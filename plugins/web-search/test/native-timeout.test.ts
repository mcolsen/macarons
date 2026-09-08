import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { tick } from "@macarons/plugin-test-harness"
import { createNativeBackend, type NativeDeps } from "../src/backends/native"

type ProvidersResult = Awaited<
  ReturnType<NativeDeps["client"]["config"]["providers"]>
>
type Request = { url: string; headers: Headers; signal?: AbortSignal | null }

const MODEL = "synthetic-model"
const ANSWER = {
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: "Healthy answer." }],
    },
  ],
}
const OAUTH = {
  openai: {
    type: "oauth",
    access: "synthetic-access-token",
    refresh: "synthetic-refresh-token",
    expires: 4_102_444_800_000,
    accountId: "synthetic-account",
  },
}

let originalFetch: typeof fetch
let requests: Request[]
let respond: () => Response | Promise<Response>

beforeEach(() => {
  originalFetch = globalThis.fetch
  requests = []
  respond = () => {
    throw new Error("unexpected native request")
  }
  // No fallthrough, even for OAuth's fixed public endpoint. Deliberately ignore
  // the signal: these tests need a deadline race, not a cooperative transport.
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      signal: init?.signal,
    })
    return respond()
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function catalog(providerID = "openai", key = "synthetic-healthy-key") {
  return {
    data: { providers: [{ id: providerID, key, options: {}, models: {} }] },
  }
}

function fixture(providerID = "openai", authStore: unknown = {}) {
  const providers = mock(
    async (_options: { signal: AbortSignal }): Promise<ProvidersResult> =>
      catalog(providerID),
  )
  const readAuthStore = mock(async (): Promise<unknown> => authStore)
  const resolveActive = mock(async (_signal: AbortSignal) => ({
    providerID,
    modelID: MODEL,
  }))
  const backend = createNativeBackend({
    client: { config: { providers } },
    readAuthStore,
    warn: () => {},
  })
  return {
    providers,
    readAuthStore,
    resolveActive,
    run: (signal = new AbortController().signal, timeoutMs = 1_000) =>
      backend(
        { enabled: true, timeoutMs },
        { query: "q" },
        resolveActive,
        signal,
      ),
  }
}

function heldBody(init?: ResponseInit) {
  const reading = Promise.withResolvers<void>()
  let controller: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value
      },
      pull() {
        reading.resolve()
      },
      cancel() {
        closed = cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  return {
    response: new Response(stream, init),
    reading: reading.promise,
    write(text: string) {
      if (!closed) controller.enqueue(new TextEncoder().encode(text))
    },
    close() {
      if (closed) return
      closed = true
      controller.close()
    },
    get cancelled() {
      return cancelled
    },
  }
}

describe.each([
  { stop: "timeout", timeoutMs: 30, reason: "timed out" },
  { stop: "cancellation", timeoutMs: 60_000, reason: "aborted" },
])("native $stop", ({ stop, timeoutMs, reason }) => {
  test.each(["providers", "auth"] as const)(
    "settles with a permanently pending %s lookup",
    async (phase) => {
      const f = fixture()
      const outer = new AbortController()
      const entered = Promise.withResolvers<void>()
      const pendingLookup = () => {
        entered.resolve()
        return new Promise<never>(() => {})
      }
      if (phase === "providers")
        f.providers.mockImplementationOnce(pendingLookup)
      else f.readAuthStore.mockImplementationOnce(pendingLookup)

      try {
        const pending = f.run(outer.signal, timeoutMs)
        await entered.promise
        const signal = f.providers.mock.calls[0]?.[0].signal
        expect(signal).toBeInstanceOf(AbortSignal)
        expect(signal).toBe(f.resolveActive.mock.calls[0]?.[0])
        expect(signal?.aborted).toBe(false)
        if (stop === "cancellation") outer.abort()

        // Nothing releases the lookup, even during cleanup.
        expect(await pending).toEqual({ kind: "error", reason })
        expect(signal?.aborted).toBe(true)
        expect(f.providers).toHaveBeenCalledTimes(1)
        expect(f.readAuthStore).toHaveBeenCalledTimes(phase === "auth" ? 1 : 0)
        expect(requests).toEqual([])
      } finally {
        outer.abort()
      }
    },
    2_000,
  )

  test.each([
    { phase: "providers", settlement: "resolve" },
    { phase: "providers", settlement: "reject" },
    { phase: "auth", settlement: "resolve" },
    { phase: "auth", settlement: "reject" },
  ])(
    "late $settlement from $phase cannot resume work or replace healthy cache",
    async ({ phase, settlement }) => {
      const f = fixture()
      const outer = new AbortController()
      const entered = Promise.withResolvers<void>()
      const providers = Promise.withResolvers<ProvidersResult>()
      const auth = Promise.withResolvers<unknown>()
      const stale = catalog("openai", "synthetic-stale-key")
      if (phase === "providers") {
        f.providers.mockImplementationOnce(() => {
          entered.resolve()
          return providers.promise
        })
      } else {
        f.providers.mockResolvedValueOnce(stale)
        f.readAuthStore.mockImplementationOnce(() => {
          entered.resolve()
          return auth.promise
        })
      }
      respond = () => Response.json(ANSWER)

      try {
        const pending = f.run(outer.signal, timeoutMs)
        await entered.promise
        if (stop === "cancellation") outer.abort()
        expect(await pending).toEqual({ kind: "error", reason })
        expect(f.providers.mock.calls[0]?.[0].signal.aborted).toBe(true)
        expect(requests).toEqual([])

        // A healthy call must proceed while the abandoned lookup is still held.
        expect(await f.run()).toEqual({ kind: "ok", output: "Healthy answer." })
        expect(f.providers).toHaveBeenCalledTimes(2)
        const authReads = phase === "auth" ? 2 : 1
        expect(f.readAuthStore).toHaveBeenCalledTimes(authReads)
        expect(requests).toHaveLength(1)

        if (settlement === "reject") {
          const held = phase === "providers" ? providers : auth
          held.reject(new Error("synthetic late lookup failure"))
        } else if (phase === "providers") providers.resolve(stale)
        else auth.resolve({})
        await tick()

        expect(f.readAuthStore).toHaveBeenCalledTimes(authReads)
        expect(requests).toHaveLength(1)
        expect(await f.run()).toEqual({ kind: "ok", output: "Healthy answer." })
        expect(f.providers).toHaveBeenCalledTimes(2)
        expect(f.readAuthStore).toHaveBeenCalledTimes(authReads)
        expect(requests).toHaveLength(2)
        expect(
          requests.map((request) => request.headers.get("Authorization")),
        ).toEqual([
          "Bearer synthetic-healthy-key",
          "Bearer synthetic-healthy-key",
        ])
      } finally {
        outer.abort()
        providers.resolve(stale)
        auth.resolve({})
        await tick()
      }
    },
    2_000,
  )

  test.each([
    { body: "success JSON", adapter: "openai", status: 200 },
    { body: "error text", adapter: "openai", status: 503 },
    { body: "ChatGPT SSE", adapter: "chatgpt", status: 200 },
  ])(
    "settles before a stalled $body body is released",
    async ({ body, adapter, status }) => {
      const f = fixture("openai", adapter === "chatgpt" ? OAUTH : {})
      const outer = new AbortController()
      const held = heldBody({
        status,
        headers: {
          "Content-Type":
            adapter === "chatgpt" ? "text/event-stream" : "application/json",
        },
      })
      respond = () => held.response

      try {
        const pending = f.run(outer.signal, timeoutMs)
        await held.reading
        const signal = requests[0]?.signal
        expect(signal).toBeInstanceOf(AbortSignal)
        expect(signal).toBe(f.providers.mock.calls[0]?.[0].signal)
        expect(signal?.aborted).toBe(false)
        if (stop === "cancellation") outer.abort()

        expect(await pending).toEqual({
          kind: "error",
          reason: `${adapter}/${MODEL}: ${reason}`,
        })
        expect(signal?.aborted).toBe(true)
        expect(requests).toHaveLength(1)
        if (adapter === "chatgpt") {
          expect(requests[0]?.url).toBe(
            "https://chatgpt.com/backend-api/codex/responses",
          )
          expect(requests[0]?.headers.get("Authorization")).toBe(
            "Bearer synthetic-access-token",
          )
          held.write(
            'event: response.output_text.delta\ndata: {"delta":"Too late."}\n\n',
          )
          await tick()
          // A late chunk must stop iteration, not start another unbounded read.
          expect(held.cancelled).toBe(true)
        } else {
          held.write(
            body === "success JSON" ? JSON.stringify(ANSWER) : "late error",
          )
        }
      } finally {
        outer.abort()
        held.close()
        await tick()
      }
    },
    2_000,
  )

  test.each(["active", "fallback"] as const)(
    "settles a stalled %s model without dispatching a late auto fallback",
    async (phase) => {
      const f = fixture()
      const discovery = catalog()
      discovery.data.providers[0]!.models = {
        "synthetic-fallback": {
          id: "synthetic-fallback",
          options: { websearch: "auto" },
        },
      }
      f.providers.mockResolvedValue(discovery)
      const outer = new AbortController()
      const held = heldBody({ status: phase === "active" ? 400 : 200 })
      respond = () =>
        phase === "fallback" && requests.length === 1
          ? Response.json(
              { error: { message: "unsupported" } },
              { status: 400 },
            )
          : held.response

      try {
        const pending = f.run(outer.signal, timeoutMs)
        await held.reading
        if (stop === "cancellation") outer.abort()
        const outcome = await pending
        expect(outcome).toMatchObject({
          kind: "error",
          reason: expect.stringContaining(
            `openai/${phase === "active" ? MODEL : "synthetic-fallback"}: ${reason}`,
          ),
        })
        const count = phase === "active" ? 1 : 2
        expect(requests).toHaveLength(count)
        for (const request of requests) {
          expect(request.signal).toBe(f.resolveActive.mock.calls[0]?.[0])
          expect(request.signal?.aborted).toBe(true)
        }
        held.write(
          JSON.stringify(
            phase === "active"
              ? { error: { message: "late failure" } }
              : ANSWER,
          ),
        )
        held.close()
        await tick()
        expect(requests).toHaveLength(count)
      } finally {
        outer.abort()
        held.close()
        await tick()
      }
    },
    2_000,
  )

  test("a late Moonshot tool-call body cannot dispatch another request", async () => {
    const f = fixture("moonshotai")
    const outer = new AbortController()
    const held = heldBody()
    respond = () =>
      requests.length === 1 ? held.response : Response.json({ choices: [] })

    try {
      const pending = f.run(outer.signal, timeoutMs)
      await held.reading
      if (stop === "cancellation") outer.abort()
      expect(await pending).toEqual({
        kind: "error",
        reason: `moonshot/${MODEL}: ${reason}`,
      })
      expect(requests[0]?.signal?.aborted).toBe(true)
      expect(requests).toHaveLength(1)
      held.write(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [
                  {
                    id: "synthetic-tool-call",
                    function: {
                      name: "$web_search",
                      arguments: '{"search_query":"q"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      held.close()
      await tick()
      expect(requests).toHaveLength(1)
    } finally {
      outer.abort()
      held.close()
      await tick()
    }
  }, 2_000)
})

test.each(["providers", "auth", "fetch"] as const)(
  "ordinary %s rejection retains its outcome and model-label semantics",
  async (phase) => {
    const f = fixture()
    const error = new Error(`synthetic ${phase} failure`)
    if (phase === "providers") f.providers.mockRejectedValueOnce(error)
    if (phase === "auth") f.readAuthStore.mockRejectedValueOnce(error)
    respond = () => {
      throw error
    }

    const outcome = await f.run()
    expect(outcome).toEqual(
      phase === "providers"
        ? {
            kind: "unavailable",
            reason:
              'provider "openai" has no native web search (or no credentials)',
          }
        : {
            kind: "error",
            reason: `${phase === "fetch" ? `openai/${MODEL}: ` : ""}${error.message}`,
          },
    )
    expect(f.readAuthStore).toHaveBeenCalledTimes(phase === "providers" ? 0 : 1)
    expect(requests).toHaveLength(phase === "fetch" ? 1 : 0)
  },
  2_000,
)

test("an already-aborted call dispatches no model/provider/auth lookup or fetch", async () => {
  const f = fixture()
  const outer = new AbortController()
  outer.abort()

  expect(await f.run(outer.signal)).toEqual({
    kind: "error",
    reason: "aborted",
  })
  expect(f.resolveActive).not.toHaveBeenCalled()
  expect(f.providers).not.toHaveBeenCalled()
  expect(f.readAuthStore).not.toHaveBeenCalled()
  expect(requests).toEqual([])
})

test("provider, auth, and body phases share one deadline rather than restarting it", async () => {
  const f = fixture()
  const outer = new AbortController()
  const providers = Promise.withResolvers<ProvidersResult>()
  const auth = Promise.withResolvers<unknown>()
  const held = heldBody()
  let bodyReleased = false
  f.providers.mockImplementationOnce(() => providers.promise)
  f.readAuthStore.mockImplementationOnce(() => auth.promise)
  respond = () => held.response
  // Each phase is shorter than 120ms; the complete attempt is longer. A fresh
  // deadline after either lookup would incorrectly allow the answer at 160ms.
  const timers = [
    setTimeout(() => providers.resolve(catalog()), 60),
    setTimeout(() => auth.resolve({}), 80),
    setTimeout(() => {
      bodyReleased = true
      held.write(JSON.stringify(ANSWER))
      held.close()
    }, 160),
  ]

  try {
    const pending = f.run(outer.signal, 120)
    await held.reading
    expect(await pending).toEqual({
      kind: "error",
      reason: `openai/${MODEL}: timed out`,
    })
    expect(bodyReleased).toBe(false)
    expect(requests[0]?.signal).toBe(f.resolveActive.mock.calls[0]?.[0])
    expect(requests[0]?.signal).toBe(f.providers.mock.calls[0]?.[0].signal)
    expect(requests[0]?.signal?.aborted).toBe(true)
  } finally {
    for (const timer of timers) clearTimeout(timer)
    outer.abort()
    providers.resolve(catalog())
    auth.resolve({})
    held.close()
    await tick()
  }
}, 2_000)

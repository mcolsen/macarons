import { describe, expect, test } from "bun:test"
import { createNativeBackend } from "../src/backends/native"
import type { ProviderData } from "../src/backends/native/scan"
import { DEFAULT_NATIVE_TIMEOUT_MS } from "../src/shared"

const copilot: ProviderData = {
  id: "github-copilot",
  key: "synthetic-copilot-key",
  options: {},
  models: {
    "claude-sonnet": { id: "claude-sonnet", options: {} },
    "gpt-search": { id: "gpt-search", options: { websearch: "auto" } },
  },
}

type Captured = {
  url: string
  headers: Headers
  body: { model: string }
  signal: AbortSignal | null | undefined
}
type Reply = Response | ((request: Captured) => Response | Promise<Response>)

const failure = () =>
  Response.json({ error: { message: "search unsupported" } }, { status: 400 })
const answer = (text = "GPT searched.") =>
  Response.json({
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  })

async function search(
  providers: ProviderData[],
  replies: Reply[],
  options: {
    providerID?: string
    modelID?: string
    signal?: AbortSignal
    deadline?: AbortSignal
  } = {},
) {
  const requests: Captured[] = []
  const timeouts: number[] = []
  const lookupSignals: AbortSignal[] = []
  const savedFetch = globalThis.fetch
  const savedTimeout = globalThis.setTimeout
  let expire: (() => void) | undefined
  // Fire the deadline explicitly, never by sleeping or racing a real timer.
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms === DEFAULT_NATIVE_TIMEOUT_MS) {
      timeouts.push(ms)
      expire = () => callback(...args)
      if (options.deadline?.aborted) queueMicrotask(expire)
      else options.deadline?.addEventListener("abort", expire, { once: true })
    }
    return savedTimeout(callback, ms, ...args)
  }) as typeof globalThis.setTimeout
  // A closed response queue: even unexpected requests never reach real fetch.
  globalThis.fetch = (async (input, init) => {
    const request: Captured = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
      signal: init?.signal,
    }
    requests.push(request)
    const reply = replies[requests.length - 1]
    if (!reply) throw new Error(`unexpected request to ${request.url}`)
    return typeof reply === "function" ? reply(request) : reply
  }) as typeof globalThis.fetch
  try {
    const backend = createNativeBackend({
      client: {
        config: {
          providers: async ({ signal }) => {
            lookupSignals.push(signal)
            return { data: { providers } }
          },
        },
      },
      readAuthStore: async () => ({}),
      warn: () => {},
    })
    const outcome = await backend(
      { enabled: true, timeoutMs: DEFAULT_NATIVE_TIMEOUT_MS },
      { query: "aurora forecast" },
      async (signal) => {
        lookupSignals.push(signal)
        return {
          providerID: options.providerID ?? providers[0]!.id,
          modelID: options.modelID ?? "claude-sonnet",
        }
      },
      options.signal ?? new AbortController().signal,
    )
    return { outcome, requests, timeouts, lookupSignals }
  } finally {
    globalThis.fetch = savedFetch
    globalThis.setTimeout = savedTimeout
    if (expire) options.deadline?.removeEventListener("abort", expire)
  }
}

describe("createNativeBackend fallback (#243)", () => {
  test("active Copilot Claude HTTP failure falls back to same-provider configured GPT auto", async () => {
    const { outcome, requests, timeouts, lookupSignals } = await search(
      [copilot],
      [failure(), answer()],
    )
    expect(outcome).toEqual({ kind: "ok", output: "GPT searched." })
    expect(requests.map((request) => request.body.model)).toEqual([
      "claude-sonnet",
      "gpt-search",
    ])
    for (const request of requests) {
      expect(request.url).toBe("https://api.githubcopilot.com/responses")
      expect(request.headers.get("Authorization")).toBe(
        "Bearer synthetic-copilot-key",
      )
      expect(request.headers.get("Openai-Intent")).toBe("conversation-edits")
    }
    expect(requests[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(requests[1]!.signal).toBe(requests[0]!.signal)
    expect(lookupSignals).toHaveLength(2)
    for (const signal of lookupSignals) expect(requests[0]!.signal).toBe(signal)
    expect(timeouts).toEqual([DEFAULT_NATIVE_TIMEOUT_MS])
  })

  test.each([
    { name: "answer", reply: answer, output: "GPT searched." },
    {
      name: "healthy empty",
      reply: () => Response.json({ output: [] }),
      output: "No search results found",
    },
  ])("active $name stops attempts", async ({ reply, output }) => {
    const { outcome, requests } = await search([copilot], [reply(), failure()])
    expect(outcome).toMatchObject({
      kind: "ok",
      output: expect.stringContaining(output),
    })
    expect(requests.map((request) => request.body.model)).toEqual([
      "claude-sonnet",
    ])
  })

  const attemptCases: {
    name: string
    models: ProviderData["models"]
    attempted: string[]
  }[] = [
    {
      name: "always is exclusive even when it fails",
      models: {
        ...copilot.models,
        locked: { id: "locked", options: { websearch: "always" } },
      },
      attempted: ["locked"],
    },
    {
      name: "auto with the same catalog id is not retried, even with api.id",
      models: {
        "claude-sonnet": {
          id: "claude-sonnet",
          api: { id: "claude-wire" },
          options: { websearch: "auto" },
        },
      },
      attempted: ["claude-wire"],
    },
    {
      name: "only the first configured auto is tried, even when both attempts fail",
      models: {
        ...copilot.models,
        extra: { id: "extra", options: { websearch: "auto" } },
      },
      attempted: ["claude-sonnet", "gpt-search"],
    },
  ]
  test.each(attemptCases)("$name", async ({ models, attempted }) => {
    const { outcome, requests } = await search(
      [{ ...copilot, models }],
      [failure(), failure(), answer()],
    )
    expect(outcome.kind).toBe("error")
    expect(requests.map((request) => request.body.model)).toEqual(attempted)
  })

  test.each([
    { name: "own api.id and api.url", baseURL: undefined, auto: true },
    {
      name: "provider baseURL overrides both model endpoints",
      baseURL: "https://gateway.invalid/v1",
      auto: true,
    },
    { name: "no own auto means no fallback", baseURL: undefined, auto: false },
  ])("exact-provider isolation: $name", async ({ baseURL, auto }) => {
    const selected: ProviderData = {
      id: "selected-openai",
      key: "synthetic-stored-key",
      options: {
        apiKey: "synthetic-selected-key",
        baseURL,
        headers: {
          "x-gateway-auth": "synthetic-selected-gateway",
          "x-route": "provider-route",
        },
      },
      models: {
        active: {
          id: "active",
          api: {
            npm: "@ai-sdk/openai",
            id: "gpt-active-wire",
            url: "https://active.invalid/v1",
          },
          headers: {
            "x-route": "active-route",
            "x-active-only": "active-only",
          },
          options: {},
        },
        auto: {
          id: "auto",
          api: { id: "gpt-auto-wire", url: "https://auto.invalid/v1" },
          headers: { "X-Route": "auto-route" },
          options: auto ? { websearch: "auto" } : {},
        },
      },
    }
    // Same adapter and catalog ids, but a different provider, key and endpoint.
    const other: ProviderData = {
      ...selected,
      id: "other-openai",
      options: {
        apiKey: "synthetic-other-key",
        baseURL: "https://other.invalid/v1",
        headers: { "x-gateway-auth": "synthetic-other-gateway" },
      },
      models: {
        ...selected.models,
        auto: {
          id: "auto",
          api: { id: "gpt-other-wire", url: "https://other-auto.invalid/v1" },
          options: { websearch: "auto" },
        },
      },
    }
    const { outcome, requests } = await search(
      [other, selected],
      [failure(), answer()],
      { providerID: selected.id, modelID: "active" },
    )
    expect(outcome.kind).toBe(auto ? "ok" : "error")
    expect(
      requests.map((request) => [request.body.model, request.url]),
    ).toEqual([
      [
        "gpt-active-wire",
        `${baseURL ?? "https://active.invalid/v1"}/responses`,
      ],
      ...(auto
        ? [
            [
              "gpt-auto-wire",
              `${baseURL ?? "https://auto.invalid/v1"}/responses`,
            ],
          ]
        : []),
    ])
    for (const [index, request] of requests.entries()) {
      expect(request.headers.get("Authorization")).toBe(
        "Bearer synthetic-selected-key",
      )
      expect(request.headers.get("x-gateway-auth")).toBe(
        "synthetic-selected-gateway",
      )
      expect(request.headers.get("x-route")).toBe(
        index === 0 ? "active-route" : "auto-route",
      )
      expect(request.headers.get("x-active-only")).toBe(
        index === 0 ? "active-only" : null,
      )
    }
  })

  test.each(
    ["caller abort", "deadline exhausted"].flatMap((stop) =>
      ["before search", "during active", "during fallback"].map((phase) => ({
        stop,
        phase,
      })),
    ),
  )("$stop $phase prevents further attempts", async ({ stop, phase }) => {
    const caller = new AbortController()
    const deadline = new AbortController()
    const controller = stop === "caller abort" ? caller : deadline
    const reason = new DOMException(
      "synthetic stop",
      stop === "caller abort" ? "AbortError" : "TimeoutError",
    )
    const stoppedReply = (request: Captured) => {
      controller.abort(reason)
      // An HTTP error can race cancellation; do not rely on its error name.
      if (phase === "during active") return failure()
      request.signal?.throwIfAborted()
      throw new Error("request did not receive cancellation")
    }
    if (phase === "before search") controller.abort(reason)
    const { outcome, requests, timeouts } = await search(
      [copilot],
      phase === "during fallback"
        ? [failure(), stoppedReply]
        : [stoppedReply, answer()],
      { signal: caller.signal, deadline: deadline.signal },
    )
    expect(outcome.kind).toBe("error")
    const count =
      phase === "before search" ? 0 : phase === "during active" ? 1 : 2
    expect(requests.map((request) => request.body.model)).toEqual(
      ["claude-sonnet", "gpt-search"].slice(0, count),
    )
    expect(timeouts).toEqual(
      stop === "caller abort" && phase === "before search"
        ? []
        : [DEFAULT_NATIVE_TIMEOUT_MS],
    )
    for (const request of requests) {
      expect(request.signal?.aborted).toBe(true)
      if (stop === "caller abort") expect(request.signal?.reason).toBe(reason)
    }
    expect(outcome).toMatchObject({
      reason: expect.stringContaining(
        stop === "caller abort" ? "aborted" : "timed out",
      ),
    })
  })
})

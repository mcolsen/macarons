import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import type { Plugin } from "@opencode-ai/plugin"
import { WebSearchPlugin } from "../src/index"
import {
  loadSearchesFile,
  preSlugSearchesFilePath,
  type SearchesFile,
  searchesFilePath,
} from "../src/searches"

/**
 * Drives the real factory against a stub host. The load-bearing claims:
 * the tool map registers the always-visible `web_search` id AND the
 * `websearch` shadow as the SAME definition, execute asks the builtin's
 * permission before any backend request, and the chain answers from the configured
 * SearXNG mock. The factory reads no env: enabling the plugin is enabling
 * search, with no OPENCODE_ENABLE_EXA-family flag required.
 */

// The native backend's credential read is env-derived now (audit §2.3), so a
// stubbed `client.path.get` no longer keeps it away from the machine's real
// auth.json the way it did while the reader went through the SDK. Point the
// data dir at nothing and clear the inline override for the whole file — the
// same isolation usage-limits and redact-secrets already do — or booting the
// factory here resolves the developer's own OAuth records and can put them on
// the wire. (`searchesFilePath` takes its root from `client.path.get`, not
// XDG, so the search-activity assertions are untouched.)
const originalDataHome = process.env.XDG_DATA_HOME
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT

beforeAll(() => {
  process.env.XDG_DATA_HOME = "/nonexistent/websearch-plugin-test"
  delete process.env.OPENCODE_AUTH_CONTENT
})

afterAll(() => {
  searxng?.stop(true)
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalDataHome
  if (originalAuthContent === undefined)
    delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuthContent
})

let searxng: ReturnType<typeof Bun.serve> | undefined
let searxngQueries: string[]

function startSearxng(): string {
  searxngQueries = []
  searxng ??= Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      searxngQueries.push(url.searchParams.get("q") ?? "")
      return Response.json({
        results: [
          {
            title: "Hit",
            url: "https://hit.example",
            content: "snippet",
            engine: "mock",
          },
        ],
      })
    },
  })
  return `http://127.0.0.1:${searxng.port}`
}

type StubHost = {
  client: unknown
  logs: {
    service: string
    level: string
    message: string
    extra?: Record<string, unknown>
  }[]
  messages: Map<string, Record<string, unknown>>
  messageCalls: unknown[]
  toasts: string[]
}

function stubHost(): StubHost {
  const logs: StubHost["logs"] = []
  const toasts: string[] = []
  const messages = new Map<string, Record<string, unknown>>()
  const messageCalls: unknown[] = []
  return {
    logs,
    toasts,
    messages,
    messageCalls,
    client: {
      global: { health: async () => ({ data: { version: BAND.floor } }) },
      app: {
        log: async (input: { body: StubHost["logs"][number] }) => {
          logs.push(input.body)
          return {}
        },
      },
      config: { providers: async () => ({ data: { providers: [] } }) },
      path: { get: async () => ({ data: {} }) },
      session: {
        message: async (input: { path: { id: string; messageID: string } }) => {
          messageCalls.push(input)
          const info = messages.get(`${input.path.id}/${input.path.messageID}`)
          return { data: info ? { info, parts: [] } : undefined }
        },
      },
      tui: {
        showToast: async (input: { body?: { message?: string } }) => {
          toasts.push(input.body?.message ?? "")
          return { data: true }
        },
      },
    },
  }
}

async function boot(host: StubHost, options?: Record<string, unknown>) {
  const factory = WebSearchPlugin as Plugin
  return factory(
    {
      client: host.client,
      directory: "/project",
      worktree: "/project",
      serverUrl: new URL("http://opencode.internal"),
    } as any,
    options,
  )
}

type ToolShape = {
  description: string
  args: Record<string, unknown>
  execute: (
    args: Record<string, unknown>,
    ctx: unknown,
  ) => Promise<{ title?: string; output: string; metadata?: unknown }>
}

function websearchTool(
  hooks: Awaited<ReturnType<Plugin>>,
  id: "websearch" | "web_search" = "websearch",
): ToolShape {
  const tool = (hooks.tool as Record<string, unknown>)[id]
  if (!tool) throw new Error(`${id} tool not registered`)
  return tool as ToolShape
}

type AskRecord = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}

function toolContext(
  asks: AskRecord[],
  sessionID = "ses_1",
  messageID = "msg_1",
) {
  return {
    sessionID,
    messageID,
    agent: "build",
    directory: "/project",
    worktree: "/project",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async (input: AskRecord) => {
      asks.push(input)
    },
  }
}

describe("factory registration", () => {
  test("registers web_search plus the websearch shadow without a session model tracker", async () => {
    const hooks = await boot(stubHost())
    expect(Object.keys(hooks.tool ?? {})).toEqual(["web_search", "websearch"])
    expect(hooks["chat.message"]).toBeUndefined()
  })

  test("registers the config hook that mirrors websearch rules to the alias", async () => {
    const hooks = await boot(stubHost())
    const config = {
      permission: { "*": "deny", websearch: "allow" },
    } as Record<string, unknown>
    await hooks.config?.(config as never)
    expect(config.permission).toMatchObject({
      websearch: "allow",
      web_search: "allow",
    })
  })

  test("both ids are the SAME definition — the shadow is a pure alias", async () => {
    // If these ever diverge, the two ids could behave differently on Zen
    // sessions (where both are visible) — identity is the cheapest pin.
    const hooks = await boot(stubHost())
    const tools = hooks.tool as Record<string, unknown>
    expect(tools.websearch).toBe(tools.web_search)
  })

  test("boot never toasts — visibility needs no env flag anymore", async () => {
    const host = stubHost()
    await boot(host)
    expect(host.toasts).toEqual([])
  })
})

describe("tool execution", () => {
  test("both ids ask the builtin's websearch permission before searching", async () => {
    const host = stubHost()
    const hooks = await boot(host, {
      searxng: { url: startSearxng() },
      exa: { enabled: false },
    })
    for (const id of ["web_search", "websearch"] as const) {
      const query = `${id} solar flares`
      const asks: AskRecord[] = []
      const result = await websearchTool(hooks, id).execute(
        { query },
        toolContext(asks),
      )
      expect(asks).toHaveLength(1)
      expect(asks[0]).toMatchObject({
        permission: "websearch",
        patterns: [query],
        always: ["*"],
      })
      expect(result.output).toContain("Hit")
      expect(searxngQueries).toContain(query)
      expect(result.metadata).toMatchObject({ backend: "searxng" })
    }
    expect(host.messageCalls).toEqual([])
  })

  test("a denied permission aborts before any assistant lookup or backend runs", async () => {
    const host = stubHost()
    const hooks = await boot(host, {
      searxng: { url: startSearxng() },
      exa: { enabled: false },
    })
    const before = searxngQueries.length
    const ctx = {
      ...toolContext([]),
      ask: async () => {
        throw new Error("denied")
      },
    }
    await expect(
      websearchTool(hooks).execute({ query: "blocked" }, ctx),
    ).rejects.toThrow("denied")
    expect(host.messageCalls).toEqual([])
    expect(searxngQueries.length).toBe(before)
  })

  test("an exhausted chain reports every attempt instead of throwing", async () => {
    const hooks = await boot(stubHost(), {
      // No searxng url, no native provider, exa disabled: nothing to try.
      exa: { enabled: false },
    })
    const result = await websearchTool(hooks).execute(
      { query: "q" },
      toolContext([]),
    )
    expect(result.output).toContain("Web search failed")
    expect(result.output).toContain("searxng: unavailable")
    expect(result.output).toContain("native: unavailable")
    expect(result.output).toContain("exa: unavailable")
  })

  test("the executing assistant supplies the native gate, even in a fresh process", async () => {
    const host = stubHost()
    host.messages.set("ses_1/msg_1", {
      id: "msg_1",
      sessionID: "ses_1",
      role: "assistant",
      providerID: "opencode-go",
      modelID: "go-large",
    })
    const hooks = await boot(host, {
      order: ["native"],
    })
    const ctx = {
      ...toolContext([]),
      directory: "/tool-directory",
      ask: async () => {
        expect(host.messageCalls).toEqual([])
      },
    }
    const result = await websearchTool(hooks).execute({ query: "q" }, ctx)
    expect(result.output).toContain('provider "opencode-go"')
    expect(host.messageCalls).toEqual([
      {
        path: { id: "ses_1", messageID: "msg_1" },
        query: { directory: "/project" },
        signal: expect.any(AbortSignal),
      },
    ])
  })

  test.each([
    { name: "missing", message: undefined },
    { name: "user", message: { role: "user" } },
    { name: "different session", message: { sessionID: "ses_other" } },
    { name: "different message", message: { id: "msg_other" } },
    { name: "missing provider", message: { providerID: undefined } },
    { name: "empty model", message: { modelID: "" } },
    { name: "invalid model", message: { modelID: 123 } },
    { name: "lookup error", message: undefined },
    { name: "lookup rejection", message: undefined },
  ])(
    "$name assistant lookup skips native without blocking fallback",
    async ({ name, message }) => {
      const host = stubHost()
      if (message) {
        host.messages.set("ses_1/msg_1", {
          id: "msg_1",
          sessionID: "ses_1",
          role: "assistant",
          providerID: "untrusted-provider",
          modelID: "untrusted-model",
          ...message,
        })
      }
      if (name.startsWith("lookup")) {
        ;(host.client as Record<string, unknown>).session = {
          message: async () => {
            if (name === "lookup rejection") throw new Error("offline")
            return {
              error: { name: "NotFoundError" },
              response: new Response(null, { status: 404 }),
            }
          },
        }
      }
      let providerReads = 0
      ;(host.client as Record<string, unknown>).config = {
        providers: async () => {
          providerReads++
          return { data: { providers: [] } }
        },
      }
      const hooks = await boot(host, {
        order: ["native", "searxng"],
        searxng: { url: startSearxng() },
      })
      const result = await websearchTool(hooks).execute(
        { query: "safe fallback" },
        toolContext([]),
      )
      expect(result.metadata).toMatchObject({ backend: "searxng" })
      expect(providerReads).toBe(0)
      const warnings = host.logs.filter(({ level }) => level === "warn")
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatchObject({
        service: "web-search",
        extra: { sessionID: "ses_1", messageID: "msg_1" },
      })
      expect(warnings[0]?.message).toContain("executing assistant lookup")
      if (name === "lookup rejection") {
        expect(warnings[0]?.message).toContain("offline")
      } else if (name === "lookup error") {
        expect(warnings[0]?.extra?.status).toBe(404)
      } else {
        expect(warnings[0]?.message).toContain("invalid or mismatched")
      }
    },
  )

  test.each([
    {},
    { order: ["searxng"], native: { enabled: true } },
    { order: ["native", "searxng"], native: { enabled: false } },
  ])(
    "unused native search never looks up an assistant (%j)",
    async (options) => {
      const host = stubHost()
      const hooks = await boot(host, {
        ...options,
        searxng: { url: startSearxng() },
      })
      const result = await websearchTool(hooks).execute(
        { query: "q" },
        toolContext([]),
      )
      expect(result.metadata).toMatchObject({ backend: "searxng" })
      expect(host.messageCalls).toEqual([])
      expect(host.logs.filter(({ level }) => level === "warn")).toEqual([])
    },
  )

  for (const phase of ["assistant", "providers"] as const) {
    test.each(["timeout", "cancellation"])(
      `issue #247: %s settles a pending ${phase} lookup and controls fallback`,
      async (stop) => {
        const host = stubHost()
        const lookup = Promise.withResolvers<unknown>()
        const reached = Promise.withResolvers<AbortSignal>()
        const assistant = {
          id: "msg_1",
          sessionID: "ses_1",
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-x",
        }
        const client = host.client as Record<string, unknown>
        let providerReads = 0
        client.session = {
          message: ({ signal }: { signal: AbortSignal }) => {
            if (phase === "assistant") {
              reached.resolve(signal)
              return lookup.promise
            }
            return Promise.resolve({ data: { info: assistant, parts: [] } })
          },
        }
        client.config = {
          providers: ({ signal }: { signal: AbortSignal }) => {
            providerReads++
            reached.resolve(signal)
            return lookup.promise
          },
        }
        const hooks = await boot(host, {
          order: ["native", "searxng"],
          native: { timeoutMs: stop === "timeout" ? 1_000 : 60_000 },
          searxng: { url: startSearxng() },
        })
        const outer = new AbortController()
        const pending = websearchTool(hooks).execute(
          { query: "bounded lookup" },
          { ...toolContext([]), abort: outer.signal },
        )
        try {
          const signal = await reached.promise
          expect(signal.aborted).toBe(false)
          expect(signal).not.toBe(outer.signal)
          if (stop === "cancellation") outer.abort()
          const result = await pending
          expect(signal.aborted).toBe(true)
          if (stop === "timeout") {
            expect(result.metadata).toMatchObject({ backend: "searxng" })
            expect(searxngQueries).toEqual(["bounded lookup"])
            expect(outer.signal.aborted).toBe(false)
          } else {
            expect(result.output).toContain("native: failed")
            expect(result.output).toContain("aborted")
            expect(searxngQueries).toEqual([])
          }
          // A transport that ignores abort may answer after the chain settled.
          lookup.resolve({
            data: { info: assistant, parts: [], providers: [] },
          })
          await new Promise<void>((resolve) => setImmediate(resolve))
          expect(providerReads).toBe(phase === "providers" ? 1 : 0)
        } finally {
          lookup.resolve({ data: {} })
          await pending.catch(() => {})
          await hooks.dispose?.()
        }
      },
    )
  }
})

describe("native invocation identity", () => {
  test.each(["approval", "searxng", "provider resolution"])(
    "keeps endpoint, credential and model across %s waits and an overlapping search",
    async (phase) => {
      const reached = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const captured: {
        url: string
        authorization: string | null
        body: unknown
      }[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === "/search") {
            if (phase === "searxng" && url.searchParams.get("q") === "older") {
              reached.resolve()
              await release.promise
            }
            return new Response("unavailable", { status: 503 })
          }
          captured.push({
            url: request.url,
            authorization: request.headers.get("authorization"),
            body: await request.json(),
          })
          return Response.json({
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Native answer" }],
              },
            ],
          })
        },
      })
      const baseURL = `http://127.0.0.1:${server.port}`
      const host = stubHost()
      const older = {
        id: "msg_a",
        sessionID: "ses_busy",
        role: "assistant",
        providerID: "provider-a",
        modelID: "model-a",
      }
      host.messages.set("ses_busy/msg_a", older)
      host.messages.set("ses_busy/msg_b", {
        ...older,
        id: "msg_b",
        providerID: "provider-b",
        modelID: "model-b",
      })
      let holdResolution = phase === "provider resolution"
      ;(host.client as Record<string, unknown>).config = {
        providers: async () => {
          if (holdResolution) {
            holdResolution = false
            reached.resolve()
            await release.promise
          }
          return {
            data: {
              providers: ["a", "b"].map((id) => ({
                id: `provider-${id}`,
                options: {
                  apiKey: `synthetic-key-${id}`,
                  baseURL: `${baseURL}/${id}/v1`,
                },
                models: {
                  [`model-${id}`]: {
                    id: `model-${id}`,
                    api: { npm: "@ai-sdk/openai", id: `wire-${id}` },
                    options: {},
                  },
                },
              })),
            },
          }
        },
      }
      const hooks = await boot(host, {
        order: phase === "searxng" ? ["searxng", "native"] : ["native"],
        searxng: { url: baseURL },
      })
      const ctx = {
        ...toolContext([], "ses_busy", "msg_a"),
        ask: async () => {
          if (phase !== "approval") return
          reached.resolve()
          await release.promise
        },
      }
      const pending = websearchTool(hooks, "web_search").execute(
        { query: "older" },
        ctx,
      )
      try {
        await Promise.race([
          reached.promise,
          pending.then(() => {
            throw new Error(`older search never awaited ${phase}`)
          }),
        ])
        expect(captured).toEqual([])
        expect(host.messageCalls).toHaveLength(
          phase === "provider resolution" ? 1 : 0,
        )
        // The IDs are captured before permission; provider/model are only
        // read once native runs. Later turns do not rewrite stored assistants.
        ctx.sessionID = "ses_other"
        ctx.messageID = "msg_b"
        if (phase === "provider resolution") {
          // Once fetched, the SDK payload must be copied, not kept by reference.
          older.providerID = "provider-b"
          older.modelID = "model-b"
        }
        const newer = await websearchTool(hooks, "websearch").execute(
          { query: "newer" },
          toolContext([], "ses_busy", "msg_b"),
        )
        expect(newer.metadata).toMatchObject({ backend: "native" })
        release.resolve()
        expect((await pending).metadata).toMatchObject({ backend: "native" })
        expect(captured).toMatchObject([
          {
            url: `${baseURL}/b/v1/responses`,
            authorization: "Bearer synthetic-key-b",
            body: {
              model: "wire-b",
              input: "Perform a web search for the query: newer",
            },
          },
          {
            url: `${baseURL}/a/v1/responses`,
            authorization: "Bearer synthetic-key-a",
            body: {
              model: "wire-a",
              input: "Perform a web search for the query: older",
            },
          },
        ])
        expect(host.messageCalls).toHaveLength(2)
      } finally {
        release.resolve()
        await pending.catch(() => {})
        await hooks.dispose?.()
        server.stop(true)
      }
    },
  )
})

describe("search-activity channel", () => {
  async function waitForFile(
    file: string,
    query?: string,
  ): Promise<SearchesFile> {
    const start = Date.now()
    while (Date.now() - start < 2_000) {
      const parsed = await loadSearchesFile(file)
      if (
        parsed?.searches.some(
          (search) =>
            search.state === "complete" &&
            (query === undefined || search.query === query),
        )
      )
        return parsed
      await Bun.sleep(15)
    }
    throw new Error(`activity file never settled: ${file}`)
  }

  test("records the search lifecycle into the state file and pokes the TUI", async () => {
    const stateRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "websearch-activity-")),
    )
    const previous =
      process.platform === "win32" ? undefined : process.umask(0o022)
    try {
      const host = stubHost()
      const pokes: string[] = []
      // Advertise a real state directory and a poke target the server calls.
      ;(host.client as Record<string, unknown>).path = {
        get: async () => ({ data: { state: stateRoot } }),
      }
      ;(host.client as { tui: Record<string, unknown> }).tui.publish =
        async (arg: { body?: { properties?: { command?: string } } }) => {
          pokes.push(arg?.body?.properties?.command ?? "")
          return { data: true }
        }

      const hooks = await boot(host, {
        searxng: { url: startSearxng() },
        exa: { enabled: false },
      })
      const result = await websearchTool(hooks).execute(
        { query: "state-file test" },
        toolContext([], "ses_state"),
      )
      expect(result.metadata).toMatchObject({ backend: "searxng" })

      const file = searchesFilePath(stateRoot, "/project")
      const preSlugFile = preSlugSearchesFilePath(stateRoot, "/project")
      const parsed = await waitForFile(file, "state-file test")
      await waitForFile(preSlugFile, "state-file test")
      expect(parsed.searches).toHaveLength(1)
      expect(parsed.searches[0]).toMatchObject({
        sessionID: "ses_state",
        query: "state-file test",
        state: "complete",
        backend: "searxng",
      })
      expect(parsed.searches[0]?.endedAt).toBeGreaterThan(0)
      expect(pokes).toContain("websearch.activity.sync")

      if (process.platform !== "win32") {
        const parent = path.dirname(file)
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
        expect((await fs.stat(preSlugFile)).mode & 0o777).toBe(0o600)
        expect((await fs.stat(parent)).mode & 0o777).toBe(0o700)

        await fs.chmod(file, 0o644)
        await fs.chmod(preSlugFile, 0o400)
        await fs.chmod(parent, 0o755)
        await websearchTool(hooks).execute(
          { query: "mode rewrite" },
          toolContext([], "ses_modes"),
        )
        await Promise.all([
          waitForFile(file, "mode rewrite"),
          waitForFile(preSlugFile, "mode rewrite"),
        ])
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
        expect((await fs.stat(preSlugFile)).mode & 0o777).toBe(0o400)
        expect((await fs.stat(parent)).mode & 0o777).toBe(0o700)
      }

      // dispose removes the file so a fresh instance never reads dead rows.
      await (hooks as { dispose?: () => Promise<void> }).dispose?.()
      expect(await loadSearchesFile(file)).toBeUndefined()
      expect(await loadSearchesFile(preSlugFile)).toBeUndefined()
    } finally {
      if (previous !== undefined) process.umask(previous)
      await fs.rm(stateRoot, { recursive: true, force: true })
    }
  })

  test("a denied search settles as an error row, not a stuck 'searching'", async () => {
    const stateRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "websearch-denied-")),
    )
    try {
      const host = stubHost()
      ;(host.client as Record<string, unknown>).path = {
        get: async () => ({ data: { state: stateRoot } }),
      }
      ;(host.client as { tui: Record<string, unknown> }).tui.publish =
        async () => ({ data: true })

      const hooks = await boot(host, { exa: { enabled: false } })
      const ctx = {
        ...toolContext([], "ses_denied"),
        ask: async () => {
          throw new Error("denied")
        },
      }
      await expect(
        websearchTool(hooks).execute({ query: "blocked" }, ctx),
      ).rejects.toThrow("denied")

      const file = searchesFilePath(stateRoot, "/project")
      const start = Date.now()
      let row: SearchesFile["searches"][number] | undefined
      while (Date.now() - start < 2_000) {
        row = (await loadSearchesFile(file))?.searches[0]
        if (row?.state === "error") break
        await Bun.sleep(15)
      }
      expect(row).toMatchObject({ state: "error", error: "cancelled" })
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true })
    }
  })
})

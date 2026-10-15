import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { Info } from "@opencode/plugin/promise/tool"
import type { WebSearchDefinition } from "@opencode/plugin/promise/websearch"
import plugin from "../src/index"

async function load(options: Record<string, unknown> = {}) {
  const providers: WebSearchDefinition[] = []
  const tools: Info[] = []
  const ctx = {
    options,
    websearch: {
      transform: async (edit: any) =>
        edit({
          add: (provider: WebSearchDefinition) => providers.push(provider),
        }),
    },
    tool: {
      transform: async (edit: any) =>
        edit({ add: (tool: Info) => tools.push(tool) }),
    },
  } as unknown as Plugin.Context
  await plugin.setup(ctx)
  return { providers, tools, ctx }
}

describe("V2 search additions", () => {
  test("only adds configured SearXNG and provider search, leaving builtin search untouched", async () => {
    const h = await load({ searxng: { url: "http://localhost:8080" } })
    expect(h.providers.map((p) => p.id)).toEqual(["macarons-searxng"])
    expect(h.tools.map((t) => t.name)).toEqual(["provider_search"])
    expect((await load({ native: { enabled: false } })).tools).toHaveLength(0)
    expect((await load()).providers).toHaveLength(0)
  })
  test("SearXNG emits native result records and healthy empties stay empty", async () => {
    let payload: unknown = {
      results: [
        { title: "Result", url: "https://example.test", content: "Snippet" },
      ],
    }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        expect(url.searchParams.get("q")).toBe("query")
        return Response.json(payload)
      },
    })
    try {
      const h = await load({
        searxng: { url: server.url.origin },
        native: { enabled: false },
      })
      const search = h.providers[0]!.execute
      expect(
        await search(
          { query: "query" },
          { signal: new AbortController().signal },
        ),
      ).toEqual([
        {
          title: "Result",
          url: "https://example.test",
          content: "Snippet",
          time: {},
        },
      ])
      payload = { results: [] }
      expect(
        await search(
          { query: "query" },
          { signal: new AbortController().signal },
        ),
      ).toEqual([])
      payload = { results: [], unresponsive_engines: [["engine", "timeout"]] }
      await expect(
        search({ query: "query" }, { signal: new AbortController().signal }),
      ).rejects.toThrow("engines failed")
    } finally {
      server.stop(true)
    }
  })
  test("provider search asks native websearch permission before resolving any model", async () => {
    const h = await load()
    let read = false
    Object.assign(h.ctx, {
      permission: {
        assert: async (request: any) => {
          expect(request.action).toBe("websearch")
          expect(request.resources).toEqual(["query"])
          throw new Error("denied")
        },
      },
      session: {
        context: async () => {
          read = true
          return []
        },
      },
    })
    await expect(
      h.tools[0]!.execute({ query: "query" }, {
        sessionID: "ses",
        messageID: "msg",
        id: "call",
        agent: "build",
        signal: new AbortController().signal,
      } as any),
    ).rejects.toThrow("denied")
    expect(read).toBe(false)
  })
  test("missing requesting assistant fails closed without borrowing a current model", async () => {
    const h = await load()
    Object.assign(h.ctx, {
      permission: { assert: async () => {} },
      session: { context: async () => [] },
    })
    await expect(
      h.tools[0]!.execute({ query: "query" }, {
        sessionID: "ses",
        messageID: "msg",
        id: "call",
        agent: "build",
        signal: new AbortController().signal,
      } as any),
    ).rejects.toThrow("not sent")
  })
})

test("cancelling an uncooperative requesting-message lookup settles without dispatch", async () => {
  const h = await load()
  let resolveLookup: (value: unknown) => void = () => {}
  Object.assign(h.ctx, {
    permission: { assert: async () => {} },
    session: {
      context: () =>
        new Promise((resolve) => {
          resolveLookup = resolve
        }),
    },
    provider: {
      get: () => {
        throw new Error("must not dispatch after cancellation")
      },
    },
  })
  const controller = new AbortController()
  const pending = h.tools[0]!.execute({ query: "query" }, {
    sessionID: "ses",
    messageID: "msg",
    id: "call",
    agent: "build",
    signal: controller.signal,
  } as any)
  await Bun.sleep(1)
  controller.abort()
  expect(
    await Promise.race([
      pending.then(
        () => false,
        () => true,
      ),
      Bun.sleep(50).then(() => false),
    ]),
  ).toBe(true)
  resolveLookup([
    {
      id: "msg",
      type: "assistant",
      model: { providerID: "openai", id: "model" },
    },
  ])
  await Bun.sleep(1)
})

test("SearXNG invalid configuration never echoes endpoint credentials", async () => {
  const h = await load({
    searxng: { url: "invalid?token=private-value" },
    native: { enabled: false },
  })
  const call = h.providers[0]!.execute(
    { query: "q" },
    { signal: new AbortController().signal },
  )
  await expect(call).rejects.toThrow("Invalid SearXNG endpoint")
  try {
    await call
  } catch (error) {
    expect(String(error)).not.toContain("private-value")
  }
})

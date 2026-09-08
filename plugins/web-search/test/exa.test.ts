import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import {
  exaRequestBody,
  exaRequestUrl,
  exaSearch,
  parseExaResponse,
} from "../src/backends/exa"
import { DEFAULT_EXA_TIMEOUT_MS, DEFAULT_EXA_URL } from "../src/shared"

const never = new AbortController().signal

const ENVELOPE = JSON.stringify({
  result: { content: [{ type: "text", text: "exa results here" }] },
})

let server: ReturnType<typeof Bun.serve>
let respondWith: () => Response
let received: { url: URL; body: unknown; accept: string | null } | undefined

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received = {
        url: new URL(request.url),
        body: await request.json(),
        accept: request.headers.get("Accept"),
      }
      return respondWith()
    },
  })
})

afterAll(() => {
  server.stop(true)
})

afterEach(() => {
  delete process.env.EXA_API_KEY
})

function options(overrides: Partial<{ enabled: boolean; url: string }> = {}) {
  return {
    enabled: overrides.enabled ?? true,
    url: overrides.url ?? `http://127.0.0.1:${server.port}/mcp`,
    timeoutMs: DEFAULT_EXA_TIMEOUT_MS,
  }
}

describe("request shape (pinned to the builtin's mcp-websearch call)", () => {
  test("the JSON-RPC envelope calls web_search_exa with query-derived args only", () => {
    expect(
      exaRequestBody({
        query: "solar flares",
        type: "deep",
        numResults: 3,
        livecrawl: "preferred",
        contextMaxCharacters: 5_000,
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query: "solar flares",
          type: "deep",
          numResults: 3,
          livecrawl: "preferred",
          contextMaxCharacters: 5_000,
        },
      },
    })
  })

  test("defaults mirror the builtin: auto, 8 results, fallback crawl", () => {
    const body = exaRequestBody({ query: "q" }) as {
      params: { arguments: Record<string, unknown> }
    }
    expect(body.params.arguments).toEqual({
      query: "q",
      type: "auto",
      numResults: 8,
      livecrawl: "fallback",
    })
  })

  test("EXA_API_KEY rides ONLY the builtin's default URL", () => {
    expect(exaRequestUrl(DEFAULT_EXA_URL)).toBe(DEFAULT_EXA_URL)
    process.env.EXA_API_KEY = "k/y"
    expect(exaRequestUrl(DEFAULT_EXA_URL)).toBe(
      `${DEFAULT_EXA_URL}?exaApiKey=k%2Fy`,
    )
    // A custom exa.url (proxy, mock, plain HTTP) never receives the
    // credential implicitly — that would disclose it to whatever host the
    // option happens to point at.
    expect(exaRequestUrl("http://127.0.0.1:9/mcp")).toBe(
      "http://127.0.0.1:9/mcp",
    )
    expect(exaRequestUrl("https://proxy.corp/mcp")).toBe(
      "https://proxy.corp/mcp",
    )
  })
})

describe("response parsing (direct JSON and SSE)", () => {
  test("a direct JSON body yields the first non-empty content text", () => {
    expect(parseExaResponse(ENVELOPE)).toEqual({
      kind: "text",
      text: "exa results here",
    })
  })

  test("an SSE body scans data: lines for the envelope", () => {
    const sse = `event: message\ndata: ${ENVELOPE}\n\n`
    expect(parseExaResponse(sse)).toEqual({
      kind: "text",
      text: "exa results here",
    })
  })

  test("garbage yields null; a valid empty result yields empty", () => {
    expect(parseExaResponse("not json")).toBeNull()
    expect(parseExaResponse('{"result":{"content":[]}}')).toEqual({
      kind: "empty",
    })
  })

  test("JSON-RPC and MCP tool errors classify as errors, not results", () => {
    expect(
      parseExaResponse('{"jsonrpc":"2.0","id":1,"error":{"message":"boom"}}'),
    ).toEqual({ kind: "rpc-error", message: "boom" })
    expect(parseExaResponse('{"error":{"code":-32600}}')).toEqual({
      kind: "rpc-error",
      message: "code -32600",
    })
    expect(
      parseExaResponse(
        '{"result":{"isError":true,"content":[{"type":"text","text":"quota exhausted"}]}}',
      ),
    ).toEqual({ kind: "tool-error", message: "quota exhausted" })
  })

  test("a text success elsewhere in the stream wins over a stray error", () => {
    const sse = [
      `data: {"error":{"message":"transient"}}`,
      `data: ${ENVELOPE}`,
    ].join("\n")
    expect(parseExaResponse(sse)).toEqual({
      kind: "text",
      text: "exa results here",
    })
  })
})

describe("exaSearch against a loopback MCP endpoint", () => {
  test("a healthy endpoint answers ok and the wire shape is the pinned one", async () => {
    respondWith = () =>
      new Response(ENVELOPE, {
        headers: { "Content-Type": "application/json" },
      })
    const outcome = await exaSearch(options(), { query: "solar" }, never)
    expect(outcome).toEqual({ kind: "ok", output: "exa results here" })
    expect(received?.accept).toBe("application/json, text/event-stream")
    expect(received?.body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "web_search_exa" },
    })
  })

  test("disabled reports unavailable without touching the network", async () => {
    received = undefined
    const outcome = await exaSearch(
      options({ enabled: false }),
      { query: "q" },
      never,
    )
    expect(outcome.kind).toBe("unavailable")
    expect(received).toBeUndefined()
  })

  test("an empty envelope is a final no-results answer", async () => {
    respondWith = () =>
      new Response('{"result":{"content":[]}}', {
        headers: { "Content-Type": "application/json" },
      })
    const outcome = await exaSearch(options(), { query: "q" }, never)
    expect(outcome.kind).toBe("ok")
    if (outcome.kind !== "ok") throw new Error("unreachable")
    expect(outcome.output).toContain("No search results found")
  })

  test("a non-2xx answer errors with the status", async () => {
    respondWith = () => new Response("upstream sad", { status: 502 })
    const outcome = await exaSearch(options(), { query: "q" }, never)
    expect(outcome.kind).toBe("error")
    if (outcome.kind !== "error") throw new Error("unreachable")
    expect(outcome.reason).toContain("502")
  })

  test("an HTTP-200 JSON-RPC error falls through instead of ending the chain", async () => {
    respondWith = () =>
      new Response('{"jsonrpc":"2.0","id":1,"error":{"message":"boom"}}', {
        headers: { "Content-Type": "application/json" },
      })
    const outcome = await exaSearch(options(), { query: "q" }, never)
    expect(outcome.kind).toBe("error")
    if (outcome.kind !== "error") throw new Error("unreachable")
    expect(outcome.reason).toContain("boom")
  })

  test("an HTTP-200 MCP isError falls through with the tool message", async () => {
    respondWith = () =>
      new Response(
        '{"result":{"isError":true,"content":[{"type":"text","text":"quota exhausted"}]}}',
        { headers: { "Content-Type": "application/json" } },
      )
    const outcome = await exaSearch(options(), { query: "q" }, never)
    expect(outcome.kind).toBe("error")
    if (outcome.kind !== "error") throw new Error("unreachable")
    expect(outcome.reason).toContain("quota exhausted")
  })

  test("an unrecognized 200 body is an error, not a fake empty result", async () => {
    respondWith = () => new Response("<html>gateway page</html>")
    const outcome = await exaSearch(options(), { query: "q" }, never)
    expect(outcome.kind).toBe("error")
    if (outcome.kind !== "error") throw new Error("unreachable")
    expect(outcome.reason).toContain("unrecognized body")
  })

  test("an unreachable endpoint errors with the fetch reason", async () => {
    const outcome = await exaSearch(
      options({ url: "http://127.0.0.1:9/mcp" }),
      { query: "q" },
      never,
    )
    expect(outcome.kind).toBe("error")
  })

  test("failure reasons carry a sanitized endpoint label, never credentials", async () => {
    const outcome = await exaSearch(
      options({ url: "http://user:sekret@127.0.0.1:9/mcp?token=tok" }),
      { query: "q" },
      never,
    )
    expect(outcome.kind).toBe("error")
    if (outcome.kind !== "error") throw new Error("unreachable")
    expect(outcome.reason).not.toContain("sekret")
    expect(outcome.reason).not.toContain("tok")
  })
})

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  formatSearxngOutput,
  parseSearxngResults,
  parseSearxngUnresponsiveEngines,
  searxngRequestUrl,
  searxngSearch,
} from "../src/backends/searxng"
import { DEFAULT_SEARXNG_TIMEOUT_MS, MIN_TIMEOUT_MS } from "../src/shared"

const never = new AbortController().signal

type Served = {
  status: number
  body: string
  contentType?: string
}

let server: ReturnType<typeof Bun.serve>
let serve: Served
let lastUrl: URL | undefined

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      lastUrl = new URL(request.url)
      return new Response(serve.body, {
        status: serve.status,
        headers: {
          "Content-Type": serve.contentType ?? "application/json",
        },
      })
    },
  })
})

afterAll(() => {
  server.stop(true)
})

function base(): string {
  return `http://127.0.0.1:${server.port}`
}

function options(overrides: Partial<{ url: string | undefined }> = {}) {
  return {
    url: "url" in overrides ? overrides.url : base(),
    timeoutMs: DEFAULT_SEARXNG_TIMEOUT_MS,
  }
}

const RESULTS = {
  query: "bun test",
  number_of_results: 0, // upstream often reports 0 here; it must be ignored
  results: [
    {
      title: "Bun docs",
      url: "https://bun.sh/docs",
      content: "Bun's test runner.",
      engine: "duckduckgo",
    },
    { url: "https://example.com/plain" },
    { title: "no url — dropped" },
  ],
}

describe("request mapping", () => {
  test("q, format=json, and pageno ride the query string", () => {
    const url = new URL(
      searxngRequestUrl("http://searx.internal:8080", {
        query: "rust async traits",
      }),
    )
    expect(url.pathname).toBe("/search")
    expect(url.searchParams.get("q")).toBe("rust async traits")
    expect(url.searchParams.get("format")).toBe("json")
    expect(url.searchParams.get("pageno")).toBe("1")
  })
})

describe("response mapping", () => {
  test("hits map content→snippet and drop url-less entries", () => {
    const hits = parseSearxngResults(RESULTS)
    expect(hits).toEqual([
      {
        title: "Bun docs",
        url: "https://bun.sh/docs",
        snippet: "Bun's test runner.",
        engine: "duckduckgo",
      },
      {
        title: "https://example.com/plain",
        url: "https://example.com/plain",
        snippet: "",
        engine: undefined,
      },
    ])
  })

  test("unresponsive_engines parses defensively: pairs label, junk drops", () => {
    expect(
      parseSearxngUnresponsiveEngines({
        unresponsive_engines: [
          ["duckduckgo", "timeout"],
          ["qwant"],
          [42, "reason"],
          "junk",
        ],
      }),
    ).toEqual(["duckduckgo (timeout)", "qwant"])
    expect(parseSearxngUnresponsiveEngines({})).toEqual([])
    expect(parseSearxngUnresponsiveEngines(null)).toEqual([])
  })

  test("a body without a results array is a parse failure, not zero hits", () => {
    expect(parseSearxngResults({})).toBeNull()
    expect(parseSearxngResults("nope")).toBeNull()
  })

  test("formatting numbers hits and honors the limit", () => {
    const hits = parseSearxngResults(RESULTS) ?? []
    const output = formatSearxngOutput("bun test", hits, 1)
    expect(output).toContain('Search results for "bun test" (1 of 2)')
    expect(output).toContain("1. Bun docs (duckduckgo)")
    expect(output).toContain("https://bun.sh/docs")
    expect(output).not.toContain("example.com")
  })
})

describe("searxngSearch against a live loopback instance", () => {
  test("a healthy instance answers ok with formatted hits", async () => {
    serve = { status: 200, body: JSON.stringify(RESULTS) }
    const outcome = await searxngSearch(
      options(),
      { query: "bun test", numResults: 5 },
      never,
    )
    expect(outcome.kind).toBe("ok")
    if (outcome.kind !== "ok") throw new Error("unreachable")
    expect(outcome.output).toContain("Bun docs")
    expect(lastUrl?.searchParams.get("q")).toBe("bun test")
  })

  test("zero results is a final ok answer, not a fallthrough", async () => {
    serve = { status: 200, body: JSON.stringify({ results: [] }) }
    const outcome = await searxngSearch(options(), { query: "xyzzy" }, never)
    expect(outcome.kind).toBe("ok")
    if (outcome.kind !== "ok") throw new Error("unreachable")
    expect(outcome.output).toContain("No results found")
  })

  test("zero results with unresponsive engines is a failed search, not a healthy empty one", async () => {
    // Engines timing out / rate-limited / CAPTCHA'd still answer 200 with
    // an empty results array; nothing actually searched, so fall through.
    serve = {
      status: 200,
      body: JSON.stringify({
        results: [],
        unresponsive_engines: [
          ["duckduckgo", "timeout"],
          ["brave", "too many requests"],
        ],
      }),
    }
    const outcome = await searxngSearch(options(), { query: "q" }, never)
    expect(outcome.kind).toBe("error")
    if (outcome.kind !== "error") throw new Error("unreachable")
    expect(outcome.reason).toContain("duckduckgo (timeout)")
    expect(outcome.reason).toContain("brave (too many requests)")
  })

  test("real hits stay ok even when some engines were unresponsive", async () => {
    serve = {
      status: 200,
      body: JSON.stringify({
        ...RESULTS,
        unresponsive_engines: [["brave", "timeout"]],
      }),
    }
    const outcome = await searxngSearch(options(), { query: "bun test" }, never)
    expect(outcome.kind).toBe("ok")
  })

  test("no configured url reports unavailable", async () => {
    const outcome = await searxngSearch(
      options({ url: undefined }),
      { query: "q" },
      never,
    )
    expect(outcome.kind).toBe("unavailable")
  })

  test("a 403 errors with the formats/limiter hint", async () => {
    serve = { status: 403, body: "Forbidden" }
    const outcome = await searxngSearch(options(), { query: "q" }, never)
    expect(outcome.kind).toBe("error")
    if (outcome.kind !== "error") throw new Error("unreachable")
    expect(outcome.reason).toContain("403")
    expect(outcome.reason).toContain("search.formats")
  })

  test("a 200 with an HTML body errors instead of pretending zero hits", async () => {
    // The classic misconfiguration: json missing from search.formats on an
    // instance that still answers the HTML page with 200.
    serve = {
      status: 200,
      body: "<html>results</html>",
      contentType: "text/html",
    }
    const outcome = await searxngSearch(options(), { query: "q" }, never)
    expect(outcome.kind).toBe("error")
    if (outcome.kind !== "error") throw new Error("unreachable")
    expect(outcome.reason).toContain("non-JSON")
  })

  test("an unreachable instance errors with the fetch reason", async () => {
    const outcome = await searxngSearch(
      { url: "http://127.0.0.1:9", timeoutMs: MIN_TIMEOUT_MS },
      { query: "q" },
      never,
    )
    expect(outcome.kind).toBe("error")
  })

  test("failure reasons carry a sanitized endpoint label, never credentials", async () => {
    const outcome = await searxngSearch(
      {
        url: "http://admin:sekret@127.0.0.1:9",
        timeoutMs: MIN_TIMEOUT_MS,
      },
      { query: "q" },
      never,
    )
    expect(outcome.kind).toBe("error")
    if (outcome.kind !== "error") throw new Error("unreachable")
    expect(outcome.reason).not.toContain("sekret")
    expect(outcome.reason).not.toContain("admin")
  })

  test("an aborted outer signal surfaces as an error outcome", async () => {
    const controller = new AbortController()
    controller.abort()
    serve = { status: 200, body: JSON.stringify(RESULTS) }
    const outcome = await searxngSearch(
      options(),
      { query: "q" },
      controller.signal,
    )
    expect(outcome.kind).toBe("error")
  })
})

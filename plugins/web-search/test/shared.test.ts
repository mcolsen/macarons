import { describe, expect, test } from "bun:test"
import {
  type Backend,
  type BackendId,
  DEFAULT_EXA_TIMEOUT_MS,
  DEFAULT_EXA_URL,
  DEFAULT_NATIVE_TIMEOUT_MS,
  DEFAULT_ORDER,
  DEFAULT_SEARXNG_TIMEOUT_MS,
  describeChainFailure,
  MIN_TIMEOUT_MS,
  resolvedNumResults,
  resolveServerOptions,
  runSearchChain,
  safeEndpointLabel,
  toolDescription,
} from "../src/shared"

const never = new AbortController().signal

function fixed(
  id: BackendId,
  outcome: Awaited<ReturnType<Backend["run"]>>,
  calls?: string[],
): Backend {
  return {
    id,
    run: async () => {
      calls?.push(id)
      return outcome
    },
  }
}

describe("resolveServerOptions", () => {
  test("defaults: searxng-first order, no url, exa enabled at the real endpoint", () => {
    const options = resolveServerOptions(undefined)
    expect(options.order).toEqual([...DEFAULT_ORDER])
    expect(options.searxng.url).toBeUndefined()
    expect(options.searxng.timeoutMs).toBe(DEFAULT_SEARXNG_TIMEOUT_MS)
    expect(options.native.enabled).toBe(true)
    expect(options.native.timeoutMs).toBe(DEFAULT_NATIVE_TIMEOUT_MS)
    expect(options.exa.enabled).toBe(true)
    expect(options.exa.url).toBe(DEFAULT_EXA_URL)
    expect(options.exa.timeoutMs).toBe(DEFAULT_EXA_TIMEOUT_MS)
  })

  test("unknown order entries are dropped and duplicates keep first position", () => {
    const options = resolveServerOptions({
      order: ["exa", "brave", "exa", "searxng"],
    })
    expect(options.order).toEqual(["exa", "searxng"])
  })

  test("an explicit order with no recognized entries fails CLOSED", () => {
    // A user typing an order is restricting egress; a typo must not quietly
    // re-enable the default chain (which ends in paid third-party Exa).
    expect(resolveServerOptions({ order: ["searxngg"] }).order).toEqual([])
    expect(resolveServerOptions({ order: ["brave", 42] }).order).toEqual([])
    expect(resolveServerOptions({ order: [] }).order).toEqual([])
    expect(resolveServerOptions({ order: "searxng" }).order).toEqual([])
  })

  test("a partially valid explicit order keeps the recognized subset", () => {
    // Never MORE egress than the user named; the valid entries still work.
    expect(resolveServerOptions({ order: ["searxng", "exaa"] }).order).toEqual([
      "searxng",
    ])
  })

  test("searxng url is trimmed and stripped of trailing slashes", () => {
    const options = resolveServerOptions({
      searxng: { url: " http://searx.internal:8080/// " },
    })
    expect(options.searxng.url).toBe("http://searx.internal:8080")
  })

  test("non-string and empty urls stay unavailable", () => {
    expect(
      resolveServerOptions({ searxng: { url: "   " } }).searxng.url,
    ).toBeUndefined()
    expect(
      resolveServerOptions({ searxng: { url: 7 } }).searxng.url,
    ).toBeUndefined()
  })

  test("timeouts clamp to the floor and reject garbage", () => {
    const options = resolveServerOptions({
      searxng: { timeoutMs: 1 },
      exa: { timeoutMs: "soon" },
    })
    expect(options.searxng.timeoutMs).toBe(MIN_TIMEOUT_MS)
    expect(options.exa.timeoutMs).toBe(DEFAULT_EXA_TIMEOUT_MS)
  })

  test("backends toggle off explicitly; absent stays on", () => {
    const options = resolveServerOptions({
      native: { enabled: false },
      exa: { enabled: false },
    })
    expect(options.native.enabled).toBe(false)
    expect(options.exa.enabled).toBe(false)
    expect(resolveServerOptions({ native: {} }).native.enabled).toBe(true)
    expect(resolveServerOptions({}).exa.enabled).toBe(true)
  })

  test("an explicit non-boolean enabled fails CLOSED, not open", () => {
    // `"false"`, `"true"`, `1` — every explicit non-`true` disables. A typo
    // in a value meant to restrict egress must not enable a paid backend.
    expect(
      resolveServerOptions({ exa: { enabled: "false" } }).exa.enabled,
    ).toBe(false)
    expect(resolveServerOptions({ exa: { enabled: "true" } }).exa.enabled).toBe(
      false,
    )
    expect(
      resolveServerOptions({ native: { enabled: 1 } }).native.enabled,
    ).toBe(false)
  })

  test("an explicit invalid exa.url disables the backend instead of pointing at the real endpoint", () => {
    const options = resolveServerOptions({ exa: { url: 7 } })
    expect(options.exa.enabled).toBe(false)
    expect(resolveServerOptions({ exa: { url: "  " } }).exa.enabled).toBe(false)
    // Absent url keeps the default endpoint and stays enabled.
    expect(resolveServerOptions({ exa: {} }).exa.url).toBe(DEFAULT_EXA_URL)
    expect(resolveServerOptions({ exa: {} }).exa.enabled).toBe(true)
  })
})

describe("safeEndpointLabel", () => {
  test("strips userinfo, query, and fragment", () => {
    expect(
      safeEndpointLabel("https://user:secret@searx.internal:8080/search-api"),
    ).toBe("https://searx.internal:8080/search-api")
    expect(safeEndpointLabel("https://proxy.corp/mcp?token=abc#frag")).toBe(
      "https://proxy.corp/mcp",
    )
  })

  test("a bare origin keeps no trailing slash", () => {
    expect(safeEndpointLabel("http://127.0.0.1:9")).toBe("http://127.0.0.1:9")
  })

  test("non-http(s) and unparseable values get a placeholder", () => {
    expect(safeEndpointLabel("user:secret@host/search")).toBe(
      "<configured endpoint>",
    )
    expect(safeEndpointLabel("not a url")).toBe("<configured endpoint>")
  })
})

describe("runSearchChain", () => {
  test("first ok backend answers and later backends never run", async () => {
    const calls: string[] = []
    const result = await runSearchChain(
      ["searxng", "native", "exa"],
      {
        searxng: fixed("searxng", { kind: "ok", output: "hits" }, calls),
        native: fixed("native", { kind: "ok", output: "unreached" }, calls),
        exa: fixed("exa", { kind: "ok", output: "unreached" }, calls),
      },
      { query: "q" },
      never,
    )
    expect(result).toEqual({ kind: "ok", backend: "searxng", output: "hits" })
    expect(calls).toEqual(["searxng"])
  })

  test("errors and unavailability fall through in order", async () => {
    const calls: string[] = []
    const result = await runSearchChain(
      ["searxng", "native", "exa"],
      {
        searxng: fixed(
          "searxng",
          { kind: "error", reason: "instance down" },
          calls,
        ),
        native: fixed(
          "native",
          { kind: "unavailable", reason: "no provider" },
          calls,
        ),
        exa: fixed("exa", { kind: "ok", output: "exa says" }, calls),
      },
      { query: "q" },
      never,
    )
    expect(result).toEqual({ kind: "ok", backend: "exa", output: "exa says" })
    expect(calls).toEqual(["searxng", "native", "exa"])
  })

  test("a successful empty answer is final — no paid fallthrough", async () => {
    // The zero-results contract: a healthy backend that found nothing ends
    // the chain; only failures fall through.
    const calls: string[] = []
    const result = await runSearchChain(
      ["searxng", "exa"],
      {
        searxng: fixed(
          "searxng",
          { kind: "ok", output: 'No results found for "q".' },
          calls,
        ),
        native: fixed("native", { kind: "ok", output: "unreached" }, calls),
        exa: fixed("exa", { kind: "ok", output: "unreached" }, calls),
      },
      { query: "q" },
      never,
    )
    expect(result.kind).toBe("ok")
    expect(calls).toEqual(["searxng"])
  })

  test("all failing backends produce the aggregate failure", async () => {
    const result = await runSearchChain(
      ["searxng", "exa"],
      {
        searxng: fixed("searxng", { kind: "error", reason: "timed out" }),
        native: fixed("native", { kind: "ok", output: "unused" }),
        exa: fixed("exa", { kind: "unavailable", reason: "disabled" }),
      },
      { query: "q" },
      never,
    )
    expect(result.kind).toBe("failed")
    if (result.kind !== "failed") throw new Error("unreachable")
    expect(result.attempts).toEqual([
      { backend: "searxng", kind: "error", reason: "timed out" },
      { backend: "exa", kind: "unavailable", reason: "disabled" },
    ])
  })

  test("a throwing backend degrades to an error attempt, not a crash", async () => {
    const result = await runSearchChain(
      ["native", "exa"],
      {
        searxng: fixed("searxng", { kind: "ok", output: "unused" }),
        native: {
          id: "native",
          run: async () => {
            throw new Error("adapter bug")
          },
        },
        exa: fixed("exa", { kind: "ok", output: "recovered" }),
      },
      { query: "q" },
      never,
    )
    expect(result).toEqual({ kind: "ok", backend: "exa", output: "recovered" })
  })

  test("an aborted signal stops the chain instead of starting backends", async () => {
    const controller = new AbortController()
    controller.abort()
    const calls: string[] = []
    const result = await runSearchChain(
      ["searxng", "exa"],
      {
        searxng: fixed("searxng", { kind: "ok", output: "unused" }, calls),
        native: fixed("native", { kind: "ok", output: "unused" }, calls),
        exa: fixed("exa", { kind: "ok", output: "unused" }, calls),
      },
      { query: "q" },
      controller.signal,
    )
    expect(calls).toEqual([])
    expect(result.kind).toBe("failed")
  })

  test("onAttempt fires for each backend the instant before it runs", async () => {
    // The sidebar tracks which backend a running search is on; the hook must
    // report every attempted backend in order and none that never runs.
    const attempted: BackendId[] = []
    await runSearchChain(
      ["searxng", "native", "exa"],
      {
        searxng: fixed("searxng", { kind: "error", reason: "down" }),
        native: fixed("native", { kind: "unavailable", reason: "no provider" }),
        exa: fixed("exa", { kind: "ok", output: "hit" }),
      },
      { query: "q" },
      never,
      (backend) => attempted.push(backend),
    )
    expect(attempted).toEqual(["searxng", "native", "exa"])
  })

  test("onAttempt does not fire for an already-aborted chain", async () => {
    const controller = new AbortController()
    controller.abort()
    const attempted: BackendId[] = []
    await runSearchChain(
      ["searxng"],
      {
        searxng: fixed("searxng", { kind: "ok", output: "x" }),
        native: fixed("native", { kind: "ok", output: "x" }),
        exa: fixed("exa", { kind: "ok", output: "x" }),
      },
      { query: "q" },
      controller.signal,
      (backend) => attempted.push(backend),
    )
    expect(attempted).toEqual([])
  })
})

describe("failure description", () => {
  test("names each backend with its kind and reason", () => {
    const text = describeChainFailure([
      { backend: "searxng", kind: "error", reason: "timed out" },
      { backend: "native", kind: "unavailable", reason: "no provider" },
    ])
    expect(text).toContain("searxng: failed — timed out")
    expect(text).toContain("native: unavailable — no provider")
    expect(text).toContain("Nothing was searched")
  })
})

describe("tool surface helpers", () => {
  test("the description carries the current year twice and the shape caveat", () => {
    const text = toolDescription(2026)
    expect(text).toContain("The current year is 2026")
    expect(text).toContain('"AI news 2026", NOT "AI news 2025"')
    expect(text).toContain("Output shape varies by backend")
  })

  test("numResults clamps to a sane window", () => {
    expect(resolvedNumResults({ query: "q" })).toBe(8)
    expect(resolvedNumResults({ query: "q", numResults: 3 })).toBe(3)
    expect(resolvedNumResults({ query: "q", numResults: 500 })).toBe(50)
    expect(resolvedNumResults({ query: "q", numResults: -1 })).toBe(1)
  })
})

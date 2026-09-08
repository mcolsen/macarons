import { describe, expect, test } from "bun:test"
import { stableStringify } from "../src/index"

/**
 * Promoted from approve-for-me with its behavior — and this test
 * suite — intact (2026-07-23 audit §4, issue #114). The provenance markers in
 * the test names (audit L-AF2, PR #67 review F1/F4) date from the original
 * in-plugin hardening passes and still describe what each case pins.
 */

describe("stableStringify (request fingerprints, audit L-AF2 + PR #67 review F1/F4)", () => {
  // The original caller computes fingerprints inside an event hook, before
  // any exception boundary: the serializer must be TOTAL (never throw,
  // whatever the host or another plugin put in metadata) and deterministic,
  // while still distinguishing different contents — a collision would let a
  // changed request ride an in-flight verdict. Non-JSON states render as
  // UNQUOTED typed tokens, so no user string can forge them; states whose
  // content the serializer cannot fully see flag `lossy`, and the caller
  // then refuses to treat any re-emission as unchanged.
  const lossyOf = (value: unknown): boolean => {
    const state = { lossy: false }
    stableStringify(value, state)
    return state.lossy
  }

  test("BigInt values serialize instead of throwing", () => {
    expect(() => JSON.stringify({ big: 10n })).toThrow()
    expect(stableStringify({ big: 10n })).toBe('{"big":10n}')
    expect(stableStringify({ big: 10n })).not.toBe(
      stableStringify({ big: 11n }),
    )
    expect(lossyOf({ big: 10n })).toBe(false)
  })

  test("cycles collapse to a marker; shared (acyclic) branches serialize normally", () => {
    const cyclic: Record<string, unknown> = { name: "a" }
    cyclic.self = cyclic
    expect(() => JSON.stringify(cyclic)).toThrow()
    expect(stableStringify(cyclic)).toBe('{"name":"a","self":[circular]}')
    const shared = { x: 1 }
    expect(stableStringify({ left: shared, right: shared })).toBe(
      '{"left":{"x":1},"right":{"x":1}}',
    )
  })

  test('a user string can never forge a marker: the literal "[circular]" stays a quoted string', () => {
    // Review F1: the old encoding rendered both as the same JSON string, so
    // a request whose metadata changed between the cyclic and literal form
    // would have read as unchanged and ridden the in-flight verdict.
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(stableStringify(cyclic)).toBe('{"self":[circular]}')
    expect(stableStringify({ self: "[circular]" })).toBe(
      '{"self":"[circular]"}',
    )
    expect(stableStringify(cyclic)).not.toBe(
      stableStringify({ self: "[circular]" }),
    )
    // Cycles alone are NOT lossy: any cycle already makes a plain
    // JSON.stringify throw, so equal renderings imply equal fallback views.
    expect(lossyOf(cyclic)).toBe(false)
  })

  test("distinct cyclic contents stay distinguishable", () => {
    const one: Record<string, unknown> = { x: 1 }
    one.self = one
    const two: Record<string, unknown> = { x: 2 }
    two.self = two
    expect(stableStringify(one)).not.toBe(stableStringify(two))
  })

  test("key order never changes the fingerprint", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(
      stableStringify({ b: 2, a: 1 }),
    )
  })

  test("Dates keep their timestamp (JSON.stringify distinguished them via toJSON)", () => {
    expect(stableStringify(new Date(1_000))).toBe("Date(1000)")
    expect(stableStringify(new Date(1_000))).not.toBe(
      stableStringify(new Date(2_000)),
    )
    expect(lossyOf(new Date(1_000))).toBe(false)
  })

  test("toJSON-bearing and non-plain objects are opaque AND lossy (review F1: the URL collision)", () => {
    // JSON.stringify — the original caller's prompt view — serializes a URL
    // via its toJSON, so different URLs are different prompts; enumerable
    // keys alone rendered them all as "{}". Opaque values cannot prove a
    // re-emission unchanged, so they poison the fingerprint.
    expect(stableStringify(new URL("https://safe.example"))).toBe("[opaque]")
    expect(lossyOf(new URL("https://safe.example"))).toBe(true)
    expect(lossyOf({ nested: { toJSON: () => "x" } })).toBe(true)
    class Custom {
      x = 1
    }
    expect(lossyOf({ instance: new Custom() })).toBe(true)
    // A Date whose toJSON was replaced no longer serializes faithfully.
    const oddDate = new Date(1_000)
    ;(oddDate as unknown as { toJSON: () => string }).toJSON = () => "odd"
    expect(lossyOf(oddDate)).toBe(true)
  })

  test("undefined, symbols, and functions serialize to stable, quote-delimited markers", () => {
    expect(stableStringify([undefined, Symbol("s"), function named() {}])).toBe(
      '[undefined,Symbol("s"),Function("named")]',
    )
    // The name is JSON-quoted so a crafted one cannot forge structure.
    expect(stableStringify([Symbol('a"),1')])).toBe('[Symbol("a\\"),1")]')
  })

  test("throwing getters and lying accessors are marked unreadable in place, never thrown — and lossy", () => {
    const hostile = {}
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        throw new Error("gotcha")
      },
    })
    expect(stableStringify({ before: 1, nested: hostile })).toBe(
      '{"before":1,"nested":{"boom":[unreadable]}}',
    )
    expect(lossyOf({ nested: hostile })).toBe(true)
  })

  test("a revoked proxy is unreadable, not a throw", () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    expect(() => stableStringify({ dead: proxy })).not.toThrow()
    expect(stableStringify({ dead: proxy })).toContain("[unreadable]")
    expect(lossyOf({ dead: proxy })).toBe(true)
  })

  test("every defensive catch arm marks unreadable-in-place and flags lossy (audit WP8)", () => {
    // Each hostile accessor throws inside exactly one guarded read in
    // stableStringify. The serializer must swallow it in place (never throw),
    // emit the unquoted marker, AND flag state.lossy so the caller refuses to
    // treat a re-emission as unchanged — except the function-name arm, which
    // recovers the name via spend() into Function() and is intentionally NOT
    // lossy. Removing any one wrapper turns exotic event metadata into an
    // unhandled rejection in the host's event pipeline (audit L-AF2); a
    // marker-without-lossy mutant would let a changed request ride an in-flight
    // verdict. The Date and plain-object cases share one throwing-toJSON
    // fixture but hit different arms: a real Date reaches it via the
    // instanceof-Date branch, a plain object via the toJSON-typeof branch.
    const cases: {
      label: string
      make: () => unknown
      token: string
      lossy: boolean
    }[] = [
      {
        label: "function name getter",
        make: () => {
          const fn = function named() {}
          Object.defineProperty(fn, "name", {
            configurable: true,
            get() {
              throw new Error("name")
            },
          })
          return { fn }
        },
        token: "Function()",
        lossy: false,
      },
      {
        label: "Date with a throwing toJSON getter (instanceof-Date arm)",
        make: () => {
          const date = new Date(1_000)
          Object.defineProperty(date, "toJSON", {
            configurable: true,
            get() {
              throw new Error("toJSON")
            },
          })
          return { date }
        },
        token: "[unreadable]",
        lossy: true,
      },
      {
        label: "plain object with a throwing toJSON getter (toJSON-typeof arm)",
        make: () => {
          const value = {}
          Object.defineProperty(value, "toJSON", {
            configurable: true,
            get() {
              throw new Error("toJSON")
            },
          })
          return { value }
        },
        token: "[unreadable]",
        lossy: true,
      },
      {
        label: "array with a throwing length getter",
        make: () => ({
          arr: new Proxy([] as unknown[], {
            get(target, key) {
              if (key === "length") throw new Error("length")
              return Reflect.get(target, key)
            },
          }),
        }),
        token: "[unreadable]",
        lossy: true,
      },
      {
        label: "array with a throwing index getter",
        make: () => ({
          arr: new Proxy(["a", "b"] as unknown[], {
            get(target, key) {
              if (key === "0") throw new Error("index")
              return Reflect.get(target, key)
            },
          }),
        }),
        token: "[unreadable]",
        lossy: true,
      },
      {
        label:
          "object whose getPrototypeOf throws after instanceof consumed one",
        make: () => {
          // instanceof Date consumes the first getPrototypeOf on this proxy;
          // the explicit Object.getPrototypeOf at the prototype guard is the
          // second call — that is the one that throws, reaching the later catch
          // an always-throwing trap would never let control past (it is caught
          // at the instanceof arm first).
          let seen = 0
          return {
            value: new Proxy(
              { a: 1 },
              {
                getPrototypeOf() {
                  seen += 1
                  if (seen >= 2) throw new Error("proto")
                  return Object.prototype
                },
              },
            ),
          }
        },
        token: "[unreadable]",
        lossy: true,
      },
      {
        label: "object with a throwing ownKeys trap",
        make: () => ({
          value: new Proxy(
            { a: 1 },
            {
              ownKeys() {
                throw new Error("ownKeys")
              },
            },
          ),
        }),
        token: "[unreadable]",
        lossy: true,
      },
    ]
    for (const testCase of cases) {
      // A fresh state per iteration: state.lossy is sticky, and reusing it
      // would make the name arm read a prior case's flag.
      const state = { lossy: false }
      let rendered = ""
      expect(() => {
        rendered = stableStringify(testCase.make(), state)
      }, testCase.label).not.toThrow()
      expect(rendered, testCase.label).toContain(testCase.token)
      expect(state.lossy, testCase.label).toBe(testCase.lossy)
    }
  })

  test("hostile depth and array lengths are bounded, not a stack overflow — and lossy", () => {
    let deep: unknown = "leaf"
    for (let i = 0; i < 100_000; i++) deep = { deep }
    expect(() => stableStringify(deep)).not.toThrow()
    expect(stableStringify(deep)).toContain("[deep]")
    expect(lossyOf(deep)).toBe(true)
    const lying = new Proxy([], {
      get(target, key) {
        if (key === "length") return Number.MAX_SAFE_INTEGER
        return Reflect.get(target, key)
      },
    })
    expect(() => stableStringify(lying)).not.toThrow()
    expect(stableStringify(lying)).toContain("more]")
    expect(lossyOf(lying)).toBe(true)
  })

  test("a small shared acyclic graph stays bounded by the output budget (review F4)", () => {
    // Ancestors-only cycle detection re-renders shared branches at every
    // reference: 19 levels of {left, right} pointing at one child rendered
    // ~15 MB before the budget existed. It must now cut off quickly, flag
    // lossy, and stay far under the unbounded blowup.
    let node: Record<string, unknown> = { leaf: "x" }
    for (let i = 0; i < 19; i++) node = { left: node, right: node }
    const state = { lossy: false }
    const started = performance.now()
    const rendered = stableStringify(node, state)
    // Generous for a loaded CI box; the unbounded render took ~534ms and
    // grew exponentially with depth, so any pass here proves the cutoff.
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(rendered.length).toBeLessThan(600_000)
    expect(state.lossy).toBe(true)
    expect(rendered).toContain("[budget]")
  })

  test("oversized flat content exhausts the budget instead of memory", () => {
    const wide = Array.from(
      { length: 400 },
      (_, i) => `${i}:${"x".repeat(1_000)}`,
    )
    const state = { lossy: false }
    const rendered = stableStringify(wide, state)
    expect(state.lossy).toBe(true)
    expect(rendered.length).toBeLessThan(600_000)
  })

  test("a single oversized scalar is charged too, not accepted whole (PR #142 review F1)", () => {
    // Budget checks between nodes never caught the one-node case: a lone
    // multi-megabyte string rendered in full, lossy false.
    const state = { lossy: false }
    const rendered = stableStringify("x".repeat(1_000_000), state)
    expect(rendered).toBe("[budget]")
    expect(state.lossy).toBe(true)
  })

  test("a structural-only array DAG cannot render past the budget (PR #142 review F1)", () => {
    // Arrays of arrays emit nothing but delimiters, which were never charged:
    // 22 levels of [child, child] rendered ~20 MB of brackets, lossy false.
    let node: unknown[] = []
    for (let i = 0; i < 22; i++) node = [node, node]
    const state = { lossy: false }
    const started = performance.now()
    const rendered = stableStringify(node, state)
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(rendered.length).toBeLessThan(600_000)
    expect(state.lossy).toBe(true)
    expect(rendered).toContain("[budget]")
  })
})

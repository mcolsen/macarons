import { describe, expect, test } from "bun:test"
import { GLOBAL_FILTER, RULES } from "../src/engine/rules.generated"
import type { FilterNode } from "../src/engine/types"

// Invariants the scanner relies on, checked against the committed generated
// module so a bad regeneration cannot slip through review unnoticed.

describe("generated rule data", () => {
  test("has a plausible rule count", () => {
    expect(RULES.length).toBeGreaterThan(250)
  })

  test("ids are unique and placeholder-safe", () => {
    const ids = new Set<string>()
    for (const rule of RULES) {
      expect(rule.id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(ids.has(rule.id)).toBe(false)
      ids.add(rule.id)
    }
  })

  test("is sorted by specificity descending", () => {
    for (let i = 1; i < RULES.length; i++) {
      expect(
        (RULES[i - 1]?.specificity ?? 0) >= (RULES[i]?.specificity ?? 0),
      ).toBe(true)
    }
  })

  test("no keyword contains a JSON unit-boundary character", () => {
    // The incremental scan-context noting (audit M7) sweeps a request in
    // UNITS — one serialized message, one body array element, the husk around
    // the arrays — instead of one transcript-sized string. Splitting is sound
    // only while no keyword can straddle two units in the raw serialization,
    // which requires containing the `,` element separator or the `[`/`]`
    // array brackets; keywords carrying other punctuation (mongodb://) are
    // fine. A future vendored rule that breaks this must fail here loudly,
    // not silently weaken the cross-string gate.
    for (const rule of RULES) {
      for (const keyword of rule.keywords) expect(keyword).not.toMatch(/[,[\]]/)
    }
  })

  test("every rule has lowercase keywords and a pattern compiling in unicode mode", () => {
    // "dgu" is exactly how the scanner compiles rules — unicode mode is what
    // gives bounded quantifiers RE2's rune-counting semantics, and every
    // vendored pattern must accept it (toUnicodeCompatible in vendor-rules.ts
    // rewrites the Annex-B-only constructs at vendor time).
    for (const rule of RULES) {
      expect(rule.keywords.length).toBeGreaterThan(0)
      for (const keyword of rule.keywords)
        expect(keyword).toBe(keyword.toLowerCase())
      expect(() => new RegExp(rule.pattern, `${rule.flags}dgu`)).not.toThrow()
    }
  })

  test("every filter pattern compiles in unicode mode", () => {
    const walk = (node: FilterNode): void => {
      if ("or" in node) for (const child of node.or) walk(child)
      if ("and" in node) for (const child of node.and) walk(child)
      if ("not" in node) walk(node.not)
      if ("matches" in node) {
        for (const [source, flags] of node.matches)
          expect(() => new RegExp(source, `${flags}u`)).not.toThrow()
      }
    }
    walk(GLOBAL_FILTER)
    for (const rule of RULES) if (rule.filter) walk(rule.filter)
  })

  test("headline rules made it through vendoring", () => {
    const ids = new Set(RULES.map((rule) => rule.id))
    for (const id of [
      "github-pat",
      "aws-access-token",
      "aws-secret-access-key",
      "openai-api-key",
      "anthropic-api-key",
      "private-key",
      "generic-api-key",
    ]) {
      expect(ids.has(id)).toBe(true)
    }
  })
})

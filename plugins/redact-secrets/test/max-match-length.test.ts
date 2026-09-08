import { describe, expect, test } from "bun:test"
import { maxMatchLength } from "../src/engine/scanner"

// maxMatchLength decides whether a rule can straddle a chunk seam, and its
// answer is the premise the windowed scan rests on: a rule judged BOUNDED
// goes onto the windowed path, where scanChunk drops matches flush against a
// cut edge on the assumption that the neighboring window will see the same
// span whole. That assumption holds only while the bound is honest, so the
// walker's contract is asymmetric — overcounting costs a rule an unchunked
// pass (slow), undercounting lets a real secret cross a seam unseen (a leak).
//
// The walker is 140 hand-written lines with no other test between it and
// production: it is exported but imported by nothing outside the scanner, and
// scripts/vendor-rules.ts's canary gate uses sub-kilobyte fixtures, far under
// CHUNK_SIZE, so a regeneration cannot exercise the chunked path either. This
// is the tripwire for that pipeline — today's vendored rules contain no
// lookaround, backreference, \k or \u at all, but a future upstream sync can
// import any of them, and nothing else here would notice a bad bound.

describe("maxMatchLength", () => {
  const cases: ReadonlyArray<readonly [string, number]> = [
    // Literals and "." each consume exactly one code point in unicode mode.
    ["abc", 3],
    ["a.c", 3],
    // A character class is one atom however wide it is written; the leading
    // "]" of "[^]]" is a literal member, not the terminator.
    ["[a-z]{4}", 4],
    ["[^]]+", Infinity],
    ["[]]", 1],
    ["[^]]", 1],
    // Counted quantifiers take the UPPER bound; an open upper bound is
    // unbounded and must resolve to Infinity rather than to `n`.
    ["a{3}", 3],
    ["a{2,5}", 5],
    ["a{2,5}?", 5], // the lazy marker changes nothing about the maximum
    ["a{2,}", Infinity],
    ["a*", Infinity],
    ["a+", Infinity],
    ["a?", 1],
    ["ab{0}", 1],
    // A "{" that is not a well-formed quantifier is a literal term, so
    // "a\{2}" is four ordinary characters, not "a" repeated twice.
    ["a\\{2}", 4],
    // Alternation takes the widest branch, at both top level and inside a
    // modifier group.
    ["ab|cdef", 4],
    ["(?i:ab|cde)", 3],
    // Zero-width constructs contribute nothing: anchors, \b, and the whole
    // body of a lookahead or lookbehind.
    ["^ab$", 2],
    ["\\d\\w\\b", 2],
    ["(?=abcdef)x", 1],
    ["(?<!abc)x", 1],
    // Groups: non-capturing with a quantifier, and named capture.
    ["(?:ab){3}", 6],
    ["(?<n>abc)", 3],
    // The invariant cases. A backreference's length depends on what the
    // group captured, which is unknowable statically, so both spellings must
    // bail to Infinity rather than guess low.
    ["(a)\\1", Infinity],
    ["(a)\\9", Infinity], // the whole \1-\9 range bails, not just its head
    ["(?<n>a)\\k<n>", Infinity],
    // Anything the walker cannot parse resolves to Infinity too — the
    // catch-all is the safety net, and a pattern it silently mis-parses into
    // a finite number is the failure this whole test exists to catch.
    ["(unclosed", Infinity],
    ["[unclosed", Infinity],
    // A walk that halts before the end of the pattern has desynchronized and
    // whatever it accumulated is an UNDERCOUNT of the real maximum; the
    // terminal position check is what turns that into Infinity.
    ["ab)cd", Infinity],
    // Well-formed hex/unicode escapes consume their digits: one atom each.
    ["\\x41b", 2],
    ["\\u0041b", 2],
    // The Annex-B desync case. "\x" NOT followed by two hex digits is an
    // identity escape and the characters after it are ordinary terms.
    // Consuming digits blindly would swallow the quantifier and hand back a
    // smaller bound than the truth — undercounting, the dangerous direction.
    ["\\x{3}", 3],
    ["\\uZZ{4}", 6],
  ]

  for (const [pattern, expected] of cases) {
    test(`bounds ${JSON.stringify(pattern)} at ${expected}`, () => {
      expect(maxMatchLength(pattern)).toBe(expected)
    })
  }
})

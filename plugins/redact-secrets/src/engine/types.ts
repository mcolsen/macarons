/**
 * Data shapes shared between the vendored rule set (rules.generated.ts) and
 * the scanner. The generated module is pure data: regex sources plus filter
 * ASTs, no code — so the vendor script's output stays reviewable as a diff.
 */

/** A regex pattern already transformed to JavaScript syntax: [source, flags]. */
export type PatternData = readonly [source: string, flags: string]

/**
 * A betterleaks filter expression folded into data. A filter decides whether
 * a candidate finding should be DISCARDED (true = discard, matching upstream
 * Expr semantics). `never` stands in for clauses that cannot be evaluated on
 * an in-memory string (path attributes, token efficiency): it evaluates to
 * false, so unevaluable clauses can only cause extra redaction, never a leak.
 */
export type FilterNode =
  | { readonly or: readonly FilterNode[] }
  | { readonly and: readonly FilterNode[] }
  | { readonly not: FilterNode }
  /** Discard when shannon entropy of the secret is under the ceiling. */
  | { readonly entropyMax: number; readonly inclusive: boolean }
  /** Discard when any pattern matches the target (unanchored); target defaults to the secret. */
  | {
      readonly matches: readonly PatternData[]
      readonly target?: "match" | "line"
    }
  /** Discard when the lowercased target contains any term; target defaults to the secret. */
  | { readonly contains: readonly string[]; readonly target?: "match" | "line" }
  | { readonly never: true }

export type RuleData = {
  readonly id: string
  /** JavaScript regex source (already transformed from Go RE2). */
  readonly pattern: string
  /** Flags from the pattern's own inline modifiers ("", "i", "is"). */
  readonly flags: string
  /** Lowercase keyword gates; the rule only runs when one occurs in the content. */
  readonly keywords: readonly string[]
  /** Precedence when overlapping findings compete; upstream default is 100. */
  readonly specificity: number
  /** 1-based capture group holding the secret; otherwise first non-empty group. */
  readonly secretGroup?: number
  readonly filter?: FilterNode
  /**
   * The lazy reporting prefix (`[\w.-]{0,50}?`) stripped from the pattern
   * start at vendor time for linear-time matching (see vendor-rules.ts,
   * stripReportingPrefix). Emitted only for rules whose filter targets the
   * full MATCH text: before filter evaluation the scanner re-extends the raw
   * match leftward over this class, at most `max` chars, reconstructing
   * exactly the span the unstripped pattern would have reported — so
   * match-text filters (the generic-api-key false-positive list) still see
   * the identifier prefix their patterns key on (`random[_.-]?access`,
   * `[Mm]onkey`). `pattern` is a single character class source; the class is
   * ASCII-only in the vendored corpus, so a per-UTF-16-unit test is exact.
   */
  readonly matchPrefix?: { readonly pattern: string; readonly max: number }
}

/** One detected secret occurrence within the scanned string. */
export type Finding = {
  readonly ruleId: string
  readonly secret: string
  /** Codepoint offsets of the secret within the scanned string. */
  readonly start: number
  readonly end: number
  readonly specificity: number
}

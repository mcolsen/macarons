/**
 * A TypeScript port of the betterleaks in-memory detection pipeline
 * (detect.DetectString): keyword prefilter → per-rule regex → capture-group
 * secret extraction → specificity suppression → entropy + filter evaluation.
 * Rule data comes from rules.generated.ts, compiled out of the vendored
 * betterleaks.toml by scripts/vendor-rules.ts.
 *
 * Deliberate differences from upstream, all biased toward redacting more:
 *   - no encoded-segment passes (base64/hex/percent decoding),
 *   - no multi-part required-rule processing (primaries run standalone),
 *   - path-scoped and skipReport rules are excluded at vendor time,
 *   - failsTokenEfficiency and path-attribute filter clauses evaluate false,
 *     so they never discard a finding,
 *   - specificity suppression requires span containment, not upstream's
 *     line + string containment (see isSuppressed),
 *   - inline allow signatures (`gitleaks:allow` / `betterleaks:allow`) are
 *     NOT honored. Upstream scans a repo, where the marker is the author
 *     annotating their own code; here it would let the CONTENT of a request
 *     disable its own redaction — any file or tool output could carry a real
 *     credential past the scan by having the marker on the same line, and a
 *     serialized JSON body is typically ONE line, so a single marker would
 *     allowlist an entire wire-backstop request. Runtime content must never
 *     steer redaction policy; a deliberately-marked test fixture being
 *     masked (and restored locally) is the accepted cost.
 */

import { GLOBAL_FILTER, RULES } from "./rules.generated"
import type { FilterNode, Finding, PatternData, RuleData } from "./types"

/** Strings shorter than any redactable secret are skipped outright. */
const MIN_SCAN_LENGTH = 8

/** Long strings are scanned in overlapping windows to bound regex work. */
const CHUNK_SIZE = 100_000
/**
 * Windowed scanning is sound only for rules whose longest possible match fits
 * inside the overlap — such a match always lies entirely within some window.
 * Rules that can match longer (an unbounded PEM body, a giant JWT) would
 * straddle a seam and appear whole in NEITHER window, so scanContent gives
 * them one unchunked pass instead (see canExceedOverlap).
 *
 * Exported for the classification tests: the doubling and the `>=` in
 * canExceedOverlap are load-bearing seam-safety decisions that no shipped rule
 * currently exercises (the widest finite bound is ~4x under it), so a
 * synthetic-rule test is the only thing that can pin them.
 */
export const CHUNK_OVERLAP = 8_000

// ---- compiled artifacts (lazy, cached per generated-data identity) ---------

const ruleRegexCache = new WeakMap<RuleData, RegExp>()
const patternListCache = new WeakMap<object, readonly RegExp[]>()
const matchPrefixRegexCache = new WeakMap<RuleData, RegExp>()

/**
 * Single-character test for a rule's vendor-stripped reporting prefix class
 * (RuleData.matchPrefix): the scanner re-extends a raw match leftward over
 * this class before filter evaluation, reconstructing the match span the
 * unstripped pattern reported. The class is ASCII in the vendored corpus, so
 * testing one UTF-16 unit at a time is exact (a lone surrogate half simply
 * fails the test and stops the extension — the safe direction).
 */
function matchPrefixRegex(rule: RuleData): RegExp {
  let re = matchPrefixRegexCache.get(rule)
  if (!re) {
    re = new RegExp(`^(?:${rule.matchPrefix?.pattern})$`, "u")
    matchPrefixRegexCache.set(rule, re)
  }
  return re
}

/**
 * Rule and filter patterns compile in unicode mode (`u`): RE2 counts
 * quantifiers in RUNES, and only u-mode JS RegExp matches that — without it a
 * bounded gap like amplitude's `(?:.|[\n\r]){0,32}?` counts UTF-16 units, so
 * 17 emojis (34 units, 17 runes) overflow a gap upstream permits and the
 * secret behind them goes to the wire unredacted. `iu` also uses Unicode case
 * folding, matching RE2's `(?i)`. The vendor script guarantees every emitted
 * pattern compiles under `u` (see toUnicodeCompatible) and validates with
 * these exact flags.
 */
function ruleRegex(rule: RuleData): RegExp {
  let re = ruleRegexCache.get(rule)
  if (!re) {
    re = new RegExp(rule.pattern, `${rule.flags}dgu`)
    ruleRegexCache.set(rule, re)
  }
  return re
}

function compiledPatterns(node: {
  readonly matches: readonly PatternData[]
}): readonly RegExp[] {
  let list = patternListCache.get(node)
  if (!list) {
    list = node.matches.map(
      ([source, flags]) => new RegExp(source, `${flags}u`),
    )
    patternListCache.set(node, list)
  }
  return list
}

// ---- chunk-safety analysis ---------------------------------------------------

/**
 * Conservative upper bound on the length (in CODE POINTS — the unit a u-mode
 * atom consumes) of any string the pattern can match, or Infinity when it is
 * unbounded (unbounded quantifier, backreference) or uses syntax this
 * analyzer does not model. A code point occupies at most 2 UTF-16 units, so
 * callers comparing against UTF-16 offsets (canExceedOverlap) double this
 * bound. The direction of every approximation is DELIBERATE: overcounting
 * only moves a rule onto the unchunked scan path (a performance cost), while
 * undercounting would let a real match straddle a chunk seam unseen — so
 * anything uncertain resolves to Infinity, never to a smaller number.
 */
export function maxMatchLength(pattern: string): number {
  let pos = 0
  const fail = (): never => {
    throw new Error("unmodeled regex construct")
  }

  const parseAlternation = (): number => {
    let max = parseSequence()
    while (pattern[pos] === "|") {
      pos++
      max = Math.max(max, parseSequence())
    }
    return max
  }

  const parseSequence = (): number => {
    let total = 0
    while (pos < pattern.length && pattern[pos] !== "|" && pattern[pos] !== ")")
      total += parseTerm()
    return total
  }

  const parseTerm = (): number => {
    const c = pattern[pos] as string
    let atom: number
    if (c === "^" || c === "$") {
      pos++
      atom = 0
    } else if (c === "(") {
      atom = parseGroup()
    } else if (c === "[") {
      skipClass()
      atom = 1
    } else if (c === "\\") {
      atom = parseEscape()
    } else {
      // "." and literals match one code point in unicode mode.
      pos++
      atom = 1
    }
    const bound = parseQuantifier()
    if (bound === undefined) return atom
    return atom === 0 ? 0 : atom * bound
  }

  const parseGroup = (): number => {
    pos++ // "("
    let lookaround = false
    if (pattern[pos] === "?") {
      pos++
      const c = pattern[pos]
      if (c === "=" || c === "!") {
        pos++
        lookaround = true
      } else if (
        c === "<" &&
        (pattern[pos + 1] === "=" || pattern[pos + 1] === "!")
      ) {
        pos += 2
        lookaround = true
      } else if (c === "<") {
        const end = pattern.indexOf(">", pos)
        if (end === -1) fail()
        pos = end + 1
      } else {
        // "(?:" and modifier groups "(?i:", "(?i-m:" — flags then a colon.
        while (pos < pattern.length && /[a-z-]/i.test(pattern[pos] as string))
          pos++
        if (pattern[pos] !== ":") fail()
        pos++
      }
    }
    const inner = parseAlternation()
    if (pattern[pos] !== ")") fail()
    pos++
    return lookaround ? 0 : inner
  }

  const skipClass = (): void => {
    pos++ // "["
    if (pattern[pos] === "^") pos++
    if (pattern[pos] === "]") pos++
    while (pos < pattern.length && pattern[pos] !== "]") {
      if (pattern[pos] === "\\") pos++
      pos++
    }
    if (pattern[pos] !== "]") fail()
    pos++
  }

  const parseEscape = (): number => {
    pos++ // "\"
    const c = pattern[pos]
    if (c === undefined) fail()
    pos++
    if (c === "b" || c === "B") return 0
    // A backreference's length depends on what the group captured — unknowable.
    if ((c as string) >= "1" && (c as string) <= "9") fail()
    if (c === "k") fail()
    // Hex/unicode/control escapes only consume their digits when well-formed;
    // otherwise they are Annex-B identity escapes and the digits parse as
    // ordinary terms — consuming them blindly would desynchronize the walk
    // and could silently swallow a quantifier.
    if (c === "x" && /^[0-9a-fA-F]{2}/.test(pattern.slice(pos))) pos += 2
    else if (c === "u" && /^[0-9a-fA-F]{4}/.test(pattern.slice(pos))) pos += 4
    else if (c === "c" && /^[a-zA-Z]/.test(pattern.slice(pos))) pos += 1
    return 1
  }

  const parseQuantifier = (): number | undefined => {
    const c = pattern[pos]
    let bound: number
    if (c === "*" || c === "+") {
      pos++
      bound = Infinity
    } else if (c === "?") {
      pos++
      bound = 1
    } else if (c === "{") {
      const m = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(pos))
      if (!m) return undefined // literal "{" — the NEXT term, not a quantifier
      pos += m[0].length
      bound =
        m[2] === undefined
          ? Number(m[1])
          : m[2] === ""
            ? Infinity
            : Number(m[2])
    } else {
      return undefined
    }
    if (pattern[pos] === "?") pos++ // lazy marker
    return bound
  }

  try {
    const result = parseAlternation()
    if (pos !== pattern.length) fail()
    return result
  } catch {
    return Infinity
  }
}

const overlongRuleCache = new WeakMap<RuleData, boolean>()

/**
 * Whether the rule can match a string as long as the chunk overlap. Chunk
 * windows are sliced at UTF-16 offsets while maxMatchLength bounds CODE
 * POINTS, so the bound is doubled (a code point is at most 2 UTF-16 units)
 * before comparing. Bounded rules are STRICTLY shorter than the overlap
 * (>= routes an exact-overlap bound to the unchunked path) — the
 * seam-artifact drop in scanChunk needs that strictness: a match touching one
 * window edge must sit strictly inside the neighboring window, clear of that
 * window's own edges.
 */
export function canExceedOverlap(rule: RuleData): boolean {
  let overlong = overlongRuleCache.get(rule)
  if (overlong === undefined) {
    overlong = maxMatchLength(rule.pattern) * 2 >= CHUNK_OVERLAP
    overlongRuleCache.set(rule, overlong)
  }
  return overlong
}

// ---- keyword prefilter ------------------------------------------------------

type KeywordIndex = {
  readonly keywords: readonly string[]
  readonly rulesByKeyword: ReadonlyMap<string, RuleData[]>
}

let keywordIndex: KeywordIndex | undefined

/** ASCII letter or digit — see keywordPresent. */
function isAlnum(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90)
  )
}

/** ASCII A-Z. */
function isUpper(code: number): boolean {
  return code >= 65 && code <= 90
}

/** ASCII a-z or 0-9 — the left side of a camelCase word boundary. */
function isLowerOrDigit(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57)
}

/**
 * Shortest keyword that may be admitted on a camelCase boundary alone. See
 * CAMEL_ADMISSION in keywordPresent for the arithmetic behind the number.
 */
export const CAMEL_ADMISSION_MIN_LENGTH = 5

/**
 * Whether `original` has a camelCase word boundary at `at` — an uppercase
 * letter directly after a lowercase letter or digit, the one word start that
 * leaves no non-alphanumeric character behind for the token-start test to see
 * (`myFacebookIntegration`, `v2SourcegraphToken`).
 */
function camelBoundaryAt(original: string, at: number): boolean {
  return (
    at > 0 &&
    isUpper(original.charCodeAt(at)) &&
    isLowerOrDigit(original.charCodeAt(at - 1))
  )
}

/**
 * Whether a lowercased string contains `keyword` at a TOKEN START — that is,
 * with the preceding character something other than an ASCII letter or digit.
 *
 * This is the admission test for the STICKY CROSS-STRING context set only
 * (keywordsIn → Redactor.noteScanContext), never for matching a rule against
 * the string that holds its own keyword. The asymmetry is the point. A keyword
 * found in a string gates rules for THAT string under a plain substring test,
 * which is self-limiting: the rule still has to match there, and nothing
 * outside is affected. Promotion into the context set is the opposite — it is
 * permanent, process-wide, and flushes the scan cache, so ONE bad promotion
 * re-gates every string of every session for the rest of the process.
 *
 * That asymmetry has a price attached. This port's input, unlike the source
 * files upstream betterleaks scans, carries provider-issued opaque blobs —
 * encrypted reasoning payloads, item ids, signatures — that are base64 over a
 * ~64-character alphabet, so a short gate keyword turns up in them by
 * coincidence at a rate that scales with transcript size: `sgp_` is four
 * characters, and a few KB of ciphertext hits it regularly. On 2026-07-25
 * exactly that happened — `…wZsgp_C-4-…` inside one reasoningEncryptedContent
 * promoted `sgp_`, gating sourcegraph-access-token process-wide; it vaulted two
 * git SHAs and reset the prompt cache in five concurrent sessions at once
 * (458,880 tokens). Requiring a token start makes a coincidence also need a
 * non-alphanumeric immediately before the keyword, which base64 supplies only
 * at `+`, `/`, `-`, `_`.
 *
 * Only the LEADING side is checked: many gate keywords are deliberately
 * prefixes of what they gate (`sgp_`, `ghp_`, `sk_test`, `aws`), so a trailing
 * boundary would reject the very shapes the gate exists for. Letters and digits
 * are the only characters treated as "inside a token" — `_` and `-` are
 * boundaries, so the identifiers real config and prose produce still promote
 * (`my_sourcegraph_token`, `x-api-key`).
 *
 * CAMEL_ADMISSION — `original`, when given, is the SAME string before
 * lowercasing, and a camelCase boundary counts as a token start too
 * (`myFacebookIntegration` promotes `facebook`). Case is the only evidence of a
 * word start that survives nowhere else, and dropping it was a real detection
 * loss: a vendor named in one serialized field could no longer gate a bare
 * token in a sibling field, which is exactly what the cross-string set is for.
 *
 * It is length-gated because it is measurably weaker than the non-alphanumeric
 * test. Over a ~64-character base64 alphabet, per position and for a keyword of
 * L letters, a plain substring hit runs at p = (2/64)^L; requiring a
 * non-alphanumeric before it multiplies that by ~4/64, while a camel boundary
 * multiplies it by only ~0.5 (the first letter must be uppercase) × ~0.56 (the
 * character before it must be lowercase or a digit) ≈ 0.28 — nearly 5x looser.
 * Applied to every keyword it would give back most of the incident this
 * function exists to prevent. At L >= CAMEL_ADMISSION_MIN_LENGTH the absolute
 * rate is what matters instead: 0.28 x (2/64)^5 ≈ 8e-9 per position, under
 * 1e-4 across a 4 KB blob, versus ~3e-2 for a three-character keyword. So
 * vendor names long enough to mean something (`facebook`, `sourcegraph`,
 * `squarespace`) admit on case, and the short prefix gates that collide with
 * ciphertext (`aws`, `api`, `sgp_`) still require a real delimiter. `sgp_`
 * would need a literal `Sgp_` after a lowercase character; the 2026-07-25
 * `…wZsgp_C-4-…` stays rejected either way.
 */
export function keywordPresent(
  lowered: string,
  keyword: string,
  original?: string,
): boolean {
  const camel =
    original !== undefined &&
    original.length === lowered.length &&
    keyword.length >= CAMEL_ADMISSION_MIN_LENGTH
  let from = 0
  while (true) {
    const at = lowered.indexOf(keyword, from)
    if (at === -1) return false
    if (at === 0 || !isAlnum(lowered.charCodeAt(at - 1))) return true
    if (camel && camelBoundaryAt(original as string, at)) return true
    from = at + 1
  }
}

function getKeywordIndex(): KeywordIndex {
  if (!keywordIndex) {
    const rulesByKeyword = new Map<string, RuleData[]>()
    for (const rule of RULES) {
      for (const keyword of rule.keywords) {
        const list = rulesByKeyword.get(keyword)
        if (list) list.push(rule)
        else rulesByKeyword.set(keyword, [rule])
      }
    }
    keywordIndex = { keywords: [...rulesByKeyword.keys()], rulesByKeyword }
  }
  return keywordIndex
}

/**
 * Whether `content` contains any rule's gate keyword — i.e. whether scanning it
 * could ever produce a finding. The deep redactor uses this to decide if a
 * structured object's FIELD NAME adds detection signal a value lacks: a
 * keyword-gated rule (generic-api-key) never fires on a bare value like
 * "x7k2…" but does on the reconstructed line "api_key = x7k2…". Cheap: the same
 * substring sweep the prefilter already runs, short-circuiting on the first
 * hit.
 */
export function stringHasKeyword(content: string): boolean {
  if (!content) return false
  const lowered = content.toLowerCase()
  for (const keyword of getKeywordIndex().keywords) {
    if (lowered.includes(keyword)) return true
  }
  return false
}

/**
 * The rule-gate keywords present in `content`, minus `skip`. Callers
 * accumulate these into a cross-string context set (ScanOptions.
 * contextKeywords): the provider reads every string of a request as one
 * document, so a keyword found in ONE outbound string must gate rules in
 * EVERY string of that request. `skip` lets an accumulating caller avoid
 * re-sweeping keywords it already holds — after warm-up only the keywords
 * never yet seen are searched for.
 *
 * Admission uses keywordPresent, not a bare substring test: this set is sticky
 * and process-wide, so it holds to a higher bar than the per-string gate does.
 * The ORIGINAL string is handed down with the lowercased one so a camelCase
 * word start still counts as a token start (see keywordPresent).
 */
export function keywordsIn(
  content: string,
  skip?: ReadonlySet<string>,
): string[] {
  if (!content) return []
  const lowered = content.toLowerCase()
  const found: string[] = []
  for (const keyword of getKeywordIndex().keywords) {
    if (skip?.has(keyword)) continue
    if (keywordPresent(lowered, keyword, content)) found.push(keyword)
  }
  return found
}

/** Which rules a scan pass runs: everything, or one side of the overlap split. */
type RuleScope = "all" | "bounded" | "overlong"

/**
 * Rules whose keyword occurs in the content — or in the caller-supplied
 * cross-string context (ScanOptions.contextKeywords) — in RULES order
 * (specificity descending — the vendor script sorts, mirroring
 * orderedRulesBySpecificity). The context check runs first: a set lookup is
 * cheaper than the substring sweep it short-circuits.
 */
function candidateRules(
  lowered: string,
  disabled: ReadonlySet<string> | undefined,
  scope: RuleScope,
  context?: ReadonlySet<string>,
): RuleData[] {
  const { keywords, rulesByKeyword } = getKeywordIndex()
  const hit = new Set<RuleData>()
  for (const keyword of keywords) {
    if (!context?.has(keyword) && !lowered.includes(keyword)) continue
    for (const rule of rulesByKeyword.get(keyword) ?? []) {
      if (disabled?.has(rule.id)) continue
      if (scope !== "all" && canExceedOverlap(rule) !== (scope === "overlong"))
        continue
      hit.add(rule)
    }
  }
  if (hit.size === 0) return []
  return RULES.filter((rule) => hit.has(rule))
}

// ---- entropy (byte-based, mirroring exprruntime.shannonEntropy) -------------

const utf8 = new TextEncoder()

export function shannonEntropy(secret: string): number {
  if (secret.length === 0) return 0
  const bytes = utf8.encode(secret)
  const freq = new Float64Array(256)
  for (const b of bytes) freq[b] = (freq[b] ?? 0) + 1
  const n = bytes.length
  let h = 0
  for (let i = 0; i < 256; i++) {
    const f = freq[i] ?? 0
    if (f > 0) {
      const p = f / n
      h -= p * Math.log2(p)
    }
  }
  return h
}

// ---- filter evaluation -------------------------------------------------------

type FilterContext = {
  readonly secret: string
  readonly match: string
  readonly line: string
  readonly entropy: number
}

function filterTarget(
  ctx: FilterContext,
  target: "match" | "line" | undefined,
): string {
  return target === "match"
    ? ctx.match
    : target === "line"
      ? ctx.line
      : ctx.secret
}

function evalFilter(node: FilterNode, ctx: FilterContext): boolean {
  if ("or" in node) return node.or.some((child) => evalFilter(child, ctx))
  if ("and" in node) return node.and.every((child) => evalFilter(child, ctx))
  if ("not" in node) return !evalFilter(node.not, ctx)
  if ("entropyMax" in node)
    return node.inclusive
      ? ctx.entropy <= node.entropyMax
      : ctx.entropy < node.entropyMax
  if ("matches" in node) {
    const target = filterTarget(ctx, node.target)
    return compiledPatterns(node).some((re) => re.test(target))
  }
  if ("contains" in node) {
    const lowered = filterTarget(ctx, node.target).toLowerCase()
    return node.contains.some((term) => lowered.includes(term))
  }
  return false // "never": unevaluable clauses must not discard findings
}

// ---- line bookkeeping --------------------------------------------------------

class LineMap {
  private readonly newlines: number[]
  constructor(private readonly content: string) {
    this.newlines = []
    for (
      let i = content.indexOf("\n");
      i !== -1;
      i = content.indexOf("\n", i + 1)
    )
      this.newlines.push(i)
  }

  /** 0-based line number containing the given offset. */
  lineAt(offset: number): number {
    let lo = 0
    let hi = this.newlines.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((this.newlines[mid] as number) < offset) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  lineStart(line: number): number {
    return line === 0 ? 0 : (this.newlines[line - 1] as number) + 1
  }

  lineEnd(line: number): number {
    return line < this.newlines.length
      ? (this.newlines[line] as number)
      : this.content.length
  }
}

// ---- specificity suppression (utils.go filter / isSuppressedBy...) -----------

/**
 * A finding is suppressed when a higher-specificity finding's secret span
 * CONTAINS its span — the same characters matched twice, so the more specific
 * rule owns them. Upstream suppresses by line + string containment instead;
 * for a redactor that is unsound, because a standalone second credential that
 * happens to equal a substring of another secret on the same line (a generic
 * key reusing a PAT's suffix) would be discarded as a "duplicate" and leave
 * the wire raw. Span containment implies upstream's string containment
 * (spans cover exactly the secret text), never the reverse.
 */
function isSuppressed(candidate: Finding, others: readonly Finding[]): boolean {
  for (const other of others) {
    if (
      other.ruleId !== candidate.ruleId &&
      other.specificity > candidate.specificity &&
      other.start <= candidate.start &&
      candidate.end <= other.end
    ) {
      return true
    }
  }
  return false
}

// ---- the scan ----------------------------------------------------------------

export type ScanOptions = {
  /** Rule ids to skip entirely. */
  readonly disabledRules?: ReadonlySet<string>
  /**
   * Rule-gate keywords known to be present in the WIDER outbound context this
   * string travels in — sibling message parts, the system prompt, tool
   * definitions (see Redactor.noteScanContext). The provider reads all of
   * them as one document, so a rule whose keyword sits in a sibling string
   * must still run here: the same reasoning that makes candidate rules come
   * from the full content rather than one chunk window, lifted across string
   * boundaries. Affects candidate SELECTION only — every rule's regex still
   * has to match this string on its own, so a keyword-free string gains no
   * findings its own text cannot produce.
   */
  readonly contextKeywords?: ReadonlySet<string>
}

/** Scan a string for secrets. Findings are non-overlapping post-suppression duplicates aside. */
export function scanContent(content: string, options?: ScanOptions): Finding[] {
  if (content.length < MIN_SCAN_LENGTH) return []
  // Candidate rules come from the FULL content, never from a window: the
  // keyword prefilter is a per-content gate, not a proximity requirement.
  // Several rules' keywords are not part of their token pattern at all
  // (facebook-access-token gates on "facebook" but matches a bare
  // digits|token shape), so a window that holds the token without the
  // keyword must still run the rule — computing candidates per window made
  // exactly that pair invisible whenever they landed >100KB apart.
  const lowered = content.toLowerCase()
  if (content.length <= CHUNK_SIZE) {
    return scanChunk(
      content,
      0,
      candidateRules(
        lowered,
        options?.disabledRules,
        "all",
        options?.contextKeywords,
      ),
    )
  }

  const seen = new Set<string>()
  const findings: Finding[] = []
  const collect = (batch: readonly Finding[]): void => {
    for (const finding of batch) {
      const key = `${finding.ruleId}:${finding.start}:${finding.end}`
      if (seen.has(key)) continue
      seen.add(key)
      findings.push(finding)
    }
  }
  // Rules that can match longer than CHUNK_OVERLAP (a 9KB PEM, say) can
  // straddle a window seam and appear whole in NEITHER window, so they get
  // one unchunked pass over the full content. Bounded rules keep the
  // windowed scan: overlap ≥ their longest match guarantees every occurrence
  // lies entirely inside some window. The two rule sets are disjoint, so the
  // passes cannot duplicate each other's findings.
  collect(
    scanChunk(
      content,
      0,
      candidateRules(
        lowered,
        options?.disabledRules,
        "overlong",
        options?.contextKeywords,
      ),
    ),
  )
  const bounded = candidateRules(
    lowered,
    options?.disabledRules,
    "bounded",
    options?.contextKeywords,
  )
  if (bounded.length > 0) {
    for (
      let offset = 0;
      offset < content.length;
      offset += CHUNK_SIZE - CHUNK_OVERLAP
    ) {
      const isLast = offset + CHUNK_SIZE >= content.length
      // A window's cut edges are not real content boundaries: `$`, `\b`, and a
      // greedy quantifier all behave at a slice edge as they would at true
      // end-of-input, so a match TOUCHING a seam edge may be a truncation
      // artifact (a clean "…151|<41 letters>" cut after 40 letters "matches"
      // facebook-access-token in the window while the full content matches
      // nothing — reproduced). Matches at a seam edge are dropped here and
      // owned by the neighboring window, which sees the same span with real
      // context on that side: a bounded match is strictly shorter than the
      // overlap, so a span ending at this window's cut end lies strictly
      // inside the next window (and one starting at this window's cut start
      // strictly inside the previous), clear of that window's own edges.
      collect(
        scanChunk(
          content.slice(offset, offset + CHUNK_SIZE),
          offset,
          bounded,
          offset > 0,
          !isLast,
        ),
      )
      if (isLast) break
    }
  }
  // Each pass suppressed only within itself; re-run the symmetric containment
  // pass so an overlong finding (private-key) still suppresses a bounded one
  // (generic-api-key) that the windowed pass matched inside its span.
  return findings.filter((finding) => !isSuppressed(finding, findings))
}

function scanChunk(
  chunk: string,
  baseOffset: number,
  rules: readonly RuleData[],
  cutStart = false,
  cutEnd = false,
): Finding[] {
  if (rules.length === 0) return []

  let lineMap: LineMap | undefined
  const findings: Finding[] = []

  for (const rule of rules) {
    for (const match of chunk.matchAll(ruleRegex(rule))) {
      const full = match[0]
      if (!full) continue
      const matchStart = match.index
      // Seam-artifact guard (see scanContent): a raw match flush against a CUT
      // edge may only exist because the slice ended there — the neighboring
      // window owns that span and re-judges it with real context.
      if (
        (cutStart && matchStart === 0) ||
        (cutEnd && matchStart + full.length === chunk.length)
      )
        continue

      // Upstream trims newlines off the raw match before treating it as the
      // default secret; unlike upstream we shift the start too, so the span
      // always covers exactly the secret text (a must for replacement).
      const trimmedMatch = full.replace(/^\n+/, "").replace(/\n+$/, "")
      const leading = full.length - full.replace(/^\n+/, "").length
      let secret = trimmedMatch
      let start = matchStart + leading
      let end = start + secret.length

      // Capture-group extraction: secretGroup if configured, else the first
      // non-empty group; the `d` flag gives us the group's exact span.
      if (match.length > 1) {
        let groupIndex = 0
        if (rule.secretGroup) {
          if (rule.secretGroup >= match.length) continue
          groupIndex = rule.secretGroup
        } else {
          for (let i = 1; i < match.length; i++) {
            if (match[i]) {
              groupIndex = i
              break
            }
          }
        }
        if (groupIndex > 0) {
          const value = match[groupIndex]
          const span = match.indices?.[groupIndex]
          if (!value || !span) continue
          secret = value
          ;[start, end] = span
        }
      }
      if (!secret) continue

      lineMap ??= new LineMap(chunk)
      const line = lineMap.lineAt(matchStart)
      const endLine = lineMap.lineAt(Math.max(end - 1, matchStart))
      const lineText = chunk.slice(
        lineMap.lineStart(line),
        Math.max(lineMap.lineEnd(endLine), end),
      )

      const candidate: Finding = {
        ruleId: rule.id,
        secret,
        start: baseOffset + start,
        end: baseOffset + end,
        specificity: rule.specificity,
      }
      if (isSuppressed(candidate, findings)) continue

      // Rules whose lazy reporting prefix was stripped at vendor time
      // (stripReportingPrefix) but whose FILTER inspects the match text get
      // that span back here: extend leftward over the stripped class, at most
      // `max` chars, exactly the run the original lazy prefix would have
      // matched — so generic-api-key's false-positive list still sees the
      // identifier before the keyword (`random_access`, `monkey`,
      // `primary_key`). At a chunk's cut start the extension can be truncated
      // by the slice; the filter then discards less and redacts more — the
      // safe direction, and the neighboring window re-judges the span whole.
      let matchText = trimmedMatch
      if (rule.matchPrefix) {
        const prefixRe = matchPrefixRegex(rule)
        const from = matchStart + leading
        let cursor = from
        while (
          from - cursor < rule.matchPrefix.max &&
          cursor > 0 &&
          prefixRe.test(chunk[cursor - 1] as string)
        ) {
          cursor--
        }
        if (cursor < from) matchText = chunk.slice(cursor, from) + trimmedMatch
      }

      const filterContext = {
        secret,
        match: matchText,
        line: lineText,
        entropy: shannonEntropy(secret),
      }
      if (evalFilter(GLOBAL_FILTER, filterContext)) continue
      if (rule.filter && evalFilter(rule.filter, filterContext)) continue

      findings.push(candidate)
    }
  }

  // Final symmetric pass, mirroring upstream filter(): a finding is dropped
  // when a higher-specificity finding's span contains its span — whichever
  // order the rules ran in.
  return findings.filter((finding) => !isSuppressed(finding, findings))
}

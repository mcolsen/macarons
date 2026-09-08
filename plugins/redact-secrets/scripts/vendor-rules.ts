/**
 * Compiles vendor/betterleaks/betterleaks.toml into src/engine/rules.generated.ts.
 *
 * Go RE2 patterns are mechanically transformed to JavaScript RegExp syntax and
 * every Expr filter program is folded into a FilterNode AST. The script is
 * deliberately strict: any rule field, regex construct, or filter shape it
 * does not recognize aborts the run, so upstream format changes surface as
 * vendor-time errors instead of silently weakened detection.
 *
 * Run from the plugin directory: `bun run vendor`
 */

import type { FilterNode, PatternData, RuleData } from "../src/engine/types"
import config from "../vendor/betterleaks/betterleaks.toml"

type RawRule = {
  id?: string
  regex?: string
  path?: string
  keywords?: string[]
  secretGroup?: number
  specificity?: number
  skipReport?: boolean
  filter?: string
  required?: Array<{ id?: string }>
  [key: string]: unknown
}

const DEFAULT_SPECIFICITY = 100

// ---- Go RE2 → JavaScript RegExp ---------------------------------------------

/**
 * Escapes the scanner compiles verbatim in unicode mode, split by position:
 * outside a character class the u-mode grammar allows syntax characters, `/`,
 * the class/assertion escapes, backreferences, and the code escapes; inside a
 * class it also allows `\-` but not `\B`, backrefs, or `\k`. Any escape NOT in
 * the applicable set is an identity escape of an ordinary character — Annex-B
 * syntax that unicode mode rejects — and is rewritten to the bare character,
 * which matches identically.
 */
const UNICODE_ESCAPES_COMMON = new Set([
  ..."^$\\.*+?()[]{}|/",
  ..."bdDsSwWfnrtvxucpP",
  "0",
])
const UNICODE_ESCAPES_OUTSIDE_CLASS = new Set([
  ...UNICODE_ESCAPES_COMMON,
  ..."123456789",
  "B",
  "k",
])
const UNICODE_ESCAPES_IN_CLASS = new Set([...UNICODE_ESCAPES_COMMON, "-"])

/**
 * Rewrites the Annex-B-only constructs in a (transformed) RE2 pattern into
 * their unicode-mode equivalents, so the scanner can compile it with the `u`
 * flag. Unicode mode is not cosmetic here: RE2 counts quantifiers in RUNES,
 * and only u-mode JS RegExp does the same — without it an astral character
 * (an emoji) counts as two, so a bounded gap like `(?:.|[\n\r]){0,32}?`
 * silently tightens and a secret that upstream betterleaks catches slips
 * through unredacted.
 *
 * Three construct families occur in the vendored corpus, each rewritten with
 * unchanged match semantics:
 *   - identity escapes of ordinary characters (`\-`, `\#`, `\@`): backslash
 *     dropped (see UNICODE_ESCAPES_* for the u-mode grammar sets);
 *   - literal `]`, `{`, `}` outside a class — and `{`/`}` not forming a
 *     well-formed `{m,n}` quantifier: escaped;
 *   - a literal `]` OPENING a character class: escaped. RE2, like POSIX,
 *     reads `[]x]` / `[^]x]` as a class containing `]` (Go parse.go: "] and -
 *     are okay as first char in class"), which Annex-B JS silently misparsed
 *     as the empty/any-char class plus a stray `]` — so beyond enabling `u`,
 *     this restores the upstream meaning of filters like `\[[^]]+]`.
 */
function toUnicodeCompatible(pattern: string): string {
  let out = ""
  let i = 0
  let inClass = false
  let classJustOpened = false
  while (i < pattern.length) {
    const c = pattern[i] as string
    if (c === "\\") {
      const next = pattern[i + 1]
      if (next === undefined) {
        // Trailing lone backslash — invalid in any mode; leave it for the
        // validation compile below to reject loudly.
        out += c
        i++
        continue
      }
      const allowed = inClass
        ? UNICODE_ESCAPES_IN_CLASS
        : UNICODE_ESCAPES_OUTSIDE_CLASS
      out += allowed.has(next) ? c + next : next
      i += 2
      classJustOpened = false
      continue
    }
    if (inClass) {
      if (c === "]" && classJustOpened) {
        out += "\\]"
      } else {
        if (c === "]") inClass = false
        out += c
      }
      classJustOpened = false
      i++
      continue
    }
    if (c === "[") {
      inClass = true
      out += c
      if (pattern[i + 1] === "^") {
        out += "^"
        i++
      }
      classJustOpened = true
      i++
      continue
    }
    if (c === "]") {
      out += "\\]"
      i++
      continue
    }
    if (c === "{") {
      const quantifier = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i))
      if (quantifier) {
        out += quantifier[0]
        i += quantifier[0].length
      } else {
        out += "\\{"
        i++
      }
      continue
    }
    if (c === "}") {
      out += "\\}"
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

function transformRegex(
  source: string,
  context: string,
): { pattern: string; flags: string } {
  let flags = ""
  let p = source

  // Leading inline flags apply to the whole pattern; hoist them to JS flags.
  const lead = /^\(\?([is]{1,2})\)/.exec(p)
  if (lead?.[1]) {
    flags = [...new Set(lead[1])].join("")
    p = p.slice(lead[0].length)
  }

  // Mid-pattern (?i) applies to the remainder of its enclosing group in RE2;
  // rewrite as a scoped-flag group (?i:...) spanning exactly that remainder.
  while (true) {
    const idx = p.indexOf("(?i)")
    if (idx === -1) break
    let depth = 0
    let end = p.length
    for (let j = idx + 4; j < p.length; j++) {
      const c = p[j]
      if (c === "\\") {
        j++
        continue
      }
      if (c === "[") {
        // Skip the character class ("]" is literal when first).
        j++
        if (p[j] === "^") j++
        if (p[j] === "]") j++
        while (j < p.length && p[j] !== "]") {
          if (p[j] === "\\") j++
          j++
        }
        continue
      }
      if (c === "(") depth++
      else if (c === ")") {
        if (depth === 0) {
          end = j
          break
        }
        depth--
      }
    }
    p = `${p.slice(0, idx)}(?i:${p.slice(idx + 4, end)})${p.slice(end)}`
  }

  p = p
    .replaceAll("(?P<", "(?<")
    .replaceAll("[[:alnum:]]", "[A-Za-z0-9]")
    .replaceAll("[[:alpha:]]", "[A-Za-z]")
    .replaceAll("[[:digit:]]", "[0-9]")
    .replaceAll("\\z", "$")
    .replaceAll("\\A", "^")

  p = toUnicodeCompatible(p)

  try {
    // "dgu" is how the scanner compiles rule patterns; validate the same way.
    new RegExp(p, `${flags}dgu`)
  } catch (error) {
    throw new Error(
      `${context}: transformed pattern does not compile as JS RegExp: ${error}\n  ${source}`,
    )
  }
  return { pattern: p, flags }
}

// ---- reporting-prefix strip (linear-time matching) ----------------------------

/**
 * Removes the leading lazy reporting prefix — `[\w.-]{0,50}?` and the nested
 * `[\w.-]{0,50}?(?i:[\w.-]{0,50}?...)` double — from every top-level
 * alternative of a rule pattern.
 *
 * WHY: gitleaks' semi-generic rule shape opens with a lazy, min-0 character
 * class so the reported match includes the variable name. Under RE2 that is
 * free; under a backtracking JS RegExp it is the whole scan's cost: at every
 * failing position the engine explores each prefix length before giving up,
 * so one rule costs O(content × bound) — and aws-secret-access-key's NESTED
 * pair costs O(content × bound²), which turned `key=` + 1MB of `a` into a
 * ~10-second stall (reproduced) and pushed the 100KB seam test past CI's
 * 5-second test timeout.
 *
 * WHY IT IS SOUND: a leading lazy min-0 term can never gate whether a match
 * EXISTS — it only widens match[0] leftward. For an unanchored global search
 * the stripped pattern therefore finds matches with byte-identical capture
 * groups at byte-identical positions, in the same order (the engine's
 * leftmost-position rule picks the same keyword occurrence: the prefix-padded
 * start is monotone in keyword position), and iteration resumes from the same
 * lastIndex (match ENDS are unchanged). Redaction replaces capture-group
 * spans, so findings are unchanged. The strip is applied only when that
 * argument holds exactly:
 *
 *   - the term sits at the very start of a top-level alternative (or of an
 *     alternative inside an UNQUANTIFIED group that itself sits at such a
 *     start — the aws nested shape), never after `^`, `\b`, or any other
 *     atom, where removing it would genuinely change semantics;
 *   - the quantifier is a bounded lazy `{0,n}?` — min 0, so it constrains
 *     nothing;
 *   - the alternative contains a capture group, so the extracted secret can
 *     never be the (now narrower) full match.
 *
 * The one observable difference is filter evaluation against the MATCH text
 * (generic-api-key's false-positive list keys on identifier chars before the
 * keyword: `random[_.-]?access`, `[Mm]onkey`, `primary[_.-]?key`). For rules
 * with such a filter the stripped classes are emitted as `matchPrefix`, and
 * the scanner re-extends the raw match leftward over that class (≤ max chars)
 * before evaluating filters — reconstructing exactly the span the unstripped
 * pattern reported, because the original lazy prefix always matched the
 * longest class run ending at the keyword, clamped to the bound.
 */
type StrippedClass = { source: string; max: number }

function splitTopLevelAlternatives(pattern: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inClass = false
  let start = 0
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "\\") {
      i++
      continue
    }
    if (inClass) {
      if (c === "]") inClass = false
      continue
    }
    if (c === "[") inClass = true
    else if (c === "(") depth++
    else if (c === ")") depth--
    else if (c === "|" && depth === 0) {
      parts.push(pattern.slice(start, i))
      start = i + 1
    }
  }
  parts.push(pattern.slice(start))
  return parts
}

/** Index just past the `)` matching the `(` at `open`. */
function groupEnd(pattern: string, open: number, context: string): number {
  let depth = 0
  let inClass = false
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "\\") {
      i++
      continue
    }
    if (inClass) {
      if (c === "]") inClass = false
      continue
    }
    if (c === "[") inClass = true
    else if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0) return i + 1
    }
  }
  throw new Error(`${context}: unbalanced group`)
}

function hasCaptureGroup(pattern: string): boolean {
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "\\") {
      i++
      continue
    }
    if (inClass) {
      if (c === "]") inClass = false
      continue
    }
    if (c === "[") inClass = true
    else if (c === "(") {
      if (pattern[i + 1] !== "?") return true
      // Named capture group (?<name>...), but not lookbehind (?<= / (?<!.
      if (
        pattern[i + 2] === "<" &&
        pattern[i + 3] !== "=" &&
        pattern[i + 3] !== "!"
      )
        return true
    }
  }
  return false
}

/** A `[class]{0,n}?` term at position 0, or undefined. */
const LEADING_LAZY_TERM = /^(\[(?:[^\]\\]|\\[\s\S])*\])\{0,(\d+)\}\?/

function stripAlternative(
  alt: string,
  strips: StrippedClass[],
  context: string,
  topLevel: boolean,
): string {
  // The capture-group requirement applies to the whole TOP-LEVEL alternative
  // (it guarantees the extracted secret is never the full match); the nested
  // recursion below stays under its enclosing alternative's check — for the
  // aws double shape the group lives AFTER the (?i:...) being recursed into.
  if (topLevel && !hasCaptureGroup(alt)) return alt
  let out = alt
  while (true) {
    const term = LEADING_LAZY_TERM.exec(out)
    if (!term) break
    strips.push({ source: term[1] as string, max: Number(term[2]) })
    out = out.slice(term[0].length)
  }
  // The aws-secret-access-key shape: the (case-scoped) group holding the
  // second lazy prefix. Recurse only into an UNQUANTIFIED group at the very
  // start — its content begins at the match start exactly once, so the same
  // argument applies; a quantified group's later iterations do not.
  const group = /^\(\?[a-z]*(?:-[a-z]+)?:/.exec(out)
  if (group) {
    const end = groupEnd(out, 0, context)
    if (!/^[*+?{]/.test(out.slice(end))) {
      const inner = stripPattern(
        out.slice(group[0].length, end - 1),
        strips,
        context,
        false,
      )
      out = out.slice(0, group[0].length) + inner + out.slice(end - 1)
    }
  }
  return out
}

function stripPattern(
  pattern: string,
  strips: StrippedClass[],
  context: string,
  topLevel = true,
): string {
  return splitTopLevelAlternatives(pattern)
    .map((alt) => stripAlternative(alt, strips, context, topLevel))
    .join("|")
}

/** Whether any filter clause targets the full match text (incl. under not). */
function filterUsesMatchTarget(node: FilterNode | undefined): boolean {
  if (!node) return false
  if ("or" in node) return node.or.some(filterUsesMatchTarget)
  if ("and" in node) return node.and.some(filterUsesMatchTarget)
  if ("not" in node) return filterUsesMatchTarget(node.not)
  if ("matches" in node || "contains" in node)
    return (node as { target?: string }).target === "match"
  return false
}

function stripReportingPrefix(
  pattern: string,
  filter: FilterNode | undefined,
  context: string,
): { pattern: string; matchPrefix?: { pattern: string; max: number } } {
  const strips: StrippedClass[] = []
  const stripped = stripPattern(pattern, strips, context)
  if (strips.length === 0) return { pattern }
  if (!filterUsesMatchTarget(filter)) return { pattern: stripped }
  // Filters that inspect the match text need the stripped span back. A single
  // class source (possibly stacked, as in the nested double) folds into one
  // budget; heterogeneous classes have no single re-extension rule — refuse
  // loudly so a future vendor drop gets a deliberate decision, not a silent
  // filter-behavior change.
  const sources = new Set(strips.map((s) => s.source))
  if (sources.size !== 1) {
    throw new Error(
      `${context}: match-target filter with heterogeneous stripped prefixes: ${JSON.stringify(strips)}`,
    )
  }
  const max = strips.reduce((total, s) => total + s.max, 0)
  return {
    pattern: stripped,
    matchPrefix: { pattern: strips[0]?.source as string, max },
  }
}

// ---- Expr filter mini-parser --------------------------------------------------

/**
 * Parses the subset of expr-lang that betterleaks default filters use:
 *   or/and/not, (filter.)entropy(finding["secret"]) <= N,
 *   matchesAny/containsAny(<subject>, [list]), failsTokenEfficiency(...),
 *   subjects being finding["secret"] or path-attribute expressions.
 * Attribute-based and token-efficiency clauses become { never: true } — they
 * cannot be evaluated for an in-memory string, and "never discard" is the
 * safe direction for a redactor.
 */
class FilterParser {
  private pos = 0
  constructor(
    private readonly src: string,
    private readonly context: string,
  ) {}

  parse(): FilterNode {
    const node = this.parseOr()
    this.skipWs()
    if (this.pos !== this.src.length)
      this.fail(`trailing content at ${this.pos}`)
    return node
  }

  private fail(message: string): never {
    throw new Error(
      `${this.context}: unsupported filter expression (${message}):\n${this.src}`,
    )
  }

  private skipWs(): void {
    while (
      this.pos < this.src.length &&
      /\s/.test(this.src[this.pos] as string)
    )
      this.pos++
  }

  private eat(token: string): boolean {
    this.skipWs()
    if (this.src.startsWith(token, this.pos)) {
      this.pos += token.length
      return true
    }
    return false
  }

  private expect(token: string): void {
    if (!this.eat(token)) this.fail(`expected "${token}" at ${this.pos}`)
  }

  private parseOr(): FilterNode {
    const nodes = [this.parseAnd()]
    while (this.eat("||")) nodes.push(this.parseAnd())
    return nodes.length === 1 ? (nodes[0] as FilterNode) : { or: nodes }
  }

  private parseAnd(): FilterNode {
    const nodes = [this.parseUnary()]
    while (this.eat("&&")) nodes.push(this.parseUnary())
    return nodes.length === 1 ? (nodes[0] as FilterNode) : { and: nodes }
  }

  private parseUnary(): FilterNode {
    if (this.eat("!")) return { not: this.parseUnary() }
    this.skipWs()
    if (this.src[this.pos] === "(") {
      // Could be a parenthesized boolean, or a parenthesized attribute
      // subject like (attributes["path"] ?? "") — try boolean first.
      const saved = this.pos
      try {
        this.expect("(")
        const inner = this.parseOr()
        this.expect(")")
        return inner
      } catch {
        this.pos = saved
        return this.parseCall()
      }
    }
    return this.parseCall()
  }

  private parseCall(): FilterNode {
    this.skipWs()
    const ident = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(this.src.slice(this.pos))?.[0]
    if (!ident) this.fail(`expected function call at ${this.pos}`)
    this.pos += ident.length

    switch (ident) {
      case "entropy":
      case "filter.entropy": {
        this.expect("(")
        this.parseSecretRef()
        this.expect(")")
        this.skipWs()
        const inclusive = this.eat("<=")
        if (!inclusive) this.expect("<")
        this.skipWs()
        const num = /^\d+(?:\.\d+)?/.exec(this.src.slice(this.pos))?.[0]
        if (!num) this.fail(`expected number at ${this.pos}`)
        this.pos += num.length
        return { entropyMax: Number(num), inclusive }
      }
      case "matchesAny":
      case "filter.matchesAny": {
        this.expect("(")
        const subject = this.parseSubject()
        this.expect(",")
        const items = this.parseStringList()
        this.expect(")")
        if (subject === "attr") return { never: true }
        const matches: PatternData[] = items.map((item, i) => {
          const { pattern, flags } = transformRegex(
            item,
            `${this.context} filter pattern ${i}`,
          )
          return [pattern, flags]
        })
        return subject === "secret" ? { matches } : { matches, target: subject }
      }
      case "containsAny":
      case "filter.containsAny": {
        this.expect("(")
        const subject = this.parseSubject()
        this.expect(",")
        const items = this.parseStringList()
        this.expect(")")
        if (subject === "attr") return { never: true }
        // Upstream lowercases the subject only; a term with an uppercase
        // character can never match and stays inert here too.
        return subject === "secret"
          ? { contains: items }
          : { contains: items, target: subject }
      }
      case "failsTokenEfficiency":
      case "filter.failsTokenEfficiency": {
        this.expect("(")
        this.parseSecretRef()
        this.expect(")")
        return { never: true }
      }
      default:
        this.fail(`unknown function "${ident}"`)
    }
  }

  /** Classifies a call subject: the secret, the full match text, its line, or a path attribute. */
  private parseSubject(): "secret" | "match" | "line" | "attr" {
    this.skipWs()
    if (this.eat('finding["secret"]')) return "secret"
    if (this.eat('finding["match"]')) return "match"
    if (this.eat('finding["line"]')) return "line"
    this.parseAttrExpr()
    return "attr"
  }

  private parseSecretRef(): void {
    this.skipWs()
    if (!this.eat('finding["secret"]'))
      this.fail(`expected finding["secret"] at ${this.pos}`)
  }

  private parseAttrExpr(): void {
    this.skipWs()
    if (this.eat("(")) {
      this.parseAttrExpr()
      this.expect("??")
      this.parseString()
      this.expect(")")
      return
    }
    if (this.eat("get")) {
      this.expect("(")
      this.expect("attributes")
      this.expect(",")
      this.parseString()
      this.expect(",")
      this.parseString()
      this.expect(")")
      return
    }
    if (this.eat("attributes")) {
      this.expect("[")
      this.parseString()
      this.expect("]")
      return
    }
    this.fail(`expected attribute expression at ${this.pos}`)
  }

  private parseString(): string {
    this.skipWs()
    const c = this.src[this.pos]
    if (c === "`") {
      const end = this.src.indexOf("`", this.pos + 1)
      if (end === -1) this.fail("unterminated raw string")
      const value = this.src.slice(this.pos + 1, end)
      this.pos = end + 1
      return value
    }
    if (c === '"') {
      let i = this.pos + 1
      let value = ""
      while (i < this.src.length && this.src[i] !== '"') {
        if (this.src[i] === "\\") {
          const next = this.src[i + 1]
          value += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "")
          i += 2
        } else {
          value += this.src[i]
          i++
        }
      }
      if (this.src[i] !== '"') this.fail("unterminated string")
      this.pos = i + 1
      return value
    }
    this.fail(`expected string at ${this.pos}`)
  }

  private parseStringList(): string[] {
    this.expect("[")
    const items: string[] = []
    while (true) {
      this.skipWs()
      if (this.eat("]")) break
      items.push(this.parseString())
      this.skipWs()
      if (!this.eat(",")) {
        this.expect("]")
        break
      }
    }
    return items
  }
}

// ---- build --------------------------------------------------------------------

const raw = config as { rules?: RawRule[]; filter?: string; prefilter?: string }
if (!raw.rules?.length)
  throw new Error("no rules found in vendored betterleaks.toml")

const KNOWN_FIELDS = new Set([
  "id",
  "description",
  "regex",
  "path",
  "keywords",
  "secretGroup",
  "specificity",
  "skipReport",
  "filter",
  "validate",
  "required",
  "tags",
  "entropy",
  "allowlist",
  "allowlists",
])

/**
 * skipReport rules never fire standalone upstream (they only exist as
 * components of multi-part rules). For a redactor, though, a lone AWS secret
 * access key is exactly the leak that matters most, and its rule is tightly
 * shaped (exact 40-char [A-Za-z0-9/+=] value behind a secret/key assignment,
 * entropy-filtered) — so that one runs standalone here. The other aux rules
 * stay dropped, faithful to upstream.
 */
const KEEP_SKIP_REPORT = new Set(["aws-secret-access-key"])

/**
 * Extra discard clauses ORed onto a rule's upstream filter (filters DISCARD a
 * finding when they evaluate true, so OR narrows detection).
 *
 * These exist because betterleaks scans a REPOSITORY, where a shape-only rule
 * costs a reviewer one dismissal, while this port scans an agent transcript,
 * where the same rule costs every request its prompt cache: a false positive
 * mints a placeholder, and the placeholder rewrites every earlier occurrence in
 * the replayed history, so the provider's prefix cache misses from that byte on.
 * A rule whose shape collides with a value agent transcripts are FULL of is
 * therefore worth narrowing here even though upstream is right to keep it.
 *
 * sourcegraph-access-token: its third alternative is a bare `[a-fA-F0-9]{40}`,
 * which is exactly a git commit SHA. Observed cost (2026-07-25): a PR review
 * session mentioned its base and head SHAs in nearly every command and diff;
 * when the `sgp_` gate keyword turned up mid-session both SHAs were vaulted as
 * Sourcegraph tokens, and the retroactive rewrite reset the prompt cache in
 * five concurrent sessions at once — 458,880 tokens, 31.5% of that run's billed
 * input. The clause keeps both `sgp_`-prefixed alternatives always, and keeps
 * the bare 40-hex one when its own LINE carries either of two credential
 * signals:
 *
 *   - the vendor name ("sourcegraph"), which covers `SOURCEGRAPH_TOKEN=<hex>`
 *     and prose naming the product; or
 *   - an access-token authentication form. Requiring the vendor name alone was
 *     too strict: Sourcegraph's own documentation writes the header as
 *     `Authorization: token YOUR_ACCESS_TOKEN`
 *     (https://sourcegraph.com/docs/api/mcp/authentication), so the canonical
 *     layout puts the vendor on the line ABOVE the credential and produced no
 *     finding at all. `Authorization: token <40 hex>` and `src` CLI token
 *     assignments are credential-shaped whoever issued them, and a git SHA
 *     does not appear after either — so this widens the keep without giving
 *     back the false positive the clause exists to stop.
 *
 * A bare 40-hex Sourcegraph token sitting with neither signal on its line is
 * the accepted loss: nothing in its shape distinguishes it from the SHAs,
 * digests, and object ids that fill these transcripts. Line-scoped rather than
 * window-scoped for the same reason — the gate keyword is sticky and
 * process-wide, so "sourcegraph appears somewhere in the session" is true of
 * every string once it is true of one, and the line is the only context narrow
 * enough to still discriminate.
 */
const EXTRA_DISCARD_FILTERS: Record<string, FilterNode> = {
  "sourcegraph-access-token": {
    and: [
      // The bare-hex alternative only — the `sgp_` forms fail this anchor.
      { matches: [["^[a-fA-F0-9]{40}$", ""]] },
      { not: { contains: ["sourcegraph"], target: "line" } },
      {
        not: {
          matches: [
            // `Authorization: token <hex>` / `Authorization: Bearer <hex>`.
            ["authorization\\s*:\\s*(?:token|bearer)\\s", "i"],
            // `src` CLI and its env var: SRC_ACCESS_TOKEN, src auth token.
            ["src[_\\s-]?access[_\\s-]?token", "i"],
            ["\\bsrc\\s+auth\\b", "i"],
          ],
          target: "line",
        },
      },
    ],
  },
}

const dropped: Record<string, string[]> = { path: [], skipReport: [] }
const standalonePrimaries: string[] = []
const keptSkipReport: string[] = []
const extraFiltered: string[] = []
const rules: RuleData[] = []
let strippedPrefixes = 0

for (const rule of raw.rules) {
  const id = rule.id
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id))
    throw new Error(`rule id unusable in placeholders: ${JSON.stringify(id)}`)
  for (const key of Object.keys(rule)) {
    if (!KNOWN_FIELDS.has(key))
      throw new Error(
        `rule ${id}: unknown field "${key}" — inspect before vendoring`,
      )
  }
  if (
    rule.entropy !== undefined ||
    rule.allowlist !== undefined ||
    rule.allowlists !== undefined
  )
    throw new Error(
      `rule ${id}: legacy gitleaks fields present — the translate step upstream should have removed these`,
    )

  // Path-scoped rules can never fire on an in-memory string (DetectString
  // fragments carry no path), and skipReport rules only fire as components
  // of multi-part rules, which this port does not implement.
  if (rule.path) {
    dropped.path?.push(id)
    continue
  }
  if (rule.skipReport) {
    if (!KEEP_SKIP_REPORT.has(id)) {
      dropped.skipReport?.push(id)
      continue
    }
    keptSkipReport.push(id)
  }
  if (!rule.regex) throw new Error(`rule ${id}: no regex and no path`)
  if (!rule.keywords?.length)
    throw new Error(
      `rule ${id}: keywordless content rule — scanner gate would never run it`,
    )
  if (rule.required?.length) standalonePrimaries.push(id)

  const { pattern: transformed, flags } = transformRegex(
    rule.regex,
    `rule ${id}`,
  )
  const upstreamFilter = rule.filter
    ? new FilterParser(rule.filter.trim(), `rule ${id}`).parse()
    : undefined
  // Applied BEFORE stripReportingPrefix so its filterUsesMatchTarget check
  // sees the final filter: an extra clause targeting the match text has to
  // keep the stripped span available like an upstream one would.
  const extra = EXTRA_DISCARD_FILTERS[id]
  if (extra) extraFiltered.push(id)
  const filter = extra
    ? upstreamFilter
      ? { or: [upstreamFilter, extra] }
      : extra
    : upstreamFilter
  const { pattern, matchPrefix } = stripReportingPrefix(
    transformed,
    filter,
    `rule ${id}`,
  )
  if (pattern !== transformed) {
    strippedPrefixes++
    try {
      new RegExp(pattern, `${flags}dgu`)
    } catch (error) {
      throw new Error(
        `rule ${id}: prefix-stripped pattern does not compile: ${error}\n  ${pattern}`,
      )
    }
  }
  const keywords = rule.keywords.map((k) => {
    if (k !== k.toLowerCase())
      throw new Error(`rule ${id}: keyword not lowercase: ${k}`)
    return k
  })

  const data: RuleData = {
    id,
    pattern,
    flags,
    keywords,
    specificity: rule.specificity ?? DEFAULT_SPECIFICITY,
    ...(rule.secretGroup ? { secretGroup: rule.secretGroup } : {}),
    ...(filter ? { filter } : {}),
    ...(matchPrefix ? { matchPrefix } : {}),
  }
  rules.push(data)
}

// An override keyed on a rule id upstream has renamed or dropped would sit
// there doing nothing, silently restoring the false positive it was written
// for — so an unmatched key is a vendor-time error, not a warning.
for (const id of Object.keys(EXTRA_DISCARD_FILTERS)) {
  if (!extraFiltered.includes(id))
    throw new Error(
      `EXTRA_DISCARD_FILTERS targets "${id}", which no kept rule matched — upstream renamed or dropped it; re-target or remove the override`,
    )
}

if (!raw.filter)
  throw new Error("no global filter in vendored betterleaks.toml")
const globalFilter = new FilterParser(
  raw.filter.trim(),
  "global filter",
).parse()

// Mirror orderedRulesBySpecificity: stable sort, specificity descending.
rules.sort((a, b) => b.specificity - a.specificity)

// ---- emit -----------------------------------------------------------------------

const header = `// AUTO-GENERATED by scripts/vendor-rules.ts — DO NOT EDIT BY HAND.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: regex sources legitimately contain \${ sequences
//
// Rule data derived from betterleaks <https://github.com/betterleaks/betterleaks>
// (MIT License, Copyright (c) 2026 Zachary Rice). See vendor/betterleaks/ for
// the vendored source, full license text, and provenance (upstream commit).
//
// ${rules.length} content rules kept; dropped at vendor time: ${dropped.path?.length} path-scoped, ${dropped.skipReport?.length} skipReport-only.
// skipReport rules re-enabled standalone for redaction: ${keptSkipReport.join(", ")}
// Multi-part primaries running standalone (co-occurrence not ported): ${standalonePrimaries.join(", ")}
// Lazy reporting prefixes stripped for linear-time matching (see stripReportingPrefix): ${strippedPrefixes} rules.
// Extra discard clauses ORed onto the upstream filter (see EXTRA_DISCARD_FILTERS): ${extraFiltered.join(", ") || "none"}

import type { FilterNode, RuleData } from "./types"

/** Rules ordered by specificity descending (stable), as the scanner expects. */
export const RULES: readonly RuleData[] = [
${rules.map((rule) => `  ${JSON.stringify(rule)},`).join("\n")}
]

export const GLOBAL_FILTER: FilterNode = ${JSON.stringify(globalFilter)}
`

await Bun.write(
  new URL("../src/engine/rules.generated.ts", import.meta.url),
  header,
)

console.log(`rules kept: ${rules.length}`)
console.log(`lazy reporting prefixes stripped: ${strippedPrefixes}`)
console.log(
  `dropped path-scoped (${dropped.path?.length}): ${dropped.path?.join(", ")}`,
)
console.log(
  `dropped skipReport (${dropped.skipReport?.length}): ${dropped.skipReport?.join(", ")}`,
)
console.log(
  `standalone multi-part primaries (${standalonePrimaries.length}): ${standalonePrimaries.join(", ")}`,
)

// ---- canary self-test -------------------------------------------------------------

const { scanContent } = await import("../src/engine/scanner")

type Canary = {
  name: string
  content: string
  expectRule?: string
  expectNone?: boolean
}
const canaries: Canary[] = [
  // Shape-valid but fake values only (and never upstream-allowlisted ones —
  // AKIA...EXAMPLE is deliberately dropped by the aws rule's own filter).
  {
    name: "github-pat",
    content: "token: ghp_x7K2mQ9pL4vN8rT3wY6bJ1hF5dS0aZcE2gUq",
    expectRule: "github-pat",
  },
  {
    name: "aws",
    content: "aws_access_key_id = AKIAQ3ZK7P2M4XVJ5TR6",
    expectRule: "aws-access-token",
  },
  {
    name: "aws-secret",
    content:
      'aws_secret_access_key = "x7K2mQ9pL4vN8rT3wY6bJ1hF5dS0aZcE2gUq9w3e"',
    expectRule: "aws-secret-access-key",
  },
  {
    name: "openai",
    content:
      "OPENAI_API_KEY=sk-proj-x7K2mQ9pL4vN8rT3wY6bT3BlbkFJx7K2mQ9pL4vN8rT3wY6b",
    expectRule: "openai-api-key",
  },
  {
    name: "private-key",
    content: [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEx7K2mQ9pL4vN8rT3wY6bJ1hF5dS0x7K2mQ9pL4vN8rT3wY6bJ1hF5dS0",
      "aZcE2gUqx7K2mQ9pL4vN8rT3wY6bJ1hF5dS0x7K2mQ9pL4vN8rT3wY6bJ1hF",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n"),
    expectRule: "private-key",
  },
  {
    name: "generic",
    content: 'api_key = "x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce"',
    expectRule: "generic-api-key",
  },
  {
    name: "placeholder-var",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell-style placeholder is the fixture
    content: 'password = "${SECRET_VAR}"',
    expectNone: true,
  },
  { name: "boolean", content: 'api_key = "false"', expectNone: true },
  {
    name: "alphabet",
    content: 'client_secret = "abcdefghijklmnopqrstuvwxyz789012"',
    expectNone: true,
  },
  // Inline allow markers are deliberately NOT honored (scanner.ts header):
  // request content must not be able to disable its own redaction.
  {
    name: "allow-comment",
    content: "api_key = 'x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce' // gitleaks:allow",
    expectRule: "generic-api-key",
  },
  // EXTRA_DISCARD_FILTERS: a git SHA is a bare 40-hex string and must survive
  // even once the rule's gate keyword is present elsewhere in the content.
  // Both SHAs are the real ones from the 2026-07-25 incident.
  {
    name: "git-sha-not-sourcegraph",
    content: [
      "# sourcegraph notes for this review",
      "git diff 7c6dcd9f2b1ec7b052ab2d3a2123c586852c65b1 b20e359367f412864ea8c3f1c50e1af52330e5f2",
    ].join("\n"),
    expectNone: true,
  },
  {
    name: "sourcegraph-bare-hex-on-vendor-line",
    content: "SOURCEGRAPH_TOKEN=7c6dcd9f2b1ec7b052ab2d3a2123c586852c65b1",
    expectRule: "sourcegraph-access-token",
  },
  {
    name: "sourcegraph-prefixed",
    content: "token = sgp_7c6dcd9f2b1ec7b052ab2d3a2123c586852c65b1",
    expectRule: "sourcegraph-access-token",
  },
]

let failures = 0
for (const canary of canaries) {
  const findings = scanContent(canary.content)
  if (canary.expectNone && findings.length > 0) {
    console.error(
      `CANARY FAIL ${canary.name}: expected no findings, got ${findings.map((f) => f.ruleId).join(", ")}`,
    )
    failures++
  } else if (
    canary.expectRule &&
    !findings.some((f) => f.ruleId === canary.expectRule)
  ) {
    console.error(
      `CANARY FAIL ${canary.name}: expected ${canary.expectRule}, got ${findings.map((f) => f.ruleId).join(", ") || "none"}`,
    )
    failures++
  }
}
if (failures > 0) {
  console.error(
    `${failures} canary failure(s) — rules.generated.ts was written but must not be committed as-is`,
  )
  process.exit(1)
}
console.log(`canaries passed: ${canaries.length}`)

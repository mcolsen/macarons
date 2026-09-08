import os from "node:os"

export type Action = "allow" | "ask" | "deny"

export function isAction(value: unknown): value is Action {
  return value === "allow" || value === "ask" || value === "deny"
}

/** A JSON-serializable dictionary whose literal keys never reach Object.prototype. */
export function literalRecord<T>(
  entries: Iterable<readonly [string, T]> = [],
): Record<string, T> {
  const record = Object.create(null) as Record<string, T>
  for (const [key, value] of entries) record[key] = value
  return record
}

export type Store = {
  permission: Record<string, Action | Record<string, Action>>
}

export type Rule = { permission: string; pattern: string; action: Action }

// Port of OpenCode's Wildcard.match (packages/core/src/util/wildcard.ts).
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  // "git status *" also matches plain "git status"
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`

  return new RegExp(
    `^${escaped}$`,
    process.platform === "win32" ? "si" : "s",
  ).test(normalized)
}

// ---------------------------------------------------------------------------
// Pattern-language reasoning
//
// wildcardMatch answers "does this concrete STRING match this pattern". The
// migration and redundancy logic below needs two different questions about
// pattern LANGUAGES (the sets of strings two patterns match):
//
//   patternSubsumes(g, s) — is every string s matches also matched by g?
//     Sound but deliberately incomplete: true only for shapes it can prove
//     (equality, "*", a literal specific, a prefix-star general). A false
//     answer merely keeps a redundant rule; a wrong true answer would DELETE
//     an approval that was not actually covered.
//
//   patternsOverlap(a, b) — is there any string both patterns match?
//     Complete for the wildcard language (exact product construction), and
//     used to detect when a migrated rule could interfere with a carve-out; a
//     spurious overlap only downgrades an automatic merge to a manual one.
//
// Both mirror wildcardMatch's normalization: backslashes become slashes, the
// comparison is case-insensitive on win32, and a trailing " *" also matches
// the bare prefix (modeled by expanding each pattern to that two-variant
// union before comparing).
// ---------------------------------------------------------------------------

function normalizeGlob(pattern: string): string {
  const slashed = pattern.replaceAll("\\", "/")
  return process.platform === "win32" ? slashed.toLowerCase() : slashed
}

// The languages a pattern denotes under wildcardMatch's trailing-" *" quirk:
// "git status *" is exactly lang("git status") ∪ lang("git status " + "*").
function globVariants(pattern: string): string[] {
  return pattern.endsWith(" *") ? [pattern.slice(0, -2), pattern] : [pattern]
}

// Exact non-emptiness of the intersection of two plain globs (no " *" quirk —
// callers expand variants first). Product reachability over the two patterns:
// each step either lets a '*' match the empty string or consumes one input
// character that both sides accept. Memoized; every recursion advances i or j.
function globsIntersect(a: string, b: string): boolean {
  const memo = new Map<number, boolean>()
  const intersect = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j
    const seen = memo.get(key)
    if (seen !== undefined) return seen
    let result: boolean
    if (i === a.length && j === b.length) result = true
    else if (i < a.length && a[i] === "*")
      result = intersect(i + 1, j) || (j < b.length && intersect(i, j + 1))
    else if (j < b.length && b[j] === "*")
      result = intersect(i, j + 1) || (i < a.length && intersect(i + 1, j))
    else if (
      i < a.length &&
      j < b.length &&
      (a[i] === "?" || b[j] === "?" || a[i] === b[j])
    )
      result = intersect(i + 1, j + 1)
    else result = false
    memo.set(key, result)
    return result
  }
  return intersect(0, 0)
}

/** True when some string matches both patterns. Exact, quirk-aware. */
export function patternsOverlap(a: string, b: string): boolean {
  for (const va of globVariants(normalizeGlob(a))) {
    for (const vb of globVariants(normalizeGlob(b))) {
      if (globsIntersect(va, vb)) return true
    }
  }
  return false
}

// Containment of one plain glob in another, for the shapes that can be proven
// cheaply. General glob containment is genuinely hard; everything this cannot
// prove reports false, which callers treat as "not redundant".
function globCovers(general: string, specific: string): boolean {
  if (general === specific) return true
  if (general === "*") return true
  // A wildcard-free specific denotes exactly one string: containment is
  // membership of that string in the general pattern.
  if (!/[*?]/.test(specific)) return globsIntersect(general, specific)
  // A prefix-star general ("git *", "src/*") contains any pattern whose
  // strings all start with that literal prefix — i.e. whose own leading
  // literal run extends it.
  const prefix = /^([^*?]*)\*$/.exec(general)?.[1]
  if (prefix === undefined) return false
  const lead = /^[^*?]*/.exec(specific)?.[0] ?? ""
  return lead.startsWith(prefix)
}

/**
 * True when every string `specific` matches is provably also matched by
 * `general`. Sound (never true without real containment), incomplete by
 * design — see the section comment.
 */
export function patternSubsumes(general: string, specific: string): boolean {
  const g = normalizeGlob(general)
  const s = normalizeGlob(specific)
  if (g === s) return true
  return globVariants(s).every((variant) =>
    globVariants(g).some((cover) => globCovers(cover, variant)),
  )
}

// Port of OpenCode's home-directory expansion for configured patterns.
export function expandHome(pattern: string): string {
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function rulesFrom(store: Store): Rule[] {
  const rules: Rule[] = []
  for (const [permission, value] of Object.entries(store.permission ?? {})) {
    if (typeof value === "string") {
      rules.push({ permission, pattern: "*", action: value })
      continue
    }
    // Stores read through readStore are fully validated; this guard remains
    // for rule maps built from other sources (like the host's config API).
    if (!value || typeof value !== "object") continue
    for (const [pattern, action] of Object.entries(value)) {
      rules.push({ permission, pattern: expandHome(pattern), action })
    }
  }
  return rules
}

// The rule that decides a request: last matching rule wins, same as OpenCode.
export function winningRule(
  permission: string,
  pattern: string,
  rules: Rule[],
): Rule | undefined {
  return rules.findLast(
    (rule) =>
      wildcardMatch(permission, rule.permission) &&
      wildcardMatch(pattern, rule.pattern),
  )
}

// Last matching rule wins; anything unmatched stays "ask" — same as OpenCode.
export function evaluate(
  permission: string,
  pattern: string,
  rules: Rule[],
): Action {
  return winningRule(permission, pattern, rules)?.action ?? "ask"
}

// True when every requested pattern is allowed by the saved rules.
export function isAllowed(
  permission: string,
  patterns: string[],
  rules: Rule[],
): boolean {
  if (!patterns.length) return false
  return patterns.every(
    (pattern) => evaluate(permission, pattern, rules) === "allow",
  )
}

/**
 * True when adding an allow rule (permission, pattern) to `rules` is provably
 * a no-op: some allow rule already covers its whole language AND no ask/deny
 * rule overlaps it. Callers use this to skip redundant writes. Both legs
 * matter: coverage must be wildcard containment, not string matching (a
 * "git ?" rule matches the five-character STRING "git *" without covering the
 * language "git *" denotes), and an overlapping carve-out means the fresh
 * allow is not a no-op — appended last it overrides the carve-out, which is
 * exactly what persisting a fresh user approval is for.
 */
export function allowRuleRedundant(
  permission: string,
  pattern: string,
  rules: Rule[],
): boolean {
  return (
    rules.some(
      (rule) =>
        rule.action === "allow" &&
        patternSubsumes(rule.permission, permission) &&
        patternSubsumes(rule.pattern, pattern),
    ) &&
    !rules.some(
      (rule) =>
        rule.action !== "allow" &&
        patternsOverlap(rule.permission, permission) &&
        patternsOverlap(rule.pattern, pattern),
    )
  )
}

/**
 * Coerce a host event field that may be a bare string or a list of strings
 * into a string list, dropping anything that is neither. Both permission
 * plugins normalize `permission.asked` payloads at their event entry points
 * and must read historical and current event shapes the same way: a field
 * one plugin coerces and the other drops is a rule the two halves disagree
 * about.
 */
export function toStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string")
  return []
}

/**
 * A `permission.asked` event, read into the shape both permission plugins act
 * on. The superset: persist-permissions ignores the last three fields, which
 * only approve-for-me's classifier needs.
 */
export type PermissionAsk = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  /** The patterns OpenCode itself would remember for an "always" answer. */
  always: string[]
  /**
   * True when the event carried no patterns and "*" was invented for
   * evaluation. Load-bearing: a synthesized "*" must never be PERSISTED or
   * journaled as "everything" — "no pattern information" is not consent.
   */
  synthesized: boolean
  title?: string
  metadata?: unknown
  /**
   * The host's pointer to the tool call that raised the request (v1.18 events
   * carry it for every tool-raised ask). MCP and code-mode permissions arrive
   * with patterns ["*"] and empty metadata, so this pointer is the only route
   * to the call's arguments.
   */
  toolCall?: { messageID: string; callID: string }
}

/**
 * Read a `permission.asked` payload, accepting both current and historical
 * event shapes.
 *
 * This is the suite's most contract-critical shared helper: it is the single
 * place the host's event shape is interpreted, and the two permission plugins
 * MUST interpret it identically. They act on the same prompts from separate
 * processes — one deciding whether to auto-answer, the other whether to
 * persist the answer — so a field one coerces and the other drops is a rule
 * the two disagree about, for the same user on the same prompt. It stays in
 * lockstep with the host's shape by having exactly one definition site.
 *
 * When an event carries no patterns at all, "*" is synthesized so evaluation
 * stays conservative — auto-approval then needs a blanket rule to pass — and
 * the synthesis is MARKED, because consumers must not write it down as consent
 * to everything.
 */
export function normalizeRequest(
  properties: unknown,
): PermissionAsk | undefined {
  if (!properties || typeof properties !== "object") return
  const props = properties as Record<string, unknown>
  if (typeof props.id !== "string" || typeof props.sessionID !== "string")
    return

  const permission =
    typeof props.permission === "string"
      ? props.permission
      : typeof props.type === "string"
        ? props.type
        : undefined
  if (!permission) return

  let patterns = toStringArray(props.patterns)
  if (!patterns.length) patterns = toStringArray(props.pattern)
  const synthesized = !patterns.length
  if (synthesized) patterns = ["*"]

  // "always" holds the patterns OpenCode itself would remember for the
  // session. Old event shapes had no such field; they fall back to the
  // request patterns.
  const always = Object.hasOwn(props, "always")
    ? toStringArray(props.always)
    : patterns

  const pointer =
    props.tool && typeof props.tool === "object"
      ? (props.tool as Record<string, unknown>)
      : undefined
  const toolCall =
    pointer &&
    typeof pointer.messageID === "string" &&
    typeof pointer.callID === "string"
      ? { messageID: pointer.messageID, callID: pointer.callID }
      : undefined

  return {
    id: props.id,
    sessionID: props.sessionID,
    permission,
    patterns,
    always,
    synthesized,
    title: typeof props.title === "string" ? props.title : undefined,
    metadata: props.metadata,
    toolCall,
  }
}

// The session's own ruleset as exposed by GET /session/{id} — the host
// stores it in the same { permission, pattern, action } shape rules use
// (schema/v1/session.ts `permission`), set via the session-update API rather
// than by config. Junk from unknown hosts is dropped, never guessed at.
// Patterns are matched verbatim (no ~ expansion): the host expands only
// config-file patterns, not API-set session rules.
export function sessionRulesOf(session: unknown): Rule[] {
  if (!session || typeof session !== "object") return []
  const ruleset = (session as { permission?: unknown }).permission
  if (!Array.isArray(ruleset)) return []
  const rules: Rule[] = []
  for (const entry of ruleset) {
    if (!entry || typeof entry !== "object") continue
    const { permission, pattern, action } = entry as Record<string, unknown>
    if (typeof permission !== "string" || typeof pattern !== "string") continue
    if (!isAction(action)) continue
    rules.push({ permission, pattern, action })
  }
  return rules
}

// True when the session's own ruleset explicitly resolves any requested
// pattern to ask/deny. Session rules are deliberate, session-scoped
// overrides — e.g. a plugin sandboxing a forked session with "ask" rules it
// auto-rejects (opencode-btw's read-only side questions) — and a stored
// approval must never overrule them: the host evaluates them last-match-wins
// AFTER the agent ruleset, so an explicit ask/deny here is why the prompt
// exists at all. No match means the ask came from agent-level defaults,
// which stored approvals exist to answer.
export function sessionOverrides(
  permission: string,
  patterns: string[],
  sessionRules: Rule[],
): boolean {
  if (!sessionRules.length) return false
  return patterns.some((pattern) => {
    const match = winningRule(permission, pattern, sessionRules)
    return match !== undefined && match.action !== "allow"
  })
}

// The narrowest patterns that still cover an approval: OpenCode's blanket "*"
// remember-rule (which the TUI presents as tool-wide but session-scoped) is
// replaced by the request's concrete patterns; everything else is kept
// verbatim.
export function narrowestPatterns(
  always: string[],
  patterns: string[],
): string[] {
  return [
    ...new Set(
      always.flatMap((pattern) => (pattern === "*" ? patterns : [pattern])),
    ),
  ]
}

/**
 * Appends the pattern as an allow rule. Re-adding moves it to the end so the
 * freshest approval wins under last-rule-wins evaluation.
 *
 * Normalizing plain-object dictionaries may replace `store.permission` and
 * nested rule-map references; callers must read them back from `store`.
 */
export function addAllowRule(
  store: Store,
  permission: string,
  pattern: string,
): boolean {
  if (Object.getPrototypeOf(store.permission) !== null) {
    store.permission = literalRecord(
      Object.entries(store.permission).map(([key, value]) => [
        key,
        typeof value === "object" && value !== null
          ? literalRecord(Object.entries(value))
          : value,
      ]),
    )
  }
  let current = Object.hasOwn(store.permission, permission)
    ? store.permission[permission]
    : undefined
  if (typeof current === "string") {
    if (current === "allow") return false
    store.permission[permission] = literalRecord([
      ["*", current],
      [pattern, "allow"],
    ])
    return true
  }
  if (!current || typeof current !== "object") {
    // Absent — or junk from a hand-edited store, replaced by a valid rule map.
    store.permission[permission] = literalRecord([[pattern, "allow"]])
    return true
  }
  if (Object.getPrototypeOf(current) !== null) {
    current = literalRecord(Object.entries(current))
    store.permission[permission] = current
  }
  const keys = Object.keys(current)
  if (
    Object.hasOwn(current, pattern) &&
    current[pattern] === "allow" &&
    keys[keys.length - 1] === pattern
  )
    return false
  delete current[pattern]
  current[pattern] = "allow"
  return true
}

// Drops oldest entries first; used to bound the per-request bookkeeping maps.
export function trim(
  collection: Map<string, unknown> | Set<string>,
  max = 500,
) {
  while (collection.size > max) {
    const oldest = collection.keys().next().value
    if (oldest === undefined) break
    collection.delete(oldest)
  }
}

/**
 * The suite-wide ledger of permission replies authored by automation, keyed
 * by request id. The host's `permission.replied` event names no actor, and
 * Approve for Me treats a reply it cannot attribute to a plugin as the user
 * answering — the presence signal that resets its unattended-deny budget. A
 * sibling plugin's automatic reply (persist-permissions honoring a stored
 * allow, say) would read as a human and hand an unattended run a fresh
 * denial allowance. So every plugin in this suite that answers a prompt
 * automatically registers the request id here BEFORE posting the reply (the
 * host publishes the replied event while the POST is still resolving) and
 * removes it again if the POST fails; consumers delete ids as they
 * attribute events, and everyone bounds the set with trim().
 *
 * Lives on globalThis under a Symbol.for key because each plugin bundle
 * inlines its own copy of this library: module state would not be shared
 * across bundles, the realm's symbol registry is. Process-local by
 * construction — only plugins loaded into the same OpenCode instance can
 * attribute each other's replies; automation outside the suite stays
 * unattributable (and so still reads as the user).
 */
// Keep both keys for OpenCode-v1 compatibility. Self-contained plugin bundles
// inline this library, and supported file/copy installs provide no enforceable
// minimum Macarons version. Remove the bridge only when pre-Macarons bundle
// interop is explicitly unsupported, normally when the v1 plugins retire.
const AUTOMATED_REPLIES = Symbol.for("@macarons/automated-permission-replies")
const LEGACY_AUTOMATED_REPLIES = Symbol.for(
  "@mcolsen-opencode/automated-permission-replies",
)
export function automatedReplies(): Set<string> {
  const holder = globalThis as Record<symbol, unknown>
  const current = holder[AUTOMATED_REPLIES]
  const legacy = holder[LEGACY_AUTOMATED_REPLIES]
  if (current instanceof Set) {
    if (legacy instanceof Set && legacy !== current) {
      for (const requestID of legacy) {
        if (typeof requestID === "string") current.add(requestID)
      }
    }
    holder[LEGACY_AUTOMATED_REPLIES] = current
    return current as Set<string>
  }
  if (legacy instanceof Set) {
    holder[AUTOMATED_REPLIES] = legacy
    return legacy as Set<string>
  }
  const created = new Set<string>()
  holder[AUTOMATED_REPLIES] = created
  holder[LEGACY_AUTOMATED_REPLIES] = created
  return created
}

/**
 * "Warn once per distinct cause, and say so when it clears."
 *
 * A plugin that checks the same thing on every permission prompt (a settings
 * file it cannot read, a store it cannot key) would otherwise nag on every
 * single one. Latching the warning per cause fixes that but creates the
 * opposite problem: the last thing the user was told is still "persistence is
 * paused" long after the cause cleared, because most of these causes clear on
 * their own — a host that had not finished starting answers the next probe.
 * So `resolve` reports the recovery, and only when a warning was actually
 * outstanding, which keeps a healthy path silent.
 *
 * Both methods return whether they had an effect, so the caller decides how
 * to surface it (log line, toast, both). The key set is bounded like every
 * other per-request map in the suite.
 */
export type WarnOnceLatch = {
  /** True when this cause was not already outstanding — i.e. warn now. */
  warn: (key: string) => boolean
  /** True when a warning for this cause was outstanding — i.e. report recovery. */
  resolve: (key: string) => boolean
  /** True while any cause is outstanding. */
  outstanding: () => boolean
}

export function createWarnOnceLatch(
  options: { max?: number } = {},
): WarnOnceLatch {
  const warned = new Set<string>()
  return {
    warn: (key) => {
      if (warned.has(key)) return false
      warned.add(key)
      trim(warned, options.max)
      return true
    },
    resolve: (key) => warned.delete(key),
    outstanding: () => warned.size > 0,
  }
}

// ---------------------------------------------------------------------------
// Session prompt identity
//
// The host's createUserMessage (1.17-1.18 session/prompt.ts) resolves the agent
// for an injected prompt as `input.agent ?? DEFAULT agent` — not the target
// session's own — recomputes the variant from `input.variant ?? agent config`
// (never the session's pinned variant), and then re-pins the session via
// setAgentModel when anything differs. Every prompt a plugin injects into an
// existing session (notifications, scheduled prompts, steers) must therefore
// echo that session's current agent/model/variant back, or it silently
// re-pins the session onto the default agent and strips its variant.
// ---------------------------------------------------------------------------

export type PromptIdentity = {
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
}

/** Extract what a prompt must echo back from a raw GET /session/:id payload. */
export function sessionPromptIdentity(info: unknown): PromptIdentity {
  const session = (info ?? {}) as {
    agent?: unknown
    model?: { providerID?: unknown; id?: unknown; variant?: unknown }
  }
  const identity: PromptIdentity = {}
  if (typeof session.agent === "string" && session.agent)
    identity.agent = session.agent
  const model = session.model
  if (
    typeof model?.providerID === "string" &&
    model.providerID &&
    typeof model.id === "string" &&
    model.id
  ) {
    identity.model = { providerID: model.providerID, modelID: model.id }
    // "default" is the host's marker for "no variant pinned".
    if (
      typeof model.variant === "string" &&
      model.variant &&
      model.variant !== "default"
    )
      identity.variant = model.variant
  }
  return identity
}

/**
 * The identity fields spread into a prompt body, omitting the ones the session
 * has not pinned. Every injected prompt in the suite builds the same three
 * conditional spreads; separating them from sessionPromptIdentity is what let
 * one caller re-derive the identity inline instead — including its own
 * `variant !== "default"` check, the drift these two helpers exist to prevent.
 *
 * Spread into the body next to `parts`; the shape is the same on the v1 and v2
 * prompt routes, which differ in where the body sits, not in these fields.
 */
export function promptIdentityBody(identity: PromptIdentity): {
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
} {
  return {
    ...(identity.agent ? { agent: identity.agent } : {}),
    ...(identity.model ? { model: identity.model } : {}),
    ...(identity.variant ? { variant: identity.variant } : {}),
  }
}

/**
 * An `experimental.session.compacting` handler that pushes one note onto the
 * compaction prompt. Both context-rewriting plugins had the identical body;
 * the NOTE ITSELF stays plugin-owned — what each asks the summarizer to carry
 * forward is the plugin's own contract with its own state, and merging those
 * strings would be merging two unrelated policies.
 */
export function compactionNote(
  text: string,
): (input: unknown, output: { context: string[] }) => Promise<void> {
  return async (_input, output) => {
    output.context.push(text)
  }
}

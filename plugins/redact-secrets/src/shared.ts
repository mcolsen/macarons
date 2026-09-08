import { createHash, createHmac } from "node:crypto"
import { authEntry } from "@macarons/permission-rules"
import {
  decodePayloadBytes,
  isOpaqueBinaryPayload,
  parseDataUrl,
  percentDecodeTolerant,
} from "./dataurl"
import type { ScanOptions } from "./engine/scanner"
import { keywordsIn, scanContent, stringHasKeyword } from "./engine/scanner"
import type { Finding } from "./engine/types"

/**
 * @macarons/redact-secrets — pure core.
 *
 * Everything here is deterministic and IO-free so it can be unit-tested
 * directly: the placeholder grammar, the secret vault, string/deep redaction
 * and restoration, plugin option parsing, and the request-body rewrite the
 * wire backstop applies.
 */

// The verified band is centralized in the shared library and rides the repo's
// OpenCode pin (.opencode-version) — the policy comment lives there. The host
// surfaces this package leans on: the experimental chat transform hooks and
// the text.complete write-back.
export {
  openCodeCompatNotice,
  SUPPORTED_OPENCODE_RANGE,
} from "@macarons/permission-rules"

// ---- placeholders -----------------------------------------------------------

/**
 * Placeholder grammar: [REDACTED-SECRET:<rule-id>:<hash>]. The hash is the
 * first 16 hex chars of HMAC-SHA256(installKey, secret), keyed by a random
 * per-installation secret (minted and persisted by index.ts). The keying is
 * deliberate: a bare SHA-256 prefix is an OFFLINE ORACLE. An observer of
 * provider logs could hash guessed low-entropy credentials (e.g. the password
 * in `curl -u root:Summer2026!`) and match the prefix to confirm the
 * original, and the same secret would produce the same placeholder for every
 * user, letting logs be correlated across installations. Under a local-only
 * key neither works: the hash is unreproducible without the key, and two
 * installations never agree.
 *
 * Within one installation the hash is still a pure function of the secret, so
 * the same secret maps to the same placeholder across requests, sessions, and
 * process restarts (cache-stable prompt prefixes, restart self-healing), and
 * REGISTRATION ORDER NEVER MATTERS to it. An earlier design used 8 chars with
 * a fall-back-to-16 collision branch; that awarded the short hash to whichever
 * secret registered first, so a restart that re-learned the vault in a
 * different order could restore an old placeholder to the WRONG secret. At 16
 * chars (64 bits) an accidental collision is out of reach, and a deliberate
 * one only lets an attacker alias two strings they both chose themselves.
 *
 * The rule-id label is NOT a pure function of the secret — several rules can
 * match the same value, and which one fires depends on surrounding context —
 * so it is made canonical instead: the rule that first registers a hash names
 * it forever (Redactor.ruleIdByHash, persisted in the fingerprint catalog and
 * re-adopted on seed). Restoration never depends on the label; PLACEHOLDER_RE
 * keys on the hash alone, so placeholders minted before this stabilization
 * still restore.
 */
export function placeholderFor(ruleId: string, hash: string): string {
  return `[REDACTED-SECRET:${ruleId}:${hash}]`
}

export const PLACEHOLDER_RE =
  /\[REDACTED-SECRET:[a-z0-9][a-z0-9-]*:([a-f0-9]{16})\]/g

export function secretHash(secret: string, key: string): string {
  return createHmac("sha256", key)
    .update(secret, "utf8")
    .digest("hex")
    .slice(0, 16)
}

// The notes below deliberately show a schematic placeholder that does NOT
// match PLACEHOLDER_RE (the hash slot is not hex), so it can never be
// "restored" or collide with a real one.
export const SYSTEM_NOTE = [
  "Some strings in this conversation appear as placeholders of the form",
  "[REDACTED-SECRET:rule-id:xxxxxxxxxxxxxxxx]. Each stands for a secret (API key, token,",
  "credential) that was detected and masked locally before the conversation was",
  "sent to you; the rule-id says what kind of secret it is. Treat placeholders as",
  "opaque constants: when one belongs in a tool call (a command, file content, or",
  "any argument), copy it exactly as written and the real value is substituted",
  "locally before the tool runs. Never guess, alter, or try to reconstruct the",
  "underlying value, and never mention that you know the real value — you don't.",
].join(" ")

/**
 * Injected into the compaction prompt. Summaries stream through the same
 * processor as chat turns, so experimental.text.complete restores placeholders
 * only when a cold scan can re-mask the resulting text. Other shapes stay
 * masked and depend on env recovery after a restart. Carrying every live
 * placeholder forward preserves at least its identity across compaction.
 */
export const COMPACTION_NOTE = [
  "If the conversation contains placeholder tokens of the form",
  "[REDACTED-SECRET:rule-id:xxxxxxxxxxxxxxxx], reproduce every distinct one verbatim",
  "somewhere in the summary (Key Facts is a good place), including ones that",
  "only appear inside tool calls or tool output. They stand in for locally",
  "masked credentials, and any placeholder missing from the summary becomes",
  "unusable for the rest of the session.",
].join(" ")

/** Project-level files the fingerprint recovery scan is willing to read. */
export const ENV_FILE_CANDIDATES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".envrc",
] as const

/** Recovery scans skip absurdly large env files rather than stall a tool call. */
export const MAX_RECOVERY_FILE_BYTES = 1024 * 1024

// ---- deep-walk key policy -----------------------------------------------------

/**
 * Structural fields of a message part: identifiers, discriminators, and
 * content-addressed references whose values never carry file or command
 * content (every name is a part-level field in schema/src/v1/session.ts).
 * The skip is path-aware — it applies only to the direct fields of a part
 * (and of the FilePart attachments nested under a tool part's state). The
 * same names inside tool input/output/metadata are data and are scanned in
 * full: a tool input's `url` happily carries `?token=...` query strings.
 *
 * `url` is intentionally NOT in this set. A part-level `url` is the attachment
 * payload, which the host forwards to the provider verbatim
 * (message-v2.ts:221) — and OpenCode accepts arbitrary remote urls, so a
 * REMOTE http(s) `url` with `?token=...` is a readable secret bound for the
 * wire (and the OAuth/fetch-owning providers the wire backstop must skip have
 * no other guard over it). Only genuinely opaque CONTENT is left alone: a
 * `file:` path the host resolves before any request leaves the machine, and the
 * base64 PAYLOAD of a `data:` url whose declared binary mediatype is CONFIRMED
 * by the payload's own magic bytes (a real image or audio/video clip) — bytes a
 * scan cannot read as text. The declaration alone is never trusted: textual
 * bytes wearing an `image/png` label are scanned like any other text (see
 * BINARY_MAGIC). A `data:application/pdf` payload is not skipped either —
 * providers extract a PDF's text, so it is decoded and scanned like any other
 * textual attachment.
 * A `data:` url's METADATA is always scanned even when its payload is skipped: a
 * crafted `;token=...` mediatype parameter is masked defensively — the host's AI
 * SDK reduces a data-url mediatype to its bare type (dropping `;params`) before
 * the wire, so this is defense in depth, not a demonstrated leak, but the plugin
 * does not rely on provider/SDK internals and keeps parity with the scanned
 * `mime` field. Everything else the provider can read is scanned
 * — a REMOTE url (percent-decoded per component), a PLAINTEXT `data:` payload
 * (percent-decoded first), and the base64 PAYLOAD of any `data:` url that is
 * not magic-confirmed binary (scanned byte-preservingly — content
 * classification can narrow the skip but never exempt a scan, so neither a
 * leading NUL nor a binary-looking label can hide a credential — since
 * OpenCode base64-encodes any non-`text/plain` attachment — application/json,
 * or a non-UTF-8 SQL/CSV dump — prompt.ts:962, and the provider decodes it
 * back to readable text). That scheme- and mediatype-aware call lives in the
 * redactor (redactPartUrl), not in this all-or-nothing set.
 *
 * `mime` is also NOT in this set. FilePart.mime is an unrestricted
 * `Schema.String` (schema/src/v1/session.ts) the host forwards to the provider
 * verbatim as `mediaType` (message-v2.ts:222). A crafted value —
 * `text/plain; token=ghp_...`, or a mimeType handed back by an untrusted MCP
 * server (session/tools.ts:433) — is a readable secret on the wire that the
 * backstop covers only on wrapped providers, so it is scanned like any other
 * string. A legitimate mediatype (`image/png`, `application/json`) matches no
 * rule and passes through untouched.
 */
export const PART_STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "id",
  "sessionID",
  "messageID",
  "type",
  "callID",
  "tool",
  "snapshot",
  "hash",
])

export { isOpaqueBinaryPayload, percentDecodeTolerant } from "./dataurl"

// ---- options ------------------------------------------------------------------

export type RedactOptions = {
  /** Rule ids to skip during scanning. */
  readonly disabledRules: ReadonlySet<string>
  /** Append the placeholder explanation to the system prompt. Default true. */
  readonly systemNote: boolean
  /**
   * Restore restart-safe placeholders in completed assistant text parts.
   * Default true.
   * Disabling keeps placeholders in ALL stored assistant text — compaction
   * summaries included, since they stream through the same hook. That is the
   * point of the option (no raw value is ever written back into the stored
   * transcript), but it carries a documented cost: once compaction drops the
   * transcript's raw copies and the process restarts, a placeholder can only
   * be resolved by fingerprint recovery (shell env + project env files); a
   * secret absent from those reaches its tool call as a literal placeholder.
   * index.ts warns at startup when this is off.
   */
  readonly restoreText: boolean
  /**
   * Never re-redact an outbound surface this session already sent (HistoryPins).
   * Default true. Turning it off restores retroactive redaction — a secret
   * first recognized at turn N is masked in the replayed turns 1..N-1 too — at
   * the cost of resetting the provider's prompt cache on the request that
   * learns it, and on every later request that learns another.
   */
  readonly stableHistory: boolean
  /** Install the wire-level fetch backstop on safely wrappable providers. Default true. */
  readonly wireBackstop: boolean
  /** Provider ids the wire backstop must leave alone, in addition to built-in exclusions. */
  readonly wireSkipProviders: ReadonlySet<string>
}

export const DEFAULT_OPTIONS: RedactOptions = {
  disabledRules: new Set(),
  systemNote: true,
  restoreText: true,
  stableHistory: true,
  wireBackstop: true,
  wireSkipProviders: new Set(),
}

export function parseOptions(raw: unknown): RedactOptions {
  if (!raw || typeof raw !== "object") return DEFAULT_OPTIONS
  const record = raw as Record<string, unknown>
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : []
  return {
    disabledRules: new Set(strings(record.disabledRules)),
    systemNote: record.systemNote !== false,
    restoreText: record.restoreText !== false,
    stableHistory: record.stableHistory !== false,
    wireBackstop: record.wireBackstop !== false,
    wireSkipProviders: new Set(strings(record.wireSkipProviders)),
  }
}

/**
 * Mirrors the host's runtime-flag parsing (Effect Config.Boolean, verified in
 * effect 4.0.0-beta.83): exactly "true" | "yes" | "on" | "1" | "y" enable a
 * flag. Anything else reads as disabled — other casings or junk values are a
 * host startup error, so they never reach a running plugin anyway.
 */
export function runtimeFlagEnabled(value: unknown): boolean {
  return (
    value === "true" ||
    value === "yes" ||
    value === "on" ||
    value === "1" ||
    value === "y"
  )
}

/** Whether the auth store holds an entry (of any type) for `providerID`. */
export function hasAuthEntry(authJson: unknown, providerID: string): boolean {
  return authEntry(authJson, providerID) !== undefined
}

// The host's `Auth.Info` decode — the filter this plugin applies to the
// auth.json FILE path, and never to the inline override — was the one piece of
// the suite's three auth readers this plugin owned outright (audit §2.3). It
// lives in the library now, next to the reader that applies it; re-exported so
// the wire-backstop policy below keeps reading as one module.
export {
  type AuthType,
  validAuthType,
  validatedAuthStore,
} from "@macarons/permission-rules"

/**
 * Provider ids the wire backstop must never wrap, because the host installs
 * its own `options.fetch` for them at provider-assembly time — AFTER the
 * plugin config hook ran — and the final config re-apply
 * (provider.ts:1571-1577) would clobber it with ours:
 *
 *   - github-copilot: OAuth auth-plugin loader installs a token fetch.
 *   - google-vertex: the custom loader installs an ADC-token fetch whenever
 *     a GCP project is resolvable (provider.ts:530-541); losing it strips
 *     Authorization from every Vertex request.
 *   - snowflake-cortex: the custom loader installs a request/response
 *     transformation fetch for env/config/api-key tokens
 *     (provider.ts:902-955).
 */
export const FETCH_OWNING_PROVIDERS: ReadonlySet<string> = new Set([
  "github-copilot",
  "google-vertex",
  "snowflake-cortex",
])

/**
 * Provider ids whose auth entry means another fetch is (or may be) installed
 * by an internal auth-plugin loader; overwriting it via config options would
 * break their authentication, so the wire backstop must skip them. The
 * OAuth rule is generic on purpose: every internal loader that installs a
 * fetch does so for oauth-type auth (verified across plugin/*.ts at
 * 1.17.18), and a third-party auth plugin is most likely to follow the same
 * shape.
 */
export function unsafeWireProviders(authJson: unknown): Set<string> {
  const unsafe = new Set<string>(FETCH_OWNING_PROVIDERS)
  if (authJson && typeof authJson === "object") {
    for (const [providerID, entry] of Object.entries(
      authJson as Record<string, unknown>,
    )) {
      const type =
        entry && typeof entry === "object"
          ? (entry as { type?: unknown }).type
          : undefined
      if (type === "oauth") unsafe.add(providerID)
    }
  }
  return unsafe
}

/**
 * Provider ids that are provably active on the host WITHOUT an entry in
 * config.provider, derived exactly the way the host activates them
 * (provider.ts:1506-1530): a models.dev catalog provider whose env key is
 * set ("load env"), or one holding an api-key auth entry ("load apikeys").
 * These are the providers the wire backstop must create a config entry for —
 * their requests (title generation above all) otherwise leave with no fetch
 * wrapper at all. Catalog membership is required on both paths: the host
 * ignores env keys and api auth for unknown providers, and a config entry
 * for an unknown id would conjure a phantom selector entry.
 *
 * `catalogJson` is the parsed models.dev snapshot (Record<id, {env: [...]}>).
 * Only `type: "api"` auth entries count: `oauth` activates through plugin
 * auth loaders (never safe to wrap anyway) and `wellknown` activates nothing.
 */
export function catalogWireCandidates(
  catalogJson: unknown,
  env: Record<string, string | undefined>,
  authJson: unknown,
): Set<string> {
  const candidates = new Set<string>()
  if (!catalogJson || typeof catalogJson !== "object") return candidates
  const catalog = catalogJson as Record<string, unknown>
  for (const [providerID, entry] of Object.entries(catalog)) {
    if (!entry || typeof entry !== "object") continue
    const envKeys = (entry as { env?: unknown }).env
    if (!Array.isArray(envKeys)) continue
    if (envKeys.some((key) => typeof key === "string" && env[key]))
      candidates.add(providerID)
  }
  if (authJson && typeof authJson === "object") {
    for (const [providerID, entry] of Object.entries(
      authJson as Record<string, unknown>,
    )) {
      const type =
        entry && typeof entry === "object"
          ? (entry as { type?: unknown }).type
          : undefined
      if (type === "api" && providerID in catalog) candidates.add(providerID)
    }
  }
  return candidates
}

// ---- the redactor ---------------------------------------------------------------

type CacheEntry = {
  readonly output: string
  readonly pairs: ReadonlyArray<readonly [string, string, string]>
}

const CACHE_MIN_LENGTH = 256
const CACHE_MAX_BYTES = 8 * 1024 * 1024

/**
 * A non-reversible record of one vault secret, safe to persist: the 16-hex
 * keyed fingerprint (the same value already embedded in every placeholder
 * this install sends to providers), the canonical rule id that labels the
 * placeholder, and the secret's length in UTF-16 units. Persisting these (and
 * nothing else) is what makes restored-but-contextless secrets restart-safe:
 * after a restart the vault is empty, and a raw secret that text.complete
 * wrote back into stored prose as a bare token ("- x7k2…") carries none of
 * the field context its detection rule needs — rule re-scanning, the
 * pre-restart self-heal, cannot see it. The fingerprint lets the scanner
 * re-identify the EXACT value (recoverFingerprints) without any reversible
 * secret material ever touching disk: the hash is useless without the
 * install key, and length + rule id are the only metadata disclosed.
 */
export type FingerprintEntry = {
  readonly hash: string
  readonly ruleId: string
  readonly length: number
}

const FINGERPRINT_HASH_RE = /^[a-f0-9]{16}$/
const FINGERPRINT_RULE_RE = /^[a-z0-9][a-z0-9-]*$/
const FINGERPRINT_MAX_LENGTH = 1_000_000
const FINGERPRINT_MIN_LENGTH = 4

/**
 * Strict shape check for a persisted fingerprint. Used both when seeding a
 * Redactor and when the host half reads/merges the on-disk catalog, so junk
 * in a corrupted file is dropped everywhere instead of being copied forward.
 */
export function validFingerprintEntry(
  entry: unknown,
): entry is FingerprintEntry {
  if (!entry || typeof entry !== "object") return false
  const e = entry as Record<string, unknown>
  return (
    typeof e.hash === "string" &&
    FINGERPRINT_HASH_RE.test(e.hash) &&
    typeof e.ruleId === "string" &&
    e.ruleId.length <= 128 &&
    FINGERPRINT_RULE_RE.test(e.ruleId) &&
    typeof e.length === "number" &&
    Number.isInteger(e.length) &&
    e.length >= FINGERPRINT_MIN_LENGTH &&
    e.length <= FINGERPRINT_MAX_LENGTH
  )
}

/** Parse a placeholder back into its rule id (placeholderFor's inverse). */
const PLACEHOLDER_PARTS_RE =
  /^\[REDACTED-SECRET:([a-z0-9][a-z0-9-]*):[a-f0-9]{16}\]$/

/**
 * Findings synthesized from the vault (exact substring occurrences of known
 * secrets) outrank every rule finding on span ties: the vault entry IS the
 * secret, no rule heuristics involved. Rule specificities are small integers
 * (upstream default 100).
 */
const VAULT_SPECIFICITY = 1_000_000

/**
 * The characters a single-token secret can be made of, across the vendored
 * corpus: base64/base64url, hex, dotted prefixes (`pat….…`), `~` (authress),
 * `|` (facebook's digits|token shape). Keep these boundaries even when adding
 * credential characters below: a colon-adjacent label must not swallow a
 * previously recoverable token into a longer run.
 */
const SECRET_RUN_RE = /[A-Za-z0-9+/=_.~|-]{4,}/g

/** Also recover unquoted curl user:pass pairs and header tokens containing @. */
const CREDENTIAL_RUN_RE = /[A-Za-z0-9+/=_.~|:@${}-]{4,}/g

/**
 * A run may glom trailing punctuation onto a secret ("…x7k2." at sentence
 * end) or a short neighbor; windows of the fingerprint's exact length are
 * tested only when the entire run exceeds that length by at most this much.
 * Small on purpose: it covers punctuation glue without sliding over long runs.
 */
const FINGERPRINT_RUN_SLACK = 4

/** Hard cap on HMAC candidates tested per scanned string (DoS bound). */
export const FINGERPRINT_MAX_CANDIDATES = 10_000

/** A recovery scan exhausted its budget; callers must fail closed. */
export class FingerprintLimitError extends Error {
  constructor() {
    super(
      `fingerprint recovery exceeded ${FINGERPRINT_MAX_CANDIDATES} distinct candidate strings in one scanned string; ` +
        "reduce or stop replaying the candidate-heavy content (start a new session if it is in history). " +
        "Do not clear redact-secrets.fingerprints.json unless necessary: doing so can leave contextless secrets " +
        "in stored transcripts unrecognized after restart; see the plugin README for recovery",
    )
    this.name = "FingerprintLimitError"
  }
}

/**
 * Hard ceilings for the deep walkers (redactWalk, redactPart/redactToolState,
 * and the restore/inspect walk). Real payloads — message parts, tool schemas,
 * parsed request bodies — nest a few dozen levels and hold well under a
 * million nodes; these sit orders of magnitude above that, so tripping one
 * means the structure is pathological: adversarially deep nesting, a cycle
 * (each lap deepens the walk, so the depth ceiling catches it without any
 * cycle bookkeeping), or a shared-node DAG whose path count explodes (caught
 * by the visit budget). The budget charges EVERY traversed child — recursive
 * descent, and equally the string leaves and property names the walkers scan
 * inline — so a structure wide in strings, the costliest leaf type, is
 * bounded exactly like one wide in anything else. On a trip the walkers
 * THROW rather than skip the
 * offending branch — a skipped branch is a fail-open path for whatever secret
 * it holds; an aborted request is closed. There is deliberately NO visited
 * set: a node shared under two parents must be rescanned under each parent's
 * key context, because context decides which keyword-gated rules fire.
 */
export const MAX_WALK_DEPTH = 1000
export const MAX_WALK_VISITS = 10_000_000

/** A walker hit MAX_WALK_DEPTH or MAX_WALK_VISITS; the caller must abort. */
export class WalkLimitError extends Error {
  constructor(kind: "depth" | "nodes") {
    // Never quote the structure here — it could hold the very secret the
    // walk was masking.
    super(
      kind === "depth"
        ? `refusing to walk a structure nested deeper than ${MAX_WALK_DEPTH} levels (pathological nesting or a cycle)`
        : `refusing to walk a structure with more than ${MAX_WALK_VISITS} nodes (string leaves and property names count)`,
    )
    this.name = "WalkLimitError"
  }
}

/**
 * Node-visit budget shared across one walk entry call (all passes included);
 * depth travels as a plain per-path parameter beside it.
 */
type WalkGuard = { visits: number }

/**
 * How many content digests noteScanContextCached remembers (audit M7). Each
 * entry is one already-swept request surface — a serialized message, the
 * joined system prompt, one tool definition — so the working set is the
 * transcript sizes of the live sessions, and this sits far above any real one.
 * Eviction is SAFE here, unlike the vault maps: a forgotten digest only means
 * that content pays one redundant keyword sweep on its next appearance — work,
 * never coverage (the sweep is idempotent and the keyword set never shrinks).
 */
export const NOTED_CONTEXT_LIMIT = 16_384

/**
 * Lowercased field names whose value is provider-issued OPAQUE protocol state —
 * ciphertext the provider encrypted, a signature over it, or an item id the
 * provider minted — never text a human or a tool wrote. Matched
 * case-insensitively against the raw key.
 *
 * Matched by NAME under any namespace rather than as exact
 * `<provider>.<field>` pairs. Provider namespaces are an open set (every
 * openai-compatible and custom provider mints its own), and the two failure
 * directions are not symmetric: skipping a field a provider did not mint
 * leaves at most an unscanned blob that the value's own shape says is
 * ciphertext, while scanning one it DID mint substitutes a placeholder into
 * live protocol state and breaks the request. The names here are specific
 * enough that ordinary prose does not land under them by accident, and the
 * skip applies only one level under `part.metadata` (redactPartMetadata) —
 * the same field names anywhere else are ordinary content and still redacted.
 *
 * Every entry is a field OpenCode 1.18.5 itself persists into `part.metadata`
 * and replays as `providerOptions` (message-v2.ts:283,374 →
 * provider/transform.ts). Verified against the pinned checkout:
 *   - openai: `reasoningEncryptedContent`, `itemId`
 *   - anthropic / bedrock: `signature`, `redactedData` (transform.ts:180-212)
 *   - copilot: `reasoningOpaque`
 *     (github-copilot/chat/convert-to-openai-compatible-chat-messages.ts:83-121)
 *   - google: `thoughtSignature`
 * Adding a provider without adding its opaque fields here makes that
 * provider's continuation state mutable — check the host's converters when
 * bumping the OpenCode pin.
 */
export const OPAQUE_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  "reasoningencryptedcontent",
  "encryptedcontent",
  "encrypted_content",
  "reasoningopaque",
  "reasoning_opaque",
  "thoughtsignature",
  "thought_signature",
  "redactedreasoning",
  "redacted_reasoning",
  "redacteddata",
  "redacted_data",
  "signature",
  "itemid",
  "item_id",
])

/**
 * The `part.metadata.<providerNamespace>` records reachable from one message —
 * the objects whose own string fields are provider protocol state. Collected by
 * identity so serializeForKeywordSweep can drop OPAQUE_PROVIDER_KEYS at exactly
 * the path redactPartMetadata skips them at, and nowhere else.
 *
 * Deliberately the same shape test redactPart applies: a top-level `metadata`
 * object on a member of `parts`, one level down. `state.metadata` (tool output)
 * is NOT provider state and is not collected.
 */
function providerMetadataRecords(value: unknown): Set<object> {
  const records = new Set<object>()
  const parts = Array.isArray(value)
    ? value
    : ((value as { parts?: unknown } | null)?.parts ?? undefined)
  if (!Array.isArray(parts)) return records
  for (const part of parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue
    const metadata = (part as Record<string, unknown>).metadata
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      continue
    for (const state of Object.values(metadata as Record<string, unknown>)) {
      if (state && typeof state === "object" && !Array.isArray(state))
        records.add(state)
    }
  }
  return records
}

/**
 * Serialize a request surface for the KEYWORD SWEEP (Redactor.noteScanContext),
 * dropping the OPAQUE_PROVIDER_KEYS values found at
 * `parts[].metadata.<provider>.<key>`.
 *
 * Only the sweep — the decision about which RULES are eligible to run — uses
 * this. Redaction still walks the whole surface, so nothing stops being
 * scanned; what stops is a random base64 blob being allowed to TURN ON a rule
 * for every other string in the request. Those blobs are ciphertext over a
 * ~64-character alphabet, so they contain short gate keywords by coincidence
 * (`sgp_`, `ghp_`, `aws`) at a rate that scales with transcript size, and the
 * keyword set is sticky and process-wide: one coincidence permanently widens
 * the candidate rules for every session in the process. That is not a
 * theoretical concern — see keywordPresent for the 2026-07-25 incident this
 * pairs with. Dropping them loses no real signal either, since ciphertext
 * cannot contain the plaintext credential its keyword would gate.
 *
 * Scoped by PATH, not by field name alone. `signature`, `itemId` and the rest
 * are ordinary application field names outside provider metadata — a tool
 * input `{ signature: "facebook token follows" }` is real keyword context, and
 * dropping it would silently cost the sibling strings of that request their
 * gate. The path test keeps the incident's `reasoningEncryptedContent` out of
 * the sweep while leaving every field a tool or a human wrote in it.
 *
 * Returns undefined when the value will not serialize, so callers fall back to
 * sweeping what they can rather than silently skipping the surface.
 */
export function serializeForKeywordSweep(value: unknown): string | undefined {
  const opaque = providerMetadataRecords(value)
  try {
    // A `function` expression, not an arrow: JSON.stringify binds the holder
    // of `key` as `this`, which is what makes the path test possible at all.
    return JSON.stringify(value, function (this: unknown, key, inner) {
      return typeof inner === "string" &&
        OPAQUE_PROVIDER_KEYS.has(key.toLowerCase()) &&
        typeof this === "object" &&
        this !== null &&
        opaque.has(this)
        ? undefined
        : inner
    })
  } catch {
    return undefined
  }
}

/** Pinned redaction of one already-sent request surface (see HistoryPins). */
export type Pin = { readonly output: string; readonly count: number }

/** A pin plus the delivery state that decides whether it may be trusted. */
type PinEntry = { readonly pin: Pin; delivered: boolean }

/** Surfaces pinned per session, and sessions kept, before LRU eviction. */
export const PINS_PER_SCOPE = 2_048
export const PIN_SCOPES = 64

/**
 * Aggregate ceiling, in UTF-16 units, on the redacted snapshots pinning
 * retains (audit: count limits alone are byte-unbounded).
 *
 * The count limits permit 2,048 surfaces in each of 64 sessions, and a single
 * surface can be a multi-megabyte tool output or a data URL, so a
 * count-only bound admits hundreds of megabytes of retained history. 32 MiB
 * holds a realistic working set — a long session's replayed parts run to a
 * few MiB — and evicting past it costs the evicted surface only its
 * stability, never its coverage.
 */
export const PIN_BYTE_BUDGET = 32 * 1024 * 1024

/** SHA-256, base64 — the lookup key pins are stored under. */
function pinDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64")
}

/**
 * Per-session record of how an outbound surface was ALREADY redacted, so a
 * surface that reached the provider once is never rewritten afterwards.
 *
 * The problem it solves: redaction is a moving target. The rule gate is sticky
 * and grows as content arrives, and every newly vaulted secret is swept for by
 * exact match across the WHOLE transcript — so a secret first recognized at
 * turn N rewrites its occurrences in turns 1..N-1, which the host replays
 * verbatim every request. To a provider's prefix cache that is a changed
 * prompt: the 2026-07-25 incident reset five sessions at once, and even a
 * correct detection does the same thing, just deservedly.
 *
 * Pinning trades the retroactive half away. Content is redacted under the full
 * current rule set the FIRST time it is seen — new turns, edited parts, and
 * compaction-replaced history all miss the pin and get today's behavior — but
 * a byte-identical replay of something already sent returns the decision that
 * was already made. That cannot create exposure the pin prevented: the pinned
 * bytes are exactly what this process already put on the wire for this scope,
 * so re-sending them reveals nothing that destination was not already given.
 * What it does give up is the late catch-up — a secret learned at turn N stays
 * unmasked in the replayed turns 1..N-1 for the rest of the session.
 *
 * Three properties make the "already sent" premise true rather than assumed:
 *
 *   - SCOPE is session AND destination. The caller folds the provider/model a
 *     request is bound for into the key, so a session that switches models, or
 *     whose history is routed to a separately configured compaction model,
 *     cannot inherit the exposure decision made for a different provider —
 *     the case that would otherwise turn "these bytes already went there" into
 *     a first disclosure (audit F2).
 *   - DELIVERY is observed, not assumed. A pin is created undelivered and is
 *     invisible to `get` until `markDelivered` is called for its session on
 *     evidence the provider answered. The transforms run before request
 *     construction and transport, so a pin committed there would otherwise
 *     treat an aborted attempt's decision as sent — and on retry suppress a
 *     detection that had become available in between (audit F6).
 *   - Keys are DIGESTS. The pre-redaction serialization is hashed rather than
 *     retained, and the retained post-redaction snapshots are held under an
 *     aggregate byte budget as well as the count limits (audit F8).
 *
 * Both maps are insertion-ordered LRU (re-touched on read). Eviction only costs
 * the evicted surface its stability — it is re-redacted, under rules that can
 * only be wider — never its coverage.
 *
 * Process-local by design: pins are never persisted. Their value is a snapshot
 * of exactly the bytes a provider was sent, secrets included, and writing that
 * to disk would be a worse trade than the restart-window it closes. Stability
 * therefore lasts one OpenCode process; see the README known gaps.
 */
export class HistoryPins {
  private readonly scopes = new Map<string, Map<string, PinEntry>>()
  private bytes = 0

  constructor(
    private readonly perScope: number = PINS_PER_SCOPE,
    private readonly maxScopes: number = PIN_SCOPES,
    private readonly byteBudget: number = PIN_BYTE_BUDGET,
  ) {}

  /**
   * The pinned decision for `key` in `scope`, or undefined when there is none
   * or the request that made it was never observed to reach the provider.
   */
  get(scope: string, key: string): Pin | undefined {
    const pins = this.scopes.get(scope)
    if (!pins) return undefined
    const digest = pinDigest(key)
    const entry = pins.get(digest)
    if (!entry?.delivered) return undefined
    this.scopes.delete(scope)
    this.scopes.set(scope, pins)
    pins.delete(digest)
    pins.set(digest, entry)
    return entry.pin
  }

  /** Record a decision, undelivered until markDelivered says otherwise. */
  set(scope: string, key: string, pin: Pin): void {
    const digest = pinDigest(key)
    let pins = this.scopes.get(scope)
    if (pins) this.scopes.delete(scope)
    else pins = new Map()
    this.scopes.set(scope, pins)
    this.drop(pins, digest)
    pins.set(digest, { pin, delivered: false })
    this.bytes += this.cost(digest, pin)
    this.evict(pins)
  }

  /**
   * Promote every pin this scope holds to delivered. Called on evidence that
   * the provider answered a request for this session — the latest point this
   * plugin can observe, and the only one that distinguishes a sent request
   * from an aborted one.
   */
  markDelivered(scope: string): void {
    const pins = this.scopes.get(scope)
    if (!pins) return
    for (const entry of pins.values()) entry.delivered = true
  }

  /** Release a scope outright — its session was deleted. */
  forget(scope: string): void {
    const pins = this.scopes.get(scope)
    if (!pins) return
    for (const [digest, entry] of pins)
      this.bytes -= this.cost(digest, entry.pin)
    this.scopes.delete(scope)
  }

  private cost(digest: string, pin: Pin): number {
    return digest.length + pin.output.length
  }

  private drop(pins: Map<string, PinEntry>, digest: string): void {
    const existing = pins.get(digest)
    if (!existing) return
    this.bytes -= this.cost(digest, existing.pin)
    pins.delete(digest)
  }

  /**
   * Trim to the per-scope count, the scope count, and the byte budget, in that
   * order. Only `touched` can have exceeded the per-scope count, so the other
   * scopes are left alone until the byte budget reaches them.
   *
   * The byte pass runs least-recently-used scope first, oldest surface within
   * it first, and removes a scope the pass empties so it cannot hold a slot.
   * Insertion order in both maps IS recency order: `get` and `set` re-insert.
   */
  private evict(touched: Map<string, PinEntry>): void {
    for (const oldest of touched.keys()) {
      if (touched.size <= this.perScope) break
      this.drop(touched, oldest)
    }
    for (const oldest of this.scopes.keys()) {
      if (this.scopes.size <= this.maxScopes) break
      this.forget(oldest)
    }
    for (const [scope, pins] of this.scopes) {
      if (this.bytes <= this.byteBudget) break
      for (const oldest of pins.keys()) {
        if (this.bytes <= this.byteBudget) break
        this.drop(pins, oldest)
      }
      if (pins.size === 0) this.scopes.delete(scope)
    }
  }

  /** Distinct sessions currently holding pins (tests, diagnostics). */
  get scopeCount(): number {
    return this.scopes.size
  }

  /** Retained snapshot bytes, in UTF-16 units (tests, diagnostics). */
  get byteCount(): number {
    return this.bytes
  }
}

/**
 * Ceiling on DISTINCT secrets one process will vault (audit L-RS1). The vault
 * maps (byHash/bySecret/ruleIdByHash) deliberately never evict: every entry
 * backs a live guarantee — stable placeholder text (prompt-cache stability),
 * exact-match re-redaction of restored prose, and restoration of any
 * placeholder still reachable through history or a summary — and none of
 * those can be proven dead while the session that minted them can still echo
 * the placeholder back. So the bound is a fail-closed cap in the
 * WalkLimitError mold, not an LRU: real sessions vault at most a few hundred
 * distinct secrets (the persisted fingerprint catalog caps at 2048), so
 * reaching five figures means adversarial or runaway content, and the right
 * response is to abort that request — never to evict a mapping a later
 * restore may need, and never to pass the excess secret through raw.
 *
 * A COUNT alone does not bound memory, which is what the cap is really for:
 * several rules match unbounded spans (private-key most of all — a PEM body
 * has no length ceiling), so ten thousand entries could retain gigabytes.
 * MAX_VAULT_CHARS bounds the aggregate below; both are checked before any
 * vault map is mutated.
 */
export const MAX_VAULT_SECRETS = 10_000

/**
 * Ceiling on the TOTAL secret text one process will vault (audit review of
 * L-RS1). Counted in string length units — a JS engine retains one or two
 * bytes per unit, so true retention is at most twice this — and counted once
 * per distinct secret, because byHash's value and bySecret's key are the same
 * string instance, not two copies.
 *
 * The number is deliberately far above real use (a 4096-bit PEM is ~3 KB, so
 * this admits thousands of them) and far below anything that threatens the
 * process. It exists for the unbounded-match rules: without it a single
 * multi-megabyte PEM-shaped value counts as ONE entry against
 * MAX_VAULT_SECRETS while retaining unbounded memory for the session's life.
 * Tripping it fails closed exactly like the count cap.
 */
export const MAX_VAULT_CHARS = 8 * 1024 * 1024

/** The vault hit MAX_VAULT_SECRETS or MAX_VAULT_CHARS; the caller must abort. */
export class VaultLimitError extends Error {
  constructor() {
    // Never quote the secret that tripped the cap.
    super(
      `refusing to vault more than ${MAX_VAULT_SECRETS} distinct secrets or ` +
        `${MAX_VAULT_CHARS} characters of secret material (runaway or ` +
        "adversarial content); aborting the request rather than evicting a " +
        "live mapping or forwarding the value unredacted",
    )
    this.name = "VaultLimitError"
  }
}

export class Redactor {
  // The three vault maps below NEVER evict (audit L-RS1 — deliberate): each
  // entry backs stable placeholder text, exact-match re-redaction, and
  // restoration, and no entry can be proven dead while a session can still
  // echo its placeholder. Growth is bounded instead by MAX_VAULT_SECRETS,
  // enforced fail-closed in register().
  /** hash → secret (for restoration). */
  private readonly byHash = new Map<string, string>()
  /** secret → placeholder (for consistent reuse). */
  private readonly bySecret = new Map<string, string>()
  /**
   * hash → canonical rule id. The rule that FIRST registered a hash — in this
   * process or, via seedFingerprints, in any earlier one — labels its
   * placeholder forever. Without this the label depended on detection
   * context: the same 32-char value re-learned after a restart under a
   * different field name minted `discord-client-secret:<hash>` where the old
   * transcript says `datadog-api-key:<hash>` — restore still worked (hash
   * only), but the placeholder text changed, rewriting the prompt prefix and
   * breaking the promised cache stability.
   */
  private readonly ruleIdByHash = new Map<string, string>()
  /** Aggregate length of every distinct secret in the vault (MAX_VAULT_CHARS). */
  private vaultedChars = 0
  /**
   * length → (hash → rule id): persisted fingerprints whose secret this
   * process has not yet seen. recoverFingerprints hunts for these in every
   * scanned string; a hit registers the secret and removes the entry.
   */
  private readonly unresolvedFingerprints = new Map<
    number,
    Map<string, string>
  >()
  /** scanned content → redacted result, insertion-order evicted. */
  private readonly cache = new Map<string, CacheEntry>()
  private cacheBytes = 0
  /** Rule-gate keywords seen anywhere in wire-bound content (noteScanContext). */
  private readonly contextKeywords = new Set<string>()
  /**
   * SHA-256 digests of content already fed through noteScanContext, LRU-touched
   * (oldest-first eviction at NOTED_CONTEXT_LIMIT). See noteScanContextCached.
   */
  private readonly notedDigests = new Set<string>()
  /** Options for every scanContent call; contextKeywords is live by reference. */
  private readonly scanOptions: ScanOptions
  /** Total placeholder substitutions performed over this instance's lifetime. */
  redactionCount = 0

  constructor(
    private readonly options: RedactOptions = DEFAULT_OPTIONS,
    /** Per-installation HMAC key for placeholder fingerprints (see placeholderFor). */
    private readonly hashKey: string,
    /**
     * Fired once per newly registered secret (never on reuse) with its
     * non-reversible fingerprint, so the host half can persist the catalog
     * that seeds the next process (seedFingerprints). Must not throw.
     */
    private readonly onRegister?: (entry: FingerprintEntry) => void,
  ) {
    this.scanOptions = {
      disabledRules: options.disabledRules,
      contextKeywords: this.contextKeywords,
    }
  }

  /**
   * Adopt fingerprints persisted by an earlier process. Malformed entries are
   * dropped (the file is plugin-owned but treated as untrusted input); hashes
   * already resolved in this process keep their in-memory registration. The
   * scan cache is flushed: entries computed before seeding could hold a
   * stale-clean result for content containing a now-recoverable secret.
   */
  seedFingerprints(entries: readonly FingerprintEntry[]): void {
    let seeded = false
    for (const entry of entries) {
      if (!validFingerprintEntry(entry)) continue
      if (!this.ruleIdByHash.has(entry.hash))
        this.ruleIdByHash.set(entry.hash, entry.ruleId)
      if (this.byHash.has(entry.hash)) continue
      let byLength = this.unresolvedFingerprints.get(entry.length)
      if (!byLength) {
        byLength = new Map()
        this.unresolvedFingerprints.set(entry.length, byLength)
      }
      if (!byLength.has(entry.hash))
        byLength.set(entry.hash, this.ruleIdByHash.get(entry.hash) as string)
      seeded = true
    }
    if (seeded) {
      this.cache.clear()
      this.cacheBytes = 0
    }
  }

  /**
   * Record that `content` travels in the same provider request as the strings
   * this redactor scans, so its rule-gate keywords must gate candidate rules
   * in every OTHER string too. The keyword prefilter is a per-document gate,
   * and to the provider the document is the WHOLE request: several rules'
   * keywords are not part of their token pattern at all (facebook-access-token
   * gates on "facebook" but matches a bare digits|token shape), so "facebook
   * token follows" in one message part must gate the rule in the sibling part
   * that holds only the bare token — scanning each part with only its own
   * keywords reproducibly leaked exactly that pair on providers the wire
   * backstop cannot cover. Callers note each request-level surface BEFORE
   * scanning any of its strings (a later part's keyword must cover an earlier
   * part's token).
   *
   * The set only ever grows — session-lifetime, deliberately: message history
   * carries past content into later requests anyway, and a context keyword
   * only widens candidate SELECTION (every rule's regex still has to match
   * the individual string), so persistence can only redact more, never less.
   * Growth invalidates the scan cache: entries were computed under the
   * smaller candidate set, and a stale "clean" result for a string whose rule
   * has only now been gated in would leak on every later cache hit.
   */
  noteScanContext(content: string): void {
    if (typeof content !== "string" || content.length === 0) return
    const found = keywordsIn(content, this.contextKeywords)
    if (found.length === 0) return
    for (const keyword of found) this.contextKeywords.add(keyword)
    this.cache.clear()
    this.cacheBytes = 0
  }

  /**
   * noteScanContext, skipping the keyword sweep when this EXACT content was
   * already swept (audit M7). The full-transcript surfaces re-present the same
   * bytes every request — history messages, the system prompt, tool
   * definitions — and re-sweeping them cost a lowercase pass plus a substring
   * search per never-observed keyword over the whole transcript, every turn.
   * Skipping a repeat is sound because noting is idempotent per content: the
   * same bytes always yield the same keywords, and the sticky set never
   * shrinks, so everything a repeat sweep could add is already in the set —
   * which also means the cache-flush contract is untouched (a skipped sweep
   * can never be the one that grows the set). Keying on a CONTENT digest —
   * never object identity — is what makes change detection exact: the host
   * hydrates fresh part objects every request, and compaction REPLACES
   * history wholesale, so identity carries no signal, while changed bytes
   * (a new message, an edited part, a replaced history) always miss the
   * digest set and get swept like new content. Every uncertain direction
   * degrades to sweeping, never to skipping: an unstable serialization
   * produces a fresh digest (a redundant sweep), and an evicted digest
   * (NOTED_CONTEXT_LIMIT, oldest first, present entries re-touched) is
   * re-swept on its next appearance.
   */
  noteScanContextCached(content: string): void {
    if (typeof content !== "string" || content.length === 0) return
    const digest = createHash("sha256").update(content, "utf8").digest("base64")
    const known = this.notedDigests.delete(digest)
    this.notedDigests.add(digest)
    if (known) return
    this.noteScanContext(content)
    for (const oldest of this.notedDigests) {
      if (this.notedDigests.size <= NOTED_CONTEXT_LIMIT) break
      this.notedDigests.delete(oldest)
    }
  }

  /** Number of distinct secrets currently known. */
  get vaultSize(): number {
    return this.byHash.size
  }

  /** Total length of the distinct secrets currently vaulted (MAX_VAULT_CHARS). */
  get vaultChars(): number {
    return this.vaultedChars
  }

  private register(secret: string, ruleId: string): string {
    const known = this.bySecret.get(secret)
    if (known) return known
    // Capacity is checked only for a NEW secret — reuse above stays valid at
    // either cap, so everything already vaulted keeps redacting and restoring.
    // Tripping this means runaway or adversarial content (see the constants);
    // the throw aborts the enclosing request, which is the only response that
    // neither evicts a mapping a later restore may need nor lets the
    // over-cap secret leave raw. BOTH capacities are reserved here, before any
    // vault map is touched, so a rejected secret leaves no partial entry
    // behind (a half-registered secret would redact without restoring).
    if (this.byHash.size >= MAX_VAULT_SECRETS) throw new VaultLimitError()
    if (this.vaultedChars + secret.length > MAX_VAULT_CHARS)
      throw new VaultLimitError()
    // The full 16-char keyed fingerprint, unconditionally — see placeholderFor
    // for why no shorter hash (and no collision branch) is acceptable, and why
    // it is HMAC-keyed rather than a bare digest. A genuine 64-bit collision
    // would alias two secrets to one placeholder; at that probability it is
    // not worth code, and any handling would reintroduce registration-order
    // sensitivity.
    const hash = secretHash(secret, this.hashKey)
    // The placeholder's rule label is CANONICAL per hash (see ruleIdByHash):
    // whichever rule first registered this secret — ever, via the persisted
    // fingerprint catalog — names it; a later re-detection under a different
    // rule reuses that label so the placeholder string never changes.
    const canonical = this.ruleIdByHash.get(hash) ?? ruleId
    this.ruleIdByHash.set(hash, canonical)
    this.byHash.set(hash, secret)
    this.vaultedChars += secret.length
    const placeholder = placeholderFor(canonical, hash)
    this.bySecret.set(secret, placeholder)
    // Resolved — stop hunting for this fingerprint in scanned content.
    const byLength = this.unresolvedFingerprints.get(secret.length)
    if (byLength?.delete(hash) && byLength.size === 0)
      this.unresolvedFingerprints.delete(secret.length)
    // A cached result computed before this secret existed may contain it BARE
    // (that is exactly the restored-prose leak): a stale-clean hit would send
    // the raw value on every later request. New-secret registration is rare
    // after warm-up, so the flush is cheap where it matters.
    this.cache.clear()
    this.cacheBytes = 0
    try {
      this.onRegister?.({ hash, ruleId: canonical, length: secret.length })
    } catch {
      // Persistence is defense in depth; a failing callback must not break
      // the redaction that is happening right now.
    }
    return placeholder
  }

  /**
   * Exact-substring findings for every vault secret present in `content`.
   * Rule detection alone is NOT enough once a secret is known: placeholders
   * the model echoes into prose are restored into the STORED text
   * (text.complete), and ordinary prose strips the field context a
   * context-gated rule needs — `api_key=x7k2…` was detected, but the restored
   * "- x7k2…" no longer matches anything, and the raw value sailed out on the
   * next request (reproduced review finding). A known vault value is redacted
   * wherever its exact bytes appear, context-free. Spans are deduped against
   * rule findings by applyFindings' overlap drop; a vault span nested inside
   * a longer rule match loses to it (the longer secret owns the text), which
   * replaces strictly more.
   */
  private vaultFindings(content: string): Finding[] {
    if (this.bySecret.size === 0 || content.length === 0) return []
    const findings: Finding[] = []
    for (const [secret, placeholder] of this.bySecret) {
      if (secret.length > content.length) continue
      let at = content.indexOf(secret)
      if (at === -1) continue
      const ruleId =
        PLACEHOLDER_PARTS_RE.exec(placeholder)?.[1] ?? "generic-api-key"
      while (at !== -1) {
        findings.push({
          ruleId,
          secret,
          start: at,
          end: at + secret.length,
          specificity: VAULT_SPECIFICITY,
        })
        at = content.indexOf(secret, at + secret.length)
      }
    }
    return findings
  }

  /**
   * Hunt for persisted-but-unresolved fingerprints in `content` and register
   * any hits, BEFORE the string is scanned. This is the restart half of the
   * exact-match story: after a restart the vault is empty, so a contextless
   * restored secret in stored prose matches no rule and no vault entry — but
   * its keyed fingerprint survives on disk. Candidates come from token and
   * credential runs, allowing FINGERPRINT_RUN_SLACK for glued punctuation.
   * Both passes share one deduplicated HMAC budget; only an exact keyed hash
   * match registers a value. Exhaustion aborts the request, since silently
   * skipping recovery could forward (and cache) a restored credential raw.
   */
  private recoverFingerprints(content: string): void {
    if (
      this.unresolvedFingerprints.size === 0 ||
      content.length < FINGERPRINT_MIN_LENGTH
    )
      return
    const tested = new Set<string>()
    for (const pattern of [SECRET_RUN_RE, CREDENTIAL_RUN_RE]) {
      for (const match of content.matchAll(pattern)) {
        const run = match[0]
        for (const [length, byLength] of this.unresolvedFingerprints) {
          const slack = run.length - length
          if (slack < 0 || slack > FINGERPRINT_RUN_SLACK) continue
          for (let offset = 0; offset <= slack; offset++) {
            const candidate = run.slice(offset, offset + length)
            if (tested.has(candidate)) continue
            if (tested.size >= FINGERPRINT_MAX_CANDIDATES)
              throw new FingerprintLimitError()
            tested.add(candidate)
            const hash = secretHash(candidate, this.hashKey)
            const ruleId = byLength.get(hash)
            if (ruleId) {
              this.register(candidate, ruleId)
              if (this.unresolvedFingerprints.size === 0) return
            }
          }
        }
      }
    }
  }

  /**
   * Replace a finding list within `content`. Findings are sorted
   * earliest-start-first; on ties the longer span, then higher specificity,
   * wins. Contained spans are dropped; partial overlaps are merged so no tail
   * of a known secret can survive beside a placeholder. Registers each kept
   * value (including partial-overlap constituents for the later vault sweep)
   * and bumps redactionCount per replacement. Returns the rewritten string and
   * the (hash, secret, placeholder) triples applied, for the caller's cache.
   */
  private applyFindings(
    content: string,
    findings: readonly Finding[],
  ): { output: string; pairs: Array<readonly [string, string, string]> } {
    const pairs: Array<readonly [string, string, string]> = []
    if (findings.length === 0) return { output: content, pairs }
    const ordered = [...findings].sort(
      (a, b) =>
        a.start - b.start || b.end - a.end || b.specificity - a.specificity,
    )
    const chunks: string[] = []
    let cursor = 0
    for (let i = 0; i < ordered.length; i++) {
      const finding = ordered[i] as Finding
      let end = finding.end
      for (; i + 1 < ordered.length; i++) {
        const next = ordered[i + 1] as Finding
        if (next.start >= end) break
        if (next.end <= end) continue
        // Keep the real constituent mappings, but vault only the final union,
        // not intermediate unions in a chain of overlapping findings.
        if (end === finding.end) this.register(finding.secret, finding.ruleId)
        this.register(next.secret, next.ruleId)
        end = next.end
      }
      const secret = content.slice(finding.start, end)
      const placeholder = this.register(secret, finding.ruleId)
      const hash = /:([a-f0-9]{16})\]$/.exec(placeholder)?.[1] as string
      pairs.push([hash, secret, placeholder])
      chunks.push(content.slice(cursor, finding.start), placeholder)
      cursor = end
      this.redactionCount++
    }
    chunks.push(content.slice(cursor))
    return { output: chunks.join(""), pairs }
  }

  /**
   * Apply findings, then — when this very call registered NEW secrets — one
   * exact-match pass over the OUTPUT. Within a single string the rule scan
   * can learn a secret from its keyworded occurrence ("api_key=x7k2…" at the
   * end) AFTER a bare occurrence ("- x7k2…" at the start) has already been
   * passed over; the sweep catches those stragglers. It need not loop: exact
   * matching can create overlap unions, but learns no new constituent secrets.
   */
  private applyWithVaultSweep(
    content: string,
    findings: readonly Finding[],
    vaultSizeBefore: number,
  ): { output: string; pairs: Array<readonly [string, string, string]> } {
    const first = this.applyFindings(content, findings)
    if (this.bySecret.size === vaultSizeBefore) return first
    const stragglers = this.vaultFindings(first.output)
    if (stragglers.length === 0) return first
    const second = this.applyFindings(first.output, stragglers)
    return { output: second.output, pairs: first.pairs.concat(second.pairs) }
  }

  /** Replace every detected secret in `content` with its placeholder. */
  redactString(content: string): string {
    if (typeof content !== "string" || content.length === 0) return content

    const cached = this.cache.get(content)
    if (cached) {
      // Re-register so a vault that was rebuilt (new process) or evicted
      // entries still learn the mapping from cache hits — including the
      // canonical rule label the placeholder text already carries.
      for (const [hash, secret, placeholder] of cached.pairs) {
        this.byHash.set(hash, secret)
        this.bySecret.set(secret, placeholder)
        const ruleId = PLACEHOLDER_PARTS_RE.exec(placeholder)?.[1]
        if (ruleId && !this.ruleIdByHash.has(hash))
          this.ruleIdByHash.set(hash, ruleId)
      }
      // One increment per secret applied, matching the cache-miss path — a
      // string with two secrets must count 2 on re-scan, not 1, or the
      // per-request "N secrets redacted" notification undercounts.
      this.redactionCount += cached.pairs.length
      return cached.output
    }

    // Restart recovery first (it can only add vault entries the sweeps below
    // then honor), then rule findings unioned with exact-match vault findings.
    this.recoverFingerprints(content)
    const vaultSizeBefore = this.bySecret.size
    const findings = [
      ...scanContent(content, this.scanOptions),
      ...this.vaultFindings(content),
    ]
    const { output, pairs } = this.applyWithVaultSweep(
      content,
      findings,
      vaultSizeBefore,
    )

    if (content.length >= CACHE_MIN_LENGTH) {
      const size = content.length + output.length
      this.cacheBytes += size
      this.cache.set(content, { output, pairs })
      for (const key of this.cache.keys()) {
        if (this.cacheBytes <= CACHE_MAX_BYTES) break
        const entry = this.cache.get(key)
        this.cacheBytes -= key.length + (entry?.output.length ?? 0)
        this.cache.delete(key)
      }
    }
    return output
  }

  /**
   * Redact a string value that appeared under a single object key. Public for
   * surfaces whose field-like name lives OUTSIDE any walked object: a tool ID
   * over its description (serialized adjacent on the wire,
   * {"name":"facebook","description":…}), an agent name over its description
   * (assembled into "- name: description" Task-tool lines). The name itself
   * is never rewritten by this call — only the value is.
   */
  redactStringUnderKey(key: string | undefined, value: string): string {
    return this.redactStringUnderKeys([key], value)
  }

  /**
   * Redact a string value that appeared under one or more candidate context
   * keys. Structured data ({"api_key":"x7k2…"}) splits the FIELD NAME a
   * keyword-gated rule needs from the value, so scanning the value alone never
   * fires generic-api-key — the reproduced gap. For every candidate key that
   * itself carries a rule keyword we also scan the reconstructed line
   * "key=value" (the same KEY=value shape env-file recovery scans) and fold in
   * every match that lands strictly inside the value, shifted back to value
   * coordinates. Multiple keys let a value inherit context from more than one
   * source — its own object key, its nearest ANCESTOR key
   * ({"credentials":{"production":…}} redacts under "credentials"; the
   * one-level bound is argued at redactWalk), and, for
   * the value element of a [key, value] pair, its sibling key (see
   * redactWalk). The plain-value scan still runs — a prefix
   * could break a rule's `^` anchor or lookbehind — and applyFindings unions all
   * of them by span. When no candidate key carries a keyword the value takes the
   * cached redactString fast path unchanged.
   */
  private redactStringUnderKeys(
    keys: ReadonlyArray<string | undefined>,
    value: string,
  ): string {
    if (typeof value !== "string" || value.length === 0) return value
    const active: string[] = []
    for (const key of keys) {
      if (key && stringHasKeyword(key) && !active.includes(key))
        active.push(key)
    }
    if (active.length === 0) return this.redactString(value)
    // Same union as redactString: restart recovery, rule findings, and
    // exact-match vault findings (the keyed prefix passes below need neither —
    // a vault hit inside the value is already covered by the plain sweep).
    this.recoverFingerprints(value)
    const vaultSizeBefore = this.bySecret.size
    const findings: Finding[] = [
      ...scanContent(value, this.scanOptions),
      ...this.vaultFindings(value),
    ]
    for (const key of active) {
      const prefix = `${key}=`
      for (const finding of scanContent(prefix + value, this.scanOptions)) {
        if (finding.start >= prefix.length) {
          findings.push({
            ...finding,
            start: finding.start - prefix.length,
            end: finding.end - prefix.length,
          })
        }
      }
    }
    return this.applyWithVaultSweep(value, findings, vaultSizeBefore).output
  }

  /** Replace every known placeholder in `content` with its secret. Unknown placeholders stay. */
  restoreString(content: string): string {
    if (typeof content !== "string" || content.length === 0) return content
    return content.replace(
      PLACEHOLDER_RE,
      (whole, hash: string) => this.byHash.get(hash) ?? whole,
    )
  }

  /**
   * Restore persisted prose only if a cold scan can reproduce its masked form.
   * The caller must supply a fingerprint snapshot confirmed on disk.
   */
  restoreText(
    content: string,
    fingerprints: readonly FingerprintEntry[],
  ): string {
    const restored = this.restoreString(content)
    if (restored === content) return content
    // No live vault, keyword history, cache, or persistence callback: those
    // would falsely certify contextless values that a restart cannot recover.
    // Even with an unchanged catalog, reusing a prior scan's vault is unsafe.
    const cold = new Redactor(this.options, this.hashKey)
    cold.seedFingerprints(fingerprints)
    try {
      return cold.redactString(restored) === content ? restored : content
    } catch (error) {
      if (error instanceof FingerprintLimitError) return content
      throw error
    }
  }

  /**
   * Deep-redact all string fields of an object/array in place, giving each
   * value its FIELD NAME as detection context (so {"api_key":"x7k2…"} redacts)
   * and scanning property names themselves for secrets. Returns the number of
   * substitutions made. The value must be a throwaway per-request structure —
   * the caller guarantees nothing persistent is reachable from it. `context`
   * is a root key path for values whose enclosing name lives outside the
   * structure — a tool ID over its JSON schema — and participates in the same
   * one-level inheritance bound as any walked key (redactWalk). Throws
   * WalkLimitError on a pathologically deep, cyclic, or path-exploding
   * structure — the caller's request must abort, not continue around it.
   */
  redactValueInPlace(
    value: unknown,
    context: ReadonlyArray<string> = [],
  ): number {
    const before = this.redactionCount
    const guard: WalkGuard = { visits: 0 }
    // A pass that REGISTERS a new secret may already have walked past a bare
    // occurrence of it in an earlier string of the same structure; the
    // registration flushed the scan cache, so one re-walk lets the vault
    // exact-match catch the straggler. A pass that registers nothing breaks
    // immediately, so the common case stays single-pass; placeholders from
    // earlier passes match nothing on re-scan.
    for (let pass = 0; pass < 3; pass++) {
      const vaultBefore = this.bySecret.size
      this.redactWalk(value, [...context], 0, guard)
      if (this.bySecret.size === vaultBefore) break
    }
    return this.redactionCount - before
  }

  /**
   * Entry check for every RECURSIVE deep-walk step. Depth is per path and
   * accounts only for recursive descent; the node itself also charges the
   * shared visit budget (chargeVisit). Throws WalkLimitError — the
   * fail-closed direction argued at the constants — instead of pruning.
   */
  private checkWalkLimits(depth: number, guard: WalkGuard): void {
    if (depth > MAX_WALK_DEPTH) throw new WalkLimitError("depth")
    this.chargeVisit(guard)
  }

  /**
   * Charge one traversal step against the walk's shared budget. Every
   * traversed child pays: recursive descent through checkWalkLimits, and —
   * because the containing walker scans string leaves and property names
   * INLINE, which is precisely the expensive per-leaf work the budget exists
   * to bound — every inline string scan and every property name too. Without
   * the inline charges, MAX_WALK_VISITS+1 string leaves walked (and scanned)
   * unbounded while the same width of numeric leaves threw (finding).
   */
  private chargeVisit(guard: WalkGuard): void {
    guard.visits += 1
    if (guard.visits > MAX_WALK_VISITS) throw new WalkLimitError("nodes")
  }

  /**
   * Deep-redact an arbitrary object/array in place with field-name awareness.
   * A string value is redacted under its object key PLUS its NEAREST ancestor
   * key (redactStringUnderKeys): real payloads bury generic secrets under
   * keyword-free leaf names — {"credentials":{"production":"x7k2…"}}, a JSON
   * Schema's {"properties":{"api_key":{"default":"x7k2…"}}} — where the
   * keyword a gated rule needs sits one level UP. Scanning under that key
   * fires exactly like the flat "credentials=x7k2…" line, and
   * redactStringUnderKeys ignores keys that carry no keyword, so the extra
   * context costs nothing when the parent is inert. The inheritance is
   * DELIBERATELY BOUNDED to one level: a keyword two or more levels up is a
   * container, not an assignment — treating {"api":{"response":{"trace_id":
   * "4bf9…"}}} as "api=4bf9…" mass-redacted the trace/session/etag
   * identifiers that pervade clean tool output (adversarially reproduced),
   * associations upstream's flat scan would never make either (the structure
   * between keyword and value breaks the rule's ≤20-char bridge). One level
   * IS what flat "credentials = x7k2…" grants, so that is what a value
   * inherits. An array's string elements inherit the array's key plus ITS
   * parent the same way ({"api_keys":["x7k2…"]} has no per-element name of
   * its own). The one addition is a 2-element [key, value] PAIR — the tuple
   * shape HTTP headers, URLSearchParams entries, and Object.entries output
   * take ({"headers":[["api_key","x7k2…"]]}) — where the value element
   * additionally inherits the KEY element as context, so a keyword-gated rule
   * fires as it would on the equivalent object. That context is ADDED, never
   * substituted, so a plain value array still redacts every element. Each
   * property NAME is also scanned — under the ENCLOSING key, because like an
   * array element a name has no field name of its own ({"api_keys": {"x7k2…":
   * true}} is the map shape of {"api_keys": ["x7k2…"]}, and property names
   * serialize to the provider just like values) — and, if it is itself a
   * secret, renamed to its placeholder (a secret can sit in a key, e.g. an
   * api-key-indexed map). A secret key is dropped UNCONDITIONALLY — fail
   * closed, so the raw key can never serialize. Normally the value moves to
   * the placeholder key; in the astronomically unlikely case that the
   * placeholder already names a sibling (an attacker would have to know this
   * install's HMAC fingerprint), the existing sibling is kept and this value
   * is dropped rather than retain the sensitive key or clobber the sibling.
   *
   * `keyPath` is a shared stack (nearest key last), pushed/popped around each
   * descent; callers outside the walk pass their root context (or []). The
   * stack keeps the full path so the bound is applied at each USE site
   * (slice(-1)/slice(-2)), not baked into the traversal.
   *
   * The walk is depth- and visit-bounded (checkWalkLimits): a pathological
   * structure throws WalkLimitError so the enclosing request aborts closed —
   * it never degrades to skipping the branch that tripped the limit.
   */
  private redactWalk(
    value: unknown,
    keyPath: string[],
    depth: number,
    guard: WalkGuard,
  ): void {
    this.checkWalkLimits(depth, guard)
    if (Array.isArray(value)) {
      // A 2-element [key, value] pair (a header, a query parameter, one
      // Object.entries row) carries its own field name in element 0. The value
      // element (1) is scanned under that key as well as the ancestor path;
      // every other element keeps just the path, so a plain value array is
      // unaffected. Directional on purpose: element 0 is the key, matching
      // every standard pair representation.
      const pairKey =
        value.length === 2 && typeof value[0] === "string"
          ? (value[0] as string)
          : undefined
      for (let i = 0; i < value.length; i++) {
        const item = value[i]
        const isPairValue = i === 1 && pairKey !== undefined
        if (typeof item === "string") {
          this.chargeVisit(guard)
          // An element's "own key" is the array's key (path tail), so like an
          // object value it sees that key plus one ancestor: slice(-2).
          value[i] = isPairValue
            ? this.redactStringUnderKeys([pairKey, ...keyPath.slice(-1)], item)
            : this.redactStringUnderKeys(keyPath.slice(-2), item)
        } else if (isPairValue) {
          // A pair's non-string value ([["credentials", {…}]]) descends with
          // the pair key on the path, mirroring the equivalent object shape.
          keyPath.push(pairKey)
          this.redactWalk(item, keyPath, depth + 1, guard)
          keyPath.pop()
        } else {
          this.redactWalk(item, keyPath, depth + 1, guard)
        }
      }
      return
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>
      for (const key of Object.keys(record)) {
        // One charge per property covers the NAME scan below; a string value
        // is a second inline-scanned child and charges again.
        this.chargeVisit(guard)
        const item = record[key]
        let newValue: unknown = item
        if (typeof item === "string") {
          this.chargeVisit(guard)
          // Own key + nearest ancestor — the one-level bound documented above.
          newValue = this.redactStringUnderKeys(
            [key, ...keyPath.slice(-1)],
            item,
          )
        } else {
          keyPath.push(key)
          this.redactWalk(item, keyPath, depth + 1, guard)
          keyPath.pop()
        }
        // A name has no key of its own; its context is the enclosing key
        // (path tail), exactly the array-element rule.
        const newKey = this.redactStringUnderKeys(keyPath.slice(-1), key)
        if (newKey === key) {
          record[key] = newValue
          continue
        }
        // The key itself was a secret. Drop it regardless of whether the
        // placeholder slot is free, so the raw key never survives; only fill the
        // placeholder key when nothing already occupies it.
        delete record[key]
        if (!(newKey in record)) record[newKey] = newValue
      }
    }
  }

  /**
   * Deep-redact an array of message parts in place, applying the
   * PART_STRUCTURAL_KEYS skip exactly where the schema says those names are
   * structural: on the part itself and on FilePart attachments nested under a
   * tool part's state. Everything below — tool input, output, metadata,
   * errors — is scanned in full whatever its keys are called. Returns the
   * number of substitutions made.
   */
  redactPartsInPlace(parts: unknown): number {
    const before = this.redactionCount
    if (Array.isArray(parts)) {
      const guard: WalkGuard = { visits: 0 }
      // Multi-pass for the same reason as redactValueInPlace: part 3's
      // "api_key=x7k2…" registers a secret whose bare "- x7k2…" in part 1 was
      // already walked; the re-walk's exact-match sweep catches it.
      for (let pass = 0; pass < 3; pass++) {
        const vaultBefore = this.bySecret.size
        for (const part of parts) this.redactPart(part, 0, guard)
        if (this.bySecret.size === vaultBefore) break
      }
    }
    return this.redactionCount - before
  }

  private redactPart(part: unknown, depth: number, guard: WalkGuard): void {
    this.checkWalkLimits(depth, guard)
    if (!part || typeof part !== "object" || Array.isArray(part)) return
    const record = part as Record<string, unknown>
    for (const key of Object.keys(record)) {
      // Every key is a traversed child: its value is either scanned inline
      // right here (a url, a plain string) or charged again on entry by the
      // walker it descends into.
      this.chargeVisit(guard)
      const value = record[key]
      if (key === "url") {
        // The attachment payload url. redactPartUrl decides what is readable on
        // the wire and scans it: a `file:` path (resolved locally, never sent)
        // is left alone; a `data:` url has its metadata scanned like a `mime`
        // field and its payload scanned unless its declared binary type is
        // magic-confirmed; a remote http(s) url is scanned whole. Only
        // genuinely opaque bytes (a magic-confirmed binary data: payload, a
        // file: path) survive untouched.
        if (typeof value === "string") record[key] = this.redactPartUrl(value)
        continue
      }
      if (PART_STRUCTURAL_KEYS.has(key)) continue
      if (
        key === "metadata" &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        this.redactPartMetadata(
          value as Record<string, unknown>,
          depth + 1,
          guard,
        )
      } else if (
        key === "state" &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        this.redactToolState(value as Record<string, unknown>, depth + 1, guard)
      } else if (typeof value === "string") {
        record[key] = this.redactStringUnderKey(key, value)
      } else {
        this.redactWalk(value, [key], depth + 1, guard)
      }
    }
  }

  /**
   * Redact `part.metadata`, leaving provider-issued opaque protocol state
   * byte-exact.
   *
   * The host stores this map as `{ <providerNamespace>: { ...providerState } }`
   * and hands it straight back to the provider as `providerOptions` on the next
   * request (provider/transform.ts). For OpenAI that state is the reasoning
   * item's `itemId` and its `reasoningEncryptedContent` — and with `store:false`
   * the ciphertext is not a cache of anything, it IS how the model sees its own
   * prior reasoning, so it travels in the prompt on every later turn.
   *
   * Rewriting a byte of it is pure loss. The value is ciphertext or an id the
   * provider minted, so it cannot hold a plaintext credential this scan would
   * otherwise catch; but a placeholder substituted into it corrupts protocol
   * state the provider will reject or silently mis-thread. And these blobs are
   * base64/hex over a large alphabet, which is exactly the shape entropy-gated
   * rules are built to notice — so "no rule matches one today" is a property of
   * the current rule set, not a guarantee. Skipping them is therefore the
   * fail-SAFE direction here, the one place in this plugin where scanning less
   * is the more conservative choice.
   *
   * Scoped to one level under the namespace on purpose: every other field in
   * metadata — a differently named one, a nested object, an array — walks
   * normally, so metadata is not a hole.
   *
   * The skip is keyed on the FIELD NAME under any namespace, not on exact
   * `<provider>.<field>` pairs, so `metadata.someplugin.signature` is skipped
   * too. That is deliberate and it is the one asymmetry worth stating twice:
   * provider namespaces are an open set, and a namespace this build has never
   * heard of is far more likely to be a provider added since the pin than a
   * plugin stashing a credential under a name that means "ciphertext". See
   * OPAQUE_PROVIDER_KEYS for the full argument and the verified field list.
   * The keyword SWEEP does not follow this rule — it drops these names only at
   * the real provider path (serializeForKeywordSweep), because there a
   * false skip costs detection instead of buying safety.
   */
  private redactPartMetadata(
    metadata: Record<string, unknown>,
    depth: number,
    guard: WalkGuard,
  ): void {
    this.checkWalkLimits(depth, guard)
    for (const namespace of Object.keys(metadata)) {
      this.chargeVisit(guard)
      const state = metadata[namespace]
      if (!state || typeof state !== "object" || Array.isArray(state)) {
        if (typeof state === "string")
          metadata[namespace] = this.redactStringUnderKey(namespace, state)
        else this.redactWalk(state, [namespace], depth + 1, guard)
        continue
      }
      const record = state as Record<string, unknown>
      this.checkWalkLimits(depth + 1, guard)
      for (const field of Object.keys(record)) {
        this.chargeVisit(guard)
        const value = record[field]
        if (typeof value === "string") {
          if (OPAQUE_PROVIDER_KEYS.has(field.toLowerCase())) continue
          record[field] = this.redactStringUnderKeys([field, namespace], value)
        } else this.redactWalk(value, [namespace, field], depth + 2, guard)
      }
    }
  }

  /**
   * Scan a part-level url and rewrite everything on it the provider can read.
   *
   *   - A `file:` path is resolved locally before any request leaves the machine
   *     (message-v2.ts), so it never reaches the provider and is left untouched.
   *   - A `data:` url: its pre-comma METADATA (mediatype + any `;param=value`) is
   *     always scanned — the host places the full url into the outbound file part
   *     (message-v2.ts:221). Defense in depth: the AI SDK reduces a data-url
   *     mediatype to its bare type (dropping `;params`) before the wire, so a
   *     `;token=ghp_...` parameter is masked rather than trusted to be stripped,
   *     keeping parity with the scanned `mime` field. Then the payload: a
   *     base64 payload whose DECLARED binary mediatype is CONFIRMED by its own
   *     magic bytes (a real image or audio/video clip — isOpaqueBinaryPayload)
   *     is opaque bytes and left byte-for-byte alone; every OTHER base64
   *     payload — a PDF, an unrecognized type, or textual bytes wearing a
   *     binary label — is decoded (UTF-8 when well-formed, so proximity-bounded
   *     rules count the code points the provider will read; latin1, the
   *     byte-exact 1:1 map, otherwise — see decodePayloadBytes) and SCANNED,
   *     never exempted by its content — a leading NUL cannot hide a textual
   *     credential inside an application/json attachment, and an `image/png`
   *     label cannot hide one either — and re-encoded only
   *     when something changed, so a clean payload round-trips unchanged.
   *     OpenCode base64-encodes any non-`text/plain` attachment (prompt.ts:962),
   *     so a credential in a textual one would otherwise reach the provider in
   *     full. A plaintext (non-base64) payload is percent-DECODED before scanning
   *     — a percent-encoded secret would otherwise slip past shape- and
   *     keyword-based rules — tolerantly (percentDecodeTolerant: a malformed
   *     escape passes through literally instead of aborting the decode, so one
   *     stray `%FF` cannot shield the properly encoded secret beside it), and
   *     re-encoded only when redacted.
   *   - Every non-`data:` scheme (a remote http(s) url) is handed to
   *     redactRemoteUrl, which scans each url component percent-decoded.
   *
   * The rebuilt data url is byte-identical to the input when nothing matched
   * (scheme + scanned-mediatype + base64 marker + "," + payload reconstructs the
   * original), so a request without a secret is never altered.
   */
  private redactPartUrl(url: string): string {
    if (/^\s*file:/i.test(url)) return url
    const data = parseDataUrl(url)
    if (!data) return this.redactRemoteUrl(url)
    const mediatype = this.redactString(data.mediatype)
    const prefix = `${data.scheme}${mediatype}${data.base64Marker},`
    if (data.base64) {
      if (isOpaqueBinaryPayload(data.mediatype, data.payload))
        return prefix + data.payload
      const { text, encoding } = decodePayloadBytes(
        Buffer.from(data.payload, "base64"),
      )
      const redacted = this.redactString(text)
      const payload =
        redacted === text
          ? data.payload
          : Buffer.from(redacted, encoding).toString("base64")
      return prefix + payload
    }
    const decoded = percentDecodeTolerant(data.payload)
    const redacted = this.redactString(decoded)
    const payload =
      redacted === decoded ? data.payload : encodeURIComponent(redacted)
    return prefix + payload
  }

  /**
   * Scan a non-`data:` part url — a remote http(s) attachment url the host
   * forwards to the provider verbatim (message-v2.ts:221). Two passes:
   *
   *   1. PER-COMPONENT, percent-DECODED. A raw scan misses a secret hidden by
   *      percent-encoding — `?token=%67%68%70%5f…` is a valid `ghp_` credential
   *      once decoded, yet the encoded bytes match no rule. So each component is
   *      decoded before scanning: query parameter names and their values (values
   *      under the original name, so `?api_key=…` keeps the keyword context a
   *      keyword-gated rule needs), then userinfo, path, and fragment.
   *   2. WHOLE-STRING backstop over the assembled url. Pass 1 scans each region
   *      in ISOLATION, which the pre-fix whole-string `redactString(url)` did
   *      not: it never sees the host/authority, and it cannot fire a url rule
   *      keyword-gated on one region whose token lives in another
   *      (slack-webhook-url keys on the `hooks.slack.com` host but captures a
   *      path token). A final raw scan restores exactly that coverage. It is
   *      inert on the placeholders pass 1 already inserted (a placeholder never
   *      re-matches a secret rule) and returns a clean url byte-identical, so no
   *      request without a secret is altered. Pass 2 is a raw (still-encoded)
   *      scan, so the one residual — a secret that is BOTH percent-encoded AND
   *      sits only in a host label, the one region pass 1 does not decode — is
   *      left to the general "no encoded-segment passes" limitation, exactly as
   *      before this fix.
   *
   * The url is rebuilt after pass 1 only when a component actually changed; a
   * rebuilt one re-encodes normally (the placeholder percent-encoded along with
   * everything else), which is harmless for an outbound url whose secret is
   * already gone. A url the parser rejects (relative), or one whose scheme is
   * not hierarchical http(s)/ws(s) — a malformed `data:` the earlier parse
   * missed, or any opaque scheme that folds its payload into a path the
   * component pass can't see — skips pass 1 and is covered by a raw scan alone.
   */
  private redactRemoteUrl(url: string): string {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return this.redactString(url)
    }
    if (!/^(?:https?|wss?):$/i.test(parsed.protocol))
      return this.redactString(url)
    let changed = false
    const params = parsed.searchParams
    // Snapshot the keys first: delete+append below reorders the params.
    for (const key of new Set(params.keys())) {
      const values = params.getAll(key)
      // URLSearchParams exposes parameter NAMES percent-decoded, and this is
      // the only place the decoded name is visible — pass 2's raw scan sees
      // only its encoded bytes, so `?%67%68%70…=1` would otherwise pass
      // through carrying a live credential as the key. Values keep the
      // ORIGINAL name as keyword context; a redacted name carries none.
      const redactedKey = this.redactString(key)
      const redacted = values.map((value) =>
        this.redactStringUnderKey(key, value),
      )
      if (
        redactedKey !== key ||
        redacted.some((value, index) => value !== values[index])
      ) {
        params.delete(key)
        for (const value of redacted) params.append(redactedKey, value)
        changed = true
      }
    }
    // Percent-decode each remaining component before scanning; the URL setter
    // re-encodes on write. Decoding is per-escape-run (percentDecodeTolerant),
    // so a malformed escape passes through literally while every valid run
    // around it still decodes — an all-or-nothing decode would let one stray
    // `%FF` in the path hide a fully percent-encoded credential beside it.
    const scanComponent = (encoded: string): string | undefined => {
      if (encoded.length === 0) return undefined
      const decoded = percentDecodeTolerant(encoded)
      const redacted = this.redactString(decoded)
      return redacted === decoded ? undefined : redacted
    }
    const username = scanComponent(parsed.username)
    if (username !== undefined) {
      parsed.username = username
      changed = true
    }
    const password = scanComponent(parsed.password)
    if (password !== undefined) {
      parsed.password = password
      changed = true
    }
    const pathname = scanComponent(parsed.pathname)
    if (pathname !== undefined) {
      parsed.pathname = pathname
      changed = true
    }
    const fragment = scanComponent(parsed.hash.replace(/^#/, ""))
    if (fragment !== undefined) {
      parsed.hash = fragment
      changed = true
    }
    // Pass 2: whole-string backstop over the (rebuilt) url — covers the host, a
    // bare query-key, and host-keyword-gated url rules pass 1 leaves untouched.
    return this.redactString(changed ? parsed.toString() : url)
  }

  private redactToolState(
    state: Record<string, unknown>,
    depth: number,
    guard: WalkGuard,
  ): void {
    this.checkWalkLimits(depth, guard)
    for (const key of Object.keys(state)) {
      // Every key is a traversed child — same accounting as redactPart.
      this.chargeVisit(guard)
      // `status` is the state discriminator; attachments are FileParts, so
      // they get the part policy (mime is scanned like any wire-bound string;
      // magic-confirmed binary base64 payloads and file: paths are skipped;
      // remote urls, plaintext data: urls, and every other base64 payload —
      // PDFs, unrecognized types, and mislabeled binaries included — are
      // decoded and scanned).
      if (key === "status") continue
      const value = state[key]
      if (key === "attachments" && Array.isArray(value)) {
        for (const attachment of value)
          this.redactPart(attachment, depth + 1, guard)
      } else if (typeof value === "string") {
        state[key] = this.redactStringUnderKey(key, value)
      } else {
        this.redactWalk(value, [key], depth + 1, guard)
      }
    }
  }

  /**
   * Placeholder hashes present anywhere in `value` (a string, object, or
   * array) that this vault cannot restore. A non-empty result means a
   * fingerprint recovery scan is worth attempting before restoring.
   */
  collectUnresolved(value: unknown): Set<string> {
    const missing = new Set<string>()
    const inspect = (s: string): string => {
      for (const match of s.matchAll(PLACEHOLDER_RE)) {
        const hash = match[1] as string
        if (!this.byHash.has(hash)) missing.add(hash)
      }
      return s
    }
    if (typeof value === "string") inspect(value)
    else this.walk(value, inspect, 0, { visits: 0 })
    return missing
  }

  /**
   * Scan content purely to learn secret→placeholder mappings — used by
   * fingerprint recovery, where a placeholder's sha256-derived hash lets the
   * vault re-verify a secret found in the shell environment or an env file.
   */
  learnFrom(content: string): void {
    this.redactString(content)
  }

  /** Deep-restore all placeholders in an object/array in place. Returns substitution count. */
  restoreValueInPlace(value: unknown): number {
    let count = 0
    this.walk(
      value,
      (s) => {
        const restored = this.restoreString(s)
        if (restored !== s) count++
        return restored
      },
      0,
      { visits: 0 },
    )
    return count
  }

  /**
   * Apply `transform` to every string in `value` in place, INCLUDING object
   * property names — the redaction walk can rewrite a key when the key itself
   * is a secret, so restore (transform = restoreString) and unresolved-hash
   * collection (transform = inspect) must be symmetric or a placeholder that
   * landed in a key could never be brought back. A renamed key that collides
   * with a sibling is skipped (the original key is kept) — the safe outcome in
   * this direction, where the "raw" key is a placeholder and keeping it can only
   * leave a value unrestored, never leak a secret. redactWalk instead DROPS a
   * colliding key, because there the raw key is the secret.
   *
   * Bounded exactly like redactWalk (checkWalkLimits, same ceilings), so
   * anything the redaction walk accepted, restore and unresolved-hash
   * collection can walk too — and a pathological structure aborts with the
   * same WalkLimitError instead of overflowing the stack or spinning forever.
   */
  private walk(
    value: unknown,
    transform: (s: string) => string,
    depth: number,
    guard: WalkGuard,
  ): void {
    this.checkWalkLimits(depth, guard)
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i]
        if (typeof item === "string") {
          this.chargeVisit(guard)
          value[i] = transform(item)
        } else {
          this.walk(item, transform, depth + 1, guard)
        }
      }
      return
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>
      for (const key of Object.keys(record)) {
        // Same accounting as redactWalk: the property name is one inline
        // child, a string value a second.
        this.chargeVisit(guard)
        const item = record[key]
        let newValue: unknown = item
        if (typeof item === "string") {
          this.chargeVisit(guard)
          newValue = transform(item)
        } else {
          this.walk(item, transform, depth + 1, guard)
        }
        const newKey = transform(key)
        if (newKey !== key && !(newKey in record)) {
          delete record[key]
          record[newKey] = newValue
        } else {
          record[key] = newValue
        }
      }
    }
  }

  /**
   * Rewrite a serialized JSON request body, redacting every string value.
   * Returns the original string when nothing changed (or when the body is
   * not parseable JSON), so untouched requests stay byte-identical.
   */
  redactJsonBody(body: string): string {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return body
    }
    if (!parsed || typeof parsed !== "object") return body
    // The provider reads this body as ONE document, so a rule keyword
    // anywhere in it must gate that rule in every string of it — the same
    // cross-string contract messages.transform honors. The surfaces only this
    // backstop covers (MCP tool definitions, the StructuredOutput schema)
    // never pass a note-taking hook, so without this note a keyword in one of
    // their strings ("facebook token follows" in a description) could not
    // gate the bare token in a sibling string (a schema default). Noted
    // BEFORE the walk so string order inside the body cannot matter.
    //
    // The RAW body string is noted, deliberately NOT an incremental split of
    // the parsed object (audit M7 targets messages.transform, not this
    // surface). Splitting here would have to start from `parsed`, and
    // JSON.parse has already collapsed any duplicate key — so a keyword
    // living only in a shadowed value would be lost, a soundness regression
    // versus noting the pre-parse bytes. messages.transform can split safely
    // because it starts from JS objects (whose keys are unique by
    // construction); a serialized string body cannot. The residual cost (one
    // keyword sweep of the body) is bounded by keywordsIn skipping keywords
    // already in the set — and on a configured provider messages.transform
    // has populated it incrementally before this fires — while the
    // side-channel bodies this backstop uniquely covers (a title request, a
    // tool-definition set) are small.
    this.noteScanContext(body)
    const count = this.redactValueInPlace(parsed)
    return count > 0 ? JSON.stringify(parsed) : body
  }
}

export {
  dropContentLength,
  MAX_WIRE_BODY_BYTES,
  OversizedBodyError,
  redactWireRequest,
  UnscannableBodyError,
  type WireRequestResult,
} from "./wire-body"

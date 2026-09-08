import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  appLogger,
  compactionNote,
  createSerialQueue,
  openCodeDataDir,
  readAuthStore,
  readJsonFile,
  registerSourceRedactor,
  reportServerCompat,
  serverToast,
} from "@macarons/permission-rules"
import type { Plugin } from "@opencode-ai/plugin"
import {
  COMPACTION_NOTE,
  catalogWireCandidates,
  ENV_FILE_CANDIDATES,
  type FingerprintEntry,
  FingerprintLimitError,
  HistoryPins,
  hasAuthEntry,
  MAX_RECOVERY_FILE_BYTES,
  PIN_SCOPES,
  parseOptions,
  Redactor,
  redactWireRequest,
  runtimeFlagEnabled,
  SYSTEM_NOTE,
  serializeForKeywordSweep,
  unsafeWireProviders,
  VaultLimitError,
  validFingerprintEntry,
  WalkLimitError,
} from "./shared"

/**
 * @macarons/redact-secrets — server half (the whole plugin; no TUI).
 *
 * A last line of defense against secrets reaching a model provider: every
 * outbound request is scanned with a vendored betterleaks rule set, detected
 * secrets are replaced in-flight with deterministic placeholders, and the
 * placeholders are turned back into the real values exactly where they are
 * needed locally. The layers, all verified against the 1.17.18 source:
 *
 *   OUTBOUND (redact)
 *   1. experimental.chat.messages.transform — the primary layer. Message
 *      parts here are fresh per-request deserializations (prompt.ts hydrates
 *      new objects from the DB each turn), so in-place redaction changes only
 *      what this request sends — never stored session state. It covers every
 *      provider and transport, including auth-plugin fetches (Codex
 *      websockets) the wire layer cannot see, and the compaction path, which
 *      fires the same hook on a structuredClone.
 *   2. experimental.chat.system.transform — system prompt strings, plus an
 *      appended note teaching the model to treat placeholders as opaque and
 *      copy them verbatim into tool calls.
 *   3. tool.definition — descriptions and JSON schemas of built-in and
 *      plugin-registered tools, the only tool-definition surface the host
 *      exposes (registry.ts:313). MCP server tools and StructuredOutput
 *      schemas pass through NO hook (session/tools.ts:390-489,
 *      prompt.ts:1244); only the wire backstop below can cover those.
 *   4. A wire backstop: provider options.fetch that re-scans the fully
 *      serialized request body (catches side channels like title generation,
 *      which bypasses the chat transforms — verified: llm.stream fires no
 *      messages hook; only prompt.ts:1255 and compaction.ts:350 do). Every
 *      body shape is inspected, not just strings — bytes, Blobs, streams,
 *      and Request-held bodies are decoded and, when JSON, redacted in
 *      their original encoding; an undecodable maybe-JSON body aborts
 *      (redactWireRequest in shared.ts, audit L-RS3).
 *      Installed ONLY where provably safe, on two classes of provider:
 *        a. entries the user already configured in opencode.json, and
 *        b. providers the host provably activates WITHOUT a config entry —
 *           a models.dev catalog provider whose env key is set, or one with
 *           an api-key auth entry (provider.ts:1506-1530). For those a
 *           minimal config entry carrying only the fetch is injected; the
 *           catalog-membership requirement keeps this from conjuring
 *           phantom selector entries, and the catalog is read from the same
 *           snapshot the host reads (OPENCODE_MODELS_PATH, else the
 *           models.json cache). No snapshot readable (first-ever run, or a
 *           custom OPENCODE_MODELS_URL whose cache filename is hashed) means
 *           class (b) degrades to nothing, with a logged warning.
 *      Skipped everywhere the host installs its own fetch AFTER the config
 *      hook — config options are re-applied last at provider.ts:1571-1577
 *      and would clobber it: oauth-authed providers and github-copilot
 *      (auth-plugin loaders; breaking Codex OAuth was the original lesson),
 *      google-vertex and snowflake-cortex (custom assembly-time loaders),
 *      and openai whenever the websocket rollout is live, because the Codex
 *      loader then installs a pooled websocket fetch even for plain api-key
 *      auth (plugin/openai/codex.ts:314-323). Auth state is read the way
 *      the host reads it — inline OPENCODE_AUTH_CONTENT first, then
 *      auth.json (auth/index.ts:58-67). Residual gap, by design: for the
 *      skipped providers the one-shot generation side channels stay open —
 *      title generation and agent-from-description generation, which embed
 *      user text into a generateObject/streamObject call that fires the
 *      system transform but not the messages transform (agent/agent.ts:406) —
 *      and so do MCP tool definitions and structured-output schemas (no hook
 *      fires for them — see layer 3); the transform layers still cover
 *      every chat turn. A third-party auth plugin that installs a fetch for
 *      non-oauth auth is undetectable here. And the wire backstop is a fetch
 *      wrapper, so the experimental native LLM runtime
 *      (OPENCODE_EXPERIMENTAL_NATIVE_LLM) bypasses it entirely for its
 *      supported providers — it drives @opencode-ai/llm's own transport and
 *      honors options.fetch only for an openai OAuth override
 *      (session/llm/native-runtime.ts:148-153) — widening the same
 *      side-channel gap (title generation, MCP definitions, structured-output
 *      schemas) to every native-eligible OpenAI/Anthropic/opencode provider.
 *      A plugin cannot intercept that transport; the factory warns loudly at
 *      startup when the flag is set (see README known gaps).
 *
 *   INBOUND (restore)
 *   5. experimental.text.complete — placeholders the model echoes in its
 *      prose are restored only when a cold scan can re-mask them; the host
 *      writes the hook's text back into the stored part (processor.ts:516-530),
 *      so transcript and TUI show either the safe raw form or placeholders.
 *   6. tool.execute.before — placeholders inside tool arguments are restored
 *      on the exact args object handed to the tool (tools.ts:106-111), so
 *      commands and file writes use the real secret. The transcript's
 *      recorded call keeps the placeholder (the processor stores tool input
 *      from the model stream independently), which is the desirable outcome:
 *      what the model said stays what the model said.
 *
 * The placeholder→secret map lives in memory only; no detected secret — and
 * nothing a secret could be recomputed from — is ever written to disk. The
 * plugin persists exactly two local 0600 files: the random per-installation
 * HMAC key placeholders are derived under (so they stay stable across
 * restarts without becoming an offline oracle: an observer of provider logs
 * cannot test a guessed low-entropy credential against a keyed hash, and two
 * installations never map the same secret to the same placeholder), and a
 * fingerprint catalog of (keyed 16-hex hash, rule id, length) per vaulted
 * secret — the hash is the same value already embedded in every placeholder
 * sent to providers, and rule id + length are the only metadata disclosed.
 *
 * A KNOWN secret is redacted by exact match wherever its bytes appear,
 * context-free: text.complete writes restored values back into stored prose
 * where the field context a detection rule needs is gone ("- x7k2…"), so rule
 * re-scanning alone reproducibly leaked exactly those (review finding). The
 * in-memory vault covers that within a process; the fingerprint catalog
 * covers it across restarts (recoverFingerprints re-identifies the value by
 * keyed hash and re-registers it), and also pins each placeholder's rule
 * label so the placeholder STRING — not just its hash — is stable across
 * restarts and detection contexts (prompt-cache stability). Self-healing has
 * three legs: a restarted process re-learns mappings when the next outbound
 * request re-scans the transcript (rule scan + fingerprint catalog), and a
 * hash the transcript can no longer explain (compaction erased the raw copy
 * before a restart) is re-derived by env fingerprint recovery — rescanning
 * the shell environment and project env files and verifying candidates
 * against the placeholder's hash. Compaction summaries
 * are additionally asked (experimental.session.compacting) to carry every
 * live placeholder forward, and since summaries stream through the same
 * text.complete write-back, the stored summary keeps restart-safe raw copies.
 * Values that cannot be safely re-masked stay placeholders instead.
 *
 * Targets OpenCode v1; verified against 1.17.18–1.18.x. Outside that band it
 * warns but keeps redacting; only OpenCode v2+ (whose plugin API differs)
 * disables it.
 */

const SERVICE = "redact-secrets"

/**
 * Clone the wire-visible form of a tool JSON schema that structuredClone
 * rejected. Rejection means a function or symbol lives somewhere in it — but
 * JSON serialization silently DROPS those and keeps every serializable
 * sibling, secrets included, so the schema is still wire-visible and must
 * still be redacted. A JSON round-trip reproduces exactly what the host's own
 * serialization would emit (same dropped values, same toJSON handling); the
 * caller redacts that and swaps it in. A schema JSON.stringify itself rejects
 * (a cycle, a BigInt) cannot reach the wire at all — throw, so the request
 * aborts closed instead of forwarding a schema no layer has scanned. The
 * error never quotes the schema; it could contain the very secret at stake.
 */
function wireVisibleSchemaClone(
  schema: object,
  toolID: string | undefined,
): unknown {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(schema)
  } catch (cause) {
    throw new Error(
      `${SERVICE}: the JSON schema of tool "${toolID ?? "<unknown>"}" can be neither cloned nor serialized; ` +
        "aborting the request rather than forwarding the schema unredacted",
      { cause },
    )
  }
  // A toJSON returning undefined serializes to nothing at the top level; the
  // caller treats any nullish snapshot as unpinnable and aborts, because a
  // key-sensitive toJSON could still emit a secret when the host serializes
  // the original under a real property name.
  return serialized === undefined ? undefined : JSON.parse(serialized)
}

/**
 * The session a message belongs to, or undefined when the host hands us a
 * shape without one. `experimental.chat.messages.transform` receives no
 * sessionID of its own (input is `{}` in 1.18.5), but every Message carries
 * one; an unattributable message simply goes unpinned — the pre-pin behavior,
 * never a pin under the wrong scope.
 */
function messageScope(message: unknown): string | undefined {
  const info = (message as { info?: { sessionID?: unknown } } | null)?.info
  const id = info?.sessionID
  return typeof id === "string" && id.length > 0 ? id : undefined
}

/**
 * The provider/model a pinned decision was made FOR, folded into the pin key
 * so a decision can never be reused across destinations.
 *
 * A pin's safety rests entirely on the claim that its bytes already went to
 * the destination this request is bound for. Session alone does not carry that
 * claim: OpenCode lets a session change model mid-conversation, and routes the
 * same session's history to a separately configured compaction model
 * (session/compaction.ts:328-350). A value sent raw to provider A must not
 * stay pinned raw when the next request goes to provider B, where it would be
 * a first disclosure rather than a repeat.
 */
function destinationKey(model: unknown): string | undefined {
  const record = model as
    | {
        providerID?: unknown
        id?: unknown
        modelID?: unknown
        variant?: unknown
      }
    | null
    | undefined
  const provider = record?.providerID
  // `Model` names it `id`; a message's stored `model` names it `modelID`.
  const id = typeof record?.id === "string" ? record.id : record?.modelID
  if (typeof provider !== "string" || typeof id !== "string") return undefined
  const variant = typeof record?.variant === "string" ? record.variant : ""
  return `${provider}/${id}/${variant}`
}

/**
 * The destination a `messages.transform` batch is bound for, read from the
 * LAST user message's stored model — which is exactly how the host picks it
 * (`getModel(lastUser.model.providerID, lastUser.model.modelID)`,
 * session/prompt.ts:1141). Undefined disables pinning for the batch.
 *
 * The compaction path is the exception this cannot see: it calls the same hook
 * with history whose last user message names the USER's model while the
 * request goes to the compaction agent's. That path is excluded separately, by
 * the `experimental.session.compacting` hook that fires just before it.
 */
function messagesDestination(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = (messages[i] as { info?: { role?: unknown; model?: unknown } })
      ?.info
    if (info?.role === "user") return destinationKey(info.model)
  }
  return undefined
}

/**
 * The shared compacting-hook body, bound to this plugin's own note. Kept as a
 * standing binding rather than the hook itself because the hook also has pin
 * bookkeeping to do; the note push is still single-sourced.
 */
const pushCompactionNote = compactionNote(COMPACTION_NOTE)

/**
 * Part types only an assistant message carries. Seeing one is this plugin's
 * evidence that a request for that session reached the provider and was
 * answered — the signal HistoryPins promotes pending decisions on. User-side
 * types (`text`, `file`, `agent`) are excluded deliberately: those parts are
 * published when the prompt is created, BEFORE the request is built, so
 * treating them as delivery would confirm an attempt that never sent.
 */
const ASSISTANT_PROGRESS_PARTS: ReadonlySet<string> = new Set([
  "step-start",
  "step-finish",
  "reasoning",
  "tool",
])

/**
 * Stable serialization of a part array for use as a pin key or pin value.
 * Returns undefined when the parts will not serialize, which disables pinning
 * for that message rather than keying it on something lossy.
 */
function serializeParts(parts: unknown): string | undefined {
  try {
    return JSON.stringify(parts)
  } catch {
    return undefined
  }
}

function isContainer(
  value: unknown,
): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null
}

/**
 * Copy a pinned snapshot onto a live tree, mutating the EXISTING objects and
 * arrays rather than swapping in the parsed ones.
 *
 * Structural identity is guaranteed by construction — the pin is keyed on the
 * serialization of this very tree and holds the serialization of that same tree
 * after redaction, so only leaf strings differ — and is re-checked anyway
 * (matching lengths and key sets), because a pin is process state and this is
 * the cheapest place to refuse a mismatched one.
 *
 * Mutating in place rather than replacing matters for the same reason redaction
 * does it: the host handed us these objects and may hold references to
 * individual parts, not just the array. A swap would leave any such reference
 * pointing at the pre-redaction object — a leak that only shows up on whichever
 * host path keeps one. Copying leaves every identity in the tree untouched.
 *
 * On a structure mismatch the caller falls back to a normal redaction pass; a
 * partially applied tree is safe to hand to it, since every value written so
 * far is the redacted form of what was already there and rescanning is
 * idempotent over placeholders.
 */
function assignPinned(target: unknown, source: unknown): boolean {
  if (Array.isArray(target)) {
    if (!Array.isArray(source) || source.length !== target.length) return false
    for (let i = 0; i < target.length; i++) {
      const next = source[i]
      if (isContainer(target[i]) && isContainer(next)) {
        if (!assignPinned(target[i], next)) return false
      } else target[i] = next
    }
    return true
  }
  if (!isContainer(target) || !isContainer(source) || Array.isArray(source))
    return false
  const record = target as Record<string, unknown>
  const from = source as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== Object.keys(from).length) return false
  for (const key of keys) {
    if (!Object.hasOwn(from, key)) return false
    const next = from[key]
    if (isContainer(record[key]) && isContainer(next)) {
      if (!assignPinned(record[key], next)) return false
    } else record[key] = next
  }
  return true
}

/**
 * Apply a pinned snapshot to a live array. Returns false — for the caller to
 * redact normally — when the snapshot does not parse or does not line up, so a
 * corrupt or stale pin degrades to a re-scan rather than a wrong request.
 */
function applyPinnedArray(target: unknown[], snapshot: string): boolean {
  let next: unknown
  try {
    next = JSON.parse(snapshot)
  } catch {
    return false
  }
  return Array.isArray(next) && assignPinned(target, next)
}

function applyPinnedParts(parts: unknown, snapshot: string): boolean {
  return Array.isArray(parts) ? applyPinnedArray(parts, snapshot) : false
}

function applyPinnedSystem(system: string[], snapshot: string): boolean {
  return applyPinnedArray(system, snapshot)
}

export const RedactSecretsPlugin: Plugin = async ({
  client,
  directory,
  serverUrl,
}) => {
  const log = appLogger(client, SERVICE)

  const compat = await reportServerCompat({
    client,
    serverUrl,
    label: SERVICE,
    service: SERVICE,
    log,
  })
  if (compat?.disable) {
    // A non-v1 host disables redaction entirely. A merely untested v1 host runs
    // on — losing redaction on an incompatible host would be the worse failure.
    return {}
  }

  // Global paths, derived exactly as the host derives them (core/global.ts:
  // OPENCODE_CONFIG_DIR override, else xdg-basedir + "opencode"). Computed
  // from the environment on purpose: plugins load during instance bootstrap,
  // and an SDK call that needs the instance (client.path.get) deadlocks
  // startup — the e2e harness caught exactly that.
  const configDir =
    process.env.OPENCODE_CONFIG_DIR ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
  const dataDir = openCodeDataDir(process.env, homedir())
  const cacheDir = join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "opencode",
  )

  const options = await readFile(
    join(configDir, "redact-secrets.json"),
    "utf8",
  ).then(
    (text) => {
      try {
        return parseOptions(JSON.parse(text))
      } catch (error) {
        log("warn", `ignoring unparseable redact-secrets.json: ${error}`)
        return parseOptions(undefined)
      }
    },
    () => parseOptions(undefined),
  )

  // Per-installation key for placeholder fingerprints. Placeholders embed
  // HMAC-SHA256(key, secret) instead of a bare hash so they cannot serve as an
  // offline oracle (an observer of provider logs cannot test a guessed
  // low-entropy credential against a keyed hash) and cannot be correlated
  // across installations (every install keys differently). The key must be
  // STABLE across restarts — self-healing depends on the same secret
  // re-deriving the same placeholder — so it is minted once, stored locally
  // with 0600 perms, and reused. A lost key only costs the ability to restore
  // placeholders that were minted under the old one.
  const loadOrCreateHashKey = async (): Promise<string> => {
    const keyPath = join(dataDir, "redact-secrets.key")
    const isKey = (value: string): boolean => /^[0-9a-f]{64}$/i.test(value)
    const readKey = async (): Promise<string | undefined> => {
      try {
        const value = (await readFile(keyPath, "utf8")).trim()
        return isKey(value) ? value : undefined
      } catch {
        return undefined
      }
    }
    const existing = await readKey()
    if (existing) return existing
    const key = randomBytes(32).toString("hex")
    try {
      await mkdir(dataDir, { recursive: true })
      // wx fails when the path already exists: either another process just
      // won the create race (prefer its key, so both agree) or a corrupt key
      // file is squatting there and needs repair below.
      await writeFile(keyPath, key, { mode: 0o600, flag: "wx" })
      return key
    } catch {
      const raced = await readKey()
      if (raced) return raced
      // The file exists but holds no valid key (a truncated or interrupted
      // write). Left in place it would fail the wx create on EVERY start and
      // permanently downgrade the plugin to ephemeral keys — so it is
      // repaired, and repair must be SERIALIZED: with each repairer renaming
      // its own fresh key over the path, two concurrent boots could adopt
      // DIFFERENT keys — one reads the file between the two renames and keeps
      // a key the final file no longer holds (reproduced review finding), and
      // every placeholder it mints is unrecoverable after the next restart. A
      // wx-created lock file arbitrates: ONLY the lock holder may rewrite
      // keyPath, and it re-reads under the lock first, so a valid key, once
      // published, is never replaced — every process converges on the first
      // one written, whether it came from a repairer or from a concurrent
      // fresh boot's plain wx create. Losers poll for that key; a lock left
      // by a crashed repairer is stolen once its mtime goes stale.
      const lockPath = `${keyPath}.lock`
      const deadline = Date.now() + 3_000
      while (Date.now() < deadline) {
        let locked = false
        try {
          await writeFile(lockPath, String(process.pid), {
            mode: 0o600,
            flag: "wx",
          })
          locked = true
        } catch {
          try {
            const info = await stat(lockPath)
            if (Date.now() - info.mtimeMs > 10_000)
              await rm(lockPath, { force: true })
          } catch {
            // The holder released it between our wx and the stat; loop and
            // retry immediately.
          }
        }
        if (locked) {
          try {
            // Re-validate under the lock: another process may have published
            // a valid key since our read — never replace it.
            const current = await readKey()
            if (current) return current
            const tmpPath = `${keyPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
            try {
              await writeFile(tmpPath, key, { mode: 0o600, flag: "wx" })
              await rename(tmpPath, keyPath)
            } catch (error) {
              await rm(tmpPath, { force: true }).catch(() => {})
              throw error
            }
            return key
          } catch {
            break // unwritable data dir — fall through to the ephemeral warning
          } finally {
            await rm(lockPath, { force: true }).catch(() => {})
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
        const published = await readKey()
        if (published) return published
      }
      log(
        "warn",
        "could not persist placeholder key; placeholders minted this run will not survive a restart",
      )
      return key
    }
  }

  // Fingerprint catalog: the non-reversible (hash, ruleId, length) record of
  // every secret this install has ever vaulted — the restart half of the
  // exact-match defense. text.complete writes restored secrets back into
  // stored prose where they can sit WITHOUT the field context their detection
  // rule needs ("- x7k2…"); pre-restart the in-memory vault exact-matches
  // them, and post-restart only this catalog can (rule re-scanning cannot see
  // a contextless bare token). Nothing reversible is persisted: the 16-hex
  // keyed hash already rides inside every placeholder sent to providers, and
  // rule id + length are the only metadata disclosed (README, "What touches
  // disk"). Losing entries narrows recovery back to rules + env fingerprinting;
  // contextless values previously restored into prose may no longer be masked.
  const FINGERPRINT_LIMIT = 2048
  const fingerprintsPath = join(dataDir, "redact-secrets.fingerprints.json")
  const fingerprintCatalog = new Map<
    string,
    { ruleId: string; length: number }
  >()

  // Missing or unreadable catalogs seed no fingerprints. Rule detection still
  // runs, but cannot replace the lost context-free recovery.
  const readFingerprintFile = async (): Promise<FingerprintEntry[]> =>
    (await readJsonFile<FingerprintEntry[]>(
      fingerprintsPath,
      (value) => {
        const parsed = value as { entries?: unknown } | null
        if (!parsed || typeof parsed !== "object") return []
        if (!Array.isArray(parsed.entries)) return []
        return parsed.entries.filter(validFingerprintEntry)
      },
      { onMissing: () => [] },
    )) ?? []

  let persistedFingerprints = (await readFingerprintFile()).slice(
    -FINGERPRINT_LIMIT,
  )
  let fingerprintTimer: ReturnType<typeof setTimeout> | undefined
  const fingerprintWrites = createSerialQueue()
  let fingerprintWarned = false
  let fingerprintWriteFailed = false
  const persistFingerprints = (): Promise<void> => {
    if (fingerprintTimer) {
      clearTimeout(fingerprintTimer)
      fingerprintTimer = undefined
    }
    return fingerprintWrites.push(async () => {
      try {
        await mkdir(dataDir, { recursive: true })
        // Merge with the file first so a concurrent instance's entries are
        // carried forward instead of clobbered. Simultaneous renames can still
        // lose a batch until that instance's next write (README known gaps).
        const merged = new Map<string, { ruleId: string; length: number }>()
        for (const entry of await readFingerprintFile()) {
          merged.set(entry.hash, {
            ruleId: entry.ruleId,
            length: entry.length,
          })
        }
        for (const [hash, entry] of fingerprintCatalog) merged.set(hash, entry)
        const entries = [...merged]
          .slice(-FINGERPRINT_LIMIT)
          .map(([hash, entry]) => ({ hash, ...entry }))
        const tmpPath = `${fingerprintsPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
        try {
          await writeFile(tmpPath, JSON.stringify({ version: 1, entries }), {
            mode: 0o600,
            flag: "wx",
          })
          await rename(tmpPath, fingerprintsPath)
        } catch (error) {
          await rm(tmpPath, { force: true }).catch(() => {})
          throw error
        }
        // Only this exact snapshot reached disk. Registrations arriving during
        // the write belong to the next batch and cannot certify a restore yet.
        persistedFingerprints = entries
        fingerprintWriteFailed = false
      } catch (error) {
        fingerprintWriteFailed = true
        if (!fingerprintWarned) {
          fingerprintWarned = true
          log(
            "warn",
            `could not persist secret fingerprints; keeping completed text masked until persistence recovers: ${error}`,
          )
        }
      }
    })
  }

  for (const entry of persistedFingerprints) {
    fingerprintCatalog.set(entry.hash, {
      ruleId: entry.ruleId,
      length: entry.length,
    })
  }

  const redactor = new Redactor(
    options,
    await loadOrCreateHashKey(),
    (entry) => {
      const existing = fingerprintCatalog.get(entry.hash)
      if (
        existing &&
        existing.ruleId === entry.ruleId &&
        existing.length === entry.length
      )
        return
      fingerprintCatalog.set(entry.hash, {
        ruleId: entry.ruleId,
        length: entry.length,
      })
      // Insertion-order eviction: the catalog is a recency window, not an
      // archive — 2048 distinct secrets is far beyond any real session count.
      while (fingerprintCatalog.size > FINGERPRINT_LIMIT) {
        const oldest = fingerprintCatalog.keys().next().value
        if (oldest === undefined) break
        fingerprintCatalog.delete(oldest)
      }
      // Batch bursts, but keep the timer referenced so ordinary shutdown lets
      // the write finish. text.complete flushes it before restoring stored text.
      if (!fingerprintTimer)
        fingerprintTimer = setTimeout(() => void persistFingerprints(), 250)
    },
  )
  // Per-session record of surfaces this process already sent, so replayed
  // history is never re-redacted under a later rule set (HistoryPins). Lives
  // beside the redactor, not inside it: only the two chat transforms — the
  // surfaces whose bytes form the provider's cached prefix — pin. The wire
  // backstop, tool definitions, and every restore path keep scanning fresh.
  const pins = new HistoryPins()
  // Sessions whose NEXT `messages.transform` call belongs to compaction, set
  // by the `experimental.session.compacting` hook that immediately precedes
  // it. Compaction can route history to a different model than the session's
  // own, which no other signal on that hook reveals.
  //
  // Normally one entry, consumed microseconds later. Bounded anyway because a
  // compaction aborted between the two hooks leaves its flag behind, and the
  // stale flag costs only that session's next turn its pin — the safe
  // direction, but not one worth leaking session ids to hold.
  const compactionPending = new Set<string>()
  const markCompacting = (sessionID: string): void => {
    compactionPending.add(sessionID)
    for (const oldest of compactionPending) {
      if (compactionPending.size <= PIN_SCOPES) break
      compactionPending.delete(oldest)
    }
  }
  redactor.seedFingerprints(persistedFingerprints)

  // The native LLM runtime (OPENCODE_EXPERIMENTAL_NATIVE_LLM) routes supported
  // OpenAI/Anthropic/opencode requests straight through @opencode-ai/llm's
  // transport, which ignores a provider's `options.fetch` for everything except
  // an openai OAuth override (session/llm/native-runtime.ts:148-153). The
  // chat/system/tool transforms still cover ordinary turns and compaction, but
  // the wire backstop — the ONLY cover for title generation, MCP tool
  // definitions, and structured-output schemas (all verified to fire no other
  // hook) — is bypassed for those providers, widening the excluded-provider gap
  // to every native-eligible one. No plugin-installed fetch can reach that
  // transport, so the honest response is to surface the degradation loudly
  // rather than let the user assume the backstop still holds.
  if (
    options.wireBackstop &&
    runtimeFlagEnabled(process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM)
  ) {
    const message =
      "wire backstop is bypassed while OPENCODE_EXPERIMENTAL_NATIVE_LLM is set: the native LLM transport ignores " +
      "the provider fetch wrapper for OpenAI/Anthropic/opencode models, so title generation, MCP tool definitions, " +
      "and structured-output schemas can leak secrets to those providers. Chat and compaction turns stay covered. " +
      "See the README known gaps."
    if (!log("warn", message, { nativeLlm: true })) {
      try {
        console.warn(`${SERVICE}: ${message}`)
      } catch {
        // A missing logger must not turn a warning into a crash.
      }
    }
  }

  // Disabling restoreText is a legitimate opt-out (no raw value is ever
  // written back into the stored transcript), but it quietly narrows restart
  // recovery: compaction summaries then keep placeholders instead of raw
  // values, so once compaction has erased the transcript's raw copies and the
  // process restarts, only fingerprint recovery (shell env + project env
  // files) can resolve a placeholder — one whose secret lives nowhere in
  // those sources reaches its tool call as a literal placeholder and fails
  // visibly. Restoring summaries anyway would defeat the option, so the
  // trade-off is surfaced here instead of silently overridden.
  if (!options.restoreText) {
    log(
      "warn",
      "restoreText is disabled: stored text (compaction summaries included) keeps placeholders, so after " +
        "compaction plus a restart, placeholders resolve only via env/env-file fingerprint recovery. " +
        "A secret absent from those sources will reach tools as a literal placeholder.",
      { restoreText: false },
    )
  }

  const toast = serverToast(client, { directory, title: "Secrets redacted" })
  let toasted = false
  const noteRedactions = (count: number, where: string) => {
    if (count <= 0) return
    log(
      "info",
      `replaced ${count} secret value(s) with placeholders in ${where}`,
      { vault: redactor.vaultSize },
    )
    if (toasted) return
    toasted = true
    // Headless hosts have no TUI; the log line above still tells the story.
    toast("info", "Detected secret values were masked before leaving OpenCode.")
  }

  // Auth methods that install their own provider fetch (OAuth loaders, Codex
  // websockets) must not be clobbered — see the header. The library's reader
  // mirrors the host's Auth.all (auth/index.ts:58-67) on all three axes, and
  // all three matter here:
  //   - inline OPENCODE_AUTH_CONTENT wins when set and parseable, and is
  //     returned RAW — the host does not schema-filter inline auth (lines
  //     59-63), so neither does the reader (control-plane workspaces inject
  //     auth this way with no auth.json on disk); unparseable inline JSON
  //     falls through to the file exactly like the host;
  //   - the auth.json file is decoded per-entry, dropping every entry the
  //     Info schema would reject (line 66) — so a stale {type:"oauth"} with no
  //     tokens no longer masquerades as an oauth provider and wrongly excludes
  //     an api-key-served provider from the backstop;
  //   - a missing OR unparseable file degrades to an EMPTY store (line 65's
  //     orElseSucceed(() => ({}))), NOT to a disabled backstop: an empty store
  //     is one the host also sees, so no loader installed a fetch to clobber,
  //     and wrapping every eligible provider is both safe and more protective
  //     than standing down globally.
  // Env-derived, never asked of the server: this runs in the config hook,
  // where an SDK call that needs the instance deadlocks bootstrap.
  const readAuthRecord = (): Promise<unknown> =>
    readAuthStore({ env: process.env, homedir: homedir() })

  // Fingerprint recovery: a placeholder embeds HMAC-SHA256(installKey, secret),
  // so a hash the
  // in-memory vault has never seen (compaction erased the raw copy, then the
  // process restarted) can be re-derived by rescanning where stray secrets
  // live — the shell environment and the project's env files — and letting
  // the vault verify candidates against the hash. Attempted once per unknown
  // hash; the sources are cheap, local, and never written anywhere.
  //
  // The set is bounded (audit L-RS1), and — unlike the vault maps, which must
  // never evict — evicting here is provably harmless: an entry only dedupes
  // WORK (the env/env-file rescan), so dropping the oldest re-permits one
  // bounded rescan for that hash and can never lose a mapping or forward
  // anything raw. Unknown hashes are content-controlled (any tool output can
  // embed placeholder-shaped strings), which is exactly why an unbounded
  // memo is the wrong shape.
  const ATTEMPTED_RECOVERY_LIMIT = 4096
  const attemptedRecovery = new Set<string>()
  const recoverUnknown = async (
    missing: ReadonlySet<string>,
  ): Promise<boolean> => {
    const fresh = [...missing].filter((hash) => !attemptedRecovery.has(hash))
    if (fresh.length === 0) return false
    for (const hash of fresh) {
      attemptedRecovery.add(hash)
      for (const oldest of attemptedRecovery) {
        if (attemptedRecovery.size <= ATTEMPTED_RECOVERY_LIMIT) break
        attemptedRecovery.delete(oldest)
      }
    }
    // KEY=value lines so keyword-context rules see the variable name.
    const envText = Object.entries(process.env)
      .map(([key, value]) => `${key}=${value ?? ""}`)
      .join("\n")
    redactor.learnFrom(envText)
    for (const name of ENV_FILE_CANDIDATES) {
      const file = join(directory, name)
      try {
        // Bound the work BEFORE reading: skip non-regular files (a fifo or
        // device would block readFile indefinitely) and anything past the cap,
        // rather than pulling an unbounded .env fully into memory just to
        // measure it afterward.
        const info = await stat(file)
        if (!info.isFile() || info.size > MAX_RECOVERY_FILE_BYTES) continue
        redactor.learnFrom(await readFile(file, "utf8"))
      } catch {
        // Missing or unreadable env files are the normal case.
      }
    }
    return true
  }

  const restoreWithRecovery = async (
    value: unknown,
    where: string,
  ): Promise<number> => {
    const missing = redactor.collectUnresolved(value)
    if (missing.size > 0 && (await recoverUnknown(missing))) {
      const still = redactor.collectUnresolved(value)
      const recovered = missing.size - still.size
      if (recovered > 0)
        log(
          "info",
          `recovered ${recovered} placeholder mapping(s) from local sources`,
        )
      if (still.size > 0) {
        log(
          "warn",
          `${still.size} placeholder(s) in ${where} could not be resolved and will pass through verbatim`,
        )
      }
    }
    return redactor.restoreValueInPlace(value)
  }

  // Body handling (string, bytes, Blob, stream, Request-held — and the
  // fail-closed cases) lives in redactWireRequest; see its header for the
  // per-shape policy (audit L-RS3).
  const wrapProviderFetch = (
    inner: unknown,
  ): ((input: unknown, init?: RequestInit) => Promise<Response>) => {
    const innerFetch =
      typeof inner === "function" ? (inner as typeof fetch) : fetch
    return async (input: unknown, init?: RequestInit) => {
      const inspected = await redactWireRequest(redactor, input, init)
      if (inspected.redacted)
        noteRedactions(1, "a provider request body (wire backstop)")
      return innerFetch(
        inspected.input as Parameters<typeof fetch>[0],
        inspected.init,
      )
    }
  }

  // The models.dev snapshot, read the way the host reads it from disk
  // (core/models-dev.ts:139-172): the OPENCODE_MODELS_PATH flag overrides,
  // else the models.json cache the host itself maintains. A custom
  // OPENCODE_MODELS_URL writes a hash-named cache file this plugin cannot
  // name, and a first-ever run has no snapshot yet — both degrade the wire
  // backstop to config-listed providers only.
  const readCatalogSnapshot = async (): Promise<unknown> => {
    const file =
      process.env.OPENCODE_MODELS_PATH || join(cacheDir, "models.json")
    try {
      return JSON.parse(await readFile(file, "utf8"))
    } catch {
      return undefined
    }
  }

  // Source consumers may shorten or reshape the request before any chat hook.
  // Note the COMPLETE snapshot before walking it, so later sources and field
  // names gate earlier values too. These are fresh disclosures, never history
  // pins; use the same configured live engine and vault as the outbound hooks.
  const releaseSourceRedactor = registerSourceRedactor(
    { serverUrl, directory },
    (value) => {
      try {
        redactor.noteScanContextCached(JSON.stringify(value))
        noteRedactions(redactor.redactValueInPlace(value), "request sources")
      } catch (error) {
        // Even error names can contain source text; log only known categories.
        const category =
          error instanceof WalkLimitError
            ? "WalkLimitError"
            : error instanceof VaultLimitError
              ? "VaultLimitError"
              : error instanceof FingerprintLimitError
                ? "FingerprintLimitError"
                : "unexpected error"
        log("warn", `source redaction failed (${category})`)
        throw error
      }
    },
  )

  return {
    dispose: async () => {
      releaseSourceRedactor()
    },

    config: async (config) => {
      const cfg = config as {
        agent?: Record<string, { description?: unknown } | undefined>
        provider?: Record<string, { options?: Record<string, unknown> }>
        disabled_providers?: string[]
        enabled_providers?: string[]
      }

      // Agent descriptions reach the wire OUTSIDE every message-level hook:
      // the host fires tool.definition and only THEN appends describeTask's
      // "- name: description" lines to the Task tool (registry.ts:313 vs
      // :320-326), so a credential pasted into an agent's description would
      // leak on providers the wire backstop cannot cover (OAuth-owned fetch,
      // never-wrap loaders, the native runtime). This config object is the
      // same cached instance Agent state later builds from (agent.ts:267-294
      // reads cfg.agent, and markdown agents are merged into it at load,
      // config.ts:460-461), so redacting here covers config- and
      // markdown-defined agents on every provider, before any request
      // exists. Agent NAMES are left alone deliberately: they are invocation
      // identifiers — renaming one to a placeholder would break Task calls
      // once tool.execute.before restores the raw name the host no longer
      // knows. Prompts need nothing here: an agent prompt becomes the child
      // session's system text, which chat.system.transform already redacts.
      const before = redactor.redactionCount
      const agents = Object.entries(cfg.agent ?? {})
      // All agents land in the SAME Task-tool description as "- name:
      // description" lines, so names and descriptions share one keyword gate
      // (noteScanContext) — noted together before any description is scanned.
      // NAMES carry gate signal too: an agent called "facebook-agent" puts
      // that vendor's keyword on the wire for every line in the list, so it
      // must gate those rules here at the source as well.
      for (const [name, agent] of agents) {
        redactor.noteScanContext(name)
        if (agent && typeof agent.description === "string")
          redactor.noteScanContext(agent.description)
      }
      for (const [name, agent] of agents) {
        if (agent && typeof agent.description === "string") {
          // The assembled line puts the name ADJACENT to its description
          // ("- facebook-agent: <token>"), which keyword-adjacency rules
          // (generic-api-key) match on the wire — so the description is
          // scanned under its name as field context, mirroring that line at
          // the source. The name itself stays unredacted (see above).
          agent.description = redactor.redactStringUnderKey(
            name,
            agent.description,
          )
        }
      }
      noteRedactions(redactor.redactionCount - before, "agent descriptions")

      if (!options.wireBackstop) return
      const authStore = await readAuthRecord()
      const unsafe = unsafeWireProviders(authStore)
      // The Codex auth loader runs for ANY openai auth entry, and when the
      // host's websocket rollout is live it installs a pooled websocket fetch
      // even for plain api-key auth (plugin/openai/codex.ts:314-323) — one
      // more fetch this hook must not clobber. Rollout detection mirrors
      // experimentalWebSocketsEnabled (plugin/index.ts:60-62) minus its
      // channel half: local/dev/beta builds carry version strings ("local",
      // "0.0.0-<channel>-<timestamp>") that already fail this plugin's
      // version gate, so only the runtime flag can matter here.
      const websocketsLive = runtimeFlagEnabled(
        process.env.OPENCODE_EXPERIMENTAL_WEBSOCKETS,
      )
      const disabledProviders = new Set(
        Array.isArray(cfg.disabled_providers) ? cfg.disabled_providers : [],
      )
      const enabledProviders = Array.isArray(cfg.enabled_providers)
        ? new Set(cfg.enabled_providers)
        : undefined
      const skip = (providerID: string): boolean =>
        unsafe.has(providerID) ||
        options.wireSkipProviders.has(providerID) ||
        disabledProviders.has(providerID) ||
        (enabledProviders !== undefined && !enabledProviders.has(providerID)) ||
        (providerID === "openai" &&
          websocketsLive &&
          hasAuthEntry(authStore, "openai"))

      // Providers the host activates with no config entry (catalog providers
      // with a set env key or an api-key auth entry) get a minimal entry
      // injected so their requests — title generation above all — pass the
      // backstop too. The wrap itself happens in the uniform loop below.
      const catalog = await readCatalogSnapshot()
      if (catalog) {
        for (const providerID of catalogWireCandidates(
          catalog,
          process.env,
          authStore,
        )) {
          if (skip(providerID) || cfg.provider?.[providerID]) continue
          cfg.provider ??= {}
          cfg.provider[providerID] = { options: {} }
        }
      } else {
        log(
          "warn",
          "wire backstop: no models.dev snapshot readable; providers loaded purely from auth or env keys stay unwrapped",
        )
      }

      for (const [providerID, entry] of Object.entries(cfg.provider ?? {})) {
        if (!entry || typeof entry !== "object") continue
        if (skip(providerID)) continue
        entry.options ??= {}
        const providerOptions: Record<string, unknown> = entry.options
        providerOptions.fetch = wrapProviderFetch(providerOptions.fetch)
      }
    },

    // Primary outbound layer: parts here are fresh per-request copies
    // (verified: prompt.ts hydrates new objects from the DB every turn and
    // nothing writes them back), so in-place mutation is safe and reaches
    // every provider, transport, and the compaction summarizer.
    "experimental.chat.messages.transform": async (_input, output) => {
      // Keyword gates span the whole outbound request, not one part: the
      // provider reads every part of every message as one document, so a rule
      // keyword in one part ("facebook token follows") must gate rules in a
      // SIBLING part holding only the bare token — scanning each part with
      // only its own keywords reproducibly leaked that pair on providers the
      // wire backstop cannot cover. Every message is noted before any part is
      // scanned (a LATER part's keyword must cover an EARLIER part's token).
      // Serialization is an over-approximation of the wire-bound strings (it
      // includes structural keys and skipped payloads), which can only gate
      // in extra rules whose regexes still have to match — the
      // fail-toward-redaction direction.
      //
      // Noted PER MESSAGE through the digest gate (audit M7): history
      // messages re-hydrate to identical bytes every request, so each pays
      // its keyword sweep once — only new or changed messages (the current
      // turn, a tool part whose state advanced, compaction-replaced history)
      // are swept — where noting the transcript as one string re-swept all
      // of it every turn. Splitting on messages loses no keyword: an
      // occurrence spanning two messages in the old whole-array note would
      // have to contain the `,`/`[`/`]` serialization glue, and no rule
      // keyword does (vendor-guarded in rules.test.ts).
      // Provider-issued opaque payloads (encrypted reasoning, signatures) are
      // dropped from the SWEEP only — serializeForKeywordSweep explains why a
      // ciphertext blob must not be allowed to turn a rule on for the whole
      // process. Redaction below still walks them in full.
      for (const message of output.messages) {
        // A non-serializable message (never observed: parts are DB-hydrated
        // JSON) falls back to per-string keyword gating — and no longer costs
        // the OTHER messages their notes, as the single whole-array stringify
        // did.
        const serialized = serializeForKeywordSweep(message)
        if (serialized) redactor.noteScanContextCached(serialized)
      }
      // The destination this batch is bound for, and whether pinning applies
      // to it at all. Compaction routes a session's history to a model this
      // hook cannot see, so the `experimental.session.compacting` hook flags
      // that session and pinning is skipped for the one call that follows —
      // the safe direction: the history is redacted under the full current
      // rule set, and a one-shot summarization request has no prefix cache
      // worth protecting anyway. Every message in a batch carries the same
      // session, so the flag is read and cleared once.
      const batchScope = output.messages
        .map((message) => messageScope(message))
        .find((scope) => scope !== undefined)
      const compacting =
        batchScope !== undefined && compactionPending.delete(batchScope)
      const destination =
        options.stableHistory && !compacting
          ? messagesDestination(output.messages)
          : undefined
      let count = 0
      for (const message of output.messages) {
        // Pinned per session AND destination on the PRE-redaction bytes, so a
        // replayed history message returns the decision this session already
        // sent to this provider and the prompt prefix stays byte-stable
        // (HistoryPins). A message the pin has never seen — a new turn, an
        // advanced tool part, compaction-replaced history — misses and is
        // redacted under the full current rule set.
        const scope = messageScope(message)
        const before =
          destination !== undefined && scope !== undefined
            ? serializeParts(message.parts)
            : undefined
        const key = before === undefined ? undefined : `${destination} ${before}`
        if (key !== undefined) {
          const pinned = pins.get(scope as string, key)
          if (pinned && applyPinnedParts(message.parts, pinned.output)) {
            count += pinned.count
            continue
          }
        }
        const applied = redactor.redactPartsInPlace(message.parts)
        count += applied
        if (key !== undefined) {
          const after = serializeParts(message.parts)
          if (after !== undefined)
            pins.set(scope as string, key, { output: after, count: applied })
        }
      }
      noteRedactions(count, "chat messages")
    },

    "experimental.chat.system.transform": async (input, output) => {
      // Same cross-string keyword contract as messages.transform: all system
      // entries land in one request. The host fires messages.transform BEFORE
      // this hook in each request cycle (prompt.ts:1255 → llm/request.ts:70),
      // so message keywords cover system entries within the SAME request; a
      // keyword living only in system text covers message parts from the next
      // request on (the note is sticky and flushes the scan cache, so history
      // parts rescan under it). The residual — a system-only keyword plus a
      // bare token in a message part on the very first request of a process —
      // is accepted and documented. Digest-gated (audit M7): the assembled
      // system prompt is identical across a session's requests, so it pays
      // its sweep once; any changed assembly re-notes.
      redactor.noteScanContextCached(
        output.system.filter((entry) => typeof entry === "string").join("\n"),
      )
      // Pinned like message parts: the system prompt is the CHEAPEST prefix
      // bytes in the request and the ones every later byte's cache hit depends
      // on, so a rule gated in mid-session must not be able to rewrite it and
      // cost the session its entire prefix. Keyed on the joined pre-redaction
      // entries AND the destination model this hook is handed; a changed
      // assembly (a refreshed memory snapshot, a new skill) or a switched
      // model misses and is redacted afresh. The agent-prompt call site
      // (agent.ts:381) passes no sessionID and so never pins.
      const destination = destinationKey(input.model)
      const scope =
        options.stableHistory && destination !== undefined
          ? input.sessionID
          : undefined
      const before = scope
        ? `${destination} ${JSON.stringify(output.system)}`
        : undefined
      const pinned =
        before === undefined ? undefined : pins.get(scope as string, before)
      const restored =
        pinned === undefined
          ? false
          : applyPinnedSystem(output.system, pinned.output)
      if (!restored) {
        for (let i = 0; i < output.system.length; i++) {
          const entry = output.system[i]
          if (typeof entry === "string")
            output.system[i] = redactor.redactString(entry)
        }
        if (before !== undefined)
          pins.set(scope as string, before, {
            output: JSON.stringify(output.system),
            count: 0,
          })
      }
      if (options.systemNote) output.system.push(SYSTEM_NOTE)
    },

    // Tool definitions (descriptions and JSON schemas) are serialized into
    // every model request alongside the messages, and this hook is the ONLY
    // pre-request surface the host offers for them — it fires per tool from
    // ToolRegistry.tools (registry.ts:313), covering built-in and
    // plugin-registered tools. Two things it does NOT see: the agent list the
    // host appends to the Task tool AFTER this hook returns (registry.ts:
    // 320-326 — covered at the source by the config hook's agent-description
    // redaction above), and MCP server tools / the StructuredOutput schema,
    // which never pass through it (session/tools.ts:390-489 adds MCP tools
    // directly; prompt.ts:1244 builds StructuredOutput inline) — for those
    // the wire backstop is the only cover, a documented gap on
    // backstop-excluded providers (README, "Known gaps").
    "tool.definition": async (input, output) => {
      const before = redactor.redactionCount
      const toolID =
        typeof input?.toolID === "string" ? input.toolID : undefined
      // Definitions ride every request alongside the messages, so their
      // keywords join the same cross-string gate (noteScanContext) — a vendor
      // name in a tool description ("Post to the Facebook Graph API") must
      // gate that vendor's rules in a message part holding only the bare
      // token. The tool's ID is serialized right beside them and carries the
      // same signal (a tool NAMED "facebook"), so it is noted too. Noted
      // before this definition's own strings are scanned, so a keyword in the
      // ID or schema covers a token in the description too. Ordering ACROSS
      // definitions is registry order: a keyword living only in a LATER
      // tool's definition covers an earlier tool's token from the next
      // request on (the note is sticky and flushes the scan cache, and this
      // hook re-fires per request) — the same first-request-of-a-process
      // residual documented at system.transform.
      const schema = (output as { jsonSchema?: unknown }).jsonSchema
      try {
        // Digest-gated (audit M7): the hook re-fires per request with the
        // same definition bytes, so each tool pays its sweep once until its
        // definition actually changes.
        redactor.noteScanContextCached(
          `${toolID ?? ""}\n${output.description ?? ""}\n${JSON.stringify(schema) ?? ""}`,
        )
      } catch {
        // JSON.stringify rejected the schema (a cycle, a BigInt) — the host
        // cannot serialize it into a request either, so there is no wire
        // form to take keywords from. Swallowing is safe ONLY because the
        // schema block below still fails such a request closed.
      }
      // The wire form places the ID adjacent to the description
      // ({"name":"facebook","description":…}), so the description is scanned
      // under the ID as field context; the ID itself is never rewritten (it
      // is the tool's invocation name — same rule as agent names above).
      if (typeof output.description === "string") {
        output.description = redactor.redactStringUnderKey(
          toolID,
          output.description,
        )
      }
      // The schema on the hook payload is a REFERENCE into the registry's
      // cached tool definition — never mutate it in place. Redact a clone and
      // swap the whole field: a replaced jsonSchema is exactly what the host
      // keeps (registry.ts:314-317) and what it serializes
      // (ToolJsonSchema.fromTool prefers jsonSchema). `parameters` is left
      // alone on purpose — on every tool shape it is an Effect Schema full of
      // functions whose serialized form comes FROM jsonSchema.
      //
      // This block must FAIL CLOSED (audit M10 — it was the plugin's one
      // fail-open path): a clone failure falls back to the wire-visible JSON
      // form, a serialization failure throws (wireVisibleSchemaClone), and
      // the redaction walk itself runs under NO catch, so a WalkLimitError
      // from a cyclic or pathologically deep schema aborts the request
      // (Plugin.trigger runs hooks via Effect.promise — a rejection is a
      // defect that kills tool assembly before any request exists). The
      // original schema is never forwarded after a failure — and never after
      // a SUCCESS either: the scanned snapshot is always swapped in, even
      // when the scan found nothing. Retaining the original because its
      // clone looked clean reopened the gap sideways — what was SCANNED (the
      // clone's plain data) and what the host SERIALIZES (the original, its
      // prototype chain and toJSON live) can diverge: structuredClone strips
      // an inherited toJSON that would emit a secret on the wire, a
      // key-sensitive toJSON(key) can answer the top-level JSON probe ("")
      // clean and the host's serialization under a real property name with a
      // secret, and a getter can simply return a different value on its
      // second read. Swapping pins the wire form to the exact bytes that
      // were scanned.
      if (schema && typeof schema === "object") {
        let clone: unknown
        try {
          clone = structuredClone(schema)
        } catch {
          // Not structured-cloneable does NOT mean not wire-visible: JSON
          // serialization drops the offending function or symbol silently
          // and keeps every serializable sibling, secrets included.
          clone = wireVisibleSchemaClone(schema, toolID)
        }
        if (clone && typeof clone === "object") {
          // The ID is the schema's enclosing name on the wire, so it is the
          // walk's root context — a top-level default under a keyword-bearing
          // ID scans like the flat "id=value" line, bounded by the same
          // one-level inheritance as any walked key.
          redactor.redactValueInPlace(clone, toolID ? [toolID] : [])
          ;(output as { jsonSchema?: unknown }).jsonSchema = clone
        } else if (typeof clone === "string") {
          // A toJSON collapsed the schema to a bare string; scan it like any
          // other wire-bound string, under the tool's ID. Even an empty
          // string pins the wire form (the host's fromTool passes any
          // non-nullish jsonSchema through).
          ;(output as { jsonSchema?: unknown }).jsonSchema =
            redactor.redactStringUnderKey(toolID, clone)
        } else if (clone !== undefined && clone !== null) {
          // A number or boolean: nothing to scan, but it still pins.
          ;(output as { jsonSchema?: unknown }).jsonSchema = clone
        } else {
          // A nullish snapshot cannot pin anything: the host's fromTool falls
          // back past a nullish jsonSchema to serializing `parameters`
          // (json-schema.ts:25, `??` — verified 1.17.18 and 1.18.3), a form
          // no layer ever scans. Abort closed instead.
          throw new Error(
            `${SERVICE}: the JSON schema of tool "${toolID ?? "<unknown>"}" serialized to nothing; ` +
              "aborting the request rather than letting the host forward an unscanned schema",
          )
        }
      }
      noteRedactions(redactor.redactionCount - before, "a tool definition")
    },

    // Ask the summarizer to carry every live placeholder into the summary.
    // The summary streams through the same processor as chat turns, so the
    // text.complete hook below restores those placeholders into the STORED
    // summary when a cold scan proves it can re-mask the result. Otherwise
    // placeholders survive, with tool restoration still available in-process
    // (or via env recovery after a restart).
    //
    // Also the only warning that the NEXT `messages.transform` call belongs to
    // compaction (session/compaction.ts:341 → :350), which may route this
    // session's history to a different model than the session's own — see the
    // pinning block in that hook.
    //
    // The note push stays on the shared helper — it is still byte-identical to
    // memory's compacting hook; only the pin bookkeeping is this plugin's own.
    "experimental.session.compacting": async (input, output) => {
      await pushCompactionNote(input, output)
      if (typeof input?.sessionID === "string" && input.sessionID)
        markCompacting(input.sessionID)
    },

    // The two things pinning needs from the host that no transform reports:
    // whether a request actually reached the provider, and when a session's
    // pins may be released.
    //
    // DELIVERY. Both transforms run before request construction and transport,
    // so a decision committed there would treat an attempt that failed or was
    // cancelled as "already sent" — and suppress, on the retry, a detection
    // that had become available in between. A pin is therefore created
    // undelivered and promoted only here, on an assistant-only part appearing
    // for that session: the provider answered, so the bytes went. The cost of
    // this signal never arriving is that pinning degrades to no pinning, which
    // is the pre-PR behavior and the safe direction.
    //
    // RELEASE. Pins outlive their session otherwise, held until 64 newer ones
    // evict them.
    event: async (input) => {
      const event = input?.event as
        | { type?: unknown; properties?: Record<string, unknown> }
        | undefined
      if (event?.type === "message.part.updated") {
        const part = event.properties?.part as
          | { type?: unknown; sessionID?: unknown }
          | undefined
        if (
          typeof part?.type === "string" &&
          ASSISTANT_PROGRESS_PARTS.has(part.type) &&
          typeof part.sessionID === "string" &&
          part.sessionID
        )
          pins.markDelivered(part.sessionID)
        return
      }
      if (event?.type === "session.deleted") {
        const id = (event.properties?.info as { id?: unknown } | undefined)?.id
        if (typeof id === "string" && id) {
          pins.forget(id)
          compactionPending.delete(id)
        }
      }
    },

    // Inbound: restore placeholders the model echoed into its prose (chat
    // turns and compaction summaries alike). The host writes this text back
    // into the stored part. Never persist a restored form that only the LIVE
    // vault can re-mask: that would expose it after a restart.
    "experimental.text.complete": async (_input, output) => {
      // The opt-out covers summaries too — deliberately. Restoring ONLY
      // summaries would write raw secrets into stored text against the
      // option's whole purpose; the restart-recovery cost of leaving them
      // masked is documented on RedactOptions and warned about at startup.
      if (!options.restoreText) return
      const missing = redactor.collectUnresolved(output.text)
      if (missing.size > 0) await recoverUnknown(missing)
      // Publishing raw prose must not race the debounce or an in-flight write.
      // Retry failures here too: recovery must not need a brand-new secret.
      if (fingerprintTimer || fingerprintWriteFailed)
        await persistFingerprints()
      else await fingerprintWrites.drain()
      if (fingerprintWriteFailed) return
      output.text = redactor.restoreText(output.text, persistedFingerprints)
    },

    // Inbound: restore placeholders inside tool arguments, in place, on the
    // exact object the tool executes with. The transcript's recorded call
    // keeps the placeholder (the processor stores tool input independently).
    "tool.execute.before": async (_input, output) => {
      const args = (output as { args?: unknown }).args
      if (args && typeof args === "object") {
        const count = await restoreWithRecovery(args, "tool arguments")
        if (count > 0)
          log("info", `restored ${count} placeholder(s) in tool arguments`)
      }
    },
  }
}

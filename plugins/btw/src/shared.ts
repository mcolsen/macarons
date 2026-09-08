import { setTimeout as delay } from "node:timers/promises"
import {
  keybindOption,
  mintMessageID,
  parseModelRef,
  unwrap,
  wildcardMatch,
  withTimeout,
} from "@macarons/permission-rules"
import type {
  OpencodeClient,
  PermissionRuleset,
  Session,
} from "@opencode-ai/sdk/v2"

/**
 * @macarons/btw — shared core
 *
 * The mechanics of a "side question": fork the current session at the last
 * completed turn, ask the question in the fork with the same agent/model (so
 * the provider request is prefix-identical to the parent's and served from
 * cache), stream the answer, and delete the fork afterwards. Nothing is ever
 * added to the parent session, and because forks run on their own session
 * runner, all of it works while the parent is actively inferring.
 *
 * Everything here is driven through the v2 SDK client so the TUI half and the
 * E2E suite exercise the exact same code path.
 *
 * Cache-safety rules encoded below (verified against OpenCode 1.17.18):
 *   - The side-question instructions ride in the USER message, never in the
 *     prompt's `system` field — `system` is joined into the system message and
 *     would change the request prefix from token zero.
 *   - Added tool guards use session "ask" rules (+ instant auto-deny by the
 *     plugin), not blanket "deny" rules or the deprecated `tools` map. Parent
 *     read/glob restrictions are preserved; path-specific denies do not remove
 *     tools from the request or change the provider's cached prefix.
 *   - The fork is prompted with the parent's agent, model, and variant, read
 *     from the parent session info at ask time.
 */

// The verified band is centralized in the shared library and rides the repo's
// OpenCode pin (.opencode-version) — the policy comment lives there. The host
// surfaces this package leans on: session fork, the v2 SDK surface, and the
// TUI plugin API.
export {
  openCodeCompatNotice,
  replaceLargeDialog,
  reportTuiCompat,
  SUPPORTED_OPENCODE_RANGE,
  trim,
  tuiGate,
} from "@macarons/permission-rules"

export type ToolsMode = "read-only" | "none"

export type ResolvedOptions = {
  /** Comma-separated keybind alternatives for the ask command; undefined disables the binding. */
  keybind: string | undefined
  /** Key for "open side answer as full session" while one is on screen. */
  openKeybind: string | undefined
  /** Key for "copy side answer" while one is on screen. */
  copyKeybind: string | undefined
  /** Toast when an answer finishes while its panel is not on screen. */
  notify: boolean
  /** Pin a model ("provider/model") instead of the parent session's. Costs the cache hit. */
  model: { providerID: string; modelID: string } | undefined
  /** Variant (reasoning-effort) override for side questions. */
  variant: string | undefined
  tools: ToolsMode
  /** Abort a side question that has not completed after this long. */
  timeoutMs: number
  /** Keep forked side-question sessions instead of deleting them on dismiss. */
  keepSessions: boolean
}

export const DEFAULT_KEYBIND = "<leader>w,ctrl+alt+w"
// Deliberately NOT ctrl+o (persist-permissions binds it globally; its dialog
// would replace ours) and not any key the managed textarea claims while
// focused (ctrl+a/b/d/e/f/k/n/p/u/w...). Plain ctrl+l and ctrl+y are unused
// by OpenCode's default keymap.
export const DEFAULT_OPEN_KEYBIND = "ctrl+l"
export const DEFAULT_COPY_KEYBIND = "ctrl+y"
export const DEFAULT_TIMEOUT_MS = 180_000

export function resolveOptions(raw: unknown): ResolvedOptions {
  const options = (raw ?? {}) as Record<string, unknown>
  return {
    keybind: keybindOption(options.keybind, DEFAULT_KEYBIND),
    openKeybind: keybindOption(options.openKeybind, DEFAULT_OPEN_KEYBIND),
    copyKeybind: keybindOption(options.copyKeybind, DEFAULT_COPY_KEYBIND),
    notify: options.notify !== false,
    model: parseModelRef(options.model),
    variant:
      typeof options.variant === "string" && options.variant.trim()
        ? options.variant.trim()
        : undefined,
    tools: options.tools === "none" ? "none" : "read-only",
    timeoutMs:
      typeof options.timeoutMs === "number" &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS,
    keepSessions: options.keepSessions === true,
  }
}

// ---------------------------------------------------------------------------
// Session marker
//
// Forked side-question sessions carry this metadata so (a) the server half
// can recognize them in chat.params / permission.asked, (b) leftover forks
// from a crashed TUI can be swept on a later start, and (c) nothing else is
// ever mistaken for one — sweeping deletes sessions, so identification must
// be explicit, never heuristic (a title is not a marker). Session metadata
// is an arbitrary shared record, so the marker defends itself: a namespaced
// key nothing else would collide with, an exact version, and full-shape
// validation — markerOf rejects anything this code did not write, instead of
// defaulting missing fields on someone else's metadata.
//
// The lease is what makes sweeping safe across OpenCode instances: the TUI
// that owns a fork rewrites the marker with a fresh lease every
// LEASE_INTERVAL_MS, so a marker whose lease has not moved for LEASE_STALE_MS
// is provably unowned crash debris — not a live side question belonging to
// another TUI on the same project.
// ---------------------------------------------------------------------------

export const MARKER_KEY = "@macarons/btw"
const LEGACY_MARKER_KEY = "@mcolsen-opencode/btw"
export const MARKER_VERSION = 1

/** How often the owning TUI refreshes a live fork's lease. */
export const LEASE_INTERVAL_MS = 30_000
/** A lease this old means no running TUI owns the fork; many missed beats of slack. */
export const LEASE_STALE_MS = 5 * 60_000

export type Marker = {
  /** Session the side question forked from. */
  parent: string
  tools: ToolsMode
  created: number
  /** Last owner heartbeat; sweeps may only reclaim markers whose lease went stale. */
  lease: number
}

export function markerFor(marker: Marker): Record<string, unknown> {
  const value = { version: MARKER_VERSION, ...marker }
  // Keep this OpenCode-v1 bridge until pre-Macarons sessions and independently
  // upgraded server/TUI halves are explicitly unsupported, normally when this
  // v1 implementation retires. Session metadata has no retention cutoff, and
  // file/copy installs provide no enforceable minimum Macarons version.
  return { [MARKER_KEY]: value, [LEGACY_MARKER_KEY]: value }
}

export function markerOf(metadata: unknown): Marker | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const record = metadata as Record<string, unknown>
  const value = record[MARKER_KEY] ?? record[LEGACY_MARKER_KEY]
  if (!value || typeof value !== "object") return undefined
  const marker = value as Record<string, unknown>
  if (marker.version !== MARKER_VERSION) return undefined
  if (typeof marker.parent !== "string" || !marker.parent) return undefined
  if (marker.tools !== "read-only" && marker.tools !== "none") return undefined
  if (typeof marker.created !== "number" || !Number.isFinite(marker.created))
    return undefined
  if (typeof marker.lease !== "number" || !Number.isFinite(marker.lease))
    return undefined
  return {
    parent: marker.parent,
    tools: marker.tools,
    created: marker.created,
    lease: marker.lease,
  }
}

// ---------------------------------------------------------------------------
// Fork boundary
// ---------------------------------------------------------------------------

export type MessageInfoLike = {
  id: string
  role: string
  time?: { created?: number; completed?: number }
}

export type ForkBoundary = {
  /**
   * Exclusive fork cut point. While the parent is mid-turn this is the
   * in-flight assistant message's ID, so the fork gets everything up to the
   * last completed turn plus the user message that started the current one —
   * exactly the prefix the parent's own in-flight request just wrote to the
   * provider cache. Message IDs ascend, so this also excludes any user
   * messages queued behind the running turn. Undefined copies everything.
   */
  messageID: string | undefined
  /** False when the fork would copy nothing (brand-new session). */
  hasContext: boolean
}

export function forkBoundary(infos: readonly MessageInfoLike[]): ForkBoundary {
  // Only the NEWEST assistant message can be in-flight. An older assistant
  // with time.completed unset is crash debris — the host stamps completion on
  // every abort/interrupt path but never repairs messages orphaned by a hard
  // kill mid-turn — and cutting there would silently drop everything after it.
  let newest: MessageInfoLike | undefined
  for (const info of infos) {
    if (info.role !== "assistant") continue
    if (!newest || info.id > newest.id) newest = info
  }
  const messageID =
    newest?.time?.completed === undefined ? newest?.id : undefined
  const hasContext =
    messageID === undefined
      ? infos.length > 0
      : infos.some((info) => info.id < messageID)
  return { messageID, hasContext }
}

// ---------------------------------------------------------------------------
// The side-question prompt
// ---------------------------------------------------------------------------

// The instructions ride in the user message so the request stays
// prefix-identical to the parent's (the upstream /ask PR independently hit
// and fixed exactly this). Question last, for recency.
export function wrapQuestion(question: string, tools: ToolsMode): string {
  const toolLine =
    tools === "none"
      ? "- Do not use any tools; answer from the conversation alone."
      : "- Prefer answering from context. You may use read-only tools (read, glob) when the answer genuinely needs them; every other tool is disabled."
  return [
    "The <side-question> below is a quick aside from the user — it is NOT an instruction to continue the task or to change anything.",
    "- Answer it directly and concisely, in markdown, using the conversation above as context.",
    "- Do not modify files, run commands, or take any other action on the user's environment.",
    toolLine,
    "- Keep the answer brief unless the question demands depth.",
    "",
    "<side-question>",
    question.trim(),
    "</side-question>",
  ].join("\n")
}

// Session "ask" rules guarantee write-capable tools cannot run in the fork
// even where the agent ruleset allows them outright (build agents typically
// allow edit). "ask" keeps the tool in the request — preserving the cached
// prefix; only a pattern-"*" "deny" strips tools — and the plugin auto-denies
// the resulting permission request before anyone sees it. Last-match-wins:
// the update endpoint appends these after the session's existing rules.
//
// The shape is an allowlist, not a denylist: permission names are open-ended.
// MCP tools ask under their sanitized ids (`github_create_issue`, never an
// "mcp" prefix — session/tools.ts asks with the `McpCatalog.toolName` key),
// and plugin tools under whatever they pass to ctx.ask, so enumerating
// write-capable names can never be complete. Gate "*" and re-open only the
// read-only tools, subject to the parent's effective policy. Replay all matching
// rules in order, including wildcard permission names and allow exceptions, but
// scope them to read/glob so a parent's "*" allow cannot re-enable writes. An
// inherited "ask" is auto-rejected, never silently upgraded to an allow.
//
// grep is NOT re-opened, although it never mutates: its permission carries
// only the search regex (tool/grep.ts asks with patterns: [params.pattern]),
// while the tool itself takes path/include arguments and returns matching
// line CONTENT — so rules can never tell a grep of src/ from a grep of
// secrets.env, and a blanket allow would hand the fork every env file's
// contents past the read guard. There is no layer that can filter grep
// RESULTS in a TUI-only install, so it falls to the "*" ask and is
// auto-rejected, like the write tools.
export function sideQuestionRules(
  tools: ToolsMode,
  parent: PermissionRuleset,
): PermissionRuleset {
  const rules: PermissionRuleset = [
    { permission: "*", pattern: "*", action: "ask" },
  ]
  if (tools === "none") return rules
  for (const permission of ["read", "glob"]) {
    for (const rule of parent) {
      if (wildcardMatch(permission, rule.permission))
        rules.push({ ...rule, permission })
    }
  }
  // The host hides a tool only when its last permission rule is a blanket
  // deny. Extra path guards would reintroduce an already-disabled read tool.
  const lastRead = rules.findLast((rule) => rule.permission === "read")
  if (lastRead?.pattern === "*" && lastRead.action === "deny") return rules

  // Path-specific denies preserve the tool list and cannot relax a parent deny
  // to an approvable ask. Env examples are exempt only where the parent permits
  // them: intersect each ordered read rule with the fixed suffix, rather than
  // appending another blanket "*.env.example" allow.
  rules.push(
    { permission: "read", pattern: "*.env", action: "deny" },
    { permission: "read", pattern: "*.env.*", action: "deny" },
  )
  const suffix = ".env.example"
  for (const rule of parent) {
    if (!wildcardMatch("read", rule.permission)) continue
    for (let cut = 0; cut < rule.pattern.length; cut++) {
      if (!wildcardMatch(suffix, rule.pattern.slice(cut))) continue
      // A '*' can consume both the arbitrary prefix and part of the suffix.
      const prefix = rule.pattern.slice(
        0,
        cut + (rule.pattern[cut] === "*" ? 1 : 0),
      )
      rules.push({ ...rule, permission: "read", pattern: prefix + suffix })
    }
  }
  // MCP resource readers ask under "read", not their tool IDs. Even a parent
  // allow must not let a side question invoke an external MCP server.
  rules.push({ permission: "read", pattern: "mcp:*", action: "deny" })
  return rules
}

// Tool IDs a side question may execute, enforced by the server half at
// tool.execute.before — which fires for builtin, MCP, and plugin tools alike,
// with the same ids permissions use. This backstops the rules above for
// plugin tools that never call ctx.ask (nothing forces them to; see
// registry.ts fromPlugin), which session rules cannot see at all. grep is
// excluded here for the same reason it is not re-opened in the rules: it
// returns matched file content from path/include/directory sweeps that
// nothing pre-execution can filter, so an out-raced ask must still fail.
// The MCP resource readers are excluded likewise: they ask under "read" with
// "mcp:*" patterns (gated in sideQuestionRules), and their content comes from
// external servers nothing here can audit — a foreign approval that out-races
// the reject must still find them refused at execution.
export const READ_ONLY_TOOL_IDS: ReadonlySet<string> = new Set([
  "read",
  "glob",
  // Pure error echo for malformed tool calls; executing it changes nothing.
  "invalid",
])

// The env-file carve-out, argument-side. sideQuestionRules denies env files,
// but the host's runtime approvals can override session rules. The hard gate
// admits "read" by tool ID before any ask exists, so it must also check the
// argument. Mirrors the host's wildcard semantics for the same three
// patterns: "*" crosses "/" and matches empty (util/wildcard.ts), so
// "*.env" is a plain suffix test and relative-vs-absolute paths agree.
export function isGuardedEnvPath(filePath: unknown): boolean {
  if (typeof filePath !== "string" || !filePath) return false
  let candidate = filePath.replaceAll("\\", "/")
  if (process.platform === "win32") candidate = candidate.toLowerCase()
  // Examples bypass this extra guard, not the parent's read restrictions.
  if (candidate.endsWith(".env.example")) return false
  return candidate.endsWith(".env") || candidate.includes(".env.")
}

export function sideSessionTitle(question: string): string {
  const flattened = question.replace(/\s+/g, " ").trim()
  return `btw: ${flattened.length > 64 ? `${flattened.slice(0, 63)}…` : flattened}`
}

// ---------------------------------------------------------------------------
// Client-driven flow
// ---------------------------------------------------------------------------

export type PromptTarget = {
  agent: string | undefined
  model: { providerID: string; modelID: string } | undefined
  variant: string | undefined
}

/**
 * Structural slice of a parent message used as variant evidence. Only user
 * messages carry a `model` object (assistant messages record modelID and
 * providerID top-level instead), so assistants contribute nothing here.
 */
export type VariantEvidence = {
  id: string
  role: string
  model?: { providerID: string; modelID: string; variant?: string }
}

// The host stores its no-pinned-variant sentinel AND an explicitly selected
// variant literally named "default" identically: Session.Info.model.variant
// === "default". Session info alone cannot tell them apart, so the parent's
// latest user message on the same model is the tiebreaker — a user message
// records the variant only as actually requested: undefined for an unpinned
// turn, "default" only when that variant was really asked for. Without such
// a message — or with stale evidence from a different model — the sentinel
// is dropped: base options on a model that defines no "default" variant is
// exactly what the parent ran with.
function inheritedVariant(
  model: Session["model"],
  history: readonly VariantEvidence[],
): string | undefined {
  if (!model?.variant) return undefined
  if (model.variant !== "default") return model.variant
  let latest: VariantEvidence["model"] | undefined
  let latestID = ""
  for (const info of history) {
    if (info.role !== "user" || !info.model) continue
    if (info.id > latestID) {
      latest = info.model
      latestID = info.id
    }
  }
  if (!latest) return undefined
  if (latest.providerID !== model.providerID || latest.modelID !== model.id)
    return undefined
  return latest.variant === "default" ? "default" : undefined
}

// The parent session's stored agent/model/variant (kept current by the host
// on every prompt). Prompting the fork with the same target is what makes the
// system prompt and tool list — and therefore the cached prefix — identical.
// The parent's variant only travels with the parent's model: variants are
// defined per model, so a pinned model must never inherit a variant name that
// belongs to a different one (the host silently ignores unknown variants, and
// a same-named variant on the pinned model could mean different settings).
// An explicit options.variant passes through verbatim: someone who configured
// that exact string — "default" included — means that variant.
export function promptTarget(
  parent: Pick<Session, "agent" | "model">,
  options: ResolvedOptions,
  history: readonly VariantEvidence[] = [],
): PromptTarget {
  return {
    agent: parent.agent,
    model:
      options.model ??
      (parent.model
        ? { providerID: parent.model.providerID, modelID: parent.model.id }
        : undefined),
    variant:
      options.variant ??
      (options.model ? undefined : inheritedVariant(parent.model, history)),
  }
}

export const PROMPT_CONFIRM_DELAYS_MS = [200, 500, 1000, 2000] as const
export const PROMPT_CONFIRM_LOOKUP_TIMEOUT_MS = 1_000

export type PromptDispatchOutcome = "accepted" | "ambiguous"

const MESSAGE_MILLIS_MASK = (1n << 36n) - 1n

function messageMillis(messageID: string | undefined): bigint | undefined {
  if (!messageID || !/^msg_[0-9a-f]{12}/.test(messageID)) return undefined
  return BigInt(`0x${messageID.slice(4, 16)}`) >> 12n
}

/** Mint after freshly copied fork history, while leaving counter 1 for the host's assistant. */
export async function mintSidePromptMessageID(
  lastCopiedMessageID: string | undefined,
  clock: {
    now?: () => number
    waitForNextMs?: () => Promise<void>
  } = {},
): Promise<string> {
  const now = clock.now ?? Date.now
  const waitForNextMs =
    clock.waitForNextMs ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 1)))
  const copiedMillis = messageMillis(lastCopiedMessageID)
  let current = now()
  while (
    copiedMillis !== undefined &&
    (BigInt(current) & MESSAGE_MILLIS_MASK) === copiedMillis
  ) {
    await waitForNextMs()
    current = now()
  }
  return mintMessageID(current)
}

/**
 * Dispatch with a caller-minted id. A resolved SDK error is a definitive host
 * rejection; a thrown transport is correlated against the message route
 * because the host may have persisted the prompt before its response was lost.
 *
 * The optional signal cancels dispatch, confirmation lookups, and backoff.
 * An already-aborted signal skips dispatch. Cancellation without positive
 * acceptance evidence returns "ambiguous", even for a resolved SDK error after
 * abort; a late successful response or lookup still returns "accepted".
 * Cancellation is not proof of host rejection and cannot settle a transport
 * that ignores its signal. Callers needing a bounded wait must race it too.
 */
export async function dispatchSidePrompt(
  client: OpencodeClient,
  input: {
    directory: string
    sessionID: string
    target: PromptTarget
    text: string
    messageID: string
    confirmDelaysMs?: readonly number[]
    confirmLookupTimeoutMs?: number
    signal?: AbortSignal
  },
): Promise<PromptDispatchOutcome> {
  if (input.signal?.aborted) return "ambiguous"
  let transportFailed = false
  let result:
    | Awaited<ReturnType<OpencodeClient["session"]["promptAsync"]>>
    | undefined
  try {
    result = await client.session.promptAsync(
      {
        sessionID: input.sessionID,
        directory: input.directory,
        messageID: input.messageID,
        agent: input.target.agent,
        model: input.target.model,
        variant: input.target.variant,
        parts: [{ type: "text", text: input.text }],
      },
      { signal: input.signal },
    )
  } catch {
    transportFailed = true
  }

  if (!transportFailed) {
    if (!result) return "ambiguous"
    const error = "error" in result ? result.error : undefined
    if (error !== undefined && error !== null) {
      // Cancelling the transport is not evidence that the host rejected it.
      if (input.signal?.aborted) return "ambiguous"
      throw new Error(
        `asking the side question failed: ${JSON.stringify(error)}`,
      )
    }
    return "accepted"
  }

  const delays = input.confirmDelaysMs ?? PROMPT_CONFIRM_DELAYS_MS
  const lookupTimeoutMs =
    input.confirmLookupTimeoutMs ?? PROMPT_CONFIRM_LOOKUP_TIMEOUT_MS
  for (let attempt = 0; ; attempt++) {
    if (input.signal?.aborted) return "ambiguous"
    try {
      const found = await withTimeout(
        (signal) =>
          client.session.message(
            {
              sessionID: input.sessionID,
              messageID: input.messageID,
              directory: input.directory,
            },
            { signal },
          ),
        lookupTimeoutMs,
        { signal: input.signal },
      )
      if ((found.error === undefined || found.error === null) && found.data)
        return "accepted"
    } catch {
      // A failed lookup is no evidence that the prompt was rejected.
    }
    const wait = delays[attempt]
    if (wait === undefined || input.signal?.aborted) return "ambiguous"
    try {
      await delay(wait, undefined, { signal: input.signal })
    } catch {
      return "ambiguous"
    }
  }
}

export type StartInput = {
  directory: string
  parentID: string
  question: string
  options: ResolvedOptions
  now?: number
  /** Test seam for the bounded post-transport message lookup. */
  confirmDelaysMs?: readonly number[]
  /** Test seam for each post-transport message lookup deadline. */
  confirmLookupTimeoutMs?: number
  /**
   * Called with the prepared fork right before the question is fired. The
   * host's runner starts streaming as soon as the prompt is admitted — while
   * promptAsync is still in flight — so a caller that routes events by
   * session ID must install that routing here, not after startSideQuestion
   * resolves, or it can miss the first tokens (and, for a fast answer, the
   * session.idle that ends it). If the prompt then fails — or this callback
   * throws, which is the supported way to cancel a start that was dismissed
   * while the fork was being prepared — the fork is deleted and the error
   * rethrown; the caller must tear its routing down again.
   */
  onBeforePrompt?: (started: StartedSideQuestion) => void
}

export type StartedSideQuestion = {
  sessionID: string
  parentID: string
  target: PromptTarget
  /** The marker written on the fork. The owner heartbeats its lease from this. */
  marker: Marker
  /**
   * The fork's own last copied message ID. Forking copies every message with
   * FRESH ascending IDs, so the parent's IDs mean nothing inside the fork —
   * this is read from the fork's message list before the question is sent.
   * Everything at or below it is copied history; everything above it belongs
   * to the side question.
   */
  lastCopiedMessageID: string | undefined
  /** Stable id supplied to promptAsync and retained for transport correlation. */
  promptMessageID: string | undefined
  promptOutcome: PromptDispatchOutcome | undefined
  hasContext: boolean
}

/**
 * Fork the parent at the last completed turn, mark and guard the fork, and
 * fire the side question. Returns as soon as the prompt is admitted; the
 * answer streams via events. Throws with the fork already deleted if any step
 * after the fork fails, so callers never leak sessions.
 */
export async function startSideQuestion(
  client: OpencodeClient,
  input: StartInput,
): Promise<StartedSideQuestion> {
  const { directory, parentID, question, options } = input
  const now = input.now ?? Date.now()

  const parent = unwrap(
    await client.session.get({ sessionID: parentID, directory }),
    "reading the session",
  )
  const messages = unwrap(
    await client.session.messages({ sessionID: parentID, directory }),
    "reading the conversation",
  )
  const infos = messages.map((message) => message.info)
  const boundary = forkBoundary(infos)
  const target = promptTarget(parent, options, infos)
  let permission: PermissionRuleset = []
  if (options.tools === "read-only") {
    const needsDefaultAgent = !target.agent
    const agents = unwrap(
      await client.app.agents({ directory }),
      "reading agent permissions",
    )
    if (!target.agent) {
      const config = unwrap(
        await client.config.get({ directory }),
        "reading the default agent",
      )
      // /agent is sorted for display, not default selection. The normal build
      // default is unambiguous; if it is unavailable, require a selected agent
      // rather than guessing a different policy from the catalog's first row.
      target.agent = config.default_agent || "build"
    }
    const agent = agents.find((agent) => agent.name === target.agent)
    if (
      !agent ||
      (needsDefaultAgent && (agent.mode === "subagent" || agent.hidden))
    )
      throw new Error(
        "Could not resolve the parent agent's read permissions. Select an agent in the parent session and try again.",
      )
    // Mirrors session/tools.ts. Native forks do not copy session permissions,
    // so both the resolved agent policy and inherited session rules must travel.
    permission = [...agent.permission, ...(parent.permission ?? [])]
  }

  const fork = unwrap(
    await client.session.fork({
      sessionID: parentID,
      directory,
      messageID: boundary.messageID,
    }),
    "forking the session",
  )

  const marker: Marker = {
    parent: parentID,
    tools: options.tools,
    created: now,
    lease: now,
  }

  try {
    unwrap(
      await client.session.update({
        sessionID: fork.id,
        directory,
        title: sideSessionTitle(question),
        metadata: markerFor(marker),
        permission: sideQuestionRules(options.tools, permission),
      }),
      "marking the side session",
    )

    // Nothing to ask about (the parent has no prior turns): leave the fork
    // marked so it is still swept, but do not spend a model call on empty
    // context — the caller discards it.
    if (!boundary.hasContext) {
      return {
        sessionID: fork.id,
        parentID,
        target,
        marker,
        lastCopiedMessageID: undefined,
        promptMessageID: undefined,
        promptOutcome: undefined,
        hasContext: false,
      }
    }

    // The copies carry fresh IDs, so the boundary between copied history and
    // the streamed answer must come from the fork's own message list — read it
    // before the question is sent so it cannot include the question's echo.
    const copied = unwrap(
      await client.session.messages({ sessionID: fork.id, directory }),
      "reading the forked conversation",
    )
    const lastCopied = copied.reduce<string | undefined>(
      (max, message) =>
        max === undefined || message.info.id > max ? message.info.id : max,
      undefined,
    )

    // Counter 0 leaves room for the host's same-ms assistant at counter 1. If
    // the fork copies were minted this millisecond, wait for the next one first
    // so the prompt also sorts above all copied history.
    const promptMessageID = await mintSidePromptMessageID(lastCopied)
    const prepared: StartedSideQuestion = {
      sessionID: fork.id,
      parentID,
      target,
      marker,
      lastCopiedMessageID: lastCopied,
      promptMessageID,
      promptOutcome: undefined,
      hasContext: boundary.hasContext,
    }
    input.onBeforePrompt?.(prepared)

    const promptOutcome = await dispatchSidePrompt(client, {
      sessionID: fork.id,
      directory,
      target,
      messageID: promptMessageID,
      text: wrapQuestion(question, options.tools),
      confirmDelaysMs: input.confirmDelaysMs,
      confirmLookupTimeoutMs: input.confirmLookupTimeoutMs,
    })

    return { ...prepared, promptOutcome }
  } catch (error) {
    await client.session
      .delete({ sessionID: fork.id, directory })
      .catch(() => {})
    throw error
  }
}

export type DiscardInput = {
  directory: string
  sessionID: string
  /** Abort first; safe (and necessary) while the answer is still streaming. */
  abort?: boolean
}

/** Best-effort teardown; never throws. Returns false when nothing was deleted. */
export async function discardSideQuestion(
  client: OpencodeClient,
  input: DiscardInput,
): Promise<boolean> {
  const { directory, sessionID } = input
  if (input.abort)
    await client.session.abort({ sessionID, directory }).catch(() => {})
  try {
    const result = await client.session.delete({ sessionID, directory })
    return result.error === undefined || result.error === null
  } catch {
    return false
  }
}

/**
 * Delete leftover marked forks (a crashed TUI cannot clean up after itself).
 * Only sessions carrying a fully valid marker whose lease has gone stale are
 * ever touched: a live fork's owner heartbeats the lease fresh, so another
 * OpenCode instance starting on the same project never reclaims it.
 */
export async function sweepOrphans(
  client: OpencodeClient,
  directory: string,
  now: number,
): Promise<number> {
  let sessions: Session[]
  try {
    sessions = unwrap(
      await client.session.list({ directory }),
      "listing sessions",
    )
  } catch {
    return 0
  }
  let swept = 0
  for (const session of sessions) {
    const marker = markerOf(session.metadata)
    if (!marker || now - marker.lease < LEASE_STALE_MS) continue
    if (
      await discardSideQuestion(client, {
        directory,
        sessionID: session.id,
        abort: true,
      })
    )
      swept += 1
  }
  return swept
}

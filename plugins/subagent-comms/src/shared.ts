import {
  clampNumber,
  formatDuration,
  type Rule,
  truncateLabel,
} from "@macarons/permission-rules"

/**
 * @macarons/subagent-comms — shared core
 *
 * Everything pure enough for `bun test` to exercise directly: option
 * resolution, the child-session permission derivation mirrored from the
 * host's task tool, reply extraction from raw message lists, and every
 * model-facing string. The strings ARE the plugin's interface — tests pin
 * them so a rewording is a deliberate act, not drift.
 *
 * No SDK imports here: the server half (src/index.ts) stays on the v1
 * injected client while tests construct plain values.
 */

export const SERVICE = "subagent-comms"

// The verified band is centralized in the shared library and rides the repo's
// OpenCode pin (.opencode-version) — the policy comment lives there. The host
// surfaces this package leans on: the plugin tool API (Hooks.tool + ctx.ask),
// promptAsync noReply/agent, GET /session/:id/children, and the
// session-create body fields this package relies on.
export {
  MAX_TIMER_MS,
  MESSAGE_COUNTER_MAX,
  mintMessageID,
  openCodeCompatNotice,
  SUPPORTED_OPENCODE_RANGE,
} from "@macarons/permission-rules"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Hard cap on any single blocking wait a tool call may hold. */
export const WAIT_MAX_TIMEOUT_MS = 600_000
export const DEFAULT_WAIT_TIMEOUT_MS = 300_000
export const MIN_WAIT_TIMEOUT_MS = 1_000
export const DEFAULT_POLL_INTERVAL_MS = 2_000
export const DEFAULT_MAX_REPLY_CHARS = 16_384
export const DEFAULT_MAX_BUSY_CHILDREN = 8
/** How long subagent_kill waits for the abort to be confirmed as idle. */
export const KILL_CONFIRM_MS = 8_000
/**
 * A watched child that looks idle with no new reply is declared "ended" only
 * after this many idle observations, spaced at least GRACE_SPACING_MS apart —
 * insurance against the window where promptAsync has returned 204 but the
 * child's run has not registered as busy yet.
 */
export const IDLE_CHECKS_BEFORE_ENDED = 2
export const GRACE_SPACING_MS = 750
/**
 * promptAsync answers 204 after FORKING the whole prompt operation, message
 * persistence included; an early failure in that fork is only published as a
 * session.error event and the message never lands. Every injection therefore
 * polls (spaced INJECT_CONFIRM_POLL_MS) until its minted id is visible. A
 * bounded miss is ambiguous, not failed: the caller preserves routing rather
 * than risking duplicate work or deleting a run the host may have accepted.
 */
export const INJECT_CONFIRM_POLL_MS = 150
export const DEFAULT_INJECT_CONFIRM_TIMEOUT_MS = 10_000

export type ServerOptions = {
  /** Inject completion notes for spawns / unwaited sends into the parent (default true). */
  notify: boolean
  /** Toast when a tracked subagent finishes, in addition to the note (default true). */
  toast: boolean
  /** Append the subagent-tools pointer to the builtin task description (default true). */
  taskHint: boolean
  /** Default cap for subagent_send/subagent_wait blocking waits. */
  defaultWaitTimeoutMs: number
  /** Fallback poll for missed idle events; runs only while something is watched. */
  pollIntervalMs: number
  /** Reply truncation bound for tool outputs and notifications. */
  maxReplyChars: number
  /** Busy children per session; subagent_spawn past this fails with guidance. */
  maxBusyChildren: number
  /** Confirmation window; a miss is uncertain, never proof of rejection. */
  injectConfirmTimeoutMs: number
}

export function resolveServerOptions(raw: unknown): ServerOptions {
  const options = (raw ?? {}) as Record<string, unknown>
  return {
    notify: options.notify !== false,
    toast: options.toast !== false,
    taskHint: options.taskHint !== false,
    defaultWaitTimeoutMs: clampNumber(
      options.defaultWaitTimeoutMs,
      DEFAULT_WAIT_TIMEOUT_MS,
      MIN_WAIT_TIMEOUT_MS,
      WAIT_MAX_TIMEOUT_MS,
    ),
    pollIntervalMs: clampNumber(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      250,
      30_000,
    ),
    maxReplyChars: clampNumber(
      options.maxReplyChars,
      DEFAULT_MAX_REPLY_CHARS,
      512,
      262_144,
    ),
    maxBusyChildren: clampNumber(
      options.maxBusyChildren,
      DEFAULT_MAX_BUSY_CHILDREN,
      1,
      32,
    ),
    injectConfirmTimeoutMs: clampNumber(
      options.injectConfirmTimeoutMs,
      DEFAULT_INJECT_CONFIRM_TIMEOUT_MS,
      250,
      60_000,
    ),
  }
}

export function clampWaitTimeout(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return fallback
  return Math.min(
    WAIT_MAX_TIMEOUT_MS,
    Math.max(MIN_WAIT_TIMEOUT_MS, Math.floor(value)),
  )
}

// ---------------------------------------------------------------------------
// Rulesets and the child-session permission derivation
//
// Mirrors the host's own subagent spawn path (agent/subagent-permissions.ts +
// tool/task.ts childToolDenies at v1.17.18): the child keeps the parent
// session's deny and external_directory rules, and is denied todowrite/task
// unless its agent's own ruleset mentions them. On top of the stock denies,
// the six subagent_* tools are denied under the same "can it task?"
// condition — a `pattern:"*"` deny for a tool's own name hides the tool from
// the model entirely (the host's Permission.disabled request filter), so a
// child that cannot spawn subagents never sees the tools either.
//
// The stock task tool ALSO layers on, unconditionally, a `pattern:"*"` deny
// for every entry in experimental.primary_tools — tools the user restricted to
// primary agents (tool/task.ts childToolDenies). Those denies live in task.ts,
// not in the shared subagent-permissions helper, so a child created off the
// task path would otherwise regain bash/write/etc. `deriveChildPermission`
// takes the primary_tools list and mirrors those denies too; index.ts reads
// experimental.primary_tools from config and passes it here.
// ---------------------------------------------------------------------------

export const SUBAGENT_TOOL_IDS = [
  "subagent_spawn",
  "subagent_send",
  "subagent_list",
  "subagent_wait",
  "subagent_kill",
  "subagent_models",
] as const

const ACTIONS = new Set(["allow", "ask", "deny"])

/** Junk-tolerant read of a runtime ruleset (ordered Rule[]); anything else → []. */
export function rulesetOf(value: unknown): Rule[] {
  if (!Array.isArray(value)) return []
  const rules: Rule[] = []
  for (const entry of value) {
    const rule = entry as {
      permission?: unknown
      pattern?: unknown
      action?: unknown
    }
    if (
      typeof rule?.permission !== "string" ||
      typeof rule.pattern !== "string"
    )
      continue
    if (typeof rule.action !== "string" || !ACTIONS.has(rule.action)) continue
    rules.push({
      permission: rule.permission,
      pattern: rule.pattern,
      action: rule.action as Rule["action"],
    })
  }
  return rules
}

/**
 * The child-session create body, typed against what the ROUTE accepts rather
 * than the SDK's generated body type — that one still lists only
 * parentID/title, so the fields this plugin depends on (`agent` and the
 * lockdown `permission`) are invisible to it. The value is passed to
 * client.session.create STRUCTURALLY: excess-property checking holds it to
 * THIS contract, while the extra keys ride through because a non-fresh value
 * with extra properties is assignable to the narrower generated type.
 *
 * Never launder this through a cast. The fields below are required precisely
 * so dropping or misspelling one is a compile error — because nothing else
 * would catch it: the create route decodes with Effect Schema's default
 * onExcessProperty ("ignore"), so an unknown key is dropped without an error
 * anywhere, and a misspelled `permission` would create a child with no
 * lockdown ruleset at all.
 *
 * Everything else Session.CreateInput accepts on opencode 1.18.3 —
 * `model` ({id, providerID}; note `id`, NOT the promptAsync body's `modelID`),
 * `metadata`, `workspaceID` — is deliberately absent: spawn does not send it,
 * and an unused optional field would not be checked against anything.
 */
export type SessionCreateBody = {
  parentID: string
  title: string
  agent: string
  permission: Rule[]
}

export function deriveChildPermission(
  parentPermission: Rule[],
  subagentPermission: Rule[],
  primaryTools: readonly string[] = [],
): Rule[] {
  const canTask = subagentPermission.some((rule) => rule.permission === "task")
  const canTodo = subagentPermission.some(
    (rule) => rule.permission === "todowrite",
  )
  const carried = parentPermission.filter(
    (rule) =>
      rule.permission === "external_directory" || rule.action === "deny",
  )
  const denies: Rule[] = [
    ...(canTodo
      ? []
      : [{ permission: "todowrite", pattern: "*", action: "deny" as const }]),
    ...(canTask
      ? []
      : ["task", ...SUBAGENT_TOOL_IDS].map((permission) => ({
          permission,
          pattern: "*",
          action: "deny" as const,
        }))),
    // Unconditional, exactly like the stock task tool: a child never regains a
    // tool the user restricted to primary agents, whatever its own ruleset says.
    ...primaryTools.map((permission) => ({
      permission,
      pattern: "*",
      action: "deny" as const,
    })),
  ]
  // Dedup each deny against everything accumulated so far (carried rules and
  // earlier denies), so a primary_tools entry that overlaps task/todowrite/a
  // subagent tool does not double up — the same filter the stock tool applies.
  const result: Rule[] = [...carried]
  for (const deny of denies) {
    if (
      !result.some(
        (rule) =>
          rule.permission === deny.permission &&
          rule.pattern === deny.pattern &&
          rule.action === deny.action,
      )
    )
      result.push(deny)
  }
  return result
}

// Session prompt identity lives in the shared library (background-tasks and
// cron echo it too); re-exported here so both this plugin's halves and its
// tests keep one import site. See sessionPromptIdentity's comment there for
// why every injected prompt must echo the target session's agent/model/
// variant.
export {
  type PromptIdentity,
  sessionPromptIdentity,
} from "@macarons/permission-rules"

// ---------------------------------------------------------------------------
// Message parsing and reply extraction
// ---------------------------------------------------------------------------

export type ChildMessage = {
  id: string
  role: "user" | "assistant"
  /** Assistant: time.completed set. User messages count as complete. */
  completed: boolean
  /** Assistant: the user message the step answered (the newest one when it started). */
  parentID?: string
  /** Assistant: true on compaction summaries, which are not replies. */
  summary?: boolean
  /** Assistant error summary, when the host recorded one. */
  error?: string
  /** Last text part, the same selection the stock task tool returns. */
  text?: string
}

/** Junk-tolerant parse of a raw GET /session/:id/message payload. */
export function parseChildMessages(raw: unknown): ChildMessage[] {
  if (!Array.isArray(raw)) return []
  const messages: ChildMessage[] = []
  for (const entry of raw) {
    const info = (entry as { info?: unknown })?.info as
      | {
          id?: unknown
          role?: unknown
          parentID?: unknown
          summary?: unknown
          time?: { completed?: unknown }
          error?: unknown
        }
      | undefined
    if (!info || typeof info.id !== "string") continue
    if (info.role !== "user" && info.role !== "assistant") continue
    const parts = (entry as { parts?: unknown }).parts
    let text: string | undefined
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const candidate = part as { type?: unknown; text?: unknown }
        if (
          candidate?.type === "text" &&
          typeof candidate.text === "string" &&
          candidate.text
        )
          text = candidate.text
      }
    }
    const error = info.error as
      | { data?: { message?: unknown }; name?: unknown }
      | undefined
    const errorMessage =
      typeof error?.data?.message === "string"
        ? error.data.message
        : typeof error?.name === "string"
          ? error.name
          : undefined
    messages.push({
      id: info.id,
      role: info.role,
      completed:
        info.role === "user" ? true : typeof info.time?.completed === "number",
      ...(typeof info.parentID === "string" ? { parentID: info.parentID } : {}),
      ...(info.summary === true ? { summary: true } : {}),
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
      ...(text !== undefined ? { text } : {}),
    })
  }
  return messages
}

export type ChildOutcome =
  | { kind: "replied"; messageID: string; text: string }
  | { kind: "errored"; error: string }
  | { kind: "none" }

/**
 * The child's outcome relative to `repliesTo`, the minted id of the user
 * message this plugin injected (undefined accepts any assistant activity —
 * the explicit-idle wait and kill-confirmation "latest reply" reading). A
 * reply must be parented at or past the injected message: the host's run loop
 * message pending when a step starts but records only the newest as
 * parentID, so a reply attributed to a later message still covers ours,
 * while anything parented earlier belongs to a previous run — even when it
 * lands, newer-id and freshly completed, in the window between our
 * promptAsync and its message becoming visible. Compaction summaries are
 * assistant-shaped and parented like replies, but are transcript
 * management, not replies. Message ids are monotonic in the host; sorting
 * here makes the answer independent of fetch order (limit:N returns
 * newest-first, unlimited ascending).
 *
 * Precedence is newest → oldest, first message that carries a verdict wins,
 * with an error beating text ON THE SAME MESSAGE. The host can complete an
 * assistant message with BOTH a partial text part AND an error — a mid-stream
 * or content-filter cut-off flushes what streamed, sets time.completed, and
 * records the error (session/processor.ts, prompt.ts). That is a failure, not
 * a truncated reply. Scanning newest-first also stops an older successful step
 * from masking a newer errored one (each run step is its own assistant
 * message).
 */
export function extractChildOutcome(
  messages: ChildMessage[],
  repliesTo: string | undefined,
): ChildOutcome {
  const candidates = messages
    .filter(
      (message) =>
        message.role === "assistant" &&
        message.summary !== true &&
        (repliesTo === undefined ||
          (message.parentID !== undefined && message.parentID >= repliesTo)),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (let i = candidates.length - 1; i >= 0; i--) {
    const message = candidates[i]
    if (message === undefined) continue
    if (message.error) return { kind: "errored", error: message.error }
    if (message.completed && message.text)
      return { kind: "replied", messageID: message.id, text: message.text }
  }
  return { kind: "none" }
}

/**
 * Whether the plugin's own injected user message is visible yet. A watcher
 * that observes its target idle BEFORE this is true is inside the
 * promptAsync accepted-but-not-started window and must keep waiting, not
 * conclude the run ended without a reply.
 */
export function hasInjectedMessage(
  messages: ChildMessage[],
  messageID: string,
): boolean {
  return messages.some((message) => message.id === messageID)
}

/**
 * The id of the newest user message in a child's transcript, or undefined if
 * there is none. subagent_wait injects nothing, so it has no minted id to
 * correlate against; it captures this at wait-start as a watermark and passes
 * it as `repliesTo`. The run in flight when the wait began answers this user
 * message (its steps record it, or a later one, as parentID), so extraction
 * accepts that run's reply while excluding any PREVIOUS run's — without it a
 * run that goes idle without producing new text would surface an older reply
 * as though it were the awaited run's. Message ids are monotonic in the host,
 * so the newest user message is the max id; string comparison suffices.
 */
export function newestUserMessageID(
  messages: ChildMessage[],
): string | undefined {
  let newest: string | undefined
  for (const message of messages) {
    if (
      message.role === "user" &&
      (newest === undefined || message.id > newest)
    )
      newest = message.id
  }
  return newest
}

export function truncateReply(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, maxChars)}\n[... ${text.length - maxChars} characters truncated; the full reply is in the subagent's session ...]`,
    truncated: true,
  }
}

// Child labels and elapsed times render identically here and in
// background-tasks, which is why both plugins had grown the same two
// functions; the definition is in the library now (re-exported so both halves
// keep one import site).
export { formatDuration, truncateLabel }

// ---------------------------------------------------------------------------
// Provider model catalog
// ---------------------------------------------------------------------------

/** The allowlisted portion of GET /config/providers used by this plugin. */
export type CatalogModel = {
  ref: string
  providerID: string
  modelID: string
  providerName: string
  modelName: string
  providerDefault: boolean
  variants: string[]
}

export type ModelCatalog = { models: CatalogModel[] }

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Project the current provider response onto the fields safe to show a model.
 * Provider keys, options, headers, API details, and raw errors must never
 * cross this boundary: the host's provider endpoint can include all of them.
 */
export function parseModelCatalog(raw: unknown): ModelCatalog | undefined {
  const data = recordOf(raw)
  if (!data || !Array.isArray(data.providers)) return undefined
  const defaults = recordOf(data.default) ?? {}
  const models: CatalogModel[] = []
  for (const providerValue of data.providers) {
    const provider = recordOf(providerValue)
    const providerID = provider?.id
    const providerModels = provider && recordOf(provider.models)
    if (typeof providerID !== "string" || !providerID || !providerModels)
      continue
    const providerName =
      typeof provider.name === "string" && provider.name
        ? provider.name
        : providerID
    const defaultModelID = defaults[providerID]
    for (const modelValue of Object.values(providerModels)) {
      const model = recordOf(modelValue)
      const modelID = model?.id
      if (typeof modelID !== "string" || !modelID) continue
      const variants = recordOf(model.variants)
      models.push({
        ref: `${providerID}/${modelID}`,
        providerID,
        modelID,
        providerName,
        modelName:
          typeof model.name === "string" && model.name ? model.name : modelID,
        providerDefault: defaultModelID === modelID,
        variants: variants
          ? Object.keys(variants).filter((name) => Boolean(name))
          : [],
      })
    }
  }
  models.sort((left, right) =>
    left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0,
  )
  for (const model of models)
    model.variants.sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
  return { models }
}

export function findCatalogModel(
  catalog: ModelCatalog,
  model: { providerID: string; modelID: string },
): CatalogModel | undefined {
  return catalog.models.find(
    (candidate) =>
      candidate.providerID === model.providerID &&
      candidate.modelID === model.modelID,
  )
}

export function renderModelCatalog(catalog: ModelCatalog): string {
  if (!catalog.models.length)
    return "No models are currently listed in the provider catalog."
  return [
    "Models in the current provider catalog:",
    ...catalog.models.map((model) => {
      const defaultLabel = model.providerDefault ? " [provider default]" : ""
      const variants = model.variants.length
        ? `; variants: ${model.variants.join(", ")}`
        : "; variants: none"
      return `- ${model.ref} (${model.providerName} / ${model.modelName})${defaultLabel}${variants}`
    }),
  ].join("\n")
}

export const MODEL_CATALOG_READ_ERROR =
  "Could not read the current provider model catalog, so the requested model selection was not started. Try again."

export const INVALID_MODEL_REF_ERROR =
  'Model must be a non-empty "provider/model" reference. Call subagent_models to inspect the current provider catalog.'

export function unavailableModelError(ref: string): string {
  return `Model "${ref}" is not listed in the current provider catalog. Call subagent_models to inspect the catalog.`
}

export function unavailableVariantError(
  ref: string,
  variants: readonly string[],
): string {
  const supported = variants.length ? variants.join(", ") : "none"
  return `Variant is not listed for model "${ref}" in the current provider catalog. Supported variants: ${supported}. Call subagent_models to inspect the catalog.`
}

// ---------------------------------------------------------------------------
// Model-facing text
// ---------------------------------------------------------------------------

/**
 * Byte-for-byte mirror of the stock task tool's renderOutput block so replies
 * routed through this plugin read exactly like task tool results to the
 * model.
 */
export function renderTaskBlock(input: {
  sessionID: string
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}): string {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

const IGNORABLE =
  "If this completion is not relevant to what you are doing now, you may ignore it and continue."

export function notificationText(input: {
  sessionID: string
  label: string
  outcome: ChildOutcome
  elapsedMs: number
  maxReplyChars: number
}): string {
  const followUp = `Finished after ${formatDuration(input.elapsedMs)}. To follow up, use subagent_send({ "session_id": "${input.sessionID}", "message": ... }). ${IGNORABLE}`
  if (input.outcome.kind === "replied") {
    const reply = truncateReply(input.outcome.text, input.maxReplyChars)
    return [
      renderTaskBlock({
        sessionID: input.sessionID,
        state: "completed",
        summary: `Background subagent completed: ${input.label}`,
        text: reply.text,
      }),
      followUp,
    ].join("\n")
  }
  if (input.outcome.kind === "errored") {
    return [
      renderTaskBlock({
        sessionID: input.sessionID,
        state: "error",
        summary: `Background subagent failed: ${input.label}`,
        text: input.outcome.error,
      }),
      followUp,
    ].join("\n")
  }
  return [
    `Background subagent ${input.sessionID} ("${input.label}") went idle after ${formatDuration(input.elapsedMs)} without producing a new reply (it may have been interrupted).`,
    `Its session is preserved: subagent_send({ "session_id": "${input.sessionID}", "message": ... }) picks the conversation back up. ${IGNORABLE}`,
  ].join("\n")
}

export function notDirectChildError(id: string, parentID: string): string {
  return `${id} is not one of this session's subagents. You can only communicate with subagents you started yourself (direct children of session ${parentID}); use subagent_list to see them.`
}

export function unknownAgentError(name: string, available: string[]): string {
  const list = available.length
    ? ` Available agent types: ${available.join(", ")}.`
    : ""
  return `Unknown agent type: ${name} is not a valid agent type.${list}`
}

export function spawnDeniedError(inSubagent: boolean): string {
  return inSubagent
    ? "Subagents may not spawn subagents of their own: spawning is denied in this session. Finish your task and report back to your parent instead."
    : "Spawning a subagent was not permitted (the task permission is denied here, or the user declined)."
}

export const SEND_DENIED_MESSAGE =
  "Messaging this subagent was not permitted (the task permission is denied here, or the user declined)."

/** Byte-for-byte mirror of the stock task tool's depth refusal (task.ts, v1.18.2). */
export function subagentDepthLimitError(limit: number): string {
  return `Subagent depth limit reached (${limit}). Increase "subagent_depth" to allow nested subagents.`
}

/**
 * Mirrors the stock task tool, which DIES when the parent's current message
 * (the model-inheritance source) cannot be read. Falling back to the host's
 * default model instead would silently change provider, cost, or data routing.
 */
export function spawnModelReadError(detail: string): string {
  return `Could not read the current model for the subagent to inherit, so it was not started (${detail}). This is usually transient; try again.`
}

/**
 * A spawn is refused rather than run with a looser ruleset when the inputs that
 * lock the child down (the parent session's permissions, the primary_tools
 * restrictions) cannot be read — failing closed, never escalating access.
 */
export function spawnLockdownReadError(detail: string): string {
  return `Could not read the permission restrictions needed to lock down the subagent, so it was not started (${detail}). This is usually transient; try again.`
}

export function tooManyBusyChildrenError(busy: number, max: number): string {
  return `This session already has ${busy} subagents working (limit ${max}). Wait for one with subagent_wait, stop one with subagent_kill, or message one with subagent_send instead of starting another.`
}

export type ChildSummary = {
  id: string
  title?: string
  agent?: string
  /** "unknown" only when the status endpoint could not be read for a listing. */
  status: "busy" | "retry" | "idle" | "unknown"
  /** A completion reached the parent-delivery boundary but was not confirmed. */
  notification?: "ambiguous" | "terminal"
  /** Initial prompt acceptance is still unresolved, independently of host activity. */
  launch?: { promptMessageId: string; state: "unconfirmed" | "parked" }
  /** Session time.updated, when present. */
  updated?: number
}

export function childLine(child: ChildSummary, now: number): string {
  const agent = child.agent ? ` @${child.agent}` : ""
  const title = child.title ? ` — "${truncateLabel(child.title, 60)}"` : ""
  const updated =
    child.updated !== undefined
      ? ` — updated ${formatDuration(Math.max(0, now - child.updated))} ago`
      : ""
  const notification = child.notification
    ? ` — completion notification ${child.notification}`
    : ""
  const launch = child.launch
    ? ` - ${initialLaunchText(child.launch.promptMessageId, child.launch.state === "parked")}`
    : ""
  return `- ${child.id} [${child.status}]${agent}${title}${updated}${notification}${launch}`
}

export const NO_CHILDREN_MESSAGE =
  "You have no subagents in this session. Start one with subagent_spawn (background) or the task tool (foreground)."

// ---------------------------------------------------------------------------
// Tool descriptions — these ride every model request, so they stay tight.
// Every description is generated from the RESOLVED notify setting: with
// notify:false the model must never be promised a notification that cannot
// arrive (it would launch non-blocking work and end its turn waiting forever).
// ---------------------------------------------------------------------------

export function subagentSpawnDescription(notifyEnabled: boolean): string {
  return [
    "Start a subagent in the background and return immediately with its session id.",
    "",
    notifyEnabled
      ? "Like the task tool, but non-blocking: the subagent runs in its own child session while you continue working, and you are NOTIFIED automatically in this conversation when it finishes, with its reply included. Use the task tool when you need the result before continuing; use subagent_spawn for independent work that can run in parallel."
      : "Like the task tool, but non-blocking: the subagent runs in its own child session while you continue working. Completion notifications are disabled (notify: false), so collect its result later with subagent_wait. Use the task tool when you need the result before continuing; use subagent_spawn for independent work that can run in parallel.",
    "",
    "- subagent_type works exactly like the task tool's: pick from the same agent types.",
    "- Call subagent_models to inspect the current provider catalog, provider defaults, and variants. model optionally selects a catalog-listed provider/model; variant optionally selects a catalog-listed effort for the resolved model. An explicit model without variant uses its default effort. Catalog checks do not pre-check provider authentication or runtime usability.",
    "- The subagent cannot spawn subagents of its own.",
    "- An unconfirmed initial launch is tracked for a bounded window, then parked visibly in subagent_list. Do not duplicate its work; inspect with subagent_wait or clear its tracking with subagent_kill.",
    "- Follow up with subagent_send (message it), subagent_list (see all your subagents), subagent_wait (block until they finish), subagent_kill (stop one).",
    notifyEnabled
      ? "- DO NOT sleep, poll for progress, or duplicate the subagent's work — avoid working with the same files or topics it is using. Continue with non-overlapping work, or end your turn."
      : "- DO NOT sleep, poll for progress, or duplicate the subagent's work — avoid working with the same files or topics it is using. Continue with non-overlapping work, then collect results with subagent_wait.",
  ].join("\n")
}

export const SUBAGENT_MODELS_DESCRIPTION =
  "List models in the current provider catalog for subagent_spawn. Returns canonical provider/model references, display names, provider defaults, and supported variants. Catalog membership is validated before spawn, but provider authentication and runtime usability are not pre-checked."

export function subagentSendDescription(
  defaultTimeoutMs: number,
  notifyEnabled: boolean,
): string {
  return [
    "Send a message to one of your subagents (a direct child session), like talking to a teammate.",
    "",
    "By default this waits and returns the subagent's reply. If the subagent is idle, your message starts a new turn; if it is still working, the message is merged into its current run as additional context (steering) and the reply comes when that run finishes.",
    "",
    '- session_id must be one of YOUR subagents: a session id returned by subagent_spawn, the task tool (<task id="...">), or subagent_list.',
    notifyEnabled
      ? "- wait: false delivers the message and returns immediately; you will be notified in this conversation when the subagent replies. Use it to keep working in parallel."
      : "- wait: false delivers the message and returns immediately; completion notifications are disabled (notify: false), so collect the reply later with subagent_wait. Use it to keep working in parallel.",
    notifyEnabled
      ? `- timeout_ms (default ${defaultTimeoutMs}, max ${WAIT_MAX_TIMEOUT_MS}) caps the wait. Timing out is not an error: the subagent keeps working and you will be notified when it replies. DO NOT poll or sleep after a timeout.`
      : `- timeout_ms (default ${defaultTimeoutMs}, max ${WAIT_MAX_TIMEOUT_MS}) caps the wait. Timing out is not an error: the subagent keeps working; collect its reply later with subagent_wait. DO NOT poll or sleep after a timeout.`,
  ].join("\n")
}

export function subagentListDescription(notifyEnabled: boolean): string {
  return [
    "List your subagents: every child session of this session, with its session id, status (busy/idle), agent type, title, and last activity.",
    "Includes subagents started by both the task tool and subagent_spawn. Use the session ids with subagent_send, subagent_wait, and subagent_kill.",
    "Unconfirmed initial launches show their original prompt id and whether tracking is parked; parked uncertainty is not evidence of completion or cancellation.",
    notifyEnabled
      ? "Never call this in a polling loop — you are notified automatically when subagents you started finish."
      : "Never call this in a polling loop — block on subagent_wait to collect results instead.",
  ].join("\n")
}

export function subagentWaitDescription(
  defaultTimeoutMs: number,
  notifyEnabled: boolean,
): string {
  return [
    "Block until subagents finish their current work, then return each one's latest reply.",
    "",
    `Waits for the given session_ids (default: every subagent of yours that is currently busy) to go idle, up to timeout_ms (default ${defaultTimeoutMs}, max ${WAIT_MAX_TIMEOUT_MS}). Timing out is not an error — still-busy subagents keep working and are listed as such. An explicitly named subagent that is already idle returns its latest completed result.`,
    "If inspection leaves an initial launch unresolved, it returns uncertainty instead of a fabricated completion and does not restart parked automatic tracking.",
    notifyEnabled
      ? "Also the way to pick up a reply after an interrupted or timed-out subagent_send. Prefer doing other useful work and letting the automatic completion notifications come to you."
      : "Also the way to pick up a reply after an interrupted or timed-out subagent_send, and — with notifications disabled (notify: false) — the only way to collect a backgrounded subagent's result.",
  ].join("\n")
}

export const SUBAGENT_KILL_DESCRIPTION = [
  "Stop a subagent that is currently working. Aborts the child session's in-flight run (like pressing Esc in that session).",
  "The session and its messages survive: subagent_send (or the task tool's task_id) can resume it later. Killing an already-idle subagent is not an error. This never deletes the session.",
  "For an idle child with an unconfirmed initial launch, clears its tracking without claiming the possibly accepted request was cancelled.",
].join("\n")

// ---------------------------------------------------------------------------
// Composite output fragments (index.ts assembles tool outputs from these)
// ---------------------------------------------------------------------------

const NOTIFY_NOTE =
  "You will be notified automatically in this conversation when it finishes, with its reply included — DO NOT poll it, run sleep commands, or duplicate its work. Continue with other, non-overlapping work, or end your turn."
const NO_NOTIFY_NOTE =
  "Automatic completion notifications are disabled (notify: false); check on it later with subagent_wait or subagent_list. DO NOT poll it in a loop or run sleep commands."

export function spawnStartedText(
  childID: string,
  notifyEnabled: boolean,
  confirmed: boolean,
): string {
  return [
    confirmed
      ? "The subagent is working in its own session in the background."
      : "The initial prompt may have been accepted, but delivery could not be confirmed. The child remains tracked for one more confirmation window, then unresolved tracking is parked; do not spawn duplicate work.",
    `- subagent_send({ "session_id": "${childID}", "message": ... }) sends it a follow-up (and by default waits for the reply).`,
    "- subagent_list() shows all your subagents; subagent_wait() blocks until they finish; subagent_kill() stops one.",
    confirmed
      ? notifyEnabled
        ? NOTIFY_NOTE
        : NO_NOTIFY_NOTE
      : "Use subagent_list to see launch uncertainty, subagent_wait with this session id to inspect for a reply, or subagent_kill to clear tracking. Parking stops automatic polling and notifications, not possibly accepted work.",
  ].join("\n")
}

export function initialLaunchText(messageID: string, parked: boolean): string {
  return `initial prompt unconfirmed (${messageID}); ${parked ? "tracking parked, automatic polling stopped" : "bounded reconciliation pending"}. The request may have been accepted; do not resend the same work. Use subagent_wait to inspect or subagent_kill to clear tracking.`
}

export function deliveredText(
  childID: string,
  wasBusy: boolean,
  notifyEnabled: boolean,
  confirmed: boolean,
): string {
  return [
    confirmed
      ? `Message delivered to subagent ${childID}.`
      : unconfirmedDeliveryText(childID),
    confirmed
      ? wasBusy
        ? "It was mid-run; your message was merged into that run as additional context (steering)."
        : "It was idle and is now working on it."
      : "The subagent remains registered so any eventual reply can still be collected.",
    notifyEnabled ? NOTIFY_NOTE : NO_NOTIFY_NOTE,
  ].join("\n")
}

export function unconfirmedDeliveryText(childID: string): string {
  return `Delivery to subagent ${childID} could not be confirmed. The request may have been accepted; do not resend the same message.`
}

export function sendTimedOutText(
  childID: string,
  timeoutMs: number,
  notifyEnabled: boolean,
): string {
  return [
    `Timed out after ${timeoutMs} ms; subagent ${childID} is still working on it. Timing out is not an error.`,
    notifyEnabled ? NOTIFY_NOTE : NO_NOTIFY_NOTE,
  ].join("\n")
}

/**
 * The abort messages below are mostly transcript artifacts: on an interrupted
 * turn the host overwrites every still-open tool part with its own "Tool
 * execution aborted" and makes no further model request, so the model rarely
 * reads these strings. What the abort checkpoints actually buy is side-effect
 * suppression — no permission prompt, no session created, no child prompted.
 * The wording still matters for the transcript a later turn can see.
 */
export const SPAWN_ABORTED_MESSAGE =
  "The spawn was aborted before the subagent was prompted; no subagent is running."
/**
 * Distinct from SEND_ABORTED_MESSAGE, which tells the model the subagent kept
 * the message and is working on it — true only once the prompt was accepted.
 * Aborting before that means the subagent never heard anything.
 */
export const SEND_ABORTED_BEFORE_DELIVERY_MESSAGE =
  "The send was aborted before the message was delivered; the subagent did not receive it."
export const SEND_ABORTED_MESSAGE =
  "The wait for the subagent's reply was aborted. The subagent keeps running; collect its reply later with subagent_wait, or send a follow-up with subagent_send."
export const WAIT_ABORTED_MESSAGE =
  "The wait was aborted. The subagents keep running; their replies stay collectable with subagent_wait or subagent_send."
/**
 * Teardown, not failure. Raised both by dispose() for the waits it finds open
 * and by the guards that refuse to start new work once it has run, so a caller
 * cannot tell which side of the teardown it landed on — which is the point.
 */
export const PLUGIN_DISPOSED_MESSAGE = "The plugin was disposed while waiting."
export const ENDED_WITHOUT_REPLY_TEXT =
  "The subagent's run ended without a new reply (it may have been interrupted). Its session is preserved; subagent_send can pick the conversation back up."

export function killedIdleText(childID: string): string {
  return `Subagent ${childID} was already idle; nothing to stop. Its work so far is preserved in its session — subagent_send can pick the conversation back up.`
}

export function killedText(childID: string, confirmed: boolean): string {
  return confirmed
    ? `Aborted subagent ${childID}; it is now idle. The session and its messages are preserved, so subagent_send (or the task tool's task_id) can resume it.`
    : `Sent the abort to subagent ${childID}, but it has not confirmed going idle yet. Check subagent_list before assuming it stopped.`
}

export function killedDeletedText(childID: string): string {
  return `Sent the abort to subagent ${childID}; its session has since been deleted, so it is stopped for good and can no longer be resumed.`
}

/**
 * Appended to the builtin task tool's description (the host appends its own
 * agent list after hook output, so this sits mid-description — harmless).
 * Generated from the resolved notify setting like the tool descriptions.
 */
export function taskHint(notifyEnabled: boolean): string {
  const spawn = notifyEnabled
    ? "subagent_spawn (run one in the background; you are notified with its reply)"
    : "subagent_spawn (run one in the background; collect its reply with subagent_wait)"
  return [
    "",
    `Task ids are child session ids ("ses_..."), and you can keep collaborating with a task's subagent after it returns: pass its id as task_id here to resume it in the foreground, or use the subagent tools — ${spawn}, subagent_send (message one and get the reply, or steer it mid-run), subagent_list, subagent_wait, subagent_kill, subagent_models (discover models and variants before a background spawn).`,
  ].join("\n")
}

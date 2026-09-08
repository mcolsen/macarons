import type { Dirent } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import {
  canonicalPath,
  clampNumber,
  formatDuration,
  isInside,
  MAX_TIMER_MS,
  projectFileKey,
  readJsonFile,
  shortProjectHash,
  truncateLabel,
  writeJsonFile,
} from "@macarons/permission-rules"

/**
 * @macarons/background-tasks — shared core
 *
 * Everything pure enough for `bun test` to exercise directly, and everything
 * the two halves must agree on. The server half (src/index.ts) owns the
 * processes; the TUI half (src/tui.tsx) only ever sees them through the
 * contract defined here:
 *
 *   - the per-instance task state files each server rewrites on lifecycle
 *     transitions (never per output chunk), merged by the TUI;
 *   - the kill-request drop directory the TUI writes into, swept by the
 *     server;
 *   - the `tui.command.execute` poke the server publishes after each state
 *     write so an attached TUI refreshes promptly (the TUI's poll makes the
 *     poke best-effort, never load-bearing).
 *
 * No solid-js and no SDK imports here: the host substitutes its own solid-js
 * for the TUI ENTRY module only, so anything reactive must live in tui.tsx,
 * and keeping the SDK out lets the server half stay on the v1 injected client
 * while tests construct plain values.
 */

export const SERVICE = "background-tasks"

// The verified band is centralized in the shared library and rides the repo's
// OpenCode pin (.opencode-version) — the policy comment lives there. The host
// surfaces this package leans on: the plugin tool API (Hooks.tool + ctx.ask),
// promptAsync noReply, and the TUI surface.
export {
  every,
  isSubAgentSession,
  MAX_TIMER_MS,
  openCodeCompatNotice,
  reportTuiCompat,
  resolvePathsOnce,
  routeSessionID,
  SUPPORTED_OPENCODE_RANGE,
  singleFlight,
  tuiToast,
  unrefTimer,
} from "@macarons/permission-rules"

// ---------------------------------------------------------------------------
// Server locality (the shared classification; definition in the library)
//
// The state files and the kill-request directory describe processes on the
// SERVER's machine, so a remote attach must disable the TUI half entirely:
// local files would name the wrong machine's pids. Loopback and in-process
// both mean "this machine". `tuiGate` applies exactly that rule alongside the
// version gate — this half passes `remoteBails: true`.
// ---------------------------------------------------------------------------

export {
  type ServerLocality,
  sdkClientBaseUrl,
  serverLocality,
  tuiGate,
} from "@macarons/permission-rules"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type ServerOptions = {
  /** Inject a note into the owning session when a task exits (default true). */
  notify: boolean
  /** Toast when a task exits, in addition to the note (default true). */
  toast: boolean
  /** Append the background_run pointer to the builtin bash description (default true). */
  bashHint: boolean
  /**
   * Per-task rolling output cap. Measured in UTF-16 code units — one per byte
   * for the ASCII that terminal output overwhelmingly is; the point is a
   * memory-safety bound, not accounting.
   */
  maxBufferBytes: number
  /** Running tasks per session; background_run past this fails with guidance. */
  maxTasksPerSession: number
  /** Last-N output lines quoted in the exit notification. */
  notifyTailLines: number
  /**
   * How long a single completion notification may take to post before the
   * session's notification queue moves on without it. Notifications for one
   * session are serialized so a stale idle reading cannot turn the second into
   * a mid-turn steer; this bound keeps one unanswered post from wedging the
   * rest of that session's notes behind it.
   *
   * The floor is well above the host's busy-propagation latency on purpose. A
   * timeout is an unknown outcome, and abandoning a post BEFORE the host would
   * have recorded the turn it started is the one case where the next note could
   * still read the session as idle and land mid-turn — the very race the queue
   * exists to prevent.
   */
  notifyPostTimeoutMs: number
  /**
   * How long background_kill waits for the killed task to confirm exit before
   * it returns the provisional "not confirmed yet" result (default 8000).
   * Injectable so tests need not sit out the full window; floored well below
   * the default so a misconfiguration cannot make the tool block indefinitely.
   */
  killConfirmMs: number
}

export const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024
export const MIN_MAX_BUFFER_BYTES = 64 * 1024
export const MAX_MAX_BUFFER_BYTES = 16 * 1024 * 1024
export const DEFAULT_MAX_TASKS_PER_SESSION = 8
export const DEFAULT_NOTIFY_TAIL_LINES = 10
export const DEFAULT_NOTIFY_POST_TIMEOUT_MS = 15_000
export const MIN_NOTIFY_POST_TIMEOUT_MS = 1_000
export const DEFAULT_KILL_CONFIRM_MS = 8_000
export const MIN_KILL_CONFIRM_MS = 50

export function resolveServerOptions(raw: unknown): ServerOptions {
  const options = (raw ?? {}) as Record<string, unknown>
  return {
    notify: options.notify !== false,
    toast: options.toast !== false,
    bashHint: options.bashHint !== false,
    maxBufferBytes: clampNumber(
      options.maxBufferBytes,
      DEFAULT_MAX_BUFFER_BYTES,
      MIN_MAX_BUFFER_BYTES,
      MAX_MAX_BUFFER_BYTES,
    ),
    maxTasksPerSession: clampNumber(
      options.maxTasksPerSession,
      DEFAULT_MAX_TASKS_PER_SESSION,
      1,
      32,
    ),
    notifyTailLines: clampNumber(
      options.notifyTailLines,
      DEFAULT_NOTIFY_TAIL_LINES,
      0,
      50,
    ),
    notifyPostTimeoutMs: clampNumber(
      options.notifyPostTimeoutMs,
      DEFAULT_NOTIFY_POST_TIMEOUT_MS,
      MIN_NOTIFY_POST_TIMEOUT_MS,
      MAX_TIMER_MS,
    ),
    killConfirmMs: clampNumber(
      options.killConfirmMs,
      DEFAULT_KILL_CONFIRM_MS,
      MIN_KILL_CONFIRM_MS,
      MAX_TIMER_MS,
    ),
  }
}

export type TuiOptions = {
  /** Comma-separated keybind alternatives for the task list; undefined disables the binding. */
  keybind: string | undefined
  /** Render the sidebar widget (default true); the palette command stays either way. */
  sidebar: boolean
  /** Fallback poll interval for the state files; the poke usually beats it. */
  pollMs: number
}

export const DEFAULT_POLL_MS = 15_000
export const MIN_POLL_MS = 2_000

// No default keybind: AGENTS.md forbids shipping one without a collision
// audit, and palette + /bg cover invocation. A user opts in via options.
export function resolveTuiOptions(raw: unknown): TuiOptions {
  const options = (raw ?? {}) as Record<string, unknown>
  return {
    keybind:
      typeof options.keybind === "string" &&
      options.keybind.trim() &&
      options.keybind.trim() !== "none"
        ? options.keybind.trim()
        : undefined,
    sidebar: options.sidebar !== false,
    pollMs: clampNumber(
      options.pollMs,
      DEFAULT_POLL_MS,
      MIN_POLL_MS,
      MAX_TIMER_MS,
    ),
  }
}

// ---------------------------------------------------------------------------
// Task model
// ---------------------------------------------------------------------------

export type TaskState = "running" | "exited" | "killed" | "error"

export type TaskInstance = { id: string; pid: number; startedAt: number }

export type NotificationDeliveryState =
  | "pending"
  | "retrying"
  | "delivered"
  | "ambiguous"
  | "failed"

/** Additive delivery diagnostics shared by the tool results, state file, and TUI. */
export type NotificationDelivery = {
  /** Stable identity of the immutable logical completion batch. */
  batchID: string
  state: NotificationDeliveryState
  /** Number of delivery attempts made for this batch, including pre-dispatch failures. */
  attempts: number
  /** Caller-minted id of the most recent prompt attempt. */
  messageID?: string
  error?: string
}

export type KillReason =
  | "background_kill"
  | "timeout"
  | "session-deleted"
  | "dispose"
  | "tui"

export type TaskRecord = {
  /** "bg_<instance slug>_1", "…_2", … — see taskIdPrefix for why ids embed the instance. */
  id: string
  /** Short model-supplied label, for notifications and the TUI. */
  name?: string
  command: string
  /** Resolved absolute working directory. */
  workdir: string
  /** Owning session; every tool call is scoped to it. */
  sessionID: string
  /** ctx.agent at start; display only. */
  agent: string
  /** Process-group leader pid; absent when the spawn itself failed. */
  pid?: number
  state: TaskState
  /** Exit code; null when the process died to a signal. */
  exitCode?: number | null
  signal?: string
  killReason?: KillReason
  /** state "error": what went wrong (spawn failure, orphaned instance). */
  errorMessage?: string
  startedAt: number
  endedAt?: number
  /** Optional hard cap after which the task is killed; undefined = unlimited. */
  timeoutMs?: number
  /** Completion-prompt delivery status; absent when notification is disabled or delivered inline. */
  notificationDelivery?: NotificationDelivery
}

/** What the state file carries per task — the record plus output accounting. */
export type TaskSnapshot = TaskRecord & {
  outputBytes: number
  droppedBytes: number
  /** Bounded output tail as of the last lifecycle transition — not live. */
  recentOutput?: string
  /** Original writer carried only by a compatibility aggregate. */
  ownerInstance?: TaskInstance
  /** Whether that aggregate source was authoritative or a legacy singleton. */
  ownerFormat?: "instance" | "legacy"
}

/** Cap on the recentOutput tail carried in the state file. */
export const SNAPSHOT_TAIL_CHARS = 16 * 1024

// ---------------------------------------------------------------------------
// Output ring buffer + shared read cursor
//
// One buffer per task: merged stdout+stderr in arrival order, capped by
// evicting from the front, with a single absolute-offset coordinate system so
// "what you have not read yet" survives eviction accounting. Offsets are
// UTF-16 code units (see ServerOptions.maxBufferBytes).
// ---------------------------------------------------------------------------

type Chunk = { text: string; offset: number }

export type OutputBuffer = {
  chunks: Chunk[]
  /** Absolute end offset — total output ever appended. */
  total: number
  /** Absolute offset of the first retained char — everything before is gone. */
  dropped: number
  max: number
  /** The task's single read cursor, shared by background_output and background_wait. */
  cursor: number
}

export function createBuffer(max: number): OutputBuffer {
  return { chunks: [], total: 0, dropped: 0, max, cursor: 0 }
}

export function appendOutput(buffer: OutputBuffer, text: string): void {
  if (!text) return
  buffer.chunks.push({ text, offset: buffer.total })
  buffer.total += text.length
  // Evict from the front down to exactly max retained; an oversize first
  // chunk is sliced rather than dropped whole so the cap is precise.
  while (
    buffer.total - buffer.dropped > buffer.max &&
    buffer.chunks.length > 0
  ) {
    const first = buffer.chunks[0]
    // Unreachable: the loop guard ensures chunks is non-empty.
    if (first === undefined) break
    const excess = buffer.total - buffer.dropped - buffer.max
    if (first.text.length <= excess) {
      buffer.chunks.shift()
      buffer.dropped += first.text.length
    } else {
      buffer.chunks[0] = {
        text: first.text.slice(excess),
        offset: first.offset + excess,
      }
      buffer.dropped += excess
    }
  }
}

/** The retained text in [from, to) — clamped to what is still in the buffer. */
export function sliceBuffer(
  buffer: OutputBuffer,
  from: number,
  to?: number,
): string {
  const start = Math.max(from, buffer.dropped)
  const end = Math.min(to ?? buffer.total, buffer.total)
  if (end <= start) return ""
  const parts: string[] = []
  for (const chunk of buffer.chunks) {
    const chunkEnd = chunk.offset + chunk.text.length
    if (chunkEnd <= start) continue
    if (chunk.offset >= end) break
    parts.push(
      chunk.text.slice(
        Math.max(0, start - chunk.offset),
        Math.min(chunk.text.length, end - chunk.offset),
      ),
    )
  }
  return parts.join("")
}

export type ReadResult = {
  text: string
  /** Chars that were evicted before the cursor could read them. */
  lost: number
  from: number
  to: number
}

// Consume everything unread. `filter` selects which LINES are shown, never
// what is consumed — filtered-out output does not reappear on the next read
// (Claude Code's BashOutput filter contract).
export function readUnread(buffer: OutputBuffer, filter?: RegExp): ReadResult {
  const from = Math.max(buffer.cursor, buffer.dropped)
  const lost = from - buffer.cursor
  let text = sliceBuffer(buffer, from)
  const to = buffer.total
  buffer.cursor = buffer.total
  if (filter && text) {
    text = text
      .split("\n")
      .filter((line) => filter.test(line))
      .join("\n")
  }
  return { text, lost, from, to }
}

/** Bounded tail of the retained output, for snapshots and notifications. */
export function tailOf(buffer: OutputBuffer, maxChars: number): string {
  return sliceBuffer(buffer, Math.max(buffer.dropped, buffer.total - maxChars))
}

export function lastLines(text: string, count: number): string {
  if (count <= 0 || !text) return ""
  const lines = text.replace(/\n$/, "").split("\n")
  return lines.slice(-count).join("\n")
}

// ---------------------------------------------------------------------------
// Wait matching
// ---------------------------------------------------------------------------

export const WAIT_DEFAULT_TIMEOUT_MS = 60_000
// Parity with the builtin bash tool's MAX_TIMEOUT_MS: the longest the host
// ever lets one tool call hold a turn open.
export const WAIT_MAX_TIMEOUT_MS = 600_000

export function clampWaitTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return WAIT_DEFAULT_TIMEOUT_MS
  return Math.min(WAIT_MAX_TIMEOUT_MS, Math.floor(value))
}

// Compile without flags: matching is per line, so anchors mean line
// boundaries naturally and "m"/"g" state can never leak between scans. The
// error text is model-facing — it comes back as the failed tool call's error.
export function compileWaitPattern(source: string): RegExp | Error {
  try {
    return new RegExp(source)
  } catch (error) {
    return new Error(
      `Invalid pattern ${JSON.stringify(source)}: ${error instanceof Error ? error.message : String(error)}. Pass a JavaScript-syntax regular expression.`,
    )
  }
}

export type LineMatch = {
  line: string
  /** Offset just past the matched line's newline, relative to the scanned text. */
  end: number
}

/**
 * First line in `text` matching `pattern`. While the process is live only
 * newline-terminated lines are eligible (`requireTerminated`) — a pattern
 * must not match half a line that the next chunk completes differently; the
 * final scan after exit inspects the trailing partial line too.
 */
export function scanLinesForMatch(
  text: string,
  pattern: RegExp,
  requireTerminated: boolean,
): LineMatch | undefined {
  let start = 0
  while (start <= text.length) {
    const newline = text.indexOf("\n", start)
    if (newline === -1) {
      if (requireTerminated || start >= text.length) return undefined
      const line = text.slice(start)
      return pattern.test(line) ? { line, end: text.length } : undefined
    }
    const line = text.slice(start, newline)
    if (pattern.test(line)) return { line, end: newline + 1 }
    start = newline + 1
  }
  return undefined
}

/** Offset of the start of the trailing unterminated line (== length if none). */
export function completeLineEnd(text: string): number {
  const lastNewline = text.lastIndexOf("\n")
  return lastNewline === -1 ? 0 : lastNewline + 1
}

// ---------------------------------------------------------------------------
// Cross-half channel: per-instance state files + kill requests
// ---------------------------------------------------------------------------

export const STATE_FILE_VERSION = 1

/** Command name the server pokes over `tui.command.execute`; the TUI registers it (non-palette). */
export const SYNC_COMMAND = "background_tasks.sync"

export type TasksFile = {
  version: number
  /** Writer identity: lets a reader tell live state from a dead server's debris. */
  instance: TaskInstance
  /** Derived compatibility view for pre-instance TUI halves. */
  aggregate?: true
  updatedAt: number
  tasks: TaskSnapshot[]
}

/** Directory containing one atomically replaced snapshot per live server. */
export function tasksDirectory(stateDir: string, projectRoot: string): string {
  return path.join(stateDir, SERVICE, `tasks-${projectFileKey(projectRoot)}`)
}

const INSTANCE_FILE_NAME = /^instance-([A-Za-z0-9-]+)\.json$/

/** A writer-owned file: no server ever rewrites or removes another server's path. */
export function instanceTasksFilePath(
  tasksDir: string,
  instanceID: string,
): string {
  if (!/^[A-Za-z0-9-]+$/.test(instanceID))
    throw new Error("invalid background-task instance id")
  return path.join(tasksDir, `instance-${instanceID}.json`)
}

export function tasksFilePath(
  stateDir: string,
  projectRoot: string,
  instanceID: string,
): string {
  return instanceTasksFilePath(
    tasksDirectory(stateDir, projectRoot),
    instanceID,
  )
}

/** The old readable-key path; current servers publish a locked merged view here. */
export function legacyTasksFilePath(
  stateDir: string,
  projectRoot: string,
): string {
  return path.join(
    stateDir,
    SERVICE,
    `tasks-${projectFileKey(projectRoot)}.json`,
  )
}

export function killRequestsDir(stateDir: string, projectRoot: string): string {
  return path.join(stateDir, SERVICE, `requests-${projectFileKey(projectRoot)}`)
}

/**
 * The names pre-slug releases gave the two channel paths above. The TUI and
 * server halves are separate processes upgraded independently (`opencode
 * attach`), so the current TUI still reads both legacy state-file names and
 * current servers sweep both kill directories. Current servers publish a
 * locked aggregate into both old state names so an older TUI can still see all
 * current writers without making those shared files authoritative again.
 */
export function preSlugTasksFilePath(
  stateDir: string,
  projectRoot: string,
): string {
  return path.join(
    stateDir,
    SERVICE,
    `tasks-${shortProjectHash(projectRoot)}.json`,
  )
}

export function preSlugKillRequestsDir(
  stateDir: string,
  projectRoot: string,
): string {
  return path.join(
    stateDir,
    SERVICE,
    `requests-${shortProjectHash(projectRoot)}`,
  )
}

export type ChannelPaths = {
  projectRoot: string
  tasksDir: string
  /** Pre-instance, readable-project-key compatibility aggregate. */
  legacyStateFile: string
  killDir: string
  /** Pre-slug generation of legacyStateFile/killDir — see preSlugTasksFilePath. */
  preSlugStateFile: string
  preSlugKillDir: string
}

// Validate both the directory root and the fully derived descendants: a
// state directory inside the project, or a descendant symlink escaping the
// state directory (especially back into the agent-writable project), is not
// trusted. The channel only carries display/kill state — never an approval
// input — but a kill request is still an action, so the same containment
// rules as the suite's other trusted files apply.
export async function resolveChannelPaths(
  projectRoot: string,
  stateDir: string,
): Promise<ChannelPaths | undefined> {
  try {
    const [realRoot, realState] = await Promise.all([
      canonicalPath(projectRoot),
      canonicalPath(stateDir),
    ])
    const [
      tasksDir,
      legacyStateFile,
      killDir,
      preSlugStateFile,
      preSlugKillDir,
    ] = await Promise.all([
      canonicalPath(tasksDirectory(realState, realRoot)),
      canonicalPath(legacyTasksFilePath(realState, realRoot)),
      canonicalPath(killRequestsDir(realState, realRoot)),
      canonicalPath(preSlugTasksFilePath(realState, realRoot)),
      canonicalPath(preSlugKillRequestsDir(realState, realRoot)),
    ])
    if (isInside(realRoot, realState)) return undefined
    for (const derived of [
      tasksDir,
      legacyStateFile,
      killDir,
      preSlugStateFile,
      preSlugKillDir,
    ])
      if (isInside(realRoot, derived) || !isInside(realState, derived))
        return undefined
    return {
      projectRoot: realRoot,
      tasksDir,
      legacyStateFile,
      killDir,
      preSlugStateFile,
      preSlugKillDir,
    }
  } catch {
    return undefined
  }
}

const TASK_STATES: ReadonlySet<string> = new Set([
  "running",
  "exited",
  "killed",
  "error",
])

function parseTaskInstance(value: unknown): TaskInstance | undefined {
  if (!value || typeof value !== "object") return undefined
  const instance = value as Record<string, unknown>
  if (
    typeof instance.id !== "string" ||
    !instance.id ||
    typeof instance.pid !== "number" ||
    !Number.isFinite(instance.pid) ||
    typeof instance.startedAt !== "number" ||
    !Number.isFinite(instance.startedAt)
  )
    return undefined
  return {
    id: instance.id,
    pid: instance.pid,
    startedAt: instance.startedAt,
  }
}

function parseTaskSnapshot(value: unknown): TaskSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined
  const task = value as Record<string, unknown>
  if (typeof task.id !== "string" || !task.id) return undefined
  if (typeof task.command !== "string") return undefined
  if (typeof task.workdir !== "string") return undefined
  if (typeof task.sessionID !== "string") return undefined
  if (typeof task.agent !== "string") return undefined
  if (typeof task.state !== "string" || !TASK_STATES.has(task.state))
    return undefined
  if (typeof task.startedAt !== "number" || !Number.isFinite(task.startedAt))
    return undefined
  const optionalNumber = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? candidate
      : undefined
  const delivery = task.notificationDelivery as
    | Record<string, unknown>
    | undefined
  const deliveryState = delivery?.state
  const notificationDelivery =
    delivery &&
    typeof delivery.batchID === "string" &&
    typeof deliveryState === "string" &&
    ["pending", "retrying", "delivered", "ambiguous", "failed"].includes(
      deliveryState,
    ) &&
    typeof delivery.attempts === "number" &&
    Number.isFinite(delivery.attempts)
      ? {
          batchID: delivery.batchID,
          state: deliveryState as NotificationDeliveryState,
          attempts: delivery.attempts,
          messageID:
            typeof delivery.messageID === "string"
              ? delivery.messageID
              : undefined,
          error:
            typeof delivery.error === "string" ? delivery.error : undefined,
        }
      : undefined
  const ownerInstance = parseTaskInstance(task.ownerInstance)
  const ownerFormat =
    task.ownerFormat === "instance" || task.ownerFormat === "legacy"
      ? task.ownerFormat
      : undefined
  return {
    id: task.id,
    name: typeof task.name === "string" && task.name ? task.name : undefined,
    command: task.command,
    workdir: task.workdir,
    sessionID: task.sessionID,
    agent: task.agent,
    pid: optionalNumber(task.pid),
    state: task.state as TaskState,
    exitCode: task.exitCode === null ? null : optionalNumber(task.exitCode),
    signal: typeof task.signal === "string" ? task.signal : undefined,
    killReason:
      typeof task.killReason === "string"
        ? (task.killReason as KillReason)
        : undefined,
    errorMessage:
      typeof task.errorMessage === "string" ? task.errorMessage : undefined,
    startedAt: task.startedAt,
    endedAt: optionalNumber(task.endedAt),
    timeoutMs: optionalNumber(task.timeoutMs),
    outputBytes: optionalNumber(task.outputBytes) ?? 0,
    droppedBytes: optionalNumber(task.droppedBytes) ?? 0,
    recentOutput:
      typeof task.recentOutput === "string" ? task.recentOutput : undefined,
    ...(ownerInstance ? { ownerInstance } : {}),
    ...(ownerInstance && ownerFormat ? { ownerFormat } : {}),
    notificationDelivery,
  }
}

// Junk-tolerant, per entry: one malformed task must not blank the whole
// widget. A wrong version or a foreign shape reads as "no file".
export function parseTasksFile(value: unknown): TasksFile | undefined {
  if (!value || typeof value !== "object") return undefined
  const file = value as Record<string, unknown>
  if (file.version !== STATE_FILE_VERSION) return undefined
  const instance = parseTaskInstance(file.instance)
  if (!instance) return undefined
  if (!Array.isArray(file.tasks)) return undefined
  return {
    version: STATE_FILE_VERSION,
    instance,
    ...(file.aggregate === true ? { aggregate: true as const } : {}),
    updatedAt: typeof file.updatedAt === "number" ? file.updatedAt : 0,
    tasks: file.tasks
      .map(parseTaskSnapshot)
      .filter((task): task is TaskSnapshot => task !== undefined),
  }
}

/** undefined = missing or unreadable; treated as "no tasks" by the TUI. */
export async function loadTasksFile(
  file: string,
): Promise<TasksFile | undefined> {
  return readJsonFile(file, parseTasksFile)
}

/**
 * Load every valid writer-owned snapshot. Junk, symlinks, temporary files,
 * and files whose embedded instance does not match their name are ignored per
 * entry so one bad writer cannot blank the registry.
 */
export async function loadTasksFiles(tasksDir: string): Promise<TasksFile[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(tasksDir, { withFileTypes: true })
  } catch {
    return []
  }
  const loaded = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && INSTANCE_FILE_NAME.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const match = INSTANCE_FILE_NAME.exec(entry.name)
        const instanceID = match?.[1]
        if (!instanceID) return undefined
        const file = await loadTasksFile(path.join(tasksDir, entry.name))
        return file?.instance.id === instanceID && file.aggregate !== true
          ? file
          : undefined
      }),
  )
  return loaded.filter((file): file is TasksFile => file !== undefined)
}

// Task ids embed a slug of the writer instance's random id: concurrent or
// restarted servers for the same project share the kill-request directory and
// TUI registry, so a bare counter ("bg_1") could name two different
// processes — and a kill request must never be able to reach the wrong one,
// nor the TUI select a dead instance's debris over a live task with the same
// counter. Six hex chars (24 bits) of randomness is far beyond what the
// handful of instances a project ever sees can collide on.
export function taskIdPrefix(instanceID: string): string {
  return `bg_${instanceID.replace(/-/g, "").slice(0, 6)}_`
}

export type KillRequest = {
  taskID: string
  /** Written by the TUI; lets a non-owner sweep provably stale requests. 0 when absent. */
  requestedAt: number
}

export function parseKillRequest(value: unknown): KillRequest | undefined {
  if (!value || typeof value !== "object") return undefined
  const request = value as Record<string, unknown>
  if (request.version !== STATE_FILE_VERSION || request.action !== "kill")
    return undefined
  if (typeof request.taskID !== "string" || !request.taskID) return undefined
  const requestedAt = request.requestedAt
  return {
    taskID: request.taskID,
    requestedAt:
      typeof requestedAt === "number" && Number.isFinite(requestedAt)
        ? requestedAt
        : 0,
  }
}

// One file per request: no read-modify-write races between the TUI(s) and the
// server. writeJsonFile is tmp+rename, so the sweeper can never read a torn
// request.
export async function writeKillRequest(
  killDir: string,
  taskID: string,
): Promise<void> {
  const nonce = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36)}`
  const file = path.join(killDir, `kill-${taskID}-${nonce}.json`)
  await writeJsonFile(file, {
    version: STATE_FILE_VERSION,
    action: "kill",
    taskID,
    requestedAt: Date.now(),
  })
}

// ---------------------------------------------------------------------------
// Presentation helpers (used by both halves' text)
// ---------------------------------------------------------------------------

export function taskLabel(
  task: Pick<TaskSnapshot, "name" | "command">,
): string {
  return task.name?.trim() || task.command
}

// Row labels and elapsed times render identically here and in subagent-comms,
// which is why both plugins had grown the same two functions; the definition
// is in the library now (re-exported so both halves keep one import site).
export { formatDuration, truncateLabel }

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = exists but owned by someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export type SplitTasks = {
  /** Running, owned by the viewed session. */
  current: TaskSnapshot[]
  /** Running, owned by other sessions in this project. */
  others: TaskSnapshot[]
  finished: TaskSnapshot[]
  /** Recorded running but provably dead (dead pid or dead writer instance). */
  stale: TaskSnapshot[]
}

export function splitTasks(
  tasks: TaskSnapshot[],
  sessionID: string | undefined,
  alive: (pid: number) => boolean,
  instanceAlive: boolean,
): SplitTasks {
  const split: SplitTasks = { current: [], others: [], finished: [], stale: [] }
  for (const task of tasks) {
    if (task.state !== "running") {
      split.finished.push(task)
      continue
    }
    if (!instanceAlive || task.pid === undefined || !alive(task.pid)) {
      split.stale.push(task)
      continue
    }
    if (sessionID !== undefined && task.sessionID === sessionID)
      split.current.push(task)
    else split.others.push(task)
  }
  return split
}

// ---------------------------------------------------------------------------
// Model-facing text
//
// Written out here, not inline in the tools, so tests pin the exact wording:
// this text IS the interface the model programs against.
// ---------------------------------------------------------------------------

export function scopedTaskError(taskID: string): string {
  return `No background task "${taskID}" belongs to this session. Task ids are session-scoped; use the id returned by background_run, or start a new task with background_run.`
}

function taskTitle(task: Pick<TaskRecord, "id" | "name">): string {
  return task.name ? `${task.id} ("${task.name}")` : task.id
}

/** "exited with code 0" / "was killed (SIGTERM…)" / spawn-failure phrasing. */
export function endedPhrase(task: TaskSnapshot): string {
  if (task.state === "error")
    return `failed: ${task.errorMessage ?? "unknown error"}`
  if (task.state === "killed") {
    if (task.killReason === "timeout")
      return `was killed after exceeding its ${task.timeoutMs ?? 0} ms timeout (${task.signal ?? "SIGTERM"})`
    if (task.killReason === "tui")
      return `was killed (${task.signal ?? "SIGTERM"}, requested via the TUI)`
    return `was killed (${task.signal ?? "SIGTERM"})`
  }
  return `exited with code ${task.exitCode ?? 0}`
}

// The <background-task-update> block injected into the owning session when a
// task finishes on its own. Fenced so it is unmistakably host-generated, with
// an explicit "may ignore" tail — a completion may land mid-something-else.
export function notificationBlock(task: TaskSnapshot, tail: string): string {
  const elapsed = formatDuration(
    (task.endedAt ?? task.startedAt) - task.startedAt,
  )
  const lines = [
    "<background-task-update>",
    `Background task ${taskTitle(task)} ${endedPhrase(task)} after ${elapsed}.`,
    `Command: ${task.command}`,
  ]
  if (tail) lines.push("Last lines of output:", tail)
  else lines.push("(no output was produced)")
  lines.push("</background-task-update>")
  return lines.join("\n")
}

// Kept as one trailing line however many blocks precede it: repeating the same
// "you may ignore this" guidance per task would bury the blocks themselves.
export function notificationGuidance(ids: string[]): string {
  const target =
    ids.length === 1
      ? `background_output({ "task_id": "${ids[0]}" })`
      : `background_output for any of ${ids.map((id) => `"${id}"`).join(", ")}`
  return `Call ${target} if you need the full unread output. If ${ids.length === 1 ? "this completion is" : "these completions are"} not relevant to what you are doing now, you may ignore ${ids.length === 1 ? "it" : "them"} and continue.`
}

export function notificationText(task: TaskSnapshot, tail: string): string {
  return [notificationBlock(task, tail), notificationGuidance([task.id])].join(
    "\n",
  )
}

/**
 * One prompt for every completion that piled up while the session was busy.
 * Several tasks finishing during one long turn should cost the session one
 * interruption, not one per task.
 */
export function coalescedNotificationText(
  notes: Array<{ id: string; block: string }>,
): string {
  const first = notes[0]
  if (first && notes.length === 1)
    return [first.block, notificationGuidance([first.id])].join("\n")
  return [
    `${notes.length} background tasks finished while you were working:`,
    ...notes.map((note) => note.block),
    notificationGuidance(notes.map((note) => note.id)),
  ].join("\n")
}

export function backgroundRunDescription(maxBufferBytes: number): string {
  const cap = `${Math.round((maxBufferBytes / (1024 * 1024)) * 10) / 10} MiB`
  return `Run a shell command in the background and return immediately with a task id.

Use this instead of the bash tool when a command should keep running while you continue working: dev servers, file watchers, log tails (tail -f), and long builds or test suites that would exceed the bash timeout. The command runs in its own process group with its stdout and stderr captured (merged, ${cap} rolling buffer).

How to follow up:
- background_output reads output incrementally (only what appeared since your last read).
- background_wait blocks until a regex matches the output, the task exits, or a timeout elapses — use it when you need readiness ("Listening on port …") or the final result before continuing.
- background_kill terminates a task (SIGTERM, then SIGKILL after 3 seconds).
- When the task finishes on its own you will be NOTIFIED automatically in this conversation with its exit code and the last lines of output. Therefore: DO NOT poll with repeated background_output calls and DO NOT run sleep commands to wait — either continue with other work, or make a single background_wait call.

Rules:
- Every executable subcommand and relevant external path must pass permission checks before anything starts. Unsupported syntax or unresolved command/path expansions are rejected; use literal paths and workdir instead of inline directory changes. Execution currently requires a POSIX /bin/sh shell.
- Redirects to /dev/null and absolute executable paths may require external_directory approval; prefer a one-off approval over a broad permanent grant. External access requiring a filesystem-root grant is rejected; use a more specific directory or path.
- Tasks have no time limit unless you pass timeout_ms; kill what you start if it is no longer needed.
- Task ids are only valid within this session.
- This tool is for genuinely long-running or continuous commands. For anything expected to finish within a couple of minutes, prefer the bash tool — its result comes back inline.
- Do not use this to background interactive programs that require input; stdin is closed.`
}

export const BACKGROUND_OUTPUT_DESCRIPTION = `Read new output from a background task started with background_run.

Returns only output produced since your last read of this task (background_wait also advances the same read position). Includes the task's current status and, once it has finished, its exit code. Reading a finished task's remaining output is the normal way to collect its result if you were not waiting on it.

- Returns immediately; never blocks. To block until something happens, use background_wait instead.
- Do NOT call this in a polling loop: you will be notified in the conversation when the task finishes.
- filter is a regex applied per line to what is shown; filtered-out lines are still marked as read.
- Output is kept in a bounded buffer; if a very chatty task overflows it, the oldest unread output is dropped and the response says how much was lost.`

export const BACKGROUND_KILL_DESCRIPTION = `Stop a running background task.

On POSIX, sends SIGTERM to the task's whole process group, escalating to SIGKILL after 3 seconds if needed. Task exit and repeated kills do not reset that deadline. Returns the task's final status and any output you had not read yet. Killing a task that has already finished is not an error: on POSIX it also stops surviving group members, without changing the original exit status; on Windows it just returns the final status. Cleanup failures are reported, with at most one retry of an unconfirmed SIGKILL.

Kill tasks you no longer need — background tasks otherwise run until they exit on their own or the session ends.`

export const BACKGROUND_WAIT_DESCRIPTION = `Wait for a background task to produce specific output or to finish.

Blocks until the first of: (1) a line of new output matches \`pattern\`, (2) the task exits, (3) \`timeout_ms\` elapses (default 60000, max 600000). Returns which of these happened, the matching line if any, all task output consumed by the wait, and the exit code if the task finished. Waiting consumes output like background_output does: subsequent reads only return newer output.

Use this when you cannot proceed without the task — e.g. wait for a server's "listening" line before hitting it, or for a build to finish before using its artifacts. If you can do other useful work instead, do that: you will be notified in this conversation when the task finishes anyway. A timeout is not an error; the task keeps running and you can wait again or move on.`

// Appended to the builtin bash tool's description via the tool.definition
// hook (ServerOptions.bashHint). Keep it short: it rides every request.
export const BASH_HINT = `
For long-running or continuous commands (dev servers, watchers, tails, builds or test suites expected to exceed the timeout), do not raise the timeout or poll with sleep — use the background_run tool and continue working; you will be notified when the task completes.`

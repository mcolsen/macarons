import { type ChildProcess, spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import {
  appLogger,
  createSerialQueue,
  createSessionActivityTracker,
  mintMessageID,
  type PromptIdentity,
  promptIdentityBody,
  reportServerCompat,
  serverToast,
  sessionPromptIdentity,
  trim,
  unrefTimer,
  unsupportedVersionHooks,
  withStoreLock,
  withTimeout,
  writeJsonFile,
} from "@macarons/permission-rules"
import { type Plugin, tool } from "@opencode-ai/plugin"
import { type ProcessGroup, spawnProcessGroup } from "./process-group"
import {
  appendOutput,
  BACKGROUND_KILL_DESCRIPTION,
  BACKGROUND_OUTPUT_DESCRIPTION,
  BACKGROUND_WAIT_DESCRIPTION,
  BASH_HINT,
  backgroundRunDescription,
  type ChannelPaths,
  clampWaitTimeout,
  coalescedNotificationText,
  compileWaitPattern,
  completeLineEnd,
  createBuffer,
  endedPhrase,
  formatDuration,
  instanceTasksFilePath,
  isProcessAlive,
  lastLines,
  loadTasksFile,
  loadTasksFiles,
  MAX_TIMER_MS,
  type NotificationDelivery,
  notificationBlock,
  type OutputBuffer,
  parseKillRequest,
  readUnread,
  resolveChannelPaths,
  resolveServerOptions,
  SERVICE,
  SNAPSHOT_TAIL_CHARS,
  STATE_FILE_VERSION,
  SYNC_COMMAND,
  scanLinesForMatch,
  scopedTaskError,
  sliceBuffer,
  type TaskInstance,
  type TaskRecord,
  type TaskSnapshot,
  type TasksFile,
  tailOf,
  taskIdPrefix,
  taskLabel,
  truncateLabel,
} from "./shared"
import { analyzeShellCommand } from "./shell-permissions"

/**
 * @macarons/background-tasks — server half
 *
 * Gives the agent Claude Code-style background tasks on OpenCode. Four tools,
 * registered through the plugin tool API (Hooks.tool — the same registry
 * builtin tools live in, so tool.execute hooks and permissions see them like
 * any other tool):
 *
 *   - background_run    spawn a command in its own process group, return a
 *                       task id immediately (permission: the same "bash"
 *                       action the builtin bash tool asserts, so existing
 *                       rules and permission plugins govern it unchanged)
 *   - background_output incremental, never-blocking reads of captured output
 *   - background_kill   SIGTERM the group, SIGKILL after 3 s
 *   - background_wait   block until a regex matches, the task exits, or a
 *                       timeout — event-driven, no polling
 *
 * When a task finishes on its own the owning session is notified: an idle
 * session gets a real prompt (a model turn, like the host's experimental
 * background subagents), a busy one gets a noReply note it reads on its next
 * request. A wait/kill that already delivered the exit inline suppresses the
 * redundant note.
 *
 * The TUI half (src/tui.tsx) merges the per-instance state files this half
 * rewrites on lifecycle transitions and drops kill-request files this half
 * sweeps; see src/shared.ts for the contract.
 *
 * POSIX tasks retain a private IPC connection to a group keeper. Cleanup never
 * signals a recorded numeric PGID: losing the keeper loses that capability.
 * Old state-file records are display debris, never cleanup instructions.
 *
 * Targets OpenCode v1; verified against 1.17.18–1.18.x (plugin tool API +
 * promptAsync noReply). Outside that band it warns but runs; only OpenCode v2+
 * (whose plugin API differs) disables it. All host calls go through the injected v1 SDK
 * client — never fetch(serverUrl), which is unbound in the standalone TUI.
 */

const KILL_ESCALATION_MS = 3_000
const MAX_KILL_ESCALATIONS = 2
const SWEEP_INTERVAL_MS = 750
/**
 * A kill request whose task id carries another instance's prefix is that
 * instance's to act on and delete; this instance only sweeps it once it is
 * old enough that its owner (which sweeps every SWEEP_INTERVAL_MS while
 * anything runs) has provably abandoned it.
 */
const FOREIGN_KILL_REQUEST_TTL_MS = 60_000
const FINISHED_TTL_MS = 30 * 60_000
const MAX_FINISHED = 50
const MAX_DEBRIS = 20
const NAME_MAX_CHARS = 50
const TITLE_MAX_CHARS = 40
const NOTIFY_RETRY_DELAYS_MS = [250, 1_000] as const
const NOTIFY_CONFIRM_POLL_MS = 150
const MAX_NOTIFICATION_SESSIONS = 500

type Waiter = {
  pattern: RegExp | undefined
  /** Absolute offset where the next complete-line scan begins. */
  scanFrom: number
  settle: (outcome: WaitOutcome) => void
}

type WaitOutcome =
  | { kind: "matched"; line: string; consumed: string; lost: number }
  | { kind: "exited" }
  | { kind: "timeout" }

type LiveTask = {
  record: TaskRecord
  buffer: OutputBuffer
  child: ChildProcess
  group: ProcessGroup | undefined
  waiters: Set<Waiter>
  /** The exit already reached the model inline (wait/kill result); skip the note. */
  deliveredInline: boolean
  killWaiters: number
  killTimer: ReturnType<typeof setTimeout> | undefined
  timeoutTimer: ReturnType<typeof setTimeout> | undefined
  closed: Promise<void>
  finalized: boolean
  /** Complete means absent or sent SIGKILL, not necessarily reaped. Never reopen a PGID. */
  groupCleanup: "pending" | "complete" | "unverified"
  discardWhenClean: boolean
}

type CompletionNote = Readonly<{ id: string; block: string }>

type SessionDeliveryToken = { cancelled: boolean }

type NotificationBatch = {
  readonly id: string
  readonly sessionID: string
  readonly sessionToken: SessionDeliveryToken
  readonly notes: ReadonlyArray<CompletionNote>
  delivery: NotificationDelivery
}

export const BackgroundTasksPlugin: Plugin = async (
  { client, directory, worktree, serverUrl },
  rawOptions,
) => {
  const log = appLogger(client, SERVICE)

  const compat = await reportServerCompat({
    client,
    serverUrl,
    label: "Background tasks",
    service: SERVICE,
    log,
  })
  // Only a non-v1 host disables the plugin; the deferred toast surfaces that
  // at the first permission prompt. A merely untested v1 host runs on.
  if (compat?.disable)
    return unsupportedVersionHooks(client, directory, compat.message)

  const options = resolveServerOptions(rawOptions)
  const toast = serverToast(client, {
    directory,
    title: "Background task finished",
  })
  const root = worktree && worktree !== "/" ? worktree : directory
  const instance = {
    id: crypto.randomUUID(),
    pid: process.pid,
    startedAt: Date.now(),
  }
  // Task ids are globally unique across instances (see taskIdPrefix): the
  // kill-request directory and TUI registry are shared per project, and a bare
  // per-instance counter would let a request for one server's "bg_1" kill
  // another's.
  const idPrefix = taskIdPrefix(instance.id)

  // Permission analysis must match this shell; unsupported shells fail closed.
  const shellPath =
    process.platform === "win32"
      ? (process.env.COMSPEC ?? "cmd.exe")
      : "/bin/sh"

  // ---- registry -----------------------------------------------------------

  const tasks = new Map<string, LiveTask>()
  /** Orphaned running entries adopted from dead instance files — display debris. */
  const debris: TaskSnapshot[] = []
  /**
   * In-flight background_run reservations per session. The per-session cap is
   * checked before the permission prompts, but a task only becomes countable
   * (via runningTasks) once it is in `tasks` — several awaits later. Without a
   * reservation every concurrent run in a session clears the same pre-spawn
   * count and the cap is bypassed. Released once the task is registered, and
   * on abort, so an unanswered prompt cannot hold a slot forever.
   */
  const pendingRuns = new Map<string, number>()
  let idCounter = 0

  const ownedTask = (sessionID: string, taskID: string): LiveTask => {
    const task = tasks.get(taskID)
    // Foreign and unknown ids get the same message on purpose: task ids are
    // session-scoped, and existence elsewhere is nobody else's business.
    if (!task || task.record.sessionID !== sessionID)
      throw new Error(scopedTaskError(taskID))
    return task
  }

  const runningTasks = () =>
    [...tasks.values()].filter((task) => task.record.state === "running")

  const discardTask = (task: LiveTask, reason?: TaskRecord["killReason"]) => {
    task.discardWhenClean = true
    void killGroup(task, reason)
    if (task.finalized && task.groupCleanup !== "pending")
      tasks.delete(task.record.id)
  }

  const pruneFinished = () => {
    const now = Date.now()
    const finished = [...tasks.values()].filter(
      (task) => task.record.state !== "running" && !task.discardWhenClean,
    )
    for (const task of finished) {
      const caughtUp = task.buffer.cursor >= task.buffer.total
      const endedAt = task.record.endedAt
      if (caughtUp && endedAt !== undefined && now - endedAt > FINISHED_TTL_MS)
        discardTask(task)
    }
    // Hard cap regardless of unread output — a runaway caller must not pin
    // fifty buffers forever. `tasks` is instance-global, so this caps finished
    // tasks across EVERY session in one server lifetime, not per session.
    // Oldest first; running tasks are never pruned. A surviving group gets
    // its termination grace period before we release the record that owns it.
    const remaining = [...tasks.values()].filter(
      (task) => task.record.state !== "running" && !task.discardWhenClean,
    )
    for (const task of remaining.slice(
      0,
      Math.max(0, remaining.length - MAX_FINISHED),
    ))
      discardTask(task)
  }

  const snapshotOf = (task: LiveTask): TaskSnapshot => ({
    ...task.record,
    outputBytes: task.buffer.total,
    droppedBytes: task.buffer.dropped,
    recentOutput: tailOf(task.buffer, SNAPSHOT_TAIL_CHARS) || undefined,
  })

  // ---- instance state file + poke ----------------------------------------

  // Resolved lazily and never awaited at init: /path can deadlock plugin
  // bootstrap, and a failed resolution must degrade to "no TUI channel", not
  // disable the tools. Startup housekeeping (dead-writer adoption, stale
  // kill-request cleanup, the initial write) rides the same promise.
  const pathsPromise: Promise<ChannelPaths | undefined> = (async () => {
    try {
      const result = await client.path.get({ query: { directory } })
      const stateDir = (result.data as { state?: unknown } | undefined)?.state
      if (typeof stateDir !== "string" || !stateDir) {
        log(
          "warn",
          "no state directory from /path; the TUI channel is disabled",
        )
        return undefined
      }
      const paths = await resolveChannelPaths(root, stateDir)
      if (!paths) {
        log(
          "warn",
          "state-dir containment check failed; the TUI channel is disabled",
          { stateDir },
        )
        return undefined
      }
      // Every current server owns a distinct file. A live writer is a peer,
      // not an orphan; only a dead writer's running entries become debris.
      // Its uniquely named file can then be removed without touching peers.
      let orphaned = 0
      const adoptedInstances = new Set<string>()
      const adoptDeadTasks = (
        owner: TaskInstance,
        snapshots: TaskSnapshot[],
        updatedAt: number,
      ): boolean => {
        if (owner.id === instance.id || isProcessAlive(owner.pid)) return false
        if (!adoptedInstances.has(owner.id)) {
          adoptedInstances.add(owner.id)
          for (const task of snapshots) {
            if (task.state !== "running") continue
            const snapshot: TaskSnapshot = { ...task }
            delete snapshot.ownerInstance
            delete snapshot.ownerFormat
            debris.push({
              ...snapshot,
              state: "error",
              errorMessage: "orphaned by a previous OpenCode instance",
              endedAt: task.endedAt ?? updatedAt ?? task.startedAt,
            })
            orphaned++
          }
          while (debris.length > MAX_DEBRIS) debris.shift()
        }
        return true
      }
      const adoptDeadInstance = (previous: TasksFile): boolean => {
        if (previous.aggregate !== true)
          return adoptDeadTasks(
            previous.instance,
            previous.tasks,
            previous.updatedAt,
          )
        const owners = new Map<
          string,
          { instance: TaskInstance; tasks: TaskSnapshot[] }
        >()
        for (const task of previous.tasks) {
          const owner = task.ownerInstance ?? previous.instance
          const group = owners.get(owner.id) ?? { instance: owner, tasks: [] }
          group.tasks.push(task)
          owners.set(owner.id, group)
        }
        let adopted = false
        for (const group of owners.values())
          if (adoptDeadTasks(group.instance, group.tasks, previous.updatedAt))
            adopted = true
        return adopted
      }
      for (const previous of await loadTasksFiles(paths.tasksDir)) {
        if (!adoptDeadInstance(previous)) continue
        await fs
          .rm(instanceTasksFilePath(paths.tasksDir, previous.instance.id), {
            force: true,
          })
          .catch(() => {})
      }
      // A crashed pre-instance server can leave either legacy filename behind.
      // Adopt it once; the first aggregate sync below replaces both stale
      // single-writer files with a current merged compatibility view.
      const legacy = await Promise.all([
        loadTasksFile(paths.legacyStateFile),
        loadTasksFile(paths.preSlugStateFile),
      ])
      for (const previous of legacy) if (previous) adoptDeadInstance(previous)
      if (orphaned)
        log(
          "info",
          `marked ${orphaned} task(s) from dead instance(s) as orphaned`,
        )
      // Leftover kill requests are harmless to this instance (its fresh id
      // prefix can never match them) and may belong to a concurrent live
      // server, so they are NOT wiped here; the startup sweep below prunes
      // the provably stale ones and leaves the rest for their owner.
      return paths
    } catch (error) {
      log(
        "warn",
        `state-file channel disabled: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  })()

  // Serialized writes so this instance's snapshots can never land out of
  // order; each write is followed by a best-effort poke so an attached TUI
  // refreshes without waiting out its poll.
  const writes = createSerialQueue()
  // Once dispose() has torn the instance down and removed its state file, no
  // straggling write may resurrect it: a killed task finalizes asynchronously
  // (on the child's 'close') and would otherwise re-create the file after
  // removal, leaving a clean shutdown looking like an orphaned crash.
  let disposed = false

  // Current TUI halves read the authoritative instance directory. Older TUI
  // halves still read one of the two shared filenames, so publish a derived
  // aggregate there under an inter-process lock. Every current writer rebuilds
  // it from all instance files; no last writer can hide a peer's task.
  const syncLegacyStateFiles = async (paths: ChannelPaths) => {
    try {
      await withStoreLock(
        paths.legacyStateFile,
        async (lease) => {
          const files = await loadTasksFiles(paths.tasksDir)
          const targets = [paths.legacyStateFile, paths.preSlugStateFile]
          const compatibility = await Promise.all(
            targets.map((target) => loadTasksFile(target)),
          )
          const currentInstances = new Set(
            files.map((file) => file.instance.id),
          )
          const byTask = new Map<string, TaskSnapshot>()
          const addTasks = (
            tasks: TaskSnapshot[],
            owner: TaskInstance,
            ownerFormat: "instance" | "legacy",
          ) => {
            for (const task of tasks) {
              if (byTask.has(task.id)) continue
              byTask.set(task.id, {
                ...task,
                ownerInstance: owner,
                ownerFormat,
              })
            }
          }
          for (const file of files)
            addTasks(file.tasks, file.instance, "instance")
          // Preserve a concurrently live old server across future aggregate
          // rewrites. Current-format owners are represented only by their
          // instance files, so removing one on dispose also removes its tasks.
          const freshLegacyInstances = new Set<string>()
          for (const previous of compatibility) {
            if (!previous || previous.aggregate === true) continue
            freshLegacyInstances.add(previous.instance.id)
            if (
              currentInstances.has(previous.instance.id) ||
              !isProcessAlive(previous.instance.pid)
            )
              continue
            addTasks(previous.tasks, previous.instance, "legacy")
          }
          for (const previous of compatibility) {
            if (previous?.aggregate !== true) continue
            for (const task of previous.tasks) {
              const owner = task.ownerInstance
              if (
                !owner ||
                task.ownerFormat !== "legacy" ||
                freshLegacyInstances.has(owner.id) ||
                currentInstances.has(owner.id) ||
                !isProcessAlive(owner.pid) ||
                byTask.has(task.id)
              )
                continue
              byTask.set(task.id, {
                ...task,
                ownerInstance: owner,
                ownerFormat: "legacy",
              })
            }
          }
          if (byTask.size === 0) {
            for (const target of targets) {
              const previous = await loadTasksFile(target)
              if (previous?.aggregate !== true) continue
              await lease.assertHeld()
              await fs.rm(target, { force: true })
            }
            return
          }
          const snapshots = [...byTask.values()]
          const firstTask = snapshots[0]
          const owner =
            files.find((file) => isProcessAlive(file.instance.pid))?.instance ??
            snapshots.find((task) =>
              task.ownerInstance
                ? isProcessAlive(task.ownerInstance.pid)
                : false,
            )?.ownerInstance ??
            firstTask?.ownerInstance
          if (!owner) return
          const aggregate: TasksFile = {
            version: STATE_FILE_VERSION,
            instance: owner,
            aggregate: true,
            updatedAt: Date.now(),
            tasks: snapshots,
          }
          for (const target of targets)
            await writeJsonFile(target, aggregate, {
              beforePublish: () => lease.assertHeld(),
            })
        },
        { label: "the background-task compatibility state" },
      )
    } catch (error) {
      log(
        "warn",
        `legacy state-file sync failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const writeStateFile = () => {
    void writes
      .push(async () => {
        if (disposed) return
        const paths = await pathsPromise
        if (!paths) return
        const file: TasksFile = {
          version: STATE_FILE_VERSION,
          instance,
          updatedAt: Date.now(),
          tasks: [...debris, ...[...tasks.values()].map(snapshotOf)],
        }
        await writeJsonFile(
          instanceTasksFilePath(paths.tasksDir, instance.id),
          file,
        )
        await syncLegacyStateFiles(paths)
        await client.tui
          .publish({
            body: {
              type: "tui.command.execute",
              properties: { command: SYNC_COMMAND },
            },
            query: { directory },
          })
          .catch(() => {})
      })
      .catch((error) => {
        log(
          "warn",
          `state-file write failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  }
  void pathsPromise.then((paths) => {
    if (!paths) return
    writeStateFile()
    // Startup housekeeping: prune stale kill-request debris left by dead
    // instances (nothing here can target this instance's fresh ids).
    void sweepKillRequests()
  })

  // ---- kill-request sweeper ------------------------------------------------

  // Runs only while something is running: there is nothing to kill otherwise,
  // and an idle server should touch nothing.
  let sweeper: ReturnType<typeof setInterval> | undefined
  const sweepKillRequests = async () => {
    const paths = await pathsPromise
    if (!paths) return
    // Both filename generations: a pre-slug TUI drops its requests in the old
    // directory, and this release's TUI mirrors every request into it too, so
    // the sweep must cover both (kills are idempotent — the mirror of a
    // request already honored finds cleanup in progress or complete).
    for (const killDir of [paths.killDir, paths.preSlugKillDir]) {
      let entries: string[]
      try {
        entries = await fs.readdir(killDir)
      } catch {
        continue // ENOENT: no requests ever written
      }
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue
        const file = path.join(killDir, entry)
        try {
          const request = parseKillRequest(
            JSON.parse(await fs.readFile(file, "utf8")),
          )
          if (request) {
            if (!request.taskID.startsWith(idPrefix)) {
              // Another instance's request: acting on it is impossible (the id
              // cannot match) and deleting it fresh would eat a concurrent live
              // server's kill before its own sweeper sees it.
              if (
                Date.now() - request.requestedAt <
                FOREIGN_KILL_REQUEST_TTL_MS
              )
                continue
            } else {
              const task = tasks.get(request.taskID)
              if (task) {
                log("info", `kill requested via TUI for ${request.taskID}`)
                await killGroup(task, "tui")
              }
            }
          }
        } catch {
          // Torn/junk file: deleted below either way.
        }
        await fs.rm(file, { force: true }).catch(() => {})
      }
    }
  }
  const syncSweeper = () => {
    const shouldRun = !disposed && runningTasks().length > 0
    if (shouldRun && !sweeper) {
      sweeper = unrefTimer(
        setInterval(() => void sweepKillRequests(), SWEEP_INTERVAL_MS),
      )
    } else if (!shouldRun && sweeper) {
      clearInterval(sweeper)
      sweeper = undefined
    }
  }

  // ---- process lifecycle ---------------------------------------------------

  const completeGroupCleanup = (
    task: LiveTask,
    result: "complete" | "unverified" = "complete",
  ) => {
    if (task.groupCleanup !== "pending") return
    task.groupCleanup = result
    if (task.killTimer) clearTimeout(task.killTimer)
    task.killTimer = undefined
    task.group?.release()
    if (task.finalized && task.discardWhenClean && tasks.delete(task.record.id))
      writeStateFile()
  }

  const needsGroupCleanup = (task: LiveTask): boolean => {
    if (task.groupCleanup !== "pending") return false
    // The POSIX keeper owns an IPC capability, never a reusable numeric PGID.
    // Its closure settles cleanup separately from command/output completion.
    if (task.group || !task.finalized) return true
    // Windows retains its existing close-based behavior.
    completeGroupCleanup(task)
    return false
  }

  /**
   * Terminate a spawned command's whole process tree, not just the shell we
   * hold. A detached `sh -c "..."` forks descendants that outlive a kill aimed
   * at the shell PID alone — and they keep the stdout/stderr pipes open. Split
   * out of killGroup so the pre-registration abort/dispose gate in
   * background_run (which has a child but no LiveTask yet) terminates exactly
   * the same way normal cleanup does.
   * POSIX signals go through the keeper even after the command exits. Losing
   * its control channel must never fall back to a recorded numeric PGID.
   */
  const signalTree = async (
    child: ChildProcess,
    pid: number | undefined,
    signal: "SIGTERM" | "SIGKILL",
    group: ProcessGroup | undefined,
  ): Promise<"signalled" | "absent" | "unconfirmed"> => {
    if (group) return group.signal(signal)
    if (process.platform !== "win32") return "unconfirmed"
    // Windows has no process groups: taskkill /T walks the child tree, /F
    // because console processes have no graceful close for SIGTERM's intent
    // to map onto. The escalation timer just runs it again if the first
    // pass raced a dying tree.
    if (pid !== undefined) {
      try {
        const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        })
        killer.on("error", () => {
          try {
            child.kill(signal)
          } catch {
            // Already dead.
          }
        })
        return "unconfirmed"
      } catch {
        // taskkill unavailable; fall through to the direct kill.
      }
    }
    try {
      child.kill(signal)
    } catch {
      // Already dead.
    }
    return "unconfirmed"
  }

  const killGroup = async (
    task: LiveTask,
    reason: TaskRecord["killReason"],
  ) => {
    if (!needsGroupCleanup(task) || task.killTimer) return
    // Terminal records describe the shell's completion, not later group cleanup.
    if (!task.finalized) {
      task.record.killReason ??= reason
      task.record.signal ??=
        process.platform === "win32" ? "taskkill" : "SIGTERM"
    }
    const pid = task.record.pid
    const signalGroup = (signal: "SIGTERM" | "SIGKILL") =>
      signalTree(task.child, pid, signal, task.group)
    let escalations = 0
    const escalate = async () => {
      // Keep the guard armed while IPC acknowledgement is outstanding, too.
      if (needsGroupCleanup(task)) {
        if (!task.finalized && process.platform !== "win32")
          task.record.signal = "SIGKILL"
        // SIGKILL cannot be ignored. Do not retain zombie-only groups waiting
        // for another process to reap them, or later signal a recycled PGID.
        const result = await signalGroup("SIGKILL")
        if (task.groupCleanup !== "pending") return
        if (result !== "unconfirmed") {
          completeGroupCleanup(task)
        } else if (++escalations < MAX_KILL_ESCALATIONS) {
          task.killTimer = unrefTimer(
            setTimeout(() => void escalate(), KILL_ESCALATION_MS),
          )
        } else {
          log(
            "warn",
            `task ${task.record.id} process-group cleanup could not be confirmed after ${escalations} SIGKILL attempts; no further cleanup requests will be made`,
            { pid },
          )
          // Retire the signalling capability, not a claim that every member died.
          // Otherwise discarded tasks and their output buffers stay pinned forever.
          completeGroupCleanup(task, "unverified")
        }
      }
      pruneFinished()
      writeStateFile()
    }
    task.killTimer = unrefTimer(
      setTimeout(() => void escalate(), KILL_ESCALATION_MS),
    )
    if ((await signalGroup("SIGTERM")) === "absent") completeGroupCleanup(task)
  }

  const pumpWaiters = (task: LiveTask) => {
    if (task.waiters.size === 0) return
    const buffer = task.buffer
    for (const waiter of [...task.waiters]) {
      if (!waiter.pattern) continue // exit-only waits resolve at finalize
      const from = Math.max(waiter.scanFrom, buffer.dropped)
      const region = sliceBuffer(buffer, from)
      const match = scanLinesForMatch(region, waiter.pattern, true)
      if (match) {
        const matchEnd = from + match.end
        const consumedFrom = Math.max(buffer.cursor, buffer.dropped)
        const consumed = sliceBuffer(buffer, consumedFrom, matchEnd)
        const lost = Math.max(0, buffer.dropped - buffer.cursor)
        buffer.cursor = Math.max(buffer.cursor, matchEnd)
        task.waiters.delete(waiter)
        waiter.settle({ kind: "matched", line: match.line, consumed, lost })
      } else {
        // Advance past the complete lines just scanned; the trailing partial
        // line is re-scanned once its newline (or the exit) arrives.
        waiter.scanFrom = from + completeLineEnd(region)
      }
    }
  }

  const finalize = (
    task: LiveTask,
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error,
  ) => {
    if (task.finalized) return
    task.finalized = true
    const record = task.record
    record.state = error
      ? "error"
      : record.killReason !== undefined
        ? "killed"
        : "exited"
    if (error) record.errorMessage = error.message
    record.exitCode = code
    if (signal) record.signal = signal
    record.endedAt = Date.now()
    if (task.timeoutTimer) clearTimeout(task.timeoutTimer)
    task.timeoutTimer = undefined
    // Shell/stdio closure says nothing about redirected descendants. The keeper
    // owns cleanup independently, so command completion cannot cancel escalation.
    needsGroupCleanup(task)
    // A final scan lets a pattern match the trailing unterminated line before
    // the waiter learns the task exited; then everyone still waiting gets the
    // exit itself — which counts as inline delivery, so no duplicate note.
    pumpWaitersFinal(task)
    if (task.discardWhenClean) {
      if (task.groupCleanup !== "pending") tasks.delete(record.id)
    } else if (record.killReason !== "dispose") {
      void deliverNotification(task)
    }
    pruneFinished()
    writeStateFile()
    syncSweeper()
  }

  const pumpWaitersFinal = (task: LiveTask) => {
    const buffer = task.buffer
    for (const waiter of [...task.waiters]) {
      if (waiter.pattern) {
        const from = Math.max(waiter.scanFrom, buffer.dropped)
        const match = scanLinesForMatch(
          sliceBuffer(buffer, from),
          waiter.pattern,
          false,
        )
        if (match) {
          const matchEnd = from + match.end
          const consumedFrom = Math.max(buffer.cursor, buffer.dropped)
          const consumed = sliceBuffer(buffer, consumedFrom, matchEnd)
          const lost = Math.max(0, buffer.dropped - buffer.cursor)
          buffer.cursor = Math.max(buffer.cursor, matchEnd)
          task.waiters.delete(waiter)
          waiter.settle({ kind: "matched", line: match.line, consumed, lost })
          continue
        }
      }
      task.deliveredInline = true
      task.waiters.delete(waiter)
      waiter.settle({ kind: "exited" })
    }
  }

  /**
   * Notifications for one session are posted one at a time. Two tasks that
   * finish together would otherwise each sample idle, then each await more work
   * before posting: the first starts a model turn and the second — still
   * holding its stale "idle" — posts an ordinary prompt that lands mid-turn as
   * an unintended steer.
   */
  const notifyQueue = new Map<string, Promise<void>>()
  const enqueueNotification = (
    sessionID: string,
    work: () => Promise<void>,
  ): Promise<void> => {
    const tail = (notifyQueue.get(sessionID) ?? Promise.resolve())
      .then(work)
      .catch(() => {})
    notifyQueue.set(sessionID, tail)
    void tail.then(() => {
      if (notifyQueue.get(sessionID) === tail) notifyQueue.delete(sessionID)
    })
    return tail
  }

  /**
   * Serializing is necessary but not sufficient: the host does not EXPOSE a
   * session as busy when it accepts a prompt. Its runner has an authoritative
   * busy flag, but no non-destructive route reports it; the observable
   * SessionStatus is set separately, and promptAsync forks the prompt operation
   * and answers 204 long before that happens — `status.set(busy)` only runs
   * once the forked run reaches its message loop, several database round trips
   * later. So the note that just started a turn is still invisible to
   * both the status endpoint and the session.status event when the next note
   * samples them, and there is no atomic "prompt if idle, else noReply"
   * primitive to ask for instead. This half therefore remembers the turns it
   * started itself, for long enough to cover that gap.
   *
   * Residual, unfixable without such a host primitive: the mark is an
   * assumption. If the forked prompt fails before starting a run (the host
   * publishes session.error and never touches status), the next note is held
   * for a session that is actually idle — it goes out on the next idle
   * observation, or alongside the next completion. And a turn the user starts
   * in the window between the sample and the post still takes the note as a
   * steer.
   */
  const OPTIMISTIC_BUSY_MS = 5_000
  const optimisticBusy = new Map<string, number>()
  /**
   * Bumped wherever a session is observed idle. The mark is written after an
   * await, so without an epoch a turn that started AND finished inside that
   * window would have its idle observation overwritten by the stale mark,
   * holding the session's notes for the next OPTIMISTIC_BUSY_MS.
   */
  const busyEpoch = new Map<string, number>()

  /**
   * Completions that finished while their session was mid-turn, waiting for it
   * to end.
   *
   * A busy session CANNOT be notified safely. `noReply` does not buy what its
   * name suggests: the host persists the user message before it consults the
   * flag (createUserMessage runs first, and only then does `noReply` skip the
   * loop), and a run already in flight re-reads the message store on every step
   * and will not exit while the newest user message outranks its assistant. So
   * a note posted into a busy session is consumed as steering no matter how it
   * is flagged — the flag only decides whether an IDLE session also starts a
   * turn for it. The one way not to steer a running turn is not to write during
   * it, so notes are parked here and flushed when the session is next observed
   * idle, coalesced into a single prompt.
   */
  const pendingNotes = new Map<string, CompletionNote[]>()
  /**
   * Per session. A session that never goes idle again would otherwise grow this
   * list for as long as tasks keep finishing; the oldest are dropped first
   * because their output is the stalest — and every one of them was already
   * toasted and stays readable through background_output.
   */
  const MAX_PENDING_NOTES = 16

  const parkNotes = (
    sessionID: string,
    notes: ReadonlyArray<CompletionNote>,
  ) => {
    // Nothing will ever flush a park made after shutdown, and the busy sample
    // a disposed post takes is exactly the one that fails closed: the shared
    // signal aborts it, "not idle" comes back, and this would re-populate the
    // map dispose() just cleared.
    if (disposed) return
    const queued = [...(pendingNotes.get(sessionID) ?? []), ...notes]
    const dropped = queued.length - MAX_PENDING_NOTES
    if (dropped > 0) {
      queued.splice(0, dropped)
      log(
        "warn",
        `dropped ${dropped} undelivered completion note(s) for session ${sessionID}: the session has stayed busy`,
      )
    }
    pendingNotes.set(sessionID, queued)
    trim(pendingNotes)
  }

  /** Batches exist only once their immutable contents are ready to dispatch. */
  const activeBatches = new Map<string, NotificationBatch>()
  const parkedRetryBatches = new Map<string, NotificationBatch[]>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const sessionTokens = new Map<string, SessionDeliveryToken>()

  const sessionToken = (sessionID: string): SessionDeliveryToken => {
    const existing = sessionTokens.get(sessionID)
    if (existing) return existing
    if (sessionTokens.size >= MAX_NOTIFICATION_SESSIONS) {
      const oldestID = sessionTokens.keys().next().value
      if (oldestID !== undefined) {
        const oldest = sessionTokens.get(oldestID)
        if (oldest) {
          oldest.cancelled = true
          for (const batch of [...activeBatches.values()]) {
            if (batch.sessionToken !== oldest) continue
            finishBatch(batch, {
              ...batch.delivery,
              state: "failed",
              error: "notification was evicted by the session-delivery bound",
            })
          }
        }
        parkedRetryBatches.delete(oldestID)
        sessionTokens.delete(oldestID)
      }
    }
    const created = { cancelled: false }
    sessionTokens.set(sessionID, created)
    return created
  }

  const batchLive = (batch: NotificationBatch): boolean =>
    !disposed && activeBatches.has(batch.id) && !batch.sessionToken.cancelled

  const createBatch = (
    sessionID: string,
    notes: ReadonlyArray<CompletionNote>,
    token: SessionDeliveryToken,
  ): NotificationBatch => {
    const id = `notify_${crypto.randomUUID()}`
    return {
      id,
      sessionID,
      sessionToken: token,
      notes: Object.freeze(notes.map((note) => Object.freeze({ ...note }))),
      delivery: {
        batchID: id,
        state: "pending",
        attempts: 0,
      },
    }
  }

  const activateBatch = (
    sessionID: string,
    notes: ReadonlyArray<CompletionNote>,
    token: SessionDeliveryToken,
  ): NotificationBatch => {
    const batch = createBatch(sessionID, notes, token)
    activeBatches.set(batch.id, batch)
    setBatchDelivery(batch, batch.delivery)
    return batch
  }

  const setBatchDelivery = (
    batch: NotificationBatch,
    delivery: NotificationDelivery,
  ) => {
    batch.delivery = { ...delivery }
    for (const note of batch.notes) {
      const task = tasks.get(note.id)
      if (task) task.record.notificationDelivery = { ...delivery }
    }
    writeStateFile()
  }

  const finishBatch = (
    batch: NotificationBatch,
    delivery: NotificationDelivery,
  ) => {
    const timer = retryTimers.get(batch.id)
    if (timer) clearTimeout(timer)
    retryTimers.delete(batch.id)
    activeBatches.delete(batch.id)
    setBatchDelivery(batch, delivery)
  }

  const parkRetryBatch = (batch: NotificationBatch) => {
    if (!batchLive(batch)) return
    if (
      !parkedRetryBatches.has(batch.sessionID) &&
      parkedRetryBatches.size >= MAX_NOTIFICATION_SESSIONS
    ) {
      const oldestSessionID = parkedRetryBatches.keys().next().value
      if (oldestSessionID !== undefined) {
        const evicted = parkedRetryBatches.get(oldestSessionID) ?? []
        parkedRetryBatches.delete(oldestSessionID)
        for (const candidate of evicted)
          finishBatch(candidate, {
            ...candidate.delivery,
            state: "failed",
            error: "notification retry was evicted by the parked-session bound",
          })
      }
    }
    const parked = parkedRetryBatches.get(batch.sessionID) ?? []
    if (!parked.some((candidate) => candidate.id === batch.id))
      parked.push(batch)
    parkedRetryBatches.set(batch.sessionID, parked)
  }

  /** Hand everything parked for a session to the queue as one prompt. */
  const flushNotes = (sessionID: string) => {
    const notes = pendingNotes.get(sessionID)
    if (!notes?.length || disposed) return
    pendingNotes.delete(sessionID)
    const token = sessionToken(sessionID)
    void enqueueNotification(sessionID, () =>
      postNotes(sessionID, notes, token),
    )
  }

  const flushRetryBatches = (sessionID: string) => {
    const batches = parkedRetryBatches.get(sessionID)
    if (!batches?.length || disposed) return
    parkedRetryBatches.delete(sessionID)
    for (const batch of batches)
      void enqueueNotification(sessionID, () => retryBatch(batch))
  }

  const observedIdle = (sessionID: string) => {
    optimisticBusy.delete(sessionID)
    busyEpoch.set(sessionID, (busyEpoch.get(sessionID) ?? 0) + 1)
    trim(busyEpoch)
    // The turn that was blocking delivery has ended: this is what the parked
    // notes were waiting for.
    flushRetryBatches(sessionID)
    flushNotes(sessionID)
  }

  /** Aborted by dispose() to tear down notification requests already in flight. */
  const disposeSignal = new AbortController()

  /**
   * Busy/idle as the host reports it: session.status / session.idle events,
   * with a one-shot GET /session/status for a session no event has described
   * yet, and not-idle whenever neither can say. It shares this half's post
   * deadline and dispose signal, because a note's busy sample is one of the
   * bounded host calls the notification queue is waiting on.
   *
   * What it deliberately does NOT know is everything below: the turns this
   * half started itself (optimisticBusy), and what to do with a session that
   * turns out to be busy (parkNotes). Those are delivery policy.
   */
  const activity = createSessionActivityTracker({
    client,
    directory,
    timeoutMs: options.notifyPostTimeoutMs,
    signal: disposeSignal.signal,
  })

  /**
   * Bounds every host call a queued notification makes. Serializing per session
   * means one unanswered call no longer costs a single note — it holds every
   * later note for that session behind it — so the reads are bounded as well as
   * the post itself. Each read already treats failure as "carry on", so a
   * timeout there degrades exactly like an error.
   *
   * The deadline is enforced by ABORTING the request, not by racing a timer
   * against it. Racing only stops the waiting: the request itself stays in
   * flight, so a timed-out post could still land after the queue moved on —
   * reordering notes, or starting a turn nobody expected — and a timed-out read
   * kept its connection. The generated client passes `signal` straight to the
   * Request, and on this (v1) client an abort rejects, so the catch below still
   * reports the timeout in the caller's terms. dispose() shares the signal so
   * shutdown cancels the same way instead of leaving work running.
   */
  const withPostTimeout = <T>(
    call: (signal: AbortSignal) => Promise<T>,
    timeoutMs = options.notifyPostTimeoutMs,
  ): Promise<T> =>
    withTimeout(call, timeoutMs, {
      // dispose() shares the signal so shutdown cancels the same way instead
      // of leaving work running.
      signal: disposeSignal.signal,
      message: `the host did not answer within ${timeoutMs} ms`,
    })

  const readIdentity = async (sessionID: string): Promise<PromptIdentity> => {
    const session = await withPostTimeout((signal) =>
      client.session.get({
        path: { id: sessionID },
        query: { directory },
        signal,
      }),
    )
    if (session.error) throw new Error(JSON.stringify(session.error))
    const identity = sessionPromptIdentity(session.data)
    if (!identity.agent || !identity.model)
      throw new Error("the session reports no complete pinned agent/model")
    return identity
  }

  const confirmMessage = async (
    batch: NotificationBatch,
    messageID: string,
  ): Promise<boolean> => {
    const deadline = Date.now() + options.notifyPostTimeoutMs
    while (batchLive(batch)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      try {
        const result = await withPostTimeout(
          (signal) =>
            client.session.message({
              path: { id: batch.sessionID, messageID },
              query: { directory },
              signal,
            }),
          remaining,
        )
        if (
          !result.error &&
          (result.data as { info?: { id?: unknown } } | undefined)?.info?.id ===
            messageID
        )
          return true
      } catch {
        // A visibility failure is transient evidence until the deadline.
      }
      const delay = Math.min(
        NOTIFY_CONFIRM_POLL_MS,
        Math.max(0, deadline - Date.now()),
      )
      if (delay === 0) return false
      await new Promise<void>((resolve) => {
        unrefTimer(setTimeout(resolve, delay))
      })
    }
    return false
  }

  const markOptimisticBusy = (sessionID: string, epoch: number) => {
    if ((busyEpoch.get(sessionID) ?? 0) !== epoch) return
    optimisticBusy.set(sessionID, Date.now() + OPTIMISTIC_BUSY_MS)
    trim(optimisticBusy)
  }

  const scheduleBatchRetry = (
    batch: NotificationBatch,
    delivery: NotificationDelivery,
    freshMessageID = false,
  ) => {
    if (!batchLive(batch)) return
    const delay = NOTIFY_RETRY_DELAYS_MS[delivery.attempts - 1]
    if (delay === undefined) {
      finishBatch(batch, {
        ...delivery,
        state: "failed",
        error: delivery.error ?? "the host rejected every delivery attempt",
      })
      return
    }
    setBatchDelivery(batch, {
      ...delivery,
      state: "retrying",
      ...(freshMessageID ? { messageID: undefined } : {}),
    })
    const timer = unrefTimer(
      setTimeout(() => {
        retryTimers.delete(batch.id)
        if (!batchLive(batch)) return
        void enqueueNotification(batch.sessionID, () => retryBatch(batch))
      }, delay),
    )
    retryTimers.set(batch.id, timer)
  }

  const attemptBatch = async (
    batch: NotificationBatch,
    identity: PromptIdentity,
  ) => {
    if (!batchLive(batch)) return
    const attempts = batch.delivery.attempts + 1
    // Mint only after every pre-dispatch identity/activity await. An older ID
    // can sort behind a newer assistant and be stored without starting a turn.
    const messageID = batch.delivery.messageID ?? mintMessageID()
    const delivery: NotificationDelivery = {
      batchID: batch.id,
      state: attempts === 1 ? "pending" : "retrying",
      attempts,
      messageID,
    }
    setBatchDelivery(batch, delivery)
    const body: {
      messageID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      variant?: string
      parts: Array<{ type: "text"; text: string; synthetic: boolean }>
    } = {
      messageID,
      ...promptIdentityBody(identity),
      parts: [
        {
          type: "text",
          text: coalescedNotificationText([...batch.notes]),
          synthetic: true,
        },
      ],
    }
    if (disposed) return
    const epoch = busyEpoch.get(batch.sessionID) ?? 0
    let failure = "the host accepted the notification"
    try {
      const result = await withPostTimeout((signal) =>
        client.session.promptAsync({
          path: { id: batch.sessionID },
          query: { directory },
          body,
          signal,
        }),
      )
      if (!batchLive(batch)) return
      if (result.error) {
        const error = JSON.stringify(result.error)
        log(
          "warn",
          `host rejected completion notification ${batch.id} attempt ${attempts} for session ${batch.sessionID}: ${error}`,
        )
        scheduleBatchRetry(batch, { ...delivery, error }, true)
        return
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (!batchLive(batch)) return
    // A 204 acknowledges forked processing, not persistence. Confirm the same
    // exact ID after success or response loss; neither alone proves delivery.
    try {
      if (await confirmMessage(batch, messageID)) {
        if (!batchLive(batch)) return
        finishBatch(batch, { ...delivery, state: "delivered" })
        markOptimisticBusy(batch.sessionID, epoch)
        return
      }
    } catch {
      // A failed exact-id read is itself ambiguous, never evidence to retry.
    }
    if (!batchLive(batch)) return
    const message = `${failure}; exact message ${messageID} could not be confirmed`
    log(
      "warn",
      `completion notification ${batch.id} for session ${batch.sessionID} is ambiguous: ${message}`,
    )
    finishBatch(batch, { ...delivery, state: "ambiguous", error: message })
    // Acceptance is possible, so conservatively cover the host's delayed
    // busy propagation. A newer idle observation still wins via the epoch.
    markOptimisticBusy(batch.sessionID, epoch)
  }

  const retryBatch = async (batch: NotificationBatch) => {
    if (!batchLive(batch)) return
    let identity: PromptIdentity
    try {
      identity = await readIdentity(batch.sessionID)
    } catch (error) {
      const detail = `could not read the session identity before dispatch: ${error instanceof Error ? error.message : String(error)}`
      log(
        "warn",
        `completion notification ${batch.id} for session ${batch.sessionID} was not dispatched: ${detail}`,
      )
      scheduleBatchRetry(batch, {
        ...batch.delivery,
        attempts: batch.delivery.attempts + 1,
        error: detail,
      })
      return
    }
    if (!batchLive(batch)) return
    const busyNow =
      (optimisticBusy.get(batch.sessionID) ?? 0) > Date.now() ||
      !(await activity.isIdle(batch.sessionID))
    if (!batchLive(batch)) return
    if (busyNow) {
      parkRetryBatch(batch)
      return
    }
    await attemptBatch(batch, identity)
  }

  const deliverNotification = async (task: LiveTask) => {
    const record = task.record
    const snapshot = snapshotOf(task)
    // The toast stays outside the queue: it is fire-and-forget UI with no
    // idle dependency, and queueing it behind a slow session read would delay
    // the one signal the user actually sees.
    if (options.toast)
      toast(
        record.state === "exited" && record.exitCode === 0
          ? "success"
          : "warning",
        `${taskTitle(record)} ${endedPhrase(snapshot)}`,
      )
    if (!options.notify) return
    // A later completion is also missed-idle-event insurance for a rejected
    // batch whose retry reached a busy/unknown session.
    flushRetryBatches(record.sessionID)
    if (task.deliveredInline) return
    // Rendered now, while the record is fresh; nothing appends to the buffer
    // after finalize, so the queued half needs no state but the text.
    const tail = lastLines(
      tailOf(task.buffer, SNAPSHOT_TAIL_CHARS),
      options.notifyTailLines,
    )
    const block = notificationBlock(snapshot, tail)
    // Anything already parked for this session goes out with it. Besides
    // coalescing, this is the recovery path for a session whose idle event was
    // missed: every completion re-checks, so parked notes are never waiting on
    // one specific event to arrive.
    const notes = [
      ...(pendingNotes.get(record.sessionID) ?? []),
      { id: record.id, block },
    ]
    pendingNotes.delete(record.sessionID)
    const token = sessionToken(record.sessionID)
    await enqueueNotification(record.sessionID, () =>
      postNotes(record.sessionID, notes, token),
    )
  }

  /**
   * Deliver a session's accumulated completion notes, or park them if the
   * session turns out to be mid-turn. Runs inside the per-session queue, so the
   * busy sample it takes is the last thing before its own post.
   */
  const postNotes = async (
    sessionID: string,
    notes: ReadonlyArray<CompletionNote>,
    token: SessionDeliveryToken,
  ) => {
    if (disposed || token.cancelled) return
    const ids = notes.map((note) => note.id).join(", ")
    // Echo the owning session's pinned agent/model/variant: the host resolves
    // an omitted agent to the DEFAULT agent — not the session's own — and
    // re-pins the session, stripping a pinned variant (see
    // sessionPromptIdentity in permission-rules). Read BEFORE the busy sample
    // so the sample is the last thing that happens before the post.
    //
    // This read is FAIL-CLOSED, matching deliverNotify in subagent-comms.
    // Posting with an empty identity is not a cosmetic degradation: on 1.18.3
    // createUserMessage resolves the omitted agent to the global default and
    // calls setAgentModel whenever that differs from the pin, so a note sent
    // blind rewrites the session's agent, model and variant. That swaps the
    // agent-level permission ruleset (a plan-mode session lands in build, with
    // write and edit restored), changes provider routing and the model used
    // for every later turn, and drops variant-derived provider options. A
    // transient read failure must never buy that; the toast has already told
    // the user the task finished, and the output stays in background_output.
    let identity: PromptIdentity
    try {
      identity = await readIdentity(sessionID)
    } catch (error) {
      if (disposed || token.cancelled) return
      const batch = activateBatch(sessionID, notes, token)
      const detail = `could not read the session's pinned agent/model: ${error instanceof Error ? error.message : String(error)}`
      log(
        "warn",
        `completion notification ${batch.id} for session ${sessionID} about ${ids} was not dispatched: ${detail}; prompting without it would re-pin the session to the default agent`,
      )
      scheduleBatchRetry(batch, {
        ...batch.delivery,
        attempts: 1,
        error: detail,
      })
      return
    }
    if (disposed || token.cancelled) return
    // The turns this half started itself first — they are the ones the host
    // cannot report yet — and then what the host says. Ordered so a live mark
    // costs no request: `||` never evaluates the tracker once it holds.
    const busyNow =
      (optimisticBusy.get(sessionID) ?? 0) > Date.now() ||
      !(await activity.isIdle(sessionID))
    if (disposed || token.cancelled) return
    if (busyNow) {
      // Writing now would steer the running turn, so wait it out: the next
      // idle observation (or the next completion for this session) delivers
      // these together.
      parkNotes(sessionID, notes)
      return
    }
    const batch = activateBatch(sessionID, notes, token)
    await attemptBatch(batch, identity)
  }

  const taskTitle = (record: Pick<TaskRecord, "id" | "name">): string =>
    record.name ? `${record.id} ("${record.name}")` : record.id

  const cleanupNotice = (task: LiveTask): string[] => {
    if (task.groupCleanup === "unverified")
      return [
        "Process-group cleanup could not be confirmed; no further cleanup requests will be made. Surviving processes may need manual cleanup.",
      ]
    return task.killTimer
      ? [
          `Process-group cleanup is still pending; SIGKILL starts ${KILL_ESCALATION_MS / 1000} s after the original termination request, with one retry if signalling cannot be confirmed.`,
        ]
      : []
  }

  const statusLine = (task: LiveTask): string => {
    const record = task.record
    const status = [
      record.state === "running"
        ? `Task ${taskTitle(record)}: running (${formatDuration(Date.now() - record.startedAt)} elapsed).`
        : `Task ${taskTitle(record)}: ${endedPhrase(snapshotOf(task))} after ${formatDuration((record.endedAt ?? record.startedAt) - record.startedAt)}.`,
      ...cleanupNotice(task),
    ].join("\n")
    const delivery = record.notificationDelivery
    if (delivery?.state === "ambiguous")
      return `${status}\nCompletion notification delivery is uncertain after ${delivery.attempts} attempt(s); it was parked without reinjection.`
    if (delivery?.state === "failed")
      return `${status}\nCompletion notification delivery failed after ${delivery.attempts} attempt(s); no more retries will be made.`
    return status
  }

  const notificationMetadata = (record: TaskRecord) =>
    record.notificationDelivery
      ? { notificationDelivery: { ...record.notificationDelivery } }
      : {}

  const lostNotice = (lost: number): string[] =>
    lost > 0
      ? [
          `[... ${lost} characters of earlier output were dropped from the buffer before they were read ...]`,
        ]
      : []

  // ---- tools ---------------------------------------------------------------

  const z = tool.schema

  const background_run = tool({
    description: backgroundRunDescription(options.maxBufferBytes),
    args: {
      command: z
        .string()
        .min(1)
        .describe("Shell command to run in the background."),
      name: z
        .string()
        .max(NAME_MAX_CHARS)
        .optional()
        .describe(
          'Short human-readable label for this task (shown in notifications and the task list), e.g. "dev server" or "full test suite".',
        ),
      workdir: z
        .string()
        .optional()
        .describe(
          "Working directory. Defaults to the project directory; relative paths resolve from it.",
        ),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_TIMER_MS)
        .optional()
        .describe(
          `Optional hard time limit in milliseconds (maximum ${MAX_TIMER_MS}, ~24.8 days). When exceeded the task's whole process group is killed and you are notified. Default: no limit.`,
        ),
    },
    execute: async (args, ctx) => {
      // Reserve the slot before the first await. Everything below — both
      // permission prompts and the spawn — happens before the task lands in
      // `tasks`, so concurrent runs would otherwise all clear the same
      // pre-spawn count (see pendingRuns).
      const running = runningTasks().filter(
        (task) => task.record.sessionID === ctx.sessionID,
      )
      const reserved = pendingRuns.get(ctx.sessionID) ?? 0
      const occupied = running.length + reserved
      if (occupied >= options.maxTasksPerSession) {
        throw new Error(
          `This session already has ${occupied} running background tasks (counting any still awaiting permission approval). Wait for one with background_wait, stop one with background_kill, or read and dismiss finished ones with background_output.`,
        )
      }
      // No await between reading `reserved` above and this write, so two
      // parallel runs cannot both claim the same free slot.
      pendingRuns.set(ctx.sessionID, reserved + 1)
      let released = false
      const release = () => {
        if (released) return
        released = true
        const left = (pendingRuns.get(ctx.sessionID) ?? 1) - 1
        if (left > 0) pendingRuns.set(ctx.sessionID, left)
        else pendingRuns.delete(ctx.sessionID)
      }
      // Releasing on abort is not belt-and-braces: it is the only thing that
      // reclaims the slot. The host bridges ctx.ask on a DETACHED root fiber,
      // so interrupting the turn does not interrupt the ask — its promise never
      // settles, and the finally below never runs. The abort checkpoints around
      // the spawn keep the early release honest: a run that resumes after its
      // turn was aborted starts no process, and one already mid-spawn kills it.
      ctx.abort.addEventListener("abort", release, { once: true })
      // Adding a listener to an ALREADY-aborted signal never fires it, so the
      // release above would never run — and the ctx.ask below is bridged on a
      // detached fiber whose promise need never settle, so the finally would
      // not run either. That combination parks the reservation for the life of
      // the plugin, silently shrinking the session's cap by one. Checked after
      // registration so a signal that aborts between the two is covered too.
      if (ctx.abort.aborted) {
        release()
        throw new Error(
          "The background task was aborted before its command started.",
        )
      }
      try {
        const workdir = args.workdir
          ? path.resolve(ctx.directory, args.workdir)
          : ctx.directory
        // Analyze the entire script before prompting or spawning. Authorizing
        // the shell string as one resource lets an allowed prefix hide denies.
        const scan = await analyzeShellCommand(
          args.command,
          workdir,
          root,
          shellPath,
        )
        if (ctx.abort.aborted)
          throw new Error(
            "The background task was aborted before its command started.",
          )
        // Suite permission UIs can persist concrete prompt patterns even when
        // `always` is empty, so exposing a root `/*` prompt is never safe.
        if (scan.directories.some((dir) => dir === path.parse(dir).root))
          throw new Error(
            "Cannot safely approve external access at the filesystem root. Use a more specific working directory or path.",
          )
        await ctx.ask({
          permission: "bash",
          patterns: scan.patterns,
          always: scan.patterns,
          metadata: {
            command: args.command,
            background: true,
            ...(args.name ? { description: args.name } : {}),
          },
        })
        if (scan.directories.length) {
          if (ctx.abort.aborted)
            throw new Error(
              "The background task was aborted before its command started.",
            )
          if (disposed)
            throw new Error(
              "The background-tasks plugin shut down before the command started.",
            )
          const patterns = scan.directories.map((dir) => path.join(dir, "*"))
          await ctx.ask({
            permission: "external_directory",
            patterns,
            always: patterns,
            metadata: {
              command: args.command,
              directories: scan.directories,
              patterns,
            },
          })
        }
        // The prompts above can sit open for a long time. Starting a process now
        // for a turn that was aborted — or into an instance dispose() has already
        // walked past — would leave one nobody is watching or can kill.
        if (ctx.abort.aborted)
          throw new Error(
            "The background task was aborted before its command started.",
          )
        if (disposed)
          throw new Error(
            "The background-tasks plugin shut down before the command started.",
          )

        const id = `${idPrefix}${++idCounter}`
        const group =
          process.platform !== "win32"
            ? spawnProcessGroup(args.command, {
                cwd: workdir,
                env: process.env,
              })
            : undefined
        const child =
          group?.child ??
          spawn(args.command, [], {
            shell: shellPath,
            cwd: workdir,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
          })
        try {
          await (group?.spawned ??
            new Promise<void>((resolve, reject) => {
              child.once("spawn", resolve)
              child.once("error", reject)
            }))
        } catch (error) {
          group?.release()
          throw new Error(
            `Could not start the command: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        // Re-checked after the spawn event, which the checks above cannot cover:
        // dispose() may since have walked the task list and removed the state
        // file, and the abort listener may since have released this run's slot.
        // Registering now would leave a live process nobody tracks — or, for the
        // abort, one holding a slot the cap has already handed to someone else.
        if (disposed || ctx.abort.aborted) {
          // The whole tree, not just the shell: the command has been running
          // since the spawn event and may already have forked descendants that
          // a shell-only kill would strand (holding the pipes) with nothing
          // left tracking them.
          if (
            (await signalTree(child, child.pid, "SIGKILL", group)) ===
            "unconfirmed"
          )
            log(
              "warn",
              `pre-registration cleanup of task ${id} could not be confirmed`,
              { pid: child.pid },
            )
          group?.release()
          throw new Error(
            disposed
              ? "The background-tasks plugin shut down before the command started."
              : "The background task was aborted before its command started.",
          )
        }

        const record: TaskRecord = {
          id,
          name: args.name?.trim() || undefined,
          command: args.command,
          workdir,
          sessionID: ctx.sessionID,
          agent: ctx.agent,
          pid: child.pid,
          state: "running",
          startedAt: Date.now(),
          timeoutMs: args.timeout_ms,
        }
        let resolveClosed = () => {}
        const task: LiveTask = {
          record,
          buffer: createBuffer(options.maxBufferBytes),
          child,
          group,
          waiters: new Set(),
          deliveredInline: false,
          killWaiters: 0,
          killTimer: undefined,
          timeoutTimer: undefined,
          closed: new Promise((resolve) => {
            resolveClosed = resolve
          }),
          finalized: false,
          groupCleanup: "pending",
          discardWhenClean: false,
        }
        tasks.set(id, task)

        // Merged stdout+stderr in arrival order; one streaming decoder per
        // stream so multibyte codepoints split across chunks never corrupt.
        for (const stream of [
          group?.stdout ?? child.stdout,
          group?.stderr ?? child.stderr,
        ]) {
          if (!stream) continue
          const decoder = new TextDecoder("utf-8")
          stream.on("data", (data: Uint8Array) => {
            appendOutput(task.buffer, decoder.decode(data, { stream: true }))
            pumpWaiters(task)
          })
          stream.on("close", () => {
            appendOutput(task.buffer, decoder.decode())
          })
        }
        // 'error' can fire again after spawn (e.g. on kill failure); an
        // unhandled 'error' event would crash the server process.
        child.on("error", (error) =>
          log("warn", `task ${id} process error: ${error.message}`),
        )
        // 'close', not 'exit': close waits for the stdio streams to flush, so
        // the final output is in the buffer before waiters and notification see
        // the exit.
        const closed = (
          code: number | null,
          signal: NodeJS.Signals | null,
          error?: Error,
        ) => {
          finalize(task, code, signal, error)
          resolveClosed()
        }
        if (group) {
          void group.closed.then(
            ({ code, signal }) => closed(code, signal),
            (error: Error) => closed(null, null, error),
          )
          void group.groupClosed.then((result) => {
            if (task.groupCleanup !== "pending") return
            if (result === "unverified")
              log(
                "warn",
                `task ${id} lost its process-group keeper; cleanup could not be confirmed and no numeric PGID fallback will be attempted`,
                { pid: record.pid },
              )
            completeGroupCleanup(task, result)
            pruneFinished()
            writeStateFile()
          })
        } else child.on("close", closed)
        if (args.timeout_ms) {
          task.timeoutTimer = setTimeout(
            () => void killGroup(task, "timeout"),
            args.timeout_ms,
          )
          unrefTimer(task.timeoutTimer)
        }

        pruneFinished()
        writeStateFile()
        syncSweeper()
        log(
          "info",
          `started ${id} for session ${ctx.sessionID}: ${args.command}`,
        )
        return {
          title: `${truncateLabel(taskLabel(record), TITLE_MAX_CHARS)} (${id})`,
          output: [
            `Started background task ${taskTitle(record)}: ${args.command}`,
            "The command is now running in the background; its output is being captured.",
            `- background_output({ "task_id": "${id}" }) returns output produced since your last read.`,
            `- background_wait({ "task_id": "${id}", "pattern": "..." }) blocks until a regex matches, the task exits, or a timeout.`,
            `- background_kill({ "task_id": "${id}" }) stops it.`,
            "You will be notified automatically in this conversation when the task finishes — do NOT poll it in a loop and do NOT run sleep commands to wait for it. Continue with other work, or use background_wait if you genuinely cannot proceed without its result.",
          ].join("\n"),
          metadata: { taskId: id, pid: child.pid },
        }
      } finally {
        // The task is registered by now (or never will be), so runningTasks()
        // has taken over counting this slot.
        ctx.abort.removeEventListener("abort", release)
        release()
      }
    },
  })

  const background_output = tool({
    description: BACKGROUND_OUTPUT_DESCRIPTION,
    args: {
      task_id: z
        .string()
        .describe('Task id returned by background_run, e.g. "bg_4f9a2c_3".'),
      filter: z
        .string()
        .optional()
        .describe(
          "Optional JavaScript-syntax regex. Only output LINES matching it are shown. Unmatched lines are still consumed and will not reappear on the next read.",
        ),
    },
    execute: async (args, ctx) => {
      const task = ownedTask(ctx.sessionID, args.task_id)
      let filter: RegExp | undefined
      if (args.filter !== undefined) {
        const compiled = compileWaitPattern(args.filter)
        if (compiled instanceof Error) throw compiled
        filter = compiled
      }
      const read = readUnread(task.buffer, filter)
      const record = task.record
      return {
        title: `${truncateLabel(taskLabel(record), TITLE_MAX_CHARS)} (${record.id})`,
        output: [
          statusLine(task),
          ...lostNotice(read.lost),
          read.text || "(no new output since last read)",
        ].join("\n"),
        metadata: {
          taskId: record.id,
          state: record.state,
          ...(record.state !== "running"
            ? { exitCode: record.exitCode ?? null }
            : {}),
          newBytes: read.to - read.from,
          droppedBytes: task.buffer.dropped,
          ...notificationMetadata(record),
        },
      }
    },
  })

  const background_kill = tool({
    description: BACKGROUND_KILL_DESCRIPTION,
    args: {
      task_id: z
        .string()
        .describe('Task id returned by background_run, e.g. "bg_4f9a2c_3".'),
    },
    execute: async (args, ctx) => {
      const task = ownedTask(ctx.sessionID, args.task_id)
      const record = task.record
      const title = `${truncateLabel(taskLabel(record), TITLE_MAX_CHARS)} (${record.id})`
      if (record.state !== "running") {
        await killGroup(task, "background_kill")
        const read = readUnread(task.buffer)
        return {
          title,
          output: [
            `Task ${taskTitle(record)} had already ${endedPhrase(snapshotOf(task))}.`,
            ...cleanupNotice(task),
            ...lostNotice(read.lost),
            ...(read.text ? ["Final unread output:", read.text] : []),
          ].join("\n"),
          metadata: {
            taskId: record.id,
            state: record.state,
            exitCode: record.exitCode ?? null,
          },
        }
      }
      if (task.groupCleanup === "unverified") {
        const read = readUnread(task.buffer)
        return {
          title,
          output: [statusLine(task), ...lostNotice(read.lost), read.text]
            .filter(Boolean)
            .join("\n"),
          metadata: { taskId: record.id, state: record.state },
        }
      }
      // The kill result IS the delivery; the auto-notification would be noise.
      task.deliveredInline = true
      task.killWaiters++
      let confirmed = false
      try {
        await killGroup(task, "background_kill")
        confirmed = await Promise.race([
          task.closed.then(() => true),
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(
              () => resolve(false),
              options.killConfirmMs,
            )
            unrefTimer(timer)
          }),
        ])
        confirmed ||= task.finalized
      } finally {
        task.killWaiters--
        // A faster concurrent kill timing out must not unsuppress the exit that
        // another caller is still waiting to deliver inline.
        if (!confirmed && task.killWaiters === 0) task.deliveredInline = false
      }
      if (!confirmed) {
        // The exit was NOT delivered inline: this result only promises a
        // follow-up when it exits. Clearing the suppression flag lets finalize ->
        // deliverNotification keep that promise; the confirmed path below
        // leaves the flag set because its inline output IS the delivery.
        return {
          title,
          output: [
            `Requested termination of task ${taskTitle(record)}, but it has not confirmed exit yet. Its final status will be reported when it exits.`,
            ...cleanupNotice(task),
          ].join("\n"),
          metadata: { taskId: record.id, state: record.state },
        }
      }
      const read = readUnread(task.buffer)
      return {
        title,
        output: [
          task.record.state === "killed"
            ? `Killed background task ${taskTitle(record)} after ${formatDuration((record.endedAt ?? Date.now()) - record.startedAt)} (${record.signal ?? "SIGTERM"}).`
            : `Task ${taskTitle(record)} ${endedPhrase(snapshotOf(task))}.`,
          ...cleanupNotice(task),
          ...lostNotice(read.lost),
          "Final unread output:",
          read.text || "(none)",
        ].join("\n"),
        metadata: {
          taskId: record.id,
          state: record.state,
          exitCode: record.exitCode ?? null,
        },
      }
    },
  })

  const background_wait = tool({
    description: BACKGROUND_WAIT_DESCRIPTION,
    args: {
      task_id: z
        .string()
        .describe('Task id returned by background_run, e.g. "bg_4f9a2c_3".'),
      pattern: z
        .string()
        .optional()
        .describe(
          "JavaScript-syntax regex matched against the task's output lines. The wait resolves as soon as a line matches. Omit to wait for the task to exit.",
        ),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(600_000)
        .optional()
        .describe(
          "How long to wait in milliseconds. Default 60000, maximum 600000. Timing out is not an error; you get the output so far and the task keeps running.",
        ),
    },
    execute: async (args, ctx) => {
      const task = ownedTask(ctx.sessionID, args.task_id)
      // An already-aborted tool call must not consume the shared output cursor
      // or register a waiter whose eventual exit would suppress notification.
      if (ctx.abort.aborted) throw new Error("The wait was aborted.")
      const record = task.record
      const title = `${truncateLabel(taskLabel(record), TITLE_MAX_CHARS)} (${record.id})`
      let pattern: RegExp | undefined
      if (args.pattern !== undefined) {
        const compiled = compileWaitPattern(args.pattern)
        if (compiled instanceof Error) throw compiled
        pattern = compiled
      }
      const startedWaiting = Date.now()
      const buffer = task.buffer

      const matchedResult = (line: string, consumed: string, lost: number) => ({
        title,
        output: [
          `Matched /${pattern?.source}/ in task ${taskTitle(record)} after ${formatDuration(Date.now() - startedWaiting)}.`,
          `Matched line: ${line}`,
          ...lostNotice(lost),
          "Output up to the match:",
          consumed || "(none)",
        ].join("\n"),
        metadata: { taskId: record.id, outcome: "matched", matchedLine: line },
      })

      // A wait that is already satisfied resolves synchronously: scan the
      // unread region first (partial trailing line included once the task has
      // finished — there is no next chunk to complete it).
      if (pattern) {
        const from = Math.max(buffer.cursor, buffer.dropped)
        const match = scanLinesForMatch(
          sliceBuffer(buffer, from),
          pattern,
          record.state === "running",
        )
        if (match) {
          const matchEnd = from + match.end
          const consumed = sliceBuffer(buffer, from, matchEnd)
          const lost = Math.max(0, buffer.dropped - buffer.cursor)
          buffer.cursor = Math.max(buffer.cursor, matchEnd)
          return matchedResult(match.line, consumed, lost)
        }
      }
      if (record.state !== "running") {
        const read = readUnread(buffer)
        return {
          title,
          output: [
            `Task ${taskTitle(record)} has already ${endedPhrase(snapshotOf(task))}.`,
            ...lostNotice(read.lost),
            ...(read.text
              ? ["Remaining output:", read.text]
              : ["(no unread output)"]),
          ].join("\n"),
          metadata: {
            taskId: record.id,
            outcome: "exited",
            exitCode: record.exitCode ?? null,
          },
        }
      }

      const timeoutMs = clampWaitTimeout(args.timeout_ms)
      const outcome = await new Promise<WaitOutcome>((resolve, reject) => {
        let settled = false
        const waiter: Waiter = {
          pattern,
          scanFrom: Math.max(buffer.cursor, buffer.dropped),
          settle: (result) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            task.waiters.delete(waiter)
            ctx.abort.removeEventListener("abort", onAbort)
            resolve(result)
          },
        }
        const timer = setTimeout(() => {
          task.waiters.delete(waiter)
          waiter.settle({ kind: "timeout" })
        }, timeoutMs)
        unrefTimer(timer)
        const onAbort = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          task.waiters.delete(waiter)
          ctx.abort.removeEventListener("abort", onAbort)
          reject(new Error("The wait was aborted."))
        }
        ctx.abort.addEventListener("abort", onAbort, { once: true })
        // Listener registration does not replay a prior abort. Checking after
        // it closes that race while ensuring a dead caller inserts no waiter.
        if (ctx.abort.aborted || settled) onAbort()
        else task.waiters.add(waiter)
      })

      if (outcome.kind === "matched")
        return matchedResult(outcome.line, outcome.consumed, outcome.lost)
      if (outcome.kind === "exited") {
        const read = readUnread(buffer)
        return {
          title,
          output: [
            `Task ${taskTitle(record)} ${endedPhrase(snapshotOf(task))} while waiting (after ${formatDuration(Date.now() - startedWaiting)}).`,
            ...lostNotice(read.lost),
            "Remaining output:",
            read.text || "(none)",
          ].join("\n"),
          metadata: {
            taskId: record.id,
            outcome: "exited",
            exitCode: record.exitCode ?? null,
          },
        }
      }
      const read = readUnread(buffer)
      return {
        title,
        output: [
          `Timed out after ${timeoutMs} ms; task ${taskTitle(record)} is still running.`,
          ...lostNotice(read.lost),
          "Output during the wait:",
          read.text || "(none)",
        ].join("\n"),
        metadata: { taskId: record.id, outcome: "timeout" },
      }
    },
  })

  // ---- hooks ---------------------------------------------------------------

  return {
    tool: {
      background_run,
      background_output,
      background_kill,
      background_wait,
    },

    event: async ({ event }) => {
      // Recorded before anything awaits, so the tracker never lags the host's
      // own status map (see createSessionActivityTracker).
      const seen = activity.observe(event)
      if (!seen) return
      if (seen.activity === "busy" || seen.activity === "retry") {
        // The host has caught up; the local assumption has done its job.
        optimisticBusy.delete(seen.sessionID)
        return
      }
      // Idle, or deleted — which ends the turn that was holding delivery just
      // as surely, and whose notes the identity read below drops on their way
      // out rather than prompting a session that no longer exists.
      const sessionID = seen.sessionID
      if (seen.activity === "gone") {
        const token = sessionTokens.get(sessionID)
        if (token) token.cancelled = true
        sessionTokens.delete(sessionID)
        pendingNotes.delete(sessionID)
        parkedRetryBatches.delete(sessionID)
        for (const [batchID, batch] of activeBatches) {
          if (batch.sessionID !== sessionID) continue
          const timer = retryTimers.get(batchID)
          if (timer) clearTimeout(timer)
          retryTimers.delete(batchID)
          activeBatches.delete(batchID)
        }
        let touched = false
        for (const task of tasks.values()) {
          if (task.record.sessionID !== sessionID) continue
          touched = true
          discardTask(task, "session-deleted")
        }
        if (touched) writeStateFile()
        return
      }
      observedIdle(sessionID)
    },

    "tool.definition": async (input, output) => {
      if (!options.bashHint || input.toolID !== "bash") return
      output.description += BASH_HINT
    },

    dispose: async () => {
      // Flag first so any write a late finalize enqueues is a no-op.
      disposed = true
      if (sweeper) clearInterval(sweeper)
      sweeper = undefined
      // A straggling release computes (undefined ?? 1) - 1 === 0 and deletes,
      // so clearing here can neither go negative nor resurrect an entry.
      pendingRuns.clear()
      // Queued notifications are not awaited: the disposed guard in
      // postNotification makes whatever is still queued a no-op. Clearing the
      // queue cannot recall a note already past that guard and awaiting the
      // host, so the shared signal cancels those in flight as well.
      notifyQueue.clear()
      disposeSignal.abort()
      activity.clear()
      optimisticBusy.clear()
      busyEpoch.clear()
      // Notes waiting for a turn that will now never be observed to end.
      pendingNotes.clear()
      for (const token of sessionTokens.values()) token.cancelled = true
      sessionTokens.clear()
      for (const timer of retryTimers.values()) clearTimeout(timer)
      retryTimers.clear()
      parkedRetryBatches.clear()
      activeBatches.clear()
      const retained = [...tasks.values()]
      for (const task of retained) void killGroup(task, "dispose")
      if (retained.length > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            Promise.all(
              retained.flatMap((task) => [
                task.closed,
                task.group?.groupClosed,
              ]),
            ),
            new Promise<void>((resolve) => {
              // Intentionally referenced to keep escalation alive during this wait.
              // Finished commands can retain a keeper and redirected descendants.
              // Bound process exit as well as pipe closure from escaped descendants:
              // a slow-to-die task may still be alive when the deadline wins.
              // Keep this wait below OpenCode's shared 5 s shutdown budget.
              timer = setTimeout(resolve, KILL_ESCALATION_MS + 1_000)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      const paths = await pathsPromise
      // Drain in-flight writes before removing this instance's file so nothing
      // past the guard can land after the rm and re-create it. The unique path
      // means shutdown cannot erase another live server's state.
      await writes.drain()
      if (paths) {
        await fs
          .rm(instanceTasksFilePath(paths.tasksDir, instance.id), {
            force: true,
          })
          .catch(() => {})
        await syncLegacyStateFiles(paths)
      }
    },
  }
}

import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import {
  type ChannelPaths,
  every,
  formatDuration,
  isProcessAlive,
  isSubAgentSession,
  loadTasksFile,
  loadTasksFiles,
  resolveChannelPaths,
  resolvePathsOnce,
  resolveTuiOptions,
  routeSessionID,
  SYNC_COMMAND,
  singleFlight,
  splitTasks,
  type TaskSnapshot,
  type TasksFile,
  taskLabel,
  truncateLabel,
  tuiGate,
  tuiToast,
  unrefTimer,
  writeKillRequest,
} from "./shared"

/**
 * @macarons/background-tasks — TUI companion
 *
 * Shows the agent's background tasks while they run, and lets the user act on
 * them without asking the agent:
 *
 *   - a sidebar section listing the viewed session's running tasks (name,
 *     elapsed, state), recently finished ones, and a one-line count of tasks
 *     other sessions own — rendered only when there is something to show;
 *   - a palette command ("Background tasks: list / kill", /bg) opening a task
 *     list: kill a task (a confirm first), copy its captured output, or jump
 *     to the owning session.
 *
 * The server half (src/index.ts) owns the processes. This half only merges the
 * instance state files servers maintain and drops kill-request files they
 * sweep; see src/shared.ts for the contract. Updates arrive by poke (the server
 * publishes a `tui.command.execute` for SYNC_COMMAND after each state write)
 * with a slow content-gated poll as the fallback, so a missed poke costs
 * staleness, never correctness.
 *
 * Toasts on task completion come from the SERVER half; the only toast this
 * half owns is the kill-request watchdog's failure warning.
 *
 * No default keybind (AGENTS.md rule 2): palette + /bg suffice, and a user
 * can bind one via the `keybind` option (first alternative shown in the
 * palette, the rest functional but hidden from its non-shrinking hint
 * column).
 *
 * Targets OpenCode v1 (verified against 1.17.18–1.18.x), like the server half:
 * warns outside that band, disables only on OpenCode v2+.
 */

const LIST = "background_tasks.list"
const CATEGORY = "Background tasks"
const SIDEBAR_LIMIT = 5
const SIDEBAR_LABEL_CHARS = 22
const DIALOG_LABEL_CHARS = 44
const DIALOG_COMMAND_CHARS = 60
/** How long a finished task stays in the sidebar after ending. */
const FINISHED_VISIBLE_MS = 60_000
const POKE_DEBOUNCE_MS = 100
const KILL_WATCHDOG_MS = 5_000

function glyph(task: TaskSnapshot): string {
  if (task.state === "running") return "▶"
  if (task.state === "killed") return "◼"
  if (task.state === "error" || (task.exitCode ?? 0) !== 0) return "✗"
  return "✓"
}

function statusWord(task: TaskSnapshot, now: number): string {
  let status: string
  if (task.state === "running") status = formatDuration(now - task.startedAt)
  else if (task.state === "killed") status = "killed"
  else if (task.state === "error") status = "error"
  else status = `exit ${task.exitCode ?? 0}`
  if (task.notificationDelivery?.state === "ambiguous")
    return `${status} · notify uncertain`
  if (task.notificationDelivery?.state === "failed")
    return `${status} · notify failed`
  return status
}

export const tui: TuiPlugin = async (api, rawOptions) => {
  // The state files and kill requests describe processes on the SERVER's
  // machine. In-process and loopback attaches are this machine; a remote
  // attach (or an unidentifiable transport) makes both meaningless, so the
  // plugin stays out of the way entirely.
  const gate = tuiGate(api, {
    label: "background-tasks",
    service: "background-tasks",
    remoteBails: true,
  })
  if (gate.disabled) return

  const options = resolveTuiOptions(rawOptions)
  const theme = () => api.theme.current
  const toast = tuiToast(api)

  // All reactive state lives HERE, in the entry module: the host substitutes
  // its own solid-js for this module only, and signals created anywhere else
  // hold values but never notify the UI.
  const [tasksFiles, setTasksFiles] = createSignal<TasksFile[]>([])
  const [now, setNow] = createSignal(Date.now())
  const [pendingKills, setPendingKills] = createSignal<ReadonlySet<string>>(
    new Set(),
  )

  // Resolved once the host's path sync lands, then cached; see
  // resolvePathsOnce for why resolving against the placeholders would latch
  // wrong paths for the TUI's lifetime.
  const resolveChannelPathsOnce = resolvePathsOnce<ChannelPaths>(
    api,
    ({ projectRoot, state }) => resolveChannelPaths(projectRoot, state),
    { require: ["state"] },
  )

  // Single-flight registry read. A poke or poll landing mid-read queues exactly
  // one follow-up, so bursts collapse to two reads. Current per-instance files
  // are authoritative; the two old single-file names remain compatibility
  // inputs for either previous filename generation.
  let lastRead = ""
  const sync = singleFlight(
    async (force: boolean): Promise<void> => {
      const paths = await resolveChannelPathsOnce()
      if (!paths) return
      const [current, legacy, preSlug] = await Promise.all([
        loadTasksFiles(paths.tasksDir),
        loadTasksFile(paths.legacyStateFile),
        loadTasksFile(paths.preSlugStateFile),
      ])
      // Old server halves mirror the same instance into both legacy names.
      // When current instance sources exist, expand only the legacy
      // portions carried by an aggregate; its current-format tasks would just
      // duplicate those authoritative files. With no sources, keep the whole
      // aggregate as crash debris.
      const currentInstances = new Set(current.map((file) => file.instance.id))
      const compatibility = [legacy, preSlug].flatMap((file): TasksFile[] => {
        if (!file) return []
        if (file.aggregate !== true || current.length === 0) return [file]
        const byOwner = new Map<string, TasksFile>()
        for (const task of file.tasks) {
          const owner = task.ownerInstance
          if (
            !owner ||
            task.ownerFormat !== "legacy" ||
            currentInstances.has(owner.id)
          )
            continue
          const source = byOwner.get(owner.id) ?? {
            version: file.version,
            instance: owner,
            aggregate: true,
            updatedAt: file.updatedAt,
            tasks: [],
          }
          source.tasks.push(task)
          byOwner.set(owner.id, source)
        }
        return [...byOwner.values()]
      })
      // Prefer the newest compatibility copy, while current instance files
      // naturally win a timestamp tie because they are visited first.
      const byInstance = new Map<string, TasksFile>()
      for (const file of [...current, ...compatibility]) {
        if (!file) continue
        const previous = byInstance.get(file.instance.id)
        if (!previous || file.updatedAt > previous.updatedAt)
          byInstance.set(file.instance.id, file)
      }
      const files = [...byInstance.values()].sort(
        (left, right) =>
          left.instance.startedAt - right.instance.startedAt ||
          left.instance.id.localeCompare(right.instance.id),
      )
      const read = JSON.stringify(files)
      if (!force && read === lastRead) return
      lastRead = read
      setTasksFiles(files)
    },
    { followUp: [true] },
  )

  // Trailing-debounced poke target: a burst of state writes → one read.
  let pokeTimer: ReturnType<typeof setTimeout> | undefined
  const pokeSync = () => {
    if (pokeTimer) return
    pokeTimer = unrefTimer(
      setTimeout(() => {
        pokeTimer = undefined
        void sync(true)
      }, POKE_DEBOUNCE_MS),
    )
  }

  // The server's poke arrives as a `tui.command.execute` for SYNC_COMMAND.
  // Consumed two redundant ways — the plugin event bus, and a registered
  // (non-palette, so invisible) command in case the host routes the event
  // through the keymap dispatcher instead. Whichever fires, pokeSync
  // debounces the duplicates away.
  const unsubscribePoke = api.event.on("tui.command.execute", (event) => {
    if (event.properties.command === SYNC_COMMAND) pokeSync()
  })

  void sync(false)
  const poller = every(() => void sync(false), options.pollMs)

  // 1 s elapsed-time ticker; short-circuits to zero signal churn while
  // nothing is running.
  const anyRunning = () =>
    tasksFiles().some((file) =>
      file.tasks.some((task) => task.state === "running"),
    )
  const ticker = every(() => {
    if (anyRunning()) setNow(Date.now())
  }, 1_000)

  // ---- derived task views --------------------------------------------------

  const EMPTY = { current: [], others: [], finished: [], stale: [] }
  // A plain function, not a memo: it reads the tasksFiles signal on every call
  // so callers always see the latest state, and the read still tracks inside
  // the sidebar View's memo for reactivity. Liveness is evaluated per writer,
  // so one crashed server cannot make a live peer's tasks look stale.
  const groupsForSession = (sessionID: string | undefined) => {
    const groups = {
      current: [] as TaskSnapshot[],
      others: [] as TaskSnapshot[],
      finished: [] as TaskSnapshot[],
      stale: [] as TaskSnapshot[],
    }
    const seen = new Set<string>()
    for (const file of tasksFiles()) {
      const unique = file.tasks.filter((task) => {
        if (seen.has(task.id)) return false
        seen.add(task.id)
        return true
      })
      for (const task of unique) {
        const split = splitTasks(
          [task],
          sessionID,
          isProcessAlive,
          isProcessAlive(task.ownerInstance?.pid ?? file.instance.pid),
        )
        groups.current.push(...split.current)
        groups.others.push(...split.others)
        groups.finished.push(...split.finished)
        groups.stale.push(...split.stale)
      }
    }
    return groups
  }

  const taskByID = (taskID: string) =>
    tasksFiles()
      .flatMap((file) => file.tasks)
      .find((task) => task.id === taskID)

  const viewedSessionID = (): string | undefined => routeSessionID(api)

  // ---- kill flow -----------------------------------------------------------

  const requestKill = async (task: TaskSnapshot) => {
    const pathsPromise = resolveChannelPathsOnce()
    const resolved = pathsPromise ? await pathsPromise : undefined
    if (!resolved) {
      toast(
        "warning",
        "OpenCode's paths are still syncing — try again in a moment.",
      )
      return
    }
    try {
      // Both filename generations, and the request FAILS unless both land:
      // the attached server half may be a pre-slug release that only sweeps
      // the old directory, and a kill button must never claim a request a
      // server cannot see. The unconsumed copy is swept as foreign debris
      // after its TTL.
      await Promise.all([
        writeKillRequest(resolved.killDir, task.id),
        writeKillRequest(resolved.preSlugKillDir, task.id),
      ])
    } catch (error) {
      toast(
        "error",
        `Could not write the kill request: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    setPendingKills((previous) => new Set(previous).add(task.id))
    // The only TUI-originated toast in the kill flow, and only on failure:
    // if the server half never picks the request up, say so instead of
    // leaving a silently ignored button.
    unrefTimer(
      setTimeout(() => {
        void (async () => {
          await sync(true)
          setPendingKills((previous) => {
            const next = new Set(previous)
            next.delete(task.id)
            return next
          })
          const current = taskByID(task.id)
          if (
            current?.state === "running" &&
            current.pid !== undefined &&
            isProcessAlive(current.pid)
          ) {
            toast(
              "warning",
              "Kill request not picked up — is the background-tasks server half installed?",
            )
          }
        })()
      }, KILL_WATCHDOG_MS),
    )
  }

  // ---- dialogs -------------------------------------------------------------
  // Every transition replaces the single-occupancy dialog; Esc simply closes.

  const openTaskList = () => {
    void sync(true)
    const currentSession = viewedSessionID()
    api.ui.dialog.replace(
      () => {
        const groups = groupsForSession(currentSession)
        const ordered: Array<{ task: TaskSnapshot; category: string }> = [
          ...groups.current.map((task) => ({ task, category: "This session" })),
          ...groups.others.map((task) => ({
            task,
            category: "Other sessions",
          })),
          ...groups.finished.map((task) => ({ task, category: "Finished" })),
          ...groups.stale.map((task) => ({
            task,
            category: "Stale (server gone)",
          })),
        ]
        return api.ui.DialogSelect<string>({
          title: "Background tasks",
          placeholder: "Select a task",
          options: ordered.map(({ task, category }) => ({
            title: `${glyph(task)} ${truncateLabel(taskLabel(task), DIALOG_LABEL_CHARS)} · ${statusWord(task, now())}${pendingKills().has(task.id) ? " · killing…" : ""}`,
            value: task.id,
            description: truncateLabel(task.command, DIALOG_COMMAND_CHARS),
            category,
            onSelect: () => openTaskActions(task.id),
          })),
        })
      },
      () => {},
    )
  }

  const openTaskActions = (taskID: string) => {
    const task = taskByID(taskID)
    if (!task) {
      openTaskList()
      return
    }
    const killable = task.state === "running" && !pendingKills().has(task.id)
    api.ui.dialog.replace(
      () =>
        api.ui.DialogSelect<string>({
          title: `${glyph(task)} ${truncateLabel(taskLabel(task), DIALOG_LABEL_CHARS)} — ${truncateLabel(task.command, DIALOG_COMMAND_CHARS)}`,
          options: [
            {
              title: "Kill task",
              value: "kill",
              description: killable
                ? "SIGTERM the process group; SIGKILL after 3 s"
                : "Not running",
              disabled: !killable,
              onSelect: () => confirmKill(task),
            },
            {
              title: "Copy recent output",
              value: "copy",
              description: "Captured output as of the last state change",
              onSelect: () => copyOutput(task),
            },
            {
              title: "Go to session",
              value: "session",
              description: `Open the owning session (${task.sessionID})`,
              onSelect: () => {
                api.ui.dialog.clear()
                api.route.navigate("session", { sessionID: task.sessionID })
              },
            },
            { title: "Back", value: "back", onSelect: openTaskList },
          ],
        }),
      () => {},
    )
  }

  const confirmKill = (task: TaskSnapshot) => {
    api.ui.dialog.replace(
      () =>
        api.ui.DialogConfirm({
          title: `Kill ${truncateLabel(taskLabel(task), DIALOG_LABEL_CHARS)}?`,
          message:
            "The kill request goes to the OpenCode server; the task's whole process group is terminated.",
          onConfirm: () => {
            void requestKill(task)
            openTaskList()
          },
          onCancel: () => openTaskActions(task.id),
        }),
      () => {},
    )
  }

  const copyOutput = (task: TaskSnapshot) => {
    const output = task.recentOutput ?? ""
    if (!output) {
      toast("info", "No captured output for this task yet.")
      return
    }
    try {
      const copied = api.renderer.copyToClipboardOSC52(output)
      toast(
        copied ? "success" : "warning",
        copied
          ? "Task output copied."
          : "Clipboard not available in this terminal.",
      )
    } catch {
      toast("warning", "Clipboard not available in this terminal.")
    }
  }

  const runList = () => {
    if (!resolveChannelPathsOnce()) {
      toast(
        "info",
        "OpenCode's paths are still syncing — try again in a moment.",
      )
      return
    }
    openTaskList()
  }

  // ---- commands + optional keybind ----------------------------------------

  const keys = options.keybind
    ? options.keybind
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean)
    : []
  const [firstKey] = keys
  api.keymap.registerLayer({
    commands: [
      {
        name: LIST,
        title: "Background tasks: list / kill",
        desc: "Show the agent's background tasks; kill one or copy its output",
        category: CATEGORY,
        namespace: "palette",
        slashName: "bg",
        slashAliases: ["bgtasks"],
        run: runList,
      },
      // The server's poke target. No namespace, so it appears in no palette;
      // dispatching it in a TUI without this plugin is a keymap "not-found"
      // no-op.
      { name: SYNC_COMMAND, run: () => pokeSync() },
    ],
    bindings: [
      // Only the first alternative is bound to the command NAME: the palette
      // shows every named binding in a non-shrinking column that clips
      // titles. The remaining alternatives bind to a function — functional,
      // but invisible to the palette.
      ...(firstKey !== undefined
        ? [
            {
              key: firstKey,
              cmd: LIST,
              desc: "Background tasks",
              group: CATEGORY,
            },
          ]
        : []),
      ...(keys.length > 1
        ? [
            {
              key: keys.slice(1).join(","),
              cmd: () => runList(),
              desc: "Background tasks",
              group: CATEGORY,
            },
          ]
        : []),
    ],
  })

  // ---- sidebar widget ------------------------------------------------------

  function View(props: { session_id: string }) {
    // Sub-agent sessions never show a sidebar of their own.
    const groups = createMemo(() =>
      isSubAgentSession(api, props.session_id)
        ? EMPTY
        : groupsForSession(props.session_id),
    )
    const rows = createMemo(() => {
      const finishedHere = groups().finished.filter(
        (task) =>
          task.sessionID === props.session_id &&
          (task.endedAt ?? task.startedAt) + FINISHED_VISIBLE_MS > now(),
      )
      return [...groups().current, ...finishedHere]
    })
    const otherCount = () => groups().others.length
    const shown = () => rows().slice(0, SIDEBAR_LIMIT)
    const stateColor = (task: TaskSnapshot) => {
      if (task.state === "running") return theme().textMuted
      if (task.state === "error" || (task.exitCode ?? 0) !== 0)
        return theme().error
      if (
        task.notificationDelivery?.state === "ambiguous" ||
        task.notificationDelivery?.state === "failed"
      )
        return theme().warning
      if (task.state === "killed") return theme().warning
      return theme().success
    }
    return (
      <Show when={rows().length > 0 || otherCount() > 0}>
        <box>
          <text fg={theme().text}>
            <b>Background tasks</b>
          </text>
          <For each={shown()}>
            {(task) => (
              <text fg={theme().textMuted}>
                <span style={{ fg: stateColor(task) }}>{glyph(task)} </span>
                {truncateLabel(taskLabel(task), SIDEBAR_LABEL_CHARS)}{" "}
                {statusWord(task, now())}
              </text>
            )}
          </For>
          <Show when={rows().length > SIDEBAR_LIMIT}>
            <text fg={theme().textMuted}>
              {"  "}…{rows().length - SIDEBAR_LIMIT} more (/bg)
            </text>
          </Show>
          <Show when={otherCount() > 0}>
            <text fg={theme().textMuted}>
              {"  "}+{otherCount()} in other sessions
            </text>
          </Show>
        </box>
      </Show>
    )
  }

  if (options.sidebar) {
    // Between the host's Context section (100) and MCP (200), just under
    // the limits widgets (150/152): live workload belongs next to live quota.
    api.slots.register({
      order: 160,
      slots: {
        sidebar_content: (_ctx, props) => (
          <View session_id={props.session_id} />
        ),
      },
    })
  }

  api.lifecycle.onDispose(() => {
    clearInterval(poller)
    clearInterval(ticker)
    if (pokeTimer) clearTimeout(pokeTimer)
    unsubscribePoke()
  })
}

const plugin: TuiPluginModule = {
  id: "opencode-background-tasks",
  tui,
}

export default plugin

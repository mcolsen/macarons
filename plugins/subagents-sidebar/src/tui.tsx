import {
  every,
  rejectNumber,
  routeSessionID,
  tuiGate,
  warnTui,
} from "@macarons/permission-rules"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, Show, type Signal } from "solid-js"
import {
  type ChildProbe,
  dedupeSightings,
  isActive,
  isSubAgentSession,
  phaseGlyph,
  rowLabel,
  rowOf,
  type SubagentRow,
  type SubagentSighting,
  sightingOf,
  splitRows,
  statusWord,
  truncateLabel,
} from "./core"

/**
 * opencode-subagents-sidebar
 *
 * A quick overview of the viewed session's subagents in the OpenCode sidebar
 * — who is running, on what, for how long, and whether one is stuck waiting
 * on the user:
 *
 *   Subagents
 *     ▶ explore: find the sync path 1m24s
 *     ! claude: fix the flaky test waiting on you   (warning color)
 *     ✓ plan: design the approach done
 *
 * The stock TUI shows a subagent's existence only inline in the parent's
 * transcript (where it scrolls away) and its detail only once you navigate
 * into the child session; this section keeps the live picture in view. Rows
 * come straight from the parent session's spawn tool parts — the stock
 * `task` tool AND subagent-comms' `subagent_spawn`, which writes the same
 * part contract (see core.ts SPAWN_TOOLS) — carrying the agent type, the
 * parent's own description, the child session id, and start/end times —
 * refined by the child session's synced status: a pending permission or
 * question in the child turns its row (and the section title) into a
 * warning-colored "waiting on you", the state a parent-session overview most
 * needs to surface. Background runs (whose tool part completes at LAUNCH:
 * `task` with background=true, and every `subagent_spawn`) stay listed while
 * the child session's own status is busy. Finished subagents linger briefly
 * with a ✓/✗ verdict, then fade.
 *
 * A palette command ("Subagents: list / open", /subagents) opens the same
 * rows as a dialog and jumps to any subagent's session on select — including
 * ones already finished, which the sidebar has faded but the dialog keeps
 * for the plugin's lifetime.
 *
 * The engine keeps its own per-parent record of every task part it has seen:
 * the host TUI syncs only a session's newest 100 messages, so a long-running
 * subagent's spawning part would otherwise age out of the store and the row
 * would vanish while the subagent still works. A session read for the first
 * time also hydrates once from its full server-side message history — the
 * store walk and the bus can only cover what happened since the TUI
 * attached, and a cold or remote attach must still find spawns older than
 * the 100-message window. Pending requests and child statuses hydrate at
 * startup and per reconnect because the host's event-built stores do not
 * reconcile an event gap; current children hydrate with each parent so a
 * deletion missed during that gap cannot leave a dead row. Sub-agent sessions
 * themselves never render the section (suite convention: a child has no
 * standing of its own in the sidebar), though nested spawns still track under
 * their own parent, so viewing a mid-depth session shows ITS children.
 *
 * No default keybind (AGENTS.md rule 2): palette + /subagents suffice, and a
 * user can bind one via the `keybind` option.
 *
 * Install by loading this file from a `tui.json` `plugin` array, or run
 * `opencode plugin <path-to-this-package>`. This plugin is TUI-only; it reads
 * the session state the host already syncs plus read-only history and
 * pending-request list fetches, so it works on local and remote attaches
 * alike.
 *
 * Options (second element of a `["file://…", {…}]` plugin entry). An
 * out-of-range or wrong-typed value is ignored with one startup warning toast
 * and the documented default is used — never silently accepted (the suite's
 * house rule, audit L-UM3):
 *   - finishedLingerSeconds: number > 0 — how long a finished subagent's row
 *     stays in the sidebar (default 60, background-tasks' finished window).
 *   - sidebar: boolean — set false to skip the sidebar section and keep only
 *     the palette command (default true).
 *   - keybind: string — comma-separated keybind alternatives for the list
 *     dialog; no default.
 *
 * Targets OpenCode v1, like the rest of this repo. The verified band is the
 * shared SUPPORTED_OPENCODE_RANGE (1.18.10–1.18.x, riding the repo's
 * OpenCode pin); other v1 releases run behind the unverified-host warning,
 * and only OpenCode v2+ disables the plugin.
 */

const LIST = "subagents.list"
const CATEGORY = "Subagents"
const SIDEBAR_LIMIT = 5
const SIDEBAR_LABEL_CHARS = 24
const DIALOG_LABEL_CHARS = 44
const DEFAULT_FINISHED_LINGER_MS = 60_000

/**
 * How many parent sessions the engine tracks at once, evicted by recency —
 * the same bound and idiom as cache-ratio's session map. A Tracking is O(the
 * session's task calls), so the map is the plugin's real footprint; 64 is far
 * beyond the handful a person moves between while still bounding a long-lived
 * attach to a busy server.
 */
export const MAX_TRACKED_SESSIONS = 64

type ResolvedOptions = {
  lingerMs: number
  sidebar: boolean
  keybind: string | undefined
}

export function resolveOptions(options: Record<string, unknown> | undefined): {
  options: ResolvedOptions
  problems: string[]
} {
  const problems: string[] = []
  // 0 would clear a finished row on the next macrotask: set, unset, never
  // seen. A user who wants no linger is asking the sidebar to hide finishes,
  // which `sidebar: false` (or ignoring the section) already covers.
  const lingerSeconds = rejectNumber({
    key: "finishedLingerSeconds",
    value: options?.finishedLingerSeconds,
    range: "greater than 0",
    accepts: (value) => value > 0,
    problems,
  })
  // Held to the same rule as the numbers rather than read as `!== false`,
  // which would quietly resolve `sidebar: "false"` — the near-miss that
  // actually gets written into JSON — to the default TRUE with no warning.
  const sidebar = ((): boolean | undefined => {
    const value = options?.sidebar
    if (value === undefined) return undefined
    if (typeof value === "boolean") return value
    problems.push(
      `sidebar must be a boolean (ignoring ${JSON.stringify(value) ?? String(value)})`,
    )
    return undefined
  })()
  const keybind = ((): string | undefined => {
    const value = options?.keybind
    if (value === undefined) return undefined
    if (typeof value === "string")
      return value.trim() && value.trim() !== "none" ? value.trim() : undefined
    problems.push(
      `keybind must be a string (ignoring ${JSON.stringify(value) ?? String(value)})`,
    )
    return undefined
  })()
  return {
    options: {
      lingerMs:
        lingerSeconds !== undefined
          ? lingerSeconds * 1000
          : DEFAULT_FINISHED_LINGER_MS,
      sidebar: sidebar ?? true,
      keybind,
    },
    problems,
  }
}

export const tui: TuiPlugin = async (api, options) => {
  // No remote bail, deliberately: this half reads nothing but session state
  // the host has already synced to this machine — messages, parts, session
  // statuses — so a remote attach shows exactly the right subagents for the
  // session on screen.
  const gate = tuiGate(api, {
    label: "Subagents",
    service: "subagents-sidebar",
    remoteBails: false,
  })
  if (gate.disabled) return

  const { options: opts, problems } = resolveOptions(options)
  // ONE toast for all problems: a mistyped tuple trips several checks at
  // once, and stacked startup toasts bury the message rather than deliver it.
  if (problems.length)
    warnTui(
      api,
      "subagents-sidebar",
      `Subagents ignored invalid options — ${problems.join("; ")}. Using defaults.`,
    )

  const theme = () => api.theme.current

  // The engine's durable record, keyed by PARENT session id. The synced store
  // holds only the newest 100 messages, so a sighting is kept from the moment
  // it is first seen (store walk or bus event) until its parent session is
  // deleted or the recency cap evicts an idle one. `version` notifies the
  // sidebar's memos of bus-side changes — and doubles as the reactivity
  // fallback in case a host syncs part stores more coarsely than it emits
  // events.
  type Tracking = {
    sightings: Map<string, SubagentSighting>
    deleted: boolean
    deletedChildren: Set<string>
    childDirectories: Map<string, string>
    version: Signal<number>
  }
  const sessions = new Map<string, Tracking>()
  const tracking = (parentID: string): Tracking => {
    const existing = sessions.get(parentID)
    if (existing) {
      // Re-insert so the cap evicts by recency, not by first sight. Mutating
      // the map here is safe ONLY because this writes no signal — it runs
      // inside View memos, and a signal write would self-invalidate them.
      sessions.delete(parentID)
      sessions.set(parentID, existing)
      return existing
    }
    const entry: Tracking = {
      sightings: new Map(),
      deleted: false,
      deletedChildren: new Set(),
      childDirectories: new Map(),
      version: createSignal(0),
    }
    sessions.set(parentID, entry)
    return entry
  }
  const bump = (entry: Tracking) => entry.version[1]((version) => version + 1)

  const viewedSessionID = (): string | undefined => routeSessionID(api)

  // Hold the map to MAX_TRACKED_SESSIONS, oldest-touched first. Writes no
  // signals, so this is safe from the bus handler AND from inside a View memo.
  // Never evicts the viewed session (the only one that renders) nor the
  // caller's own, so self-eviction is impossible by construction.
  const trimSessions = (keep?: string) => {
    if (sessions.size <= MAX_TRACKED_SESSIONS) return
    const viewed = viewedSessionID()
    for (const parentID of [...sessions.keys()]) {
      if (sessions.size <= MAX_TRACKED_SESSIONS) break
      if (parentID === viewed || parentID === keep) continue
      sessions.delete(parentID)
      // Evicting the record also forgets the hydration, so a later re-view
      // recovers old spawns from history again instead of trusting a record
      // that no longer exists.
      cancelHistoryHydration(parentID)
    }
  }

  // Notifies the row memos of every plugin-observed change the host stores
  // don't carry: child status/run transitions, hydrated pending requests, and
  // hydration completing. One coarse signal — only the viewed session's memo
  // recomputes, and these events are per run or per prompt, not per token.
  const [childStateVersion, setChildStateVersion] = createSignal(0)
  const bumpChildState = () => setChildStateVersion((version) => version + 1)

  // What the plugin itself has observed of a child session, beyond the host
  // stores: the busy→idle stamp (the host touches a session record at prompt
  // START, never on settle — so `time.updated` misstates a finish by the
  // whole runtime) and the latest run's terminal verdict (the parent part of
  // a background run completed at launch and can never carry it). Keyed by
  // child session id; FIFO-capped far above what 64 tracked parents can hold.
  type ChildRun = { settledAt?: number; failed?: boolean }
  const childRuns = new Map<string, ChildRun>()
  const MAX_CHILD_RECORDS = 256
  const rememberChildRun = (childID: string, run: ChildRun) => {
    childRuns.delete(childID)
    childRuns.set(childID, run)
    if (childRuns.size > MAX_CHILD_RECORDS) {
      const oldest = childRuns.keys().next().value
      if (oldest !== undefined) childRuns.delete(oldest)
    }
  }

  // Only children some retained sighting names are observed — the gate keeps
  // server-wide status/message traffic from bloating the maps and from waking
  // the sidebar for sessions this plugin has no row for.
  const isTrackedChild = (childID: string): boolean => {
    for (const entry of sessions.values())
      for (const sighting of entry.sightings.values())
        if (sighting.childID === childID) return true
    return false
  }

  // Recently deleted sessions cover deletion-before-sighting races. Durable
  // child tombstones live on their bounded parent Tracking instead: keeping
  // every server-wide deletion forever would make a long-lived attach grow
  // without bound.
  const tombstones = new Set<string>()
  const MAX_RECENT_TOMBSTONES = 256
  const entomb = (sessionID: string) => {
    tombstones.delete(sessionID)
    tombstones.add(sessionID)
    if (tombstones.size <= MAX_RECENT_TOMBSTONES) return
    const oldest = tombstones.values().next().value
    if (oldest !== undefined) tombstones.delete(oldest)
  }
  const buried = (entry: Tracking, sighting: SubagentSighting): boolean =>
    sighting.childID !== undefined &&
    (tombstones.has(sighting.childID) ||
      entry.deletedChildren.has(sighting.childID))
  // Server/store snapshots may advance a part's lifecycle, but only a live
  // bus event may move it backward (for example, an explicit resume).
  const sightingRank = (sighting: SubagentSighting): number =>
    sighting.state === "pending" ? 0 : sighting.state === "running" ? 1 : 2

  // Pending permission/question requests hydrated from the server. The host
  // TUI builds its queues exclusively from live ask/reply events — bootstrap
  // and reconnect never call the list endpoints — so a TUI attaching after a
  // child already blocked sees empty stores and would render the child as
  // running (docs/upstream-issues/tui-permission-store-not-reconciled.md).
  // A successful startup/reconnect snapshot replaces each queue, including
  // stale host requests answered during an event gap. Only events observed
  // since that fetch began may override it; host queues are a fallback until
  // the first successful snapshot for that request kind and directory. The
  // event bus spans directories, but the list endpoints do not.
  const hydratedRequests = {
    permissions: new Set<string>(),
    questions: new Set<string>(),
  }
  const pendingRequests = new Map<
    string,
    { permissions: Set<string>; questions: Set<string> }
  >()
  // Scope proof outlives pending membership and does not require a rendered
  // row. Retained parents keep it durably; unknown-parent records are bounded.
  const requestDirectories = new Map<string, string>()
  const rememberRequestDirectory = (sessionID: string, directory: string) => {
    requestDirectories.delete(sessionID)
    requestDirectories.set(sessionID, directory)
    if (requestDirectories.size > MAX_CHILD_RECORDS) {
      const oldest = requestDirectories.keys().next().value
      if (oldest !== undefined) requestDirectories.delete(oldest)
    }
    for (const entry of sessions.values())
      for (const sighting of entry.sightings.values())
        if (sighting.childID === sessionID) {
          entry.childDirectories.set(sessionID, directory)
          break
        }
  }
  const requestDirectoryFor = (sessionID: string): string | undefined => {
    const directory =
      api.state.session.get(sessionID)?.directory ||
      requestDirectories.get(sessionID)
    if (directory) return directory
    for (const entry of sessions.values()) {
      const held = entry.childDirectories.get(sessionID)
      if (held) return held
    }
  }
  const pendingFor = (sessionID: string) => {
    const held = pendingRequests.get(sessionID)
    if (held) return held
    const entry = {
      permissions: new Set<string>(),
      questions: new Set<string>(),
    }
    pendingRequests.set(sessionID, entry)
    return entry
  }
  // The hydration endpoints are host contracts of the VERIFIED band; an
  // unverified v1 host (which this plugin still runs on, warned) may lack
  // them, and a missing namespace throws synchronously — which must degrade
  // to a failed hydration, never take down startup.
  const attempt = <T,>(call: () => Promise<T>): Promise<T> => {
    try {
      return call()
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  }
  type ChildStatus = "busy" | "retry" | "idle"
  type ChildRunEvent =
    | { type: "status"; status: ChildStatus; at: number }
    | { type: "failed" }
  let hydratedStatuses: Map<string, ChildStatus> | undefined
  const statusFor = (childID: string): ChildStatus | undefined => {
    if (hydratedStatuses) return hydratedStatuses.get(childID) ?? "idle"
    const status = api.state.session.status(childID)?.type
    return status === "busy" || status === "retry" || status === "idle"
      ? status
      : undefined
  }
  type ServerHydration = {
    generation: number
    controller: AbortController
    directory: string | undefined
    touched: {
      permissions: Set<string>
      questions: Set<string>
      statuses: Set<string>
    }
    runBaselines: Map<
      string,
      { status: ChildStatus | undefined; run: ChildRun | undefined }
    >
    runEvents: Map<string, ChildRunEvent[]>
  }
  let serverGeneration = 0
  let activeServerHydration: ServerHydration | undefined
  const hydrateServerState = () => {
    if (api.lifecycle.signal.aborted) return
    activeServerHydration?.controller.abort()
    const hydration: ServerHydration = {
      generation: ++serverGeneration,
      controller: new AbortController(),
      directory: api.state.path.directory || undefined,
      touched: {
        permissions: new Set(),
        questions: new Set(),
        statuses: new Set(),
      },
      runBaselines: new Map(),
      runEvents: new Map(),
    }
    for (const entry of sessions.values()) {
      for (const sighting of entry.sightings.values()) {
        if (!sighting.childID || hydration.runBaselines.has(sighting.childID))
          continue
        const run = childRuns.get(sighting.childID)
        hydration.runBaselines.set(sighting.childID, {
          status: statusFor(sighting.childID),
          run: run ? { ...run } : undefined,
        })
      }
    }
    activeServerHydration = hydration
    void Promise.allSettled([
      attempt(() =>
        api.client.permission.list(
          { directory: hydration.directory },
          { signal: hydration.controller.signal },
        ),
      ),
      attempt(() =>
        api.client.question.list(
          { directory: hydration.directory },
          { signal: hydration.controller.signal },
        ),
      ),
      attempt(() =>
        api.client.session.status(undefined, {
          signal: hydration.controller.signal,
        }),
      ),
    ]).then(([permissions, questions, statuses]) => {
      // A reconnect may have started (or completed) a newer snapshot while
      // this one was in flight. Only that latest generation may replace state.
      if (
        api.lifecycle.signal.aborted ||
        activeServerHydration?.generation !== hydration.generation
      )
        return
      activeServerHydration = undefined
      // Each queue replaces wholesale only when its own fetch succeeded — a
      // failed or degraded endpoint (an older host, a blip) keeps the last
      // known copy rather than blanking real waits. Preserve the latest live
      // state for IDs asked/replied/rejected since the fetch began, even when
      // the list response settles after those events.
      const permissionData =
        permissions.status === "fulfilled" ? permissions.value.data : undefined
      const questionData =
        questions.status === "fulfilled" ? questions.value.data : undefined
      const statusData =
        statuses.status === "fulfilled" ? statuses.value.data : undefined
      if (
        permissionData === undefined &&
        questionData === undefined &&
        statusData === undefined
      )
        return
      for (const [kind, data] of [
        ["permissions", permissionData],
        ["questions", questionData],
      ] as const) {
        if (data === undefined) continue
        if (hydration.directory) {
          hydratedRequests[kind].add(hydration.directory)
          for (const request of data)
            if (!tombstones.has(request.sessionID))
              rememberRequestDirectory(request.sessionID, hydration.directory)
        }
        for (const [sessionID, held] of pendingRequests) {
          // A snapshot cannot retire waits belonging to another instance, or
          // to an unknown session unless the response itself establishes scope.
          const directory = requestDirectoryFor(sessionID)
          if (!directory || directory !== hydration.directory) continue
          for (const id of held[kind])
            if (!hydration.touched[kind].has(id)) held[kind].delete(id)
        }
        for (const request of data) {
          if (
            !hydration.touched[kind].has(request.id) &&
            !tombstones.has(request.sessionID)
          )
            pendingFor(request.sessionID)[kind].add(request.id)
        }
      }
      for (const [sessionID, held] of pendingRequests)
        if (held.permissions.size === 0 && held.questions.size === 0)
          pendingRequests.delete(sessionID)
      if (statusData !== undefined) {
        const trackedChildren = new Set<string>()
        for (const entry of sessions.values())
          for (const sighting of entry.sightings.values())
            if (sighting.childID) trackedChildren.add(sighting.childID)
        const snapshot = new Map<string, ChildStatus>()
        for (const [sessionID, value] of Object.entries(statusData)) {
          const status = value?.type
          if (status === "busy" || status === "retry" || status === "idle")
            snapshot.set(sessionID, status)
        }
        const next = new Map(
          [...snapshot].filter(([, status]) => status !== "idle"),
        )
        // Status events delivered after this request began are newer than its
        // response snapshot and remain authoritative.
        for (const sessionID of hydration.touched.statuses) {
          const status = statusFor(sessionID)
          if (!status) continue
          if (status === "idle") next.delete(sessionID)
          else next.set(sessionID, status)
        }

        for (const childID of trackedChildren) {
          const held = childRuns.get(childID)
          const baseline = hydration.runBaselines.get(childID) ?? {
            status: statusFor(childID),
            run: held ? { ...held } : undefined,
          }
          const events = hydration.runEvents.get(childID) ?? []
          const statusEvents = events.filter(
            (event): event is Extract<ChildRunEvent, { type: "status" }> =>
              event.type === "status",
          )
          const baselineLive =
            baseline.status === "busy" || baseline.status === "retry"
          const snapshotStatus = snapshot.get(childID) ?? "idle"
          const snapshotLive =
            snapshotStatus === "busy" || snapshotStatus === "retry"

          if (statusEvents.length > 0) {
            const last = statusEvents.at(-1)
            if (!last) continue
            const sawLive = statusEvents.some(
              (event) => event.status === "busy" || event.status === "retry",
            )
            // Live handlers already applied these events in their true order.
            // The one missing edge is an old idle baseline, a snapshot proving
            // a run existed, and only its later idle event reaching the TUI.
            if (
              !baselineLive &&
              snapshotLive &&
              !sawLive &&
              last.status === "idle"
            ) {
              rememberChildRun(childID, {
                ...(events.some((event) => event.type === "failed")
                  ? { failed: true }
                  : {}),
                settledAt: last.at,
              })
            }
            continue
          }

          let run = baseline.run ? { ...baseline.run } : undefined
          if (
            snapshotLive &&
            !baselineLive &&
            (run?.settledAt !== undefined || run?.failed === true)
          )
            run = {}
          else if (!snapshotLive && baselineLive)
            run = { ...run, settledAt: Date.now() }
          if (events.some((event) => event.type === "failed"))
            run = { ...run, failed: true }

          if (run) rememberChildRun(childID, run)
          else childRuns.delete(childID)
        }
        hydratedStatuses = next
      }
      bumpChildState()
    })
  }
  const rememberRunEvent = (childID: string, event: ChildRunEvent) => {
    const hydration = activeServerHydration
    if (!hydration) return
    if (!hydration.runBaselines.has(childID)) {
      const run = childRuns.get(childID)
      hydration.runBaselines.set(childID, {
        status: statusFor(childID),
        run: run ? { ...run } : undefined,
      })
    }
    const events = hydration.runEvents.get(childID) ?? []
    events.push(event)
    hydration.runEvents.set(childID, events)
  }
  const attentionFor = (childID: string): number => {
    const held = pendingRequests.get(childID)
    const directory = requestDirectoryFor(childID)
    const permissionIDs = new Set(held?.permissions)
    if (!directory || !hydratedRequests.permissions.has(directory))
      for (const request of api.state.session.permission(childID))
        permissionIDs.add(request.id)
    const questionIDs = new Set(held?.questions)
    if (!directory || !hydratedRequests.questions.has(directory))
      for (const request of api.state.session.question(childID))
        questionIDs.add(request.id)
    return permissionIDs.size + questionIDs.size
  }

  // One-time recovery per read parent: fetch full history plus the current
  // children so a cold attach finds old spawns and a reconnect advances stale
  // parts or retires children deleted during the event gap. Live part events
  // touched mid-fetch always win; snapshots otherwise advance lifecycle state
  // monotonically. Failures retry after a pause on the next read.
  type HistoryHydration =
    | {
        status: "pending"
        generation: number
        controller: AbortController
        touched: Set<string>
        liveChildren: Set<string>
      }
    | { status: "done" }
    | { status: "retry"; failedAt: number }
  const hydrated = new Map<string, HistoryHydration>()
  let historyGeneration = 0
  const HYDRATE_RETRY_MS = 30_000
  const cancelHistoryHydration = (parentID: string) => {
    const state = hydrated.get(parentID)
    hydrated.delete(parentID)
    if (state?.status === "pending") state.controller.abort()
  }
  const cancelAllHistoryHydrations = () => {
    for (const parentID of [...hydrated.keys()])
      cancelHistoryHydration(parentID)
  }
  const ensureHydrated = (parentID: string) => {
    if (api.lifecycle.signal.aborted || tombstones.has(parentID)) return
    if (sessions.get(parentID)?.deleted) return
    const state = hydrated.get(parentID)
    if (state?.status === "pending" || state?.status === "done") return
    if (
      state?.status === "retry" &&
      Date.now() - state.failedAt < HYDRATE_RETRY_MS
    )
      return
    const generation = ++historyGeneration
    const controller = new AbortController()
    const hydration: HistoryHydration = {
      status: "pending",
      generation,
      controller,
      touched: new Set(),
      liveChildren: new Set(),
    }
    hydrated.set(parentID, hydration)
    void attempt(() =>
      api.client.session.messages(
        {
          sessionID: parentID,
        },
        { signal: controller.signal },
      ),
    )
      .then(
        (result) => result.data,
        () => undefined,
      )
      .then(async (messageData) => {
        const current = hydrated.get(parentID)
        if (
          api.lifecycle.signal.aborted ||
          current?.status !== "pending" ||
          current.generation !== generation
        )
          return { messageData, childrenData: undefined }
        // Read children second. A child present in this history snapshot must
        // either exist in the later child snapshot or have been deleted while
        // the two reads crossed; concurrent snapshots cannot establish that.
        const childrenData = await attempt(() =>
          api.client.session.children(
            {
              sessionID: parentID,
            },
            { signal: controller.signal },
          ),
        ).then(
          (result) => result.data,
          () => undefined,
        )
        return { messageData, childrenData }
      })
      .then(({ messageData, childrenData }) => {
        // Deleted, evicted, or superseded by a reconnect while in flight:
        // this snapshot no longer speaks for anyone. The generation check is
        // necessary because a newer request is also pending.
        const current = hydrated.get(parentID)
        if (
          api.lifecycle.signal.aborted ||
          current?.status !== "pending" ||
          current.generation !== generation
        )
          return
        if (messageData === undefined && childrenData === undefined) {
          hydrated.set(parentID, { status: "retry", failedAt: Date.now() })
          return
        }
        hydrated.set(
          parentID,
          messageData !== undefined && childrenData !== undefined
            ? { status: "done" }
            : { status: "retry", failedAt: Date.now() },
        )
        const entry = tracking(parentID)
        if (entry.deleted) return
        let changed = false
        let currentChildren: Set<string> | undefined
        if (childrenData !== undefined) {
          // Child records need not be in the host's synced window. Retain
          // their request scope with the bounded parent record instead.
          entry.childDirectories = new Map(
            childrenData
              .filter((child) => child.directory && !tombstones.has(child.id))
              .map((child) => [child.id, child.directory]),
          )
          changed = true
          currentChildren = new Set(
            childrenData
              .map((child) => child.id)
              .filter((childID) => !tombstones.has(childID)),
          )
          for (const childID of hydration.liveChildren)
            currentChildren.add(childID)
          for (const [key, sighting] of entry.sightings) {
            if (!sighting.childID || currentChildren.has(sighting.childID))
              continue
            entomb(sighting.childID)
            entry.deletedChildren.add(sighting.childID)
            entry.sightings.delete(key)
            changed = true
          }
        }
        if (messageData !== undefined) {
          for (const message of messageData) {
            for (const part of message.parts) {
              const sighting = sightingOf(part)
              if (!sighting || hydration.touched.has(sighting.key)) continue
              if (
                sighting.childID &&
                currentChildren &&
                !currentChildren.has(sighting.childID)
              ) {
                entomb(sighting.childID)
                entry.deletedChildren.add(sighting.childID)
                continue
              }
              if (buried(entry, sighting)) continue
              const held = entry.sightings.get(sighting.key)
              if (held && sightingRank(held) > sightingRank(sighting)) continue
              entry.sightings.set(sighting.key, sighting)
              changed = true
            }
          }
        }
        if (changed) bump(entry)
      })
      .catch(() => {
        const current = hydrated.get(parentID)
        if (
          !api.lifecycle.signal.aborted &&
          current?.status === "pending" &&
          current.generation === generation
        )
          hydrated.set(parentID, { status: "retry", failedAt: Date.now() })
      })
  }

  // Everything known about a child session right now: the host stores kept
  // for EVERY session on the server (statuses are seeded in one fetch and
  // updated per bus event) merged with the plugin's own observations, so
  // background children and pre-attach spawns resolve too. The host reads
  // track reactively under a memo; the plugin-side maps are covered by the
  // childStateVersion read in rowsFor.
  const probeFor = (childID: string | undefined): ChildProbe | undefined => {
    if (!childID) return undefined
    const status = statusFor(childID)
    const run = childRuns.get(childID)
    return {
      status,
      attention: attentionFor(childID),
      updatedAt: api.state.session.get(childID)?.time.updated,
      settledAt: run?.settledAt,
      failed: run?.failed,
    }
  }

  // The parent's subagents in conversation order: the durable record,
  // refreshed from the synced store on every read. Reactive when called under
  // a tracking scope (messages, parts, child probes, and the version signals
  // are all tracked); a plain ordered read from the dialog.
  const rowsFor = (parentID: string): SubagentRow[] => {
    if (tombstones.has(parentID)) return []
    const entry = tracking(parentID)
    if (entry.deleted) return []
    entry.version[0]()
    childStateVersion()
    ensureHydrated(parentID)
    for (const message of api.state.session.messages(parentID)) {
      if (message.role !== "assistant") continue
      for (const part of api.state.part(message.id)) {
        const sighting = sightingOf(part)
        if (!sighting || buried(entry, sighting)) continue
        const held = entry.sightings.get(sighting.key)
        if (!held || sightingRank(sighting) > sightingRank(held))
          entry.sightings.set(sighting.key, sighting)
      }
    }
    // Browsing sessions on a quiet server reaches the engine only through
    // here, so the cap is applied on this path too.
    trimSessions(parentID)
    return dedupeSightings(entry.sightings.values()).map((sighting) => {
      if (sighting.childID) {
        const directory = requestDirectoryFor(sighting.childID)
        if (directory) entry.childDirectories.set(sighting.childID, directory)
      }
      return rowOf(sighting, probeFor(sighting.childID))
    })
  }

  // 1 s elapsed-time ticker, feeding every visible row's elapsed/linger math.
  // Gated on a plain map read — no signals — so an idle TUI with no recorded
  // subagents anywhere near the route costs zero signal churn.
  const [now, setNow] = createSignal(Date.now())
  const ticker = every(() => {
    const viewed = viewedSessionID()
    if (viewed && (sessions.get(viewed)?.sightings.size ?? 0) > 0)
      setNow(Date.now())
  }, 1_000)

  // The bus keeps the record current even for sessions the store has already
  // evicted messages from, and its bump is what re-renders the sidebar the
  // moment a task part changes state. Parts from nested spawns track under
  // THEIR parent (the part's own session), which is exactly the session whose
  // view should list them.
  api.lifecycle.onDispose(
    api.event.on("message.part.updated", (event) => {
      const sighting = sightingOf(event.properties.part)
      if (!sighting) return
      const parentID = event.properties.part.sessionID
      if (
        tombstones.has(parentID) ||
        (sighting.childID !== undefined && tombstones.has(sighting.childID))
      )
        return
      const entry = tracking(parentID)
      if (entry.deleted || buried(entry, sighting)) return
      const hydration = hydrated.get(parentID)
      if (hydration?.status === "pending") {
        hydration.touched.add(sighting.key)
        if (sighting.childID) hydration.liveChildren.add(sighting.childID)
      }
      trimSessions(parentID)
      entry.sightings.set(sighting.key, sighting)
      bump(entry)
    }),
  )

  // The child's busy→idle transition is the only trustworthy completion time
  // a run has (the host never touches the session record on settle), and a
  // new run starting clears the previous stamp AND verdict — a child resumed
  // through subagent_send goes busy again and its settled row must come back
  // to life. The first idle stamp is kept over re-delivered idles, so dupes
  // cannot stretch the linger.
  api.lifecycle.onDispose(
    api.event.on("session.status", (event) => {
      const { sessionID, status } = event.properties
      const tracked = isTrackedChild(sessionID)
      if (tracked)
        rememberRunEvent(sessionID, {
          type: "status",
          status: status.type,
          at: Date.now(),
        })
      activeServerHydration?.touched.statuses.add(sessionID)
      if (hydratedStatuses) {
        if (status.type === "idle") hydratedStatuses.delete(sessionID)
        else hydratedStatuses.set(sessionID, status.type)
      }
      if (!tracked) return
      const run = childRuns.get(sessionID)
      if (status.type === "idle") {
        if (run?.settledAt === undefined)
          rememberChildRun(sessionID, { ...run, settledAt: Date.now() })
      } else if (run?.settledAt !== undefined || run?.failed === true)
        rememberChildRun(sessionID, {})
      // The hydrated status map is nonreactive even when no terminal run changed.
      bumpChildState()
    }),
  )

  // A terminal error on the child's assistant message — a failure or an
  // abort — is the only place the host records a background run's verdict:
  // the parent tool part completed at launch and stays "completed" no matter
  // how the child ends. Only ever set here; the next run's busy status is
  // what clears it.
  api.lifecycle.onDispose(
    api.event.on("message.updated", (event) => {
      const info = event.properties.info
      if (info.role !== "assistant" || info.error === undefined) return
      if (!isTrackedChild(info.sessionID)) return
      rememberRunEvent(info.sessionID, { type: "failed" })
      const run = childRuns.get(info.sessionID)
      if (run?.failed === true) return
      rememberChildRun(info.sessionID, { ...run, failed: true })
      bumpChildState()
    }),
  )

  // After hydration, live events keep the authoritative queues current without
  // consulting the host's potentially stale copies. Track asks even before a
  // child sighting is discovered, and protect in-flight events from snapshots.
  const askPending =
    (kind: "permissions" | "questions") =>
    (event: { properties: { sessionID: string; id: string } }) => {
      const { sessionID, id } = event.properties
      if (tombstones.has(sessionID)) return
      const directory = requestDirectoryFor(sessionID)
      if (directory) rememberRequestDirectory(sessionID, directory)
      activeServerHydration?.touched[kind].add(id)
      const held = pendingFor(sessionID)[kind]
      if (held.has(id)) return
      held.add(id)
      bumpChildState()
    }
  const retirePending =
    (kind: "permissions" | "questions") =>
    (event: { properties: { sessionID: string; requestID: string } }) => {
      // The request may exist only in an in-flight server snapshot, not in
      // pendingRequests yet. Remember the newer reply so that snapshot cannot
      // add it back when its promise settles.
      activeServerHydration?.touched[kind].add(event.properties.requestID)
      const held = pendingRequests.get(event.properties.sessionID)
      if (!held?.[kind].delete(event.properties.requestID)) return
      if (held.permissions.size === 0 && held.questions.size === 0)
        pendingRequests.delete(event.properties.sessionID)
      bumpChildState()
    }
  api.lifecycle.onDispose(
    api.event.on("permission.asked", askPending("permissions")),
  )
  api.lifecycle.onDispose(
    api.event.on("question.asked", askPending("questions")),
  )
  api.lifecycle.onDispose(
    api.event.on("permission.replied", retirePending("permissions")),
  )
  api.lifecycle.onDispose(
    api.event.on("question.replied", retirePending("questions")),
  )
  api.lifecycle.onDispose(
    api.event.on("question.rejected", retirePending("questions")),
  )

  // A reconnect means an event gap of unknown size: re-fetch pending requests
  // and child statuses, then mark every hydrated parent stale so its next read
  // re-verifies history and current children against the server.
  api.lifecycle.onDispose(
    api.event.on("server.connected", () => {
      if (api.lifecycle.signal.aborted) return
      cancelAllHistoryHydrations()
      hydrateServerState()
    }),
  )
  hydrateServerState()

  // A deleted child must vanish from every parent it was sighted in. Its
  // per-parent tombstone outlives the bounded recent tombstone, because the
  // spawn part usually survives in the parent transcript indefinitely.
  api.lifecycle.onDispose(
    api.event.on("session.deleted", (event) => {
      const sessionID = event.properties.sessionID
      entomb(sessionID)
      const own = sessions.get(sessionID)
      if (own) {
        own.deleted = true
        own.sightings.clear()
        bump(own)
      }
      const parentID = event.properties.info.parentID
      const parent =
        typeof parentID === "string"
          ? (sessions.get(parentID) ??
            (parentID === viewedSessionID() ? tracking(parentID) : undefined))
          : undefined
      if (parent && !parent.deletedChildren.has(sessionID)) {
        parent.deletedChildren.add(sessionID)
        trimSessions(parentID)
        bump(parent)
      }
      cancelHistoryHydration(sessionID)
      childRuns.delete(sessionID)
      hydratedStatuses?.delete(sessionID)
      pendingRequests.delete(sessionID)
      requestDirectories.delete(sessionID)
      for (const entry of sessions.values()) {
        entry.childDirectories.delete(sessionID)
        let removed = false
        for (const [key, sighting] of entry.sightings) {
          if (sighting.childID !== sessionID) continue
          entry.sightings.delete(key)
          entry.deletedChildren.add(sessionID)
          removed = true
        }
        if (removed) bump(entry)
      }
    }),
  )

  api.lifecycle.onDispose(() => {
    // Abort unresolved snapshots before their continuations can mutate plugin
    // state after teardown.
    serverGeneration++
    activeServerHydration?.controller.abort()
    activeServerHydration = undefined
    cancelAllHistoryHydrations()
    clearInterval(ticker)
  })

  // ---- dialog --------------------------------------------------------------

  let dialogGeneration = 0
  let selectionGeneration = 0
  const openList = () => {
    const parentID = viewedSessionID()
    if (!parentID) return
    const dialog = ++dialogGeneration
    selectionGeneration++
    api.ui.dialog.replace(
      () => {
        const rows = rowsFor(parentID)
        return api.ui.DialogSelect<string>({
          title: "Subagents",
          placeholder: "Select a subagent",
          options: rows.map((row) => ({
            title: `${phaseGlyph(row.phase)} ${truncateLabel(rowLabel(row), DIALOG_LABEL_CHARS)} · ${statusWord(row, now())}`,
            value: row.key,
            description: row.childID ?? "session not known yet",
            category: isActive(row.phase) ? "Running" : "Finished",
            // Never `disabled`: the host's DialogSelect filters disabled
            // options OUT of the list entirely, and a still-pending spawn
            // must stay visible — so selection is guarded instead.
            onSelect: () => {
              if (
                api.lifecycle.signal.aborted ||
                dialogGeneration !== dialog ||
                viewedSessionID() !== parentID
              )
                return
              const selection = ++selectionGeneration
              const stale = () =>
                api.lifecycle.signal.aborted ||
                dialogGeneration !== dialog ||
                selectionGeneration !== selection ||
                viewedSessionID() !== parentID
              if (!row.childID) {
                api.ui.toast({
                  variant: "info",
                  message: "This subagent's session is not known yet.",
                })
                return
              }
              const childID = row.childID
              const deleted = () =>
                tombstones.has(childID) ||
                sessions.get(parentID)?.deletedChildren.has(childID) === true
              const unavailable = (message: string) =>
                api.ui.toast({
                  variant: "info",
                  message,
                })
              if (deleted()) {
                unavailable("This subagent's session was deleted.")
                return
              }
              const open = () => {
                if (stale()) return
                api.ui.dialog.clear()
                api.route.navigate("session", { sessionID: childID })
              }
              const hydration = hydrated.get(parentID)
              if (hydration?.status === "pending") {
                unavailable("Subagent state is still refreshing. Try again.")
                return
              }
              if (hydration?.status === "done") {
                open()
                return
              }
              // A degraded children fetch cannot authorize navigation. Verify
              // this one session directly and fail closed on any uncertainty.
              void attempt(() =>
                api.client.session.get(
                  { sessionID: childID },
                  { signal: api.lifecycle.signal },
                ),
              ).then(
                (result) => {
                  if (stale()) return
                  if (!result.data || deleted()) {
                    unavailable("This subagent's session is unavailable.")
                    return
                  }
                  open()
                },
                () => {
                  if (!stale())
                    unavailable("Could not verify this subagent session.")
                },
              )
            },
          })),
        })
      },
      () => {
        if (dialogGeneration !== dialog) return
        dialogGeneration++
        selectionGeneration++
      },
    )
  }

  const runList = () => {
    const parentID = viewedSessionID()
    if (!parentID) {
      api.ui.toast({
        variant: "info",
        message: "Open a session to list its subagents.",
      })
      return
    }
    openList()
  }

  // ---- command + optional keybind ------------------------------------------

  const keys = opts.keybind
    ? opts.keybind
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean)
    : []
  const [firstKey] = keys
  api.keymap.registerLayer({
    commands: [
      {
        name: LIST,
        title: "Subagents: list / open",
        desc: "List this session's subagents; open one's session",
        category: CATEGORY,
        namespace: "palette",
        slashName: "subagents",
        slashAliases: ["subs"],
        run: runList,
      },
    ],
    bindings: [
      // Only the first alternative is bound to the command NAME: the palette
      // shows every named binding in a non-shrinking column that clips
      // titles. The remaining alternatives bind to a function — functional,
      // but invisible to the palette.
      ...(firstKey !== undefined
        ? [{ key: firstKey, cmd: LIST, desc: "Subagents", group: CATEGORY }]
        : []),
      ...(keys.length > 1
        ? [
            {
              key: keys.slice(1).join(","),
              cmd: () => runList(),
              desc: "Subagents",
              group: CATEGORY,
            },
          ]
        : []),
    ],
  })

  // ---- sidebar widget ------------------------------------------------------

  function View(props: { api: TuiPluginApi; session_id: string }) {
    // Sub-agent sessions never show a sidebar section of their own.
    const rows = createMemo(() =>
      isSubAgentSession(props.api, props.session_id)
        ? []
        : rowsFor(props.session_id),
    )
    const shown = createMemo(() => {
      const split = splitRows(rows(), now(), opts.lingerMs)
      return [...split.active, ...split.recent]
    })
    const anyWaiting = createMemo(() =>
      shown().some((row) => row.phase === "waiting"),
    )
    const rowColor = (row: SubagentRow) => {
      if (row.phase === "waiting") return theme().warning
      if (row.phase === "failed") return theme().error
      if (row.phase === "done") return theme().success
      return theme().textMuted
    }
    return (
      <Show when={shown().length > 0}>
        <box>
          <text fg={anyWaiting() ? theme().warning : theme().text}>
            <b>Subagents</b>
          </text>
          <For each={shown().slice(0, SIDEBAR_LIMIT)}>
            {(row) => (
              <text fg={theme().textMuted}>
                <span style={{ fg: rowColor(row) }}>
                  {phaseGlyph(row.phase)}{" "}
                </span>
                {truncateLabel(rowLabel(row), SIDEBAR_LABEL_CHARS)}{" "}
                <span
                  style={{
                    fg:
                      row.phase === "waiting"
                        ? theme().warning
                        : theme().textMuted,
                  }}
                >
                  {statusWord(row, now())}
                </span>
              </text>
            )}
          </For>
          <Show when={shown().length > SIDEBAR_LIMIT}>
            <text fg={theme().textMuted}>
              {"  "}…{shown().length - SIDEBAR_LIMIT} more (/subagents)
            </text>
          </Show>
        </box>
      </Show>
    )
  }

  if (opts.sidebar) {
    // 155: packed with the suite's other live per-session sections between
    // the host's Context (100) and MCP (200), just after the limits widgets
    // and above background-tasks (160), because a working subagent is the
    // liveliest thing a session owns. The suite-wide uniqueness rule is
    // pinned in tests/repo/test/slot-order.test.ts.
    api.slots.register({
      order: 155,
      slots: {
        sidebar_content: (_ctx, props) => (
          <View api={api} session_id={props.session_id} />
        ),
      },
    })
  }
}

const plugin: TuiPluginModule = {
  id: "opencode-subagents-sidebar",
  tui,
}

export default plugin

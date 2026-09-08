/**
 * opencode-subagents — pure core
 *
 * Everything the sidebar and the /subagents dialog need that is not JSX or the
 * TUI plugin API: reading a subagent sighting out of a `task` tool part,
 * deciding what phase a subagent is in, the linger split, and the row text —
 * so `bun test` can exercise all of it directly.
 *
 * A "sighting" is one subagent-spawning tool call as the host records it in
 * the PARENT session. Two tools spawn subagents in this suite's world, and
 * both write the same part shape (subagent-comms deliberately mirrors the
 * host's): the stock `task` tool, and subagent-comms' `subagent_spawn` —
 * verified against on-disk session data from both. The spawning tool creates
 * a child session (`parentID` = the caller) and the tool part's state carries
 * everything the overview needs — `input.subagent_type` and
 * `input.description` from the call, `metadata.sessionId` naming the child
 * once the tool reported it, and `time.start`/`time.end`. The part's own
 * status is authoritative for foreground runs (the part completes when the
 * child finishes); a BACKGROUND run's part completes at launch instead —
 * `task` with `background: true`, and every `subagent_spawn` by design — so
 * for those the child session's own status decides whether the subagent is
 * still working.
 */

import { formatDuration } from "@macarons/permission-rules"

// The verified band is centralized in the shared library and rides the repo's
// OpenCode pin (.opencode-version) — the policy comment lives there. The band
// matters here because the task-part metadata shape (`sessionId`, `background`)
// and the busy/retry/idle status vocabulary are host contracts this module
// hard-codes.
export {
  formatDuration,
  isSubAgentSession,
  truncateLabel,
} from "@macarons/permission-rules"

/** The task tool part's own lifecycle, as the host records it. */
export type TaskPartState = "pending" | "running" | "completed" | "error"

/** One `task` tool call observed in a parent session. */
export type SubagentSighting = {
  /**
   * Stable identity across the part's state transitions: the tool callID when
   * the host provides one, else the part id. Dedupe and the durable record
   * key off this.
   */
  key: string
  partID: string
  messageID: string
  /**
   * The child session the task runs in — `metadata.sessionId`, present from
   * the moment the tool resolved its agent and session. Absent only while the
   * call is still streaming in ("pending"), when there is nothing to open yet.
   */
  childID?: string
  /** `input.subagent_type` — which agent the child runs. */
  agent?: string
  /** `input.description` — the parent's own 3-5 word label for the task. */
  description?: string
  /**
   * The tool part completes at LAUNCH rather than at the subagent's finish —
   * `task` with background=true (or promoted), and every `subagent_spawn` —
   * so a completed part must not read as a finished subagent until the child
   * session itself goes idle.
   */
  background: boolean
  state: TaskPartState
  startedAt?: number
  endedAt?: number
}

/**
 * The tools whose parts spawn a subagent. `subagent_spawn` (subagent-comms)
 * writes the same input/metadata contract as the stock `task` tool on
 * purpose, so one reader covers both; a suite install where the model
 * prefers `subagent_spawn` would otherwise show an empty section for every
 * spawn — the gap the first live test hit.
 */
export const SPAWN_TOOLS = ["task", "subagent_spawn"] as const

/**
 * Read a subagent sighting out of one synced part, or undefined for anything
 * that is not a spawn tool part. Defensive throughout: the part arrives from
 * the host's store or bus and this reader must never throw on a shape drift —
 * an unreadable field degrades to undefined, never to a crash.
 */
export function sightingOf(part: unknown): SubagentSighting | undefined {
  if (!part || typeof part !== "object") return undefined
  const candidate = part as {
    id?: unknown
    messageID?: unknown
    callID?: unknown
    type?: unknown
    tool?: unknown
    state?: unknown
  }
  if (candidate.type !== "tool") return undefined
  if (!(SPAWN_TOOLS as readonly unknown[]).includes(candidate.tool))
    return undefined
  if (typeof candidate.id !== "string" || candidate.id.length === 0)
    return undefined
  if (typeof candidate.messageID !== "string") return undefined
  const state = (candidate.state ?? {}) as {
    status?: unknown
    input?: unknown
    metadata?: unknown
    time?: unknown
  }
  const status = state.status
  if (
    status !== "pending" &&
    status !== "running" &&
    status !== "completed" &&
    status !== "error"
  )
    return undefined
  const input = (
    state.input && typeof state.input === "object" ? state.input : {}
  ) as Record<string, unknown>
  const metadata = (
    state.metadata && typeof state.metadata === "object" ? state.metadata : {}
  ) as Record<string, unknown>
  const time = (
    state.time && typeof state.time === "object" ? state.time : {}
  ) as { start?: unknown; end?: unknown }
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined
  const stamp = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined
  return {
    key: text(candidate.callID) ?? candidate.id,
    partID: candidate.id,
    messageID: candidate.messageID,
    childID: text(metadata.sessionId),
    agent: text(input.subagent_type),
    description: text(input.description),
    // subagent_spawn is background-only BY DESIGN (its part completes at
    // launch, always), so it is hard-wired rather than trusted to the flag:
    // a spawn part missing the metadata would otherwise read "done" the
    // moment it launched, while the subagent worked on unseen.
    background:
      candidate.tool === "subagent_spawn" ||
      metadata.background === true ||
      input.background === true,
    state: status,
    startedAt: stamp(time.start),
    endedAt: stamp(time.end),
  }
}

/**
 * What the host currently knows about the CHILD session, read from the synced
 * stores the TUI already keeps for every session on the server, plus what the
 * plugin has observed of the child itself:
 *   - status: the child's session status (busy / retry / idle);
 *   - attention: pending permission prompts + questions in the child — the
 *     subagent is stopped waiting on the user, which is the one state a
 *     parent-session overview most needs to surface;
 *   - updatedAt: the child session record's last-activity stamp. The host
 *     touches it when a prompt STARTS (never on the idle transition), so for
 *     a settled run it names the start, not the finish — a fallback only;
 *   - settledAt: when the plugin saw the child's own busy→idle transition —
 *     the real completion time of the child's latest run, on the local clock
 *     the linger math also uses. Absent when the run settled unobserved;
 *   - failed: the child's latest run ended in an error or abort. Absent when
 *     no terminal outcome was observed.
 */
export type ChildProbe = {
  status?: "idle" | "retry" | "busy"
  attention: number
  updatedAt?: number
  settledAt?: number
  failed?: boolean
}

export type SubagentPhase =
  | "starting"
  | "running"
  | "retrying"
  | "waiting"
  | "done"
  | "failed"

/** One subagent as the sidebar and dialog present it. */
export type SubagentRow = {
  key: string
  childID?: string
  agent?: string
  description?: string
  background: boolean
  phase: SubagentPhase
  startedAt?: number
  /**
   * The child's observed settle time when the plugin saw it, else the part's
   * end (foreground) or the child record's last-activity stamp (background).
   */
  endedAt?: number
}

/**
 * Judge one sighting against what is known of its child session.
 *
 * A LIVE child probe (busy, retrying, or holding a pending permission or
 * question) overrides ANY settled sighting: subagent-comms' `subagent_send`
 * resumes an existing child without writing a new spawn part, so the only
 * retained sighting stays completed/error while the child works — the part
 * alone cannot settle a row whose child is demonstrably active. Otherwise the
 * part's own status decides the foreground lifecycle, and a background run's
 * completed part only means "launched", so there the child's terminal
 * outcome (failed) and the observed settle time carry the verdict. An
 * unknown child status reads as finished, never as running: a child the host
 * has no record of is not one the user can do anything about, and a genuinely
 * working child's busy status arrives with its first event.
 */
export function rowOf(
  sighting: SubagentSighting,
  probe: ChildProbe | undefined,
): SubagentRow {
  const live = (): SubagentPhase => {
    if ((probe?.attention ?? 0) > 0) return "waiting"
    if (probe?.status === "retry") return "retrying"
    return "running"
  }
  const childLive =
    probe?.status === "busy" ||
    probe?.status === "retry" ||
    (probe?.attention ?? 0) > 0
  const phase = ((): SubagentPhase => {
    switch (sighting.state) {
      case "pending":
        return "starting"
      case "running":
        return live()
      case "error":
        return childLive ? live() : "failed"
      case "completed":
        if (childLive) return live()
        if (probe?.failed) return "failed"
        return "done"
    }
  })()
  const settled = phase === "done" || phase === "failed"
  return {
    key: sighting.key,
    childID: sighting.childID,
    agent: sighting.agent,
    description: sighting.description,
    background: sighting.background,
    phase,
    startedAt: sighting.startedAt,
    // The observed busy→idle stamp wins wherever it exists: a foreground
    // part's own end time survives a `subagent_send` resume unchanged, and a
    // background child's session record is only touched at prompt START — so
    // both part end and updatedAt understate a later or longer run.
    endedAt: settled
      ? (probe?.settledAt ??
        (sighting.background
          ? (probe?.updatedAt ?? sighting.endedAt)
          : sighting.endedAt))
      : undefined,
  }
}

/**
 * Collapse resumed tasks to one row: a `task` call with task_id continues the
 * SAME child session under a new tool call, and two rows for one subagent
 * would double-count it. Groups by child session (sightings with no child yet
 * stand alone) and keeps each group's newest sighting — message then part id,
 * the host's ascending identifiers — so the row reflects the latest run.
 * Output preserves each group's first-appearance order, which follows
 * conversation order when the caller feeds sightings in store order.
 */
export function dedupeSightings(
  sightings: Iterable<SubagentSighting>,
): SubagentSighting[] {
  const groups = new Map<string, SubagentSighting>()
  for (const sighting of sightings) {
    const group = sighting.childID ?? sighting.key
    const held = groups.get(group)
    if (
      !held ||
      held.messageID < sighting.messageID ||
      (held.messageID === sighting.messageID && held.partID < sighting.partID)
    )
      groups.set(group, sighting)
  }
  return [...groups.values()]
}

export function isActive(phase: SubagentPhase): boolean {
  return phase !== "done" && phase !== "failed"
}

/**
 * The sidebar split: everything live, plus recently settled rows so a finish
 * is seen rather than silently vanishing. A settled row with no usable end
 * time never lingers — without a stamp "recent" is unknowable, and a TUI
 * attaching hours later must not resurrect old history.
 */
export function splitRows(
  rows: readonly SubagentRow[],
  now: number,
  lingerMs: number,
): { active: SubagentRow[]; recent: SubagentRow[] } {
  const active: SubagentRow[] = []
  const recent: SubagentRow[] = []
  for (const row of rows) {
    if (isActive(row.phase)) active.push(row)
    else if (row.endedAt !== undefined && now - row.endedAt < lingerMs)
      recent.push(row)
  }
  return { active, recent }
}

/** "explore: find the sync path", degrading to whichever half is known. */
export function rowLabel(row: SubagentRow): string {
  if (row.agent && row.description) return `${row.agent}: ${row.description}`
  return row.description ?? row.agent ?? "subagent"
}

/** Single-cell state glyph, matching background-tasks' vocabulary. */
export function phaseGlyph(phase: SubagentPhase): string {
  if (phase === "waiting") return "!"
  if (phase === "done") return "✓"
  if (phase === "failed") return "✗"
  return "▶"
}

/**
 * The row's trailing status: elapsed time while live (the overview's pulse),
 * words only where time is the wrong signal. "waiting on you" names the one
 * state that needs the user; done/failed stay bare — the linger is short and
 * the glyph already carries the verdict.
 */
export function statusWord(row: SubagentRow, now: number): string {
  const elapsed = (): string =>
    row.startedAt === undefined ? "" : formatDuration(now - row.startedAt)
  switch (row.phase) {
    case "starting":
      return "starting"
    case "running":
      return elapsed() || "running"
    case "retrying":
      return elapsed() ? `retrying ${elapsed()}` : "retrying"
    case "waiting":
      return "waiting on you"
    case "done":
      return "done"
    case "failed":
      return "failed"
  }
}

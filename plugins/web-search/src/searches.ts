import path from "node:path"
import {
  canonicalPath,
  isInside,
  projectFileKey,
  readJsonFile,
  shortProjectHash,
} from "@macarons/permission-rules"
import { type BackendId, clampNumber, MAX_TIMER_MS, SERVICE } from "./shared"

// Re-exported so the two halves reading this channel need only import from here.
export { SERVICE }

/**
 * @macarons/web-search — search-activity channel
 *
 * The contract the two halves share so the TUI sidebar can show searches as
 * they run. Everything here is host-free and unit-testable, and (like
 * background-tasks' shared core) imports NO solid-js and NO SDK: the host
 * substitutes its own solid-js for the TUI entry module only, so anything
 * reactive lives in tui.tsx, and keeping the SDK out lets the server half stay
 * on the injected v1 client while the bundle inlines just this and
 * permission-rules.
 *
 *   - the activity state file the server rewrites on every search lifecycle
 *     transition (pending → running → complete/error), read by the TUI;
 *   - a `tui.command.execute` poke the server publishes after each write so an
 *     attached TUI refreshes without waiting out its poll (best-effort — the
 *     TUI's poll is the correctness fallback).
 *
 * There is no reverse channel: the sidebar is read-only display, so unlike
 * background-tasks there are no kill-request files.
 */

export const STATE_FILE_VERSION = 1

// Keep the existing channel paths and command for independently upgraded halves.
const STATE_DIRECTORY = "websearch"

/** Command the server pokes over `tui.command.execute`; the TUI registers it (non-palette). */
export const SYNC_COMMAND = "websearch.activity.sync"

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * The four lifecycle states the sidebar renders:
 *   - pending  awaiting the permission ask, no backend chosen yet
 *   - running  the backend chain is executing; `backend` is the one currently
 *              attempted (undefined for the brief gap before the first attempt)
 *   - complete a backend answered; `backend` is the one that did
 *   - error    every backend was unavailable/errored, or the call was denied
 *              or aborted
 */
export type SearchState = "pending" | "running" | "complete" | "error"

export type SearchRecord = {
  /** "ws_<instance slug>_1", "…_2", … — unique across instances sharing the file. */
  id: string
  sessionID: string
  query: string
  state: SearchState
  /** The answering backend (complete) or currently-attempted one (running). */
  backend?: BackendId
  /** Short reason for the error state; display only. */
  error?: string
  startedAt: number
  /** Set when the search reaches complete/error; drives the transient window. */
  endedAt?: number
}

export type SearchesFile = {
  version: number
  /** Writer identity: lets a reader tell live state from a dead server's debris. */
  instance: { id: string; pid: number; startedAt: number }
  updatedAt: number
  searches: SearchRecord[]
}

// ---------------------------------------------------------------------------
// Retention + limits (server-side hygiene; the TUI applies the strict window)
// ---------------------------------------------------------------------------

/**
 * How long an ended search is kept in the file. The TUI hides ended rows after
 * `visibleMs` (≤ MAX_VISIBLE_MS below), so this floor guarantees the file still
 * carries a row for the whole time any TUI could want to show it.
 */
export const SERVER_RETENTION_MS = 60_000
/** Hard cap on rows in the file; the most recent survive a purge. */
export const MAX_SEARCHES = 50

// ---------------------------------------------------------------------------
// Paths (one file per project root, keyed by a stable hash)
// ---------------------------------------------------------------------------

export function searchesFilePath(
  stateDir: string,
  projectRoot: string,
): string {
  return path.join(
    stateDir,
    STATE_DIRECTORY,
    `searches-${projectFileKey(projectRoot)}.json`,
  )
}

/**
 * The name pre-slug releases gave searchesFilePath's file. The two halves are
 * separate processes upgraded independently (`opencode attach`), so for one
 * compatibility window this is a live channel bridge: the server mirrors each
 * write to the old name and the TUI falls back to it, so a half from the
 * previous release still sees the feed. Remove the bridge only once a release
 * no longer needs to interoperate with pre-slug halves.
 */
export function preSlugSearchesFilePath(
  stateDir: string,
  projectRoot: string,
): string {
  return path.join(
    stateDir,
    STATE_DIRECTORY,
    `searches-${shortProjectHash(projectRoot)}.json`,
  )
}

export type SearchesPaths = {
  stateFile: string
  /** Pre-slug generation of stateFile — see preSlugSearchesFilePath. */
  preSlugStateFile: string
}

/**
 * Resolve + containment-check the state file paths. A state directory inside
 * the project, or a descendant symlink escaping the state directory
 * (especially back into the agent-writable project), is not trusted — the
 * same rule the suite's other trusted files apply. Returns undefined when
 * anything is off.
 */
export async function resolveSearchesPath(
  projectRoot: string,
  stateDir: string,
): Promise<SearchesPaths | undefined> {
  try {
    const [realRoot, realState] = await Promise.all([
      canonicalPath(projectRoot),
      canonicalPath(stateDir),
    ])
    if (isInside(realRoot, realState)) return undefined
    const [stateFile, preSlugStateFile] = await Promise.all([
      canonicalPath(searchesFilePath(realState, realRoot)),
      canonicalPath(preSlugSearchesFilePath(realState, realRoot)),
    ])
    for (const derived of [stateFile, preSlugStateFile])
      if (isInside(realRoot, derived) || !isInside(realState, derived))
        return undefined
    return { stateFile, preSlugStateFile }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Parsing (junk-tolerant per entry: one bad row must not blank the widget)
// ---------------------------------------------------------------------------

const SEARCH_STATES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "complete",
  "error",
])

const BACKEND_IDS: ReadonlySet<string> = new Set(["searxng", "native", "exa"])

function parseSearchRecord(value: unknown): SearchRecord | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== "string" || !record.id) return undefined
  if (typeof record.sessionID !== "string" || !record.sessionID)
    return undefined
  if (typeof record.query !== "string") return undefined
  if (typeof record.state !== "string" || !SEARCH_STATES.has(record.state))
    return undefined
  if (
    typeof record.startedAt !== "number" ||
    !Number.isFinite(record.startedAt)
  )
    return undefined
  const optionalNumber = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? candidate
      : undefined
  return {
    id: record.id,
    sessionID: record.sessionID,
    query: record.query,
    state: record.state as SearchState,
    backend:
      typeof record.backend === "string" && BACKEND_IDS.has(record.backend)
        ? (record.backend as BackendId)
        : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
    startedAt: record.startedAt,
    endedAt: optionalNumber(record.endedAt),
  }
}

export function parseSearchesFile(value: unknown): SearchesFile | undefined {
  if (!value || typeof value !== "object") return undefined
  const file = value as Record<string, unknown>
  if (file.version !== STATE_FILE_VERSION) return undefined
  const instance = file.instance as Record<string, unknown> | undefined
  if (!instance || typeof instance !== "object") return undefined
  if (typeof instance.id !== "string" || typeof instance.pid !== "number")
    return undefined
  if (typeof instance.startedAt !== "number") return undefined
  if (!Array.isArray(file.searches)) return undefined
  return {
    version: STATE_FILE_VERSION,
    instance: {
      id: instance.id,
      pid: instance.pid,
      startedAt: instance.startedAt,
    },
    updatedAt: typeof file.updatedAt === "number" ? file.updatedAt : 0,
    searches: file.searches
      .map(parseSearchRecord)
      .filter((record): record is SearchRecord => record !== undefined),
  }
}

/** undefined = missing or unreadable; treated as "no searches" by the TUI. */
export async function loadSearchesFile(
  file: string,
): Promise<SearchesFile | undefined> {
  return readJsonFile(file, parseSearchesFile)
}

// ---------------------------------------------------------------------------
// Server-side record maintenance
// ---------------------------------------------------------------------------

/**
 * Search ids embed a slug of the writer instance's random id so restarted or
 * concurrent servers sharing one project file cannot collide on a bare counter.
 * The id targets no action (the sidebar is read-only), but a stable, unique key
 * still keeps the TUI's list rendering honest across instances.
 */
export function searchIdPrefix(instanceID: string): string {
  return `ws_${instanceID.replace(/-/g, "").slice(0, 6)}_`
}

/**
 * The rows worth keeping in the file: drop ended searches older than
 * `retentionMs`, then cap to `max` most-recently-started. Live rows
 * (pending/running) are never dropped by age — only the cap can shed them, and
 * only after the ended ones.
 */
export function pruneSearches(
  records: readonly SearchRecord[],
  now: number,
  retentionMs = SERVER_RETENTION_MS,
  max = MAX_SEARCHES,
): SearchRecord[] {
  const kept = records.filter((record) => {
    if (record.endedAt === undefined) return true
    return record.endedAt + retentionMs > now
  })
  if (kept.length <= max) return kept
  // Keep the most recent by start time; stable enough for a display list.
  return [...kept].sort((a, b) => b.startedAt - a.startedAt).slice(0, max)
}

// ---------------------------------------------------------------------------
// TUI options
// ---------------------------------------------------------------------------

export type TuiOptions = {
  /** Render the sidebar widget (default true). */
  sidebar: boolean
  /** How long a completed/errored search stays visible after it ends. */
  visibleMs: number
  /** Fallback poll interval for the state file; the poke usually beats it. */
  pollMs: number
}

export const DEFAULT_VISIBLE_MS = 10_000
export const MIN_VISIBLE_MS = 1_000
// Capped so SERVER_RETENTION_MS always covers the visible window: the file must
// still hold a row for as long as any TUI would display it.
export const MAX_VISIBLE_MS = SERVER_RETENTION_MS
export const DEFAULT_POLL_MS = 15_000
export const MIN_POLL_MS = 2_000

export function resolveTuiOptions(raw: unknown): TuiOptions {
  const options = (raw ?? {}) as Record<string, unknown>
  return {
    sidebar: options.sidebar !== false,
    visibleMs: clampNumber(
      options.visibleMs,
      DEFAULT_VISIBLE_MS,
      MIN_VISIBLE_MS,
      MAX_VISIBLE_MS,
    ),
    pollMs: clampNumber(
      options.pollMs,
      DEFAULT_POLL_MS,
      MIN_POLL_MS,
      MAX_TIMER_MS,
    ),
  }
}

// ---------------------------------------------------------------------------
// Presentation (used by the sidebar; pinned here so tests own the wording)
// ---------------------------------------------------------------------------

/** Short backend labels for the narrow sidebar column. */
export const SIDEBAR_BACKEND_LABELS: Record<BackendId, string> = {
  searxng: "SearXNG",
  native: "provider",
  exa: "Exa",
}

export function searchGlyph(state: SearchState): string {
  if (state === "pending") return "○"
  if (state === "running") return "◐"
  if (state === "error") return "✗"
  return "✓"
}

/**
 * The bracketed `[label]` shown before a row's query. The glyph already carries
 * the state, so this holds the backend once one is known and a short fallback
 * word otherwise (awaiting permission, no backend reached yet, or the failure
 * reason).
 */
export function searchLabel(record: SearchRecord): string {
  switch (record.state) {
    case "pending":
      return "queued"
    case "running":
      return record.backend ? SIDEBAR_BACKEND_LABELS[record.backend] : "…"
    case "complete":
      return record.backend ? SIDEBAR_BACKEND_LABELS[record.backend] : "done"
    case "error":
      return record.error ?? "failed"
  }
}

// A query renders in the sidebar exactly like a task or subagent label does,
// so it uses the same helper — re-exported here because this module is the
// one import site the TUI half reads this channel through.
export { truncateLabel } from "@macarons/permission-rules"

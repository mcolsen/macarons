import { randomUUID } from "node:crypto"
import { unwatchFile, watchFile } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  isLockBusyError,
  keybindOption,
  notePromptSession,
  openCodeDataDir,
  patchSettingsFile,
  pathExists,
  promptSessionFamily,
  routeSessionID,
  trim,
  tuiGate,
  tuiToast,
  verifyFilesystemLocality,
} from "@macarons/permission-rules"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import {
  createEffect,
  createSignal,
  createMemo as createSolidMemo,
  onCleanup,
} from "solid-js"
import {
  ACTIVITY_REASON_MAX,
  type Activity,
  clearTrustedSessionModelIfUnchanged,
  DEFAULT_TIMEOUT_MS,
  formatModelRef,
  globalConfigCandidates,
  hostConfigRoot,
  legacyProjectSettingsFile,
  type Override,
  ownPackageDir,
  type PolicySnapshot,
  parseModelRef,
  parseSettings,
  patchGlobalEntryOptions,
  projectConfigDisabled,
  readActivity,
  readBlessing,
  readOverride,
  readPolicySnapshot,
  readTrustedSessionModel,
  requestInstanceID,
  resolveSettings,
  resolveTrustedSessionModelFile,
  resolveTrustedSettingsPaths,
  SERVICE,
  SESSION_ANCESTRY_HOP_LIMIT,
  type ServerStatus,
  type SessionModelReadResult,
  type SessionModelRecord,
  STORAGE_SERVICE,
  scanSideloadSources,
  scanWorktreeConfig,
  sessionModelFile,
  settingsLocalityPaths,
  TRUNCATE_SUFFIX,
  type TrustedSettingsPaths,
  worktreeConfigCandidates,
  writeBlessing,
  writeOverride,
  writeSessionModel,
} from "./shared"

/**
 * opencode-approve-for-me — TUI companion
 *
 * The interactive controls for Approve for Me; the server half (src/index.ts) does
 * the classifying. This half registers:
 *
 *   - Approve for Me: toggle for this instance — a keybinding (<leader>d by
 *     default; ctrl+alt+a works too) and palette command that pauses or
 *     resumes auto-approval for the running OpenCode instance only, like
 *     Claude Code's shift+tab. It writes the instance override file the
 *     server half re-reads on every request, so it applies immediately; the
 *     override dies with the instance and the persistent default takes over
 *     again on next start.
 *   - Approve for Me: choose classifier model — a model picker over every
 *     provider/model available in this OpenCode instance, plus "Session model
 *     (default)". When the picked model defines variants (OpenCode's effort
 *     levels), a second step picks one, or the model's default. Scope is
 *     chosen first: a trusted root-session record, a trusted project-keyed
 *     config file, or this plugin's global opencode.json[c] entry (edited
 *     surgically so comments survive). Worktree config is only ever honored
 *     under the blessing below — an agent with project edit access must not
 *     be able to reconfigure the judge that approves its own actions.
 *   - Approve for Me: set classifier timeout — a picker over preset
 *     wall-clock budgets for one classification (default 2 minutes; local
 *     and budget cloud judges can take well over a minute per verdict).
 *     Saved to the same project-keyed or global settings file as the model
 *     pin, "Default" clearing the pin like the model picker's session-model
 *     entry.
 *   - Approve for Me: set persistent default — enable or disable Approve for Me
 *     durably, per project or globally.
 *   - Approve for Me: trust project plugin config — reviews and blesses the
 *     worktree-local OpenCode config (opencode.json[c],
 *     .opencode/opencode.json[c]) and sideloaded .opencode/plugin sources.
 *     Worktree config that names this plugin is honored ONLY while its exact
 *     bytes match this blessing (recorded in the trusted state directory);
 *     any edit — including the agent's — pauses auto-approval until re-trusted
 *     here. Revoking forgets every approved file.
 *   - A sidebar status section — a bold "Approve for Me" header over a status
 *     line — showing whether auto-approval is active right now and which model
 *     judges: the trust posture stays visible whenever a session is open,
 *     shaped like the host's own Context and LSP sidebar sections. "Active
 *     right now" is not read off the settings files alone: the server half
 *     writes a ready/paused beacon into the instance-scoped activity file,
 *     and the TUI itself pre-checks a pinned judge against this instance's
 *     model catalog — so a missing server half, an unreadable store, or a
 *     pinned model this instance does not have all render as "paused ·
 *     reason" instead of a false "on".
 *   - A sidebar activity stream under that status line: one line per
 *     permission prompt of the viewed session (and its sub-agent children),
 *     annotated with what the server half is doing — evaluating, approved,
 *     needs you (and why, rendered in full: explanations wrap rather than
 *     truncate). Fast bursts of prompts stay legible where toasts
 *     scroll away: an item the classifier did not approve persists until the
 *     user answers the prompt, while approvals fade out after a few seconds.
 *     Pending items come from the host's own permission state; the classifier
 *     annotations arrive through an instance-scoped activity file the server
 *     half writes (the same channel and lifetime as the toggle override).
 *
 * All of this is user-only surface. The agent cannot invoke palette commands
 * or keybindings, so it has no way to switch its own judge or re-enable a
 * paused Approve for Me.
 *
 * Install both halves with `opencode plugin <path-or-package>`. Options
 * (second element of a `["file://…", {…}]` plugin entry):
 *   - keybind: string — key(s) for the toggle, comma-separated alternatives
 *     (default "<leader>d,ctrl+alt+a"); only the first alternative shows in
 *     the command palette's hint column, the rest stay functional but
 *     undisplayed. false or "none" removes the binding, leaving the palette
 *     entries.
 *   - sidebar: boolean — show the status line (default true).
 *   - feed: boolean — show the activity stream under the status line
 *     (default true; requires sidebar).
 *
 * Targets OpenCode v1 (verified against 1.17.14–1.18.x), like the server half:
 * warns outside that band, disables only on OpenCode v2+.
 */

// Command IDs stay stable so existing user keybindings continue to work.
const TOGGLE_COMMAND = "permissions_approve_for_me.toggle"
const MODEL_COMMAND = "permissions_approve_for_me.model"
const TIMEOUT_COMMAND = "permissions_approve_for_me.timeout"
const DEFAULT_COMMAND = "permissions_approve_for_me.default"
const TRUST_COMMAND = "permissions_approve_for_me.trust"
// A leader chord first plus a single-stroke alternative. <leader>d is a free
// leader letter — <leader>a is already OpenCode's agent_list ("List agents"),
// so binding it would collide with a built-in — and ctrl+alt+a is unbound in
// the stock keymap (unlike ctrl+a line-start and shift+tab host focus
// cycling). Order matters: only the first alternative appears in the command
// palette's keybind hint (see the bindings registration below).
const DEFAULT_KEYBIND = "<leader>d,ctrl+alt+a"

// "Session model" sentinel for the picker; a settings-file value of null
// means the same thing (and lets a project file override a global pin).
const SESSION_MODEL = null
// A symbol keeps the picker-only option distinct from every possible model
// reference; a string union would collapse this sentinel back to `string`.
const PROJECT_OR_GLOBAL_MODEL = Symbol("project-or-global-model")
const FILE_WATCH_INTERVAL_MS = 250
const SESSION_MODEL_WATCHERS_MAX = 16
// Poll for late host paths and retry owner discovery between transport hints.
const PATH_SYNC_POLL_MS = 250
// The suite's wording for the boot race — a transient state the user retries,
// never to be blamed on path safety (persist-permissions et al. say the same).
const PATHS_SYNCING_MESSAGE =
  "OpenCode's paths are still syncing — try again in a moment."
const SESSION_DETAILS_SYNCING_REASON =
  "session details are still syncing or unavailable"
const FILESYSTEM_UNVERIFIED_MESSAGE =
  "Approve for Me controls are unavailable: shared filesystem access with the server could not be verified. Server settings are unchanged; classification may still be active."

type Scope = "project" | "global"
type ModelScope = "session" | Scope

// The bold header for the sidebar section, sitting beside the host's own
// "Context" and "LSP" headers.
const SIDEBAR_HEADER = "Approve for Me"

// The content line rendered under that header, pure so tests can pin the whole
// matrix. It drops the "Approve for Me" name the header already carries.
// `pauseReason` is a TUI-side fault (unsafe paths, migration, unreadable
// settings); `server` is what the server half's beacon says — "starting"
// while the first disk read or the beacon itself is still pending, "missing"
// when no beacon appeared within the startup grace (server half not installed
// or dead); `override` is the instance toggle (undefined when untouched),
// `defaultEnabled` the merged persistent setting. Saying "on" requires the
// whole chain to hold — settings on, no TUI-side fault, a ready beacon — so
// the line can never claim a model is approving while nothing is.
export function statusLabel(input: {
  pauseReason?: string
  server: "ready" | "paused" | "starting" | "missing"
  serverReason?: string
  override: boolean | undefined
  defaultEnabled: boolean
  model: string
}): string {
  if (input.pauseReason) return `paused · ${input.pauseReason}`
  const enabled = input.override ?? input.defaultEnabled
  // "(this instance)" only when the toggle disagrees with the persistent
  // default — otherwise the override is redundant and goes unmentioned.
  const instance =
    input.override !== undefined && input.override !== input.defaultEnabled
      ? " (this instance)"
      : ""
  if (!enabled) return `off${instance}`
  if (input.server === "paused")
    return `paused · ${input.serverReason || "server fault"}`
  if (input.server === "missing") return "paused · server half not running"
  if (input.server === "starting") return "starting…"
  return `on${instance} · ${input.model}`
}

// ---------------------------------------------------------------------------
// The activity stream, as pure data
// ---------------------------------------------------------------------------

export type FeedRequest = {
  id: string
  permission: string
  patterns: readonly string[]
}
export type FeedSettled = FeedRequest & { reply: "once" | "always" | "reject" }
export type FeedTone = "info" | "warning" | "success" | "muted"
export type FeedLine = {
  marker: "⋯" | "!" | "·" | "✓" | "✗"
  tone: FeedTone
  text: string
  /** The explanation under the line, in full — the renderer wraps it. */
  reason?: string
}

// Sidebar lines are one narrow column; clip headlines with a plain ellipsis
// rather than wrap, so a burst of prompts stays one line per item.
const FEED_TEXT_MAX = 44
// Explanations are the exception: a needs-you reason is exactly what the
// user weighs before answering — a truncated "why" reads as innocuous when
// it is not — and a reject's explanation is the one chance to see why a
// prompt went away. Both keep their full text and the renderer wraps them.
// The server half normalizes every reason to ACTIVITY_REASON_MAX before
// recording it, so this cap — sized to pass any normalized value, truncate
// suffix included — never clips a recorded explanation; it only stops a
// corrupt activity file from flooding the sidebar.
const FEED_REASON_MAX = ACTIVITY_REASON_MAX + TRUNCATE_SUFFIX.length
// Pending prompts are the actionable backlog and all count toward the "+N
// more waiting" tail; settled items are just an exit animation.
const FEED_MAX_PENDING = 4
const FEED_MAX_SETTLED = 2

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function feedHeadline(request: {
  permission: string
  patterns: readonly string[]
}): string {
  return clip(
    `${request.permission}: ${request.patterns.join(", ")}`,
    FEED_TEXT_MAX,
  )
}

// "3h" / "14m" / "<1m" — coarse on purpose; the sidebar is not a stopwatch,
// and the 30 s tick keeps it fresh enough for a minutes-scale deadline.
function denyEta(remainingMs: number): string {
  if (remainingMs >= 5_400_000) return `${Math.round(remainingMs / 3_600_000)}h`
  if (remainingMs >= 60_000) return `${Math.round(remainingMs / 60_000)}m`
  return "<1m"
}

// The stream's render model: pending prompts first (they persist until the
// user or the classifier settles them), then recently settled ones. Activity
// entries — keyed by request id, written by the server half — refine the
// label; without one a pending prompt is simply waiting for the user, which
// is also the graceful degradation when the activity file is unreadable.
export function feedItems(input: {
  pending: readonly FeedRequest[]
  settled: readonly FeedSettled[]
  activity: Activity
  /** ms epoch for rendering unattended-deny countdowns; without it (or once
   *  a deadline has passed) the `!` lines simply show no countdown. */
  now?: number
}): { lines: FeedLine[]; hiddenPending: number } {
  const lines: FeedLine[] = []
  const pending = input.pending.slice(0, FEED_MAX_PENDING)
  for (const request of pending) {
    const entry = input.activity[request.id]
    const text = feedHeadline(request)
    if (!entry) {
      lines.push({ marker: "·", tone: "muted", text })
    } else if (
      entry.state === "evaluating" ||
      entry.state === "approved" ||
      entry.state === "denied"
    ) {
      // "approved"/"denied" while still pending means the reply is in
      // flight — the classifier has it either way.
      lines.push({ marker: "⋯", tone: "info", text })
    } else {
      // A live deny deadline rides the end of the reason — appended after
      // the cap, so even a cap-length reason never hides the countdown.
      const eta =
        entry.denyAt !== undefined &&
        input.now !== undefined &&
        entry.denyAt > input.now
          ? `deny in ${denyEta(entry.denyAt - input.now)}`
          : undefined
      const reason = eta
        ? entry.reason
          ? `${clip(entry.reason, FEED_REASON_MAX)} · ${eta}`
          : eta
        : entry.reason
          ? clip(entry.reason, FEED_REASON_MAX)
          : undefined
      lines.push({
        marker: "!",
        tone: "warning",
        text,
        ...(reason ? { reason } : {}),
      })
    }
  }
  for (const request of input.settled.slice(-FEED_MAX_SETTLED)) {
    const text = feedHeadline(request)
    if (request.reply === "reject") {
      // An unattended deny explains itself under the exit line, so a user
      // who steps back within the linger sees why the prompt went away.
      const entry = input.activity[request.id]
      lines.push({
        marker: "✗",
        tone: "muted",
        text,
        ...(entry?.state === "denied" && entry.reason
          ? { reason: clip(entry.reason, FEED_REASON_MAX) }
          : {}),
      })
    } else {
      // Success colour only for the classifier's own approvals; the user's
      // answers settle in muted — they already know they pressed the key.
      const byClassifier = input.activity[request.id]?.state === "approved"
      lines.push({
        marker: "✓",
        tone: byClassifier ? "success" : "muted",
        text,
      })
    }
  }
  return {
    lines,
    hiddenPending: Math.max(0, input.pending.length - pending.length),
  }
}

export const tui: TuiPlugin = async (api, options) => {
  // A server-reported path or loopback URL is not proof of shared storage.
  // File access requires a shared-filesystem proof; the connected server's
  // discovered owner ID separately scopes its override and activity files.
  if (
    tuiGate(api, {
      label: "Approve for Me",
      service: SERVICE,
      remoteBails: false,
    }).disabled
  )
    return

  const keybind = keybindOption(options?.keybind, DEFAULT_KEYBIND)
  const sidebar = options?.sidebar !== false
  const feed = sidebar && options?.feed !== false

  // Non-git projects report worktree "/" (opencode's instance-context
  // sentinel); treat it as absent, same as the server half, so both compute
  // the same project root — and therefore the same override-file key.
  const root = () => {
    const { worktree, directory } = api.state.path
    return worktree && worktree !== "/" ? worktree : directory
  }
  // The host's own config-discovery boundary, which non-git sessions keep
  // at "/" — the policy and sideload scans must mirror the host's upward
  // search, not stop at the launch directory.
  const configRoot = () => hostConfigRoot(api.state.path.worktree)

  const toast = tuiToast(api)

  // This plugin's own package root, for recognizing its plugin entry in
  // opencode.json[c] files — resolved once; it cannot move within a TUI
  // instance.
  const packageDir = await ownPackageDir()

  // The whole settings pipeline mirrored into one signal so the sidebar
  // re-renders on our own writes and on edits from outside this TUI —
  // computed by the same readPolicySnapshot the server half runs, so the two
  // can never disagree about why the feature is paused. undefined means the
  // pipeline could not be evaluated at all. It starts undefined: until the
  // first disk read lands, nothing may render or act as if the defaults were
  // known-good — the fail-closed state is the initial one.
  const [policy, setPolicy] = createSignal<PolicySnapshot | undefined>(
    undefined,
  )
  const [override, setOverride] = createSignal<Override | undefined>(undefined)
  let overrideReadGeneration = 0
  let overrideAppliedGeneration = 0
  const [migrationRequired, setMigrationRequired] = createSignal(false)
  const [preSlugConflict, setPreSlugConflict] = createSignal(false)
  const [loaded, setLoaded] = createSignal(false)
  const [instanceUnavailable, setInstanceUnavailable] = createSignal(false)
  const [sharedFilesystem, setSharedFilesystem] = createSignal<
    boolean | undefined
  >(undefined)
  // The server half's per-request annotations for the activity stream, and
  // its ready/paused beacon. Unreadable degrades to empty annotations and no
  // beacon: the stream's pending prompts come from the host's own state, not
  // this file, and a beacon we cannot read must never count as "ready".
  const [activity, setActivity] = createSignal<Activity>({})
  const [serverStatus, setServerStatus] = createSignal<
    ServerStatus | undefined
  >(undefined)

  const reloadSettings = async (trusted: TrustedSettingsPaths) => {
    const epoch = localityEpoch
    if (!localityCurrent(epoch) || settledPaths()?.trusted !== trusted) return
    const [legacyExists, trustedProjectExists, preSlugExists] =
      await Promise.all([
        pathExists(legacyProjectSettingsFile(trusted.projectRoot)),
        pathExists(trusted.projectSettingsFile),
        pathExists(trusted.preSlugProjectSettingsPath),
      ])
    if (!localityCurrent(epoch) || settledPaths()?.trusted !== trusted) return
    if (
      legacyExists === undefined ||
      trustedProjectExists === undefined ||
      preSlugExists === undefined
    ) {
      setPolicy(undefined)
      return
    }
    setMigrationRequired(legacyExists && !trustedProjectExists)
    // Mirrors the server half's fail-closed gate: a file still at the
    // pre-slug settings name is pre-upgrade policy this release cannot read.
    setPreSlugConflict(preSlugExists)
    const snapshot = await readPolicySnapshot({
      configDir: trusted.configDir,
      projectSettingsFile: trusted.projectSettingsFile,
      blessPath: trusted.blessPath,
      legacyGlobalFile: trusted.globalSettingsFile,
      directory: api.state.path.directory,
      projectRoot: root(),
      configRoot: configRoot(),
      packageDir,
    })
    if (localityCurrent(epoch) && settledPaths()?.trusted === trusted)
      setPolicy(snapshot)
  }
  const reloadOverride = async (trusted: TrustedSettingsPaths) => {
    const epoch = localityEpoch
    if (!localityCurrent(epoch) || settledPaths()?.trusted !== trusted)
      return undefined
    const generation = ++overrideReadGeneration
    const current = await readOverride(trusted.overridePath)
    if (!localityCurrent(epoch) || settledPaths()?.trusted !== trusted)
      return undefined
    // Prefer a newer completed read, but never wait for pending watchers:
    // continuous activity on a slow filesystem must not starve an OFF toggle.
    if (generation < overrideAppliedGeneration) return override()
    overrideAppliedGeneration = generation
    setOverride(current)
    return current
  }
  const reloadActivity = async (trusted: TrustedSettingsPaths) => {
    const epoch = localityEpoch
    if (!localityCurrent(epoch) || settledPaths()?.trusted !== trusted) return
    // The same gate every other file read gets, now structural: only
    // beginWatching calls this, and only trusted paths reach beginWatching.
    // With untrusted derived paths the fallback location is agent-writable,
    // and nothing from it — annotations or beacon — may be rendered as if the
    // server half wrote it.
    const file = await readActivity(trusted.activityPath)
    if (!localityCurrent(epoch) || settledPaths()?.trusted !== trusted) return
    setActivity(file?.requests ?? {})
    setServerStatus(file?.server)
  }

  // With trusted paths in hand, wire the disk mirror: watch every file whose
  // change must re-render the sidebar, and kick the first read. Never called
  // for placeholder or untrusted paths — a watcher on a placeholder-derived
  // path would poll junk under the process cwd for the TUI's whole life.
  let disposed = false
  let localityEpoch = 0
  let teardownWatchers: (() => void) | undefined
  // The first read is what toggle() and the status line wait for; later
  // watcher-driven reloads just refresh the signals. A resolved placeholder
  // until adoption — every consumer checks the paths gate first.
  let firstLoad: Promise<void> = Promise.resolve()
  const beginWatching = (trusted: TrustedSettingsPaths) => {
    if (disposed) return
    const epoch = localityEpoch
    const watchedFiles = [
      // Legacy bespoke global file: its (re)appearance must pause immediately.
      trusted.globalSettingsFile,
      trusted.projectSettingsFile,
      legacyProjectSettingsFile(trusted.projectRoot),
      // Unmigrated durable policy still pauses the toggle. Unowned legacy
      // override/activity files are not this server's channel.
      trusted.preSlugProjectSettingsPath,
      trusted.overridePath,
      // The live settings sources: global opencode.json[c] candidates, every
      // worktree candidate the host would merge, and the blessing record.
      ...globalConfigCandidates(api.state.path.config),
      ...worktreeConfigCandidates(api.state.path.directory, configRoot()),
      trusted.blessPath,
      trusted.activityPath,
    ]
    const reloadFromDisk = () => {
      if (!localityCurrent(epoch) || settledPaths()?.trusted !== trusted)
        return Promise.resolve()
      return Promise.all([
        reloadSettings(trusted),
        reloadOverride(trusted),
        reloadActivity(trusted),
      ]).then(() => {
        if (localityCurrent(epoch) && settledPaths()?.trusted === trusted)
          setLoaded(true)
      })
    }
    firstLoad = reloadFromDisk()
    for (const file of watchedFiles) {
      // watchFile also observes files that do not exist yet, which matters for
      // both first-time settings creation and a first instance toggle. Polling
      // stat avoids platform-specific recursive-directory watcher behavior.
      watchFile(
        file,
        { interval: FILE_WATCH_INTERVAL_MS, persistent: false },
        reloadFromDisk,
      )
    }
    teardownWatchers = () => {
      for (const file of watchedFiles) unwatchFile(file, reloadFromDisk)
    }
  }

  const invalidateLocality = (shared?: false) => {
    localityEpoch++
    teardownWatchers?.()
    teardownWatchers = undefined
    clearSessionModelMirrors()
    setSharedFilesystem(shared)
    setLoaded(false)
    setPolicy(undefined)
    setOverride(undefined)
    setActivity({})
    setServerStatus(undefined)
  }

  const localityCurrent = (epoch: number, explicit = false) => {
    const current =
      !disposed && epoch === localityEpoch && sharedFilesystem() === true
    if (!current && explicit && !disposed)
      toast("warning", FILESYSTEM_UNVERIFIED_MESSAGE)
    return current
  }

  let localityFlight:
    | { epoch: number; explicit: boolean; promise: Promise<boolean> }
    | undefined
  const verifyLocality = async (
    trusted: TrustedSettingsPaths,
    explicit = false,
  ) => {
    if (disposed) return false
    if (settledPaths()?.trusted !== trusted) {
      if (explicit) toast("warning", "Server instance changed; try again.")
      return false
    }
    const epoch = localityEpoch
    if (localityFlight?.epoch !== epoch) {
      const flight = {
        epoch,
        explicit,
        promise: Promise.resolve()
          .then(async () => {
            const paths = await settingsLocalityPaths(trusted)
            const shared =
              !!paths &&
              (await verifyFilesystemLocality(api, {
                service: STORAGE_SERVICE,
                directory: api.state.path.directory,
                paths,
              }))
            if (
              disposed ||
              epoch !== localityEpoch ||
              settledPaths()?.trusted !== trusted
            )
              return false
            if (!shared) {
              invalidateLocality(false)
              if (flight.explicit)
                toast("warning", FILESYSTEM_UNVERIFIED_MESSAGE)
            } else {
              setSharedFilesystem(true)
              if (!teardownWatchers) beginWatching(trusted)
            }
            return shared
          })
          .finally(() => {
            // Share only pending checks, not proofs across later dialog writes.
            // An invalidated flight must not clear its replacement on reconnect.
            if (localityFlight === flight) localityFlight = undefined
          }),
      }
      localityFlight = flight
    }
    localityFlight.explicit ||= explicit
    const shared = await localityFlight.promise
    return shared && !disposed && epoch === localityEpoch
  }

  // Paths arrive asynchronously, and project/URL identity cannot identify a
  // server lifetime. Discover the owner over this TUI's actual transport;
  // re-discover after reload/reconnect instead of adopting a peer's files.
  const [settledPaths, setSettledPaths] = createSignal<
    { trusted: TrustedSettingsPaths | undefined } | undefined
  >(undefined)
  let instanceID: string | undefined
  let lastDiscovery = Number.NEGATIVE_INFINITY
  let discoveryGeneration = 0
  let adoption: Promise<TrustedSettingsPaths | undefined> | undefined
  const adoptPaths = ():
    | Promise<TrustedSettingsPaths | undefined>
    | undefined => {
    if (disposed) return undefined
    const { directory, config, state } = api.state.path
    const projectRoot = root()
    if (!directory || !projectRoot || !config || !state) return undefined
    if (!adoption) {
      const generation = discoveryGeneration
      adoption = (async () => {
        const owner = await requestInstanceID(api)
        if (disposed || generation !== discoveryGeneration) return undefined
        lastDiscovery = performance.now()
        setInstanceUnavailable(!owner)
        // A missed probe invalidates the live claim, not the disk mirror.
        // Keep its bounded watchers until a replacement owner is discovered.
        if (!owner) return undefined
        if (owner === instanceID && settledPaths()) {
          const trusted = settledPaths()?.trusted
          if (trusted && sharedFilesystem() !== true)
            void verifyLocality(trusted)
          return trusted
        }
        invalidateLocality()
        instanceID = owner
        setSettledPaths(undefined)
        const trusted = await resolveTrustedSettingsPaths(
          projectRoot,
          config,
          state,
          openCodeDataDir(process.env, os.homedir()),
          owner,
          { migrate: false },
        )
        if (disposed || generation !== discoveryGeneration) return undefined
        setSettledPaths({ trusted })
        if (trusted) await verifyLocality(trusted)
        return trusted
      })().finally(() => {
        adoption = undefined
        // A reconnect/dispose hint during a probe must not be consumed by
        // that probe's stale response or postpone the fresh attempt.
        if (!disposed && generation !== discoveryGeneration) void adoptPaths()
      })
    }
    return adoption
  }
  const invalidateDiscovery = () => {
    if (disposed) return
    discoveryGeneration++
    lastDiscovery = Number.NEGATIVE_INFINITY
    setInstanceUnavailable(true)
    invalidateLocality()
    void adoptPaths()
  }
  api.lifecycle.onDispose(api.event.on("server.connected", invalidateDiscovery))
  api.lifecycle.onDispose(api.event.on("global.disposed", invalidateDiscovery))
  api.lifecycle.onDispose(
    api.event.on("server.instance.disposed", (event) => {
      if (event.properties.directory === api.state.path.directory)
        invalidateDiscovery()
    }),
  )
  void adoptPaths()
  const pathSyncPoll = setInterval(() => {
    if (performance.now() - lastDiscovery >= 5_000) void adoptPaths()
  }, PATH_SYNC_POLL_MS)
  api.lifecycle.onDispose(() => clearInterval(pathSyncPoll))

  // Every user flow enters here. "syncing" is the transient boot race (the
  // host's path batch has not landed yet); "unsafe" is real paths having
  // failed the trust checks — the one permanent state; "ready" additionally
  // waits out the first disk read so nothing acts on default-initialized
  // signals.
  type PathsGate =
    | { state: "syncing"; message: string }
    | { state: "unsafe" }
    | { state: "unshared" }
    | {
        state: "ready"
        trusted: TrustedSettingsPaths
        instanceID: string
        epoch: number
      }
  const gatePaths = async (): Promise<PathsGate> => {
    const generation = discoveryGeneration
    const pending = adoptPaths()
    if (!pending) return { state: "syncing", message: PATHS_SYNCING_MESSAGE }
    const trusted = await pending
    if (
      !instanceID ||
      instanceUnavailable() ||
      disposed ||
      generation !== discoveryGeneration
    )
      return {
        state: "syncing",
        message:
          "Approve for Me server instance unavailable. Update and restart both plugin halves before toggling.",
      }
    if (!trusted) return { state: "unsafe" }
    const owner = instanceID
    const epoch = localityEpoch
    if (!(await verifyLocality(trusted, true))) return { state: "unshared" }
    await firstLoad
    if (!localityCurrent(epoch, true)) return { state: "unshared" }
    if (
      disposed ||
      instanceUnavailable() ||
      owner !== instanceID ||
      settledPaths()?.trusted !== trusted
    )
      return {
        state: "syncing",
        message: "Server instance changed; try again.",
      }
    return { state: "ready", trusted, instanceID: owner, epoch }
  }

  // Session pins live outside the worktree and are independent for every root
  // session. Keep a small LRU of live file mirrors: slot rendering can visit
  // several sessions, but a long-lived TUI must not leave one watcher per
  // session it has ever shown.
  type SessionModelMirror = {
    read: () => SessionModelReadResult | undefined
    reload: () => Promise<void>
    stop: () => void
    leases: number
  }
  type EffectiveModel = {
    model: string | null | undefined
    variant: string | null | undefined
    source: "persistent" | "session"
    loading: boolean
    invalid: boolean
    ancestryUnresolved: boolean
  }
  const sessionModelMirrors = new Map<string, SessionModelMirror>()
  const rootSessionID = (sessionID: string): string | undefined => {
    if (!sessionID || sessionID !== sessionID.trim()) return undefined
    let current = sessionID
    let hops = 0
    const seen = new Set<string>()
    for (;;) {
      if (seen.has(current)) return undefined
      seen.add(current)
      let session: unknown
      let parentID: unknown
      try {
        session = api.state.session.get(current)
        if (
          typeof session !== "object" ||
          session === null ||
          Array.isArray(session)
        )
          return undefined
        parentID = (session as { parentID?: unknown }).parentID
      } catch {
        return undefined
      }
      if (parentID === undefined) return current
      if (
        typeof parentID !== "string" ||
        !parentID ||
        parentID !== parentID.trim()
      )
        return undefined
      if (hops >= SESSION_ANCESTRY_HOP_LIMIT) return undefined
      hops += 1
      current = parentID
    }
  }
  const clearSessionModelMirrors = () => {
    for (const mirror of sessionModelMirrors.values()) mirror.stop()
    sessionModelMirrors.clear()
  }
  const pruneSessionModelMirrors = () => {
    // Never evict a rendered sidebar's mirror: stopping that watcher leaves
    // the visible slot silently stale until another unrelated render happens.
    // The bound therefore applies to historical, unleased mirrors only.
    while (sessionModelMirrors.size > SESSION_MODEL_WATCHERS_MAX) {
      const oldest = [...sessionModelMirrors.entries()].find(
        ([, mirror]) => mirror.leases === 0,
      )
      if (!oldest) break
      const [rootID, discarded] = oldest
      sessionModelMirrors.delete(rootID)
      discarded.stop()
    }
  }
  const sessionModelMirror = (rootID: string | undefined) => {
    if (!rootID) return undefined
    if (!sharedFilesystem()) return undefined
    const existing = sessionModelMirrors.get(rootID)
    if (existing) {
      sessionModelMirrors.delete(rootID)
      sessionModelMirrors.set(rootID, existing)
      return existing
    }
    const trusted = settledPaths()?.trusted
    if (!trusted) return undefined
    const file = sessionModelFile(trusted.sessionModelsDir, rootID)
    const [read, setRead] = createSignal<SessionModelReadResult | undefined>(
      undefined,
    )
    let stopped = false
    let reloadGeneration = 0
    const reload = async () => {
      const generation = ++reloadGeneration
      if (stopped) return
      const result = await readTrustedSessionModel(
        trusted.sessionModelsDir,
        rootID,
      )
      if (!disposed && !stopped && generation === reloadGeneration)
        setRead(result)
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      reloadGeneration++
      unwatchFile(file, reload)
    }
    const mirror = { read, reload, stop, leases: 0 }
    sessionModelMirrors.set(rootID, mirror)
    watchFile(
      file,
      { interval: FILE_WATCH_INTERVAL_MS, persistent: false },
      reload,
    )
    void reload()
    pruneSessionModelMirrors()
    return mirror
  }
  const leaseSessionModelMirror = (rootID: string | undefined) => {
    const mirror = sessionModelMirror(rootID)
    if (!mirror) return undefined
    mirror.leases += 1
    return () => {
      mirror.leases -= 1
      pruneSessionModelMirrors()
    }
  }
  const refreshSessionModel = async (rootID: string | undefined) => {
    await sessionModelMirror(rootID)?.reload()
  }
  const effectiveModel = (
    rootID?: string,
    sessionScoped = false,
  ): EffectiveModel => {
    const persistent = merged()
    if (!sessionScoped)
      return {
        model: persistent.model,
        variant: persistent.variant,
        source: "persistent" as const,
        loading: false,
        invalid: false,
        ancestryUnresolved: false,
      }
    if (!rootID)
      return {
        model: persistent.model,
        variant: persistent.variant,
        source: "persistent" as const,
        loading: false,
        invalid: false,
        ancestryUnresolved: true,
      }
    const read = sessionModelMirror(rootID)?.read()
    if (!read)
      return {
        model: persistent.model,
        variant: persistent.variant,
        source: "persistent" as const,
        loading: true,
        invalid: false,
        ancestryUnresolved: false,
      }
    if (read.status !== "valid" || read.record.mode === "inherit")
      return {
        model: persistent.model,
        variant: persistent.variant,
        source: "persistent" as const,
        loading: false,
        invalid: read.status === "invalid",
        ancestryUnresolved: false,
      }
    return {
      model: read.record.model,
      variant: read.record.variant,
      source: "session" as const,
      loading: false,
      invalid: false,
      ancestryUnresolved: false,
    }
  }
  const modelLabel = (model: EffectiveModel) => {
    return `${model.model ?? "session model"}${model.variant ? ` · ${model.variant}` : ""}${model.source === "session" ? " · this session" : ""}`
  }
  // A TUI-side fault before any request hits the server: the effective pin for
  // this root session names a model or variant this instance cannot provide.
  // Session-model judging itself can only be checked server-side.
  const judgePause = ({ model, variant, loading }: EffectiveModel) => {
    if (loading) return undefined
    if (!model) return undefined
    const info = modelInfo(model)
    if (!info) return `pinned model ${model} unavailable here`
    if (variant && !info.variants.includes(variant))
      return `pinned variant "${variant}" unavailable here`
    return undefined
  }
  // No beacon can mean the server half is still bootstrapping (it writes one
  // as soon as its trusted paths resolve) or that it is not there at all.
  // Give bootstrap a grace window before the sidebar calls it missing. Live
  // owner discovery stops trusting a crashed server's stale beacon;
  // another server's beacon can never substitute for it.
  const SERVER_BEACON_GRACE_MS = 10_000
  const [beaconGraceOver, setBeaconGraceOver] = createSignal(false)
  const beaconGraceTimer = setTimeout(
    () => setBeaconGraceOver(true),
    SERVER_BEACON_GRACE_MS,
  )
  api.lifecycle.onDispose(() => {
    disposed = true
    localityEpoch++
    clearTimeout(beaconGraceTimer)
    teardownWatchers?.()
    clearSessionModelMirrors()
  })

  const pauseReason = () => {
    if (instanceUnavailable()) return "server instance unavailable"
    // Only REAL paths that failed the trust checks may be called unsafe;
    // while the host's path sync is still pending nothing is wrong yet — the
    // status line renders that window as "starting…" (the first disk read
    // cannot have landed either) and the user flows name the boot race.
    const settled = settledPaths()
    if (settled && !settled.trusted) return "settings path unsafe"
    // Before the first disk read the signals are undefined by construction,
    // not because anything is wrong; the status line renders that window as
    // "starting…" and toggle() waits it out.
    if (!loaded()) return undefined
    if (migrationRequired()) return "settings migration required"
    if (preSlugConflict()) return "pre-upgrade settings file needs review"
    const fault = policy()?.fault
    if (!policy()) return "settings unreadable"
    if (!fault) return undefined
    switch (fault.kind) {
      case "legacy-global":
        return "global settings moved to opencode.json[c] — migrate"
      case "global-unreadable":
        return "global OpenCode config unreadable"
      case "bless-unreadable":
        return "project-config trust record unreadable"
      case "worktree-unreadable":
        return "project opencode config unreadable"
      case "worktree-unblessed":
        return "project opencode config needs review"
      case "project-unreadable":
        return "settings unreadable"
    }
  }
  /** Raw field-wise merge of every healthy layer — what the pickers show as
   *  the current pin; {} while faulted (nothing may render as known-good). */
  const pinned = () => policy()?.settings ?? {}
  const merged = () => resolveSettings(pinned())

  // The model's catalog entry in this instance, with its variant ids
  // (OpenCode's effort levels); undefined when the instance does not have the
  // model at all.
  const modelInfo = (ref: string): { variants: string[] } | undefined => {
    const parsed = parseModelRef(ref)
    if (!parsed) return undefined
    for (const provider of api.state.provider) {
      const providerAny = provider as {
        id?: string
        models?: Record<string, { variants?: Record<string, unknown> }>
      }
      if (providerAny.id !== parsed.providerID) continue
      const model = providerAny.models?.[parsed.modelID]
      if (!model) return undefined
      const variants = model.variants
      return {
        variants:
          variants && typeof variants === "object" ? Object.keys(variants) : [],
      }
    }
    return undefined
  }

  // What the server beacon says stands between the settings saying "on" and
  // anything actually being approved; undefined when the server is ready.
  const serverIssue = () => {
    const beacon = serverStatus()
    if (beacon?.state === "paused")
      return beacon.reason ?? "an instance-wide fault"
    if (!beacon && beaconGraceOver()) return "the server half is not running"
    return undefined
  }

  const doToggle = async () => {
    if (disposed) return
    // Never act on default-initialized signals — a fast keypress right
    // after startup waits the path adoption and first disk read out instead,
    // and one that beats the host's path sync names the boot race rather
    // than blaming path safety.
    const gate = await gatePaths()
    if (gate.state === "syncing") {
      toast("warning", gate.message)
      return
    }
    if (gate.state === "unshared") return
    if (gate.state !== "ready") {
      toast(
        "warning",
        "Approve for Me controls are unavailable: settings path unsafe. Server state is unknown.",
      )
      return
    }
    const paused = pauseReason()
    if (paused) {
      toast(
        "warning",
        `Approve for Me remains paused: ${paused ?? "settings path unsafe"}.`,
      )
      return
    }
    const routedSessionID = routeSessionID(api)
    const routedRootID = routedSessionID
      ? rootSessionID(routedSessionID)
      : undefined
    if (routedRootID) await refreshSessionModel(routedRootID)
    if (!localityCurrent(gate.epoch, true)) return
    const current = await reloadOverride(gate.trusted)
    if (!localityCurrent(gate.epoch, true)) return
    if (
      disposed ||
      instanceUnavailable() ||
      settledPaths()?.trusted !== gate.trusted ||
      pauseReason()
    )
      return
    // Refresh before choosing a target; this is not a cross-TUI lock. The
    // post-write check detects competing writes without overwriting them.
    const next = !(current?.enabled ?? merged().enabled)
    const at = Date.now()
    try {
      // The timestamp lets the server half prove a toggle-off happened while
      // an unattended-deny deadline was pending, even after a re-enable.
      await writeOverride(gate.trusted.overridePath, {
        enabled: next,
        at,
      })
    } catch (error) {
      toast(
        "error",
        `Could not write the toggle state: ${error instanceof Error ? error.message : String(error)}.`,
      )
      return
    }
    if (!localityCurrent(gate.epoch, true)) return
    const liveOwner = await requestInstanceID(api)
    if (disposed) return
    if (
      instanceUnavailable() ||
      liveOwner !== gate.instanceID ||
      instanceID !== gate.instanceID ||
      settledPaths()?.trusted !== gate.trusted
    ) {
      await adoptPaths()
      toast(
        "warning",
        "Server instance changed or disconnected; toggle again after it reconnects.",
      )
      return
    }
    // Another attached TUI may have toggled while discovery was in flight.
    // Never replace its newer observed state with this operation's old target.
    if (!localityCurrent(gate.epoch, true)) return
    const confirmed = await reloadOverride(gate.trusted)
    if (!localityCurrent(gate.epoch, true)) return
    if (
      disposed ||
      instanceUnavailable() ||
      settledPaths()?.trusted !== gate.trusted
    )
      return
    if (confirmed?.enabled !== next || confirmed?.at !== at) {
      toast(
        "warning",
        "Toggle state changed while saving; check the current instance state before toggling again.",
      )
      return
    }
    if (next) {
      // "ON" must not overpromise: if the server half cannot actually
      // approve anything right now, the toggle toast says so too.
      const sessionModel = effectiveModel(routedRootID, !!routedSessionID)
      const blocked =
        (sessionModel.ancestryUnresolved
          ? SESSION_DETAILS_SYNCING_REASON
          : sessionModel.loading
            ? SESSION_DETAILS_SYNCING_REASON
            : sessionModel.invalid
              ? "session model record unreadable or invalid"
              : undefined) ??
        judgePause(sessionModel) ??
        serverIssue()
      if (blocked) {
        toast(
          "warning",
          `Approve for Me is ON for this instance, but paused: ${blocked}.`,
        )
      } else {
        toast(
          "success",
          `Approve for Me is ON for this instance (classifier: ${modelLabel(sessionModel)}).`,
        )
      }
    } else {
      toast(
        "info",
        "Approve for Me is OFF for this instance — prompts will wait for you.",
      )
    }
  }
  // Presses in this TUI are serialized, each recomputing its target after the
  // previous one landed. Other attached TUIs can still write concurrently.
  let lastToggle: Promise<void> = Promise.resolve()
  const toggle = () => {
    const chained = lastToggle.then(doToggle)
    // doToggle reports its own failures; the chain itself must stay usable.
    lastToggle = chained.catch(() => {})
    return chained
  }

  // One select dialog, promise-style like persist-permissions' promptEdit:
  // resolves the chosen value, or undefined when dismissed. The host dialog
  // does not close itself on select; the caller replaces or clears it.
  const promptSelect = <Value,>(
    title: string,
    choices: {
      title: string
      value: Value
      description?: string
      category?: string
    }[],
    current?: Value,
  ): Promise<Value | undefined> =>
    new Promise((resolve) => {
      let settled = false
      const done = (result: Value | undefined) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      api.ui.dialog.replace(
        () =>
          api.ui.DialogSelect({
            title,
            options: choices,
            current,
            onSelect: (option) => done(option.value as Value),
          }),
        () => done(undefined),
      )
    })

  const promptScope = (what: string): Promise<Scope | undefined> =>
    promptSelect<Scope>(`Save ${what} where?`, [
      {
        title: "This project",
        value: "project",
        description:
          "Trusted project-keyed file in the OpenCode config directory",
      },
      {
        title: "Global (all projects)",
        value: "global",
        description:
          "This plugin's entry options in your global opencode.json[c]",
      },
    ])

  const promptModelScope = (): Promise<ModelScope | undefined> =>
    promptSelect<ModelScope>("Set classifier model where?", [
      {
        title: "This session",
        value: "session",
        description: "Trusted per-root-session model choice",
      },
      {
        title: "This project",
        value: "project",
        description:
          "Trusted project-keyed file in the OpenCode config directory",
      },
      {
        title: "Global (all projects)",
        value: "global",
        description:
          "This plugin's entry options in your global opencode.json[c]",
      },
    ])

  const saveSetting = async (
    scope: Scope,
    patch: Record<string, unknown>,
  ): Promise<boolean> => {
    const settled = settledPaths()
    if (!settled) {
      // Unreachable through the pickers (they gate on the sync first), but a
      // save must still never blame path safety for the boot race.
      toast("error", `Not saved: ${PATHS_SYNCING_MESSAGE}`)
      return false
    }
    const trusted = settled.trusted
    if (!trusted) {
      toast(
        "error",
        "Not saved: the derived OpenCode config/state paths are not trusted paths outside this project.",
      )
      return false
    }
    // A picker may have stayed open across a reconnect or mount change.
    if (!(await verifyLocality(trusted, true))) return false
    const epoch = localityEpoch
    if (scope === "project") {
      const legacyFile = legacyProjectSettingsFile(trusted.projectRoot)
      const [legacyExists, trustedProjectExists, preSlugExists] =
        await Promise.all([
          pathExists(legacyFile),
          pathExists(trusted.projectSettingsFile),
          pathExists(trusted.preSlugProjectSettingsPath),
        ])
      if (
        legacyExists === undefined ||
        trustedProjectExists === undefined ||
        preSlugExists === undefined
      ) {
        toast("error", "Not saved: a project settings path is unreadable.")
        return false
      }
      if (legacyExists && !trustedProjectExists) {
        toast(
          "error",
          `Not saved: review and migrate ${legacyFile} in full to ${trusted.projectSettingsFile} before changing project settings.`,
        )
        return false
      }
      if (preSlugExists) {
        toast(
          "error",
          `Not saved: a pre-upgrade settings file remains at ${trusted.preSlugProjectSettingsPath}. Merge it into ${trusted.projectSettingsFile} (or delete it) first.`,
        )
        return false
      }
    }
    if (scope === "global") {
      // Global settings live on this plugin's entry in the global
      // opencode.json[c]; the edit is surgical (jsonc-parser) so the user's
      // comments and formatting survive.
      let result:
        | "ok"
        | "corrupt"
        | "no-entry"
        | "shadowed"
        | "unsafe"
        | "conflict"
      try {
        if (!localityCurrent(epoch, true)) return false
        result = await patchGlobalEntryOptions(
          trusted.configDir,
          packageDir,
          trusted.projectRoot,
          patch,
        )
      } catch (error) {
        toast(
          "error",
          `Not saved: could not update the global opencode config (${error instanceof Error ? error.message : String(error)}).`,
        )
        return false
      }
      if (result === "corrupt") {
        toast(
          "error",
          "Not saved: a global opencode.json[c] (or this plugin's entry in it) is unreadable or mistyped.",
        )
        return false
      }
      if (result === "unsafe") {
        toast(
          "error",
          "Not saved: a global opencode.json[c] resolves outside the OpenCode config directory (or into this project) — a symlinked candidate cannot be trusted as global policy.",
        )
        return false
      }
      if (result === "shadowed") {
        toast(
          "error",
          'Not saved: this plugin\'s global entry is shadowed — a later global config file defines its own "plugin" array, which replaces the earlier one wholly. Move the entry into the last file that defines "plugin".',
        )
        return false
      }
      if (result === "no-entry") {
        toast(
          "error",
          'Not saved: no global opencode.json[c] declares this plugin — add its entry under "plugin" first.',
        )
        return false
      }
      if (result === "conflict") {
        toast(
          "error",
          "Not saved: the global OpenCode config kept changing while it was being updated. Review the concurrent edit and try again.",
        )
        return false
      }
      if (!localityCurrent(epoch, true)) return false
      await reloadSettings(trusted)
      return localityCurrent(epoch, true)
    }
    const file = trusted.projectSettingsFile
    let result: "ok" | "corrupt"
    try {
      if (!localityCurrent(epoch, true)) return false
      result = await patchSettingsFile(file, patch)
    } catch (error) {
      toast(
        "error",
        `Not saved: could not write ${file} (${error instanceof Error ? error.message : String(error)}).`,
      )
      return false
    }
    if (result === "corrupt") {
      toast("error", `Not saved: ${file} is unreadable JSON.`)
      return false
    }
    if (!localityCurrent(epoch, true)) return false
    await reloadSettings(trusted)
    return localityCurrent(epoch, true)
  }

  let dialogFlow = false

  // The variant ids the picked model defines (OpenCode's effort levels),
  // straight from the host's provider state; [] when there are none.
  const variantsOf = (ref: string): string[] => modelInfo(ref)?.variants ?? []

  const chooseModel = async () => {
    if (disposed || dialogFlow) return
    dialogFlow = true
    try {
      // Capture the route once. A dialog can outlive navigation, but a session
      // model selection must never silently land on whichever session is open
      // when the final button is pressed. Persistent scopes do not require a
      // routed session at all.
      const flowSessionID = routeSessionID(api)
      const requireKnownFlowRoot = (sessionID: string) => {
        const rootID = rootSessionID(sessionID)
        if (!rootID) {
          toast(
            "warning",
            "Session details are still syncing or unavailable — try again in a moment.",
          )
          return false
        }
        if (rootID !== flowSessionID) {
          toast(
            "warning",
            "Open the parent session before choosing a classifier model.",
          )
          return false
        }
        return true
      }
      // The picker highlights the current pin; don't read it off
      // default-initialized signals right after startup — and don't open at
      // all while the host's path sync is still pending (unsafe paths flow
      // through: saveSetting names them when the pick lands).
      const gate = await gatePaths()
      if (gate.state === "syncing") {
        toast("warning", gate.message)
        return
      }
      if (gate.state === "unshared") return
      if (gate.state !== "ready") {
        toast(
          "error",
          "Not saved: the derived OpenCode config/state paths are not trusted paths outside this project.",
        )
        return
      }
      const scope = await promptModelScope()
      if (!scope) return
      if (!(await verifyLocality(gate.trusted, true))) return
      const scopeEpoch = localityEpoch
      let sessionID: string | undefined
      if (scope === "session") {
        if (!flowSessionID) {
          toast(
            "warning",
            "Open a top-level session before choosing a classifier model.",
          )
          return
        }
        sessionID = flowSessionID
        if (!requireKnownFlowRoot(sessionID)) return
      }
      const trustedSessionFile = () =>
        sessionID && rootSessionID(sessionID) === sessionID
          ? resolveTrustedSessionModelFile(
              gate.trusted.sessionModelsDir,
              sessionID,
            )
          : Promise.resolve(undefined)
      let sessionRecord: SessionModelReadResult | undefined
      if (scope === "session" && sessionID) {
        sessionRecord = await readTrustedSessionModel(
          gate.trusted.sessionModelsDir,
          sessionID,
        )
        if (!localityCurrent(scopeEpoch, true)) return
        if (!requireKnownFlowRoot(sessionID)) return
      }
      const models: {
        title: string
        value: string | null | typeof PROJECT_OR_GLOBAL_MODEL
        description?: string
        category?: string
      }[] = []
      if (scope === "session")
        models.push({
          title: "Use project/global setting",
          value: PROJECT_OR_GLOBAL_MODEL,
          description: "Clear this session's model override",
        })
      models.push({
        title: "Session model (default)",
        value: SESSION_MODEL,
        description: "Judge with whatever model the asking session is using",
      })
      for (const provider of api.state.provider) {
        const providerAny = provider as {
          id?: string
          name?: string
          models?: Record<string, { name?: string }>
        }
        if (!providerAny.id || !providerAny.models) continue
        for (const [modelID, model] of Object.entries(providerAny.models)) {
          const ref = formatModelRef({ providerID: providerAny.id, modelID })
          models.push({
            title: model?.name || modelID,
            value: ref,
            description: ref,
            category: providerAny.name || providerAny.id,
          })
        }
      }

      const current =
        scope === "session"
          ? sessionRecord?.status === "missing"
            ? PROJECT_OR_GLOBAL_MODEL
            : sessionRecord?.status === "valid" &&
                sessionRecord.record.mode === "override"
              ? sessionRecord.record.model
              : sessionRecord?.status === "valid"
                ? PROJECT_OR_GLOBAL_MODEL
                : undefined
          : (merged().model ?? SESSION_MODEL)
      const choice = await promptSelect(
        "Approve for Me classifier model",
        models,
        current,
      )
      if (choice === undefined) return
      if (
        choice !== PROJECT_OR_GLOBAL_MODEL &&
        typeof choice === "string" &&
        !parseModelRef(choice)
      ) {
        toast(
          "error",
          `Not saved: "${choice}" is not a provider/model reference.`,
        )
        return
      }

      // Effort step, only when the picked model defines variants. Everything
      // else clears a leftover variant pin rather than carrying it onto a
      // model that may not define it (the server half would pause then).
      const selectedModel = typeof choice === "string" ? choice : null
      const variants = selectedModel ? variantsOf(selectedModel) : []
      let variant: string | null = null
      if (variants.length) {
        const picked = await promptSelect<string | null>(
          "Classifier effort (model variant)",
          [
            {
              title: "Model default",
              value: null,
              description: "Judge at the model's default effort",
            },
            ...variants.map((id) => ({
              title: id,
              value: id,
              description: `${selectedModel} · ${id}`,
            })),
          ],
          scope === "session" &&
            sessionRecord?.status === "valid" &&
            sessionRecord.record.mode === "override" &&
            sessionRecord.record.model === selectedModel
            ? sessionRecord.record.variant
            : scope === "session"
              ? null
              : (merged().variant ?? null),
        )
        if (picked === undefined) return
        variant = picked
      }

      if (scope === "session" && sessionID) {
        if (!(await verifyLocality(gate.trusted, true))) return
        const epoch = localityEpoch
        if (!requireKnownFlowRoot(sessionID)) return
        try {
          const inherits = choice === PROJECT_OR_GLOBAL_MODEL
          const unchanged =
            (inherits && sessionRecord?.status === "missing") ||
            (sessionRecord?.status === "valid" &&
              !inherits &&
              sessionRecord.record.mode === "override" &&
              sessionRecord.record.model === selectedModel &&
              sessionRecord.record.variant === variant)
          if (unchanged) {
            toast(
              "success",
              inherits
                ? "Classifier for this session follows the project/global setting."
                : choice === SESSION_MODEL
                  ? "Classifier for this session uses the session model."
                  : `Classifier model for this session: ${selectedModel}${variant ? ` · ${variant}` : ""}.`,
            )
            return
          }
          const record: SessionModelRecord = {
            version: 1,
            rootSessionID: sessionID,
            revision: randomUUID(),
            mode: "override",
            model: selectedModel,
            variant,
          }
          if (!requireKnownFlowRoot(sessionID)) return
          if (inherits) {
            if (sessionRecord?.status === "valid") {
              const cleared = await clearTrustedSessionModelIfUnchanged(
                gate.trusted.sessionModelsDir,
                sessionRecord.record,
              )
              if (!cleared)
                throw new Error("the session model changed while clearing it")
            } else if (sessionRecord?.status === "invalid") {
              throw new Error(
                "the session model record is unreadable or invalid",
              )
            }
          } else {
            const file = await trustedSessionFile()
            if (!localityCurrent(epoch, true)) return
            if (!requireKnownFlowRoot(sessionID)) return
            if (!file) throw new Error("the session model path is not trusted")
            await writeSessionModel(file, record)
          }
          if (!localityCurrent(epoch, true)) return
          await refreshSessionModel(sessionID)
          if (!localityCurrent(epoch, true)) return
        } catch (error) {
          const detail = isLockBusyError(error)
            ? "the session model is temporarily busy; try again"
            : error instanceof Error
              ? error.message
              : String(error)
          toast("error", `Could not update the session model: ${detail}.`)
          return
        }
        toast(
          "success",
          choice === PROJECT_OR_GLOBAL_MODEL
            ? "Classifier for this session follows the project/global setting."
            : choice === SESSION_MODEL
              ? "Classifier for this session uses the session model."
              : `Classifier model for this session: ${selectedModel}${variant ? ` · ${variant}` : ""}.`,
        )
        return
      }
      if (scope === "session") return
      const patch: Record<string, unknown> = { model: selectedModel }
      if (variant !== null) patch.variant = variant
      else if (variants.length || merged().variant !== undefined) {
        // In the project file an explicit null overrides a global pin;
        // globally, deleting the key is the cleanest "no pin".
        patch.variant = scope === "project" ? null : undefined
      }
      if (!(await saveSetting(scope, patch))) return
      const where = scope === "project" ? "this project" : "all projects"
      toast(
        "success",
        choice === SESSION_MODEL
          ? `Classifier follows the session model for ${where}.`
          : `Classifier model for ${where}: ${selectedModel}${variant ? ` · ${variant}` : ""}.`,
      )
    } finally {
      dialogFlow = false
      api.ui.dialog.clear()
    }
  }

  // Preset classification budgets; all inside the server half's clamp range.
  const TIMEOUT_CHOICES_MS = [
    15_000, 30_000, 45_000, 60_000, 120_000, 180_000, 300_000, 600_000,
  ]
  const formatTimeout = (ms: number) =>
    ms % 60_000 === 0
      ? `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`
      : `${Math.round(ms / 1000)} seconds`

  const chooseTimeout = async () => {
    if (disposed || dialogFlow) return
    dialogFlow = true
    try {
      const gate = await gatePaths()
      if (gate.state === "syncing") {
        toast("warning", gate.message)
        return
      }
      if (gate.state === "unshared") return
      // Highlight what the sources actually pin — resolveSettings() fills
      // the default in, and an unset budget must not render as an explicit
      // pin.
      const current = pinned().timeoutMs ?? null
      const choice = await promptSelect<number | null>(
        "Approve for Me classifier timeout",
        [
          {
            title: `Default (${formatTimeout(DEFAULT_TIMEOUT_MS)})`,
            value: null,
            description:
              "How long one classification may run before the prompt surfaces",
          },
          ...TIMEOUT_CHOICES_MS.map((ms) => ({
            title: formatTimeout(ms),
            value: ms as number | null,
            description: `timeoutMs: ${ms}`,
          })),
        ],
        current,
      )
      if (choice === undefined) return
      const scope = await promptScope("the classifier timeout")
      if (!scope) return
      // In the project file an explicit null overrides a global pin;
      // globally, deleting the key is the cleanest "no pin" (same shape as
      // the model picker's variant step).
      const patch = {
        timeoutMs: choice ?? (scope === "project" ? null : undefined),
      }
      if (!(await saveSetting(scope, patch))) return
      const where = scope === "project" ? "this project" : "all projects"
      toast(
        "success",
        choice === null
          ? `Classifier timeout follows the default (${formatTimeout(DEFAULT_TIMEOUT_MS)}) for ${where}.`
          : `Classifier timeout for ${where}: ${formatTimeout(choice)}.`,
      )
    } finally {
      dialogFlow = false
      api.ui.dialog.clear()
    }
  }

  const chooseDefault = async () => {
    if (disposed || dialogFlow) return
    dialogFlow = true
    try {
      const gate = await gatePaths()
      if (gate.state === "syncing") {
        toast("warning", gate.message)
        return
      }
      if (gate.state === "unshared") return
      const choice = await promptSelect<boolean>(
        "Approve for Me persistent default",
        [
          {
            title: "Enabled",
            value: true,
            description: "Classify and auto-approve safe requests",
          },
          {
            title: "Disabled",
            value: false,
            description: "Never auto-approve; every prompt waits for you",
          },
        ],
        merged().enabled,
      )
      if (choice === undefined) return
      const scope = await promptScope("the Approve for Me default")
      if (!scope) return
      if (!(await saveSetting(scope, { enabled: choice }))) return
      const where = scope === "project" ? "this project" : "all projects"
      toast(
        "success",
        `Approve for Me default for ${where}: ${choice ? "enabled" : "disabled"}.`,
      )
      if (override() !== undefined && override()?.enabled !== choice) {
        toast(
          "info",
          "The instance toggle still overrides it until this OpenCode exits — toggle to match.",
        )
      }
    } finally {
      dialogFlow = false
      api.ui.dialog.clear()
    }
  }

  // The worktree-config blessing: reviewing and approving the exact bytes of
  // every project-local OpenCode config file that names plugins, plus any
  // sideloaded .opencode/plugin source. User-only surface by construction —
  // the agent cannot invoke palette commands, and the record lives in the
  // trusted state directory outside the worktree.
  const trustProject = async () => {
    if (disposed || dialogFlow) return
    dialogFlow = true
    try {
      const gate = await gatePaths()
      if (gate.state === "syncing") {
        toast("warning", gate.message)
        return
      }
      if (gate.state === "unshared") return
      if (gate.state !== "ready") {
        toast(
          "error",
          "Cannot trust project config: the derived OpenCode config/state paths are not trusted paths outside this project.",
        )
        return
      }
      if (projectConfigDisabled()) {
        toast(
          "info",
          "Project config is disabled (OPENCODE_DISABLE_PROJECT_CONFIG): the host loads no project plugin config, so there is nothing to trust or revoke.",
        )
        return
      }
      const [scan, sources] = await Promise.all([
        scanWorktreeConfig(api.state.path.directory, configRoot(), packageDir),
        scanSideloadSources(api.state.path.directory, configRoot()),
      ])
      if (!localityCurrent(gate.epoch, true)) return
      if (scan.unreadable.length) {
        toast(
          "error",
          `Cannot trust project config: unreadable or mistyped file(s): ${scan.unreadable.join(", ")}. Fix or remove them first.`,
        )
        return
      }
      const unreadableSource = sources.find(
        (source) => source.hash === "unreadable",
      )
      if (unreadableSource) {
        toast(
          "error",
          `Cannot trust project config: ${unreadableSource.file} is unreadable.`,
        )
        return
      }
      const gated = [
        ...scan.files
          .filter((file) => file.hasOwnEntry || file.pluginSpecs.length)
          .map((file) => ({
            file: file.file,
            hash: file.hash,
            what: file.hasOwnEntry
              ? `sets ${
                  Object.keys(parseSettings(file.ownOptions ?? {}) ?? {}).join(
                    ", ",
                  ) || "no options"
                }`
              : "declares plugin entries",
          })),
        ...sources.map((source) => ({
          file: source.file,
          hash: source.hash,
          what: "sideloaded plugin source the host loads at startup",
        })),
      ]
      if (!gated.length) {
        // A non-empty record with nothing left on disk is the file-removal
        // pause: the user must still be able to approve the REMOVAL, which
        // is what writing the now-empty record does.
        const existing = await readBlessing(gate.trusted.blessPath)
        if (!localityCurrent(gate.epoch, true)) return
        if (!existing || !Object.keys(existing.files).length) {
          toast(
            "info",
            "No project-local OpenCode config or plugin sources found to review.",
          )
          return
        }
      }
      const summary = gated
        .map(
          (item) =>
            `${path.relative(root(), item.file) || item.file} — ${item.what}`,
        )
        .join("; ")
      const choice = await promptSelect<"trust" | "revoke">(
        "Trust project plugin config for Approve for Me?",
        [
          {
            title: `Trust current contents (${gated.length} file${gated.length === 1 ? "" : "s"})`,
            value: "trust",
            description: gated.length
              ? `Review these files first — ${summary}`
              : "Previously trusted files were removed; trusting approves the removal",
          },
          {
            title: "Revoke trust",
            value: "revoke",
            description:
              "Forget every approved file; worktree config pauses until re-trusted",
          },
        ],
      )
      if (choice === undefined) return
      if (!(await verifyLocality(gate.trusted, true))) return
      const epoch = localityEpoch
      const files: Record<string, string> = {}
      if (choice === "trust")
        for (const item of gated) files[item.file] = item.hash
      try {
        await writeBlessing(gate.trusted.blessPath, {
          files,
          // Which of these files SUPPLY Approve for Me policy right now:
          // the server pauses when one of them later disappears or stops
          // naming the plugin, instead of widening to global/defaults.
          policy:
            choice === "trust"
              ? scan.files
                  .filter((file) => file.hasOwnEntry)
                  .map((file) => file.file)
              : [],
          at: Date.now(),
        })
      } catch (error) {
        toast(
          "error",
          `Could not write the trust record: ${error instanceof Error ? error.message : String(error)}.`,
        )
        return
      }
      if (!localityCurrent(epoch, true)) return
      await reloadSettings(gate.trusted)
      if (!localityCurrent(epoch, true)) return
      toast(
        choice === "trust" ? "success" : "info",
        choice === "trust"
          ? `Trusted ${gated.length} project file${gated.length === 1 ? "" : "s"} for Approve for Me. Any edit to them pauses auto-approval until re-trusted.`
          : "Project plugin config trust revoked — worktree config is ignored (and pauses Approve for Me if it names this plugin) until trusted again.",
      )
    } finally {
      dialogFlow = false
      api.ui.dialog.clear()
    }
  }

  // The palette renders every binding registered under a command's name in a
  // hint column that never shrinks (flexShrink 0 in the host's DialogSelect),
  // so a multi-alternative hint clips the command title. Only the first
  // alternative is registered against the command name — and therefore shown;
  // the rest run the same handler through a function-cmd binding, which
  // getCommandBindings cannot associate with the command (verified against
  // the 1.17.18 palette source). Both stay fully functional.
  const [shownKey, ...quietKeys] = keybind
    ? keybind
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean)
    : []
  const toggleDesc = "Toggle Approve for Me (this instance)"

  api.keymap.registerLayer({
    commands: [
      {
        name: TOGGLE_COMMAND,
        title: "Approve for Me: toggle for this instance",
        category: "Permission",
        namespace: "palette",
        run: toggle,
      },
      {
        name: MODEL_COMMAND,
        title: "Approve for Me: choose classifier model",
        category: "Permission",
        namespace: "palette",
        run: chooseModel,
      },
      {
        name: TIMEOUT_COMMAND,
        title: "Approve for Me: set classifier timeout",
        category: "Permission",
        namespace: "palette",
        run: chooseTimeout,
      },
      {
        name: DEFAULT_COMMAND,
        title: "Approve for Me: set persistent default",
        category: "Permission",
        namespace: "palette",
        run: chooseDefault,
      },
      {
        name: TRUST_COMMAND,
        title: "Approve for Me: trust project plugin config",
        category: "Permission",
        namespace: "palette",
        run: trustProject,
      },
    ],
    bindings: [
      ...(shownKey
        ? [
            {
              key: shownKey,
              cmd: TOGGLE_COMMAND,
              desc: toggleDesc,
              group: "Permission",
            },
          ]
        : []),
      ...(quietKeys.length
        ? [
            {
              key: quietKeys.join(","),
              cmd: () => {
                void toggle()
              },
              desc: toggleDesc,
              group: "Permission",
            },
          ]
        : []),
    ],
  })

  // The prompt lifecycle behind the activity stream, learned from the host's
  // own events. Pending items are read live from the host's permission state
  // at render; the two subscriptions only cover what that state cannot say —
  // which child sessions have prompted (so sub-agent prompts appear under the
  // viewed session, like the host prompt itself aggregates them) and what a
  // request looked like once it is answered and gone from that state.
  type SettledItem = {
    id: string
    sessionID: string
    permission: string
    patterns: string[]
    reply: "once" | "always" | "reject"
  }
  const SETTLED_LINGER_MS = 5_000
  const SETTLED_KEPT = 10
  const [promptSessions, setPromptSessions] = createSignal<readonly string[]>(
    [],
  )
  const [settled, setSettled] = createSignal<readonly SettledItem[]>([])
  // Coarse clock behind the deny countdowns: 30 s granularity is plenty for
  // a minutes-scale deadline, and the signal re-renders the stream between
  // file events.
  const DENY_ETA_TICK_MS = 30_000
  const [now, setNow] = createSignal(Date.now())
  if (feed) {
    const denyEtaTicker = setInterval(
      () => setNow(Date.now()),
      DENY_ETA_TICK_MS,
    )
    api.lifecycle.onDispose(() => clearInterval(denyEtaTicker))
    const askedInfo = new Map<
      string,
      { permission: string; patterns: string[] }
    >()
    const settleTimers = new Set<ReturnType<typeof setTimeout>>()
    const unsubscribes = [
      api.event.on("permission.asked", (event) => {
        const { id, sessionID, permission, patterns } = event.properties
        setPromptSessions((prev) => notePromptSession(prev, sessionID))
        askedInfo.set(id, { permission, patterns: [...patterns] })
        trim(askedInfo)
      }),
      api.event.on("permission.replied", (event) => {
        const { requestID, sessionID, reply } = event.properties
        // Answered prompts leave the host state, so the request details come
        // from the asked event; the state read is the fallback for prompts
        // asked before this TUI attached (and raced away replies just skip
        // the exit animation).
        const info =
          askedInfo.get(requestID) ??
          api.state.session
            .permission(sessionID)
            .find((request) => request.id === requestID)
        askedInfo.delete(requestID)
        if (!info) return
        const item: SettledItem = {
          id: requestID,
          sessionID,
          permission: info.permission,
          patterns: [...info.patterns],
          reply,
        }
        setSettled((prev) => [...prev.slice(1 - SETTLED_KEPT), item])
        const timer = setTimeout(() => {
          settleTimers.delete(timer)
          setSettled((prev) => prev.filter((entry) => entry !== item))
        }, SETTLED_LINGER_MS)
        settleTimers.add(timer)
      }),
    ]
    api.lifecycle.onDispose(() => {
      for (const unsubscribe of unsubscribes) unsubscribe()
      for (const timer of settleTimers) clearTimeout(timer)
      settleTimers.clear()
    })
  }

  // The trust posture, always visible while a session is open: whether a
  // model is approving on the user's behalf right now, and which one. Shaped
  // like the host's own sidebar sections — a bold header over a muted line,
  // with the blank line above supplied by the sidebar container's own gap.
  if (sidebar) {
    function SidebarView(props: { sessionID: string }) {
      // The sidebar has several reactive expressions for its text and colour.
      // Keep one reactive root resolution per slot so each expression consumes
      // the same authoritative ancestry result.
      const resolvedRootID = createSolidMemo(() =>
        rootSessionID(props.sessionID),
      )
      // Keep the visible slot's mirror live even when other sidebar slots push
      // the cache past its historical-entry limit. Cleanup makes a revisited
      // root eligible for LRU eviction again after this slot unmounts.
      createEffect(() => {
        const release = leaseSessionModelMirror(resolvedRootID())
        onCleanup(() => release?.())
      })
      const model = createSolidMemo(() =>
        effectiveModel(resolvedRootID(), true),
      )
      const localPause = () => {
        const current = model()
        if (current.ancestryUnresolved) return "session ancestry unavailable"
        if (current.invalid) return "session model record unreadable or invalid"
        return undefined
      }
      const statusLine = () => {
        if (sharedFilesystem() === false)
          return "controls unavailable · shared filesystem unverified; server state unknown"
        if (sharedFilesystem() === undefined && pauseReason())
          return `controls unavailable · ${pauseReason()}; server state unknown`
        if (sharedFilesystem() === undefined && !pauseReason())
          return "starting…"
        // The TUI-side judge pre-check outranks the beacon: a pinned model that
        // is gone shows up here immediately, before any request lets the server
        // half discover it.
        const current = model()
        const staticPause = judgePause(current)
        const policyPause = pauseReason()
        const local = localPause()
        const beacon = serverStatus()
        const server = !loaded()
          ? ("starting" as const)
          : local
            ? ("paused" as const)
            : staticPause
              ? ("paused" as const)
              : beacon
                ? beacon.state
                : current.loading
                  ? ("starting" as const)
                  : beaconGraceOver()
                    ? ("missing" as const)
                    : ("starting" as const)
        return statusLabel({
          pauseReason: policyPause ?? local,
          server,
          serverReason: staticPause ?? beacon?.reason,
          override: override()?.enabled,
          defaultEnabled: merged().enabled,
          model: modelLabel(current),
        })
      }
      // Muted like the content under the host's own Context and LSP headers,
      // so the bold header carries the emphasis. Paused is the one exception:
      // any fault the status line reports is worth flagging in warning colour
      // (but "off" stays muted even when the server also has a fault — off is
      // what the user chose, and it is the line being shown).
      const statusColor = () => {
        const theme = api.theme.current
        if (sharedFilesystem() === false) return theme.warning
        if (pauseReason()) return theme.warning
        if (!loaded()) return theme.textMuted
        const current = model()
        if (current.ancestryUnresolved || current.invalid) return theme.warning
        const enabled = override()?.enabled ?? merged().enabled
        return enabled && (judgePause(current) || serverIssue())
          ? theme.warning
          : theme.textMuted
      }
      return (
        <box flexDirection="column" flexShrink={0}>
          <text>
            <b>{SIDEBAR_HEADER}</b>
          </text>
          <text fg={statusColor()}>{statusLine()}</text>
          {feedLines(props.sessionID)}
        </box>
      )
    }
    const feedTone = (tone: FeedTone) => {
      const theme = api.theme.current
      if (tone === "info") return theme.info
      if (tone === "warning") return theme.warning
      if (tone === "success") return theme.success
      return theme.textMuted
    }
    // The stream under the status line, scoped to the session whose sidebar
    // this is: its own prompts plus those of its sub-agent child sessions,
    // which the host prompt aggregates into the same view. Reads reactive
    // sources throughout (host permission state, the activity file mirror,
    // the settled list), so lines appear, re-label, and fade on their own.
    const feedLines = (sessionID: string): JSX.Element[] | undefined => {
      if (!feed) return undefined
      const ids = promptSessionFamily(api, sessionID, promptSessions())
      const { lines, hiddenPending } = feedItems({
        pending: ids.flatMap((id) => api.state.session.permission(id)),
        settled: settled().filter((item) => ids.includes(item.sessionID)),
        activity: sharedFilesystem() ? activity() : {},
        now: now(),
      })
      const rendered: JSX.Element[] = []
      for (const line of lines) {
        rendered.push(
          <text fg={feedTone(line.tone)}>{`${line.marker} ${line.text}`}</text>,
        )
        // Padding, not a two-space string prefix, so a reason longer than
        // the column wraps with its continuation lines still indented under
        // the first — the full explanation reads as one block.
        if (line.reason)
          rendered.push(
            <box paddingLeft={2}>
              <text fg={api.theme.current.textMuted} wrapMode="word">
                {line.reason}
              </text>
            </box>,
          )
      }
      if (hiddenPending > 0) {
        rendered.push(
          <text
            fg={api.theme.current.textMuted}
          >{`+${hiddenPending} more waiting`}</text>,
        )
      }
      return rendered
    }
    api.slots.register({
      order: 320,
      slots: {
        sidebar_content: (_context, slot) => (
          <SidebarView sessionID={slot.session_id} />
        ),
      },
    })
  }
}

const plugin: TuiPluginModule = {
  id: "opencode-approve-for-me",
  tui,
}

export default plugin

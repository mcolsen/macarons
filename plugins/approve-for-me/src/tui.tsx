import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import {
  openCodeDataDir,
  patchSettingsFile,
  pathExists,
  verifyFilesystemLocality,
} from "@macarons/permission-rules"
import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { type ApprovalSnapshot, rpcDefinition } from "./rpc"
import {
  ACTIVITY_REASON_MAX,
  type Activity,
  clearTrustedSessionModelIfUnchanged,
  DEFAULT_TIMEOUT_MS,
  JEV_MODEL_REF,
  legacyProjectSettingsFile,
  ownPackageDir,
  patchGlobalEntryOptions,
  readTrustedSessionModel,
  resolveTrustedSessionModelFile,
  resolveTrustedSettingsPaths,
  scanSideloadSources,
  scanWorktreeConfig,
  settingsLocalityPaths,
  TRUNCATE_SUFFIX,
  writeBlessing,
  writeOverride,
  writeSessionModel,
} from "./shared"

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

const COMMAND = "permissions_approve_for_me"
type Scope = "session" | "project" | "global"
const SAME_PATHS = [
  "projectRoot",
  "configDir",
  "stateDir",
  "sessionModelsDir",
  "globalSettingsFile",
  "projectSettingsFile",
  "overridePath",
  "activityPath",
  "journalPath",
  "blessPath",
  "preSlugProjectSettingsPath",
  "preSlugJournalPath",
] as const

export const tui = Plugin.define({
  id: "macarons.approve-for-me",
  async setup(ctx) {
    const lifecycle = new AbortController()
    const api = ctx.client.rpc(rpcDefinition)
    const packageDir = await ownPackageDir()
    const [snapshot, setSnapshot] = createSignal<ApprovalSnapshot>()
    const [unavailable, setUnavailable] = createSignal(false)
    const [settled, setSettled] = createSignal<
      Array<FeedSettled & { sessionID: string; time: number }>
    >([])
    const [now, setNow] = createSignal(Date.now())
    const location = () => {
      const route = ctx.ui.router.current()
      return route.type === "session"
        ? (ctx.data.session.get(route.sessionID)?.location ??
            ctx.location ??
            ctx.data.location.default())
        : (ctx.location ?? ctx.data.location.default())
    }
    const locationKey = (value: ReturnType<typeof location>) =>
      JSON.stringify(value)
    let pendingRefresh: Promise<ApprovalSnapshot> | undefined
    let pendingKey: string | undefined
    const refresh = (target = location()) => {
      const key = locationKey(target)
      if (pendingRefresh && pendingKey === key) return pendingRefresh
      const promise = api
        .snapshot(
          {},
          {
            location: target,
            signal: AbortSignal.any([
              lifecycle.signal,
              AbortSignal.timeout(5_000),
            ]),
          },
        )
        .then((data) => {
          const next = data as ApprovalSnapshot
          if (!lifecycle.signal.aborted && key === locationKey(location())) {
            setSnapshot(next)
            setUnavailable(false)
          }
          return next
        })
        .catch((error) => {
          if (!lifecycle.signal.aborted && key === locationKey(location())) {
            setSnapshot(undefined)
            setUnavailable(true)
          }
          throw error
        })
        .finally(() => {
          if (pendingRefresh === promise) pendingRefresh = undefined
        })
      pendingKey = key
      pendingRefresh = promise
      return promise
    }
    const toast = (
      message: string,
      variant: "info" | "success" | "warning" | "error" = "info",
    ) => ctx.ui.toast.show({ title: "Approve for Me", message, variant })

    // The RPC never changes policy. Controls write only after proving that
    // server and TUI share every trusted directory in both directions.
    const gate = async (
      target: ReturnType<typeof location>,
      expected?: ApprovalSnapshot,
    ) => {
      const current = await refresh(target)
      if (
        expected &&
        (current.instanceID !== expected.instanceID ||
          current.directory !== expected.directory)
      )
        throw new Error(
          "The server changed while the control was open. Try again.",
        )
      if (!current.paths)
        throw new Error("The server has no trusted settings paths.")
      const paths = await resolveTrustedSettingsPaths(
        current.projectRoot,
        current.paths.configDir,
        current.paths.stateDir,
        openCodeDataDir(process.env, homedir()),
        current.instanceID,
        { migrate: false },
      )
      if (
        !paths ||
        SAME_PATHS.some((key) => paths[key] !== current.paths?.[key])
      )
        throw new Error("Settings paths are not trusted outside this project.")
      const roots = await settingsLocalityPaths(paths)
      if (
        !roots ||
        !(await verifyFilesystemLocality(
          {
            signal: lifecycle.signal,
            publish: (command: string, signal: AbortSignal) =>
              api.locality({ command }, { location: target, signal }),
          },
          {
            service: "permissions-approve-for-me",
            paths: roots,
            directory: current.directory,
          },
        ))
      )
        throw new Error(
          "Controls require a verified shared filesystem with the server. Remote viewing remains available.",
        )
      const latest = (await api.snapshot(
        {},
        {
          location: target,
          signal: AbortSignal.any([
            lifecycle.signal,
            AbortSignal.timeout(5_000),
          ]),
        },
      )) as ApprovalSnapshot
      if (
        latest.instanceID !== current.instanceID ||
        !latest.paths ||
        SAME_PATHS.some((key) => latest.paths?.[key] !== paths[key])
      )
        throw new Error("The server or its settings paths changed. Try again.")
      return { snapshot: latest, paths }
    }
    let busy = false
    const action = (operation: () => Promise<void>) => async () => {
      if (busy || lifecycle.signal.aborted) return
      busy = true
      try {
        await operation()
      } catch (error) {
        if (!lifecycle.signal.aborted)
          toast(
            error instanceof Error
              ? error.message
              : "The control could not complete.",
            "error",
          )
      } finally {
        busy = false
        if (!lifecycle.signal.aborted) void refresh().catch(() => {})
      }
    }
    const chooseScope = (session = false) =>
      ctx.ui.dialog.select<Scope>({
        title: "Save Approve for Me settings for",
        options: [
          ...(session
            ? [{ title: "This root session", value: "session" as const }]
            : []),
          { title: "This project", value: "project" },
          { title: "All projects", value: "global" },
        ],
      })
    const save = async (
      target: ReturnType<typeof location>,
      expected: ApprovalSnapshot,
      scope: Exclude<Scope, "session">,
      patch: Record<string, unknown>,
    ) => {
      const { paths } = await gate(target, expected)
      if (scope === "project") {
        const [legacy, current, old] = await Promise.all([
          pathExists(legacyProjectSettingsFile(paths.projectRoot)),
          pathExists(paths.projectSettingsFile),
          pathExists(paths.preSlugProjectSettingsPath),
        ])
        if (
          [legacy, current, old].includes(undefined) ||
          old ||
          (legacy && !current)
        )
          throw new Error(
            "Review and migrate the existing project settings before changing them.",
          )
      }
      const result =
        scope === "project"
          ? await patchSettingsFile(paths.projectSettingsFile, patch)
          : await patchGlobalEntryOptions(
              paths.configDir,
              packageDir,
              paths.projectRoot,
              patch,
            )
      if (result !== "ok")
        throw new Error(
          `Settings were not saved (${result}). Review the OpenCode configuration first.`,
        )
      toast("Settings saved.", "success")
    }

    const toggle = action(async () => {
      const target = location()
      const { snapshot, paths } = await gate(target)
      await writeOverride(paths.overridePath, {
        enabled: !snapshot.enabled,
        at: Date.now(),
      })
      toast(
        `Auto-approval ${snapshot.enabled ? "paused" : "enabled"} for this instance.`,
        "success",
      )
    })
    const model = action(async () => {
      const target = location()
      const start = await gate(target)
      const route = ctx.ui.router.current()
      const sessionID = route.type === "session" ? route.sessionID : undefined
      const scope = await chooseScope(!!sessionID)
      if (!scope) return
      if (
        scope === "session" &&
        (!sessionID ||
          !ctx.data.session.get(sessionID) ||
          ctx.data.session.root(sessionID) !== sessionID)
      )
        throw new Error(
          "Open the root session before choosing its classifier model.",
        )
      await ctx.data.location.model.sync(target)
      const models = ctx.data.location.model.list(target) ?? []
      const selected = await ctx.ui.dialog.select<string | null>({
        title: "Classifier model",
        options: [
          ...(scope === "session"
            ? [{ title: "Follow project/global setting", value: "inherit" }]
            : []),
          { title: "Use the session model", value: null },
          { title: "Jev permission classifier", value: JEV_MODEL_REF },
          ...models
            .filter((entry) => entry.enabled)
            .map((entry) => ({
              title: entry.name,
              value: `${entry.providerID}/${entry.id}`,
              description: `${entry.providerID}/${entry.id}`,
            })),
        ],
      })
      if (selected === undefined) return
      let variant: string | null = null
      const variants =
        models.find((entry) => `${entry.providerID}/${entry.id}` === selected)
          ?.variants ?? []
      if (variants.length) {
        const choice = await ctx.ui.dialog.select<string | null>({
          title: "Classifier effort",
          options: [
            { title: "Model default", value: null },
            ...variants.map((item) => ({ title: item.id, value: item.id })),
          ],
        })
        if (choice === undefined) return
        variant = choice
      }
      if (scope !== "session")
        return save(target, start.snapshot, scope, {
          model: selected,
          variant: variant ?? (scope === "project" ? null : undefined),
        })
      if (!sessionID) return
      const { paths } = await gate(target, start.snapshot)
      if (
        !ctx.data.session.get(sessionID) ||
        ctx.data.session.root(sessionID) !== sessionID
      )
        throw new Error("Session details changed while the picker was open.")
      const previous = await readTrustedSessionModel(
        paths.sessionModelsDir,
        sessionID,
      )
      if (previous.status === "invalid")
        throw new Error("The session classifier record is invalid.")
      if (selected === "inherit") {
        if (
          previous.status === "valid" &&
          !(await clearTrustedSessionModelIfUnchanged(
            paths.sessionModelsDir,
            previous.record,
          ))
        )
          throw new Error(
            "The session classifier changed concurrently. Try again.",
          )
      } else {
        const file = await resolveTrustedSessionModelFile(
          paths.sessionModelsDir,
          sessionID,
        )
        if (!file)
          throw new Error("The session classifier path is not trusted.")
        await writeSessionModel(file, {
          version: 1,
          rootSessionID: sessionID,
          revision: randomUUID(),
          mode: "override",
          model: selected,
          variant,
        })
      }
      toast("Session classifier saved.", "success")
    })
    const timeout = action(async () => {
      const target = location()
      const start = await gate(target)
      const choice = await ctx.ui.dialog.select<number | null>({
        title: "Classifier timeout",
        options: [
          {
            title: `Default (${DEFAULT_TIMEOUT_MS / 1000} seconds)`,
            value: null,
          },
          ...[30, 60, 120, 180, 300, 600].map((seconds) => ({
            title: `${seconds} seconds`,
            value: seconds * 1000,
          })),
        ],
      })
      if (choice === undefined) return
      const scope = await chooseScope()
      if (scope && scope !== "session")
        await save(target, start.snapshot, scope, {
          timeoutMs: choice ?? (scope === "project" ? null : undefined),
        })
    })
    const persistentDefault = action(async () => {
      const target = location()
      const start = await gate(target)
      const enabled = await ctx.ui.dialog.select<boolean>({
        title: "Persistent auto-approval default",
        options: [
          { title: "Enabled", value: true },
          { title: "Disabled", value: false },
        ],
      })
      if (enabled === undefined) return
      const scope = await chooseScope()
      if (scope && scope !== "session")
        await save(target, start.snapshot, scope, { enabled })
    })
    const trust = action(async () => {
      const target = location()
      const start = await gate(target)
      const scan = await scanWorktreeConfig(
        start.snapshot.directory,
        start.snapshot.configRoot,
        packageDir,
      )
      const sources = await scanSideloadSources(
        start.snapshot.directory,
        start.snapshot.configRoot,
      )
      if (
        scan.unreadable.length ||
        sources.some((source) => source.hash === "unreadable")
      )
        throw new Error(
          "Project config contains unreadable files. Fix them before trusting it.",
        )
      const files = [
        ...scan.files
          .filter((file) => file.hasOwnEntry || file.pluginSpecs.length)
          .map((file) => ({ file: file.file, hash: file.hash })),
        ...sources,
      ]
      const choice = await ctx.ui.dialog.select<"trust" | "revoke">({
        title: "Project plugin trust",
        options: [
          {
            title: "Review and trust current files",
            value: "trust",
            description: `${files.length} files; any later change pauses approval`,
          },
          { title: "Revoke trust", value: "revoke" },
        ],
      })
      if (!choice) return
      if (
        choice === "trust" &&
        !(await ctx.ui.dialog.confirm({
          title: "Trust these exact project plugin files?",
          message:
            files
              .map((file) => `${file.file}\nSHA-256 ${file.hash}`)
              .join("\n\n") ||
            "Previously trusted plugin files were removed. Approve their removal?",
        }))
      )
        return
      const { paths } = await gate(target, start.snapshot)
      await writeBlessing(paths.blessPath, {
        files:
          choice === "trust"
            ? Object.fromEntries(files.map((file) => [file.file, file.hash]))
            : {},
        policy:
          choice === "trust"
            ? scan.files
                .filter((file) => file.hasOwnEntry)
                .map((file) => file.file)
            : [],
        at: Date.now(),
      })
      toast(
        choice === "trust"
          ? "Exact file contents trusted; later edits pause approval."
          : "Project plugin trust revoked.",
        "success",
      )
    })

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: `${COMMAND}.toggle`,
          title: "Approve for Me: toggle for this instance",
          bind:
            ctx.options.keybind === false || ctx.options.keybind === "none"
              ? (false as const)
              : typeof ctx.options.keybind === "string"
                ? ctx.options.keybind
                : "<leader>d,ctrl+alt+a",
          run: toggle,
        },
        {
          id: `${COMMAND}.model`,
          title: "Approve for Me: choose classifier model",
          run: model,
        },
        {
          id: `${COMMAND}.timeout`,
          title: "Approve for Me: set classifier timeout",
          run: timeout,
        },
        {
          id: `${COMMAND}.default`,
          title: "Approve for Me: set persistent default",
          run: persistentDefault,
        },
        {
          id: `${COMMAND}.trust`,
          title: "Approve for Me: trust project plugin config",
          run: trust,
        },
      ].map((command) => ({
        ...command,
        group: "Permission",
        palette: true as const,
      })),
    }))

    const pendingByID = new Map<string, FeedRequest & { sessionID: string }>()
    const offAsked = ctx.data.on("permission.asked", (event) => {
      pendingByID.set(event.data.id, {
        id: event.data.id,
        sessionID: event.data.sessionID,
        permission: event.data.action,
        patterns: event.data.resources,
      })
      if (pendingByID.size > 1000)
        pendingByID.delete(pendingByID.keys().next().value as string)
      void refresh().catch(() => {})
    })
    const offReplied = ctx.data.on("permission.replied", (event) => {
      const request = pendingByID.get(event.data.requestID)
      pendingByID.delete(event.data.requestID)
      if (request)
        setSettled((items) =>
          [
            ...items,
            { ...request, reply: event.data.reply, time: Date.now() },
          ].slice(-10),
        )
      void refresh().catch(() => {})
    })
    const releaseSlot =
      ctx.options.sidebar === false
        ? undefined
        : ctx.ui.slot({
            append: "sidebar.content",
            render: ({ sessionID }) => {
              const rows = () => {
                const family = ctx.data.session.family(sessionID)
                const pending = family
                  .flatMap((id) => ctx.data.session.permission.list(id) ?? [])
                  .map((request) => ({
                    id: request.id,
                    permission: request.action,
                    patterns: request.resources,
                  }))
                return feedItems({
                  pending,
                  settled: settled().filter(
                    (entry) =>
                      family.includes(entry.sessionID) &&
                      now() - entry.time < 5_000,
                  ),
                  activity: snapshot()?.requests ?? {},
                  now: now(),
                })
              }
              return (
                <box flexDirection="column">
                  <text fg={ctx.theme.text.base}>
                    <b>Approve for Me</b>
                  </text>
                  <text
                    fg={
                      snapshot()?.enabled
                        ? ctx.theme.text.feedback.success.base
                        : ctx.theme.text.muted
                    }
                    wrapMode="word"
                  >
                    {statusLabel({
                      server:
                        snapshot()?.server?.state ??
                        (unavailable() ? "missing" : "starting"),
                      serverReason: snapshot()?.server?.reason,
                      defaultEnabled:
                        snapshot()?.server?.state === "paused" ||
                        snapshot()?.enabled === undefined
                          ? true
                          : (snapshot()?.enabled ?? false),
                      override: undefined,
                      model: snapshot()?.settings?.model ?? "session model",
                    })}
                  </text>
                  {ctx.options.feed !== false && (
                    <box flexDirection="column">
                      {rows().lines.map((line) => (
                        <box flexDirection="column">
                          <text
                            fg={
                              line.tone === "warning"
                                ? ctx.theme.text.feedback.warning.base
                                : line.tone === "success"
                                  ? ctx.theme.text.feedback.success.base
                                  : ctx.theme.text.muted
                            }
                          >
                            {line.marker} {line.text}
                          </text>
                          {line.reason && (
                            <text fg={ctx.theme.text.muted} wrapMode="word">
                              {line.reason}
                            </text>
                          )}
                        </box>
                      ))}
                      {rows().hiddenPending > 0 && (
                        <text fg={ctx.theme.text.muted}>
                          +{rows().hiddenPending} more waiting
                        </text>
                      )}
                    </box>
                  )}
                </box>
              )
            },
          })
    const timer = setInterval(() => {
      setNow(Date.now())
      void refresh().catch(() => {})
    }, 1_000)
    void refresh().catch(() => {})
    return () => {
      lifecycle.abort()
      clearInterval(timer)
      offAsked()
      offReplied()
      releaseSlot?.()
    }
  },
})

export default tui

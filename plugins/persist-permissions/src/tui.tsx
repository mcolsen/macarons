import fs from "node:fs/promises"
import path from "node:path"
import {
  canonicalPath,
  verifyFilesystemLocality,
} from "@macarons/permission-rules"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import type { JSX } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import {
  addAllowRule,
  allowRuleRedundant,
  createStoreKeyingResolver,
  createStoreOpener,
  createWarnOnceLatch,
  isAllowed,
  isSubAgentSession,
  keybindOption,
  narrowestPatterns,
  notePromptSession,
  OWNER_ONLY_WRITE_MODES,
  permissionStoreFile,
  promptSessionFamily,
  readStore,
  resolveScopeOption,
  routeSessionID,
  rulesFrom,
  type StoreAccess,
  type StoreKeyingResolver,
  type StoreScope,
  trim,
  tuiGate,
  tuiToast,
  warnTui,
  withStoreLock,
  withTimeout,
  writeStore,
} from "./shared"

/**
 * opencode-persist-permissions — TUI companion
 *
 * Adds a Claude Code-style "edit the allow pattern before approving" flow to
 * OpenCode's permission prompt. The host prompt itself is fixed (Allow once /
 * Allow always / Reject, with no way to change what "always" remembers), so
 * this plugin registers a keybinding and palette command that are useful while
 * a permission prompt is showing:
 *
 *   1. Press ctrl+o (default; the ctrl+x p leader chord also works —
 *      configurable via plugin options) or run "Edit allow pattern & always
 *      allow" from the command palette.
 *   2. A dialog opens, pre-filled with the pattern the server half of this
 *      plugin would persist (e.g. `docker compose up *` for a
 *      `docker compose up -d` command). Edit it to taste — narrow it to
 *      `docker compose up *`, widen it to `git *`, anything goes.
 *   3. On confirm, the pattern is written to a project-keyed file in
 *      OpenCode's trusted config directory and the pending request is
 *      approved with "once". Persistence lives in the store, not in host
 *      remember-rules that could bypass saved carve-outs or session
 *      restrictions. The server half rechecks later matching requests.
 *
 * Every surface of the flow — hint line, palette title, dialog title and
 * description — says "always allow" on purpose. The host prompt defaults to
 * "Allow once" and its highlighted option is not observable (closed UI), so
 * the flow cannot hide the hint or refuse ctrl+o while "Allow once" is
 * selected; the wording is the only thing that stops it reading as a way to
 * amend a one-time approval.
 *
 * Install both halves with `opencode plugin <path-or-package>` — it patches
 * opencode.json (server half) and tui.json (this file) in one go. To
 * configure manually instead, load this file from the `plugin` array of a
 * `tui.json` (project `.opencode/tui.json` or the global config dir):
 *
 *   { "plugin": ["file:///path/to/macarons/plugins/persist-permissions/src/tui.tsx"] }
 *
 * Do NOT copy this file into `.opencode/plugin/` — that directory is scanned
 * for *server* plugins, and this module is TUI-only. The server half
 * (src/index.ts) is still required for re-approving saved rules in later
 * sessions. (This file is .tsx: OpenCode's TUI plugin loader ships a Solid
 * JSX transform for plugin files, which the hint line below relies on.)
 *
 * Options (second element of a `["file://…", {…}]` plugin entry):
 *   - keybind: string — key(s) for the edit command, comma-separated
 *     alternatives (default "ctrl+o,<leader>p"); false or "none" disables
 *     the binding, leaving the palette entry.
 *   - hint:    boolean — while a permission prompt is pending, show a hint
 *     line under it pointing at the keybinding (default true; the line only
 *     renders when a keybind is configured).
 *   - notify:  boolean — toast what was persisted when the user answers
 *     "always" through the host prompt (default true). The host's confirm
 *     step says the approval lasts "until OpenCode is restarted" and that
 *     text cannot be overridden; with the server half installed the approval
 *     is actually permanent, and this toast is what says so.
 *   - scope:   "repository" (default) keys the store by the primary worktree
 *     root so approvals persist across every linked worktree; "worktree"
 *     restores per-checkout keying. Must match the server half's option. An
 *     invalid value pauses persistence (fail closed) — only an absent option
 *     defaults; unknown option keys are warned about for the same reason (a
 *     typo'd key must not silently drift the halves' scopes apart).
 *
 * The matching and store helpers live in ./shared.ts, imported by both this
 * file and the server half, so the two halves cannot drift apart.
 *
 * Targets OpenCode v1 (verified against 1.17.14–1.18.x), like the server half:
 * warns outside that band, disables only on OpenCode v2+. The V2 permission
 * engine persists approvals natively and reshapes the permission API. See the
 * "Version target" note in the README.
 */

const COMMAND_NAME = "persist_permissions.edit_scope"
const COMMAND_TITLE = "Edit allow pattern & always allow"
// A single keystroke by default: leader chords (ctrl+x, release, then p) give
// no feedback while pending and are easy to fumble. The chord stays as a
// comma-separated alternative, like OpenCode's own keybind strings. (A
// held-ctrl "ctrl+x ctrl+p" sequence is NOT expressible — multi-stroke
// bindings only exist via the <leader> token.)
const DEFAULT_KEYBIND = "ctrl+o,<leader>p"
// How long the notify toast waits for the server half's write to read back
// before staying silent, and how often it looks. The server persists on the
// same replied event, so a healthy save confirms in the first round or two;
// the budget covers the server's slowest path to a successful write ahead of
// it, and must stay ABOVE it or a save that really happened goes unreported:
// a /path probe that has to time out first (5s there), then the re-probe, the
// re-key, a worktree-store migration, and contention on the cross-process
// store lock (2s acquisition timeout). Silence is the safe outcome, not a free
// one — it is the whole reason this toast exists.
const SAVE_CONFIRM_TIMEOUT_MS = 8_000
const SAVE_CONFIRM_POLL_MS = 50
// How long the permission reply may take before the flow stops waiting on it.
// Same 5s as the server half's /path probe, for the same reason and against the
// same failure: a host that accepted the request and never answered. The reply
// is a local call that normally returns in milliseconds, so this only fires on
// a wedged one — but it MUST exist, because the flow's cleanup all lives in a
// finally the await never reaches. Without it, `editing` is never cleared and
// ctrl+o and the palette entry become SILENT no-ops for the rest of the TUI
// session (run() bails on that flag before it can toast anything), and the
// dialog is never cleared. The rule is durably saved before the reply is even
// sent, so a timeout costs only certainty about the prompt — which the failure
// message already declines to claim.
const REPLY_TIMEOUT_MS = 5_000
// How the edit flow opens the store. Both flags, and they are two different
// claims: the flow exists to SAVE, so an unestablished keying is re-derived
// rather than reused; and the user pressed a key for this, so a cause that is
// still outstanding is re-toasted instead of staying silent because a passive
// read already mentioned it once. The server half writes without ever wanting
// the second — see StoreAccess.
const EXPLICIT_SAVE = { write: true, explicit: true } as const
const SAVE_UNCONFIRMED_MESSAGE =
  "Shared filesystem access changed while saving. Persistence and approval are unconfirmed for the current server."

// The patterns offered for editing: what the server half would persist for an
// "always" answer, falling back to the concrete patterns when OpenCode itself
// would remember nothing.
function suggestedPatterns(
  request: Pick<PermissionRequest, "patterns" | "always">,
): string[] {
  if (!request.always.length) return [...new Set(request.patterns)]
  return narrowestPatterns(request.always, request.patterns)
}

export const tui: TuiPlugin = async (api, options) => {
  // URL locality is not filesystem locality. Every operation requires a fresh
  // server proof; only its passive confirmation polls may reuse that proof.
  if (
    tuiGate(api, {
      label: "Permission persistence",
      service: "persist-permissions",
      remoteBails: false,
    }).disabled
  )
    return

  // Unknown option keys get a warning: a TYPO'D key silently falling back to
  // defaults is how the two halves' scopes drift apart (the server half warns
  // the same way).
  const KNOWN_OPTIONS = new Set(["keybind", "hint", "notify", "scope"])
  for (const key of Object.keys(
    (options as Record<string, unknown> | undefined) ?? {},
  )) {
    if (!KNOWN_OPTIONS.has(key))
      warnTui(
        api,
        "persist-permissions",
        `ignoring unknown plugin option ${JSON.stringify(key)}.`,
      )
  }
  const keybind = keybindOption(options?.keybind, DEFAULT_KEYBIND)
  const hint = options?.hint !== false
  const notify = options?.notify !== false
  // Must match the server half's scope (its option in opencode.json): the two
  // halves resolve the store independently, and disagreeing scopes would make
  // them read and write different files. An INVALID value pauses persistence
  // (fail closed) rather than defaulting: a half that guessed "repository"
  // while the other ran "worktree" would migrate away — and delete — the
  // store the other half is actively using. Only an absent option defaults.
  const resolvedScope = resolveScopeOption(options?.scope)
  const scope: StoreScope | undefined = resolvedScope.scope
  if (resolvedScope.problem) {
    warnTui(
      api,
      "persist-permissions",
      `Permission persistence is paused: ${resolvedScope.problem}.`,
    )
  }

  // Requests whose user-facing report the edit flow has taken over. The claim
  // is made when the flow STARTS, not when it sends its reply: an external
  // "always" landing while the dialog is up is otherwise reported by the notify
  // handler AND by this flow's failed-reply path — two toasts for one answer
  // (the store stays correct either way).
  //
  // The value is a promise rather than bare presence because a claim has to be
  // RELEASABLE, and delete-on-cancel is unrepairably racy: the replied handler
  // consumes a request's bookkeeping in the same synchronous turn the event
  // arrives, so by the time a dismissed dialog released, the event it needed to
  // un-suppress would already be gone and a genuine save would go unannounced —
  // silence being exactly the failure this toast exists to prevent. So the
  // notify handler holds the event and waits for the flow to say WHAT it
  // reported: the patterns it established, or undefined when it bowed out
  // without establishing anything. The handler then stays quiet only if those
  // patterns actually cover what it was about to announce — sound containment,
  // not "someone spoke". A user who NARROWS the pattern in the dialog while an
  // "always" is answered elsewhere leaves a BROADER rule in the store than the
  // one they were shown; suppressing on bare presence would hide exactly the
  // grant they were trying to avoid. The
  // wait is unbounded on purpose — a dialog left open only DELAYS the toast,
  // while any timeout here would re-open the double-toast window. (It also
  // means confirmSaved's reach is re-resolved at dialog-close time; still
  // honest, since it always reports the store it actually read from.)
  const selfAnswered = new Map<string, Promise<string[] | undefined>>()

  // Sessions that have (or had) a live permission prompt, learned from
  // permission.asked. Sub-agent (task) tool calls run in a child session, and
  // the host prompt aggregates the viewed session with its children (see
  // currentRequest), so their prompts — typically shell/gh commands a review
  // sub-agent runs — sit under the child session id, not the one in the route.
  // The TUI api exposes no session list, so this is the only handle on those
  // ids. A reactive signal so the hint line re-renders when a child's prompt
  // first appears; stale ids are harmless (their permission() read is empty).
  const [promptSessions, setPromptSessions] = createSignal<readonly string[]>(
    [],
  )
  const trackPromptSession = (sessionID: string) =>
    setPromptSessions((prev) => notePromptSession(prev, sessionID))
  api.event.on("permission.asked", (event) => {
    const sessionID = (event as { properties?: { sessionID?: unknown } })
      .properties?.sessionID
    if (typeof sessionID === "string") trackPromptSession(sessionID)
  })

  // The store's keying resolver — created once api.state.path is populated:
  // the host fills it from a server round-trip that races plugin activation,
  // and until it lands every field is an empty-string placeholder. Resolving
  // against those would pause persistence ("not trusted") for the TUI's
  // lifetime, so each store access retries until real paths land. Like the
  // server half, the resolver does not trust the host's non-git sentinel
  // (observed lying for linked-worktree sessions at boot) and re-derives an
  // unconfirmed keying on later accesses — writes always, reads throttled —
  // so both halves converge on the same store even after a boot-time git
  // failure; the opener's migration pass (memoized by storeFile) folds any
  // interim fallback-keyed saves in after a late re-key.
  let keyingResolver: StoreKeyingResolver | undefined
  const resolveKeying: StoreKeyingResolver | undefined = scope
    ? (config, access) => {
        const { worktree, directory } = api.state.path
        keyingResolver ??= createStoreKeyingResolver({
          scope,
          directory,
          worktree,
        })
        return keyingResolver(config, access)
      }
    : undefined

  const toast = tuiToast(api)
  let localityEpoch = 0
  api.lifecycle.onDispose(
    api.event.on("server.connected", () => {
      localityEpoch++
    }),
  )

  // The store-readiness pipeline both halves share (see ./shared). What this
  // half supplies:
  //
  //   - the config directory comes from the host's own reactive path state,
  //     read fresh on every access. The host writes all path fields in one
  //     batch when its sync lands, so an empty config dir means "still
  //     syncing", never partial data — a transient state, not a distrusted
  //     path, so it echoes the host's own wording for it and leaves the next
  //     access to retry;
  //   - only PAUSES are spoken here. The server half logs and toasts every
  //     recovery and every migration report already, and both halves render
  //     into the same TUI: two voices announcing one move would read as two
  //     moves. A user-invoked access passes `explicit` and so re-hears a cause
  //     that is still outstanding.
  //   - …with one exception, and it is a voice decision rather than a policy
  //     one: "unkeyed-shared" is the fail-closed read gate this half adopted
  //     from the server half, and its message is about AUTO-APPROVAL — the
  //     server half's job, announced by the server half, on the same event.
  //     The reads it blocks here are the notify handlers' passive snapshot and
  //     its confirmation poll, whose safe outcome is already silence; the edit
  //     flow is a write and never meets the gate. So this half fails closed on
  //     it and says nothing, rather than echoing a pause the user is hearing
  //     anyway.
  const openLocalStore = createStoreOpener({
    resolveKeying,
    configDir: () => {
      const { config, directory } = api.state.path
      return config && directory
        ? { config }
        : {
            unavailable:
              "OpenCode's paths are still syncing — try again in a moment",
          }
    },
    announce: (notice) => {
      if (notice.kind !== "paused" || notice.key === "unkeyed-shared") return
      toast("warning", notice.message)
    },
  })

  const verifyStoreLocality = async (access: StoreAccess = {}) => {
    const epoch = localityEpoch
    const { config, directory, worktree } = api.state.path
    const projectRoot = worktree && worktree !== "/" ? worktree : directory
    const current = () =>
      !api.lifecycle.signal.aborted &&
      epoch === localityEpoch &&
      config === api.state.path.config &&
      directory === api.state.path.directory &&
      worktree === api.state.path.worktree
    // Let the existing pipeline report the transient path-sync race.
    if (!config || !directory) {
      await openLocalStore(access)
      return undefined
    }
    const paths = [
      config,
      path.dirname(permissionStoreFile(config, projectRoot)),
      projectRoot,
    ]
    if (
      !(await verifyFilesystemLocality(api, {
        service: "persist-permissions",
        directory,
        paths,
      })) ||
      !current()
    ) {
      if (access.explicit)
        toast(
          "warning",
          "Permission editing is unavailable: shared filesystem access with the server could not be verified. Nothing was saved or approved; server settings are unchanged.",
        )
      return undefined
    }
    return { epoch, paths, current }
  }

  const openStore = async (access: StoreAccess = {}) => {
    const locality = await verifyStoreLocality(access)
    if (!locality) return undefined
    const ready = await openLocalStore(access)
    return ready && locality.current()
      ? { ...ready, epoch: locality.epoch }
      : undefined
  }

  // Causes outside the store pipeline (a store that will not parse) warn the
  // same way: once per cause on the passive read path, every time on an
  // explicit invocation, and re-armed once the condition reads cleanly again.
  const storeWarnings = createWarnOnceLatch()
  const warnStore = (
    key: string,
    explicit: boolean,
    variant: "warning" | "error",
    message: string,
  ) => {
    // `warn` returns false for a cause already outstanding; an explicit
    // invocation re-toasts anyway, which is the whole point of the flag.
    if (!storeWarnings.warn(key) && !explicit) return
    toast(variant, message)
  }

  // A passive read: the notify handlers' snapshot of what the store would
  // already allow. Never explicit — nothing the user pressed is waiting on it.
  const readReadyStore = async () => {
    const ready = await openStore()
    if (!ready) return undefined
    const store = await readStore(ready.file)
    if (ready.epoch !== localityEpoch) return undefined
    if (!store) {
      warnStore(
        "corrupt-store",
        false,
        "error",
        `Not saved: ${ready.file} is unreadable or invalid JSON.`,
      )
      return undefined
    }
    storeWarnings.resolve("corrupt-store")
    return { file: ready.file, shared: ready.shared, store }
  }

  // Both save paths — the plugin's edit flow and a plain "always" answered
  // through the host prompt — end at the same durable outcome: a rule in the
  // persistent permission store that outlives the session. Report it in one
  // wording so the two paths don't read as different things, and name the
  // store's reach: a repository-shared rule applies in every worktree, a
  // fallback- or worktree-scoped one only in this checkout — the difference
  // is exactly what a user hunting for a missing rule needs to see. (No file
  // name here: the store is a hashed path in OpenCode's config dir, and the
  // old wording named a legacy file that no longer exists.)
  const storeLabel = (shared: boolean) =>
    shared
      ? "the repository's shared permission store"
      : "this project's permission store"
  // The tail is a whole extra SENTENCE, not a clause: when the edit flow loses
  // the race for the prompt this is the only report the user gets (the notify
  // handler defers to it), so it still has to name the store and its reach —
  // and the reach already spends the sentence's one em dash, leaving nowhere to
  // hang a ", but …" that would not read as a qualifier on "persists".
  const savedMessage = (patterns: string, shared: boolean, tail = "") =>
    `Saved ${patterns} to ${storeLabel(shared)} — persists across sessions${shared ? " and worktrees" : ""}.${tail}`

  // The permission request the host prompt is currently showing. The host does
  // not just read the viewed session's own prompts: it aggregates that session
  // with its sub-agent child sessions, sorts by session id, and renders index 0
  // (a child session's *own* view shows none). So a shell command a sub-agent
  // runs prompts under the child session, not the one in the route — reading
  // only the routed session missed those entirely ("No pending permission
  // request in this session"). Mirror the host: bail when the viewed session is
  // itself a child (routes/session renders the parent), else fold in every
  // known child session's prompts.
  const currentRequest = (): PermissionRequest | undefined => {
    const sessionID = routeSessionID(api)
    if (!sessionID) return undefined
    if (isSubAgentSession(api, sessionID)) return undefined
    // Sorted, because index 0 of the host's own sorted aggregate is the
    // request it is showing — this half must name the same one.
    return promptSessionFamily(api, sessionID, promptSessions())
      .sort()
      .flatMap((id) => api.state.session.permission(id))[0]
  }

  // Shown inside the edit dialog. The user may have opened it while the host
  // prompt's default "Allow once" option was highlighted, expecting to amend a
  // one-time approval — the dialog itself has to say what confirming does.
  const persistenceNote = () => (
    <text fg={api.theme.current.textMuted}>
      Saves a persistent allow rule and approves the request — applies in future
      sessions too, not just this once. Esc cancels.
    </text>
  )

  // One editable text dialog. Resolves the edited value, or null when the
  // user dismisses the dialog (escape / mouse). The host DialogPrompt does not
  // close itself on confirm; the caller replaces or clears it.
  const promptEdit = (
    title: string,
    value: string,
    description?: () => JSX.Element,
  ): Promise<string | null> =>
    new Promise((resolve) => {
      let settled = false
      const done = (result: string | null) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      api.ui.dialog.replace(
        () =>
          api.ui.DialogPrompt({
            title,
            description,
            value,
            placeholder: value,
            onConfirm: (text) => done(text),
            onCancel: () => done(null),
          }),
        () => done(null),
      )
    })

  // Answer the pending request, bounded (see REPLY_TIMEOUT_MS). Throws on a
  // rejected reply, an error payload, or the timeout alike: from the caller's
  // side those are one outcome — the rule is saved and the prompt's fate is
  // unknown — and the caller's catch already says exactly that.
  const sendReply = async (
    requestID: string,
    directory: string | undefined,
  ) => {
    // Cancels the request too, not just the wait for it.
    const result = await withTimeout(
      (signal) =>
        api.client.permission.reply(
          { requestID, reply: "once", directory },
          { signal },
        ),
      REPLY_TIMEOUT_MS,
      { message: "the permission reply did not respond" },
    )
    if (result.error) throw new Error(JSON.stringify(result.error))
  }

  let editing = false

  const run = async () => {
    if (editing) return
    const request = currentRequest()
    if (!request) {
      toast("info", "No pending permission request in this session.")
      return
    }
    // Claim the report before the first await: the explicit openStore below is
    // real store I/O that re-derives keying with write semantics and can spawn
    // `git`, so an external "always" can land inside it — the window the claim
    // exists to close. From here until the finally, this flow owns what the
    // user is told about this request, whoever ends up answering it. Nothing
    // between the claim and the try can throw (a Promise constructor runs its
    // executor synchronously), so the finally always releases.
    // …but only when there is a notifier to claim it FROM. With `notify: false`
    // no replied-event listener is ever registered, so nothing consumes a claim
    // and nothing would be double-reported without one; creating them anyway
    // left one settled promise per successful edit in the map (the success path
    // deliberately keeps its entry for that listener), bounded only by trim's
    // 500-entry cap.
    let releaseClaim: (reported: string[] | undefined) => void = () => {}
    if (notify) {
      selfAnswered.set(
        request.id,
        new Promise<string[] | undefined>((resolve) => {
          releaseClaim = resolve
        }),
      )
      trim(selfAnswered)
    }
    // Set only where the flow reports the DURABLE outcome — the rule is in the
    // store, whether this flow wrote it or found it already covered — and
    // licensed by the lock-held read-modify-write that established that, not
    // merely by having toasted something. The bow-out paths — dismissed dialog,
    // empty pattern, a store that went unreadable or unwritable — leave it
    // false deliberately: they establish nothing, so an "always" answered
    // elsewhere is still news the notify handler owes the user.
    let reported: string[] | undefined
    let dialogOpened = false
    // Locked before the first await too: a second ctrl+o during the store probe
    // would otherwise open a competing dialog and overwrite the claim above.
    editing = true
    try {
      // Report unsafe paths or a required legacy migration before asking the
      // user to edit anything. Rechecked after the dialog before writing.
      if (!(await openStore(EXPLICIT_SAVE))) return

      const suggested = suggestedPatterns(request)
      if (!suggested.length) {
        toast("warning", `Nothing to persist for "${request.permission}".`)
        return
      }

      // From here a dialog is opened, so the finally has to clear it. Before
      // this point none was, and clearing unconditionally would dismiss
      // whatever else the host happens to be showing.
      dialogOpened = true
      const edited: string[] = []
      for (const [i, suggestion] of suggested.entries()) {
        const step =
          suggested.length > 1 ? ` (${i + 1}/${suggested.length})` : ""
        const value = await promptEdit(
          `Always allow "${request.permission}"${step}`,
          suggestion,
          persistenceNote,
        )
        if (value === null) return
        const trimmed = value.trim()
        if (!trimmed) {
          // Scoped to this flow's own effect, not the request's: with the claim
          // released the notify handler may follow this with a "Saved …" for an
          // answer that landed elsewhere, and "nothing saved" would read as a
          // contradiction of it.
          toast("info", "Empty pattern — cancelled, no rule added.")
          return
        }
        edited.push(trimmed)
      }

      const ready = await openStore(EXPLICIT_SAVE)
      if (!ready) return
      const file = ready.file
      let changed: boolean | undefined
      try {
        // The read→merge→write sequence holds the cross-process store lock,
        // so a concurrent save from the server half (or another instance)
        // inside this window cannot be silently overwritten by the rename.
        changed = await withStoreLock(
          file,
          async () => {
            if (ready.epoch !== localityEpoch)
              throw new Error("shared filesystem proof was invalidated")
            const store = await readStore(file)
            if (!store) return undefined
            // Skip unedited suggestions a broader rule provably covers — the
            // same sound redundancy skip the server half applies — so
            // confirming defaults never piles narrower duplicates under an
            // existing broader rule. Patterns the user actually edited are
            // always appended: re-asserting one may be the point
            // (last-rule-wins overrides a later carve-out).
            const priorRules = rulesFrom(store)
            let changed = false
            for (const [i, rule] of edited.entries()) {
              if (
                rule === suggested[i] &&
                allowRuleRedundant(request.permission, rule, priorRules)
              )
                continue
              changed = addAllowRule(store, request.permission, rule) || changed
            }
            if (ready.epoch !== localityEpoch)
              throw new Error("shared filesystem proof was invalidated")
            if (changed) await writeStore(file, store, OWNER_ONLY_WRITE_MODES)
            return changed
          },
          { modes: OWNER_ONLY_WRITE_MODES },
        )
      } catch (error) {
        toast(
          "error",
          `Not saved: could not write ${file} (${error instanceof Error ? error.message : String(error)}).`,
        )
        return
      }
      if (changed === undefined) {
        warnStore(
          "corrupt-store",
          true,
          "error",
          `Not saved: ${file} is unreadable or invalid JSON.`,
        )
        return
      }
      storeWarnings.resolve("corrupt-store")
      const saveStillCurrent = () => {
        if (ready.epoch === localityEpoch) return true
        toast("warning", SAVE_UNCONFIRMED_MESSAGE)
        return false
      }
      if (!saveStillCurrent()) return

      // The durable outcome is established HERE — the lock-held read-modify-
      // write above put the rule in the store (or found it already covered) —
      // so this is where the claim is answerable, and both reply outcomes below
      // set `reported` to exactly this. Releasing before the reply keeps a
      // reply call that never settles from holding the notify handler's report
      // of an answer that landed elsewhere; the finally still releases every
      // path that bows out before this point.
      reported = edited
      releaseClaim(reported)

      // Persistence is already durable. Reply only "once": a host remember-
      // rule could bypass other saved exceptions or session restrictions.
      // The server half rechecks later matching requests against both.
      const saved = edited.join(", ")
      try {
        await sendReply(
          request.id,
          api.state.session.get(request.sessionID)?.directory ??
            api.state.path.directory,
        )
        if (!saveStillCurrent()) return
        // Don't surface the "once" reply: the saved rule applies from now on,
        // and "(once)" would read as if nothing was persisted. Same wording
        // as the host-prompt "always" path; the durable effect is identical.
        toast(
          "success",
          changed
            ? savedMessage(saved, ready.shared)
            : `Already covered by ${storeLabel(ready.shared)} — request approved.`,
        )
      } catch {
        if (!saveStillCurrent()) return
        // Usually the request was answered elsewhere while the dialog was
        // open, but any reply failure lands here — don't claim to know. The
        // rule is saved either way; that is what the user asked for. This is
        // also the toast the notify handler steps aside for, so it names the
        // store's reach like every other durable-outcome message.
        toast(
          "warning",
          changed
            ? savedMessage(
                saved,
                ready.shared,
                " The prompt could not be answered; it may already have been resolved.",
              )
            : `Already covered by ${storeLabel(ready.shared)}. The prompt could not be answered; it may already have been resolved.`,
        )
      }
    } finally {
      editing = false
      releaseClaim(reported)
      // A released claim the notify handler never consumed is dead weight, and
      // a stale entry would suppress the report for whatever request reuses the
      // id. Keep it only when this flow reported: that is the case where its
      // OWN reply still has a replied event coming that must stay silent. (With
      // `notify: false` there is no entry to keep — none was created.)
      if (!reported) selfAnswered.delete(request.id)
      if (dialogOpened) api.ui.dialog.clear()
    }
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: COMMAND_NAME,
        title: COMMAND_TITLE,
        category: "Permission",
        namespace: "palette",
        run,
      },
    ],
    bindings: keybind
      ? [
          {
            key: keybind,
            cmd: COMMAND_NAME,
            desc: COMMAND_TITLE,
            group: "Permission",
          },
        ]
      : [],
  })

  // Toast what a plain "always" answer through the host prompt persisted. The
  // host's confirm step claims the approval lasts "until OpenCode is
  // restarted" (hard-coded, not overridable); the server half makes it
  // permanent, and this is the only place the user learns that.
  //
  // WHAT to report is computed at asked-time, against the store as it was
  // BEFORE the reply — a replied-time read would race the server half's write
  // and see the rule it is about to announce. WHETHER it happened is checked
  // afterwards, because this half cannot know: the two halves are separate
  // processes with no channel, the server re-resolves keying with write
  // semantics before persisting, and it saves nothing at all when that re-key
  // pauses migration or its store path stops being trusted. The store itself
  // is the acknowledgment — nothing is claimed until the rule reads back.
  if (notify) {
    const tracked = new Map<
      string,
      Promise<
        | { autoAllowed: boolean; saveable: string[]; permission: string }
        | undefined
      >
    >()

    api.event.on("permission.asked", (event) => {
      const { id, permission, patterns, always } = event.properties
      // Track synchronously: the store probe below is real fs I/O, and a
      // reply can land before it settles — it must still find the request.
      tracked.set(
        id,
        (async () => {
          const snapshot = await readReadyStore()
          if (!snapshot) return
          const rules = rulesFrom(snapshot.store)
          // What the server half would persist: the always-set, with the
          // session-scoped blanket "*" narrowed to the concrete patterns, minus
          // anything provably redundant. Mirrors its narrowest()+skip logic.
          const saveable = narrowestPatterns(always, patterns).filter(
            (pattern) => !allowRuleRedundant(permission, pattern, rules),
          )
          // Requests the store already allows get auto-answered by the server
          // half — an "always" reply for those is not the user's and persists
          // nothing new.
          const autoAllowed = isAllowed(permission, patterns, rules)
          // The permission travels with the snapshot: the replied event
          // carries only the request id and the answer.
          return { autoAllowed, saveable, permission }
        })(),
      )
      trim(tracked)
    })

    // Poll the store the server half would write until the approval reads
    // back, then report where it actually landed. Coverage, not literal
    // presence: a rule the server skipped as redundant (another writer added a
    // broader one first) is just as persisted as one it wrote. Silence on
    // timeout is deliberate — the server half toasts its own pause reasons,
    // and claiming a save it declined to make is the bug this replaces.
    const confirmSaved = async (
      permission: string,
      saveable: string[],
    ): Promise<{ shared: boolean; current: () => boolean } | undefined> => {
      const epoch = localityEpoch
      const deadline = Date.now() + SAVE_CONFIRM_TIMEOUT_MS
      let locality: Awaited<ReturnType<typeof verifyStoreLocality>>
      let identities: Awaited<ReturnType<typeof fs.stat>>[] | undefined
      // The keying resolver caches canonical paths. Reusing a proof must not
      // follow a replaced config/project mount or a retargeted store symlink.
      const current = async () => {
        if (!locality?.current() || !identities) return false
        try {
          const stats = await Promise.all(
            locality.paths.map((dir) => fs.stat(dir)),
          )
          return (
            locality.current() &&
            stats.every(
              (stat, i) =>
                stat.isDirectory() &&
                stat.dev === identities?.[i]?.dev &&
                stat.ino === identities?.[i]?.ino,
            )
          )
        } catch {
          return false
        }
      }
      // Passive resolves only. Forcing a re-derivation here (write semantics,
      // to chase a re-key the server half might be making on this same event)
      // buys nothing and costs a `git` spawn inside the reply path: what makes
      // the report honest is that the rule was found in the store this half
      // resolved, so `shared` always describes the file it was actually read
      // from. If the server re-keyed and wrote elsewhere, this poll simply
      // never finds it and stays silent — the same safe outcome as any other
      // unconfirmed save, and never a claim about the wrong store.
      for (;;) {
        if (epoch !== localityEpoch || api.lifecycle.signal.aborted) return
        if (!locality) {
          if (api.state.path.config && api.state.path.directory) {
            locality = await verifyStoreLocality()
            if (!locality) return
            identities = await Promise.all(
              locality.paths.map((dir) => fs.stat(dir)),
            ).catch(() => undefined)
          } else {
            // Paths can still be syncing when the reply arrives. Wait for
            // readiness without spending (or retrying) the confirmation proof.
            await openLocalStore()
          }
        }
        if (locality) {
          if (!(await current())) return
          const ready = await openLocalStore()
          if (!(await current())) return
          if (ready) {
            const safeFile = async () =>
              (await canonicalPath(ready.file).catch(() => undefined)) ===
              ready.file
            if (!(await safeFile())) return
            const store = await readStore(ready.file)
            if (
              !(await current()) ||
              !(await safeFile()) ||
              !locality.current()
            )
              return
            if (store && isAllowed(permission, saveable, rulesFrom(store)))
              return { shared: ready.shared, current: locality.current }
          }
        }
        if (Date.now() >= deadline) return undefined
        await new Promise((resolve) =>
          setTimeout(resolve, SAVE_CONFIRM_POLL_MS),
        )
      }
    }

    api.event.on("permission.replied", (event) => {
      const { requestID, reply } = event.properties
      const pending = tracked.get(requestID)
      tracked.delete(requestID)
      // Consume the claim synchronously — one event to one claimant, and the
      // map stays bounded whatever the flow does next — but defer the
      // DECISION: an edit flow whose dialog is still open has claimed the
      // report without yet knowing whether it will make one.
      const claim = selfAnswered.get(requestID)
      selfAnswered.delete(requestID)
      if (reply !== "always" || !pending) return
      return (async () => {
        // Awaiting the claim BEFORE the confirmation poll also keeps that poll
        // honest: the flow's own write may be the very thing it would confirm.
        const claimed = claim ? await claim : undefined
        const info = await pending
        if (!info || info.autoAllowed || !info.saveable.length) return
        // Silent only when the flow's report already covers this one. Sound
        // containment against the patterns it actually established — a flow
        // that NARROWED the pattern reported a strictly smaller grant than the
        // one the host's own "always" just persisted, and that difference is
        // the whole reason the user reached for the edit dialog.
        if (
          claimed?.length &&
          isAllowed(
            info.permission,
            info.saveable,
            claimed.map((pattern) => ({
              permission: info.permission,
              pattern,
              action: "allow" as const,
            })),
          )
        ) {
          return
        }
        const confirmed = await confirmSaved(info.permission, info.saveable)
        if (!confirmed?.current()) return
        toast("info", savedMessage(info.saveable.join(", "), confirmed.shared))
      })()
    })
  }

  // A hint line rendered directly under the permission prompt while one is
  // pending (the host prompt's own footer is not extensible). app_bottom is
  // the slot pinned beneath the session view; state.session.permission is a
  // reactive store read, so the line appears and disappears with the prompt.
  // Show only the first alternative — "ctrl+o,<leader>p,…" is noise. The line
  // renders whichever host option is highlighted (the selection is not
  // observable), so its wording must say the flow is an always-allow.
  const hintKey = keybind?.split(",")[0]?.trim()
  if (hint && hintKey) {
    api.slots.register({
      order: 300,
      slots: {
        app_bottom: () => (
          <Show when={currentRequest()}>
            <box
              flexDirection="row"
              flexShrink={0}
              paddingLeft={2}
              paddingRight={2}
            >
              <text fg={api.theme.current.text}>
                {hintKey}{" "}
                <span style={{ fg: api.theme.current.textMuted }}>
                  edit pattern & always allow
                </span>
              </text>
            </box>
          </Show>
        ),
      },
    })
  }
}

const plugin: TuiPluginModule = {
  id: "opencode-persist-permissions",
  tui,
}

export default plugin

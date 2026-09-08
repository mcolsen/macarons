import fs from "node:fs/promises"
import path from "node:path"
import {
  canonicalPath,
  createFilesystemLocalityResponder,
  isInside,
  permissionStoreFile,
} from "@macarons/permission-rules"
import type { Plugin } from "@opencode-ai/plugin"
import {
  addAllowRule,
  allowRuleRedundant,
  appLogger,
  automatedReplies,
  createStoreKeyingResolver,
  createStoreOpener,
  createWarnOnceLatch,
  isAllowed,
  narrowestPatterns,
  normalizeRequest,
  OWNER_ONLY_WRITE_MODES,
  type PermissionAsk,
  type Rule,
  readStore as readStoreFile,
  reportServerCompat,
  resolveScopeOption,
  rulesFrom,
  type Store,
  type StoreScope,
  serverToast,
  sessionOverrides,
  sessionRulesOf,
  trim,
  unsupportedVersionHooks,
  withStoreLock,
  withTimeout,
  writeStore,
} from "./shared"

/**
 * opencode-persist-permissions
 *
 * Persists "always allow" permission approvals across OpenCode sessions,
 * mirroring Claude Code's `.claude/settings.local.json` behavior.
 *
 * OpenCode only remembers an "always" approval in memory, so it is lost when
 * the instance exits. This plugin:
 *
 *   1. Watches `permission.replied` events. When the user answers "always",
 *      it saves the approved patterns to a project-keyed file in OpenCode's
 *      trusted config directory. Only the narrowest
 *      interpretation of the approval is saved: OpenCode's blanket "*"
 *      remember-rule (which the TUI presents as session-scoped) is replaced
 *      by the request's concrete patterns, so approving one file edit never
 *      persists tool-wide access.
 *   2. Watches `permission.asked` events. When every requested pattern is
 *      already allowed by the saved rules, it replies on the user's behalf so
 *      no prompt interrupts the session. It always replies "once": a host
 *      remember-rule could override saved carve-outs or session restrictions
 *      for later requests and other pending prompts. Each matching request
 *      is checked again against the current store and session rules.
 *      One boundary: a session whose OWN ruleset explicitly asks/denies the
 *      request is never auto-approved. Session-scoped rules are deliberate
 *      overrides — e.g. a plugin sandboxing a forked session (opencode-btw's
 *      read-only side questions) — and the host evaluates them after the
 *      agent's, so they are the reason the prompt exists; the saved store
 *      mirrors config-level intent and must not outrank them.
 *
 * The store uses the same shape as the `permission` block in opencode.json,
 * so entries can be copied there verbatim. Matching replicates OpenCode's own
 * semantics: `*` / `?` wildcards, `~` and `$HOME` expansion, last matching
 * rule wins, and a trailing " *" also matches the bare command.
 *
 * Stores are keyed by the PRIMARY worktree root by default (scope:
 * "repository"), so approving something in one linked worktree persists it
 * for the primary checkout and every other worktree of the same repository.
 * The work-tree detection does not trust the host's instance context alone:
 * its non-git sentinel is verified against git, and an unconfirmed keying is
 * re-derived on later accesses (see createStoreKeyingResolver). A store
 * written under the old per-worktree keying is folded in on first access when
 * it holds only allow rules; one with ask/deny carve-outs pauses persistence
 * for that worktree until it is merged by hand (see migrateWorktreeStore).
 * Set the `scope: "worktree"` plugin option (on BOTH halves) to restore
 * per-worktree isolation.
 *
 * The matching and store helpers live in ./shared.ts, imported by both this
 * file and the TUI companion (src/tui.tsx). Install both halves with
 * `opencode plugin <path-or-package>` — it patches opencode.json and tui.json
 * in one go. To copy a single file into `.opencode/plugin/` instead, copy the
 * bundled dist/persist-permissions.js (`bun run build`), not this file — this
 * file's ./shared import does not resolve from that directory.
 *
 * Targets OpenCode v1; verified against 1.17.14–1.18.x. Outside that band it
 * warns but runs; only OpenCode v2+ disables it. The runtime guard is
 * deliberate because path/file installs bypass package-engine checks. The V2
 * permission engine persists "always" approvals natively and reshapes these
 * events, so retire this server half rather than run both layers together.
 * See the "Version target" note in the README.
 */

const SERVICE = "persist-permissions"

// How long a failed /path lookup is left alone before a READ re-probes. Same
// 15s as createStoreKeyingResolver's retry interval — the two failures have the
// same cause (a host that is still starting) and no reason to disagree about
// how long it takes to clear.
const CONFIG_RETRY_INTERVAL_MS = 15_000

// How long a single /path request may take before it counts as a transient
// failure. /path is instance-scoped and normally answers in milliseconds, so
// this only ever fires on a host that has stopped responding — but it MUST
// exist: every caller joins the one in-flight probe, and a promise that never
// settles never clears it, so one stalled request would wedge every later
// permission event for the life of the process. (Before retries existed exactly
// one /path call was ever made, so a host that answered once — even with an
// error — could not wedge anything afterwards. Retrying from the hooks is what
// creates the exposure, so the bound comes with it.)
const CONFIG_PROBE_TIMEOUT_MS = 5_000

// The shared reading of a permission.asked event (see the library's
// normalizeRequest): this plugin ignores the classifier-only fields.
type Request = PermissionAsk

// Plugin options (the second element of an ["file://…", {…}] plugin entry).
// `scope` decides what a project's store is keyed by: "repository" (default)
// keys by the primary worktree root so approvals persist across every linked
// worktree of the repository; "worktree" restores the historical per-checkout
// keying. The TUI companion accepts the same option and the two must agree —
// see the README. An INVALID scope value returns no scope at all and the
// plugin pauses persistence: only an absent option may default. The halves
// resolve this option independently, so one half silently defaulting to
// "repository" while the other runs "worktree" would migrate away — and
// delete — the store the other half is actively using. NOT exported: the
// server loader calls every export of this module as a plugin function (see
// test/packaging.test.ts).
function normalizeOptions(raw: unknown): {
  scope?: StoreScope
  problems: string[]
} {
  const problems: string[] = []
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined
  const resolved = resolveScopeOption(record?.scope)
  if (resolved.problem) problems.push(resolved.problem)
  for (const key of Object.keys(record ?? {})) {
    if (key !== "scope") problems.push(`unknown option ${JSON.stringify(key)}`)
  }
  return { scope: resolved.scope, problems }
}

export const PersistPermissionsPlugin: Plugin = async (
  { client, directory, worktree, serverUrl },
  rawOptions,
) => {
  const log = appLogger(client, SERVICE)

  const compat = await reportServerCompat({
    client,
    serverUrl,
    label: "Permission persistence",
    service: SERVICE,
    log,
  })
  // Only a non-v1 host disables persistence; the deferred toast surfaces that
  // at the first permission prompt. A merely untested v1 host runs on.
  if (compat?.disable)
    return unsupportedVersionHooks(client, directory, compat.message)

  const { scope, problems } = normalizeOptions(rawOptions)
  for (const problem of problems)
    log("warn", `plugin option problem: ${problem}`)

  // The host's instance context is supposed to name the session's git work
  // tree, with "/" as the non-git sentinel — but that sentinel is host state,
  // not ground truth: it has been observed reaching plugin factories for
  // sessions that ARE inside linked worktrees, transiently at boot, which
  // silently regressed store keys to per-worktree. The keying resolver
  // verifies the sentinel against git itself and keeps re-deriving (writes
  // always, reads throttled) until git positively confirms the keying, so a
  // boot-time failure cannot choose the store key for the process lifetime; a
  // late success swaps the paths and the store opener's migration pass folds
  // any interim fallback-keyed saves into the shared store.
  const resolveKeying = scope
    ? createStoreKeyingResolver({
        scope,
        directory,
        worktree,
        onProbeFallback: () =>
          log(
            "warn",
            "could not establish the primary worktree root; keying the permission store by this worktree",
          ),
        onShared: (keyRoot, root, late) => {
          if (keyRoot === root) return
          log(
            "info",
            late
              ? `sharing the permission store across worktrees of ${keyRoot} (established after retry; earlier saves keyed to this worktree will be folded in)`
              : `sharing the permission store across worktrees of ${keyRoot}`,
          )
        },
      })
    : undefined

  // The permanently-broken leg, decided ONCE, synchronously, at factory time.
  // No later permission event can make it succeed, so it stays memoized:
  // retrying it would only re-log and re-toast a fixed misconfiguration on
  // every prompt — a client with no path lookup will never grow one, because
  // the injected SDK client is a single fixed object for the process.
  // Everything that CAN succeed later — the request itself, and a response
  // that omitted `config` — lives in probeConfigDir.
  //
  // Without a keying resolver there is no scope, and openStore pauses every
  // access before it ever asks for a config directory (guessing a scope is
  // what would let a typo'd half migrate away — and delete — the store the
  // correctly-configured half is using; see normalizeOptions). This leg only
  // has to keep THAT from touching client.path: a host answering a question
  // whose answer can never be used has been probed for nothing. The sentinel
  // below is internal — the pause the user sees is openStore's.
  const pathProbe:
    | { get: (input?: unknown) => Promise<{ data?: unknown }> }
    | { error: string } = (() => {
    if (!resolveKeying) return { error: "the store keying is unavailable" }
    const pathApi = (
      client as {
        path?: { get?: (input?: unknown) => Promise<{ data?: unknown }> }
      }
    ).path
    const get = pathApi?.get?.bind(pathApi)
    if (!get) return { error: "the SDK client has no path lookup method" }
    return { get }
  })()

  // /path is instance-scoped and can deadlock plugin bootstrap when awaited
  // during initialization, so it is only awaited from the permission hooks and
  // the boot prime below — never inline in the factory.
  //
  // Only a SUCCESS is cached for the process. A throw from the request, or a
  // response without `config`, is a host-still-starting / request-race symptom;
  // memoizing one of those disabled persistence until OpenCode restarted, in a
  // plugin whose whole contract is that nothing needs a restart (deleting a
  // rule and unpausing a migration both take effect on the next request). The
  // retry shape deliberately mirrors createStoreKeyingResolver rather than
  // inventing a second policy:
  //   - one in-flight probe is shared by every concurrent awaiter;
  //   - a WRITE always re-probes — an "always" reply is rare, user-initiated,
  //     and the moment a silently dropped save becomes lost user intent;
  //   - a READ re-probes at most once per CONFIG_RETRY_INTERVAL_MS, so a host
  //     that is genuinely down is not re-probed on every prompt.
  // Every failure stays fail-closed: the caller pauses persistence and leaves
  // the prompt interactive — including a probe that exceeds
  // CONFIG_PROBE_TIMEOUT_MS, which is treated as an ordinary transient failure
  // so a stalled host cannot wedge the hooks that join it.
  let configDir: string | undefined
  let configInflight:
    | Promise<{ config: string } | { error: string }>
    | undefined
  let configError: string | undefined
  let configAttemptAt: number | undefined
  // Aborted on dispose, and composed into every config probe. Losing a timeout
  // race releases the plugin's callers but says nothing about the REQUEST: an
  // unaborted one stays alive holding its transport resources, and since writes
  // deliberately bypass the read throttle, a genuinely wedged host would
  // accumulate one per "always" reply for the life of the process. withTimeout
  // aborts each attempt at its own deadline; this signal aborts whatever is
  // still on the wire when the plugin is torn down.
  const disposeController = new AbortController()

  const probeConfigDir = async (access: {
    write?: boolean
    /** The boot prime below: it must not spend the read throttle's budget. */
    prime?: boolean
  }): Promise<{ config: string } | { error: string }> => {
    if ("error" in pathProbe) return { error: pathProbe.error }
    const getPath = pathProbe.get
    const write = access.write === true
    for (;;) {
      if (configDir !== undefined) return { config: configDir }
      if (configInflight) {
        const joined = await configInflight
        // A write must not inherit a failure from a probe that was already in
        // flight when it arrived: that probe may have called /path before the
        // host finished starting. Loop back and probe again on its own.
        if (!write || !("error" in joined)) return joined
        continue
      }
      const at = Date.now()
      const due =
        configAttemptAt === undefined ||
        write ||
        at - configAttemptAt >= CONFIG_RETRY_INTERVAL_MS
      // Report the last real cause rather than inventing a wording for
      // "throttled": the caller's warn is keyed by cause, and a throttled read
      // is the same pause the user was already told about.
      if (!due)
        return {
          error: configError ?? "the config directory could not be resolved",
        }
      // Stamped synchronously, before the first await, so the boot prime
      // provably leaves the budget unspent for the first real permission event:
      // the failure this retry exists for clears in seconds, and making the
      // user wait a full interval for it would be the same bug with a timer.
      if (!access.prime) configAttemptAt = at
      const attempt = (async (): Promise<
        { config: string } | { error: string }
      > => {
        try {
          // A fresh signal per attempt (withTimeout mints one): cancelling the
          // timed-out request must not reach the retry that replaces it. The
          // request itself is cancelled, not just our wait for it — an SDK
          // transport that ignores `signal` is no worse off than before.
          const result = await withTimeout(
            (signal) => getPath({ query: { directory }, signal }),
            CONFIG_PROBE_TIMEOUT_MS,
            {
              signal: disposeController.signal,
              message: "the path lookup did not respond",
            },
          )
          const config = (result?.data as { config?: unknown } | undefined)
            ?.config
          if (typeof config !== "string" || !config)
            throw new Error("the path response omitted config")
          configDir = config
          // Unreachable today (the cache check above short-circuits first), but
          // a stale cause left behind is exactly what a later reorder would
          // start reporting.
          configError = undefined
          return { config }
        } catch (error) {
          configError = error instanceof Error ? error.message : String(error)
          return { error: configError }
        }
      })().finally(() => {
        if (configInflight === attempt) configInflight = undefined
      })
      configInflight = attempt
      return attempt
    }
  }

  const locality = createFilesystemLocalityResponder({
    service: SERVICE,
    paths: async (signal) => {
      signal.throwIfAborted()
      const cfg = await probeConfigDir({})
      signal.throwIfAborted()
      if ("error" in cfg) return
      // Prove this instance's project mount, not the repository-wide store key.
      // Do not invoke keying here: resolving it can adopt legacy store names.
      const root = worktree && worktree !== "/" ? worktree : directory
      if (!path.isAbsolute(cfg.config) || !path.isAbsolute(root)) return
      const policyDir = path.dirname(permissionStoreFile(cfg.config, root))
      const realConfig = await fs.realpath(cfg.config)
      signal.throwIfAborted()
      const realRoot = await fs.realpath(root)
      signal.throwIfAborted()
      const realPolicy = await canonicalPath(policyDir)
      signal.throwIfAborted()
      if (
        realPolicy === realConfig ||
        !isInside(realConfig, realPolicy) ||
        isInside(realRoot, realConfig) ||
        isInside(realRoot, realPolicy)
      )
        return
      // Only this fixed, containment-validated store directory may be created;
      // neither config/project roots nor request-supplied paths are mkdir inputs.
      await fs.mkdir(realPolicy, { recursive: true, mode: 0o700 })
      signal.throwIfAborted()
      // Validate canonical containment, but bind the same raw paths as the TUI.
      return [cfg.config, policyDir, root]
    },
  })

  // First keying attempt at boot, so a healthy session logs its keying
  // immediately and the first permission event doesn't pay the probe latency.
  // `prime` applies to the CONFIG lookup only: resolveKeying's own boot attempt
  // deliberately spends its retry budget (see createStoreKeyingResolver), and
  // that asymmetry is the point — a throttled keying read still returns a
  // usable fallback, whereas a throttled config read pauses persistence
  // outright. Do not "harmonize" them. Silent either way: reporting belongs to
  // the hooks, which is where a pause is actually user-visible.
  void (async () => {
    if (!resolveKeying) return
    const cfg = await probeConfigDir({ prime: true })
    if ("error" in cfg) return
    await resolveKeying(cfg.config)
  })().catch(() => {})

  // Requests seen via permission.asked, so the replied event (which only
  // carries the request ID) can be resolved back to its patterns.
  const pending = new Map<string, Request>()
  // Requests this plugin answered itself, so their replied events are not
  // re-persisted and never answered twice.
  const autoReplied = new Set<string>()
  let warnedCorrupt = false
  const warnings = createWarnOnceLatch()

  // Session-scoped rulesets, fetched at most once per session before an
  // auto-approval and invalidated whenever the session changes. A session's
  // own ask/deny rules are deliberate overrides (see sessionOverrides) — the
  // store must not answer prompts they created.
  const sessionRules = new Map<string, Rule[]>()

  // Lookups currently in flight, one token each. The host launches event hooks
  // without awaiting the previous one (`void hook.event?.(…)` in its plugin
  // dispatcher), so a session.updated carrying a fresh ask/deny rule can land
  // while a session.get is still on the wire. Deleting the cache entry does not
  // reach that response: it was read BEFORE the update, and writing it back
  // would both auto-approve the in-flight prompt and leave the pre-update
  // ruleset cached until the next session change. Marking the token instead
  // makes the response fail closed with everything else here — one extra
  // interactive prompt, versus a stored allow answering a prompt a
  // session-scoped ask had just created. Bounded by concurrency, not by
  // session count: the finally always removes the token.
  const sessionRulesInflight = new Set<{ sessionID: string; stale: boolean }>()
  const invalidateSessionRules = (sessionID: string) => {
    sessionRules.delete(sessionID)
    for (const token of sessionRulesInflight)
      if (token.sessionID === sessionID) token.stale = true
  }

  // undefined = could not be determined; the caller must fail closed and
  // leave the prompt interactive. A client without session.get is not a shape
  // any supported host serves, but it is indistinguishable from a host whose
  // sessions carry ask/deny rules this plugin cannot see — so it fails closed
  // too. Returning [] there would assert "this session has no rules of its
  // own", and that claim is exactly what lets a stored allow answer a prompt a
  // session-scoped ask created.
  const resolveSessionRules = async (
    sessionID: string,
  ): Promise<Rule[] | undefined> => {
    const cached = sessionRules.get(sessionID)
    if (cached) return cached
    const sessionApi = (
      client as {
        session?: {
          get?: (
            options: unknown,
          ) => Promise<{ data?: unknown; error?: unknown }>
        }
      }
    ).session
    const get = sessionApi?.get?.bind(sessionApi)
    if (!get) {
      // Permanent for the process — the SDK client is one fixed object — so
      // warn once rather than at every prompt. warnOnce is declared below this
      // function; the call site lives in the returned hooks, which cannot run
      // until the factory body has finished initializing the closure.
      warnOnce(
        "no-session-api",
        "Auto-approval is paused: this OpenCode client exposes no session lookup, so a session's own ask/deny rules cannot be checked and a saved approval could override one. Prompts stay interactive; saving what you answer is unaffected.",
      )
      return undefined
    }
    const token = { sessionID, stale: false }
    sessionRulesInflight.add(token)
    try {
      const result = await get({
        path: { id: sessionID },
        query: { directory },
      })
      if (result?.error !== undefined && result?.error !== null)
        throw new Error(JSON.stringify(result.error))
      const rules = sessionRulesOf(result?.data)
      // The session changed while this was in flight, so these rules are known
      // to be out of date: neither cache them nor answer from them.
      if (token.stale) return undefined
      sessionRules.set(sessionID, rules)
      trim(sessionRules)
      return rules
    } catch (error) {
      log(
        "warn",
        `could not read session rules for ${sessionID}; leaving the prompt interactive: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    } finally {
      sessionRulesInflight.delete(token)
    }
  }

  // No attached TUI means the server log is the available surface.
  const toast = serverToast(client, { directory })

  // A pause cause outside the store pipeline (see resolveSessionRules): one
  // warning per distinct cause, or a client shape that cannot change would nag
  // on every single permission request.
  const warnOnce = (key: string, message: string) => {
    if (!warnings.warn(key)) return
    log("warn", message)
    toast("warning", message)
  }

  // The store-readiness pipeline both halves share (see ./shared). This half
  // supplies the two things that are genuinely its own: how a config directory
  // is obtained, and the fact that it is the ANNOUNCER — a server plugin has no
  // guaranteed TUI, so the log is the surface that always exists, and every
  // notice goes to both it and a toast. Recoveries and migration reports are
  // deliberately part of that: the TUI companion stays silent about them
  // precisely because this half speaks.
  const openStore = createStoreOpener({
    resolveKeying,
    configDir: async (access) => {
      const cfg = await probeConfigDir({ write: access.write })
      return "error" in cfg
        ? { unavailable: cfg.error }
        : { config: cfg.config }
    },
    announce: (notice) => {
      const problem = notice.kind === "paused" || notice.kind === "warning"
      log(
        problem ? "warn" : "info",
        notice.detail ? `${notice.message} (${notice.detail})` : notice.message,
      )
      toast(problem ? "warning" : "info", notice.message)
    },
  })

  // Corrupt-store errors are logged once until the file reads cleanly again.
  const readStoreAt = async (file: string): Promise<Store | undefined> => {
    const store = await readStoreFile(file, (error) => {
      if (warnedCorrupt) return
      warnedCorrupt = true
      log(
        "error",
        `ignoring unreadable ${file}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    if (store) warnedCorrupt = false
    return store
  }

  const readActiveStore = async (): Promise<
    { file: string; store: Store } | undefined
  > => {
    const ready = await openStore()
    if (!ready) return undefined
    const store = await readStoreAt(ready.file)
    return store ? { file: ready.file, store } : undefined
  }

  // The patterns worth remembering forever: the narrowest rules that still
  // cover this approval. An empty always-set means OpenCode itself would
  // remember nothing, so nothing is persisted either. A synthesized "*" (see
  // normalizeRequest) contributes nothing: no pattern information must not
  // persist as everything.
  const narrowest = (request: Request): string[] => {
    if (!request.always.length) return []
    return narrowestPatterns(
      request.always,
      request.synthesized ? [] : request.patterns,
    )
  }

  const persist = async (request: Request) => {
    const patterns = narrowest(request)
    if (!patterns.length) return
    // A write always re-attempts an unestablished keying: the "always" reply
    // is rare and user-initiated, and it is the moment a mis-keyed store
    // becomes durable state.
    const ready = await openStore({ write: true })
    if (!ready) return
    const file = ready.file
    let added: string[] | undefined
    try {
      // The read→merge→write sequence holds the cross-process store lock:
      // without it, another instance saving (or migrating a worktree store)
      // inside this window would be silently overwritten by the rename.
      added = await withStoreLock(
        file,
        async () => {
          const store = await readStoreAt(file)
          if (!store) return undefined
          // Skip patterns a broader rule provably covers — e.g. one the TUI
          // half wrote moments before this "always" reply landed — so the
          // store doesn't fill with redundant narrower entries. Sound
          // containment, never string matching: a stored "git ?" matches the
          // five-character STRING "git *" without covering it, and skipping on
          // that match would silently drop the approval. Patterns an ask/deny
          // carve-out overlaps are still appended: under last-rule-wins the
          // fresh allow overrides the earlier carve-out, matching what the
          // user just confirmed.
          const rules = rulesFrom(store)
          let changed = false
          const saved: string[] = []
          for (const pattern of patterns) {
            if (allowRuleRedundant(request.permission, pattern, rules)) continue
            changed =
              addAllowRule(store, request.permission, pattern) || changed
            saved.push(pattern)
          }
          if (!changed) return []
          await writeStore(file, store, OWNER_ONLY_WRITE_MODES)
          return saved
        },
        { modes: OWNER_ONLY_WRITE_MODES },
      )
    } catch (error) {
      // A user approval that cannot be saved (write failure, lock timeout)
      // must not take down the event pipeline — log it and leave the store
      // as it was.
      log(
        "error",
        `failed to save allow rule for "${request.permission}": ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    if (added?.length)
      log(
        "info",
        `saved allow rule for "${request.permission}": ${added.join(", ")}`,
      )
  }

  const autoReply = async (request: Request) => {
    const respond = (
      client as {
        postSessionIdPermissionsPermissionId?: (
          options: unknown,
        ) => Promise<{ error?: unknown }>
      }
    ).postSessionIdPermissionsPermissionId?.bind(client)
    if (!respond) {
      autoReplied.delete(request.id)
      automatedReplies().delete(request.id)
      log(
        "warn",
        "cannot auto-approve: SDK client has no permission reply method",
      )
      return
    }
    try {
      const result = await respond({
        path: { id: request.sessionID, permissionID: request.id },
        body: { response: "once" },
        query: { directory },
      })
      if (result?.error) throw new Error(JSON.stringify(result.error))
      log(
        "info",
        `auto-approved ("once") "${request.permission}" for: ${request.patterns.join(", ")}`,
      )
    } catch (error) {
      // Likely already answered by the user; the prompt stays interactive.
      autoReplied.delete(request.id)
      automatedReplies().delete(request.id)
      log(
        "warn",
        `auto-approve failed for ${request.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return {
    event: async ({ event }) => {
      if (
        event.type === "tui.command.execute" &&
        (await locality.handle(event))
      )
        return
      const { type, properties } = event as {
        type?: string
        properties?: unknown
      }

      // Session rules can change over a session's life (they are set through
      // the update API); drop the cached copy whenever the session does.
      if (type === "session.updated" || type === "session.deleted") {
        const props = (properties ?? {}) as Record<string, unknown>
        const info = props.info
        const infoID =
          info && typeof info === "object"
            ? (info as { id?: unknown }).id
            : undefined
        const id =
          typeof infoID === "string"
            ? infoID
            : typeof props.sessionID === "string"
              ? props.sessionID
              : undefined
        if (id) invalidateSessionRules(id)
        return
      }

      if (type === "permission.asked" || type === "permission.updated") {
        const request = normalizeRequest(properties)
        if (!request) return
        pending.set(request.id, request)
        trim(pending)
        if (autoReplied.has(request.id)) return
        const snapshot = await readActiveStore()
        if (!snapshot) return
        const rules = rulesFrom(snapshot.store)
        if (!isAllowed(request.permission, request.patterns, rules)) return
        // The store would approve — but an explicit session-scoped ask/deny
        // outranks it. Unknown session rules fail closed: better an extra
        // prompt than an approval a sandboxing plugin meant to forbid.
        const scoped = await resolveSessionRules(request.sessionID)
        if (
          !scoped ||
          sessionOverrides(request.permission, request.patterns, scoped)
        )
          return
        autoReplied.add(request.id)
        trim(autoReplied)
        // Registered in the suite-wide ledger BEFORE the POST: the host
        // publishes the replied event while the reply is still resolving,
        // and no sibling plugin may read this automatic answer as the user
        // being present (Approve for Me resets its unattended-deny budget
        // on exactly that signal).
        automatedReplies().add(request.id)
        trim(automatedReplies())
        await autoReply(request)
        return
      }

      if (type === "permission.replied") {
        const props = (properties ?? {}) as Record<string, unknown>
        const id = props.requestID ?? props.permissionID
        const reply = props.reply ?? props.response
        if (typeof id !== "string") return
        const request = pending.get(id)
        pending.delete(id)
        const wasAuto = autoReplied.delete(id)
        if (wasAuto || reply !== "always" || !request) return
        await persist(request)
      }
    },

    // Present for compatible 1.17 hosts that invoke the hook before prompting;
    // the event path remains the primary route on 1.17.15. Session-scoped
    // ask/deny rules are respected here too — this hook would otherwise
    // convert them to "allow" before any event is ever emitted.
    "permission.ask": async (input, output) => {
      const request = normalizeRequest(input)
      if (!request) return
      const snapshot = await readActiveStore()
      if (!snapshot) return
      if (
        !isAllowed(
          request.permission,
          request.patterns,
          rulesFrom(snapshot.store),
        )
      )
        return
      const scoped = await resolveSessionRules(request.sessionID)
      if (
        !scoped ||
        sessionOverrides(request.permission, request.patterns, scoped)
      )
        return
      output.status = "allow"
    },

    // The host tears plugin instances down per directory, not only at exit, so
    // a probe still on the wire outlives the hooks that could ever use it.
    // Nothing else here holds a resource: timers are cleared where they are
    // created, and the store lock is released inside withStoreLock.
    dispose: async () => {
      disposeController.abort()
      await locality.dispose()
    },
  }
}

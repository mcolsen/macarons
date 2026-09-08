/**
 * opencode-persist-permissions — shared core
 *
 * The store shape, wildcard matching, rule evaluation, version guard, and
 * store I/O used by both halves of the plugin — the server half
 * (src/index.ts) and the TUI companion (src/tui.tsx) — now live in the
 * monorepo's @macarons/permission-rules library, shared with
 * approve-for-me. This module re-exports them (plus this plugin's own
 * store constants) so both halves keep a single import site and the two
 * plugins cannot drift apart. The engine's behavior spec still lives in this
 * package (test/matching-spec.test.ts) and runs through these re-exports.
 *
 * What the library cannot own is this plugin's persistence POLICY — when a
 * store may be used at all, and what the user is told when it may not. That is
 * the store-readiness pipeline at the bottom of this file: plugin-local by the
 * rule in libraries/README.md, but shared by both halves so the two cannot
 * answer that question differently.
 *
 * OpenCode loads configured plugins with a plain dynamic import (server
 * plugins from opencode.json, TUI plugins from tui.json), so this import
 * resolves through the monorepo's workspace install for every install method
 * except one: copying a file into `.opencode/plugin/`. That directory loads
 * every top-level file as its own plugin module — bare imports break, and any
 * stray export is called as a plugin. For that install path, `bun run build`
 * bundles the server half together with the library into a single
 * self-contained file (dist/persist-permissions.js). Nothing here may be
 * re-exported from either entrypoint: the server loader calls every export of
 * src/index.ts as a plugin function, and the TUI loader reads only the default
 * export of src/tui.tsx (see test/packaging.test.ts).
 */

import {
  createWarnOnceLatch,
  migrateStores,
  PERMISSIONS_STORE_BASENAME,
  type PermissionStorePaths,
  pathExists,
  type StoreKeyingResolver,
  storeMigrationCandidates,
} from "@macarons/permission-rules"

export type {
  Action,
  ExecRunner,
  PermissionAsk,
  PermissionStorePaths,
  Rule,
  Store,
  StoreKeying,
  StoreKeyingResolver,
  StoreMigration,
  StoreScope,
  StoresMigration,
} from "@macarons/permission-rules"
export {
  addAllowRule,
  allowRuleRedundant,
  appLogger,
  automatedReplies,
  createStoreKeyingResolver,
  createWarnOnceLatch,
  discoverPrimaryRoot,
  discoverWorktreeRoot,
  evaluate,
  expandHome,
  isAllowed,
  isStoreScope,
  isSubAgentSession,
  keybindOption,
  legacyPermissionStoreFile,
  migrateStores,
  migrateWorktreeStore,
  narrowestPatterns,
  normalizeRequest,
  notePromptSession,
  OWNER_ONLY_WRITE_MODES,
  openCodeCompatNotice,
  pathExists,
  patternSubsumes,
  patternsOverlap,
  permissionStoreFile,
  preSlugPermissionStoreFile,
  probeOpenCodeVersion,
  promptSessionFamily,
  readStore,
  reportServerCompat,
  reportTuiCompat,
  resolvePermissionStorePaths,
  resolveScopeOption,
  routeSessionID,
  rulesFrom,
  runGitCommand,
  SUPPORTED_OPENCODE_RANGE,
  serverToast,
  sessionOverrides,
  sessionRulesOf,
  storeMigrationCandidates,
  toStringArray,
  trim,
  tuiGate,
  tuiToast,
  unsupportedVersionHooks,
  warnTui,
  wildcardMatch,
  withStoreLock,
  withTimeout,
  writeStore,
} from "@macarons/permission-rules"

// Re-exported from the library because the basename is a contract with
// approve-for-me, which reads this plugin's store for its rule vetoes.
export const STORE_BASENAME = PERMISSIONS_STORE_BASENAME

// ---------------------------------------------------------------------------
// Store readiness
//
// Getting from "something wants the store" to "here is the file this access
// may use" is one fixed sequence: resolve OpenCode's config directory, key the
// store by the right root, refuse a path that is not trusted, refuse to ANSWER
// prompts from a fallback store while the repository's real one is
// unreachable, refuse a legacy in-project store the trusted one has not
// replaced yet, and only then fold in every store this session no longer keys
// by. Every step can pause persistence; every pause is reported once per cause
// and reports its own recovery when the cause clears, because most of these
// clear on their own and "persistence is paused" must not stay the last thing
// the user heard.
//
// The last two are in that order on purpose, and swapping them back is a
// security regression, not a refactor: the fold WRITES the trusted store into
// existence out of a migration candidate, which answers the legacy gate on the
// legacy store's behalf and lets an allow-only store auto-approve past a
// carve-out nobody was ever asked to review. The argument is spelled out at
// the call site.
//
// Both halves ran their own copy of that sequence, and the copies had already
// drifted: the server grew the fail-closed `unkeyedShared` read gate, the TUI
// grew the `explicit` re-report flag, and three pauses (untrusted path, legacy
// store, invalid scope) were worded differently at each half. One pipeline now,
// with one message catalog. What genuinely
// differs between the halves stays with the halves, injected here:
//
//   - WHERE the config directory comes from. The server asks the SDK (/path,
//     with its own timeout, shared in-flight probe and 15s read throttle); the
//     TUI reads the host's reactive api.state.path, which is empty until the
//     host's sync lands and needs none of that. Neither mechanism is absorbed
//     here: this pipeline takes their ANSWER ("here is a config dir" / "here is
//     why there isn't one") and owns everything after it.
//   - WHO speaks. The server half logs and toasts everything, including
//     recoveries and migration reports. The TUI half toasts pause causes only:
//     both halves render into the same TUI, so two voices announcing one
//     migration read as two migrations.
// ---------------------------------------------------------------------------

/** How an access intends to use the store. */
export type StoreAccess = {
  /**
   * A save is imminent. An unestablished keying is re-derived rather than
   * reused (see createStoreKeyingResolver) — an "always" reply is rare,
   * user-initiated, and the moment a mis-keyed store becomes durable state —
   * and the fail-closed read gate below does not apply: writing to a narrower
   * fallback store is safe, answering prompts from it is not.
   */
  write?: boolean
  /**
   * A user asked for this (the TUI's edit command). Passive accesses report a
   * cause once until it clears, so a burst of prompts cannot stack duplicate
   * toasts; an explicit access re-reports a cause that is still outstanding,
   * because silence in answer to a keystroke reads as "nothing happened".
   * Orthogonal to `write` on purpose: the server saves without ever wanting a
   * re-report, and the two axes must not be conflated just because the TUI's
   * one caller passes both.
   */
  explicit?: boolean
}

/** The store an access may use, and how far it reaches. */
export type OpenedStore = {
  file: string
  /**
   * True when `file` is the repository-shared store, so a rule saved into it
   * applies in every worktree — the difference a user hunting for a missing
   * rule needs to see, and the reason this pipeline returns a record rather
   * than a path.
   */
  shared: boolean
}

/** Something the pipeline wants the user told about. */
export type StoreNotice = {
  /** The cause. Also the warn-once key, so recoveries pair with their pause. */
  key: string
  /**
   * "paused"  — this access failed; nothing may be read or written.
   * "warning" — a problem worth reporting that did NOT pause the access.
   * "resumed" — a cause that had been reported has cleared.
   * "info"    — the pipeline changed something the user should know about.
   */
  kind: "paused" | "warning" | "resumed" | "info"
  message: string
  /** Context for a log line only; never part of the user-facing message. */
  detail?: string
}

/** Where the config directory comes from, or the reason there isn't one. */
export type ConfigDir = { config: string } | { unavailable: string }

/**
 * Answered per access, never memoized here: the server half's probe throttles
 * and retries its own way, and the TUI half's host path state can land at any
 * moment. Either shape may answer synchronously.
 */
export type ConfigDirLookup = (
  access: StoreAccess,
) => ConfigDir | Promise<ConfigDir>

export type StoreOpener = (
  access?: StoreAccess,
) => Promise<OpenedStore | undefined>

/** One worktree-store fold: whether the store may be used, and why not. */
type MigrationPass = {
  ok: boolean
  /** The pass is not finished — never memoize it (see ensureMigrated). */
  retry: boolean
  /** Set whenever `ok` is false; reported by the caller, per access. */
  pause?: { key: string; message: string }
  /**
   * The pass finished, but left something worth saying. Handed back for the
   * same reason `pause` is: it is reported per ACCESS, so an explicit access
   * re-hears it and one joining an in-flight pass hears it at all.
   */
  warning?: { key: string; message: string }
}

/**
 * The store-readiness pipeline both halves run.
 *
 * `resolveKeying` is undefined only when the `scope` option was invalid, which
 * pauses every access: guessing a scope is what would let a typo'd half
 * migrate away — and delete — the store the correctly-configured half is
 * using (see each half's option parsing).
 */
export function createStoreOpener(input: {
  resolveKeying: StoreKeyingResolver | undefined
  configDir: ConfigDirLookup
  announce: (notice: StoreNotice) => void
}): StoreOpener {
  const { resolveKeying, configDir, announce } = input
  const warnings = createWarnOnceLatch()

  // A cause that stops (or complicates) this access. Latched per cause; an
  // explicit access re-reports one that is still outstanding.
  const report = (
    access: StoreAccess,
    notice: { key: string; kind: "paused" | "warning"; message: string },
  ) => {
    const fresh = warnings.warn(notice.key)
    if (!fresh && access.explicit !== true) return
    announce(notice)
  }

  // Clearing a pause key re-arms its warning, but that is bookkeeping the user
  // cannot see: the last thing they were told is still "persistence is
  // paused", and the causes here clear on their own — a host that had not
  // finished starting answers the very next probe, and a WRITE re-probes
  // immediately rather than waiting out a read throttle. So a read can pause,
  // warn, and have the write that follows it on the same event succeed a
  // moment later, leaving a correct store behind a stale warning. (The TUI
  // companion's save toast cannot be relied on to correct it: its confirmation
  // budget is a deadline, and a probe that had to time out first can outlast
  // it.) Report the recovery instead, once per episode — `resolve` returning
  // false means no warning was outstanding, so a healthy path stays silent.
  const resumed = (key: string, message: string) => {
    if (!warnings.resolve(key)) return
    announce({ key, kind: "resumed", message })
  }

  // How far a rule in the destination store actually reaches, in the same
  // vocabulary the halves already use to word a save (see the TUI's
  // storeLabel). The fold is NOT repository-only: it also runs under scope
  // "worktree" — where an unestablished boot keyed by the session directory
  // and the re-key leaves that store behind as a stale candidate — and under
  // the repository-scope write fallback below, where a save is let through
  // with `shared: false` precisely because the shared store is unreachable.
  // Announcing either of those as "repository-wide" tells the user their
  // approval travels between worktrees when it does not.
  const reachOf = (shared: boolean) =>
    shared
      ? {
          store: "the repository-wide permission store",
          applies: "they now apply in every worktree",
        }
      : {
          store: "this project's permission store",
          applies: "they apply in this checkout only",
        }

  // Fold every store this session is not keyed by any more into the active
  // one: the store keyed by this worktree's own root (written before
  // repository scope existed, or under scope: "worktree") and any store an
  // earlier, unestablished keying fell back to (see createStoreKeyingResolver
  // — a boot without git keys by the session DIRECTORY, which a later re-key
  // would otherwise orphan). Memoized only when the pass fully settled AND the
  // resolved paths no longer name a candidate at all: manual/error outcomes —
  // and a merge whose source file could not be deleted yet — re-check on the
  // next access, so deleting the reported file (or the removal finally
  // succeeding) unpauses without a restart, and a named candidate is re-checked
  // because a candidate that does not exist YET can still be created after the
  // pass settles. A write is handed its store file and returns to its caller
  // before the lock and the write itself, so a save keyed by an earlier
  // fallback can land on disk after the pass that would have folded it in
  // already completed; memoizing that pass strands the approval — durable on
  // disk, invisible to the active store — for the rest of the process lifetime.
  // Re-checking costs one stat per named candidate — and since the resolved
  // paths always name the pre-slug (bare-hash) store names so a file an older
  // release recreates there is folded in rather than silently shadowed, the
  // memo never latches and every access pays those stats. Concurrent callers
  // still share one in-flight pass; a duplicated pass after a cleared memo is
  // harmless (the merge is idempotent, cross-process-locked, and writes
  // atomically).
  //
  // The pass announces the one thing that is true once and only once — that it
  // MOVED rules — but hands its pause and its warning back to the caller, to
  // be reported per ACCESS: an explicit access re-hears a cause that is still
  // outstanding, and an access that merely joined a pass a passive one started
  // hears it at all. Latching those inside the pass would deny both.
  let migration: Promise<MigrationPass> | undefined
  let migrationStore: string | undefined
  const ensureMigrated = (
    paths: PermissionStorePaths,
    shared: boolean,
  ): Promise<MigrationPass> => {
    // A late re-key (see createStoreKeyingResolver) changes the active store:
    // the fold must run again against the NEW shared store — it is what pulls
    // this worktree's interim fallback-keyed saves in. A dropped in-flight
    // pass for the old store is harmless: the merge is idempotent,
    // cross-process-locked, and writes atomically.
    if (migrationStore !== paths.storeFile) {
      migration = undefined
      migrationStore = paths.storeFile
    }
    if (migration) return migration
    const reach = reachOf(shared)
    const pass: Promise<MigrationPass> = (async () => {
      const result = await migrateStores(paths)
      if (result.moved > 0)
        announce({
          key: "worktree-store-moved",
          kind: "info",
          message: `Moved ${result.moved} saved approval(s) from a permission store this session no longer uses into ${reach.store} — ${reach.applies}.`,
          detail: paths.storeFile,
        })
      if (!result.ok)
        return {
          ok: false,
          retry: true,
          pause:
            result.kind === "manual"
              ? {
                  key: "worktree-store-migration",
                  message: `Permission persistence is paused for this worktree: ${result.reason}, and rules like that cannot be merged into ${reach.store} automatically. Review it, copy what you still want into ${paths.storeFile}, then delete it.`,
                }
              : {
                  key: "worktree-store-migration-error",
                  message: `Permission persistence is paused: ${result.reason}.`,
                },
        }
      // A paused pass re-runs on the next access, so the user merging the file
      // by hand (or deleting it) unpauses without a restart — and that
      // recovery is only visible if it is reported.
      resumed(
        "worktree-store-migration",
        "Permission persistence resumed: the permission store this session no longer uses was merged in.",
      )
      resumed(
        "worktree-store-migration-error",
        "Permission persistence resumed: the store migration completed.",
      )
      if (result.unremoved)
        // The destination store is complete, so persistence keeps working —
        // but the pass is not finished until the stale source is really gone.
        return {
          ok: true,
          retry: result.retry,
          warning: {
            key: "worktree-store-removal",
            message: `Moved the saved approvals into ${reach.store}, but the old file could not be deleted (${result.unremoved}); removal will be retried.`,
          },
        }
      resumed(
        "worktree-store-removal",
        "The old permission store was removed; the migration is complete.",
      )
      return { ok: true, retry: result.retry }
    })().then(
      (outcome) => {
        if (outcome.retry || storeMigrationCandidates(paths).length > 0)
          retire()
        return outcome
      },
      (error) => {
        retire()
        throw error
      },
    )
    // Only the pass that settled may retire itself. A re-key between this
    // assignment and that settle installs a pass for the NEW store, and an
    // unconditional `migration = undefined` here would drop it on the floor —
    // leaving the next access to start a third pass racing a live second one.
    // Rare before, but the candidate rule above clears the memo on every pass
    // that names one, so it would no longer be.
    const retire = () => {
      if (migration === pass) migration = undefined
    }
    migration = pass
    return pass
  }

  return async (access = {}) => {
    if (!resolveKeying) {
      report(access, {
        key: "invalid-scope",
        kind: "paused",
        message:
          'Permission persistence is paused: the "scope" plugin option is invalid — set it to "repository" or "worktree".',
      })
      return undefined
    }
    const located = await configDir(access)
    if ("unavailable" in located) {
      // Its own key, not the "unsafe-path" one below: the two causes have
      // different messages and different fixes, and sharing a key let
      // whichever fired first swallow the other's toast.
      report(access, {
        key: "config-path",
        kind: "paused",
        message: `Permission persistence is paused: ${located.unavailable}.`,
      })
      return undefined
    }
    // Cleared as soon as its gate passes, like every other cause here, so a
    // recurrence warns anew — and so a "paused" toast for a transient failure
    // that has since self-healed is not the last word the user heard.
    resumed(
      "config-path",
      "Permission persistence resumed: the config directory resolved.",
    )
    const keying = await resolveKeying(located.config, {
      write: access.write === true,
    })
    if (!keying) {
      report(access, {
        key: "unsafe-path",
        kind: "paused",
        message:
          "Permission persistence is paused: the derived permission-store path is not trusted outside the project.",
      })
      return undefined
    }
    resumed(
      "unsafe-path",
      "Permission persistence resumed: the permission-store path is trusted again.",
    )
    if (keying.unkeyedShared) {
      // Git confirms a work tree here, but the repository-shared store could
      // not be located, so `keying` is the worktree-keyed fallback. Writing
      // there is safe — it shares less, and a later re-key folds it in — but
      // ANSWERING a prompt from it is not: the shared store is an independent
      // last-match-wins ruleset, and an allow in the fallback would
      // auto-approve straight through an ask/deny carve-out the user wrote
      // into the store this session cannot currently reach. Reads fail closed
      // until the shared keying is established; the prompt simply stays
      // interactive. A write passes, but it does NOT clear the warning: the
      // shared store is still unlocated, and reporting "resumed" off the back
      // of an access that never needed it would be a claim about git that
      // nothing here established.
      if (!access.write) {
        report(access, {
          key: "unkeyed-shared",
          kind: "paused",
          message:
            "Auto-approval is paused: this repository's shared permission store could not be located, so saved rules cannot be applied without risking a carve-out in it. Prompts stay interactive until git resolves the repository's primary worktree.",
        })
        return undefined
      }
    } else {
      resumed(
        "unkeyed-shared",
        "Auto-approval resumed: this repository's shared permission store was located.",
      )
    }
    const paths = keying.paths
    // BEFORE the fold, and on purpose. The legacy gate asks whether the
    // agent-writable in-project store has a trusted replacement yet, and the
    // fold can CREATE that replacement: migrateStores writes the destination
    // into existence from a candidate (a missing destination reads as an empty
    // store — see readStore's onMissing). Run the fold first and a pure-allow
    // candidate satisfies the gate on the legacy store's behalf: the check
    // downstream sees both files present, stays quiet, and hands back a store
    // whose allow rules can auto-approve straight past an ask/deny carve-out
    // the user wrote into the legacy file and was never asked to review. The
    // gate has to be answered from the state the access ARRIVED in.
    const [legacyExists, trustedExists] = await Promise.all([
      pathExists(paths.legacyStoreFile),
      pathExists(paths.storeFile),
    ])
    if (legacyExists === undefined || trustedExists === undefined) {
      report(access, {
        key: "unreadable-path",
        kind: "paused",
        message:
          "Permission persistence is paused: a permission-store path is unreadable.",
      })
      return undefined
    }
    resumed(
      "unreadable-path",
      "Permission persistence resumed: the permission-store paths are readable again.",
    )
    if (legacyExists && !trustedExists) {
      report(access, {
        key: "migration-required",
        kind: "paused",
        message: `Permission persistence is paused: ${paths.legacyStoreFile} is agent-writable and is no longer trusted. Review it and recreate the complete store at ${paths.storeFile}.`,
      })
      return undefined
    }
    resumed(
      "migration-required",
      "Permission persistence resumed: the trusted permission store is in place.",
    )
    const migrated = await ensureMigrated(paths, keying.shared)
    if (!migrated.ok) {
      if (migrated.pause) report(access, { ...migrated.pause, kind: "paused" })
      return undefined
    }
    if (migrated.warning)
      report(access, { ...migrated.warning, kind: "warning" })
    return { file: paths.storeFile, shared: keying.shared }
  }
}

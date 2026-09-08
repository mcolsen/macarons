import os from "node:os"
import { openCodeDataDir } from "@macarons/permission-rules"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import {
  hostConfigRoot,
  legacyProjectSettingsFile,
  ownPackageDir,
  parseModelRef,
  readActivity,
  readEffectiveSettings,
  readTrustedSessionModel,
  requestInstanceID,
  resolveTrustedSettingsPaths,
  type TrustedSettingsPaths,
} from "./shared"

/**
 * opencode-approve-for-me — the sibling-plugin interop surface.
 *
 * This module is the ONE deliberate cross-plugin API in the suite: the
 * limits sidebars ask "which provider does the active classifier spend
 * quota on right now?", so its limits can sit next to the coding model's.
 * Everything else in this package — settings schema, file layout, trust-path
 * resolution — is an internal that may change shape between releases, which
 * is exactly what happened when global settings moved onto the opencode.jsonc
 * plugin entry (PR #139) and an out-of-package copy of the old pipeline kept
 * reading the retired file. The repo guard
 * (tests/repo/test/cross-plugin-imports.test.ts) therefore pins sibling
 * plugins to THIS entrypoint: a new cross-plugin import anywhere else fails
 * loudly until it is reviewed into the allowlist.
 *
 * The answer is computed the way this plugin computes it for itself —
 * resolveTrustedSettingsPaths and the readEffectiveSettings chain shared with
 * the server half's own out-of-band readers — so the two plugins can never
 * disagree about whether the classifier is on. The rules, verbatim from that
 * chain:
 *
 *   - the trusted paths resolve (an untrusted layout disables approve-for-me
 *     itself, so it must yield no answer here either),
 *   - no fail-closed gate trips (legacy or pre-upgrade settings files,
 *     unreadable layers, an unblessed worktree config),
 *   - approval is effectively on (the instance toggle wins over the settings
 *     default),
 *   - and the root session's override record pins a classifier, or its record
 *     is absent/inherit and persistent settings pin one. An explicit session
 *     model override follows the asking session, whose limits a sidebar
 *     already shows.
 *
 * Settings alone prove only "configured on" — a leftover settings file with
 * the server half uninstalled, or a pinned model this instance cannot
 * provide, still reads as configured. Whether anything is actually
 * classifying is the server half's own claim: its activity beacon
 * (shared.ts, ServerStatus) reads "ready" from startup until an
 * instance-wide fault pauses it, and is cleared on dispose. The beacon
 * gates the answer here exactly as it gates the approve-for-me sidebar's
 * own status line, so the two sidebars tell the same story.
 *
 * Anything else — approve-for-me not installed, toggled off, paused,
 * unreadable — resolves to undefined. Fail closed, never guess.
 */

export type ClassifierProvider = {
  id: string
  models: Record<string, { variants?: Record<string, unknown> }>
}

export type ClassifierConfig = {
  /** The provider the ACTIVE classifier is pinned to right now, or undefined
   *  when no distinct, active classifier exists. Re-read per call: settings,
   *  the instance toggle, and the server beacon all change live. */
  providerID: (input: {
    rootSessionID: string
    providers: readonly ClassifierProvider[]
  }) => Promise<string | undefined>
}

/**
 * Resolve an interop handle against the host's path fields. The owning server
 * UUID is deliberately discovered inside each providerID call: a TUI may load
 * before its server half or reconnect to a replacement server without itself
 * restarting. Trusted paths are cached only under the UUID that owns their
 * ephemeral override and activity files.
 *
 * `worktree` is the host's RAW worktree field — "" and "/" are its non-git
 * sentinels. The project root and the config-discovery boundary are derived
 * here, not by the caller, so this plugin's own derivations (root falls back
 * to the instance directory; non-git config scans reach "/", exactly the
 * host's upward search) can never be re-implemented differently outside it.
 */
export async function resolveClassifierConfig(input: {
  api: Pick<TuiPluginApi, "client" | "event" | "lifecycle" | "state">
  /** The instance directory (api.state.path.directory). */
  directory: string
  /** The host's raw worktree field (api.state.path.worktree), if any. */
  worktree: string | undefined
  configDir: string
  stateDir: string
}): Promise<ClassifierConfig | undefined> {
  const projectRoot =
    input.worktree && input.worktree !== "/" ? input.worktree : input.directory
  const configRoot = hostConfigRoot(input.worktree || undefined)
  const packageDir = await ownPackageDir()
  const trustedByInstance = new Map<
    string,
    Promise<TrustedSettingsPaths | undefined>
  >()
  return {
    providerID: async ({ rootSessionID, providers }) => {
      // Never let a broken layer escape into the caller's poll loop: an
      // unanswerable question IS the fail-closed answer.
      try {
        const instanceID = await requestInstanceID(input.api)
        if (!instanceID) return undefined
        let trustedPromise = trustedByInstance.get(instanceID)
        if (!trustedPromise) {
          trustedPromise = resolveTrustedSettingsPaths(
            projectRoot,
            input.configDir,
            input.stateDir,
            openCodeDataDir(process.env, os.homedir()),
            instanceID,
          )
          trustedByInstance.set(instanceID, trustedPromise)
          // Keep at most eight owners across reconnects. In-flight calls retain
          // their own promise even if another owner evicts its cache entry.
          if (trustedByInstance.size > 8) {
            const oldest = trustedByInstance.keys().next().value
            if (oldest) trustedByInstance.delete(oldest)
          }
        }
        const trusted = await trustedPromise
        if (!trusted) return undefined
        const state = await readEffectiveSettings({
          paths: trusted,
          legacyProjectFile: legacyProjectSettingsFile(trusted.projectRoot),
          directory: input.directory,
          configRoot,
          packageDir,
        })
        if (!state) return undefined
        const sessionModel = await readTrustedSessionModel(
          trusted.sessionModelsDir,
          rootSessionID,
        )
        if (sessionModel.status === "invalid") return undefined
        const settings =
          sessionModel.status === "valid" &&
          sessionModel.record.mode === "override"
            ? {
                model: sessionModel.record.model,
                variant: sessionModel.record.variant,
              }
            : state.settings
        // An explicit null override follows the asking session at its default
        // variant, so it never earns a second quota section.
        if (!settings.model) return undefined
        const model = parseModelRef(settings.model)
        if (!model) return undefined
        const entry = providers.find(
          (provider) => provider.id === model.providerID,
        )?.models[model.modelID]
        if (!entry) return undefined
        if (
          settings.variant &&
          (!entry.variants || !Object.hasOwn(entry.variants, settings.variant))
        )
          return undefined
        // Settings say "on"; only the server half's beacon says "running and
        // unpaused". No beacon (absent, disposed, unreadable) or a paused one
        // means nothing is spending quota, however the settings read.
        const activity = await readActivity(trusted.activityPath)
        if (activity?.server?.state !== "ready") return undefined
        return model.providerID
      } catch {
        return undefined
      }
    },
  }
}

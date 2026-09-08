import { randomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  appLogger,
  automatedReplies,
  createFilesystemLocalityResponder,
  createSerialQueue,
  createWarnOnceLatch,
  discoverPrimaryRoot,
  discoverWorktreeRoot,
  isAllowed,
  narrowestPatterns,
  normalizeRequest,
  openCodeDataDir,
  type PermissionAsk,
  pathExists,
  type Rule,
  readStore,
  reportServerCompat,
  resolvePermissionStorePaths,
  rulesFrom,
  runGitCommand,
  type Store,
  serverToast,
  stableStringify,
  trim,
  unsupportedVersionHooks,
  withTimeout,
} from "@macarons/permission-rules"
import type { Plugin } from "@opencode-ai/plugin"
import { batchKeyOf, createBatchScheduler } from "./server/batch-scheduler"
import { createClassifierPipeline } from "./server/classifier"
import { createHostAdapter, createHostReadCoalescer } from "./server/host"
import { createConcurrencyPool } from "./server/pool"
import {
  ACTIVITY_REASON_MAX,
  type ActivityEntry,
  type ActivityFile,
  type ActivityState,
  CLASSIFIER_SYSTEM_PROMPT,
  clearActivity,
  clearOverride,
  clearTrustedSessionModel,
  clearTrustedSessionModelIfUnchanged,
  type EffectiveSettings,
  emptyApprovals,
  enforcedDecision,
  explicitCarveOut,
  formatModelRef,
  hostConfigRoot,
  legacyProjectSettingsFile,
  listTrustedSessionModels,
  type ModelRef,
  ownPackageDir,
  type PolicyFault,
  parseModelRef,
  parseRuleArray,
  projectConfigDisabled,
  pruneActivity,
  type ResolvedSettings,
  type RiskLevel,
  readApprovalsJournal,
  readBlessing,
  readEffectiveSettings,
  readOverride,
  readPolicySnapshot,
  readTrustedSessionModel,
  recordApproval,
  resolveReservedPath,
  resolveSettings,
  resolveTrustedSettingsPaths,
  respondInstanceRequest,
  SERVICE,
  SESSION_ANCESTRY_HOP_LIMIT,
  type ServerStatus,
  type SessionModelReadResult,
  STORAGE_SERVICE,
  scanSideloadSources,
  scanWorktreeConfig,
  sessionModelCapability,
  storeCarveOut,
  TOOL_CATALOG,
  truncate,
  UNATTENDED_DENY_LIMIT,
  unblessedSideloads,
  type Verdict,
  writeActivity,
  writeApprovalsJournal,
} from "./shared"
import { settingsLocalityPaths } from "./shared/config-policy"

/**
 * opencode-approve-for-me — server half
 *
 * Auto-approves permission prompts that a classifier model judges safe, and
 * leaves everything else for the user — OpenCode's version of Codex's
 * "Approve for me". On every `permission.asked` event the plugin:
 *
 *   1. Checks that Approve for Me is on: the merged settings say enabled, no
 *      instance-scoped toggle override says otherwise, and the permission
 *      type is not opted out. Settings merge field-wise from three sources
 *      (see shared.ts readPolicySnapshot): this plugin's entry options in the
 *      global opencode.json[c] — read from DISK, never from the host-passed
 *      options object, which carries no provenance — under blessed worktree
 *      config (honored only while its exact bytes match the user-recorded
 *      blessing; anything else pauses), under the project-keyed file in the
 *      trusted config directory. An agent with project edit access can WRITE
 *      worktree config, but nothing it writes takes effect before the user
 *      reviews and re-blesses it — it must not be able to reconfigure the
 *      judge that approves its own actions.
 *   2. Applies the user's explicit rules first, against the same ruleset
 *      OpenCode itself evaluated: the requesting session's active agent
 *      (tracked from its user messages) resolved through /agent, merged with
 *      the session's own `permission` rules. A non-blanket ask/deny rule
 *      winning in that effective ruleset or in the merged config `permission`
 *      block vetoes classification outright, and so does ANY matching
 *      non-allow rule — blanket included — in persist-permissions' trusted
 *      project store, which no host rule evaluation ever enforces.
 *      If the active agent or either ruleset cannot be established, approval
 *      pauses: classifying with weaker rules than the host applied could
 *      approve through a deliberate agent- or session-level carve-out.
 *      Requests the store already allows are skipped too, deferring to
 *      persist-permissions' own auto-approval.
 *   3. Asks the classifier model. The request (tool, patterns, title,
 *      metadata) plus a bounded window of the root session's user-authored
 *      messages and the requesting session's tool-call titles — never tool
 *      outputs or assistant prose, the prime injection vectors — are sent
 *      to a throwaway OpenCode session created with a deny-everything
 *      permission ruleset and all tools disabled. Its inherited OpenCode
 *      system stream is replaced with the fixed classifier policy; project
 *      guidance is passed only as labeled, untrusted user data. The model is
 *      prompted with a JSON-schema verdict format and defaults to whatever
 *      model the triggering
 *      session is currently using; a settings `model` pins it, and a settings
 *      `variant` pins its effort level (OpenCode's model variants). A variant
 *      the judge model does not define pauses auto-approval — the host would
 *      silently ignore it and judge at default effort otherwise.
 *   4. Acts on the verdict. The model reports a risk level and how clearly
 *      the user authorized the action; the approve/surface policy over those
 *      axes (shared.ts matrixDecision) is enforced HERE in code — the model's
 *      own "decision" can only veto toward surfacing, never approve past the
 *      matrix. An approval answers the prompt with "once" — NEVER "always",
 *      so a classifier decision can never grant OpenCode's session-wide
 *      in-memory blanket, and persist-permissions (which only persists
 *      "always" replies) can never write it to disk. "surface", any error, a
 *      timeout, or an unparseable verdict (including one missing either axis)
 *      all leave the prompt exactly as it was: fail closed, the user decides.
 *
 * The classifier's own sessions are tracked and never classified (no
 * recursion), and they are deleted after each verdict. Scheduling is
 * BATCH-PARALLEL, RELEASE-SERIAL per prompt tree (a root session plus its
 * sub-agent descendants). A batch is the set of prompts raised by ONE
 * assistant turn's tool calls — they share the turn's message id in the
 * permission event's tool pointer, and they are the calls the model issued
 * together, so judging them together approves nothing the turn's author has
 * not already committed to. The default `processing: "parallel"` judges the
 * top-of-stack batch concurrently (bounded by the `maxConcurrent` slot
 * pool); batches never interleave — the next batch is judged only once every
 * prompt of the previous one has settled — so bursts from different turns or
 * different sub-agents drain batch by batch, FIFO within a session.
 * Approvals are always RELEASED strictly one at a time in exactly the order
 * the host TUI presents prompts (sessions by id ascending, requests by id
 * ascending within a session): a verdict that lands beneath an undecided
 * prompt PARKS until everything above it settles, and a prompt the
 * classifier leaves for the user (surfaced, vetoed, failed — anything but an
 * accepted approval) HOLDS its stack position: nothing below it is judged
 * until the user answers it, so no action is ever auto-approved past a
 * prompt the user has not decided. `processing: "serial"` opts back into
 * judging strictly one prompt at a time per tree — same invariants, plus no
 * model call is ever spent on a prompt a deny cascade then kills (parallel
 * risks the in-flight remainder of the current batch), at the cost of burst
 * throughput. Prompts without a tool pointer are conservatively their own
 * batch of one. Prompts a user answers while queued are settled by that
 * answer alone and never cost a model call. Independent trees always
 * classify concurrently, bounded by the same slot pool (settings
 * `maxConcurrent`, default 4). Settings are re-read on every request, so the
 * TUI companion's toggle and model picker take effect immediately.
 *
 * A sweeper cleans up after aborted runs: on the pinned hosts, aborting a
 * session kills its tool calls but leaks their pending permission prompts —
 * no permission.replied is ever published, the orphans sit in /permission
 * (and every TUI's prompt stack) forever, answering them approves nothing,
 * and a later reject CASCADES onto live prompts of the session's next turn.
 * When a session settles (idle) with prompts still pending and EVERY one of
 * them verifiably belongs to a dead tool call (its tool part is in a
 * terminal state), the sweeper rejects one — the host's own same-session
 * cascade clears the rest — after re-checking the session is still idle.
 * Reject and never approve: rejecting a dead prompt grants nothing, and a
 * session with even one live or unverifiable prompt is never touched.
 * Disabled with the plugin toggle or `sweepStale: false`.
 *
 * An unattended-deny timer keeps a surfaced prompt from holding an
 * unattended session hostage: a prompt the classifier surfaced or failed on
 * (never one the user's own rules or opt-outs reserved) that stays
 * unanswered for `unattendedDenyMs` is rejected with a message explaining
 * the automated timeout — a reject with a message resolves the tool call as
 * PermissionCorrectedError on the pinned hosts, which does not end the turn,
 * so the agent can route around the denied action. Reject and never approve,
 * like the sweeper; three timed denies per prompt tree without a user answer
 * in between disarm the timer for that tree. The instance-scoped activity file carries the
 * per-request annotations for the sidebar stream plus a ready/paused server
 * beacon, so the sidebar reports this half's actual state — running, and not
 * stopped by an instance-wide fault — rather than just what the settings
 * files say. Each accepted approval is also aggregated into the durable,
 * project-keyed approvals journal under the state directory (narrowest
 * persistent pattern, counts, risk grades) — advisory evidence for the
 * enshrine-approvals skill; no approval decision ever reads it back. The
 * plugin registers no agent-callable tools, and repository instructions
 * cannot alter the classifier's system policy.
 *
 * Targets OpenCode v1; verified against 1.17.14–1.18.x. Outside that band it
 * warns but runs; only OpenCode v2+ disables it — enforced at runtime like
 * persist-permissions (path/file installs bypass package-engine checks). The
 * event path is the only route available: on the pinned hosts Permission.ask
 * publishes the Asked event straight after rule evaluation, and the
 * `permission.ask` plugin hook that could pre-empt it is declared in the
 * plugin API but never triggered (verified against the v1.17.14 and v1.17.18
 * sources; the TUI's plugin surface is read-only over pending permissions
 * too). The prompt therefore cannot be suppressed or held back while the
 * classifier thinks — instead a notify-gated toast announces the
 * classification the moment it starts.
 */

const MAX_QUEUED = 64
const PROJECT_GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]

// The shared reading of a permission.asked event (see the library's
// normalizeRequest). The tool-call pointer's messageID doubles as the
// scheduler's batch identity: every tool call of one assistant turn carries
// that turn's message id.
type Request = PermissionAsk

function modelFromMessage(info: unknown): ModelRef | undefined {
  if (!info || typeof info !== "object") return
  const message = info as {
    model?: unknown
    providerID?: unknown
    modelID?: unknown
  }
  if (message.model && typeof message.model === "object") {
    const model = message.model as { providerID?: unknown; modelID?: unknown }
    if (
      typeof model.providerID === "string" &&
      typeof model.modelID === "string"
    ) {
      return { providerID: model.providerID, modelID: model.modelID }
    }
  }
  if (typeof message.model === "string") return parseModelRef(message.model)
  if (
    typeof message.providerID === "string" &&
    typeof message.modelID === "string"
  ) {
    return { providerID: message.providerID, modelID: message.modelID }
  }
  return undefined
}

// Command-expansion provenance. The host persists a project command's
// template text as ordinary non-synthetic user text (verified against the
// v1.18.1 source), indistinguishable from typed prose — so this plugin marks
// the parts itself in command.execute.before, and the transcript then carries
// the user's own invocation ("/deploy prod") instead of the
// repository-controlled template, which must never read as user authorization.
type CommandOrigin = { command: string; arguments?: string }

function commandOriginOf(part: unknown): CommandOrigin | undefined {
  const metadata = (part as { metadata?: unknown }).metadata
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return
  if (!Object.hasOwn(metadata, STORAGE_SERVICE)) return
  const marker = (metadata as Record<string, unknown>)[STORAGE_SERVICE]
  if (!marker || typeof marker !== "object") return
  const { command, arguments: args } = marker as {
    command?: unknown
    arguments?: unknown
  }
  if (typeof command !== "string" || !command.trim()) return
  return {
    command: command.trim(),
    arguments:
      typeof args === "string" && args.trim() ? args.trim() : undefined,
  }
}

function textOfParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  const texts: string[] = []
  let command: CommandOrigin | undefined
  for (const part of parts) {
    const isText =
      !!part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string" &&
      !(part as { synthetic?: unknown }).synthetic
    if (!isText) continue
    const origin = commandOriginOf(part)
    if (origin) {
      // Repository-authored template text: represent the user's own
      // invocation instead, once, however many parts the template produced.
      command ??= origin
      continue
    }
    texts.push((part as { text: string }).text)
  }
  if (command) {
    texts.unshift(
      `(ran the project command "/${command.command}${command.arguments ? ` ${command.arguments}` : ""}" — its repository-defined template text is not shown)`,
    )
  }
  return texts.join("\n").trim()
}

type SessionContext = { model?: ModelRef; task?: string; agent?: string }

function agentOfMessage(info: unknown): string | undefined {
  if (!info || typeof info !== "object") return
  const agent = (info as { agent?: unknown }).agent
  return typeof agent === "string" && agent ? agent : undefined
}

// One key/message pair per policy fault, shared by the request gate, the
// processing-mode read, and the startup scan so a pause is reported
// identically wherever it is noticed.
function policyFaultKey(fault: PolicyFault): string {
  switch (fault.kind) {
    case "legacy-global":
      return "settings-global-migration"
    case "global-unreadable":
      return "settings-global-unreadable"
    case "bless-unreadable":
      return "bless-unreadable"
    case "worktree-unreadable":
      return `worktree-config-unreadable:${fault.files.join("\n")}`
    case "worktree-unblessed":
      return `worktree-config-unblessed:${fault.files.join("\n")}`
    case "project-unreadable":
      return "settings-corrupt"
  }
}

function policyFaultMessage(fault: PolicyFault): string {
  switch (fault.kind) {
    case "legacy-global":
      return `Approve for Me is paused: global settings now live on this plugin's entry in your global opencode.json[c] — ["<spec>", { …settings }]. Move the contents of ${fault.file} onto that entry, then delete the file.`
    case "global-unreadable":
      return "Approve for Me is paused: a global OpenCode config file (or this plugin's entry options in it) is unreadable or mistyped."
    case "bless-unreadable":
      return `Approve for Me is paused: the project-config trust record at ${fault.file} is unreadable or invalid JSON.`
    case "worktree-unreadable":
      return `Approve for Me is paused: project OpenCode config could not be read: ${fault.files.join(", ")}.`
    case "worktree-unblessed":
      return `Approve for Me is paused: project OpenCode config carrying Approve for Me options is unreviewed, changed, or removed: ${fault.files.join(", ")}. Review the state of the file(s), then approve it via "Approve for Me: trust project plugin config" in the TUI palette.`
    case "project-unreadable":
      return `Approve for Me is paused: a ${SERVICE} settings file is unreadable or invalid JSON.`
  }
}

function sideloadWarning(files: string[]): { key: string; message: string } {
  return {
    key: `sideload:${files.join("\n")}`,
    message: `OpenCode loads project-local plugin code without review: ${files.join(", ")}. It can answer permissions without any of Approve for Me's checks. Review it, then trust it via "Approve for Me: trust project plugin config" — or remove it.`,
  }
}

export const ApproveForMePlugin: Plugin = async ({
  client,
  directory,
  worktree,
  serverUrl,
}) => {
  const instanceID = randomUUID()
  const log = appLogger(client, SERVICE)

  const compat = await reportServerCompat({
    client,
    serverUrl,
    label: "Approve for Me",
    service: SERVICE,
    log,
  })
  // Only a non-v1 host disables auto-approval; the deferred toast surfaces
  // that at the first permission prompt. A merely untested v1 host runs on —
  // and the classifier it guards still defers to the user on every ask.
  if (compat?.disable)
    return unsupportedVersionHooks(client, directory, compat.message)

  // Non-git projects report worktree "/" (opencode's instance-context
  // sentinel); treat it as absent so files land in the project directory.
  const inGitWorktree = Boolean(worktree && worktree !== "/")
  const root = inGitWorktree ? worktree : directory
  // The HOST keeps the "/" sentinel as its config-discovery stop, though —
  // a non-git session loads opencode.json[c] and .opencode directories from
  // every ancestor, so the policy and sideload scans must look that far too.
  const configRoot = hostConfigRoot(worktree)
  const legacySettingsFile = legacyProjectSettingsFile(root)

  // No TUI attached just means nobody is listening; never let that disturb
  // permission handling.
  const toast = serverToast(client, { directory })

  // One warning per distinct cause, or every toast-capable failure would
  // nag on every single permission request.
  const warnings = createWarnOnceLatch()
  const warnOnce = (key: string, message: string) => {
    if (!warnings.warn(key)) return
    log("warn", message)
    toast("warning", message)
  }

  // Project instructions are useful evidence about repository conventions,
  // but a repository must never be able to redefine classifier policy. Read
  // the same first-choice filenames OpenCode recognizes at the project root
  // and pass the first one found in the explicitly untrusted user-data block.
  //
  // Every request opens, fstats, and reads the real file — no cache, so the
  // next-request freshness contract holds by construction. (A stat-identity
  // cache cannot honor it: a same-length in-place rewrite with a restored or
  // coarse-granularity mtime leaves inode, mtime, and size all unchanged.)
  // The read is bounded instead: a file over GUIDANCE_MAX_BYTES is skipped
  // outright — the classifier prompt uses at most a few thousand characters
  // of guidance, so an oversized file could only cost memory, never add
  // signal — which keeps the per-request read cheap enough to need no cache.
  const GUIDANCE_READ_TIMEOUT_MS = 10_000
  const GUIDANCE_MAX_BYTES = 262_144
  const readProjectGuidance = async (
    userAnswered?: AbortSignal,
  ): Promise<string | undefined> => {
    let guidanceRoot: string
    try {
      guidanceRoot = await fs.realpath(root)
    } catch (error) {
      warnOnce(
        "project-guidance:root",
        `Could not resolve the project root as classifier context; continuing without it (${error instanceof Error ? error.message : String(error)}).`,
      )
      return undefined
    }
    // Reads are cancellable: the user answering first abandons them, and a
    // stalled filesystem gives up on its own timeout instead of wedging the
    // classification (and leaking its pending handler) forever. The open
    // itself cannot take a signal — O_NONBLOCK below keeps it from blocking.
    const timeout = AbortSignal.timeout(GUIDANCE_READ_TIMEOUT_MS)
    const signal = userAnswered
      ? AbortSignal.any([userAnswered, timeout])
      : timeout
    for (const basename of PROJECT_GUIDANCE_FILES) {
      let file: fs.FileHandle | undefined
      try {
        // Repositories can commit a guidance-file symlink to an external
        // secret. Opening the canonical root child with O_NOFOLLOW prevents
        // that permission-bypassing read, and checking/reading one open handle
        // closes the usual lstat-to-read replacement race. O_NOFOLLOW does
        // not stop a FIFO, whose read-open blocks until a writer appears —
        // O_NONBLOCK makes that open return at once (a no-op for regular
        // files) and the fstat gate below rejects everything but a real file.
        file = await fs.open(
          path.join(guidanceRoot, basename),
          fsConstants.O_RDONLY |
            fsConstants.O_NOFOLLOW |
            fsConstants.O_NONBLOCK,
        )
        const stat = await file.stat()
        if (!stat.isFile()) throw new Error("not a regular file")
        if (stat.size > GUIDANCE_MAX_BYTES) {
          warnOnce(
            `project-guidance:${basename}:oversize`,
            `${basename} is ${stat.size} bytes; classifier guidance is capped at ${GUIDANCE_MAX_BYTES} bytes — skipping it.`,
          )
          continue
        }
        const text = (await file.readFile({ encoding: "utf8", signal })).trim()
        if (text) return `${basename}:\n${text}`
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        // The user answered while the read was in flight: the classification
        // is being abandoned anyway — no warning worth raising.
        if (userAnswered?.aborted) return undefined
        warnOnce(
          `project-guidance:${basename}`,
          `Could not read ${basename} as classifier context; continuing without it.`,
        )
      } finally {
        await file?.close().catch(() => {})
      }
    }
    return undefined
  }

  // What the classifier is doing per request, mirrored to the activity file
  // for the TUI companion's sidebar stream — plus the server beacon: ready or
  // paused-with-reason, so the sidebar can tell the truth about whether this
  // half is actually approving anything. Display-only — no approval decision
  // reads any of it — so write failures are reported once and otherwise
  // ignored. Writes are chained so an older snapshot can never land after a
  // newer one; each write is atomic (tmp + rename) on its own.
  const activityEntries = new Map<string, ActivityEntry>()
  const activityWrites = createSerialQueue()
  let serverEntry: ServerStatus | undefined
  let disposed = false
  // Pause ownership is independent: healing one gate must not hide another
  // gate that is still broken or an ancestry barrier that is still pending.
  const serverPauses = new Map<string, string>()
  const flushActivity = (file: string) => {
    if (disposed) return
    const snapshot: ActivityFile = {
      ...(serverEntry ? { server: serverEntry } : {}),
      requests: Object.fromEntries(activityEntries),
    }
    void activityWrites.push(async () => {
      try {
        await writeActivity(file, snapshot)
      } catch (error) {
        warnOnce(
          "activity-write",
          `Could not write the sidebar activity feed: ${error instanceof Error ? error.message : String(error)}.`,
        )
      }
    })
  }
  const recordActivity = (
    file: string,
    requestID: string,
    state: ActivityState,
    reason?: string,
    denyAt?: number,
  ) => {
    if (disposed) return
    const now = Date.now()
    // Normalized here, once, with the complete annotation in hand — callers
    // prefix and quote freely (assessment before a reason, a rule pattern of
    // any length) and the recorded value still stays within the bound the
    // sidebar's render cap is derived from, so it renders in full.
    activityEntries.set(requestID, {
      state,
      ...(reason ? { reason: truncate(reason, ACTIVITY_REASON_MAX) } : {}),
      time: now,
      ...(denyAt !== undefined ? { denyAt } : {}),
    })
    pruneActivity(activityEntries, now)
    flushActivity(file)
  }
  // Removes a stale countdown: once a deadline is disarmed — an answer
  // landed, a toggle intervened, a fire-time guard declined — the sidebar
  // must stop promising an automatic reject that will never come, and the
  // entry goes back to ordinary TTL aging.
  const dropDeadline = (file: string, requestID: string) => {
    if (disposed) return
    const entry = activityEntries.get(requestID)
    if (!entry || entry.denyAt === undefined) return
    const { denyAt: _disarmed, ...rest } = entry
    activityEntries.set(requestID, rest)
    flushActivity(file)
  }
  const refreshServerEntry = (): boolean => {
    const reason = serverPauses.values().next().value as string | undefined
    if (
      reason === undefined
        ? serverEntry?.state === "ready"
        : serverEntry?.state === "paused" && serverEntry.reason === reason
    )
      return false
    serverEntry = reason
      ? { state: "paused", reason, time: Date.now() }
      : { state: "ready", time: Date.now() }
    return true
  }
  const updateServerPause = (key: string, reason?: string): boolean => {
    if (reason === undefined) {
      if (!serverPauses.delete(key)) return false
    } else if (serverPauses.get(key) === reason) {
      return false
    } else {
      serverPauses.set(key, reason)
    }
    return refreshServerEntry()
  }
  const serverPaused = (file: string, key: string, reason: string) => {
    if (disposed) return
    if (updateServerPause(key, reason)) flushActivity(file)
  }
  const serverHealed = (file: string, key: string) => {
    if (disposed) return
    if (updateServerPause(key)) flushActivity(file)
  }

  // The durable approvals journal: what the classifier approved, keyed by the
  // narrowest persistent pattern (what persist-permissions would save for an
  // "always" answer), so the enshrine-approvals skill can later propose real
  // store rules from it. Advisory output only — no approval decision ever
  // reads it — so every failure warns once and is otherwise ignored, and a
  // journal that cannot be parsed starts over instead of pausing anything.
  // Each update is a full read-modify-write chained behind the previous one:
  // within the instance updates can never interleave, across instances the
  // last writer wins a whole file (the store's own caveat family), and each
  // write is atomic on its own.
  const journalWrites = createSerialQueue()
  const journalApproval = (
    file: string,
    preSlugFile: string,
    projectRoot: string,
    storeFile: string,
    permission: string,
    patterns: string[],
    risk: RiskLevel,
  ) => {
    if (!patterns.length) return
    void journalWrites
      .push(async () => {
        // Advisory data, so an unresolved pre-upgrade journal warns rather
        // than pausing anything — but it must not stay silent: the entries in
        // it are invisible to this release and to the enshrine-approvals
        // skill until the user merges or removes the old file.
        if ((await pathExists(preSlugFile)) === true) {
          warnOnce(
            "approvals-journal-preslug",
            `A pre-upgrade approvals journal remains at ${preSlugFile}; its entries are invisible to this release. Merge it into ${file} or delete it.`,
          )
        }
        let journal = await readApprovalsJournal(file)
        if (!journal) {
          // History lost is worth one warning; approvals themselves never wait
          // on this.
          warnOnce(
            "approvals-journal-reset",
            `The approvals journal at ${file} was unreadable and starts over.`,
          )
          journal = { approvals: emptyApprovals() }
        }
        recordApproval(
          journal.approvals,
          permission,
          patterns,
          risk,
          Date.now(),
        )
        // storeFile names the store persist-permissions actually writes for
        // this project — since repository scope, no longer derivable from
        // this journal's own filename hash (a linked worktree's store is
        // keyed by the PRIMARY root). The enshrine-approvals skill reads it
        // instead of re-deriving anything.
        await writeApprovalsJournal(file, {
          root: projectRoot,
          storeFile,
          approvals: journal.approvals,
        })
      })
      .catch((error) => {
        warnOnce(
          "approvals-journal",
          `Could not update the approvals journal: ${error instanceof Error ? error.message : String(error)}.`,
        )
      })
  }

  // The OpenCode global config and state directories, probed once. Both are
  // trust inputs: if either cannot be resolved, approval pauses instead of
  // silently losing global settings or the instance toggle.
  // /path is an instance-scoped endpoint and plugins load during instance
  // bootstrap, so awaiting it HERE would deadlock startup — the promise is
  // kicked off now and awaited by the event handlers instead. A fresh UUID
  // owns fresh ephemeral files; older instances' files are never touched.
  type HostPaths =
    | {
        projectRoot: string
        configDir: string
        stateDir: string
        sessionModelsDir: string
        reservedPaths: string[]
        globalSettingsFile: string
        projectSettingsFile: string
        overridePath: string
        activityPath: string
        journalPath: string
        blessPath: string
        preSlugProjectSettingsPath: string
        preSlugJournalPath: string
        storeFile: string
        legacyStoreFile: string
        worktreeStoreFile?: string
        preSlugStoreFiles?: string[]
        packageDir?: string
        error?: never
      }
    | {
        projectRoot?: never
        configDir?: never
        stateDir?: never
        sessionModelsDir?: never
        reservedPaths?: never
        globalSettingsFile?: never
        projectSettingsFile?: never
        overridePath?: never
        activityPath?: never
        journalPath?: never
        blessPath?: never
        preSlugProjectSettingsPath?: never
        preSlugJournalPath?: never
        storeFile?: never
        legacyStoreFile?: never
        worktreeStoreFile?: never
        preSlugStoreFiles?: never
        packageDir?: never
        error: string
      }
  const hostPaths: Promise<HostPaths> = (async () => {
    try {
      const pathApi = (
        client as {
          path?: { get?: (input?: unknown) => Promise<{ data?: unknown }> }
        }
      ).path
      const getPath = pathApi?.get?.bind(pathApi)
      if (!getPath) throw new Error("the SDK client has no path lookup method")
      const result = await getPath({ query: { directory } })
      const paths = (result?.data ?? undefined) as
        | { config?: unknown; state?: unknown }
        | undefined
      if (typeof paths?.config !== "string" || !paths.config)
        throw new Error("the path response omitted config")
      if (typeof paths.state !== "string" || !paths.state)
        throw new Error("the path response omitted state")
      const trusted = await resolveTrustedSettingsPaths(
        root,
        paths.config,
        paths.state,
        openCodeDataDir(process.env, os.homedir()),
        instanceID,
      )
      if (!trusted) {
        throw new Error(
          "the derived OpenCode config/state paths are not trusted paths outside the project",
        )
      }
      const sessionModels = await sessionModelCapability(
        trusted.sessionModelsDir,
      )
      if (!sessionModels.available) {
        warnOnce(
          "session-model-capability",
          `Session-scoped classifier models are unavailable: ${sessionModels.reason}. Project/global classifier settings still work.`,
        )
      }
      // persist-permissions keys its store by the primary worktree root by
      // default ("repository" scope), so a linked-worktree session resolves
      // TWO candidate files: the shared repository store and any store still
      // keyed by this worktree's own root (pre-repository-scope data, or that
      // plugin's scope: "worktree"). This plugin reads both — a carve-out in
      // either must keep vetoing regardless of the other plugin's scope
      // option or migration state.
      //
      // A failed probe must NOT quietly collapse the pair to the worktree's
      // own store: a repository-scoped store may hold an ask/deny carve-out
      // this classifier is obliged to honor, and dropping the candidate would
      // silently auto-approve what the user configured to stay interactive.
      // That fallback is fine for persist-permissions (it merely shares
      // less); a classifier must pause instead. The one benign failure is a
      // host that reported a worktree for a directory git itself says is not
      // inside a work tree (some harnesses do; stray .git debris also lands
      // here) — no repository means no second candidate store to miss, so
      // the session keys by its own root like a non-git project.
      //
      // The host's NON-git sentinel is not ground truth either: it has been
      // observed reaching plugin factories for sessions that ARE inside
      // linked worktrees, transiently at boot. Concluding non-git from it
      // alone would skip the shared candidate store — and its carve-outs —
      // exactly like the failed-probe collapse above, so the claim is
      // verified against git before the probe is skipped. (A host that DID
      // name a work tree stays trusted as before; the is-inside-work-tree
      // confirm keeps non-git harness directories alive.)
      let keyRoot: string | undefined
      const worktreeRoot = inGitWorktree
        ? root
        : await discoverWorktreeRoot(root)
      if (worktreeRoot) {
        keyRoot = await discoverPrimaryRoot(worktreeRoot)
        if (!keyRoot) {
          const confirm = await runGitCommand(worktreeRoot, [
            "rev-parse",
            "--is-inside-work-tree",
          ])
          if (confirm.code === 0) {
            throw new Error(
              "the repository's primary worktree root could not be established, so a repository-scoped permission store (and any ask/deny carve-outs in it) cannot be consulted",
            )
          }
        }
      }
      // The store paths key by the WORK-TREE root whenever git found one, not
      // by `root`. In the false-sentinel path `root` is the session directory,
      // which may sit well below the worktree root — persist-permissions keys
      // its worktree store by the root itself, so hashing from a nested launch
      // directory would name a file that plugin never writes, and the real
      // worktree store's ask/deny carve-outs would silently stop vetoing.
      // (`root` still governs everything else: settings keying and the
      // file-escape containment checks must not widen to the worktree.)
      const trustedStore = await resolvePermissionStorePaths(
        worktreeRoot ?? root,
        paths.config,
        keyRoot,
      )
      if (!trustedStore) {
        throw new Error(
          "the derived permission-store path is not trusted outside the project",
        )
      }
      // Publish only this factory's beacon. A failed write fails init rather
      // than leaving the sidebar unable to report the server's state.
      refreshServerEntry()
      await writeActivity(trusted.activityPath, {
        server: serverEntry,
        requests: {},
      })
      const packageDir = await ownPackageDir()
      return {
        ...trusted,
        ...(packageDir ? { packageDir } : {}),
        storeFile: trustedStore.storeFile,
        legacyStoreFile: trustedStore.legacyStoreFile,
        ...(trustedStore.worktreeStoreFile
          ? { worktreeStoreFile: trustedStore.worktreeStoreFile }
          : {}),
        ...(trustedStore.preSlugStoreFiles
          ? { preSlugStoreFiles: trustedStore.preSlugStoreFiles }
          : {}),
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log("warn", `could not initialize OpenCode paths: ${detail}`)
      return { error: detail }
    }
  })()

  const locality = createFilesystemLocalityResponder({
    service: STORAGE_SERVICE,
    paths: async (signal) => {
      signal.throwIfAborted()
      const paths = await hostPaths
      signal.throwIfAborted()
      if ("error" in paths) return
      const scope = await settingsLocalityPaths(paths)
      signal.throwIfAborted()
      if (!scope) return
      for (const dir of [paths.configDir, paths.projectRoot]) {
        if (!(await fs.stat(dir)).isDirectory()) return
        signal.throwIfAborted()
      }
      // The shared resolver includes accepted redirected policy/config targets.
      // Serialize creation so cancellation prevents every not-yet-started mkdir.
      for (const dir of scope) {
        signal.throwIfAborted()
        if (dir === paths.configDir || dir === paths.projectRoot) continue
        await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      }
      signal.throwIfAborted()
      return scope
    },
  })

  // Startup sideload scan: worktree plugin surfaces the host loads without
  // review should be flagged even in a session that never raises a
  // permission prompt. Best-effort by design — a failure here pauses
  // nothing (the request gate re-checks everything that matters). Under
  // OPENCODE_DISABLE_PROJECT_CONFIG the host loads none of these surfaces,
  // so there is nothing to warn about.
  void hostPaths
    .then(async (paths) => {
      if ("error" in paths) return
      if (projectConfigDisabled()) return
      const [scan, sources, blessing] = await Promise.all([
        scanWorktreeConfig(directory, configRoot, paths.packageDir),
        scanSideloadSources(directory, configRoot),
        readBlessing(paths.blessPath),
      ])
      // An unreadable blessing is a pause the request gate owns; guessing
      // "everything is unreviewed" here would just double-report it.
      if (!blessing) return
      const flagged = unblessedSideloads(scan, sources, blessing)
      if (flagged.length) {
        const warning = sideloadWarning(flagged)
        // Log AND toast, but do NOT consume the once-latch: host toasts are
        // fire-and-forget with no retention, so a TUI that subscribes after
        // this publish never saw it — the first permission request's
        // re-scan must still be able to warn (its warnOnce latches for
        // both, so later requests stay quiet).
        log("warn", warning.message)
        toast("warning", warning.message)
      }
    })
    .catch(() => {})

  // Latest user prompt (model + user-authored text) per session, from the
  // chat.message hook. A permission request always follows a prompt in the
  // same process, so the triggering session is normally tracked; the
  // session-messages fallback covers child sessions whose prompts predate us.
  const sessionContext = new Map<string, SessionContext>()
  // parentID is immutable per session, so cache successful lookups forever
  // (bounded). Failed lookups are deliberately not cached: unknown ancestry
  // must never be mistaken for a root/user-authored session.
  const sessionParents = new Map<string, string | null>()
  // Sessions this plugin created to run the classifier. Never classified,
  // never treated as user activity.
  const classifierSessions = new Set<string>()
  // A classifier verdict is trusted only after the system-transform hook has
  // replaced OpenCode's inherited agent/project prompt with our fixed policy.
  const isolatedClassifierSessions = new Set<string>()
  // In-flight classifications are abortable when the user answers first — or
  // when a re-emission shows the request's content changed under the
  // classifier (the fingerprint pins the snapshot being judged). The
  // scheduler owns settled-request state.
  const inFlight = new Map<
    string,
    { controller: AbortController; fingerprint: string | undefined }
  >()
  // Permission replies THIS plugin authored — approvals, timed denies, sweep
  // rejects, and the host-cascade victims of those rejects — registered
  // BEFORE each POST, because the host publishes the replied event while the
  // POST is still resolving. A replied event whose id is not in here is a
  // user-authored answer: the presence signal that resets a prompt tree's
  // unattended-deny budget.
  const pluginReplied = new Set<string>()
  // The unattended-deny timers, one per prompt the classifier left for the
  // user (surfaced or failed on), and each prompt tree's count of timed
  // denies since the user last answered anything in it. Timers are never
  // trim()ed: every entry either fires (and deletes itself) or is cleared by
  // the replied event, so the map is bounded by the host's own pending set.
  const unattendedDenyTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const unattendedDenyCounts = new Map<string, number>()
  // Computed inside the event hook, before any exception boundary — so it
  // must be TOTAL. Plain JSON.stringify throws on BigInt and cyclic metadata,
  // and that unhandled rejection would disturb the event pipeline (the one
  // thing this plugin must never do). stableStringify never throws and is
  // deterministic, so identical re-emissions still compare equal. A LOSSY
  // serialization (beyond-depth or truncated content, throwing accessors,
  // toJSON/non-plain objects such as URL, exceeded budget) cannot prove a
  // re-emission unchanged — distinct contents can share its rendering — so
  // it yields no fingerprint at all and every comparison against it fails.
  const requestFingerprint = (request: Request): string | undefined => {
    const state = { lossy: false }
    const text = stableStringify(
      [
        request.permission,
        request.patterns,
        request.title ?? null,
        request.metadata ?? null,
      ],
      state,
    )
    return state.lossy ? undefined : text
  }

  // Classification is the slow, model-latency-bound stage, so it runs through
  // a small FIFO slot pool: up to the settings' maxConcurrent verdicts in
  // flight, and every later prompt WAITS for a freed slot instead of falling
  // through to the user — a burst of parallel sub-agents raises far more
  // simultaneous prompts than any sensible limit, and dropping the overflow
  // made the plugin useless exactly when it was needed most. The queue is
  // bounded as a runaway backstop; overflow fails closed like before. The
  // prompt stays on screen while queued, and a user answer still wins:
  // an answered waiter leaves the queue at once (so dead entries never crowd
  // out live prompts against MAX_QUEUED), and handle() re-checks its abort
  // signal the moment a slot is granted.
  const classifierPool = createConcurrencyPool(MAX_QUEUED)

  const { api } = createHostAdapter({ client, directory, serverUrl })

  // A batch-parallel turn fans one burst of prompts into near-identical host
  // lookups: the merged config, the /agent list, the provider catalog, and
  // the same session's history and rules, once per prompt. Concurrent
  // identical reads are COALESCED, and nothing outlives its read: no TTL, no
  // cache. Settings files and permission stores are deliberately not
  // touched: re-read on every request, the documented contract. A failure
  // reaches every sharer and the next request retries — a coalesced read is
  // never a cached error.
  //
  // Joining is EPOCH-GATED: the host persists and executes streamed tool
  // calls while a read is in flight, so a snapshot that materialized before
  // a later prompt's ask could hide that prompt's just-persisted siblings
  // from its classifier trail (or a just-changed rule from its rule mirror).
  // Every permission event advances the epoch; a consumer only joins a read
  // that STARTED in its own epoch — anything older gets a fresh read whose
  // snapshot necessarily covers everything persisted before the consumer's
  // ask. A same-turn burst still shares: its events all land before the
  // first handle() reaches these reads.
  //
  // Reads are also individually TIMED OUT, owner-independently: none of the
  // SDK calls behind them carries an abort, and one never-settling transport
  // call would otherwise wedge every sharer's slot forever (the epoch gate
  // already keeps LATER requests off the hung promise). Timeout and transport
  // failure both resolve `undefined` — the exact fail-closed value every
  // consumer already maps to pause-or-degrade — never a rejection.
  const { coalesce, fresh, advanceEpoch } = createHostReadCoalescer(log)

  type ParentLookup = { known: true; parent?: string } | { known: false }
  const SESSION_PARENT_LOOKUP_TIMEOUT_MS = 3_000

  const getSessionParent = async (sessionID: string): Promise<ParentLookup> => {
    if (sessionParents.has(sessionID)) {
      const parent = sessionParents.get(sessionID)
      return { known: true, parent: parent ?? undefined }
    }
    try {
      const sessionApi = (
        client as {
          session?: { get?: (input: unknown) => Promise<{ data?: unknown }> }
        }
      ).session
      const get = sessionApi?.get?.bind(sessionApi)
      if (!get) return { known: false }
      const result = await withTimeout(
        () =>
          get({
            path: { id: sessionID },
            query: { directory },
          }),
        SESSION_PARENT_LOOKUP_TIMEOUT_MS,
        { message: `session parent lookup for ${sessionID} timed out` },
      )
      if (!result?.data || typeof result.data !== "object")
        return { known: false }
      const parentID = (result.data as { parentID?: unknown }).parentID
      const parent = typeof parentID === "string" ? parentID : undefined
      sessionParents.set(sessionID, parent ?? null)
      trim(sessionParents)
      return { known: true, parent }
    } catch {
      return { known: false }
    }
  }

  // The tool name and title of a completed-or-running tool part. Anything
  // not shaped like a tool part is skipped defensively, like textOfParts.
  // Name and title stay separate: on the supported hosts a title can be the
  // full command line or URL, which only a judge that already sees this
  // session's content may receive (see the trail rendering in handle()).
  type ToolCallEntry = { tool: string; title?: string }
  const toolCallOfPart = (part: unknown): ToolCallEntry | undefined => {
    if (!part || typeof part !== "object") return
    const candidate = part as {
      type?: unknown
      tool?: unknown
      state?: unknown
    }
    if (
      candidate.type !== "tool" ||
      typeof candidate.tool !== "string" ||
      !candidate.tool
    )
      return
    const title =
      candidate.state && typeof candidate.state === "object"
        ? (candidate.state as { title?: unknown }).title
        : undefined
    return {
      tool: candidate.tool,
      ...(typeof title === "string" && title.trim()
        ? { title: title.trim() }
        : {}),
    }
  }

  // How many messages one history fetch may hydrate. The supported hosts
  // (1.17.14+) apply `limit` as "newest N"; without it every message and
  // every part — tool outputs included — is materialized on every permission
  // request, which grows without bound over a long session. The transcript
  // budget is ~6k chars of user text and the tool trail wants 15 titles, so
  // the newest 200 messages are plenty; hitting the limit flags the history
  // as truncated so the window drops its first-message anchor.
  const HISTORY_PAGE_LIMIT = 200

  // One pass over a session's recorded messages: every user-authored prompt
  // (for the classifier's transcript window), every tool call (for the
  // workflow trail), and the newest user message's model/agent/text — the
  // same fallback context the chat.message hook would have captured had it
  // seen the session. undefined only when the messages cannot be read.
  type SessionHistory = {
    userMessages: string[]
    toolCalls: ToolCallEntry[]
    truncated: boolean
    last?: SessionContext
  }
  const sessionHistory = (
    sessionID: string,
  ): Promise<SessionHistory | undefined> =>
    coalesce(`history:${sessionID}`, () => fetchSessionHistory(sessionID))
  const fetchSessionHistory = async (
    sessionID: string,
  ): Promise<SessionHistory | undefined> => {
    try {
      const sessionApi = (
        client as {
          session?: {
            messages?: (input: unknown) => Promise<{ data?: unknown }>
          }
        }
      ).session
      const messages = sessionApi?.messages?.bind(sessionApi)
      const result = messages
        ? await messages({
            path: { id: sessionID },
            query: { directory, limit: HISTORY_PAGE_LIMIT },
          })
        : undefined
      if (!Array.isArray(result?.data)) return undefined
      const entries = result.data as { info?: unknown; parts?: unknown }[]
      const history: SessionHistory = {
        userMessages: [],
        toolCalls: [],
        truncated: entries.length >= HISTORY_PAGE_LIMIT,
      }
      for (const entry of entries) {
        const role = (entry.info as { role?: unknown } | undefined)?.role
        if (role === "user") {
          const text = textOfParts(entry.parts)
          // Keep complete source text until classifier preparation redacts it.
          if (text) history.userMessages.push(text)
          // The newest user message carries model/agent even when it has no
          // usable text (e.g. attachment-only prompts).
          history.last = {
            model: modelFromMessage(entry.info),
            task: text || undefined,
            agent: agentOfMessage(entry.info),
          }
        } else if (role === "assistant" && Array.isArray(entry.parts)) {
          for (const part of entry.parts) {
            const call = toolCallOfPart(part)
            if (call) history.toolCalls.push(call)
          }
        }
      }
      return history
    } catch {
      return undefined
    }
  }

  // What the classifier gets to see and which model judges by default: the
  // triggering session's model; the root session's user-authored prompts as
  // the transcript window (its newest doubling as the task fallback); and the
  // requesting session's own tool-call trail — titles only, agent-authored,
  // labeled untrusted. A child (sub-agent) session's own prompt is
  // agent-authored, so it is passed separately, labeled untrusted. The agent
  // is always the requesting session's own — the name recorded on its latest
  // user message is the agent whose ruleset the host evaluated. History that
  // cannot be read degrades to the hook-cached single task; it never blocks
  // classification on its own.
  const requestContext = async (
    sessionID: string,
  ): Promise<{
    model?: ModelRef
    task?: string
    userMessages?: string[]
    userMessagesTruncated?: boolean
    toolCalls?: ToolCallEntry[]
    subtask?: string
    agent?: string
  }> => {
    const chain = [sessionID]
    let tail = sessionID
    let rootKnown = false
    let hops = 0
    for (;;) {
      const lookup = await getSessionParent(tail)
      if (!lookup.known) break
      if (!lookup.parent) {
        rootKnown = true
        break
      }
      if (chain.includes(lookup.parent)) break
      if (hops >= SESSION_ANCESTRY_HOP_LIMIT) break
      hops += 1
      chain.push(lookup.parent)
      tail = lookup.parent
    }
    const ownHistory = await sessionHistory(sessionID)
    const own = sessionContext.get(sessionID) ?? ownHistory?.last
    const toolCalls = ownHistory?.toolCalls.length
      ? ownHistory.toolCalls
      : undefined
    if (!rootKnown) {
      // The session may be a child, so its prompts cannot be asserted to be
      // user-authored. Keep its model, but pass any text only in the
      // explicitly untrusted subtask section — and no transcript at all.
      return {
        model: own?.model,
        subtask: own?.task,
        agent: own?.agent,
        toolCalls,
      }
    }
    const rootID = tail
    const rootHistory =
      rootID === sessionID ? ownHistory : await sessionHistory(rootID)
    const rootContext =
      rootID === sessionID
        ? own
        : (sessionContext.get(rootID) ?? rootHistory?.last)
    const userMessages = rootHistory?.userMessages.length
      ? rootHistory.userMessages
      : undefined
    return {
      model: own?.model ?? rootContext?.model,
      task: userMessages?.at(-1) ?? rootContext?.task,
      userMessages,
      userMessagesTruncated: rootHistory?.truncated,
      toolCalls,
      subtask: rootID === sessionID ? undefined : own?.task,
      agent: own?.agent,
    }
  }

  // The pending tool call's arguments, recovered through the permission
  // event's tool pointer. MCP and code-mode permissions carry patterns ["*"]
  // and empty metadata, so without this the judge would grade an opaque name.
  // On the pinned hosts the tool part is already persisted with its input
  // (status "running") when the ask blocks:
  //   - a direct MCP call is the pointed-to part itself — its state.input is
  //     the arguments;
  //   - a code-mode child call shares the parent "execute" part; the child's
  //     arguments live in state.metadata.toolCalls, and because children run
  //     sequentially and the ask blocks, exactly one entry is "running" — the
  //     one asking. Anything else (still "pending", zero or several running
  //     entries) returns undefined, and the caller fails closed.
  const pendingCallInput = async (request: Request): Promise<unknown> => {
    if (!request.toolCall) return undefined
    try {
      const message = (await api(
        "GET",
        `/session/${request.sessionID}/message/${request.toolCall.messageID}`,
      )) as { parts?: unknown }
      if (!Array.isArray(message?.parts)) return undefined
      const part = message.parts.find(
        (candidate): candidate is { tool?: unknown; state?: unknown } =>
          !!candidate &&
          typeof candidate === "object" &&
          (candidate as { type?: unknown }).type === "tool" &&
          (candidate as { callID?: unknown }).callID ===
            request.toolCall?.callID,
      )
      if (!part?.state || typeof part.state !== "object") return undefined
      const state = part.state as {
        status?: unknown
        input?: unknown
        metadata?: unknown
      }
      if (part.tool === request.permission) {
        return state.status === "running" ? state.input : undefined
      }
      const childCalls =
        state.metadata && typeof state.metadata === "object"
          ? (state.metadata as { toolCalls?: unknown }).toolCalls
          : undefined
      if (!Array.isArray(childCalls)) return undefined
      const running = childCalls.filter(
        (call) =>
          !!call &&
          typeof call === "object" &&
          (call as { status?: unknown }).status === "running",
      )
      if (running.length !== 1) return undefined
      const call = running[0] as { tool?: unknown; input?: unknown }
      return { tool: call.tool, arguments: call.input ?? {} }
    } catch {
      return undefined
    }
  }

  const getConfig = (): Promise<
    { permission?: unknown; model?: unknown } | undefined
  > => coalesce("config", () => fetchConfig())
  const fetchConfig = async (): Promise<
    { permission?: unknown; model?: unknown } | undefined
  > => {
    try {
      const configApi = (
        client as {
          config?: { get?: (input?: unknown) => Promise<{ data?: unknown }> }
        }
      ).config
      const get = configApi?.get?.bind(configApi)
      const result = get ? await get({ query: { directory } }) : undefined
      const data = result?.data
      return data && typeof data === "object"
        ? (data as { permission?: unknown; model?: unknown })
        : undefined
    } catch {
      return undefined
    }
  }

  // The active agent's resolved rule array from /agent — the defaults, agent
  // overrides, and merged config `permission` block in the exact order the
  // host evaluates them. undefined when the agent is unknown to the host or
  // anything about the payload is off; the caller must pause then.
  const agentCatalog = (): Promise<unknown[] | undefined> =>
    coalesce("agents", fetchAgentCatalog)
  const fetchAgentCatalog = async (): Promise<unknown[] | undefined> => {
    try {
      const appApi = (
        client as {
          app?: { agents?: (input?: unknown) => Promise<{ data?: unknown }> }
        }
      ).app
      const agents = appApi?.agents?.bind(appApi)
      const result = agents ? await agents({ query: { directory } }) : undefined
      return Array.isArray(result?.data) ? result.data : undefined
    } catch {
      return undefined
    }
  }
  const rulesOfAgent = (
    name: string,
    catalog: unknown[] | undefined,
  ): Rule[] | undefined => {
    if (!catalog) return undefined
    const entry = catalog.find(
      (item) =>
        !!item &&
        typeof item === "object" &&
        (item as { name?: unknown }).name === name,
    )
    if (!entry) return undefined
    return parseRuleArray((entry as { permission?: unknown }).permission)
  }
  const agentRules = async (name: string): Promise<Rule[] | undefined> =>
    rulesOfAgent(name, await agentCatalog())
  const fetchAgentRules = async (name: string): Promise<Rule[] | undefined> =>
    rulesOfAgent(name, await fetchAgentCatalog())

  // The session's own `permission` rules, which the host appends after the
  // agent's when it evaluates a request. Sessions without the field carry no
  // rules; a session that cannot be read or a malformed payload is undefined.
  const sessionRules = (sessionID: string): Promise<Rule[] | undefined> =>
    coalesce(`session-rules:${sessionID}`, () => fetchSessionRules(sessionID))
  const fetchSessionRules = async (
    sessionID: string,
  ): Promise<Rule[] | undefined> => {
    try {
      const sessionApi = (
        client as {
          session?: { get?: (input: unknown) => Promise<{ data?: unknown }> }
        }
      ).session
      const get = sessionApi?.get?.bind(sessionApi)
      const result = get
        ? await get({ path: { id: sessionID }, query: { directory } })
        : undefined
      if (!result?.data || typeof result.data !== "object") return undefined
      const permission = (result.data as { permission?: unknown }).permission
      if (permission === undefined) return []
      return parseRuleArray(permission)
    } catch {
      return undefined
    }
  }

  // The model's entry in the providers catalog, or undefined when the model
  // (or the catalog itself) is not available.
  const providersCatalog = (): Promise<unknown[] | undefined> =>
    coalesce("providers", async () => {
      try {
        const configApi = (
          client as {
            config?: {
              providers?: (input?: unknown) => Promise<{ data?: unknown }>
            }
          }
        ).config
        const providers = configApi?.providers?.bind(configApi)
        const result = providers
          ? await providers({ query: { directory } })
          : undefined
        const list = (result?.data as { providers?: unknown } | undefined)
          ?.providers
        return Array.isArray(list) ? list : undefined
      } catch {
        return undefined
      }
    })
  const providerModel = async (
    model: ModelRef,
  ): Promise<Record<string, unknown> | undefined> => {
    const list = await providersCatalog()
    if (!list) return undefined
    for (const provider of list) {
      const entry = provider as { id?: unknown; models?: unknown }
      if (
        entry.id !== model.providerID ||
        !entry.models ||
        typeof entry.models !== "object"
      )
        continue
      const info = (entry.models as Record<string, unknown>)[model.modelID]
      return info && typeof info === "object"
        ? (info as Record<string, unknown>)
        : undefined
    }
    return undefined
  }

  type Judge = { model: ModelRef; variant?: string }
  type ModelResolution = { judge?: Judge; failure?: string }

  // A configured variant must exist on the judge model. The host silently
  // ignores a variant the model does not define (verified against 1.17.14
  // source and a live 1.17.18), which would quietly judge at default effort —
  // pause instead, exactly like a pinned model that is gone. The caller
  // hands over the model's catalog entry it already holds — the pinned-model
  // availability check needs the same entry, and fetching it twice per
  // request was half of audit finding L-AF4.
  const withVariant = (
    model: ModelRef,
    settings: ResolvedSettings,
    entry: Record<string, unknown> | undefined,
  ): ModelResolution => {
    if (!settings.variant) return { judge: { model } }
    const variants = entry?.variants
    // `in` would also accept Object.prototype names such as "toString". The
    // host silently ignores an unknown variant, so an inherited-property hit
    // would bypass this guard and classify at an unrequested default effort.
    const available =
      !!variants &&
      typeof variants === "object" &&
      !Array.isArray(variants) &&
      Object.hasOwn(variants, settings.variant)
    if (!available) {
      const failure = `classifier model ${formatModelRef(model)} has no "${settings.variant}" variant in this OpenCode instance`
      warnOnce(
        `variant:${formatModelRef(model)}#${settings.variant}`,
        `Approve for Me cannot classify this prompt tree: ${failure}.`,
      )
      return { failure }
    }
    return { judge: { model, variant: settings.variant } }
  }

  const resolveModel = async (
    settings: ResolvedSettings,
    configModel: unknown,
    context: { model?: ModelRef },
  ): Promise<ModelResolution> => {
    if (settings.model) {
      const pinned = parseModelRef(settings.model)
      const entry = pinned ? await providerModel(pinned) : undefined
      if (!pinned || !entry) {
        // A pinned model that is gone must not silently fall back to another
        // model the user never chose to trust.
        const failure = `configured classifier model "${settings.model}" is not available in this OpenCode instance`
        warnOnce(
          `model:${settings.model}`,
          `Approve for Me cannot classify this prompt tree: ${failure}.`,
        )
        return { failure }
      }
      return withVariant(pinned, settings, entry)
    }
    const model = context.model ?? parseModelRef(configModel)
    if (!model) return {}
    return withVariant(
      model,
      settings,
      settings.variant ? await providerModel(model) : undefined,
    )
  }

  const { classify } = createClassifierPipeline({
    directory,
    serverUrl,
    api,
    log,
    classifierSessions,
    isolatedClassifierSessions,
    textOfParts,
  })

  const reply = async (request: Request): Promise<boolean> => {
    if (disposed) return false
    const respond = (
      client as {
        postSessionIdPermissionsPermissionId?: (
          options: unknown,
        ) => Promise<{ error?: unknown }>
      }
    ).postSessionIdPermissionsPermissionId?.bind(client)
    if (!respond) {
      log(
        "warn",
        "cannot auto-approve: SDK client has no permission reply method",
      )
      return false
    }
    try {
      const result = await respond({
        path: { id: request.sessionID, permissionID: request.id },
        // "once" and never "always": an "always" reply would grant OpenCode's
        // session-wide in-memory blanket AND would be indistinguishable from a
        // user answer to persist-permissions, which persists exactly those.
        body: { response: "once" },
        query: { directory },
      })
      if (result?.error) throw new Error(JSON.stringify(result.error))
      return true
    } catch (error) {
      // Usually the user answered while the classifier was thinking.
      log(
        "warn",
        `auto-approve reply failed for ${request.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  const headline = (request: Request) =>
    truncate(`${request.permission}: ${request.patterns.join(", ")}`, 120)

  // The outcome steers the scheduler: "approved" — the host accepted
  // the "once" reply, the prompt is gone; "left" — the prompt stays pending
  // for the user and must HOLD its stack position. That includes every inert
  // path (off, unconfigured, broken paths): OpenCode still retains the
  // unanswered prompt, so once the feature heals, nothing below it may be
  // classified until the user actually answers it. releaseTurn gates the
  // final "once" reply: it resolves true only while this request is again
  // top-of-stack, false when the prompt was answered or superseded first.
  const handle = async (
    request: Request,
    controller: AbortController,
    treeKey: string,
    releaseTurn: () => boolean | Promise<boolean>,
  ): Promise<"approved" | "left"> => {
    // --- Is Approve for Me on at all? -----------------------------------------
    const paths = await hostPaths
    if ("error" in paths) {
      warnOnce(
        "paths-unreachable",
        `Approve for Me is paused: the OpenCode config/state paths could not be initialized (${paths.error}).`,
      )
      return "left"
    }
    const {
      projectRoot,
      configDir,
      sessionModelsDir,
      reservedPaths,
      globalSettingsFile,
      projectSettingsFile,
      overridePath,
      activityPath,
      journalPath,
      blessPath,
      preSlugProjectSettingsPath,
      storeFile,
      legacyStoreFile,
      worktreeStoreFile,
      preSlugStoreFiles,
      packageDir,
    } = paths
    // Everything from here on annotates the sidebar stream: why a prompt is
    // waiting, that the classifier has it, what it decided. Recorded only
    // while Approve for Me is on — when it is off or paused the sidebar
    // status line already explains the silence.
    const record = (state: ActivityState, reason?: string, denyAt?: number) =>
      recordActivity(activityPath, request.id, state, reason, denyAt)
    const [legacyExists, trustedProjectExists, preSlugSettingsExists] =
      await Promise.all([
        pathExists(legacySettingsFile),
        pathExists(projectSettingsFile),
        pathExists(preSlugProjectSettingsPath),
      ])
    if (
      legacyExists === undefined ||
      trustedProjectExists === undefined ||
      preSlugSettingsExists === undefined
    ) {
      warnOnce(
        "settings-path-unreadable",
        `Approve for Me is paused: a ${SERVICE} settings path is unreadable.`,
      )
      return "left"
    }
    if (legacyExists && !trustedProjectExists) {
      warnOnce(
        "settings-migration-required",
        `Approve for Me is paused: ${legacySettingsFile} is no longer trusted. Review it and recreate the settings at ${projectSettingsFile}; worktree-local settings are never read because agents can edit them.`,
      )
      return "left"
    }
    // Checked per request, not once at init: adoption normally empties the
    // pre-slug name, so a file here is unresolved pre-upgrade policy — a
    // dual-name conflict, or a still-running pre-slug instance writing it
    // again. Its settings (including "enabled": false and permission
    // opt-outs) are invisible to this release, so classifying past it would
    // silently choose one generation's policy. Fail closed until it is gone.
    if (preSlugSettingsExists) {
      warnOnce(
        "settings-preslug-unresolved",
        `Approve for Me is paused: a pre-upgrade settings file remains at ${preSlugProjectSettingsPath}. Merge anything you still want into ${projectSettingsFile}, delete the old file, and make sure no pre-upgrade OpenCode instance is still running for this project.`,
      )
      return "left"
    }
    const snapshot = await readPolicySnapshot({
      configDir,
      projectSettingsFile,
      blessPath,
      legacyGlobalFile: globalSettingsFile,
      directory,
      projectRoot,
      configRoot,
      packageDir,
    })
    // Sideloaded worktree plugin surfaces are warned about, never paused on:
    // the host already loaded them and pausing this plugin would not unload
    // them — but the user must know code exists here that can act on
    // permissions without any of this plugin's checks.
    if (snapshot.sideloads.length) {
      const warning = sideloadWarning(snapshot.sideloads)
      warnOnce(warning.key, warning.message)
    }
    if (snapshot.fault) {
      warnOnce(
        policyFaultKey(snapshot.fault),
        policyFaultMessage(snapshot.fault),
      )
      return "left"
    }
    const settings = resolveSettings(snapshot.settings ?? {})
    let enabled = settings.enabled
    if (overridePath) {
      const override = await readOverride(overridePath)
      if (override) enabled = override.enabled
    }
    if (!enabled) return "left"
    if (
      Object.hasOwn(settings.permissions, request.permission) &&
      settings.permissions[request.permission] === false
    ) {
      log(
        "info",
        `"${request.permission}" is opted out of auto-approve; leaving the prompt`,
      )
      record("skipped", "opted out in settings")
      return "left"
    }
    // External access can be judged, but the host's config, state, and data
    // trees remain deterministic reservations: they contain policy, plugin
    // state, credentials, and session history. Host config surfaces are
    // reserved too, including canonical aliases through symlinks.
    const metadata = request.metadata as
      | {
          path?: unknown
          filepath?: unknown
          files?: unknown
        }
      | undefined
    const filePaths: {
      pattern: string
      roots: string[]
      boundary?: boolean
    }[] =
      request.permission === "external_directory"
        ? request.patterns.map((pattern) => ({
            pattern,
            roots: [root, directory],
            boundary: true,
          }))
        : request.permission === "read" ||
            request.permission === "edit" ||
            request.permission === "write" ||
            request.permission === "list"
          ? request.patterns.map((pattern) => ({
              pattern,
              roots: [root, directory],
            }))
          : request.permission === "glob" || request.permission === "grep"
            ? [metadata?.path]
                .filter(
                  (candidate): candidate is string =>
                    typeof candidate === "string" && candidate.length > 0,
                )
                .map((pattern) => ({ pattern, roots: [directory, root] }))
            : []
    if (typeof metadata?.filepath === "string" && metadata.filepath)
      filePaths.push({ pattern: metadata.filepath, roots: [root, directory] })
    if (Array.isArray(metadata?.files)) {
      for (const entry of metadata.files) {
        if (!entry || typeof entry !== "object") continue
        for (const key of ["filePath", "movePath"] as const) {
          const candidate = (entry as Record<string, unknown>)[key]
          if (typeof candidate === "string" && candidate)
            filePaths.push({ pattern: candidate, roots: [root, directory] })
        }
      }
    }
    const readReservedPaths = async () => {
      const resolutions = []
      for (const target of filePaths) {
        resolutions.push(
          await resolveReservedPath(
            target.roots,
            reservedPaths,
            target.pattern,
            target.boundary,
          ),
        )
      }
      return resolutions
    }
    const reservedPathsState = await readReservedPaths()
    const reservedIndex = reservedPathsState.findIndex(
      (resolution) => resolution.reserved,
    )
    const reserved =
      reservedIndex === -1 ? undefined : filePaths[reservedIndex]?.pattern
    if (reserved) {
      log(
        "info",
        `"${request.permission}" targets ${reserved}, a reserved OpenCode path; leaving the prompt`,
      )
      record("skipped", "reserved OpenCode path — never auto-approved")
      return "left"
    }

    // --- The user's explicit rules come first. ---------------------------
    // Instance-wide gates flip the sidebar's server beacon as they fail and
    // heal, each clearing only its own pause; per-request faults further down
    // only annotate their own request.
    const config = await getConfig()
    if (!config) {
      warnOnce(
        "config-unreachable",
        "Approve for Me is paused: the OpenCode config could not be read.",
      )
      serverPaused(
        activityPath,
        "config",
        "the OpenCode config could not be read",
      )
      record("undecided", "config unreachable")
      return "left"
    }
    serverHealed(activityPath, "config")
    // The merged config `permission` block. The active agent's resolved rules
    // (below) already fold this in on the pinned hosts, so the veto rechecks
    // it only as a deliberate safety net, should /agent resolution ever drop it.
    const configRules = rulesFrom({
      permission: (config.permission && typeof config.permission === "object"
        ? config.permission
        : {}) as Store["permission"],
    })
    const preSlugStoreNames = preSlugStoreFiles ?? []
    const [legacyStoreExists, trustedStoreExists, worktreeStoreExists] =
      await Promise.all([
        pathExists(legacyStoreFile),
        pathExists(storeFile),
        worktreeStoreFile
          ? pathExists(worktreeStoreFile)
          : Promise.resolve(false),
      ])
    const preSlugStoreExists = await Promise.all(
      preSlugStoreNames.map((file) => pathExists(file)),
    )
    if (
      legacyStoreExists === undefined ||
      trustedStoreExists === undefined ||
      worktreeStoreExists === undefined ||
      preSlugStoreExists.includes(undefined)
    ) {
      warnOnce(
        "store-path-unreadable",
        "Approve for Me is paused: a permission-store path is unreadable.",
      )
      serverPaused(
        activityPath,
        "store",
        "a permission-store path is unreadable",
      )
      record("undecided", "permission store unreadable")
      return "left"
    }
    if (legacyStoreExists && !trustedStoreExists && !worktreeStoreExists) {
      warnOnce(
        "store-migration-required",
        `Approve for Me is paused: ${legacyStoreFile} is agent-writable and is no longer trusted. Review it and recreate the complete store at ${storeFile}.`,
      )
      serverPaused(activityPath, "store", "permission-store migration required")
      record("undecided", "store migration required")
      return "left"
    }
    let storeCorrupt = false
    const store = await readStore(storeFile, () => {
      storeCorrupt = true
    })
    if (storeCorrupt || !store) {
      warnOnce(
        "store-corrupt",
        `Approve for Me is paused: ${storeFile} is unreadable or invalid JSON.`,
      )
      serverPaused(
        activityPath,
        "store",
        "the permission store is unreadable or invalid JSON",
      )
      record("undecided", "permission store unreadable")
      return "left"
    }
    // A store still keyed by this worktree's own root — pre-repository-scope
    // data persist-permissions has not migrated yet, or its scope:
    // "worktree" — keeps counting until the file is gone. Its rules are kept
    // SEPARATE from the shared store's: each file is a self-contained
    // last-match-wins ruleset, and concatenating them would let an allow
    // appended in one cancel a carve-out the user wrote in the other.
    let worktreeStoreRules: Rule[] = []
    if (worktreeStoreFile && worktreeStoreExists) {
      let worktreeCorrupt = false
      const worktreeStore = await readStore(worktreeStoreFile, () => {
        worktreeCorrupt = true
      })
      if (worktreeCorrupt || !worktreeStore) {
        warnOnce(
          "store-corrupt",
          `Approve for Me is paused: ${worktreeStoreFile} is unreadable or invalid JSON.`,
        )
        serverPaused(
          activityPath,
          "store",
          "the permission store is unreadable or invalid JSON",
        )
        record("undecided", "permission store unreadable")
        return "left"
      }
      worktreeStoreRules = rulesFrom(worktreeStore)
    }
    // Stores still sitting at the pre-slug (bare-hash) names are veto-only
    // input, like any inactive candidate: adoption could not move them — a
    // dual-name conflict, or a still-running pre-slug instance recreating
    // them — and persist-permissions' fold machinery reconciles them
    // eventually, but their ask/deny carve-outs are the user's live policy
    // NOW, while an allow that exists only there answers nothing. Existence
    // is checked per request (above), so a file recreated after init is still
    // honored. Each file stays its own last-match-wins ruleset — never
    // concatenated, for the same reason the worktree store's rules are kept
    // separate.
    type StoreAuthorizationInput = {
      file: string
      exists: boolean
      rules: Rule[]
    }
    const preSlugStoreInputs: StoreAuthorizationInput[] = []
    for (const [index, file] of preSlugStoreNames.entries()) {
      if (preSlugStoreExists[index] !== true) {
        preSlugStoreInputs.push({ file, exists: false, rules: [] })
        continue
      }
      let preSlugCorrupt = false
      const preSlugStore = await readStore(file, () => {
        preSlugCorrupt = true
      })
      if (preSlugCorrupt || !preSlugStore) {
        warnOnce(
          "store-corrupt",
          `Approve for Me is paused: ${file} is unreadable or invalid JSON.`,
        )
        serverPaused(
          activityPath,
          "store",
          "the permission store is unreadable or invalid JSON",
        )
        record("undecided", "permission store unreadable")
        return "left"
      }
      preSlugStoreInputs.push({
        file,
        exists: true,
        rules: rulesFrom(preSlugStore),
      })
    }
    serverHealed(activityPath, "store")
    const storeRules = rulesFrom(store)

    // The ruleset OpenCode actually evaluated for this request: the active
    // agent's resolved rules plus the session's own, in that order. A
    // specific rule in either can be the sole reason this prompt exists, so
    // when any part cannot be established the plugin fails closed instead of
    // judging with weaker rules.
    const context = await requestContext(request.sessionID)
    if (!context.agent) {
      log(
        "warn",
        `the active agent for session ${request.sessionID} is unknown; leaving ${headline(request)} to the user`,
      )
      record("undecided", "active agent unknown")
      return "left"
    }
    const [rulesOfAgent, rulesOfSession] = await Promise.all([
      agentRules(context.agent),
      sessionRules(request.sessionID),
    ])
    if (!rulesOfAgent) {
      warnOnce(
        `agent-rules:${context.agent}`,
        `Approve for Me is paused: the resolved ruleset for agent "${context.agent}" could not be read.`,
      )
      record("undecided", "agent ruleset unreadable")
      return "left"
    }
    if (!rulesOfSession) {
      log(
        "warn",
        `the session rules for ${request.sessionID} could not be read; leaving ${headline(request)} to the user`,
      )
      record("undecided", "session rules unreadable")
      return "left"
    }
    const effectiveRules = [...rulesOfAgent, ...rulesOfSession]

    const veto =
      explicitCarveOut(request.permission, request.patterns, effectiveRules) ??
      explicitCarveOut(request.permission, request.patterns, configRules) ??
      storeCarveOut(request.permission, request.patterns, storeRules) ??
      storeCarveOut(request.permission, request.patterns, worktreeStoreRules) ??
      preSlugStoreInputs.reduce<ReturnType<typeof storeCarveOut>>(
        (found, candidate) =>
          found ??
          storeCarveOut(request.permission, request.patterns, candidate.rules),
        undefined,
      )
    if (veto) {
      log(
        "info",
        `explicit rule "${veto.pattern}": "${veto.action}" vetoes auto-approve for ${headline(request)}`,
      )
      record("skipped", `your rule "${veto.pattern}": ${veto.action}`)
      return "left"
    }
    // Which candidate is the ACTIVE store — the file persist-permissions
    // actually reads, answers from, and writes to — follows the scope
    // setting, which must mirror that plugin's own option. The other
    // candidate stays veto-only: its carve-outs still block (above), but an
    // allow that exists only in an INACTIVE store answers nothing — skipping
    // classification for it would leave the prompt hanging on a plugin that
    // never reads that file.
    const active =
      settings.scope === "worktree" && worktreeStoreFile
        ? { file: worktreeStoreFile, rules: worktreeStoreRules }
        : { file: storeFile, rules: storeRules }
    if (isAllowed(request.permission, request.patterns, active.rules)) {
      // The user already always-allowed this; persist-permissions (whose
      // store this is) re-approves it without spending a model call.
      log(
        "info",
        `store already allows ${headline(request)}; deferring to persist-permissions`,
      )
      record("skipped", "allowed by permissions.local.json")
      return "left"
    }

    type ApprovalPolicyInputs = {
      settings: Pick<ResolvedSettings, "permissions" | "scope">
      enabled: boolean
      settingsPaths: {
        legacy: boolean
        trustedProject: boolean
        preSlug: boolean
      }
      reservedPaths: Awaited<ReturnType<typeof readReservedPaths>>
      configRules: Rule[]
      agent: string
      agentRules: Rule[]
      sessionRules: Rule[]
      legacyStore: { file: string; exists: boolean }
      stores: StoreAuthorizationInput[]
      activeStore: string
    }
    const approvalPolicyFingerprint = (
      inputs: ApprovalPolicyInputs,
    ): string | undefined => {
      const state = { lossy: false }
      const fingerprint = stableStringify(inputs, state)
      return state.lossy ? undefined : fingerprint
    }
    const initialApprovalPolicyFingerprint = approvalPolicyFingerprint({
      settings: { permissions: settings.permissions, scope: settings.scope },
      enabled,
      settingsPaths: {
        legacy: legacyExists,
        trustedProject: trustedProjectExists,
        preSlug: preSlugSettingsExists,
      },
      reservedPaths: reservedPathsState,
      configRules,
      agent: context.agent,
      agentRules: rulesOfAgent,
      sessionRules: rulesOfSession,
      legacyStore: { file: legacyStoreFile, exists: legacyStoreExists },
      stores: [
        { file: storeFile, exists: trustedStoreExists, rules: storeRules },
        ...(worktreeStoreFile
          ? [
              {
                file: worktreeStoreFile,
                exists: worktreeStoreExists,
                rules: worktreeStoreRules,
              },
            ]
          : []),
        ...preSlugStoreInputs,
      ],
      activeStore: active.file,
    })
    if (initialApprovalPolicyFingerprint === undefined) {
      log(
        "warn",
        `the approval policy for ${headline(request)} could not be fingerprinted without loss; leaving the prompt`,
      )
      record("undecided", "approval policy could not be verified")
      return "left"
    }

    // --- Unknown tools must show the judge something concrete. -------------
    // MCP and code-mode permissions arrive under the tool's own name with
    // patterns ["*"] and empty metadata; the call's arguments are recovered
    // through the event's tool pointer instead. When nothing concrete can be
    // shown — no real patterns, no metadata, no recoverable arguments — the
    // request is never classified: approving an opaque third-party action on
    // the strength of its name alone is exactly what fail-closed forbids.
    let callInput: unknown
    if (!Object.hasOwn(TOOL_CATALOG, request.permission)) {
      callInput = await pendingCallInput(request)
      const metadataEmpty =
        request.metadata === undefined ||
        (typeof request.metadata === "object" &&
          request.metadata !== null &&
          Object.keys(request.metadata).length === 0)
      const concrete =
        callInput !== undefined ||
        !metadataEmpty ||
        request.patterns.some((pattern) => pattern !== "*")
      if (!concrete) {
        log(
          "info",
          `third-party tool ${headline(request)} shows no arguments; leaving the prompt`,
        )
        record("skipped", "third-party tool call with no visible arguments")
        return "left"
      }
    }

    // --- Ask the classifier. ----------------------------------------------
    const projectGuidance = await readProjectGuidance(controller.signal)
    const readTreeModel = (): Promise<SessionModelReadResult> =>
      readTrustedSessionModel(sessionModelsDir, treeKey)
    const resolveTreeJudge = async (
      treeModel: SessionModelReadResult,
      inheritedSettings: ResolvedSettings,
      inheritedConfigModel: unknown,
      modelContext: { model?: ModelRef },
    ): Promise<ModelResolution> => {
      let selectedSettings = inheritedSettings
      let selectedConfigModel = inheritedConfigModel
      if (
        treeModel.status === "valid" &&
        treeModel.record.mode === "override"
      ) {
        const { model, variant } = treeModel.record
        selectedSettings = {
          ...inheritedSettings,
          model: model ?? undefined,
          variant: variant ?? undefined,
        }
        // An explicit override with no pin means the requesting session's
        // model at its default effort, not the configured project model.
        if (model === null) selectedConfigModel = undefined
      }
      return resolveModel(selectedSettings, selectedConfigModel, modelContext)
    }
    const modelSelectionFingerprint = (
      treeModel: SessionModelReadResult,
      resolution: ModelResolution,
    ): string | undefined => {
      const state = { lossy: false }
      const fingerprint = stableStringify(
        [semanticTreeModel(treeModel), resolution.judge ?? null],
        state,
      )
      return state.lossy ? undefined : fingerprint
    }
    const semanticTreeModel = (treeModel: SessionModelReadResult) =>
      treeModel.status === "valid"
        ? {
            status: "valid" as const,
            mode: treeModel.record.mode,
            model: treeModel.record.model,
            variant: treeModel.record.variant,
          }
        : treeModel
    type CurrentApprovalInputs = {
      treeModel: SessionModelReadResult
      settings: ResolvedSettings
      configModel: unknown
      contextModel?: ModelRef
      enabled: boolean
      approvalPolicyFingerprint: string
    }
    const modelInputsFingerprint = (
      inputs: CurrentApprovalInputs,
    ): string | undefined => {
      const state = { lossy: false }
      const fingerprint =
        inputs.treeModel.status === "valid" &&
        inputs.treeModel.record.mode === "override"
          ? stableStringify(
              [semanticTreeModel(inputs.treeModel), inputs.enabled],
              state,
            )
          : stableStringify(
              [
                semanticTreeModel(inputs.treeModel),
                inputs.settings.model ?? null,
                inputs.settings.variant ?? null,
                inputs.configModel ?? null,
                inputs.contextModel ?? null,
                inputs.enabled,
              ],
              state,
            )
      return state.lossy ? undefined : fingerprint
    }
    const treeModel = await readTreeModel()
    if (treeModel.status === "invalid") {
      log(
        "warn",
        `the classifier model selection for prompt tree ${treeKey} is unreadable or invalid; leaving ${headline(request)} to the user`,
      )
      record("undecided", "session classifier model selection unreadable")
      return "left"
    }
    const resolution = await resolveTreeJudge(
      treeModel,
      settings,
      config.model,
      context,
    )
    if (resolution.failure) {
      record("undecided", "classifier model unavailable")
      return "left"
    }
    const judge = resolution.judge
    if (!judge) {
      log(
        "info",
        `no classifier model could be resolved for ${headline(request)}; leaving the prompt`,
      )
      record("undecided", "no classifier model")
      return "left"
    }
    const modelFingerprint = modelSelectionFingerprint(treeModel, resolution)
    if (modelFingerprint === undefined) {
      log(
        "warn",
        `the classifier model selection for prompt tree ${treeKey} could not be fingerprinted without loss; leaving ${headline(request)} to the user`,
      )
      record("undecided", "classifier model selection could not be verified")
      return "left"
    }
    const readCurrentApprovalInputs = async (): Promise<
      CurrentApprovalInputs | undefined
    > => {
      // All potentially remote host reads come first. Trusted files and
      // canonical path checks are read afterward, leaving no remote await
      // between the final complete snapshot and stack admission.
      const currentContext = await fresh(`history:${request.sessionID}`, () =>
        fetchSessionHistory(request.sessionID),
      )
      const currentConfig = await fresh("config", fetchConfig)
      if (!currentConfig) {
        serverPaused(
          activityPath,
          "config",
          "the OpenCode config could not be read",
        )
        return undefined
      }
      serverHealed(activityPath, "config")
      const historyModel = currentContext?.last?.model
      const cachedContext = sessionContext.get(request.sessionID)
      const cachedModel = cachedContext?.model
      if (
        historyModel &&
        cachedModel &&
        (historyModel.providerID !== cachedModel.providerID ||
          historyModel.modelID !== cachedModel.modelID)
      )
        return undefined
      const historyAgent = currentContext?.last?.agent
      const cachedAgent = cachedContext?.agent
      if (historyAgent && cachedAgent && historyAgent !== cachedAgent)
        return undefined
      const currentAgent = historyAgent ?? cachedAgent
      if (!currentAgent) return undefined
      const [currentAgentRules, currentSessionRules] = await Promise.all([
        fresh("agents", () => fetchAgentRules(currentAgent)),
        fresh(`session-rules:${request.sessionID}`, () =>
          fetchSessionRules(request.sessionID),
        ),
      ])
      if (!currentAgentRules || !currentSessionRules) return undefined

      const [
        currentLegacyExists,
        currentTrustedProjectExists,
        currentPreSlugSettingsExists,
      ] = await Promise.all([
        pathExists(legacySettingsFile),
        pathExists(projectSettingsFile),
        pathExists(preSlugProjectSettingsPath),
      ])
      if (
        currentLegacyExists === undefined ||
        currentTrustedProjectExists === undefined ||
        currentPreSlugSettingsExists === undefined ||
        (currentLegacyExists && !currentTrustedProjectExists) ||
        currentPreSlugSettingsExists
      )
        return undefined
      const currentSnapshot = await readPolicySnapshot({
        configDir,
        projectSettingsFile,
        blessPath,
        legacyGlobalFile: globalSettingsFile,
        directory,
        projectRoot,
        configRoot,
        packageDir,
      })
      const currentSettings = resolveSettings(currentSnapshot.settings ?? {})
      const currentOverride = overridePath
        ? await readOverride(overridePath)
        : undefined
      const currentTreeModel = await readTreeModel()
      if (currentTreeModel.status === "invalid" || currentSnapshot.fault)
        return undefined

      const currentEnabled = currentOverride?.enabled ?? currentSettings.enabled
      if (
        !currentEnabled ||
        (Object.hasOwn(currentSettings.permissions, request.permission) &&
          currentSettings.permissions[request.permission] === false)
      )
        return undefined

      const currentReservedPaths = await readReservedPaths()
      if (currentReservedPaths.some((resolution) => resolution.reserved))
        return undefined

      const [
        currentLegacyStoreExists,
        currentTrustedStoreExists,
        currentWorktreeStoreExists,
      ] = await Promise.all([
        pathExists(legacyStoreFile),
        pathExists(storeFile),
        worktreeStoreFile
          ? pathExists(worktreeStoreFile)
          : Promise.resolve(false),
      ])
      const currentPreSlugStoreExists = await Promise.all(
        preSlugStoreNames.map((file) => pathExists(file)),
      )
      if (
        currentLegacyStoreExists === undefined ||
        currentTrustedStoreExists === undefined ||
        currentWorktreeStoreExists === undefined ||
        currentPreSlugStoreExists.includes(undefined) ||
        (currentLegacyStoreExists &&
          !currentTrustedStoreExists &&
          !currentWorktreeStoreExists)
      ) {
        serverPaused(
          activityPath,
          "store",
          "the permission store could not be revalidated",
        )
        return undefined
      }
      const readCurrentStoreRules = async (
        file: string,
      ): Promise<Rule[] | undefined> => {
        let corrupt = false
        const currentStore = await readStore(file, () => {
          corrupt = true
        })
        return corrupt || !currentStore ? undefined : rulesFrom(currentStore)
      }
      const currentStoreRules = await readCurrentStoreRules(storeFile)
      const currentWorktreeStoreRules = worktreeStoreFile
        ? await readCurrentStoreRules(worktreeStoreFile)
        : []
      const currentPreSlugStoreInputs: StoreAuthorizationInput[] = []
      for (const [index, file] of preSlugStoreNames.entries()) {
        const rules = await readCurrentStoreRules(file)
        if (!rules) {
          serverPaused(
            activityPath,
            "store",
            "the permission store is unreadable or invalid JSON",
          )
          return undefined
        }
        currentPreSlugStoreInputs.push({
          file,
          exists: currentPreSlugStoreExists[index] === true,
          rules,
        })
      }
      if (!currentStoreRules || !currentWorktreeStoreRules) {
        serverPaused(
          activityPath,
          "store",
          "the permission store is unreadable or invalid JSON",
        )
        return undefined
      }
      serverHealed(activityPath, "store")
      const currentConfigRules = rulesFrom({
        permission: (currentConfig.permission &&
        typeof currentConfig.permission === "object"
          ? currentConfig.permission
          : {}) as Store["permission"],
      })
      const currentActiveStore =
        currentSettings.scope === "worktree" && worktreeStoreFile
          ? worktreeStoreFile
          : storeFile
      const currentApprovalPolicyFingerprint = approvalPolicyFingerprint({
        settings: {
          permissions: currentSettings.permissions,
          scope: currentSettings.scope,
        },
        enabled: currentEnabled,
        settingsPaths: {
          legacy: currentLegacyExists,
          trustedProject: currentTrustedProjectExists,
          preSlug: currentPreSlugSettingsExists,
        },
        reservedPaths: currentReservedPaths,
        configRules: currentConfigRules,
        agent: currentAgent,
        agentRules: currentAgentRules,
        sessionRules: currentSessionRules,
        legacyStore: {
          file: legacyStoreFile,
          exists: currentLegacyStoreExists,
        },
        stores: [
          {
            file: storeFile,
            exists: currentTrustedStoreExists,
            rules: currentStoreRules,
          },
          ...(worktreeStoreFile
            ? [
                {
                  file: worktreeStoreFile,
                  exists: currentWorktreeStoreExists,
                  rules: currentWorktreeStoreRules,
                },
              ]
            : []),
          ...currentPreSlugStoreInputs,
        ],
        activeStore: currentActiveStore,
      })
      if (currentApprovalPolicyFingerprint === undefined) return undefined
      return {
        treeModel: currentTreeModel,
        settings: currentSettings,
        configModel: currentConfig.model,
        contextModel: historyModel ?? cachedModel,
        enabled: currentEnabled,
        approvalPolicyFingerprint: currentApprovalPolicyFingerprint,
      }
    }
    const readCurrentApprovalFingerprints = async (): Promise<
      { model: string; approvalPolicy: string } | undefined
    > => {
      const current = await readCurrentApprovalInputs()
      if (!current) return undefined
      const inputsFingerprint = modelInputsFingerprint(current)
      if (inputsFingerprint === undefined) return undefined
      const currentResolution = await resolveTreeJudge(
        current.treeModel,
        current.settings,
        current.configModel,
        { model: current.contextModel },
      )
      if (currentResolution.failure || !currentResolution.judge)
        return undefined
      // Provider/catalog resolution is asynchronous. Verify the trusted
      // model and authorization inputs again afterward so an edit during that
      // window cannot combine stale policy with a newer catalog response.
      const verified = await readCurrentApprovalInputs()
      const verifiedFingerprint = verified
        ? modelInputsFingerprint(verified)
        : undefined
      if (
        verifiedFingerprint === undefined ||
        verifiedFingerprint !== inputsFingerprint ||
        verified?.approvalPolicyFingerprint !==
          current.approvalPolicyFingerprint
      )
        return undefined
      const currentModelFingerprint = modelSelectionFingerprint(
        current.treeModel,
        currentResolution,
      )
      return currentModelFingerprint === undefined
        ? undefined
        : {
            model: currentModelFingerprint,
            approvalPolicy: current.approvalPolicyFingerprint,
          }
    }
    // The tool trail carries full titles (a shell title is the whole command
    // line, a webfetch title the URL) only when the judge IS the session's
    // own model — that provider already processes the entire session. Any
    // other judge (a pinned model, the config default) gets tool names only:
    // pinning a judge must not quietly forward historical commands to a
    // provider that never saw them.
    const judgeSeesSession =
      !!context.model &&
      judge.model.providerID === context.model.providerID &&
      judge.model.modelID === context.model.modelID
    const toolTitles = context.toolCalls?.map((call) =>
      judgeSeesSession && call.title
        ? `${call.tool}: ${call.title}`
        : call.tool,
    )
    const judgeLabel = `${formatModelRef(judge.model)}${judge.variant ? ` (${judge.variant})` : ""}`
    const slot = classifierPool.acquire(
      settings.maxConcurrent,
      controller.signal,
    )
    if (slot === false) {
      log(
        "warn",
        `the classification queue is full; leaving ${headline(request)} to the user`,
      )
      record("undecided", "classifier busy")
      return "left"
    }
    if (slot !== true) {
      // Every slot is judging an earlier prompt. Wait in line — the prompt is
      // already on screen, and the user answering it settles the matter. One
      // notify toast per request: this one replaces, not precedes, the
      // "evaluating" toast.
      log(
        "info",
        `all classifier slots are busy; queueing ${headline(request)}`,
      )
      record("evaluating", "waiting for a free classifier slot")
      if (settings.notify)
        toast("info", `Approve for Me queued ${headline(request)}…`)
      // Resolved false: answered (or superseded) while waiting. The waiter
      // already left the queue holding nothing — there is no slot to release,
      // and no verdict may be recorded over the user's decision.
      if (!(await slot)) return "left"
    }
    let verdict: Verdict | undefined
    let failure: string | undefined
    try {
      // Answered by the user (or superseded) while waiting: the slot goes
      // straight back, and no verdict is recorded over their decision.
      if (controller.signal.aborted) return "left"
      if (slot === true && settings.notify) {
        // The prompt is already on screen — the host publishes it before any
        // plugin can react — so say the classifier is on it rather than leave
        // the user staring at an unexplained pause.
        toast("info", `Approve for Me is evaluating ${headline(request)}…`)
      }
      record("evaluating", judgeLabel)
      ;({ verdict, failure } = await classify(
        {
          permission: request.permission,
          patterns: request.patterns,
          title: request.title,
          metadata: request.metadata,
          callInput,
          directory: root,
          task: context.task,
          userMessages: context.userMessages,
          userMessagesTruncated: context.userMessagesTruncated,
          toolTitles,
          subtask: context.subtask,
          projectGuidance,
        },
        judge,
        settings.timeoutMs,
        controller.signal,
      ))
    } finally {
      classifierPool.release()
    }

    if (!verdict) {
      // Timeout, user answered first, model error, or an unparseable verdict:
      // all fail closed. The prompt is still on screen; nothing to undo.
      // A user answer settles the sidebar item on its own — recording over it
      // would be a ghost annotation on a prompt that no longer exists.
      // The cause rides the annotation the way a surfaced verdict's reason
      // does: "could not evaluate" alone leaves the user guessing what broke.
      if (!controller.signal.aborted) {
        record(
          "undecided",
          failure ? `could not evaluate — ${failure}` : "could not evaluate",
          armUnattendedDeny(request, settings, activityPath),
        )
        if (settings.notify)
          toast(
            "info",
            `Approve for Me could not evaluate ${headline(request)}${failure ? ` (${failure})` : ""} — your call.`,
          )
      }
      return "left"
    }
    // The verdict carries the model's risk/authorization assessment; the
    // approve/surface policy over those axes is enforced here in code. A
    // model "approve" that the matrix forbids surfaces like any other.
    const assessment = `${verdict.risk} risk, ${verdict.authorization === "none" ? "no user assent" : `${verdict.authorization} user assent`}`
    if (enforcedDecision(verdict) !== "approve") {
      // When the matrix overrode a model "approve", the reason text explains
      // an approval that did not happen — lead with the assessment so the
      // sidebar line is not misleading. A genuine surface keeps the model's
      // reason front and center (the sidebar clips long lines).
      const overridden = verdict.decision === "approve"
      const annotation = overridden
        ? `${assessment} — ${verdict.reason || "policy requires your approval"}`
        : verdict.reason || assessment
      log(
        "info",
        `classifier surfaced ${headline(request)} (${assessment}${overridden ? "; model decision overridden by policy" : ""}): ${verdict.reason}`,
      )
      record(
        "surfaced",
        annotation,
        armUnattendedDeny(request, settings, activityPath),
      )
      if (settings.notify) {
        toast(
          "info",
          `Needs your approval${verdict.reason ? ` — ${verdict.reason}` : ""}`,
        )
      }
      return "left"
    }
    // Revalidate before every release attempt. A parked approval awaits the
    // prompts above it, so both its model pin and its stack position can move
    // while it sleeps. Once releaseTurn() says true, stay synchronous through
    // plugin attribution and initiation of the host reply: no later event may
    // insert a prompt above this one in that gap.
    for (;;) {
      if (disposed || controller.signal.aborted) return "left"
      const currentFingerprints = await readCurrentApprovalFingerprints()
      if (currentFingerprints === undefined) {
        log(
          "info",
          `the classifier model selection or approval policy for prompt tree ${treeKey} could not be revalidated while ${headline(request)} was being evaluated; leaving the prompt`,
        )
        record(
          "undecided",
          "classifier model selection or approval policy could not be revalidated",
        )
        return "left"
      }
      if (
        currentFingerprints.model !== modelFingerprint ||
        currentFingerprints.approvalPolicy !== initialApprovalPolicyFingerprint
      ) {
        log(
          "info",
          `the classifier model selection or approval policy for prompt tree ${treeKey} changed while ${headline(request)} was being evaluated; leaving the prompt`,
        )
        record(
          "undecided",
          "classifier model selection or approval policy changed while evaluating",
        )
        return "left"
      }
      if (disposed || controller.signal.aborted) return "left"
      const releasing = releaseTurn()
      if (releasing === true) break
      record(
        "evaluating",
        "approval ready — waiting for the prompts above to be decided",
      )
      if (!(await releasing)) return "left"
    }
    if (disposed || controller.signal.aborted) return "left"
    // Registered BEFORE the POST: the host publishes the replied event while
    // the reply is still resolving, and this plugin-authored approval must
    // not read as the user answering (which would reset the tree's
    // unattended-deny budget). A refused reply unregisters below — if the
    // refusal was a lost race with the user's own answer, that one answer
    // merely skips the reset, which only errs toward fewer timed denies.
    pluginReplied.add(request.id)
    trim(pluginReplied)
    if (await reply(request)) {
      // Recorded only after the host accepted the reply, so a lost race with
      // the user's own answer can never be labeled as a classifier approval.
      record("approved", verdict.reason)
      if (!disposed && settings.journal) {
        // Journaled by the narrowest persistent pattern, exactly what a store
        // rule for this approval would say. A synthesized "*" contributes
        // nothing: no pattern information must never accrue as "everything".
        // The journal names the ACTIVE store, so rules the enshrine skill
        // later writes land in the file persist-permissions really reads
        // under the configured scope.
        journalApproval(
          journalPath,
          paths.preSlugJournalPath,
          projectRoot,
          active.file,
          request.permission,
          narrowestPatterns(
            request.always,
            request.synthesized ? [] : request.patterns,
          ),
          verdict.risk,
        )
      }
      log(
        "info",
        `auto-approved ("once") ${headline(request)} with ${judgeLabel} (${assessment}): ${verdict.reason}`,
      )
      if (settings.notify) toast("success", `Approved ${headline(request)}`)
      return "approved"
    }
    pluginReplied.delete(request.id)
    if (!controller.signal.aborted) {
      record(
        "undecided",
        "could not answer the prompt",
        armUnattendedDeny(request, settings, activityPath),
      )
    }
    return "left"
  }

  // --- Batch-parallel, release-serial scheduling ---------------------------
  // Classification per prompt tree (a root session plus its sub-agent
  // descendants) proceeds one BATCH at a time, in the order the host TUI
  // presents prompts (compareStackOrder). A batch is one assistant turn's
  // tool calls — the prompts sharing that turn's message id in their tool
  // pointer; a request without a pointer is a batch of one. Under the
  // default parallel mode the whole top-of-stack batch is judged
  // concurrently; under the serial opt-in a batch drains one prompt at a
  // time. Batches never interleave: the next batch starts only when every
  // prompt of the previous one has settled. Nothing is ever auto-approved
  // past a prompt the user has not decided: any job that ends "left"
  // (surfaced, vetoed, failed, feature inert) HOLDS its stack position and
  // stalls everything below it until an actual answer arrives. The scheduler
  // never preempts — a prompt that arrives sorting above an in-flight
  // classification waits for those verdicts — and a verdict is RELEASED only
  // while its prompt is again top-of-stack: an approval completed beneath an
  // undecided prompt (a newer, higher arrival — or simply its own
  // batch-mates still being judged above it) is parked (holding its
  // position, blocking everything below) until everything above settles, so
  // replies always land strictly one at a time, in exact stack order.
  let ancestryPauseGeneration = 0
  const onAncestryBlockedChange = (blocked: boolean) => {
    if (disposed) return
    const generation = ++ancestryPauseGeneration
    const changed = updateServerPause(
      "ancestry",
      blocked ? "a pending prompt's session ancestry is unresolved" : undefined,
    )
    if (!changed) return
    void hostPaths.then((paths) => {
      if (
        disposed ||
        generation !== ancestryPauseGeneration ||
        "error" in paths
      )
        return
      flushActivity(paths.activityPath)
    })
  }
  const scheduler = createBatchScheduler({
    handle,
    headline,
    log,
    maxQueued: MAX_QUEUED,
    onAncestryBlockedChange,
    onJobFinished: (request) => {
      inFlight.delete(request.id)
    },
    readProcessingMode: async () => {
      const paths = await hostPaths
      if ("error" in paths) return "serial"
      const snapshot = await readPolicySnapshot({
        configDir: paths.configDir,
        projectSettingsFile: paths.projectSettingsFile,
        blessPath: paths.blessPath,
        legacyGlobalFile: paths.globalSettingsFile,
        directory,
        projectRoot: paths.projectRoot,
        configRoot,
        packageDir: paths.packageDir,
      })
      if (snapshot.fault) return "serial"
      return resolveSettings(snapshot.settings ?? {}).processing
    },
  })

  // The tree a session's prompts stack under: its root session. A parent
  // lookup that keeps failing after retries leaves the chain unauthoritative:
  // the caller must fail closed, because keying the request under a partial
  // root would split one TUI prompt tree into independently scheduled trees
  // and let a sibling be approved beneath this request's undecided prompt.
  const PARENT_LOOKUP_ATTEMPTS = 3
  const PARENT_LOOKUP_RETRY_MS = 200
  const resolveTreeKey = async (
    sessionID: string,
  ): Promise<{ key: string; authoritative: boolean }> => {
    const chain = [sessionID]
    let tail = sessionID
    let hops = 0
    for (;;) {
      let lookup: ParentLookup = { known: false }
      for (
        let attempt = 0;
        attempt < PARENT_LOOKUP_ATTEMPTS && !lookup.known;
        attempt++
      ) {
        if (attempt)
          await new Promise((wake) => setTimeout(wake, PARENT_LOOKUP_RETRY_MS))
        lookup = await getSessionParent(tail)
      }
      if (!lookup.known) return { key: tail, authoritative: false }
      if (!lookup.parent) return { key: tail, authoritative: true }
      if (chain.includes(lookup.parent))
        return { key: tail, authoritative: false }
      if (hops >= SESSION_ANCESTRY_HOP_LIMIT)
        return { key: tail, authoritative: false }
      hops += 1
      chain.push(lookup.parent)
      tail = lookup.parent
    }
  }

  // --- Stale-prompt sweeper ------------------------------------------------
  // Aborting a run kills its tool calls but leaks their pending permission
  // prompts on the pinned hosts: no permission.replied is published, the
  // orphans sit in /permission and every TUI's prompt stack until the
  // instance restarts, answering them drives nothing — and a user's reject
  // on one CASCADES onto live prompts of the session's next turn. Once a
  // session with unanswered asks settles, and EVERY one of its pending
  // prompts verifiably belongs to a dead tool call, one reject clears them
  // all (the host's own same-session cascade sweeps the siblings). Reject
  // and never approve: rejecting a dead prompt grants nothing, while a
  // session with any live or unverifiable prompt is never touched.
  const SWEEP_SETTLE_MS = 1_000
  // A sweep that could not run or complete retries on this ladder, re-running
  // every safety check each time: the aborted session is already idle and may
  // never emit another idle event, so a transient failure (settings briefly
  // unreadable, an API hiccup, a tool part not yet settled) must not orphan
  // its prompts forever. Bounded: a session still unswept after the ladder
  // keeps its prompts until a fresh idle or answer.
  const SWEEP_RETRY_MS = [2_000, 10_000, 30_000, 90_000, 240_000]
  const sweepTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** requestID → sessionID for asks seen and not yet answered. */
  const askedSessions = new Map<string, string>()
  /** sessionID → count of fresh asks seen: the sweeper's race guard. */
  const askCounters = new Map<string, number>()
  /** Deleted session IDs are terminal; stale async work may never act on them. */
  const deletedSessions = new Set<string>()
  let sweeps: Promise<void> = Promise.resolve()
  // The trusted settings chain for actions that run without a fresh
  // permission event to re-read settings for them — the stale sweeper and
  // the unattended-deny timer. Same chain as classification, failing closed
  // on anything unreadable, and honoring the instance toggle: undefined
  // means "do nothing right now". The override rides along so the deny
  // timer can compare its write time against a deadline's arm time. The
  // chain itself lives in shared.ts (readEffectiveSettings) so the
  // The limits-plugin interop reads it through the same definition.
  const backgroundSettings = async (): Promise<
    EffectiveSettings | undefined
  > => {
    const paths = await hostPaths
    if ("error" in paths) return undefined
    return readEffectiveSettings({
      paths,
      legacyProjectFile: legacySettingsFile,
      directory,
      configRoot,
      packageDir: paths.packageDir,
    })
  }

  // Whether sweeping is allowed right now.
  const sweepConfig = async (): Promise<{ notify: boolean } | undefined> => {
    const state = await backgroundSettings()
    if (!state?.settings.sweepStale) return undefined
    return { notify: state.settings.notify }
  }

  // The pointed-to tool call's part status, or undefined when it cannot be
  // established — which keeps its whole session off-limits.
  const toolCallStatus = async (
    request: Request,
  ): Promise<string | undefined> => {
    if (!request.toolCall) return undefined
    try {
      const message = (await api(
        "GET",
        `/session/${request.sessionID}/message/${request.toolCall.messageID}`,
      )) as { parts?: unknown }
      if (!Array.isArray(message?.parts)) return undefined
      const part = message.parts.find(
        (candidate): candidate is { state?: unknown } =>
          !!candidate &&
          typeof candidate === "object" &&
          (candidate as { type?: unknown }).type === "tool" &&
          (candidate as { callID?: unknown }).callID ===
            request.toolCall?.callID,
      )
      const status =
        part?.state && typeof part.state === "object"
          ? (part.state as { status?: unknown }).status
          : undefined
      return typeof status === "string" ? status : undefined
    } catch {
      return undefined
    }
  }

  // "done": swept, nothing to sweep, or a fresh turn owns the session now (a
  // new idle event will re-schedule). "retry": a condition that may recover
  // without any further event — sweeping disabled or settings unreadable
  // right now, an API failure, a tool part not yet settled — re-runs on the
  // retry ladder with every check repeated from scratch.
  const sweepSession = async (sessionID: string): Promise<"done" | "retry"> => {
    try {
      if (disposed || deletedSessions.has(sessionID)) return "done"
      const config = await sweepConfig()
      if (!config) return "retry"
      const paths = await hostPaths
      if ("error" in paths) return "done"
      // The snapshot generation: any fresh ask after this point means a live
      // turn raced the sweep, and the reject below must not fire.
      const generation = askCounters.get(sessionID) ?? 0
      const pending = (await api("GET", "/permission")) as unknown
      if (!Array.isArray(pending)) return "retry"
      const mine = pending
        .map((entry) => normalizeRequest(entry))
        .filter(
          (entry): entry is Request => !!entry && entry.sessionID === sessionID,
        )
      if (!mine.length) return "done"
      // EVERY pending prompt of the session must verifiably belong to a dead
      // tool call — the reject below cascades session-wide, so one live or
      // unverifiable prompt keeps the whole session off-limits.
      for (const request of mine) {
        const status = await toolCallStatus(request)
        if (status !== "error" && status !== "completed") return "retry"
      }
      // And the session must still be settled when the reject fires: prompts
      // of a freshly started turn must never be caught in the cascade.
      const statuses = (await api("GET", "/session/status")) as
        | Record<string, { type?: unknown }>
        | undefined
      const current =
        statuses && typeof statuses === "object"
          ? statuses[sessionID]
          : undefined
      if (
        current &&
        typeof current === "object" &&
        (current as { type?: unknown }).type !== "idle"
      )
        return "done"
      // Narrowing the check-to-act window: re-list right before acting and
      // refuse if any prompt exists beyond the verified snapshot; a subset is
      // fine (an answer landed meanwhile). This cannot be fully atomic — the
      // host offers no conditional reject — but with the generation guard
      // below the remaining window is a single event-loop turn.
      const relisted = (await api("GET", "/permission")) as unknown
      if (!Array.isArray(relisted)) return "retry"
      const verified = new Set(mine.map((request) => request.id))
      const remaining = relisted
        .map((entry) => normalizeRequest(entry))
        .filter(
          (entry): entry is Request => !!entry && entry.sessionID === sessionID,
        )
      if (remaining.some((entry) => !verified.has(entry.id))) return "done"
      const first = remaining[0]
      if (!first) return "done"
      if (disposed || deletedSessions.has(sessionID)) return "done"
      if ((askCounters.get(sessionID) ?? 0) !== generation) return "done"
      for (const request of remaining) {
        recordActivity(
          paths.activityPath,
          request.id,
          "skipped",
          "stale — its tool call already ended; cleared",
        )
        // A sweep reject (and its cascade) is plugin-authored cleanup, not
        // the user answering — it must not reset any unattended-deny budget.
        pluginReplied.add(request.id)
      }
      trim(pluginReplied)
      await api("POST", `/permission/${first.id}/reply`, {
        reply: "reject",
      })
      log(
        "info",
        `swept ${remaining.length} stale prompt(s) of settled session ${sessionID}: ${remaining.map((request) => request.id).join(", ")}`,
      )
      if (config.notify) {
        toast(
          "info",
          `Cleared ${remaining.length} stale permission prompt${remaining.length === 1 ? "" : "s"} left by an aborted run.`,
        )
      }
      return "done"
    } catch (error) {
      log(
        "warn",
        `stale-prompt sweep for ${sessionID} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return "retry"
    }
  }

  const scheduleSweep = (sessionID: string, attempt = 0) => {
    // Retries re-enter here from the sweeps chain, which dispose() awaits —
    // without this guard a "retry" outcome could re-arm a timer after
    // dispose() already cleared them all.
    if (disposed) return
    if (classifierSessions.has(sessionID) || deletedSessions.has(sessionID))
      return
    let unansweredAsks = false
    for (const pendingSession of askedSessions.values()) {
      if (pendingSession !== sessionID) continue
      unansweredAsks = true
      break
    }
    if (!unansweredAsks) return
    const delay = attempt === 0 ? SWEEP_SETTLE_MS : SWEEP_RETRY_MS[attempt - 1]
    if (delay === undefined) {
      log(
        "warn",
        `giving up on sweeping session ${sessionID} after ${SWEEP_RETRY_MS.length} retries; its prompts stay until a fresh idle or answer`,
      )
      return
    }
    const existing = sweepTimers.get(sessionID)
    if (existing) clearTimeout(existing)
    sweepTimers.set(
      sessionID,
      setTimeout(() => {
        sweepTimers.delete(sessionID)
        sweeps = sweeps.then(async () => {
          if ((await sweepSession(sessionID)) === "retry")
            scheduleSweep(sessionID, attempt + 1)
        })
      }, delay),
    )
  }

  // --- Unattended-deny timer -----------------------------------------------
  // A prompt the classifier surfaces (or fails on) holds its whole prompt
  // tree until the user answers — by design, but with nobody at the keyboard
  // that stalls the session indefinitely on a question the agent could often
  // route around. After settings.unattendedDenyMs without an answer the
  // prompt is rejected WITH a message: on the pinned hosts a reject carrying
  // a message resolves the blocked tool call as PermissionCorrectedError,
  // which the session processor deliberately does not treat as turn-ending
  // (verified against the 1.18.5/1.18.6 sources — only the bare
  // RejectedError sets the blocked flag), so the agent reads the feedback
  // and can try another approach. The message says outright that the denial
  // was an automated timeout, not the user's judgment. Like the sweeper this
  // path can only ever REJECT — a timed deny grants nothing — and every
  // failed guard merely leaves the prompt waiting. The host cascades bare
  // rejects onto the session's other pending prompts SESSION-wide, not
  // batch-wide, exactly as a manual deny would — so before posting, the
  // deny proves every would-be casualty is the target's own batch-mate
  // under this plugin's management, and one prompt it cannot vouch for (a
  // reserved prompt, a stale survivor, a fresh turn's ask, anything
  // untracked) keeps the target waiting instead. The per-tree budget
  // (UNATTENDED_DENY_LIMIT, reset by any user-authored answer in the
  // tree) keeps an unattended agent from grinding through model spend by
  // re-approaching a question nobody is present to answer.
  let denials: Promise<void> = Promise.resolve()

  const unattendedMinutes = (delayMs: number): number =>
    Math.max(1, Math.round(delayMs / 60_000))

  const unattendedDenyMessage = (delayMs: number): string => {
    const minutes = unattendedMinutes(delayMs)
    return (
      `[Approve for Me] Nobody answered this permission prompt within ${minutes} minute${minutes === 1 ? "" : "s"} — ` +
      "the user appears to be away, so it was denied automatically. This is a timeout, not the user's judgment on the action. " +
      "Do not retry the same call. Take an approach that does not need this permission, or finish what you can and summarize what remains for the user."
    )
  }

  const denyUnattended = async (
    request: Request,
    treeKey: string,
    delayMs: number,
    activityPath: string,
    armedAt: number,
  ): Promise<void> => {
    if (
      disposed ||
      deletedSessions.has(request.sessionID) ||
      scheduler.isAnswered(request.id)
    )
      return
    // The same trusted settings chain as classification and sweeping — and
    // the feature must still be on: a disable, a toggle-off, or newly
    // unreadable settings mid-wait all win over the armed timer. The timer
    // never retries, so every declined fire below also drops the sidebar
    // countdown: the reject it promised is never coming.
    const state = await backgroundSettings()
    if (!state?.settings.unattendedDenyMs) {
      dropDeadline(activityPath, request.id)
      return
    }
    // An override stamped at or after arming proves the wait was
    // interrupted: the TUI toggle strictly flips, so a mid-wait write means
    // the plugin sat toggled off (or settings-disabled) somewhere along the
    // way — and a toggle-off disarms this deadline for good, re-enable or
    // not. Overrides from older TUI halves carry no stamp and simply keep
    // the fire-time enabled check as their only guard.
    if (state.override?.at !== undefined && state.override.at >= armedAt) {
      log(
        "info",
        `the instance toggle changed while ${headline(request)} waited; its deadline stays disarmed`,
      )
      dropDeadline(activityPath, request.id)
      return
    }
    if ((unattendedDenyCounts.get(treeKey) ?? 0) >= UNATTENDED_DENY_LIMIT) {
      dropDeadline(activityPath, request.id)
      return
    }
    // The snapshot generation, sweeper-style: any fresh ask in this session
    // past this point means a live turn raced the timer, and the reject
    // below must not fire.
    const generation = askCounters.get(request.sessionID) ?? 0
    // The host's pending list is the ground truth: only a prompt that is
    // still pending may be denied — an answer that raced the timer wins, and
    // an unreadable list leaves the prompt for the user (no retry ladder
    // here; a prompt kept waiting is exactly the pre-timer behavior).
    const pending = (await api("GET", "/permission")) as unknown
    if (!Array.isArray(pending)) {
      dropDeadline(activityPath, request.id)
      return
    }
    const mine = pending
      .map((entry) => normalizeRequest(entry))
      .filter((entry): entry is Request => !!entry)
    if (!mine.some((entry) => entry.id === request.id)) return
    // The host cascades bare rejects over the session's OTHER pending
    // prompts, unconfined to this prompt's batch — so this guard confines
    // it: every casualty must verifiably be the timer's to clear. That
    // means the target itself, or a batch-mate (same assistant turn)
    // either armed with its own deadline or still moving through this
    // scheduler (queued, being judged, or parked). Anything else — a
    // prompt the user reserved (held but never armed), a stale survivor of
    // an aborted turn, a fresh turn's ask in another batch, a prompt never
    // tracked here — leaves the target waiting instead: a kept prompt is
    // the pre-timer behavior, while one wrong cascade could reject a
    // reserved prompt or end a live turn.
    const casualties = mine.filter(
      (entry) => entry.sessionID === request.sessionID,
    )
    const batch = batchKeyOf(request)
    const foreign = casualties.find(
      (entry) =>
        entry.id !== request.id &&
        !(
          batchKeyOf(entry) === batch &&
          (unattendedDenyTimers.has(entry.id) ||
            scheduler.isManagedBatchMember(entry.id, treeKey))
        ),
    )
    if (foreign) {
      log(
        "info",
        `a same-session prompt (${headline(foreign)}) is not this deadline's to clear; ${headline(request)} stays for the user`,
      )
      dropDeadline(activityPath, request.id)
      return
    }
    // Narrowing the check-to-act window exactly like the sweeper: re-list
    // right before acting, refuse if any same-session prompt exists beyond
    // the verified set (a subset is fine — an answer landed meanwhile), and
    // refuse if a fresh ask moved the session's generation.
    const relisted = (await api("GET", "/permission")) as unknown
    if (!Array.isArray(relisted)) {
      dropDeadline(activityPath, request.id)
      return
    }
    const verified = new Set(casualties.map((entry) => entry.id))
    const remaining = relisted
      .map((entry) => normalizeRequest(entry))
      .filter(
        (entry): entry is Request =>
          !!entry && entry.sessionID === request.sessionID,
      )
    if (
      remaining.some((entry) => !verified.has(entry.id)) ||
      (askCounters.get(request.sessionID) ?? 0) !== generation
    ) {
      log(
        "info",
        `session ${request.sessionID} moved while the deadline fired; ${headline(request)} stays for the user`,
      )
      dropDeadline(activityPath, request.id)
      return
    }
    if (!remaining.some((entry) => entry.id === request.id)) return
    if (
      disposed ||
      deletedSessions.has(request.sessionID) ||
      scheduler.isAnswered(request.id)
    )
      return
    // Mark every casualty plugin-authored BEFORE posting — the host
    // publishes the replied events while the POST resolves, and none of
    // them may read as the user answering.
    for (const entry of casualties) pluginReplied.add(entry.id)
    trim(pluginReplied)
    try {
      await api("POST", `/permission/${request.id}/reply`, {
        reply: "reject",
        message: unattendedDenyMessage(delayMs),
      })
    } catch (error) {
      for (const entry of casualties) pluginReplied.delete(entry.id)
      log(
        "warn",
        `unattended deny failed for ${headline(request)}; the prompt stays for the user: ${error instanceof Error ? error.message : String(error)}`,
      )
      dropDeadline(activityPath, request.id)
      return
    }
    const count = (unattendedDenyCounts.get(treeKey) ?? 0) + 1
    unattendedDenyCounts.set(treeKey, count)
    trim(unattendedDenyCounts)
    const minutes = unattendedMinutes(delayMs)
    recordActivity(
      activityPath,
      request.id,
      "denied",
      `no answer for ${minutes} min — denied so the run can move on`,
    )
    for (const entry of casualties) {
      if (entry.id === request.id) continue
      recordActivity(
        activityPath,
        entry.id,
        "denied",
        "cleared by the deny cascade",
      )
    }
    log(
      "info",
      `denied ${headline(request)} after ${delayMs}ms without an answer (${casualties.length - 1} cascade mate(s); timed deny ${count}/${UNATTENDED_DENY_LIMIT} for tree ${treeKey})`,
    )
    if (state.settings.notify) {
      toast(
        "warning",
        `Approve for Me denied ${headline(request)} after ${minutes} min without an answer — the agent may try another way.`,
      )
      if (count >= UNATTENDED_DENY_LIMIT) {
        toast(
          "info",
          `That was timed deny ${UNATTENDED_DENY_LIMIT} of ${UNATTENDED_DENY_LIMIT} — further unanswered prompts in this session now wait for you.`,
        )
      }
    }
  }

  // Arms the timer for a prompt the classifier just left to the user, and
  // returns the deadline for the sidebar annotation. No timer when the
  // feature is off, the prompt is already answered, or the tree's budget is
  // spent. Deliberately NOT armed for prompts the user reserved for
  // themselves (rule vetoes, opt-outs, external_directory) or prompts seen
  // while the plugin is off or paused — the timer only covers what Approve
  // for Me tried to handle and could not approve.
  const armUnattendedDeny = (
    request: Request,
    settings: ResolvedSettings,
    activityPath: string,
  ): number | undefined => {
    if (disposed || !settings.unattendedDenyMs) return undefined
    if (scheduler.isAnswered(request.id)) return undefined
    const treeKey = scheduler.treeKeyFor(request.id) ?? request.sessionID
    if ((unattendedDenyCounts.get(treeKey) ?? 0) >= UNATTENDED_DENY_LIMIT) {
      log(
        "info",
        `the unattended-deny budget for this prompt tree is spent; ${headline(request)} waits for the user`,
      )
      return undefined
    }
    const delayMs = settings.unattendedDenyMs
    const armedAt = Date.now()
    const existing = unattendedDenyTimers.get(request.id)
    if (existing) clearTimeout(existing)
    unattendedDenyTimers.set(
      request.id,
      setTimeout(() => {
        unattendedDenyTimers.delete(request.id)
        // Serialized like sweeps, so dispose() can drain an in-flight deny
        // and two fires can never interleave their check-then-reject.
        denials = denials.then(() =>
          denyUnattended(
            request,
            treeKey,
            delayMs,
            activityPath,
            armedAt,
          ).catch((error) => {
            log(
              "warn",
              `unattended deny failed for ${headline(request)}: ${error instanceof Error ? error.message : String(error)}`,
            )
          }),
        )
      }, delayMs),
    )
    return armedAt + delayMs
  }

  const reconcileSessionModels = async (sessionModelsDir: string) => {
    const sessionApi = (
      client as {
        session?: {
          get?: (input: unknown) => Promise<{
            data?: unknown
            error?: unknown
            response?: { status?: number }
          }>
        }
      }
    ).session
    const get = sessionApi?.get?.bind(sessionApi)
    if (!get) return
    for (const record of await listTrustedSessionModels(sessionModelsDir)) {
      if (disposed) return
      const lookup = () =>
        get({
          path: { id: record.rootSessionID },
          query: { directory },
        })
      let result:
        | {
            data?: unknown
            error?: unknown
            response?: { status?: number }
          }
        | undefined
      for (let attempt = 0; attempt < 2 && !disposed; attempt++) {
        try {
          result = await withTimeout(() => lookup(), 10_000, {
            message: `session model reconciliation lookup for ${record.rootSessionID} timed out`,
          })
          break
        } catch {
          // One bounded retry covers transient startup failures without
          // turning reconciliation into a long-lived background process.
        }
      }
      if (disposed) return
      const errorName = (result?.error as { name?: unknown } | undefined)?.name
      if (
        result?.data !== undefined ||
        result?.response?.status !== 404 ||
        errorName !== "NotFoundError"
      )
        continue
      try {
        await clearTrustedSessionModelIfUnchanged(sessionModelsDir, record)
      } catch {
        // Retain records that cannot be safely cleared and keep reconciling.
      }
    }
  }

  // Reconciliation is deliberately deferred to the next task: plugin hooks
  // must be available before any host session lookup can begin.
  const sessionModelReconciliationTimer = setTimeout(() => {
    void hostPaths
      .then(async (paths) => {
        if (!disposed && !("error" in paths))
          await reconcileSessionModels(paths.sessionModelsDir)
      })
      .catch(() => {})
  }, 0)

  return {
    event: async ({ event }) => {
      if (disposed) return
      if (
        event.type === "tui.command.execute" &&
        (await locality.handle(event))
      )
        return
      const { type, properties } = event as {
        type?: string
        properties?: unknown
      }
      if (type === "tui.command.execute") {
        await hostPaths
        if (disposed) return
        if (await respondInstanceRequest(client, event, instanceID, directory))
          return
      }

      // Any permission event can mean the host's session state advanced past
      // what an in-flight coalesced read will return (a new ask arrives after
      // the tool part behind it was persisted). Bump the epoch so later
      // consumers start fresh reads instead of joining pre-event snapshots.
      if (typeof type === "string" && type.startsWith("permission."))
        advanceEpoch()

      if (type === "permission.asked" || type === "permission.updated") {
        const request = normalizeRequest(properties)
        if (!request) return
        if (
          classifierSessions.has(request.sessionID) ||
          deletedSessions.has(request.sessionID)
        )
          return
        const existing = inFlight.get(request.id)
        if (existing) {
          // A re-emission with identical content is idempotent. One whose
          // content CHANGED invalidates the verdict being computed — the
          // classifier is judging a snapshot the request no longer matches,
          // and its "once" reply would approve the new content sight unseen.
          // Abort; the prompt stays for the user. An UNVERIFIABLE comparison
          // (either side lossy — no fingerprint) is treated exactly like a
          // change: identity cannot be proven, so nothing may ride on it.
          const fingerprint = requestFingerprint(request)
          if (
            existing.fingerprint === undefined ||
            fingerprint === undefined ||
            existing.fingerprint !== fingerprint
          ) {
            log(
              "warn",
              `permission ${request.id} ${existing.fingerprint === undefined || fingerprint === undefined ? "could not be verified unchanged" : "changed"} while being classified; aborting fail-closed`,
            )
            existing.controller.abort(
              new Error("the request changed while being classified"),
            )
          }
          return
        }
        if (scheduler.isDecided(request.id)) return
        askedSessions.set(request.id, request.sessionID)
        trim(askedSessions)
        // A fresh ask moves the session's generation forward: a sweep whose
        // verified snapshot predates it must not fire its cascading reject.
        const previousAskCount = askCounters.get(request.sessionID) ?? 0
        askCounters.set(request.sessionID, previousAskCount + 1)
        trim(askCounters)
        const controller = new AbortController()
        // Registered synchronously so a permission.updated re-emission that
        // races this handler can never start a second classification.
        inFlight.set(request.id, {
          controller,
          fingerprint: requestFingerprint(request),
        })
        trim(inFlight)
        // Install the global fail-closed barrier before the first ancestry
        // await. Until this request has an authoritative tree, it could sort
        // above every prompt in every tree.
        if (!scheduler.beginAncestry(request, controller)) {
          inFlight.delete(request.id)
          askedSessions.delete(request.id)
          if (previousAskCount) {
            askCounters.set(request.sessionID, previousAskCount)
          } else {
            askCounters.delete(request.sessionID)
          }
          return
        }
        // Unawaited: the scheduling-mode read must not delay this prompt's
        // entry into the tree — when it lands changed, it re-pumps.
        void scheduler.refreshProcessingMode()
        const { key, authoritative } = await resolveTreeKey(request.sessionID)
        if (!authoritative) {
          // This prompt's place in the TUI stack cannot be established, so it
          // is never classified — and nothing anywhere may be approved while
          // it is pending: it could sort above any prompt in any tree.
          warnOnce(
            "ancestry-unknown",
            "Approve for Me is paused: a session's ancestry could not be read; pending prompts are yours until answered.",
          )
          log(
            "warn",
            `the ancestry of session ${request.sessionID} could not be established; leaving ${headline(request)} to the user and pausing approvals until it is answered`,
          )
          scheduler.holdUnresolvedAncestry(request, key, controller)
          return
        }
        // The scheduler's runaway backstop counts queued and judging work.
        const resolution = scheduler.resolveAncestry(request, key, controller)
        if (resolution.state === "cancelled") return
        if (resolution.state === "held") {
          // Fail closed — and hold the stack position: an unjudged prompt is
          // the user's to answer.
          if (!controller.signal.aborted)
            log(
              "warn",
              `the classification queue is full; leaving ${headline(request)} to the user`,
            )
          return
        }
        // Resolves when this request's turn came and went (or an answer made
        // its turn unnecessary) — the host dispatches events fire-and-forget,
        // so waiting here backs nothing up.
        await resolution.settled
        return
      }

      if (type === "permission.replied") {
        const props = (properties ?? {}) as Record<string, unknown>
        const id = props.requestID ?? props.permissionID
        if (typeof id !== "string") return
        // An answered prompt needs no unattended deny; and a reply this
        // plugin did NOT author means somebody is present — that resets the
        // prompt tree's timed-deny budget. (Read the tree key before the
        // bookkeeping below can drop it.)
        const denyTimer = unattendedDenyTimers.get(id)
        if (denyTimer) {
          clearTimeout(denyTimer)
          unattendedDenyTimers.delete(id)
          // The countdown annotation dies with the timer, returning the
          // entry to ordinary TTL aging (fire-and-forget: display only, and
          // awaiting paths here would reorder event bookkeeping; the
          // disposed check keeps a late event from re-flushing an activity
          // file dispose() already drained and cleared).
          void hostPaths.then((paths) => {
            if (!disposed && !("error" in paths))
              dropDeadline(paths.activityPath, id)
          })
        }
        const ownReply = pluginReplied.delete(id)
        // A reply the suite's own automation registered (persist-permissions
        // honoring a stored allow, say) is not the user either. Only a reply
        // attributed to nobody reads as human presence — that is what resets
        // the tree's timed-deny budget. Automation outside the suite cannot
        // register itself, so it still reads as the user: the ledger narrows
        // the spoof, host actor provenance would close it.
        const siblingReply = automatedReplies().delete(id)
        if (!ownReply && !siblingReply) {
          const budgetKey = scheduler.treeKeyFor(id)
          if (budgetKey) unattendedDenyCounts.delete(budgetKey)
        }
        // The user (or another plugin) answered: stop wasting the classifier's
        // time, make sure we never answer a settled prompt, and release the
        // stack position it may have been holding.
        askedSessions.delete(id)
        inFlight.get(id)?.controller.abort()
        scheduler.replied(id)
        return
      }

      if (type === "session.deleted") {
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
        if (!id || id !== id.trim()) return
        deletedSessions.add(id)
        trim(deletedSessions)

        // This event is terminal, not evidence that a person answered. Cancel
        // exact-session work directly instead of routing it through the reply
        // path that resets unattended-deny presence budgets.
        const requestIDs = new Set(scheduler.cancelSession(id))
        for (const [requestID, sessionID] of askedSessions) {
          if (sessionID === id) requestIDs.add(requestID)
        }
        let activityChanged = false
        for (const requestID of requestIDs) {
          inFlight
            .get(requestID)
            ?.controller.abort(new Error("the request's session was deleted"))
          inFlight.delete(requestID)
          askedSessions.delete(requestID)
          pluginReplied.delete(requestID)
          automatedReplies().delete(requestID)
          const denyTimer = unattendedDenyTimers.get(requestID)
          if (denyTimer) clearTimeout(denyTimer)
          unattendedDenyTimers.delete(requestID)
          activityChanged = activityEntries.delete(requestID) || activityChanged
        }
        const sweepTimer = sweepTimers.get(id)
        if (sweepTimer) clearTimeout(sweepTimer)
        sweepTimers.delete(id)
        askCounters.delete(id)
        unattendedDenyCounts.delete(id)
        sessionContext.delete(id)
        sessionParents.delete(id)
        classifierSessions.delete(id)
        isolatedClassifierSessions.delete(id)
        const paths = await hostPaths.catch(() => undefined)
        if (paths && !("error" in paths)) {
          if (activityChanged) flushActivity(paths.activityPath)
          const cleared = await clearTrustedSessionModel(
            paths.sessionModelsDir,
            id,
          )
          if (!cleared)
            log(
              "warn",
              `could not clear the session-scoped classifier model for deleted session ${id}`,
            )
        } else {
          log(
            "warn",
            `could not resolve paths while cleaning deleted session ${id}`,
          )
        }
        return
      }

      if (type === "session.idle") {
        const sessionID = (properties as { sessionID?: unknown } | undefined)
          ?.sessionID
        if (typeof sessionID === "string") scheduleSweep(sessionID)
      }
    },

    "command.execute.before": async (input, output) => {
      // The host persists a project command's expanded template as ordinary
      // non-synthetic user text with no provenance (verified against the
      // v1.18.1 source) — indistinguishable from typed prose, and template
      // text is repository-controlled. Mark every outgoing text part here, at
      // the only moment the origin is known, so the transcript later shows
      // the user's own invocation instead of treating the template as their
      // words. The marker is inert metadata the host's TextPart schema
      // already allows; the model and TUI still see the template unchanged.
      //
      // The marker is load-bearing, so this boundary must not just swallow
      // (an unmarked template would later read as the user's own prose). A
      // part that refuses the write — frozen or proxied by another plugin —
      // is rebuilt as a marked plain copy in the same array slot; the host
      // keeps using this array object (verified against the 1.18.3 source),
      // so in-place replacement is the reconstruction that counts. Every
      // write is VERIFIED by reading the marker back: a proxy that silently
      // drops the set must not pass. Only when even the rebuilt copy cannot
      // land does the hook abort with a controlled error — on the pinned
      // hosts that fails the command's execution effect, so the unmarked
      // template never reaches the transcript at all.
      let command = ""
      try {
        command = typeof input?.command === "string" ? input.command : ""
        if (!command || !Array.isArray(output?.parts)) return
        const args = typeof input.arguments === "string" ? input.arguments : ""
        // Verification means THIS invocation, normalized the way
        // commandOriginOf reads markers back. Presence alone would let a
        // part that already carries a marker for another invocation (frozen,
        // or proxied to drop writes) pass as marked — and that stale command
        // would then be presented as the user's own action in the transcript.
        const expected = {
          command: command.trim(),
          arguments: args.trim() || undefined,
        }
        const marked = (candidate: unknown): boolean => {
          try {
            const origin = commandOriginOf(candidate)
            return (
              !!origin &&
              origin.command === expected.command &&
              origin.arguments === expected.arguments
            )
          } catch {
            return false
          }
        }
        for (let index = 0; index < output.parts.length; index++) {
          const part: unknown = output.parts[index]
          if (
            !part ||
            typeof part !== "object" ||
            (part as { type?: unknown }).type !== "text"
          )
            continue
          try {
            const target = part as { metadata?: Record<string, unknown> }
            target.metadata = {
              ...target.metadata,
              [STORAGE_SERVICE]: { command, arguments: args },
            }
          } catch {
            // Rebuilt below instead.
          }
          if (marked(output.parts[index])) continue
          let metadata: Record<string, unknown>
          try {
            const raw = (part as { metadata?: unknown }).metadata
            metadata =
              raw && typeof raw === "object" && !Array.isArray(raw)
                ? { ...(raw as Record<string, unknown>) }
                : {}
          } catch {
            // Unreadable metadata is dropped from the copy; the part's own
            // text and type are preserved by the spread below (or the outer
            // boundary aborts if even those cannot be read).
            metadata = {}
          }
          // The copy carries every readable property of the original plus the
          // marker; the SDK's Part union cannot see that through a spread of
          // Record<string, unknown>, hence the cast.
          output.parts[index] = {
            ...(part as Record<string, unknown>),
            metadata: {
              ...metadata,
              [STORAGE_SERVICE]: { command, arguments: args },
            },
          } as unknown as (typeof output.parts)[number]
          if (!marked(output.parts[index]))
            throw new Error("the provenance marker did not stick")
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        log("error", `could not mark command-template provenance: ${detail}`, {
          command,
        })
        throw new Error(
          `${SERVICE}: could not mark the provenance of the "/${command || "unknown"}" command's template parts (${detail}); refusing to let repository template text pass as user-authored`,
        )
      }
    },

    "chat.message": async (input, output) => {
      const message = (output?.message ?? {}) as { sessionID?: unknown }
      const sessionID =
        typeof input?.sessionID === "string"
          ? input.sessionID
          : typeof message.sessionID === "string"
            ? message.sessionID
            : undefined
      if (!sessionID || classifierSessions.has(sessionID)) return
      const task = textOfParts(output?.parts)
      const model =
        input?.model &&
        typeof input.model.providerID === "string" &&
        typeof input.model.modelID === "string"
          ? { providerID: input.model.providerID, modelID: input.model.modelID }
          : modelFromMessage(output?.message)
      const agent =
        typeof (input as { agent?: unknown } | undefined)?.agent === "string" &&
        (input as { agent?: string }).agent
          ? (input as { agent: string }).agent
          : agentOfMessage(output?.message)
      sessionContext.set(sessionID, {
        model,
        task: task || undefined,
        agent,
      })
      trim(sessionContext)
    },

    "experimental.chat.system.transform": async (input, output) => {
      // Identity first, under a swallow-only guard: this hook runs inside
      // the host's message preparation for EVERY session, and an ordinary
      // chat must never be disturbed — malformed input degrades to "not a
      // classifier session".
      let sessionID: string | undefined
      try {
        sessionID = input.sessionID
        if (!sessionID || !classifierSessions.has(sessionID)) return
      } catch {
        return
      }
      try {
        // OpenCode normally prepends its provider/default-agent prompt,
        // environment, AGENTS.md/configured instructions, skills, and MCP
        // instructions. None of those are classifier policy. Replace the whole
        // system stream; selected project guidance is supplied separately as
        // labeled, untrusted user data.
        output.system.splice(0, output.system.length, CLASSIFIER_SYSTEM_PROMPT)
        // The host keeps using this same array object (verified against the
        // 1.18.3 source), so in-place replacement is the only substitution
        // that counts — and it is verified by reading the stream back before
        // the session may be marked isolated: a frozen or proxied stream
        // that kept inherited entries must never have its verdict trusted.
        if (
          output.system.length !== 1 ||
          output.system[0] !== CLASSIFIER_SYSTEM_PROMPT
        ) {
          throw new Error("the system stream did not accept the replacement")
        }
        isolatedClassifierSessions.add(sessionID)
        trim(isolatedClassifierSessions)
      } catch (error) {
        // This session IS the plugin's own classifier. Swallowing here would
        // let the host finish preparing the message and ship the inherited
        // system stream — agent prompt, environment, instructions, skills,
        // MCP context — to the classifier's (possibly separately pinned)
        // provider, with classify() only refusing the verdict AFTER that
        // disclosure and spent model call. Rethrow a controlled error
        // instead: the hook is awaited inside the host's LLM request
        // preparation (verified against the 1.18.3 source), so the throw
        // fails this one classifier message before provider dispatch and
        // classify() fails closed on the errored POST. Ordinary sessions
        // returned above and can never reach this throw.
        const detail = error instanceof Error ? error.message : String(error)
        isolatedClassifierSessions.delete(sessionID)
        log("error", `classifier system-prompt isolation failed: ${detail}`)
        throw new Error(
          `${SERVICE}: classifier session could not be isolated from the inherited system prompt (${detail}); refusing to dispatch it`,
        )
      }
    },

    dispose: async () => {
      // Pending sweeps die with the instance — their orphans would be gone
      // with it anyway. In-flight ones drain below like journal writes.
      disposed = true
      const localityDisposed = locality.dispose()
      clearTimeout(sessionModelReconciliationTimer)
      for (const timer of sweepTimers.values()) clearTimeout(timer)
      sweepTimers.clear()
      // Unattended-deny timers die with the instance too — pending prompts
      // do not survive a restart, so there is nothing to hand over — but an
      // in-flight deny drains like an in-flight sweep.
      for (const timer of unattendedDenyTimers.values()) clearTimeout(timer)
      unattendedDenyTimers.clear()
      await localityDisposed
      await scheduler.dispose()
      await sweeps
      await denials
      // Journal updates are fire-and-forget at approval time, so an approval
      // right before shutdown may still be queued here — drain it, or the
      // entry is lost. (The chain never rejects; every link ends in a catch.)
      await journalWrites.drain()
      const paths = await hostPaths
      if ("error" in paths) return
      // Drain queued sidebar flushes too, so a late write cannot land after
      // the clear below and resurrect the activity file with a stale beacon.
      await activityWrites.drain()
      await clearOverride(paths.overridePath).catch(() => {})
      // Take the beacon down with the instance so a dead server can never
      // keep reading as "ready"; the next instance writes a fresh one anyway.
      await clearActivity(paths.activityPath).catch(() => {})
    },
  }
}

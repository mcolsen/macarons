import {
  appLogger,
  createSerialQueue,
  createSessionActivityTracker,
  mintMessageID,
  type PromptIdentity,
  promptIdentityBody,
  reportServerCompat,
  SESSION_STATUS_PROBE_TIMEOUT_MS,
  serverToast,
  sessionPromptIdentity,
  trim,
  truncateLabel,
  unrefTimer,
  withTimeout,
} from "@macarons/permission-rules"
import { type Plugin, tool } from "@opencode-ai/plugin"
import {
  type CronJob,
  createScheduler,
  type DeliveryResult,
  MAX_DELIVERY_ATTEMPTS,
  MAX_JOBS_PER_SESSION,
  nextMatch,
  type Scheduler,
  validateCron,
} from "./scheduler"

/**
 * @macarons/cron — plugin factory
 *
 * Gives the OpenCode agent Claude Code's cron tools: cron_create, cron_list,
 * cron_delete. A fired job's prompt is enqueued into the owning session as an
 * ordinary user turn via session.promptAsync — but only while that session is
 * idle; fires that land mid-turn wait for the next idle and coalesce. Whether
 * a session is idle comes from the suite's shared tracker
 * (createSessionActivityTracker in permission-rules): session.status /
 * session.idle events, a one-shot GET /session/status for a session no event
 * has described yet, and not-idle whenever the answer is unknown. The holding
 * and coalescing on top of that answer is this plugin's own (src/scheduler.ts).
 *
 * Jobs created by a sub-agent attach to its top-level session (parentID chain
 * walked via session.get): child sessions are hidden from the switcher and
 * end with their task, so a prompt fired into one would never be seen. The
 * walk fails closed — an unconfirmed link aborts the tool call rather than
 * guessing at (and caching) the wrong owner.
 *
 * Everything goes through the injected v1 client — never fetch(serverUrl) —
 * so the standalone TUI's in-process transport works identically to serve
 * mode. The timer functions and delivery deadline are injectable purely for
 * tests; src/index.ts exports the real-clock instance and nothing else,
 * because the host calls every function a plugin module exports.
 */

const SERVICE = "cron"

const CREATE_DESCRIPTION = `Schedule a prompt to be enqueued in this session at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the machine's local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local — no timezone conversion needed. Plain numeric syntax only — wildcards, values, ranges, steps, comma lists; name aliases (MON, JAN) and extensions (L, W, ?, #) are rejected.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete. Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

## Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "*/5 * * * *" (every 5 min), "7 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)

## Avoid the :00 and :30 minute marks when the task allows it

Everyone who asks for "9am" gets \`0 9\`, and everyone who asks for "hourly" gets \`0 *\` — so scheduled requests from across the planet land on the model providers at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" → "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" → "7 * * * *" (not "0 * * * *")
Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past").

## Session-only

Jobs live in memory only — they are gone when OpenCode restarts and when the session is deleted. Jobs created by a sub-agent belong to, and fire into, its top-level session. A session holds at most 50 jobs at once.

## Runtime behavior

Jobs fire only while the session is idle (never mid-turn). A fire that lands while the session is working is delivered when it next goes idle, and repeat fires of the same recurring job coalesce into one delivery. Fire times carry a deterministic per-job jitter: recurring jobs fire up to 30 minutes after the cron match (at most half the interval for schedules more frequent than hourly), and one-shots pinned to :00 or :30 fire up to 90 seconds early — a one-shot on any other minute fires exactly. Recurring jobs normally fire on each match and expire 7 days after creation — the first fire at or past expiry is the final one. Tell the user about the 7-day limit when scheduling recurring jobs. If the host definitively refuses a one-shot or final recurring fire, delivery is retried a few times. Any fired prompt whose acceptance cannot be confirmed parks its job unscheduled, including recurring jobs; cron_list shows the failure details and cron_delete clears it.

Returns a job ID you can pass to cron_delete.`

const LIST_DESCRIPTION =
  "List the cron jobs scheduled via cron_create for this session: each job's ID, schedule, next fire time, expiry, and prompt. A job whose delivery failed or could not be confirmed stays listed with its failure details until deleted."

const DELETE_DESCRIPTION =
  "Cancel a cron job previously scheduled with cron_create in this session. Removes it from the in-memory session store."

export type TimerDeps = {
  now(): number
  setTimer(run: () => void, delayMs: number): unknown
  clearTimer(timer: unknown): void
}

const REAL_TIMERS: TimerDeps = {
  now: () => Date.now(),
  // Unref'd like every other timer in the suite. A cron arm is a pending
  // *notification*, not a reason for the OpenCode server to stay up: the
  // listening socket is what keeps that process alive, and a job armed for
  // next Tuesday must not outvote a shutdown.
  setTimer: (run, delayMs) => unrefTimer(setTimeout(run, delayMs)),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

const PROMPT_PREVIEW_CHARS = 60

/** One line of a job's prompt for a listing row or a toast. */
function preview(text: string): string {
  return truncateLabel(text, PROMPT_PREVIEW_CHARS)
}

function local(ms: number): string {
  return new Date(ms).toLocaleString()
}

function formatJob(job: CronJob): string {
  const kind = job.recurring ? "recurring" : "one-shot"
  const when = job.failure
    ? job.failure.kind === "rejected"
      ? `delivery failed ${local(job.failure.at)} after ${job.failure.attempts} attempt(s): ${job.failure.detail} — kept for inspection, clear with cron_delete`
      : `delivery unconfirmed ${local(job.failure.at)}: ${job.failure.detail} — the host may or may not have received it; kept for inspection, clear with cron_delete`
    : job.pending
      ? "fired while the session was busy — delivers on next idle"
      : job.nextFire !== undefined
        ? job.attempts
          ? `delivery attempt ${job.attempts} of ${MAX_DELIVERY_ATTEMPTS} was not accepted — retrying ${local(job.nextFire)}`
          : `next fire ${local(job.nextFire)}`
        : "awaiting idle"
  const expiry =
    job.expiresAt !== undefined && !job.failure
      ? `, expires ${local(job.expiresAt)}`
      : ""
  return `- ${job.id}: "${job.cron}" (${kind}) — ${when}${expiry} — prompt: ${preview(job.prompt)}`
}

// Pauses between the message lookups that prove a fire was accepted, after the
// immediate first lookup. Bounded: a prompt that never appears parks the job
// as ambiguous instead of blocking the scheduler forever.
export const CONFIRM_DELAYS_MS = [200, 500, 1000, 2000]

// A transiently loaded host must not permanently park a recurring schedule
// merely because its forked prompt write missed the terminal-fire budget.
// Keeping the extension non-final avoids adding twelve seconds to one-shots.
export const NON_FINAL_CONFIRM_DELAYS_MS = [...CONFIRM_DELAYS_MS, 4000, 8000]

// Every host request on the fire path gets an aborting deadline. The status
// probe already uses this suite-wide bound; sharing it keeps one definition of
// how long a loopback host call may hold a cron delivery.
export const DELIVERY_CALL_TIMEOUT_MS = SESSION_STATUS_PROBE_TIMEOUT_MS

// A confirmed message normally starts a turn immediately. If it was stored but
// the fork died before publishing any status transition, re-check live host
// state after this grace period so later same-session fires are not stranded.
export const AWAIT_IDLE_RECHECK_MS = SESSION_STATUS_PROBE_TIMEOUT_MS

export function cronPlugin(
  timers: TimerDeps = REAL_TIMERS,
  deliveryCallTimeoutMs = DELIVERY_CALL_TIMEOUT_MS,
): Plugin {
  return async ({ client, directory, serverUrl }) => {
    const log = appLogger(client, SERVICE)

    const compat = await reportServerCompat({
      client,
      serverUrl,
      label: SERVICE,
      service: SERVICE,
      log,
    })
    // Only a non-v1 host is disabling; a merely untested v1 host runs on.
    if (compat?.disable) return {}

    // ---- session busy/idle tracking -----------------------------------------

    /** Aborted by dispose() so no status or delivery request outlives the plugin. */
    const disposeSignal = new AbortController()

    // Busy/idle from session.status / session.idle, with a one-shot
    // GET /session/status for a session no event has described yet and
    // not-idle whenever the answer is unknown. The tracker reports state; what
    // this plugin does with it — hold the fire, coalesce the repeats, deliver
    // on the next idle — is the scheduler's, below.
    const activity = createSessionActivityTracker({
      client,
      directory,
      timeoutMs: deliveryCallTimeoutMs,
      signal: disposeSignal.signal,
    })

    // ---- root-session resolution --------------------------------------------

    // Only CONFIRMED walks are cached. A transient failure must never decide
    // job ownership: guessing "current session is the root" on an error and
    // caching it would permanently attach a sub-agent's jobs to a session
    // that ends with its task — fires delivered where nobody looks, and
    // cron_list/cron_delete from the real root blind to the job. Like the
    // equivalent walk in subagent-comms, every unconfirmed link fails closed.

    const roots = new Map<string, string>()

    const MAX_ANCESTRY_DEPTH = 16

    const unresolvedAncestry = (sessionID: string, reason: string): string =>
      `Could not resolve this session's top-level session (stopped at ${JSON.stringify(sessionID)}: ${reason}). Nothing was changed — retry when the host answers again.`

    const rootSessionOf = async (sessionID: string): Promise<string> => {
      const cached = roots.get(sessionID)
      if (cached) return cached
      const visited = [sessionID]
      let current = sessionID
      for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
        let result: { data?: unknown; error?: unknown }
        try {
          result = await client.session.get({
            path: { id: current },
            query: { directory },
          })
        } catch (error) {
          throw new Error(
            unresolvedAncestry(
              current,
              `session.get failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
        }
        if (result.error) {
          throw new Error(
            unresolvedAncestry(
              current,
              `the host answered with an error: ${JSON.stringify(result.error)}`,
            ),
          )
        }
        const info = result.data as { parentID?: unknown } | undefined | null
        if (!info || typeof info !== "object") {
          throw new Error(
            unresolvedAncestry(current, "the host returned no session data"),
          )
        }
        const parentID = info.parentID
        if (parentID === undefined || parentID === null || parentID === "") {
          // Confirmed root: cache every hop of the walk.
          for (const id of visited) roots.set(id, current)
          trim(roots)
          return current
        }
        if (typeof parentID !== "string") {
          throw new Error(
            unresolvedAncestry(current, "the session's parentID is malformed"),
          )
        }
        current = parentID
        visited.push(current)
      }
      throw new Error(
        unresolvedAncestry(
          current,
          `the parent chain is deeper than ${MAX_ANCESTRY_DEPTH} sessions`,
        ),
      )
    }

    // ---- delivery ------------------------------------------------------------

    // No TUI attached just means nobody is watching; the fire is in the log.
    const toast = serverToast(client, { directory })

    const delivered = (job: CronJob, how: string) => {
      log("info", `job ${job.id} fired into session ${job.sessionID}${how}`)
      toast("info", `cron: ${job.id} fired — ${preview(job.prompt)}`)
    }

    type DeliveryLane = {
      queue: ReturnType<typeof createSerialQueue>
      pending: number
    }
    type AwaitingIdleMark = {
      recheckAt: number
      timer?: unknown
    }
    const deliveryLanes = new Map<string, DeliveryLane>()
    const idleEpochs = new Map<string, number>()
    const awaitingIdle = new Map<string, AwaitingIdleMark>()
    const suppressLegacyIdle = new Set<string>()
    let scheduler: Scheduler

    // OpenCode orders a session's messages by ID. Keep prompt submission and
    // exact-ID confirmation serial within that session so concurrent cron jobs
    // cannot persist out of order; other sessions retain independent lanes.
    const inDeliveryLane = <T>(
      sessionID: string,
      work: () => Promise<T>,
    ): Promise<T> => {
      const lane = deliveryLanes.get(sessionID) ?? {
        queue: createSerialQueue(),
        pending: 0,
      }
      deliveryLanes.set(sessionID, lane)
      lane.pending++
      return lane.queue.push(work).finally(() => {
        lane.pending--
        if (lane.pending === 0 && deliveryLanes.get(sessionID) === lane) {
          deliveryLanes.delete(sessionID)
        }
      })
    }

    const withDeliveryTimeout = <T>(
      description: string,
      call: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> =>
      withTimeout(call, deliveryCallTimeoutMs, {
        signal: disposeSignal.signal,
        message: `${description} timed out after ${deliveryCallTimeoutMs} ms`,
      })

    const clearAwaitingIdle = (sessionID: string): void => {
      const mark = awaitingIdle.get(sessionID)
      if (!mark) return
      if (mark.timer !== undefined) timers.clearTimer(mark.timer)
      awaitingIdle.delete(sessionID)
    }

    // The cached idle that preceded a cron prompt cannot prove that its fork
    // has finished. Refresh through the shared tracker, which also lets an
    // event racing the request override the endpoint's older snapshot.
    const isDefinitelyIdleNow = (sessionID: string): Promise<boolean> =>
      activity.isIdle(sessionID, { refresh: true })

    const scheduleAwaitingIdleRecheck = (
      sessionID: string,
      mark: AwaitingIdleMark,
    ): void => {
      if (mark.timer !== undefined) return
      mark.timer = timers.setTimer(
        () => {
          mark.timer = undefined
          void (async () => {
            const idle = await isDefinitelyIdleNow(sessionID)
            if (
              disposeSignal.signal.aborted ||
              awaitingIdle.get(sessionID) !== mark
            ) {
              return
            }
            if (!idle) {
              mark.recheckAt = timers.now() + AWAIT_IDLE_RECHECK_MS
              scheduleAwaitingIdleRecheck(sessionID, mark)
              return
            }
            clearAwaitingIdle(sessionID)
            idleEpochs.set(sessionID, (idleEpochs.get(sessionID) ?? 0) + 1)
            trim(idleEpochs)
            scheduler.onSessionIdle(sessionID)
          })()
        },
        Math.max(mark.recheckAt - timers.now(), 0),
      )
    }

    const markAwaitingIdle = (sessionID: string): void => {
      clearAwaitingIdle(sessionID)
      awaitingIdle.set(sessionID, {
        recheckAt: timers.now() + AWAIT_IDLE_RECHECK_MS,
      })
      // This is correctness state, not a cache: evicting it could let another
      // prompt overlap the turn it guards. Idle/deleted events, disposal, or a
      // blocked delivery's live-status watchdog remove it instead.
    }

    const wait = (ms: number): Promise<void> => {
      const signal = disposeSignal.signal
      if (signal.aborted) {
        return Promise.reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("The cron plugin is shutting down."),
        )
      }
      return new Promise<void>((resolve, reject) => {
        let timer: unknown
        const onAbort = () => {
          timers.clearTimer(timer)
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("The cron plugin is shutting down."),
          )
        }
        signal.addEventListener("abort", onAbort, { once: true })
        timer = timers.setTimer(() => {
          signal.removeEventListener("abort", onAbort)
          resolve()
        }, ms)
      })
    }

    // Only the stored message proves a fire was accepted: promptAsync answers
    // 204 BEFORE its forked prompt work resolves the agent and writes the user
    // message (failures after the fork are only logged and published as session
    // errors), and after a transport failure the request may have reached the
    // host anyway. Poll briefly — the fork usually writes within milliseconds,
    // but "not found" right now could be a prompt still landing. A fire that
    // cannot be proven stays unknown, and the scheduler parks the job rather
    // than risking a duplicate or an overlapping next occurrence.
    const confirmEnqueued = async (
      job: CronJob,
      messageID: string,
      sendProblem: string,
      how: string,
    ): Promise<DeliveryResult> => {
      let lookupProblem = `message ${messageID} was not found on the host`
      const delays =
        job.recurring && job.nextFire !== undefined
          ? NON_FINAL_CONFIRM_DELAYS_MS
          : CONFIRM_DELAYS_MS
      for (let attempt = 0; ; attempt++) {
        try {
          const found = await withDeliveryTimeout(
            `confirming message ${messageID}`,
            (signal) =>
              client.session.message({
                path: { id: job.sessionID, messageID },
                query: { directory },
                signal,
              }),
          )
          if (!found.error && found.data) {
            delivered(job, how)
            return { outcome: "delivered" }
          }
        } catch (error) {
          lookupProblem = `the message lookup failed: ${error instanceof Error ? error.message : String(error)}`
        }
        const delay = delays[attempt]
        if (delay === undefined) break
        await wait(delay)
      }
      return { outcome: "unknown", reason: `${sendProblem}; ${lookupProblem}` }
    }

    const deliverOne = async (
      job: CronJob,
      beginAttempt: () => string | undefined,
    ): Promise<DeliveryResult> => {
      // A previous job in this session has started a turn. Hand this fire back
      // to the scheduler as pending; the next idle event will flush it after
      // the host's assistant message exists, preserving message-ID ordering.
      const awaiting = awaitingIdle.get(job.sessionID)
      if (awaiting) {
        scheduleAwaitingIdleRecheck(job.sessionID, awaiting)
        return { outcome: "deferred" }
      }
      // The scheduler's idle snapshot predates this session's ordering wait.
      if (!(await activity.isIdle(job.sessionID))) {
        return { outcome: "deferred" }
      }

      // Echo the session's pinned agent/model/variant: the host resolves an
      // omitted agent to the DEFAULT agent — not the session's own — and
      // re-pins the session, stripping a pinned variant (see
      // sessionPromptIdentity in permission-rules). An unreadable session
      // fails the delivery instead of skipping the echo — nothing has been
      // sent yet, so this is a definitive rejection and a retry is safe.
      let identity: PromptIdentity
      try {
        const session = await withDeliveryTimeout(
          `reading session ${job.sessionID}`,
          (signal) =>
            client.session.get({
              path: { id: job.sessionID },
              query: { directory },
              signal,
            }),
        )
        if (session.error || !session.data) {
          return {
            outcome: "rejected",
            reason: `could not read the session to echo its agent/model: ${JSON.stringify(session.error ?? "no data")}`,
          }
        }
        identity = sessionPromptIdentity(session.data)
      } catch (error) {
        return {
          outcome: "rejected",
          reason: `could not read the session to echo its agent/model: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      // Activity can change during the identity read. Hand the job back before
      // minting an ID; resuming it must read identity again, not reuse this pin.
      if (!(await activity.isIdle(job.sessionID))) {
        return { outcome: "deferred" }
      }
      // Mint only after the identity read and this session's ordering wait. An
      // ID minted before either could sort behind a turn completed meanwhile.
      const idleEpoch = idleEpochs.get(job.sessionID) ?? 0
      const messageID = beginAttempt()
      if (!messageID) {
        return {
          outcome: "rejected",
          reason: "the cron job was removed before prompt dispatch",
        }
      }
      const recordTurn = (result: DeliveryResult): DeliveryResult => {
        if (
          result.outcome === "delivered" &&
          !disposeSignal.signal.aborted &&
          (idleEpochs.get(job.sessionID) ?? 0) === idleEpoch
        ) {
          markAwaitingIdle(job.sessionID)
        }
        return result
      }
      // `variant` is accepted by the route but missing from the stale SDK
      // body type, so the body rides through a widened variable.
      const body: {
        agent?: string
        model?: { providerID: string; modelID: string }
        variant?: string
        messageID: string
        parts: Array<{ type: "text"; text: string }>
      } = {
        ...promptIdentityBody(identity),
        messageID,
        parts: [{ type: "text", text: job.prompt }],
      }
      let result: { error?: unknown }
      try {
        result = await withDeliveryTimeout(
          `prompting session ${job.sessionID}`,
          (signal) =>
            client.session.promptAsync({
              path: { id: job.sessionID },
              body,
              query: { directory },
              signal,
            }),
        )
      } catch (error) {
        return recordTurn(
          await confirmEnqueued(
            job,
            messageID,
            `the transport failed mid-request: ${error instanceof Error ? error.message : String(error)}`,
            " (confirmed by message lookup after a transport failure)",
          ),
        )
      }
      if (result.error) {
        // An error RESPONSE is definitive: promptAsync validates the session
        // before forking the prompt work, and the fork reports its failures
        // only through the event bus after the 204 — an error status can only
        // mean the prompt was never enqueued.
        return {
          outcome: "rejected",
          reason: `the host rejected the prompt: ${JSON.stringify(result.error)}`,
        }
      }
      // The 204 is provisional; serial delivery cannot release the next job
      // until this ID is visible and therefore ordered in host storage.
      return recordTurn(
        await confirmEnqueued(
          job,
          messageID,
          "the host accepted the request but the prompt message never appeared",
          "",
        ),
      )
    }

    const deliver = (
      job: CronJob,
      beginAttempt: () => string | undefined,
    ): Promise<DeliveryResult> =>
      inDeliveryLane(job.sessionID, () => deliverOne(job, beginAttempt))

    // Separate logical clocks per session make same-millisecond cron prompts
    // strictly ascending without skewing one busy session from another. The
    // host uses message IDs as its chronological tiebreaker.
    const messageTimes = new Map<string, number>()
    const mintDeliveryMessageID = (sessionID: string): string => {
      const now = timers.now()
      const messageTime = Math.max(now, (messageTimes.get(sessionID) ?? -1) + 1)
      messageTimes.set(sessionID, messageTime)
      trim(messageTimes)
      return mintMessageID(messageTime)
    }

    scheduler = createScheduler({
      ...timers,
      isIdle: (sessionID) => activity.isIdle(sessionID),
      deliver,
      mintMessageID: (job) => mintDeliveryMessageID(job.sessionID),
      onFailure: (job) => {
        const failure = job.failure
        if (!failure) return
        toast(
          "error",
          `cron: ${job.id} ${failure.kind === "ambiguous" ? "could not be confirmed" : "failed"} and was parked — inspect with cron_list`,
        )
      },
      log: (level, message) => {
        log(level, message)
      },
    })

    // ---- tools ----------------------------------------------------------------

    const z = tool.schema

    return {
      // OpenCode's hardcoded agent ruleset opens with a `"*": allow` rule, so
      // an ask under a key nobody configured is silently allowed — without a
      // cron rule, the permission gate on cron_create would never prompt.
      // Inject the ask default into the loaded config before agent rulesets
      // are built from it. An explicit user setting is left alone, and both
      // agent-level carve-outs and session "always" replies are appended
      // after config rules, so they still win under last-match-wins.
      config: async (config) => {
        config.permission ??= {}
        const permissions = config.permission as Record<string, unknown>
        if (permissions.cron === undefined) permissions.cron = "ask"
      },

      tool: {
        cron_create: tool({
          description: CREATE_DESCRIPTION,
          args: {
            cron: z
              .string()
              .describe(
                'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).',
              ),
            prompt: z
              .string()
              .describe("The prompt to enqueue at each fire time."),
            recurring: z
              .boolean()
              .optional()
              .describe(
                'true (default) = normally fire on each cron match until deleted or auto-expired after 7 days; an unconfirmable delivery parks the job until deleted. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.',
              ),
          },
          async execute(args, ctx) {
            ctx.abort.throwIfAborted()
            const problem = validateCron(args.cron)
            if (problem) {
              throw new Error(
                `Invalid cron expression ${JSON.stringify(args.cron)}: ${problem}`,
              )
            }
            const recurring = args.recurring ?? true
            const sessionID = await rootSessionOf(ctx.sessionID)
            // Check the cap before prompting: never ask the user to approve a
            // job the scheduler is about to refuse anyway.
            if (scheduler.list(sessionID).length >= MAX_JOBS_PER_SESSION) {
              throw new Error(
                `This session already has ${MAX_JOBS_PER_SESSION} cron jobs — the per-session limit. Delete one with cron_delete first.`,
              )
            }
            // Same rule as the cap check above: never ask the user to approve a
            // job the scheduler will refuse anyway. An expression that never
            // matches a future time can never fire.
            if (nextMatch(args.cron, timers.now()) === undefined) {
              throw new Error(
                `The expression ${JSON.stringify(args.cron)} never matches a future time.`,
              )
            }
            // Scheduling a future autonomous turn is a real capability grant;
            // route it through the permission system. The pattern carries the
            // FULL prompt: rules and the approval dialog match against it, so
            // truncating would let two different prompts present the same ask
            // and hide a long prompt's tail from deny rules. "Always allow"
            // stores a cron/* rule, so persist-permissions and approve-for-me
            // interop.
            ctx.abort.throwIfAborted()
            await ctx.ask({
              permission: "cron",
              patterns: [args.prompt],
              always: ["*"],
              metadata: { cron: args.cron, prompt: args.prompt, recurring },
            })
            // Approval can resolve after the calling turn was cancelled.
            ctx.abort.throwIfAborted()
            const job = scheduler.create({
              sessionID,
              cron: args.cron,
              prompt: args.prompt,
              recurring,
            })
            const lines = [
              `Created cron job ${job.id}: "${job.cron}" (${recurring ? "recurring" : "one-shot"}).`,
              `Next fire: ${job.nextFire !== undefined ? local(job.nextFire) : "unknown"}.`,
              recurring
                ? `Expires: ${job.expiresAt !== undefined ? local(job.expiresAt) : "unknown"} — recurring jobs last 7 days; the first fire at or past expiry is the final one.`
                : "One-shot: the job deletes itself after firing.",
            ]
            log(
              "info",
              `job ${job.id} created for session ${sessionID}: ${job.cron}`,
            )
            return {
              title: `${job.id} · ${job.cron}`,
              output: lines.join("\n"),
              metadata: { id: job.id, cron: job.cron, recurring },
            }
          },
        }),

        cron_list: tool({
          description: LIST_DESCRIPTION,
          args: {},
          async execute(_args, ctx) {
            const sessionID = await rootSessionOf(ctx.sessionID)
            const jobs = scheduler.list(sessionID)
            if (jobs.length === 0) {
              return "No cron jobs are scheduled for this session."
            }
            return {
              title: `${jobs.length} cron job(s)`,
              output: [
                `${jobs.length} cron job(s) for this session:`,
                ...jobs.map(formatJob),
              ].join("\n"),
            }
          },
        }),

        cron_delete: tool({
          description: DELETE_DESCRIPTION,
          args: {
            id: z.string().describe("Job ID returned by cron_create."),
          },
          async execute(args, ctx) {
            const sessionID = await rootSessionOf(ctx.sessionID)
            if (!scheduler.remove(args.id, sessionID)) {
              throw new Error(
                `No cron job ${JSON.stringify(args.id)} exists for this session. Use cron_list to see current jobs.`,
              )
            }
            log("info", `job ${args.id} deleted from session ${sessionID}`)
            return `Deleted cron job ${args.id}.`
          },
        }),
      },

      event: async ({ event }) => {
        // Recorded before anything awaits, so the cache never lags the host's
        // own status map (see createSessionActivityTracker).
        const statusForm =
          (event as { properties?: { status?: unknown } } | undefined)
            ?.properties?.status !== undefined
        const seen = activity.observe(event)
        if (!seen) return
        if (seen.activity === "idle") {
          // The host publishes session.status(idle) followed by the deprecated
          // session.idle for the same transition. Keep legacy-only transitions
          // working, but do not let the duplicate release the next lane job as
          // though the turn started by the first fire had already completed.
          if (!statusForm && suppressLegacyIdle.delete(seen.sessionID)) {
            return
          }
          if (statusForm) {
            suppressLegacyIdle.add(seen.sessionID)
            trim(suppressLegacyIdle)
          }
          idleEpochs.set(
            seen.sessionID,
            (idleEpochs.get(seen.sessionID) ?? 0) + 1,
          )
          trim(idleEpochs)
          clearAwaitingIdle(seen.sessionID)
          // A genuine idle transition releases the pending jobs; the
          // per-session lane preserves their turn order after reservation.
          scheduler.onSessionIdle(seen.sessionID)
          return
        }
        if (seen.activity === "gone") {
          roots.delete(seen.sessionID)
          messageTimes.delete(seen.sessionID)
          idleEpochs.delete(seen.sessionID)
          clearAwaitingIdle(seen.sessionID)
          suppressLegacyIdle.delete(seen.sessionID)
          scheduler.dropSession(seen.sessionID)
          return
        }
        suppressLegacyIdle.delete(seen.sessionID)
      },

      dispose: async () => {
        scheduler.dispose()
        disposeSignal.abort(new Error("The cron plugin is shutting down."))
        activity.clear()
        deliveryLanes.clear()
        messageTimes.clear()
        idleEpochs.clear()
        for (const sessionID of [...awaitingIdle.keys()]) {
          clearAwaitingIdle(sessionID)
        }
        suppressLegacyIdle.clear()
      },
    }
  }
}

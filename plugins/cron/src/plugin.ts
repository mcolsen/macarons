import { randomUUID } from "node:crypto"
import { unrefTimer } from "@macarons/permission-rules"
import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
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
  setTimer: (run, delayMs) => unrefTimer(setTimeout(run, delayMs)),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

export const DELIVERY_CALL_TIMEOUT_MS = 10_000
export const IDLE_RECHECK_MS = 10_000

const PROMPT_PREVIEW_CHARS = 60

/** One line of a job's prompt for a listing row or a toast. */
function preview(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, PROMPT_PREVIEW_CHARS)
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

/** Native V2 plugin: the host durably admits queued inputs before acknowledging them. */
export function cronPlugin(
  timers: TimerDeps = REAL_TIMERS,
  deliveryCallTimeoutMs = DELIVERY_CALL_TIMEOUT_MS,
): Plugin.Plugin {
  return Plugin.define({
    id: "macarons.cron",
    async setup(context) {
      const lifecycle = new AbortController()
      const retries = new Map<string, unknown>()
      const lanes = new Map<string, Promise<unknown>>()
      let scheduler: Scheduler

      // Keep all remote operations bounded, even when a transport ignores abort.
      async function bounded<T>(
        call: (signal: AbortSignal) => Promise<T>,
      ): Promise<T> {
        const abort = new AbortController()
        const stop = () => abort.abort(lifecycle.signal.reason)
        lifecycle.signal.addEventListener("abort", stop, { once: true })
        let timer: ReturnType<typeof setTimeout> | undefined
        let onAbort: (() => void) | undefined
        try {
          lifecycle.signal.throwIfAborted()
          return await Promise.race([
            Promise.resolve().then(() => call(abort.signal)),
            new Promise<never>((_, reject) => {
              onAbort = () => reject(abort.signal.reason)
              abort.signal.addEventListener("abort", onAbort, { once: true })
              timer = setTimeout(
                () => abort.abort(new Error("cron host request timed out")),
                deliveryCallTimeoutMs,
              )
              unrefTimer(timer)
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
          if (onAbort) abort.signal.removeEventListener("abort", onAbort)
          lifecycle.signal.removeEventListener("abort", stop)
        }
      }

      const errorTag = (error: unknown): string | undefined =>
        error && typeof error === "object" && "_tag" in error
          ? String(error._tag)
          : undefined
      const detail = (error: unknown) =>
        error instanceof Error ? error.message : String(error)

      function cancelRetry(sessionID: string) {
        const timer = retries.get(sessionID)
        if (timer !== undefined) timers.clearTimer(timer)
        retries.delete(sessionID)
      }

      function retryWhenIdle(sessionID: string) {
        if (
          lifecycle.signal.aborted ||
          retries.has(sessionID) ||
          scheduler.list(sessionID).length === 0
        )
          return
        retries.set(
          sessionID,
          timers.setTimer(() => {
            retries.delete(sessionID)
            scheduler.onSessionIdle(sessionID)
          }, IDLE_RECHECK_MS),
        )
      }

      // wait follows any successor execution, including new work admitted during
      // cleanup. A failed probe never authorizes a fire; pending jobs retry later.
      async function isIdle(sessionID: string): Promise<boolean> {
        try {
          await bounded((signal) =>
            context.session.wait({ sessionID }, { signal }),
          )
          return true
        } catch (error) {
          if (errorTag(error) === "SessionNotFoundError") {
            scheduler.dropSession(sessionID)
            cancelRetry(sessionID)
          } else retryWhenIdle(sessionID)
          return false
        }
      }

      async function rootSessionOf(sessionID: string): Promise<string> {
        const visited = new Set<string>()
        let current = sessionID
        for (let depth = 0; depth < 16; depth++) {
          if (visited.has(current))
            throw new Error("Could not resolve top-level session: parent cycle")
          visited.add(current)
          const data = await bounded((signal) =>
            context.session.get({ sessionID: current }, { signal }),
          )
          if (!data || data.id !== current)
            throw new Error(
              "Could not resolve top-level session: invalid session data",
            )
          if (!data.parentID) return current
          current = data.parentID
        }
        throw new Error(
          "Could not resolve top-level session: parent chain exceeds 16 sessions",
        )
      }

      async function deliverOne(
        job: CronJob,
        beginAttempt: () => string | undefined,
      ): Promise<DeliveryResult> {
        if (!(await isIdle(job.sessionID))) return { outcome: "deferred" }
        const id = beginAttempt()
        if (!id)
          return {
            outcome: "rejected",
            reason: "The job was removed before dispatch",
          }
        try {
          const data = await bounded((signal) =>
            context.session.prompt(
              {
                sessionID: job.sessionID,
                id,
                text: job.prompt,
                delivery: "queue",
              },
              { signal },
            ),
          )
          // Queue is essential: a user turn racing our idle probe cannot be
          // steered by a reminder. No model/agent override changes the session.
          if (
            data.id !== id ||
            data.sessionID !== job.sessionID ||
            data.delivery !== "queue"
          ) {
            return {
              outcome: "unknown",
              reason: "Host returned an unexpected inbox acknowledgment",
            }
          }
          return { outcome: "delivered" }
        } catch (error) {
          // Only typed admission rejections prove nothing was enqueued. Timeouts
          // and transport failures remain ambiguous and MUST NOT be replayed.
          const rejected = [
            "InvalidRequestError",
            "SessionNotFoundError",
          ].includes(errorTag(error) ?? "")
          return {
            outcome: rejected ? "rejected" : "unknown",
            reason: detail(error),
          }
        }
      }

      scheduler = createScheduler({
        ...timers,
        isIdle,
        mintMessageID: () => `msg_${randomUUID().replaceAll("-", "")}`,
        deliver: (job, beginAttempt) => {
          const previous = lanes.get(job.sessionID) ?? Promise.resolve()
          const pending = previous
            .catch(() => {})
            .then(() => deliverOne(job, beginAttempt))
          lanes.set(job.sessionID, pending)
          void pending
            .finally(() => {
              if (lanes.get(job.sessionID) === pending)
                lanes.delete(job.sessionID)
            })
            .catch(() => {})
          return pending
        },
        log: (level, message) => {
          if (level !== "info") console.warn(`[macarons.cron] ${message}`)
        },
      })

      // V2 ships a broad built-in allow first. Insert our ask default immediately
      // after it, before configured global/agent rules; explicit user rules and
      // native saved approvals still retain their normal precedence.
      const agents = await context.agent.transform((editor) => {
        for (const current of editor.list()) {
          editor.update(String(current.id), (agent) => {
            const first = agent.permissions[0]
            const afterDefault =
              first?.action === "*" &&
              first.resource === "*" &&
              first.effect === "allow"
                ? 1
                : 0
            agent.permissions.splice(afterDefault, 0, {
              action: "cron",
              resource: "*",
              effect: "ask",
            })
          })
        }
      })
      const tools = await context.tool.transform((editor) => {
        editor.add({
          name: "cron_create",
          description: CREATE_DESCRIPTION,
          options: { codemode: false },
          input: Schema.Struct({
            cron: Schema.String.annotate({
              description: "Standard five-field cron expression in local time.",
            }),
            prompt: Schema.String.annotate({
              description: "Full prompt to enqueue when the schedule fires.",
            }),
            recurring: Schema.optionalKey(Schema.Boolean),
          }),
          async execute(args, call) {
            call.signal.throwIfAborted()
            lifecycle.signal.throwIfAborted()
            const problem = validateCron(args.cron)
            if (problem)
              throw new Error(
                `Invalid cron expression ${JSON.stringify(args.cron)}: ${problem}`,
              )
            const sessionID = await rootSessionOf(call.sessionID)
            if (scheduler.list(sessionID).length >= MAX_JOBS_PER_SESSION)
              throw new Error(
                `This session already has ${MAX_JOBS_PER_SESSION} cron jobs`,
              )
            if (nextMatch(args.cron, timers.now()) === undefined)
              throw new Error("The expression never matches a future time")
            const recurring = args.recurring ?? true
            await context.permission.assert({
              sessionID: call.sessionID,
              agent: call.agent,
              action: "cron",
              resources: [args.prompt],
              save: ["*"],
              metadata: { cron: args.cron, prompt: args.prompt, recurring },
              source: { type: "tool", messageID: call.messageID, id: call.id },
            })
            call.signal.throwIfAborted()
            lifecycle.signal.throwIfAborted()
            const job = scheduler.create({
              sessionID,
              cron: args.cron,
              prompt: args.prompt,
              recurring,
            })
            return {
              content: [
                `Created cron job ${job.id}: "${job.cron}" (${recurring ? "recurring" : "one-shot"}).`,
                `Next fire: ${job.nextFire === undefined ? "unknown" : local(job.nextFire)}.`,
                recurring
                  ? `Expires: ${local(job.expiresAt as number)} — recurring jobs last 7 days.`
                  : "One-shot: the job deletes itself after admission to the host queue.",
              ].join("\n"),
              metadata: { id: job.id, cron: job.cron, recurring },
            }
          },
        })
        editor.add({
          name: "cron_list",
          description: LIST_DESCRIPTION,
          options: { codemode: false },
          input: Schema.Struct({}),
          async execute(_args, call) {
            const jobs = scheduler.list(await rootSessionOf(call.sessionID))
            return {
              content: jobs.length
                ? [
                    `${jobs.length} cron job(s) for this session:`,
                    ...jobs.map(formatJob),
                  ].join("\n")
                : "No cron jobs are scheduled for this session.",
            }
          },
        })
        editor.add({
          name: "cron_delete",
          description: DELETE_DESCRIPTION,
          options: { codemode: false },
          input: Schema.Struct({ id: Schema.String }),
          async execute(args, call) {
            const sessionID = await rootSessionOf(call.sessionID)
            call.signal.throwIfAborted()
            if (!scheduler.remove(args.id, sessionID))
              throw new Error(
                `No cron job ${JSON.stringify(args.id)} exists for this session`,
              )
            if (!scheduler.list(sessionID).length) cancelRetry(sessionID)
            return { content: `Deleted cron job ${args.id}.` }
          },
        })
      })

      // Native events are global; session IDs scope our in-memory scheduler.
      // A reconnect can miss events, so failed idle probes also re-arm a timer.
      const watch = async () => {
        try {
          for await (const event of context.event.subscribe({
            signal: lifecycle.signal,
          })) {
            if (lifecycle.signal.aborted) break
            if (event.type === "session.deleted") {
              scheduler.dropSession(event.data.sessionID)
              cancelRetry(event.data.sessionID)
            } else if (
              [
                "session.execution.succeeded",
                "session.execution.failed",
                "session.execution.interrupted",
              ].includes(event.type) &&
              "sessionID" in event.data &&
              typeof event.data.sessionID === "string"
            ) {
              scheduler.onSessionIdle(event.data.sessionID)
            }
          }
        } catch {
          // Timer recovery does not depend on a continuously connected stream.
        }
      }
      void watch()

      return async () => {
        lifecycle.abort(new Error("The cron plugin is shutting down"))
        scheduler.dispose()
        for (const sessionID of retries.keys()) cancelRetry(sessionID)
        lanes.clear()
        await Promise.all([tools.dispose(), agents.dispose()])
      }
    },
  })
}

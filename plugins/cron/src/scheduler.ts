import { Cron } from "croner"

/**
 * @macarons/cron — scheduler core
 *
 * An in-memory, session-scoped cron job store with a single re-armed timer.
 * Faithful to Claude Code's CronCreate semantics: jobs live only in this
 * process (nothing on disk, gone on restart), fire only while their session
 * is idle, one-shots delete themselves after a confirmed delivery, and
 * recurring jobs expire seven days after creation — the first fire at or
 * past expiry is the final one. A session holds at most 50 jobs, only the
 * plain 5-field cron dialect is accepted (no MON/JAN names, no L/W/?/#), and
 * fire times carry a deterministic per-job jitter so sessions across the
 * fleet do not hit the model providers at the same wall-clock instant.
 *
 * Every delivery attempt carries a host-format message ID minted at dispatch
 * time, so acceptance can be correlated without risking a duplicate. A fire
 * whose acceptance cannot be established parks the job in a terminal
 * `failure` state — visible in cron_list until deleted — rather than letting
 * a possibly-live request overlap another occurrence. A terminal fire (a
 * one-shot, or a recurring job's final fire) that the host definitively
 * refused is retried a bounded number of times; each retry gets a fresh ID so
 * it stays newer than any turn completed during the pause.
 *
 * Everything time- and delivery-shaped is injected (`SchedulerDeps`), so the
 * whole store is unit-testable with a fake clock. croner is used for cron
 * parsing and next-occurrence math only — it never owns a timer here; the
 * one timer belongs to this module and is re-armed after every mutation or
 * dispatch, independently of delivery completion.
 */

export type CronJob = {
  id: string
  /** Root session that owns delivery. Jobs created by sub-agents resolve to their root. */
  sessionID: string
  cron: string
  prompt: string
  recurring: boolean
  createdAt: number
  /** Recurring jobs only: the first fire at or past this instant is the final one. */
  expiresAt?: number
  /** A fire landed while the session was busy; deliver on its next idle. Repeat fires coalesce into this flag. */
  pending: boolean
  /** Next wall-clock fire in epoch ms. Absent for a pending one-shot (idle is all it still waits for) and for a job parked in `failure`. */
  nextFire?: number
  /**
   * Prompt message ID for the current in-flight delivery attempt, minted just
   * before dispatch; after a transport failure it is what host-state
   * correlation looks up. A completed or definitively rejected non-terminal
   * attempt clears it before the next occurrence.
   */
  messageID?: string
  /** Delivery attempts made for the current accountable fire so far. */
  attempts?: number
  /** Set when delivery is abandoned: the job no longer fires but stays visible in the list until deleted. */
  failure?: DeliveryFailure
}

export type DeliveryFailure = {
  /** "rejected" = the host definitively refused every attempt; "ambiguous" = acceptance is unknowable and a retry could deliver the reminder twice. */
  kind: "rejected" | "ambiguous"
  at: number
  attempts: number
  detail: string
}

export type DeliveryResult =
  /** The host accepted the prompt — directly, or confirmed by correlation after a transport failure. */
  | { outcome: "delivered" }
  /** Another prompt just started this session; hold this fire for its next idle transition. */
  | { outcome: "deferred" }
  /** The host definitively did not accept the prompt: nothing was enqueued, so a retry cannot duplicate it. */
  | { outcome: "rejected"; reason: string }
  /** Acceptance could not be determined: the prompt may have landed, so a retry could deliver it twice. */
  | { outcome: "unknown"; reason: string }

export type SchedulerDeps = {
  now(): number
  setTimer(run: () => void, delayMs: number): unknown
  clearTimer(timer: unknown): void
  /** Whether the owning session can receive a prompt right now. */
  isIdle(sessionID: string): Promise<boolean>
  /** Deliver a fired job's prompt. Call beginAttempt immediately before dispatch; undefined means the job was removed. */
  deliver(
    job: CronJob,
    beginAttempt: () => string | undefined,
  ): Promise<DeliveryResult>
  /** Mint a host-compatible prompt message ID for a delivery attempt. */
  mintMessageID(job: CronJob): string
  /** Notify the host UI after a job enters its terminal parked state. */
  onFailure?(job: CronJob): void
  log?(level: "info" | "warn" | "error", message: string): void
}

export type Scheduler = {
  create(input: {
    sessionID: string
    cron: string
    prompt: string
    recurring: boolean
  }): CronJob
  list(sessionID: string): CronJob[]
  /** Delete a job, but only if the given session owns it. */
  remove(id: string, sessionID: string): boolean
  /** The session just went idle: deliver whatever fired while it was busy. */
  onSessionIdle(sessionID: string): void
  dropSession(sessionID: string): void
  dispose(): void
}

export const RECURRING_TTL_MS = 7 * 24 * 60 * 60 * 1000

export const MAX_JOBS_PER_SESSION = 50

/** Total delivery attempts for a terminal fire the host keeps refusing, before the job is parked as failed. */
export const MAX_DELIVERY_ATTEMPTS = 3

/** Pause between delivery attempts of a terminal fire the host definitively refused. */
export const RETRY_DELAY_MS = 60 * 1000

// Longest single arm; a tick with nothing due simply re-arms. Keeps delays far
// from the 32-bit setTimeout ceiling no matter what croner returns.
const MAX_ARM_MS = 30 * 60 * 1000

type CronField = { name: string; min: number; max: number }

const CRON_FIELDS: CronField[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  // Vixie cron: both 0 and 7 mean Sunday.
  { name: "day-of-week", min: 0, max: 7 },
]

function validateField(field: string, spec: CronField): string | undefined {
  for (const item of field.split(",")) {
    const parts = item.split("/")
    // `String.split` always yields at least one element, so `base` is really a
    // string; the `= ""` default only satisfies the checker and folds into the
    // existing empty-base malformed check below.
    const [base = "", step] = parts
    if (parts.length > 2 || base === "" || step === "") {
      return `${spec.name} entry ${JSON.stringify(item)} is malformed`
    }
    if (step !== undefined) {
      if (!/^\d+$/.test(step) || Number(step) < 1) {
        return `${spec.name} step in ${JSON.stringify(item)} must be a positive integer`
      }
      if (base !== "*" && !/^\d+-\d+$/.test(base)) {
        return `${spec.name} entry ${JSON.stringify(item)}: a step needs "*" or a range before the "/"`
      }
    }
    if (base === "*") continue
    const range = base.match(/^(\d+)(?:-(\d+))?$/)
    if (!range) {
      return `${spec.name} entry ${JSON.stringify(item)} is not plain cron — names (MON, JAN) and L, W, ?, # are not supported`
    }
    const low = Number(range[1])
    const high = range[2] !== undefined ? Number(range[2]) : low
    if (low > high) {
      return `${spec.name} range ${JSON.stringify(item)} is reversed`
    }
    if (low < spec.min || high > spec.max) {
      return `${spec.name} must be within ${spec.min}-${spec.max}, got ${JSON.stringify(item)}`
    }
  }
  return undefined
}

/**
 * Returns a human-readable problem with the expression, or undefined if it is
 * a valid 5-field cron in the plain dialect: wildcards, numeric values,
 * ranges, steps, and comma lists. Croner itself is far more permissive
 * (6-field seconds patterns, MON/JAN names, L/W/?/# extensions); those are
 * rejected field-by-field here to stay on the standard dialect.
 */
export function validateCron(expression: string): string | undefined {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    return `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`
  }
  for (const [i, spec] of CRON_FIELDS.entries()) {
    // `fields.length === 5 === CRON_FIELDS.length` is enforced above, so every
    // field is present; the guard just discharges the index-access type.
    const field = fields[i]
    if (field === undefined) continue
    const problem = validateField(field, spec)
    if (problem) return problem
  }
  try {
    new Cron(expression)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return undefined
}

/** Next wall-clock match strictly after `afterMs`, in epoch ms; undefined when the pattern never matches again. */
export function nextMatch(
  expression: string,
  afterMs: number,
): number | undefined {
  return nextRunAfter(new Cron(expression), afterMs)
}

// One parsed Cron per job object, replaced if the job's expression ever
// changes (jobs are immutable today; the guard means an edit path added
// later cannot serve a stale schedule). Reuse is safe because a callback-free
// croner instance never arms a timer — croner only schedules when handed a
// callback — and nextRun with an explicit "from" date reads no instance
// state, so it stays pure. WeakMap keying makes cleanup automatic when a job
// is dropped, however it leaves the store.
const parsers = new WeakMap<object, { expression: string; parser: Cron }>()

function parserFor(job: Pick<CronJob, "cron">): Cron {
  const cached = parsers.get(job)
  if (cached && cached.expression === job.cron) return cached.parser
  const parser = new Cron(job.cron)
  parsers.set(job, { expression: job.cron, parser })
  return parser
}

function nextRunAfter(parser: Cron, afterMs: number): number | undefined {
  const next = parser.nextRun(new Date(afterMs))
  return next ? next.getTime() : undefined
}

export const RECURRING_JITTER_MAX_MS = 30 * 60 * 1000
export const ONE_SHOT_EARLY_JITTER_MAX_MS = 90 * 1000

// FNV-1a over the job identity → stable fraction in [0, 1). Seeded with the
// session ID as well as the job ID because sequential IDs repeat across
// processes — every process's first job is cron_1, and fleet-wide diversity
// is the whole point of the jitter.
function jitterFraction(job: Pick<CronJob, "id" | "sessionID">): number {
  const seed = `${job.sessionID}\n${job.id}`
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 0x1_0000_0000
}

/**
 * Next fire time after `afterMs` with the job's deterministic jitter applied,
 * so scheduled requests from across the fleet do not land on the model
 * providers at the same instant. Recurring jobs fire up to 30 minutes past
 * the cron match — at most half the interval, for schedules more frequent
 * than hourly. One-shots pinned to :00/:30 (where everyone's "at 9am" lands)
 * fire up to 90 seconds early; any other minute fires exactly. The offset is
 * derived from the job identity, so a given job always gets the same one.
 */
export function nextFireAfter(
  job: Pick<CronJob, "id" | "sessionID" | "cron" | "recurring">,
  afterMs: number,
): number | undefined {
  const parser = parserFor(job)
  const nominal = nextRunAfter(parser, afterMs)
  if (nominal === undefined) return undefined
  const fraction = jitterFraction(job)
  if (!job.recurring) {
    const minute = new Date(nominal).getMinutes()
    if (minute !== 0 && minute !== 30) return nominal
    return Math.max(
      nominal - Math.round(fraction * ONE_SHOT_EARLY_JITTER_MAX_MS),
      afterMs,
    )
  }
  const following = nextRunAfter(parser, nominal)
  const cap =
    following === undefined
      ? RECURRING_JITTER_MAX_MS
      : Math.min(RECURRING_JITTER_MAX_MS, Math.floor((following - nominal) / 2))
  return nominal + Math.round(fraction * cap)
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const jobs = new Map<string, CronJob>()
  // Guards each job against overlapping fire paths (timer tick vs idle flush).
  const firing = new Set<string>()
  const idleEpochs = new Map<string, number>()
  const deferredAtEpoch = new Map<string, number>()
  let timer: unknown
  let seq = 0
  let disposed = false

  const log = deps.log ?? (() => {})

  function arm(): void {
    if (timer !== undefined) {
      deps.clearTimer(timer)
      timer = undefined
    }
    if (disposed) return
    let earliest: number | undefined
    for (const job of jobs.values()) {
      // One job never overlaps itself. Its completion re-arms the timer, while
      // excluding it here lets every other job keep its own schedule even if
      // this delivery is slow or permanently unresolved.
      if (firing.has(job.id)) continue
      if (
        job.nextFire !== undefined &&
        (earliest === undefined || job.nextFire < earliest)
      ) {
        earliest = job.nextFire
      }
    }
    if (earliest === undefined) return
    const delay = Math.min(Math.max(earliest - deps.now(), 0), MAX_ARM_MS)
    timer = deps.setTimer(() => {
      timer = undefined
      void tick()
    }, delay)
  }

  function runReserved(job: CronJob, work: () => Promise<void>): void {
    void (async () => {
      try {
        await work()
      } catch (error) {
        // A job-local failure must not become an unhandled rejection or affect
        // another reservation. The normal delivery paths report failures as
        // state; this is only the last-resort guard around unexpected throws.
        log(
          "error",
          `job ${job.id}: fire failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        firing.delete(job.id)
        const deferredEpoch = deferredAtEpoch.get(job.id)
        deferredAtEpoch.delete(job.id)
        if (
          deferredEpoch !== undefined &&
          (idleEpochs.get(job.sessionID) ?? 0) !== deferredEpoch &&
          jobs.get(job.id) === job &&
          job.pending
        ) {
          // An idle transition raced the initial probe or a deferred delivery
          // while this reservation held the per-job guard. Retry only after
          // releasing it; a one-shot has no timer to recover the missed event.
          firing.add(job.id)
          runReserved(job, () => deliverNow(job))
        }
        arm()
      }
    })()
  }

  function tick(): void {
    const now = deps.now()
    const due = [...jobs.values()].filter(
      (job) => job.nextFire !== undefined && job.nextFire <= now,
    )
    const reserved: CronJob[] = []
    for (const job of due) {
      if (firing.has(job.id) || !jobs.has(job.id)) continue
      // Re-check dueness at reservation time, not just at snapshot time: a
      // mutation or re-entrant path may have delivered and advanced the job.
      if (job.nextFire === undefined || job.nextFire > deps.now()) continue
      firing.add(job.id)
      reserved.push(job)
    }
    // Start in store order, preserving deterministic dispatch order, but do
    // not await one job before starting the next. All reservations are taken
    // first so a re-entrant tick cannot select a later job twice.
    const idleChecks = new Map<string, Promise<boolean>>()
    for (const job of reserved) {
      let idleCheck = idleChecks.get(job.sessionID)
      if (!idleCheck) {
        // Jobs from one session share a snapshot. Besides avoiding duplicate
        // reads, every waiter resumes in reservation order, so delivery calls
        // retain the store ordering even when other sessions answer first.
        idleCheck = Promise.resolve().then(() => deps.isIdle(job.sessionID))
        idleChecks.set(job.sessionID, idleCheck)
      }
      runReserved(job, () => fire(job, idleCheck))
    }
    // In-flight jobs are excluded by arm(); every other job remains timed even
    // if one of the deliveries above never settles.
    arm()
  }

  async function fire(
    job: CronJob,
    idleCheck = deps.isIdle(job.sessionID),
  ): Promise<void> {
    const idleEpoch = idleEpochs.get(job.sessionID) ?? 0
    let idle = false
    try {
      idle = await idleCheck
    } catch {
      // Can't confirm: hold the fire as pending; the next idle event flushes it.
    }
    // The idle probe is an await window: cron_delete, session deletion, or
    // dispose() may have removed the job while it was in flight. A removed
    // job must neither deliver nor be resurrected as pending.
    if (jobs.get(job.id) !== job) return
    if (!idle) {
      job.pending = true
      deferredAtEpoch.set(job.id, idleEpoch)
      // A busy recurring job keeps matching in the background; advancing
      // nextFire here is what coalesces those repeats into one delivery.
      job.nextFire = job.recurring ? nextFireAfter(job, deps.now()) : undefined
      return
    }
    await deliverNow(job)
  }

  async function deliverNow(job: CronJob): Promise<void> {
    job.pending = false
    const firedAt = deps.now()
    const expired = job.expiresAt !== undefined && firedAt >= job.expiresAt
    // Bookkeeping before delivery, so a failed delivery can never double-fire:
    // a recurring job advances past this match up front. The delivery layer
    // invokes beginAttempt only after its pre-dispatch work and any ordering
    // wait, minting the correlation ID at the last responsible moment.
    const followUp =
      job.recurring && !expired ? nextFireAfter(job, firedAt) : undefined
    job.nextFire = followUp
    const idleEpoch = idleEpochs.get(job.sessionID) ?? 0
    let result: DeliveryResult
    try {
      result = await deps.deliver(job, () => {
        if (disposed || jobs.get(job.id) !== job) return undefined
        job.messageID ??= deps.mintMessageID(job)
        return job.messageID
      })
    } catch (error) {
      // deliver reports failures as values; a throw means even the reporting
      // failed, which proves nothing about acceptance.
      result = {
        outcome: "unknown",
        reason: error instanceof Error ? error.message : String(error),
      }
    }
    // The delivery await is a removal window: cron_delete, session deletion,
    // or dispose may have dropped the job — never resurrect it here.
    if (jobs.get(job.id) !== job) return
    if (result.outcome === "deferred") {
      job.pending = true
      job.messageID = undefined
      deferredAtEpoch.set(job.id, idleEpoch)
      return
    }
    if (result.outcome === "delivered") {
      if (followUp === undefined) jobs.delete(job.id)
      else job.messageID = undefined
      return
    }
    if (followUp !== undefined && result.outcome === "rejected") {
      // A non-final recurring fire recovers on its next match; dropping this
      // fire is the accepted cost of never risking a duplicate.
      job.messageID = undefined
      log("error", `job ${job.id}: delivery failed: ${result.reason}`)
      return
    }
    const attempts = (job.attempts ?? 0) + 1
    job.attempts = attempts
    if (result.outcome === "rejected" && attempts < MAX_DELIVERY_ATTEMPTS) {
      // Definitively not enqueued, so a retry cannot duplicate the reminder.
      // The stale ID is discarded — message IDs are time-ordered, and a turn
      // completed during the pause would leave a reused ID older than the
      // latest assistant message: the host stores such a prompt but its run
      // loop exits without executing it. The pause itself runs from the
      // rejection, not the attempt start, so a slow attempt cannot eat it.
      job.messageID = undefined
      job.nextFire = deps.now() + RETRY_DELAY_MS
      log(
        "warn",
        `job ${job.id}: the host did not accept the prompt (attempt ${attempts}/${MAX_DELIVERY_ATTEMPTS}): ${result.reason}`,
      )
      return
    }
    // Either the host refused every terminal-fire attempt, or acceptance is
    // unknowable and another occurrence could overlap a request that is still
    // live. Park the job, unscheduled, so the list shows what happened instead
    // of losing the fire silently or risking a duplicate.
    job.nextFire = undefined
    job.failure = {
      kind: result.outcome === "rejected" ? "rejected" : "ambiguous",
      at: firedAt,
      attempts,
      detail: result.reason,
    }
    log(
      "error",
      `job ${job.id}: delivery ${job.failure.kind === "rejected" ? "failed" : "unconfirmed"} after ${attempts} attempt(s): ${result.reason}`,
    )
    deps.onFailure?.(job)
  }

  return {
    create(input) {
      if (disposed) throw new Error("The cron scheduler is shutting down.")
      let owned = 0
      for (const job of jobs.values()) {
        if (job.sessionID === input.sessionID) owned++
      }
      if (owned >= MAX_JOBS_PER_SESSION) {
        throw new Error(
          `This session already has ${MAX_JOBS_PER_SESSION} cron jobs — the per-session limit. Delete one with cron_delete first.`,
        )
      }
      const now = deps.now()
      if (nextMatch(input.cron, now) === undefined) {
        throw new Error(
          `The expression ${JSON.stringify(input.cron)} never matches a future time.`,
        )
      }
      const job: CronJob = {
        id: `cron_${++seq}`,
        sessionID: input.sessionID,
        cron: input.cron,
        prompt: input.prompt,
        recurring: input.recurring,
        createdAt: now,
        expiresAt: input.recurring ? now + RECURRING_TTL_MS : undefined,
        pending: false,
      }
      job.nextFire = nextFireAfter(job, now)
      jobs.set(job.id, job)
      arm()
      return job
    },

    list(sessionID) {
      return [...jobs.values()]
        .filter((job) => job.sessionID === sessionID)
        .sort((a, b) => a.createdAt - b.createdAt)
    },

    remove(id, sessionID) {
      const job = jobs.get(id)
      if (!job || job.sessionID !== sessionID) return false
      jobs.delete(id)
      deferredAtEpoch.delete(id)
      if (![...jobs.values()].some((other) => other.sessionID === sessionID)) {
        idleEpochs.delete(sessionID)
      }
      arm()
      return true
    },

    onSessionIdle(sessionID) {
      if (![...jobs.values()].some((job) => job.sessionID === sessionID)) return
      idleEpochs.set(sessionID, (idleEpochs.get(sessionID) ?? 0) + 1)
      const pending = [...jobs.values()].filter(
        (job) =>
          job.sessionID === sessionID && job.pending && !firing.has(job.id),
      )
      if (pending.length === 0) return
      // The host publishes both session.status(idle) and the legacy
      // session.idle for a single transition, and awaits neither hook — so a
      // second flush can start while this one is parked in a delivery.
      // Reserving every selected job before the first await keeps concurrent
      // selections disjoint. Each reservation then runs independently, in
      // selection order, so one stuck pending delivery cannot hold the rest.
      for (const job of pending) firing.add(job.id)
      for (const job of pending) {
        runReserved(job, async () => {
          if (jobs.has(job.id)) {
            // Delivery rechecks activity after its own preparation and ordering
            // waits, since this idle event is not a reservation of the session.
            await deliverNow(job)
          }
        })
      }
      arm()
    },

    dropSession(sessionID) {
      let removed = false
      for (const job of [...jobs.values()]) {
        if (job.sessionID !== sessionID) continue
        jobs.delete(job.id)
        deferredAtEpoch.delete(job.id)
        removed = true
      }
      idleEpochs.delete(sessionID)
      if (removed) arm()
    },

    dispose() {
      disposed = true
      jobs.clear()
      idleEpochs.clear()
      deferredAtEpoch.clear()
      if (timer !== undefined) {
        deps.clearTimer(timer)
        timer = undefined
      }
    },
  }
}

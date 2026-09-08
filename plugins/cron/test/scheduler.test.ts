import { describe, expect, test } from "bun:test"
import {
  type CronJob,
  createScheduler,
  type DeliveryResult,
  MAX_DELIVERY_ATTEMPTS,
  MAX_JOBS_PER_SESSION,
  nextFireAfter,
  RECURRING_TTL_MS,
  RETRY_DELAY_MS,
  validateCron,
} from "../src/scheduler"

// All times are parsed as local wall-clock (no trailing Z), matching croner's
// default timezone handling, so these tests are machine-timezone independent.
const START = "2026-07-11T10:00:00"

function at(iso: string): number {
  return new Date(iso).getTime()
}

function harness(startISO = START) {
  let now = at(startISO)
  let nextTimerId = 1
  let idle = true
  let minted = 0
  let isIdleImpl: () => Promise<boolean> = async () => idle
  let deliverImpl: (job: CronJob) => Promise<DeliveryResult> = async () => ({
    outcome: "delivered",
  })
  const timers: Array<{ id: number; at: number; run: () => void }> = []
  // Snapshots of every attempt, and of the successful ones only.
  const deliveries: CronJob[] = []
  const deliveryTimes: number[] = []
  const delivered: CronJob[] = []

  const scheduler = createScheduler({
    now: () => now,
    setTimer: (run, delayMs) => {
      const id = nextTimerId++
      timers.push({ id, at: now + delayMs, run })
      return id
    },
    clearTimer: (timer) => {
      const index = timers.findIndex((t) => t.id === timer)
      if (index >= 0) timers.splice(index, 1)
    },
    isIdle: () => isIdleImpl(),
    mintMessageID: () => `msg_test_${++minted}`,
    deliver: async (job, beginAttempt) => {
      beginAttempt()
      deliveries.push({ ...job })
      deliveryTimes.push(now)
      const result = await deliverImpl(job)
      if (result.outcome === "delivered") delivered.push({ ...job })
      return result
    },
  })

  // Two macrotask turns flush the async tick/flush chains started by run().
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  // Run every fake timer due before the target instant, in time order,
  // letting each tick re-arm follow-up timers inside the window.
  const advance = async (ms: number) => {
    const target = now + ms
    for (;;) {
      await settle()
      const due = [...timers]
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers.splice(timers.indexOf(due), 1)
      now = Math.max(now, due.at)
      due.run()
      await settle()
    }
    now = target
  }

  return {
    scheduler,
    delivered,
    deliveries,
    deliveryTimes,
    timers,
    advance,
    settle,
    setIdle: (value: boolean) => {
      idle = value
    },
    setIsIdle: (impl: () => Promise<boolean>) => {
      isIdleImpl = impl
    },
    setDeliverResult: (result: DeliveryResult) => {
      deliverImpl = async () => result
    },
    setDeliver: (impl: (job: CronJob) => Promise<DeliveryResult>) => {
      deliverImpl = impl
    },
    now: () => now,
    // Moves the clock without running due timers, for tests that fire a
    // stored timer late by hand — real setTimeout lateness.
    setNow: (value: number) => {
      now = value
    },
  }
}

describe("validateCron", () => {
  test("accepts a standard 5-field expression", () => {
    expect(validateCron("*/5 * * * *")).toBeUndefined()
    expect(validateCron("57 8 * * 1-5")).toBeUndefined()
  })

  test("rejects the wrong field count", () => {
    expect(validateCron("* * * *")).toContain("expected 5 fields")
    expect(validateCron("0 * * * * *")).toContain("expected 5 fields")
  })

  test("rejects out-of-range and garbage fields", () => {
    expect(validateCron("99 * * * *")).toContain("minute")
    expect(validateCron("0 25 * * *")).toContain("hour")
    expect(validateCron("a b c d e")).toBeDefined()
  })

  test("accepts every documented operator, including 7 for Sunday", () => {
    expect(validateCron("*/15 8-18 1,15 * 1-5")).toBeUndefined()
    expect(validateCron("0-59/10 * * * *")).toBeUndefined()
    expect(validateCron("0 9 * * 7")).toBeUndefined()
  })

  test("rejects extended syntax croner would otherwise accept", () => {
    expect(validateCron("0 9 * * MON")).toContain("not plain cron")
    expect(validateCron("0 9 * JAN *")).toContain("not plain cron")
    expect(validateCron("0 9 L * *")).toContain("not plain cron")
    expect(validateCron("0 9 15W * *")).toContain("not plain cron")
    expect(validateCron("0 9 ? * *")).toContain("not plain cron")
    expect(validateCron("0 9 * * 1#2")).toContain("not plain cron")
  })

  test("rejects malformed steps and reversed ranges", () => {
    expect(validateCron("5/15 * * * *")).toContain(
      'a step needs "*" or a range',
    )
    expect(validateCron("*/0 * * * *")).toContain("positive integer")
    expect(validateCron("30-10 * * * *")).toContain("reversed")
  })

  test("routes stray-slash and empty entries to 'is malformed', kept distinct from 'not plain cron'", () => {
    // The cron string is built by the model via template substitution
    // ("30 14 <today_dom> <today_month> *"), so a stray or doubled slash and an
    // empty comma entry are the realistic malformed inputs. Each must return
    // the malformed diagnostic and specifically NOT the extended-syntax "not
    // plain cron" message, so the two stay distinguishable to the model.
    for (const expr of [
      "*/5/3 * * * *",
      "/5 * * * *",
      "*/ * * * *",
      "1,,2 * * * *",
    ]) {
      expect(validateCron(expr)).toContain("is malformed")
      expect(validateCron(expr)).not.toContain("not plain cron")
    }
  })

  test("returns croner's own diagnostic for an expression only croner rejects", () => {
    // "0-59/99" passes the field validator (positive-integer step over a range)
    // and is rejected ONLY by the croner backstop. validateCron must RETURN
    // that message, not let new Cron() throw uncaught.
    const problem = validateCron("0-59/99 * * * *")
    expect(problem).toBeDefined()
    expect(problem).toContain("steps cannot be greater")
  })
})

describe("createScheduler", () => {
  test("fires a recurring job at each match while idle and reschedules", async () => {
    const h = harness()
    const job = h.scheduler.create({
      sessionID: "s",
      cron: "*/5 * * * *",
      prompt: "check",
      recurring: true,
    })
    // Jittered: lands in [10:05, 10:07:30] — up to half the 5-minute interval.
    expect(job.nextFire).toBeGreaterThanOrEqual(at("2026-07-11T10:05:00"))
    expect(job.nextFire).toBeLessThanOrEqual(at("2026-07-11T10:07:30"))

    await h.advance(9 * 60_000) // 10:09 — past the 10:05 match plus max jitter
    expect(h.delivered.length).toBe(1)
    expect(h.delivered[0]?.prompt).toBe("check")

    const listed = h.scheduler.list("s")
    expect(listed.length).toBe(1)
    expect(listed[0]?.nextFire).toBeGreaterThanOrEqual(
      at("2026-07-11T10:10:00"),
    )
    expect(listed[0]?.nextFire).toBeLessThanOrEqual(at("2026-07-11T10:12:30"))

    await h.advance(10 * 60_000) // 10:19 — covers the jittered 10:10 and 10:15 fires
    expect(h.delivered.length).toBe(3)
  })

  test("a one-shot fires once and deletes itself", async () => {
    const h = harness()
    const job = h.scheduler.create({
      sessionID: "s",
      cron: "30 14 11 7 *",
      prompt: "remind",
      recurring: false,
    })
    // Pinned to :30, so the early one-shot jitter applies: [14:28:30, 14:30].
    expect(job.nextFire).toBeGreaterThanOrEqual(at("2026-07-11T14:28:30"))
    expect(job.nextFire).toBeLessThanOrEqual(at("2026-07-11T14:30:00"))

    await h.advance(6 * 60 * 60_000)
    expect(h.delivered.length).toBe(1)
    expect(h.scheduler.list("s")).toEqual([])
    expect(h.timers.length).toBe(0)
  })

  test("fires while busy go pending and coalesce into one idle delivery", async () => {
    const h = harness()
    h.setIdle(false)
    h.scheduler.create({
      sessionID: "s",
      cron: "*/5 * * * *",
      prompt: "check",
      recurring: true,
    })

    await h.advance(16 * 60_000)
    expect(h.delivered.length).toBe(0)
    expect(h.scheduler.list("s")[0]?.pending).toBe(true)

    h.setIdle(true)
    h.scheduler.onSessionIdle("s")
    await h.settle()
    expect(h.delivered.length).toBe(1)

    const listed = h.scheduler.list("s")
    expect(listed.length).toBe(1)
    expect(listed[0]?.pending).toBe(false)
    expect(listed[0]?.nextFire).toBeGreaterThan(h.now())
  })

  test("a pending one-shot waits for idle only, then deletes itself", async () => {
    const h = harness()
    h.setIdle(false)
    h.scheduler.create({
      sessionID: "s",
      cron: "5 10 11 7 *",
      prompt: "remind",
      recurring: false,
    })

    await h.advance(10 * 60_000)
    expect(h.delivered.length).toBe(0)
    const pending = h.scheduler.list("s")[0]
    expect(pending?.pending).toBe(true)
    expect(pending?.nextFire).toBeUndefined()

    h.scheduler.onSessionIdle("s")
    await h.settle()
    expect(h.delivered.length).toBe(1)
    expect(h.scheduler.list("s")).toEqual([])
  })

  test.each([false, true])(
    "an idle racing the initial probe is replayed once (recurring=%p)",
    async (recurring) => {
      const h = harness()
      let releaseIdleCheck!: () => void
      h.setIsIdle(
        () =>
          new Promise((resolve) => {
            releaseIdleCheck = () => resolve(false)
          }),
      )
      const job = h.scheduler.create({
        sessionID: "s",
        cron: recurring ? "*/5 * * * *" : "5 10 11 7 *",
        prompt: "remind",
        recurring,
      })

      // Cross several recurring matches while the initial busy result is held.
      // The job is reserved, but not pending yet, so neither idle flush sees it.
      await h.advance(16 * 60_000)
      expect(job.pending).toBe(false)
      expect(h.deliveries).toHaveLength(0)
      expect(h.timers).toHaveLength(0)
      h.setIsIdle(async () => true)
      h.scheduler.onSessionIdle("s")
      h.scheduler.onSessionIdle("s")
      releaseIdleCheck()
      await h.settle()

      // No later idle event or timer is needed to recover the captured busy.
      expect(h.deliveries).toHaveLength(1)
      expect(h.delivered).toHaveLength(1)
      if (recurring) {
        expect(h.scheduler.list("s")).toEqual([job])
        expect(job.pending).toBe(false)
        expect(job.nextFire).toBeGreaterThan(h.now())
        await h.advance(job.nextFire! - h.now())
        expect(h.deliveries).toHaveLength(2)
        expect(h.delivered).toHaveLength(2)
        expect(job.nextFire).toBeGreaterThan(h.now())
      } else {
        expect(h.scheduler.list("s")).toEqual([])
        expect(h.timers).toHaveLength(0)
        await h.advance(24 * 60 * 60_000)
        expect(h.deliveries).toHaveLength(1)
        expect(h.delivered).toHaveLength(1)
      }
    },
  )

  test("a delivery deferred by session ordering waits for the next idle", async () => {
    const h = harness()
    let attempts = 0
    h.setDeliver(async () =>
      ++attempts === 1 ? { outcome: "deferred" } : { outcome: "delivered" },
    )
    h.scheduler.create({
      sessionID: "s",
      cron: "5 10 11 7 *",
      prompt: "remind",
      recurring: false,
    })

    await h.advance(10 * 60_000)
    const pending = h.scheduler.list("s")[0]
    expect(pending?.pending).toBe(true)
    expect(pending?.nextFire).toBeUndefined()
    expect(pending?.messageID).toBeUndefined()

    h.scheduler.onSessionIdle("s")
    await h.settle()
    expect(h.delivered).toHaveLength(1)
    expect(h.scheduler.list("s")).toEqual([])
  })

  test("an idle racing a deferred one-shot is replayed after its guard releases", async () => {
    const h = harness()
    let attempts = 0
    h.setDeliver(async () => {
      attempts++
      if (attempts === 1) {
        // Put the event behind the deferred-result continuation but ahead of
        // runReserved's finally: the job is pending then, but still guarded.
        queueMicrotask(() =>
          queueMicrotask(() =>
            queueMicrotask(() => h.scheduler.onSessionIdle("s")),
          ),
        )
        return { outcome: "deferred" }
      }
      return { outcome: "delivered" }
    })
    h.scheduler.create({
      sessionID: "s",
      cron: "5 10 11 7 *",
      prompt: "remind",
      recurring: false,
    })

    await h.advance(10 * 60_000)

    expect(h.deliveries).toHaveLength(2)
    expect(h.delivered).toHaveLength(1)
    expect(h.scheduler.list("s")).toEqual([])
  })

  test("overlapping idle flushes deliver each pending job exactly once", async () => {
    const h = harness()
    h.setIdle(false)
    h.scheduler.create({
      sessionID: "s",
      cron: "5 10 11 7 *",
      prompt: "one",
      recurring: false,
    })
    h.scheduler.create({
      sessionID: "s",
      cron: "5 10 11 7 *",
      prompt: "two",
      recurring: false,
    })
    await h.advance(10 * 60_000) // both fired busy at 10:05 and went pending
    expect(h.deliveries.length).toBe(0)

    const releases: Array<(result: DeliveryResult) => void> = []
    h.setDeliver(() => new Promise((resolve) => releases.push(resolve)))
    h.setIdle(true)
    // The host publishes session.status(idle) AND the legacy session.idle for
    // one transition, awaiting neither hook: two flushes start back-to-back
    // while the first is parked in a delivery.
    h.scheduler.onSessionIdle("s")
    h.scheduler.onSessionIdle("s")
    await h.settle()
    // The second flush found every pending job already reserved by the first.
    // Both reservations start in job order without waiting on each other.
    expect(h.deliveries.map((d) => d.prompt)).toEqual(["one", "two"])

    while (releases.length > 0) {
      releases.shift()?.({ outcome: "delivered" })
      await h.settle()
    }
    expect(h.scheduler.list("s")).toEqual([])
  })

  test("a permanently unresolved delivery cannot delay another job or overlap its own next fire", async () => {
    const h = harness()
    const stuck = h.scheduler.create({
      sessionID: "s",
      cron: "* * * * *",
      prompt: "stuck",
      recurring: true,
    })
    const later = h.scheduler.create({
      sessionID: "s",
      cron: "3 10 11 7 *",
      prompt: "later",
      recurring: false,
    })
    const laterFire = later.nextFire
    h.setDeliver((job) =>
      job.id === stuck.id
        ? new Promise(() => {})
        : Promise.resolve({ outcome: "delivered" }),
    )

    await h.advance(5 * 60_000)

    expect(h.deliveries.map((d) => d.prompt)).toEqual(["stuck", "later"])
    expect(h.delivered.map((d) => d.prompt)).toEqual(["later"])
    expect(h.deliveryTimes[1]).toBe(laterFire)
    // Several matches of the stuck recurring job passed, but its per-job guard
    // keeps a second delivery from overlapping the unresolved first one.
    expect(h.deliveries.filter((d) => d.id === stuck.id)).toHaveLength(1)
    expect(h.scheduler.list("s").map((job) => job.id)).toEqual([stuck.id])
  })

  test("a recurring job expires after 7 days: the first fire past expiry is the final one", async () => {
    const h = harness()
    const job = h.scheduler.create({
      sessionID: "s",
      cron: "3 12 * * *",
      prompt: "daily",
      recurring: true,
    })
    expect(job.expiresAt).toBe(at(START) + RECURRING_TTL_MS)

    await h.advance(9 * 24 * 60 * 60_000)
    // 12:03 on Jul 11–17 fire normally (7); Jul 18 12:03 is past the Jul 18
    // 10:00 expiry, so it fires one final time and the job is deleted.
    expect(h.delivered.length).toBe(8)
    expect(h.scheduler.list("s")).toEqual([])
  })

  test("remove only deletes jobs owned by the caller's session", async () => {
    const h = harness()
    const job = h.scheduler.create({
      sessionID: "s",
      cron: "*/5 * * * *",
      prompt: "check",
      recurring: true,
    })

    expect(h.scheduler.remove(job.id, "other")).toBe(false)
    expect(h.scheduler.remove("cron_999", "s")).toBe(false)
    expect(h.scheduler.remove(job.id, "s")).toBe(true)

    await h.advance(30 * 60_000)
    expect(h.delivered.length).toBe(0)
  })

  test("a job deleted while the idle check is in flight never delivers", async () => {
    const h = harness()
    let releaseIdleCheck!: () => void
    h.setIsIdle(
      () =>
        new Promise((resolve) => {
          releaseIdleCheck = () => resolve(true)
        }),
    )
    const job = h.scheduler.create({
      sessionID: "s",
      cron: "*/5 * * * *",
      prompt: "check",
      recurring: true,
    })

    // The tick fires and blocks inside isIdle; the job is deleted mid-check.
    await h.advance(9 * 60_000)
    expect(h.scheduler.remove(job.id, "s")).toBe(true)

    releaseIdleCheck()
    await h.settle()
    expect(h.delivered.length).toBe(0)
    expect(h.scheduler.list("s")).toEqual([])
  })

  test("dropSession cancels all of a session's jobs and no others", async () => {
    const h = harness()
    h.scheduler.create({
      sessionID: "a",
      cron: "*/5 * * * *",
      prompt: "one",
      recurring: true,
    })
    h.scheduler.create({
      sessionID: "a",
      cron: "*/7 * * * *",
      prompt: "two",
      recurring: true,
    })
    const kept = h.scheduler.create({
      sessionID: "b",
      cron: "*/5 * * * *",
      prompt: "three",
      recurring: true,
    })

    h.scheduler.dropSession("a")
    expect(h.scheduler.list("a")).toEqual([])
    expect(h.scheduler.list("b").map((job) => job.id)).toEqual([kept.id])
  })

  test("dispose clears every timer and refuses new jobs", async () => {
    const h = harness()
    h.scheduler.create({
      sessionID: "s",
      cron: "*/5 * * * *",
      prompt: "check",
      recurring: true,
    })
    h.scheduler.dispose()

    expect(h.timers.length).toBe(0)
    await h.advance(30 * 60_000)
    expect(h.delivered.length).toBe(0)
    expect(() =>
      h.scheduler.create({
        sessionID: "s",
        cron: "* * * * *",
        prompt: "x",
        recurring: true,
      }),
    ).toThrow()
  })

  test("a failed delivery drops the fire but never the recurring job", async () => {
    const h = harness()
    h.scheduler.create({
      sessionID: "s",
      cron: "*/5 * * * *",
      prompt: "check",
      recurring: true,
    })
    h.setDeliverResult({ outcome: "rejected", reason: "session vanished" })

    await h.advance(9 * 60_000) // 10:09 — past the jittered 10:05 fire
    expect(h.delivered.length).toBe(0)
    const listed = h.scheduler.list("s")
    expect(listed.length).toBe(1)
    expect(listed[0]?.nextFire).toBeGreaterThanOrEqual(
      at("2026-07-11T10:10:00"),
    )
    expect(listed[0]?.nextFire).toBeLessThanOrEqual(at("2026-07-11T10:12:30"))
    // Every dispatched fire carries an ID so an ambiguous transport can be
    // correlated and cannot overlap the next occurrence.
    expect(h.deliveries[0]?.messageID).toBe("msg_test_1")
    expect(listed[0]?.messageID).toBeUndefined()

    h.setDeliverResult({ outcome: "delivered" })
    await h.advance(4 * 60_000) // 10:13 — past the jittered 10:10 fire
    expect(h.delivered.length).toBe(1)
  })

  test("enforces the 50-job limit per session", () => {
    const h = harness()
    for (let i = 0; i < MAX_JOBS_PER_SESSION; i++) {
      h.scheduler.create({
        sessionID: "s",
        cron: "*/5 * * * *",
        prompt: `p${i}`,
        recurring: true,
      })
    }
    expect(() =>
      h.scheduler.create({
        sessionID: "s",
        cron: "*/5 * * * *",
        prompt: "extra",
        recurring: true,
      }),
    ).toThrow("per-session limit")

    // The cap is per session, and deleting a job frees a slot.
    expect(() =>
      h.scheduler.create({
        sessionID: "other",
        cron: "*/5 * * * *",
        prompt: "ok",
        recurring: true,
      }),
    ).not.toThrow()
    const first = h.scheduler.list("s")[0]
    expect(h.scheduler.remove(first?.id ?? "", "s")).toBe(true)
    expect(() =>
      h.scheduler.create({
        sessionID: "s",
        cron: "*/5 * * * *",
        prompt: "refill",
        recurring: true,
      }),
    ).not.toThrow()
  })

  test("refuses a field-legal expression that never matches a future time", () => {
    const h = harness()
    // Feb 30 is field-legal — validateCron("0 0 30 2 *") returns undefined — but
    // it never matches, so create() must refuse it rather than store a job with
    // an undefined nextFire that sits in the list forever without ever firing.
    expect(() =>
      h.scheduler.create({
        sessionID: "s",
        cron: "0 0 30 2 *",
        prompt: "p",
        recurring: true,
      }),
    ).toThrow(/never matches a future time/)
    expect(h.scheduler.list("s")).toHaveLength(0)
  })
})

describe("terminal-fire delivery", () => {
  test("a rejected one-shot retries with a freshly minted message ID and can still succeed", async () => {
    const h = harness()
    let attempts = 0
    h.setDeliver(async () =>
      ++attempts === 1
        ? { outcome: "rejected", reason: "503" }
        : { outcome: "delivered" },
    )
    h.scheduler.create({
      sessionID: "s",
      cron: "7 14 11 7 *",
      prompt: "remind",
      recurring: false,
    })

    // 14:07:30 — fired once (exact 14:07 fire), rejected, retry armed.
    await h.advance(4 * 60 * 60_000 + 7 * 60_000 + 30_000)
    expect(h.deliveries.length).toBe(1)
    const listed = h.scheduler.list("s")[0]
    expect(listed?.attempts).toBe(1)
    expect(listed?.nextFire).toBe(at("2026-07-11T14:07:00") + RETRY_DELAY_MS)

    await h.advance(60_000) // 14:08:30 — past the retry
    expect(h.deliveries.length).toBe(2)
    // The rejection discarded the first ID: message IDs are time-ordered, and
    // a turn completed during the pause would leave a reused ID sorting behind
    // the latest assistant — stored by the host but never run.
    expect(h.deliveries[0]?.messageID).toBe("msg_test_1")
    expect(h.deliveries[1]?.messageID).toBe("msg_test_2")
    expect(h.delivered.length).toBe(1)
    expect(h.scheduler.list("s")).toEqual([])
  })

  test("a one-shot the host keeps refusing is parked as failed, not lost", async () => {
    const h = harness()
    h.setDeliverResult({ outcome: "rejected", reason: "boom" })
    const job = h.scheduler.create({
      sessionID: "s",
      cron: "7 14 11 7 *",
      prompt: "remind",
      recurring: false,
    })

    await h.advance(6 * 60 * 60_000)
    expect(h.deliveries.length).toBe(MAX_DELIVERY_ATTEMPTS)
    expect(h.delivered.length).toBe(0)
    const listed = h.scheduler.list("s")[0]
    expect(listed?.failure).toMatchObject({
      kind: "rejected",
      attempts: MAX_DELIVERY_ATTEMPTS,
      detail: "boom",
    })
    expect(listed?.nextFire).toBeUndefined()
    expect(h.timers.length).toBe(0)

    // Parked jobs never fire again but stay deletable.
    expect(h.scheduler.remove(job.id, "s")).toBe(true)
  })

  test("an unconfirmable delivery parks the job immediately — a retry could duplicate it", async () => {
    const h = harness()
    h.setDeliverResult({ outcome: "unknown", reason: "socket dropped" })
    h.scheduler.create({
      sessionID: "s",
      cron: "7 14 11 7 *",
      prompt: "remind",
      recurring: false,
    })

    await h.advance(6 * 60 * 60_000)
    expect(h.deliveries.length).toBe(1)
    expect(h.scheduler.list("s")[0]?.failure).toMatchObject({
      kind: "ambiguous",
      attempts: 1,
      detail: "socket dropped",
    })
    expect(h.timers.length).toBe(0)
  })

  test("an unconfirmable recurring fire is parked before another occurrence can overlap it", async () => {
    const h = harness()
    h.setDeliverResult({ outcome: "unknown", reason: "socket dropped" })
    h.scheduler.create({
      sessionID: "s",
      cron: "*/5 * * * *",
      prompt: "check",
      recurring: true,
    })

    await h.advance(30 * 60_000)

    expect(h.deliveries).toHaveLength(1)
    expect(h.scheduler.list("s")[0]?.failure).toMatchObject({
      kind: "ambiguous",
      attempts: 1,
      detail: "socket dropped",
    })
    expect(h.scheduler.list("s")[0]?.nextFire).toBeUndefined()
    expect(h.timers).toHaveLength(0)
  })

  test("a throwing deliver counts as unconfirmable", async () => {
    const h = harness()
    h.setDeliver(async () => {
      throw new Error("exploded")
    })
    h.scheduler.create({
      sessionID: "s",
      cron: "7 14 11 7 *",
      prompt: "remind",
      recurring: false,
    })

    await h.advance(6 * 60 * 60_000)
    expect(h.scheduler.list("s")[0]?.failure).toMatchObject({
      kind: "ambiguous",
      detail: "exploded",
    })
  })

  test("the final fire of an expired recurring job is accountable too", async () => {
    const h = harness()
    h.setDeliverResult({ outcome: "rejected", reason: "gone" })
    h.scheduler.create({
      sessionID: "s",
      cron: "3 12 * * *",
      prompt: "daily",
      recurring: true,
    })

    await h.advance(8 * 24 * 60 * 60_000)
    // Jul 11–17 12:03 fires are non-final: rejected, dropped, job advances.
    // The Jul 18 fire is past the Jul 18 10:00 expiry and retries before
    // parking the job.
    expect(h.deliveries.length).toBe(7 + MAX_DELIVERY_ATTEMPTS)
    // Every fire is correlated. Each rejected attempt discards its ID; the
    // next occurrence or retry mints a fresh one.
    expect(h.deliveries.slice(0, 7).map((d) => d.messageID)).toEqual([
      "msg_test_1",
      "msg_test_2",
      "msg_test_3",
      "msg_test_4",
      "msg_test_5",
      "msg_test_6",
      "msg_test_7",
    ])
    expect(h.deliveries.slice(7).map((d) => d.messageID)).toEqual([
      "msg_test_8",
      "msg_test_9",
      "msg_test_10",
    ])
    expect(h.scheduler.list("s")[0]?.failure).toMatchObject({
      kind: "rejected",
      attempts: MAX_DELIVERY_ATTEMPTS,
    })
  })

  test("a pending one-shot that is rejected on idle flush still retries", async () => {
    const h = harness()
    h.setIdle(false)
    let attempts = 0
    h.setDeliver(async () =>
      ++attempts === 1
        ? { outcome: "rejected", reason: "no" }
        : { outcome: "delivered" },
    )
    h.scheduler.create({
      sessionID: "s",
      cron: "5 10 11 7 *",
      prompt: "remind",
      recurring: false,
    })

    await h.advance(10 * 60_000) // 10:10 — fired busy, went pending
    expect(h.deliveries.length).toBe(0)

    h.setIdle(true)
    h.scheduler.onSessionIdle("s")
    await h.settle()
    expect(h.deliveries.length).toBe(1)
    const listed = h.scheduler.list("s")[0]
    expect(listed?.pending).toBe(false)
    expect(listed?.nextFire).toBe(h.now() + RETRY_DELAY_MS)

    await h.advance(2 * 60_000)
    expect(h.delivered.length).toBe(1)
    expect(h.scheduler.list("s")).toEqual([])
  })

  test("the retry pause is measured from the rejection, not the attempt start", async () => {
    const h = harness()
    let release!: (result: DeliveryResult) => void
    h.setDeliver(() => new Promise((resolve) => (release = resolve)))
    h.scheduler.create({
      sessionID: "s",
      cron: "7 14 11 7 *",
      prompt: "remind",
      recurring: false,
    })

    await h.advance(4 * 60 * 60_000 + 7 * 60_000) // 14:07 — attempt starts, parked in deliver
    expect(h.deliveries.length).toBe(1)
    await h.advance(2 * RETRY_DELAY_MS) // the attempt itself outlives the intended pause
    release({ outcome: "rejected", reason: "slow 503" })
    await h.settle()

    // A full pause after the rejection — not an immediate, already-overdue retry.
    expect(h.scheduler.list("s")[0]?.nextFire).toBe(h.now() + RETRY_DELAY_MS)
    expect(h.deliveries.length).toBe(1)
  })

  test("a job deleted while delivery is in flight is not resurrected by the failure path", async () => {
    const h = harness()
    let release!: (result: DeliveryResult) => void
    h.setDeliver(() => new Promise((resolve) => (release = resolve)))
    const job = h.scheduler.create({
      sessionID: "s",
      cron: "7 14 11 7 *",
      prompt: "remind",
      recurring: false,
    })

    await h.advance(4 * 60 * 60_000 + 8 * 60_000) // the fire is blocked inside deliver
    expect(h.deliveries.length).toBe(1)
    expect(h.scheduler.remove(job.id, "s")).toBe(true)

    release({ outcome: "rejected", reason: "late" })
    await h.settle()
    expect(h.scheduler.list("s")).toEqual([])
    expect(h.timers.length).toBe(0)
  })
})

describe("parser cache", () => {
  test("the cached per-job parser matches a fresh parse, and an expression edit replaces it", () => {
    const job = {
      id: "cron_1",
      sessionID: "s",
      cron: "*/5 * * * *",
      recurring: true,
    }
    const t = at(START)
    const first = nextFireAfter(job, t)
    expect(nextFireAfter(job, t)).toBe(first as number) // served from the cache
    expect(nextFireAfter({ ...job }, t)).toBe(first as number) // fresh object, fresh parse — same answer

    job.cron = "*/7 * * * *"
    expect(nextFireAfter(job, t)).toBe(nextFireAfter({ ...job }, t) as number) // stale parser replaced
    expect(nextFireAfter(job, t)).not.toBe(first as number)
  })
})

describe("jitter", () => {
  test("recurring fires land at most half the interval past the match, capped at 30 minutes", () => {
    const h = harness()
    const five = h.scheduler.create({
      sessionID: "s",
      cron: "*/5 * * * *",
      prompt: "p",
      recurring: true,
    })
    expect(five.nextFire).toBeGreaterThanOrEqual(at("2026-07-11T10:05:00"))
    expect(five.nextFire).toBeLessThanOrEqual(at("2026-07-11T10:07:30"))

    const daily = h.scheduler.create({
      sessionID: "s",
      cron: "0 9 * * *",
      prompt: "p",
      recurring: true,
    })
    expect(daily.nextFire).toBeGreaterThanOrEqual(at("2026-07-12T09:00:00"))
    expect(daily.nextFire).toBeLessThanOrEqual(at("2026-07-12T09:30:00"))
  })

  test("the offset is deterministic per job identity and varies across sessions", () => {
    const a = harness()
    const b = harness()
    const first = a.scheduler.create({
      sessionID: "s",
      cron: "0 9 * * *",
      prompt: "p",
      recurring: true,
    })
    const again = b.scheduler.create({
      sessionID: "s",
      cron: "0 9 * * *",
      prompt: "p",
      recurring: true,
    })
    expect(again.nextFire).toBe(first.nextFire as number)

    const other = b.scheduler.create({
      sessionID: "another-session",
      cron: "0 9 * * *",
      prompt: "p",
      recurring: true,
    })
    expect(other.nextFire).not.toBe(first.nextFire as number)
  })

  test("one-shots pinned to :00/:30 fire up to 90 seconds early; other minutes are exact", () => {
    const h = harness()
    const onHour = h.scheduler.create({
      sessionID: "s",
      cron: "0 14 11 7 *",
      prompt: "p",
      recurring: false,
    })
    expect(onHour.nextFire).toBeGreaterThanOrEqual(at("2026-07-11T13:58:30"))
    expect(onHour.nextFire).toBeLessThanOrEqual(at("2026-07-11T14:00:00"))

    const offHour = h.scheduler.create({
      sessionID: "s",
      cron: "7 14 11 7 *",
      prompt: "p",
      recurring: false,
    })
    expect(offHour.nextFire).toBe(at("2026-07-11T14:07:00"))
  })

  test("the cap really is HALF the interval, for every identity and every interval", () => {
    // The range assertions above are satisfied by a jitter twice as large as
    // intended, because the identities they use happen to hash below 0.5 of
    // the window. This case sweeps identities whose jitter fraction sits
    // ABOVE the half mark, where doubling the cap pushes the fire past the
    // midpoint between two matches. That is not cosmetic: the reschedule
    // after a fire is nextFireAfter(job, firedAt), so a jittered fire that
    // reaches the following match makes the scheduler skip that match, and a
    // frequent job silently loses one interval per fire — no error, no toast,
    // just fewer fires than the user asked for.
    const t = at(START)
    const windows = [
      { cron: "* * * * *", nominal: "10:01:00", following: "10:02:00" },
      { cron: "*/2 * * * *", nominal: "10:02:00", following: "10:04:00" },
      { cron: "*/5 * * * *", nominal: "10:05:00", following: "10:10:00" },
      { cron: "*/10 * * * *", nominal: "10:10:00", following: "10:20:00" },
    ]
    // Fractions: alpha .667, sess-b .659, another-session .547 (all above the
    // half mark, so they discriminate), plus s .368 and beta .038 for spread.
    const sessions = ["alpha", "sess-b", "another-session", "s", "beta"]
    for (const { cron, nominal, following } of windows) {
      const start = at(`2026-07-11T${nominal}`)
      const next = at(`2026-07-11T${following}`)
      for (const sessionID of sessions) {
        const job = { id: "cron_1", sessionID, cron, recurring: true }
        const fire = nextFireAfter(job, t) as number
        const label = `${cron} @ ${sessionID}`
        expect({ label, early: fire < start }).toEqual({ label, early: false })
        expect({ label, offset: fire - start <= (next - start) / 2 }).toEqual({
          label,
          offset: true,
        })
        expect({ label, beforeNext: fire < next }).toEqual({
          label,
          beforeNext: true,
        })
      }
    }
  })

  test("a recurring fire lands at its exact deterministic offset", () => {
    // One pinned value, so a change to the fraction, the cap, or the rounding
    // has to be made deliberately rather than drifting inside a range.
    const fire = nextFireAfter(
      { id: "cron_1", sessionID: "s", cron: "*/5 * * * *", recurring: true },
      at(START),
    )
    expect(fire).toBe(at("2026-07-11T10:05:00") + 55_224)
  })
})

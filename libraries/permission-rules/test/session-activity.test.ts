import { describe, expect, test } from "bun:test"
import {
  createSessionActivityTracker,
  SESSION_STATUS_PROBE_TIMEOUT_MS,
  sessionActivityFromEvent,
} from "../src/index"

/**
 * The busy/idle tracker cron and background-tasks now share (audit 2026-07-23
 * §2.2). Both had their own copy of the same core and disagreed on every leg
 * of it; these tests pin the answers the consolidation settled rather than
 * either fork's behavior:
 *
 *   - an observation beats a request. A session the event feed has described
 *     is answered from that record, with no call at all — the host publishes
 *     session.status into the plugin hooks synchronously BEFORE it mutates the
 *     map the endpoint serves, so a cross-check could only ever confirm.
 *   - a session it has NOT described goes to the host on every check, and the
 *     answer is not cached: that leg exists precisely because the feed has
 *     said nothing, so caching "busy" would need an idle event from the same
 *     silent feed to clear it (background-tasks' reading, over cron's).
 *   - anything unknown is not idle: a non-2xx, a throw, a deadline, an
 *     unreadable payload, an absent route (cron's reading, over
 *     background-tasks' "keep the event-derived answer").
 *   - only the literal "idle" is idle. "retry" is a sleeping attempt inside a
 *     live run, and a status type this suite has not heard of gets the same
 *     treatment as busy.
 *
 * Host ground truth throughout, opencode v1.18.5: session/status.ts:39-48
 * (publish, then delete-on-idle / set-otherwise — so the map lists only
 * non-idle sessions), plugin/index.ts:251-258 (hooks called inline from the
 * publish), core/event.ts:606-612 (live listeners, no replay),
 * session/processor.ts:656-674 (retry is inside the run),
 * session/session.ts:608-628 (deleting a session leaves its status entry).
 */

type StatusResult = { data?: unknown; error?: unknown }

type Call = { query?: unknown; signal?: AbortSignal; bound: boolean }

/** A client whose session.status behaves however the test needs it to. */
function makeClient(answer: () => Promise<StatusResult>) {
  const calls: Call[] = []
  const session = {
    _client: {},
    // Mimics the generated SDK client: a prototype method reading `this`, so a
    // tracker that detached the reference would throw here exactly like the
    // real one does.
    status(
      this: unknown,
      input: { query?: unknown; signal?: AbortSignal },
    ): Promise<StatusResult> {
      calls.push({
        query: input?.query,
        signal: input?.signal,
        bound:
          (this as { _client?: unknown } | undefined)?._client !== undefined,
      })
      return answer()
    },
  }
  return { client: { session }, calls }
}

/** The common case: a host that answers with the map it was handed. */
function trackerOver(map: Record<string, unknown> = {}) {
  const { client, calls } = makeClient(async () => ({ data: map }))
  return {
    calls,
    map,
    tracker: createSessionActivityTracker({ client, directory: "/project" }),
  }
}

/**
 * A host whose answer the test releases by hand. The window between the call
 * and the release is the one an event can land in — the interleaving the
 * "observation beats a request" rule has to survive, and the only one a fake
 * that resolves immediately cannot open.
 */
function deferredTracker() {
  let release!: (result: StatusResult) => void
  const { client, calls } = makeClient(
    () =>
      new Promise<StatusResult>((resolve) => {
        release = resolve
      }),
  )
  return {
    calls,
    tracker: createSessionActivityTracker({ client, directory: "/p" }),
    release: (result: StatusResult) => {
      release(result)
    },
  }
}

const statusEvent = (sessionID: unknown, type: unknown) => ({
  type: "session.status",
  properties: { sessionID, status: { type } },
})

describe("createSessionActivityTracker: what the events settle", () => {
  test("an observed idle is answered without asking the host", async () => {
    const h = trackerOver({ ses_1: { type: "busy" } })

    expect(h.tracker.observe(statusEvent("ses_1", "idle"))).toEqual({
      sessionID: "ses_1",
      activity: "idle",
    })

    // The map still says busy. It is the STALER of the two: the host publishes
    // the event and only then deletes the key, so a read here would answer
    // with the state this event just superseded.
    expect(await h.tracker.isIdle("ses_1")).toBe(true)
    expect(h.calls).toEqual([])
  })

  test("an observed busy is answered without asking the host", async () => {
    const h = trackerOver()

    expect(h.tracker.observe(statusEvent("ses_1", "busy"))).toEqual({
      sessionID: "ses_1",
      activity: "busy",
    })
    expect(await h.tracker.isIdle("ses_1")).toBe(false)
    expect(h.calls).toEqual([])
  })

  test("a refresh bypasses stale idle but never second-guesses observed busy", async () => {
    const h = trackerOver({ ses_1: { type: "busy" } })

    h.tracker.observe(statusEvent("ses_1", "idle"))
    expect(await h.tracker.isIdle("ses_1", { refresh: true })).toBe(false)
    expect(h.calls).toHaveLength(1)

    h.tracker.observe(statusEvent("ses_1", "busy"))
    expect(await h.tracker.isIdle("ses_1", { refresh: true })).toBe(false)
    expect(h.calls).toHaveLength(1)
  })

  test("retry is not idle: it is a sleeping attempt inside a live run", async () => {
    const h = trackerOver()

    expect(h.tracker.observe(statusEvent("ses_1", "retry"))?.activity).toBe(
      "retry",
    )
    expect(await h.tracker.isIdle("ses_1")).toBe(false)
  })

  test("a status type this suite has not heard of is not idle", async () => {
    const h = trackerOver()

    // A host that grows a fourth SessionStatus must be non-idle from the day
    // it ships, not the day this suite hears of it.
    expect(
      h.tracker.observe(statusEvent("ses_1", "compacting"))?.activity,
    ).toBe("busy")
    expect(await h.tracker.isIdle("ses_1")).toBe(false)
  })

  test("a status event that cannot be read is recorded as not idle", async () => {
    const h = trackerOver()

    // It is still a status CHANGE; the only safe reading of an unreadable one
    // is "not idle", and the next idle event clears it.
    for (const status of [undefined, null, {}, { type: 7 }, { type: "" }]) {
      const seen = h.tracker.observe({
        type: "session.status",
        properties: { sessionID: "ses_1", status },
      })
      expect(seen?.activity, JSON.stringify(status)).toBe("busy")
    }
    expect(await h.tracker.isIdle("ses_1")).toBe(false)
    expect(h.calls).toEqual([])
  })

  test("the deprecated session.idle form records idle on its own", async () => {
    const h = trackerOver({ ses_1: { type: "busy" } })

    // It carries no status payload at all, and a host that ever publishes only
    // the legacy form still has to track correctly.
    expect(
      h.tracker.observe({
        type: "session.idle",
        properties: { sessionID: "ses_1" },
      }),
    ).toEqual({ sessionID: "ses_1", activity: "idle" })
    expect(await h.tracker.isIdle("ses_1")).toBe(true)
  })

  test("session.deleted evicts, and reports the deletion for the caller to act on", async () => {
    const h = trackerOver({})
    h.tracker.observe(statusEvent("ses_1", "busy"))

    expect(
      h.tracker.observe({
        type: "session.deleted",
        properties: { sessionID: "ses_1", info: { id: "ses_1" } },
      }),
    ).toEqual({ sessionID: "ses_1", activity: "gone" })

    // Evicted rather than recorded idle: the host never clears its own entry
    // for a deleted session, so a stale record here would be the only one
    // nothing could ever correct.
    expect(await h.tracker.isIdle("ses_1")).toBe(true)
    expect(h.calls.length).toBe(1)
  })

  test("session.deleted resolves its id from either shape the wire carries", () => {
    const h = trackerOver()

    // The v1 SDK types only `info`; the publish sends both (session.ts:624).
    expect(
      h.tracker.observe({
        type: "session.deleted",
        properties: { sessionID: "ses_from_id" },
      })?.sessionID,
    ).toBe("ses_from_id")
    expect(
      h.tracker.observe({
        type: "session.deleted",
        properties: { info: { id: "ses_from_info" } },
      })?.sessionID,
    ).toBe("ses_from_info")
  })

  test("an event that says nothing about session activity is ignored", () => {
    const h = trackerOver()

    for (const event of [
      undefined,
      {},
      { type: "permission.asked", properties: { sessionID: "ses_1" } },
      { type: "session.status", properties: { sessionID: 7, status: {} } },
      { type: "session.status" },
      { type: "session.idle", properties: {} },
      { type: "session.deleted", properties: { info: {} } },
    ]) {
      expect(h.tracker.observe(event), JSON.stringify(event)).toBeUndefined()
    }
  })

  test("clear() forgets every observation", async () => {
    const h = trackerOver({ ses_1: { type: "busy" } })
    h.tracker.observe(statusEvent("ses_1", "idle"))

    h.tracker.clear()

    // Back to unseen, so the host decides — and it says busy.
    expect(await h.tracker.isIdle("ses_1")).toBe(false)
    expect(h.calls.length).toBe(1)
  })

  test("the record is bounded, and eviction only costs a request", async () => {
    const h = trackerOver({})
    h.tracker.observe(statusEvent("ses_oldest", "busy"))
    for (let i = 0; i < 600; i++)
      h.tracker.observe(statusEvent(`ses_${i}`, "busy"))

    // Dropping the oldest is safe here in a way it would not be for a
    // busy-only set: an evicted entry reads as unseen, and unseen asks the
    // host rather than guessing idle.
    expect(await h.tracker.isIdle("ses_oldest")).toBe(true)
    expect(h.calls.length).toBe(1)
    expect(await h.tracker.isIdle("ses_599")).toBe(false)
    expect(h.calls.length).toBe(1)
  })
})

describe("sessionActivityFromEvent", () => {
  // subagent-comms shares this parse and keeps its own endpoint-first answer
  // (§2.9), so the two must not be able to drift: three plugins narrowing
  // session.status payloads by hand is how the shapes come apart.
  test("is exactly what the tracker records", () => {
    const events = [
      statusEvent("ses_1", "idle"),
      statusEvent("ses_1", "busy"),
      statusEvent("ses_1", "retry"),
      statusEvent("ses_1", "compacting"),
      { type: "session.status", properties: { sessionID: "ses_1" } },
      { type: "session.idle", properties: { sessionID: "ses_1" } },
      { type: "session.deleted", properties: { info: { id: "ses_1" } } },
      { type: "session.deleted", properties: { sessionID: "ses_1" } },
      { type: "permission.asked", properties: { sessionID: "ses_1" } },
      { type: "session.status", properties: { sessionID: 7 } },
      undefined,
    ]

    for (const event of events) {
      const h = trackerOver()
      expect(h.tracker.observe(event), JSON.stringify(event)).toEqual(
        sessionActivityFromEvent(event),
      )
    }
  })

  test("keeps no state and asks the host nothing", async () => {
    const h = trackerOver({ ses_1: { type: "busy" } })

    // Parsing an idle is not observing one: a consumer that only borrows the
    // parse must not silently seed someone else's record.
    expect(sessionActivityFromEvent(statusEvent("ses_1", "idle"))).toEqual({
      sessionID: "ses_1",
      activity: "idle",
    })
    expect(sessionActivityFromEvent(statusEvent("ses_1", "idle"))).toEqual({
      sessionID: "ses_1",
      activity: "idle",
    })
    expect(await h.tracker.isIdle("ses_1")).toBe(false)
    expect(h.calls.length).toBe(1)
  })
})

describe("createSessionActivityTracker: the fallback read", () => {
  test("a session no event has described is asked about, scoped to this project", async () => {
    const h = trackerOver({})

    expect(await h.tracker.isIdle("ses_1")).toBe(true)
    // /session/status is directory-scoped; an unscoped call answers for the
    // server process's cwd, where our session's absence would read as idle.
    expect(h.calls.map((call) => call.query)).toEqual([
      { directory: "/project" },
    ])
    expect(h.calls[0]?.bound).toBe(true)
  })

  test("presence in the map is not idle, whatever the entry says", async () => {
    for (const entry of [
      { type: "busy" },
      { type: "retry", attempt: 2, next: 1 },
      { type: "compacting" },
      {},
      null,
      "busy",
    ]) {
      const h = trackerOver({ ses_1: entry })
      expect(await h.tracker.isIdle("ses_1"), JSON.stringify(entry)).toBe(false)
    }
  })

  test("an entry the host reports idle is idle", async () => {
    // The route only ever lists non-idle sessions, but `{type:"idle"}` is a
    // member of the schema it serves, so reading the type beats reading the
    // key's presence: a host that started listing idle sessions would
    // otherwise hold every delivery forever.
    const h = trackerOver({ ses_1: { type: "idle" } })

    expect(await h.tracker.isIdle("ses_1")).toBe(true)
  })

  test("the answer is not cached: another check reads again", async () => {
    const h = trackerOver({ ses_1: { type: "busy" } })

    expect(await h.tracker.isIdle("ses_1")).toBe(false)
    // The turn ended and its idle event never reached this process — the one
    // case this leg exists for. Nothing but another read can notice.
    delete h.map.ses_1
    expect(await h.tracker.isIdle("ses_1")).toBe(true)
    expect(h.calls.length).toBe(2)
  })

  test("an event arriving after a read stops the reads", async () => {
    const h = trackerOver({})

    expect(await h.tracker.isIdle("ses_1")).toBe(true)
    h.tracker.observe(statusEvent("ses_1", "busy"))
    expect(await h.tracker.isIdle("ses_1")).toBe(false)
    expect(h.calls.length).toBe(1)
  })

  test("an event arriving DURING a read beats the request's older snapshot", async () => {
    const h = deferredTracker()

    const answer = h.tracker.isIdle("ses_1")
    await Promise.resolve()
    // A turn started while the request was in flight. The host published this
    // into the plugin hooks BEFORE it wrote the map the response was cloned
    // from, so the record is strictly the newer of the two — and the empty
    // map below is what an unseen session's fallback would otherwise read as
    // "idle, go ahead and prompt".
    h.tracker.observe(statusEvent("ses_1", "busy"))
    h.release({ data: {} })

    expect(await answer).toBe(false)
    expect(h.calls.length).toBe(1)
  })

  test("a mid-read idle beats a snapshot that still says busy", async () => {
    const h = deferredTracker()

    const answer = h.tracker.isIdle("ses_1")
    await Promise.resolve()
    h.tracker.observe(statusEvent("ses_1", "idle"))
    // The map lags by exactly one publish: an idle transition deletes the key
    // only after the event has already walked the hooks.
    h.release({ data: { ses_1: { type: "busy" } } })

    expect(await answer).toBe(true)
  })

  test("an event arriving during a refreshed idle read beats its snapshot", async () => {
    const h = deferredTracker()
    h.tracker.observe(statusEvent("ses_1", "idle"))

    const answer = h.tracker.isIdle("ses_1", { refresh: true })
    await Promise.resolve()
    h.tracker.observe(statusEvent("ses_1", "busy"))
    h.release({ data: {} })

    expect(await answer).toBe(false)
    expect(h.calls).toHaveLength(1)
  })

  test("a refreshed read detects a racing event after observation eviction", async () => {
    const h = deferredTracker()
    h.tracker.observe(statusEvent("ses_1", "idle"))

    const answer = h.tracker.isIdle("ses_1", { refresh: true })
    await Promise.resolve()
    // Evict the original ses_1 record, then add a new record with the same
    // activity-generation count a numeric revision map would have reused.
    for (let i = 0; i < 500; i++) {
      h.tracker.observe(statusEvent(`other_${i}`, "busy"))
    }
    h.tracker.observe(statusEvent("ses_1", "busy"))
    h.release({ data: {} })

    expect(await answer).toBe(false)
  })

  test("a failed refresh does not reuse the stale idle observation", async () => {
    const { client } = makeClient(async () => ({ error: { code: 500 } }))
    const tracker = createSessionActivityTracker({ client, directory: "/p" })
    tracker.observe(statusEvent("ses_1", "idle"))

    expect(await tracker.isIdle("ses_1", { refresh: true })).toBe(false)
  })

  test("a mid-read failure still prefers what the events said", async () => {
    const h = deferredTracker()

    const answer = h.tracker.isIdle("ses_1")
    await Promise.resolve()
    h.tracker.observe(statusEvent("ses_1", "idle"))
    // Nothing was learned from the HOST, but the feed answered anyway. A
    // wedged host is when a parked delivery can least afford to throw away an
    // idle it would otherwise have to wait for a second time.
    h.release({ error: { code: 500 } })

    expect(await answer).toBe(true)
  })

  test("a mid-read deletion leaves the answer to the host, by design", async () => {
    const h = deferredTracker()

    const answer = h.tracker.isIdle("ses_1")
    await Promise.resolve()
    // A deletion evicts rather than records, so it leaves the re-read nothing
    // to find — deliberately, and this pins that rather than the generation
    // counter a later reader might reach for. The host never clears a deleted
    // session's status entry, so the endpoint IS its steady-state answer, and
    // both consumers drop the session from their own deleted handlers anyway.
    h.tracker.observe({
      type: "session.deleted",
      properties: { info: { id: "ses_1" } },
    })
    h.release({ data: { ses_1: { type: "busy" } } })

    expect(await answer).toBe(false)
  })

  test("a non-2xx answer is not idle", async () => {
    // The generated client resolves with `{ error }` rather than throwing, and
    // its `data` is then undefined — which reads exactly like the empty
    // (all-idle) map unless the error is checked first.
    const { client } = makeClient(async () => ({ error: { code: 500 } }))
    const tracker = createSessionActivityTracker({ client, directory: "/p" })

    expect(await tracker.isIdle("ses_1")).toBe(false)
  })

  test("a payload that is not a status map is not idle", async () => {
    for (const data of [undefined, null, "{}", 7, [{ type: "busy" }]]) {
      const { client } = makeClient(async () => ({ data }))
      const tracker = createSessionActivityTracker({ client, directory: "/p" })
      // An array passes a bare `typeof === "object"` check and then answers
      // "absent, therefore idle" for every session id there is.
      expect(await tracker.isIdle("ses_1"), JSON.stringify(data)).toBe(false)
    }
  })

  test("a transport failure is not idle, thrown either way", async () => {
    for (const answer of [
      async () => {
        throw new Error("socket hang up")
      },
      () => {
        throw new Error("synchronous explosion")
      },
    ]) {
      const { client } = makeClient(answer as () => Promise<StatusResult>)
      const tracker = createSessionActivityTracker({ client, directory: "/p" })
      expect(await tracker.isIdle("ses_1")).toBe(false)
    }
  })

  test("a host with no status route at all is not idle", async () => {
    for (const client of [{}, { session: {} }, { session: { status: 7 } }]) {
      const tracker = createSessionActivityTracker({ client, directory: "/p" })
      expect(await tracker.isIdle("ses_1"), JSON.stringify(client)).toBe(false)
    }
  })

  test("a host that never answers is not idle, and its request is aborted", async () => {
    const { client, calls } = makeClient(
      () => new Promise<StatusResult>(() => {}),
    )
    const tracker = createSessionActivityTracker({
      client,
      directory: "/p",
      timeoutMs: 20,
    })

    expect(await tracker.isIdle("ses_1")).toBe(false)
    // Aborted, not merely stopped waiting: cron awaits this inside the single
    // tick every job shares, and background-tasks inside a per-session queue.
    expect(calls[0]?.signal?.aborted).toBe(true)
  })

  test("the caller's dispose signal cancels a read in flight", async () => {
    const { client, calls } = makeClient(
      () => new Promise<StatusResult>(() => {}),
    )
    const disposing = new AbortController()
    const tracker = createSessionActivityTracker({
      client,
      directory: "/p",
      timeoutMs: 60_000,
      signal: disposing.signal,
    })

    const answer = tracker.isIdle("ses_1")
    disposing.abort()

    expect(await answer).toBe(false)
    expect(calls[0]?.signal?.aborted).toBe(true)
  })

  test("the default deadline is the exported one", () => {
    // Long for a loopback GET, short next to what waits on it.
    expect(SESSION_STATUS_PROBE_TIMEOUT_MS).toBe(10_000)
  })
})

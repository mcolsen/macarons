import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createSlotMounter } from "@macarons/plugin-test-harness/view"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"
import { HISTORY_TIMEOUT_MS, MAX_TRACKED_SESSIONS, tui } from "../src/tui"
import {
  assistant,
  breakingPart,
  floodSessions,
  type MockMessage,
  type MockPart,
  makeApi,
  seedHealthySession,
  settle,
  stepFinish,
} from "./harness"

const NOW = 1_700_000_000_000
const mountSlot = createSlotMounter({ width: 80, height: 12 })
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type History = { info: MockMessage; parts: MockPart[] }[]
type Stage = "headers" | "body"
type Flight = {
  request: Request
  argumentCount: number
  bodyStarted: boolean
  aborts: number
  pending: boolean
  complete: (history: History) => void
  fail: (error?: Error) => void
}

// The host SDK outlives plugin scopes. Only the transport is controlled here:
// session.messages still builds its Request and consumes/parses the real body.
function historyFixture(stage: Stage = "headers", ignoreAbort = false) {
  const host = new AbortController()
  const flights: Flight[] = []
  const scopes: ReturnType<typeof makeApi>[] = []
  const clearTimer = globalThis.clearTimeout
  const setSpy = spyOn(globalThis, "setTimeout")
  const clearSpy = spyOn(globalThis, "clearTimeout")
  const deadlines = () =>
    setSpy.mock.calls.flatMap((call, index) =>
      call[1] === HISTORY_TIMEOUT_MS
        ? [
            {
              fire: call[0] as () => void,
              timer: setSpy.mock.results[index]!.value as ReturnType<
                typeof setTimeout
              >,
            },
          ]
        : [],
    )
  const cleared = (timer: ReturnType<typeof setTimeout>) =>
    clearSpy.mock.calls.some((call) => call[0] === timer)

  cleanups.push(async () => {
    try {
      for (const scope of scopes) await scope.dispose()
    } finally {
      // Even an abort-ignoring worker/body must be released if an assertion
      // fails before the test supplies its late result.
      for (const flight of flights) flight.fail()
      host.abort()
      try {
        await settle()
      } finally {
        for (const deadline of deadlines()) clearTimer(deadline.timer)
        setSpy.mockRestore()
        clearSpy.mockRestore()
      }
    }
  })

  const client = createOpencodeClient({
    baseUrl: "http://opencode.internal",
    signal: host.signal,
    fetch: ((...args: [Request]) => {
      const [request] = args
      if (!(request instanceof Request))
        throw new Error("SDK transport must receive a Request")
      const headers = Promise.withResolvers<Response>()
      let body: ReadableStreamDefaultController<Uint8Array> | undefined
      const finish = (history?: History, error?: Error) => {
        if (!flight.pending) return
        flight.pending = false
        request.signal.removeEventListener("abort", onAbort)
        if (body) {
          if (error) body.error(error)
          else {
            body.enqueue(new TextEncoder().encode(JSON.stringify(history)))
            body.close()
          }
        } else if (error) headers.reject(error)
        else headers.resolve(Response.json(history))
      }
      const onAbort = () => {
        flight.aborts++
        if (!ignoreAbort) finish(undefined, request.signal.reason)
      }
      const flight: Flight = {
        request,
        argumentCount: args.length,
        bodyStarted: false,
        aborts: 0,
        pending: true,
        complete: (history) => finish(history),
        fail: (error = new Error("controlled history failure")) =>
          finish(undefined, error),
      }
      flights.push(flight)
      if (stage === "body") {
        const stream = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              body = controller
            },
            pull() {
              flight.bodyStarted = true
            },
          },
          { highWaterMark: 0 },
        )
        headers.resolve(
          new Response(stream, {
            headers: { "content-type": "application/json" },
          }),
        )
      }
      // Native fetch errors an in-progress response body on abort. A bare
      // Response(stream) does not, so model that transport responsibility.
      request.signal.addEventListener("abort", onAbort, { once: true })
      if (request.signal.aborted) onAbort()
      return headers.promise
    }) as typeof fetch,
  })

  return {
    host,
    client,
    flights,
    deadlines,
    cleared,
    expire() {
      expect(HISTORY_TIMEOUT_MS).toBe(30_000)
      expect(deadlines()).toHaveLength(1)
      const deadline = deadlines()[0]!
      expect(cleared(deadline.timer)).toBe(false)
      // Invoke the captured deadline, not a 30-second wall-clock wait. The
      // production finally must still clear this exact real timer.
      deadline.fire()
    },
    async activate() {
      const harness = makeApi()
      harness.api.client = client
      scopes.push(harness)
      await tui(harness.api, undefined, {} as any)
      return harness
    },
  }
}

function history(read = 100_000, messageID = "msg_1"): History {
  return [
    {
      info: assistant(messageID, {
        time: { created: NOW - 120_000, completed: NOW - 60_000 },
      }),
      parts: [
        stepFinish(messageID === "msg_1" ? "prt_prev" : "prt_old", messageID, {
          input: 2_000,
          cache: { read, write: 3_000 },
        }),
      ],
    },
  ]
}

function healthyPart() {
  // Later breakingPart events update this request, so its healthy usage cannot
  // become a separate predecessor that masks whether history seeded the floor.
  return stepFinish("prt_cur", "msg_2", {
    input: 2_000,
    cache: { read: 103_000 },
  })
}

describe("SDK history ownership (#251)", () => {
  test("seeds full history through the real SDK once and updates the mounted sidebar", async () => {
    const fixture = historyFixture()
    const harness = await fixture.activate()
    harness.messages.set("ses_1", [
      assistant("msg_2", { time: { created: NOW } }),
    ])
    const view = await mountSlot(harness)
    expect(view.captureCharFrame()).not.toContain("Cache")
    expect(fixture.flights).toHaveLength(1)
    const flight = fixture.flights[0]!
    expect(flight.request).toBeInstanceOf(Request)
    expect(flight.argumentCount).toBe(1)
    expect(flight.request.method).toBe("GET")
    expect(new URL(flight.request.url).pathname).toBe("/session/ses_1/message")

    harness.emitPartUpdated(healthyPart(), NOW)
    harness.emitPartUpdated(healthyPart(), NOW)
    await settle()
    expect(fixture.flights).toHaveLength(1)
    flight.complete(history())
    await settle()
    await view.renderOnce()
    const frame = view.captureCharFrame()
    expect(frame).toContain("hit 97%")
    expect(frame).toContain("203k cached")
    expect(frame).toContain("3k written")
    expect(frame).toContain("4k fresh")
    expect(harness.toasts).toHaveLength(0)
    expect(fixture.deadlines()).toHaveLength(1)
    expect(fixture.cleared(fixture.deadlines()[0]!.timer)).toBe(true)
    expect(flight.request.signal.aborted).toBe(false)

    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.message).toContain("1k of 100k")
    harness.emitPartUpdated(healthyPart(), NOW)
    await settle()
    expect(fixture.flights).toHaveLength(1)
  })

  test("a late SDK snapshot preserves the store's fresher usage", async () => {
    const fixture = historyFixture()
    const harness = await fixture.activate()
    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(healthyPart(), NOW)
    await settle()
    fixture.flights[0]!.complete(history(1_000))
    await settle()

    harness.messages.set("ses_1", [
      assistant("msg_2", { time: { created: NOW } }),
    ])
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.message).toContain("1k of 100k")
    expect(fixture.flights).toHaveLength(1)
  })

  test.each(["headers", "body"] as const)(
    "disposal aborts pending %s without aborting the shared host client",
    async (stage) => {
      const fixture = historyFixture(stage)
      const harness = await fixture.activate()
      seedHealthySession(harness, NOW)
      harness.emitPartUpdated(healthyPart(), NOW)
      await settle()
      expect(fixture.flights).toHaveLength(1)
      const flight = fixture.flights[0]!
      expect(flight.pending).toBe(true)
      expect(flight.bodyStarted).toBe(stage === "body")
      expect(fixture.deadlines()).toHaveLength(1)
      expect(fixture.cleared(fixture.deadlines()[0]!.timer)).toBe(false)

      await harness.dispose()
      await settle()
      expect(flight.request.signal.aborted).toBe(true)
      expect(flight.aborts).toBe(1)
      expect(flight.pending).toBe(false)
      expect(harness.api.lifecycle.signal.aborted).toBe(true)
      expect(fixture.host.signal.aborted).toBe(false)
      expect(fixture.cleared(fixture.deadlines()[0]!.timer)).toBe(true)
      expect(harness.disposeErrors).toEqual([])
      expect(harness.handlers.get("message.part.updated")).toHaveLength(0)
      expect(harness.toasts).toHaveLength(0)
      expect(fixture.flights).toHaveLength(1)
    },
  )

  test.each(["headers", "body"] as const)(
    "the deadline aborts pending %s and falls back to the store without retry",
    async (stage) => {
      const fixture = historyFixture(stage)
      const harness = await fixture.activate()
      seedHealthySession(harness, NOW)
      const view = await mountSlot(harness)
      const flight = fixture.flights[0]!
      expect(flight.pending).toBe(true)
      expect(flight.bodyStarted).toBe(stage === "body")

      fixture.expire()
      await settle()
      expect(flight.request.signal.aborted).toBe(true)
      expect(flight.aborts).toBe(1)
      expect(flight.pending).toBe(false)
      expect(fixture.cleared(fixture.deadlines()[0]!.timer)).toBe(true)
      expect(fixture.host.signal.aborted).toBe(false)
      expect(harness.api.lifecycle.signal.aborted).toBe(false)
      expect(harness.toasts).toHaveLength(0)
      await view.renderOnce()
      expect(view.captureCharFrame()).toContain("100k cached")

      harness.emitPartUpdated(breakingPart(), NOW)
      expect(harness.toasts).toHaveLength(1)
      expect(harness.toasts[0]!.message).toContain("1k of 100k")
      harness.emitPartUpdated(healthyPart(), NOW)
      harness.emitPartUpdated(healthyPart(), NOW)
      await settle()
      expect(fixture.flights).toHaveLength(1)
      expect(fixture.deadlines()).toHaveLength(1)
    },
  )

  test("repeated deactivate/reactivate uses fresh scopes on the same live SDK client", async () => {
    const fixture = historyFixture()
    const signals = new Set<AbortSignal>()
    for (let cycle = 0; cycle < 3; cycle++) {
      const harness = await fixture.activate()
      signals.add(harness.api.lifecycle.signal)
      expect(harness.api.client).toBe(fixture.client)
      expect(harness.api.lifecycle.signal.aborted).toBe(false)
      seedHealthySession(harness, NOW)
      harness.emitPartUpdated(healthyPart(), NOW)
      await settle()
      expect(fixture.flights).toHaveLength(cycle + 1)
      expect(fixture.flights[cycle]!.request.signal.aborted).toBe(false)
      await harness.dispose()
      await settle()
      expect(fixture.flights.every((flight) => !flight.pending)).toBe(true)
      expect(
        fixture.flights.every((flight) => flight.request.signal.aborted),
      ).toBe(true)
      expect(fixture.host.signal.aborted).toBe(false)
    }
    expect(signals.size).toBe(3)

    const harness = await fixture.activate()
    harness.messages.set("ses_1", [
      assistant("msg_2", { time: { created: NOW } }),
    ])
    harness.emitPartUpdated(healthyPart(), NOW)
    await settle()
    expect(fixture.flights).toHaveLength(4)
    fixture.flights[3]!.complete(history())
    await settle()
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts[0]!.message).toContain("1k of 100k")
    expect(fixture.host.signal.aborted).toBe(false)
  })

  test.each([
    ["deletion", "headers", "success"],
    ["deletion", "body", "rejection"],
    ["eviction", "body", "success"],
    ["eviction", "headers", "rejection"],
  ] as const)(
    "%s cancels its flight; ignored %s abort and late %s cannot resurrect the entry",
    async (drop, stage, outcome) => {
      const fixture = historyFixture(stage, true)
      const harness = await fixture.activate()
      seedHealthySession(harness, NOW)
      const view = await mountSlot(harness)
      const before = view.captureCharFrame()
      const flight = fixture.flights[0]!
      expect(flight.bodyStarted).toBe(stage === "body")
      if (drop === "deletion") harness.emitSessionDeleted("ses_1")
      else {
        harness.setRouteSession("ses_other")
        floodSessions(harness, MAX_TRACKED_SESSIONS)
      }
      await settle()
      expect(flight.request.signal.aborted).toBe(true)
      expect(flight.pending).toBe(true)
      expect(fixture.host.signal.aborted).toBe(false)
      expect(fixture.cleared(fixture.deadlines()[0]!.timer)).toBe(true)

      // Retain the old Solid owner through teardown. A stale version bump
      // would re-read this changed store, recreate tracking, and fetch again.
      harness.parts.set("msg_1", history(8_000)[0]!.parts)
      if (outcome === "success") flight.complete(history(900_000, "msg_0"))
      else flight.fail()
      await settle()
      await view.renderOnce()
      expect(fixture.flights).toHaveLength(1)
      expect(view.captureCharFrame()).toBe(before)
      expect(harness.toasts).toHaveLength(0)

      // A genuinely new observation may track the id again, with its own
      // one-shot request rather than the cancelled entry's pending latch.
      harness.setRouteSession("ses_1")
      harness.emitPartUpdated(healthyPart(), NOW)
      await settle()
      expect(fixture.flights).toHaveLength(2)
      expect(fixture.flights[1]!.request.signal.aborted).toBe(false)
      fixture.flights[1]!.complete([])
      await settle()
    },
  )

  test.each(["success", "rejection"] as const)(
    "a disposed scope ignores late body %s, queued callbacks, and mounted view reads",
    async (outcome) => {
      const fixture = historyFixture("body", true)
      const harness = await fixture.activate()
      seedHealthySession(harness, NOW)
      const [sessionID, setSessionID] = createSignal("ses_1")
      const view = await mountSlot(() =>
        harness.slotPlugins[0]!.slots.sidebar_content(
          {},
          {
            get session_id() {
              return sessionID()
            },
          },
        ),
      )
      const before = view.captureCharFrame()
      const onPart = harness.handlers.get("message.part.updated")![0]!
      const flight = fixture.flights[0]!
      expect(flight.bodyStarted).toBe(true)
      await harness.dispose()
      expect(flight.request.signal.aborted).toBe(true)
      expect(flight.pending).toBe(true)

      harness.parts.set("msg_1", history(8_000)[0]!.parts)
      if (outcome === "success") flight.complete(history(900_000, "msg_0"))
      else flight.fail()
      await settle()
      await view.renderOnce()
      expect(view.captureCharFrame()).toBe(before)
      expect(fixture.flights).toHaveLength(1)
      expect(harness.toasts).toHaveLength(0)

      onPart({ properties: { part: breakingPart(), time: NOW } })
      const setSpy = spyOn(Map.prototype, "set")
      try {
        setSessionID("ses_after_dispose")
        expect(
          setSpy.mock.calls.some(([key]) => key === "ses_after_dispose"),
        ).toBe(false)
      } finally {
        setSpy.mockRestore()
      }
      await settle()
      await view.renderOnce()
      expect(view.captureCharFrame()).not.toContain("Cache")
      expect(fixture.flights).toHaveLength(1)
      expect(harness.toasts).toHaveLength(0)
      expect(fixture.host.signal.aborted).toBe(false)
      expect(fixture.cleared(fixture.deadlines()[0]!.timer)).toBe(true)
    },
  )

  test.each(["success", "rejection"] as const)(
    "the deadline bounds an abort-ignoring body and discards its late %s",
    async (outcome) => {
      const fixture = historyFixture("body", true)
      const harness = await fixture.activate()
      seedHealthySession(harness, NOW)
      const view = await mountSlot(harness)
      const before = view.captureCharFrame()
      const flight = fixture.flights[0]!
      expect(flight.bodyStarted).toBe(true)
      fixture.expire()
      await settle()
      expect(flight.request.signal.aborted).toBe(true)
      expect(flight.pending).toBe(true)
      expect(fixture.cleared(fixture.deadlines()[0]!.timer)).toBe(true)
      expect(harness.toasts).toHaveLength(0)

      harness.parts.set("msg_1", history(8_000)[0]!.parts)
      if (outcome === "success") flight.complete(history(900_000, "msg_0"))
      else flight.fail()
      await settle()
      await view.renderOnce()
      expect(view.captureCharFrame()).toBe(before)
      expect(fixture.flights).toHaveLength(1)
      expect(harness.toasts).toHaveLength(0)

      harness.emitPartUpdated(healthyPart(), NOW)
      await settle()
      await view.renderOnce()
      expect(view.captureCharFrame()).toContain("111k cached")
      expect(view.captureCharFrame()).not.toContain("900k")
      expect(fixture.flights).toHaveLength(1)
      expect(fixture.host.signal.aborted).toBe(false)
      expect(harness.toasts).toHaveLength(0)
    },
  )
})

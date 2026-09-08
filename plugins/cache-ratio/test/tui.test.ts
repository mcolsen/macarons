import { describe, expect, spyOn, test } from "bun:test"
import { describeGating } from "@macarons/plugin-test-harness/tui"
import { MAX_TRACKED_SESSIONS, resolveOptions, tui } from "../src/tui"
import {
  assistant,
  breakingPart,
  breakingPartFor,
  emitExpiredSequence,
  floodSessions,
  makeApi,
  seedHealthySession,
  seedHealthySessionFor,
  settle,
  stepFinish,
  stepStart,
} from "./harness"

// Engine-level tests: event handler, toast, slot registration, compat gate,
// against the shared mock api in test/harness.ts. The View's JSX and the
// expiry notice's reactive lifecycle are covered by test/view.test.tsx under
// @opentui/solid's headless test renderer.

describeGating({
  remoteBails: false,
  load: async (input) => {
    const harness = makeApi(input)
    await tui(harness.api, undefined, {} as any)
    const run = {
      toasts: harness.toasts,
      registered: harness.slotPlugins.length === 1,
      inert:
        harness.slotPlugins.length === 0 &&
        harness.layers.length === 0 &&
        harness.handlers.size === 0,
    }
    await harness.dispose()
    return run
  },
})

describe("registration", () => {
  // 165, not 160: background-tasks already held 160, and two halves at one
  // order left their relative position to the host's tie-break. The suite-wide
  // uniqueness rule is pinned in tests/repo/test/slot-order.test.ts.
  test("registers a sidebar_content slot at order 165 on a supported host", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    expect(harness.toasts).toHaveLength(0)
    expect(harness.slotPlugins).toHaveLength(1)
    expect(harness.slotPlugins[0]!.order).toBe(165)
    expect(typeof harness.slotPlugins[0]!.slots.sidebar_content).toBe(
      "function",
    )
  })
})

describe("break toasts", () => {
  const NOW = 1_700_000_000_000

  test("toasts exactly once on a live break in the viewed session", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)

    // The event can race the host's part-store sync: the part is not in
    // state yet when the handler runs.
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.variant).toBe("error")
    expect(harness.toasts[0]!.title).toBe("Prompt cache")
    expect(harness.toasts[0]!.message).toContain("1k of 100k")

    // Re-delivery of the same part — including after the store caught up —
    // stays one toast.
    harness.emitPartUpdated(breakingPart(), NOW)
    harness.parts.set("msg_2", [breakingPart()])
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(1)
  })

  test("a healthy request never toasts", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(
      stepFinish("prt_cur", "msg_2", {
        input: 1_500,
        cache: { read: 103_000, write: 800 },
      }),
      NOW,
    )
    expect(harness.toasts).toHaveLength(0)
  })

  test("no toast for a session that is not being viewed", async () => {
    const harness = makeApi({ routeSessionID: "ses_other" })
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(0)
  })

  test("no toast outside the session route", async () => {
    const harness = makeApi({ routeName: "home" })
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(0)
  })

  test("no toast for sub-agent sessions", async () => {
    const harness = makeApi({ parentID: "ses_root" })
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(0)
  })

  test("no toast across a model switch", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)
    const switched = harness.messages.get("ses_1")
    if (switched)
      switched[1] = assistant("msg_2", {
        modelID: "claude-opus-4-8",
        time: { created: NOW },
      })
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(0)
  })

  test("no toast when the previous request finished longer than the TTL ago", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)
    // The previous request's time comes from its message's completion; a gap
    // past the TTL means the cache plausibly just expired.
    harness.emitPartUpdated(breakingPart(), NOW - 60_000 + 301_000)
    expect(harness.toasts).toHaveLength(0)
  })

  test("no toast when the message is missing from state", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(
      stepFinish("prt_cur", "msg_unknown", {
        input: 2_000,
        cache: { write: 104_000 },
      }),
      NOW,
    )
    expect(harness.toasts).toHaveLength(0)
  })

  test("toasts: false keeps the sidebar alert but silences the toast", async () => {
    const harness = makeApi()
    await tui(harness.api, { toasts: false }, {} as any)
    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(0)
    expect(harness.slotPlugins).toHaveLength(1)
  })

  test("threshold options are honored", async () => {
    const harness = makeApi()
    await tui(harness.api, { minPreviousRead: 200_000 }, {} as any)
    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(0)
  })

  test("a persisting break toasts only on the transition into the broken state", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(1)

    // The store catches up, the conversation continues, and the next request
    // again reads almost nothing: still broken, but already alerted.
    harness.parts.set("msg_2", [breakingPart()])
    harness.messages
      .get("ses_1")
      ?.push(assistant("msg_3", { time: { created: NOW + 30_000 } }))
    harness.emitPartUpdated(
      stepFinish("prt_next", "msg_3", {
        input: 110_000,
        cache: { read: 1_000 },
      }),
      NOW + 30_000,
    )
    expect(harness.toasts).toHaveLength(1)
  })

  test("a recovery re-arms the toast for the next break", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(1)

    harness.parts.set("msg_2", [breakingPart()])
    const recovery = stepFinish("prt_rec", "msg_3", {
      input: 4_000,
      cache: { read: 126_000 },
    })
    harness.messages
      .get("ses_1")
      ?.push(assistant("msg_3", { time: { created: NOW + 30_000 } }))
    harness.emitPartUpdated(recovery, NOW + 30_000)
    expect(harness.toasts).toHaveLength(1)

    harness.parts.set("msg_3", [recovery])
    harness.messages
      .get("ses_1")
      ?.push(assistant("msg_4", { time: { created: NOW + 60_000 } }))
    harness.emitPartUpdated(
      stepFinish("prt_again", "msg_4", {
        input: 130_000,
        cache: { read: 1_000 },
      }),
      NOW + 60_000,
    )
    expect(harness.toasts).toHaveLength(2)
  })

  test("a long in-step wait past the TTL is expiry — measured start to start, no toast", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    const T0 = NOW - 460_000
    harness.messages.set("ses_1", [
      assistant("msg_2", { time: { created: T0 } }),
    ])

    // Step N starts at T0, streams, then its tool waits minutes on a
    // permission prompt (the approve-for-me shape) — its step-finish lands
    // only after that wait.
    harness.emitPartUpdated(stepStart("prt_a1", "msg_2"), T0)
    const healthyFinish = stepFinish("prt_a2", "msg_2", {
      input: 2_000,
      cache: { read: 100_000, write: 3_000 },
    })
    harness.emitPartUpdated(healthyFinish, NOW - 10_000)
    harness.parts.set("msg_2", [healthyFinish])

    // Step N+1 goes out seconds later, so the finish-to-finish gap looks
    // tiny — but the entry it tried to read was written at step N's START,
    // well past the TTL. Expiry, not a break: no toast.
    harness.emitPartUpdated(stepStart("prt_b1", "msg_2"), NOW - 10_000)
    harness.emitPartUpdated(
      stepFinish("prt_b2", "msg_2", {
        input: 2_000,
        cache: { read: 1_000, write: 104_000 },
      }),
      NOW,
    )
    expect(harness.toasts).toHaveLength(0)
  })

  test("a slow response does not masquerade as expiry — start-to-start stays under the TTL", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    const T0 = NOW - 400_000
    harness.messages.set("ses_1", [
      assistant("msg_2", { time: { created: T0 } }),
    ])

    harness.emitPartUpdated(stepStart("prt_a1", "msg_2"), T0)
    const healthyFinish = stepFinish("prt_a2", "msg_2", {
      input: 2_000,
      cache: { read: 100_000, write: 3_000 },
    })
    harness.emitPartUpdated(healthyFinish, T0 + 10_000)
    harness.parts.set("msg_2", [healthyFinish])

    // The next request read the cache within seconds of the write — then
    // streamed for longer than the TTL. The finish gap alone would have
    // called this expiry and silently swallowed a real break.
    harness.emitPartUpdated(stepStart("prt_b1", "msg_2"), T0 + 20_000)
    harness.emitPartUpdated(
      stepFinish("prt_b2", "msg_2", {
        input: 2_000,
        cache: { read: 1_000, write: 104_000 },
      }),
      NOW,
    )
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.message).toContain("1k of 100k")
  })

  test("fork-cloned history keeps its original time, so a post-TTL miss is expiry, not a break", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    // A fork copies a message completed long before the cache TTL and
    // re-emits its part event at fork time. The clone must not be stamped
    // with the fork's wall-clock.
    const cloned = assistant("msg_1", {
      time: { created: NOW - 500_000, completed: NOW - 400_000 },
    })
    const clonedPart = stepFinish("prt_prev", "msg_1", {
      input: 2_000,
      cache: { read: 100_000, write: 3_000 },
    })
    harness.messages.set("ses_1", [cloned])
    harness.parts.set("msg_1", [clonedPart])
    harness.emitPartUpdated(clonedPart, NOW)
    expect(harness.toasts).toHaveLength(0)

    // The fork's first real request misses because the provider cache
    // legitimately expired — that is expiry to skip, not a break to toast.
    harness.messages
      .get("ses_1")
      ?.push(assistant("msg_2", { time: { created: NOW } }))
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(0)
  })

  test("re-emitted parts of a completed multi-step message never alert", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    // Forking clones history by re-emitting EVERY copied part at fork time.
    // This message's own two steps happen to form a break — it broke minutes
    // ago, was seen then, and is settled history now. Judging cloned parts
    // would re-toast that long-dead break the instant the user forks.
    const cloned = assistant("msg_1", {
      time: { created: NOW - 500_000, completed: NOW - 400_000 },
    })
    const first = stepFinish("prt_a", "msg_1", {
      input: 2_000,
      cache: { read: 100_000, write: 3_000 },
    })
    const second = stepFinish("prt_b", "msg_1", {
      input: 2_000,
      cache: { read: 1_000, write: 104_000 },
    })
    harness.messages.set("ses_1", [cloned])
    harness.parts.set("msg_1", [first, second])

    // Both arrive at the fork's wall-clock. `prt_a` is a NON-final step, so
    // nothing recovers a time for it — without the completed-message guard
    // the pair would look like it happened just now, the TTL gate would have
    // no age to work with, and `prt_b` would toast.
    harness.emitPartUpdated(first, NOW)
    harness.emitPartUpdated(second, NOW)
    expect(harness.toasts).toHaveLength(0)
  })

  test("a step that carried no prompt at all never enters the record", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)

    // A step aborted before its request went out: zero prompt, zero
    // everything. It is not an API request and must not be remembered as one.
    const aborted = stepFinish("prt_zero", "msg_2", {})
    harness.parts.set("msg_2", [aborted])
    harness.emitPartUpdated(aborted, NOW)
    expect(harness.toasts).toHaveLength(0)

    // If the aborted step were recorded it would become this request's
    // predecessor with a 0 cache read — a floor of 0, under the alert
    // minimum — and a genuine standing break would silently report healthy.
    harness.messages
      .get("ses_1")
      ?.push(assistant("msg_3", { time: { created: NOW + 30_000 } }))
    harness.emitPartUpdated(
      stepFinish("prt_miss", "msg_3", {
        input: 110_000,
        cache: { read: 1_000 },
      }),
      NOW + 30_000,
    )
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.message).toContain("1k of 100k")
  })

  test("a store re-read refreshes a request already in the durable record", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    harness.messages.set("ses_1", [
      assistant("msg_1", {
        time: { created: NOW - 120_000, completed: NOW - 60_000 },
      }),
      assistant("msg_2", { time: { created: NOW } }),
    ])
    // The host synced this step-finish while its usage was still streaming,
    // so the first read of the store sees a fraction of the real numbers.
    harness.parts.set("msg_1", [
      stepFinish("prt_prev", "msg_1", { input: 200, cache: { read: 1_000 } }),
    ])
    // Update this same current request below, rather than adding an unrelated
    // small-prompt request that would legitimately reset the detector's floor.
    harness.emitPartUpdated(
      stepFinish("prt_cur", "msg_2", { input: 1_000, cache: { read: 500 } }),
      NOW,
    )
    expect(harness.toasts).toHaveLength(0)

    // The store now carries the settled usage for that same part. The record
    // has to take the refresh: frozen at the partial snapshot, the floor
    // stays under the alert minimum and the break below goes unreported.
    harness.parts.set("msg_1", [
      stepFinish("prt_prev", "msg_1", {
        input: 2_000,
        cache: { read: 100_000, write: 3_000 },
      }),
    ])
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.message).toContain("1k of 100k")
  })

  test("the late history seed never clobbers the store's fresher reading", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)
    // The seed fetch is issued from inside a store read and resolves after
    // it, so for any part in both sources the HTTP snapshot lands LAST — and
    // it was taken while this step's usage was still streaming. Keeping what
    // the store already recorded is what stops that stale snapshot winning.
    harness.history.set("ses_1", [
      {
        info: assistant("msg_1", {
          time: { created: NOW - 120_000, completed: NOW - 60_000 },
        }),
        parts: [
          stepFinish("prt_prev", "msg_1", {
            input: 2_000,
            cache: { read: 1_000, write: 3_000 },
          }),
        ],
      },
    ])

    // An early update of the current request records prt_prev at its full
    // 100k from the store and kicks off the one-shot seed; settle() lets the
    // seed land on top. The same current part is updated again below.
    harness.emitPartUpdated(
      stepFinish("prt_cur", "msg_2", { input: 1_000, cache: { read: 2_000 } }),
      NOW,
    )
    await settle()
    expect(harness.toasts).toHaveLength(0)

    // msg_1 has since aged out of the host's synced window, so nothing can
    // re-read it from the store: only the plugin's own record still carries
    // that 100k floor, and only if the seed left it alone.
    harness.messages.set("ses_1", [
      assistant("msg_2", { time: { created: NOW } }),
    ])
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.message).toContain("1k of 100k")
  })

  test("session.deleted drops the session's tracking", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(breakingPart(), NOW)
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(1)

    // After deletion nothing is retained, so a session reusing the id is
    // judged from scratch — the observable side of the cleanup.
    harness.emitSessionDeleted("ses_1")
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(2)
  })

  // The recency cap (audit L-UM1). Eviction has no direct observation surface,
  // so these read it through the `toasted` one-shot set the way the
  // session.deleted test above does: a session whose tracking is gone judges
  // its next request from scratch and toasts again.
  test("an idle background session is evicted once the cap is passed", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(breakingPart(), NOW)
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(1)

    // Route away so ses_1 loses its exemption, then push it past the cap.
    harness.setRouteSession("ses_other")
    floodSessions(harness, MAX_TRACKED_SESSIONS + 1)

    harness.setRouteSession("ses_1")
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(2)
  })

  test("the viewed session is never evicted", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(1)

    // Twice the cap in background traffic must not dislodge the session the
    // user is looking at — it keeps its `toasted` set, so no second toast.
    floodSessions(harness, MAX_TRACKED_SESSIONS * 2)
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(1)
  })

  test("tracking is evicted by recency of activity, not by first sight", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedHealthySessionFor(harness, "ses_a", NOW)
    seedHealthySessionFor(harness, "ses_b", NOW)

    // Both sessions record a break, so both carry a `toasted` entry.
    harness.setRouteSession("ses_a")
    harness.emitPartUpdated(breakingPartFor("ses_a"), NOW)
    harness.setRouteSession("ses_b")
    harness.emitPartUpdated(breakingPartFor("ses_b"), NOW)
    expect(harness.toasts).toHaveLength(2)

    // Touch ses_a again so it is newer than ses_b despite being seen first.
    harness.setRouteSession("ses_a")
    harness.emitPartUpdated(breakingPartFor("ses_a"), NOW)
    expect(harness.toasts).toHaveLength(2)

    // Route away and flood just enough that exactly one entry must go.
    harness.setRouteSession("ses_none")
    floodSessions(harness, MAX_TRACKED_SESSIONS - 1)

    // ses_a survived the flood: its `toasted` set is intact, so it stays
    // silent. Checked BEFORE ses_b below, because re-creating ses_b puts the
    // map back over the cap and would then evict ses_a in its turn.
    harness.setRouteSession("ses_a")
    harness.emitPartUpdated(breakingPartFor("ses_a"), NOW)
    expect(harness.toasts).toHaveLength(2)

    // ses_b was the oldest, so it was the one dropped, and re-judges from
    // scratch.
    harness.setRouteSession("ses_b")
    harness.emitPartUpdated(breakingPartFor("ses_b"), NOW)
    expect(harness.toasts).toHaveLength(3)
  })

  test("eviction cancels the pending expiry fade timer", async () => {
    // Same timer-identity surface as the session.deleted test: an evicted
    // entry's fade timer must be cleared, or its closure keeps the whole
    // Tracking alive until a possibly long linger elapses.
    const setSpy = spyOn(globalThis, "setTimeout")
    const clearSpy = spyOn(globalThis, "clearTimeout")
    try {
      const harness = makeApi()
      await tui(harness.api, { expiryLingerSeconds: 600 }, {} as any)
      emitExpiredSequence(harness, NOW)
      const timerCall = setSpy.mock.calls.findIndex(
        (call) => call[1] === 600_000,
      )
      expect(timerCall).toBeGreaterThanOrEqual(0)
      const timer = setSpy.mock.results[timerCall]?.value

      harness.setRouteSession("ses_other")
      floodSessions(harness, MAX_TRACKED_SESSIONS + 1)
      expect(clearSpy.mock.calls.some((call) => call[0] === timer)).toBe(true)
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })

  test("session.deleted cancels the pending expiry fade timer", async () => {
    // Timer identity is the only honest observation surface: the fade timer
    // must be the one handed to clearTimeout, else the deleted session's
    // tracking stays referenced until a (possibly long) linger elapses.
    const setSpy = spyOn(globalThis, "setTimeout")
    const clearSpy = spyOn(globalThis, "clearTimeout")
    try {
      const harness = makeApi()
      await tui(harness.api, { expiryLingerSeconds: 600 }, {} as any)
      emitExpiredSequence(harness, NOW)
      expect(harness.toasts).toHaveLength(0)
      const timerCall = setSpy.mock.calls.findIndex(
        (call) => call[1] === 600_000,
      )
      expect(timerCall).toBeGreaterThanOrEqual(0)
      const timer = setSpy.mock.results[timerCall]?.value

      harness.emitSessionDeleted("ses_1")
      expect(clearSpy.mock.calls.some((call) => call[0] === timer)).toBe(true)
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })

  test("dispose cancels pending expiry fade timers", async () => {
    const setSpy = spyOn(globalThis, "setTimeout")
    const clearSpy = spyOn(globalThis, "clearTimeout")
    try {
      const harness = makeApi()
      await tui(harness.api, { expiryLingerSeconds: 600 }, {} as any)
      emitExpiredSequence(harness, NOW)
      const timerCall = setSpy.mock.calls.findIndex(
        (call) => call[1] === 600_000,
      )
      expect(timerCall).toBeGreaterThanOrEqual(0)
      const timer = setSpy.mock.results[timerCall]?.value

      // The shared core's dispose is async (the real lifecycle can be); the
      // old local harness ran disposers synchronously.
      await harness.dispose()
      expect(clearSpy.mock.calls.some((call) => call[0] === timer)).toBe(true)
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })

  test("the break judgment sees history beyond the synced message window", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    // The healthy previous request has aged out of the host's synced store;
    // only the server's full history still records it.
    const old = assistant("msg_1", {
      time: { created: NOW - 120_000, completed: NOW - 60_000 },
    })
    const oldPart = stepFinish("prt_prev", "msg_1", {
      input: 2_000,
      cache: { read: 100_000, write: 3_000 },
    })
    harness.history.set("ses_1", [{ info: old, parts: [oldPart] }])
    harness.messages.set("ses_1", [
      assistant("msg_2", { time: { created: NOW } }),
    ])

    // The first live event triggers the one-shot seed; judged before it
    // lands, this break has no floor to be measured against yet.
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(0)
    await settle()
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.message).toContain("1k of 100k")
  })

  // The "One-shot full-history seed" contract: seedHistory latches
  // history="pending" BEFORE its await, and samplesFor only re-seeds while the
  // state is "idle". samplesFor runs on every reactive read and from the bus
  // handler, so without that latch one seed becomes a fetch storm against
  // session.messages — invisible to line coverage.
  test("the full-history seed fires at most once per session across many reads", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)

    // Healthy reads never toast, so each bus event reaches samplesFor (the
    // `toasted` short-circuit never trips) — the exact re-read path the latch
    // guards.
    const healthy = () =>
      stepFinish("prt_cur", "msg_2", {
        input: 1_500,
        cache: { read: 103_000, write: 800 },
      })
    harness.emitPartUpdated(healthy(), NOW)
    harness.emitPartUpdated(healthy(), NOW)
    harness.emitPartUpdated(healthy(), NOW)
    // These reads all happen BEFORE the async seed settles — exactly where a
    // moved/dropped "pending" latch re-fetches on every read.
    expect(harness.messagesCalls()).toBe(1)

    await settle()
    harness.emitPartUpdated(healthy(), NOW)
    expect(harness.messagesCalls()).toBe(1)
  })

  test("a rejected history seed degrades to the synced store without re-fetching", async () => {
    const harness = makeApi({ messagesReject: true })
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)

    // The seed fetch (kicked off from this first read) rejects; the `.catch`
    // absorbs it, so the plugin still judges the break from the synced store
    // and never surfaces an unhandled rejection.
    harness.emitPartUpdated(breakingPart(), NOW)
    await settle()
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.message).toContain("1k of 100k")

    // After the failure history is "failed", never "idle", so a later read
    // does not retry — the one-shot latch holds even on the failure path.
    harness.emitPartUpdated(
      stepFinish("prt_healthy", "msg_2", {
        input: 1_500,
        cache: { read: 103_000, write: 800 },
      }),
      NOW,
    )
    await settle()
    expect(harness.messagesCalls()).toBe(1)
  })
})

// An out-of-range option is rejected with one warning toast and the documented
// default is used, rather than silently taking effect (audit L-UM3). The
// endpoint that motivated this was `floorFraction: 0`, which reads as "most
// sensitive" but made every request pass the floor test.
describe("option validation", () => {
  const NOW = 1_700_000_000_000

  test("floorFraction: 0 warns and leaves detection live on the default", async () => {
    const harness = makeApi()
    await tui(harness.api, { floorFraction: 0 }, {} as any)
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.variant).toBe("warning")
    expect(harness.toasts[0]!.message).toContain("floorFraction")

    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(2)
    expect(harness.toasts[1]!.variant).toBe("error")
  })

  test("ttlSeconds: 0 warns and a real break is not reclassified as expiry", async () => {
    const harness = makeApi()
    await tui(harness.api, { ttlSeconds: 0 }, {} as any)
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.message).toContain("ttlSeconds")

    // The 60s gap seedHealthySession leaves is inside the restored 300s
    // default, so this stays a break rather than becoming an expiry.
    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(breakingPart(), NOW)
    expect(harness.toasts).toHaveLength(2)
    expect(harness.toasts[1]!.variant).toBe("error")
  })

  test.each([
    ["above the range", 5],
    ["negative", -1],
    ["not a number", "0.5"],
  ] as const)(
    "a floorFraction that is %s warns and falls back to the default",
    async (_name, floorFraction) => {
      const harness = makeApi()
      await tui(harness.api, { floorFraction }, {} as any)
      expect(harness.toasts).toHaveLength(1)
      expect(harness.toasts[0]!.variant).toBe("warning")
      expect(harness.toasts[0]!.message).toContain("floorFraction")

      seedHealthySession(harness, NOW)
      harness.emitPartUpdated(breakingPart(), NOW)
      expect(harness.toasts).toHaveLength(2)
    },
  )

  test("floorFraction: 1 is accepted, and is sharper than the default", async () => {
    const harness = makeApi()
    await tui(harness.api, { floorFraction: 1 }, {} as any)
    expect(harness.toasts).toHaveLength(0)

    // A dip the default would pass: 96k read against a 100k floor. The prompt
    // still totals above the floor, so the prompt-shrank skip does not apply.
    seedHealthySession(harness, NOW)
    harness.emitPartUpdated(
      stepFinish("prt_cur", "msg_2", { input: 8_000, cache: { read: 96_000 } }),
      NOW,
    )
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.variant).toBe("error")
  })

  test("minPreviousRead: 0 is accepted — it means no size gate", async () => {
    const harness = makeApi()
    await tui(harness.api, { minPreviousRead: 0 }, {} as any)
    expect(harness.toasts).toHaveLength(0)
  })

  // minPreviousRead is the one numeric option whose lower-bound rejection was
  // unpinned: only the accepted 0 was tested, so relaxing the validator to
  // `() => true` passed. A negative token count is refused like any other
  // out-of-range value, and the documented 5_000 default stands in (the
  // non-number branch already dies via the shared floorFraction: "0.5" row).
  test("a negative minPreviousRead warns and falls back to the default", async () => {
    const harness = makeApi()
    await tui(harness.api, { minPreviousRead: -1 }, {} as any)
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.variant).toBe("warning")
    expect(harness.toasts[0]!.message).toContain("minPreviousRead")
    expect(
      resolveOptions({ minPreviousRead: -1 }).options.minPreviousRead,
    ).toBe(5_000)
  })

  test("expiryLingerSeconds: 0 warns and the fade reverts to the default linger", async () => {
    const setSpy = spyOn(globalThis, "setTimeout")
    try {
      const harness = makeApi()
      await tui(harness.api, { expiryLingerSeconds: 0 }, {} as any)
      expect(harness.toasts).toHaveLength(1)
      expect(harness.toasts[0]!.message).toContain("expiryLingerSeconds")

      emitExpiredSequence(harness, NOW)
      expect(setSpy.mock.calls.some((call) => call[1] === 5_000)).toBe(true)
    } finally {
      setSpy.mockRestore()
    }
  })

  // `toasts` is the one non-numeric option, and read as `!== false` it silently
  // resolved every near-miss to the default TRUE — so the attempt to silence
  // alerts failed with no warning and no clue why.
  test.each([
    ["a JSON string", "false"],
    ["a number", 0],
    ["null", null],
  ] as const)(
    "a toasts value that is %s warns and falls back to the default",
    async (_name, toasts) => {
      const harness = makeApi()
      await tui(harness.api, { toasts }, {} as any)
      expect(harness.toasts).toHaveLength(1)
      expect(harness.toasts[0]!.variant).toBe("warning")
      expect(harness.toasts[0]!.message).toContain("toasts")

      // Defaulted to true, so a break still toasts.
      seedHealthySession(harness, NOW)
      harness.emitPartUpdated(breakingPart(), NOW)
      expect(harness.toasts).toHaveLength(2)
      expect(harness.toasts[1]!.variant).toBe("error")
    },
  )

  test("toasts: true is accepted without warning", async () => {
    const harness = makeApi()
    await tui(harness.api, { toasts: true }, {} as any)
    expect(harness.toasts).toHaveLength(0)
  })

  test("several bad options produce exactly one toast naming all of them", async () => {
    const harness = makeApi()
    await tui(harness.api, { floorFraction: 0, ttlSeconds: -5 }, {} as any)
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.message).toContain("floorFraction")
    expect(harness.toasts[0]!.message).toContain("ttlSeconds")
  })

  test("valid options never warn", async () => {
    const harness = makeApi()
    await tui(
      harness.api,
      {
        minPreviousRead: 200_000,
        floorFraction: 0.25,
        ttlSeconds: 3_600,
        expiryLingerSeconds: 0.2,
        toasts: false,
      },
      {} as any,
    )
    expect(harness.toasts).toHaveLength(0)
  })

  test("resolveOptions maps seconds to milliseconds and reports no problems by default", () => {
    expect(resolveOptions(undefined)).toEqual({
      options: {
        minPreviousRead: 5_000,
        floorFraction: 0.5,
        ttlMs: 300_000,
        toasts: true,
        lingerMs: 5_000,
      },
      problems: [],
    })
    expect(resolveOptions({ ttlSeconds: 3_600 }).options.ttlMs).toBe(3_600_000)
    // Fractional lingers must stay legal — the view tests rely on 0.2.
    expect(resolveOptions({ expiryLingerSeconds: 0.2 }).options.lingerMs).toBe(
      200,
    )
  })
})

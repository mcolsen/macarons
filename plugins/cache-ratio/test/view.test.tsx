import { describe, expect, test } from "bun:test"
import { createSlotMounter } from "@macarons/plugin-test-harness/view"
import { createSignal, Show } from "solid-js"
import { tui } from "../src/tui"
import {
  assistant,
  breakingPart,
  emitExpiredSequence,
  makeApi,
  seedHealthySession,
  settle,
  stepFinish,
  stepStart,
} from "./harness"

// Rendering-level tests: the registered sidebar slot mounted under
// @opentui/solid's headless test renderer and driven through the same mock
// api + bus events as the engine tests. The package bunfig preloads
// @opentui/solid's solid transform, so src/tui.tsx compiles here the way the
// host compiles it and the fine-grained reactivity under test is genuine —
// captured char frames are the assertion surface.

const NOW = 1_700_000_000_000

const mountSlot = createSlotMounter({ width: 80, height: 12 })

/** Mount the plugin's registered sidebar slot for one session. */
async function renderSidebar(
  harness: ReturnType<typeof makeApi>,
  sessionID = "ses_1",
) {
  return mountSlot(harness, { sessionID })
}

describe("sidebar view", () => {
  test("renders the hit ratio and session-wide sums", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    harness.messages.set("ses_1", [
      assistant("msg_1", {
        time: { created: NOW - 60_000, completed: NOW - 30_000 },
      }),
    ])
    harness.parts.set("msg_1", [
      stepFinish("prt_1", "msg_1", {
        input: 1_000,
        cache: { read: 8_000, write: 1_000 },
      }),
    ])

    const view = await renderSidebar(harness)
    const frame = await view.waitForFrame((f) => f.includes("Cache"))
    expect(frame).toContain("hit 80% · last 80%")
    expect(frame).toContain("8k cached · 1k written · 1k fresh")
    expect(frame).not.toContain("prefix broke")
    expect(frame).not.toContain("cache expired")
  })

  test.each(["before", "after"] as const)(
    "retains all 151 requests across background eviction when events arrive %s part sync",
    async (eventOrder) => {
      const harness = makeApi()
      await tui(harness.api, undefined, {} as any)
      try {
        const messages = [
          assistant("msg_000", {
            time: { created: NOW - 2_000, completed: NOW - 1_000 },
          }),
        ]
        const tokens = { input: 1, cache: { read: 1_000, write: 100 } }
        const initial = stepFinish("prt_000", "msg_000", tokens)
        harness.messages.set("ses_1", messages)
        harness.parts.set("msg_000", [initial])
        harness.history.set("ses_1", [{ info: messages[0]!, parts: [initial] }])

        // Match the host's keyed session view: navigation unmounts the slot,
        // not the plugin. No view memo can harvest the background samples.
        const [sessionID, setSessionID] = createSignal<string | undefined>(
          "ses_1",
        )
        const slot = harness.slotPlugins[0]!.slots.sidebar_content
        const view = await mountSlot(() => (
          <Show when={sessionID()} keyed>
            {(id: string) => slot({}, { session_id: id })}
          </Show>
        ))
        await settle()
        expect(view.captureCharFrame()).toContain(
          "1k cached · 100 written · 1 fresh",
        )
        expect(harness.messagesCalls()).toBe(1)

        harness.setRouteSession("ses_other")
        setSessionID(undefined)
        await view.renderOnce()
        expect(view.captureCharFrame()).not.toContain("Cache")

        for (let index = 1; index <= 150; index++) {
          const suffix = String(index).padStart(3, "0")
          const time = NOW + index * 1_000
          const message = assistant(`msg_${suffix}`, {
            time: { created: time },
          })
          const part = stepFinish(`prt_${suffix}`, message.id, tokens)
          messages.push(message)
          if (messages.length > 100) {
            const evicted = messages.shift()!
            harness.parts.delete(evicted.id)
          }
          if (eventOrder === "after") harness.parts.set(message.id, [part])
          harness.emitPartUpdated(part, time)
          harness.emitPartUpdated(part, time + 1)
          if (eventOrder === "before") harness.parts.set(message.id, [part])
          message.time.completed = time + 2
          harness.history.get("ses_1")!.push({ info: message, parts: [part] })
        }
        expect(messages).toHaveLength(100)
        expect(messages[0]!.id).toBe("msg_051")
        expect(harness.parts.size).toBe(100)
        expect(harness.messagesCalls()).toBe(1)
        expect(harness.toasts).toHaveLength(0)

        harness.setRouteSession("ses_1")
        setSessionID("ses_1")
        await view.renderOnce()
        const frame = view.captureCharFrame()
        // One fresh token per request pins the exact sample count as well as
        // the ticket's 151k cached total; duplicate events must not inflate it.
        expect(frame).toContain("151k cached · 15.1k written · 151 fresh")
        expect(frame).toContain("hit 91% · last 91%")
        expect(harness.messagesCalls()).toBe(1)
        expect(harness.toasts).toHaveLength(0)
      } finally {
        await harness.dispose()
      }
    },
  )

  test("retains a background expiry without showing a notice on return", async () => {
    const harness = makeApi({ routeSessionID: "ses_other" })
    await tui(harness.api, { expiryLingerSeconds: 600 }, {} as any)
    try {
      emitExpiredSequence(harness, NOW)
      expect(harness.messagesCalls()).toBe(0)
      expect(harness.toasts).toHaveLength(0)

      harness.setRouteSession("ses_1")
      const view = await renderSidebar(harness)
      const frame = view.captureCharFrame()
      expect(frame).toContain("101k cached · 107k written · 4k fresh")
      expect(frame).not.toContain("cache expired")
      expect(frame).not.toContain("prefix broke")
      expect(harness.toasts).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  test("stays hidden for sessions with no recorded requests", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    const view = await renderSidebar(harness)
    expect(view.captureCharFrame()).not.toContain("Cache")
  })

  test("a live break turns into the red detail row as the store updates", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedHealthySession(harness, NOW)
    const view = await renderSidebar(harness)
    expect(view.captureCharFrame()).not.toContain("prefix broke")

    // Store catches up, then the live event lands — the version bump must
    // reach the mounted view without a re-mount.
    harness.parts.set("msg_2", [breakingPart()])
    harness.emitPartUpdated(breakingPart(), NOW)
    const frame = await view.waitForFrame((f) => f.includes("prefix broke"))
    expect(frame).toContain("prefix broke: lost 99k cached")
  })

  test("an expiry shows the muted transient notice — and fades after the linger", async () => {
    const harness = makeApi()
    await tui(harness.api, { expiryLingerSeconds: 0.2 }, {} as any)
    const T0 = NOW - 460_000
    harness.messages.set("ses_1", [
      assistant("msg_2", { time: { created: T0 } }),
    ])
    const view = await renderSidebar(harness)

    // Step N: started long ago, finished moments ago (a permission prompt
    // held its tools for minutes) — the approve-for-me shape.
    harness.emitPartUpdated(stepStart("prt_a1", "msg_2"), T0)
    const healthyFinish = stepFinish("prt_a2", "msg_2", {
      input: 2_000,
      cache: { read: 100_000, write: 3_000 },
    })
    harness.parts.set("msg_2", [healthyFinish])
    harness.emitPartUpdated(healthyFinish, NOW - 10_000)

    // Step N+1 re-pays the whole context; start-to-start age is past the TTL.
    harness.emitPartUpdated(stepStart("prt_b1", "msg_2"), NOW - 10_000)
    const expiredFinish = stepFinish("prt_b2", "msg_2", {
      input: 2_000,
      cache: { read: 1_000, write: 104_000 },
    })
    harness.parts.set("msg_2", [healthyFinish, expiredFinish])
    harness.emitPartUpdated(expiredFinish, NOW)

    const frame = await view.waitForFrame((f) => f.includes("cache expired"))
    expect(frame).toContain("cache expired: re-paid 99k cached")
    // Cost visibility, not an alarm: no red break row, no toast.
    expect(frame).not.toContain("prefix broke")
    expect(harness.toasts).toHaveLength(0)

    // The notice fades on its own once the linger elapses.
    await Bun.sleep(300)
    await view.renderOnce()
    const after = view.captureCharFrame()
    expect(after).not.toContain("cache expired")
    // The section itself stays, with the sums now including the re-pay.
    expect(after).toContain("Cache")
  })

  test("a second expiry inside the linger is not blanked by the first notice's timer", async () => {
    // Each fade timer clears the notice only if it is still the one showing:
    // `shown === notice ? undefined : shown`. Two expiries closer together than
    // the linger prove the identity check — the first timer must leave the
    // second, newer notice alone. Replacing it with `entry.expiry[1](undefined)`
    // would blank the live cost line the instant the older timer fires.
    const harness = makeApi()
    await tui(harness.api, { expiryLingerSeconds: 0.3 }, {} as any)
    harness.messages.set("ses_1", [
      assistant("msg_2", { time: { created: NOW - 460_000 } }),
      assistant("msg_3", { time: { created: NOW - 400_000 } }),
    ])
    const view = await renderSidebar(harness)

    // First expiry: read 100k re-paid down to 1k, start-to-start past the TTL.
    const firstHealthy = stepFinish("prt_a2", "msg_2", {
      input: 2_000,
      cache: { read: 100_000, write: 3_000 },
    })
    harness.parts.set("msg_2", [firstHealthy])
    harness.emitPartUpdated(firstHealthy, NOW - 460_000)
    const firstMiss = stepFinish("prt_b2", "msg_2", {
      input: 2_000,
      cache: { read: 1_000, write: 104_000 },
    })
    harness.parts.set("msg_2", [firstHealthy, firstMiss])
    harness.emitPartUpdated(firstMiss, NOW - 10_000)
    await view.waitForFrame((f) => f.includes("re-paid 99k"))

    // Wait a fraction of the linger, then raise a SECOND expiry with a
    // distinguishable figure while the first notice's timer is still pending.
    await Bun.sleep(200)
    const secondHealthy = stepFinish("prt_c2", "msg_3", {
      input: 2_000,
      cache: { read: 51_000, write: 3_000 },
    })
    harness.parts.set("msg_3", [secondHealthy])
    harness.emitPartUpdated(secondHealthy, NOW - 400_000)
    const secondMiss = stepFinish("prt_d2", "msg_3", {
      input: 2_000,
      cache: { read: 1_000, write: 104_000 },
    })
    harness.parts.set("msg_3", [secondHealthy, secondMiss])
    harness.emitPartUpdated(secondMiss, NOW)
    const shown = await view.waitForFrame((f) => f.includes("re-paid 50k"))
    // The second notice replaced the first (a distinct 50k figure).
    expect(shown).toContain("cache expired: re-paid 50k cached")

    // Past the FIRST timer's deadline but before the second's: the second
    // notice must survive — only its own timer may clear it.
    await Bun.sleep(200)
    await view.renderOnce()
    const midway = view.captureCharFrame()
    expect(midway).toContain("cache expired: re-paid 50k cached")

    // The second notice fades on its own once its linger elapses.
    await Bun.sleep(300)
    await view.renderOnce()
    expect(view.captureCharFrame()).not.toContain("cache expired")
  })
})

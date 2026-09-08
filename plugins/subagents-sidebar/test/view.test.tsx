import { describe, expect, test } from "bun:test"
import { flush } from "@macarons/plugin-test-harness"
import { createSlotMounter } from "@macarons/plugin-test-harness/view"
import { tui } from "../src/tui"
import { makeApi, seedTask, taskPart } from "./harness"

// Rendering-level tests: the registered sidebar slot mounted under
// @opentui/solid's headless test renderer and driven through the same mock
// api + bus events as the engine tests. The package bunfig preloads
// @opentui/solid's solid transform, so src/tui.tsx compiles here the way the
// host compiles it and the fine-grained reactivity under test is genuine —
// captured char frames are the assertion surface.

const mountSlot = createSlotMounter({ width: 60, height: 12 })

/** Mount the plugin's registered sidebar slot for one session. */
async function renderSidebar(
  harness: ReturnType<typeof makeApi>,
  sessionID = "ses_1",
) {
  return mountSlot(harness, { sessionID })
}

describe("sidebar view", () => {
  test("renders a running subagent with agent, description, and elapsed time", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedTask(
      harness,
      taskPart({ state: { time: { start: Date.now() - 90_000 } } }),
    )

    const view = await renderSidebar(harness)
    const frame = await view.waitForFrame((f) => f.includes("Subagents"))
    expect(frame).toContain("▶ explore: find the sync")
    // Assert the elapsed SHAPE, not the exact seconds: the row renders with
    // the `now` captured at plugin init, the task started 90 s before the
    // SEED, and formatDuration floors — so "1m30s" appears only when init and
    // seed share a millisecond (or a ticker tick lands first). Any gap floors
    // to 1m29s, which is why this assertion read "1m3" green locally for
    // days and then went red on a loaded CI runner (run 30687876196). The
    // exact digits are formatDuration's own unit-tested concern
    // (core.test.ts pins statusWord against a fixed clock).
    expect(frame).toMatch(/1m\d\ds/)
  })

  test("stays hidden for sessions with no subagents", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    const view = await renderSidebar(harness)
    expect(view.captureCharFrame()).not.toContain("Subagents")
  })

  test("stays hidden inside a subagent session itself", async () => {
    const harness = makeApi({ routeSessionID: "ses_child_1" })
    await tui(harness.api, undefined, {} as any)
    // The child spawned its own nested task, but the child's view shows no
    // section — a sub-agent session has no sidebar standing of its own.
    harness.sessionRecords.set("ses_child_1", {
      id: "ses_child_1",
      parentID: "ses_1",
      time: { created: 0, updated: 0 },
    })
    seedTask(
      harness,
      taskPart(
        {
          state: { metadata: { sessionId: "ses_grandchild" } },
        },
        "ses_child_1",
      ),
      "ses_child_1",
    )
    const view = await renderSidebar(harness, "ses_child_1")
    expect(view.captureCharFrame()).not.toContain("Subagents")
  })

  test("a child stopped on a permission renders as waiting on you", async () => {
    const harness = makeApi()
    harness.pendingPermissions.push({
      id: "perm_1",
      sessionID: "ses_child_1",
    })
    await tui(harness.api, undefined, {} as any)
    seedTask(harness, taskPart())

    const view = await renderSidebar(harness)
    const frame = await view.waitForFrame((f) => f.includes("waiting on you"))
    expect(frame).toContain("! explore")
    expect(frame).toContain("waiting on you")
  })

  test.each([
    ["permission", "permission.replied"],
    ["question", "question.replied"],
    ["question", "question.rejected"],
  ] as const)(
    "reconnect clears a stale %s wait and %s clears a newer live ask without a remount",
    async (kind, replyEvent) => {
      const harness = makeApi()
      const pending =
        kind === "permission"
          ? harness.pendingPermissions
          : harness.pendingQuestions
      const host =
        kind === "permission" ? harness.permissions : harness.questions
      const stale = { id: `${kind}_stale`, sessionID: "ses_child_1" }
      pending.push(stale)
      host.set(stale.sessionID, [stale])
      await tui(harness.api, undefined, {} as any)
      seedTask(harness, taskPart())

      const view = await renderSidebar(harness)
      const waiting = await view.waitForFrame((f) =>
        f.includes("waiting on you"),
      )
      expect(waiting).toContain("! explore: find the sync")

      // The reply was missed during the event gap. Leave the host queue stale.
      pending.length = 0
      harness.emit("server.connected", {})
      const running = await view.waitForFrame((f) => f.includes("▶ explore"))
      expect(running).toContain("Subagents")
      expect(running).toContain("▶ explore: find the sync")
      expect(running).not.toContain("waiting on you")

      // Only a genuinely newer bus event, not a host-store mutation, adds a wait.
      const live = { id: `${kind}_live`, sessionID: stale.sessionID }
      harness.emit(`${kind}.asked`, live)
      const asking = await view.waitForFrame((f) =>
        f.includes("waiting on you"),
      )
      expect(asking).toContain("! explore: find the sync")

      harness.emit(replyEvent, {
        sessionID: live.sessionID,
        requestID: live.id,
      })
      const cleared = await view.waitForFrame((f) => f.includes("▶ explore"))
      expect(cleared).toContain("Subagents")
      expect(cleared).toContain("▶ explore: find the sync")
      expect(cleared).not.toContain("waiting on you")
      expect(host.get(stale.sessionID)).toEqual([stale])
    },
  )

  test("a live completion flips the row to its verdict without a remount", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedTask(harness, taskPart({ id: "prt_live", callID: "call_live" }))
    const view = await renderSidebar(harness)
    await view.waitForFrame((f) => f.includes("▶ explore"))

    // The store catches up and the bus delivers the completed part — the
    // version bump must reach the mounted view.
    const done = taskPart({
      id: "prt_live",
      callID: "call_live",
      state: {
        status: "completed",
        time: { start: Date.now() - 90_000, end: Date.now() },
      },
    })
    seedTask(harness, done)
    harness.emitPartUpdated(done)
    const frame = await view.waitForFrame((f) => f.includes("✓"))
    expect(frame).toContain("✓ explore: find the sync")
    expect(frame).toContain("done")
  })

  test("a subagent-comms spawn shows as a live row while its child is busy", async () => {
    // The first live test's exact shape: subagent_spawn completes at launch
    // (background by design), child session busy. The sidebar must show a
    // running row — this scenario rendered an empty sidebar when the reader
    // accepted only `task` parts.
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedTask(
      harness,
      taskPart({
        tool: "subagent_spawn",
        state: {
          status: "completed",
          input: {
            description: "pick random number",
            subagent_type: "general",
          },
          metadata: {
            sessionId: "ses_child_1",
            background: true,
            truncated: false,
          },
          time: { start: Date.now() - 12_000, end: Date.now() - 11_000 },
        },
      }),
    )
    harness.statuses.set("ses_child_1", { type: "busy" })

    const view = await renderSidebar(harness)
    const frame = await view.waitForFrame((f) => f.includes("Subagents"))
    expect(frame).toContain("▶ general: pick random nu")
    expect(frame).not.toContain("done")
  })

  test.each(["busy", "retry"])(
    "the first %s event revives a mounted done row after successful status hydration",
    async (status) => {
      const harness = makeApi()
      harness.clientStatus.data = {}
      await tui(harness.api, undefined, {} as any)
      await flush()
      seedTask(
        harness,
        taskPart({
          tool: "subagent_spawn",
          state: {
            status: "completed",
            time: { start: Date.now() - 30_000, end: Date.now() },
          },
        }),
      )

      const view = await renderSidebar(harness)
      // Settle history hydration too, so it cannot mask a missing status bump.
      await flush()
      const initial = await view.waitForFrame((f) => f.includes("done"))
      expect(initial).toContain("✓ explore")

      // No prior idle/error event created a terminal ChildRun. The host store
      // stays unchanged; only this event can update the hydrated status map.
      harness.emit("session.status", {
        sessionID: "ses_child_1",
        status: { type: status },
      })
      const frame = await view.waitForFrame((f) => f.includes("▶ explore"))
      expect(frame).not.toContain("done")
      expect(frame.includes("retrying")).toBe(status === "retry")
    },
  )

  test("busy and retry transitions update a mounted row after successful status hydration", async () => {
    const harness = makeApi()
    harness.clientStatus.data = { ses_child_1: { type: "busy" } }
    await tui(harness.api, undefined, {} as any)
    await flush()
    seedTask(
      harness,
      taskPart({
        tool: "subagent_spawn",
        state: {
          status: "completed",
          time: { start: Date.now() - 30_000, end: Date.now() },
        },
      }),
    )

    const view = await renderSidebar(harness)
    await flush()
    const initial = await view.waitForFrame((f) => f.includes("▶ explore"))
    expect(initial).not.toContain("retrying")

    harness.emit("session.status", {
      sessionID: "ses_child_1",
      status: { type: "retry" },
    })
    const retrying = await view.waitForFrame((f) => f.includes("retrying"))
    expect(retrying).toContain("▶ explore")
    expect(retrying).not.toContain("done")

    harness.emit("session.status", {
      sessionID: "ses_child_1",
      status: { type: "busy" },
    })
    const running = await view.waitForFrame(
      (f) => f.includes("▶ explore") && !f.includes("retrying"),
    )
    expect(running).not.toContain("done")
  })

  test("a background launch stays listed while the child works", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    // The tool part completed at LAUNCH; the child is still busy.
    seedTask(
      harness,
      taskPart({
        state: {
          status: "completed",
          metadata: { sessionId: "ses_child_1", background: true },
          time: { start: Date.now() - 30_000, end: Date.now() - 29_000 },
        },
      }),
    )
    harness.statuses.set("ses_child_1", { type: "busy" })

    const view = await renderSidebar(harness)
    const frame = await view.waitForFrame((f) => f.includes("Subagents"))
    expect(frame).toContain("▶ explore")
    expect(frame).not.toContain("✓")
  })

  test("a background finish lingers from the observed settle, not the run start", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    // A background run that has already outlived the 60 s linger: the child
    // record's `time.updated` was stamped at prompt START and is 2 minutes
    // old — judging recency by it would drop the row the instant it settles.
    seedTask(
      harness,
      taskPart({
        state: {
          status: "completed",
          metadata: { sessionId: "ses_child_1", background: true },
          time: { start: Date.now() - 120_000, end: Date.now() - 119_000 },
        },
      }),
    )
    harness.sessionRecords.set("ses_child_1", {
      id: "ses_child_1",
      parentID: "ses_1",
      time: { created: Date.now() - 120_000, updated: Date.now() - 120_000 },
    })
    harness.statuses.set("ses_child_1", { type: "busy" })
    const view = await renderSidebar(harness)
    await view.waitForFrame((f) => f.includes("▶ explore"))

    // The child settles NOW: the observed busy→idle transition is the finish.
    harness.statuses.set("ses_child_1", { type: "idle" })
    harness.emit("session.status", {
      sessionID: "ses_child_1",
      status: { type: "idle" },
    })
    const frame = await view.waitForFrame((f) => f.includes("✓"))
    expect(frame).toContain("✓ explore")
    expect(frame).toContain("done")
  })

  test("a background child that failed renders the ✗ verdict, not a checkmark", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedTask(
      harness,
      taskPart({
        tool: "subagent_spawn",
        state: {
          status: "completed",
          time: { start: Date.now() - 30_000, end: Date.now() - 29_000 },
        },
      }),
    )
    harness.statuses.set("ses_child_1", { type: "busy" })
    const view = await renderSidebar(harness)
    await view.waitForFrame((f) => f.includes("▶ explore"))

    // The child's run dies, then the session settles.
    harness.emit("message.updated", {
      sessionID: "ses_child_1",
      info: {
        id: "msg_child_1",
        sessionID: "ses_child_1",
        role: "assistant",
        error: { name: "UnknownError", data: { message: "boom" } },
      },
    })
    harness.statuses.set("ses_child_1", { type: "idle" })
    harness.emit("session.status", {
      sessionID: "ses_child_1",
      status: { type: "idle" },
    })
    const frame = await view.waitForFrame((f) => f.includes("✗"))
    expect(frame).toContain("✗ explore")
    expect(frame).toContain("failed")
    expect(frame).not.toContain("✓")
  })

  test("overflow collapses to a count pointing at /subagents", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    for (let index = 0; index < 7; index++) {
      seedTask(
        harness,
        taskPart({
          id: `prt_many_${index}`,
          messageID: `msg_many_${index}`,
          callID: `call_many_${index}`,
          state: {
            metadata: { sessionId: `ses_child_${index}` },
            input: { subagent_type: "claude", description: `task ${index}` },
            time: { start: Date.now() },
          },
        }),
      )
    }
    const view = await renderSidebar(harness)
    const frame = await view.waitForFrame((f) => f.includes("more"))
    expect(frame).toContain("…2 more (/subagents)")
  })

  test("a finished row lingers, then fades on the ticker", async () => {
    const harness = makeApi()
    await tui(harness.api, { finishedLingerSeconds: 0.2 }, {} as any)
    seedTask(
      harness,
      taskPart({
        state: {
          status: "completed",
          time: { start: Date.now() - 10_000, end: Date.now() },
        },
      }),
    )
    const view = await renderSidebar(harness)
    const frame = await view.waitForFrame((f) => f.includes("Subagents"))
    expect(frame).toContain("✓ explore")

    // The 1 s ticker is the only clock that advances `now`; after it fires,
    // the 0.2 s linger has long lapsed and the section (its only row gone)
    // hides itself.
    await Bun.sleep(1_400)
    await view.renderOnce()
    expect(view.captureCharFrame()).not.toContain("Subagents")
  })
})

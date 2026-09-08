import { describe, expect, test } from "bun:test"
import {
  type ChildProbe,
  dedupeSightings,
  isActive,
  phaseGlyph,
  rowLabel,
  rowOf,
  type SubagentSighting,
  sightingOf,
  splitRows,
  statusWord,
} from "../src/core"

const NOW = 1_700_000_000_000

function taskPart(over: Record<string, unknown> = {}) {
  return {
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    tool: "task",
    callID: "call_1",
    state: {
      status: "running",
      input: { subagent_type: "explore", description: "find the sync path" },
      metadata: { sessionId: "ses_child" },
      time: { start: NOW - 60_000 },
      ...(over.state as Record<string, unknown> | undefined),
    },
    ...Object.fromEntries(
      Object.entries(over).filter(([key]) => key !== "state"),
    ),
  }
}

function sighting(over: Partial<SubagentSighting> = {}): SubagentSighting {
  return {
    key: "call_1",
    partID: "prt_1",
    messageID: "msg_1",
    childID: "ses_child",
    agent: "explore",
    description: "find the sync path",
    background: false,
    state: "running",
    startedAt: NOW - 60_000,
    ...over,
  }
}

describe("sightingOf", () => {
  test("reads a running task part into a sighting", () => {
    expect(sightingOf(taskPart())).toEqual({
      key: "call_1",
      partID: "prt_1",
      messageID: "msg_1",
      childID: "ses_child",
      agent: "explore",
      description: "find the sync path",
      background: false,
      state: "running",
      startedAt: NOW - 60_000,
      endedAt: undefined,
    })
  })

  test("ignores every part that is not a task tool call", () => {
    expect(sightingOf(undefined)).toBeUndefined()
    expect(sightingOf("text")).toBeUndefined()
    expect(sightingOf({ type: "text" })).toBeUndefined()
    expect(sightingOf(taskPart({ tool: "bash" }))).toBeUndefined()
    expect(sightingOf(taskPart({ type: "step-finish" }))).toBeUndefined()
  })

  test("an unknown part status is not a sighting", () => {
    expect(
      sightingOf(taskPart({ state: { status: "streaming" } })),
    ).toBeUndefined()
    expect(sightingOf({ type: "tool", tool: "task", id: "p" })).toBeUndefined()
  })

  test("degrades missing fields to undefined instead of throwing", () => {
    const bare = sightingOf({
      type: "tool",
      tool: "task",
      id: "prt_9",
      messageID: "msg_9",
      state: { status: "pending" },
    })
    expect(bare).toMatchObject({
      key: "prt_9",
      childID: undefined,
      agent: undefined,
      description: undefined,
      background: false,
      state: "pending",
    })
  })

  test("background is read from metadata or input, never from truthy junk", () => {
    expect(
      sightingOf(taskPart({ state: { metadata: { background: true } } }))
        ?.background,
    ).toBe(true)
    expect(
      sightingOf(
        taskPart({
          state: {
            metadata: {},
            input: { background: true, subagent_type: "claude" },
          },
        }),
      )?.background,
    ).toBe(true)
    expect(
      sightingOf(taskPart({ state: { metadata: { background: "true" } } }))
        ?.background,
    ).toBe(false)
  })

  test("completed parts carry their end time", () => {
    const done = sightingOf(
      taskPart({
        state: {
          status: "completed",
          time: { start: NOW - 60_000, end: NOW - 5_000 },
        },
      }),
    )
    expect(done?.state).toBe("completed")
    expect(done?.endedAt).toBe(NOW - 5_000)
  })

  // Verbatim (prompt/output trimmed) from a real 1.18.10 session: ten
  // subagents spawned through subagent-comms' subagent_spawn showed an EMPTY
  // sidebar, because the first reader only accepted `task`. The spawn part
  // completes at launch, so recognizing it AND holding it background is what
  // makes the row live off the child's status instead of vanishing as done.
  test("a real subagent_spawn part is a background sighting", () => {
    const spawn = sightingOf({
      id: "prt_fbb881c2d001aCFkPxGyZ03DqC",
      sessionID: "ses_04477fc65ffe03LD0SL9qJ7Ha4",
      messageID: "msg_spawn_1",
      type: "tool",
      tool: "subagent_spawn",
      callID: "chatcmpl-tool-8de6b7a397ebc3da",
      state: {
        status: "completed",
        input: {
          description: "pick random number",
          prompt: "Pick a random integer …",
          subagent_type: "general",
        },
        output: '<task id="ses_04477e294ffeULzzoCvhutrXhl" state="running">…',
        metadata: {
          parentSessionId: "ses_04477fc65ffe03LD0SL9qJ7Ha4",
          sessionId: "ses_04477e294ffeULzzoCvhutrXhl",
          model: { providerID: "opencode-go", modelID: "hy3" },
          background: true,
          truncated: false,
        },
        title: "pick random number (ses_04477e294ffeULzzoCvhutrXhl)",
        time: { start: 1785557687615, end: 1785557687879 },
      },
    })
    expect(spawn).toMatchObject({
      key: "chatcmpl-tool-8de6b7a397ebc3da",
      childID: "ses_04477e294ffeULzzoCvhutrXhl",
      agent: "general",
      description: "pick random number",
      background: true,
      state: "completed",
    })
    // While the child is busy the row is live; idle settles it.
    expect(rowOf(spawn!, { status: "busy", attention: 0 }).phase).toBe(
      "running",
    )
    expect(rowOf(spawn!, { status: "idle", attention: 0 }).phase).toBe("done")
  })

  test("a subagent_spawn part with no background flag is STILL background", () => {
    // The flag rides ctx.metadata, which a running-state part may not carry
    // yet — and a spawn whose part reads as foreground would show "done" at
    // launch while the subagent works on unseen.
    const spawn = sightingOf(
      taskPart({
        tool: "subagent_spawn",
        state: { status: "completed", metadata: { sessionId: "ses_child" } },
      }),
    )
    expect(spawn?.background).toBe(true)
  })
})

describe("rowOf", () => {
  const probe = (over: Partial<ChildProbe> = {}): ChildProbe => ({
    attention: 0,
    ...over,
  })

  test("the foreground lifecycle follows the part status", () => {
    expect(rowOf(sighting({ state: "pending" }), undefined).phase).toBe(
      "starting",
    )
    expect(rowOf(sighting(), probe({ status: "busy" })).phase).toBe("running")
    expect(rowOf(sighting({ state: "error" }), undefined).phase).toBe("failed")
    expect(
      rowOf(sighting({ state: "completed", endedAt: NOW }), probe()).phase,
    ).toBe("done")
  })

  test("a pending permission or question turns a live row into waiting", () => {
    expect(rowOf(sighting(), probe({ attention: 1 })).phase).toBe("waiting")
    expect(
      rowOf(sighting(), probe({ attention: 2, status: "retry" })).phase,
    ).toBe("waiting")
  })

  test("a retrying child shows as retrying", () => {
    expect(rowOf(sighting(), probe({ status: "retry" })).phase).toBe("retrying")
  })

  test("a background launch stays live while the child is busy", () => {
    const launched = sighting({
      background: true,
      state: "completed",
      endedAt: NOW - 50_000,
    })
    expect(rowOf(launched, probe({ status: "busy" })).phase).toBe("running")
    expect(rowOf(launched, probe({ status: "retry" })).phase).toBe("retrying")
    expect(rowOf(launched, probe({ attention: 1 })).phase).toBe("waiting")
  })

  test("a background child that went idle is done, stamped with its last activity", () => {
    const launched = sighting({
      background: true,
      state: "completed",
      endedAt: NOW - 50_000,
    })
    const row = rowOf(
      launched,
      probe({ status: "idle", updatedAt: NOW - 2_000 }),
    )
    expect(row.phase).toBe("done")
    expect(row.endedAt).toBe(NOW - 2_000)
  })

  test("a background child the host knows nothing about reads as done, not running", () => {
    const launched = sighting({
      background: true,
      state: "completed",
      endedAt: NOW - 50_000,
    })
    expect(rowOf(launched, undefined).phase).toBe("done")
  })

  // subagent_send resumes an existing child WITHOUT writing a new spawn part,
  // so the only retained sighting stays completed/error while the child works
  // — a live probe must outrank any settled part, foreground included.
  test("a live child overrides a settled foreground sighting", () => {
    const finished = sighting({ state: "completed", endedAt: NOW - 90_000 })
    expect(rowOf(finished, probe({ status: "busy" })).phase).toBe("running")
    expect(rowOf(finished, probe({ status: "retry" })).phase).toBe("retrying")
    expect(rowOf(finished, probe({ attention: 1 })).phase).toBe("waiting")
    // And the row is live again: no end time while the child works.
    expect(rowOf(finished, probe({ status: "busy" })).endedAt).toBeUndefined()
    const errored = sighting({ state: "error" })
    expect(rowOf(errored, probe({ status: "busy" })).phase).toBe("running")
    expect(rowOf(errored, probe({ attention: 1 })).phase).toBe("waiting")
    // An idle child leaves the part's verdict alone.
    expect(rowOf(finished, probe({ status: "idle" })).phase).toBe("done")
    expect(rowOf(errored, probe({ status: "idle" })).phase).toBe("failed")
  })

  test("a settled child with a failed verdict reads as failed, not done", () => {
    const launched = sighting({
      background: true,
      state: "completed",
      endedAt: NOW - 50_000,
    })
    expect(rowOf(launched, probe({ status: "idle", failed: true })).phase).toBe(
      "failed",
    )
    // A foreground sighting whose child failed a LATER (subagent_send) run
    // carries the verdict too — the part alone can never learn of it.
    expect(
      rowOf(sighting({ state: "completed" }), probe({ failed: true })).phase,
    ).toBe("failed")
    // The verdict never settles a child that is still working.
    expect(rowOf(launched, probe({ status: "busy", failed: true })).phase).toBe(
      "running",
    )
  })

  test("the observed settle time outranks the record stamp and the part end", () => {
    const launched = sighting({
      background: true,
      state: "completed",
      endedAt: NOW - 50_000,
    })
    const row = rowOf(
      launched,
      probe({
        status: "idle",
        updatedAt: NOW - 70_000,
        settledAt: NOW - 2_000,
      }),
    )
    expect(row.phase).toBe("done")
    expect(row.endedAt).toBe(NOW - 2_000)
    // Foreground: a settle observed after a resume outranks the original end.
    const resumedAndDone = rowOf(
      sighting({ state: "completed", endedAt: NOW - 90_000 }),
      probe({ status: "idle", settledAt: NOW - 3_000 }),
    )
    expect(resumedAndDone.endedAt).toBe(NOW - 3_000)
    // Without an observed settle, foreground keeps the part's own end.
    const unobserved = rowOf(
      sighting({ state: "completed", endedAt: NOW - 5_000 }),
      probe({ status: "idle", updatedAt: NOW - 70_000 }),
    )
    expect(unobserved.endedAt).toBe(NOW - 5_000)
  })

  test("a live row never carries an end time", () => {
    expect(rowOf(sighting(), probe()).endedAt).toBeUndefined()
    // Even when a resumed task's sighting still has the previous run's end.
    expect(
      rowOf(sighting({ endedAt: NOW - 90_000 }), probe()).endedAt,
    ).toBeUndefined()
  })
})

describe("dedupeSightings", () => {
  test("a resumed task collapses to its newest sighting", () => {
    const first = sighting({
      key: "call_1",
      partID: "prt_1",
      messageID: "msg_1",
      state: "completed",
      endedAt: NOW - 90_000,
    })
    const resumed = sighting({
      key: "call_2",
      partID: "prt_2",
      messageID: "msg_2",
    })
    expect(dedupeSightings([first, resumed])).toEqual([resumed])
    // Feeding the store's re-read in either order changes nothing.
    expect(dedupeSightings([resumed, first])).toEqual([resumed])
  })

  test("sightings without a child yet stand alone", () => {
    const a = sighting({ key: "call_1", childID: undefined })
    const b = sighting({ key: "call_2", partID: "prt_2", childID: undefined })
    expect(dedupeSightings([a, b])).toEqual([a, b])
  })

  test("distinct children keep distinct rows, in first-appearance order", () => {
    const a = sighting({ key: "call_1", childID: "ses_a" })
    const b = sighting({ key: "call_2", partID: "prt_2", childID: "ses_b" })
    expect(dedupeSightings([a, b]).map((s) => s.childID)).toEqual([
      "ses_a",
      "ses_b",
    ])
  })
})

describe("splitRows", () => {
  const row = (over: Partial<ReturnType<typeof rowOf>> = {}) =>
    rowOf(sighting(over as Partial<SubagentSighting>), { attention: 0 })

  test("live rows are active, fresh finishes linger, stale ones drop", () => {
    const live = row()
    const fresh = rowOf(
      sighting({ key: "c2", state: "completed", endedAt: NOW - 10_000 }),
      undefined,
    )
    const stale = rowOf(
      sighting({ key: "c3", state: "completed", endedAt: NOW - 120_000 }),
      undefined,
    )
    const split = splitRows([live, fresh, stale], NOW, 60_000)
    expect(split.active.map((r) => r.key)).toEqual(["call_1"])
    expect(split.recent.map((r) => r.key)).toEqual(["c2"])
  })

  test("a settled row with no end stamp never lingers", () => {
    const unstamped = rowOf(
      sighting({ key: "c4", state: "completed", endedAt: undefined }),
      undefined,
    )
    expect(splitRows([unstamped], NOW, 60_000)).toEqual({
      active: [],
      recent: [],
    })
  })
})

describe("presentation", () => {
  test("labels degrade from agent+description to whichever is known", () => {
    expect(rowLabel(rowOf(sighting(), undefined))).toBe(
      "explore: find the sync path",
    )
    expect(
      rowLabel(rowOf(sighting({ description: undefined }), undefined)),
    ).toBe("explore")
    expect(rowLabel(rowOf(sighting({ agent: undefined }), undefined))).toBe(
      "find the sync path",
    )
    expect(
      rowLabel(
        rowOf(
          sighting({ agent: undefined, description: undefined }),
          undefined,
        ),
      ),
    ).toBe("subagent")
  })

  test("status words: elapsed while live, words where time is wrong", () => {
    expect(statusWord(rowOf(sighting(), { attention: 0 }), NOW)).toBe("1m00s")
    expect(
      statusWord(rowOf(sighting({ state: "pending" }), undefined), NOW),
    ).toBe("starting")
    expect(statusWord(rowOf(sighting(), { attention: 1 }), NOW)).toBe(
      "waiting on you",
    )
    expect(
      statusWord(rowOf(sighting(), { attention: 0, status: "retry" }), NOW),
    ).toBe("retrying 1m00s")
    expect(
      statusWord(
        rowOf(sighting({ state: "completed", endedAt: NOW }), undefined),
        NOW,
      ),
    ).toBe("done")
    expect(
      statusWord(rowOf(sighting({ state: "error" }), undefined), NOW),
    ).toBe("failed")
  })

  test("glyphs are single-cell and phase-distinct where it matters", () => {
    expect(phaseGlyph("running")).toBe("▶")
    expect(phaseGlyph("starting")).toBe("▶")
    expect(phaseGlyph("retrying")).toBe("▶")
    expect(phaseGlyph("waiting")).toBe("!")
    expect(phaseGlyph("done")).toBe("✓")
    expect(phaseGlyph("failed")).toBe("✗")
  })

  test("isActive divides the six phases into live and settled", () => {
    expect(isActive("starting")).toBe(true)
    expect(isActive("running")).toBe(true)
    expect(isActive("retrying")).toBe(true)
    expect(isActive("waiting")).toBe(true)
    expect(isActive("done")).toBe(false)
    expect(isActive("failed")).toBe(false)
  })
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { writeJsonFile } from "@macarons/permission-rules"
import { flush } from "@macarons/plugin-test-harness"
import {
  createSlotMounter,
  type RenderSetup,
  settleFrame,
} from "@macarons/plugin-test-harness/view"
import { RGBA } from "@opentui/core"
import {
  STATE_FILE_VERSION,
  type TaskSnapshot,
  type TasksFile,
  tasksFilePath,
} from "../src/shared"
import { makeApi as makeHarness } from "./harness"

// WP9 — tui-view-no-render-test. The sidebar View (src/tui.tsx 464-516) never
// executes in the engine tests, which assert only that `sidebar_content` is a
// function. This file mounts the registered slot under @opentui/solid's
// headless renderer (the package bunfig preloads the real solid transform) and
// asserts on captured char frames — the only surface that pins the View's
// plugin-authored filtering/layout: the FINISHED_VISIBLE_MS window, the
// per-session finished filter, the SIDEBAR_LIMIT slice + overflow arithmetic,
// the "+N in other sessions" row, and the parentID sub-agent suppression.

let sandbox: string
let project: string
let stateDir: string

const ERROR_COLOR = "#ff0000"
const asInts = (hex: string) => RGBA.fromHex(hex).toInts()

beforeEach(async () => {
  sandbox = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "background-tasks-view-")),
  )
  project = path.join(sandbox, "project")
  stateDir = path.join(sandbox, "state")
  await Promise.all([fs.mkdir(project), fs.mkdir(stateDir)])
})

const mountSlot = createSlotMounter({ width: 60, height: 16 })

let active: ReturnType<typeof makeHarness> | undefined

afterEach(async () => {
  await active?.dispose()
  active = undefined
  await fs.rm(sandbox, { recursive: true, force: true })
})

function runningTask(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: "bg_1",
    name: "dev server",
    command: "bunx vite --port 5173",
    workdir: project,
    sessionID: "ses_1",
    agent: "build",
    pid: process.pid,
    state: "running",
    startedAt: Date.now() - 30_000,
    outputBytes: 10,
    droppedBytes: 0,
    recentOutput: "Listening on 5173\n",
    ...overrides,
  }
}

/** A finished (exited) task, `endedAt` seconds ago via `agoMs`. */
function finishedTask(agoMs: number, overrides: Partial<TaskSnapshot> = {}) {
  const now = Date.now()
  return runningTask({
    state: "exited",
    exitCode: 0,
    startedAt: now - agoMs - 5_000,
    endedAt: now - agoMs,
    ...overrides,
  })
}

async function plantStateFile(
  tasks: TaskSnapshot[],
  instancePid = process.pid,
  instanceID = "inst-1",
) {
  const file: TasksFile = {
    version: STATE_FILE_VERSION,
    instance: {
      id: instanceID,
      pid: instancePid,
      startedAt: Date.now() - 60_000,
    },
    updatedAt: Date.now(),
    tasks,
  }
  await writeJsonFile(tasksFilePath(stateDir, project, instanceID), file)
}

function makeApi(sessionParents: Record<string, string> = {}) {
  const harness = makeHarness({
    paths: {
      state: stateDir,
      config: path.join(sandbox, "config"),
      worktree: project,
      directory: project,
    },
    sessionParents,
  })
  active = harness
  return harness
}

function glyphFgs(view: RenderSetup): Array<[number, number, number, number]> {
  return view
    .captureSpans()
    .lines.flatMap((line) =>
      line.spans
        .filter((span) => span.text.includes("✗"))
        .map((span) => span.fg.toInts()),
    )
}

async function load(harness: ReturnType<typeof makeHarness>) {
  await harness.load()
}

/** Mount the registered sidebar slot for one session. */
async function mount(
  harness: ReturnType<typeof makeHarness>,
  sessionID: string,
) {
  return mountSlot(harness, { sessionID })
}

describe("sidebar view", () => {
  test("keeps a finished task inside the 60s window, drops one past it", async () => {
    // A running anchor makes the header appear regardless of the finished
    // window, so the window's effect is isolated to the two finished rows.
    const harness = makeApi()
    await load(harness)
    await plantStateFile([
      runningTask({ id: "bg_run", name: "live-anchor" }),
      finishedTask(10_000, { id: "bg_recent", name: "just-done" }),
      finishedTask(90_000, { id: "bg_old", name: "long-gone" }),
    ])
    harness.poke()
    const view = await mount(harness, "ses_1")
    const frame = await settleFrame(view, "live-anchor")
    // Finished 10s ago: inside FINISHED_VISIBLE_MS → shown.
    expect(frame).toContain("just-done")
    // Finished 90s ago: past the 60s window → gone.
    expect(frame).not.toContain("long-gone")
  })

  test.each([
    ["failed", "failed", 3],
    ["ambiguous", "uncertain", 1],
  ] as const)(
    "shows %s completion-notification delivery on the task row",
    async (state, label, attempts) => {
      const harness = makeApi()
      await load(harness)
      await plantStateFile([
        finishedTask(10_000, {
          id: "bg_notify_failed",
          name: "build",
          notificationDelivery: {
            batchID: "notify_1",
            state,
            attempts,
            messageID: "msg_3",
          },
        }),
      ])
      harness.poke()
      const view = await mount(harness, "ses_1")
      const frame = await settleFrame(view, `notify ${label}`)
      expect(frame).toContain(`build exit 0 · notify ${label}`)
    },
  )

  test("task failures keep error color when notification delivery also fails", async () => {
    const harness = makeApi()
    await load(harness)
    await plantStateFile([
      finishedTask(10_000, {
        id: "bg_error",
        name: "spawn-error",
        state: "error",
        exitCode: undefined,
        notificationDelivery: {
          batchID: "notify_error",
          state: "failed",
          attempts: 3,
        },
      }),
      finishedTask(10_000, {
        id: "bg_nonzero",
        name: "test-failure",
        exitCode: 2,
        notificationDelivery: {
          batchID: "notify_ambiguous",
          state: "ambiguous",
          attempts: 1,
        },
      }),
    ])
    harness.poke()
    const view = await mount(harness, "ses_1")
    await settleFrame(view, "test-failure")
    expect(glyphFgs(view)).toEqual([asInts(ERROR_COLOR), asInts(ERROR_COLOR)])
  })

  test("never shows a finished task owned by another session", async () => {
    const harness = makeApi()
    await load(harness)
    await plantStateFile([
      runningTask({ id: "bg_run", name: "live-anchor" }),
      // Finished recently (inside the window) but owned by ses_other.
      finishedTask(10_000, {
        id: "bg_leak",
        name: "not-mine",
        sessionID: "ses_other",
      }),
    ])
    harness.poke()
    const view = await mount(harness, "ses_1")
    const frame = await settleFrame(view, "live-anchor")
    // The session filter drops it even though its time window is fine.
    expect(frame).not.toContain("not-mine")
  })

  test("shows exactly SIDEBAR_LIMIT rows plus a '…N more' overflow line", async () => {
    const harness = makeApi()
    await load(harness)
    await plantStateFile(
      Array.from({ length: 7 }, (_, i) =>
        runningTask({ id: `bg_${i + 1}`, name: `job-${i + 1}` }),
      ),
    )
    harness.poke()
    const view = await mount(harness, "ses_1")
    const frame = await settleFrame(view, "Background tasks")
    // First five render.
    for (const n of [1, 2, 3, 4, 5]) expect(frame).toContain(`job-${n}`)
    // The last two are sliced off — surfaced only by the overflow count.
    expect(frame).not.toContain("job-6")
    expect(frame).not.toContain("job-7")
    expect(frame).toContain("…2 more (/bg)")
    // No other-session tasks → the "+N in other sessions" row must be absent
    // (an unguarded row would print "+0 in other sessions").
    expect(frame).not.toContain("in other sessions")
  })

  test("summarises other sessions' running tasks with a '+N' row", async () => {
    const harness = makeApi()
    await load(harness)
    await plantStateFile([
      runningTask({ id: "bg_a", name: "remote-a", sessionID: "ses_other" }),
      runningTask({ id: "bg_b", name: "remote-b", sessionID: "ses_third" }),
    ])
    harness.poke()
    const view = await mount(harness, "ses_1")
    const frame = await settleFrame(view, "Background tasks")
    expect(frame).toContain("+2 in other sessions")
    // Other-session tasks are counted, never listed as rows.
    expect(frame).not.toContain("remote-a")
  })

  test("renders nothing for a sub-agent session even with live tasks", async () => {
    const harness = makeApi({ ses_sub: "ses_parent" })
    await load(harness)
    await plantStateFile([
      runningTask({ id: "bg_sub", name: "hidden-task", sessionID: "ses_sub" }),
    ])
    harness.poke()
    // Control: the parent session (no parentID) sees the task as another
    // session's, proving the file is loaded into the shared signal.
    const control = await mount(harness, "ses_parent")
    await settleFrame(control, "+1 in other sessions")
    await control.renderer.destroy()

    // The sub-agent session earns no sidebar of its own.
    const view = await mount(harness, "ses_sub")
    await flush()
    await view.renderOnce()
    const frame = view.captureCharFrame()
    expect(frame).not.toContain("Background tasks")
    expect(frame).not.toContain("hidden-task")
    expect(frame).not.toContain("in other sessions")
  })
})

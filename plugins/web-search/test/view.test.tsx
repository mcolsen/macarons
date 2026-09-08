import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { writeJsonFile } from "@macarons/permission-rules"
import { flush } from "@macarons/plugin-test-harness"
import {
  createSlotMounter,
  settleFrame,
} from "@macarons/plugin-test-harness/view"
import {
  type SearchesFile,
  type SearchRecord,
  STATE_FILE_VERSION,
  searchesFilePath,
} from "../src/searches"
import { makeApi as makeHarness } from "./harness"

// Mounts the registered sidebar slot under @opentui/solid's headless renderer
// (the package bunfig preloads the real solid transform) and asserts on
// captured char frames — the only surface that pins the View's plugin-authored
// filtering/layout: the per-state row rendering, the visibleMs transient
// window, the per-session filter, the SIDEBAR_LIMIT slice + overflow line, and
// the parentID sub-agent suppression.

let sandbox: string
let project: string
let stateDir: string

beforeEach(async () => {
  sandbox = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "websearch-view-")),
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

function search(overrides: Partial<SearchRecord> = {}): SearchRecord {
  return {
    id: "ws_1",
    sessionID: "ses_1",
    query: "solar flares",
    state: "running",
    startedAt: Date.now() - 2_000,
    ...overrides,
  }
}

/** A completed search that ended `agoMs` ago. */
function completed(agoMs: number, overrides: Partial<SearchRecord> = {}) {
  const now = Date.now()
  return search({
    state: "complete",
    backend: "searxng",
    startedAt: now - agoMs - 1_000,
    endedAt: now - agoMs,
    ...overrides,
  })
}

async function plantStateFile(searches: SearchRecord[]) {
  const file: SearchesFile = {
    version: STATE_FILE_VERSION,
    instance: {
      id: "inst-1",
      pid: process.pid,
      startedAt: Date.now() - 60_000,
    },
    updatedAt: Date.now(),
    searches,
  }
  await writeJsonFile(searchesFilePath(stateDir, project), file)
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

async function load(
  harness: ReturnType<typeof makeHarness>,
  options?: Record<string, unknown>,
) {
  await harness.load(options)
}

async function mount(
  harness: ReturnType<typeof makeHarness>,
  sessionID: string,
) {
  return mountSlot(harness, { sessionID })
}

describe("sidebar view", () => {
  test("renders a row per state with its glyph, query and backend", async () => {
    const harness = makeApi()
    await load(harness)
    await plantStateFile([
      search({ id: "ws_p", query: "pending-one", state: "pending" }),
      search({
        id: "ws_r",
        query: "running-one",
        state: "running",
        backend: "native",
      }),
      completed(1_000, { id: "ws_c", query: "done-one", backend: "exa" }),
    ])
    harness.poke()
    const view = await mount(harness, "ses_1")
    const frame = await settleFrame(view, "Web Search")
    // Rows read: <glyph> [label] query.
    expect(frame).toContain("[queued] pending-one")
    expect(frame).toContain("[provider] running-one") // native, running
    expect(frame).toContain("[Exa] done-one") // the backend it completed against
    // The glyphs carry the state.
    expect(frame).toContain("○ [queued]")
    expect(frame).toContain("◐ [provider]")
    expect(frame).toContain("✓ [Exa]")
  })

  test("keeps a completed search inside the window, drops one past it", async () => {
    // A running anchor keeps the header present regardless of the window, so
    // the window's effect is isolated to the two completed rows.
    const harness = makeApi()
    await load(harness, { visibleMs: 10_000 })
    await plantStateFile([
      search({ id: "ws_anchor", query: "live-anchor", state: "running" }),
      completed(2_000, { id: "ws_recent", query: "just-done" }),
      completed(30_000, { id: "ws_old", query: "long-gone" }),
    ])
    harness.poke()
    const view = await mount(harness, "ses_1")
    const frame = await settleFrame(view, "live-anchor")
    expect(frame).toContain("just-done") // inside 10s → shown
    expect(frame).not.toContain("long-gone") // past 10s → gone
  })

  test("never shows a search owned by another session", async () => {
    const harness = makeApi()
    await load(harness)
    await plantStateFile([
      search({ id: "ws_anchor", query: "live-anchor", state: "running" }),
      search({
        id: "ws_leak",
        query: "not-mine",
        state: "running",
        sessionID: "ses_other",
      }),
    ])
    harness.poke()
    const view = await mount(harness, "ses_1")
    const frame = await settleFrame(view, "live-anchor")
    expect(frame).not.toContain("not-mine")
  })

  test("shows SIDEBAR_LIMIT rows plus a '…N more' overflow line", async () => {
    const harness = makeApi()
    await load(harness)
    await plantStateFile(
      Array.from({ length: 7 }, (_, i) =>
        search({ id: `ws_${i + 1}`, query: `q-${i + 1}`, state: "running" }),
      ),
    )
    harness.poke()
    const view = await mount(harness, "ses_1")
    const frame = await settleFrame(view, "Web Search")
    for (const n of [1, 2, 3, 4, 5]) expect(frame).toContain(`q-${n}`)
    expect(frame).not.toContain("q-6")
    expect(frame).not.toContain("q-7")
    expect(frame).toContain("…2 more")
  })

  test("renders nothing for a sub-agent session even with live searches", async () => {
    const harness = makeApi({ ses_sub: "ses_parent" })
    await load(harness)
    await plantStateFile([
      search({
        id: "ws_sub",
        query: "hidden",
        state: "running",
        sessionID: "ses_sub",
      }),
    ])
    // Control: the parent session owns nothing here, so it shows nothing
    // either — but the file IS loaded (a foreign-session running search).
    const view = await mount(harness, "ses_sub")
    await flush()
    await view.renderOnce()
    const frame = view.captureCharFrame()
    expect(frame).not.toContain("Web Search")
    expect(frame).not.toContain("hidden")
  })

  test("is empty when the viewed session has no searches", async () => {
    const harness = makeApi()
    await load(harness)
    await plantStateFile([
      search({ id: "ws_x", query: "elsewhere", sessionID: "ses_other" }),
    ])
    harness.poke()
    const view = await mount(harness, "ses_1")
    await flush()
    await view.renderOnce()
    const frame = view.captureCharFrame()
    expect(frame).not.toContain("Web Search")
  })
})

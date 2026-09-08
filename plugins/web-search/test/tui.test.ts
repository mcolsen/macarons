import { beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describeGating } from "@macarons/plugin-test-harness/tui"
import { SYNC_COMMAND } from "../src/searches"
import { makeApi } from "./harness"

// Engine-level surface (no render): compat + locality gating, slot/command
// registration, and the option toggle. The View's filtering and layout are
// pinned separately by test/view.test.tsx under the real solid renderer.

let sandbox: string
let project: string
let stateDir: string

beforeEach(async () => {
  sandbox = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "websearch-tui-")),
  )
  project = path.join(sandbox, "project")
  stateDir = path.join(sandbox, "state")
  await Promise.all([fs.mkdir(project), fs.mkdir(stateDir)])
})

function api(input: Parameters<typeof makeApi>[0] = {}) {
  return makeApi({
    paths: {
      state: stateDir,
      config: path.join(sandbox, "config"),
      worktree: project,
      directory: project,
    },
    ...input,
  })
}

describeGating({
  remoteBails: true,
  load: async (input) => {
    const mock = api(input)
    await mock.load()
    const run = {
      toasts: mock.toasts,
      registered: mock.slotPlugins.length === 1,
      inert:
        mock.layers.length === 0 &&
        mock.slotPlugins.length === 0 &&
        mock.handlers.size === 0,
    }
    await mock.dispose()
    return run
  },
})

describe("registration", () => {
  test("sidebar slot registers at order 170 with only sidebar_content", async () => {
    const mock = api()
    await mock.load()
    expect(mock.slotPlugins).toHaveLength(1)
    expect(mock.slotPlugins[0].order).toBe(170)
    expect(Object.keys(mock.slotPlugins[0].slots)).toEqual(["sidebar_content"])
    await mock.dispose()
  })

  test("registers the hidden (non-palette) sync command the server pokes", async () => {
    const mock = api()
    await mock.load()
    const sync = mock
      .commands()
      .find((command: any) => command.name === SYNC_COMMAND)
    expect(sync).toBeDefined()
    expect(sync?.namespace).toBeUndefined()
    expect(() => sync?.run?.()).not.toThrow()
    // Subscribed to the poke event too (redundant delivery path).
    expect(mock.handlers.has("tui.command.execute")).toBe(true)
    await mock.dispose()
  })

  test("sidebar:false disables the plugin entirely — no slot, no command", async () => {
    const mock = api({ options: { sidebar: false } })
    await mock.load()
    expect(mock.slotPlugins).toHaveLength(0)
    expect(mock.layers).toHaveLength(0)
    expect(mock.handlers.has("tui.command.execute")).toBe(false)
    await mock.dispose()
  })
})

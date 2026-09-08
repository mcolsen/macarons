import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import { describeBundle } from "@macarons/plugin-test-harness"
import type { Plugin, ToolContext } from "@opencode-ai/plugin"

// The bundle must inline permission-rules, the tool() helper, and its zod —
// the ./shared and workspace imports that a file copied into
// `.opencode/plugin/` cannot follow.

const bundle = describeBundle({
  testDir: import.meta.dir,
  exportName: "BackgroundTasksPlugin",
})

test("the copied single-file bundle analyzes and runs commands without parser sidecars", async () => {
  const base = path.dirname(bundle.artifact())
  const root = path.join(base, "project")
  const state = path.join(base, "state")
  await fs.mkdir(root)
  await fs.mkdir(state)
  const mod = await bundle.importArtifact()
  const plugin = mod.BackgroundTasksPlugin as Plugin
  const hooks = await plugin(
    {
      directory: root,
      worktree: root,
      serverUrl: new URL("http://localhost:4096"),
      client: {
        global: {
          health: async () => ({
            data: { healthy: true, version: BAND.floor },
          }),
        },
        path: {
          get: async () => ({
            data: { state, config: path.join(base, "config") },
          }),
        },
        app: { log: async () => ({ data: true }) },
        tui: { publish: async () => ({ data: true }) },
      },
    } as unknown as Parameters<Plugin>[0],
    { notify: false, toast: false },
  )
  const asks: Array<{ permission: string; patterns: string[] }> = []
  const ctx = {
    sessionID: "ses_bundle",
    messageID: "msg_bundle",
    agent: "build",
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata() {},
    async ask(input) {
      asks.push(input)
      if (input.patterns.includes("uname -s")) throw new Error("denied uname")
    },
  } satisfies ToolContext
  try {
    await expect(
      hooks.tool!.background_run!.execute(
        { command: "printf started > sentinel; uname -s" },
        ctx,
      ),
    ).rejects.toThrow("denied uname")
    await expect(fs.access(path.join(root, "sentinel"))).rejects.toThrow()
    expect(asks[0]?.patterns).toContain("uname -s")

    const result = await hooks.tool!.background_run!.execute(
      { command: 'printf "%s" "$(printf bundled)"' },
      ctx,
    )
    if (typeof result === "string") throw new Error("Expected task metadata")
    const output = (await hooks.tool!.background_wait!.execute(
      { task_id: result.metadata?.taskId, timeout_ms: 1_000 },
      ctx,
    )) as { output: string }
    expect(output.output).toContain("bundled")
    expect(asks[1]?.patterns).toContain("printf bundled")
  } finally {
    await hooks.dispose?.()
  }
})

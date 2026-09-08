import { describe, expect, test } from "bun:test"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import { describeBundle } from "@macarons/plugin-test-harness"

// The one install method that cannot follow a bare import is copying a single
// file into `.opencode/plugin/` — every top-level file there is loaded as its
// own plugin module, with no node_modules beside it. The artifact must inline
// everything it uses: croner, @macarons/permission-rules, and
// @opencode-ai/plugin with its zod. A surviving bare `from "croner"` is a
// hard module-not-found at load time that no unit test in this package can
// see, because the workspace root always has croner installed.

const bundle = describeBundle({
  testDir: import.meta.dir,
  exportName: "CronPlugin",
})

describe("bundled cron tools", () => {
  test("the bundled plugin registers the three cron tools against a stub host", async () => {
    // Proves the artifact is not merely importable but callable: the factory
    // runs its compat probe and tool registration entirely out of the bundle,
    // which is where an inlining gap would surface as a throw.
    const mod = (await bundle.importArtifact()) as unknown as {
      CronPlugin: (input: unknown) => Promise<{
        tool?: Record<string, unknown>
      }>
    }
    const client = {
      global: { health: async () => ({ data: { version: BAND.floor } }) },
      app: { log: async () => ({}) },
      session: {},
      tui: { showToast: async () => ({ data: true }) },
    }
    const hooks = await mod.CronPlugin({
      client,
      directory: "/project",
      worktree: "/project",
      serverUrl: new URL("http://opencode.internal"),
    })
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "cron_create",
      "cron_delete",
      "cron_list",
    ])
  })
})

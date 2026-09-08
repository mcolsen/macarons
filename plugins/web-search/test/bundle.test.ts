import { describe, expect, test } from "bun:test"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import { describeBundle } from "@macarons/plugin-test-harness"

// The artifact must inline the whole backend chain and the shared library —
// only src/index.ts is built; the TUI companion never rides along.

const bundle = describeBundle({
  testDir: import.meta.dir,
  exportName: "WebSearchPlugin",
})

describe("bundled behavior", () => {
  test("the bundled plugin registers the websearch shadow against a stub host", async () => {
    // Proves the artifact is not merely importable but callable: the
    // factory runs its compat probe and tool registration entirely out of
    // the bundle, which is where an inlining gap would surface as a throw.
    const mod = (await bundle.importArtifact()) as unknown as {
      WebSearchPlugin: (
        input: unknown,
        options?: unknown,
      ) => Promise<{ tool?: Record<string, unknown> }>
    }
    const client = {
      global: { health: async () => ({ data: { version: BAND.floor } }) },
      app: { log: async () => ({}) },
      config: { providers: async () => ({ data: { providers: [] } }) },
      path: { get: async () => ({ data: {} }) },
      tui: { showToast: async () => ({ data: true }) },
    }
    const hooks = await mod.WebSearchPlugin({
      client,
      directory: "/project",
      worktree: "/project",
      serverUrl: new URL("http://opencode.internal"),
    })
    expect(Object.keys(hooks.tool ?? {})).toEqual(["web_search", "websearch"])
  })
})

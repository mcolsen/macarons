import { describe, expect, test } from "bun:test"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import { describeBundle } from "@macarons/plugin-test-harness"

const bundle = describeBundle({
  testDir: import.meta.dir,
  exportName: "ScopedSystemPromptsPlugin",
})

describe("bundled behavior", () => {
  test("registers the system transform with configured rules", async () => {
    const mod = (await bundle.importArtifact()) as unknown as {
      ScopedSystemPromptsPlugin: (
        input: unknown,
        options: unknown,
      ) => Promise<Record<string, unknown>>
    }
    const hooks = await mod.ScopedSystemPromptsPlugin(
      {
        client: {
          app: { log: async () => ({ data: true }) },
          global: {
            health: async () => ({ data: { version: BAND.floor } }),
          },
        },
        directory: "/project",
        serverUrl: new URL("http://opencode.internal"),
      },
      {
        prompts: [
          {
            model: "openai/gpt-5.6-sol",
            mode: "append",
            content: "configured",
          },
        ],
      },
    )

    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function")
  })
})

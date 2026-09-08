import { describePackaging } from "@macarons/plugin-test-harness"

// The plugin package is type-only: bundled and source installs need no
// @opencode-ai/plugin runtime import.
describePackaging({
  testDir: import.meta.dir,
  serverExport: "ScopedSystemPromptsPlugin",
  devOnlyDeps: ["@opencode-ai/plugin", "@opencode-ai/sdk"],
})

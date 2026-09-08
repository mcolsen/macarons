import { describeBundle } from "@macarons/plugin-test-harness"

// The bundle must inline the ./shared module — the one import a file copied
// into `.opencode/plugin/` cannot follow.

describeBundle({
  testDir: import.meta.dir,
  exportName: "BtwPlugin",
})

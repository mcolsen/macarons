import { describeBundle } from "@macarons/plugin-test-harness"

// This is the largest server half in the suite and the one that value-imports
// both the workspace library and @opencode-ai/plugin, so a bundler change
// that left either as a bare specifier would ship a dist file that cannot
// resolve on a user's machine — invisible to the unit suite, which imports
// src/ only.

describeBundle({
  testDir: import.meta.dir,
  exportName: "SubagentCommsPlugin",
})

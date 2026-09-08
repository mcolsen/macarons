import { describePackaging } from "@macarons/plugin-test-harness"

// subagent-comms is server-only by design — the host TUI already surfaces
// child sessions — so there must be no ./tui export for the installer to
// discover. src imports { tool } from @opencode-ai/plugin at runtime, so it
// must be a real dependency.

describePackaging({
  testDir: import.meta.dir,
  serverExport: "SubagentCommsPlugin",
  runtimeDeps: ["@opencode-ai/plugin"],
})

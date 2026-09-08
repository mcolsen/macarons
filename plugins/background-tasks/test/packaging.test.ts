import { describePackaging } from "@macarons/plugin-test-harness"

// background-tasks ships both halves — the server half owns the task tools,
// the TUI half the tasks sidebar. src value-imports tool() from
// @opencode-ai/plugin, so a registry install must receive it as a real
// dependency.

describePackaging({
  testDir: import.meta.dir,
  serverExport: "BackgroundTasksPlugin",
  tui: true,
  runtimeDeps: ["@opencode-ai/plugin", "unbash"],
})

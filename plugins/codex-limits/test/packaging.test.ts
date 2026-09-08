import { describePackaging } from "@macarons/plugin-test-harness"

// codex-limits ships the auth-proof server companion and the TUI widget.
// The dual-solid-js bug originally shipped here (fine in tests and fast e2e
// runs, missing in real sessions), so the
// harness's solid-js scan is the direct regression guard here: reactive state
// outside the entry must come from ProviderContext.createSignal.

describePackaging({
  testDir: import.meta.dir,
  serverExport: "CodexLimitsPlugin",
  tui: true,
  runtimeDeps: ["@macarons/approve-for-me", "@macarons/usage-limits"],
})

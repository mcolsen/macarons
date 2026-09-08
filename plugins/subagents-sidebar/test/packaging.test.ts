import { describePackaging } from "@macarons/plugin-test-harness"

// subagents-sidebar is TUI-only — the sidebar section and the /subagents
// palette both live in the TUI half — so no server target may be advertised.

describePackaging({
  testDir: import.meta.dir,
  tui: true,
})

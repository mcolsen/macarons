import { describePackaging } from "@macarons/plugin-test-harness"

// cache-ratio is TUI-only — the sidebar readout needs nothing server-side —
// so no server target may be advertised for the installer (or the legacy
// server loader) to find.

describePackaging({
  testDir: import.meta.dir,
  tui: true,
})

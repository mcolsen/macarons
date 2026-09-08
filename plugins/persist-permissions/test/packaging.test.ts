import { describePackaging } from "@macarons/plugin-test-harness"

// persist-permissions ships both halves, and BOTH import the shared
// permission-rules library at runtime through src/shared.ts — the harness's
// permission-rules dependency assertion is load-bearing for the TUI entry
// here, not just the server one.

describePackaging({
  testDir: import.meta.dir,
  serverExport: "PersistPermissionsPlugin",
  tui: true,
})

import { describePackaging } from "@macarons/plugin-test-harness"

// btw ships both halves. Unusually, src touches @opencode-ai/plugin for types
// only, so it stays dev-side and there are no runtimeDeps to list beyond the
// always-asserted permission-rules library.

describePackaging({
  testDir: import.meta.dir,
  serverExport: "BtwPlugin",
  tui: true,
})

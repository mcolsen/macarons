import { describePackaging } from "@macarons/plugin-test-harness"

describePackaging({
  testDir: import.meta.dir,
  serverExport: "SyntheticLimitsPlugin",
  tui: true,
  runtimeDeps: ["@macarons/usage-limits"],
})

import { describePackaging } from "@macarons/plugin-test-harness"

describePackaging({
  testDir: import.meta.dir,
  tui: true,
  runtimeDeps: ["@macarons/approve-for-me", "@macarons/usage-limits"],
})

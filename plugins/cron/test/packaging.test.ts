import { describePackaging } from "@macarons/plugin-test-harness"

// cron is server-only by design — it has no UI of its own — so there must be
// no ./tui export for the installer to discover. croner does the actual
// expression parsing and next-match arithmetic; the host loads src directly,
// so it (and the plugin/tool helper) must be real dependencies while the
// type-only sdk stays dev-side.

describePackaging({
  testDir: import.meta.dir,
  serverExport: "CronPlugin",
  runtimeDeps: ["@opencode-ai/plugin", "croner"],
  devOnlyDeps: ["@opencode-ai/sdk"],
})

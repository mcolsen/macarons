import { describeBundle } from "@macarons/plugin-test-harness"

// The bundle must inline the relative graph (./shared, ./engine/*) and the
// vendored rule set — a copied single file cannot follow any of them.

describeBundle({
  testDir: import.meta.dir,
  exportName: "RedactSecretsPlugin",
})

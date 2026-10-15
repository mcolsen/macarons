import { expect, test } from "bun:test"

test("bundles the vendored detector while leaving host SDK packages external", async () => {
  const build = await Bun.build({
    entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
    target: "bun",
    packages: "external",
  })
  expect(build.success).toBe(true)
  const text = await build.outputs[0]?.text()
  expect(text).toContain("macarons.redact-secrets")
  expect(text).toContain("github-pat")
  expect(text).not.toContain("@opencode-ai/plugin")
})

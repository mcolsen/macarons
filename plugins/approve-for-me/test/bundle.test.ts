import { expect, test } from "bun:test"

test("server compiles using only the native host SDK", async () => {
  const build = await Bun.build({
    entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
    target: "bun",
    external: ["@opencode/plugin", "@opencode/client", "effect"],
  })
  expect(build.success).toBe(true)
  const output = await build.outputs[0]?.text()
  expect(output).toContain("macarons.approve-for-me")
  expect(output).not.toContain("@opencode-ai/")
})

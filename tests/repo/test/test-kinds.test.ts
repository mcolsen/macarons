import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const plugins = readdirSync(path.join(root, "plugins")).filter((id) =>
  existsSync(path.join(root, "plugins", id, "package.json")),
)

test("each retained plugin has functional tests in addition to central packaging checks", () => {
  expect(plugins).toHaveLength(8)
  for (const plugin of plugins) {
    const tests = readdirSync(
      path.join(root, "plugins", plugin, "test"),
    ).filter(
      (file) =>
        /\.test\.tsx?$/.test(file) &&
        !["packaging.test.ts", "bundle.test.ts"].includes(file),
    )
    expect(tests.length, plugin).toBeGreaterThan(0)
    const pkg = JSON.parse(
      readFileSync(path.join(root, "plugins", plugin, "package.json"), "utf8"),
    )
    if (pkg.exports["./tui"])
      expect(
        tests.some((file) => /(?:tui|view)\.test\.tsx?$/.test(file)),
        plugin,
      ).toBe(true)
  }
})

test("central native packaging checks execute shared packaging and bundle contracts", () => {
  const source = readFileSync(
    path.join(import.meta.dir, "native-packaging.test.ts"),
    "utf8",
  )
  expect(source).toContain('from "@macarons/plugin-test-harness"')
  expect(source).toContain("describePackaging({")
  expect(source).toContain("describeBundle({")
})

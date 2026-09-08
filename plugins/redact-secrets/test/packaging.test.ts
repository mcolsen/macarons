import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { describePackaging } from "@macarons/plugin-test-harness"

const ROOT = path.join(import.meta.dir, "..")

describePackaging({
  testDir: import.meta.dir,
  serverExport: "RedactSecretsPlugin",
})

describe("vendored betterleaks rules ship with their provenance", () => {
  test("published files include the vendored license and rule provenance", async () => {
    const pkg = JSON.parse(
      await fs.readFile(path.join(ROOT, "package.json"), "utf8"),
    ) as { files?: string[] }
    expect(pkg.files).toEqual(["LICENSE", "src", "vendor"])
    for (const file of [
      "vendor/betterleaks/LICENSE",
      "vendor/betterleaks/PROVENANCE.md",
    ]) {
      expect((await fs.stat(path.join(ROOT, file))).isFile()).toBe(true)
    }
  })

  test("the MIT license text and copyright survive verbatim", async () => {
    const license = await fs.readFile(
      path.join(ROOT, "vendor", "betterleaks", "LICENSE"),
      "utf8",
    )
    expect(license).toContain("MIT License")
    expect(license).toContain("Zachary Rice")
  })

  test("the generated rules module carries the attribution header", async () => {
    const generated = await fs.readFile(
      path.join(ROOT, "src", "engine", "rules.generated.ts"),
      "utf8",
    )
    expect(generated).toContain("AUTO-GENERATED")
    expect(generated).toContain("betterleaks")
    expect(generated).toContain("MIT License")
  })
})

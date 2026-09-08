import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const ROOT = path.join(import.meta.dir, "..")

async function manifest() {
  return JSON.parse(
    await fs.readFile(path.join(ROOT, "package.json"), "utf8"),
  ) as {
    name?: string
    type?: string
    main?: string
    exports?: Record<string, string>
    files?: string[]
  }
}

describe("usage-limits library manifest", () => {
  test("exports its source entry under the workspace name", async () => {
    const pkg = await manifest()
    expect(pkg.name).toBe("@macarons/usage-limits")
    expect(pkg.type).toBe("module")
    expect(pkg.main).toBe("./src/index.ts")
    expect(pkg.exports?.["."]).toBe(pkg.main)
    expect(
      (await fs.stat(path.resolve(ROOT, pkg.main as string))).isFile(),
    ).toBe(true)
    expect(pkg.files).toContain("src")
  })
})

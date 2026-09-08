import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

/**
 * The shared library had no packaging test, unlike every plugin. This pins the
 * package's install-facing manifest: the scoped name every consumer imports,
 * the "." export that resolves to a real entry file inside the package, and the
 * `files` allowlist that ships `src` (the host loads src directly). The
 * OpenCode version lockstep — SUPPORTED_OPENCODE_RANGE's floor against
 * .opencode-version, engines, and the exact @opencode-ai pins — is owned
 * repo-wide by tests/repo/test/version-pin.test.ts and deliberately NOT
 * duplicated here.
 */

const ROOT = path.join(import.meta.dir, "..")

async function readPackageJson() {
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

describe("permission-rules package manifest", () => {
  test("uses the monorepo package scope", async () => {
    expect((await readPackageJson()).name).toBe("@macarons/permission-rules")
  })

  test("is an ES module", async () => {
    expect((await readPackageJson()).type).toBe("module")
  })

  test('the "." export resolves to an existing file inside the package', async () => {
    const pkg = await readPackageJson()
    const entry = pkg.exports?.["."]
    expect(typeof entry).toBe("string")
    if (typeof entry !== "string") throw new Error('Missing package export "."')
    const resolved = path.resolve(ROOT, entry)
    expect(resolved.startsWith(ROOT + path.sep)).toBe(true)
    expect((await fs.stat(resolved)).isFile()).toBe(true)
    // main, when present, must agree with the "." export so a loader that
    // ignores exports still finds the same entry.
    if (pkg.main !== undefined) expect(pkg.main).toBe(entry)
  })

  test("ships the src directory that the host loads directly", async () => {
    expect((await readPackageJson()).files).toContain("src")
  })
})

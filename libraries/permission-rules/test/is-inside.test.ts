import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { canonicalPath, isInside } from "../src/index"

/**
 * isInside is the suite's containment primitive: four plugins' trust
 * boundaries reduce to it (approve-for-me's escapesProject,
 * background-tasks' cwd check, memory's store containment, and this
 * library's own resolvePermissionStorePaths at index.ts:957). Until this
 * file existed it had no direct assertion anywhere — neutralizing its
 * `relative !== ".."` clause left all 1071 unit tests in the repo green,
 * because no consumer fixture ever produced a candidate that IS the parent's
 * parent. These cases pin each shape the implementation rejects, so a
 * regression in any single clause fails here rather than silently widening
 * every downstream boundary at once.
 */
describe("isInside", () => {
  test("a path is inside itself", () => {
    // path.relative() returns "" here, the one accepting case that is not a
    // strict descendant. Callers rely on it: a store file resolving to the
    // configured root itself is in-bounds, not an escape.
    expect(isInside("/a/b", "/a/b")).toBe(true)
  })

  test("a descendant is inside, at any depth", () => {
    expect(isInside("/a/b", "/a/b/c")).toBe(true)
    expect(isInside("/a/b", "/a/b/c/d/e.txt")).toBe(true)
  })

  test("the parent directory itself is not inside its own child", () => {
    // path.relative("/a/b", "/a") === ".." exactly — no separator follows, so
    // the startsWith("../") clause does NOT catch it and the isAbsolute clause
    // does not either. Only the `relative !== ".."` clause rejects this, and
    // it is the clause with no other coverage in the suite. Without it,
    // escapesProject(["/home/u/project"], "..") reports the project's parent
    // directory as an in-project path and hands it to the classifier.
    expect(isInside("/a/b", "/a")).toBe(false)
    expect(isInside("/home/u/project", "/home/u")).toBe(false)
  })

  test("a sibling sharing the parent's name prefix is not inside", () => {
    // The classic prefix-comparison bug: "/a/bb".startsWith("/a/b") is true,
    // but path.relative gives "../bb". Containment must be path-segment-wise,
    // never string-prefix-wise.
    expect(isInside("/a/b", "/a/bb")).toBe(false)
    expect(isInside("/a/b", "/a/b-backup/secret")).toBe(false)
  })

  test("a child whose own name starts with dots is inside", () => {
    // The mirror of the prefix trap, pointing the other way. The escape check
    // must key on `..` followed by a SEPARATOR: dropping the separator turns
    // every legitimately-named "..cache"-style entry into a reported escape.
    // That direction fails closed rather than open, so nothing security-
    // relevant breaks loudly — a store or task cwd under such a directory just
    // starts getting rejected as out-of-bounds for no visible reason.
    expect(isInside("/a/b", "/a/b/..cache")).toBe(true)
    expect(isInside("/a/b", "/a/b/..cache/state.json")).toBe(true)
  })

  test("an unrelated absolute path is not inside", () => {
    expect(isInside("/a/b", "/x")).toBe(false)
    expect(isInside("/a/b", "/etc/passwd")).toBe(false)
  })

  test("an explicit .. escape is not inside", () => {
    expect(isInside("/a/b", "/a/b/../../.ssh/id_rsa")).toBe(false)
  })
})

describe("isInside symlink caveat", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "inside-")))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("is lexical only — callers must canonicalPath first", async () => {
    // isInside answers a question about path SPELLING. A symlink inside the
    // parent pointing anywhere at all still spells as a descendant, so the
    // lexical answer is true while the file really lives outside. That is why
    // every trust-boundary call site in the suite resolves through
    // canonicalPath (which walks to the nearest existing ancestor) BEFORE
    // asking isInside. If this test ever inverts, the two are being conflated
    // and the escape hatch is open.
    const parent = path.join(dir, "project")
    const outside = path.join(dir, "elsewhere")
    await fs.mkdir(parent)
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(parent, "link"))
    const viaLink = path.join(parent, "link", "stolen.txt")

    expect(isInside(parent, viaLink)).toBe(true)
    expect(isInside(parent, await canonicalPath(viaLink))).toBe(false)
  })
})

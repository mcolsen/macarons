import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Pins that a workspace directory is either a real package or absent — a plugin
 * cannot silently drop out of the test matrix by losing or renaming its
 * package.json. That failure mode is empirical, not hypothetical: commit
 * c5eabe0 (#76) fixed the same shape one enumeration layer over, where
 * tests/e2e/tsconfig.json type-checked a named allowlist of five directories
 * and a "typecheck clean" claim on the other eight was "vacuously true."
 *
 * Enumerated off `git ls-files`, so the real risk (a tracked plugin's manifest
 * lost or renamed in a diff) is caught, while untracked node_modules-only debris
 * — which does not exist in a fresh checkout — can never flip the verdict.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..")

// Workspace roots that hold `@macarons/<dirname>` packages. tests/* is
// excluded deliberately: tests/repo's name is @macarons/repo-tests (dir
// `repo`), which breaks the dir-equals-suffix rule, and neither tests/e2e nor
// tests/repo is an installable package this invariant is about.
const PACKAGE_ROOTS = ["plugins", "libraries", "tools"] as const

function gitLsFiles(...patterns: string[]): string[] {
  // :(glob) pathspec magic: a single `*` must not match across `/`, or git's
  // default (which crosses slashes) would let a nested package.json masquerade
  // as a top-level package.
  const out = execFileSync(
    "git",
    ["ls-files", ...patterns.map((p) => `:(glob)${p}`)],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  )
  return out.split("\n").filter(Boolean)
}

/** Distinct immediate SUBdirectories of each package root, tracked paths only. */
function trackedPackageDirs(): { root: string; dir: string }[] {
  const seen = new Set<string>()
  const dirs: { root: string; dir: string }[] = []
  for (const file of gitLsFiles(...PACKAGE_ROOTS)) {
    const parts = file.split("/")
    const [root, dir] = parts
    // Require root/dir/… — a bare root/file (e.g. libraries/README.md) is not
    // a package directory and must not be mistaken for one.
    if (root === undefined || dir === undefined || parts.length < 3) continue
    if (!(PACKAGE_ROOTS as readonly string[]).includes(root)) continue
    const key = `${root}/${dir}`
    if (seen.has(key)) continue
    seen.add(key)
    dirs.push({ root, dir })
  }
  return dirs
}

const packageDirs = trackedPackageDirs()

describe("every tracked package directory is a real @macarons package", () => {
  test("the directory enumeration is not vacuously empty", () => {
    // 15 today (12 plugins + permission-rules + plugin-test-harness +
    // installer). The floor only guards against a broken or empty
    // enumeration, so it keeps headroom below the real count — retiring a
    // package should not trip it.
    expect(packageDirs.length).toBeGreaterThanOrEqual(10)
  })

  test("each holds a tracked package.json named @macarons/<dir>", () => {
    const tracked = new Set(
      gitLsFiles(...PACKAGE_ROOTS.map((r) => `${r}/*/package.json`)),
    )
    const offenders: string[] = []
    for (const { root, dir } of packageDirs) {
      const rel = `${root}/${dir}/package.json`
      if (!tracked.has(rel)) {
        offenders.push(`${root}/${dir}: no tracked package.json`)
        continue
      }
      const name = (
        JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf8")) as {
          name?: string
        }
      ).name
      const expected = `@macarons/${dir}`
      if (name !== expected) {
        offenders.push(`${root}/${dir}: name is ${name}, expected ${expected}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

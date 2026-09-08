import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * The README is where a new user discovers plugins, and it is
 * hand-maintained against plugins/: a new plugin can land with
 * tests, packaging and SUITE registration all green yet be absent from the
 * table, or a rename can leave a dead README link. Each row's link and display
 * name must agree with the tracked set, and every linked README must exist.
 *
 * Enumerated off `git ls-files` (following jsx-whitespace.test.ts) so untracked
 * checkouts under .opencode/worktrees never leak in and only real plugins count.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..")

function gitLsFiles(...patterns: string[]): string[] {
  // :(glob) pathspec magic: a single `*` must not match across `/`, or git's
  // default (which crosses slashes) would let a nested package.json masquerade
  // as a top-level package.
  return execFileSync(
    "git",
    ["ls-files", ...patterns.map((p) => `:(glob)${p}`)],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  )
    .split("\n")
    .filter(Boolean)
}

const trackedPluginDirs = gitLsFiles("plugins/*/package.json")
  .map((rel) => path.basename(path.dirname(rel)))
  .sort()

const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8").split(
  "\n",
)

type Row = {
  linkDir: string
  textDir: string
  desc: string
}

/** Parse the plugin guide's name-and-description rows. */
function pluginTableRows(): Row[] {
  const rows: Row[] = []
  for (const line of readme) {
    if (!line.trimStart().startsWith("|")) continue
    const cells = line.split("|").map((c) => c.trim())
    // "| link | description |" -> ["", link, desc, ""]
    const [, link, desc] = cells
    if (link === undefined) continue
    if (!link.includes("](plugins/")) continue
    const textDir = link.match(/^\[([\w-]+)\]/)?.[1]
    const linkDir = link.match(/\]\(plugins\/([\w-]+)\/README\.md\)$/)?.[1]
    rows.push({
      linkDir: linkDir ?? "",
      textDir: textDir ?? "",
      desc: desc ?? "",
    })
  }
  return rows
}

describe("README stays in sync with the plugin set", () => {
  const rows = pluginTableRows()

  test("the parse found the plugin table and the tracked set", () => {
    // Floor guards against an empty parse; kept below the real count so a
    // legitimately removed plugin is not a false positive. The load-bearing
    // check is the exact set equality below, not this floor.
    expect(trackedPluginDirs.length).toBeGreaterThanOrEqual(10)
    expect(rows.length).toBe(trackedPluginDirs.length)
  })

  test("each plugin row encodes one consistent, non-empty directory", () => {
    const offenders: string[] = []
    for (const row of rows) {
      if (row.linkDir !== row.textDir || row.linkDir === "") {
        offenders.push(`link=${row.linkDir} text=${row.textDir}`)
      }
      if (row.desc === "") offenders.push(`${row.linkDir}: empty description`)
    }
    expect(offenders).toEqual([])
  })

  test("the table lists exactly the tracked plugin directories", () => {
    expect([...new Set(rows.map((r) => r.linkDir))].sort()).toEqual(
      trackedPluginDirs,
    )
  })

  test("every plugin link points to a tracked README", () => {
    const trackedReadmes = gitLsFiles("plugins/*/README.md")
    for (const row of rows) {
      expect(trackedReadmes).toContain(`plugins/${row.linkDir}/README.md`)
    }
  })
})

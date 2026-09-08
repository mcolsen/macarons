import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Fires when a plugin is missing a KIND of protection its shape entails — the
 * actual decay mode this repo exhibits. cron shipped in PR #63 with unit tests
 * and 94-98% line coverage but no packaging.test.ts, and that missing test kind
 * is what let a misplaced runtime dependency (fixed in #80) ride green through
 * CI. A percentage gate reads that as excellent; this gate reads it as a hole.
 *
 * Keyed off `git ls-files`, never a filesystem listing. A directory under
 * plugins/ with no tracked package.json (a stray node_modules-only checkout)
 * does not exist in a fresh `actions/checkout`, so a glob-based version would be
 * green in CI and red only on a contributor's machine — the exact hidden
 * environment-dependence this file exists to forbid elsewhere.
 *
 * There is deliberately NO sdk-contract clause. Only some plugins ship one,
 * so requiring it would mean either writing six new contract tests (WP7 owns
 * that decision) or landing a six-entry allowlist on a thirteen-package repo —
 * a rubber stamp, the named-allowlist rot commit c5eabe0 removed from
 * tests/e2e/tsconfig.json. A gate with exceptions capped at zero is the point.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..")

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

type PackageJson = {
  scripts?: Record<string, string>
  exports?: Record<string, unknown>
}

type Plugin = {
  dir: string
  hasBuild: boolean
  hasTuiExport: boolean
}

function loadPlugins(): Plugin[] {
  return gitLsFiles("plugins/*/package.json").map((rel) => {
    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, rel), "utf8"),
    ) as PackageJson
    return {
      dir: path.basename(path.dirname(rel)),
      hasBuild: typeof pkg.scripts?.build === "string",
      hasTuiExport: Boolean(pkg.exports?.["./tui"]),
    }
  })
}

const plugins = loadPlugins()
const trackedTestFiles = new Set(gitLsFiles("plugins/*/test/*"))

function hasTestFile(dir: string, file: string): boolean {
  return trackedTestFiles.has(`plugins/${dir}/test/${file}`)
}

function testFileText(dir: string, file: string): string {
  return readFileSync(
    path.join(REPO_ROOT, "plugins", dir, "test", file),
    "utf8",
  )
}

const HARNESS = "@macarons/plugin-test-harness"
const HARNESS_TUI = `${HARNESS}/tui`

/**
 * The local names a file value-imports from `specifier`, keyed by the name the
 * module exports. `import type` is skipped (it vanishes at runtime, so it
 * cannot be what runs the assertions) and `{ orig as local }` maps to `local`,
 * which is what a call site would have to name.
 *
 * A bare substring search was the first spelling of the clauses below and it
 * accepted anything — a comment, a string literal, or a hand-rolled local
 * function of the same name. Pairing the import with the call is what makes
 * "uses the harness" mean the harness, not the spelling.
 */
function valueImports(text: string, specifier: string): Map<string, string> {
  const bound = new Map<string, string>()
  const statements = text.matchAll(
    // [^}]* spans newlines, so biome's multi-line import blocks parse too.
    /^import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/gm,
  )
  for (const [, typeOnly, clause, from] of statements) {
    if (typeOnly || from !== specifier || clause === undefined) continue
    for (const raw of clause.split(",")) {
      const parts = raw.trim().split(/\s+as\s+/)
      const [head, alias] = parts
      if (!head || head.startsWith("type ")) continue
      bound.set(head, alias ?? head)
    }
  }
  return bound
}

/** Imported from `specifier` under any name, and called under that name. */
function importsAndCalls(
  text: string,
  specifier: string,
  exported: string,
): boolean {
  const local = valueImports(text, specifier).get(exported)
  return local !== undefined && text.includes(`${local}(`)
}

describe("every tracked plugin carries the test kinds its shape entails", () => {
  test("the plugin roster is discovered off git, not vacuously empty", () => {
    // Guard the guard: a broken enumeration would pass every clause below by
    // iterating nothing. 12 plugins today; the floor keeps headroom so retiring
    // one is a clean diff rather than a false positive here.
    expect(plugins.length).toBeGreaterThanOrEqual(10)
  })

  test("has packaging.test.ts", () => {
    const missing = plugins
      .filter((p) => !hasTestFile(p.dir, "packaging.test.ts"))
      .map((p) => p.dir)
    expect(missing).toEqual([])
  })

  test("has bundle.test.ts iff it declares a build script", () => {
    // A plugin with a `build` script ships a bundled dist for the single-file
    // `.opencode/plugin/` install path; bundle.test.ts proves that artifact
    // stands alone. The "iff" also flags a bundle test left behind by a
    // dropped build script.
    const builders = plugins.filter((p) => p.hasBuild)
    expect(builders.length).toBeGreaterThan(0)
    const offenders = plugins
      .filter((p) => p.hasBuild !== hasTestFile(p.dir, "bundle.test.ts"))
      .map((p) => `${p.dir} (build=${p.hasBuild})`)
    expect(offenders).toEqual([])
  })

  test("has tui.test.ts iff it exports ./tui", () => {
    const tuiPlugins = plugins.filter((p) => p.hasTuiExport)
    expect(tuiPlugins.length).toBeGreaterThan(0)
    const offenders = plugins
      .filter((p) => p.hasTuiExport !== hasTestFile(p.dir, "tui.test.ts"))
      .map((p) => `${p.dir} (tui=${p.hasTuiExport})`)
    expect(offenders).toEqual([])
  })
})

// Presence alone rotted once already: the pre-harness scaffold was 14
// hand-rolled packaging copies, and nothing could detect one that quietly
// stopped asserting the loader contract, or a makeApi mock drifting from the
// real api surface (2026-07-23 audit §3). The harness is the single
// definition site for those assertions, so "uses the harness" is the shape
// check — a file that forks back to a hand-rolled copy fails here even
// though it still exists and still passes.
describe("scaffold test kinds run through the shared harness (issue #116)", () => {
  test("packaging tests import describePackaging from the harness and call it", () => {
    const offenders = plugins
      .filter((p) => hasTestFile(p.dir, "packaging.test.ts"))
      .filter(
        (p) =>
          !importsAndCalls(
            testFileText(p.dir, "packaging.test.ts"),
            HARNESS,
            "describePackaging",
          ),
      )
      .map((p) => p.dir)
    expect(offenders).toEqual([])
  })

  test("bundle tests import describeBundle from the harness and call it", () => {
    const offenders = plugins
      .filter((p) => hasTestFile(p.dir, "bundle.test.ts"))
      .filter(
        (p) =>
          !importsAndCalls(
            testFileText(p.dir, "bundle.test.ts"),
            HARNESS,
            "describeBundle",
          ),
      )
      .map((p) => p.dir)
    expect(offenders).toEqual([])
  })

  test("tui tests build their mock on the harness core", () => {
    // makeTuiApi specifically, not "mentions the ./tui entry": every migrated
    // tui.test.ts imports describeGating from that entry, so an entry-level
    // clause is satisfied before the mock is looked at — a plugin could swap
    // test/harness.ts back to a hand-rolled api mock, keep the describeGating
    // import, and stay green. That is exactly the makeApi-drift this clause
    // exists to catch, so the mock core is what gets named.
    //
    // Accepted in tui.test.ts itself or in the local test/harness.ts it imports
    // when a plugin wraps makeTuiApi with its own surface.
    const offenders = plugins
      .filter((p) => hasTestFile(p.dir, "tui.test.ts"))
      .filter((p) => {
        const text = testFileText(p.dir, "tui.test.ts")
        if (importsAndCalls(text, HARNESS_TUI, "makeTuiApi")) return false
        return !(
          valueImports(text, "./harness").size > 0 &&
          hasTestFile(p.dir, "harness.ts") &&
          importsAndCalls(
            testFileText(p.dir, "harness.ts"),
            HARNESS_TUI,
            "makeTuiApi",
          )
        )
      })
      .map((p) => p.dir)
    expect(offenders).toEqual([])
  })
})

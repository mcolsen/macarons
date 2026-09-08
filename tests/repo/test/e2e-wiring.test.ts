import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * An e2e journey runs in CI only through three hand-maintained lists that must
 * agree: the file must be named in an `e2e:<suite>` script, and that script must
 * be reached by a CI job — the e2e-server matrix, or the e2e:tui/standalone
 * jobs. Nothing cross-checks the links, and the worst failure mode in the
 * taxonomy hides here: a test that exists, is believed to run, and asserts
 * nothing because nothing ever invokes it.
 *
 * Three assertions close the loop:
 *  1. every e2e-server matrix `suite` names an existing `e2e:<suite>` script
 *     (the invariant the ci.yml comment already states in prose);
 *  2. every non-aggregate `e2e:<suite>` script is reached by a CI job — this is
 *     what catches an orphaned alias like the dead `e2e:cache-ratio` was;
 *  3. every *.e2e.test.ts file on disk is named by at least one script, so a
 *     newly added journey that nobody wires fails immediately rather than
 *     silently never running.
 *
 * The TUI assertions additionally pin which journeys are required versus
 * advisory, along with the CI job semantics that make that distinction real.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..")

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8")
}

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

const scripts =
  (
    JSON.parse(read("tests/e2e/package.json")) as {
      scripts?: Record<string, string>
    }
  ).scripts ?? {}

const ciText = read(".github/workflows/ci.yml")

/** The `suite:` list under the e2e-server matrix, parsed as a YAML block seq. */
function matrixSuites(): string[] {
  const lines = ciText.split("\n")
  // Anchor to the e2e-server job so an unrelated `suite:` key elsewhere cannot
  // be picked up, and tolerate blank lines and `# comments` inside the block
  // (both legal YAML, both routine edits) rather than truncating the list on
  // the first one.
  const jobStart = lines.findIndex((line) => /^\s*e2e-server:/.test(line))
  const suiteIdx = lines.findIndex(
    (line, i) =>
      i > (jobStart === -1 ? -1 : jobStart) &&
      /^\s*suite:\s*(#.*)?$/.test(line),
  )
  if (suiteIdx === -1) return []
  const suites: string[] = []
  for (const line of lines.slice(suiteIdx + 1)) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    const match = line.match(/^\s*-\s*([A-Za-z0-9-]+)\s*(#.*)?$/)
    if (!match?.[1]) break
    suites.push(match[1])
  }
  return suites
}

const suites = matrixSuites()

function ciJob(name: string): string {
  const lines = ciText.split("\n")
  const start = lines.indexOf(`  ${name}:`)
  if (start === -1) return ""
  const next = lines.findIndex(
    (line, index) =>
      index > start && /^ {2}[A-Za-z_][A-Za-z0-9_-]*:\s*(?:#.*)?$/.test(line),
  )
  return lines.slice(start, next === -1 ? undefined : next).join("\n")
}

function invokedE2eScripts(text: string): string[] {
  const commandText = text
    .split("\n")
    .filter((line) => /\brun:/.test(line) || /\bbun (run|test)\b/.test(line))
    .join("\n")
  return [...commandText.matchAll(/\be2e:[a-z0-9:-]+/g)].map(
    (match) => match[0],
  )
}

// Scripts a CI job invokes by name: the matrix expands `e2e:${{ matrix.suite }}`
// per suite, and the TUI jobs name their scripts literally.
// Only command lines are scanned for the literal tokens — a script name that
// appears solely in a YAML comment does not count as invoked, so it cannot mask
// an orphaned alias.
const ciInvoked = new Set<string>([
  ...suites.map((s) => `e2e:${s}`),
  ...invokedE2eScripts(ciText),
])

// Chains, not journeys: run locally to walk everything serially, never invoked
// as a unit in CI, so they are not expected to appear in ciInvoked.
const AGGREGATES = new Set(["e2e", "e2e:server"])

const e2eScriptKeys = Object.keys(scripts).filter((k) => /^e2e(:|$)/.test(k))

const TUI_CLASSIFICATION = {
  "e2e:tui:gating": [
    "codex-limits/tui.e2e.test.ts",
    "persist-permissions/remote-tui.e2e.test.ts",
    "persist-permissions/tui.e2e.test.ts",
    "synthetic-limits/tui.e2e.test.ts",
  ],
  "e2e:tui": [
    "background-tasks/poke.e2e.test.ts",
    "background-tasks/tui.e2e.test.ts",
    "btw/tui.e2e.test.ts",
    "cache-ratio/tui.e2e.test.ts",
    "approve-for-me/tui.e2e.test.ts",
  ],
} as const

/** `<dir>/…/<file>.e2e.test.ts` tokens named across every script body. */
function namedTestFiles(scriptKeys = Object.keys(scripts)): Set<string> {
  const tokens = new Set<string>()
  for (const key of scriptKeys) {
    const body = scripts[key]
    if (!body) continue
    // One or more path segments so a nested e2e file is captured whole, matching
    // the `tests/e2e/`-stripped on-disk path it is compared against.
    for (const match of body.matchAll(
      /(?:[\w.-]+\/)+[\w.-]+\.e2e\.test\.ts/g,
    )) {
      tokens.add(match[0])
    }
  }
  return tokens
}

describe("e2e journeys are wired from file to CI job", () => {
  test("the matrix and script lists parse to something", () => {
    expect(suites.length).toBeGreaterThan(0)
    expect(e2eScriptKeys.length).toBeGreaterThan(0)
  })

  test("every e2e-server matrix suite names an existing script", () => {
    const missing = suites.filter((s) => !(`e2e:${s}` in scripts))
    expect(missing).toEqual([])
  })

  test("every non-aggregate e2e script is reached by a CI job", () => {
    const orphans = e2eScriptKeys.filter(
      (key) => !AGGREGATES.has(key) && !ciInvoked.has(key),
    )
    expect(orphans).toEqual([])
  })

  test("keeps stable TUI journeys gating and timing-sensitive journeys advisory", () => {
    for (const [script, expected] of Object.entries(TUI_CLASSIFICATION)) {
      expect([...namedTestFiles([script])].sort()).toEqual([...expected].sort())
    }
  })

  test("keeps TUI job gating semantics and script routing", () => {
    const gating = ciJob("e2e-tui-gating")
    const advisory = ciJob("e2e-tui")

    expect(gating).not.toBe("")
    expect(gating).not.toMatch(/^[ \t]+continue-on-error:/m)
    expect(invokedE2eScripts(gating)).toEqual(["e2e:tui:gating"])

    expect(advisory).not.toBe("")
    expect(advisory).toMatch(
      /^ {4}continue-on-error:[ \t]*true[ \t]*(?:#.*)?$/m,
    )
    expect(invokedE2eScripts(advisory)).toEqual(["e2e:tui"])
  })

  test("every e2e test file on disk is named by at least one script", () => {
    const named = namedTestFiles()
    const onDisk = gitLsFiles("tests/e2e")
      .filter((f) => f.endsWith(".e2e.test.ts"))
      .map((f) => f.replace(/^tests\/e2e\//, ""))
    expect(onDisk.length).toBeGreaterThan(0)
    const unwired = onDisk.filter((f) => !named.has(f))
    expect(unwired).toEqual([])
  })
})

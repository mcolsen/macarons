import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Locks every OpenCode version knob to `.opencode-version` in the PR that moves
 * one of them, not weeks later when the nightly bump job's guard exits 1 on an
 * unwatched schedule.
 *
 * Without this invariant, three knobs can drift independently: the exact
 * `@opencode-ai/*` pins, the `engines.opencode` gate, and
 * SUPPORTED_OPENCODE_RANGE. Its floor is otherwise tested only against samples
 * the same parser derives from it, so a floor mutation moves the samples with
 * it and survives the suite. A caret sneaking into one `@opencode-ai` dep type-
 * checks and unit-tests green against a floating SDK while e2e runs the pinned
 * binary — a shape mismatch, not a crash.
 *
 * SUPPORTED_OPENCODE_RANGE's bounds are parsed here with an INDEPENDENT regex,
 * never by calling the library's own versionFloorFromRange — the whole point is
 * an anchor the parser cannot drag along with it.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..")
const LIBRARY_SRC_DIR = "libraries/permission-rules/src"

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

const LIBRARY_SOURCES = readdirSync(path.join(REPO_ROOT, LIBRARY_SRC_DIR))
  .filter((rel) => rel.endsWith(".ts"))
  .sort()
  .map((rel) => path.join(LIBRARY_SRC_DIR, rel))

/** Extract one `export const NAME = "value"` from the library sources. */
function sourceConstant(name: string): string {
  const matches = LIBRARY_SOURCES.flatMap((rel) => {
    const match = read(rel).match(
      new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`),
    )
    return match?.[1] ? [{ rel, value: match[1] }] : []
  })
  const match = matches[0]
  if (matches.length !== 1 || !match)
    throw new Error(
      `${name} must have exactly one definition in ${LIBRARY_SRC_DIR}; found ${matches.length}`,
    )
  return match.value
}

const PIN = read(".opencode-version").trim()
const SUPPORTED_OPENCODE_RANGE = sourceConstant("SUPPORTED_OPENCODE_RANGE")
const OPENCODE_ENGINE_RANGE = sourceConstant("OPENCODE_ENGINE_RANGE")

type PackageJson = {
  name?: string
  engines?: { opencode?: string }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function loadPackage(rel: string): PackageJson {
  return JSON.parse(read(rel)) as PackageJson
}

const workspacePackageFiles = gitLsFiles(
  "package.json",
  "plugins/*/package.json",
  "libraries/*/package.json",
  "tools/*/package.json",
  "tests/*/package.json",
)

describe("OpenCode version pins move in lockstep with .opencode-version", () => {
  test("the pin string is a concrete version", () => {
    expect(PIN).toMatch(/^\d+\.\d+\.\d+$/)
    expect(workspacePackageFiles.length).toBeGreaterThanOrEqual(10)
  })

  test("every @opencode-ai/* dependency is the exact pin, no ranges", () => {
    const offenders: string[] = []
    let checked = 0
    for (const rel of workspacePackageFiles) {
      const pkg = loadPackage(rel)
      for (const field of ["dependencies", "devDependencies"] as const) {
        for (const [dep, version] of Object.entries(pkg[field] ?? {})) {
          if (!dep.startsWith("@opencode-ai/")) continue
          checked++
          if (version !== PIN) {
            offenders.push(`${rel}: ${field}.${dep} is ${version}, want ${PIN}`)
          }
        }
      }
    }
    // Guard the guard: a walk that found zero @opencode-ai deps would pass
    // vacuously. There are well over a dozen across the workspace.
    expect(checked).toBeGreaterThan(10)
    expect(offenders).toEqual([])
  })

  test("every plugin declares engines.opencode === OPENCODE_ENGINE_RANGE", () => {
    const plugins = gitLsFiles("plugins/*/package.json")
    expect(plugins.length).toBeGreaterThanOrEqual(10)
    const offenders = plugins
      .filter(
        (rel) => loadPackage(rel).engines?.opencode !== OPENCODE_ENGINE_RANGE,
      )
      .map((rel) => `${rel}: ${loadPackage(rel).engines?.opencode}`)
    expect(offenders).toEqual([])
  })

  test("SUPPORTED_OPENCODE_RANGE floor is the pin and ceiling is its next minor", () => {
    // Parsed independently of the library so a broken versionFloorFromRange
    // cannot move this anchor along with the compat samples it feeds.
    const floor = SUPPORTED_OPENCODE_RANGE.match(/>=\s*(\d+\.\d+\.\d+)/)?.[1]
    const ceiling = SUPPORTED_OPENCODE_RANGE.match(/<\s*(\d+\.\d+\.\d+)/)?.[1]
    expect(floor).toBe(PIN)

    const [major, minor] = PIN.split(".").map(Number)
    expect(ceiling).toBe(`${major}.${(minor ?? 0) + 1}.0`)
  })

  test(".opencode-checksums.json records the pinned version", () => {
    const checksums = JSON.parse(read(".opencode-checksums.json")) as {
      version?: string
    }
    expect(checksums.version).toBe(PIN)
  })
})

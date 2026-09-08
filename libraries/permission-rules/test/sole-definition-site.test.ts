import { describe, expect, test } from "bun:test"
import type { Dirent } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

/**
 * The suite-wide sole-definition-site guard (issue #37).
 *
 * The 2026-07 audit's M5 finding was two plugins carrying private,
 * comment-for-comment copies of this library's trust-boundary helpers — so a
 * symlink-escape fix applied here would silently not have reached them, and
 * no test caught the drift. The forks are gone; this guard keeps them gone,
 * for every helper the suite shares, across every plugin.
 *
 * plugins/persist-permissions/test/matching-spec.test.ts carries the original,
 * finer-grained guard for the matching ENGINE (it also pins the re-export
 * mechanics its behavior tables depend on). This sweep is the coarse suite-wide
 * complement: no plugin source file may declare its own function or const
 * binding under any shared helper's name — a private copy must fail loudly,
 * whatever package it appears in.
 *
 * The PR #65 review hardened the sweep against three ways it could rot:
 * the helper roster is derived from the library's exports instead of a
 * hand-list that omitted readStore, isAllowed & co.; the walk fails loudly
 * and must cover every plugin package instead of shrinking silently; and the
 * logger tripwire rejects any raw app.log access, not one bind idiom.
 *
 * The 2026-07-23 audit (issue #118) found the drift was exactly where this
 * guard could not see: the sweep walked `plugins/*` only, and `tools/installer`
 * had forked two library helpers (`pathExists`, `writeTextFile`) without even
 * depending on the library — a blind spot the name-matching sweep could never
 * surface. The sweep now covers `tools/*` too, and adds two idiom tripwires
 * (the toast bind and the timer `.unref` call) modeled on the existing
 * raw-`app.log` rule. A future workspace root that ships runtime source must be
 * added to the sweep here deliberately; until it is, its source is unguarded.
 */

// The helper roster is every function or const the library exports — derived
// across its private source modules, not hand-maintained, so promoting a helper
// extends the guard automatically after an internal split too.
const librarySources = await Promise.all(
  (await fs.readdir(path.join(import.meta.dir, "..", "src")))
    .filter((file) => /\.ts$/.test(file))
    .sort()
    .map((file) =>
      fs.readFile(path.join(import.meta.dir, "..", "src", file), "utf8"),
    ),
)
const HELPERS = [
  ...new Set(
    librarySources.flatMap((source) =>
      [
        ...source.matchAll(
          /^export (?:async )?(?:function|const) ([A-Za-z_$][\w$]*)/gm,
        ),
      ].map((m) => m[1] as string),
    ),
  ),
]

// The one file allowed to carry each listed name. An exception is a reviewed
// decision that the binding is NOT a fork of the library helper — anything
// else must pick its own name (see viewedSessionID in the TUIs, or
// readActiveStore in persist-permissions).
const EXCEPTIONS: { helper: string; file: string; reason: string }[] = []

const repoRoot = path.join(import.meta.dir, "..", "..", "..")
const pluginsDir = path.join(repoRoot, "plugins")
const toolsDir = path.join(repoRoot, "tools")

// Every workspace member under a given root (the workspaces glob matches
// directories with a package.json). A failure to list the root itself fails
// the whole suite — an empty sweep must never look like a passing one.
async function packagesUnder(root: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = await fs
      .stat(path.join(root, entry.name, "package.json"))
      .catch(() => undefined)
    if (manifest?.isFile()) out.push(entry.name)
  }
  return out
}

// Records carry the repo-relative root label ("plugins"/"tools") so error
// messages name where a file lives; the absolute `file` is what the regex
// assertions print.
async function sourceFilesOf(
  root: string,
  rootLabel: string,
  name: string,
): Promise<
  { rootLabel: string; name: string; file: string; source: string }[]
> {
  const out: {
    rootLabel: string
    name: string
    file: string
    source: string
  }[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      // Only a missing src/ is tolerable here — the coverage assertion below
      // still fails for it. Any other error must fail the sweep, not shrink it.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (/\.tsx?$/.test(entry.name))
        out.push({
          rootLabel,
          name,
          file: absolute,
          source: await fs.readFile(absolute, "utf8"),
        })
    }
  }
  await walk(path.join(root, name, "src"))
  return out
}

const pluginPackages = await packagesUnder(pluginsDir)
const toolPackages = await packagesUnder(toolsDir)
const packages = [
  ...pluginPackages.map((name) => ({ root: "plugins", name })),
  ...toolPackages.map((name) => ({ root: "tools", name })),
]
const files = (
  await Promise.all([
    ...pluginPackages.map((name) => sourceFilesOf(pluginsDir, "plugins", name)),
    ...toolPackages.map((name) => sourceFilesOf(toolsDir, "tools", name)),
  ])
).flat()

describe("the permission-rules library is the sole definition site of every shared helper", () => {
  test("the helper roster derivation actually parsed the library", () => {
    // If the export idiom in any source module ever drifts from what the roster
    // regex expects, the sweep must fail rather than guard a shrunken list.
    expect(HELPERS.length).toBeGreaterThanOrEqual(40)
    expect(HELPERS).toEqual(
      expect.arrayContaining([
        "appLogger",
        "canonicalPath",
        "isAllowed",
        "narrowestPatterns",
        "pathExists",
        "readStore",
        "resolvePermissionStorePaths",
        "wildcardMatch",
      ]),
    )
  })

  test("the sweep covers every plugin and tool package", () => {
    // A broken walk of EITHER root must fail loudly, never shrink silently —
    // the 2026-07-23 audit's blind spot was a root this sweep did not walk.
    // ≥ the 12 plugin packages at the time of writing; ≥ the 1 tool package
    // (tools/installer). Removing one is a loud, deliberate roster update; a
    // broken walk is not.
    expect(pluginPackages.length).toBeGreaterThanOrEqual(12)
    expect(toolPackages.length).toBeGreaterThanOrEqual(1)
    const covered = [
      ...new Set(files.map(({ rootLabel, name }) => `${rootLabel}/${name}`)),
    ].sort()
    const expected = packages.map(({ root, name }) => `${root}/${name}`).sort()
    expect(covered).toEqual(expected)
  })

  test("every plugin and tool entrypoint lives inside the scanned source set", async () => {
    // The sweep reads .ts/.tsx under src/ — this pins that layout, so moving
    // sources (or shipping compiled entrypoints) fails here instead of
    // silently leaving the moved files unscanned. A package's entrypoints are
    // read from its manifest's `exports`, `main`, AND `bin` (the installer's
    // only entrypoint is `"bin": "./src/cli.ts"`; it has no exports/main).
    const entryValues = (value: unknown): string[] =>
      typeof value === "string"
        ? [value]
        : value && typeof value === "object"
          ? Object.values(value).flatMap(entryValues)
          : []
    for (const { root, name } of packages) {
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(
            root === "plugins" ? pluginsDir : toolsDir,
            name,
            "package.json",
          ),
          "utf8",
        ),
      )
      const entries = entryValues(manifest.exports).concat(
        entryValues(manifest.main),
        entryValues(manifest.bin),
      )
      expect(
        entries.length,
        `${root}/${name} exposes no entrypoints`,
      ).toBeGreaterThan(0)
      for (const entry of entries) {
        expect(
          entry,
          `${root}/${name} entrypoint ${entry} is outside the swept src/ tree`,
        ).toMatch(/^\.\/src\/.+\.tsx?$/)
      }
    }
  })

  test("every exception is live", () => {
    // A stale exception is a hole: it exempts a file from a check it no
    // longer needs exempting from.
    for (const exception of EXCEPTIONS) {
      expect(HELPERS).toContain(exception.helper)
      const record = files.find(
        ({ file }) => file === path.join(repoRoot, exception.file),
      )
      expect(record, `${exception.file} is not in the sweep`).toBeDefined()
      expect(record?.source).toMatch(
        new RegExp(`\\b(?:const|let|var) ${exception.helper}\\b`),
      )
    }
  })

  for (const helper of HELPERS) {
    const allowed = new Set(
      EXCEPTIONS.filter((e) => e.helper === helper).map((e) =>
        path.join(repoRoot, e.file),
      ),
    )
    test(`${helper}: defined in the library, forked nowhere`, () => {
      for (const { file, source } of files) {
        if (allowed.has(file)) continue
        // Every declaration shape a fork would take, type annotations
        // included. A wrapper is fine — it must just pick its own name.
        expect(source, `${file} declares a private ${helper}`).not.toMatch(
          new RegExp(
            `\\bfunction ${helper}\\s*\\(|\\b(?:const|let|var) ${helper}\\b[^=\\n]*=[^=]`,
          ),
        )
      }
    })
  }

  test("no plugin touches the raw SDK app logger", () => {
    // appLogger owns the one bound call, missing-logger handling, and the
    // boolean compatibility reporting keys off. Any raw app.log member access
    // — client.app.log(...), app?.log?.bind(...) — is a reimplementation
    // seed, whatever idiom it takes; a plugin needing app.log goes through
    // appLogger.
    for (const { file, source } of files) {
      expect(source, `${file} accesses app.log directly`).not.toMatch(
        /\bapp\s*\??\.\s*log\b/,
      )
    }
  })

  test("no plugin or tool calls the SDK toast endpoint directly", () => {
    // serverToast (src/compat.ts) owns the one client.tui.showToast bind +
    // {query:{directory}} + swallow-all — the suite's most-copied idiom
    // (audit 2026-07-23 §2.2 found seven hand-copies). A raw tui.showToast
    // access is a reimplementation seed whatever name the wrapper picks, and
    // this is exactly what catches the renamed re-forks the name-matching
    // sweep above cannot. A caller needing a toast goes through serverToast.
    // Matching comments too is deliberate, same as the app.log rule: a
    // comment naming the pattern is provenance for a copy.
    for (const { file, source } of files) {
      expect(source, `${file} calls tui.showToast directly`).not.toMatch(
        /\btui\s*\??\.\s*showToast\b/,
      )
    }
  })

  test("no plugin or tool calls .unref() directly outside the library", () => {
    // unrefTimer / every (src/async.ts) own the one optional `.unref?.()` call
    // — optional because test doubles lack `unref`, which is the hardening a
    // direct member access loses (subagent-comms had hand-rolled
    // `(poller as unknown as { unref?: () => void }).unref?.()`, a renamed
    // re-fork of exactly this helper). Any direct `.unref` / `.unref?.` member
    // access re-implements it; go through unrefTimer / every. The
    // regex does not match `unrefTimer(` (no dot before it).
    for (const { file, source } of files) {
      expect(source, `${file} calls .unref() directly`).not.toMatch(
        /\.\s*unref(\s*\?\s*\.)?\s*\(/,
      )
    }
  })
})

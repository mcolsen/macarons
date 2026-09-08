import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Checks the packaging/config boilerplate the 2026-07-23 audit (§3) found
 * drifting with no invariant holding it: the devDependency names required by
 * each plugin shape, and two tsconfig shapes (server / TUI) that are now shared
 * presets (`tsconfig.server.json` / `tsconfig.tui.json` at the repo root, both
 * extending `tsconfig.base.json`). Dependency versions remain manifest and
 * package-manager concerns and are deliberately not duplicated here.
 *
 * Pre-audit, one tsconfig carried an unexplained shape outlier (§2.8.6) that
 * was invisible until the audit — exactly the kind of silent drift a shape
 * preset now forces to become an explicit, reviewed opt-out. Any opt-out must
 * land here as a small, reviewed, reasoned allowlist entry. A near-total
 * allowlist is a rubber stamp, so the opt-out tables are capped at a small,
 * reviewed size and every entry is kept live against the default shape.
 *
 * The devDep uniformity block has one shape-driven split worth flagging so a
 * future reader doesn't "simplify" it away: the bare `@opencode-ai/plugin`
 * specifier is in BASE_DEV_DEPS, but a plugin that value-imports it must carry
 * it in `dependencies` instead (the installer loads plugin `src` directly, so a
 * devDep a consumer install drops loads under workspace hoisting and fails
 * on a real `opencode plugin install` — the trap runtime-deps.test.ts guards,
 * which already bit cron). The minus-runtime-deps rule encodes that split.
 * One named opt-out removes a key a plugin genuinely doesn't use:
 * redact-secrets imports @opencode-ai/sdk nowhere, so it drops that package.
 *
 * Enumerated off `git ls-files`, never a filesystem glob — untracked debris
 * under plugins/ must not flip the verdict (a hard repo convention; a stray
 * checkout is invisible to actions/checkout and would be green in CI, red
 * only on a contributor's machine, the hidden environment-dependence this
 * file forbids elsewhere).
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

type PackageJson = {
  exports?: Record<string, unknown>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  workspaces?: string[]
}

type TsConfig = {
  extends?: string
  compilerOptions?: Record<string, unknown>
  include?: string[]
  exclude?: string[]
}

function loadPackage(rel: string): PackageJson {
  // Plain JSON today; if one ever gains comments, failing here loudly is
  // correct rather than silently accommodating the drift.
  return JSON.parse(read(rel)) as PackageJson
}

function loadTsConfig(rel: string): TsConfig {
  return JSON.parse(read(rel)) as TsConfig
}

const BASE_DEV_DEPS = [
  "@biomejs/biome",
  "@macarons/plugin-test-harness",
  "@opencode-ai/plugin",
  "@opencode-ai/sdk",
  "@types/bun",
  "@types/node",
  "typescript",
]

const TUI_EXTRA_DEV_DEPS = [
  "@opentui/core",
  "@opentui/keymap",
  "@opentui/solid",
  "solid-js",
]

// Named, reasoned opt-outs from the uniform devDep shape above. Each removes
// keys that would otherwise be expected for that plugin but that it does not
// use, so an unused package is not demanded. Capped at exactly one by the
// liveness test below — a second cannot slip in as a drive-by, and a dead entry
// (one that no longer opts anything out, or that names a plugin now carrying
// the key) fails.
const DEV_DEP_OPT_OUTS: Record<string, { remove: string[]; reason: string }> = {
  "redact-secrets": {
    remove: ["@opencode-ai/sdk"],
    reason:
      "imports @opencode-ai/sdk nowhere in tracked sources, so the package would be unused",
  },
}

const pluginPackages = gitLsFiles("plugins/*/package.json")
const workspacePatterns = loadPackage("package.json").workspaces ?? []
const workspacePackages = workspacePatterns.length
  ? gitLsFiles(...workspacePatterns.map((pattern) => `${pattern}/package.json`))
  : []
const nonPluginTsConfigCandidates = workspacePackages
  .filter((rel) => !rel.startsWith("plugins/"))
  .map((rel) => `${path.posix.dirname(rel)}/tsconfig.json`)
const nonPluginWorkspaceTsconfigs = nonPluginTsConfigCandidates.length
  ? gitLsFiles(...nonPluginTsConfigCandidates)
  : []

type Plugin = {
  dir: string
  pkgRel: string
  tsRel: string
  pkg: PackageJson
  hasTui: boolean
}

function loadPlugins(): Plugin[] {
  return pluginPackages.map((rel) => {
    const pkg = loadPackage(rel)
    const dir = path.basename(path.dirname(rel))
    return {
      dir,
      pkgRel: rel,
      tsRel: `plugins/${dir}/tsconfig.json`,
      pkg,
      hasTui: Boolean(pkg.exports?.["./tui"]),
    }
  })
}

const plugins = loadPlugins()

describe("plugin tsconfigs extend the preset matching their shape", () => {
  test("the plugin roster is discovered off git, not vacuously empty", () => {
    // Guard the guard: a broken enumeration would pass every clause below by
    // iterating nothing. 12 plugins today; the floor keeps headroom.
    expect(plugins.length).toBeGreaterThanOrEqual(10)
  })

  test("each plugin tsconfig extends the right preset with only `include` allowed to differ", () => {
    // redact-secrets typechecks a scripts/ directory, so its include is the
    // one explicit opt-out. Modelled as a tiny allowlist with a reason, and
    // kept live: an entry naming a plugin whose tsconfig already matches the
    // default shape fails the liveness check below, so the allowlist cannot
    // rot into a rubber stamp.
    const INCLUDE_OPT_OUTS: Record<
      string,
      { include: string[]; reason: string }
    > = {
      "redact-secrets": {
        include: ["src", "test", "scripts"],
        reason: "typechecks a scripts/ directory",
      },
    }

    const offenders: string[] = []
    for (const p of plugins) {
      const ts = loadTsConfig(p.tsRel)
      const expectedExtends = p.hasTui
        ? "../../tsconfig.tui.json"
        : "../../tsconfig.server.json"
      const defaultInclude = ["src", "test"]
      const optOut = INCLUDE_OPT_OUTS[p.dir]
      const expectedInclude = optOut?.include ?? defaultInclude

      const expected: TsConfig = {
        extends: expectedExtends,
        include: expectedInclude,
      }

      const actualKeys = Object.keys(ts).sort()
      const expectedKeys = Object.keys(expected).sort()
      if (
        actualKeys.length !== expectedKeys.length ||
        actualKeys.some((k, i) => k !== expectedKeys[i])
      ) {
        offenders.push(
          `${p.dir}: top-level keys [${actualKeys.join(", ")}], want [${expectedKeys.join(", ")}]`,
        )
        continue
      }
      if (ts.extends !== expected.extends) {
        offenders.push(
          `${p.dir}: extends ${ts.extends}, want ${expected.extends}`,
        )
      }
      const actualInclude = ts.include ?? []
      if (
        actualInclude.length !== expectedInclude.length ||
        actualInclude.some((v, i) => v !== expectedInclude[i])
      ) {
        offenders.push(
          `${p.dir}: include [${actualInclude.join(", ")}], want [${expectedInclude.join(", ")}]`,
        )
      }
    }
    expect(offenders).toEqual([])

    // Every opt-out is live: an entry naming a plugin whose tsconfig already
    // matches the default shape would be dead weight — exactly the rubber
    // stamp the issue says to forbid. The default shape here is `include:
    // ["src","test"]` with no `compilerOptions`, so an opt-out that does not
    // change `include` (or adds nothing the default doesn't already have) is
    // dead.
    const deadOptOuts = Object.entries(INCLUDE_OPT_OUTS)
      .filter(([, opt]) => {
        const def = ["src", "test"]
        return (
          opt.include.length === def.length &&
          opt.include.every((v, i) => v === def[i])
        )
      })
      .map(([dir]) => dir)
    expect(deadOptOuts).toEqual([])
  })
})

describe("non-plugin workspace tsconfigs are pinned to their reviewed shape", () => {
  // Allowlist-with-reasons: each entry is the full expected shape, so a drift
  // in any key (extends, types, include) fails here rather than silently.
  const EXPECTED: Record<string, { shape: TsConfig; reason: string }> = {
    "libraries/permission-rules": {
      shape: {
        extends: "../../tsconfig.server.json",
        compilerOptions: { types: ["bun"] },
        include: ["src", "test"],
      },
      reason: "library package, server preset, bun types",
    },
    "libraries/plugin-test-harness": {
      shape: {
        extends: "../../tsconfig.server.json",
        compilerOptions: { types: ["bun"] },
        include: ["src", "test"],
      },
      reason: "dev-only harness, server preset, bun types",
    },
    "libraries/usage-limits": {
      shape: {
        extends: "../../tsconfig.server.json",
        compilerOptions: { types: ["bun"] },
        include: ["src", "test"],
      },
      reason: "headless limits engine, server preset, bun types",
    },
    "tools/installer": {
      shape: {
        extends: "../../tsconfig.server.json",
        compilerOptions: { types: ["bun", "node"] },
        include: ["src", "test"],
      },
      reason: "installer tool, server preset, bun+node types",
    },
    "tests/e2e": {
      shape: {
        extends: "../../tsconfig.server.json",
        compilerOptions: { types: ["bun", "node"] },
        include: ["**/*.ts", "**/*.tsx"],
        exclude: ["node_modules", "artifacts"],
      },
      reason: "end-to-end workspace, server preset, bun+node types",
    },
    "tests/repo": {
      shape: {
        extends: "../../tsconfig.server.json",
        compilerOptions: { types: ["bun"] },
        include: ["test"],
      },
      reason: "repository-invariant tests, server preset, bun types",
    },
  }

  test("the shape table covers every non-plugin workspace tsconfig", () => {
    // Guard the guard: derive the roster from the root workspace declarations
    // so a new non-plugin workspace cannot silently escape this table.
    const expectedDirs = Object.keys(EXPECTED).sort()
    const discoveredDirs = nonPluginWorkspaceTsconfigs
      .map((rel) => path.posix.dirname(rel))
      .sort()
    expect(expectedDirs.length).toBeGreaterThan(0)
    expect(expectedDirs).toEqual(discoveredDirs)
  })

  test("each non-plugin tsconfig matches its table entry exactly", () => {
    for (const [dir, { shape: expected }] of Object.entries(EXPECTED)) {
      expect(loadTsConfig(`${dir}/tsconfig.json`), dir).toEqual(expected)
    }
  })
})

describe("plugin devDependency names match their shape", () => {
  test("the plugin roster is discovered off git, not vacuously empty", () => {
    // Guard the guard: this clause checks ≥10 plugins so a broken walk that
    // found zero plugins cannot pass the devDep uniformity check vacuously.
    expect(plugins.length).toBeGreaterThanOrEqual(10)
  })

  test("the opt-out table is capped at one live entry", () => {
    // A near-total allowlist is a rubber stamp (the issue's guardrail), so the
    // table is pinned at exactly one and each entry must be live: the removed
    // keys must otherwise be expected for that plugin (applying the opt-out
    // changes its expected set), AND the plugin must still actually lack
    // those keys in devDependencies. An opt-out that no longer opts anything
    // out, or that names a plugin now carrying the key, fails here — so the
    // allowlist cannot rot the way a named allowlist silently did in
    // tests/e2e/tsconfig.json (commit c5eabe0).
    expect(Object.keys(DEV_DEP_OPT_OUTS)).toHaveLength(1)

    const byDir = new Map(plugins.map((p) => [p.dir, p]))
    const dead: string[] = []
    for (const [dir, opt] of Object.entries(DEV_DEP_OPT_OUTS)) {
      const p = byDir.get(dir)
      if (!p) {
        dead.push(`${dir}: not a tracked plugin`)
        continue
      }
      // The keys an opt-out removes must otherwise be expected: present in
      // BASE_DEV_DEPS + (hasTui ? TUI_EXTRA_DEV_DEPS : []) and not already
      // subtracted by the runtime-deps rule. Compute the pre-opt-out expected
      // set the same way the shape test does.
      const runtimeDeps = new Set(Object.keys(p.pkg.dependencies ?? {}))
      const preOptOut = new Set<string>()
      for (const k of BASE_DEV_DEPS) {
        if (!runtimeDeps.has(k)) preOptOut.add(k)
      }
      if (p.hasTui) {
        for (const k of TUI_EXTRA_DEV_DEPS) {
          if (!runtimeDeps.has(k)) preOptOut.add(k)
        }
      }
      const removesChange =
        opt.remove.length > 0 && opt.remove.every((k) => preOptOut.has(k))
      if (!removesChange) {
        dead.push(
          `${dir}: remove [${opt.remove.join(", ")}] not otherwise expected`,
        )
        continue
      }
      // The plugin must still actually lack every removed key in devDeps.
      const dev = p.pkg.devDependencies ?? {}
      const nowCarries = opt.remove.filter((k) => k in dev)
      if (nowCarries.length) {
        dead.push(
          `${dir}: now carries [${nowCarries.join(", ")}] in devDependencies`,
        )
      }
    }
    expect(dead).toEqual([])
  })

  test("every plugin devDependencies block contains the expected names", () => {
    const offenders: string[] = []
    let checked = 0
    for (const p of plugins) {
      checked++
      const runtimeDeps = new Set(Object.keys(p.pkg.dependencies ?? {}))
      // Expected = BASE_DEV_DEPS + (hasTui ? TUI_EXTRA_DEV_DEPS : [])
      // minus runtime deps and the explicit opt-out.
      // The minus-runtime-deps rule is load-bearing and applies to every key,
      // not just TUI_EXTRA: the installer loads plugin `src` directly
      // (pathToFileURL into this checkout), so a runtime VALUE import of the
      // bare `@opencode-ai/plugin` specifier must be a real `dependency`, not a
      // devDependency a consumer install drops — the trap runtime-deps.test.ts
      // documents (cron already shipped it wrong: green under workspace
      // hoisting, red only on a real `opencode plugin install`). So
      // `@opencode-ai/plugin` splits across deps/devDeps by import shape, and a
      // key carried in `dependencies` is not also demanded in `devDependencies`.
      // Do NOT "simplify" this minus-deps rule away.
      const expected = new Set<string>()
      for (const k of BASE_DEV_DEPS) {
        if (!runtimeDeps.has(k)) expected.add(k)
      }
      if (p.hasTui) {
        for (const k of TUI_EXTRA_DEV_DEPS) {
          if (!runtimeDeps.has(k)) expected.add(k)
        }
      }
      const optOut = DEV_DEP_OPT_OUTS[p.dir]
      if (optOut) {
        for (const k of optOut.remove) expected.delete(k)
      }
      const dev = p.pkg.devDependencies ?? {}

      // Missing: an expected key absent from devDependencies.
      for (const k of expected) {
        if (!(k in dev)) {
          offenders.push(`${p.dir}: missing devDependencies.${k}`)
        }
      }

      // Extra: a devDependency beyond the expected set. Intra-suite workspace
      // dependencies are a sanctioned shape, so any /^@macarons\//
      // key with value `workspace:*` is allowed without a growing named
      // allowlist that would rubber-stamp drift.
      for (const [k, v] of Object.entries(dev)) {
        if (expected.has(k)) continue
        if (/^@macarons\//.test(k) && v === "workspace:*") continue
        offenders.push(`${p.dir}: extra devDependencies.${k} = ${v}`)
      }
    }
    // Guard the guard: reaffirm the walk checked the fleet, not nothing.
    expect(checked).toBeGreaterThanOrEqual(10)
    expect(offenders).toEqual([])
  })
})

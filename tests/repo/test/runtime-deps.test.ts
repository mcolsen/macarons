import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import path from "node:path"
import ts from "@typescript/typescript6"

/**
 * The installer loads plugin `src` directly — `pathToFileURL(serverEntry)` into
 * this checkout — so a runtime VALUE import of a bare specifier must be a real
 * `dependency`, not a `devDependency` that a consumer install drops. That trap
 * already bit cron: `import { tool } from "@opencode-ai/plugin"` with the
 * package in devDependencies loads fine under workspace hoisting (unit tests,
 * typecheck, and the cron e2e all stay green) and fails only on a real
 * `opencode plugin install`. It is pinned per-plugin in each packaging.test.ts;
 * cron had none, so for cron it was pinned nowhere. This is the repo-wide guard.
 *
 * The check discriminates VALUE imports (and `export … from` re-exports) from
 * TYPE-ONLY ones — an `import type` (or an all-`type` named list) carries no
 * runtime dependency and may stay in devDependencies. Host-provided peers the
 * OpenCode runtime injects into a plugin's module scope are exempt from the
 * dependency requirement:
 *   - any `@opencode-ai/*` specifier EXCEPT the bare `@opencode-ai/plugin`
 *     (so `@opencode-ai/plugin/tui`, `@opencode-ai/sdk[/…]` are exempt), plus
 *     the TUI render runtime `solid-js` / `@opentui/*` — every TUI half
 *     value-imports these and keeps them in devDependencies, uniformly.
 * The bare `@opencode-ai/plugin` specifier is NOT exempt: it is the server-half
 * import the installer's load path cannot resolve from devDependencies, and the
 * one cron got wrong.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..")
const BUILTINS = new Set(builtinModules)

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

function packageNameOf(specifier: string): string {
  if (specifier.startsWith("@"))
    return specifier.split("/").slice(0, 2).join("/")
  return specifier.split("/")[0] ?? specifier
}

/**
 * Packages the OpenCode host injects at load time, so a plugin may keep them in
 * devDependencies. `@opencode-ai/plugin` bare is deliberately excluded — the
 * server-load path must resolve it from the plugin's own dependencies.
 */
function isHostProvided(specifier: string, pkg: string): boolean {
  if (pkg === "solid-js" || pkg.startsWith("@opentui/")) return true
  return pkg.startsWith("@opencode-ai/") && specifier !== "@opencode-ai/plugin"
}

/** True when the import statement introduces at least one runtime binding. */
function isValueImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (!clause) return true // `import "x"` — a side-effecting runtime import
  if (clause.isTypeOnly) return false
  if (clause.name) return true // default binding is a value
  const bindings = clause.namedBindings
  if (!bindings) return false
  if (ts.isNamespaceImport(bindings)) return true // `import * as x`
  return bindings.elements.some((element) => !element.isTypeOnly)
}

/**
 * The bare specifier a statement pulls in at RUNTIME, or undefined for a
 * type-only / non-module statement. Covers `import …`, side-effect `import "x"`,
 * and `export … from "x"` re-exports (a runtime value dependency too).
 */
function runtimeSpecifier(statement: ts.Statement): string | undefined {
  if (ts.isImportDeclaration(statement)) {
    if (!ts.isStringLiteral(statement.moduleSpecifier)) return undefined
    return isValueImport(statement) ? statement.moduleSpecifier.text : undefined
  }
  if (ts.isExportDeclaration(statement)) {
    const spec = statement.moduleSpecifier
    if (!spec || !ts.isStringLiteral(spec)) return undefined // not `export … from`
    if (statement.isTypeOnly) return undefined // `export type … from`
    const clause = statement.exportClause
    // `export { type A, b } from "x"` is a value re-export iff some named
    // element is not type-only; `export * from "x"` (no clause) always is.
    if (clause && ts.isNamedExports(clause)) {
      if (!clause.elements.some((element) => !element.isTypeOnly))
        return undefined
    }
    return spec.text
  }
  return undefined
}

/**
 * A required-dependency edge: plugin `dir`'s runtime import of bare `pkg` in
 * `file`, which must therefore appear in that plugin's `dependencies`.
 */
type Requirement = { dir: string; pkg: string; file: string }

function requirementsFor(dir: string): Requirement[] {
  const out: Requirement[] = []
  const files = gitLsFiles(`plugins/${dir}/src`).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".tsx"),
  )
  for (const file of files) {
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8")
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.ESNext,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    for (const statement of source.statements) {
      const specifier = runtimeSpecifier(statement)
      if (specifier === undefined) continue
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue
      const pkg = packageNameOf(specifier)
      if (BUILTINS.has(pkg)) continue
      if (isHostProvided(specifier, pkg)) continue
      out.push({ dir, pkg, file })
    }
  }
  return out
}

const pluginDirs = gitLsFiles("plugins/*/package.json").map((rel) =>
  path.basename(path.dirname(rel)),
)

function dependenciesOf(dir: string): Record<string, string> {
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "plugins", dir, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> }
  return pkg.dependencies ?? {}
}

const requirements = pluginDirs.flatMap(requirementsFor)

describe("runtime value imports are declared as real dependencies", () => {
  test("the import scan actually found the load-bearing runtime imports", () => {
    // Guard the guard: a parser that stopped detecting value imports would make
    // every plugin pass vacuously. Pin the two exemplars the installer trap
    // turns on — cron's server-half `tool` import and its third-party croner.
    expect(requirements.length).toBeGreaterThanOrEqual(8)
    const cron = requirements.filter((r) => r.dir === "cron").map((r) => r.pkg)
    expect(cron).toContain("@opencode-ai/plugin")
    expect(cron).toContain("croner")
  })

  test("every value-imported bare package is in that plugin's dependencies", () => {
    const offenders: string[] = []
    for (const { dir, pkg, file } of requirements) {
      if (!(pkg in dependenciesOf(dir))) {
        offenders.push(
          `${file}: value-imports ${pkg} but it is not a dependency`,
        )
      }
    }
    expect([...new Set(offenders)]).toEqual([])
  })
})

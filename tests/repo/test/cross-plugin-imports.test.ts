import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "@typescript/typescript6"

/**
 * Cross-plugin imports are reviewed exceptions, not routine wiring (2026-07-23
 * audit §2.7, issue #114).
 *
 * Shared package APIs live under libraries/. A plugin importing another
 * plugin sits outside those reviewed library surfaces. The permission-rules
 * sole-definition-site guard keeps every promoted helper single-sourced, but
 * cross-plugin interop sits in that guard's blind spot: nothing
 * tracked the surface, so when approve-for-me moved its global settings onto
 * the opencode.json[c] plugin entry (PR #139), the old limits plugin's copy
 * of the old settings pipeline kept reading the retired file and nothing
 * failed. This sweep is the tripwire: every cross-plugin import in runtime
 * sources must be on the allowlist below, pinned to the exact importing file
 * and the exact entrypoint, so a new one — or a widened one — fails loudly
 * until it is reviewed as a deliberate interop surface (and the producer
 * grows one, like approve-for-me's ./interop). The scan reads every
 * module-load form it can see — static imports, `export … from`, dynamic
 * `import()`, `require()`, template-literal arguments — resolves relative
 * specifiers against the importing package, and fails on loads it cannot
 * analyze rather than passing them silently (PR #142 review F3/F4).
 *
 * Scope: `src/` of every plugin and tool — the runtime dependency surface.
 * Test files may import a sibling for FIXTURES (writing the producer's files
 * via the producer's own path helpers is what keeps fixtures from drifting);
 * the runtime wiring they exercise still goes through the allowlisted
 * entrypoint. Imports of the shared library and of a package's own name are
 * not cross-plugin imports.
 */

const ALLOWED = [
  {
    importer: path.join("plugins", "codex-limits", "src", "tui.tsx"),
    specifier: "@macarons/approve-for-me/interop",
    reason:
      "Codex limits show classifier usage; ./interop is approve-for-me's deliberate sibling API, answered by its own settings chain (issue #114)",
  },
  {
    importer: path.join("plugins", "synthetic-limits", "src", "tui.tsx"),
    specifier: "@macarons/approve-for-me/interop",
    reason:
      "Synthetic limits show classifier usage through the same reviewed approve-for-me interop surface",
  },
]

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..")

function gitLsFiles(...patterns: string[]): string[] {
  // :(glob) pathspec magic: a single `*` must not match across `/`, or git's
  // default (which crosses slashes) would let a nested package.json
  // masquerade as a top-level package.
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

type ScannedModuleLoads = {
  specifiers: string[]
  /** `file:line` of every dynamic `import()`/`require()` whose argument is
   *  not a literal — a load the scan cannot classify, which must fail loudly
   *  rather than pass as "not cross-plugin" (PR #142 review F4). */
  unanalyzable: string[]
}

/** Every static import, `export … from`, dynamic `import("…")`, and
 *  `require("…")` specifier in a source file — type-only included: a type
 *  dependency on a sibling's internals couples to the same shape a value
 *  import does. Literal means a string literal or a no-substitution template:
 *  either can smuggle a sibling entrypoint past a string-literal-only scan. */
function moduleLoadsOf(file: string, text: string): ScannedModuleLoads {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ESNext,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const specifiers: string[] = []
  const unanalyzable: string[] = []
  const literalText = (node: ts.Node | undefined): string | undefined =>
    node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined
  const visit = (node: ts.Node): void => {
    // Grammar already restricts import/export declaration specifiers to
    // string literals; anything else is a parse error, not a blind spot.
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const specifier = literalText(node.arguments[0])
      if (specifier !== undefined) specifiers.push(specifier)
      else {
        const { line } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        )
        unanalyzable.push(`${file}:${line + 1}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { specifiers, unanalyzable }
}

type PackageDir = { dir: string; name: string }

function packagesUnder(kind: "plugins" | "tools"): PackageDir[] {
  return gitLsFiles(`${kind}/*/package.json`).map((rel) => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, rel), "utf8"),
    ) as { name?: string }
    if (!manifest.name) throw new Error(`${rel} has no package name`)
    return { dir: path.dirname(rel), name: manifest.name }
  })
}

const SHARED_LIBRARIES = new Set(
  gitLsFiles("libraries/*/package.json").map((rel) => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, rel), "utf8"),
    ) as { name?: string }
    if (!manifest.name) throw new Error(`${rel} has no package name`)
    return manifest.name
  }),
)

const packages = [...packagesUnder("plugins"), ...packagesUnder("tools")]

type CrossImport = { importer: string; specifier: string }

/** The cross-package edge a specifier creates, if any: a bare sibling
 *  package specifier, or a relative path that escapes the importing package
 *  into another tracked one — relative escape hatches recreate exactly the
 *  unreviewed coupling the bare-specifier scan exists to stop (PR #142
 *  review F3). */
function crossImportOf(
  pkg: PackageDir,
  file: string,
  specifier: string,
): CrossImport | undefined {
  if (specifier.startsWith(".")) {
    // git ls-files paths are POSIX; resolve the target the same way.
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), specifier),
    )
    const target = packages.find(
      (candidate) =>
        resolved === candidate.dir || resolved.startsWith(`${candidate.dir}/`),
    )
    if (target && target.dir !== pkg.dir) return { importer: file, specifier }
    return undefined
  }
  if (!specifier.startsWith("@macarons/")) return undefined
  const name = packageNameOf(specifier)
  if (SHARED_LIBRARIES.has(name) || name === pkg.name) return undefined
  return { importer: file, specifier }
}

function crossImportsOf(pkg: PackageDir): {
  scanned: number
  cross: CrossImport[]
  unanalyzable: string[]
} {
  const files = gitLsFiles(`${pkg.dir}/src/**`).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".tsx"),
  )
  const cross: CrossImport[] = []
  const unanalyzable: string[] = []
  for (const file of files) {
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8")
    const loads = moduleLoadsOf(file, text)
    unanalyzable.push(...loads.unanalyzable)
    for (const specifier of loads.specifiers) {
      const edge = crossImportOf(pkg, file, specifier)
      if (edge) cross.push(edge)
    }
  }
  return { scanned: files.length, cross, unanalyzable }
}

const scans = packages.map((pkg) => ({ pkg, ...crossImportsOf(pkg) }))
const crossImports = scans.flatMap(({ cross }) => cross)

describe("cross-plugin imports are pinned to reviewed interop surfaces", () => {
  test("the sweep covers every plugin and tool package", () => {
    // ≥ the 12 plugins + 1 tool at the time of writing; shrinking is a loud,
    // deliberate roster change, not a broken walk. Every package must
    // contribute scanned sources — an empty scan must never pass vacuously.
    expect(packages.length).toBeGreaterThanOrEqual(13)
    for (const { pkg, scanned } of scans)
      expect(
        scanned,
        `${pkg.dir} contributed no scanned sources`,
      ).toBeGreaterThan(0)
  })

  test("the import scan actually sees the allowlisted interop import", () => {
    // Guard the guard: a parser that stopped extracting specifiers would
    // make the allowlist checks below pass vacuously.
    for (const allowed of ALLOWED) {
      expect(
        crossImports,
        `${allowed.importer} no longer imports ${allowed.specifier} — remove its stale allowlist entry`,
      ).toContainEqual({
        importer: allowed.importer,
        specifier: allowed.specifier,
      })
    }
  })

  test("every cross-plugin import in src/ is an allowlisted (file, entrypoint) pair", () => {
    const allowed = new Set(
      ALLOWED.map((entry) => `${entry.importer} → ${entry.specifier}`),
    )
    const offenders = crossImports
      .map(({ importer, specifier }) => `${importer} → ${specifier}`)
      .filter((edge) => !allowed.has(edge))
    // A new edge is not necessarily wrong — it is UNREVIEWED. Either point
    // the consumer at (or ask the producer for) a dedicated interop
    // entrypoint and allowlist the pair with its reason, or promote the
    // shared piece to the permission-rules library.
    expect(offenders).toEqual([])
  })

  test("every dynamic module load in src/ is analyzable", () => {
    // A computed import()/require() argument could name a sibling entrypoint
    // the scan cannot see. None exist in runtime sources today; one that
    // appears is reviewed here — make it literal, or extend the guard
    // deliberately if the computed load is genuinely needed.
    expect(scans.flatMap(({ unanalyzable }) => unanalyzable)).toEqual([])
  })

  test("every cross-plugin manifest dependency belongs to an allowlisted importer", () => {
    // The manifest edge is what makes the import resolvable; pinning it too
    // catches coupling added through require()-style paths the AST scan
    // might miss, and dead sibling dependencies left behind after a removal.
    const allowedPairs = new Set(
      ALLOWED.map((entry) => {
        const dir = entry.importer.split(path.sep).slice(0, 2).join("/")
        const pkg = packages.find((candidate) => candidate.dir === dir)
        if (!pkg) throw new Error(`allowlist names unknown package dir ${dir}`)
        return `${pkg.name} → ${packageNameOf(entry.specifier)}`
      }),
    )
    const offenders: string[] = []
    for (const pkg of packages) {
      const manifest = JSON.parse(
        readFileSync(path.join(REPO_ROOT, pkg.dir, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> }
      for (const dep of Object.keys(manifest.dependencies ?? {})) {
        if (!dep.startsWith("@macarons/")) continue
        if (SHARED_LIBRARIES.has(dep)) continue
        if (!allowedPairs.has(`${pkg.name} → ${dep}`))
          offenders.push(
            `${pkg.dir} depends on ${dep} without an allowlisted import`,
          )
      }
    }
    expect(offenders).toEqual([])
  })
})

describe("the scanner sees what it claims to see", () => {
  // Guard the guard, on synthetic sources: each form below once slipped past
  // (or would have) — a scanner regression here means the sweep above passes
  // vacuously against exactly the loads it exists to catch.
  const importer = path.join("plugins", "codex-limits", "src", "tui.tsx")
  const importingPkg = () => {
    const pkg = packages.find((p) => p.dir === "plugins/codex-limits")
    if (!pkg) throw new Error("plugins/codex-limits missing from the roster")
    return pkg
  }

  test("require() and no-substitution template arguments are extracted", () => {
    const { specifiers, unanalyzable } = moduleLoadsOf(
      importer,
      [
        `const a = require("@macarons/approve-for-me/shared")`,
        "const b = await import(`@macarons/approve-for-me/interop`)",
        "const c = require(`../../approve-for-me/src/shared`)",
      ].join("\n"),
    )
    expect(specifiers).toEqual([
      "@macarons/approve-for-me/shared",
      "@macarons/approve-for-me/interop",
      "../../approve-for-me/src/shared",
    ])
    expect(unanalyzable).toEqual([])
  })

  test("non-literal dynamic loads are unanalyzable, never silently clean", () => {
    const { specifiers, unanalyzable } = moduleLoadsOf(
      importer,
      [
        `const name = "../../approve-for-me/src/shared"`,
        `const a = await import(name)`,
        `const b = require(\`../../\${name}\`)`,
      ].join("\n"),
    )
    expect(specifiers).toEqual([])
    expect(unanalyzable).toEqual([`${importer}:2`, `${importer}:3`])
  })

  test("a relative path into a sibling package is a cross-plugin import", () => {
    expect(
      crossImportOf(
        importingPkg(),
        importer,
        "../../approve-for-me/src/shared",
      ),
    ).toEqual({
      importer,
      specifier: "../../approve-for-me/src/shared",
    })
  })

  test("relative paths within the package, or out of any tracked one, are not", () => {
    expect(crossImportOf(importingPkg(), importer, "./core")).toBeUndefined()
    expect(
      crossImportOf(
        importingPkg(),
        importer,
        "../../../libraries/permission-rules/src/index",
      ),
    ).toBeUndefined()
  })
})

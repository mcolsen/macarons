import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { OPENCODE_ENGINE_RANGE } from "@macarons/permission-rules"

/**
 * The shared packaging skeleton (2026-07-23 audit §3, issue #116). Guards the
 * contract that makes `opencode plugin <path-or-package>` install a plugin and
 * keeps OpenCode's loaders accepting the entry modules:
 *
 * - The installer detects the server target from exports["./server"] (or
 *   `main`) and the TUI half from exports["./tui"]; a target that does not
 *   exist is not a crash — pickExport() yields undefined and the half is
 *   silently dropped from the discovery wizard.
 * - The legacy server loader treats EVERY export of the entry module as a
 *   plugin function; one non-function export makes loading throw.
 * - bun hoists every workspace package's node_modules to the repo root, so a
 *   runtime import resolves here no matter which dependency block declares
 *   it, while a registry install gets only `dependencies` — a misplaced
 *   runtime dep reaches a real consumer as "the plugin silently does
 *   nothing" with every local test green.
 *
 * Genuinely per-plugin contracts (SKILL.md, NOTICE/attribution, vendored-rule
 * markers, SUITE cross-checks, version-pin cross-checks) stay inline in the
 * plugin's own packaging.test.ts.
 */
export type PackagingOptions = {
  /** The calling test file's `import.meta.dir` (the plugin's test/ dir). */
  testDir: string
  /**
   * The single function name the server entry must export (the legacy
   * server-loader contract). Omit for TUI-only plugins, which must not
   * advertise a server target at all.
   */
  serverExport?: string
  /** Whether the plugin ships a ./tui half. */
  tui?: boolean
  /**
   * Bare specifiers the src tree value-imports: they must sit in
   * `dependencies` (and not also in `devDependencies`, which would hide a
   * later demotion from every local install). The shared permission-rules
   * library is asserted for every plugin and needs no listing here.
   */
  runtimeDeps?: string[]
  /**
   * Packages that must stay dev-only — declared in `devDependencies` and
   * absent from `dependencies`, so consumers never install weight src/ never
   * loads (the mirror image of runtimeDeps).
   */
  devOnlyDeps?: string[]
}

type PackageJson = {
  name?: string
  main?: string
  exports?: Record<string, string>
  files?: string[]
  engines?: { opencode?: string }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export function describePackaging(options: PackagingOptions): void {
  const root = path.resolve(options.testDir, "..")
  const packageDir = path.basename(root)
  const hasServer = options.serverExport !== undefined
  const hasTui = Boolean(options.tui)

  async function readPackageJson(): Promise<PackageJson> {
    return JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf8"),
    ) as PackageJson
  }

  /** Resolve a declared export target to an absolute path inside the package. */
  async function exportTarget(key: string): Promise<string> {
    const target = (await readPackageJson()).exports?.[key]
    if (typeof target !== "string") throw new Error(`Missing export ${key}`)
    return path.resolve(root, target)
  }

  describe("package.json advertises the install target", () => {
    test("uses the monorepo package scope", async () => {
      // The name is pinned to the directory so the workspace manifest guard
      // (tests/repo package-manifest.test.ts) and this file can never disagree
      // about which package they are talking about.
      expect((await readPackageJson()).name).toBe(`@macarons/${packageDir}`)
    })

    test("every declared export resolves to a real file that `files` ships", async () => {
      const pkg = await readPackageJson()
      const entries = Object.entries(pkg.exports ?? {})
      expect(entries.length).toBeGreaterThan(0)
      for (const [name, target] of entries) {
        expect(typeof target).toBe("string")
        const resolved = path.resolve(root, target)
        expect(resolved.startsWith(root + path.sep)).toBe(true)
        expect((await fs.stat(resolved)).isFile()).toBe(true)
        // Published tarballs contain only `files`, so an export pointing
        // outside them resolves locally and 404s for a consumer. Only
        // checkable where the package declares `files` at all.
        if (pkg.files) {
          const top = path.relative(root, resolved).split(path.sep)[0]
          expect({ name, shipped: pkg.files.includes(top as string) }).toEqual({
            name,
            shipped: true,
          })
        }
      }
    })

    test("declares exactly the halves it ships", async () => {
      const pkg = await readPackageJson()
      if (hasServer) {
        expect(typeof pkg.exports?.["./server"]).toBe("string")
        // An `exports` map takes precedence over `main` for the package root,
        // so dropping "." turns `import "@macarons/<plugin>"` into
        // ERR_PACKAGE_PATH_NOT_EXPORTED no matter what `main` still says. The
        // per-plugin copies this helper replaced iterated [".", "./server"]
        // explicitly; enumerating whatever exports happen to exist lost that,
        // so the root is named here rather than inferred.
        expect(pkg.exports?.["."]).toBe(pkg.exports?.["./server"])
      } else {
        expect(pkg.exports?.["./server"]).toBeUndefined()
        // Mirror image: a TUI-only package that grew a root export would be
        // picked up by the legacy server loader and die on its non-function
        // exports, the same failure `main` is checked for below.
        expect(pkg.exports?.["."]).toBeUndefined()
      }
      if (hasTui) {
        expect(typeof pkg.exports?.["./tui"]).toBe("string")
      } else {
        expect(pkg.exports?.["./tui"]).toBeUndefined()
      }
    })

    if (hasServer) {
      test("main names the server entry for loaders that ignore exports", async () => {
        const pkg = await readPackageJson()
        expect(pkg.main).toBe(pkg.exports?.["./server"])
      })
    } else {
      test("declares no server target", async () => {
        // A TUI-only plugin with a `main` would be discovered by the legacy
        // server loader and die on its non-function exports.
        expect((await readPackageJson()).main).toBeUndefined()
      })
    }

    test("engines declares the static v1 install gate", async () => {
      // Pinned to the shared constant so the band never drifts for one plugin
      // alone; the nightly bump job deliberately leaves engines untouched, so
      // any divergence here is a hand edit that nothing else would catch.
      expect((await readPackageJson()).engines?.opencode).toBe(
        OPENCODE_ENGINE_RANGE,
      )
    })

    test("runtime imports are real dependencies (the host loads src directly)", async () => {
      // `exports` point into ./src and `files` ships sources, so a registry
      // install gets no devDependencies: every value-imported bare specifier
      // held as a devDependency is an unresolvable specifier at plugin load.
      const pkg = await readPackageJson()
      expect(pkg.dependencies?.["@macarons/permission-rules"]).toBeDefined()
      for (const dep of options.runtimeDeps ?? []) {
        expect({ dep, runtime: pkg.dependencies?.[dep] !== undefined }).toEqual(
          { dep, runtime: true },
        )
        expect({ dep, dev: pkg.devDependencies?.[dep] }).toEqual({
          dep,
          dev: undefined,
        })
      }
    })

    if (options.devOnlyDeps?.length) {
      test("type-only packages stay devDependencies — src never imports them", async () => {
        // The mirror image of the assertion above: promoting a type-only or
        // test-only package to dependencies makes every consumer install
        // weight they never load.
        const pkg = await readPackageJson()
        for (const dep of options.devOnlyDeps ?? []) {
          expect({ dep, runtime: pkg.dependencies?.[dep] }).toEqual({
            dep,
            runtime: undefined,
          })
          expect({
            dep,
            dev: pkg.devDependencies?.[dep] !== undefined,
          }).toEqual({ dep, dev: true })
        }
      })
    }
  })

  if (hasServer) {
    describe("server entry satisfies the legacy server-loader contract", () => {
      test("every export is a function and there is no default export", async () => {
        // Imported through the declared target rather than a hardcoded
        // ../src/index so the module under test is the one installs resolve.
        const mod = (await import(
          pathToFileURL(await exportTarget("./server")).href
        )) as Record<string, unknown>
        expect("default" in mod).toBe(false)
        expect(Object.keys(mod)).toEqual([options.serverExport as string])
        expect(typeof mod[options.serverExport as string]).toBe("function")
      })
    })
  }

  if (hasTui) {
    describe("tui entry satisfies the TUI-loader contract", () => {
      test("default export is { id, tui } and never carries server()", async () => {
        const mod = (await import(
          pathToFileURL(await exportTarget("./tui")).href
        )) as { default?: Record<string, unknown> }
        const plugin = mod.default
        expect(plugin).toBeDefined()
        if (!plugin) throw new Error("Missing default TUI plugin export")
        expect(typeof plugin.id).toBe("string")
        expect((plugin.id as string).length).toBeGreaterThan(0)
        expect(typeof plugin.tui).toBe("function")
        expect("server" in plugin).toBe(false)
      })
    })

    // The host substitutes its own solid-js for the ENTRY module only. Any
    // other module that value-imports solid-js gets a second copy from
    // node_modules; signals created on it hold values but never notify the
    // UI, so it only renders when data races in before first paint. All
    // reactive state outside the entry must be created through the entry's
    // own createSignal/createMemo; `import type` stays allowed — types vanish
    // at runtime.
    describe("only the tui entry imports solid-js at runtime", () => {
      test("no value-import of solid-js outside src/tui.tsx", async () => {
        const sources: string[] = []
        for await (const entry of fs.glob("src/**/*.{ts,tsx}", { cwd: root }))
          sources.push(entry)
        expect(sources.length).toBeGreaterThan(1)
        const offenders: string[] = []
        for (const relative of sources) {
          if (relative === path.join("src", "tui.tsx")) continue
          const text = await fs.readFile(path.join(root, relative), "utf8")
          const imports = text.matchAll(
            /^import\s(?:(?!^import\s)[\s\S])*?from\s+"solid-js"/gm,
          )
          for (const [statement] of imports) {
            if (!/^import\s+type\s/.test(statement)) offenders.push(relative)
          }
        }
        expect(offenders).toEqual([])
      })
    })
  }
}

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { builtinModules } from "node:module"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/**
 * The shared bundle skeleton (2026-07-23 audit §3, issue #116). A plugin with
 * a `build` script ships a bundled dist for the single-file
 * `.opencode/plugin/` install path; this proves that artifact stands alone:
 * built fresh into a bare temp dir (no package.json, no node_modules — the
 * environment the copied file really runs in), scanned for bare imports, and
 * loaded through a real dynamic import.
 *
 * The artifact under test is built by RUNNING `scripts.build`, redirected to
 * the temp dir — not by an independent Bun.build the suite composes itself.
 * An independently composed build is a second expression of the same intent,
 * and the two drift: `--packages=external` or `--no-bundle` on the real
 * script ships a dist full of bare specifiers while a self-composed artifact
 * stays fully bundled and importable, so every assertion below passes about a
 * file no user ever receives. Pinning a couple of substrings of the script
 * only denies the flags someone thought of. Executing the declared command
 * removes the second expression entirely.
 *
 * The command must therefore be one plain `bun build` invocation whose flags
 * this harness understands (see parseBuildCommand) — an unrecognized flag is
 * a loud failure asking for a deliberate harness change, because flags like
 * `--format=cjs` would leave the ESM import scan below matching nothing and
 * passing vacuously.
 *
 * Always a subprocess with cwd at the package root, exactly as `bun run
 * build` runs it: in-process Bun.build inherits the test runner's cwd, so a
 * dependency bun did not hoist (approve-for-me's jsonc-parser) resolves out
 * of bun's install cache and emits unresolvable relative CommonJS requires —
 * an artifact that fails only when imported.
 *
 * Call at the top level of bundle.test.ts: the build registers as a
 * file-level beforeAll, so per-plugin integration describes elsewhere in the
 * file can reach the artifact through the returned context.
 */
export type BundleOptions = {
  /** The calling test file's `import.meta.dir` (the plugin's test/ dir). */
  testDir: string
  /** The single function name the bundled module must export. */
  exportName: string
}

export type BundleContext = {
  /** Absolute path of the built artifact (assigned in beforeAll). */
  artifact: () => string
  /** Import the artifact the way the host loads a `.opencode/plugin/` file. */
  importArtifact: () => Promise<Record<string, unknown>>
}

type PackageJson = {
  scripts?: Record<string, string>
  exports?: Record<string, string>
}

/**
 * `--outfile` is rewritten to the temp artifact; `--target` is read back and
 * pinned to `bun` (the runtime the host loads a `.opencode/plugin/` file in).
 * Nothing else is accepted: a flag this harness has no opinion about could
 * silently invalidate the assertions that run against the output, so the
 * failure is "teach the harness about this flag", not "assume it is benign".
 */
const KNOWN_FLAGS = new Set(["--target", "--outfile"])

type BuildCommand = {
  entrypoint: string
  flags: Map<string, string>
}

function parseBuildCommand(script: string): BuildCommand {
  // One command, no shell: a pipeline or `&&` chain means the shipped dist is
  // not the file this single invocation would produce.
  if (/[|&;<>()`$'"]/.test(script))
    throw new Error(`build script is not one plain command: ${script}`)
  const [bun, build, ...rest] = script.trim().split(/\s+/)
  if (bun !== "bun" || build !== "build")
    throw new Error(`build script is not \`bun build …\`: ${script}`)

  const entrypoints: string[] = []
  const flags = new Map<string, string>()
  for (const token of rest) {
    if (!token.startsWith("-")) {
      entrypoints.push(token)
      continue
    }
    const eq = token.indexOf("=")
    const name = eq < 0 ? token : token.slice(0, eq)
    if (!KNOWN_FLAGS.has(name) || eq < 0)
      throw new Error(
        `describeBundle does not understand \`${token}\` and will not guess ` +
          `what it does to the artifact — teach parseBuildCommand about it ` +
          `(and whatever assertion it affects) first: ${script}`,
      )
    flags.set(name, token.slice(eq + 1))
  }

  const [entrypoint] = entrypoints
  if (entrypoints.length !== 1 || entrypoint === undefined)
    throw new Error(`build script names ${entrypoints.length} entrypoints`)
  if (!flags.has("--outfile"))
    throw new Error(`build script names no --outfile: ${script}`)
  return { entrypoint, flags }
}

export function describeBundle(options: BundleOptions): BundleContext {
  const root = path.resolve(options.testDir, "..")
  let dir: string
  let artifact: string

  async function readPackageJson(): Promise<PackageJson> {
    return JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf8"),
    ) as PackageJson
  }

  async function buildCommand(): Promise<BuildCommand> {
    const script = (await readPackageJson()).scripts?.build
    if (typeof script !== "string")
      throw new Error(`${path.basename(root)} declares no build script`)
    return parseBuildCommand(script)
  }

  beforeAll(async () => {
    // realpath because os.tmpdir() can sit behind a symlink (macOS /var →
    // /private/var) and some plugins canonicalize the project root.
    dir = await fs.realpath(
      await fs.mkdtemp(
        path.join(os.tmpdir(), `${path.basename(root)}-bundle-`),
      ),
    )
    const command = await buildCommand()
    artifact = path.join(
      dir,
      path.basename(command.flags.get("--outfile") as string),
    )
    // The declared argv, verbatim apart from the redirected output — cwd at
    // the package root so `bun run build` and this resolve identically.
    const args = ["build", command.entrypoint]
    for (const [name, value] of command.flags)
      args.push(`${name}=${name === "--outfile" ? artifact : value}`)
    await execFileAsync("bun", args, { cwd: root })
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const context: BundleContext = {
    artifact: () => artifact,
    importArtifact: async () =>
      (await import(pathToFileURL(artifact).href)) as Record<string, unknown>,
  }

  describe("bundled server half", () => {
    test("bundles the same module a registry install resolves", async () => {
      const command = await buildCommand()
      // The runtime the host loads a `.opencode/plugin/` file in.
      expect(command.flags.get("--target")).toBe("bun")
      // Two install paths, one module: `opencode plugin <pkg>` resolves
      // exports["./server"] out of the registry while `.opencode/plugin/`
      // gets this single file. An entrypoint that stops tracking the export
      // ships two different server halves under one version, with both this
      // suite and packaging.test.ts green — each following its own target.
      const server = (await readPackageJson()).exports?.["./server"]
      expect(typeof server).toBe("string")
      expect(path.resolve(root, command.entrypoint)).toBe(
        path.resolve(root, server as string),
      )
    })

    test("imports nothing but node builtins", async () => {
      const text = await fs.readFile(artifact, "utf8")
      const specifiers = [
        ...text.matchAll(
          /^(?:import\s[^"']*|export\s[^"']*\sfrom\s*)["']([^"']+)["']/gm,
        ),
      ].map((match) => match[1])
      for (const specifier of specifiers) {
        if (specifier === undefined) continue
        expect(builtinModules).toContain(specifier.replace(/^node:/, ""))
      }
    })

    test("keeps the legacy loader contract: only the plugin function is exported", async () => {
      const mod = await context.importArtifact()
      expect(Object.keys(mod).sort()).toEqual([options.exportName])
      expect(typeof mod[options.exportName]).toBe("function")
    })
  })

  return context
}

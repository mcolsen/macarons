import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { builtinModules } from "node:module"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** Build the declared native server package and validate its runtime imports.
 * Native v2 loads package directories, so externals are allowed only when
 * declared runtime dependencies. The staged import exposes exactly those
 * dependencies; dev-only workspace hoisting cannot hide a packaging error.
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
  dependencies?: Record<string, string>
}

/**
 * `--outfile` is rewritten to the temp artifact; `--target` is read back and
 * pinned to `bun` (the runtime the host loads a `.opencode/plugin/` file in).
 * Nothing else is accepted: a flag this harness has no opinion about could
 * silently invalidate the assertions that run against the output, so the
 * failure is "teach the harness about this flag", not "assume it is benign".
 */
const KNOWN_FLAGS = new Set([
  "--target",
  "--outfile",
  "--packages",
  "--external",
])

type BuildCommand = {
  entrypoint: string
  flags: Map<string, string>
  externals: string[]
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
  const externals: string[] = []
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index] as string
    if (!token.startsWith("-")) {
      entrypoints.push(token)
      continue
    }
    const eq = token.indexOf("=")
    const name = eq < 0 ? token : token.slice(0, eq)
    if (!KNOWN_FLAGS.has(name))
      throw new Error(`Unsupported build flag ${token}`)
    const value = eq < 0 ? rest[++index] : token.slice(eq + 1)
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${name}`)
    if (name === "--external") externals.push(value)
    else flags.set(name, value)
  }
  if (flags.has("--packages") && flags.get("--packages") !== "external")
    throw new Error("Only --packages=external is supported")

  const [entrypoint] = entrypoints
  if (entrypoints.length !== 1 || entrypoint === undefined)
    throw new Error(`build script names ${entrypoints.length} entrypoints`)
  if (!flags.has("--outfile"))
    throw new Error(`build script names no --outfile: ${script}`)
  return { entrypoint, flags, externals }
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
    for (const external of command.externals) args.push("--external", external)
    await execFileAsync("bun", args, { cwd: root })
    const dependencies = (await readPackageJson()).dependencies ?? {}
    for (const dependency of Object.keys(dependencies)) {
      const target = path.join(dir, "node_modules", dependency)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.symlink(
        await fs.realpath(path.join(root, "node_modules", dependency)),
        target,
        "dir",
      )
    }
  })

  afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
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

    test("external imports are node builtins or declared runtime dependencies", async () => {
      const text = await fs.readFile(artifact, "utf8")
      const specifiers = [
        ...text.matchAll(
          /^(?:import\s[^"']*|export\s[^"']*\sfrom\s*)["']([^"']+)["']/gm,
        ),
      ].map((match) => match[1])
      const dependencies = (await readPackageJson()).dependencies ?? {}
      for (const specifier of specifiers) {
        if (specifier === undefined) continue
        if (builtinModules.includes(specifier.replace(/^node:/, ""))) continue
        const name = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0]
        expect(
          name && name in dependencies,
          `${specifier} is not a declared dependency`,
        ).toBe(true)
      }
    })

    test("keeps the native v2 default plugin definition", async () => {
      const mod = await context.importArtifact()
      const definition = mod.default as
        | { id?: unknown; setup?: unknown }
        | undefined
      expect(typeof definition?.id).toBe("string")
      expect(typeof definition?.setup).toBe("function")
      expect(mod[options.exportName]).toBe(definition)
    })
  })

  return context
}

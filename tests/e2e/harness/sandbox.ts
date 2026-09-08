import { spawn } from "node:child_process"
import { once } from "node:events"
import { type Dirent, rmSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  OWNER_ENVIRONMENT_VARIABLE,
  OWNER_MARKER,
  registerResource,
  stopSandboxResources,
  sweepStaleResourcesOnce,
} from "./registry"

export type Sandbox = {
  readonly root: string
  readonly project: string
  readonly home: string
  readonly config: string
  readonly artifacts: string
  environment(
    instance: string,
    extra?: Record<string, string | undefined>,
  ): Promise<Record<string, string>>
  preserve(name: string): Promise<string>
  cleanup(): Promise<void>
}

function safeName(value: string) {
  return (
    value.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "") ||
    "e2e"
  )
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
) {
  const child = spawn(command, args, { cwd, env, stdio: "ignore" })
  const [code] = (await once(child, "close")) as [number | null]
  if (code !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}`,
    )
}

// What a failing run keeps (audit M4): everything a test or OpenCode wrote,
// minus reconstructable stores. The exclusions are named — not the keep set —
// so fixtures tests place directly under the sandbox root (crafted models.dev
// catalogs, secondary worktree checkouts) survive into the snapshot.
const EXCLUDED_ROOT_ENTRIES = new Set(["bun-install", "tmp", OWNER_MARKER])
// Dependency and package-cache stores, wherever they appear: OpenCode
// installs plugin dependencies under its config dir and fills ~/.npm/_cacache
// doing so — one failing run otherwise snapshots hundreds of MB.
const EXCLUDED_SEGMENTS = new Set(["node_modules", "_cacache", ".bun"])

function excludedFromPreservation(segments: string[]): boolean {
  const top = segments[0]
  if (top === undefined) return false
  if (segments.length === 1 && EXCLUDED_ROOT_ENTRIES.has(top)) return true
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return true
  const relative = segments.join("/")
  if (relative === "xdg/cache" || relative === "home/.cache") return true
  // Per-instance XDG cache homes: instances/<name>/cache.
  if (segments.length === 3 && top === "instances" && segments[2] === "cache")
    return true
  return false
}

async function copyDiagnostics(
  sourceRoot: string,
  destinationRoot: string,
  segments: string[],
): Promise<void> {
  const source = path.join(sourceRoot, ...segments)
  let entries: Dirent[]
  try {
    entries = await fs.readdir(source, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const childSegments = [...segments, entry.name]
    if (excludedFromPreservation(childSegments)) continue
    const from = path.join(sourceRoot, ...childSegments)
    const to = path.join(destinationRoot, ...childSegments)
    try {
      if (entry.isDirectory()) {
        await fs.mkdir(to, { recursive: true })
        await copyDiagnostics(sourceRoot, destinationRoot, childSegments)
      } else if (entry.isFile()) {
        await fs.mkdir(path.dirname(to), { recursive: true })
        await fs.copyFile(from, to)
      } else if (entry.isSymbolicLink()) {
        await fs.mkdir(path.dirname(to), { recursive: true })
        await fs.symlink(await fs.readlink(from), to)
      }
      // Sockets, FIFOs and devices are not diagnostics: skipped entirely.
    } catch {
      // An entry vanishing or unreadable mid-copy must not sink the whole
      // snapshot — preservation is best-effort by design.
    }
  }
}

export async function createSandbox(
  name: string,
  options: { git?: boolean } = {},
): Promise<Sandbox> {
  // Reclaim what SIGKILL'd/OOM'd earlier runs leaked before adding to /tmp.
  await sweepStaleResourcesOnce()
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), `opencode-e2e-${safeName(name)}-`),
  )
  const project = path.join(root, "project")
  const home = path.join(root, "home")
  const artifacts = path.join(root, "artifacts")
  const temp = path.join(root, "tmp")
  const xdg = {
    cache: path.join(root, "xdg", "cache"),
    config: path.join(root, "xdg", "config"),
    data: path.join(root, "xdg", "data"),
    state: path.join(root, "xdg", "state"),
  }
  await Promise.all([
    fs.mkdir(project, { recursive: true }),
    fs.mkdir(home, { recursive: true }),
    fs.mkdir(artifacts, { recursive: true }),
    fs.mkdir(temp, { recursive: true }),
    fs.mkdir(path.join(xdg.config, "opencode"), { recursive: true }),
    fs.mkdir(xdg.cache, { recursive: true }),
    fs.mkdir(xdg.data, { recursive: true }),
    fs.mkdir(xdg.state, { recursive: true }),
    // The stale sweeper reclaims this sandbox once the owning pid is gone.
    fs.writeFile(
      path.join(root, OWNER_MARKER),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    ),
  ])
  // Exit/signal last resort: resources registered after this one (the
  // sandbox's processes) are killed first — killAllSync runs in reverse
  // registration order — and then the tree goes. The stale sweep only covers
  // the NEXT run; this covers the one that is exiting right now.
  const unregister = registerResource({
    kind: "sandbox",
    home,
    killSync: () => rmSync(root, { recursive: true, force: true }),
  })

  const base = {
    BUN_INSTALL: path.join(root, "bun-install"),
    BUN_TMPDIR: temp,
    CI: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    NO_PROXY: "127.0.0.1,localhost",
    // Signs every sandboxed instance out of everything. Note this is now the
    // INLINE override for the plugins too (audit §2.3: all three auth readers
    // honor it, raw and wholesale, exactly as the host does), so an auth.json
    // planted under XDG_DATA_HOME is unreachable while it is set — a journey
    // that needs a file-backed credential has to clear it in `environment()`.
    // That holds for THIS value because an empty store has no expired OAuth
    // record to repair; a journey that overrides it with one would let
    // web-search's `readRefreshedAuthStore` reach the file for that provider
    // after all.
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_DIR: path.join(xdg.config, "opencode"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PRUNE: "1",
    OPENCODE_DISABLE_TERMINAL_TITLE: "1",
    // Marks every process spawned in this sandbox with the owning runner pid,
    // so the stale sweeper can find orphans once that pid is gone.
    [OWNER_ENVIRONMENT_VARIABLE]: String(process.pid),
    PATH: process.env.PATH ?? "",
    TZ: "UTC",
    TMPDIR: temp,
    XDG_CACHE_HOME: xdg.cache,
    XDG_CONFIG_HOME: xdg.config,
    XDG_DATA_HOME: xdg.data,
    XDG_STATE_HOME: xdg.state,
    http_proxy: "",
    https_proxy: "",
    no_proxy: "127.0.0.1,localhost",
    // OpenCode waits for this config-time install before loading local plugins.
    // npm's 5m defaults outlive every E2E readiness and per-test budget.
    npm_config_fetch_retries: "0",
    npm_config_fetch_timeout: "15000",
  }

  if (options.git !== false)
    await run("git", ["init", "--quiet"], project, base)

  return {
    root,
    project,
    home,
    config: base.OPENCODE_CONFIG_DIR,
    artifacts,
    async environment(instance, extra = {}) {
      const name = safeName(instance)
      const state = path.join(root, "instances", name)
      const instanceXdg = {
        cache: path.join(state, "cache"),
        config: path.join(state, "config"),
        data: path.join(state, "data"),
        state: path.join(state, "state"),
      }
      await Promise.all([
        fs.mkdir(path.join(instanceXdg.config, "opencode"), {
          recursive: true,
        }),
        fs.mkdir(instanceXdg.cache, { recursive: true }),
        fs.mkdir(instanceXdg.data, { recursive: true }),
        fs.mkdir(instanceXdg.state, { recursive: true }),
      ])
      return {
        ...base,
        // Authorization settings and permission stores must survive a fresh
        // OpenCode process, so every isolated instance in this sandbox shares
        // the same trusted config directory while keeping runtime state apart.
        OPENCODE_CONFIG_DIR: base.OPENCODE_CONFIG_DIR,
        XDG_CACHE_HOME: instanceXdg.cache,
        XDG_CONFIG_HOME: xdg.config,
        XDG_DATA_HOME: instanceXdg.data,
        XDG_STATE_HOME: instanceXdg.state,
        ...Object.fromEntries(
          Object.entries(extra).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      }
    },
    async preserve(label) {
      // Quiesce first: the snapshot must not race writes from still-running
      // servers or TUIs (audit M4).
      await stopSandboxResources(home)
      const destinationRoot =
        process.env.E2E_ARTIFACTS_DIR ?? path.join(process.cwd(), "artifacts")
      await fs.mkdir(destinationRoot, { recursive: true })
      const destination = path.join(
        destinationRoot,
        `${safeName(label)}-${Date.now()}`,
      )
      await fs.mkdir(destination, { recursive: true })
      await copyDiagnostics(root, destination, [])
      await fs.writeFile(
        path.join(destination, "preserve.json"),
        `${JSON.stringify({ label, pid: process.pid, preservedAt: new Date().toISOString(), root }, null, 2)}\n`,
      )
      return destination
    },
    async cleanup() {
      await stopSandboxResources(home)
      unregister()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

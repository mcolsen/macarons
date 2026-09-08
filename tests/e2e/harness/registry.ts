import { spawnSync } from "node:child_process"
import type { Dirent } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Process-global safety net for e2e resources (audit M9).
//
// Every detached OpenCode process group, per-run tmux server, and sandbox
// directory registers here so that:
//   - SIGINT/SIGTERM/SIGHUP and normal exit tear registered resources down
//     synchronously before the runner dies;
//   - `Sandbox.preserve` can quiesce a sandbox's processes before it
//     snapshots the tree (audit M4);
//   - a later run can reclaim what SIGKILL/OOM leaked — those cannot be
//     hooked, so every resource leaves an on-disk owner trail: sandboxes a
//     marker file, tmux sockets the owner pid in their name, OpenCode
//     processes an environment marker.

/** Injected into every sandbox environment; names the owning test-runner pid. */
export const OWNER_ENVIRONMENT_VARIABLE = "OPENCODE_E2E_OWNER"
/** Written at each sandbox root; names the owning test-runner pid. */
export const OWNER_MARKER = ".opencode-e2e-owner.json"

const SANDBOX_PREFIX = "opencode-e2e-"
const TMUX_SOCKET_PATTERN = /^opencode-e2e-(\d+)-/
/** Pre-marker debris is only swept once it cannot be a live run's sandbox. */
const UNMARKED_STALE_AGE_MS = 60 * 60 * 1000

export type RegisteredResource = {
  kind: "opencode" | "tmux" | "sandbox"
  /** HOME of the owning sandbox — the key `Sandbox.preserve` stops by. */
  home?: string
  /** Graceful teardown for preserve/cleanup. Must be idempotent. */
  stop?: () => Promise<void>
  /** Synchronous last resort, safe in signal and exit handlers. Must be idempotent. */
  killSync: () => void
}

const resources = new Set<RegisteredResource>()
let handlersInstalled = false

function killAllSync() {
  for (const resource of [...resources].reverse()) {
    try {
      resource.killSync()
    } catch {
      // A handler must never throw past another resource's teardown.
    }
  }
}

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]

function installHandlers() {
  if (handlersInstalled) return
  handlersInstalled = true
  process.on("exit", killAllSync)
  for (const signal of SIGNALS) {
    const handler = () => {
      killAllSync()
      // The runner may own shutdown for this signal; only when this handler
      // is the sole listener has default termination been suppressed by us,
      // and then the signal must be re-raised to preserve the exit status.
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, handler)
        process.kill(process.pid, signal)
      }
    }
    process.on(signal, handler)
  }
}

export function registerResource(resource: RegisteredResource): () => void {
  installHandlers()
  resources.add(resource)
  return () => {
    resources.delete(resource)
  }
}

/** Gracefully stop every registered resource belonging to the sandbox with this HOME. */
export async function stopSandboxResources(home: string): Promise<void> {
  const owned = [...resources].filter(
    (resource) => resource.home === home && resource.stop,
  )
  // TUIs first, so panes wind down before the servers they are attached to.
  for (const resource of [
    ...owned.filter((r) => r.kind === "tmux"),
    ...owned.filter((r) => r.kind !== "tmux"),
  ]) {
    try {
      await resource.stop?.()
    } catch {
      // Preservation and cleanup must proceed past a wedged resource — but it
      // stays registered, so the exit-time killSync still gets a shot at it.
      continue
    }
    resources.delete(resource)
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else: alive.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function sweepSandboxes(root: string) {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SANDBOX_PREFIX)) continue
    const directory = path.join(root, entry.name)
    let stale = false
    try {
      const marker = JSON.parse(
        await fs.readFile(path.join(directory, OWNER_MARKER), "utf8"),
      ) as { pid?: unknown }
      stale =
        typeof marker.pid === "number" &&
        Number.isInteger(marker.pid) &&
        marker.pid > 0 &&
        !processAlive(marker.pid)
    } catch {
      // No readable marker: pre-marker debris or a run killed mid-creation.
      // Only age makes that distinguishable from a sandbox being born now.
      try {
        const stats = await fs.stat(directory)
        stale = Date.now() - stats.mtimeMs > UNMARKED_STALE_AGE_MS
      } catch {
        // Vanished while we looked — someone else cleaned it.
      }
    }
    if (stale)
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

async function sweepTmuxSockets(root: string) {
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return
  }
  for (const entry of entries) {
    const match = TMUX_SOCKET_PATTERN.exec(entry)
    if (!match) continue
    const owner = Number(match[1])
    if (!Number.isInteger(owner) || owner <= 0 || processAlive(owner)) continue
    const socket = path.join(root, entry)
    try {
      // The tmux server is a daemon that outlives its dead owner; this is the
      // only handle left to it.
      spawnSync("tmux", ["-S", socket, "kill-server"], {
        stdio: "ignore",
        timeout: 5_000,
      })
    } catch {
      // No tmux, or no server behind the socket — the unlink below suffices.
    }
    await fs.rm(socket, { force: true }).catch(() => {})
  }
}

async function sweepOrphanProcesses(procRoot: string) {
  if (process.platform !== "linux") return
  let entries: string[]
  try {
    entries = await fs.readdir(procRoot)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === process.pid) continue
    let environ: string
    try {
      environ = await fs.readFile(path.join(procRoot, entry, "environ"), "utf8")
    } catch {
      continue // Not ours to read (or already gone) — never touch it.
    }
    const marker = environ
      .split("\0")
      .find((candidate) =>
        candidate.startsWith(`${OWNER_ENVIRONMENT_VARIABLE}=`),
      )
    if (!marker) continue
    const owner = Number(marker.slice(OWNER_ENVIRONMENT_VARIABLE.length + 1))
    if (!Number.isInteger(owner) || owner <= 0 || processAlive(owner)) continue
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // Exited between the scan and the kill.
      }
    }
  }
}

export type SweepOptions = {
  /** Where sandbox directories live. Defaults to the OS temp directory. */
  sandboxRoot?: string
  /** The tmux socket directory. Defaults to tmux's own for this user. */
  tmuxRoot?: string
  /** Linux proc root for the orphan-process scan, or false to skip it. */
  procRoot?: string | false
}

/**
 * Reclaim resources leaked by runs that could not clean up after themselves
 * (SIGKILL, OOM). Safe against concurrent runs: everything is matched by
 * harness naming AND a dead owner pid; unmarked directories are only removed
 * once they are too old to be a live run's.
 */
export async function sweepStaleResources(
  options: SweepOptions = {},
): Promise<void> {
  const tmuxRoot =
    options.tmuxRoot ??
    path.join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${os.userInfo().uid}`)
  await Promise.all([
    sweepSandboxes(options.sandboxRoot ?? os.tmpdir()),
    sweepTmuxSockets(tmuxRoot),
    options.procRoot === false
      ? Promise.resolve()
      : sweepOrphanProcesses(options.procRoot ?? "/proc"),
  ])
}

let sweep: Promise<void> | undefined

/** The once-per-process startup sweep; the first sandbox creation awaits it. */
export function sweepStaleResourcesOnce(): Promise<void> {
  sweep ??= sweepStaleResources().catch(() => {})
  return sweep
}

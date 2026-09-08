import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { EventRecorder } from "./events"
import { runOpenCodeCommand } from "./opencode-process"
import {
  OWNER_ENVIRONMENT_VARIABLE,
  OWNER_MARKER,
  registerResource,
  stopSandboxResources,
  sweepStaleResources,
} from "./registry"
import { createSandbox } from "./sandbox"
import { startTmuxTui } from "./tmux"
import { assertFor } from "./wait"

// Harness self-tests for audit findings M4 (allowlisted failure preservation)
// and M9 (global cleanup safety net). No OpenCode binary is involved; these
// run everywhere `turbo run test` does.

async function exists(...segments: string[]) {
  return fs.access(path.join(...segments)).then(
    () => true,
    () => false,
  )
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(
  condition: () => boolean,
  timeout: number,
): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (condition()) return true
    await Bun.sleep(50)
  }
  return condition()
}

async function withArtifactsDir<T>(
  destination: string,
  body: () => Promise<T>,
): Promise<T> {
  const previous = process.env.E2E_ARTIFACTS_DIR
  process.env.E2E_ARTIFACTS_DIR = destination
  try {
    return await body()
  } finally {
    if (previous === undefined) delete process.env.E2E_ARTIFACTS_DIR
    else process.env.E2E_ARTIFACTS_DIR = previous
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function clientForEventStream(
  stream: AsyncIterable<never>,
  onSignal: (signal: AbortSignal) => void,
): OpencodeClient {
  return {
    event: {
      subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
        if (!options.signal) throw new Error("expected an abort signal")
        onSignal(options.signal)
        return { stream }
      },
    },
  } as unknown as OpencodeClient
}

describe("bounded stability assertions", () => {
  test("keeps checking through the full observation window", async () => {
    const started = performance.now()
    const checks: number[] = []
    await assertFor(
      () => {
        checks.push(performance.now() - started)
      },
      { duration: 50, interval: 5 },
    )
    expect(checks.at(-1)).toBeGreaterThanOrEqual(50)
  })

  test("propagates a later asynchronous assertion failure without retrying", async () => {
    const failure = new Error("unexpected classifier request")
    let checks = 0
    await expect(
      assertFor(
        async () => {
          checks += 1
          if (checks === 2) throw failure
        },
        { duration: 10_000, interval: 5 },
      ),
    ).rejects.toBe(failure)
    expect(checks).toBe(2)
  })
})

describe("event recorder startup cleanup", () => {
  test("a readiness timeout aborts and drains the stream before rejecting", async () => {
    const stopStream = deferred()
    const abortObserved = deferred()
    const finalizing = deferred()
    const allowFinalize = deferred()
    const streamDone = deferred()
    let signal: AbortSignal | undefined
    let streamFinished = false
    let connectionSettled = false

    const stream = (async function* () {
      yield* []
      try {
        await stopStream.promise
      } finally {
        finalizing.resolve()
        await allowFinalize.promise
        streamFinished = true
        streamDone.resolve()
      }
    })()
    const client = clientForEventStream(stream, (current) => {
      signal = current
      current.addEventListener(
        "abort",
        () => {
          abortObserved.resolve()
          stopStream.resolve()
        },
        { once: true },
      )
    })
    const outcome = EventRecorder.connect(client, 5).then(
      (recorder) => {
        connectionSettled = true
        return { kind: "resolved" as const, recorder }
      },
      (error: unknown) => {
        connectionSettled = true
        return { kind: "rejected" as const, error }
      },
    )

    try {
      const firstObserved = await Promise.race([
        abortObserved.promise.then(() => "aborted" as const),
        outcome.then(() => "settled" as const),
      ])
      expect(firstObserved).toBe("aborted")
      await finalizing.promise
      expect(signal?.aborted).toBe(true)
      expect(connectionSettled).toBe(false)
      expect(streamFinished).toBe(false)

      allowFinalize.resolve()
      const result = await outcome
      if (result.kind !== "rejected")
        throw new Error("expected recorder connection to reject")
      expect(streamFinished).toBe(true)
      expect((result.error as Error).message).toBe(
        "Timed out after 5ms waiting for server.connected event.\nRecent events:\n",
      )
    } finally {
      stopStream.resolve()
      allowFinalize.resolve()
      await streamDone.promise
    }
  })

  test("an initial stream failure aborts the subscription before rejecting", async () => {
    let signal: AbortSignal | undefined
    let abortCount = 0
    let streamFinished = false
    const stream = (async function* () {
      yield* []
      try {
        throw new Error("fixture stream failed")
      } finally {
        streamFinished = true
      }
    })()
    const client = clientForEventStream(stream, (current) => {
      signal = current
      current.addEventListener(
        "abort",
        () => {
          abortCount += 1
        },
        { once: true },
      )
    })
    const result = await EventRecorder.connect(client, 1_000).then(
      (recorder) => ({ kind: "resolved" as const, recorder }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    )

    if (result.kind !== "rejected")
      throw new Error("expected recorder connection to reject")
    expect(signal?.aborted).toBe(true)
    expect(abortCount).toBe(1)
    expect(streamFinished).toBe(true)
    expect((result.error as Error).message).toBe(
      "OpenCode event stream failed: Error: fixture stream failed\nRecent events:\n",
    )
  })
})

describe("sandbox preservation (audit M4)", () => {
  test("preserve keeps the diagnostic set and drops dependency stores, caches, and sockets", async () => {
    const destinationRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "e2e-harness-preserve-"),
    )
    const sandbox = await createSandbox("harness-preserve")
    const socketServer = net.createServer()
    try {
      // Diagnostics a failing test wants back.
      await fs.writeFile(
        path.join(sandbox.artifacts, "server.stdout.log"),
        "log line\n",
      )
      await fs.writeFile(path.join(sandbox.project, "opencode.json"), "{}\n")
      await fs.writeFile(
        path.join(sandbox.config, "package.json"),
        `{"dependencies":{}}\n`,
      )
      const environment = await sandbox.environment("server")
      const instanceLogs = path.join(
        environment.XDG_DATA_HOME as string,
        "opencode",
        "log",
      )
      await fs.mkdir(instanceLogs, { recursive: true })
      await fs.writeFile(
        path.join(instanceLogs, "opencode.log"),
        "server log\n",
      )

      // Reconstructable state that must never be preserved: the dependency
      // tree OpenCode installs under its config dir, the npm cache it fills
      // doing so, per-instance XDG caches, and the bun install root.
      const dependencyTree = path.join(
        sandbox.config,
        "node_modules",
        "leftpad",
      )
      await fs.mkdir(dependencyTree, { recursive: true })
      await fs.writeFile(
        path.join(dependencyTree, "index.js"),
        "module.exports = 1\n",
      )
      const npmCache = path.join(sandbox.home, ".npm", "_cacache", "content-v2")
      await fs.mkdir(npmCache, { recursive: true })
      await fs.writeFile(path.join(npmCache, "blob"), "cached\n")
      await fs.mkdir(path.join(sandbox.home, ".npm", "_logs"), {
        recursive: true,
      })
      await fs.writeFile(
        path.join(sandbox.home, ".npm", "_logs", "install.log"),
        "npm log\n",
      )
      const instanceCache = path.join(
        environment.XDG_CACHE_HOME as string,
        "opencode",
        "bin",
      )
      await fs.mkdir(instanceCache, { recursive: true })
      await fs.writeFile(path.join(instanceCache, "tool"), "binary\n")
      await fs.mkdir(path.join(sandbox.root, "bun-install"), {
        recursive: true,
      })
      await fs.writeFile(
        path.join(sandbox.root, "bun-install", "artifact"),
        "bun\n",
      )
      await fs.writeFile(path.join(sandbox.root, "tmp", "scratch"), "scratch\n")

      // Fixtures tests place directly at the sandbox root (a crafted
      // models.dev catalog, a secondary worktree checkout) are diagnostics
      // too — only the named reconstructable roots may be dropped.
      await fs.writeFile(path.join(sandbox.root, "models.json"), "{}\n")
      await fs.mkdir(path.join(sandbox.root, "worktree-checkout"), {
        recursive: true,
      })
      await fs.writeFile(
        path.join(sandbox.root, "worktree-checkout", "README.md"),
        "checkout\n",
      )

      // A live unix socket must neither be copied nor sink the snapshot.
      const socketPath = path.join(sandbox.home, "live.sock")
      await new Promise<void>((resolve, reject) => {
        socketServer.once("error", reject)
        socketServer.listen(socketPath, resolve)
      })

      const destination = await withArtifactsDir(destinationRoot, () =>
        sandbox.preserve("harness-preserve"),
      )

      expect(await exists(destination, "artifacts", "server.stdout.log")).toBe(
        true,
      )
      expect(await exists(destination, "project", "opencode.json")).toBe(true)
      expect(
        await exists(destination, "xdg", "config", "opencode", "package.json"),
      ).toBe(true)
      expect(
        await exists(
          destination,
          "instances",
          "server",
          "data",
          "opencode",
          "log",
          "opencode.log",
        ),
      ).toBe(true)
      expect(
        await exists(destination, "home", ".npm", "_logs", "install.log"),
      ).toBe(true)
      expect(await exists(destination, "preserve.json")).toBe(true)
      expect(await exists(destination, "models.json")).toBe(true)
      expect(await exists(destination, "worktree-checkout", "README.md")).toBe(
        true,
      )

      expect(
        await exists(destination, "xdg", "config", "opencode", "node_modules"),
      ).toBe(false)
      expect(await exists(destination, "home", ".npm", "_cacache")).toBe(false)
      expect(await exists(destination, "instances", "server", "cache")).toBe(
        false,
      )
      expect(await exists(destination, "bun-install")).toBe(false)
      expect(await exists(destination, "tmp")).toBe(false)
      expect(await exists(destination, "home", "live.sock")).toBe(false)
      expect(await exists(destination, OWNER_MARKER)).toBe(false)
    } finally {
      socketServer.close()
      await sandbox.cleanup()
      await fs.rm(destinationRoot, { recursive: true, force: true })
    }
  })

  test("preserve stops this sandbox's registered resources before it copies", async () => {
    const destinationRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "e2e-harness-stop-"),
    )
    const sandbox = await createSandbox("harness-stop")
    const other = await createSandbox("harness-stop-other")
    let otherStopped = false
    const unregisterOther = registerResource({
      kind: "opencode",
      home: other.home,
      stop: async () => {
        otherStopped = true
      },
      killSync: () => {},
    })
    try {
      // The proof of ordering: stop() plants a file that only lands in the
      // snapshot if quiescing happened before the copy.
      registerResource({
        kind: "opencode",
        home: sandbox.home,
        stop: async () => {
          await fs.writeFile(
            path.join(sandbox.artifacts, "stopped-before-copy.txt"),
            "yes\n",
          )
        },
        killSync: () => {},
      })
      const destination = await withArtifactsDir(destinationRoot, () =>
        sandbox.preserve("harness-stop"),
      )
      expect(
        await exists(destination, "artifacts", "stopped-before-copy.txt"),
      ).toBe(true)
      expect(otherStopped).toBe(false)
    } finally {
      unregisterOther()
      await sandbox.cleanup()
      await other.cleanup()
      await fs.rm(destinationRoot, { recursive: true, force: true })
    }
  })
})

describe("stale-resource sweep (audit M9)", () => {
  test("removes sandboxes owned by dead processes, keeps live and fresh ones", async () => {
    const scratch = await fs.mkdtemp(
      path.join(os.tmpdir(), "e2e-harness-sweep-"),
    )
    try {
      const deadPid = spawnSync("true").pid
      expect(typeof deadPid).toBe("number")

      const stale = path.join(scratch, "opencode-e2e-stale-x")
      await fs.mkdir(stale, { recursive: true })
      await fs.writeFile(
        path.join(stale, OWNER_MARKER),
        `${JSON.stringify({ pid: deadPid })}\n`,
      )
      const live = path.join(scratch, "opencode-e2e-live-x")
      await fs.mkdir(live, { recursive: true })
      await fs.writeFile(
        path.join(live, OWNER_MARKER),
        `${JSON.stringify({ pid: process.pid })}\n`,
      )
      const unmarked = path.join(scratch, "opencode-e2e-unmarked-x")
      await fs.mkdir(unmarked, { recursive: true })
      const unrelated = path.join(scratch, "unrelated")
      await fs.mkdir(unrelated, { recursive: true })

      await sweepStaleResources({
        sandboxRoot: scratch,
        tmuxRoot: path.join(scratch, "no-tmux"),
        procRoot: false,
      })

      expect(await exists(stale)).toBe(false)
      expect(await exists(live)).toBe(true)
      // Unmarked but fresh: could be a sandbox being born right now.
      expect(await exists(unmarked)).toBe(true)
      expect(await exists(unrelated)).toBe(true)
    } finally {
      await fs.rm(scratch, { recursive: true, force: true })
    }
  })

  test("removes tmux sockets whose embedded owner pid is dead", async () => {
    const scratch = await fs.mkdtemp(
      path.join(os.tmpdir(), "e2e-harness-tmux-sweep-"),
    )
    try {
      const deadPid = spawnSync("true").pid
      const staleSocket = path.join(scratch, `opencode-e2e-${deadPid}-stale`)
      await fs.writeFile(staleSocket, "")
      const liveSocket = path.join(scratch, `opencode-e2e-${process.pid}-live`)
      await fs.writeFile(liveSocket, "")
      const foreignSocket = path.join(scratch, "default")
      await fs.writeFile(foreignSocket, "")

      await sweepStaleResources({
        sandboxRoot: scratch,
        tmuxRoot: scratch,
        procRoot: false,
      })

      expect(await exists(staleSocket)).toBe(false)
      expect(await exists(liveSocket)).toBe(true)
      expect(await exists(foreignSocket)).toBe(true)
    } finally {
      await fs.rm(scratch, { recursive: true, force: true })
    }
  })

  test("a resource whose stop fails stays registered for the exit fallback", async () => {
    let stops = 0
    const home = path.join(os.tmpdir(), `e2e-harness-wedged-${process.pid}`)
    const unregister = registerResource({
      kind: "opencode",
      home,
      stop: async () => {
        stops += 1
        if (stops === 1) throw new Error("wedged")
      },
      killSync: () => {},
    })
    try {
      await stopSandboxResources(home)
      expect(stops).toBe(1)
      // Still registered after the failure: a later pass retries it.
      await stopSandboxResources(home)
      expect(stops).toBe(2)
      // The successful stop unregistered it: no third call.
      await stopSandboxResources(home)
      expect(stops).toBe(2)
    } finally {
      unregister()
    }
  })
})

describe("command process-group cleanup (audit M9)", () => {
  const commandEnv = {
    PATH: process.env.PATH ?? "",
    // Hygiene: if this test process dies mid-test, the next run's sweep can
    // still find and kill the sleeping group.
    [OWNER_ENVIRONMENT_VARIABLE]: String(process.pid),
  }

  test.skipIf(process.platform === "win32")(
    "a timed-out command's descendants die with it",
    async () => {
      const scratch = await fs.mkdtemp(
        path.join(os.tmpdir(), "e2e-harness-command-"),
      )
      const pidFile = path.join(scratch, "descendant.pid")
      try {
        const command = runOpenCodeCommand({
          binary: "sh",
          args: ["-c", `sleep 300 & echo $! > "${pidFile}"; wait`],
          cwd: scratch,
          env: commandEnv,
          timeout: 1_500,
        })
        await expect(command).rejects.toThrow(/timed out/)
        const pid = Number((await fs.readFile(pidFile, "utf8")).trim())
        expect(pid).toBeGreaterThan(0)
        // SIGTERM lands at timeout and SIGKILL 2s later; the whole detached
        // process group — the descendant included — must be gone.
        expect(await waitUntil(() => !alive(pid), 4_000)).toBe(true)
      } finally {
        await fs.rm(scratch, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(process.platform === "win32")(
    "the group is killed even after its leader exited",
    async () => {
      const scratch = await fs.mkdtemp(
        path.join(os.tmpdir(), "e2e-harness-leader-"),
      )
      const pidFile = path.join(scratch, "descendant.pid")
      try {
        // The leader exits immediately; its background child inherits the stdio
        // pipes, so `close` never fires and the command runs into its timeout.
        // Teardown must still signal the group the exited leader named.
        const command = runOpenCodeCommand({
          binary: "sh",
          args: ["-c", `sleep 300 & echo $! > "${pidFile}"`],
          cwd: scratch,
          env: commandEnv,
          timeout: 1_500,
        })
        await expect(command).rejects.toThrow(/timed out/)
        const pid = Number((await fs.readFile(pidFile, "utf8")).trim())
        expect(pid).toBeGreaterThan(0)
        expect(await waitUntil(() => !alive(pid), 4_000)).toBe(true)
      } finally {
        await fs.rm(scratch, { recursive: true, force: true })
      }
    },
  )
})

describe("sandbox exit cleanup (audit M9)", () => {
  test("a process that exits without cleanup removes its sandbox on the way out", async () => {
    const scratch = await fs.mkdtemp(
      path.join(os.tmpdir(), "e2e-harness-exit-"),
    )
    let root = ""
    try {
      const script = path.join(scratch, "create-and-exit.ts")
      await fs.writeFile(
        script,
        `import { createSandbox } from ${JSON.stringify(path.join(import.meta.dir, "sandbox.ts"))}\n` +
          `const sandbox = await createSandbox("harness-exit-cleanup", { git: false })\n` +
          `console.log(sandbox.root)\n`,
      )
      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        timeout: 30_000,
      })
      expect(result.status).toBe(0)
      root = result.stdout.trim().split("\n").pop() ?? ""
      expect(root).toContain("opencode-e2e-")
      expect(await exists(root)).toBe(false)
    } finally {
      if (root) await fs.rm(root, { recursive: true, force: true })
      await fs.rm(scratch, { recursive: true, force: true })
    }
  })
})

describe("tmux server teardown (audit M9)", () => {
  const noServer = /no server running|error connecting/i

  test.skipIf(process.platform === "win32" || !Bun.which("tmux"))(
    "stop kills the per-run tmux server even under exit-empty off",
    async () => {
      const scratch = await fs.mkdtemp(
        path.join(os.tmpdir(), "e2e-harness-tmux-server-"),
      )
      let socket: string | undefined
      try {
        const tui = await startTmuxTui({
          binary: "sh",
          directory: scratch,
          env: { PATH: process.env.PATH ?? "" },
        })
        socket = tui.socket
        // A developer's tmux configuration can keep the server alive after
        // its last session dies; teardown must kill the server itself.
        const configured = spawnSync(
          "tmux",
          ["-L", socket, "set-option", "-s", "exit-empty", "off"],
          {
            encoding: "utf8",
          },
        )
        expect(configured.status).toBe(0)
        await tui.stop()
        const gone = await waitUntil(() => {
          const probe = spawnSync(
            "tmux",
            ["-L", socket as string, "has-session"],
            { encoding: "utf8" },
          )
          return probe.status !== 0 && noServer.test(probe.stderr)
        }, 3_000)
        expect(gone).toBe(true)
      } finally {
        if (socket)
          spawnSync("tmux", ["-L", socket, "kill-server"], {
            stdio: "ignore",
            timeout: 5_000,
          })
        await fs.rm(scratch, { recursive: true, force: true })
      }
    },
  )
})

// The supply-chain fail-closed paths: every executed binary must trace back to
// a checksum, so a cached binary whose sha256 no longer matches its sidecar is
// refused, and a payload with no sidecar is treated as "not installed" (never
// trusted on a self-report). These only run when something is already wrong, so
// the happy path every e2e run takes proves nothing about them. Both cases are
// offline and deterministic: the mismatch throws before any download, and the
// no-sidecar case falls through to a version with no committed checksum, which
// refuses before any fetch. Each drives the real resolveOpenCodeBinary in a
// SUBPROCESS (CI=1, XDG_CACHE_HOME staged) because the module memoizes its
// resolution and the non-CI $PATH shortcut returns before the cache is read —
// the same spawn-a-child precedent the sandbox-exit test above uses.
//
// NOT covered here, and recorded rather than papered over: the "a committed pin
// always beats an OPENCODE_E2E_SHA256 override" rule (opencode-binary.ts:224-246)
// is not offline-testable without exporting verifyCachedBinary or injecting
// fetch/RELEASE_URL_BASE — reaching the comparison requires a real download.
describe("binary checksum fail-closed (audit harness-checksum-failclosed-untested)", () => {
  const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..")
  const binaryModule = path.join(import.meta.dir, "opencode-binary.ts")

  async function pinnedVersion(): Promise<string> {
    return (
      await fs.readFile(path.join(REPO_ROOT, ".opencode-version"), "utf8")
    ).trim()
  }

  // A driver that resolves the real binary and reports the outcome: the resolved
  // path on success (which must NOT happen for these staged caches) or the
  // rejection message on the fail-closed throw.
  async function writeDriver(dir: string): Promise<string> {
    const driver = path.join(dir, "resolve.ts")
    await fs.writeFile(
      driver,
      `import { resolveOpenCodeBinary } from ${JSON.stringify(binaryModule)}\n` +
        `resolveOpenCodeBinary().then(\n` +
        `  (p) => { console.log("RESOLVED:" + p); process.exit(0) },\n` +
        `  (e) => { console.error("REJECTED:" + (e?.message ?? String(e))); process.exit(7) },\n` +
        `)\n`,
    )
    return driver
  }

  function resolveInSubprocess(
    driver: string,
    cacheHome: string,
    extraEnv: Record<string, string> = {},
  ) {
    const env = { ...process.env, ...extraEnv }
    // Force the cache path (CI=1 skips the $PATH shortcut) and clear anything
    // that would short-circuit resolution before the cache is consulted.
    env.CI = "1"
    env.XDG_CACHE_HOME = cacheHome
    delete env.OPENCODE_BIN
    delete env.OPENCODE_E2E_SHA256
    return spawnSync(process.execPath, [driver], {
      encoding: "utf8",
      timeout: 60_000,
      env,
    })
  }

  test("refuses a cached binary whose sha256 no longer matches its sidecar", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-checksum-"))
    try {
      const version = await pinnedVersion()
      const cacheHome = path.join(scratch, "cache")
      const versionDir = path.join(cacheHome, "macarons-e2e", version)
      await fs.mkdir(versionDir, { recursive: true })

      const payload = Buffer.from("this is not a real opencode binary\n")
      const found = crypto.createHash("sha256").update(payload).digest("hex")
      const recorded = "0".repeat(64) // a valid-shaped hash that does not match
      await fs.writeFile(path.join(versionDir, "opencode"), payload)
      await fs.writeFile(
        path.join(versionDir, "opencode.sha256"),
        `${recorded}\n`,
      )

      const driver = await writeDriver(scratch)
      const result = resolveInSubprocess(driver, cacheHome)
      const out = `${result.stdout}${result.stderr}`

      // Fail closed: refuse rather than resolve, and name BOTH digests so the
      // operator can see what was recorded vs. what was found.
      expect(result.status).not.toBe(0)
      expect(out).toContain(
        "no longer matches its install-time SHA-256 sidecar",
      )
      expect(out).toContain(recorded)
      expect(out).toContain(found)
      expect(out).not.toContain("RESOLVED:")
    } finally {
      await fs.rm(scratch, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")(
    "a payload with no sidecar is not trusted, even when it self-reports the right version",
    async () => {
      const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-checksum-"))
      try {
        // A version with no committed checksum: once the staged payload is
        // (correctly) rejected for lacking a sidecar, downloadPinned has no pin
        // to trust and refuses BEFORE any network fetch — an offline, determinate
        // signal that the fall-through happened.
        const version = "9999.0.0"
        const cacheHome = path.join(scratch, "cache")
        const versionDir = path.join(cacheHome, "macarons-e2e", version)
        await fs.mkdir(versionDir, { recursive: true })

        // An EXECUTABLE payload that self-reports the expected version but has no
        // sidecar. The supply-chain property under test: it must never be
        // executed or trusted. Under the mutant that trusts a sidecar-less
        // payload, the version probe would run this script, match, and RESOLVE it.
        const staged = path.join(versionDir, "opencode")
        await fs.writeFile(staged, `#!/bin/sh\necho ${version}\n`)
        await fs.chmod(staged, 0o755)

        const driver = await writeDriver(scratch)
        const result = resolveInSubprocess(driver, cacheHome, {
          OPENCODE_E2E_VERSION: version,
        })
        const out = `${result.stdout}${result.stderr}`

        expect(result.status).not.toBe(0)
        expect(out).toContain(`No pinned SHA-256 for OpenCode ${version}`)
        // The staged binary was never trusted/returned.
        expect(out).not.toContain(`RESOLVED:${staged}`)
      } finally {
        await fs.rm(scratch, { recursive: true, force: true })
      }
    },
  )
})

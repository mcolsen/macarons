import { type ChildProcessByStdio, spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import type { Readable } from "node:stream"
import {
  EXPECTED_OPENCODE_VERSION,
  resolveOpenCodeBinary,
} from "./opencode-binary"
import { registerResource } from "./registry"

const DEFAULT_TIMEOUT = 30_000

export type OpenCodeProcess = {
  readonly binary: string
  readonly url: string
  readonly version: string
  readonly stdout: () => string
  readonly stderr: () => string
  isRunning(): boolean
  writeDiagnostics(directory: string): Promise<void>
  stop(): Promise<void>
}

export type OpenCodeCommandResult = {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
  readonly stdout: string
}

type StartOptions = {
  cwd: string
  env: Record<string, string>
  binary?: string
  expectedVersion?: string
  timeout?: number
}

type CommandOptions = {
  args: string[]
  cwd: string
  env: Record<string, string>
  binary?: string
  timeout?: number
}

type OpenCodeChild = ChildProcessByStdio<null, Readable, Readable>

// A spawned child plus whether its `close` event has fired. The leader's
// exit status is not enough for teardown: descendants in its (detached)
// process group can outlive it holding the stdio pipes, and only `close`
// proves the group has let go — so kill/wait key on `close`, never on
// `exitCode`.
type ManagedChild = {
  readonly child: OpenCodeChild
  closed: boolean
}

function manage(child: OpenCodeChild): ManagedChild {
  const managed: ManagedChild = { child, closed: false }
  child.once("close", () => {
    managed.closed = true
  })
  return managed
}

function trimVersion(value: string) {
  return value.trim().replace(/^v/, "")
}

function exitError(
  binary: string,
  stdout: () => string,
  stderr: () => string,
  code: number | null,
  signal: NodeJS.Signals | null,
) {
  return new Error(
    `${binary} exited before listening (code=${code ?? "unknown"}, signal=${signal ?? "none"}).\nstdout:\n${stdout()}\nstderr:\n${stderr()}`,
  )
}

function killChild(managed: ManagedChild, signal: NodeJS.Signals) {
  if (managed.closed) return
  const { child } = managed
  try {
    if (process.platform !== "win32" && child.pid) {
      // Signalled even when the leader already exited: until `close`, its
      // descendants keep the group — and the sandbox — alive.
      process.kill(-child.pid, signal)
      return
    }
  } catch {
    // The whole group is already gone.
  }
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill(signal)
  } catch {
    // Teardown should be idempotent.
  }
}

async function waitForClose(managed: ManagedChild, timeout: number) {
  if (managed.closed) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeout)
    managed.child.once("close", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function stopChild(managed: ManagedChild) {
  killChild(managed, "SIGTERM")
  await waitForClose(managed, 2_000)
  if (!managed.closed) {
    killChild(managed, "SIGKILL")
    await waitForClose(managed, 2_000)
  }
}

/** Safety net (audit M9): every spawned child is registered until it closes. */
function registerChild(managed: ManagedChild, home: string | undefined) {
  const unregister = registerResource({
    kind: "opencode",
    home,
    stop: () => stopChild(managed),
    killSync: () => killChild(managed, "SIGKILL"),
  })
  managed.child.once("close", unregister)
}

async function readVersion(
  binary: string,
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  const child = spawn(binary, ["--version"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const result = await new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal }))
  })
  if (result.code !== 0) {
    throw new Error(
      `${binary} --version failed (code=${result.code}, signal=${result.signal}). ${stderr}`,
    )
  }
  const version = trimVersion(stdout)
  if (!version) throw new Error(`${binary} --version returned no version`)
  return version
}

export async function runOpenCodeCommand(
  options: CommandOptions,
): Promise<OpenCodeCommandResult> {
  const binary = options.binary ?? (await resolveOpenCodeBinary())
  const timeout = options.timeout ?? DEFAULT_TIMEOUT
  const child = spawn(binary, options.args, {
    cwd: options.cwd,
    // A process-group leader, like the server: on timeout the group kill must
    // reach descendants (package managers the CLI spawns), not just the CLI.
    detached: process.platform !== "win32",
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const managed = manage(child)
  registerChild(managed, options.env.HOME)
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  return new Promise<OpenCodeCommandResult>((resolve, reject) => {
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      killChild(managed, "SIGTERM")
      killTimer = setTimeout(() => killChild(managed, "SIGKILL"), 2_000)
      reject(
        new Error(
          `${binary} ${options.args.join(" ")} timed out after ${timeout}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      )
    }, timeout)
    child.once("error", (error) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      reject(error)
    })
    child.once("close", (code, signal) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ code, signal, stderr, stdout })
    })
  })
}

export async function startOpenCode(
  options: StartOptions,
): Promise<OpenCodeProcess> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT
  const binary = options.binary ?? (await resolveOpenCodeBinary())
  const expectedVersion = options.expectedVersion ?? EXPECTED_OPENCODE_VERSION
  const version = await readVersion(binary, options.cwd, options.env)
  if (expectedVersion && version !== expectedVersion) {
    throw new Error(
      `Expected OpenCode ${expectedVersion}, found ${version} at ${binary}`,
    )
  }

  const child = spawn(
    binary,
    [
      "serve",
      "--hostname=127.0.0.1",
      "--port=0",
      "--print-logs",
      "--log-level=DEBUG",
    ],
    {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const managed = manage(child)
  registerChild(managed, options.env.HOME)
  let stdout = ""
  let stderr = ""
  let serverURL: string | undefined
  const consume = (chunk: Buffer, append: (text: string) => void) => {
    append(chunk.toString())
    const match = `${stdout}\n${stderr}`.match(
      /opencode server listening on\s+(https?:\/\/[^\s]+)/i,
    )
    if (match) serverURL = match[1]
  }
  child.stdout.on("data", (chunk: Buffer) =>
    consume(chunk, (text) => (stdout += text)),
  )
  child.stderr.on("data", (chunk: Buffer) =>
    consume(chunk, (text) => (stderr += text)),
  )

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `Timed out after ${timeout}ms waiting for ${binary} to listen.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      )
    }, timeout)
    const check = () => {
      if (!serverURL) return
      cleanup()
      resolve(serverURL)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(
        exitError(
          binary,
          () => stdout,
          () => stderr,
          code,
          signal,
        ),
      )
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off("error", onError)
      child.off("close", onClose)
      child.stdout.off("data", check)
      child.stderr.off("data", check)
    }
    child.on("error", onError)
    child.on("close", onClose)
    // Stream handlers above collect output. These observers only wake up the
    // readiness check after each chunk, preserving the full artifact log.
    child.stdout.on("data", check)
    child.stderr.on("data", check)
    check()
  }).catch(async (error) => {
    await stopChild(managed)
    throw error
  })

  const healthDeadline = Date.now() + timeout
  let healthy = false
  let healthError: unknown
  while (Date.now() < healthDeadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw exitError(
        binary,
        () => stdout,
        () => stderr,
        child.exitCode,
        child.signalCode,
      )
    }
    try {
      // Each probe is bounded by what is left of the startup window, so one
      // hung fetch cannot outlive the deadline it is meant to enforce.
      const remaining = Math.max(healthDeadline - Date.now(), 1)
      const response = await fetch(`${url}/global/health`, {
        signal: AbortSignal.timeout(remaining),
      })
      if (response.ok) {
        healthy = true
        break
      }
      healthError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      healthError = error
    }
    await Bun.sleep(25)
  }
  if (!healthy) {
    await stopChild(managed)
    throw new Error(
      `OpenCode listened at ${url} but never passed /global/health: ${String(healthError)}`,
    )
  }

  return {
    binary,
    url,
    version,
    stdout: () => stdout,
    stderr: () => stderr,
    isRunning: () => child.exitCode === null && child.signalCode === null,
    async writeDiagnostics(directory) {
      await fs.mkdir(directory, { recursive: true })
      await Promise.all([
        fs.writeFile(path.join(directory, "opencode.stdout.log"), stdout),
        fs.writeFile(path.join(directory, "opencode.stderr.log"), stderr),
        fs.writeFile(
          path.join(directory, "opencode.process.json"),
          `${JSON.stringify({ binary, url, version }, null, 2)}\n`,
        ),
      ])
    },
    async stop() {
      await stopChild(managed)
    },
  }
}

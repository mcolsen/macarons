import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { resolveOpenCodeBinary } from "./opencode-binary"
import { registerResource } from "./registry"

const DEFAULT_TIMEOUT = 30_000

type CommandResult = { code: number | null; stderr: string; stdout: string }

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function runTmux(
  args: string[],
  timeout = 5_000,
): Promise<CommandResult> {
  const child = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`tmux ${args.join(" ")} timed out after ${timeout}ms`))
    }, timeout)
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stderr, stdout })
    })
  })
}

function safeName(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9_-]+/g, "-")
}

export type TmuxTui = {
  readonly socket: string
  readonly session: string
  capture(): Promise<string>
  sendKey(key: string): Promise<void>
  type(text: string): Promise<void>
  waitForText(match: string | RegExp, timeout?: number): Promise<string>
  writeDiagnostics(directory: string): Promise<void>
  stop(): Promise<void>
}

export async function startTmuxTui(input: {
  binary?: string
  directory: string
  env: Record<string, string>
  /** Attach to an external server. Omitted, the TUI runs standalone: the host lives in-process and serverUrl is never bound. */
  serverURL?: string
  sessionID?: string
  tuiConfig?: string
}): Promise<TmuxTui> {
  const socket = safeName(
    `opencode-e2e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  const session = "tui"
  const binary = input.binary ?? (await resolveOpenCodeBinary())
  const environment = {
    ...input.env,
    ...(input.tuiConfig ? { OPENCODE_TUI_CONFIG: input.tuiConfig } : {}),
    TERM: "xterm-256color",
  }
  const argv = input.serverURL
    ? [
        binary,
        "attach",
        input.serverURL,
        "--dir",
        input.directory,
        ...(input.sessionID ? ["--session", input.sessionID] : []),
      ]
    : [binary]
  const command = [
    "env",
    "-i",
    ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    ...argv,
  ]
    .map(quote)
    .join(" ")
  const started = await runTmux([
    "-L",
    socket,
    "new-session",
    "-d",
    "-s",
    session,
    "-x",
    "200",
    "-y",
    "50",
    "-c",
    input.directory,
    command,
  ])
  if (started.code !== 0) {
    throw new Error(
      `Could not start tmux TUI (exit ${started.code}).\n${started.stderr}`,
    )
  }

  const target = `${session}:0.0`
  const capture = async () => {
    const result = await runTmux([
      "-L",
      socket,
      "capture-pane",
      "-p",
      "-J",
      "-t",
      target,
    ])
    if (result.code !== 0)
      throw new Error(
        `Could not capture TUI pane (exit ${result.code}).\n${result.stderr}`,
      )
    return result.stdout
  }
  const stopServer = async () => {
    // Each TUI owns its own per-run tmux server behind a unique -L socket, so
    // whole-server teardown is exact. kill-session would not be: under the
    // developer's tmux configuration (`exit-empty off` — runTmux inherits the
    // real environment) the server survives its last session. Throws when the
    // server is not confirmed gone, so callers keep the registry fallback.
    const result = await runTmux(["-L", socket, "kill-server"])
    if (
      result.code !== 0 &&
      !/no server running|error connecting/i.test(result.stderr)
    ) {
      throw new Error(
        `tmux kill-server on socket ${socket} exited ${result.code ?? "unknown"}.\n${result.stderr}`,
      )
    }
  }
  // Safety net (audit M9): the per-run tmux server stays registered until the
  // TUI is stopped, so signals and `Sandbox.preserve` can tear it down.
  const unregister = registerResource({
    kind: "tmux",
    home: input.env.HOME,
    stop: stopServer,
    killSync: () => {
      try {
        spawnSync("tmux", ["-L", socket, "kill-server"], {
          stdio: "ignore",
          timeout: 5_000,
        })
      } catch {
        // Already gone, or tmux itself is — nothing left to leak.
      }
    },
  })
  return {
    socket,
    session,
    capture,
    async sendKey(key) {
      const result = await runTmux([
        "-L",
        socket,
        "send-keys",
        "-t",
        target,
        key,
      ])
      if (result.code !== 0)
        throw new Error(
          `Could not send TUI key ${JSON.stringify(key)}.\n${result.stderr}`,
        )
    },
    async type(text) {
      const result = await runTmux([
        "-L",
        socket,
        "send-keys",
        "-t",
        target,
        "-l",
        text,
      ])
      if (result.code !== 0)
        throw new Error(`Could not type into TUI.\n${result.stderr}`)
    },
    async waitForText(match, timeout = DEFAULT_TIMEOUT) {
      const deadline = Date.now() + timeout
      let pane = ""
      while (Date.now() < deadline) {
        pane = await capture()
        const found =
          typeof match === "string" ? pane.includes(match) : match.test(pane)
        if (found) return pane
        await Bun.sleep(50)
      }
      throw new Error(
        `Timed out after ${timeout}ms waiting for TUI text ${String(match)}.\nLast pane:\n${pane}`,
      )
    },
    async writeDiagnostics(directory) {
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(path.join(directory, "tmux-pane.txt"), await capture())
    },
    async stop() {
      // Cleanup must never throw, but a kill that was not confirmed keeps the
      // resource registered so the exit-time killSync still gets a shot.
      try {
        await stopServer()
      } catch (error) {
        console.error(
          `tmux server on socket ${socket} may be leaked: ${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }
      unregister()
    },
  }
}

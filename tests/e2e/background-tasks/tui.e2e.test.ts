import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { writeJsonFile } from "../../../libraries/permission-rules/src/index"
import {
  STATE_FILE_VERSION,
  type TaskSnapshot,
  tasksFilePath,
} from "../../../plugins/background-tasks/src/shared"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import { BACKGROUND_TASKS_TUI_ENTRY } from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import { startTmuxTui, type TmuxTui } from "../harness/tmux"

// Drives the real TUI (tmux) attached to a real server. The server half is NOT
// installed here: the test itself plants the state file at the exact path the
// TUI resolves from the server's reported state dir, standing in for the
// server half's writes. It proves the visual contract — the sidebar renders
// running tasks, hides finished/empty state, and filters out debris whose
// process is gone — driven purely off the state file and the fallback poll
// (no poke, since nothing publishes one without the server half).

const POLL_MS = 2_000

async function hostPaths(
  serverURL: string,
  directory: string,
): Promise<{ worktree: string; state: string }> {
  const client = createOpencodeClient({ baseUrl: serverURL, directory })
  const result = await client.path.get({ directory })
  const data = result.data as
    | { worktree?: unknown; state?: unknown; directory?: unknown }
    | undefined
  const worktree =
    typeof data?.worktree === "string" && data.worktree
      ? data.worktree
      : directory
  const state = data?.state
  if (typeof state !== "string" || !state)
    throw new Error("host did not report a state dir")
  // The TUI canonicalizes both before deriving the file path; match it.
  return {
    worktree: await fs.realpath(worktree),
    state: await fs.realpath(state),
  }
}

function runningTask(
  sessionID: string,
  pid: number,
  overrides: Partial<TaskSnapshot> = {},
): TaskSnapshot {
  return {
    id: "bg_1",
    name: "vite dev",
    command: "bunx vite --port 5173",
    workdir: "/project",
    sessionID,
    agent: "build",
    pid,
    state: "running",
    startedAt: Date.now() - 42_000,
    outputBytes: 20,
    droppedBytes: 0,
    recentOutput: "Listening on 5173\n",
    ...overrides,
  }
}

async function plantTasks(
  stateDir: string,
  worktree: string,
  tasks: TaskSnapshot[],
  instancePid = process.pid,
) {
  const instanceID = "e2e-instance"
  await writeJsonFile(tasksFilePath(stateDir, worktree, instanceID), {
    version: STATE_FILE_VERSION,
    instance: {
      id: instanceID,
      pid: instancePid,
      startedAt: Date.now() - 60_000,
    },
    updatedAt: Date.now(),
    tasks,
  })
}

async function writeTuiConfig(project: string): Promise<string> {
  const directory = path.join(project, ".opencode")
  await fs.mkdir(directory, { recursive: true })
  const file = path.join(directory, "tui.json")
  const spec = [
    pathToFileURL(BACKGROUND_TASKS_TUI_ENTRY).href,
    { pollMs: POLL_MS },
  ]
  await fs.writeFile(file, `${JSON.stringify({ plugin: [spec] }, null, 2)}\n`)
  return file
}

async function retainFailure(
  sandbox: Sandbox,
  server: OpenCodeProcess | undefined,
  tui: TmuxTui | undefined,
) {
  if (server)
    await server.writeDiagnostics(path.join(sandbox.artifacts, "server"))
  if (tui) await tui.writeDiagnostics(path.join(sandbox.artifacts, "tui"))
  const artifact = await sandbox.preserve("background-tasks-tui")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("background-tasks sidebar widget", () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("renders running tasks, hides them when the file empties, and filters dead-pid debris", async () => {
    const sandbox = await createSandbox("background-tasks-tui")
    let server: OpenCodeProcess | undefined
    let tui: TmuxTui | undefined
    // A real, live process so the TUI's liveness check keeps the task visible.
    const live = spawn("sleep", ["600"], { detached: true, stdio: "ignore" })
    live.unref()
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => tui?.stop())
    cleanups.push(async () => server?.stop())
    cleanups.push(async () => {
      try {
        process.kill(live.pid as number, "SIGKILL")
      } catch {
        // already gone
      }
    })

    try {
      const tuiConfig = await writeTuiConfig(sandbox.project)
      // Minimal config: no provider needed, the TUI never prompts.
      await fs.writeFile(
        path.join(sandbox.project, "opencode.json"),
        `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`,
      )
      server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("server"),
      })
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: sandbox.project,
      })
      const created = await client.session.create({
        directory: sandbox.project,
        title: "E2E background tasks",
      })
      if (created.error || !created.data)
        throw new Error(
          `Could not create session: ${JSON.stringify(created.error)}`,
        )
      const sessionID = created.data.id

      const { worktree, state } = await hostPaths(server.url, sandbox.project)
      await plantTasks(state, worktree, [
        runningTask(sessionID, live.pid as number),
      ])

      tui = await startTmuxTui({
        directory: sandbox.project,
        env: await sandbox.environment("tui"),
        serverURL: server.url,
        sessionID,
        tuiConfig,
      })

      // The running task shows, with its label and elapsed time.
      await tui.waitForText("Background tasks")
      await tui.waitForText("vite dev")

      // Emptying the file makes the whole section disappear (zero footprint).
      await plantTasks(state, worktree, [])
      const deadline = Date.now() + 10_000
      let pane = await tui.capture()
      while (Date.now() < deadline && pane.includes("Background tasks")) {
        await Bun.sleep(200)
        pane = await tui.capture()
      }
      expect(pane).not.toContain("Background tasks")

      // A running task whose process is gone is debris: the sidebar never
      // shows it (it belongs in the dialog, muted).
      await plantTasks(state, worktree, [
        runningTask(sessionID, 2, {
          id: "bg_stale",
          name: "ghost",
          pid: 2147480000,
        }),
      ])
      await Bun.sleep(POLL_MS + 1_500)
      expect(await tui.capture()).not.toContain("ghost")
    } catch (error) {
      await retainFailure(sandbox, server, tui)
      throw error
    }
  }, 90_000)
})

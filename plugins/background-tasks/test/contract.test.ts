import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { writeJsonFile } from "@macarons/permission-rules"
import {
  killRequestsDir,
  loadTasksFile,
  loadTasksFiles,
  parseKillRequest,
  STATE_FILE_VERSION,
  type TaskSnapshot,
  type TasksFile,
  tasksDirectory,
  tasksFilePath,
  writeKillRequest,
} from "../src/shared"

// The state files and the kill-request directory are the only channel between
// the two halves — which run in different processes in attach mode. These
// round trips pin the contract from both directions: what the server-side
// writer produces must parse through the TUI-side reader, and what the TUI
// writes must parse through the server-side sweeper's reader. The live
// halves are exercised against the same helpers in plugin.test.ts.

let sandbox: string
let project: string
let stateDir: string

beforeEach(async () => {
  sandbox = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "background-tasks-contract-")),
  )
  project = path.join(sandbox, "project")
  stateDir = path.join(sandbox, "state")
  await Promise.all([fs.mkdir(project), fs.mkdir(stateDir)])
})

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true })
})

test("server-shaped instance files written atomically read back as one registry", async () => {
  const task: TaskSnapshot = {
    id: "bg_3",
    name: "dev server",
    command: "bunx vite --port 5173",
    workdir: project,
    sessionID: "ses_A",
    agent: "build",
    pid: 4242,
    state: "running",
    startedAt: 1_720_000_000_000,
    outputBytes: 120,
    droppedBytes: 0,
    recentOutput: "Listening on 5173\n",
  }
  const file: TasksFile = {
    version: STATE_FILE_VERSION,
    instance: { id: "inst-1", pid: process.pid, startedAt: 1_720_000_000_000 },
    updatedAt: 1_720_000_000_500,
    tasks: [task],
  }
  const target = tasksFilePath(stateDir, project, file.instance.id)
  await writeJsonFile(target, file)
  expect(await loadTasksFile(target)).toEqual(file)
  expect(await loadTasksFiles(tasksDirectory(stateDir, project))).toEqual([
    file,
  ])
})

test("a TUI-written kill request parses through the server-side reader", async () => {
  const killDir = killRequestsDir(stateDir, project)
  await writeKillRequest(killDir, "bg_9")
  const entries = (await fs.readdir(killDir)).filter((entry) =>
    entry.endsWith(".json"),
  )
  expect(entries).toHaveLength(1)
  const [entryName] = entries
  expect(entryName).toStartWith("kill-bg_9-")
  if (entryName === undefined) throw new Error("expected a kill request file")
  const parsed = parseKillRequest(
    JSON.parse(await fs.readFile(path.join(killDir, entryName), "utf8")),
  )
  expect(parsed?.taskID).toBe("bg_9")
  // The timestamp lets a non-owner instance sweep provably stale requests.
  expect(parsed?.requestedAt).toBeGreaterThan(0)
})

test("concurrent kill requests for the same task never collide", async () => {
  const killDir = killRequestsDir(stateDir, project)
  await Promise.all([
    writeKillRequest(killDir, "bg_1"),
    writeKillRequest(killDir, "bg_1"),
  ])
  expect(
    (await fs.readdir(killDir)).filter((entry) => entry.endsWith(".json"))
      .length,
  ).toBe(2)
})

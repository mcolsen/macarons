import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { writeJsonFile } from "@macarons/permission-rules"
import { until } from "@macarons/plugin-test-harness"
import { describeGating } from "@macarons/plugin-test-harness/tui"
import {
  killRequestsDir,
  legacyTasksFilePath,
  parseKillRequest,
  STATE_FILE_VERSION,
  SYNC_COMMAND,
  type TaskSnapshot,
  type TasksFile,
  tasksFilePath,
} from "../src/shared"
import { makeApi } from "./harness"

// Engine-level surface (no render): compat + locality gating, command/binding
// registration, and the task-list dialog flows. The View's filtering and
// layout are pinned separately by test/view.test.tsx under the real solid
// renderer.

let sandbox: string
let project: string
let stateDir: string

beforeEach(async () => {
  sandbox = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "background-tasks-tui-")),
  )
  project = path.join(sandbox, "project")
  stateDir = path.join(sandbox, "state")
  await Promise.all([fs.mkdir(project), fs.mkdir(stateDir)])
})

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true })
})

function runningTask(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: "bg_1",
    name: "dev server",
    command: "bunx vite --port 5173",
    workdir: project,
    sessionID: "ses_1",
    agent: "build",
    pid: process.pid,
    state: "running",
    startedAt: Date.now() - 30_000,
    outputBytes: 10,
    droppedBytes: 0,
    recentOutput: "Listening on 5173\n",
    ...overrides,
  }
}

async function plantStateFile(
  tasks: TaskSnapshot[],
  instancePid = process.pid,
  instanceID = "inst-1",
) {
  const file: TasksFile = {
    version: STATE_FILE_VERSION,
    instance: {
      id: instanceID,
      pid: instancePid,
      startedAt: Date.now() - 60_000,
    },
    updatedAt: Date.now(),
    tasks,
  }
  await writeJsonFile(tasksFilePath(stateDir, project, instanceID), file)
}

function api(input: Parameters<typeof makeApi>[0] = {}) {
  return makeApi({
    paths: {
      state: stateDir,
      config: path.join(sandbox, "config"),
      worktree: project,
      directory: project,
    },
    ...input,
  })
}

// Let the load-time and open-time force-syncs (single-flight, possibly chained
// through pendingSync) fully resolve — resolveChannelPaths + fs.stat — before
// the caller plants a file. A plant that lands mid-flight could be picked up by
// a still-running sync, muddying which trigger caused the refresh.
async function drainSyncs(): Promise<void> {
  for (let i = 0; i < 5; i++) await Bun.sleep(20)
}

describeGating({
  remoteBails: true,
  load: async (input) => {
    const mock = api(input)
    await mock.load()
    const run = {
      toasts: mock.toasts,
      registered: mock.layers.length > 0,
      inert:
        mock.layers.length === 0 &&
        mock.slotPlugins.length === 0 &&
        mock.handlers.size === 0,
    }
    await mock.dispose()
    return run
  },
})

describe("commands and bindings", () => {
  test("registers the palette command (/bg) and the hidden sync command; no default keybind", async () => {
    const mock = api()
    await mock.load()
    const commands = mock.layers.flatMap((layer) => layer.commands ?? [])
    const list = commands.find(
      (command: any) => command.name === "background_tasks.list",
    )
    expect(list?.namespace).toBe("palette")
    expect(list?.slashName).toBe("bg")
    expect(list?.slashAliases).toEqual(["bgtasks"])
    const sync = commands.find((command: any) => command.name === SYNC_COMMAND)
    expect(sync).toBeDefined()
    expect(sync?.namespace).toBeUndefined()
    expect(mock.layers.flatMap((layer) => layer.bindings ?? [])).toHaveLength(0)
    await mock.dispose()
  })

  test("a configured keybind: first alternative visible on the command, the rest hidden behind a function", async () => {
    const mock = api({ options: { keybind: "<leader>k, ctrl+alt+k" } })
    await mock.load()
    const bindings = mock.layers.flatMap((layer) => layer.bindings ?? [])
    expect(bindings).toHaveLength(2)
    expect(bindings[0]).toMatchObject({
      key: "<leader>k",
      cmd: "background_tasks.list",
    })
    expect(bindings[1].key).toBe("ctrl+alt+k")
    expect(typeof bindings[1].cmd).toBe("function")
    await mock.dispose()
  })

  test("sidebar slot registers at order 160 unless disabled", async () => {
    const on = api()
    await on.load()
    expect(on.slotPlugins).toHaveLength(1)
    expect(on.slotPlugins[0].order).toBe(160)
    expect(Object.keys(on.slotPlugins[0].slots)).toEqual(["sidebar_content"])
    await on.dispose()
    const off = api({ options: { sidebar: false } })
    await off.load()
    expect(off.slotPlugins).toHaveLength(0)
    await off.dispose()
  })
})

describe("task list dialog", () => {
  test("paths still syncing: the list command toasts instead of opening a dialog", async () => {
    // No paths input: the core defaults every state.path entry to "" — the
    // host's placeholders before its path sync lands.
    const mock = makeApi()
    await mock.load()
    mock.listCommand()?.run()
    expect(mock.dialogs).toHaveLength(0)
    expect(
      mock.toasts.some((toast) =>
        String(toast.message).includes("still syncing"),
      ),
    ).toBe(true)
    await mock.dispose()
  })

  test("the event-bus poke alone refreshes the open dialog, grouped by session", async () => {
    // A 10-minute poll: the fallback poll provably cannot be what refreshes.
    const mock = api({ options: { pollMs: 600_000 } })
    await mock.load()
    // Open the dialog ONCE. openTaskList's own void sync(true) runs here (no
    // file yet) and captures the render thunk; the wait loop below re-invokes
    // that SAME thunk via lastDialog(), which reads groupsForSession fresh
    // WITHOUT forcing another sync — so only the poke can drive the refresh.
    mock.listCommand()?.run()
    await drainSyncs()
    expect(mock.lastDialog().options).toHaveLength(0)

    await plantStateFile([
      runningTask(),
      runningTask({ id: "bg_2", name: "worker", sessionID: "ses_other" }),
    ])
    // Still empty until something re-reads: the open-time force-sync is done
    // and the poll is 10 minutes away, so re-invoking the thunk sees nothing.
    expect(mock.lastDialog().options).toHaveLength(0)

    mock.poke()
    const start = Date.now()
    await until(() => mock.lastDialog().options.length === 2)
    // Landed on the poke's debounce (~100 ms), nowhere near the 10-min poll.
    expect(Date.now() - start).toBeLessThan(5_000)

    // The original grouping coverage: this session vs other sessions.
    const options = mock.lastDialog().options
    expect(options[0].category).toBe("This session")
    expect(options[0].title).toContain("dev server")
    expect(options[1].category).toBe("Other sessions")
    await mock.dispose()
  })

  test("the registered sync command's run() triggers the refresh too", async () => {
    // Pins the `run: () => pokeSync()` wiring the command test only asserts is
    // defined. A separate delivery path from the event bus above.
    const mock = api({ options: { pollMs: 600_000 } })
    await mock.load()
    mock.listCommand()?.run()
    await drainSyncs()
    expect(mock.lastDialog().options).toHaveLength(0)

    await plantStateFile([runningTask()])
    const syncCommand = mock.layers
      .flatMap((layer) => layer.commands ?? [])
      .find((command: any) => command.name === SYNC_COMMAND)
    if (!syncCommand?.run) throw new Error("sync command has no run()")
    // Still empty until the command fires.
    expect(mock.lastDialog().options).toHaveLength(0)

    syncCommand.run()
    const start = Date.now()
    await until(() => mock.lastDialog().options.length === 1)
    expect(Date.now() - start).toBeLessThan(5_000)
    await mock.dispose()
  })

  test("merges task snapshots from two live server instances", async () => {
    const mock = api({ options: { pollMs: 600_000 } })
    await Promise.all([
      plantStateFile(
        [runningTask({ id: "bg_aaaaaa_1", name: "first-server" })],
        process.pid,
        "inst-a",
      ),
      plantStateFile(
        [runningTask({ id: "bg_bbbbbb_1", name: "second-server" })],
        process.pid,
        "inst-b",
      ),
    ])
    // Current servers also publish this aggregate for older TUI halves. The
    // current TUI must prefer authoritative instance files while retaining a
    // marked legacy server that has no instance file of its own.
    await writeJsonFile(legacyTasksFilePath(stateDir, project), {
      version: STATE_FILE_VERSION,
      instance: {
        id: "inst-a",
        pid: process.pid,
        startedAt: Date.now() - 60_000,
      },
      aggregate: true,
      updatedAt: Date.now() + 1_000,
      tasks: [
        runningTask({ id: "bg_ghost00_1", name: "compatibility-ghost" }),
        runningTask({
          id: "bg_legacy0_1",
          name: "legacy-server",
          ownerInstance: {
            id: "legacy-server",
            pid: process.pid,
            startedAt: Date.now() - 60_000,
          },
          ownerFormat: "legacy",
        }),
      ],
    } satisfies TasksFile)
    await mock.load()
    await until(() => {
      mock.listCommand()?.run()
      return mock.lastDialog().options.length === 3
    })
    const rendered = JSON.stringify(mock.lastDialog().options)
    expect(rendered).toContain("first-server")
    expect(rendered).toContain("second-server")
    expect(rendered).toContain("legacy-server")
    expect(rendered).not.toContain("compatibility-ghost")
    await mock.dispose()
  })

  test("an aggregate-only fallback evaluates each task's original writer", async () => {
    const dead = Bun.spawn(["sh", "-c", "true"])
    await dead.exited
    const mock = api()
    await writeJsonFile(legacyTasksFilePath(stateDir, project), {
      version: STATE_FILE_VERSION,
      instance: {
        id: "aggregate-owner",
        pid: process.pid,
        startedAt: Date.now() - 60_000,
      },
      aggregate: true,
      updatedAt: Date.now(),
      tasks: [
        runningTask({
          id: "bg_live00_1",
          name: "live-writer",
          ownerInstance: {
            id: "live-writer",
            pid: process.pid,
            startedAt: Date.now() - 60_000,
          },
          ownerFormat: "instance",
        }),
        runningTask({
          id: "bg_dead00_1",
          name: "dead-writer",
          ownerInstance: {
            id: "dead-writer",
            pid: dead.pid,
            startedAt: Date.now() - 60_000,
          },
          ownerFormat: "instance",
        }),
      ],
    } satisfies TasksFile)
    await mock.load()
    await until(() => {
      mock.listCommand()?.run()
      return mock.lastDialog().options.length === 2
    })
    const options = mock.lastDialog().options as Array<{
      value: string
      category: string
    }>
    expect(
      options.find((option) => option.value === "bg_live00_1")?.category,
    ).toBe("This session")
    expect(
      options.find((option) => option.value === "bg_dead00_1")?.category,
    ).toBe("Stale (server gone)")
    await mock.dispose()
  })

  test("each option title carries the right glyph and status word per terminal state", async () => {
    // The existing grouping tests only assert `.toContain("dev server")`, which
    // survives a glyph/status-word mutant. This pins the whole matrix: running
    // ▶ + elapsed, killed ◼ + "killed", error ✗ + "error", and a nonzero exit
    // ✗ + "exit 1" (the || (exitCode ?? 0) !== 0 clause).
    const mock = api()
    await plantStateFile([
      runningTask({ id: "bg_run", name: "runner" }),
      runningTask({
        id: "bg_kill",
        name: "terminated",
        state: "killed",
        endedAt: Date.now() - 5_000,
      }),
      runningTask({
        id: "bg_err",
        name: "crashed",
        state: "error",
        errorMessage: "spawn failed",
        endedAt: Date.now() - 5_000,
      }),
      runningTask({
        id: "bg_exit1",
        name: "code-one",
        state: "exited",
        exitCode: 1,
        endedAt: Date.now() - 5_000,
      }),
    ])
    await mock.load()
    await until(() => {
      mock.listCommand()?.run()
      return mock.lastDialog().options.length === 4
    })
    const options = mock.lastDialog().options as Array<{
      value: string
      title: string
    }>
    const titleOf = (id: string) => {
      const option = options.find((candidate) => candidate.value === id)
      if (!option) throw new Error(`no dialog option for ${id}`)
      return option.title
    }

    // running → ▶ + an elapsed duration (~30s), never a terminal word.
    expect(titleOf("bg_run").startsWith("▶ ")).toBe(true)
    expect(titleOf("bg_run")).toMatch(/· \d+s$/)
    // killed → ◼ + "killed".
    expect(titleOf("bg_kill").startsWith("◼ ")).toBe(true)
    expect(titleOf("bg_kill").endsWith("· killed")).toBe(true)
    // error → ✗ + "error".
    expect(titleOf("bg_err").startsWith("✗ ")).toBe(true)
    expect(titleOf("bg_err").endsWith("· error")).toBe(true)
    // nonzero exit → ✗ (the exitCode clause) + "exit 1".
    expect(titleOf("bg_exit1").startsWith("✗ ")).toBe(true)
    expect(titleOf("bg_exit1").endsWith("· exit 1")).toBe(true)
    await mock.dispose()
  })

  test("a dead writer instance renders running entries as stale", async () => {
    const dead = Bun.spawn(["sh", "-c", "true"])
    await dead.exited
    const mock = api()
    await plantStateFile([runningTask()], dead.pid)
    await mock.load()
    await until(() => {
      mock.listCommand()?.run()
      return mock.lastDialog().options.length === 1
    })
    expect(mock.lastDialog().options[0].category).toBe("Stale (server gone)")
    await mock.dispose()
  })

  test("kill flow: confirm writes exactly one request file and no TUI toast", async () => {
    const mock = api()
    await plantStateFile([runningTask()])
    await mock.load()
    await until(() => {
      mock.listCommand()?.run()
      return mock.lastDialog().options.length === 1
    })
    mock.lastDialog().options[0].onSelect() // task → actions
    const actions = mock.lastDialog()
    const kill = actions.options.find((option: any) => option.value === "kill")
    expect(kill.disabled).toBe(false)
    kill.onSelect() // actions → confirm
    mock.lastDialog().onConfirm() // confirm → write request, back to list
    const killDir = killRequestsDir(stateDir, project)
    await until(async () => {
      const entries = await fs.readdir(killDir).catch(() => [] as string[])
      return entries.filter((entry) => entry.endsWith(".json")).length === 1
    })
    const [entry] = (await fs.readdir(killDir)).filter((name) =>
      name.endsWith(".json"),
    )
    if (entry === undefined) throw new Error("kill request file missing")
    const parsed = parseKillRequest(
      JSON.parse(await fs.readFile(path.join(killDir, entry), "utf8")),
    )
    expect(parsed?.taskID).toBe("bg_1")
    expect(parsed?.requestedAt).toBeGreaterThan(0)
    expect(mock.toasts).toHaveLength(0)
    await mock.dispose()
  })

  test("the pickup watchdog warns when the server half never reacts", async () => {
    const mock = api()
    await plantStateFile([runningTask()])
    await mock.load()
    await until(() => {
      mock.listCommand()?.run()
      return mock.lastDialog().options.length === 1
    })
    mock.lastDialog().options[0].onSelect()
    mock
      .lastDialog()
      .options.find((option: any) => option.value === "kill")
      .onSelect()
    mock.lastDialog().onConfirm()
    // Nothing sweeps the request and the pid stays alive → one warning.
    await until(() => mock.toasts.length > 0, { timeoutMs: 7_000 })
    const [warning] = mock.toasts
    if (warning === undefined) throw new Error("expected a warning toast")
    expect(warning.variant).toBe("warning")
    expect(String(warning.message)).toContain("not picked up")
    await mock.dispose()
  }, 10_000)

  test("copy uses OSC52 with the captured output; an empty capture just informs", async () => {
    const mock = api()
    await plantStateFile([
      runningTask(),
      runningTask({ id: "bg_2", recentOutput: undefined }),
    ])
    await mock.load()
    await until(() => {
      mock.listCommand()?.run()
      return mock.lastDialog().options.length === 2
    })
    mock.lastDialog().options[0].onSelect()
    mock
      .lastDialog()
      .options.find((option: any) => option.value === "copy")
      .onSelect()
    expect(mock.copied).toEqual(["Listening on 5173\n"])
    expect(mock.toasts.at(-1)?.variant).toBe("success")
    mock.listCommand()?.run()
    mock.lastDialog().options[1].onSelect()
    mock
      .lastDialog()
      .options.find((option: any) => option.value === "copy")
      .onSelect()
    expect(mock.copied).toHaveLength(1)
    expect(mock.toasts.at(-1)?.variant).toBe("info")
    await mock.dispose()
  })

  test("go to session navigates and closes the dialog", async () => {
    const mock = api()
    await plantStateFile([runningTask({ sessionID: "ses_elsewhere" })])
    await mock.load()
    await until(() => {
      mock.listCommand()?.run()
      return mock.lastDialog().options.length === 1
    })
    mock.lastDialog().options[0].onSelect()
    mock
      .lastDialog()
      .options.find((option: any) => option.value === "session")
      .onSelect()
    expect(mock.navigations).toEqual([
      { name: "session", params: { sessionID: "ses_elsewhere" } },
    ])
    await mock.dispose()
  })
})

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  BAND_SAMPLE_VERSIONS as BAND,
  evaluate,
  rulesFrom,
  type Store,
  writeJsonFile,
} from "@macarons/permission-rules"
import { BackgroundTasksPlugin } from "../src/index"
import * as processGroups from "../src/process-group"
import {
  isProcessAlive,
  killRequestsDir,
  legacyTasksFilePath,
  loadTasksFile,
  loadTasksFiles,
  MIN_NOTIFY_POST_TIMEOUT_MS,
  preSlugTasksFilePath,
  SNAPSHOT_TAIL_CHARS,
  SYNC_COMMAND,
  scopedTaskError,
  type TasksFile,
  tasksDirectory,
  tasksFilePath,
  writeKillRequest,
} from "../src/shared"

type Hooks = Awaited<ReturnType<typeof BackgroundTasksPlugin>>

let sandbox: string
let root: string
let stateDir: string
let active: Hooks | undefined
const groups = new Map<number, processGroups.ProcessGroup>()
let restoreSpawn = () => {}

async function loadStateFiles(): Promise<TasksFile[]> {
  return loadTasksFiles(tasksDirectory(stateDir, root))
}

async function loadStateFile(): Promise<TasksFile | undefined> {
  const files = await loadStateFiles()
  if (files.length > 1)
    throw new Error(
      `expected one background-task state file, found ${files.length}`,
    )
  return files[0]
}

beforeEach(async () => {
  // realpath: os.tmpdir() can sit behind a symlink (macOS /var → /private/var)
  // and the channel paths are canonicalized — expectations computed from the
  // raw root would name different files.
  sandbox = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "background-tasks-plugin-")),
  )
  root = path.join(sandbox, "project")
  stateDir = path.join(sandbox, "state")
  await Promise.all([fs.mkdir(root), fs.mkdir(stateDir)])
  active = undefined
  groups.clear()
  const spawn = processGroups.spawnProcessGroup
  const mocked = spyOn(processGroups, "spawnProcessGroup").mockImplementation(
    (...args) => {
      const group = spawn(...args)
      if (group.child.pid !== undefined) groups.set(group.child.pid, group)
      return group
    },
  )
  restoreSpawn = () => mocked.mockRestore()
})

afterEach(async () => {
  const disposing = active?.dispose?.()
  // Cleanup outside shutdown tests need not spend another grace period on every
  // retained keeper. Shutdown behavior is asserted before this fallback runs.
  await Promise.all(
    [...groups.values()].map((group) => group.signal("SIGKILL")),
  )
  await disposing
  restoreSpawn()
  await fs.rm(sandbox, { recursive: true, force: true })
})

type ClientKnobs = {
  /** Delay (ms) before session.get resolves — widens the notification's own await window. */
  getDelayMs?: (sessionID: string, call: number) => number
  /** "accept-missing" models a 204 without persistence; "persist-throw" loses the response after storage. */
  promptMode?: (
    input: any,
    call: number,
  ) =>
    | "resolve"
    | "accept-missing"
    | "hang"
    | "reject"
    | "throw"
    | "persist-throw"
  /** Exact-message confirmation transport. Default: consult persisted messages. */
  messageMode?: (
    input: any,
    call: number,
  ) => "resolve" | "throw" | "error" | "missing"
  /**
   * How the identity read behaves: "throw" rejects, "error" resolves with an
   * SDK error result (which the client does for every HTTP error), "empty"
   * resolves with a session carrying no pinned agent. Default: resolve.
   */
  getMode?: (
    sessionID: string,
    call: number,
  ) => "resolve" | "throw" | "error" | "empty"
  /**
   * How the busy/idle read behaves: "throw" rejects, "error" resolves with an
   * SDK error result, "hang" never settles unless its signal aborts. Default:
   * resolve with the status map.
   */
  statusMode?: (call: number) => "resolve" | "throw" | "error" | "hang"
}

/**
 * Mimics how the generated (v1) client treats `signal`: it is handed to the
 * underlying Request, so aborting REJECTS the in-flight call rather than
 * leaving it pending. Mocks that ignore the signal cannot distinguish a request
 * the plugin actually cancelled from one it merely stopped waiting on.
 */
function abortable<T>(
  signal: AbortSignal | undefined,
  start: (resolve: (value: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("The operation was aborted."))
    signal?.addEventListener(
      "abort",
      () => reject(new Error("The operation was aborted.")),
      { once: true },
    )
    start(resolve)
  })
}

// Mimics the generated SDK client: methods live on prototypes and read
// `this`, so a detached call throws synchronously exactly like the real one.
function makeClient(
  version: unknown = BAND.floor,
  statusMap: () => Record<string, unknown> = () => ({}),
  knobs: ClientKnobs = {},
) {
  const logs: any[] = []
  const toasts: any[] = []
  const prompts: any[] = []
  const publishes: any[] = []
  const statusReads: any[] = []
  const statusSignals: Array<AbortSignal | undefined> = []
  const messageReads: any[] = []
  const promptTimes: number[] = []
  const persistedMessages = new Set<string>()
  let getCalls = 0
  let promptCalls = 0
  let statusCalls = 0
  let messageCalls = 0
  class App {
    _client = {}
    log(input: any) {
      void this._client
      logs.push(input)
      return Promise.resolve({ data: true })
    }
  }
  class Tui {
    _client = {}
    showToast(input: any) {
      void this._client
      toasts.push(input)
      return Promise.resolve({ data: true })
    }
    publish(input: any) {
      void this._client
      publishes.push(input)
      return Promise.resolve({ data: true })
    }
  }
  class Session {
    _client = {}
    // The notification path reads the owning session to echo its pinned
    // agent/model/variant back on the injected prompt.
    get(input: any) {
      void this._client
      const mode = knobs.getMode?.(input.path.id, getCalls) ?? "resolve"
      if (mode === "throw")
        return Promise.reject(new Error("session read failed"))
      if (mode === "error")
        return Promise.resolve({ error: { name: "NotFound" } })
      const data =
        mode === "empty"
          ? { id: input.path.id }
          : {
              id: input.path.id,
              agent: "build",
              model: {
                providerID: "anthropic",
                id: "claude-x",
                variant: "max",
              },
            }
      const delay = knobs.getDelayMs?.(input.path.id, getCalls++) ?? 0
      if (!delay) return Promise.resolve({ data })
      return abortable(input.signal, (resolve) =>
        setTimeout(() => resolve({ data }), delay),
      )
    }
    promptAsync(input: any) {
      void this._client
      const mode = knobs.promptMode?.(input, promptCalls++) ?? "resolve"
      // Recorded before the mode is honored: a hung post has still been sent.
      prompts.push(input)
      promptTimes.push(Date.now())
      // A "hung" post is only ever released by its abort signal, exactly like
      // the real transport — so a test can tell a post that was CANCELLED from
      // one that was merely abandoned and could still land later.
      if (mode === "hang") return abortable(input.signal, () => {})
      if (mode === "reject")
        return Promise.resolve({ error: { name: "BadRequest" } })
      if (mode === "throw") return Promise.reject(new Error("transport failed"))
      if (mode !== "accept-missing" && input.body.messageID)
        persistedMessages.add(input.body.messageID)
      if (mode === "persist-throw")
        return Promise.reject(new Error("response lost after acceptance"))
      return Promise.resolve({
        data: undefined,
        response: new Response(null, { status: 204 }),
      })
    }
    message(input: any) {
      void this._client
      messageReads.push(input)
      const mode = knobs.messageMode?.(input, messageCalls++) ?? "resolve"
      if (mode === "throw")
        return Promise.reject(new Error("message read failed"))
      if (mode === "error")
        return Promise.resolve({ error: { name: "ServiceUnavailable" } })
      if (mode === "missing" || !persistedMessages.has(input.path.messageID))
        return Promise.resolve({ error: { name: "NotFound" } })
      return Promise.resolve({
        data: { info: { id: input.path.messageID, role: "user" }, parts: [] },
      })
    }
    status(input: any) {
      void this._client
      statusReads.push(input?.query)
      statusSignals.push(input?.signal)
      const mode = knobs.statusMode?.(statusCalls++) ?? "resolve"
      if (mode === "throw")
        return Promise.reject(new Error("status read failed"))
      if (mode === "error")
        return Promise.resolve({ error: { name: "ServiceUnavailable" } })
      // Only its signal releases it, exactly like the real transport — so a
      // test can tell a read that was CANCELLED from one merely abandoned.
      if (mode === "hang") return abortable(input?.signal, () => {})
      return Promise.resolve({ data: statusMap() })
    }
  }
  class Client {
    _client = {}
    app = new App()
    tui = new Tui()
    session = new Session()
    global = {
      health: () => Promise.resolve({ data: { healthy: true, version } }),
    }
    path = {
      get: () =>
        Promise.resolve({
          data: { config: path.join(sandbox, "config"), state: stateDir },
        }),
    }
  }
  return {
    client: new Client(),
    logs,
    toasts,
    prompts,
    publishes,
    statusReads,
    statusSignals,
    messageReads,
    promptTimes,
  }
}

async function load(
  client: unknown,
  options?: Record<string, unknown>,
): Promise<Hooks> {
  const hooks = await BackgroundTasksPlugin(
    {
      client: client as any,
      directory: root,
      worktree: root,
      project: {} as any,
      serverUrl: new URL("http://localhost:4096"),
      experimental_workspace: { register() {} } as any,
      $: {} as any,
    },
    options,
  )
  active = hooks
  return hooks
}

function makeCtx(sessionID = "ses_1", permission?: Store["permission"]) {
  const controller = new AbortController()
  const asks: any[] = []
  const rules = permission && rulesFrom({ permission })
  const ctx = {
    sessionID,
    messageID: "msg_1",
    agent: "build",
    directory: root,
    worktree: root,
    abort: controller.signal,
    metadata: () => {},
    ask: (input: any) => {
      asks.push(input)
      if (rules) {
        const actions = (input.patterns as string[]).map((pattern) => ({
          pattern,
          action: evaluate(input.permission, pattern, rules),
        }))
        const rejected =
          actions.find(({ action }) => action === "deny") ??
          actions.find(({ action }) => action !== "allow")
        if (rejected)
          return Promise.reject(
            new Error(
              `${input.permission} ${rejected.action}: ${rejected.pattern}`,
            ),
          )
      }
      return Promise.resolve()
    },
  }
  return { ctx, asks, controller }
}

type ToolResultObject = {
  title?: string
  output: string
  metadata?: Record<string, any>
}

async function run(
  hooks: Hooks,
  ctx: unknown,
  args: Record<string, unknown>,
): Promise<ToolResultObject> {
  return (await hooks.tool?.background_run?.execute(
    args as any,
    ctx as any,
  )) as ToolResultObject
}

async function call(
  hooks: Hooks,
  name: "background_output" | "background_kill" | "background_wait",
  ctx: unknown,
  args: Record<string, unknown>,
): Promise<ToolResultObject> {
  return (await hooks.tool?.[name]?.execute(
    args as any,
    ctx as any,
  )) as ToolResultObject
}

async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await Bun.sleep(20)
  }
}

type LinuxProcessState = { state: string; processGroup: number }

async function linuxProcessState(
  pid: number,
): Promise<LinuxProcessState | undefined> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const state = fields[0]
    const processGroup = Number(fields[2])
    if (!state || !Number.isInteger(processGroup))
      throw new Error(`could not parse process state for pid ${pid}`)
    return { state, processGroup }
  } catch (error) {
    if (
      ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return undefined
    throw error
  }
}

async function linuxProcessRunning(pid: number): Promise<boolean> {
  const process = await linuxProcessState(pid)
  return process !== undefined && !["Z", "X", "x"].includes(process.state)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function termResistantDescendantCommand(
  marker: string,
  leaderCommand: string,
): string {
  const worker = `trap '' TERM; printf '%s\\n' "$$" > ${shellQuote(marker)}; sleep 30`
  return `sh -c ${shellQuote(worker)} >/dev/null 2>&1 & ${leaderCommand}`
}

async function readReadyPid(marker: string): Promise<number> {
  let pid: number | undefined
  await until(async () => {
    try {
      const candidate = Number((await fs.readFile(marker, "utf8")).trim())
      if (!Number.isSafeInteger(candidate) || candidate <= 0) return false
      pid = candidate
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  })
  if (pid === undefined) throw new Error("worker pid marker was not ready")
  return pid
}

async function forceKillProcessGroup(
  processGroup: number | undefined,
  workerPid?: number,
): Promise<void> {
  if (processGroup !== undefined) {
    try {
      process.kill(-processGroup, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  if (workerPid !== undefined)
    await until(async () => !(await linuxProcessRunning(workerPid)), 3_000)
}

function observeProcessGroupSignals(processGroup: number): {
  signals: Array<NodeJS.Signals | number | undefined>
  restore: () => void
} {
  const group = groups.get(processGroup)!
  const originalSignal = group.signal
  const signals: Array<NodeJS.Signals | number | undefined> = []
  group.signal = (signal) => {
    signals.push(signal)
    return originalSignal(signal)
  }
  return { signals, restore: () => (group.signal = originalSignal) }
}

async function isProcessExecuting(pid: number): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
      const state = stat[stat.lastIndexOf(")") + 2]
      return state !== "Z" && state !== "X" && state !== "x"
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ESRCH") return false
      return true
    }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

async function noProcessesExecuting(pids: number[]): Promise<boolean> {
  return (await Promise.all(pids.map(isProcessExecuting))).every(
    (executing) => !executing,
  )
}

type HostShutdownEvent =
  | { type: "worker"; groupPid: number }
  | {
      type: "ready"
      workers: Array<{ groupPid: number; descendantPid: number }>
    }
  | { type: "disposed"; elapsedMs: number }

function parseHostShutdownEvents(output: string): HostShutdownEvent[] {
  const events: HostShutdownEvent[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue
    try {
      events.push(JSON.parse(line) as HostShutdownEvent)
    } catch {
      // Keep earlier complete PID messages if shutdown truncates the last line.
    }
  }
  return events
}

async function statusEvent(
  hooks: Hooks,
  sessionID: string,
  type: "busy" | "idle",
) {
  await hooks.event?.({
    event: {
      type: "session.status",
      properties: { sessionID, status: { type } },
    } as any,
  })
}

describe("OpenCode runtime compatibility guard", () => {
  // A v1 host outside the verified band warns but still registers its tools.
  test("warns but runs on an untested v1 host", async () => {
    const { client, logs } = makeClient(BAND.belowBand)
    const hooks = await load(client)
    expect(hooks.tool).toBeDefined()
    expect(logs[0].body.level).toBe("warn")
    expect(logs[0].body.message).toContain(`found ${BAND.belowBand}`)
    expect(logs[0].body.message).toContain("Running anyway")
  })

  // A non-v1 host (OpenCode v2+, whose plugin API differs) disables the plugin
  // — but visibly, via the deferred first-prompt toast.
  test("stays inert on OpenCode v2 — but visibly", async () => {
    const { client, logs } = makeClient("2.0.0")
    const hooks = await load(client)
    expect(Object.keys(hooks)).toEqual(["event"])
    expect(hooks.tool).toBeUndefined()
    expect(logs[0].body.level).toBe("warn")
    expect(logs[0].body.message).toContain("OpenCode 2.0.0")
    expect(logs[0].body.message).toContain("disabled")
  })
})

describe("background_run", () => {
  test("asserts the bash permission with the command, then returns the task id and guidance", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx, asks } = makeCtx()
    const result = await run(hooks, ctx, {
      command: "echo hi",
      name: "greeter",
    })
    expect(asks[0]).toMatchObject({
      permission: "bash",
      patterns: ["echo hi"],
      always: ["echo hi"],
      metadata: {
        command: "echo hi",
        background: true,
        description: "greeter",
      },
    })
    // Ids are per-instance monotonic behind an instance slug: the cross-half
    // channel is shared per project, so bare counters could collide across
    // concurrent/restarted servers.
    expect(result.metadata?.taskId).toMatch(/^bg_[0-9a-f]{6}_1$/)
    expect(result.output).toContain(
      `Started background task ${result.metadata?.taskId} ("greeter")`,
    )
    expect(result.output).toContain("notified automatically")
    expect(result.output).toContain("do NOT poll")
    expect(hooks.tool?.background_run?.description).toContain(
      "Redirects to /dev/null and absolute executable paths may require external_directory approval",
    )
  })

  test("checks bash before external workdirs", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const outside = path.join(sandbox, "elsewhere")
    await fs.mkdir(outside)
    const inProject = makeCtx()
    await run(hooks, inProject.ctx, { command: "true" })
    expect(inProject.asks.map((ask) => ask.permission)).toEqual(["bash"])
    const outOfProject = makeCtx()
    await run(hooks, outOfProject.ctx, { command: "true", workdir: outside })
    expect(outOfProject.asks.map((ask) => ask.permission)).toEqual([
      "bash",
      "external_directory",
    ])
    expect(outOfProject.asks[1].patterns).toEqual([path.join(outside, "*")])
  })

  test("does not ask for external access when bash is denied", async () => {
    const outside = path.join(sandbox, "elsewhere")
    await fs.mkdir(outside)
    const { client } = makeClient()
    const hooks = await load(client, { maxTasksPerSession: 1, notify: false })
    const denied = makeCtx("ses_order", {
      bash: "deny",
      external_directory: "ask",
    })
    await expect(
      run(hooks, denied.ctx, { command: "true", workdir: outside }),
    ).rejects.toThrow("bash deny: true")
    expect(denied.asks.map((ask) => ask.permission)).toEqual(["bash"])

    const next = makeCtx("ses_order")
    const result = await run(hooks, next.ctx, { command: "true" })
    await call(hooks, "background_wait", next.ctx, {
      task_id: result.metadata?.taskId,
      timeout_ms: 1_000,
    })
  })

  test.each([
    "printf harmless; uname -s",
    "printf harmless && uname -s",
    "printf harmless\nuname -s",
    "printf harmless; false || uname -s",
    "printf harmless | uname -s",
    "printf harmless | uname -s | printf end",
    'printf "%s" "$(uname -s)"',
    'printf "%s" "`uname -s`"',
    'printf "%s" "$(printf "%s" "$(uname -s)")"',
    "printf harmless; (uname -s)",
    "printf harmless; { uname -s; }",
    "printf harmless; if true; then uname -s; fi",
    "printf harmless; while false; do uname -s; done",
    'printf harmless; "uname" -s',
    "printf harmless; un\\ame -s",
  ])(
    "denies a hidden subcommand before any part starts: %s",
    async (command) => {
      const { client } = makeClient()
      const hooks = await load(client, { maxTasksPerSession: 1, notify: false })
      const { ctx, asks } = makeCtx("ses_denied", {
        bash: {
          "*": "ask",
          "printf *": "allow",
          true: "allow",
          false: "allow",
          "uname *": "deny",
        },
        external_directory: "deny",
      })
      await expect(
        run(hooks, ctx, { command: `printf started > sentinel; ${command}` }),
      ).rejects.toThrow("bash deny: uname -s")
      expect(asks.find((ask) => ask.permission === "bash").patterns).toContain(
        "uname -s",
      )
      await expect(fs.access(path.join(root, "sentinel"))).rejects.toThrow()

      // Analysis and rejection must not consume the session's only task slot.
      const allowed = await run(hooks, ctx, { command: "printf allowed" })
      const output = await call(hooks, "background_wait", ctx, {
        task_id: allowed.metadata?.taskId,
        timeout_ms: 1_000,
      })
      expect(output.output).toContain("allowed")
    },
  )

  test.each([
    ["printf first; printf second", "firstsecond"],
    ["printf first && printf second", "firstsecond"],
    ["printf first | cat", "first"],
    ["printf created > new-output; cat new-output", "created"],
    ['printf "%s" "$(printf nested)"', "nested"],
    ['printf "%s" "`printf nested`"', "nested"],
    ["printf '%s' 'harmless; uname -s'", "harmless; uname -s"],
  ])(
    "runs an authorized script without treating quoted data as commands: %s",
    async (command, expected) => {
      const { client } = makeClient()
      const hooks = await load(client, { notify: false })
      const { ctx, asks } = makeCtx("ses_allowed", {
        bash: {
          "*": "ask",
          "printf *": "allow",
          "cat *": "allow",
          "uname *": "deny",
        },
        external_directory: "deny",
      })
      const result = await run(hooks, ctx, { command })
      const output = await call(hooks, "background_wait", ctx, {
        task_id: result.metadata?.taskId,
        timeout_ms: 1_000,
      })
      expect(output.output).toContain(expected)
      expect(asks).toHaveLength(1)
      expect(asks[0].patterns).not.toContain("uname -s")
    },
  )

  test.each([
    "cat '../outside fixtures/manifest.txt'",
    "cat < '../outside fixtures/manifest.txt'",
    "printf blocked > '../outside fixtures/new.txt'",
    "touch '../outside fixtures/new.txt'",
    "touch '../outside fixtures/new=file.txt'",
    "chmod u=rw '../outside fixtures/manifest.txt'",
    "chmod -w '../outside fixtures/manifest.txt'",
    "cat 'link/manifest.txt'",
    'printf "%s" "$(cat \'../outside fixtures/manifest.txt\')"',
  ])(
    "blocks external argument and redirect paths before spawning: %s",
    async (command) => {
      const outside = path.join(sandbox, "outside fixtures")
      await fs.mkdir(outside)
      await fs.writeFile(path.join(outside, "manifest.txt"), "harmless fixture")
      await fs.symlink(outside, path.join(root, "link"), "dir")
      const { client } = makeClient()
      const hooks = await load(client, { notify: false })
      const { ctx, asks } = makeCtx("ses_external", {
        bash: "allow",
        external_directory: "deny",
      })
      await expect(
        run(hooks, ctx, { command: `printf started > sentinel; ${command}` }),
      ).rejects.toThrow("external_directory deny:")
      expect(asks.map((ask) => ask.permission)).toEqual([
        "bash",
        "external_directory",
      ])
      expect(asks[1].patterns).toEqual([path.join(outside, "*")])
      await expect(fs.access(path.join(root, "sentinel"))).rejects.toThrow()
      await expect(fs.access(path.join(outside, "new.txt"))).rejects.toThrow()
    },
  )

  test("requests the canonical external operand directory from an in-project cwd", async () => {
    const outside = path.join(sandbox, "outside fixtures")
    const file = path.join(outside, "manifest.txt")
    await fs.mkdir(outside)
    await fs.writeFile(file, "harmless external fixture")
    const { client } = makeClient()
    const hooks = await load(client, { notify: false })
    const { ctx, asks } = makeCtx()
    const command = `cat '${file}'`
    const result = await run(hooks, ctx, { command })
    expect(asks.map((ask) => ask.permission)).toEqual([
      "bash",
      "external_directory",
    ])
    expect(asks[1]).toMatchObject({
      patterns: [path.join(outside, "*")],
      always: [path.join(outside, "*")],
      metadata: { command, directories: [outside] },
    })
    const output = await call(hooks, "background_wait", ctx, {
      task_id: result.metadata?.taskId,
      timeout_ms: 1_000,
    })
    expect(output.output).toContain("harmless external fixture")
  })

  test("rejects root-only and mixed filesystem-root access before asking", async () => {
    const { client } = makeClient()
    const hooks = await load(client, {
      maxTasksPerSession: 1,
      notify: false,
    })
    const rootOnly = makeCtx("ses_root")
    await expect(
      run(hooks, rootOnly.ctx, {
        command: "true",
        workdir: path.parse(root).root,
      }),
    ).rejects.toThrow("Use a more specific working directory or path")
    expect(rootOnly.asks).toEqual([])

    const rootFile = path.join(
      path.parse(root).root,
      `missing-${path.basename(sandbox)}`,
    )
    for (const command of [`cat '${rootFile}'`, `true < '${rootFile}'`]) {
      const operand = makeCtx("ses_root")
      await expect(run(hooks, operand.ctx, { command })).rejects.toThrow(
        "Use a more specific working directory or path",
      )
      expect(operand.asks).toEqual([])
    }

    const outside = path.join(sandbox, "outside fixtures")
    const file = path.join(outside, "manifest.txt")
    await fs.mkdir(outside)
    await fs.writeFile(file, "fixture")
    const mixed = makeCtx("ses_mixed")
    await expect(
      run(hooks, mixed.ctx, {
        command: `cat '${file}'`,
        workdir: path.parse(root).root,
      }),
    ).rejects.toThrow("Use a more specific working directory or path")
    expect(mixed.asks).toEqual([])

    // Rejection must release the session's only reservation.
    const next = makeCtx("ses_root")
    const result = await run(hooks, next.ctx, { command: "true" })
    await call(hooks, "background_wait", next.ctx, {
      task_id: result.metadata?.taskId,
      timeout_ms: 1_000,
    })
  })

  test.each([
    'printf "unterminated',
    '"$COMMAND"',
    'cat "$FILE"',
    'cat "$(printf ../outside)"',
    'printf "%s" "$(true; if)"',
    "eval 'uname -s'",
    `printf "%s" "\${HOME:+'$(uname -s)'}"`,
    `printf "%s" "\${x:-'}"; uname -s #'}"`,
    "cat */manifest.txt",
    "cp -t../outside new-output",
    'head "$HOME/.profile"',
    "touch ~'/'new-output",
    "printf %n HOME; touch ~/new-output",
    "for x in uname; do $\\\nx; done",
    "grep secret */manifest.txt",
    "mapfile -C uname -c 1 < input",
    "for RANDOM in 'x[$(uname -s >&2)0]'; do :; done",
    "cat /proc/self/cwd/../../outside/manifest.txt",
  ])(
    "fails closed without requesting approval or keeping a slot: %s",
    async (command) => {
      const { client } = makeClient()
      const hooks = await load(client, { maxTasksPerSession: 1, notify: false })
      const { ctx, asks } = makeCtx()
      await expect(
        run(hooks, ctx, { command: `printf started > sentinel; ${command}` }),
      ).rejects.toThrow()
      expect(asks).toEqual([])
      await expect(fs.access(path.join(root, "sentinel"))).rejects.toThrow()
      const allowed = await run(hooks, ctx, { command: "printf allowed" })
      await call(hooks, "background_wait", ctx, {
        task_id: allowed.metadata?.taskId,
        timeout_ms: 1_000,
      })
    },
  )

  test("a spawn failure fails the tool call with the reason", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const missing = path.join(sandbox, "missing-dir")
    await expect(
      run(hooks, ctx, { command: "true", workdir: missing }),
    ).rejects.toThrow("Could not start the command")
  })

  test("caps running tasks per session with actionable guidance", async () => {
    const { client } = makeClient()
    const hooks = await load(client, { maxTasksPerSession: 1 })
    const { ctx } = makeCtx()
    const first = await run(hooks, ctx, { command: "sleep 30" })
    await expect(run(hooks, ctx, { command: "sleep 30" })).rejects.toThrow(
      "already has 1 running background tasks",
    )
    await call(hooks, "background_kill", ctx, {
      task_id: first.metadata?.taskId,
    })
  })

  // The cap is checked before the permission prompts but a task only becomes
  // countable once it is registered, several awaits later: without a
  // reservation both of these clear the same pre-spawn count of zero.
  test("two concurrent runs cannot both claim the last slot", async () => {
    const { client } = makeClient()
    const hooks = await load(client, { maxTasksPerSession: 1 })
    const { ctx } = makeCtx()
    let openGate = () => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const gatedCtx = { ...ctx, ask: () => gate }
    const settled = Promise.allSettled([
      run(hooks, gatedCtx, { command: "sleep 30" }),
      run(hooks, gatedCtx, { command: "sleep 30" }),
    ])
    openGate()
    const results = await settled
    const fulfilled = results.filter(
      (result) => result.status === "fulfilled",
    ) as PromiseFulfilledResult<ToolResultObject>[]
    const rejected = results.filter(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult[]
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0]!.reason?.message)).toContain(
      "running background tasks",
    )
    // background_kill awaits the exit, so the winner has left runningTasks()
    // by the time it returns: a third run proves the winner released its
    // reservation instead of holding the slot on top of its registration.
    await call(hooks, "background_kill", ctx, {
      task_id: fulfilled[0]!.value.metadata?.taskId,
    })
    const again = await run(hooks, ctx, { command: "sleep 30" })
    await call(hooks, "background_kill", ctx, {
      task_id: again.metadata?.taskId,
    })
  })

  test("a denied permission releases the reserved slot", async () => {
    const { client } = makeClient()
    const hooks = await load(client, { maxTasksPerSession: 1 })
    const { ctx } = makeCtx()
    const denied = { ...ctx, ask: () => Promise.reject(new Error("denied")) }
    await expect(run(hooks, denied, { command: "sleep 30" })).rejects.toThrow(
      "denied",
    )
    const ok = await run(hooks, ctx, { command: "sleep 30" })
    expect(ok.metadata?.taskId).toBeDefined()
    await call(hooks, "background_kill", ctx, { task_id: ok.metadata?.taskId })
  })

  test("a spawn failure releases the reserved slot", async () => {
    const { client } = makeClient()
    const hooks = await load(client, { maxTasksPerSession: 1 })
    const { ctx } = makeCtx()
    const missing = path.join(sandbox, "missing-dir")
    await expect(
      run(hooks, ctx, { command: "true", workdir: missing }),
    ).rejects.toThrow("Could not start the command")
    const ok = await run(hooks, ctx, { command: "sleep 30" })
    await call(hooks, "background_kill", ctx, { task_id: ok.metadata?.taskId })
  })

  // A permission prompt that is never answered must not hold the slot: on this
  // host an aborted turn can leave one pending forever.
  test("an aborted run releases its slot, and never starts the command", async () => {
    const { client } = makeClient()
    const hooks = await load(client, { maxTasksPerSession: 1 })
    const { ctx, controller } = makeCtx()
    let openGate = () => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    let asked = false
    const stuck = run(
      hooks,
      {
        ...ctx,
        ask: () => {
          asked = true
          return gate
        },
      },
      { command: "sleep 30" },
    )
    await until(() => asked)
    controller.abort()
    // A fresh turn for the same session: the aborted one must not still hold
    // the only slot.
    const next = makeCtx()
    const ok = await run(hooks, next.ctx, { command: "sleep 30" })
    expect(ok.metadata?.taskId).toBeDefined()
    await call(hooks, "background_kill", next.ctx, {
      task_id: ok.metadata?.taskId,
    })
    // Releasing early is only safe because a run that resumes after its turn
    // was aborted refuses to spawn.
    openGate()
    await expect(stuck).rejects.toThrow("aborted before its command started")
  })

  // The test above aborts AFTER the listener is registered. A signal that is
  // already aborted on entry never fires a newly-added listener, so nothing
  // would release the slot — and the permission prompt it then waits on is
  // bridged on a detached fiber that need never settle, so the finally would
  // not run either. The reservation would outlive the session.
  test("a run whose turn was already aborted reserves no slot, even if its permission never settles", async () => {
    const { client } = makeClient()
    const hooks = await load(client, { maxTasksPerSession: 1 })
    const { ctx, controller } = makeCtx()
    controller.abort()
    // Never settles, exactly like a detached ask whose turn is already gone.
    const stuck = run(
      hooks,
      { ...ctx, ask: () => new Promise<void>(() => {}) },
      { command: "sleep 30" },
    )
    await expect(stuck).rejects.toThrow("aborted before its command started")
    const next = makeCtx()
    const ok = await run(hooks, next.ctx, { command: "sleep 30" })
    expect(ok.metadata?.taskId).toBeDefined()
    await call(hooks, "background_kill", next.ctx, {
      task_id: ok.metadata?.taskId,
    })
  })
})

describe("completion notification", () => {
  test("idle session: a real prompt, with the update block, tail, and a toast", async () => {
    const { client, prompts, toasts, publishes } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_idle")
    await run(hooks, ctx, {
      command: "printf 'line one\\nline two\\n'",
      name: "printer",
    })
    await until(() => prompts.length > 0)
    const prompt = prompts[0]
    expect(prompt.path.id).toBe("ses_idle")
    expect(prompt.body.noReply).toBeUndefined()
    expect(prompt.body.parts[0].synthetic).toBe(true)
    expect(prompt.body.parts[0].text).toContain("<background-task-update>")
    expect(prompt.body.parts[0].text).toContain(
      '("printer") exited with code 0',
    )
    expect(prompt.body.parts[0].text).toContain("line one\nline two")
    // The note echoes the session's pinned identity so the host does not
    // re-pin the session onto the default agent or strip its variant.
    expect(prompt.body).toMatchObject({
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-x" },
      variant: "max",
    })
    const finished = toasts.filter(
      (toast) => toast.body.title === "Background task finished",
    )
    expect(finished).toHaveLength(1)
    expect(finished[0].body.variant).toBe("success")
    // Every state write pokes the TUI so it refreshes without waiting out
    // its poll.
    await until(() => publishes.length > 0)
    expect(publishes[0].body).toEqual({
      type: "tui.command.execute",
      properties: { command: SYNC_COMMAND },
    })
  })

  // `noReply` cannot keep a note out of a running turn — the host persists the
  // message before it consults the flag, and the in-flight loop re-reads the
  // store each step — so the only way not to steer is not to write. The note
  // waits for the turn to end.
  test("busy session (from session.status events): nothing is written until it goes idle", async () => {
    const { client, prompts } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_busy")
    await statusEvent(hooks, "ses_busy", "busy")
    await run(hooks, ctx, { command: "printf done" })
    await Bun.sleep(150)
    expect(prompts).toHaveLength(0)
    await statusEvent(hooks, "ses_busy", "idle")
    await until(() => prompts.length === 1)
    expect(prompts[0].path.id).toBe("ses_busy")
    expect(prompts[0].body.noReply).toBeUndefined()
    expect(prompts[0].body.parts[0].text).toContain("exited with code 0")
  })

  // A session this process has seen no status event for — it went busy before
  // the plugin loaded, and the host replays nothing — is the one the status
  // endpoint answers for.
  test("a session no event has described is read from the status endpoint, scoped to this project", async () => {
    const busy: Record<string, unknown> = { ses_racy: { type: "busy" } }
    const { client, prompts, statusReads } = makeClient(BAND.floor, () => busy)
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_racy")
    await run(hooks, ctx, { command: "printf done" })
    await Bun.sleep(150)
    expect(prompts).toHaveLength(0)
    // The turn ended without its idle event reaching this process. Nothing but
    // another read notices — so the endpoint answer is never cached.
    delete busy.ses_racy
    await run(hooks, makeCtx("ses_racy").ctx, { command: "printf again" })
    await until(() => prompts.length === 1)
    expect(prompts[0].body.parts[0].text).toContain("2 background tasks")
    // /session/status is directory-scoped: asked about the wrong project, this
    // session is simply absent from the answer, which reads as idle.
    expect(statusReads).toEqual([{ directory: root }, { directory: root }])
  })

  test("a status read that never answers is abandoned on this half's post deadline, not left to hang the queue", async () => {
    const { client, prompts, statusSignals } = makeClient(
      BAND.floor,
      () => ({}),
      { statusMode: () => "hang" },
    )
    const hooks = await load(client, {
      notifyPostTimeoutMs: MIN_NOTIFY_POST_TIMEOUT_MS,
    })
    const { ctx } = makeCtx("ses_hang")
    await run(hooks, ctx, { command: "printf done" })
    await until(() => statusSignals.length === 1)
    // Still waiting on the read rather than posting past it.
    await Bun.sleep(150)
    expect(prompts).toHaveLength(0)
    // Aborted at this plugin's own deadline (1 s), not the library's 10 s
    // default: a note whose busy sample is still in flight holds every later
    // note for that session behind it.
    await until(() => statusSignals[0]?.aborted === true, 3_000)
    expect(prompts).toHaveLength(0)
    await statusEvent(hooks, "ses_hang", "idle")
    await until(() => prompts.length === 1)
  })

  test("dispose cancels a busy sample already awaiting the host", async () => {
    const { client, prompts, statusSignals } = makeClient(
      BAND.floor,
      () => ({}),
      { statusMode: () => "hang" },
    )
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_shutdown")
    await run(hooks, ctx, { command: "printf done" })
    await until(() => statusSignals.length === 1)
    await hooks.dispose?.()
    active = undefined
    expect(statusSignals[0]?.aborted).toBe(true)
    // And nothing the cancelled sample unblocks re-parks or posts after
    // shutdown.
    await Bun.sleep(50)
    expect(prompts).toHaveLength(0)
  })

  test("a session observed idle is answered from that event, not another read", async () => {
    const { client, prompts, statusReads } = makeClient(BAND.floor, () => ({
      // Deliberately stale: the host publishes the status event into the
      // plugin hooks BEFORE it deletes the key this map is built from, so a
      // read here could only ever confirm what the event already said — and
      // this one would confirm the state the event superseded.
      ses_seen: { type: "busy" },
    }))
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_seen")
    await statusEvent(hooks, "ses_seen", "busy")
    await statusEvent(hooks, "ses_seen", "idle")
    await run(hooks, ctx, { command: "printf done" })
    await until(() => prompts.length === 1)
    expect(statusReads).toEqual([])
  })

  test("a status read the host cannot answer holds the note instead of posting it", async () => {
    for (const mode of ["error", "throw"] as const) {
      const { client, prompts, toasts } = makeClient(BAND.floor, () => ({}), {
        statusMode: () => mode,
      })
      const hooks = await load(client)
      const sessionID = `ses_unknown_${mode}`
      const { ctx } = makeCtx(sessionID)
      await run(hooks, ctx, { command: "printf done" })
      await Bun.sleep(150)
      // No event to go on and no answer from the host: posting would be a
      // guess, and the wrong guess steers a running turn. An `{ error }`
      // result never throws — the SDK reports HTTP failures that way — so a
      // reader that only catches rejections reads it as the empty (all-idle)
      // map and posts.
      expect(prompts, mode).toHaveLength(0)
      // The user has already been told the task finished; only the model's
      // note is waiting.
      expect(
        toasts.filter(
          (toast) => toast.body.title === "Background task finished",
        ),
        mode,
      ).toHaveLength(1)
      // Parked, not dropped: the next idle observation carries it out.
      await statusEvent(hooks, sessionID, "idle")
      await until(() => prompts.length === 1)
      expect(prompts[0].path.id, mode).toBe(sessionID)
      await hooks.dispose?.()
    }
  }, 10_000)

  // Several tasks finishing during one long turn should cost the session one
  // interruption, not one per task.
  test("completions that pile up during a turn are delivered as a single coalesced prompt", async () => {
    const { client, prompts } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_pile")
    await statusEvent(hooks, "ses_pile", "busy")
    await run(hooks, ctx, { command: "printf one", name: "first" })
    await run(hooks, ctx, { command: "printf two", name: "second" })
    await run(hooks, ctx, { command: "printf three", name: "third" })
    await Bun.sleep(150)
    expect(prompts).toHaveLength(0)
    await statusEvent(hooks, "ses_pile", "idle")
    await until(() => prompts.length === 1)
    const text = prompts[0].body.parts[0].text
    expect(text).toContain(
      "3 background tasks finished while you were working:",
    )
    for (const name of ["first", "second", "third"])
      expect(text).toContain(`("${name}")`)
    // One trailing guidance line for the batch, naming every task.
    expect(text.match(/you may ignore/g)).toHaveLength(1)
  })

  // Parked notes are capped at MAX_PENDING_NOTES for a session that never goes
  // idle, and the overflow drops the OLDEST on purpose — their output is the
  // stalest, and every one of them was already toasted and stays readable
  // through background_output. Flipping the splice to
  // `queued.splice(MAX_PENDING_NOTES)` keeps the sixteen oldest instead: when
  // the turn finally ends the session is told about ancient completions and
  // never hears about the most recent ones, which are the ones it is most
  // likely still depending on. The prompt is well-formed either way, so only
  // naming which notes survived catches the inversion.
  test("notes parked past the cap drop the oldest, not the newest", async () => {
    const { client, prompts, logs, toasts } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_flood")
    await statusEvent(hooks, "ses_flood", "busy")
    const names: string[] = []
    for (let n = 1; n <= 20; n++) {
      // Zero-padded: an unpadded "task-1" is a substring of "task-10", which
      // would make the "none of the oldest four" assertions vacuously true.
      const name = `task-${String(n).padStart(2, "0")}`
      names.push(name)
      await run(hooks, ctx, { command: `printf '${name}'`, name })
      // The toast is the first thing a completion does, and the note queue is
      // FIFO per session — so waiting for it before launching the next task is
      // what makes "oldest" mean launch order. Twenty printfs racing to exit
      // finalize in whatever order the OS scheduled them, and on a loaded
      // machine that is emphatically not the order they were started in.
      await until(() => toasts.length === n)
    }
    // Every completion re-parks the whole accumulated list, so the cap trims
    // one note at a time: the four completions past the sixteenth each warn.
    const drops = () =>
      logs.filter((entry) =>
        String(entry.body.message).includes("undelivered completion note(s)"),
      )
    await until(() => drops().length === 4, 15_000)
    expect(drops()[0].body.level).toBe("warn")
    expect(drops()[0].body.message).toContain(
      "dropped 1 undelivered completion note(s) for session ses_flood",
    )
    // Nothing may be written while the turn is still running.
    expect(prompts).toHaveLength(0)
    await statusEvent(hooks, "ses_flood", "idle")
    await until(() => prompts.length === 1)
    const text = prompts[0].body.parts[0].text
    for (const name of names.slice(4)) expect(text).toContain(`("${name}")`)
    for (const name of names.slice(0, 4))
      expect(text).not.toContain(`("${name}")`)
  }, 30_000)

  // The flush must not depend on one specific event arriving: a completion for
  // the same session re-checks and takes anything parked along with it.
  test("a later completion carries parked notes out even if the idle event was missed", async () => {
    const busy: Record<string, unknown> = { ses_missed: { type: "busy" } }
    const { client, prompts } = makeClient(BAND.floor, () => busy)
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_missed")
    await run(hooks, ctx, { command: "printf one", name: "parked" })
    await Bun.sleep(150)
    expect(prompts).toHaveLength(0)
    // The turn ended, but no idle event was seen — only the endpoint knows.
    delete busy.ses_missed
    await run(hooks, ctx, { command: "printf two", name: "later" })
    await until(() => prompts.length === 1)
    const text = prompts[0].body.parts[0].text
    expect(text).toContain('("parked")')
    expect(text).toContain('("later")')
  })

  test("an inline completion flushes a parked retry without notifying itself", async () => {
    const busy: Record<string, unknown> = {}
    const { client, prompts } = makeClient(BAND.floor, () => busy, {
      promptMode: (_input, call) => (call === 0 ? "reject" : "resolve"),
    })
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_inline_flush")

    await run(hooks, ctx, { command: "printf one", name: "parked" })
    await until(() => prompts.length === 1)
    busy.ses_inline_flush = { type: "busy" }
    await Bun.sleep(400)
    expect(prompts).toHaveLength(1)

    delete busy.ses_inline_flush
    const inline = await run(hooks, ctx, {
      command: "sleep 0.2; printf two",
      name: "inline",
    })
    const result = await call(hooks, "background_wait", ctx, {
      task_id: inline.metadata?.taskId,
    })
    expect(result.metadata?.outcome).toBe("exited")
    await until(() => prompts.length === 2)
    expect(prompts[1].body.parts[0].text).toContain('("parked")')
    expect(prompts[1].body.parts[0].text).not.toContain('("inline")')
  })

  test("notify: false disables the prompt but keeps the toast", async () => {
    const { client, prompts, toasts } = makeClient()
    const hooks = await load(client, { notify: false })
    const { ctx } = makeCtx()
    await run(hooks, ctx, { command: "printf done" })
    await until(() =>
      toasts.some((toast) => toast.body.title === "Background task finished"),
    )
    await Bun.sleep(100)
    expect(prompts).toHaveLength(0)
  })

  // The status endpoint stays empty (idle) throughout, and the identity read is
  // slow enough that both notifications would sample it before either posts.
  // Unserialized, both post and the second lands mid-turn as a steer;
  // serialized, the second sees the turn the first just started and parks.
  test("two completions for one session: the second waits rather than steering the first's turn", async () => {
    const { client, prompts } = makeClient(BAND.floor, () => ({}), {
      getDelayMs: () => 40,
    })
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_pair")
    await run(hooks, ctx, { command: "printf one" })
    await run(hooks, ctx, { command: "printf two" })
    await until(() => prompts.length === 1)
    await Bun.sleep(150)
    // The first note started a turn; the second must not write into it.
    expect(prompts).toHaveLength(1)
    expect(prompts[0].path.id).toBe("ses_pair")
    expect(prompts[0].body).toMatchObject({
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-x" },
    })
    // It goes out once that turn ends.
    await statusEvent(hooks, "ses_pair", "idle")
    await until(() => prompts.length === 2)
    expect(prompts[1].body).toMatchObject({
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-x" },
    })
  })

  test("the queue is per session: two sessions both get a real turn", async () => {
    const { client, prompts } = makeClient(BAND.floor, () => ({}), {
      getDelayMs: () => 40,
    })
    const hooks = await load(client)
    await run(hooks, makeCtx("ses_a").ctx, { command: "printf a" })
    await run(hooks, makeCtx("ses_b").ctx, { command: "printf b" })
    await until(() => prompts.length === 2)
    expect(prompts.every((prompt) => prompt.body.noReply === undefined)).toBe(
      true,
    )
  })

  // The optimistic mark must not hold a session's notes indefinitely: an
  // observed idle is newer evidence than the assumption and clears it.
  test("an idle event clears the assumed turn, so the next note goes straight out", async () => {
    const { client, prompts } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_cleared")
    await run(hooks, ctx, { command: "printf one" })
    await until(() => prompts.length === 1)
    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "ses_cleared" },
      } as any,
    })
    await run(hooks, ctx, { command: "printf two" })
    await until(() => prompts.length === 2)
  })

  test.each(["resolve", "persist-throw"] as const)(
    "%s confirms the caller-minted id and never reinjects",
    async (mode) => {
      const { client, prompts, messageReads } = makeClient(
        BAND.floor,
        () => ({}),
        { promptMode: () => mode },
      )
      const hooks = await load(client)
      const { ctx } = makeCtx("ses_accepted_loss")
      const started = await run(hooks, ctx, {
        command: "printf one",
        name: "accepted",
      })
      await until(async () => {
        const file = await loadStateFile()
        return file?.tasks[0]?.notificationDelivery?.state === "delivered"
      })
      expect(prompts).toHaveLength(1)
      expect(messageReads).toHaveLength(1)
      expect(prompts[0].body.messageID).toMatch(/^msg_/)
      expect(messageReads[0].path).toEqual({
        id: "ses_accepted_loss",
        messageID: prompts[0].body.messageID,
      })
      expect(messageReads[0].query).toEqual({ directory: root })
      expect(messageReads[0].signal).toBeInstanceOf(AbortSignal)
      const output = await call(hooks, "background_output", ctx, {
        task_id: started.metadata?.taskId,
      })
      expect(output.metadata?.notificationDelivery).toMatchObject({
        state: "delivered",
        attempts: 1,
        messageID: prompts[0].body.messageID,
      })
      expect(output.metadata?.notificationDelivery.error).toBeUndefined()

      // Repeated idle observations used to flush and reinject the parked note.
      for (let cycle = 0; cycle < 4; cycle++)
        await statusEvent(hooks, "ses_accepted_loss", "idle")
      await Bun.sleep(100)
      expect(prompts).toHaveLength(1)
    },
  )

  test.each(["resolve", "persist-throw"] as const)(
    "%s polls until delayed persistence becomes visible",
    async (mode) => {
      let visible = false
      const { client, prompts, messageReads } = makeClient(
        BAND.floor,
        () => ({}),
        {
          promptMode: () => mode,
          messageMode: () => (visible ? "resolve" : "missing"),
        },
      )
      const hooks = await load(client, {
        notifyPostTimeoutMs: MIN_NOTIFY_POST_TIMEOUT_MS,
      })
      const { ctx } = makeCtx("ses_delayed_persistence")
      const started = await run(hooks, ctx, {
        command: "printf one",
        name: "delayed",
      })
      const taskID = started.metadata?.taskId as string

      await until(() => messageReads.length >= 2)
      const pending = await call(hooks, "background_output", ctx, {
        task_id: taskID,
      })
      expect(pending.metadata?.notificationDelivery).toMatchObject({
        state: "pending",
        attempts: 1,
        messageID: prompts[0].body.messageID,
      })
      visible = true
      await until(async () => {
        const file = await loadStateFile()
        return (
          file?.tasks.find((task) => task.id === taskID)?.notificationDelivery
            ?.state === "delivered"
        )
      })
      expect(prompts).toHaveLength(1)
      expect(messageReads.length).toBeGreaterThanOrEqual(3)
      expect(new Set(messageReads.map((read) => read.path.messageID))).toEqual(
        new Set([prompts[0].body.messageID]),
      )
    },
  )

  for (const [outcome, promptMode, messageMode] of [
    ["successful 204 without persistence", "accept-missing", "resolve"],
    ["unconfirmable transport ambiguity", "throw", "throw"],
  ] as const) {
    test(`${outcome} is parked without reinjection`, async () => {
      const { client, prompts, messageReads, logs } = makeClient(
        BAND.floor,
        () => ({}),
        {
          promptMode: (_input, call) => (call === 0 ? promptMode : "resolve"),
          messageMode: () => messageMode,
        },
      )
      const hooks = await load(client, {
        notifyPostTimeoutMs: MIN_NOTIFY_POST_TIMEOUT_MS,
      })
      const { ctx } = makeCtx("ses_ambiguous")
      const started = await run(hooks, ctx, {
        command: "printf one",
        name: "uncertain",
      })
      const taskID = started.metadata?.taskId as string
      await until(async () => {
        const file = await loadStateFile()
        return ["delivered", "ambiguous", "failed"].includes(
          file?.tasks[0]?.notificationDelivery?.state ?? "",
        )
      })
      const uncertain = await call(hooks, "background_output", ctx, {
        task_id: taskID,
      })
      expect(uncertain.output).toContain(
        "Completion notification delivery is uncertain",
      )
      expect(uncertain.output).toContain("parked without reinjection")
      expect(uncertain.metadata?.notificationDelivery).toMatchObject({
        state: "ambiguous",
        attempts: 1,
        messageID: prompts[0].body.messageID,
        error: expect.stringContaining("could not be confirmed"),
      })
      expect(messageReads.length).toBeGreaterThan(1)
      expect(new Set(messageReads.map((read) => read.path.messageID))).toEqual(
        new Set([prompts[0].body.messageID]),
      )
      expect(logs).toContainEqual(
        expect.objectContaining({
          body: expect.objectContaining({
            level: "warn",
            message: expect.stringContaining("is ambiguous"),
          }),
        }),
      )
      for (let cycle = 0; cycle < 4; cycle++)
        await statusEvent(hooks, "ses_ambiguous", "idle")
      await Bun.sleep(100)
      expect(prompts).toHaveLength(1)

      // A later completion is a new logical batch; it must not carry the parked
      // ambiguous completion back into the parent.
      await run(hooks, ctx, { command: "printf two", name: "later" })
      await until(() => prompts.length === 2)
      expect(prompts[1].body.parts[0].text).toContain('("later")')
      expect(prompts[1].body.parts[0].text).not.toContain('("uncertain")')
    })
  }

  test("definitive host rejection retries with fresh ids, then fails visibly", async () => {
    const { client, prompts, promptTimes } = makeClient(
      BAND.floor,
      () => ({}),
      { promptMode: () => "reject" },
    )
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_rejected")
    const started = await run(hooks, ctx, {
      command: "printf one",
      name: "rejected",
    })
    const taskID = started.metadata?.taskId as string
    await until(async () => {
      const task = (await loadStateFile())?.tasks.find(
        (candidate) => candidate.id === taskID,
      )
      return task?.notificationDelivery?.state === "failed"
    }, 5_000)

    expect(prompts).toHaveLength(3)
    expect(new Set(prompts.map((prompt) => prompt.body.messageID)).size).toBe(3)
    const [firstAttempt, secondAttempt, thirdAttempt] = promptTimes
    if (
      firstAttempt === undefined ||
      secondAttempt === undefined ||
      thirdAttempt === undefined
    )
      throw new Error("expected three timed prompt attempts")
    expect(secondAttempt - firstAttempt).toBeGreaterThanOrEqual(200)
    expect(thirdAttempt - secondAttempt).toBeGreaterThanOrEqual(900)
    const snapshot = (await loadStateFile())?.tasks.find(
      (candidate) => candidate.id === taskID,
    )
    expect(snapshot?.notificationDelivery).toMatchObject({
      state: "failed",
      attempts: 3,
      messageID: prompts[2].body.messageID,
    })
    const output = await call(hooks, "background_output", ctx, {
      task_id: taskID,
    })
    expect(output.output).toContain(
      "Completion notification delivery failed after 3 attempt(s)",
    )
    expect(output.metadata?.notificationDelivery).toMatchObject({
      state: "failed",
      attempts: 3,
    })
  })

  // The unanswered request is bounded, but its outcome remains ambiguous: a
  // later completion moves through the queue and parks until idle rather than
  // steering a turn the first request may have started.
  test("a post that never answers times out and later work parks safely", async () => {
    const { client, prompts, toasts } = makeClient(BAND.floor, () => ({}), {
      promptMode: (_input, call) => (call === 0 ? "hang" : "resolve"),
    })
    const hooks = await load(client, {
      notifyPostTimeoutMs: MIN_NOTIFY_POST_TIMEOUT_MS,
    })
    const { ctx } = makeCtx("ses_hung")
    await run(hooks, ctx, { command: "printf one" })
    await until(() => prompts.length === 1)
    await run(hooks, ctx, { command: "printf two" })
    // Toasts never queue behind the post: both are visible immediately.
    await until(
      () =>
        toasts.filter(
          (toast) => toast.body.title === "Background task finished",
        ).length === 2,
    )
    expect(prompts).toHaveLength(1)
    await statusEvent(hooks, "ses_hung", "idle")
    await until(() => prompts.length === 2)
  })

  // Posting without the session's pinned identity is not a cosmetic
  // degradation: the host resolves the omitted agent to the GLOBAL default and
  // re-pins the session to it, swapping the agent-level permission ruleset,
  // the model and the variant. A note is never worth that, but because nothing
  // was dispatched, bounded retries are safe and their exhaustion stays visible.
  for (const mode of ["throw", "error", "empty"] as const) {
    test(`an identity read that ${mode}s fails visibly after bounded retries without prompting blind`, async () => {
      const { client, prompts, toasts, logs } = makeClient(
        BAND.floor,
        () => ({}),
        { getMode: () => mode },
      )
      const hooks = await load(client)
      const { ctx } = makeCtx("ses_blind")
      await run(hooks, ctx, { command: "printf done" })
      // The toast still fires — the user is told the task finished either way.
      await until(() =>
        toasts.some((toast) => toast.body.title === "Background task finished"),
      )
      await until(() =>
        logs.some((entry) =>
          entry.body.message?.includes("was not dispatched"),
        ),
      )
      await until(async () => {
        const file = await loadStateFile()
        return file?.tasks[0]?.notificationDelivery?.state === "failed"
      }, 5_000)
      expect(prompts).toHaveLength(0)
      const file = await loadStateFile()
      expect(file?.tasks[0]?.notificationDelivery).toMatchObject({
        state: "failed",
        attempts: 3,
      })
    })
  }

  test("a pre-dispatch identity failure mints the attempt id only after recovery", async () => {
    let identityReads = 0
    const { client, prompts } = makeClient(BAND.floor, () => ({}), {
      getMode: () => (identityReads++ === 0 ? "throw" : "resolve"),
    })
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_identity_retry")
    await run(hooks, ctx, { command: "printf done" })
    await until(async () => {
      const delivery = (await loadStateFile())?.tasks[0]?.notificationDelivery
      return delivery?.state === "retrying"
    })
    const retrying = (await loadStateFile())?.tasks[0]?.notificationDelivery
    expect(retrying?.messageID).toBeUndefined()
    await until(() => prompts.length === 1)
    expect(prompts[0].body.messageID).toMatch(/^msg_/)
  })

  // The epoch guards against an idle observed AFTER the post — evidence that
  // beats the assumed turn. An idle arriving while the STATUS READ is still in
  // flight is about the previous turn and must not suppress the mark, or the
  // next completion samples idle too and writes straight into the turn this
  // note just started.
  test("an idle event during the status read still leaves the started turn marked busy", async () => {
    const { client, prompts } = makeClient(BAND.floor, () => ({}), {
      getDelayMs: () => 40,
    })
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_epoch")
    await run(hooks, ctx, { command: "printf one" })
    // Lands inside the first note's identity/status window.
    await Bun.sleep(20)
    await statusEvent(hooks, "ses_epoch", "idle")
    await until(() => prompts.length === 1)
    await run(hooks, ctx, { command: "printf two" })
    await Bun.sleep(200)
    // Held: the first note's turn is assumed live despite that stale idle.
    expect(prompts).toHaveLength(1)
  })

  // A timed-out post must be CANCELLED, not merely abandoned: an abandoned one
  // is still in flight and can land after the queue advanced, reordering notes
  // or starting a turn nothing expects.
  test("a post that times out is aborted, not left in flight", async () => {
    const { client, prompts } = makeClient(BAND.floor, () => ({}), {
      promptMode: (_input, call) => (call === 0 ? "hang" : "resolve"),
    })
    const hooks = await load(client, {
      notifyPostTimeoutMs: MIN_NOTIFY_POST_TIMEOUT_MS,
    })
    const { ctx } = makeCtx("ses_cancelled")
    await run(hooks, ctx, { command: "printf one" })
    await until(() => prompts.length === 1)
    await until(() => prompts[0].signal?.aborted === true)
    await run(hooks, ctx, { command: "printf two" })
    await Bun.sleep(100)
    expect(prompts).toHaveLength(1)
    await statusEvent(hooks, "ses_cancelled", "idle")
    await until(() => prompts.length === 2)
  })

  test("dispose cancels a notification already awaiting the host", async () => {
    // The read must outlive dispose but finish well inside the assertion
    // window: if it were still pending at the end, the test would pass without
    // the fix simply because nothing had got as far as posting yet.
    const { client, prompts } = makeClient(BAND.floor, () => ({}), {
      getDelayMs: () => 150,
    })
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_late")
    await run(hooks, ctx, { command: "printf one" })
    // Parked on the identity read, past postNotification's first disposal check.
    await Bun.sleep(50)
    await hooks.dispose?.()
    active = undefined
    await Bun.sleep(400)
    // Neither the parked read nor anything behind it may post after shutdown.
    expect(prompts).toHaveLength(0)
  })

  test("dispose does not wait for a hung notification", async () => {
    const { client, prompts } = makeClient(BAND.floor, () => ({}), {
      promptMode: () => "hang",
    })
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_disposing")
    await run(hooks, ctx, { command: "printf one" })
    await until(() => prompts.length === 1)
    await hooks.dispose?.()
    active = undefined
    await run(hooks, ctx, { command: "printf two" }).catch(() => {})
    await Bun.sleep(100)
    expect(prompts).toHaveLength(1)
  })
})

describe("background_output", () => {
  test("incremental reads: new output once, then nothing, then what arrived since", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command: "printf 'a\\nb\\n'; sleep 0.3; printf 'c\\n'; sleep 30",
    })
    const id = started.metadata?.taskId
    await Bun.sleep(120) // let the first chunk land
    const first = await call(hooks, "background_output", ctx, { task_id: id })
    expect(first.output).toContain("running")
    expect(first.output).toContain("a\nb")
    await Bun.sleep(350)
    const second = await call(hooks, "background_output", ctx, { task_id: id })
    expect(second.output).toContain("c")
    expect(second.output).not.toContain("a\nb")
    const third = await call(hooks, "background_output", ctx, { task_id: id })
    expect(third.output).toContain("(no new output since last read)")
    await call(hooks, "background_kill", ctx, { task_id: id })
  })

  test("filter shows matching lines only but still consumes; bad regex fails the call", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command: "printf 'x1\\ny2\\nx3\\n'; sleep 30",
    })
    const id = started.metadata?.taskId
    await Bun.sleep(150)
    await expect(
      call(hooks, "background_output", ctx, { task_id: id, filter: "(bad" }),
    ).rejects.toThrow("Invalid pattern")
    const filtered = await call(hooks, "background_output", ctx, {
      task_id: id,
      filter: "^x",
    })
    expect(filtered.output).toContain("x1")
    expect(filtered.output).toContain("x3")
    expect(filtered.output).not.toContain("y2")
    const next = await call(hooks, "background_output", ctx, { task_id: id })
    expect(next.output).toContain("(no new output since last read)")
    await call(hooks, "background_kill", ctx, { task_id: id })
  })

  test("task ids are session-scoped: another session's ctx cannot touch them", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const owner = makeCtx("ses_owner")
    const started = await run(hooks, owner.ctx, { command: "sleep 30" })
    const id = started.metadata?.taskId as string
    const intruder = makeCtx("ses_intruder")
    for (const name of [
      "background_output",
      "background_kill",
      "background_wait",
    ] as const) {
      await expect(
        call(hooks, name, intruder.ctx, { task_id: id }),
      ).rejects.toThrow(scopedTaskError(id))
    }
    await call(hooks, "background_kill", owner.ctx, { task_id: id })
  })

  // The MAX_FINISHED hard cap runs on every completion, but nothing pinned
  // WHICH fifty entries it keeps. Inverting the slice to
  // `remaining.slice(MAX_FINISHED)` keeps the fifty OLDEST and evicts the
  // newest — so the task the model just started is the first one thrown away,
  // and its very next background_output rejects with scopedTaskError for an id
  // it was handed seconds ago. Both directions leave exactly fifty entries
  // behind, so only naming the survivors catches it; a length check does not.
  //
  // Note the cap is global to the plugin instance, not per session: `tasks`
  // holds every session's entries, so 51 finished tasks in one server lifetime
  // trigger it regardless of how they are spread across sessions.
  test("the finished-task cap evicts the oldest, leaving the newest readable", async () => {
    const { client } = makeClient()
    // notify/toast off: this is about retention, and 55 completions would
    // otherwise spend the whole test posting prompts nobody asserts on.
    const hooks = await load(client, { notify: false, toast: false })
    const { ctx } = makeCtx("ses_cap")
    const ids: string[] = []
    for (let n = 1; n <= 55; n++) {
      const started = await run(hooks, ctx, {
        command: `printf 'run-${n}'`,
        name: `task-${n}`,
      })
      const id = started.metadata?.taskId as string
      ids.push(id)
      // Waiting for the exit before the next run makes "oldest" unambiguous:
      // the registry is insertion-ordered and every task is finished before
      // its successor is even spawned.
      await call(hooks, "background_wait", ctx, { task_id: id })
    }
    // The file lags the registry: every completion queues a snapshot and the
    // queue drains serially, so the file passes through THREE distinct
    // fifty-entry states on the way here — 1..50 as the cap first bites, then
    // 3..52, then 6..55. A bare `length === 50` matches the first of them, and
    // the assertion below would then compare the wrong fifty (which is exactly
    // how this raced on CI). Only the final snapshot ends at the newest id, so
    // wait for that instead.
    await until(async () => {
      const entries = (await loadStateFile())?.tasks
      return entries?.length === 50 && entries.at(-1)?.id === ids[54]
    }, 20_000)
    const surviving = (await loadStateFile())?.tasks.map((task) => task.id)
    expect(surviving).toEqual(ids.slice(5))
    // And the consequence the model actually feels: the task it just ran is
    // still addressable, the five it ran first are not.
    const newest = await call(hooks, "background_output", ctx, {
      task_id: ids[54] as string,
    })
    expect(newest.metadata?.taskId).toBe(ids[54])
    expect(newest.metadata?.state).toBe("exited")
    await expect(
      call(hooks, "background_output", ctx, { task_id: ids[0] as string }),
    ).rejects.toThrow(scopedTaskError(ids[0] as string))
  }, 60_000)

  test.skipIf(process.platform !== "linux")(
    "the finished-task cap cleans an evicted task group before forgetting it",
    async () => {
      const { client } = makeClient()
      const hooks = await load(client, { notify: false, toast: false })
      const { ctx } = makeCtx("ses_cap_group_cleanup")
      const marker = path.join(sandbox, "cap-terminal-worker.pid")
      let processGroup: number | undefined
      let workerPid: number | undefined
      let observed: ReturnType<typeof observeProcessGroupSignals> | undefined
      try {
        const oldest = await run(hooks, ctx, {
          command: termResistantDescendantCommand(marker, "exit 0"),
        })
        const oldestID = oldest.metadata?.taskId as string
        processGroup = oldest.metadata?.pid as number | undefined
        expect(processGroup).toBeNumber()
        workerPid = await readReadyPid(marker)
        expect((await linuxProcessState(workerPid))?.processGroup).toBe(
          processGroup,
        )
        await until(async () => {
          const result = await call(hooks, "background_output", ctx, {
            task_id: oldestID,
          })
          return result.metadata?.state === "exited"
        })
        expect(await linuxProcessRunning(workerPid)).toBe(true)
        observed = observeProcessGroupSignals(processGroup!)

        for (let n = 0; n < 50; n++) {
          const started = await run(hooks, ctx, { command: ":" })
          await call(hooks, "background_wait", ctx, {
            task_id: started.metadata?.taskId,
          })
        }

        expect(observed.signals).toContain("SIGTERM")
        const retained = await call(hooks, "background_output", ctx, {
          task_id: oldestID,
        })
        expect(retained.metadata).toMatchObject({
          state: "exited",
          exitCode: 0,
        })
        expect(await linuxProcessRunning(workerPid)).toBe(true)
        await until(async () => !(await linuxProcessRunning(workerPid!)), 4_500)
        expect(observed.signals).toContain("SIGKILL")
        expect(await groups.get(processGroup!)!.groupClosed).toBe("complete")
        await expect(
          call(hooks, "background_output", ctx, { task_id: oldestID }),
        ).rejects.toThrow(scopedTaskError(oldestID))
      } finally {
        observed?.restore()
        await forceKillProcessGroup(processGroup, workerPid)
      }
    },
    30_000,
  )
})

describe("background_wait", () => {
  test("resolves on the first line matching the pattern and consumes through it", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command:
        "printf 'starting\\n'; sleep 0.2; printf 'Listening on 3000\\nextra\\n'; sleep 30",
    })
    const id = started.metadata?.taskId
    const result = await call(hooks, "background_wait", ctx, {
      task_id: id,
      pattern: "Listening on \\d+",
    })
    expect(result.metadata?.outcome).toBe("matched")
    expect(result.metadata?.matchedLine).toBe("Listening on 3000")
    expect(result.output).toContain("starting")
    expect(result.output).toContain("Listening on 3000")
    expect(result.output).not.toContain("extra")
    // What the wait consumed never comes back; what it did not is still there.
    const rest = await call(hooks, "background_output", ctx, { task_id: id })
    expect(rest.output).toContain("extra")
    expect(rest.output).not.toContain("starting")
    await call(hooks, "background_kill", ctx, { task_id: id })
  })

  test("exit during the wait delivers inline and suppresses the auto-notification", async () => {
    const { client, prompts, toasts } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command: "sleep 0.2; printf 'bye\\n'; exit 3",
    })
    const result = await call(hooks, "background_wait", ctx, {
      task_id: started.metadata?.taskId,
    })
    expect(result.metadata?.outcome).toBe("exited")
    expect(result.metadata?.exitCode).toBe(3)
    expect(result.output).toContain("exited with code 3")
    expect(result.output).toContain("bye")
    await until(() =>
      toasts.some((toast) => toast.body.title === "Background task finished"),
    )
    await Bun.sleep(100)
    expect(prompts).toHaveLength(0)
  })

  test("a wait on an already-finished task returns immediately with the remaining output", async () => {
    const { client, prompts } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, { command: "printf 'done\\n'" })
    await until(() => prompts.length > 0)
    const result = await call(hooks, "background_wait", ctx, {
      task_id: started.metadata?.taskId,
    })
    expect(result.metadata?.outcome).toBe("exited")
    expect(result.output).toContain("has already exited with code 0")
    expect(result.output).toContain("done")
  })

  test("timeout is a non-error: reports the output so far and the task keeps running", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command: "printf 'warming up\\n'; sleep 30",
    })
    const id = started.metadata?.taskId
    const result = await call(hooks, "background_wait", ctx, {
      task_id: id,
      pattern: "never",
      timeout_ms: 200,
    })
    expect(result.metadata?.outcome).toBe("timeout")
    expect(result.output).toContain("Timed out after 200 ms")
    expect(result.output).toContain("still running")
    expect(result.output).toContain("warming up")
    await call(hooks, "background_kill", ctx, { task_id: id })
  })

  test("ctx.abort cancels the wait without touching the task", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx, controller } = makeCtx()
    const started = await run(hooks, ctx, { command: "sleep 30" })
    const id = started.metadata?.taskId
    const pending = call(hooks, "background_wait", ctx, {
      task_id: id,
      pattern: "never",
    })
    await Bun.sleep(50)
    controller.abort()
    await expect(pending).rejects.toThrow("The wait was aborted.")
    const status = await call(hooks, "background_output", ctx, { task_id: id })
    expect(status.output).toContain("running")
    await call(hooks, "background_kill", ctx, { task_id: id })
  })

  test("a pre-aborted buffered-pattern wait consumes no output", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const owner = makeCtx("ses_pre_aborted_buffered")
    const started = await run(hooks, owner.ctx, {
      command: "printf 'ready\\n'; sleep 30",
    })
    const id = started.metadata?.taskId
    await Bun.sleep(200)

    const aborted = makeCtx("ses_pre_aborted_buffered")
    aborted.controller.abort()
    const timers = spyOn(globalThis, "setTimeout")
    try {
      await expect(
        call(hooks, "background_wait", aborted.ctx, {
          task_id: id,
          pattern: "^ready$",
          timeout_ms: 543_210,
        }),
      ).rejects.toThrow("The wait was aborted.")
      expect(timers.mock.calls.some((call) => call[1] === 543_210)).toBe(false)
    } finally {
      timers.mockRestore()
    }

    const unread = await call(hooks, "background_output", owner.ctx, {
      task_id: id,
    })
    expect(unread.output).toContain("ready")
    expect(unread.metadata?.newBytes).toBeGreaterThan(0)
    await call(hooks, "background_kill", owner.ctx, { task_id: id })
  })

  test("a pre-aborted wait on a running task leaves no waiter to suppress notification", async () => {
    const { client, prompts } = makeClient()
    const hooks = await load(client)
    const owner = makeCtx("ses_pre_aborted_running")
    const started = await run(hooks, owner.ctx, {
      command: "sleep 0.5; printf 'done\\n'",
      name: "natural exit",
    })
    const id = started.metadata?.taskId

    const aborted = makeCtx("ses_pre_aborted_running")
    aborted.controller.abort()
    await expect(
      call(hooks, "background_wait", aborted.ctx, { task_id: id }),
    ).rejects.toThrow("The wait was aborted.")
    const status = await call(hooks, "background_output", owner.ctx, {
      task_id: id,
    })
    expect(status.metadata?.state).toBe("running")

    await until(() => prompts.length === 1)
    expect(prompts[0].body.parts[0].text).toContain(String(id))
  })

  test("an abort observed immediately after listener registration inserts no waiter", async () => {
    const { client, prompts } = makeClient()
    const hooks = await load(client)
    const owner = makeCtx("ses_wait_registration_race")
    const started = await run(hooks, owner.ctx, {
      command: "sleep 0.3; printf 'done\\n'",
    })
    let reads = 0
    let added = 0
    let removed = 0
    const abort = {
      get aborted() {
        reads++
        return reads > 1
      },
      addEventListener() {
        added++
      },
      removeEventListener() {
        removed++
      },
    } as unknown as AbortSignal

    await expect(
      call(
        hooks,
        "background_wait",
        { ...owner.ctx, abort },
        { task_id: started.metadata?.taskId },
      ),
    ).rejects.toThrow("The wait was aborted.")
    expect(added).toBe(1)
    expect(removed).toBe(1)
    await until(() => prompts.length === 1)
  })
})

describe("background_kill", () => {
  test.skipIf(process.platform === "win32")(
    "a concurrent kill timeout cannot unsuppress another kill's inline exit",
    async () => {
      const { client, prompts } = makeClient()
      const hooks = await load(client, { killConfirmMs: 50 })
      const { ctx } = makeCtx()
      const started = await run(hooks, ctx, {
        command: "sleep 0.3; printf 'done\\n'",
      })
      const group = groups.get(started.metadata?.pid)!
      const originalSignal = group.signal
      group.signal = async () => {
        await Bun.sleep(500)
        return "signalled"
      }
      try {
        const first = call(hooks, "background_kill", ctx, {
          task_id: started.metadata?.taskId,
        })
        const second = await call(hooks, "background_kill", ctx, {
          task_id: started.metadata?.taskId,
        })
        expect(second.output).toContain("has not confirmed exit yet")
        expect((await first).output).toContain("Killed background task")
        expect(prompts).toHaveLength(0)
      } finally {
        group.signal = originalSignal
      }
    },
  )

  test.skipIf(process.platform !== "linux")(
    "a retired capability reports failure without claiming a kill or suppressing natural exit",
    async () => {
      const { client, prompts } = makeClient()
      const hooks = await load(client)
      const { ctx } = makeCtx()
      const started = await run(hooks, ctx, {
        command: "printf 'ready\\n'; sleep 0.5",
      })
      const id = started.metadata?.taskId as string
      const group = groups.get(started.metadata?.pid)!
      try {
        await call(hooks, "background_wait", ctx, {
          task_id: id,
          pattern: "ready",
        })
        group.child.kill("SIGKILL")
        expect(await group.groupClosed).toBe("unverified")
        const result = await call(hooks, "background_kill", ctx, {
          task_id: id,
        })
        expect(result.metadata?.state).toBe("running")
        expect(result.output).toContain("cleanup could not be confirmed")
        expect(result.output).not.toContain("Killed background task")
        expect(result.output).not.toContain("Requested termination")
        await until(() => prompts.length === 1)
      } finally {
        await forceKillProcessGroup(started.metadata?.pid, undefined)
      }
    },
  )

  test.skipIf(process.platform !== "linux").each([false, true])(
    "keeper loss retires cleanup without reopening the PGID (escalating: %s)",
    async (escalating) => {
      const { client, logs } = makeClient()
      const hooks = await load(client, { notify: false, toast: false })
      const { ctx } = makeCtx()
      const marker = path.join(sandbox, "lost-keeper-worker.pid")
      let processGroup: number | undefined
      let workerPid: number | undefined
      let observed: ReturnType<typeof observeProcessGroupSignals> | undefined
      const originalKill = process.kill
      try {
        const started = await run(hooks, ctx, {
          command: termResistantDescendantCommand(
            marker,
            escalating ? "exec sleep 30" : "exit 0",
          ),
        })
        const id = started.metadata?.taskId as string
        processGroup = started.metadata?.pid as number
        workerPid = await readReadyPid(marker)
        observed = observeProcessGroupSignals(processGroup)
        if (escalating)
          await call(hooks, "background_kill", ctx, { task_id: id })
        else await call(hooks, "background_wait", ctx, { task_id: id })

        const group = groups.get(processGroup)!
        group.child.kill("SIGKILL")
        expect(await group.groupClosed).toBe("unverified")
        const numericSignals: Array<NodeJS.Signals | number | undefined> = []
        process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
          if (pid !== -processGroup!)
            return originalKill(pid, signal as NodeJS.Signals)
          // A recycled numeric identifier would appear alive to every probe.
          numericSignals.push(signal)
          return true
        }) as typeof process.kill

        const result = await call(hooks, "background_kill", ctx, {
          task_id: id,
        })
        expect(result.output).toContain("cleanup could not be confirmed")
        expect(result.output).not.toContain("cleanup is still pending")
        expect(result.metadata?.state).toBe(escalating ? "killed" : "exited")
        await hooks.event?.({
          event: {
            type: "session.deleted",
            properties: { info: { id: ctx.sessionID } },
          } as any,
        })
        await expect(
          call(hooks, "background_output", ctx, { task_id: id }),
        ).rejects.toThrow(scopedTaskError(id))
        await hooks.dispose?.()
        active = undefined
        if (escalating) await Bun.sleep(3_200)
        expect(observed.signals).toEqual(escalating ? ["SIGTERM"] : [])
        expect(numericSignals).toEqual([])
        expect(await linuxProcessRunning(workerPid)).toBe(true)
        expect(
          logs.some((entry) =>
            String(entry.body?.message).includes(
              "lost its process-group keeper",
            ),
          ),
        ).toBe(true)
      } finally {
        process.kill = originalKill
        observed?.restore()
        await forceKillProcessGroup(processGroup, workerPid)
      }
    },
    15_000,
  )

  test.skipIf(process.platform === "win32")(
    "a kill racing natural exit retains its requested signal with the kill reason",
    async () => {
      const { client } = makeClient()
      const hooks = await load(client, { notify: false, toast: false })
      const { ctx } = makeCtx()
      const started = await run(hooks, ctx, { command: "sleep 0.5; exit 0" })
      const id = started.metadata?.taskId as string
      const group = groups.get(started.metadata?.pid)!
      const originalSignal = group.signal
      const signals: Array<NodeJS.Signals | number | undefined> = []
      group.signal = async (signal) => {
        signals.push(signal)
        await group.closed
        return "absent"
      }
      try {
        const result = await call(hooks, "background_kill", ctx, {
          task_id: id,
        })
        expect(result.metadata?.state).toBe("killed")
        await until(async () => {
          const record = (await loadStateFile())?.tasks.find(
            (task) => task.id === id,
          )
          return record?.state === "killed"
        })
        expect(
          (await loadStateFile())?.tasks.find((task) => task.id === id),
        ).toMatchObject({ killReason: "background_kill", signal: "SIGTERM" })
        await call(hooks, "background_kill", ctx, { task_id: id })
        expect(signals).toEqual(["SIGTERM"])
      } finally {
        group.signal = originalSignal
      }
    },
  )

  test
    .skipIf(process.platform !== "linux")
    .each(["recovered", "unverified", "discarded"] as const)(
    "bounds unconfirmed group escalation: %s",
    async (outcome) => {
      const { client, logs } = makeClient()
      const hooks = await load(client, { notify: false, toast: false })
      const { ctx } = makeCtx()
      const marker = path.join(sandbox, "unconfirmed-worker.pid")
      let processGroup: number | undefined
      let workerPid: number | undefined
      let restoreSignal = () => {}
      try {
        const started = await run(hooks, ctx, {
          command: termResistantDescendantCommand(marker, "exit 0"),
        })
        const id = started.metadata?.taskId as string
        processGroup = started.metadata?.pid as number
        const group = groups.get(processGroup)!
        workerPid = await readReadyPid(marker)
        await call(hooks, "background_wait", ctx, { task_id: id })
        let terms = 0
        let escalations = 0
        const originalSignal = group.signal
        group.signal = async (signal) => {
          if (signal === "SIGTERM") terms++
          if (signal === "SIGKILL") {
            escalations++
            if (outcome === "recovered" && escalations === 2)
              return originalSignal(signal)
          }
          return "unconfirmed"
        }
        restoreSignal = () => (group.signal = originalSignal)

        const deleted = () =>
          hooks.event?.({
            event: {
              type: "session.deleted",
              properties: { info: { id: ctx.sessionID } },
            } as any,
          })
        if (outcome === "discarded") await deleted()
        else await call(hooks, "background_kill", ctx, { task_id: id })
        await until(() => escalations === 1, 4_500)
        expect(await linuxProcessRunning(workerPid)).toBe(true)
        const retry = await call(hooks, "background_kill", ctx, { task_id: id })
        expect(retry.output).toContain("Process-group cleanup is still pending")
        expect(terms).toBe(1)
        await until(() => escalations === 2, 4_500)
        if (outcome === "recovered") await group.groupClosed
        else
          await until(() =>
            logs.some((entry) =>
              String(entry.body?.message).includes(
                "process-group cleanup could not be confirmed",
              ),
            ),
          )

        const warnings = logs.filter((entry) =>
          String(entry.body?.message).includes(
            "process-group cleanup could not be confirmed",
          ),
        )
        if (outcome === "recovered") {
          expect(warnings).toHaveLength(0)
          await until(async () => !(await linuxProcessRunning(workerPid!)))
        } else {
          expect(warnings).toHaveLength(1)
          expect(warnings[0].body.level).toBe("warn")
          expect(warnings[0].body.message).toContain(id)
          // Retirement disconnects IPC, so a responsive keeper self-cleans even
          // though the parent could not confirm either signalling request.
          await until(() => !isProcessAlive(processGroup!))
          await until(async () => !(await linuxProcessRunning(workerPid!)))
        }
        if (outcome !== "discarded") {
          const result = await call(hooks, "background_kill", ctx, {
            task_id: id,
          })
          expect(result.output).not.toContain("cleanup is still pending")
          const output = await call(hooks, "background_output", ctx, {
            task_id: id,
          })
          if (outcome === "unverified") {
            expect(result.output).toContain("cleanup could not be confirmed")
            expect(output.output).toContain("cleanup could not be confirmed")
          }
          await deleted()
        }
        await expect(
          call(hooks, "background_output", ctx, { task_id: id }),
        ).rejects.toThrow(scopedTaskError(id))
        await until(
          async () =>
            !(await loadStateFile())?.tasks.some((task) => task.id === id),
        )
        expect(terms).toBe(1)
        expect(escalations).toBe(2)
      } finally {
        restoreSignal()
        await forceKillProcessGroup(processGroup, workerPid)
      }
    },
    15_000,
  )

  test("kills the whole process group and returns the final unread output", async () => {
    const { client, prompts } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command: "printf 'serving\\n'; sleep 30",
      name: "server",
    })
    const id = started.metadata?.taskId
    await Bun.sleep(150)
    const result = await call(hooks, "background_kill", ctx, { task_id: id })
    expect(result.output).toContain(`Killed background task ${id} ("server")`)
    expect(result.output).toContain("serving")
    expect(result.metadata?.state).toBe("killed")
    // The kill result is the delivery; no auto-notification follows.
    await Bun.sleep(150)
    expect(prompts).toHaveLength(0)
  })

  test("escalates to SIGKILL when SIGTERM is trapped", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command: `trap '' TERM; while true; do sleep 0.1; done`,
    })
    await Bun.sleep(300) // let the shell install its trap before signaling
    const before = Date.now()
    const result = await call(hooks, "background_kill", ctx, {
      task_id: started.metadata?.taskId,
    })
    expect(Date.now() - before).toBeGreaterThanOrEqual(2_900)
    expect(result.output).toContain("SIGKILL")
    expect(result.metadata?.state).toBe("killed")
  }, 15_000)

  test.skipIf(process.platform !== "linux")(
    "keeps one escalation deadline after the shell closes and kill is repeated",
    async () => {
      const { client } = makeClient()
      const hooks = await load(client, { notify: false, toast: false })
      const { ctx } = makeCtx("ses_repeated_terminal_kill")
      const marker = path.join(sandbox, "repeated-terminal-worker.pid")
      let processGroup: number | undefined
      let workerPid: number | undefined
      try {
        const started = await run(hooks, ctx, {
          command: termResistantDescendantCommand(marker, "exec sleep 12"),
        })
        processGroup = started.metadata?.pid as number | undefined
        expect(processGroup).toBeNumber()
        workerPid = await readReadyPid(marker)
        expect((await linuxProcessState(workerPid))?.processGroup).toBe(
          processGroup,
        )

        const firstKillAt = Date.now()
        const firstKill = await call(hooks, "background_kill", ctx, {
          task_id: started.metadata?.taskId,
        })
        expect(firstKill.output).toContain(
          "Process-group cleanup is still pending",
        )
        let terminal: ToolResultObject | undefined
        await until(async () => {
          terminal = await call(hooks, "background_output", ctx, {
            task_id: started.metadata?.taskId,
          })
          return terminal.metadata?.state !== "running"
        })
        expect(terminal?.metadata?.state).toBe("killed")
        expect(await linuxProcessRunning(workerPid)).toBe(true)
        let beforeCleanup: TasksFile | undefined
        await until(async () => {
          beforeCleanup = await loadStateFile()
          return (
            beforeCleanup?.tasks.some(
              (task) =>
                task.id === started.metadata?.taskId && task.state === "killed",
            ) ?? false
          )
        })
        const beforeCleanupFile = beforeCleanup
        if (!beforeCleanupFile)
          throw new Error("terminal task state was not persisted")
        const beforeRecord = beforeCleanupFile.tasks.find(
          (task) => task.id === started.metadata?.taskId,
        )
        const completionFacts = {
          state: beforeRecord?.state,
          exitCode: beforeRecord?.exitCode,
          signal: beforeRecord?.signal,
          killReason: beforeRecord?.killReason,
          endedAt: beforeRecord?.endedAt,
        }

        await Bun.sleep(2_000)
        const repeated = await call(hooks, "background_kill", ctx, {
          task_id: started.metadata?.taskId,
        })
        expect(repeated.metadata?.state).toBe("killed")
        expect(repeated.output).toContain(
          "Process-group cleanup is still pending",
        )
        await until(
          async () => !(await linuxProcessRunning(workerPid!)),
          Math.max(1, firstKillAt + 4_500 - Date.now()),
        )
        const afterCleanup = await call(hooks, "background_output", ctx, {
          task_id: started.metadata?.taskId,
        })
        expect(afterCleanup.metadata).toMatchObject({
          state: "killed",
          exitCode: null,
        })
        await until(async () => {
          const file = await loadStateFile()
          return (file?.updatedAt ?? 0) > beforeCleanupFile.updatedAt
        })
        const afterRecord = (await loadStateFile())?.tasks.find(
          (task) => task.id === started.metadata?.taskId,
        )
        expect({
          state: afterRecord?.state,
          exitCode: afterRecord?.exitCode,
          signal: afterRecord?.signal,
          killReason: afterRecord?.killReason,
          endedAt: afterRecord?.endedAt,
        }).toEqual(completionFacts)
      } finally {
        await forceKillProcessGroup(processGroup, workerPid)
      }
    },
    15_000,
  )

  test.skipIf(process.platform !== "linux")(
    "kills a remaining process group through a normally exited task record",
    async () => {
      const { client } = makeClient()
      const hooks = await load(client, { notify: false, toast: false })
      const { ctx } = makeCtx("ses_natural_terminal_kill")
      const marker = path.join(sandbox, "natural-terminal-worker.pid")
      let processGroup: number | undefined
      let workerPid: number | undefined
      try {
        const started = await run(hooks, ctx, {
          command: termResistantDescendantCommand(marker, "exit 0"),
        })
        processGroup = started.metadata?.pid as number | undefined
        expect(processGroup).toBeNumber()
        workerPid = await readReadyPid(marker)
        expect((await linuxProcessState(workerPid))?.processGroup).toBe(
          processGroup,
        )

        let terminal: ToolResultObject | undefined
        await until(async () => {
          terminal = await call(hooks, "background_output", ctx, {
            task_id: started.metadata?.taskId,
          })
          return terminal.metadata?.state !== "running"
        })
        expect(terminal?.metadata).toMatchObject({
          state: "exited",
          exitCode: 0,
        })
        expect(await linuxProcessRunning(workerPid)).toBe(true)

        await until(async () => {
          const file = await loadStateFile()
          return (
            file?.tasks.some(
              (task) =>
                task.id === started.metadata?.taskId && task.state === "exited",
            ) ?? false
          )
        })
        const beforeFile = await loadStateFile()
        const beforeCleanup = beforeFile?.tasks.find(
          (task) => task.id === started.metadata?.taskId,
        )
        const killed = await call(hooks, "background_kill", ctx, {
          task_id: started.metadata?.taskId,
        })
        expect(killed.output).toContain(
          "Process-group cleanup is still pending",
        )
        await until(async () => !(await linuxProcessRunning(workerPid!)), 4_500)
        const afterCleanup = await call(hooks, "background_output", ctx, {
          task_id: started.metadata?.taskId,
        })
        expect(afterCleanup.metadata).toMatchObject({
          state: "exited",
          exitCode: 0,
        })
        await until(async () => {
          const file = await loadStateFile()
          return (file?.updatedAt ?? 0) > (beforeFile?.updatedAt ?? 0)
        })
        const afterRecord = (await loadStateFile())?.tasks.find(
          (task) => task.id === started.metadata?.taskId,
        )
        expect(afterRecord).toMatchObject({
          state: "exited",
          exitCode: 0,
          endedAt: beforeCleanup?.endedAt,
        })
        expect(afterRecord?.killReason).toBeUndefined()
        expect(afterRecord?.signal).toBe(beforeCleanup?.signal)
      } finally {
        await forceKillProcessGroup(processGroup, workerPid)
      }
    },
    15_000,
  )

  test.skipIf(process.platform !== "linux")(
    "latches an absent group reported by the keeper without reopening it",
    async () => {
      const { client } = makeClient()
      const hooks = await load(client, { notify: false, toast: false })
      const { ctx } = makeCtx("ses_absent_group_race")
      const marker = path.join(sandbox, "absent-group-race-worker.pid")
      let processGroup: number | undefined
      let workerPid: number | undefined
      let restoreSignal = () => {}
      try {
        const started = await run(hooks, ctx, {
          command: termResistantDescendantCommand(marker, "exit 0"),
        })
        const id = started.metadata?.taskId as string
        processGroup = started.metadata?.pid as number | undefined
        expect(processGroup).toBeNumber()
        workerPid = await readReadyPid(marker)
        await until(async () => {
          const result = await call(hooks, "background_output", ctx, {
            task_id: id,
          })
          return result.metadata?.state === "exited"
        })
        expect(await linuxProcessRunning(workerPid)).toBe(true)

        const group = groups.get(processGroup!)!
        const originalSignal = group.signal
        const targetCalls: Array<NodeJS.Signals | number | undefined> = []
        group.signal = async (signal) => {
          targetCalls.push(signal)
          if (targetCalls.length === 1) {
            await originalSignal("SIGKILL")
            return "absent"
          }
          return "signalled"
        }
        restoreSignal = () => (group.signal = originalSignal)

        const first = await call(hooks, "background_kill", ctx, {
          task_id: id,
        })
        expect(first.output).not.toContain(
          "Process-group cleanup is still pending",
        )
        await call(hooks, "background_kill", ctx, { task_id: id })
        await Bun.sleep(3_200)
        expect(targetCalls).toEqual(["SIGTERM"])
        expect(await linuxProcessRunning(workerPid)).toBe(false)
      } finally {
        restoreSignal()
        await forceKillProcessGroup(processGroup, workerPid)
      }
    },
    15_000,
  )

  test.skipIf(process.platform !== "linux")(
    "session deletion defers discard until an early-finalized kill cleans its group",
    async () => {
      const { client } = makeClient()
      const hooks = await load(client, { notify: false, toast: false })
      const { ctx } = makeCtx("ses_deleted_after_terminal_kill")
      const marker = path.join(sandbox, "deleted-terminal-worker.pid")
      let processGroup: number | undefined
      let workerPid: number | undefined
      try {
        const started = await run(hooks, ctx, {
          command: termResistantDescendantCommand(marker, "exec sleep 30"),
        })
        const id = started.metadata?.taskId as string
        processGroup = started.metadata?.pid as number | undefined
        expect(processGroup).toBeNumber()
        workerPid = await readReadyPid(marker)
        expect((await linuxProcessState(workerPid))?.processGroup).toBe(
          processGroup,
        )

        const firstKillAt = Date.now()
        await call(hooks, "background_kill", ctx, { task_id: id })
        await until(async () => {
          const result = await call(hooks, "background_output", ctx, {
            task_id: id,
          })
          return result.metadata?.state === "killed"
        })
        expect(await linuxProcessRunning(workerPid)).toBe(true)

        await hooks.event?.({
          event: {
            type: "session.deleted",
            properties: { info: { id: "ses_deleted_after_terminal_kill" } },
          } as any,
        })
        const retained = await call(hooks, "background_output", ctx, {
          task_id: id,
        })
        expect(retained.metadata).toMatchObject({
          state: "killed",
          exitCode: null,
        })
        await until(async () => {
          const record = (await loadStateFile())?.tasks.find(
            (task) => task.id === id,
          )
          return record?.killReason === "background_kill"
        })

        await until(
          async () => !(await linuxProcessRunning(workerPid!)),
          Math.max(1, firstKillAt + 4_500 - Date.now()),
        )
        await until(
          async () =>
            !(await loadStateFile())?.tasks.some((task) => task.id === id),
        )
        await expect(
          call(hooks, "background_output", ctx, { task_id: id }),
        ).rejects.toThrow(scopedTaskError(id))
      } finally {
        await forceKillProcessGroup(processGroup, workerPid)
      }
    },
    15_000,
  )

  test.skipIf(process.platform !== "linux")(
    "dispose cleans a naturally exited task group without rewriting its completion",
    async () => {
      const { client } = makeClient()
      const hooks = await load(client, { notify: false, toast: false })
      const { ctx } = makeCtx("ses_dispose_terminal_group")
      const marker = path.join(sandbox, "dispose-terminal-worker.pid")
      let processGroup: number | undefined
      let workerPid: number | undefined
      let observed: ReturnType<typeof observeProcessGroupSignals> | undefined
      try {
        const started = await run(hooks, ctx, {
          command: termResistantDescendantCommand(marker, "exit 0"),
        })
        const id = started.metadata?.taskId as string
        processGroup = started.metadata?.pid as number | undefined
        expect(processGroup).toBeNumber()
        workerPid = await readReadyPid(marker)
        expect((await linuxProcessState(workerPid))?.processGroup).toBe(
          processGroup,
        )
        observed = observeProcessGroupSignals(processGroup!)

        let terminal: ToolResultObject | undefined
        await until(async () => {
          terminal = await call(hooks, "background_output", ctx, {
            task_id: id,
          })
          return terminal.metadata?.state === "exited"
        })
        expect(terminal?.metadata).toMatchObject({
          state: "exited",
          exitCode: 0,
        })
        expect(await linuxProcessRunning(workerPid)).toBe(true)

        await hooks.dispose?.()
        active = undefined
        expect(await groups.get(processGroup!)!.groupClosed).toBe("complete")
        expect(await linuxProcessRunning(workerPid)).toBe(false)
        expect(observed.signals).toContain("SIGTERM")
        expect(observed.signals).toContain("SIGKILL")
        const afterCleanup = await call(hooks, "background_output", ctx, {
          task_id: id,
        })
        expect(afterCleanup.metadata).toMatchObject({
          state: "exited",
          exitCode: 0,
        })
      } finally {
        observed?.restore()
        await forceKillProcessGroup(processGroup, workerPid)
      }
    },
    15_000,
  )

  test("killing an already-finished task is a non-error", async () => {
    const { client, prompts } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, { command: "printf leftover" })
    await until(() => prompts.length > 0)
    const result = await call(hooks, "background_kill", ctx, {
      task_id: started.metadata?.taskId,
    })
    expect(result.output).toContain("had already exited with code 0")
    expect(result.output).toContain("leftover")
  })
})

describe("state files + TUI kill channel", () => {
  test("lifecycle transitions land in the owned state file; dispose removes it and kills tasks", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command: "sleep 30",
      name: "watched",
    })
    await until(
      async () =>
        (await loadStateFile())?.tasks.some(
          (task) => task.state === "running",
        ) ?? false,
    )
    const state = await loadStateFile()
    const running = state?.tasks.find(
      (task) => task.id === started.metadata?.taskId,
    )
    expect(running?.name).toBe("watched")
    expect(running?.pid).toBeDefined()
    const pid = running?.pid as number
    const file = tasksFilePath(stateDir, root, state?.instance.id as string)
    await hooks.dispose?.()
    expect(await loadTasksFile(file)).toBeUndefined()
    expect(
      await loadTasksFile(legacyTasksFilePath(stateDir, root)),
    ).toBeUndefined()
    await until(() => !isProcessAlive(pid))
  })

  test("two live servers keep interleaved state and dispose only their own file", async () => {
    const firstHooks = await load(makeClient().client, {
      notify: false,
      toast: false,
    })
    const firstCtx = makeCtx("ses_first")
    let secondHooks: Hooks | undefined
    let firstDisposed = false
    let secondDisposed = false
    try {
      const first = await run(firstHooks, firstCtx.ctx, {
        command: "sleep 30",
        name: "first server",
      })
      await until(async () => (await loadStateFiles()).length === 1)

      secondHooks = await load(makeClient().client, {
        notify: false,
        toast: false,
      })
      const secondCtx = makeCtx("ses_second")
      const second = await run(secondHooks, secondCtx.ctx, {
        command: "sleep 30",
        name: "second server",
      })
      await until(async () => {
        const files = await loadStateFiles()
        return (
          files.length === 2 &&
          files
            .flatMap((file) => file.tasks)
            .filter((task) => task.state === "running").length === 2
        )
      })
      const live = (await loadStateFiles()).flatMap((file) => file.tasks)
      expect(live.map((task) => task.id).sort()).toEqual(
        [first.metadata?.taskId, second.metadata?.taskId].sort(),
      )
      expect(live.some((task) => task.state === "error")).toBe(false)
      await until(async () => {
        const aggregate = await loadTasksFile(
          legacyTasksFilePath(stateDir, root),
        )
        return (
          aggregate?.aggregate === true &&
          aggregate.tasks.length === 2 &&
          aggregate.tasks.every(
            (task) =>
              task.state === "running" && task.ownerFormat === "instance",
          )
        )
      })

      await call(firstHooks, "background_kill", firstCtx.ctx, {
        task_id: first.metadata?.taskId,
      })
      await until(async () => {
        const tasks = (await loadStateFiles()).flatMap((file) => file.tasks)
        return (
          tasks.find((task) => task.id === first.metadata?.taskId)?.state ===
            "killed" &&
          tasks.find((task) => task.id === second.metadata?.taskId)?.state ===
            "running"
        )
      })

      await firstHooks.dispose?.()
      firstDisposed = true
      await until(async () => {
        const files = await loadStateFiles()
        return (
          files.length === 1 &&
          files[0]?.tasks.some(
            (task) =>
              task.id === second.metadata?.taskId && task.state === "running",
          ) === true
        )
      })
      expect(isProcessAlive(second.metadata?.pid as number)).toBe(true)
      const remainingAggregate = await loadTasksFile(
        legacyTasksFilePath(stateDir, root),
      )
      expect(remainingAggregate?.aggregate).toBe(true)
      expect(remainingAggregate?.tasks.map((task) => task.id)).toEqual([
        second.metadata?.taskId,
      ])
      await call(secondHooks, "background_kill", secondCtx.ctx, {
        task_id: second.metadata?.taskId,
      })
      await secondHooks.dispose?.()
      secondDisposed = true
      expect(
        await loadTasksFile(legacyTasksFilePath(stateDir, root)),
      ).toBeUndefined()
    } finally {
      if (!firstDisposed) await firstHooks.dispose?.()
      if (!secondDisposed) await secondHooks?.dispose?.()
      active = undefined
    }
  }, 10_000)

  test("a state file owned by a distinct live process remains a peer", async () => {
    const peer = Bun.spawn(["sleep", "30"])
    const peerInstance = "live-peer"
    const peerFile = tasksFilePath(stateDir, root, peerInstance)
    await writeJsonFile(peerFile, {
      version: 1,
      instance: {
        id: peerInstance,
        pid: peer.pid,
        startedAt: Date.now() - 1_000,
      },
      updatedAt: Date.now(),
      tasks: [
        {
          id: "bg_111111_1",
          name: "peer task",
          command: "sleep 30",
          workdir: root,
          sessionID: "ses_peer",
          agent: "build",
          pid: peer.pid,
          state: "running",
          startedAt: Date.now() - 1_000,
          outputBytes: 0,
          droppedBytes: 0,
        },
      ],
    } satisfies TasksFile)
    const hooks = await load(makeClient().client, {
      notify: false,
      toast: false,
    })
    let disposed = false
    try {
      await until(async () => (await loadStateFiles()).length === 2)
      const files = await loadStateFiles()
      const peerState = files.find((file) => file.instance.id === peerInstance)
      expect(peerState?.instance.pid).toBe(peer.pid)
      expect(peerState?.tasks[0]?.state).toBe("running")
      expect(
        files
          .flatMap((file) => file.tasks)
          .some((task) => task.state === "error"),
      ).toBe(false)

      await hooks.dispose?.()
      disposed = true
      active = undefined
      expect((await loadStateFiles()).map((file) => file.instance.id)).toEqual([
        peerInstance,
      ])
      expect(await loadTasksFile(peerFile)).toBeDefined()
    } finally {
      if (!disposed) await hooks.dispose?.()
      peer.kill()
      await peer.exited
      active = undefined
    }
  })

  test("a live legacy server survives current aggregate rewrites", async () => {
    const peer = Bun.spawn(["sleep", "30"])
    const legacyInstance = "live-legacy-peer"
    const legacyTask = "bg_222222_1"
    await writeJsonFile(legacyTasksFilePath(stateDir, root), {
      version: 1,
      instance: {
        id: legacyInstance,
        pid: peer.pid,
        startedAt: Date.now() - 1_000,
      },
      updatedAt: Date.now(),
      tasks: [
        {
          id: legacyTask,
          name: "legacy peer task",
          command: "sleep 30",
          workdir: root,
          sessionID: "ses_legacy_peer",
          agent: "build",
          pid: peer.pid,
          state: "running",
          startedAt: Date.now() - 1_000,
          outputBytes: 0,
          droppedBytes: 0,
        },
      ],
    } satisfies TasksFile)
    const hooks = await load(makeClient().client, {
      notify: false,
      toast: false,
    })
    const owner = makeCtx("ses_current")
    let disposed = false
    try {
      const current = await run(hooks, owner.ctx, { command: "sleep 30" })
      await until(async () => {
        const aggregate = await loadTasksFile(
          legacyTasksFilePath(stateDir, root),
        )
        return (
          aggregate?.aggregate === true &&
          aggregate.tasks.some((task) => task.id === legacyTask) &&
          aggregate.tasks.some((task) => task.id === current.metadata?.taskId)
        )
      })
      const aggregate = await loadTasksFile(legacyTasksFilePath(stateDir, root))
      expect(
        aggregate?.tasks.find((task) => task.id === legacyTask),
      ).toMatchObject({
        ownerInstance: { id: legacyInstance, pid: peer.pid },
        ownerFormat: "legacy",
      })

      await call(hooks, "background_kill", owner.ctx, {
        task_id: current.metadata?.taskId,
      })
      await hooks.dispose?.()
      disposed = true
      active = undefined
      const afterDispose = await loadTasksFile(
        legacyTasksFilePath(stateDir, root),
      )
      expect(afterDispose?.aggregate).toBe(true)
      expect(afterDispose?.tasks.map((task) => task.id)).toEqual([legacyTask])
    } finally {
      if (!disposed) await hooks.dispose?.()
      peer.kill()
      await peer.exited
      active = undefined
    }
  })

  // snapshotOf's recentOutput is the ONLY path by which captured output
  // reaches the TUI half — tui.tsx's "Copy recent output" reads nothing else.
  // Both halves' unit tests hand-plant this field on fixtures, so the mutant
  // `recentOutput: undefined` leaves the whole suite green while the affordance
  // silently reports "No captured output for this task yet." forever.
  test("a state-file snapshot carries the captured output tail, not just the record", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command: "printf 'hello world\\n'",
      name: "chatty",
    })
    const id = started.metadata?.taskId as string
    // The snapshot is written at lifecycle transitions, not per chunk, so the
    // exit is the first write that can carry any output at all.
    await until(
      async () =>
        (await loadStateFile())?.tasks.find((task) => task.id === id)?.state ===
        "exited",
    )
    const entry = (await loadStateFile())?.tasks.find((task) => task.id === id)
    expect(entry?.recentOutput).toContain("hello world")
  })

  // The tail is bounded independently of the buffer: a task that outrun its
  // buffer must not push a snapshot proportional to everything it ever wrote
  // into the state file, and the drop accounting must survive the round trip.
  test("an overflowing task's snapshot tail stays bounded by SNAPSHOT_TAIL_CHARS", async () => {
    const { client } = makeClient()
    // 64 KiB is the floor the option clamps to; the command writes ~220 KB.
    const hooks = await load(client, { maxBufferBytes: 64 * 1024 })
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command: "yes 0123456789 | head -n 20000",
      name: "firehose",
    })
    const id = started.metadata?.taskId as string
    await until(
      async () =>
        (await loadStateFile())?.tasks.find((task) => task.id === id)?.state ===
        "exited",
    )
    const entry = (await loadStateFile())?.tasks.find((task) => task.id === id)
    expect(entry?.droppedBytes).toBeGreaterThan(0)
    expect(entry?.recentOutput?.length).toBe(SNAPSHOT_TAIL_CHARS)
    // The assertion above is measured against the same constant the
    // implementation uses, so on its own it would follow the constant anywhere
    // — including a bump that stops it bounding anything. These pin the
    // property that makes the tail worth having, in terms nothing in src can
    // move: the snapshot is a strict fraction of both what the task wrote and
    // what the buffer still holds, so the state file never grows with the
    // task's output.
    expect(SNAPSHOT_TAIL_CHARS).toBe(16 * 1024)
    const written = entry?.outputBytes ?? 0
    expect(written).toBeGreaterThan(200_000)
    expect(entry?.recentOutput?.length ?? 0).toBeLessThan(written / 4)
    // Retained buffer = everything written minus what overflow dropped; the
    // tail must be a slice of that, not all of it.
    const retained = written - (entry?.droppedBytes ?? 0)
    expect(retained).toBeGreaterThan(60_000)
    expect(entry?.recentOutput?.length ?? 0).toBeLessThan(retained)
  }, 15_000)

  test("a TUI kill request is picked up by the sweeper while tasks run", async () => {
    const { client, prompts } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, { command: "sleep 30" })
    const id = started.metadata?.taskId as string
    // A real TUI only sees the task once the state file exists, so waiting on
    // it mirrors the earliest moment a request could be written.
    await until(
      async () =>
        (await loadStateFile())?.tasks.some((task) => task.id === id) ?? false,
    )
    await writeKillRequest(killRequestsDir(stateDir, root), id)
    await until(() => prompts.length > 0, 5_000)
    expect(prompts[0].body.parts[0].text).toContain("requested via the TUI")
    await until(
      async () =>
        (await loadStateFile())?.tasks.find((task) => task.id === id)?.state ===
        "killed",
    )
    const state = await loadStateFile()
    expect(state?.tasks.find((task) => task.id === id)?.state).toBe("killed")
    const requests = await fs
      .readdir(killRequestsDir(stateDir, root))
      .catch(() => [])
    expect(requests.filter((entry) => entry.endsWith(".json"))).toHaveLength(0)
  })

  test("another instance's kill requests are never acted on, and fresh ones are left for their owner", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, { command: "sleep 30" })
    const id = started.metadata?.taskId as string
    const killDir = killRequestsDir(stateDir, root)
    // The pre-uniqueness collision shape: same counter, different instance.
    await writeJsonFile(path.join(killDir, "kill-bg_ffffff_1-fresh.json"), {
      version: 1,
      action: "kill",
      taskID: "bg_ffffff_1",
      requestedAt: Date.now(),
    })
    await writeJsonFile(path.join(killDir, "kill-bg_eeeeee_1-stale.json"), {
      version: 1,
      action: "kill",
      taskID: "bg_eeeeee_1",
      requestedAt: Date.now() - 120_000,
    })
    // The sweeper (running because a task is) prunes the stale foreign file…
    await until(
      async () =>
        !(await fs.readdir(killDir)).includes("kill-bg_eeeeee_1-stale.json"),
    )
    // …but leaves the fresh one for its owner, and this instance's task lives.
    expect(await fs.readdir(killDir)).toContain("kill-bg_ffffff_1-fresh.json")
    const status = await call(hooks, "background_output", ctx, { task_id: id })
    expect(status.output).toContain("running")
    await call(hooks, "background_kill", ctx, { task_id: id })
  })

  test("dead current, legacy, and aggregate-only writers become orphaned debris", async () => {
    const dead = Bun.spawn(["sh", "-c", "true"])
    await dead.exited
    const deadInstance = "dead-instance"
    const legacyInstance = "dead-legacy-instance"
    const aggregateInstance = "dead-aggregate-instance"
    const deadFile = tasksFilePath(stateDir, root, deadInstance)
    const crashed = (instanceID: string, taskID: string): TasksFile => ({
      version: 1,
      instance: {
        id: instanceID,
        pid: dead.pid,
        startedAt: Date.now() - 10_000,
      },
      updatedAt: Date.now() - 5_000,
      tasks: [
        {
          id: taskID,
          name: "orphan",
          command: "sleep 30",
          workdir: root,
          sessionID: "ses_dead",
          agent: "build",
          pid: dead.pid,
          state: "running",
          startedAt: Date.now() - 9_000,
          outputBytes: 0,
          droppedBytes: 0,
        },
      ],
    })
    const aggregateOnly = crashed(aggregateInstance, "bg_aggregate_1")
    aggregateOnly.aggregate = true
    aggregateOnly.tasks = aggregateOnly.tasks.map((task) => ({
      ...task,
      ownerInstance: aggregateOnly.instance,
      ownerFormat: "instance",
    }))
    await Promise.all([
      writeJsonFile(deadFile, crashed(deadInstance, "bg_dead00_1")),
      writeJsonFile(
        legacyTasksFilePath(stateDir, root),
        crashed(legacyInstance, "bg_legacy_1"),
      ),
      writeJsonFile(preSlugTasksFilePath(stateDir, root), aggregateOnly),
    ])
    const hooks = await load(makeClient().client)
    await until(async () => {
      const files = await loadStateFiles()
      const aggregate = await loadTasksFile(legacyTasksFilePath(stateDir, root))
      return (
        files.length === 1 &&
        files[0]?.instance.id !== deadInstance &&
        files[0]?.tasks.filter((task) => task.state === "error").length === 3 &&
        aggregate?.aggregate === true &&
        aggregate.tasks.filter((task) => task.state === "error").length === 3
      )
    })
    expect(await loadTasksFile(deadFile)).toBeUndefined()
    const orphans = (await loadStateFile())?.tasks ?? []
    expect(orphans.map((task) => task.id).sort()).toEqual([
      "bg_aggregate_1",
      "bg_dead00_1",
      "bg_legacy_1",
    ])
    expect(
      orphans.every(
        (task) =>
          task.state === "error" &&
          task.errorMessage?.includes(
            "orphaned by a previous OpenCode instance",
          ),
      ),
    ).toBe(true)
    expect(
      (await loadTasksFile(legacyTasksFilePath(stateDir, root)))?.aggregate,
    ).toBe(true)
    void hooks
  })
})

describe("event + tool.definition hooks", () => {
  test("session.deleted kills the session's tasks silently and drops their records", async () => {
    const { client, prompts, toasts } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx("ses_doomed")
    const started = await run(hooks, ctx, { command: "sleep 30" })
    await until(
      async () =>
        (await loadStateFile())?.tasks.some(
          (task) => task.state === "running",
        ) ?? false,
    )
    const pid = (await loadStateFile())?.tasks[0]?.pid as number
    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses_doomed" } },
      } as any,
    })
    await until(() => !isProcessAlive(pid))
    await until(async () => ((await loadStateFile())?.tasks.length ?? -1) === 0)
    expect(prompts).toHaveLength(0)
    expect(
      toasts.filter((toast) => toast.body.title === "Background task finished"),
    ).toHaveLength(0)
    void started
  })

  test("bashHint appends to the builtin bash description only", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const bash = { description: "original", parameters: {} }
    await hooks["tool.definition"]?.({ toolID: "bash" } as any, bash as any)
    expect(bash.description).toContain("original")
    expect(bash.description).toContain("background_run")
    const read = { description: "original", parameters: {} }
    await hooks["tool.definition"]?.({ toolID: "read" } as any, read as any)
    expect(read.description).toBe("original")
    const off = await load(makeClient().client, { bashHint: false })
    const untouched = { description: "original", parameters: {} }
    await off["tool.definition"]?.({ toolID: "bash" } as any, untouched as any)
    expect(untouched.description).toBe("original")
  })
})

// ---------------------------------------------------------------------------
// WP5 audit coverage: fail-paths that execute in no existing test. Each case
// is written to FAIL against the named surviving mutant and PASS on baseline —
// line coverage was already present; what was missing is an assertion.
// ---------------------------------------------------------------------------

describe("WP5: background_run timeout_ms arms the hard-kill deadline", () => {
  // Nothing passes timeout_ms to background_run today (the only timeout_ms in
  // the suite is background_WAIT's). Surviving mutants: (a) killGroup reason
  // "background_kill" instead of "timeout"; (b) the whole timer block deleted
  // (task runs forever, no note); (c) dropping `timeoutMs` off the record
  // (endedPhrase degrades to "its 0 ms timeout").
  test("a timed-out run is killed with reason 'timeout' and the note names the deadline", async () => {
    const { client, prompts } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command: "sleep 30",
      timeout_ms: 300,
    })
    const id = started.metadata?.taskId as string
    const pid = started.metadata?.pid as number
    // Timer fires at ~300ms -> killGroup(task,"timeout") -> finalize ->
    // deliverNotification posts (session is never busy, so it posts at once).
    // Deleting the block (mutant b) leaves the task running: no note ever
    // arrives and this until throws.
    await until(() => prompts.length > 0)
    const text = prompts[0].body.parts[0].text as string
    // The literal "300 ms" is load-bearing: mutant (a) makes it
    // "was killed (SIGTERM)", mutant (c) makes it "its 0 ms timeout".
    expect(text).toContain("was killed after exceeding its 300 ms timeout")
    await until(
      async () =>
        (await loadStateFile())?.tasks.find((t) => t.id === id)?.state ===
        "killed",
    )
    const snap = (await loadStateFile())?.tasks.find((t) => t.id === id)
    expect(snap?.state).toBe("killed")
    // Independently kills mutant (a): the reason itself is recorded.
    expect(snap?.killReason).toBe("timeout")
    // Kills mutant (b) alongside the until above: the process is really reaped.
    await until(() => !isProcessAlive(pid))
    expect(isProcessAlive(pid)).toBe(false)
  })
})

describe("WP5: background_wait already-satisfied fast path", () => {
  // These pin the CALL SITE at index.ts:1327-1339 (the requireTerminated
  // argument + the buffer.cursor advance); scanLinesForMatch itself is already
  // pinned in shared.test.ts. Two mutants: (M1) delete the whole `if (pattern)`
  // sync block; (M2) flip `record.state === "running"` to a literal `true`.
  test("Case A: a running task whose pattern already landed matches synchronously and advances the cursor", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command: "printf 'Listening on 3000\\nextra\\n'; sleep 30",
    })
    const id = started.metadata?.taskId as string
    await Bun.sleep(200) // the chunk lands while the task keeps running
    // timeout_ms:500 bounds the mutant: under M1 the waiter registers, pumpWaiters
    // only fires on NEW chunks, and the quiet task returns "timeout" fast.
    const r = await call(hooks, "background_wait", ctx, {
      task_id: id,
      pattern: "Listening on \\d+",
      timeout_ms: 500,
    })
    expect(r.metadata?.outcome).toBe("matched")
    expect(r.metadata?.matchedLine).toBe("Listening on 3000")
    // The cursor advanced exactly through the match: only "extra" is left.
    const rest = await call(hooks, "background_output", ctx, { task_id: id })
    expect(rest.output).toContain("extra")
    expect(rest.output).not.toContain("Listening")
    await call(hooks, "background_kill", ctx, { task_id: id })
  })

  test("Case B: an exited task's unterminated tail still matches (requireTerminated tracks state)", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, { command: "printf 'ready'" })
    const id = started.metadata?.taskId as string
    // Poll the state file (not prompts): the notification read (tailOf) does not
    // advance the cursor, so the fast-path scan from cursor 0 still sees "ready".
    await until(
      async () =>
        (await loadStateFile())?.tasks.find((t) => t.id === id)?.state ===
        "exited",
    )
    const r = await call(hooks, "background_wait", ctx, {
      task_id: id,
      pattern: "ready",
    })
    // Under M2 (requireTerminated forced true) the unterminated "ready" cannot
    // match, so outcome is "exited" and matchedLine is absent.
    expect(r.metadata?.outcome).toBe("matched")
    expect(r.metadata?.matchedLine).toBe("ready")
  })
})

describe("WP5: pumpWaitersFinal pattern scan", () => {
  // The distinct exit-time scan at index.ts:522-547 (requireTerminated=false),
  // reached only when a pattern waiter is registered BEFORE its match lands.
  // Mutants: (M1) delete the `if (waiter.pattern)` block (always kind:"exited");
  // (M2) pass `true` instead of `false` (the unterminated tail never matches).
  test("positive: a pattern waiter registered before an unterminated final line matches at close", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command: "sleep 0.3; printf 'BUILD OK'",
    })
    const id = started.metadata?.taskId as string
    // Called synchronously after run: the buffer is empty (still sleeping) and
    // state is "running", so the 1327 sync scan finds nothing and a waiter is
    // registered. The live pumpWaiters (requireTerminated=true) cannot match the
    // trailing unterminated 'BUILD OK', so only pumpWaitersFinal can settle it.
    const r = await call(hooks, "background_wait", ctx, {
      task_id: id,
      pattern: "BUILD OK",
    })
    expect(r.metadata?.outcome).toBe("matched")
    expect(r.metadata?.matchedLine).toBe("BUILD OK")
  })

  test("negative twin: a non-matching pattern waiter settles as exited at close", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command: "sleep 0.3; printf 'BUILD OK'",
    })
    const r = await call(hooks, "background_wait", ctx, {
      task_id: started.metadata?.taskId as string,
      pattern: "NEVER",
    })
    expect(r.metadata?.outcome).toBe("exited")
    expect(r.metadata?.matchedLine).toBeUndefined()
  })
})

describe("WP5: the dropped-output notice reaches the tool surface", () => {
  // lostNotice's body (index.ts:917-920) executes in no test — every existing
  // task emits a few dozen bytes so buffer.dropped stays 0. Mutants: (M1) drop
  // `...lostNotice(read.lost)` from a call site; (M2) flip the guard to
  // `lost >= 0` (a spurious "0 characters ... dropped" on every read).
  test("Case A: background_output discloses the dropped region when the buffer overflows", async () => {
    const { client } = makeClient()
    const hooks = await load(client, { maxBufferBytes: 65536 })
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command: "yes 0123456789 | head -n 7000",
    })
    const id = started.metadata?.taskId as string
    await until(
      async () =>
        (await loadStateFile())?.tasks.find((t) => t.id === id)?.state ===
        "exited",
    )
    const out = await call(hooks, "background_output", ctx, { task_id: id })
    // ~77000 chars over a 64 KiB floor -> the front is evicted before the read.
    expect(out.output).toContain("were dropped from the buffer")
    expect(out.metadata?.droppedBytes).toBeGreaterThan(0)
  })

  test("Case B: background_kill's confirmed-kill path discloses the dropped region", async () => {
    const { client } = makeClient()
    const hooks = await load(client, { maxBufferBytes: 65536 })
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, {
      command: "yes 0123456789 | head -n 7000; sleep 30",
    })
    const id = started.metadata?.taskId as string
    await Bun.sleep(300) // output lands and overflows while the task is alive
    // No background_output before the kill: reading here would advance the
    // cursor past the dropped region and make lost=0. background_kill carries no
    // droppedBytes metadata, so this string is the only guard for the 1264 site.
    const k = await call(hooks, "background_kill", ctx, { task_id: id })
    expect(k.output).toContain("were dropped from the buffer")
  })

  test("Case C: a clean read carries no spurious dropped-output notice", async () => {
    const { client } = makeClient()
    const hooks = await load(client, { maxBufferBytes: 65536 })
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, { command: "printf 'hi\\n'" })
    const id = started.metadata?.taskId as string
    await until(
      async () =>
        (await loadStateFile())?.tasks.find((t) => t.id === id)?.state ===
        "exited",
    )
    const clean = await call(hooks, "background_output", ctx, { task_id: id })
    // Under M2 (`lost >= 0`) a "0 characters ... dropped" notice would appear.
    expect(clean.output).not.toContain("were dropped")
  })
})

describe("WP5: post-spawn orphan gate", () => {
  // Three abort checkpoints precede spawn: entry, analysis, and permissions.
  // The fourth read is after the spawn event but before task registration.
  test("M1: an abort landing after spawn but before registration rejects and registers nothing", async () => {
    const { client } = makeClient()
    const hooks = await load(client)
    const { ctx } = makeCtx()
    let n = 0
    const abort = {
      get aborted() {
        n++
        return n >= 4
      },
      addEventListener() {},
      removeEventListener() {},
    }
    const fakeCtx = { ...ctx, abort }
    await expect(run(hooks, fakeCtx, { command: "sleep 300" })).rejects.toThrow(
      "aborted before its command started",
    )
    // Corroborate the process was never registered (mutant resolves + registers).
    expect((await loadStateFile())?.tasks ?? []).toHaveLength(0)
  })

  test.skipIf(process.platform === "win32")(
    "M2: the post-spawn reap uses the keeper's group capability",
    async () => {
      const { client } = makeClient()
      const hooks = await load(client)
      const { ctx } = makeCtx()
      let n = 0
      const abort = {
        get aborted() {
          n++
          return n >= 4
        },
        addEventListener() {},
        removeEventListener() {},
      }
      const fakeCtx = { ...ctx, abort }
      await expect(
        run(hooks, fakeCtx, { command: "sleep 300" }),
      ).rejects.toThrow("aborted before its command started")
      expect(groups.size).toBe(1)
      const group = [...groups.values()][0]!
      expect(await group.groupClosed).toBe("complete")
      await until(() => !isProcessAlive(group.child.pid!))
    },
  )
})

describe("WP5: an unconfirmed kill keeps its promised note", () => {
  // APPROVED FIX regression test. background_kill sets deliveredInline before
  // the confirm race; the unconfirmed branch promises "reported as killed once
  // it goes down" but — before the fix — deliveredInline stayed true and the
  // eventual finalize->deliverNotification suppressed the note. The fix clears
  // deliveredInline in the `if (!confirmed)` branch. The "note arrives"
  // assertion FAILS if that clear is reverted.
  test.skipIf(process.platform === "win32")(
    "the note eventually arrives after the child finally goes down",
    async () => {
      const { client, prompts } = makeClient()
      // Shrunk confirm window so the test need not sit out the 8s default.
      const hooks = await load(client, { killConfirmMs: 200 })
      const { ctx } = makeCtx()
      // The child ignores the process-group SIGTERM and holds stdout, so `close`
      // does not fire until it dies on its own at 2s — keeping task.closed
      // pending past the 200ms confirm window. The "escaped" marker makes this
      // deterministic: gating the kill on it guarantees the pipe-holder has
      // forked and inherited stdout before the group signal lands.
      const started = await run(hooks, ctx, {
        command: `sh -c 'trap "" TERM; echo escaped; sleep 2' & exec sleep 60`,
      })
      const id = started.metadata?.taskId as string
      await until(async () => {
        const o = await call(hooks, "background_output", ctx, { task_id: id })
        return o.output.includes("escaped")
      })
      const k = await call(hooks, "background_kill", ctx, { task_id: id })
      // Unconfirmed-branch pins (pass pre- and post-fix).
      expect(k.output).toContain("has not confirmed exit yet")
      expect(k.metadata?.state).toBe("running")
      // The kept promise (assert on prompts, NOT toasts: the toast fires before
      // the deliveredInline gate either way). Under the reverted fix this note
      // is suppressed and the until throws.
      await until(() => prompts.length > 0, 4000)
      const text = prompts[0].body.parts[0].text as string
      expect(text).toContain(String(id))
      expect(text).toContain("was killed")
    },
    10_000,
  )
})

describe("WP5: server channel disabled when no state directory", () => {
  // pathsPromise degrades to undefined when /path returns no state dir; the
  // four tools must keep working. Consumer-guard mutants: (M1) drop
  // `if (!paths) return` in writeStateFile (the swallowed TypeError logs
  // "state-file write failed"); (M2) drop `if (paths)` in dispose (reading
  // undefined.tasksDir rejects dispose). Reassigning client.path before load
  // is the technique — there is no ClientKnobs entry for it.
  test("degrades cleanly: tools work, no error log, dispose resolves", async () => {
    const { client, logs } = makeClient()
    // Must be set BEFORE load: pathsPromise is built at factory time.
    ;(client as any).path = { get: () => Promise.resolve({ data: {} }) }
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const started = await run(hooks, ctx, { command: "printf 'hi\\n'" })
    const id = started.metadata?.taskId as string
    // Degradation still returns a real task id.
    expect(id).toMatch(/^bg_[0-9a-f]{6}_1$/)
    // Output still reads back (no state file to poll, so poll the tool).
    let out: ToolResultObject | undefined
    await until(async () => {
      out = await call(hooks, "background_output", ctx, { task_id: id })
      return out.output.includes("hi")
    })
    expect(out?.output).toContain("hi")
    // Let the fire-and-forget write chain run.
    await Bun.sleep(100)
    // Producer branch logged the disabled channel.
    expect(
      logs.some((l) => String(l.body?.message).includes("no state directory")),
    ).toBe(true)
    // Kills M1: the swallowed instanceTasksFilePath(undefined.tasksDir) TypeError would
    // log exactly this warn.
    expect(
      logs.some((l) =>
        String(l.body?.message).includes("state-file write failed"),
      ),
    ).toBe(false)
    // No file was written to the (disabled) state path.
    expect(await loadStateFile()).toBeUndefined()
    // Kills M2: dispose must resolve, not reject on undefined.tasksDir.
    await expect(hooks.dispose?.()).resolves.toBeUndefined()
    active = undefined
  })
})

describe("issue #271: disposal stays scoped to one plugin instance", () => {
  test.skipIf(process.platform === "win32")(
    "disposing a running instance leaves its peer's TERM-resistant tree alive and usable past escalation",
    async () => {
      const workers: Array<{
        name: string
        hooks?: Hooks
        taskId?: string
        groupPid?: number
        descendantPid?: number
      }> = [{ name: "first" }, { name: "second" }]
      const { ctx } = makeCtx("ses_dispose_isolation")

      try {
        for (const worker of workers) {
          worker.hooks = await load(makeClient().client, {
            notify: false,
            toast: false,
          })
          // The child announces readiness only after both shells ignore TERM.
          // PID files also cover a failed run/readiness call before capture.
          // Read the actual PGID even if the keeper dies and reparents the shell.
          const publish = [
            process.execPath,
            path.join(import.meta.dir, "fixtures/record-process-group.ts"),
            path.join(root, `${worker.name}-group.pid`),
          ]
            .map(shellQuote)
            .join(" ")
          const started = await run(worker.hooks, ctx, {
            command: `trap '' TERM; ${publish} || exit 1; sh -c 'trap "" TERM; printf "%s\\n" "$$" > ${worker.name}-child.pid; printf "child-ready:%s\\n" "$$"; while :; do sleep 1; done' & while :; do sleep 1; done`,
          })
          worker.groupPid = started.metadata?.pid
          worker.taskId = started.metadata?.taskId
          const ready = await call(worker.hooks, "background_wait", ctx, {
            task_id: worker.taskId,
            pattern: "^child-ready:[0-9]+$",
            timeout_ms: 5_000,
          })
          const match = String(ready.metadata?.matchedLine).match(
            /^child-ready:([0-9]+)$/,
          )
          worker.descendantPid = Number(match?.[1]) || undefined
          expect(ready.metadata?.outcome).toBe("matched")
          expect(worker.groupPid).toBeGreaterThan(1)
          expect(worker.descendantPid).toBeGreaterThan(1)
          expect(worker.descendantPid).not.toBe(worker.groupPid)
        }

        for (const worker of workers) {
          expect(await isProcessExecuting(worker.groupPid!)).toBe(true)
          expect(await isProcessExecuting(worker.descendantPid!)).toBe(true)
        }
        const first = workers[0]!
        const second = workers[1]!
        const startedAt = performance.now()
        await first.hooks!.dispose?.()
        // An early-returning disposer must not hide a delayed kill of its peer.
        await until(() => performance.now() - startedAt >= 3_500)
        await until(() =>
          noProcessesExecuting([first.groupPid!, first.descendantPid!]),
        )
        expect(await isProcessExecuting(second.groupPid!)).toBe(true)
        expect(await isProcessExecuting(second.descendantPid!)).toBe(true)
        const remaining = await call(second.hooks!, "background_output", ctx, {
          task_id: second.taskId,
        })
        expect(remaining.metadata?.state).toBe("running")

        const next = await run(second.hooks!, ctx, {
          command: "printf 'peer-still-usable\\n'",
        })
        const completed = await call(second.hooks!, "background_wait", ctx, {
          task_id: next.metadata?.taskId,
          timeout_ms: 1_000,
        })
        expect(completed.metadata?.outcome).toBe("exited")
        expect(completed.metadata?.exitCode).toBe(0)
        expect(completed.output).toContain("peer-still-usable")
      } finally {
        const pids: number[] = []
        for (const worker of workers) {
          worker.groupPid ??=
            Number(
              await fs
                .readFile(path.join(root, `${worker.name}-group.pid`), "utf8")
                .catch(() => ""),
            ) || undefined
          if (
            worker.groupPid &&
            Number.isSafeInteger(worker.groupPid) &&
            worker.groupPid > 1
          ) {
            await forceKillProcessGroup(worker.groupPid)
            pids.push(worker.groupPid)
          }
          worker.descendantPid ??=
            Number(
              await fs
                .readFile(path.join(root, `${worker.name}-child.pid`), "utf8")
                .catch(() => ""),
            ) || undefined
          if (
            worker.descendantPid &&
            Number.isSafeInteger(worker.descendantPid) &&
            worker.descendantPid > 1
          )
            pids.push(worker.descendantPid)
        }
        active = undefined
        await Promise.all(
          workers.map((worker) => worker.hooks?.dispose?.().catch(() => {})),
        )
        await until(() => noProcessesExecuting(pids), 2_000)
      }
    },
    25_000,
  )
})

describe("issue #234: host shutdown waits for process-tree termination", () => {
  test.skipIf(process.platform === "win32")(
    "an exiting host keeps TERM-to-KILL escalation alive and drains tasks concurrently",
    async () => {
      const proc = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "fixtures", "host-shutdown.ts"),
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            TMPDIR: os.tmpdir(),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const stdoutPromise = new Response(proc.stdout).text()
      const stderrPromise = new Response(proc.stderr).text()
      let stdout = ""
      let stderr = ""
      let groupPids: number[] = []
      let descendantPids: number[] = []
      const watchdog = setTimeout(() => proc.kill("SIGKILL"), 8_000)

      try {
        const exitCode = await proc.exited
        clearTimeout(watchdog)
        ;[stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
        if (exitCode !== 0)
          throw new Error(
            `host fixture exited with ${exitCode}\nstderr:\n${stderr || "(none)"}\nstdout:\n${stdout || "(none)"}`,
          )
        const events = parseHostShutdownEvents(stdout)
        const ready = events.find((event) => event.type === "ready")
        const disposed = events.find((event) => event.type === "disposed")
        groupPids = ready?.workers.map((worker) => worker.groupPid) ?? []
        descendantPids =
          ready?.workers.map((worker) => worker.descendantPid) ?? []

        expect(ready, stderr || stdout).toBeDefined()
        expect(groupPids).toHaveLength(2)
        expect(descendantPids).toHaveLength(2)
        expect(disposed?.elapsedMs).toBeGreaterThanOrEqual(2_900)
        expect(disposed?.elapsedMs).toBeLessThan(6_000)
        const allPids = [...groupPids, ...descendantPids]
        const allStopped = () => noProcessesExecuting(allPids)
        if (process.platform !== "linux")
          await until(allStopped, 500).catch(() => {})
        // This is observed before the supervisor's finally cleanup below.
        expect(await allStopped()).toBe(true)
      } finally {
        clearTimeout(watchdog)
        if (proc.exitCode === null) proc.kill("SIGKILL")
        await proc.exited
        const drained = await Promise.all([
          stdoutPromise.catch(() => ""),
          stderrPromise.catch(() => ""),
        ])
        stdout ||= drained[0]
        stderr ||= drained[1]
        const events = parseHostShutdownEvents(stdout)
        for (const event of events) {
          if (event.type === "worker") groupPids.push(event.groupPid)
          if (event.type === "ready") {
            groupPids.push(...event.workers.map((worker) => worker.groupPid))
            descendantPids.push(
              ...event.workers.map((worker) => worker.descendantPid),
            )
          }
        }
        groupPids = [...new Set(groupPids)]
        descendantPids = [...new Set(descendantPids)]
        await Promise.all(groupPids.map((pid) => forceKillProcessGroup(pid)))
        await until(
          () => noProcessesExecuting([...groupPids, ...descendantPids]),
          2_000,
        )
      }
    },
    12_000,
  )

  test.skipIf(process.platform === "win32")(
    "dispose references and clears its deadline without restarting the sweeper",
    async () => {
      const hooks = await load(makeClient().client, {
        notify: false,
        toast: false,
      })
      const { ctx } = makeCtx("ses_dispose_deadline")
      const [responsive, resistant] = await Promise.all([
        run(hooks, ctx, {
          command:
            "trap - TERM; printf 'responsive-ready\\n'; while :; do sleep 1; done",
        }),
        run(hooks, ctx, {
          command:
            "trap '' TERM; printf 'resistant-ready\\n'; while :; do sleep 1; done",
        }),
      ])
      const readiness = await Promise.all([
        call(hooks, "background_wait", ctx, {
          task_id: responsive.metadata?.taskId,
          pattern: "^responsive-ready$",
          timeout_ms: 5_000,
        }),
        call(hooks, "background_wait", ctx, {
          task_id: resistant.metadata?.taskId,
          pattern: "^resistant-ready$",
          timeout_ms: 5_000,
        }),
      ])
      expect(
        readiness.every((result) => result.metadata?.outcome === "matched"),
      ).toBe(true)

      const timeoutSpy = spyOn(globalThis, "setTimeout")
      const clearSpy = spyOn(globalThis, "clearTimeout")
      const intervalSpy = spyOn(globalThis, "setInterval")
      let disposing: Promise<void> | undefined
      try {
        disposing = hooks.dispose?.()
        await until(() =>
          timeoutSpy.mock.calls.some((call) => call[1] === 4_000),
        )
        const deadlineCall = timeoutSpy.mock.calls.findIndex(
          (call) => call[1] === 4_000,
        )
        const deadline = timeoutSpy.mock.results[deadlineCall]
          ?.value as ReturnType<typeof setTimeout>
        expect(deadline.hasRef()).toBe(true)
        await until(async () => {
          const result = await call(hooks, "background_output", ctx, {
            task_id: responsive.metadata?.taskId,
          })
          return result.metadata?.state === "killed"
        }, 2_000)
        // The responsive command has exited, but its keeper deliberately survives
        // TERM until escalation, independently of command completion.
        expect(
          await isProcessExecuting(responsive.metadata?.pid as number),
        ).toBe(true)
        expect(
          await isProcessExecuting(resistant.metadata?.pid as number),
        ).toBe(true)

        await disposing
        expect(clearSpy.mock.calls.some((call) => call[0] === deadline)).toBe(
          true,
        )
        expect(intervalSpy).toHaveBeenCalledTimes(0)
      } finally {
        timeoutSpy.mockRestore()
        clearSpy.mockRestore()
        intervalSpy.mockRestore()
        const pids = [responsive, resistant].map(
          (task) => task.metadata?.pid as number,
        )
        await Promise.all(pids.map((pid) => forceKillProcessGroup(pid)))
        await (disposing ?? hooks.dispose?.())?.catch(() => {})
        await until(() => noProcessesExecuting(pids), 2_000)
        active = undefined
      }
    },
    10_000,
  )

  test.skipIf(process.platform !== "linux")(
    "bounded disposal returns when an escaped group keeps child pipes open",
    async () => {
      const { client } = makeClient()
      const hooks = await load(client, { killConfirmMs: 1 })
      const { ctx } = makeCtx("ses_dispose_escaped_pipe")
      const escapedPidFile = path.join(sandbox, "escaped.pid")
      // Create the escaped group through the runtime, not a shell wrapper that
      // the permission analyzer deliberately rejects.
      const source = [
        'const { spawn } = require("node:child_process")',
        'process.on("SIGTERM", () => {})',
        'const child = spawn("/bin/sh", ["-c", \'trap "" TERM; printf "escaped:%s\\\\n" "$$"; while :; do sleep 1; done\'], { detached: true, stdio: ["ignore", "inherit", "inherit"] })',
        `require("node:fs").writeFileSync(${JSON.stringify(escapedPidFile)}, String(child.pid))`,
        "setInterval(() => {}, 1_000)",
      ].join("; ")
      const started = await run(hooks, ctx, {
        command: `exec ${[process.execPath, "-e", source]
          .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
          .join(" ")}`,
      })
      const leaderPid = started.metadata?.pid as number
      let escapedPid: number | undefined
      let disposeTimer: ReturnType<typeof setTimeout> | undefined

      try {
        const ready = await call(hooks, "background_wait", ctx, {
          task_id: started.metadata?.taskId,
          pattern: "^escaped:[0-9]+$",
          timeout_ms: 5_000,
        })
        const match = String(ready.metadata?.matchedLine).match(
          /^escaped:([0-9]+)$/,
        )
        escapedPid = Number(match?.[1]) || undefined
        expect(ready.metadata?.outcome).toBe("matched")
        expect(escapedPid).toBeDefined()

        const startedAt = performance.now()
        const disposeWatchdog = new Promise<never>((_, reject) => {
          disposeTimer = setTimeout(
            () => reject(new Error("dispose exceeded its bounded allowance")),
            7_000,
          )
        })
        await Promise.race([hooks.dispose?.(), disposeWatchdog])
        clearTimeout(disposeTimer)
        const elapsed = performance.now() - startedAt
        expect(elapsed).toBeGreaterThanOrEqual(3_900)
        expect(elapsed).toBeLessThan(7_000)
        expect(await groups.get(leaderPid)!.groupClosed).toBe("complete")
        expect(
          (
            await call(hooks, "background_output", ctx, {
              task_id: started.metadata?.taskId,
            })
          ).metadata?.state,
        ).toBe("running")
        expect(await isProcessExecuting(leaderPid)).toBe(false)
        expect(await isProcessExecuting(escapedPid as number)).toBe(true)
      } finally {
        if (disposeTimer) clearTimeout(disposeTimer)
        if (!escapedPid) {
          const sideChannel = await fs
            .readFile(escapedPidFile, "utf8")
            .catch(() => "")
          escapedPid = Number(sideChannel.trim()) || undefined
        }
        await forceKillProcessGroup(leaderPid)
        if (escapedPid) await forceKillProcessGroup(escapedPid)
        await until(
          async () =>
            !(await isProcessExecuting(leaderPid)) &&
            (escapedPid === undefined ||
              !(await isProcessExecuting(escapedPid))),
          2_000,
        )
        active = undefined
      }
    },
    12_000,
  )
})

describe("the busy/idle tracker lives in exactly one place", () => {
  // A tripwire, not a proof: this plugin and cron each carried a copy of the
  // same core and had drifted on every leg of it (audit 2026-07-23 §2.2), so
  // the core's own moving parts must not reappear here. The parking and
  // optimistic-busy policies above it are deliberately still local (§2.9).
  test("the server half runs the shared tracker instead of its own", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "../src/index.ts"),
    ).text()

    expect(source).toContain("createSessionActivityTracker({")
    for (const part of [
      "client.session.status",
      '"session.status"',
      '"session.idle"',
      '"session.deleted"',
    ]) {
      expect(source, `index.ts still carries ${part}`).not.toContain(part)
    }
  })
})

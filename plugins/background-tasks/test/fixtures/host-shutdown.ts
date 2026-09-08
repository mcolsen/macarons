import { BackgroundTasksPlugin } from "../../src/index"

const client = {
  app: {
    health: () =>
      Promise.resolve({ data: { healthy: true, version: "1.18.14" } }),
    log: () => Promise.resolve({ data: true }),
  },
  path: {
    // Disable the state-file channel; this fixture must not need a live host.
    get: () => Promise.resolve({ data: {} }),
  },
  session: {},
  tui: {},
}

const directory = process.cwd()
const controller = new AbortController()
const context = {
  sessionID: "ses_host_shutdown",
  messageID: "msg_host_shutdown",
  agent: "build",
  directory,
  worktree: directory,
  abort: controller.signal,
  metadata() {},
  ask: () => Promise.resolve(),
}

let hooks: Awaited<ReturnType<typeof BackgroundTasksPlugin>> | undefined
const groupPids: number[] = []

const forceCleanup = () => {
  for (const pid of groupPids) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
}

try {
  hooks = await BackgroundTasksPlugin(
    {
      client: client as never,
      directory,
      worktree: directory,
      project: {} as never,
      serverUrl: new URL("http://127.0.0.1:1"),
      experimental_workspace: { register() {} } as never,
      $: {} as never,
    },
    { notify: false, toast: false, killConfirmMs: 1 },
  )

  const tasks = await Promise.all(
    [1, 2].map(async (worker) => {
      const result = await hooks?.tool?.background_run?.execute(
        {
          command: `trap '' TERM; sh -c 'trap "" TERM; printf "worker-${worker}-child:%s\\n" "$$"; while :; do sleep 1; done' & while :; do sleep 1; done`,
          name: `shutdown worker ${worker}`,
        },
        context as never,
      )
      const metadata = (
        result as { metadata?: { taskId?: string; pid?: number } }
      ).metadata
      if (!metadata?.taskId || !metadata.pid)
        throw new Error("background_run did not return task metadata")
      groupPids.push(metadata.pid)
      process.stdout.write(
        `${JSON.stringify({ type: "worker", groupPid: metadata.pid })}\n`,
      )
      return { worker, taskId: metadata.taskId, groupPid: metadata.pid }
    }),
  )

  const workers = await Promise.all(
    tasks.map(async (task) => {
      const result = (await hooks?.tool?.background_wait?.execute(
        {
          task_id: task.taskId,
          pattern: `^worker-${task.worker}-child:[0-9]+$`,
          timeout_ms: 5_000,
        },
        context as never,
      )) as { metadata?: { outcome?: string; matchedLine?: string } }
      const match = result.metadata?.matchedLine?.match(
        new RegExp(`^worker-${task.worker}-child:([0-9]+)$`),
      )
      if (result.metadata?.outcome !== "matched" || !match)
        throw new Error(`worker ${task.worker} did not confirm readiness`)
      const descendantPid = Number(match[1])
      return { groupPid: task.groupPid, descendantPid }
    }),
  )

  process.stdout.write(`${JSON.stringify({ type: "ready", workers })}\n`)
  const startedAt = performance.now()
  await hooks.dispose?.()
  process.stdout.write(
    `${JSON.stringify({ type: "disposed", elapsedMs: performance.now() - startedAt })}\n`,
  )

  // Model the host's normal exit immediately after all plugin disposers settle.
  process.exit(0)
} catch (error) {
  await hooks?.dispose?.().catch(() => {})
  forceCleanup()
  console.error(error)
  process.exit(1)
}

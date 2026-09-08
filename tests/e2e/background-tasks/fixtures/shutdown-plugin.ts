import { appendFileSync, readFileSync } from "node:fs"
import path from "node:path"
import { BackgroundTasksPlugin } from "../../../../plugins/background-tasks/src/index"

type Input = Parameters<typeof BackgroundTasksPlugin>[0]
const version = readFileSync(
  new URL("../../../../.opencode-version", import.meta.url),
  "utf8",
).trim()
const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()

function record(directory: string, event: Record<string, unknown>) {
  appendFileSync(
    process.env.OPENCODE_E2E_SHUTDOWN_JOURNAL as string,
    `${JSON.stringify({ ...event, directory, time: Date.now() })}\n`,
  )
}

// Legacy exports are loaded in name order. This hook must not starve the
// later TasksPlugin hook, even inside a single instance's finalizer.
export async function BlockerPlugin({ directory }: Input) {
  const gate = Promise.withResolvers<void>()
  gates.set(directory, gate)
  return {
    async dispose() {
      if (process.env.OPENCODE_E2E_SHUTDOWN_GATE === "1") await gate.promise
    },
  }
}

export async function TasksPlugin(input: Input) {
  const { directory } = input
  const hooks = await BackgroundTasksPlugin(
    {
      ...input,
      // Exercise the real host's plugin lifetime, but no SDK I/O during task
      // teardown: the process barrier must fit even with the channel disabled.
      client: {
        app: {
          health: async () => ({ data: { healthy: true, version } }),
          log: async () => ({ data: true }),
        },
        path: { get: async () => ({ data: {} }) },
        session: {},
        tui: {},
      } as never,
    },
    { notify: false, toast: false, killConfirmMs: 1 },
  )
  const context = {
    sessionID: "ses_shutdown",
    messageID: "msg_shutdown",
    agent: "build",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  // Publish PIDs independently of background_run returning or readiness. The
  // outer supervisor can clean up even if initialization fails partway through.
  // Query the actual PGID; neither $$ nor a possibly reparented $PPID is safe.
  const publish = [
    process.execPath,
    path.join(
      import.meta.dir,
      "../../../../plugins/background-tasks/test/fixtures/record-process-group.ts",
    ),
    path.join(directory, "group.pid"),
  ]
    .map(quote)
    .join(" ")
  const child = `trap '' TERM; printf '%s\\n' "$$" > ${quote(path.join(directory, "descendant.pid"))}; printf 'child:%s\\n' "$$"; while :; do sleep 1; done`
  const command = `trap '' TERM; ${publish} || exit 1; sh -c ${quote(child)} & while :; do sleep 1; done`
  try {
    const result = (await hooks.tool?.background_run?.execute(
      { command, name: "host shutdown regression" },
      context as never,
    )) as { metadata?: { taskId?: string; pid?: number } }
    const { taskId, pid } = result.metadata ?? {}
    if (!taskId || !pid) throw new Error("background_run omitted task metadata")
    record(directory, { type: "spawned", groupPid: pid })
    const ready = (await hooks.tool?.background_wait?.execute(
      { task_id: taskId, pattern: "^child:[0-9]+$", timeout_ms: 5_000 },
      context as never,
    )) as { metadata?: { outcome?: string; matchedLine?: string } }
    const match = ready.metadata?.matchedLine?.match(/^child:([0-9]+)$/)
    if (ready.metadata?.outcome !== "matched" || !match)
      throw new Error("task tree did not confirm its TERM traps are installed")
    record(directory, {
      type: "ready",
      groupPid: pid,
      descendantPid: Number(match[1]),
      hostPid: process.pid,
    })
  } catch (error) {
    record(directory, { type: "error", error: String(error) })
    await hooks.dispose?.()
    throw error
  }

  if (directory !== process.env.OPENCODE_E2E_SHUTDOWN_PEER) {
    // Bootstrap a second cached directory through the worker's real in-process
    // SDK transport. No listener, provider, model prompt, or second host.
    setTimeout(() => {
      void input.client.path
        .get({ query: { directory: process.env.OPENCODE_E2E_SHUTDOWN_PEER } })
        .then((result) => {
          if (result.error) throw new Error(JSON.stringify(result.error))
        })
        .catch((error) =>
          record(directory, { type: "error", error: String(error) }),
        )
    }, 0)
  }

  return {
    ...hooks,
    async dispose() {
      record(directory, { type: "disposing" })
      gates.get(directory)?.resolve()
      const started = performance.now()
      await hooks.dispose?.()
      record(directory, {
        type: "disposed",
        elapsedMs: performance.now() - started,
      })
    },
  }
}

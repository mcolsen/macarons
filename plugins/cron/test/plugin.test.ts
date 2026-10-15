import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import { cronPlugin, IDLE_RECHECK_MS } from "../src/plugin"

const START = new Date("2026-07-11T10:00:00").getTime()

async function setup() {
  let now = START
  let sequence = 0
  const timers = new Map<number, { at: number; run(): void }>()
  const tools = new Map<string, Info>()
  const sessions: Record<string, { id: string; parentID?: string }> = {
    root: { id: "root" },
    child: { id: "child", parentID: "root" },
    other: { id: "other" },
  }
  const prompts: Array<Record<string, unknown>> = []
  const asks: Array<Record<string, unknown>> = []
  const waits: string[] = []
  const rules = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "cron", resource: "private*", effect: "deny" },
  ]
  let promptError: unknown
  let waitError: unknown
  let deny = false
  let beforeApproval: (() => void) | undefined
  let promptResult: ((input: Record<string, unknown>) => unknown) | undefined
  let eventConsumer: ((event: unknown) => void) | undefined
  let finished = false
  let disposed = 0
  const context = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (!sessions[sessionID]) throw { _tag: "SessionNotFoundError" }
        return sessions[sessionID]
      },
      wait: async ({ sessionID }: { sessionID: string }) => {
        waits.push(sessionID)
        if (waitError) throw waitError
      },
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        if (promptError) throw promptError
        return promptResult ? promptResult(input) : input
      },
    },
    permission: {
      assert: async (input: Record<string, unknown>) => {
        asks.push(input)
        beforeApproval?.()
        if (deny) throw new Error("denied")
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: (tool: Info) => tools.set(tool.name, tool) })
        return {
          dispose: async () => {
            disposed++
          },
        }
      },
    },
    agent: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          list: () => [{ id: "build", permissions: rules }],
          update: (_id: string, fn: (agent: unknown) => void) =>
            fn({ permissions: rules }),
        })
        return {
          dispose: async () => {
            disposed++
          },
        }
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!finished) {
            const event = await new Promise<unknown>((resolve) => {
              eventConsumer = resolve
              signal.addEventListener(
                "abort",
                () => {
                  finished = true
                  resolve(undefined)
                },
                { once: true },
              )
            })
            if (!event) return
            yield event
          }
        },
      }),
    },
  } as unknown as Plugin.Context
  const plugin = cronPlugin(
    {
      now: () => now,
      setTimer: (run, delay) => {
        const id = ++sequence
        timers.set(id, { at: now + delay, run })
        return id
      },
      clearTimer: (timer) => {
        timers.delete(timer as number)
      },
    },
    20,
  )
  const cleanup = await plugin.setup(context)
  async function flush() {
    for (let i = 0; i < 40; i++) await Promise.resolve()
  }
  async function advance(ms: number) {
    now += ms
    for (const [id, timer] of [...timers]) {
      if (timer.at > now) continue
      timers.delete(id)
      timer.run()
    }
    await flush()
  }
  async function call(
    name: string,
    args: unknown,
    sessionID = "root",
    signal = new AbortController().signal,
  ) {
    const tool = tools.get(name)
    if (!tool) throw new Error(`missing ${name}`)
    return tool.execute(args, {
      sessionID,
      agent: "build",
      messageID: "msg_parent",
      id: "call_1",
      signal,
      progress: async () => {},
    } as unknown as ToolContext)
  }
  const create = (sessionID = "root") =>
    call(
      "cron_create",
      { cron: "1 10 11 7 *", prompt: "check the deploy", recurring: false },
      sessionID,
    )
  return {
    tools,
    asks,
    prompts,
    waits,
    rules,
    sessions,
    create,
    call,
    advance,
    flush,
    setWaitError(error: unknown) {
      waitError = error
    },
    setPromptError(error: unknown) {
      promptError = error
    },
    setPromptResult(fn: typeof promptResult) {
      promptResult = fn
    },
    setDeny(value: boolean) {
      deny = value
    },
    beforeApproval(fn: () => void) {
      beforeApproval = fn
    },
    async emit(event: unknown) {
      eventConsumer?.(event)
      await flush()
    },
    async stop() {
      if (cleanup) await cleanup()
      await flush()
    },
    get disposed() {
      return disposed
    },
    get timerCount() {
      return timers.size
    },
  }
}

describe("native V2 cron", () => {
  test("registers three tools and puts ask before configured permission rules", async () => {
    const h = await setup()
    expect([...h.tools.keys()]).toEqual([
      "cron_create",
      "cron_list",
      "cron_delete",
    ])
    expect(h.rules).toEqual([
      { action: "*", resource: "*", effect: "allow" },
      { action: "cron", resource: "*", effect: "ask" },
      { action: "cron", resource: "private*", effect: "deny" },
    ])
    await h.stop()
    expect(h.disposed).toBe(2)
  })

  test("child-created reminder belongs to root and uses durable queue admission", async () => {
    const h = await setup()
    await h.create("child")
    expect(h.asks[0]).toMatchObject({
      sessionID: "child",
      action: "cron",
      resources: ["check the deploy"],
      source: { type: "tool", messageID: "msg_parent", id: "call_1" },
    })
    await h.advance(60_000)
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]).toMatchObject({
      sessionID: "root",
      text: "check the deploy",
      delivery: "queue",
    })
    expect(h.prompts[0]).not.toHaveProperty("agent")
    expect(h.prompts[0]).not.toHaveProperty("model")
    expect(h.prompts[0]?.id).toMatch(/^msg_/)
    expect((await h.call("cron_list", {})).content).toBe(
      "No cron jobs are scheduled for this session.",
    )
    await h.stop()
  })

  test("full prompt is permission resource, including a long tail", async () => {
    const h = await setup()
    const prompt = `${"a".repeat(1000)} private action`
    await h.call("cron_create", { cron: "* * * * *", prompt })
    expect(h.asks[0]?.resources).toEqual([prompt])
    await h.stop()
  })

  test("denied approval does not create a job", async () => {
    const h = await setup()
    h.setDeny(true)
    await expect(h.create()).rejects.toThrow("denied")
    expect((await h.call("cron_list", {})).content).toBe(
      "No cron jobs are scheduled for this session.",
    )
    await h.stop()
  })

  test("cancellation while approval is pending does not create a job", async () => {
    const h = await setup()
    const abort = new AbortController()
    h.beforeApproval(() => abort.abort(new Error("cancelled")))
    await expect(
      h.call(
        "cron_create",
        { cron: "* * * * *", prompt: "check" },
        "root",
        abort.signal,
      ),
    ).rejects.toThrow("cancelled")
    expect(h.timerCount).toBe(0)
    await h.stop()
  })

  test("invalid cron and uncertain ancestry fail before permission", async () => {
    const h = await setup()
    await expect(
      h.call("cron_create", { cron: "bad", prompt: "x" }),
    ).rejects.toThrow("Invalid cron")
    h.sessions.root = { id: "root", parentID: "child" }
    await expect(h.create("child")).rejects.toThrow("parent cycle")
    expect(h.asks).toHaveLength(0)
    await h.stop()
  })

  test("uncertain idle status holds delivery and recovers without events", async () => {
    const h = await setup()
    await h.create()
    h.setWaitError(new Error("host unavailable"))
    await h.advance(60_000)
    expect(h.prompts).toHaveLength(0)
    expect((await h.call("cron_list", {})).content).toContain("busy")
    h.setWaitError(undefined)
    await h.advance(IDLE_RECHECK_MS)
    expect(h.prompts).toHaveLength(1)
    await h.stop()
  })

  test("transport ambiguity parks the job without resubmitting", async () => {
    const h = await setup()
    await h.create()
    h.setPromptError(new Error("connection lost after dispatch"))
    await h.advance(60_000)
    expect((await h.call("cron_list", {})).content).toContain(
      "delivery unconfirmed",
    )
    await h.advance(24 * 60 * 60_000)
    expect(h.prompts).toHaveLength(1)
    await h.stop()
  })

  test("mismatched persisted input acknowledgment parks the job", async () => {
    const h = await setup()
    await h.create()
    h.setPromptResult((input) => ({ ...input, id: "msg_other" }))
    await h.advance(60_000)
    expect((await h.call("cron_list", {})).content).toContain(
      "delivery unconfirmed",
    )
    await h.stop()
  })

  test("typed admission rejection is retried with a fresh input ID", async () => {
    const h = await setup()
    await h.create()
    h.setPromptError({ _tag: "InvalidRequestError" })
    await h.advance(60_000)
    const id = h.prompts[0]?.id
    h.setPromptError(undefined)
    await h.advance(60_000)
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[1]?.id).not.toBe(id)
    await h.stop()
  })

  test("jobs cannot be deleted from another session", async () => {
    const h = await setup()
    const result = await h.create()
    await expect(
      h.call("cron_delete", { id: result.metadata?.id }, "other"),
    ).rejects.toThrow("No cron job")
    await h.call("cron_delete", { id: result.metadata?.id }, "child")
    await h.advance(60_000)
    expect(h.prompts).toHaveLength(0)
    await h.stop()
  })

  test("session deletion drops jobs and disposal clears timers", async () => {
    const h = await setup()
    await h.create()
    await h.emit({ type: "session.deleted", data: { sessionID: "root" } })
    await h.advance(60_000)
    expect(h.prompts).toHaveLength(0)
    await h.create()
    await h.stop()
    expect(h.timerCount).toBe(0)
    await h.advance(60_000)
    expect(h.prompts).toHaveLength(0)
  })
})

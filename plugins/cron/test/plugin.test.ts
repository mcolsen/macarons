import { describe, expect, test } from "bun:test"
import path from "node:path"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import {
  AWAIT_IDLE_RECHECK_MS,
  CONFIRM_DELAYS_MS,
  cronPlugin,
  NON_FINAL_CONFIRM_DELAYS_MS,
} from "../src/plugin"
import { MAX_JOBS_PER_SESSION } from "../src/scheduler"

const START = "2026-07-11T10:00:00"

type FakePrompt = {
  path: { id: string }
  signal?: AbortSignal
  body: {
    agent?: string
    model?: { providerID: string; modelID: string }
    variant?: string
    messageID?: string
    parts: Array<{ type: string; text: string }>
  }
}

type FakePromptResult = {
  data?: Record<string, never>
  error?: unknown
}

type FakeFailure = {
  error?: unknown
  reject?: Error
  hang?: boolean
  hangIgnoringAbort?: boolean
}

async function setup(options?: {
  version?: string
  realTimers?: boolean
  deliveryCallTimeoutMs?: number
  beforeSessionGet?(sessionID: string): Promise<void>
}) {
  let now = new Date(START).getTime()
  let nextTimerId = 1
  const timers: Array<{ id: number; at: number; run: () => void }> = []

  const sessions: Record<
    string,
    {
      id: string
      parentID?: string
      agent?: string
      model?: Record<string, string>
    }
  > = {
    root: {
      id: "root",
      agent: "build",
      model: { providerID: "anthropic", id: "claude-x", variant: "max" },
    },
    child: { id: "child", parentID: "root" },
    other: { id: "other" },
  }
  const statusMap: Record<string, { type: string }> = {}
  const statusQueries: Array<Record<string, unknown> | undefined> = []
  // Every session.get, in call order. A safety cap turns a regressed depth
  // guard (an infinite parentID cycle is a microtask-only loop that never
  // yields to bun's timeout timer) into a clean assertion failure.
  const sessionGets: string[] = []
  let statusError: unknown
  let sessionGetFailure: FakeFailure | undefined
  let sessionGetWait: Promise<void> | undefined
  let promptAsyncFailure: FakeFailure | undefined
  let promptAsyncImpl:
    | ((input: FakePrompt) => Promise<FakePromptResult>)
    | undefined
  // The realistic default: the host stores the prompt message it accepted.
  // foundAfterLookups delays the write: found only from lookup n+1 onward.
  let messageLookup: {
    found?: boolean
    foundAfterLookups?: number
    reject?: Error
    hang?: boolean
  } = { found: true }
  const messageLookups: Array<{ id: string; messageID: string }> = []
  const sessionGetSignals: Array<AbortSignal | undefined> = []
  const messageLookupSignals: Array<AbortSignal | undefined> = []
  const prompts: FakePrompt[] = []
  const toasts: string[] = []

  const pendingRequest = <T>(signal?: AbortSignal): Promise<T> =>
    new Promise((_, reject) => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      })
    })

  const client = {
    global: {
      health: async () => ({
        data: { version: options?.version ?? BAND.floor },
      }),
    },
    app: { log: async () => ({}) },
    session: {
      get: async (input: { path: { id: string }; signal?: AbortSignal }) => {
        sessionGets.push(input.path.id)
        sessionGetSignals.push(input.signal)
        if (sessionGets.length > 64)
          throw new Error("harness: session.get runaway")
        if (options?.beforeSessionGet)
          await options.beforeSessionGet(input.path.id)
        if (sessionGetFailure?.hang)
          return pendingRequest<{ data: (typeof sessions)[string] }>(
            input.signal,
          )
        if (sessionGetFailure?.reject) throw sessionGetFailure.reject
        if (sessionGetFailure?.error !== undefined)
          return { error: sessionGetFailure.error }
        const data = sessions[input.path.id]
        if (sessionGetWait) await sessionGetWait
        return { data }
      },
      status: async (input?: { query?: Record<string, unknown> }) => {
        statusQueries.push(input?.query)
        return statusError ? { error: statusError } : { data: statusMap }
      },
      promptAsync: async (input: FakePrompt) => {
        prompts.push(input)
        if (promptAsyncImpl) return promptAsyncImpl(input)
        if (promptAsyncFailure?.hangIgnoringAbort)
          return pendingRequest<{ data: Record<string, never> }>()
        if (promptAsyncFailure?.hang)
          return pendingRequest<{ data: Record<string, never> }>(input.signal)
        if (promptAsyncFailure?.reject) throw promptAsyncFailure.reject
        if (promptAsyncFailure?.error !== undefined)
          return { error: promptAsyncFailure.error }
        return { data: {} }
      },
      message: async (input: {
        path: { id: string; messageID: string }
        signal?: AbortSignal
      }) => {
        messageLookups.push(input.path)
        messageLookupSignals.push(input.signal)
        if (messageLookup.hang)
          return pendingRequest<{ data: Record<string, never> }>(input.signal)
        if (messageLookup.reject) throw messageLookup.reject
        const found =
          messageLookup.found ??
          (messageLookup.foundAfterLookups !== undefined &&
            messageLookups.length > messageLookup.foundAfterLookups)
        return found
          ? { data: { info: { id: input.path.messageID } } }
          : { error: { data: {} } }
      },
    },
    tui: {
      showToast: async (input: { body: { message: string } }) => {
        toasts.push(input.body.message)
        return { data: true }
      },
    },
  }

  const plugin = options?.realTimers
    ? cronPlugin(undefined, options.deliveryCallTimeoutMs)
    : cronPlugin(
        {
          now: () => now,
          setTimer: (run, delayMs) => {
            const id = nextTimerId++
            timers.push({ id, at: now + delayMs, run })
            return id
          },
          clearTimer: (timer) => {
            const index = timers.findIndex((t) => t.id === timer)
            if (index >= 0) timers.splice(index, 1)
          },
        },
        options?.deliveryCallTimeoutMs,
      )
  const hooks = await plugin({
    client,
    directory: "/project",
    worktree: "/project",
    serverUrl: new URL("http://opencode.internal"),
  } as unknown as PluginInput)

  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  const advance = async (ms: number) => {
    const target = now + ms
    for (;;) {
      await settle()
      const due = [...timers]
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers.splice(timers.indexOf(due), 1)
      now = Math.max(now, due.at)
      due.run()
      await settle()
    }
    now = target
  }

  const asks: Array<Record<string, unknown>> = []
  const ctx = (sessionID: string, ask?: () => Promise<void>): ToolContext =>
    ({
      sessionID,
      messageID: "msg",
      agent: "build",
      directory: "/project",
      worktree: "/project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask:
        ask ??
        (async (input: Record<string, unknown>) => {
          asks.push(input)
        }),
    }) as unknown as ToolContext

  // Hooks stores tools as the generic ToolDefinition, erasing each tool's
  // inferred arg and result types; the casts put them back for the tests.
  const run = (
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<any> => {
    const definition = hooks.tool?.[name]
    if (!definition) throw new Error(`tool ${name} is not registered`)
    return (definition.execute as (a: unknown, c: ToolContext) => Promise<any>)(
      args,
      context,
    )
  }

  const event = (type: string, properties: Record<string, unknown>) =>
    hooks.event?.({ event: { type, properties } as any })

  return {
    hooks,
    run,
    ctx,
    event,
    advance,
    settle,
    timers,
    prompts,
    toasts,
    statusMap,
    statusQueries,
    sessionGets,
    sessionGetSignals,
    sessions,
    messageLookups,
    messageLookupSignals,
    asks,
    setStatusError: (error: unknown) => {
      statusError = error
    },
    setSessionGetFailure: (failure: FakeFailure | undefined) => {
      sessionGetFailure = failure
    },
    setSessionGetWait: (wait: Promise<void> | undefined) => {
      sessionGetWait = wait
    },
    setPromptAsyncFailure: (failure: FakeFailure | undefined) => {
      promptAsyncFailure = failure
    },
    setPromptAsync: (
      impl: ((input: FakePrompt) => Promise<FakePromptResult>) | undefined,
    ) => {
      promptAsyncImpl = impl
    },
    setMessageLookup: (lookup: {
      found?: boolean
      foundAfterLookups?: number
      reject?: Error
      hang?: boolean
    }) => {
      messageLookup = lookup
    },
  }
}

describe("cronPlugin", () => {
  test("registers the three cron tools", async () => {
    const h = await setup()
    expect(Object.keys(h.hooks.tool ?? {}).sort()).toEqual([
      "cron_create",
      "cron_delete",
      "cron_list",
    ])
  })

  test("describes that an unconfirmable recurring fire parks its job", async () => {
    const h = await setup()
    const description = h.hooks.tool?.cron_create?.description
    expect(description).toContain("including recurring jobs")
    expect(description).toContain("parks its job unscheduled")
  })

  test("the default timer does not keep the process alive", async () => {
    const h = await setup({ realTimers: true })
    const armed: ReturnType<typeof setTimeout>[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((run: () => void, delayMs?: number) => {
      const timer = originalSetTimeout(run, delayMs)
      armed.push(timer)
      return timer
    }) as typeof setTimeout
    try {
      const created = await h.run(
        "cron_create",
        { cron: "*/5 * * * *", prompt: "check deploy" },
        h.ctx("root"),
      )
      expect(armed).toHaveLength(1)
      expect(armed[0]?.hasRef()).toBe(false)
      await h.run(
        "cron_delete",
        { id: created.metadata.id as string },
        h.ctx("root"),
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
      for (const timer of armed) clearTimeout(timer)
    }
  })

  test("injects the cron ask default into config, leaving an explicit setting alone", async () => {
    const h = await setup()
    const bare = {} as Parameters<NonNullable<typeof h.hooks.config>>[0]
    await h.hooks.config?.(bare)
    expect((bare.permission as Record<string, unknown>).cron).toBe("ask")

    const explicit = { permission: { cron: "allow" } } as unknown as Parameters<
      NonNullable<typeof h.hooks.config>
    >[0]
    await h.hooks.config?.(explicit)
    expect((explicit.permission as Record<string, unknown>).cron).toBe("allow")
  })

  test("warns but runs on an untested v1 host", async () => {
    const h = await setup({ version: "1.16.0" })
    expect(h.hooks.tool).toBeDefined()
  })

  test("disables itself on a non-v1 host (OpenCode v2+)", async () => {
    const h = await setup({ version: "2.0.0" })
    expect(h.hooks.tool).toBeUndefined()
    expect(h.hooks.event).toBeUndefined()
  })

  test("rejects an invalid expression before asking permission", async () => {
    const h = await setup()
    await expect(
      h.run("cron_create", { cron: "* * *", prompt: "p" }, h.ctx("root")),
    ).rejects.toThrow("expected 5 fields")
    expect(h.asks.length).toBe(0)
  })

  test("refuses a never-matching expression before asking permission", async () => {
    const h = await setup()
    // "0 0 30 2 *" validates (Feb 30 is field-legal) but never matches a future
    // time, so — like the per-session cap — the tool must refuse it before ever
    // prompting the user, honoring the plugin.ts:476-477 invariant. Without the
    // hoisted guard the scheduler's own create() still throws the same message,
    // so the ask-count is the load-bearing assertion here.
    await expect(
      h.run("cron_create", { cron: "0 0 30 2 *", prompt: "p" }, h.ctx("root")),
    ).rejects.toThrow(/never matches a future time/)
    expect(h.asks.length).toBe(0)
  })

  test("create asks permission, attaches to the root session, and lists there", async () => {
    const h = await setup()
    const result = await h.run(
      "cron_create",
      { cron: "*/5 * * * *", prompt: "check deploy" },
      h.ctx("child"),
    )
    expect(result.output).toContain("Created cron job cron_1")
    expect(h.asks.length).toBe(1)
    expect(h.asks[0]?.permission).toBe("cron")

    const fromRoot = await h.run("cron_list", {}, h.ctx("root"))
    expect(fromRoot.output).toContain("cron_1")
    const fromOther = await h.run("cron_list", {}, h.ctx("other"))
    expect(fromOther).toContain("No cron jobs")
  })

  test("the permission pattern carries the full prompt, untruncated", async () => {
    const h = await setup()
    const prompt =
      "check the deploy status, summarize the result for the standup notes, file follow-up tickets for anything broken, and then delete the production database"
    await h.run("cron_create", { cron: "*/5 * * * *", prompt }, h.ctx("root"))
    expect(h.asks[0]?.patterns).toEqual([prompt])
  })

  test("refuses the 51st job before asking permission", async () => {
    const h = await setup()
    for (let i = 0; i < MAX_JOBS_PER_SESSION; i++) {
      await h.run(
        "cron_create",
        { cron: "*/5 * * * *", prompt: `p${i}` },
        h.ctx("root"),
      )
    }
    expect(h.asks.length).toBe(MAX_JOBS_PER_SESSION)

    await expect(
      h.run(
        "cron_create",
        { cron: "*/5 * * * *", prompt: "overflow" },
        h.ctx("root"),
      ),
    ).rejects.toThrow("per-session limit")
    expect(h.asks.length).toBe(MAX_JOBS_PER_SESSION)
  })

  test("a denied permission creates nothing", async () => {
    const h = await setup()
    const deny = async () => {
      throw new Error("rejected")
    }
    await expect(
      h.run(
        "cron_create",
        { cron: "*/5 * * * *", prompt: "p" },
        h.ctx("root", deny),
      ),
    ).rejects.toThrow("rejected")
    expect(await h.run("cron_list", {}, h.ctx("root"))).toContain(
      "No cron jobs",
    )
  })

  test.each([
    "before setup",
    "during ancestry resolution",
    "during permission approval",
  ])(
    "cancellation %s creates nothing and retains no capacity",
    async (phase) => {
      const reached = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const h = await setup({
        beforeSessionGet:
          phase === "during ancestry resolution"
            ? async (sessionID) => {
                if (sessionID !== "root") return
                reached.resolve()
                await release.promise
              }
            : undefined,
      })
      const controller = new AbortController()
      const reason = new Error("cron_create cancelled")
      const ctx = { ...h.ctx("child"), abort: controller.signal }
      if (phase === "during permission approval") {
        const ask = ctx.ask
        ctx.ask = async (input) => {
          await ask(input)
          reached.resolve()
          await release.promise
        }
      }
      try {
        if (phase === "before setup") controller.abort(reason)
        const creating = h.run(
          "cron_create",
          { cron: "*/5 * * * *", prompt: "cancelled work" },
          ctx,
        )
        if (phase !== "before setup") {
          await reached.promise
          controller.abort(reason)
          // Approval/ancestry succeeds after cancellation, rather than rejecting.
          release.resolve()
        }
        await expect(creating).rejects.toBe(reason)
        expect(h.asks).toHaveLength(
          phase === "during permission approval" ? 1 : 0,
        )
        expect(h.sessionGets).toEqual(
          phase === "before setup" ? [] : ["child", "root"],
        )
        for (const sessionID of ["root", "child"]) {
          expect(await h.run("cron_list", {}, h.ctx(sessionID))).toContain(
            "No cron jobs",
          )
        }
        expect(h.timers).toHaveLength(0)
        await h.advance(9 * 60_000)
        await h.event("session.idle", { sessionID: "root" })
        await h.settle()
        expect(h.prompts).toHaveLength(0)
        expect(h.timers).toHaveLength(0)

        // Cancellation must leave every slot available to subsequent live calls.
        for (let i = 0; i < MAX_JOBS_PER_SESSION; i++) {
          const created = await h.run(
            "cron_create",
            { cron: "*/5 * * * *", prompt: `live work ${i}` },
            h.ctx("child"),
          )
          expect(created.metadata.id).toBe(`cron_${i + 1}`)
        }
        expect((await h.run("cron_list", {}, h.ctx("root"))).title).toBe(
          `${MAX_JOBS_PER_SESSION} cron job(s)`,
        )
      } finally {
        release.resolve()
        await h.hooks.dispose?.()
      }
    },
  )

  test("fires into the owning session via promptAsync while idle", async () => {
    const h = await setup()
    await h.run(
      "cron_create",
      { cron: "*/5 * * * *", prompt: "check deploy" },
      h.ctx("child"),
    )

    await h.advance(9 * 60_000) // 10:09 — past the 10:05 match plus max jitter
    expect(h.prompts.length).toBe(1)
    expect(h.prompts[0]?.path.id).toBe("root")
    expect(h.prompts[0]?.body.parts[0]?.text).toBe("check deploy")
    // The fired prompt echoes the session's pinned identity so the host does
    // not re-pin the session onto the default agent or strip its variant.
    expect(h.prompts[0]?.body).toMatchObject({
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-x" },
      variant: "max",
    })
    expect(h.toasts.length).toBe(1)
  })

  test("holds fires while the session is busy and flushes on the idle event", async () => {
    const h = await setup()
    await h.event("session.status", {
      sessionID: "root",
      status: { type: "busy" },
    })
    await h.run(
      "cron_create",
      { cron: "*/5 * * * *", prompt: "p" },
      h.ctx("root"),
    )

    await h.advance(11 * 60_000)
    expect(h.prompts.length).toBe(0)

    await h.event("session.idle", { sessionID: "root" })
    await h.settle()
    expect(h.prompts.length).toBe(1)
  })

  test("idle event forms racing the initial busy probe deliver a one-shot once", async () => {
    const h = await setup()
    await h.event("session.status", {
      sessionID: "root",
      status: { type: "busy" },
    })
    await h.run(
      "cron_create",
      { cron: "5 10 11 7 *", prompt: "remind", recurring: false },
      h.ctx("root"),
    )

    expect(h.timers).toHaveLength(1)
    const due = h.timers[0]!
    const run = due.run
    due.run = () => {
      run()
      // The tick queues its initial probe first. Emit idle after that probe
      // captures cached busy, but before the scheduler consumes its answer.
      queueMicrotask(() => {
        void h.event("session.status", {
          sessionID: "root",
          status: { type: "idle" },
        })
        void h.event("session.idle", { sessionID: "root" })
      })
    }

    await h.advance(5 * 60_000)
    expect(h.prompts.map((prompt) => prompt.body.parts[0]?.text)).toEqual([
      "remind",
    ])
    expect(h.messageLookups).toEqual([
      { id: "root", messageID: expect.any(String) },
    ])
    expect(h.messageLookups[0]?.messageID).toBe(h.prompts[0]?.body.messageID)
    expect(await h.run("cron_list", {}, h.ctx("root"))).toContain(
      "No cron jobs",
    )
    expect(h.timers).toHaveLength(0)

    await h.advance(24 * 60 * 60_000)
    expect(h.prompts).toHaveLength(1)
    await h.hooks.dispose?.()
  })

  test.each(["busy", "retry"])(
    "a %s transition during identity lookup defers and refreshes identity on idle",
    async (type) => {
      const h = await setup()
      await h.run(
        "cron_create",
        { cron: "20 10 11 7 *", prompt: "remind", recurring: false },
        h.ctx("root"),
      )
      let release!: () => void
      h.setSessionGetWait(
        new Promise<void>((resolve) => {
          release = resolve
        }),
      )
      try {
        await h.advance(20 * 60_000)
        expect(h.sessionGets).toEqual(["root", "root"])
        expect(h.prompts).toHaveLength(0)

        // Leave the endpoint's map idle: the event is the newer authority.
        await h.event("session.status", { sessionID: "root", status: { type } })
        h.setSessionGetWait(undefined)
        release()
        await h.settle()
        expect(h.prompts).toHaveLength(0)
        expect(h.messageLookups).toHaveLength(0)
        expect(h.toasts).toHaveLength(0)
        const pending = await h.run("cron_list", {}, h.ctx("root"))
        expect(pending.output).toContain("fired while the session was busy")
        expect(h.timers).toHaveLength(0) // deferred, not a failed-attempt retry

        await h.advance(60_000)
        h.sessions.root = {
          id: "root",
          agent: "plan",
          model: { providerID: "openai", id: "replacement", variant: "high" },
        }
        await Promise.all([
          h.event("session.status", {
            sessionID: "root",
            status: { type: "idle" },
          }),
          h.event("session.idle", { sessionID: "root" }),
        ])
        await h.settle()

        expect(h.sessionGets).toEqual(["root", "root", "root"])
        expect(h.prompts).toHaveLength(1)
        expect(h.prompts[0]?.body).toMatchObject({
          agent: "plan",
          model: { providerID: "openai", modelID: "replacement" },
          variant: "high",
          parts: [{ type: "text", text: "remind" }],
        })
        expect(h.messageLookups).toEqual([
          { id: "root", messageID: h.prompts[0]?.body.messageID as string },
        ])
        expect(await h.run("cron_list", {}, h.ctx("root"))).toContain(
          "No cron jobs",
        )

        await h.event("session.idle", { sessionID: "root" })
        await h.advance(10 * 60_000)
        expect(h.prompts).toHaveLength(1)
        expect(h.toasts).toHaveLength(1)
      } finally {
        release()
        await h.hooks.dispose?.()
      }
    },
  )

  test("duplicate idle event forms reserve pending jobs once and preserve turn order", async () => {
    const h = await setup()
    await h.event("session.status", {
      sessionID: "root",
      status: { type: "busy" },
    })
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "a", recurring: false },
      h.ctx("root"),
    )
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "b", recurring: false },
      h.ctx("root"),
    )
    await h.advance(25 * 60_000)
    expect(h.prompts.length).toBe(0) // both fired busy and went pending

    // The modern event starts one ordered turn and leaves the second job
    // pending for a genuinely later idle transition.
    await h.event("session.status", {
      sessionID: "root",
      status: { type: "idle" },
    })
    await h.settle()
    expect(h.prompts.map((p) => p.body.parts[0]?.text)).toEqual(["a"])

    // The host's legacy duplicate can arrive after the deferred result has
    // settled; it is still the same transition and must not release job b.
    await h.event("session.idle", { sessionID: "root" })
    await h.settle()
    expect(h.prompts.map((p) => p.body.parts[0]?.text)).toEqual(["a"])

    await h.event("session.status", {
      sessionID: "root",
      status: { type: "idle" },
    })
    await h.settle()
    expect(h.prompts.map((p) => p.body.parts[0]?.text)).toEqual(["a", "b"])
    expect(await h.run("cron_list", {}, h.ctx("root"))).toContain(
      "No cron jobs",
    )
  })

  test("live status releases a lane when a stored prompt produces no idle transition", async () => {
    const h = await setup()
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "first", recurring: false },
      h.ctx("root"),
    )
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "second", recurring: false },
      h.ctx("root"),
    )

    // The first write is confirmed, but the fixture emits no busy/idle events.
    // The second fire is held behind it and arms the missing-idle watchdog.
    await h.advance(20 * 60_000)
    expect(h.prompts.map((prompt) => prompt.body.parts[0]?.text)).toEqual([
      "first",
    ])

    // A live busy answer is authoritative and re-arms the check rather than
    // releasing the second prompt into a running turn.
    h.statusMap.root = { type: "busy" }
    await h.advance(AWAIT_IDLE_RECHECK_MS)
    expect(h.prompts.map((prompt) => prompt.body.parts[0]?.text)).toEqual([
      "first",
    ])

    // Even without an idle event, the next live idle answer releases the lane.
    delete h.statusMap.root
    await h.advance(AWAIT_IDLE_RECHECK_MS)
    expect(h.prompts.map((prompt) => prompt.body.parts[0]?.text)).toEqual([
      "first",
      "second",
    ])
    expect(await h.run("cron_list", {}, h.ctx("root"))).toContain(
      "No cron jobs",
    )
  })

  test("the status fallback lookup is scoped to the project directory", async () => {
    const h = await setup()
    await h.run(
      "cron_create",
      { cron: "*/5 * * * *", prompt: "p" },
      h.ctx("root"),
    )

    await h.advance(9 * 60_000)
    expect(h.prompts.length).toBe(1)
    // Unseen sessions are checked at reservation, lane entry, and dispatch.
    expect(h.statusQueries).toEqual([
      { directory: "/project" },
      { directory: "/project" },
      { directory: "/project" },
    ])
  })

  test("a status lookup error holds the fire instead of assuming idle", async () => {
    const h = await setup()
    h.setStatusError({ code: 500, message: "boom" })
    await h.run(
      "cron_create",
      { cron: "*/5 * * * *", prompt: "p" },
      h.ctx("root"),
    )

    await h.advance(9 * 60_000)
    expect(h.prompts.length).toBe(0)

    await h.event("session.idle", { sessionID: "root" })
    await h.settle()
    expect(h.prompts.length).toBe(1)
  })

  test("session.deleted drops the session's jobs", async () => {
    const h = await setup()
    await h.run(
      "cron_create",
      { cron: "*/5 * * * *", prompt: "p" },
      h.ctx("root"),
    )
    await h.event("session.deleted", { info: { id: "root" } })

    expect(await h.run("cron_list", {}, h.ctx("root"))).toContain(
      "No cron jobs",
    )
    await h.advance(10 * 60_000)
    expect(h.prompts.length).toBe(0)
  })

  test("cron_delete removes only this session's job", async () => {
    const h = await setup()
    const created = await h.run(
      "cron_create",
      { cron: "*/5 * * * *", prompt: "p" },
      h.ctx("root"),
    )
    const id = created.metadata.id as string

    await expect(h.run("cron_delete", { id }, h.ctx("other"))).rejects.toThrow(
      "No cron job",
    )
    await expect(
      h.run("cron_delete", { id: "cron_999" }, h.ctx("root")),
    ).rejects.toThrow("No cron job")
    expect(await h.run("cron_delete", { id }, h.ctx("root"))).toBe(
      `Deleted cron job ${id}.`,
    )
    expect(await h.run("cron_list", {}, h.ctx("root"))).toContain(
      "No cron jobs",
    )
  })

  test("root resolution fails closed on a host error and is not negatively cached", async () => {
    const h = await setup()
    h.setSessionGetFailure({ error: { data: { message: "boom" } } })
    await expect(
      h.run(
        "cron_create",
        { cron: "*/5 * * * *", prompt: "p" },
        h.ctx("child"),
      ),
    ).rejects.toThrow("Could not resolve this session's top-level session")
    expect(h.asks.length).toBe(0) // failed before ever prompting the user

    // The failure was not cached as an answer: the same call heals with the host.
    h.setSessionGetFailure(undefined)
    const result = await h.run(
      "cron_create",
      { cron: "*/5 * * * *", prompt: "p" },
      h.ctx("child"),
    )
    expect(result.output).toContain("Created cron job")
    const fromRoot = await h.run("cron_list", {}, h.ctx("root"))
    expect(fromRoot.output).toContain("cron_1")
  })

  test("root resolution fails closed on a transport throw, for every tool", async () => {
    const h = await setup()
    h.setSessionGetFailure({ reject: new Error("socket reset") })
    await expect(
      h.run(
        "cron_create",
        { cron: "*/5 * * * *", prompt: "p" },
        h.ctx("child"),
      ),
    ).rejects.toThrow("socket reset")
    await expect(h.run("cron_list", {}, h.ctx("root"))).rejects.toThrow(
      "Could not resolve",
    )
    await expect(
      h.run("cron_delete", { id: "cron_1" }, h.ctx("root")),
    ).rejects.toThrow("Could not resolve")
  })

  test("a confirmed walk caches every hop and survives a later host outage", async () => {
    const h = await setup()
    await h.run(
      "cron_create",
      { cron: "*/5 * * * *", prompt: "p" },
      h.ctx("child"),
    )
    h.setSessionGetFailure({ reject: new Error("down") })
    expect((await h.run("cron_list", {}, h.ctx("child"))).output).toContain(
      "cron_1",
    )
    expect((await h.run("cron_list", {}, h.ctx("root"))).output).toContain(
      "cron_1",
    )
  })

  test("every fired job carries a stable host-format message ID", async () => {
    const h = await setup()
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "remind", recurring: false },
      h.ctx("root"),
    )
    await h.run(
      "cron_create",
      { cron: "*/5 * * * *", prompt: "check" },
      h.ctx("other"),
    )

    await h.advance(20 * 60_000)
    await h.event("session.idle", { sessionID: "root" })
    await h.advance(10 * 60_000)
    const oneShot = h.prompts.find((p) => p.body.parts[0]?.text === "remind")
    const recurring = h.prompts.find((p) => p.body.parts[0]?.text === "check")
    expect(oneShot?.body.messageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(recurring?.body.messageID).toMatch(
      /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    )
  })

  test("the minted stamp ticks 4096 per millisecond, matching the host's message ordering scale", async () => {
    // The host sorts messages by the 48-bit stamp encoded in the ID, minted
    // as Date.now() * 0x1000. Get the scale wrong and the ID still has 12 hex
    // characters — so the shape regex above passes — but it sorts far below
    // the session's latest assistant message. The host then STORES the prompt
    // and its run loop exits without executing it: confirmEnqueued finds the
    // message, reports "delivered", the one-shot is deleted, and the user is
    // toasted that a reminder fired that will never run. Nothing else in this
    // package pins the multiplier, so it is asserted here as a literal
    // difference between two fires exactly one minute apart: 60_000 ms of
    // wall clock must move the stamp by 60_000 * 4096 ticks.
    const h = await setup()
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "first", recurring: false },
      h.ctx("root"),
    )
    await h.run(
      "cron_create",
      { cron: "21 10 11 7 *", prompt: "second", recurring: false },
      h.ctx("root"),
    )

    await h.advance(20 * 60_000)
    await h.event("session.idle", { sessionID: "root" })
    await h.advance(10 * 60_000)
    const first = h.prompts.find((p) => p.body.parts[0]?.text === "first")
    const second = h.prompts.find((p) => p.body.parts[0]?.text === "second")
    const stampOf = (id: string | undefined) => {
      expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
      return Number.parseInt((id as string).slice(4, 16), 16)
    }
    const firstStamp = stampOf(first?.body.messageID)
    const secondStamp = stampOf(second?.body.messageID)
    expect(secondStamp - firstStamp).toBe(245_760_000) // 60_000 ms × 4096
    // The 48-bit mask is a live path, not an edge case: today's epoch times
    // 4096 already overflows it, so the stamp is a truncated value. Dropping
    // the mask widens the stamp to 13 hex characters, which the shape regex
    // in stampOf above rejects — verified by mutation, so there is no extra
    // assertion for it here (a bound on a 12-hex slice cannot fail).
    // What the scale buys: later fires sort later as plain strings, which is
    // the comparison the host's message ordering actually performs.
    expect(
      (first?.body.messageID as string) < (second?.body.messageID as string),
    ).toBe(true)
  })

  test("a stuck delivery-time session read times out and retries without sending", async () => {
    const h = await setup({ deliveryCallTimeoutMs: 0 })
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "remind", recurring: false },
      h.ctx("root"),
    )
    // Root resolution is now cached, so this hangs only deliver()'s identity
    // read. A zero-millisecond test deadline exercises the production timeout
    // path without making the suite wait for the real loopback bound.
    h.setSessionGetFailure({ hang: true })

    await h.advance(20 * 60_000)

    expect(h.prompts).toHaveLength(0)
    expect(h.sessionGetSignals[h.sessionGetSignals.length - 1]?.aborted).toBe(
      true,
    )
    const listed = await h.run("cron_list", {}, h.ctx("root"))
    expect(listed.output).toContain("was not accepted — retrying")
  })

  test("a stuck prompt request is aborted, then correlated by message ID", async () => {
    const h = await setup({ deliveryCallTimeoutMs: 0 })
    h.setPromptAsyncFailure({ hang: true })
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "remind", recurring: false },
      h.ctx("root"),
    )

    await h.advance(20 * 60_000)

    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]?.signal?.aborted).toBe(true)
    expect(h.messageLookups).toHaveLength(1)
    // The lookup fixture found the stable ID, so the timed-out transport is
    // confirmed rather than retried and potentially delivered twice.
    expect(await h.run("cron_list", {}, h.ctx("root"))).toContain(
      "No cron jobs",
    )
  })

  test("stuck confirmation lookups are individually bounded", async () => {
    const h = await setup({ deliveryCallTimeoutMs: 0 })
    h.setMessageLookup({ hang: true })
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "remind", recurring: false },
      h.ctx("root"),
    )

    await h.advance(21 * 60_000)

    expect(h.messageLookups).toHaveLength(CONFIRM_DELAYS_MS.length + 1)
    expect(h.messageLookupSignals.every((signal) => signal?.aborted)).toBe(true)
    const listed = await h.run("cron_list", {}, h.ctx("root"))
    expect(listed.output).toContain("delivery unconfirmed")
  })

  test("same-session prompt writes serialize while another session remains independent", async () => {
    const h = await setup()
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "root first", recurring: false },
      h.ctx("root"),
    )
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "root second", recurring: false },
      h.ctx("root"),
    )
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "other", recurring: false },
      h.ctx("other"),
    )
    h.setPromptAsyncFailure({ hang: true })

    await h.advance(20 * 60_000)

    expect(
      h.prompts
        .filter((prompt) => prompt.path.id === "root")
        .map((prompt) => prompt.body.parts[0]?.text),
    ).toEqual(["root first"])
    expect(
      h.prompts
        .filter((prompt) => prompt.path.id === "other")
        .map((prompt) => prompt.body.parts[0]?.text),
    ).toEqual(["other"])
    await h.hooks.dispose?.()
    await h.settle()
  })

  test("same-session prompt IDs stay ordered across bounded deliveries", async () => {
    const h = await setup({ deliveryCallTimeoutMs: 0 })
    h.setPromptAsyncFailure({ hang: true })
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "first", recurring: false },
      h.ctx("root"),
    )
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "second", recurring: false },
      h.ctx("root"),
    )

    await h.advance(20 * 60_000)
    expect(h.prompts.map((prompt) => prompt.body.parts[0]?.text)).toEqual([
      "first",
    ])

    await h.event("session.idle", { sessionID: "root" })
    await h.settle()

    expect(h.prompts.map((prompt) => prompt.body.parts[0]?.text)).toEqual([
      "first",
      "second",
    ])
    const [first, second] = h.prompts.map((prompt) => prompt.body.messageID)
    expect(first).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(second).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect((first as string) < (second as string)).toBe(true)
  })

  test("a busy transition during the ordering wait defers the next job until idle", async () => {
    const h = await setup()
    let release!: (result: FakePromptResult) => void
    h.setPromptAsync(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const first = await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "first", recurring: false },
      h.ctx("root"),
    )
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "second", recurring: false },
      h.ctx("root"),
    )
    try {
      await h.advance(20 * 60_000)
      expect(h.prompts.map((prompt) => prompt.body.parts[0]?.text)).toEqual([
        "first",
      ])
      expect(h.sessionGets).toEqual(["root", "root"])

      await h.event("session.status", {
        sessionID: "root",
        status: { type: "busy" },
      })
      // Rejection releases the lane without the confirmed-turn idle barrier,
      // so only authoritative activity can stop the already queued second job.
      h.setPromptAsync(undefined)
      release({ error: { name: "rejected" } })
      await h.settle()
      expect(h.prompts).toHaveLength(1)
      expect(h.sessionGets).toEqual(["root", "root"])
      await h.run(
        "cron_delete",
        { id: first.metadata.id as string },
        h.ctx("root"),
      )
      const pending = await h.run("cron_list", {}, h.ctx("root"))
      expect(pending.output).toContain("fired while the session was busy")
      expect(h.timers).toHaveLength(0)

      await h.advance(60_000)
      h.sessions.root = {
        id: "root",
        agent: "plan",
        model: { providerID: "openai", id: "replacement", variant: "high" },
      }
      await Promise.all([
        h.event("session.status", {
          sessionID: "root",
          status: { type: "idle" },
        }),
        h.event("session.idle", { sessionID: "root" }),
      ])
      await h.settle()

      expect(h.prompts.map((prompt) => prompt.body.parts[0]?.text)).toEqual([
        "first",
        "second",
      ])
      expect(h.prompts[1]?.body).toMatchObject({
        agent: "plan",
        model: { providerID: "openai", modelID: "replacement" },
        variant: "high",
      })
      expect(h.messageLookups).toHaveLength(1)
      expect(await h.run("cron_list", {}, h.ctx("root"))).toContain(
        "No cron jobs",
      )
      await h.event("session.idle", { sessionID: "root" })
      await h.advance(10 * 60_000)
      expect(h.prompts).toHaveLength(2)
      expect(h.toasts).toHaveLength(1)
    } finally {
      await h.hooks.dispose?.()
    }
  })

  test("a job deleted while waiting in its session lane never dispatches", async () => {
    const h = await setup()
    let release!: (result: FakePromptResult) => void
    h.setPromptAsync(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "first", recurring: false },
      h.ctx("root"),
    )
    const second = await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "second", recurring: false },
      h.ctx("root"),
    )
    await h.advance(20 * 60_000)
    expect(h.prompts.map((prompt) => prompt.body.parts[0]?.text)).toEqual([
      "first",
    ])

    await h.run(
      "cron_delete",
      { id: second.metadata.id as string },
      h.ctx("root"),
    )
    release({ error: { name: "rejected" } })
    await h.settle()

    expect(h.prompts.map((prompt) => prompt.body.parts[0]?.text)).toEqual([
      "first",
    ])
    await h.hooks.dispose?.()
  })

  test("an abort-ignoring ambiguous request parks a recurring job before its next fire", async () => {
    const h = await setup({ deliveryCallTimeoutMs: 0 })
    h.setPromptAsyncFailure({ hangIgnoringAbort: true })
    h.setMessageLookup({ found: false })
    await h.run(
      "cron_create",
      { cron: "* * * * *", prompt: "check", recurring: true },
      h.ctx("root"),
    )

    await h.advance(30 * 60_000)

    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]?.signal?.aborted).toBe(true)
    const listed = await h.run("cron_list", {}, h.ctx("root"))
    expect(listed.output).toContain("delivery unconfirmed")
  })

  test("an abort-ignoring request cannot stop the next job in its session lane", async () => {
    const h = await setup({ deliveryCallTimeoutMs: 0 })
    h.setPromptAsyncFailure({ hangIgnoringAbort: true })
    h.setMessageLookup({ found: false })
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "first", recurring: false },
      h.ctx("root"),
    )
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "second", recurring: false },
      h.ctx("root"),
    )

    await h.advance(21 * 60_000)

    expect(h.prompts.map((prompt) => prompt.body.parts[0]?.text)).toEqual([
      "first",
      "second",
    ])
    const listed = await h.run("cron_list", {}, h.ctx("root"))
    expect(listed.output.match(/delivery unconfirmed/g)).toHaveLength(2)
  })

  test("dispose aborts an in-flight delivery request", async () => {
    const h = await setup()
    h.setMessageLookup({ hang: true })
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "remind", recurring: false },
      h.ctx("root"),
    )
    await h.advance(20 * 60_000)
    expect(h.messageLookupSignals[0]?.aborted).toBe(false)

    await h.hooks.dispose?.()

    expect(h.messageLookupSignals[0]?.aborted).toBe(true)
    expect(
      (h.messageLookupSignals[0]?.reason as Error | undefined)?.message,
    ).toBe("The cron plugin is shutting down.")
    await h.settle()
  })

  test("dispose cancels an in-flight confirmation delay", async () => {
    const h = await setup()
    h.setMessageLookup({ found: false })
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "remind", recurring: false },
      h.ctx("root"),
    )
    await h.advance(20 * 60_000)
    expect(h.messageLookups).toHaveLength(1)
    expect(h.timers).toHaveLength(1)

    await h.hooks.dispose?.()

    expect(h.timers).toHaveLength(0)
    await h.advance(10_000)
    expect(h.messageLookups).toHaveLength(1)
  })

  test("a transport failure whose message is found on the host counts as delivered", async () => {
    const h = await setup()
    h.setPromptAsyncFailure({ reject: new Error("socket closed") })
    h.setMessageLookup({ found: true })
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "remind", recurring: false },
      h.ctx("root"),
    )

    await h.advance(25 * 60_000)
    expect(h.prompts.length).toBe(1)
    expect(h.messageLookups[0]?.messageID).toBe(
      h.prompts[0]?.body.messageID as string,
    )
    // Confirmed delivered: the job is gone, no retry can duplicate it.
    expect(await h.run("cron_list", {}, h.ctx("root"))).toContain(
      "No cron jobs",
    )
    expect(h.toasts.length).toBe(1)
  })

  test("a transport failure with no message on the host parks the job for inspection", async () => {
    const h = await setup()
    h.setPromptAsyncFailure({ reject: new Error("socket closed") })
    h.setMessageLookup({ found: false })
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "remind", recurring: false },
      h.ctx("root"),
    )

    await h.advance(60 * 60_000)
    expect(h.prompts.length).toBe(1) // no blind retry — it could deliver the reminder twice
    const listed = await h.run("cron_list", {}, h.ctx("root"))
    expect(listed.output).toContain("delivery unconfirmed")
    expect(listed.output).toContain("kept for inspection")
  })

  test("a 204 whose prompt message never appears parks the job instead of claiming delivery", async () => {
    // The host's 204 answers before its forked prompt work runs; a fork that
    // dies (agent resolution, hooks, storage) never stores the user message.
    const h = await setup()
    h.setMessageLookup({ found: false })
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "remind", recurring: false },
      h.ctx("root"),
    )

    await h.advance(60 * 60_000)
    expect(h.prompts.length).toBe(1) // ambiguous — a blind retry could double-deliver
    expect(h.messageLookups.length).toBe(CONFIRM_DELAYS_MS.length + 1) // bounded polling, then park
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0]).toContain("could not be confirmed")
    expect(h.toasts[0]).not.toContain("fired")
    const listed = await h.run("cron_list", {}, h.ctx("root"))
    expect(listed.output).toContain("delivery unconfirmed")
    expect(listed.output).toContain("kept for inspection")
  })

  test("a 204 confirmed by a delayed message write still counts as delivered", async () => {
    const h = await setup()
    h.setMessageLookup({ foundAfterLookups: 2 })
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "remind", recurring: false },
      h.ctx("root"),
    )

    await h.advance(25 * 60_000)
    expect(h.messageLookups.length).toBe(3) // polled past the write lag, then stopped
    expect(await h.run("cron_list", {}, h.ctx("root"))).toContain(
      "No cron jobs",
    )
    expect(h.toasts.length).toBe(1)
  })

  test("a slow non-final recurring write gets the extended confirmation window", async () => {
    const h = await setup()
    // The sixth lookup is beyond the terminal budget (five total lookups) but
    // inside the longer non-final recurring budget (seven total lookups).
    h.setMessageLookup({ foundAfterLookups: CONFIRM_DELAYS_MS.length + 1 })
    await h.run(
      "cron_create",
      { cron: "20 10 * * *", prompt: "check", recurring: true },
      h.ctx("root"),
    )

    await h.advance(60 * 60_000)

    expect(NON_FINAL_CONFIRM_DELAYS_MS.length).toBeGreaterThan(
      CONFIRM_DELAYS_MS.length,
    )
    expect(h.messageLookups).toHaveLength(CONFIRM_DELAYS_MS.length + 2)
    const listed = await h.run("cron_list", {}, h.ctx("root"))
    expect(listed.output).not.toContain("delivery unconfirmed")
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0]).toContain("fired")
  })

  test("a host rejection retries with a freshly minted message ID and can succeed", async () => {
    const h = await setup()
    h.setPromptAsyncFailure({ error: { data: { message: "429" } } })
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "remind", recurring: false },
      h.ctx("root"),
    )

    await h.advance(20 * 60_000 + 30_000) // 10:20:30 — first attempt made and rejected
    expect(h.prompts.length).toBe(1)
    const inFlight = await h.run("cron_list", {}, h.ctx("root"))
    expect(inFlight.output).toContain("was not accepted — retrying")

    h.setPromptAsyncFailure(undefined)
    await h.advance(90_000) // past the 10:21:00 retry
    expect(h.prompts.length).toBe(2)
    // A fresh, current-time ID: the first one would sort behind any turn that
    // completed during the pause, and the host would store but never run it.
    expect(h.prompts[1]?.body.messageID).toMatch(
      /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    )
    expect(h.prompts[1]?.body.messageID).not.toBe(
      h.prompts[0]?.body.messageID as string,
    )
    // Inequality alone proves nothing here — the 14 random base62 characters
    // guarantee it even if the ID were re-minted at the ORIGINAL fire time.
    // The invariant this retry exists to protect is ORDERING, so assert the
    // time stamp itself moved forward, by the length of the retry pause.
    const stamp = (id: string | undefined) =>
      Number.parseInt((id as string).slice(4, 16), 16)
    expect(
      stamp(h.prompts[1]?.body.messageID) - stamp(h.prompts[0]?.body.messageID),
    ).toBe(245_760_000) // the 60s retry pause, at 4096 ticks per millisecond
    expect(await h.run("cron_list", {}, h.ctx("root"))).toContain(
      "No cron jobs",
    )
  })

  test("an unreadable session at delivery time sends nothing — no re-pin to the default agent", async () => {
    const h = await setup()
    await h.run(
      "cron_create",
      { cron: "20 10 11 7 *", prompt: "remind", recurring: false },
      h.ctx("root"),
    )
    h.setSessionGetFailure({ error: { data: { message: "flaky" } } })

    await h.advance(20 * 60_000 + 30_000)
    expect(h.prompts.length).toBe(0) // never prompted without the identity echo

    h.setSessionGetFailure(undefined)
    await h.advance(90_000)
    expect(h.prompts.length).toBe(1)
    expect(h.prompts[0]?.body).toMatchObject({ agent: "build" })
  })

  test("one-shot jobs report their auto-delete and fire once", async () => {
    const h = await setup()
    const result = await h.run(
      "cron_create",
      { cron: "30 14 11 7 *", prompt: "remind me", recurring: false },
      h.ctx("root"),
    )
    expect(result.output).toContain("one-shot")

    await h.advance(6 * 60 * 60_000)
    expect(h.prompts.length).toBe(1)
    expect(await h.run("cron_list", {}, h.ctx("root"))).toContain(
      "No cron jobs",
    )
  })

  describe("WP5: isIdle fallback holds a busy session", () => {
    test("a busy session in the status map holds the fire, flushed by the next idle event", async () => {
      const h = await setup()
      // Mutate the exposed map only — do NOT emit a status EVENT, or the fire
      // hits the cached fast path instead of the directory-scoped fallback we
      // are pinning.
      h.statusMap.root = { type: "busy" }
      await h.run(
        "cron_create",
        { cron: "*/5 * * * *", prompt: "p" },
        h.ctx("root"),
      )

      await h.advance(9 * 60_000)
      // Baseline: the fallback reads "busy" and holds. A tracker that answered
      // idle for a session it has no event for delivers here.
      expect(h.prompts.length).toBe(0)
      const held = await h.run("cron_list", {}, h.ctx("root"))
      expect(held.output).toContain("fired while the session was busy")

      await h.event("session.idle", { sessionID: "root" })
      await h.settle()
      expect(h.prompts.length).toBe(1)
    })

    test("a non-idle 'retry' status in the status map holds the fire", async () => {
      const h = await setup()
      h.statusMap.root = { type: "retry" }
      await h.run(
        "cron_create",
        { cron: "*/5 * * * *", prompt: "p" },
        h.ctx("root"),
      )

      await h.advance(9 * 60_000)
      // Baseline: "retry" is not idle — it is a sleeping attempt inside a live
      // run, and a prompt written then is absorbed as a steer. A tracker that
      // counted anything-but-"busy" as idle delivers here.
      expect(h.prompts.length).toBe(0)
    })

    test("a session no event has described is re-read on every fire, so a recovery needs no event", async () => {
      const h = await setup()
      h.statusMap.root = { type: "busy" }
      await h.run(
        "cron_create",
        { cron: "*/5 * * * *", prompt: "p" },
        h.ctx("root"),
      )

      // advance(13m) covers both the 10:05 and 10:10 fires (jitter reaches
      // nominal+2.5min, so 13min guarantees the second is due).
      await h.advance(13 * 60_000)
      expect(h.prompts.length).toBe(0)
      // Both fires read the host, each scoped to this project. The fallback is
      // the leg for a session the event feed has said nothing about, so its
      // answer is never cached: caching "busy" here would take an idle event
      // to clear, from the same feed that has not delivered one yet.
      expect(h.statusQueries).toEqual([
        { directory: "/project" },
        { directory: "/project" },
      ])

      // The turn ended and its idle event never reached this process — the one
      // case the fallback exists for. Only another read can notice.
      delete h.statusMap.root
      await h.advance(6 * 60_000)
      expect(h.prompts.length).toBe(1)
    })

    test("a 'retry' status cached via a status EVENT holds the fire, without asking the host", async () => {
      const h = await setup()
      // Cached through an event, not the map: an observation beats a request.
      await h.event("session.status", {
        sessionID: "root",
        status: { type: "retry" },
      })
      await h.run(
        "cron_create",
        { cron: "*/5 * * * *", prompt: "p" },
        h.ctx("root"),
      )

      await h.advance(9 * 60_000)
      // Baseline: the recorded status is not "idle", so the fire holds and no
      // request is made. A tracker that read `cached !== "busy"` as idle
      // delivers; one that confirmed every answer with the host queries.
      expect(h.prompts.length).toBe(0)
      expect(h.statusQueries).toEqual([])
    })
  })

  describe("WP5: rootSessionOf fail-closed branches", () => {
    test("a session the host returns no data for fails closed before prompting", async () => {
      const h = await setup()
      // "ghost" is absent from the fixture, so session.get answers {data:
      // undefined}. The no-data guard at :252-257 must throw. A mutant treating
      // missing data as a confirmed root resolves ghost and proceeds to ask.
      await expect(
        h.run(
          "cron_create",
          { cron: "*/5 * * * *", prompt: "p" },
          h.ctx("ghost"),
        ),
      ).rejects.toThrow(/the host returned no session data/)
      await expect(
        h.run(
          "cron_create",
          { cron: "*/5 * * * *", prompt: "p" },
          h.ctx("ghost"),
        ),
      ).rejects.toThrow(/Could not resolve this session's top-level session/)
      expect(h.asks.length).toBe(0)

      // Not negatively cached: once the session exists, the same call heals.
      h.sessions.ghost = { id: "ghost" }
      const healed = await h.run(
        "cron_create",
        { cron: "*/5 * * * *", prompt: "p" },
        h.ctx("ghost"),
      )
      expect(healed.output).toContain("Created cron job")
    })

    test("a malformed (non-string) parentID fails closed", async () => {
      const h = await setup()
      h.sessions.other!.parentID = 42 as unknown as string
      // The :265-269 guard must reject a numeric parentID. Deleting it walks to
      // id 42, finds no data, and throws /no session data/ instead.
      await expect(
        h.run(
          "cron_create",
          { cron: "*/5 * * * *", prompt: "p" },
          h.ctx("other"),
        ),
      ).rejects.toThrow(/the session's parentID is malformed/)
    })

    test("a parentID cycle stops at the depth guard rather than looping forever", async () => {
      const h = await setup()
      // child.parentID is already "root"; this closes the loop.
      h.sessions.root!.parentID = "child"
      await expect(
        h.run(
          "cron_create",
          { cron: "*/5 * * * *", prompt: "p" },
          h.ctx("child"),
        ),
      ).rejects.toThrow(/the parent chain is deeper than 16 sessions/)
      // Exactly 16 hops: depth 0..15, then the guard throws. A dropped/relaxed
      // counter loops until the harness runaway cap fires (65 gets) and wraps
      // as /session.get failed/, so both assertions catch it.
      expect(h.sessionGets.length).toBe(16)
    }, 2000)
  })

  describe("WP5: delivery-time session.get throw retries", () => {
    test("a transport throw while echoing identity is a recoverable rejection, not an ambiguous park", async () => {
      const h = await setup()
      // Create first so rootSessionOf's walk caches root before the failure is
      // armed — otherwise create() itself rejects and delivery is never reached.
      await h.run(
        "cron_create",
        { cron: "20 10 11 7 *", prompt: "remind", recurring: false },
        h.ctx("root"),
      )
      h.setSessionGetFailure({ reject: new Error("socket reset") })

      // The one-shot fires exactly at 10:20:00 (no jitter); reach 10:20:30.
      await h.advance(20 * 60_000 + 30_000)
      expect(h.prompts.length).toBe(0) // identity never resolved

      const listed = await h.run("cron_list", {}, h.ctx("root"))
      // Baseline: deliver()'s catch at :361 returns "rejected" → the scheduler
      // retries. A mutant returning "unknown" parks the job as ambiguous.
      expect(listed.output).toContain("was not accepted — retrying")
      expect(listed.output).not.toContain("delivery unconfirmed")

      h.setSessionGetFailure(undefined)
      await h.advance(90_000) // past the 60s retry
      // Baseline retries and delivers; a parked (unknown) job never would.
      expect(h.prompts.length).toBe(1)
      expect(h.prompts[0]?.body).toMatchObject({ agent: "build" })
    })
  })
})

describe("the busy/idle tracker lives in exactly one place", () => {
  // A tripwire, not a proof: this plugin and background-tasks each carried a
  // copy of the same core and had drifted on every leg of it (audit
  // 2026-07-23 §2.2), so the core's own moving parts must not reappear here.
  test("the plugin runs the shared tracker instead of its own", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "../src/plugin.ts"),
    ).text()

    expect(source).toContain("createSessionActivityTracker({")
    for (const part of [
      "client.session.status",
      '"session.status"',
      '"session.idle"',
      '"session.deleted"',
    ]) {
      expect(source, `plugin.ts still carries ${part}`).not.toContain(part)
    }
  })
})

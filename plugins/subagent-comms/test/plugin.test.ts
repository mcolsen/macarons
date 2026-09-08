import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "node:path"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import { SubagentCommsPlugin } from "../src/index"
import {
  GRACE_SPACING_MS,
  SEND_ABORTED_BEFORE_DELIVERY_MESSAGE,
  SEND_ABORTED_MESSAGE,
  SPAWN_ABORTED_MESSAGE,
  SUBAGENT_TOOL_IDS,
  taskHint,
  WAIT_ABORTED_MESSAGE,
} from "../src/shared"

type Hooks = Awaited<ReturnType<typeof SubagentCommsPlugin>>

const DIRECTORY = "/project"

type RawMessage = {
  info: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

type World = {
  sessions: Map<string, Record<string, unknown>>
  messages: Map<string, RawMessage[]>
  /** Present entry = busy/retry; absent = idle, like the real endpoint. */
  status: Record<string, { type: string }>
  /** When true, session.status never settles until its signal aborts. */
  statusHangs?: boolean
  agents: Array<Record<string, unknown>>
  /** What client.config.get returns; experimental.primary_tools lives here. */
  config: Record<string, unknown>
  /** What client.config.providers returns; deliberately includes unsafe fields. */
  providers: unknown
  /** When true, config.providers never settles until its signal aborts. */
  providerHangs?: boolean
  providerFailure?: "error" | "throw"
}

function makeWorld(): World {
  return {
    sessions: new Map([
      [
        "ses_parent",
        {
          id: "ses_parent",
          title: "root",
          agent: "build",
          model: { providerID: "anthropic", id: "claude-x", variant: "max" },
        },
      ],
    ]),
    messages: new Map([
      [
        "ses_parent",
        [
          {
            info: {
              id: "msg_parent_1",
              role: "assistant",
              sessionID: "ses_parent",
              providerID: "anthropic",
              modelID: "claude-x",
              variant: "max",
              time: { created: 1, completed: 2 },
            },
            parts: [],
          },
        ],
      ],
    ]),
    status: {},
    agents: [
      {
        name: "build",
        mode: "primary",
        permission: [{ permission: "task", pattern: "*", action: "allow" }],
      },
      { name: "general", mode: "subagent", permission: [] },
      {
        name: "explore",
        mode: "subagent",
        permission: [],
        model: { providerID: "anthropic", modelID: "claude-mini" },
      },
      { name: "secret", mode: "subagent", hidden: true, permission: [] },
    ],
    config: {},
    providers: {
      providers: [
        {
          id: "e2e",
          name: "E2E provider",
          key: "PROVIDER_KEY_SECRET",
          options: { apiKey: "PROVIDER_OPTIONS_SECRET" },
          models: {
            test: { id: "test", name: "E2E test" },
            alternate: {
              id: "alternate",
              name: "E2E alternate",
              options: { token: "MODEL_OPTIONS_SECRET" },
              headers: { Authorization: "MODEL_HEADERS_SECRET" },
              variants: { high: { private: "VARIANT_SECRET" } },
            },
          },
        },
        {
          id: "openrouter",
          name: "OpenRouter",
          models: {
            "anthropic/claude-sonnet": {
              id: "anthropic/claude-sonnet",
              name: "Claude Sonnet",
              variants: { high: {} },
            },
          },
        },
      ],
      default: { e2e: "test", openrouter: "anthropic/claude-sonnet" },
    },
  }
}

// Mimics the generated SDK client: methods live on prototypes and read
// `this`, so a detached call throws synchronously exactly like the real one.
function makeClient(world: World, version: unknown = BAND.floor) {
  const logs: any[] = []
  const toasts: any[] = []
  const prompts: any[] = []
  const creates: any[] = []
  const aborts: string[] = []
  const messageCalls: any[] = []
  const statusSignals: Array<AbortSignal | undefined> = []
  const providerSignals: Array<AbortSignal | undefined> = []
  const deletes: string[] = []
  const providerCalls: any[] = []
  let childCounter = 0
  class App {
    _client = {}
    log(input: any) {
      void this._client
      logs.push(input)
      return Promise.resolve({ data: true })
    }
    agents() {
      void this._client
      return Promise.resolve({ data: world.agents })
    }
  }
  class Tui {
    _client = {}
    showToast(input: any) {
      void this._client
      toasts.push(input)
      return Promise.resolve({ data: true })
    }
  }
  class Config {
    _client = {}
    get() {
      void this._client
      return Promise.resolve({ data: { ...world.config } })
    }
    providers(input: any) {
      void this._client
      providerCalls.push(input)
      providerSignals.push(input?.signal)
      if (world.providerHangs)
        return new Promise((_resolve, reject) => {
          input?.signal?.addEventListener(
            "abort",
            () => reject(new Error("The operation was aborted.")),
            { once: true },
          )
        })
      if (world.providerFailure === "throw")
        return Promise.reject(new Error("PROVIDER_FAILURE_SECRET"))
      if (world.providerFailure === "error")
        return Promise.resolve({
          error: { message: "PROVIDER_FAILURE_SECRET" },
        })
      return Promise.resolve({ data: world.providers })
    }
  }
  class Session {
    _client = {}
    get(input: any) {
      void this._client
      const found = world.sessions.get(input.path.id)
      return Promise.resolve(
        found ? { data: found } : { error: { name: "NotFoundError" } },
      )
    }
    children(input: any) {
      void this._client
      return Promise.resolve({
        data: [...world.sessions.values()].filter(
          (session) => session.parentID === input.path.id,
        ),
      })
    }
    status(input: any) {
      void this._client
      statusSignals.push(input?.signal)
      // Released only by its signal, exactly like the real transport — so a
      // test can tell a read that was CANCELLED from one merely abandoned.
      if (world.statusHangs)
        return new Promise((_resolve, reject) => {
          input?.signal?.addEventListener(
            "abort",
            () => reject(new Error("The operation was aborted.")),
            { once: true },
          )
        })
      return Promise.resolve({ data: { ...world.status } })
    }
    messages(input: any) {
      void this._client
      messageCalls.push(input)
      const list = world.messages.get(input.path.id) ?? []
      const limit = input.query?.limit
      // The real route returns newest-first when limited, ascending otherwise.
      return Promise.resolve({
        data: limit ? [...list].slice(-limit).reverse() : list,
      })
    }
    message(input: any) {
      void this._client
      const found = (world.messages.get(input.path.id) ?? []).find(
        (entry) => entry.info.id === input.path.messageID,
      )
      return Promise.resolve(
        found ? { data: found } : { error: { name: "NotFoundError" } },
      )
    }
    promptAsync(input: any) {
      void this._client
      prompts.push(input)
      // Like the real host: the forked prompt op persists the user message
      // (the plugin's visibility confirmation polls for exactly this).
      const list = world.messages.get(input.path.id) ?? []
      list.push({
        info: {
          id: input.body.messageID,
          role: "user",
          sessionID: input.path.id,
          time: { created: Date.now() },
        },
        parts: input.body.parts ?? [],
      })
      world.messages.set(input.path.id, list)
      return Promise.resolve({})
    }
    create(input: any) {
      void this._client
      creates.push(input)
      const id = `ses_child_${++childCounter}`
      world.sessions.set(id, {
        id,
        ...input.body,
        time: { created: Date.now(), updated: Date.now() },
      })
      return Promise.resolve({ data: world.sessions.get(id) })
    }
    abort(input: any) {
      void this._client
      aborts.push(input.path.id)
      return Promise.resolve({ data: true })
    }
    delete(input: any) {
      void this._client
      deletes.push(input.path.id)
      world.sessions.delete(input.path.id)
      return Promise.resolve({ data: true })
    }
  }
  class Client {
    _client = {}
    app = new App()
    tui = new Tui()
    config = new Config()
    session = new Session()
    global = {
      health: () => Promise.resolve({ data: { healthy: true, version } }),
    }
  }
  return {
    client: new Client(),
    logs,
    toasts,
    prompts,
    creates,
    aborts,
    messageCalls,
    deletes,
    providerCalls,
    providerSignals,
    statusSignals,
  }
}

let active: Hooks | undefined

beforeEach(() => {
  active = undefined
})

afterEach(async () => {
  await active?.dispose?.()
})

async function load(
  client: unknown,
  options?: Record<string, unknown>,
): Promise<Hooks> {
  const hooks = await SubagentCommsPlugin(
    {
      client: client as any,
      directory: DIRECTORY,
      worktree: DIRECTORY,
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

function makeCtx(sessionID = "ses_parent") {
  const controller = new AbortController()
  const asks: any[] = []
  let askError: Error | undefined
  const metadatas: any[] = []
  const ctx = {
    sessionID,
    messageID: "msg_parent_1",
    agent: "build",
    directory: DIRECTORY,
    worktree: DIRECTORY,
    abort: controller.signal,
    metadata: (input: any) => {
      metadatas.push(input)
    },
    ask: (input: any) => {
      asks.push(input)
      return askError ? Promise.reject(askError) : Promise.resolve()
    },
  }
  return {
    ctx,
    asks,
    metadatas,
    controller,
    denyAsks: (error: Error) => (askError = error),
  }
}

type ToolName =
  | "subagent_models"
  | "subagent_spawn"
  | "subagent_send"
  | "subagent_list"
  | "subagent_wait"
  | "subagent_kill"
type ToolResultObject = {
  title?: string
  output: string
  metadata?: Record<string, any>
}

async function call(
  hooks: Hooks,
  name: ToolName,
  ctx: unknown,
  args: Record<string, unknown>,
): Promise<ToolResultObject> {
  const entry = hooks.tool?.[name]
  if (!entry) {
    throw new Error(`tool ${name} is not registered`)
  }
  return (await entry.execute(args as any, ctx as any)) as ToolResultObject
}

async function idleEvent(hooks: Hooks, sessionID: string) {
  await hooks.event?.({
    event: { type: "session.idle", properties: { sessionID } } as any,
  })
}

/**
 * A completed child turn: the injected user message (pass the minted id from
 * the captured prompt when the plugin injected it) plus a finished reply
 * parented to it, the way the host records replies.
 */
function completeChild(
  world: World,
  childID: string,
  replyText: string,
  messageID = "msg_w_user",
  replyID?: string,
) {
  const list = world.messages.get(childID) ?? []
  // The mock promptAsync already persisted plugin-injected user messages.
  if (!list.some((message) => message.info.id === messageID))
    list.push({
      info: {
        id: messageID,
        role: "user",
        sessionID: childID,
        time: { created: 1 },
      },
      parts: [{ type: "text", text: "the prompt" }],
    })
  list.push({
    info: {
      id: replyID ?? `${messageID}_reply`,
      role: "assistant",
      parentID: messageID,
      sessionID: childID,
      time: { created: 2, completed: 3 },
    },
    parts: [{ type: "text", text: replyText }],
  })
  world.messages.set(childID, list)
  delete world.status[childID]
}

/**
 * Like completeChild, but the appended assistant carries an `info.error`
 * (extractChildOutcome reads info.error.data.message, which beats text and the
 * completed check). The only way to drive an errored ChildOutcome through the
 * plugin — the plain completeChild never sets info.error.
 */
function completeChildWithError(
  world: World,
  childID: string,
  errorMessage: string,
  messageID = "msg_w_user",
) {
  const list = world.messages.get(childID) ?? []
  if (!list.some((message) => message.info.id === messageID))
    list.push({
      info: {
        id: messageID,
        role: "user",
        sessionID: childID,
        time: { created: 1 },
      },
      parts: [{ type: "text", text: "the prompt" }],
    })
  list.push({
    info: {
      id: `${messageID}_reply`,
      role: "assistant",
      parentID: messageID,
      sessionID: childID,
      error: { data: { message: errorMessage } },
      time: { created: 2, completed: 3 },
    },
    parts: [],
  })
  world.messages.set(childID, list)
  delete world.status[childID]
}

async function until(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await Bun.sleep(20)
  }
}

/** A host-minted-style id (48-bit ms stamp + counter), for fixtures that must order against plugin-minted ids. */
function hostMessageID(ts: number, counter: number): string {
  const stamp = ((BigInt(ts) << 12n) | BigInt(counter)) & 0xffffffffffffn
  return `msg_${stamp.toString(16).padStart(12, "0")}00000000000000`
}

/** The 12-bit per-millisecond counter packed into a message id's stamp (low bits). */
function counterOf(id: string): number {
  return Number(BigInt(`0x${id.slice(4, 16)}`) & 0xfffn)
}

function appendNewerUserMessages(world: World, childID: string, count: number) {
  const messages = world.messages.get(childID) ?? []
  const startedAt = Date.now() + 1
  for (let index = 0; index < count; index++) {
    messages.push({
      info: {
        id: hostMessageID(startedAt + index, 0),
        role: "user",
        sessionID: childID,
        time: { created: startedAt + index },
      },
      parts: [],
    })
  }
  world.messages.set(childID, messages)
}

function appendAssistantSteps(
  world: World,
  childID: string,
  parentID: string,
  count = 50,
) {
  const messages = world.messages.get(childID) ?? []
  const startedAt = Date.now() + 1
  for (let index = 0; index < count; index++) {
    messages.push({
      info: {
        id: hostMessageID(startedAt + index, 0),
        role: "assistant",
        parentID,
        sessionID: childID,
        time: { created: startedAt + index, completed: startedAt + index },
      },
      parts: [],
    })
  }
  world.messages.set(childID, messages)
}

describe("OpenCode runtime compatibility guard", () => {
  // A v1 host outside the verified band warns but still registers its tools.
  test("warns but runs on an untested v1 host", async () => {
    const world = makeWorld()
    const { client, logs } = makeClient(world, BAND.belowBand)
    const hooks = await load(client)
    expect(hooks.tool).toBeDefined()
    expect(logs[0].body.level).toBe("warn")
    expect(logs[0].body.message).toContain(`found ${BAND.belowBand}`)
    expect(logs[0].body.message).toContain("Running anyway")
  })

  // A non-v1 host (OpenCode v2+, whose plugin API differs) disables the plugin
  // — but visibly, via the deferred first-prompt toast.
  test("stays inert on OpenCode v2 — but visibly", async () => {
    const world = makeWorld()
    const { client, logs } = makeClient(world, "2.0.0")
    const hooks = await load(client)
    expect(hooks.tool).toBeUndefined()
    expect(logs[0].body.level).toBe("warn")
    expect(logs[0].body.message).toContain("OpenCode 2.0.0")
    expect(logs[0].body.message).toContain("disabled")
  })
})

describe("subagent_models", () => {
  test("lists a freshly-read allowlisted catalog without provider secrets", async () => {
    const world = makeWorld()
    const { client, providerCalls } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()

    const result = await call(hooks, "subagent_models", ctx, {})

    expect(providerCalls[0]).toMatchObject({
      query: { directory: DIRECTORY },
    })
    expect(providerCalls[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(result.output).toContain("e2e/test")
    expect(result.output).toContain("E2E provider / E2E test")
    expect(result.output).toContain("[provider default]")
    expect(result.output).toContain("e2e/alternate")
    expect(result.output).toContain("high")
    expect(result.output).toContain("openrouter/anthropic/claude-sonnet")
    for (const secret of [
      "PROVIDER_KEY_SECRET",
      "PROVIDER_OPTIONS_SECRET",
      "MODEL_OPTIONS_SECRET",
      "MODEL_HEADERS_SECRET",
      "VARIANT_SECRET",
    ])
      expect(JSON.stringify(result)).not.toContain(secret)

    world.providers = { providers: [], default: {} }
    expect((await call(hooks, "subagent_models", ctx, {})).output).toContain(
      "No models are currently listed",
    )
    expect(providerCalls).toHaveLength(2)
  })

  test("fails safely when the provider catalog cannot be read", async () => {
    for (const failure of ["error", "throw"] as const) {
      const world = makeWorld()
      world.providerFailure = failure
      const { client } = makeClient(world)
      const hooks = await load(client)
      await expect(
        call(hooks, "subagent_models", makeCtx().ctx, {}),
      ).rejects.toThrow(/Could not read the current provider model catalog/)
    }
  })

  test("bounds a provider catalog read and aborts its transport", async () => {
    const world = makeWorld()
    world.providerHangs = true
    const { client, providerSignals } = makeClient(world)
    const hooks = await load(client)

    const error = await call(hooks, "subagent_models", makeCtx().ctx, {}).catch(
      (thrown: Error) => thrown,
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(
      /Could not read the current provider model catalog/,
    )
    expect(providerSignals[0]?.aborted).toBe(true)
  }, 15_000)
})

describe("subagent_spawn", () => {
  test("asks under the task permission, creates a locked-down child, prompts it, and registers the completion note", async () => {
    const world = makeWorld()
    const { client, prompts, creates } = makeClient(world)
    const hooks = await load(client)
    const { ctx, asks, metadatas } = makeCtx()

    const result = await call(hooks, "subagent_spawn", ctx, {
      description: "audit configs",
      prompt: "Audit every config file.",
      subagent_type: "general",
    })

    expect(asks[0]).toMatchObject({
      permission: "task",
      patterns: ["general"],
      always: ["*"],
      metadata: {
        description: "audit configs",
        subagent_type: "general",
        background: true,
      },
    })
    expect(creates[0].body).toMatchObject({
      parentID: "ses_parent",
      title: "audit configs (@general subagent)",
      agent: "general",
    })
    const denied = (
      creates[0].body.permission as Array<{
        permission: string
        action: string
      }>
    ).map((rule) => rule.permission)
    expect(denied).toEqual(["todowrite", "task", ...SUBAGENT_TOOL_IDS])
    // The general agent has no model of its own → inherits the parent's, with variant.
    expect(prompts[0]).toMatchObject({
      path: { id: "ses_child_1" },
      body: {
        agent: "general",
        model: { providerID: "anthropic", modelID: "claude-x" },
        variant: "max",
        parts: [{ type: "text", text: "Audit every config file." }],
      },
    })
    expect(prompts[0].body.parts[0].synthetic).toBeUndefined()
    // The injected message's id is minted in the host's own format, so the
    // reply can be correlated to it via the assistant's parentID.
    expect(prompts[0].body.messageID).toMatch(
      /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    )
    expect(metadatas[0]).toMatchObject({
      title: "audit configs",
      metadata: { sessionId: "ses_child_1", background: true },
    })
    expect(result.output).toContain('<task id="ses_child_1" state="running">')
    expect(result.output).toContain("subagent_send")
    expect(result.metadata).toMatchObject({
      sessionId: "ses_child_1",
      parentSessionId: "ses_parent",
    })
  })

  test("an agent with its own model does not inherit the parent's variant", async () => {
    const world = makeWorld()
    const { client, prompts } = makeClient(world)
    const hooks = await load(client)
    const { ctx, metadatas } = makeCtx()
    const result = await call(hooks, "subagent_spawn", ctx, {
      description: "find loader",
      prompt: "Find it.",
      subagent_type: "explore",
    })
    expect(prompts[0].body.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-mini",
    })
    expect(prompts[0].body.variant).toBeUndefined()
    expect(result.metadata).not.toHaveProperty("variant")
    expect(metadatas[0]?.metadata).not.toHaveProperty("variant")
  })

  test("rejects a malformed explicit model before asking permission", async () => {
    const world = makeWorld()
    const { client, creates, providerCalls } = makeClient(world)
    const hooks = await load(client)
    const { ctx, asks } = makeCtx()

    await expect(
      call(hooks, "subagent_spawn", ctx, {
        description: "bad model ref",
        prompt: "Do nothing.",
        subagent_type: "general",
        model: "missing-slash",
      }),
    ).rejects.toThrow(/provider\/model/)
    expect(asks).toHaveLength(0)
    expect(providerCalls).toHaveLength(0)
    expect(creates).toHaveLength(0)
  })

  test("uses an explicit catalog-validated model at default effort without reading the parent model", async () => {
    const world = makeWorld()
    const { client, prompts, providerCalls } = makeClient(world)
    ;(client.session as any).message = () =>
      Promise.resolve({ error: { name: "boom" } })
    const hooks = await load(client)
    const { ctx, asks } = makeCtx()

    const result = await call(hooks, "subagent_spawn", ctx, {
      description: "use alternate model",
      prompt: "Do the alternate task.",
      subagent_type: "general",
      model: "e2e/alternate",
    })

    expect(asks[0]?.metadata).toMatchObject({ model: "e2e/alternate" })
    expect(providerCalls).toHaveLength(1)
    expect(prompts[0]?.body).toMatchObject({
      model: { providerID: "e2e", modelID: "alternate" },
      variant: "default",
    })
    expect(result.metadata).toMatchObject({
      model: { providerID: "e2e", modelID: "alternate" },
      variant: "default",
    })
  })

  test("validates explicit and variant-only model selections before creating a child", async () => {
    const world = makeWorld()
    world.providers = {
      providers: [
        ...(world.providers as { providers: unknown[] }).providers,
        {
          id: "anthropic",
          models: { "claude-x": { id: "claude-x", variants: { high: {} } } },
        },
      ],
      default: {},
    }
    const { client, creates, prompts } = makeClient(world)
    const hooks = await load(client)
    const { ctx, asks } = makeCtx()

    const explicit = await call(hooks, "subagent_spawn", ctx, {
      description: "use high effort",
      prompt: "Do the high effort task.",
      subagent_type: "general",
      model: "e2e/alternate",
      variant: "high",
    })
    expect(asks[0]?.metadata).toMatchObject({
      model: "e2e/alternate",
      variant: "high",
    })
    expect(prompts[0]?.body).toMatchObject({
      model: { providerID: "e2e", modelID: "alternate" },
      variant: "high",
    })
    expect(explicit.metadata).toMatchObject({ variant: "high" })

    const variantOnly = await call(hooks, "subagent_spawn", ctx, {
      description: "override parent effort",
      prompt: "Do the parent task.",
      subagent_type: "general",
      variant: "high",
    })
    expect(asks[1]?.metadata).toMatchObject({ variant: "high" })
    expect(asks[1]?.metadata.model).toBeUndefined()
    expect(prompts[1]?.body).toMatchObject({
      model: { providerID: "anthropic", modelID: "claude-x" },
      variant: "high",
    })
    expect(variantOnly.metadata).toMatchObject({ variant: "high" })

    await call(hooks, "subagent_spawn", ctx, {
      description: "nested slash model",
      prompt: "Do the nested task.",
      subagent_type: "general",
      model: "openrouter/anthropic/claude-sonnet",
      variant: "high",
    })
    expect(prompts[2]?.body.model).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet",
    })

    const childCount = creates.length
    await expect(
      call(hooks, "subagent_spawn", ctx, {
        description: "missing model",
        prompt: "Do nothing.",
        subagent_type: "general",
        model: "e2e/missing",
      }),
    ).rejects.toThrow(/not listed in the current provider catalog/)
    await expect(
      call(hooks, "subagent_spawn", ctx, {
        description: "missing variant",
        prompt: "Do nothing.",
        subagent_type: "general",
        model: "e2e/alternate",
        variant: "missing",
      }),
    ).rejects.toThrow(/Supported variants: high/)
    expect(creates).toHaveLength(childCount)
  })

  test("catalog failures reject overrides before creating a child", async () => {
    const world = makeWorld()
    world.providerFailure = "error"
    const { client, creates } = makeClient(world)
    const hooks = await load(client)

    await expect(
      call(hooks, "subagent_spawn", makeCtx().ctx, {
        description: "catalog failure",
        prompt: "Do nothing.",
        subagent_type: "general",
        model: "e2e/alternate",
      }),
    ).rejects.toThrow(/Could not read the current provider model catalog/)
    expect(creates).toHaveLength(0)
  })

  test("catalog validation does not reserve a busy-child slot and dispose cancels it", async () => {
    const world = makeWorld()
    world.providerHangs = true
    const { client, creates, providerSignals } = makeClient(world)
    const hooks = await load(client, { maxBusyChildren: 1 })

    const override = call(hooks, "subagent_spawn", makeCtx().ctx, {
      description: "waiting override",
      prompt: "Wait for the catalog.",
      subagent_type: "general",
      model: "e2e/alternate",
    }).catch((error: Error) => error)
    await until(() => providerSignals.length === 1)

    const ordinary = await call(hooks, "subagent_spawn", makeCtx().ctx, {
      description: "ordinary spawn",
      prompt: "Proceed without an override.",
      subagent_type: "general",
    })
    expect(ordinary.metadata?.sessionId).toBe("ses_child_1")
    expect(creates).toHaveLength(1)

    const startedAt = Date.now()
    await hooks.dispose?.()
    active = undefined
    expect(await override).toBeInstanceOf(Error)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(providerSignals[0]?.aborted).toBe(true)
  })

  test("a denied ask reads as no-nesting inside a subagent session", async () => {
    const world = makeWorld()
    // Past the depth boundary (which would fire first, like stock task): the
    // permission denial itself is what these cases exercise.
    world.config = { subagent_depth: 2 }
    world.sessions.set("ses_sub", {
      id: "ses_sub",
      parentID: "ses_parent",
      agent: "general",
    })
    const { client } = makeClient(world)
    const hooks = await load(client)
    const inChild = makeCtx("ses_sub")
    inChild.denyAsks(new Error("denied"))
    expect(
      call(hooks, "subagent_spawn", inChild.ctx, {
        description: "x y z",
        prompt: "p",
        subagent_type: "general",
      }),
    ).rejects.toThrow(/may not spawn subagents/)
    const inParent = makeCtx()
    inParent.denyAsks(new Error("denied"))
    expect(
      call(hooks, "subagent_spawn", inParent.ctx, {
        description: "x y z",
        prompt: "p",
        subagent_type: "general",
      }),
    ).rejects.toThrow(/not permitted/)
  })

  test("a nested spawn stops at the stock subagent_depth boundary; a raised limit allows it", async () => {
    const world = makeWorld()
    world.sessions.set("ses_sub", {
      id: "ses_sub",
      parentID: "ses_parent",
      agent: "general",
    })
    // The child session's own current message, for model inheritance once the
    // raised limit lets the spawn proceed.
    world.messages.set("ses_sub", [
      {
        info: {
          id: "msg_parent_1",
          role: "assistant",
          sessionID: "ses_sub",
          providerID: "anthropic",
          modelID: "claude-x",
          time: { created: 1, completed: 2 },
        },
        parts: [],
      },
    ])
    const { client, creates } = makeClient(world)
    const hooks = await load(client)
    const inChild = makeCtx("ses_sub")
    // Default limit 1: a session at depth 1 may not spawn, before any ask.
    expect(
      call(hooks, "subagent_spawn", inChild.ctx, {
        description: "x y z",
        prompt: "p",
        subagent_type: "general",
      }),
    ).rejects.toThrow(/Subagent depth limit reached \(1\)/)
    expect(creates).toHaveLength(0)
    // The same spawn passes once the user raises subagent_depth, like stock.
    world.config = { subagent_depth: 2 }
    const result = await call(hooks, "subagent_spawn", inChild.ctx, {
      description: "x y z",
      prompt: "p",
      subagent_type: "general",
    })
    expect(result.metadata).toMatchObject({ parentSessionId: "ses_sub" })
    expect(creates).toHaveLength(1)
  })

  test("fails closed when the parent's current model can't be read for inheritance", async () => {
    const world = makeWorld()
    const { client, creates } = makeClient(world)
    ;(client.session as any).message = () =>
      Promise.resolve({ error: { name: "boom" } })
    const hooks = await load(client)
    const { ctx } = makeCtx()
    // "general" has no model of its own: inheritance is required, and its
    // source being unreadable must fail the spawn (stock task dies here), not
    // silently fall back to the host's default model.
    expect(
      call(hooks, "subagent_spawn", ctx, {
        description: "x y z",
        prompt: "p",
        subagent_type: "general",
      }),
    ).rejects.toThrow(/Could not read the current model/)
    expect(creates).toHaveLength(0)
    // "explore" carries its own model, so the broken message route is moot.
    const result = await call(hooks, "subagent_spawn", ctx, {
      description: "find loader",
      prompt: "p",
      subagent_type: "explore",
    })
    expect(result.metadata).toMatchObject({
      model: { providerID: "anthropic", modelID: "claude-mini" },
    })
  })

  test("unknown agent types list the visible non-primary agents", async () => {
    const world = makeWorld()
    const { client } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const rejection = call(hooks, "subagent_spawn", ctx, {
      description: "x y z",
      prompt: "p",
      subagent_type: "nope",
    })
    expect(rejection).rejects.toThrow(/general, explore/)
    expect(rejection).rejects.not.toThrow(/secret|build/)
  })

  test("refuses past the busy-children cap with guidance", async () => {
    const world = makeWorld()
    world.sessions.set("ses_busy", { id: "ses_busy", parentID: "ses_parent" })
    world.status.ses_busy = { type: "busy" }
    const { client } = makeClient(world)
    const hooks = await load(client, { maxBusyChildren: 1 })
    const { ctx } = makeCtx()
    expect(
      call(hooks, "subagent_spawn", ctx, {
        description: "x y z",
        prompt: "p",
        subagent_type: "general",
      }),
    ).rejects.toThrow(/already has 1 subagents working/)
  })

  test("a status read that never answers fails the spawn instead of parking it forever", async () => {
    const world = makeWorld()
    world.statusHangs = true
    const { client, statusSignals } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()

    // The busy-children cap reads the status map with no timeout of its own,
    // so before this read was bounded a wedged host held the tool call — and
    // the settle engine's poll tick — open indefinitely. The deadline
    // degrades exactly like the API error the cap already handles.
    //
    // This test really does wait out SESSION_STATUS_PROBE_TIMEOUT_MS: the
    // deadline is the suite's one answer for this route rather than a plugin
    // option, so there is nothing to shorten, and a silent hang is what it
    // exists to prevent.
    const error = await call(hooks, "subagent_spawn", ctx, {
      description: "x y z",
      prompt: "p",
      subagent_type: "general",
    }).catch((thrown: Error) => thrown)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/did not answer/)
    // Aborted, not merely abandoned: the request must not still be in flight.
    expect(statusSignals[0]?.aborted).toBe(true)
  }, 15_000)

  test("dispose cancels a status read already awaiting the host", async () => {
    const world = makeWorld()
    world.statusHangs = true
    const { client, statusSignals } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()

    const spawn = call(hooks, "subagent_spawn", ctx, {
      description: "x y z",
      prompt: "p",
      subagent_type: "general",
    }).catch((error: Error) => error)
    await until(() => statusSignals.length === 1)
    const startedAt = Date.now()
    await hooks.dispose?.()
    active = undefined

    // Released by the abort, not by waiting out the 10 s deadline.
    expect(await spawn).toBeInstanceOf(Error)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(statusSignals[0]?.aborted).toBe(true)
  })

  test("parallel spawns cannot both slip past the cap on the same status snapshot", async () => {
    const world = makeWorld()
    const { client, creates } = makeClient(world)
    const hooks = await load(client, { maxBusyChildren: 1 })
    const { ctx } = makeCtx()
    // Both fire against an empty snapshot; the reservation lets exactly one win.
    const results = await Promise.allSettled([
      call(hooks, "subagent_spawn", ctx, {
        description: "one",
        prompt: "p",
        subagent_type: "general",
      }),
      call(hooks, "subagent_spawn", ctx, {
        description: "two",
        prompt: "p",
        subagent_type: "general",
      }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    )
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason.message).toMatch(
      /already has 1 subagents working/,
    )
    expect(creates).toHaveLength(1)
  })

  test("mirrors experimental.primary_tools into the child's denied ruleset", async () => {
    const world = makeWorld()
    world.config = { experimental: { primary_tools: ["bash", "write"] } }
    const { client, creates } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()
    await call(hooks, "subagent_spawn", ctx, {
      description: "audit configs",
      prompt: "Audit.",
      subagent_type: "general",
    })
    const denied = (
      creates[0].body.permission as Array<{ permission: string }>
    ).map((rule) => rule.permission)
    expect(denied).toEqual([
      "todowrite",
      "task",
      ...SUBAGENT_TOOL_IDS,
      "bash",
      "write",
    ])
  })

  test("fails closed if the parent's permissions can't be read", async () => {
    const world = makeWorld()
    const { client } = makeClient(world)
    // The lockdown re-read of the parent session fails; the spawn must not
    // proceed with an empty (escalated) ruleset.
    ;(client.session as any).get = (input: any) =>
      input.path.id === "ses_parent"
        ? Promise.resolve({ error: { name: "boom" } })
        : Promise.resolve({ data: world.sessions.get(input.path.id) })
    const hooks = await load(client)
    const { ctx } = makeCtx()
    expect(
      call(hooks, "subagent_spawn", ctx, {
        description: "x y z",
        prompt: "p",
        subagent_type: "general",
      }),
    ).rejects.toThrow(/lock down the subagent/)
  })

  test("fails closed if the primary-tools config can't be read", async () => {
    const world = makeWorld()
    const { client, creates } = makeClient(world)
    ;(client.config as any).get = () =>
      Promise.resolve({ error: { name: "boom" } })
    const hooks = await load(client)
    const { ctx } = makeCtx()
    expect(
      call(hooks, "subagent_spawn", ctx, {
        description: "x y z",
        prompt: "p",
        subagent_type: "general",
      }),
    ).rejects.toThrow(/lock down the subagent/)
    expect(creates).toHaveLength(0)
  })

  test("a child whose first prompt fails is deleted, not leaked", async () => {
    const world = makeWorld()
    const { client, deletes } = makeClient(world)
    ;(client.session as any).promptAsync = () =>
      Promise.resolve({ error: { name: "boom" } })
    const hooks = await load(client)
    const { ctx } = makeCtx()
    expect(
      call(hooks, "subagent_spawn", ctx, {
        description: "x y z",
        prompt: "p",
        subagent_type: "general",
      }),
    ).rejects.toThrow()
    await until(() => deletes.length === 1)
    expect(deletes[0]).toBe("ses_child_1")
  })

  test("a child is retained when its first prompt persisted before the response was lost", async () => {
    const world = makeWorld()
    const { client, prompts, deletes } = makeClient(world)
    const persist = (client.session as any).promptAsync.bind(client.session)
    ;(client.session as any).promptAsync = async (input: any) => {
      await persist(input)
      throw new Error("socket closed")
    }
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    const spawned = await call(hooks, "subagent_spawn", ctx, {
      description: "x y z",
      prompt: "p",
      subagent_type: "general",
    })

    expect(spawned.metadata).toMatchObject({
      sessionId: "ses_child_1",
      promptOutcome: "confirmed",
    })
    expect(prompts[0].body.messageID).toMatch(
      /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    )
    expect(deletes).toHaveLength(0)

    completeChild(world, "ses_child_1", "finished", prompts[0].body.messageID)
    await idleEvent(hooks, "ses_child_1")
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)
  })

  test("WP5: a current message that reads fine but carries no model fails the spawn, no child created", async () => {
    const world = makeWorld()
    const { client, creates } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()
    // The message route succeeds, but its info omits providerID/modelID. A
    // modelless subagent ("general") REQUIRES inheritance, so this must fail
    // closed rather than silently omit the pin and let the host pick a default.
    world.messages.set("ses_parent", [
      {
        info: {
          id: "msg_parent_1",
          role: "assistant",
          sessionID: "ses_parent",
          time: { created: 1, completed: 2 },
        },
        parts: [],
      },
    ])
    const rejection = call(hooks, "subagent_spawn", ctx, {
      description: "x y z",
      prompt: "p",
      subagent_type: "general",
    })
    await expect(rejection).rejects.toThrow(/Could not read the current model/)
    await expect(rejection).rejects.toThrow(/carries no model/)
    expect(creates).toHaveLength(0)
  })
})

describe("subagent_send", () => {
  function withChild(world: World) {
    world.sessions.set("ses_child", {
      id: "ses_child",
      parentID: "ses_parent",
      title: "audit configs (@general subagent)",
      agent: "general",
      model: { providerID: "anthropic", id: "claude-x", variant: "default" },
    })
    world.messages.set("ses_child", [
      {
        info: {
          id: "msg_c_0",
          role: "assistant",
          sessionID: "ses_child",
          time: { created: 1, completed: 2 },
        },
        parts: [{ type: "text", text: "earlier reply" }],
      },
    ])
  }

  test("rejects targets that are not direct children, with one shared message", async () => {
    const world = makeWorld()
    world.sessions.set("ses_other", {
      id: "ses_other",
      parentID: "ses_elsewhere",
    })
    const { client } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()
    for (const target of ["ses_other", "ses_missing"]) {
      expect(
        call(hooks, "subagent_send", ctx, {
          session_id: target,
          message: "hi",
        }),
      ).rejects.toThrow(/not one of this session's subagents/)
    }
  })

  test("asks under the task permission like a stock task_id resume; a denial blocks the send", async () => {
    const world = makeWorld()
    withChild(world)
    const { client, prompts } = makeClient(world)
    const hooks = await load(client)
    const allowed = makeCtx()
    await call(hooks, "subagent_send", allowed.ctx, {
      session_id: "ses_child",
      message: "hi",
      wait: false,
    })
    // The pattern is the child's agent type — what a stock resume would assert
    // — so plan mode's per-agent task denies govern the send too.
    expect(allowed.asks[0]).toMatchObject({
      permission: "task",
      patterns: ["general"],
      always: ["*"],
    })

    const denied = makeCtx()
    denied.denyAsks(new Error("denied"))
    const before = prompts.length
    expect(
      call(hooks, "subagent_send", denied.ctx, {
        session_id: "ses_child",
        message: "hi",
      }),
    ).rejects.toThrow(/not permitted/)
    await Bun.sleep(10)
    expect(prompts).toHaveLength(before) // nothing was injected into the child
  })

  test("wait:true echoes the child's pinned identity, anchors past old replies, and returns the new one", async () => {
    const world = makeWorld()
    withChild(world)
    const { client, prompts } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()

    const pending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "and the tests?",
    })
    await until(() => prompts.length === 1)
    // agent echoed; "default" variant dropped rather than re-pinned.
    expect(prompts[0]).toMatchObject({
      path: { id: "ses_child" },
      body: {
        agent: "general",
        model: { providerID: "anthropic", modelID: "claude-x" },
        parts: [{ type: "text", text: "and the tests?" }],
      },
    })
    expect(prompts[0].body.variant).toBeUndefined()

    completeChild(world, "ses_child", "tests pass", prompts[0].body.messageID)
    await idleEvent(hooks, "ses_child")
    const result = await pending
    expect(result.output).toContain("replied after")
    expect(result.output).toContain('<task id="ses_child" state="completed">')
    expect(result.output).toContain("tests pass")
    expect(result.output).not.toContain("earlier reply")
    expect(result.metadata).toMatchObject({
      sessionId: "ses_child",
      outcome: "replied",
      wasBusy: false,
    })
  })

  test("wait:true reports a run that ended without a reply after the grace, not the stale reply", async () => {
    const world = makeWorld()
    withChild(world)
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    const pending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "hello?",
    })
    await until(() => prompts.length === 1)
    // The injected user message landed (the mock persists it); the run dies
    // without ever producing a reply.
    await idleEvent(hooks, "ses_child")
    await Bun.sleep(GRACE_SPACING_MS + 100)
    await idleEvent(hooks, "ses_child")
    const result = await pending
    expect(result.output).toContain("without a new reply")
    expect(result.metadata?.outcome).toBe("ended")
  })

  test("wait:true timeout keeps the reply collectable via the completion note", async () => {
    const world = makeWorld()
    withChild(world)
    world.status.ses_child = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const result = await call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "hi",
      timeout_ms: 1_000,
    })
    expect(result.output).toContain("Timed out after 1000 ms")
    expect(result.metadata?.outcome).toBe("timeout")
    // The reply now arrives as a note into the (idle) parent.
    completeChild(world, "ses_child", "late reply", prompts[0].body.messageID)
    await idleEvent(hooks, "ses_child")
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    const note = prompts.find((prompt) => prompt.path.id === "ses_parent")
    expect(note.body.parts[0].text).toContain("late reply")
    expect(note.body.parts[0].synthetic).toBe(true)
    expect(note.body.noReply).toBeUndefined()
    // The parent's own pinned identity is echoed, not reset.
    expect(note.body).toMatchObject({
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-x" },
      variant: "max",
    })
  })

  test("wait:false notes even a busy parent with a plain prompt, and flags the steer wording on a busy child", async () => {
    const world = makeWorld()
    withChild(world)
    world.status.ses_child = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const result = await call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "also check CI",
      wait: false,
    })
    expect(result.output).toContain(
      "merged into that run as additional context",
    )
    expect(result.metadata).toMatchObject({
      outcome: "delivered",
      wasBusy: true,
    })

    world.status.ses_parent = { type: "busy" }
    completeChild(world, "ses_child", "done both", prompts[0].body.messageID)
    await idleEvent(hooks, "ses_child")
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    const note = prompts.find((prompt) => prompt.path.id === "ses_parent")
    // A PLAIN prompt regardless of the parent's busy state: the host's runner
    // merges it into a run in flight and starts one on an idle parent
    // atomically. A noReply note here would race the parent going idle between
    // the busy check and the injection, recording a note that never starts a
    // turn and sits unread until some later request.
    expect(note.body.noReply).toBeUndefined()
    expect(note.body.parts[0].text).toContain("done both")
    // The busy-steer high counter must NOT leak into the parent note: a note
    // that sorted above the parent's terminal assistant could hijack a
    // finishing run into answering it mid-flight.
    expect(counterOf(note.body.messageID)).toBe(0)
  })

  test("a previous run's reply landing mid-send is never returned as the send's reply", async () => {
    const world = makeWorld()
    withChild(world)
    world.status.ses_child = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    const pending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "new question",
    })
    await until(() => prompts.length === 1)
    const minted = prompts[0].body.messageID
    // The run already in flight finishes first: its reply is newer than any
    // pre-send anchor, but parented to an OLDER user message than ours.
    const oldParent = hostMessageID(Date.now() - 60_000, 5)
    expect(oldParent < minted).toBe(true)
    world.messages.get("ses_child")?.push({
      info: {
        id: "msg_zz_previous",
        role: "assistant",
        parentID: oldParent,
        sessionID: "ses_child",
        time: { created: 4, completed: 5 },
      },
      parts: [{ type: "text", text: "previous answer" }],
    })
    delete world.status.ses_child
    await idleEvent(hooks, "ses_child")
    await Bun.sleep(50) // anchor-based extraction would have resolved here
    // Then the child picks the injected message up and answers it.
    completeChild(world, "ses_child", "actual answer", minted, "msg_zz_reply")
    await idleEvent(hooks, "ses_child")
    const result = await pending
    expect(result.metadata?.outcome).toBe("replied")
    expect(result.output).toContain("actual answer")
    expect(result.output).not.toContain("previous answer")
  })

  test("a blocking send owns the completion: the spawn's pending note does not double-deliver", async () => {
    const world = makeWorld()
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_spawn", ctx, {
      description: "audit configs",
      prompt: "Audit.",
      subagent_type: "general",
    })
    world.status.ses_child_1 = { type: "busy" }
    await Bun.sleep(5) // the send's minted id lands in a later millisecond than the spawn's
    const pending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child_1",
      message: "status?",
    })
    await until(() => prompts.length === 2)
    completeChild(
      world,
      "ses_child_1",
      "all audited",
      prompts[1].body.messageID,
    )
    await idleEvent(hooks, "ses_child_1")
    const result = await pending
    expect(result.output).toContain("all audited")
    // The tool result was the delivery; the spawn's note must not fire too.
    await Bun.sleep(100)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(0)
  })

  test("aborting the parent turn rejects the wait but leaves the child alone", async () => {
    const world = makeWorld()
    withChild(world)
    world.status.ses_child = { type: "busy" }
    const { client, prompts, aborts } = makeClient(world)
    const hooks = await load(client)
    const { ctx, controller } = makeCtx()
    const pending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "hi",
    })
    await until(() => prompts.length === 1)
    controller.abort()
    expect(pending).rejects.toThrow(SEND_ABORTED_MESSAGE)
    await Bun.sleep(20)
    expect(aborts).toHaveLength(0)
  })

  test("a child deleted mid-wait surfaces as an error", async () => {
    const world = makeWorld()
    withChild(world)
    world.status.ses_child = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const pending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "hi",
    })
    await until(() => prompts.length === 1)
    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses_child" } },
      } as any,
    })
    expect(pending).rejects.toThrow(/deleted while waiting/)
  })

  test("steering a busy child mints the message above same-ms host ids; idle sends and spawns stay below", async () => {
    const world = makeWorld()
    withChild(world)
    world.status.ses_child = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()

    // Busy steer: high counter, so the in-flight run cannot read it as answered.
    const pending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "steer",
    })
    await until(() => prompts.length === 1)
    expect(counterOf(prompts[0].body.messageID)).toBe(0xfff)
    completeChild(world, "ses_child", "steered ok", prompts[0].body.messageID)
    await idleEvent(hooks, "ses_child")
    expect((await pending).metadata?.outcome).toBe("replied")

    // Idle send to the same (now idle) child: default counter 0.
    const idleSend = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "again",
      wait: false,
    })
    await until(() => prompts.length === 2)
    expect(counterOf(prompts[1].body.messageID)).toBe(0)
    await idleSend

    // A spawn's first prompt is an idle injection too: counter 0.
    await call(hooks, "subagent_spawn", ctx, {
      description: "audit",
      prompt: "go",
      subagent_type: "general",
    })
    const spawnPrompt = prompts.find((p) => p.path.id === "ses_child_1")
    expect(counterOf(spawnPrompt.body.messageID)).toBe(0)
  })

  test("a transient error while settling is not mistaken for deletion; the wait recovers", async () => {
    const world = makeWorld()
    withChild(world)
    world.status.ses_child = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const origMessages = (client.session as any).messages.bind(client.session)
    const origGet = (client.session as any).get.bind(client.session)
    const hooks = await load(client, { pollIntervalMs: 100 })
    const { ctx } = makeCtx()
    const pending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "q",
    })
    await until(() => prompts.length === 1)
    const minted = prompts[0].body.messageID

    // Both endpoints fail transiently (non-404) exactly as the child goes idle.
    ;(client.session as any).messages = () =>
      Promise.resolve({ error: { name: "InternalError" } })
    ;(client.session as any).get = () =>
      Promise.resolve({ error: { name: "InternalError" } })
    delete world.status.ses_child
    await idleEvent(hooks, "ses_child")
    await Bun.sleep(60)
    // A blip must NOT settle the wait as deleted (which would reject).
    let rejected = false
    void pending.catch(() => (rejected = true))
    await Bun.sleep(20)
    expect(rejected).toBe(false)

    // Endpoints recover and the real reply lands: the wait completes normally.
    ;(client.session as any).messages = origMessages
    ;(client.session as any).get = origGet
    completeChild(world, "ses_child", "recovered reply", minted)
    const result = await pending
    expect(result.metadata?.outcome).toBe("replied")
    expect(result.output).toContain("recovered reply")
  })

  test("a genuine not-found while settling does surface as deletion", async () => {
    const world = makeWorld()
    withChild(world)
    world.status.ses_child = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 100 })
    const { ctx } = makeCtx()
    const pending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "q",
    })
    await until(() => prompts.length === 1)
    // messages fails and the probe reports the in-process 404 shape (no response).
    ;(client.session as any).messages = () =>
      Promise.resolve({ error: { name: "boom" } })
    ;(client.session as any).get = () =>
      Promise.resolve({ error: { name: "NotFoundError" } })
    delete world.status.ses_child
    await idleEvent(hooks, "ses_child")
    await expect(pending).rejects.toThrow(/deleted while waiting/)
  })

  test("a transport failure during the deletion probe is treated as unknown, not deletion", async () => {
    const world = makeWorld()
    withChild(world)
    world.status.ses_child = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const origMessages = (client.session as any).messages.bind(client.session)
    const origGet = (client.session as any).get.bind(client.session)
    const hooks = await load(client, { pollIntervalMs: 100 })
    const { ctx } = makeCtx()
    const pending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "q",
    })
    await until(() => prompts.length === 1)
    const minted = prompts[0].body.messageID
    // messages fails and the probe REJECTS (connection refused / in-process throw).
    ;(client.session as any).messages = () =>
      Promise.resolve({ error: { name: "boom" } })
    ;(client.session as any).get = () =>
      Promise.reject(new Error("ECONNREFUSED"))
    delete world.status.ses_child
    await idleEvent(hooks, "ses_child")
    await Bun.sleep(60)
    let rejected = false
    void pending.catch(() => (rejected = true))
    await Bun.sleep(20)
    expect(rejected).toBe(false)
    ;(client.session as any).messages = origMessages
    ;(client.session as any).get = origGet
    completeChild(world, "ses_child", "still here", minted)
    expect((await pending).output).toContain("still here")
  })

  // The confirmation window bounds how long we WAIT, not whether the host took
  // the prompt. A 204 means it forked the prompt operation, so an unconfirmed
  // message is ambiguous — it may have landed and be driving a run right now.
  // Deleting the child on that evidence does not undo the run: on 1.18.3
  // Session.remove never touches SessionRunState, so the model and tool calls
  // continue against a session whose row and messages are gone, with nothing
  // tracking them and no completion notification owed to anyone.
  test("an accepted prompt whose message never becomes visible keeps the child rather than deleting it", async () => {
    const world = makeWorld()
    withChild(world)
    const { client, prompts, deletes } = makeClient(world)
    // 204 accepted, but nothing ever becomes visible — indistinguishable, from
    // here, from a host slower than the confirmation window or a run of failed
    // message reads.
    ;(client.session as any).promptAsync = (input: any) => {
      prompts.push(input)
      return Promise.resolve({})
    }
    const hooks = await load(client, { injectConfirmTimeoutMs: 300 })
    const { ctx } = makeCtx()
    const spawned = await call(hooks, "subagent_spawn", ctx, {
      description: "x y z",
      prompt: "p",
      subagent_type: "general",
    })
    expect(spawned.metadata?.sessionId).toBe("ses_child_1")
    expect(spawned.metadata?.promptOutcome).toBe("unconfirmed")
    expect(spawned.output).toContain("do not spawn duplicate work")
    // The accepted child is retained, and stays registered for its completion
    // note — the settle engine, not this window, decides its outcome.
    expect(deletes).toHaveLength(0)
    // A send is likewise not reported as failed: telling the caller it did not
    // land invites a re-send of a message the child may already be acting on.
    const sent = await call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "hi",
      wait: false,
    })
    expect(sent.metadata?.sessionId).toBe("ses_child")
    expect(sent.metadata?.outcome).toBe("unconfirmed")
    expect(sent.output).toContain("do not resend the same message")
    expect(deletes).toHaveLength(0)
  })

  test("a send continues when its prompt persisted before the response was lost", async () => {
    const world = makeWorld()
    withChild(world)
    const { client, prompts, deletes } = makeClient(world)
    const persist = (client.session as any).promptAsync.bind(client.session)
    ;(client.session as any).promptAsync = async (input: any) => {
      await persist(input)
      throw new Error("socket closed")
    }
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    const sent = await call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "status?",
      wait: false,
    })

    expect(sent.metadata).toMatchObject({
      sessionId: "ses_child",
      outcome: "delivered",
    })
    expect(prompts[0].body.messageID).toMatch(
      /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    )
    expect(deletes).toHaveLength(0)

    completeChild(world, "ses_child", "answer", prompts[0].body.messageID)
    await idleEvent(hooks, "ses_child")
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)
  })

  test("a thrown prompt keeps polling after a successful empty visibility read", async () => {
    const world = makeWorld()
    withChild(world)
    const { client, prompts, deletes } = makeClient(world)
    const originalMessages = (client.session as any).messages.bind(
      client.session,
    )
    let visibilityReads = 0
    ;(client.session as any).promptAsync = (input: any) => {
      prompts.push(input)
      return Promise.reject(new Error("socket closed"))
    }
    ;(client.session as any).messages = (input: any) => {
      visibilityReads++
      if (visibilityReads === 1) return Promise.resolve({ data: [] })
      world.messages.set("ses_child", [
        {
          info: {
            id: prompts[0].body.messageID,
            role: "user",
            sessionID: "ses_child",
          },
          parts: prompts[0].body.parts,
        },
      ])
      return originalMessages(input)
    }
    const hooks = await load(client, { injectConfirmTimeoutMs: 500 })
    const { ctx } = makeCtx()
    const sent = await call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "status?",
      wait: false,
    })

    expect(sent.metadata?.outcome).toBe("delivered")
    expect(visibilityReads).toBe(2)
    expect(deletes).toHaveLength(0)
  })

  test("a failed transport and visibility read return unconfirmed without waiting out the window", async () => {
    const world = makeWorld()
    withChild(world)
    const { client, prompts, deletes } = makeClient(world)
    const originalPromptAsync = (client.session as any).promptAsync.bind(
      client.session,
    )
    const originalMessages = (client.session as any).messages.bind(
      client.session,
    )
    let visibilityReads = 0
    ;(client.session as any).promptAsync = (input: any) => {
      prompts.push(input)
      return Promise.reject(new Error("socket closed"))
    }
    ;(client.session as any).messages = () => {
      visibilityReads++
      return Promise.reject(new Error("connection refused"))
    }
    const hooks = await load(client, { injectConfirmTimeoutMs: 30_000 })
    const { ctx } = makeCtx()
    const sent = await Promise.race([
      call(hooks, "subagent_send", ctx, {
        session_id: "ses_child",
        message: "status?",
        wait: false,
      }),
      Bun.sleep(500).then(() => {
        throw new Error("confirmation did not fail fast")
      }),
    ])

    expect(sent.metadata).toMatchObject({
      sessionId: "ses_child",
      outcome: "unconfirmed",
    })
    expect(sent.output).toContain("do not resend the same message")
    expect(visibilityReads).toBe(1)
    expect(deletes).toHaveLength(0)

    ;(client.session as any).promptAsync = originalPromptAsync
    ;(client.session as any).messages = originalMessages
    completeChild(world, "ses_child", "answer", prompts[0].body.messageID)
    await idleEvent(hooks, "ses_child")
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
  })

  test("a spawn preserves completion tracking when transport and visibility both fail", async () => {
    const world = makeWorld()
    const { client, prompts, deletes } = makeClient(world)
    const originalPromptAsync = (client.session as any).promptAsync.bind(
      client.session,
    )
    const originalMessages = (client.session as any).messages.bind(
      client.session,
    )
    let promptAttempted = false
    let visibilityReads = 0
    ;(client.session as any).promptAsync = (input: any) => {
      promptAttempted = true
      prompts.push(input)
      return Promise.reject(new Error("socket closed"))
    }
    ;(client.session as any).messages = (input: any) => {
      if (!promptAttempted) return originalMessages(input)
      visibilityReads++
      return Promise.reject(new Error("connection refused"))
    }
    const hooks = await load(client, { injectConfirmTimeoutMs: 30_000 })
    const { ctx } = makeCtx()
    const spawned = await Promise.race([
      call(hooks, "subagent_spawn", ctx, {
        description: "x y z",
        prompt: "p",
        subagent_type: "general",
      }),
      Bun.sleep(500).then(() => {
        throw new Error("confirmation did not fail fast")
      }),
    ])

    expect(spawned.metadata).toMatchObject({
      sessionId: "ses_child_1",
      promptOutcome: "unconfirmed",
    })
    expect(spawned.output).toContain("do not spawn duplicate work")
    expect(visibilityReads).toBe(1)
    expect(deletes).toHaveLength(0)

    ;(client.session as any).promptAsync = originalPromptAsync
    ;(client.session as any).messages = originalMessages
    completeChild(world, "ses_child_1", "answer", prompts[0].body.messageID)
    await idleEvent(hooks, "ses_child_1")
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
  })

  // The other half of the same invariant: a prompt the host explicitly
  // REJECTED was never accepted, so the child really is dead on arrival.
  test("a rejected prompt still deletes the child it was for", async () => {
    const world = makeWorld()
    withChild(world)
    const { client, deletes } = makeClient(world)
    ;(client.session as any).promptAsync = () =>
      Promise.resolve({ error: { name: "BadRequest" } })
    const hooks = await load(client, { injectConfirmTimeoutMs: 300 })
    const { ctx } = makeCtx()
    await expect(
      call(hooks, "subagent_spawn", ctx, {
        description: "x y z",
        prompt: "p",
        subagent_type: "general",
      }),
    ).rejects.toThrow(/failed/)
    await until(() => deletes.length === 1)
    expect(deletes[0]).toBe("ses_child_1")
  })

  // An abort during confirmation ends the CALLER'S wait. Polling on would only
  // hold the spawn reservation and delay cancellation; the child keeps the
  // prompt the host accepted either way.
  test("an abort during the confirmation wait stops waiting without retracting the child", async () => {
    const world = makeWorld()
    withChild(world)
    const { client, prompts, deletes } = makeClient(world)
    ;(client.session as any).promptAsync = (input: any) => {
      prompts.push(input)
      return Promise.resolve({})
    }
    // Long enough that returning promptly can only be the abort, not the deadline.
    const hooks = await load(client, { injectConfirmTimeoutMs: 30_000 })
    const { ctx, controller } = makeCtx()
    const spawning = call(hooks, "subagent_spawn", ctx, {
      description: "x y z",
      prompt: "p",
      subagent_type: "general",
    })
    await until(() => prompts.length === 1)
    controller.abort()
    const spawned = await spawning
    expect(spawned.metadata?.sessionId).toBe("ses_child_1")
    expect(deletes).toHaveLength(0)
  })

  // isBusy answers "unknown" for a read this plugin CANCELLED exactly as it
  // does for one that failed, and unknown errs toward busy — which is the
  // reading that would carry a send straight into the injection. These pin the
  // guard that stops it: the destructive direction here is promptAsync, which
  // STARTS a child run on a host the plugin has already said goodbye to.
  test("dispose during the busy read of a blocking send neither prompts nor waits", async () => {
    const world = makeWorld()
    withChild(world)
    world.statusHangs = true
    const { client, prompts, statusSignals } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()

    const sending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "hi",
    }).catch((error: Error) => error)
    // requireDirectChild reads session.get/children, not the status map, so
    // the first signal really is isBusy's.
    await until(() => statusSignals.length === 1)
    const startedAt = Date.now()
    await hooks.dispose?.()
    active = undefined

    // Released by the abort, not by waiting out the 10 s deadline — and not by
    // the five-minute wait a post-teardown waiter would otherwise sit in.
    expect(await sending).toBeInstanceOf(Error)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(prompts).toHaveLength(0)
  })

  test("dispose during the busy read of a non-blocking send registers no notification", async () => {
    const world = makeWorld()
    withChild(world)
    world.statusHangs = true
    const { client, prompts, statusSignals } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()

    const sending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "hi",
      wait: false,
    }).catch((error: Error) => error)
    await until(() => statusSignals.length === 1)
    await hooks.dispose?.()
    active = undefined

    // The variant that reports "delivered" and leaves a note behind: without
    // the guard it repopulates the notifies map teardown just emptied, with no
    // poller left that could ever drain it.
    expect(await sending).toBeInstanceOf(Error)
    expect(prompts).toHaveLength(0)
  })
})

describe("#239: unconfirmed initial launches", () => {
  test("an invisible launch gets one additional budget, then parks without discounting real host work", async () => {
    const now = Date.now()
    let skew = 0
    const clock = spyOn(Date, "now").mockImplementation(() => now + skew)
    try {
      const world = makeWorld()
      const { client, prompts, creates, aborts, deletes } = makeClient(world)
      const promptAsync = client.session.promptAsync.bind(client.session)
      const messages = client.session.messages.bind(client.session)
      ;(client.session as any).promptAsync = (input: any) => {
        if (input.path.id !== "ses_child_1") return promptAsync(input)
        prompts.push(input)
        return Promise.resolve({})
      }
      ;(client.session as any).messages = (input: any) => {
        // Spend the initial confirmation window without spending real time.
        if (input.path.id === "ses_child_1" && skew === 0) skew = 250
        return messages(input)
      }
      const hooks = await load(client, {
        injectConfirmTimeoutMs: 250,
        pollIntervalMs: 30_000,
        maxBusyChildren: 1,
      })
      const { ctx } = makeCtx()
      const spawned = await call(hooks, "subagent_spawn", ctx, {
        description: "uncertain launch",
        prompt: "original work",
        subagent_type: "general",
      })
      const promptMessageId = prompts[0].body.messageID
      expect(spawned.metadata).toMatchObject({
        sessionId: "ses_child_1",
        promptOutcome: "unconfirmed",
        promptMessageId,
      })
      expect(spawned.output).toContain("do not spawn duplicate work")

      for (const elapsed of [0, 249]) {
        skew = 250 + elapsed
        const listed = await call(hooks, "subagent_list", ctx, {})
        expect(listed.output).toContain("initial prompt unconfirmed")
        expect(listed.output).not.toContain("tracking parked")
        expect(listed.output).toContain(promptMessageId)
        expect(listed.metadata?.unconfirmedLaunches).toEqual([
          { sessionId: "ses_child_1", promptMessageId, state: "unconfirmed" },
        ])
        await expect(
          call(hooks, "subagent_spawn", ctx, {
            description: "still reserved",
            prompt: "different work",
            subagent_type: "general",
          }),
        ).rejects.toThrow(/already has 1 subagents working/)
      }

      // The first tool check at the deadline parks, with no idle/grace checks.
      skew = 500
      expect(creates).toHaveLength(1)
      const next = await call(hooks, "subagent_spawn", ctx, {
        description: "released synthetic slot",
        prompt: "different work",
        subagent_type: "general",
      })
      expect(next.metadata?.sessionId).toBe("ses_child_2")
      completeChild(
        world,
        "ses_child_2",
        "different work done",
        prompts[1].body.messageID,
      )
      await idleEvent(hooks, "ses_child_2")
      await until(() =>
        prompts.some((prompt) => prompt.path.id === "ses_parent"),
      )

      for (const type of ["busy", "retry"]) {
        world.status.ses_child_1 = { type }
        await expect(
          call(hooks, "subagent_spawn", ctx, {
            description: "host still working",
            prompt: "different work",
            subagent_type: "general",
          }),
        ).rejects.toThrow(/already has 1 subagents working/)
        const listed = await call(hooks, "subagent_list", ctx, {})
        expect(listed.output).toContain(`ses_child_1 [${type}]`)
        expect(listed.output).toContain("initial prompt unconfirmed")
        expect(listed.output).toContain("tracking parked")
        expect(listed.output).toContain(promptMessageId)
        expect(listed.metadata?.busy).toBe(1)
        expect(listed.metadata?.unconfirmedLaunches).toEqual([
          { sessionId: "ses_child_1", promptMessageId, state: "parked" },
        ])
      }
      expect(creates).toHaveLength(2)
      expect(world.sessions.has("ses_child_1")).toBe(true)
      expect(world.messages.get("ses_child_1") ?? []).toEqual([])
      expect(prompts).toHaveLength(3)
      expect(
        prompts.filter((prompt) => prompt.path.id === "ses_child_1"),
      ).toHaveLength(1)
      expect(aborts).toHaveLength(0)
      expect(deletes).toHaveLength(0)
    } finally {
      clock.mockRestore()
    }
  })

  test("parking stops autonomous reads despite unavailable endpoints and repeated idle events", async () => {
    const realNow = Date.now.bind(Date)
    let skew = 0
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew)
    try {
      const world = makeWorld()
      const { client, prompts, messageCalls, statusSignals } = makeClient(world)
      const promptAsync = client.session.promptAsync.bind(client.session)
      const messages = client.session.messages.bind(client.session)
      const status = client.session.status.bind(client.session)
      ;(client.session as any).promptAsync = (input: any) => {
        prompts.push(input)
        return Promise.resolve({})
      }
      const hooks = await load(client, {
        injectConfirmTimeoutMs: 250,
        pollIntervalMs: 250,
      })
      const { ctx } = makeCtx()
      await call(hooks, "subagent_spawn", ctx, {
        description: "unreadable launch",
        prompt: "original work",
        subagent_type: "general",
      })
      const promptMessageId = prompts[0].body.messageID
      let failedTranscriptReads = 0
      let failedStatusReads = 0
      const lookups: any[] = []
      ;(client.session as any).messages = () => {
        failedTranscriptReads++
        return Promise.reject(new Error("transcript unavailable"))
      }
      ;(client.session as any).message = (input: any) => {
        lookups.push(input)
        return Promise.reject(new Error("lookup unavailable"))
      }
      await idleEvent(hooks, "ses_child_1")
      await until(() => failedTranscriptReads === 1)
      ;(client.session as any).status = () => {
        failedStatusReads++
        return Promise.reject(new Error("status unavailable"))
      }
      skew += 251
      // Only the 250 ms poller can notice expiry here, not a list/tool call.
      await Bun.sleep(600)
      expect(failedStatusReads).toBe(0)
      expect(failedTranscriptReads).toBe(1)
      expect(lookups).toHaveLength(0)
      const listed = await call(hooks, "subagent_list", ctx, {})
      expect(listed.metadata?.statusUnavailable).toBe(true)
      expect(listed.metadata?.unconfirmedLaunches).toEqual([
        { sessionId: "ses_child_1", promptMessageId, state: "parked" },
      ])
      for (let index = 0; index < 3; index++) {
        skew += GRACE_SPACING_MS + 1
        await idleEvent(hooks, "ses_child_1")
      }
      await Bun.sleep(600)
      expect(failedStatusReads).toBe(1) // Only the explicit list read.
      expect(failedTranscriptReads).toBe(1)
      expect(lookups).toHaveLength(0)

      ;(client.session as any).promptAsync = promptAsync
      ;(client.session as any).messages = messages
      ;(client.session as any).status = status
      completeChild(world, "ses_child_1", "late real answer", promptMessageId)
      const reads = messageCalls.length
      const statuses = statusSignals.length
      await Promise.all([
        idleEvent(hooks, "ses_child_1"),
        idleEvent(hooks, "ses_child_1"),
      ])
      await Bun.sleep(600)
      expect(messageCalls).toHaveLength(reads)
      expect(statusSignals).toHaveLength(statuses)
      expect(lookups).toHaveLength(0)
      expect(prompts).toHaveLength(1)
    } finally {
      clock.mockRestore()
    }
  })

  test("explicit waits preserve initial uncertainty through timeout and failed reads until a correlated reply arrives", async () => {
    const world = makeWorld()
    const oldUserID = hostMessageID(Date.now() - 1, 0)
    const { client, prompts, statusSignals, messageCalls } = makeClient(world)
    const promptAsync = client.session.promptAsync.bind(client.session)
    const messages = client.session.messages.bind(client.session)
    const message = client.session.message.bind(client.session)
    ;(client.session as any).promptAsync = (input: any) => {
      prompts.push(input)
      return Promise.resolve({})
    }
    const hooks = await load(client, {
      injectConfirmTimeoutMs: 250,
      pollIntervalMs: 30_000,
    })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_spawn", ctx, {
      description: "uncertain result",
      prompt: "original work",
      subagent_type: "general",
    })
    const promptMessageId = prompts[0].body.messageID
    completeChild(world, "ses_child_1", "UNRELATED OLD ANSWER", oldUserID)
    const lookups: any[] = []
    let hangLookup = false
    ;(client.session as any).message = (input: any) => {
      lookups.push(input)
      if (hangLookup)
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            {
              once: true,
            },
          )
        })
      return message(input)
    }
    const args = { session_ids: ["ses_child_1"], timeout_ms: 1_000 }
    const unresolved = await call(hooks, "subagent_wait", ctx, args)
    expect(unresolved.metadata).toMatchObject({
      waited: [],
      stillBusy: [],
      uncertain: ["ses_child_1"],
    })
    expect(unresolved.output).toContain(promptMessageId)
    expect(unresolved.output).not.toContain("UNRELATED OLD ANSWER")
    expect(unresolved.output).not.toContain("went idle without a new reply")
    expect(lookups).toHaveLength(1)
    expect(lookups[0].path).toEqual({
      id: "ses_child_1",
      messageID: promptMessageId,
    })
    expect(
      (await call(hooks, "subagent_list", ctx, {})).metadata
        ?.unconfirmedLaunches,
    ).toEqual([
      { sessionId: "ses_child_1", promptMessageId, state: "unconfirmed" },
    ])

    // Read the current transcript, but keep the unseen initial id as a lower bound.
    world.status.ses_child_1 = { type: "busy" }
    const statuses = statusSignals.length
    const reads = messageCalls.length
    const pending = call(hooks, "subagent_wait", ctx, args)
    let settled = false
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    )
    await until(() => statusSignals.length >= statuses + 2)
    expect(messageCalls.length).toBeGreaterThan(reads)
    delete world.status.ses_child_1
    await idleEvent(hooks, "ses_child_1")
    await Bun.sleep(50)
    expect(settled).toBe(false)
    const timedOut = await pending
    expect(timedOut.metadata).toMatchObject({
      waited: [],
      stillBusy: [],
      uncertain: ["ses_child_1"],
    })
    expect(timedOut.output).not.toContain("UNRELATED OLD ANSWER")

    let transcriptSignal: AbortSignal | undefined
    ;(client.session as any).messages = (input: any) => {
      transcriptSignal = input.signal
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          {
            once: true,
          },
        )
      })
    }
    const failedRead = await call(hooks, "subagent_wait", ctx, args)
    expect(transcriptSignal?.aborted).toBe(true)
    expect(failedRead.metadata).toMatchObject({
      waited: [],
      stillBusy: [],
      uncertain: ["ses_child_1"],
    })
    ;(client.session as any).messages = messages
    hangLookup = true
    const failedLookup = await call(hooks, "subagent_wait", ctx, args)
    expect(lookups).toHaveLength(2)
    expect(lookups[1]).toMatchObject({
      path: { id: "ses_child_1", messageID: promptMessageId },
      query: { directory: DIRECTORY },
    })
    expect(lookups[1].signal.aborted).toBe(true)
    expect(failedLookup.metadata).toMatchObject({
      waited: [],
      stillBusy: [],
      uncertain: ["ses_child_1"],
    })
    expect(
      (await call(hooks, "subagent_list", ctx, {})).metadata
        ?.unconfirmedLaunches,
    ).toEqual([{ sessionId: "ses_child_1", promptMessageId, state: "parked" }])

    ;(client.session as any).promptAsync = promptAsync
    completeChild(
      world,
      "ses_child_1",
      "CORRELATED LATE ANSWER",
      promptMessageId,
    )
    const collected = await call(hooks, "subagent_wait", ctx, args)
    expect(collected.output).toContain("CORRELATED LATE ANSWER")
    expect(collected.output).not.toContain("UNRELATED OLD ANSWER")
    expect(collected.metadata).toMatchObject({
      waited: ["ses_child_1"],
      stillBusy: [],
    })
    expect(collected.metadata?.uncertain ?? []).toEqual([])
    expect(lookups).toHaveLength(2) // A correlated transcript needs no exact lookup.
    expect(
      (await call(hooks, "subagent_list", ctx, {})).metadata
        ?.unconfirmedLaunches ?? [],
    ).toEqual([])
    await idleEvent(hooks, "ses_child_1")
    await Bun.sleep(50)
    expect(prompts).toHaveLength(1)
  })

  test.each(["reply", "error"] as const)(
    "a newer %s cannot confirm an unseen initial prompt before or after parking",
    async (kind) => {
      const realNow = Date.now.bind(Date)
      let skew = 0
      const clock = spyOn(Date, "now").mockImplementation(
        () => realNow() + skew,
      )
      try {
        const world = makeWorld()
        const { client, prompts, messageCalls, statusSignals } =
          makeClient(world)
        const promptAsync = client.session.promptAsync.bind(client.session)
        ;(client.session as any).promptAsync = (input: any) => {
          if (input.path.id === "ses_parent") return promptAsync(input)
          prompts.push(input)
          return Promise.resolve({})
        }
        const hooks = await load(client, {
          injectConfirmTimeoutMs: 250,
          pollIntervalMs: 30_000,
        })
        const { ctx } = makeCtx()
        await call(hooks, "subagent_spawn", ctx, {
          description: "unseen initial A",
          prompt: "A",
          subagent_type: "general",
        })
        const promptMessageId = prompts[0].body.messageID
        const newerID = hostMessageID(Date.now() + 1, 0)
        const complete =
          kind === "reply" ? completeChild : completeChildWithError
        complete(world, "ses_child_1", "UNRELATED B OUTCOME", newerID)
        const lookup = spyOn(client.session, "message")
        const args = { session_ids: ["ses_child_1"] }
        for (const state of ["unconfirmed", "parked"]) {
          if (state === "parked") skew += 251
          const listed = await call(hooks, "subagent_list", ctx, {})
          expect(listed.metadata?.unconfirmedLaunches).toEqual([
            { sessionId: "ses_child_1", promptMessageId, state },
          ])
          const inspected = await call(hooks, "subagent_wait", ctx, args)
          expect(inspected.metadata).toMatchObject({
            waited: [],
            stillBusy: [],
            uncertain: ["ses_child_1"],
          })
          expect(inspected.output).not.toContain("UNRELATED B OUTCOME")
          expect(lookup).toHaveBeenLastCalledWith(
            expect.objectContaining({
              path: { id: "ses_child_1", messageID: promptMessageId },
            }),
          )
          // Restoring an unparked claim also schedules automatic settlement.
          await idleEvent(hooks, "ses_child_1")
          await Bun.sleep(20)
          expect(prompts).toHaveLength(1)
        }

        // A wait anchored to unseen A must not consume B if it arrives later.
        const newerMessages = world.messages.get("ses_child_1")!
        world.messages.set("ses_child_1", [])
        world.status.ses_child_1 = { type: "busy" }
        const statuses = statusSignals.length
        const pending = call(hooks, "subagent_wait", ctx, {
          ...args,
          timeout_ms: 1_000,
        })
        await until(() => statusSignals.length >= statuses + 2)
        world.messages.set("ses_child_1", newerMessages)
        delete world.status.ses_child_1
        await idleEvent(hooks, "ses_child_1")
        const waited = await pending
        expect(waited.metadata).toMatchObject({
          waited: [],
          stillBusy: [],
          uncertain: ["ses_child_1"],
        })
        expect(waited.output).not.toContain("UNRELATED B OUTCOME")

        // An exact parent proves acceptance even when the user message aged
        // out of the bounded transcript and the exact-message route fails.
        complete(world, "ses_child_1", "EXACT A OUTCOME", promptMessageId)
        const exact = world.messages.get("ses_child_1")!.at(-1)!
        world.messages.set("ses_child_1", [exact])
        lookup.mockImplementation(() =>
          Promise.reject(new Error("unavailable")),
        )
        lookup.mockClear()
        const collected = await call(hooks, "subagent_wait", ctx, args)
        expect(collected.metadata?.waited).toEqual(["ses_child_1"])
        expect(collected.metadata?.uncertain ?? []).toEqual([])
        expect(collected.output).toContain("EXACT A OUTCOME")
        expect(lookup).not.toHaveBeenCalled()
        lookup.mockRestore()
        const reads = messageCalls.length
        await idleEvent(hooks, "ses_child_1")
        await Bun.sleep(20)
        expect(messageCalls).toHaveLength(reads)
        expect(prompts).toHaveLength(1)
      } finally {
        clock.mockRestore()
      }
    },
  )

  test("idle kill clears unresolved launch tracking before and after parking without cancelling acceptance", async () => {
    const realNow = Date.now.bind(Date)
    let skew = 0
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew)
    try {
      const world = makeWorld()
      const { client, prompts, aborts, deletes, messageCalls } =
        makeClient(world)
      const promptAsync = client.session.promptAsync.bind(client.session)
      ;(client.session as any).promptAsync = (input: any) => {
        prompts.push(input)
        return Promise.resolve({})
      }
      const hooks = await load(client, {
        injectConfirmTimeoutMs: 250,
        pollIntervalMs: 30_000,
        maxBusyChildren: 1,
      })
      const { ctx } = makeCtx()
      for (const state of ["unconfirmed", "parked"]) {
        const spawned = await call(hooks, "subagent_spawn", ctx, {
          description: "clear uncertain launch",
          prompt: "original work",
          subagent_type: "general",
        })
        const childID = spawned.metadata?.sessionId
        const promptMessageId = prompts.at(-1).body.messageID
        if (state === "parked") {
          skew += 251
          const reads = messageCalls.length
          await idleEvent(hooks, childID)
          await Bun.sleep(20)
          expect(messageCalls).toHaveLength(reads)
        }
        expect(
          (await call(hooks, "subagent_list", ctx, {})).metadata
            ?.unconfirmedLaunches,
        ).toEqual([{ sessionId: childID, promptMessageId, state }])
        const killed = await call(hooks, "subagent_kill", ctx, {
          session_id: childID,
        })
        expect(killed.metadata).toEqual({
          sessionId: childID,
          aborted: false,
          trackingCleared: true,
          promptMessageId,
        })
        expect(killed.output).toContain(promptMessageId)
        expect(killed.output).toContain(
          "does not prove the original request was cancelled",
        )
        expect(world.sessions.has(childID)).toBe(true)
        expect(
          (await call(hooks, "subagent_list", ctx, {})).metadata
            ?.unconfirmedLaunches ?? [],
        ).toEqual([])
        const reads = messageCalls.length
        completeChild(
          world,
          childID,
          "late acceptance was not cancelled",
          promptMessageId,
        )
        skew += 1_000
        await idleEvent(hooks, childID)
        await idleEvent(hooks, childID)
        await Bun.sleep(20)
        expect(messageCalls).toHaveLength(reads)
      }
      ;(client.session as any).promptAsync = promptAsync
      const next = await call(hooks, "subagent_spawn", ctx, {
        description: "cleared slot",
        prompt: "different work",
        subagent_type: "general",
      })
      expect(next.metadata?.sessionId).toBe("ses_child_3")
      expect(prompts).toHaveLength(3)
      expect(aborts).toHaveLength(0)
      expect(deletes).toHaveLength(0)
    } finally {
      clock.mockRestore()
    }
  })

  test("idle and busy kills prevent an outstanding wait from restoring unresolved initial tracking", async () => {
    const world = makeWorld()
    const oldUserID = hostMessageID(Date.now() - 1, 0)
    const { client, prompts, aborts, deletes, statusSignals } =
      makeClient(world)
    const abort = client.session.abort.bind(client.session)
    ;(client.session as any).promptAsync = (input: any) => {
      prompts.push(input)
      return Promise.resolve({})
    }
    ;(client.session as any).abort = async (input: any) => {
      const result = await abort(input)
      delete world.status[input.path.id]
      return result
    }
    const hooks = await load(client, {
      injectConfirmTimeoutMs: 250,
      pollIntervalMs: 30_000,
      maxBusyChildren: 1,
    })
    const { ctx } = makeCtx()
    for (const busy of [false, true]) {
      const spawned = await call(hooks, "subagent_spawn", ctx, {
        description: "claimed uncertain launch",
        prompt: "original work",
        subagent_type: "general",
      })
      const childID = spawned.metadata?.sessionId
      completeChild(world, childID, "OLD ANSWER", oldUserID)
      world.status[childID] = { type: "busy" }
      const waiting = makeCtx()
      const statuses = statusSignals.length
      const pending = call(hooks, "subagent_wait", waiting.ctx, {
        session_ids: [childID],
        timeout_ms: 1_000,
      })
      await until(() => statusSignals.length >= statuses + 2)
      // The wait now owns the note off-map; kill cannot claim that note itself.
      if (!busy) delete world.status[childID]
      const killed = await call(hooks, "subagent_kill", ctx, {
        session_id: childID,
      })
      expect(killed.metadata?.aborted).toBe(busy)
      waiting.controller.abort()
      await expect(pending).rejects.toThrow(WAIT_ABORTED_MESSAGE)
      expect(
        (await call(hooks, "subagent_list", ctx, {})).metadata
          ?.unconfirmedLaunches ?? [],
      ).toEqual([])
      expect(world.sessions.has(childID)).toBe(true)
      await idleEvent(hooks, childID)
    }
    expect(aborts).toEqual(["ses_child_2"])
    expect(deletes).toHaveLength(0)
    expect(prompts).toHaveLength(2)
  })

  test.each([false, true])(
    "kill suppresses a spawn still confirming its initial prompt (busy: %s)",
    async (busy) => {
      const world = makeWorld()
      const { client, prompts, messageCalls, aborts } = makeClient(world)
      const messages = client.session.messages.bind(client.session)
      let releaseRead!: () => void
      const readGate = new Promise<void>((resolve) => (releaseRead = resolve))
      ;(client.session as any).promptAsync = (input: any) => {
        prompts.push(input)
        return Promise.resolve({})
      }
      ;(client.session as any).messages = async (input: any) => {
        if (input.path.id !== "ses_child_1") return messages(input)
        messageCalls.push(input)
        await readGate
        return { data: [] }
      }
      const hooks = await load(client, {
        injectConfirmTimeoutMs: 250,
        pollIntervalMs: 30_000,
      })
      const spawning = makeCtx()
      const pending = call(hooks, "subagent_spawn", spawning.ctx, {
        description: "confirming initial launch",
        prompt: "A",
        subagent_type: "general",
      })
      await until(() => messageCalls.length === 1)
      if (busy) world.status.ses_child_1 = { type: "busy" }
      const killing = makeCtx()
      // Skip waiting for idle confirmation, not the abort RPC itself.
      killing.controller.abort()
      const killed = await call(hooks, "subagent_kill", killing.ctx, {
        session_id: "ses_child_1",
      })
      expect(killed.metadata?.aborted).toBe(false)
      expect(aborts).toEqual(busy ? ["ses_child_1"] : [])
      spawning.controller.abort()
      releaseRead()
      const spawned = await pending
      expect(spawned.metadata?.promptOutcome).toBe("unconfirmed")
      expect(
        (await call(hooks, "subagent_list", spawning.ctx, {})).metadata
          ?.unconfirmedLaunches ?? [],
      ).toEqual([])
      const reads = messageCalls.length
      completeChild(world, "ses_child_1", "late A", prompts[0].body.messageID)
      await idleEvent(hooks, "ses_child_1")
      await Bun.sleep(20)
      expect(messageCalls).toHaveLength(reads)
      expect(prompts).toHaveLength(1)
      expect(world.sessions.has("ses_child_1")).toBe(true)
    },
  )

  test.each(["success", "error", "throw"] as const)(
    "a claim restored during the abort RPC is cleared only on success (%s)",
    async (response) => {
      const world = makeWorld()
      const { client, prompts, aborts, statusSignals } = makeClient(world)
      const promptAsync = client.session.promptAsync.bind(client.session)
      let finishAbort!: () => void
      const abortGate = new Promise<void>((resolve) => (finishAbort = resolve))
      ;(client.session as any).promptAsync = (input: any) => {
        if (input.path.id === "ses_parent") return promptAsync(input)
        prompts.push(input)
        return Promise.resolve({})
      }
      ;(client.session as any).abort = async (input: any) => {
        aborts.push(input.path.id)
        await abortGate
        if (response === "throw") throw new Error("transport failed")
        return response === "error"
          ? { error: { name: "rejected" } }
          : { data: true }
      }
      const hooks = await load(client, {
        injectConfirmTimeoutMs: 250,
        pollIntervalMs: 30_000,
      })
      const { ctx } = makeCtx()
      await call(hooks, "subagent_spawn", ctx, {
        description: "claim restored during abort",
        prompt: "A",
        subagent_type: "general",
      })
      const promptMessageId = prompts[0].body.messageID
      world.status.ses_child_1 = { type: "busy" }
      const waiting = makeCtx()
      const statuses = statusSignals.length
      const pending = call(hooks, "subagent_wait", waiting.ctx, {
        session_ids: ["ses_child_1"],
        timeout_ms: 1_000,
      })
      await until(() => statusSignals.length >= statuses + 2)
      const killing = makeCtx()
      const killed = call(hooks, "subagent_kill", killing.ctx, {
        session_id: "ses_child_1",
      })
      await until(() => aborts.length === 1)
      waiting.controller.abort()
      await expect(pending).rejects.toThrow(WAIT_ABORTED_MESSAGE)
      expect(
        (await call(hooks, "subagent_list", ctx, {})).metadata
          ?.unconfirmedLaunches,
      ).toEqual([
        { sessionId: "ses_child_1", promptMessageId, state: "unconfirmed" },
      ])
      killing.controller.abort()
      finishAbort()
      if (response === "success") {
        expect((await killed).metadata?.aborted).toBe(false)
        expect(
          (await call(hooks, "subagent_list", ctx, {})).metadata
            ?.unconfirmedLaunches ?? [],
        ).toEqual([])
      } else {
        await expect(killed).rejects.toThrow(/aborting ses_child_1 failed/)
        expect(
          (await call(hooks, "subagent_list", ctx, {})).metadata
            ?.unconfirmedLaunches,
        ).toHaveLength(1)
      }
      completeChild(world, "ses_child_1", "A finished anyway", promptMessageId)
      await idleEvent(hooks, "ses_child_1")
      if (response !== "success") await until(() => prompts.length === 2)
      await Bun.sleep(20)
      expect(prompts).toHaveLength(response === "success" ? 1 : 2)
      if (response !== "success")
        expect(prompts[1].body.parts[0].text).toContain("A finished anyway")
    },
  )

  test("initial visibility before the deadline keeps normal completion tracking beyond the budget", async () => {
    const realNow = Date.now.bind(Date)
    let skew = 0
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew)
    try {
      const world = makeWorld()
      const { client, prompts, messageCalls } = makeClient(world)
      const promptAsync = client.session.promptAsync.bind(client.session)
      ;(client.session as any).promptAsync = (input: any) => {
        prompts.push(input)
        return Promise.resolve({})
      }
      const hooks = await load(client, {
        injectConfirmTimeoutMs: 250,
        pollIntervalMs: 30_000,
      })
      const { ctx } = makeCtx()
      await call(hooks, "subagent_spawn", ctx, {
        description: "late visible launch",
        prompt: "original work",
        subagent_type: "general",
      })
      const initial = prompts[0]
      const promptMessageId = initial.body.messageID
      world.messages.set("ses_child_1", [
        {
          info: { id: promptMessageId, role: "user", sessionID: "ses_child_1" },
          parts: initial.body.parts,
        },
      ])
      ;(client.session as any).promptAsync = promptAsync
      const reads = messageCalls.length
      await idleEvent(hooks, "ses_child_1")
      await until(() => messageCalls.length > reads)
      expect(
        (await call(hooks, "subagent_list", ctx, {})).metadata
          ?.unconfirmedLaunches ?? [],
      ).toEqual([])
      skew += 1_000
      completeChild(world, "ses_child_1", "normal completion", promptMessageId)
      await idleEvent(hooks, "ses_child_1")
      await until(() =>
        prompts.some((prompt) => prompt.path.id === "ses_parent"),
      )
      await idleEvent(hooks, "ses_child_1")
      await Bun.sleep(50)
      expect(
        prompts.filter((prompt) => prompt.path.id === "ses_child_1"),
      ).toHaveLength(1)
      const notes = prompts.filter((prompt) => prompt.path.id === "ses_parent")
      expect(notes).toHaveLength(1)
      expect(notes[0].body.parts[0].text).toContain("normal completion")
    } finally {
      clock.mockRestore()
    }
  })

  test.each([
    "initial prompt",
    "aged-out initial prompt",
    "exact reply with newer prompt",
    "newer prompt only",
  ])(
    "a busy wait resumes parked tracking only with initial evidence (%s)",
    async (evidence) => {
      const realNow = Date.now.bind(Date)
      let skew = 0
      const clock = spyOn(Date, "now").mockImplementation(
        () => realNow() + skew,
      )
      try {
        const world = makeWorld()
        const { client, prompts, messageCalls } = makeClient(world)
        const promptAsync = client.session.promptAsync.bind(client.session)
        ;(client.session as any).promptAsync = (input: any) => {
          if (input.path.id === "ses_parent") return promptAsync(input)
          prompts.push(input)
          return Promise.resolve({})
        }
        const hooks = await load(client, {
          injectConfirmTimeoutMs: 250,
          pollIntervalMs: 30_000,
        })
        const { ctx } = makeCtx()
        await call(hooks, "subagent_spawn", ctx, {
          description: "confirmed after parking",
          prompt: "original work",
          subagent_type: "general",
        })
        const initial = prompts[0]
        const promptMessageId = initial.body.messageID
        skew += 251
        expect(
          (await call(hooks, "subagent_list", ctx, {})).metadata
            ?.unconfirmedLaunches,
        ).toEqual([
          { sessionId: "ses_child_1", promptMessageId, state: "parked" },
        ])

        if (
          evidence === "initial prompt" ||
          evidence === "aged-out initial prompt"
        ) {
          world.messages.set("ses_child_1", [
            {
              info: {
                id: promptMessageId,
                role: "user",
                sessionID: "ses_child_1",
              },
              parts: initial.body.parts,
            },
          ])
        } else {
          if (evidence === "exact reply with newer prompt") {
            completeChild(world, "ses_child_1", "OLD A REPLY", promptMessageId)
            world.messages.set("ses_child_1", [
              world.messages.get("ses_child_1")!.at(-1)!,
            ])
          }
          appendNewerUserMessages(world, "ses_child_1", 1)
        }
        const currentPromptID = world.messages.get("ses_child_1")!.at(-1)!.info
          .id as string
        if (evidence === "aged-out initial prompt") {
          appendAssistantSteps(world, "ses_child_1", promptMessageId)
          expect(
            world.messages
              .get("ses_child_1")!
              .slice(-50)
              .every((message) => message.info.role === "assistant"),
          ).toBe(true)
        }
        world.status.ses_child_1 = { type: "busy" }
        const waited = await call(hooks, "subagent_wait", ctx, {
          session_ids: ["ses_child_1"],
          timeout_ms: 1_000,
        })
        expect(waited.metadata).toMatchObject({
          waited: [],
          stillBusy: ["ses_child_1"],
        })
        expect(waited.metadata?.uncertain ?? []).toEqual([])
        expect(waited.output).not.toContain("OLD A REPLY")
        expect(
          (await call(hooks, "subagent_list", ctx, {})).metadata
            ?.unconfirmedLaunches ?? [],
        ).toEqual(
          evidence === "newer prompt only"
            ? [{ sessionId: "ses_child_1", promptMessageId, state: "parked" }]
            : [],
        )

        const reads = messageCalls.length
        completeChild(
          world,
          "ses_child_1",
          "confirmed completion",
          currentPromptID,
        )
        await idleEvent(hooks, "ses_child_1")
        if (evidence !== "newer prompt only") {
          await until(() => prompts.length === 2)
          expect(messageCalls.length).toBeGreaterThan(reads)
          expect(prompts[1].path.id).toBe("ses_parent")
          expect(prompts[1].body.parts[0].text).toContain(
            "confirmed completion",
          )
        }
        await idleEvent(hooks, "ses_child_1")
        await Bun.sleep(20)
        expect(prompts).toHaveLength(evidence === "newer prompt only" ? 1 : 2)
        if (evidence === "newer prompt only")
          expect(messageCalls).toHaveLength(reads)
      } finally {
        clock.mockRestore()
      }
    },
  )

  test("idle kill preserves restoration of an observed initial completion it did not clear", async () => {
    const world = makeWorld()
    const { client, prompts, logs } = makeClient(world)
    const messages = client.session.messages.bind(client.session)
    ;(client.session as any).promptAsync = (input: any) => {
      prompts.push(input)
      return Promise.resolve({})
    }
    const hooks = await load(client, {
      injectConfirmTimeoutMs: 250,
      pollIntervalMs: 30_000,
    })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_spawn", ctx, {
      description: "retained completion",
      prompt: "original work",
      subagent_type: "general",
    })
    completeChild(
      world,
      "ses_child_1",
      "retained answer",
      prompts[0].body.messageID,
    )
    // The child completed, but its parent notification cannot be delivered.
    world.sessions.get("ses_parent")!.model = undefined
    await idleEvent(hooks, "ses_child_1")
    await until(() =>
      logs.some((entry) => entry.body.message.includes("is terminal")),
    )
    expect(
      (await call(hooks, "subagent_list", ctx, {})).metadata
        ?.notificationIssues,
    ).toBe(1)

    const killed = await call(hooks, "subagent_kill", ctx, {
      session_id: "ses_child_1",
    })
    expect(killed.metadata?.trackingCleared).toBeUndefined()
    ;(client.session as any).messages = () =>
      Promise.reject(new Error("transient read failure"))
    const args = { session_ids: ["ses_child_1"] }
    const failedRead = await call(hooks, "subagent_wait", ctx, args)
    expect(failedRead.metadata?.waited).toEqual([])
    expect(
      (await call(hooks, "subagent_list", ctx, {})).metadata
        ?.notificationIssues,
    ).toBe(1)

    ;(client.session as any).messages = messages
    const collected = await call(hooks, "subagent_wait", ctx, args)
    expect(collected.output).toContain("retained answer")
    expect(
      (await call(hooks, "subagent_list", ctx, {})).metadata
        ?.notificationIssues,
    ).toBeUndefined()
    expect(prompts).toHaveLength(1)
  })

  test("accepted follow-up sends replace unresolved initial tracking even when a blocking send is aborted", async () => {
    const realNow = Date.now.bind(Date)
    let skew = 0
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew)
    try {
      const world = makeWorld()
      const { client, prompts, aborts, deletes } = makeClient(world)
      const promptAsync = client.session.promptAsync.bind(client.session)
      const hooks = await load(client, {
        injectConfirmTimeoutMs: 250,
        pollIntervalMs: 30_000,
        maxBusyChildren: 1,
      })
      const { ctx } = makeCtx()
      for (const [index, { wait, parked }] of [
        { wait: false, parked: true },
        { wait: true, parked: false },
        { wait: true, parked: true },
      ].entries()) {
        ;(client.session as any).promptAsync = (input: any) => {
          prompts.push(input)
          return Promise.resolve({})
        }
        const spawned = await call(hooks, "subagent_spawn", ctx, {
          description: "superseded launch",
          prompt: "original work",
          subagent_type: "general",
        })
        const childID = spawned.metadata?.sessionId
        const initialID = prompts.at(-1).body.messageID
        if (parked) skew += 251
        expect(
          (await call(hooks, "subagent_list", ctx, {})).metadata
            ?.unconfirmedLaunches,
        ).toEqual([
          {
            sessionId: childID,
            promptMessageId: initialID,
            state: parked ? "parked" : "unconfirmed",
          },
        ])
        ;(client.session as any).promptAsync = promptAsync
        const sending = makeCtx()
        const pending = call(hooks, "subagent_send", sending.ctx, {
          session_id: childID,
          message: "fresh follow-up work",
          wait,
        })
        await until(
          () =>
            prompts.filter((prompt) => prompt.path.id === childID).length === 2,
        )
        if (wait) {
          sending.controller.abort()
          await expect(pending).rejects.toThrow(SEND_ABORTED_MESSAGE)
        } else {
          expect((await pending).metadata?.outcome).toBe("delivered")
        }
        const fresh = prompts.filter((prompt) => prompt.path.id === childID)[1]
        expect(fresh.body.messageID).not.toBe(initialID)
        expect(fresh.body.parts[0].text).toBe("fresh follow-up work")
        expect(
          (await call(hooks, "subagent_list", ctx, {})).metadata
            ?.unconfirmedLaunches ?? [],
        ).toEqual([])
        await expect(
          call(hooks, "subagent_spawn", ctx, {
            description: "fresh work owns slot",
            prompt: "different work",
            subagent_type: "general",
          }),
        ).rejects.toThrow(/already has 1 subagents working/)
        completeChild(
          world,
          childID,
          `fresh answer ${childID}`,
          fresh.body.messageID,
        )
        await idleEvent(hooks, childID)
        await until(
          () =>
            prompts.filter((prompt) => prompt.path.id === "ses_parent")
              .length ===
            index + 1,
        )
        expect(
          prompts.filter((prompt) => prompt.path.id === "ses_parent")[index]
            .body.parts[0].text,
        ).toContain(`fresh answer ${childID}`)
        expect(
          prompts.filter((prompt) => prompt.path.id === childID),
        ).toHaveLength(2)
      }
      expect(aborts).toHaveLength(0)
      expect(deletes).toHaveLength(0)
    } finally {
      clock.mockRestore()
    }
  })

  test("aborting a blocking follow-up preserves a newer nonblocking send's notification", async () => {
    const world = makeWorld()
    const { client, prompts, messageCalls, statusSignals } = makeClient(world)
    const promptAsync = client.session.promptAsync.bind(client.session)
    ;(client.session as any).promptAsync = (input: any) => {
      prompts.push(input)
      return Promise.resolve({})
    }
    const hooks = await load(client, {
      injectConfirmTimeoutMs: 250,
      pollIntervalMs: 30_000,
    })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_spawn", ctx, {
      description: "initial A",
      prompt: "A",
      subagent_type: "general",
    })
    ;(client.session as any).promptAsync = promptAsync
    world.status.ses_child_1 = { type: "busy" }
    const sending = makeCtx()
    const statuses = statusSignals.length
    const pending = call(hooks, "subagent_send", sending.ctx, {
      session_id: "ses_child_1",
      message: "blocking B",
    })
    await until(
      () => prompts.length === 2 && statusSignals.length >= statuses + 2,
    )
    const messageB = prompts[1].body.messageID
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_child_1",
      message: "newer C",
      wait: false,
    })
    const messageC = prompts[2].body.messageID
    expect(messageC > messageB).toBe(true)
    sending.controller.abort()
    await expect(pending).rejects.toThrow(SEND_ABORTED_MESSAGE)

    // B must not replace C's anchor: an answer to B alone cannot notify C.
    completeChild(world, "ses_child_1", "OLD B ANSWER", messageB)
    const reads = messageCalls.length
    await idleEvent(hooks, "ses_child_1")
    await until(() => messageCalls.length > reads)
    await Bun.sleep(20)
    expect(prompts).toHaveLength(3)
    completeChild(world, "ses_child_1", "NEW C ANSWER", messageC)
    await idleEvent(hooks, "ses_child_1")
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    const notes = prompts.filter((prompt) => prompt.path.id === "ses_parent")
    expect(notes).toHaveLength(1)
    expect(notes[0].body.parts[0].text).toContain("NEW C ANSWER")
    expect(notes[0].body.parts[0].text).not.toContain("OLD B ANSWER")
  })

  test("a busy wait advances past a parked launch to the stock tool's newer user watermark", async () => {
    const realNow = Date.now.bind(Date)
    let skew = 0
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew)
    try {
      const world = makeWorld()
      const { client, prompts, statusSignals } = makeClient(world)
      ;(client.session as any).promptAsync = (input: any) => {
        prompts.push(input)
        return Promise.resolve({})
      }
      const hooks = await load(client, {
        injectConfirmTimeoutMs: 250,
        pollIntervalMs: 30_000,
      })
      const { ctx } = makeCtx()
      await call(hooks, "subagent_spawn", ctx, {
        description: "initial A",
        prompt: "A",
        subagent_type: "general",
      })
      const promptMessageId = prompts[0].body.messageID
      skew += 251
      expect(
        (await call(hooks, "subagent_list", ctx, {})).metadata
          ?.unconfirmedLaunches,
      ).toEqual([
        { sessionId: "ses_child_1", promptMessageId, state: "parked" },
      ])
      completeChild(
        world,
        "ses_child_1",
        "OLD INITIAL A ANSWER",
        promptMessageId,
      )
      appendNewerUserMessages(world, "ses_child_1", 1) // A stock task resumes with B.
      world.status.ses_child_1 = { type: "busy" }
      const statuses = statusSignals.length
      const pending = call(hooks, "subagent_wait", ctx, {
        session_ids: ["ses_child_1"],
        timeout_ms: 1_000,
      })
      await until(() => statusSignals.length >= statuses + 2)
      delete world.status.ses_child_1
      await idleEvent(hooks, "ses_child_1")
      await Bun.sleep(20)
      skew += GRACE_SPACING_MS + 1
      await idleEvent(hooks, "ses_child_1")
      const result = await pending
      expect(result.output).not.toContain("OLD INITIAL A ANSWER")
      expect(result.output).toContain("went idle without a new reply")
      expect(result.metadata).toMatchObject({
        waited: ["ses_child_1"],
        stillBusy: [],
      })
      expect(result.metadata?.uncertain ?? []).toEqual([])
      expect(prompts).toHaveLength(1)
    } finally {
      clock.mockRestore()
    }
  })

  test("observing a claimed initial prompt resumes tracking unless kill cleared it", async () => {
    const realNow = Date.now.bind(Date)
    let skew = 0
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew)
    try {
      const world = makeWorld()
      const { client, prompts, messageCalls, statusSignals, aborts } =
        makeClient(world)
      const promptAsync = client.session.promptAsync.bind(client.session)
      ;(client.session as any).promptAsync = (input: any) => {
        if (input.path.id === "ses_parent") return promptAsync(input)
        prompts.push(input)
        return Promise.resolve({})
      }
      const hooks = await load(client, {
        injectConfirmTimeoutMs: 250,
        pollIntervalMs: 30_000,
        maxBusyChildren: 1,
      })
      const { ctx } = makeCtx()
      // Each subsequent spawn also checks that the previous note freed the sole slot.
      for (const killFirst of [true, false]) {
        const spawned = await call(hooks, "subagent_spawn", ctx, {
          description: "observed initial claim",
          prompt: "A",
          subagent_type: "general",
        })
        const childID = spawned.metadata?.sessionId
        const initial = prompts.at(-1)
        const promptMessageId = initial.body.messageID
        if (!killFirst) {
          skew += 251
          expect(
            (await call(hooks, "subagent_list", ctx, {})).metadata
              ?.unconfirmedLaunches,
          ).toEqual([{ sessionId: childID, promptMessageId, state: "parked" }])
        }
        world.status[childID] = { type: "busy" }
        const waiting = makeCtx()
        const statuses = statusSignals.length
        let reads = messageCalls.length
        const pending = call(hooks, "subagent_wait", waiting.ctx, {
          session_ids: [childID],
          timeout_ms: 1_000,
        })
        await until(() => statusSignals.length >= statuses + 2)
        expect(messageCalls.length).toBeGreaterThan(reads) // Empty, but readable; A is the lower bound.
        delete world.status[childID]
        if (killFirst) {
          const killed = await call(hooks, "subagent_kill", ctx, {
            session_id: childID,
          })
          expect(killed.metadata?.aborted).toBe(false)
        }
        // Observe A while its claim is off-map, then abort before the idle grace.
        world.messages.set(childID, [
          {
            info: { id: promptMessageId, role: "user", sessionID: childID },
            parts: initial.body.parts,
          },
        ])
        reads = messageCalls.length
        await idleEvent(hooks, childID)
        await until(() => messageCalls.length > reads)
        await Bun.sleep(20)
        waiting.controller.abort()
        await expect(pending).rejects.toThrow(WAIT_ABORTED_MESSAGE)

        const listed = await call(hooks, "subagent_list", ctx, {})
        if (!killFirst) {
          expect(listed.output).not.toContain("tracking parked")
          expect(listed.metadata?.unconfirmedLaunches ?? []).toEqual([])
          completeChild(world, childID, "observed completion", promptMessageId)
          await idleEvent(hooks, childID)
          await until(() =>
            prompts.some((prompt) => prompt.path.id === "ses_parent"),
          )
          const notes = prompts.filter(
            (prompt) => prompt.path.id === "ses_parent",
          )
          expect(notes).toHaveLength(1)
          expect(notes[0].body.parts[0].text).toContain("observed completion")
        }
        expect(
          (await call(hooks, "subagent_list", ctx, {})).metadata
            ?.unconfirmedLaunches ?? [],
        ).toEqual([])
        reads = messageCalls.length
        await idleEvent(hooks, childID)
        await Bun.sleep(20)
        expect(messageCalls).toHaveLength(reads)
        expect(world.sessions.has(childID)).toBe(true)
      }
      ;(client.session as any).promptAsync = promptAsync
      const next = await call(hooks, "subagent_spawn", ctx, {
        description: "cleared observed claims",
        prompt: "different work",
        subagent_type: "general",
      })
      expect(next.metadata?.sessionId).toBe("ses_child_3")
      expect(prompts).toHaveLength(4)
      expect(aborts).toHaveLength(0)
    } finally {
      clock.mockRestore()
    }
  })
})

describe("subagent_list", () => {
  test("shows busy-first children with agent, title, and status; empty state guides to spawning", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      title: "audit (@general subagent)",
      agent: "general",
      time: { updated: Date.now() - 34_000 },
    })
    world.sessions.set("ses_b", {
      id: "ses_b",
      parentID: "ses_parent",
      title: "explore (@explore subagent)",
      agent: "explore",
      time: { updated: Date.now() },
    })
    world.status.ses_a = { type: "busy" }
    const { client } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const result = await call(hooks, "subagent_list", ctx, {})
    const lines = result.output.split("\n")
    expect(lines[0]).toBe("You have 2 subagent(s):")
    expect(lines[1]).toContain("ses_a [busy] @general")
    expect(lines[2]).toContain("ses_b [idle] @explore")
    expect(result.metadata).toEqual({ count: 2, busy: 1 })

    const empty = makeCtx("ses_b")
    const emptyResult = await call(hooks, "subagent_list", empty.ctx, {})
    expect(emptyResult.output).toContain("no subagents")
    expect(emptyResult.metadata).toEqual({ count: 0, busy: 0 })
  })

  test("reports unknown status rather than fabricating idle when the status endpoint fails", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      title: "audit (@general subagent)",
      agent: "general",
    })
    const { client } = makeClient(world)
    ;(client.session as any).status = () =>
      Promise.resolve({ error: { name: "boom" } })
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const result = await call(hooks, "subagent_list", ctx, {})
    expect(result.output).toContain("live status is unavailable")
    expect(result.output).toContain("ses_a [unknown]")
    expect(result.metadata).toMatchObject({ count: 1, statusUnavailable: true })
  })
})

describe("subagent_wait", () => {
  test("collects each busy child's latest reply and reports already-idle ones", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", { id: "ses_a", parentID: "ses_parent" })
    world.sessions.set("ses_b", { id: "ses_b", parentID: "ses_parent" })
    world.messages.set("ses_a", [
      {
        info: {
          id: "msg_w_user",
          role: "user",
          sessionID: "ses_a",
          time: { created: 1 },
        },
        parts: [],
      },
    ])
    world.status.ses_a = { type: "busy" }
    const { client } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const pending = call(hooks, "subagent_wait", ctx, {})
    await Bun.sleep(20)
    completeChild(world, "ses_a", "found it")
    await idleEvent(hooks, "ses_a")
    const result = await pending
    expect(result.output).toContain("1 of 1 busy subagent(s) finished")
    expect(result.output).toContain("found it")
    expect(result.output).toContain("- ses_b was already idle.")
    expect(result.metadata).toMatchObject({ waited: ["ses_a"], stillBusy: [] })
  })

  test("timeout lists still-working children without killing anything", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", { id: "ses_a", parentID: "ses_parent" })
    world.messages.set("ses_a", [
      {
        info: {
          id: "msg_w_user",
          role: "user",
          sessionID: "ses_a",
          time: { created: 1 },
        },
        parts: [],
      },
    ])
    world.status.ses_a = { type: "busy" }
    const { client, aborts } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const result = await call(hooks, "subagent_wait", ctx, {
      timeout_ms: 1_000,
    })
    expect(result.output).toContain("- ses_a is still working.")
    expect(result.metadata).toMatchObject({ waited: [], stillBusy: ["ses_a"] })
    expect(aborts).toHaveLength(0)
  })

  test("a wait that returns the reply consumes the pending note; a timeout restores it", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_a", [])
    world.status.ses_a = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "work",
      wait: false,
    })

    // Timed out: the completion was not consumed, so the note comes back.
    const timedOut = await call(hooks, "subagent_wait", ctx, {
      timeout_ms: 1_000,
    })
    expect(timedOut.metadata).toMatchObject({
      waited: [],
      stillBusy: ["ses_a"],
    })
    completeChild(world, "ses_a", "done late", prompts[0].body.messageID)
    await idleEvent(hooks, "ses_a")
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)

    // Same shape again, but the wait consumes the completion this time.
    world.messages.set("ses_a", [])
    world.status.ses_a = { type: "busy" }
    const before = prompts.length
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "more work",
      wait: false,
    })
    const pending = call(hooks, "subagent_wait", ctx, {})
    await Bun.sleep(20)
    completeChild(world, "ses_a", "done again", prompts[before].body.messageID)
    await idleEvent(hooks, "ses_a")
    const result = await pending
    expect(result.output).toContain("done again")
    await Bun.sleep(100)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)
  })

  test("validates explicit targets; an explicit idle target is answered, not brushed off", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", { id: "ses_a", parentID: "ses_parent" })
    world.sessions.set("ses_b", { id: "ses_b", parentID: "ses_parent" })
    world.messages.set("ses_b", [
      {
        info: {
          id: "msg_b_user",
          role: "user",
          sessionID: "ses_b",
          time: { created: 1 },
        },
        parts: [],
      },
      {
        info: {
          id: "msg_b_reply",
          role: "assistant",
          parentID: "msg_b_user",
          sessionID: "ses_b",
          time: { created: 2, completed: 3 },
        },
        parts: [{ type: "text", text: "already done" }],
      },
    ])
    const { client } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()
    expect(
      call(hooks, "subagent_wait", ctx, { session_ids: ["ses_missing"] }),
    ).rejects.toThrow(/not one of this session's subagents/)
    // An idle explicit target with a completed reply returns it — the recovery
    // path for a timed-out or aborted send (and the only collection path with
    // notify:false). One that never replied says so instead.
    const result = await call(hooks, "subagent_wait", ctx, {
      session_ids: ["ses_a", "ses_b"],
    })
    expect(result.output).toContain("None of those subagents are busy")
    expect(result.output).toContain('<task id="ses_b" state="completed">')
    expect(result.output).toContain("already done")
    expect(result.output).toContain("- ses_a went idle without a new reply")
    expect(result.metadata).toMatchObject({
      waited: ["ses_a", "ses_b"],
      stillBusy: [],
    })
    // The DEFAULT selection still filters to busy children only.
    const idle = await call(hooks, "subagent_wait", ctx, {})
    expect(idle.output).toContain("Nothing to wait for")
  })

  test("an explicit wait on an already-idle child consumes its pending note", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_a", [])
    world.status.ses_a = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "work",
      wait: false,
    })
    // The child finishes, but nothing has settled it yet (no events, poller
    // parked): the pending note is still registered when the wait arrives.
    completeChild(world, "ses_a", "done late", prompts[0].body.messageID)
    const result = await call(hooks, "subagent_wait", ctx, {
      session_ids: ["ses_a"],
    })
    expect(result.output).toContain("done late")
    expect(result.metadata).toMatchObject({ waited: ["ses_a"], stillBusy: [] })
    // The wait result was the delivery; the parked note must not fire too.
    await idleEvent(hooks, "ses_a")
    await Bun.sleep(100)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(0)
  })

  test("surfaces a status-endpoint failure instead of returning nothing-to-wait-for", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", { id: "ses_a", parentID: "ses_parent" })
    const { client } = makeClient(world)
    ;(client.session as any).status = () =>
      Promise.resolve({ error: { name: "boom" } })
    const hooks = await load(client)
    const { ctx } = makeCtx()
    expect(call(hooks, "subagent_wait", ctx, {})).rejects.toThrow(
      /reading subagent status failed/,
    )
  })

  test("a status-endpoint blip does not settle a wait with a stale reply", async () => {
    const world = makeWorld()
    // A busy child whose transcript already holds an OLD completed reply.
    world.sessions.set("ses_child", {
      id: "ses_child",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_child", [
      {
        info: {
          id: "msg_b_user",
          role: "user",
          sessionID: "ses_child",
          time: { created: 1 },
        },
        parts: [],
      },
      {
        info: {
          id: "msg_c_0",
          role: "assistant",
          parentID: "msg_b_user",
          sessionID: "ses_child",
          time: { created: 1, completed: 2 },
        },
        parts: [{ type: "text", text: "earlier reply" }],
      },
    ])
    world.status.ses_child = { type: "busy" }
    const { client } = makeClient(world)
    const origStatus = (client.session as any).status.bind(client.session)
    const hooks = await load(client, { pollIntervalMs: 100 })
    const { ctx } = makeCtx()
    const pending = call(hooks, "subagent_wait", ctx, {
      session_ids: ["ses_child"],
    })
    await Bun.sleep(20) // the waiter is registered
    let settled = false
    void pending.then(() => (settled = true))

    // Status fails right as an idle event tries to settle, with the child not in
    // the busy-event cache (the idle event clears it first).
    ;(client.session as any).status = () =>
      Promise.resolve({ error: { name: "boom" } })
    await idleEvent(hooks, "ses_child")
    await Bun.sleep(60)
    // Fabricating idle here would have returned the stale "earlier reply".
    expect(settled).toBe(false)

    // Status recovers; the child was genuinely still busy, so the wait holds...
    ;(client.session as any).status = origStatus
    await Bun.sleep(150)
    expect(settled).toBe(false)
    // ...until a real completion arrives.
    completeChild(world, "ses_child", "fresh reply")
    await idleEvent(hooks, "ses_child")
    const result = await pending
    expect(result.output).toContain("fresh reply")
    expect(result.output).not.toContain("earlier reply")
  })

  test("a run that goes idle without new text reports ended, not a previous run's reply", async () => {
    const world = makeWorld()
    // A busy child whose transcript holds an OLD completed reply, then a NEWER
    // user message that triggered the run in flight now.
    world.sessions.set("ses_child", {
      id: "ses_child",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_child", [
      {
        info: {
          id: "msg_a_user",
          role: "user",
          sessionID: "ses_child",
          time: { created: 1 },
        },
        parts: [{ type: "text", text: "old q" }],
      },
      {
        info: {
          id: "msg_b_reply",
          role: "assistant",
          parentID: "msg_a_user",
          sessionID: "ses_child",
          time: { created: 2, completed: 3 },
        },
        parts: [{ type: "text", text: "OLD ANSWER" }],
      },
      {
        info: {
          id: "msg_c_user",
          role: "user",
          sessionID: "ses_child",
          time: { created: 4 },
        },
        parts: [{ type: "text", text: "new q" }],
      },
    ])
    world.status.ses_child = { type: "busy" }
    const { client } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    const pending = call(hooks, "subagent_wait", ctx, {
      session_ids: ["ses_child"],
    })
    await Bun.sleep(20) // the watermark (newest user message) is captured here
    // The in-flight run ends without producing any new reply.
    delete world.status.ses_child
    await idleEvent(hooks, "ses_child")
    await Bun.sleep(GRACE_SPACING_MS + 100)
    await idleEvent(hooks, "ses_child")
    const result = await pending
    // Watermarking to the newest user message excludes the older reply.
    expect(result.output).toContain("went idle without a new reply")
    expect(result.output).not.toContain("OLD ANSWER")
    expect(result.metadata).toMatchObject({
      waited: ["ses_child"],
      stillBusy: [],
    })
  })

  test.each(["spawn", "send", "task"] as const)(
    "the first wait recovers an already-aged-out %s anchor",
    async (source) => {
      const world = makeWorld()
      const { client, prompts, messageCalls, statusSignals } = makeClient(world)
      const hooks = await load(client, { pollIntervalMs: 30_000 })
      const { ctx } = makeCtx()
      let childID = "ses_stock_child"
      let anchor = hostMessageID(Date.now(), 0)
      if (source === "spawn") {
        const spawned = await call(hooks, "subagent_spawn", ctx, {
          description: "long-running child",
          prompt: "work",
          subagent_type: "general",
        })
        childID = spawned.metadata?.sessionId
        anchor = prompts[0].body.messageID
      } else {
        // Stock task children have only session lineage, no plugin registration.
        world.sessions.set(childID, {
          id: childID,
          parentID: "ses_parent",
          agent: "general",
        })
        if (source === "send") {
          await call(hooks, "subagent_send", ctx, {
            session_id: childID,
            message: "work",
            wait: false,
          })
          anchor = prompts[0].body.messageID
        } else {
          world.messages.set(childID, [
            {
              info: { id: anchor, role: "user", sessionID: childID },
              parts: [],
            },
          ])
        }
      }
      world.status[childID] = { type: "busy" }
      appendAssistantSteps(world, childID, anchor)
      expect(
        world.messages
          .get(childID)
          ?.slice(-50)
          .every((message) => message.info.role === "assistant"),
      ).toBe(true)
      const exactRead = spyOn(client.session, "message")
      const statusReads = statusSignals.length
      let finished = false
      const pending = call(hooks, "subagent_wait", ctx, {
        session_ids: [childID],
        timeout_ms: 5_000,
      }).finally(() => {
        finished = true
      })
      void pending.catch(() => {})
      await until(() => finished || statusSignals.length >= statusReads + 2)
      expect(finished).toBe(false)
      expect(exactRead).toHaveBeenCalledTimes(source === "task" ? 1 : 0)
      if (source === "task") {
        expect(exactRead.mock.calls[0]?.[0]).toMatchObject({
          path: { id: childID, messageID: anchor },
          query: { directory: DIRECTORY },
          signal: expect.any(AbortSignal),
        })
      }
      expect(
        messageCalls
          .filter((input) => input.path.id === childID)
          .every((input) => input.query.limit === 50),
      ).toBe(true)

      completeChild(
        world,
        childID,
        "FRESH ANSWER",
        anchor,
        hostMessageID(Date.now() + 100, 0),
      )
      await idleEvent(hooks, childID)
      const result = await pending
      expect(result.output).toContain("FRESH ANSWER")
      expect(result.metadata).toMatchObject({
        waited: [childID],
        stillBusy: [],
      })
      await idleEvent(hooks, childID)
      expect(
        prompts.filter((prompt) => prompt.path.id === "ses_parent"),
      ).toHaveLength(0)
    },
  )

  test.each([false, true])(
    "an aged-out newer run excludes an older reply (old anchor tracked: %s)",
    async (tracked) => {
      const realNow = Date.now.bind(Date)
      let skew = 0
      const clock = spyOn(Date, "now").mockImplementation(
        () => realNow() + skew,
      )
      try {
        const world = makeWorld()
        const childID = "ses_child"
        world.sessions.set(childID, {
          id: childID,
          parentID: "ses_parent",
          agent: "general",
        })
        const { client, prompts, messageCalls, statusSignals } =
          makeClient(world)
        const hooks = await load(client, { pollIntervalMs: 30_000 })
        const { ctx } = makeCtx()
        let oldAnchor = hostMessageID(Date.now() - 2, 0)
        if (tracked) {
          await call(hooks, "subagent_send", ctx, {
            session_id: childID,
            message: "old work",
            wait: false,
          })
          oldAnchor = prompts[0].body.messageID
        }
        completeChild(world, childID, "OLD ANSWER", oldAnchor)
        const currentAnchor = hostMessageID(Date.now() + 1, 0)
        world.messages.get(childID)?.push({
          info: { id: currentAnchor, role: "user", sessionID: childID },
          parts: [],
        })
        appendAssistantSteps(world, childID, currentAnchor)
        // A larger assistant ID must not hide the newer parent elsewhere in the tail.
        completeChild(
          world,
          childID,
          "OLD LATE ANSWER",
          oldAnchor,
          hostMessageID(Date.now() + 100, 0),
        )
        world.status[childID] = { type: "busy" }
        const exactRead = spyOn(client.session, "message")
        const statusReads = statusSignals.length
        const pending = call(hooks, "subagent_wait", ctx, {
          session_ids: [childID],
        })
        await until(() => statusSignals.length >= statusReads + 2)
        expect(exactRead).toHaveBeenCalledTimes(1)
        expect(exactRead.mock.calls[0]?.[0].path.messageID).toBe(currentAnchor)

        delete world.status[childID]
        let reads = messageCalls.length
        await idleEvent(hooks, childID)
        await until(() => messageCalls.length > reads)
        skew += GRACE_SPACING_MS + 1
        reads = messageCalls.length
        await idleEvent(hooks, childID)
        await until(() => messageCalls.length > reads)
        const result = await pending
        expect(result.output).toContain("went idle without a new reply")
        expect(result.output).not.toContain("OLD")
        expect(result.metadata).toMatchObject({
          waited: [childID],
          stillBusy: [],
        })
        expect(
          prompts.filter((prompt) => prompt.path.id === "ses_parent"),
        ).toHaveLength(0)
      } finally {
        clock.mockRestore()
      }
    },
  )

  test.each([
    "missing-parent",
    "missing-user",
    "wrong-role",
    "wrong-id",
    "wrong-session",
    "transport-error",
  ] as const)(
    "an aged-out watermark fails closed on %s without trying an older parent",
    async (failure) => {
      const world = makeWorld()
      const childID = "ses_stock_child"
      const anchor = hostMessageID(Date.now(), 0)
      world.sessions.set(childID, { id: childID, parentID: "ses_parent" })
      completeChild(
        world,
        childID,
        "OLD ANSWER",
        hostMessageID(Date.now() - 2, 0),
      )
      world.messages.get(childID)?.push({
        info: { id: anchor, role: "user", sessionID: childID },
        parts: [],
      })
      appendAssistantSteps(world, childID, anchor, 49)
      // Keep an older completed reply in the tail as a tempting unsafe fallback.
      const olderReply = world.messages.get(childID)?.[1]
      if (olderReply) {
        olderReply.info.id = hostMessageID(Date.now() + 100, 0)
        world.messages.get(childID)?.push(olderReply)
      }
      if (failure === "missing-parent") {
        for (const message of world.messages.get(childID) ?? []) {
          if (message.info.role === "assistant") delete message.info.parentID
        }
      }
      world.status[childID] = { type: "busy" }
      const { client, prompts } = makeClient(world)
      const exactRead = spyOn(client.session, "message").mockImplementation(
        () => {
          if (failure === "transport-error")
            return Promise.reject(new Error("transport failed"))
          if (failure === "missing-user")
            return Promise.resolve({ error: { name: "NotFoundError" } })
          return Promise.resolve({
            data: {
              info: {
                id: failure === "wrong-id" ? "msg_wrong" : anchor,
                role: failure === "wrong-role" ? "assistant" : "user",
                sessionID:
                  failure === "wrong-session" ? "ses_foreign" : childID,
              },
              parts: [],
            },
          })
        },
      )
      const hooks = await load(client, { pollIntervalMs: 30_000 })
      await expect(
        call(hooks, "subagent_wait", makeCtx().ctx, { session_ids: [childID] }),
      ).rejects.toThrow(
        /Could not establish a reply watermark.*no completions were collected/,
      )
      expect(exactRead).toHaveBeenCalledTimes(
        failure === "missing-parent" ? 0 : 1,
      )
      if (failure !== "missing-parent")
        expect(exactRead.mock.calls[0]?.[0].path.messageID).toBe(anchor)
      expect(prompts).toHaveLength(0)
    },
  )

  test.each(["timeout", "abort", "dispose"] as const)(
    "%s cancels exact watermark recovery and does not consume other claims",
    async (stop) => {
      const world = makeWorld()
      const { client, prompts, statusSignals } = makeClient(world)
      const hooks = await load(client, {
        pollIntervalMs: 30_000,
        injectConfirmTimeoutMs: 250,
      })
      const { ctx, controller } = makeCtx()
      const spawned = await call(hooks, "subagent_spawn", ctx, {
        description: "tracked child",
        prompt: "work",
        subagent_type: "general",
      })
      const trackedID = spawned.metadata?.sessionId as string
      world.status[trackedID] = { type: "busy" }
      const stockID = "ses_stock_child"
      const stockAnchor = hostMessageID(Date.now(), 0)
      world.sessions.set(stockID, { id: stockID, parentID: "ses_parent" })
      world.status[stockID] = { type: "busy" }
      appendAssistantSteps(world, stockID, stockAnchor)
      let signal: AbortSignal | undefined
      const exactRead = spyOn(client.session, "message").mockImplementation(
        (input: any) => {
          signal = input.signal
          // Deliberately ignore cancellation: the deadline must bound the tool too.
          return new Promise(() => {})
        },
      )
      const pending = call(hooks, "subagent_wait", ctx, {
        session_ids: [trackedID, stockID],
      })
      void pending.catch(() => {})
      await until(() => signal !== undefined)
      if (stop === "abort") controller.abort()
      if (stop === "dispose") await hooks.dispose?.()
      await expect(pending).rejects.toThrow(
        stop === "abort"
          ? WAIT_ABORTED_MESSAGE
          : stop === "dispose"
            ? "disposed"
            : "Could not establish a reply watermark",
      )
      expect(signal?.aborted).toBe(true)
      expect(exactRead).toHaveBeenCalledTimes(1)
      exactRead.mockRestore()
      expect(
        prompts.filter((prompt) => prompt.path.id === "ses_parent"),
      ).toHaveLength(0)

      if (stop !== "dispose") {
        completeChild(
          world,
          trackedID,
          "RESTORED ANSWER",
          prompts[0].body.messageID,
        )
        await Promise.all([
          idleEvent(hooks, trackedID),
          idleEvent(hooks, trackedID),
        ])
        await until(() =>
          prompts.some((prompt) => prompt.path.id === "ses_parent"),
        )
        await idleEvent(hooks, trackedID)
        const notes = prompts.filter(
          (prompt) => prompt.path.id === "ses_parent",
        )
        expect(notes).toHaveLength(1)
        expect(notes[0].body.parts[0].text).toContain("RESTORED ANSWER")
      } else {
        const reads = statusSignals.length
        await idleEvent(hooks, trackedID)
        expect(statusSignals).toHaveLength(reads)
      }
    },
  )

  test.each([
    "missing-parent",
    "null",
    "non-array",
    "invalid-message",
  ] as const)(
    "a tracked anchor cannot hide a %s transcript failure",
    async (failure) => {
      const world = makeWorld()
      const { client, prompts } = makeClient(world)
      const hooks = await load(client, { pollIntervalMs: 30_000 })
      const { ctx } = makeCtx()
      const spawned = await call(hooks, "subagent_spawn", ctx, {
        description: "tracked child",
        prompt: "work",
        subagent_type: "general",
      })
      const childID = spawned.metadata?.sessionId as string
      world.status[childID] = { type: "busy" }
      const malformed =
        failure === "null"
          ? null
          : failure === "non-array"
            ? {}
            : [
                {
                  info: {
                    id: hostMessageID(Date.now() + 1, 0),
                    role:
                      failure === "missing-parent" ? "assistant" : "invalid",
                    sessionID: childID,
                  },
                  parts: [],
                },
              ]
      const transcript = spyOn(
        client.session as any,
        "messages",
      ).mockResolvedValue({ data: malformed })
      await expect(
        call(hooks, "subagent_wait", ctx, { session_ids: [childID] }),
      ).rejects.toThrow("Could not establish a reply watermark")
      transcript.mockRestore()
      completeChild(
        world,
        childID,
        "RESTORED ANSWER",
        prompts[0].body.messageID,
      )
      await idleEvent(hooks, childID)
      await until(() =>
        prompts.some((prompt) => prompt.path.id === "ses_parent"),
      )
      await idleEvent(hooks, childID)
      expect(
        prompts.filter((prompt) => prompt.path.id === "ses_parent"),
      ).toHaveLength(1)
    },
  )

  test.each(["unconfirmed", "confirmed", "superseded"])(
    "reused %s anchor visibility survives restoration",
    async (state) => {
      const confirmed = state !== "unconfirmed"
      const realNow = Date.now.bind(Date)
      let skew = 0
      const clock = spyOn(Date, "now").mockImplementation(
        () => realNow() + skew,
      )
      try {
        const world = makeWorld()
        const { client, prompts, messageCalls, statusSignals } =
          makeClient(world)
        const messages = client.session.messages.bind(client.session)
        const transcript = spyOn(client.session, "messages").mockImplementation(
          (input: any) =>
            input.path.id === "ses_parent"
              ? messages(input)
              : Promise.reject(new Error("transient")),
        )
        const prompt = spyOn(client.session, "promptAsync").mockImplementation(
          (input: any) => {
            prompts.push(input)
            return Promise.reject(new Error("response lost"))
          },
        )
        const hooks = await load(client, { pollIntervalMs: 30_000 })
        const { ctx, controller } = makeCtx()
        const spawned = await call(hooks, "subagent_spawn", ctx, {
          description: "unconfirmed child",
          prompt: "work",
          subagent_type: "general",
        })
        const childID = spawned.metadata?.sessionId as string
        expect(spawned.output).toContain("unconfirmed")
        transcript.mockRestore()
        prompt.mockRestore()
        const anchor = prompts[0].body.messageID
        if (confirmed)
          world.messages.set(childID, [
            {
              info: { id: anchor, role: "user", sessionID: childID },
              parts: [],
            },
          ])
        const currentAnchor =
          state === "superseded" ? hostMessageID(Date.now() + 1, 0) : anchor
        if (state === "superseded")
          world.messages.get(childID)?.push({
            info: { id: currentAnchor, role: "user", sessionID: childID },
            parts: [],
          })
        world.status[childID] = { type: "busy" }
        const statusReads = statusSignals.length
        let finished = false
        const pending = call(hooks, "subagent_wait", ctx, {
          session_ids: [childID],
          timeout_ms: confirmed ? 1_000 : 5_000,
        }).finally(() => {
          finished = true
        })
        void pending.catch(() => {})
        await until(() => finished || statusSignals.length >= statusReads + 2)
        expect(finished).toBe(false)
        if (confirmed) {
          expect((await pending).metadata?.stillBusy).toEqual([childID])
          appendAssistantSteps(world, childID, currentAnchor)
        }
        delete world.status[childID]
        for (let index = 0; index < 2; index++) {
          skew += GRACE_SPACING_MS + 1
          const reads = messageCalls.length
          await idleEvent(hooks, childID)
          await until(() => messageCalls.length > reads)
        }
        if (confirmed) {
          await until(() =>
            prompts.some((prompt) => prompt.path.id === "ses_parent"),
          )
          const notes = prompts.filter(
            (prompt) => prompt.path.id === "ses_parent",
          )
          expect(notes).toHaveLength(1)
          expect(notes[0].body.parts[0].text).toContain(
            "without producing a new reply",
          )
        } else {
          expect(finished).toBe(false)
          controller.abort()
          await expect(pending).rejects.toThrow(WAIT_ABORTED_MESSAGE)
          await idleEvent(hooks, childID)
          expect(
            prompts.filter((prompt) => prompt.path.id === "ses_parent"),
          ).toHaveLength(0)
        }
      } finally {
        clock.mockRestore()
      }
    },
  )

  test("a failed initial watermark read refuses a stale reply and restores the claimed note", async () => {
    const world = makeWorld()
    const oldUserID = hostMessageID(Date.now() - 2, 0)
    const oldReplyID = hostMessageID(Date.now() - 1, 0)
    world.sessions.set("ses_child", {
      id: "ses_child",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_child", [
      {
        info: {
          id: oldUserID,
          role: "user",
          sessionID: "ses_child",
          time: { created: 1 },
        },
        parts: [],
      },
      {
        info: {
          id: oldReplyID,
          role: "assistant",
          parentID: oldUserID,
          sessionID: "ses_child",
          time: { created: 2, completed: 3 },
        },
        parts: [{ type: "text", text: "OLD ANSWER" }],
      },
    ])
    world.status.ses_child = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, {
      maxBusyChildren: 1,
      pollIntervalMs: 30_000,
    })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "current work",
      wait: false,
    })
    const currentMessageID = prompts[0].body.messageID

    const messages = (client.session as any).messages.bind(client.session)
    let failWatermark = true
    ;(client.session as any).messages = (input: any) => {
      if (input.path.id === "ses_child" && failWatermark) {
        failWatermark = false
        return Promise.resolve({ error: { name: "transient" } })
      }
      return messages(input)
    }
    await expect(
      call(hooks, "subagent_wait", ctx, { session_ids: ["ses_child"] }),
    ).rejects.toThrow(
      /Could not establish a reply watermark.*no completions were collected.*Retry subagent_wait/,
    )

    // The child is idle, so only the restored note can still occupy this slot.
    delete world.status.ses_child
    await expect(
      call(hooks, "subagent_spawn", ctx, {
        description: "must stay blocked",
        prompt: "go",
        subagent_type: "general",
      }),
    ).rejects.toThrow(/already has 1 subagents working/)

    completeChild(world, "ses_child", "FRESH ANSWER", currentMessageID)
    await Promise.all([
      idleEvent(hooks, "ses_child"),
      idleEvent(hooks, "ses_child"),
    ])
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    await Bun.sleep(100)
    const notes = prompts.filter((prompt) => prompt.path.id === "ses_parent")
    expect(notes).toHaveLength(1)
    expect(notes[0].body.parts[0].text).toContain("FRESH ANSWER")
    expect(notes[0].body.parts[0].text).not.toContain("OLD ANSWER")

    // Confirmed delivery consumes the restored note and releases the slot.
    const spawned = await call(hooks, "subagent_spawn", ctx, {
      description: "slot released",
      prompt: "go",
      subagent_type: "general",
    })
    expect(spawned.metadata?.sessionId).toBe("ses_child_1")
  })

  test("a captured wait watermark outside the bounded message window ends without a stale reply", async () => {
    const realNow = Date.now.bind(Date)
    let skew = 0
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew)
    try {
      const world = makeWorld()
      const oldUserID = hostMessageID(Date.now() - 2, 0)
      const anchor = hostMessageID(Date.now(), 0)
      world.sessions.set("ses_child", {
        id: "ses_child",
        parentID: "ses_parent",
        agent: "general",
      })
      world.messages.set("ses_child", [
        {
          info: {
            id: oldUserID,
            role: "user",
            sessionID: "ses_child",
            time: { created: Date.now() - 2 },
          },
          parts: [],
        },
        {
          info: {
            id: hostMessageID(Date.now() - 1, 0),
            role: "assistant",
            parentID: oldUserID,
            sessionID: "ses_child",
            time: { created: Date.now() - 1, completed: Date.now() - 1 },
          },
          parts: [{ type: "text", text: "OLD ANSWER" }],
        },
        {
          info: {
            id: anchor,
            role: "user",
            sessionID: "ses_child",
            time: { created: Date.now() },
          },
          parts: [],
        },
      ])
      world.status.ses_child = { type: "busy" }
      const { client, messageCalls, statusSignals } = makeClient(world)
      const hooks = await load(client, { pollIntervalMs: 30_000 })
      const { ctx } = makeCtx()
      const pending = call(hooks, "subagent_wait", ctx, {
        session_ids: ["ses_child"],
        timeout_ms: 5_000,
      })
      await until(() => messageCalls.length >= 1 && statusSignals.length >= 2)

      const childCalls = messageCalls.filter(
        (input) => input.path.id === "ses_child",
      )
      const limit = childCalls.at(-1)?.query?.limit
      expect(limit).toBeGreaterThan(0)
      appendNewerUserMessages(world, "ses_child", limit)
      expect(
        (world.messages.get("ses_child") ?? [])
          .slice(-limit)
          .some((message) => message.info.id === anchor),
      ).toBe(false)

      delete world.status.ses_child
      let reads = messageCalls.length
      await idleEvent(hooks, "ses_child")
      await until(() => messageCalls.length > reads)
      skew += GRACE_SPACING_MS + 1
      reads = messageCalls.length
      await idleEvent(hooks, "ses_child")
      await until(() => messageCalls.length > reads)

      const result = await pending
      expect(result.output).toContain("went idle without a new reply")
      expect(result.output).not.toContain("OLD ANSWER")
      expect(result.metadata).toMatchObject({
        waited: ["ses_child"],
        stillBusy: [],
      })
    } finally {
      clock.mockRestore()
    }
  })
})

describe("busy-state resolution", () => {
  function withIdleChild(world: World) {
    world.sessions.set("ses_child", {
      id: "ses_child",
      parentID: "ses_parent",
      agent: "general",
      model: { providerID: "anthropic", id: "claude-x", variant: "default" },
    })
    world.messages.set("ses_child", [])
  }

  test("a stale busy-cache (missed idle event) still reads idle from the authoritative endpoint", async () => {
    const world = makeWorld()
    withIdleChild(world)
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    // A busy status event caches the child busy, but its idle event is missed,
    // so the endpoint (world.status) legitimately shows idle. A send must trust
    // the endpoint: idle ordering (counter 0), not the stale busy-steer counter.
    await hooks.event?.({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_child", status: { type: "busy" } },
      } as any,
    })
    const result = await call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "hi",
      wait: false,
    })
    expect(result.metadata).toMatchObject({ wasBusy: false })
    expect(counterOf(prompts[0].body.messageID)).toBe(0)
  })

  test("an unreadable status endpoint errs toward busy, never idle", async () => {
    const world = makeWorld()
    withIdleChild(world)
    const { client, prompts } = makeClient(world)
    ;(client.session as any).status = () =>
      Promise.resolve({ error: { name: "boom" } })
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    // Unknown busy-state must not read as idle: were it to, a genuinely-busy
    // steer would use idle ordering and risk being dropped as already-answered.
    const result = await call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "steer",
      wait: false,
    })
    expect(result.metadata).toMatchObject({ wasBusy: true })
    expect(counterOf(prompts[0].body.messageID)).toBe(0xfff)
  })
})

describe("completion settlement", () => {
  test("racing completion signals deliver the note exactly once", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_a", [])
    world.status.ses_a = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "work",
      wait: false,
    })
    completeChild(world, "ses_a", "done", prompts[0].body.messageID)
    // A status event, an idle event, and a second idle event all observe the
    // same completion concurrently; the settles must serialize.
    await Promise.all([
      idleEvent(hooks, "ses_a"),
      idleEvent(hooks, "ses_a"),
      hooks.event?.({
        event: {
          type: "session.status",
          properties: { sessionID: "ses_a", status: { type: "idle" } },
        } as any,
      }),
    ])
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    await Bun.sleep(100)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)
  })

  test("a whole-server hiccup on both endpoints defers, then delivers the note exactly once", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_a", [])
    world.status.ses_a = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const origStatus = (client.session as any).status.bind(client.session)
    const origMessages = (client.session as any).messages.bind(client.session)
    const hooks = await load(client, { pollIntervalMs: 80 })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "work",
      wait: false,
    })
    completeChild(world, "ses_a", "done", prompts[0].body.messageID)

    // Status AND messages both fail for several ticks; each settle attempt must
    // defer (F2/F3), never fabricate idle or a deletion, and never deliver.
    ;(client.session as any).status = () =>
      Promise.resolve({ error: { name: "boom" } })
    ;(client.session as any).messages = () =>
      Promise.resolve({ error: { name: "boom" } })
    await idleEvent(hooks, "ses_a")
    await idleEvent(hooks, "ses_a")
    await Bun.sleep(200)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(0)

    // Recovery: the poller settles it and the note lands exactly once.
    ;(client.session as any).status = origStatus
    ;(client.session as any).messages = origMessages
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    await Bun.sleep(200)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)
  })

  test("an aborted blocking send revives the note it parked", async () => {
    const world = makeWorld()
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx, controller } = makeCtx()
    await call(hooks, "subagent_spawn", ctx, {
      description: "audit configs",
      prompt: "Audit.",
      subagent_type: "general",
    })
    world.status.ses_child_1 = { type: "busy" }
    await Bun.sleep(5) // the send's minted id lands in a later millisecond than the spawn's
    const pending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child_1",
      message: "status?",
    })
    await until(() => prompts.length === 2)
    controller.abort()
    await expect(pending).rejects.toThrow(SEND_ABORTED_MESSAGE)
    // The spawn's note is live again: completion still reaches the parent, once.
    completeChild(
      world,
      "ses_child_1",
      "all audited",
      prompts[1].body.messageID,
    )
    await idleEvent(hooks, "ses_child_1")
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    await Bun.sleep(100)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)
  })

  test("a note whose parent identity can't be read is not injected blind, and is retried", async () => {
    const world = makeWorld()
    const { client, prompts, logs } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 100 })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_spawn", ctx, {
      description: "audit",
      prompt: "go",
      subagent_type: "general",
    })
    world.status.ses_child_1 = { type: "busy" }
    const minted = prompts[0].body.messageID
    // The parent's identity read fails as the child finishes. Prompting blind
    // would re-pin the parent onto the default agent and strip its variant, so
    // nothing must be injected — and the completion must not be lost.
    const origGet = (client.session as any).get.bind(client.session)
    ;(client.session as any).get = (input: any) =>
      input.path.id === "ses_parent"
        ? Promise.resolve({ error: { name: "boom" } })
        : origGet(input)
    completeChild(world, "ses_child_1", "audited", minted)
    await idleEvent(hooks, "ses_child_1")
    await Bun.sleep(80)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(0)
    const retryLog = logs.find((entry) =>
      entry.body.message.includes("will retry completion notification"),
    )
    expect(retryLog.body.message).toContain("notification unassigned")

    // Identity read recovers; the poller retries and the note lands once, WITH
    // the parent's own pinned identity echoed back.
    ;(client.session as any).get = origGet
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    await Bun.sleep(200)
    const notes = prompts.filter((prompt) => prompt.path.id === "ses_parent")
    expect(notes).toHaveLength(1)
    expect(notes[0].body).toMatchObject({
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-x" },
      variant: "max",
    })
    expect(notes[0].body.messageID).toMatch(/^msg_/)
    expect(notes[0].body.parts[0].text).toContain("audited")
  })

  test("an incomplete readable parent identity fails terminally without pointless retries", async () => {
    const world = makeWorld()
    const { client, prompts, logs, toasts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 100 })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_spawn", ctx, {
      description: "audit",
      prompt: "go",
      subagent_type: "general",
    })
    const minted = prompts[0].body.messageID
    const parent = world.sessions.get("ses_parent")
    if (!parent) throw new Error("expected parent fixture")
    delete parent.agent

    completeChild(world, "ses_child_1", "audited", minted)
    await idleEvent(hooks, "ses_child_1")
    await until(() =>
      logs.some((entry) => {
        const message = String(entry.body.message)
        return (
          message.includes("is terminal") ||
          message.includes("will retry completion notification")
        )
      }),
    )

    expect(
      logs.some((entry) =>
        entry.body.message.includes("will retry completion notification"),
      ),
    ).toBe(false)
    expect(
      logs.some(
        (entry) =>
          entry.body.level === "error" &&
          entry.body.message.includes("is terminal") &&
          entry.body.message.includes("no complete pinned agent/model"),
      ),
    ).toBe(true)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(0)
    const listed = await call(hooks, "subagent_list", ctx, {})
    expect(listed.output).toContain("completion notification terminal")
    expect(listed.metadata?.notificationIssues).toBe(1)
    expect(
      toasts.find((entry) => entry.body.message.includes("terminal"))?.body
        .variant,
    ).toBe("error")
  })

  test("a transient injection failure requeues the note instead of losing it", async () => {
    const world = makeWorld()
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 100 })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_spawn", ctx, {
      description: "audit",
      prompt: "go",
      subagent_type: "general",
    })
    world.status.ses_child_1 = { type: "busy" }
    const minted = prompts[0].body.messageID
    // The parent injection fails once (transient), then succeeds on retry.
    const origPrompt = (client.session as any).promptAsync.bind(client.session)
    let failParentOnce = true
    ;(client.session as any).promptAsync = (input: any) => {
      if (input.path.id === "ses_parent" && failParentOnce) {
        failParentOnce = false
        return Promise.resolve({ error: { name: "boom" } })
      }
      return origPrompt(input)
    }
    completeChild(world, "ses_child_1", "audited", minted)
    await idleEvent(hooks, "ses_child_1")
    // The first attempt threw; the poller retries and it lands exactly once.
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    await Bun.sleep(200)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)
  })

  test("accepted parent delivery with a lost response produces exactly one prompt across settle cycles", async () => {
    const world = makeWorld()
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, {
      injectConfirmTimeoutMs: 250,
      pollIntervalMs: 250,
    })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_spawn", ctx, {
      description: "audit",
      prompt: "go",
      subagent_type: "general",
    })
    const childMessageID = prompts[0].body.messageID
    const promptAsync = (client.session as any).promptAsync.bind(client.session)
    ;(client.session as any).promptAsync = async (input: any) => {
      const result = await promptAsync(input)
      if (input.path.id === "ses_parent") throw new Error("response lost")
      return result
    }

    completeChild(world, "ses_child_1", "audited", childMessageID)
    await idleEvent(hooks, "ses_child_1")
    await until(
      () =>
        prompts.filter((prompt) => prompt.path.id === "ses_parent").length ===
        1,
    )
    await idleEvent(hooks, "ses_child_1")
    await idleEvent(hooks, "ses_child_1")
    await Bun.sleep(600)

    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)
  })

  test("ambiguous parent delivery is parked and never reinjected", async () => {
    const world = makeWorld()
    const { client, prompts, logs, toasts } = makeClient(world)
    const hooks = await load(client, {
      injectConfirmTimeoutMs: 30_000,
      pollIntervalMs: 250,
    })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_spawn", ctx, {
      description: "audit",
      prompt: "go",
      subagent_type: "general",
    })
    const childMessageID = prompts[0].body.messageID
    const promptAsync = (client.session as any).promptAsync.bind(client.session)
    const messages = (client.session as any).messages.bind(client.session)
    ;(client.session as any).promptAsync = (input: any) => {
      if (input.path.id === "ses_parent") {
        prompts.push(input)
        return Promise.reject(new Error("response lost"))
      }
      return promptAsync(input)
    }
    ;(client.session as any).messages = (input: any) =>
      input.path.id === "ses_parent"
        ? Promise.reject(new Error("visibility unavailable"))
        : messages(input)

    completeChild(world, "ses_child_1", "audited", childMessageID)
    await idleEvent(hooks, "ses_child_1")
    await until(() =>
      logs.some((entry) => entry.body.message.includes("is ambiguous")),
    )
    const note = prompts.find((prompt) => prompt.path.id === "ses_parent")
    expect(note.body.messageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)

    await idleEvent(hooks, "ses_child_1")
    await idleEvent(hooks, "ses_child_1")
    await Bun.sleep(700)
    const notes = prompts.filter((prompt) => prompt.path.id === "ses_parent")
    expect(notes).toHaveLength(1)
    expect(notes[0].body.messageID).toBe(note.body.messageID)

    const listed = await call(hooks, "subagent_list", ctx, {})
    expect(listed.output).toContain("completion notification ambiguous")
    expect(listed.metadata?.notificationIssues).toBe(1)
    expect(
      toasts.find((entry) => entry.body.message.includes("ambiguous"))?.body
        .variant,
    ).toBe("warning")
  })

  test("a hung parent post and confirmation are bounded, then parked", async () => {
    const world = makeWorld()
    const { client, prompts, logs } = makeClient(world)
    const hooks = await load(client, {
      injectConfirmTimeoutMs: 250,
      pollIntervalMs: 250,
    })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_spawn", ctx, {
      description: "audit",
      prompt: "go",
      subagent_type: "general",
    })
    const childMessageID = prompts[0].body.messageID
    const promptAsync = (client.session as any).promptAsync.bind(client.session)
    ;(client.session as any).promptAsync = (input: any) => {
      if (input.path.id === "ses_parent") {
        prompts.push(input)
        return new Promise(() => {})
      }
      return promptAsync(input)
    }
    ;(client.session as any).message = (input: any) =>
      input.path.id === "ses_parent"
        ? new Promise(() => {})
        : Promise.resolve({ error: { name: "NotFoundError" } })

    completeChild(world, "ses_child_1", "audited", childMessageID)
    await idleEvent(hooks, "ses_child_1")
    await until(
      () =>
        logs.some(
          (entry) =>
            entry.body.message.includes("completion notification") &&
            entry.body.message.includes("is ambiguous"),
        ),
      2_000,
    )
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)
    const listed = await call(hooks, "subagent_list", ctx, {})
    expect(listed.output).toContain("completion notification ambiguous")
  })

  test("definitive parent rejection retries with bounded backoff and terminates visibly", async () => {
    const world = makeWorld()
    const { client, prompts, logs, toasts } = makeClient(world)
    const hooks = await load(client, {
      injectConfirmTimeoutMs: 250,
      pollIntervalMs: 250,
    })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_spawn", ctx, {
      description: "audit",
      prompt: "go",
      subagent_type: "general",
    })
    const childMessageID = prompts[0].body.messageID
    const promptAsync = (client.session as any).promptAsync.bind(client.session)
    const attemptedAt: number[] = []
    ;(client.session as any).promptAsync = (input: any) => {
      if (input.path.id === "ses_parent") {
        prompts.push(input)
        attemptedAt.push(Date.now())
        return Promise.resolve({ error: { name: "Rejected" } })
      }
      return promptAsync(input)
    }

    completeChild(world, "ses_child_1", "audited", childMessageID)
    await idleEvent(hooks, "ses_child_1")
    await until(() => attemptedAt.length === 1)
    await idleEvent(hooks, "ses_child_1")
    await idleEvent(hooks, "ses_child_1")
    await Bun.sleep(100)
    expect(attemptedAt).toHaveLength(1)

    await until(() => attemptedAt.length === 4)
    await Bun.sleep(600)
    await idleEvent(hooks, "ses_child_1")
    expect(attemptedAt).toHaveLength(4)
    expect(attemptedAt[1]! - attemptedAt[0]!).toBeGreaterThanOrEqual(200)
    expect(attemptedAt[2]! - attemptedAt[1]!).toBeGreaterThanOrEqual(450)
    expect(attemptedAt[3]! - attemptedAt[2]!).toBeGreaterThanOrEqual(900)

    const notes = prompts.filter((prompt) => prompt.path.id === "ses_parent")
    expect(new Set(notes.map((prompt) => prompt.body.messageID)).size).toBe(4)
    const listed = await call(hooks, "subagent_list", ctx, {})
    expect(listed.output).toContain("completion notification terminal")
    expect(listed.metadata?.notificationIssues).toBe(1)
    expect(
      logs.some(
        (entry) =>
          entry.body.level === "error" &&
          entry.body.message.includes("is terminal"),
      ),
    ).toBe(true)
    expect(
      toasts.find((entry) => entry.body.message.includes("terminal"))?.body
        .variant,
    ).toBe("error")
  })

  test("a completion for a genuinely-deleted parent is dropped, not retried forever", async () => {
    const world = makeWorld()
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_spawn", ctx, {
      description: "audit",
      prompt: "go",
      subagent_type: "general",
    })
    const minted = prompts[0].body.messageID
    // The parent vanished and its session.deleted event was missed: getSession
    // 404s. Retrying forever would leak the note, spin the poller, and peg a
    // busy-children slot — so the note is dropped after confirming missing.
    world.sessions.delete("ses_parent")
    completeChild(world, "ses_child_1", "audited", minted)
    await idleEvent(hooks, "ses_child_1")
    await Bun.sleep(80) // the failed delivery drops the note here

    // The parent "returns" (or was a transient blip all along). A re-settle
    // must NOT resurrect the note: a dropped completion stays dropped.
    world.sessions.set("ses_parent", {
      id: "ses_parent",
      agent: "build",
      model: { providerID: "anthropic", id: "claude-x", variant: "max" },
    })
    await idleEvent(hooks, "ses_child_1")
    await Bun.sleep(80)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(0)
  })
})

describe("WP5: claim restoration and delivery concurrency", () => {
  function seedIdleChild(world: World, id = "ses_a") {
    world.sessions.set(id, {
      id,
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set(id, [])
  }

  test("send-inject-failure restores the parked note so the child can still notify", async () => {
    const world = makeWorld()
    seedIdleChild(world, "ses_child")
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    // A working unwaited send first registers a pending completion note.
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "work",
      wait: false,
    })
    const minted = prompts[0].body.messageID
    const origPrompt = (client.session as any).promptAsync.bind(client.session)
    // Now a blocking send whose inject fails: it claims the note up front, then
    // its injectPrompt throws — the catch must restore the claimed note.
    ;(client.session as any).promptAsync = () =>
      Promise.resolve({ error: { name: "BadRequest" } })
    await expect(
      call(hooks, "subagent_send", ctx, {
        session_id: "ses_child",
        message: "status?",
      }),
    ).rejects.toThrow(/prompting session ses_child failed/)
    // The still-running child finishes; the restored note must reach the parent.
    ;(client.session as any).promptAsync = origPrompt
    completeChild(world, "ses_child", "answer", minted)
    await idleEvent(hooks, "ses_child")
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)
  })

  test("wait-abort restores every claimed note", async () => {
    const world = makeWorld()
    seedIdleChild(world, "ses_a")
    world.status.ses_a = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx, controller } = makeCtx()
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "work",
      wait: false,
    })
    const minted = prompts[0].body.messageID
    // A default wait claims ses_a's pending note up front, then is aborted.
    const pending = call(hooks, "subagent_wait", ctx, {})
    await Bun.sleep(20)
    controller.abort()
    await expect(pending).rejects.toThrow(WAIT_ABORTED_MESSAGE)
    // The child finishes; the restored claim must still reach the parent once.
    completeChild(world, "ses_a", "done", minted)
    await idleEvent(hooks, "ses_a")
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)
  })

  test("wait on an idle target whose transcript read fails restores the claim and reports retry", async () => {
    const world = makeWorld()
    seedIdleChild(world, "ses_a")
    world.status.ses_a = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "work",
      wait: false,
    })
    const minted = prompts[0].body.messageID
    // The child is now idle, but its transcript read fails during the wait.
    delete world.status.ses_a
    const origMessages = (client.session as any).messages.bind(client.session)
    ;(client.session as any).messages = (input: any) =>
      input.path.id === "ses_a"
        ? Promise.resolve({ error: { name: "boom" } })
        : origMessages(input)
    const result = await call(hooks, "subagent_wait", ctx, {
      session_ids: ["ses_a"],
    })
    // The renderer's fallback fires and the failed id is excluded from waited.
    expect(result.output).toContain("reading its latest reply failed just now")
    expect(result.metadata?.waited).not.toContain("ses_a")
    // The restored note still delivers once when the child truly completes.
    ;(client.session as any).messages = origMessages
    completeChild(world, "ses_a", "answer", minted)
    await idleEvent(hooks, "ses_a")
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)
  })

  test("a deleted parent's sweep drops only its own notes, not a live sibling parent's", async () => {
    const world = makeWorld()
    world.sessions.set("ses_parent_b", {
      id: "ses_parent_b",
      agent: "build",
      model: { providerID: "anthropic", id: "claude-x", variant: "max" },
    })
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      agent: "general",
    })
    world.sessions.set("ses_b", {
      id: "ses_b",
      parentID: "ses_parent_b",
      agent: "general",
    })
    world.messages.set("ses_a", [])
    world.messages.set("ses_b", [])
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx: ctxA } = makeCtx()
    const { ctx: ctxB } = makeCtx("ses_parent_b")
    await call(hooks, "subagent_send", ctxA, {
      session_id: "ses_a",
      message: "work",
      wait: false,
    })
    const mintedA = prompts[0].body.messageID
    await call(hooks, "subagent_send", ctxB, {
      session_id: "ses_b",
      message: "work",
      wait: false,
    })
    const mintedB = prompts[1].body.messageID
    // Parent A is deleted: the sweep must drop only A's notes (keyed on ses_a),
    // leaving parent B's note (keyed on ses_b) untouched.
    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses_parent" } },
      } as any,
    })
    // Sibling B completes first (its note must still deliver).
    completeChild(world, "ses_b", "b-done", mintedB)
    await idleEvent(hooks, "ses_b")
    // A completes too; its swept note must NOT deliver.
    completeChild(world, "ses_a", "a-done", mintedA)
    await idleEvent(hooks, "ses_a")
    await until(() =>
      prompts.some((prompt) => prompt.path.id === "ses_parent_b"),
    )
    await Bun.sleep(100)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent_b"),
    ).toHaveLength(1)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(0)
  })

  test("kill errs toward busy when status is unreadable, and aborts", async () => {
    const world = makeWorld()
    seedIdleChild(world, "ses_a")
    world.status.ses_a = { type: "busy" }
    const { client, aborts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    const orig = (client.session as any).status.bind(client.session)
    // The status endpoint blips during the kill: the inline catch must treat
    // the child as busy and abort it, not declare it already-idle.
    ;(client.session as any).status = () =>
      Promise.resolve({ error: { name: "boom" } })
    const pending = call(hooks, "subagent_kill", ctx, { session_id: "ses_a" })
    await Bun.sleep(20)
    // Settle the confirm wait so the kill resolves (baseline would block for
    // KILL_CONFIRM_MS otherwise).
    ;(client.session as any).status = orig
    completeChild(world, "ses_a", "partial")
    await idleEvent(hooks, "ses_a")
    const result = await pending
    expect(aborts).toContain("ses_a")
    expect(result.metadata).toMatchObject({ aborted: true })
    expect(result.output).not.toContain("already idle")
  })
})

describe("WP5: delivering-flag re-entrancy guard", () => {
  test("concurrent settle ticks against an in-flight delivery inject the note exactly once", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_a", [])
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const orig = (client.session as any).promptAsync.bind(client.session)
    let parentAttempts = 0
    // Gate ONLY the parent injection; the child's own send prompt goes through.
    ;(client.session as any).promptAsync = async (input: any) => {
      if (input.path.id === "ses_parent") {
        parentAttempts++
        await gate
      }
      return orig(input)
    }
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "work",
      wait: false,
    })
    completeChild(world, "ses_a", "done", prompts[0].body.messageID)
    await idleEvent(hooks, "ses_a")
    // The first delivery is now parked inside the gate with entry.delivering=true.
    await until(() => parentAttempts === 1)
    // Two more settle ticks fire against the in-flight (delivering) entry; the
    // guard must skip them, so no second deliverNotify starts.
    await idleEvent(hooks, "ses_a")
    await idleEvent(hooks, "ses_a")
    await Bun.sleep(50)
    release()
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    await Bun.sleep(100)
    expect(parentAttempts).toBe(1)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)
  })

  test("a blocking send must not claim a note that is already mid-delivery", async () => {
    // claimNotifies' `!entry.delivering` guard: a blocking send for a pair whose
    // note is in flight must NOT park it. If it does, an abort revives the
    // already-delivered entry and the parent hears the same completion twice.
    const world = makeWorld()
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_a", [])
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx, controller } = makeCtx()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const orig = (client.session as any).promptAsync.bind(client.session)
    let parentAttempts = 0
    ;(client.session as any).promptAsync = async (input: any) => {
      if (input.path.id === "ses_parent") {
        parentAttempts++
        await gate
      }
      return orig(input)
    }
    // Register a note, complete the child, and drive the delivery into the gate.
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "work",
      wait: false,
    })
    completeChild(world, "ses_a", "done", prompts[0].body.messageID)
    await idleEvent(hooks, "ses_a")
    await until(() => parentAttempts === 1)
    // The note is now mid-delivery (delivering=true), parked in the gate.

    // A blocking send for the same pair: its claimNotifies must refuse the
    // delivering entry. Keep the child busy so this send's wait stays pending.
    world.status.ses_a = { type: "busy" }
    const blocking = call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "steer",
    })
    await Bun.sleep(20)

    // Let the in-flight delivery finish (parent note #1), then make the child
    // idle so any revived note would settle immediately.
    release()
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    await Bun.sleep(20)
    delete world.status.ses_a

    // Abort the blocking send: restoreNotifies runs. Only if claimNotifies wrongly
    // parked the delivering entry does a second delivery fire here.
    controller.abort()
    await expect(blocking).rejects.toThrow(SEND_ABORTED_MESSAGE)
    await Bun.sleep(100)

    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)
  })
})

describe("WP5: notify-side none-guard", () => {
  function withIdleChild(world: World) {
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_a", [])
  }

  test("a run that goes idle without a reply notes the parent only after the grace, once", async () => {
    const world = makeWorld()
    withIdleChild(world)
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    // Unwaited send registers a completion note; the mock persists the injected
    // user message so hasInjectedMessage is true.
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "work",
      wait: false,
    })

    // Phase 1: the FIRST idle observation is inside the grace — no note yet.
    await idleEvent(hooks, "ses_a")
    await Bun.sleep(100)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(0)

    // Phase 2: a second idle spaced past GRACE_SPACING_MS expires the grace and
    // delivers exactly one "went idle without a new reply" note.
    await Bun.sleep(GRACE_SPACING_MS + 100)
    await idleEvent(hooks, "ses_a")
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    await Bun.sleep(100)
    const notes = prompts.filter((prompt) => prompt.path.id === "ses_parent")
    expect(notes).toHaveLength(1)
    expect(notes[0].body.parts[0].text).toContain(
      "without producing a new reply",
    )
    expect(notes[0].body.parts[0].text).toContain("subagent_send")
  })

  test("a confirmed anchor outside the bounded message window settles once and frees the slot", async () => {
    const realNow = Date.now.bind(Date)
    let skew = 0
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew)
    try {
      const world = makeWorld()
      withIdleChild(world)
      const { client, messageCalls, prompts } = makeClient(world)
      const hooks = await load(client, {
        maxBusyChildren: 1,
        pollIntervalMs: 30_000,
      })
      const { ctx } = makeCtx()
      await call(hooks, "subagent_send", ctx, {
        session_id: "ses_a",
        message: "work",
        wait: false,
      })

      const childCalls = messageCalls.filter(
        (input) => input.path.id === "ses_a",
      )
      const limit = childCalls.at(-1)?.query?.limit
      expect(limit).toBeGreaterThan(0)
      const anchor = prompts[0].body.messageID
      appendNewerUserMessages(world, "ses_a", limit)
      expect(
        (world.messages.get("ses_a") ?? [])
          .slice(-limit)
          .some((message) => message.info.id === anchor),
      ).toBe(false)

      const childReadCount = () =>
        messageCalls.filter((input) => input.path.id === "ses_a").length
      let reads = childReadCount()
      await idleEvent(hooks, "ses_a")
      await until(() => childReadCount() > reads)
      skew += GRACE_SPACING_MS + 1
      reads = childReadCount()
      await idleEvent(hooks, "ses_a")
      await until(() => childReadCount() > reads)
      await until(() =>
        prompts.some((prompt) => prompt.path.id === "ses_parent"),
      )

      await Promise.all([idleEvent(hooks, "ses_a"), idleEvent(hooks, "ses_a")])
      await Bun.sleep(100)
      const notes = prompts.filter((prompt) => prompt.path.id === "ses_parent")
      expect(notes).toHaveLength(1)
      expect(notes[0].body.parts[0].text).toContain(
        "without producing a new reply",
      )

      const spawned = await call(hooks, "subagent_spawn", ctx, {
        description: "slot released",
        prompt: "go",
        subagent_type: "general",
      })
      expect(spawned.metadata?.sessionId).toBe("ses_child_1")
    } finally {
      clock.mockRestore()
    }
  })

  test("a never-confirmed injected message is not delivered on grace alone", async () => {
    const realNow = Date.now.bind(Date)
    let skew = 0
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew)
    try {
      const world = makeWorld()
      withIdleChild(world)
      const { client, messageCalls, prompts } = makeClient(world)
      const hooks = await load(client, { pollIntervalMs: 30_000 })
      const { ctx } = makeCtx()
      const promptAsync = (client.session as any).promptAsync.bind(
        client.session,
      )
      const messages = (client.session as any).messages.bind(client.session)
      let failFirstVisibilityRead = true
      ;(client.session as any).promptAsync = (input: any) =>
        input.path.id === "ses_a"
          ? Promise.reject(new Error("response lost"))
          : promptAsync(input)
      ;(client.session as any).messages = (input: any) => {
        if (input.path.id === "ses_a" && failFirstVisibilityRead) {
          failFirstVisibilityRead = false
          return Promise.reject(new Error("visibility unavailable"))
        }
        return messages(input)
      }

      const sent = await call(hooks, "subagent_send", ctx, {
        session_id: "ses_a",
        message: "work",
        wait: false,
      })
      expect(sent.metadata?.outcome).toBe("unconfirmed")
      ;(client.session as any).promptAsync = promptAsync
      ;(client.session as any).messages = messages

      const childReadCount = () =>
        messageCalls.filter((input) => input.path.id === "ses_a").length
      for (let index = 0; index < 3; index++) {
        const reads = childReadCount()
        skew += GRACE_SPACING_MS + 1
        await idleEvent(hooks, "ses_a")
        await until(() => childReadCount() > reads)
      }
      await Bun.sleep(20)
      expect(
        prompts.filter((prompt) => prompt.path.id === "ses_parent"),
      ).toHaveLength(0)
    } finally {
      clock.mockRestore()
    }
  })
})

describe("WP5: errored outcomes", () => {
  function withChild(world: World) {
    world.sessions.set("ses_child", {
      id: "ses_child",
      parentID: "ses_parent",
      title: "audit configs (@general subagent)",
      agent: "general",
      model: { providerID: "anthropic", id: "claude-x", variant: "default" },
    })
    world.messages.set("ses_child", [
      {
        info: {
          id: "msg_c_0",
          role: "assistant",
          sessionID: "ses_child",
          time: { created: 1, completed: 2 },
        },
        parts: [{ type: "text", text: "earlier reply" }],
      },
    ])
  }

  test("a blocking send whose run errors renders task_error, not a successful task_result", async () => {
    const world = makeWorld()
    withChild(world)
    world.status.ses_child = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    const pending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "go",
    })
    await until(() => prompts.length === 1)
    completeChildWithError(
      world,
      "ses_child",
      "context overflow",
      prompts[0].body.messageID,
    )
    await idleEvent(hooks, "ses_child")
    const result = await pending
    expect(result.output).toContain('<task id="ses_child" state="error">')
    expect(result.output).toContain("<task_error>")
    expect(result.output).toContain("context overflow")
    expect(result.output).not.toContain("task_result")
    expect(result.metadata?.outcome).toBe("errored")
  })

  test("a wait on an idle child whose latest run errored renders task_error", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_a", [
      {
        info: {
          id: "msg_err",
          role: "assistant",
          sessionID: "ses_a",
          error: { data: { message: "context overflow" } },
          time: { created: 2, completed: 3 },
        },
        parts: [],
      },
    ])
    const { client } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    const result = await call(hooks, "subagent_wait", ctx, {
      session_ids: ["ses_a"],
    })
    expect(result.output).toContain('<task id="ses_a" state="error">')
    expect(result.output).toContain("<task_error>")
    expect(result.output).toContain("context overflow")
    expect(result.output).not.toContain("task_result")
    expect(result.metadata?.waited).toContain("ses_a")
  })
})

describe("subagent_kill", () => {
  test("idle child is a friendly no-op", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", { id: "ses_a", parentID: "ses_parent" })
    const { client, aborts } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const result = await call(hooks, "subagent_kill", ctx, {
      session_id: "ses_a",
    })
    expect(result.output).toContain("already idle")
    expect(result.metadata).toMatchObject({ aborted: false })
    expect(aborts).toHaveLength(0)
  })

  test("dispose during the busy read sends no abort", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", { id: "ses_a", parentID: "ses_parent" })
    world.statusHangs = true
    const { client, aborts, statusSignals } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()

    const killing = call(hooks, "subagent_kill", ctx, {
      session_id: "ses_a",
    }).catch((error: Error) => error)
    await until(() => statusSignals.length === 1)
    const startedAt = Date.now()
    await hooks.dispose?.()
    active = undefined

    // "Unreadable status means assume busy and stop it" is right for a blip
    // and wrong for a read this plugin cancelled itself — the child's runner
    // is going down with the same teardown. The confirm wait swallows every
    // rejection, so waitForChild's own guard cannot stop the abort; only the
    // check ahead of it can.
    expect(await killing).toBeInstanceOf(Error)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(aborts).toHaveLength(0)
  })

  test("busy child is aborted, confirmed idle, and its pending note suppressed", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_a", [])
    world.status.ses_a = { type: "busy" }
    const { client, prompts, aborts } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()
    // Track a pending completion note first (an unwaited send).
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "work",
      wait: false,
    })

    const pending = call(hooks, "subagent_kill", ctx, { session_id: "ses_a" })
    await until(() => aborts.length === 1)
    completeChild(world, "ses_a", "partial")
    await idleEvent(hooks, "ses_a")
    const result = await pending
    expect(result.output).toContain("Aborted subagent ses_a")
    expect(result.metadata).toMatchObject({ aborted: true })
    // The kill result was the delivery; no note lands on the parent.
    await Bun.sleep(50)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(0)
  })

  test("a failed abort restores the pending note so the child can still notify", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_a", [])
    world.status.ses_a = { type: "busy" }
    const { client, prompts } = makeClient(world)
    ;(client.session as any).abort = () =>
      Promise.resolve({ error: { name: "boom" } })
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    // A pending completion note (an unwaited send) exists before the kill.
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "work",
      wait: false,
    })
    const minted = prompts[0].body.messageID
    // The abort fails; the note must be restored, not permanently discarded.
    await expect(
      call(hooks, "subagent_kill", ctx, { session_id: "ses_a" }),
    ).rejects.toThrow(/aborting ses_a failed/)
    // The still-running child finishes on its own and its parent is notified.
    completeChild(world, "ses_a", "finished anyway", minted)
    await Promise.all([idleEvent(hooks, "ses_a"), idleEvent(hooks, "ses_a")])
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    await Bun.sleep(100)
    const notes = prompts.filter((prompt) => prompt.path.id === "ses_parent")
    expect(notes).toHaveLength(1)
    expect(notes[0].body.parts[0].text).toContain("finished anyway")
  })

  test("a rejected abort restores the pending note exactly once and releases its slot", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_a", [])
    world.status.ses_a = { type: "busy" }
    const { client, prompts, aborts } = makeClient(world)
    const abort = (client.session as any).abort.bind(client.session)
    ;(client.session as any).abort = async (input: any) => {
      await abort(input)
      throw new Error("transport response lost")
    }
    const hooks = await load(client, {
      maxBusyChildren: 1,
      pollIntervalMs: 30_000,
    })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "work",
      wait: false,
    })
    const minted = prompts[0].body.messageID

    await expect(
      call(hooks, "subagent_kill", ctx, { session_id: "ses_a" }),
    ).rejects.toThrow(/aborting ses_a failed: transport response lost/)
    expect(aborts).toEqual(["ses_a"])

    // With status idle, only the restored note can keep the sole slot occupied.
    delete world.status.ses_a
    await expect(
      call(hooks, "subagent_spawn", ctx, {
        description: "must stay blocked",
        prompt: "go",
        subagent_type: "general",
      }),
    ).rejects.toThrow(/already has 1 subagents working/)

    completeChild(world, "ses_a", "finished anyway", minted)
    await Promise.all([idleEvent(hooks, "ses_a"), idleEvent(hooks, "ses_a")])
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    await Bun.sleep(100)
    const notes = prompts.filter((prompt) => prompt.path.id === "ses_parent")
    expect(notes).toHaveLength(1)
    expect(notes[0].body.parts[0].text).toContain("finished anyway")

    const spawned = await call(hooks, "subagent_spawn", ctx, {
      description: "slot released",
      prompt: "go",
      subagent_type: "general",
    })
    expect(spawned.metadata?.sessionId).toBe("ses_child_1")
  })

  test("a child deleted during the kill confirmation is reported gone, not preserved", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_a", [])
    world.status.ses_a = { type: "busy" }
    const { client, aborts } = makeClient(world)
    const hooks = await load(client, { pollIntervalMs: 30_000 })
    const { ctx } = makeCtx()
    const pending = call(hooks, "subagent_kill", ctx, { session_id: "ses_a" })
    await until(() => aborts.length === 1)
    // The session vanishes before it confirms idle.
    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses_a" } },
      } as any,
    })
    const result = await pending
    expect(result.output).toContain("has since been deleted")
    expect(result.output).not.toContain("preserved")
    expect(result.metadata).toMatchObject({ aborted: true, deleted: true })
  })
})

describe("task tool hint", () => {
  test("appends only to the task tool, and only when enabled", async () => {
    const world = makeWorld()
    const { client } = makeClient(world)
    const hooks = await load(client)
    const task = { description: "base", parameters: {} }
    await hooks["tool.definition"]?.({ toolID: "task" } as any, task as any)
    expect(task.description).toBe(`base${taskHint(true)}`)
    const bash = { description: "base", parameters: {} }
    await hooks["tool.definition"]?.({ toolID: "bash" } as any, bash as any)
    expect(bash.description).toBe("base")

    const disabled = await load(client, { taskHint: false })
    const untouched = { description: "base", parameters: {} }
    await disabled["tool.definition"]?.(
      { toolID: "task" } as any,
      untouched as any,
    )
    expect(untouched.description).toBe("base")
  })
})

describe("options", () => {
  test("notify:false still toasts but never prompts the parent, and the outputs say so", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_a", [])
    world.status.ses_a = { type: "busy" }
    const { client, prompts, toasts } = makeClient(world)
    const hooks = await load(client, { notify: false })
    const { ctx } = makeCtx()
    const result = await call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "work",
      wait: false,
    })
    expect(result.output).toContain("notifications are disabled")
    completeChild(world, "ses_a", "done", prompts[0].body.messageID)
    await idleEvent(hooks, "ses_a")
    await until(() => toasts.length === 1)
    await Bun.sleep(50)
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(0)
  })

  test("notify:false is reflected in every tool description and the task hint", async () => {
    const world = makeWorld()
    const { client } = makeClient(world)
    const hooks = await load(client, { notify: false })
    for (const name of SUBAGENT_TOOL_IDS) {
      const description =
        (hooks.tool?.[name] as { description?: string } | undefined)
          ?.description ?? ""
      // No tool may promise a notification that cannot arrive.
      expect(description.toLowerCase()).not.toContain("notified")
    }
    const spawnDescription =
      (hooks.tool?.subagent_spawn as { description?: string } | undefined)
        ?.description ?? ""
    expect(spawnDescription).toContain("notify: false")
    const task = { description: "base", parameters: {} }
    await hooks["tool.definition"]?.({ toolID: "task" } as any, task as any)
    expect(task.description).toContain("collect its reply with subagent_wait")
  })

  test("a toast-only (notify:false) completion consumes its note and frees the slot", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", {
      id: "ses_a",
      parentID: "ses_parent",
      agent: "general",
    })
    world.messages.set("ses_a", [])
    world.status.ses_a = { type: "busy" }
    const { client, prompts } = makeClient(world)
    // notify:false makes deliverNotify complete synchronously; the note must be
    // dropped, not re-added on every poll tick (which would peg the slot).
    const hooks = await load(client, {
      notify: false,
      maxBusyChildren: 1,
      pollIntervalMs: 50,
    })
    const { ctx } = makeCtx()
    await call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "work",
      wait: false,
    })
    completeChild(world, "ses_a", "done", prompts[0].body.messageID)
    await idleEvent(hooks, "ses_a")
    await Bun.sleep(160) // several poll ticks
    // ses_a is idle and its note consumed, so the one slot is free again.
    const result = await call(hooks, "subagent_spawn", ctx, {
      description: "next",
      prompt: "go",
      subagent_type: "general",
    })
    expect(result.metadata).toMatchObject({ sessionId: "ses_child_1" })
  })
})

describe("dispose", () => {
  test("fails pending waits instead of leaving them hanging", async () => {
    const world = makeWorld()
    world.sessions.set("ses_a", { id: "ses_a", parentID: "ses_parent" })
    world.status.ses_a = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const hooks = await load(client)
    const { ctx } = makeCtx()
    const pending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_a",
      message: "hi",
    })
    await until(() => prompts.length === 1)
    await hooks.dispose?.()
    expect(pending).rejects.toThrow(/disposed/)
  })
})

describe("abort handling", () => {
  function withChild(world: World) {
    world.sessions.set("ses_child", {
      id: "ses_child",
      parentID: "ses_parent",
      title: "audit configs (@general subagent)",
      agent: "general",
      model: { providerID: "anthropic", id: "claude-x", variant: "default" },
    })
    world.messages.set("ses_child", [
      {
        info: {
          id: "msg_c_0",
          role: "assistant",
          sessionID: "ses_child",
          time: { created: 1, completed: 2 },
        },
        parts: [{ type: "text", text: "earlier reply" }],
      },
    ])
  }

  test("an already-aborted turn neither asks for permission nor creates a subagent", async () => {
    const world = makeWorld()
    const { client, creates, prompts } = makeClient(world)
    const hooks = await load(client)
    const { ctx, asks, controller } = makeCtx()
    controller.abort()
    expect(
      call(hooks, "subagent_spawn", ctx, {
        description: "audit",
        prompt: "go",
        subagent_type: "general",
      }),
    ).rejects.toThrow(SPAWN_ABORTED_MESSAGE)
    await Bun.sleep(20)
    expect(asks).toHaveLength(0)
    expect(creates).toHaveLength(0)
    expect(prompts).toHaveLength(0)
  })

  test("an abort racing session.create deletes the child that never got its prompt", async () => {
    const world = makeWorld()
    const { client, prompts, deletes } = makeClient(world)
    const hooks = await load(client)
    const { ctx, controller } = makeCtx()
    // The abort lands after the session exists but before it is prompted —
    // the one window where cleanup is both possible and correct.
    const create = (client.session as any).create.bind(client.session)
    ;(client.session as any).create = (input: any) => {
      controller.abort()
      return create(input)
    }
    expect(
      call(hooks, "subagent_spawn", ctx, {
        description: "audit",
        prompt: "go",
        subagent_type: "general",
      }),
    ).rejects.toThrow(SPAWN_ABORTED_MESSAGE)
    await until(() => deletes.length === 1)
    expect(deletes[0]).toBe("ses_child_1")
    expect(prompts).toHaveLength(0)
  })

  // The opposite window: once the host has the prompt the child owns it, and
  // deleting it would retract work already accepted.
  test("an abort after the prompt is accepted keeps the subagent and still notifies", async () => {
    const world = makeWorld()
    const { client, prompts, deletes } = makeClient(world)
    const hooks = await load(client)
    const { ctx, controller } = makeCtx()
    const promptAsync = (client.session as any).promptAsync.bind(client.session)
    ;(client.session as any).promptAsync = (input: any) => {
      const result = promptAsync(input)
      controller.abort()
      return result
    }
    const result = await call(hooks, "subagent_spawn", ctx, {
      description: "audit",
      prompt: "go",
      subagent_type: "general",
    })
    expect(result.metadata?.sessionId).toBe("ses_child_1")
    expect(deletes).toHaveLength(0)
    // The aborted caller does not own delivery, so the completion still
    // reaches the parent.
    completeChild(world, "ses_child_1", "done", prompts[0].body.messageID)
    await idleEvent(hooks, "ses_child_1")
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
  })

  test("a send aborted before delivery injects nothing", async () => {
    const world = makeWorld()
    withChild(world)
    const { client, prompts } = makeClient(world)
    const hooks = await load(client)
    const { ctx, asks, controller } = makeCtx()
    controller.abort()
    expect(
      call(hooks, "subagent_send", ctx, {
        session_id: "ses_child",
        message: "hi",
      }),
    ).rejects.toThrow(SEND_ABORTED_BEFORE_DELIVERY_MESSAGE)
    await Bun.sleep(20)
    expect(asks).toHaveLength(0)
    expect(prompts).toHaveLength(0)
  })

  // An aborted wait must not lose the completion of a message the child has
  // already accepted. A child with no pending note — one spawned by the stock
  // task tool, or whose earlier note was already delivered — has nothing to
  // restore, so the send has to register one itself.
  test("aborting a blocking send still leaves the parent a completion note", async () => {
    const world = makeWorld()
    withChild(world)
    world.status.ses_child = { type: "busy" }
    const { client, prompts } = makeClient(world)
    const hooks = await load(client)
    const { ctx, controller } = makeCtx()
    const pending = call(hooks, "subagent_send", ctx, {
      session_id: "ses_child",
      message: "hi",
    })
    await until(() => prompts.length === 1)
    controller.abort()
    expect(pending).rejects.toThrow(SEND_ABORTED_MESSAGE)
    await Bun.sleep(20)
    completeChild(world, "ses_child", "answer", prompts[0].body.messageID)
    await idleEvent(hooks, "ses_child")
    await until(() => prompts.some((prompt) => prompt.path.id === "ses_parent"))
    expect(
      prompts.filter((prompt) => prompt.path.id === "ses_parent"),
    ).toHaveLength(1)
  })
})

describe("the host's event contract has one reader", () => {
  // A tripwire, not a proof. This plugin keeps its own busy/idle ANSWER on
  // purpose — endpoint-first, whole-map, tri-state (audit §2.9) — but the
  // parse of the host's event payloads is the same contract cron and
  // background-tasks read, and three hand-rolled narrowings of session.status
  // is how those shapes drift apart.
  test("the server half shares the library's event parse", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "../src/index.ts"),
    ).text()

    expect(source).toContain("sessionActivityFromEvent(")
    for (const part of [
      '"session.status"',
      '"session.idle"',
      '"session.deleted"',
    ]) {
      expect(source, `index.ts still parses ${part} itself`).not.toContain(part)
    }
  })
})

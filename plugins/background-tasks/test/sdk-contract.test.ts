import { describe, expect, test } from "bun:test"
import type {
  Hooks,
  Plugin,
  ToolContext,
  ToolDefinition,
} from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

// Compile-time pins for every host surface the server half depends on —
// directly, or through the shared busy/idle tracker it runs
// (createSessionActivityTracker, which takes `client: unknown` and narrows
// structurally, so these are the suite's only type-level check on
// /session/status and on the three session events it reads). Each assignment
// below only typechecks while the pinned SDK/plugin types still accept those
// shapes; drift fails `bun run typecheck` instead of surfacing at runtime in
// someone's session.

type Client = Parameters<Plugin>[0]["client"]

type PromptAsyncParams = NonNullable<
  Parameters<Client["session"]["promptAsync"]>[0]
>
type SessionStatusParams = NonNullable<
  Parameters<Client["session"]["status"]>[0]
>
type SessionMessageParams = NonNullable<
  Parameters<Client["session"]["message"]>[0]
>
type ShowToastParams = NonNullable<Parameters<Client["tui"]["showToast"]>[0]>
type PublishParams = NonNullable<Parameters<Client["tui"]["publish"]>[0]>
type PathGetParams = NonNullable<Parameters<Client["path"]["get"]>[0]>

// promptAsync: the notification pipeline's exact call — `synthetic` marks the
// injected part as host-generated, and `signal` is what makes the post's
// deadline a real cancellation rather than an abandoned request.
//
// Deliberately no `noReply`: the host persists the user message before it
// consults that flag, so it cannot keep a note out of a turn already running.
// Notes for a busy session are withheld until it is observed idle instead.
const promptAsync: PromptAsyncParams = {
  path: { id: "ses_1" },
  query: { directory: "/project" },
  signal: new AbortController().signal,
  body: {
    messageID: "msg_completion_1",
    parts: [
      { type: "text", text: "<background-task-update>…", synthetic: true },
    ],
  },
}

const sessionMessage: SessionMessageParams = {
  path: { id: "ses_1", messageID: "msg_completion_1" },
  query: { directory: "/project" },
  signal: new AbortController().signal,
}

// session.status lists only busy/retry sessions, keyed by session id.
const sessionStatus: SessionStatusParams = { query: { directory: "/project" } }

const showToast: ShowToastParams = {
  body: {
    title: "Background task finished",
    message: "bg_1 exited with code 0",
    variant: "success",
  },
  query: { directory: "/project" },
}

// The TUI poke: a tui.command.execute event published through the host.
const publish: PublishParams = {
  body: {
    type: "tui.command.execute",
    properties: { command: "background_tasks.sync" },
  },
  query: { directory: "/project" },
}

const pathGet: PathGetParams = { query: { directory: "/project" } }

// Event property shapes the event hook narrows.
type Event = Parameters<NonNullable<Hooks["event"]>>[0]["event"]
type SessionStatusEvent = Extract<Event, { type: "session.status" }>
type SessionDeletedEvent = Extract<Event, { type: "session.deleted" }>
type SessionIdleEvent = Extract<Event, { type: "session.idle" }>

const statusProperties: SessionStatusEvent["properties"] = {
  sessionID: "ses_1",
  status: { type: "busy" },
}
const idleStatus: SessionStatusEvent["properties"]["status"] = { type: "idle" }
const deletedProperties: SessionDeletedEvent["properties"] = {
  info: { id: "ses_1" } as SessionDeletedEvent["properties"]["info"],
}
const idleProperties: SessionIdleEvent["properties"] = { sessionID: "ses_1" }

// tool.definition receives the tool id and a mutable description.
type ToolDefinitionHook = NonNullable<Hooks["tool.definition"]>
const definitionArgs: Parameters<ToolDefinitionHook> = [
  { toolID: "bash" },
  { description: "…", parameters: {} },
]

// The tool() helper: zod raw shape in, ToolContext with sessionID/abort/ask.
const definition: ToolDefinition = tool({
  description: "pin",
  args: { task_id: tool.schema.string() },
  execute: async (args, ctx: ToolContext) => {
    void ctx.sessionID
    void ctx.agent
    void (ctx.abort satisfies AbortSignal)
    await ctx.ask({
      permission: "bash",
      patterns: [args.task_id],
      always: [args.task_id],
      metadata: {},
    })
    return { title: "t", output: "o", metadata: { taskId: args.task_id } }
  },
})

// Hooks.tool is the registration surface — the map key is the tool id.
const hooks: Hooks = { tool: { background_run: definition } }

describe("pinned SDK call shapes", () => {
  test("the compile-time pins above still hold", () => {
    // The value assignments are the assertions; this test just keeps the file
    // in the runtime suite so an accidental `skip` of typecheck is visible.
    expect(promptAsync.body?.noReply).toBeUndefined()
    expect(promptAsync.signal).toBeDefined()
    expect(promptAsync.body?.messageID).toBe("msg_completion_1")
    expect(sessionMessage.path.messageID).toBe("msg_completion_1")
    expect(sessionStatus.query?.directory).toBe("/project")
    expect(showToast.body?.variant).toBe("success")
    expect(publish.body?.type).toBe("tui.command.execute")
    expect(pathGet.query?.directory).toBe("/project")
    expect(statusProperties.status.type).toBe("busy")
    expect(idleStatus.type).toBe("idle")
    expect(deletedProperties.info).toBeDefined()
    expect(idleProperties.sessionID).toBe("ses_1")
    expect(definitionArgs[0].toolID).toBe("bash")
    expect(typeof definition.execute).toBe("function")
    expect(Object.keys(hooks.tool ?? {})).toEqual(["background_run"])
  })
})

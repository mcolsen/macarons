import { describe, expect, test } from "bun:test"
import type { Rule } from "@macarons/permission-rules"
import type { Plugin, ToolContext } from "@opencode-ai/plugin"
import type { Model, Provider } from "@opencode-ai/sdk"
import type { SessionCreateBody } from "../src/shared"

// Compile-time pins for the host surfaces this plugin depends on. Each
// assignment below only typechecks while the pinned SDK/plugin types still
// accept the exact call shapes src/index.ts makes; drift fails
// `bun run typecheck` instead of surfacing at runtime in someone's session.

type Client = Parameters<Plugin>[0]["client"]
type SessionCreateParams = NonNullable<
  Parameters<Client["session"]["create"]>[0]
>
type ProvidersParams = NonNullable<Parameters<Client["config"]["providers"]>[0]>
type PromptAsyncParams = NonNullable<
  Parameters<Client["session"]["promptAsync"]>[0]
>
type MessageParams = NonNullable<Parameters<Client["session"]["message"]>[0]>

const permission: Rule[] = [
  { permission: "task", pattern: "*", action: "deny" },
]

// The child-session create body. The generated SDK body type lists only
// parentID/title, so `agent` and the lockdown `permission` are checked against
// the local contract and the value rides through structurally. If a future SDK
// stops accepting the extra keys structurally, THIS assignment breaks — which
// is the signal to switch to the raw _client.post("/session") transport, not to
// re-introduce a cast.
const createBody = {
  parentID: "ses_parent",
  title: "audit the config (@general subagent)",
  agent: "general",
  permission,
} satisfies SessionCreateBody

const create: SessionCreateParams = {
  body: createBody,
  query: { directory: "/project" },
}

const providerSignal = new AbortController().signal
const providersCall: ProvidersParams = {
  query: { directory: "/project" },
  signal: providerSignal,
}

const watermarkRead: MessageParams = {
  path: { id: "ses_child", messageID: "msg_child" },
  query: { directory: "/project" },
  signal: new AbortController().signal,
}

// The generated SDK omits runtime-only model variants, so those are decoded
// structurally in shared.ts. These are the provider/model fields it does pin.
const providerFields = (provider: Provider, model: Model) =>
  ({
    providerID: provider.id,
    providerName: provider.name,
    models: provider.models,
    modelID: model.id,
    modelName: model.name,
  }) satisfies Record<string, unknown>

// Model and variant belong on the first prompt, not session.create: the host
// resolves the child session's active model from this prompt body.
type InitialPromptBody = {
  messageID: string
  agent: string
  model: { providerID: string; modelID: string }
  variant: string
  parts: Array<{ type: "text"; text: string }>
}

const promptBody = {
  messageID: "msg_child",
  agent: "general",
  model: { providerID: "e2e", modelID: "alternate" },
  variant: "high",
  parts: [{ type: "text", text: "Do the work." }],
} satisfies InitialPromptBody

const promptAsync: PromptAsyncParams = {
  path: { id: "ses_child" },
  query: { directory: "/project" },
  body: promptBody,
}

// Dropping the lockdown ruleset must not compile: a child created without it
// inherits none of the parent's denies.
// @ts-expect-error — `permission` is required by SessionCreateBody.
const withoutLockdown: SessionCreateBody = {
  parentID: "ses_parent",
  title: "t",
  agent: "general",
}

const createWithModel: SessionCreateBody = {
  parentID: "ses_parent",
  title: "t",
  agent: "general",
  permission,
  // @ts-expect-error — model selection is intentionally absent from create.
  model: { providerID: "e2e", modelID: "alternate" },
}

// The tool context: `abort` is the signal spawn/send check before creating or
// prompting a child.
const contextShape = (ctx: ToolContext) => {
  void (ctx.abort satisfies AbortSignal)
  return ctx.sessionID
}

describe("pinned SDK call shapes", () => {
  test("the compile-time pins above still hold", () => {
    expect(create.body?.parentID).toBe("ses_parent")
    expect(createBody.permission).toHaveLength(1)
    expect(withoutLockdown.parentID).toBe("ses_parent")
    expect(providersCall.query?.directory).toBe("/project")
    expect(providersCall.signal).toBe(providerSignal)
    expect(watermarkRead.path).toEqual({
      id: "ses_child",
      messageID: "msg_child",
    })
    expect(watermarkRead.query?.directory).toBe("/project")
    expect(watermarkRead.signal).toBeInstanceOf(AbortSignal)
    expect(typeof providerFields).toBe("function")
    expect(promptBody.variant).toBe("high")
    expect(promptAsync.path.id).toBe("ses_child")
    expect(createWithModel.parentID).toBe("ses_parent")
    expect(typeof contextShape).toBe("function")
  })

  // The create body was once laundered through `as never`, which erased the
  // annotation AND excess-property checking: a misspelled `permission` compiled
  // clean and shipped an unlocked child. The contract above is the guard; this
  // keeps the guard from being cast away again.
  test("no host body is laundered through a cast", async () => {
    for (const module of ["../src/index.ts", "../src/shared.ts"]) {
      const source = await Bun.file(new URL(module, import.meta.url)).text()
      expect(source).not.toContain("as never")
    }
  })
})

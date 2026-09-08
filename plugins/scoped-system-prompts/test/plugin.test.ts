import { describe, expect, test } from "bun:test"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import { ScopedSystemPromptsPlugin } from "../src/index"

type Hooks = Awaited<ReturnType<typeof ScopedSystemPromptsPlugin>>

function makeClient(version: unknown = BAND.floor) {
  const logs: Array<{ body?: { message?: string } }> = []
  const toasts: unknown[] = []
  const client = {
    app: {
      log(input: { body?: { message?: string } }) {
        logs.push(input)
        return Promise.resolve({ data: true })
      },
    },
    global: {
      health: () => Promise.resolve({ data: { healthy: true, version } }),
    },
    tui: {
      showToast(input: unknown) {
        toasts.push(input)
        return Promise.resolve({ data: true })
      },
    },
  }
  return { client, logs, toasts }
}

async function load(
  options: Record<string, unknown> | undefined,
  version: unknown = BAND.floor,
) {
  const host = makeClient(version)
  const hooks = await ScopedSystemPromptsPlugin(
    {
      client: host.client as any,
      directory: "/project",
      worktree: "/project",
      project: { id: "project" } as any,
      serverUrl: new URL("http://opencode.internal"),
      experimental_workspace: { register() {} } as any,
      $: {} as any,
    },
    options,
  )
  return { ...host, hooks }
}

async function transform(
  hooks: Hooks,
  system: string[],
  providerID: string,
  id: string,
  apiID = id,
): Promise<void> {
  await hooks["experimental.chat.system.transform"]?.(
    {
      model: {
        providerID,
        id,
        api: { id: apiID },
      } as any,
    },
    { system },
  )
}

describe("system prompt hook", () => {
  test("matches the selectable model id rather than the backing API id", async () => {
    const { hooks } = await load({
      prompts: [
        {
          model: "openai/my-sol-alias",
          mode: "append",
          content: "model-scoped instruction",
        },
      ],
    })
    const system = ["base"]

    await transform(hooks, system, "openai", "my-sol-alias", "gpt-5.6-sol")

    expect(system).toEqual(["base", "model-scoped instruction"])
  })

  test("leaves nonmatching requests unchanged", async () => {
    const { hooks } = await load({
      prompts: [
        {
          model: "openai/gpt-5.6-sol",
          mode: "replace",
          content: "replacement",
        },
      ],
    })
    const system = ["base", "project"]

    await transform(hooks, system, "openai", "gpt-5.6-terra")

    expect(system).toEqual(["base", "project"])
  })

  test("applies without a session id, including hidden generation calls", async () => {
    const { hooks } = await load({
      prompts: [
        {
          model: "openai/gpt-5.6-sol",
          mode: "prepend",
          content: "first",
        },
      ],
    })
    const system = ["base"]

    await transform(hooks, system, "openai", "gpt-5.6-sol")

    expect(system).toEqual(["first", "base"])
  })

  test("logs invalid rules once at startup and keeps valid rules active", async () => {
    const { hooks, logs } = await load({
      prompts: [
        { model: "bad", mode: "append", content: "ignored" },
        {
          model: "openai/gpt-5.6-sol",
          mode: "append",
          content: "active",
        },
      ],
    })
    const system = ["base"]

    await transform(hooks, system, "openai", "gpt-5.6-sol")

    expect(system).toEqual(["base", "active"])
    expect(logs).toHaveLength(1)
    expect(logs[0]?.body?.message).toContain("ignoring invalid plugin option")
  })

  test("stays inert when no valid rules are configured", async () => {
    const { hooks } = await load(undefined)
    expect(hooks["experimental.chat.system.transform"]).toBeUndefined()
  })

  test("disables on an incompatible host major", async () => {
    const { hooks, logs } = await load(
      {
        prompts: [
          {
            model: "openai/gpt-5.6-sol",
            mode: "append",
            content: "never applied",
          },
        ],
      },
      BAND.incompatible,
    )

    expect(hooks["experimental.chat.system.transform"]).toBeUndefined()
    expect(
      logs.some((entry) => entry.body?.message?.includes("is disabled")),
    ).toBe(true)
  })
})

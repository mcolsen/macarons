import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { PermissionRequest } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import type { SessionGenerate } from "@opencode/plugin/promise/session"
import plugin from "../src/index"
import { V2_CLASSIFIER_SYSTEM } from "../src/server/classifier"
import { projectSettingsFile } from "../src/shared"

let sandbox: string
const priorEnv = { ...process.env }
let stop: (() => Promise<void> | void) | undefined
beforeEach(async () => {
  sandbox = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "approve-native-")),
  )
  process.env.OPENCODE_CONFIG_DIR = path.join(sandbox, "config")
  process.env.XDG_STATE_HOME = path.join(sandbox, "state")
  process.env.XDG_DATA_HOME = path.join(sandbox, "data")
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true"
  await Promise.all(
    ["project", "config", "state/opencode", "data/opencode"].map((dir) =>
      fs.mkdir(path.join(sandbox, dir), { recursive: true }),
    ),
  )
})
afterEach(async () => {
  await stop?.()
  stop = undefined
  for (const key of [
    "OPENCODE_CONFIG_DIR",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
  ]) {
    if (priorEnv[key] === undefined) delete process.env[key]
    else process.env[key] = priorEnv[key]
  }
  await fs.rm(sandbox, { recursive: true, force: true })
})
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("condition did not settle")
}

async function setup(
  options: {
    settings?: Record<string, unknown>
    risk?: string
    authorization?: string
    verdict?: string
    rules?: unknown[]
    sessionRules?: unknown[]
    missingAgent?: boolean
    beforeGenerate?: () => Promise<void>
  } = {},
) {
  const directory = path.join(sandbox, "project")
  const settingsPath = projectSettingsFile(
    process.env.OPENCODE_CONFIG_DIR!,
    directory,
  )
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  await fs.writeFile(
    settingsPath,
    JSON.stringify({
      notify: false,
      journal: false,
      sweepStale: false,
      unattendedDenyMs: 0,
      ...options.settings,
    }),
  )
  const callbacks = new Map<string, (event: any) => unknown>()
  const pending = new Map<string, PermissionRequest>()
  const replies: Array<{ requestID: string; decision: string }> = []
  const prompts: string[] = []
  const isolated: SessionGenerate[] = []
  const removed: string[] = []
  const created: unknown[] = []
  const sessions = new Map<string, any>([
    [
      "ses_root",
      {
        id: "ses_root",
        agent: "build",
        model: { providerID: "test", id: "judge" },
        permissions: options.sessionRules ?? [],
      },
    ],
    [
      "ses_child",
      {
        id: "ses_child",
        parentID: "ses_root",
        agent: "build",
        model: { providerID: "test", id: "judge" },
        permissions: [],
      },
    ],
  ])
  let sequence = 0
  let eventResolve: ((value: IteratorResult<any>) => void) | undefined
  let ended = false
  const queue: any[] = []
  let rpc: Record<string, (input: any) => Promise<any>> = {}
  const emit = (event: any) => {
    if (eventResolve) {
      const resolve = eventResolve
      eventResolve = undefined
      resolve({ value: event, done: false })
    } else queue.push(event)
  }
  const context = {
    app: { name: "OpenCode", version: "2.0.29", channel: "prod" },
    location: {
      directory,
      project: { id: "project", directory, canonical: directory },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (!sessions.has(sessionID)) throw { _tag: "SessionNotFoundError" }
        return sessions.get(sessionID)
      },
      context: async ({ sessionID }: { sessionID: string }) => [
        {
          type: "user",
          id: "msg_user",
          text:
            sessionID === "ses_root"
              ? "Fix the project. You may push when ready."
              : "Investigate the tests",
          time: { created: 0 },
        },
        {
          type: "assistant",
          id: "msg_tools",
          agent: "build",
          model: { providerID: "test", id: "judge" },
          time: { created: 1 },
          content: [
            {
              type: "tool",
              id: "call_1",
              name: "shell",
              state: {
                status: "running",
                input: { command: "git status" },
                metadata: {},
              },
              time: { created: 1 },
            },
          ],
        },
      ],
      hook: async (name: string, callback: (event: any) => unknown) => {
        callbacks.set(name, callback)
        return {
          dispose: async () => {
            callbacks.delete(name)
          },
        }
      },
      create: async (input: any) => {
        const id = `ses_judge_${++sequence}`
        created.push(input)
        sessions.set(id, { id, ...input })
        return { id, ...input }
      },
      generate: async ({
        sessionID,
        prompt,
      }: {
        sessionID: string
        prompt: string
      }) => {
        prompts.push(prompt)
        await options.beforeGenerate?.()
        const event = {
          sessionID,
          agent: "build",
          model: { providerID: "test", id: "judge" },
          system: [
            { type: "text", text: "project instructions must disappear" },
          ],
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "unrelated session text" }],
            },
          ],
          tools: { shell: {} },
          options: {},
        } as unknown as SessionGenerate
        await callbacks.get("generate")?.(event)
        isolated.push(event)
        return {
          text:
            options.verdict ??
            JSON.stringify({
              decision: "approve",
              risk: options.risk ?? "low",
              authorization: options.authorization ?? "implied",
              reason: "fixture verdict",
            }),
        }
      },
      remove: async ({ sessionID }: { sessionID: string }) => {
        removed.push(sessionID)
        sessions.delete(sessionID)
      },
      wait: async () => {},
    },
    agent: {
      list: async () => ({
        data: options.missingAgent
          ? []
          : [
              {
                id: "build",
                permissions: options.rules ?? [
                  { action: "shell", resource: "*", effect: "ask" },
                ],
              },
            ],
      }),
    },
    model: {
      list: async () => ({
        data: [{ providerID: "test", id: "judge", variants: [] }],
      }),
    },
    permission: {
      list: async ({ sessionID }: { sessionID: string }) =>
        [...pending.values()].filter(
          (request) => request.sessionID === sessionID,
        ),
      get: async ({ requestID }: { requestID: string }) => {
        if (!pending.has(requestID)) throw { _tag: "PermissionNotFoundError" }
        return pending.get(requestID)
      },
      reply: async (input: {
        sessionID: string
        requestID: string
        decision: string
      }) => {
        replies.push(input)
        pending.delete(input.requestID)
        emit({
          type: "permission.replied",
          data: { ...input, reply: input.decision },
        })
      },
    },
    integration: {
      transform: async (callback: any) => {
        callback({
          update: (_id: string, fn: any) => fn({ name: "" }),
          method: { update: () => {} },
        })
        return { dispose: async () => {} }
      },
      connection: { active: async () => undefined },
    },
    rpc: {
      register: async (_definition: unknown, handlers: typeof rpc) => {
        rpc = handlers
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        [Symbol.asyncIterator]() {
          return this
        },
        next: async (): Promise<IteratorResult<any>> => {
          if (ended || signal.aborted) return { done: true, value: undefined }
          if (queue.length) return { done: false, value: queue.shift() }
          return new Promise((resolve) => {
            eventResolve = resolve
            signal.addEventListener(
              "abort",
              () => resolve({ done: true, value: undefined }),
              { once: true },
            )
          })
        },
      }),
    },
  } as unknown as Plugin.Context
  const cleanup = await plugin.setup(context)
  stop = cleanup ?? undefined
  const snapshot = () => rpc.snapshot!({})
  const ready = await snapshot()
  expect(ready.paths).toBeDefined()
  const ask = (
    id = "per_1",
    action = "shell",
    resources = ["git status"],
    sessionID = "ses_root",
  ) => {
    const request = {
      id,
      sessionID,
      action,
      resources,
      save: ["git status *"],
      metadata: { description: "inspect working tree" },
      source: { type: "tool", messageID: "msg_tools", id: "call_1" },
    } as PermissionRequest
    pending.set(id, request)
    emit({ type: "permission.asked", data: request, location: { directory } })
    return request
  }
  const settled = async (id = "per_1") =>
    until(async () => {
      const item = (await snapshot()).requests[id]
      return item && item.state !== "evaluating"
    })
  return {
    ask,
    settled,
    snapshot,
    replies,
    prompts,
    isolated,
    created,
    removed,
    pending,
    sessions,
    settingsPath,
    emit,
    async disconnect() {
      ended = true
      eventResolve?.({ done: true, value: undefined })
      eventResolve = undefined
      await Bun.sleep(20)
    },
    async answer(id: string) {
      pending.delete(id)
      emit({
        type: "permission.replied",
        data: { sessionID: "ses_root", requestID: id, reply: "once" },
      })
    },
  }
}

describe("native V2 approvals", () => {
  test("unblessed plugin options above the project root pause native approvals", async () => {
    const h = await setup()
    delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
    await fs.writeFile(
      path.join(sandbox, "opencode.json"),
      JSON.stringify({
        plugins: [
          { package: "@macarons/approve-for-me", options: { enabled: true } },
        ],
      }),
    )
    h.ask()
    await until(async () => (await h.snapshot()).server?.state === "paused")
    expect(h.prompts).toHaveLength(0)
    expect(h.replies).toHaveLength(0)
  })

  test("default agent and model resolve from the actual assistant when session pins are absent", async () => {
    const h = await setup()
    delete h.sessions.get("ses_root").agent
    delete h.sessions.get("ses_root").model
    h.ask()
    await until(() => h.replies.length === 1)
    expect(h.replies[0]?.decision).toBe("once")
  })

  test("RPC snapshots contain only protocol JSON values", async () => {
    const h = await setup()
    const snapshot = await h.snapshot()
    expect(snapshot).toStrictEqual(JSON.parse(JSON.stringify(snapshot)))
  })

  test("routine action approves once with isolated fixed policy and no tools", async () => {
    const h = await setup()
    h.ask()
    await until(() => h.replies.length === 1)
    expect(h.replies[0]?.decision).toBe("once")
    expect(h.isolated[0]?.system).toEqual([
      { type: "text", text: V2_CLASSIFIER_SYSTEM },
    ])
    expect(h.isolated[0]?.tools).toEqual({})
    expect(h.isolated[0]?.messages).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
    })
    expect(h.removed).toHaveLength(1)
  })
  test.each(["high", "critical"])(
    "%s risk remains manual even with claimed clear authorization",
    async (risk) => {
      const h = await setup({ risk, authorization: "clear" })
      h.ask()
      await h.settled()
      expect(h.prompts).toHaveLength(1)
      expect(h.replies).toHaveLength(0)
    },
  )
  test("medium implied work remains eligible", async () => {
    const h = await setup({ risk: "medium" })
    h.ask()
    await until(() => h.replies.length === 1)
  })
  test("medium work with no authorization remains manual", async () => {
    const h = await setup({ risk: "medium", authorization: "none" })
    h.ask()
    await h.settled()
    expect(h.replies).toHaveLength(0)
  })
  test.each(["ask", "deny"])(
    "explicit %s carve-out bypasses classifier",
    async (effect) => {
      const h = await setup({
        rules: [
          { action: "shell", resource: "*", effect: "ask" },
          { action: "shell", resource: "git status", effect },
        ],
      })
      h.ask()
      await h.settled()
      expect(h.prompts).toHaveLength(0)
      expect(h.replies).toHaveLength(0)
    },
  )
  test("session permission carve-out bypasses classifier", async () => {
    const h = await setup({
      sessionRules: [
        { action: "shell", resource: "git status", effect: "ask" },
      ],
    })
    h.ask()
    await h.settled()
    expect(h.prompts).toHaveLength(0)
  })
  test("missing agent data fails closed", async () => {
    const h = await setup({ missingAgent: true })
    h.ask()
    await h.settled()
    expect(h.prompts).toHaveLength(0)
    expect(h.replies).toHaveLength(0)
  })
  test("invalid model output stays manual", async () => {
    const h = await setup({ verdict: "approve, trust me" })
    h.ask()
    await h.settled()
    expect(h.replies).toHaveLength(0)
  })
  test("configured permission opt-out is never classified", async () => {
    const h = await setup({ settings: { permissions: { shell: false } } })
    h.ask()
    await h.settled()
    expect(h.prompts).toHaveLength(0)
  })
  test("disabled settings leave native permissions pending", async () => {
    const h = await setup({ settings: { enabled: false } })
    h.ask()
    await Bun.sleep(50)
    expect(h.prompts).toHaveLength(0)
    expect(h.replies).toHaveLength(0)
  })
  test("user answer racing classifier wins", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = await setup({ beforeGenerate: () => gate })
    h.ask()
    await until(() => h.prompts.length === 1)
    await h.answer("per_1")
    release()
    await until(() => h.removed.length === 1)
    expect(h.replies).toHaveLength(0)
  })
  test("settings changing while classifier runs veto the verdict", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = await setup({ beforeGenerate: () => gate })
    h.ask()
    await until(() => h.prompts.length === 1)
    await fs.writeFile(h.settingsPath, JSON.stringify({ enabled: false }))
    release()
    await h.settled()
    expect(h.replies).toHaveLength(0)
  })
  test("changed permission payload cannot reuse a verdict", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = await setup({ beforeGenerate: () => gate })
    const request = h.ask()
    await until(() => h.prompts.length === 1)
    h.pending.set(request.id, { ...request, resources: ["git push"] })
    release()
    await h.settled()
    expect(h.replies).toHaveLength(0)
  })
  test("event-stream loss prevents automatic approvals", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = await setup({ beforeGenerate: () => gate })
    h.ask()
    await until(() => h.prompts.length === 1)
    await h.disconnect()
    release()
    await until(() => h.removed.length === 1)
    expect(h.replies).toHaveLength(0)
    expect((await h.snapshot()).server.state).toBe("paused")
  })
  test("unrelated remote location events cannot approve", async () => {
    const h = await setup()
    h.emit({
      type: "permission.asked",
      location: { directory: "/different" },
      data: {
        id: "per_x",
        sessionID: "ses_root",
        action: "shell",
        resources: ["git status"],
      },
    })
    await Bun.sleep(50)
    expect(h.prompts).toHaveLength(0)
  })
  test("parallel batch verdicts are released in prompt order", async () => {
    const releases: Array<() => void> = []
    const h = await setup({
      beforeGenerate: () =>
        new Promise<void>((resolve) => releases.push(resolve)),
    })
    h.ask("per_1")
    h.ask("per_2")
    await until(() => releases.length === 2)
    releases[1]?.()
    await Bun.sleep(30)
    expect(h.replies).toHaveLength(0)
    releases[0]?.()
    await until(() => h.replies.length === 2)
    expect(h.replies.map((reply) => reply.requestID)).toEqual([
      "per_1",
      "per_2",
    ])
  })
  test("subagent approval retains root context and child rule scope", async () => {
    const h = await setup()
    h.ask("per_child", "shell", ["git status"], "ses_child")
    await until(() => h.replies.length === 1)
    expect(h.prompts[0]).toContain("Fix the project")
    expect(h.prompts[0]).toContain("Investigate the tests")
  })
  test("unknown ancestry holds the prompt without running a classifier", async () => {
    const h = await setup()
    h.sessions.get("ses_child").parentID = "ses_missing"
    h.ask("per_child", "shell", ["git status"], "ses_child")
    await until(async () => (await h.snapshot()).server?.state === "paused")
    expect(h.prompts).toHaveLength(0)
    expect(h.replies).toHaveLength(0)
  })
  test("protected configuration edits never reach the classifier", async () => {
    const h = await setup()
    h.ask("per_config", "edit", [h.settingsPath])
    await h.settled("per_config")
    expect(h.prompts).toHaveLength(0)
    expect(h.replies).toHaveLength(0)
  })
  test("session deletion invalidates an in-flight verdict", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = await setup({ beforeGenerate: () => gate })
    h.ask()
    await until(() => h.prompts.length === 1)
    h.sessions.delete("ses_root")
    h.emit({ type: "session.deleted", data: { sessionID: "ses_root" } })
    release()
    await until(() => h.removed.length === 1)
    expect(h.replies).toHaveLength(0)
  })
})

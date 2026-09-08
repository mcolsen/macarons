import { describe, expect, test } from "bun:test"
import {
  BAND_SAMPLE_VERSIONS as BAND,
  evaluate,
} from "@macarons/permission-rules"
import type { Plugin } from "@opencode-ai/plugin"
import type { OpencodeClient, PermissionRuleset } from "@opencode-ai/sdk/v2"
import { BtwPlugin } from "../src/index"
import {
  discardSideQuestion,
  LEASE_STALE_MS,
  markerFor,
  markerOf,
  resolveOptions,
  startSideQuestion,
  sweepOrphans,
} from "../src/shared"

type Call = { method: string; params: Record<string, unknown> }
type Result = { data?: unknown; error?: unknown }

type StubConfig = {
  parent?: {
    agent?: string
    model?: { id: string; providerID: string; variant?: string }
    metadata?: unknown
    permission?: PermissionRuleset
  }
  messages?: {
    info: {
      id: string
      role: string
      time?: { completed?: number }
      model?: { providerID: string; modelID: string; variant?: string }
    }
  }[]
  /** What the fork's own message list returns — fresh IDs, like the real host. */
  forkMessages?: {
    info: { id: string; role: string; time?: { completed?: number } }
  }[]
  forkID?: string
  agents?: {
    name: string
    permission: PermissionRuleset
    mode?: string
    hidden?: boolean
  }[]
  defaultAgent?: string
  sessions?: { id: string; metadata?: unknown }[]
  promptTransportError?: Error
  persistPromptBeforeTransportError?: boolean
  fail?: Partial<
    Record<
      | "get"
      | "agents"
      | "config"
      | "messages"
      | "fork"
      | "update"
      | "promptAsync"
      | "delete"
      | "list",
      unknown
    >
  >
}

function makeClient(config: StubConfig = {}) {
  const calls: Call[] = []
  const persistedPromptIDs = new Set<string>()
  const record = (
    method: string,
    params: Record<string, unknown>,
    result: Result,
  ): Promise<Result> => {
    calls.push({ method, params })
    const failure = config.fail?.[method as keyof typeof config.fail]
    return Promise.resolve(failure !== undefined ? { error: failure } : result)
  }
  const forkID = config.forkID ?? "ses_fork"
  const session = {
    get: (params: Record<string, unknown>) =>
      record("get", params, {
        data: {
          id: params.sessionID,
          agent: config.parent?.agent,
          model: config.parent?.model,
          metadata: config.parent?.metadata,
          permission: config.parent?.permission,
        },
      }),
    messages: (params: Record<string, unknown>) =>
      record("messages", params, {
        data:
          params.sessionID === forkID
            ? (config.forkMessages ?? [])
            : (config.messages ?? []),
      }),
    fork: (params: Record<string, unknown>) =>
      record("fork", params, { data: { id: forkID } }),
    update: (params: Record<string, unknown>) =>
      record("update", params, { data: { id: params.sessionID } }),
    promptAsync: async (params: Record<string, unknown>) => {
      const result = await record("promptAsync", params, { data: {} })
      if (config.promptTransportError) {
        if (
          config.persistPromptBeforeTransportError &&
          typeof params.messageID === "string"
        )
          persistedPromptIDs.add(params.messageID)
        throw config.promptTransportError
      }
      return result
    },
    message: (params: Record<string, unknown>) =>
      record("message", params, {
        data: persistedPromptIDs.has(String(params.messageID))
          ? { info: { id: params.messageID } }
          : undefined,
      }),
    delete: (params: Record<string, unknown>) =>
      record("delete", params, { data: true }),
    abort: (params: Record<string, unknown>) =>
      record("abort", params, { data: true }),
    list: (params: Record<string, unknown>) =>
      record("list", params, { data: config.sessions ?? [] }),
  }
  return {
    client: {
      session,
      app: {
        agents: (params: Record<string, unknown>) =>
          record("agents", params, {
            data: config.agents ?? [
              {
                name: "build",
                mode: "primary",
                permission: [
                  { permission: "*", pattern: "*", action: "allow" },
                ],
              },
            ],
          }),
      },
      config: {
        get: (params: Record<string, unknown>) =>
          record("config", params, {
            data: { default_agent: config.defaultAgent },
          }),
      },
    } as unknown as OpencodeClient,
    calls,
    forkID,
  }
}

const only = (calls: Call[], method: string) =>
  calls.filter((call) => call.method === method)
const one = (calls: Call[], method: string) => {
  const matches = only(calls, method)
  expect(matches).toHaveLength(1)
  return matches[0]!.params
}

const defaultVariantMessages = (
  variant?: "default",
): NonNullable<StubConfig["messages"]> => [
  {
    info: {
      id: "msg_01",
      role: "user",
      model: {
        providerID: "p",
        modelID: "m",
        ...(variant === undefined ? {} : { variant }),
      },
    },
  },
  { info: { id: "msg_02", role: "assistant", time: { completed: 5 } } },
]

describe("startSideQuestion", () => {
  const base = {
    parent: {
      agent: "build",
      model: { id: "claude-sonnet-5", providerID: "anthropic" },
    },
    messages: [
      { info: { id: "msg_01", role: "user" } },
      { info: { id: "msg_02", role: "assistant", time: { completed: 5 } } },
      { info: { id: "msg_03", role: "user" } },
      { info: { id: "msg_04", role: "assistant" } }, // in-flight
    ],
    // The fork's copies of msg_01–msg_03 — fresh IDs, like the real host mints.
    forkMessages: [
      { info: { id: "msg_90", role: "user" } },
      { info: { id: "msg_91", role: "assistant", time: { completed: 5 } } },
      { info: { id: "msg_92", role: "user" } },
    ],
  }

  test("forks at the in-flight boundary and asks in a marked, guarded fork", async () => {
    const { client, calls, forkID } = makeClient(base)
    const started = await startSideQuestion(client, {
      directory: "/repo",
      parentID: "ses_parent",
      question: "why backoff?",
      options: { ...resolveOptions(undefined) },
      now: 1000,
    })

    expect(started.sessionID).toBe(forkID)
    expect(started.hasContext).toBe(true)
    // The boundary is the fork's own last copy (fresh IDs), read before asking.
    expect(started.lastCopiedMessageID).toBe("msg_92")
    const forkRead = calls.findIndex(
      (call) => call.method === "messages" && call.params.sessionID === forkID,
    )
    const asked = calls.findIndex((call) => call.method === "promptAsync")
    expect(forkRead).toBeGreaterThanOrEqual(0)
    expect(forkRead).toBeLessThan(asked)

    // Fork bounded at the in-flight assistant.
    expect(one(calls, "fork").messageID).toBe("msg_04")

    // Marked + guarded in one update. The lease starts at creation time; the
    // owning TUI heartbeats it fresh from there.
    const update = one(calls, "update")
    expect(markerOf(update.metadata)).toEqual({
      parent: "ses_parent",
      tools: "read-only",
      created: 1000,
      lease: 1000,
    })
    expect(started.marker).toEqual({
      parent: "ses_parent",
      tools: "read-only",
      created: 1000,
      lease: 1000,
    })
    expect(update.permission).toBeDefined()
    expect(String(update.title)).toContain("btw:")

    // Prompted on the parent's agent/model, question in the USER part (never system).
    const prompt = one(calls, "promptAsync")
    expect(prompt.sessionID).toBe(forkID)
    expect(prompt.messageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(Number.parseInt(String(prompt.messageID).slice(13, 16), 16)).toBe(0)
    expect(started.promptMessageID).toBe(prompt.messageID as string)
    expect(started.promptOutcome).toBe("accepted")
    expect(prompt.agent).toBe("build")
    expect(prompt.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-5",
    })
    expect(prompt).not.toHaveProperty("system")
    const parts = prompt.parts as { type: string; text: string }[]
    const [first] = parts
    expect(first?.type).toBe("text")
    expect(first?.text).toContain("<side-question>")
    expect(first?.text).toContain("why backoff?")
  })

  test("the actual fork rules and server guard jointly enforce inherited confidentiality and read-only access", async () => {
    const agentPermission: PermissionRuleset = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "read", pattern: "private/**", action: "deny" },
      { permission: "read", pattern: "private/public.md", action: "allow" },
      { permission: "glob", pattern: "**/*.pem", action: "deny" },
    ]
    const sessionPermission: PermissionRuleset = [
      { permission: "read", pattern: "inherited/**", action: "deny" },
      { permission: "read", pattern: "private/*.env.example", action: "deny" },
      { permission: "read", pattern: "review/**", action: "ask" },
      { permission: "glob", pattern: "inherited/**", action: "deny" },
    ]
    const { client, calls, forkID } = makeClient({
      ...base,
      agents: [{ name: "build", permission: agentPermission }],
      parent: { ...base.parent, permission: sessionPermission },
    })
    await startSideQuestion(client, {
      directory: "/repo",
      parentID: "ses_parent",
      question: "q",
      options: resolveOptions(undefined),
    })
    const update = one(calls, "update")
    const rules = update.permission as PermissionRuleset
    const replies: unknown[] = []
    const hooks = await BtwPlugin({
      directory: "/repo",
      worktree: "/repo",
      serverUrl: new URL("http://127.0.0.1:65535"),
      client: {
        _client: { get: async () => ({ data: { version: BAND.floor } }) },
        app: { log: async () => ({}) },
        postSessionIdPermissionsPermissionId: async (reply: unknown) => {
          replies.push(reply)
          return {}
        },
      },
    } as unknown as Parameters<Plugin>[0])
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: forkID, metadata: update.metadata } },
      },
    } as never)
    const gate = (tool: string, args: unknown) =>
      hooks["tool.execute.before"]!(
        { tool, sessionID: forkID, callID: "call_1" },
        { args },
      )

    // Read/glob pass the real tool-ID guard, so the effective fork rules must
    // stop arbitrary denied paths. The mock fork copies no session permissions.
    for (const [tool, pattern] of [
      ["read", "private/signing-key.pem"],
      ["read", "inherited/key.pem"],
      ["read", "private/.env.example"],
      ["glob", "**/*.pem"],
      ["glob", "inherited/**"],
    ]) {
      await expect(
        gate(tool!, { filePath: pattern, pattern }),
      ).resolves.toBeUndefined()
      expect(evaluate(tool!, pattern!, rules)).toBe("deny")
    }
    for (const filePath of [
      "src/main.ts",
      "private/public.md",
      ".env.example",
    ]) {
      await expect(gate("read", { filePath })).resolves.toBeUndefined()
      expect(evaluate("read", filePath, rules)).toBe("allow")
    }
    expect(evaluate("glob", "src/**/*.ts", rules)).toBe("allow")

    expect(evaluate("read", "review/draft.md", rules)).toBe("ask")
    await hooks.event?.({
      event: {
        type: "permission.asked",
        properties: {
          id: "per_read",
          sessionID: forkID,
          permission: "read",
          patterns: ["review/draft.md"],
        },
      },
    } as never)
    expect(replies).toEqual([
      {
        path: { id: forkID, permissionID: "per_read" },
        body: { response: "reject" },
        query: { directory: "/repo" },
      },
    ])

    for (const filePath of [".env", "config/.env.production"]) {
      expect(evaluate("read", filePath, rules)).toBe("deny")
      await expect(gate("read", { filePath })).rejects.toThrow(/env files/)
    }
    expect(evaluate("read", "mcp:server:private/key", rules)).toBe("deny")
    for (const tool of [
      "read_mcp_resource",
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "edit",
      "bash",
      "grep",
      "some_plugin_tool",
    ]) {
      await expect(gate(tool, {})).rejects.toThrow(/read-only/)
    }
    expect(one(calls, "agents").directory).toBe("/repo")
    expect(calls.findIndex((call) => call.method === "agents")).toBeLessThan(
      calls.findIndex((call) => call.method === "fork"),
    )
    expect(one(calls, "promptAsync").agent).toBe("build")
    expect(
      only(calls, "update").every((call) => call.params.sessionID === forkID),
    ).toBe(true)
  })

  test("resolves an unstored agent from config and pins that same agent on the prompt", async () => {
    const { client, calls } = makeClient({
      ...base,
      parent: { model: base.parent.model },
      defaultAgent: "custom",
      agents: [
        {
          name: "custom",
          mode: "all",
          permission: [{ permission: "read", pattern: "*", action: "deny" }],
        },
      ],
    })
    await startSideQuestion(client, {
      directory: "/repo",
      parentID: "ses_parent",
      question: "q",
      options: resolveOptions(undefined),
    })
    expect(one(calls, "config").directory).toBe("/repo")
    expect(one(calls, "promptAsync").agent).toBe("custom")
    expect(
      evaluate(
        "read",
        "private/key.pem",
        one(calls, "update").permission as PermissionRuleset,
      ),
    ).toBe("deny")
  })

  for (const failure of [
    { fail: { agents: "unavailable" } },
    { parent: {}, fail: { config: "unavailable" } },
    { agents: [] },
    {
      parent: {},
      agents: [{ name: "other", mode: "primary", permission: [] }],
    },
  ]) {
    test(`fails before forking when parent policy cannot be resolved: ${JSON.stringify(failure)}`, async () => {
      const { client, calls } = makeClient({ ...base, ...failure })
      await expect(
        startSideQuestion(client, {
          directory: "/repo",
          parentID: "ses_parent",
          question: "q",
          options: resolveOptions(undefined),
        }),
      ).rejects.toThrow()
      expect(only(calls, "fork")).toHaveLength(0)
      expect(only(calls, "promptAsync")).toHaveLength(0)
    })
  }

  for (const { name, messageVariant, expected } of [
    {
      name: 'strips the inherited host "default" sentinel from the initial prompt',
      messageVariant: undefined,
      expected: undefined,
    },
    {
      name: 'preserves a literal "default" variant in the initial prompt',
      messageVariant: "default",
      expected: "default",
    },
  ] as const) {
    test(name, async () => {
      const { client, calls } = makeClient({
        parent: {
          agent: "build",
          model: { id: "m", providerID: "p", variant: "default" },
        },
        messages: defaultVariantMessages(messageVariant),
      })

      const started = await startSideQuestion(client, {
        directory: "/repo",
        parentID: "ses_parent",
        question: "q",
        options: resolveOptions(undefined),
      })

      expect(started.target.variant).toBe(expected)
      expect(one(calls, "promptAsync").variant).toBe(expected)
    })
  }

  test("copies everything when the parent is idle (no in-flight turn)", async () => {
    const { client, calls } = makeClient({
      parent: base.parent,
      messages: [
        { info: { id: "msg_01", role: "user" } },
        { info: { id: "msg_02", role: "assistant", time: { completed: 5 } } },
      ],
      forkMessages: [
        { info: { id: "msg_90", role: "user" } },
        { info: { id: "msg_91", role: "assistant", time: { completed: 5 } } },
      ],
    })
    const started = await startSideQuestion(client, {
      directory: "/repo",
      parentID: "ses_parent",
      question: "q",
      options: resolveOptions(undefined),
    })
    expect(one(calls, "fork").messageID).toBeUndefined()
    expect(started.lastCopiedMessageID).toBe("msg_91")
  })

  test("reports no context for an empty session without asking", async () => {
    const { client, calls } = makeClient({ parent: base.parent, messages: [] })
    const started = await startSideQuestion(client, {
      directory: "/repo",
      parentID: "ses_parent",
      question: "q",
      options: resolveOptions(undefined),
    })
    expect(started.hasContext).toBe(false)
    // The fork was still created (caller decides to discard it); no prompt
    // sent, and the fork's messages are never read.
    expect(only(calls, "promptAsync")).toHaveLength(0)
    expect(only(calls, "messages")).toHaveLength(1)
  })

  test("deletes the fork when the host definitively rejects the initial prompt", async () => {
    const { client, calls } = makeClient({
      ...base,
      fail: { promptAsync: { name: "boom" } },
    })
    await expect(
      startSideQuestion(client, {
        directory: "/repo",
        parentID: "ses_parent",
        question: "q",
        options: resolveOptions(undefined),
      }),
    ).rejects.toThrow()
    // The just-created fork is cleaned up rather than leaked.
    expect(one(calls, "delete").sessionID).toBe("ses_fork")
  })

  test("keeps the fork when the initial prompt persisted before its response was lost", async () => {
    const { client, calls } = makeClient({
      ...base,
      promptTransportError: new Error("socket closed"),
      persistPromptBeforeTransportError: true,
    })
    const started = await startSideQuestion(client, {
      directory: "/repo",
      parentID: "ses_parent",
      question: "q",
      options: resolveOptions(undefined),
      confirmDelaysMs: [],
    })

    const prompt = one(calls, "promptAsync")
    expect(started.promptMessageID).toBe(prompt.messageID as string)
    expect(started.promptOutcome).toBe("accepted")
    expect(one(calls, "message").messageID).toBe(prompt.messageID)
    expect(only(calls, "delete")).toHaveLength(0)
  })

  test("keeps an ambiguously delivered initial prompt without inviting a retry", async () => {
    const { client, calls } = makeClient({
      ...base,
      promptTransportError: new Error("socket closed"),
    })
    const started = await startSideQuestion(client, {
      directory: "/repo",
      parentID: "ses_parent",
      question: "q",
      options: resolveOptions(undefined),
      confirmDelaysMs: [],
    })

    expect(started.promptOutcome).toBe("ambiguous")
    expect(only(calls, "delete")).toHaveLength(0)
  })

  test("bounds a hung confirmation lookup and preserves the ambiguous fork", async () => {
    const { client, calls } = makeClient({
      ...base,
      promptTransportError: new Error("socket closed"),
    })
    let lookupSignal: AbortSignal | undefined
    client.session.message = ((
      _params: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      lookupSignal = options?.signal
      return new Promise((_resolve, reject) => {
        lookupSignal?.addEventListener(
          "abort",
          () => reject(new Error("lookup aborted")),
          { once: true },
        )
      })
    }) as typeof client.session.message

    const started = await startSideQuestion(client, {
      directory: "/repo",
      parentID: "ses_parent",
      question: "q",
      options: resolveOptions(undefined),
      confirmDelaysMs: [],
      confirmLookupTimeoutMs: 10,
    })

    expect(started.promptOutcome).toBe("ambiguous")
    expect(lookupSignal?.aborted).toBe(true)
    expect(only(calls, "delete")).toHaveLength(0)
  })

  test("onBeforePrompt fires with the prepared fork before the prompt is sent", async () => {
    const { client, calls } = makeClient(base)
    let seen:
      | {
          promptsSoFar: number
          sessionID: string
          boundary: string | undefined
        }
      | undefined
    await startSideQuestion(client, {
      directory: "/repo",
      parentID: "ses_parent",
      question: "q",
      options: resolveOptions(undefined),
      onBeforePrompt: (started) => {
        seen = {
          promptsSoFar: only(calls, "promptAsync").length,
          sessionID: started.sessionID,
          boundary: started.lastCopiedMessageID,
        }
      },
    })
    // Everything a caller needs to route events was already resolved…
    expect(seen?.sessionID).toBe("ses_fork")
    expect(seen?.boundary).toBe("msg_92")
    // …and the prompt had not yet been fired when it saw them.
    expect(seen?.promptsSoFar).toBe(0)
    expect(only(calls, "promptAsync")).toHaveLength(1)
  })

  test("onBeforePrompt is skipped when there is no context to ask about", async () => {
    const { client } = makeClient({ parent: base.parent, messages: [] })
    let called = false
    await startSideQuestion(client, {
      directory: "/repo",
      parentID: "ses_parent",
      question: "q",
      options: resolveOptions(undefined),
      onBeforePrompt: () => {
        called = true
      },
    })
    expect(called).toBe(false)
  })

  test("a failing prompt still deletes the fork after onBeforePrompt fired", async () => {
    // The documented contract: the callback may have installed event routing;
    // on failure the fork is deleted and the error rethrown, so the caller
    // must tear that routing down in its own error handling.
    const { client, calls } = makeClient({
      ...base,
      fail: { promptAsync: { name: "boom" } },
    })
    let called = false
    await expect(
      startSideQuestion(client, {
        directory: "/repo",
        parentID: "ses_parent",
        question: "q",
        options: resolveOptions(undefined),
        onBeforePrompt: () => {
          called = true
        },
      }),
    ).rejects.toThrow()
    expect(called).toBe(true)
    expect(one(calls, "delete").sessionID).toBe("ses_fork")
  })
})

describe("discardSideQuestion", () => {
  test("aborts then deletes when asked", async () => {
    const { client, calls } = makeClient()
    const ok = await discardSideQuestion(client, {
      directory: "/repo",
      sessionID: "ses_fork",
      abort: true,
    })
    expect(ok).toBe(true)
    expect(only(calls, "abort")).toHaveLength(1)
    expect(only(calls, "delete")).toHaveLength(1)
  })

  test("never throws on a delete failure", async () => {
    const { client } = makeClient({ fail: { delete: { name: "gone" } } })
    expect(
      await discardSideQuestion(client, {
        directory: "/repo",
        sessionID: "ses_fork",
      }),
    ).toBe(false)
  })
})

describe("sweepOrphans", () => {
  const now = 10_000_000
  const marked = (lease: number) =>
    markerFor({ parent: "ses_p", tools: "read-only", created: 1, lease })

  test("deletes only marked forks whose lease has gone provably stale", async () => {
    const { client, calls } = makeClient({
      sessions: [
        { id: "ses_normal", metadata: {} },
        { id: "ses_stale_fork", metadata: marked(now - LEASE_STALE_MS - 1) },
        // A fork owned by a live TUI — this one or another instance on the
        // same project — heartbeats its lease fresh; never swept.
        { id: "ses_live_fork", metadata: marked(now - 1_000) },
      ],
    })
    const swept = await sweepOrphans(client, "/repo", now)
    expect(swept).toBe(1)
    const deletes = only(calls, "delete").map((call) => call.params.sessionID)
    expect(deletes).toEqual(["ses_stale_fork"])
  })

  test("foreign metadata that merely looks marker-ish is never deleted", async () => {
    // Session metadata is an arbitrary shared record; deletion may only key
    // off the full namespaced, versioned, validated marker.
    const { client, calls } = makeClient({
      sessions: [
        {
          id: "ses_foreign",
          metadata: { btw: { parent: "x", tools: "read-only", created: 1 } },
        },
        {
          id: "ses_partial",
          metadata: { "@macarons/btw": { parent: "x" } },
        },
      ],
    })
    expect(await sweepOrphans(client, "/repo", now)).toBe(0)
    expect(only(calls, "delete")).toHaveLength(0)
  })

  test("returns 0 and never throws when listing fails", async () => {
    const { client } = makeClient({ fail: { list: { name: "nope" } } })
    expect(await sweepOrphans(client, "/repo", now)).toBe(0)
  })
})

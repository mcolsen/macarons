import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import type { Plugin } from "@opencode-ai/plugin"
import { BtwPlugin } from "../src/index"
import { markerFor } from "../src/shared"

// The probe's last resort is a raw fetch of serverUrl; keep every test off
// the network — the standalone TUI never binds that URL anyway.
let fetchSpy: ReturnType<typeof spyOn> | undefined

afterEach(() => {
  fetchSpy?.mockRestore()
  fetchSpy = undefined
})

function mockDeadNetwork() {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() =>
    Promise.reject(
      new Error("Unable to connect"),
    )) as unknown as typeof globalThis.fetch)
  return fetchSpy
}

type Reply = { id: string; permissionID: string; response: string }
type SessionGetResult = { data?: unknown; error?: unknown }
type SessionGetReply = SessionGetResult | Error | Promise<SessionGetResult>

// The slice of the v1 plugin client the server half touches.
function makeClient(
  input: {
    version?: string | null
    metadataBySession?: Record<string, unknown>
    sessionGetReplies?: SessionGetReply[]
  } = {},
) {
  const version = "version" in input ? input.version : BAND.floor
  const metadataBySession = input.metadataBySession ?? {}
  const logs: { level: string; message: string }[] = []
  const replies: Reply[] = []
  const gets: string[] = []
  const sessionGetSignals: AbortSignal[] = []
  const sessionGetReplies = [...(input.sessionGetReplies ?? [])]

  const client = {
    app: {
      log: async (options: { body: { level: string; message: string } }) => {
        logs.push({ level: options.body.level, message: options.body.message })
        return { data: undefined }
      },
    },
    // The client the 1.17.18 binary hands to plugins has no global.health —
    // the version probe goes through the raw _client transport, which the
    // host wires for in-process dispatch even in the standalone TUI.
    _client: {
      get: async (_options: { url: string }) =>
        version === null ? { data: {} } : { data: { version } },
    },
    global: { event: () => {} },
    session: {
      get: async (options: { path: { id: string }; signal?: AbortSignal }) => {
        gets.push(options.path.id)
        if (options.signal) sessionGetSignals.push(options.signal)
        const reply = sessionGetReplies.shift()
        if (reply instanceof Error) throw reply
        if (reply) return reply
        return {
          data: {
            id: options.path.id,
            metadata: metadataBySession[options.path.id],
          },
        }
      },
    },
    postSessionIdPermissionsPermissionId: async (options: {
      path: { id: string; permissionID: string }
      body: { response: string }
    }) => {
      replies.push({
        id: options.path.id,
        permissionID: options.path.permissionID,
        response: options.body.response,
      })
      return { data: undefined }
    },
  }

  return {
    client: client as unknown as Parameters<Plugin>[0]["client"],
    logs,
    replies,
    gets,
    sessionGetSignals,
  }
}

async function load(client: ReturnType<typeof makeClient>["client"]) {
  return BtwPlugin({
    client,
    directory: "/repo",
    worktree: "/repo",
    serverUrl: new URL("http://127.0.0.1:65535"),
  } as unknown as Parameters<Plugin>[0])
}

const forkMarker = markerFor({
  parent: "ses_parent",
  tools: "read-only",
  created: 1,
  lease: 1,
})

describe("version guard", () => {
  // A v1 host outside the verified band (older, a newer minor, or unreadable)
  // warns but keeps running — the hooks are real, not the inert {}.
  for (const version of [BAND.belowBand, BAND.aboveBand, null]) {
    test(`warns but runs on untested ${String(version)}`, async () => {
      mockDeadNetwork()
      const harness = makeClient({ version })
      const hooks = await load(harness.client)
      expect(typeof hooks["chat.params"]).toBe("function")
      expect(
        harness.logs.some(
          (entry) =>
            entry.level === "warn" && entry.message.includes("Running anyway"),
        ),
      ).toBe(true)
    })
  }

  // A non-v1 host (OpenCode v2+, whose plugin API differs) disables btw.
  for (const version of ["2.0.0", "2.0.0-beta.1"]) {
    test(`disables on incompatible ${version}`, async () => {
      mockDeadNetwork()
      const harness = makeClient({ version })
      const hooks = await load(harness.client)
      expect(hooks).toEqual({})
      expect(
        harness.logs.some(
          (entry) =>
            entry.level === "warn" && entry.message.includes("disabled"),
        ),
      ).toBe(true)
    })
  }

  // The standalone TUI never binds serverUrl, so raw fetch cannot reach the
  // host there; the probe must succeed through the client's own transport
  // without ever touching the network.
  test("probes the version through the SDK transport, not the network", async () => {
    const spy = mockDeadNetwork()
    const harness = makeClient()
    const hooks = await load(harness.client)

    expect(typeof hooks["chat.params"]).toBe("function")
    expect(spy).not.toHaveBeenCalled()
    expect(harness.logs.filter((entry) => entry.level === "warn")).toEqual([])
  })
})

describe("chat.params cache-key rewrite", () => {
  test("rewrites a marked fork's cache key to its parent", async () => {
    const harness = makeClient()
    const hooks = await load(harness.client)
    // Learn the fork from a session event first (fast path).
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: forkMarker } },
      },
    } as never)
    const output = { options: {} as Record<string, unknown> }
    await hooks["chat.params"]?.(
      { sessionID: "ses_fork" } as never,
      output as never,
    )
    expect(output.options.promptCacheKey).toBe("ses_parent")
    expect(output.options.prompt_cache_key).toBe("ses_parent")
    expect(harness.gets).toHaveLength(0) // served from the event cache, no lookup
  })

  test("leaves a normal session untouched", async () => {
    const harness = makeClient({ metadataBySession: { ses_normal: {} } })
    const hooks = await load(harness.client)
    const output = { options: {} as Record<string, unknown> }
    await hooks["chat.params"]?.(
      { sessionID: "ses_normal" } as never,
      output as never,
    )
    expect(output.options).toEqual({})
  })

  test("falls back to one lazy lookup when the event has not arrived yet", async () => {
    const harness = makeClient({ metadataBySession: { ses_fork: forkMarker } })
    const hooks = await load(harness.client)
    const output = { options: {} as Record<string, unknown> }
    await hooks["chat.params"]?.(
      { sessionID: "ses_fork" } as never,
      output as never,
    )
    expect(output.options.promptCacheKey).toBe("ses_parent")
    // A second call is served from cache — the lookup happens at most once.
    await hooks["chat.params"]?.(
      { sessionID: "ses_fork" } as never,
      { options: {} } as never,
    )
    expect(harness.gets).toEqual(["ses_fork"])
  })

  test("caches a normal session negatively so it is looked up at most once", async () => {
    const harness = makeClient({ metadataBySession: { ses_normal: {} } })
    const hooks = await load(harness.client)
    await hooks["chat.params"]?.(
      { sessionID: "ses_normal" } as never,
      { options: {} } as never,
    )
    await hooks["chat.params"]?.(
      { sessionID: "ses_normal" } as never,
      { options: {} } as never,
    )
    expect(harness.gets).toEqual(["ses_normal"])
  })

  test("only negatively caches structurally valid unmarked session responses", async () => {
    const harness = makeClient({
      sessionGetReplies: [
        {},
        { data: { metadata: {} } },
        { data: { id: "ses_other", metadata: {} } },
        { data: { id: "ses_normal", metadata: {} } },
      ],
    })
    const hooks = await load(harness.client)
    for (let call = 0; call < 5; call++) {
      await hooks["chat.params"]?.(
        { sessionID: "ses_normal" } as never,
        { options: {} } as never,
      )
    }
    expect(harness.gets).toEqual([
      "ses_normal",
      "ses_normal",
      "ses_normal",
      "ses_normal",
    ])
  })

  test("preserves a newer unmarked event over an in-flight marked lookup", async () => {
    let resolveLookup: (result: SessionGetResult) => void = () => {}
    const lookup = new Promise<SessionGetResult>((resolve) => {
      resolveLookup = resolve
    })
    const harness = makeClient({ sessionGetReplies: [lookup] })
    const hooks = await load(harness.client)
    const output = { options: {} as Record<string, unknown> }
    const pending = hooks["chat.params"]?.(
      { sessionID: "ses_fork" } as never,
      output as never,
    )
    expect(harness.gets).toEqual(["ses_fork"])

    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: {} } },
      },
    } as never)
    resolveLookup({ data: { id: "ses_fork", metadata: forkMarker } })
    await pending

    expect(output.options).toEqual({})
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "edit", sessionID: "ses_fork", callID: "call_1" } as never,
        { args: {} } as never,
      ),
    ).resolves.toBeUndefined()
    expect(harness.gets).toEqual(["ses_fork"])
  })

  test("preserves a newer marked event over an in-flight unmarked lookup", async () => {
    let resolveLookup: (result: SessionGetResult) => void = () => {}
    const lookup = new Promise<SessionGetResult>((resolve) => {
      resolveLookup = resolve
    })
    const harness = makeClient({ sessionGetReplies: [lookup] })
    const hooks = await load(harness.client)
    const output = { options: {} as Record<string, unknown> }
    const pending = hooks["chat.params"]?.(
      { sessionID: "ses_fork" } as never,
      output as never,
    )
    expect(harness.gets).toEqual(["ses_fork"])

    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: forkMarker } },
      },
    } as never)
    resolveLookup({ data: { id: "ses_fork", metadata: {} } })
    await pending

    expect(output.options.promptCacheKey).toBe("ses_parent")
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "edit", sessionID: "ses_fork", callID: "call_1" } as never,
        { args: {} } as never,
      ),
    ).rejects.toThrow(/read-only/)
    expect(harness.gets).toEqual(["ses_fork"])
  })
})

describe("permission auto-deny", () => {
  test("rejects any permission prompt inside a marked fork", async () => {
    const harness = makeClient()
    const hooks = await load(harness.client)
    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_fork", metadata: forkMarker } },
      },
    } as never)
    await hooks.event?.({
      event: {
        type: "permission.asked",
        properties: { id: "per_1", sessionID: "ses_fork", permission: "edit" },
      },
    } as never)
    expect(harness.replies).toEqual([
      { id: "ses_fork", permissionID: "per_1", response: "reject" },
    ])
  })

  test("never touches a normal session's prompts", async () => {
    const harness = makeClient({ metadataBySession: { ses_normal: {} } })
    const hooks = await load(harness.client)
    await hooks.event?.({
      event: {
        type: "permission.asked",
        properties: {
          id: "per_1",
          sessionID: "ses_normal",
          permission: "bash",
        },
      },
    } as never)
    expect(harness.replies).toHaveLength(0)
  })

  test("stops guarding a fork once its marker is cleared (adopted)", async () => {
    const harness = makeClient()
    const hooks = await load(harness.client)
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: forkMarker } },
      },
    } as never)
    // Adoption clears the marker.
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: {} } },
      },
    } as never)
    await hooks.event?.({
      event: {
        type: "permission.asked",
        properties: { id: "per_1", sessionID: "ses_fork", permission: "edit" },
      },
    } as never)
    // No mark and (because it was dropped) a fresh lookup returns no marker.
    expect(harness.replies).toHaveLength(0)
  })
})

describe("tool.execute.before hard gate", () => {
  // Session "ask" rules only gate tools that request permission; a plugin
  // tool that never calls ctx.ask would otherwise run unchecked. The hook
  // fires for builtin, MCP, and plugin tools alike, so a marked fork refuses
  // everything outside the read-only allowlist by failing the tool call.
  const gate = async (
    hooks: Awaited<ReturnType<typeof load>>,
    sessionID: string,
    tool: string,
    args: unknown = {},
  ) =>
    hooks["tool.execute.before"]?.(
      { tool, sessionID, callID: "call_1" } as never,
      { args } as never,
    )

  const executeThroughGate = async (
    hooks: Awaited<ReturnType<typeof load>>,
    execute: () => void,
  ) => {
    await gate(hooks, "ses_fork", "edit")
    execute()
  }

  test("fails closed after a thrown marker lookup and re-resolves the marked fork", async () => {
    const harness = makeClient({
      sessionGetReplies: [
        new Error("transport unavailable"),
        { data: { id: "ses_fork", metadata: forkMarker } },
      ],
    })
    const hooks = await load(harness.client)
    let writes = 0

    await expect(
      executeThroughGate(hooks, () => {
        writes++
      }),
    ).rejects.toThrow(/marker lookup was unavailable/)
    expect(writes).toBe(0)

    const output = { options: {} as Record<string, unknown> }
    await hooks["chat.params"]?.(
      { sessionID: "ses_fork" } as never,
      output as never,
    )
    expect(output.options.promptCacheKey).toBe("ses_parent")
    expect(output.options.prompt_cache_key).toBe("ses_parent")
    expect(harness.gets).toEqual(["ses_fork", "ses_fork"])
  })

  test("fails closed after a resolved-error marker lookup and re-resolves the marked fork", async () => {
    const harness = makeClient({
      sessionGetReplies: [
        { error: new Error("session unavailable") },
        { data: { id: "ses_fork", metadata: forkMarker } },
      ],
    })
    const hooks = await load(harness.client)
    let writes = 0

    await expect(
      executeThroughGate(hooks, () => {
        writes++
      }),
    ).rejects.toThrow(/marker lookup was unavailable/)
    expect(writes).toBe(0)

    const output = { options: {} as Record<string, unknown> }
    await hooks["chat.params"]?.(
      { sessionID: "ses_fork" } as never,
      output as never,
    )
    expect(output.options.promptCacheKey).toBe("ses_parent")
    expect(output.options.prompt_cache_key).toBe("ses_parent")
    expect(harness.gets).toEqual(["ses_fork", "ses_fork"])
  })

  test("fails closed when marker lookup times out and retries later", async () => {
    const never = new Promise<SessionGetResult>(() => {})
    const harness = makeClient({
      sessionGetReplies: [
        never,
        { data: { id: "ses_fork", metadata: forkMarker } },
      ],
    })
    const hooks = await load(harness.client)

    await expect(gate(hooks, "ses_fork", "edit")).rejects.toThrow(
      /marker lookup was unavailable/,
    )
    expect(harness.sessionGetSignals[0]?.aborted).toBe(true)

    const output = { options: {} as Record<string, unknown> }
    await hooks["chat.params"]?.(
      { sessionID: "ses_fork" } as never,
      output as never,
    )
    expect(output.options.promptCacheKey).toBe("ses_parent")
    expect(harness.gets).toEqual(["ses_fork", "ses_fork"])
  }, 15_000)

  test("does not trust an unmarked creation when the marking event is missed", async () => {
    const harness = makeClient({ metadataBySession: { ses_fork: forkMarker } })
    const hooks = await load(harness.client)
    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_fork", metadata: {} } },
      },
    } as never)

    await expect(gate(hooks, "ses_fork", "edit")).rejects.toThrow(/read-only/)
    expect(harness.gets).toEqual(["ses_fork"])
  })

  test("lets a marked fork run read-only tools", async () => {
    const harness = makeClient()
    const hooks = await load(harness.client)
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: forkMarker } },
      },
    } as never)
    for (const tool of ["read", "glob"]) {
      await expect(gate(hooks, "ses_fork", tool)).resolves.toBeUndefined()
    }
  })

  test("the MCP resource readers are refused — their content comes from external servers", async () => {
    // They ask under "read" with mcp:* patterns (re-gated in the session
    // rules), so the ID gate must refuse them too or a foreign approval
    // out-racing the reject would still fetch from an MCP server.
    const harness = makeClient()
    const hooks = await load(harness.client)
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: forkMarker } },
      },
    } as never)
    for (const tool of [
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
    ]) {
      await expect(gate(hooks, "ses_fork", tool)).rejects.toThrow(/read-only/)
    }
  })

  test("grep is refused whatever its arguments — nothing pre-execution can filter its results", async () => {
    // grep's permission carries only the search regex, but the tool returns
    // matching line content from path/include/directory sweeps — so even an
    // "innocent-looking" grep can pull env-file contents past the read
    // guard. The gate must fail it by tool ID, args unseen.
    const harness = makeClient()
    const hooks = await load(harness.client)
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: forkMarker } },
      },
    } as never)
    for (const args of [
      { pattern: "retry" },
      { pattern: ".", include: "*.env" },
      { pattern: "KEY", path: "config/.env" },
    ]) {
      await expect(gate(hooks, "ses_fork", "grep", args)).rejects.toThrow(
        /read-only/,
      )
    }
    // Normal sessions grep subject only to the host's own rules.
    const normal = makeClient({ metadataBySession: { ses_normal: {} } })
    const normalHooks = await load(normal.client)
    await expect(
      gate(normalHooks, "ses_normal", "grep", { pattern: "." }),
    ).resolves.toBeUndefined()
  })

  test("fails write-capable, MCP, and unknown plugin tools in a marked fork", async () => {
    const harness = makeClient()
    const hooks = await load(harness.client)
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: forkMarker } },
      },
    } as never)
    // MCP permission names are sanitized tool ids with no "mcp" prefix —
    // exactly the shape the old mcp* rule missed.
    for (const tool of [
      "edit",
      "bash",
      "task",
      "github_create_issue",
      "some_plugin_tool",
    ]) {
      await expect(gate(hooks, "ses_fork", tool)).rejects.toThrow(/read-only/)
    }
  })

  test("env-file reads are refused pre-execution even though 'read' is allowlisted", async () => {
    // The session rules' env "ask" + auto-reject can be out-raced by another
    // permission plugin answering "allow" first; the gate cannot. It must
    // check the read's argument, not just the tool ID.
    const harness = makeClient()
    const hooks = await load(harness.client)
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: forkMarker } },
      },
    } as never)
    for (const filePath of [
      ".env",
      "/repo/config/.env.production",
      "secrets.env",
    ]) {
      await expect(
        gate(hooks, "ses_fork", "read", { filePath }),
      ).rejects.toThrow(/env files/)
    }
    // The example allow-rule and ordinary files still read fine, and a
    // pathless args object is not treated as an env file.
    for (const args of [
      { filePath: ".env.example" },
      { filePath: "src/main.ts" },
      {},
    ]) {
      await expect(
        gate(hooks, "ses_fork", "read", args),
      ).resolves.toBeUndefined()
    }
    // Normal sessions read env files subject only to the host's own rules.
    const normal = makeClient({ metadataBySession: { ses_normal: {} } })
    const normalHooks = await load(normal.client)
    await expect(
      gate(normalHooks, "ses_normal", "read", { filePath: ".env" }),
    ).resolves.toBeUndefined()
  })

  test("explains env-file denial when marker state is unknown", async () => {
    const harness = makeClient({
      sessionGetReplies: [new Error("transport unavailable")],
    })
    const hooks = await load(harness.client)

    await expect(
      gate(hooks, "ses_unknown", "read", { filePath: ".env" }),
    ).rejects.toThrow(/marker lookup was unavailable.*env-file access/)
  })

  test("tools:none forks run nothing at all", async () => {
    const noneMarker = markerFor({
      parent: "ses_parent",
      tools: "none",
      created: 1,
      lease: 1,
    })
    const harness = makeClient()
    const hooks = await load(harness.client)
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: noneMarker } },
      },
    } as never)
    await expect(gate(hooks, "ses_fork", "read")).rejects.toThrow()
  })

  test("normal sessions are never touched", async () => {
    const harness = makeClient({ metadataBySession: { ses_normal: {} } })
    const hooks = await load(harness.client)
    for (const tool of ["edit", "bash", "github_create_issue"]) {
      await expect(gate(hooks, "ses_normal", tool)).resolves.toBeUndefined()
    }
  })

  test("stops gating a fork once its marker is cleared (adopted)", async () => {
    const harness = makeClient()
    const hooks = await load(harness.client)
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: forkMarker } },
      },
    } as never)
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: {} } },
      },
    } as never)
    await expect(gate(hooks, "ses_fork", "edit")).resolves.toBeUndefined()
  })
})

// ---- WP5: the session.deleted eviction branch (index.ts:211-226) was the only
// uncovered range in the server half. gets is the cache-behavior observable: a
// fresh lazy lookup after eviction pushes the id, a cache hit leaves it empty.
describe("WP5: session.deleted cache eviction", () => {
  test("does not restore stale state when deletion lands during lookup", async () => {
    let resolveLookup: (result: SessionGetResult) => void = () => {}
    const lookup = new Promise<SessionGetResult>((resolve) => {
      resolveLookup = resolve
    })
    const harness = makeClient({
      sessionGetReplies: [
        lookup,
        { data: { id: "ses_fork", metadata: forkMarker } },
      ],
    })
    const hooks = await load(harness.client)
    const staleOutput = { options: {} as Record<string, unknown> }
    const pending = hooks["chat.params"]?.(
      { sessionID: "ses_fork" } as never,
      staleOutput as never,
    )
    expect(harness.gets).toEqual(["ses_fork"])

    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses_fork" } },
      },
    } as never)
    resolveLookup({ data: { id: "ses_fork", metadata: forkMarker } })
    await pending
    expect(staleOutput.options).toEqual({})

    const freshOutput = { options: {} as Record<string, unknown> }
    await hooks["chat.params"]?.(
      { sessionID: "ses_fork" } as never,
      freshOutput as never,
    )
    expect(freshOutput.options.promptCacheKey).toBe("ses_parent")
    expect(harness.gets).toEqual(["ses_fork", "ses_fork"])
  })

  test("evicts a learned fork mark so a later query re-looks it up (nested shape)", async () => {
    const harness = makeClient({ metadataBySession: { ses_fork: forkMarker } })
    const hooks = await load(harness.client)
    // Learn the mark from a session event (fast path, no lookup).
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: forkMarker } },
      },
    } as never)
    await hooks["chat.params"]?.(
      { sessionID: "ses_fork" } as never,
      { options: {} } as never,
    )
    expect(harness.gets).toHaveLength(0) // served from the event cache

    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses_fork" } },
      },
    } as never)
    await hooks["chat.params"]?.(
      { sessionID: "ses_fork" } as never,
      { options: {} } as never,
    )
    // Baseline: the mark was evicted → one fresh lazy lookup. If the branch is
    // dropped, the mark survives and this is served from cache → gets stays [].
    expect(harness.gets).toEqual(["ses_fork"])
  })

  test("evicts the negative (normal) cache too so a re-created id is re-checked", async () => {
    const harness = makeClient({ metadataBySession: { ses_normal: {} } })
    const hooks = await load(harness.client)
    await hooks["chat.params"]?.(
      { sessionID: "ses_normal" } as never,
      { options: {} } as never,
    )
    await hooks["chat.params"]?.(
      { sessionID: "ses_normal" } as never,
      { options: {} } as never,
    )
    expect(harness.gets).toEqual(["ses_normal"]) // negative-cached: one lookup

    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses_normal" } },
      },
    } as never)
    await hooks["chat.params"]?.(
      { sessionID: "ses_normal" } as never,
      { options: {} } as never,
    )
    // Baseline evicts `normal` too → a re-lookup. A marks-only eviction keeps
    // the negative cache → gets stays length 1.
    expect(harness.gets).toEqual(["ses_normal", "ses_normal"])
  })

  test("resolves the deleted id from the flat sessionID shape too", async () => {
    const harness = makeClient({ metadataBySession: { ses_fork: forkMarker } })
    const hooks = await load(harness.client)
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: forkMarker } },
      },
    } as never)
    await hooks["chat.params"]?.(
      { sessionID: "ses_fork" } as never,
      { options: {} } as never,
    )
    expect(harness.gets).toHaveLength(0)

    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { sessionID: "ses_fork" },
      },
    } as never)
    await hooks["chat.params"]?.(
      { sessionID: "ses_fork" } as never,
      { options: {} } as never,
    )
    expect(harness.gets).toEqual(["ses_fork"])
  })

  test("a shapeless session.deleted is a harmless no-op", async () => {
    const harness = makeClient({ metadataBySession: { ses_fork: forkMarker } })
    const hooks = await load(harness.client)
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: { id: "ses_fork", metadata: forkMarker } },
      },
    } as never)
    await hooks.event?.({
      event: { type: "session.deleted", properties: {} },
    } as never)
    // Neither id shape present → nothing evicted → still served from cache.
    await hooks["chat.params"]?.(
      { sessionID: "ses_fork" } as never,
      { options: {} } as never,
    )
    expect(harness.gets).toHaveLength(0)
  })
})

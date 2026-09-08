import { describe, expect, test } from "bun:test"
import { makeTuiApi } from "@macarons/plugin-test-harness/tui"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
import type { ProviderContext } from "../src/core"
import { createUsageLimitsEngine } from "../src/engine"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("loopback modules receive server provider state but no implicit TUI auth store", async () => {
  const harness = makeTuiApi({ baseUrl: "http://127.0.0.1:4096" })
  const original = process.env.OPENCODE_AUTH_CONTENT
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    openai: {
      type: "oauth",
      access: "unrelated-local-token",
      expires: 9999999999999,
    },
  })
  const provider = { id: "synthetic", options: { apiKey: "server-key" } }
  harness.api.state.provider = [provider]
  harness.api.state.config = {}
  harness.api.state.session.messages = () => []
  harness.api.state.session.status = () => undefined
  let context: ProviderContext | undefined
  try {
    const engine = createUsageLimitsEngine({
      api: harness.api as unknown as TuiPluginApi,
      modules: [
        {
          providerID: "synthetic",
          title: "Synthetic",
          create: (ctx) => {
            context = ctx
            return {
              available: () => true,
              snapshot: () => undefined,
              syncAuth: async () => {},
              refresh: async () => {},
            }
          },
        },
      ],
      label: "Usage limits",
      service: "usage-limits",
      createSignal,
    })
    expect(engine).toBeDefined()
    expect(context?.provider()).toBe(provider)
    expect(await context?.readAuthStore()).toBeUndefined()
  } finally {
    await harness.dispose()
    if (original === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = original
  }
})

describe("classifier synchronization", () => {
  test("an older tick cannot restore stale provider state", async () => {
    const harness = makeTuiApi({
      paths: {
        config: "/config",
        state: "/state",
        directory: "/project",
        worktree: "/project",
      },
    })
    harness.api.state.config = {}
    harness.api.state.provider = []
    harness.api.state.session = {
      get: (sessionID: string) => ({ id: sessionID }),
      messages: () => [],
      status: () => undefined,
    }

    const first = deferred<string | undefined>()
    const second = deferred<string | undefined>()
    const firstStarted = deferred<void>()
    const secondStarted = deferred<void>()
    let reads = 0
    const engine = createUsageLimitsEngine({
      api: harness.api as unknown as TuiPluginApi,
      modules: [],
      label: "Usage limits",
      service: "usage limits",
      createSignal,
      resolveClassifier: async () => ({
        providerID: () => {
          reads += 1
          if (reads === 1) {
            firstStarted.resolve()
            return first.promise
          }
          secondStarted.resolve()
          return second.promise
        },
      }),
    })
    if (!engine) throw new Error("expected the engine to start")

    await firstStarted.promise
    harness.emit("session.idle", { sessionID: "ses_1" })
    await secondStarted.promise
    second.resolve("synthetic")
    await Bun.sleep(0)
    expect(engine.classifierProviderID()).toBe("synthetic")

    first.resolve("openai")
    await Bun.sleep(0)
    expect(engine.classifierProviderID()).toBe("synthetic")
    await harness.dispose()
  })
})

describe("staged model synchronization", () => {
  test("clears a staged provider after sync and tracks later state", async () => {
    const harness = makeTuiApi()
    harness.api.state.config = {}
    harness.api.state.provider = []
    harness.api.state.session = {
      get: (sessionID: string) => ({ id: sessionID }),
      messages: () => [],
      status: () => undefined,
    }
    const engine = createUsageLimitsEngine({
      api: harness.api as unknown as TuiPluginApi,
      modules: [],
      label: "Usage limits",
      service: "usage limits",
      createSignal,
    })
    if (!engine) throw new Error("expected the engine to start")

    harness.emit("session.next.model.switched", {
      sessionID: "ses_1",
      model: { id: "gpt-5.6-sol-fast", providerID: "openai" },
    })
    expect(engine.nextModelProviderID("ses_1")).toBe("openai")

    harness.emit("session.updated", {
      info: {
        id: "ses_1",
        model: { id: "gpt-5.6-sol-fast", providerID: "openai" },
      },
    })
    expect(engine.nextModelProviderID("ses_1")).toBeUndefined()

    harness.emit("session.next.model.switched", {
      sessionID: "ses_1",
      model: { id: "gpt-5.6-sol-fast", providerID: "openai" },
    })
    harness.emit("session.updated", {
      info: {
        id: "ses_1",
        model: { id: "claude-sonnet-4-20250514", providerID: "anthropic" },
      },
    })
    expect(engine.nextModelProviderID("ses_1")).toBe("anthropic")

    harness.emit("session.deleted", { info: { id: "ses_1" } })
    expect(engine.nextModelProviderID("ses_1")).toBeUndefined()
    await harness.dispose()
  })
})

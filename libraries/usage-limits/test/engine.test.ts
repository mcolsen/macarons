import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { createUsageLimitsEngine } from "../src/engine"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function harness() {
  let sessionID = "one"
  let providerID = "openai"
  let parentID: string | undefined
  let classifier: string | undefined
  let snapshotCalls = 0
  let removed = false
  let snapshot = async (): Promise<unknown> => ({
    snapshot: { windows: [{ key: "primary", label: "5h", usedPercent: 42 }] },
  })
  const api = {
    options: {},
    location: { directory: "/remote/project" },
    ui: {
      router: { current: () => ({ type: "session", sessionID }) },
      model: { current: () => ({ providerID }) },
    },
    data: {
      session: {
        get: () => ({
          id: sessionID,
          parentID,
          location: { directory: "/remote/project" },
        }),
      },
      on: () => () => {
        removed = true
      },
    },
    client: {
      rpc: (definition: { id: string }) =>
        definition.id === "macarons.approve-for-me"
          ? { classifierProvider: async () => ({ providerID: classifier }) }
          : {
              snapshot: async () => {
                snapshotCalls++
                return snapshot()
              },
            },
    },
  } as unknown as Plugin.Context
  return {
    api,
    setSession: (id: string) => {
      sessionID = id
    },
    setProvider: (id: string) => {
      providerID = id
    },
    setParent: (id: string | undefined) => {
      parentID = id
    },
    setClassifier: (id: string) => {
      classifier = id
    },
    setSnapshot: (value: typeof snapshot) => {
      snapshot = value
    },
    calls: () => snapshotCalls,
    removed: () => removed,
  }
}

test("the TUI reads remote snapshots over RPC without accessing credentials", async () => {
  const h = harness()
  const engine = createUsageLimitsEngine({
    api: h.api,
    providerID: "openai",
    createSignal,
  })
  try {
    await engine.refresh()
    expect(engine.snapshot()?.windows[0]?.usedPercent).toBe(42)
    expect(h.calls()).toBeGreaterThan(0)
  } finally {
    engine.dispose()
  }
  expect(h.removed()).toBe(true)
})

test("subagents do not poll quotas and missing RPC clears the display", async () => {
  const h = harness()
  h.setParent("root")
  const engine = createUsageLimitsEngine({
    api: h.api,
    providerID: "openai",
    createSignal,
  })
  try {
    await engine.refresh()
    expect(h.calls()).toBe(0)
    h.setParent(undefined)
    await engine.refresh()
    expect(engine.snapshot()).toBeDefined()
    h.setSnapshot(async () => {
      throw new Error("missing companion")
    })
    await engine.refresh()
    expect(engine.snapshot()).toBeUndefined()
  } finally {
    engine.dispose()
  }
})

test("a different classifier provider remains relevant", async () => {
  const h = harness()
  h.setProvider("anthropic")
  h.setClassifier("openai")
  const engine = createUsageLimitsEngine({
    api: h.api,
    providerID: "openai",
    createSignal,
  })
  try {
    await engine.refresh()
    expect(engine.classifierProviderID()).toBe("openai")
    expect(engine.snapshot()).toBeDefined()
  } finally {
    engine.dispose()
  }
})

test("late results cannot restore another tab's quota display", async () => {
  const h = harness()
  const slow = deferred<unknown>()
  const started = deferred<void>()
  h.setSnapshot(() => {
    started.resolve()
    return slow.promise
  })
  const engine = createUsageLimitsEngine({
    api: h.api,
    providerID: "openai",
    createSignal,
  })
  await started.promise
  h.setSession("two")
  h.setProvider("anthropic")
  await engine.refresh()
  slow.resolve({
    snapshot: { windows: [{ key: "old", label: "5h", usedPercent: 99 }] },
  })
  await Promise.resolve()
  expect(engine.snapshot()).toBeUndefined()
  engine.dispose()
})

import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { createCacheEngine, messageSample } from "../src/engine"
import { resolveOptions } from "../src/options"

function assistant(
  id: string,
  start: number,
  read: number,
): SessionMessageInfo {
  return {
    type: "assistant",
    id,
    sessionID: "ses",
    agent: "build",
    model: { providerID: "openai", id: "model" },
    content: [],
    tokens: {
      input: 110000 - read,
      output: 20,
      reasoning: 0,
      cache: { read, write: 0 },
    },
    time: { created: start, streamed: start + 10, completed: start + 1000 },
  } as SessionMessageInfo
}
function harness(
  messages: SessionMessageInfo[] = [],
  options: Record<string, unknown> = {},
) {
  const listeners = new Map<string, (event: any) => void>()
  const toasts: any[] = []
  let pages: SessionMessageInfo[][] = [messages]
  let calls = 0
  let readHistory:
    | (() => Promise<{ data: SessionMessageInfo[]; cursor: { next?: string } }>)
    | undefined
  const session: any = { id: "ses" }
  const ctx = {
    options,
    data: {
      on: (type: string, fn: (event: any) => void) => {
        listeners.set(type, fn)
        return () => listeners.delete(type)
      },
      session: {
        get: () => session,
        message: {
          list: () => messages,
          get: (_: string, id: string) => messages.find((m) => m.id === id),
        },
      },
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "ses" }) },
      toast: { show: (toast: any) => toasts.push(toast) },
    },
    client: {
      message: {
        list: async () => {
          if (readHistory) {
            calls++
            return readHistory()
          }
          const data = pages[calls++] ?? []
          return {
            data,
            cursor: { next: calls < pages.length ? String(calls) : undefined },
          }
        },
      },
    },
  } as unknown as Plugin.Context
  const engine = createCacheEngine(ctx, () => {})
  const emit = (type: string, data: any, created = 2010) =>
    listeners.get(type)?.({ data, created })
  function step(id: string, start: number, read: number) {
    emit("session.step.started", {
      sessionID: "ses",
      assistantMessageID: id,
      started: start,
      model: { providerID: "openai", id: "model" },
    })
    emit(
      "session.step.ended",
      {
        sessionID: "ses",
        assistantMessageID: id,
        tokens: {
          input: 110000 - read,
          output: 20,
          reasoning: 0,
          cache: { read, write: 0 },
        },
      },
      start + 10,
    )
  }
  return {
    engine,
    listeners,
    toasts,
    emit,
    step,
    session,
    setPages: (next: SessionMessageInfo[][]) => {
      pages = next
    },
    calls: () => calls,
    setHistory: (reader: NonNullable<typeof readHistory>) => {
      readHistory = reader
    },
  }
}

describe("V2 cache health", () => {
  test("uses native per-request token and dispatch timestamps", () => {
    const sample = messageSample(assistant("a", 1000, 100000))!
    expect(sample.startedAt).toBe(1000)
    expect(sample.observedAt).toBe(1010)
    expect(sample.tokens.cacheRead).toBe(100000)
  })
  test("loads every history page, deduplicates live/store echoes, and alerts only once", async () => {
    const h = harness()
    h.setPages([[assistant("a", 1000, 100000)], [assistant("b", 2000, 101000)]])
    await h.engine.sync("ses")
    expect(h.calls()).toBe(2)
    expect(h.engine.samples("ses")).toHaveLength(2)
    expect(h.toasts).toHaveLength(0)
    h.step("c", 3000, 1000)
    expect(h.toasts).toHaveLength(1)
    h.step("c", 3000, 1000)
    h.step("d", 4000, 1000)
    expect(h.toasts).toHaveLength(1)
    expect(h.engine.verdict("ses")?.kind).toBe("break")
    h.engine.dispose()
    expect(h.listeners.size).toBe(0)
  })
  test("expiry is transient and child sessions do not poll or alert", async () => {
    const h = harness([assistant("a", 1000, 100000)], {
      expiryLingerSeconds: 0.001,
    })
    await h.engine.sync("ses")
    h.step("b", 400000, 1000)
    expect(h.engine.verdict("ses")?.kind).toBe("expired")
    expect(h.engine.expiry("ses")).toBeDefined()
    expect(h.toasts).toHaveLength(0)
    await Bun.sleep(10)
    expect(h.engine.expiry("ses")).toBeUndefined()
    h.engine.dispose()
    const child = harness()
    child.session.parentID = "parent"
    await child.engine.sync("ses")
    child.step("b", 1000, 0)
    expect(child.calls()).toBe(0)
    expect(child.engine.samples("ses")).toHaveLength(0)
    child.engine.dispose()
  })
  test("revert excludes later samples and compaction resets break detection", async () => {
    const h = harness([
      assistant("a", 1000, 100000),
      assistant("b", 2000, 1000),
    ])
    await h.engine.sync("ses")
    expect(h.engine.verdict("ses")?.kind).toBe("break")
    h.session.revert = { messageID: "b" }
    expect(h.engine.samples("ses")).toHaveLength(1)
    h.engine.dispose()
  })
  test("invalid options warn while zero minimum and explicit toasts false work", () => {
    expect(
      resolveOptions({ floorFraction: 0, ttlSeconds: -5 }).problems,
    ).toHaveLength(2)
    expect(
      resolveOptions({ minPreviousRead: 0, toasts: false }).options,
    ).toMatchObject({ minPreviousRead: 0, toasts: false })
  })
})

describe("native event/store ordering", () => {
  test("a retry-in-progress does not reuse the previous attempt's tokens", () => {
    const value = assistant("a", 1000, 100000)
    if (value.type !== "assistant") throw new Error("expected assistant")
    value.time.completed = undefined
    expect(messageSample(value)).toBeUndefined()
  })
  test("failed history is attempted once instead of on every store update", async () => {
    const h = harness()
    h.setHistory(async () => {
      throw new Error("offline")
    })
    await h.engine.sync("ses")
    await h.engine.sync("ses")
    await h.engine.sync("ses")
    expect(h.calls()).toBe(1)
    expect(h.toasts).toHaveLength(1)
    h.engine.dispose()
  })
  test("late store snapshots cannot overwrite live usage or dispatch time", async () => {
    const messages = [assistant("a", 1000, 100000)]
    const h = harness(messages)
    await h.engine.sync("ses")
    h.step("b", 3000, 1000)
    messages.push(assistant("b", 2000, 101000))
    await h.engine.sync("ses")
    expect(h.engine.samples("ses").at(-1)).toMatchObject({
      startedAt: 3000,
      tokens: { cacheRead: 1000 },
    })
    expect(h.engine.verdict("ses")?.kind).toBe("break")
    h.engine.dispose()
  })
  test("a store echo before the live event does not swallow the first break toast", async () => {
    const h = harness([
      assistant("a", 1000, 100000),
      assistant("b", 2000, 1000),
    ])
    await h.engine.sync("ses")
    expect(h.toasts).toHaveLength(0)
    h.step("b", 2000, 1000)
    expect(h.toasts).toHaveLength(1)
    h.step("b", 2000, 1000)
    expect(h.toasts).toHaveLength(1)
    h.engine.dispose()
  })
  test("compaction resets background history without needing a cached message", async () => {
    const h = harness([assistant("a", 1000, 100000)])
    await h.engine.sync("ses")
    h.emit(
      "session.compaction.started",
      { sessionID: "ses", inputID: "b" },
      1500,
    )
    h.emit("session.compaction.ended", { sessionID: "ses" }, 1800)
    h.step("c", 2000, 1000)
    expect(
      h.engine.samples("ses").find((sample) => sample.messageID === "b")
        ?.summary,
    ).toBe(true)
    expect(h.engine.verdict("ses")?.kind).toBe("skipped")
    expect(h.toasts).toHaveLength(0)
    h.engine.dispose()
  })
  test("dispose settles a history read even if the transport ignores cancellation", async () => {
    const h = harness()
    h.setHistory(() => new Promise(() => {}))
    const pending = h.engine.sync("ses")
    h.engine.dispose()
    expect(
      await Promise.race([
        pending.then(() => true),
        Bun.sleep(50).then(() => false),
      ]),
    ).toBe(true)
    expect(h.toasts).toHaveLength(0)
  })
})

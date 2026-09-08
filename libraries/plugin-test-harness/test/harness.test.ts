import { describe, expect, test } from "bun:test"
import { flush, tick, until } from "../src/index"
import { makeTuiApi } from "../src/tui"

// The harness is otherwise exercised entirely through its consumers, which
// assert their plugins, not the harness. These cases pin the core behaviors a
// consumer failure would only report confusingly: the poll loop's failure
// mode and the mock bus/lifecycle semantics every TUI test leans on.

describe("until", () => {
  test("returns once the condition holds", async () => {
    let ready = false
    setTimeout(() => {
      ready = true
    }, 20)
    await until(() => ready, { timeoutMs: 2_000 })
    expect(ready).toBe(true)
  })

  test("fails loudly on expiry, naming the label", async () => {
    await expect(
      until(() => false, { timeoutMs: 30, label: "the store write" }),
    ).rejects.toThrow("the store write not met within 30ms")
  })

  test("accepts async conditions", async () => {
    let polls = 0
    await until(async () => ++polls >= 3, { intervalMs: 1 })
    expect(polls).toBe(3)
  })
})

describe("tick and flush", () => {
  test("flush lets a chain of macrotask-deep awaits settle", async () => {
    let depth = 0
    const deepen = () => {
      depth++
      if (depth < 6) setTimeout(deepen, 0)
    }
    setTimeout(deepen, 0)
    await flush()
    expect(depth).toBe(6)
  })

  test("tick runs exactly one macrotask turn", async () => {
    let later = false
    setTimeout(() => {
      setTimeout(() => {
        later = true
      }, 0)
    }, 0)
    await tick()
    expect(later).toBe(false)
  })
})

describe("makeTuiApi core", () => {
  test("emit dispatches host-shaped events to subscribers; unsubscribe works", () => {
    const harness = makeTuiApi()
    const seen: unknown[] = []
    const off = harness.api.event.on("session.deleted", (event) =>
      seen.push(event),
    )
    harness.emit("session.deleted", { sessionID: "ses_1" })
    expect(seen).toEqual([
      { type: "session.deleted", properties: { sessionID: "ses_1" } },
    ])
    off()
    harness.emit("session.deleted", { sessionID: "ses_2" })
    expect(seen).toHaveLength(1)
  })

  // The lifecycle cases below pin this mock to the host's createPluginScope
  // (opencode src/plugin/tui/runtime.ts): abort-then-reverse-drain, real
  // unregistration, and a drain that survives a throwing callback. A mock
  // that only promised "runs once" let the other four differ silently, and a
  // shared mock's divergence is every TUI half's divergence.

  test("dispose runs each registered disposer once", async () => {
    const harness = makeTuiApi()
    let runs = 0
    harness.api.lifecycle.onDispose(() => {
      runs++
    })
    await harness.dispose()
    await harness.dispose()
    expect(runs).toBe(1)
  })

  test("dispose aborts lifecycle.signal before running any disposer", async () => {
    const harness = makeTuiApi()
    const seen: boolean[] = []
    harness.api.lifecycle.onDispose(() => {
      seen.push(harness.api.lifecycle.signal.aborted)
    })
    expect(harness.api.lifecycle.signal.aborted).toBe(false)
    await harness.dispose()
    expect(seen).toEqual([true])
    expect(harness.api.lifecycle.signal.aborted).toBe(true)
  })

  test("disposers drain in reverse registration order", async () => {
    // A half registers its store, then a subscriber over it; teardown has to
    // unwind, not replay.
    const harness = makeTuiApi()
    const order: string[] = []
    harness.api.lifecycle.onDispose(() => {
      order.push("store")
    })
    harness.api.lifecycle.onDispose(() => {
      order.push("subscriber")
    })
    await harness.dispose()
    expect(order).toEqual(["subscriber", "store"])
  })

  test("onDispose returns a working unregister, idempotent per registration", () => {
    const harness = makeTuiApi()
    const stay = () => {}
    const off = harness.api.lifecycle.onDispose(() => {})
    harness.api.lifecycle.onDispose(stay)
    off()
    off() // second call must not evict the survivor
    expect(harness.disposers).toEqual([stay])
  })

  test("a throwing disposer is recorded, and the rest still run", async () => {
    const harness = makeTuiApi()
    const boom = new Error("cleanup failed")
    let after = false
    harness.api.lifecycle.onDispose(() => {
      after = true
    })
    harness.api.lifecycle.onDispose(async () => {
      throw boom
    })
    await harness.dispose()
    expect(harness.disposeErrors).toEqual([boom])
    expect(after).toBe(true)
  })

  test("registering during teardown is dropped, not queued", async () => {
    const harness = makeTuiApi()
    let late = 0
    harness.api.lifecycle.onDispose(() => {
      harness.api.lifecycle.onDispose(() => {
        late++
      })
    })
    await harness.dispose()
    expect(late).toBe(0)
    expect(harness.disposers).toEqual([])
  })

  test("version defaults to the band floor and null means unknowable", () => {
    expect(makeTuiApi().api.app.version).toMatch(/^\d+\.\d+\.\d+$/)
    // Explicit undefined also means floor, so a plugin harness can forward
    // its own optional version input verbatim.
    expect(makeTuiApi({ version: undefined }).api.app.version).toMatch(
      /^\d+\.\d+\.\d+$/,
    )
    expect(makeTuiApi({ version: null }).api.app.version).toBeNull()
  })

  test("a null baseUrl models a client with no transport at all", () => {
    expect(makeTuiApi({ baseUrl: null }).api.client._client).toBeUndefined()
    expect(makeTuiApi().api.client._client.getConfig().baseUrl).toBe(
      "http://opencode.internal",
    )
  })
})

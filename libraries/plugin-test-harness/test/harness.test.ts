import { describe, expect, test } from "bun:test"
import { flush, tick, until } from "../src/index"

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

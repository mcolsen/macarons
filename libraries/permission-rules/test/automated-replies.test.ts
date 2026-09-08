import { afterEach, describe, expect, test } from "bun:test"
import { automatedReplies } from "../src/index"

// The ledger lives on globalThis under a Symbol.for key so separately
// bundled plugins in one host process share one Set. These tests poke the
// registry the same way a second bundle's inlined copy would.
const KEY = Symbol.for("@macarons/automated-permission-replies")
const LEGACY_KEY = Symbol.for("@mcolsen-opencode/automated-permission-replies")
const holder = globalThis as Record<symbol, unknown>

afterEach(() => {
  delete holder[KEY]
  delete holder[LEGACY_KEY]
})

describe("the automated-replies ledger", () => {
  test("every access returns the same shared set", () => {
    automatedReplies().add("per_1")
    expect(automatedReplies().has("per_1")).toBe(true)
    expect(automatedReplies()).toBe(automatedReplies())
  })

  test("a second bundle's copy sees the first bundle's entries", () => {
    // A different inlined copy of this library resolves the same Symbol.for
    // key; simulate it by reading the registry directly off globalThis.
    automatedReplies().add("per_2")
    const other = holder[KEY]
    expect(other).toBe(automatedReplies())
    expect((other as Set<string>).has("per_2")).toBe(true)
  })

  test("shares the ledger with pre-Macarons plugin bundles", () => {
    const legacy = new Set(["per_legacy"])
    holder[LEGACY_KEY] = legacy

    expect(automatedReplies()).toBe(legacy)
    expect(holder[KEY]).toBe(legacy)

    automatedReplies().add("per_new")
    expect((holder[LEGACY_KEY] as Set<string>).has("per_new")).toBe(true)
  })

  test("a clobbered or foreign registry value is replaced, not trusted", () => {
    holder[KEY] = "junk"
    holder[LEGACY_KEY] = "junk"
    const set = automatedReplies()
    expect(set).toBeInstanceOf(Set)
    expect(set.size).toBe(0)
    set.add("per_3")
    expect(automatedReplies().has("per_3")).toBe(true)
  })
})

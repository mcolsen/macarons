import { describe, expect, test } from "bun:test"
import { activeProviderID, formatReset, windowLabel } from "../src/core"

const NOW = new Date(2026, 6, 11, 10, 0, 0).getTime()

describe("windowLabel", () => {
  test.each([
    [18_000, "5h"],
    [17_500, "5h"],
    [86_400, "24h"],
    [604_800, "7d"],
    [590_000, "7d"],
    [2_592_000, "30d"],
    [31_536_000, "365d"],
    [7_200, "2h"],
    [259_200, "3d"],
    [undefined, "Usage"],
    [0, "Usage"],
  ] as const)("%p seconds -> %p", (seconds, expected) => {
    expect(windowLabel(seconds)).toBe(expected)
  })
})

describe("formatReset", () => {
  test("same-day resets show only the time", () => {
    const reset = new Date(2026, 6, 11, 14, 32).getTime()
    expect(formatReset(reset, NOW)).toBe("14:32")
  })

  test("cross-day resets prepend the date", () => {
    const reset = new Date(2026, 6, 15, 9, 5).getTime()
    expect(formatReset(reset, NOW)).toBe("15 Jul 09:05")
  })
})

describe("activeProviderID", () => {
  test("a staged model switch wins over stale session state", () => {
    expect(
      activeProviderID({
        nextModelProviderID: "openai",
        sessionModelProviderID: "anthropic",
        lastAssistantProviderID: "synthetic",
        configModel: "opencode-go/minimax-m3",
      }),
    ).toBe("openai")
  })

  test("sticky session model wins", () => {
    expect(
      activeProviderID({
        sessionModelProviderID: "openai",
        lastAssistantProviderID: "anthropic",
        configModel: "synthetic/syn:large:text",
      }),
    ).toBe("openai")
  })

  test("last assistant turn beats the config default", () => {
    expect(
      activeProviderID({
        lastAssistantProviderID: "synthetic",
        configModel: "openai/gpt-5.5",
      }),
    ).toBe("synthetic")
  })

  test("falls back to the configured default model", () => {
    expect(activeProviderID({ configModel: "synthetic/syn:large:text" })).toBe(
      "synthetic",
    )
  })

  test("yields nothing without any source", () => {
    expect(activeProviderID({})).toBeUndefined()
    expect(activeProviderID({ configModel: "no-slash" })).toBeUndefined()
  })
})

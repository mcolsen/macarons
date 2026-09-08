import { describe, expect, test } from "bun:test"
import {
  applyPromptRules,
  normalizeOptions,
  type ScopedPromptRule,
} from "../src/shared"

describe("option normalization", () => {
  test("normalizes exact model references and string-or-array content", () => {
    const result = normalizeOptions({
      prompts: [
        {
          model: " openai/gpt-5.6-sol ",
          mode: "append",
          content: "delegate deliberately",
        },
        {
          model: "openrouter/anthropic/claude-sonnet",
          mode: "replace",
          content: ["first", "second"],
        },
      ],
    })

    expect(result.problems).toEqual([])
    expect(result.rules).toEqual([
      {
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        mode: "append",
        content: ["delegate deliberately"],
      },
      {
        providerID: "openrouter",
        modelID: "anthropic/claude-sonnet",
        mode: "replace",
        content: ["first", "second"],
      },
    ])
  })

  test("absent options are inert", () => {
    expect(normalizeOptions(undefined)).toEqual({ rules: [], problems: [] })
    expect(normalizeOptions({})).toEqual({ rules: [], problems: [] })
  })

  test("skips malformed rules while retaining valid neighbors", () => {
    const result = normalizeOptions({
      prompts: [
        null,
        { model: "missing-slash", mode: "append", content: "text" },
        { model: "openai/sol", mode: "around", content: "text" },
        { model: "openai/sol", mode: "prepend", content: [] },
        {
          model: "openai/sol",
          mode: "append",
          content: "skipped",
          typo: true,
        },
        { model: "openai/sol", mode: "append", content: "valid" },
      ],
      unexpected: true,
    })

    expect(result.rules).toEqual([
      {
        providerID: "openai",
        modelID: "sol",
        mode: "append",
        content: ["valid"],
      },
    ])
    expect(result.problems).toHaveLength(6)
    expect(result.problems.join("\n")).toContain("unknown plugin option")
    expect(result.problems.join("\n")).toContain("unknown field")
  })

  test("rejects malformed option containers", () => {
    expect(normalizeOptions("bad").problems).toEqual([
      "plugin options must be an object, got string",
    ])
    expect(normalizeOptions({ prompts: {} }).problems).toEqual([
      '"prompts" must be an array',
    ])
  })
})

describe("rule application", () => {
  const model = { providerID: "openai", id: "sol" }

  test.each([
    ["append", ["base", "project", "one", "two"]],
    ["prepend", ["one", "two", "base", "project"]],
    ["replace", ["one", "two"]],
  ] as const)("applies %s in place", (mode, expected) => {
    const system = ["base", "project"]
    const original = system
    applyPromptRules(
      [
        {
          providerID: "openai",
          modelID: "sol",
          mode,
          content: ["one", "two"],
        },
      ],
      model,
      system,
    )
    expect(system).toBe(original)
    expect(system).toEqual([...expected])
  })

  test("composes matching rules in declaration order", () => {
    const rules: ScopedPromptRule[] = [
      {
        providerID: "openai",
        modelID: "sol",
        mode: "append",
        content: ["discarded"],
      },
      {
        providerID: "openai",
        modelID: "sol",
        mode: "replace",
        content: ["replacement"],
      },
      {
        providerID: "openai",
        modelID: "sol",
        mode: "append",
        content: ["after"],
      },
      {
        providerID: "openai",
        modelID: "sol",
        mode: "prepend",
        content: ["before"],
      },
    ]
    const system = ["base"]

    applyPromptRules(rules, model, system)

    expect(system).toEqual(["before", "replacement", "after"])
  })

  test("uses exact case-sensitive provider and model matches", () => {
    const rules: ScopedPromptRule[] = [
      {
        providerID: "openai",
        modelID: "sol",
        mode: "append",
        content: ["matched"],
      },
    ]
    for (const other of [
      { providerID: "OpenAI", id: "sol" },
      { providerID: "openai", id: "Sol" },
      { providerID: "other", id: "sol" },
    ]) {
      const system = ["base"]
      applyPromptRules(rules, other, system)
      expect(system).toEqual(["base"])
    }
  })
})

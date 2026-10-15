import { describe, expect, spyOn, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { SessionRequest } from "@opencode/plugin/promise/session"
import plugin from "../src/index"

async function load(options: Record<string, unknown> = {}) {
  const hooks = new Map<string, (request: SessionRequest) => void>()
  await plugin.setup({
    options,
    location: { directory: "/fixture" },
    session: {
      hook: async (name: string, fn: (request: SessionRequest) => void) => {
        hooks.set(name, fn)
      },
    },
  } as unknown as Plugin.Context)
  return hooks
}

function request(providerID = "openai", id = "my-alias"): SessionRequest {
  return {
    sessionID: "session" as SessionRequest["sessionID"],
    model: { providerID, id } as SessionRequest["model"],
    system: [{ type: "text", text: "base", metadata: { retained: true } }],
    messages: [],
    options: {},
  }
}

describe("v2 scoped system prompts", () => {
  test("applies ordered rules to every request kind and preserves untouched part metadata", async () => {
    const hooks = await load({
      prompts: [
        { model: "openai/my-alias", mode: "prepend", content: "first" },
        {
          model: "openai/my-alias",
          mode: "append",
          content: ["last", "last again"],
        },
      ],
    })
    expect([...hooks.keys()]).toEqual([
      "context",
      "compaction",
      "title",
      "generate",
    ])
    for (const transform of hooks.values()) {
      const event = request()
      const original = event.system[0]
      transform(event)
      expect(event.system.map((part) => part.text)).toEqual([
        "first",
        "base",
        "last",
        "last again",
      ])
      expect(event.system[1]).toBe(original)
    }
  })
  test("matches exact selectable provider/model and replaces when configured", async () => {
    const hooks = await load({
      prompts: [
        { model: "openai/my-alias", mode: "replace", content: "replacement" },
      ],
    })
    for (const [provider, model] of [
      ["other", "my-alias"],
      ["openai", "backing-model"],
    ]) {
      const event = request(provider, model)
      hooks.get("context")?.(event)
      expect(event.system[0]?.text).toBe("base")
    }
    const event = request()
    hooks.get("context")?.(event)
    expect(event.system).toEqual([{ type: "text", text: "replacement" }])
  })
  test("warns for invalid rules and leaves valid rules active", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const hooks = await load({
        prompts: [
          { model: "bad", mode: "append", content: "ignored" },
          { model: "openai/my-alias", mode: "append", content: "active" },
        ],
      })
      expect(warn).toHaveBeenCalledTimes(1)
      const event = request()
      hooks.get("context")?.(event)
      expect(event.system.at(-1)?.text).toBe("active")
    } finally {
      warn.mockRestore()
    }
  })
  test("registers nothing without valid rules", async () => {
    expect((await load()).size).toBe(0)
  })
})

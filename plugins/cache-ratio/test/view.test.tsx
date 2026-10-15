import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { testRender } from "@opentui/solid"
import { createRoot } from "solid-js"
import plugin from "../src/tui"

test("native sidebar renders cache history and releases its subscriptions", async () => {
  let render!: (input: { sessionID: string }) => unknown
  let released = false
  const subscriptions = new Set<() => void>()
  const messages = [
    {
      type: "assistant",
      id: "message",
      sessionID: "session",
      agent: "build",
      model: { providerID: "openai", id: "model" },
      content: [],
      tokens: {
        input: 1000,
        output: 10,
        reasoning: 0,
        cache: { read: 9000, write: 0 },
      },
      time: { created: 1000, completed: 2000 },
    },
  ]
  const api = {
    options: {},
    theme: {
      text: {
        base: "#ffffff",
        muted: "#888888",
        feedback: { error: { base: "#ff0000" } },
      },
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "session" }) },
      toast: { show: () => {} },
      slot: (claim: { append: string; render: typeof render }) => {
        expect(claim.append).toBe("sidebar.content")
        render = claim.render
        return () => {
          released = true
        }
      },
    },
    data: {
      on: () => {
        const stop = () => {
          subscriptions.delete(stop)
        }
        subscriptions.add(stop)
        return stop
      },
      session: {
        get: () => ({ id: "session" }),
        message: { list: () => messages, get: () => messages[0] },
      },
    },
    client: { message: { list: async () => ({ data: messages, cursor: {} }) } },
  } as unknown as Plugin.Context
  let disposeRoot!: () => void
  const cleanup = await createRoot((dispose) => {
    disposeRoot = dispose
    return plugin.setup(api)
  })
  const view = await testRender(() => render({ sessionID: "session" }), {
    width: 60,
    height: 10,
  })
  try {
    for (let count = 0; count < 20; count++) {
      await Bun.sleep(5)
      await view.renderOnce()
      if (view.captureCharFrame().includes("Cache health")) break
    }
    expect(view.captureCharFrame()).toContain("Cache health")
    expect(view.captureCharFrame()).toContain("90%")
  } finally {
    await view.renderer.destroy()
    await cleanup?.()
    disposeRoot()
  }
  expect(released).toBe(true)
  expect(subscriptions.size).toBe(0)
})

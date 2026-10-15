import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { tui } from "../src/tui"

test("native sidebar renders server quotas and hides subagents", async () => {
  const [parent, setParent] = createSignal<string>()
  let render!: (input: { sessionID: string }) => unknown
  let removed = false
  const api = {
    options: {},
    location: { directory: "/remote/project" },
    theme: {
      text: {
        base: "#ffffff",
        muted: "#888888",
        feedback: { error: { base: "#ff0000" }, warning: { base: "#ffcc00" } },
      },
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "root" }) },
      model: { current: () => ({ providerID: "synthetic" }) },
      slot: (claim: { append: string; render: typeof render }) => {
        expect(claim.append).toBe("sidebar.content")
        render = claim.render
        return () => {
          removed = true
        }
      },
    },
    data: {
      session: {
        get: () => ({
          id: "root",
          parentID: parent(),
          model: { providerID: "synthetic" },
        }),
      },
      on: () => () => {},
    },
    client: {
      rpc: (definition: { id: string }) =>
        definition.id === "macarons.approve-for-me"
          ? { classifierProvider: async () => ({}) }
          : {
              snapshot: async () => ({
                snapshot: {
                  windows: [{ key: "primary", label: "5h", usedPercent: 42 }],
                },
              }),
            },
    },
  } as unknown as Plugin.Context
  const cleanup = await tui.setup(api)
  const view = await testRender(() => render({ sessionID: "root" }), {
    width: 60,
    height: 10,
  })
  try {
    for (let count = 0; count < 20; count++) {
      await Bun.sleep(5)
      await view.renderOnce()
      if (view.captureCharFrame().includes("58% left")) break
    }
    expect(view.captureCharFrame()).toContain("Synthetic Limits")
    expect(view.captureCharFrame()).toContain("5h 58% left")
    setParent("parent")
    await Bun.sleep(5)
    await view.renderOnce()
    expect(view.captureCharFrame()).not.toContain("Synthetic Limits")
  } finally {
    await view.renderer.destroy()
    await cleanup?.()
  }
  expect(removed).toBe(true)
})

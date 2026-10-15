import type { Plugin } from "@opencode/plugin"
import type { SessionGenerate } from "@opencode/plugin/promise/session"
import { createClassifierPipeline } from "../src/server/classifier"

export function classifierHarness(
  options: {
    directory?: string
    answer?: string
    skipHook?: boolean
    onGenerate?: (event: SessionGenerate) => void
    onCall?: (call: string) => void
  } = {},
) {
  const hooks = new Map<string, Array<(event: SessionGenerate) => unknown>>()
  const logs: string[] = []
  const messages: Array<{
    model: { providerID: string; modelID: string }
    parts: Array<{ type: string; text: string }>
  }> = []
  const calls: string[] = []
  let model = { providerID: "test", id: "judge" }
  let connectedKey: string | undefined
  const host = {
    location: { directory: options.directory ?? "/test/classifier" },
    integration: {
      connection: {
        active: async () => (connectedKey ? { id: "typesafe" } : undefined),
        resolve: async () => ({ type: "key", key: connectedKey }),
      },
    },
    session: {
      hook: async (name: string, fn: (event: SessionGenerate) => unknown) => {
        const list = hooks.get(name) ?? []
        list.push(fn)
        hooks.set(name, list)
        return {
          dispose: async () => {
            hooks.set(
              name,
              list.filter((item) => item !== fn),
            )
          },
        }
      },
      create: async (input: { model: typeof model }) => {
        options.onCall?.("create")
        calls.push("create")
        model = input.model
        return { id: "ses_judge" }
      },
      generate: async ({ prompt }: { prompt: string }) => {
        options.onCall?.("generate")
        calls.push("generate")
        const event = {
          sessionID: "ses_judge",
          system: [{ type: "text", text: "untrusted project instructions" }],
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "secret existing context" }],
            },
          ],
          tools: { shell: {} },
          model,
        } as unknown as SessionGenerate
        if (!options.skipHook)
          for (const hook of hooks.get("generate") ?? []) await hook(event)
        options.onGenerate?.(event)
        messages.push({
          model: { providerID: model.providerID, modelID: model.id },
          parts: [{ type: "text", text: prompt }],
        })
        return {
          text:
            options.answer ??
            '{"decision":"approve","risk":"low","authorization":"implied","reason":"safe fixture"}',
        }
      },
      remove: async () => {
        options.onCall?.("remove")
        calls.push("remove")
      },
    },
  } as unknown as Plugin.Context
  const pipeline = createClassifierPipeline({
    host,
    log: (_level, message) => logs.push(message),
  })
  return {
    ...pipeline,
    messages,
    calls,
    logs,
    host,
    setConnectedKey(key: string | undefined) {
      connectedKey = key
    },
  }
}

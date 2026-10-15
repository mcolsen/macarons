import { isIsolatedGeneration } from "@macarons/permission-rules"
import { Plugin } from "@opencode/plugin"
import type { SessionRequest } from "@opencode/plugin/promise/session"
import { normalizeOptions, SERVICE } from "./shared"

/** Apply rules to request-owned parts, preserving cache hints on untouched parts. */
export const ScopedSystemPromptsPlugin = Plugin.define({
  id: SERVICE,
  async setup(ctx) {
    const { rules, problems } = normalizeOptions(ctx.options)
    for (const problem of problems)
      console.warn(`${SERVICE}: ignoring invalid plugin option: ${problem}`)
    if (rules.length === 0) return

    const transform = (request: SessionRequest) => {
      if (isIsolatedGeneration(ctx.location, request.sessionID)) return
      for (const rule of rules) {
        if (
          rule.providerID !== request.model.providerID ||
          rule.modelID !== request.model.id
        )
          continue
        const content = rule.content.map((text) => ({
          type: "text" as const,
          text,
        }))
        if (rule.mode === "replace")
          request.system.splice(0, request.system.length, ...content)
        else if (rule.mode === "prepend") request.system.unshift(...content)
        else request.system.push(...content)
      }
    }
    // V2 has distinct hooks for the agent loop and auxiliary session requests.
    for (const hook of ["context", "compaction", "title", "generate"] as const)
      await ctx.session.hook(hook, transform)
  },
})

export default ScopedSystemPromptsPlugin

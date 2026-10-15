import { createUsageLimitsServer } from "@macarons/usage-limits"
import { type Credential, Plugin } from "@opencode/plugin"
import { codexModule } from "./codex"

export function codexAuthStore(
  credential: Credential.Value | undefined,
): unknown {
  if (
    credential?.type !== "oauth" ||
    !["chatgpt-browser", "chatgpt-headless"].includes(credential.methodID)
  )
    return
  return {
    openai: {
      type: "oauth",
      access: credential.access,
      expires: credential.expires,
      accountId: credential.metadata?.accountID,
    },
  }
}

export const CodexLimitsPlugin = Plugin.define({
  id: "macarons.codex-limits",
  setup: (ctx) =>
    createUsageLimitsServer({
      ctx,
      module: codexModule,
      authStore: codexAuthStore,
    }),
})
export default CodexLimitsPlugin

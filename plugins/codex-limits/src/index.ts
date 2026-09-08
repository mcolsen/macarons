import os from "node:os"
import {
  appLogger,
  readRefreshedAuthStore,
  reportServerCompat,
  unsupportedVersionHooks,
} from "@macarons/permission-rules"
import type { Config, Plugin } from "@opencode-ai/plugin"
import { createAuthScopeResponder } from "./auth-scope"

export const CodexLimitsPlugin: Plugin = async ({
  client,
  directory,
  serverUrl,
}) => {
  const compat = await reportServerCompat({
    client,
    serverUrl,
    label: "Codex limits",
    service: "codex-limits",
    log: appLogger(client, "codex-limits"),
  })
  if (compat?.disable)
    return unsupportedVersionHooks(client, directory, compat.message)

  const controller = new AbortController()
  let config: Config | undefined
  const respond = createAuthScopeResponder({
    readAuthStore: async () => {
      // A retained OAuth record is not active when bundled Codex is disabled
      // or its fetch is explicitly replaced. Do not attest those credentials.
      if (
        !config ||
        /^(?:true|yes|on|1|y)$/i.test(
          process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS ?? "",
        ) ||
        config.disabled_providers?.includes("openai") ||
        (config.enabled_providers &&
          !config.enabled_providers.includes("openai")) ||
        Object.hasOwn(config.provider?.openai?.options ?? {}, "fetch")
      )
        return
      return readRefreshedAuthStore({ env: process.env, homedir: os.homedir() })
    },
    publish: (command, signal) =>
      client.tui.publish({
        query: { directory },
        body: { type: "tui.command.execute", properties: { command } },
        signal,
      }),
    signal: controller.signal,
  })
  return {
    config: async (value) => {
      config = value
    },
    event: async ({ event }) => respond(event),
    dispose: async () => controller.abort(),
  }
}

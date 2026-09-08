import {
  appLogger,
  reportServerCompat,
  unsupportedVersionHooks,
} from "@macarons/permission-rules"
import type { Plugin } from "@opencode-ai/plugin"
import { applyPromptRules, normalizeOptions, SERVICE } from "./shared"

/** Provider/model-scoped system prompt transforms. */
export const ScopedSystemPromptsPlugin: Plugin = async (
  { client, directory, serverUrl },
  rawOptions,
) => {
  const log = appLogger(client, SERVICE)
  const compat = await reportServerCompat({
    client,
    serverUrl,
    label: "Scoped system prompts",
    service: SERVICE,
    log,
  })
  if (compat?.disable)
    return unsupportedVersionHooks(client, directory, compat.message)

  const { rules, problems } = normalizeOptions(rawOptions)
  for (const problem of problems)
    log("warn", `ignoring invalid plugin option: ${problem}`)
  if (rules.length === 0) return {}

  return {
    "experimental.chat.system.transform": async ({ model }, output) => {
      applyPromptRules(rules, model, output.system)
    },
  }
}

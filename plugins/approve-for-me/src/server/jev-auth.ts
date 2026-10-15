import os from "node:os"
import type { AuthStoreInput } from "@macarons/permission-rules"
import type { Plugin } from "@opencode/plugin"

export { JEV_AUTH_HINT } from "../shared/classifier-models"

/** V2 owns credentials; the plugin never reads the retired auth.json store. */
export async function registerJevIntegration(host: Plugin.Context) {
  return host.integration.transform((editor) => {
    editor.update("typesafe", (integration) => {
      integration.name = "TypeSafe (Jev)"
    })
    editor.method.update({
      integrationID: "typesafe",
      method: { type: "key", label: "TypeSafe API key" },
    })
    editor.method.update({
      integrationID: "typesafe",
      method: { type: "env", names: ["TYPESAFE_API_KEY"] },
    })
  })
}

export async function readJevApiKey(
  input: AuthStoreInput = { env: process.env, homedir: os.homedir() },
  integration?: Plugin.Context["integration"],
): Promise<string | undefined> {
  if (integration) {
    const active = await integration.connection.active("typesafe")
    if (active) {
      const credential = await integration.connection.resolve(active)
      if (credential?.type === "key") return credential.key.trim() || undefined
    }
  }
  return input.env.TYPESAFE_API_KEY?.trim() || undefined
}

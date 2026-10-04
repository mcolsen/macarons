import os from "node:os"
import {
  type AuthStoreInput,
  authEntry,
  readAuthStore,
  validAuthType,
} from "@macarons/permission-rules"
import type { AuthHook, Config } from "@opencode-ai/plugin"

// The host owns the key prompt and credential persistence for API methods.
export const jevAuth = {
  provider: "typesafe",
  methods: [{ type: "api", label: "TypeSafe API key" }],
} satisfies AuthHook

export async function registerJevProvider(config: Config): Promise<void> {
  config.provider ??= {}
  config.provider.typesafe ??= {}
  const provider = config.provider.typesafe
  provider.name ??= "TypeSafe (Jev)"
  provider.env ??= ["TYPESAFE_API_KEY"]
  provider.models ??= {}
}

/** Read on every classification so connecting, replacing, and removing a key
 *  take effect without retaining a credential in the plugin instance. */
export async function readJevApiKey(
  input: AuthStoreInput = { env: process.env, homedir: os.homedir() },
): Promise<string | undefined> {
  const entry = authEntry(await readAuthStore(input), "typesafe")
  const saved =
    validAuthType(entry) === "api" && typeof entry?.key === "string"
      ? entry.key.trim()
      : undefined
  return saved || input.env.TYPESAFE_API_KEY?.trim() || undefined
}

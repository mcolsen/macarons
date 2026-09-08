import type { ScannableProviderType } from "./types"

/**
 * Provider detection. Adapted from emilsvennesson/opencode-websearch v0.6.0
 * (MIT; see NOTICE).
 */

type ProviderModelLike = {
  api?: { npm?: unknown }
}

export type ProviderDataLike = {
  id: string
  models: Record<string, ProviderModelLike>
}

/**
 * Canonical OpenCode/models.dev provider ids to adapter type. `opencode-go`
 * and other unlisted ids intentionally resolve to null — the session falls
 * through to the next chain backend.
 */
const PROVIDER_TYPES_BY_ID: Record<string, ScannableProviderType> = {
  anthropic: "anthropic",
  "github-copilot": "copilot",
  moonshotai: "moonshot",
  "moonshotai-cn": "moonshot",
  openai: "openai",
}

/**
 * Unambiguous SDK-package fallbacks so custom-renamed providers (e.g.
 * `openai-prod`) are still served with their own credentials/baseURL.
 * Moonshot is deliberately absent: `@ai-sdk/openai-compatible` is shared by
 * many unrelated (often local) providers and must never auto-match.
 */
const NPM_TO_TYPE: Record<string, ScannableProviderType> = {
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/github-copilot": "copilot",
  "@ai-sdk/openai": "openai",
}

export function detectProviderType(
  provider: ProviderDataLike,
): ScannableProviderType | null {
  const byID = PROVIDER_TYPES_BY_ID[provider.id]
  if (byID) return byID
  for (const model of Object.values(provider.models)) {
    const npm = model.api?.npm
    if (typeof npm !== "string") continue
    const byNpm = NPM_TO_TYPE[npm]
    if (byNpm) return byNpm
  }
  return null
}

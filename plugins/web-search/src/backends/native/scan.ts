import { detectProviderType } from "./registry"
import type { ProviderCredentials, ProviderType } from "./types"

/**
 * Provider config scanning. Adapted from emilsvennesson/opencode-websearch
 * v0.6.0 (MIT; see NOTICE).
 */

export type ProviderData = {
  id: string
  key?: string
  options: Record<string, unknown>
  models: Record<string, ProviderModel>
}

type ProviderModel = {
  id: string
  api?: { npm?: unknown; id?: unknown; url?: unknown }
  headers?: Record<string, string>
  options: Record<string, unknown>
}

/**
 * The provider-facing half of one model's identity. The host's `resolveSDK` in
 * `provider/provider.ts` resolves both on every model: `api.id` is the wire
 * model id when the catalog key is an alias
 * (`"fast": { "id": "gpt-4.1" }`), and `api.url` is the endpoint when the
 * config uses the provider- or model-level `api` field instead of
 * `options.baseURL`. Dropping either routes the search to the wrong model name
 * or, worse, the wrong host.
 */
export type ModelApi = {
  id?: string
  url?: string
  headers?: Record<string, string>
}

/**
 * A scan result whose credentials may still be null: a provider configured
 * only with `websearch` flags (or canonical Copilot) keeps its slot so the
 * OAuth attachment pass can fill the credentials in afterwards. Still-null
 * entries are filtered before resolutions reach the picker.
 */
export type ScannedResolution = {
  /** Keep a configured gateway even when no usable API key survives scanning. */
  configuredBaseURL?: string
  credentials: ProviderCredentials | null
  fallbackModel?: string
  headers?: Record<string, string>
  lockedModel?: string
  /** Per catalog model id, the provider-facing wire id/endpoint and headers. */
  modelApi: Record<string, ModelApi>
  providerID: string
  type: ProviderType
}

function stringOption(
  options: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = options[key]
  return typeof value === "string" && value ? value : undefined
}

function headerOption(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
}

/**
 * The host's `auth/index.ts` `OAUTH_DUMMY_KEY` stands for "this provider
 * authenticates through an installed fetch, not through a key." It is NOT a
 * credential, and it is not rare: `provider/provider.ts`'s plugin-auth loader
 * loop merges the loader's options into the provider record at LIST time, so
 * `/config/providers` reports `options.apiKey: "opencode-oauth-dummy-key"` for
 * sentinel-based OAuth providers, including ChatGPT. The host never sends it;
 * its own fetch strips the Authorization header and writes the
 * real bearer token in (`plugin/openai/codex.ts`'s `CodexAuthPlugin` fetch).
 *
 * Read as a key it would be the WORST possible resolution: a guaranteed 401
 * from api.openai.com, reached only when resolve.ts's OAuth attachment pass
 * declined — so it converts "no ChatGPT credentials, fall through the chain"
 * into "burn the native attempt on a request that cannot succeed", which is
 * exactly what the expiry decline in auth.ts exists to avoid. It keeps its
 * SLOT (that pass still wants to fill it) but contributes no credentials of
 * its own.
 */
const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

/** Anthropic's messages endpoint lives under /v1; strip a configured one. */
export function normalizeBaseURL(type: ProviderType, url: string): string {
  return type === "anthropic" ? url.replace(/\/v1\/?$/, "") : url
}

function collectModelApi(provider: ProviderData): Record<string, ModelApi> {
  const modelApi: Record<string, ModelApi> = {}
  for (const [key, model] of Object.entries(provider.models)) {
    const api = model.api
    const id = typeof api?.id === "string" && api.id ? api.id : undefined
    const url = typeof api?.url === "string" && api.url ? api.url : undefined
    const headers = headerOption(model.headers)
    if (!id && !url && !headers) continue
    modelApi[typeof model.id === "string" && model.id ? model.id : key] = {
      ...(id ? { id } : {}),
      ...(url ? { url } : {}),
      ...(headers ? { headers } : {}),
    }
  }
  return modelApi
}

function collectWebsearchModels(provider: ProviderData): {
  lockedModel?: string
  fallbackModel?: string
} {
  let lockedModel: string | undefined
  let fallbackModel: string | undefined
  for (const model of Object.values(provider.models)) {
    const flag = model.options.websearch
    if (flag === "always" && !lockedModel) lockedModel = model.id
    if (flag === "auto" && !fallbackModel) fallbackModel = model.id
  }
  return { lockedModel, fallbackModel }
}

function scanProvider(
  provider: ProviderData,
  warn?: (message: string) => void,
): ScannedResolution | null {
  const type = detectProviderType(provider)
  if (!type) return null
  const copilot = provider.id === "github-copilot"
  // Match the host's provider/provider.ts resolveSDK: only an absent option
  // falls back to its stored/env key. Select before filtering the sentinel so
  // OAuth cannot expose that fallback.
  const configured =
    provider.options.apiKey === undefined
      ? provider.key
      : stringOption(provider.options, "apiKey")
  if (
    provider.options.apiKey !== undefined &&
    configured === undefined &&
    !(copilot && provider.options.apiKey === "")
  ) {
    warn?.(
      `provider "${provider.id}" has an explicit empty or non-string options.apiKey; native search will not fall back to its stored/environment key`,
    )
  }
  const oauthOnly = configured === OAUTH_DUMMY_KEY
  const apiKey = oauthOnly ? undefined : configured
  const { lockedModel, fallbackModel } = collectWebsearchModels(provider)
  // A provider contributing neither credentials nor flags is dead weight —
  // except an OAuth slot. Copilot's host loader uses an empty apiKey, not the
  // sentinel; keep its configuration instead of synthesizing a bare resolution.
  if (!apiKey && !oauthOnly && !copilot && !lockedModel && !fallbackModel)
    return null
  const baseURL = stringOption(provider.options, "baseURL")
  const headers = headerOption(provider.options.headers)
  const credentials = apiKey
    ? {
        apiKey,
        ...(baseURL ? { baseURL: normalizeBaseURL(type, baseURL) } : {}),
      }
    : null
  return {
    ...(baseURL ? { configuredBaseURL: baseURL } : {}),
    credentials,
    fallbackModel,
    ...(headers ? { headers } : {}),
    lockedModel,
    modelApi: collectModelApi(provider),
    providerID: provider.id,
    type,
  }
}

/** One scan result per detected provider, in config insertion order. */
export function scanProviders(
  providers: ProviderData[],
  warn?: (message: string) => void,
): ScannedResolution[] {
  const out: ScannedResolution[] = []
  for (const provider of providers) {
    const resolution = scanProvider(provider, warn)
    if (resolution) out.push(resolution)
  }
  return out
}

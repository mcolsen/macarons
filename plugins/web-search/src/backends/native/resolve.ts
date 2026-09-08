import { resolveChatGPTCredentials, resolveCopilotCredentials } from "./auth"
import {
  type ProviderData,
  type ScannedResolution,
  scanProviders,
} from "./scan"
import type { ActiveModel, ProviderResolution } from "./types"

/**
 * Resolution loading and model picking. Adapted from
 * emilsvennesson/opencode-websearch v0.6.0 (MIT; see NOTICE), with one
 * deliberate divergence: upstream picks a search-capable model on ANY
 * configured provider; this suite restricts native search to the SESSION'S
 * OWN provider so no party that wasn't already seeing the conversation ever
 * sees a query (decided in issue #61). Anything else falls through to the
 * next chain backend.
 */

const CANONICAL_OPENAI_ID = "openai"
const CANONICAL_COPILOT_ID = "github-copilot"

export type ProvidersClient = {
  config: {
    providers: (options: { signal: AbortSignal }) => Promise<{
      data?: { providers?: unknown }
    }>
  }
}

/** Reads the whole auth store — the library's reader, or a test's stand-in. */
export type AuthStoreReader = () => Promise<unknown>

function hasCredentials(
  resolution: ScannedResolution,
): resolution is ProviderResolution {
  return resolution.credentials !== null
}

export async function loadResolutions(
  client: ProvidersClient,
  readAuthStore: AuthStoreReader,
  signal: AbortSignal,
  warn?: (message: string) => void,
): Promise<ProviderResolution[]> {
  signal.throwIfAborted()
  let providers: ProviderData[]
  try {
    const { data } = await client.config.providers({ signal })
    signal.throwIfAborted()
    if (!Array.isArray(data?.providers)) return []
    providers = data.providers as ProviderData[]
  } catch {
    signal.throwIfAborted()
    return []
  }
  const scanned = scanProviders(providers, warn)
  // One read for both OAuth providers: the two resolvers below used to reach
  // for auth.json separately, each with its own /path round-trip.
  const authStore = await readAuthStore()
  signal.throwIfAborted()

  // ChatGPT OAuth shadows the canonical `openai` provider when it has no
  // explicit baseURL: OAuth replaces the apiKey and the adapter type flips
  // to chatgpt (covering both a keyed entry and a flags-only entry). A
  // custom-renamed openai provider keeps its own credentials — its explicit
  // baseURL would not authenticate against ChatGPT OAuth tokens.
  const chatgpt = resolveChatGPTCredentials(authStore)
  if (chatgpt) {
    const canonical = scanned.find(
      (resolution) => resolution.providerID === CANONICAL_OPENAI_ID,
    )
    if (canonical && !canonical.configuredBaseURL) {
      canonical.credentials = chatgpt
      canonical.type = "chatgpt"
    }
  }

  // Copilot OAuth fills the canonical `github-copilot` resolution when it
  // has no explicit baseURL, and synthesizes one when no entry exists at
  // all — an OAuth-only Copilot user needs no opencode.json provider block.
  const copilot = resolveCopilotCredentials(authStore)
  if (copilot) {
    const canonical = scanned.find(
      (resolution) => resolution.providerID === CANONICAL_COPILOT_ID,
    )
    if (canonical && !canonical.configuredBaseURL) {
      canonical.credentials = copilot
    } else if (!canonical) {
      scanned.push({
        credentials: copilot,
        modelApi: {},
        providerID: CANONICAL_COPILOT_ID,
        type: "copilot",
      })
    }
  }

  return scanned.filter(hasCredentials)
}

export type PickedModel = {
  /** Catalog id — matching, logging, failure reasons. */
  modelID: string
  /** Provider-facing wire id — what the request body's `model` must carry. */
  apiModelID: string
  /** Model-level endpoint (api.url), when one is configured. */
  apiURL?: string
  resolution: ProviderResolution
}

/**
 * Active-provider-only attempts: a `"websearch": "always"` model is exclusive;
 * otherwise try the active model, then a distinct `"websearch": "auto"`
 * fallback on failure. Both picks keep the same provider resolution. Matching
 * happens on CATALOG ids (the session's model id is the catalog key), but
 * the wire id is the model's `api.id` when the catalog key is an alias.
 */
export function pickForActiveProvider(
  resolutions: ProviderResolution[],
  active: ActiveModel | undefined,
): PickedModel[] {
  if (!active) return []
  const resolution = resolutions.find(
    (candidate) => candidate.providerID === active.providerID,
  )
  if (!resolution) return []
  const modelIDs = [resolution.lockedModel ?? active.modelID]
  if (
    !resolution.lockedModel &&
    resolution.fallbackModel &&
    resolution.fallbackModel !== active.modelID
  ) {
    modelIDs.push(resolution.fallbackModel)
  }
  return modelIDs.map((modelID) => {
    const api = resolution.modelApi[modelID]
    return {
      modelID,
      apiModelID: api?.id ?? modelID,
      ...(api?.url ? { apiURL: api.url } : {}),
      resolution,
    }
  })
}

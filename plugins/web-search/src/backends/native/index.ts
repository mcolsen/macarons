import { withTimeout } from "@macarons/permission-rules"
import {
  type BackendOutcome,
  fetchFailureReason,
  type SearchParams,
  type ServerOptions,
} from "../../shared"
import { anthropicSearch } from "./anthropic"
import { chatgptSearch } from "./chatgpt"
import { mergeHeaders } from "./http"
import { moonshotSearch } from "./moonshot"
import { copilotSearch, openaiSearch } from "./openai"
import {
  type AuthStoreReader,
  loadResolutions,
  type PickedModel,
  type ProvidersClient,
  pickForActiveProvider,
} from "./resolve"
import { normalizeBaseURL } from "./scan"
import type { ActiveModel, ProviderResolution, SearchConfig } from "./types"

/**
 * The provider-native chain backend: resolve the executing assistant's provider
 * to an adapter + credentials, dispatch, and translate every miss into an
 * unavailable/error outcome the chain can fall through.
 */

const RESOLUTION_TTL_MS = 60_000

export type NativeDeps = {
  client: ProvidersClient
  /**
   * Reads OpenCode's auth store. Required, with no ambient default, because
   * an optional one fails OPEN: a construction site that forgot it would
   * silently resolve the machine's real credentials and put them on the wire —
   * from a unit test, against chatgpt.com or api.githubcopilot.com. The plugin
   * entry supplies the library reader; tests supply a stand-in.
   */
  readAuthStore: AuthStoreReader
  warn: (message: string) => void
}

type ResolutionCache = {
  at: number
  resolutions: ProviderResolution[]
}

/**
 * Effective request base, mirroring the host's own resolution
 * (provider/provider.ts: a non-empty `options.baseURL` wins, else the
 * model's `api.url` with `${VAR}` placeholders substituted from the
 * environment). Undefined lets the adapter use its public default — but
 * ONLY when no endpoint was configured at all; an `api.url` left with
 * unresolved placeholders throws instead, because falling back to the
 * public default would send the provider's credentials to a host the
 * config did not name.
 */
export function requestBaseURL(picked: PickedModel): string | undefined {
  const configured = picked.resolution.credentials.baseURL
  if (configured) return configured
  if (!picked.apiURL) return undefined
  // Collect names from the template, never from substituted credential values.
  const unresolved = new Set<string>()
  const url = picked.apiURL.replace(/\$\{([^}]+)\}/g, (raw, name: string) => {
    const value = process.env[name]
    if (value === undefined) unresolved.add(name)
    return value ?? raw
  })
  if (url.includes("${")) {
    const names = [...unresolved].join(", ")
    throw new Error(
      names
        ? `configured endpoint has unresolved variables: ${names}`
        : "configured endpoint is malformed after variable substitution",
    )
  }
  return normalizeBaseURL(picked.resolution.type, url)
}

export function createNativeBackend(deps: NativeDeps) {
  let cache: ResolutionCache | undefined

  const resolutions = async (
    signal: AbortSignal,
  ): Promise<ProviderResolution[]> => {
    // Config and auth can change mid-session (opencode auth login, config
    // edit + reload); a short TTL keeps that fresh without a providers()
    // round-trip per search.
    if (cache && Date.now() - cache.at < RESOLUTION_TTL_MS) {
      return cache.resolutions
    }
    const loaded = await loadResolutions(
      deps.client,
      deps.readAuthStore,
      signal,
      deps.warn,
    )
    // An uninterruptible lookup may finish after its attempt has settled.
    signal.throwIfAborted()
    cache = { at: Date.now(), resolutions: loaded }
    return loaded
  }

  return async (
    options: ServerOptions["native"],
    params: SearchParams,
    resolveActive: (signal: AbortSignal) => Promise<ActiveModel | undefined>,
    outerSignal: AbortSignal,
  ): Promise<BackendOutcome> => {
    if (!options.enabled) {
      return { kind: "unavailable", reason: "disabled in the plugin options" }
    }
    let picked: PickedModel | undefined
    const failures: string[] = []
    try {
      // One deadline covers lookup, auth, both models and complete body reads.
      // The race also settles work whose transport cannot honor cancellation.
      return await withTimeout(
        async (signal): Promise<BackendOutcome> => {
          const active = await resolveActive(signal)
          signal.throwIfAborted()
          if (!active) {
            return {
              kind: "unavailable",
              reason: "the executing assistant's model could not be resolved",
            }
          }
          const loaded = await resolutions(signal)
          signal.throwIfAborted()
          const candidates = pickForActiveProvider(loaded, active)
          if (!candidates.length) {
            return {
              kind: "unavailable",
              reason: `provider "${active.providerID}" has no native web search (or no credentials)`,
            }
          }
          for (const candidate of candidates) {
            signal.throwIfAborted()
            picked = candidate
            try {
              const config: SearchConfig = {
                ...picked.resolution.credentials,
                baseURL: requestBaseURL(picked),
                // Host resolveSDK precedence: provider options, then the selected model.
                headers: mergeHeaders(
                  picked.resolution.headers,
                  picked.resolution.modelApi[picked.modelID]?.headers,
                ),
                model: picked.apiModelID,
              }
              switch (picked.resolution.type) {
                case "anthropic":
                  return {
                    kind: "ok",
                    output: await anthropicSearch(config, params.query, signal),
                  }
                case "openai":
                  return {
                    kind: "ok",
                    output: await openaiSearch(config, params.query, signal),
                  }
                case "chatgpt":
                  return {
                    kind: "ok",
                    output: await chatgptSearch(config, params.query, signal),
                  }
                case "copilot":
                  return {
                    kind: "ok",
                    output: await copilotSearch(config, params.query, signal),
                  }
                case "moonshot":
                  return {
                    kind: "ok",
                    output: await moonshotSearch(
                      picked.resolution.providerID,
                      config,
                      params.query,
                      signal,
                    ),
                  }
              }
            } catch (error) {
              if (signal.aborted) throw error
              failures.push(
                `${picked.resolution.type}/${picked.modelID}: ${fetchFailureReason(error)}`,
              )
            }
          }
          return { kind: "error", reason: failures.join("; ") }
        },
        options.timeoutMs,
        { signal: outerSignal, message: "timed out" },
      )
    } catch (error) {
      failures.push(
        picked
          ? `${picked.resolution.type}/${picked.modelID}: ${fetchFailureReason(error)}`
          : fetchFailureReason(error),
      )
      return { kind: "error", reason: failures.join("; ") }
    }
  }
}

/**
 * Provider-native web search: shared types.
 *
 * Adapted from emilsvennesson/opencode-websearch v0.6.0 (MIT; see NOTICE),
 * rewritten to plain fetch and to this suite's active-provider-only scope.
 */

/** Credentials needed to call a provider API. */
export type ProviderCredentials = {
  accountId?: string
  apiKey: string
  baseURL?: string
  /** OAuth fetch wrappers apply their authentication after configured headers. */
  oauth?: boolean
}

export type ProviderType =
  | "anthropic"
  | "chatgpt"
  | "copilot"
  | "moonshot"
  | "openai"

/**
 * `chatgpt` is excluded: it is derived from OAuth credentials read from
 * auth.json, never detected from a provider entry.
 */
export type ScannableProviderType = Exclude<ProviderType, "chatgpt">

/** Fully resolved config for one search call: credentials + model. */
export type SearchConfig = ProviderCredentials & {
  headers?: Record<string, string>
  model: string
}

/**
 * One scanned provider, ready to answer a web-search call.
 *
 * - `providerID`: the OpenCode provider id; the active-provider gate
 *   matches the session's model against this directly.
 * - `type`: which adapter serves it (may flip to "chatgpt" when OAuth
 *   shadows the canonical openai entry).
 * - `lockedModel` / `fallbackModel`: models tagged `"websearch": "always"`
 *   / `"auto"` in the provider's model options, as CATALOG ids.
 * - `modelApi`: per catalog model id, the provider-facing `api.id` (wire
 *   model name when the catalog key is an alias) and `api.url` (endpoint
 *   configured via the provider/model `api` field rather than
 *   `options.baseURL`), plus that model's headers.
 */
export type ProviderResolution = {
  credentials: ProviderCredentials
  fallbackModel?: string
  headers?: Record<string, string>
  lockedModel?: string
  modelApi: Record<
    string,
    { id?: string; url?: string; headers?: Record<string, string> }
  >
  providerID: string
  type: ProviderType
}

/** The executing assistant's model, snapshotted for one tool invocation. */
export type ActiveModel = {
  modelID: string
  providerID: string
}

export type SearchHit = {
  title: string
  url: string
}

/** A provider answer: synthesized text paragraphs and/or citation hits. */
export type StructuredSearchResponse = {
  query: string
  results: (SearchHit[] | string)[]
}

/** Render the structured answer for the LLM: text, then a Sources list. */
export function formatStructuredResponse(
  response: StructuredSearchResponse,
): string {
  const texts: string[] = []
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  for (const entry of response.results) {
    if (typeof entry === "string") {
      texts.push(entry)
      continue
    }
    for (const hit of entry) {
      if (seen.has(hit.url)) continue
      seen.add(hit.url)
      hits.push(hit)
    }
  }
  const parts: string[] = []
  if (texts.length) parts.push(texts.join("\n\n"))
  if (hits.length) {
    parts.push(
      ["Sources:", ...hits.map((hit) => `- [${hit.title}](${hit.url})`)].join(
        "\n",
      ),
    )
  }
  if (!parts.length) {
    return `No search results found for "${response.query}". Please try a different query.`
  }
  return parts.join("\n\n")
}

export const SEARCH_SYSTEM_PROMPT =
  "You are an assistant for performing a web search tool use"
export const MAX_RESPONSE_TOKENS = 16_000

export function buildSearchInput(query: string): string {
  return `Perform a web search for the query: ${query}`
}

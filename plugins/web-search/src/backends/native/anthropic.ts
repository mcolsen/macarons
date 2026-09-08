import { mergeHeaders, postJson, throwApiError } from "./http"
import {
  buildSearchInput,
  formatStructuredResponse,
  MAX_RESPONSE_TOKENS,
  SEARCH_SYSTEM_PROMPT,
  type SearchConfig,
  type SearchHit,
  type StructuredSearchResponse,
} from "./types"

/**
 * Anthropic server-side web search via the Messages API. Adapted from
 * emilsvennesson/opencode-websearch v0.6.0 (MIT; see NOTICE), SDK calls
 * replaced with plain fetch.
 */

const DEFAULT_BASE_URL = "https://api.anthropic.com"
const ANTHROPIC_VERSION = "2023-06-01"
const DEFAULT_SEARCH_USES = 8

type ContentBlock = {
  type?: unknown
  text?: unknown
  content?: unknown
}

type SearchError = { errorCode: string }

function processBlock(
  block: ContentBlock,
): SearchHit[] | string | SearchError | null {
  if (block.type === "text" && typeof block.text === "string") {
    const text = block.text.trim()
    if (text) return text
  }
  if (block.type === "web_search_tool_result") {
    if (!Array.isArray(block.content)) {
      // A non-array content is the error object shape:
      // { type: "web_search_tool_result_error", error_code: … }
      const code = (block.content as { error_code?: unknown } | undefined)
        ?.error_code
      return { errorCode: typeof code === "string" ? code : "unknown" }
    }
    const hits: SearchHit[] = []
    for (const result of block.content as Array<{
      title?: unknown
      url?: unknown
    }>) {
      if (typeof result?.url !== "string") continue
      hits.push({
        title: typeof result.title === "string" ? result.title : result.url,
        url: result.url,
      })
    }
    return hits
  }
  return null
}

export function anthropicRequestBody(
  config: SearchConfig,
  query: string,
): unknown {
  return {
    model: config.model,
    max_tokens: MAX_RESPONSE_TOKENS,
    system: SEARCH_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildSearchInput(query) }],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: DEFAULT_SEARCH_USES,
      },
    ],
  }
}

export async function anthropicSearch(
  config: SearchConfig,
  query: string,
  signal: AbortSignal,
): Promise<string> {
  const base = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, "")
  const response = await postJson(
    `${base}/v1/messages`,
    mergeHeaders(
      {
        "x-api-key": config.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      config.headers,
    ),
    anthropicRequestBody(config, query),
    signal,
  )
  if (!response.ok) await throwApiError("Anthropic", response)
  const payload = (await response.json()) as { content?: unknown }
  const blocks = Array.isArray(payload.content)
    ? (payload.content as ContentBlock[])
    : []
  const structured: StructuredSearchResponse = { query, results: [] }
  const errors: string[] = []
  let hitCount = 0
  for (const block of blocks) {
    const result = processBlock(block)
    if (result === null) continue
    if (typeof result === "string") {
      structured.results.push(result)
      continue
    }
    if (Array.isArray(result)) {
      hitCount += result.length
      structured.results.push(result)
      continue
    }
    errors.push(result.errorCode)
  }
  // The API can declare the search itself failed inside an HTTP 200 (a
  // web_search_tool_result error object — max_uses_exceeded, unavailable,
  // …). Without any actual search hits that is a failed search, not an
  // answer: throw so the chain falls through instead of returning the
  // model's unsearched prose (or an error string) as a final result.
  if (errors.length && hitCount === 0) {
    throw new Error(`Anthropic web search failed: ${errors.join(", ")}`)
  }
  return formatStructuredResponse(structured)
}

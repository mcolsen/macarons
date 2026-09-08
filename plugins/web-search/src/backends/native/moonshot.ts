import { mergeHeaders, postJson, throwApiError } from "./http"
import {
  buildSearchInput,
  formatStructuredResponse,
  SEARCH_SYSTEM_PROMPT,
  type SearchConfig,
  type SearchHit,
} from "./types"

/**
 * Moonshot/Kimi builtin $web_search via the OpenAI-compatible completions
 * API. Adapted from emilsvennesson/opencode-websearch v0.6.0 (MIT; see
 * NOTICE). Kimi's builtin search is agentic: the model emits a
 * $web_search tool call whose arguments are echoed straight back as the
 * tool result (the search happens server-side), looping until it answers
 * in text or the turn cap trips.
 *
 * Divergence from upstream: a canonical moonshotai/-cn provider with no
 * configured baseURL defaults to the matching regional endpoint instead of
 * inheriting the OpenAI SDK's api.openai.com default.
 */

const MAX_SEARCH_TURNS = 8
const WEB_SEARCH_FUNCTION = "$web_search"

export function moonshotBaseURL(
  providerID: string,
  configured: string | undefined,
): string {
  if (configured) return configured.replace(/\/$/, "")
  return providerID === "moonshotai-cn"
    ? "https://api.moonshot.cn/v1"
    : "https://api.moonshot.ai/v1"
}

type ToolCall = {
  id?: unknown
  function?: { name?: unknown; arguments?: unknown }
}

type CompletionMessage = {
  content?: unknown
  tool_calls?: unknown
  annotations?: unknown
}

type Completion = {
  choices?: Array<{ finish_reason?: unknown; message?: CompletionMessage }>
}

function completionRequestBody(model: string, messages: unknown[]): unknown {
  return {
    model,
    messages,
    thinking: { type: "disabled" },
    tool_choice: "auto",
    tools: [
      { type: "builtin_function", function: { name: WEB_SEARCH_FUNCTION } },
    ],
  }
}

function validToolCalls(
  message: CompletionMessage,
): Array<{ id: string; name: string; arguments: string }> {
  if (!Array.isArray(message.tool_calls)) return []
  const calls: Array<{ id: string; name: string; arguments: string }> = []
  for (const raw of message.tool_calls as ToolCall[]) {
    if (typeof raw?.id !== "string") continue
    const name = raw.function?.name
    const args = raw.function?.arguments
    if (typeof name !== "string" || typeof args !== "string") continue
    calls.push({ id: raw.id, name, arguments: args })
  }
  return calls
}

function toolResultContent(call: { name: string; arguments: string }): string {
  if (call.name !== WEB_SEARCH_FUNCTION) {
    return JSON.stringify(`Error: unable to find tool by name '${call.name}'`)
  }
  try {
    return JSON.stringify(JSON.parse(call.arguments))
  } catch {
    return JSON.stringify({ error: "Invalid tool arguments JSON" })
  }
}

function finalOutput(query: string, message: CompletionMessage): string {
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  if (Array.isArray(message.annotations)) {
    for (const annotation of message.annotations as Array<{
      type?: unknown
      url_citation?: { title?: unknown; url?: unknown }
    }>) {
      if (annotation?.type !== "url_citation") continue
      const citation = annotation.url_citation
      if (typeof citation?.url !== "string" || seen.has(citation.url)) continue
      seen.add(citation.url)
      hits.push({
        title:
          typeof citation.title === "string" ? citation.title : citation.url,
        url: citation.url,
      })
    }
  }
  const results: (SearchHit[] | string)[] = []
  const text = typeof message.content === "string" ? message.content.trim() : ""
  if (text) results.push(text)
  if (hits.length) results.push(hits)
  return formatStructuredResponse({ query, results })
}

export async function moonshotSearch(
  providerID: string,
  config: SearchConfig,
  query: string,
  signal: AbortSignal,
): Promise<string> {
  const base = moonshotBaseURL(providerID, config.baseURL)
  const messages: unknown[] = [
    { role: "system", content: SEARCH_SYSTEM_PROMPT },
    { role: "user", content: buildSearchInput(query) },
  ]
  for (let turn = 0; turn < MAX_SEARCH_TURNS; turn++) {
    const response = await postJson(
      `${base}/chat/completions`,
      mergeHeaders(
        { Authorization: `Bearer ${config.apiKey}` },
        config.headers,
      ),
      completionRequestBody(config.model, messages),
      signal,
    )
    if (!response.ok) await throwApiError("Moonshot", response)
    const completion = (await response.json()) as Completion
    signal.throwIfAborted()
    const choice = completion.choices?.[0]
    if (!choice?.message) {
      return formatStructuredResponse({ query, results: [] })
    }
    const calls = validToolCalls(choice.message)
    if (choice.finish_reason !== "tool_calls" || !calls.length) {
      return finalOutput(query, choice.message)
    }
    messages.push({
      role: "assistant",
      content: choice.message.content ?? null,
      tool_calls: choice.message.tool_calls,
    })
    for (const call of calls) {
      messages.push({
        role: "tool",
        name: call.name,
        tool_call_id: call.id,
        content: toolResultContent(call),
      })
    }
  }
  throw new Error(
    `Moonshot web search exceeded the maximum of ${MAX_SEARCH_TURNS} tool-call turns without producing a final answer`,
  )
}

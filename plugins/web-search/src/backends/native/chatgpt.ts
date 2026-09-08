import { CHATGPT_BASE_URL } from "./auth"
import { mergeHeaders, postJson, throwApiError } from "./http"
import {
  buildSearchInput,
  formatStructuredResponse,
  SEARCH_SYSTEM_PROMPT,
  type SearchConfig,
  type SearchHit,
} from "./types"

/**
 * ChatGPT-OAuth web search against the Codex backend. Adapted from
 * emilsvennesson/opencode-websearch v0.6.0 (MIT; see NOTICE). The endpoint
 * only streams, so the response is SSE consumed incrementally: text deltas
 * accumulate and completed web_search_call items contribute source URLs.
 */

type ChatGPTEventData = {
  delta?: unknown
  item?: {
    type?: unknown
    action?: { type?: unknown; sources?: unknown }
  }
  message?: unknown
  response?: { error?: { message?: unknown } }
}

type StreamState = {
  outputText: string
  hits: SearchHit[]
  seen: Set<string>
  /** A `response.completed`/`response.incomplete` terminal event arrived. */
  completed: boolean
  /** Message from a `response.failed` or `error` event, when one arrived. */
  failure?: string
}

export function newStreamState(): StreamState {
  return { outputText: "", hits: [], seen: new Set(), completed: false }
}

function parseEventBlock(block: string): { type: string; data: string } | null {
  let data = ""
  let type = ""
  for (const line of block.split("\n")) {
    if (line.startsWith("data: ")) data += line.slice(6)
    if (line.startsWith("event: ")) type = line.slice(7)
  }
  if (!type || !data) return null
  return { type, data }
}

function applyEvent(
  event: { type: string; data: string },
  state: StreamState,
): void {
  let parsed: ChatGPTEventData
  try {
    parsed = JSON.parse(event.data) as ChatGPTEventData
  } catch {
    return
  }
  if (
    event.type === "response.output_text.delta" &&
    typeof parsed.delta === "string"
  ) {
    state.outputText += parsed.delta
  }
  if (
    event.type === "response.completed" ||
    event.type === "response.incomplete"
  ) {
    state.completed = true
  }
  if (event.type === "response.failed") {
    const message = parsed.response?.error?.message
    state.failure =
      typeof message === "string" && message ? message : "response.failed"
  }
  if (event.type === "error") {
    const message = parsed.message
    state.failure =
      typeof message === "string" && message ? message : "stream error"
  }
  if (event.type === "response.output_item.done") {
    const item = parsed.item
    if (item?.type !== "web_search_call") return
    const action = item.action
    if (action?.type !== "search" || !Array.isArray(action.sources)) return
    for (const source of action.sources as Array<{ url?: unknown }>) {
      if (typeof source?.url !== "string" || state.seen.has(source.url)) {
        continue
      }
      state.seen.add(source.url)
      state.hits.push({ title: source.url, url: source.url })
    }
  }
}

/** Split the buffer on SSE event delimiters, returning the unfinished tail. */
export function consumeSseBuffer(buffer: string, state: StreamState): string {
  let remaining = buffer
  for (;;) {
    const index = remaining.indexOf("\n\n")
    if (index === -1) return remaining
    const block = remaining.slice(0, index)
    remaining = remaining.slice(index + 2)
    const event = parseEventBlock(block)
    if (event) applyEvent(event, state)
  }
}

export function chatgptRequestBody(
  config: SearchConfig,
  query: string,
): unknown {
  return {
    model: config.model,
    instructions: SEARCH_SYSTEM_PROMPT,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: buildSearchInput(query) }],
      },
    ],
    store: false,
    stream: true,
    tool_choice: "auto",
    tools: [{ type: "web_search" }],
    include: ["web_search_call.action.sources"],
  }
}

export async function chatgptSearch(
  config: SearchConfig,
  query: string,
  signal: AbortSignal,
): Promise<string> {
  const base = (config.baseURL ?? CHATGPT_BASE_URL).replace(/\/$/, "")
  const response = await postJson(
    `${base}/responses`,
    mergeHeaders(
      { Accept: "text/event-stream", "User-Agent": "macarons-websearch" },
      config.headers,
      // Match the host's Codex OAuth fetch: token and known account win last.
      {
        Authorization: `Bearer ${config.apiKey}`,
        ...(config.accountId ? { "chatgpt-account-id": config.accountId } : {}),
      },
    ),
    chatgptRequestBody(config, query),
    signal,
  )
  if (!response.ok) await throwApiError("ChatGPT", response)
  if (!response.body) {
    throw new Error("ChatGPT API returned an empty response body")
  }
  const state = newStreamState()
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of response.body) {
    signal.throwIfAborted()
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    buffer = consumeSseBuffer(buffer, state)
  }
  buffer += decoder.decode()
  consumeSseBuffer(buffer, state)
  // A stream can declare failure inside the HTTP 200 (response.failed /
  // error events) or just stop early; neither is a searched-and-empty
  // answer. Content without a terminal event is kept — a truncated stream
  // that already produced text/sources beats failing the whole chain.
  if (state.failure) {
    throw new Error(`ChatGPT API error: ${state.failure}`)
  }
  const results: (SearchHit[] | string)[] = []
  const text = state.outputText.trim()
  if (text) results.push(text)
  if (state.hits.length) results.push(state.hits)
  if (!state.completed && !results.length) {
    throw new Error(
      "ChatGPT stream ended without a terminal event or any output",
    )
  }
  return formatStructuredResponse({ query, results })
}

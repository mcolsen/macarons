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
 * OpenAI Responses-API web search, also serving GitHub Copilot (same wire
 * shape against api.githubcopilot.com plus Copilot's identification
 * headers and source includes). Adapted from
 * emilsvennesson/opencode-websearch v0.6.0 (MIT; see NOTICE), SDK calls
 * replaced with plain fetch — which is why hit collection walks the raw
 * `output` items instead of the SDK's output_text convenience field.
 */

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"

type OutputTextPart = {
  type?: unknown
  text?: unknown
  annotations?: unknown
}

type OutputItem = {
  type?: unknown
  status?: unknown
  content?: unknown
  action?: unknown
}

function pushUnique(
  seen: Set<string>,
  hits: SearchHit[],
  title: string,
  url: string,
): void {
  if (seen.has(url)) return
  seen.add(url)
  hits.push({ title, url })
}

/** Text paragraphs and url_citation hits from message output items. */
function collectFromMessages(
  items: OutputItem[],
  seen: Set<string>,
  hits: SearchHit[],
): string[] {
  const texts: string[] = []
  for (const item of items) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue
    for (const part of item.content as OutputTextPart[]) {
      if (part.type !== "output_text" || typeof part.text !== "string") {
        continue
      }
      const text = part.text.trim()
      if (text) texts.push(text)
      if (!Array.isArray(part.annotations)) continue
      for (const annotation of part.annotations as Array<{
        type?: unknown
        title?: unknown
        url?: unknown
      }>) {
        if (annotation.type !== "url_citation") continue
        if (typeof annotation.url !== "string") continue
        pushUnique(
          seen,
          hits,
          typeof annotation.title === "string"
            ? annotation.title
            : annotation.url,
          annotation.url,
        )
      }
    }
  }
  return texts
}

/** Source URLs surfaced by `web_search_call.action.sources` (Copilot). */
function collectFromSearchCalls(
  items: OutputItem[],
  seen: Set<string>,
  hits: SearchHit[],
): void {
  for (const item of items) {
    if (item.type !== "web_search_call") continue
    const action = item.action as
      | { type?: unknown; sources?: unknown }
      | undefined
    if (action?.type !== "search" || !Array.isArray(action.sources)) continue
    for (const source of action.sources as Array<{ url?: unknown }>) {
      if (typeof source?.url !== "string") continue
      pushUnique(seen, hits, source.url, source.url)
    }
  }
}

export function parseResponsesOutput(
  query: string,
  payload: unknown,
  includeSources: boolean,
): StructuredSearchResponse {
  const response = payload as {
    status?: unknown
    error?: { message?: unknown; code?: unknown } | null
    incomplete_details?: { reason?: unknown } | null
    output?: unknown
  }
  // HTTP 200 can still represent failed or unfinished execution. Reject it
  // before collecting partial output so the configured chain can fall through.
  if (
    response.error != null ||
    response.incomplete_details != null ||
    (typeof response.status === "string" && response.status !== "completed")
  ) {
    const reason =
      response.error?.message ??
      response.error?.code ??
      response.incomplete_details?.reason ??
      response.status
    throw new Error(
      `Responses API execution failed: ${typeof reason === "string" ? reason : "unknown error"}`,
    )
  }
  const items = Array.isArray(response.output)
    ? (response.output as OutputItem[])
    : []
  for (const item of items) {
    if (
      item.type === "web_search_call" &&
      typeof item.status === "string" &&
      item.status !== "completed"
    ) {
      throw new Error(`Responses web search did not complete: ${item.status}`)
    }
  }
  const seen = new Set<string>()
  const hits: SearchHit[] = []
  const texts = collectFromMessages(items, seen, hits)
  if (includeSources) collectFromSearchCalls(items, seen, hits)
  const results: (SearchHit[] | string)[] = []
  const text = texts.join("\n\n").trim()
  if (text) results.push(text)
  if (hits.length) results.push(hits)
  return { query, results }
}

export function responsesRequestBody(
  config: SearchConfig,
  query: string,
  copilot: boolean,
): unknown {
  return {
    model: config.model,
    input: buildSearchInput(query),
    instructions: SEARCH_SYSTEM_PROMPT,
    store: false,
    max_output_tokens: MAX_RESPONSE_TOKENS,
    tools: [{ type: "web_search" }],
    ...(copilot
      ? {
          tool_choice: "auto",
          include: ["web_search_call.action.sources"],
        }
      : {}),
  }
}

export async function openaiSearch(
  config: SearchConfig,
  query: string,
  signal: AbortSignal,
): Promise<string> {
  const base = (config.baseURL ?? OPENAI_DEFAULT_BASE_URL).replace(/\/$/, "")
  const response = await postJson(
    `${base}/responses`,
    mergeHeaders({ Authorization: `Bearer ${config.apiKey}` }, config.headers),
    responsesRequestBody(config, query, false),
    signal,
  )
  if (!response.ok) await throwApiError("OpenAI", response)
  return formatStructuredResponse(
    parseResponsesOutput(query, await response.json(), false),
  )
}

export async function copilotSearch(
  config: SearchConfig,
  query: string,
  signal: AbortSignal,
): Promise<string> {
  const base = (config.baseURL ?? "https://api.githubcopilot.com").replace(
    /\/$/,
    "",
  )
  const headers = mergeHeaders(
    {
      Authorization: `Bearer ${config.apiKey}`,
      "Openai-Intent": "conversation-edits",
      "User-Agent": "macarons-websearch",
      "x-initiator": "user",
    },
    config.headers,
    config.oauth
      ? {
          Authorization: `Bearer ${config.apiKey}`,
          "Openai-Intent": "conversation-edits",
          "User-Agent": "macarons-websearch",
        }
      : undefined,
  )
  // The host's Copilot OAuth fetch replaces bearer auth and removes SDK keys.
  if (config.oauth) delete headers["x-api-key"]
  const response = await postJson(
    `${base}/responses`,
    headers,
    responsesRequestBody(config, query, true),
    signal,
  )
  if (!response.ok) await throwApiError("GitHub Copilot", response)
  return formatStructuredResponse(
    parseResponsesOutput(query, await response.json(), true),
  )
}

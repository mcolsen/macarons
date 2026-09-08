import {
  type BackendOutcome,
  backendSignal,
  DEFAULT_EXA_URL,
  fetchFailureReason,
  resolvedNumResults,
  type SearchParams,
  type ServerOptions,
  safeEndpointLabel,
} from "../shared"

/**
 * Last-resort backend replicating the builtin websearch's Exa MCP call
 * (verified against tool/mcp-websearch.ts at the pinned OpenCode version):
 * a JSON-RPC 2.0 tools/call POST for `web_search_exa`, answered as either
 * direct JSON or an SSE stream whose data lines carry the same envelope.
 *
 * Deliberately NOT replicated: the builtin's Parallel path — that request
 * carries the session id and active model name, which is exactly the leak
 * this plugin exists to close. The Exa argument set below is query-derived
 * only. EXA_API_KEY is honored the way the builtin honors it (a URL query
 * parameter), affecting billing/rate limits, not data handling — and ONLY
 * on the builtin's own endpoint: a custom `exa.url` (proxy, mock, plain
 * HTTP) never receives the credential implicitly.
 */

const EXA_TOOL_NAME = "web_search_exa"
const MAX_ERROR_REASON_LENGTH = 200

export function exaRequestUrl(base: string): string {
  const key = process.env.EXA_API_KEY
  if (!key || base !== DEFAULT_EXA_URL) return base
  return `${base}?exaApiKey=${encodeURIComponent(key)}`
}

export function exaRequestBody(params: SearchParams): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: EXA_TOOL_NAME,
      arguments: {
        query: params.query,
        type: params.type || "auto",
        numResults: resolvedNumResults(params),
        livecrawl: params.livecrawl || "fallback",
        ...(params.contextMaxCharacters !== undefined
          ? { contextMaxCharacters: params.contextMaxCharacters }
          : {}),
      },
    },
  }
}

/**
 * A classified response envelope. The upstream can declare failure inside
 * an HTTP 200 three ways — a JSON-RPC `error` member, an MCP tools/call
 * `result.isError`, or a body that is no envelope at all — and each must
 * fall through the chain instead of masquerading as a searched-and-empty
 * success (which is final and would suppress configured fallbacks).
 */
export type ExaEnvelope =
  | { kind: "text"; text: string }
  | { kind: "empty" }
  | { kind: "rpc-error"; message: string }
  | { kind: "tool-error"; message: string }

function truncated(message: string): string {
  return message.length > MAX_ERROR_REASON_LENGTH
    ? `${message.slice(0, MAX_ERROR_REASON_LENGTH)}…`
    : message
}

function envelopeFromPayload(payload: string): ExaEnvelope | null {
  const trimmed = payload.trim()
  if (!trimmed.startsWith("{")) return null
  let parsed: {
    error?: { message?: unknown; code?: unknown }
    result?: { isError?: unknown; content?: Array<{ text?: unknown }> }
  }
  try {
    parsed = JSON.parse(trimmed) as typeof parsed
  } catch {
    return null
  }
  if (parsed.error && typeof parsed.error === "object") {
    const message =
      typeof parsed.error.message === "string" && parsed.error.message
        ? parsed.error.message
        : `code ${String(parsed.error.code ?? "unknown")}`
    return { kind: "rpc-error", message: truncated(message) }
  }
  const result = parsed.result
  if (!result || typeof result !== "object") return null
  const item = Array.isArray(result.content)
    ? result.content.find(
        (entry) => typeof entry?.text === "string" && entry.text,
      )
    : undefined
  const text = typeof item?.text === "string" ? item.text : undefined
  if (result.isError === true) {
    return {
      kind: "tool-error",
      message: truncated(text ?? "tool error without a message"),
    }
  }
  return text ? { kind: "text", text } : { kind: "empty" }
}

/**
 * Direct-JSON body first, then SSE `data:` lines — the builtin's transport
 * handling, extended with envelope classification. A text success wins over
 * anything else in the stream; otherwise the first declared error, then a
 * valid-but-empty result; null when nothing parsed as an envelope.
 */
export function parseExaResponse(body: string): ExaEnvelope | null {
  const envelopes: ExaEnvelope[] = []
  const direct = envelopeFromPayload(body)
  if (direct) envelopes.push(direct)
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const envelope = envelopeFromPayload(line.slice(6))
    if (envelope) envelopes.push(envelope)
  }
  return (
    envelopes.find((entry) => entry.kind === "text") ??
    envelopes.find(
      (entry) => entry.kind === "rpc-error" || entry.kind === "tool-error",
    ) ??
    envelopes[0] ??
    null
  )
}

export async function exaSearch(
  options: ServerOptions["exa"],
  params: SearchParams,
  outerSignal: AbortSignal,
): Promise<BackendOutcome> {
  if (!options.enabled) {
    return { kind: "unavailable", reason: "disabled in the plugin options" }
  }
  const label = safeEndpointLabel(options.url)
  let response: Response
  try {
    response = await fetch(exaRequestUrl(options.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(exaRequestBody(params)),
      signal: backendSignal(outerSignal, options.timeoutMs),
    })
  } catch (error) {
    return {
      kind: "error",
      reason: `request to ${label} ${fetchFailureReason(error)}`,
    }
  }
  if (!response.ok) {
    return {
      kind: "error",
      reason: `${label} answered ${response.status}`,
    }
  }
  const envelope = parseExaResponse(await response.text())
  if (!envelope) {
    return {
      kind: "error",
      reason: `${label} answered 200 with an unrecognized body`,
    }
  }
  switch (envelope.kind) {
    case "text":
      return { kind: "ok", output: envelope.text }
    case "empty":
      return {
        kind: "ok",
        output: "No search results found. Please try a different query.",
      }
    case "rpc-error":
      return {
        kind: "error",
        reason: `${label} answered a JSON-RPC error: ${envelope.message}`,
      }
    case "tool-error":
      return {
        kind: "error",
        reason: `${label} reported a tool error: ${envelope.message}`,
      }
  }
}

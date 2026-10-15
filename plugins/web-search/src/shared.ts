import {
  clampNumber,
  explicitBoolean,
  MAX_TIMER_MS,
} from "@macarons/permission-rules"
export const DEFAULT_NUM_RESULTS = 8
export const MAX_NUM_RESULTS = 50
export const DEFAULT_SEARXNG_TIMEOUT_MS = 10000
export const DEFAULT_NATIVE_TIMEOUT_MS = 60000
export const MIN_TIMEOUT_MS = 1000
export type SearchParams = { query: string; numResults?: number }
export type BackendOutcome =
  | { kind: "ok"; output: string }
  | { kind: "unavailable" | "error"; reason: string }
export type ServerOptions = {
  searxng: { url: string | undefined; timeoutMs: number }
  native: { enabled: boolean; timeoutMs: number }
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
/** Legacy order only restricts egress; V2 owns provider selection and failover. */
export function resolveServerOptions(raw: unknown): ServerOptions {
  const options = object(raw)
  const searxng = object(options.searxng)
  const native = object(options.native)
  const allowed = (id: string) =>
    options.order === undefined ||
    (Array.isArray(options.order) && options.order.includes(id))
  return {
    searxng: {
      url:
        allowed("searxng") &&
        typeof searxng.url === "string" &&
        searxng.url.trim()
          ? searxng.url.trim().replace(/\/+$/, "")
          : undefined,
      timeoutMs: clampNumber(
        searxng.timeoutMs,
        DEFAULT_SEARXNG_TIMEOUT_MS,
        MIN_TIMEOUT_MS,
        MAX_TIMER_MS,
      ),
    },
    native: {
      enabled: allowed("native") && explicitBoolean(native.enabled, true),
      timeoutMs: clampNumber(
        native.timeoutMs,
        DEFAULT_NATIVE_TIMEOUT_MS,
        MIN_TIMEOUT_MS,
        MAX_TIMER_MS,
      ),
    },
  }
}

export function resolvedNumResults(params: SearchParams): number {
  return clampNumber(params.numResults, DEFAULT_NUM_RESULTS, 1, MAX_NUM_RESULTS)
}

/** A per-attempt signal: the tool's abort plus the backend's own timeout. */
export function backendSignal(
  outer: AbortSignal,
  timeoutMs: number,
): AbortSignal {
  return AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)])
}

/**
 * Endpoint label safe for model-visible failure output. Configured
 * SearXNG/Exa URLs may carry basic-auth userinfo or query tokens; failure
 * reasons end up as tool output (model context, transcript, telemetry), so
 * only origin + path survive. Anything that is not a plain http(s) URL gets
 * a placeholder — a broken value is not worth echoing verbatim.
 */
export function safeEndpointLabel(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "<configured endpoint>"
    }
    return parsed.pathname === "/"
      ? parsed.origin
      : `${parsed.origin}${parsed.pathname}`
  } catch {
    return "<configured endpoint>"
  }
}

/** One-line failure reason from a fetch-level error. */
export function fetchFailureReason(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "timed out"
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "aborted"
  }
  return error instanceof Error ? error.message : String(error)
}

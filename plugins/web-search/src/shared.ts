import {
  clampNumber,
  explicitBoolean,
  MAX_TIMER_MS,
} from "@macarons/permission-rules"

/**
 * @macarons/web-search — pure core
 *
 * Everything here is host-free and unit-testable: option resolution, the
 * backend chain runner, and the tool's parameter/description surface. The
 * implementation is registered under two ids — the always-visible
 * `web_search` and a `websearch` shadow of the builtin (same zod arg shape,
 * same permission action) — so search is available on every provider and a
 * query can never reach the builtin's hardcoded Exa/Parallel endpoints
 * unless the chain explicitly falls back to Exa.
 */

export const SERVICE = "web-search"

export {
  clampNumber,
  explicitBoolean,
  MAX_TIMER_MS,
} from "@macarons/permission-rules"

/** Chain position ids, in the order the options accept them. */
export const BACKEND_IDS = ["searxng", "native", "exa"] as const
export type BackendId = (typeof BACKEND_IDS)[number]

export const DEFAULT_ORDER: readonly BackendId[] = ["searxng", "native", "exa"]

export const DEFAULT_NUM_RESULTS = 8
export const MAX_NUM_RESULTS = 50
export const DEFAULT_SEARXNG_TIMEOUT_MS = 10_000
export const DEFAULT_NATIVE_TIMEOUT_MS = 60_000
export const DEFAULT_EXA_TIMEOUT_MS = 25_000
export const MIN_TIMEOUT_MS = 1_000

/** Mirrors the builtin websearch parameter surface (tool/websearch.ts). */
export type SearchParams = {
  query: string
  numResults?: number
  livecrawl?: "fallback" | "preferred"
  type?: "auto" | "fast" | "deep"
  contextMaxCharacters?: number
}

export type ServerOptions = {
  /** Backend attempt order; unknown names are dropped at resolution. */
  order: BackendId[]
  searxng: {
    /** Instance base URL; undefined leaves the backend unavailable. */
    url: string | undefined
    timeoutMs: number
  }
  native: {
    enabled: boolean
    timeoutMs: number
  }
  exa: {
    enabled: boolean
    /** Overridable so tests can point the JSON-RPC call at a mock. */
    url: string
    timeoutMs: number
  }
}

export const DEFAULT_EXA_URL = "https://mcp.exa.ai/mcp"

function isBackendId(value: unknown): value is BackendId {
  return (BACKEND_IDS as readonly unknown[]).includes(value)
}

/**
 * Resolve the raw `[spec, options]` tuple payload. Absent options take the
 * defaults, but EXPLICIT options are strict and fail closed: this plugin's
 * whole point is controlling query egress, so a typo in a value meant to
 * restrict backends must never quietly re-enable the default paid chain.
 *
 * - `order` absent → default chain. Present → only recognized names count
 *   (duplicates keep first position); unrecognized entries are dropped so a
 *   partial typo degrades to the intended SUBSET, and an order with no
 *   recognized entries (or a non-array) resolves to an EMPTY chain — the
 *   tool then reports the misconfiguration instead of searching anywhere
 *   the user did not name.
 * - `enabled` absent → true. Present → only literal `true` enables; any
 *   other value (including `"false"`, `"true"`, `1`) disables the backend.
 * - `exa.url` absent → the default endpoint. Present but not a usable
 *   string → the backend is disabled rather than silently pointed back at
 *   the real Exa endpoint.
 */
export function resolveServerOptions(raw: unknown): ServerOptions {
  const options = (raw ?? {}) as Record<string, unknown>
  const searxng = (options.searxng ?? {}) as Record<string, unknown>
  const native = (options.native ?? {}) as Record<string, unknown>
  const exa = (options.exa ?? {}) as Record<string, unknown>

  let order: BackendId[]
  if (options.order === undefined) {
    order = [...DEFAULT_ORDER]
  } else {
    order = []
    if (Array.isArray(options.order)) {
      for (const entry of options.order) {
        if (isBackendId(entry) && !order.includes(entry)) order.push(entry)
      }
    }
  }

  const url =
    typeof searxng.url === "string" && searxng.url.trim()
      ? searxng.url.trim().replace(/\/+$/, "")
      : undefined

  const exaUrlInvalid =
    exa.url !== undefined && !(typeof exa.url === "string" && exa.url.trim())

  return {
    order,
    searxng: {
      url,
      timeoutMs: clampNumber(
        searxng.timeoutMs,
        DEFAULT_SEARXNG_TIMEOUT_MS,
        MIN_TIMEOUT_MS,
        MAX_TIMER_MS,
      ),
    },
    native: {
      enabled: explicitBoolean(native.enabled, true),
      timeoutMs: clampNumber(
        native.timeoutMs,
        DEFAULT_NATIVE_TIMEOUT_MS,
        MIN_TIMEOUT_MS,
        MAX_TIMER_MS,
      ),
    },
    exa: {
      enabled: explicitBoolean(exa.enabled, true) && !exaUrlInvalid,
      url:
        typeof exa.url === "string" && exa.url.trim()
          ? exa.url.trim()
          : DEFAULT_EXA_URL,
      timeoutMs: clampNumber(
        exa.timeoutMs,
        DEFAULT_EXA_TIMEOUT_MS,
        MIN_TIMEOUT_MS,
        MAX_TIMER_MS,
      ),
    },
  }
}

// ---- backend chain ---------------------------------------------------------

/**
 * What one backend attempt produced.
 *
 * - `ok` ends the chain, including a successful search that found nothing:
 *   a healthy backend answering "no results" is a final answer, and falling
 *   through would turn every genuinely empty query into paid native/Exa
 *   traffic.
 * - `unavailable` skips silently (not configured / not applicable here).
 * - `error` records the reason and falls through to the next backend.
 */
export type BackendOutcome =
  | { kind: "ok"; output: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; reason: string }

export type Backend = {
  id: BackendId
  run(params: SearchParams, signal: AbortSignal): Promise<BackendOutcome>
}

export type ChainAttempt = {
  backend: BackendId
  kind: "unavailable" | "error"
  reason: string
}

export type ChainResult =
  | { kind: "ok"; backend: BackendId; output: string }
  | { kind: "failed"; attempts: ChainAttempt[] }

export const BACKEND_LABELS: Record<BackendId, string> = {
  searxng: "SearXNG Web Search",
  native: "Provider Web Search",
  exa: "Exa Web Search",
}

export async function runSearchChain(
  order: readonly BackendId[],
  backends: Record<BackendId, Backend>,
  params: SearchParams,
  signal: AbortSignal,
  /**
   * Fired with each backend id the instant before it is attempted (after the
   * abort check, so a backend that is skipped for an already-aborted signal
   * never reports). Purely observational — the TUI sidebar uses it to show
   * which backend a search is currently running against; it must not affect
   * the chain.
   */
  onAttempt?: (backend: BackendId) => void,
): Promise<ChainResult> {
  const attempts: ChainAttempt[] = []
  for (const id of order) {
    if (signal.aborted) {
      attempts.push({ backend: id, kind: "error", reason: "aborted" })
      break
    }
    onAttempt?.(id)
    let outcome: BackendOutcome
    try {
      outcome = await backends[id].run(params, signal)
    } catch (error) {
      // Backends report failures as outcomes; a throw is a bug, but the
      // chain still degrades to the next backend instead of dying.
      outcome = {
        kind: "error",
        reason: error instanceof Error ? error.message : String(error),
      }
    }
    if (outcome.kind === "ok") {
      return { kind: "ok", backend: id, output: outcome.output }
    }
    attempts.push({ backend: id, kind: outcome.kind, reason: outcome.reason })
  }
  return { kind: "failed", attempts }
}

/**
 * The all-backends-failed tool output. A string, not a throw, mirroring the
 * prior art this plugin adapts: the model can read why each backend was
 * skipped and adjust (different query, tell the user to fix config) instead
 * of seeing an opaque tool error.
 */
export function describeChainFailure(attempts: ChainAttempt[]): string {
  if (!attempts.length) {
    return "Web search failed: the configured backend order is empty."
  }
  const lines = attempts.map(
    (attempt) =>
      `- ${attempt.backend}: ${attempt.kind === "unavailable" ? "unavailable" : "failed"} — ${attempt.reason}`,
  )
  return [
    "Web search failed: every configured backend was unavailable or errored.",
    ...lines,
    "Nothing was searched. Fix the failing backend (or its plugin options) and retry.",
  ].join("\n")
}

// ---- tool surface ----------------------------------------------------------

/**
 * Adapted from the builtin's websearch.txt so the shadow is a drop-in: same
 * intent and usage notes, plus the one honest difference — output shape
 * varies by backend (raw result list vs synthesized cited answer).
 */
export function toolDescription(year: number): string {
  return `- Search the web - performs real-time web searches through this project's configured search backends
- Provides up-to-date information for current events and recent data
- Use this tool for accessing information beyond knowledge cutoff
- Searches are performed automatically within a single tool call

Usage notes:
  - Output shape varies by backend: a raw result list (title, URL, snippet) or a synthesized answer with a Sources list
  - When the output carries sources or URLs, cite them in your response as markdown links
  - Search types when available: 'auto' (balanced), 'fast' (quick results), 'deep' (comprehensive search)
  - Live crawling modes when available: 'fallback' (backup if cached unavailable) or 'preferred' (prioritize live crawling)

The current year is ${year}. You MUST use this year when searching for recent information or current events
- Example: If the current year is ${year} and the user asks for "latest AI news", search for "AI news ${year}", NOT "AI news ${year - 1}"`
}

/** Clamp the model-supplied result count for backends that honor it. */
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

import {
  type BackendOutcome,
  backendSignal,
  fetchFailureReason,
  resolvedNumResults,
  type SearchParams,
  type ServerOptions,
  safeEndpointLabel,
} from "../shared"

/**
 * SearXNG JSON API backend: GET <instance>/search?q=…&format=json.
 *
 * Request/response mapping follows the upstream JSON format (webutils
 * get_json_response): results[] carries {title, url, content, engine};
 * number_of_results is an unreliable aggregate and is ignored in favor of
 * results.length. The instance must list `json` in search.formats and run
 * with the limiter off — a public limiter-guarded instance answers 403 for
 * keyless JSON clients, which is why the failure hint names both settings.
 */

type SearxngResult = {
  title?: unknown
  url?: unknown
  content?: unknown
  engine?: unknown
}

export type SearxngHit = {
  title: string
  url: string
  snippet: string
  engine: string | undefined
}

export function parseSearxngResults(payload: unknown): SearxngHit[] | null {
  if (!payload || typeof payload !== "object") return null
  const results = (payload as { results?: unknown }).results
  if (!Array.isArray(results)) return null
  const hits: SearxngHit[] = []
  for (const entry of results as SearxngResult[]) {
    if (!entry || typeof entry !== "object") continue
    if (typeof entry.url !== "string" || !entry.url) continue
    hits.push({
      title: typeof entry.title === "string" ? entry.title : entry.url,
      url: entry.url,
      snippet: typeof entry.content === "string" ? entry.content : "",
      engine: typeof entry.engine === "string" ? entry.engine : undefined,
    })
  }
  return hits
}

/**
 * Engines that failed for this query, as `name (reason)` labels. SearXNG
 * reports them as `unresponsive_engines: [[name, reason], …]` on an
 * otherwise healthy HTTP 200 — timeouts, rate limits, CAPTCHAs.
 */
export function parseSearxngUnresponsiveEngines(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return []
  const raw = (payload as { unresponsive_engines?: unknown })
    .unresponsive_engines
  if (!Array.isArray(raw)) return []
  const engines: string[] = []
  for (const entry of raw) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[0]) {
      continue
    }
    engines.push(
      typeof entry[1] === "string" && entry[1]
        ? `${entry[0]} (${entry[1]})`
        : entry[0],
    )
  }
  return engines
}

export function formatSearxngOutput(
  query: string,
  hits: SearxngHit[],
  limit: number,
): string {
  const shown = hits.slice(0, limit)
  if (!shown.length) {
    return `No results found for "${query}". Try a different or broader query.`
  }
  const blocks = shown.map((hit, index) => {
    const engine = hit.engine ? ` (${hit.engine})` : ""
    const snippet = hit.snippet ? `\n   ${hit.snippet}` : ""
    return `${index + 1}. ${hit.title}${engine}\n   ${hit.url}${snippet}`
  })
  return [
    `Search results for "${query}" (${shown.length} of ${hits.length}):`,
    ...blocks,
  ].join("\n\n")
}

export function searxngRequestUrl(base: string, params: SearchParams): string {
  const url = new URL(`${base}/search`)
  url.searchParams.set("q", params.query)
  url.searchParams.set("format", "json")
  url.searchParams.set("pageno", "1")
  return url.toString()
}

export async function searxngSearch(
  options: ServerOptions["searxng"],
  params: SearchParams,
  outerSignal: AbortSignal,
): Promise<BackendOutcome> {
  if (!options.url) {
    return {
      kind: "unavailable",
      reason: "no searxng.url configured in the plugin options",
    }
  }
  const label = safeEndpointLabel(options.url)
  let response: Response
  try {
    response = await fetch(searxngRequestUrl(options.url, params), {
      headers: { Accept: "application/json" },
      signal: backendSignal(outerSignal, options.timeoutMs),
    })
  } catch (error) {
    return {
      kind: "error",
      reason: `request to ${label} ${fetchFailureReason(error)}`,
    }
  }
  if (!response.ok) {
    const hint =
      response.status === 403
        ? " (a 403 usually means the instance is missing `json` in search.formats or has the limiter enabled)"
        : ""
    return {
      kind: "error",
      reason: `${label} answered ${response.status}${hint}`,
    }
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return {
      kind: "error",
      reason: `${label} answered 200 with a non-JSON body`,
    }
  }
  const hits = parseSearxngResults(payload)
  if (hits === null) {
    return {
      kind: "error",
      reason: `${label} answered JSON without a results array`,
    }
  }
  if (!hits.length) {
    // Zero hits with reported engine failures is a failed search wearing a
    // 200, not a healthy empty answer — fall through so the chain can try
    // the next backend. A genuinely empty healthy response stays final.
    const failed = parseSearxngUnresponsiveEngines(payload)
    if (failed.length) {
      return {
        kind: "error",
        reason: `${label} returned no results and reported unresponsive engines: ${failed.join(", ")}`,
      }
    }
  }
  return {
    kind: "ok",
    output: formatSearxngOutput(params.query, hits, resolvedNumResults(params)),
  }
}

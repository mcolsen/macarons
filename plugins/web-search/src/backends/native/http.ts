/**
 * Minimal fetch plumbing shared by the native adapters. The upstream prior
 * art (see NOTICE) leans on @anthropic-ai/sdk and openai; this suite ships
 * plain fetch so the plugin bundle stays dependency-free and the request
 * shapes stay pinned in adapter tests.
 */

/** Later layers win, including case-only collisions (never comma-join auth). */
export function mergeHeaders(
  ...sources: (Record<string, string> | undefined)[]
): Record<string, string> {
  return Object.fromEntries(
    sources.flatMap((source) =>
      Object.entries(source ?? {}).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    ),
  )
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  let requestHeaders: Headers
  try {
    requestHeaders = new Headers(
      mergeHeaders({ "Content-Type": "application/json" }, headers),
    )
  } catch {
    // Bun's validation errors include header values, which can be credentials.
    throw new Error("invalid native request headers")
  }
  return fetch(url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
    signal,
  })
}

/** Enough of a provider's error body to diagnose it, bounded so a provider
 *  that returns an HTML page cannot turn one failure into a wall of text. */
const RAW_BODY_CHARS = 200

/**
 * Throw the provider's error message with its status, mirroring the
 * "<label> API error: <message> (status: <n>)" strings the prior art
 * produced from its SDK error classes. Every native adapter routes its
 * `!response.ok` path here.
 *
 * Field precedence is `error.message` before `detail`, deliberately. Both
 * shapes appear across these providers — `{"error":{"message":…}}` is the
 * documented envelope for the Anthropic/OpenAI-compatible endpoints, while
 * `{"detail":…}` is what the ChatGPT backend returns for auth and
 * entitlement failures — and a body normally carries one or the other, so
 * the order only decides a body carrying BOTH. There, the provider's own
 * `error.message` is the specific one and the gateway's `detail` the
 * generic. The ChatGPT adapter used to read these in the opposite order
 * from its four siblings; the divergence was copy drift, not a decision.
 *
 * A body that parses but carries neither field falls back to its raw text:
 * reporting "no body" for a response that HAD one sent people looking in
 * the wrong place.
 */
export async function throwApiError(
  label: string,
  response: Response,
): Promise<never> {
  let message = ""
  const text = await response.text().catch(() => "")
  if (text) {
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: unknown }
        detail?: unknown
      }
      if (typeof parsed.error?.message === "string" && parsed.error.message) {
        message = parsed.error.message
      } else if (typeof parsed.detail === "string" && parsed.detail) {
        message = parsed.detail
      } else {
        message = text.slice(0, RAW_BODY_CHARS)
      }
    } catch {
      message = text.slice(0, RAW_BODY_CHARS)
    }
  }
  throw new Error(
    `${label} API error: ${message || "no body"} (status: ${response.status})`,
  )
}

import { MAX_TIMER_MS, withTimeout } from "@macarons/permission-rules"
import { TRUNCATE_SUFFIX } from "../shared"

const DEFAULT_API_TIMEOUT_MS = 10_000
const COALESCED_READ_TIMEOUT_MS = 10_000

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}${TRUNCATE_SUFFIX}`

type Log = (level: "warn", message: string) => void

export class SafeCauseError extends Error {
  readonly safeCause: string

  constructor(message: string, safeCause = message) {
    super(message)
    this.safeCause = safeCause
  }
}

/**
 * Host transport adapter. It uses the generated client's in-process transport
 * when available and retains HTTP only as the standalone-client fallback.
 */
export function createHostAdapter(input: {
  client: unknown
  directory: string
  serverUrl: string | URL
}) {
  const transport = (
    input.client as {
      _client?: {
        request?: (options: Record<string, unknown>) => Promise<unknown>
      }
    }
  )._client
  const transportRequest = transport?.request?.bind(transport)

  const callHost = async (
    method: string,
    pathname: string,
    body: unknown,
    effectiveSignal: AbortSignal,
  ): Promise<unknown> => {
    if (transportRequest) {
      const result = (await transportRequest({
        method,
        url: pathname,
        query: { directory: input.directory },
        ...(body === undefined ? {} : { body }),
        signal: effectiveSignal,
        throwOnError: false,
      })) as
        | { data?: unknown; error?: unknown; response?: { status?: number } }
        | undefined
      if (result?.error !== undefined) {
        const status = result.response?.status
        throw new SafeCauseError(
          `${method} ${pathname} failed:${status ? ` HTTP ${status}` : ""} ${truncate(JSON.stringify(result.error), 300)}`,
          `${method} ${pathname} failed${status ? `: HTTP ${status}` : ""}`,
        )
      }
      return result?.data
    }

    const url = new URL(pathname, input.serverUrl)
    url.searchParams.set("directory", input.directory)
    const response = await fetch(url, {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: effectiveSignal,
    })
    if (!response.ok) {
      throw new SafeCauseError(
        `${method} ${pathname} failed: HTTP ${response.status} ${truncate(await response.text().catch(() => ""), 300)}`,
        `${method} ${pathname} failed: HTTP ${response.status}`,
      )
    }
    return response.json()
  }

  const api = (
    method: string,
    pathname: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    withTimeout(
      (effectiveSignal) => callHost(method, pathname, body, effectiveSignal),
      signal ? MAX_TIMER_MS : DEFAULT_API_TIMEOUT_MS,
      { signal },
    )

  return { api }
}

/** Epoch-gated, in-flight-only host-read sharing. */
export function createHostReadCoalescer(log: Log) {
  let epoch = 0
  type InFlightRead = { epoch: number; promise: Promise<unknown> }
  const reads = new Map<string, InFlightRead>()

  const fresh = <T>(
    key: string,
    read: () => Promise<T | undefined>,
  ): Promise<T | undefined> =>
    new Promise<T | undefined>((resolve) => {
      const timer = setTimeout(() => {
        log(
          "warn",
          `the shared "${key}" read did not settle within ${COALESCED_READ_TIMEOUT_MS}ms; failing it for all sharers`,
        )
        resolve(undefined)
      }, COALESCED_READ_TIMEOUT_MS)
      read().then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        () => {
          clearTimeout(timer)
          resolve(undefined)
        },
      )
    })

  const coalesce = <T>(
    key: string,
    read: () => Promise<T | undefined>,
  ): Promise<T | undefined> => {
    const existing = reads.get(key)
    if (existing && existing.epoch === epoch)
      return existing.promise as Promise<T | undefined>
    const entry: InFlightRead = { epoch, promise: Promise.resolve(undefined) }
    entry.promise = fresh(key, read).finally(() => {
      if (reads.get(key) === entry) reads.delete(key)
    })
    reads.set(key, entry)
    return entry.promise as Promise<T | undefined>
  }

  return {
    coalesce,
    fresh,
    advanceEpoch: () => {
      epoch += 1
    },
  }
}

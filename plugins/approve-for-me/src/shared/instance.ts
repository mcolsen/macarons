import { randomUUID } from "node:crypto"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

const PROTOCOL = "macarons.permissions-approve-for-me.instance.v1"
const REQUEST_PREFIX = `${PROTOCOL}.request.`
const RESPONSE_PREFIX = `${PROTOCOL}.response.`
const DEFAULT_TIMEOUT_MS = 2_000
const MAX_TIMEOUT_MS = 10_000
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type PublishClient = {
  tui: {
    publish: (options: {
      body: {
        type: "tui.command.execute"
        properties: { command: string }
      }
      query: { directory: string }
    }) => unknown
  }
}

type DiscoveryApi = Pick<
  TuiPluginApi,
  "client" | "event" | "lifecycle" | "state"
>

function publishFailed(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    result.error !== undefined
  )
}

function commandOf(event: unknown): string | undefined {
  if (
    typeof event !== "object" ||
    event === null ||
    !("type" in event) ||
    event.type !== "tui.command.execute" ||
    !("properties" in event) ||
    typeof event.properties !== "object" ||
    event.properties === null ||
    !("command" in event.properties) ||
    typeof event.properties.command !== "string"
  ) {
    return undefined
  }
  return event.properties.command
}

function requestIDOf(event: unknown): string | undefined {
  const command = commandOf(event)
  if (!command?.startsWith(REQUEST_PREFIX)) return undefined
  const requestID = command.slice(REQUEST_PREFIX.length)
  return UUID_V4.test(requestID) ? requestID.toLowerCase() : undefined
}

function responseOf(
  event: unknown,
): { requestID: string; instanceID: string } | undefined {
  const command = commandOf(event)
  if (!command?.startsWith(RESPONSE_PREFIX)) return undefined
  const fields = command.slice(RESPONSE_PREFIX.length).split(".")
  if (fields.length !== 2) return undefined
  const requestID = fields[0]
  const instanceID = fields[1]
  if (!requestID || !instanceID) return undefined
  if (!UUID_V4.test(requestID) || !UUID_V4.test(instanceID)) return undefined
  return {
    requestID: requestID.toLowerCase(),
    instanceID: instanceID.toLowerCase(),
  }
}

/** Respond to one valid v1 identity request received by the server plugin. */
export async function respondInstanceRequest(
  client: PublishClient,
  event: unknown,
  instanceID: string,
  directory: string,
): Promise<boolean> {
  const requestID = requestIDOf(event)
  if (!requestID || !UUID_V4.test(instanceID)) return false

  try {
    const result = await client.tui.publish({
      body: {
        type: "tui.command.execute",
        properties: {
          command: `${RESPONSE_PREFIX}${requestID}.${instanceID.toLowerCase()}`,
        },
      },
      query: { directory },
    })
    return !publishFailed(result)
  } catch {
    return false
  }
}

/**
 * Discover the lowercase UUID of the server backing this TUI's SDK client.
 * timeoutMs defaults to 2,000 and is clamped to 0..10,000 milliseconds;
 * non-finite values use the default.
 */
export async function requestInstanceID(
  api: DiscoveryApi,
  options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
  const signal = api.lifecycle.signal
  if (signal.aborted) return undefined

  const requestID = randomUUID()
  const requestedTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(0, Math.min(MAX_TIMEOUT_MS, requestedTimeout))
    : DEFAULT_TIMEOUT_MS

  return await new Promise<string | undefined>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = () => {}

    const finish = (instanceID?: string) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      unsubscribe()
      resolve(instanceID)
    }
    const onAbort = () => finish()

    try {
      unsubscribe = api.event.on("tui.command.execute", (event) => {
        const response = responseOf(event)
        if (response?.requestID === requestID) finish(response.instanceID)
      })
    } catch {
      finish()
      return
    }

    signal.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => finish(), timeoutMs)

    // Abort may have raced listener registration. Check again before sending.
    if (signal.aborted) {
      finish()
      return
    }

    try {
      const publish = api.client.tui.publish({
        body: {
          type: "tui.command.execute",
          properties: { command: `${REQUEST_PREFIX}${requestID}` },
        },
        directory: api.state.path.directory,
      })
      // Delivery can outlive discovery. Observe SDK error results and network
      // rejections without awaiting a transport that may never settle; only a
      // correlated event proves identity.
      void Promise.resolve(publish).then(
        (result) => {
          if (publishFailed(result)) finish()
        },
        () => finish(),
      )
    } catch {
      finish()
    }
  })
}

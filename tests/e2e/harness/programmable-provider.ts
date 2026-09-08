const DEFAULT_WAIT_TIMEOUT_MS = 10_000

type JsonObject = Record<string, unknown>

export type ChatMessage = JsonObject & {
  role?: string
}

export type ChatCompletionRequest = JsonObject & {
  messages?: ChatMessage[]
  model?: string
  stream?: boolean
  tools?: unknown[]
}

export type ProviderReply =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; name: string; args: Record<string, unknown> }

export type RespondContext = {
  request: ChatCompletionRequest
  /** Zero-based arrival order of this request. */
  index: number
  hasTool(name: string): boolean
  hasToolResultAfterLastUser(): boolean
}

export type ProgrammableProviderOptions = {
  /** Decides the streamed reply for each incoming completion request. */
  respond(context: RespondContext): ProviderReply
}

export type RequestWaitOptions = {
  timeoutMs?: number
}

export type ProgrammableProvider = {
  /** OpenAI-compatible base URL for OpenCode's provider configuration. */
  readonly baseURL: string
  /** Loopback-only origin of the fake provider. */
  readonly origin: string
  readonly port: number
  /** Resolves after the bound server answers its health check. */
  readonly ready: Promise<void>
  /** Request bodies in arrival order. */
  readonly requests: readonly ChatCompletionRequest[]
  readonly closed: boolean
  waitUntilReady(): Promise<void>
  waitForRequestCount(
    count: number,
    options?: RequestWaitOptions,
  ): Promise<readonly ChatCompletionRequest[]>
  close(): Promise<void>
}

type RequestWaiter = {
  count: number
  reject: (error: Error) => void
  resolve: (requests: readonly ChatCompletionRequest[]) => void
  timer: ReturnType<typeof setTimeout>
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasAdvertisedTool(
  request: ChatCompletionRequest,
  name: string,
): boolean {
  return (
    Array.isArray(request.tools) &&
    request.tools.some((tool) => {
      if (
        !isJsonObject(tool) ||
        tool.type !== "function" ||
        !isJsonObject(tool.function)
      ) {
        return false
      }
      return tool.function.name === name
    })
  )
}

/**
 * Tool results from an earlier turn must not finish a later turn. OpenCode sends
 * the complete message history on every request, so only inspect messages after
 * the newest user message.
 */
function hasToolResultAfterLastUser(messages: readonly ChatMessage[]): boolean {
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index
      break
    }
  }

  if (lastUserIndex === -1) return false
  return messages
    .slice(lastUserIndex + 1)
    .some((message) => message.role === "tool")
}

function completionChunk(
  id: string,
  model: string,
  choice: JsonObject,
): JsonObject {
  return {
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, ...choice }],
  }
}

function sseResponse(chunks: readonly JsonObject[]): Response {
  const encoder = new TextEncoder()
  const frames = [
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    "data: [DONE]\n\n",
  ]
  let index = 0

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const frame = frames[index]
      index += 1
      if (frame === undefined) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(frame))
    },
  })

  return new Response(body, {
    headers: {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  })
}

function toolCallChunks(
  id: string,
  model: string,
  toolCallID: string,
  name: string,
  args: Record<string, unknown>,
): JsonObject[] {
  return [
    completionChunk(id, model, {
      delta: { role: "assistant" },
      finish_reason: null,
    }),
    completionChunk(id, model, {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: toolCallID,
            type: "function",
            function: { name, arguments: "" },
          },
        ],
      },
      finish_reason: null,
    }),
    completionChunk(id, model, {
      delta: {
        tool_calls: [
          { index: 0, function: { arguments: JSON.stringify(args) } },
        ],
      },
      finish_reason: null,
    }),
    completionChunk(id, model, { delta: {}, finish_reason: "tool_calls" }),
  ]
}

function textChunks(id: string, model: string, text: string): JsonObject[] {
  return [
    completionChunk(id, model, {
      delta: { role: "assistant" },
      finish_reason: null,
    }),
    completionChunk(id, model, {
      delta: { content: text },
      finish_reason: null,
    }),
    completionChunk(id, model, { delta: {}, finish_reason: "stop" }),
  ]
}

/**
 * Start a deterministic, loopback-only OpenAI-compatible server for E2E tests.
 *
 * Unlike the scripted provider (fixed one-bash-call-per-turn choreography),
 * this one hands every completion request to the caller's `respond` callback,
 * which picks a text or tool-call reply per request — enough to script
 * multi-model, multi-session journeys such as a plan handoff.
 */
export function createProgrammableProvider(
  options: ProgrammableProviderOptions,
): ProgrammableProvider {
  const requests: ChatCompletionRequest[] = []
  const waiters = new Set<RequestWaiter>()
  let completionNumber = 0
  let toolCallNumber = 0
  let isClosed = false

  function settleRequestWaiters(): void {
    for (const waiter of waiters) {
      if (requests.length < waiter.count) continue
      clearTimeout(waiter.timer)
      waiters.delete(waiter)
      waiter.resolve(requests.slice(0, waiter.count))
    }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(incoming): Promise<Response> {
      const url = new URL(incoming.url)

      if (url.pathname === "/health") {
        return Response.json({ healthy: true })
      }

      if (url.pathname !== "/v1/chat/completions") {
        return Response.json(
          { error: { message: "Not found" } },
          { status: 404 },
        )
      }

      if (incoming.method !== "POST") {
        return Response.json(
          { error: { message: "Method not allowed" } },
          { status: 405, headers: { Allow: "POST" } },
        )
      }

      let parsed: unknown
      try {
        parsed = await incoming.json()
      } catch {
        return Response.json(
          { error: { message: "Invalid JSON body" } },
          { status: 400 },
        )
      }

      if (!isJsonObject(parsed)) {
        return Response.json(
          { error: { message: "Expected a JSON object" } },
          { status: 400 },
        )
      }

      const request = parsed as ChatCompletionRequest
      const index = requests.length
      requests.push(request)
      settleRequestWaiters()

      completionNumber += 1
      const id = `chatcmpl-programmable-${completionNumber}`
      const model =
        typeof request.model === "string" ? request.model : "fake/test"
      const messages = Array.isArray(request.messages)
        ? request.messages.filter(isJsonObject)
        : []

      const reply = options.respond({
        request,
        index,
        hasTool: (name) => hasAdvertisedTool(request, name),
        hasToolResultAfterLastUser: () =>
          hasToolResultAfterLastUser(messages as ChatMessage[]),
      })

      if (reply.kind === "tool_call") {
        toolCallNumber += 1
        return sseResponse(
          toolCallChunks(
            id,
            model,
            `call_programmable_${toolCallNumber}`,
            reply.name,
            reply.args,
          ),
        )
      }

      return sseResponse(textChunks(id, model, reply.text))
    },
  })

  const port = server.port
  if (port === undefined) {
    void server.stop(true)
    throw new Error("Programmable provider did not bind a TCP port")
  }

  const origin = `http://127.0.0.1:${port}`
  const baseURL = `${origin}/v1`
  const ready = fetch(`${origin}/health`).then((response) => {
    if (!response.ok)
      throw new Error(
        `Programmable provider health check failed: ${response.status}`,
      )
  })

  return {
    baseURL,
    origin,
    port,
    ready,
    get requests() {
      return requests
    },
    get closed() {
      return isClosed
    },
    waitUntilReady() {
      return ready
    },
    waitForRequestCount(count, waitOptions = {}) {
      if (!Number.isInteger(count) || count < 0) {
        return Promise.reject(
          new Error(
            `Request count must be a non-negative integer, got ${count}`,
          ),
        )
      }
      if (requests.length >= count)
        return Promise.resolve(requests.slice(0, count))
      if (isClosed)
        return Promise.reject(
          new Error("Programmable provider closed before receiving requests"),
        )

      const timeoutMs = waitOptions.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        return Promise.reject(
          new Error(`Timeout must be a non-negative number, got ${timeoutMs}`),
        )
      }

      return new Promise((resolve, reject) => {
        const waiter: RequestWaiter = {
          count,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter)
            reject(
              new Error(
                `Timed out waiting for ${count} provider requests after ${timeoutMs}ms (received ${requests.length})`,
              ),
            )
          }, timeoutMs),
        }
        waiters.add(waiter)
      })
    },
    async close() {
      if (isClosed) return
      isClosed = true
      const error = new Error(
        "Programmable provider closed before receiving requests",
      )
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
      waiters.clear()
      await server.stop(true)
    },
  }
}

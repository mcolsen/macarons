const DEFAULT_FINAL_TEXT = "done"
const DEFAULT_WAIT_TIMEOUT_MS = 10_000
const TOOL_NAME = "bash"

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

export type ScriptedToolCall = {
  /** Tool to invoke; only emitted when the request advertises it. */
  tool: string
  /** JSON arguments for the call. */
  arguments: JsonObject
}

export type ScriptedProviderOptions = {
  /** Shell command returned in the next bash tool call. Ignored when `toolCall` or `commands` is set. */
  command?: string
  /**
   * Per-turn command script: tool round N of a user turn runs commands[N] and
   * the turn ends with `finalText` once every command has a tool result. When
   * set it overrides `command`, turning each user turn into a sequential
   * multi-tool-call conversation — the shape a busy sub-agent produces. An
   * ARRAY entry emits all of its commands as parallel tool calls in ONE
   * assistant message — the shape a turn of concurrent tool calls produces —
   * and the round completes once every one of them has a tool result.
   */
  commands?: readonly (string | readonly string[])[]
  /** Text returned after a tool result for the current user turn. */
  finalText?: string
  /** Human-readable description included in the bash tool arguments. */
  toolDescription?: string
  /** Verdict returned (as JSON text) to approve-for-me classifier requests. */
  classifierVerdict?: unknown
  /**
   * Emit a fixed custom tool call instead of the default bash one, capped at
   * `maxToolCalls` calls across the whole session (further turns get
   * finalText). Mutually exclusive with `toolCall`.
   */
  tool?: ScriptedToolCall
  /** Cap on total tool calls emitted for `tool`; further turns get finalText. Default: unbounded. */
  maxToolCalls?: number
  /**
   * Overrides the default bash scripting: called with the newest user
   * message's text for each completion request, before that turn has a tool
   * result. Return one tool call or a parallel group to emit for the turn, or
   * undefined to answer with text instead.
   */
  toolCall?: (
    lastUserText: string,
  ) => ScriptedToolCall | readonly ScriptedToolCall[] | undefined
}

/**
 * How approve-for-me classifier calls answer. Exactly one of
 * `verdict`, `rawText`, and `status` applies: `verdict` is serialized to JSON
 * text (the well-behaved case), `rawText` is returned verbatim (an
 * unparseable verdict must fail closed), `status` makes the completion
 * endpoint fail outright. `delayMs` and `gated` hold the response first —
 * fixed model latency and a manual latch respectively — so suites can pile
 * up concurrent classifications deterministically.
 */
export type ClassifierBehavior = {
  verdict?: unknown
  rawText?: string
  status?: number
  /** Hold each classifier response this long before answering. */
  delayMs?: number
  /** Hold classifier responses until releaseClassifiers() frees them. */
  gated?: boolean
}

/** One classifier call as the provider saw it, with wall-clock bookkeeping. */
export type ClassifierRecord = {
  request: ChatCompletionRequest
  /** ms epoch when the request hit the endpoint. */
  arrivedAt: number
  /** ms epoch when the response was released (after any delay/gate). */
  respondedAt?: number
}

// approve-for-me sends its classifier prompts with a system message
// containing this marker; nothing else in the suites does.
const CLASSIFIER_MARKER = "permission gatekeeper"

function messageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      isJsonObject(part) && typeof part.text === "string" ? part.text : "",
    )
    .join("\n")
}

export function isClassifierRequest(request: ChatCompletionRequest): boolean {
  return (
    Array.isArray(request.messages) &&
    request.messages.some(
      (message) =>
        message.role === "system" &&
        messageText(message.content).includes(CLASSIFIER_MARKER),
    )
  )
}

export type RequestWaitOptions = {
  timeoutMs?: number
}

export type ScriptedProvider = {
  /** OpenAI-compatible base URL for OpenCode's provider configuration. */
  readonly baseURL: string
  /** Loopback-only origin of the fake provider. */
  readonly origin: string
  readonly port: number
  /** Resolves after the bound server answers its health check. */
  readonly ready: Promise<void>
  /** Request bodies in arrival order. */
  readonly requests: readonly ChatCompletionRequest[]
  /** The subset of requests that came from the Approve for Me classifier. */
  readonly classifierRequests: readonly ChatCompletionRequest[]
  /** Classifier calls with arrival/response timestamps, in arrival order. */
  readonly classifierRecords: readonly ClassifierRecord[]
  /** Classifier calls currently being held or answered. */
  readonly classifierInFlight: number
  /** The most classifier calls ever held or answered at once. */
  readonly maxClassifierInFlight: number
  readonly closed: boolean
  setCommand(command: string): void
  /** Replace (or with undefined, clear) the per-turn command script. */
  setCommands(
    commands: readonly (string | readonly string[])[] | undefined,
  ): void
  setClassifier(behavior: ClassifierBehavior): void
  /** Free up to `count` gate-held classifier responses; returns how many. */
  releaseClassifiers(count?: number): number
  /** Free the one gate-held call whose record matches; false when none does. */
  releaseClassifierMatching(
    predicate: (record: ClassifierRecord) => boolean,
  ): boolean
  waitUntilReady(): Promise<void>
  waitForRequestCount(
    count: number,
    options?: RequestWaitOptions,
  ): Promise<readonly ChatCompletionRequest[]>
  /** Resolves once `count` classifier calls have ARRIVED (not answered). */
  waitForClassifierCount(
    count: number,
    options?: RequestWaitOptions,
  ): Promise<void>
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
 * Tool results from an earlier turn must not finish a later turn. OpenCode
 * sends the complete message history on every request, so only count messages
 * after the newest user message: the count is the current turn's completed
 * tool round, which doubles as the index into a per-turn command script.
 */
function toolResultsAfterLastUser(messages: readonly ChatMessage[]): number {
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index
      break
    }
  }

  if (lastUserIndex === -1) return 0
  return messages
    .slice(lastUserIndex + 1)
    .filter((message) => message.role === "tool").length
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

type EmittedToolCall = {
  toolCallID: string
  toolName: string
  argumentsJson: string
}

/** One assistant message carrying every listed tool call — several entries
 *  are the parallel-tool-call shape a single turn can produce. */
function toolCallChunks(
  id: string,
  model: string,
  calls: readonly EmittedToolCall[],
): JsonObject[] {
  return [
    completionChunk(id, model, {
      delta: { role: "assistant" },
      finish_reason: null,
    }),
    ...calls.flatMap((call, index) => [
      completionChunk(id, model, {
        delta: {
          tool_calls: [
            {
              index,
              id: call.toolCallID,
              type: "function",
              function: { name: call.toolName, arguments: "" },
            },
          ],
        },
        finish_reason: null,
      }),
      completionChunk(id, model, {
        delta: {
          tool_calls: [{ index, function: { arguments: call.argumentsJson } }],
        },
        finish_reason: null,
      }),
    ]),
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

// The newest user message's text, for `toolCall` scripting to dispatch on.
function lastUserText(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "user") return messageText(message.content)
  }
  return ""
}

/**
 * Start a deterministic, loopback-only OpenAI-compatible server for E2E tests.
 *
 * For each user turn it emits one bash tool call (or whatever the `toolCall`
 * script decides for that turn). Once OpenCode includes that turn's tool
 * result in the message history, it emits `finalText`. Requests that do not
 * advertise the scripted tool (for example title generation) receive text.
 */
export function createScriptedProvider(
  options: ScriptedProviderOptions,
): ScriptedProvider {
  let command = options.command
  let commands = options.commands
  const finalText = options.finalText ?? DEFAULT_FINAL_TEXT
  const description = options.toolDescription ?? "Run deterministic E2E command"
  const scriptedTool = options.tool
  const toolName = scriptedTool?.tool ?? TOOL_NAME
  const maxToolCalls = options.maxToolCalls ?? Number.POSITIVE_INFINITY
  let classifier: ClassifierBehavior = {
    verdict: options.classifierVerdict ?? {
      decision: "approve",
      risk: "low",
      authorization: "implied",
      reason: "scripted approval",
    },
  }
  const requests: ChatCompletionRequest[] = []
  const classifierRecords: ClassifierRecord[] = []
  const waiters = new Set<RequestWaiter>()
  const classifierWaiters = new Set<RequestWaiter>()
  const gateHolds: { record: ClassifierRecord; release: () => void }[] = []
  let classifierInFlight = 0
  let maxClassifierInFlight = 0
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

  function settleClassifierWaiters(): void {
    for (const waiter of classifierWaiters) {
      if (classifierRecords.length < waiter.count) continue
      clearTimeout(waiter.timer)
      classifierWaiters.delete(waiter)
      waiter.resolve(
        classifierRecords
          .slice(0, waiter.count)
          .map((record) => record.request),
      )
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
      requests.push(request)
      settleRequestWaiters()

      completionNumber += 1
      const id = `chatcmpl-scripted-${completionNumber}`
      const model =
        typeof request.model === "string" ? request.model : "fake/test"
      const messages = Array.isArray(request.messages)
        ? request.messages.filter(isJsonObject)
        : []

      // Classifier calls are recognized before the tool branch: the classifier
      // session disables tools, but if the host ever advertised them anyway,
      // answering with a tool call instead of a verdict would wedge the flow.
      if (isClassifierRequest(request)) {
        const record: ClassifierRecord = { request, arrivedAt: Date.now() }
        classifierRecords.push(record)
        classifierInFlight += 1
        maxClassifierInFlight = Math.max(
          maxClassifierInFlight,
          classifierInFlight,
        )
        settleClassifierWaiters()
        // The behavior at arrival governs the whole call, so re-configuring
        // the gate mid-test never strands an already-arrived request.
        const behavior = classifier
        try {
          if (behavior.delayMs) await Bun.sleep(behavior.delayMs)
          if (behavior.gated && !isClosed) {
            await new Promise<void>((release) => {
              gateHolds.push({ record, release })
            })
          }
          if (behavior.status) {
            return Response.json(
              { error: { message: "Scripted classifier failure" } },
              { status: behavior.status },
            )
          }
          const text = behavior.rawText ?? JSON.stringify(behavior.verdict)
          return sseResponse(textChunks(id, model, text))
        } finally {
          classifierInFlight -= 1
          record.respondedAt = Date.now()
        }
      }

      // A static `tool` emits a fixed custom tool call, at most once per user
      // turn and capped at `maxToolCalls` across the whole session. A `toolCall`
      // script emits at most one custom tool call per user turn. Otherwise
      // replay the per-turn bash command script (`commands`, or the single
      // `command`), one tool call per round until it is exhausted.
      if (scriptedTool) {
        if (
          hasAdvertisedTool(request, toolName) &&
          toolResultsAfterLastUser(messages as ChatMessage[]) === 0 &&
          toolCallNumber < maxToolCalls
        ) {
          toolCallNumber += 1
          return sseResponse(
            toolCallChunks(id, model, [
              {
                toolCallID: `call_scripted_${toolCallNumber}`,
                toolName,
                argumentsJson: JSON.stringify(scriptedTool.arguments),
              },
            ]),
          )
        }
      } else if (options.toolCall) {
        if (toolResultsAfterLastUser(messages as ChatMessage[]) === 0) {
          const scripted = options.toolCall(
            lastUserText(messages as ChatMessage[]),
          )
          const calls: readonly ScriptedToolCall[] = Array.isArray(scripted)
            ? scripted
            : scripted
              ? [scripted as ScriptedToolCall]
              : []
          if (
            calls.length > 0 &&
            calls.every((call) => hasAdvertisedTool(request, call.tool))
          ) {
            const emittedCalls: EmittedToolCall[] = []
            for (const call of calls) {
              toolCallNumber += 1
              emittedCalls.push({
                toolCallID: `call_scripted_${toolCallNumber}`,
                toolName: call.tool,
                argumentsJson: JSON.stringify(call.arguments),
              })
            }
            return sseResponse(toolCallChunks(id, model, emittedCalls))
          }
        }
      } else if (hasAdvertisedTool(request, TOOL_NAME)) {
        const script = commands ?? (command === undefined ? [] : [command])
        // Map the turn's completed tool results onto script rounds: a string
        // round is one call, an array round that many parallel calls in one
        // assistant message. The next round is emitted only at an exact
        // round boundary — a partial round means its calls are still running.
        const done = toolResultsAfterLastUser(messages as ChatMessage[])
        let consumed = 0
        let round: string | readonly string[] | undefined
        for (const entry of script) {
          const width = typeof entry === "string" ? 1 : entry.length
          if (done < consumed + width) {
            round = entry
            break
          }
          consumed += width
        }
        if (round !== undefined && done === consumed) {
          const group = typeof round === "string" ? [round] : round
          return sseResponse(
            toolCallChunks(
              id,
              model,
              group.map((groupCommand) => {
                toolCallNumber += 1
                return {
                  toolCallID: `call_scripted_${toolCallNumber}`,
                  toolName: TOOL_NAME,
                  argumentsJson: JSON.stringify({
                    command: groupCommand,
                    description,
                  }),
                }
              }),
            ),
          )
        }
      }

      return sseResponse(textChunks(id, model, finalText))
    },
  })

  const port = server.port
  if (port === undefined) {
    void server.stop(true)
    throw new Error("Scripted provider did not bind a TCP port")
  }

  const origin = `http://127.0.0.1:${port}`
  const baseURL = `${origin}/v1`
  const ready = fetch(`${origin}/health`).then((response) => {
    if (!response.ok)
      throw new Error(
        `Scripted provider health check failed: ${response.status}`,
      )
  })

  function releaseClassifiers(count = Number.POSITIVE_INFINITY): number {
    let released = 0
    while (released < count && gateHolds.length) {
      gateHolds.shift()?.release()
      released += 1
    }
    return released
  }

  // Frees ONE held call picked by its record, regardless of arrival order.
  // FIFO release completes verdicts in dispatch order — which is already the
  // plugin's stack order — so only an out-of-order release can prove replies
  // are gated on the release order rather than on verdict completion.
  function releaseClassifierMatching(
    predicate: (record: ClassifierRecord) => boolean,
  ): boolean {
    const index = gateHolds.findIndex((held) => predicate(held.record))
    if (index === -1) return false
    const [held] = gateHolds.splice(index, 1)
    if (!held) return false
    held.release()
    return true
  }

  return {
    baseURL,
    origin,
    port,
    ready,
    get requests() {
      return requests
    },
    get classifierRequests() {
      return classifierRecords.map((record) => record.request)
    },
    get classifierRecords() {
      return classifierRecords
    },
    get classifierInFlight() {
      return classifierInFlight
    },
    get maxClassifierInFlight() {
      return maxClassifierInFlight
    },
    get closed() {
      return isClosed
    },
    setCommand(nextCommand) {
      if (isClosed)
        throw new Error("Cannot configure a closed scripted provider")
      command = nextCommand
    },
    setCommands(nextCommands) {
      if (isClosed)
        throw new Error("Cannot configure a closed scripted provider")
      commands = nextCommands
    },
    setClassifier(behavior) {
      if (isClosed)
        throw new Error("Cannot configure a closed scripted provider")
      classifier = behavior
    },
    releaseClassifiers,
    releaseClassifierMatching,
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
          new Error("Scripted provider closed before receiving requests"),
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
    async waitForClassifierCount(count, waitOptions = {}) {
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(
          `Classifier count must be a non-negative integer, got ${count}`,
        )
      }
      if (classifierRecords.length >= count) return
      if (isClosed)
        throw new Error(
          "Scripted provider closed before receiving classifier requests",
        )

      const timeoutMs = waitOptions.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new Error(
          `Timeout must be a non-negative number, got ${timeoutMs}`,
        )
      }

      await new Promise<readonly ChatCompletionRequest[]>((resolve, reject) => {
        const waiter: RequestWaiter = {
          count,
          resolve,
          reject,
          timer: setTimeout(() => {
            classifierWaiters.delete(waiter)
            reject(
              new Error(
                `Timed out waiting for ${count} classifier requests after ${timeoutMs}ms (received ${classifierRecords.length})`,
              ),
            )
          }, timeoutMs),
        }
        classifierWaiters.add(waiter)
      })
    },
    async close() {
      if (isClosed) return
      isClosed = true
      // Gate-held classifier calls must finish, not dangle, or their fetch
      // handlers would leak past the test that latched them.
      releaseClassifiers()
      const error = new Error(
        "Scripted provider closed before receiving requests",
      )
      for (const waiter of [...waiters, ...classifierWaiters]) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
      waiters.clear()
      classifierWaiters.clear()
      await server.stop(true)
    },
  }
}

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  createOpencodeClient,
  type Event,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2"
import {
  discardSideQuestion,
  markerOf,
  resolveOptions,
  startSideQuestion,
} from "../../../plugins/btw/src/shared"
import { EventRecorder } from "../harness/events"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import { writeBtwConfig } from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import {
  type ChatCompletionRequest,
  createScriptedProvider,
  type ScriptedProvider,
} from "../harness/scripted-provider"
import { waitFor } from "../harness/wait"

type SessionIdle = Extract<Event, { type: "session.idle" }>

const isIdle =
  (sessionID: string) =>
  (event: Event): event is SessionIdle =>
    event.type === "session.idle" && event.properties.sessionID === sessionID

function clientFor(server: OpenCodeProcess, directory: string): OpencodeClient {
  return createOpencodeClient({ baseUrl: server.url, directory })
}

async function createSession(
  client: OpencodeClient,
  directory: string,
  title: string,
) {
  const result = await client.session.create({ directory, title })
  if (result.error || !result.data)
    throw new Error(`Could not create session: ${JSON.stringify(result.error)}`)
  return result.data.id
}

async function promptParent(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
  text: string,
) {
  const result = await client.session.promptAsync({
    directory,
    sessionID,
    model: { providerID: "e2e", modelID: "test" },
    parts: [{ type: "text", text }],
  })
  if (result.error)
    throw new Error(`Could not prompt: ${JSON.stringify(result.error)}`)
}

// Content of every message with the given role, flattened to plain text.
function textOf(request: ChatCompletionRequest, role: string): string[] {
  const messages = Array.isArray(request.messages) ? request.messages : []
  return messages
    .filter((message) => message.role === role)
    .map((message) => {
      const content = (message as { content?: unknown }).content
      if (typeof content === "string") return content
      if (Array.isArray(content)) {
        return content
          .map((part) =>
            part && typeof part === "object"
              ? String((part as { text?: unknown }).text ?? "")
              : "",
          )
          .join("")
      }
      return ""
    })
}

const systemText = (request: ChatCompletionRequest) =>
  textOf(request, "system").join("\n---\n")
const hasSideQuestion = (request: ChatCompletionRequest) =>
  [...textOf(request, "user")].some((text) => text.includes("<side-question>"))
const advertisesTool = (request: ChatCompletionRequest, name: string) =>
  Array.isArray(request.tools) &&
  request.tools.some((tool) => {
    const fn =
      tool && typeof tool === "object"
        ? (tool as { function?: { name?: unknown } }).function
        : undefined
    return fn?.name === name
  })
const advertisesBash = (request: ChatCompletionRequest) =>
  advertisesTool(request, "bash")
const toolTextSince = (provider: ScriptedProvider, requestCount: number) =>
  provider.requests
    .slice(requestCount)
    .flatMap((request) => textOf(request, "tool"))
    .join("\n")

async function writeArtifacts(
  sandbox: Sandbox,
  provider: ScriptedProvider | undefined,
  processes: OpenCodeProcess[],
  events: EventRecorder[],
) {
  await Promise.all(
    processes.map((process, index) =>
      process.writeDiagnostics(
        path.join(sandbox.artifacts, `server-${index + 1}`),
      ),
    ),
  )
  await fs.writeFile(
    path.join(sandbox.artifacts, "events.json"),
    `${JSON.stringify(
      events.flatMap((r) => r.events),
      null,
      2,
    )}\n`,
  )
  await fs.writeFile(
    path.join(sandbox.artifacts, "provider-requests.json"),
    `${JSON.stringify(provider?.requests ?? [], null, 2)}\n`,
  )
  const artifact = await sandbox.preserve("btw-server")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("btw against a real OpenCode server", () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("side question is a cache-hot fork: identical prefix, main untouched, mutating tool auto-denied, cleaned up", async () => {
    const sandbox = await createSandbox("btw-server")
    const provider = createScriptedProvider({
      command: "git status --short",
      finalText: "We use exponential backoff.",
    })
    const processes: OpenCodeProcess[] = []
    const recorders: EventRecorder[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => {
      for (const recorder of recorders) await recorder.close()
    })
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await provider.ready
      await writeBtwConfig(sandbox.project, provider.baseURL)
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("btw"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      // A parent session with one completed turn (bash allowed, so it runs
      // without a prompt).
      const parent = await createSession(
        client,
        sandbox.project,
        "Retry logic discussion",
      )
      const parentMark = events.mark()
      await promptParent(
        client,
        sandbox.project,
        parent,
        "Explain the retry logic in detail.",
      )
      await events.waitFor(isIdle(parent), {
        after: parentMark,
        description: "parent idle",
      })

      const before = await client.session.messages({
        sessionID: parent,
        directory: sandbox.project,
      })
      const beforeCount = before.data?.length ?? 0
      const parentRequest = provider.requests.find(
        (request) => advertisesBash(request) && !hasSideQuestion(request),
      )
      expect(parentRequest).toBeDefined()

      // Fire the side question through the plugin's own code path.
      const sideMark = events.mark()
      const started = await startSideQuestion(client, {
        directory: sandbox.project,
        parentID: parent,
        question: "Which backoff strategy did we choose?",
        options: resolveOptions({}),
      })
      expect(started.hasContext).toBe(true)

      // The fork carries the marker while alive.
      const forkInfo = await client.session.get({
        sessionID: started.sessionID,
        directory: sandbox.project,
      })
      expect(markerOf(forkInfo.data?.metadata)?.parent).toBe(parent)

      // The fork tries bash for the side question; the server half's
      // tool.execute.before gate fails the call before it can even reach the
      // permission layer, and the model reads the denial in its next request.
      await events.waitFor(isIdle(started.sessionID), {
        after: sideMark,
        description: "fork idle",
      })
      const forkRequests = provider.requests.filter(hasSideQuestion)
      expect(forkRequests.length).toBeGreaterThanOrEqual(2)
      const forkToolResults = forkRequests
        .flatMap((request) => textOf(request, "tool"))
        .join("\n")
      expect(forkToolResults).toContain("read-only")
      // Gated pre-ask: no permission prompt was ever raised for the fork.
      const forkAsked = events.events
        .slice(sideMark)
        .some(
          (event) =>
            event.type === "permission.asked" &&
            (event.properties as { sessionID?: string }).sessionID ===
              started.sessionID,
        )
      expect(forkAsked).toBe(false)

      // Prefix identity: the fork's first request matches the parent's system
      // prompt and tool list byte-for-byte — the whole point of forking.
      const forkRequest = provider.requests.find(hasSideQuestion)
      expect(forkRequest).toBeDefined()
      if (!forkRequest || !parentRequest) throw new Error("missing requests")
      expect(systemText(forkRequest)).toBe(systemText(parentRequest))
      expect(forkRequest.tools).toEqual(parentRequest.tools)
      // The parent's original prompt is carried; the side question rides in a
      // user message, never the system prompt.
      expect(textOf(forkRequest, "user").join("\n")).toContain(
        "Explain the retry logic in detail.",
      )
      expect(
        textOf(forkRequest, "user").some((text) =>
          text.includes("Which backoff strategy did we choose?"),
        ),
      ).toBe(true)
      expect(systemText(forkRequest)).not.toContain("<side-question>")

      // The main conversation gained nothing.
      const after = await client.session.messages({
        sessionID: parent,
        directory: sandbox.project,
      })
      expect(after.data?.length ?? 0).toBe(beforeCount)

      // Teardown deletes the fork.
      expect(
        await discardSideQuestion(client, {
          directory: sandbox.project,
          sessionID: started.sessionID,
        }),
      ).toBe(true)
      await waitFor(
        async () => {
          const gone = await client.session.get({
            sessionID: started.sessionID,
            directory: sandbox.project,
          })
          return gone.error !== undefined && gone.error !== null
        },
        { description: "fork deleted" },
      )
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes, recorders)
      throw error
    }
  })

  test("a fork preserves parent read/glob denies and session restrictions while its server guard blocks env reads", async () => {
    const sandbox = await createSandbox("btw-parent-permissions")
    const ordinaryFile = path.join(sandbox.project, ".env.example")
    const configDeniedRead = "config-denied-read.txt"
    const configDeniedGlob = "config-denied-glob-*.txt"
    const configDeniedGlobFile = path.join(
      sandbox.project,
      "config-denied-glob-proof.txt",
    )
    const sessionDeniedRead = "session-denied-read.txt"
    const privateEnvExample = "private.env.example"
    const envFile = path.join(sandbox.project, ".env")
    const ordinaryContent = "E2E_ENV_EXAMPLE_READ_OK"
    const configReadContent = "E2E_CONFIG_READ_DENY_PROOF"
    const configGlobContent = "E2E_CONFIG_GLOB_DENY_PROOF"
    const sessionReadContent = "E2E_SESSION_READ_DENY_PROOF"
    const privateEnvExampleContent = "E2E_PRIVATE_ENV_EXAMPLE_DENY_PROOF"
    const envContent = "E2E_ENV_READ_DENY_PROOF_NOT_A_SECRET"
    const fixtures = [
      [ordinaryFile, ordinaryContent],
      [path.join(sandbox.project, configDeniedRead), configReadContent],
      [configDeniedGlobFile, configGlobContent],
      [path.join(sandbox.project, sessionDeniedRead), sessionReadContent],
      [path.join(sandbox.project, privateEnvExample), privateEnvExampleContent],
      [envFile, envContent],
    ] as const
    const provider = createScriptedProvider({
      finalText: "The requested check is complete.",
      toolCall(lastUserText) {
        if (lastUserText.includes("ordinary read")) {
          return { tool: "read", arguments: { filePath: ordinaryFile } }
        }
        if (lastUserText.includes("config read deny")) {
          return {
            tool: "read",
            arguments: {
              filePath: path.join(sandbox.project, configDeniedRead),
            },
          }
        }
        if (lastUserText.includes("config glob deny")) {
          return {
            tool: "glob",
            arguments: { pattern: configDeniedGlob, path: sandbox.project },
          }
        }
        if (lastUserText.includes("session read deny")) {
          return {
            tool: "read",
            arguments: {
              filePath: path.join(sandbox.project, sessionDeniedRead),
            },
          }
        }
        if (lastUserText.includes("private env example deny")) {
          return {
            tool: "read",
            arguments: {
              filePath: path.join(sandbox.project, privateEnvExample),
            },
          }
        }
        if (lastUserText.includes("env read deny")) {
          return { tool: "read", arguments: { filePath: envFile } }
        }
        return undefined
      },
    })
    const processes: OpenCodeProcess[] = []
    const recorders: EventRecorder[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => {
      for (const recorder of recorders) await recorder.close()
    })
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await provider.ready
      await Promise.all(
        fixtures.map(([file, content]) => fs.writeFile(file, `${content}\n`)),
      )
      // Specific project rules must remain effective after btw installs its
      // read-only rules. The ordinary read proves this is not a blanket deny.
      await writeBtwConfig(sandbox.project, provider.baseURL, {
        permission: {
          "*": "ask",
          bash: "allow",
          read: {
            "*": "allow",
            [configDeniedRead]: "deny",
            [privateEnvExample]: "deny",
          },
          glob: { "*": "allow", [configDeniedGlob]: "deny" },
        },
      })
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("btw-parent-permissions"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)
      const parent = await createSession(
        client,
        sandbox.project,
        "Parent permission inheritance",
      )

      // Session.fork deliberately omits this ruleset. btw must recover it when
      // it prepares the side fork, rather than letting its read-only allowlist
      // silently relax the parent's explicit restriction.
      const updated = await client.session.update({
        directory: sandbox.project,
        sessionID: parent,
        permission: [
          {
            permission: "read",
            pattern: sessionDeniedRead,
            action: "deny",
          },
        ],
      })
      if (updated.error)
        throw new Error(
          `Could not set parent session restriction: ${JSON.stringify(updated.error)}`,
        )

      const parentMark = events.mark()
      await promptParent(
        client,
        sandbox.project,
        parent,
        "Establish context without a tool call.",
      )
      await events.waitFor(isIdle(parent), {
        after: parentMark,
        description: "parent context idle",
      })

      const initialRequests = provider.requests.length
      const forkMark = events.mark()
      const started = await startSideQuestion(client, {
        directory: sandbox.project,
        parentID: parent,
        question: "Perform the ordinary read.",
        options: resolveOptions({}),
      })
      await events.waitFor(isIdle(started.sessionID), {
        after: forkMark,
        description: "ordinary side read idle",
      })
      expect(toolTextSince(provider, initialRequests)).toContain(
        ordinaryContent,
      )

      async function promptFork(probe: string, description: string) {
        const mark = events.mark()
        const requestCount = provider.requests.length
        await promptParent(client, sandbox.project, started.sessionID, probe)
        await events.waitFor(isIdle(started.sessionID), {
          after: mark,
          description,
        })
        return requestCount
      }

      for (const probe of [
        {
          prompt: "Attempt the config read deny probe.",
          description: "config-denied read idle",
          tool: "read",
          forbidden: configReadContent,
        },
        {
          prompt: "Attempt the config glob deny probe.",
          description: "config-denied glob idle",
          tool: "glob",
          forbidden: configDeniedGlobFile,
        },
        {
          prompt: "Attempt the session read deny probe.",
          description: "session-denied read idle",
          tool: "read",
          forbidden: sessionReadContent,
        },
        {
          prompt: "Attempt the private env example deny probe.",
          description: "private env example deny idle",
          tool: "read",
          forbidden: privateEnvExampleContent,
        },
      ]) {
        const requestCount = await promptFork(probe.prompt, probe.description)
        const requests = provider.requests.slice(requestCount)
        expect(
          requests.some((request) => advertisesTool(request, probe.tool)),
        ).toBe(true)
        const toolText = toolTextSince(provider, requestCount)
        expect(toolText).toMatch(/denied|disallow/i)
        expect(toolText).not.toContain(probe.forbidden)
      }

      const envRead = await promptFork(
        "Attempt the env read deny probe.",
        "env read guard idle",
      )
      const envRequests = provider.requests.slice(envRead)
      expect(
        envRequests.some((request) => advertisesTool(request, "read")),
      ).toBe(true)
      const envToolText = toolTextSince(provider, envRead)
      expect(envToolText).toContain("read-only")
      expect(envToolText).not.toContain(envContent)

      // Every denied operation resolves automatically: a side fork must never
      // leave a user permission prompt behind, and none of these probes mutate.
      const forkPrompts = events.events
        .slice(forkMark)
        .filter(
          (event) =>
            event.type === "permission.asked" &&
            (event.properties as { sessionID?: string }).sessionID ===
              started.sessionID,
        )
      expect(forkPrompts).toEqual([])
      for (const [file, content] of fixtures)
        await expect(fs.readFile(file, "utf8")).resolves.toBe(`${content}\n`)
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes, recorders)
      throw error
    }
  })

  test("a side question runs and answers while the parent is still mid-turn", async () => {
    const sandbox = await createSandbox("btw-busy")
    const gate = createGatedProvider()
    const processes: OpenCodeProcess[] = []
    const recorders: EventRecorder[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => gate.close())
    cleanups.push(async () => {
      for (const recorder of recorders) await recorder.close()
    })
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await gate.ready
      await writeBtwConfig(sandbox.project, gate.baseURL)
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("btw-busy"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      // Give the parent one completed turn, then start a second that the
      // provider holds open — the parent is now busy.
      const parent = await createSession(
        client,
        sandbox.project,
        "Long running task",
      )
      const firstMark = events.mark()
      await promptParent(client, sandbox.project, parent, "First question.")
      await events.waitFor(isIdle(parent), {
        after: firstMark,
        description: "parent first turn idle",
      })

      const busyMark = events.mark()
      gate.hold() // the next parent completion will block
      await promptParent(
        client,
        sandbox.project,
        parent,
        "Start the long task.",
      )
      await waitFor(
        async () => {
          const status = await client.session.status({
            directory: sandbox.project,
          })
          return status.data?.[parent]?.type === "busy"
        },
        { description: "parent busy" },
      )

      // Ask a side question while the parent is provably mid-turn.
      const started = await startSideQuestion(client, {
        directory: sandbox.project,
        parentID: parent,
        question: "Quick aside — what does this function return?",
        options: resolveOptions({}),
      })
      expect(started.sessionID).not.toBe(parent)
      await events.waitFor(isIdle(started.sessionID), {
        after: busyMark,
        description: "fork answered while parent busy",
      })

      // The parent is still busy: it has not gone idle since we held the gate.
      const parentIdleWhileBusy = events.events
        .slice(busyMark)
        .some(isIdle(parent))
      expect(parentIdleWhileBusy).toBe(false)

      // Release the parent; it completes normally afterward.
      gate.release()
      await events.waitFor(isIdle(parent), {
        after: busyMark,
        description: "parent completes after release",
      })

      await discardSideQuestion(client, {
        directory: sandbox.project,
        sessionID: started.sessionID,
      })
    } catch (error) {
      await writeArtifacts(
        sandbox,
        gate as unknown as ScriptedProvider,
        processes,
        recorders,
      )
      throw error
    }
  })
})

// A loopback OpenAI-compatible provider that returns plain text, but can hold a
// parent completion open until released. Side-question requests (recognized by
// the wrapper marker) are never held, so a fork can answer while the parent's
// turn is blocked.
function createGatedProvider() {
  const requests: ChatCompletionRequest[] = []
  let held = false
  let releaseGate: (() => void) | undefined
  let pending: Promise<void> | undefined

  const sse = (text: string): Response => {
    const chunk = (choice: Record<string, unknown>) =>
      `data: ${JSON.stringify({ id: "gated", object: "chat.completion.chunk", created: 0, model: "e2e/test", choices: [{ index: 0, ...choice }] })}\n\n`
    const frames = [
      chunk({ delta: { role: "assistant" }, finish_reason: null }),
      chunk({ delta: { content: text }, finish_reason: null }),
      chunk({ delta: {}, finish_reason: "stop" }),
      "data: [DONE]\n\n",
    ]
    let i = 0
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const frame = frames[i++]
          if (frame === undefined) return controller.close()
          controller.enqueue(new TextEncoder().encode(frame))
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      },
    )
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(incoming): Promise<Response> {
      const url = new URL(incoming.url)
      if (url.pathname === "/health") return Response.json({ healthy: true })
      if (url.pathname !== "/v1/chat/completions")
        return Response.json({ error: { message: "nf" } }, { status: 404 })
      const body = (await incoming.json()) as ChatCompletionRequest
      requests.push(body)
      const isSide = JSON.stringify(body.messages ?? []).includes(
        "<side-question>",
      )
      if (!isSide && held && pending) await pending
      return sse(isSide ? "It returns the retry count." : "Long task complete.")
    },
  })
  const port = server.port
  if (port === undefined) throw new Error("gated provider did not bind")
  const origin = `http://127.0.0.1:${port}`

  return {
    baseURL: `${origin}/v1`,
    requests,
    ready: fetch(`${origin}/health`).then(() => undefined),
    hold() {
      held = true
      pending = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
    },
    release() {
      releaseGate?.()
      held = false
    },
    async close() {
      releaseGate?.()
      await server.stop(true)
    },
  }
}

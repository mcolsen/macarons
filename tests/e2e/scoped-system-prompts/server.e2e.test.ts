import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import { writeScopedSystemPromptsConfig } from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import {
  type ChatCompletionRequest,
  type ChatMessage,
  createScriptedProvider,
  type ScriptedProvider,
} from "../harness/scripted-provider"

const PREPEND = ["E2E-SCOPED-PREPEND-ONE", "E2E-SCOPED-PREPEND-TWO"]
const REPLACE = ["E2E-SCOPED-REPLACE-ONE", "E2E-SCOPED-REPLACE-TWO"]
const APPEND = ["E2E-SCOPED-APPEND-ONE", "E2E-SCOPED-APPEND-TWO"]
const DISCARDED = "E2E-SCOPED-DISCARDED-BEFORE-REPLACE"

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

async function prompt(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
  modelID: string,
) {
  const result = await client.session.promptAsync({
    directory,
    sessionID,
    model: { providerID: "e2e", modelID },
    parts: [{ type: "text", text: "Inspect the configured system prompt." }],
  })
  if (result.error)
    throw new Error(`Could not prompt: ${JSON.stringify(result.error)}`)
}

function textOf(message: ChatMessage): string {
  const { content } = message
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      part && typeof part === "object"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("")
}

function scopedSystemTexts(request: ChatCompletionRequest): string[] {
  return (request.messages ?? [])
    .filter((message) => message.role === "system")
    .map(textOf)
    .filter((text) => text.startsWith("E2E-SCOPED-"))
}

async function writeArtifacts(
  sandbox: Sandbox,
  provider: ScriptedProvider,
  processes: OpenCodeProcess[],
) {
  await Promise.all(
    processes.map((process, index) =>
      process.writeDiagnostics(
        path.join(sandbox.artifacts, `server-${index + 1}`),
      ),
    ),
  )
  await fs.writeFile(
    path.join(sandbox.artifacts, "provider-requests.json"),
    `${JSON.stringify(provider.requests, null, 2)}\n`,
  )
  const artifact = await sandbox.preserve("scoped-system-prompts-server")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("scoped-system-prompts against a real OpenCode server", () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("declared rules compose for the resolved model and leave another model untouched", async () => {
    const sandbox = await createSandbox("scoped-system-prompts-server")
    const provider = createScriptedProvider({ finalText: "Prompt inspected." })
    const processes: OpenCodeProcess[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await provider.ready
      await writeScopedSystemPromptsConfig(sandbox.project, provider.baseURL, {
        prompts: [
          { model: "e2e/test", mode: "append", content: DISCARDED },
          { model: "e2e/test", mode: "replace", content: REPLACE },
          { model: "e2e/test", mode: "prepend", content: PREPEND },
          { model: "e2e/test", mode: "append", content: APPEND },
        ],
      })
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("scoped-system-prompts-server"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)

      const matchingSession = await createSession(
        client,
        sandbox.project,
        "Scoped prompt match",
      )
      await prompt(client, sandbox.project, matchingSession, "test")
      const [matchingRequest] = await provider.waitForRequestCount(1)
      expect(matchingRequest).toBeDefined()
      expect(
        scopedSystemTexts(matchingRequest as ChatCompletionRequest),
      ).toEqual([...PREPEND, ...REPLACE, ...APPEND])
      expect(
        scopedSystemTexts(matchingRequest as ChatCompletionRequest),
      ).not.toContain(DISCARDED)

      const unmatchedSession = await createSession(
        client,
        sandbox.project,
        "Scoped prompt nonmatch",
      )
      await prompt(client, sandbox.project, unmatchedSession, "other")
      const [, unmatchedRequest] = await provider.waitForRequestCount(2)
      expect(unmatchedRequest).toBeDefined()
      expect(
        scopedSystemTexts(unmatchedRequest as ChatCompletionRequest),
      ).toEqual([])
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes)
      throw error
    }
  })
})

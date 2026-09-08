import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import { REPOSITORY_ROOT } from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import { startTmuxTui, type TmuxTui } from "../harness/tmux"

const TUI_ENTRY = path.join(
  REPOSITORY_ROOT,
  "plugins",
  "cache-ratio",
  "src",
  "tui.tsx",
)

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function lastUserText(body: JsonObject): string {
  const messages = Array.isArray(body.messages)
    ? body.messages.filter(isJsonObject)
    : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "user") continue
    const content = message.content
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content
      .map((part) =>
        isJsonObject(part) && typeof part.text === "string" ? part.text : "",
      )
      .join("\n")
  }
  return ""
}

/**
 * Loopback OpenAI-compatible model provider that, unlike the shared scripted
 * provider, reports token `usage` on its final stream chunk — including
 * `prompt_tokens_details.cached_tokens`, the field the AI SDK maps to
 * cachedInputTokens and OpenCode normalizes into `tokens.cache.read`. That
 * usage is the entire subject under test here, so the journey brings its own
 * backend, the same way the codex-limits journey brings its usage endpoint.
 *
 * Requests whose conversation mentions "zzbreak" get break-shaped usage —
 * reads collapse while the prompt stays large — everything else reads 100k of
 * a 120k prompt from cache. A newest user message mentioning "zzrecover"
 * overrides that with recovery-shaped usage: reads jump back above the old
 * floor, as they would once the context is re-cached. Replies echo the newest
 * user message's first word (`ack: hello`) so the transcript shows which turn
 * completed.
 */
function startCacheModelProvider() {
  const requests: JsonObject[] = []
  let completionNumber = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(incoming): Promise<Response> {
      const url = new URL(incoming.url)
      if (url.pathname === "/health") return Response.json({ healthy: true })
      if (
        url.pathname !== "/v1/chat/completions" ||
        incoming.method !== "POST"
      ) {
        return Response.json(
          { error: { message: "Not found" } },
          { status: 404 },
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
      if (!isJsonObject(parsed))
        return Response.json(
          { error: { message: "Expected an object" } },
          { status: 400 },
        )
      requests.push(parsed)

      completionNumber += 1
      const id = `chatcmpl-cache-${completionNumber}`
      const model = typeof parsed.model === "string" ? parsed.model : "test"
      const wantsRecover = lastUserText(parsed).includes("zzrecover")
      const wantsBreak =
        !wantsRecover &&
        JSON.stringify(parsed.messages ?? []).includes("zzbreak")
      const usage = wantsRecover
        ? {
            prompt_tokens: 130_000,
            completion_tokens: 5,
            total_tokens: 130_005,
            prompt_tokens_details: { cached_tokens: 126_000 },
          }
        : wantsBreak
          ? {
              prompt_tokens: 125_000,
              completion_tokens: 5,
              total_tokens: 125_005,
              prompt_tokens_details: { cached_tokens: 1_000 },
            }
          : {
              prompt_tokens: 120_000,
              completion_tokens: 5,
              total_tokens: 120_005,
              prompt_tokens_details: { cached_tokens: 100_000 },
            }
      const text = `ack: ${lastUserText(parsed).trim().split(/\s+/)[0] || "hello"}`
      const chunk = (choice: JsonObject, extra: JsonObject = {}) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, ...choice }], ...extra })}\n\n`
      const frames = [
        chunk({ delta: { role: "assistant" }, finish_reason: null }),
        chunk({ delta: { content: text }, finish_reason: null }),
        chunk({ delta: {}, finish_reason: "stop" }, { usage }),
        "data: [DONE]\n\n",
      ]
      return new Response(frames.join(""), {
        headers: {
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8",
        },
      })
    },
  })
  const port = server.port
  if (port === undefined) {
    void server.stop(true)
    throw new Error("Cache model provider did not bind a TCP port")
  }
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: async () => {
      await server.stop(true)
    },
  }
}

// The generous context limit matters: the provider reports 120k+ prompts, and
// a small declared context would trip the host's auto-compaction — a summary
// turn — right in the middle of the journey.
async function writeProject(project: string, baseURL: string) {
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "cache/test",
    small_model: "cache/test",
    provider: {
      cache: {
        npm: "@ai-sdk/openai-compatible",
        name: "E2E cache provider",
        options: { apiKey: "e2e-not-a-secret", baseURL },
        models: {
          test: {
            name: "E2E cache model",
            limit: { context: 1_000_000, output: 4_096 },
          },
        },
      },
    },
  }
  await fs.writeFile(
    path.join(project, "opencode.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  )
  const directory = path.join(project, ".opencode")
  await fs.mkdir(directory, { recursive: true })
  const file = path.join(directory, "tui.json")
  await fs.writeFile(
    file,
    `${JSON.stringify({ plugin: [pathToFileURL(TUI_ENTRY).href] }, null, 2)}\n`,
  )
  return file
}

async function retainFailure(
  sandbox: Sandbox,
  requests: JsonObject[],
  server: OpenCodeProcess | undefined,
  tui: TmuxTui | undefined,
) {
  if (server)
    await server.writeDiagnostics(path.join(sandbox.artifacts, "server"))
  if (tui) await tui.writeDiagnostics(path.join(sandbox.artifacts, "tui"))
  await fs.writeFile(
    path.join(sandbox.artifacts, "provider-requests.json"),
    `${JSON.stringify(requests, null, 2)}\n`,
  )
  const artifact = await sandbox.preserve("cache-ratio-tui")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("cache-ratio sidebar widget", () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("tracks the hit ratio and alerts on a prefix break", async () => {
    const sandbox = await createSandbox("cache-ratio-tui")
    const provider = startCacheModelProvider()
    let server: OpenCodeProcess | undefined
    let tui: TmuxTui | undefined
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => tui?.stop())
    cleanups.push(async () => server?.stop())

    try {
      const tuiConfig = await writeProject(sandbox.project, provider.baseURL)
      server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("server"),
      })
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: sandbox.project,
      })
      const created = await client.session.create({
        directory: sandbox.project,
        title: "E2E cache ratio",
      })
      if (created.error || !created.data)
        throw new Error(
          `Could not create session: ${JSON.stringify(created.error)}`,
        )
      tui = await startTmuxTui({
        directory: sandbox.project,
        env: await sandbox.environment("tui"),
        serverURL: server.url,
        sessionID: created.data.id,
        tuiConfig,
      })

      // Before any request the session has no samples, so the sidebar (whose
      // built-in Context section proves it rendered) carries no Cache section.
      let pane = await tui.waitForText("Context")
      expect(pane).not.toContain("· last")
      expect(pane).not.toContain("cached ·")

      // Turn 1 — healthy usage: 100k of the 120,005-token prompt from cache.
      await tui.type("hello there")
      await tui.sendKey("Enter")
      pane = await tui.waitForText("hit 83% · last 83%")
      expect(pane).toContain("100k cached · 0 written · 20k fresh")
      expect(pane).not.toContain("prefix broke:")

      // Turn 2 — reads collapse to 1k while the prompt grows: a prefix break.
      // The toast is transient, so it is awaited before the sticky sidebar rows.
      await tui.type("zzbreak please")
      await tui.sendKey("Enter")
      pane = await tui.waitForText("reused only 1k of 100k cached tokens")
      expect(pane).toContain("Prompt cache")
      pane = await tui.waitForText("prefix broke: lost 99k cached")
      expect(pane).toContain("hit 41% · last 1%")

      // Turn 3 — the failure is sustained: "zzbreak" is still in the
      // conversation history, so this request also reads only 1k. The alert
      // must persist — the floor is the last HEALTHY read, sticky across
      // consecutive misses — not clear just because the previous (broken)
      // request read almost nothing.
      await tui.type("all good again")
      await tui.sendKey("Enter")
      pane = await tui.waitForText("ack: all")
      pane = await tui.waitForText("hit 28% · last 1%")
      expect(pane).toContain("prefix broke: lost 99k cached")

      // Turn 4 — genuine recovery: reads jump back above the floor and the
      // red state clears.
      await tui.type("zzrecover thanks")
      await tui.sendKey("Enter")
      pane = await tui.waitForText("hit 46% · last 97%")
      expect(pane).not.toContain("prefix broke:")

      // Every completion request hit the loopback provider: the four turns,
      // and possibly title generation.
      expect(provider.requests.length).toBeGreaterThanOrEqual(4)
    } catch (error) {
      await retainFailure(sandbox, provider.requests, server, tui)
      throw error
    }
  })

  test("session totals cover history beyond the host's 100-message sync window", async () => {
    const sandbox = await createSandbox("cache-ratio-tui-history")
    const provider = startCacheModelProvider()
    let server: OpenCodeProcess | undefined
    let tui: TmuxTui | undefined
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => tui?.stop())
    cleanups.push(async () => server?.stop())

    try {
      const tuiConfig = await writeProject(sandbox.project, provider.baseURL)
      server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("server"),
      })
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: sandbox.project,
      })
      const created = await client.session.create({
        directory: sandbox.project,
        title: "E2E cache history",
      })
      if (created.error || !created.data)
        throw new Error(
          `Could not create session: ${JSON.stringify(created.error)}`,
        )
      const sessionID = created.data.id

      // 51 healthy turns = 102 messages: past the newest-100 window the TUI
      // hydrates and retains, so by the time it attaches, the oldest turn is
      // only reachable through the server's full history.
      for (let turn = 1; turn <= 51; turn += 1) {
        const prompted = await client.session.prompt({
          directory: sandbox.project,
          sessionID,
          model: { providerID: "cache", modelID: "test" },
          parts: [{ type: "text", text: `turn ${turn}` }],
        })
        if (prompted.error)
          throw new Error(
            `Prompt ${turn} failed: ${JSON.stringify(prompted.error)}`,
          )
      }

      tui = await startTmuxTui({
        directory: sandbox.project,
        env: await sandbox.environment("tui"),
        serverURL: server.url,
        sessionID,
        tuiConfig,
      })

      // 51 requests × (100k cached of 120k). The synced window alone reaches
      // only 5.0M across its 50 retained assistant messages — 5.1M proves the
      // aggregate covers the whole session.
      const pane = await tui.waitForText("5.1M cached · 0 written · 1M fresh")
      expect(pane).toContain("hit 83%")
      expect(pane).not.toContain("prefix broke:")
    } catch (error) {
      await retainFailure(sandbox, provider.requests, server, tui)
      throw error
    }
  })
})

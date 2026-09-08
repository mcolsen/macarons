import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import { EventRecorder } from "../harness/events"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import {
  WEB_SEARCH_SERVER_ENTRY,
  writeWebSearchConfig,
} from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import {
  type ChatCompletionRequest,
  createScriptedProvider,
  type ScriptedProvider,
} from "../harness/scripted-provider"
import { waitFor } from "../harness/wait"

// End-to-end pins for the implicit upstream behaviors this plugin is built
// on, against a real version-pinned OpenCode binary (issue #61):
//
//  1. SHADOWING — a plugin tool with the id `websearch` REPLACES the
//     builtin's execution: session tool assembly is an id-keyed map filled
//     builtin-first then plugin, last writer wins (session/tools.ts). The
//     pin: the tool the model is offered carries OUR description, and
//     executing it hits the configured SearXNG mock — never mcp.exa.ai.
//
//  2. VISIBILITY — the registry filters the literal `websearch` id (ours
//     included) behind provider==opencode OR the enable env flags
//     (registry.ts webSearchEnabled), and ONLY that id. The pin: without a
//     flag the scripted provider (id `e2e`) is never offered `websearch`,
//     but the plugin's ungated `web_search` alias is offered and serves
//     the chain — plugin-enabled IS search-enabled.
//
// Plus the chain fallback: SearXNG down + no native provider → the Exa
// JSON-RPC call (pointed at a loopback mock via exa.url).

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

/** The SDK-caller shape that omits `model`: the host resolves the default. */
async function promptWithoutModel(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
  text: string,
) {
  const result = await client.session.promptAsync({
    directory,
    sessionID,
    parts: [{ type: "text", text }],
  })
  if (result.error)
    throw new Error(`Could not prompt: ${JSON.stringify(result.error)}`)
}

/** Names (and, keyed by name, descriptions) of the tools a request offered. */
function offeredTools(request: ChatCompletionRequest): Map<string, string> {
  const offered = new Map<string, string>()
  for (const entry of request.tools ?? []) {
    const fn = (
      entry as { function?: { name?: unknown; description?: unknown } }
    ).function
    if (typeof fn?.name !== "string") continue
    offered.set(
      fn.name,
      typeof fn.description === "string" ? fn.description : "",
    )
  }
  return offered
}

function requestsText(provider: ScriptedProvider): string {
  return JSON.stringify(provider.requests)
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
  const artifact = await sandbox.preserve("web-search-server")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("web-search against a real OpenCode server", () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("the shadow replaces the builtin: our description is offered, our SearXNG backend executes", async () => {
    const sandbox = await createSandbox("web-search-shadow")
    const searxngQueries: string[] = []
    const searxng = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        searxngQueries.push(url.searchParams.get("q") ?? "")
        return Response.json({
          results: [
            {
              title: "Shadow pin hit",
              url: "https://shadow-pin.example",
              content: "proof the plugin backend served this",
              engine: "mock",
            },
          ],
        })
      },
    })
    const provider = createScriptedProvider({
      finalText: "Read the search results.",
      tool: {
        tool: "websearch",
        arguments: { query: "e2e shadow probe" },
      },
      maxToolCalls: 1,
    })
    const processes: OpenCodeProcess[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => {
      searxng.stop(true)
    })
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await provider.ready
      await writeWebSearchConfig(sandbox.project, provider.baseURL, {
        pluginOptions: {
          searxng: { url: `http://127.0.0.1:${searxng.port}` },
          exa: { enabled: false },
        },
      })
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("web-search-shadow", {
          OPENCODE_ENABLE_EXA: "1",
        }),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const session = await createSession(client, sandbox.project, "Shadow")
      await prompt(client, sandbox.project, session, "Search for the probe.")

      // The tool result flows back to the provider in the follow-up
      // completion request; our SearXNG formatting appearing there proves
      // the plugin's execute ran in the builtin's id slot.
      await waitFor(
        async () => requestsText(provider).includes("Shadow pin hit"),
        {
          description: "plugin search result reached the model",
          timeout: 20_000,
        },
      )
      expect(searxngQueries).toContain("e2e shadow probe")
      expect(requestsText(provider)).toContain(
        'Search results for \\"e2e shadow probe\\"',
      )

      // Interface-level pin: the websearch slot the flag exposes is OURS —
      // the builtin's description says "the session's web search
      // provider"; ours declares the backend-varying output shape. With
      // the flag set the ungated alias rides along too, so both ids are
      // offered on such sessions (both ours).
      const offered = provider.requests.map(offeredTools)
      const withWebsearch = offered.filter((tools) => tools.has("websearch"))
      expect(withWebsearch.length).toBeGreaterThan(0)
      for (const tools of withWebsearch) {
        expect(tools.get("websearch")).toContain(
          "Output shape varies by backend",
        )
        expect(tools.get("web_search")).toContain(
          "Output shape varies by backend",
        )
      }
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes)
      throw error
    }
  }, 90_000)

  test("without an enable flag the shadow id is gated but web_search still serves the chain", async () => {
    const sandbox = await createSandbox("web-search-gate")
    const searxngQueries: string[] = []
    const searxng = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        searxngQueries.push(url.searchParams.get("q") ?? "")
        return Response.json({
          results: [
            {
              title: "Ungated pin hit",
              url: "https://ungated-pin.example",
              content: "served with no env flag set",
              engine: "mock",
            },
          ],
        })
      },
    })
    const provider = createScriptedProvider({
      finalText: "Read the search results.",
      tool: {
        tool: "web_search",
        arguments: { query: "e2e ungated probe" },
      },
      maxToolCalls: 1,
    })
    const processes: OpenCodeProcess[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => {
      searxng.stop(true)
    })
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await provider.ready
      await writeWebSearchConfig(sandbox.project, provider.baseURL, {
        pluginOptions: {
          searxng: { url: `http://127.0.0.1:${searxng.port}` },
          exa: { enabled: false },
        },
      })
      // The sandbox env is built from scratch (PATH aside), so the host's
      // own OPENCODE_ENABLE_EXA never leaks in; this run has NO flag.
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("web-search-gate"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const session = await createSession(client, sandbox.project, "Gate")
      await prompt(client, sandbox.project, session, "Search for the probe.")

      // The always-available pin: with no flag, plugin-enabled IS
      // search-enabled — web_search rides past the registry filter and
      // executes the chain.
      await waitFor(
        async () => requestsText(provider).includes("Ungated pin hit"),
        {
          description: "ungated search result reached the model",
          timeout: 20_000,
        },
      )
      expect(searxngQueries).toContain("e2e ungated probe")

      // The gate pin: the registry still filtered the literal websearch id
      // for provider `e2e` — only the ungated alias was offered.
      for (const request of provider.requests) {
        const offered = offeredTools(request)
        expect([...offered.keys()]).not.toContain("websearch")
        if (offered.has("web_search")) {
          expect(offered.get("web_search")).toContain(
            "Output shape varies by backend",
          )
        }
      }
      const offeredSomewhere = provider.requests.some((request) =>
        offeredTools(request).has("web_search"),
      )
      expect(offeredSomewhere).toBe(true)
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes)
      throw error
    }
  }, 90_000)

  test("deny-star rules keep the alias visible, and an omitted prompt model still feeds the native gate", async () => {
    // Two review pins in one server:
    //
    //  M1 — a ruleset like { "*": "deny", websearch: "allow" } (the shape
    //  the host's own explore agent hardcodes) hides tools per ID. The
    //  plugin's config-hook mirror must keep `web_search` offered where
    //  `websearch` rules allow it — while the registry still gates the
    //  literal builtin id off-Zen.
    //
    //  H1 — the prompt omits `model` (SDK callers relying on the config
    //  default). The executing assistant carries the RESOLVED model: the
    //  native backend's failure reason then names its provider instead of
    //  reporting an unknown model.
    const sandbox = await createSandbox("web-search-alias-permission")
    const provider = createScriptedProvider({
      finalText: "Read the failure report.",
      tool: {
        tool: "web_search",
        arguments: { query: "e2e alias probe" },
      },
      maxToolCalls: 1,
    })
    const processes: OpenCodeProcess[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await provider.ready
      await writeWebSearchConfig(sandbox.project, provider.baseURL, {
        permission: { "*": "deny", websearch: "allow" },
        // native-only: its per-provider failure reason is the observable
        // proof of which executing model fed the gate.
        pluginOptions: { order: ["native"] },
      })
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("web-search-alias-permission"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const session = await createSession(client, sandbox.project, "Alias")
      await promptWithoutModel(
        client,
        sandbox.project,
        session,
        "Search for the probe.",
      )

      // H1: the chain's failure output names the session's own provider —
      // the executing assistant's resolved default model (e2e/test) was read.
      await waitFor(
        async () => requestsText(provider).includes("has no native web search"),
        {
          description: "native failure report reached the model",
          timeout: 20_000,
        },
      )
      expect(requestsText(provider)).toContain(
        'provider \\"e2e\\" has no native web search',
      )
      expect(requestsText(provider)).not.toContain("not known yet")

      // M1: the alias rode past { "*": "deny", websearch: "allow" }; the
      // literal builtin id stayed registry-gated.
      const offeredSomewhere = provider.requests.some((request) =>
        offeredTools(request).has("web_search"),
      )
      expect(offeredSomewhere).toBe(true)
      for (const request of provider.requests) {
        expect([...offeredTools(request).keys()]).not.toContain("websearch")
      }
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes)
      throw error
    }
  }, 90_000)

  for (const hold of [
    "permission approval",
    "assistant tool response",
  ] as const) {
    test(`issues #228/#242: admitting B during A's ${hold} preserves A's native endpoint, key, model, and headers`, async () => {
      const sandbox = await createSandbox(`web-search-switch-${hold}`)
      const processes: OpenCodeProcess[] = []
      const recorders: EventRecorder[] = []
      const responseHeld = Promise.withResolvers<void>()
      const releaseResponse = Promise.withResolvers<void>()
      const proxyAbort = new AbortController()
      const nativeRequests: {
        destination: string
        url: string
        authorization: string | null
        headers: Record<string, string>
        body: Record<string, unknown>
      }[] = []
      const providers = ["a", "b"].map((side) => {
        const provider = createScriptedProvider({
          // B's admitted-while-busy prompt is text-only. A later normal B
          // turn checks that pinning A did not freeze the whole session at A.
          toolCall: (text) =>
            text.includes(side === "a" ? "older A" : "normal B")
              ? {
                  tool: "web_search",
                  arguments: {
                    query: `search-${side}`,
                    numResults: 3,
                    livecrawl: "fallback",
                    type: "auto",
                    contextMaxCharacters: 1000,
                  },
                }
              : undefined,
        })
        let held = false
        const endpoint = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const url = new URL(request.url)
            const native = url.pathname === "/v1/responses"
            if (!native && url.pathname !== "/v1/chat/completions")
              return new Response("Unexpected endpoint", { status: 404 })
            const body = (await request.json()) as ChatCompletionRequest
            if (native) {
              nativeRequests.push({
                destination: side,
                url: request.url,
                authorization: request.headers.get("authorization"),
                headers: Object.fromEntries(request.headers),
                body,
              })
            }
            // #242: both host chat and native search must authenticate at the
            // gateway; each model overrides the same exact provider header name.
            const modelHeader = `${native ? "search" : "chat"}-${side}`
            if (
              request.headers.get("x-e2e-provider") !== `provider-${side}` ||
              request.headers.get("x-e2e-model") !== modelHeader ||
              request.headers.get("x-e2e-conflict") !== modelHeader
            ) {
              return new Response(
                `Missing or incorrect gateway headers for ${modelHeader}`,
                { status: 401 },
              )
            }
            if (native) {
              return Response.json({
                output: [
                  {
                    type: "message",
                    content: [
                      { type: "output_text", text: `native-result-${side}` },
                    ],
                  },
                ],
              })
            }
            const response = await fetch(
              `${provider.baseURL}/chat/completions`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: proxyAbort.signal,
              },
            )
            const text = await response.text()
            if (
              side === "a" &&
              hold === "assistant tool response" &&
              !held &&
              text.includes('"tool_calls"')
            ) {
              held = true
              responseHeld.resolve()
              await releaseResponse.promise
            }
            return new Response(text, {
              status: response.status,
              headers: { "Content-Type": "text/event-stream" },
            })
          },
        })
        return {
          side,
          provider,
          endpoint,
          baseURL: `http://127.0.0.1:${endpoint.port}/v1`,
        }
      })
      cleanups.push(async () => sandbox.cleanup())
      cleanups.push(async () => {
        for (const { provider, endpoint } of providers) {
          await endpoint.stop(true)
          await provider.close()
        }
      })
      cleanups.push(async () => {
        for (const recorder of recorders) await recorder.close()
        for (const process of processes) await process.stop()
      })
      cleanups.push(async () => {
        releaseResponse.resolve()
        proxyAbort.abort()
      })

      try {
        await Promise.all(providers.map(({ provider }) => provider.ready))
        await fs.writeFile(
          path.join(sandbox.project, "opencode.json"),
          JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              model: "switch-a/chat",
              enabled_providers: ["switch-a", "switch-b"],
              provider: Object.fromEntries(
                providers.map(({ side, baseURL }) => [
                  `switch-${side}`,
                  {
                    npm: "@ai-sdk/openai-compatible",
                    options: {
                      apiKey: `e2e-synthetic-key-${side}`,
                      baseURL,
                      headers: {
                        "x-e2e-provider": `provider-${side}`,
                        "x-e2e-conflict": `provider-${side}`,
                      },
                    },
                    models: {
                      chat: {
                        id: `chat-wire-${side}`,
                        headers: {
                          "x-e2e-model": `chat-${side}`,
                          "x-e2e-conflict": `chat-${side}`,
                        },
                        limit: { context: 32_000, output: 4_096 },
                      },
                      // The chat SDK stays scripted; this model explicitly marks
                      // the same provider as native OpenAI with its own wire ID.
                      search: {
                        id: `search-wire-${side}`,
                        provider: { npm: "@ai-sdk/openai", api: baseURL },
                        options: { websearch: "always" },
                        headers: {
                          "x-e2e-model": `search-${side}`,
                          "x-e2e-conflict": `search-${side}`,
                        },
                        limit: { context: 32_000, output: 4_096 },
                      },
                    },
                  },
                ]),
              ),
              permission: { websearch: "ask" },
              plugin: [
                [
                  pathToFileURL(WEB_SEARCH_SERVER_ENTRY).href,
                  { order: ["native"] },
                ],
              ],
            },
            null,
            2,
          ),
        )
        const server = await startOpenCode({
          cwd: sandbox.project,
          env: await sandbox.environment("provider-switch"),
        })
        processes.push(server)
        const client = clientFor(server, sandbox.project)
        const events = await EventRecorder.connect(client)
        recorders.push(events)
        const sessionID = await createSession(
          client,
          sandbox.project,
          "Provider switch",
        )
        const send = async (side: string, text: string) => {
          const result = await client.session.promptAsync({
            directory: sandbox.project,
            sessionID,
            model: { providerID: `switch-${side}`, modelID: "chat" },
            parts: [{ type: "text", text }],
          })
          if (result.error)
            throw new Error(`Prompt failed: ${JSON.stringify(result.error)}`)
        }
        const permissionFor = (query: string) =>
          events.waitFor(
            (event) =>
              event.type === "permission.asked" &&
              event.properties.sessionID === sessionID &&
              event.properties.patterns.includes(query),
            { description: `permission for ${query}` },
          )
        const approve = async (
          asked: Awaited<ReturnType<typeof permissionFor>>,
        ) => {
          if (asked.type !== "permission.asked")
            throw new Error("Expected permission")
          const result = await client.permission.reply({
            directory: sandbox.project,
            requestID: asked.properties.id,
            reply: "once",
          })
          if (result.error)
            throw new Error(`Approval failed: ${JSON.stringify(result.error)}`)
        }
        const idleAfter = (after: number) =>
          events.waitFor(
            (event) =>
              event.type === "session.status" &&
              event.properties.sessionID === sessionID &&
              event.properties.status.type === "idle",
            { after, description: "provider-switch session idle" },
          )

        const start = events.mark()
        await send("a", "Search for older A.")
        const assistant = await events.waitFor(
          (event) =>
            event.type === "message.updated" &&
            event.properties.info.sessionID === sessionID &&
            event.properties.info.role === "assistant",
          { after: start, description: "executing assistant A persisted" },
        )
        if (
          assistant.type !== "message.updated" ||
          assistant.properties.info.role !== "assistant"
        )
          throw new Error("Expected assistant A")
        expect(assistant.properties.info).toMatchObject({
          providerID: "switch-a",
          modelID: "chat",
        })
        const assistantID = assistant.properties.info.id
        let asked: Awaited<ReturnType<typeof permissionFor>> | undefined
        if (hold === "permission approval") {
          asked = await permissionFor("search-a")
        } else {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              responseHeld.promise,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error("A's tool response never reached the hold"),
                    ),
                  20_000,
                )
              }),
            ])
          } finally {
            clearTimeout(timer)
          }
          const message = await client.session.message({
            directory: sandbox.project,
            sessionID,
            messageID: assistantID,
          })
          expect(message.error).toBeUndefined()
          expect(message.data?.parts.some((part) => part.type === "tool")).toBe(
            false,
          )
        }
        expect(nativeRequests).toEqual([])

        const admission = events.mark()
        await send(
          "b",
          "Admit newer B while A is busy; answer without searching.",
        )
        // message.updated is published AFTER chat.message finishes. A 204
        // from prompt_async alone would not prove B had reached the old tracker.
        const newer = await events.waitFor(
          (event) =>
            event.type === "message.updated" &&
            event.properties.info.sessionID === sessionID &&
            event.properties.info.role === "user" &&
            event.properties.info.model.providerID === "switch-b",
          { after: admission, description: "newer B user message admitted" },
        )
        if (newer.type !== "message.updated")
          throw new Error("Expected admitted B")
        const persisted = await client.session.message({
          directory: sandbox.project,
          sessionID,
          messageID: newer.properties.info.id,
        })
        expect(persisted.error).toBeUndefined()
        expect(persisted.data?.info).toMatchObject({
          role: "user",
          model: { providerID: "switch-b", modelID: "chat" },
        })
        const status = await client.session.status({
          directory: sandbox.project,
        })
        expect(status.error).toBeUndefined()
        expect(status.data?.[sessionID]?.type).toBe("busy")
        expect(nativeRequests).toEqual([])

        releaseResponse.resolve()
        asked ??= await permissionFor("search-a")
        if (asked.type !== "permission.asked")
          throw new Error("Expected A permission")
        expect(asked.properties.tool?.messageID).toBe(assistantID)
        const pending = await client.permission.list({
          directory: sandbox.project,
        })
        expect(pending.error).toBeUndefined()
        expect(
          pending.data?.some((entry) => entry.id === asked.properties.id),
        ).toBe(true)
        await approve(asked)
        await idleAfter(start)
        expect(nativeRequests).toHaveLength(1)
        expect(nativeRequests[0]).toMatchObject({
          destination: "a",
          url: `${providers[0]?.baseURL}/responses`,
          authorization: "Bearer e2e-synthetic-key-a",
          headers: {
            "x-e2e-provider": "provider-a",
            "x-e2e-model": "search-a",
            "x-e2e-conflict": "search-a",
          },
          body: { model: "search-wire-a" },
        })
        expect(JSON.stringify(nativeRequests[0]?.body)).toContain("search-a")

        const normal = events.mark()
        await send("b", "Search for normal B.")
        await approve(await permissionFor("search-b"))
        await idleAfter(normal)
        expect(nativeRequests).toHaveLength(2)
        expect(nativeRequests[1]).toMatchObject({
          destination: "b",
          url: `${providers[1]?.baseURL}/responses`,
          authorization: "Bearer e2e-synthetic-key-b",
          headers: {
            "x-e2e-provider": "provider-b",
            "x-e2e-model": "search-b",
            "x-e2e-conflict": "search-b",
          },
          body: { model: "search-wire-b" },
        })
        expect(JSON.stringify(nativeRequests[1]?.body)).toContain("search-b")
      } catch (error) {
        releaseResponse.resolve()
        proxyAbort.abort()
        await fs.writeFile(
          path.join(sandbox.artifacts, "provider-switch.json"),
          JSON.stringify(
            {
              hold,
              nativeRequests,
              chatRequests: providers.map(({ side, provider }) => ({
                side,
                requests: provider.requests,
              })),
              events: recorders.flatMap((recorder) => recorder.events),
            },
            null,
            2,
          ),
        )
        for (const [index, process] of processes.entries())
          await process.writeDiagnostics(
            path.join(sandbox.artifacts, `server-${index + 1}`),
          )
        console.error(
          `E2E artifacts retained at ${await sandbox.preserve("web-search-provider-switch")}`,
        )
        throw error
      }
    }, 90_000)
  }

  test("SearXNG down + no native provider falls back to the Exa JSON-RPC call", async () => {
    const sandbox = await createSandbox("web-search-exa")
    const mcpBodies: unknown[] = []
    const exa = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        mcpBodies.push(await request.json())
        return Response.json({
          result: {
            content: [{ type: "text", text: "exa-fallback-marker result" }],
          },
        })
      },
    })
    const provider = createScriptedProvider({
      finalText: "Read the fallback results.",
      tool: {
        tool: "websearch",
        arguments: { query: "e2e exa probe" },
      },
      maxToolCalls: 1,
    })
    const processes: OpenCodeProcess[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => {
      exa.stop(true)
    })
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await provider.ready
      await writeWebSearchConfig(sandbox.project, provider.baseURL, {
        pluginOptions: {
          // A dead port: the chain must record the failure and move on.
          searxng: { url: "http://127.0.0.1:9", timeoutMs: 2000 },
          exa: { url: `http://127.0.0.1:${exa.port}/mcp` },
        },
      })
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("web-search-exa", {
          OPENCODE_ENABLE_EXA: "1",
        }),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const session = await createSession(client, sandbox.project, "Exa")
      await prompt(client, sandbox.project, session, "Search for the probe.")

      await waitFor(
        async () => requestsText(provider).includes("exa-fallback-marker"),
        {
          description: "exa fallback result reached the model",
          timeout: 30_000,
        },
      )
      // The wire shape is the builtin's Exa call: JSON-RPC tools/call for
      // web_search_exa, query-derived arguments only (no session id, no
      // model name — that is the Parallel path this plugin refuses).
      expect(mcpBodies.length).toBeGreaterThan(0)
      expect(mcpBodies[0]).toMatchObject({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: { query: "e2e exa probe" },
        },
      })
      expect(JSON.stringify(mcpBodies)).not.toContain(session)
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes)
      throw error
    }
  }, 90_000)
})

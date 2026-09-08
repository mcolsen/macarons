import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  createOpencodeClient,
  type Event,
  type ModelRef,
} from "@opencode-ai/sdk/v2"
import { EventRecorder } from "../harness/events"
import { EXPECTED_OPENCODE_VERSION } from "../harness/opencode-binary"
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
  "codex-limits",
  "src",
  "tui.tsx",
)
const SERVER_ENTRY = path.join(path.dirname(TUI_ENTRY), "index.ts")
const AUTH_COMMAND_PREFIX = "macarons.codex-auth.v1"
type CommandExecuted = Extract<Event, { type: "tui.command.execute" }>

const OAUTH_AUTH_CONTENT = JSON.stringify({
  openai: {
    type: "oauth",
    access: "e2e-access-token",
    refresh: "e2e-refresh-token",
    expires: Date.now() + 3_600_000,
    accountId: "e2e-account",
  },
})

const API_KEY_AUTH_CONTENT = JSON.stringify({
  openai: { type: "api", key: "sk-e2e-not-a-secret" },
})

const OTHER_OAUTH_AUTH_CONTENT = JSON.stringify({
  openai: {
    type: "oauth",
    access: "e2e-other-access-token",
    refresh: "e2e-other-refresh-token",
    expires: Date.now() + 3_600_000,
    accountId: "e2e-other-account",
  },
})

const FAST_MODEL = {
  id: "gpt-5.6-sol-fast",
  providerID: "openai",
  variant: "max",
} as const

const OTHER_MODEL = {
  id: "claude-sonnet-4-20250514",
  providerID: "anthropic",
} as const

type UsageRequest = { url: string; headers: Record<string, string> }

// Loopback stand-in for chatgpt.com/backend-api/wham/usage, wired in through
// the codex module's documented `providers.openai.endpoint` option.
function startUsageBackend() {
  const requests: UsageRequest[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({
        url: request.url,
        headers: Object.fromEntries(request.headers),
      })
      return Response.json({
        plan_type: "plus",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 42,
            limit_window_seconds: 18_000,
            reset_at: Math.floor(Date.now() / 1000) + 9_000,
          },
          secondary_window: {
            used_percent: 21,
            limit_window_seconds: 604_800,
            reset_at: Math.floor(Date.now() / 1000) + 400_000,
          },
        },
      })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/wham/usage`,
    requests,
    close: async () => {
      await server.stop(true)
    },
  }
}

// Keep the Fast model as the project default. One journey exercises that
// fallback directly; the switch journey starts with an explicit other model.
// No prompt is sent, so no scripted model backend is needed.
async function writeProject(
  project: string,
  usageURL: string,
  serverPlugin = true,
  serverApiKey?: string,
) {
  await fs.writeFile(
    path.join(project, "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: "openai/gpt-5.6-sol-fast",
        plugin: serverPlugin ? [pathToFileURL(SERVER_ENTRY).href] : [],
        ...(serverApiKey
          ? { provider: { openai: { options: { apiKey: serverApiKey } } } }
          : {}),
      },
      null,
      2,
    )}\n`,
  )
  const directory = path.join(project, ".opencode")
  await fs.mkdir(directory, { recursive: true })
  const file = path.join(directory, "tui.json")
  const spec = [
    pathToFileURL(TUI_ENTRY).href,
    { providers: { openai: { endpoint: usageURL } }, interval: 15 },
  ]
  await fs.writeFile(file, `${JSON.stringify({ plugin: [spec] }, null, 2)}\n`)
  return file
}

async function retainFailure(
  sandbox: Sandbox,
  requests: UsageRequest[],
  server: OpenCodeProcess | undefined,
  tui: TmuxTui | undefined,
  events: EventRecorder | undefined,
) {
  if (server)
    await server.writeDiagnostics(path.join(sandbox.artifacts, "server"))
  if (tui) await tui.writeDiagnostics(path.join(sandbox.artifacts, "tui"))
  await fs.writeFile(
    path.join(sandbox.artifacts, "usage-requests.json"),
    `${JSON.stringify(requests, null, 2)}\n`,
  )
  await fs.writeFile(
    path.join(sandbox.artifacts, "events.json"),
    `${JSON.stringify(events?.events ?? [], null, 2)}\n`,
  )
  const artifact = await sandbox.preserve("codex-limits-tui")
  console.error(`E2E artifacts retained at ${artifact}`)
}

type Journey = {
  sandbox: Sandbox
  backend: ReturnType<typeof startUsageBackend>
  server: OpenCodeProcess
  tui: TmuxTui
  client: ReturnType<typeof createOpencodeClient>
  events: EventRecorder
  sessionID: string
}

describe("codex-limits sidebar widget", () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function startJourney(input: {
    name: string
    serverAuth: string
    tuiAuth?: string
    model?: ModelRef
    serverPlugin?: boolean
    disableDefaultPlugins?: boolean
    serverApiKey?: string
  }): Promise<Journey> {
    const sandbox = await createSandbox(input.name)
    const backend = startUsageBackend()
    let server: OpenCodeProcess | undefined
    let tui: TmuxTui | undefined
    let events: EventRecorder | undefined
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => backend.close())
    cleanups.push(async () => tui?.stop())
    cleanups.push(async () => server?.stop())
    cleanups.push(async () => events?.close())

    try {
      const tuiConfig = await writeProject(
        sandbox.project,
        backend.url,
        input.serverPlugin,
        input.serverApiKey,
      )
      server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("server", {
          OPENCODE_AUTH_CONTENT: input.serverAuth,
          // No prompts are sent: enable bundled Codex for real OAuth-mode
          // applicability without spending fake refresh tokens on a provider.
          OPENCODE_DISABLE_DEFAULT_PLUGINS: input.disableDefaultPlugins
            ? "1"
            : "0",
        }),
      })
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: sandbox.project,
      })
      events = await EventRecorder.connect(client)
      const created = await client.session.create({
        directory: sandbox.project,
        title: "E2E Codex limits",
        ...(input.model ? { model: input.model } : {}),
      })
      if (created.error || !created.data)
        throw new Error(
          `Could not create session: ${JSON.stringify(created.error)}`,
        )
      tui = await startTmuxTui({
        directory: sandbox.project,
        env: await sandbox.environment("tui", {
          OPENCODE_AUTH_CONTENT: input.tuiAuth ?? input.serverAuth,
        }),
        serverURL: server.url,
        sessionID: created.data.id,
        tuiConfig,
      })
      return {
        sandbox,
        backend,
        server,
        tui,
        client,
        events,
        sessionID: created.data.id,
      }
    } catch (error) {
      await retainFailure(sandbox, backend.requests, server, tui, events)
      throw error
    }
  }

  test("shows the 5h and weekly windows after a server-staged Fast OpenAI-via-OAuth model switch", async () => {
    const journey = await startJourney({
      name: "codex-limits-oauth",
      serverAuth: OAUTH_AUTH_CONTENT,
      model: OTHER_MODEL,
    })
    try {
      await journey.tui.waitForText("Context")
      await Bun.sleep(500)
      expect(await journey.tui.capture()).not.toContain("Codex Limits")
      expect(journey.backend.requests).toHaveLength(0)

      const switched = await journey.client.v2.session.switchModel({
        sessionID: journey.sessionID,
        model: FAST_MODEL,
      })
      if (switched.error)
        throw new Error(
          `Could not switch model: ${JSON.stringify(switched.error)}`,
        )

      await journey.tui.waitForText("Codex Limits")
      // The 5h reset (+2.5h) is usually today ("14:32") but crosses midnight
      // into the dated form ("15 Jul 14:32"); the weekly reset (+4.6d) is
      // always dated. Accept either so the test doesn't flake by wall clock.
      const reset = /resets (\d{1,2} \w{3} )?\d{2}:\d{2}/.source
      const pane = await journey.tui.waitForText(
        new RegExp(`5h 58% left · ${reset}`),
      )
      expect(pane).toMatch(new RegExp(`7d 79% left · ${reset}`))

      expect(journey.backend.requests.length).toBeGreaterThanOrEqual(1)
      const request = journey.backend.requests[0]
      if (!request) throw new Error("expected a backend request")
      expect(request.url.endsWith("/wham/usage")).toBe(true)
      expect(request.headers.authorization).toBe("Bearer e2e-access-token")
      expect(request.headers["chatgpt-account-id"]).toBe("e2e-account")
      expect(request.headers.originator).toBe("opencode")
      expect(request.headers["user-agent"]).toBe(
        `opencode/${EXPECTED_OPENCODE_VERSION}`,
      )
      const proofEvents = journey.events.events.filter(
        (event) =>
          event.type === "tui.command.execute" &&
          event.properties.command.startsWith(AUTH_COMMAND_PREFIX),
      )
      expect(proofEvents.length).toBeGreaterThanOrEqual(2)
      expect(JSON.stringify(proofEvents)).not.toMatch(
        /e2e-(access-token|refresh-token|account)/,
      )
    } catch (error) {
      await retainFailure(
        journey.sandbox,
        journey.backend.requests,
        journey.server,
        journey.tui,
        journey.events,
      )
      throw error
    }
  })

  test("shows limits from the configured default without a session model", async () => {
    const journey = await startJourney({
      name: "codex-limits-config-default",
      serverAuth: OAUTH_AUTH_CONTENT,
    })
    try {
      const pane = await journey.tui.waitForText("Codex Limits")
      expect(pane).toContain("5h 58% left")
      expect(journey.backend.requests.length).toBeGreaterThanOrEqual(1)
    } catch (error) {
      await retainFailure(
        journey.sandbox,
        journey.backend.requests,
        journey.server,
        journey.tui,
        journey.events,
      )
      throw error
    }
  })

  test("stays hidden when OpenAI is authenticated with an API key", async () => {
    const journey = await startJourney({
      name: "codex-limits-apikey",
      serverAuth: API_KEY_AUTH_CONTENT,
      model: FAST_MODEL,
    })
    try {
      // The built-in Context section proves the sidebar itself rendered.
      await journey.tui.waitForText("Context")
      await Bun.sleep(2_000)
      const pane = await journey.tui.capture()
      expect(pane).not.toContain("Codex Limits")
      expect(journey.backend.requests).toHaveLength(0)
    } catch (error) {
      await retainFailure(
        journey.sandbox,
        journey.backend.requests,
        journey.server,
        journey.tui,
        journey.events,
      )
      throw error
    }
  })

  test.each([
    {
      name: "an API-key server",
      serverAuth: API_KEY_AUTH_CONTENT,
      serverPlugin: true,
    },
    {
      name: "a different OAuth server identity",
      serverAuth: OTHER_OAUTH_AUTH_CONTENT,
      serverPlugin: true,
    },
    {
      name: "no server companion",
      serverAuth: OAUTH_AUTH_CONTENT,
      serverPlugin: false,
    },
    {
      name: "inactive stored OAuth and a configured API key",
      serverAuth: OAUTH_AUTH_CONTENT,
      serverPlugin: true,
      disableDefaultPlugins: true,
      serverApiKey: "sk-e2e-configured-not-a-secret",
    },
  ])(
    "stays hidden on loopback with local OAuth and $name",
    async ({
      name,
      serverAuth,
      serverPlugin,
      disableDefaultPlugins,
      serverApiKey,
    }) => {
      const journey = await startJourney({
        name: `codex-limits-${name}`,
        serverAuth,
        tuiAuth: OAUTH_AUTH_CONTENT,
        model: FAST_MODEL,
        serverPlugin,
        disableDefaultPlugins,
        serverApiKey,
      })
      try {
        await journey.tui.waitForText("Context")
        // Observe the actual TUI probe so a failed plugin load cannot make a
        // negative quota assertion pass without exercising the auth gate.
        const probe = await journey.events.waitFor(
          (event): event is CommandExecuted =>
            event.type === "tui.command.execute" &&
            event.properties.command.startsWith(
              `${AUTH_COMMAND_PREFIX}:probe:`,
            ),
          { description: "Codex TUI auth-scope probe" },
        )
        if (serverPlugin) {
          const replyPrefix = `${probe.properties.command.replace(":probe:", ":result:")}:`
          await journey.events.waitFor(
            (event) =>
              event.type === "tui.command.execute" &&
              event.properties.command.startsWith(replyPrefix),
            { description: "Codex server auth-scope response" },
          )
        }
        // Also outlast the missing-companion deadline: a timeout must not
        // fall back to trusting loopback and spending the TUI's credentials.
        await Bun.sleep(4_000)
        expect(await journey.tui.capture()).not.toContain("Codex Limits")
        expect(journey.backend.requests).toHaveLength(0)
      } catch (error) {
        await retainFailure(
          journey.sandbox,
          journey.backend.requests,
          journey.server,
          journey.tui,
          journey.events,
        )
        throw error
      }
    },
  )
})

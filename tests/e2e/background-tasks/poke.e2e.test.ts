import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import {
  BACKGROUND_TASKS_SERVER_ENTRY,
  BACKGROUND_TASKS_TUI_ENTRY,
} from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import { createScriptedProvider } from "../harness/scripted-provider"
import { startTmuxTui, type TmuxTui } from "../harness/tmux"

// Verifies the server→TUI poke. With BOTH halves installed and the TUI's
// fallback poll pushed out to ten minutes, a background task started AFTER the
// TUI has finished its initial sync can only reach the sidebar via the
// `tui.command.execute` poke the server half publishes on each state write.
// If the poke did not work, the sidebar would not update until the (disabled)
// poll and the test would time out.

const POLL_MS = 600_000 // effectively disabled, isolating the poke

async function retainFailure(
  sandbox: Sandbox,
  server: OpenCodeProcess | undefined,
  tui: TmuxTui | undefined,
) {
  if (server)
    await server.writeDiagnostics(path.join(sandbox.artifacts, "server"))
  if (tui) await tui.writeDiagnostics(path.join(sandbox.artifacts, "tui"))
  const artifact = await sandbox.preserve("background-tasks-poke")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("background-tasks server→TUI poke", () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("a task started after the TUI is up appears via the poke, not the poll", async () => {
    const sandbox = await createSandbox("background-tasks-poke")
    const provider = createScriptedProvider({
      command: "unused",
      finalText: "Started.",
      tool: {
        tool: "background_run",
        arguments: { command: "sleep 600", name: "poke runner" },
      },
      maxToolCalls: 1,
    })
    let server: OpenCodeProcess | undefined
    let tui: TmuxTui | undefined
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => tui?.stop())
    cleanups.push(async () => server?.stop())

    try {
      await provider.ready
      // Both halves: server (opencode.json) + TUI (tui.json) with a 10-min poll.
      const serverEntry = pathToFileURL(BACKGROUND_TASKS_SERVER_ENTRY).href
      await fs.writeFile(
        path.join(sandbox.project, "opencode.json"),
        `${JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            model: "e2e/test",
            provider: {
              e2e: {
                npm: "@ai-sdk/openai-compatible",
                name: "E2E scripted provider",
                options: {
                  apiKey: "e2e-not-a-secret",
                  baseURL: provider.baseURL,
                },
                models: {
                  test: {
                    name: "E2E scripted model",
                    limit: { context: 32_000, output: 4_096 },
                  },
                },
              },
            },
            permission: { bash: "allow" },
            plugin: [serverEntry],
          },
          null,
          2,
        )}\n`,
      )
      const tuiDir = path.join(sandbox.project, ".opencode")
      await fs.mkdir(tuiDir, { recursive: true })
      const tuiConfig = path.join(tuiDir, "tui.json")
      await fs.writeFile(
        tuiConfig,
        `${JSON.stringify({ plugin: [[pathToFileURL(BACKGROUND_TASKS_TUI_ENTRY).href, { pollMs: POLL_MS }]] }, null, 2)}\n`,
      )

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
        title: "Poke test",
      })
      if (created.error || !created.data)
        throw new Error(
          `Could not create session: ${JSON.stringify(created.error)}`,
        )
      const sessionID = created.data.id

      tui = await startTmuxTui({
        directory: sandbox.project,
        env: await sandbox.environment("tui"),
        serverURL: server.url,
        sessionID,
        tuiConfig,
      })

      // Let the TUI fully come up and run its initial sync (the host Context
      // sidebar section is a stable "the sidebar rendered" marker). No
      // background task exists yet, so nothing of ours shows.
      await tui.waitForText("Context")
      await Bun.sleep(1_000)
      expect(await tui.capture()).not.toContain("poke runner")

      // Now start the task. Its only path to the sidebar is the poke.
      const prompted = await client.session.promptAsync({
        directory: sandbox.project,
        sessionID,
        model: { providerID: "e2e", modelID: "test" },
        parts: [{ type: "text", text: "Start the background runner." }],
      })
      if (prompted.error)
        throw new Error(`Could not prompt: ${JSON.stringify(prompted.error)}`)

      // Comfortably under the 10-minute poll: appearing at all proves the poke.
      await tui.waitForText("poke runner", 20_000)
    } catch (error) {
      await retainFailure(sandbox, server, tui)
      throw error
    }
  }, 90_000)
})

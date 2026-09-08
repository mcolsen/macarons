import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import { EventRecorder } from "../harness/events"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import {
  readJson,
  storeFile,
  writeProjectConfig,
  writeTuiConfig,
} from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import {
  createScriptedProvider,
  type ScriptedProvider,
} from "../harness/scripted-provider"
import { startTmuxTui, type TmuxTui } from "../harness/tmux"

type PermissionAsked = Extract<Event, { type: "permission.asked" }>
type PermissionReplied = Extract<Event, { type: "permission.replied" }>
type SessionIdle = Extract<Event, { type: "session.idle" }>

const FIRST_COMMAND = "git status --short"
const EDITED_PATTERN = "git status --short"
const UNMATCHED_COMMAND = "git rev-parse --is-inside-work-tree"

async function retainFailure(
  sandbox: Sandbox,
  provider: ScriptedProvider | undefined,
  server: OpenCodeProcess | undefined,
  events: EventRecorder | undefined,
  tui: TmuxTui | undefined,
) {
  if (server)
    await server.writeDiagnostics(path.join(sandbox.artifacts, "server"))
  if (tui) await tui.writeDiagnostics(path.join(sandbox.artifacts, "tui"))
  await fs.writeFile(
    path.join(sandbox.artifacts, "events.json"),
    `${JSON.stringify(events?.events ?? [], null, 2)}\n`,
  )
  await fs.writeFile(
    path.join(sandbox.artifacts, "provider-requests.json"),
    `${JSON.stringify(provider?.requests ?? [], null, 2)}\n`,
  )
  const artifact = await sandbox.preserve("persist-permissions-tui")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("persist-permissions TUI companion", () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("edits a persistent permission rule through Ctrl+O and leaves a cancelled rule pending", async () => {
    const sandbox = await createSandbox("persist-permissions-tui")
    const provider = createScriptedProvider({ command: FIRST_COMMAND })
    let server: OpenCodeProcess | undefined
    let events: EventRecorder | undefined
    let tui: TmuxTui | undefined
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => events?.close())
    cleanups.push(async () => tui?.stop())
    cleanups.push(async () => server?.stop())

    try {
      await provider.ready
      await writeProjectConfig(sandbox.project, provider.baseURL)
      const tuiConfig = await writeTuiConfig(sandbox.project)
      server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("server"),
      })
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: sandbox.project,
      })
      events = await EventRecorder.connect(client)
      const created = await client.session.create({
        directory: sandbox.project,
        title: "E2E TUI companion",
      })
      if (created.error || !created.data)
        throw new Error(
          `Could not create TUI session: ${JSON.stringify(created.error)}`,
        )
      const sessionID = created.data.id
      tui = await startTmuxTui({
        directory: sandbox.project,
        env: await sandbox.environment("tui"),
        serverURL: server.url,
        sessionID,
        tuiConfig,
      })
      await tui.waitForText(/OpenCode|opencode/i)

      const firstMark = events.mark()
      const firstPrompt = await client.session.promptAsync({
        directory: sandbox.project,
        sessionID,
        model: { providerID: "e2e", modelID: "test" },
        parts: [
          { type: "text", text: "Run the scripted command exactly once." },
        ],
      })
      if (firstPrompt.error)
        throw new Error(
          `Could not start TUI prompt: ${JSON.stringify(firstPrompt.error)}`,
        )
      const firstAsked = await events.waitFor(
        (event): event is PermissionAsked =>
          event.type === "permission.asked" &&
          event.properties.sessionID === sessionID,
        { after: firstMark, description: "TUI permission.asked" },
      )
      expect(firstAsked.properties.patterns).toEqual([FIRST_COMMAND])
      await tui.waitForText("edit pattern & always allow")
      await tui.sendKey("C-o")
      await tui.waitForText('Always allow "bash"')
      await tui.sendKey("C-u")
      await tui.type(EDITED_PATTERN)
      await tui.sendKey("Enter")
      const firstReply = await events.waitFor(
        (event): event is PermissionReplied =>
          event.type === "permission.replied" &&
          event.properties.sessionID === sessionID,
        { after: firstMark, description: "TUI permission.replied" },
      )
      expect(firstReply.properties.requestID).toBe(firstAsked.properties.id)
      expect(firstReply.properties.reply).toBe("once")
      await events.waitFor(
        (event): event is SessionIdle =>
          event.type === "session.idle" &&
          event.properties.sessionID === sessionID,
        { after: firstMark, description: "TUI session idle" },
      )
      const persisted = await readJson<{
        permission: { bash: Record<string, string> }
      }>(storeFile(sandbox.config, sandbox.project))
      expect(persisted.permission.bash).toEqual({ [EDITED_PATTERN]: "allow" })

      provider.setCommand(UNMATCHED_COMMAND)
      const cancelledMark = events.mark()
      const cancelledPrompt = await client.session.promptAsync({
        directory: sandbox.project,
        sessionID,
        model: { providerID: "e2e", modelID: "test" },
        parts: [
          { type: "text", text: "Run the next scripted command exactly once." },
        ],
      })
      if (cancelledPrompt.error)
        throw new Error(
          `Could not start cancellation prompt: ${JSON.stringify(cancelledPrompt.error)}`,
        )
      const cancelledAsked = await events.waitFor(
        (event): event is PermissionAsked =>
          event.type === "permission.asked" &&
          event.properties.sessionID === sessionID,
        { after: cancelledMark, description: "cancelled TUI permission.asked" },
      )
      await tui.waitForText("edit pattern & always allow")
      await tui.sendKey("C-o")
      await tui.waitForText('Always allow "bash"')
      await tui.sendKey("Escape")
      const pending = await client.permission.list({
        directory: sandbox.project,
      })
      if (pending.error || !pending.data)
        throw new Error(
          `Could not inspect cancelled permission: ${JSON.stringify(pending.error)}`,
        )
      expect(
        pending.data.some(
          (request) => request.id === cancelledAsked.properties.id,
        ),
      ).toBe(true)
      expect(
        await readJson<typeof persisted>(
          storeFile(sandbox.config, sandbox.project),
        ),
      ).toEqual(persisted)
      const rejected = await client.permission.reply({
        directory: sandbox.project,
        requestID: cancelledAsked.properties.id,
        reply: "reject",
      })
      if (rejected.error)
        throw new Error(
          `Could not reject cancelled permission: ${JSON.stringify(rejected.error)}`,
        )
      await events.waitFor(
        (event): event is SessionIdle =>
          event.type === "session.idle" &&
          event.properties.sessionID === sessionID,
        { after: cancelledMark, description: "cancelled session idle" },
      )
    } catch (error) {
      await retainFailure(sandbox, provider, server, events, tui)
      throw error
    }
  })
})

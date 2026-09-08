import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import { EventRecorder } from "../harness/events"
import {
  type OpenCodeProcess,
  runOpenCodeCommand,
  startOpenCode,
} from "../harness/opencode-process"
import {
  PERSIST_PERMISSIONS_ROOT,
  readJson,
  storeFile,
  writeProjectConfig,
} from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import {
  createScriptedProvider,
  type ScriptedProvider,
} from "../harness/scripted-provider"

type PermissionAsked = Extract<Event, { type: "permission.asked" }>
type SessionIdle = Extract<Event, { type: "session.idle" }>

const COMMAND = "git status --short"

async function retainFailure(
  sandbox: Sandbox,
  provider: ScriptedProvider | undefined,
  process: OpenCodeProcess | undefined,
  recorder: EventRecorder | undefined,
) {
  if (process)
    await process.writeDiagnostics(path.join(sandbox.artifacts, "server"))
  await fs.writeFile(
    path.join(sandbox.artifacts, "provider-requests.json"),
    `${JSON.stringify(provider?.requests ?? [], null, 2)}\n`,
  )
  await fs.writeFile(
    path.join(sandbox.artifacts, "events.json"),
    `${JSON.stringify(recorder?.events ?? [], null, 2)}\n`,
  )
  const artifact = await sandbox.preserve("persist-permissions-install")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("opencode plugin installer", () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("installs both targets and loads the server half from generated configuration", async () => {
    const sandbox = await createSandbox("persist-permissions-install")
    const provider = createScriptedProvider({ command: COMMAND })
    let server: OpenCodeProcess | undefined
    let events: EventRecorder | undefined
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => events?.close())
    cleanups.push(async () => server?.stop())

    try {
      await provider.ready
      // Keep the provider and permission policy in the root config. The installer
      // writes its target entries below .opencode, just as it would for a user.
      await writeProjectConfig(sandbox.project, provider.baseURL, {
        serverPlugin: false,
      })
      const install = await runOpenCodeCommand({
        args: ["plugin", PERSIST_PERMISSIONS_ROOT],
        cwd: sandbox.project,
        env: await sandbox.environment("installer"),
      })
      expect(install.code).toBe(0)

      const serverConfigFile = path.join(
        sandbox.project,
        ".opencode",
        "opencode.json",
      )
      const tuiConfigFile = path.join(sandbox.project, ".opencode", "tui.json")
      const [serverConfig, tuiConfig] = await Promise.all([
        readJson(serverConfigFile),
        readJson(tuiConfigFile),
      ])
      expect(JSON.stringify(serverConfig)).toContain("persist-permissions")
      expect(JSON.stringify(tuiConfig)).toContain("persist-permissions")

      server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("runtime"),
      })
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: sandbox.project,
      })
      events = await EventRecorder.connect(client)
      const created = await client.session.create({
        directory: sandbox.project,
        title: "E2E installer load",
      })
      if (created.error || !created.data)
        throw new Error(
          `Could not create session: ${JSON.stringify(created.error)}`,
        )
      const mark = events.mark()
      const prompted = await client.session.promptAsync({
        directory: sandbox.project,
        sessionID: created.data.id,
        model: { providerID: "e2e", modelID: "test" },
        parts: [
          { type: "text", text: "Run the scripted command exactly once." },
        ],
      })
      if (prompted.error)
        throw new Error(
          `Could not start prompt: ${JSON.stringify(prompted.error)}`,
        )
      const asked = await events.waitFor(
        (event): event is PermissionAsked =>
          event.type === "permission.asked" &&
          event.properties.sessionID === created.data.id,
        { after: mark, description: "installer-loaded permission.asked" },
      )
      const approved = await client.permission.reply({
        directory: sandbox.project,
        requestID: asked.properties.id,
        reply: "always",
      })
      if (approved.error)
        throw new Error(
          `Could not approve permission: ${JSON.stringify(approved.error)}`,
        )
      await events.waitFor(
        (event): event is SessionIdle =>
          event.type === "session.idle" &&
          event.properties.sessionID === created.data.id,
        { after: mark, description: "installer-loaded session idle" },
      )
      expect(
        await readJson<{ permission: { bash: { "git status *": string } } }>(
          storeFile(sandbox.config, sandbox.project),
        ),
      ).toEqual({ permission: { bash: { "git status *": "allow" } } })
    } catch (error) {
      await retainFailure(sandbox, provider, server, events)
      throw error
    }
  })
})

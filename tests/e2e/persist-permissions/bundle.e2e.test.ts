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
  SERVER_ENTRY,
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

async function writeBundledPlugin(project: string) {
  const build = await Bun.build({ entrypoints: [SERVER_ENTRY], target: "bun" })
  const output = build.outputs[0]
  if (!build.success || build.outputs.length !== 1 || !output) {
    throw new Error(
      `Could not bundle persist-permissions for E2E: ${JSON.stringify(build.logs)}`,
    )
  }
  const directory = path.join(project, ".opencode", "plugin")
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, "persist-permissions.js"),
    await output.text(),
  )
}

async function retainFailure(
  sandbox: Sandbox,
  provider: ScriptedProvider | undefined,
  server: OpenCodeProcess | undefined,
  events: EventRecorder | undefined,
) {
  if (server)
    await server.writeDiagnostics(path.join(sandbox.artifacts, "server"))
  await fs.writeFile(
    path.join(sandbox.artifacts, "events.json"),
    `${JSON.stringify(events?.events ?? [], null, 2)}\n`,
  )
  await fs.writeFile(
    path.join(sandbox.artifacts, "provider-requests.json"),
    `${JSON.stringify(provider?.requests ?? [], null, 2)}\n`,
  )
  const artifact = await sandbox.preserve("persist-permissions-bundle")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("copy-installed persist-permissions bundle", () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("loads from .opencode/plugin and persists a real approval", async () => {
    const sandbox = await createSandbox("persist-permissions-bundle")
    const provider = createScriptedProvider({ command: COMMAND })
    let server: OpenCodeProcess | undefined
    let events: EventRecorder | undefined
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => events?.close())
    cleanups.push(async () => server?.stop())

    try {
      await provider.ready
      await writeProjectConfig(sandbox.project, provider.baseURL, {
        serverPlugin: false,
      })
      await writeBundledPlugin(sandbox.project)
      server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("bundle"),
      })
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: sandbox.project,
      })
      events = await EventRecorder.connect(client)
      const created = await client.session.create({
        directory: sandbox.project,
        title: "E2E bundled plugin",
      })
      if (created.error || !created.data)
        throw new Error(
          `Could not create bundle session: ${JSON.stringify(created.error)}`,
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
          `Could not start bundled prompt: ${JSON.stringify(prompted.error)}`,
        )
      const asked = await events.waitFor(
        (event): event is PermissionAsked =>
          event.type === "permission.asked" &&
          event.properties.sessionID === created.data.id,
        { after: mark, description: "bundled plugin permission.asked" },
      )
      const approved = await client.permission.reply({
        directory: sandbox.project,
        requestID: asked.properties.id,
        reply: "always",
      })
      if (approved.error)
        throw new Error(
          `Could not approve bundled permission: ${JSON.stringify(approved.error)}`,
        )
      await events.waitFor(
        (event): event is SessionIdle =>
          event.type === "session.idle" &&
          event.properties.sessionID === created.data.id,
        { after: mark, description: "bundled plugin session idle" },
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

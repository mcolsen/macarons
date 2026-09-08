import { afterEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import {
  activityFile,
  readActivity,
  requestInstanceID,
} from "../../../plugins/approve-for-me/src/shared"
import { EventRecorder } from "../harness/events"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import {
  AUTO_APPROVE_ROOT,
  storeFile,
  writeProjectConfig,
} from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import {
  createScriptedProvider,
  type ScriptedProvider,
} from "../harness/scripted-provider"
import { waitFor } from "../harness/wait"

/**
 * The copy-install path: `bun run build` bundles the server half together
 * with the @macarons/permission-rules workspace library into one
 * file under .opencode/plugin/, where OpenCode loads every file as its own
 * plugin. The bundle must classify and auto-approve exactly like the source
 * install — with no node_modules anywhere near the project.
 */

type PermissionAsked = Extract<Event, { type: "permission.asked" }>
type PermissionReplied = Extract<Event, { type: "permission.replied" }>
type SessionIdle = Extract<Event, { type: "session.idle" }>

const execFileAsync = promisify(execFile)

const COMMAND = "git status --short"

async function writeBundledPlugin(project: string) {
  // Build exactly the way README Option C does — from the package root — so
  // dependencies that bun did not hoist to the monorepo root (jsonc-parser)
  // resolve through the package's own node_modules. A Bun.build from this
  // test's cwd resolves such a dependency out of the install cache instead
  // and leaves unresolvable relative requires in the output: a bundle the
  // host then fails to import, with no error surfaced anywhere.
  const directory = path.join(project, ".opencode", "plugin")
  await fs.mkdir(directory, { recursive: true })
  const outfile = path.join(directory, "approve-for-me.js")
  await execFileAsync(
    "bun",
    ["build", "src/index.ts", "--target=bun", `--outfile=${outfile}`],
    { cwd: AUTO_APPROVE_ROOT },
  )
  // Guard against the failure mode recurring in some new form: the bundle
  // must be importable in isolation before the host ever sees it.
  await import(outfile)
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
  const artifact = await sandbox.preserve("approve-for-me-bundle")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("copy-installed approve-for-me bundle", () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("loads from .opencode/plugin and auto-approves 'once' without persisting", async () => {
    const sandbox = await createSandbox("approve-for-me-bundle")
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
      const environment = await sandbox.environment("bundle")
      if (!environment.XDG_STATE_HOME)
        throw new Error("sandbox omitted XDG_STATE_HOME")
      server = await startOpenCode({
        cwd: sandbox.project,
        env: environment,
      })
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: sandbox.project,
      })
      events = await EventRecorder.connect(client)
      const instanceID = await requestInstanceID(
        events.tuiDiscoveryApi(client, sandbox.project),
      )
      if (!instanceID) throw new Error("could not discover server instance ID")
      // Separate init failures from classification failures outright: once
      // the event stream's directory query has bootstrapped the instance
      // (plugins load then, not at `serve` startup), the bundled server half
      // writes a ready beacon before any permission traffic exists. A bundle
      // the host cannot import fails HERE, not twenty seconds into a
      // permission wait with nothing in the logs.
      const beaconFile = activityFile(
        path.join(environment.XDG_STATE_HOME, "opencode"),
        sandbox.project,
        instanceID,
      )
      await waitFor(
        async () => (await readActivity(beaconFile))?.server?.state === "ready",
        { description: "the bundled server half's ready beacon" },
      )
      const created = await client.session.create({
        directory: sandbox.project,
        title: "E2E bundled auto-approve",
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
        { after: mark, description: "bundled auto-approve permission.asked" },
      )
      const replied = await events.waitFor(
        (event): event is PermissionReplied =>
          event.type === "permission.replied" &&
          event.properties.sessionID === created.data.id,
        { after: mark, description: "bundled auto-approve permission.replied" },
      )
      expect(replied.properties.requestID).toBe(asked.properties.id)
      expect(replied.properties.reply).toBe("once")
      await events.waitFor(
        (event): event is SessionIdle =>
          event.type === "session.idle" &&
          event.properties.sessionID === created.data.id,
        { after: mark, description: "bundled auto-approve session idle" },
      )
      expect(provider.classifierRequests.length).toBe(1)
      expect(await fs.exists(storeFile(sandbox.config, sandbox.project))).toBe(
        false,
      )
    } catch (error) {
      await retainFailure(sandbox, provider, server, events)
      throw error
    }
  })
})

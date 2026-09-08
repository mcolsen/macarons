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
  AUTO_APPROVE_ROOT,
  blessAutoApproveProjectConfig,
  readJson,
  storeFile,
  writeProjectConfig,
} from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import {
  createScriptedProvider,
  type ScriptedProvider,
} from "../harness/scripted-provider"

/**
 * The one-command install journey: `opencode plugin <package-directory>` must
 * detect both targets from the package exports, patch .opencode/opencode.json
 * and .opencode/tui.json, and the installed server half — resolving the
 * @macarons/permission-rules workspace dependency from the monorepo
 * checkout — must classify and auto-approve on the next start.
 */

type PermissionAsked = Extract<Event, { type: "permission.asked" }>
type PermissionReplied = Extract<Event, { type: "permission.replied" }>
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
  const artifact = await sandbox.preserve("approve-for-me-install")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("opencode plugin installer", () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("installs both targets and the loaded server half auto-approves without persisting", async () => {
    const sandbox = await createSandbox("approve-for-me-install")
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
        args: ["plugin", AUTO_APPROVE_ROOT],
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
      expect(JSON.stringify(serverConfig)).toContain("approve-for-me")
      expect(JSON.stringify(tuiConfig)).toContain("approve-for-me")

      // The host adds "$schema" to a schema-less config file on first load
      // and writes it back (config.ts loadFile) — which would drift a
      // pre-start blessing. Settle the file's final form now so the blessing
      // below matches the bytes the runtime instance will keep reading. (A
      // real user blesses from the running TUI, after that rewrite.)
      await fs.writeFile(
        serverConfigFile,
        `${JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            ...(serverConfig as Record<string, unknown>),
          },
          null,
          2,
        )}\n`,
      )
      // The installer landed the entry in worktree config, which is never
      // honored unreviewed: record the blessing the TUI's trust command
      // would — the README's one post-install step for project-local
      // installs.
      const runtimeEnv = await sandbox.environment("runtime")
      if (!runtimeEnv.XDG_STATE_HOME)
        throw new Error("sandbox omitted XDG_STATE_HOME")
      await blessAutoApproveProjectConfig(
        runtimeEnv.XDG_STATE_HOME,
        sandbox.project,
      )
      server = await startOpenCode({
        cwd: sandbox.project,
        env: runtimeEnv,
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
      const replied = await events.waitFor(
        (event): event is PermissionReplied =>
          event.type === "permission.replied" &&
          event.properties.sessionID === created.data.id,
        { after: mark, description: "installer-loaded permission.replied" },
      )
      expect(replied.properties.requestID).toBe(asked.properties.id)
      expect(replied.properties.reply).toBe("once")
      await events.waitFor(
        (event): event is SessionIdle =>
          event.type === "session.idle" &&
          event.properties.sessionID === created.data.id,
        { after: mark, description: "installer-loaded session idle" },
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

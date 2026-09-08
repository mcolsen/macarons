import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import {
  overrideFile,
  readSessionModel,
  requestInstanceID,
  sessionModelDirectory,
  sessionModelFile,
} from "../../../plugins/approve-for-me/src/shared"
import { EventRecorder } from "../harness/events"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import {
  AUTO_APPROVE_SERVER_ENTRY,
  AUTO_APPROVE_TUI_ENTRY,
  autoApproveSettingsFile,
  blessAutoApproveProjectConfig,
  writeProjectConfig,
  writeTuiConfig,
} from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import {
  createScriptedProvider,
  type ScriptedProvider,
} from "../harness/scripted-provider"
import { startTmuxTui, type TmuxTui } from "../harness/tmux"
import { pickOption, runPaletteCommand } from "../harness/tui-commands"
import { waitFor } from "../harness/wait"

/**
 * The interactive half of the trust boundary, driven like a user: the sidebar
 * status line, and the instance toggle flowing from a keypress through the
 * override file into the server half's next decision. Scripted provider,
 * pinned OpenCode, tmux terminal — no real models, no real approvals.
 */

type PermissionAsked = Extract<Event, { type: "permission.asked" }>
type PermissionReplied = Extract<Event, { type: "permission.replied" }>
type SessionIdle = Extract<Event, { type: "session.idle" }>

const COMMAND = "git status --short"

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
  const artifact = await sandbox.preserve("approve-for-me-tui")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("approve-for-me TUI companion", () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("shows the sidebar status and toggles auto-approve for the instance", async () => {
    const sandbox = await createSandbox("approve-for-me-tui")
    const provider = createScriptedProvider({ command: COMMAND })
    let server: OpenCodeProcess | undefined
    let events: EventRecorder | undefined
    let tui: TmuxTui | undefined
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => events?.close())
    // Pushed after the server so LIFO cleanup stops the attached TUI first;
    // killing the server under a live TUI leaves it wedged on a dead socket.
    cleanups.push(async () => server?.stop())
    cleanups.push(async () => tui?.stop())

    try {
      await provider.ready
      await writeProjectConfig(sandbox.project, provider.baseURL, {
        plugins: [AUTO_APPROVE_SERVER_ENTRY],
      })
      const tuiConfig = await writeTuiConfig(sandbox.project, [
        AUTO_APPROVE_TUI_ENTRY,
      ])
      // The TUI reuses the server's instance environment: the toggle override
      // lives under the OpenCode state directory and both halves must agree
      // on which one that is.
      const environment = await sandbox.environment("server")
      if (!environment.XDG_STATE_HOME)
        throw new Error("sandbox omitted XDG_STATE_HOME")
      await blessAutoApproveProjectConfig(
        environment.XDG_STATE_HOME,
        sandbox.project,
      )
      server = await startOpenCode({ cwd: sandbox.project, env: environment })
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: sandbox.project,
      })
      events = await EventRecorder.connect(client)
      const instanceID = await requestInstanceID(
        events.tuiDiscoveryApi(client, sandbox.project),
      )
      if (!instanceID) throw new Error("could not discover server instance ID")
      const created = await client.session.create({
        directory: sandbox.project,
        title: "E2E auto-approve TUI",
      })
      if (created.error || !created.data)
        throw new Error(
          `Could not create TUI session: ${JSON.stringify(created.error)}`,
        )
      const sessionID = created.data.id
      tui = await startTmuxTui({
        directory: sandbox.project,
        env: environment,
        serverURL: server.url,
        sessionID,
        tuiConfig,
      })

      // The trust posture is on screen from the start: a bold "Approve for Me"
      // header (like the host's own Context/LSP sections) over the status line.
      await tui.waitForText(/Approve for Me/)
      await tui.waitForText(/on · session model/)

      // Toggle OFF: keypress → override file → sidebar.
      await tui.sendKey("C-M-a")
      await tui.waitForText(/off \(this instance\)/)
      const overridePath = overrideFile(
        path.join(environment.XDG_STATE_HOME, "opencode"),
        sandbox.project,
        instanceID,
      )
      const override = JSON.parse(await fs.readFile(overridePath, "utf8"))
      expect(override.enabled).toBe(false)
      // The toggle stamps its write time so the server half can prove a
      // mid-wait toggle-off to the unattended-deny timer.
      expect(typeof override.at).toBe("number")

      // While OFF, a permission request waits for the user.
      const offMark = events.mark()
      const offPrompt = await client.session.promptAsync({
        directory: sandbox.project,
        sessionID,
        model: { providerID: "e2e", modelID: "test" },
        parts: [
          { type: "text", text: "Run the scripted command exactly once." },
        ],
      })
      if (offPrompt.error)
        throw new Error(
          `Could not start toggled-off prompt: ${JSON.stringify(offPrompt.error)}`,
        )
      const offAsked = await events.waitFor(
        (event): event is PermissionAsked =>
          event.type === "permission.asked" &&
          event.properties.sessionID === sessionID,
        { after: offMark, description: "toggled-off permission.asked" },
      )
      await Bun.sleep(1_500)
      expect(provider.classifierRequests.length).toBe(0)
      const pending = await client.permission.list({
        directory: sandbox.project,
      })
      if (pending.error || !pending.data)
        throw new Error(
          `Could not list pending permissions: ${JSON.stringify(pending.error)}`,
        )
      expect(
        pending.data.some((request) => request.id === offAsked.properties.id),
      ).toBe(true)
      const answered = await client.permission.reply({
        directory: sandbox.project,
        requestID: offAsked.properties.id,
        reply: "once",
      })
      if (answered.error)
        throw new Error(
          `Could not answer toggled-off permission: ${JSON.stringify(answered.error)}`,
        )
      await events.waitFor(
        (event): event is SessionIdle =>
          event.type === "session.idle" &&
          event.properties.sessionID === sessionID,
        { after: offMark, description: "toggled-off session idle" },
      )

      // Toggle back ON: the next request is classified and auto-approved.
      await tui.sendKey("C-M-a")
      await tui.waitForText(/on · session model/)
      await waitFor(
        async () =>
          JSON.parse(await fs.readFile(overridePath, "utf8")).enabled === true,
        { description: "override file to record the re-enable" },
      )

      const onMark = events.mark()
      const onPrompt = await client.session.promptAsync({
        directory: sandbox.project,
        sessionID,
        model: { providerID: "e2e", modelID: "test" },
        parts: [{ type: "text", text: "Run the scripted command once more." }],
      })
      if (onPrompt.error)
        throw new Error(
          `Could not start toggled-on prompt: ${JSON.stringify(onPrompt.error)}`,
        )
      const onAsked = await events.waitFor(
        (event): event is PermissionAsked =>
          event.type === "permission.asked" &&
          event.properties.sessionID === sessionID,
        { after: onMark, description: "toggled-on permission.asked" },
      )
      const onReplied = await events.waitFor(
        (event): event is PermissionReplied =>
          event.type === "permission.replied" &&
          event.properties.sessionID === sessionID,
        { after: onMark, description: "toggled-on permission.replied" },
      )
      expect(onReplied.properties.requestID).toBe(onAsked.properties.id)
      expect(onReplied.properties.reply).toBe("once")
      await events.waitFor(
        (event): event is SessionIdle =>
          event.type === "session.idle" &&
          event.properties.sessionID === sessionID,
        { after: onMark, description: "toggled-on session idle" },
      )
      // The journey's exact classifier total: a late toggled-off call that
      // the user reply above masked would land here and fail the test.
      expect(provider.classifierRequests.length).toBe(1)
    } catch (error) {
      await retainFailure(sandbox, provider, server, events, tui)
      throw error
    }
  })

  test("saves a classifier pin for This session without changing persistent settings", async () => {
    const sandbox = await createSandbox("approve-for-me-tui-model")
    const provider = createScriptedProvider({ command: COMMAND })
    let server: OpenCodeProcess | undefined
    let tui: TmuxTui | undefined
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => server?.stop())
    cleanups.push(async () => tui?.stop())

    try {
      await provider.ready
      await writeProjectConfig(sandbox.project, provider.baseURL, {
        plugins: [AUTO_APPROVE_SERVER_ENTRY],
      })
      const tuiConfig = await writeTuiConfig(sandbox.project, [
        AUTO_APPROVE_TUI_ENTRY,
      ])
      const environment = await sandbox.environment("server")
      if (!environment.XDG_STATE_HOME)
        throw new Error("sandbox omitted XDG_STATE_HOME")
      await blessAutoApproveProjectConfig(
        environment.XDG_STATE_HOME,
        sandbox.project,
      )
      server = await startOpenCode({ cwd: sandbox.project, env: environment })
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: sandbox.project,
      })
      const created = await client.session.create({
        directory: sandbox.project,
        title: "E2E session-scoped model picker",
      })
      if (created.error || !created.data)
        throw new Error(
          `Could not create TUI session: ${JSON.stringify(created.error)}`,
        )
      const sessionID = created.data.id
      tui = await startTmuxTui({
        directory: sandbox.project,
        env: environment,
        serverURL: server.url,
        sessionID,
        tuiConfig,
      })
      await tui.waitForText(/Approve for Me/)

      await runPaletteCommand(
        tui,
        "classifier model",
        "Approve for Me: choose classifier model",
      )
      await pickOption(
        tui,
        "Set classifier model where?",
        "This session",
        "This session",
        "This project",
      )
      await pickOption(
        tui,
        "Approve for Me classifier model",
        "classifier",
        "E2E scripted classifier model",
        "Session model (default)",
      )
      await pickOption(
        tui,
        "Classifier effort (model variant)",
        "boost",
        "boost",
        "Model default",
      )

      const recordPath = sessionModelFile(
        sessionModelDirectory(
          path.join(environment.XDG_STATE_HOME, "opencode"),
        ),
        sessionID,
      )
      await waitFor(
        async () =>
          (await readSessionModel(recordPath, sessionID)).status === "valid",
        { description: "session-scoped classifier record" },
      )
      expect(await readSessionModel(recordPath, sessionID)).toMatchObject({
        status: "valid",
        record: {
          rootSessionID: sessionID,
          mode: "override",
          model: "e2e/classifier",
          variant: "boost",
        },
      })
      await tui.waitForText(/e2e\/classifier\s*·\s*boost\s*·\s*this\s+session/)
      expect(
        await fs.exists(
          autoApproveSettingsFile(sandbox.config, sandbox.project),
        ),
      ).toBe(false)
      expect(await fs.exists(path.join(sandbox.config, "opencode.jsonc"))).toBe(
        false,
      )
    } catch (error) {
      await retainFailure(sandbox, provider, server, undefined, tui)
      throw error
    }
  })

  test("streams prompt activity in the sidebar: approvals fade, surfaced prompts persist", async () => {
    const sandbox = await createSandbox("approve-for-me-tui-feed")
    const provider = createScriptedProvider({ command: COMMAND })
    let server: OpenCodeProcess | undefined
    let events: EventRecorder | undefined
    let tui: TmuxTui | undefined
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => events?.close())
    // Pushed after the server so LIFO cleanup stops the attached TUI first;
    // killing the server under a live TUI leaves it wedged on a dead socket.
    cleanups.push(async () => server?.stop())
    cleanups.push(async () => tui?.stop())

    try {
      await provider.ready
      await writeProjectConfig(sandbox.project, provider.baseURL, {
        plugins: [AUTO_APPROVE_SERVER_ENTRY],
      })
      const tuiConfig = await writeTuiConfig(sandbox.project, [
        AUTO_APPROVE_TUI_ENTRY,
      ])
      const environment = await sandbox.environment("server")
      if (!environment.XDG_STATE_HOME)
        throw new Error("sandbox omitted XDG_STATE_HOME")
      await blessAutoApproveProjectConfig(
        environment.XDG_STATE_HOME,
        sandbox.project,
      )
      server = await startOpenCode({ cwd: sandbox.project, env: environment })
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: sandbox.project,
      })
      events = await EventRecorder.connect(client)
      const created = await client.session.create({
        directory: sandbox.project,
        title: "E2E activity stream",
      })
      if (created.error || !created.data)
        throw new Error(
          `Could not create TUI session: ${JSON.stringify(created.error)}`,
        )
      const sessionID = created.data.id
      tui = await startTmuxTui({
        directory: sandbox.project,
        env: environment,
        serverURL: server.url,
        sessionID,
        tuiConfig,
      })
      await tui.waitForText(/Approve for Me/)
      await tui.waitForText(/on · session model/)

      // --- A classifier approval settles as ✓ and fades out. ----------------
      const approveMark = events.mark()
      const approvePrompt = await client.session.promptAsync({
        directory: sandbox.project,
        sessionID,
        model: { providerID: "e2e", modelID: "test" },
        parts: [
          { type: "text", text: "Run the scripted command exactly once." },
        ],
      })
      if (approvePrompt.error)
        throw new Error(
          `Could not start approve prompt: ${JSON.stringify(approvePrompt.error)}`,
        )
      const approveReplied = await events.waitFor(
        (event): event is PermissionReplied =>
          event.type === "permission.replied" &&
          event.properties.sessionID === sessionID,
        { after: approveMark, description: "stream-journey auto-approval" },
      )
      expect(approveReplied.properties.reply).toBe("once")
      await tui.waitForText("✓ bash: git status")
      // The exit animation: settled approvals leave the sidebar on their own.
      await waitFor(
        async () => !(await tui!.capture()).includes("✓ bash: git status"),
        {
          description: "approved stream item to fade out",
          timeout: 10_000,
        },
      )
      await events.waitFor(
        (event): event is SessionIdle =>
          event.type === "session.idle" &&
          event.properties.sessionID === sessionID,
        { after: approveMark, description: "stream-journey approve idle" },
      )

      // --- A surfaced prompt persists, with the classifier's reason. --------
      provider.setClassifier({
        verdict: {
          decision: "surface",
          risk: "high",
          authorization: "none",
          reason: "scripted surface reason",
        },
      })
      const surfaceMark = events.mark()
      const surfacePrompt = await client.session.promptAsync({
        directory: sandbox.project,
        sessionID,
        model: { providerID: "e2e", modelID: "test" },
        parts: [{ type: "text", text: "Run the scripted command once more." }],
      })
      if (surfacePrompt.error)
        throw new Error(
          `Could not start surface prompt: ${JSON.stringify(surfacePrompt.error)}`,
        )
      const surfaceAsked = await events.waitFor(
        (event): event is PermissionAsked =>
          event.type === "permission.asked" &&
          event.properties.sessionID === sessionID,
        { after: surfaceMark, description: "stream-journey permission.asked" },
      )
      await tui.waitForText("! bash: git status")
      await tui.waitForText("scripted surface reason")
      // Well past the settled-item fade window: an unanswered needs-you item
      // must still be on screen — that persistence is the feature.
      await Bun.sleep(6_000)
      const pane = await tui.capture()
      expect(pane).toContain("! bash: git status")
      expect(pane).toContain("scripted surface reason")

      // Answering settles it: ✗ appears, then the line clears.
      const answered = await client.permission.reply({
        directory: sandbox.project,
        requestID: surfaceAsked.properties.id,
        reply: "reject",
      })
      if (answered.error)
        throw new Error(
          `Could not reject surfaced permission: ${JSON.stringify(answered.error)}`,
        )
      await tui.waitForText("✗ bash: git status")
      await waitFor(
        async () =>
          !(await tui!.capture()).includes("bash: git status --short"),
        {
          description: "settled stream items to clear",
          timeout: 10_000,
        },
      )
      await events.waitFor(
        (event): event is SessionIdle =>
          event.type === "session.idle" &&
          event.properties.sessionID === sessionID,
        { after: surfaceMark, description: "stream-journey surface idle" },
      )
      // The journey's exact classifier total: one approval, one surface.
      expect(provider.classifierRequests.length).toBe(2)
    } catch (error) {
      await retainFailure(sandbox, provider, server, events, tui)
      throw error
    }
  })
})

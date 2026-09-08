import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  createOpencodeClient,
  type Event,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2"
import {
  sessionModelDirectory,
  sessionModelFile,
  writeSessionModel,
} from "../../../plugins/approve-for-me/src/shared"
import { EventRecorder } from "../harness/events"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import {
  AUTO_APPROVE_SERVER_ENTRY,
  autoApproveGlobalSettingsFile,
  autoApproveJournalFile,
  autoApproveSettingsFile,
  blessAutoApproveProjectConfig,
  legacyAutoApproveSettingsFile,
  readJson,
  SERVER_ENTRY,
  storeFile,
  writeAutoApproveSettings,
  writeProjectConfig,
  writeStoreFile,
} from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import {
  createScriptedProvider,
  type ScriptedProvider,
} from "../harness/scripted-provider"
import { waitFor } from "../harness/wait"

/**
 * The approve-for-me trust journeys against the pinned real OpenCode
 * host and the loopback scripted provider. The provider recognizes classifier
 * calls by the plugin's system-prompt marker and answers them with scripted
 * verdicts, so every step is deterministic and free of real model calls.
 */

type PermissionAsked = Extract<Event, { type: "permission.asked" }>
type PermissionReplied = Extract<Event, { type: "permission.replied" }>
type SessionIdle = Extract<Event, { type: "session.idle" }>

const COMMAND = "git status --short"

function clientFor(server: OpenCodeProcess, directory: string): OpencodeClient {
  return createOpencodeClient({ baseUrl: server.url, directory })
}

function isAsked(sessionID: string) {
  return (event: Event): event is PermissionAsked =>
    event.type === "permission.asked" &&
    event.properties.sessionID === sessionID
}

function isReplied(sessionID: string) {
  return (event: Event): event is PermissionReplied =>
    event.type === "permission.replied" &&
    event.properties.sessionID === sessionID
}

function isIdle(sessionID: string) {
  return (event: Event): event is SessionIdle =>
    event.type === "session.idle" && event.properties.sessionID === sessionID
}

async function createSession(
  client: OpencodeClient,
  directory: string,
  title: string,
) {
  const result = await client.session.create({ directory, title })
  if (result.error || !result.data)
    throw new Error(
      `Could not create E2E session: ${JSON.stringify(result.error)}`,
    )
  return result.data.id
}

async function prompt(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
  text = "Run the scripted command exactly once.",
) {
  const result = await client.session.promptAsync({
    directory,
    sessionID,
    model: { providerID: "e2e", modelID: "test" },
    parts: [{ type: "text", text }],
  })
  if (result.error)
    throw new Error(
      `Could not start E2E prompt: ${JSON.stringify(result.error)}`,
    )
}

async function pendingPermissionIds(
  client: OpencodeClient,
  directory: string,
): Promise<string[]> {
  const pending = await client.permission.list({ directory })
  if (pending.error || !pending.data)
    throw new Error(
      `Could not list pending permissions: ${JSON.stringify(pending.error)}`,
    )
  return pending.data.map((request) => request.id)
}

async function replyAsUser(
  client: OpencodeClient,
  directory: string,
  requestID: string,
  reply: "once" | "always" | "reject",
) {
  const result = await client.permission.reply({ directory, requestID, reply })
  if (result.error)
    throw new Error(
      `Could not reply to permission: ${JSON.stringify(result.error)}`,
    )
}

// The classifier session is created, prompted, and deleted per verdict; give
// its background deletion a moment before asserting no leftovers.
async function expectNoClassifierSessions(
  client: OpencodeClient,
  directory: string,
) {
  await waitFor(
    async () => {
      const sessions = await client.session.list({ directory })
      if (sessions.error || !sessions.data) return false
      return sessions.data.every(
        (session) =>
          !session.title?.includes("approve-for-me classifier (throwaway)"),
      )
    },
    { description: "classifier throwaway sessions to be deleted" },
  )
}

async function writeFailureArtifacts(
  sandbox: Sandbox,
  provider: ScriptedProvider | undefined,
  processes: OpenCodeProcess[],
  events: EventRecorder[],
) {
  await Promise.all(
    processes.map((process, index) =>
      process.writeDiagnostics(
        path.join(sandbox.artifacts, `server-${index + 1}`),
      ),
    ),
  )
  await fs.writeFile(
    path.join(sandbox.artifacts, "events.json"),
    `${JSON.stringify(
      events.flatMap((recorder) => recorder.events),
      null,
      2,
    )}\n`,
  )
  await fs.writeFile(
    path.join(sandbox.artifacts, "provider-requests.json"),
    `${JSON.stringify(provider?.requests ?? [], null, 2)}\n`,
  )
  const artifact = await sandbox.preserve("approve-for-me-server")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("approve-for-me against a real OpenCode server", () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("classifies, approves 'once', pins models, and fails closed", async () => {
    const sandbox = await createSandbox("approve-for-me-server")
    const provider = createScriptedProvider({ command: COMMAND })
    const processes: OpenCodeProcess[] = []
    const recorders: EventRecorder[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => {
      for (const recorder of recorders) await recorder.close()
    })
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await provider.ready
      const projectInstructionMarker =
        "PROJECT_INSTRUCTIONS_MUST_NOT_BECOME_CLASSIFIER_POLICY"
      await fs.writeFile(
        path.join(sandbox.project, "AGENTS.md"),
        `Repository context only. ${projectInstructionMarker}\n`,
      )
      await writeProjectConfig(sandbox.project, provider.baseURL, {
        plugins: [AUTO_APPROVE_SERVER_ENTRY],
      })

      const serverEnv = await sandbox.environment("server")
      const configDir = serverEnv.OPENCODE_CONFIG_DIR
      if (!configDir) throw new Error("sandbox omitted OPENCODE_CONFIG_DIR")
      const stateHome = serverEnv.XDG_STATE_HOME
      if (!stateHome) throw new Error("sandbox omitted XDG_STATE_HOME")
      // The project config just written names approve-for-me: record the
      // blessing the TUI's trust command would, or the plugin pauses by
      // design (worktree config is never honored unreviewed).
      await blessAutoApproveProjectConfig(stateHome, sandbox.project)
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: serverEnv,
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      // --- Step A: default settings — approve with the session's model. ---
      const approveSession = await createSession(
        client,
        sandbox.project,
        "E2E auto-approve",
      )
      const approveMark = events.mark()
      await prompt(client, sandbox.project, approveSession)
      const approveAsked = await events.waitFor(isAsked(approveSession), {
        after: approveMark,
        description: "approve-journey permission.asked",
      })
      expect(approveAsked.properties.permission).toBe("bash")
      const approveReplied = await events.waitFor(isReplied(approveSession), {
        after: approveMark,
        description: "auto-approve permission.replied",
      })
      expect(approveReplied.properties.requestID).toBe(
        approveAsked.properties.id,
      )
      // The trust invariant: a classifier approval is "once", never "always".
      expect(approveReplied.properties.reply).toBe("once")
      await events.waitFor(isIdle(approveSession), {
        after: approveMark,
        description: "approve-journey idle",
      })

      expect(provider.classifierRequests.length).toBe(1)
      const firstRequest = provider.classifierRequests[0]
      if (!firstRequest) throw new Error("missing classifier request")
      // Defaulted to the model the asking session is using.
      expect(firstRequest.model).toBe("test")
      // The classifier prompt carried the request and the user's task text.
      const classifierPrompt = JSON.stringify(firstRequest.messages)
      expect(classifierPrompt).toContain("git status --short")
      expect(classifierPrompt).toContain(
        "Run the scripted command exactly once.",
      )
      // Project guidance remains available, but only as user data. The host's
      // inherited AGENTS.md system entry must have been replaced completely.
      expect(classifierPrompt).toContain(projectInstructionMarker)
      const classifierSystem = firstRequest.messages?.filter(
        (message) => message.role === "system",
      )
      expect(JSON.stringify(classifierSystem)).not.toContain(
        projectInstructionMarker,
      )
      expect(JSON.stringify(classifierSystem)).not.toContain(
        "Instructions from:",
      )
      // Nothing was persisted anywhere.
      expect(await fs.exists(storeFile(sandbox.config, sandbox.project))).toBe(
        false,
      )
      await expectNoClassifierSessions(client, sandbox.project)
      // …except the advisory approvals journal, which recorded the approval
      // under the prefix pattern the host itself would remember for "always" —
      // the evidence the enshrine-approvals skill later reads. No rule was
      // granted: the store stayed empty above.
      const journalFile = autoApproveJournalFile(
        path.join(stateHome, "opencode"),
        sandbox.project,
      )
      type Journal = {
        root?: string
        approvals?: Record<string, Record<string, { count?: number }>>
      }
      await waitFor(
        async () => {
          const journal = await readJson<Journal>(journalFile).catch(
            () => undefined,
          )
          return (
            journal?.root === sandbox.project &&
            journal.approvals?.bash?.["git status *"]?.count === 1
          )
        },
        {
          description:
            "the classifier approval to land in the approvals journal",
        },
      )

      // --- Step A2: worktree-local settings cannot re-enable approval. -----
      // A trusted disable (project-keyed file in the config dir) plus a
      // legacy worktree file claiming enabled: the worktree file is ignored
      // (never a settings source) and the disable holds. A retired
      // permissions-approve-for-me.json global file would pause the plugin
      // outright — its own migration path, covered by the pause step below.
      await writeAutoApproveSettings(configDir, sandbox.project, {
        enabled: false,
      })
      const legacyFile = legacyAutoApproveSettingsFile(sandbox.project)
      await fs.mkdir(path.dirname(legacyFile), { recursive: true })
      await fs.writeFile(
        legacyFile,
        JSON.stringify({ enabled: true, model: "e2e/classifier" }),
      )
      const legacySession = await createSession(
        client,
        sandbox.project,
        "E2E untrusted legacy settings",
      )
      const legacyMark = events.mark()
      await prompt(client, sandbox.project, legacySession)
      const legacyAsked = await events.waitFor(isAsked(legacySession), {
        after: legacyMark,
        description: "legacy-settings permission.asked",
      })
      await Bun.sleep(1_500)
      expect(provider.classifierRequests.length).toBe(1)
      expect(await pendingPermissionIds(client, sandbox.project)).toContain(
        legacyAsked.properties.id,
      )
      await replyAsUser(
        client,
        sandbox.project,
        legacyAsked.properties.id,
        "once",
      )
      await events.waitFor(isIdle(legacySession), {
        after: legacyMark,
        description: "legacy-settings idle",
      })
      await fs.rm(legacyFile)

      // --- Step A3: the retired bespoke global file pauses classification. -
      // The A2 disable is cleared FIRST so the pause is the only thing
      // holding classification back — policy in a file this release no
      // longer reads must never be silently dropped, even one that says
      // "enabled".
      await writeAutoApproveSettings(configDir, sandbox.project, {})
      await fs.writeFile(
        autoApproveGlobalSettingsFile(configDir),
        JSON.stringify({ enabled: true }),
      )
      const retiredSession = await createSession(
        client,
        sandbox.project,
        "E2E retired global settings file",
      )
      const retiredMark = events.mark()
      await prompt(client, sandbox.project, retiredSession)
      const retiredAsked = await events.waitFor(isAsked(retiredSession), {
        after: retiredMark,
        description: "retired-global permission.asked",
      })
      await Bun.sleep(1_500)
      expect(provider.classifierRequests.length).toBe(1)
      expect(await pendingPermissionIds(client, sandbox.project)).toContain(
        retiredAsked.properties.id,
      )
      await replyAsUser(
        client,
        sandbox.project,
        retiredAsked.properties.id,
        "once",
      )
      await events.waitFor(isIdle(retiredSession), {
        after: retiredMark,
        description: "retired-global idle",
      })
      await fs.rm(autoApproveGlobalSettingsFile(configDir))

      // --- Step B: a pinned classifier model is used verbatim. -------------
      const settingsFile = await writeAutoApproveSettings(
        configDir,
        sandbox.project,
        { model: "e2e/classifier" },
      )
      // Placement guard, independent of the production path helpers (which
      // the harness reuses and would therefore agree with even if wrong):
      // the settings file the journey just wrote must live under the
      // sandbox's OpenCode config dir and never inside the project an agent
      // can edit — the same outside-project check persist-permissions makes
      // for its store.
      expect(settingsFile.startsWith(configDir + path.sep)).toBe(true)
      expect(
        path.relative(sandbox.project, settingsFile).startsWith(".."),
      ).toBe(true)
      const pinnedSession = await createSession(
        client,
        sandbox.project,
        "E2E pinned classifier",
      )
      const pinnedMark = events.mark()
      await prompt(client, sandbox.project, pinnedSession)
      const pinnedReplied = await events.waitFor(isReplied(pinnedSession), {
        after: pinnedMark,
        description: "pinned-model permission.replied",
      })
      expect(pinnedReplied.properties.reply).toBe("once")
      await events.waitFor(isIdle(pinnedSession), {
        after: pinnedMark,
        description: "pinned-model idle",
      })
      expect(provider.classifierRequests.length).toBe(2)
      const secondRequest = provider.classifierRequests[1]
      if (!secondRequest) throw new Error("missing classifier request")
      expect(secondRequest.model).toBe("classifier")
      // No variant pinned: the marker option must not leak into the call.
      expect(
        (provider.classifierRequests[1] as Record<string, unknown>)
          .scripted_marker,
      ).toBeUndefined()

      // --- Step B2: a pinned variant is applied by the host. ---------------
      await writeAutoApproveSettings(configDir, sandbox.project, {
        model: "e2e/classifier",
        variant: "boost",
      })
      const variantSession = await createSession(
        client,
        sandbox.project,
        "E2E pinned variant",
      )
      const variantMark = events.mark()
      await prompt(client, sandbox.project, variantSession)
      const variantReplied = await events.waitFor(isReplied(variantSession), {
        after: variantMark,
        description: "pinned-variant permission.replied",
      })
      expect(variantReplied.properties.reply).toBe("once")
      await events.waitFor(isIdle(variantSession), {
        after: variantMark,
        description: "pinned-variant idle",
      })
      expect(provider.classifierRequests.length).toBe(3)
      const thirdRequest = provider.classifierRequests[2]
      if (!thirdRequest) throw new Error("missing classifier request")
      expect(thirdRequest.model).toBe("classifier")
      // The variant's option reached the provider request: the classifier
      // really judged at the configured effort, not the model default.
      expect(
        (provider.classifierRequests[2] as Record<string, unknown>)
          .scripted_marker,
      ).toBe("variant-boost")

      // --- Step B3: a variant the model lacks pauses — no model call. ------
      // The host would silently ignore it and judge at default effort, so
      // the plugin leaves the prompt for the user instead.
      await writeAutoApproveSettings(configDir, sandbox.project, {
        model: "e2e/classifier",
        variant: "warp",
      })
      const missingVariantSession = await createSession(
        client,
        sandbox.project,
        "E2E missing variant",
      )
      const missingVariantMark = events.mark()
      await prompt(client, sandbox.project, missingVariantSession)
      const missingVariantAsked = await events.waitFor(
        isAsked(missingVariantSession),
        {
          after: missingVariantMark,
          description: "missing-variant permission.asked",
        },
      )
      await Bun.sleep(1_500)
      expect(provider.classifierRequests.length).toBe(3)
      expect(await pendingPermissionIds(client, sandbox.project)).toContain(
        missingVariantAsked.properties.id,
      )
      await replyAsUser(
        client,
        sandbox.project,
        missingVariantAsked.properties.id,
        "once",
      )
      await events.waitFor(isIdle(missingVariantSession), {
        after: missingVariantMark,
        description: "missing-variant idle",
      })
      await fs.rm(autoApproveSettingsFile(configDir, sandbox.project))

      // --- Step C: a surface verdict leaves the prompt for the user. -------
      provider.setClassifier({
        verdict: {
          decision: "surface",
          risk: "high",
          authorization: "none",
          reason: "scripted refusal",
        },
      })
      const surfaceSession = await createSession(
        client,
        sandbox.project,
        "E2E surface verdict",
      )
      const surfaceMark = events.mark()
      await prompt(client, sandbox.project, surfaceSession)
      const surfaceAsked = await events.waitFor(isAsked(surfaceSession), {
        after: surfaceMark,
        description: "surface-journey permission.asked",
      })
      await waitFor(() => provider.classifierRequests.length >= 4, {
        description: "surface-journey classifier request",
      })
      // Give a wrong auto-reply every chance to land before asserting.
      await Bun.sleep(1_500)
      expect(await pendingPermissionIds(client, sandbox.project)).toContain(
        surfaceAsked.properties.id,
      )
      await replyAsUser(
        client,
        sandbox.project,
        surfaceAsked.properties.id,
        "once",
      )
      await events.waitFor(isIdle(surfaceSession), {
        after: surfaceMark,
        description: "surface-journey idle",
      })

      // --- Step C2: a model approve the matrix forbids is overridden. -------
      // High risk with merely implied authorization is a forbidden matrix
      // cell: the model's own "approve" must not carry it. The enforcement is
      // plugin code, not model obedience — asserted here against the real
      // host so no prompt-level regression can silently re-open the cell.
      provider.setClassifier({
        verdict: {
          decision: "approve",
          risk: "high",
          authorization: "implied",
          reason: "scripted overreach",
        },
      })
      const overreachSession = await createSession(
        client,
        sandbox.project,
        "E2E matrix-forbidden approve",
      )
      const overreachMark = events.mark()
      await prompt(client, sandbox.project, overreachSession)
      const overreachAsked = await events.waitFor(isAsked(overreachSession), {
        after: overreachMark,
        description: "matrix-override permission.asked",
      })
      await waitFor(() => provider.classifierRequests.length >= 5, {
        description: "matrix-override classifier request",
      })
      await Bun.sleep(1_500)
      expect(await pendingPermissionIds(client, sandbox.project)).toContain(
        overreachAsked.properties.id,
      )
      await replyAsUser(
        client,
        sandbox.project,
        overreachAsked.properties.id,
        "once",
      )
      await events.waitFor(isIdle(overreachSession), {
        after: overreachMark,
        description: "matrix-override idle",
      })

      // --- Step D: an unparseable verdict fails closed. ---------------------
      provider.setClassifier({
        rawText: "I refuse to answer in the requested format.",
      })
      const garbageSession = await createSession(
        client,
        sandbox.project,
        "E2E unparseable verdict",
      )
      const garbageMark = events.mark()
      await prompt(client, sandbox.project, garbageSession)
      const garbageAsked = await events.waitFor(isAsked(garbageSession), {
        after: garbageMark,
        description: "unparseable-verdict permission.asked",
      })
      await waitFor(() => provider.classifierRequests.length >= 6, {
        description: "unparseable-verdict classifier request",
      })
      await Bun.sleep(1_500)
      expect(await pendingPermissionIds(client, sandbox.project)).toContain(
        garbageAsked.properties.id,
      )
      await replyAsUser(
        client,
        sandbox.project,
        garbageAsked.properties.id,
        "once",
      )
      await events.waitFor(isIdle(garbageSession), {
        after: garbageMark,
        description: "unparseable-verdict idle",
      })

      // --- Step D2: a classifier endpoint failure fails closed. -------------
      // The scripted endpoint answers the classifier call with an HTTP error
      // (400: statuses the model SDK would retry would blur the exact call
      // counts below). The request ends undecided — the plugin must not
      // reply — and the user's own answer then wins as usual.
      provider.setClassifier({ status: 400 })
      const failedSession = await createSession(
        client,
        sandbox.project,
        "E2E classifier endpoint failure",
      )
      const failedMark = events.mark()
      await prompt(client, sandbox.project, failedSession)
      const failedAsked = await events.waitFor(isAsked(failedSession), {
        after: failedMark,
        description: "classifier-failure permission.asked",
      })
      await waitFor(() => provider.classifierRequests.length >= 7, {
        description: "classifier-failure classifier request",
      })
      await Bun.sleep(1_500)
      expect(await pendingPermissionIds(client, sandbox.project)).toContain(
        failedAsked.properties.id,
      )
      await replyAsUser(
        client,
        sandbox.project,
        failedAsked.properties.id,
        "once",
      )
      await events.waitFor(isIdle(failedSession), {
        after: failedMark,
        description: "classifier-failure idle",
      })

      // --- Step E: an explicit ask carve-out vetoes without a model call. --
      provider.setClassifier({
        verdict: {
          decision: "approve",
          risk: "low",
          authorization: "implied",
          reason: "must never be consulted",
        },
      })
      await writeStoreFile(sandbox.config, sandbox.project, {
        permission: { bash: { "git status *": "ask" } },
      })
      const vetoSession = await createSession(
        client,
        sandbox.project,
        "E2E carve-out veto",
      )
      const vetoMark = events.mark()
      const classifierCallsBeforeVeto = provider.classifierRequests.length
      await prompt(client, sandbox.project, vetoSession)
      const vetoAsked = await events.waitFor(isAsked(vetoSession), {
        after: vetoMark,
        description: "veto-journey permission.asked",
      })
      await Bun.sleep(1_500)
      expect(provider.classifierRequests.length).toBe(classifierCallsBeforeVeto)
      expect(await pendingPermissionIds(client, sandbox.project)).toContain(
        vetoAsked.properties.id,
      )
      await replyAsUser(
        client,
        sandbox.project,
        vetoAsked.properties.id,
        "once",
      )
      await events.waitFor(isIdle(vetoSession), {
        after: vetoMark,
        description: "veto-journey idle",
      })

      // The journey's exact classifier total, one per classified step (A, B,
      // B2, C, C2, D, D2). The absence steps above assert with a fixed sleep,
      // so a classification that started late — masked there by the user
      // reply aborting it — would only show up here, as a count of eight.
      expect(provider.classifierRequests.length).toBe(7)
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, processes, recorders)
      throw error
    }
  })

  test("approves a harmless external read and its directory boundary once", async () => {
    const sandbox = await createSandbox("approve-for-me-external-directory")
    const fixture = path.join(sandbox.home, "harmless-external-read.txt")
    const provider = createScriptedProvider({
      tool: { tool: "read", arguments: { filePath: fixture } },
      maxToolCalls: 1,
    })
    const processes: OpenCodeProcess[] = []
    const recorders: EventRecorder[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => {
      for (const recorder of recorders) await recorder.close()
    })
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await provider.ready
      await fs.writeFile(fixture, "harmless external fixture\n")
      await writeProjectConfig(sandbox.project, provider.baseURL, {
        plugins: [AUTO_APPROVE_SERVER_ENTRY],
        permission: { read: "ask", external_directory: "ask" },
      })

      const serverEnv = await sandbox.environment("server")
      const stateHome = serverEnv.XDG_STATE_HOME
      if (!stateHome) throw new Error("sandbox omitted XDG_STATE_HOME")
      await blessAutoApproveProjectConfig(stateHome, sandbox.project)
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: serverEnv,
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      const session = await createSession(
        client,
        sandbox.project,
        "E2E external read approval",
      )
      const mark = events.mark()
      await prompt(
        client,
        sandbox.project,
        session,
        "Read the scripted harmless external fixture once.",
      )
      await events.waitFor(isIdle(session), {
        after: mark,
        description: "external-read approval idle",
      })

      const asked = events.events.slice(mark).filter(isAsked(session))
      expect(asked.map((event) => event.properties.permission).sort()).toEqual([
        "external_directory",
        "read",
      ])
      const replied = events.events.slice(mark).filter(isReplied(session))
      expect(replied).toHaveLength(2)
      expect(replied.map((event) => event.properties.reply)).toEqual([
        "once",
        "once",
      ])
      expect(replied.map((event) => event.properties.requestID).sort()).toEqual(
        asked.map((event) => event.properties.id).sort(),
      )

      expect(provider.classifierRequests).toHaveLength(2)
      const classifierPrompts = provider.classifierRequests.map((request) =>
        JSON.stringify(request.messages),
      )
      expect(
        classifierPrompts.some((prompt) =>
          prompt.includes("tool: external_directory"),
        ),
      ).toBe(true)
      expect(
        classifierPrompts.some((prompt) => prompt.includes("tool: read")),
      ).toBe(true)
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, processes, recorders)
      throw error
    }
  })

  test("keeps a reserved OpenCode config read manual without classification", async () => {
    const sandbox = await createSandbox(
      "approve-for-me-reserved-external-directory",
    )
    const fixture = path.join(sandbox.config, "reserved-external-read.txt")
    const provider = createScriptedProvider({
      tool: { tool: "read", arguments: { filePath: fixture } },
      maxToolCalls: 1,
    })
    const processes: OpenCodeProcess[] = []
    const recorders: EventRecorder[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => {
      for (const recorder of recorders) await recorder.close()
    })
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await provider.ready
      await fs.writeFile(fixture, "synthetic reserved-path fixture\n")
      await writeProjectConfig(sandbox.project, provider.baseURL, {
        plugins: [AUTO_APPROVE_SERVER_ENTRY],
        permission: { read: "ask", external_directory: "ask" },
      })

      const serverEnv = await sandbox.environment("server")
      const stateHome = serverEnv.XDG_STATE_HOME
      if (!stateHome) throw new Error("sandbox omitted XDG_STATE_HOME")
      await blessAutoApproveProjectConfig(stateHome, sandbox.project)
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: serverEnv,
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      const session = await createSession(
        client,
        sandbox.project,
        "E2E reserved external read",
      )
      const mark = events.mark()
      await prompt(
        client,
        sandbox.project,
        session,
        "Attempt the scripted read from the reserved OpenCode config path.",
      )

      const asked: PermissionAsked[] = []
      for (const reply of ["once", "reject"] as const) {
        const request = await events.waitFor(
          (event): event is PermissionAsked =>
            isAsked(session)(event) &&
            !asked.some((seen) => seen.properties.id === event.properties.id),
          {
            after: mark,
            description: "reserved-path manual permission.asked",
          },
        )
        asked.push(request)

        // Either host prompt may arrive first. Both must stay pending without
        // consulting the classifier; allow the first only so the second can
        // surface, then reject the second to finish the tool call.
        await Bun.sleep(1_500)
        expect(provider.classifierRequests).toHaveLength(0)
        expect(await pendingPermissionIds(client, sandbox.project)).toContain(
          request.properties.id,
        )
        await replyAsUser(client, sandbox.project, request.properties.id, reply)
      }

      await events.waitFor(isIdle(session), {
        after: mark,
        description: "reserved external-read session idle",
      })
      expect(asked.map((event) => event.properties.permission).sort()).toEqual([
        "external_directory",
        "read",
      ])
      const replied = events.events.slice(mark).filter(isReplied(session))
      expect(replied.map((event) => event.properties.requestID)).toEqual(
        asked.map((event) => event.properties.id),
      )
      expect(replied.map((event) => event.properties.reply)).toEqual([
        "once",
        "reject",
      ])
      expect(provider.classifierRequests).toHaveLength(0)
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, processes, recorders)
      throw error
    }
  })

  test("composes with persist-permissions: user decisions persist, classifier decisions never do", async () => {
    const sandbox = await createSandbox("approve-for-me-coinstall")
    const provider = createScriptedProvider({ command: COMMAND })
    const processes: OpenCodeProcess[] = []
    const recorders: EventRecorder[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => {
      for (const recorder of recorders) await recorder.close()
    })
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await provider.ready
      await writeProjectConfig(sandbox.project, provider.baseURL, {
        plugins: [SERVER_ENTRY, AUTO_APPROVE_SERVER_ENTRY],
      })
      await writeStoreFile(sandbox.config, sandbox.project, {
        permission: { bash: { "git status *": "allow" } },
      })

      const serverEnv = await sandbox.environment("server")
      if (!serverEnv.XDG_STATE_HOME)
        throw new Error("sandbox omitted XDG_STATE_HOME")
      await blessAutoApproveProjectConfig(
        serverEnv.XDG_STATE_HOME,
        sandbox.project,
      )
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: serverEnv,
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      // --- Step A: a store-allowed request is persist-permissions' turf. ---
      const storedSession = await createSession(
        client,
        sandbox.project,
        "E2E store allow",
      )
      const storedMark = events.mark()
      await prompt(client, sandbox.project, storedSession)
      const storedReplied = await events.waitFor(isReplied(storedSession), {
        after: storedMark,
        description: "persist-permissions auto reply",
      })
      // persist-permissions replies "once" even for a fully covered rule;
      // Approve for Me stands down entirely: no classifier call was made.
      expect(storedReplied.properties.reply).toBe("once")
      await events.waitFor(isIdle(storedSession), {
        after: storedMark,
        description: "store-allow idle",
      })
      expect(provider.classifierRequests.length).toBe(0)

      // --- Step B: a classifier approval must never enter the store. -------
      provider.setCommand("git rev-parse --is-inside-work-tree")
      const approvedSession = await createSession(
        client,
        sandbox.project,
        "E2E classifier approval",
      )
      const approvedMark = events.mark()
      await prompt(client, sandbox.project, approvedSession)
      const approvedAsked = await events.waitFor(isAsked(approvedSession), {
        after: approvedMark,
        description: "classifier-approval permission.asked",
      })
      const approvedReplied = await events.waitFor(isReplied(approvedSession), {
        after: approvedMark,
        description: "classifier-approval permission.replied",
      })
      expect(approvedReplied.properties.requestID).toBe(
        approvedAsked.properties.id,
      )
      expect(approvedReplied.properties.reply).toBe("once")
      await events.waitFor(isIdle(approvedSession), {
        after: approvedMark,
        description: "classifier-approval idle",
      })
      expect(provider.classifierRequests.length).toBe(1)
      // The store still holds exactly the user's one rule.
      expect(
        await readJson<{ permission: { bash: Record<string, string> } }>(
          storeFile(sandbox.config, sandbox.project),
        ),
      ).toEqual({
        permission: { bash: { "git status *": "allow" } },
      })

      // --- Step C: a real user "always" still persists. ---------------------
      provider.setClassifier({
        verdict: {
          decision: "surface",
          risk: "high",
          authorization: "none",
          reason: "let the user decide",
        },
      })
      provider.setCommand("git log --oneline -n 1")
      const userSession = await createSession(
        client,
        sandbox.project,
        "E2E user always",
      )
      const userMark = events.mark()
      await prompt(client, sandbox.project, userSession)
      const userAsked = await events.waitFor(isAsked(userSession), {
        after: userMark,
        description: "user-always permission.asked",
      })
      await waitFor(() => provider.classifierRequests.length >= 2, {
        description: "user-always classifier request",
      })
      await Bun.sleep(1_500)
      expect(await pendingPermissionIds(client, sandbox.project)).toContain(
        userAsked.properties.id,
      )
      await replyAsUser(
        client,
        sandbox.project,
        userAsked.properties.id,
        "always",
      )
      await events.waitFor(isIdle(userSession), {
        after: userMark,
        description: "user-always idle",
      })
      await waitFor(
        async () =>
          JSON.stringify(
            await readJson(storeFile(sandbox.config, sandbox.project)),
          ).includes("git log *"),
        {
          description: "user always-approval persisted by persist-permissions",
        },
      )
      expect(
        await readJson<{ permission: { bash: Record<string, string> } }>(
          storeFile(sandbox.config, sandbox.project),
        ),
      ).toEqual({
        permission: { bash: { "git status *": "allow", "git log *": "allow" } },
      })

      // The journey's exact classifier total (steps B and C): a late call
      // from the store-allowed step A would fail the test here.
      expect(provider.classifierRequests.length).toBe(2)
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, processes, recorders)
      throw error
    }
  })

  test("uses a trusted session model only for its root session", async () => {
    const sandbox = await createSandbox("approve-for-me-session-model")
    const provider = createScriptedProvider({ command: COMMAND })
    const processes: OpenCodeProcess[] = []
    const recorders: EventRecorder[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => {
      for (const recorder of recorders) await recorder.close()
    })
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await provider.ready
      await writeProjectConfig(sandbox.project, provider.baseURL, {
        plugins: [AUTO_APPROVE_SERVER_ENTRY],
      })
      const serverEnv = await sandbox.environment("server")
      if (!serverEnv.XDG_STATE_HOME)
        throw new Error("sandbox omitted XDG_STATE_HOME")
      await blessAutoApproveProjectConfig(
        serverEnv.XDG_STATE_HOME,
        sandbox.project,
      )
      // The second root must prove that a record for the first does not leak
      // into the project's durable classifier setting.
      await writeAutoApproveSettings(sandbox.config, sandbox.project, {
        model: "e2e/test",
      })
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: serverEnv,
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      const sessionPinned = await createSession(
        client,
        sandbox.project,
        "E2E session-scoped classifier",
      )
      const sessionPersistent = await createSession(
        client,
        sandbox.project,
        "E2E persistent classifier",
      )
      await writeSessionModel(
        sessionModelFile(
          sessionModelDirectory(
            path.join(serverEnv.XDG_STATE_HOME, "opencode"),
          ),
          sessionPinned,
        ),
        {
          version: 1,
          rootSessionID: sessionPinned,
          revision: "e2e-session-model",
          mode: "override",
          model: "e2e/classifier",
          variant: "boost",
        },
      )

      const pinnedMark = events.mark()
      await prompt(client, sandbox.project, sessionPinned)
      await events.waitFor(isReplied(sessionPinned), {
        after: pinnedMark,
        description: "session-pinned classifier reply",
      })
      await events.waitFor(isIdle(sessionPinned), {
        after: pinnedMark,
        description: "session-pinned classifier idle",
      })

      const persistentMark = events.mark()
      await prompt(client, sandbox.project, sessionPersistent)
      await events.waitFor(isReplied(sessionPersistent), {
        after: persistentMark,
        description: "persistent classifier reply",
      })
      await events.waitFor(isIdle(sessionPersistent), {
        after: persistentMark,
        description: "persistent classifier idle",
      })

      expect(provider.classifierRequests).toHaveLength(2)
      expect(provider.classifierRequests[0]?.model).toBe("classifier")
      expect(
        (provider.classifierRequests[0] as Record<string, unknown>)
          .scripted_marker,
      ).toBe("variant-boost")
      expect(provider.classifierRequests[1]?.model).toBe("test")
      expect(
        (provider.classifierRequests[1] as Record<string, unknown>)
          .scripted_marker,
      ).toBeUndefined()
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, processes, recorders)
      throw error
    }
  })
})

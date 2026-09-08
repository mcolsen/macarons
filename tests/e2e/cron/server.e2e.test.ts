import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  createOpencodeClient,
  type Event,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2"
import { EventRecorder } from "../harness/events"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import { CRON_SERVER_ENTRY, writeProjectConfig } from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import {
  type ChatCompletionRequest,
  createScriptedProvider,
  type ScriptedProvider,
} from "../harness/scripted-provider"
import { waitFor } from "../harness/wait"

/**
 * End-to-end: the scripted provider plays an agent that calls cron_create /
 * cron_list, against a real OpenCode server loading the real plugin. The
 * schedule test rides a genuine minute boundary ("* * * * *" one-shot), so it
 * spends up to ~60s waiting for the fire — that wait IS the feature.
 */

const SCHEDULE_TRIGGER = "Schedule my reminder now."
const LIST_TRIGGER = "List the cron jobs."
const FIRED_PROMPT = "CRON FIRED: summarize the deploy status."
const FIRE_TIMEOUT_MS = 90_000

type SessionIdle = Extract<Event, { type: "session.idle" }>
type PermissionAsked = Extract<Event, { type: "permission.asked" }>

const isIdle =
  (sessionID: string) =>
  (event: Event): event is SessionIdle =>
    event.type === "session.idle" && event.properties.sessionID === sessionID

const isAsked =
  (sessionID: string) =>
  (event: Event): event is PermissionAsked =>
    event.type === "permission.asked" &&
    event.properties.sessionID === sessionID

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

// Content of every message with the given role, flattened to plain text.
function textOf(request: ChatCompletionRequest, role: string): string[] {
  const messages = Array.isArray(request.messages) ? request.messages : []
  return messages
    .filter((message) => message.role === role)
    .map((message) => {
      const content = (message as { content?: unknown }).content
      if (typeof content === "string") return content
      if (Array.isArray(content)) {
        return content
          .map((part) =>
            part && typeof part === "object"
              ? String((part as { text?: unknown }).text ?? "")
              : "",
          )
          .join("")
      }
      return ""
    })
}

const toolText = (request: ChatCompletionRequest) =>
  textOf(request, "tool").join("\n")

function cronToolScript(lastUserText: string) {
  if (lastUserText.includes(SCHEDULE_TRIGGER)) {
    return {
      tool: "cron_create",
      arguments: { cron: "* * * * *", prompt: FIRED_PROMPT, recurring: false },
    }
  }
  if (lastUserText.includes(LIST_TRIGGER)) {
    return { tool: "cron_list", arguments: {} }
  }
  return undefined
}

async function writeArtifacts(
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
  const artifact = await sandbox.preserve("cron-server")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("cron against a real OpenCode server", () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("an approved one-shot fires into its own session at the minute boundary, then deletes itself", async () => {
    const sandbox = await createSandbox("cron-server")
    const provider = createScriptedProvider({ toolCall: cronToolScript })
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
        plugins: [CRON_SERVER_ENTRY],
      })
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("cron"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      const session = await createSession(
        client,
        sandbox.project,
        "E2E cron schedule",
      )
      const createMark = events.mark()
      await prompt(client, sandbox.project, session, SCHEDULE_TRIGGER)

      // cron_create routes through the permission system before storing.
      const asked = await events.waitFor(isAsked(session), {
        after: createMark,
        description: "cron permission.asked",
      })
      expect(asked.properties.permission).toBe("cron")
      expect(asked.properties.patterns).toEqual([FIRED_PROMPT])
      const metadata = (
        asked.properties as {
          metadata?: { cron?: unknown; recurring?: unknown }
        }
      ).metadata
      expect(metadata?.cron).toBe("* * * * *")
      expect(metadata?.recurring).toBe(false)

      const reply = await client.permission.reply({
        directory: sandbox.project,
        requestID: asked.properties.id,
        reply: "once",
      })
      if (reply.error)
        throw new Error(
          `Could not approve permission: ${JSON.stringify(reply.error)}`,
        )
      await events.waitFor(isIdle(session), {
        after: createMark,
        description: "schedule turn idle",
      })

      // The model read the job confirmation in its tool result.
      await waitFor(
        () =>
          provider.requests.some((request) =>
            toolText(request).includes("Created cron job"),
          ),
        {
          description: "cron_create tool result reaching the scripted provider",
        },
      )

      // The fire: the job's prompt arrives as a genuine user turn in the same
      // session — the provider sees it as the newest user message, and the
      // session's own history gains it.
      const fireMark = events.mark()
      await waitFor(
        () =>
          provider.requests.some((request) =>
            textOf(request, "user").some((text) => text.includes(FIRED_PROMPT)),
          ),
        {
          description: "cron fire prompting the session",
          timeout: FIRE_TIMEOUT_MS,
          interval: 250,
        },
      )
      await events.waitFor(isIdle(session), {
        after: fireMark,
        description: "fired turn idle",
      })

      const messages = await client.session.messages({
        sessionID: session,
        directory: sandbox.project,
      })
      const firedAsUserTurn = (messages.data ?? []).some((entry) => {
        const info = (entry as { info?: { role?: string } }).info
        const parts =
          (entry as { parts?: Array<{ type?: string; text?: string }> })
            .parts ?? []
        return (
          info?.role === "user" &&
          parts.some(
            (part) =>
              part.type === "text" &&
              typeof part.text === "string" &&
              part.text.includes(FIRED_PROMPT),
          )
        )
      })
      expect(firedAsUserTurn).toBe(true)

      // One-shot cleanup: a scripted cron_list turn reports the store empty.
      const listMark = events.mark()
      await prompt(client, sandbox.project, session, LIST_TRIGGER)
      await events.waitFor(isIdle(session), {
        after: listMark,
        description: "list turn idle",
      })
      await waitFor(
        () =>
          provider.requests.some((request) =>
            toolText(request).includes("No cron jobs"),
          ),
        {
          description:
            "empty cron_list tool result reaching the scripted provider",
        },
      )
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes, recorders)
      throw error
    }
  })

  test("a rejected cron permission schedules nothing", async () => {
    const sandbox = await createSandbox("cron-deny")
    const provider = createScriptedProvider({ toolCall: cronToolScript })
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
        plugins: [CRON_SERVER_ENTRY],
      })
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("cron-deny"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      const session = await createSession(
        client,
        sandbox.project,
        "E2E cron deny",
      )
      const denyMark = events.mark()
      await prompt(client, sandbox.project, session, SCHEDULE_TRIGGER)
      const asked = await events.waitFor(isAsked(session), {
        after: denyMark,
        description: "cron permission.asked",
      })
      expect(asked.properties.permission).toBe("cron")

      const reply = await client.permission.reply({
        directory: sandbox.project,
        requestID: asked.properties.id,
        reply: "reject",
      })
      if (reply.error)
        throw new Error(
          `Could not reject permission: ${JSON.stringify(reply.error)}`,
        )
      await events.waitFor(isIdle(session), {
        after: denyMark,
        description: "denied turn idle",
      })

      // No job was stored: the plugin answers a follow-up cron_list turn with
      // an empty store, and no "Created cron job" result ever reached the model.
      const listMark = events.mark()
      await prompt(client, sandbox.project, session, LIST_TRIGGER)
      await events.waitFor(isIdle(session), {
        after: listMark,
        description: "list turn idle",
      })
      await waitFor(
        () =>
          provider.requests.some((request) =>
            toolText(request).includes("No cron jobs"),
          ),
        {
          description:
            "empty cron_list tool result reaching the scripted provider",
        },
      )
      expect(
        provider.requests.some((request) =>
          toolText(request).includes("Created cron job"),
        ),
      ).toBe(false)
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes, recorders)
      throw error
    }
  })

  test("an explicit cron allow rule overrides the plugin's injected ask default", async () => {
    const sandbox = await createSandbox("cron-allow")
    const provider = createScriptedProvider({ toolCall: cronToolScript })
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
        plugins: [CRON_SERVER_ENTRY],
        permission: { cron: "allow" },
      })
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("cron-allow"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      const session = await createSession(
        client,
        sandbox.project,
        "E2E cron allow",
      )
      const mark = events.mark()
      await prompt(client, sandbox.project, session, SCHEDULE_TRIGGER)
      await events.waitFor(isIdle(session), {
        after: mark,
        description: "allowed schedule turn idle",
      })

      // The job was created without a single permission prompt.
      await waitFor(
        () =>
          provider.requests.some((request) =>
            toolText(request).includes("Created cron job"),
          ),
        {
          description: "cron_create tool result reaching the scripted provider",
        },
      )
      expect(events.events.slice(mark).some(isAsked(session))).toBe(false)
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes, recorders)
      throw error
    }
  })
})

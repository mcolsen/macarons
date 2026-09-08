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
import {
  type ChatCompletionRequest,
  type ChatMessage,
  createProgrammableProvider,
  type ProgrammableProvider,
} from "../harness/programmable-provider"
import { writeSubagentCommsConfig } from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import { waitFor } from "../harness/wait"

// End-to-end against a real, version-pinned OpenCode.
//
// Scenario 1: the fake model spawns a subagent with the BUILTIN task tool,
// then (told the child's id) messages it with subagent_send — proving the
// plugin's addressing accepts stock-spawned children and that the child's
// second reply comes back through the send tool's result.
//
// Scenario 2: the parent discovers the current provider catalog, then starts a
// background subagent on its alternate model/variant. The child works while
// the parent idles, and its completion note reaches the parent as a REAL turn.
//
// Scenario 3: the full lifecycle against a GENUINELY BUSY child. A background
// spawn leaves the child sleeping in a bash step; subagent_send then steers it
// MID-RUN (the send result carries the merged-into-run wording, so the busy
// path — high-counter message ordering included — really executed against the
// host), subagent_wait on the now-idle child returns its latest completed
// reply (the explicit-idle collection path), subagent_list shows it idle, and
// subagent_kill on the idle child declines as a friendly no-op.

type SessionIdle = Extract<Event, { type: "session.idle" }>
const isIdle =
  (sessionID: string) =>
  (event: Event): event is SessionIdle =>
    event.type === "session.idle" && event.properties.sessionID === sessionID

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

/** Direct children via the V1 route (the v2 client has no wrapper for it). */
async function childrenOf(
  server: OpenCodeProcess,
  directory: string,
  sessionID: string,
): Promise<Array<{ id: string }>> {
  const response = await fetch(
    `${server.url}/session/${sessionID}/children?directory=${encodeURIComponent(directory)}`,
  )
  if (!response.ok) throw new Error(`children route failed: ${response.status}`)
  return (await response.json()) as Array<{ id: string }>
}

function textOf(message: ChatMessage): string {
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
}

function lastUserText(request: ChatCompletionRequest): string {
  const messages = Array.isArray(request.messages) ? request.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "user") return textOf(message)
  }
  return ""
}

function userText(request: ChatCompletionRequest): string {
  const messages = Array.isArray(request.messages) ? request.messages : []
  return messages
    .filter((message) => message.role === "user")
    .map(textOf)
    .join("\n")
}

function toolResultTexts(request: ChatCompletionRequest): string[] {
  const messages = Array.isArray(request.messages) ? request.messages : []
  return messages.filter((message) => message.role === "tool").map(textOf)
}

async function writeArtifacts(
  sandbox: Sandbox,
  provider: ProgrammableProvider,
  processes: OpenCodeProcess[],
) {
  await Promise.all(
    processes.map((process, index) =>
      process.writeDiagnostics(
        path.join(sandbox.artifacts, `server-${index + 1}`),
      ),
    ),
  )
  await fs.writeFile(
    path.join(sandbox.artifacts, "provider-requests.json"),
    `${JSON.stringify(provider.requests, null, 2)}\n`,
  )
  const artifact = await sandbox.preserve("subagent-comms-server")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("subagent-comms against a real OpenCode server", () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("subagent_send steers a child the builtin task tool spawned and returns its fresh reply", async () => {
    const sandbox = await createSandbox("subagent-comms-send")
    const provider = createProgrammableProvider({
      respond(context) {
        const ask = lastUserText(context.request)
        if (ask.includes("Say the magic word"))
          return { kind: "text", text: "CHILD-REPLY-ONE" }
        if (ask.includes("How about the tests"))
          return { kind: "text", text: "CHILD-REPLY-TWO" }
        if (ask.includes("SEND:")) {
          if (context.hasToolResultAfterLastUser())
            return { kind: "text", text: "PARENT-DONE-TWO" }
          const childID =
            /SEND:(ses_[0-9A-Za-z]+)/.exec(ask)?.[1] ?? "ses_missing"
          return {
            kind: "tool_call",
            name: "subagent_send",
            args: { session_id: childID, message: "How about the tests?" },
          }
        }
        if (ask.includes("Spawn a subagent")) {
          if (context.hasToolResultAfterLastUser())
            return { kind: "text", text: "PARENT-DONE-ONE" }
          return {
            kind: "tool_call",
            name: "task",
            args: {
              description: "magic word task",
              prompt: "Say the magic word.",
              subagent_type: "general",
            },
          }
        }
        return { kind: "text", text: "OK" }
      },
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
      await writeSubagentCommsConfig(sandbox.project, provider.baseURL)
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("subagent-comms-send"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      const session = await createSession(
        client,
        sandbox.project,
        "Subagent send session",
      )
      const firstTurn = events.mark()
      await prompt(client, sandbox.project, session, "Spawn a subagent now.")
      await events.waitFor(isIdle(session), {
        after: firstTurn,
        description: "parent idle after the task turn",
      })

      const children = await childrenOf(server, sandbox.project, session)
      expect(children).toHaveLength(1)
      const childID = children[0]!.id
      expect(childID).toMatch(/^ses_/)

      const secondTurn = events.mark()
      await prompt(
        client,
        sandbox.project,
        session,
        `Now message that subagent. SEND:${childID}`,
      )
      await events.waitFor(isIdle(session), {
        after: secondTurn,
        description: "parent idle after the send turn",
      })

      // The send blocked, steered the child, and returned the child's second
      // reply inside a stock-style task block — visible to the model as the
      // send's own tool-result message. (The request history also carries turn
      // 1's task result with the FIRST reply, so assert on the send's message
      // alone.)
      const sendResult = provider.requests
        .flatMap(toolResultTexts)
        .find((text) => text.includes("CHILD-REPLY-TWO"))
      expect(sendResult).toBeDefined()
      expect(sendResult).toContain(`<task id="${childID}" state="completed">`)
      expect(sendResult).toContain("replied after")
      expect(sendResult).not.toContain("CHILD-REPLY-ONE")
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes)
      throw error
    }
  }, 90_000)

  test("subagent_spawn runs in the background and the completion note starts a real parent turn", async () => {
    const sandbox = await createSandbox("subagent-comms-spawn")
    const provider = createProgrammableProvider({
      respond(context) {
        const ask = lastUserText(context.request)
        if (ask.includes("Say the alternate magic word")) {
          // The child burns a second so the parent reliably idles first.
          if (context.hasToolResultAfterLastUser())
            return { kind: "text", text: "ALTERNATE-CHILD-REPLY" }
          return {
            kind: "tool_call",
            name: "bash",
            args: { command: "sleep 1", description: "think hard" },
          }
        }
        if (ask.includes("Background subagent completed"))
          return { kind: "text", text: "PARENT-SAW-NOTE" }
        if (ask.includes("Spawn a subagent")) {
          if (context.hasToolResultAfterLastUser()) {
            const lastResult = toolResultTexts(context.request).at(-1) ?? ""
            if (lastResult.includes("Models in the current provider catalog"))
              return {
                kind: "tool_call",
                name: "subagent_spawn",
                args: {
                  description: "alternate model task",
                  prompt: "Say the alternate magic word.",
                  subagent_type: "general",
                  model: "e2e/alternate",
                  variant: "high",
                },
              }
            return { kind: "text", text: "PARENT-DONE-ONE" }
          }
          return {
            kind: "tool_call",
            name: "subagent_models",
            args: {},
          }
        }
        return { kind: "text", text: "OK" }
      },
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
      await writeSubagentCommsConfig(sandbox.project, provider.baseURL)
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("subagent-comms-spawn"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      const session = await createSession(
        client,
        sandbox.project,
        "Subagent spawn session",
      )
      const firstTurn = events.mark()
      await prompt(
        client,
        sandbox.project,
        session,
        "Spawn a subagent in the background.",
      )
      await events.waitFor(isIdle(session), {
        after: firstTurn,
        description: "parent idle right after spawning",
      })
      const afterSpawnTurn = events.mark()

      // The spawn returned while the child was still working: its tool result
      // announced a running task, and the child session exists.
      const spawnTurn = provider.requests.find((request) =>
        toolResultTexts(request).some((text) =>
          text.includes('state="running"'),
        ),
      )
      expect(spawnTurn).toBeDefined()
      expect(
        provider.requests.some(
          (request) =>
            Array.isArray(request.tools) &&
            request.tools.some(
              (tool) =>
                typeof tool === "object" &&
                tool !== null &&
                (tool as { function?: { name?: unknown } }).function?.name ===
                  "subagent_models",
            ),
        ),
      ).toBe(true)
      expect(
        provider.requests
          .flatMap(toolResultTexts)
          .some((text) => text.includes("e2e/alternate")),
      ).toBe(true)
      const children = await childrenOf(server, sandbox.project, session)
      expect(children).toHaveLength(1)

      const childRequest = provider.requests.find(
        (request) => lastUserText(request) === "Say the alternate magic word.",
      )
      expect(childRequest?.model).toBe("alternate")
      expect(childRequest?.scripted_marker).toBe("subagent-alternate-high")

      // The completion note lands as a fresh user turn on the idle parent,
      // with the child's reply inlined.
      await waitFor(
        async () =>
          provider.requests.some((request) =>
            userText(request).includes("Background subagent completed"),
          ),
        { description: "completion note reached the model", timeout: 30_000 },
      )
      const note = provider.requests.find((request) =>
        userText(request).includes("Background subagent completed"),
      )
      const text = note ? userText(note) : ""
      expect(text).toContain("ALTERNATE-CHILD-REPLY")
      expect(text).toContain(`<task id="${children[0]!.id}" state="completed">`)
      expect(text).toContain("subagent_send")

      await events.waitFor(isIdle(session), {
        after: afterSpawnTurn,
        description: "parent idle after the note turn",
      })
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes)
      throw error
    }
  }, 90_000)

  test("busy steer, explicit-idle wait, list, and idle kill against a live child", async () => {
    const sandbox = await createSandbox("subagent-comms-lifecycle")
    const provider = createProgrammableProvider({
      respond(context) {
        const ask = lastUserText(context.request)
        // The child: answers the steer once it arrives; otherwise burns five
        // seconds in bash so the parent's next turn reliably finds it busy.
        if (ask.includes("How about the tests"))
          return { kind: "text", text: "CHILD-STEERED-REPLY" }
        if (ask.includes("Say the magic word")) {
          if (context.hasToolResultAfterLastUser())
            return { kind: "text", text: "CHILD-REPLY-ONE" }
          return {
            kind: "tool_call",
            name: "bash",
            args: { command: "sleep 5", description: "think hard" },
          }
        }
        // The parent: one tool call per turn, each keyed by a user marker.
        if (ask.includes("SEND:")) {
          if (context.hasToolResultAfterLastUser())
            return { kind: "text", text: "PARENT-DONE-SEND" }
          const childID =
            /SEND:(ses_[0-9A-Za-z]+)/.exec(ask)?.[1] ?? "ses_missing"
          return {
            kind: "tool_call",
            name: "subagent_send",
            args: { session_id: childID, message: "How about the tests?" },
          }
        }
        if (ask.includes("WAIT:")) {
          if (context.hasToolResultAfterLastUser())
            return { kind: "text", text: "PARENT-DONE-WAIT" }
          const childID =
            /WAIT:(ses_[0-9A-Za-z]+)/.exec(ask)?.[1] ?? "ses_missing"
          return {
            kind: "tool_call",
            name: "subagent_wait",
            args: { session_ids: [childID] },
          }
        }
        if (ask.includes("LIST now")) {
          if (context.hasToolResultAfterLastUser())
            return { kind: "text", text: "PARENT-DONE-LIST" }
          return { kind: "tool_call", name: "subagent_list", args: {} }
        }
        if (ask.includes("KILL:")) {
          if (context.hasToolResultAfterLastUser())
            return { kind: "text", text: "PARENT-DONE-KILL" }
          const childID =
            /KILL:(ses_[0-9A-Za-z]+)/.exec(ask)?.[1] ?? "ses_missing"
          return {
            kind: "tool_call",
            name: "subagent_kill",
            args: { session_id: childID },
          }
        }
        if (ask.includes("Spawn a subagent")) {
          if (context.hasToolResultAfterLastUser())
            return { kind: "text", text: "PARENT-DONE-SPAWN" }
          return {
            kind: "tool_call",
            name: "subagent_spawn",
            args: {
              description: "magic word task",
              prompt: "Say the magic word.",
              subagent_type: "general",
            },
          }
        }
        return { kind: "text", text: "OK" }
      },
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
      await writeSubagentCommsConfig(sandbox.project, provider.baseURL)
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("subagent-comms-lifecycle"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      const session = await createSession(
        client,
        sandbox.project,
        "Subagent lifecycle session",
      )

      // Turn 1: background spawn; the parent idles while the child sleeps.
      const spawnTurn = events.mark()
      await prompt(
        client,
        sandbox.project,
        session,
        "Spawn a subagent in the background.",
      )
      await events.waitFor(isIdle(session), {
        after: spawnTurn,
        description: "parent idle right after spawning",
      })
      const children = await childrenOf(server, sandbox.project, session)
      expect(children).toHaveLength(1)
      const childID = children[0]!.id

      // Turn 2: steer the child while it is STILL in its bash step. The
      // blocking send claims the spawn's pending completion note (the send
      // result is the delivery), merges the message into the run in flight,
      // and returns the reply that answers it.
      const sendTurn = events.mark()
      await prompt(
        client,
        sandbox.project,
        session,
        `Now message that subagent. SEND:${childID}`,
      )
      await events.waitFor(isIdle(session), {
        after: sendTurn,
        description: "parent idle after the steer turn",
      })
      const sendResult = provider.requests
        .flatMap(toolResultTexts)
        .find((text) => text.includes("CHILD-STEERED-REPLY"))
      expect(sendResult).toBeDefined()
      expect(sendResult).toContain(
        "merged into a run that was already in progress",
      )
      expect(sendResult).toContain(`<task id="${childID}" state="completed">`)

      // Turn 3: an explicit wait on the now-idle child returns its latest
      // completed reply instead of "nothing to wait for".
      const waitTurn = events.mark()
      await prompt(
        client,
        sandbox.project,
        session,
        `Collect it. WAIT:${childID}`,
      )
      await events.waitFor(isIdle(session), {
        after: waitTurn,
        description: "parent idle after the wait turn",
      })
      const waitResult = provider.requests
        .flatMap(toolResultTexts)
        .find((text) => text.includes("None of those subagents are busy"))
      expect(waitResult).toBeDefined()
      expect(waitResult).toContain("Latest reply")
      expect(waitResult).toContain("CHILD-STEERED-REPLY")

      // Turn 4: the listing shows the idle child with its agent type.
      const listTurn = events.mark()
      await prompt(client, sandbox.project, session, "LIST now.")
      await events.waitFor(isIdle(session), {
        after: listTurn,
        description: "parent idle after the list turn",
      })
      const listResult = provider.requests
        .flatMap(toolResultTexts)
        .find((text) => text.includes("You have 1 subagent(s)"))
      expect(listResult).toBeDefined()
      expect(listResult).toContain(`${childID} [idle] @general`)

      // Turn 5: killing the idle child is a friendly no-op that preserves it.
      const killTurn = events.mark()
      await prompt(client, sandbox.project, session, `Stop it. KILL:${childID}`)
      await events.waitFor(isIdle(session), {
        after: killTurn,
        description: "parent idle after the kill turn",
      })
      const killResult = provider.requests
        .flatMap(toolResultTexts)
        .find((text) => text.includes("already idle"))
      expect(killResult).toBeDefined()
      expect(killResult).toContain(childID)

      // The blocking send owned the completion: no stray note turn fired.
      expect(
        provider.requests.some((request) =>
          userText(request).includes("Background subagent completed"),
        ),
      ).toBe(false)
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes)
      throw error
    }
  }, 120_000)
})

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  createOpencodeClient,
  type Event,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2"
import {
  killRequestsDir,
  loadTasksFiles,
  tasksDirectory,
  writeKillRequest,
} from "../../../plugins/background-tasks/src/shared"
import { EventRecorder } from "../harness/events"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import { writeBackgroundTasksConfig } from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import {
  type ChatCompletionRequest,
  createScriptedProvider,
  type ScriptedProvider,
} from "../harness/scripted-provider"
import { waitFor } from "../harness/wait"

// End-to-end against a real, version-pinned OpenCode: the fake model emits a
// single background_run tool call, the plugin spawns the process, and once it
// finishes the plugin injects the completion notice back into the session —
// which, on an idle session, starts a fresh model turn. We assert the notice
// reaches the conversation and the provider's follow-up request, that the
// state registry reflects the lifecycle, and that a TUI-style kill request is
// honored.

type SessionIdle = Extract<Event, { type: "session.idle" }>
const isIdle =
  (sessionID: string) =>
  (event: Event): event is SessionIdle =>
    event.type === "session.idle" && event.properties.sessionID === sessionID

function clientFor(server: OpenCodeProcess, directory: string): OpencodeClient {
  return createOpencodeClient({ baseUrl: server.url, directory })
}

async function registeredTasks(stateDir: string, project: string) {
  return (await loadTasksFiles(tasksDirectory(stateDir, project))).flatMap(
    (file) => file.tasks,
  )
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

function userText(request: ChatCompletionRequest): string {
  const messages = Array.isArray(request.messages) ? request.messages : []
  return messages
    .filter((message) => message.role === "user")
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
    .join("\n")
}

async function stateDirOf(
  client: OpencodeClient,
  directory: string,
): Promise<string> {
  const result = await client.path.get({ directory })
  const state = (result.data as { state?: unknown } | undefined)?.state
  if (typeof state !== "string" || !state)
    throw new Error("could not resolve the server state dir")
  return state
}

type BackgroundRunPart = {
  type?: unknown
  tool?: unknown
  state?: {
    status?: unknown
    error?: unknown
    output?: unknown
  }
}

async function backgroundRunPart(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
): Promise<BackgroundRunPart | undefined> {
  const result = await client.session.messages({ directory, sessionID })
  if (result.error)
    throw new Error(
      `Could not read session messages: ${JSON.stringify(result.error)}`,
    )
  return (result.data ?? [])
    .flatMap(
      (message) => (message as { parts?: BackgroundRunPart[] }).parts ?? [],
    )
    .find((part) => part.type === "tool" && part.tool === "background_run")
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function writeArtifacts(
  sandbox: Sandbox,
  provider: ScriptedProvider,
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
  const artifact = await sandbox.preserve("background-tasks-server")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("background-tasks against a real OpenCode server", () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("background_run spawns, finishes, and notifies the idle session with a real turn", async () => {
    const sandbox = await createSandbox("background-tasks-server")
    const provider = createScriptedProvider({
      command: "unused",
      finalText: "Acknowledged the background task.",
      tool: {
        tool: "background_run",
        arguments: {
          command: "sh -c 'sleep 0.3; echo done-marker-7f3a'",
          name: "e2e task",
        },
      },
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
      await writeBackgroundTasksConfig(sandbox.project, provider.baseURL)
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("background-tasks"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      const session = await createSession(
        client,
        sandbox.project,
        "Background task session",
      )
      const mark = events.mark()
      await prompt(
        client,
        sandbox.project,
        session,
        "Start the long build in the background.",
      )

      // The completion notice is injected as a user message and (idle session)
      // starts a new turn: the provider therefore receives a follow-up request
      // whose user text carries the update block and the task's output marker.
      // waitFor throws on timeout, so reaching past it proves the notice landed.
      await waitFor(
        async () =>
          provider.requests.some((request) =>
            userText(request).includes("<background-task-update>"),
          ),
        { description: "completion notice reached the model", timeout: 20_000 },
      )
      const notice = provider.requests.find((request) =>
        userText(request).includes("<background-task-update>"),
      )
      const text = notice ? userText(notice) : ""
      expect(text).toContain("done-marker-7f3a")
      expect(text).toContain("exited with code 0")

      await events.waitFor(isIdle(session), {
        after: mark,
        description: "session idle after the notice turn",
      })

      // The state registry records the finished task.
      const stateDir = await stateDirOf(client, sandbox.project)
      const task = (await registeredTasks(stateDir, sandbox.project)).find(
        (candidate) => candidate.name === "e2e task",
      )
      expect(task).toBeDefined()
      expect(task?.state).toBe("exited")
      expect(task?.exitCode).toBe(0)
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes)
      throw error
    }
  }, 60_000)

  test("a TUI-dropped kill request stops a running background task", async () => {
    const sandbox = await createSandbox("background-tasks-kill")
    const provider = createScriptedProvider({
      command: "unused",
      finalText: "Started the long task.",
      tool: {
        tool: "background_run",
        arguments: { command: "sleep 120", name: "long runner" },
      },
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
      await writeBackgroundTasksConfig(sandbox.project, provider.baseURL)
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("background-tasks-kill"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      const session = await createSession(
        client,
        sandbox.project,
        "Kill session",
      )
      await prompt(
        client,
        sandbox.project,
        session,
        "Start the server in the background.",
      )

      const stateDir = await stateDirOf(client, sandbox.project)
      await waitFor(
        async () =>
          (await registeredTasks(stateDir, sandbox.project)).some(
            (task) => task.state === "running",
          ),
        {
          description: "task running",
          timeout: 20_000,
        },
      )
      const running = (await registeredTasks(stateDir, sandbox.project)).find(
        (task) => task.state === "running",
      )
      expect(running?.name).toBe("long runner")

      // Drop a kill request exactly as the TUI half would.
      await writeKillRequest(
        killRequestsDir(stateDir, sandbox.project),
        running?.id as string,
      )
      await waitFor(
        async () =>
          (await registeredTasks(stateDir, sandbox.project)).find(
            (task) => task.id === running?.id,
          )?.state === "killed",
        { description: "task killed via TUI request", timeout: 20_000 },
      )
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes)
      throw error
    }
  }, 60_000)

  test("background_run applies host bash permissions to every executable subcommand and external path", async () => {
    const sandbox = await createSandbox("background-tasks-permissions-219")
    const externalFixture = path.join(sandbox.home, "external-fixture.txt")
    const deniedCases = [
      {
        trigger: "Run the issue 219 compound command.",
        name: "compound permission regression",
        command:
          "printf 'compound launched\\n' > compound-sentinel && uname -a",
        sentinel: path.join(sandbox.project, "compound-sentinel"),
      },
      {
        trigger: "Run the issue 219 pipeline command.",
        name: "pipeline permission regression",
        command: "printf 'pipeline launched\\n' > pipe-sentinel | uname -a",
        sentinel: path.join(sandbox.project, "pipe-sentinel"),
      },
      {
        trigger: "Run the issue 219 command substitution.",
        name: "substitution permission regression",
        command: "printf '%s\\n' \"$(uname -a)\" > substitution-sentinel",
        sentinel: path.join(sandbox.project, "substitution-sentinel"),
      },
      {
        trigger: "Run the issue 256 timeout wrapper command.",
        name: "timeout wrapper permission regression",
        command:
          "printf 'timeout launched\\n' > timeout-sentinel && timeout 300 uname -a",
        sentinel: path.join(sandbox.project, "timeout-sentinel"),
      },
      {
        trigger: "Run the issue 256 nested wrapper command.",
        name: "nested wrapper permission regression",
        command:
          "printf 'nested launched\\n' > nested-sentinel && nice -n 5 timeout 300 uname -a",
        sentinel: path.join(sandbox.project, "nested-sentinel"),
      },
      {
        trigger: "Run the issue 219 external operand command.",
        name: "external operand permission regression",
        command: `printf 'external launched\\n' > external-sentinel && cat ${shellArg(externalFixture)} > /dev/null`,
        sentinel: path.join(sandbox.project, "external-sentinel"),
      },
      {
        trigger: "Run the issue 219 parameter expansion command.",
        name: "fail-closed parser regression",
        command: `printf '%s' "\${HOME:+'$(uname -a)'}" > parser-sentinel`,
        sentinel: path.join(sandbox.project, "parser-sentinel"),
        error: "Cannot safely analyze background command",
      },
    ]
    const allowedCase = {
      trigger: "Run the issue 219 allowed command.",
      name: "allowed permission control",
      command: "printf 'allowed\\n' > allowed-sentinel",
      sentinel: path.join(sandbox.project, "allowed-sentinel"),
    }
    const cases = [...deniedCases, allowedCase]
    const provider = createScriptedProvider({
      finalText: "Observed the scripted background_run result.",
      toolCall(lastUserText) {
        const selected = cases.find((candidate) =>
          lastUserText.includes(candidate.trigger),
        )
        return selected
          ? {
              tool: "background_run",
              arguments: {
                command: selected.command,
                name: selected.name,
                workdir: ".",
              },
            }
          : undefined
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
      await fs.writeFile(externalFixture, "isolated external fixture\n")
      await writeBackgroundTasksConfig(sandbox.project, provider.baseURL, {
        permission: {
          bash: {
            "*": "ask",
            "printf *": "allow",
            "cat *": "allow",
            "nice *": "allow",
            "timeout *": "allow",
            "uname *": "deny",
          },
          external_directory: {
            "*": "allow",
            [`${sandbox.home}${path.sep}*`]: "deny",
          },
        },
      })
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("background-tasks-permissions-219"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      for (const denied of deniedCases) {
        const session = await createSession(
          client,
          sandbox.project,
          denied.name,
        )
        const mark = events.mark()
        await prompt(client, sandbox.project, session, denied.trigger)
        await events.waitFor(isIdle(session), {
          after: mark,
          description: `${denied.name} denied turn idle`,
        })

        const part = await backgroundRunPart(client, sandbox.project, session)
        expect(part?.state?.status).toBe("error")
        expect(String(part?.state?.error)).toContain(
          denied.error ?? "prevents you from using this specific tool call",
        )
        await expect(fs.access(denied.sentinel)).rejects.toThrow()
      }

      const allowedSession = await createSession(
        client,
        sandbox.project,
        allowedCase.name,
      )
      const allowedMark = events.mark()
      await prompt(client, sandbox.project, allowedSession, allowedCase.trigger)
      await events.waitFor(isIdle(allowedSession), {
        after: allowedMark,
        description: "allowed control turn idle",
      })
      const allowedPart = await backgroundRunPart(
        client,
        sandbox.project,
        allowedSession,
      )
      expect(allowedPart?.state?.status).toBe("completed")
      expect(String(allowedPart?.state?.output)).toContain(
        "Started background task",
      )
      await waitFor(
        async () =>
          (await fs.readFile(allowedCase.sentinel, "utf8").catch(() => "")) ===
          "allowed\n",
        { description: "allowed printf command wrote its sentinel" },
      )
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes)
      throw error
    }
  }, 90_000)
})

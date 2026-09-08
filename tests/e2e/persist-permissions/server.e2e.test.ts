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
  readJson,
  storeFile,
  writeProjectConfig,
  writeStoreFile,
} from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import {
  createScriptedProvider,
  type ScriptedProvider,
} from "../harness/scripted-provider"
import { waitFor } from "../harness/wait"

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

async function sessionTranscript(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
) {
  const result = await client.session.messages({ directory, sessionID })
  if (result.error || !result.data)
    throw new Error(
      `Could not read E2E session messages: ${JSON.stringify(result.error)}`,
    )
  return JSON.stringify(result.data)
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
  const artifact = await sandbox.preserve("persist-permissions-server")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("persist-permissions against a real OpenCode server", () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("persists an approval and auto-approves it after a fresh OpenCode restart", async () => {
    const sandbox = await createSandbox("persist-permissions-server")
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
      await writeProjectConfig(sandbox.project, provider.baseURL)

      const first = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("first"),
      })
      processes.push(first)
      const firstClient = clientFor(first, sandbox.project)
      const firstEvents = await EventRecorder.connect(firstClient)
      recorders.push(firstEvents)
      const firstSession = await createSession(
        firstClient,
        sandbox.project,
        "E2E persist approval",
      )
      const firstMark = firstEvents.mark()
      await prompt(firstClient, sandbox.project, firstSession)
      const firstAsked = await firstEvents.waitFor(isAsked(firstSession), {
        after: firstMark,
        description: "first permission.asked",
      })
      expect(firstAsked.properties.permission).toBe("bash")
      expect(firstAsked.properties.patterns).toEqual([COMMAND])
      const firstReply = await firstClient.permission.reply({
        directory: sandbox.project,
        requestID: firstAsked.properties.id,
        reply: "always",
      })
      if (firstReply.error)
        throw new Error(
          `Could not approve first permission: ${JSON.stringify(firstReply.error)}`,
        )
      await firstEvents.waitFor(isIdle(firstSession), {
        after: firstMark,
        description: "first session idle",
      })

      // Same store-write race as the non-git test: poll, never single-read.
      const firstStoreFile = storeFile(sandbox.config, sandbox.project)
      await waitFor(
        async () =>
          (
            await readJson<{ permission: { bash?: Record<string, string> } }>(
              firstStoreFile,
            ).catch(() => undefined)
          )?.permission.bash?.["git status *"] === "allow",
        { description: "first approval reaching the store" },
      )
      const initialStore = await readJson<{
        permission: { bash?: Record<string, string> }
      }>(firstStoreFile)
      expect(initialStore.permission.bash).toEqual({ "git status *": "allow" })
      expect(
        path.relative(sandbox.project, firstStoreFile).startsWith(".."),
      ).toBe(true)
      await waitFor(
        () =>
          provider.requests.some((request) =>
            request.messages?.some((message) => message.role === "tool"),
          ),
        { description: "tool result reaching the scripted provider" },
      )

      await firstEvents.close()
      await first.stop()
      recorders.splice(recorders.indexOf(firstEvents), 1)
      processes.splice(processes.indexOf(first), 1)

      const second = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("second"),
      })
      processes.push(second)
      const secondClient = clientFor(second, sandbox.project)
      const secondEvents = await EventRecorder.connect(secondClient)
      recorders.push(secondEvents)
      const secondSession = await createSession(
        secondClient,
        sandbox.project,
        "E2E auto approval",
      )
      const secondMark = secondEvents.mark()
      await prompt(secondClient, sandbox.project, secondSession)
      const secondAsked = await secondEvents.waitFor(isAsked(secondSession), {
        after: secondMark,
        description: "auto-approved permission.asked",
      })
      expect(secondAsked.properties.patterns).toEqual([COMMAND])
      const secondReply = await secondEvents.waitFor(isReplied(secondSession), {
        after: secondMark,
        description: "plugin auto permission.replied",
      })
      expect(secondReply.properties.requestID).toBe(secondAsked.properties.id)
      expect(secondReply.properties.reply).toBe("once")
      await secondEvents.waitFor(isIdle(secondSession), {
        after: secondMark,
        description: "second session idle",
      })
      expect(
        await readJson<typeof initialStore>(
          storeFile(sandbox.config, sandbox.project),
        ),
      ).toEqual(initialStore)

      provider.setCommand("git rev-parse --is-inside-work-tree")
      const unmatchedSession = await createSession(
        secondClient,
        sandbox.project,
        "E2E unmatched rule",
      )
      const unmatchedMark = secondEvents.mark()
      await prompt(secondClient, sandbox.project, unmatchedSession)
      const unmatchedAsked = await secondEvents.waitFor(
        isAsked(unmatchedSession),
        {
          after: unmatchedMark,
          description: "unmatched permission.asked",
        },
      )
      const pending = await secondClient.permission.list({
        directory: sandbox.project,
      })
      if (pending.error || !pending.data)
        throw new Error(
          `Could not inspect pending permissions: ${JSON.stringify(pending.error)}`,
        )
      expect(
        pending.data.some(
          (request) => request.id === unmatchedAsked.properties.id,
        ),
      ).toBe(true)
      const reject = await secondClient.permission.reply({
        directory: sandbox.project,
        requestID: unmatchedAsked.properties.id,
        reply: "reject",
      })
      if (reject.error)
        throw new Error(
          `Could not reject unmatched permission: ${JSON.stringify(reject.error)}`,
        )
      await secondEvents.waitFor(isIdle(unmatchedSession), {
        after: unmatchedMark,
        description: "unmatched session idle",
      })
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, processes, recorders)
      throw error
    }
  })

  test("an automated ordinary read approval cannot unlock protected reads", async () => {
    const sandbox = await createSandbox("persist-permissions-read-carveout")
    const readme = path.join(sandbox.project, "README.md")
    const protectedFile = path.join(sandbox.project, ".env")
    const ordinaryMarker = "HARMLESS_ORDINARY_READ_FIXTURE"
    const protectedMarker = "HARMLESS_PROTECTED_READ_FIXTURE"
    const provider = createScriptedProvider({
      toolCall: (text) => {
        if (text.includes("protected read and the ordinary README")) {
          return [
            { tool: "read", arguments: { filePath: protectedFile } },
            { tool: "read", arguments: { filePath: readme } },
          ]
        }
        if (text.includes("later protected read"))
          return { tool: "read", arguments: { filePath: protectedFile } }
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
      await Promise.all([
        fs.writeFile(readme, `${ordinaryMarker}\n`),
        fs.writeFile(protectedFile, `${protectedMarker}\n`),
      ])
      await writeProjectConfig(sandbox.project, provider.baseURL, {
        permission: { read: "ask" },
      })
      await writeStoreFile(sandbox.config, sandbox.project, {
        permission: { read: { "*": "allow", ".env": "deny" } },
      })

      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("read-carveout"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)
      const created = await client.session.create({
        directory: sandbox.project,
        title: "E2E protected read carve-out",
        permission: [{ permission: "read", pattern: ".env", action: "ask" }],
      })
      if (created.error || !created.data)
        throw new Error(
          `Could not create E2E session: ${JSON.stringify(created.error)}`,
        )
      const sessionID = created.data.id

      // The protected call is emitted first in the same assistant batch. Its
      // ask must already be pending when the saved README allow is replayed.
      const initialMark = events.mark()
      await prompt(
        client,
        sandbox.project,
        sessionID,
        "Attempt one protected read and the ordinary README read together.",
      )
      await waitFor(
        () =>
          events.events.slice(initialMark).filter(isAsked(sessionID)).length ===
            2 || JSON.stringify(provider.requests).includes(protectedMarker),
        {
          description:
            "both initial reads to ask or the protected fixture to be exposed",
        },
      )
      expect(JSON.stringify(provider.requests)).not.toContain(protectedMarker)
      const initialAsked = events.events
        .slice(initialMark)
        .filter(isAsked(sessionID))
      const ordinaryAsked = initialAsked.find((event) =>
        event.properties.patterns.includes("README.md"),
      )
      const protectedAsked = initialAsked.find((event) =>
        event.properties.patterns.includes(".env"),
      )
      if (!ordinaryAsked || !protectedAsked)
        throw new Error("initial read permission events were incomplete")
      expect(ordinaryAsked.properties.patterns).toEqual(["README.md"])
      expect(ordinaryAsked.properties.always).toEqual(["*"])
      expect(protectedAsked.properties.patterns).toEqual([".env"])
      const ordinaryReplied = await events.waitFor(
        (event): event is PermissionReplied =>
          isReplied(sessionID)(event) &&
          event.properties.requestID === ordinaryAsked.properties.id,
        {
          after: initialMark,
          description: "ordinary read auto-approval",
        },
      )
      expect(ordinaryReplied.properties.requestID).toBe(
        ordinaryAsked.properties.id,
      )
      expect(events.events.indexOf(protectedAsked)).toBeLessThan(
        events.events.indexOf(ordinaryReplied),
      )
      // Give an unsafe "always" replay time to sweep the already-pending ask
      // and feed both read results back to the provider.
      await Bun.sleep(500)
      const initialPending = await client.permission.list({
        directory: sandbox.project,
      })
      if (initialPending.error || !initialPending.data)
        throw new Error(
          `Could not inspect pending permissions: ${JSON.stringify(initialPending.error)}`,
        )
      expect(JSON.stringify(provider.requests)).not.toContain(protectedMarker)
      expect(initialPending.data.map((request) => request.id)).toEqual([
        protectedAsked.properties.id,
      ])
      expect(ordinaryReplied.properties.reply).toBe("once")
      let initialTranscript = ""
      await waitFor(
        async () => {
          initialTranscript = await sessionTranscript(
            client,
            sandbox.project,
            sessionID,
          )
          return (
            initialTranscript.includes(ordinaryMarker) ||
            initialTranscript.includes(protectedMarker)
          )
        },
        { description: "the initial read results reaching session history" },
      )
      expect(initialTranscript).toContain(ordinaryMarker)
      expect(initialTranscript).not.toContain(protectedMarker)

      const rejected = await client.permission.reply({
        directory: sandbox.project,
        requestID: protectedAsked.properties.id,
        reply: "reject",
      })
      if (rejected.error)
        throw new Error(
          `Could not reject protected read: ${JSON.stringify(rejected.error)}`,
        )
      await events.waitFor(isIdle(sessionID), {
        after: initialMark,
        description: "initial protected read rejected and session idle",
      })
      expect(JSON.stringify(provider.requests)).not.toContain(protectedMarker)

      // A fresh turn proves the ordinary approval did not leave behind a
      // read:* host rule that unlocks protected reads later in the session.
      const laterMark = events.mark()
      await prompt(
        client,
        sandbox.project,
        sessionID,
        "Attempt the later protected read.",
      )
      await waitFor(
        () =>
          events.events.slice(laterMark).filter(isAsked(sessionID)).length ===
            1 || JSON.stringify(provider.requests).includes(protectedMarker),
        {
          description:
            "later protected read to ask or expose its fixture contents",
        },
      )
      expect(JSON.stringify(provider.requests)).not.toContain(protectedMarker)
      const laterAsked = events.events
        .slice(laterMark)
        .filter(isAsked(sessionID))
      expect(laterAsked.map((event) => event.properties.patterns)).toEqual([
        [".env"],
      ])
      await Bun.sleep(500)
      const laterPending = await client.permission.list({
        directory: sandbox.project,
      })
      if (laterPending.error || !laterPending.data)
        throw new Error(
          `Could not inspect pending permissions: ${JSON.stringify(laterPending.error)}`,
        )
      expect(laterPending.data.map((request) => request.id)).toEqual([
        laterAsked[0]!.properties.id,
      ])
      expect(JSON.stringify(provider.requests)).not.toContain(protectedMarker)

      const laterRejected = await client.permission.reply({
        directory: sandbox.project,
        requestID: laterAsked[0]!.properties.id,
        reply: "reject",
      })
      if (laterRejected.error)
        throw new Error(
          `Could not reject later protected read: ${JSON.stringify(laterRejected.error)}`,
        )
      await events.waitFor(isIdle(sessionID), {
        after: laterMark,
        description: "later protected read rejected and session idle",
      })
      const laterTranscript = await sessionTranscript(
        client,
        sandbox.project,
        sessionID,
      )
      expect(laterTranscript).toContain(ordinaryMarker)
      expect(laterTranscript).not.toContain(protectedMarker)
      expect(JSON.stringify(provider.requests)).not.toContain(protectedMarker)
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, processes, recorders)
      throw error
    }
  })

  test("an approval in a linked worktree persists for the primary checkout, folding in pre-scope data", async () => {
    const sandbox = await createSandbox("persist-permissions-worktree")
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

    const git = async (args: string[]) => {
      const proc = Bun.spawn(["git", ...args], {
        cwd: sandbox.project,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.exited
      if (proc.exitCode !== 0) {
        throw new Error(
          `git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`,
        )
      }
    }

    try {
      await provider.ready
      await writeProjectConfig(sandbox.project, provider.baseURL)
      // Commit the config so the linked worktree checks it out too — the
      // worktree instance needs the same provider and plugin entries.
      const worktreeDir = path.join(sandbox.root, "worktree-checkout")
      await git(["add", "-A"])
      await git([
        "-c",
        "user.email=e2e@example.invalid",
        "-c",
        "user.name=e2e",
        "commit",
        "--quiet",
        "-m",
        "e2e setup",
      ])
      await git(["worktree", "add", "--quiet", worktreeDir])

      // A store a pre-repository-scope release left behind, keyed by the
      // worktree's own root: the first store access must fold it in.
      const preScopeStore = storeFile(sandbox.config, worktreeDir)
      await fs.mkdir(path.dirname(preScopeStore), { recursive: true })
      await fs.writeFile(
        preScopeStore,
        `${JSON.stringify({ permission: { bash: { "ls *": "allow" } } })}\n`,
      )

      const inWorktree = await startOpenCode({
        cwd: worktreeDir,
        env: await sandbox.environment("worktree"),
      })
      processes.push(inWorktree)
      const worktreeClient = clientFor(inWorktree, worktreeDir)
      const worktreeEvents = await EventRecorder.connect(worktreeClient)
      recorders.push(worktreeEvents)
      const worktreeSession = await createSession(
        worktreeClient,
        worktreeDir,
        "E2E worktree approval",
      )
      const worktreeMark = worktreeEvents.mark()
      await prompt(worktreeClient, worktreeDir, worktreeSession)
      const asked = await worktreeEvents.waitFor(isAsked(worktreeSession), {
        after: worktreeMark,
        description: "worktree permission.asked",
      })
      const reply = await worktreeClient.permission.reply({
        directory: worktreeDir,
        requestID: asked.properties.id,
        reply: "always",
      })
      if (reply.error)
        throw new Error(
          `Could not approve worktree permission: ${JSON.stringify(reply.error)}`,
        )
      await worktreeEvents.waitFor(isIdle(worktreeSession), {
        after: worktreeMark,
        description: "worktree session idle",
      })

      // The approval lands in the PRIMARY-keyed store, alongside the folded-in
      // pre-scope rule, and the worktree-keyed file is gone.
      const sharedStoreFile = storeFile(sandbox.config, sandbox.project)
      await waitFor(
        async () =>
          (
            await readJson<{ permission: { bash?: Record<string, string> } }>(
              sharedStoreFile,
            ).catch(() => undefined)
          )?.permission.bash?.["git status *"] === "allow",
        { description: "worktree approval reaching the primary-keyed store" },
      )
      const sharedStore = await readJson<{
        permission: { bash: Record<string, string> }
      }>(sharedStoreFile)
      expect(sharedStore.permission.bash["ls *"]).toBe("allow")
      await expect(fs.access(preScopeStore)).rejects.toThrow()

      await worktreeEvents.close()
      await inWorktree.stop()
      recorders.splice(recorders.indexOf(worktreeEvents), 1)
      processes.splice(processes.indexOf(inWorktree), 1)

      // A fresh OpenCode in the PRIMARY checkout silently re-approves what
      // was approved in the worktree — the papercut this scope exists for.
      const inPrimary = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("primary"),
      })
      processes.push(inPrimary)
      const primaryClient = clientFor(inPrimary, sandbox.project)
      const primaryEvents = await EventRecorder.connect(primaryClient)
      recorders.push(primaryEvents)
      const primarySession = await createSession(
        primaryClient,
        sandbox.project,
        "E2E primary auto approval",
      )
      const primaryMark = primaryEvents.mark()
      await prompt(primaryClient, sandbox.project, primarySession)
      const primaryAsked = await primaryEvents.waitFor(
        isAsked(primarySession),
        {
          after: primaryMark,
          description: "primary permission.asked",
        },
      )
      const primaryReplied = await primaryEvents.waitFor(
        isReplied(primarySession),
        {
          after: primaryMark,
          description: "primary auto permission.replied",
        },
      )
      expect(primaryReplied.properties.requestID).toBe(
        primaryAsked.properties.id,
      )
      expect(primaryReplied.properties.reply).toBe("once")
      await primaryEvents.waitFor(isIdle(primarySession), {
        after: primaryMark,
        description: "primary session idle",
      })
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, processes, recorders)
      throw error
    }
  })

  test("stores approvals under the session directory for a non-git project", async () => {
    const sandbox = await createSandbox("persist-permissions-non-git", {
      git: false,
    })
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
      await writeProjectConfig(sandbox.project, provider.baseURL)
      const server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("non-git"),
      })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)
      const sessionID = await createSession(
        client,
        sandbox.project,
        "E2E non-git fallback",
      )
      const mark = events.mark()
      await prompt(client, sandbox.project, sessionID)
      const asked = await events.waitFor(isAsked(sessionID), {
        after: mark,
        description: "non-git permission.asked",
      })
      const replied = await client.permission.reply({
        directory: sandbox.project,
        requestID: asked.properties.id,
        reply: "always",
      })
      if (replied.error)
        throw new Error(
          `Could not approve non-git permission: ${JSON.stringify(replied.error)}`,
        )
      await events.waitFor(isIdle(sessionID), {
        after: mark,
        description: "non-git session idle",
      })
      // The plugin persists on its own clock after the reply — behind the
      // scope probes and the store lock — so session.idle does not order the
      // write (seen on a loaded CI runner: lock file present, store not yet
      // written). Poll for the store like the worktree test above; never a
      // single read.
      const nonGitStoreFile = storeFile(sandbox.config, sandbox.project)
      await waitFor(
        async () =>
          (
            await readJson<{ permission: { bash?: Record<string, string> } }>(
              nonGitStoreFile,
            ).catch(() => undefined)
          )?.permission.bash?.["git status *"] === "allow",
        {
          description: "non-git approval reaching the session-directory store",
        },
      )
      expect(
        await readJson<{ permission: { bash: Record<string, string> } }>(
          nonGitStoreFile,
        ),
      ).toEqual({
        permission: { bash: { "git status *": "allow" } },
      })
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, processes, recorders)
      throw error
    }
  })
})

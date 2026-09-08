import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  createOpencodeClient,
  type Event,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2"
import {
  activityFile,
  overrideFile,
  readOverride,
  requestInstanceID,
  writeOverride,
} from "../../../plugins/approve-for-me/src/shared"
import { EventRecorder } from "../harness/events"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import {
  AUTO_APPROVE_SERVER_ENTRY,
  blessAutoApproveProjectConfig,
  writeAutoApproveSettings,
  writeProjectConfig,
} from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import {
  type ClassifierRecord,
  createScriptedProvider,
  type ScriptedProvider,
} from "../harness/scripted-provider"
import { assertFor, waitFor } from "../harness/wait"

/**
 * approve-for-me under concurrent load, against the pinned real
 * OpenCode host. Most scenarios drive a fan of child sessions — the shape a
 * session full of parallel sub-agents produces — whose simultaneous tool
 * calls raise simultaneous permission prompts, all in ONE prompt tree (the
 * shared parent); the batch scenarios drive a single turn issuing several
 * parallel tool calls in one assistant message. The scripted provider's
 * classifier gate/latency controls make the timing deterministic.
 * Scheduling is batch-parallel, release-serial (a batch being one assistant
 * turn's tool calls; every sub-agent prompt here is a batch of one unless
 * the script says otherwise):
 *
 *   - one turn's parallel tool calls are judged CONCURRENTLY; batches never
 *     interleave — a cross-batch burst is judged one batch at a time, in the
 *     order the TUI presents the stack (sessions by id ascending) — and
 *     never dropped to the user,
 *   - `processing: "serial"` opts back into one prompt at a time everywhere,
 *   - replies land in exact stack order in every mode: an approval judged
 *     while a higher prompt arrived above it is PARKED until that settles,
 *   - a surfaced prompt stalls the tree until the user answers it,
 *   - a user answering a still-queued prompt wins, and that prompt is never
 *     spent on a model call,
 *   - sustained pipelines (each sub-agent making several sequential tool
 *     calls) drain completely,
 *   - prompts orphaned by an aborted run are swept (rejected) once their
 *     session settles and their tool calls are verifiably dead.
 *
 * The suite also measures ask→verdict latency per prompt and prints a small
 * report, so plugin overhead is separable from injected model latency.
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
  parentID?: string,
) {
  const result = await client.session.create({
    directory,
    title,
    ...(parentID ? { parentID } : {}),
  })
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
  text: string,
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

/** The `[worker-N]` marker planted in each child session's prompt text. */
function workerMarker(index: number) {
  return `[worker-${index}]`
}

/**
 * Which workers' prompts the classifier has actually been asked about so
 * far — each classifier call carries the triggering session's task text, so
 * the marker identifies the worker even when every worker runs the same
 * command.
 */
function classifiedWorkers(provider: ScriptedProvider): Set<number> {
  return new Set(classifiedWorkerSequence(provider))
}

/** The same, but as the ordered sequence of classifier calls. */
function classifiedWorkerSequence(provider: ScriptedProvider): number[] {
  const workers: number[] = []
  for (const record of provider.classifierRecords) {
    const match = JSON.stringify(record.request.messages).match(
      /\[worker-(\d+)\]/,
    )
    if (match) workers.push(Number(match[1]))
  }
  return workers
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return Number.NaN
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * q)),
  )
  const value = sorted[index]
  if (value === undefined) return Number.NaN
  return value
}

function reportLatencies(label: string, samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  console.error(
    `[perf] ${label}: n=${sorted.length} ` +
      `p50=${quantile(sorted, 0.5)}ms p90=${quantile(sorted, 0.9)}ms max=${sorted[sorted.length - 1] ?? Number.NaN}ms`,
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
  const artifact = await sandbox.preserve("approve-for-me-concurrency")
  console.error(`E2E artifacts retained at ${artifact}`)
}

type Fixture = {
  sandbox: Sandbox
  provider: ScriptedProvider
  server: OpenCodeProcess
  client: OpencodeClient
  events: EventRecorder
  configDir: string
}

describe("approve-for-me under concurrent sub-agent load", () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function startFixture(
    name: string,
    options: Parameters<typeof createScriptedProvider>[0],
  ): Promise<Fixture> {
    const sandbox = await createSandbox(name)
    const provider = createScriptedProvider(options)
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

    await provider.ready
    await writeProjectConfig(sandbox.project, provider.baseURL, {
      plugins: [AUTO_APPROVE_SERVER_ENTRY],
    })
    const serverEnv = await sandbox.environment("server")
    const configDir = serverEnv.OPENCODE_CONFIG_DIR
    if (!configDir) throw new Error("sandbox omitted OPENCODE_CONFIG_DIR")
    if (!serverEnv.XDG_STATE_HOME)
      throw new Error("sandbox omitted XDG_STATE_HOME")
    await blessAutoApproveProjectConfig(
      serverEnv.XDG_STATE_HOME,
      sandbox.project,
    )
    const server = await startOpenCode({ cwd: sandbox.project, env: serverEnv })
    processes.push(server)
    const client = clientFor(server, sandbox.project)
    const events = await EventRecorder.connect(client)
    recorders.push(events)
    const fixture = { sandbox, provider, server, client, events, configDir }
    return fixture
  }

  /** N child sessions under one parent, all prompted at once. */
  async function promptWorkers(
    fixture: Fixture,
    count: number,
  ): Promise<string[]> {
    const { client, sandbox } = fixture
    const parent = await createSession(
      client,
      sandbox.project,
      "E2E sub-agent parent",
    )
    const workers = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        createSession(
          client,
          sandbox.project,
          `E2E sub-agent ${index}`,
          parent,
        ),
      ),
    )
    await Promise.all(
      workers.map((sessionID, index) =>
        prompt(
          client,
          sandbox.project,
          sessionID,
          `Run the scripted command exactly once. ${workerMarker(index)}`,
        ),
      ),
    )
    return workers
  }

  test("a burst is judged one prompt at a time, in stack order, and never dropped", async () => {
    const WORKERS = 10
    const fixture = await startFixture("approve-for-me-burst", {
      command: COMMAND,
      classifierVerdict: {
        decision: "approve",
        risk: "low",
        authorization: "implied",
        reason: "scripted approval",
      },
    })
    const { sandbox, provider, client, events } = fixture

    try {
      // Hold every classifier response so the serial scheduler's pacing is
      // observable deterministically.
      provider.setClassifier({
        verdict: {
          decision: "approve",
          risk: "low",
          authorization: "implied",
          reason: "scripted approval",
        },
        gated: true,
      })

      const mark = events.mark()
      const workers = await promptWorkers(fixture, WORKERS)
      const asked = new Map<string, PermissionAsked>()
      for (const sessionID of workers) {
        asked.set(
          sessionID,
          await events.waitFor(isAsked(sessionID), {
            after: mark,
            description: `permission.asked for ${sessionID}`,
          }),
        )
      }

      // All ten prompts share one tree (one parent) but come from ten
      // DIFFERENT sessions — ten batches of one — so even the default
      // parallel mode judges them one at a time: exactly ONE classifier
      // call may be in flight while its verdict is held.
      await provider.waitForClassifierCount(1, { timeoutMs: 15_000 })
      await Bun.sleep(500)
      expect(provider.classifierRecords.length).toBe(1)

      // Each landed verdict advances to exactly the next prompt in the
      // TUI's stack order: sessions ascending by id (the first pick is
      // arrival-order — the scheduler never preempts a running judgment).
      for (let done = 1; done <= WORKERS; done += 1) {
        provider.releaseClassifiers(1)
        if (done < WORKERS)
          await provider.waitForClassifierCount(done + 1, { timeoutMs: 15_000 })
      }

      const latencies: number[] = []
      for (const sessionID of workers) {
        const replied = await events.waitFor(isReplied(sessionID), {
          after: mark,
          timeout: 30_000,
          description: `permission.replied for ${sessionID}`,
        })
        // Every prompt was answered by the classifier: "once", never
        // "always", and never left for the user.
        expect(replied.properties.reply).toBe("once")
        expect(replied.properties.requestID).toBe(
          asked.get(sessionID)?.properties.id ?? "",
        )
        const askedAt = events.receivedAt(asked.get(sessionID) as Event)
        const repliedAt = events.receivedAt(replied)
        if (askedAt !== undefined && repliedAt !== undefined)
          latencies.push(repliedAt - askedAt)
      }
      reportLatencies(
        `serial burst of ${WORKERS} (gate-held ~500ms)`,
        latencies,
      )

      expect(await pendingPermissionIds(client, sandbox.project)).toEqual([])
      // Exactly one model call per prompt — nothing dropped, nothing judged
      // twice — and never more than one in flight.
      expect(provider.classifierRecords.length).toBe(WORKERS)
      expect(provider.maxClassifierInFlight).toBe(1)

      // After the arbitrary first CLASSIFICATION pick (the scheduler never
      // preempts a judgment already in flight), the rest were judged in
      // stack order: remaining workers sorted by session id ascending.
      const sequence = classifiedWorkerSequence(provider)
      const first = sequence[0]
      const expected = workers
        .map((sessionID, index) => ({ sessionID, index }))
        .filter(({ index }) => index !== first)
        .toSorted((a, b) => (a.sessionID < b.sessionID ? -1 : 1))
        .map(({ index }) => index)
      expect(sequence.slice(1)).toEqual(expected)

      // REPLIES carry no such exemption: an approval judged early parks until
      // everything above it is decided, so the replies land in exact stack
      // order — sessions ascending by id, start to finish.
      const replySequence = events.events
        .filter(
          (event): event is PermissionReplied =>
            event.type === "permission.replied",
        )
        .map((event) => event.properties.sessionID)
        .filter((sessionID) => workers.includes(sessionID))
      expect(replySequence).toEqual([...workers].toSorted())

      for (const sessionID of workers) {
        await events.waitFor(isIdle(sessionID), {
          after: mark,
          timeout: 30_000,
          description: `idle for ${sessionID}`,
        })
      }
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, [fixture.server], [events])
      throw error
    }
  })

  test("an approval judged beneath a later, higher prompt parks until that prompt settles", async () => {
    const fixture = await startFixture("approve-for-me-park", {
      command: COMMAND,
    })
    const { sandbox, provider, client, events } = fixture

    try {
      provider.setClassifier({
        verdict: {
          decision: "approve",
          risk: "low",
          authorization: "implied",
          reason: "scripted approval",
        },
        gated: true,
      })

      const mark = events.mark()
      const parent = await createSession(
        client,
        sandbox.project,
        "E2E park parent",
      )
      const older = await createSession(
        client,
        sandbox.project,
        "E2E park older child",
        parent,
      )
      const newer = await createSession(
        client,
        sandbox.project,
        "E2E park newer child",
        parent,
      )
      // Session ids are minted time-DESCENDING: the newer child sorts first,
      // so its prompt stacks ABOVE the older child's in the TUI.
      expect(newer < older).toBe(true)

      // The older child's prompt goes under judgment first…
      await prompt(
        client,
        sandbox.project,
        older,
        `Run the scripted command exactly once. ${workerMarker(0)}`,
      )
      await events.waitFor(isAsked(older), {
        after: mark,
        description: `permission.asked for ${older}`,
      })
      await provider.waitForClassifierCount(1, { timeoutMs: 15_000 })

      // …and while its verdict is held, the newer child's prompt arrives
      // above it: the TUI now shows the NEWER prompt on top.
      await prompt(
        client,
        sandbox.project,
        newer,
        `Run the scripted command exactly once. ${workerMarker(1)}`,
      )
      await events.waitFor(isAsked(newer), {
        after: mark,
        description: `permission.asked for ${newer}`,
      })

      // The older verdict lands — it must NOT execute beneath the undecided
      // prompt above: no reply fires, and the higher prompt is judged next.
      provider.releaseClassifiers(1)
      await provider.waitForClassifierCount(2, { timeoutMs: 15_000 })
      await Bun.sleep(300)
      const repliesSoFar = events.events.filter(
        (event): event is PermissionReplied =>
          event.type === "permission.replied",
      )
      expect(repliesSoFar).toHaveLength(0)

      // The higher verdict releases: both replies land, in stack order.
      provider.releaseClassifiers(1)
      const repliedNewer = await events.waitFor(isReplied(newer), {
        after: mark,
        timeout: 30_000,
        description: `permission.replied for ${newer}`,
      })
      const repliedOlder = await events.waitFor(isReplied(older), {
        after: mark,
        timeout: 30_000,
        description: `permission.replied for ${older}`,
      })
      expect(repliedNewer.properties.reply).toBe("once")
      expect(repliedOlder.properties.reply).toBe("once")
      const replySequence = events.events
        .filter(
          (event): event is PermissionReplied =>
            event.type === "permission.replied",
        )
        .map((event) => event.properties.sessionID)
      expect(replySequence).toEqual([newer, older])
      // Each prompt was judged exactly once, older first — parking never
      // re-classifies, it only defers the reply.
      expect(classifiedWorkerSequence(provider)).toEqual([0, 1])

      expect(await pendingPermissionIds(client, sandbox.project)).toEqual([])
      for (const sessionID of [older, newer]) {
        await events.waitFor(isIdle(sessionID), {
          after: mark,
          timeout: 30_000,
          description: `idle for ${sessionID}`,
        })
      }
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, [fixture.server], [events])
      throw error
    }
  })

  test("a single turn's parallel tool calls are judged concurrently, replies in stack order", async () => {
    const CALLS = 4
    const fixture = await startFixture("approve-for-me-turn-batch", {
      // One user turn, one assistant message, four parallel bash calls: the
      // batch shape the default parallel mode exists for.
      commands: [
        Array.from(
          { length: CALLS },
          (_, index) => `echo scripted-parallel-${index}`,
        ),
      ],
    })
    const { sandbox, provider, client, events } = fixture

    try {
      provider.setClassifier({
        verdict: {
          decision: "approve",
          risk: "low",
          authorization: "implied",
          reason: "scripted approval",
        },
        gated: true,
      })

      const mark = events.mark()
      const session = await createSession(
        client,
        sandbox.project,
        "E2E parallel turn",
      )
      await prompt(
        client,
        sandbox.project,
        session,
        `Run the scripted commands exactly once. ${workerMarker(0)}`,
      )

      // The whole batch goes under judgment at once: all four classifier
      // calls are in flight together while their verdicts are held — under
      // serial this would stall at one.
      await provider.waitForClassifierCount(CALLS, { timeoutMs: 15_000 })
      expect(provider.classifierInFlight).toBe(CALLS)

      // Map stack positions to batch members: each asked event carries its
      // member's command, and stack order is request id ascending.
      await waitFor(
        () => events.events.filter(isAsked(session)).length === CALLS,
        {
          description: "all batch asks observed",
          timeout: 15_000,
        },
      )
      const askedEvents = events.events.filter(isAsked(session))
      const memberOf = (event: PermissionAsked) =>
        Number(
          JSON.stringify(event.properties).match(
            /scripted-parallel-(\d+)/,
          )?.[1] ?? -1,
        )
      const stack = [...askedEvents].sort((a, b) =>
        a.properties.id < b.properties.id ? -1 : 1,
      )
      // The judged member's own command sits on the classifier prompt's
      // "- patterns:" line (tool-trail titles render as "- bash: …" instead).
      const judging = (member: number) => (record: ClassifierRecord) =>
        JSON.stringify(record.request.messages).includes(
          `- patterns: echo scripted-parallel-${member}`,
        )
      // Complete the verdicts BELOW the top first, bottom-up. A FIFO release
      // completes verdicts in dispatch order — which is already stack order —
      // so only out-of-order completion can prove replies gate on the release
      // order: nothing may be answered while the top verdict is still out.
      for (const event of [...stack].reverse().slice(0, CALLS - 1)) {
        expect(
          provider.releaseClassifierMatching(judging(memberOf(event))),
        ).toBe(true)
      }
      await Bun.sleep(500)
      expect(events.events.filter(isReplied(session))).toHaveLength(0)
      // The top verdict settles: every reply lands, strictly in stack order.
      expect(
        provider.releaseClassifierMatching(judging(memberOf(stack[0]!))),
      ).toBe(true)
      await events.waitFor(isIdle(session), {
        after: mark,
        timeout: 30_000,
        description: "parallel turn idle",
      })

      const askedIds = askedEvents.map((event) => event.properties.id)
      expect(askedIds).toHaveLength(CALLS)
      const replies = events.events.filter(isReplied(session))
      // Every prompt was answered by the classifier ("once", never dropped),
      // and even though the verdicts completed out of stack order, the
      // replies landed strictly in stack order: request ids ascending.
      expect(replies.map((event) => event.properties.reply)).toEqual(
        Array(CALLS).fill("once"),
      )
      expect(replies.map((event) => event.properties.requestID)).toEqual(
        [...askedIds].toSorted(),
      )
      expect(provider.classifierRecords.length).toBe(CALLS)
      expect(provider.maxClassifierInFlight).toBe(CALLS)
      expect(await pendingPermissionIds(client, sandbox.project)).toEqual([])
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, [fixture.server], [events])
      throw error
    }
  })

  test('the "serial" opt-in judges a turn\'s parallel calls one prompt at a time', async () => {
    const CALLS = 3
    const fixture = await startFixture("approve-for-me-turn-batch-serial", {
      commands: [
        Array.from(
          { length: CALLS },
          (_, index) => `echo scripted-parallel-${index}`,
        ),
      ],
    })
    const { sandbox, provider, client, events, configDir } = fixture

    try {
      await writeAutoApproveSettings(configDir, sandbox.project, {
        processing: "serial",
      })
      provider.setClassifier({
        verdict: {
          decision: "approve",
          risk: "low",
          authorization: "implied",
          reason: "scripted approval",
        },
        gated: true,
      })

      const mark = events.mark()
      const session = await createSession(
        client,
        sandbox.project,
        "E2E serial turn",
      )
      await prompt(
        client,
        sandbox.project,
        session,
        `Run the scripted commands exactly once. ${workerMarker(0)}`,
      )

      // Same batch shape, opted back into serial: one judgment at a time.
      await provider.waitForClassifierCount(1, { timeoutMs: 15_000 })
      await Bun.sleep(500)
      expect(provider.classifierRecords.length).toBe(1)
      for (let done = 1; done <= CALLS; done += 1) {
        provider.releaseClassifiers(1)
        if (done < CALLS)
          await provider.waitForClassifierCount(done + 1, { timeoutMs: 15_000 })
      }
      await events.waitFor(isIdle(session), {
        after: mark,
        timeout: 30_000,
        description: "serial turn idle",
      })

      const askedIds = events.events
        .filter(isAsked(session))
        .map((event) => event.properties.id)
      const replies = events.events.filter(isReplied(session))
      expect(replies.map((event) => event.properties.reply)).toEqual(
        Array(CALLS).fill("once"),
      )
      expect(replies.map((event) => event.properties.requestID)).toEqual(
        [...askedIds].toSorted(),
      )
      expect(provider.classifierRecords.length).toBe(CALLS)
      expect(provider.maxClassifierInFlight).toBe(1)
      expect(await pendingPermissionIds(client, sandbox.project)).toEqual([])
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, [fixture.server], [events])
      throw error
    }
  })

  test("sub-agent turn batches drain batch by batch, never interleaved", async () => {
    const fixture = await startFixture("approve-for-me-batch-fifo", {
      // Each of two sibling sub-agents issues one turn of two parallel
      // calls: four prompts pending at once, two batches in one tree.
      commands: [["echo scripted-parallel-0", "echo scripted-parallel-1"]],
    })
    const { sandbox, provider, client, events } = fixture

    try {
      provider.setClassifier({
        verdict: {
          decision: "approve",
          risk: "low",
          authorization: "implied",
          reason: "scripted approval",
        },
        gated: true,
      })

      const mark = events.mark()
      const workers = await promptWorkers(fixture, 2)

      // Exactly ONE batch — both calls of one worker's turn — is in flight
      // while its verdicts are held; the other worker's batch waits.
      await provider.waitForClassifierCount(2, { timeoutMs: 15_000 })
      await Bun.sleep(500)
      expect(provider.classifierRecords.length).toBe(2)
      const firstBatch = classifiedWorkerSequence(provider)
      expect(new Set(firstBatch).size).toBe(1)

      // The first batch settles completely, then the second is judged.
      provider.releaseClassifiers(2)
      await provider.waitForClassifierCount(4, { timeoutMs: 15_000 })
      const secondBatch = classifiedWorkerSequence(provider).slice(2)
      expect(new Set(secondBatch).size).toBe(1)
      expect(secondBatch[0]).not.toBe(firstBatch[0])
      provider.releaseClassifiers()

      for (const sessionID of workers) {
        await events.waitFor(isIdle(sessionID), {
          after: mark,
          timeout: 30_000,
          description: `idle for ${sessionID}`,
        })
      }
      // Never more than one batch's worth of concurrent judgments.
      expect(provider.maxClassifierInFlight).toBe(2)
      // Replies land in exact stack order across the whole tree: sessions
      // ascending by id, request ids ascending within each.
      const expected = [...workers].toSorted().flatMap((sessionID) =>
        events.events
          .filter(isAsked(sessionID))
          .map((event) => event.properties.id)
          .toSorted(),
      )
      const replySequence = events.events
        .filter(
          (event): event is PermissionReplied =>
            event.type === "permission.replied" &&
            workers.includes(event.properties.sessionID),
        )
        .map((event) => event.properties.requestID)
      expect(replySequence).toEqual(expected)
      expect(await pendingPermissionIds(client, sandbox.project)).toEqual([])
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, [fixture.server], [events])
      throw error
    }
  })

  test("a user answering a queued prompt wins, and that prompt never costs a model call", async () => {
    const WORKERS = 6
    const fixture = await startFixture("approve-for-me-queue-user-wins", {
      command: COMMAND,
    })
    const { sandbox, provider, client, events } = fixture

    try {
      provider.setClassifier({
        verdict: {
          decision: "approve",
          risk: "low",
          authorization: "implied",
          reason: "scripted approval",
        },
        gated: true,
      })

      const mark = events.mark()
      const workers = await promptWorkers(fixture, WORKERS)
      const askedByWorker = new Map<number, PermissionAsked>()
      for (const [index, sessionID] of workers.entries()) {
        askedByWorker.set(
          index,
          await events.waitFor(isAsked(sessionID), {
            after: mark,
            description: `permission.asked for ${sessionID}`,
          }),
        )
      }

      // Strict serial: one prompt is being judged, everything else waits.
      await provider.waitForClassifierCount(1, { timeoutMs: 15_000 })
      await Bun.sleep(500)
      const inFlight = classifiedWorkers(provider)
      const queued = [...askedByWorker.keys()].filter(
        (index) => !inFlight.has(index),
      )
      expect(queued.length).toBe(WORKERS - 1)

      // The user answers one prompt that is still waiting its turn. Their
      // decision must settle it: the classifier may never spend a model call
      // on it afterwards.
      const answered = queued[0]
      if (answered === undefined) throw new Error("no queued worker to answer")
      const answeredAsk = askedByWorker.get(answered)
      if (!answeredAsk) throw new Error("queued worker has no asked event")
      await replyAsUser(
        client,
        sandbox.project,
        answeredAsk.properties.id,
        "reject",
      )
      const answeredSession = workers[answered]
      if (answeredSession === undefined)
        throw new Error("answered worker has no session")
      const userReplied = await events.waitFor(isReplied(answeredSession), {
        after: mark,
        description: "user reject replied",
      })
      expect(userReplied.properties.reply).toBe("reject")

      provider.setClassifier({
        verdict: {
          decision: "approve",
          risk: "low",
          authorization: "implied",
          reason: "scripted approval",
        },
      })
      provider.releaseClassifiers()

      for (const [index, sessionID] of workers.entries()) {
        if (index === answered) continue
        const replied = await events.waitFor(isReplied(sessionID), {
          after: mark,
          timeout: 30_000,
          description: `permission.replied for ${sessionID}`,
        })
        expect(replied.properties.reply).toBe("once")
      }

      expect(await pendingPermissionIds(client, sandbox.project)).toEqual([])
      // Every worker except the user-answered one cost exactly one call, and
      // they were judged strictly one at a time.
      await Bun.sleep(500)
      expect(provider.classifierRecords.length).toBe(WORKERS - 1)
      expect(classifiedWorkers(provider).has(answered)).toBe(false)
      expect(provider.maxClassifierInFlight).toBe(1)

      for (const sessionID of workers) {
        await events.waitFor(isIdle(sessionID), {
          after: mark,
          timeout: 30_000,
          description: `idle for ${sessionID}`,
        })
      }
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, [fixture.server], [events])
      throw error
    }
  })

  test("a surfaced prompt at the top of the stack stalls everything below it", async () => {
    const fixture = await startFixture("approve-for-me-stall-on-surface", {
      command: COMMAND,
    })
    const { sandbox, provider, client, events } = fixture

    try {
      const mark = events.mark()
      const parent = await createSession(
        client,
        sandbox.project,
        "E2E sub-agent parent",
      )
      const workers = await Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          createSession(
            client,
            sandbox.project,
            `E2E sub-agent ${index}`,
            parent,
          ),
        ),
      )
      // The TUI presents sessions in id order: the first-sorting worker owns
      // the top of the stack. Surface ITS prompt first, so the hold is at the
      // top and everything else genuinely sits below it.
      const [top, ...rest] = [...workers].sort()
      if (top === undefined) throw new Error("no workers to surface")
      provider.setClassifier({
        verdict: {
          decision: "surface",
          risk: "high",
          authorization: "none",
          reason: "needs a human",
        },
      })
      await prompt(
        client,
        sandbox.project,
        top,
        `Run the scripted command exactly once. ${workerMarker(workers.indexOf(top))}`,
      )
      const topAsk = await events.waitFor(isAsked(top), {
        after: mark,
        description: "top worker asked",
      })
      await provider.waitForClassifierCount(1, { timeoutMs: 15_000 })
      // Let the surface verdict land and take hold.
      await Bun.sleep(500)

      // Everything below the held prompt arrives — and must wait for the
      // user, not the classifier.
      provider.setClassifier({
        verdict: {
          decision: "approve",
          risk: "low",
          authorization: "implied",
          reason: "scripted approval",
        },
      })
      for (const sessionID of rest) {
        await prompt(
          client,
          sandbox.project,
          sessionID,
          `Run the scripted command exactly once. ${workerMarker(workers.indexOf(sessionID))}`,
        )
        await events.waitFor(isAsked(sessionID), {
          after: mark,
          description: `permission.asked for ${sessionID}`,
        })
      }
      await Bun.sleep(1_500)
      expect(provider.classifierRecords.length).toBe(1)
      expect(await pendingPermissionIds(client, sandbox.project)).toHaveLength(
        3,
      )

      // The user approves the surfaced top; the tree resumes and drains.
      await replyAsUser(client, sandbox.project, topAsk.properties.id, "once")
      for (const sessionID of rest) {
        const replied = await events.waitFor(isReplied(sessionID), {
          after: mark,
          timeout: 30_000,
          description: `permission.replied for ${sessionID}`,
        })
        expect(replied.properties.reply).toBe("once")
      }
      expect(await pendingPermissionIds(client, sandbox.project)).toEqual([])
      expect(provider.classifierRecords.length).toBe(3)
      expect(provider.maxClassifierInFlight).toBe(1)
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, [fixture.server], [events])
      throw error
    }
  })

  test("prompts orphaned by an aborted run are swept once their session settles", async () => {
    const fixture = await startFixture("approve-for-me-sweeper", {
      command: COMMAND,
    })
    const { sandbox, provider, client, events } = fixture

    try {
      // Hold the classifier so the prompt is still pending when the run dies.
      provider.setClassifier({
        verdict: {
          decision: "approve",
          risk: "low",
          authorization: "implied",
          reason: "scripted approval",
        },
        gated: true,
      })

      const mark = events.mark()
      const [worker] = await promptWorkers(fixture, 1)
      if (worker === undefined) throw new Error("no worker session")
      const askedEvent = await events.waitFor(isAsked(worker), {
        after: mark,
        description: "permission.asked",
      })

      // Aborting the run kills the tool call but leaks the pending prompt on
      // the host (no permission.replied) — the defect the sweeper exists for.
      const aborted = await client.session.abort({
        directory: sandbox.project,
        sessionID: worker,
      })
      if (aborted.error) throw new Error(JSON.stringify(aborted.error))
      await events.waitFor(isIdle(worker), {
        after: mark,
        timeout: 15_000,
        description: "idle after abort",
      })

      // Without any user reply, the sweeper rejects the orphan once the
      // session has settled and the tool call is verifiably dead.
      const swept = await events.waitFor(isReplied(worker), {
        after: mark,
        timeout: 15_000,
        description: "sweeper reject",
      })
      expect(swept.properties.reply).toBe("reject")
      expect(swept.properties.requestID).toBe(askedEvent.properties.id)
      expect(await pendingPermissionIds(client, sandbox.project)).toEqual([])
      // The orphan's classification was gated the whole time: the sweep never
      // waited on (or spent) a verdict.
      provider.releaseClassifiers()
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, [fixture.server], [events])
      throw error
    }
  })

  test("sustained sub-agent pipelines drain completely under model latency", async () => {
    const WORKERS = 5
    const ROUNDS = 3
    const MODEL_LATENCY_MS = 200
    const fixture = await startFixture("approve-for-me-sustained", {
      command: COMMAND,
      // Each worker's single user turn runs three sequential tool calls —
      // three permission prompts arriving as earlier verdicts land, the way
      // working sub-agents actually behave.
      commands: Array.from(
        { length: ROUNDS },
        (_, round) => `echo scripted-round-${round + 1}`,
      ),
    })
    const { sandbox, provider, client, events } = fixture

    try {
      provider.setClassifier({
        verdict: {
          decision: "approve",
          risk: "low",
          authorization: "implied",
          reason: "scripted approval",
        },
        delayMs: MODEL_LATENCY_MS,
      })

      const mark = events.mark()
      const workers = await promptWorkers(fixture, WORKERS)
      for (const sessionID of workers) {
        await events.waitFor(isIdle(sessionID), {
          after: mark,
          timeout: 60_000,
          description: `sustained idle for ${sessionID}`,
        })
      }

      const replies = events.events.filter(
        (event): event is PermissionReplied =>
          event.type === "permission.replied" &&
          workers.includes(event.properties.sessionID),
      )
      expect(replies.length).toBe(WORKERS * ROUNDS)
      for (const replied of replies)
        expect(replied.properties.reply).toBe("once")
      expect(provider.classifierRecords.length).toBe(WORKERS * ROUNDS)
      // One shared tree: strictly one judgment at a time, round after round.
      expect(provider.maxClassifierInFlight).toBe(1)
      expect(await pendingPermissionIds(client, sandbox.project)).toEqual([])

      // Latency report: asked → replied per prompt, with the injected model
      // latency called out so plugin overhead is readable at a glance.
      const askedTimes = new Map<string, number>()
      for (const [index, event] of events.events.entries()) {
        if (
          event.type === "permission.asked" &&
          workers.includes(event.properties.sessionID)
        ) {
          const askedAt = events.times[index]
          if (askedAt !== undefined)
            askedTimes.set(event.properties.id, askedAt)
        }
      }
      const latencies: number[] = []
      for (const replied of replies) {
        const askedAt = askedTimes.get(replied.properties.requestID)
        const repliedAt = events.receivedAt(replied)
        if (askedAt !== undefined && repliedAt !== undefined)
          latencies.push(repliedAt - askedAt)
      }
      reportLatencies(
        `sustained ${WORKERS}×${ROUNDS} prompts (injected model latency ${MODEL_LATENCY_MS}ms)`,
        latencies,
      )
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, [fixture.server], [events])
      throw error
    }
  })

  test("keeps instance toggles isolated when two real servers share project state", async () => {
    // OFF has no completion event: this is bounded negative evidence, not a
    // guarantee that a classifier can never dispatch later on a stalled host.
    const quietWindow = { duration: 5_000 }
    const sandbox = await createSandbox("approve-for-me-shared-instance-state")
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
      // Unlike sandbox.environment("a") and ("b"), these two hosts share
      // the actual state root and config while keeping disposable caches apart.
      const sharedStateHome = path.join(sandbox.root, "shared-state")
      await fs.mkdir(sharedStateHome, { recursive: true })
      const [environmentA, environmentB] = await Promise.all([
        sandbox.environment("server-a", { XDG_STATE_HOME: sharedStateHome }),
        sandbox.environment("server-b", { XDG_STATE_HOME: sharedStateHome }),
      ])
      if (
        !environmentA.OPENCODE_CONFIG_DIR ||
        !environmentB.OPENCODE_CONFIG_DIR
      )
        throw new Error("sandbox omitted OPENCODE_CONFIG_DIR")
      expect(environmentA.XDG_STATE_HOME).toBe(sharedStateHome)
      expect(environmentB.XDG_STATE_HOME).toBe(sharedStateHome)
      expect(environmentA.OPENCODE_CONFIG_DIR).toBe(
        environmentB.OPENCODE_CONFIG_DIR,
      )
      await blessAutoApproveProjectConfig(sharedStateHome, sandbox.project)

      const serverA = await startOpenCode({
        cwd: sandbox.project,
        env: environmentA,
      })
      processes.push(serverA)
      const clientA = clientFor(serverA, sandbox.project)
      const eventsA = await EventRecorder.connect(clientA)
      recorders.push(eventsA)
      const instanceA = await requestInstanceID(
        eventsA.tuiDiscoveryApi(clientA, sandbox.project),
      )
      if (!instanceA) throw new Error("could not discover server A instance ID")
      const stateDir = path.join(sharedStateHome, "opencode")
      const overrideA = overrideFile(stateDir, sandbox.project, instanceA)
      const activityA = activityFile(stateDir, sandbox.project, instanceA)
      await writeOverride(overrideA, { enabled: false, at: Date.now() })
      expect(await readOverride(overrideA)).toMatchObject({ enabled: false })

      // Starting B performs its normal initialization against the same state
      // root. It must not migrate, consume, or remove A's owned OFF record.
      const serverB = await startOpenCode({
        cwd: sandbox.project,
        env: environmentB,
      })
      processes.push(serverB)
      const clientB = clientFor(serverB, sandbox.project)
      const eventsB = await EventRecorder.connect(clientB)
      recorders.push(eventsB)
      const instanceB = await requestInstanceID(
        eventsB.tuiDiscoveryApi(clientB, sandbox.project),
      )
      if (!instanceB) throw new Error("could not discover server B instance ID")
      expect(instanceB).not.toBe(instanceA)
      const overrideB = overrideFile(stateDir, sandbox.project, instanceB)
      const activityB = activityFile(stateDir, sandbox.project, instanceB)
      expect(overrideB).not.toBe(overrideA)
      expect(await readOverride(overrideA)).toMatchObject({ enabled: false })
      expect(await readOverride(overrideB)).toBeUndefined()

      const offA = await createSession(
        clientA,
        sandbox.project,
        "E2E server A initially off",
      )
      const offAMark = eventsA.mark()
      await prompt(
        clientA,
        sandbox.project,
        offA,
        "A stays off after B starts.",
      )
      const offAAsked = await eventsA.waitFor(isAsked(offA), {
        after: offAMark,
        description: "server A OFF permission.asked",
      })
      await assertFor(() => {
        expect(provider.classifierRequests).toHaveLength(0)
        expect(eventsA.events.filter(isReplied(offA))).toHaveLength(0)
      }, quietWindow)
      expect(await pendingPermissionIds(clientA, sandbox.project)).toContain(
        offAAsked.properties.id,
      )
      await replyAsUser(
        clientA,
        sandbox.project,
        offAAsked.properties.id,
        "once",
      )
      await eventsA.waitFor(isIdle(offA), {
        after: offAMark,
        description: "server A OFF idle",
      })

      const onB = await createSession(
        clientB,
        sandbox.project,
        "E2E server B remains on",
      )
      const onBMark = eventsB.mark()
      await prompt(clientB, sandbox.project, onB, "B remains independently on.")
      await eventsB.waitFor(isReplied(onB), {
        after: onBMark,
        description: "server B independent auto-approval",
      })
      await eventsB.waitFor(isIdle(onB), {
        after: onBMark,
        description: "server B independent approval idle",
      })
      expect(provider.classifierRequests).toHaveLength(1)

      // Simultaneous owner-scoped writes model interleaved TUI toggles. Each
      // server must subsequently honor only its own state file.
      await Promise.all([
        writeOverride(overrideA, { enabled: true, at: Date.now() }),
        writeOverride(overrideB, { enabled: false, at: Date.now() }),
      ])
      expect(await readOverride(overrideA)).toMatchObject({ enabled: true })
      expect(await readOverride(overrideB)).toMatchObject({ enabled: false })

      const onA = await createSession(
        clientA,
        sandbox.project,
        "E2E server A independently on",
      )
      const onAMark = eventsA.mark()
      await prompt(clientA, sandbox.project, onA, "A is independently on.")
      await eventsA.waitFor(isReplied(onA), {
        after: onAMark,
        description: "server A independent auto-approval",
      })
      await eventsA.waitFor(isIdle(onA), {
        after: onAMark,
        description: "server A independent approval idle",
      })
      expect(provider.classifierRequests).toHaveLength(2)

      const offB = await createSession(
        clientB,
        sandbox.project,
        "E2E server B independently off",
      )
      const offBMark = eventsB.mark()
      await prompt(clientB, sandbox.project, offB, "B is independently off.")
      const offBAsked = await eventsB.waitFor(isAsked(offB), {
        after: offBMark,
        description: "server B OFF permission.asked",
      })
      await assertFor(() => {
        expect(provider.classifierRequests).toHaveLength(2)
        expect(eventsB.events.filter(isReplied(offB))).toHaveLength(0)
      }, quietWindow)
      expect(await pendingPermissionIds(clientB, sandbox.project)).toContain(
        offBAsked.properties.id,
      )
      await replyAsUser(
        clientB,
        sandbox.project,
        offBAsked.properties.id,
        "once",
      )
      await eventsB.waitFor(isIdle(offB), {
        after: offBMark,
        description: "server B OFF idle",
      })

      await writeOverride(overrideA, { enabled: false, at: Date.now() })
      const [overrideABeforeDispose, activityABeforeDispose] =
        await Promise.all([
          fs.readFile(overrideA, "utf8"),
          fs.readFile(activityA, "utf8"),
        ])
      // Both B-owned files must exist before exercising their removal.
      await Promise.all([fs.access(overrideB), fs.access(activityB)])
      // Stop the SDK stream from reconnecting and bootstrapping a new B
      // instance. serve's SIGTERM does not run plugin dispose hooks; the
      // global HTTP route awaits them without stopping the server process.
      await eventsB.close()
      const disposedB = await clientB.global.dispose({
        signal: AbortSignal.timeout(20_000),
      })
      if (disposedB.error) throw new Error(JSON.stringify(disposedB.error))
      expect(disposedB.data).toBe(true)
      expect(serverB.isRunning()).toBe(true)
      await expect(fs.stat(overrideB)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(fs.stat(activityB)).rejects.toMatchObject({ code: "ENOENT" })
      expect(await fs.readFile(overrideA, "utf8")).toBe(overrideABeforeDispose)
      expect(await fs.readFile(activityA, "utf8")).toBe(activityABeforeDispose)
      await serverB.stop()
      expect(await readOverride(overrideA)).toMatchObject({ enabled: false })

      const offAfterPeerDispose = await createSession(
        clientA,
        sandbox.project,
        "E2E server A off after B disposal",
      )
      const peerDisposeMark = eventsA.mark()
      await prompt(
        clientA,
        sandbox.project,
        offAfterPeerDispose,
        "A remains off after B disposes its instance.",
      )
      const peerDisposeAsked = await eventsA.waitFor(
        isAsked(offAfterPeerDispose),
        {
          after: peerDisposeMark,
          description: "server A OFF after B disposal permission.asked",
        },
      )
      await assertFor(() => {
        expect(provider.classifierRequests).toHaveLength(2)
        expect(
          eventsA.events.filter(isReplied(offAfterPeerDispose)),
        ).toHaveLength(0)
      }, quietWindow)
      expect(await pendingPermissionIds(clientA, sandbox.project)).toContain(
        peerDisposeAsked.properties.id,
      )
      await replyAsUser(
        clientA,
        sandbox.project,
        peerDisposeAsked.properties.id,
        "once",
      )
      await eventsA.waitFor(isIdle(offAfterPeerDispose), {
        after: peerDisposeMark,
        description: "server A OFF after B disposal idle",
      })
      expect(provider.classifierRequests).toHaveLength(2)
    } catch (error) {
      await writeFailureArtifacts(sandbox, provider, processes, recorders)
      throw error
    }
  })
})

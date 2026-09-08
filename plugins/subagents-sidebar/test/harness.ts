import { makeTuiApi } from "@macarons/plugin-test-harness/tui"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

type Api = Parameters<TuiPlugin>[0]

// subagents-sidebar's api mock — the shared core plus what this plugin's
// entry actually reads: the record-backed session store (messages, parts,
// statuses, permissions, questions), the server-side client dispatchers the
// hydration paths call, and the single-occupancy dialog. Shared by the engine
// tests (bus handler, tracking, dialog, compat gate) and the rendering tests
// (view.test.tsx), which mount the registered sidebar slot under
// @opentui/solid's headless test renderer.

export type MockMessage = { role: string; id: string }

export type MockTaskState = {
  status: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
  title?: string
  time?: { start?: number; end?: number }
}

export type MockPart = {
  id: string
  sessionID: string
  messageID: string
  type: string
  tool?: string
  callID?: string
  state?: MockTaskState
}

// `time` is required, as on the real Session record: the plugin reads
// `.time.updated` off any child record that exists, so a fixture without one
// would pass a test and throw in the host.
export type MockSession = {
  id: string
  parentID?: string
  directory?: string
  time: { created: number; updated: number }
}

export type MockStatus = { type: string }

/** One entry of the client's full-history reply: message info + its parts. */
export type MockHistoryMessage = { info: MockMessage; parts: MockPart[] }

export function makeApi(
  input: {
    version?: string | null
    baseUrl?: string
    routeName?: string
    routeSessionID?: string
  } = {},
) {
  const base = makeTuiApi({ ...input, paths: { directory: "/project" } })
  const messages = new Map<string, MockMessage[]>()
  const parts = new Map<string, MockPart[]>()
  const sessionRecords = new Map<string, MockSession>()
  const statuses = new Map<string, MockStatus>()
  const permissions = new Map<string, unknown[]>()
  const questions = new Map<string, unknown[]>()
  // What the server-side client hands back, distinct from the synced store
  // above: the hydration paths read these, the store reads never do.
  const clientMessages = new Map<string, MockHistoryMessage[]>()
  const clientChildren = new Map<string, MockSession[] | undefined>()
  const clientStatus: {
    data: Record<string, MockStatus> | undefined
  } = { data: undefined }
  const missingClientSessions = new Set<string>()
  const pendingPermissions: { id: string; sessionID: string }[] = []
  const pendingQuestions: { id: string; sessionID: string }[] = []
  // Domain-shaped navigate recorder ({name, params}, not the core's raw args
  // arrays): the dialog tests assert whole navigation objects.
  const navigations: { name: string; params?: Record<string, unknown> }[] = []
  // The single-occupancy dialog: `replace` immediately runs the render
  // callback (the host defers to its reactive scope; for engine tests a
  // synchronous call is equivalent) and stores what DialogSelect received.
  const dialogs: Record<string, any>[] = []
  let dialogClears = 0

  base.api.ui.DialogSelect = (props: Record<string, unknown>) => props
  base.api.ui.dialog = {
    replace: (render: () => unknown, _onClose?: () => void) => {
      dialogs.push(render() as Record<string, any>)
    },
    clear: () => {
      dialogClears++
    },
  }
  base.api.state.session = {
    get: (sessionID: string) => sessionRecords.get(sessionID),
    messages: (sessionID: string) => messages.get(sessionID) ?? [],
    status: (sessionID: string) => statuses.get(sessionID),
    permission: (sessionID: string) => permissions.get(sessionID) ?? [],
    question: (sessionID: string) => questions.get(sessionID) ?? [],
  }
  base.api.state.part = (messageID: string) => parts.get(messageID) ?? []
  base.api.route.navigate = (
    name: string,
    params?: Record<string, unknown>,
  ) => {
    navigations.push({ name, params })
  }
  // Grafted next to the core's _client transport, which the compat gate reads.
  base.api.client.session = {
    messages: async ({ sessionID }: { sessionID: string }) => ({
      data: clientMessages.get(sessionID) ?? [],
    }),
    children: async ({ sessionID }: { sessionID: string }) => ({
      data: clientChildren.get(sessionID),
    }),
    status: async () => ({ data: clientStatus.data }),
    get: async ({ sessionID }: { sessionID: string }) => ({
      data: missingClientSessions.has(sessionID)
        ? undefined
        : (sessionRecords.get(sessionID) ?? { id: sessionID }),
    }),
  }
  base.api.client.permission = {
    list: async () => ({ data: pendingPermissions.slice() }),
  }
  base.api.client.question = {
    list: async () => ({ data: pendingQuestions.slice() }),
  }

  const emitPartUpdated = (part: MockPart) => {
    base.emit("message.part.updated", { sessionID: part.sessionID, part })
  }

  const emitSessionDeleted = (sessionID: string, parentID?: string) => {
    base.emit("session.deleted", {
      sessionID,
      info: { id: sessionID, parentID },
    })
  }

  return {
    ...base,
    api: base.api as unknown as Api,
    messages,
    parts,
    sessionRecords,
    statuses,
    permissions,
    questions,
    clientMessages,
    clientChildren,
    clientStatus,
    missingClientSessions,
    pendingPermissions,
    pendingQuestions,
    navigations,
    dialogs,
    dialogClears: () => dialogClears,
    emitPartUpdated,
    emitSessionDeleted,
  }
}

let partCounter = 0

/** A `task` tool part in `sessionID`, defaulting to a foreground running call. */
export function taskPart(
  over: Omit<Partial<MockPart>, "state"> & {
    state?: Partial<MockTaskState>
  } = {},
  sessionID = "ses_1",
): MockPart {
  partCounter++
  const id = over.id ?? `prt_task_${String(partCounter).padStart(3, "0")}`
  return {
    id,
    sessionID,
    messageID: over.messageID ?? "msg_1",
    type: "tool",
    tool: "task",
    callID: over.callID ?? `call_${id}`,
    ...over,
    state: {
      status: "running",
      input: { subagent_type: "explore", description: "find the sync path" },
      metadata: { sessionId: "ses_child_1" },
      time: { start: 1_700_000_000_000 },
      ...over.state,
    },
  }
}

/** Seed one parent message and register `part` in the synced store. */
export function seedTask(
  harness: ReturnType<typeof makeApi>,
  part: MockPart,
  sessionID = "ses_1",
) {
  const childID = part.state?.metadata?.sessionId
  if (typeof childID === "string" && !harness.sessionRecords.has(childID))
    harness.sessionRecords.set(childID, {
      id: childID,
      parentID: sessionID,
      directory: harness.api.state.path.directory,
      // The host stamps child activity at run start, not the spawn part's end.
      time: {
        created: part.state?.time?.start ?? 0,
        updated: part.state?.time?.start ?? 0,
      },
    })
  const existing = harness.messages.get(sessionID) ?? []
  if (!existing.some((message) => message.id === part.messageID))
    harness.messages.set(sessionID, [
      ...existing,
      { role: "assistant", id: part.messageID },
    ])
  harness.parts.set(part.messageID, [
    ...(harness.parts.get(part.messageID) ?? []).filter(
      (held) => held.id !== part.id,
    ),
    part,
  ])
}

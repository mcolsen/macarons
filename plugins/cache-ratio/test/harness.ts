import { tick } from "@macarons/plugin-test-harness"
import { makeTuiApi } from "@macarons/plugin-test-harness/tui"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

type Api = Parameters<TuiPlugin>[0]

// cache-ratio's api mock — the shared core plus what this plugin's entry
// actually reads: the host-synced message and part stores, and the server's
// one-shot full-history fetch. Shared by the engine tests (event handler,
// toast, slot registration, compat gate) and the rendering tests
// (view.test.tsx), which mount the registered sidebar slot under
// @opentui/solid's headless test renderer.
export type MockMessage = {
  role: string
  id: string
  providerID: string
  modelID: string
  summary?: boolean
  time: { created: number; completed?: number }
}

export type MockTokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type MockPart = {
  id: string
  sessionID: string
  messageID: string
  type: string
  tokens?: MockTokens
}

export function makeApi(
  input: {
    version?: string | null
    baseUrl?: string
    routeName?: string
    routeSessionID?: string
    parentID?: string
    /**
     * Make the one-shot history fetch reject, so the seed's fail path runs
     * (`entry.history = "failed"` in its `.catch`). Default behavior is
     * unchanged: the fetch resolves with the seeded history.
     */
    messagesReject?: boolean
  } = {},
) {
  const base = makeTuiApi(input)
  const messages = new Map<string, MockMessage[]>()
  const parts = new Map<string, MockPart[]>()
  // Full server-side history, as the one-shot seed fetch would return it.
  const history = new Map<string, { info: MockMessage; parts: MockPart[] }[]>()
  // Counts every call to the fake `client.session.messages`, so a test can pin
  // that the full-history seed fires at most once per session (the pending
  // latch in seedHistory).
  let messagesCalls = 0

  // Graft the domain surface onto the core: the synced stores the engine
  // reads reactively, and the server's full-history endpoint it seeds from.
  base.api.state.session.messages = (sessionID: string) =>
    messages.get(sessionID) ?? []
  base.api.state.part = (messageID: string) => parts.get(messageID) ?? []
  base.api.client.session = {
    messages: async ({ sessionID }: { sessionID: string }) => {
      messagesCalls++
      if (input.messagesReject) throw new Error("history fetch failed")
      return { data: history.get(sessionID) ?? [] }
    },
  }

  return {
    ...base,
    api: base.api as unknown as Api,
    messages,
    parts,
    history,
    // How many times the seed's `client.session.messages` has been called.
    messagesCalls: () => messagesCalls,
    emitPartUpdated: (part: MockPart, time: number) =>
      base.emit("message.part.updated", {
        sessionID: part.sessionID,
        part,
        time,
      }),
    emitSessionDeleted: (sessionID: string) =>
      base.emit("session.deleted", { sessionID, info: { id: sessionID } }),
  }
}

/**
 * `seedHealthySession` for an arbitrary session id. Message and part ids are
 * derived from it so several seeded sessions can coexist — `parts` is keyed by
 * message id across the whole fixture, not per session.
 */
export function seedHealthySessionFor(
  harness: ReturnType<typeof makeApi>,
  sessionID: string,
  now: number,
) {
  const previous = `msg_${sessionID}_1`
  const current = `msg_${sessionID}_2`
  harness.messages.set(sessionID, [
    assistant(previous, {
      time: { created: now - 120_000, completed: now - 60_000 },
    }),
    assistant(current, { time: { created: now } }),
  ])
  harness.parts.set(previous, [
    stepFinish(
      `prt_${sessionID}_prev`,
      previous,
      { input: 2_000, cache: { read: 100_000, write: 3_000 } },
      sessionID,
    ),
  ])
}

/** The breaking request for a session seeded by `seedHealthySessionFor`. */
export function breakingPartFor(sessionID: string): MockPart {
  return stepFinish(
    `prt_${sessionID}_cur`,
    `msg_${sessionID}_2`,
    { input: 2_000, cache: { read: 1_000, write: 104_000 } },
    sessionID,
  )
}

/**
 * Make `count` distinct background sessions known to the engine. One step-start
 * each is enough: the bus handler tolerates a missing message for step-start
 * (it returns before the alert path), so no message fixtures are needed.
 */
export function floodSessions(
  harness: ReturnType<typeof makeApi>,
  count: number,
  prefix = "ses_bg_",
) {
  for (let index = 0; index < count; index++) {
    harness.emitPartUpdated(
      stepStart("prt_s1", "msg_bg", `${prefix}${index}`),
      1,
    )
  }
}

/** Let the engine's async full-history seed settle. */
export const settle = tick

export function assistant(
  id: string,
  over: Partial<MockMessage> = {},
): MockMessage {
  return {
    role: "assistant",
    id,
    providerID: "anthropic",
    modelID: "claude-sonnet-5",
    time: { created: 1_000_000 },
    ...over,
  }
}

export function stepFinish(
  id: string,
  messageID: string,
  tokens: Omit<Partial<MockTokens>, "cache"> & {
    cache?: { read?: number; write?: number }
  },
  sessionID = "ses_1",
): MockPart {
  return {
    id,
    sessionID,
    messageID,
    type: "step-finish",
    tokens: {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cache: { read: tokens.cache?.read ?? 0, write: tokens.cache?.write ?? 0 },
    },
  }
}

export function stepStart(
  id: string,
  messageID: string,
  sessionID = "ses_1",
): MockPart {
  return { id, sessionID, messageID, type: "step-start" }
}

/** A session whose previous request read 100k cached tokens, moments ago. */
export function seedHealthySession(
  harness: ReturnType<typeof makeApi>,
  now: number,
) {
  harness.messages.set("ses_1", [
    assistant("msg_1", {
      time: { created: now - 120_000, completed: now - 60_000 },
    }),
    assistant("msg_2", { time: { created: now } }),
  ])
  harness.parts.set("msg_1", [
    stepFinish("prt_prev", "msg_1", {
      input: 2_000,
      cache: { read: 100_000, write: 3_000 },
    }),
  ])
}

/** The classic break signature: reads collapse, the whole context re-writes. */
export function breakingPart(): MockPart {
  return stepFinish("prt_cur", "msg_2", {
    input: 2_000,
    cache: { read: 1_000, write: 104_000 },
  })
}

/**
 * Drive ses_1 through a start-to-start TTL expiry: step N started long ago
 * (its tool held minutes on a permission prompt), step N+1 re-paid the whole
 * context moments later. Leaves the expiry notice — and its fade timer —
 * pending.
 */
export function emitExpiredSequence(
  harness: ReturnType<typeof makeApi>,
  now: number,
) {
  const started = now - 460_000
  harness.messages.set("ses_1", [
    assistant("msg_2", { time: { created: started } }),
  ])
  harness.emitPartUpdated(stepStart("prt_a1", "msg_2"), started)
  const healthyFinish = stepFinish("prt_a2", "msg_2", {
    input: 2_000,
    cache: { read: 100_000, write: 3_000 },
  })
  harness.emitPartUpdated(healthyFinish, now - 10_000)
  harness.parts.set("msg_2", [healthyFinish])
  harness.emitPartUpdated(stepStart("prt_b1", "msg_2"), now - 10_000)
  harness.emitPartUpdated(
    stepFinish("prt_b2", "msg_2", {
      input: 2_000,
      cache: { read: 1_000, write: 104_000 },
    }),
    now,
  )
}

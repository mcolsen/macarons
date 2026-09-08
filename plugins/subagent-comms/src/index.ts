import {
  appLogger,
  every,
  parseModelRef,
  promptIdentityBody,
  type Rule,
  reportServerCompat,
  SESSION_STATUS_PROBE_TIMEOUT_MS,
  serverToast,
  sessionActivityFromEvent,
  trim,
  unrefTimer,
  unsupportedVersionHooks,
  unwrap,
  withTimeout,
} from "@macarons/permission-rules"
import { type Plugin, tool } from "@opencode-ai/plugin"
import {
  type ChildMessage,
  type ChildOutcome,
  type ChildSummary,
  childLine,
  clampWaitTimeout,
  deliveredText,
  deriveChildPermission,
  ENDED_WITHOUT_REPLY_TEXT,
  extractChildOutcome,
  findCatalogModel,
  formatDuration,
  GRACE_SPACING_MS,
  hasInjectedMessage,
  IDLE_CHECKS_BEFORE_ENDED,
  INJECT_CONFIRM_POLL_MS,
  INVALID_MODEL_REF_ERROR,
  initialLaunchText,
  KILL_CONFIRM_MS,
  killedDeletedText,
  killedIdleText,
  killedText,
  MAX_TIMER_MS,
  MESSAGE_COUNTER_MAX,
  MODEL_CATALOG_READ_ERROR,
  type ModelCatalog,
  mintMessageID,
  NO_CHILDREN_MESSAGE,
  newestUserMessageID,
  notDirectChildError,
  notificationText,
  PLUGIN_DISPOSED_MESSAGE,
  type PromptIdentity,
  parseChildMessages,
  parseModelCatalog,
  renderModelCatalog,
  renderTaskBlock,
  resolveServerOptions,
  rulesetOf,
  SEND_ABORTED_BEFORE_DELIVERY_MESSAGE,
  SEND_ABORTED_MESSAGE,
  SEND_DENIED_MESSAGE,
  SERVICE,
  type SessionCreateBody,
  SPAWN_ABORTED_MESSAGE,
  SUBAGENT_KILL_DESCRIPTION,
  SUBAGENT_MODELS_DESCRIPTION,
  sendTimedOutText,
  sessionPromptIdentity,
  spawnDeniedError,
  spawnLockdownReadError,
  spawnModelReadError,
  spawnStartedText,
  subagentDepthLimitError,
  subagentListDescription,
  subagentSendDescription,
  subagentSpawnDescription,
  subagentWaitDescription,
  taskHint,
  tooManyBusyChildrenError,
  truncateLabel,
  truncateReply,
  unavailableModelError,
  unavailableVariantError,
  unconfirmedDeliveryText,
  unknownAgentError,
  WAIT_ABORTED_MESSAGE,
  WAIT_MAX_TIMEOUT_MS,
} from "./shared"

/**
 * @macarons/subagent-comms — server half (the whole plugin; no TUI)
 *
 * Gives the agent Claude Code-style communication with its subagents,
 * complementary to the builtin task tool (which keeps foreground spawning and
 * task_id resume). Six tools, registered through the plugin tool API:
 *
 *   - subagent_spawn  start a subagent in the background (child session +
 *                     promptAsync) — enforces the stock task tool's
 *                     subagent_depth boundary, then asks under the same
 *                     "task" permission action the builtin asserts, so user
 *                     rules and the host's no-nested-subagents deny govern
 *                     it unchanged
 *   - subagent_send   message a direct child; asks under "task" like a stock
 *                     task_id resume (commanding an existing child is the
 *                     same capability as spawning one); by default blocks
 *                     for the reply (a busy child absorbs the message as a
 *                     steer)
 *   - subagent_list   direct children with busy/idle status
 *   - subagent_wait   block until children finish, with timeout; an
 *                     explicitly named idle child returns its latest
 *                     completed result instead
 *   - subagent_kill   abort a child's in-flight run; the session survives
 *   - subagent_models list provider-catalog models and supported variants
 *
 * When a tracked subagent (spawned, or messaged without waiting) finishes,
 * the parent session is notified with the reply inlined via a plain prompt —
 * the stock background-subagent delivery. The host's runner merges it into a
 * run already in flight and starts one on an idle parent, atomically, so no
 * busy-vs-idle check (and no noReply race against the parent going idle
 * between check and injection) is needed.
 *
 * Reply collection never uses the blocking POST /message route (it would
 * hold the HTTP request for the child's whole run with no timeout control).
 * Instead: mint the injected user message's own id (the prompt routes honor
 * a caller-supplied messageID), promptAsync, confirm the minted message
 * actually became visible (204 only means the host FORKED the prompt op;
 * an early failure in that fork would otherwise wedge the watchers keyed to
 * the id), then resolve on session.idle/session.status events with an
 * interval poll as missed-event insurance, running only while something is
 * watched. A reply is an assistant message whose parentID points at or past
 * the minted id — exact correlation, so a previous run's reply can never be
 * mistaken for ours. Every prompt this plugin injects echoes the target
 * session's current agent/model/variant back (sessionPromptIdentity) — the
 * host otherwise re-pins prompted sessions onto the default agent and
 * strips their variant.
 *
 * Addressing is stateless — a target is valid iff its parentID is the
 * calling session — so children spawned by the builtin task tool are first-
 * class targets and a server restart orphans nothing but in-flight
 * notification registrations (accepted, like background-tasks' crash
 * orphans).
 *
 * Targets OpenCode v1; verified against 1.17.18–1.18.x (the plugin tool API,
 * promptAsync noReply/agent, GET /session/:id/children, and the session-create
 * body fields this package relies on). Outside that band it warns but runs;
 * only OpenCode v2+ (whose plugin API differs) disables it. All host calls go
 * through the injected v1 SDK client — never fetch(serverUrl), which is unbound
 * in the standalone TUI.
 */

/** Bounded transcript tail per settle; anchor visibility is remembered separately. */
const MESSAGES_FETCH_LIMIT = 50
const TITLE_MAX_CHARS = 40
const LABEL_MAX_CHARS = 50
const MODEL_CATALOG_TIMEOUT_MS = 10_000
/** Initial delivery plus three delayed retries; the poll interval supplies the base. */
const NOTIFY_RETRY_BACKOFF = [1, 2, 4] as const

type WaitOutcome =
  | { kind: "replied"; messageID: string; text: string }
  | { kind: "errored"; error: string }
  | { kind: "ended" }
  | { kind: "timeout" }
  | { kind: "deleted" }

type ReplyAnchor = {
  /** Minted or observed user-message id against which replies correlate. */
  messageID: string
  /** Monotonic: once visible, a later bounded transcript cannot unsee it. */
  observed: boolean
  /** Initial launch only; the reconciliation budget survives claim/restore. */
  initial?: { deadline: number; parked: boolean }
}

/** A newer reply can cover a known prompt, but only an exact parent proves an unseen one existed. */
const hasReplyAnchor = (messages: ChildMessage[], messageID: string): boolean =>
  hasInjectedMessage(messages, messageID) ||
  messages.some(
    (message) => message.role === "assistant" && message.parentID === messageID,
  )

type Waiter = {
  /**
   * The user message this waiter follows. Undefined accepts any completion
   * (kill confirmation and explicit idle-result collection).
   */
  replyAnchor: ReplyAnchor | undefined
  idleChecks: number
  lastIdleObservedAt: number
  settle: (outcome: WaitOutcome) => void
  fail: (error: Error) => void
}

type NotifyDeliveryState = "pending" | "retry" | "ambiguous" | "terminal"

type PendingNotify = {
  parentID: string
  childID: string
  /** Injected user message the completion must answer. */
  replyAnchor: ReplyAnchor
  label: string
  startedAt: number
  idleChecks: number
  lastIdleObservedAt: number
  /** The "finished" toast fired once; kept true across delivery retries. */
  toasted?: boolean
  /** Stable identity for the current parent-prompt attempt, minted at dispatch. */
  deliveryMessageID?: string
  deliveryState: NotifyDeliveryState
  deliveryFailures: number
  nextDeliveryAt: number
  deliveryAlerted?: "ambiguous" | "terminal"
  /**
   * A dispatch or same-identity confirmation is in flight. The entry stays in
   * the map until delivery is confirmed or manually collected; this flag stops
   * concurrent settle/poll ticks from acting on it twice.
   */
  delivering?: boolean
}

const pollableNotify = (entry: PendingNotify): boolean =>
  !entry.replyAnchor.initial?.parked &&
  entry.deliveryState !== "ambiguous" &&
  entry.deliveryState !== "terminal"

class PromptRejectedError extends Error {}

export const SubagentCommsPlugin: Plugin = async (
  { client, directory, serverUrl },
  rawOptions,
) => {
  const log = appLogger(client, SERVICE)

  const compat = await reportServerCompat({
    client,
    serverUrl,
    label: "Subagent communication",
    service: SERVICE,
    log,
  })
  // Only a non-v1 host disables the plugin; the deferred toast surfaces that
  // at the first permission prompt. A merely untested v1 host runs on.
  if (compat?.disable)
    return unsupportedVersionHooks(client, directory, compat.message)

  const options = resolveServerOptions(rawOptions)
  const toast = serverToast(client, { directory, title: "Subagent finished" })

  // ---- state ----------------------------------------------------------------

  const waiters = new Map<string, Set<Waiter>>()
  const notifies = new Map<string, PendingNotify[]>()
  /**
   * Kill tombstones cover off-map claims and spawns still confirming their
   * prompt. No live note does not mean no registration can arrive later; keep
   * the id until session deletion/disposal rather than evicting that protection.
   */
  const clearedInitialLaunches = new Set<string>()
  /**
   * Last known non-idle children, from status events and from what a settle
   * read. Only ever a HINT: every decision reads the endpoint first (see
   * isBusy), and this answers when that read fails.
   */
  const busySessions = new Set<string>()
  /** Aborted by dispose() so a status read cannot outlive the plugin. */
  const disposeSignal = new AbortController()
  // In-flight subagent_spawn reservations per parent: a spawn that has passed
  // the busy-children cap but not yet created its child holds a slot here, so
  // parallel spawns cannot all clear the same status snapshot and blow past the
  // limit. Released (in a finally) once the child is created and its notify
  // registered, after which the notify keeps the slot counted.
  const pendingSpawns = new Map<string, number>()
  let disposed = false

  // ---- SDK plumbing ----------------------------------------------------------

  type RawSession = {
    id: string
    parentID?: string
    title?: string
    agent?: unknown
    time?: { updated?: number }
    permission?: unknown
  }

  const getSession = async (id: string): Promise<RawSession> =>
    unwrap(
      await client.session.get({ path: { id }, query: { directory } }),
      `looking up session ${id}`,
    ) as RawSession

  /**
   * Classify a session lookup WITHOUT throwing, so a settle can tell a genuine
   * deletion apart from a transient blip. The host answers a missing session
   * with HTTP 404 / body {name:"NotFoundError"} (SessionError.mapStorageNotFound
   * → ApiError.notFound); any other failure — 500, a transport error that
   * rejects the call outright, the in-process client returning a non-JSON
   * error string — is transient and must read as "unknown" so the caller
   * retries rather than mistake a blip for a deletion. Both the response status
   * and the error name are checked because the standalone-TUI in-process client
   * may not surface a real Response object.
   */
  const sessionExistence = async (
    id: string,
  ): Promise<"exists" | "missing" | "unknown"> => {
    let result: {
      data?: unknown
      error?: unknown
      response?: { status?: number }
    }
    try {
      result = await withTimeout(
        (signal) =>
          client.session.get({ path: { id }, query: { directory }, signal }),
        options.injectConfirmTimeoutMs,
        { signal: disposeSignal.signal },
      )
    } catch {
      return "unknown"
    }
    if (!result.error && result.data !== undefined) return "exists"
    const status = result.response?.status
    const name = (result.error as { name?: unknown } | undefined)?.name
    if (status === 404 || name === "NotFoundError") return "missing"
    return "unknown"
  }

  /**
   * Foreign and unknown ids get the same message on purpose: targets are
   * scoped to the caller's own children, and existence elsewhere is nobody
   * else's business.
   */
  const requireDirectChild = async (
    sessionID: string,
    id: string,
  ): Promise<RawSession> => {
    let info: RawSession
    try {
      info = await getSession(id)
    } catch {
      throw new Error(notDirectChildError(id, sessionID))
    }
    if (info.parentID !== sessionID)
      throw new Error(notDirectChildError(id, sessionID))
    return info
  }

  const directChildren = async (sessionID: string): Promise<RawSession[]> =>
    unwrap(
      await client.session.children({
        path: { id: sessionID },
        query: { directory },
      }),
      "listing subagents",
    ) as RawSession[]

  /**
   * The endpoint lists only non-idle sessions; absence means idle. A real API
   * error THROWS — it must never read as "every session is idle", which would
   * make waits return early, kills decline, and settles consume stale replies.
   * On success, missing data legitimately means the empty (all-idle) map.
   */
  const statusMap = async (): Promise<
    Record<string, { type?: string } | undefined>
  > => {
    // Bounded on the suite's one deadline for this route, and cancelled by
    // dispose. Unbounded, a wedged host held whatever awaited it: the settle
    // engine's poll tick, and a subagent_spawn parked in its busy-children cap
    // with no timeout of its own. A deadline degrades exactly like the API
    // error below, which every caller already handles.
    const result = await withTimeout(
      (signal) => client.session.status({ query: { directory }, signal }),
      SESSION_STATUS_PROBE_TIMEOUT_MS,
      {
        signal: disposeSignal.signal,
        message: `the host did not answer /session/status within ${SESSION_STATUS_PROBE_TIMEOUT_MS} ms`,
      },
    )
    if (result.error)
      throw new Error(
        `reading subagent status failed: ${JSON.stringify(result.error)}`,
      )
    return (result.data ?? {}) as Record<string, { type?: string } | undefined>
  }

  /**
   * Busy/idle for a session, from the authoritative status endpoint. The event
   * cache is NOT consulted on success: a cached-busy that missed its idle event
   * would otherwise stick forever, and the endpoint lists every non-idle
   * session so its absence is genuine idle. Failures never read as idle — an
   * actually-busy steer that used idle ordering could be dropped as
   * already-answered — so the endpoint's positive-only event cache is the
   * fallback hint and everything else is "unknown". Callers treat "unknown" as
   * busy (the safe direction: over-ordering a steer costs at most one wasted
   * turn if the child is actually idle, whereas under-ordering a genuinely-busy
   * one loses the message outright).
   *
   * This is why the suite's shared tracker (createSessionActivityTracker) is
   * NOT used here, though this plugin shares its event parse: that tracker
   * answers from its record when it has one, which is right for cron and
   * background-tasks — they decide whether to interrupt the USER's turn, and a
   * record they never clear only ever holds a delivery back. Here a stale
   * "busy" would hold a wait, a kill and a settle open indefinitely, and most
   * reads want the whole map at once for every child being watched, not one
   * session's answer. Deliberate divergence, audit §2.9.
   */
  const isBusy = async (id: string): Promise<"busy" | "idle" | "unknown"> => {
    try {
      return (await statusMap())[id] ? "busy" : "idle"
    } catch {
      return busySessions.has(id) ? "busy" : "unknown"
    }
  }

  const fetchMessages = async (
    id: string,
    signal?: AbortSignal,
  ): Promise<ChildMessage[]> => {
    const raw = unwrap(
      await withTimeout(
        (signal) =>
          client.session.messages({
            path: { id },
            query: { directory, limit: MESSAGES_FETCH_LIMIT },
            signal,
          }),
        options.injectConfirmTimeoutMs,
        { signal: signal ?? disposeSignal.signal },
      ),
      `reading messages of ${id}`,
    )
    const messages = parseChildMessages(raw)
    if (!Array.isArray(raw) || messages.length !== raw.length)
      throw new Error(`invalid message transcript for ${id}`)
    return messages
  }

  const injectedMessageVisibility = async (
    sessionID: string,
    messageID: string,
  ): Promise<"visible" | "missing" | "unknown"> => {
    let result: {
      data?: unknown
      error?: unknown
      response?: { status?: number }
    }
    try {
      result = await withTimeout(
        (signal) =>
          client.session.message({
            path: { id: sessionID, messageID },
            query: { directory },
            signal,
          }),
        options.injectConfirmTimeoutMs,
        { signal: disposeSignal.signal },
      )
    } catch {
      return "unknown"
    }
    if (!result.error && result.data !== undefined) return "visible"
    const status = result.response?.status
    const name = (result.error as { name?: unknown } | undefined)?.name
    if (status === 404 || name === "NotFoundError") return "missing"
    return "unknown"
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      unrefTimer(setTimeout(resolve, ms))
    })

  /**
   * Inject a prompt while echoing back the target's current agent/model/
   * variant (see the header comment: omitting them re-pins the session).
   * Returns the minted id of the injected user message — the correlation
   * point for that prompt's reply. `variant` and `messageID` are not in the
   * stale SDK body type but are accepted by the route.
   *
   * `sortAfterSameMs` is set ONLY when steering a busy child (subagent_send to
   * a mid-run child): it mints the id above any same-millisecond host id so the
   * in-flight run cannot mistake the steer for already-answered and exit (see
   * mintMessageID). It must stay false for idle prompts and for the parent
   * notification — a note that lost a same-ms tie merely waits in the
   * transcript for the next request, while one that WON the tie against the
   * parent's terminal assistant could hijack a finishing run.
   *
   * The 204 from promptAsync means only that the host FORKED the prompt
   * operation — message persistence included (httpapi session handlers); an
   * early failure in that fork is published as a session.error event and the
   * message never lands. So success is only reported once the minted id is
   * VISIBLE in the target's messages, within a bounded window: an
   * unobservable minted id would hold every watcher keyed to it (and its
   * busy-children slot) forever, and would let a parent notification read as
   * delivered when it never was.
   *
   * `abortBeforeAccept` is honored exactly once, before the prompt is issued.
   * The confirmation loop that follows is deliberately NOT abortable: once the
   * host has accepted the prompt the child owns it, so an abort arriving
   * mid-confirmation is left to the caller's own wait (which is already
   * abortable).
   *
   * A resolved SDK error is a definitive host rejection. A thrown transport is
   * correlated against the minted id just like a 204: the request may have
   * reached the host before its response was lost. Acceptance that could not
   * be confirmed is NOT an error; it returns `confirmed: false`. The distinction
   * is load-bearing. Deleting a child on an unconfirmed prompt does not undo it:
   * on 1.18.3 Session.remove tears down the session row and its messages but
   * never touches SessionRunState, so an accepted run keeps calling the model
   * and its tools with nothing left tracking it. Callers must preserve ambiguous
   * work rather than assuming none.
   */
  const injectPrompt = async (input: {
    sessionID: string
    identity: PromptIdentity
    text: string
    synthetic: boolean
    messageID?: string
    sortAfterSameMs?: boolean
    abortBeforeAccept?: { signal: AbortSignal; message: string }
  }): Promise<{ messageID: string; confirmed: boolean }> => {
    if (input.abortBeforeAccept?.signal.aborted)
      throw new Error(input.abortBeforeAccept.message)
    const messageID =
      input.messageID ??
      mintMessageID(Date.now(), input.sortAfterSameMs ? MESSAGE_COUNTER_MAX : 0)
    const body: {
      messageID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      variant?: string
      parts: Array<{ type: "text"; text: string; synthetic?: boolean }>
    } = {
      messageID,
      ...promptIdentityBody(input.identity),
      parts: [
        {
          type: "text",
          text: input.text,
          ...(input.synthetic ? { synthetic: true } : {}),
        },
      ],
    }
    let result: { error?: unknown } | undefined
    let transportFailed = false
    try {
      result = await withTimeout(
        (signal) =>
          client.session.promptAsync({
            path: { id: input.sessionID },
            query: { directory },
            body,
            signal,
          }),
        options.injectConfirmTimeoutMs,
        {
          signal: disposeSignal.signal,
          message: `prompting session ${input.sessionID} timed out after ${options.injectConfirmTimeoutMs} ms`,
        },
      )
    } catch {
      transportFailed = true
    }
    if (result?.error)
      throw new PromptRejectedError(
        `prompting session ${input.sessionID} failed: ${JSON.stringify(result.error)}`,
      )
    const deadline = Date.now() + options.injectConfirmTimeoutMs
    let firstLookup = true
    while (true) {
      try {
        const messages = parseChildMessages(
          unwrap(
            await withTimeout(
              (signal) =>
                client.session.messages({
                  path: { id: input.sessionID },
                  query: { directory, limit: MESSAGES_FETCH_LIMIT },
                  signal,
                }),
              options.injectConfirmTimeoutMs,
              { signal: disposeSignal.signal },
            ),
            `reading messages of ${input.sessionID}`,
          ),
        )
        if (hasInjectedMessage(messages, messageID))
          return { messageID, confirmed: true }
      } catch {
        if (transportFailed && firstLookup) {
          log(
            "warn",
            `prompt to session ${input.sessionID} is ambiguous: the transport and its first visibility read both failed — preserving it as unconfirmed`,
          )
          return { messageID, confirmed: false }
        }
        // Without two immediately failed transports, a read failure remains
        // transient evidence; keep checking until the deadline decides.
      }
      firstLookup = false
      // An abort ends the CALLER'S wait, not the child's work. Polling on for
      // the rest of the window after the parent turn is gone only holds the
      // spawn reservation and delays the caller's cancellation; the child keeps
      // the prompt either way, and the settle engine — not this loop — is what
      // reports its outcome. Returning unconfirmed (rather than throwing) is
      // what keeps the accepted child registered instead of deleted.
      if (input.abortBeforeAccept?.signal.aborted) {
        log(
          "info",
          `stopped waiting for the prompt to session ${input.sessionID} to become visible: the caller was aborted; the accepted prompt is left in place`,
        )
        return { messageID, confirmed: false }
      }
      if (Date.now() >= deadline) {
        // Out of confirmation window, NOT out of prompt. The host accepted this
        // prompt; all we know is that we could not see it in time, which a run
        // of failed message reads or a host slower than the (configurable, as
        // low as 250 ms) window produces just as readily as a prompt that never
        // landed. Report the ambiguity instead of inventing a failure.
        const transport = transportFailed
          ? "the transport failed and "
          : "the host accepted the request but "
        log(
          "warn",
          `prompt to session ${input.sessionID} is ambiguous: ${transport}its message did not become visible within ${options.injectConfirmTimeoutMs} ms — preserving it as unconfirmed`,
        )
        return { messageID, confirmed: false }
      }
      await sleep(INJECT_CONFIRM_POLL_MS)
    }
  }

  // ---- the settle engine ------------------------------------------------------

  const resetGrace = (childID: string) => {
    for (const waiter of waiters.get(childID) ?? []) waiter.idleChecks = 0
    for (const entry of notifies.get(childID) ?? []) entry.idleChecks = 0
  }

  const graceExpired = (entry: {
    idleChecks: number
    lastIdleObservedAt: number
  }): boolean => {
    const now = Date.now()
    if (now - entry.lastIdleObservedAt < GRACE_SPACING_MS)
      return entry.idleChecks >= IDLE_CHECKS_BEFORE_ENDED
    entry.lastIdleObservedAt = now
    entry.idleChecks += 1
    return entry.idleChecks >= IDLE_CHECKS_BEFORE_ENDED
  }

  /**
   * Settles for one child are serialized: session.status, session.idle, the
   * poller, and fresh waiters can all trigger one concurrently, and two
   * interleaved bodies would each see the same pending notifications and
   * deliver them twice. The map holds each child's queue tail.
   */
  const settleQueue = new Map<string, Promise<void>>()

  const settleChild = (
    childID: string,
    knownStatus?: Record<string, unknown>,
  ): Promise<void> => {
    // Expiry must not queue behind a hung transcript/status read.
    syncPoller()
    const tail = (settleQueue.get(childID) ?? Promise.resolve())
      .then(() => settleChildSerialized(childID, knownStatus))
      .catch(() => {})
    settleQueue.set(childID, tail)
    void tail.then(() => {
      if (settleQueue.get(childID) === tail) settleQueue.delete(childID)
    })
    return tail
  }

  /**
   * Re-examine a watched child: if it is idle, resolve every waiter and
   * pending notification whose outcome is decidable. Never call directly —
   * settleChild serializes invocations per child. `knownStatus` carries a
   * status map the caller already fetched (the poll tick), so one tick costs
   * one status call regardless of how many children are watched.
   */
  const settleChildSerialized = async (
    childID: string,
    knownStatus?: Record<string, unknown>,
  ) => {
    if (disposed) return
    const hasPollableNotify = (notifies.get(childID) ?? []).some(pollableNotify)
    if (!waiters.get(childID)?.size && !hasPollableNotify) return

    // The endpoint is the authority; the event cache alone must neither hold
    // a settle hostage (stale busy) nor trigger one early (missed busy).
    if (knownStatus === undefined) {
      try {
        knownStatus = await statusMap()
      } catch {
        // Status is the authority for busy/idle; with it unreadable we cannot
        // tell a still-busy child from an idle one. Treating it as idle here
        // would let an unanchored idle-result read or kill confirmation consume
        // a PREVIOUS reply, and would grace-expire a correlated waiter to
        // "ended", both while the current run is still going. Leave every
        // waiter and notify pending; the poller retries on its next tick and
        // each wait's own timeout is the backstop.
        return
      }
    }
    if (knownStatus[childID]) {
      busySessions.add(childID)
      trim(busySessions)
      resetGrace(childID)
      return
    }
    busySessions.delete(childID)

    if (
      !waiters.get(childID)?.size &&
      !(notifies.get(childID) ?? []).some(pollableNotify)
    )
      return

    let messages: ChildMessage[]
    try {
      messages = await fetchMessages(childID)
    } catch {
      // Transient, or the session vanished with its deletion event missed. Only
      // a genuine not-found is decidable as deletion; any other failure —
      // including a transport error that hits fetchMessages and the probe
      // alike — is transient and left for the poller to retry, never mistaken
      // for a deletion that would drop the waiters and notifications for good.
      if ((await sessionExistence(childID)) === "missing") {
        for (const waiter of [...(waiters.get(childID) ?? [])])
          waiter.settle({ kind: "deleted" })
        notifies.delete(childID)
        syncPoller()
      }
      return
    }

    for (const waiter of [...(waiters.get(childID) ?? [])]) {
      const anchor = waiter.replyAnchor
      if (anchor && !anchor.observed)
        anchor.observed = hasReplyAnchor(messages, anchor.messageID)
      if (anchor?.initial && !anchor.observed) {
        if (Date.now() >= anchor.initial.deadline)
          waiter.settle({ kind: "timeout" })
        continue
      }
      const outcome = extractChildOutcome(messages, anchor?.messageID)
      if (outcome.kind === "none") {
        // Inside the promptAsync accepted-but-not-visible window nothing is
        // decidable yet. Visibility is monotonic: after confirmation or one
        // observation, a bounded later page that no longer includes the anchor
        // must not wedge settlement forever.
        if (anchor && !anchor.observed) continue
        if (graceExpired(waiter)) waiter.settle({ kind: "ended" })
        continue
      }
      waiter.settle(outcome)
    }

    // Read fresh AFTER the awaits: entries claimed by a blocking wait,
    // suppressed by a kill, or dropped with a deleted parent meanwhile must
    // not be delivered from a stale capture. Deciding what stays is synchronous
    // (no await between reading the list and writing it back), so a concurrent
    // claim cannot clobber the map write. Deliverable entries are KEPT in the
    // map and marked `delivering` — deliverNotify removes each only after a
    // successful injection, so a transient failure leaves it pending for the
    // poller rather than losing the completion, and claimNotifies refuses to
    // claim a delivering entry (its injection can't be recalled). A claim that
    // lands in the narrow window after `delivering` is set but before injection
    // still can't stop that injection, so a blocking wait/send may occasionally
    // see the same completion both injected and in its own result — a redundant
    // (ignorable) note, never a lost or corrupted one.
    const childNotifies = notifies.get(childID)
    if (childNotifies?.length) {
      const remaining: PendingNotify[] = []
      const toDeliver: Array<{ entry: PendingNotify; outcome: ChildOutcome }> =
        []
      for (const entry of childNotifies) {
        if (entry.delivering) {
          remaining.push(entry)
          continue
        }
        if (!pollableNotify(entry)) {
          remaining.push(entry)
          continue
        }
        const anchor = entry.replyAnchor
        if (!anchor.observed)
          anchor.observed = hasReplyAnchor(messages, anchor.messageID)
        if (anchor.initial && !anchor.observed) {
          remaining.push(entry)
          continue
        }
        const outcome = extractChildOutcome(messages, anchor.messageID)
        if (outcome.kind === "none") {
          if (!anchor.observed || !graceExpired(entry)) {
            remaining.push(entry)
            continue
          }
        } else anchor.observed = true
        if (
          entry.deliveryState === "retry" &&
          Date.now() < entry.nextDeliveryAt
        ) {
          remaining.push(entry)
          continue
        }
        entry.delivering = true
        remaining.push(entry)
        toDeliver.push({ entry, outcome })
      }
      // Write the map BEFORE firing deliveries: a delivery with no notify
      // injection (toast-only / notify:false) completes SYNCHRONOUSLY, so its
      // removeNotify must run against this fresh map — not be clobbered by a
      // stale write that re-adds the just-removed entry.
      if (remaining.length) notifies.set(childID, remaining)
      else notifies.delete(childID)
      for (const { entry, outcome } of toDeliver)
        void deliverNotify(entry, outcome)
    }
    syncPoller()
  }

  /** Drop a delivered notify from the live map; safe against concurrent claims. */
  const removeNotify = (entry: PendingNotify) => {
    const list = notifies.get(entry.childID)
    if (!list) return
    const without = list.filter((existing) => existing !== entry)
    if (without.length === list.length) return
    if (without.length) notifies.set(entry.childID, without)
    else notifies.delete(entry.childID)
    syncPoller()
  }

  const notifyRegistered = (entry: PendingNotify): boolean =>
    !disposed && (notifies.get(entry.childID) ?? []).includes(entry)

  const notifyMessageID = (entry: PendingNotify): string =>
    (entry.deliveryMessageID ??= mintMessageID(Date.now(), 0))

  const reportNotifyState = (
    entry: PendingNotify,
    state: "ambiguous" | "terminal",
    detail: string,
  ) => {
    const level = state === "terminal" ? "error" : "warn"
    const messageID = entry.deliveryMessageID ?? "unassigned"
    log(
      level,
      `completion notification ${messageID} for session ${entry.parentID} about ${entry.childID} is ${state}: ${detail}`,
    )
    if (options.toast && entry.deliveryAlerted !== state) {
      entry.deliveryAlerted = state
      toast(
        state === "terminal" ? "error" : "warning",
        `Completion notification ${state} for ${entry.childID}; use subagent_list or subagent_wait.`,
      )
    }
  }

  const scheduleNotifyRetry = async (
    entry: PendingNotify,
    input: { definitiveRejection: boolean; detail: string },
  ) => {
    if (!notifyRegistered(entry)) return
    if ((await sessionExistence(entry.parentID)) === "missing") {
      removeNotify(entry)
      return
    }
    if (!notifyRegistered(entry)) return
    const delayFactor = NOTIFY_RETRY_BACKOFF[entry.deliveryFailures]
    entry.deliveryFailures += 1
    if (delayFactor === undefined) {
      entry.deliveryState = "terminal"
      entry.nextDeliveryAt = Number.POSITIVE_INFINITY
      reportNotifyState(entry, "terminal", input.detail)
      syncPoller()
      return
    }
    if (input.definitiveRejection) entry.deliveryMessageID = undefined
    const messageID = entry.deliveryMessageID ?? "unassigned"
    const base = options.pollIntervalMs
    entry.deliveryState = "retry"
    entry.nextDeliveryAt = Date.now() + base * delayFactor
    log(
      "warn",
      `will retry completion notification ${messageID} for session ${entry.parentID} about ${entry.childID} after ${base * delayFactor} ms: ${input.detail}`,
    )
    syncPoller()
  }

  /**
   * Deliver a child's completion with its retained parent-message id. Confirmed
   * delivery removes the registration; ambiguous dispatch is parked under
   * that same id. Transient pre-dispatch failures and definitive rejections
   * get bounded backoff, with a new id only after rejection; a readable but
   * incomplete parent identity is terminal because retrying cannot repair it.
   * A confirmed-deleted parent drops the note instead of leaking its poller.
   * `delivering` serializes dispatch and confirmation, and the finished toast
   * fires at most once.
   */
  const deliverNotify = async (entry: PendingNotify, outcome: ChildOutcome) => {
    // The whole body runs under a finally that force-clears `delivering`: an
    // unexpected synchronous throw (building the note, the toast) or an early
    // return must never leave the flag set, which would make settle and
    // claimNotifies skip the entry forever.
    try {
      if (!notifyRegistered(entry)) return
      if (options.toast && !entry.toasted) {
        entry.toasted = true
        toast(
          outcome.kind === "replied" ? "success" : "warning",
          `${truncateLabel(entry.label, TITLE_MAX_CHARS)} (${entry.childID})`,
        )
      }
      let delivered = true
      if (options.notify) {
        delivered = false
        const text = notificationText({
          sessionID: entry.childID,
          label: entry.label,
          outcome,
          elapsedMs: Date.now() - entry.startedAt,
          maxReplyChars: options.maxReplyChars,
        })
        let identity: PromptIdentity
        try {
          // Never prompt with an empty identity. This is pre-dispatch, so the
          // attempt id stays unminted across a bounded retry.
          const parent = unwrap(
            await withTimeout(
              (signal) =>
                client.session.get({
                  path: { id: entry.parentID },
                  query: { directory },
                  signal,
                }),
              options.injectConfirmTimeoutMs,
              { signal: disposeSignal.signal },
            ),
            `looking up session ${entry.parentID}`,
          )
          identity = sessionPromptIdentity(parent)
          if (!identity.agent || !identity.model) {
            entry.deliveryState = "terminal"
            entry.nextDeliveryAt = Number.POSITIVE_INFINITY
            reportNotifyState(
              entry,
              "terminal",
              "the parent session has no complete pinned agent/model, so it cannot be prompted safely",
            )
            syncPoller()
            return
          }
        } catch (error) {
          await scheduleNotifyRetry(entry, {
            definitiveRejection: false,
            detail: error instanceof Error ? error.message : String(error),
          })
          return
        }
        if (!notifyRegistered(entry)) return
        try {
          // A plain prompt, exactly like the host's experimental background
          // subagents: the host's runner atomically merges it into a run
          // already in flight and starts one on an idle parent. Checking
          // busy/idle here and switching to a noReply note would race the
          // parent going idle between check and injection — the note would be
          // recorded without starting a turn and sit unread until some later
          // request.
          // Mint only after every pre-dispatch await. An older ID can sort
          // behind a newer parent assistant and be stored without running.
          const deliveryMessageID = notifyMessageID(entry)
          const injected = await injectPrompt({
            sessionID: entry.parentID,
            identity,
            text,
            synthetic: true,
            messageID: deliveryMessageID,
          })
          if (!notifyRegistered(entry)) return
          if (!injected.confirmed) {
            // One exact-id read gets a response-loss attempt out of the
            // transcript-list failure path. If that still cannot prove
            // acceptance, park terminally: host state may settle later, but
            // polling it forever would trade duplicate turns for unbounded
            // autonomous reads.
            const visibility = await injectedMessageVisibility(
              entry.parentID,
              deliveryMessageID,
            )
            if (visibility === "visible") {
              removeNotify(entry)
              return
            }
            entry.deliveryState = "ambiguous"
            entry.nextDeliveryAt = Number.POSITIVE_INFINITY
            reportNotifyState(
              entry,
              "ambiguous",
              "acceptance could not be confirmed; it is parked without reinjection",
            )
            syncPoller()
            return
          }
          delivered = true
        } catch (error) {
          await scheduleNotifyRetry(entry, {
            definitiveRejection: error instanceof PromptRejectedError,
            detail: error instanceof Error ? error.message : String(error),
          })
          return
        }
      }
      if (delivered) {
        removeNotify(entry)
        return
      }
    } finally {
      entry.delivering = false
    }
  }

  /**
   * One pending note per (parent, child): the child's next completion
   * answers every message injected before it, so a newer registration
   * supersedes the old — the parent should hear about that completion once,
   * not once per send.
   */
  const registerNotify = (
    entry: Omit<
      PendingNotify,
      | "idleChecks"
      | "lastIdleObservedAt"
      | "deliveryMessageID"
      | "deliveryState"
      | "deliveryFailures"
      | "nextDeliveryAt"
    >,
  ) => {
    // Declines after teardown for the reason restoreNotifies does: syncPoller
    // is `!disposed && ...` so the poller never restarts, and settleChild
    // returns early, which makes a registration here an entry nothing can ever
    // deliver — written into the map dispose() has just emptied.
    if (disposed) return
    if (entry.replyAnchor.initial && clearedInitialLaunches.has(entry.childID))
      return
    // An older blocking send may finish/abort after newer work registered.
    // Host/plugin ids are lexicographic reply watermarks (see mintMessageID);
    // preserve the greatest watermark, not the latest registration time.
    if (
      (notifies.get(entry.childID) ?? []).some(
        (existing) =>
          existing.parentID === entry.parentID &&
          existing.replyAnchor.messageID > entry.replyAnchor.messageID,
      )
    )
      return
    const list = (notifies.get(entry.childID) ?? []).filter(
      (existing) => existing.parentID !== entry.parentID,
    )
    list.push({
      ...entry,
      idleChecks: 0,
      lastIdleObservedAt: 0,
      deliveryState: "pending",
      deliveryFailures: 0,
      nextDeliveryAt: 0,
    })
    notifies.set(entry.childID, list)
    syncPoller()
  }

  /**
   * A blocking wait owns completion delivery for its (parent, child) pair:
   * the tool result is the delivery, so pending notes are parked while it
   * runs and dropped when it consumes the completion. They come back only
   * when the wait ends without consuming one — restoreNotifies on abort or
   * injection failure; a timeout re-registers instead, which supersedes.
   *
   * An entry already mid-delivery (delivering=true) is NOT claimable: its
   * in-flight deliverNotify cannot be recalled, so parking it would let the
   * note be injected AND revived-then-re-injected. Leaving it means the sole
   * in-flight delivery finishes it (removed on success, retried in-map on
   * failure), and restoreNotifies therefore never revives a delivering entry.
   */
  const claimNotifies = (
    childID: string,
    parentID: string,
  ): PendingNotify[] => {
    const list = notifies.get(childID) ?? []
    const claimed = list.filter(
      (entry) => entry.parentID === parentID && !entry.delivering,
    )
    if (!claimed.length) return []
    const rest = list.filter((entry) => !claimed.includes(entry))
    if (rest.length) notifies.set(childID, rest)
    else notifies.delete(childID)
    syncPoller()
    return claimed
  }

  const restoreNotifies = (childID: string, claimed: PendingNotify[]) => {
    if (disposed || !claimed.length) return
    const list = notifies.get(childID) ?? []
    // A registration that landed meanwhile supersedes what it claimed. (Claimed
    // entries are never delivering — claimNotifies skips those — so none can be
    // revived mid-delivery and double-fire.)
    const fresh = claimed.filter(
      (entry) =>
        !(entry.replyAnchor.initial && clearedInitialLaunches.has(childID)) &&
        !list.some((existing) => existing.parentID === entry.parentID),
    )
    if (!fresh.length) return
    notifies.set(childID, [...list, ...fresh])
    syncPoller()
    // The child may have finished while the notes were parked.
    void settleChild(childID)
  }

  // ---- poller (missed-event insurance; runs only while something is watched) --

  let poller: ReturnType<typeof setInterval> | undefined
  const pollTick = async () => {
    if (disposed) return
    // Reconciliation expires even when the host is busy or unreadable.
    syncPoller()
    const ids = new Set(waiters.keys())
    for (const [childID, entries] of notifies) {
      if (entries.some(pollableNotify)) ids.add(childID)
    }
    if (!ids.size) return
    let map: Record<string, unknown> | undefined
    try {
      map = await statusMap()
    } catch {
      return // Transient; next tick retries.
    }
    for (const id of ids) void settleChild(id, map)
  }
  const syncPoller = () => {
    if (!disposed) {
      for (const entries of notifies.values()) {
        for (const entry of entries) {
          const anchor = entry.replyAnchor
          // Explicit inspection can resolve a parked launch without resubmitting it.
          if (anchor.initial && anchor.observed) anchor.initial.parked = false
          if (
            !anchor.initial ||
            anchor.initial.parked ||
            anchor.observed ||
            Date.now() < anchor.initial.deadline
          )
            continue
          anchor.initial.parked = true
          log(
            "warn",
            `initial prompt ${anchor.messageID} for ${entry.childID} is unconfirmed; tracking parked without resubmission`,
          )
          if (options.toast)
            toast(
              "warning",
              `Initial prompt unconfirmed for ${entry.childID}; tracking parked. Use subagent_list or subagent_wait to inspect, or subagent_kill to clear tracking.`,
              { title: "Subagent launch uncertain" },
            )
        }
      }
    }
    const hasPollableNotify = [...notifies.values()].some((entries) =>
      entries.some(pollableNotify),
    )
    const shouldRun = !disposed && (waiters.size > 0 || hasPollableNotify)
    if (shouldRun && !poller) {
      poller = every(() => void pollTick(), options.pollIntervalMs)
    } else if (!shouldRun && poller) {
      clearInterval(poller)
      poller = undefined
    }
  }

  // ---- waiting ----------------------------------------------------------------

  const waitForChild = (
    childID: string,
    params: {
      replyAnchor: ReplyAnchor | undefined
      timeoutMs: number
      abort: AbortSignal
      abortMessage: string
    },
  ): Promise<WaitOutcome> =>
    new Promise((resolve, reject) => {
      // Disposal landing between a caller's last await and this registration
      // would otherwise leave a waiter in a map dispose() has already cleared,
      // with nothing left to answer it: the poller is stopped for good and
      // settleChild returns early, so only this waiter's own timer could
      // settle it — late, and for a caller whose run the same teardown
      // cancelled. Refusing now is indistinguishable, to that caller, from
      // dispose() failing a waiter registered a millisecond earlier, which is
      // why it reuses that message. Mirrors the abort early-out below.
      if (disposed) {
        reject(new Error(PLUGIN_DISPOSED_MESSAGE))
        return
      }
      const set = waiters.get(childID) ?? new Set<Waiter>()
      waiters.set(childID, set)
      let settled = false
      const finish = (deliver: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        params.abort.removeEventListener("abort", onAbort)
        set.delete(waiter)
        if (!set.size) waiters.delete(childID)
        deliver()
        syncPoller()
      }
      const waiter: Waiter = {
        replyAnchor: params.replyAnchor,
        idleChecks: 0,
        lastIdleObservedAt: 0,
        settle: (outcome) => finish(() => resolve(outcome)),
        fail: (error) => finish(() => reject(error)),
      }
      const timer = setTimeout(
        () => waiter.settle({ kind: "timeout" }),
        Math.min(params.timeoutMs, MAX_TIMER_MS),
      )
      unrefTimer(timer)
      const onAbort = () => waiter.fail(new Error(params.abortMessage))
      if (params.abort.aborted) {
        onAbort()
        return
      }
      params.abort.addEventListener("abort", onAbort, { once: true })
      set.add(waiter)
      syncPoller()
      // An already-idle child should settle promptly, not wait out a poll tick.
      void settleChild(childID)
    })

  // ---- tools --------------------------------------------------------------

  const z = tool.schema

  /**
   * The provider endpoint includes credentials and provider options. Parse only
   * the discovery allowlist, and collapse every transport/payload failure into
   * a fixed error so an error body cannot leak through a tool result.
   */
  const providerModelCatalog = async (): Promise<ModelCatalog> => {
    try {
      const result = await withTimeout(
        (signal) => client.config.providers({ query: { directory }, signal }),
        MODEL_CATALOG_TIMEOUT_MS,
        {
          signal: disposeSignal.signal,
          message: `the host did not answer /config/providers within ${MODEL_CATALOG_TIMEOUT_MS} ms`,
        },
      )
      if (result.error) throw new Error(MODEL_CATALOG_READ_ERROR)
      const catalog = parseModelCatalog(result.data)
      if (!catalog) throw new Error(MODEL_CATALOG_READ_ERROR)
      return catalog
    } catch (error) {
      if (error instanceof Error && error.message === MODEL_CATALOG_READ_ERROR)
        throw error
      throw new Error(MODEL_CATALOG_READ_ERROR)
    }
  }

  const subagent_models = tool({
    description: SUBAGENT_MODELS_DESCRIPTION,
    args: {},
    execute: async () => {
      return {
        title: "Subagent model catalog",
        output: renderModelCatalog(await providerModelCatalog()),
      }
    },
  })

  const subagent_spawn = tool({
    description: subagentSpawnDescription(options.notify),
    args: {
      description: z
        .string()
        .min(1)
        .max(100)
        .describe("A short (3-5 words) description of the task"),
      prompt: z
        .string()
        .min(1)
        .describe("The task for the subagent to perform"),
      subagent_type: z
        .string()
        .min(1)
        .describe("The type of specialized agent to use for this task"),
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional provider/model override. Call subagent_models first; models not listed in the current provider catalog are rejected before a child is created. An explicit model without variant uses the host's default effort.",
        ),
      variant: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional variant override for the resolved model. Call subagent_models first; variants not listed for that model in the current provider catalog are rejected before a child is created.",
        ),
    },
    execute: async (args, ctx) => {
      // Everything that locks the child down or bounds the spawn — the
      // subagent_depth limit, the parent's permission ruleset, the
      // primary_tools restrictions — is read up front and FAILS CLOSED: a
      // spawn must never proceed on defaults when a boundary is unreadable.
      let config: {
        subagent_depth?: unknown
        experimental?: { primary_tools?: unknown }
      }
      let parentInfo: RawSession
      let depth = 0
      try {
        config = unwrap(
          await client.config.get({ query: { directory } }),
          "reading config",
        ) as typeof config
        parentInfo = await getSession(ctx.sessionID)
        let cursor = parentInfo
        while (cursor.parentID) {
          depth++
          cursor = await getSession(cursor.parentID)
        }
      } catch (error) {
        throw new Error(
          spawnLockdownReadError(
            error instanceof Error ? error.message : String(error),
          ),
        )
      }

      // The stock task tool's resource boundary (task.ts, v1.18.2): walk the
      // parent lineage and refuse past config.subagent_depth (default 1).
      // Checked BEFORE the ask, like stock, so a spawn that cannot proceed
      // never bothers the user with a permission prompt. The plugin enforces
      // it across the whole supported band — hosts older than 1.18.2 simply
      // never set the key, so they get the same default boundary.
      const rawDepth = config.subagent_depth
      const depthLimit =
        typeof rawDepth === "number" &&
        Number.isInteger(rawDepth) &&
        rawDepth >= 0
          ? rawDepth
          : 1
      if (depth >= depthLimit)
        throw new Error(subagentDepthLimitError(depthLimit))

      // Checked outside the try below, whose catch turns anything thrown into a
      // permission denial: an aborted turn must not be reported as one. Asking
      // for permission on behalf of a turn that is already over is noise, and
      // the answer could only arrive too late to matter.
      if (ctx.abort.aborted) throw new Error(SPAWN_ABORTED_MESSAGE)

      // Reject a malformed override before asking the user to approve a spawn
      // that can never proceed. Catalog membership remains a post-permission,
      // fresh read so a permission wait cannot stale the validation result.
      const explicitModel =
        args.model !== undefined ? parseModelRef(args.model) : undefined
      if (args.model !== undefined && !explicitModel)
        throw new Error(INVALID_MODEL_REF_ERROR)

      // The same permission action the builtin task tool asserts: silently
      // allowed by default in normal sessions, governed by user permission.task
      // rules, and denied by the host's derived ruleset inside subagent
      // sessions — which is exactly the no-nested-subagents rule.
      try {
        await ctx.ask({
          permission: "task",
          patterns: [args.subagent_type],
          always: ["*"],
          metadata: {
            description: args.description,
            subagent_type: args.subagent_type,
            background: true,
            ...(args.model !== undefined ? { model: args.model } : {}),
            ...(args.variant !== undefined ? { variant: args.variant } : {}),
          },
        })
      } catch {
        throw new Error(spawnDeniedError(Boolean(parentInfo.parentID)))
      }

      if (ctx.abort.aborted) throw new Error(SPAWN_ABORTED_MESSAGE)

      let reservedSlot = false
      try {
        type RawAgent = {
          name?: unknown
          mode?: unknown
          hidden?: unknown
          model?: { providerID?: unknown; modelID?: unknown }
          permission?: unknown
        }
        const agents = unwrap(
          await client.app.agents({ query: { directory } }),
          "listing agents",
        ) as RawAgent[]
        const agent = agents.find(
          (candidate) => candidate.name === args.subagent_type,
        )
        if (!agent || typeof agent.name !== "string") {
          const available = agents
            .filter(
              (candidate) =>
                candidate.mode !== "primary" && candidate.hidden !== true,
            )
            .map((candidate) => candidate.name)
            .filter((name): name is string => typeof name === "string")
          throw new Error(unknownAgentError(args.subagent_type, available))
        }

        // Stock model inheritance: the subagent's own model, else the parent's
        // current one; the variant rides only with an inherited model. Like
        // stock (which DIES on an unreadable current message), an inheritance
        // source that cannot be read fails the spawn — silently falling back
        // to the host's default model could change provider, cost, or data
        // routing.
        let model: { providerID: string; modelID: string }
        let variant: string | undefined
        if (explicitModel) {
          model = explicitModel
        } else if (
          typeof agent.model?.providerID === "string" &&
          typeof agent.model.modelID === "string"
        ) {
          model = {
            providerID: agent.model.providerID,
            modelID: agent.model.modelID,
          }
        } else {
          let info:
            | { providerID?: unknown; modelID?: unknown; variant?: unknown }
            | undefined
          try {
            const message = unwrap(
              await client.session.message({
                path: { id: ctx.sessionID, messageID: ctx.messageID },
                query: { directory },
              }),
              "reading the current message",
            ) as {
              info?: {
                providerID?: unknown
                modelID?: unknown
                variant?: unknown
              }
            }
            info = message.info
          } catch (error) {
            throw new Error(
              spawnModelReadError(
                error instanceof Error ? error.message : String(error),
              ),
            )
          }
          if (
            typeof info?.providerID !== "string" ||
            typeof info.modelID !== "string"
          )
            throw new Error(
              spawnModelReadError("the current message carries no model"),
            )
          model = { providerID: info.providerID, modelID: info.modelID }
          if (typeof info.variant === "string" && info.variant)
            variant = info.variant
        }

        if (args.variant !== undefined) variant = args.variant
        else if (args.model !== undefined) variant = "default"

        // Only an explicit override depends on the current provider catalog.
        // Omitted arguments retain the stock agent/current-message resolution
        // and fail-closed inheritance without adding a catalog dependency.
        if (args.model !== undefined || args.variant !== undefined) {
          const catalogModel = findCatalogModel(
            await providerModelCatalog(),
            model,
          )
          if (!catalogModel)
            throw new Error(
              unavailableModelError(`${model.providerID}/${model.modelID}`),
            )
          // "default" is the host sentinel used only for an explicit model
          // with no variant: it suppresses the selected agent's effort pin.
          if (
            args.variant !== undefined &&
            !(args.model !== undefined && args.variant === "default") &&
            !catalogModel.variants.includes(args.variant)
          )
            throw new Error(
              unavailableVariantError(catalogModel.ref, catalogModel.variants),
            )
        }

        // The parent ruleset (external_directory + denies) and the
        // experimental.primary_tools restrictions both lock the child down;
        // both were read fail-closed at the top of this execute.
        const parentPermission: Rule[] = rulesetOf(parentInfo.permission)
        const list = config.experimental?.primary_tools
        const primaryTools = Array.isArray(list)
          ? list.filter((name): name is string => typeof name === "string")
          : []
        const permission = deriveChildPermission(
          parentPermission,
          rulesetOf(agent.permission),
          primaryTools,
        )

        if (ctx.abort.aborted) throw new Error(SPAWN_ABORTED_MESSAGE)

        // Validate every input before claiming a busy-child slot. statusMap
        // throws on a real API error rather than reading it as all-idle, so a
        // transient status failure fails the spawn instead of over-spawning.
        const statusSnapshot = await statusMap()
        const children = await directChildren(ctx.sessionID)
        syncPoller()
        // A child occupies a slot if it is busy in the status map OR is still
        // tracked by a pending notify (a spawned/sent child registers its notify
        // before it registers as busy), plus reservations for spawns mid-flight.
        const tracked = new Set<string>()
        for (const [childID, entries] of notifies)
          if (
            entries.some(
              (entry) =>
                entry.parentID === ctx.sessionID && pollableNotify(entry),
            )
          )
            tracked.add(childID)
        const reserved = pendingSpawns.get(ctx.sessionID) ?? 0
        let occupied = reserved
        for (const child of children)
          if (statusSnapshot[child.id] || tracked.has(child.id)) occupied++
        if (occupied >= options.maxBusyChildren)
          throw new Error(
            tooManyBusyChildrenError(occupied, options.maxBusyChildren),
          )
        // Reserve synchronously — no await between reading `reserved` above and
        // this write — so parallel spawns cannot both claim the same free slot.
        pendingSpawns.set(ctx.sessionID, reserved + 1)
        reservedSlot = true

        // parentID/title are in the SDK's create-body type; agent/permission are
        // accepted by the route but missing from the stale generated type, so
        // the body is checked against the local SessionCreateBody contract and
        // passed structurally (runtime-verified on 1.17.18; the raw-transport
        // _client.post("/session") is the fallback if a future client ever
        // strips unknown body keys).
        const createBody = {
          parentID: ctx.sessionID,
          title: `${args.description} (@${agent.name} subagent)`,
          agent: agent.name,
          permission,
        } satisfies SessionCreateBody
        // The last instant at which "no child exists" is still true — the
        // permission prompt and the agent/model reads above can have taken a
        // while. Past this point the child is real, and an abort is handled by
        // cleaning it up rather than by not creating it.
        if (ctx.abort.aborted) throw new Error(SPAWN_ABORTED_MESSAGE)
        const child = unwrap(
          await client.session.create({
            body: createBody,
            query: { directory },
          }),
          "creating the subagent session",
        ) as { id: string }

        let messageID: string
        let promptConfirmed: boolean
        try {
          // A throw here means the host never accepted the prompt (see
          // injectPrompt); an accepted-but-unconfirmed prompt resolves instead,
          // and must NOT reach the delete path. Deleting a child whose prompt
          // the host took on does not cancel it — Session.remove leaves the
          // runner running — so it would strand a live, untracked subagent and
          // silently drop the notification the parent is owed.
          ;({ messageID, confirmed: promptConfirmed } = await injectPrompt({
            sessionID: child.id,
            identity: {
              agent: agent.name,
              model,
              ...(variant ? { variant } : {}),
            },
            text: args.prompt,
            synthetic: false,
            // Only up to acceptance: an abort that lands in the race between
            // create and prompt takes the delete path below, which is the
            // cleanup this window needs. Once the prompt IS accepted the child
            // is running and deleting it would retract work the host took on.
            abortBeforeAccept: {
              signal: ctx.abort,
              message: SPAWN_ABORTED_MESSAGE,
            },
          }))
        } catch (error) {
          // Dead on arrival: a child that never got its prompt is clutter.
          await client.session
            .delete({ path: { id: child.id }, query: { directory } })
            .catch(() => {})
          throw error instanceof Error ? error : new Error(String(error))
        }

        const metadata = {
          parentSessionId: ctx.sessionID,
          sessionId: child.id,
          model,
          ...(variant !== undefined ? { variant } : {}),
          background: true,
          promptOutcome: promptConfirmed ? "confirmed" : "unconfirmed",
          promptMessageId: messageID,
        }
        ctx.metadata({ title: args.description, metadata })
        registerNotify({
          parentID: ctx.sessionID,
          childID: child.id,
          replyAnchor: {
            messageID,
            observed: promptConfirmed,
            ...(!promptConfirmed
              ? {
                  initial: {
                    deadline: Date.now() + options.injectConfirmTimeoutMs,
                    parked: false,
                  },
                }
              : {}),
          },
          label: args.description,
          startedAt: Date.now(),
        })
        log(
          "info",
          `spawned subagent ${child.id} (@${agent.name}) for session ${ctx.sessionID}`,
        )
        return {
          title: `${truncateLabel(args.description, TITLE_MAX_CHARS)} (${child.id})`,
          output: renderTaskBlock({
            sessionID: child.id,
            state: "running",
            summary: `Background subagent started: ${args.description}`,
            text: spawnStartedText(child.id, options.notify, promptConfirmed),
          }),
          metadata,
        }
      } finally {
        if (reservedSlot) {
          // Release the slot: from here the child's registered notify keeps it
          // counted (via `tracked`) until it settles.
          const left = (pendingSpawns.get(ctx.sessionID) ?? 1) - 1
          if (left > 0) pendingSpawns.set(ctx.sessionID, left)
          else pendingSpawns.delete(ctx.sessionID)
        }
      }
    },
  })

  const subagent_send = tool({
    description: subagentSendDescription(
      options.defaultWaitTimeoutMs,
      options.notify,
    ),
    args: {
      session_id: z
        .string()
        .min(1)
        .describe(
          'Child session id, e.g. "ses_...", from subagent_spawn, subagent_list, or a task tool result.',
        ),
      message: z
        .string()
        .min(1)
        .describe("The message to send to the subagent."),
      wait: z
        .boolean()
        .optional()
        .describe(
          "Default true: block and return the subagent's reply. false: deliver and return immediately.",
        ),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(WAIT_MAX_TIMEOUT_MS)
        .optional()
        .describe(
          `Cap on the wait in milliseconds (default ${options.defaultWaitTimeoutMs}, max ${WAIT_MAX_TIMEOUT_MS}). Only meaningful with wait: true; timing out is not an error.`,
        ),
    },
    execute: async (args, ctx) => {
      const info = await requireDirectChild(ctx.sessionID, args.session_id)
      const childID = info.id
      const identity = sessionPromptIdentity(info)
      const label = truncateLabel(args.message, LABEL_MAX_CHARS)
      // Before the ask and before any note is claimed: nothing has been
      // delivered yet, so an aborted turn simply stops here.
      if (ctx.abort.aborted)
        throw new Error(SEND_ABORTED_BEFORE_DELIVERY_MESSAGE)
      // Commanding an existing child is the same capability as spawning one:
      // the stock task tool re-asks the "task" permission on every task_id
      // resume, so a session whose current agent denies task (plan mode, say)
      // cannot keep directing a more-privileged child it started earlier.
      // The pattern is the child's agent type, matching what a stock resume
      // would assert for it.
      try {
        await ctx.ask({
          permission: "task",
          patterns: [
            typeof info.agent === "string" && info.agent ? info.agent : "*",
          ],
          always: ["*"],
          metadata: {
            description: label,
            subagent_type:
              typeof info.agent === "string" ? info.agent : undefined,
          },
        })
      } catch {
        throw new Error(SEND_DENIED_MESSAGE)
      }
      const wantsWait = args.wait !== false
      // A blocking send owns delivery: park any pending completion note for
      // this pair now, or the completion would arrive twice — once as this
      // tool's result and once injected into the parent.
      const claimed = wantsWait ? claimNotifies(childID, ctx.sessionID) : []
      let wasBusy: boolean
      let messageID: string
      let promptConfirmed: boolean
      try {
        // Unknown (status unreadable) errs toward busy: sorting a steer above
        // same-ms host ids costs at most one wasted turn on an idle child, but
        // NOT doing so for a busy one risks the run dropping it as
        // already-answered.
        wasBusy = (await isBusy(childID)) !== "idle"
        // isBusy cannot tell a read this plugin CANCELLED from one that
        // failed — both answer "unknown", which errs toward busy and would
        // carry us straight into the injection below, starting a child run
        // after the plugin announced it was gone. Test the flag rather than
        // the rejection: dispose() sets it before it aborts the signal, so it
        // also catches a teardown that landed at requireDirectChild or the
        // permission ask, and it does not depend on telling a disposal
        // AbortError apart from the one withTimeout's own deadline raises.
        // (Same shape as background-tasks' post-read re-check.)
        if (disposed) {
          throw new Error(PLUGIN_DISPOSED_MESSAGE)
        }
        // A steer into a busy child must sort above the in-flight assistant, or
        // the running loop can read it as already-answered and drop it.
        // As in spawn, only a genuine non-acceptance throws. An accepted
        // prompt we could not confirm counts as delivered: restoring the parked
        // notes and reporting failure would invite the caller to send again,
        // duplicating a message the child may already be acting on. An unseen
        // prompt remains uncertain, not evidence that the run ended.
        ;({ messageID, confirmed: promptConfirmed } = await injectPrompt({
          sessionID: childID,
          identity,
          text: args.message,
          synthetic: false,
          sortAfterSameMs: wasBusy,
          // Pre-acceptance only. Once the child has the message, an abort ends
          // this caller's wait and nothing more (below) — the message is never
          // retracted.
          abortBeforeAccept: {
            signal: ctx.abort,
            message: SEND_ABORTED_BEFORE_DELIVERY_MESSAGE,
          },
        }))
      } catch (error) {
        restoreNotifies(childID, claimed)
        throw error instanceof Error ? error : new Error(String(error))
      }
      const title = `${truncateLabel(info.title ?? childID, TITLE_MAX_CHARS)} (${childID})`
      const preserveAmbiguity = (text: string) =>
        promptConfirmed
          ? text
          : `${text}\n\n${unconfirmedDeliveryText(childID)}`
      const replyAnchor: ReplyAnchor = {
        messageID,
        observed: promptConfirmed,
      }

      if (!wantsWait) {
        registerNotify({
          parentID: ctx.sessionID,
          childID,
          replyAnchor,
          label,
          startedAt: Date.now(),
        })
        return {
          title,
          output: deliveredText(
            childID,
            wasBusy,
            options.notify,
            promptConfirmed,
          ),
          metadata: {
            sessionId: childID,
            outcome: promptConfirmed ? "delivered" : "unconfirmed",
            wasBusy,
          },
        }
      }

      const timeoutMs = clampWaitTimeout(
        args.timeout_ms,
        options.defaultWaitTimeoutMs,
      )
      const startedAt = Date.now()
      let outcome: WaitOutcome
      try {
        outcome = await waitForChild(childID, {
          replyAnchor,
          timeoutMs,
          abort: ctx.abort,
          abortMessage: SEND_ABORTED_MESSAGE,
        })
      } catch (error) {
        // An accepted follow-up supersedes unresolved initial tracking. Reviving
        // its unseen old anchor could park this new, genuinely accepted work.
        const supersedesInitial = claimed.some(
          (entry) =>
            entry.replyAnchor.initial &&
            (!entry.replyAnchor.observed || entry.replyAnchor.initial.parked),
        )
        if (!supersedesInitial) restoreNotifies(childID, claimed)
        // With nothing parked there is nothing to revive — and this send's
        // message HAS been delivered, so without a registration its completion
        // would reach the parent only if the model thought to ask. (A child
        // spawned by the stock task tool, or one whose earlier note was already
        // delivered, has no note to claim.) The timeout branch registers for the
        // same reason but unconditionally, because a timeout consumed its claim.
        if (!disposed && (!claimed.length || supersedesInitial))
          registerNotify({
            parentID: ctx.sessionID,
            childID,
            replyAnchor,
            label,
            startedAt,
          })
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(preserveAmbiguity(message))
      }
      const steerNote = wasBusy
        ? " Your message was merged into a run that was already in progress."
        : ""
      switch (outcome.kind) {
        case "replied": {
          const reply = truncateReply(outcome.text, options.maxReplyChars)
          return {
            title,
            output: [
              `Subagent ${childID} replied after ${formatDuration(Date.now() - startedAt)}.${steerNote}`,
              renderTaskBlock({
                sessionID: childID,
                state: "completed",
                text: reply.text,
              }),
            ].join("\n"),
            metadata: {
              sessionId: childID,
              outcome: "replied",
              wasBusy,
              truncated: reply.truncated,
            },
          }
        }
        case "errored":
          // The send itself worked; the child's run failed. A result, not a
          // thrown error, so the model sees the failure text verbatim.
          return {
            title,
            output: renderTaskBlock({
              sessionID: childID,
              state: "error",
              text: outcome.error,
            }),
            metadata: { sessionId: childID, outcome: "errored", wasBusy },
          }
        case "ended":
          return {
            title,
            output: preserveAmbiguity(ENDED_WITHOUT_REPLY_TEXT),
            metadata: {
              sessionId: childID,
              outcome: "ended",
              wasBusy,
              promptOutcome: promptConfirmed ? "confirmed" : "unconfirmed",
            },
          }
        case "timeout":
          // Supersedes whatever the wait claimed: one note, correlated to
          // this send's message, covers the eventual completion.
          registerNotify({
            parentID: ctx.sessionID,
            childID,
            replyAnchor,
            label,
            startedAt,
          })
          return {
            title,
            output: preserveAmbiguity(
              sendTimedOutText(childID, timeoutMs, options.notify),
            ),
            metadata: {
              sessionId: childID,
              outcome: "timeout",
              wasBusy,
              promptOutcome: promptConfirmed ? "confirmed" : "unconfirmed",
            },
          }
        case "deleted":
          throw new Error(
            `Subagent session ${childID} was deleted while waiting for its reply.`,
          )
      }
    },
  })

  const subagent_list = tool({
    description: subagentListDescription(options.notify),
    args: {},
    execute: async (_args, ctx) => {
      const children = await directChildren(ctx.sessionID)
      if (!children.length)
        return {
          title: "No subagents",
          output: NO_CHILDREN_MESSAGE,
          metadata: { count: 0, busy: 0 },
        }
      // A status-endpoint failure is reported as "unknown", not fabricated as
      // all-idle: the children list itself is still worth returning.
      let map: Record<string, { type?: string } | undefined> | undefined
      try {
        map = await statusMap()
      } catch {
        map = undefined
      }
      const rank = { busy: 0, retry: 1, unknown: 2, idle: 3 }
      syncPoller()
      const summaries: ChildSummary[] = children
        .map((child) => {
          const launch = (notifies.get(child.id) ?? []).find(
            (entry) =>
              entry.parentID === ctx.sessionID &&
              entry.replyAnchor.initial &&
              (!entry.replyAnchor.observed || entry.replyAnchor.initial.parked),
          )?.replyAnchor
          const notification = (notifies.get(child.id) ?? []).find(
            (entry) =>
              entry.parentID === ctx.sessionID &&
              (entry.deliveryState === "ambiguous" ||
                entry.deliveryState === "terminal"),
          )?.deliveryState as ChildSummary["notification"] | undefined
          return {
            id: child.id,
            title: typeof child.title === "string" ? child.title : undefined,
            agent: typeof child.agent === "string" ? child.agent : undefined,
            status: (map === undefined
              ? "unknown"
              : map[child.id]
                ? map[child.id]?.type === "retry"
                  ? "retry"
                  : "busy"
                : "idle") as ChildSummary["status"],
            ...(notification ? { notification } : {}),
            ...(launch
              ? {
                  launch: {
                    promptMessageId: launch.messageID,
                    state: launch.initial?.parked
                      ? ("parked" as const)
                      : ("unconfirmed" as const),
                  },
                }
              : {}),
            updated:
              typeof child.time?.updated === "number"
                ? child.time.updated
                : undefined,
          }
        })
        .sort(
          (a, b) =>
            rank[a.status] - rank[b.status] ||
            (b.updated ?? 0) - (a.updated ?? 0),
        )
      const busy = summaries.filter(
        (child) => child.status === "busy" || child.status === "retry",
      ).length
      const notificationIssues = summaries.filter(
        (child) => child.notification,
      ).length
      const unconfirmedLaunches = summaries.flatMap((child) =>
        child.launch ? [{ sessionId: child.id, ...child.launch }] : [],
      )
      const now = Date.now()
      const header =
        map === undefined
          ? `You have ${summaries.length} subagent(s) (live status is unavailable right now):`
          : `You have ${summaries.length} subagent(s):`
      return {
        title:
          map === undefined
            ? `${summaries.length} subagent(s), status unavailable`
            : `${summaries.length} subagent(s), ${busy} busy`,
        output: [
          header,
          ...summaries.map((child) => childLine(child, now)),
        ].join("\n"),
        metadata: {
          count: summaries.length,
          ...(map === undefined ? { statusUnavailable: true } : { busy }),
          ...(notificationIssues ? { notificationIssues } : {}),
          ...(unconfirmedLaunches.length ? { unconfirmedLaunches } : {}),
        },
      }
    },
  })

  const subagent_wait = tool({
    description: subagentWaitDescription(
      options.defaultWaitTimeoutMs,
      options.notify,
    ),
    args: {
      session_ids: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Specific subagents to wait for. Default: all of yours that are currently busy.",
        ),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(WAIT_MAX_TIMEOUT_MS)
        .optional()
        .describe(
          `Cap on the wait in milliseconds (default ${options.defaultWaitTimeoutMs}, max ${WAIT_MAX_TIMEOUT_MS}). Timing out is not an error.`,
        ),
    },
    execute: async (args, ctx) => {
      const explicit = [...new Set(args.session_ids ?? [])]
      for (const id of explicit) await requireDirectChild(ctx.sessionID, id)
      const targets = explicit.length
        ? explicit
        : (await directChildren(ctx.sessionID)).map((child) => child.id)
      if (!targets.length)
        return {
          title: "Nothing to wait for",
          output: NO_CHILDREN_MESSAGE,
          metadata: { waited: [], stillBusy: [] },
        }

      // statusMap throws on a real API error; surfacing it beats fabricating an
      // all-idle map that would make the wait return "nothing to wait for".
      const map = await statusMap()
      const busyTargets = targets.filter((id) => map[id])
      const idleTargets = targets.filter((id) => !map[id])
      // Only the DEFAULT selection filters to busy children. An explicitly
      // named target is answered even when already idle — its latest completed
      // outcome is the documented recovery path for a timed-out or aborted
      // send (and with notify:false the only way to collect a completion).
      if (!explicit.length && !busyTargets.length) {
        return {
          title: "Nothing to wait for",
          output:
            "Nothing to wait for; none of your subagents are working right now.",
          metadata: { waited: [], stillBusy: [] },
        }
      }

      const timeoutMs = clampWaitTimeout(
        args.timeout_ms,
        options.defaultWaitTimeoutMs,
      )
      const startedAt = Date.now()
      // This wait owns delivery for the children it covers (see subagent_send)
      // — and it claims their pending notes FIRST, before any awaited setup:
      // a child completing during the watermark reads below could otherwise
      // inject its notification and then have this wait return the same reply
      // again. Claims are consumed by delivered outcomes and restored on
      // abort or timeout.
      const collectTargets = explicit.length ? targets : busyTargets
      const claims = new Map(
        collectTargets.map((id): [string, PendingNotify[]] => [
          id,
          claimNotifies(id, ctx.sessionID),
        ]),
      )
      // Reuse tracked anchors, but inspect the tail for newer work before trusting
      // an old registration. A long run can age its user message out before this
      // first wait; its assistant steps still identify that user by parentID.
      // Recover it with one exact read, never by accepting an uncorrelated reply.
      // If any target is uncertain, fail the whole setup and restore every claim.
      const watermarks = new Map<string, ReplyAnchor>()
      await Promise.all(
        busyTargets.map(async (id) => {
          try {
            const anchor = await withTimeout(
              async (signal): Promise<ReplyAnchor> => {
                const messages = await fetchMessages(id, signal)
                signal.throwIfAborted()
                let tracked: ReplyAnchor | undefined
                for (const entry of [
                  ...(claims.get(id) ?? []),
                  ...(notifies.get(id) ?? []),
                  ...(waiters.get(id) ?? []),
                ]) {
                  const candidate = entry.replyAnchor
                  if (!candidate) continue
                  // Retain visibility on every claim, even if newer work wins below.
                  candidate.observed ||= hasReplyAnchor(
                    messages,
                    candidate.messageID,
                  )
                  if (!tracked || candidate.messageID > tracked.messageID)
                    tracked = candidate
                }
                const visibleID = newestUserMessageID(messages)
                let messageID = visibleID
                for (const message of messages) {
                  if (
                    message.role === "assistant" &&
                    message.parentID &&
                    (!messageID || message.parentID > messageID)
                  )
                    messageID = message.parentID
                }
                if (tracked && (!messageID || tracked.messageID >= messageID))
                  messageID = tracked.messageID
                if (!messageID)
                  throw new Error(
                    "no user message or assistant parent was visible",
                  )
                for (const message of messages) {
                  if (
                    message.role === "assistant" &&
                    !message.parentID &&
                    message.id >= messageID
                  )
                    throw new Error(
                      "a newer assistant step has no reply parent",
                    )
                }
                if (tracked?.messageID === messageID) return tracked
                if (messageID !== visibleID) {
                  const { info } = unwrap(
                    await client.session.message({
                      path: { id, messageID },
                      query: { directory },
                      signal,
                    }),
                    `reading reply watermark ${messageID} of ${id}`,
                  )
                  if (
                    info?.id !== messageID ||
                    info.role !== "user" ||
                    info.sessionID !== id
                  )
                    throw new Error(
                      "assistant parent did not resolve to the expected user message",
                    )
                }
                return { messageID, observed: true }
              },
              Math.min(timeoutMs, options.injectConfirmTimeoutMs),
              { signal: AbortSignal.any([ctx.abort, disposeSignal.signal]) },
            )
            watermarks.set(id, anchor)
          } catch (error) {
            log(
              "warn",
              `could not capture a reply watermark for ${id}; refusing an uncorrelated wait: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }),
      )
      const uncorrelated = busyTargets.filter((id) => !watermarks.has(id))
      if (uncorrelated.length) {
        for (const [id, entries] of claims) restoreNotifies(id, entries)
        if (disposed) throw new Error(PLUGIN_DISPOSED_MESSAGE)
        if (ctx.abort.aborted) throw new Error(WAIT_ABORTED_MESSAGE)
        throw new Error(
          `Could not establish a reply watermark for ${uncorrelated.join(", ")}; no completions were collected. Retry subagent_wait.`,
        )
      }
      const correlatedTargets = busyTargets.flatMap((id) => {
        const replyAnchor = watermarks.get(id)
        return replyAnchor ? [{ id, replyAnchor }] : []
      })
      const settled = await Promise.allSettled(
        correlatedTargets.map(({ id, replyAnchor }) =>
          waitForChild(id, {
            replyAnchor,
            timeoutMs,
            abort: ctx.abort,
            abortMessage: WAIT_ABORTED_MESSAGE,
          }),
        ),
      )
      const aborted = settled.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      if (aborted) {
        // Nothing was delivered — every claim revives, idle targets included.
        for (const [id, entries] of claims) restoreNotifies(id, entries)
        throw aborted.reason instanceof Error
          ? aborted.reason
          : new Error(String(aborted.reason))
      }

      const outcomes = settled.map(
        (result) => (result as PromiseFulfilledResult<WaitOutcome>).value,
      )
      const uncertain = new Set<string>()
      correlatedTargets.forEach(({ id }, index) => {
        // A timed-out child's completion was not consumed; its note revives.
        if (outcomes[index]?.kind === "timeout") {
          const anchor = watermarks.get(id)
          if (anchor?.initial && !anchor.observed) uncertain.add(id)
          restoreNotifies(id, claims.get(id) ?? [])
        }
      })

      // Explicit already-idle targets: their latest completed outcome, read
      // now. A claimed pending note pins the extraction to the message that
      // completion must answer (so an interrupted run reads as "no new reply",
      // not as a previous run's reply); with no note pending, the latest reply
      // is the answer. An unreadable transcript restores the claim — the
      // completion is not consumed by an answer that never rendered.
      const idleOutcomes = new Map<string, ChildOutcome>()
      if (explicit.length) {
        await Promise.all(
          idleTargets.map(async (id) => {
            const entries = claims.get(id) ?? []
            const anchor = entries[0]?.replyAnchor
            try {
              const messages = await fetchMessages(id)
              const outcome = extractChildOutcome(messages, anchor?.messageID)
              if (anchor?.initial && !anchor.observed) {
                anchor.observed =
                  hasReplyAnchor(messages, anchor.messageID) ||
                  (await injectedMessageVisibility(id, anchor.messageID)) ===
                    "visible"
                if (!anchor.observed) {
                  uncertain.add(id)
                  restoreNotifies(id, entries)
                  return
                }
              }
              idleOutcomes.set(id, outcome)
            } catch {
              if (anchor?.initial && !anchor.observed) uncertain.add(id)
              restoreNotifies(id, entries)
            }
          }),
        )
      }

      const finished = outcomes.filter(
        (outcome) => outcome.kind !== "timeout",
      ).length
      const sections: string[] = [
        busyTargets.length
          ? `Waited ${formatDuration(Date.now() - startedAt)}; ${finished} of ${busyTargets.length} busy subagent(s) finished.`
          : "None of those subagents are busy; checking for completed results.",
      ]
      const renderOutcome = (id: string, outcome: ChildOutcome) => {
        if (outcome.kind === "replied") {
          const reply = truncateReply(outcome.text, options.maxReplyChars)
          sections.push(
            renderTaskBlock({
              sessionID: id,
              state: "completed",
              summary: "Latest reply",
              text: reply.text,
            }),
          )
        } else if (outcome.kind === "errored") {
          sections.push(
            renderTaskBlock({
              sessionID: id,
              state: "error",
              text: outcome.error,
            }),
          )
        } else {
          sections.push(
            `- ${id} went idle without a new reply (it may have been interrupted).`,
          )
        }
      }
      busyTargets.forEach((id, index) => {
        const outcome = outcomes[index]
        if (outcome === undefined) return
        if (uncertain.has(id)) return
        if (outcome.kind === "deleted") {
          sections.push(`- ${id} was deleted while waiting.`)
        } else if (outcome.kind === "timeout") {
          sections.push(`- ${id} is still working.`)
        } else if (outcome.kind === "ended") {
          sections.push(
            `- ${id} went idle without a new reply (it may have been interrupted).`,
          )
        } else {
          renderOutcome(id, outcome)
        }
      })
      for (const id of idleTargets) {
        if (uncertain.has(id)) continue
        if (!explicit.length) {
          sections.push(`- ${id} was already idle.`)
        } else if (idleOutcomes.has(id)) {
          renderOutcome(id, idleOutcomes.get(id) as ChildOutcome)
        } else {
          sections.push(
            `- ${id} is idle, but reading its latest reply failed just now; try again.`,
          )
        }
      }
      for (const id of uncertain) {
        const anchor = claims.get(id)?.[0]?.replyAnchor
        if (anchor)
          sections.push(
            `- ${id}: ${initialLaunchText(anchor.messageID, !!anchor.initial?.parked)}`,
          )
      }
      const collected = explicit.length
        ? idleTargets.filter((id) => idleOutcomes.has(id))
        : []
      return {
        title: busyTargets.length
          ? `Waited on ${busyTargets.length} subagent(s)`
          : `Collected ${collected.length} subagent result(s)`,
        output: sections.join("\n"),
        metadata: {
          waited: [
            ...busyTargets.filter(
              (_, index) => outcomes[index]?.kind !== "timeout",
            ),
            ...collected,
          ],
          stillBusy: busyTargets.filter(
            (id, index) =>
              outcomes[index]?.kind === "timeout" && !uncertain.has(id),
          ),
          ...(uncertain.size ? { uncertain: [...uncertain] } : {}),
        },
      }
    },
  })

  const subagent_kill = tool({
    description: SUBAGENT_KILL_DESCRIPTION,
    args: {
      session_id: z
        .string()
        .min(1)
        .describe(
          'Child session id, e.g. "ses_...", from subagent_spawn, subagent_list, or a task tool result.',
        ),
    },
    execute: async (args, ctx) => {
      const info = await requireDirectChild(ctx.sessionID, args.session_id)
      const childID = info.id
      const title = `${truncateLabel(info.title ?? childID, TITLE_MAX_CHARS)} (${childID})`
      // If live status can't be read, don't assume idle — aborting an
      // already-idle child is harmless, so err toward stopping it.
      let busyNow: boolean
      try {
        busyNow = Boolean((await statusMap())[childID])
      } catch {
        busyNow = true
      }
      if (!busyNow) {
        const initial = (notifies.get(childID) ?? []).find(
          (entry) =>
            entry.parentID === ctx.sessionID && entry.replyAnchor.initial,
        )
        // Do not poison future claim restoration for an observed notification
        // we deliberately leave pending. No live note can also mean an off-map
        // claim or a spawn still confirming, so `initial` must not gate the tombstone.
        const retained =
          initial?.replyAnchor.observed && !initial.replyAnchor.initial?.parked
        if (!retained) clearedInitialLaunches.add(childID)
        if (initial && !retained) removeNotify(initial)
        return {
          title,
          output:
            initial && !retained
              ? `Subagent ${childID} is currently idle; cleared its unconfirmed initial-launch tracking (${initial.replyAnchor.messageID}). The session is preserved. This does not prove the original request was cancelled; do not resend the same work blindly.`
              : killedIdleText(childID),
          metadata: {
            sessionId: childID,
            aborted: false,
            ...(initial && !retained
              ? {
                  trackingCleared: true,
                  promptMessageId: initial.replyAnchor.messageID,
                }
              : {}),
          },
        }
      }
      // The kill result IS the delivery, so park the pending completion note.
      // If the abort itself fails, restore it: the child is still running and
      // its parent must still hear when it finishes.
      const claimed = claimNotifies(childID, ctx.sessionID)
      // The catch above assumed busy, which is the right reading of a status
      // that could not be READ but not of one this plugin cancelled itself.
      // The confirm wait below swallows every rejection, so the guard in
      // waitForChild cannot stop the abort — only this can, and an abort is a
      // write to a host the plugin has already finished talking to.
      if (disposed) throw new Error(PLUGIN_DISPOSED_MESSAGE)
      let abortError: unknown
      try {
        const result = await client.session.abort({
          path: { id: childID },
          query: { directory },
        })
        abortError = "error" in result ? result.error : undefined
      } catch (error) {
        restoreNotifies(childID, claimed)
        throw new Error(
          `aborting ${childID} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (abortError) {
        restoreNotifies(childID, claimed)
        throw new Error(
          `aborting ${childID} failed: ${JSON.stringify(abortError)}`,
        )
      }
      // The RPC succeeded; aborted:false below only means idle confirmation
      // failed. A concurrent claim/spawn may have returned while it was pending.
      clearedInitialLaunches.add(childID)
      for (const entry of notifies.get(childID) ?? []) {
        if (entry.parentID === ctx.sessionID && entry.replyAnchor.initial)
          removeNotify(entry)
      }
      const outcome = await waitForChild(childID, {
        replyAnchor: undefined,
        timeoutMs: KILL_CONFIRM_MS,
        abort: ctx.abort,
        abortMessage: `The abort was sent to ${childID}, but confirming it was interrupted.`,
      }).catch(() => ({ kind: "timeout" }) as WaitOutcome)
      if (outcome.kind === "deleted") {
        // The child vanished during the confirm window: stopped, but gone —
        // never claim its session is preserved and resumable.
        log(
          "info",
          `aborted subagent ${childID} for session ${ctx.sessionID} (session deleted)`,
        )
        return {
          title,
          output: killedDeletedText(childID),
          metadata: { sessionId: childID, aborted: true, deleted: true },
        }
      }
      const confirmed = outcome.kind !== "timeout"
      log(
        "info",
        `aborted subagent ${childID} for session ${ctx.sessionID} (confirmed: ${confirmed})`,
      )
      return {
        title,
        output: killedText(childID, confirmed),
        metadata: { sessionId: childID, aborted: confirmed },
      }
    },
  })

  // ---- hooks ---------------------------------------------------------------

  return {
    tool: {
      subagent_models,
      subagent_spawn,
      subagent_send,
      subagent_list,
      subagent_wait,
      subagent_kill,
    },

    event: async ({ event }) => {
      // The parse is the host's contract and is shared with cron and
      // background-tasks; what this plugin does with the answer is its own —
      // and unlike theirs, the hint it keeps is never the authority (isBusy).
      const seen = sessionActivityFromEvent(event)
      if (!seen) return
      const sessionID = seen.sessionID
      if (seen.activity === "busy" || seen.activity === "retry") {
        busySessions.add(sessionID)
        trim(busySessions)
        resetGrace(sessionID)
        return
      }
      busySessions.delete(sessionID)
      if (seen.activity === "idle") {
        void settleChild(sessionID)
        return
      }
      // Deleted: nothing left to settle, and nobody left to notify.
      for (const waiter of [...(waiters.get(sessionID) ?? [])])
        waiter.settle({ kind: "deleted" })
      notifies.delete(sessionID)
      clearedInitialLaunches.delete(sessionID)
      for (const [childID, entries] of [...notifies]) {
        const remaining = entries.filter(
          (entry) => entry.parentID !== sessionID,
        )
        if (remaining.length) notifies.set(childID, remaining)
        else notifies.delete(childID)
      }
      syncPoller()
    },

    "tool.definition": async (input, output) => {
      if (!options.taskHint || input.toolID !== "task") return
      output.description += taskHint(options.notify)
    },

    dispose: async () => {
      disposed = true
      if (poller) clearInterval(poller)
      poller = undefined
      // Cancels status/catalog reads still awaiting the host, so shutdown does
      // not wait out their deadlines.
      disposeSignal.abort()
      for (const set of [...waiters.values()]) {
        for (const waiter of [...set])
          waiter.fail(new Error(PLUGIN_DISPOSED_MESSAGE))
      }
      waiters.clear()
      notifies.clear()
      clearedInitialLaunches.clear()
      busySessions.clear()
      settleQueue.clear()
      pendingSpawns.clear()
    },
  }
}

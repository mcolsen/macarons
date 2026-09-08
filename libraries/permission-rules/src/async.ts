import crypto from "node:crypto"
import { trim } from "./engine"

// ---------------------------------------------------------------------------
// Timers, deadlines and serialization
//
// Three primitives every plugin was hand-rolling. They live together because
// they answer one question — "how does asynchronous work end?" — and because
// each had drifted: timers that forgot to unref (cron, usage-limits) held
// their process open, and a timeout race without an abort left the request it
// gave up on still running.
// ---------------------------------------------------------------------------

/**
 * The largest delay setTimeout/setInterval accept (2^31-1 ms, ~24.9 days).
 * Anything larger silently becomes a 1 ms timer — a scheduled job would fire
 * immediately and forever — so every millisecond option in the suite clamps to
 * this ceiling.
 */
export const MAX_TIMER_MS = 2_147_483_647

/**
 * Drop a timer's hold on the event loop. A plugin's timers are never the
 * reason its process should stay alive: the server is kept up by its listening
 * socket and the TUI by its terminal, so a pending arm must not outvote a
 * shutdown. `unref` is Node/Bun-only and absent under some test doubles, hence
 * the optional call.
 */
export function unrefTimer<T>(timer: T): T {
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return timer
}

/** An interval that never keeps a process alive on its own (tests included). */
export function every(
  callback: () => void,
  ms: number,
): ReturnType<typeof setInterval> {
  return unrefTimer(setInterval(callback, ms))
}

/**
 * Run `work` under a deadline, giving it a signal that is aborted when the
 * deadline passes or when the caller's own `signal` aborts.
 *
 * Both halves are load-bearing, which is why the ~10 hand-rolled copies this
 * replaces were each missing one of them:
 *
 * - The **abort** is what actually cancels the work. A race alone only stops
 *   the waiting — a timed-out request stays in flight and can still land after
 *   the caller moved on (reordering a queue, starting a turn nobody expected),
 *   and a timed-out read keeps its connection.
 * - The **race** is what guarantees the caller advances. Whether a given host
 *   transport honors the signal it is handed is a version detail, and the v1
 *   SDK turns request timeouts off entirely (`req.timeout = false`), so work
 *   that ignores its signal would otherwise park the caller forever — the
 *   exact failure the bound exists to prevent.
 *
 * Rejects with `timed out after ${ms}ms` at the deadline, or with the caller's
 * abort reason when the outer signal fires. The timer is unref'd (a pending
 * deadline must not hold the process open) and always cleared.
 */
export async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  options: { signal?: AbortSignal; message?: string } = {},
): Promise<T> {
  const abortError = (signal: AbortSignal): Error =>
    signal.reason instanceof Error ? signal.reason : new Error("aborted")
  const outer = options.signal
  if (outer?.aborted) return Promise.reject(abortError(outer))
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // One listener, removed in the finally: a long-lived outer signal (a
  // dispose controller shared by every call) would otherwise accumulate one
  // per call for the life of the process.
  let onOuterAbort: (() => void) | undefined
  try {
    // Armed before the work is dispatched, because two orderings decide
    // whether the bound actually holds:
    //
    // - **Settle, then abort.** Abort listeners run synchronously, so work
    //   that resolves from its own abort handler queues its reaction first
    //   and wins the race the deadline just lost — withTimeout would resolve
    //   with a value produced *by* the timeout it is supposed to report.
    // - **Listen before dispatch.** An abort listener added to an
    //   already-aborted signal never fires, so work that aborts the caller's
    //   signal synchronously would miss cancellation entirely and park until
    //   the deadline.
    const stopped = new Promise<never>((_, reject) => {
      timer = unrefTimer(
        setTimeout(() => {
          reject(new Error(options.message ?? `timed out after ${ms}ms`))
          controller.abort()
        }, ms),
      )
      if (!outer) return
      onOuterAbort = () => {
        reject(abortError(outer))
        controller.abort(outer.reason)
      }
      outer.addEventListener("abort", onOuterAbort, { once: true })
    })
    // Dispatched inside an async wrapper so a work function that throws
    // synchronously becomes a rejection this race can settle on — `stopped`
    // is already armed, and an unraced one would reject unhandled at the
    // deadline.
    return await Promise.race([
      (async () => work(controller.signal))(),
      stopped,
    ])
  } finally {
    clearTimeout(timer)
    if (onOuterAbort) outer?.removeEventListener("abort", onOuterAbort)
  }
}

/**
 * A queue that runs its work one at a time, in submission order, on a promise
 * chain. The idiom every plugin that serializes writes to one file had
 * open-coded: `chain = chain.then(...)`.
 *
 * This is IN-PROCESS ordering only — it is not a lock. Concurrent processes
 * writing the same file still need withStoreLock; what this prevents is one
 * process's own interleaved read-modify-write sequences losing an update.
 *
 * A rejected job never breaks the chain (the next job still runs), and
 * `push` resolves or rejects with its own job's outcome, so a caller that
 * wants to know can await it and one that does not can drop it.
 */
export type SerialQueue = {
  push: <T>(job: () => Promise<T>) => Promise<T>
  /** Resolves when everything queued so far has settled. */
  drain: () => Promise<void>
}

export function createSerialQueue(): SerialQueue {
  let chain: Promise<unknown> = Promise.resolve()
  return {
    push: <T>(job: () => Promise<T>): Promise<T> => {
      const result = chain.then(job)
      // The chain itself must never reject, or every later job would be
      // skipped; the caller's copy of the promise keeps the rejection.
      chain = result.catch(() => {})
      return result
    },
    drain: () => chain.then(() => {}),
  }
}

/**
 * One flight at a time, plus exactly one catch-up run for everything that
 * arrived during it.
 *
 * The opposite policy to createSerialQueue above, for the opposite kind of
 * work: a queue is right when every call must HAPPEN, and this is right when
 * every call only has to be ANSWERED — re-reading a state file, re-fetching a
 * quota. Ten pokes during one read do not need ten reads; they need the read
 * in flight plus one more, because the in-flight one may have already passed
 * the point where it would have seen what the tenth poke is about.
 *
 * The queued follow-up is what makes the collapse safe, and it is exactly the
 * part a hand-rolled `if (busy) return` drops: without it, the last update in
 * a burst is the one that gets discarded, and the display stays stale until
 * some unrelated tick happens along. It runs with `followUp` as its arguments
 * — the "forced" form of the call, since a collapsed burst must not then be
 * skipped by the caller's own freshness or mtime gate — and it is scheduled on
 * a microtask rather than awaited inside the finally, so the flight that
 * happened to be last does not end up owning an unbounded chain of successors.
 *
 * `queues` decides whether a call landing mid-flight earns that follow-up at
 * all; the default is every call. usage-limits' quota refresh passes one
 * because a forced refresh or a credential generation change is news its
 * in-flight response predates — an ordinary overlapping poll is dropped.
 *
 * A caller's own rejection is not swallowed — the returned promise settles as
 * `run` did — and the follow-up still fires afterwards (the flag is cleared in
 * a finally), so one failed read cannot wedge the flag and stop every later
 * one. The FOLLOW-UP's rejection is different and has to be: nobody is holding
 * that promise, and an unhandled rejection from a background catch-up read can
 * take the process down. It goes to `onFollowUpError`, which defaults to
 * dropping it — the same disposition every call site already applies to these
 * promises by hand (`void sync(...)`, `.catch(() => {})`), now stated once
 * instead of depending on each body happening to be throw-free.
 */
export function singleFlight<T extends unknown[]>(
  run: (...args: T) => Promise<unknown>,
  input: {
    /** Arguments for the catch-up run — the "forced" form of the call. */
    followUp: T
    /** Whether a call arriving mid-flight queues one. Default: always. */
    queues?: (...args: T) => boolean
    /** Where a catch-up run's rejection goes. Default: dropped. */
    onFollowUpError?: (error: unknown) => void
  },
): (...args: T) => Promise<void> {
  let inFlight = false
  let queued = false
  const flight = async (...args: T): Promise<void> => {
    if (inFlight) {
      if (input.queues?.(...args) ?? true) queued = true
      return
    }
    inFlight = true
    try {
      await run(...args)
    } finally {
      inFlight = false
      if (queued) {
        // Consumed before re-entering, so a call arriving during the follow-up
        // queues its own turn instead of being folded into one already spent.
        queued = false
        queueMicrotask(() => {
          flight(...input.followUp).catch((error) => {
            input.onFollowUpError?.(error)
          })
        })
      }
    }
  }
  return flight
}

// ---------------------------------------------------------------------------
// Host SDK results and message ids
// ---------------------------------------------------------------------------

/**
 * The value out of an SDK `{ data, error }` result, or a thrown error naming
 * what was being done.
 *
 * Strict on BOTH legs, because the lenient copy this replaces (btw's) returned
 * `result.data as T` and so handed callers an `undefined` typed as `T` —
 * a success-shaped answer for a call that produced nothing, surfacing later as
 * a property read on undefined far from the request that failed.
 */
export function unwrap<T>(
  result: { data?: T; error?: unknown },
  what: string,
): T {
  if (result.error !== undefined && result.error !== null)
    throw new Error(`${what} failed: ${JSON.stringify(result.error)}`)
  if (result.data === undefined) throw new Error(`${what} returned no data`)
  return result.data
}

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/**
 * A message id in the host's own ascending format — the shape
 * `Identifier.ascending("message")` mints: `"msg_"` + 12 hex chars of a 48-bit
 * stamp packing `millisecond << 12 | counter`, then 14 random base62 chars.
 * The prompt routes honor a caller-supplied messageID verbatim, validating
 * only the `msg` prefix, so this is a *host format* the suite must mirror
 * exactly — precisely the kind of thing that must have one definition site.
 *
 * Message ordering sorts by creation time with the id as tiebreaker, so where
 * a minted id lands relative to a host-minted one in the same millisecond is
 * what `counter` controls:
 *
 * - **0** (the default) for a prompt into a session with no in-flight host
 *   message to outsort — a freshly created session, a scheduled fire.
 * - **the counter ceiling** for a steer into a session that is mid-run, whose
 *   in-flight assistant message the host minted first and may share the
 *   millisecond with. Sorting below that assistant would make the running loop
 *   read `lastUser < lastAssistant` and exit, silently dropping the steer.
 *
 * Two ids minted in the same millisecond with the same counter differ only in
 * the random tail, so their relative order is unspecified.
 */
export const MESSAGE_COUNTER_MAX = 0xfff

export function mintMessageID(now = Date.now(), counter = 0): string {
  const stamp =
    ((BigInt(now) << 12n) | (BigInt(counter) & 0xfffn)) & 0xffffffffffffn
  let tail = ""
  for (const byte of crypto.randomBytes(14)) tail += BASE62_ALPHABET[byte % 62]
  return `msg_${stamp.toString(16).padStart(12, "0")}${tail}`
}

// ---------------------------------------------------------------------------
// Session busy/idle
//
// Two plugins have to answer "is a model turn running in this session?" before
// they write into it — cron holds a fired job, background-tasks holds a
// completion note — and both had built the same core around it (audit
// 2026-07-23 §2.2): a cache fed from session.status/session.idle, a one-shot
// GET /session/status for sessions no event has been seen for, and "when the
// answer is unknown, not idle". What each does with the answer — cron's
// pending flag, background-tasks' parked notes and optimistic-busy mark — is
// genuinely different delivery policy and stays in the plugins (§2.9).
//
// The host contract this encodes, from opencode v1.18.5:
//
//   - SessionStatus.set (session/status.ts:39-48) publishes session.status
//     (plus the deprecated session.idle when idle) and THEN mutates its map:
//     idle DELETES the key, busy/retry set it. So GET /session/status lists
//     only non-idle sessions and absence from a successful answer is the only
//     reading of "idle" available.
//   - That publish walks the plugin event hooks synchronously, in-process,
//     before the map is touched (plugin/index.ts:251-258). A tracker that
//     records before its first await therefore knows everything the endpoint
//     knows, which is why the endpoint is consulted for unseen sessions only.
//     It is needed for those: listeners are live-only, with no replay, so a
//     session that went busy before the plugin loaded has left no trace
//     (core/event.ts:606-612, server/routes/.../event.ts:29-77). Missing a
//     LIVE event takes something throwing synchronously out of that dispatch
//     ahead of us — a sibling plugin's hook (it is a plain `for` over every
//     plugin's hook) or a listener registered before the plugin dispatcher,
//     since non-durable events are notified un-isolated (core/event.ts:393).
//     A feed broken that way swallows the idle events every delivery here
//     waits on, and aborts the publish before the map is written too, so it is
//     a host-level failure rather than something one more read would repair.
//   - Only the literal "idle" is idle. "retry" is a sleeping attempt INSIDE a
//     live run (session/processor.ts:656-674) whose loop re-reads history
//     every pass, so a prompt written then is absorbed as a steer — and a
//     status type this suite has not heard of gets the same treatment.
//   - The map is per-directory (effect/instance-state.ts:47-50). An unscoped
//     call answers for the server process's cwd, where our session's absence
//     would read as idle.
//   - Deleting a session never clears its status entry (session/session.ts:
//     608-628), so session.deleted evicts here rather than being left to age.
//
// What no ordinary tracker read can see, and what the plugins' own marks exist
// for:
// promptAsync answers 204 several database round trips before its forked run
// reaches status.set(busy) (session/prompt.ts:1088), and halt() publishes idle
// while the runner is still Running (session/processor.ts:624). Both windows
// report idle from the events AND from the endpoint. A caller that has held its
// own grace period may request a fresh endpoint read to recover when no later
// event arrived, but the grace period remains the caller's policy.
// ---------------------------------------------------------------------------

/** The host's SessionStatus vocabulary. Only `"idle"` means the session is free. */
export type SessionActivity = "idle" | "busy" | "retry"

/**
 * What a host event just said about one session. `"gone"` is a deletion — the
 * entry is evicted rather than recorded, because the host keeps its own.
 */
export type SessionActivityObservation = {
  sessionID: string
  activity: SessionActivity | "gone"
}

export type SessionActivityTracker = {
  /**
   * Record what one host event says — `sessionActivityFromEvent` plus the
   * record. Returns the observation so the caller can run its own policy on it
   * (flush what was parked, drop a session's work), or undefined for an event
   * that carries nothing about session activity.
   *
   * Call this BEFORE the handler's first await: the recording is what makes
   * the cache as current as the host's own map (see the section header).
   */
  observe(event: unknown): SessionActivityObservation | undefined
  /**
   * Whether a prompt written now would land in an idle session rather than
   * steer a running turn. Answers from the events when there are any, from one
   * `GET /session/status` when there are none, and `false` when neither can
   * say — the direction that costs a delay instead of a hijacked turn.
   *
   * `refresh` bypasses a previously observed idle and asks the host again. A
   * non-idle observation remains authoritative, and any event that arrives
   * during the request beats its older snapshot. This is for a caller that has
   * already waited for an expected busy→idle transition that never arrived.
   */
  isIdle(sessionID: string, options?: { refresh?: boolean }): Promise<boolean>
  /** Forget everything. For dispose(); the tracker is otherwise self-bounding. */
  clear(): void
}

/**
 * Bound for the fallback status read. Ten seconds is long for a loopback GET
 * and short next to what it gates: cron's fire loop and background-tasks'
 * per-session notification queue both await this answer, so an unbounded read
 * against a wedged host would stall every later delivery, not just this one.
 */
export const SESSION_STATUS_PROBE_TIMEOUT_MS = 10_000

/**
 * Classify one `SessionStatus` payload. `undefined` means "nothing readable
 * here", which callers turn into not-idle; a readable type that is neither
 * `idle` nor `retry` is treated as busy, so a status the host adds later is
 * non-idle from the day it ships rather than the day this suite hears of it.
 */
function sessionActivityOf(status: unknown): SessionActivity | undefined {
  const type = (status as { type?: unknown } | undefined)?.type
  if (typeof type !== "string" || type === "") return undefined
  if (type === "idle") return "idle"
  if (type === "retry") return "retry"
  return "busy"
}

/**
 * What one host event says about one session's activity — the event half of
 * the contract above, with no state kept and nothing asked of the host.
 *
 * Exported on its own for a consumer that shares the host's event shapes but
 * not the tracker's answer: subagent-comms decides busy/idle endpoint-first on
 * every call, because it orders steers INTO subagents rather than deciding
 * whether to interrupt a user's turn, and it reads the whole map at once for
 * every child it is watching. That is deliberate divergence (audit §2.9), and
 * it is also the reason this parse must not be a third fork — three plugins
 * narrowing `session.status` payloads by hand is how the shapes drift.
 */
export function sessionActivityFromEvent(
  event: unknown,
): SessionActivityObservation | undefined {
  const { type, properties } = (event ?? {}) as {
    type?: unknown
    properties?: unknown
  }
  const props = (properties ?? {}) as {
    sessionID?: unknown
    status?: unknown
    info?: { id?: unknown } | null
  }
  const idOf = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined
  if (type === "session.status") {
    const sessionID = idOf(props.sessionID)
    if (sessionID === undefined) return undefined
    // An unreadable payload is still a status change, and the only safe
    // reading of one is "not idle" — the next idle event clears it.
    return { sessionID, activity: sessionActivityOf(props.status) ?? "busy" }
  }
  // Deprecated by the host and strictly redundant (every idle transition
  // publishes session.status first), kept because it costs one line and a host
  // that ever publishes only the legacy form still tracks correctly.
  if (type === "session.idle") {
    const sessionID = idOf(props.sessionID)
    return sessionID === undefined ? undefined : { sessionID, activity: "idle" }
  }
  if (type === "session.deleted") {
    // The v1 SDK types only `info`, the wire carries both.
    const sessionID = idOf(props.info?.id) ?? idOf(props.sessionID)
    return sessionID === undefined ? undefined : { sessionID, activity: "gone" }
  }
  return undefined
}

export function createSessionActivityTracker(input: {
  client: unknown
  directory: string
  /** Deadline for the fallback read. Default SESSION_STATUS_PROBE_TIMEOUT_MS. */
  timeoutMs?: number
  /** Aborted on dispose, so a shutdown does not leave a read in flight. */
  signal?: AbortSignal
}): SessionActivityTracker {
  // Values are records rather than bare strings so a refresh can compare
  // object identity across its await. That avoids a numeric generation's ABA
  // problem if this bounded map evicts and then re-adds the same session.
  const observed = new Map<string, { activity: SessionActivity }>()
  const timeoutMs = input.timeoutMs ?? SESSION_STATUS_PROBE_TIMEOUT_MS

  return {
    observe(event) {
      const seen = sessionActivityFromEvent(event)
      if (!seen) return undefined
      // A deletion evicts rather than records: the host keeps its own entry
      // for a deleted session forever, so a record here would be the only one
      // nothing could correct.
      if (seen.activity === "gone") observed.delete(seen.sessionID)
      else {
        observed.set(seen.sessionID, { activity: seen.activity })
        // Bounded like every other per-session map in the suite. Eviction is
        // safe in a way it would not be for a busy-only set: an evicted entry
        // reads as unseen, and unseen goes to the host rather than to a guess.
        trim(observed)
      }
      return seen
    },

    async isIdle(sessionID, options) {
      const seen = observed.get(sessionID)
      const refresh = options?.refresh === true
      // A fresh read is useful only for an idle observation that may have gone
      // stale after a prompt was stored. Busy/retry is the safe answer and was
      // published before the endpoint's map update, so never second-guess it.
      if (seen && (!refresh || seen.activity !== "idle")) {
        return seen.activity === "idle"
      }
      const session = (
        input.client as {
          session?: {
            status?: (input: unknown) => Promise<{
              data?: unknown
              error?: unknown
            }>
          }
        }
      ).session
      // No route to ask and no event to go on: not idle.
      if (typeof session?.status !== "function") return false
      // The generated client's methods are prototype methods reading
      // `this._client`, so the call stays bound to `client.session`.
      const status = session.status.bind(session)
      try {
        const result = await withTimeout(
          (signal) => status({ query: { directory: input.directory }, signal }),
          timeoutMs,
          {
            signal: input.signal,
            message: `the host did not answer /session/status within ${timeoutMs} ms`,
          },
        )
        // An observation beats a request ACROSS the await, not only before
        // it. observe() runs synchronously from the host's publish, and that
        // publish walks the plugin hooks BEFORE the map this response was
        // serialized from is mutated (see the section header) — so anything
        // recorded while this request was in flight is strictly newer than
        // the snapshot coming back. Read ahead of `error` and ahead of the
        // payload for the same reason: a record is better evidence than a
        // read that failed. Without this the one leg that consults the host
        // is the one leg that ignores the events.
        //
        // A bare lookup suffices; no generation counter is needed. This leg
        // runs only because the lookup above MISSED, so anything found now
        // was recorded during this call's own flight — there is no older
        // value a repeat could be confused with. A deletion is deliberately
        // NOT covered: it evicts rather than records, so it leaves this
        // lookup empty and the host answers instead, which is exactly what
        // the section header says a deleted session should get.
        const meanwhile = observed.get(sessionID)
        if (refresh) {
          if (meanwhile !== seen) {
            return meanwhile?.activity === "idle"
          }
        } else if (meanwhile) return meanwhile.activity === "idle"
        // The generated client reports a non-2xx as `{ error }` rather than
        // throwing, and its `data` is then undefined — which would otherwise
        // read exactly like the empty (all-idle) map.
        if (result.error) return false
        const map = result.data
        if (!map || typeof map !== "object" || Array.isArray(map)) return false
        // Deliberately NOT cached: the fallback only runs for a session no
        // event has described, so this answer has nothing to confirm it and
        // nothing to expire it. Caching a busy read from a feed that has never
        // delivered for this session would need an idle event from that same
        // feed to clear it, and there is no evidence one is coming; re-reading
        // costs one GET on a path that is already the rare one.
        const entry = (map as Record<string, unknown>)[sessionID]
        return entry === undefined || sessionActivityOf(entry) === "idle"
      } catch {
        // Timed out, aborted, or the transport failed: nothing was learned
        // from the HOST. An event may still have landed while we waited, and
        // the same ordering makes it the better answer — a wedged host is
        // also when a parked delivery most needs the idle it would otherwise
        // have to wait for a second time. Absent, it reads false as before.
        if (refresh && observed.get(sessionID) === seen) return false
        return observed.get(sessionID)?.activity === "idle"
      }
    },

    clear() {
      observed.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin options
//
// Options arrive as user-typed JSON from an opencode.json plugin tuple, so
// every reader must be total. The suite had settled on three different answers
// to "the user wrote something unusable" — clamp silently, clamp without a
// floor, or reject and warn — which is one answer too many.
//
// The house default for a NEW option is rejectNumber: a present-but-unusable
// value is reported and the documented default stands in. The reasoning is
// cache-ratio's (audit finding L-UM3), the one that was written down: clamping
// silently accepted `floorFraction: 0`, which turned detection off without
// telling anyone, and a plugin cannot know whether the user meant the value or
// mistyped it. clampNumber stays for the options already documented as
// clamping — their ranges are ergonomic bounds ("at least 250 ms"), not
// correctness gates, and re-reading them as rejections would change behavior
// users already rely on.
//
// String-array options go through toStringArray (below); millisecond options
// cap at MAX_TIMER_MS (above).
// ---------------------------------------------------------------------------

/** Out-of-range, non-numeric or absent → within range. Floors to an integer. */
export function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/**
 * Absent → undefined (the caller's default applies). Present and acceptable →
 * the value. Present and unusable → undefined, with a line pushed onto
 * `problems` naming the key, the expected range, and what was ignored; the
 * caller surfaces the collected problems (a toast, the app log) so a
 * misconfiguration is visible rather than silently overridden.
 */
export function rejectNumber(input: {
  key: string
  value: unknown
  /** Human phrasing of the accepted range, e.g. "of at least 0". */
  range: string
  accepts: (value: number) => boolean
  problems: string[]
}): number | undefined {
  const { value } = input
  if (value === undefined) return undefined
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    input.accepts(value)
  )
    return value
  // JSON.stringify renders NaN/Infinity as "null" and is undefined for a
  // symbol, so numbers are shown raw and anything else defensively.
  const shown =
    typeof value === "number"
      ? String(value)
      : (JSON.stringify(value) ?? String(value))
  input.problems.push(
    `${input.key} must be a number ${input.range} (ignoring ${shown})`,
  )
  return undefined
}

/**
 * Absent → the default; an explicit non-boolean fails CLOSED, not open. Used
 * where the option restricts something (an egress backend, a capability): a
 * typo in a value meant to switch a thing OFF must never read as leaving it on,
 * so only literal `true` enables. Options that merely toggle a convenience keep
 * the suite's looser `value !== false`.
 */
export function explicitBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === true
}

/**
 * A keybind option: the host's comma-separated alternatives string, `"none"`
 * (or `false`) to bind nothing, absent for the plugin's own default.
 *
 * Unusable values DISABLE the binding rather than falling back to the default.
 * A keybinding is the one option class where guessing is actively harmful — a
 * default key silently bound behind a typo can shadow a host or sibling-plugin
 * chord the user is already using, and AGENTS.md requires a collision audit
 * before any key ships. Plugins with no auditable default (background-tasks)
 * simply pass no fallback.
 */
export function keybindOption(
  value: unknown,
  fallback?: string,
): string | undefined {
  if (value === undefined) return fallback
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed && trimmed !== "none" ? trimmed : undefined
}

export type ModelRef = { providerID: string; modelID: string }

/**
 * OpenCode writes model references as "provider/model", the same format
 * opencode.json's `model` field takes. Model IDs may contain further slashes
 * (openrouter's "anthropic/claude-…") and provider IDs never do, so only the
 * FIRST separator splits. Surrounding whitespace is trimmed: these values are
 * hand-typed into JSON, where a stray space is a typo rather than a distinct
 * model id.
 */
export function parseModelRef(value: unknown): ModelRef | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  }
}

export function formatModelRef(model: ModelRef): string {
  return `${model.providerID}/${model.modelID}`
}

// ---------------------------------------------------------------------------
// User-facing text
//
// Both halves of several plugins render the same two things — a one-line label
// squeezed into a dialog row or a toast, and an elapsed time. Each had grown a
// private copy (subagent-comms and background-tasks carried byte-identical
// pairs; cron and web-search carried near-variants, one of them missing the
// negative-slice guard), so a rendering fix reached one surface and not the
// next.
// ---------------------------------------------------------------------------

/**
 * One line of label text for a dialog row, toast, or sidebar entry: interior
 * whitespace (newlines included) flattens to single spaces, and anything over
 * `max` is cut to `max` characters counting the ellipsis. `Math.max(0, …)`
 * matters — a `max` of 0 or 1 would otherwise slice from the end and return
 * the label minus its last character.
 */
export function truncateLabel(text: string, max: number): string {
  const flattened = text.replace(/\s+/g, " ").trim()
  return flattened.length > max
    ? `${flattened.slice(0, Math.max(0, max - 1))}…`
    : flattened
}

/**
 * Compact elapsed/duration code: "34s", "12m40s", "1h02m", "3d". Negative
 * input (a clock that moved backwards between two stamps) reads as "0s"
 * rather than a nonsense elapsed time.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`
  return `${Math.floor(hours / 24)}d`
}

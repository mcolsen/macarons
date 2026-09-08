import { rejectNumber, tuiToast, withTimeout } from "@macarons/permission-rules"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import type { AssistantMessage, StepFinishPart } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, Show, type Signal } from "solid-js"
import {
  type BreakOptions,
  DEFAULT_BREAK_OPTIONS,
  detectBreakSeries,
  formatPercent,
  formatTokens,
  isSubAgentSession,
  promptTokens,
  ratioSnapshot,
  routeSessionID,
  type StepSample,
  tuiGate,
  warnTui,
} from "./core"

/**
 * opencode-cache-ratio
 *
 * Shows the viewed session's prompt-cache hit ratio in the OpenCode sidebar,
 * live while the session runs, and alerts when a request appears to have
 * broken the prompt-cache prefix:
 *
 *   Cache
 *     hit 92% · last 96%
 *     1.2M cached · 210k written · 88k fresh
 *
 * "hit" is cached ÷ total prompt tokens across every API request of the
 * session so far, "last" the same for the newest request, and the second row
 * the session-wide sums the ratio derives from. Each request's usage comes
 * from the step-finish part OpenCode records per API call; the host
 * normalizes all providers to the same accounting (input excludes cached
 * tokens), so the math is provider-independent — see src/core.ts.
 *
 * The host TUI syncs only a session's newest 100 messages and evicts older
 * ones as new messages arrive, so the synced store alone would silently turn
 * these "session-wide" sums into a rolling window. The plugin therefore keeps
 * its own per-session record of every request: seeded once from the server's
 * full message history when a session is first viewed, then kept current from
 * live events even while unviewed, and refreshed from the synced store. If
 * that one fetch fails the section still works, covering synced and live
 * requests observed during this attach.
 *
 * When a request re-reads far less from cache than the request before it —
 * and no expected cause applies (model switch, compaction, revert, an
 * elapsed cache TTL) — the prefix upstream of the cached span must have
 * changed: something rewrote or reordered the conversation head that
 * caching depends on. The section title and a detail row turn red, and a
 * toast fires for breaks observed live in the viewed session:
 *
 *   Cache                                    (red)
 *     hit 78% · last 2%
 *     1.2M cached · 340k written · 96k fresh
 *     prefix broke: lost 126k cached         (red)
 *
 * The red state persists while requests keep missing (each one re-paying the
 * context) and clears when a request reuses the cache normally again — or
 * when an expected-loss cause resets detection. Only the transition into the
 * broken state toasts; a persisting break stays a sidebar-only signal.
 *
 * The TTL gate measures a cache entry's age start-to-start: requests write
 * the cache as their prompt is ingested and the next request reads it at its
 * own start, while step-FINISH times land only after a step's tool calls —
 * permission-prompt waits included — settle. So live step-start parts are
 * stamped as they arrive, and a full re-pay whose start-to-start age exceeds
 * the TTL is classified as expiry, not a break: no red, no toast, just a
 * muted sidebar line that fades after a few seconds (the same linger as
 * approve-for-me's settled entries):
 *
 *     cache expired: re-paid 126k cached     (muted, transient)
 *
 * Install by loading this file from a `tui.json` `plugin` array, or run
 * `opencode plugin <path-to-this-package>`. This plugin is TUI-only and
 * reads only session state the host already syncs, so it works on local and
 * remote attaches alike.
 *
 * Options (second element of a `["file://…", {…}]` plugin entry). An
 * out-of-range or wrong-typed value is ignored with one startup warning toast
 * and the documented default is used — never silently accepted (audit L-UM3):
 *   - minPreviousRead: number ≥ 0 — only alert when the previous request read
 *     at least this many cached tokens (default 5000). 0 means "no size gate".
 *   - floorFraction: number > 0 and ≤ 1 — alert when the current read falls
 *     below this fraction of the previous read (default 0.5). Larger is more
 *     sensitive: 1 alerts on any drop at all. 0 is refused: it would switch
 *     break AND expiry detection off, since the fraction test short-circuits
 *     ahead of both.
 *   - ttlSeconds: number > 0 — suppress alerts across gaps longer than this,
 *     when both request times are known: the provider cache plausibly expired
 *     (default 300, Anthropic's default TTL).
 *   - toasts: boolean — set false to keep the sidebar alert but silence the
 *     toast (default true).
 *   - expiryLingerSeconds: number > 0 — how long the transient expiry line
 *     stays before fading (default 5, approve-for-me's settled-prompt linger).
 *
 * Targets OpenCode v1 (verified against 1.17.14–1.18.x), like the rest of
 * this repo: warns outside that band, disables only on OpenCode v2+.
 */

type ResolvedOptions = BreakOptions & { toasts: boolean; lingerMs: number }

// How long the expiry notice stays in the sidebar before fading — the same
// linger approve-for-me gives settled permission entries, so the two plugins'
// transient lines feel like one behavior.
const DEFAULT_EXPIRY_LINGER_MS = 5_000

// Includes full-history body consumption, even on a stalled remote attach.
export const HISTORY_TIMEOUT_MS = 30_000

/**
 * How many sessions the engine tracks at once, evicted by recency (audit
 * L-UM1). A Tracking is O(the session's API requests), not O(1) — this map is
 * the plugin's real footprint, so the shared `trim()` default of 500 is the
 * wrong order of magnitude. 64 is far beyond the handful a person moves
 * between, while still bounding a long-lived attach to a server running many
 * sessions.
 */
export const MAX_TRACKED_SESSIONS = 64

export function resolveOptions(options: Record<string, unknown> | undefined): {
  options: ResolvedOptions
  problems: string[]
} {
  const problems: string[] = []
  // A present-but-unusable value is REJECTED, never clamped and never silently
  // defaulted: the plugin cannot know whether the user meant the endpoint or
  // mistyped the number, and running under a threshold nobody chose is exactly
  // how `floorFraction: 0` turned detection off unnoticed (audit L-UM3). That
  // argument is now the suite's house rule; rejectNumber is the shared
  // implementation of it, and this plugin is where it came from.
  const number = (
    key: string,
    range: string,
    accepts: (value: number) => boolean,
  ): number | undefined =>
    rejectNumber({ key, value: options?.[key], range, accepts, problems })
  // 0 is meaningful and safe here — "no size gate, judge every pair": the gate
  // is `floor < minPreviousRead`, which 0 never trips, and a zero floor still
  // passes the fraction test as ok.
  const minPreviousRead = number(
    "minPreviousRead",
    "of at least 0",
    (value) => value >= 0,
  )
  // 0 makes `read >= floor * 0` true for every request — no break, and no
  // expiry either, since that branch sits behind this one in judgeAgainstFloor.
  // Above 1 holds a request to MORE than the previous read, so ordinary healthy
  // reuse reports a break every time. 1 itself is the sharpest useful setting:
  // any drop at all alerts.
  const floorFraction = number(
    "floorFraction",
    "greater than 0 and at most 1",
    (value) => value > 0 && value <= 1,
  )
  // 0 would classify every timed miss as an expired entry — break alerts
  // silently off. No provider has a zero-length cache.
  const ttlSeconds = number(
    "ttlSeconds",
    "greater than 0",
    (value) => value > 0,
  )
  // 0 would clear the notice on the next macrotask: set, unset, never seen.
  const lingerSeconds = number(
    "expiryLingerSeconds",
    "greater than 0",
    (value) => value > 0,
  )
  // Held to the same rule as the numbers rather than read as `!== false`, which
  // quietly resolves the near-miss that actually gets written — `toasts:
  // "false"`, a JSON string — to the default TRUE, leaving toasts on with no
  // warning and no clue why.
  const toasts = ((): boolean | undefined => {
    const value = options?.toasts
    if (value === undefined) return undefined
    if (typeof value === "boolean") return value
    problems.push(
      `toasts must be a boolean (ignoring ${JSON.stringify(value) ?? String(value)})`,
    )
    return undefined
  })()
  return {
    options: {
      minPreviousRead: minPreviousRead ?? DEFAULT_BREAK_OPTIONS.minPreviousRead,
      floorFraction: floorFraction ?? DEFAULT_BREAK_OPTIONS.floorFraction,
      ttlMs:
        ttlSeconds !== undefined
          ? ttlSeconds * 1000
          : DEFAULT_BREAK_OPTIONS.ttlMs,
      toasts: toasts ?? true,
      lingerMs:
        lingerSeconds !== undefined
          ? lingerSeconds * 1000
          : DEFAULT_EXPIRY_LINGER_MS,
    },
    problems,
  }
}

export const tui: TuiPlugin = async (api, options) => {
  // No remote bail, deliberately (2026-07-23 audit §2.9): this half reads
  // nothing but the message and part stores the host has already synced to
  // this machine, so a remote attach shows exactly the right numbers for the
  // session on screen. Its siblings bail because they reach the server's own
  // filesystem or auth store; there is nothing here to reach.
  const gate = tuiGate(api, {
    label: "Cache ratio",
    service: "cache-ratio",
    remoteBails: false,
  })
  if (gate.disabled) return

  const { options: opts, problems } = resolveOptions(options)
  // ONE toast for all problems: a mistyped tuple trips several ranges at once,
  // and four stacked startup toasts — on top of a possible compat warning —
  // would bury the message rather than deliver it. Deliberately not gated on
  // `toasts: false`, which silences the break alert; a configuration error must
  // not be silenceable by an unrelated switch (the same reason the compat guard
  // warns unconditionally).
  if (problems.length)
    warnTui(
      api,
      "cache-ratio",
      `Cache ratio ignored invalid options — ${problems.join("; ")}. Using defaults.`,
    )

  const toast = tuiToast(api, { title: "Prompt cache" })

  // Everything the engine tracks, keyed by session id so unrelated sessions
  // neither grow one shared map for the TUI's lifetime nor invalidate the
  // viewed session's memos. An entry is dropped when its session is deleted,
  // or when the recency cap evicts an idle background one (audit L-UM1).
  //   - samples: every API request observed for the session, keyed by
  //     step-finish part id. The host TUI syncs only the newest 100 messages,
  //     so this is the plugin's own durable record: seeded once from the
  //     server's full history, then kept current from live events even while
  //     unviewed, and refreshed from the synced store.
  //   - live: wall-clock bus arrival of step-finish parts observed live.
  //     Forks re-emit part events for copied history; those are classified
  //     historical (their message is already completed) and never land here.
  //   - starts: bus arrival of step-start parts, per message in part-id
  //     order. A step's start is when its request went out — the moment the
  //     provider writes (and the next request reads) the cache — so the TTL
  //     gate pairs each step-finish with the nearest earlier start. Stamped
  //     from events like `live`, so fork-replayed history never lands here.
  //   - toasted: makes each part's alert one-shot — toast or expiry notice
  //     alike (part updates can deliver the same part more than once).
  //   - expiry: the transient "cache expired: re-paid …" sidebar notice; set
  //     when a live request's verdict is an expiry, cleared by a short timer
  //     (mirroring approve-for-me's settled-entry fade).
  //   - timers: that notice's pending fade timers, owned by the session so
  //     deletion, eviction, and dispose can all cancel them — an orphaned
  //     timer would otherwise keep the dropped session's tracking alive until
  //     it fired.
  //   - version: notifies the sidebar's memos of engine-side changes — and
  //     doubles as the reactivity fallback in case a host syncs part stores
  //     more coarsely than it emits events. Per session, so background
  //     activity does not recompute the viewed session's aggregate.
  type StartStamp = { partID: string; time: number }
  type ExpiryNotice = { partID: string; lostTokens: number }
  type Tracking = {
    samples: Map<string, StepSample>
    live: Map<string, number>
    starts: Map<string, StartStamp[]>
    toasted: Set<string>
    expiry: Signal<ExpiryNotice | undefined>
    timers: Set<ReturnType<typeof setTimeout>>
    history: "idle" | "pending" | "done" | "failed"
    historyAbort?: AbortController
    version: Signal<number>
  }
  const sessions = new Map<string, Tracking>()
  const tracking = (sessionID: string): Tracking => {
    const existing = sessions.get(sessionID)
    if (existing) {
      // Re-insert so the cap evicts by recency, not by first sight: a session
      // stays tracked while it is active OR while its sidebar renders (the
      // View's memos call through here). Same idiom as memory's snapshots.
      // Mutating the map here is safe ONLY because this writes no signal — it
      // runs inside View memos, and a signal write would self-invalidate them.
      sessions.delete(sessionID)
      sessions.set(sessionID, existing)
      return existing
    }
    const entry: Tracking = {
      samples: new Map(),
      live: new Map(),
      starts: new Map(),
      toasted: new Set(),
      expiry: createSignal<ExpiryNotice | undefined>(undefined),
      timers: new Set(),
      history: "idle",
      version: createSignal(0),
    }
    sessions.set(sessionID, entry)
    return entry
  }
  const bump = (entry: Tracking) => entry.version[1]((version) => version + 1)

  const toSample = (
    part: StepFinishPart,
    message: AssistantMessage,
    steps: readonly StepFinishPart[],
    live: Map<string, number>,
    starts: readonly StartStamp[],
  ): StepSample => {
    // A final step's time is recoverable from history (the message completes
    // with it); earlier steps have no recorded time, which just disables the
    // TTL gate for their pairs. The completion time also wins over the bus
    // arrival time: forks re-deliver copied parts with fork-time events, and
    // for a genuinely live final step the two are moments apart anyway.
    const historical =
      steps.at(-1)?.id === part.id ? message.time.completed : undefined
    // The step's own start: part ids ascend within a message, so it is the
    // latest stamped step-start that precedes this finish. Only live-observed
    // starts exist (history has none), so `startedAt` degrades to undefined
    // exactly where the TTL gate's finish-time fallback takes over.
    let startedAt: number | undefined
    for (const start of starts) {
      if (start.partID < part.id) startedAt = start.time
    }
    return {
      partID: part.id,
      messageID: message.id,
      providerID: message.providerID,
      modelID: message.modelID,
      summary: message.summary === true,
      tokens: {
        input: part.tokens.input,
        output: part.tokens.output,
        reasoning: part.tokens.reasoning,
        cacheRead: part.tokens.cache.read,
        cacheWrite: part.tokens.cache.write,
      },
      observedAt: historical ?? live.get(part.id),
      startedAt,
    }
  }

  const record = (entry: Tracking, sample: StepSample, overwrite: boolean) => {
    // A step that carried no prompt at all (aborted before the request went
    // out) would only distort ratios and pair-wise judgement.
    if (promptTokens(sample.tokens).total === 0) return
    if (!overwrite && entry.samples.has(sample.partID)) return
    entry.samples.set(sample.partID, sample)
  }

  // One-shot full-history seed. The synced store starts at the newest 100
  // messages, so everything older is only reachable through the server API.
  // Parts already recorded from the store are kept (they carry the freshest
  // knowledge); on failure the section degrades to the host's synced window.
  const seedHistory = (sessionID: string, entry: Tracking) => {
    entry.history = "pending"
    const controller = new AbortController()
    entry.historyAbort = controller
    const current = () =>
      !api.lifecycle.signal.aborted && sessions.get(sessionID) === entry
    ;(async () => {
      // The shared host client outlives this plugin. Bound the entire SDK call
      // (including JSON decoding), not just the wait for response headers.
      const response = await withTimeout(
        (signal) => api.client.session.messages({ sessionID }, { signal }),
        HISTORY_TIMEOUT_MS,
        {
          signal: AbortSignal.any([api.lifecycle.signal, controller.signal]),
        },
      )
      // Cancellation can race a settled request, and an id can be tracked
      // again after deletion/eviction. Only this entry may commit its result.
      if (!current()) return
      if (!response.data)
        throw new Error(JSON.stringify(response.error ?? "no data"))
      for (const item of response.data) {
        if (item.info.role !== "assistant") continue
        const steps = item.parts.filter(
          (part): part is StepFinishPart => part.type === "step-finish",
        )
        for (const step of steps)
          record(
            entry,
            toSample(
              step,
              item.info,
              steps,
              entry.live,
              entry.starts.get(item.info.id) ?? [],
            ),
            false,
          )
      }
      entry.history = "done"
      bump(entry)
    })()
      .catch(() => {
        if (current()) entry.history = "failed"
      })
      .finally(() => {
        entry.historyAbort = undefined
      })
  }

  // The session's API requests in conversation order: the durable per-session
  // record, refreshed from the synced store on every read. Reactive when
  // called under a tracking scope (messages, parts, and the session's version
  // signal are all tracked); a plain ordered read from the event handler.
  const samplesFor = (sessionID: string): StepSample[] => {
    if (api.lifecycle.signal.aborted) return []
    const entry = tracking(sessionID)
    entry.version[0]()
    if (entry.history === "idle" && !isSubAgentSession(api, sessionID))
      seedHistory(sessionID, entry)
    for (const message of api.state.session.messages(sessionID)) {
      if (message.role !== "assistant") continue
      const steps = api.state
        .part(message.id)
        .filter((item): item is StepFinishPart => item.type === "step-finish")
      for (const part of steps)
        record(
          entry,
          toSample(
            part,
            message,
            steps,
            entry.live,
            entry.starts.get(message.id) ?? [],
          ),
          true,
        )
    }
    // Browsing sessions on a quiet server reaches the engine only through
    // here, so the cap has to be applied on this path too — a bus-only trim
    // would leave that growth unbounded.
    trimSessions(sessionID)
    // Message and part ids are the host's ascending identifiers, so a
    // lexicographic sort restores conversation order across the merged
    // history/store/live sources.
    return [...entry.samples.values()].sort((a, b) =>
      a.messageID === b.messageID
        ? a.partID < b.partID
          ? -1
          : 1
        : a.messageID < b.messageID
          ? -1
          : 1,
    )
  }

  const viewedSessionID = (): string | undefined => routeSessionID(api)

  const clearExpiryTimers = (entry: Tracking) => {
    for (const timer of entry.timers) clearTimeout(timer)
    entry.timers.clear()
  }

  // Stop tracking one session. Deliberately reads with `sessions.get`, never
  // `tracking()`, so dropping an id the plugin never saw does not resurrect
  // it. Cancel both the history read and expiry timers that retain the entry.
  const drop = (sessionID: string) => {
    const entry = sessions.get(sessionID)
    if (!entry) return
    sessions.delete(sessionID)
    entry.historyAbort?.abort()
    clearExpiryTimers(entry)
  }

  // Hold the map to MAX_TRACKED_SESSIONS, oldest-touched first. Writes no
  // signals, so this is safe from the bus handler AND from inside a View memo
  // — which is what lets `samplesFor` call it, closing the growth path that
  // browsing many sessions on a quiet server would otherwise open.
  const trimSessions = (keep?: string) => {
    if (sessions.size <= MAX_TRACKED_SESSIONS) return
    const viewed = viewedSessionID()
    // Iterate a key snapshot with `continue` rather than looping on
    // `sessions.size`: if every remaining entry were protected, a
    // shrink-until-under-cap loop would spin forever.
    for (const sessionID of [...sessions.keys()]) {
      if (sessions.size <= MAX_TRACKED_SESSIONS) break
      // Never evict what the user is looking at — it is the only session that
      // toasts and the only one whose sidebar renders — nor the caller's own
      // session, which makes self-eviction impossible by construction rather
      // than by argument about touch order.
      //
      // The viewed-session exemption is also what keeps eviction invisible to
      // the sidebar: OpenCode 1.18.3 wraps the session screen in
      // `<Show when={sessionID} keyed>` (app.tsx), so this plugin's View is
      // torn down and rebuilt on every session switch and only ever exists for
      // the routed session. If a future host drops that `keyed`, a mounted
      // View could outlive its entry and its memos would silently stop
      // updating — revisit this exemption then.
      if (sessionID === viewed || sessionID === keep) continue
      drop(sessionID)
    }
  }

  // Alerts fire from the bus, not from rendering, so they land even while
  // the sidebar is collapsed — but only for the session the user is looking
  // at, which is also the one whose sidebar renders them. The event may race
  // the host's part-store sync, so the current sample is built from the
  // event's own part and only the PRIOR samples are read from state. A break
  // toasts, and only on the TRANSITION into the broken state: while a break
  // persists, every further request judges as broken too, and the sidebar
  // already carries that standing alert. An expiry — a real re-pay that the
  // lapsed TTL fully explains — never toasts and never turns anything red;
  // it raises the transient sidebar notice instead, so the cost is visible
  // without the alarm.
  const maybeAlert = (sessionID: string, current: StepSample) => {
    const entry = tracking(sessionID)
    if (entry.toasted.has(current.partID)) return
    if (sessionID !== viewedSessionID()) return
    if (promptTokens(current.tokens).total === 0) return
    const prior = samplesFor(sessionID).filter(
      (sample) => sample.partID !== current.partID,
    )
    const verdict = detectBreakSeries([...prior, current], opts)
    if (verdict?.kind === "expired") {
      entry.toasted.add(current.partID)
      const notice: ExpiryNotice = {
        partID: current.partID,
        lostTokens: verdict.lostTokens,
      }
      entry.expiry[1](notice)
      const timer = setTimeout(() => {
        entry.timers.delete(timer)
        // Only this notice's own timer may clear it — a newer expiry that
        // replaced the notice brings its own timer.
        entry.expiry[1]((shown) => (shown === notice ? undefined : shown))
      }, opts.lingerMs)
      entry.timers.add(timer)
      return
    }
    if (verdict?.kind !== "break") return
    if (detectBreakSeries(prior, opts)?.kind === "break") return
    entry.toasted.add(current.partID)
    if (!opts.toasts) return
    toast(
      "error",
      `Request reused only ${formatTokens(verdict.read)} of ${formatTokens(verdict.previousRead)} cached tokens — the prompt-cache prefix looks broken.`,
    )
  }

  api.lifecycle.onDispose(
    api.event.on("message.part.updated", (event) => {
      if (api.lifecycle.signal.aborted) return
      const part = event.properties.part
      if (part.type !== "step-finish" && part.type !== "step-start") return
      // Sub-agent sessions never surface here: their sidebar section is
      // hidden and their toasts suppressed, so don't track them either.
      if (isSubAgentSession(api, part.sessionID)) return
      const message = api.state.session
        .messages(part.sessionID)
        .find(
          (item): item is AssistantMessage =>
            item.role === "assistant" && item.id === part.messageID,
        )
      // A part whose message is already completed is not a live request:
      // forking clones history by re-emitting every copied part. Stamping
      // those with arrival time would make old requests look recent,
      // defeating the TTL gate and toasting on long-settled breaks.
      if (message?.time.completed) return
      const entry = tracking(part.sessionID)
      // Before `bump()` below flushes the viewed session's memos, so eviction
      // never runs inside a computation. Naming this session keeps it safe
      // from its own trim.
      trimSessions(part.sessionID)
      if (part.type === "step-start") {
        // The request behind this step is going out right now — this stamp is
        // when its prompt hits the provider, i.e. when the cache is read and
        // rewritten. No bump: nothing renders until its step-finish arrives,
        // and that event bumps.
        const stamps = entry.starts.get(part.messageID) ?? []
        if (!stamps.some((stamp) => stamp.partID === part.id)) {
          const time = event.properties.time
          stamps.push({
            partID: part.id,
            time: typeof time === "number" ? time : Date.now(),
          })
          stamps.sort((a, b) => (a.partID < b.partID ? -1 : 1))
          entry.starts.set(part.messageID, stamps)
        }
        return
      }
      if (!entry.live.has(part.id)) {
        const time = event.properties.time
        entry.live.set(part.id, typeof time === "number" ? time : Date.now())
      }
      if (message) {
        const steps = api.state
          .part(message.id)
          .filter((item): item is StepFinishPart => item.type === "step-finish")
        const current = toSample(
          part,
          message,
          steps,
          entry.live,
          entry.starts.get(message.id) ?? [],
        )
        // Retain the event's usage before any view/alert gates: an unmounted
        // sidebar cannot harvest requests before the host evicts their parts.
        record(entry, current, true)
        maybeAlert(part.sessionID, current)
      }
      bump(entry)
    }),
  )

  api.lifecycle.onDispose(() => {
    for (const sessionID of sessions.keys()) drop(sessionID)
  })

  api.lifecycle.onDispose(
    api.event.on("session.deleted", (event) => {
      drop(event.properties.sessionID)
    }),
  )

  function View(props: { api: TuiPluginApi; session_id: string }) {
    const theme = () => props.api.theme.current
    const session = createMemo(() =>
      props.api.state.session.get(props.session_id),
    )
    const samples = createMemo(() => samplesFor(props.session_id))
    const snapshot = createMemo(() => ratioSnapshot(samples()))
    const broke = createMemo(() => {
      const verdict = detectBreakSeries(samples(), opts)
      return verdict?.kind === "break" ? verdict : undefined
    })
    // The transient expiry notice — engine-set on a live expiry verdict,
    // engine-cleared a few seconds later. Never red: the lapsed TTL fully
    // explains the re-pay, so this is cost visibility, not an alert.
    const expired = createMemo(() =>
      api.lifecycle.signal.aborted
        ? undefined
        : tracking(props.session_id).expiry[0](),
    )

    return (
      <Show when={!session()?.parentID && snapshot().steps > 0}>
        <box>
          <text fg={broke() ? theme().error : theme().text}>
            <b>Cache</b>
          </text>
          <text fg={theme().textMuted}>
            {snapshot().session === undefined
              ? ""
              : `hit ${formatPercent(snapshot().session ?? 0)}`}
            {snapshot().last === undefined ? (
              ""
            ) : (
              <span style={{ fg: broke() ? theme().error : theme().textMuted }}>
                {` · last ${formatPercent(snapshot().last ?? 0)}`}
              </span>
            )}
          </text>
          <text fg={theme().textMuted}>
            {`${formatTokens(snapshot().cachedTokens)} cached · ${formatTokens(snapshot().writtenTokens)} written · ${formatTokens(snapshot().freshTokens)} fresh`}
          </text>
          <Show when={broke()}>
            <text
              fg={theme().error}
            >{`prefix broke: lost ${formatTokens(broke()?.lostTokens ?? 0)} cached`}</text>
          </Show>
          <Show when={expired()}>
            <text
              fg={theme().textMuted}
            >{`cache expired: re-paid ${formatTokens(expired()?.lostTokens ?? 0)} cached`}</text>
          </Show>
        </box>
      </Show>
    )
  }

  // Just after the limits and workload widgets: cache efficiency is the same
  // neighborhood, and both sit between the host's Context section (100) and
  // MCP (200).
  //
  // 165, not 160 — background-tasks took 160 first and this half was written
  // to the same "just after 150" reasoning without noticing, so both claimed
  // it and their relative order fell to whatever the host's tie-break does
  // with two equal keys (the suite's slot orders are pinned against exactly
  // this in tests/repo/test/slot-order.test.ts). 165 keeps the documented
  // reading — limits, background-tasks, cache-ratio, websearch — and
  // leaves the round numbers free.
  api.slots.register({
    order: 165,
    slots: {
      sidebar_content: (_ctx, props) => (
        <View api={api} session_id={props.session_id} />
      ),
    },
  })
}

const plugin: TuiPluginModule = {
  id: "opencode-cache-ratio",
  tui,
}

export default plugin

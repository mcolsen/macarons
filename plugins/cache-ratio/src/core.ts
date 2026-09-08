/**
 * opencode-cache-ratio — pure core
 *
 * Everything the sidebar and the break alert need that is not JSX or the TUI
 * plugin API: the per-request sample shape, hit-ratio aggregation, break
 * detection, and number formatting — so `bun test` can exercise all of it
 * directly.
 *
 * A "sample" is one LLM API request: OpenCode records one `step-finish` part
 * per request inside each assistant message, carrying that request's token
 * usage. The host normalizes every provider's accounting to one shape before
 * a plugin ever sees it (session.getUsage subtracts cache reads/writes from
 * the AI SDK's inclusive input count), so across ALL providers:
 *
 *   tokens.input        = non-cached ("fresh") prompt tokens only
 *   tokens.cache.read   = prompt tokens served from cache
 *   tokens.cache.write  = prompt tokens written to cache (0 on providers
 *                         that never report writes, e.g. OpenAI)
 *   full prompt         = input + cache.read + cache.write
 *
 * The engine (src/tui.tsx) turns the viewed session's step-finish parts into
 * an ordered sample list; this module turns that list into a ratio snapshot
 * and a verdict on whether the newest request broke the prompt-cache prefix.
 */

// The verified band is centralized in the shared library and rides the repo's
// OpenCode pin (.opencode-version) — the policy comment lives there. The band
// matters here because the prompt math above relies on the hosts' usage
// normalization staying as verified.
export {
  isSubAgentSession,
  openCodeCompatNotice,
  reportTuiCompat,
  routeSessionID,
  SUPPORTED_OPENCODE_RANGE,
  tuiGate,
  warnTui,
} from "@macarons/permission-rules"

/** Token usage of one API request, as OpenCode records it on a step-finish part. */
export type StepTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

/** One LLM API request observed in a session, in conversation order. */
export type StepSample = {
  /** The step-finish part id — stable identity for dedupe. */
  partID: string
  messageID: string
  providerID: string
  modelID: string
  /** The containing assistant message is a compaction summary turn. */
  summary: boolean
  tokens: StepTokens
  /**
   * Wall-clock time of the request, when one is known: the bus event time for
   * samples observed live, the message's completion time for the final step
   * of a historical message. Absent for non-final historical steps (parts
   * carry no timestamps), which simply disables the TTL gate for that pair.
   */
  observedAt?: number
  /**
   * Wall-clock START of the request: the bus arrival of its step-start part,
   * for live-observed steps. This is the clock the TTL gate prefers — a cache
   * entry is written while a request's prompt is ingested (its start) and
   * read at the NEXT request's start, whereas a step-finish part is recorded
   * only after the step's tool calls settle, permission-prompt waits
   * included. Those waits age the cache but are invisible to finish-to-finish
   * gaps. Absent for history (starts are not recoverable), which falls back
   * to the finish-time gap.
   */
  startedAt?: number
}

/** A request's prompt, normalized: how much came from cache, and its total size. */
export function promptTokens(tokens: StepTokens): {
  cached: number
  total: number
} {
  return {
    cached: tokens.cacheRead,
    total: tokens.input + tokens.cacheRead + tokens.cacheWrite,
  }
}

export type RatioSnapshot = {
  /** Cached ÷ total prompt tokens across all samples; undefined with no prompt tokens. */
  session?: number
  /** Cached ÷ total prompt tokens of the newest sample; undefined with no samples. */
  last?: number
  /** Number of samples (API requests) aggregated. */
  steps: number
  /** Session-wide sums the ratios derive from. */
  cachedTokens: number
  writtenTokens: number
  freshTokens: number
  totalPromptTokens: number
}

export function ratioSnapshot(samples: readonly StepSample[]): RatioSnapshot {
  let cachedTokens = 0
  let writtenTokens = 0
  let freshTokens = 0
  for (const sample of samples) {
    cachedTokens += sample.tokens.cacheRead
    writtenTokens += sample.tokens.cacheWrite
    freshTokens += sample.tokens.input
  }
  const totalPromptTokens = cachedTokens + writtenTokens + freshTokens
  const newest = samples.at(-1)
  const lastPrompt = newest ? promptTokens(newest.tokens) : undefined
  return {
    session:
      totalPromptTokens > 0 ? cachedTokens / totalPromptTokens : undefined,
    last:
      lastPrompt && lastPrompt.total > 0
        ? lastPrompt.cached / lastPrompt.total
        : undefined,
    steps: samples.length,
    cachedTokens,
    writtenTokens,
    freshTokens,
    totalPromptTokens,
  }
}

export type BreakOptions = {
  /**
   * Ignore breaks when the previous request read fewer cached tokens than
   * this — losing a tiny cache is noise, not an alert.
   */
  minPreviousRead: number
  /**
   * The fraction of the previous request's cache read below which the current
   * read counts as a break. Prefix breaks lose (nearly) everything, so the
   * default is generous enough not to flag ordinary drift or partial reuse.
   */
  floorFraction: number
  /**
   * The provider's cache TTL. A miss whose start-to-start age exceeds this is
   * classified "expired", not "break": the entry's lifetime had lapsed, so
   * expiry fully explains the re-pay and a break claim would be
   * unsupportable. The default is Anthropic's 5 minutes — a guaranteed
   * MINIMUM lifetime there, refreshed on each read, which also makes the
   * converse sharp on Anthropic-family providers: an in-window miss means
   * the prefix really changed. Best-effort caches (OpenAI evicts under load)
   * keep the README's softer reading of in-window misses.
   */
  ttlMs: number
}

export const DEFAULT_BREAK_OPTIONS: BreakOptions = {
  minPreviousRead: 5_000,
  floorFraction: 0.5,
  ttlMs: 300_000,
}

/** Why a pair of consecutive samples was not judged at all. */
export type BreakSkipReason =
  | "first-request"
  | "model-changed"
  | "compaction"
  | "prompt-shrank"

export type BreakVerdict =
  | { kind: "ok" }
  | { kind: "skipped"; reason: BreakSkipReason }
  | {
      /**
       * A real full re-pay whose age makes TTL expiry the sufficient
       * explanation — a cost event, not an alert. Carries the same numbers
       * as a break so the UI can say what the expiry re-paid.
       */
      kind: "expired"
      /** Cached tokens of the floor that had to be re-paid after the TTL lapsed. */
      lostTokens: number
      /** The floor itself: the last healthy request's cache read. */
      previousRead: number
      read: number
    }
  | {
      kind: "break"
      /** Cached tokens of the reusable floor that this request failed to re-read. */
      lostTokens: number
      /** The floor itself: the last healthy request's cache read. */
      previousRead: number
      read: number
    }

/**
 * Judge whether `current` broke the prompt-cache prefix, given the request
 * that preceded it in the same session and the reusable floor to hold it to.
 *
 * The floor is a recent request's cache read: whatever was read then was
 * cached and, with an intact prefix and live TTL, must be readable now —
 * conversation prompts only grow. A current read far below that floor means
 * the prefix changed upstream of the cached span. Compaction summaries,
 * model/provider switches, and shrunken prompts (revert/undo) are expected
 * cache losses and are skipped; a real re-pay older than the TTL is
 * classified "expired" — a quantified cost event, still not an alert.
 */
function judgeAgainstFloor(
  previous: StepSample | undefined,
  current: StepSample,
  floor: number,
  options: BreakOptions,
): BreakVerdict {
  if (!previous) return { kind: "skipped", reason: "first-request" }
  if (
    previous.providerID !== current.providerID ||
    previous.modelID !== current.modelID
  )
    return { kind: "skipped", reason: "model-changed" }
  if (previous.summary || current.summary)
    return { kind: "skipped", reason: "compaction" }

  if (floor < options.minPreviousRead) return { kind: "ok" }

  const read = current.tokens.cacheRead
  if (read >= floor * options.floorFraction) return { kind: "ok" }

  // A prompt smaller than what was previously read from cache means messages
  // were removed (revert, fork) — an expected loss, not a break.
  if (promptTokens(current.tokens).total < floor)
    return { kind: "skipped", reason: "prompt-shrank" }

  // The age of the entry this request tried to read: the previous request
  // wrote it at ITS start, this request read at its own start, and nothing in
  // this session refreshed it in between — so start-to-start is the honest
  // window. Finish-to-finish is the degraded fallback (historical samples,
  // lost start events); it excludes in-step waits (a permission prompt held
  // for minutes ages the cache invisibly) and inflates for slow responses, so
  // it both misses expiries and can mask real breaks — accepted for pairs
  // that carry no better clock, exactly the pre-start-tracking behavior.
  const age =
    previous.startedAt !== undefined && current.startedAt !== undefined
      ? current.startedAt - previous.startedAt
      : previous.observedAt !== undefined && current.observedAt !== undefined
        ? current.observedAt - previous.observedAt
        : undefined
  if (age !== undefined && age > options.ttlMs)
    return {
      kind: "expired",
      lostTokens: floor - read,
      previousRead: floor,
      read,
    }

  return { kind: "break", lostTokens: floor - read, previousRead: floor, read }
}

/** Judge one consecutive pair, holding `current` to the previous request's own cache read. */
export function detectBreak(
  previous: StepSample | undefined,
  current: StepSample,
  options: BreakOptions = DEFAULT_BREAK_OPTIONS,
): BreakVerdict {
  return judgeAgainstFloor(
    previous,
    current,
    previous?.tokens.cacheRead ?? 0,
    options,
  )
}

/**
 * Judge a whole session's requests in order and return the newest one's
 * verdict (undefined with no samples).
 *
 * Pairwise judgement alone would clear an alert after a single request: once
 * a request misses, its own tiny read becomes the next pair's floor, so a
 * SUSTAINED cache failure reports "ok" from the second miss on. The fold
 * instead carries the last healthy read as a sticky floor across consecutive
 * breaks — the state stays "break" until a request genuinely reuses the cache
 * again (read back above the floor fraction) or an expected-loss reset
 * (model switch, compaction, revert, TTL expiry) makes the comparison moot.
 * While broken, `previousRead`/`lostTokens` keep referring to that last
 * healthy floor.
 */
export function detectBreakSeries(
  samples: readonly StepSample[],
  options: BreakOptions = DEFAULT_BREAK_OPTIONS,
): BreakVerdict | undefined {
  let verdict: BreakVerdict | undefined
  let stickyFloor: number | undefined
  let previous: StepSample | undefined
  for (const current of samples) {
    verdict = judgeAgainstFloor(
      previous,
      current,
      stickyFloor ?? previous?.tokens.cacheRead ?? 0,
      options,
    )
    stickyFloor = verdict.kind === "break" ? verdict.previousRead : undefined
    previous = current
  }
  return verdict
}

/** "873", "12.4k", "1.3M" — compact enough for a sidebar row. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0"
  if (count < 1_000) return String(Math.round(count))
  // The k band ends where its display would round to "1000k".
  const scaled = count < 999_500 ? count / 1_000 : count / 1_000_000
  const suffix = count < 999_500 ? "k" : "M"
  const digits =
    scaled >= 100
      ? String(Math.round(scaled))
      : scaled.toFixed(1).replace(/\.0$/, "")
  return `${digits}${suffix}`
}

/** Whole-number percent for a 0–1 ratio, never rounding a partial hit up to 100% or a nonzero one down to 0%. */
export function formatPercent(ratio: number): string {
  const percent = Math.min(100, Math.max(0, ratio * 100))
  const rounded = Math.round(percent)
  if (rounded === 100 && percent < 100) return "99%"
  if (rounded === 0 && percent > 0) return "1%"
  return `${rounded}%`
}

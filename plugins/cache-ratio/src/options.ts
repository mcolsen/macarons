import { rejectNumber } from "@macarons/permission-rules"
import { type BreakOptions, DEFAULT_BREAK_OPTIONS } from "./core"

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

import {
  oauthAccountId,
  oauthRecordOf,
  singleFlight,
  withTimeout,
} from "@macarons/permission-rules"
import {
  type Fetcher,
  type LimitsSnapshot,
  type LimitWindow,
  type ProviderContext,
  type ProviderInstance,
  type UsageProviderModule,
  windowLabel,
} from "@macarons/usage-limits"

/**
 * Codex provider module — the ChatGPT-subscription 5-hour and weekly windows
 * for the `openai` provider, fetched from the same backend the Codex CLI's
 * /status asks (GET chatgpt.com/backend-api/wham/usage) with the OAuth access
 * token OpenCode already holds.
 *
 * The OAuth handling follows OpenCode's auth.json shape and account-id JWT
 * claims, but remains deliberately read-only:
 *
 *   - Expired credentials are left for OpenCode's bundled Codex integration to
 *     refresh. This plugin never spends refresh tokens or writes auth state.
 *   - Store changes are adopted on the next tick and stale in-flight responses
 *     are discarded rather than restoring another account's usage.
 *   - Only a 401 marks the token as bad; a 403 is a plain failure, and a 401
 *     latches fetching off until the stored credentials change.
 */

export const OPENAI_PROVIDER_ID = "openai"

export const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

// After repeated failures the last snapshot is more likely wrong than stale;
// hide it rather than keep reporting numbers nobody is updating.
const HIDE_AFTER_FAILURES = 3

export type CodexOauth = {
  access: string
  refresh?: string
  /** Unix milliseconds, like the `expires` field OpenCode stores. */
  expires: number
  accountId?: string
}

// The `openai` entry of an auth.json-shaped object, but only when it is a
// ChatGPT/Codex OAuth record complete enough to read usage. API keys
// (`type: "api"`), well-known tokens, and malformed entries all yield undefined
// too — the widget must treat every one of those as "not signed in with
// ChatGPT". The lenient parse underneath is shared; this narrowing is what
// makes it a usable Codex record.
export function codexOauthFrom(content: unknown): CodexOauth | undefined {
  const record = oauthRecordOf(content, OPENAI_PROVIDER_ID)
  if (!record?.access || record.expires === undefined) return
  return {
    access: record.access,
    ...(record.refresh ? { refresh: record.refresh } : {}),
    expires: record.expires,
    accountId: record.accountId,
  }
}

export function sameCodexOauth(
  a: CodexOauth | undefined,
  b: CodexOauth | undefined,
): boolean {
  return (
    a?.access === b?.access &&
    a?.refresh === b?.refresh &&
    a?.expires === b?.expires &&
    a?.accountId === b?.accountId
  )
}

// Whether two auth records provably belong to the same ChatGPT account.
// Records whose account cannot be derived compare as different accounts —
// usage numbers must be dropped rather than carried across an unproven
// identity change.
export function sameAccount(
  a: CodexOauth | undefined,
  b: CodexOauth | undefined,
): boolean {
  const idA = a ? oauthAccountId(a) : undefined
  const idB = b ? oauthAccountId(b) : undefined
  return idA !== undefined && idB !== undefined && idA === idB
}

export function isExpired(oauth: CodexOauth, now: number): boolean {
  return oauth.expires < now
}

function limitWindow(
  key: "primary" | "secondary",
  value: unknown,
  now: number,
): LimitWindow | undefined {
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  const used = record.used_percent
  if (typeof used !== "number" || !Number.isFinite(used)) return
  const seconds =
    typeof record.limit_window_seconds === "number" &&
    Number.isFinite(record.limit_window_seconds)
      ? record.limit_window_seconds
      : undefined
  const resetAt = record.reset_at
  const resetAfter = record.reset_after_seconds
  const resetsAt =
    typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt > 0
      ? resetAt * 1000
      : typeof resetAfter === "number" &&
          Number.isFinite(resetAfter) &&
          resetAfter > 0
        ? now + resetAfter * 1000
        : undefined
  return {
    key,
    label: windowLabel(seconds),
    usedPercent: Math.min(100, Math.max(0, Math.round(used))),
    resetsAt,
  }
}

// Normalizes a chatgpt.com/backend-api/wham/usage response body. Returns
// undefined when the body carries no readable windows at all — the widget
// hides rather than rendering an empty section.
export function parseUsage(
  body: unknown,
  now: number,
): LimitsSnapshot | undefined {
  if (!body || typeof body !== "object") return
  const record = body as Record<string, unknown>
  const rateLimit = record.rate_limit
  if (!rateLimit || typeof rateLimit !== "object") return
  const details = rateLimit as Record<string, unknown>
  const windows = [
    limitWindow("primary", details.primary_window, now),
    limitWindow("secondary", details.secondary_window, now),
  ].filter((window): window is LimitWindow => window !== undefined)
  if (!windows.length) return
  const planType = record.plan_type
  return {
    windows,
    planType: typeof planType === "string" ? planType : undefined,
  }
}

/**
 * Deadline for one usage read. Composed with the caller's own abort rather
 * than standing alone so plugin teardown cannot leave a request running.
 */
const REQUEST_TIMEOUT_MS = 10_000

export type UsageResult =
  | { kind: "success"; limits: LimitsSnapshot }
  | { kind: "unauthorized" }
  | { kind: "failed" }

// One usage fetch with the same identification the host sends the Codex
// backend: bearer access token, ChatGPT account id, opencode originator.
export async function fetchUsage(input: {
  oauth: CodexOauth
  fetcher: Fetcher
  now: number
  url: string
  userAgent: string
  /** The caller's abort (plugin dispose); composed with the request deadline. */
  signal?: AbortSignal
}): Promise<UsageResult> {
  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${input.oauth.access}`,
      originator: "opencode",
      "user-agent": input.userAgent,
    }
    const accountId = oauthAccountId(input.oauth)
    if (accountId) headers["chatgpt-account-id"] = accountId
    // Body read included: the deadline and the caller's dispose have to cover
    // the whole exchange. A stalled body left `inFlight` latched, and every
    // later refresh skipped, for the life of the process.
    const read = await withTimeout(
      async (signal) => {
        const response = await input.fetcher(input.url, {
          method: "GET",
          headers,
          signal,
        })
        // Only 401 marks the token itself as bad — the same rule as the Codex
        // CLI's own backend client. A 403 is a permission problem a fresh
        // token would not fix, so it must not be reported as refreshable.
        if (response.status === 401) return { kind: "unauthorized" } as const
        if (!response.ok) return { kind: "failed" } as const
        return { kind: "body", body: await response.json() } as const
      },
      REQUEST_TIMEOUT_MS,
      { signal: input.signal },
    )
    if (read.kind !== "body") return read
    const limits = parseUsage(read.body, input.now)
    return limits ? { kind: "success", limits } : { kind: "failed" }
  } catch {
    return { kind: "failed" }
  }
}

function createCodexInstance(ctx: ProviderContext): ProviderInstance & {
  invalidateAuth: () => void
} {
  const endpoint =
    typeof ctx.options.endpoint === "string" && ctx.options.endpoint.trim()
      ? ctx.options.endpoint.trim()
      : DEFAULT_USAGE_URL

  // The OAuth record as last read from OpenCode's auth store, and the last
  // usage snapshot. Both are signals (on the engine's runtime — see
  // ProviderContext.createSignal) so the sidebar section appears and
  // disappears reactively with sign-in state and data availability.
  const [oauth, setOauth] = ctx.createSignal<CodexOauth | undefined>(
    undefined,
    { equals: sameCodexOauth },
  )
  const [limits, setLimits] = ctx.createSignal<LimitsSnapshot | undefined>()

  // Fetch bookkeeping. A rejected record cannot heal until OpenCode updates
  // the stored credentials, so retries are latched off until that happens.
  let lastSuccessAt = 0
  let failures = 0
  let backoffUntil = 0
  let rejected: CodexOauth | undefined
  let credentialGeneration = 0
  let flightGeneration = -1
  let authReadSequence = 0

  const readStoredOauth = async () =>
    codexOauthFrom(await ctx.readAuthStore().catch(() => undefined))

  const invalidateAuth = () => {
    authReadSequence += 1
    credentialGeneration += 1
    setOauth(undefined)
    setLimits(undefined)
    lastSuccessAt = 0
    failures = 0
    backoffUntil = 0
    rejected = undefined
  }

  const syncAuth = async () => {
    const sequence = ++authReadSequence
    const read = await readStoredOauth()
    if (sequence !== authReadSequence) return
    const previous = oauth()
    if (sameCodexOauth(read, previous)) return sequence
    credentialGeneration += 1
    failures = 0
    backoffUntil = 0
    rejected = undefined
    // Unless the change provably stayed within one ChatGPT account, the
    // numbers on screen belong to a different identity and must disappear.
    if (!sameAccount(previous, read)) {
      setLimits(undefined)
      lastSuccessAt = 0
    }
    setOauth(read)
    return sequence
  }

  // One fetch at a time. A forced call or any call after credentials changed
  // queues one catch-up run; routine overlapping polls are dropped.
  const refresh = singleFlight(
    async (force: boolean) => {
      flightGeneration = credentialGeneration
      // Also covers view-triggered refreshes and queued follow-ups, neither
      // of which necessarily passes through the engine's auth-sync tick.
      const before = await syncAuth()
      if (
        before === undefined ||
        before !== authReadSequence ||
        ctx.disposeSignal.aborted
      )
        return
      const generation = credentialGeneration
      flightGeneration = generation
      const current = oauth()
      if (!current) return
      if (rejected && sameCodexOauth(current, rejected)) return
      const now = Date.now()
      if (now < backoffUntil) return
      // Unforced calls come from the timer and from the sidebar's gate effect;
      // the timer already paces itself, so this freshness window only has to
      // absorb bursts. Comparing against the full interval made every other
      // timer tick skip: the previous fetch finishes shortly after the tick
      // that started it, so the next tick measured just under one interval.
      if (!force && lastSuccessAt && now - lastSuccessAt < ctx.intervalMs / 2)
        return
      if (isExpired(current, now)) {
        // OpenCode owns refresh-token rotation. Writing auth here has no atomic
        // compare-and-set and could overwrite a concurrent host refresh.
        fail(false)
        return
      }
      const result = await fetchUsage({
        oauth: current,
        fetcher: ctx.fetcher,
        now: Date.now(),
        url: endpoint,
        userAgent: ctx.userAgent,
        signal: ctx.disposeSignal,
      })
      // Recheck after I/O: a server sign-out/switch during the usage request
      // must not put the old account's numbers back on screen.
      const after = await syncAuth()
      if (
        after === undefined ||
        after !== authReadSequence ||
        ctx.disposeSignal.aborted ||
        generation !== credentialGeneration ||
        !sameCodexOauth(current, oauth())
      )
        return
      if (result.kind === "success") {
        setLimits(result.limits)
        lastSuccessAt = Date.now()
        failures = 0
        backoffUntil = 0
        rejected = undefined
        return
      }
      if (result.kind === "unauthorized") rejected = current
      fail(result.kind === "unauthorized")
    },
    {
      followUp: [true],
      queues: (force) => force || flightGeneration !== credentialGeneration,
    },
  )

  // Transient failures keep the last snapshot on screen; persistent ones (or
  // a token the backend rejects) hide the section until
  // a fetch succeeds again. Back off so a broken backend sees at most one
  // request per few poll intervals.
  const fail = (unauthorized: boolean) => {
    failures += 1
    backoffUntil = Date.now() + Math.min(failures, 10) * ctx.intervalMs
    if (unauthorized || failures >= HIDE_AFTER_FAILURES) setLimits(undefined)
  }

  return {
    available: () => oauth() !== undefined,
    snapshot: limits,
    syncAuth: async () => {
      await syncAuth()
    },
    refresh,
    invalidateAuth,
  }
}

export const codexModule = {
  providerID: OPENAI_PROVIDER_ID,
  title: "Codex Limits",
  create: createCodexInstance,
} satisfies UsageProviderModule

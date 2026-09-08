import { singleFlight, withTimeout } from "@macarons/permission-rules"
import type {
  EffectiveProvider,
  Fetcher,
  LimitsSnapshot,
  LimitWindow,
  ProviderContext,
  ProviderInstance,
  UsageProviderModule,
} from "@macarons/usage-limits"

export const SYNTHETIC_PROVIDER_ID = "synthetic"
export const DEFAULT_QUOTAS_URL = "https://api.synthetic.new/v2/quotas"

const REQUEST_TIMEOUT_MS = 10_000
const HIDE_AFTER_FAILURES = 3

/** Read the API key after OpenCode has resolved config, auth, and environment. */
export function syntheticApiKey(
  provider: EffectiveProvider | undefined,
): string | undefined {
  if (!provider) return
  const key =
    typeof provider.options.apiKey === "string"
      ? provider.options.apiKey
      : provider.key
  return typeof key === "string" && key.length > 0 ? key : undefined
}

export function parseQuotas(
  body: unknown,
  now: number,
): LimitsSnapshot | undefined {
  if (!body || typeof body !== "object") return
  const record = body as Record<string, unknown>

  // Current responses split subscription usage into rolling request and weekly
  // credit limits. Synthetic's API docs still show the older subscription-only
  // response, so retain that as a fallback when no usable rolling window exists.
  const weekly = weeklyWindow(record.weeklyTokenLimit, now)
  const fiveHour =
    rollingFiveHourWindow(record.rollingFiveHourLimit, now) ??
    legacySubscriptionWindow(record.subscription, now)
  const windows = [fiveHour, weekly].filter(
    (window): window is LimitWindow => window !== undefined,
  )
  return windows.length ? { windows } : undefined
}

function quotaRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined
}

function nextQuotaEvent(value: unknown, now: number): number | undefined {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN
  return Number.isFinite(parsed) && parsed > now ? parsed : undefined
}

function legacySubscriptionWindow(
  value: unknown,
  now: number,
): LimitWindow | undefined {
  const record = quotaRecord(value)
  if (!record) return
  const limit = record.limit
  const requests = record.requests
  if (
    typeof limit !== "number" ||
    !Number.isFinite(limit) ||
    limit <= 0 ||
    typeof requests !== "number" ||
    !Number.isFinite(requests) ||
    requests < 0
  )
    return

  return {
    key: "five-hour",
    label: "5h",
    usedPercent: Math.min(
      100,
      Math.max(0, Math.round((requests / limit) * 100)),
    ),
    resetsAt: nextQuotaEvent(record.renewsAt, now),
    resetVerb: "regen 5%",
  }
}

function rollingFiveHourWindow(
  value: unknown,
  now: number,
): LimitWindow | undefined {
  const record = quotaRecord(value)
  if (!record) return
  const remaining = record.remaining
  const max = record.max
  if (
    typeof remaining !== "number" ||
    !Number.isFinite(remaining) ||
    remaining < 0 ||
    typeof max !== "number" ||
    !Number.isFinite(max) ||
    max <= 0
  )
    return
  return {
    key: "five-hour",
    label: "5h",
    usedPercent: Math.min(
      100,
      Math.max(0, Math.round(((max - remaining) / max) * 100)),
    ),
    resetsAt: nextQuotaEvent(record.nextTickAt, now),
    resetVerb: "regen 5%",
  }
}

function weeklyWindow(value: unknown, now: number): LimitWindow | undefined {
  const record = quotaRecord(value)
  if (!record) return
  const percentRemaining = record.percentRemaining
  if (
    typeof percentRemaining !== "number" ||
    !Number.isFinite(percentRemaining)
  )
    return
  const roundedRemaining = Math.min(
    100,
    Math.max(0, Math.round(percentRemaining)),
  )
  return {
    key: "weekly",
    label: "7d",
    usedPercent: 100 - roundedRemaining,
    resetsAt: nextQuotaEvent(record.nextRegenAt, now),
    resetVerb: "regen 2%",
  }
}

export type QuotasResult =
  | { kind: "success"; limits: LimitsSnapshot }
  | { kind: "unauthorized" }
  | { kind: "failed" }

export async function fetchQuotas(input: {
  apiKey: string
  fetcher: Fetcher
  now: number
  url?: string
  userAgent: string
  signal?: AbortSignal
}): Promise<QuotasResult> {
  try {
    const read = await withTimeout(
      async (signal) => {
        const response = await input.fetcher(input.url ?? DEFAULT_QUOTAS_URL, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${input.apiKey}`,
            "user-agent": input.userAgent,
          },
          signal,
        })
        if (response.status === 401) return { kind: "unauthorized" } as const
        if (!response.ok) return { kind: "failed" } as const
        return { kind: "body", body: await response.json() } as const
      },
      REQUEST_TIMEOUT_MS,
      { signal: input.signal },
    )
    if (read.kind !== "body") return read
    const limits = parseQuotas(read.body, input.now)
    return limits ? { kind: "success", limits } : { kind: "failed" }
  } catch {
    return { kind: "failed" }
  }
}

function createSyntheticInstance(ctx: ProviderContext): ProviderInstance {
  const endpoint =
    typeof ctx.options.endpoint === "string" && ctx.options.endpoint.trim()
      ? ctx.options.endpoint.trim()
      : DEFAULT_QUOTAS_URL
  const [apiKey, setApiKey] = ctx.createSignal<string | undefined>()
  const [limits, setLimits] = ctx.createSignal<LimitsSnapshot | undefined>()
  let lastSuccessAt = 0
  let failures = 0
  let backoffUntil = 0
  let rejectedKey: string | undefined
  let credentialGeneration = 0
  let flightGeneration = -1

  const syncAuth = async () => {
    const next = syntheticApiKey(ctx.provider())
    if (next === apiKey()) return
    credentialGeneration += 1
    setApiKey(next)
    setLimits(undefined)
    lastSuccessAt = 0
    failures = 0
    backoffUntil = 0
    rejectedKey = undefined
  }

  const refresh = singleFlight(
    async (force: boolean) => {
      const generation = credentialGeneration
      flightGeneration = generation
      const key = apiKey()
      if (!key || key === rejectedKey) return
      const now = Date.now()
      if (now < backoffUntil) return
      if (!force && lastSuccessAt && now - lastSuccessAt < ctx.intervalMs / 2)
        return
      const result = await fetchQuotas({
        apiKey: key,
        fetcher: ctx.fetcher,
        now,
        url: endpoint,
        userAgent: ctx.userAgent,
        signal: ctx.disposeSignal,
      })
      if (generation !== credentialGeneration || key !== apiKey()) return
      if (result.kind === "success") {
        setLimits(result.limits)
        lastSuccessAt = Date.now()
        failures = 0
        backoffUntil = 0
        rejectedKey = undefined
        return
      }
      failures += 1
      backoffUntil = Date.now() + Math.min(failures, 10) * ctx.intervalMs
      if (result.kind === "unauthorized") {
        rejectedKey = key
        setLimits(undefined)
      } else if (failures >= HIDE_AFTER_FAILURES) {
        setLimits(undefined)
      }
    },
    {
      followUp: [true],
      queues: (force) => force || flightGeneration !== credentialGeneration,
    },
  )

  return {
    available: () => apiKey() !== undefined,
    snapshot: limits,
    syncAuth,
    refresh,
  }
}

export const syntheticModule: UsageProviderModule = {
  providerID: SYNTHETIC_PROVIDER_ID,
  title: "Synthetic Limits",
  create: createSyntheticInstance,
}

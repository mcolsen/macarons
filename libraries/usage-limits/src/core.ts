import type { createSignal } from "solid-js"

/** Provider-neutral quota shapes and provider-module contracts. */

export {
  isSubAgentSession,
  openCodeAuthStorePath,
  openCodeCompatNotice,
  readAuthStore,
  readRefreshedAuthStore,
  reportTuiCompat,
  resolvePathsOnce,
  routeSessionID,
  type ServerLocality,
  SUPPORTED_OPENCODE_RANGE,
  sdkClientBaseUrl,
  serverLocality,
  singleFlight,
  tuiGate,
} from "@macarons/permission-rules"

export type LimitWindow = {
  /** Stable identity of the window within its provider's snapshot. */
  key: string
  label: string
  /** Whole percent, clamped to 0-100. */
  usedPercent: number
  /** Unix milliseconds; absent when the provider sent no quota-event time. */
  resetsAt?: number
  /** Defaults to "resets"; providers may describe a renewal or partial refill. */
  resetVerb?: "regen 2%" | "regen 5%" | "renews" | "resets"
}

export type LimitsSnapshot = {
  windows: LimitWindow[]
  planType?: string
}

const MINUTE = 60
const WINDOW_LABELS: Array<{ seconds: number; label: string }> = [
  { seconds: 5 * 60 * MINUTE, label: "5h" },
  { seconds: 24 * 60 * MINUTE, label: "24h" },
  { seconds: 7 * 24 * 60 * MINUTE, label: "7d" },
  { seconds: 30 * 24 * 60 * MINUTE, label: "30d" },
  { seconds: 365 * 24 * 60 * MINUTE, label: "365d" },
]

export function windowLabel(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0)
    return "Usage"
  for (const { seconds: expected, label } of WINDOW_LABELS) {
    if (Math.abs(seconds - expected) <= expected * 0.05) return label
  }
  if (seconds < 48 * 60 * MINUTE)
    return `${Math.max(1, Math.round(seconds / (60 * MINUTE)))}h`
  return `${Math.max(1, Math.round(seconds / (24 * 60 * MINUTE)))}d`
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

export function formatReset(resetsAt: number, now: number): string {
  const reset = new Date(resetsAt)
  const current = new Date(now)
  const time = `${String(reset.getHours()).padStart(2, "0")}:${String(reset.getMinutes()).padStart(2, "0")}`
  const sameDay =
    reset.getFullYear() === current.getFullYear() &&
    reset.getMonth() === current.getMonth() &&
    reset.getDate() === current.getDate()
  if (sameDay) return time
  return `${reset.getDate()} ${MONTHS[reset.getMonth()]} ${time}`
}

export function activeProviderID(input: {
  nextModelProviderID?: string
  sessionModelProviderID?: string
  lastAssistantProviderID?: string
  configModel?: string
}): string | undefined {
  if (input.nextModelProviderID) return input.nextModelProviderID
  if (input.sessionModelProviderID) return input.sessionModelProviderID
  if (input.lastAssistantProviderID) return input.lastAssistantProviderID
  const model = input.configModel
  if (typeof model === "string" && model.includes("/"))
    return model.split("/")[0] || undefined
  return
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export type EffectiveProvider = {
  key?: string
  options: Record<string, unknown>
}

export type ProviderContext = {
  /** Server-scoped auth only; the TUI engine supplies no local-store fallback. */
  readAuthStore: () => Promise<unknown>
  fetcher: Fetcher
  userAgent: string
  /** This provider's subtree of the limits plugin options. */
  options: Record<string, unknown>
  /** The host's resolved provider state, including its effective API key. */
  provider: () => EffectiveProvider | undefined
  intervalMs: number
  disposeSignal: AbortSignal
  /** Create provider signals on the OpenCode entry module's Solid runtime. */
  createSignal: typeof createSignal
}

export type SessionRetryStatus = {
  message: string
  next: number
  action?: {
    reason: string
    provider: string
    title: string
    message: string
  }
}

export type ProviderInstance = {
  available: () => boolean
  snapshot: () => LimitsSnapshot | undefined
  syncAuth: () => Promise<void>
  refresh: (force: boolean) => Promise<void>
  onRetryStatus?: (status: SessionRetryStatus) => void
  onAssistantError?: (error: unknown, anchorMs: number) => void
}

export type UsageProviderModule = {
  providerID: string
  title: string
  create: (ctx: ProviderContext) => ProviderInstance
}

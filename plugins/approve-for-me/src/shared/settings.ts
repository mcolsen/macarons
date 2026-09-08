import { literalRecord } from "@macarons/permission-rules"

export type SettingsValues = {
  enabled?: boolean
  model?: string
  variant?: string
  timeoutMs?: number
  processing?: "serial" | "parallel"
  maxConcurrent?: number
  notify?: boolean
  journal?: boolean
  sweepStale?: boolean
  unattendedDenyMs?: number
  permissions?: Record<string, boolean>
  scope?: "repository" | "worktree"
}

export function normalizeSettings(
  merged: SettingsValues,
  limits: {
    timeout: { default: number; min: number; max: number }
    concurrent: { default: number; min: number; max: number }
    unattended: { default: number; min: number; max: number }
  },
) {
  const timeout = merged.timeoutMs ?? limits.timeout.default
  const concurrent = merged.maxConcurrent ?? limits.concurrent.default
  const unattended = merged.unattendedDenyMs ?? limits.unattended.default
  return {
    enabled: merged.enabled ?? true,
    model: merged.model,
    variant: merged.variant,
    timeoutMs: Math.min(
      limits.timeout.max,
      Math.max(limits.timeout.min, timeout),
    ),
    processing: merged.processing ?? "parallel",
    maxConcurrent: Math.min(
      limits.concurrent.max,
      Math.max(limits.concurrent.min, Math.floor(concurrent)),
    ),
    notify: merged.notify ?? true,
    journal: merged.journal ?? true,
    sweepStale: merged.sweepStale ?? true,
    unattendedDenyMs:
      unattended <= 0
        ? 0
        : Math.min(
            limits.unattended.max,
            Math.max(limits.unattended.min, unattended),
          ),
    permissions: literalRecord(Object.entries(merged.permissions ?? {})),
    scope: merged.scope ?? "repository",
  }
}

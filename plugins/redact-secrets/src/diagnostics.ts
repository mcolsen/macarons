import { AsyncLocalStorage } from "node:async_hooks"
import type { AppLogger, ServerToast } from "@macarons/permission-rules"
import { FINGERPRINT_MAX_CANDIDATES, type ScanLimitInfo } from "./shared"

export const SCAN_LIMIT_GUIDANCE =
  "Re-run with smaller or selective output if the omitted content is needed. The session can continue; do not clear the redact-secrets catalog or key files."

const SCAN_LIMIT_TOAST =
  "Secret scanning omitted candidate-heavy content safely. The session can continue; re-run with smaller or selective output if needed."

const RECOVERY_SCAN_LIMIT_TOAST =
  "Secret scanning skipped candidate-heavy local recovery data safely. The session can continue; use smaller or selective local input if needed."

const SCAN_WARNING_DURATION_MS = 12_000
const FATAL_ERROR_DURATION_MS = 15_000

const HOOKS = new Set([
  "config",
  "experimental.chat.messages.transform",
  "experimental.chat.system.transform",
  "experimental.text.complete",
  "source.redaction",
  "tool.definition",
  "tool.execute.before",
  "wire.request",
])

const SURFACES = new Set([
  "agent descriptions",
  "chat messages",
  "completed text",
  "provider request body",
  "recovery sources",
  "request sources",
  "system prompt",
  "tool arguments",
  "tool definition",
])

const PART_TYPES = new Set([
  "agent",
  "compaction",
  "file",
  "patch",
  "reasoning",
  "retry",
  "snapshot",
  "step-finish",
  "step-start",
  "subtask",
  "text",
  "tool",
])

// Host built-ins only. Plugin/MCP names are deliberately collapsed to
// "custom": a repository can choose an arbitrary, secret-bearing tool name.
const BUILTIN_TOOLS = new Set([
  "apply_patch",
  "bash",
  "edit",
  "glob",
  "grep",
  "lsp",
  "question",
  "read",
  "skill",
  "task",
  "todowrite",
  "webfetch",
  "websearch",
  "write",
])

export type RedactionFailureCategory =
  | "FingerprintLimitError"
  | "OversizedBodyError"
  | "UnscannableBodyError"
  | "VaultLimitError"
  | "WalkLimitError"
  | "UnexpectedError"

export type DiagnosticContext = {
  hook?: unknown
  surface?: unknown
  sessionID?: unknown
  messageID?: unknown
  partID?: unknown
  partType?: unknown
  tool?: unknown
}

type SafeContext = {
  hook?: string
  surface?: string
  sessionID?: string
  messageID?: string
  partID?: string
  partType?: string
  tool?: string
}

const CONTEXT_KEYS = [
  "hook",
  "surface",
  "sessionID",
  "messageID",
  "partID",
  "partType",
  "tool",
] as const satisfies readonly (keyof DiagnosticContext)[]

function member(
  value: unknown,
  allowed: ReadonlySet<string>,
): string | undefined {
  return typeof value === "string" && value.length <= 64 && allowed.has(value)
    ? value
    : undefined
}

function hostID(value: unknown, prefix: "ses" | "msg" | "prt") {
  if (typeof value !== "string" || value.length > 36) return undefined
  return new RegExp(`^${prefix}_[A-Za-z0-9]{8,32}$`).test(value)
    ? value
    : undefined
}

function safeTool(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  if (value.length > 64) return "custom"
  return BUILTIN_TOOLS.has(value) ? value : "custom"
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    : undefined
}

function read(value: unknown, key: string): unknown {
  try {
    return (value as Record<string, unknown> | null | undefined)?.[key]
  } catch {
    return undefined
  }
}

function safeContext(value: DiagnosticContext): SafeContext {
  return {
    hook: member(read(value, "hook"), HOOKS),
    surface: member(read(value, "surface"), SURFACES),
    sessionID: hostID(read(value, "sessionID"), "ses"),
    messageID: hostID(read(value, "messageID"), "msg"),
    partID: hostID(read(value, "partID"), "prt"),
    partType: member(read(value, "partType"), PART_TYPES),
    tool: safeTool(read(value, "tool")),
  }
}

function defined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  )
}

function failureDetail(
  category: RedactionFailureCategory,
  surface: string,
): { reason: string; guidance: string; toast: string } {
  switch (category) {
    case "WalkLimitError": {
      const reason = `Redaction input in ${surface} was too large or deeply nested.`
      const guidance = "Retry with smaller or less-nested input."
      return { reason, guidance, toast: `${reason} ${guidance}` }
    }
    case "VaultLimitError": {
      const reason = `The secret vault filled while scanning ${surface}.`
      const guidance =
        "Retry with smaller output, then restart OpenCode to clear the in-memory vault."
      return { reason, guidance, toast: `${reason} ${guidance}` }
    }
    case "OversizedBodyError": {
      const reason = `Wire inspection found an oversized body in ${surface}.`
      const guidance = "Retry with a smaller request body."
      return { reason, guidance, toast: `${reason} ${guidance}` }
    }
    case "UnscannableBodyError": {
      const reason = `Wire inspection found an unsupported body encoding in ${surface}.`
      const guidance =
        "Retry with a smaller body in a supported text or JSON encoding."
      return { reason, guidance, toast: `${reason} ${guidance}` }
    }
    case "FingerprintLimitError": {
      const reason = `Fingerprint recovery exceeded its safe limit in ${surface}.`
      const guidance =
        "Retry with smaller or selective output; do not clear the redact-secrets catalog or key files."
      return { reason, guidance, toast: `${reason} ${guidance}` }
    }
    case "UnexpectedError": {
      const reason = `Unexpected redaction failure in ${surface}.`
      const guidance = "See redact-secrets logs and report a bug."
      return { reason, guidance, toast: `${reason} ${guidance}` }
    }
  }
}

function mergeContext(
  outer: DiagnosticContext | undefined,
  inner: DiagnosticContext,
): DiagnosticContext {
  const result: DiagnosticContext = {}
  for (const key of CONTEXT_KEYS) {
    const next = read(inner, key)
    const value = next === undefined ? read(outer, key) : next
    if (value !== undefined) result[key] = value
  }
  return result
}

export type RedactionDiagnostics = ReturnType<typeof createRedactionDiagnostics>

/**
 * Secret-safe reporting for redaction work. All emitted prose is fixed, and
 * every dynamic field is allowlisted before it reaches the logger or a toast.
 * Reporting itself is best-effort and can never replace the original failure.
 */
export function createRedactionDiagnostics(input: {
  log: AppLogger
  toast: ServerToast
  candidateLimit?: number
  maxDedupeEntries?: number
}) {
  const contexts = new AsyncLocalStorage<DiagnosticContext>()
  const loggedScanLimits = new Set<string>()
  const toastedScanLimits = new Set<string>()
  const candidateLimit =
    finiteCount(input.candidateLimit) ?? FINGERPRINT_MAX_CANDIDATES
  const maxDedupeEntries = Math.max(
    1,
    finiteCount(input.maxDedupeEntries) ?? 512,
  )

  const emitLog = (
    level: "warn" | "error",
    message: string,
    extra: Record<string, unknown>,
  ) => {
    try {
      input.log(level, message, extra)
    } catch {
      // Diagnostics must not disturb redaction or replace its original error.
    }
  }

  const emitToast = (
    variant: "warning" | "error",
    message: string,
    duration: number,
  ) => {
    try {
      input.toast(variant, message, {
        title: "Secret redaction",
        duration,
      })
    } catch {
      // serverToast already contains failures; tolerate narrower test doubles.
    }
  }

  const scope = <T>(context: DiagnosticContext, operation: () => T): T =>
    contexts.run(mergeContext(contexts.getStore(), context), operation)

  const remember = (seen: Set<string>, key: string): boolean => {
    if (seen.has(key)) return false
    seen.add(key)
    while (seen.size > maxDedupeEntries) {
      const oldest = seen.values().next().value
      if (oldest === undefined) break
      seen.delete(oldest)
    }
    return true
  }

  const onScanLimit = (details: ScanLimitInfo): void => {
    try {
      const context = safeContext(
        mergeContext(contexts.getStore(), {
          partID: read(details, "partID"),
          partType: read(details, "partType"),
          tool: read(details, "tool"),
        }),
      )
      const toastKey = [
        context.sessionID ?? "global",
        context.surface ?? "unknown-surface",
      ].join("\u0000")
      const characters = finiteCount(read(details, "characters"))
      const candidates = finiteCount(read(details, "candidates"))
      const logKey = [
        context.sessionID ?? "global",
        context.hook ?? "unknown-hook",
        context.surface ?? "unknown-surface",
        context.messageID ?? "unknown-message",
        context.partID ?? "unknown-part",
        characters ?? "unknown-characters",
        candidates ?? "unknown-candidates",
      ].join("\u0000")
      const recovery = context.surface === "recovery sources"
      if (remember(loggedScanLimits, logKey))
        emitLog(
          "warn",
          recovery
            ? "secret scan limit reached while learning local recovery sources; candidate-heavy local data was skipped"
            : "secret scan limit reached; candidate-heavy content was replaced with a safe marker",
          defined({
            event: "scan_limit",
            category: "FingerprintLimitError",
            ...context,
            characters,
            candidates,
            limit: candidateLimit,
            guidance: SCAN_LIMIT_GUIDANCE,
          }),
        )
      if (remember(toastedScanLimits, toastKey))
        emitToast(
          "warning",
          recovery ? RECOVERY_SCAN_LIMIT_TOAST : SCAN_LIMIT_TOAST,
          SCAN_WARNING_DURATION_MS,
        )
    } catch {
      // Host-owned values may be adversarial objects. Never let reporting turn
      // a contained scan limit back into a failed request.
    }
  }

  const reportFailure = (
    category: RedactionFailureCategory,
    context: DiagnosticContext = {},
  ): void => {
    try {
      const safe = safeContext(mergeContext(contexts.getStore(), context))
      const detail = failureDetail(category, safe.surface ?? "redaction input")
      emitLog(
        "error",
        "secret redaction failed closed; the request was stopped",
        defined({
          event: "redaction_failure",
          category,
          ...safe,
          reason: detail.reason,
          guidance: detail.guidance,
        }),
      )
      emitToast("error", detail.toast, FATAL_ERROR_DURATION_MS)
    } catch {
      // Reporting cannot be allowed to replace the original hook exception.
    }
  }

  const categoryOf = (
    classify: (error: unknown) => RedactionFailureCategory,
    error: unknown,
  ): RedactionFailureCategory => {
    try {
      return classify(error)
    } catch {
      return "UnexpectedError"
    }
  }

  const runSync = <T>(
    context: DiagnosticContext,
    category: (error: unknown) => RedactionFailureCategory,
    operation: () => T,
  ): T => {
    try {
      return scope(context, operation)
    } catch (error) {
      reportFailure(categoryOf(category, error), context)
      throw error
    }
  }

  const run = async <T>(
    context: DiagnosticContext,
    category: (error: unknown) => RedactionFailureCategory,
    operation: () => T | Promise<T>,
  ): Promise<T> => {
    try {
      return await scope(context, operation)
    } catch (error) {
      reportFailure(categoryOf(category, error), context)
      throw error
    }
  }

  return { onScanLimit, reportFailure, run, runSync, scope }
}

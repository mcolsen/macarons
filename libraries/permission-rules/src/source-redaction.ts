type SourceRedactionScope = {
  serverUrl: string | URL
  directory: string
}

type SourceRedactor = { redact: (value: unknown) => void }

// Each independently bundled plugin has its own module copy, but shares this
// registry. Never share a configured engine/vault across servers or projects.
const SOURCE_REDACTORS = Symbol.for("@macarons/source-redactors")

function sourceRedactors(): Map<string, SourceRedactor> {
  const holder = globalThis as Record<symbol, unknown>
  holder[SOURCE_REDACTORS] ??= new Map()
  return holder[SOURCE_REDACTORS] as Map<string, SourceRedactor>
}

function scopeKey(scope: SourceRedactionScope): string {
  return JSON.stringify([new URL(scope.serverUrl).href, scope.directory])
}

/**
 * Register the optional live producer. The callback receives a mutable
 * one-element array holding the JSON snapshot, so even root strings can be
 * redacted in place. Disposing an older registration never removes a newer one.
 */
export function registerSourceRedactor(
  scope: SourceRedactionScope,
  redact: (value: unknown) => void,
): () => void {
  const registry = sourceRedactors()
  const key = scopeKey(scope)
  const entry = { redact }
  registry.set(key, entry)
  return () => {
    if (registry.get(key) === entry) registry.delete(key)
  }
}

/**
 * Resolve the producer at call time, independent of plugin load order. Without
 * one, preserve opt-out semantics (including object identity). With one, only
 * the detached, redacted JSON form may leave this boundary; never fall back to
 * raw source or expose a source-bearing exception through its message/cause.
 */
export function redactSourceValue<T>(scope: SourceRedactionScope, value: T): T {
  try {
    const producer = sourceRedactors().get(scopeKey(scope))
    if (!producer) return value
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error()
    const snapshot = [JSON.parse(serialized)]
    producer.redact(snapshot)
    return snapshot[0] as T
  } catch {
    throw new Error("Source redaction failed")
  }
}

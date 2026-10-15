/** Cooperative guard: model-specific prompt plugins must not modify an isolated judge. */
const KEY = Symbol.for("@macarons/isolated-generations")
function entries(): Set<string> {
  const globals = globalThis as Record<symbol, unknown>
  globals[KEY] ??= new Set<string>()
  return globals[KEY] as Set<string>
}
function key(
  location: { directory: string; workspaceID?: string },
  sessionID: string,
) {
  return JSON.stringify([location.workspaceID, location.directory, sessionID])
}
export function isolateGeneration(
  location: { directory: string; workspaceID?: string },
  sessionID: string,
): () => void {
  const id = key(location, sessionID)
  entries().add(id)
  return () => {
    entries().delete(id)
  }
}
export function isIsolatedGeneration(
  location: { directory: string; workspaceID?: string },
  sessionID: string,
): boolean {
  return entries().has(key(location, sessionID))
}

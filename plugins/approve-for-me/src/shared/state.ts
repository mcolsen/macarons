export type StackPosition = { sessionID: string; requestID: string }

export const SESSION_ANCESTRY_HOP_LIMIT = 20

/** Host prompt-stack ordering: session id, then request id. */
export function compareStackOrder(a: StackPosition, b: StackPosition): number {
  if (a.sessionID !== b.sessionID) return a.sessionID < b.sessionID ? -1 : 1
  if (a.requestID !== b.requestID) return a.requestID < b.requestID ? -1 : 1
  return 0
}

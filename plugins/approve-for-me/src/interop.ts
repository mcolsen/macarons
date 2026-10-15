import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { rpcDefinition } from "./rpc"

/** Ask the owning V2 server which pinned classifier is actually active. */
export async function classifierProvider(
  client: Pick<OpenCodeClient, "rpc">,
  location: LocationRef,
  sessionID: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await client.rpc(rpcDefinition).classifierProvider(
      { sessionID },
      {
        location,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
          : AbortSignal.timeout(5_000),
      },
    )
    return result.providerID
  } catch {
    // An unavailable or paused companion must never advertise classifier usage.
    return undefined
  }
}

export { rpcDefinition } from "./rpc"

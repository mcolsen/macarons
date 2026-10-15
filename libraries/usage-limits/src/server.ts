import { clampNumber } from "@macarons/permission-rules"
import type { Credential, Plugin } from "@opencode/plugin"
import type { createSignal } from "solid-js"
import type { EffectiveProvider, UsageProviderModule } from "./core"
import { usageLimitsRpc } from "./rpc"

/** Provider modules keep their private state on the server without a UI runtime. */
const stateSignal: typeof createSignal = (<T>(initial?: T) => {
  let value = initial
  return [
    () => value,
    (next: T | ((current: T | undefined) => T)) => {
      value =
        typeof next === "function"
          ? (next as (current: T | undefined) => T)(value)
          : next
      return value
    },
  ]
}) as typeof createSignal

/** Resolve credentials only through the host's active integration connection. */
export async function activeCredential(
  ctx: Plugin.Context,
  providerID: string,
): Promise<Credential.Value | undefined> {
  const provider = (await ctx.provider.list()).data.find(
    (item) => item.id === providerID,
  )
  if (!provider || provider.activation === "disabled") return
  const integrationID = provider.integrationID ?? providerID
  const connection = await ctx.integration.connection.active(integrationID)
  if (!connection) return
  const value = await ctx.integration.connection.resolve(connection)
  const current = await ctx.integration.connection.active(integrationID)
  // A switch while resolve was pending must not revive a previous account.
  if (JSON.stringify(current) !== JSON.stringify(connection)) return
  return value
}

export async function createUsageLimitsServer(input: {
  ctx: Plugin.Context
  module: UsageProviderModule
  authStore?: (credential: Credential.Value | undefined) => unknown
}): Promise<() => Promise<void>> {
  const { ctx, module } = input
  const controller = new AbortController()
  let provider: EffectiveProvider | undefined
  let credential: Credential.Value | undefined
  let generation = 0
  const load = async () => {
    const sequence = ++generation
    const value = await activeCredential(ctx, module.providerID).catch(
      () => undefined,
    )
    if (sequence !== generation || controller.signal.aborted) return
    credential = value
    provider =
      value?.type === "key" ? { key: value.key, options: {} } : undefined
  }
  const providers = ctx.options.providers
  const options =
    providers && typeof providers === "object"
      ? providers[module.providerID]
      : undefined
  const instance = module.create({
    readAuthStore: async () => {
      await load()
      return input.authStore?.(credential)
    },
    provider: () => provider,
    fetcher: (url, init) => fetch(url, init),
    options: options && typeof options === "object" ? options : {},
    userAgent: `opencode/${ctx.app.version}`,
    intervalMs: clampNumber(ctx.options.interval, 60, 15, 3600) * 1000,
    disposeSignal: controller.signal,
    createSignal: stateSignal,
  })
  const registration = await ctx.rpc.register(
    usageLimitsRpc(module.providerID),
    {
      snapshot: async () => {
        await load()
        await instance.syncAuth()
        if (!controller.signal.aborted) await instance.refresh(false)
        // Synthetic's module consumes the resolved key synchronously: re-resolve
        // after I/O before returning anything so an account switch clears it.
        await load()
        await instance.syncAuth()
        const snapshot = controller.signal.aborted
          ? undefined
          : instance.snapshot()
        // RPC validates JSON before transport serialization, so nested optional
        // values must be omitted rather than retained as undefined properties.
        return {
          snapshot: snapshot ? JSON.parse(JSON.stringify(snapshot)) : null,
        }
      },
    },
  )
  return async () => {
    controller.abort()
    generation++
    credential = undefined
    provider = undefined
    await registration.dispose()
  }
}

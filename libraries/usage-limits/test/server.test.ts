import { expect, test } from "bun:test"
import type { Credential, Plugin } from "@opencode/plugin"
import type { ProviderContext } from "../src/core"
import { activeCredential, createUsageLimitsServer } from "../src/server"

function harness() {
  let credential: Credential.Value | undefined = {
    type: "key",
    key: "server-key",
  }
  let connection = { id: "first" }
  let disabled = false
  let disposed = false
  let handler!: () => Promise<unknown>
  const ctx = {
    options: {},
    app: { version: "2.0.29" },
    provider: {
      list: async () => ({
        data: [
          {
            id: "synthetic",
            integrationID: "synthetic",
            activation: disabled ? "disabled" : "enabled",
          },
        ],
      }),
    },
    integration: {
      connection: {
        active: async () => connection,
        resolve: async () => credential,
      },
    },
    rpc: {
      register: async (
        _definition: unknown,
        handlers: { snapshot: () => Promise<unknown> },
      ) => {
        handler = handlers.snapshot
        return {
          dispose: async () => {
            disposed = true
          },
        }
      },
    },
  } as unknown as Plugin.Context
  return {
    ctx,
    snapshot: () => handler(),
    setCredential: (value: Credential.Value | undefined) => {
      credential = value
    },
    switchConnection: () => {
      connection = { id: "second" }
    },
    disable: () => {
      disabled = true
    },
    disposed: () => disposed,
  }
}

test("active credentials come from the server integration, not local auth files", async () => {
  const h = harness()
  expect(await activeCredential(h.ctx, "synthetic")).toEqual({
    type: "key",
    key: "server-key",
  })
  h.disable()
  expect(await activeCredential(h.ctx, "synthetic")).toBeUndefined()
})

test("connection switches while resolving fail closed", async () => {
  const h = harness()
  Object.assign(h.ctx.integration.connection, {
    resolve: async () => {
      h.switchConnection()
      return { type: "key", key: "stale-key" }
    },
  })
  expect(await activeCredential(h.ctx, "synthetic")).toBeUndefined()
})

test("snapshot RPC exposes quota values only and rechecks auth after fetching", async () => {
  const h = harness()
  let context!: ProviderContext
  let key: string | undefined
  let visible = false
  let switchDuringFetch = false
  const cleanup = await createUsageLimitsServer({
    ctx: h.ctx,
    module: {
      providerID: "synthetic",
      title: "Synthetic",
      create: (ctx) => {
        context = ctx
        return {
          available: () => Boolean(key),
          snapshot: () =>
            visible
              ? { windows: [{ key: "5h", label: "5h", usedPercent: 20 }] }
              : undefined,
          syncAuth: async () => {
            const next = ctx.provider()?.key
            if (next !== key) visible = false
            key = next
          },
          refresh: async () => {
            visible = Boolean(key)
            if (switchDuringFetch) h.setCredential(undefined)
          },
        }
      },
    },
  })
  expect(await h.snapshot()).toEqual({
    snapshot: { windows: [{ key: "5h", label: "5h", usedPercent: 20 }] },
  })
  expect(JSON.stringify(await h.snapshot())).not.toContain("server-key")
  switchDuringFetch = true
  expect(await h.snapshot()).toEqual({ snapshot: null })
  await cleanup()
  expect(context.disposeSignal.aborted).toBe(true)
  expect(h.disposed()).toBe(true)
})

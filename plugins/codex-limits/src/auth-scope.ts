import { createHmac, randomUUID } from "node:crypto"
import os from "node:os"
import {
  readRefreshedAuthStore,
  routeSessionID,
  sdkClientBaseUrl,
  withTimeout,
} from "@macarons/permission-rules"
import type { UsageProviderModule } from "@macarons/usage-limits"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { type CodexOauth, codexModule, codexOauthFrom } from "./codex"

const PREFIX = "macarons.codex-auth.v1"
const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
const PROBE = new RegExp(`^macarons\\.codex-auth\\.v1:probe:(${UUID})$`)
const TIMEOUT_MS = 3_000

// A fresh, credential-keyed proof of the complete request identity. Neither
// tokens nor account IDs cross the event bus, and old replies cannot be reused.
function proof(oauth: CodexOauth, nonce: string): string {
  return createHmac("sha256", oauth.access)
    .update(
      JSON.stringify([
        PREFIX,
        nonce,
        oauth.refresh ?? null,
        oauth.expires,
        oauth.accountId ?? null,
      ]),
    )
    .digest("hex")
}

export function createAuthScopeResponder(input: {
  readAuthStore: () => Promise<unknown>
  publish: (command: string, signal: AbortSignal) => Promise<unknown>
  signal: AbortSignal
}) {
  let pending = 0
  return async (event: { type: string; properties?: unknown }) => {
    if (event.type !== "tui.command.execute" || input.signal.aborted) return
    const command = (event.properties as { command?: unknown } | undefined)
      ?.command
    if (typeof command !== "string" || command.length > 128) return
    const match = PROBE.exec(command)
    const nonce = match?.[1]
    if (!nonce || match?.[0] !== command || pending >= 8) return
    pending += 1
    // Keep the slot until the underlying work settles, even if it ignores
    // cancellation, so an unresponsive transport cannot accumulate work.
    let work: Promise<unknown> = Promise.resolve()
    try {
      await withTimeout(
        (signal) => {
          work = (async () => {
            const oauth = codexOauthFrom(await input.readAuthStore())
            signal.throwIfAborted()
            await input.publish(
              `${PREFIX}:result:${nonce}:${oauth ? proof(oauth, nonce) : "unavailable"}`,
              signal,
            )
          })()
          return work
        },
        TIMEOUT_MS,
        { signal: input.signal },
      )
    } catch {
      // Missing/unreadable server auth is unavailable, never a local fallback.
    } finally {
      void work.catch(() => {}).finally(() => pending--)
    }
  }
}

/** Codex alone needs a proof; Synthetic already uses server-resolved keys. */
export function scopedCodexModule(api: TuiPluginApi): UsageProviderModule {
  return {
    ...codexModule,
    create(ctx) {
      const target = () => {
        const sessionID = routeSessionID(api)
        const session = sessionID ? api.state.session.get(sessionID) : undefined
        return {
          client: api.client,
          url: sdkClientBaseUrl(api.client),
          directory: session?.directory || api.state.path.directory,
          workspace: session?.workspaceID,
        }
      }
      const [scope, setScope] = ctx.createSignal<ReturnType<typeof target>>()
      const matches = () => {
        try {
          const current = target()
          const selected = scope()
          return (
            selected !== undefined &&
            current.client === selected.client &&
            current.url === selected.url &&
            current.directory === selected.directory &&
            current.workspace === selected.workspace
          )
        } catch {
          return false
        }
      }
      let epoch = new AbortController()
      let pending = 0
      const instance = codexModule.create({
        ...ctx,
        readAuthStore: async () => {
          const currentEpoch = epoch
          const selected = scope()
          const publish = selected?.client.tui?.publish
          if (!selected?.directory || typeof publish !== "function") return
          if (pending >= 8) return
          pending += 1
          let off: (() => void) | undefined
          let work: Promise<unknown> = Promise.resolve()
          try {
            return await withTimeout(
              (signal) => {
                work = (async () => {
                  const store = await readRefreshedAuthStore({
                    env: process.env,
                    homedir: os.homedir(),
                  })
                  signal.throwIfAborted()
                  const oauth = codexOauthFrom(store)
                  if (!oauth) return
                  const nonce = randomUUID()
                  const expected = `${PREFIX}:result:${nonce}:${proof(oauth, nonce)}`
                  const prefix = `${PREFIX}:result:${nonce}:`
                  const reply = new Promise<boolean>((resolve) => {
                    off = api.event.on("tui.command.execute", (event) => {
                      const command = event.properties?.command
                      if (
                        typeof command === "string" &&
                        command.startsWith(prefix)
                      )
                        resolve(command === expected)
                    })
                    signal.addEventListener("abort", () => resolve(false), {
                      once: true,
                    })
                  })
                  const result = await selected.client.tui.publish(
                    {
                      directory: selected.directory,
                      workspace: selected.workspace,
                      body: {
                        type: "tui.command.execute",
                        properties: { command: `${PREFIX}:probe:${nonce}` },
                      },
                    },
                    { signal },
                  )
                  if (result.error != null || !(await reply)) return
                  if (signal.aborted || !matches() || currentEpoch !== epoch)
                    return
                  return store
                })()
                return work
              },
              TIMEOUT_MS,
              {
                signal: AbortSignal.any([
                  ctx.disposeSignal,
                  currentEpoch.signal,
                ]),
              },
            )
          } catch {
            return undefined
          } finally {
            off?.()
            void work.catch(() => {}).finally(() => pending--)
          }
        },
      })
      const invalidate = () => {
        epoch.abort()
        epoch = new AbortController()
        setScope(undefined)
        instance.invalidateAuth()
      }
      const selectScope = () => {
        if (matches()) return
        invalidate()
        try {
          setScope(target())
        } catch {}
      }
      api.lifecycle.onDispose(api.event.on("server.connected", invalidate))
      api.lifecycle.onDispose(invalidate)
      return {
        available: () => matches() && instance.available(),
        snapshot: () => (matches() ? instance.snapshot() : undefined),
        syncAuth: async () => {
          selectScope()
          await instance.syncAuth()
        },
        refresh: async (force) => {
          selectScope()
          await instance.refresh(force)
        },
      }
    },
  }
}

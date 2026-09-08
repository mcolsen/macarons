import os from "node:os"
import { respondInstanceRequest } from "@macarons/approve-for-me/shared"
import { readRefreshedAuthStore } from "@macarons/permission-rules"
import { makeTuiApi } from "@macarons/plugin-test-harness/tui"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
import { createAuthScopeResponder } from "../src/auth-scope"
import { tui } from "../src/tui"

type Api = Parameters<TuiPlugin>[0]

export const INSTANCE_ID = "11111111-1111-4111-8111-111111111111"

type Provider = {
  id: string
  models: Record<string, { variants?: Record<string, unknown> }>
}

type SessionMetadata =
  | "missing"
  | "throwing"
  | { parentID?: unknown; directory?: string; workspaceID?: string }
  | readonly unknown[]

/**
 * codex-limits' api mock — the shared core plus what this plugin's entry
 * actually reads: the session→provider inputs (sticky session model, last
 * assistant turn, config default), and the session status feed the modules
 * watch for retry states. Shared by the engine tests (tui.test.ts) and
 * the rendering tests (view.test.tsx), which used to carry two divergent
 * copies.
 *
 * The composed api is structural (the core's containers are open records),
 * so drift against the real TuiPluginApi is caught at the cast in `load`
 * below — the role the old file-local `satisfies TouchedApi` played.
 */
export function makeApi(
  input: {
    version?: string | null
    /** Server origin `_client.getConfig()` reports; "" models an unreadable
     * transport. */
    baseUrl?: string
    /** Independent server credentials; false models a missing companion. */
    serverAuth?: (() => Promise<unknown>) | false
    routeName?: string
    routeSessionID?: string
    sessionModelProviderID?: string
    lastAssistantProviderID?: string
    configModel?: string
    parentID?: unknown
    sessionMetadata?: SessionMetadata
    messagesThrow?: boolean
    /** Merged over the core's defaults; view tests pin span colours to it. */
    theme?: Record<string, unknown>
    /**
     * Back state.session.status with a solid signal so the sidebar's gate
     * effect re-samples when setSessionStatus fires — the delivery path
     * view.test.tsx pins. Engine tests leave it off: the poll loop samples
     * status imperatively, and nothing there observes reactivity.
     */
    reactiveStatus?: boolean
    providers?: readonly Provider[]
    onProviderCatalogRead?: () => void
    paths?: {
      config: string
      state: string
      directory: string
      worktree?: string
    }
  } = {},
) {
  const base = makeTuiApi({
    version: input.version,
    baseUrl: input.baseUrl,
    routeName: input.routeName,
    routeSessionID: input.routeSessionID,
    theme: input.theme,
    paths: {
      config: input.paths?.config ?? "/nonexistent/codex-limits-test/config",
      state: input.paths?.state ?? "/nonexistent/codex-limits-test/state",
      // The host's non-git sentinel unless a fixture names a worktree.
      worktree: input.paths?.worktree ?? "/",
      directory:
        input.paths?.directory ?? "/nonexistent/codex-limits-test/project",
    },
  })
  const responseClient = {
    tui: {
      publish: async (request: unknown) => {
        const body = (
          request as { body: { type: string; properties: unknown } }
        ).body
        base.emit(body.type, body.properties)
        return {}
      },
    },
  } as unknown as Parameters<typeof respondInstanceRequest>[0]

  const [statusSignal, setStatusSignal] = createSignal<
    Record<string, unknown> | undefined
  >(undefined)
  const [sessionMetadata, setSessionMetadata] = createSignal<SessionMetadata>(
    input.sessionMetadata ?? { parentID: input.parentID },
  )
  const [messagesThrow, setMessagesThrow] = createSignal(
    input.messagesThrow ?? false,
  )
  let statusValue: Record<string, unknown> | undefined
  const status = input.reactiveStatus ? statusSignal : () => statusValue

  base.api.state.config = { model: input.configModel }
  const providers = input.providers ?? [
    { id: "openai", models: { "gpt-5.5-codex": {} } },
    { id: "opencode-go", models: { "minimax-m3": {} } },
  ]
  Object.defineProperty(base.api.state, "provider", {
    get: () => {
      input.onProviderCatalogRead?.()
      return providers
    },
  })
  base.api.state.session = {
    get: (sessionID: string) => {
      const metadata = sessionMetadata()
      if (metadata === "missing") return undefined
      if (metadata === "throwing")
        throw new Error("session metadata unavailable")
      if (Array.isArray(metadata)) return metadata as never
      return {
        id: sessionID,
        ...metadata,
        model: input.sessionModelProviderID
          ? { id: "some-model", providerID: input.sessionModelProviderID }
          : undefined,
      }
    },
    messages: () => {
      if (messagesThrow()) throw new Error("session messages unavailable")
      return input.lastAssistantProviderID
        ? [{ role: "assistant", providerID: input.lastAssistantProviderID }]
        : []
    },
    status: () => status(),
  }

  const activeCompletions = new Set<Promise<void>>()
  let serverAuth =
    input.serverAuth === false
      ? undefined
      : (input.serverAuth ??
        (() =>
          readRefreshedAuthStore({ env: process.env, homedir: os.homedir() })))
  const authCommands: string[] = []
  const respond = createAuthScopeResponder({
    readAuthStore: async () => serverAuth?.(),
    publish: async (command) => {
      authCommands.push(command)
      base.emit("tui.command.execute", { command })
    },
    signal: base.api.lifecycle.signal,
  })
  base.api.client.tui = {
    publish: async (parameters: {
      body: { type: string; properties: { command: string } }
    }) => {
      if (
        await respondInstanceRequest(
          responseClient,
          parameters.body,
          INSTANCE_ID,
          base.api.state.path.directory,
        )
      )
        return { data: true }
      if (input.serverAuth !== false) {
        authCommands.push(parameters.body.properties.command)
        await respond(parameters.body)
      }
      return { data: true }
    },
  }
  const load = (options?: Record<string, unknown>) =>
    tui(base.api as unknown as Api, options, {} as never)

  Object.assign(base.api, {
    __usageLimitsTestHooks: {
      onTick: (completion: Promise<void>) => {
        activeCompletions.add(completion)
        void completion.then(
          () => activeCompletions.delete(completion),
          () => activeCompletions.delete(completion),
        )
      },
      onClassifierSync: (completion: Promise<void>) => {
        activeCompletions.add(completion)
        void completion.then(
          () => activeCompletions.delete(completion),
          () => activeCompletions.delete(completion),
        )
      },
    },
  })

  return {
    ...base,
    load,
    authCommands,
    setServerAuth: (read: () => Promise<unknown>) => {
      serverAuth = read
    },
    waitForQuiescence: async () => {
      while (activeCompletions.size > 0) {
        await Promise.allSettled([...activeCompletions])
      }
    },
    setSessionStatus: (value: Record<string, unknown> | undefined) => {
      statusValue = value
      setStatusSignal(value)
    },
    setSessionMetadata: (value: SessionMetadata) => setSessionMetadata(value),
    setMessagesThrow: (value: boolean) => setMessagesThrow(value),
  }
}

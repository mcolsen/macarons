import { clampNumber, every, MAX_TIMER_MS } from "@macarons/permission-rules"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { createEffect, createMemo, createSignal } from "solid-js"
import {
  activeProviderID,
  type ProviderInstance,
  resolvePathsOnce,
  routeSessionID,
  type SessionRetryStatus,
  tuiGate,
  type UsageProviderModule,
} from "./core"

const DEFAULT_INTERVAL_SECONDS = 60
const MIN_INTERVAL_SECONDS = 15

export type ClassifierProvider = {
  id: string
  models: Record<string, { variants?: Record<string, unknown> }>
}

export type ClassifierConfigHandle = {
  providerID: (input: {
    rootSessionID: string
    providers: readonly ClassifierProvider[]
  }) => Promise<string | undefined>
}

export type ClassifierResolver = (input: {
  directory: string
  worktree?: string
  configDir: string
  stateDir: string
}) => Promise<ClassifierConfigHandle | undefined>

export type UsageLimitsEngine = {
  instances: Map<
    string,
    { module: UsageProviderModule; instance: ProviderInstance }
  >
  classifierProviderID: () => string | undefined
  nextModelProviderID: (sessionID: string) => string | undefined
  feedRetryStatus: (status: unknown) => void
  syncClassifier: (rootSessionID: string | undefined) => Promise<void>
}

type UsageLimitsTestHooks = {
  onTick?: (completion: Promise<void>) => void
  onClassifierSync?: (completion: Promise<void>) => void
}

function testHooks(api: TuiPluginApi): UsageLimitsTestHooks | undefined {
  return (
    api as TuiPluginApi & { __usageLimitsTestHooks?: UsageLimitsTestHooks }
  ).__usageLimitsTestHooks
}

// Unlike the suite-wide sub-agent check, usage polling must fail closed while
// the routed session record is still syncing: an unknown ID may be a child.
function knownTopLevelSessionID(
  api: TuiPluginApi,
  sessionID: string | undefined,
): string | undefined {
  if (!sessionID) return
  try {
    const session = api.state.session.get(sessionID)
    if (!session || typeof session !== "object" || Array.isArray(session))
      return
    if ((session as { parentID?: unknown }).parentID !== undefined) return
    return sessionID
  } catch {
    return
  }
}

function pluginProviderOptions(
  options: Record<string, unknown> | undefined,
  providerID: string,
): Record<string, unknown> {
  const providers = options?.providers
  if (!providers || typeof providers !== "object") return {}
  const entry = (providers as Record<string, unknown>)[providerID]
  return entry && typeof entry === "object"
    ? (entry as Record<string, unknown>)
    : {}
}

export function createUsageLimitsEngine(input: {
  api: TuiPluginApi
  options?: Record<string, unknown>
  modules: readonly UsageProviderModule[]
  label: string
  service: string
  createSignal: typeof createSignal
  resolveClassifier?: ClassifierResolver
}): UsageLimitsEngine | undefined {
  const { api } = input
  const hooks = testHooks(api)
  const gate = tuiGate(api, {
    label: input.label,
    service: input.service,
    remoteBails: true,
  })
  if (gate.disabled) return

  const intervalOption = input.options?.interval
  const intervalSeconds =
    typeof intervalOption === "number" &&
    Number.isFinite(intervalOption) &&
    intervalOption > 0
      ? clampNumber(
          intervalOption,
          DEFAULT_INTERVAL_SECONDS,
          MIN_INTERVAL_SECONDS,
          Math.floor(MAX_TIMER_MS / 1000),
        )
      : DEFAULT_INTERVAL_SECONDS
  const intervalMs = intervalSeconds * 1000
  const disposeController = new AbortController()
  const instances: UsageLimitsEngine["instances"] = new Map()

  for (const module of input.modules) {
    instances.set(module.providerID, {
      module,
      instance: module.create({
        // A TUI's environment/home is not the server's auth scope, even on
        // loopback. Modules needing OAuth must supply a verified reader.
        readAuthStore: async () => undefined,
        fetcher: (url, init) => fetch(url, init),
        userAgent: `opencode/${api.app.version}`,
        options: pluginProviderOptions(input.options, module.providerID),
        provider: () =>
          api.state.provider.find(
            (provider) => provider.id === module.providerID,
          ),
        intervalMs,
        disposeSignal: disposeController.signal,
        createSignal: input.createSignal,
      }),
    })
  }

  const [classifierPID, setClassifierPID] = input.createSignal<
    string | undefined
  >()
  // A model picked for the next turn has its own event; retain it only until
  // the synced session catches up or a later session update supersedes it.
  const [nextProviderIDs, setNextProviderIDs] = input.createSignal<
    ReadonlyMap<string, string>
  >(new Map())
  const rawWorktree = (): string | undefined => {
    const value = (api as { state?: { path?: { worktree?: unknown } } }).state
      ?.path?.worktree
    return typeof value === "string" ? value : undefined
  }
  const resolver = input.resolveClassifier
  const resolveClassifierOnce = resolver
    ? resolvePathsOnce<ClassifierConfigHandle>(
        api,
        ({ directory, config, state }) =>
          resolver({
            directory,
            worktree: rawWorktree(),
            configDir: config,
            stateDir: state,
          }),
        { require: ["config", "state"] },
      )
    : undefined

  let classifierSyncGeneration = 0
  let classifierRootSessionID: string | undefined
  const runClassifierSync = async (rootSessionID: string | undefined) => {
    const generation = ++classifierSyncGeneration
    if (rootSessionID !== classifierRootSessionID) {
      classifierRootSessionID = rootSessionID
      setClassifierPID(undefined)
    }
    if (!resolveClassifierOnce || !rootSessionID) return
    try {
      const config = await resolveClassifierOnce()
      const providerID = config
        ? await config.providerID({
            rootSessionID,
            providers: api.state.provider,
          })
        : undefined
      if (generation === classifierSyncGeneration) setClassifierPID(providerID)
    } catch {
      if (generation === classifierSyncGeneration) setClassifierPID(undefined)
    }
  }

  const syncClassifier = (rootSessionID: string | undefined) => {
    const completion = runClassifierSync(rootSessionID)
    hooks?.onClassifierSync?.(completion)
    return completion
  }

  const sessionProviderID = (sessionID: string): string | undefined => {
    const session = api.state.session.get(sessionID)
    const last = api.state.session
      .messages(sessionID)
      .findLast((item): item is AssistantMessage => item.role === "assistant")
    return activeProviderID({
      nextModelProviderID: nextProviderIDs().get(sessionID),
      sessionModelProviderID: session?.model?.providerID,
      lastAssistantProviderID: last?.providerID,
      configModel: api.state.config.model,
    })
  }

  const viewedSessionID = (): string | undefined => {
    return knownTopLevelSessionID(api, routeSessionID(api))
  }

  const relevantProviderIDs = (sessionID: string | undefined): Set<string> => {
    const relevant = new Set<string>()
    if (!sessionID) return relevant
    const active = sessionProviderID(sessionID)
    if (active) relevant.add(active)
    const classifier = classifierPID()
    if (classifier) relevant.add(classifier)
    return relevant
  }

  const feedRetryStatus = (status: unknown) => {
    if (!status || typeof status !== "object") return
    const record = status as {
      type?: unknown
      message?: unknown
      next?: unknown
      action?: unknown
    }
    if (record.type !== "retry") return
    if (typeof record.message !== "string" || typeof record.next !== "number")
      return
    const narrowed: SessionRetryStatus = {
      message: record.message,
      next: record.next,
      action:
        record.action && typeof record.action === "object"
          ? (record.action as SessionRetryStatus["action"])
          : undefined,
    }
    for (const { instance } of instances.values())
      instance.onRetryStatus?.(narrowed)
  }

  const observeSession = (sessionID: string | undefined) => {
    if (!sessionID) return
    feedRetryStatus(api.state.session.status(sessionID))
    const last = api.state.session
      .messages(sessionID)
      .findLast((item): item is AssistantMessage => item.role === "assistant")
    if (!last?.error) return
    const anchor = last.time.completed ?? last.time.created
    for (const { instance } of instances.values())
      instance.onAssistantError?.(last.error, anchor)
  }

  const runTick = async (force: boolean) => {
    await Promise.all(
      [...instances.values()].map(({ instance }) =>
        instance.syncAuth().catch(() => {}),
      ),
    )
    const rootSessionID = viewedSessionID()
    await syncClassifier(rootSessionID)
    observeSession(rootSessionID)
    const relevant = relevantProviderIDs(rootSessionID)
    await Promise.all(
      [...instances.entries()]
        .filter(([providerID]) => relevant.has(providerID))
        .map(([, { instance }]) => instance.refresh(force).catch(() => {})),
    )
  }

  const tick = (force: boolean) => {
    const completion = runTick(force)
    hooks?.onTick?.(completion)
    return completion
  }

  void tick(false)
  const timer = every(() => void tick(false), intervalMs)
  api.lifecycle.onDispose(() => {
    clearInterval(timer)
    disposeController.abort()
  })
  api.lifecycle.onDispose(api.event.on("session.idle", () => void tick(true)))
  api.lifecycle.onDispose(
    api.event.on("session.next.model.switched", (event) => {
      const { sessionID, model } = event.properties
      setNextProviderIDs((current) => {
        const next = new Map(current)
        next.set(sessionID, model.providerID)
        return next
      })
      if (sessionID === viewedSessionID()) void tick(false)
    }),
  )
  api.lifecycle.onDispose(
    api.event.on("session.updated", (event) => {
      const { id: sessionID, model } = event.properties.info
      setNextProviderIDs((current) => {
        if (!current.has(sessionID)) return current
        const providerID = model?.providerID
        const next = new Map(current)
        if (providerID === current.get(sessionID)) next.delete(sessionID)
        else if (providerID) next.set(sessionID, providerID)
        else next.delete(sessionID)
        return next
      })
    }),
  )
  api.lifecycle.onDispose(
    api.event.on("session.deleted", (event) => {
      const sessionID = event.properties.info.id
      setNextProviderIDs((current) => {
        if (!current.has(sessionID)) return current
        const next = new Map(current)
        next.delete(sessionID)
        return next
      })
    }),
  )

  return {
    instances,
    classifierProviderID: classifierPID,
    nextModelProviderID: (sessionID) => nextProviderIDs().get(sessionID),
    feedRetryStatus,
    syncClassifier,
  }
}

export function createUsageLimitsViewModel(input: {
  api: TuiPluginApi
  engine: UsageLimitsEngine
  sessionID: string
  createMemo: typeof createMemo
  createEffect: typeof createEffect
}) {
  const theme = () => input.api.theme.current
  const rootSessionID = input.createMemo(() =>
    knownTopLevelSessionID(input.api, input.sessionID),
  )
  const session = input.createMemo(() => {
    if (!rootSessionID()) return
    try {
      return input.api.state.session.get(input.sessionID)
    } catch {
      return
    }
  })
  const last = input.createMemo(() => {
    if (!rootSessionID()) return
    try {
      return input.api.state.session
        .messages(input.sessionID)
        .findLast((item): item is AssistantMessage => item.role === "assistant")
    } catch {
      return
    }
  })
  const active = input.createMemo(() =>
    activeProviderID({
      nextModelProviderID: input.engine.nextModelProviderID(input.sessionID),
      sessionModelProviderID: session()?.model?.providerID,
      lastAssistantProviderID: last()?.providerID,
      configModel: input.api.state.config.model,
    }),
  )
  const sections = input.createMemo(() => {
    if (!rootSessionID()) return []
    const list: Array<{
      module: UsageProviderModule
      instance: ProviderInstance
      classifier: boolean
    }> = []
    const activePID = active()
    const activeEntry = activePID
      ? input.engine.instances.get(activePID)
      : undefined
    if (activeEntry) list.push({ ...activeEntry, classifier: false })
    const classifier = input.engine.classifierProviderID()
    if (classifier && classifier !== activePID) {
      const entry = input.engine.instances.get(classifier)
      if (entry) list.push({ ...entry, classifier: true })
    }
    return list
  })
  const rendered = input.createMemo(() =>
    sections()
      .map((section) => ({
        ...section,
        rows: section.instance.available()
          ? (section.instance.snapshot()?.windows ?? [])
          : [],
      }))
      .filter((section) => section.rows.length > 0),
  )

  input.createEffect(() => {
    void input.engine.syncClassifier(rootSessionID())
  })

  input.createEffect(() => {
    const sessionID = rootSessionID()
    if (!sessionID) return
    input.engine.feedRetryStatus(input.api.state.session.status(sessionID))
    for (const section of sections()) {
      if (section.instance.available() && !section.instance.snapshot())
        void section.instance.refresh(false).catch(() => {})
    }
  })

  const percentColor = (usedPercent: number) =>
    usedPercent >= 95
      ? theme().error
      : usedPercent >= 75
        ? theme().warning
        : theme().textMuted

  return { rendered, percentColor, theme }
}

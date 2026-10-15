import { clampNumber, every } from "@macarons/permission-rules"
import type { Plugin } from "@opencode/plugin/tui"
import type { createEffect, createMemo, createSignal } from "solid-js"
import type { LimitsSnapshot } from "./core"
import { classifierProviderRpc, usageLimitsRpc } from "./rpc"

export type UsageLimitsEngine = {
  snapshot: () => LimitsSnapshot | undefined
  classifierProviderID: () => string | undefined
  refresh: () => Promise<void>
  dispose: () => void
}

export function knownTopLevelSessionID(
  api: Plugin.Context,
): string | undefined {
  const route = api.ui.router.current()
  if (route.type !== "session") return
  const session = api.data.session.get(route.sessionID)
  return session && session.parentID === undefined ? route.sessionID : undefined
}

export function sessionProviderID(
  api: Plugin.Context,
  sessionID: string,
): string | undefined {
  return (
    api.ui.model.current()?.providerID ??
    api.data.session.get(sessionID)?.model?.providerID
  )
}

export function createUsageLimitsEngine(input: {
  api: Plugin.Context
  providerID: string
  createSignal: typeof createSignal
}): UsageLimitsEngine {
  const { api, providerID } = input
  const [snapshot, setSnapshot] = input.createSignal<LimitsSnapshot>()
  const [classifierProviderID, setClassifierProviderID] =
    input.createSignal<string>()
  const controller = new AbortController()
  let sequence = 0
  let viewedSessionID: string | undefined
  const interval = clampNumber(api.options.interval, 60, 15, 3600) * 1000
  const refresh = async () => {
    const generation = ++sequence
    const sessionID = knownTopLevelSessionID(api)
    if (sessionID !== viewedSessionID) {
      viewedSessionID = sessionID
      setSnapshot(undefined)
      setClassifierProviderID(undefined)
    }
    if (!sessionID || controller.signal.aborted) return
    const options = {
      location: api.data.session.get(sessionID)?.location ?? api.location,
      signal: controller.signal,
    }
    let classifier: string | undefined
    try {
      const result = (await api.client
        .rpc(classifierProviderRpc)
        .classifierProvider({ sessionID }, options)) as { providerID?: string }
      classifier = result.providerID
    } catch {
      /* Approve for Me is optional. */
    }
    if (generation !== sequence || controller.signal.aborted) return
    setClassifierProviderID(classifier)
    if (
      sessionProviderID(api, sessionID) !== providerID &&
      classifier !== providerID
    ) {
      setSnapshot(undefined)
      return
    }
    try {
      const result = (await api.client
        .rpc(usageLimitsRpc(providerID))
        .snapshot({}, options)) as { snapshot: LimitsSnapshot | null }
      if (
        generation !== sequence ||
        controller.signal.aborted ||
        knownTopLevelSessionID(api) !== sessionID
      )
        return
      setSnapshot(result.snapshot ?? undefined)
    } catch {
      if (generation === sequence) setSnapshot(undefined)
    }
  }
  void refresh()
  const timer = every(() => void refresh(), interval)
  const subscriptions = [
    api.data.on("session.model.selected", () => void refresh()),
    api.data.on("session.execution.succeeded", () => void refresh()),
    api.data.on("session.execution.failed", () => void refresh()),
    api.data.on("credential.switched", () => {
      setSnapshot(undefined)
      void refresh()
    }),
    api.data.on("credential.updated", () => {
      setSnapshot(undefined)
      void refresh()
    }),
  ]
  return {
    snapshot,
    classifierProviderID,
    refresh,
    dispose: () => {
      controller.abort()
      sequence++
      clearInterval(timer)
      for (const off of subscriptions) off()
    },
  }
}

export function createUsageLimitsViewModel(input: {
  api: Plugin.Context
  engine: UsageLimitsEngine
  providerID: string
  sessionID: string
  createMemo: typeof createMemo
  createEffect: typeof createEffect
}) {
  const visible = input.createMemo(() => {
    const session = input.api.data.session.get(input.sessionID)
    return session && session.parentID === undefined
  })
  const classifier = input.createMemo(
    () =>
      input.engine.classifierProviderID() === input.providerID &&
      sessionProviderID(input.api, input.sessionID) !== input.providerID,
  )
  const rows = input.createMemo(() =>
    visible() &&
    (sessionProviderID(input.api, input.sessionID) === input.providerID ||
      classifier())
      ? (input.engine.snapshot()?.windows ?? [])
      : [],
  )
  input.createEffect(() => {
    // Observe native route/model state so switching tabs/models refreshes promptly.
    knownTopLevelSessionID(input.api)
    sessionProviderID(input.api, input.sessionID)
    void input.engine.refresh()
  })
  const percentColor = (usedPercent: number) =>
    usedPercent >= 95
      ? input.api.theme.text.feedback.error.base
      : usedPercent >= 75
        ? input.api.theme.text.feedback.warning.base
        : input.api.theme.text.muted
  return { rows, classifier, percentColor }
}

import { withTimeout } from "@macarons/permission-rules"
import type { SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { detectBreakSeries, type StepSample } from "./core"
import {
  HISTORY_TIMEOUT_MS,
  MAX_TRACKED_SESSIONS,
  resolveOptions,
} from "./options"

export function messageSample(
  message: SessionMessageInfo,
): StepSample | undefined {
  if (message.type === "compaction" && message.status === "completed") {
    return {
      partID: message.id,
      messageID: message.id,
      providerID: "",
      modelID: "",
      summary: true,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      startedAt: message.time.created,
      observedAt: message.time.created,
    }
  }
  if (
    message.type !== "assistant" ||
    !message.tokens ||
    message.time.completed === undefined
  )
    return
  return {
    partID: message.id,
    messageID: message.id,
    providerID: message.model.providerID,
    modelID: message.model.id,
    summary: false,
    tokens: {
      input: message.tokens.input,
      output: message.tokens.output,
      reasoning: message.tokens.reasoning,
      cacheRead: message.tokens.cache.read,
      cacheWrite: message.tokens.cache.write,
    },
    startedAt: message.time.created,
    observedAt: message.time.streamed ?? message.time.completed,
  }
}

type Tracking = {
  samples: Map<string, StepSample>
  live: Set<string>
  loaded: boolean
  loading?: Promise<void>
  controller?: AbortController
  expiry?: { until: number; lostTokens: number }
}
export function createCacheEngine(
  ctx: Plugin.Context,
  changed: () => void,
  now = Date.now,
) {
  const { options, problems } = resolveOptions(ctx.options)
  for (const problem of problems)
    ctx.ui.toast.show({
      variant: "warning",
      title: "Cache ratio",
      message: problem,
    })
  const sessions = new Map<string, Tracking>()
  const starts = new Map<
    string,
    { sessionID: string; sample: Omit<StepSample, "tokens"> }
  >()
  const compactions = new Map<
    string,
    { messageID: string; startedAt: number }
  >()
  let disposed = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const viewed = () => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }
  const isRoot = (id: string) => {
    const session = ctx.data.session.get(id)
    return session !== undefined && !session.parentID
  }
  const drop = (id: string) => {
    sessions.get(id)?.controller?.abort()
    sessions.delete(id)
    compactions.delete(id)
    for (const [key, value] of starts)
      if (value.sessionID === id) starts.delete(key)
  }
  function tracking(id: string): Tracking {
    let record = sessions.get(id)
    if (!record) {
      record = { samples: new Map(), live: new Set(), loaded: false }
      sessions.set(id, record)
    } else {
      sessions.delete(id)
      sessions.set(id, record)
    }
    while (sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = [...sessions.keys()].find(
        (key) => key !== id && key !== viewed(),
      )
      if (!oldest) break
      drop(oldest)
    }
    return record
  }
  function samples(id: string) {
    const cutoff = ctx.data.session.get(id)?.revert?.messageID
    return [...(sessions.get(id)?.samples.values() ?? [])]
      .filter((sample) => !cutoff || sample.messageID < cutoff)
      .sort(
        (a, b) =>
          (a.startedAt ?? 0) - (b.startedAt ?? 0) ||
          a.messageID.localeCompare(b.messageID),
      )
  }
  function record(id: string, sample: StepSample, live: boolean) {
    if (disposed || !isRoot(id)) return
    const entry = tracking(id)
    // The host projects messages before notifying all listeners. A synced
    // copy may therefore arrive before the same live completion callback.
    // Preserve live dispatch timing/tokens against lagging store snapshots.
    if (!live && entry.live.has(sample.partID)) return
    const duplicate = entry.live.has(sample.partID)
    const before = detectBreakSeries(
      live && !duplicate
        ? samples(id).filter((item) => item.partID !== sample.partID)
        : samples(id),
      options,
    )
    if (live) entry.live.add(sample.partID)
    entry.samples.set(sample.partID, sample)
    const after = detectBreakSeries(samples(id), options)
    if (live && !duplicate && id === viewed()) {
      if (after?.kind === "break" && before?.kind !== "break" && options.toasts)
        ctx.ui.toast.show({
          variant: "error",
          title: "Cache ratio",
          message: `Prompt-cache reuse dropped: ${after.lostTokens.toLocaleString()} cached tokens lost.`,
          sessionID: id,
        })
      if (after?.kind === "expired") {
        const expiry = {
          until: now() + options.lingerMs,
          lostTokens: after.lostTokens,
        }
        entry.expiry = expiry
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (!disposed && entry.expiry === expiry) {
            entry.expiry = undefined
            changed()
          }
        }, options.lingerMs)
        timers.add(timer)
      }
    }
    changed()
  }
  async function sync(id: string) {
    if (disposed || !isRoot(id)) return
    const entry = tracking(id)
    for (const message of ctx.data.session.message.list(id)) {
      const sample = messageSample(message)
      if (sample) record(id, sample, false)
    }
    if (entry.loading) return entry.loading
    if (entry.loaded) return
    // One bounded history attempt per retained session. Failure degrades to
    // observed data instead of retrying on every streamed token/store update.
    entry.loaded = true
    const controller = new AbortController()
    entry.controller = controller
    entry.loading = withTimeout(
      async (signal) => {
        let cursor: string | undefined
        const seen = new Set<string>()
        do {
          const page = await ctx.client.message.list(
            {
              sessionID: id,
              limit: 200,
              ...(cursor ? { cursor } : { order: "asc" as const }),
            },
            { signal },
          )
          signal.throwIfAborted()
          if (disposed || sessions.get(id) !== entry) return
          for (const message of page.data) {
            const sample = messageSample(message)
            if (sample && !entry.samples.has(sample.partID))
              record(id, sample, false)
          }
          cursor = page.cursor.next ?? undefined
          if (cursor && seen.has(cursor))
            throw new Error("Repeated history cursor")
          if (cursor) seen.add(cursor)
        } while (cursor)
      },
      HISTORY_TIMEOUT_MS,
      { signal: controller.signal },
    )
      .catch(() => {
        if (!disposed && !controller.signal.aborted)
          ctx.ui.toast.show({
            variant: "warning",
            title: "Cache ratio",
            message:
              "Full cache history could not be loaded; showing observed requests only.",
          })
      })
      .finally(() => {
        entry.loading = undefined
      })
    return entry.loading
  }
  const unsubs = [
    ctx.data.on("session.step.started", ({ data }) => {
      if (disposed || !isRoot(data.sessionID)) return
      tracking(data.sessionID)
      starts.set(data.assistantMessageID, {
        sessionID: data.sessionID,
        sample: {
          partID: data.assistantMessageID,
          messageID: data.assistantMessageID,
          providerID: data.model.providerID,
          modelID: data.model.id,
          summary: false,
          startedAt: data.started,
        },
      })
    }),
    ctx.data.on("session.step.ended", ({ data, created }) => {
      const start = starts.get(data.assistantMessageID)
      starts.delete(data.assistantMessageID)
      const stored = ctx.data.session.message.get(
        data.sessionID,
        data.assistantMessageID,
      )
      const base = start?.sample ?? (stored && messageSample(stored))
      if (!base) {
        void sync(data.sessionID)
        return
      }
      record(
        data.sessionID,
        {
          ...base,
          observedAt: created,
          tokens: {
            input: data.tokens.input,
            output: data.tokens.output,
            reasoning: data.tokens.reasoning,
            cacheRead: data.tokens.cache.read,
            cacheWrite: data.tokens.cache.write,
          },
        },
        true,
      )
    }),
    ctx.data.on("session.step.failed", ({ data }) => {
      starts.delete(data.assistantMessageID)
    }),
    ctx.data.on("session.compaction.started", ({ id, created, data }) => {
      if (disposed || !isRoot(data.sessionID)) return
      tracking(data.sessionID)
      compactions.set(data.sessionID, {
        messageID: data.inputID ?? id.replace(/^evt_/, "msg_"),
        startedAt: created,
      })
    }),
    ctx.data.on("session.compaction.ended", ({ id, created, data }) => {
      const start = compactions.get(data.sessionID)
      compactions.delete(data.sessionID)
      // An unviewed session may have no message cache. The native event still
      // establishes a reset boundary, without waiting for a store echo.
      const messageID = start?.messageID ?? id.replace(/^evt_/, "msg_")
      record(
        data.sessionID,
        {
          partID: messageID,
          messageID,
          providerID: "",
          modelID: "",
          summary: true,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          startedAt: start?.startedAt ?? created,
          observedAt: created,
        },
        false,
      )
      void sync(data.sessionID)
    }),
    ctx.data.on("session.compaction.failed", ({ data }) => {
      compactions.delete(data.sessionID)
    }),
    ctx.data.on("session.revert.staged", () => changed()),
    ctx.data.on("session.revert.cleared", () => changed()),
    ctx.data.on("session.revert.committed", ({ data }) => {
      drop(data.sessionID)
      void sync(data.sessionID)
    }),
    ctx.data.on("session.deleted", ({ data }) => {
      drop(data.sessionID)
      changed()
    }),
  ]
  return {
    sync,
    samples,
    verdict: (id: string) => detectBreakSeries(samples(id), options),
    expiry: (id: string) => sessions.get(id)?.expiry,
    dispose() {
      disposed = true
      for (const stop of unsubs) stop()
      for (const timer of timers) clearTimeout(timer)
      for (const id of sessions.keys()) drop(id)
    },
  }
}

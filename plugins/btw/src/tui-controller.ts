import {
  every,
  mintMessageID,
  type tuiToast,
  withTimeout,
} from "@macarons/permission-rules"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import type { Accessor, Setter } from "solid-js"
import {
  discardSideQuestion,
  dispatchSidePrompt,
  LEASE_INTERVAL_MS,
  type Marker,
  markerFor,
  PROMPT_CONFIRM_DELAYS_MS,
  type PromptTarget,
  type resolveOptions,
  startSideQuestion,
  sweepOrphans,
  wrapQuestion,
} from "./shared"

type Api = Parameters<TuiPlugin>[0]
type Options = ReturnType<typeof resolveOptions>
type Toast = ReturnType<typeof tuiToast>

export type ExchangeStatus = "streaming" | "done" | "stopped" | "error"

export type Exchange = {
  question: string
  answer: string
  status: ExchangeStatus
  error?: string
}

export type Panel = {
  modelLabel: string
  exchanges: Exchange[]
  /** True between "asked" and the first streamed token, so we can show "Thinking…". */
  starting: boolean
}

export type PanelState = {
  panel: Accessor<Panel | null>
  setPanel: Setter<Panel | null>
}

// Live, non-reactive bookkeeping for the one fork currently backing the panel.
type Active = {
  sessionID: string
  directory: string
  /** Resolved with parent history so a literal "default" survives follow-ups. */
  target: PromptTarget
  /** The fork's marker as last written; heartbeats rewrite it with a fresh lease. */
  marker: Marker
  /** The fork's last copied message ID (fork-space — copies get fresh IDs). */
  boundary: string
  /** Assistant message ids seen for the fork (their text parts form the answers). */
  assistants: Set<string>
  /** Only messages above this watermark belong to the exchange now streaming. */
  watermark: string
  /** partID → current text of that text part (delta-built, reconciled by updates). */
  parts: Map<string, string>
  /** messageID for each part, to filter to assistant answers. */
  partMessage: Map<string, string>
  streaming: boolean
  adopted: boolean
  /** False while a promotion is unmarking the fork — beats must not re-mark it. */
  beating: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  heartbeat: ReturnType<typeof setInterval> | undefined
  /** Stable id of the initial or latest follow-up prompt. */
  promptMessageID: string | undefined
  /** User messages that may legitimately parent this exchange's answer. */
  promptUserMessageIDs: Set<string>
  /** False while a follow-up is being prepared, so prior late events are ignored. */
  acceptingPromptEvents: boolean
  /** Stopped/error runs can emit stale terminal events into their replacement. */
  terminalNeedsAssistant: boolean
  /** Set only when this controller aborts a run before observing its terminal event. */
  staleTerminalPossible: boolean
  /** Blocks reuse until the initial dispatch and late cancellation settle. */
  initialAdmissionPending: boolean
  /** Unlike a fast completion, cancellation requires a post-admission abort. */
  initialAdmissionCancelled: boolean
  /** Each unacknowledged abort could still arrive and stop replacement work. */
  abortsPending: number
  followUp?: {
    controller: AbortController
    cancelled: boolean
    /** An absent prompt and an idle snapshot cannot rule out delayed admission. */
    pendingAdmission: boolean
  }
}

// Mutable only so the direct TUI tests can shorten real timers.
export const timing = {
  leaseIntervalMs: LEASE_INTERVAL_MS,
  sweepIntervalMs: 60_000,
  promptConfirmDelaysMs: PROMPT_CONFIRM_DELAYS_MS as readonly number[],
}

function modelLabel(target: {
  model?: { providerID: string; modelID: string }
  variant?: string
}): string {
  if (!target.model) return "session model"
  const base = `${target.model.providerID}/${target.model.modelID}`
  return target.variant ? `${base} (${target.variant})` : base
}

/**
 * Owns the side-question fork and its rendered state. Rendering supplies the
 * panel opener after it has created the dialog stack, keeping host UI ordering
 * separate from session/event lifecycle work.
 */
export function createBtwController(
  api: Api,
  options: Options,
  toast: Toast,
  state: PanelState,
) {
  const directory = () => api.state.path.directory
  const { panel, setPanel } = state
  let active: Active | null = null
  let showPanel = () => {}
  let startGen = 0
  let startPending = false

  const setShowPanel = (show: () => void) => {
    showPanel = show
  }

  const clearTimer = () => {
    if (active?.timer) clearTimeout(active.timer)
    if (active) active.timer = undefined
  }

  const abortRun = async (state: Active) => {
    const attempt = state.followUp
    // A lookup has not dispatched any work. An unnecessary session-wide abort
    // could arrive after the next follow-up has already started.
    if (attempt && !state.promptMessageID) return true
    state.staleTerminalPossible = true
    state.abortsPending++
    const aborted = await withTimeout(
      (signal) =>
        api.client.session.abort(
          { sessionID: state.sessionID, directory: state.directory },
          { signal },
        ),
      options.timeoutMs,
    )
      .then((result) => result.error === undefined || result.error === null)
      .catch(() => false)
    if (aborted) state.abortsPending--
    return aborted
  }

  // Keep the owned fork's lease fresh. A beat racing release or promotion
  // clears its own marker again rather than leaving a sweepable session behind.
  const startHeartbeat = (state: Active) => {
    if (state.heartbeat) return
    state.heartbeat = every(() => {
      if (active !== state) {
        clearInterval(state.heartbeat)
        state.heartbeat = undefined
        return
      }
      if (!state.beating) return
      void (async () => {
        state.marker = { ...state.marker, lease: Date.now() }
        await api.client.session
          .update({
            sessionID: state.sessionID,
            directory: state.directory,
            metadata: markerFor(state.marker),
          })
          .catch(() => {})
        if (active !== state || !state.beating) {
          await api.client.session
            .update({
              sessionID: state.sessionID,
              directory: state.directory,
              metadata: {},
            })
            .catch(() => {})
        }
      })()
    }, timing.leaseIntervalMs)
  }

  // Release the current fork. Deletes it unless it was adopted or explicitly kept.
  const release = async () => {
    const current = active
    active = null
    if (!current) return
    if (current.timer) clearTimeout(current.timer)
    if (current.heartbeat) clearInterval(current.heartbeat)
    current.heartbeat = undefined
    if (current.followUp) {
      current.followUp.cancelled ||= current.streaming
      current.followUp.controller.abort()
    }
    if (current.adopted) return
    if (current.streaming) await abortRun(current)
    if (options.keepSessions) {
      const unmarked = await api.client.session
        .update({
          sessionID: current.sessionID,
          directory: current.directory,
          metadata: {},
        })
        .then((result) => result.error === undefined || result.error === null)
        .catch(() => false)
      if (!unmarked) {
        try {
          toast(
            "warning",
            "Could not unmark the kept side session — the next start's cleanup may delete it.",
          )
        } catch {
          // On shutdown the UI may already be gone.
        }
      }
      return
    }
    await discardSideQuestion(api.client, {
      directory: current.directory,
      sessionID: current.sessionID,
    })
  }

  const renderStreaming = () => {
    const state = active
    if (!state) return
    const partIDs = [...state.parts.keys()]
      .filter((partID) => {
        const messageID = state.partMessage.get(partID)
        return (
          messageID !== undefined &&
          messageID > state.watermark &&
          state.assistants.has(messageID)
        )
      })
      .sort()
    const answer = partIDs
      .map((partID) => state.parts.get(partID) ?? "")
      .join("")
      .trim()
    setPanel((prev) => {
      if (!prev?.exchanges.length) return prev
      const exchanges = prev.exchanges.slice()
      const last = exchanges[exchanges.length - 1]
      if (last?.status !== "streaming") return prev
      exchanges[exchanges.length - 1] = { ...last, answer }
      return {
        ...prev,
        exchanges,
        starting: prev.starting && answer.length === 0,
      }
    })
  }

  const finishStreaming = (
    status: "done" | "stopped" | "error",
    error?: string,
  ) => {
    if (active) {
      if (active.initialAdmissionPending && status !== "done")
        active.initialAdmissionCancelled = true
      active.streaming = false
      active.acceptingPromptEvents = false
      if (active.followUp) {
        if (
          status === "done" &&
          active.assistants.size > 0 &&
          !active.followUp.cancelled
        )
          active.followUp.pendingAdmission = false
        active.followUp.cancelled ||= status !== "done"
        active.followUp.controller.abort()
      }
    }
    clearTimer()
    setPanel((prev) => {
      if (!prev?.exchanges.length) return prev
      const exchanges = prev.exchanges.slice()
      const last = exchanges[exchanges.length - 1]
      if (last?.status !== "streaming") return prev
      const stoppedEmpty = status === "stopped" && !last.answer
      exchanges[exchanges.length - 1] = {
        ...last,
        status: stoppedEmpty ? "error" : status,
        error: stoppedEmpty ? "Stopped before an answer arrived." : error,
      }
      return { ...prev, exchanges, starting: false }
    })
    if (status === "done" && options.notify && !api.ui.dialog.open) {
      const last = panel()?.exchanges.at(-1)
      if (last?.answer)
        toast("info", "Side question answered — reopen it from the palette.")
    }
  }

  const armWatchdog = () => {
    clearTimer()
    const state = active
    if (!state) return
    const attempt = state.followUp
    state.timer = setTimeout(() => {
      if (active !== state || state.followUp !== attempt || !state.streaming)
        return
      void abortRun(state)
      const seconds = Math.round(options.timeoutMs / 1000)
      const phase =
        attempt && !state.promptMessageID
          ? "Follow-up session lookup"
          : attempt?.pendingAdmission
            ? "Follow-up admission"
            : undefined
      finishStreaming(
        "error",
        `${phase ? `${phase} timed out after ${seconds}s without progress.` : `No progress for ${seconds}s - timed out.`}${attempt?.pendingAdmission ? " Follow-up delivery may have been accepted; do not resend it." : ""}`,
      )
    }, options.timeoutMs)
  }

  // Route all stream and permission events through the active fork only.
  api.event.on("message.updated", (event) => {
    const { sessionID, info } = event.properties
    if (
      !active ||
      sessionID !== active.sessionID ||
      !active.acceptingPromptEvents
    )
      return
    if (
      info.role === "user" &&
      active.promptMessageID &&
      info.id > active.promptMessageID
    ) {
      // Auto-compaction creates a compaction user and then a replay/continue
      // user. The final answer is parented to one of those newer messages.
      active.promptUserMessageIDs.add(info.id)
      return
    }
    if (
      info.role === "assistant" &&
      info.summary !== true &&
      active.promptUserMessageIDs.has(info.parentID) &&
      info.id > active.boundary
    ) {
      // A current assistant proves any terminal burst from the locally aborted
      // predecessor is over, even if its final idle event was lost.
      active.staleTerminalPossible = false
      active.terminalNeedsAssistant = false
      active.assistants.add(info.id)
      if (active.streaming) armWatchdog()
      renderStreaming()
    }
  })

  api.event.on("message.part.updated", (event) => {
    const { sessionID, part } = event.properties
    if (
      !active ||
      sessionID !== active.sessionID ||
      !active.acceptingPromptEvents
    )
      return
    if (
      part.type !== "text" ||
      part.messageID <= active.boundary ||
      !active.assistants.has(part.messageID)
    )
      return
    active.partMessage.set(part.id, part.messageID)
    active.parts.set(part.id, part.text)
    if (active.streaming) armWatchdog()
    renderStreaming()
  })

  api.event.on("message.part.delta", (event) => {
    const { sessionID, messageID, partID, field, delta } = event.properties
    if (
      !active ||
      sessionID !== active.sessionID ||
      !active.acceptingPromptEvents
    )
      return
    if (
      field !== "text" ||
      messageID <= active.boundary ||
      !active.assistants.has(messageID)
    )
      return
    active.partMessage.set(partID, messageID)
    active.parts.set(partID, (active.parts.get(partID) ?? "") + delta)
    if (active.streaming) armWatchdog()
    renderStreaming()
  })

  const consumeExpectedStaleTerminal = (state: Active): boolean => {
    if (!state.staleTerminalPossible) return false
    if (
      state.streaming &&
      state.acceptingPromptEvents &&
      (!state.terminalNeedsAssistant || state.assistants.size > 0)
    )
      return false
    // Error/idle bursts are not correlated and may contain duplicate idles.
    // Only a current assistant can prove that this predecessor's burst is over.
    return true
  }

  api.event.on("session.idle", (event) => {
    if (!active || event.properties.sessionID !== active.sessionID) return
    if (consumeExpectedStaleTerminal(active)) return
    if (
      active.streaming &&
      active.acceptingPromptEvents &&
      (!active.terminalNeedsAssistant || active.assistants.size > 0)
    ) {
      active.staleTerminalPossible = false
      finishStreaming("done")
    }
  })

  api.event.on("permission.asked", (event) => {
    const { sessionID, id } = event.properties
    if (!active || sessionID !== active.sessionID) return
    void api.client.permission
      .reply({ requestID: id, reply: "reject", directory: active.directory })
      .catch(() => {})
  })

  api.event.on("permission.replied", (event) => {
    const { sessionID, reply } = event.properties
    if (!active || sessionID !== active.sessionID || reply === "reject") return
    void abortRun(active)
    finishStreaming(
      "error",
      "Stopped: something granted this read-only side question a gated tool.",
    )
  })

  api.event.on("session.error", (event) => {
    if (!active || event.properties.sessionID !== active.sessionID) return
    if (consumeExpectedStaleTerminal(active)) return
    const message = event.properties.error
    const detail =
      message && typeof message === "object" && "name" in message
        ? String((message as { name?: unknown }).name)
        : "error"
    if (
      active.streaming &&
      active.acceptingPromptEvents &&
      (!active.terminalNeedsAssistant || active.assistants.size > 0)
    ) {
      active.staleTerminalPossible = false
      finishStreaming("error", `The model reported an error (${detail}).`)
    }
  })

  const beginQuestion = async (parentID: string, question: string) => {
    const gen = ++startGen
    startPending = true
    await release()
    const dir = directory()
    setPanel({
      modelLabel: "…",
      exchanges: [{ question, answer: "", status: "streaming" }],
      starting: true,
    })
    showPanel()
    let installed: Active | undefined
    try {
      const started = await startSideQuestion(api.client, {
        directory: dir,
        parentID,
        question,
        options,
        onBeforePrompt: (prepared) => {
          if (gen !== startGen) throw new Error("side question cancelled")
          startPending = false
          active = {
            sessionID: prepared.sessionID,
            directory: dir,
            target: prepared.target,
            marker: prepared.marker,
            boundary: prepared.lastCopiedMessageID ?? "",
            assistants: new Set(),
            watermark: prepared.lastCopiedMessageID ?? "",
            parts: new Map(),
            partMessage: new Map(),
            streaming: true,
            adopted: false,
            beating: true,
            timer: undefined,
            heartbeat: undefined,
            promptMessageID: prepared.promptMessageID,
            promptUserMessageIDs: new Set(
              prepared.promptMessageID ? [prepared.promptMessageID] : [],
            ),
            acceptingPromptEvents: true,
            terminalNeedsAssistant: false,
            staleTerminalPossible: false,
            initialAdmissionPending: true,
            initialAdmissionCancelled: false,
            abortsPending: 0,
          }
          installed = active
          startHeartbeat(active)
          setPanel((prev) =>
            prev ? { ...prev, modelLabel: modelLabel(prepared.target) } : prev,
          )
          armWatchdog()
        },
        confirmDelaysMs: timing.promptConfirmDelaysMs,
      })
      if (
        gen !== startGen ||
        (installed &&
          (active !== installed || installed.initialAdmissionCancelled))
      ) {
        if (!installed)
          await discardSideQuestion(api.client, {
            directory: dir,
            sessionID: started.sessionID,
          })
        else await abortRun(installed)
        return
      }
      if (!started.hasContext) {
        startPending = false
        await discardSideQuestion(api.client, {
          directory: dir,
          sessionID: started.sessionID,
        })
        setPanel(null)
        api.ui.dialog.clear()
        toast(
          "info",
          "This session has no conversation yet — ask once it has replied at least once.",
        )
        return
      }
      if (started.promptOutcome === "ambiguous")
        toast(
          "warning",
          "Side-question delivery could not be confirmed. It may have been accepted; do not resend it.",
        )
    } catch (error) {
      if (gen !== startGen) return
      startPending = false
      clearTimer()
      if (active?.heartbeat) clearInterval(active.heartbeat)
      active = null
      finishStreaming(
        "error",
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      if (installed) installed.initialAdmissionPending = false
    }
  }

  const maxMessageID = (state: Active): string | undefined => {
    let max: string | undefined
    for (const messageID of state.partMessage.values())
      if (max === undefined || messageID > max) max = messageID
    for (const messageID of state.assistants)
      if (max === undefined || messageID > max) max = messageID
    return max
  }

  const settlingMessage =
    "Side question is still settling. Wait before following up or opening it as a session."

  const canReuse = () => {
    if (
      !active?.initialAdmissionPending &&
      !active?.abortsPending &&
      !active?.followUp?.pendingAdmission
    )
      return true
    toast("info", settlingMessage)
    return false
  }

  const askFollowUp = async (question: string) => {
    const state = active
    if (!state || !canFollowUp()) {
      toast(
        "warning",
        followUpPending()
          ? "Follow-up not sent: delivery or cancellation is still unconfirmed."
          : state?.streaming
            ? "Follow-up not sent: the side thread is still answering."
            : "Follow-up not sent: the side thread is no longer available.",
      )
      return
    }
    if (!canReuse()) return
    const attempt = {
      controller: new AbortController(),
      cancelled: false,
      pendingAdmission: false,
    }
    state.followUp = attempt
    state.promptMessageID = undefined
    state.promptUserMessageIDs.clear()
    state.acceptingPromptEvents = false
    state.terminalNeedsAssistant = state.staleTerminalPossible
    state.watermark = maxMessageID(state) ?? state.boundary
    state.assistants.clear()
    state.streaming = true
    setPanel((prev) =>
      prev
        ? {
            ...prev,
            starting: true,
            exchanges: [
              ...prev.exchanges,
              { question, answer: "", status: "streaming" },
            ],
          }
        : prev,
    )
    armWatchdog()
    const signal = attempt.controller.signal
    const stale = () =>
      active !== state ||
      state.followUp !== attempt ||
      !state.streaming ||
      signal.aborted
    // The watchdog owns the progress deadline. Race its cancellation as well
    // as forwarding it: some transports never settle even after abort.
    const stopped = Promise.withResolvers<void>()
    const stop = () => stopped.resolve()
    signal.addEventListener("abort", stop, { once: true })
    try {
      await Promise.race([
        (async () => {
          const current = await api.client.session.get(
            { sessionID: state.sessionID, directory: state.directory },
            { signal },
          )
          if (stale()) return
          if (current.error) throw new Error(JSON.stringify(current.error))
          const messageID = mintMessageID()
          state.promptMessageID = messageID
          state.promptUserMessageIDs.add(messageID)
          state.acceptingPromptEvents = true
          attempt.pendingAdmission = true
          const outcome = await dispatchSidePrompt(api.client, {
            sessionID: state.sessionID,
            directory: state.directory,
            target: state.target,
            messageID,
            text: wrapQuestion(question, options.tools),
            confirmDelaysMs: timing.promptConfirmDelaysMs,
            signal,
          })
          // Keep observing the original dispatch after our wait is cancelled:
          // the first session abort may have beaten admission. Do not reuse
          // this fork until both admission and its compensating abort settle.
          if (
            attempt.cancelled &&
            !state.adopted &&
            (active !== state || state.followUp === attempt)
          ) {
            const aborted = await abortRun(state)
            if (aborted && outcome === "accepted")
              attempt.pendingAdmission = false
            return
          }
          if (outcome === "accepted") attempt.pendingAdmission = false
          if (stale()) return
          if (outcome === "ambiguous")
            toast(
              "warning",
              "Follow-up delivery could not be confirmed. It may have been accepted; do not resend it.",
            )
        })(),
        stopped.promise,
      ])
    } catch (error) {
      if (stale()) return
      attempt.pendingAdmission = false
      finishStreaming(
        "error",
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      signal.removeEventListener("abort", stop)
    }
  }

  const onPanelDismiss = () => {
    if (active?.streaming) {
      void abortRun(active)
      finishStreaming("stopped")
      return
    }
    if (startPending) {
      startGen++
      startPending = false
      setPanel(null)
    }
  }

  const followUpPending = () =>
    Boolean(
      active?.followUp &&
        (active.followUp.pendingAdmission || active.abortsPending),
    )

  const canFollowUp = () =>
    Boolean(active && !active.streaming && !followUpPending())

  const runOpen = async () => {
    if (!active || !panel()) return
    const state = active
    const { sessionID, directory: dir } = state
    const pending = () =>
      state.initialAdmissionPending ||
      state.followUp?.pendingAdmission ||
      state.abortsPending
    const pendingMessage = state.followUp
      ? "Follow-up admission or cancellation is still unconfirmed. Opening this session is blocked and may remain unavailable."
      : settlingMessage
    if (pending()) {
      toast(state.followUp ? "warning" : "info", pendingMessage)
      return
    }
    state.beating = false
    try {
      const result = await api.client.session.update({
        sessionID,
        directory: dir,
        metadata: {},
        title: panel()?.exchanges[0]?.question ?? "Side question",
      })
      if (result.error) throw new Error(JSON.stringify(result.error))
      if (active !== state) return
      if (pending()) {
        // A dismissal can race the unmark request. Keep the fork guarded and
        // owned until its session-wide abort can no longer hit promoted work.
        try {
          await api.client.session.update({
            sessionID,
            directory: dir,
            metadata: markerFor(state.marker),
          })
        } finally {
          if (active !== state)
            await api.client.session
              .update({ sessionID, directory: dir, metadata: {} })
              .catch(() => {})
        }
        throw new Error(pendingMessage)
      }
      state.adopted = true
      clearTimer()
      state.followUp?.controller.abort()
      if (state.heartbeat) clearInterval(state.heartbeat)
      state.heartbeat = undefined
      active = null
      api.ui.dialog.clear()
      setPanel(null)
      api.route.navigate("session", { sessionID })
      toast("success", "Side question promoted to a full session.")
    } catch (error) {
      state.beating = true
      toast(
        "error",
        `Could not open as a session: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const runCopy = () => {
    if (!panel()) return
    const last = panel()?.exchanges.at(-1)
    if (!last?.answer) {
      toast("info", "Nothing to copy yet.")
      return
    }
    try {
      const copied = api.renderer.copyToClipboardOSC52(last.answer)
      toast(
        copied ? "success" : "warning",
        copied ? "Answer copied." : "Clipboard not available in this terminal.",
      )
    } catch {
      toast("warning", "Clipboard not available in this terminal.")
    }
  }

  const runReopen = () => {
    if (!panel()) {
      toast("info", "No recent side question to reopen.")
      return
    }
    showPanel()
  }

  const sweep = () =>
    void sweepOrphans(api.client, directory(), Date.now()).catch(() => {})
  let sweeper: ReturnType<typeof setInterval> | undefined

  const startLifecycle = () => {
    sweep()
    sweeper = every(sweep, timing.sweepIntervalMs)
  }

  const dispose = async () => {
    if (sweeper) clearInterval(sweeper)
    startGen++
    startPending = false
    await release()
  }

  return {
    askFollowUp,
    beginQuestion,
    canFollowUp,
    canReuse,
    dispose,
    followUpPending,
    onPanelDismiss,
    panel,
    runCopy,
    runOpen,
    runReopen,
    setShowPanel,
    startLifecycle,
  }
}

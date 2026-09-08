import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { SyntaxStyle } from "@opentui/core"
import type { For, Show } from "solid-js"
import { replaceLargeDialog } from "./shared"
import type { createBtwController } from "./tui-controller"

type Api = Parameters<TuiPlugin>[0]
type Controller = ReturnType<typeof createBtwController>
type SolidComponents = { For: typeof For; Show: typeof Show }

function firstKey(keybind: string | undefined): string | undefined {
  return keybind?.split(",")[0]?.trim() || undefined
}

/** Owns all host dialog replacement ordering and BTW panel rendering. */
export function createBtwDialogs(input: {
  api: Api
  controller: Controller
  keybind: string | undefined
  openKeybind: string | undefined
  copyKeybind: string | undefined
  solid: SolidComponents
  toast: (
    variant: "info" | "success" | "warning" | "error",
    message: string,
  ) => void
}) {
  const { api, controller, toast } = input
  const { For, Show } = input.solid
  const askKey = firstKey(input.keybind)
  const openKey = firstKey(input.openKeybind)
  const copyKey = firstKey(input.copyKeybind)
  const theme = () => api.theme.current
  let selfReplace = false
  let panelRestorePending = false
  let syntaxStyle: SyntaxStyle | undefined

  const replaceDialog = (
    render: () => unknown,
    onClose: () => void,
    large = false,
  ) => {
    selfReplace = true
    try {
      if (large) replaceLargeDialog(api, render, onClose)
      else api.ui.dialog.replace(render, onClose)
    } finally {
      selfReplace = false
    }
  }

  const markdownSyntax = () => {
    if (!syntaxStyle) syntaxStyle = SyntaxStyle.create()
    return syntaxStyle
  }

  const askDescription = () => (
    <box flexDirection="column">
      <text fg={theme().textMuted}>
        Answered from the conversation so far. Nothing is added to it; your task
        keeps running.
      </text>
      <Show when={askKey}>
        <text fg={theme().textMuted}>
          Reopen this anytime with{" "}
          <span style={{ fg: theme().text }}>{askKey}</span>.
        </text>
      </Show>
    </box>
  )

  const answerFooter = (streaming: boolean) => (
    <box flexDirection="row" flexWrap="wrap" paddingTop={1}>
      <For
        each={[
          streaming
            ? { key: "esc", label: "stop & close" }
            : { key: "esc", label: "close" },
          ...(!streaming && askKey ? [{ key: askKey, label: "ask" }] : []),
          ...(openKey ? [{ key: openKey, label: "open as session" }] : []),
          ...(copyKey ? [{ key: copyKey, label: "copy" }] : []),
        ]}
      >
        {(hint) => (
          <text>
            <span style={{ fg: theme().text }}>{hint.key}</span>
            <span style={{ fg: theme().textMuted }}>
              {" "}
              {hint.label}
              {"   "}
            </span>
          </text>
        )}
      </For>
    </box>
  )

  const answerBody = () => {
    const state = controller.panel()
    if (!state) return null
    return (
      <box flexDirection="column" flexGrow={1}>
        <box flexDirection="row" paddingBottom={1}>
          <text fg={theme().textMuted}>BTW · {state.modelLabel}</text>
        </box>
        <scrollbox flexGrow={1}>
          <For each={state.exchanges}>
            {(exchange, index) => (
              <box flexDirection="column" paddingBottom={1}>
                <Show when={state.exchanges.length > 1}>
                  <text fg={theme().textMuted}>
                    <span style={{ fg: theme().text }}>Q{index() + 1}.</span>{" "}
                    {exchange.question}
                  </text>
                </Show>
                <Show
                  when={exchange.answer || exchange.status !== "streaming"}
                  fallback={
                    <text fg={theme().textMuted}>
                      {state.starting ? "Thinking…" : "…"}
                    </text>
                  }
                >
                  <Show
                    when={exchange.status !== "error"}
                    fallback={
                      <text fg={theme().error ?? theme().text}>
                        {exchange.error ?? "Something went wrong."}
                      </text>
                    }
                  >
                    <markdown
                      content={exchange.answer || "…"}
                      streaming={exchange.status === "streaming"}
                      syntaxStyle={markdownSyntax()}
                      fg={theme().markdownText}
                    />
                    <Show when={exchange.status === "stopped"}>
                      <text fg={theme().textMuted}>— stopped</text>
                    </Show>
                  </Show>
                </Show>
              </box>
            )}
          </For>
        </scrollbox>
        {answerFooter(state.exchanges.at(-1)?.status === "streaming")}
      </box>
    )
  }

  const showPanel = () => {
    replaceDialog(
      () => (
        <box
          flexDirection="column"
          flexGrow={1}
          paddingLeft={1}
          paddingRight={1}
        >
          {answerBody()}
        </box>
      ),
      controller.onPanelDismiss,
      true,
    )
  }

  const restorePanelOnDismiss = () => {
    if (selfReplace || panelRestorePending) return
    panelRestorePending = true
    queueMicrotask(() => {
      panelRestorePending = false
      showPanel()
    })
  }

  const sessionRoute = (): string | undefined => {
    const route = api.route.current
    if (route.name !== "session") return undefined
    const params =
      "params" in route
        ? (route.params as Record<string, unknown> | undefined)
        : undefined
    return typeof params?.sessionID === "string" ? params.sessionID : undefined
  }

  const openQuestionDialog = () => {
    replaceDialog(
      () =>
        api.ui.DialogPrompt({
          title: "BTW",
          description: askDescription,
          placeholder: "e.g. why did we pick exponential backoff here?",
          onConfirm: (text) => {
            const question = text.trim()
            const parentID = sessionRoute()
            if (!question) {
              api.ui.dialog.clear()
              return
            }
            if (!parentID) {
              api.ui.dialog.clear()
              toast(
                "info",
                "Open a session first — a side question needs a conversation to look at.",
              )
              return
            }
            void controller.beginQuestion(parentID, question)
          },
          onCancel: () => api.ui.dialog.clear(),
        }),
      () => {},
    )
  }

  const openFollowUpDialog = () => {
    replaceDialog(
      () =>
        api.ui.DialogPrompt({
          title: "Ask a follow-up",
          description: askDescription,
          placeholder: "continue the side thread…",
          onConfirm: (text) => {
            const question = text.trim()
            showPanel()
            if (question) void controller.askFollowUp(question)
          },
          onCancel: restorePanelOnDismiss,
        }),
      restorePanelOnDismiss,
    )
  }

  const runAsk = () => {
    if (api.ui.dialog.open && controller.canFollowUp()) {
      if (controller.canReuse()) openFollowUpDialog()
      return
    }
    if (controller.followUpPending())
      toast(
        "warning",
        "Follow-up delivery or cancellation is unconfirmed. Confirming a new side question will replace this thread.",
      )
    openQuestionDialog()
  }

  controller.setShowPanel(showPanel)
  return { runAsk }
}

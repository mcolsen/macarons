import {
  createUsageLimitsEngine,
  createUsageLimitsViewModel,
  formatReset,
} from "@macarons/usage-limits"
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"

export const tui = Plugin.define({
  id: "macarons.synthetic-limits",
  setup(api) {
    const engine = createUsageLimitsEngine({
      api,
      providerID: "synthetic",
      createSignal,
    })
    function View(props: { sessionID: string }) {
      const view = createUsageLimitsViewModel({
        api,
        engine,
        providerID: "synthetic",
        sessionID: props.sessionID,
        createMemo,
        createEffect,
      })
      return (
        <Show when={view.rows().length > 0}>
          <box gap={1}>
            <text fg={api.theme.text.base}>
              <b>Synthetic Limits</b>
              {view.classifier() ? (
                <span style={{ fg: api.theme.text.muted }}> · classifier</span>
              ) : (
                ""
              )}
            </text>
            <For each={view.rows()}>
              {(window) => (
                <text fg={api.theme.text.muted}>
                  <span
                    style={{ fg: view.percentColor(window.usedPercent) }}
                  >{`${window.label} ${100 - window.usedPercent}% left`}</span>
                  {window.resetsAt === undefined
                    ? ""
                    : ` · ${window.resetVerb ?? "resets"} ${formatReset(window.resetsAt, Date.now())}`}
                </text>
              )}
            </For>
          </box>
        </Show>
      )
    }
    const remove = api.ui.slot({
      append: "sidebar.content",
      render: (props) => <View sessionID={props.sessionID} />,
    })
    return () => {
      engine.dispose()
      remove()
    }
  },
})
export default tui

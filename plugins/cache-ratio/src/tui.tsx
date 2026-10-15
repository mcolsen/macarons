import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { formatPercent, formatTokens, ratioSnapshot } from "./core"
import { createCacheEngine } from "./engine"

export default Plugin.define({
  id: "cache-ratio",
  setup(ctx) {
    const [revision, refresh] = createSignal(0)
    const engine = createCacheEngine(ctx, () => refresh((value) => value + 1))
    createEffect(() => {
      const route = ctx.ui.router.current()
      if (route.type === "session") {
        ctx.data.session.message.list(route.sessionID)
        void engine.sync(route.sessionID)
      }
    })
    const release = ctx.ui.slot({
      append: "sidebar.content",
      render(props) {
        const samples = createMemo(() => {
          revision()
          return engine.samples(props.sessionID)
        })
        const snapshot = createMemo(() =>
          ratioSnapshot(samples().filter((sample) => !sample.summary)),
        )
        const verdict = createMemo(() => {
          revision()
          return engine.verdict(props.sessionID)
        })
        const expiry = createMemo(() => {
          revision()
          return engine.expiry(props.sessionID)
        })
        return (
          <Show
            when={
              !ctx.data.session.get(props.sessionID)?.parentID &&
              snapshot().steps > 0
            }
          >
            <box>
              <text fg={ctx.theme.text.base}>
                <b>Cache health</b>
              </text>
              <text
                fg={ctx.theme.text.muted}
              >{`hit ${formatPercent(snapshot().session ?? 0)} · last ${formatPercent(snapshot().last ?? 0)}`}</text>
              <Show when={verdict()?.kind === "break"}>
                <text fg={ctx.theme.text.feedback.error.base}>
                  Prompt-cache prefix may have changed
                </text>
              </Show>
              <Show when={expiry()}>
                <text
                  fg={ctx.theme.text.muted}
                >{`cache expired: re-paid ${formatTokens(expiry()?.lostTokens ?? 0)}`}</text>
              </Show>
            </box>
          </Show>
        )
      },
    })
    return () => {
      release()
      engine.dispose()
    }
  },
})

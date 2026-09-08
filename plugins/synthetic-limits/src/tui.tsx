import {
  type ClassifierConfig,
  resolveClassifierConfig,
} from "@macarons/approve-for-me/interop"
import {
  createUsageLimitsEngine,
  createUsageLimitsViewModel,
  formatReset,
} from "@macarons/usage-limits"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { syntheticModule } from "./synthetic"

/** Shows Synthetic five-hour and weekly quotas for the session or classifier. */
export const tui: TuiPlugin = async (api, options) => {
  const engine = createUsageLimitsEngine({
    api,
    options,
    modules: [syntheticModule],
    label: "Synthetic limits",
    service: "synthetic-limits",
    createSignal,
    resolveClassifier: (paths) =>
      resolveClassifierConfig({
        api,
        directory: paths.directory,
        worktree: paths.worktree,
        configDir: paths.configDir,
        stateDir: paths.stateDir,
      }) as Promise<ClassifierConfig | undefined>,
  })
  if (!engine) return
  const activeEngine = engine

  function View(props: { api: TuiPluginApi; session_id: string }) {
    const view = createUsageLimitsViewModel({
      api: props.api,
      engine: activeEngine,
      sessionID: props.session_id,
      createMemo,
      createEffect,
    })

    return (
      <Show when={view.rendered().length > 0}>
        <box gap={1}>
          <For each={view.rendered()}>
            {(section) => (
              <box>
                <text fg={view.theme().text}>
                  <b>{section.module.title}</b>
                  {section.classifier ? (
                    <span style={{ fg: view.theme().textMuted }}>
                      {" · classifier"}
                    </span>
                  ) : (
                    ""
                  )}
                </text>
                <For each={section.rows}>
                  {(window) => (
                    <text fg={view.theme().textMuted}>
                      <span
                        style={{ fg: view.percentColor(window.usedPercent) }}
                      >
                        {`${window.label} ${100 - window.usedPercent}% left`}
                      </span>
                      {window.resetsAt === undefined
                        ? ""
                        : ` · ${window.resetVerb ?? "resets"} ${formatReset(window.resetsAt, Date.now())}`}
                    </text>
                  )}
                </For>
              </box>
            )}
          </For>
        </box>
      </Show>
    )
  }

  api.slots.register({
    order: 152,
    slots: {
      sidebar_content: (_ctx, props) => (
        <View api={api} session_id={props.session_id} />
      ),
    },
  })
}

const plugin: TuiPluginModule = {
  id: "opencode-synthetic-limits",
  tui,
}

export default plugin

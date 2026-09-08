import { makeTuiApi } from "@macarons/plugin-test-harness/tui"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { SYNC_COMMAND } from "../src/shared"
import { tui } from "../src/tui"

type Api = Parameters<TuiPlugin>[0]

/**
 * background-tasks' api mock — the shared core plus what this plugin's entry
 * actually reads: the dialog stack (list → actions → confirm renders,
 * re-invokable via lastDialog), the OSC52 clipboard hook, per-session parent
 * links for the sub-agent suppression, and the server's post-write poke.
 * Shared by the engine tests (tui.test.ts) and the rendering tests
 * (view.test.tsx), which used to carry two divergent copies.
 */
export function makeApi(
  input: {
    version?: string | null
    baseUrl?: string
    paths?: {
      state: string
      config: string
      worktree: string
      directory: string
    }
    sessionParents?: Record<string, string>
    options?: Record<string, unknown>
  } = {},
) {
  const base = makeTuiApi(input)
  const parents = input.sessionParents
  if (parents) {
    base.api.state.session = {
      get: (sessionID: string) => ({
        id: sessionID,
        parentID: parents[sessionID],
      }),
    }
  }

  // Dialog stack: replace() pushes the render thunk, clear() pushes a null
  // render. lastDialog() re-invokes the TOP thunk, so tests read the current
  // dialog contents fresh without forcing another open (the thunks close over
  // live signals).
  const dialogs: Array<() => unknown> = []
  base.api.ui.dialog = {
    replace: (render: () => unknown, _onClose?: () => void) => {
      dialogs.push(render)
    },
    clear: () => {
      dialogs.push(() => null)
    },
    setSize: () => {},
    size: "medium",
    depth: 0,
    open: false,
  }
  base.api.ui.DialogSelect = (props: unknown) => props
  base.api.ui.DialogConfirm = (props: unknown) => props
  base.api.ui.DialogPrompt = (props: unknown) => props

  const copied: string[] = []
  Object.assign(base.api, {
    renderer: {
      copyToClipboardOSC52: (text: string) => {
        copied.push(text)
        return true
      },
    },
  })

  // The dialog flows navigate with (name, params); recording that shape keeps
  // the assertions readable (the core records raw argument arrays).
  const navigations: Array<{
    name: string
    params?: Record<string, unknown>
  }> = []
  base.api.route.navigate = (
    name: string,
    params?: Record<string, unknown>,
  ) => {
    navigations.push({ name, params })
  }

  const load = (options = input.options) =>
    tui(base.api as unknown as Api, options, {} as never)
  const listCommand = () =>
    base.layers
      .flatMap((layer) => layer.commands ?? [])
      .find((command: any) => command.name === "background_tasks.list")
  // The server's post-write poke, delivered over the plugin event bus. The
  // load-time sync races a test's freshly planted state files; the poke is the
  // real, deterministic "the file changed, re-read it" signal.
  const poke = () => base.emit("tui.command.execute", { command: SYNC_COMMAND })
  const lastDialog = () => dialogs.at(-1)?.() as any

  return {
    ...base,
    navigations,
    dialogs,
    copied,
    load,
    listCommand,
    poke,
    lastDialog,
  }
}

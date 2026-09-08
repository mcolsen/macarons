import { tuiToast } from "@macarons/permission-rules"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import { resolveOptions, tuiGate } from "./shared"
import { registerBtwCommands } from "./tui-commands"
import { createBtwController, type Panel, timing } from "./tui-controller"
import { createBtwDialogs } from "./tui-dialog"

export { timing }

/** BTW's TUI assembly: gate the host, then connect controller, dialogs, and commands. */
export const tui: TuiPlugin = async (api, rawOptions) => {
  // No remote bail: side-question sessions live on the server reached by the SDK.
  if (
    tuiGate(api, { label: "btw", service: "btw", remoteBails: false }).disabled
  )
    return

  const options = resolveOptions(rawOptions)
  const toast = tuiToast(api)
  const [panel, setPanel] = createSignal<Panel | null>(null)
  const controller = createBtwController(api, options, toast, {
    panel,
    setPanel,
  })
  const dialogs = createBtwDialogs({
    api,
    controller,
    keybind: options.keybind,
    openKeybind: options.openKeybind,
    copyKeybind: options.copyKeybind,
    solid: { For, Show },
    toast,
  })

  registerBtwCommands({
    api,
    keybind: options.keybind,
    openKeybind: options.openKeybind,
    copyKeybind: options.copyKeybind,
    runAsk: dialogs.runAsk,
    runOpen: controller.runOpen,
    runCopy: controller.runCopy,
    runReopen: controller.runReopen,
  })

  controller.startLifecycle()
  api.lifecycle.onDispose(controller.dispose)
}

const plugin: TuiPluginModule = {
  id: "opencode-btw",
  tui,
}

export default plugin

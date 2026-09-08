import type { TuiPlugin } from "@opencode-ai/plugin/tui"

type Api = Parameters<TuiPlugin>[0]

const ASK = "btw.ask"
const OPEN = "btw.open"
const COPY = "btw.copy"
const REOPEN = "btw.reopen"
const CATEGORY = "BTW"

/** Registers BTW's unchanged palette commands and optional user-configured keys. */
export function registerBtwCommands(input: {
  api: Api
  keybind: string | undefined
  openKeybind: string | undefined
  copyKeybind: string | undefined
  runAsk: () => void
  runOpen: () => Promise<void>
  runCopy: () => void
  runReopen: () => void
}) {
  const { api } = input
  api.keymap.registerLayer({
    commands: [
      {
        name: ASK,
        title: "BTW",
        desc: "Ask about the conversation without adding to it",
        category: CATEGORY,
        namespace: "palette",
        run: input.runAsk,
      },
      {
        name: OPEN,
        title: "Open side answer as a session",
        category: CATEGORY,
        namespace: "palette",
        run: () => void input.runOpen(),
      },
      {
        name: COPY,
        title: "Copy side answer",
        category: CATEGORY,
        namespace: "palette",
        run: input.runCopy,
      },
      {
        name: REOPEN,
        title: "Reopen last side answer",
        category: CATEGORY,
        namespace: "palette",
        run: input.runReopen,
      },
    ],
    bindings: [
      ...(input.keybind
        ? [
            {
              key: input.keybind,
              cmd: ASK,
              desc: "Ask a side question",
              group: CATEGORY,
            },
          ]
        : []),
      ...(input.openKeybind
        ? [
            {
              key: input.openKeybind,
              cmd: OPEN,
              desc: "Open side answer as a session",
              group: CATEGORY,
            },
          ]
        : []),
      ...(input.copyKeybind
        ? [
            {
              key: input.copyKeybind,
              cmd: COPY,
              desc: "Copy side answer",
              group: CATEGORY,
            },
          ]
        : []),
    ],
  })
}

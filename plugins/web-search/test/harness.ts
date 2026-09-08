import { makeTuiApi } from "@macarons/plugin-test-harness/tui"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { SYNC_COMMAND } from "../src/searches"
import { tui } from "../src/tui"

type Api = Parameters<TuiPlugin>[0]

/**
 * web-search's api mock — the shared core plus what this plugin's entry
 * actually reads: the state.path sandbox the sync reads its searches file
 * from, per-session parent links for the sub-agent suppression, and the
 * server's post-write poke. Shared by the engine tests (tui.test.ts) and the
 * rendering tests (view.test.tsx), which used to carry two divergent copies.
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

  const load = (options = input.options) =>
    tui(base.api as unknown as Api, options, {} as never)
  const commands = () => base.layers.flatMap((layer) => layer.commands ?? [])
  // The server's post-write poke, delivered over the plugin event bus. The
  // load-time sync races a test's freshly planted state file; the poke is the
  // real, deterministic "the file changed, re-read it" signal.
  const poke = () => base.emit("tui.command.execute", { command: SYNC_COMMAND })

  return { ...base, load, commands, poke }
}

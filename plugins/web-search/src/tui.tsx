import fs from "node:fs/promises"
import {
  every,
  isSubAgentSession,
  resolvePathsOnce,
  routeSessionID,
  singleFlight,
  tuiGate,
  unrefTimer,
} from "@macarons/permission-rules"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import {
  loadSearchesFile,
  resolveSearchesPath,
  resolveTuiOptions,
  SERVICE,
  type SearchesFile,
  type SearchesPaths,
  type SearchRecord,
  SYNC_COMMAND,
  searchGlyph,
  searchLabel,
  truncateLabel,
} from "./searches"

/**
 * @macarons/web-search — TUI companion
 *
 * A transient sidebar section listing the viewed session's recent web
 * searches: the query, the backend each ran against, and its status
 * (pending → running → complete/error). A search appears the moment it is
 * issued and, once it finishes, lingers for `visibleMs` (10s by default) before
 * disappearing — so the section is empty whenever nothing has searched lately.
 *
 * The server half (src/index.ts) owns the state file this half only reads; see
 * src/searches.ts for the contract. Updates arrive by poke (the server
 * publishes a `tui.command.execute` for SYNC_COMMAND after each state write)
 * with a slow mtime-gated poll as the fallback, so a missed poke costs
 * staleness, never correctness. This half writes nothing and shows no toasts —
 * it is pure display.
 *
 * The state file names searches on the SERVER's machine, so a remote attach
 * (which cannot read that machine's files) disables the sidebar entirely, as in
 * background-tasks. Targets OpenCode v1: warns outside the verified band,
 * disables only on OpenCode v2+.
 */

const SIDEBAR_LIMIT = 5
const SIDEBAR_QUERY_CHARS = 24
const POKE_DEBOUNCE_MS = 100

export const tui: TuiPlugin = async (api, rawOptions) => {
  // The state file describes searches on the SERVER's machine. In-process and
  // loopback attaches are this machine; a remote attach (or an unidentifiable
  // transport) makes the file meaningless, so stay out of the way entirely.
  if (
    tuiGate(api, { label: "Web Search", service: SERVICE, remoteBails: true })
      .disabled
  )
    return

  const options = resolveTuiOptions(rawOptions)
  if (!options.sidebar) return

  const theme = () => api.theme.current

  // All reactive state lives HERE, in the entry module: the host substitutes
  // its own solid-js for this module only, and signals created anywhere else
  // hold values but never notify the UI.
  const [searchesFile, setSearchesFile] = createSignal<
    SearchesFile | undefined
  >()
  const [now, setNow] = createSignal(Date.now())

  // Resolved once the host's path sync lands, then cached; see
  // resolvePathsOnce for why resolving against the placeholders would latch a
  // wrong path for the TUI's lifetime.
  const resolveStatePathOnce = resolvePathsOnce<SearchesPaths>(
    api,
    ({ projectRoot, state }) => resolveSearchesPath(projectRoot, state),
    { require: ["state"] },
  )

  // Single-flight, mtime-gated read of the state file. A poke or poll landing
  // mid-read queues exactly one follow-up, so bursts collapse to two reads.
  // The gate keys by (file, mtime): a server half from the previous release
  // writes only the pre-slug name, so a missing readable file falls back to
  // it before concluding no server is running.
  let lastRead = ""
  const sync = singleFlight(
    async (force: boolean): Promise<void> => {
      const paths = await resolveStatePathOnce()
      if (!paths) return
      let file = paths.stateFile
      let stat = await fs.stat(file).catch(() => undefined)
      if (!stat) {
        file = paths.preSlugStateFile
        stat = await fs.stat(file).catch(() => undefined)
      }
      if (!stat) {
        // Missing files: no server half running (or it disposed) — no searches.
        lastRead = ""
        setSearchesFile(undefined)
        return
      }
      const read = `${file}:${stat.mtimeMs}`
      if (!force && read === lastRead) return
      lastRead = read
      setSearchesFile(await loadSearchesFile(file))
    },
    { followUp: [true] },
  )

  // Trailing-debounced poke target: a burst of state writes → one read.
  let pokeTimer: ReturnType<typeof setTimeout> | undefined
  const pokeSync = () => {
    if (pokeTimer) return
    pokeTimer = unrefTimer(
      setTimeout(() => {
        pokeTimer = undefined
        void sync(true)
      }, POKE_DEBOUNCE_MS),
    )
  }

  // The server's poke arrives as a `tui.command.execute` for SYNC_COMMAND.
  // Consumed two redundant ways — the plugin event bus, and a registered
  // (non-palette, so invisible) command in case the host routes the event
  // through the keymap dispatcher instead. Whichever fires, pokeSync debounces
  // the duplicates away.
  const unsubscribePoke = api.event.on("tui.command.execute", (event) => {
    if (event.properties.command === SYNC_COMMAND) pokeSync()
  })
  api.keymap.registerLayer({
    commands: [{ name: SYNC_COMMAND, run: () => pokeSync() }],
  })

  void sync(false)
  const poller = every(() => void sync(false), options.pollMs)

  // The rows visible for a given session at `now`: live searches always, ended
  // ones only inside the transient window.
  const rowsFor = (sessionID: string | undefined): SearchRecord[] => {
    const file = searchesFile()
    if (!file || sessionID === undefined) return []
    return file.searches.filter((record) => {
      if (record.sessionID !== sessionID) return false
      if (record.endedAt === undefined) return true
      return record.endedAt + options.visibleMs > now()
    })
  }

  // 1s ticker so the transient window and the running elapsed advance without a
  // state write. It short-circuits to zero signal churn whenever the viewed
  // session has nothing left to show or count down.
  const ticker = every(() => {
    if (rowsFor(routeSessionID(api)).length > 0) setNow(Date.now())
  }, 1_000)

  // ---- sidebar widget ------------------------------------------------------

  function View(props: { session_id: string }) {
    // Sub-agent sessions never show a sidebar of their own.
    const rows = createMemo(() =>
      isSubAgentSession(api, props.session_id) ? [] : rowsFor(props.session_id),
    )
    const shown = () => rows().slice(0, SIDEBAR_LIMIT)
    const stateColor = (record: SearchRecord) => {
      if (record.state === "pending") return theme().textMuted
      if (record.state === "running") return theme().warning
      if (record.state === "error") return theme().error
      return theme().success
    }
    return (
      <Show when={rows().length > 0}>
        <box>
          <text fg={theme().text}>
            <b>Web Search</b>
          </text>
          <For each={shown()}>
            {(record) => (
              <text fg={theme().textMuted}>
                <span style={{ fg: stateColor(record) }}>
                  {searchGlyph(record.state)} [{searchLabel(record)}]
                </span>{" "}
                {truncateLabel(record.query, SIDEBAR_QUERY_CHARS)}
              </text>
            )}
          </For>
          <Show when={rows().length > SIDEBAR_LIMIT}>
            <text fg={theme().textMuted}>
              {"  "}…{rows().length - SIDEBAR_LIMIT} more
            </text>
          </Show>
        </box>
      </Show>
    )
  }

  // Between the host's Context section (100) and MCP (200), just past the live
  // workload widgets (limits 150/152, background-tasks 160): transient search
  // activity sits with the other live per-session signals.
  api.slots.register({
    order: 170,
    slots: {
      sidebar_content: (_ctx, props) => <View session_id={props.session_id} />,
    },
  })

  api.lifecycle.onDispose(() => {
    clearInterval(poller)
    clearInterval(ticker)
    if (pokeTimer) clearTimeout(pokeTimer)
    unsubscribePoke()
  })
}

const plugin: TuiPluginModule = {
  id: "opencode-web-search",
  tui,
}

export default plugin

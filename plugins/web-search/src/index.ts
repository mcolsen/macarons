import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import {
  appLogger,
  createSerialQueue,
  OWNER_ONLY_WRITE_MODES,
  readRefreshedAuthStore,
  reportServerCompat,
  unsupportedVersionHooks,
  writeJsonFile,
} from "@macarons/permission-rules"
import { type Plugin, tool } from "@opencode-ai/plugin"
import { exaSearch } from "./backends/exa"
import { createNativeBackend } from "./backends/native"
import type { ProvidersClient } from "./backends/native/resolve"
import type { ActiveModel } from "./backends/native/types"
import { searxngSearch } from "./backends/searxng"
import {
  pruneSearches,
  resolveSearchesPath,
  type SearchesFile,
  type SearchesPaths,
  type SearchRecord,
  STATE_FILE_VERSION,
  SYNC_COMMAND,
  searchIdPrefix,
} from "./searches"
import {
  BACKEND_LABELS,
  type Backend,
  type BackendId,
  type ChainAttempt,
  describeChainFailure,
  resolveServerOptions,
  runSearchChain,
  SERVICE,
  toolDescription,
} from "./shared"
import { mirrorWebsearchPermissions } from "./visibility"

/**
 * @macarons/web-search — server entry
 *
 * Registers ONE search implementation under TWO tool ids:
 *
 * - `web_search` — the primary, always-visible id. The host's registry
 *   filter only gates the literal id `websearch` (behind provider==opencode
 *   OR the OPENCODE_ENABLE_EXA-family env flags), so this alias is offered
 *   on every provider with no flag required: enabling the plugin IS
 *   enabling search.
 * - `websearch` — a defensive shadow of the builtin id. Session tool
 *   assembly is an id-keyed map filled builtin-first then plugin, last
 *   writer wins, so wherever the host makes that id visible OUR execute
 *   occupies the slot and the builtin's hardcoded Exa/Parallel POSTs can
 *   never happen while the plugin is loaded.
 *
 * Both halves of that contract are pinned by this plugin's e2e suite; the
 * mechanics were verified against the pinned OpenCode source
 * (tool/registry.ts, session/tools.ts). Sessions where both ids pass the
 * filter (Zen, or a flag set) are offered the tool twice — identical
 * definitions, both ours — which is why the README recommends dropping the
 * env flag once the plugin is installed. Permission rules keyed on the
 * literal `websearch` are mirrored onto `web_search` via the config hook
 * (see visibility.ts) so per-id visibility filtering treats both the same.
 *
 * Query handling is an ordered backend chain (searxng → native → exa by
 * default): first configured-and-working backend answers; failures fall
 * through; a successful empty result is final. The native backend is
 * restricted to the executing assistant's provider, and the Parallel path
 * (which leaks session id + model name) is deliberately not implemented.
 */

const z = tool.schema

export const WebSearchPlugin: Plugin = async (
  { client, directory, worktree, serverUrl },
  rawOptions,
) => {
  const log = appLogger(client, SERVICE)

  const compat = await reportServerCompat({
    client,
    serverUrl,
    label: "Web Search",
    service: SERVICE,
    log,
  })
  if (compat?.disable) {
    return unsupportedVersionHooks(client, directory, compat.message)
  }

  const options = resolveServerOptions(rawOptions)

  // One native backend for the plugin's lifetime so its provider-resolution
  // cache is shared across sessions; the active model is per call.
  const nativeSearch = createNativeBackend({
    client: client as unknown as ProvidersClient,
    // The ambient read belongs here, at the plugin entry, because this is the
    // half the host loads into its OWN process: `process.env` here is the
    // environment that placed OpenCode's data dir, so it names the very file
    // the host opened — no /path round-trip, and nothing a peer can steer.
    //
    // The REFRESHED reader, not the plain `Auth.all()` mirror: this backend has
    // to USE an OAuth access token, and a control-plane workspace's inline
    // snapshot never learns about the host's refreshes. Declining an expired
    // ChatGPT record (backends/native/auth.ts) would otherwise be permanent
    // there instead of lasting one refresh.
    readAuthStore: () =>
      readRefreshedAuthStore({ env: process.env, homedir: os.homedir() }),
    warn: (message) => {
      log("warn", message)
    },
  })

  const backendsFor = (
    resolveActive: (signal: AbortSignal) => Promise<ActiveModel | undefined>,
  ): Record<BackendId, Backend> => ({
    searxng: {
      id: "searxng",
      run: (params, signal) => searxngSearch(options.searxng, params, signal),
    },
    native: {
      id: "native",
      run: (params, signal) =>
        nativeSearch(options.native, params, resolveActive, signal),
    },
    exa: {
      id: "exa",
      run: (params, signal) => exaSearch(options.exa, params, signal),
    },
  })

  // ---- search-activity channel (feeds the TUI sidebar) --------------------
  //
  // The server records each search's lifecycle (pending → running →
  // complete/error) into a per-project state file the TUI companion reads, and
  // pokes an attached TUI after every write. The whole channel is best-effort
  // display: if the state directory is unavailable or containment-suspect, it
  // silently no-ops and search itself is unaffected. See src/searches.ts for
  // the contract and src/tui.tsx for the reader.
  const instance = {
    id: crypto.randomUUID(),
    pid: process.pid,
    startedAt: Date.now(),
  }
  const idPrefix = searchIdPrefix(instance.id)
  let searchCounter = 0
  const searches = new Map<string, SearchRecord>()
  const root = worktree && worktree !== "/" ? worktree : directory

  // Resolve + containment-check the state file paths once; any failure
  // disables the channel for the plugin's lifetime.
  const stateFilePromise: Promise<SearchesPaths | undefined> = (async () => {
    try {
      const result = await client.path.get({ query: { directory } })
      const stateDir = (result.data as { state?: unknown } | undefined)?.state
      if (typeof stateDir !== "string" || !stateDir) return undefined
      return await resolveSearchesPath(root, stateDir)
    } catch {
      return undefined
    }
  })()

  // Serialized writes so snapshots never land out of order; each is followed by
  // a best-effort poke so an attached TUI refreshes without waiting its poll.
  const writes = createSerialQueue()
  let disposed = false
  const publishPoke = () => {
    const tui = (
      client as {
        tui?: { publish?: (arg: unknown) => Promise<unknown> }
      }
    ).tui
    if (typeof tui?.publish !== "function") return
    void Promise.resolve(
      tui.publish({
        body: {
          type: "tui.command.execute",
          properties: { command: SYNC_COMMAND },
        },
        query: { directory },
      }),
    ).catch(() => {})
  }
  const writeStateFile = () => {
    void writes
      .push(async () => {
        if (disposed) return
        const paths = await stateFilePromise
        if (!paths) return
        const now = Date.now()
        const kept = pruneSearches([...searches.values()], now)
        // Keep the in-memory map in step with the pruned file so it cannot grow
        // without bound across a long-lived session.
        if (kept.length !== searches.size) {
          const keep = new Set(kept.map((record) => record.id))
          for (const id of [...searches.keys()]) {
            if (!keep.has(id)) searches.delete(id)
          }
        }
        const file: SearchesFile = {
          version: STATE_FILE_VERSION,
          instance,
          updatedAt: now,
          searches: kept,
        }
        await writeJsonFile(paths.stateFile, file, OWNER_ONLY_WRITE_MODES)
        // Mixed-version bridge: an attached pre-slug TUI reads the old name.
        await writeJsonFile(
          paths.preSlugStateFile,
          file,
          OWNER_ONLY_WRITE_MODES,
        ).catch(() => {})
        publishPoke()
      })
      .catch((error) => {
        log(
          "warn",
          `activity write failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  }

  const beginSearch = (sessionID: string, query: string): string => {
    const id = `${idPrefix}${++searchCounter}`
    searches.set(id, {
      id,
      sessionID,
      query,
      state: "pending",
      startedAt: Date.now(),
    })
    writeStateFile()
    return id
  }
  const updateSearch = (id: string, patch: Partial<SearchRecord>) => {
    const record = searches.get(id)
    if (!record) return
    Object.assign(record, patch)
    writeStateFile()
  }
  const markRunning = (id: string, backend?: BackendId) =>
    updateSearch(
      id,
      backend ? { state: "running", backend } : { state: "running" },
    )
  const markComplete = (id: string, backend: BackendId) =>
    updateSearch(id, { state: "complete", backend, endedAt: Date.now() })
  const markError = (id: string, reason: string) =>
    updateSearch(id, { state: "error", error: reason, endedAt: Date.now() })

  // A short display token for the sidebar's error row — never the multi-line
  // model-facing failure text.
  const chainFailureSummary = (attempts: ChainAttempt[]): string =>
    attempts.length === 0 ? "no backends" : "all failed"

  // Mirrors the builtin websearch parameter surface (tool/websearch.ts at
  // the pinned OpenCode version) so the shadow is a drop-in.
  const searchTool = tool({
    description: toolDescription(new Date().getFullYear()),
    args: {
      query: z.string().min(1).describe("Websearch query"),
      numResults: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of search results to return (default: 8)"),
      livecrawl: z
        .enum(["fallback", "preferred"])
        .optional()
        .describe(
          "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
        ),
      type: z
        .enum(["auto", "fast", "deep"])
        .optional()
        .describe(
          "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
        ),
      contextMaxCharacters: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum characters for context string optimized for LLMs (default: 10000)",
        ),
    },
    async execute(args, ctx) {
      const { sessionID, messageID } = ctx
      ctx.metadata({
        title: `Web Search "${args.query}"`,
        metadata: { chain: options.order },
      })
      // Record the search as pending before the permission gate so the sidebar
      // can show it awaiting approval.
      const searchID = beginSearch(sessionID, args.query)
      let settled = false
      try {
        // The host persists this assistant before executing its tools. Resolve
        // that exact message only when native runs, never session-latest state.
        const resolveActive = async (
          signal: AbortSignal,
        ): Promise<ActiveModel | undefined> => {
          try {
            const result = await client.session.message({
              path: { id: sessionID, messageID },
              query: { directory },
              signal,
            })
            signal.throwIfAborted()
            if (result.error) {
              log("warn", "executing assistant lookup failed", {
                sessionID,
                messageID,
                status: result.response.status,
              })
              return undefined
            }
            const message = result.data?.info
            if (
              message?.role === "assistant" &&
              message.id === messageID &&
              message.sessionID === sessionID &&
              typeof message.providerID === "string" &&
              message.providerID &&
              typeof message.modelID === "string" &&
              message.modelID
            ) {
              // Copy the identity before awaiting provider resolution.
              return {
                providerID: message.providerID,
                modelID: message.modelID,
              }
            }
            log(
              "warn",
              "executing assistant lookup returned an invalid or mismatched message",
              { sessionID, messageID },
            )
          } catch (error) {
            signal.throwIfAborted()
            log(
              "warn",
              `executing assistant lookup failed: ${error instanceof Error ? error.message : String(error)}`,
              { sessionID, messageID },
            )
          }
          return undefined
        }
        // Same permission action, patterns, and always shape as the builtin
        // — under BOTH tool ids — so existing websearch rules,
        // persist-permissions stores, and approve-for-me behavior carry over
        // unchanged and govern the alias too.
        await ctx.ask({
          permission: "websearch",
          patterns: [args.query],
          always: ["*"],
          metadata: {
            query: args.query,
            numResults: args.numResults,
            livecrawl: args.livecrawl,
            type: args.type,
            contextMaxCharacters: args.contextMaxCharacters,
            chain: options.order,
          },
        })
        markRunning(searchID)
        const result = await runSearchChain(
          options.order,
          backendsFor(resolveActive),
          args,
          ctx.abort,
          // Surface the backend the chain is currently attempting so the
          // sidebar shows which one a running search is executing against.
          (backend) => markRunning(searchID, backend),
        )
        if (result.kind === "ok") {
          markComplete(searchID, result.backend)
          settled = true
          const label = BACKEND_LABELS[result.backend]
          log(
            "info",
            `"${args.query}" answered by ${result.backend} for session ${sessionID}`,
          )
          return {
            title: `${label}: ${args.query}`,
            output: result.output,
            metadata: { backend: result.backend },
          }
        }
        markError(searchID, chainFailureSummary(result.attempts))
        settled = true
        log(
          "warn",
          `"${args.query}" failed: ${result.attempts
            .map((attempt) => `${attempt.backend}=${attempt.kind}`)
            .join(", ")}`,
        )
        return {
          title: `Web search failed: ${args.query}`,
          output: describeChainFailure(result.attempts),
          metadata: { attempts: result.attempts },
        }
      } finally {
        // A denied permission, an abort that threw, or any unexpected error
        // leaves the search unsettled: mark it errored so the sidebar never
        // strands a "searching…" row, then let the original throw propagate.
        if (!settled) markError(searchID, "cancelled")
      }
    },
  })

  return {
    // Mirror `websearch` permission rules onto the `web_search` alias so
    // rules that keep the builtin id visible keep the alias visible too
    // (and vice versa). The host applies config-hook mutations before
    // building agents (project/bootstrap.ts).
    config: async (config) => {
      mirrorWebsearchPermissions(config)
    },

    tool: {
      web_search: searchTool,
      websearch: searchTool,
    },

    // Remove the activity state file on shutdown so a fresh instance never
    // reads a dead server's rows. Flag first, then drain in-flight writes
    // before the rm so nothing past the disposed guard can re-create it.
    dispose: async () => {
      disposed = true
      const paths = await stateFilePromise
      await writes.drain()
      if (paths) {
        await fs.rm(paths.stateFile, { force: true }).catch(() => {})
        await fs.rm(paths.preSlugStateFile, { force: true }).catch(() => {})
      }
    },
  }
}

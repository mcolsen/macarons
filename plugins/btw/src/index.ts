import {
  appLogger,
  reportServerCompat,
  withTimeout,
} from "@macarons/permission-rules"
import type { Plugin } from "@opencode-ai/plugin"
import {
  isGuardedEnvPath,
  type Marker,
  markerOf,
  READ_ONLY_TOOL_IDS,
  trim,
} from "./shared"

/**
 * @macarons/btw — server half
 *
 * Optional, but recommended. The TUI half (src/tui.tsx) can run side questions
 * on its own; this half makes three things better and does not touch anything
 * else:
 *
 *   1. Provider cache reuse for non-Anthropic models. A side question forks the
 *      current session so the request prefix matches the parent's and is served
 *      from cache. Anthropic keys its cache off the token prefix, so that works
 *      with no help. OpenAI-family providers instead key the cache off a
 *      per-session `promptCacheKey` (the SDK sets it to the *fork's* id) — so
 *      without intervention the fork looks like a brand-new conversation and
 *      pays full price. This half rewrites that key back to the *parent's* id
 *      via the `chat.params` hook, so the fork shares the parent's cache.
 *
 *   2. Read-only enforcement that does not depend on the TUI. Forked side
 *      sessions gate other tools with "ask" rules (a blanket "deny" would
 *      drop tools from the request and break the cache prefix), while keeping
 *      the parent's read/glob restrictions. This half rejects prompts when
 *      they appear, so a side question can never edit files or run commands
 *      even in a headless/serve deployment, and the model gets a clean
 *      "denied" and keeps answering instead of hanging.
 *
 *   3. A hard stop on tool executions the permission layer never sees.
 *      Session rules only gate tools that request permission, and nothing
 *      forces a plugin tool to do so. The tool.execute.before hook fires for
 *      every execution — builtin, MCP, plugin — so this half fails any call
 *      in a marked fork that is not on the read-only allowlist, and any
 *      "read" whose target is an env file (the ID allowlist alone cannot see
 *      arguments, and the permission-path guard for env files can be
 *      out-raced by another plugin's stored approval).
 *
 * Forked side sessions are recognized only by the metadata marker this plugin's
 * shared core writes (never by title or any heuristic), so nothing else is ever
 * mistaken for one.
 *
 * Targets OpenCode v1; verified against 1.17.18–1.18.x. On a v1 host outside
 * that band it warns but runs, and it disables only on OpenCode v2+ (whose
 * plugin API differs). Uses only the v1 plugin client and pure helpers, so it
 * is safe in the standalone TUI (in-process transport) too.
 */

const SERVICE = "btw"
const MARKER_LOOKUP_TIMEOUT_MS = 10_000

// ---- plugin ----------------------------------------------------------------

type SessionInfo = { id?: unknown; metadata?: unknown }
type MarkerState = Marker | null | undefined
type LookupToken = { stale: boolean }

function sessionInfoOf(properties: unknown): SessionInfo | undefined {
  if (!properties || typeof properties !== "object") return
  const info = (properties as { info?: unknown }).info
  return info && typeof info === "object" ? (info as SessionInfo) : undefined
}

export const BtwPlugin: Plugin = async ({ client, directory, serverUrl }) => {
  const log = appLogger(client, SERVICE)

  const compat = await reportServerCompat({
    client,
    serverUrl,
    label: SERVICE,
    service: SERVICE,
    log,
  })
  // Only a non-v1 host disables btw; a merely untested v1 host runs on.
  if (compat?.disable) return {}

  // Marked forks, learned from session events (fast path) and lazy lookup (see
  // resolveMarker). Confirmed marked and normal sessions are cached; failed or
  // malformed lookups remain unknown so a later request can recover.
  const marks = new Map<string, Marker>()
  const normal = new Set<string>()
  const pendingLookups = new Map<string, Set<LookupToken>>()

  const noteStateEvent = (sessionID: string) => {
    for (const lookup of pendingLookups.get(sessionID) ?? []) {
      lookup.stale = true
    }
  }

  const rememberFromInfo = (
    info: SessionInfo | undefined,
    confirmUnmarked: boolean,
  ) => {
    if (!info || typeof info.id !== "string") return
    noteStateEvent(info.id)
    const marker = markerOf(info.metadata)
    if (marker) {
      marks.set(info.id, marker)
      normal.delete(info.id)
      trim(marks)
    } else {
      marks.delete(info.id)
      if (confirmUnmarked) {
        // An unmarked update is authoritative: this is a normal session or an
        // adopted fork whose marker was deliberately cleared.
        normal.add(info.id)
        trim(normal)
      } else {
        // Forks are created before their marker is written. Creation alone
        // cannot prove normality if that later update event is missed.
        normal.delete(info.id)
      }
    }
  }

  // Resolve a session's marker, fetching if we have no confirmed state. The
  // negative cache keeps successful normal-session lookups to one request,
  // while failures remain retryable so a missed marker event can still recover.
  const resolveMarker = async (sessionID: string): Promise<MarkerState> => {
    const known = marks.get(sessionID)
    if (known) return known
    if (normal.has(sessionID)) return null

    const lookup: LookupToken = { stale: false }
    const pending = pendingLookups.get(sessionID) ?? new Set<LookupToken>()
    pending.add(lookup)
    pendingLookups.set(sessionID, pending)

    let response: unknown
    try {
      response = await withTimeout(
        (signal) =>
          client.session.get({
            path: { id: sessionID },
            query: { directory },
            signal,
          }),
        MARKER_LOOKUP_TIMEOUT_MS,
      )
    } catch {
      return undefined
    } finally {
      pending.delete(lookup)
      if (pending.size === 0) pendingLookups.delete(sessionID)
    }

    if (lookup.stale) {
      const learned = marks.get(sessionID)
      if (learned) return learned
      return normal.has(sessionID) ? null : undefined
    }

    if (!response || typeof response !== "object") return undefined
    const result = response as { data?: unknown; error?: unknown }
    if (result.error != null || !result.data || typeof result.data !== "object")
      return undefined
    const info = result.data as SessionInfo
    if (info.id !== sessionID) return undefined

    const marker = markerOf(info.metadata)
    if (marker) {
      marks.set(sessionID, marker)
      normal.delete(sessionID)
      trim(marks)
      return marker
    }

    normal.add(sessionID)
    trim(normal)
    return null
  }

  const rejectPermission = async (sessionID: string, permissionID: string) => {
    const respond = (
      client as {
        postSessionIdPermissionsPermissionId?: (
          options: unknown,
        ) => Promise<{ error?: unknown }>
      }
    ).postSessionIdPermissionsPermissionId?.bind(client)
    if (!respond) return
    try {
      await respond({
        path: { id: sessionID, permissionID },
        body: { response: "reject" },
        query: { directory },
      })
    } catch {
      // Usually already answered (e.g. the TUI half rejected it first). Benign.
    }
  }

  return {
    // Rewrite the fork's cache key to the parent's so OpenAI-family providers
    // serve the side question's prefix from the parent's cache. Inert for
    // Anthropic (which caches by prefix and ignores this key).
    "chat.params": async (input, output) => {
      const marker = await resolveMarker(input.sessionID)
      if (!marker) return
      output.options.promptCacheKey = marker.parent
      output.options.prompt_cache_key = marker.parent
    },

    // Hard stop for tools the session rules cannot see. Rules only gate tools
    // that request permission, and nothing forces a plugin tool to call
    // ctx.ask. This hook fires before every execution — builtin, MCP, and
    // plugin alike — and a throw here fails just that tool call: the host
    // records the message as the call's error and the model reads it and
    // moves on (SessionProcessor.failToolCall).
    "tool.execute.before": async (input, output) => {
      const marker = await resolveMarker(input.sessionID)
      if (marker === null) return
      if (
        (marker === undefined || marker.tools === "read-only") &&
        READ_ONLY_TOOL_IDS.has(input.tool)
      ) {
        // "read" passes the ID allowlist, but the env-file carve-out is
        // argument-level. Enforce it here, pre-execution: the session rules'
        // "ask" + auto-reject can be out-raced by another permission plugin
        // answering "allow" first, and this gate cannot.
        const args = (output as { args?: unknown } | undefined)?.args
        const filePath =
          args && typeof args === "object"
            ? (args as { filePath?: unknown }).filePath
            : undefined
        if (input.tool === "read" && isGuardedEnvPath(filePath)) {
          if (marker === undefined) {
            throw new Error(
              "Denied: marker lookup was unavailable, so env-file access cannot be verified as safe for this session.",
            )
          }
          throw new Error(
            "Denied: this is a read-only side question, and env files are off-limits to it.",
          )
        }
        return
      }
      if (marker === undefined) {
        throw new Error(
          `Denied: marker lookup was unavailable, so "${input.tool}" cannot be verified as safe for this session.`,
        )
      }
      throw new Error(
        `Denied: this is a read-only side question, and "${input.tool}" is not one of its permitted read-only tools.`,
      )
    },

    event: async ({ event }) => {
      const { type, properties } = event as {
        type?: string
        properties?: unknown
      }

      if (type === "session.updated" || type === "session.created") {
        rememberFromInfo(sessionInfoOf(properties), type === "session.updated")
        return
      }

      if (type === "session.deleted") {
        const info = sessionInfoOf(properties)
        const fallback = (properties as { sessionID?: unknown } | undefined)
          ?.sessionID
        const id =
          typeof info?.id === "string"
            ? info.id
            : typeof fallback === "string"
              ? fallback
              : undefined
        if (id) {
          noteStateEvent(id)
          marks.delete(id)
          normal.delete(id)
        }
        return
      }

      if (type === "permission.asked") {
        const props = (properties ?? {}) as Record<string, unknown>
        const sessionID = props.sessionID
        const id = props.id ?? props.permissionID
        if (typeof sessionID !== "string" || typeof id !== "string") return
        // A side question cannot request new access: inherited read/glob asks
        // are rejected just like write-capable tools, never auto-approved.
        const marker = await resolveMarker(sessionID)
        if (!marker) return
        await rejectPermission(sessionID, id)
        log(
          "info",
          `auto-denied "${String(props.permission ?? "?")}" in side session ${sessionID}`,
        )
      }
    },
  }
}

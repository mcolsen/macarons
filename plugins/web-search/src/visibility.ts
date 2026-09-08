/**
 * `web_search` alias visibility.
 *
 * The host hides a tool from the model when the last permission rule whose
 * KEY matches the tool's id is a `"*": "deny"` (Permission.disabled, applied
 * per tool id in session/llm/request.ts resolveTools). Execute-time asks are
 * already unified — both of this plugin's ids ask the `websearch` action —
 * but visibility is per-id: a ruleset like `{ "*": "deny", "websearch":
 * "allow" }` keeps the builtin id visible while hiding the alias, and the
 * host's own `explore` agent hardcodes exactly that shape (agent/agent.ts).
 * On a non-Zen provider without an enable flag the registry has already
 * removed the literal `websearch` id, so such an agent would end up with NO
 * search tool at all — breaking the "plugin-enabled is search-enabled"
 * contract.
 *
 * The host guarantees plugin `config` hooks run before anything reads the
 * config ("Plugin can mutate config so it has to be initialized before
 * anything else" — project/bootstrap.ts), so this mirror runs there:
 *
 * 1. Every config ruleset (global and per-agent) with a literal `websearch`
 *    key and no `web_search` key gets the same value copied under
 *    `web_search`, at the same merge position.
 * 2. The built-in `explore` agent's hardcoded allow has no config
 *    counterpart to mirror, so `web_search: "allow"` is appended to its
 *    per-agent config — but ONLY when no user rule already governs either
 *    id for explore (global or agent-level): per-agent config merges LAST,
 *    so an unconditional injection would override user rules like a global
 *    `websearch: "deny"` that step 1 already mirrors correctly.
 *
 * Wildcard keys (e.g. `"web*"`) match both ids in the host already and are
 * left untouched; an explicit `web_search` key anywhere is user intent and
 * is never overwritten. The explore special case is pinned to the host
 * version this plugin's e2e suite runs against.
 */

import { wildcardMatch } from "@macarons/permission-rules"

const BUILTIN_ID = "websearch"
const ALIAS_ID = "web_search"

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Copy a literal `websearch` rule to `web_search`, in place. */
function mirrorRuleset(permission: Record<string, unknown>): void {
  if (
    !Object.hasOwn(permission, BUILTIN_ID) ||
    Object.hasOwn(permission, ALIAS_ID)
  )
    return
  const value = permission[BUILTIN_ID]
  permission[ALIAS_ID] = isRecord(value) ? { ...value } : value
}

/** Does any key of this ruleset govern either search id? */
function governsSearch(permission: unknown): boolean {
  if (!isRecord(permission)) return false
  return Object.keys(permission).some(
    (key) => wildcardMatch(BUILTIN_ID, key) || wildcardMatch(ALIAS_ID, key),
  )
}

export function mirrorWebsearchPermissions(config: unknown): void {
  if (!isRecord(config)) return

  const globalPermission = isRecord(config.permission)
    ? config.permission
    : undefined
  if (globalPermission) mirrorRuleset(globalPermission)

  const agents = isRecord(config.agent) ? config.agent : undefined
  if (agents) {
    for (const entry of Object.values(agents)) {
      if (isRecord(entry) && isRecord(entry.permission)) {
        mirrorRuleset(entry.permission)
      }
    }
  }

  // Explore equalizer (step 2). Only global rules and explore's own
  // per-agent rules feed explore's effective ruleset; when neither governs
  // a search id, the hardcoded `{ "*": "deny", websearch: "allow" }` is the
  // deciding layer and the alias needs the matching allow appended last.
  const explorePermission = isRecord(agents?.explore)
    ? agents.explore.permission
    : undefined
  if (governsSearch(globalPermission) || governsSearch(explorePermission)) {
    return
  }
  if (!isRecord(config.agent)) config.agent = {}
  const agent = config.agent as Record<string, unknown>
  if (!isRecord(agent.explore)) agent.explore = {}
  const explore = agent.explore as Record<string, unknown>
  if (!isRecord(explore.permission)) explore.permission = {}
  const permission = explore.permission as Record<string, unknown>
  permission[ALIAS_ID] = "allow"
}

import {
  oauthAccountId,
  oauthExpired,
  oauthRecordOf,
} from "@macarons/permission-rules"
import type { ProviderCredentials } from "./types"

/**
 * OAuth credential readers. Adapted from emilsvennesson/opencode-websearch
 * v0.6.0 (MIT; see NOTICE).
 *
 * OpenCode exposes no "read credential" endpoint, so the auth store is read
 * from disk — by the library's reader, which resolves the same file the host
 * opened and honors the same inline OPENCODE_AUTH_CONTENT override the host
 * honors. Upstream (and this package until the 2026-07-23 audit's §2.3/§2.8.4)
 * instead derived auth.json from the SDK's state path and read only the file,
 * which was wrong twice over: the state→share rewrite it depended on holds
 * only when XDG_STATE_HOME and XDG_DATA_HOME are both unset (in the repo's own
 * e2e sandbox, which sets both, it resolved to a directory nothing writes),
 * and a control-plane workspace carries its credentials in the environment
 * with no auth.json on disk at all. Both readers ran per resolution, so a
 * hiccup in the /path round-trip also read as "signed out of everything";
 * this half runs inside the host's own process, so its environment IS the
 * host's and no round-trip is needed to find the file.
 *
 * These take the store rather than reading it themselves: one read serves
 * both providers, and the caller owns the seam tests inject through.
 */

export const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex"
const COPILOT_BASE_URL = "https://api.githubcopilot.com"

/**
 * ChatGPT OAuth: the `openai` entry's access token, plus the account id it
 * identifies — the stored `accountId` when the host wrote one, else the id
 * claimed by the access token itself (the same JWT fallback usage-limits has
 * always had, §2.3). A record with no derivable id is still credentials: the
 * host omits that header in exactly this case too, so the search is attempted
 * rather than the whole ChatGPT resolution dropped.
 *
 * An access token whose stored expiry has passed is NOT credentials, though.
 * This resolution SHADOWS a configured `openai` api key (resolve.ts), and
 * unlike the host — which refreshes before it uses one (plugin/openai/
 * codex.ts:361) — nothing here can rotate a token. Shadowing a working key
 * with a token that can only 401 is strictly worse than declining, and the
 * decline is temporary: the host refreshes on its own next use and the 60s
 * resolution TTL picks the new token up. A record with no expiry at all
 * (possible on the raw inline path) is used, since nothing proves it dead.
 *
 * "Temporary" is load-bearing and is not free — it holds only because the entry
 * reads through `readRefreshedAuthStore` (src/index.ts). Under the plain
 * `Auth.all()` mirror a control-plane workspace's inline snapshot never learns
 * about the host's refresh, so the same decline would last the whole workspace
 * lifetime. Anything that reverts that reader to `readAuthStore` reintroduces a
 * permanent ChatGPT outage there, not a one-refresh gap.
 */
export function resolveChatGPTCredentials(
  store: unknown,
  now: number = Date.now(),
): ProviderCredentials | null {
  const record = oauthRecordOf(store, "openai")
  if (!record?.access) return null
  // The library's predicate, not a local comparison: the reader's refresh
  // fallback keys off the same one, and the two must never drift apart.
  if (oauthExpired(record, now)) return null
  const accountId = oauthAccountId(record)
  return {
    ...(accountId ? { accountId } : {}),
    apiKey: record.access,
    baseURL: CHATGPT_BASE_URL,
    oauth: true,
  }
}

function copilotBaseURL(enterpriseUrl: unknown): string {
  if (typeof enterpriseUrl !== "string" || !enterpriseUrl.trim()) {
    return COPILOT_BASE_URL
  }
  const domain = enterpriseUrl
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
  return domain ? `https://copilot-api.${domain}` : COPILOT_BASE_URL
}

/** Copilot OAuth: the `github-copilot` entry's refresh token. */
export function resolveCopilotCredentials(
  store: unknown,
): ProviderCredentials | null {
  const record = oauthRecordOf(store, "github-copilot")
  if (!record?.refresh) return null
  return {
    apiKey: record.refresh,
    baseURL: copilotBaseURL(record.enterpriseUrl),
    oauth: true,
  }
}

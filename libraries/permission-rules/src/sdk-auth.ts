import fs from "node:fs/promises"
import path from "node:path"
import type { CompatNotice } from "./compat"
import { reportTuiCompat } from "./compat"

/**
 * Whether a session is a sub-agent's — a child the host spawned inside another
 * session's turn, identified by its `parentID`.
 *
 * Six TUI halves probe this and every one of them wrote the same optional
 * chain (2026-07-23 audit §2.5). It matters because a sub-agent session can be
 * *routed to* and *rendered* like any other: the sidebar slot is invoked with
 * whatever session the host is showing, so a widget that does not filter here
 * draws a per-session panel for a child that has no standing of its own — and
 * an engine that does not filter attributes the child's work to it.
 *
 * Fail-open (`false`) on anything unreadable: a host that shapes the session
 * record differently must degrade to showing a widget, never to hiding every
 * widget in the suite.
 */
export function isSubAgentSession(api: unknown, sessionID: string): boolean {
  const get = (
    api as { state?: { session?: { get?: (id: string) => unknown } } }
  ).state?.session?.get
  if (typeof get !== "function") return false
  try {
    const parentID = (get(sessionID) as { parentID?: unknown } | undefined)
      ?.parentID
    return typeof parentID === "string" && parentID.length > 0
  } catch {
    return false
  }
}

/**
 * How many prompting sessions a TUI half remembers. Both permission TUIs
 * arrived at the same bound: the list only exists to map a parent session to
 * the children currently prompting under it, and a child that prompted 200
 * sessions ago is not one of them.
 */
export const PROMPT_SESSIONS_TRACKED = 200

/**
 * Remember a session that just prompted, keeping the newest `limit`.
 *
 * Pure, and returning the SAME array when nothing changed, because both
 * callers hold this in a solid signal: a fresh array on a repeat sessionID
 * would re-render the sidebar on every permission event from a session
 * already in the list. (Signals live in the plugins, not here — the host
 * substitutes its own solid-js into the TUI entry module only, so a signal
 * created in this library would hold values and never notify anything.)
 */
export function notePromptSession(
  tracked: readonly string[],
  sessionID: string,
  limit = PROMPT_SESSIONS_TRACKED,
): readonly string[] {
  if (tracked.includes(sessionID)) return tracked
  const next = [...tracked, sessionID]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/**
 * A viewed session together with the tracked sessions prompting *under* it.
 *
 * The host does not show a session only its own prompts: it aggregates the
 * session with its sub-agent children (a child's own view shows none), which
 * is why a shell command a sub-agent runs prompts under the child session and
 * not the one in the route. A half that reads only the routed session misses
 * those entirely — both permission TUIs hit that and fixed it the same way.
 *
 * `tracked` is the caller's own prompt-session list (see notePromptSession):
 * the host exposes no children-of query, so the children are recovered from
 * sessions this TUI has actually seen prompt. Order is the viewed session
 * first, then `tracked` order — a caller that needs the host's own tie-break
 * across several pending prompts sorts the result.
 */
export function promptSessionFamily(
  api: unknown,
  sessionID: string,
  tracked: readonly string[],
): string[] {
  const get = (
    api as { state?: { session?: { get?: (id: string) => unknown } } }
  ).state?.session?.get
  if (typeof get !== "function") return [sessionID]
  const family = [sessionID]
  for (const candidate of tracked) {
    if (candidate === sessionID || family.includes(candidate)) continue
    try {
      const parentID = (get(candidate) as { parentID?: unknown } | undefined)
        ?.parentID
      if (parentID === sessionID) family.push(candidate)
    } catch {
      // An unreadable session record is simply not a known child.
    }
  }
  return family
}

// The sessionID of the session screen the TUI is currently showing, or
// undefined on any other screen. Callers that must exclude sub-agent sessions
// (which never render a sidebar of their own) add that filter on top — see
// usage-limits' viewedSessionID, and isSubAgentSession above.
export function routeSessionID(api: unknown): string | undefined {
  const route = (api as { route?: { current?: unknown } }).route?.current
  if (!route || typeof route !== "object") return
  if ((route as { name?: unknown }).name !== "session") return
  const params = (route as { params?: unknown }).params
  if (!params || typeof params !== "object") return
  const sessionID = (params as { sessionID?: unknown }).sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

/**
 * The host path fields a TUI half derives its files from, once they are real.
 *
 * `projectRoot` is the derivation every half had inlined: the host's `worktree`
 * when it names one, falling back to `directory`. OpenCode reports worktree
 * `"/"` as its non-git instance-context sentinel, which is not a project root
 * and must read as absent — both halves of a plugin key files off this, so a
 * half that took the sentinel literally would key against the filesystem root
 * and never find what the other half wrote.
 */
export type TuiStatePaths = {
  projectRoot: string
  directory: string
  config: string
  state: string
}

/**
 * Resolve something from `api.state.path` exactly once, and not before the
 * host's paths are real.
 *
 * `api.state.path` is not populated at plugin activation: the host fills every
 * field in one batch from a server round-trip that races activation, and until
 * it lands each field is an empty-string placeholder. Four TUI halves had each
 * written the same guard around that race (2026-07-23 audit §2.5), because
 * getting it wrong is silent and permanent in both directions:
 *
 * - **Resolve too early** and the answer is latched against placeholders for
 *   the TUI's whole lifetime — web-search would watch a state file under `""`,
 *   usage-limits would decide there is no classifier section, and neither
 *   would ever retry.
 * - **Re-resolve on every read** and a filesystem probe runs per render.
 *
 * So the returned getter answers `undefined` while the paths are still
 * placeholders — the caller's cue to try again on its next tick — and from the
 * first call that sees real paths on, the same promise every time.
 *
 * A resolution that *fails* is cached as `undefined`, deliberately: the
 * failures these callers see (interop unavailable, a containment check
 * rejected the path) are properties of the project, not of the moment, so
 * retrying them per read would repeat a settled answer at filesystem cost.
 *
 * `require` names the fields beyond `directory` that must be non-empty first.
 * The host writes them in one batch, so in practice they land together — but
 * naming them keeps each caller's precondition its own: usage-limits needs the
 * config dir and would otherwise resolve against `""`, while web-search needs
 * only the state dir and must not be gated on a field it never reads.
 */
export function resolvePathsOnce<T>(
  api: unknown,
  resolve: (paths: TuiStatePaths) => Promise<T | undefined>,
  input: { require?: ReadonlyArray<"config" | "state"> } = {},
): () => Promise<T | undefined> | undefined {
  let resolved: Promise<T | undefined> | undefined
  return () => {
    if (resolved) return resolved
    const path = (
      api as {
        state?: {
          path?: {
            worktree?: unknown
            directory?: unknown
            config?: unknown
            state?: unknown
          }
        }
      }
    ).state?.path
    const field = (name: "worktree" | "directory" | "config" | "state") => {
      const value = path?.[name]
      return typeof value === "string" ? value : ""
    }
    const directory = field("directory")
    if (!directory) return undefined
    for (const name of input.require ?? []) if (!field(name)) return undefined
    const worktree = field("worktree")
    resolved = resolve({
      projectRoot: worktree && worktree !== "/" ? worktree : directory,
      directory,
      config: field("config"),
      state: field("state"),
    }).catch(() => undefined)
    return resolved
  }
}

/**
 * Open a dialog at the host's "large" size.
 *
 * The size has to be set AFTER the replace, because the host resets it to
 * "medium" inside `replace()` itself — so the obvious ordering silently gives
 * you a medium dialog. Two plugins found that out independently and the
 * comment recording it was copy-pasted verbatim between them (2026-07-23 audit
 * §1), which is the tell that the ordering, not the two calls, is the thing
 * worth naming.
 *
 * `render` and `onClose` pass straight through; this helper owns only the
 * ordering. The api is probed defensively — a host without `setSize` still
 * gets its dialog, at whatever size it defaults to.
 */
export function replaceLargeDialog(
  api: unknown,
  render: () => unknown,
  onClose?: () => void,
): void {
  const dialog = (
    api as {
      ui?: {
        dialog?: {
          replace?: (render: () => unknown, onClose?: () => void) => void
          setSize?: (size: string) => void
        }
      }
    }
  ).ui?.dialog
  dialog?.replace?.(render, onClose)
  dialog?.setSize?.("large")
}

// ---------------------------------------------------------------------------
// Server locality
// ---------------------------------------------------------------------------

// The base URL of the SDK client the host handed to the plugin. The transport
// field is `client` in the published v2 SDK but `_client` in the client
// bundled into the 1.17.15+ binaries, so both are probed; anything unreadable
// reads as undefined and callers must treat that as not-local.
export function sdkClientBaseUrl(client: unknown): string | undefined {
  if (!client || typeof client !== "object") return
  const record = client as { _client?: unknown; client?: unknown }
  const transport = record._client ?? record.client
  if (!transport || typeof transport !== "object") return
  const getConfig = (transport as { getConfig?: unknown }).getConfig
  if (typeof getConfig !== "function") return
  try {
    const baseUrl = (
      getConfig.call(transport) as { baseUrl?: unknown } | undefined
    )?.baseUrl
    return typeof baseUrl === "string" && baseUrl ? baseUrl : undefined
  } catch {
    return
  }
}

// Where the attached server runs relative to this process. Only the
// placeholder hostname of the host's in-process (standalone TUI) client
// proves the server is this very process. A loopback or wildcard address
// proves the connection terminates on this machine but not that the server
// runs here — an SSH tunnel or local proxy to a remote server presents
// exactly the same hostname, so loopback must never be trusted with
// credential writes. Everything else — including an unreadable URL — reads
// as remote, so callers fail closed.
export type ServerLocality = "in-process" | "loopback" | "remote"

const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
  "::",
  "[::]",
])

export function serverLocality(baseUrl: string | undefined): ServerLocality {
  if (!baseUrl) return "remote"
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    if (hostname === "opencode.internal") return "in-process"
    return LOOPBACK_HOSTNAMES.has(hostname) ? "loopback" : "remote"
  } catch {
    return "remote"
  }
}

/**
 * The two questions every TUI half answers before it wires anything up: is
 * this host a version we run on, and is the server it attached to on this
 * machine? All ten halves opened with these (2026-07-23 audit §2.5), assembled
 * from the primitives above by copy-paste.
 *
 * Both legs stay exactly as the hand-written copies had them:
 *
 * - **Version.** Only a non-v1 host disables the plugin. A merely *untested*
 *   v1 host warns and runs on — the band is a statement about what has been
 *   verified, not a lockout, and a plugin that refused every unreleased patch
 *   version would be broken by its own caution. `reportTuiCompat` surfaces the
 *   notice; this gate only acts on `disable`.
 * - **Locality.** Whether a remote attach disables the half is a per-plugin
 *   fact and `remoteBails` is therefore REQUIRED, with no default in either
 *   direction, because both defaults are wrong for someone. Four halves reach
 *   the server machine's filesystem or processes (web-search, background-tasks,
 *   worktree) or the local auth store (usage-limits) and are meaningless — in
 *   worktree's case, actively destructive against a same-named local checkout
 *   — when the server is elsewhere. The other six are pure UI over data the
 *   host already synced, and work perfectly on a remote attach; cache-ratio in
 *   particular omits the bail *by design* (§2.9). Defaulting to bail would
 *   silently disable those six; defaulting to no-bail would let a new
 *   file-touching half ship without the guard. Making it a required field
 *   makes the author answer it.
 *
 * Returns the locality on the running leg so a caller that needs finer rules
 * than "remote or not" does not probe it a second time.
 */
export type TuiGate =
  | { disabled: true; reason: "version" | "remote" }
  | { disabled: false; locality: ServerLocality; compat: CompatNotice | null }

export function tuiGate(
  api: unknown,
  input: {
    label: string
    service: string
    remoteBails: boolean
    range?: string
  },
): TuiGate {
  const compat = reportTuiCompat(api, input)
  if (compat?.disable) return { disabled: true, reason: "version" }
  const locality = serverLocality(
    sdkClientBaseUrl((api as { client?: unknown }).client),
  )
  if (input.remoteBails && locality === "remote")
    return { disabled: true, reason: "remote" }
  return { disabled: false, locality, compat }
}

// ---------------------------------------------------------------------------
// OpenCode's auth store
//
// Where the host keeps provider credentials, and how a plugin reads them
// without inventing its own answer. Three packages had each grown a private
// reader (2026-07-23 audit §2.3) and the three disagreed about what
// credentials exist: two honored the inline OPENCODE_AUTH_CONTENT override
// and one did not (§2.8.4), one filtered the file the way the host filters it
// and two did not, and the path was derived from the environment twice and
// from the SDK's state path once. A plugin that reads a different store than
// the host acts on credentials the host will never use — so the read is
// settled here, once, against the host's own `Auth.all()`
// (opencode/src/auth/index.ts:58-67) rather than averaged across the forks.
// ---------------------------------------------------------------------------

/**
 * OpenCode's data directory — `Global.Path.data` (core/global.ts:11), derived
 * exactly as the host derives it: xdg-basedir 5.1.0's `xdgData`, which is
 * `XDG_DATA_HOME` when non-empty and `<homedir>/.local/share` otherwise, on
 * every platform (that package has no darwin/win32 case), plus the `opencode`
 * app segment.
 *
 * Plain `||`, not a trimmed test: the host joins whatever non-empty value the
 * variable holds, so a whitespace-only `XDG_DATA_HOME` sends the host to a
 * relative directory and has to send a plugin to the same one. usage-limits'
 * `.trim()` fork would have kept reading the real store while the host read
 * nothing — a disagreement in exactly the direction this reader exists to
 * end. `env`/`homedir` are parameters rather than `process` reads so the
 * derivation stays pure (and so a config hook, which cannot ask the server
 * anything without deadlocking bootstrap, can still reach the right file).
 */
export function openCodeDataDir(
  env: Record<string, string | undefined>,
  homedir: string,
): string {
  return path.join(
    env.XDG_DATA_HOME || path.join(homedir, ".local", "share"),
    "opencode",
  )
}

/**
 * `<data>/auth.json` — the file the host's auth service opens
 * (auth/index.ts:10), derived from the environment and nothing else.
 *
 * The suite had a second derivation, and this is where it was retired rather
 * than folded in. web-search reached auth.json through the SDK instead: `/path`
 * reports the host's `state` dir but never `data` (server .../handlers/
 * instance.ts:29-37), so it rewrote `…/state/opencode` into
 * `…/share/opencode`. That rewrite is sound only if the process that PRODUCED
 * the state dir left both XDG variables unset — and a reader can never
 * establish that:
 *
 * - **Same process** (every server-half plugin, and a standalone TUI): the
 *   environment here IS the environment that placed the dirs, so the rewrite
 *   can only reproduce what the env derivation already returns. It buys
 *   nothing.
 * - **Different process** (a TUI attached to a server it did not start):
 *   nothing about *this* environment proves anything about *that* one. A
 *   server under systemd with `XDG_STATE_HOME=/var/lib/opencode/state` reports
 *   a state dir that rewrites to `/var/lib/opencode/share/opencode` — a
 *   directory nothing ever writes — while its real store sits under its own
 *   `XDG_DATA_HOME`. The repo's own e2e sandbox is exactly this shape, which
 *   is why web-search's reader found no credentials in any sandbox run.
 *
 * So the rewrite is either redundant or unsound, with no configuration in
 * between. It is also an untrusted input on the only tier that would want it:
 * `path.get` is answered by the attached server (and is workspace-scoped, so a
 * selected control-plane workspace answers with a container's paths), and a
 * loopback attach is precisely the tier this suite refuses to trust — see
 * serverLocality. A peer must not get to name the file a plugin reads
 * credentials from.
 */
export function openCodeAuthStorePath(
  env: Record<string, string | undefined>,
  homedir: string,
): string {
  return path.join(openCodeDataDir(env, homedir), "auth.json")
}

/** The auth types the host's `Auth.Info` union decodes to. */
export type AuthType = "oauth" | "api" | "wellknown"

/**
 * The auth type an entry would decode to under the host's `Auth.Info` union
 * (auth/index.ts:14-35), or `undefined` if the host would DROP it. `Auth.all()`
 * schema-validates every entry read from auth.json and silently discards the
 * malformed ones (`Record.filterMap(..., decodeUnknownOption(Info))`), so a
 * stale `{"type":"oauth"}` with no tokens is not an oauth provider to the host —
 * it activates nothing and installs no fetch. A plugin must read entries the
 * same way, or it treats a phantom entry as an active provider (and, for
 * redact-secrets, skips wrapping a provider the host actually serves through a
 * plain api key, leaking its title-generation traffic). The three member
 * shapes, required fields only (excess keys are ignored, exactly like
 * `Schema.Class` decoding):
 *
 *   - oauth: refresh, access (strings) + expires (a non-negative SAFE integer —
 *     `NonNegativeInt` is `Schema.Int.check(isGreaterThanOrEqualTo(0))`
 *     (opencode/packages/schema/src/schema.ts:4) and effect's `isInt` filter is
 *     `Number.isSafeInteger`, not `Number.isInteger`, so an expiry past 2^53
 *     drops the entry for the host. `Number.isInteger` here kept it, and since
 *     web-search began declining EXPIRED ChatGPT records that divergence became
 *     load-bearing: a `1e100` expiry read as a live token and shadowed the
 *     configured `openai` api key the host was actually serving with.)
 *   - api: key (string) + optional metadata (Record<string, string> — any
 *     other present shape, `42` or `{a: 1}` alike, fails the decode and the
 *     host drops the whole entry)
 *   - wellknown: key, token (strings)
 */
export function validAuthType(entry: unknown): AuthType | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    return undefined
  const e = entry as Record<string, unknown>
  const str = (v: unknown): boolean => typeof v === "string"
  const optStr = (v: unknown): boolean =>
    v === undefined || typeof v === "string"
  const optStrRecord = (v: unknown): boolean =>
    v === undefined ||
    (!!v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.values(v).every((x) => typeof x === "string"))
  switch (e.type) {
    case "oauth":
      return str(e.refresh) &&
        str(e.access) &&
        typeof e.expires === "number" &&
        Number.isSafeInteger(e.expires) &&
        e.expires >= 0 &&
        optStr(e.accountId) &&
        optStr(e.enterpriseUrl)
        ? "oauth"
        : undefined
    case "api":
      return str(e.key) && optStrRecord(e.metadata) ? "api" : undefined
    case "wellknown":
      return str(e.key) && str(e.token) ? "wellknown" : undefined
    default:
      return undefined
  }
}

/**
 * Mirror the host's `Auth.all()` filtering for the auth.json FILE path: keep the
 * raw entries the `Info` schema would accept, drop the rest. The host does NOT
 * validate inline `OPENCODE_AUTH_CONTENT` (it returns the raw parse verbatim —
 * auth/index.ts:59-63), so that path must be passed through unfiltered; this is
 * only for the file it decodes. Entries are kept as the raw objects, never
 * reshaped, because callers read fields the schema does not name.
 *
 * Null-prototype accumulator: `JSON.parse` makes `__proto__` a real own
 * property, so assigning it into a plain literal would silently re-point the
 * result's prototype instead of adding a provider — and this is the map that
 * decides which providers redact-secrets' wire backstop stands down for.
 */
export function validatedAuthStore(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  if (!raw || typeof raw !== "object") return out
  for (const [providerID, entry] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (validAuthType(entry)) out[providerID] = entry
  }
  return out
}

/**
 * The whole auth store, read the way the host's `Auth.all()` reads it
 * (auth/index.ts:58-67) — the one policy all three former readers now share:
 *
 * - **The inline override wins, and is returned RAW.** A set, parseable
 *   `OPENCODE_AUTH_CONTENT` replaces the store wholesale — no merging with the
 *   file, even when it parses to something with no usable entries — and it is
 *   NOT schema-filtered, because the host does not filter it either. This is
 *   not a test affordance: a control-plane workspace is launched with its
 *   credentials in this variable and no auth.json on disk at all
 *   (control-plane/workspace.ts:530), so a file-only reader is blind exactly
 *   where the host is signed in. web-search was that reader (audit §2.8.4).
 * - **Unparseable inline content falls through to the file**, silently, the
 *   same catch-and-continue the host performs: the host stays signed in via
 *   auth.json when the override is garbage, so a plugin must not read that as
 *   a sign-out.
 * - **The file is decoded per entry** (validatedAuthStore), so an entry the
 *   host would discard never masquerades here as a live credential.
 * - **A missing or unreadable file is an EMPTY store, not an unknown one.**
 *   `orElseSucceed(() => ({}))` is the host's own answer, and an empty store
 *   is a truthful one: it is what the host sees too.
 *
 * The path is re-derived per call rather than frozen at import the way the
 * host's is, so a caller whose environment moves (a test, a sandbox) reads
 * where it now points; `readFile` is injectable for the same reason.
 *
 * This is the exact mirror, and it is what a caller that must agree with the
 * host about WHO IS SIGNED IN wants (redact-secrets decides which providers its
 * wire backstop stands down for). A caller that instead has to USE an OAuth
 * token wants `readRefreshedAuthStore`, which repairs the one thing a frozen
 * inline snapshot gets wrong.
 */
export async function readAuthStore(input: AuthStoreInput): Promise<unknown> {
  const inline = inlineAuthStore(input.env)
  if (inline !== undefined) return inline
  return fileAuthStore(input)
}

export type AuthStoreInput = {
  env: Record<string, string | undefined>
  homedir: string
  readFile?: (file: string) => Promise<string>
}

/**
 * The inline override's parse, or `undefined` when it is unset or unparseable —
 * the two cases the host treats identically by falling through to the file.
 * `JSON.parse` cannot itself return `undefined`, so the sentinel is unambiguous:
 * `OPENCODE_AUTH_CONTENT="null"` parses to `null` and still WINS, exactly as it
 * does for the host.
 */
function inlineAuthStore(
  env: Record<string, string | undefined>,
): unknown | undefined {
  const inline = env.OPENCODE_AUTH_CONTENT
  if (!inline) return undefined
  try {
    return JSON.parse(inline)
  } catch {
    return undefined
  }
}

/** auth.json, decoded entry by entry; empty when missing or corrupt. */
async function fileAuthStore(
  input: AuthStoreInput,
): Promise<Record<string, unknown>> {
  const readFile = input.readFile ?? ((file) => fs.readFile(file, "utf8"))
  try {
    return validatedAuthStore(
      JSON.parse(
        await readFile(openCodeAuthStorePath(input.env, input.homedir)),
      ),
    )
  } catch {
    return {}
  }
}

/**
 * Whether an OAuth record's stored expiry has already passed. A record with no
 * usable expiry is NOT expired — nothing proves it dead, and the raw inline path
 * can carry one (`oauthRecordOf` drops a non-finite or non-numeric `expires` to
 * `undefined`).
 *
 * Shared on purpose rather than re-written per caller: `readRefreshedAuthStore`
 * has to consult the file for EXACTLY the records a caller would decline. If the
 * two comparisons drifted — a skew tolerance added to one only — the repair
 * would either fire when no decline was coming (superseding a token the caller
 * was about to use) or fail to fire when one was, which is the permanent outage
 * it exists to prevent.
 */
export function oauthExpired(
  record: OauthRecord | undefined,
  now: number,
): boolean {
  return record?.expires !== undefined && record.expires < now
}

/** Provider ids whose OAuth record carries an expiry that has already passed. */
function expiredOauthProviders(store: unknown, now: number): string[] {
  if (!store || typeof store !== "object") return []
  const expired: string[] = []
  for (const providerID of Object.keys(store as Record<string, unknown>)) {
    if (oauthExpired(oauthRecordOf(store, providerID), now)) {
      expired.push(providerID)
    }
  }
  return expired
}

/**
 * A shallow copy with a null prototype, built by assignment so a `__proto__`
 * own property (which `JSON.parse` really does create) lands as an own key
 * instead of re-pointing the copy's prototype — the same care
 * `validatedAuthStore` takes, for the same reason.
 */
function copyAuthStore(store: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  for (const [providerID, entry] of Object.entries(
    store as Record<string, unknown>,
  )) {
    out[providerID] = entry
  }
  return out
}

/**
 * `readAuthStore`, plus the one repair the host's own reader cannot make: an
 * INLINE OAuth record whose expiry has already passed is replaced by a LATER
 * file record for the same provider.
 *
 * This is the store's only deliberate divergence from `Auth.all()`, and it
 * exists because the inline path is a frozen snapshot while OAuth records are
 * not. A control-plane workspace receives its credentials once, as a serialized
 * `Auth.all()` in `OPENCODE_AUTH_CONTENT` (control-plane/workspace.ts:530).
 * When one of those tokens expires the host refreshes it and persists the
 * replacement through `Auth.set()`, which always writes `auth.json`
 * (auth/index.ts:73-83) — but it never rewrites the environment, and
 * `Auth.all()` short-circuits on the variable before it ever opens the file
 * (auth/index.ts:58-67). So the host serves the fresh token from memory while
 * every later `Auth.all()` keeps reporting the expired one, for the lifetime of
 * the workspace.
 *
 * A plugin that only mirrors `Auth.all()` therefore sees a credential that can
 * never come back, and any decline it makes on expiry grounds is permanent
 * rather than temporary — which is exactly what web-search's ChatGPT resolution
 * does (backends/native/auth.ts). Reading the newer file record does not
 * disagree with the host: it is the token the host itself refreshed to and is
 * already using. It CONVERGES with the host, where mirroring diverges.
 *
 * Deliberately narrow, so this can only ever repair staleness:
 *
 * - **Only when the store came from inline.** With no override, the file IS the
 *   store and a refresh is already visible; there is nothing to repair.
 * - **Only providers the inline snapshot already holds.** A provider present
 *   only in the file is NOT signed in as far as the host is concerned, so
 *   adding it would be the merge `Auth.all()` refuses to do.
 * - **Only expired OAuth records**, and only when the file's record is a valid
 *   entry (`validatedAuthStore`) with an access token, the same derivable
 *   account identity, and a STRICTLY later expiry. An unprovable or changed
 *   account fails closed instead of substituting another user's credential.
 *   Copilot rides through untouched: the host stores `expires: 0` for it, so
 *   its record always reads as expired, but the file's copy carries the same
 *   `0` and never wins the comparison.
 * - **Any file trouble leaves the inline store as it was**, and a store with
 *   nothing to repair is returned raw and uncopied.
 */
export async function readRefreshedAuthStore(
  input: AuthStoreInput & { now?: number },
): Promise<unknown> {
  const inline = inlineAuthStore(input.env)
  if (inline === undefined) return fileAuthStore(input)
  const expired = expiredOauthProviders(inline, input.now ?? Date.now())
  if (expired.length === 0) return inline
  const file = await fileAuthStore(input)
  let repaired: Record<string, unknown> | undefined
  for (const providerID of expired) {
    const fresh = oauthRecordOf(file, providerID)
    if (!fresh?.access || fresh.expires === undefined) continue
    const stale = oauthRecordOf(inline, providerID)
    if (!stale) continue
    const staleAccount = oauthAccountId(stale)
    if (!staleAccount || oauthAccountId(fresh) !== staleAccount) continue
    if (fresh.expires <= (stale.expires ?? 0)) continue
    repaired ??= copyAuthStore(inline)
    repaired[providerID] = file[providerID]
  }
  return repaired ?? inline
}

/**
 * One provider's entry of an auth-store-shaped object, or undefined when the
 * store is not an object, holds nothing under that id, or holds a non-object
 * there. The guard every store-indexing parser in the suite opened with.
 */
export function authEntry(
  store: unknown,
  providerID: string,
): Record<string, unknown> | undefined {
  if (!store || typeof store !== "object") return
  const entry = (store as Record<string, unknown>)[providerID]
  if (!entry || typeof entry !== "object") return
  return entry as Record<string, unknown>
}

/**
 * An OAuth entry's fields, each present only when it is usable — a non-empty
 * string, or a finite number for `expires` (unix milliseconds, the host's own
 * unit). Deliberately LENIENT: every field is optional, because its two
 * callers need different ones (codex-limits needs `access` + `expires`,
 * web-search only ever sends `access`, and Copilot's API key IS its `refresh`
 * token), and because the inline override reaches this parser unfiltered by
 * design. Each caller narrows to what it needs; a strict shared parser would
 * have made one of them reject records it serves today.
 */
export type OauthRecord = {
  access?: string
  refresh?: string
  expires?: number
  accountId?: string
  enterpriseUrl?: string
}

/** A provider's entry, when it is an OAuth record. */
export function oauthRecordOf(
  store: unknown,
  providerID: string,
): OauthRecord | undefined {
  const entry = authEntry(store, providerID)
  if (entry?.type !== "oauth") return
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value ? value : undefined
  const expires = entry.expires
  return {
    access: text(entry.access),
    refresh: text(entry.refresh),
    expires:
      typeof expires === "number" && Number.isFinite(expires)
        ? expires
        : undefined,
    accountId: text(entry.accountId),
    enterpriseUrl: text(entry.enterpriseUrl),
  }
}

function jwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return
  // Three dot-separated segments or nothing, the same framing check the host
  // makes (plugin/openai/codex.ts:47-55) before it trusts a payload.
  const parts = token.split(".")
  if (parts.length !== 3) return
  const payload = parts[1]
  if (!payload) return
  try {
    const text = Buffer.from(
      payload.replaceAll("-", "+").replaceAll("_", "/"),
      "base64",
    ).toString("utf8")
    const claims = JSON.parse(text)
    return claims && typeof claims === "object" && !Array.isArray(claims)
      ? claims
      : undefined
  } catch {
    return
  }
}

/**
 * The ChatGPT account id carried in a token's JWT claims, read with the same
 * precedence as the host's `extractAccountIdFromClaims`
 * (plugin/openai/codex.ts:57-63): a top-level `chatgpt_account_id`, the nested
 * `https://api.openai.com/auth` claim, then the first organization. A
 * malformed token yields undefined rather than throwing — one of the tokens
 * fed to it comes straight off the network.
 *
 * Stricter than the host on claim types (a numeric `chatgpt_account_id` falls
 * through here instead of being stringified into a header) and stricter than
 * the copy this replaces on framing (see jwtClaims).
 */
export function accountIdFromToken(token: unknown): string | undefined {
  const claims = jwtClaims(token)
  if (!claims) return
  if (
    typeof claims.chatgpt_account_id === "string" &&
    claims.chatgpt_account_id
  )
    return claims.chatgpt_account_id
  const auth = claims["https://api.openai.com/auth"]
  if (auth && typeof auth === "object") {
    const nested = (auth as Record<string, unknown>).chatgpt_account_id
    if (typeof nested === "string" && nested) return nested
  }
  const organizations = claims.organizations
  if (
    Array.isArray(organizations) &&
    organizations[0] &&
    typeof organizations[0] === "object"
  ) {
    const id = (organizations[0] as Record<string, unknown>).id
    if (typeof id === "string" && id) return id
  }
  return
}

/**
 * The account id an OAuth record identifies: the stored `accountId`, else the
 * one its access token's claims carry. The fallback existed only in
 * usage-limits though web-search's ChatGPT path wanted the same id (audit
 * §2.3), and it is a strict superset of reading the field — the host derives
 * account ids from exactly this token when it mints the record, so a record
 * without the field still resolves to the id the host would have stored.
 */
export function oauthAccountId(record: {
  access?: string
  accountId?: string
}): string | undefined {
  return record.accountId ?? accountIdFromToken(record.access)
}

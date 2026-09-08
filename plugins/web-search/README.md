# @macarons/web-search

An [OpenCode](https://opencode.ai) plugin that replaces the builtin
`websearch` tool with a privacy-first backend chain. The builtin POSTs every
query to hardcoded third-party endpoints (Exa or Parallel, chosen by a
session-id hash); Exa's policy trains on queries, and the Parallel request
carries your session id and active model name. This plugin registers one
search implementation under two ids: an always-visible `web_search`, and a
shadow of the builtin's `websearch` id so the builtin's code can never
serve a query while the plugin is loaded. Enabling the plugin is enabling
search — on every provider, no env flags required.

## The tools

| Tool | What it does |
| --- | --- |
| `web_search` | The primary id, visible on every provider: same parameters as the builtin (`query`, `numResults`, `livecrawl`, `type`, `contextMaxCharacters`), same `websearch` permission action, output produced by the first backend in your chain that answers. |
| `websearch` | The same definition again, under the builtin's id. Wherever the host makes that id visible, this registration replaces the builtin's execution in the session tool map. |

## The backend chain

Backends are tried in `order` (default `searxng → native → exa`). A backend
that is not configured or not applicable is skipped; a backend that errors
falls through to the next; a backend that answers — **including a healthy
"no results"** — ends the chain. Failures a backend declares inside an
HTTP 200 count as errors, not empty answers: a SearXNG response whose
engines were all unresponsive, a JSON-RPC/MCP error envelope from Exa, and
provider-declared search errors all fall through. If everything fails, the
tool returns a per-backend failure report instead of throwing (with
endpoint labels stripped of any userinfo/query credentials), so the model
can react.

1. **searxng** — `GET <url>/search?q=…&format=json` against your own
   [SearXNG](https://docs.searxng.org) instance. Raw result list (title,
   URL, snippet), free, and the query only leaves your network through your
   instance's engine egress.
2. **native** — the **session's own provider's** server-side search:
   Anthropic `web_search`, OpenAI Responses `web_search`, ChatGPT OAuth
   (Codex backend), GitHub Copilot OAuth, or Moonshot/Kimi `$web_search`.
   Returns a synthesized answer with a Sources list. Deliberately stricter
   than the prior art it adapts: a search-capable model on some *other*
   configured provider is never borrowed, so no party that wasn't already
   seeing the conversation sees the query. `opencode-go` and local
   `@ai-sdk/openai-compatible` models have no native search and fall
   through. Credentials come from OpenCode's own provider config and auth
   store; a model tagged `"websearch": "always"` in your provider's model
   `options` is used exclusively, even if it fails. Otherwise the active
   model is tried first; on error, a different model tagged
   `"websearch": "auto"` on that same provider is tried once with the same
   credentials. The first configured model for each flag wins. Both attempts
   share the native timeout; cancellation or a successful answer (including
   no results) stops further attempts. Custom endpoints (provider/model-level
   `api` or `options.baseURL`) and model id aliases (`"fast": { "id":
   "gpt-4.1" }`) are honored for each selected model the way the host resolves
   them.
3. **exa** — the builtin's Exa MCP call (`web_search_exa`, JSON-RPC),
   replicated as a last resort with query-derived arguments only. The
   builtin's Parallel path is **not** implemented — that request is the
   session-id/model-name leak. `EXA_API_KEY` is honored like the builtin
   honors it, and **only toward the default Exa endpoint** — a custom
   `exa.url` never receives the credential implicitly.

## Visibility: always available — drop `OPENCODE_ENABLE_EXA`

OpenCode's registry only offers the **literal id `websearch`** when the
session's provider is `opencode` (Zen) or an enable env flag is set
(`OPENCODE_ENABLE_EXA` / `OPENCODE_ENABLE_PARALLEL`) — and it gates only
that id. The plugin's `web_search` alias is not filtered, so search is
available everywhere the moment the plugin loads. The `websearch` shadow
registration exists purely as a guard: wherever the host does expose that
id, the slot holds this plugin's execute, never the builtin's.

If you previously exported `OPENCODE_ENABLE_EXA=1` to get the builtin
everywhere, drop it once this plugin is installed:

- With the flag set, sessions are offered **both** ids — harmless
  (identical definitions, both this plugin's) but redundant.
- Without the flag, a plugin-load failure **fails closed** off-Zen: no
  search tool at all. With the flag, it fails open — the *builtin* returns,
  pinned to Exa. On Zen sessions the builtin resurfaces after a load
  failure regardless; that is the host's own behavior.

## SearXNG instance prerequisites

The JSON API is opt-in and limiter-guarded upstream, so the instance you
point `searxng.url` at must have:

```yaml
search:
  formats:
    - html
    - json      # 403 for format=json without this
server:
  limiter: false  # the bot heuristics block keyless JSON clients
```

Run such an instance private (localhost/tailnet) — never expose a
limiter-off instance publicly. A 403 from the backend is reported with this
hint.

## The sidebar

The optional **TUI half** adds a transient **Web searches** section to the
session sidebar: one row per search the current session issues, showing the
query, the backend it ran against, and its status as it moves through
`pending → running → complete/error`. A row appears the moment the search is
issued and, once it finishes, lingers for a few seconds (10s by default) before
disappearing — so the section is empty whenever nothing has searched recently.
It is purely a viewer: it reads a small state file the server half writes on
every lifecycle transition (in OpenCode's state directory, outside the
agent-writable project) and never writes anything itself. A remote attach,
which cannot read the server machine's files, hides it entirely.

The server half works without the TUI half — installing the sidebar is
optional.

## Install

Clone the repository as described in the [root README](../../README.md), then
run `bun install && bun setup` from the checkout root. The interactive installer
wires both halves and prompts for the SearXNG URL and the native/Exa backend
toggles. Packages need not be published. After installing dependencies, you can
instead configure the local source paths by hand:

```jsonc
// opencode.json — the server half (required)
{
  "plugin": [
    [
      "file:///path/to/macarons/plugins/web-search/src/index.ts",
      {
        "searxng": { "url": "http://searxng.your-tailnet:8080" }
      }
    ]
  ]
}
```

```jsonc
// tui.json — the sidebar (optional)
{
  "plugin": ["file:///path/to/macarons/plugins/web-search/src/tui.tsx"]
}
```

### Renaming an existing installation

If you installed this plugin as `websearch`, rerun `bun setup` or replace
its package/path entries with `web-search` in both server and TUI config,
keeping the existing options. Quit and restart OpenCode, including attached
TUIs, after updating. Tool IDs (`web_search` and `websearch`), permission
keys, provider search flags, and the existing `websearch` state directory
and activity channel are unchanged.

## Options

Options ride in a `[spec, { … }]` tuple in the relevant `plugin` array.

### Server half (`opencode.json`)

| Option | Default | Meaning |
| --- | --- | --- |
| `order` | `["searxng", "native", "exa"]` | Backend attempt order. Omit for the default. An explicit order keeps only recognized names; if none survive (typo, wrong type), the chain is **empty** and the tool reports the misconfiguration — an explicit order never silently re-enables backends you did not name. |
| `searxng.url` | *(unset)* | Instance base URL. Unset leaves the backend unavailable (skipped). |
| `searxng.timeoutMs` | `10000` | Per-attempt timeout. |
| `native.enabled` | `true` | Allow the active provider's native search. Only literal `true`/absent enables; any other explicit value disables (fail closed). |
| `native.timeoutMs` | `60000` | One deadline for the entire native attempt, including assistant/provider lookup, auth resolution, response-body consumption, and any auto fallback. |
| `exa.enabled` | `true` | Allow the Exa last-resort call. Only literal `true`/absent enables; any other explicit value disables (fail closed). |
| `exa.url` | `https://mcp.exa.ai/mcp` | Exa MCP endpoint (overridable for tests/proxies). An explicit non-string/empty value disables the backend rather than falling back to the real endpoint. `EXA_API_KEY` is never attached to a custom URL. |
| `exa.timeoutMs` | `25000` | Per-attempt timeout (the builtin's value). |

### TUI half (`tui.json`)

| Option | Default | Meaning |
| --- | --- | --- |
| `sidebar` | `true` | Show the **Web searches** sidebar section. When off, the TUI half is fully inert. |
| `visibleMs` | `10000` | How long a completed or errored search stays in the sidebar after it ends (clamped 1000–60000). Live (pending/running) rows always show. |
| `pollMs` | `15000` | How often the TUI re-reads the state file as a fallback (clamped 2000 – 2147483647). A poke from the server half usually refreshes it much sooner. |

## Permissions

The tool asks the same `websearch` permission action as the builtin, with
the query as the pattern and `always: ["*"]` — existing `permission`
config, persist-permissions stores, and approve-for-me behavior carry over
unchanged. Like the builtin, an unconfigured `websearch` action is allowed
by the host's default ruleset; set `"permission": { "websearch": "ask" }`
to be prompted per query.

Tool **visibility** is filtered per tool id, so the plugin's config hook
mirrors literal `websearch` permission keys onto `web_search` (global and
per-agent): rules like `{ "*": "deny", "websearch": "allow" }` keep the
alias exactly as visible as the builtin id — including in the host's
built-in `explore` agent, which hardcodes that shape. An explicit
`web_search` key in your config always wins over the mirror.

## Scope and caveats

- **Output shape varies by backend** (the tool description says so to the
  model): SearXNG returns a result list; native returns a synthesized,
  cited answer; Exa returns Exa's context blob.
- Native search costs provider tokens/fees (order of $10 per 1k searches,
  varies by provider) — one reason SearXNG defaults first.
- Native timeouts fall through to the next configured backend. Tool cancellation
  stops the chain. Both settle promptly even if a lookup or transport ignores
  cancellation; late lookups cannot dispatch a search or replace cached credentials.
- Each search captures the executing assistant's message ID before permission
  approval, then reads its provider/model only if the chain reaches an enabled
  native backend. Newer messages or model switches in a busy session cannot
  redirect an older search. If that assistant cannot be resolved, native search
  logs a warning and falls through without borrowing another model.
- The provider-native adapters are adapted from
  [opencode-websearch](https://github.com/emilsvennesson/opencode-websearch)
  (MIT — see `NOTICE`), rewritten to plain fetch with an
  active-provider-only scope.
- Shadowing and its visibility gate are implicit upstream behavior, pinned
  by this plugin's e2e suite (`tests/e2e/web-search/`) against the pinned
  OpenCode binary.

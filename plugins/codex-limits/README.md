# opencode-codex-limits

An [OpenCode](https://opencode.ai) plugin with server and TUI halves that shows
your **Codex subscription usage windows and reset times in the sidebar**, live
while you use them.

```text
Codex Limits
5h 58% left · resets 14:32
7d 79% left · resets 15 Jul 09:05
```

The section renders between Context and the other live workload widgets. Rows
show remaining quota, colored by usage: muted below 75% used, warning from 75%,
and error from 95%.

## When it appears

The widget appears only when the relevant model uses OpenCode's `openai`
provider and the server's ChatGPT/Codex OAuth identity matches the TUI's local
credentials. An OpenAI API key does not use these subscription windows and
leaves the section hidden, even when the TUI has a separate local OAuth login.

The relevant model is the viewed session's next-turn model when staged through
OpenCode's session API, falling back to its sticky model, last assistant turn,
and then the configured default. The built-in TUI keeps `/models` selections
local until prompt submission, so those selections become visible here once
the session syncs. If
[approve-for-me](../approve-for-me) is enabled with a
pinned OpenAI classifier while the session uses another provider, the same
section appears with a `· classifier` tag.

Data comes from the ChatGPT endpoint used by `codex /status`. It refreshes on a
poll interval and after every completed turn. Transient failures retain the
last snapshot briefly; repeated failures hide it and back off.

### Auth scope

The server companion reads the server-scoped auth store read-only and answers
each fresh TUI challenge with an HMAC identity proof. The TUI uses local OAuth
credentials for quota requests only after verifying a matching, challenge-bound
proof. Tokens and account IDs are never sent through the event bus.
Each process resolves its own `OPENCODE_AUTH_CONTENT` override or auth store;
sharing a hostname or project directory does not make those credentials equal.

A hostname is not proof of a shared auth scope: `opencode.internal`, localhost,
and other loopback addresses can still connect processes with different auth
stores. An API-key server, a different OAuth identity, an invalid or missing
proof, or a missing server companion leaves Codex quota hidden and sends no
usage request. Non-local remote attaches remain disabled even if credentials
would match; the existing remote-bail policy is unchanged. This proof
requirement is Codex-only; Synthetic still uses its server-resolved API key on
loopback.

This integration targets OpenCode's bundled Codex auth loader. A server that
disables default plugins, excludes OpenAI, or explicitly overrides its `fetch`
cannot attest an active Codex login, so the widget stays hidden. Third-party
OpenAI auth-loader or SDK replacements are not supported: the public plugin
API does not expose their effective credential/transport ownership.

The plugin never spends refresh tokens or writes credentials. It waits for
OpenCode's bundled Codex integration to refresh expired OAuth records, then
adopts the replacement on its next tick once the proof matches again.

## Install

Clone the repository as described in the [root README](../../README.md), then
run `bun install && bun setup` from the checkout root and select `codex-limits`.
This uses local source files, not a published package. Alternatively, after
installing dependencies:

```sh
opencode plugin /path/to/macarons/plugins/codex-limits
```

This installs **both halves**, which are required. Existing TUI-only installs
must add the server companion. Alternatively, run `bun setup` from the Macarons
checkout and leave `codex-limits` ticked to repair the missing half without
changing saved TUI options.

To install manually, add the server entry to `opencode.json` on the server:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///path/to/macarons/plugins/codex-limits/src/index.ts"]
}
```

Add the TUI entry to `tui.json` on the TUI machine:

```json
{
  "plugin": ["file:///path/to/macarons/plugins/codex-limits/src/tui.tsx"]
}
```

Merge these entries with any existing plugins. Configuration and plugin code
are loaded at startup: quit and restart OpenCode after installing or upgrading.
For a separate server and attached TUI, restart the server **and** the TUI;
reconnecting a TUI to an old server does not load the new companion. The widget
stays hidden until both updated halves complete the auth proof.

## Options

Options belong only to the TUI entry in `tui.json`; the server half has no
options.

```json
{
  "plugin": [
    ["file:///path/to/macarons/plugins/codex-limits/src/tui.tsx", {
      "interval": 120,
      "providers": {
        "openai": { "endpoint": "https://gateway.example/wham/usage" }
      }
    }]
  ]
}
```

- `interval`: poll interval in seconds, default `60`, minimum `15`.
- `providers.openai.endpoint`: optional ChatGPT usage endpoint override for
  tests or an enterprise proxy.

## Development

```sh
cd plugins/codex-limits
bun run lint
bun test
bun run typecheck
bun run build
```

`src/index.ts` exports the server companion, `CodexLimitsPlugin`.
`src/codex.ts` owns Codex auth and API semantics. The provider-neutral engine,
quota shapes, formatting, polling, and classifier relevance live in
[`libraries/usage-limits`](../../libraries/usage-limits). `src/tui.tsx` keeps
the JSX and Solid imports entry-local so OpenCode supplies the reactive runtime.

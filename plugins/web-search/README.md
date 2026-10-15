# @macarons/web-search

Adds two search capabilities to OpenCode **2.0.29+**:

- **SearXNG** appears as `macarons-searxng` in the native search provider chooser.
- **`provider_search`** uses the requesting assistant's own model provider:
  Anthropic, OpenAI, ChatGPT token-sharing and legacy Codex OAuth, GitHub Copilot,
  or Moonshot/Kimi.

OpenCode v2 supplies the general websearch tool, provider selection, consent,
Exa, and other integrations. Macarons no longer replaces those features, registers
`web_search` aliases, adds a search sidebar, or implements a fallback to Exa.

## Install

Run `bun install && bun setup` from the checkout root, or add to `opencode.json`:

```jsonc
{
  "plugins": [{
    "package": "file:///path/to/macarons/plugins/web-search",
    "options": {
      "searxng": { "url": "http://localhost:8080", "timeoutMs": 10000 },
      "native": { "enabled": true, "timeoutMs": 60000 }
    }
  }]
}
```

There is no TUI plugin. Restart the server after changing options. SearXNG is
available only when its URL is configured. Its instance must enable JSON search
responses. Select it through the host's chooser or configure
`"websearch": {"provider": "macarons-searxng"}` in the server configuration.
Successful empty results remain empty; HTTP errors and failed search engines
are reported to the native search service.

## Same-provider search

`provider_search({query})` uses the native tool context to identify the requesting
assistant, checks the `websearch` permission, and reads fresh server-side
credentials through v2's integration connection API. It never borrows a model
from a different provider. A missing requesting model fails without sending the
query. Provider/model endpoint overrides, headers, aliases, and variants are
honored; subscription OAuth credentials are refused on unrelated endpoints.

The current model is tried first. A model on that same provider with
`settings.websearch: "auto"` is retried after a failure; a model tagged
`"always"` is used exclusively. Both attempts share one timeout. A successful
empty answer or cancellation ends the operation. Provider-native search may
incur provider usage charges.

This is a separate narrow tool because v2 websearch provider callbacks lack
session/model identity. Putting it into that chooser would lose the privacy
boundary. Built-in search continues to use the user's native provider selection.

Legacy `order` settings restrict which remaining capabilities are enabled, but
no longer create a chain. For example `order: ["searxng"]` disables native
provider search. `exa` options have no effect. The installer reports these old
settings during migration. Configure Exa directly in OpenCode if desired.

Adapted native wire adapters retain their MIT attribution in [NOTICE](NOTICE).

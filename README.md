# Macarons

Macarons is a collection of focused plugins for [OpenCode v2](https://opencode.ai/v2/docs/).
The current target is **OpenCode 2.0.29**, pinned in [`.opencode-version`](.opencode-version).
V1 plugin implementations are no longer included in the active suite.

## Install or migrate

Install OpenCode v2, Git, and [Bun 1.3.14](https://bun.sh). If upgrading from v1,
start OpenCode v2 once so it can migrate your terminal preferences to `cli.json`.
Then run:

```sh
git clone https://github.com/mcolsen/macarons.git
cd macarons
bun install && bun setup
```

Select plugins with **space**, press **enter** to review, then confirm with **y**.
Restart OpenCode and any separately running server. `bun setup --dry-run` previews
changes without writing.

The installer edits user-level `opencode.json(c)` and `cli.json`, using native
`plugins` entries and package-directory `file://` URLs. It preserves unrelated
settings and JSONC comments, migrates existing Macarons options, and removes
entries for retired Macarons plugins. It does not install OpenCode or configure
model credentials. See the [installer guide](tools/installer/README.md).

Keep this checkout and its `node_modules` in place: OpenCode loads these source
packages directly. No build or publication is required for this installation.

## Plugins

| Plugin | What it adds to v2 |
| --- | --- |
| [cron](plugins/cron/README.md) | One-shot and recurring prompts delivered through the native session queue. |
| [approve-for-me](plugins/approve-for-me/README.md) | Model-based review of permission requests, with guarded local controls. |
| [redact-secrets](plugins/redact-secrets/README.md) | Detect and mask secrets in outbound session requests; restore placeholders before local tool execution. |
| [web-search](plugins/web-search/README.md) | A SearXNG integration for native websearch and same-provider search through `provider_search`. |
| [scoped-system-prompts](plugins/scoped-system-prompts/README.md) | Ordered replace/prepend/append system-prompt rules for exact provider/model pairs. |
| [codex-limits](plugins/codex-limits/README.md) | Server-authenticated Codex subscription quota widgets. |
| [synthetic-limits](plugins/synthetic-limits/README.md) | Server-authenticated Synthetic subscription quota widgets. |
| [cache-ratio](plugins/cache-ratio/README.md) | Live cache-health ratios, prefix-loss alerts, and expiry detection. |

OpenCode v2 now supplies background shell work, background subagents and their
management tab, `/btw`, and persisted permission approvals. Macarons retires
`background-tasks`, `subagent-comms`, `subagents-sidebar`, `btw`, and
`persist-permissions`. The deliberately dropped extras and source comparison are
recorded in [the migration notes](MIGRATION.md).

## Behavior to know

Approve for Me starts enabled when installed. Its model judgments can be wrong;
it is not a sandbox. V2 lacks reliable provenance for expanded user commands,
so authorization-dependent high-risk actions remain for manual approval.
Its controls require proof that the TUI and server share the trusted filesystem.

Secret redaction is defense in depth. It keeps prose placeholders in v2 because
the host has no completed-text restoration hook. Local tools still receive
restored values. See its README for coverage and detection limits.

Cron schedules remain session-only and recurring schedules expire after seven
days. A due prompt enters the native queue when the session is idle; this is not
a durable exact-time scheduler.

Web search uses OpenCode's native selection, permission, and consent UI for
SearXNG and built-in integrations. `provider_search` sends its query only to the
requesting model's provider. Macarons no longer shadows native websearch or
implements Exa fallback.

## Update or remove

Stop OpenCode and any separately running server, then run:

```sh
git pull --ff-only
bun install && bun setup
```

Untick plugins in the wizard to remove their managed entries. Remove all entries
before deleting the checkout. Plugin-owned settings, saved approvals, and other
data are preserved. Remove any project-local entries you added separately.

See [CONTRIBUTING.md](CONTRIBUTING.md) for verification and the repository layout.
Report issues at [GitHub](https://github.com/mcolsen/macarons/issues), including
OpenCode/Bun versions, enabled plugins, and local versus remote setup. Remove
credentials and private conversation content from logs before sharing.

## License

[MIT](LICENSE). Vendored betterleaks rules retain their
[upstream attribution](plugins/redact-secrets/vendor/betterleaks/PROVENANCE.md).

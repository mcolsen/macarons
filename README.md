# Macarons

Macarons is a small collection of plugins for [OpenCode](https://opencode.ai).
Each plugin is designed to solve a focused problem without getting in your way.
Use the whole box or just pick the ones you like.

## Install

You need [Git](https://git-scm.com), [Bun 1.3.14](https://bun.sh), and an existing
OpenCode installation. The current tested OpenCode version is **1.18.14**, pinned
in [`.opencode-version`](.opencode-version). Use that version for the verified
baseline; the broader package engine range is not a promise that every host
version has been tested.

Clone into a permanent location, then run the installer in an interactive terminal:

```sh
git clone https://github.com/mcolsen/macarons.git
cd macarons
bun install && bun setup
```

1. Use the arrow keys to move and **space** to select plugins.
2. Press **enter** to review the changes and any plugin-specific options.
3. Confirm with **y**, then restart OpenCode. If you use a separate server,
   restart the server and every attached TUI together.

The installer adds local `file://` entries to your **user-level OpenCode
configuration** and preserves unrelated settings and JSONC comments. It does
not install OpenCode or configure your model providers. No build or npm package
publication is needed for this installation path.

**Keep the checkout and its `node_modules` in place.** OpenCode loads the plugins
from this directory, not from a copied installation. Moving or deleting it will
break those entries.

To preview without writing, run `bun setup --dry-run`. Nothing is written until
you explicitly confirm a normal interactive run. See the
[installer guide](tools/installer/README.md) for custom config directories,
config-file precedence, migration, and safeguards.

## Choose Your Plugins

Follow a plugin's link for its commands, configuration, and limitations.

| Plugin | What it adds |
| --- | --- |
| [background-tasks](plugins/background-tasks/README.md) | Run long-lived shell commands while the agent keeps working, with completion notifications and a task list. |
| [subagent-comms](plugins/subagent-comms/README.md) | Spawn background subagents, choose their models, send follow-ups, and receive their results. |
| [subagents-sidebar](plugins/subagents-sidebar/README.md) | See subagent progress and permission waits; use `/subagents` to jump into their sessions. |
| [cron](plugins/cron/README.md) | Schedule one-shot or recurring prompts that return to the session while it is idle. |
| [btw](plugins/btw/README.md) | Ask side questions about the conversation without adding them to the main thread, even while the agent is working. |
| [persist-permissions](plugins/persist-permissions/README.md) | Remember permission approvals across sessions, with an optional edit-before-approve flow. |
| [approve-for-me](plugins/approve-for-me/README.md) | Let a model review permission requests and approve those its risk and authorization policy permits. |
| [redact-secrets](plugins/redact-secrets/README.md) | Replace detected secrets with placeholders in outbound model requests and restore them locally when needed. |
| [web-search](plugins/web-search/README.md) | Search through SearXNG, supported provider-native search, and an optional Exa fallback. |
| [scoped-system-prompts](plugins/scoped-system-prompts/README.md) | Replace, prepend, or append system prompts for specific provider/model pairs. |
| [codex-limits](plugins/codex-limits/README.md) | Show Codex subscription usage windows and reset times in the sidebar. |
| [synthetic-limits](plugins/synthetic-limits/README.md) | Show Synthetic subscription quotas and regeneration times in the sidebar. |
| [cache-ratio](plugins/cache-ratio/README.md) | Track prompt-cache hit ratio and warn about apparent cache-prefix breaks. |

## Before Enabling

- **Approve for Me starts enabled when installed.** It makes additional model
  requests and can approve actions without asking you. Model risk judgments can
  be wrong; this is not a sandbox. Review its
  [trust model](plugins/approve-for-me/README.md#the-trust-model), especially
  before choosing a classifier on a different provider. Use `<leader>d` to
  pause it for the running instance.
- **Secret redaction is defense in depth, not a guarantee.** Detection has
  [known gaps](plugins/redact-secrets/README.md#limits-worth-knowing), and local transcripts
  and tool execution can still contain real secrets. It does not replace access
  controls or credential hygiene.
- **Web search sends queries to the enabled backends.** Provider-native search
  and the Exa fallback default to on; the installer lets you disable either and
  optionally supply your own SearXNG URL. Review the plugin's
  [privacy details](plugins/web-search/README.md).
- **Cron schedules are session-only.** They disappear on restart or session
  deletion; recurring jobs expire after seven days. Prompts wait until the
  session is idle, so this is not a durable or exact-time scheduler.
- **Stop important background work explicitly before quitting.** Stock OpenCode
  1.18.14 has a shared shutdown deadline that can interrupt process cleanup.
  See [the known host limitation](tests/e2e/background-tasks/SHUTDOWN.md).

Some features require local server/TUI access or a shared filesystem. For remote
attach setups, check the relevant plugin's limitations, particularly
[Codex auth scope](plugins/codex-limits/README.md#auth-scope) and
[Approve for Me](plugins/approve-for-me/README.md). A hidden or unavailable widget
can be a deliberate safety check rather than a failed installation.

## Update Or Remove

To update, stop OpenCode (including separate servers and attached TUIs), then
run these commands from your checkout:

```sh
git pull --ff-only
bun install && bun setup
```

Leave the plugins you want selected, review any changes, and restart OpenCode.
Updating both server and TUI code together matters for permission controls and
authentication checks.

To remove plugins, run `bun setup`, **untick** them, confirm, and restart
OpenCode. Remove all entries before deleting the checkout. The wizard removes
managed config entries, not plugin-owned settings, stored approvals, or other
data. It does not manage project-local or remotely supplied configuration;
remove any entries you added there separately.

Existing pre-Macarons installations can use the same wizard to migrate old
package names while preserving their options. See
[migration details](tools/installer/README.md#configuring-a-plugin-at-install-time).

## Help And Development

If a plugin does not appear, restart both OpenCode halves, check that the checkout
still exists, and review `bun setup`'s selected plugins. Symlinked config files
are deliberately refused by the installer; edit their targets manually instead.

Report bugs or request features in
[GitHub Issues](https://github.com/mcolsen/macarons/issues). Include the plugin,
OpenCode and Bun versions, operating system, local versus remote setup, and a
minimal reproduction. Remove credentials and private conversation content from
logs before sharing them.

For repository checks, real-host tests, and the package layout, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Vendored betterleaks rules retain their
[upstream attribution](plugins/redact-secrets/vendor/betterleaks/PROVENANCE.md).

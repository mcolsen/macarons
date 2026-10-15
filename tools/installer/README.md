# @macarons/installer

Interactive install, migration, and removal for Macarons on OpenCode v2.
From the repository root:

```sh
bun install
bun setup
bun setup --dry-run
```

Use the OpenCode release pinned in [`.opencode-version`](../../.opencode-version).
If upgrading an existing OpenCode installation, **start OpenCode v2 once before
running the wizard**. The host migrates its own `tui.json` and saved UI settings
into `cli.json`; the wizard refuses to create `cli.json` while those legacy
settings still need migration.

The wizard shows available plugins as checkboxes. Move with ↑/↓ or j/k,
toggle with space, and press enter to review. Escape, q, Ctrl-C, or Ctrl-D
cancel. The review lists every affected file and plugin; `Apply these changes?
[y/N]` defaults to no. `--dry-run` prints the plan without writing. Outside an
interactive terminal the command only prints installation status.

## OpenCode v2 configuration

The configuration directory is `OPENCODE_CONFIG_DIR`, otherwise
`$XDG_CONFIG_HOME/opencode`, otherwise `~/.config/opencode`.
`--config-dir DIR` replaces that directory for this run.

- Server plugins use `plugins` in `opencode.json` or `opencode.jsonc`. Both
  documents contribute entries. The wizard prefers an existing document,
  defaulting to `opencode.jsonc`.
- TUI plugins use `plugins` in global `cli.json`. OpenCode v2 does not load
  `tui.json` or `tui.jsonc` as active plugin configuration.
- Local entries point at **package directories** using `file://` URLs.
  OpenCode v2 resolves their server and TUI entry points. Keep the checkout
  in place after installing and restart OpenCode after changes.
- Plugin options use the v2 form `{ "package": "file:///...", "options": {...} }`.
  Entries without options are strings.

These rules were verified against the tagged OpenCode v2.0.29 source:
[`config/discovery.ts`](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/config/discovery.ts),
[`config/plugin/source.ts`](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/config/plugin/source.ts),
and [`cli/config/config.ts`](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/config/config.ts).
A regression test requires rechecking the rules when the pinned minor line changes.

## Upgrading existing Macarons entries

Leaving a plugin checked migrates its old declarations to native v2 package
directories. The wizard recognizes source-file paths, directory paths,
relative paths, package names, versions, npm aliases, legacy `[spec, options]`
tuples, and v2 objects. Former `@mcolsen-opencode` names and renamed plugins
are recognized too. Saved options are preserved. Conflicting saved options
stop the run before writing instead of choosing which configuration to discard.

Unchecking removes every matching loading declaration from the inventoried files,
including both `plugin` and `plugins` arrays. Native disable selectors are retained
so uninstalling cannot reactivate an auto-discovered plugin. Inventory includes old
`config.json`, `tui.json`, `tui.jsonc`, and `~/.opencode` configuration so stale
Macarons entries cannot survive the migration. Unrelated plugins and settings
remain in their original files.

OpenCode v2 replaces `background-tasks`, `subagent-comms`, `subagents-sidebar`,
`btw`, and `persist-permissions`. These packages are not offered for installation;
the reviewed plan removes their old declarations automatically.

The wizard manages user-level files only. Project configuration, managed system
configuration, remote well-known configuration, auto-discovered plugin
directories, and `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`,
`OPENCODE_CLI_CONFIG_CONTENT` overrides require separate editing. Home
`~/.opencode` is inventoried for migration, even though v2 discovers it only
when it is a project ancestor. Environment overrides produce an explanatory note.

## Configuration and safeguards

A first installation of `web-search` asks for its SearXNG URL and enabled
backends. Defaults need no saved options. Existing installations keep their
saved options and are not prompted again. The preview shows newly collected
options before confirmation.

The wizard preserves JSONC comments, unrelated properties, and existing file
permissions. All changed documents are rendered and validated before writing.
Existing files use atomic replacement; newly created files use create-only
publication. The full inventory is rechecked before every publication so an
editor's concurrent changes abort a stale plan. Symlinked config files are
refused with guidance to edit their targets; symlinked configuration directories
containing regular files work.

Writes are atomic per file, not a transaction across files. A late failure can
leave earlier files changed. Resolve the conflict and rerun to recompute the
remaining edits; the wizard does not restore snapshots over another editor's
work. No credential-bearing backup copies are created.

## Development

```sh
cd tools/installer
bun test
bun run typecheck
bun run lint
```

[`src/core.ts`](src/core.ts) handles discovery, matching, migration plans, and
validated writes. [`src/config.ts`](src/config.ts) collects plugin options;
[`src/wizard.ts`](src/wizard.ts) provides the checkbox interface; and
[`src/cli.ts`](src/cli.ts) coordinates review, cancellation, and publication.

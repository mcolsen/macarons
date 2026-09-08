# @macarons/installer

The interactive install/uninstall wizard for Macarons. Tick the plugins you
want, untick the ones you don't, and your **user-level OpenCode configuration**
is updated to match — no hand-editing of `opencode.json` and `tui.json`.

Start with the [clone and install instructions](../../README.md#install).
The wizard does not install OpenCode or check its version: use the tested v1
release in [`.opencode-version`](../../.opencode-version). Installing config
entries successfully does not establish host compatibility; the plugins disable
themselves on unsupported major versions.

```sh
bun install            # once, from the repo root
bun setup
```

```text
  Macarons plugin installer
  user-level config: /home/you/.config/opencode

  › [x] persist-permissions    (will install)  — persists "always allow" approvals across sessions

  ↑/↓ move · space toggle · a all · enter review · q/esc/^c/^d cancel
  1 pending change
```

- **↑/↓** (or `j`/`k`) move · **space** toggle the focused plugin · **a** toggle all ·
  **enter** review · **q**/**esc**/**Ctrl-C**/**Ctrl-D** cancel without writing
  anything.
- A plugin with any config entry starts **ticked**; unticking it and continuing
  uninstalls it. `(will install)` / `(will remove)` tags preview each change,
  then the wizard prints any fresh-install options and the affected files
  before asking for final confirmation. Nothing is written until that
  confirmation is accepted.

## Which files OpenCode loads plugins from

OpenCode assembles the active plugin set from **several config files at once**,
so the wizard models each source class the way the host does (rules verified
against the pinned OpenCode source; a test pins the verified version line so a
host bump re-checks them):

- **The config directory** — `OPENCODE_CONFIG_DIR` if set, else
  `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. Setting
  `OPENCODE_CONFIG_DIR` *replaces* the default directory: the default is then
  never read. Inside the directory, `config.json` < `opencode.json` <
  `opencode.jsonc` are deep-merged with **later-file-wins** semantics, and a
  `plugin` array *replaces* a lower file's array — but a file that *omits* the
  key inherits the array from below it. In a custom (`OPENCODE_CONFIG_DIR`)
  directory, `opencode.json` and `opencode.jsonc` are *additionally* loaded as
  independent origins, so entries in **both** are active regardless of the
  merge.
- **`~/.opencode`** — its `opencode.json` and `opencode.jsonc` are further
  always-active origins, in every mode.
- **TUI config** — `tui.json` **and** `tui.jsonc` both load, in the config
  directory and in `~/.opencode`; all of their entries are active.

What the wizard does with that model:

- **Installing** writes the file whose entry actually takes effect: for the
  server half, the file whose `plugin` array wins the merge (so it never adds
  a `plugin` key that would mask another file's plugins), defaulting to
  `opencode.jsonc` when none exists; for the TUI half, `tui.json` (or
  `tui.jsonc` when that is the only TUI file you keep).
- **Uninstalling** removes the plugin's entries from **every** file above —
  including entries the merge currently masks — so no active or latent origin
  is left behind. This matters most for plugins like the
  approve-for-me auto-approver, which must not keep loading after
  the wizard reports it removed. A file swept down to its last entry keeps an
  explicit `"plugin": []` (as OpenCode's own config writer does) rather than
  losing the key, so an uninstall never changes which file wins the merge —
  and never unmasks (silently activates) entries a lower file still lists.

Sources the wizard deliberately does **not** manage: per-project `.opencode`
directories, `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` /
`OPENCODE_TUI_CONFIG`, and remote (well-known) configs. It prints a note when
one of those env flags is set.

Entries are written as `file://` URLs pointing at this checkout's `src/index.ts`
and `src/tui.tsx` — the same form the plugins' own [Option B](../../plugins/persist-permissions#readme)
install documents. Because the entries point into this checkout, keep it in
place after installing and run `bun install` here once so the plugins' workspace
dependencies resolve. Restart OpenCode to load a change.

A plugin ships a **server half**, a **TUI half**, or both; a tick installs each
half the plugin exposes, and a plugin with only one half (e.g. the TUI-only
`synthetic-limits`) touches only that half's files. `codex-limits` requires both
halves for its auth identity proof: leave it ticked to add the server companion
to an older TUI-only install. Existing TUI options stay on the TUI entry; the
new server entry takes no options. Restart both the server and TUI after this
upgrade, including any separately running `opencode serve` process.

## Configuring a plugin at install time

Most plugins can start with their defaults. The wizard currently prompts for
options for one plugin:
[`web-search`](../../plugins/web-search#readme) accepts options that pick its
backends. When you tick it **for the first time**, the wizard (after you press
**enter** on the checkbox list, before it writes anything) asks a few short
questions:

```text
Configure web-search (enter accepts each default):
  SearXNG instance URL (blank to skip SearXNG): http://searxng.your-tailnet:8080
  Enable provider-native web search? [Y/n]:
  Enable Exa last-resort search? [Y/n]: n
```

- The **SearXNG URL** is the one value with no sensible default; leaving it
  blank simply drops SearXNG from the chain.
- The two backend toggles default to **on** — press enter to keep them, or
  answer `n`/`no` to keep queries off a provider entirely. Yes/no prompts
  accept only `y`/`yes`/`n`/`no` (in any case); other text is prompted again.

The answers are written as the options half of a `[spec, options]` entry, and
**only the values you changed from a default are recorded** — accept every
default and the entry is a plain string, identical to any other plugin's. The
planned entry is shown in the change preview before you confirm, so you see the
exact options that will land. The plugin itself validates and fills in
everything else at load time, so hand-editing the written entry later works
exactly as its README documents.

After the preview, `Apply these changes? [y/N]:` is the only action that can
start writes. It defaults to **no** (pressing enter cancels); answering `y` or
`yes` applies the plan. `n`/`no`, EOF, and Ctrl-C all cancel with no files
written. A dry run prints the same plan and exits before this confirmation.
Ctrl-C also cancels cleanly while moving between the configuration, review,
and confirmation phases.

Configuration safeguards:

- **Only a *fresh* install is prompted.** Re-ticking a plugin that is already
  installed leaves its existing options untouched. Repairing a merge-masked
  half copies its complete saved tuple to the active entry, changing only the
  spec to this checkout. The wizard neither reapplies fresh defaults nor
  prompts for or echoes the saved option values.
- **Conflicting saved declarations stop the run.** When no declaration for a
  half is currently active, all matching saved declarations must be identical
  after canonicalization. Any difference — including a bare entry versus a
  tuple — refuses the repair before preview, confirmation, rendering, or any
  write. Keep only the intended configuration, or make the declarations
  identical, before retrying. Alternatively, rerun the wizard and untick the
  plugin to remove all of its entries instead. The installer never silently
  merges options or chooses defaults.
- **Configuration needs the interactive prompt.** A non-interactive run (piped
  stdin or stdout, CI) only reports status; it never guesses options.

The wizard is careful with a config you already have:

- **Other keys — and your comments — are preserved.** An existing file is
  edited in place with the same comment-preserving JSONC editor OpenCode itself
  uses (`jsonc-parser`), so your `model`, `permission`, provider blocks,
  `// comments`, and trailing commas all survive; only the `plugin` array is
  rewritten. Every rewrite is validated to round-trip **before any file is
  written** — a multi-file uninstall validates all of its rewrites up front, so
  an installer bug can never leave the sweep half-applied — and each existing-file
  rewrite is atomic (temp file + rename) with the original file's permission bits
  preserved (a `0600`-protected config carrying provider credentials stays
  `0600`). If a run is interrupted mid-write anyway (crash, full disk), simply
  re-run the wizard: it recomputes from what is on disk and finishes the sweep.
- **Concurrent config edits abort the stale plan.** After confirmation, every
  inventoried file is checked against its original text and existence before
  any write, including files the plan does not rewrite. A conflict names the
  affected path and asks you to rerun the wizard to review a fresh plan; a file
  that can no longer be read gets the same guidance. The whole inventory is
  checked again after staging each write, with earlier writes compared against
  the installer's own output. Newly created configs use create-only publication
  so another writer's file cannot be replaced. These are optimistic checks, not
  a filesystem transaction: an existing file can still change between its last
  check and rename, and a non-target source changed after its last check can
  still invalidate which plugins load. A conflict during a multi-file apply can
  leave earlier writes applied. Rerun rather than restore old snapshots; the
  wizard does not roll back over another editor's work.
- **It detects any install form.** A plugin counts as installed whether your
  config references it by `src` entry, by package directory, by the scoped
  package name (including versions and npm aliases), by a `./relative` path
  (resolved against the declaring file, as OpenCode does), or inside a
  `[spec, options]` tuple — so `opencode plugin` installs and hand-written
  entries are recognized, and unticking removes every referencing entry.
- **It migrates pre-Macarons package names.** Entries under the former
  `@mcolsen-opencode` scope count as the corresponding `@macarons` plugin.
  Leave the plugin ticked to replace every old and current declaration for
  each half that still has an old name with this checkout's source, preserving
  each tuple's options and its config order, or untick it to sweep both
  identities. If several declarations configure the same plugin, OpenCode's
  normal last-origin precedence still decides which complete entry takes
  effect; the installer never guesses how to merge plugin-owned option
  objects.
- **It recognizes renamed plugins.** `permissions-approve-for-me` is now
  `approve-for-me`, and `websearch` is now `web-search`. Old scoped package
  names and paths under this checkout's old plugin directories are migrated
  by the same flow, preserving both server and TUI options. Leave the plugins
  ticked and confirm the plan, then restart the server and all attached TUIs.
  Persisted approval settings and state remain at their existing paths.
- **Approve for Me runs last within each managed server plugin array.** Its
  classifier isolation must follow system-prompt injectors such as `scoped-system-prompts`,
  regardless of alphabetical display order. Other entries and each plugin's
  option precedence keep their relative order. If plugins also load from
  unmanaged or later config origins, keep those prompt injectors ahead of
  Approve for Me there as well.
- **It refuses what it can't safely rewrite.** A config file with genuine
  syntax errors (not comments — those are fine) is reported and left untouched
  rather than clobbered.
- **Symlinked config files are refused, not replaced.** If any inventoried
  config file is a symlink (including a dangling one), the wizard stops before
  making changes and names that path. This also applies to status and dry-run
  invocations. Add or remove plugin entries directly in the symlink's dotfiles
  target instead; the installer leaves the link, target contents, and target
  permissions untouched. A symlinked config directory containing regular
  config files is supported. Paths are checked again after confirmation and
  before each atomic rewrite is published. Writes are atomic per file, not
  transactional across files: a link introduced after writing starts can stop
  the sweep after earlier files have changed. Any symlinked config still needs
  to be handled before retrying; re-running alone cannot bypass the refusal.
- **A half-install (or a masked entry) is repaired.** Ticking a plugin whose
  server half is present but TUI half is missing (or vice versa), or whose
  only entry is masked by the config merge, adds exactly what is needed to
  make it active.

## Options

```sh
bun setup --dry-run        # show the plan, skip confirmation, write nothing
bun setup --config-dir DIR # use DIR as the config directory
bun setup --help
```

`--config-dir` behaves exactly like `OPENCODE_CONFIG_DIR`: it replaces the
default config directory (and `~/.opencode` remains in the inventory).

Run outside an interactive terminal (including redirected stdin or stdout), the
wizard cannot safely show a checkbox list, so it prints the current install
status — flagging `inactive` leftovers whose entries exist but would not load,
along with the config files those entries live in — and exits without changing
anything.

## Development

```sh
cd tools/installer
bun test          # core, prompt, CLI orchestration, and validated atomic-write coverage
bun run typecheck
bun run lint
```

Runtime dependencies are [`jsonc-parser`](https://www.npmjs.com/package/jsonc-parser)
for reading and comment-preservingly editing `.jsonc` configs, and the shared
[`@macarons/permission-rules`](../../libraries/permission-rules) library.

The package is split so the decisions are testable without a terminal:
[`src/core.ts`](src/core.ts) is side-effect-light and unit tested (plugin
discovery, config-source discovery per host mode, the host's active-entry merge
model, entry matching across every install form, the add/remove plan — including
attaching install-time options as a `[spec, options]` tuple — and the validated
atomic writer, with integration fixtures proving an uninstall leaves no active
origin behind); [`src/config.ts`](src/config.ts) holds the install-time
configuration decisions (which plugins are configurable, the pure
answers→options builder, and strict yes/no prompting) behind an injectable
prompter, so the whole prompt flow is unit tested without a TTY;
[`src/wizard.ts`](src/wizard.ts) is the thin raw-mode checkbox layer; and
[`src/cli.ts`](src/cli.ts) wires them together — including cancellation-safe
readline prompts, final confirmation, and CLI-level no-write tests.

# opencode-persist-permissions

An [OpenCode](https://opencode.ai) plugin that makes **"always allow" permission approvals persist across sessions**, the way Claude Code persists them in `.claude/settings.local.json`. An optional TUI companion adds Claude Code's other trick: **editing the allow pattern before approving** (approve `docker compose up -d`, persist `docker compose up *` — or anything you type).

Out of the box, OpenCode only remembers an "always" approval in memory: restart the OpenCode server and every `git status`, `npm test`, and file edit asks again. This plugin saves those approvals to a project-keyed store in OpenCode's trusted config directory and silently re-approves matching requests in future sessions. One repository gets one store: approvals persist across the primary checkout and all of its linked `git worktree`s, not just the checkout they were answered in.

## How it works

OpenCode's server emits an event for every permission prompt and every answer. The plugin:

1. **Persists approvals, as narrowly as possible** — when you answer **always**, the plugin catches the `permission.replied` event and writes an allow rule to the trusted project store. It saves the *narrowest* interpretation of your approval: where OpenCode shows you concrete patterns to remember (bash's `git status *`, external-directory globs, `mcp:server:*`), those are saved verbatim; where OpenCode would remember a blanket `*` for the whole tool (read, edit, glob, grep, webfetch, …), the plugin saves the request's specific patterns instead — the file path you approved editing, the URL you approved fetching — never tool-wide access. Keeping authorization state outside the worktree prevents an agent with ordinary project-edit access from granting itself broader permissions.
2. **Re-approves on later sessions** - when a `permission.asked` event arrives and *every* requested pattern is already allowed by the saved rules, the plugin answers through the OpenCode API before you see the prompt. It always answers **once**, even for broad saved rules. An "always" reply would add host remember-rules that could override saved ask/deny exceptions or session restrictions, including for other pending requests. Instead, each matching request is checked against the current store and session rules and re-approved individually.

Pattern matching replicates OpenCode's own permission semantics exactly: `*` and `?` wildcards, `~`/`$HOME` expansion, **last matching rule wins**, and a rule ending in `" *"` also matches the bare command (`git status *` matches `git status`).

## Editing the allow pattern before approving (optional TUI companion)

In Claude Code, "always approve" lets you edit the rule being saved — approve `docker compose up -d` but persist `docker compose up *`, or widen it to `docker *`. OpenCode's built-in prompt has no such affordance (its "Allow always" confirm step shows the patterns but they are not editable), but the OpenCode TUI is pluggable, so this repo ships a TUI companion (`src/tui.tsx`) that adds the flow:

1. While a permission prompt is on screen, a `ctrl+o edit pattern & always allow` hint line appears right beneath it. Press **`ctrl+o`** (the `ctrl+x p` leader chord works too), or run **Edit allow pattern & always allow** from the command palette.
2. A dialog opens pre-filled with the pattern this plugin would persist — `docker compose up *` for a `docker compose up -d` command, the file path for an edit, the URL for a webfetch. Edit it freely; `*` and `?` wildcards work anywhere. The dialog says what confirming does: it saves a persistent allow rule, not a one-time approval.
3. Confirm. The rule is written to the trusted project store and the pending request is approved with **once**. The saved rule is still persistent; the reply deliberately adds no host remember-rule that could bypass other saved exceptions or session restrictions. Later matching requests are re-approved by the server half as they arrive.

Dismissing the dialog (esc) or confirming an empty pattern leaves the prompt untouched and saves nothing.

The flow is **always persistent**, no matter which option the host prompt has highlighted. The prompt defaults to *Allow once*, and a plugin cannot see — let alone gate on — the highlighted option (the prompt is closed UI), so `ctrl+o` works the same while *Allow once* is selected. That is why the hint, the palette entry, and the dialog all say "always allow": for a genuine one-time approval, answer the prompt normally and skip `ctrl+o`.

### Installing the TUI companion

The easiest way is the one-command install described under [Install](#install) — it configures the TUI companion and the server half together. To configure manually instead: TUI plugins live in `tui.json` — project-local `.opencode/tui.json` or the global OpenCode config directory:

```json
{
  "plugin": ["file:///path/to/macarons/plugins/persist-permissions/src/tui.tsx"]
}
```

Pointing at the package directory (`plugins/persist-permissions`) also works (the package's `./tui` export routes it). Do **not** copy `src/tui.tsx` into `.opencode/plugin/` — that directory is scanned for *server* plugins and this module is TUI-only. The server half must be installed as well; re-approving saved rules in later sessions is its job.

The TUI edits permission files only after verifying shared filesystem access with the enforcing server. It sends a fresh challenge over the host API, reads the server's short-lived, owner-only proof files in the config and project directories, writes a fresh response into them, and reads back the server's acknowledgement. This round trip verifies both directions, not just readable copies of server files. Matching path strings, an internal hostname, or a loopback URL do not establish locality: tunnels and containers can expose different storage at the same paths. The proof is checked again after an edit dialog and before save notifications. Without it, the edit flow neither writes a store nor replies to the pending request, and local files cannot confirm a remote durable save. The server half and OpenCode's normal permission prompt remain active and unchanged. Update both halves and restart OpenCode; an older server half cannot answer the proof challenge.

Options go in a `[spec, options]` tuple:

```json
{
  "plugin": [
    ["file:///path/to/macarons/plugins/persist-permissions/src/tui.tsx", { "keybind": "ctrl+o,<leader>p", "hint": true }]
  ]
}
```

- `keybind` — key(s) for the command, comma-separated alternatives (default `ctrl+o,<leader>p`). `"none"` or `false` removes the binding, leaving only the palette entry. Single strokes (`"ctrl+alt+a"`) and `<leader>` chords work; multi-stroke sequences like `"ctrl+x ctrl+p"` do not — OpenCode's keymap only supports sequences through the `<leader>` token.
- `hint` — show the hint line under pending permission prompts. Default `true`; it only renders when a keybind is configured.
- `notify` — when you answer **always** through the host prompt (without the edit dialog), toast what was persisted, e.g. `Saved git status * to the repository's shared permission store — persists across sessions and worktrees.` (or `…to this project's permission store — persists across sessions.` when the store is not repository-shared: `scope: "worktree"`, or a folder git does not place in a repository). Default `true`. OpenCode's own confirm step says the approval lasts *"until OpenCode is restarted"* — that text is hard-coded and a plugin cannot change it, but with this plugin installed the approval is in fact permanent; the toast is what tells you so. Auto-re-approvals of already-saved rules stay silent. So does this toast when the `ctrl+o` edit dialog handled the same request — including when someone answers the host prompt while the dialog is up — but only as far as the dialog's own report reaches: silence is by coverage, not by "something was already said". Confirming the suggested pattern, or widening it, covers what the host answer saved, so you get one toast. **Narrowing** it does not: the host's `always` still persists the broader rule, so you get a second toast naming that rule too — two durable grants were established, and hiding the wider one would hide exactly what you reached for the dialog to avoid. If the dialog is dismissed, or its write fails, the whole report comes back here. One case has no toast at all: when git confirms a repository whose shared store cannot be located, both halves refuse to READ the narrower fallback (see below), so this half never reads back what was saved and stays silent rather than name a store it declined to trust — the save itself still happens.
- `scope` — what the store is keyed by: `"repository"` (default) shares one store across the primary checkout and all linked worktrees; `"worktree"` keys each worktree separately. Must match the server half's `scope` option (see [The store file](#the-store-file)) — the halves resolve the store independently, and disagreeing values would make them read and write different files. An invalid value **pauses persistence** for that half rather than defaulting (a half that guessed `"repository"` against a `"worktree"` other half would migrate away the store that half is using); only an absent option defaults. Unknown option keys are warned about for the same reason.

Tip: leader chords are silent while pending — pressing `ctrl+x` shows nothing until the follow-up key. If you use them, OpenCode's built-in **which-key** plugin helps: enable it via the palette's *Plugins* dialog, switch it to overlay layout, and turn on *Toggle pending key preview* to get an on-screen panel whenever a key sequence is pending.

## Install

Clone the repository as described in the [root README](../../README.md), then
run `bun install && bun setup` from the checkout root and select `persist-permissions`.
The wizard configures both halves using local source paths. The alternatives
below also require the checkout dependencies.

### Option A: OpenCode's local-package installer

OpenCode's plugin installer understands packages that target both the server and the TUI, and patches both config files in one go — no publishing required, a local checkout works:

```sh
opencode plugin /path/to/macarons/plugins/persist-permissions
```

Run it from your project directory. It detects the `server + tui` targets from this package's `exports`, adds the spec to `.opencode/opencode.json` (server half) and `.opencode/tui.json` (TUI companion), and both halves load on next start. `-g` installs into the global config directory instead; once published, the scoped package name `@macarons/persist-permissions` works as the argument too.

### Option B: reference it from config

The manual version of Option A — the same spec in two places. Point the `plugin` array of your `opencode.json` at this package in a monorepo checkout:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///path/to/macarons/plugins/persist-permissions/src/index.ts"]
}
```

Then add the TUI companion to `tui.json` if you want it (see [Installing the TUI companion](#installing-the-tui-companion)).

### Option C: copy one file (server half only, survives deleting the checkout)

The server half can be installed by dropping a single file into `.opencode/plugin/` (or globally into `~/.config/opencode/plugin/`) — but it must be the bundled artifact, not `src/index.ts`. That directory loads every file as its own plugin, so the source file's `./shared` import doesn't resolve there:

Run these commands from `plugins/persist-permissions` after installing dependencies
at the checkout root. The destination is relative to that directory; use your
target project's `.opencode/plugin/` directory when installing elsewhere.

```sh
bun run build
mkdir -p .opencode/plugin
cp dist/persist-permissions.js .opencode/plugin/persist-permissions.js
```

OpenCode loads it automatically on next start. The TUI companion cannot be copy-installed — TUI plugins are only ever loaded from `tui.json`.

## The store file

The store lives at `persist-permissions/projects/<key>.json` under OpenCode's config directory (`~/.config/opencode/` by default), where `<key>` is `<slug>-<hash>`: the basename of the canonical root the store is keyed by (lowercased, filename-safe), plus the first 16 hex chars of that root's sha256 so same-named projects never collide — e.g. `my-app-1a2b3c4d5e6f7081.json`. The slug is display only; the hash is the real key. Stores written by older releases under the bare full-hash name are adopted (renamed in place) the first time a session resolves the store. If both names ever hold data — say an instance still running the older release writes the old name again after the rename — nothing is merged blind: the old file becomes a migration candidate exactly like a leftover worktree store (folded in automatically when it holds only `allow` rules, persistence paused for your review otherwise), and Approve for Me keeps honoring its `ask`/`deny` carve-outs in the meantime. By default the keyed root is the repository's **primary worktree root**, so the primary checkout and every linked `git worktree` share one store (non-git folders key by the session directory). To give every worktree its own isolated store instead, set the `scope` option on **both** halves:

```json
{
  "plugin": [
    ["file:///path/to/macarons/plugins/persist-permissions/src/index.ts", { "scope": "worktree" }]
  ]
}
```

(and the same `{ "scope": "worktree" }` in the TUI companion's `tui.json` tuple). If the primary root cannot be established — git missing, or the probe disagreeing with the session's own worktree — the plugin falls back to keying by that worktree and logs a warning. Saving to the fallback is safe, because it only ever shares less; **auto-approval, however, pauses** whenever git confirms you are in a repository whose shared store cannot be located. The two stores are independent last-match-wins rulesets, so answering from the narrower one could approve straight through an `ask`/`deny` carve-out written in the store this session cannot currently read — prompts stay interactive until the shared keying is established.

The work-tree detection does not trust the host's instance context alone: a host claim of "not a git project" is verified against git itself, and an unconfirmed keying (either fallback) is re-derived on later accesses — every save, reads at most once per 15 s — so a transient git or host failure at boot cannot pin the session to the narrower keying. When a retry establishes the shared store, rules saved under any interim keying are folded in by the worktree-store migration below, including one keyed by a session directory below the worktree root.

The **server half** locates OpenCode's config directory under the same policy: the lookup is retried on later accesses (every save, reads at most once per 15 s) rather than being decided once at boot, so a host that was still starting when the plugin loaded pauses persistence only until the next request — not until you restart. Two causes are decided once and stay decided, because no retry can change them: a client that exposes no path lookup at all, and an invalid `scope` option — the latter in the shared readiness pipeline, which pauses before either half asks for a config directory it could not key a store with. (The TUI half reads the same directory from the host's own path state instead, and already retries on every access until it lands.)

The store uses the same shape as the `permission` block in `opencode.json`, so you can copy entries into your real config verbatim, or hand-edit them:

```json
{
  "permission": {
    "bash": {
      "git status *": "allow",
      "npm test *": "allow"
    },
    "edit": {
      "src/app.ts": "allow"
    },
    "webfetch": {
      "https://opencode.ai/docs": "allow"
    }
  }
}
```

Hand-editing notes:

- Deleting a line revokes the plugin's saved approval on the next permission request it handles; the file is re-read every time. This does not retract a manual host "always" grant, which can keep approving requests without consulting the store (see [Scope and caveats](#scope-and-caveats)).
- Saved rules are deliberately narrow; broaden them by hand if you want more, e.g. widen `"src/app.ts"` to `"src/*"`, or `"https://opencode.ai/docs"` to `"https://opencode.ai/*"`. Wildcards `*` and `?` work anywhere in a pattern.
- You may add `"ask"` or `"deny"` values to carve out exceptions, e.g. `"bash": { "git *": "allow", "git push *": "ask" }`. Rule order matters: the **last** matching rule wins, same as OpenCode. These values only stop the plugin's auto-approval — for hard denials enforced by OpenCode itself, use the `permission` block in `opencode.json`.
- If [approve-for-me](../approve-for-me) is installed too, its `enshrine-approvals` skill can draft store entries for you: it proposes allow rules from the patterns its classifier keeps approving, one confirmation per rule, and writes them here. The two plugins also share an in-process ledger of automatic replies: an answer this plugin posts on your behalf is marked as automation, so Approve for Me never mistakes it for you being at the keyboard (its unattended-deny budget resets only on answers it can read as yours).

Releases before this trust-boundary change wrote `.opencode/permissions.local.json`. That path is agent-writable and is never imported automatically. If a legacy file exists and the trusted store does not, both plugin halves pause and report the new destination. Review the complete legacy file yourself, copy it to the reported config-directory path, then remove the legacy file. Once a trusted store exists, any leftover legacy file is ignored.

Releases before repository scope keyed every worktree's store by its own root. The first time a worktree session resolves the shared store, a leftover worktree-keyed file is folded in automatically when it holds only `allow` rules — imported rules are added *before* the shared store's existing rules under the same permission key, so under last-match-wins they can never override a carve-out already there — and the old file is then removed (an info toast reports the move). The migration runs under a cross-process lock, so two instances (or the two halves) folding stores into the same destination serialize instead of overwriting each other; and a source file that cannot be deleted after a successful merge is retried on later accesses rather than forgotten. Two shapes are never merged automatically: a worktree store containing hand-added `ask`/`deny` carve-outs, and an import that would have to land *after* a shared carve-out under a different, overlapping wildcard permission key (for example a repository-wide `"*": "deny"`) — permission keys are patterns too, and the flattened ruleset is globally last-match-wins, so no automatic placement preserves both stores' meaning. In both cases persistence pauses for that worktree and a warning names the files. Review them, copy what you still want into the shared store (carve-outs after the rules they narrow), then delete the worktree-keyed file — persistence resumes on the next request, no restart needed.

## Scope and caveats

- **Restart after upgrading.** Quit and restart OpenCode to load the new plugin code and clear any in-memory approvals an older version already granted. This fix prevents new automatic remember-rules; it does not revoke existing host approvals in a running instance.
- **Read-only project roots cannot pass the TUI proof.** The server must create temporary markers in the config directory, the store's containing directory, and the project root, and both halves must update them. Permission rules still live outside the project; proving the project mount prevents a shared config directory from masking a different checkout behind a tunnel. Use shared writable roots for editing and save notifications. The server half and the normal permission prompt remain active even when the TUI cannot prove sharing.
- **Verification can delay editing.** Each proof has a three-second budget, including cleanup. The edit flow checks before opening its dialog and again before saving, so slow successful checks can add two waits to one action. A failed gate stops that stage without saving or replying; the post-dialog check is not skipped because the first check succeeded. Passive save confirmation verifies once, then polls the store without repeating the proof, and stops if the connection is invalidated.
- **Abrupt crashes can leave temporary proof files.** Normal completion, cancellation, expiry, and disposal clean up markers, but a simultaneous server/TUI crash can leave `.macarons-locality-*` files behind. Fresh checks never reuse them. There is no startup sweep because another instance sharing those directories may own a live proof; remove leftover markers only after stopping all OpenCode server and TUI instances using those directories.
- **Manual "always" can bypass exceptions.** Choosing **Allow always** in OpenCode's stock prompt still installs an in-memory host allow rule, often a tool-wide `*`. It applies across sessions in that directory's OpenCode instance and can bypass saved ask/deny exceptions and session-scoped ask/deny restrictions, including matching prompts already pending in the same session. Editing or deleting saved rules cannot retract it; restart the OpenCode server (or dispose/reload that directory's instance) to clear it. Use the TUI companion's edit-before-approve flow to persist a rule without creating a host remember-rule.
- **Repository-scoped by default.** Approvals are keyed by the canonical primary worktree root — one store per repository, shared by the primary checkout and all its linked worktrees — or by the session directory for non-git folders, and stored outside the project in OpenCode's config directory. There is no global rule set. The `scope: "worktree"` option (on both halves) restores per-worktree stores.
- **Session-scoped rules outrank the store.** A session whose *own* ruleset (set through the session API, not config) explicitly asks or denies a request is never auto-approved by this plugin: those rules are deliberate overrides — for example, opencode-btw sandboxes its read-only side-question forks with `ask`-everything rules — and the store mirrors config-level intent, which must not outrank them. The session's rules are fetched once per session (cached, refreshed when the session changes); if they cannot be read — including on a client that exposes no session lookup at all — the plugin errs interactive and leaves the prompt to you. Saving what you answer is unaffected either way.
- **Narrow by design.** The plugin narrows what it persists, not the host's in-memory grant. For example, an "always" answer to an *edit* prompt saves only the specific file you approved, not OpenCode's tool-wide `*`. After the host grant is cleared, other files prompt again unless another saved rule covers them. If a store grows tedious file-by-file, hand-widen it (see above).
- **A brief prompt flash is possible.** On OpenCode 1.17-1.18 the plugin answers through the API a few milliseconds after the prompt is created, so the TUI may briefly render it once per re-approved request, since all automated replies use "once". (On versions where the `permission.ask` plugin hook is invoked, the plugin answers before the prompt is created; the hook is registered for compatibility.)
- **Concurrent instances serialize their saves.** Every read-modify-write against the store — a persisted approval, the TUI edit flow, the worktree-store migration — holds a cross-process lock file (`<store>.lock`, broken automatically if a crashed holder leaves it behind) and finishes with an atomic rename, so the file can never be torn and concurrent saves can no longer silently drop each other's rules. A save that cannot acquire the lock within its timeout is logged and skipped — answer "always" again and the rule is back; approvals are never left half-written. Reading never takes the lock: any number of instances can share the store.
- **Version target: OpenCode v1.** Both halves are verified end to end against the repo's pinned OpenCode release (`.opencode-version`); the verified band rides that pin (floor = the pin, ceiling = its next minor), while `engines.opencode` declares only the static v1 install gate. On a v1 host outside that band the runtime guard warns (a log line on the server, a toast in the TUI) but keeps persisting; it disables the plugin only on OpenCode v2+ (major ≠ 1). OpenCode's V2 permission engine is why the hard boundary is v1: it persists "always" approvals natively and reshapes the permission API (`action`/`resources`/`save` instead of `permission`/`patterns`/`always`, with new `permission.v2.*` events). When V2 becomes the default, retire the server half rather than run both persistence layers side by side; the TUI companion's edit-before-approve flow may still be worth porting. Package installs can enforce the engine range, but path and `file://` installs may bypass that check, so they still require an explicit runtime version guard and an end-to-end test of that guard.

## Development

Install dependencies from the monorepo root, then run all repository checks:

```sh
bun install
bun run check
```

To work on only this package:

```sh
cd plugins/persist-permissions
bun run lint
bun test          # persistence, matching, TUI, packaging, and bundle contracts
bun run typecheck
bun run build     # bundles the server half into dist/persist-permissions.js for copy-install
```

From the monorepo root, run the real-host E2E suite separately:

```sh
bun run e2e         # required server, copy-installed bundle, and package-installer journeys
bun run e2e:server  # persistence across a fresh OpenCode process, copy-installed bundle, and non-git fallback
bun run e2e:install # package-installer journey only
bun run e2e:tui:gating # tmux-driven Ctrl+O edit and escape-cancel journey, plus locality and quota-auth checks
```

It uses an isolated HOME/XDG tree, a real OpenCode binary at the repo pin
(`.opencode-version`), and
a loopback-only scripted OpenAI-compatible provider—no credentials or paid
model calls. On failure it retains the event stream, provider transcript,
OpenCode output, store files, and (for TUI) terminal pane.

The matching, rule-evaluation, and store-I/O core lives in the monorepo's [`@macarons/permission-rules`](../../libraries/permission-rules) library (shared with [approve-for-me](../approve-for-me), which reads this plugin's store for its rule vetoes) and is re-exported through `src/shared.ts`, imported by both entrypoints — `test/matching-spec.test.ts` still pins the engine's semantics through those re-exports and guards that no second copy exists. `src/shared.ts` also owns the one thing the library may not: this plugin's persistence *policy*, the store-readiness pipeline (config directory → keying → untrusted-path refusal → fail-closed read gate while the repository's shared store is unlocatable → unreadable-path and legacy gates → worktree-store fold, in that order: the fold can create the trusted store out of a candidate, so running it first would answer the legacy gate on the legacy store's behalf) that decides when either half may touch the store and what you are told when it may not. Both halves run that single copy and supply only what genuinely differs — how they key the store, where the config directory comes from, and how much of the pipeline's reporting they voice (the server half logs and toasts everything; the TUI half toasts pause causes only, because both render into the same TUI). `test/store-opener.test.ts` pins each of those decisions, including a tripwire that neither entrypoint has grown its own copy of the sequence again. The entrypoints themselves stay target-exclusive because OpenCode's loaders demand it: the server loader treats every export of `src/index.ts` as a plugin function, and the TUI loader reads only the default `{ id, tui }` export of `src/tui.tsx` — one module must never carry both. `test/packaging.test.ts` guards those contracts plus the `exports` map that lets `opencode plugin` detect both install targets; `test/bundle.test.ts` proves the built artifact is self-contained.

`test/sdk-contract.test.ts` fails to compile if the OpenCode SDK ever renames or reshapes the permission-reply or log endpoints the plugin calls.

The plugin logs what it persists and auto-approves to the server log (`~/.local/share/opencode/log/opencode.log`) under service `persist-permissions`.

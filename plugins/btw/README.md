# opencode-btw

An [OpenCode](https://opencode.ai) plugin that adds cache-hot **side
questions**: ask a quick aside about the current conversation without adding
anything to it — and without interrupting the model, even while it is actively
working. The answer appears in a dismissible overlay that draws on the full
context of the session so far, so you can ask "wait, why did we pick exponential
backoff?" mid-task, read the answer, and carry on. Nothing you ask leaks into
the main thread.

Because it reuses the conversation you already sent, the side question can reuse
the provider's prompt cache rather than paying to re-read the whole history.
Cache hits depend on provider support, cache lifetime, and an unchanged prefix;
OpenAI-family providers also need the server half installed.

## Keyboard shortcuts

Shortcuts are shown where they are relevant: the ask key in the question
dialog, panel controls along the bottom of the answer panel, and configured
keybindings beside command-palette actions. They are all configurable (see
[Options](#options)).

| Keys | Where | What it does |
| --- | --- | --- |
| **`<leader>w`** (also **`ctrl+alt+w`**) | any session | Open the side-question box. `<leader>` is your OpenCode leader key, `ctrl+x` by default. |
| **Command palette** | any session | Choose **BTW**. |
| **`enter`** | side-question box | Ask. |
| **`esc`** | any btw dialog | Close. Aborts a streaming answer; the thread stays reopenable. |
| **`<leader>w`** (again) | answer panel open | Ask a **follow-up** once the side thread has settled; unconfirmed follow-ups offer a fresh question with a warning (see [caveats](#scope-and-caveats)). |
| **`ctrl+l`** | answer panel open | **Open as session** — promote the side thread to a real session and switch to it. |
| **`ctrl+y`** | answer panel open | **Copy** the answer to the clipboard. |
| **"Reopen last side answer"** | command palette | Bring back the last panel you dismissed. |

The command palette (`ctrl+p` by default) also lists every action — **Ask a side
question**, **Open side answer as a session**, **Copy side answer**, **Reopen
last side answer** — with its keybinding beside it.

## How it works

A side question runs in a throwaway **fork** of your current session:

1. When you ask, the plugin forks the session at its **last completed turn**
   (using OpenCode's `POST /session/{id}/fork`, which works even while the
   session is mid-reply). The fork inherits the entire conversation up to that
   point, plus the same agent, model, and reasoning effort.
2. It prompts the fork with your question wrapped in a `<side-question>` block
   inside the **user** message — never the system prompt — so the request is a
   byte-for-byte prefix match of what the main session already sent. Providers
   serve that prefix from cache instead of re-reading the whole history.
3. The answer streams into an overlay. Your main session is a different session
   with its own runner, so it keeps going untouched.
4. Dismissing the panel stops the answer but keeps the fork, so you can reopen
   the thread or ask a follow-up; the fork is deleted when your next question
   replaces it or when the TUI exits. Leftover forks from a crash are swept
   once their ownership lease goes stale (about five minutes without a
   heartbeat) — which is also what stops a second OpenCode instance on the
   same project from ever deleting a live side question. Nothing is ever added
   to the session you asked about.

Side questions are **read-only** by default: the fork can use read tools
(read, glob) only where the parent's effective permissions allow them. Agent,
global/project, and inherited session restrictions remain in force; reads that
would need approval are automatically rejected, not silently allowed. Everything
else, including writing files, shell commands, sub-agents, MCP tools, and other
plugins' tools, is
blocked, so a side question can never change your workspace. grep is blocked
too, read-only though it is: its permission carries only the search regex
while the tool returns matching file *contents*, so allowing it would let a
directory-wide search pull `.env` secrets past the env-file guard. The host's
MCP *resource* readers (`read_mcp_resource` and friends) are blocked for a
similar reason: they ask under the ordinary `read` permission but pull content
from external MCP servers that no rule here can audit. (Set `tools: "none"`
to forbid all tools.)

### The two halves

- **TUI companion** (`src/tui.tsx`) — the whole experience: the keybind, the
  palette commands, the streaming answer panel, and the
  read-only guard. Required.
- **Server half** (`src/index.ts`) — optional but recommended. It does three
  things and touches nothing else: it rewrites the fork's cache key back to the
  parent's for **OpenAI-family providers** (Anthropic caches by prefix and needs
  no help), it enforces the read-only guard even in headless/serve deployments,
  and it hard-stops tool executions *before they run* — including plugin tools
  that never consult the permission layer, and `read` calls whose target is an
  env file. Without it, side questions still work and the permission-based
  guard still holds on the TUI side; you lose the cache benefit on
  non-Anthropic models and the pre-execution backstop (see "Read-only by
  design" below for what that means).

## Install

Clone the repository as described in the [root README](../../README.md), then
run `bun install && bun setup` from the checkout root and select `btw`.
The wizard configures both halves using local source paths. The alternatives
below also require the checkout dependencies.

### Option A: OpenCode's local-package installer

Run from your project directory:

```sh
opencode plugin /path/to/macarons/plugins/btw
```

It detects the `server + tui` targets from this package's `exports`, adds the
spec to `.opencode/opencode.json` (server half) and `.opencode/tui.json` (TUI
companion), and both halves load on next start. `-g` installs globally; once
published, the scoped name `@macarons/btw` works as the argument too.

### Option B: reference it from config

Point the `plugin` array of your `opencode.json` at the server half, and the
`plugin` array of your `tui.json` at the TUI half:

```json
// opencode.json
{ "$schema": "https://opencode.ai/config.json", "plugin": ["file:///path/to/macarons/plugins/btw/src/index.ts"] }
```

```json
// .opencode/tui.json
{ "plugin": ["file:///path/to/macarons/plugins/btw/src/tui.tsx"] }
```

Options go in a `[spec, options]` tuple in `tui.json`:

```json
{ "plugin": [["file:///path/to/macarons/plugins/btw/src/tui.tsx", { "tools": "none" }]] }
```

### Option C: copy one file (server half only)

The server half can be dropped into `.opencode/plugin/` as the bundled artifact
(not `src/index.ts`, whose `./shared` import won't resolve there):

Run these commands from `plugins/btw` after installing dependencies at the
checkout root. The destination is relative to that directory; use your target
project's `.opencode/plugin/` directory when installing elsewhere.

```sh
bun run build
mkdir -p .opencode/plugin && cp dist/btw.js .opencode/plugin/btw.js
```

The TUI companion is only ever loaded from `tui.json`.

## Options

TUI-half options (second element of a `["file://…", {…}]` entry in `tui.json`):

- `keybind` — key(s) to open the side-question box, comma-separated
  alternatives (default `"<leader>w,ctrl+alt+w"`). The first alternative is the
  one shown on screen. `false` or `"none"` removes the binding, leaving the
  palette entries.
- `openKeybind` — key to open the answer as a session (default `"ctrl+l"`).
- `copyKeybind` — key to copy the answer (default `"ctrl+y"`).
- `notify` — toast when an answer finishes while its panel is not on screen
  (default `true`).
- `model` — pin a model for side questions as `"provider/model"` instead of the
  session's own. A cheaper model trades the cache hit for cheaper tokens; the
  default (the session's model) keeps the answer cache-hot.
- `variant` — reasoning-effort [variant](https://opencode.ai) for side
  questions (e.g. `"thinking"`), if the model defines one.
- `tools` — `"read-only"` (default) lets side questions use read/glob within
  the parent's permissions; `"none"` forbids all tools.
- `timeoutMs` — abort a side question after this long with no streaming
  progress (default `180000`). Follow-ups start this deadline before session
  lookup and prompt admission; only streamed progress extends it, not SDK
  responses.
- `keepSessions` — keep every side fork as a persistent session instead of
  deleting it when the next question replaces it or the TUI exits (default
  `false`). A kept session sheds its btw marker, so sweeps never touch it.

The server half takes no options.

## Scope and caveats

- **Unconfirmed follow-ups are not retried.** A timeout or dismissal cancels
  the local SDK wait, but the host may already have accepted the question.
  The thread stays reopenable. While that admission or its abort remains
  unconfirmed, the next ask warns before opening a fresh side-question box.
  Confirming that new question replaces the visible thread and deletes its
  fork unless `keepSessions` is enabled; cancelling leaves the thread
  reopenable. Same-thread follow-ups and promotion remain blocked until
  confirmed, possibly indefinitely: an idle snapshot or a missing prompt
  cannot rule out a request arriving late, nor can one successful abort rule
  out another still arriving. Waiting alone does not guarantee recovery.
  Initial questions also block follow-ups and promotion while their dispatch
  or cancellation is still settling. Do not resend a question whose delivery
  is unconfirmed.
- **Read-only by design.** The fork carries an allowlist of session rules:
  `ask` on every permission name, then the parent's effective read/glob policy
  in its original order, including wildcard rules and session restrictions.
  If the parent policy cannot be resolved, no side question is started. Env
  files stay guarded by path-specific denies; `.env.example` files are exempt
  only where the parent permits them. MCP resource reads fall to a trailing
  `mcp:*` deny because their content comes from external servers. grep is not
  re-allowed at all: its permission never names the files it reads, so an allow
  would bypass those guards. An allowlist because permission names are open-ended:
  MCP tools ask under sanitized ids like `github_create_issue`, plugins under
  whatever they choose — so no denylist can be complete. Added tool-wide guards
  use `ask` rather than `deny` to avoid dropping tools from the request and
  breaking the cache-prefix match; inherited read/glob denials remain denials.
  The plugin auto-rejects all prompts, including inherited read/glob asks, so
  the model gets a clean "denied" and answers from what it can read. The server
  half additionally refuses non-read-only tool *executions*
  before they run — covering plugin tools that never consult the permission
  layer, and `read` calls that target env files (which the tool-id allowlist
  alone could not see). If the host cannot verify whether a session is a side
  fork, the server half fails write-capable executions closed, bounds each
  marker lookup at 10 seconds, and retries on the next request.
- **Other permission plugins can race the TUI-only guard.** The auto-reject
  answers each prompt as it appears — so a co-installed plugin that
  auto-*approves* from stored rules could in principle answer first. The TUI
  half watches for that and kills the fork the moment any approval lands in
  it, capping the damage at a single tool call. The server half's pre-execution
  gate independently blocks writes, env files, and MCP calls, which is the main
  reason it is recommended. Other read/glob requests still rely on the host's
  permission enforcement, including its runtime approvals.
  (This repo's persist-permissions plugin respects
  session-scoped rules and never approves inside a side fork.)
- **A side fork appears in the session list while its thread is alive.** Forks
  are ordinary sessions (OpenCode has no hidden-session concept yet), so a
  `btw: …` entry is visible in the session switcher from the moment you ask
  until your next question replaces it or the TUI exits — dismissing the panel
  keeps it, so the thread stays reopenable. At most one exists at a time.
- **Cache reuse depends on the day and the provider.** The request prefix is
  identical to the parent's except for the calendar date embedded in the
  environment block, so a side question asked after midnight pays a one-time
  cache miss. OpenAI-family cache reuse needs the server half installed.
- **Version target: OpenCode v1.** The plugin uses session fork and the v2
  SDK/TUI surface; the verified band rides the repo's pinned OpenCode release
  (floor = the pin, ceiling = its next minor), while `"engines"` declares only
  the static v1 install gate. On a v1 host outside that band both halves warn (a
  log line on the server, a toast in the TUI) but keep running; they refuse to
  load only on OpenCode v2+, whose plugin API differs. The runtime guard matters
  because path and `file://` installs bypass the package-engine check.

## Development

From the repository root:

```sh
bun run test --filter=@macarons/btw
bun run check --filter=@macarons/btw
```

The real-host end-to-end journeys (a cache-hot fork with a byte-identical
prefix, the main transcript left untouched, a mutating tool auto-denied,
parent read/glob and session restrictions preserved alongside the server env
guard, and a side question answering while the parent is mid-turn) run against
the pinned OpenCode via `bun run --cwd tests/e2e e2e:btw`.

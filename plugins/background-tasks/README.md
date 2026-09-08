# background-tasks

An [OpenCode](https://opencode.ai) plugin that gives the agent **background
tasks**: the ability to start a shell command, get a task id back immediately,
and keep working while it runs — the equivalent of Claude Code's
`Bash(run_in_background)` plus `BashOutput` / `KillBash`, and of Codex's
background processes.

OpenCode's built-in `bash` tool always runs in the foreground and gives up
after at most ten minutes, so the agent cannot start a dev server, a file
watcher, or a long build and then continue with anything else. This plugin adds
four agent-facing tools that fix exactly that, and notifies the agent in the
conversation when a background task finishes — so it never has to sit and poll.

## The tools

| Tool | What it does |
| --- | --- |
| **`background_run`** | Start a command in its own process group; returns a task id immediately. Args: `command`, optional `name`, `workdir`, `timeout_ms`. |
| **`background_output`** | Read the output produced since the last read (never blocks). Optional `filter` regex selects which lines are shown. |
| **`background_wait`** | Block until a regex matches the output, the task exits, or a timeout elapses (default 60 s, max 600 s). Event-driven — no polling. |
| **`background_kill`** | Stop a task: SIGTERM to the whole group, SIGKILL after 3 s. Returns the final status and any unread output. |

`background_run` asks for permission under the **same `bash` action** the
built-in shell tool uses. Each executable command in a sequence, pipeline,
compound command, command substitution, or supported wrapper is checked
separately, so an allowed leading command in the supported subset cannot conceal
a denied one. Existing `permission.bash` rules and permission plugins apply;
remembered grants use the analyzed command patterns rather than broader
command-prefix grants. Pipeline negation (`!`) keeps the same executable
patterns: it changes exit status, not the operations being authorized.

Before anything starts, `external_directory` checks cover the working directory,
file-command operands, and redirection targets. Paths are checked against the
project boundary after resolving symlinks, including existing ancestors of new
output files. Denying either permission prevents the **entire task** from
starting, including earlier commands and substitutions. The `bash` decision
comes first, so a denied command does not leave a remembered external-directory
grant behind. Access requiring a filesystem-root grant (a workdir of `/` or a
root-level file such as `/output.log`) is rejected before either prompt. Use a
more specific directory or path instead: even an empty `always` list cannot stop
permission UIs from offering to persist the concrete `/*` request pattern.

These checks also apply to `/dev/null` redirects and path-qualified executables
outside the project, such as `/usr/local/bin/tool`. They are intentionally not
exempt from configured external-path rules. Prefer a one-off approval for these
accesses rather than remembering a broad directory grant such as `/dev/*`.

Analysis never executes shell code. Malformed or unsupported syntax, dynamic
command names, and paths that cannot be resolved safely fail closed, even when
`bash` is allowed. Use literal paths and the `workdir` argument instead of
changing directories inside a command. Shell permission analysis is not an OS
sandbox: an approved program or script can perform operations of its own.

The supported subset includes lists, pipelines, groups, conditionals, loops,
ordinary command substitutions, simple command wrappers, and literal `sh -c`
scripts. Parameter expansions (`${...}`), line continuations, wildcard paths,
heredocs, arithmetic, functions, inline environment assignments, and indirect
shell-state operations are rejected. Dynamic arguments are accepted only as
printing/no-op data, not as possible file operands. Use separate short options
and literal path values instead of attached path options such as `cp -t/path`.
Printing formats must be
literal and data-only; Bash variable-assignment forms of `printf` are rejected.
Loop variables must have ordinary lowercase names. Process-relative filesystem
paths such as `/proc/self/cwd` and `/dev/fd`, including symlink aliases, are
rejected because they cannot be resolved reliably for the child process.

| Wrapper | Accepted form |
| --- | --- |
| `exec`, `command`, `env`, `nohup` | Optional `--`, then a literal executable; no wrapper options or environment assignments. |
| `nice` | Optional `-n INTEGER`, optional `--`, then a literal executable. |
| `timeout` | Optional `--`, a literal nonnegative duration (optional `s`, `m`, `h`, or `d` suffix), then a literal executable; no timeout options. |
| `sh` or `/bin/sh` | Exactly `-c 'literal script'`, with no additional arguments. |

Supported wrappers are checked recursively, including nested wrappers and inner
path operands. Other known launchers (`ionice`, `taskset`, `chrt`, `sudo`, `doas`,
`setsid`, `stdbuf`, `xargs`, and `watch`) and `find` execution actions (`-exec`,
`-execdir`, `-ok`, `-okdir`) fail closed rather than hide an executable. Without
a full `find` predicate parser, those action tokens are also rejected when used
as data (for example, `-name -exec`). Shell names are classified by basename, so
a non-shell executable named `fish`, `cmd`, etc. is also subject to the shell
restriction; this is an intentional conservative tradeoff.
An unquoted `[` is also conservatively treated as a wildcard character; use
`test` or quote the executable as `'['`.

## Completion notifications

When a background task finishes on its own, the plugin injects a
`<background-task-update>` note into the owning session with the task's exit
code and the last lines of its output:

- if the session is **idle**, the note starts a fresh model turn (like
  OpenCode's experimental background subagents), so the agent reacts right
  away;
- if the session is **busy**, the note is **held** until the turn ends, and
  everything held for that session is then delivered as a single prompt.

Notes are withheld rather than flagged because OpenCode has no way to add a
message to a session without a running turn picking it up: the host persists a
user message before it consults `noReply`, and a run already in flight re-reads
the transcript on every step and will not exit while an unanswered user message
is newer than its own reply. `noReply` only decides whether an *idle* session
also starts a turn. So the only way not to steer a turn is not to write during
it.

Notes for one session are posted **one at a time**, and the busy/idle decision
is taken immediately before posting. Two tasks finishing together would
otherwise both read the session as idle, and the second note would arrive in
the middle of the turn the first one started — a steer the user never asked
for. The decision itself comes from the tracker this plugin shares with cron
(`createSessionActivityTracker` in `@macarons/permission-rules`):
`session.status` / `session.idle` events, a `GET /session/status` for a
session no event has described yet, and **not idle** whenever the host cannot
be reached or understood — a note held for a host that is not answering is a
delay, and one posted on a guess is a hijacked turn. OpenCode does not mark a
session busy until well after it accepts a prompt, so this half also remembers
the turns it started itself for a few seconds; that assumption stays here,
because it is about what this plugin did rather than what the host reports.
Held notes go out on the next observed idle *or* alongside the next
completion for that session, so a missed idle event delays them rather than
losing them; at most 16 are held per session, and a session that stays busy
indefinitely drops the oldest first (the toast has already fired, and the
output stays readable through `background_output`). One residual case remains:
a turn *you* start in the instant between the check and the post still receives
the note mid-turn.

Each notification batch carries a caller-minted message ID. An HTTP 204 from
`promptAsync` only acknowledges forked processing, which can still fail before
persisting the message. After successful acceptance **or** a transport error,
the plugin confirms that exact ID through the session message endpoint before
marking the batch **delivered**. It polls for delayed persistence for up to
`notifyPostTimeoutMs`; confirmation proves the message exists, not that the
model has read it or completed a turn.

If that ID cannot be confirmed, delivery becomes **uncertain** (`ambiguous`)
and is parked **without reinjection**, even on later idle events or task
completions. The warning is logged, `background_output` reports the uncertainty
and delivery metadata, and the TUI task row shows `notify uncertain`. The task's
output remains readable. Only explicit host rejection or a pre-dispatch failure
is retried, with bounded backoff and a visible failure after three attempts.

If the session's pinned agent and model cannot be read, the note is **not
posted** without them: OpenCode resolves an omitted agent to the global default
and re-pins the session to it, which would swap the session's permission ruleset,
model, and variant. Those pre-dispatch failures use the bounded retries above;
the toast still fires.

Because of this, the tool descriptions tell the model **not** to poll with
repeated `background_output` calls or `sleep` commands — it will be told when
something finishes. If a `background_wait` or `background_kill` already
delivered the exit inline, the redundant note is suppressed (a toast still
appears).

## The two halves

Like the other plugins in this suite, background-tasks ships a **server half**
and a **TUI half**, installed independently.

- **Server half** (`./server`, loaded from `opencode.json`'s `plugin` array) —
  registers the four tools, manages the processes, and sends the completion
  notifications. This is the half that does the work; install it wherever the
  agent runs (including headless/`serve` deployments).
- **TUI half** (`./tui`, loaded from `tui.json`'s `plugin` array) — a sidebar
  section listing the current session's running tasks (name, elapsed, state),
  and a palette command (`/bg`, "Background tasks: list / kill") to inspect
  tasks, kill one, copy its captured output, or jump to the session that owns
  it. Purely a viewer; it drops a request file the server half acts on when you
  kill a task.

The two communicate through a small per-project registry in OpenCode's state
directory (each server owns one state file and the TUI merges them) and a
kill-request directory (the TUI writes; every server sweeps for its own task
ids). Both live outside the agent-writable project and carry only display/kill
state — never anything that grants a permission.

For independently upgraded halves, current servers also publish a locked,
derived aggregate at the prior single-file paths. Older TUI halves therefore
keep seeing all current servers, while current TUI halves use the instance
files as the authoritative registry.

## Install

Clone the repository as described in the [root README](../../README.md), then
run `bun install && bun setup` from the checkout root. The interactive installer
wires both halves using local source paths; no published package is required.
After installing dependencies, you can instead configure those paths by hand:

```jsonc
// opencode.json — the server half
{
  "plugin": ["file:///path/to/macarons/plugins/background-tasks/src/index.ts"]
}
```

```jsonc
// tui.json — the TUI half
{
  "plugin": ["file:///path/to/macarons/plugins/background-tasks/src/tui.tsx"]
}
```

## Options

Options ride in a `[spec, { … }]` tuple in the relevant `plugin` array.

### Server half

| Option | Default | Meaning |
| --- | --- | --- |
| `notify` | `true` | Inject the completion note into the owning session when a task exits. |
| `toast` | `true` | Also show a toast when a task exits. |
| `bashHint` | `true` | Append a one-line pointer to the built-in bash tool's description telling the model to use `background_run` for long-running commands. |
| `maxBufferBytes` | `2097152` (2 MiB) | Per-task rolling output buffer cap (clamped 64 KiB–16 MiB). Oldest unread output is dropped when exceeded; reads report how much was lost. |
| `maxTasksPerSession` | `8` | Running tasks allowed per session (clamped 1–32). |
| `notifyTailLines` | `10` | Lines of output quoted in the completion note (clamped 0–50). |
| `notifyPostTimeoutMs` | `15000` | Timeout for each notification host call and, separately, the total exact-message confirmation window after posting (clamped 1000 - 2147483647). Notes for a session are posted one at a time; unconfirmed delivery is parked without reinjection when the confirmation window ends. |

### TUI half

| Option | Default | Meaning |
| --- | --- | --- |
| `keybind` | *(off)* | Optional keybind for the task list, e.g. `"<leader>k"`. Off by default; `/bg` and the palette always work. |
| `sidebar` | `true` | Show the sidebar section. When off, only the palette command remains. |
| `pollMs` | `15000` | How often the TUI re-reads the state files as a fallback (clamped 2000 – 2147483647). A poke from the server half usually refreshes them much sooner. |

## Scope and caveats

- **Normal shutdown.** Disposal signals every retained task group, including
  finished tasks whose keeper is still pending, and waits for both the task and
  group to close. The globally referenced process wait is capped at 4 s,
  covering process exit and captured-pipe closure. A descendant that escapes the
  group while holding pipes cannot block this wait indefinitely, but a
  slow-to-die task can still be alive when disposal returns. Normal cleanup may
  retry one unconfirmed SIGKILL, but shutdown can reach its 4 s budget before
  that retry. Path resolution and state-file I/O are outside this cap.
  Stock OpenCode 1.18.14's shared 5 s host-shutdown deadline can still interrupt
  serial instance/plugin disposal. Reliable multi-directory shutdown requires
  the concurrent host teardown change described in the
  [#271 upstream handoff](../../tests/e2e/background-tasks/SHUTDOWN.md), including
  its pinned real-TUI regression and patch. No fixed upstream release has been
  verified; installing/updating this plugin alone does not fix that host limit.
- **Crash orphans.** If the server is hard-killed, a keeper that detects the
  parent disconnect attempts to SIGKILL its group, but this is best effort and
  processes can still be orphaned. The plugin does **not** try to reap them from
  state on the next start or send later signals to recorded numeric process
  groups, because ids recycle and could hit unrelated processes. A later server
  distinguishes that dead writer from live peers, surfaces its tasks as orphaned
  debris, and removes only the dead instance's file.
- **POSIX-first.** Kills signal the detached process group (`SIGTERM`, then
  `SIGKILL` after 3 s) on POSIX through a private in-group keeper. The keeper
  remains after the shell exits, so pending escalation and repeated
  `background_kill` calls can still stop descendants without a later signal to
  a numeric group id that might have been reused; the task's original exit facts
  remain unchanged. During normal cleanup, the 3-second deadline survives
  terminal results and repeated kills, with one retry when cleanup is
  unconfirmed. If the keeper or its IPC is lost, cleanup is warned about and
  retired rather than risking a bare group-id signal. A finished record retains
  its keeper until normal cleanup (the
  activity-triggered 30-minute TTL, the 50-record cap, session deletion, or
  disposal). The 50 retained finished records can each hold a keeper process;
  evicted records also retain theirs during the termination grace period.
  Commands run through `/bin/sh`; Windows command
  execution is rejected until equivalent permission analysis for its shell is
  available. Other tools can still inspect task state.
- **stdin is closed.** Background tasks cannot be interactive.
- **Task ids are session-scoped** — a tool call can only see and act on tasks
  its own session started — **and unique per server instance** (an instance
  slug is embedded in the id), so concurrent or restarted OpenCode servers on
  the same project can never mistake each other's tasks in the state registry
  or kill-request channel.

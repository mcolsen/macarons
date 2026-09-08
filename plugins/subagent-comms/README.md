# subagent-comms

An [OpenCode](https://opencode.ai) plugin that gives the agent **two-way
communication with its subagents** — the equivalent of Claude Code's
`SendMessage` tool and background `Task` agents, and of Codex's multi-agent
collaboration tools.

OpenCode's built-in `task` tool spawns a subagent and blocks until it
finishes; resuming one afterwards (`task_id`) blocks the same way, and there
is no way to see which subagents exist, to run one in the background without
an experimental env flag, or to stop one. This plugin adds six agent-facing
tools that are deliberately **complementary** to the built-in: foreground
spawning and resume stay with `task` (the plugin appends a short hint to its
description saying so), and everything else lives here.

## The tools

| Tool | What it does |
| --- | --- |
| **`subagent_models`** | List models in the current provider catalog, safe display names, provider defaults, and supported variants for catalog-checked spawn selection. |
| **`subagent_spawn`** | Start a subagent in the background: child session + prompt, returns the session id immediately. Args: `description`, `prompt`, `subagent_type` (same agent types as `task`), optional `model` (`provider/model`), and optional `variant`. |
| **`subagent_send`** | Message one of your subagents, like talking to a teammate. Blocks for the reply by default (`wait: false` delivers and returns); `timeout_ms` caps the wait (default 300 s, max 600 s). |
| **`subagent_list`** | Your direct child sessions with id, busy/idle status, agent type, title, and last activity — including children the built-in `task` tool spawned. |
| **`subagent_wait`** | Block until the given (default: all busy) subagents go idle; returns each one's latest reply. An explicitly named subagent that is already idle returns its latest completed result instead. Timing out is not an error. |
| **`subagent_kill`** | Abort a subagent's in-flight run (like pressing Esc in its session). The session survives and can be resumed. |

Session ids are interchangeable with the built-in tool's: a `<task id="ses_…">`
result from `task`, a `subagent_spawn` result, and `subagent_list` all name the
same child sessions, and `task(task_id=…)` can resume a child this plugin
spawned.

## Model selection

`subagent_models` reads the current provider catalog and returns safe,
canonical `provider/model` references, display names, each provider's default
model, and supported variants. It never returns provider keys, options, or
credentials. The catalog can include explicitly configured providers that are
not currently authenticated.

`subagent_spawn` accepts optional `model` and `variant` arguments. Its model
selection precedence is: explicit `model`, the selected subagent type's
configured model, then the parent turn's model. Its variant precedence is:
explicit `variant`, the default effort for an explicit `model`, or the existing
agent/inherited behavior when neither argument is supplied. A `variant` without
a `model` applies to the otherwise resolved model. Explicit model or variant
selections are checked against a freshly read catalog before the child session
is created; selections not listed there fail without starting a child. Catalog
membership does not pre-check provider authentication, SDK initialization,
network reachability, or inference usability, so a listed selection can still
fail when the child starts. An explicit model without a variant requests the
host's default effort rather than inheriting an agent effort pin. The built-in
foreground `task` tool is unchanged.

## Talking to a busy subagent

Messaging an **idle** subagent starts a new turn in its session. Messaging a
**busy** one does not queue and does not fail: the host merges the message
into the running loop at its next step boundary — a steer, exactly what
resuming a running task does. `subagent_send` reports which of the two
happened. Every message the plugin injects carries its own minted message id,
and a reply only counts if the host recorded it as answering that message (or
a later one) — so a steered send returns the run's fresh final reply, and a
previous run finishing at the exact moment you send is never mistaken for it.

## Completion notifications

Subagents the plugin is tracking — spawned ones, unwaited sends
(`wait: false`), and sends that timed out — notify the parent session when
they finish, with the reply inlined in a stock-style `<task>` block (truncated
past `maxReplyChars`). The note is a plain prompt, exactly like the host's
experimental background subagents: the host's runner atomically merges it into
a run already in flight (the agent sees it mid-turn) and starts a fresh model
turn on an idle parent — no busy-vs-idle check that could race the parent
going idle between check and injection.

The tool descriptions therefore tell the model **not** to poll or `sleep`
(with `notify: false` they instead point at `subagent_wait`). A
parent gets **one note per child**: a child's next completion answers
everything sent to it before, so a newer registration supersedes the old.
Blocking calls own the delivery — while a `subagent_send` or `subagent_wait`
is waiting on a child, its pending note is parked, dropped if the tool result
returns the completion, and revived if the wait times out or is aborted. An
explicit `subagent_wait` that times out registers no new note (you asked, you
got the answer "still busy"), and `subagent_kill` suppresses the pending note
for the child it stops — the kill result is the delivery.

### Unconfirmed initial launches

HTTP acceptance does not prove that the host persisted the initial prompt. If
spawn cannot confirm it, the child and original prompt id are preserved without
resubmitting the work. Automatic reconciliation gets one additional
`injectConfirmTimeoutMs` window after spawn returns. At the first poll or tool
check after that deadline, an unresolved launch becomes **parked**, even if
status or transcript reads fail. Parking is logged and, with `toast: true`,
shown as a warning, not a completion.

`subagent_list` shows the original prompt id and launch uncertainty separately
from the host's busy/idle status. Parked initial tracking stops automatic
transcript polling and no longer occupies a `maxBusyChildren` slot by itself;
a child the host actually reports as busy or retrying still counts.

Use `subagent_wait` with the explicit session id for a bounded, correlated
inspection. If the launch is still unresolved, it returns uncertainty and
preserves the parked record, without restarting automatic tracking. A later
correlated reply can be collected this way. If inspection confirms the original
prompt and the wait times out or is aborted before collecting its result, normal
automatic completion tracking resumes. A reply to a newer prompt alone does not
confirm an unseen initial prompt. Use `subagent_kill` to clear an idle child's
unresolved tracking; this preserves the session and does not prove the original
request was cancelled. Do not blindly resend the original prompt or spawn
duplicate work. An intentional follow-up is a new prompt, not a retry.

## Interrupting

Pressing Esc aborts the turn, not the subagents. What that means depends on
how far the call had got:

- **Before the message was delivered** — `subagent_spawn` before it created
  the child, or `subagent_send` before the child accepted the message — the
  call stops and nothing was started. A subagent created in the race between
  creation and prompting is deleted, so an interrupted spawn never leaves a
  session behind that was never given anything to do.
- **After the message was delivered**, only your wait ends. The subagent keeps
  the message and keeps working, and it is still registered to notify you when
  it finishes, subject to the bounded initial-launch uncertainty policy above.
  A delivered message is never retracted. Use `subagent_kill` to stop a run. This
  includes the window where the host has *accepted* the message but the plugin
  has not yet been able to see it: an abort stops the confirmation wait
  immediately rather than polling it out, and the subagent is kept either way.

## Permissions and scoping

- **Addressing is parent-only**: a session may message, wait on, and kill only
  its **direct children**. Unknown and foreign session ids get the same error
  on purpose.
- **`subagent_spawn` enforces the stock `subagent_depth` resource boundary**
  (walk the parent lineage, refuse past `config.subagent_depth`, default 1 —
  the same check the built-in `task` tool runs), **then asks under the same
  `task` permission action the built-in asserts** — so it is silently allowed
  wherever `task` is, your `permission.task` rules govern it unchanged, and
  inside a subagent session (where the host's derived ruleset denies `task`)
  spawning is denied: no nested subagents, same as stock.
- **`subagent_send` also asks under `task`**, with the child's agent type as
  the pattern — commanding an existing child is the same capability as
  spawning one, and the stock tool re-asks on every `task_id` resume. A
  session whose current agent denies `task` (plan mode, say) cannot keep
  directing a more-privileged child it started earlier.
- Spawned children get the same derived permission ruleset the built-in
  applies (parent deny + `external_directory` rules carried over;
  `todowrite`/`task` denied unless the agent's own ruleset grants them), plus
  denies that hide these six tools from children that cannot `task`.
- `subagent_list`/`wait`/`kill` are deliberately ungated, like reading the
  state of (or stopping) something you already had permission to start.

Every prompt the plugin injects echoes the target session's current
agent/model/variant back to the host, so steering a subagent (or notifying the
parent) never re-pins the session onto the default agent or strips a pinned
variant.

## Coexistence with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`

With the host's experimental background subagents enabled, stock background
children are just busy child sessions to this plugin: `subagent_list` shows
them, `subagent_send` steers them, `subagent_kill` aborts them.

Subagents this plugin starts (`subagent_spawn`) are plain child sessions the
host does not track as background jobs, so their completion is injected into
the parent exactly once — by this plugin. A subagent the _host_ started with
`task(background: true)` is different: the host itself notifies the parent when
that job finishes. The plugin cannot tell such a child apart from any other
busy child — OpenCode exposes no read-only way to query the background-job
registry — so if you follow up on a host-background child with
`subagent_send(wait: false)` (or a `subagent_send` that times out and leaves a
pending note), both the host and this plugin inject a completion when it
finishes, and the parent hears about it twice. To avoid the duplicate, resume a
host-started background task with the stock `task` tool's `task_id` rather than
a non-blocking `subagent_send`, or just run background subagents through
`subagent_spawn` instead of the experimental host feature (the reason this
plugin exists). Both notes carry the "you may ignore it" hint, so a duplicate
is redundant, never incorrect.

## Install

This plugin is server-only (the OpenCode TUI already surfaces child sessions;
`<leader>Down` enters one). Add the server entry to `opencode.json`'s `plugin`
array, or clone the repository as described in the [root README](../../README.md)
and run the install wizard from the checkout root:

```sh
bun install && bun setup
```

Targets OpenCode v1; the verified band rides the repo's pinned OpenCode
release (floor = the pin, ceiling = its next minor), while `"engines"`
declares only the static v1 install gate. On a v1 host outside that band the
plugin warns (a log
line, and a deferred toast at the first permission prompt) but keeps running; it
disables itself only on OpenCode v2+, whose plugin API differs. The runtime
guard matters because path and `file://` installs bypass the package-engine
check.

## Options

Pass options with the `[spec, options]` tuple form in `opencode.json`:

```json
{
  "plugin": [["file:///path/to/macarons/plugins/subagent-comms/src/index.ts", { "defaultWaitTimeoutMs": 120000 }]]
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `notify` | `true` | Inject completion notes for tracked subagents into the parent session. |
| `toast` | `true` | Toast when a tracked subagent finishes, in addition to the note. |
| `taskHint` | `true` | Append the subagent-tools pointer to the built-in `task` description. |
| `defaultWaitTimeoutMs` | `300000` | Default cap for `subagent_send`/`subagent_wait` blocking waits (clamped 1 s – 600 s). |
| `pollIntervalMs` | `2000` | Fallback poll for missed idle events; runs only while something is watched (clamped 250 ms – 30 s). |
| `maxReplyChars` | `16384` | Reply truncation bound in tool outputs and notes (clamped 512 – 262144). |
| `maxBusyChildren` | `8` | `subagent_spawn` refuses while this many children are busy (clamped 1 – 32). |
| `injectConfirmTimeoutMs` | `10000` | How long to wait for an injection to become visible in the target session (clamped 250 ms – 60 s). Exceeding the window is uncertain, not rejection: the child and original prompt id are preserved. An unconfirmed initial launch gets one additional window of automatic reconciliation before its tracking is parked. Also bounds individual transcript and exact-message reads. |

## Scope and caveats

- Tracking state is **in-memory**: a server restart forgets pending
  notification registrations (the child sessions themselves survive and stay
  reachable via `subagent_list`/`subagent_send`). Same trade-off as
  background-tasks' crash orphans.
- Busy waits reuse tracked prompt IDs and check the newest 50 messages for
  newer work. If a prompt has already aged out, including on a stock `task`
  child, the wait can recover it through one exact lookup of an assistant's
  user-message parent. Watermark reads are bounded by `injectConfirmTimeoutMs`
  (or the wait timeout, if shorter). Unverifiable correlation fails without
  collecting completions; pending notification claims are restored for retry.
- A steer committed exactly as the child's loop is settling can go unanswered
  (host race, shared with the built-in tool's resume); the send then reports
  "ended without a new reply" rather than hanging.
- Spawned children inherit the same lockdown the built-in `task` tool applies:
  the parent session's deny/`external_directory` rules, `todowrite`/`task`
  denies, and the `experimental.primary_tools` restrictions. If the parent's
  permissions, that config, or the parent's current model (the stock
  inheritance source) can't be read, the spawn fails closed rather than
  handing the child a looser ruleset or a different model.

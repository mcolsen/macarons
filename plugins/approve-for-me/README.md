# approve-for-me

An [OpenCode](https://opencode.ai) plugin that adds **Approve for Me** for permission prompts: a classifier model looks at each request the moment it appears and approves the clearly-safe ones on your behalf. Destructive or secret-touching actions always stay on screen; high-risk actions — pushes, publishes, remote mutations, and private-data uploads — stay on screen too **unless your own messages clearly authorized them** (an explicit "push it" can auto-approve the push); anything ambiguous is yours to answer, the way Codex's *"Approve for me"* works (and unlike Claude Code's auto mode, which never asks).

The classifier model is yours to choose from every model available in your OpenCode instance. The picker offers **This session**, **project**, and **global** scopes; a session choice covers the top-level session and its descendants, and takes precedence over persistent settings. It survives OpenCode restarts until you clear it or delete the root session. With no pin at any scope, the classifier follows the asking session's model by default. Approve for Me can be flipped on and off mid-session with one keystroke, and a sidebar line always shows whether a model is currently approving things for you. Under that line, a live [activity stream](#the-sidebar-status-and-activity-stream) lists each prompt as the classifier works through it — approvals fade out on their own; anything left for you stays visible until you answer it (or, if you are away, until the [unattended-deny timer](#when-nobody-answers-the-unattended-deny-timer) turns the wait into an honest denial the agent can route around).

## How it works

OpenCode's server emits an event for every permission prompt. For each one, the plugin:

1. **Checks that Approve for Me should act at all.** The merged settings must say enabled, the instance toggle must not say paused, and the permission type must not be opted out.
2. **Applies your explicit rules first — they always beat the model.** The plugin reconstructs the same ruleset OpenCode itself evaluated for the request: the active agent's resolved rules (which fold in the merged config `permission` block and any per-agent `permission` overrides) plus the session's own rules. A matching non-blanket **ask/deny** rule anywhere in that effective ruleset (`"git push *": "ask"`, including one an agent definition added) makes the prompt always surface; the classifier is not even consulted. The tool-wide blanket that turns prompting on in the first place (`"bash": "ask"`, `"edit": "ask"`, a `"*"` entry) is *not* a carve-out — it is exactly the decision being delegated — and it cannot shadow one either: a blanket ask that lands after your carve-out (say, a session-wide ask following an agent's `"git push *": "ask"`) leaves the carve-out standing, while a later matching **allow** genuinely cancels it, just as it does for OpenCode itself — [Carve-outs and rule order](#carve-outs-and-rule-order) below spells out every ordering. persist-permissions' `permissions.local.json` is stricter still: OpenCode never enforces that file itself, so **any** matching non-allow rule there vetoes, blanket included (`"bash": "deny"` means no bash approval, ever). If the active agent or either ruleset cannot be established, auto-approval pauses for that request. Requests the store already **allows** are skipped too: re-approving them is [persist-permissions](../persist-permissions)' job and needs no model call.
3. **Asks the classifier.** The request (tool, patterns, title, metadata such as the full command) is sent to a throwaway OpenCode session created with a deny-everything permission ruleset and all tools disabled, together with the conversation context the judge needs: a bounded window of **your own messages** from the session and a short trail of the agent's recent **tool calls**. The history read is itself bounded — the newest 200 messages, never a full-session hydration — and the message window keeps the first and most recent messages while earlier ones fill a ~6k-character budget newest-first, with one marker for anything omitted (when even the 200-message page is full, the window declares that older messages could not be retrieved instead of presenting an arbitrary message as the session's start). Tool outputs and assistant prose are excluded wholesale — they are the prime prompt-injection vectors, and the tool trail alone gives the judge the workflow arc. The trail carries full titles (for a shell call, the whole command line) **only when the judge is the session's own model**, whose provider already processes the entire session; a judge pinned to any other model receives tool names only, so pinning a cheaper judge never forwards your historical commands to a provider that hasn't seen them. Each request also carries a short plugin-authored description of the tool that raised it (what `todowrite` actually touches, what the patterns mean for that tool), so the judge never guesses at OpenCode's tool semantics. Unknown or third-party tools (MCP servers, code-mode calls) raise their permission as a bare name with no arguments; the plugin recovers the pending call's actual arguments through the event's tool pointer and shows them to the judge — and if nothing concrete can be shown (no real patterns, no metadata, no recoverable arguments), the request is **never classified** and simply stays on screen. Text that a project command template expanded into the conversation is likewise never presented as your words: the judge sees the invocation you actually typed (`/deploy prod`), not the repository-defined template. The verdict comes back as strict JSON grading two axes — `{"risk":…,"authorization":…,"decision":…,"reason":…}`, see [the verdict](#the-verdict-risk--authorization) below. The plugin replaces that session's inherited system stream with its fixed classifier policy, so the normal agent prompt, project instructions, skills, and MCP instructions cannot redefine the judge. The first project-root `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` found is still supplied as bounded, explicitly untrusted context. The throwaway session is deleted afterwards. When the request comes from a sub-agent, the user-message window still comes from the root session; the sub-agent's own prompt is included separately as agent-authored, untrusted subtask text, and the tool trail is the requesting session's own.
4. **Acts on the verdict.** The risk × authorization policy matrix — enforced in plugin code, not by model obedience — decides whether the verdict may approve. An approval answers the prompt with **"once"** — never "always". A surface verdict, a model error, a timeout, an unparseable verdict, or a model that no longer exists all do exactly nothing: the prompt stays, you decide — though if nobody decides for [`unattendedDenyMs`](#when-nobody-answers-the-unattended-deny-timer) (default 20 minutes), a prompt the classifier surfaced or failed on is denied outright so an unattended session is not held hostage. The whole exchange is visible in the TUI: a stand-by toast the moment the request goes to the model (`Approve for Me is evaluating bash: git status --short…`), then a decision toast (`Approved bash: git status --short`, `Needs your approval — pushes to a remote`) — the classifier never acts invisibly. The same lifecycle is mirrored in the [sidebar activity stream](#the-sidebar-status-and-activity-stream), which — unlike a toast — does not scroll away while prompts arrive in bursts.

When the current [redact-secrets](../redact-secrets) plugin is enabled in the
same OpenCode instance, complete classifier source values are redacted before
any excerpt is cut: user history, task/subtask text, request and tool titles,
metadata, call arguments, and project guidance. This uses that plugin's live
rules and secret vault, without reusing the coding session's history pins, so
a separately pinned judge receives the same protection. It works in either
plugin load order and does not depend on the provider wire backstop. A source
that cannot be safely copied or redacted leaves the permission for you without
dispatching a classifier request. Without an enabled redactor, Approve for Me
does not perform secret detection itself. Update both plugins together to get
this pre-excerpt protection; existing transcript limits and names-only tool
trails for separately pinned judges are unchanged. Quit and restart OpenCode
after installing the updates; running sessions keep their loaded plugin code.

### One turn at a time, approvals in the order you see prompts

Scheduling is **batch-parallel, release-serial** per prompt tree (a root session plus its sub-agent children). A *batch* is the set of prompts one assistant turn's tool calls raised — the calls the model issued together in a single message, stamped with that message's id in the permission event. By default (`"processing": "parallel"`) the plugin judges the **top-of-stack batch concurrently** (bounded by `maxConcurrent`) and batches **never interleave**: the next turn's batch — or the next sub-agent's — is judged only once every prompt of the current one has settled, so a tree drains batch by batch, first-in-first-out along the prompt stack. Prompts that carry no tool pointer are conservatively batches of one.

Resolving that prompt tree is itself fail-closed. The scheduler installs a global ancestry barrier synchronously, before its first parent lookup can await; while any lookup is provisional or unresolved, the server beacon says paused and no tree can release an approval. Parent traversal is capped at 20 links in both server and TUI. An answer or session deletion that lands during the lookup cancels that exact provisional request, so a late parent result cannot resurrect it.

Whatever runs in parallel, **approvals are released strictly one at a time, in exactly the order the TUI presents prompts** — the prompt being answered is the prompt on your screen. A verdict that finishes beneath an undecided prompt (a *newer* prompt that landed above it, or simply a batch-mate above it still being judged) is **parked**, not released: the approval fires only once everything above it is decided. A prompt the classifier leaves for you (surfaced, vetoed, failed closed — or seen while the plugin was toggled off or paused) **holds its place**: nothing below it is judged until it is answered — by you, or eventually by the [unattended-deny timer](#when-nobody-answers-the-unattended-deny-timer)'s reject when a surfaced or failed prompt goes unanswered with nobody around. And when a session's ancestry cannot be established even after retries, its prompt cannot be placed in any stack — classification pauses everywhere until you answer that prompt. Before a parked approval can reply, it revalidates both the session-model selection and every authorization input that admitted the classifier — resolved opt-outs and store scope, canonical reserved-path resolution, merged config, agent/session rules, and every active or legacy store candidate — then re-enters stack admission after every wait. Any change or unverifiable read leaves the prompt for you. Once admitted, attribution and reply initiation are synchronous, so no newer prompt can enter between the final ordering check and the POST. Two things follow, by construction:

- **Nothing is ever auto-approved past a prompt you haven't decided.** You never watch an approval fire for something deeper in the stack while an earlier prompt still waits on you.
- **Little classifier spend on prompts that die unseen.** Denying a prompt makes OpenCode auto-reject every other pending prompt of that session. Batches from later turns were never judged, so a deny discards at most the in-flight remainder of the current turn's batch — calls the turn's author had already committed to together.

`"processing": "serial"` opts back into judging **exactly one prompt at a time** per tree, the strictest stance: a deny then discards zero model calls, at the cost of burst throughput — a wide turn drains one verdict at a time. Prompts from unrelated sessions (other root sessions, cron jobs) classify concurrently in both modes, bounded by `maxConcurrent`.

### Cleaning up after aborted runs

On current OpenCode versions, aborting a busy session (interrupt, a parent cancelling its sub-agents) kills its tool calls but **leaks their pending permission prompts**: no reply event is ever published, the orphans sit in the prompt stack until the instance restarts, approving them does nothing — and rejecting one by hand makes the host cascade that rejection onto *live* prompts of the session's next turn. The server half sweeps these up: once a session settles with unanswered prompts and **every one of them** verifiably belongs to a dead tool call (its tool part is in a terminal state), it rejects one — the host's own cascade clears the rest. Right before acting it re-checks that the session is still idle, re-lists the pending prompts (refusing if any prompt exists beyond the verified set), and aborts if a fresh ask arrived meanwhile; a sweep that could not run or complete retries on a bounded back-off ladder with every check repeated, since an aborted session may never emit another idle event. The host offers no atomic "reject exactly these" operation, so a theoretical window of one event-loop turn remains — the guards shrink it to the practical minimum. The sweep only ever **rejects** (it can grant nothing), never touches a session with any live or unverifiable prompt, and is disabled together with the toggle or via `"sweepStale": false`.

### When nobody answers: the unattended-deny timer

A surfaced prompt freezes its prompt tree until you answer — the ordering guarantee working as intended, but with nobody at the keyboard it holds the whole session hostage on a question the agent could often route around. So a prompt that **Approve for Me itself left on screen** — a classifier surface verdict, or a fail-closed fault like a model timeout or junk verdict — is denied after `unattendedDenyMs` (default 20 minutes) if it is still unanswered. The deny is a **reject with a message**: the message tells the agent outright that the denial was an automated timeout, not your judgment on the action, and that it should take an approach that avoids the permission rather than retry it. On the pinned hosts a reject that carries a message resolves the blocked tool call as `PermissionCorrectedError`, which the session processor deliberately does not treat as turn-ending (verified against the 1.18.5/1.18.6 sources) — so the agent actually reads the feedback and keeps working — while the host cascades plain rejects over the prompt's still-pending batch-mates exactly as your own deny would. One nuance inherited from the host: a cascaded *bare* reject does end the turn under default host settings, so a multi-prompt batch stops (cleanly, with every prompt cleared) after the feedback lands; `"experimental": { "continue_loop_on_deny": true }` in `opencode.json` lifts that if you want those turns to continue too.

The timer's scope is deliberately narrow:

- It arms **only** for prompts the classifier surfaced or failed on. Prompts your own rules reserved for you (ask/deny carve-outs, per-type opt-outs, or an opted-out `external_directory`), prompts seen while the plugin is off or paused, and prompts it refused to classify all wait for you indefinitely, exactly as before — "you said ask me" is a different contract from "the delegate said not my call".
- It can only ever **reject** — same trust family as the stale sweeper: a timed deny grants nothing, and every failed guard simply leaves the prompt waiting.
- Before acting it re-reads the trusted settings chain and re-lists the host's pending prompts, so your answer racing the deadline always wins, a mid-wait disable or toggle-off wins too — and a toggle-off disarms that prompt's deadline for good (re-enabling does not re-arm it; the toggle stamps its writes so the timer can prove the interruption at fire time).
- The host's reject cascade is session-wide, so before acting the timer also verifies **every** other pending prompt of the session is a batch-mate it may clear — armed with its own deadline, or still moving through this plugin's scheduler. If anything else is pending — a prompt your rules reserved, a stale leftover of an aborted turn, a fresh turn's prompt, anything it never tracked — the deadline stands down and the prompt stays yours. It also re-checks, sweeper-style, that no new ask arrived between verification and the reject.
- **Three timed denies per prompt tree** with no answer from you in between spend the tree's budget: after that, prompts wait for you again — an unattended agent must not grind through your model spend re-approaching a question nobody is present to answer. Any permission prompt you answer yourself in that tree resets the budget. The host's reply events name no actor, so replies this suite's own automation posts (this plugin's approvals and sweeps, a co-installed persist-permissions honoring a stored allow) are attributed through a shared in-process ledger and never count as you; an automatic reply from a plugin *outside* this suite cannot be attributed and would still read as your answer — host actor provenance would close that gap.

The sidebar's `!` line carries the live deadline (`pushes to a remote · deny in 14m`), the deny itself toasts, and the fading `✗` line says it was a timeout. Deadlines and the deny budget are instance memory: a restart drops both, which costs nothing — pending prompts do not survive a restart on these hosts anyway. Set `"unattendedDenyMs": 0` to turn the timer off.

### The verdict: risk × authorization

The classifier is not asked "is this what the user requested?" — an agent spends most of its time on routine steps no task text spells out. Modeled on the policy of Codex's auto-review guardian, it instead grades every request on two independent axes, and the **plugin** turns them into the decision:

- **Risk** — what could go wrong if the action executes once. `low`: read-only inside the project, or session bookkeeping such as the agent's own todo list. `medium`: ordinary reversible development work — editing project files, running the project's build or tests, and read-only network access that sends only the visible intended query or URL. `high`: hard to undo or reaching beyond the project — pushing/publishing, remote mutations, private/local-data uploads, installing software, changing machine state. `critical`: destructive or irreversible actions, anything touching secrets, security weakening, downloaded content executed immediately (including `curl ... | sh`), or signs of manipulated instructions.
- **Authorization** — how clearly your own words sanction that kind of action: `clear` (explicitly requested or unambiguously entailed), `implied` (a normal step for the stated task), or `none`. The judge weighs **all** the messages in its window, not just your latest — an instruction you gave earlier in the session still counts, so "push it when tests pass" three messages ago still reads as clear assent for the eventual `git push`. When the window has omitted messages, the judge is told that anything shown **before** the omission marker can never establish `clear` authorization by itself — an omitted message may have amended or withdrawn it — so a grant that predates the gap cannot carry a high-risk approval unless the recent, contiguous messages reaffirm it.

| Risk | Approved when |
| --- | --- |
| `low` | always — project reads and todo updates need no task linkage |
| `medium` | authorization is at least `implied` |
| `high` | authorization is `clear` |
| `critical` | never — the prompt is always yours |

The classifier prompt instructs the judge that a terse or stale task text (a bare "yes, go ahead") limits authorization to `none` or `implied`, and equally that terseness is *not* evidence of danger — risk is judged from the action alone, so low-risk housekeeping still approves. Be clear about what is enforced where: the risk-and-authorization **grades are the model's judgment**, steered by these instructions but not provably bound by them; what the code enforces is everything after — the `matrixDecision` thresholds live in a unit-tested function, the model's own `decision` field can only make the outcome stricter (it may veto toward surfacing, say when a request smells like prompt injection, but can never approve past the matrix), and a verdict missing either axis fails closed like any other junk.

Network transport is judged by its concrete effect, not by the tool name: an ordinary task-relevant web search, public URL fetch, read-only API request, or loopback health check is `medium`, so implied authorization is enough. Merely invoking `curl` is not exfiltration. Sending credentials, local file contents, environment values, command output, or other non-public data raises the risk; mutating an endpoint is judged by that mutation even on loopback; and piping downloaded content straight to a shell or interpreter is always `critical`. Both the built-in `websearch` tool and this suite's [`web-search`](../web-search) plugin use the same `websearch` permission action and visible query pattern, so this calibration applies to the plugin's `web_search` alias and its built-in shadow alike.

### Carve-outs and rule order

OpenCode resolves every permission request against an ordered ruleset — the active agent's resolved rules with the session's rules appended — and enacts the **last matching rule**: `allow` raises no prompt, `deny` blocks without one, `ask` prompts. Approve for Me answers a different question about the same ruleset: *may the classifier answer this prompt, or did you explicitly reserve it for yourself?* For that question the veto scan walks the ruleset from the end and stops at the last matching rule that is either an **allow** or a **narrow (non-`*`) carve-out** — blanket ask/deny rules are transparent to it. Concretely:

| Ruleset, in evaluation order | OpenCode does | Approve for Me does |
| --- | --- | --- |
| `"git push *": "ask"` | prompts | carve-out vetoes — the prompt is yours |
| `"bash": "ask"` (or a `"*"` entry) | prompts | no carve-out — the classifier decides |
| `"git push *": "ask"`, then `"*": "ask"` | prompts (the blanket wins its evaluation) | carve-out still vetoes — a blanket cannot shadow it |
| `"git push *": "deny"`, then `"*": "ask"` | prompts | carve-out still vetoes |
| `"git push *": "ask"`, then `"git *": "allow"` | allows pushes, no prompt | no veto — the later allow cancels the carve-out |
| `"git *": "allow"`, then `"git push *": "ask"` | prompts for pushes | carve-out vetoes |

The asymmetry between a trailing allow and a trailing blanket ask is deliberate. When an allow follows a carve-out, the ordering changes what OpenCode itself does — writing the allow after the carve-out is precisely how you override a carve-out in a last-match-wins system, so the plugin reads it the way the host you configured reads it. When a blanket ask follows a carve-out, OpenCode's outcome is `ask` no matter which rule wins: the ordering is invisible to the host and cannot express intent about the one question it never asks — whether a model may answer for you. There the narrow rule is the only deliberate signal, so it stands.

Reading each ruleset exactly as the host would matters because the veto cross-checks more than one: the effective agent+session rules and, as a safety net, the merged config `permission` block. When a trailing allow sits in the ruleset the host actually evaluated, no prompt exists and the veto is moot; when it sits in a cross-checked ruleset, that ruleset simply has no surviving carve-out to enforce and the others decide.

This is intentionally *not* a general "narrowest pattern wins" comparison: specificity between arbitrary wildcard patterns is ill-defined, and it would invert the allow-override row above. Note the shape of the failure modes, too — every rule here only ever widens the veto, so a misjudgment surfaces a prompt for you to answer; it can never approve one.

## The trust model

- **A classifier decision is always "once".** An "always" reply would grant OpenCode's session-wide in-memory blanket (for edits, every edit in the project) *and* is exactly what persist-permissions persists to disk. Replying "once" makes classifier decisions structurally unable to persist or broaden — there is nothing to test away, though the interaction is tested anyway.
- **The approval thresholds are code, not prompt.** The model only grades risk and authorization; the [matrix](#the-verdict-risk--authorization) that turns those grades into approve/surface is a unit-tested plugin function, and the model's own decision can only tighten the outcome, never loosen it. The per-tool descriptions the judge reads are plugin-authored too — no repository or agent text flows into them.
- **Approvals happen in the order you see prompts.** However much classification runs in parallel within a turn's batch, every approval is released top-of-stack-first: no action is ever auto-approved beneath a prompt you have not decided — a surfaced prompt freezes everything behind it until it is answered. The only replies the plugin ever sends beyond "once" are **rejects that grant nothing by construction**: the [stale sweeper](#cleaning-up-after-aborted-runs)'s clearing of a verifiably dead prompt, and the [unattended-deny timer](#when-nobody-answers-the-unattended-deny-timer)'s timeout of a surfaced prompt nobody answered.
- **Fail closed, everywhere.** Corrupt settings file, unreadable store, unreachable config, missing pinned model, classifier timeout, junk verdict: every failure leaves the prompt for you and most warn once via toast. The same stance covers requests the judge could not meaningfully review: a third-party tool whose arguments cannot be recovered, or an outside access with a shape-ambiguous boundary (including a malformed, relative, or nested-wildcard pattern), is deterministically reserved and remains manual. A concrete outside access whose effect is ambiguous is still classified, with the judge instructed to surface rather than infer. A model approval is never a bypass for a deterministic reservation: OpenCode config/state paths and host config surfaces remain yours.
- **Project instructions are context, not policy.** Classifier sessions discard OpenCode's inherited system prompt. Project guidance is supplied only in a labeled, untrusted data section and cannot grant authorization or change the approval rules; if the isolation hook does not run, the verdict is discarded.
- **Your explicit rules outrank the model.** Non-blanket ask/deny carve-outs anywhere in the effective ruleset the host evaluated — agent-resolved config rules or session rules — veto classification outright, even when a broader blanket ask sits after them; only a later matching allow (which for OpenCode itself would suppress the prompt) cancels a carve-out. Any matching non-allow rule in the store vetoes too, blanket included. A ruleset that cannot be established pauses approval for that request instead of weakening the check, and all of these inputs are re-read before every approval release so a rule tightened during classification wins too.
- **The agent cannot rewrite authorization state through ordinary project access.** The plugin registers no tools; its global and personal-project settings, persist-permissions' project-keyed rule store, and the worktree-config blessing all live in OpenCode's config/state directories outside the worktree. Worktree config CAN configure this plugin, but only while its exact bytes match [a blessing you recorded](#worktree-config-and-the-blessing) — an agent edit drifts the hash and pauses auto-approval rather than taking effect. OpenCode config/state paths and host config surfaces (`opencode.json[c]`, anything under `.opencode/`) are reserved deterministically and never auto-approved. Ordinary external access can be classified only when its concrete target and effect are reviewable; arbitrary same-user code execution remains outside this guarantee.
- **The posture is visible — and honest.** The sidebar shows an **Approve for Me** header over the classifier selected for the **viewed session** (including a session-scoped selection), `off (this instance)`, or `paused · <reason>` whenever a session is open — and the activity stream under it accounts for every prompt the classifier touched, skipped, or could not judge. Saying `on` takes more than the settings files: the server half maintains a ready/paused beacon for shared faults such as an unreadable config or store, while the TUI checks the viewed session's effective judge against the instance's model catalog — so a server half that is paused, missing, or misconfigured renders as `paused · <reason>`, never as a false `on`.

Config, store, and ancestry pauses have independent ownership. Healing or answering one cannot make the beacon say ready while another pause is still active, and stale asynchronous path initialization cannot publish an older ancestry state over a newer one.

## Turning it on and off

Installed means enabled: like persist-permissions, installing the plugin is the opt-in. From there:

- **`<leader>d` — Approve for Me: toggle for this instance** (also `ctrl+alt+a`, or the command palette). Pauses or resumes auto-approval for the running OpenCode instance only, like Claude Code's shift+tab: the toggle dies with the instance and the persistent default takes over again on next start. It takes effect on the very next permission request — no restart.
- **Approve for Me: set persistent default** (palette). Enables or disables durably, for this project or globally.
- **Approve for Me: trust project plugin config** (palette). Reviews and approves worktree-local OpenCode config so it may configure this plugin — see [the blessing](#worktree-config-and-the-blessing).
- No TUI? Set `"enabled": false` in a settings source (below).

The server plugin creates a fresh random instance ID at initialization. Attached TUIs discover that ID over their existing server connection, including standalone OpenCode's in-process transport. Overrides and activity files include both the project key and that owner ID, so starting, toggling, disposing, or crashing a peer on the same checkout and state directory cannot change your OFF setting. TUIs attached to the same server plugin instance share its toggle. Restarting or reloading that server plugin creates a new owner and restores the persistent default; detaching a TUI does not reset anything.

**Upgrade and restart the server and every attached TUI together.** A new TUI connected to an old server refuses to toggle because it cannot discover the owner. The reverse is not safe: an old TUI connected to an upgraded server can report **OFF while the server continues auto-approving**, because its legacy toggle writes have no effect on the new server. Do not rely on an old TUI's OFF confirmation after a server-only upgrade; stop and restart those TUIs before resuming work.

The new channel does not read, mirror, migrate, or delete either old project-only ephemeral filename generation: those files may still belong to a live older process. Even treating legacy OFF files as a pause gate would let that older process control unrelated new instances. Crash leftovers are inert under their old owner IDs and are not inherited or automatically reclaimed. File age and beacon timestamps do not prove an owner is dead, so automatic cleanup could erase a live idle owner's OFF setting; remove orphaned ephemeral files only with all instances sharing that state directory stopped. Persistent project/global settings, blessings, session model choices, and approvals journals keep their existing shared scopes.

A toggle takes effect when its file is written, but its success toast waits for a live-owner confirmation and a fresh read of the saved value. Discovery waits up to two seconds per probe by default; internal callers can request longer budgets, capped at ten seconds. Presses within one TUI are serialized; simultaneous writes from different attached TUIs are not a transaction, and a detected competing write produces a warning rather than overwriting it again.

## The sidebar: status and activity stream

The sidebar section has two parts. The **status line** shows the trust posture for the viewed session whenever a session is open: the effective classifier model (session-scoped, project/global-pinned, or `session model`), `off (this instance)`, `paused · <reason>`, or a brief `starting…` while the first reads land. `on` is a verified claim, not an echo of the settings: the server half writes a ready/paused beacon into the instance-scoped activity file (so an unreadable store or config shows as `paused · the permission store is unreadable or invalid JSON`, and so on), a beacon that never appears renders as `paused · server half not running` (server half not installed, or dead), and a pinned model or variant missing from the instance's catalog shows as `paused · pinned model … unavailable here` before any request ever reaches the server. A malformed or unavailable session-scoped pin pauses only that session tree.

Owner discovery is refreshed every five seconds, before toggling, and on host reconnect/disposal events. A transient identity-discovery failure suppresses the live-status claim and blocks toggles, but keeps existing watchers and activity annotations while their shared-filesystem proof remains valid. A failed filesystem proof or reconnect/disposal invalidation clears the mirror and stops its watchers until storage is verified again; discovering a replacement owner switches to its files and requires a new proof. Unverified storage means controls unavailable and server state unknown, not that classification has stopped. The host exposes no disconnect notification, so abrupt crashes still rely on the periodic probe and its timeout to stop trusting a leftover beacon.

Under it, the **activity stream** shows one line per permission prompt of the viewed session (sub-agent prompts included), so a fast burst of requests stays legible where toasts scroll away — and you can always tell whether the plugin is working on a prompt or waiting on you:

```
Approve for Me
on · session model
⋯ bash: git push origin main
! edit: src/index.ts
  needs manual review of the diff
✓ bash: git status --short
```

- `⋯` — the classifier is evaluating this prompt right now.
- `!` — the prompt is yours, with the cause underneath: the classifier surfaced it (and why), a rule of yours vetoed classification, the type is opted out, or a failure fell closed. The cause renders in full — wrapping across lines rather than truncating — because a cut-off "why" is exactly what makes a risky prompt look innocuous. **These lines persist until the prompt is answered.** When the [unattended-deny timer](#when-nobody-answers-the-unattended-deny-timer) is armed, the cause line also counts down to the deadline (`pushes to a remote · deny in 14m`).
- `·` — waiting for you, no classifier involvement.
- `✓` / `✗` — answered; these fade out after a few seconds. A green `✓` is the classifier's approval; a muted one is your own answer.
- More than four pending prompts collapse into a `+N more waiting` tail.

Pending items come from OpenCode's own permission state — the annotations arrive through an instance-scoped activity file the server half writes (same channel, trust boundary, and lifetime as the toggle override: it lives in OpenCode's state directory outside the worktree, and only its owning instance clears it on disposal). The file is display-only; no approval decision ever reads it. If it is unreadable the stream simply shows unannotated pending prompts.

## Choosing the classifier model

By default the classifier is **the model the asking session is currently using** — switch models mid-session and the judge follows. To choose a classifier model, use the palette command's scope step:

- **This session** stores the choice for the top-level session and all of its descendants. It takes precedence over project and global settings and survives restarts until cleared or until the root session is deleted.
- **Project** and **global** save the choice in their respective persistent settings scopes.
- **Use project/global setting** removes a session override and resumes the merged persistent selection. This is different from explicitly choosing **Session model**: that choice ignores persistent model pins and follows each asking session at its default effort.
- Or set `"model": "provider/model-id"` in a settings file by hand.

A project/global pinned model that is no longer available **pauses auto-approval** (with a warning toast) rather than silently falling back to a model you never chose to trust. An unavailable or malformed session-scoped pin pauses only that session tree.

Session-scoped pins require a working `O_NOFOLLOW` open flag and stable filesystem inode identities. On platforms or state filesystems without those capabilities, the plugin warns once and leaves session-scoped pins unavailable; project/global classifier settings continue to work.

### Effort level (model variants)

OpenCode expresses reasoning effort as **model variants** — the levels you cycle with `ctrl+t` in the TUI, like `low`/`medium`/`high`/`max` on reasoning models. The classifier can be pinned to one:

- When the model you pick in the palette defines variants, the picker adds an **effort step** — *Model default* or one of its variants. Explicit **Session model** uses the asking session's default effort.
- Or set `"variant": "high"` in a settings file by hand (this also works alongside the session-model default; it then applies to whatever model judges).

A variant the judge model does not define **pauses auto-approval** with a warning. The host would silently ignore it and judge at the default effort — quietly weakening (or overpaying for) the judge you configured — so the plugin refuses instead. In the **project** file, `"variant": null` overrides a global pin back to the model default; `"default"` means the same thing.

### Classification timeout

One classification gets a wall-clock budget of **2 minutes** by default — sized so local and budget cloud judges, which can legitimately take well over a minute per verdict, are not cut off mid-thought. On timeout nothing is decided for you: the prompt simply surfaces. To change it:

- **Approve for Me: set classifier timeout** (palette) picks a preset budget from 15 seconds to 10 minutes — or *Default (2 minutes)* — then asks whether to save for this project or globally.
- Or set `"timeoutMs"` in a settings file by hand (milliseconds, clamped to 5000–600000). In the **project** file, `"timeoutMs": null` overrides a global value back to the default.

## Settings

Settings are **standard OpenCode plugin configuration**: the options object on this plugin's entry under `"plugin"` in the host's own config. Three persistent layers, merged **field by field**, later layers on top:

| Layer | Where |
| --- | --- |
| Global | This plugin's `["<spec>", { …settings }]` entry in `opencode.jsonc` (or `opencode.json` / `config.json`) in the OpenCode config directory (`~/.config/opencode/` by default) |
| Project, repo-shared | The same entry form in worktree config — `opencode.json[c]` at the project root (or any directory between it and the instance directory; in a non-git session the host searches every ancestor of the launch directory, and so does this scan) or `.opencode/opencode.json[c]` — honored **only under a [blessing](#worktree-config-and-the-blessing)**, and inert (exactly like the host) when `OPENCODE_DISABLE_PROJECT_CONFIG` is set |
| Project, personal | `permissions-approve-for-me/projects/<project-basename>-<short-root-hash>.json` in the OpenCode config directory — what the TUI's project-scope saves write |

The **This session** choice is not a new Settings field or plugin option. It is trusted session state, keyed to the root session and stored outside the project. Policy reads open the record once without following a final symlink, require that descriptor to be a regular file, and verify its identity and canonical containment before reading through the same descriptor. Writes are canonicalized and containment-checked; root-session cleanup revalidates the canonical parent before unlinking. An override takes precedence over the persistent layers for that session tree; clearing it with **Use project/global setting** removes the record and reveals the merged persistent result again. The record itself is also removed when the root session is deleted. That deletion cancels every exact-session provisional, unresolved, queued, active, or parked request and clears its timers/bookkeeping; cleanup is terminal state, not a user answer, so it never resets another prompt tree's presence budget.

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": [
    ["file:///path/to/macarons/plugins/approve-for-me/src/index.ts", {
      "enabled": true,
      "model": "anthropic/claude-sonnet-5",
      "variant": "high",
      "timeoutMs": 120000,
      "processing": "parallel",
      "maxConcurrent": 4,
      "notify": true,
      "journal": true,
      "sweepStale": true,
      "unattendedDenyMs": 1200000,
      "permissions": { "edit": false }
    }]
  ]
}
```

One deliberate divergence from how the host reads this file: the plugin takes its settings **from disk, never from the options object the host passes it**. The host merges project-local config over global config and dedupes plugin entries last-wins with *no provenance attached* (verified against the 1.18.10 sources), so options arriving through the host could have been swapped in by a worktree file the agent can write. Reading the global file directly — and gating worktree files behind the blessing — keeps authorization policy pinned to files only you control. Entries in `~/.opencode/` or injected via `OPENCODE_CONFIG`/`OPENCODE_CONFIG_DIR`/`OPENCODE_CONFIG_CONTENT` are not read as settings sources; a global candidate that turns out to be a symlink out of the config directory (or into the project) pauses instead of being trusted. Within one layer the host's own semantics hold: across the three global candidates a later file that defines `"plugin"` replaces the earlier array *wholly* (an entry a later array shadows is dead, and stays dead here too), and within the winning array the last matching entry wins. Across layers, fields merge individually, so a repo can pin one knob without erasing your global choices. Spec spellings are matched the way the host resolves them — `npm:` aliases, `.`-prefixed paths, `{env:…}` substitution included. TUI global-scope saves edit the winning global file surgically (`jsonc-parser`, the host's own editor) — comments survive.

- `enabled` — the persistent default (default `true`).
- `model` — persistent classifier pin as `provider/model`; omit to follow the session model. In the **project** file, `"model": null` explicitly overrides a global pin back to the session model. A This session choice is stored separately as trusted session state and is not represented by this option.
- `variant` — pinned effort level (a model variant the judge model defines, e.g. `"high"`); omit for the model default. `null` (or `"default"`) in the project file overrides a global pin. A variant the judge model lacks pauses auto-approval instead of silently judging at default effort.
- `timeoutMs` — wall-clock budget per classification (default 120000 — 2 minutes — clamped to 5000–600000). On timeout the prompt simply surfaces. `null` in the project file overrides a global value back to the default. Also settable from the palette: [**Approve for Me: set classifier timeout**](#classification-timeout).
- `processing` — [how prompts are scheduled](#one-turn-at-a-time-approvals-in-the-order-you-see-prompts) (default `"parallel"`). `"parallel"` judges one assistant turn's parallel tool calls concurrently while still releasing every approval in stack order; `"serial"` judges strictly one prompt at a time per tree, so a deny cascade can never discard an in-flight model call.
- `maxConcurrent` — how many classifications may run at once, **across unrelated prompt trees and within a turn's batch** (default 4, clamped to 1–16). A prompt you answer while it waits its turn is settled by your answer alone and never costs a model call.
- `notify` — the stand-by and decision toasts (default `true`).
- `journal` — record each classifier approval in the durable per-project [approvals journal](#enshrining-frequent-approvals-the-enshrine-approvals-skill) (default `true`).
- `sweepStale` — [auto-reject prompts orphaned by an aborted run](#cleaning-up-after-aborted-runs) once their session has settled and every one of them is verifiably dead (default `true`).
- `unattendedDenyMs` — how long a prompt the classifier [surfaced or failed on](#when-nobody-answers-the-unattended-deny-timer) may wait unanswered before it is denied with an explanatory message (default 1200000 — 20 minutes — clamped to 60000–86400000). `0` (or any value ≤ 0) disables the timer; `null` in the project file overrides a global value back to the default. Prompts your own rules reserved are never timed.
- `permissions` — per-type opt-outs, e.g. `{ "edit": false }` means file edits always surface and `{ "external_directory": false }` keeps outside-directory boundary prompts manual. The map merges per key across the layers.
- `scope` — which persist-permissions store is the **active** one in a linked worktree, `"repository"` (default) or `"worktree"`. Set it only if you changed persist-permissions' own `scope` option, and keep the two in agreement: only an allow in the active store defers to persist-permissions, and the approvals journal records the active store's path so the enshrine skill writes where that plugin actually reads. Both candidate stores keep vetoing regardless of scope. An unknown value pauses auto-approval like any other mistyped setting.

Settings are re-read on every permission request, so edits apply immediately. A source that is unreadable or mistyped **pauses auto-approval entirely** until fixed — a trust setting that cannot be read must never default to "approve".

### Stable storage paths

The package and plugin are now named `approve-for-me`, but their shipped storage identity remains `permissions-approve-for-me`. Existing personal project settings, blessings, session model pins, instance overrides/activity, and approvals journals therefore remain at their current paths under `<config>/permissions-approve-for-me/` and `<state>/permissions-approve-for-me/`. The retired files `permissions-approve-for-me.json` and `.opencode/permissions-approve-for-me.local.json` also keep their names and their fail-closed migration guards. Host config entries using the old package spec remain recognized separately, so restrictions such as `enabled: false`, permission opt-outs, and model pins are not forgotten during the rename.

There is no automatic storage migration and no new parallel storage tree. Do not move or rename these files for the package rename: doing so would make established policy and state disappear from view.

### Worktree config and the blessing

Worktree-local config is agent-writable — that is why earlier versions refused to read it at all. It IS honored now, under one condition: **its exact bytes must match what you approved**. The palette command **Approve for Me: trust project plugin config** shows every worktree config file that declares plugin entries (plus any sideloaded `.opencode/plugin{,s}/*.ts` source) and records each file's sha-256 in the trusted state directory, outside the worktree. From then on:

- A worktree file naming this plugin whose bytes match the blessing contributes its entry options as the repo-shared settings layer.
- Any change — a `git pull`, your own edit, or the agent's — breaks the match and **pauses auto-approval** until you review and re-trust. So does **removing** a blessed file that supplied settings, or stripping its entry: the trust flow then records the removal explicitly. Pausing rather than silently dropping the layer is deliberate: a blessed layer may carry restrictions (`"enabled": false`, permission opt-outs), and ignoring it on drift *or disappearance* would *widen* what gets auto-approved.
- Revoking trust forgets every approved file.
- One host quirk to know: OpenCode itself rewrites a config file that lacks `"$schema"` on first load (it inserts the key and saves). Blessing from the running TUI — the normal flow — always happens after that rewrite, so it never bites; only tooling that records a blessing *before* the first start can see an immediate drift.

Blocking the agent from *writing* these files is not enforceable — it runs as your user, and `bash` offers endless side channels — so the design makes unreviewed writes **inert** instead. Two hardenings back it up: the classifier **never auto-approves an edit touching a host config surface** (`opencode.json[c]` anywhere, anything under `.opencode/` — checked on the canonicalized target too, so a symlink alias does not hide it) no matter what the judge model concludes, and the server half **warns about sideloaded plugin code** the host loads without review (`.opencode/plugin{,s}/` sources and unblessed worktree plugin entries) — code that could answer permissions with none of this plugin's checks. That warning fires at startup and again at the first permission request, because the host keeps no toast history for a TUI that attaches later. It is a host-level exposure this plugin can flag but not close.

### Migrating from permissions-approve-for-me.json

Global settings used to live in a bespoke `permissions-approve-for-me.json` in the OpenCode config directory. That file is retired: if it still exists, Approve for Me **pauses** and says so — move its contents onto your global plugin entry (`["<spec>", { …settings }]`) and delete the file. Pausing beats silently ignoring it, which would drop policy you once wrote (an `"enabled": false`, say).

Likewise, versions that used `.opencode/permissions-approve-for-me.local.json` do not import it automatically. If that legacy file exists and the trusted project file does not, Approve for Me pauses and reports the new destination. Review the old file yourself, copy the complete settings to the reported config-directory path, then remove the legacy file. Project-scoped TUI saves remain blocked until that migration is complete so a partial save cannot accidentally discard a legacy disable or permission opt-out.

## Using it with persist-permissions

The two plugins are designed to compose, and their interaction is covered by co-installation tests:

- A request the store **allows** is persist-permissions' turf: it re-approves instantly and Approve for Me spends no model call.
- **Any matching store ask/deny rule vetoes the classifier — blanket ones included.** OpenCode itself never enforces `permissions.local.json`, so unlike a config blanket, a store-wide `"bash": "deny"` cannot be delegated away; it always surfaces the prompt.
- A classifier approval replies "once", which persist-permissions ignores by design — **nothing a model approves is ever written to `permissions.local.json`.** Your own "always" answers persist exactly as before.
- persist-permissions keys its store by the repository's **primary worktree root** by default, so one store covers the primary checkout and every linked worktree. In a linked worktree Approve for Me reads *both* candidate files — the shared repository store and any store still keyed by that worktree's own root (pre-repository-scope data, or persist-permissions' `scope: "worktree"`). Each file is evaluated as its own last-match-wins ruleset, and a matching non-allow rule in **either** vetoes — reading both for vetoes is always at least as strict as either alone. Deferral is narrower: only an allow in the **active** store (per the `scope` setting) skips classification, because only that file makes persist-permissions actually answer the prompt.
- If the primary worktree root cannot be established in what git confirms is a real work tree — a corrupted or tampered `.git`, say — Approve for Me **pauses** rather than classify without the repository-scoped store's carve-outs. persist-permissions still *saves* under per-worktree keying in that situation (a narrower store only ever shares less), but it pauses its own auto-approval reads for the same reason this half pauses: neither may answer a prompt from a ruleset that omits a store's carve-outs.
- Legacy worktree stores are never imported automatically. If `.opencode/permissions.local.json` exists and the trusted project store does not, both plugins pause until you review and migrate it to the config-directory path they report.

## Sibling-plugin interop: the `./interop` entrypoint

[codex-limits](../codex-limits) and [synthetic-limits](../synthetic-limits) show the viewed session's effective classifier provider limits in the sidebar next to that session model's. They ask through this package's `./interop` entrypoint — `resolveClassifierConfig()`, the one deliberate cross-plugin API in the suite — which answers "which provider does the active classifier spend quota on right now?" from the same trusted settings chain the server half runs, including the viewed session's trusted session selection: trusted-path resolution, the fail-closed pause gates, the policy snapshot, and the instance toggle — gated on the server half's activity beacon, so a classifier that is merely configured (server half absent, or paused on an instance-wide fault) yields no answer. Everything else in this package (the settings schema, the file layout, `./shared` wholesale) is internal and may reshape between releases; the repo guard (`tests/repo/test/cross-plugin-imports.test.ts`) holds sibling plugins' runtime imports to this entrypoint, and its behavioral contract is pinned in `test/interop.test.ts` here, next to the code it mirrors.

## Enshrining frequent approvals: the `enshrine-approvals` skill

A classifier approval is always "once", so ten identical `git status` prompts cost ten model calls. When a pattern like that is genuinely read-only, the better end state is a persistent rule you wrote deliberately. The package ships an [OpenCode skill](https://opencode.ai/docs/skills/) for exactly that hand-off, fed by a journal the server half keeps:

- **The approvals journal** is a durable, project-keyed record of what the classifier approved: `permissions-approve-for-me/approvals/<project-basename>-<short-root-hash>.json` under OpenCode's state directory (`~/.local/state/opencode` by default). Each approval is aggregated under the narrowest pattern persist-permissions would save for an "always" answer — `git status *`, a concrete file path — with counts, first/last timestamps, and the verdicts' risk grades. Each write also records the resolved `storeFile` — the store persist-permissions actually uses for this project, which since repository scope is keyed by the primary worktree root and is therefore not derivable from the journal's own filename. The journal is advisory output, never policy input: no approval decision reads it, a journal that cannot be parsed warns once and starts over, and it stays bounded (the 400 most recently seen patterns survive; two instances on one project can cost each other counts, the store's own caveat family). Set `"journal": false` in a settings file to stop recording.
- **The `enshrine-approvals` skill** directs the agent through the hand-off: read this project's journal, shortlist patterns that are frequent *and* genuinely read-only, drop anything an existing rule already covers, and propose the rest — each rule confirmed by you individually — into persist-permissions' project store (effective on the very next prompt) or the global `opencode.json` `permission` block (applies everywhere, after a restart). Patterns are proposed verbatim, never widened, and the skill refuses to touch a store whose [legacy migration](#using-it-with-persist-permissions) is still pending.

Install the skill by pointing your **global** config at the package's `skills/` directory (a project-local skill path would let a repository rewrite the instructions that draft your permission rules):

```json
{
  "skills": { "paths": ["/path/to/macarons/plugins/approve-for-me/skills"] }
}
```

or symlink it into the global skills directory:

```sh
ln -s /path/to/macarons/plugins/approve-for-me/skills/enshrine-approvals \
  ~/.config/opencode/skills/enshrine-approvals
```

Skills are discovered at instance start; the agent then loads this one on demand through the host's `skill` tool whenever you ask for fewer permission prompts or to persist what keeps getting approved. The trust framing is the same as everywhere else in this README: the skill is instructions, not enforcement. What the hand-off actually rests on is your rule-by-rule confirmation in the conversation — nothing is enshrined that you did not individually confirm. Because the store and config sit outside the worktree, the writes the skill proposes normally also pass through the host's external-directory and edit prompts, and the skill insists on the file tools (never shell redirection) precisely so those prompts can fire — but treat that second look as defense in depth, not a guarantee: an existing rule, or an "always" answer you gave earlier in the session, can let a write through without a prompt.

## Install

Clone the repository as described in the [root README](../../README.md), then
run `bun install && bun setup` from the checkout root and select `approve-for-me`.
The wizard configures both halves in your user-level config using local source
paths. The alternatives below also require the checkout dependencies.

### Upgrading from permissions-approve-for-me

Change package specs from `@macarons/permissions-approve-for-me` to `@macarons/approve-for-me`, checkout paths from `plugins/permissions-approve-for-me` to `plugins/approve-for-me`, and copied bundles from `permissions-approve-for-me.js` to `approve-for-me.js`. Remove the old copied bundle after placing the new one so OpenCode does not load both. The installer recognizes and rewrites its managed legacy package and path entries when run against the renamed plugin.

The settings scanner still recognizes `@macarons/permissions-approve-for-me` and its already-supported older aliases. This is a safety measure so a legacy entry carrying `enabled: false`, opt-outs, or a stricter model pin is not silently ignored during an upgrade; it is not a reason to keep an unresolvable old install spec. Leave the [stable storage paths](#stable-storage-paths) untouched, then restart OpenCode so both renamed halves load together.

### Option A: OpenCode's local-package installer

```sh
opencode plugin /path/to/macarons/plugins/approve-for-me
```

Run it from your project directory (`-g` for the global config instead). It detects the `server + tui` targets from this package's `exports`, adds the spec to `.opencode/opencode.json` (server half) and `.opencode/tui.json` (TUI companion), and both halves load on next start. The checkout must have had `bun install` run once — the server half imports the monorepo's `@macarons/permission-rules` library.

A **project-local** install lands the entry in worktree config, which is gated by [the blessing](#worktree-config-and-the-blessing): run **Approve for Me: trust project plugin config** once after installing (and after any edit to that file) or auto-approval stays paused. A global (`-g`) install needs no blessing.

### Option B: reference it from config

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///path/to/macarons/plugins/approve-for-me/src/index.ts"]
}
```

In the **global** `opencode.jsonc` this entry is also where [settings](#settings) ride — turn the bare spec into `["file://…/src/index.ts", { …settings }]` (the TUI's global-scope saves do that for you).

Then add the TUI companion to `tui.json`:

```json
{
  "plugin": [
    ["file:///path/to/macarons/plugins/approve-for-me/src/tui.tsx", { "keybind": "<leader>d,ctrl+alt+a", "sidebar": true }]
  ]
}
```

TUI options: `keybind` — key(s) for the instance toggle, comma-separated alternatives (default `<leader>d,ctrl+alt+a`; only the first alternative shows in the command palette's keybind hint, the rest stay functional but undisplayed; `"none"` or `false` leaves only the palette entries); `sidebar` — the status line (default `true`); `feed` — the activity stream under it (default `true`; off whenever `sidebar` is off).

### Option C: copy one file (server half only)

Run these commands from `plugins/approve-for-me` after installing dependencies
at the checkout root. The destination below is relative to that directory;
use your target project's `.opencode/plugin/` directory when installing elsewhere.

```sh
bun run build
mkdir -p .opencode/plugin
cp dist/approve-for-me.js .opencode/plugin/approve-for-me.js
```

The bundle is self-contained (the shared library is inlined). Without the TUI companion there is no toggle, no picker, and no sidebar — control Approve for Me through the settings sources. Note that `.opencode/plugin/` is exactly the sideload surface the server half warns about (any TUI on the project can quiet it by trusting the file), and with no TUI anywhere to record a blessing, prefer Option B against the global config.

## Scope and caveats

- **The prompt appears while the classifier thinks.** This is a host constraint, not a choice: OpenCode 1.17-1.18 publishes the prompt event before any plugin can react, and the `permission.ask` hook that could pre-empt it is declared in the plugin API but never triggered by the host (verified against the 1.17.14 and 1.18.3 sources; the TUI plugin surface is read-only over pending permissions too). So the prompt cannot be held back — instead the stand-by toast and the sidebar's `⋯` marker tell you the classifier is working on it. Approved prompts clear on their own; answer yourself at any time and the classification is abandoned, your answer wins.
- **Every classified prompt is a model call.** With the default session-model setup that can mean frontier-model pricing per prompt; pin something cheaper if that bothers you. Requests covered by persist-permissions' store cost nothing.
- **Prompt injection is real.** Command text, tool metadata, tool-call titles, and (for sub-agents) subtask descriptions reach the classifier as data, clearly delimited and with instructions to ignore embedded orders — and tool **outputs** and assistant prose are excluded from the classifier's context entirely, cutting off the highest-bandwidth injection route (a hostile file or web page can never speak to the judge directly). Still, a sufficiently persuasive payload fooling the classifier cannot be ruled out. The narrow blast radius is the mitigation: one "once" approval, never a blanket, never persisted. Keep deny rules for the truly dangerous in `opencode.json`, where OpenCode enforces them without any prompt at all.
- **External-directory access is skeptical, not categorically excluded.** The classifier may consider a concrete, ordinary outside read — for example, reading a related checkout or project directory, or using disposable staging under `/tmp` — and applies the same risk × authorization policy. Only a well-formed absolute `<dir>/*` external boundary pattern is eligible for classification; malformed, relative, or nested-wildcard shapes remain manual. Ordinary external writes clear a higher bar: they are high risk and need clear authorization, while sensitive data, secrets, security-relevant state, or destructive effects are critical; an ambiguous target or effect is sent to the judge with instructions to surface rather than infer. OpenCode config/state paths and host config surfaces are reserved deterministically and remain yours. The host can raise `external_directory` *in addition to* the tool's own `read`/`edit` prompt, so one operation can produce two classifier calls; approval of the boundary does not approve the underlying operation, and each prompt must pass independently. Set `permissions.external_directory` to `false` to opt out and keep the boundary prompt manual. This is not an OS sandbox against arbitrary same-user code execution or an external-access detector bypass.
- **Command provenance is marked at execution time.** A project command's template text is excluded from the judge's user-message window (your `/command args` invocation is shown instead) because the plugin marks the expanded parts the moment the command runs. Command messages persisted before this version — or while the server half was not loaded — carry no marker and still read as ordinary user text.
- **Project guidance is size-capped and re-read every request.** The first `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` at the project root is read fresh for each classification, so an edit reaches the very next prompt — there is no cache to go stale. A guidance file over 256 KB is skipped with a one-time warning rather than loaded: the classifier prompt only ever uses the first few thousand characters, so an oversized file could add no signal, and the next candidate filename is used instead.
- **The interactive controls require verified shared storage.** Before reading permission state or changing settings, the TUI must complete a fresh round trip through temporary owner-only proof files in the enforcing server's config, state, and project directories: read the server's challenge, write a response, then read the server's acknowledgement of that write. Proof is renewed for controls, after dialogs, and on reconnect. Matching path strings, readable copies, an internal hostname, or a loopback URL are not enough: tunnels and containers may have different or copy-on-write filesystems. An attach with genuinely shared writable directories can work, but otherwise the controls report unavailable and the sidebar reports unknown server state, never a false OFF. This does **not** disable the server's classifier. Update both halves and restart OpenCode; an older server half cannot answer the challenge.
- **Read-only project roots cannot pass the TUI proof.** The server must create temporary markers in every required directory, including the project root and the actual policy-containing config/state directories, and both halves must update them. Policy still lives outside the project; proving the project mount prevents shared config/state from masking a different checkout behind a tunnel. Use shared writable roots for the controls, or use server-side configuration and the normal permission prompt instead.
- **Verification can delay a control.** Each proof has a three-second budget, including cleanup. A dialog flow checks before opening and again after confirmation, so slow successful checks can add multiple waits to one action. A failed gate stops that stage without saving; the post-dialog check is not skipped because an earlier check succeeded.
- **Abrupt crashes can leave temporary proof files.** Normal completion, cancellation, expiry, and disposal clean up markers, but a simultaneous server/TUI crash can leave `.macarons-locality-*` files behind. Fresh checks never reuse them. There is no startup sweep because another instance sharing those directories may own a live proof; remove leftover markers only after stopping all OpenCode server and TUI instances using those directories.
- **Multiple instances can share a project.** The toggle and stream are isolated by server plugin instance ID; intentional project/global settings and approval history remain shared. Owner discovery does not replace the shared-filesystem proof: both must succeed before the TUI reads or changes an owner's files.
- **Install the plugin itself from a trusted location for a strong boundary.** A project-local plugin or project config can be changed by an agent with sufficient project access and takes effect after restart. A global config entry does not protect the source checkout it points to: keep that checkout outside agent-writable projects as well to avoid moving the trust problem from settings to executable code.
- **List system-prompt-injecting plugins before this one.** The classifier session's isolation works by replacing the whole system stream in the system-transform hook, and hooks run in `plugin` array order — a plugin listed *after* this one can still append to the classifier's prompt (`scoped-system-prompts` can modify matching classifier requests, for example). The installer places `approve-for-me` after system-prompt injectors within each managed server plugin array. Plugins loaded later from unmanaged config files or auto-discovery origins are outside that ordering guarantee; order those origins manually so `scoped-system-prompts` and anything similar run before `approve-for-me`.
- **Version target: OpenCode v1**, with the verified band riding the repo's pinned OpenCode release (floor = the pin, ceiling = its next minor), `engines.opencode` declaring only the static v1 install gate, and the same runtime guard as persist-permissions: a v1 host outside that band warns but keeps auto-approving, and only OpenCode v2+ (major ≠ 1) disables the plugin (path and `file://` installs bypass engine checks; the guard is tested end to end via the shared library's spec). The V2 permission engine reshapes the permission API — the reason v1 is the hard boundary; revisit both plugins together when it lands.

## Development

```sh
bun install        # from the monorepo root
bun run check      # lint, typecheck, unit tests, build — all packages
```

To work on only this package: `cd plugins/approve-for-me && bun test`. The unit suites cover the settings pipeline, the veto table, the classifier plumbing, session-scoped model selection, the activity-feed channel and its render model, the approvals journal, the full server-half behavior against a mocked host (including co-installation with persist-permissions driven side by side, and the unattended-deny timer's arm/fire/guard/budget lifecycle), the TUI companion through a typed API mock, and the packaging/bundle/SDK contracts (the enshrine-approvals SKILL.md included).

From the monorepo root, the real-host E2E suites (`bun run e2e`, `bun run e2e:tui`) drive the OpenCode release pinned in `.opencode-version` with a loopback scripted provider that answers classifier calls with scripted verdicts: approve/pin/surface/fail-closed/veto journeys, both co-installation directions, the installer, the copy-installed bundle, and the tmux-driven toggle/sidebar journey.

The wildcard matching, rule evaluation, and version guard come from [`@macarons/permission-rules`](../../libraries/permission-rules), the same single copy persist-permissions runs; its behavior spec lives in that plugin's `test/matching-spec.test.ts`.

The plugin logs decisions to the server log (`~/.local/share/opencode/log/opencode.log`) under service `approve-for-me`.

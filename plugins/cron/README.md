# opencode-cron

An [OpenCode](https://opencode.ai) plugin that gives the agent Claude Code's
**cron tools**: `cron_create`, `cron_list`, and `cron_delete`. Ask for "remind
me at 2:30 to check the deploy" or "re-run the smoke test every 20 minutes"
and the agent schedules it; when a job fires, its prompt is enqueued into the
same session as an ordinary user turn — but only while the session is idle,
never mid-reply.

This is the lightweight, in-session scheduler from Claude Code (and Codex),
not a persistent background-job system: jobs live in memory, belong to the
session that created them, and are gone when OpenCode exits.

## The tools

| Tool | What it does |
| --- | --- |
| `cron_create` | Schedule a prompt with a standard 5-field cron expression in **local time** (`"30 14 11 7 *"` = July 11, 2:30pm). `recurring: false` makes it a one-shot reminder that deletes itself after firing. Returns a job ID. |
| `cron_list` | List this session's jobs: ID, schedule, next fire time, expiry, and prompt. |
| `cron_delete` | Cancel a job by ID. Only the session that owns a job can delete it. |

## Semantics (faithful to Claude Code)

- **Session-scoped and in-memory.** Nothing is written to disk. Jobs disappear
  when OpenCode restarts and when their session is deleted. Two OpenCode
  instances on the same project can never double-fire a job, because each only
  knows its own.
- **Idle-gated delivery.** A fire that lands while the session is working is
  held and delivered when the session next goes idle. Repeat fires of the same
  recurring job that pile up while busy coalesce into a single delivery.
- **Deliveries are isolated and bounded.** The scheduler reserves due jobs in
  creation order without waiting for earlier deliveries and immediately
  re-arms for the next job. Prompt writes retain that order in a per-session
  lane, while every host request has a 10-second deadline so a stalled call
  cannot wedge that lane forever and other sessions remain independent. With
  the current confirmation backoff, a fully unresponsive host can hold one
  lane for about 106 seconds on a non-final recurring fire (about 74 seconds
  on a terminal fire). A job never overlaps its own in-flight delivery, and
  shutdown aborts requests, confirmation delays, and idle-recovery checks.
  After a confirmed write, later same-session jobs wait for the turn's idle
  event; if the host stores the prompt but publishes no subsequent status
  transition, a 10-second watchdog verifies live status before releasing them.
- **One-shots auto-delete** after a confirmed delivery. **Recurring jobs
  expire 7 days** after creation — the first fire at or past expiry is the
  final one.
- **A fire is never lost silently or overlapped after an ambiguous send.** Every
  attempt carries a host-format message ID minted at dispatch, and only that
  message appearing in host storage counts as delivered — the host's `204`
  answers before its forked prompt work runs, so the plugin polls briefly after
  every send (and after a transport failure, where the request may have landed
  anyway). Non-final recurring fires get a longer confirmation window because
  one transiently slow write must not unnecessarily stop the whole schedule. A
  terminal fire the host definitively refuses is retried a few times, a minute
  apart, under a fresh ID; a rejected non-final recurring fire recovers on its
  next match. Any fire that cannot be proven is *ambiguous*, so the job is
  parked with its failure details in `cron_list` and a toast identifies the
  stall rather than letting another occurrence overlap a request that may
  still be live.
- **At most 50 jobs per session.** `cron_create` refuses the 51st before it
  even asks for permission. Parked failed jobs count until deleted.
- **Deterministic fire-time jitter.** So that everyone's "9am" jobs don't hit
  the model providers at the same instant, recurring jobs fire up to 30
  minutes after the cron match (at most half the interval, for schedules more
  frequent than hourly), and one-shots pinned to `:00`/`:30` fire up to 90
  seconds early — one-shots on any other minute fire exactly. The offset is
  derived from the job's identity, so a given job always fires at the same
  offset.
- **Plain cron dialect only.** Wildcards, numeric values, ranges, steps, and
  comma lists (`*/15 8-18 1,15 * 1-5`); day-of-week accepts `0` or `7` for
  Sunday. Name aliases (`MON`, `JAN`) and extensions (`L`, `W`, `?`, `#`) are
  rejected with a field-level error even though croner would accept them.
- **Sub-agent jobs bubble up.** A job created by a sub-agent belongs to, and
  fires into, its top-level session (child sessions end with their task, so a
  prompt fired into one would never be seen). The parent walk **fails
  closed**: if any link cannot be confirmed — a host error, a transport
  failure — the tool call aborts with the reason instead of guessing at (and
  caching) the wrong owner.

## Permissions

Scheduling a future autonomous turn is a capability grant, so `cron_create`
asks for permission (key `cron`) before storing the job; the full prompt
being scheduled is the permission pattern, untruncated, so rules match — and
you approve — exactly what will run. Answering "always" stores a
`cron`/`*` allow rule, so
[`persist-permissions`](../persist-permissions) can persist the approval and
[`approve-for-me`](../approve-for-me) can classify it
like any other ask. `cron_list` and `cron_delete` never prompt.

One wrinkle makes this work: OpenCode's built-in ruleset opens with a
`"*": allow` rule, so an ask under a permission key nobody configured is
**silently allowed** — the gate would never prompt. The plugin therefore
injects `permission.cron = "ask"` into the loaded config (via the plugin
`config` hook) when you haven't set it yourself. To skip the prompts
entirely, say so explicitly in `opencode.json`:

```jsonc
{ "permission": { "cron": "allow" } }
```

Your setting — config-level or agent-level — always wins over the injected
default, as do session "always" replies.

The scheduled turn itself has no special powers: when it runs, its tool calls
go through the permission system exactly like a turn you typed.

## How it works

A single re-armed timer matches jobs against wall-clock time, with
[croner](https://github.com/hexagon/croner) doing the cron parsing and
next-occurrence math (local timezone, DST-aware). Whether a session is idle
comes from the tracker this plugin shares with background-tasks
(`createSessionActivityTracker` in `@macarons/permission-rules`):
`session.status` / `session.idle` events, a directory-scoped
`GET /session/status` for a session no event has described yet — re-read each
time, since nothing but another read can notice a turn whose idle event never
arrived — and not-idle whenever the host cannot be reached or understood. The
holding, coalescing and retrying on top of that answer is this plugin's own.
Delivery uses `session.promptAsync` on the injected v1 client — never
`fetch(serverUrl)` — so the standalone TUI's in-process transport works the
same as serve mode. When a job fires, the TUI (if one is attached) shows a
toast naming the job.

Targets OpenCode v1; the verified band rides the repo's pinned OpenCode
release (floor = the pin, ceiling = its next minor).
Outside that band the plugin logs a warning but keeps running. It disables
itself only on OpenCode v2+, whose plugin API differs.

## Install

Server half only — no TUI half, no keybinds. Clone the repository as described
in the [root README](../../README.md), then run from the checkout root:

```sh
bun install && bun setup
```

and tick `cron`, or add the plugin's `src/index.ts` to the `plugin` array of
your `opencode.json` by hand.

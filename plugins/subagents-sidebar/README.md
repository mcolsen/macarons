# @macarons/subagents-sidebar

A quick overview of the viewed session's subagents in the OpenCode TUI
sidebar — who is running, on what, for how long, and whether one is stuck
waiting on you:

```
Subagents
  ▶ explore: find the sync path 1m24s
  ! claude: fix the flaky test waiting on you
  ✓ plan: design the approach done
```

The stock TUI shows a subagent's existence only inline in the parent's
transcript (where it scrolls away) and its detail only once you navigate into
the child session. This section keeps the live picture in view:

- one row per subagent of the session on screen: agent type, the task
  description the parent gave it, and elapsed time while it runs;
- a warning-colored `! … waiting on you` row — and section title — the moment
  a subagent stops on a permission prompt or question, the state a parent
  session most needs to notice;
- `retrying` when the provider is failing under a child;
- background subagents — the experimental `background: true` task mode, and
  every subagent-comms `subagent_spawn` — stay listed while their child
  session is busy, even though their tool call returned at launch; a child
  whose run ended in an error or abort settles as `✗ failed`, not as done;
- a subagent resumed through subagent-comms' `subagent_send` comes back to
  life: a live child always outranks its finished launch call;
- finished subagents linger for a minute with a `✓`/`✗` verdict, then fade —
  counted from when the child actually settled, not from when it started;
- overflow past five rows collapses to `…N more (/subagents)`.

A palette command — **Subagents: list / open** (`/subagents`, alias `/subs`)
— opens the same rows as a dialog and jumps to any subagent's session on
select, including finished ones the sidebar has already faded.

## How it reads the data

TUI-only, no server half. Rows come from the parent session's spawn tool
parts — the stock `task` tool and subagent-comms' `subagent_spawn`, which
writes the same part contract — one per spawned subagent (agent type,
description, child session id, start/end times), refined by the child
session's synced status and pending permission/question queues. Every
`subagent_spawn` is background by design, so those rows always follow the
child session's status rather than the launch call's. The plugin
keeps its own per-session record of every task part it has seen: the host TUI
syncs only a session's newest 100 messages, so a long-running subagent's
spawning part would otherwise age out of the store while the subagent still
works. Two one-time hydration fetches cover what neither the store nor the
event stream can: a session read for the first time pulls its full
server-side message history once (a cold or remote attach must still find
spawns older than the 100-message window), and the pending
permission/question lists are fetched at startup and on every reconnect
(the host's own queues are built from live events only, so they know nothing
asked before the attach). Beyond that, everything read is state the host
already syncs, so the plugin works on local and remote attaches alike.

Sub-agent sessions never render the sidebar section for themselves (suite
convention). Nested spawns still track under their own parent and are
available through `/subagents` while viewing that parent session.

## Install

Clone the repository as described in the [root README](../../README.md), then
run `bun install && bun setup` from the checkout root and select `subagents-sidebar`.
After installing dependencies, you can instead load
`file:///path/to/macarons/plugins/subagents-sidebar/src/tui.tsx` from a `tui.json`
`plugin` array, or run `opencode plugin <path-to-this-package>`.

## Options

Second element of a `["file://…", {…}]` plugin entry. An out-of-range or
wrong-typed value is ignored with one startup warning toast and the
documented default is used — never silently accepted:

- `finishedLingerSeconds`: number > 0 — how long a finished subagent's row
  stays in the sidebar (default 60).
- `sidebar`: boolean — set `false` to skip the sidebar section and keep only
  the palette command (default `true`).
- `keybind`: string — comma-separated keybind alternatives for the list
  dialog (e.g. `"ctrl+g,ctrl+shift+g"`). No default binding ships; `"none"`
  also reads as unbound.

## Version support

Targets OpenCode v1. The verified band is the suite's shared
`SUPPORTED_OPENCODE_RANGE` — currently 1.18.14–1.18.x, riding the repo's
OpenCode pin. Other v1 releases (1.17.14 and up, per `engines.opencode`) are
allowed but unverified: the plugin runs there behind a one-time
unverified-host warning. Only OpenCode v2+ disables it.

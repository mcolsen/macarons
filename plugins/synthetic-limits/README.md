# opencode-synthetic-limits

An [OpenCode](https://opencode.ai) TUI plugin that shows your **Synthetic
five-hour request and weekly credit quotas in the sidebar**.

```text
Synthetic Limits
5h 74% left · regen 5% 09:05
7d 38% left · regen 2% 12:26
```

The times are the next incremental regeneration ticks, not full reset times.
Synthetic currently regenerates part of the five-hour quota every 15 minutes
and part of the weekly quota about every 3.4 hours. The plugin reads Synthetic's
quota endpoint, which does not consume quota. It appears while the viewed
session uses the `synthetic` provider, or with a `· classifier` tag when
approve-for-me uses a pinned Synthetic model in the background.

Current responses expose separate `rollingFiveHourLimit` and
`weeklyTokenLimit` fields. The older documented `subscription` response remains
supported as a five-hour fallback.

The plugin consumes the effective Synthetic credential from OpenCode's provider
state after OpenCode has resolved configuration, `/connect` credentials,
provider environment variables, and loaders. This keeps attached TUIs on the
same account as the server.

A missing key leaves the section hidden. Changing keys immediately drops the
old account's snapshot. A 401 hides and latches the section until credentials
change; transient failures retain the last snapshot briefly, then hide it with
backoff.

## Install

Clone the repository as described in the [root README](../../README.md), then
run `bun install && bun setup` from the checkout root and select `synthetic-limits`.
Alternatively, after installing dependencies:

```sh
opencode plugin /path/to/macarons/plugins/synthetic-limits
```

Or load the TUI entry manually in `tui.json`:

```json
{
  "plugin": ["file:///path/to/macarons/plugins/synthetic-limits/src/tui.tsx"]
}
```

TUI configuration is loaded at startup; restart OpenCode after changing it.

## Options

```json
{
  "plugin": [
    ["file:///path/to/macarons/plugins/synthetic-limits/src/tui.tsx", {
      "interval": 120,
      "providers": {
        "synthetic": { "endpoint": "https://gateway.example/v2/quotas" }
      }
    }]
  ]
}
```

- `interval`: poll interval in seconds, default `60`, minimum `15`.
- `providers.synthetic.endpoint`: optional quota endpoint override for tests or
  an enterprise proxy. The default is `https://api.synthetic.new/v2/quotas`.

The plugin is read-only. Remote attaches are disabled; local and loopback
OpenCode instances are supported.

## Development

```sh
cd plugins/synthetic-limits
bun run lint
bun test
bun run typecheck
```

`src/synthetic.ts` owns credential precedence and Synthetic API semantics. The
provider-neutral engine lives in
[`libraries/usage-limits`](../../libraries/usage-limits); JSX remains in the
entry module so OpenCode supplies the correct Solid runtime.

# opencode-cache-ratio

An [OpenCode](https://opencode.ai) TUI plugin that shows **the viewed session's prompt-cache hit ratio in the sidebar**, live per request, and **alerts when a request appears to have broken the prompt-cache prefix** — the section turns red and a toast fires.

```text
Cache
hit 92% · last 96%
1.2M cached · 210k written · 88k fresh
```

and on a suspected prefix break:

```text
Cache                                    ← red
hit 78% · last 2%
1.2M cached · 340k written · 96k fresh
prefix broke: lost 126k cached           ← red
```

The section renders below the [Codex](../codex-limits) and [Synthetic](../synthetic-limits) limits widgets (when installed), between the sidebar's Context and MCP sections.

## What it shows

- **`hit`** — cached ÷ total prompt tokens across every API request of the session so far. **`last`** — the same for the newest request.
- **`cached / written / fresh`** — the session-wide sums the ratio derives from: prompt tokens read from cache, written to cache, and sent uncached.

OpenCode records one `step-finish` part per API request on each assistant message, and normalizes every provider's usage to the same accounting before plugins see it: `tokens.input` is the *non-cached* remainder, so `full prompt = input + cache.read + cache.write` regardless of provider (Anthropic reports reads and writes; OpenAI-style providers report only reads and the host subtracts them from input). That makes the math provider-independent. Sessions with no recorded requests contribute nothing; sub-agent sessions never render a section of their own.

The sums really are session-wide: the host TUI only syncs a session's newest 100 messages and evicts older ones as new messages arrive, so the plugin keeps its own per-session record of every request — seeded once from the server's full message history when the session is first viewed, then kept current from live events even while the session is unviewed, and refreshed from the synced store. The history read has a 30-second deadline, including response-body consumption. If it fails or times out, the section still renders and covers synced and live requests observed during this attach, without retrying while that session remains tracked. Deactivating the plugin, deleting the session, or evicting its tracking cancels the read; late results are ignored.

## Break detection

Prompt caching works by prefix: whatever a request read from cache stays readable for the next request — conversation prompts only grow — as long as the prefix is byte-stable and the cache TTL hasn't lapsed. So the detector uses the **last healthy request's cache read as a floor**: when a request reads less than half of that floor (configurable), something upstream of the cached span changed — a mutated system prompt, reordered tools, an injected message — and every request after it re-pays the whole context. The floor is sticky across consecutive misses: a sustained failure stays red on every request until one genuinely reuses the cache again, rather than the first miss becoming the next comparison's (tiny) floor and silently clearing the alert.

Expected cache losses are recognized and never alerted:

- **First request** of a session — nothing cached yet.
- **Model or provider switch** — caches are per-model.
- **Compaction** — a summary turn legitimately rebuilds the prompt.
- **Reverts/undo** — a prompt *smaller* than the previous read means messages were removed.
- **TTL expiry** — a full re-pay whose age exceeds the TTL (default 5 minutes, Anthropic's default) is classified as expiry: a cost event, not broken prefixing. Instead of the red alert, a muted `cache expired: re-paid 126k cached` line appears in the sidebar and fades after a few seconds (the same linger approve-for-me gives settled prompts).
- **Tiny caches** — a previous read under `minPreviousRead` (default 5000 tokens) is not worth an alert.

The expiry age is measured **request-start to request-start**, not between step-finish times: a cache entry is written while a request's prompt is ingested and read when the *next* request goes out, whereas OpenCode records a step-finish part only after the step's tool calls settle — including however long a permission prompt sat waiting (a classifier or a human). Those in-step waits age the cache invisibly to finish-time gaps, in both directions: a long wait made real expiries look like breaks (the false toast), and a slow response could make a real break look like expiry (a silent miss). Live requests are timed by their step-start part events; pairs without start times (history, lost events) fall back to the finish-time gap.

On Anthropic-family providers the TTL is a guaranteed *minimum* lifetime, refreshed on each read — so an in-window miss there really does mean the prefix changed, which is what makes the red alert trustworthy. On a suspected break the section title and a detail row turn red in the sidebar, and a toast fires when the session in view *enters* the broken state live (a persisting break stays a sidebar-only signal instead of re-toasting every request). The red state clears when a request reuses the cache normally again, or when one of the expected-loss causes above resets detection. On providers whose caching is best-effort (OpenAI evicts under load), an occasional provider-side miss can trip the detector too — the red row is still telling you truthfully that the context was re-paid.

## Install

Clone the repository as described in the [root README](../../README.md), then
run `bun install && bun setup` from the checkout root and select `cache-ratio`.
The local alternatives below also require those checkout dependencies.

TUI plugins load from `tui.json` (project-local `.opencode/tui.json` or the global OpenCode config directory). Either run the installer from your project directory:

```sh
opencode plugin /path/to/macarons/plugins/cache-ratio
```

(this package advertises only a TUI target, so only `tui.json` is patched; `-g` installs globally), or reference the entry file manually:

```json
{
  "plugin": ["file:///path/to/macarons/plugins/cache-ratio/src/tui.tsx"]
}
```

Do **not** copy `src/tui.tsx` into `.opencode/plugin/` — that directory is scanned for *server* plugins and this module is TUI-only.

## Options

Options go in a `[spec, options]` tuple:

```json
{
  "plugin": [
    ["file:///path/to/macarons/plugins/cache-ratio/src/tui.tsx", {
      "minPreviousRead": 10000,
      "floorFraction": 0.5,
      "ttlSeconds": 3600,
      "toasts": true
    }]
  ]
}
```

- `minPreviousRead` — only alert when the previous request read at least this many cached tokens (default `5000`; must be at least `0`, where `0` means "no size gate — judge every pair").
- `floorFraction` — alert when the current read falls below this fraction of the previous read (default `0.5`; must be greater than `0` and at most `1`). `1` is the sharpest useful setting: any drop at all alerts.
- `ttlSeconds` — the provider cache TTL: re-pays older than this (request-start to request-start) classify as expiry instead of a break (default `300`, Anthropic's 5-minute ephemeral cache; raise to `3600` if your provider uses a 1-hour TTL; must be greater than `0`).
- `toasts` — set `false` to keep the sidebar alert but silence the toast (default `true`).
- `expiryLingerSeconds` — how long the transient `cache expired` line stays in the sidebar before fading (default `5`, the same linger approve-for-me gives settled prompts; must be greater than `0`, and may be fractional).

An out-of-range or wrong-typed option is **ignored with one warning toast at startup**, and the documented default is used in its place — a value nobody chose never silently takes effect. `floorFraction: 0` is refused specifically: it reads as "most sensitive" but is the opposite, since a floor of zero makes every read pass the floor test, switching break *and* expiry detection off entirely. Sensitivity rises with the fraction, so use `floorFraction: 1` — alert on any drop at all — for maximum sensitivity; to keep detection while silencing the alert, use `toasts: false`.

## Scope and caveats

- **Read-only.** The plugin reads session state the host syncs to the TUI, plus one message-history fetch per viewed session through the host's own server API (the TUI syncs only the newest 100 messages; the fetch is what keeps the totals session-wide). It works on local and remote attaches alike.
- **Notifications are viewed-session only.** The ratio and red state describe the session in view; live toasts and transient expiry notices fire only for that session. Background root-session requests are still retained for the totals and break state when you return, without another history fetch while the session remains tracked. Sub-agent sessions are not tracked or reported.
- **At most 64 sessions are tracked at once.** The plugin records requests for every root session the server reports, not just the ones you open, so a long-lived attach to a busy server is capped: the least recently active session is dropped once the cap is passed, and the session in view is never dropped. Re-visiting a dropped session costs one extra history fetch and loses its recorded request *start* times, so pairs from before the drop fall back to the finish-time gap described in the bullet below — the same degradation history already has. Within a single session the record is not capped; a very long session's request list still grows.
- **Request times are partly reconstructed.** Live requests are timed by their bus events — step-start arrivals for the expiry age, step-finish arrivals otherwise. For history — including fork-cloned history, which the host re-announces at fork time — start times are not recoverable, each message's final request is timed by the message's completion, and earlier steps of multi-step messages have no recorded time; such pairs fall back to the finish-time gap, or skip the TTL gate entirely when no times are known. Reopening a stale session can therefore show a red row for its last recorded request — accurate, if old, news.
- **Version target: OpenCode v1.** The verified band rides the repo's pinned OpenCode release (floor = the pin, ceiling = its next minor); `engines` declares only the static v1 install gate. On a v1 host outside that band a runtime guard warns (with a toast) but keeps running; it disables the plugin only on OpenCode v2+, whose plugin API differs. The runtime guard matters because path and `file://` installs bypass package-engine checks. The band also pins the usage-normalization semantics the math relies on (re-verified as the pin advances).

## Development

Install dependencies from the monorepo root, then:

```sh
cd plugins/cache-ratio
bun run lint
bun test          # ratio math, break/expiry detection, engine + toast behavior, rendered sidebar, packaging contracts
bun run typecheck
```

`src/core.ts` holds everything pure (sample shape, prompt-token normalization, ratio aggregation, break/expiry detection, formatting); `src/tui.tsx` keeps the per-session request record (history seed + synced store + live `message.part.updated` events — step-start and step-finish alike — dropped on `session.deleted` or by the recency cap), renders one `sidebar_content` slot, and owns the toast and the fading expiry notice. `test/tui.test.ts` drives the engine against a mock TUI API (`test/harness.ts`); `test/view.test.tsx` mounts the registered sidebar slot under `@opentui/solid`'s headless `testRender` and asserts on captured char frames — the package `bunfig.toml` preloads `@opentui/solid/preload` so `bun test` compiles the JSX with the real solid transform (and the client solid-js build), the same pipeline the host uses; `test/packaging.test.ts` guards the TUI-only install contract.

`test/history.test.tsx` uses the actual host SDK with controlled transports and mounted sidebar views. It covers stalled requests and bodies, deadlines, repeated deactivation/reactivation, deletion/eviction, and late results from transports that ignore cancellation.

# @macarons/cache-ratio

Live cache health for OpenCode **2.0.29+**. The native `opencode stats` command
already reports aggregate cache usage; this plugin adds current-session and
last-request ratios, alerts when cache reuse unexpectedly collapses, and a brief
expiry notice. It uses native request timestamps and normalized token counts.

Install with `bun setup`, or add the package directory to global `cli.json`:

```jsonc
{
  "plugins": [{
    "package": "file:///path/to/macarons/plugins/cache-ratio",
    "options": { "minPreviousRead": 5000, "floorFraction": 0.5,
      "ttlSeconds": 300, "toasts": true, "expiryLingerSeconds": 5 }
  }]
}
```

Only root sessions display the widget. It reads native client data and paginated
server history, so local and remote connections work alike. Historical misses do
not toast. Duplicate events do not double-count; expected loss after a model
switch, compaction, revert, or cache expiry is excluded from prefix alerts.
If history cannot be loaded, a warning explains that only observed requests are
shown. Up to 64 sessions are retained per TUI instance.

`minPreviousRead` accepts zero; `floorFraction` must be greater than zero and at
most one. Timeout/linger values must be positive. Invalid settings warn and use
the defaults above. Cache loss is a heuristic: provider eviction can look like a
changed prompt prefix. Tune the TTL to your provider's cache policy.

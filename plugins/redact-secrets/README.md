# @macarons/redact-secrets

Detects credentials in OpenCode v2 session requests and replaces them with
stable, keyed placeholders before they reach a model. Real values are restored
only in the owned input passed to a local tool. This plugin remains necessary:
OpenCode v2 does not include outbound secret detection and restoration.

Run `bun install && bun setup` from the Macarons checkout, or configure the local
package directory in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/macarons/plugins/redact-secrets",
      "options": { "systemNote": true, "disabledRules": [] }
    }
  ]
}
```

The supported host is OpenCode 2.0.29 or later in the v2 series. The package uses
native `@opencode/plugin` APIs and needs no TUI companion.

The retained betterleaks detector includes 307 rules, context and entropy
checks, exact matching of known secrets, bounded scanning, and attachment
inspection. Request hooks cover ordinary chat, compaction, title generation,
and transient session generation, including system instructions, messages,
tool definitions, and request options. HTTP and experimental WebSocket hooks
scan the final provider body, including later body overlays. They preserve
host authentication and known opaque provider continuation state. Uninspectable
encodings, malformed WebSocket frames, exhausted vault capacity, and traversal
failures stop the request. Candidate-heavy fingerprint recovery replaces the
affected content with a safe omission marker.

V2 changes the following behavior:

- Assistant prose and compaction summaries keep placeholders. V2 has no
  completed-text mutation hook, so `restoreText` is retired. Local tool input
  restoration remains available, with a detached input copy so history stays
  masked.
- Native HTTP and WebSocket hooks replace provider-fetch monkey patches.
  `wireBackstop` and `wireSkipProviders` are retired; interception is always
  enabled and OAuth providers need no exclusion.
- Every request is rescanned. `stableHistory` is retired; a newly recognized
  secret may change an earlier request prefix. Keyed placeholders remain
  stable across requests and restarts while the local key/catalog are retained.
- Diagnostics use secret-safe server logs. There is no server-to-TUI toast
  endpoint in V2.

Secret-bearing tool names use stable provider-safe aliases. Native executor
identity and matching historical tool calls/results are preserved. Failed
setup releases its source-redaction registration, and unloading drains active
scans before flushing the fingerprint catalog.

`systemNote` controls the placeholder explanation (default `true`).
`disabledRules` lists detector rule IDs to skip. Existing
`~/.config/opencode/redact-secrets.json` options are read for migration;
explicit plugin options take precedence.

The existing `redact-secrets.key` and `redact-secrets.fingerprints.json` files
remain in OpenCode's data directory, honoring `XDG_DATA_HOME`. Both use `0600`
permissions. The catalog holds at most 2,048 keyed hashes, rule IDs, and lengths;
plaintext secrets remain in memory. A restart can relearn secrets from outbound
history, the environment, and bounded project environment files. After
compaction removes raw history, a secret absent from those local sources cannot
be restored after a restart; its placeholder passes to the tool unchanged.
Failed key/catalog persistence limits restart recovery and is logged.

The guarantee covers session model requests. Independent third-party network
calls and sessionless `ctx.generate.text` bypass session hooks; Macarons'
classifier uses the shared source-redaction boundary and isolated session
generation. Images are not OCR-scanned, encrypted provider state is opaque,
and intentionally encoded secrets or secrets not recognized by a detection
rule can escape. Another plugin running after redaction can change a request;
keep redaction last when order matters. Existing transcripts are not scrubbed
on disk. Concurrent catalog writers can temporarily lose a fingerprint batch
until a later flush.

Run `bun test`, `bun run typecheck`, and `bun run build` inside this package.
The vendored detector retains its MIT license and provenance under
`vendor/betterleaks/`.

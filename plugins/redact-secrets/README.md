# @macarons/redact-secrets

An OpenCode plugin that detects secrets in everything sent to a model
provider and replaces them, in flight, with opaque placeholders — then puts
the real values back exactly where they are needed locally. It is a last line
of defense for the day an errant API key sits in a `.env` the agent reads, a
shell environment it prints, or a config file it greps.

```
outbound   .env contents ──▶ scan (betterleaks rules) ──▶ [REDACTED-SECRET:aws-access-token:3f9a2c1e88d04b7a]
inbound    model says "run: deploy --key [REDACTED-SECRET:…]" ──▶ tool executes with the real key
```

This does not solve secret management. It narrows one specific, common leak:
plaintext credentials inside model requests.

## How it works

**Detection** is a TypeScript port of [betterleaks](https://github.com/betterleaks/betterleaks)
(the Gitleaks successor; MIT licensed, vendored with attribution under
`vendor/betterleaks/`): 307 rules with keyword prefilters, capture-group
extraction, Shannon-entropy floors, stopword and context allowlists, and
specificity-based overlap suppression. (The lazy "reporting prefix" the
upstream semi-generic rules open with is stripped at vendor time — under a
backtracking JS RegExp it made scan cost quadratic-per-rule on keyword-dense
content without ever gating a match; the one filter that inspected the text
it covered gets that span reconstructed at scan time.) On top of rule
detection, every secret already in the vault is redacted by **exact match**
wherever its bytes reappear — context-free, because restored model prose
("here's your key: …") strips the field context rules key on.

Placeholders are derived from the
secret under a random, per-installation key (`HMAC-SHA256(key, secret)`
prefix), so the same secret maps to the same hash across requests, sessions,
and restarts while that key is retained. This keeps prompt prefixes
cache-stable and lets a restarted process re-learn mappings its outbound scans
can detect. The rule-id label inside the placeholder is pinned per secret while
its catalog entry is retained, so the full placeholder *string* stays stable
under the same condition. Keying (rather than a bare hash) stops a
placeholder from being an
offline oracle for a guessable credential and prevents correlation across
installations. The plugin attempts to persist two local `0600` files in the
OpenCode data dir, neither containing plaintext or reversible secret material:
the key, plus a bounded fingerprint catalog for up to 2,048 recently vaulted
secrets — each entry holds its keyed 16-hex hash (the same value already inside
every placeholder your provider sees), rule id, and length. A retained entry
lets a **restarted** process re-identify a secret that now only exists as
contextless restored prose in the stored transcript.
Recovery includes unquoted Basic Auth `user:pass` arguments, without needing
the original `curl -u` syntax. Before restoring completed prose, the plugin
flushes or awaits pending catalog writes, then checks that a cold redactor with
the last successfully read or written disk snapshot can reproduce the exact
masked text. If persistence fails or the check does not reproduce it, the
entire text part keeps its placeholders; a later completion retries a failed
write even if no new secret was registered.

**Outbound**, three layers redact:

1. `experimental.chat.messages.transform` + `experimental.chat.system.transform`
   — the primary layer, covering chat and compaction traffic for **every**
   provider and transport (the message objects are per-request copies, so
   stored transcripts are untouched). Attachment payloads and mediatypes are
   covered too: a remote `http(s)` url (each component — query parameter names
   and values, path, userinfo, fragment — percent-decoded before scanning, so a
   `?token=%67%68%70…` credential can't hide inside the encoding), plaintext `data:` urls, base64
   `data:` urls, and the attachment `mime`/`mediaType` string itself are all
   scanned — the plaintext ones percent-decoded first (tolerantly, run by run:
   a malformed escape like a stray `%FF` passes through literally instead of
   aborting the decode and shielding the valid escapes around it), the base64
   ones decoded (as UTF-8 when the bytes are well-formed UTF-8, so
   proximity-bounded rules count the characters the provider will read; as
   latin1, byte-for-byte, otherwise) and re-encoded — because the provider reads every one of
   them (OpenCode base64-encodes any non-`text/plain` attachment, so a JSON file,
   a PDF, or even a non-UTF-8 SQL/CSV dump arrives as base64). Only payloads a
   scan genuinely cannot read as text are left alone: local `file:` paths
   (resolved before the request leaves the machine) and base64 payloads whose
   declared binary mediatype is **confirmed by the payload's own magic bytes**
   (a real PNG, MP4, zip, …). The declared type alone is never trusted — MIME
   is an unrestricted string an MCP resource can set to anything, so textual
   bytes labeled `image/png` (or the magic-less `application/octet-stream`)
   are decoded and scanned like any other text. A **PDF is scanned** too,
   because providers extract its text (see the
   binary-document limitation below). A short note
   is appended to the system prompt teaching the model to treat placeholders as
   opaque and copy them verbatim into tool calls.
2. `tool.definition` — the descriptions and JSON schemas of built-in and
   plugin-registered tools, which ride every model request. This is the only
   tool-definition surface OpenCode exposes to plugins; see the known gaps
   below for what it cannot reach. One piece of the Task tool's description is
   assembled *after* this hook fires — the list of subagent names and
   descriptions — so that one is covered at its source instead: the `config`
   hook redacts every agent's `description` in the loaded config before the
   agent registry is built, which reaches config- and markdown-defined agents
   on every provider and transport (native runtime included). Agent *names*
   are deliberately left alone — they are invocation identifiers, and renaming
   one to a placeholder would break `task` calls — so don't put credentials in
   an agent's name. Like every other layer, this one fails **closed**: a
   schema that cannot be safely cloned and scanned (one that JSON itself
   cannot serialize, or a cyclic/pathologically deep structure that trips the
   walker bounds) aborts the request rather than letting the definition
   through unscanned. A schema `structuredClone` rejects but JSON accepts —
   a function-valued extension next to ordinary properties — is scanned via
   its JSON round-trip, exactly the form the wire would carry.
3. A wire backstop — a provider `options.fetch` wrapper that re-scans the
   fully serialized request body (catches side channels like title
   generation). Every body shape a fetch can carry is inspected, not just
   strings: byte buffers and views, `Blob`s, streams (web, Node, or
   async-iterable, buffered under a 64 MB inspection budget), and a body held
   by a prebuilt `Request` are decoded — UTF-8 or UTF-16, BOMs preserved —
   and, when they parse as JSON, redacted and re-encoded in the same
   encoding. Byte bodies are classified against the request's declared
   `Content-Type`, never their bytes alone: a body the sender labels JSON or
   text is inspected as such whatever its bytes look like. Clean bodies pass
   through byte-identical, and clearly opaque non-JSON payloads (binary
   uploads, form data) pass untouched. A body that may be JSON but cannot be
   inspected aborts the request rather than passing unscanned — an encoding
   the runtime lacks (UTF-32, an unknown charset), a declared-text body that
   will not decode, a `Content-Encoding` other than `identity` (the plaintext
   the provider decompresses is unreadable here), or a rewrite that would
   have to be re-encoded in a charset this runtime cannot emit. A streaming
   body past the budget aborts too, rather than being buffered without bound. It is installed only where provably safe: providers you
   configured in `opencode.json`, plus providers OpenCode provably activates
   without a config entry — a models.dev catalog provider whose API-key
   environment variable is set, or one connected with an API key
   (`/connect`, `opencode auth`), read from the same catalog snapshot and
   auth store the host reads. Excluded is any provider whose setup installs
   its own fetch (OAuth loaders such as Codex, `github-copilot`,
   `google-vertex`, `snowflake-cortex`, or any OpenAI auth entry while
   OpenCode's websocket rollout is enabled) — config options are re-applied
   last during provider setup and would silently clobber those, breaking
   authentication. Auth state is read exactly the way the host reads it: inline
   `OPENCODE_AUTH_CONTENT` first (raw, as the host takes it), then `auth.json`
   with each entry schema-validated and the malformed ones dropped — so a stale
   `{"type":"oauth"}` with no tokens is not mistaken for an active OAuth provider
   and does not wrongly exclude an api-key-served one. An unreadable or
   unparseable `auth.json` falls back to an empty store (the host does the same),
   so wrapping still proceeds rather than standing down globally.

   **Known gaps — excluded providers.** Three request ingredients bypass every
   hook OpenCode offers, so the wire backstop is the only layer that covers
   them. Where the backstop must stand down (the excluded providers above),
   and on a first-ever run where no models.dev snapshot exists yet, they
   reach the provider unredacted:

   - **Session titles.** Titles are generated from the text of your *first*
     user message through a request that bypasses the chat transforms, so a
     secret pasted directly into a session's first message can leak inside
     the title request. Secrets the agent *reads* (files, env, tool output)
     are unaffected — they only ever travel through the covered chat
     pipeline.
   - **Agent-generation descriptions.** Generating an agent from a natural-
     language description embeds that description directly into a one-shot
     structured-generation request that fires the *system* transform but not
     the chat *messages* transform (`agent/agent.ts`), so a secret pasted into
     the description can leak. Like titles, this covers only text you type into
     the request itself, never secrets the agent reads.
   - **MCP tool definitions and structured-output schemas.** OpenCode
     serializes MCP servers' tool descriptions and input schemas, and any
     caller-supplied structured-output schema, into each request without
     firing the `tool.definition` hook (verified at 1.17.18:
     `session/tools.ts` adds MCP tools directly; `StructuredOutput` is built
     inline in `prompt.ts`). A credential embedded in an MCP server's tool
     description, schema default, or enum therefore reaches an excluded
     provider as-is. Built-in and plugin-registered tool definitions *are*
     covered on every provider (layer 2).

   **Known gap — the experimental native LLM runtime.** The wire backstop is a
   provider `options.fetch` wrapper. With `OPENCODE_EXPERIMENTAL_NATIVE_LLM`
   set, OpenCode routes supported OpenAI, Anthropic, and `opencode/…` requests
   through its own `@opencode-ai/llm` transport, which ignores that fetch
   wrapper for everything but an OpenAI OAuth override
   (`session/llm/native-runtime.ts`). The chat, system, and tool-definition
   transforms still cover ordinary chat and compaction turns for **every**
   provider, but the backstop-only side channels above (session titles, MCP
   tool definitions, structured-output schemas) become uncovered for those
   native-eligible providers too — the same gap the excluded providers have,
   now widened to OpenAI/Anthropic/`opencode`. Agent-generation is unaffected
   (it uses the AI SDK directly, which still honors the fetch wrapper). No
   plugin can intercept the native transport, so the plugin logs a loud
   warning at startup whenever the flag is set. If you enable it, treat those
   three side channels as unprotected for OpenAI/Anthropic/`opencode` models.

**Inbound**, two hooks restore:

1. `experimental.text.complete` — placeholders the model echoes in prose
   (chat turns and compaction summaries alike) are replaced with the real
   values only when the result passes the cold re-redaction check. The host
   writes that text into the stored part. A shape or surrounding context the
   bounded scan cannot safely recover keeps the entire part's placeholders;
   quoted Basic Auth arguments containing spaces are one example.
2. `tool.execute.before` — placeholders inside tool arguments are restored on
   the exact object the tool executes with, so commands and file writes use
   the real secret. The transcript's recorded tool call keeps the
   placeholder: what the model said stays what the model said.

## Install

Clone the repository as described in the [root README](../../README.md), then
run from the checkout root. The wizard enables it in your user-level config:

```sh
bun install && bun setup
```

Or, after installing dependencies, add
`file:///path/to/macarons/plugins/redact-secrets/src/index.ts` to the `plugin`
list in `opencode.json`. Server-only — there is no TUI half.

## Options

Optional file at `<opencode config dir>/redact-secrets.json`:

```jsonc
{
  "disabledRules": ["generic-api-key"], // rule ids to skip
  "systemNote": true,                   // append the placeholder explanation to the system prompt
  "restoreText": true,                  // restore placeholders when cold re-redaction is safe
  "stableHistory": true,                // never re-redact a surface this session already sent
  "wireBackstop": true,                 // wrap safely wrappable providers' fetch as a second layer
  "wireSkipProviders": []               // providers the backstop must leave alone
}
```

`stableHistory` keeps redaction from being retroactive. Detection is a moving
target — the keyword gate grows as content arrives, and every newly vaulted
secret is swept for by exact match across the whole transcript — so without it
a secret first recognized at turn N is rewritten into the replayed turns
1..N-1, which the host sends verbatim on every later request. To a provider's
prompt cache that is a changed prefix, and the miss costs the full replayed
history at uncached input rates. With it on (the default), a surface is
redacted under the full current rule set the **first** time it is seen — new
turns, edited parts, and compaction-replaced history all miss the pin — while a
byte-identical replay of something already sent returns the same decision. That
cannot expose anything the pin prevented: the pinned bytes are exactly what
already went to that destination. What it gives up is the late catch-up: turn
it off if you would rather mask a late-recognized secret throughout the
replayed history than keep the prefix stable.

A pin is only reused where its justification actually holds:

- **Per session *and* per destination.** A session that switches model
  mid-conversation, or whose history compaction routes to a separately
  configured model, gets the current rule set rather than a decision made for
  somewhere else. Compaction is never served from a pin at all.
- **Only after the request landed.** Both transforms run before the request is
  built and sent, so a decision made there describes an attempt, not a
  delivery. A pin stays invisible until the provider answers — an attempt that
  fails or is cancelled leaves nothing behind, and its retry is redacted under
  whatever the rule set knows by then.
- **For one process.** Pins are never written to disk: a pin's value is a
  snapshot of exactly the bytes a provider was sent, secrets included. The
  bounded fingerprint catalog *can* persist the entries needed to re-identify
  and re-redact history the previous process pinned raw after an OpenCode
  restart. That recovery depends on retaining both the installation key and
  the relevant catalog entry; see Limits worth knowing. If the provider's
  cache is still warm, a successful recovery costs one prefix miss.
- **Within a bounded budget.** Pins hold digest keys and a capped total of
  retained snapshot bytes, evicting least-recently-used first, and release a
  session outright when it is deleted. An evicted surface loses its stability,
  never its coverage.

**`stableHistory` does not cover the wire backstop**, and with `wireBackstop`
on (also the default) that is the limit worth knowing. The backstop inspects
the fully serialized request against the current vault, and the vault sweep is
exact-match and context-free — so on a wrapped provider a value the pin
replayed raw is redacted there anyway, and the prefix still moves once on the
request that learns the secret. The fetch wrapper sees a provider-shaped body
with no session identity in it, so it cannot tell replayed history from new
content; the only exemption it could apply would be per-provider, which would
also release the value in unrelated sessions. Pinning therefore buys full
prefix stability only where the backstop does not run — providers it excludes,
`wireSkipProviders` entries, or `wireBackstop: false` — and elsewhere buys the
transform layer's share of it.

Disabling `restoreText` keeps placeholders in **all** stored assistant text —
compaction summaries included, since they stream through the same hook. That
is the option's point (no raw value is ever written back into the stored
transcript), but it narrows restart recovery: recovery layer 2 below depends
on the summary holding raw values, so with `restoreText` off, a placeholder
whose raw copies were compacted away survives a restart only if fingerprint
recovery (layer 3) can find the secret in the environment or an env file. The
plugin logs a warning at startup when this option is off.
Even when it is on, a completed part that fails the cold re-redaction check
keeps its placeholders and has the same env-recovery requirement after
compaction and restart. Tool-argument restoration remains unrestricted: every
known placeholder still resolves to its exact original value at execution.

## Differences from betterleaks

Most deviations bias toward *more* redaction. Three do not, and each is called
out as such below: the cross-string **admission** rule, the
**`sourcegraph-access-token`** narrowing, and the unhonored **inline allow
signatures**. The first two exist because a false positive is not free in this
setting the way it is in a repo scan — a placeholder rewrites every earlier
occurrence in the replayed history, which costs the session its prompt cache —
so a rule that collides with values transcripts are full of is worth narrowing.
Both were written against a specific observed failure, both keep the shapes
that actually identify a credential, and both are pinned by tests.

- No encoded-segment passes: secrets hidden inside base64/hex/percent
  encodings in file *content* are not decoded and can be missed. (Three
  targeted exceptions, for attachment payloads the provider itself decodes: a
  remote `http(s)` url's components are each percent-decoded, a plaintext
  `data:` url is percent-decoded, and a base64 `data:` url is base64-decoded
  before scanning — unless its declared binary mediatype is confirmed by the
  payload's magic bytes, the one case that is skipped as opaque.)
- Path-scoped rules (5) are dropped — in-memory strings have no file path.
- Structured objects are scanned with **field-name context**: a request carries
  parsed JSON (tool-call arguments, wire bodies), where `{"api_key":"x7k2…"}`
  splits the keyword a rule needs from the value. Each value is scanned both on
  its own and as a reconstructed `key=value` line — under its own key **and its
  nearest ancestor key**, so `{"credentials":{"production":"x7k2…"}}` and a
  JSON Schema's `{"properties":{"api_key":{"default":"x7k2…"}}}` fire
  keyword-gated rules exactly like the flat config line would. The inheritance
  deliberately stops at one level: a keyword two or more levels up is a
  container, not an assignment, and treating it as one mass-redacts the clean
  trace/session/etag identifiers that fill ordinary tool output. Property
  names are scanned too, under their enclosing field name (an api-key-indexed
  map inside `api_keys` redacts like the equivalent list).
  A `[key, value]` pair array — the tuple shape HTTP headers and URL parameters
  take, `{"headers":[["api_key","x7k2…"]]}` — is handled the same way: the value
  element inherits the key element as context. Upstream, working on flat file
  text, never needs this.
- **Keyword prefilters gate across the whole outbound request, not per
  string.** Upstream scans one file at a time; here the provider reads every
  message part, system-prompt entry, and tool definition as one document, so
  a rule keyword found in any of them ("facebook token follows" in one part)
  gates that rule in every other string of the request (the sibling part
  holding only the bare token) — parts of the message set cover each other in
  either order. Tool IDs and agent names count too: they are serialized
  beside their descriptions (`{"name":"facebook","description":…}`, the Task
  tool's `- name: description` lines), so a vendor-named tool or agent gates
  that vendor's rules and doubles as field context over its own description
  and schema — while the name itself, an invocation identifier, is never
  rewritten. The wire backstop seeds the same gate from each serialized body
  it rewrites, which is what extends the cross-string cover to the surfaces
  only it sees (MCP definitions, structured-output schemas). Context keywords
  stick for the session — history carries them forward anyway — which is also
  what carries them *across* surfaces: a keyword living only in system text
  or a tool definition covers message parts (and earlier-registered tools'
  definitions) from the next request of the process on (hook ordering;
  message-part keywords cover those surfaces within the same request). They
  only widen candidate *selection*: a rule's regex still has to match the
  individual string, so a keyword-free string gains no findings its own text
  cannot produce.
- **Admission into that cross-string set requires the keyword to start a
  token** — nothing alphanumeric immediately before it, or a camelCase word
  start (`myFacebookIntegration` admits `facebook`) — while matching a rule
  against the string holding its own keyword keeps upstream's plain substring
  test. The asymmetry pays for itself: a per-string gate is self-limiting, but
  the cross-string set is sticky and process-wide, so one bad admission
  re-gates every string of every session. Transcripts, unlike source files,
  carry provider-issued ciphertext — encrypted reasoning payloads, item ids,
  signatures — which is base64 over a ~64-character alphabet and therefore
  contains short gate keywords by coincidence. The camelCase half is
  length-gated (five characters and up) because a case boundary is roughly 5x
  weaker evidence than a real delimiter over that alphabet: long vendor names
  admit on case, short prefix gates like `aws`, `api` and `sgp_` still need a
  delimiter. Provider metadata payloads are also dropped from the sweep
  outright (they still get scanned for secrets; they just cannot turn a rule
  *on*), since ciphertext cannot hold the plaintext credential its keyword
  would gate — but only at the real `parts[].metadata.<provider>` path, so a
  tool input's own `signature` field still contributes its keywords.
- **`sourcegraph-access-token` does not fire on a bare 40-hex value unless its
  own line carries a credential signal.** Its third upstream alternative is a
  bare `[a-fA-F0-9]{40}`, which is exactly a git commit SHA — a value agent
  transcripts are full of, and one that costs a false positive far more here
  than in a repo scan: the placeholder rewrites every earlier occurrence in the
  replayed history. The line has to name the vendor
  (`SOURCEGRAPH_TOKEN=<40 hex>`) or use an access-token authentication form —
  `Authorization: token <40 hex>`, `SRC_ACCESS_TOKEN=…`, `src auth …` — which
  covers the layout Sourcegraph's own [API
  documentation](https://sourcegraph.com/docs/api/mcp/authentication) uses,
  where the vendor is named on the line *above* the credential. Both
  `sgp_`-prefixed alternatives are untouched. Line-scoped rather than
  window-scoped on purpose: the gate keyword is sticky and process-wide, so
  "sourcegraph appears somewhere in the session" is true of every string once
  it is true of one. See `EXTRA_DISCARD_FILTERS` in `scripts/vendor-rules.ts`;
  an override whose rule id upstream renames is a vendor-time error, not a
  silent no-op.
- **Inline allow signatures (`gitleaks:allow` / `betterleaks:allow`) are not
  honored.** Upstream scans a repo, where the marker is an author annotating
  their own code; at runtime it would let the *content* of a request disable
  its own redaction — any file or tool output could walk a live credential
  past the scan by carrying the marker on the same line, and a serialized
  JSON body is one line, so a single marker would allowlist an entire
  wire-backstop request. A deliberately-marked fake fixture being masked (and
  restored locally) is the accepted cost.
- Multi-part rules run their primary pattern standalone instead of requiring
  co-occurring components (may over-redact; never under).
- `skipReport` component rules are dropped, except `aws-secret-access-key`,
  which is deliberately re-enabled: a lone AWS secret key is exactly the
  leak that matters most here.
- `failsTokenEfficiency` and path-attribute filter clauses evaluate to
  "keep the finding", so the generic rule may redact some strings upstream
  would discard as prose-like.
- Live credential validation (HTTP probes) is not ported and never will be.

## Limits worth knowing

- **The redaction map lives in memory — by design — with recovery layers
  instead of a secrets file.** Restoring a placeholder requires
  knowing its secret, and the plugin deliberately never writes secrets
  anywhere new (a persisted vault would aggregate every credential the agent
  ever touched into one file; that option was considered and rejected).
  Recovery works like this:
  1. Placeholders are a keyed function of the secret, so a restarted process
     re-learns every mapping when the next outbound request re-scans the
     transcript's raw copies (tool outputs, user text, restored assistant
     text). Raw copies whose detection context is gone — a restored value
     sitting bare in prose — are re-identified through the persisted
     fingerprint catalog instead (keyed hash + length; nothing reversible),
     so they are re-masked *and* restorable after a restart when the relevant
     catalog entry and installation key are still present.
  2. Compaction summaries are asked to carry every live placeholder forward,
     and because summaries stream through the same completion hook, the
     stored summary gets raw values written back only if a cold scan can
     re-mask the exact result. Otherwise it retains the placeholders rather
     than persisting an unsafe raw copy. (This layer needs `restoreText`
     on, its default; disabling it or failing the safety check leaves layer 3
     as the only post-restart recovery — see Options.)
  3. If a hash still comes up unknown (e.g. the summarizer dropped a
     placeholder and the process restarted), fingerprint recovery rescans
     the shell environment and the project's env files (`.env`,
     `.env.local`, `.env.development`, `.env.production`, `.env.test`,
     `.envrc`; each is size-checked and skipped if oversized) and verifies
     candidates against the placeholder's keyed hash — a stray key is usually
     still sitting where it originally leaked from.

  The residual case — summary dropped the placeholder, process restarted,
  *and* the secret no longer exists in the environment or an env file — is
  accepted: the tool call runs with the literal placeholder and fails
  visibly, never silently.
- **Exact matching is deliberately greedy.** Once a value is vaulted, every
  literal occurrence of it is masked for the rest of the process's life —
  even somewhere it is arguably not a credential (a hex string that once sat
  next to `datadog_api_key =` gets masked in a later stack trace too).
  Restoration is symmetric (tool calls still receive real values), so the
  cost is placeholder noise in odd places, and the alternative — trusting
  context to decide when a *known* credential is "not really" leaking — is
  exactly the reproduced leak. The catalog's re-identification after a
  restart covers single-token secrets and unquoted `user:pass` credentials,
  including `@`, `$`, and braces. These are candidate scans, not new detection
  rules: only an exact keyed fingerprint match permits replacement, so an
  unknown colon-delimited value is not redacted just for looking like a pair.
  Each run must fit a cataloged length with at most four extra characters of
  punctuation or adjacent text. Self-describing shapes such as private-key
  blocks can re-fire their rules; any restored text that neither path can
  re-mask keeps its original placeholders instead.
  Partially overlapping secret spans are masked as one placeholder covering
  their union, so neither leaves a raw fragment. Both constituent values and
  the combined span remain restorable in the live vault.
- **Fingerprint recovery is bounded and fails closed.** Both candidate passes
  share a limit of 10,000 distinct candidate strings (one HMAC each) per
  scanned string. An outbound scan needing more aborts before that content is
  sent; a completed-text safety check that exceeds the limit leaves the entire
  part's placeholders intact. An unresolved catalog entry survives a restart,
  so repeatedly replaying a candidate-heavy transcript can repeatedly hit the
  limit. The protection-preserving recovery is to remove or revert the
  candidate-heavy content from that session, or start a new session that does
  not replay it.

  The catalog is `$XDG_DATA_HOME/opencode/redact-secrets.fingerprints.json`
  when `XDG_DATA_HOME` is set, otherwise
  `~/.local/share/opencode/redact-secrets.fingerprints.json`, and retains at
  most the 2,048 most recent entries. Eviction at that bound, external deletion
  or corruption, and simultaneous processes whose final renames race can all
  lose entries. It is therefore a recovery aid, not a durable secret vault or
  a blanket restart guarantee. If the affected history cannot be changed, the
  last-resort recovery is to stop all OpenCode processes using that data
  directory and move the catalog aside, but never remove `redact-secrets.key`:
  losing a catalog entry can leave a contextless raw value in an older
  transcript unrecognized after restart and therefore unmasked if ordinary
  rule detection also misses it. Do not reopen affected old sessions until
  that content is removed or the needed catalog is restored.
- **The in-memory vault is capped, and the cap fails closed.** Because
  eviction would break the guarantees above (stable placeholders, exact
  re-masking, restoration), the vault never evicts; instead it refuses to
  grow past 10,000 distinct secrets *or* 8 MB of secret material — both
  orders of magnitude beyond any real session — and a request that would push
  it past either is aborted rather than sent with the excess value raw. The
  byte budget matters as much as the count: several rules (private keys above
  all) match spans with no length ceiling, so one PEM-shaped blob can retain
  megabytes while counting as a single entry. Hitting either cap means
  runaway or adversarial content (say, a tool dumped tens of thousands of
  credential-shaped strings); restarting OpenCode clears the vault.
- **Secrets inside binary documents and images are only partially covered.**
  PDFs are sent to capable providers, which extract their text, so a credential
  stored as literal text in a PDF — an uncompressed content stream, XMP, or
  document metadata — is caught. One buried in a **FlateDecode-compressed**
  stream is not: its bytes are zlib data no byte-level scan can read, and the
  base64 wire backstop cannot recognize it either. A secret rendered as pixels
  in an image (a screenshot of a `.env`) that a model reads via vision/OCR is
  likewise beyond a text scan — magic-confirmed image, audio, and video
  payloads are treated as opaque (a *mislabeled* one is scanned, but a real
  screenshot is a real PNG). Keep credentials out of attached documents and
  screenshots.
- **`part.metadata.<provider>` is left byte-exact for opaque protocol state.**
  The host hands that map back to the provider as `providerOptions`, and for
  OpenAI it holds the reasoning item's `itemId` and its
  `reasoningEncryptedContent` — which, under `store:false`, is not a cache of
  anything but the actual channel through which the model sees its own prior
  reasoning, so it travels in the prompt on every later turn. Substituting a
  placeholder into ciphertext or a minted id cannot prevent a leak (the
  provider generated those bytes) and does corrupt state the provider will
  reject. Since these blobs are base64/hex over a large alphabet — the shape
  entropy-gated rules exist to notice — this is the one place where scanning
  *less* is the conservative choice. The protected names cover what OpenCode
  1.18.5 actually persists and replays: OpenAI's `itemId` and
  `reasoningEncryptedContent`, Anthropic and Bedrock's `signature` and
  `redactedData`, Copilot's `reasoningOpaque`, Google's `thoughtSignature`.
  Two boundaries on the skip: it applies one level under a namespace only, so
  nested objects and every differently named field still walk normally; and it
  applies only inside `part.metadata`, so the same names elsewhere (a webhook
  payload's `signature`, a tool output's `itemId`) are ordinary content and
  still redacted. Within `part.metadata` it matches on the field *name* under
  any namespace, including one this build does not recognize — provider
  namespaces are an open set, and an unknown one is likelier to be a provider
  added since the OpenCode pin than a plugin storing a credential under a name
  meaning "ciphertext". Adding a provider means checking its converter for
  opaque fields; a missing name makes that provider's continuation state
  mutable.
- Reasoning parts and streamed tool-call arguments have no inbound hook in
  OpenCode 1.17-1.18; placeholders there stay placeholders until the tool
  actually executes (where restoration does happen).
- Detection is regex-based. A secret with no recognizable shape, keyword
  context, or entropy signature will not be caught. This is a net, not a
  guarantee.

## Updating the vendored rules

Replace `vendor/betterleaks/betterleaks.toml` with the newer upstream copy,
bump the commit hash in `vendor/betterleaks/PROVENANCE.md`, and run
`bun run vendor`. The script fails loudly on any rule or filter shape it does
not recognize; the diff of `src/engine/rules.generated.ts` is the review
surface, and built-in canaries assert headline rules still fire.

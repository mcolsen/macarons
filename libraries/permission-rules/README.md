# @macarons/permission-rules

The OpenCode V1 permission-rule engine — plus the common helpers — shared by
every Macarons plugin. The engine's first consumers were
[`persist-permissions`](../../plugins/persist-permissions) and
[`approve-for-me`](../../plugins/approve-for-me): the store
shape, `*`/`?` wildcard matching with `~`/`$HOME` expansion, last-rule-wins
evaluation, the decision helpers, trusted project-store path resolution
(including `discoverPrimaryRoot`, which keys a repository's store by its
primary worktree root under the default `"repository"` scope — verified
against the repository's own worktree listing and `--git-common-dir` so a
forged `.git` gitfile cannot select another repository's store — and
`migrateWorktreeStore`, the prepend-only fold of pre-scope per-worktree
stores, which refuses merges that could reorder an import past an overlapping
carve-out under another permission key), the pattern-language helpers
(`patternSubsumes` / `patternsOverlap`, sound containment and exact overlap
for the wildcard dialect), atomic store I/O plus `withStoreLock` (the
cross-process lock every store read-modify-write holds), and the
OpenCode-version compatibility guard
(`classifyOpenCodeVersion` / `openCodeCompatNotice`). The one hard boundary the
plugins enforce is OpenCode v1: a v1 host outside the verified band
(`SUPPORTED_OPENCODE_RANGE`, defined here for the whole suite — it rides the
repo's pinned OpenCode release, floor = the pin, ceiling = its next minor;
consumers' `engines.opencode` instead carries the static v1 install gate,
`OPENCODE_ENGINE_RANGE`) warns but keeps running, and only a non-v1 host (OpenCode
v2+, whose plugin API differs) disables the plugin.

Since the 2026-07 audit's duplication consolidation (issue #37) this package
also carries the suite-common plumbing every plugin previously forked:
trust-boundary path containment (`isInside` / `canonicalPath`, the helpers on
which settings/store/channel path trust checks are built), server-locality
classification (`sdkClientBaseUrl` / `serverLocality` — in-process vs.
loopback vs. remote, with loopback never trusted for credential writes), the
app logger (`appLogger`), and the boot-time version gates for both plugin
halves (`reportServerCompat`, `reportTuiCompat` / `warnTui`, plus
`routeSessionID` for TUI sidebars). It grew here rather than into a second
shared package because every plugin already depended on this library and one
package keeps one definition-site guard surface:
`test/sole-definition-site.test.ts` sweeps every plugin source file and fails
on any private redefinition of a shared helper.

The permission TUIs use `createFilesystemLocalityResponder` and
`verifyFilesystemLocality` rather than URL classification to authorize local
file access. A fresh challenge travels through the host's `tui.publish` API;
the enforcing server writes temporary owner-only markers in its own required
directories. The TUI must read them, write a fresh response into them, and read
back the server's acknowledgement in every directory. One-way replication or
copy-on-write mounts cannot pass merely by exposing fresh server files.
Checks include the actual policy-file directories, not just their config/state
ancestors, so a separately mounted permission subdirectory is not overlooked.
The protocol never accepts a caller-supplied server path or changes permission
policy. Missing/older server halves, failed requests, and non-shared mounts
fail closed, including loopback tunnels and internal-hostname attaches.

The 2026-07-23 duplication audit added the rest of what the suite had been
copying between plugins — the helpers found at three or more call sites, each
settled here rather than averaged (`test/tier2-helpers.test.ts` pins the
decisions):

- **Host plumbing** — `serverToast` / `tuiToast` (the suite's most-copied
  function), `withTimeout` (which both aborts the work and races it, because
  the copies it replaces each did only one), `unwrap` (strict on both legs),
  `mintMessageID` (the host's own ascending id format), `promptIdentityBody`
  next to `sessionPromptIdentity`, and `compactionNote` — plus
  `normalizeRequest`, the one reading of a `permission.asked` event both
  permission plugins act on.
- **Timers and serialization** — `unrefTimer` / `every` (no plugin timer is
  ever the reason its process stays alive) and `createSerialQueue` (in-process
  write ordering; `withStoreLock` remains the cross-process one).
- **Options** — `clampNumber`, `rejectNumber`, `explicitBoolean`,
  `keybindOption`, `parseModelRef` / `formatModelRef`, and `MAX_TIMER_MS`. The
  house default for a bad numeric option is reject-and-warn, not silent
  clamping; the reasoning is documented at the toolkit.
- **Persistence** — `readJsonFile` (the read-ENOENT-parse-validate skeleton,
  with missing and unreadable kept distinct) and `projectHash` /
  `shortProjectHash` / `projectScopedFile` for per-project state files.
- **`createWarnOnceLatch`** — warn once per cause, and report the recovery.

The same audit's §2.3 moved OpenCode's **auth store** here, the one subsystem
where a fork does not merely duplicate code but disagrees about who is signed
in: three plugins each read `auth.json` their own way, so under the inline
`OPENCODE_AUTH_CONTENT` override — how a control-plane workspace receives its
credentials, with no `auth.json` on disk at all — they saw different
credentials than the host and than each other. `readAuthStore` is now the
suite's only reader and it is the host's `Auth.all()`: the inline override
wins wholesale and stays **raw** (the host does not schema-filter it, so
neither may we), unparseable inline content falls through to the file, the
file is decoded entry by entry through `validAuthType` / `validatedAuthStore`
so an entry the host would discard is never mistaken for a live credential,
and a missing or corrupt file is an empty store rather than an unknown one.
`openCodeDataDir` / `openCodeAuthStorePath` settle the two path derivations
the plugins had in favor of the environment: it is what the host's own xdg
read returns, and the SDK-state derivation web-search used (`…/state/opencode`
rewritten to `…/share/opencode`, because `/path` reports no data dir) is
retired rather than kept — it is redundant when the reader shares the host's
process and unsound when it does not, with nothing in between, and its input
comes from a peer the loopback tier already refuses to trust with
credentials. On top of the store sit the record helpers both OAuth callers
needed: `authEntry` / `oauthRecordOf` (lenient by design — each caller narrows
to the fields it can act on) and `accountIdFromToken` / `oauthAccountId`, the
JWT account-id fallback that had existed in only one of them.
`test/auth-store.test.ts` pins each of these decisions.

`readRefreshedAuthStore` is the one sanctioned departure from that mirror, for
callers that have to **use** an OAuth token rather than agree about who is
signed in. The inline path is a frozen snapshot and OAuth records are not: when
a workspace's injected token expires the host refreshes it and `Auth.set` writes
the replacement to `auth.json`, but it never rewrites the environment and
`Auth.all()` short-circuits on the variable before it opens the file — so the
mirror reports a dead token for the workspace's whole lifetime while the host
serves a live one. This reader repairs exactly that: an **expired** inline OAuth
record is replaced by a strictly later valid file record for the same provider
and the same derivable account identity, never adding a provider the snapshot
lacks (that would be the merge `Auth.all()` refuses), substituting another
account, or touching a live record or a store that came from the file.
web-search and codex-limits read through it because they decline expired ChatGPT
tokens; redact-secrets stays on `readAuthStore`, whose view is unchanged.

The same audit's §2.2 moved **session busy/idle** here, the question two
plugins ask before they write into a session someone else may be using: cron
holds a fired job until the session is idle, background-tasks holds a
completion note, and a wrong answer does not degrade either one — it steers
the user's running turn. `createSessionActivityTracker` is the core they had
each built: a record fed from `session.status` / `session.idle`, one
directory-scoped `GET /session/status` for a session no event has described,
and not-idle for everything else. Where the two forks disagreed, the host's
own ordering settles it. An **observation beats a request**, because the host
publishes the status event into the plugin hooks synchronously *before* it
mutates the map that endpoint serves — so background-tasks' cross-check of a
session it had already seen could only ever confirm, at the cost of a round
trip per note. The **request is never cached**, because that leg runs only for
a session the event feed has said nothing about, and caching a "busy" from a
silent feed would take an idle event from that same feed to clear it. And
**unknown is not idle** — a non-2xx (which this SDK reports as a resolved
`{ error }`, not a throw), a timeout, an unreadable payload, an absent route —
because the cost of holding a delivery is a delay and the cost of guessing is
a hijacked turn. Only the literal `"idle"` counts as idle: `"retry"` is a
sleeping attempt *inside* a live run, and a status type this suite has not
heard of gets the same treatment.

What stayed in the plugins is what to *do* with the answer (§2.9): cron's
pending flag and coalescing, background-tasks' parked notes, and its
optimistic-busy mark — which exists for the two windows no tracker can see,
where `promptAsync` has answered 204 long before its forked run reaches
`status.set(busy)`, and where a halted turn publishes idle while its runner is
still running. The tracker reports state; the plugin decides what it is worth.

subagent-comms keeps its own answer too, and that one is a genuine policy
difference rather than a fork: it reads the endpoint first on every call, takes
the whole map at once for every child it is watching, and treats an unreadable
read as a third state its callers resolve toward busy. It orders steers *into*
subagents rather than deciding whether to interrupt the user's turn, so a
record it never clears would hold a wait, a kill and a settle open rather than
merely delaying a delivery. What it does share is `sessionActivityFromEvent`,
the parse of the host's own event payloads, because three plugins narrowing
`session.status` by hand is exactly how those shapes come apart — and the same
`SESSION_STATUS_PROBE_TIMEOUT_MS` now bounds its read, which had none.

`test/session-activity.test.ts` pins each decision by name, and all three
plugins carry a tripwire that the parse has not grown back locally.

Everything replicates OpenCode's own permission semantics; the port of
`Wildcard.match` is byte-for-byte deliberate. The behavior spec pinning these
semantics lives in `plugins/persist-permissions/test/matching-spec.test.ts`
and runs against this copy through that plugin's re-exports — a guard there
asserts this module stays the engine's sole definition site.

Consumed as TypeScript source (`main: ./src/index.ts`); the plugins' `bun run
build` bundles inline it for copy-installs. When OpenCode's V2 permission
engine becomes the default, this library retires with the plugins that use it.

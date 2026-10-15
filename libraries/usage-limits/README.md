# @macarons/usage-limits

Shared quota types, formatting, polling, and native OpenCode v2 RPC support for
Codex Limits and Synthetic Limits.

Provider modules normalize backend responses and retain their account-change,
backoff, and stale-response rules. The server adapter resolves credentials
through `integration.connection.active/resolve`, rechecks identity after I/O,
and returns only quota windows. The TUI engine reads those snapshots through
RPC, refreshes on model changes, hides child-session widgets, and queries the
optional Approve for Me classifier-provider RPC.

The TUI never reads auth files or makes authenticated provider requests.
The entry module supplies Solid reactive primitives so widgets share the host's
Solid runtime. The server uses a small in-memory signal implementation.

```sh
bun run --cwd libraries/usage-limits test
bun run --cwd libraries/usage-limits typecheck
```

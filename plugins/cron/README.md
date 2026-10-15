# @macarons/cron

Native OpenCode V2 scheduled prompts. OpenCode 2.0.29 provides background shell
commands and subagents, but no built-in cron or reminder tools, so this plugin
remains useful alongside the native tools.

Requires OpenCode **2.0.29 or later in the V2 series**. Run `bun install && bun
setup` from the Macarons repository to install it. To configure it manually,
add the package directory to your server configuration:

```jsonc
// opencode.jsonc
{
  "plugins": ["file:///path/to/macarons/plugins/cron"]
}
```

This plugin has no TUI half. Jobs live in the server's memory; with V2's shared
background service, closing a TUI does not stop them. Restarting the service or
reloading the plugin drops its schedules. A prompt already admitted to the
host's durable queue is owned by OpenCode and can survive plugin disposal.

| Tool | Purpose |
| --- | --- |
| `cron_create` | Schedule a prompt with a five-field local-time cron expression. Set `recurring: false` for a one-shot reminder. |
| `cron_list` | List the current root session's jobs, next fire times, expiry and delivery failures. |
| `cron_delete` | Delete a job owned by the current root session. |

For example, ask for “remind me at 2:30 today to check the deploy” or “run the
smoke test every 20 minutes.” Jobs created by a subagent belong to its top-level
session. Each root session can hold at most 50 jobs. Recurring jobs expire
seven days after creation; their first fire at or after expiry is the last.

Expressions accept numeric values, ranges, steps, comma lists and `*`. Named
months/weekdays, seconds fields and extensions such as `L`, `W`, `?` and `#`
are rejected. Recurring fires have deterministic jitter of up to half their
interval, capped at 30 minutes. One-shots on minute 0 or 30 may fire up to
90 seconds early; other one-shots fire at the specified minute.

Scheduling requires the `cron` permission. The plugin installs an `ask`
default before configured agent rules, so explicit V2 rules can override it:

```jsonc
{
  "permissions": [
    { "action": "cron", "resource": "*", "effect": "ask" }
  ]
}
```

The permission resource contains the complete scheduled prompt. Choosing
“Allow always” saves a native project-scoped `cron: *` approval. Permission
denials and cancellation never create a job.

Before dispatch, the plugin waits for the owning session to become idle.
Multiple fires while busy coalesce; calls for the same session are serialized.
The prompt uses V2's **queued delivery**, so a user turn racing that idle check
cannot be interrupted by the reminder. It preserves the session's current
agent and model. A successful response confirms durable inbox admission,
not that the agent has finished the scheduled work.

Host calls have ten-second deadlines. A session that remains busy or cannot
be queried retains the fire and is checked again. Native completion/deletion
events also release pending jobs or clean up deleted sessions. A failed event
stream does not prevent delivery recovery through those checks.

Explicit admission rejections retry a one-shot or final recurring fire up to
three times. Transport failures, timeouts and invalid acknowledgments leave
acceptance uncertain: the job is parked without resubmission to prevent a
duplicate autonomous turn. Inspect that state with `cron_list` and clear it
with `cron_delete`. A non-final recurring fire rejected before admission is
skipped and retries at its next normal match.

Run `bun test`, `bun run typecheck`, `bun run lint` and `bun run build` in this
package to verify it. The scheduler's existing timing, coalescing, expiry,
jitter and failure tests remain in place; the integration tests exercise the
native V2 tools, permission assertions, queue contract and cleanup.

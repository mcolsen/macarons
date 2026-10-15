# @macarons/approve-for-me

OpenCode v2 permission review by a user-selected classifier. It approves eligible
low and medium risk requests once, and leaves every other request for you.
V2's built-in saved permissions replace Macarons' old persist-permissions
plugin; they do not replace this classifier.

Run `bun install && bun setup` from the Macarons checkout. To configure it by
hand, put the server package directory in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/macarons/plugins/approve-for-me",
      "options": {
        "enabled": true,
        "model": "anthropic/claude-sonnet-5",
        "timeoutMs": 120000
      }
    }
  ]
}
```

Configure the native terminal companion separately in `cli.json`:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/macarons/plugins/approve-for-me",
      "options": { "sidebar": true, "feed": true }
    }
  ]
}
```

Both entrypoints use `@opencode/plugin` 2.0.29. The supported host range is
OpenCode 2.0.29 through the v2 series. The old `plugin` arrays, tuple options,
and `tui.json` configuration are replaced by V2 `plugins`, package/options
objects, and `cli.json`.

When a permission request arrives, the server reads its active session context,
selects at most the newest 200 context messages, and builds a bounded classifier
prompt. Source redaction runs before excerpts are selected. A normal model is
called through an isolated temporary session with a fixed policy system prompt,
one user prompt, no tools, and deny-all session permissions. Jev uses its native
integration. The selected model, timeout, and trust state are rechecked before
an approval can be released.

The enforced policy is:

| Risk | Automatic approval |
| --- | --- |
| Low | Eligible unless a local veto applies |
| Medium | Requires at least implied user authorization |
| High | Always requires the user |
| Critical | Always requires the user |

High-risk requests remain manual in this port because V2 does not expose the
command-origin provenance needed to prove the old clear-authorization case.
Errors, timeouts, malformed verdicts, unknown models, ambiguous ancestry, and
changed requests leave the prompt pending. Replies use `once`, never `always`.
Specific user permission carve-outs and writes affecting OpenCode configuration
or protected policy/state paths veto automatic approval regardless of the
classifier's verdict. Classifier-generated text is not user authorization.

Classification can run in parallel, while permission replies remain ordered
within a root session's prompt stack. User responses cancel outstanding work;
late results cannot overwrite them. If the public event stream terminates,
the classifier pauses until the plugin reloads: V2 does not offer a global
pending-session discovery API sufficient to prove a complete recovery.

A surfaced or failed request can be rejected after the unattended timeout
(default 20 minutes), with a bounded budget per root session. Set
`unattendedDenyMs` to `0` to disable this behavior. Startup stale-request cleanup
is limited by the sessions the V2 host exposes; incomplete snapshots never
justify automatic approval.

The terminal companion provides these palette commands:

- **Toggle for this instance**, also bound to `<leader>d` and `ctrl+alt+a`.
- **Choose classifier model**, scoped to the root session, project, or all
  projects. The picker includes the session model, Jev, available catalog
  models, and their variants.
- **Set classifier timeout** and **set persistent default**.
- **Trust project plugin config**, which records the reviewed files' exact
  hashes, or revokes an existing trust record.

The sidebar shows server status and permission activity, including the reason a
request needs you. Status and quota relevance come from read-only, location-scoped
RPC methods. RPC exposes no setting, toggle, model-selection, or trust writes.
Controls retain guarded local file writes and require a fresh bidirectional
filesystem proof across the server's config, state, policy, and project roots.
Matching paths or a loopback address do not establish shared storage. A remote
attach may view server status but cannot change policy without verified shared
storage. Reconnection or path changes invalidate an in-progress control.

The TUI options are `keybind` (string, `false`, or `"none"`), `sidebar` (default
`true`), and `feed` (default `true`). Model and permission diagnostics remain
available in server logs; the V1 server toast endpoint no longer exists.

Persistent settings merge from these sources, in order:

1. This plugin's entry in global `opencode.json`, then `opencode.jsonc`.
2. Reviewed project `opencode.json[c]` and `.opencode/opencode.json[c]` entries.
3. The personal project settings file under the OpenCode config directory.

V2 accumulates plugin arrays: a later unrelated or empty array does not erase an
earlier plugin entry. A later entry for this plugin replaces its earlier option
object. Parent project configuration precedes child configuration. Global edits
preserve JSONC comments and use checked atomic publication. Worktree settings
remain inert until their exact bytes are trusted; later edits and removals
require review again. Unreadable, unsafe, or ambiguous settings pause approval.

The stable `permissions-approve-for-me` directory names preserve existing
personal settings, approval journals, session model records, and trust records.
Instance overrides and activity are isolated by the server instance ID. The
retired standalone global settings file and unresolved legacy project settings
are not silently adopted; review and migrate them before changing policy.

Supported server options include `enabled`, `model`, `variant`, `timeoutMs`
(default 120000, bounded 5000–600000), `processing` (`parallel` or `serial`),
`maxConcurrent` (default 4, bounded 1–16), `journal`, `sweepStale`,
`unattendedDenyMs`, per-action boolean `permissions`, and repository/worktree
`scope`. An explicit project `null` can clear an inherited model, variant, or
timeout pin. Ordinary OpenCode tool permission rules still belong in native
V2 `permissions` arrays; this plugin does not replace their enforcement.

The `./interop` entrypoint exposes a bounded `classifierProvider` RPC reader
for quota widgets. The `enshrine-approvals` skill reviews the approval journal
and proposes native permission rules; approvals are never persisted as broad
rules automatically.

Models can misjudge actions. This is a convenience layer over permission prompts,
not an operating-system sandbox. The agent still runs as the host user; plugin
code, permissive shell commands, and edits outside the classifier's observable
permission requests can bypass its checks. Existing local privacy, credential,
path, and journal protections remain relevant.

Run `bun test`, `bun run typecheck`, and `bun run build` in this package. The
native tests cover classifier isolation, policy vetoes, ordering, timeout and
unattended behavior, settings drift, protected controls, RPC locality, and
quota interop.

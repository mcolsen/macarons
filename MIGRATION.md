# OpenCode v2 migration

Target: OpenCode **2.0.29** (GA), checked against the tagged upstream source and
published `@opencode/plugin` / `@opencode/client` packages. The migration uses
native default-exported `Plugin.define({id, setup})` definitions, domain hooks,
transforms, RPC, and terminal slots. It does not wrap V1 plugin entrypoints.

## Scope decisions

The owner reviewed the partial overlaps and selected these replacements:

| Old plugin | Native replacement and decision |
| --- | --- |
| background-tasks | Native background shell, completion notices, output files, Shell tab, and interruption. Retired; managed delta reads and regex waits are dropped. |
| subagent-comms | Native background subagents, model/variant selection, resume/steering, and model catalog. Retired; separate agent-facing list/wait/kill helpers are dropped. |
| subagents-sidebar | Native Subagents tab with open/interrupt. Retired; persistent sidebar and additional blocked/retry/elapsed labels are dropped. |
| btw | Native `/btw`. Retired; the plugin's follow-ups, reopen, promotion, and read-tools are dropped. |
| persist-permissions | Native project-persisted “always allow” approvals. Retired; editable patterns and conservative per-resource narrowing are dropped. Existing plugin approval files are preserved but are not imported into native permissions. |
| web-search | Native provider selection, consent, Exa and other integrations, and rate-limit failover replace the generic chain. Retain SearXNG and same-provider native search only. |
| cache-ratio | Native `opencode stats` already reports aggregate cache usage. Retain live session/request ratios, prefix-loss alerts, and expiry detection. |

Cron, model-based approval review, outbound secret masking, exact provider/model
prompt rules, and subscription quota widgets have no equivalent native feature
in the audited release and remain.

## Native contracts and behavior changes

- `opencode.json(c)` uses `plugins: [string | {package, options}]`.
  The terminal reads global `cli.json`, also with `plugins`.
- Local entries point to package directories containing root `index.ts` or
  `server.ts`, and `tui.ts(x)` where applicable. Published exports alone do not
  satisfy local directory discovery.
- Websearch provider callbacks receive only a query and abort signal. They have
  no requesting session/model identity. SearXNG uses that native integration API;
  the distinct `provider_search` tool retains the same-provider privacy boundary
  through its native tool context. It shares the native `websearch` permission
  action and does not replace the host's search tool.
- Legacy web-search `order` values are honored only as restrictions on which
  remaining backends may run. Exa/order no longer configure a fallback chain.
- Redaction covers native session context, compaction, title and transient
  generation requests, final HTTP requests and experimental WebSocket frames.
  Prose remains masked; placeholders are restored immediately before local tools.
  Sessionless consumers must use the shared source-redaction registry.
- Approve for Me preserves trust-path checks and revalidation. V2 cannot prove
  that an expanded command's text came directly from the user, so high-risk
  authorization-dependent approval fails closed to manual review. An interrupted
  permission event stream also pauses automatic approvals.
- Quota fetches run on the server using the active integration connection. TUI
  RPC responses contain display data, never credentials. Codex legacy OAuth and
  newer ChatGPT token-sharing have different authentication contracts; only
  documented compatible quota methods are queried.

The installer preserves unrelated V1 settings and entries while moving Macarons
entries. It refuses to create `cli.json` over unmigrated terminal preferences;
start v2 once first. Moving a plugin entry does not migrate stored plugin data.
Do not point OpenCode v1 at the converted configuration.

## Verification and historical tests

The active E2E suite is `tests/e2e/v2/`. Existing V1 journeys under the other
`tests/e2e/` directories are preserved as migration reference; they use the old
host API and are not part of v2 checks. Pure policy, scheduler, detector, quota,
and cache algorithms retain their relevant regression suites; native API tests
replace obsolete V1 hook and state-store assertions.

## Upstream evidence

- [Plugin migration and API](https://dev.opencode.ai/v2/docs/build/plugins/migrate-v1/)
- [Terminal plugin API](https://dev.opencode.ai/v2/docs/build/plugins/cli/)
- [Native tools](https://dev.opencode.ai/v2/docs/tools/)
- [Permissions](https://dev.opencode.ai/v2/docs/permissions/)
- [Websearch integrations](https://dev.opencode.ai/v2/docs/websearch/)
- [V2 terminal features](https://dev.opencode.ai/v2/docs/cli/tui/)
- [Tagged cache statistics implementation](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/commands/handlers/stats.ts)
- [Tagged native tool implementations](https://github.com/anomalyco/opencode/tree/v2.0.29/packages/core/src/tool/plugin)
- [Tagged terminal feature plugins](https://github.com/anomalyco/opencode/tree/v2.0.29/packages/tui/src/feature-plugins)

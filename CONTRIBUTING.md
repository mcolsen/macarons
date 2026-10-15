# Contributing to Macarons

Use Bun 1.3.14 and run from the repository root:

```sh
bun install --frozen-lockfile
bun run check
```

`check` runs lint, TypeScript, unit/integration tests, and builds through
Turborepo. Target one package with `bun run test --filter=@macarons/cron`.
`bun run format:check` checks formatting without rewriting files. Tests that use
mock HTTP servers need permission to bind loopback ports.

## Real-host verification

The active E2E suite targets the version in [`.opencode-version`](.opencode-version)
and uses temporary homes, projects, credentials, and loopback model providers:

```sh
bun run e2e             # server and installer journeys
bun run e2e:server      # native package loading, hooks, tools, and RPC
bun run e2e:install     # migrated configuration loaded by the host
bun run e2e:tui:gating  # required terminal rendering/locality journeys; needs tmux
```

These commands run `tests/e2e/v2/`. Older V1 journeys remain outside that directory
as migration reference and are not active checks. Generic sandbox and process
cleanup coverage is retained in the v2 harness tests. Run package tests through
their scripts so OpenTUI's JSX preload is applied where required.

The harness honors `OPENCODE_BIN`, then a matching local `opencode` outside CI,
otherwise downloads the native `@opencode/cli-<platform>` npm archive. Archive
SHA-512 integrity values are pinned in
[`.opencode-checksums.json`](.opencode-checksums.json). Cached extracted binaries
are verified against an installation-time SHA-256 sidecar before execution.
The upstream installer is never executed. Set `OPENCODE_E2E_VERSION` and either
`OPENCODE_BIN` or a verified `OPENCODE_E2E_INTEGRITY` to test another release.

The nightly bump workflow proposes version/dependency/integrity updates; required
CI checks must pass before accepting a new baseline. It stops at a major-version
boundary. See [CI](.github/workflows/ci.yml) for the required job matrix.

## Layout and contracts

| Directory | Purpose |
| --- | --- |
| `plugins/` | Eight independently installable native v2 plugins. |
| `libraries/permission-rules/` | Internal approval policy, trusted storage, locality, and shared helpers. |
| `libraries/usage-limits/` | Provider-neutral server quota RPC and terminal lifecycle. |
| `libraries/plugin-test-harness/` | Private packaging, bundle, async, and headless-render helpers. |
| `tools/installer/` | User-level config migration and interactive installer. |
| `tests/repo/` | Manifest, native-entry, dependency, documentation, and workflow invariants. |
| `tests/e2e/v2/` | Pinned real-host journeys. |

Server plugins default-export `Plugin.define` from `@opencode/plugin`; terminal
plugins use `@opencode/plugin/tui`. Local package directories also require root
`index.ts`/`server.ts` and `tui.ts(x)` shims. Source installs use workspace
dependencies; built artifacts require their declared runtime dependencies.
Build checks exercise the actual package scripts and staged artifact imports.

Preserve v2's native behavior where it already covers a feature. See
[MIGRATION.md](MIGRATION.md) before adding back retired features. Keep mechanisms
shared only when there are two consumers. Terminal whitespace must be explicit
JSX strings such as `{"  "}` because browser-style whitespace collapse differs.

Update affected README files when behavior changes, preserve meaningful pure
regression tests, and add native API/real-host coverage for contract changes.
Report checks that could not run. Do not commit credentials, transcripts, or
local artifacts.

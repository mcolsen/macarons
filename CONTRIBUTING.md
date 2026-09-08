# Contributing To Macarons

## Local Checks

Use [Bun 1.3.14](https://bun.sh) and run commands from the repository root:

```sh
bun install --frozen-lockfile
bun run check
```

`check` runs linting, typechecking, tests, and builds through Turborepo. You can
also run `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run build`
individually. To target one package:

```sh
bun run test --filter=@macarons/persist-permissions
```

`lint` uses `biome check`, including formatting and import order.
`bun run format:check` checks without writing; `bun run format` rewrites the
tree, so review its diff before including unrelated changes.

Spacing that reaches the terminal must be written as a JSX expression:
`{"  "}`, not literal repeated spaces in JSX text. Formatters assume browser
whitespace collapsing; terminal rendering does not. Repository tests guard this.

## Real-Host Tests

The fast checks exclude real-host E2E tests. The harness starts a pinned OpenCode
binary and a loopback-only scripted model provider. It requires permission to
bind local ports; TUI journeys also need `tmux` and a usable terminal environment.

```sh
bun run e2e             # required server, copied-bundle, and installer journeys
bun run e2e:server      # server journeys, including copied-bundle coverage
bun run e2e:install     # package-directory installer journeys
bun run e2e:tui         # advisory terminal journeys
bun run e2e:tui:gating  # required permission-locality and quota-auth journeys
```

For individual journeys, use the scripts in
[`tests/e2e/package.json`](tests/e2e/package.json), for example:

```sh
bun run --cwd tests/e2e e2e:subagent-comms
```

The required CI jobs run against [`.opencode-version`](.opencode-version).
The advisory TUI job is separate from the required TUI gating job; see
[the workflow](.github/workflows/ci.yml) for the exact matrix and artifact policy.
The background-task shutdown reproduction is also separate: stock OpenCode's
known lifecycle limitation and the host patch are documented in
[`SHUTDOWN.md`](tests/e2e/background-tasks/SHUTDOWN.md).

The harness uses `OPENCODE_BIN` when set, otherwise (outside CI) a matching
`opencode` on `PATH`, otherwise it downloads the pinned release to
`$XDG_CACHE_HOME/macarons-e2e/<version>/` (or
`~/.cache/macarons-e2e/<version>/`). It does not modify your OpenCode installation.
Downloads must match the SHA-256 in
[`.opencode-checksums.json`](.opencode-checksums.json); the upstream installation
script is not executed.

To test another release, set `OPENCODE_E2E_VERSION` and supply either
`OPENCODE_BIN` or an explicitly verified `OPENCODE_E2E_SHA256`. The committed
checksums cover only the pinned release.

The nightly [bump workflow](.github/workflows/bump-opencode.yml) proposes newer
OpenCode pins in a single PR and dispatches CI. A proposed version is not a
verified baseline until its checks pass and the PR is reviewed and merged.

## Repository Layout

| Directory | Purpose |
| --- | --- |
| `plugins/` | Independently installable plugins, each with its own README and tests. |
| `libraries/permission-rules/` | Shared permission matching, stores, host guards, and cross-plugin helpers. |
| `libraries/usage-limits/` | Provider-neutral quota contracts and TUI lifecycle. |
| `libraries/plugin-test-harness/` | Private development-only test helpers. |
| `tools/installer/` | Interactive user-level config installer. |
| `tests/repo/` | Repository-wide invariants and workflow tests. |
| `tests/e2e/` | Pinned real-host harness and journeys. |

Keep code in its plugin until a second consumer needs the same API. Share
mechanisms, not plugin-specific policy; see [the library guide](libraries/README.md).
Plugins can have a server entry, a TUI entry, or both. Source and package-directory
installs need checkout dependencies but no build. Copied distribution bundles
require a build; E2E tests exercise those separately.

## Pull Requests

Keep changes focused, add regression coverage for behavior changes, and update
the affected plugin's README when its configuration or behavior changes. Run
`bun run check` and the relevant real-host journeys, and report any checks you
could not run. Do not include credentials, private transcripts, or local test
artifacts in commits or issue reports.

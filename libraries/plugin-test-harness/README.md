# @macarons/plugin-test-harness

Dev-only test harness for Macarons (2026-07-23 audit §3, issue #116). Before it
existed the test scaffold was copy-pasted across the suite: the
packaging skeleton in 15 files, the bundle skeleton in 11, the version-gating
triad in 11 spellings of which no two matched, the TuiPlugin api mock at 17
sites, and one poll loop written nine ways. The harness is the single
definition site; per-plugin domain fixtures and genuinely unique contracts
(SKILL.md, NOTICE, vendored-rule markers, SUITE cross-checks) deliberately
stay inline in each plugin's own test files.

This package is a `devDependency` carrying `bun:test` / `@opentui/solid` machinery that must
never enter the runtime library's dependency surface, so it cannot fold into
`permission-rules`. It is `private` and never published.

## Entry points

- `.` — server-safe: `describePackaging`, `describeBundle`, and the async
  helpers (`tick`, `flush`, `until`). No TUI types load through this path.
- `./tui` — `makeTuiApi` (the api mock core a plugin's own `makeApi` extends
  with its domain surface) and `describeGating` (the compat/locality triad,
  driven by the library's `BAND_SAMPLE_VERSIONS` — the harness hardcodes no
  versions).
- `./view` — `createSlotMounter` and `settleFrame` for view tests under
  @opentui/solid's headless renderer; separate so engine-only test files
  never load solid.

`tests/repo/test/test-kinds.test.ts` requires each plugin's packaging (and
builders' bundle) tests to import the harness, so a scaffold cannot quietly
fork back to a hand-rolled copy.

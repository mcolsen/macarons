# @macarons/plugin-test-harness

Private, development-only test helpers for Macarons. Runtime packages must not
depend on this package: it imports `bun:test` and headless rendering tools.

- `.` provides `describePackaging`, `describeBundle`, `tick`, `flush`, and `until`.
- `./view` provides `createSlotMounter` and `settleFrame` for headless rendering.

The repository's central native packaging suite discovers every plugin and
checks exported `{ id, setup }` definitions, shipped package-directory entry
shims, dependencies, and builds. Builds run the package's declared command;
external imports must be declared runtime dependencies and are resolved from
a staged dependency scope. Native UI tests supply the v2 `Plugin.Context`
surface their features consume. The former v1 API mock and version-gating
helpers have been retired.

```sh
bun run --cwd libraries/plugin-test-harness test
bun run --cwd libraries/plugin-test-harness typecheck
```

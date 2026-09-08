# Shared shutdown deadline: upstream handoff

Issue: [#271](https://github.com/mcolsen/macarons/issues/271).

## Required host change

**Stock OpenCode 1.18.14 is still affected. This plugin repository cannot ship
the host lifecycle fix. Do not certify the unpatched release or merge a closing
PR as a plugin-only resolution.**

The supported reproduction baseline is OpenCode `v1.18.14`, source commit
`65cf14df16c191f3e9684f0d9a8bae69103ced6d`, with Bun `1.3.14` on Linux. Apply
[`opencode-shutdown.patch`](./opencode-shutdown.patch) to that source to obtain
the tested host prerequisite. No released upstream version containing this
change has been verified. The local `v1.18.29` tag has the same two serial
disposal loops, so a version-only upgrade to that tag is not a fix.

The patch changes only two `Effect.forEach` options to
`{ concurrency: "unbounded", discard: true }`:

- `packages/opencode/src/project/instance-store.ts`: start disposal for all
  cached directories before joining their completion. One directory's pending
  load or slow disposer must not prevent another ready directory from starting.
- `packages/opencode/src/plugin/index.ts`: start all dispose hooks within an
  instance before joining them. An earlier plugin's pending asynchronous hook
  must not starve background-tasks.

The host still awaits disposal. The five-second TUI shutdown deadline, real
worker RPC, and explicit worker termination are unchanged. Single-directory
disposal/reload, cache identity checks, in-flight global-dispose deduplication,
post-disposal events, and plugin error handling retain their existing scope.
Initialization and normal hook execution remain sequential. Upstream consumers
must not rely on ordering between asynchronous plugin dispose hooks.

There is deliberately no plugin-global task sweep, inferred shutdown event,
shortened escalation, or early return from the per-instance barrier fixed by
#234. An instance's `dispose()` has no cause or host-wide deadline. The later
`global.disposed` event neither starts shutdown nor runs on the worker shutdown
path. Referenced timers cannot survive an explicit `worker.terminate()`.

Concurrency removes serial budget starvation, not arbitrary shutdown failures:
synchronous event-loop blocking, unexpectedly slow kernel termination, escaped
process groups, a crash/SIGKILL, and unbounded state-file I/O remain outside this
guarantee. The plugin's process/pipe wait remains bounded at four seconds.

## Reproduce and verify

Use a disposable source checkout, not the host running your current session.
From the plugin repository root, after `bun install --frozen-lockfile`:

```sh
git clone --depth 1 --branch v1.18.14 https://github.com/sst/opencode /tmp/opencode-shutdown-host
git -C /tmp/opencode-shutdown-host rev-parse HEAD
bun install --cwd /tmp/opencode-shutdown-host --frozen-lockfile --ignore-scripts
OPENCODE_E2E_SOURCE=/tmp/opencode-shutdown-host bun run --cwd tests/e2e e2e:background-tasks:shutdown
```

The last command must fail on the unpatched baseline: the ordinary case never
finishes the second disposer, and the earlier-hook gate case never starts the
task disposers. The #233 keeper can kill groups on parent disconnect, but that
post-termination fallback does not meet the awaited normal-shutdown contract.
These are desired-behavior assertions, not tests that bless the bug. Each run
unconditionally kills recorded original groups, including their descendants, in
the outer supervisor's `finally`, including startup/readiness/assertion failures.
PID files are written by the tasks independently of tool return and readiness
events. The recorded group leader is the keeper, not the command shell's PID.
The fixture queries its actual PGID with `ps`, not `$PPID`, so reparenting after
keeper loss cannot redirect cleanup. The supervisor signals only recorded groups,
not potentially recycled descendant PIDs, and rejects group IDs of 0 or 1. A
focused regression kills the keeper before PID publication and checks that the
surviving member still records its original group.

Apply the exact handoff patch, then rerun the same tracked tests:

```sh
git -C /tmp/opencode-shutdown-host apply "$PWD/tests/e2e/background-tasks/opencode-shutdown.patch"
OPENCODE_E2E_SOURCE=/tmp/opencode-shutdown-host bun run --cwd tests/e2e e2e:background-tasks:shutdown
bun run test --filter=@macarons/background-tasks
bun run typecheck --filter=@macarons/background-tasks
bun run lint --filter=@macarons/background-tasks
bun run --cwd tests/e2e e2e:background-tasks
```

Also run the upstream invariants from the host's `packages/opencode` directory:

```sh
bun test --timeout 30000 test/project/instance.test.ts test/effect/instance-state.test.ts test/project/instance-bootstrap.test.ts test/plugin/loader-shared.test.ts test/cli/tui/thread.test.ts
bun typecheck
```

The new gating CI job **Background shutdown (patched real host)** provisions
this exact source and patch. It does not replace the existing stock-binary
E2E suites. The shutdown command fails rather than silently skips when the
source checkout or Linux supervision is unavailable. On a version bump,
deliberately update the source SHA and revalidate the patch/contract; do not
silently keep certifying the old source against a new binary pin.

## What the regression exercises

The outer Bun test starts the unmodified real CLI entrypoint on a PTY. A local
fixture plugin starts one TERM-resistant task tree in each of two independent
plugin instances. It initializes the second cached directory through the real
worker's in-process SDK transport. Both instances must report the same host PID
and different directory keys. Both trees retain captured pipes and announce
readiness only after installing their TERM traps.

The supervisor types `/exit`, then awaits actual host exit. This executes
`cli/cmd/tui.ts` -> the real worker shutdown RPC -> `InstanceRuntime` ->
`InstanceStore` -> the real plugin finalizers, under the unchanged five-second
timeout. The test verifies the source SHA and that the caller, worker, timeout,
and dependency lockfile have no diff. No simulated sequential-disposal loop or
copied shutdown RPC is used.

Both disposers must start within one second of each other, complete the
three-second escalation, and finish before normal host exit inside the shared
budget. Before any supervisor signal, `/proc` must show no executing member of
either original process group. Zombies awaiting init reaping count as stopped.
The second case places an earlier hook in each instance that waits for the
task disposer to begin, independently exercising concurrent plugin teardown.

The SDK used by background-tasks is fake, its state-file channel is disabled,
and notifications/toasts are off. The actual host loads only the local fixture,
with isolated HOME/XDG/auth and no inherited credentials. A configured inert
loopback model avoids the first-run provider dialog; no model prompt is sent.
Config-directory dependencies resolve locally to the pinned source, and model
fetching/default plugins/auto-update are disabled.

The focused plugin test for #271 separately disposes only one of two actively
running instances. Beyond the escalation interval, the first tree must be
stopped and the peer must remain running and accept a new task. Existing host
tests cover scoped disposal/reload, stale cache identity, and global-dispose
deduplication.

## Handoff status

- Reproduced both failures against the actual unpatched `v1.18.14` TUI exit.
  Before the #233 keeper change (plugin baseline `0506525`), the ordinary case
  left the second tree alive and the earlier-hook case left both trees alive.
  Repeated after integrating #233 (`40f4dc8`): the ordinary case still completes
  only one disposer, and the earlier-hook case starts none. The keeper leaves
  no executing group members after exit in these runs, but does not satisfy the
  disposer start/completion assertions. Parent-disconnect cleanup is not proof
  of awaited normal shutdown.
- With the two-line host patch and the current keeper, both real-host cases
  pass: disposers start within 3 ms, close after about 3004 ms, and leave no
  executing group members before outer cleanup. Host exit occurs about 3.1 s
  after disposal begins, inside the unchanged five-second shared budget.
- All 63 focused upstream lifecycle tests and the host typecheck pass.
- **Release/merge prerequisite:** land the equivalent change upstream or
  explicitly distribute a host build containing this patch, then record its
  immutable revision/version and rerun this contract against that supported
  host. Update the OpenCode pin/checksums through the normal release process
  once a fixed release is available. Until then #271 remains an upstream-blocked
  release risk, not a solved property of stock `1.18.14`.

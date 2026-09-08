# T8 — Type the TUI test harness against real SDK/plugin types

`from_finding: F7` · `size: M` · `dependencies: T7 (edits the same file; land T7 first)`

## background

This repo (`opencode-persist-permissions`) is an OpenCode plugin. Its TUI half
(`src/tui.tsx`, exporting `tui`) is exercised by `test/tui.test.ts` through a
hand-rolled mock of the OpenCode TUI plugin API (`makeApi`), currently returned
`as any`. The plugin *implementation* is typechecked against the real
`TuiPlugin` type, so drift in production is caught at compile time — but the
**mock** can drift freely from the real API: if the SDK reshapes
`PermissionRequest`, the `permission.asked`/`permission.replied` event
properties, `DialogPrompt` props, or the `permission.reply` call, every test
keeps passing against a stale mock while the feature breaks in the field.

This ticket types the harness against the real types wherever that is cheap,
so structural drift in the touched surface fails `bun run typecheck`. Verified
facts about the dependency types (from `node_modules`, `@opencode-ai/plugin`
1.17.x):

- `@opencode-ai/plugin/tui` exports `TuiPlugin` (with
  `Parameters<TuiPlugin>[0]` being the full `TuiPluginApi`) and
  `TuiDialogPromptProps` (`{title, description?, placeholder?, value?, busy?,
  busyText?, onConfirm?, onCancel?}` — note `onConfirm`/`onCancel` are
  **optional**).
- `@opencode-ai/sdk/v2` exports `PermissionRequest` (`{id, sessionID,
  permission, patterns, metadata, always, tool?}`) and the `Event` union,
  whose members include `{type: "permission.asked", properties: {…same fields
  as PermissionRequest…}}` and `{type: "permission.replied", properties:
  {sessionID, requestID, reply: "once" | "always" | "reject"}}`.
- `TuiPluginApi["state"]["session"]["permission"]` is
  `(sessionID: string) => ReadonlyArray<PermissionRequest>`.
- `TuiPluginApi["route"]["current"]` is a union that includes
  `{name: "session", params: {sessionID: string, prompt?: unknown}}`.
- The real `Session` type (return of `state.session.get`) has many required
  fields; the mock deliberately keeps a structural stub there.

Runtime is Bun; `bun run typecheck` runs strict `tsc --noEmit` over `src` and
`test`.

## invariants

- **Runtime behavior of every test is unchanged.** This is a types-only
  refactor of the harness plus fixture typing; assertions, control flow, and
  the mock's dialog/close semantics (including `replace` firing the previous
  dialog's `onClose`) stay byte-for-byte where not shown below.
- No production file changes (`src/` untouched).
- Exactly **one** escape-hatch cast where the partial mock is handed to the
  real plugin signature (`as unknown as Parameters<TuiPlugin>[0]`); no other
  `as any` on the api object itself.
- Ticket T7 added tests to this file that use `harness.dialog()!.onConfirm(…)`,
  `.value`, and `request({...})` overrides — they must compile and pass
  unchanged.

## change

All edits in `test/tui.test.ts`.

### 1. Imports and derived types

Replace the current import of `tui` at the top of the file with this block
(keeping the existing `bun:test`, `fs`, `os`, `path` imports):

```ts
import type { TuiDialogPromptProps, TuiPlugin } from "@opencode-ai/plugin/tui"
import type { Event, PermissionRequest } from "@opencode-ai/sdk/v2"
import { tui } from "../src/tui"

type Api = Parameters<TuiPlugin>[0]
type Toast = Parameters<Api["ui"]["toast"]>[0]
type AskedProperties = Extract<Event, { type: "permission.asked" }>["properties"]
type RepliedProperties = Extract<Event, { type: "permission.replied" }>["properties"]
// The host's DialogPrompt props with the handlers the tests always drive made
// required, so call sites don't need non-null assertions on every line.
type CapturedPrompt = TuiDialogPromptProps & { onConfirm: (value: string) => void; onCancel: () => void }
```

### 2. Type the request factory

Replace the existing `request` function with:

```ts
function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "per_1",
    sessionID: "ses_1",
    permission: "bash",
    patterns: ["docker compose up -d"],
    always: ["docker compose up *"],
    metadata: {},
    ...overrides,
  }
}
```

### 3. Retype `makeApi`

Replace the whole `makeApi` function with the version below. It is the same
mock, with: a `TouchedApi` type describing the slice of the real API the
plugin uses; `satisfies TouchedApi` on the literal; typed internal arrays; and
a single documented cast on the returned `api`.

```ts
// The slice of TuiPluginApi the plugin actually touches, referencing the real
// plugin/SDK types wherever cheap so structural drift in this surface fails
// `bun run typecheck` instead of silently passing against a stale mock.
// session.get and client.permission.reply are structural stubs: the real
// Session and RequestResult types carry many fields irrelevant here.
type TouchedApi = {
  state: {
    path: Api["state"]["path"]
    session: {
      permission: Api["state"]["session"]["permission"]
      get: (sessionID: string) => { id: string; directory: string } | undefined
    }
  }
  route: { current: Api["route"]["current"] }
  ui: {
    toast: Api["ui"]["toast"]
    DialogPrompt: (props: TuiDialogPromptProps) => null
    dialog: { replace: Api["ui"]["dialog"]["replace"]; clear: Api["ui"]["dialog"]["clear"] }
  }
  keymap: { registerLayer: (layer: Record<string, unknown>) => void }
  slots: { register: (plugin: Record<string, unknown>) => void }
  theme: { current: { text: unknown; textMuted: unknown } }
  event: { on: (type: string, handler: (event: never) => void) => () => void }
  client: {
    permission: {
      reply: (params: {
        requestID: string
        reply?: "once" | "always" | "reject"
        directory?: string
      }) => Promise<{ error?: unknown; data?: unknown }>
    }
  }
}

// Mimics the slice of TuiPluginApi the plugin touches. Dialogs are captured so
// tests can drive DialogPrompt's onConfirm / the stack's onClose like a user.
function makeApi(input: { requests?: PermissionRequest[]; worktree?: string; replyError?: unknown } = {}) {
  const requests = input.requests ?? [request()]
  const toasts: Toast[] = []
  const replies: Record<string, unknown>[] = []
  const layers: Record<string, any>[] = []
  const slotPlugins: Record<string, any>[] = []
  const handlers = new Map<string, ((event: never) => void)[]>()
  let dialogProps: CapturedPrompt | undefined
  let onClose: (() => void) | undefined

  const api = {
    state: {
      path: { worktree: input.worktree ?? root, directory: root, state: "", config: "" },
      session: {
        permission: (sessionID: string) => requests.filter((item) => item.sessionID === sessionID),
        get: (sessionID: string) => ({ id: sessionID, directory: root }),
      },
    },
    route: { current: { name: "session" as const, params: { sessionID: "ses_1" } } },
    ui: {
      toast: (toast: Toast) => {
        toasts.push(toast)
      },
      DialogPrompt: (props: TuiDialogPromptProps) => {
        dialogProps = props as CapturedPrompt
        return null
      },
      dialog: {
        replace: (render: () => unknown, close?: () => void) => {
          // The host fires the replaced dialog's onClose; the plugin must not
          // treat that as a cancel of the next step.
          onClose?.()
          onClose = close
          render()
        },
        clear: () => {
          const close = onClose
          onClose = undefined
          close?.()
        },
      },
    },
    keymap: {
      registerLayer: (layer: Record<string, unknown>) => {
        layers.push(layer)
      },
    },
    slots: {
      register: (plugin: Record<string, unknown>) => {
        slotPlugins.push(plugin)
      },
    },
    theme: { current: { text: {}, textMuted: {} } },
    event: {
      on: (type: string, handler: (event: never) => void) => {
        handlers.set(type, [...(handlers.get(type) ?? []), handler])
        return () => {}
      },
    },
    client: {
      permission: {
        reply: async (params: { requestID: string; reply?: "once" | "always" | "reject"; directory?: string }) => {
          replies.push(params)
          return input.replyError ? { error: input.replyError } : { data: undefined }
        },
      },
    },
  } satisfies TouchedApi

  return {
    // The mock covers only the touched slice; one cast bridges it to the full
    // plugin signature.
    api: api as unknown as Api,
    toasts,
    replies,
    layers,
    slotPlugins,
    emit: (type: string, event: unknown) => handlers.get(type)?.forEach((handler) => handler(event as never)),
    dialog: () => dialogProps,
    resetDialog: () => {
      dialogProps = undefined
    },
  }
}
```

If `satisfies` reports a mismatch on `ui.dialog.replace` because the mock's
`render` parameter is `() => unknown` while the real one returns a JSX
element: that is expected to compile (parameter contravariance) — do not
change it. If any *other* member fails `satisfies`, the real API type differs
from this ticket's description: align the mock member to the real type rather
than loosening `TouchedApi`.

### 4. Type the event fixtures

In the `describe("persistence toast for host always-approvals", ...)` block,
replace `askedEvent` and `repliedEvent` with:

```ts
  const askedEvent = (overrides: Partial<AskedProperties> = {}): { properties: AskedProperties } => ({
    properties: {
      id: "per_1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["git status"],
      always: ["git status *"],
      metadata: {},
      ...overrides,
    },
  })
  const repliedEvent = (
    reply: RepliedProperties["reply"],
    requestID = "per_1",
  ): { properties: RepliedProperties } => ({
    properties: { sessionID: "ses_1", requestID, reply },
  })
```

(Existing call sites pass `"always"`, `"once"`, `"reject"` — all members of
the real union — and property overrides that are valid `AskedProperties`; they
compile unchanged.)

### 5. `loadCommand` stays as-is

`loadCommand` already passes `harness.api` to `tui(...)`; with `harness.api`
now typed as `Api` the call is fully typed. Leave the `{} as any` meta
argument alone (the real `TuiPluginMeta` has required fields irrelevant to
these tests).

## files_in_scope

- `test/tui.test.ts` (only file)

## do_not_touch

- `src/index.ts`, `src/tui.tsx`
- All other test files, `README.md`, `package.json`, `tsconfig.json`
- Test bodies/assertions — only the harness, factory, and fixture builders
  shown above change.

## acceptance_criteria

- `bun test` passes with the identical test count as before this ticket.
- `bun run typecheck` passes.
- `test/tui.test.ts` contains no `api as any` — the only cast on the api
  object is the single `as unknown as Api` in `makeApi`'s return.
- Sanity drift-check (manual, then revert): renaming `requestID` to `id` in
  the `repliedEvent` fixture makes `bun run typecheck` fail.

## tests

- Must still pass: every test in `test/tui.test.ts` (including those added by
  T7), unchanged in behavior and count; all other suites.
- No new tests — this ticket moves the mock's correctness burden from runtime
  faith to the typechecker.

## non_goals

- No behavioral verification of the mock against the real TUI host (the
  repo's `.claude/skills/verify` tmux + fake-LLM recipe covers end-to-end
  behavior; the mock's `dialog.replace`-fires-previous-`onClose` semantics
  remain an assumption documented in its comment).
- No typing of `state.session.get`'s return beyond the structural stub.
- No changes to `test/sdk-contract.test.ts` (its two compile-time guards for
  the server half remain as they are).

# T3 — Cross-half agreement fixtures for "what gets persisted"

`from_finding: F1` · `size: M` · `dependencies: none`

## background

This repo (`opencode-persist-permissions`) is an OpenCode plugin with two
production files that deliberately duplicate their core logic (each must stay a
self-contained single file — a documented invariant):

- `src/index.ts` — server half. Exports `PersistPermissionsPlugin`, an async
  factory returning hooks. Its `event` hook receives
  `{event: {type, properties}}`. On `permission.asked` it records the request;
  on `permission.replied` with reply `"always"` it computes the **narrowest
  interpretation** of the approval and writes allow rules to
  `<root>/.opencode/permissions.local.json`. "Narrowest" means: persist the
  request's `always` patterns verbatim, except a blanket `"*"` (which OpenCode
  treats as session-scoped) is replaced by the request's concrete `patterns`;
  results are deduplicated.
- `src/tui.tsx` — TUI half. Exports `tui`, an async function taking a TUI API
  object. It computes the same "what would be persisted" answer in **two more
  places**: (a) `suggestedPatterns` — what the edit dialog pre-fills, one
  dialog step per pattern; (b) the notify handler — on `permission.asked` it
  computes `saveable` (same narrowing, minus already-allowed patterns) and on a
  user `permission.replied`/`"always"` it toasts
  `Saved <patterns> to permissions.local.json — persists across sessions.`

These three computations are hand-mirrored copies. Nothing currently asserts
they agree. This ticket adds a fixture suite that drives all three through
their public surfaces with identical inputs and asserts identical outputs, plus
pins the one **intentional divergence**: when a request's `always` list is
empty (OpenCode itself would remember nothing), the server persists nothing and
the toast stays silent, but the edit dialog falls back to offering the concrete
`patterns` so the user can opt in by hand — and the flow then replies `"once"`,
never `"always"`.

Mechanics you need to know (all verified against the current code):

- The server plugin factory takes `{client, directory, worktree, project,
  serverUrl, experimental_workspace, $}`. The store lands at
  `<worktree>/.opencode/permissions.local.json`.
- The TUI `tui(api, options, meta)` uses: `api.state.path`
  (`{worktree, directory, state, config}`), `api.state.session.permission(id)`
  (pending requests; the flow acts on index `[0]`),
  `api.state.session.get(id)` (needs `.directory`), `api.route.current`
  (must be `{name: "session", params: {sessionID}}`), `api.ui.toast`,
  `api.ui.DialogPrompt(props)`, `api.ui.dialog.replace(render, onClose)` /
  `api.ui.dialog.clear()`, `api.keymap.registerLayer({commands, bindings})`
  (the edit flow's `run` function is `commands[0].run`), `api.slots.register`,
  `api.theme.current.text/.textMuted`, `api.event.on(type, handler)`, and
  `api.client.permission.reply({requestID, reply, directory})` which resolves
  `{error?}`.
- The TUI notify handler reads the store **asynchronously** on
  `permission.asked` — tests must wait ~25ms after emitting `asked` before
  emitting `replied` (the existing `test/tui.test.ts` does the same).
- The dialog flow: `run()` opens one `DialogPrompt` per suggested pattern.
  The host `DialogPrompt` props include `value` (prefill) and `onConfirm`.
  After each `onConfirm`, yield one macrotask (`setTimeout 0`) so the plugin's
  awaited promise advances and the next dialog renders.

Runtime is Bun (`bun test`).

## invariants

- **No production changes.** This ticket only adds one test file.
- The fixture expectations below encode current, correct behavior. If a
  fixture fails, report it — do not adjust production code or the expectation.

## change

Create `test/cross-half-contract.test.ts` with exactly this content:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PersistPermissionsPlugin } from "../src/index"
import { tui } from "../src/tui"

/**
 * Cross-half contract: the server half's narrowest()+persist, the TUI edit
 * dialog's suggestions, and the TUI notify toast each compute "what does an
 * 'always' approval persist" in independent hand-mirrored code. This suite
 * drives all three through their public surfaces with the same fixtures and
 * asserts they agree, so skewing one copy fails here instead of shipping.
 */

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cross-half-"))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const storeFile = () => path.join(root, ".opencode", "permissions.local.json")
const readStore = async () => JSON.parse(await fs.readFile(storeFile(), "utf8"))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

const savedMessage = (patterns: string[]) =>
  `Saved ${patterns.join(", ")} to permissions.local.json — persists across sessions.`

type Fixture = {
  name: string
  permission: string
  patterns: string[]
  always: string[]
  persisted: string[] // the answer all three surfaces must agree on
}

const FIXTURES: Fixture[] = [
  {
    name: "bash prefix",
    permission: "bash",
    patterns: ["git status --short"],
    always: ["git status *"],
    persisted: ["git status *"],
  },
  {
    name: "blanket '*' narrows to the concrete pattern",
    permission: "edit",
    patterns: ["src/app.ts"],
    always: ["*"],
    persisted: ["src/app.ts"],
  },
  {
    name: "multiple patterns dedupe",
    permission: "edit",
    patterns: ["a.ts", "b.ts", "a.ts"],
    always: ["*"],
    persisted: ["a.ts", "b.ts"],
  },
  {
    name: "explicit '*' request stays '*' (nothing narrower exists)",
    permission: "codemode_execute",
    patterns: ["*"],
    always: ["*"],
    persisted: ["*"],
  },
  {
    name: "concrete always-set is persisted verbatim",
    permission: "external_directory",
    patterns: ["/tmp/x/file"],
    always: ["/tmp/x/*"],
    persisted: ["/tmp/x/*"],
  },
]

// --- server-half harness -----------------------------------------------

async function loadServer() {
  const client = {
    app: { log: async () => ({}) },
    postSessionIdPermissionsPermissionId: async () => ({ data: true }),
  }
  return PersistPermissionsPlugin({
    client: client as any,
    directory: root,
    worktree: root,
    project: {} as any,
    serverUrl: new URL("http://localhost:4096"),
    experimental_workspace: { register() {} },
    $: {} as any,
  })
}

const askedEvent = (f: Pick<Fixture, "permission" | "patterns" | "always">) =>
  ({
    event: {
      type: "permission.asked",
      properties: {
        id: "per_1",
        sessionID: "ses_1",
        permission: f.permission,
        patterns: f.patterns,
        always: f.always,
        metadata: {},
      },
    },
  }) as any

const repliedAlways = () =>
  ({
    event: {
      type: "permission.replied",
      properties: { sessionID: "ses_1", requestID: "per_1", reply: "always" },
    },
  }) as any

// --- TUI-half harness ----------------------------------------------------

function makeTuiHarness(requests: Record<string, unknown>[]) {
  const toasts: { variant?: string; message: string }[] = []
  const replies: Record<string, unknown>[] = []
  const layers: Record<string, any>[] = []
  const handlers = new Map<string, ((event: unknown) => void)[]>()
  let dialogProps: Record<string, any> | undefined
  let onClose: (() => void) | undefined

  const api = {
    state: {
      path: { worktree: root, directory: root, state: "", config: "" },
      session: {
        permission: (sessionID: string) => requests.filter((item) => item.sessionID === sessionID),
        get: (sessionID: string) => ({ id: sessionID, directory: root }),
      },
    },
    route: { current: { name: "session", params: { sessionID: "ses_1" } } },
    ui: {
      toast: (toast: { variant?: string; message: string }) => toasts.push(toast),
      DialogPrompt: (props: Record<string, unknown>) => {
        dialogProps = props
        return null
      },
      dialog: {
        replace: (render: () => unknown, close?: () => void) => {
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
    keymap: { registerLayer: (layer: Record<string, unknown>) => layers.push(layer) },
    slots: { register: () => {} },
    theme: { current: { text: {}, textMuted: {} } },
    event: {
      on: (type: string, handler: (event: unknown) => void) => {
        handlers.set(type, [...(handlers.get(type) ?? []), handler])
        return () => {}
      },
    },
    client: {
      permission: {
        reply: async (params: Record<string, unknown>) => {
          replies.push(params)
          return { data: undefined }
        },
      },
    },
  }

  return {
    api: api as any,
    toasts,
    replies,
    layers,
    emit: (type: string, event: unknown) => handlers.get(type)?.forEach((handler) => handler(event)),
    dialog: () => dialogProps,
  }
}

const tuiRequest = (f: Pick<Fixture, "permission" | "patterns" | "always">) => ({
  id: "per_1",
  sessionID: "ses_1",
  permission: f.permission,
  patterns: f.patterns,
  always: f.always,
  metadata: {},
})

// --- the contract ---------------------------------------------------------

for (const f of FIXTURES) {
  describe(f.name, () => {
    test("server half persists exactly these patterns", async () => {
      const hooks = await loadServer()
      await hooks.event!(askedEvent(f))
      await hooks.event!(repliedAlways())
      const store = await readStore()
      expect(store.permission[f.permission]).toEqual(
        Object.fromEntries(f.persisted.map((pattern) => [pattern, "allow"])),
      )
    })

    test("TUI toast reports exactly these patterns", async () => {
      const harness = makeTuiHarness([])
      await tui(harness.api, undefined, {} as any)
      harness.emit("permission.asked", { properties: tuiRequest(f) })
      await settle()
      harness.emit("permission.replied", {
        properties: { sessionID: "ses_1", requestID: "per_1", reply: "always" },
      })
      const info = harness.toasts.find((toast) => toast.variant === "info")
      expect(info?.message).toBe(savedMessage(f.persisted))
    })

    test("TUI edit dialog offers exactly these patterns, and confirming them writes the same rules", async () => {
      const harness = makeTuiHarness([tuiRequest(f)])
      await tui(harness.api, undefined, {} as any)
      const run = harness.layers[0].commands[0].run as () => Promise<void>

      const done = run()
      const offered: string[] = []
      for (let i = 0; i < f.persisted.length; i++) {
        await tick()
        const dialog = harness.dialog()!
        offered.push(dialog.value as string)
        dialog.onConfirm(dialog.value)
      }
      await done

      expect(offered).toEqual(f.persisted)
      const store = await readStore()
      expect(store.permission[f.permission]).toEqual(
        Object.fromEntries(f.persisted.map((pattern) => [pattern, "allow"])),
      )
    })
  })
}

// --- the one intentional divergence ----------------------------------------

describe("empty always-set (OpenCode itself would remember nothing)", () => {
  const fixture = { permission: "bash", patterns: ["git status"], always: [] as string[] }

  test("server half persists nothing", async () => {
    const hooks = await loadServer()
    await hooks.event!(askedEvent(fixture))
    await hooks.event!(repliedAlways())
    expect(fs.access(storeFile())).rejects.toThrow()
  })

  test("TUI toast stays silent", async () => {
    const harness = makeTuiHarness([])
    await tui(harness.api, undefined, {} as any)
    harness.emit("permission.asked", { properties: tuiRequest(fixture) })
    await settle()
    harness.emit("permission.replied", {
      properties: { sessionID: "ses_1", requestID: "per_1", reply: "always" },
    })
    expect(harness.toasts).toHaveLength(0)
  })

  test("TUI dialog falls back to the concrete patterns and replies 'once', never 'always'", async () => {
    const harness = makeTuiHarness([tuiRequest(fixture)])
    await tui(harness.api, undefined, {} as any)
    const run = harness.layers[0].commands[0].run as () => Promise<void>

    const done = run()
    await tick()
    expect(harness.dialog()!.value).toBe("git status")
    harness.dialog()!.onConfirm("git status")
    await done

    const store = await readStore()
    expect(store.permission.bash).toEqual({ "git status": "allow" })
    expect(harness.replies).toHaveLength(1)
    expect(harness.replies[0].reply).toBe("once")
  })
})
```

## files_in_scope

- `test/cross-half-contract.test.ts` (new — the only file this ticket touches)

## do_not_touch

- `src/index.ts`, `src/tui.tsx`
- All existing test files, `README.md`, `package.json`, `tsconfig.json`

## acceptance_criteria

- `bun test` passes with the new suite (5 fixtures × 3 surfaces + 3 divergence
  tests = 18 new tests).
- `bun run typecheck` passes.
- `git diff` shows no changes outside the new test file.

## tests

- Must still pass: all existing tests.
- New: `test/cross-half-contract.test.ts` exactly as specified.

## dependencies

None. (Listed after T2 in the index for review order only.)

## non_goals

- No deduplication of the mirrored logic (documented single-file invariant).
- No changes to toast wording, dialog behavior, or persistence semantics.
- Fixtures with pre-seeded stores (already-allowed skipping) are out of scope —
  that interplay is covered by existing tests in `test/plugin.test.ts` and
  `test/tui.test.ts`.

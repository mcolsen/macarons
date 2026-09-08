import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createFilesystemLocalityResponder } from "@macarons/permission-rules"
import { tick, until } from "@macarons/plugin-test-harness"
import { describeGating, makeTuiApi } from "@macarons/plugin-test-harness/tui"
import type { TuiDialogPromptProps, TuiPlugin } from "@opencode-ai/plugin/tui"
import type { Event, PermissionRequest } from "@opencode-ai/sdk/v2"
import {
  discoverPrimaryRoot,
  discoverWorktreeRoot,
  legacyPermissionStoreFile,
  permissionStoreFile,
} from "../src/shared"
import { tui } from "../src/tui"

type Api = Parameters<TuiPlugin>[0]
type AskedProperties = Extract<
  Event,
  { type: "permission.asked" }
>["properties"]
type RepliedProperties = Extract<
  Event,
  { type: "permission.replied" }
>["properties"]
// The host's DialogPrompt props with the handlers the tests always drive made
// required, so call sites don't need non-null assertions on every line.
type CapturedPrompt = TuiDialogPromptProps & {
  onConfirm: (value: string) => void
  onCancel: () => void
}

let sandboxRoot: string
let root: string
let configDir: string
let stateDir: string
const activeHarnesses: ReturnType<typeof makeTuiApi>[] = []

beforeEach(async () => {
  // realpath: os.tmpdir() can sit behind a symlink (macOS /var → /private/var),
  // and the plugin hashes the canonical project root — expected store paths
  // computed from the raw root would name a different file.
  sandboxRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "persist-permissions-tui-")),
  )
  root = path.join(sandboxRoot, "project")
  configDir = path.join(sandboxRoot, "config")
  stateDir = path.join(sandboxRoot, "state")
  await Promise.all([fs.mkdir(root), fs.mkdir(configDir), fs.mkdir(stateDir)])
  await fs.mkdir(path.dirname(storeFile()), { recursive: true })
})

afterEach(async () => {
  for (const harness of activeHarnesses.splice(0)) await harness.dispose()
  await fs.rm(sandboxRoot, { recursive: true, force: true })
})

const storeFile = () => permissionStoreFile(configDir, root)
const legacyStoreFile = () => legacyPermissionStoreFile(root)

async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8"))
}

function request(
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
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

// The shared harness core plus the slice only this plugin touches: the
// dialog stack (captured so tests can drive DialogPrompt's onConfirm / the
// stack's onClose like a user), the pending-permission list, and the reply
// dispatcher with its error/wedged legs. The core supplies the recorders
// (toasts, layers, slotPlugins, handlers) and the host-shaped emit; drift
// against the real api type is checked at the cast where load passes the
// grafted mock to tui().
function makeApi(
  input: {
    requests?: PermissionRequest[]
    worktree?: string
    replyError?: unknown
    /** A reply call that never settles — a wedged host, not a rejected reply. */
    replyPending?: boolean
    routeSessionID?: string
    parents?: Record<string, string>
    version?: string | null
    baseUrl?: string | null
    sharedFilesystem?: boolean
    paths?: {
      worktree: string
      directory: string
      state: string
      config: string
    }
  } = {},
) {
  const requests = input.requests ?? [request()]
  const parents = input.parents ?? {}
  const replies: Record<string, unknown>[] = []
  let dialogProps: CapturedPrompt | undefined
  let onClose: (() => void) | undefined

  const base = makeTuiApi({
    version: input.version,
    baseUrl: input.baseUrl,
    routeSessionID: input.routeSessionID,
    paths: input.paths ?? {
      worktree: input.worktree ?? root,
      directory: root,
      state: stateDir,
      config: configDir,
    },
  })
  const locality = createFilesystemLocalityResponder({
    service: "persist-permissions",
    paths: async () => {
      const { config, worktree, directory } = base.api.state.path
      const projectRoot = worktree && worktree !== "/" ? worktree : directory
      const storeDir = path.dirname(permissionStoreFile(config, projectRoot))
      await fs.mkdir(storeDir, { recursive: true, mode: 0o700 })
      return [config, storeDir, projectRoot]
    },
  })
  base.api.client.tui = {
    publish: async (payload: { body: unknown }) => {
      if (input.sharedFilesystem === false)
        return { error: "filesystem proof unavailable" }
      await locality.handle(payload.body)
      return { data: true }
    },
  }
  base.api.lifecycle.onDispose(() => locality.dispose())
  activeHarnesses.push(base)

  base.api.state.session = {
    permission: (sessionID: string) =>
      requests.filter((item) => item.sessionID === sessionID),
    get: (sessionID: string) => ({
      id: sessionID,
      directory: root,
      parentID: parents[sessionID],
    }),
  }
  Object.assign(base.api.ui, {
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
  })
  base.api.client.permission = {
    // The plugin passes an AbortSignal in the reply call's second parameter;
    // the mock ignores it (a host that ignores cancellation is the case the
    // reply timeout has to survive anyway).
    reply: async (params: {
      requestID: string
      reply?: "once" | "always" | "reject"
      directory?: string
    }) => {
      replies.push(params)
      if (input.replyPending) return new Promise<never>(() => {})
      return input.replyError
        ? { error: input.replyError }
        : { data: undefined }
    },
  }

  return {
    ...base,
    replies,
    listenerCount: () =>
      [...base.handlers.values()].reduce(
        (count, listeners) => count + listeners.length,
        0,
      ),
    dialog: () => dialogProps,
    resetDialog: () => {
      dialogProps = undefined
    },
  }
}

async function loadCommand(
  harness: ReturnType<typeof makeApi>,
  options?: Record<string, unknown>,
) {
  // The mock covers only the touched slice; one cast bridges it to the full
  // plugin signature.
  await tui(harness.api as unknown as Api, options, {} as any)
  const layer = harness.layers[0]
  expect(layer).toBeDefined()
  return layer!.commands[0]!.run as () => Promise<void>
}

// run() probes the store with real fs I/O before opening the edit dialog, so
// a single timer turn can lose that race on a loaded machine (seen as CI
// flakes). Wait for the dialog itself with the harness's wall-clock-bounded
// `until` (a tick-counted loop is only milliseconds on a fast machine and
// shrinks further under load, so it can expire before the store probe this
// waits on has finished); a genuinely missing dialog still fails, loudly, at
// the deadline. Between dialog steps, call harness.resetDialog() first — the
// captured props of the previous step would otherwise satisfy the wait.
const openDialog = (harness: ReturnType<typeof makeApi>) =>
  until(() => harness.dialog() !== undefined, {
    timeoutMs: 4_000,
    label: "edit dialog",
  })

// One complete store-resolution cycle (keying, migration, store read) before
// the flow under test, using the plugin's own edit command as the barrier: its
// dialog cannot open until the explicit openStore() has resolved. The tests
// below write the store from outside to stand in for the server half, and an
// asked-time snapshot still in flight when that write lands sees the rule
// already there, reads the request as one the server auto-approved, and
// correctly stays silent. Warming first leaves the snapshot only a file read to
// do, so the settle() before the write has a wide margin even on a loaded
// runner.
const warmStore = async (
  harness: ReturnType<typeof makeApi>,
  run: () => Promise<void>,
) => {
  harness.resetDialog()
  const done = run()
  await openDialog(harness)
  harness.dialog()!.onCancel()
  await done
  harness.resetDialog()
}

describeGating({
  // Registration is URL-independent; every store access requires a server proof.
  remoteBails: false,
  load: async (input) => {
    const harness = makeApi(input)
    await tui(harness.api as unknown as Api, undefined, {} as any)
    return {
      toasts: harness.toasts,
      // Registration means the full triple: the command layer, the hint slot,
      // and at least one event listener.
      registered:
        harness.layers.length === 1 &&
        harness.slotPlugins.length === 1 &&
        harness.listenerCount() > 0,
      inert:
        harness.layers.length === 0 &&
        harness.slotPlugins.length === 0 &&
        harness.listenerCount() === 0 &&
        harness.replies.length === 0,
    }
  },
})

describe("filesystem locality", () => {
  test("a reconnect during the reply cannot confirm a save for the new server", async () => {
    const harness = makeApi()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let sent = false
    harness.api.client.permission.reply = async () => {
      sent = true
      await held
      return { data: undefined }
    }
    const run = await loadCommand(harness)
    const done = run()
    try {
      await openDialog(harness)
      harness.dialog()!.onConfirm("docker compose up *")
      await until(() => sent)
      harness.emit("server.connected", {})
      release()
      await done
      expect(await fs.exists(storeFile())).toBe(true)
      expect(
        harness.toasts.some((toast) =>
          String(toast.message).startsWith("Saved "),
        ),
      ).toBe(false)
      expect(harness.toasts.at(-1)?.message).toContain(
        "unconfirmed for the current server",
      )
    } finally {
      release()
    }
  })

  test.each([
    "https://build-box.example:4096",
    "http://127.0.0.1:4096",
    "http://localhost:4096",
    "http://[::1]:4096",
    "http://opencode.internal",
    "",
    null,
  ])(
    "%s cannot persist or reply through matching writable paths",
    async (baseUrl) => {
      const before = (await fs.readdir(sandboxRoot, { recursive: true })).sort()
      const harness = makeApi({ baseUrl, sharedFilesystem: false })
      const run = await loadCommand(harness)
      harness.emit("permission.asked", request())
      await run()
      harness.emit("permission.replied", {
        requestID: "per_1",
        sessionID: "ses_1",
        reply: "always",
      })
      await tick()

      expect(harness.dialog()).toBeUndefined()
      expect(harness.replies).toEqual([])
      expect(
        (await fs.readdir(sandboxRoot, { recursive: true })).sort(),
      ).toEqual(before)
      expect(
        harness.toasts.some((toast) =>
          /Saved |Already covered/.test(String(toast.message)),
        ),
      ).toBe(false)
      expect(harness.toasts.at(-1)?.message).toContain(
        "Nothing was saved or approved",
      )
    },
  )

  test.each(["", "missing"])(
    "unverified paths (%s) cannot create a permission store",
    async (kind) => {
      const harness = makeApi({
        baseUrl: "http://localhost:4096",
        sharedFilesystem: false,
        paths: {
          config: kind ? path.join(sandboxRoot, "missing-config") : "",
          state: kind ? path.join(sandboxRoot, "missing-state") : "",
          worktree: kind ? path.join(sandboxRoot, "missing-project") : "",
          directory: kind ? path.join(sandboxRoot, "missing-project") : "",
        },
      })
      const run = await loadCommand(harness)
      await run()
      expect(harness.dialog()).toBeUndefined()
      expect(harness.replies).toEqual([])
      expect(await fs.exists(path.join(sandboxRoot, "missing-config"))).toBe(
        false,
      )
    },
  )

  test("an unrelated local save cannot confirm remote persistence", async () => {
    const harness = makeApi({
      baseUrl: "https://remote.example",
      sharedFilesystem: false,
    })
    await loadCommand(harness)
    harness.emit("permission.asked", request())
    await tick()
    await fs.writeFile(
      storeFile(),
      JSON.stringify({
        permission: { bash: { "docker compose up *": "allow" } },
      }),
    )
    harness.emit("permission.replied", {
      requestID: "per_1",
      sessionID: "ses_1",
      reply: "always",
    })
    await tick()
    expect(
      harness.toasts.some((toast) =>
        /Saved |Already covered/.test(String(toast.message)),
      ),
    ).toBe(false)
    expect(harness.replies).toEqual([])
  })

  test("a dialog cannot save or approve after losing shared filesystem access", async () => {
    const harness = makeApi()
    const run = await loadCommand(harness)
    const done = run()
    await openDialog(harness)
    harness.api.client.tui.publish = async () => ({
      error: "connection changed",
    })
    harness.dialog()!.onConfirm("docker compose up *")
    await done
    expect(await fs.exists(storeFile())).toBe(false)
    expect(harness.replies).toEqual([])
    expect(harness.toasts.at(-1)?.message).toContain(
      "Nothing was saved or approved",
    )
  })
})

describe("edit-scope-and-allow flow", () => {
  test("an agent-writable legacy store blocks editing until the user migrates it", async () => {
    await fs.mkdir(path.dirname(legacyStoreFile()), { recursive: true })
    await fs.writeFile(
      legacyStoreFile(),
      JSON.stringify({ permission: { bash: "allow" } }),
    )
    const harness = makeApi()
    const run = await loadCommand(harness)

    await run()

    expect(harness.dialog()).toBeUndefined()
    expect(harness.replies).toHaveLength(0)
    // The wording is the shared pipeline's, so both halves name the legacy
    // file the same way (see createStoreOpener).
    expect(
      harness.toasts.some((toast) =>
        String(toast.message).includes("is agent-writable and is no longer"),
      ),
    ).toBe(true)
  })

  test("every explicit invocation on a blocked store re-toasts the reason", async () => {
    await fs.mkdir(path.dirname(legacyStoreFile()), { recursive: true })
    await fs.writeFile(
      legacyStoreFile(),
      JSON.stringify({ permission: { bash: "allow" } }),
    )
    const harness = makeApi()
    const run = await loadCommand(harness)

    await run()
    await run()

    // An explicit user action deserves feedback every time; a silent no-op
    // would be indistinguishable from a dead keybinding. Once-per-cause is
    // for the passive event path only.
    expect(
      harness.toasts.filter((toast) =>
        String(toast.message).includes("is agent-writable and is no longer"),
      ),
    ).toHaveLength(2)
  })

  test("an unstat'able store path pauses the edit flow with an 'unreadable' warning and sends no reply", async () => {
    // pathExists returns undefined for a stat error that is not ENOENT. Writing
    // .opencode as a regular FILE makes fs.access on the legacy store
    // (<root>/.opencode/permissions.local.json) reject with ENOTDIR — a
    // deterministic, root-proof stat failure, unlike a chmod that no-ops as
    // root. The explicit edit invocation must pause, say the path is unreadable,
    // and never open a dialog or send a reply from a store it could not read.
    await fs.writeFile(path.join(root, ".opencode"), "x")
    const harness = makeApi()
    const run = await loadCommand(harness)

    const done = run()
    // Correct code pauses here without a dialog; the coalesce-to-false mutant
    // would fall through and open the edit dialog instead. Bounded-wait for
    // whichever happens first so the mutant fails on an assertion rather than a
    // timeout, then let run() settle either way.
    const unreadable = () =>
      harness.toasts.some((toast) =>
        String(toast.message).includes("a permission-store path is unreadable"),
      )
    const deadline = Date.now() + 4_000
    while (!harness.dialog() && !unreadable() && Date.now() < deadline)
      await tick()
    const openedDialog = harness.dialog() !== undefined
    harness.dialog()?.onCancel()
    await done

    expect(openedDialog).toBe(false)
    expect(harness.replies).toHaveLength(0)
    expect(unreadable()).toBe(true)
  })

  test("a config dir inside the project pauses the edit flow, re-warning on each explicit invocation", async () => {
    // createStoreKeyingResolver REFUSES (returns undefined, never null) when the
    // derived store path would sit inside the agent-writable project — the last
    // guard before the TUI half reads or writes trust data. The host's
    // api.state.path.config is the config source, so pointing it at
    // <root>/.config forces the refusal deterministically.
    await fs.mkdir(path.join(root, ".config"))
    const harness = makeApi({
      paths: {
        worktree: root,
        directory: root,
        state: stateDir,
        config: path.join(root, ".config"),
      },
    })
    const run = await loadCommand(harness)
    const notTrusted = () =>
      harness.toasts.filter(
        (toast) =>
          toast.variant === "warning" &&
          String(toast.message).includes("not trusted"),
      )

    // Explicit: the edit flow pauses with a "not trusted" warning — no dialog,
    // no reply into an untrusted store.
    await run()
    expect(harness.dialog()).toBeUndefined()
    expect(harness.replies).toHaveLength(0)
    expect(notTrusted()).toHaveLength(1)

    // An explicit user action deserves feedback every time; the once-per-cause
    // gate is for the passive event path only.
    await run()
    expect(notTrusted()).toHaveLength(2)

    // A PASSIVE read (the notify handler on a fresh prompt) is once-gated while
    // the cause is still broken: it does not stack another toast.
    harness.emit("permission.asked", request({ id: "per_2" }))
    await tick()
    await tick()
    expect(notTrusted()).toHaveLength(2)

    // Recovery: the host's config path resolves to a trusted location. The next
    // access re-derives cleanly (the repository-scope resolver never latched the
    // distrust), so the edit flow reaches the dialog, persists, and emits no
    // further "not trusted" toast.
    Object.assign(harness.api.state.path, { config: configDir })
    harness.emit("permission.asked", request({ id: "per_2" }))
    const done = run()
    await openDialog(harness)
    harness.dialog()!.onConfirm("docker compose up *")
    await done
    expect(notTrusted()).toHaveLength(2)
    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "docker compose up *": "allow" })
  })

  test("an invalid scope pauses the edit flow instead of defaulting", async () => {
    // Defaulting to "repository" would let this half migrate away — and
    // delete — a store a correctly-configured "worktree" server half is
    // actively using. Only an absent option may default.
    const harness = makeApi()
    const run = await loadCommand(harness, { scope: "bogus" })
    expect(
      harness.toasts.some((toast) =>
        String(toast.message).includes(
          '"scope" must be "repository" or "worktree"',
        ),
      ),
    ).toBe(true)

    await run()
    expect(harness.dialog()).toBeUndefined()
    expect(harness.replies).toHaveLength(0)
    expect(
      harness.toasts.some((toast) => String(toast.message).includes("paused")),
    ).toBe(true)
  })

  test("an unknown option key warns, so a typo'd scope cannot silently drift the halves apart", async () => {
    const harness = makeApi()
    await loadCommand(harness, { scpoe: "worktree" })
    expect(
      harness.toasts.some((toast) =>
        String(toast.message).includes('unknown plugin option "scpoe"'),
      ),
    ).toBe(true)
    // Unknown keys warn but never disable the plugin.
    expect(harness.layers).toHaveLength(1)
  })

  test("paths still syncing at load do not pause persistence for good", async () => {
    // The host fills api.state.path from a server round-trip that races
    // plugin activation; until it lands every field is an empty string.
    // Resolving the store path against those placeholders must not latch
    // "not trusted" for the TUI's lifetime.
    const harness = makeApi({
      paths: { worktree: "", directory: "", state: "", config: "" },
    })
    const run = await loadCommand(harness)

    await run()
    expect(harness.dialog()).toBeUndefined()
    expect(
      harness.toasts.some((toast) =>
        String(toast.message).includes("still syncing"),
      ),
    ).toBe(true)

    // The path store syncs (the host writes all fields in one batch); the
    // next access must resolve without a TUI restart.
    Object.assign(harness.api.state.path, {
      worktree: root,
      directory: root,
      state: stateDir,
      config: configDir,
    })
    const done = run()
    await openDialog(harness)
    harness.dialog()!.onConfirm("docker compose up *")
    await done

    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "docker compose up *": "allow" })
  })

  test("confirming the suggested bash prefix persists it and replies 'once'", async () => {
    const harness = makeApi()
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    expect(harness.dialog()!.value).toBe("docker compose up *")
    harness.dialog()!.onConfirm("docker compose up *")
    await done

    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "docker compose up *": "allow" })
    expect(harness.replies).toHaveLength(1)
    expect(harness.replies[0]!.reply).toBe("once")
    expect(harness.replies[0]!.requestID).toBe("per_1")
    const success = harness.toasts.find((toast) => toast.variant === "success")
    // The once reply is internal; the toast must describe persistence,
    // in the same wording as the host-prompt "always" path (see below).
    expect(success?.message).toBe(
      "Saved docker compose up * to this project's permission store — persists across sessions.",
    )
  })

  test("rewrites broad store modes without widening stricter ones under umask 022", async () => {
    if (process.platform === "win32") return
    const parent = path.dirname(storeFile())
    const previous = process.umask(0o022)
    try {
      await fs.writeFile(storeFile(), `{"permission":{}}\n`, { mode: 0o644 })
      await fs.chmod(parent, 0o755)
      const broadHarness = makeApi()
      const runBroad = await loadCommand(broadHarness)
      const broad = runBroad()
      await openDialog(broadHarness)
      broadHarness.dialog()!.onConfirm("docker compose up *")
      await broad
      expect((await fs.stat(storeFile())).mode & 0o777).toBe(0o600)
      expect((await fs.stat(parent)).mode & 0o777).toBe(0o700)

      await fs.chmod(storeFile(), 0o400)
      const strictHarness = makeApi({
        requests: [
          request({
            id: "per_2",
            patterns: ["git push origin main"],
            always: ["git push *"],
          }),
        ],
      })
      const runStrict = await loadCommand(strictHarness)
      const strict = runStrict()
      await openDialog(strictHarness)
      strictHarness.dialog()!.onConfirm("git push *")
      await strict
      expect((await fs.stat(storeFile())).mode & 0o777).toBe(0o400)
    } finally {
      process.umask(previous)
    }
  })

  test("narrowing the pattern persists the edit and replies 'once'", async () => {
    // OpenCode would remember "docker *" in-memory; the user narrows to
    // compose-only, so "always" must not be sent.
    const harness = makeApi({ requests: [request({ always: ["docker *"] })] })
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    expect(harness.dialog()!.value).toBe("docker *")
    harness.dialog()!.onConfirm("docker compose up *")
    await done

    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "docker compose up *": "allow" })
    expect(harness.replies[0]!.reply).toBe("once")
  })

  test("broadening the saved pattern still replies 'once'", async () => {
    const harness = makeApi()
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    harness.dialog()!.onConfirm("docker *")
    await done

    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "docker *": "allow" })
    expect(harness.replies[0]!.reply).toBe("once")
  })

  for (const action of ["ask", "deny"] as const) {
    test(`confirming an ordinary read preserves a saved ${action} carve-out`, async () => {
      await fs.writeFile(
        storeFile(),
        JSON.stringify({
          permission: { read: { "*": "allow", ".env*": action } },
        }),
      )
      const before = await fs.readFile(storeFile(), "utf8")
      const harness = makeApi({
        requests: [
          request({
            permission: "read",
            patterns: ["README.md"],
            always: ["*"],
          }),
        ],
      })
      const run = await loadCommand(harness)

      const done = run()
      await openDialog(harness)
      expect(harness.dialog()!.value).toBe("README.md")
      harness.dialog()!.onConfirm("README.md")
      await done

      expect(await fs.readFile(storeFile(), "utf8")).toBe(before)
      expect(harness.replies).toHaveLength(1)
      expect(harness.replies[0]!.reply).toBe("once")
    })
  }

  test("saving 'git ?' never grants the 'git *' remember-rule language", async () => {
    const harness = makeApi({
      requests: [request({ patterns: ["git a"], always: ["git *"] })],
    })
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    harness.dialog()!.onConfirm("git ?")
    await done

    expect((await readJson(storeFile())).permission.bash).toEqual({
      "git ?": "allow",
    })
    expect(harness.replies).toHaveLength(1)
    expect(harness.replies[0]!.reply).toBe("once")
  })

  test("a blanket '*' request offers the concrete pattern and replies 'once'", async () => {
    const harness = makeApi({
      requests: [
        request({
          permission: "edit",
          patterns: ["src/app.ts"],
          always: ["*"],
        }),
      ],
    })
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    expect(harness.dialog()!.value).toBe("src/app.ts")
    harness.dialog()!.onConfirm("src/*")
    await done

    const store = await readJson(storeFile())
    expect(store.permission.edit).toEqual({ "src/*": "allow" })
    // "src/*" does not cover the in-memory blanket "*", so no session grant.
    expect(harness.replies[0]!.reply).toBe("once")
  })

  test("multiple always-patterns are edited one dialog at a time", async () => {
    const harness = makeApi({
      requests: [
        request({
          permission: "external_directory",
          patterns: ["/tmp/a/*", "/tmp/b/*"],
          always: ["/tmp/a/*", "/tmp/b/*"],
        }),
      ],
    })
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    expect(harness.dialog()!.title).toContain("(1/2)")
    expect(harness.dialog()!.value).toBe("/tmp/a/*")
    harness.dialog()!.onConfirm("/tmp/a/*")
    harness.resetDialog()
    await openDialog(harness)
    expect(harness.dialog()!.title).toContain("(2/2)")
    harness.dialog()!.onConfirm("/tmp/b/sub/*")
    await done

    const store = await readJson(storeFile())
    expect(store.permission.external_directory).toEqual({
      "/tmp/a/*": "allow",
      "/tmp/b/sub/*": "allow",
    })
  })

  test("the dialog presents a persistent always-allow, not a one-time edit", async () => {
    // The host prompt defaults to "Allow once" and the plugin cannot see which
    // option is highlighted, so the dialog itself must state that confirming
    // persists: an always-allow title plus a description line under it.
    const harness = makeApi()
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    expect(harness.dialog()!.title).toBe('Always allow "bash"')
    expect(typeof harness.dialog()!.description).toBe("function")
    harness.api.ui.dialog.clear()
    await done

    expect(harness.replies).toHaveLength(0)
  })

  test("dismissing the dialog saves nothing and leaves the prompt alone", async () => {
    const harness = makeApi()
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    harness.api.ui.dialog.clear() // escape
    await done

    await expect(fs.access(storeFile())).rejects.toThrow()
    expect(harness.replies).toHaveLength(0)
  })

  test("an empty pattern cancels instead of persisting a match-nothing rule", async () => {
    const harness = makeApi()
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    harness.dialog()!.onConfirm("   ")
    await done

    await expect(fs.access(storeFile())).rejects.toThrow()
    expect(harness.replies).toHaveLength(0)
    expect(
      harness.toasts.some((toast) =>
        String(toast.message).includes("cancelled"),
      ),
    ).toBe(true)
  })

  test("without a pending permission the command only toasts", async () => {
    const harness = makeApi({ requests: [] })
    const run = await loadCommand(harness)

    await run()

    expect(harness.replies).toHaveLength(0)
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.variant).toBe("info")
  })

  test("a corrupt store aborts without replying, so the prompt stays answerable", async () => {
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(storeFile(), "{ not json")
    const harness = makeApi()
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    harness.dialog()!.onConfirm("docker *")
    await done

    expect(await fs.readFile(storeFile(), "utf8")).toBe("{ not json")
    expect(harness.replies).toHaveLength(0)
    expect(harness.toasts.some((toast) => toast.variant === "error")).toBe(true)
  })

  test("an unwritable store path toasts an error and leaves the prompt answerable", async () => {
    // The store path exists as a DIRECTORY, so writeStore's tmp-file rename fails.
    await fs.mkdir(storeFile(), { recursive: true })
    const harness = makeApi()
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    harness.dialog()!.onConfirm("docker compose up *")
    await done

    expect(harness.replies).toHaveLength(0)
    expect(
      harness.toasts.some(
        (toast) =>
          toast.variant === "error" &&
          String(toast.message).includes("Not saved"),
      ),
    ).toBe(true)
  })

  test("when the request was answered meanwhile, the rule is still saved", async () => {
    const harness = makeApi({ replyError: { name: "NotFoundError" } })
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    harness.dialog()!.onConfirm("docker compose up *")
    await done

    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "docker compose up *": "allow" })
    expect(
      harness.toasts.find((toast) => toast.variant === "warning")?.message,
    ).toBe(
      "Saved docker compose up * to this project's permission store — persists across sessions. The prompt could not be answered; it may already have been resolved.",
    )
  })

  test("a reply that never answers releases the flow instead of wedging the command", async () => {
    // Every cleanup step lives in a finally the await never reaches, so an
    // unbounded reply against a wedged host does not just lose one toast: it
    // leaves `editing` set, and run() bails on that flag BEFORE it can toast
    // anything — ctrl+o and the palette entry become silent no-ops for the
    // rest of the TUI session, with the dialog still on screen. The rule is
    // saved before the reply is sent, so only the prompt's fate is in doubt,
    // which is what the warning already says.
    const harness = makeApi({ replyPending: true })
    const run = await loadCommand(harness)

    const first = run()
    await openDialog(harness)
    harness.dialog()!.onConfirm("docker compose up *")
    await first

    expect(await readJson(storeFile())).toEqual({
      permission: { bash: { "docker compose up *": "allow" } },
    })
    expect(
      harness.toasts.find((toast) => toast.variant === "warning")?.message,
    ).toBe(
      "Saved docker compose up * to this project's permission store — persists across sessions. The prompt could not be answered; it may already have been resolved.",
    )

    // The flag was released: the command still works. Without the bound this
    // second invocation returns immediately, having done nothing at all.
    harness.resetDialog()
    const second = run()
    await openDialog(harness)
    harness.dialog()!.onCancel()
    await second
  }, 15_000)

  test("an unedited suggestion already covered by a broader rule is not re-persisted", async () => {
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(
      storeFile(),
      JSON.stringify({ permission: { bash: { "docker *": "allow" } } }),
    )
    const before = await fs.readFile(storeFile(), "utf8")
    const harness = makeApi()
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    // Confirm the pre-filled suggestion unchanged.
    harness.dialog()!.onConfirm("docker compose up *")
    await done

    expect(await fs.readFile(storeFile(), "utf8")).toBe(before)
    expect(harness.replies).toHaveLength(1)
    expect(harness.replies[0]!.reply).toBe("once")
    const success = harness.toasts.find((toast) => toast.variant === "success")
    expect(success?.message).toBe(
      "Already covered by this project's permission store — request approved.",
    )
  })

  test("an already-covered suggestion reports a reply failure without claiming it was saved", async () => {
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(
      storeFile(),
      JSON.stringify({ permission: { bash: { "docker *": "allow" } } }),
    )
    const before = await fs.readFile(storeFile(), "utf8")
    const harness = makeApi({ replyError: { name: "NotFoundError" } })
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    harness.dialog()!.onConfirm("docker compose up *")
    await done

    expect(await fs.readFile(storeFile(), "utf8")).toBe(before)
    expect(
      harness.toasts.find((toast) => toast.variant === "warning")?.message,
    ).toBe(
      "Already covered by this project's permission store. The prompt could not be answered; it may already have been resolved.",
    )
  })

  test("an unedited suggestion blocked by a later carve-out is still re-asserted", async () => {
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(
      storeFile(),
      JSON.stringify({
        permission: { bash: { "git *": "allow", "git push *": "ask" } },
      }),
    )
    const harness = makeApi({
      requests: [
        request({ patterns: ["git push origin main"], always: ["git push *"] }),
      ],
    })
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    expect(harness.dialog()!.value).toBe("git push *")
    harness.dialog()!.onConfirm("git push *")
    await done

    const store = await readJson(storeFile())
    // Last rule wins: the re-added allow must land after the ask carve-out.
    expect(Object.entries(store.permission.bash)).toEqual([
      ["git *", "allow"],
      ["git push *", "allow"],
    ])
    const success = harness.toasts.find((toast) => toast.variant === "success")
    expect(success?.message).toBe(
      "Saved git push * to this project's permission store — persists across sessions.",
    )
  })

  test("a user-typed pattern is appended even when a broader rule already covers it", async () => {
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(
      storeFile(),
      JSON.stringify({ permission: { bash: { "docker *": "allow" } } }),
    )
    const harness = makeApi()
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    // The suggestion was "docker compose up *"; the user types something else.
    harness.dialog()!.onConfirm("docker run *")
    await done

    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({
      "docker *": "allow",
      "docker run *": "allow",
    })
  })

  test("non-git '/' keys the trusted store from the session directory", async () => {
    const harness = makeApi({ worktree: "/" })
    const run = await loadCommand(harness)

    const done = run()
    await openDialog(harness)
    harness.dialog()!.onConfirm("docker compose up *")
    await done

    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "docker compose up *": "allow" })
  })
})

describe("sub-agent (child session) prompts", () => {
  // permission.asked for a request the plugin must learn about to reach its
  // (child) session — the host aggregates it into the parent view on screen.
  const askChild = (
    harness: ReturnType<typeof makeApi>,
    sessionID: string,
    overrides: Record<string, unknown> = {},
  ) =>
    harness.emit("permission.asked", {
      id: "per_child",
      sessionID,
      permission: "bash",
      patterns: ["ls test/"],
      always: ["ls *"],
      metadata: {},
      ...overrides,
    })

  test("a prompt from a sub-agent child session is edited while viewing the parent", async () => {
    // The bash prompt lives under the child session; the user is on the parent
    // route. Reading only the routed session used to toast "No pending…".
    const harness = makeApi({
      routeSessionID: "ses_parent",
      requests: [
        request({
          id: "per_child",
          sessionID: "ses_child",
          permission: "bash",
          patterns: ["ls test/"],
          always: ["ls *"],
        }),
      ],
      parents: { ses_child: "ses_parent" },
    })
    const run = await loadCommand(harness)
    askChild(harness, "ses_child")

    const done = run()
    await openDialog(harness)
    expect(harness.dialog()!.value).toBe("ls *")
    harness.dialog()!.onConfirm("ls *")
    await done

    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "ls *": "allow" })
    // The reply targets the child request, not the routed parent session.
    expect(harness.replies[0]!.requestID).toBe("per_child")
  })

  test("viewing the child session directly shows nothing, matching the host", async () => {
    // The host renders the parent (parentID-less) session and returns [] for a
    // child's own view; the command must not reach across into a sibling.
    const harness = makeApi({
      routeSessionID: "ses_child",
      requests: [request({ id: "per_child", sessionID: "ses_child" })],
      parents: { ses_child: "ses_parent" },
    })
    const run = await loadCommand(harness)
    askChild(harness, "ses_child")

    await run()

    expect(harness.replies).toHaveLength(0)
    expect(harness.toasts[0]!.variant).toBe("info")
  })

  test("a routed session's own prompt still wins over a later child's", async () => {
    // Two live prompts: the parent's own and a child's. The host sorts by
    // session id and shows the first; ses_parent < ses_z_child, so the parent's.
    const harness = makeApi({
      routeSessionID: "ses_parent",
      requests: [
        request({ id: "per_parent", sessionID: "ses_parent" }),
        request({
          id: "per_child",
          sessionID: "ses_z_child",
          permission: "bash",
          patterns: ["ls test/"],
          always: ["ls *"],
        }),
      ],
      parents: { ses_z_child: "ses_parent" },
    })
    const run = await loadCommand(harness)
    askChild(harness, "ses_z_child")

    const done = run()
    await openDialog(harness)
    // The parent request is the docker one from request(); confirm we edit it.
    expect(harness.dialog()!.value).toBe("docker compose up *")
    harness.dialog()!.onConfirm("docker compose up *")
    await done

    expect(harness.replies[0]!.requestID).toBe("per_parent")
  })
})

describe("command registration", () => {
  test("registers a palette command with the default keybinding", async () => {
    const harness = makeApi()
    await loadCommand(harness)

    const layer = harness.layers[0]
    expect(layer!.commands[0]!.name).toBe("persist_permissions.edit_scope")
    // "always allow" and not "approve": the palette entry must not read as a
    // way to amend the host prompt's currently-selected (often one-time) answer.
    expect(layer!.commands[0]!.title).toBe("Edit allow pattern & always allow")
    expect(layer!.bindings).toHaveLength(1)
    expect(layer!.bindings[0]!.key).toBe("ctrl+o,<leader>p")
  })

  test("the keybind option replaces the default; false and 'none' disable it", async () => {
    const custom = makeApi()
    await loadCommand(custom, { keybind: "ctrl+alt+a" })
    expect(custom.layers[0]!.bindings[0]!.key).toBe("ctrl+alt+a")

    const disabled = makeApi()
    await loadCommand(disabled, { keybind: false })
    expect(disabled.layers[0]!.bindings).toHaveLength(0)

    const none = makeApi()
    await loadCommand(none, { keybind: "none" })
    expect(none.layers[0]!.bindings).toHaveLength(0)
  })
})

describe("persistence toast for host always-approvals", () => {
  // Event payloads for the core's emit, which wraps them in the host's
  // `{ type, properties }` envelope.
  const askedEvent = (
    overrides: Partial<AskedProperties> = {},
  ): AskedProperties => ({
    id: "per_1",
    sessionID: "ses_1",
    permission: "bash",
    patterns: ["git status"],
    always: ["git status *"],
    metadata: {},
    ...overrides,
  })
  const repliedEvent = (
    reply: RepliedProperties["reply"],
    requestID = "per_1",
  ): RepliedProperties => ({ sessionID: "ses_1", requestID, reply })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25))
  // Bound the waits by WALL CLOCK, not by a tick count. The save toast now
  // waits on a confirmation poll that re-resolves keying (a real `git` spawn)
  // before its first store read, and a fixed number of setTimeout(0) turns is
  // a budget of milliseconds on a fast machine — the loop can exhaust itself
  // before a loaded CI runner has finished spawning git, which is exactly how
  // these three tests failed on CI while passing locally. The ceiling sits
  // above the plugin's own SAVE_CONFIRM_TIMEOUT_MS so a genuinely missing
  // toast still fails, just definitively rather than by outrunning the code.
  // Deliberately NON-throwing, unlike the harness's `until`: infoToast's
  // callers assert on the returned toast themselves, and the reach test below
  // builds its own keying diagnostic when the wait expires — a throw at the
  // deadline would preempt exactly that evidence.
  const waitFor = async (
    done: () => boolean | Promise<boolean>,
    ms = 4_000,
  ) => {
    const deadline = Date.now() + ms
    while (!(await done()) && Date.now() < deadline) await tick()
  }
  const infoToast = async (harness: ReturnType<typeof makeApi>) => {
    await waitFor(() =>
      harness.toasts.some((toast) => toast.variant === "info"),
    )
    return harness.toasts.find((toast) => toast.variant === "info")
  }
  // For count assertions after a COLD first ask: its chain pays path
  // resolution and migration probes, which can outrun settle() on a loaded
  // runner. This one throws (the harness `until`): a silent expiry would let
  // the test run on and fail at an assertion downstream of further emits,
  // muddying the diagnosis.
  const awaitToasts = (count: () => number, expected: number) =>
    until(() => count() >= expected, {
      timeoutMs: 4_000,
      label: `toast count >= ${expected}`,
    })
  // Stands in for the server half, which persists on the same replied event
  // this half is watching. The toast is an acknowledgment of THAT write — with
  // no server half writing anything, there is nothing to acknowledge.
  const serverPersists = async (
    permission: string,
    patterns: string[],
    file = storeFile(),
  ) => {
    const store = (await fs.exists(file))
      ? await readJson(file)
      : { permission: {} }
    store.permission[permission] = {
      ...(store.permission[permission] ?? {}),
      ...Object.fromEntries(patterns.map((pattern) => [pattern, "allow"])),
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(store))
  }

  // Hold only the confirmation delay, leaving real filesystem/proof deadlines
  // alone. Each queued callback is a barrier after a completed passive poll.
  const holdConfirmationPolls = () => {
    const pending: Array<() => void> = []
    const original = globalThis.setTimeout
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      ...input: Parameters<typeof setTimeout>
    ) => {
      const [callback, delay, ...args] = input
      if (delay !== 50) return original(callback, delay, ...args)
      pending.push(() => callback(...args))
      return original(() => {}, 0)
    }) as typeof setTimeout)
    return {
      wait: () =>
        until(() => pending.length > 0, { label: "confirmation poll" }),
      advance: () => pending.shift()!(),
      restore: () => {
        timer.mockRestore()
        for (const resume of pending.splice(0)) resume()
      },
    }
  }

  test.each([
    "saved",
    "reconnect",
    "dispose",
    "config",
    "directory",
    "worktree",
    "policy symlink",
    "store symlink",
    "reconnect during read",
    "config during read",
    "store symlink during read",
  ])("confirmation polls reuse one proof: %s", async (outcome) => {
    const harness = makeApi()
    await warmStore(harness, await loadCommand(harness))
    const publish = spyOn(harness.api.client.tui, "publish")
    const originalRead = fs.readFile
    const reads = spyOn(fs, "readFile")
    const polling = holdConfirmationPolls()
    try {
      harness.emit("permission.asked", askedEvent())
      const done = harness.handlers.get("permission.replied")![0]!({
        type: "permission.replied",
        properties: repliedEvent("always"),
      })
      await polling.wait()
      for (let i = 0; i < 2; i++) {
        polling.advance()
        await polling.wait()
      }
      // One asked-time snapshot plus three confirmation reads, but only one
      // fresh challenge/confirm/cleanup exchange for the entire confirmation.
      expect(
        reads.mock.calls.filter(([file]) => file === storeFile()),
      ).toHaveLength(4)
      const phases = () =>
        publish.mock.calls.map(
          ([payload]) =>
            (
              payload as { body: { properties: { command: string } } }
            ).body.properties.command.split(":")[2],
        )
      expect(phases()).toEqual([
        "probe",
        "confirm",
        "cleanup",
        "probe",
        "confirm",
        "cleanup",
      ])
      await fs.writeFile(
        storeFile(),
        JSON.stringify({ permission: { bash: { "git status *": "allow" } } }),
      )
      const invalidate = async () => {
        const kind = outcome.replace(" during read", "")
        if (kind === "reconnect") harness.emit("server.connected", {})
        else if (kind === "dispose") await harness.dispose()
        else if (["config", "directory", "worktree"].includes(kind))
          harness.api.state.path[kind] = path.join(sandboxRoot, "changed")
        else if (kind === "policy symlink") {
          const policyDir = path.dirname(storeFile())
          const moved = path.join(root, "untrusted-policy")
          await fs.rename(policyDir, moved)
          await fs.symlink(moved, policyDir, "dir")
        } else if (kind === "store symlink") {
          const moved = path.join(root, "untrusted-store.json")
          await fs.rename(storeFile(), moved)
          await fs.symlink(moved, storeFile())
        }
      }
      if (outcome.endsWith(" during read"))
        reads.mockImplementation((async (
          ...args: Parameters<typeof fs.readFile>
        ) => {
          const value = await originalRead(...args)
          if (args[0] === storeFile()) await invalidate()
          return value
        }) as typeof fs.readFile)
      else await invalidate()
      polling.advance()
      await done
      expect(phases()).toHaveLength(6)
      expect(harness.replies).toEqual([])
      if (outcome === "saved") {
        expect(harness.toasts.map((toast) => toast.message)).toEqual([
          "Saved git status * to this project's permission store — persists across sessions.",
        ])
      } else {
        expect(harness.toasts).toEqual([])
      }
    } finally {
      await harness.dispose()
      polling.restore()
      reads.mockRestore()
      publish.mockRestore()
    }
  })

  test.each(["corrupt store", "unreadable path", "paths syncing"])(
    "confirmation retries %s without repeating its proof",
    async (failure) => {
      const harness = makeApi()
      await warmStore(harness, await loadCommand(harness))
      const paths = { ...harness.api.state.path }
      const publish = spyOn(harness.api.client.tui, "publish")
      const originalRead = fs.readFile
      let snapshot = true
      const reads = spyOn(fs, "readFile").mockImplementation((async (
        ...args: Parameters<typeof fs.readFile>
      ) => {
        const value = await originalRead(...args)
        if (args[0] === storeFile() && snapshot) {
          snapshot = false
          if (failure === "corrupt store")
            await fs.writeFile(storeFile(), "{ invalid json")
          else if (failure === "unreadable path")
            await fs.writeFile(path.join(root, ".opencode"), "not a directory")
          else
            Object.assign(harness.api.state.path, { config: "", directory: "" })
        }
        return value
      }) as typeof fs.readFile)
      const polling = holdConfirmationPolls()
      try {
        // Seed an empty store so the asked-time read can be held after its
        // bytes arrive but before confirmation sees the transient failure.
        await fs.writeFile(storeFile(), JSON.stringify({ permission: {} }))
        harness.emit("permission.asked", askedEvent())
        const done = harness.handlers.get("permission.replied")![0]!({
          type: "permission.replied",
          properties: repliedEvent("always"),
        })
        await polling.wait()
        polling.advance()
        await polling.wait()
        expect(publish).toHaveBeenCalledTimes(
          failure === "paths syncing" ? 3 : 6,
        )
        expect(harness.toasts.some((toast) => toast.variant === "info")).toBe(
          false,
        )

        Object.assign(harness.api.state.path, paths)
        if (failure === "unreadable path")
          await fs.rm(path.join(root, ".opencode"))
        await fs.writeFile(
          storeFile(),
          JSON.stringify({ permission: { bash: { "git status *": "allow" } } }),
        )
        polling.advance()
        await done
        expect(publish).toHaveBeenCalledTimes(6)
        expect(
          harness.toasts.filter((toast) => toast.variant === "info"),
        ).toHaveLength(1)
      } finally {
        await harness.dispose()
        polling.restore()
        reads.mockRestore()
        publish.mockRestore()
      }
    },
  )

  test("confirmation follows a late passive store re-key under the same proof", async () => {
    const nested = path.join(root, "nested")
    await fs.mkdir(nested)
    const harness = makeApi({
      paths: {
        config: configDir,
        state: stateDir,
        directory: nested,
        worktree: "/",
      },
    })
    let now = Date.now()
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    const polling = holdConfirmationPolls()
    const publish = spyOn(harness.api.client.tui, "publish")
    try {
      await warmStore(harness, await loadCommand(harness))
      publish.mockClear()
      // The first poll is just before the passive keying retry is due. Git
      // then becomes available without forcing write semantics on the reader.
      now += 14_900
      harness.emit("permission.asked", askedEvent())
      const done = harness.handlers.get("permission.replied")![0]!({
        type: "permission.replied",
        properties: repliedEvent("always"),
      })
      await polling.wait()
      const git = Bun.spawn(["git", "init", "--quiet"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await git.exited).toBe(0)
      await fs.writeFile(
        storeFile(),
        JSON.stringify({ permission: { bash: { "git status *": "allow" } } }),
      )
      now += 200
      polling.advance()
      await done
      expect(publish).toHaveBeenCalledTimes(6)
      expect(harness.toasts.map((toast) => toast.message)).toEqual([
        "Saved git status * to the repository's shared permission store — persists across sessions and worktrees.",
      ])
      expect(await fs.exists(permissionStoreFile(configDir, nested))).toBe(
        false,
      )
    } finally {
      await harness.dispose()
      polling.restore()
      publish.mockRestore()
      clock.mockRestore()
    }
  })

  test("a user 'always' through the host prompt toasts what the server persisted", async () => {
    const harness = makeApi()
    await warmStore(harness, await loadCommand(harness))

    harness.emit("permission.asked", askedEvent())
    await settle()
    harness.emit("permission.replied", repliedEvent("always"))
    await serverPersists("bash", ["git status *"])

    const info = await infoToast(harness)
    expect(info?.message).toBe(
      "Saved git status * to this project's permission store — persists across sessions.",
    )
  })

  test("a blanket '*' approval reports the narrowed concrete patterns", async () => {
    const harness = makeApi()
    await warmStore(harness, await loadCommand(harness))

    harness.emit(
      "permission.asked",
      askedEvent({
        permission: "edit",
        patterns: ["src/app.ts"],
        always: ["*"],
      }),
    )
    await settle()
    harness.emit("permission.replied", repliedEvent("always"))
    await serverPersists("edit", ["src/app.ts"])

    const info = await infoToast(harness)
    expect(info?.message).toBe(
      "Saved src/app.ts to this project's permission store — persists across sessions.",
    )
  })

  test("a save the server never made is not announced", async () => {
    // The server half re-resolves keying with write semantics before
    // persisting, and saves NOTHING when that leaves it paused — a re-key
    // whose migration needs a manual merge, an untrusted path, a lock timeout.
    // This half cannot see any of that (separate processes, no channel), so it
    // must not claim a durable rule it has no evidence for. The server toasts
    // its own reason for pausing; a second, contradictory toast is the bug.
    const harness = makeApi()
    await loadCommand(harness)

    harness.emit("permission.asked", askedEvent())
    await settle()
    harness.emit("permission.replied", repliedEvent("always"))

    // Long enough to cover several confirmation rounds; nothing lands.
    for (let i = 0; i < 20; i++) await settle()
    expect(
      harness.toasts.filter((toast) => toast.variant === "info"),
    ).toHaveLength(0)
  })

  test("the reach reported is the one the confirmed write actually has", async () => {
    // The wording names where the rule landed, so it is read off the keying
    // that was in force when the store confirmed it — never a flag captured
    // at asked-time, which a re-key between the two events can invalidate.
    const git = async (cwd: string, args: string[]) => {
      const proc = Bun.spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.exited
      if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`)
    }
    const linked = path.join(sandboxRoot, "linked")
    await git(root, ["init", "--quiet"])
    await git(root, [
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i",
    ])
    await git(root, ["worktree", "add", "--quiet", linked])

    const harness = makeApi({
      paths: {
        worktree: linked,
        directory: linked,
        state: stateDir,
        config: configDir,
      },
    })
    // This session's store resolution runs real `git` probes, so it is the
    // slowest one in the file and the one that first exposed the race.
    await warmStore(harness, await loadCommand(harness))

    harness.emit("permission.asked", askedEvent())
    await settle()
    harness.emit("permission.replied", repliedEvent("always"))
    // The server half writes the REPOSITORY-shared store (keyed by the primary
    // checkout), which is what this session resolves too.
    const sharedStore = permissionStoreFile(configDir, root)
    await serverPersists("bash", ["git status *"], sharedStore)

    const info = await infoToast(harness)
    // Silence here means the plugin confirmed against some OTHER store, and
    // which one is the whole diagnosis — so report the keying evidence rather
    // than just "expected a string, got undefined". (A CI-only failure of this
    // test cost a full round trip for want of exactly this.)
    if (!info) {
      const [primaryProbe, worktreeProbe] = await Promise.all([
        discoverPrimaryRoot(linked),
        discoverWorktreeRoot(linked),
      ])
      throw new Error(
        `no save toast. toasts=${JSON.stringify(harness.toasts)} ` +
          `discoverPrimaryRoot(linked)=${primaryProbe} discoverWorktreeRoot(linked)=${worktreeProbe} ` +
          `expected primary=${root} shared store exists=${await fs.exists(sharedStore)} ` +
          `worktree-keyed store exists=${await fs.exists(permissionStoreFile(configDir, linked))}`,
      )
    }
    expect(info.message).toBe(
      "Saved git status * to the repository's shared permission store — persists across sessions and worktrees.",
    )
  })

  test("an unreachable shared store silences the report instead of trusting a fallback", async () => {
    // Git confirms a repository, but the primary worktree root cannot be
    // established, so this session is keyed by a narrower fallback while a
    // repository-shared store exists and is unreadable. The server half has
    // always failed its READS closed there (an allow in the fallback could
    // answer straight through a carve-out in the store this session cannot
    // reach); this half now does too, so its snapshot never forms and the
    // toast never claims a save it read out of the wrong file. Silent: the
    // pause names auto-approval, which is the server half's job — and the
    // server half is announcing it on this very event.
    const git = async (cwd: string, args: string[]) => {
      const proc = Bun.spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.exited
      if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`)
    }
    const linked = path.join(sandboxRoot, "linked")
    await git(root, ["init", "--quiet"])
    await git(root, [
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i",
    ])
    await git(root, ["worktree", "add", "--quiet", linked])
    // A directory BELOW the linked worktree's root: git still places it in a
    // work tree, but the primary probe's self-check fails on it.
    const nested = path.join(linked, "packages", "app")
    await fs.mkdir(nested, { recursive: true })

    const harness = makeApi({
      paths: {
        worktree: nested,
        directory: nested,
        state: stateDir,
        config: configDir,
      },
    })
    await loadCommand(harness)

    harness.emit("permission.asked", askedEvent())
    await settle()
    harness.emit("permission.replied", repliedEvent("always"))
    // The rule the server half would save under the fallback keying is there
    // to be read; the point is that this half declines to read it.
    await serverPersists(
      "bash",
      ["git status *"],
      permissionStoreFile(configDir, nested),
    )
    for (let i = 0; i < 20; i++) await settle()

    expect(harness.toasts).toEqual([])
  })

  test("a rule another writer covered meanwhile still counts as saved", async () => {
    // The server half skips a write it can prove is redundant. Confirmation is
    // therefore coverage, not literal presence: the approval IS persisted.
    const harness = makeApi()
    await warmStore(harness, await loadCommand(harness))

    harness.emit("permission.asked", askedEvent())
    await settle()
    harness.emit("permission.replied", repliedEvent("always"))
    await serverPersists("bash", ["git *"])

    const info = await infoToast(harness)
    expect(info?.message).toBe(
      "Saved git status * to this project's permission store — persists across sessions.",
    )
  })

  test("'once' and 'reject' replies toast nothing", async () => {
    const harness = makeApi()
    await loadCommand(harness)

    harness.emit("permission.asked", askedEvent({ id: "per_1" }))
    harness.emit("permission.asked", askedEvent({ id: "per_2" }))
    await settle()
    harness.emit("permission.replied", repliedEvent("once", "per_1"))
    harness.emit("permission.replied", repliedEvent("reject", "per_2"))

    expect(harness.toasts).toHaveLength(0)
  })

  test("notify: false disables the toast", async () => {
    const harness = makeApi()
    await loadCommand(harness, { notify: false })

    harness.emit("permission.asked", askedEvent())
    await settle()
    harness.emit("permission.replied", repliedEvent("always"))

    expect(harness.toasts).toHaveLength(0)
  })

  test("notify: false still runs the edit flow, and registers no replied listener to claim from", async () => {
    // The edit flow's report claim exists solely so the notify handler can
    // defer to it. With notify off nothing registers a permission.replied
    // listener, so a claim has no consumer: every successful edit would leave a
    // settled promise and its pattern array behind, retained until trim's
    // 500-entry cap evicted it. The flow itself must be unaffected.
    const harness = makeApi()
    const run = await loadCommand(harness, { notify: false })
    // Prompt tracking and reconnect invalidation need no reply-report claims.
    expect(harness.handlers.get("permission.replied") ?? []).toHaveLength(0)

    const done = run()
    await openDialog(harness)
    harness.dialog()!.onConfirm("docker compose up *")
    await done

    expect(await readJson(storeFile())).toEqual({
      permission: { bash: { "docker compose up *": "allow" } },
    })
    expect(harness.replies).toHaveLength(1)
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.message).toBe(
      "Saved docker compose up * to this project's permission store — persists across sessions.",
    )
  })

  test("a reply that lands before the store read settles still toasts", async () => {
    const harness = makeApi()
    // Warming does not weaken what this pins: the asked-time snapshot is still
    // asynchronous, and the reply below still lands in the same tick as the
    // ask — what must hold is that tracking was registered synchronously.
    await warmStore(harness, await loadCommand(harness))

    // Same-tick asked and replied: the tracking entry must be registered
    // synchronously or the reply finds nothing and the toast is lost (the
    // race loaded CI runners hit with a settle-based test).
    harness.emit("permission.asked", askedEvent())
    harness.emit("permission.replied", repliedEvent("always"))
    // Only once the asked-time snapshot has settled: the server half persists
    // AFTER the reply, and a store written under the snapshot's own read would
    // make the request look like one it auto-approved.
    await settle()
    await serverPersists("bash", ["git status *"])

    const info = await infoToast(harness)
    expect(info?.message).toBe(
      "Saved git status * to this project's permission store — persists across sessions.",
    )
  })

  test("a corrupt store warns once on the passive path, and re-arms after it heals", async () => {
    await fs.writeFile(storeFile(), "{ not json")
    const harness = makeApi()
    await loadCommand(harness)
    const errors = () =>
      harness.toasts.filter((toast) => toast.variant === "error").length

    harness.emit("permission.asked", askedEvent({ id: "per_1" }))
    await awaitToasts(errors, 1)
    harness.emit("permission.asked", askedEvent({ id: "per_2" }))
    await settle()
    // Once per cause: a second prompt must not stack a duplicate toast.
    expect(errors()).toBe(1)

    // A clean read heals the cause...
    await fs.writeFile(storeFile(), JSON.stringify({ permission: {} }))
    harness.emit("permission.asked", askedEvent({ id: "per_3" }))
    await settle()
    expect(errors()).toBe(1)

    // ...so a recurrence is news again (the server half's warnedCorrupt pattern).
    await fs.writeFile(storeFile(), "{ not json")
    harness.emit("permission.asked", askedEvent({ id: "per_4" }))
    await awaitToasts(errors, 2)
    expect(errors()).toBe(2)
  })

  test("a resolved legacy migration re-arms the passive warning too", async () => {
    await fs.mkdir(path.dirname(legacyStoreFile()), { recursive: true })
    await fs.writeFile(
      legacyStoreFile(),
      JSON.stringify({ permission: { bash: "allow" } }),
    )
    const harness = makeApi()
    await loadCommand(harness)
    const warnings = () =>
      harness.toasts.filter((toast) =>
        String(toast.message).includes("is agent-writable and is no longer"),
      ).length

    harness.emit("permission.asked", askedEvent({ id: "per_1" }))
    await awaitToasts(warnings, 1)
    harness.emit("permission.asked", askedEvent({ id: "per_2" }))
    await settle()
    // Once per cause, like the corrupt-store warning above.
    expect(warnings()).toBe(1)

    // The user recreates the trusted store; the leftover legacy file is
    // ignored and the cause heals...
    await fs.writeFile(storeFile(), JSON.stringify({ permission: {} }))
    harness.emit("permission.asked", askedEvent({ id: "per_3" }))
    await settle()
    expect(warnings()).toBe(1)

    // ...so losing the trusted store again warns again.
    await fs.rm(storeFile())
    harness.emit("permission.asked", askedEvent({ id: "per_4" }))
    await awaitToasts(warnings, 2)
    expect(warnings()).toBe(2)
  })

  test("auto-approved requests (store already covers them) toast nothing", async () => {
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(
      storeFile(),
      JSON.stringify({ permission: { bash: { "git *": "allow" } } }),
    )
    const harness = makeApi()
    await loadCommand(harness)

    harness.emit("permission.asked", askedEvent())
    await settle()
    harness.emit("permission.replied", repliedEvent("once"))

    // The toast is asynchronous now; give a wrong one time to appear.
    await settle()
    expect(harness.toasts).toHaveLength(0)
  })

  test("the edit flow's own once-reply is not toasted twice", async () => {
    const harness = makeApi()
    const run = await loadCommand(harness)

    harness.emit(
      "permission.asked",
      askedEvent({
        patterns: ["docker compose up -d"],
        always: ["docker compose up *"],
      }),
    )
    await settle()
    const done = run()
    await openDialog(harness)
    harness.dialog()!.onConfirm("docker compose up *")
    await done
    expect(harness.replies[0]!.reply).toBe("once")
    harness.emit("permission.replied", repliedEvent("once"))

    // The notify decision is deferred behind the flow's claim now, so the
    // assertions must not run in the same turn as the emit — without a quiet
    // period they would pass whatever the claim resolved to.
    for (let i = 0; i < 20; i++) await settle()
    expect(
      harness.toasts.filter((toast) => toast.variant === "info"),
    ).toHaveLength(0)
    expect(
      harness.toasts.filter((toast) => toast.variant === "success"),
    ).toHaveLength(1)
  })

  // An "always" answered through the host prompt while the edit dialog is up is
  // ONE answer. It used to produce two toasts: the notify handler reported the
  // server half's save, and the edit flow then failed to reply and reported
  // again. Whichever of them speaks, exactly one must.
  describe("an externally answered request is reported once", () => {
    const quiet = async () => {
      for (let i = 0; i < 20; i++) await settle()
    }

    test("the edit flow that saved something owns the report", async () => {
      const harness = makeApi({ replyError: { name: "NotFoundError" } })
      const run = await loadCommand(harness)
      await warmStore(harness, run)

      harness.emit(
        "permission.asked",
        askedEvent({
          patterns: ["docker compose up -d"],
          always: ["docker compose up *"],
        }),
      )
      await settle()
      const done = run()
      await openDialog(harness)

      // The user answers the host prompt while the dialog is still open, and
      // the server half persists its own (unedited) patterns.
      harness.emit("permission.replied", repliedEvent("always"))
      await serverPersists("bash", ["docker compose up *"])

      harness.dialog()!.onConfirm("docker *")
      await done
      await quiet()

      expect(harness.toasts).toHaveLength(1)
      expect(harness.toasts[0]!.message).toBe(
        "Saved docker * to this project's permission store — persists across sessions. The prompt could not be answered; it may already have been resolved.",
      )
    })

    test("a NARROWED edit does not suppress the broader rule the host answer saved", async () => {
      // The user reached for the dialog precisely to grant less than the host's
      // "always" would. Answering that prompt in parallel still persists the
      // broad pattern; reporting only the narrow one the user typed would hide
      // exactly the grant they were avoiding. Suppression is by sound coverage,
      // not by "the flow already said something".
      const harness = makeApi({ replyError: { name: "NotFoundError" } })
      const run = await loadCommand(harness)
      await warmStore(harness, run)

      harness.emit(
        "permission.asked",
        askedEvent({
          patterns: ["docker compose up -d"],
          always: ["docker compose up *"],
        }),
      )
      await settle()
      const done = run()
      await openDialog(harness)

      harness.emit("permission.replied", repliedEvent("always"))
      await serverPersists("bash", ["docker compose up *"])

      harness.dialog()!.onConfirm("docker compose up -d")
      await done

      // The flow's own report, plus the broad rule it does not cover.
      const info = await infoToast(harness)
      expect(info?.message).toBe(
        "Saved docker compose up * to this project's permission store — persists across sessions.",
      )
      expect(
        harness.toasts.filter((toast) => toast.variant === "warning"),
      ).toHaveLength(1)
    })

    test("a reply that never settles does not hold the external report hostage", async () => {
      // The claim is answerable the moment the lock-held write establishes the
      // durable outcome — not when the whole flow finishes. Holding it until
      // then means a reply call that hangs (the server half persisted, the
      // reply never returns) suppresses the ONLY report of an external save
      // forever. Nothing here ever resolves `done`; that is the point.
      const harness = makeApi({ replyPending: true })
      const run = await loadCommand(harness)
      await warmStore(harness, run)

      harness.emit(
        "permission.asked",
        askedEvent({
          patterns: ["docker compose up -d"],
          always: ["docker compose up *"],
        }),
      )
      await settle()
      void run()
      await openDialog(harness)

      harness.emit("permission.replied", repliedEvent("always"))
      await serverPersists("bash", ["docker compose up *"])

      // A NARROWED edit, so the flow's own rule cannot cover the broad one the
      // host answer saved — the report is genuinely owed.
      harness.dialog()!.onConfirm("docker compose up -d")

      const info = await infoToast(harness)
      expect(info?.message).toBe(
        "Saved docker compose up * to this project's permission store — persists across sessions.",
      )
    })

    test("a dismissed dialog hands the report back to the notify handler", async () => {
      // The flow saved nothing, so the external answer is still news the user
      // is owed — releasing the claim must un-suppress it, not swallow it.
      const harness = makeApi()
      const run = await loadCommand(harness)
      await warmStore(harness, run)

      harness.emit("permission.asked", askedEvent())
      await settle()
      const done = run()
      await openDialog(harness)

      harness.emit("permission.replied", repliedEvent("always"))
      await serverPersists("bash", ["git status *"])

      harness.dialog()!.onCancel()
      await done

      const info = await infoToast(harness)
      expect(info?.message).toBe(
        "Saved git status * to this project's permission store — persists across sessions.",
      )
      expect(harness.toasts).toHaveLength(1)
    })

    test("the claim covers the store probe, before any dialog paints", async () => {
      // run() does real store I/O — a keying re-derivation that can spawn git —
      // before the first dialog opens. Claiming only at reply time (or even at
      // dialog time) leaves that window open, and it is wide enough that the
      // harness needs a 4s deadline to wait out.
      const harness = makeApi({ replyError: { name: "NotFoundError" } })
      const run = await loadCommand(harness)
      await warmStore(harness, run)

      harness.emit(
        "permission.asked",
        askedEvent({
          patterns: ["docker compose up -d"],
          always: ["docker compose up *"],
        }),
      )
      await settle()
      const done = run()
      // Synchronously after run() started: no dialog exists yet.
      expect(harness.dialog()).toBeUndefined()
      harness.emit("permission.replied", repliedEvent("always"))
      await serverPersists("bash", ["docker compose up *"])

      await openDialog(harness)
      harness.dialog()!.onConfirm("docker *")
      await done
      await quiet()

      expect(harness.toasts).toHaveLength(1)
      expect(harness.toasts[0]!.variant).toBe("warning")
    })
  })
})

describe("pending-permission hint line", () => {
  test("registers an app_bottom slot by default", async () => {
    const harness = makeApi()
    await loadCommand(harness)

    expect(harness.slotPlugins).toHaveLength(1)
    expect(typeof harness.slotPlugins[0]!.slots.app_bottom).toBe("function")
  })

  test("hint: false or a disabled keybind skips the slot", async () => {
    const off = makeApi()
    await loadCommand(off, { hint: false })
    expect(off.slotPlugins).toHaveLength(0)

    // Without a key there is nothing to hint at; the palette entry remains.
    const noKey = makeApi()
    await loadCommand(noKey, { keybind: false })
    expect(noKey.slotPlugins).toHaveLength(0)
  })
})

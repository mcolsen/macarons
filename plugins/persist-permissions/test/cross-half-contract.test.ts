import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  BAND_SAMPLE_VERSIONS as BAND,
  createFilesystemLocalityResponder,
} from "@macarons/permission-rules"
import { makeTuiApi } from "@macarons/plugin-test-harness/tui"
import { PersistPermissionsPlugin } from "../src/index"
import { permissionStoreFile } from "../src/shared"
import { tui } from "../src/tui"

/**
 * Cross-half contract: the server half's narrowest()+persist, the TUI edit
 * dialog's suggestions, and the TUI notify toast each compute "what does an
 * 'always' approval persist" in independent hand-mirrored code. This suite
 * drives all three through their public surfaces with the same fixtures and
 * asserts they agree, so skewing one copy fails here instead of shipping.
 */

let sandboxRoot: string
let root: string
let configDir: string
let stateDir: string
const localities: ReturnType<typeof createFilesystemLocalityResponder>[] = []
const activeTUIs: ReturnType<typeof makeTuiApi>[] = []
beforeEach(async () => {
  // realpath: os.tmpdir() can sit behind a symlink (macOS /var → /private/var),
  // and both halves hash the canonical project root — expected store paths
  // computed from the raw root would name a different file.
  sandboxRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "cross-half-")),
  )
  root = path.join(sandboxRoot, "project")
  configDir = path.join(sandboxRoot, "config")
  stateDir = path.join(sandboxRoot, "state")
  await Promise.all([fs.mkdir(root), fs.mkdir(configDir), fs.mkdir(stateDir)])
  await fs.mkdir(path.dirname(storeFile()), { recursive: true })
})
afterEach(async () => {
  for (const harness of activeTUIs.splice(0)) await harness.dispose()
  for (const locality of localities.splice(0)) await locality.dispose()
  await fs.rm(sandboxRoot, { recursive: true, force: true })
})

const storeFile = () => permissionStoreFile(configDir, root)
const readStore = async () => JSON.parse(await fs.readFile(storeFile(), "utf8"))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

const savedMessage = (patterns: string[]) =>
  `Saved ${patterns.join(", ")} to this project's permission store — persists across sessions.`

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

async function loadServer(at?: string, options?: Record<string, unknown>) {
  const client = {
    app: { log: async () => ({}) },
    global: {
      health: async () => ({ data: { healthy: true, version: BAND.floor } }),
    },
    path: {
      get: async () => ({ data: { config: configDir, state: stateDir } }),
    },
    postSessionIdPermissionsPermissionId: async () => ({ data: true }),
  }
  return PersistPermissionsPlugin(
    {
      client: client as any,
      directory: at ?? root,
      worktree: at ?? root,
      project: {} as any,
      serverUrl: new URL("http://localhost:4096"),
      experimental_workspace: { register() {} },
      $: {} as any,
    },
    options,
  )
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
  const base = makeTuiApi()
  activeTUIs.push(base)
  const locality = createFilesystemLocalityResponder({
    service: "persist-permissions",
    paths: async (): Promise<readonly string[]> => {
      const { config, worktree, directory } = api.state.path
      const projectRoot = worktree && worktree !== "/" ? worktree : directory
      const storeDir = path.dirname(permissionStoreFile(config, projectRoot))
      await fs.mkdir(storeDir, { recursive: true, mode: 0o700 })
      return [config, storeDir, projectRoot]
    },
  })
  localities.push(locality)
  const toasts: { variant?: string; message: string }[] = []
  const replies: Record<string, unknown>[] = []
  const layers: Record<string, any>[] = []
  const handlers = new Map<string, ((event: unknown) => void)[]>()
  let dialogProps: Record<string, any> | undefined
  let onClose: (() => void) | undefined

  const api = {
    ...base.api,
    app: { version: BAND.floor },
    state: {
      path: {
        worktree: root,
        directory: root,
        state: stateDir,
        config: configDir,
      },
      session: {
        permission: (sessionID: string) =>
          requests.filter((item) => item.sessionID === sessionID),
        get: (sessionID: string) => ({ id: sessionID, directory: root }),
      },
    },
    route: { current: { name: "session", params: { sessionID: "ses_1" } } },
    ui: {
      toast: (toast: { variant?: string; message: string }) =>
        toasts.push(toast),
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
    keymap: {
      registerLayer: (layer: Record<string, unknown>) => layers.push(layer),
    },
    slots: { register: () => {} },
    theme: { current: { text: {}, textMuted: {} } },
    event: {
      on: (type: string, handler: (event: unknown) => void) => {
        handlers.set(type, [...(handlers.get(type) ?? []), handler])
        return () => {}
      },
    },
    client: {
      tui: {
        publish: async (payload: { body: unknown }) => {
          await locality.handle(payload.body)
          return { data: true }
        },
      },
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
    emit: (type: string, event: unknown) => {
      for (const handler of handlers.get(type) ?? []) handler(event)
    },
    dialog: () => dialogProps,
    resetDialog: () => {
      dialogProps = undefined
    },
  }
}

// run() probes the store with real fs I/O before opening the edit dialog, so a
// single timer turn can lose that race on a loaded machine (seen as CI flakes).
// Wait for the dialog itself, bounded so a genuinely missing dialog still fails
// fast. Between dialog steps, call harness.resetDialog() first — the captured
// props of the previous step would otherwise satisfy the wait immediately.
const openDialog = async (harness: {
  dialog: () => Record<string, any> | undefined
}) => {
  for (let i = 0; i < 500 && !harness.dialog(); i++) await tick()
  expect(harness.dialog()).toBeDefined()
}

const tuiRequest = (
  f: Pick<Fixture, "permission" | "patterns" | "always">,
) => ({
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
      // Both halves, because the toast is an ACKNOWLEDGMENT of the server
      // half's write: it names what actually reached the store, so the two
      // surfaces can only agree here if they agree about the store too.
      const harness = makeTuiHarness([])
      await tui(harness.api, undefined, {} as any)
      const server = await loadServer()

      harness.emit("permission.asked", { properties: tuiRequest(f) })
      // The TUI's snapshot is taken against the store as it was BEFORE the
      // reply; the server persists only after. (A reply that beats that
      // snapshot is covered in tui.test.ts.)
      await settle()
      await server.event!(askedEvent(f))
      await server.event!(repliedAlways())
      harness.emit("permission.replied", {
        properties: { sessionID: "ses_1", requestID: "per_1", reply: "always" },
      })

      // Wall-clock bounded: the toast waits on a confirmation poll that
      // re-resolves keying (a real `git` spawn) first, and a fixed tick count
      // is only milliseconds on a fast machine.
      const deadline = Date.now() + 4_000
      while (
        !harness.toasts.some((toast) => toast.variant === "info") &&
        Date.now() < deadline
      )
        await tick()
      const info = harness.toasts.find((toast) => toast.variant === "info")
      expect(info?.message).toBe(savedMessage(f.persisted))
    })

    test("TUI edit dialog offers exactly these patterns, and confirming them writes the same rules", async () => {
      const harness = makeTuiHarness([tuiRequest(f)])
      await tui(harness.api, undefined, {} as any)
      const run = harness.layers[0]!.commands[0].run as () => Promise<void>

      const done = run()
      const offered: string[] = []
      for (let i = 0; i < f.persisted.length; i++) {
        if (i > 0) harness.resetDialog()
        await openDialog(harness)
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
  const fixture = {
    permission: "bash",
    patterns: ["git status"],
    always: [] as string[],
  }

  test("server half persists nothing", async () => {
    const hooks = await loadServer()
    await hooks.event!(askedEvent(fixture))
    await hooks.event!(repliedAlways())
    await expect(fs.access(storeFile())).rejects.toThrow()
  })

  test("TUI toast stays silent", async () => {
    const harness = makeTuiHarness([])
    await tui(harness.api, undefined, {} as any)
    harness.emit("permission.asked", { properties: tuiRequest(fixture) })
    await settle()
    harness.emit("permission.replied", {
      properties: { sessionID: "ses_1", requestID: "per_1", reply: "always" },
    })
    // The toast is asynchronous now; give a wrong one time to appear.
    await settle()
    expect(harness.toasts).toHaveLength(0)
  })

  test("TUI dialog falls back to the concrete patterns and replies 'once', never 'always'", async () => {
    const harness = makeTuiHarness([tuiRequest(fixture)])
    await tui(harness.api, undefined, {} as any)
    const run = harness.layers[0]!.commands[0].run as () => Promise<void>

    const done = run()
    await openDialog(harness)
    expect(harness.dialog()!.value).toBe("git status")
    harness.dialog()!.onConfirm("git status")
    await done

    const store = await readStore()
    expect(store.permission.bash).toEqual({ "git status": "allow" })
    expect(harness.replies).toHaveLength(1)
    expect(harness.replies[0]!.reply).toBe("once")
  })
})

// --- repository scope: both halves key a linked worktree by the primary -----
//
// The keying is itself cross-half contract: the server half hashes the
// worktree it was constructed with, the TUI half hashes api.state.path, and
// if either resolved the primary root differently they would silently read
// and write different files. These run against a REAL repository (git init +
// git worktree add) because the primary-root probe self-checks against real
// git output — a faked layout can't exercise that agreement.

describe("repository scope across a linked worktree", () => {
  const FIXTURE = {
    permission: "bash",
    patterns: ["git status --short"],
    always: ["git status *"],
    persisted: ["git status *"],
  }

  let linked: string
  const primaryStore = () => permissionStoreFile(configDir, root)
  const linkedStore = () => permissionStoreFile(configDir, linked)

  const git = async (cwd: string, args: string[]) => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited
    if (proc.exitCode !== 0)
      throw new Error(
        `git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`,
      )
  }

  // Turns the per-test sandbox project into a primary checkout with one
  // linked worktree. Inside beforeEach's sandbox, so every test starts clean.
  const setUpWorktree = async () => {
    linked = path.join(sandboxRoot, "linked")
    await git(root, ["init", "--quiet"])
    await git(root, [
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=test",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "init",
    ])
    await git(root, ["worktree", "add", "--quiet", linked])
  }

  const linkedTuiHarness = (requests: Record<string, unknown>[]) => {
    const harness = makeTuiHarness(requests)
    harness.api.state.path = {
      worktree: linked,
      directory: linked,
      state: stateDir,
      config: configDir,
    }
    return harness
  }

  test("server half: an 'always' answered in the worktree lands in the primary's store", async () => {
    await setUpWorktree()
    const hooks = await loadServer(linked)
    await hooks.event!(askedEvent(FIXTURE))
    await hooks.event!(repliedAlways())
    const store = JSON.parse(await fs.readFile(primaryStore(), "utf8"))
    expect(store.permission.bash).toEqual({ "git status *": "allow" })
    await expect(fs.access(linkedStore())).rejects.toThrow()
  })

  test("TUI half: the edit dialog writes the same primary-keyed file", async () => {
    await setUpWorktree()
    const harness = linkedTuiHarness([tuiRequest(FIXTURE)])
    await tui(harness.api, undefined, {} as any)
    const run = harness.layers[0]!.commands[0].run as () => Promise<void>

    const done = run()
    await openDialog(harness)
    harness.dialog()!.onConfirm(harness.dialog()!.value)
    await done

    const store = JSON.parse(await fs.readFile(primaryStore(), "utf8"))
    expect(store.permission.bash).toEqual({ "git status *": "allow" })
    await expect(fs.access(linkedStore())).rejects.toThrow()
  })

  test("the halves read each other: a server-persisted rule silences the TUI notify toast", async () => {
    await setUpWorktree()
    const hooks = await loadServer(linked)
    await hooks.event!(askedEvent(FIXTURE))
    await hooks.event!(repliedAlways())

    const harness = linkedTuiHarness([])
    await tui(harness.api, undefined, {} as any)
    harness.emit("permission.asked", { properties: tuiRequest(FIXTURE) })
    await settle()
    harness.emit("permission.replied", {
      properties: { sessionID: "ses_1", requestID: "per_1", reply: "always" },
    })
    await settle()
    // autoAllowed: the TUI saw the server half's rule in the shared file, so
    // this "always" persists nothing new and must not toast a save.
    expect(
      harness.toasts.filter((toast) => toast.variant === "info"),
    ).toHaveLength(0)
  })

  test('scope: "worktree" restores per-checkout keying in both halves', async () => {
    await setUpWorktree()
    const hooks = await loadServer(linked, { scope: "worktree" })
    await hooks.event!(askedEvent(FIXTURE))
    await hooks.event!(repliedAlways())
    let store = JSON.parse(await fs.readFile(linkedStore(), "utf8"))
    expect(store.permission.bash).toEqual({ "git status *": "allow" })
    await expect(fs.access(primaryStore())).rejects.toThrow()

    await fs.rm(linkedStore())
    const harness = linkedTuiHarness([tuiRequest(FIXTURE)])
    await tui(harness.api, { scope: "worktree" } as any, {} as any)
    const run = harness.layers[0]!.commands[0].run as () => Promise<void>
    const done = run()
    await openDialog(harness)
    harness.dialog()!.onConfirm(harness.dialog()!.value)
    await done
    store = JSON.parse(await fs.readFile(linkedStore(), "utf8"))
    expect(store.permission.bash).toEqual({ "git status *": "allow" })
    await expect(fs.access(primaryStore())).rejects.toThrow()
  })

  test("a pre-scope worktree store is folded in before the first re-approval", async () => {
    await setUpWorktree()
    // A store written by an older release, keyed by the linked worktree.
    await fs.mkdir(path.dirname(linkedStore()), { recursive: true })
    await fs.writeFile(
      linkedStore(),
      JSON.stringify({ permission: { bash: { "git status *": "allow" } } }),
    )

    const exists = (file: string) =>
      fs.access(file).then(
        () => true,
        () => false,
      )
    const hooks = await loadServer(linked)
    await hooks.event!(askedEvent(FIXTURE))
    // The asked event's store read triggers the migration, then finds the
    // rule in the shared store and auto-approves without any new reply.
    for (let i = 0; i < 500 && (await exists(linkedStore())); i++) await tick()
    const store = JSON.parse(await fs.readFile(primaryStore(), "utf8"))
    expect(store.permission.bash).toEqual({ "git status *": "allow" })
    expect(await exists(linkedStore())).toBe(false)
  })
})

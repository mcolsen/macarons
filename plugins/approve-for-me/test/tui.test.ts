import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import * as nodeFs from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as permissionRules from "@macarons/permission-rules"
import { until } from "@macarons/plugin-test-harness"
import {
  describeGating,
  makeTuiApi,
  type TuiApiHarness,
} from "@macarons/plugin-test-harness/tui"
import {
  createSlotMounter,
  settleFrame,
} from "@macarons/plugin-test-harness/view"
import type { TuiDialogSelectProps, TuiPlugin } from "@opencode-ai/plugin/tui"
import { testRender } from "@opentui/solid"
import { parse as parseJsonc } from "jsonc-parser"
import { createSignal } from "solid-js"
import {
  ACTIVITY_REASON_MAX,
  blessFile,
  GLOBAL_SETTINGS_BASENAME,
  legacyProjectSettingsFile,
  activityFile as ownedActivityFile,
  overrideFile as ownedOverrideFile,
  parseVerdict,
  preSlugProjectSettingsFile,
  readBlessing,
  readOverride,
  readSessionModel,
  resolveTrustedSettingsPaths,
  respondInstanceRequest,
  SESSION_ANCESTRY_HOP_LIMIT,
  sessionModelDirectory,
  sessionModelFile,
  settingsLocalityPaths,
  TRUNCATE_SUFFIX,
  projectSettingsFile as trustedProjectSettingsFile,
  writeSessionModel,
} from "../src/shared"
import { feedItems, statusLabel, tui } from "../src/tui"

type Api = Parameters<TuiPlugin>[0]
type CapturedSelect = TuiDialogSelectProps & {
  onSelect: (option: { title: string; value: unknown }) => void
}

/**
 * The TUI companion owns every interactive control over the trust boundary:
 * the instance toggle, the classifier model picker, and the persistent
 * default. These tests drive it through a typed mock of the TuiPluginApi
 * slice it touches (the persist-permissions T8 pattern), so structural drift
 * in that surface fails typecheck instead of silently passing.
 */

let root: string
let sandboxRoot: string
const activeHarnesses: TuiApiHarness[] = []
const INSTANCE_ID = randomUUID()
const overrideFile = (state: string, project: string, owner = INSTANCE_ID) =>
  ownedOverrideFile(state, project, owner)
const activityFile = (state: string, project: string, owner = INSTANCE_ID) =>
  ownedActivityFile(state, project, owner)

beforeEach(async () => {
  // realpath: the plugin canonicalizes the project root before hashing it
  // into trusted file names, and macOS puts os.tmpdir() behind the /var →
  // /private/var symlink — raw mkdtemp paths would hash differently.
  sandboxRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "auto-approve-tui-")),
  )
  root = path.join(sandboxRoot, "project")
  await Promise.all([
    fs.mkdir(root),
    fs.mkdir(configDir()),
    fs.mkdir(stateDir()),
  ])
})

afterEach(async () => {
  // Run everything the loaded entries registered through lifecycle.onDispose
  // (file watchers, tickers) before the sandbox disappears under them.
  for (const harness of activeHarnesses.splice(0)) await harness.dispose()
  await fs.rm(sandboxRoot, { recursive: true, force: true })
})

const stateDir = () => path.join(sandboxRoot, "xdg-state")
const configDir = () => path.join(sandboxRoot, "xdg-config")
const sessionModelsDir = () => sessionModelDirectory(stateDir())
const projectSettingsFile = () => trustedProjectSettingsFile(configDir(), root)
const legacySettingsFile = () => legacyProjectSettingsFile(root)
const sessionModelPath = (sessionID: string) =>
  sessionModelFile(sessionModelsDir(), sessionID)
const globalSettingsFile = () =>
  path.join(configDir(), GLOBAL_SETTINGS_BASENAME)

async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8"))
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value)}\n`)
}

// Global settings ride on this plugin's entry in the global opencode.json[c];
// the package-name spec matches without an on-disk package.
const PLUGIN_NAME = "@macarons/approve-for-me"
const globalConfigFile = () => path.join(configDir(), "opencode.jsonc")
async function writeGlobalEntry(options?: Record<string, unknown>) {
  await writeJson(globalConfigFile(), {
    plugin: [options === undefined ? PLUGIN_NAME : [PLUGIN_NAME, options]],
  })
}
async function readGlobalEntryOptions(): Promise<unknown> {
  const raw = await fs.readFile(globalConfigFile(), "utf8")
  const parsed = parseJsonc(raw, [], { allowTrailingComma: true }) as {
    plugin?: unknown[]
  }
  const entry = parsed.plugin?.findLast(
    (item) =>
      item === PLUGIN_NAME || (Array.isArray(item) && item[0] === PLUGIN_NAME),
  )
  return Array.isArray(entry) ? entry[1] : undefined
}

/**
 * The shared TuiPlugin api core plus what this plugin's entry actually
 * touches on top of it: the provider catalog the model picker lists (and the
 * judge pre-check resolves pinned models against), the session permission
 * surface the feed scopes by, and the DialogSelect + dialog onClose-stack the
 * pickers drive. Everything the tests assert on (toasts, layers, slots,
 * event handlers, disposers) is recorded by the core.
 */
function makeApi(
  input: {
    version?: string | null
    baseUrl?: string | null
    sharedFilesystem?: boolean
    configPath?: string
    statePath?: string
    // OpenCode reports worktree "/" for a non-git project; both halves collapse
    // that sentinel to `directory` before keying instance files. Defaults keep
    // the git case (worktree === directory === root) every other test relies on.
    worktree?: string
    directory?: string
    routeName?: string
    routeSessionID?: string
    parentID?: string
    instanceID?: string | null
  } = {},
) {
  const base = makeTuiApi({
    version: input.version,
    baseUrl: input.baseUrl,
    routeName: input.routeName,
    routeSessionID: input.routeSessionID,
    parentID: input.parentID,
    paths: {
      worktree: input.worktree ?? root,
      directory: input.directory ?? root,
      state: input.statePath ?? stateDir(),
      config: input.configPath ?? configDir(),
    },
    // Overrides where the core's palette differs: pure primaries keep the
    // sidebar statusColor channel assertions unambiguous, and `info` — the
    // feed's in-flight tone — is not a core default at all.
    theme: { warning: "#ff0000", info: "#0000ff", success: "#00ff00" },
  })
  let instanceID =
    input.instanceID === undefined ? INSTANCE_ID : input.instanceID
  const locality = permissionRules.createFilesystemLocalityResponder({
    service: "permissions-approve-for-me",
    paths: async () => {
      if (!instanceID) return undefined
      const { config, state, worktree, directory } = base.api.state.path
      const projectRoot = worktree && worktree !== "/" ? worktree : directory
      const trusted = await resolveTrustedSettingsPaths(
        projectRoot,
        config,
        state,
        path.join(sandboxRoot, "data"),
        instanceID,
        { migrate: false },
      )
      const paths = trusted && (await settingsLocalityPaths(trusted))
      if (!paths) return undefined
      await Promise.all(
        paths
          .filter((dir) => dir !== config && dir !== projectRoot)
          .map((dir) => fs.mkdir(dir, { recursive: true, mode: 0o700 })),
      )
      return paths
    },
  })
  base.api.lifecycle.onDispose(() => locality.dispose())

  base.api.client.tui = {
    publish: async ({ body }: { body: unknown }) => {
      if (!instanceID) return { error: "server unavailable" }
      const identity = await respondInstanceRequest(
        {
          tui: {
            publish: async ({
              body: response,
            }: {
              body: { type: string; properties: unknown }
            }) => {
              base.emit(response.type, response.properties)
              return { data: true }
            },
          },
        },
        body,
        instanceID,
        base.api.state.path.directory,
      )
      if (!identity) {
        if (input.sharedFilesystem === false)
          return { error: "filesystem proof unavailable" }
        await locality.handle(body)
      }
      return { data: true }
    },
  }

  base.api.state.provider = [
    {
      id: "e2e",
      name: "E2E provider",
      models: {
        test: { name: "Test model" },
        other: {},
        reasoner: {
          name: "Reasoning model",
          variants: { high: {}, max: {} },
        },
      },
    },
    {
      id: "anthropic",
      models: { "claude-sonnet-5": { name: "Claude Sonnet 5" } },
    },
  ]
  // The core getter supplies a concrete root record by default. No prompts are
  // pending; feed-scoping and ancestry regressions replace either method.
  base.api.state.session.permission = (
    _sessionID: string,
  ): {
    id: string
    sessionID: string
    permission: string
    patterns: string[]
  }[] => []

  const selects: CapturedSelect[] = []
  let onClose: (() => void) | undefined
  base.api.ui.DialogSelect = (props: TuiDialogSelectProps) => {
    selects.push(props as CapturedSelect)
    return null
  }
  base.api.ui.dialog = {
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
  }

  activeHarnesses.push(base)
  return {
    ...base,
    selects,
    eventHandlers: base.handlers,
    setInstanceID: (owner: string | null) => {
      instanceID = owner
    },
  }
}

async function loadTui(
  harness: ReturnType<typeof makeApi>,
  options?: Record<string, unknown>,
) {
  await tui(harness.api as unknown as Api, options, { state: "first" } as any)
  // Startup reads settings and the override file asynchronously.
  await Bun.sleep(10)
}

function command(
  harness: ReturnType<typeof makeApi>,
  name: string,
): () => Promise<void> {
  const commands = harness.layers.flatMap((layer) => layer.commands ?? [])
  const found = commands.find((entry: any) => entry.name === name)
  if (!found) throw new Error(`command ${name} was not registered`)
  return found.run
}

// Headless render of the plugin's registered sidebar slot, driven through the
// same mock api as the engine tests. The package bunfig preloads
// @opentui/solid's solid transform, so src/tui.tsx compiles here the way the
// host compiles it and the fine-grained reactivity under test is genuine.
//
// Frame waits go through the harness's settleFrame, whose budget means
// wall-clock seconds: the sidebar renders "starting…" until the async
// first-load (settings + activity file reads) settles, and opentui's own
// waitForFrame gives up the moment the renderer's scheduler is idle with
// nothing queued — exactly the state it sits in while those reads are still
// out on the event loop, so under CI load the frame froze at "starting…"
// (the WP8 flake, three cross-branch CI hits on 2026-08-01). The explicit
// 4s budget at each call site absorbs a loaded CI's late reads.
const mountSlot = createSlotMounter({ width: 60, height: 12 })

async function renderSidebar(
  harness: ReturnType<typeof makeApi>,
  sessionID = "ses_1",
  width = 60,
) {
  return mountSlot(harness, { sessionID, width })
}

// The shared gating triad (floor-silent, untested-warns-naming-the-version,
// unknown-warns, non-v1 inert). URL locality does not decide registration:
// filesystem access is separately gated by a fresh proof from the server.
describeGating({
  remoteBails: false,
  load: async (input) => {
    const harness = makeApi(input)
    await loadTui(harness)
    return {
      toasts: harness.toasts,
      registered: harness.layers.length === 1,
      inert:
        harness.layers.length === 0 &&
        harness.slotPlugins.length === 0 &&
        harness.handlers.size === 0,
    }
  },
})

describe("filesystem locality", () => {
  test.each([true, false])(
    "concurrent commands waiting for adoption share one check (%s)",
    async (shared) => {
      const adoption = Promise.withResolvers<boolean>()
      const check = Promise.withResolvers<boolean>()
      const verify = spyOn(permissionRules, "verifyFilesystemLocality")
        .mockImplementationOnce(() => adoption.promise)
        .mockImplementationOnce(() => check.promise)
        // A competing same-epoch check would return the opposite result.
        .mockResolvedValue(!shared)
      const watch = spyOn(nodeFs, "watchFile")
      const unwatch = spyOn(nodeFs, "unwatchFile")
      const harness = makeApi({ routeName: "home" })
      const runs: Promise<void>[] = []
      try {
        await tui(harness.api as unknown as Api, undefined, {
          state: "first",
        } as any)
        await until(() => verify.mock.calls.length === 1)
        runs.push(command(harness, "permissions_approve_for_me.toggle")())
        runs.push(command(harness, "permissions_approve_for_me.trust")())
        adoption.resolve(true)
        await until(() => verify.mock.calls.length >= 2)
        check.resolve(shared)
        await Promise.all(runs)

        expect(verify).toHaveBeenCalledTimes(2)
        expect(
          watch.mock.calls.filter(([file]) => file === projectSettingsFile()),
        ).toHaveLength(1)
        if (shared) {
          expect(
            await readOverride(overrideFile(stateDir(), root)),
          ).toMatchObject({
            enabled: false,
          })
          expect(
            harness.toasts.every((toast) => toast.variant === "info"),
          ).toBe(true)
          expect(unwatch).not.toHaveBeenCalled()
        } else {
          expect(await fs.exists(overrideFile(stateDir(), root))).toBe(false)
          expect(harness.toasts).toEqual([
            expect.objectContaining({
              variant: "warning",
              message: expect.stringContaining("Server settings are unchanged"),
            }),
          ])
          expect(unwatch.mock.calls).toHaveLength(watch.mock.calls.length)
          expect(unwatch.mock.calls).toEqual(
            expect.arrayContaining(
              watch.mock.calls.map((call) => [call[0], call.at(-1)]),
            ),
          )
          const view = await renderSidebar(harness)
          await settleFrame(view, "state unknown", 4_000)
        }
      } finally {
        adoption.resolve(false)
        check.resolve(false)
        await Promise.allSettled(runs)
        await harness.dispose()
        verify.mockRestore()
        watch.mockRestore()
        unwatch.mockRestore()
      }
    },
  )

  test.each([
    [true, true],
    [false, true],
    [true, false],
  ])(
    "a stale check (%s) cannot revive state or clear a newer reconnect flight (%s)",
    async (staleShared, reconnectedShared) => {
      await writeJson(projectSettingsFile(), { enabled: false })
      const verify = spyOn(
        permissionRules,
        "verifyFilesystemLocality",
      ).mockResolvedValue(true)
      const watch = spyOn(nodeFs, "watchFile")
      const unwatch = spyOn(nodeFs, "unwatchFile")
      const harness = makeApi()
      const stale = Promise.withResolvers<boolean>()
      const reconnected = Promise.withResolvers<boolean>()
      const runs: Promise<void>[] = []
      try {
        await tui(harness.api as unknown as Api, undefined, {
          state: "first",
        } as any)
        await command(harness, "permissions_approve_for_me.trust")()
        const view = await renderSidebar(harness)
        await settleFrame(view, "off", 4_000)
        const watched = [...watch.mock.calls]
        expect(
          watched.some(([file]) => file === sessionModelPath("ses_1")),
        ).toBe(true)
        harness.toasts.length = 0
        verify.mockClear()
        verify
          .mockImplementationOnce(() => stale.promise)
          .mockImplementationOnce(() => reconnected.promise)
          .mockResolvedValue(false)

        const toggle = command(harness, "permissions_approve_for_me.toggle")()
        runs.push(toggle)
        await until(() => verify.mock.calls.length === 1)
        harness.emit("server.connected", {})
        await until(() => verify.mock.calls.length >= 2)
        expect(unwatch.mock.calls).toHaveLength(watched.length)
        expect(unwatch.mock.calls).toEqual(
          expect.arrayContaining(watched.map((call) => [call[0], call.at(-1)])),
        )

        stale.resolve(staleShared)
        await toggle
        expect(await fs.exists(overrideFile(stateDir(), root))).toBe(false)
        expect(harness.toasts).toEqual([])
        expect(watch).toHaveBeenCalledTimes(watched.length)
        await settleFrame(view, "starting", 4_000)

        const joined = command(harness, "permissions_approve_for_me.trust")()
        runs.push(joined)
        // Let the command's owner discovery settle before releasing the proof
        // it must join; adoption is no longer a cached one-shot promise.
        await Bun.sleep(0)
        reconnected.resolve(reconnectedShared)
        await joined
        expect(verify).toHaveBeenCalledTimes(2)
        expect(unwatch.mock.calls).toHaveLength(watched.length)
        expect(watch).toHaveBeenCalledTimes(
          watched.length * (reconnectedShared ? 2 : 1),
        )
        expect(harness.toasts).toEqual([
          expect.objectContaining({
            variant: reconnectedShared ? "info" : "warning",
            message: expect.stringContaining(
              reconnectedShared
                ? "No project-local OpenCode config"
                : "Server settings are unchanged",
            ),
          }),
        ])
        await settleFrame(
          view,
          reconnectedShared ? "off" : "state unknown",
          4_000,
        )
      } finally {
        stale.resolve(false)
        reconnected.resolve(false)
        await Promise.allSettled(runs)
        await harness.dispose()
        verify.mockRestore()
        watch.mockRestore()
        unwatch.mockRestore()
      }
    },
  )

  test("a successful in-flight check cannot revive disposed controls or watchers", async () => {
    await writeJson(projectSettingsFile(), { enabled: false })
    const verify = spyOn(
      permissionRules,
      "verifyFilesystemLocality",
    ).mockResolvedValue(true)
    const watch = spyOn(nodeFs, "watchFile")
    const unwatch = spyOn(nodeFs, "unwatchFile")
    const harness = makeApi()
    const check = Promise.withResolvers<boolean>()
    let toggle: Promise<void> | undefined
    try {
      await tui(harness.api as unknown as Api, undefined, {
        state: "first",
      } as any)
      await command(harness, "permissions_approve_for_me.trust")()
      const view = await renderSidebar(harness)
      await settleFrame(view, "off", 4_000)
      const watched = [...watch.mock.calls]
      expect(watched.some(([file]) => file === sessionModelPath("ses_1"))).toBe(
        true,
      )
      harness.toasts.length = 0
      verify.mockClear()
      // Ignore the lifecycle signal to exercise the TUI's own disposal guard.
      verify.mockImplementationOnce(() => check.promise)
      toggle = command(harness, "permissions_approve_for_me.toggle")()
      await until(() => verify.mock.calls.length === 1)
      await harness.dispose()
      expect(unwatch.mock.calls).toHaveLength(watched.length)
      expect(unwatch.mock.calls).toEqual(
        expect.arrayContaining(watched.map((call) => [call[0], call.at(-1)])),
      )

      check.resolve(true)
      await toggle
      harness.emit("server.connected", {})
      await command(harness, "permissions_approve_for_me.trust")()
      expect(verify).toHaveBeenCalledTimes(1)
      expect(watch).toHaveBeenCalledTimes(watched.length)
      expect(unwatch).toHaveBeenCalledTimes(watched.length)
      expect(await fs.exists(overrideFile(stateDir(), root))).toBe(false)
      expect(harness.toasts).toEqual([])
    } finally {
      check.resolve(false)
      await toggle
      await harness.dispose()
      verify.mockRestore()
      watch.mockRestore()
      unwatch.mockRestore()
    }
  })

  test("redirected policy files require proof in their actual parent directories", async () => {
    const privateDir = path.join(stateDir(), "private-blessing")
    const target = path.join(privateDir, "record.json")
    await writeJson(target, { files: {}, at: 1 })
    await fs.mkdir(path.dirname(blessFile(stateDir(), root)), {
      recursive: true,
    })
    await fs.symlink(target, blessFile(stateDir(), root))
    const globalDir = path.join(configDir(), "config-target")
    const globalTarget = path.join(globalDir, "settings.json")
    await writeJson(globalTarget, { plugin: [PLUGIN_NAME] })
    await fs.symlink(globalTarget, globalConfigFile())
    const trusted = await resolveTrustedSettingsPaths(
      root,
      configDir(),
      stateDir(),
      path.join(sandboxRoot, "data"),
      INSTANCE_ID,
      { migrate: false },
    )
    expect(trusted?.blessPath).toBe(target)
    if (!trusted) throw new Error("expected trusted redirected paths")
    const scopes = await settingsLocalityPaths(trusted)
    expect(scopes).toContain(privateDir)
    expect(scopes).toContain(globalDir)

    const harness = makeApi()
    const publish = harness.api.client.tui.publish
    harness.api.client.tui.publish = async (payload: {
      body: { properties: { command: string } }
    }) => {
      const result = await publish(payload)
      if (payload.body.properties.command.includes(":probe:")) {
        // A shared state parent does not expose files on a private submount.
        for (const file of await fs.readdir(privateDir)) {
          if (file.startsWith(".macarons-locality-"))
            await fs.rename(
              path.join(privateDir, file),
              path.join(sandboxRoot, file),
            )
        }
      }
      return result
    }
    await loadTui(harness)
    await command(harness, "permissions_approve_for_me.trust")()
    expect(harness.selects).toEqual([])
    expect(await readJson(target)).toEqual({ files: {}, at: 1 })
    expect(harness.toasts.at(-1)?.message).toContain(
      "classification may still be active",
    )
  }, 15_000)

  test("unshared startup leaves legacy local policy untouched", async () => {
    const legacy = preSlugProjectSettingsFile(configDir(), root)
    await writeJson(legacy, { enabled: false, model: "e2e/other" })
    const before = (await fs.readdir(sandboxRoot, { recursive: true })).sort()
    const harness = makeApi({
      baseUrl: "https://remote.example",
      sharedFilesystem: false,
    })
    await loadTui(harness)
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(await readJson(legacy)).toEqual({
      enabled: false,
      model: "e2e/other",
    })
    expect(await fs.exists(projectSettingsFile())).toBe(false)
    expect((await fs.readdir(sandboxRoot, { recursive: true })).sort()).toEqual(
      before,
    )
  })

  test("reconnect invalidates a toggle waiting on the first policy read", async () => {
    await writeJson(projectSettingsFile(), { enabled: true })
    const realRead = fs.readFile.bind(fs)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let reading = false
    const read = spyOn(fs, "readFile").mockImplementation((async (
      file: any,
      options: any,
    ) => {
      if (String(file) === projectSettingsFile() && !reading) {
        reading = true
        await held
      }
      return realRead(file, options)
    }) as typeof fs.readFile)
    const harness = makeApi()
    const publish = harness.api.client.tui.publish
    let proofs = 0
    harness.api.client.tui.publish = async (payload: {
      body: { properties: { command: string } }
    }) => {
      const result = await publish(payload)
      if (payload.body.properties.command.includes(":cleanup:")) proofs++
      return result
    }
    try {
      await loadTui(harness)
      await until(() => reading)
      const toggled = command(harness, "permissions_approve_for_me.toggle")()
      await until(() => proofs >= 2)
      harness.api.client.tui.publish = async () => ({
        error: "new server has different storage",
      })
      harness.emit("server.connected", {})
      release()
      await toggled
      expect(await fs.exists(overrideFile(stateDir(), root))).toBe(false)
      expect(
        harness.toasts.some((toast) =>
          String(toast.message).includes("OFF for this instance"),
        ),
      ).toBe(false)
      const view = await renderSidebar(harness)
      expect(await settleFrame(view, "state unknown", 4_000)).not.toContain(
        "off (this instance)",
      )
    } finally {
      release()
      read.mockRestore()
    }
  })

  test("losing sharing during the scope picker does not read a local session pin", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    const open = spyOn(fs, "open")
    try {
      harness.api.client.tui.publish = async () => ({
        error: "different server",
      })
      harness.selects[0]!.onSelect({ title: "This session", value: "session" })
      await run
      expect(harness.selects).toHaveLength(1)
      expect(
        open.mock.calls.some(
          ([file]) => String(file) === sessionModelPath("ses_1"),
        ),
      ).toBe(false)
      expect(harness.toasts.at(-1)?.message).toContain(
        "classification may still be active",
      )
    } finally {
      open.mockRestore()
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
    "%s cannot authorize controls through matching writable paths",
    async (baseUrl) => {
      const before = (await fs.readdir(sandboxRoot, { recursive: true })).sort()
      const harness = makeApi({ baseUrl, sharedFilesystem: false })
      await loadTui(harness)
      for (const entry of harness.layers[0]!.commands) await entry.run()

      expect(harness.selects).toEqual([])
      expect(
        (await fs.readdir(sandboxRoot, { recursive: true })).sort(),
      ).toEqual(before)
      expect(
        harness.toasts.some((toast) =>
          /OFF|ON for this instance|saved|Trusted \d/.test(
            String(toast.message),
          ),
        ),
      ).toBe(false)
      expect(harness.toasts.at(-1)?.message).toContain(
        "classification may still be active",
      )
      const view = await renderSidebar(harness)
      const frame = await settleFrame(view, "state unknown", 4_000)
      expect(frame).not.toContain("off (this instance)")
    },
  )

  test.each(["", "missing"])(
    "unverified paths (%s) cannot create permission files",
    async (kind) => {
      const harness = makeApi({
        baseUrl: "http://127.0.0.1:4096",
        sharedFilesystem: false,
        configPath: kind ? path.join(sandboxRoot, "missing-config") : "",
        statePath: kind ? path.join(sandboxRoot, "missing-state") : "",
        worktree: kind ? path.join(sandboxRoot, "missing-project") : "",
        directory: kind ? path.join(sandboxRoot, "missing-project") : "",
      })
      await loadTui(harness)
      await command(harness, "permissions_approve_for_me.toggle")()
      expect(await fs.exists(path.join(sandboxRoot, "missing-config"))).toBe(
        false,
      )
      expect(await fs.exists(path.join(sandboxRoot, "missing-state"))).toBe(
        false,
      )
      expect(
        harness.toasts.some((toast) =>
          String(toast.message).includes("OFF for this instance"),
        ),
      ).toBe(false)
    },
  )

  test("a loopback attach with a fresh server proof can toggle", async () => {
    const harness = makeApi({ baseUrl: "http://127.0.0.1:4096" })
    await loadTui(harness)
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(await readOverride(overrideFile(stateDir(), root))).toMatchObject({
      enabled: false,
    })
    expect(harness.toasts.at(-1)?.message).toContain("OFF for this instance")
  })

  test("a dialog cannot save after losing shared filesystem access", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.default")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "Disabled", value: false })
    await until(() => harness.selects.length === 2)
    harness.api.client.tui.publish = async () => ({
      error: "connection changed",
    })
    harness.selects[1]!.onSelect({ title: "This project", value: "project" })
    await run
    expect(await fs.exists(projectSettingsFile())).toBe(false)
    expect(harness.toasts.at(-1)?.message).toContain(
      "Server settings are unchanged",
    )
  })

  test("a replacement owner's mirror cannot be replaced by an old session-model dialog", async () => {
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: Date.now() },
      requests: {},
    })
    const nextID = randomUUID()
    await writeJson(overrideFile(stateDir(), root, nextID), {
      enabled: false,
      at: 1,
    })
    const harness = makeApi()
    await loadTui(harness)
    const view = await renderSidebar(harness)
    await settleFrame(view, "on · session model", 4_000)
    const run = command(harness, "permissions_approve_for_me.model")()
    try {
      await until(() => harness.selects.length === 1)
      harness.setInstanceID(nextID)
      harness.emit("server.connected", {})
      await settleFrame(view, "off (this instance)", 4_000)
      harness.selects[0]!.onSelect({ title: "This session", value: "session" })
      await run
      expect(harness.selects).toHaveLength(1)
      expect(harness.toasts.at(-1)?.message).toContain(
        "Server instance changed",
      )
      expect(await fs.exists(sessionModelPath("ses_1"))).toBe(false)
      expect(await fs.exists(overrideFile(stateDir(), root))).toBe(false)
      expect(
        await readOverride(overrideFile(stateDir(), root, nextID)),
      ).toEqual({
        enabled: false,
        at: 1,
      })
      expect(
        await settleFrame(view, "off (this instance)", 4_000),
      ).not.toContain("on · session model")
    } finally {
      harness.api.ui.dialog.clear()
      await run
    }
  })

  test("an old owner's successful proof cannot authorize a replacement owner", async () => {
    const oldOverride = overrideFile(stateDir(), root)
    await writeJson(oldOverride, { enabled: false, at: 1 })
    const oldBytes = await fs.readFile(oldOverride, "utf8")
    const nextID = randomUUID()
    const proof = Promise.withResolvers<boolean>()
    const verify = spyOn(permissionRules, "verifyFilesystemLocality")
      .mockImplementationOnce(() => proof.promise)
      .mockResolvedValue(false)
    const watching = spyOn(nodeFs, "watchFile")
    const harness = makeApi()
    try {
      await loadTui(harness)
      await until(() => verify.mock.calls.length === 1)
      harness.setInstanceID(nextID)
      harness.emit("global.disposed", {})
      proof.resolve(true)
      await until(() => verify.mock.calls.length >= 2)
      await command(harness, "permissions_approve_for_me.toggle")()
      expect(watching).not.toHaveBeenCalled()
      expect(await fs.readFile(oldOverride, "utf8")).toBe(oldBytes)
      expect(await fs.exists(overrideFile(stateDir(), root, nextID))).toBe(
        false,
      )
      expect(harness.toasts.at(-1)?.message).toContain(
        "classification may still be active",
      )
      const view = await renderSidebar(harness)
      expect(await settleFrame(view, "state unknown", 4_000)).not.toContain(
        "off",
      )
    } finally {
      proof.resolve(false)
      await harness.dispose()
      verify.mockRestore()
      watching.mockRestore()
    }
  })
})

describe("registration", () => {
  test("five palette commands and the default toggle keybind", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const layer = harness.layers[0]!
    expect(layer.commands.map((entry: any) => entry.name)).toEqual([
      "permissions_approve_for_me.toggle",
      "permissions_approve_for_me.model",
      "permissions_approve_for_me.timeout",
      "permissions_approve_for_me.default",
      "permissions_approve_for_me.trust",
    ])
    // Only the first alternative is bound to the command name — the palette's
    // keybind hint shows exactly the bindings registered under that name, and
    // a two-alternative hint clips the command title. The second alternative
    // dispatches through a function cmd the hint cannot see.
    expect(layer.bindings).toHaveLength(2)
    expect(layer.bindings[0].key).toBe("<leader>d")
    expect(layer.bindings[0].cmd).toBe("permissions_approve_for_me.toggle")
    expect(layer.bindings[1].key).toBe("ctrl+alt+a")
    expect(typeof layer.bindings[1].cmd).toBe("function")
  })

  test("the undisplayed alternative still toggles the instance override", async () => {
    const harness = makeApi()
    await loadTui(harness)
    harness.layers[0]!.bindings[1].cmd()
    await until(() => harness.toasts.length > 0)
    expect(await readOverride(overrideFile(stateDir(), root))).toMatchObject({
      enabled: false,
    })
    expect(harness.toasts.at(-1)?.message).toContain("OFF for this instance")
  })

  test('keybind "none" leaves only the palette entries', async () => {
    const harness = makeApi()
    await loadTui(harness, { keybind: "none" })
    expect(harness.layers[0]!.bindings).toHaveLength(0)
  })

  // The example chords are chosen to be free in the stock 1.17-1.18 keymaps
  // (ctrl+alt+p is which-key scroll — a collision users should not be shown,
  // even in test data).
  test("a single custom keybind is used verbatim and displayed", async () => {
    const harness = makeApi()
    await loadTui(harness, { keybind: "ctrl+alt+x" })
    expect(harness.layers[0]!.bindings).toHaveLength(1)
    expect(harness.layers[0]!.bindings[0].key).toBe("ctrl+alt+x")
    expect(harness.layers[0]!.bindings[0].cmd).toBe(
      "permissions_approve_for_me.toggle",
    )
  })

  test("custom alternatives beyond the first stay bound but undisplayed", async () => {
    const harness = makeApi()
    await loadTui(harness, { keybind: "ctrl+alt+x, <leader>z ,ctrl+alt+q" })
    const bindings = harness.layers[0]!.bindings
    expect(bindings).toHaveLength(2)
    expect(bindings[0].key).toBe("ctrl+alt+x")
    expect(bindings[0].cmd).toBe("permissions_approve_for_me.toggle")
    expect(bindings[1].key).toBe("<leader>z,ctrl+alt+q")
    expect(typeof bindings[1].cmd).toBe("function")
  })

  test("sidebar: false skips the status slot", async () => {
    const harness = makeApi()
    await loadTui(harness, { sidebar: false })
    expect(harness.slotPlugins).toHaveLength(0)
  })
})

describe("the instance toggle", () => {
  test("a legacy worktree settings file pauses and blocks partial project saves", async () => {
    await writeJson(legacySettingsFile(), { enabled: true, model: "e2e/other" })
    const harness = makeApi()
    await loadTui(harness)
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(await fs.exists(overrideFile(stateDir(), root))).toBe(false)
    expect(harness.toasts.at(-1)?.variant).toBe("warning")
    expect(harness.toasts.at(-1)?.message).toContain(
      "settings migration required",
    )

    const run = command(harness, "permissions_approve_for_me.default")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "Disabled", value: false })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({ title: "This project", value: "project" })
    await run
    expect(await fs.exists(projectSettingsFile())).toBe(false)
    expect(harness.toasts.at(-1)?.message).toContain("review and migrate")
  })

  test("unsafe config paths keep controls paused", async () => {
    const unsafeConfig = path.join(root, ".config")
    await fs.mkdir(unsafeConfig)
    const harness = makeApi({ configPath: unsafeConfig })
    await loadTui(harness)
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(await fs.exists(overrideFile(stateDir(), root))).toBe(false)
    expect(harness.toasts.at(-1)?.message).toContain("settings path unsafe")
  })

  test("a project save rechecks for a newly appeared legacy file", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.default")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "Disabled", value: false })
    await until(() => harness.selects.length === 2)
    await writeJson(legacySettingsFile(), { enabled: false })
    harness.selects[1]!.onSelect({ title: "This project", value: "project" })
    await run

    expect(await fs.exists(projectSettingsFile())).toBe(false)
    expect(harness.toasts.at(-1)?.message).toContain("review and migrate")
  })

  test("first toggle turns auto-approve off (default is on) and writes the override", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const before = Date.now()
    await command(harness, "permissions_approve_for_me.toggle")()
    const off = await readOverride(overrideFile(stateDir(), root))
    expect(off?.enabled).toBe(false)
    // Every toggle write is stamped so the server half can prove a mid-wait
    // toggle-off to the unattended-deny timer, re-enable or not.
    expect(off?.at).toBeGreaterThanOrEqual(before)
    expect(off?.at).toBeLessThanOrEqual(Date.now())
    expect(harness.toasts.at(-1)?.message).toContain("OFF for this instance")

    await command(harness, "permissions_approve_for_me.toggle")()
    const on = await readOverride(overrideFile(stateDir(), root))
    expect(on?.enabled).toBe(true)
    expect(on?.at).toBeGreaterThanOrEqual(off?.at ?? Number.NaN)
    expect(harness.toasts.at(-1)?.message).toContain("ON for this instance")
  })

  test("with a disabled persistent default, the first toggle turns it ON", async () => {
    await fs.mkdir(path.dirname(projectSettingsFile()), { recursive: true })
    await fs.writeFile(
      projectSettingsFile(),
      JSON.stringify({ enabled: false }),
    )
    const harness = makeApi()
    await loadTui(harness)
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(await readOverride(overrideFile(stateDir(), root))).toMatchObject({
      enabled: true,
    })
  })

  test("an override written by another TUI is reflected before the next toggle", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const file = overrideFile(stateDir(), root)
    await writeJson(file, { enabled: false })
    await Bun.sleep(600)

    await command(harness, "permissions_approve_for_me.toggle")()
    expect(await readOverride(file)).toMatchObject({ enabled: true })
  })

  test("two servers sharing all paths and URL keep interleaved TUI toggles isolated", async () => {
    const otherID = randomUUID()
    const first = makeApi()
    const second = makeApi({ instanceID: otherID })
    await loadTui(first)
    await command(first, "permissions_approve_for_me.toggle")()
    const firstFile = overrideFile(stateDir(), root)
    const originalOff = await fs.readFile(firstFile, "utf8")

    await loadTui(second)
    expect(await fs.readFile(firstFile, "utf8")).toBe(originalOff)
    await command(second, "permissions_approve_for_me.toggle")()
    const secondFile = overrideFile(stateDir(), root, otherID)
    expect(await readOverride(secondFile)).toMatchObject({ enabled: false })
    await command(second, "permissions_approve_for_me.toggle")()
    expect(await readOverride(secondFile)).toMatchObject({ enabled: true })
    expect(await fs.readFile(firstFile, "utf8")).toBe(originalOff)

    await second.dispose()
    expect(await fs.readFile(firstFile, "utf8")).toBe(originalOff)
    await command(first, "permissions_approve_for_me.toggle")()
    expect(await readOverride(firstFile)).toMatchObject({ enabled: true })
  })

  test("two TUIs attached to one owner share its toggle without waiting for the file watcher", async () => {
    const first = makeApi()
    const second = makeApi()
    await loadTui(first)
    await loadTui(second)
    await command(first, "permissions_approve_for_me.toggle")()
    expect(await readOverride(overrideFile(stateDir(), root))).toMatchObject({
      enabled: false,
    })
    await command(second, "permissions_approve_for_me.toggle")()
    expect(await readOverride(overrideFile(stateDir(), root))).toMatchObject({
      enabled: true,
    })
    await first.dispose()
    await command(second, "permissions_approve_for_me.toggle")()
    expect(await readOverride(overrideFile(stateDir(), root))).toMatchObject({
      enabled: false,
    })
  })

  test.each(["pre-write", "confirmation"])(
    "a superseded %s read uses the newer completed value instead of treating the file as missing",
    async (phase) => {
      const file = overrideFile(stateDir(), root)
      await writeJson(file, { enabled: true, at: 1 })
      await writeJson(activityFile(stateDir(), root), {
        server: { state: "ready", time: Date.now() },
        requests: {},
      })
      const harness = makeApi()
      await loadTui(harness)
      const sidebar = await renderSidebar(harness)
      await settleFrame(sidebar, "on · session model", 4_000)
      const readFile = fs.readFile.bind(fs)
      const rename = fs.rename.bind(fs)
      const publish = harness.api.client.tui.publish
      const releaseFirst = Promise.withResolvers<void>()
      let waiting = false
      let watcherReading = false
      let wrote = false
      let confirming = false
      harness.api.client.tui.publish = async (input: unknown) => {
        const result = await publish(input)
        if (wrote) confirming = true
        return result
      }
      const renaming = spyOn(fs, "rename").mockImplementation(
        async (from, to) => {
          await rename(from, to)
          if (String(to) === file) wrote = true
        },
      )
      const reading = spyOn(fs, "readFile").mockImplementation((async (
        target: Parameters<typeof fs.readFile>[0],
        options: Parameters<typeof fs.readFile>[1],
      ) => {
        const bytes = await readFile(target, options)
        if (String(target) !== file) return bytes
        if (!waiting && (phase === "pre-write" || confirming)) {
          waiting = true
          await releaseFirst.promise
        } else if (waiting) {
          watcherReading = true
        }
        return bytes
      }) as typeof fs.readFile)
      const pending = command(harness, "permissions_approve_for_me.toggle")()
      try {
        await until(() => waiting)
        if (phase === "pre-write") {
          await writeJson(file, { enabled: false, at: 2 })
        }
        await settleFrame(sidebar, "off (this instance)", 4_000)
        expect(watcherReading).toBe(true)
        releaseFirst.resolve()
        await pending
        expect(harness.toasts.at(-1)?.message).toContain(
          phase === "pre-write"
            ? "ON for this instance"
            : "OFF for this instance",
        )
        expect(await readOverride(file)).toMatchObject({
          enabled: phase === "pre-write",
        })
      } finally {
        releaseFirst.resolve()
        await pending
        reading.mockRestore()
        renaming.mockRestore()
      }
    },
  )

  test("ongoing watcher refreshes cannot starve either phase of a toggle", async () => {
    const file = overrideFile(stateDir(), root)
    const activity = activityFile(stateDir(), root)
    await writeJson(file, { enabled: true, at: 1 })
    await writeJson(activity, {
      server: { state: "ready", time: Date.now() },
      requests: {},
    })
    const harness = makeApi()
    const watching = spyOn(nodeFs, "watchFile")
    try {
      await loadTui(harness)
      const sidebar = await renderSidebar(harness)
      await settleFrame(sidebar, "on · session model", 4_000)
      const watchers = watching.mock.calls as unknown as Array<
        [string, unknown, () => void]
      >
      const refresh = watchers.find((call) => call[0] === activity)?.[2]
      if (!refresh) throw new Error("missing activity watcher")
      // Deliver the recorded callbacks ourselves so every notification
      // deterministically overlaps a held override read.
      for (const call of watchers) nodeFs.unwatchFile(call[0])
      const readFile = fs.readFile.bind(fs)
      const held: Array<() => void> = []
      let blocking = true
      const reading = spyOn(fs, "readFile").mockImplementation((async (
        target: Parameters<typeof fs.readFile>[0],
        options: Parameters<typeof fs.readFile>[1],
      ) => {
        const bytes = await readFile(target, options)
        if (String(target) === file && blocking) {
          const release = Promise.withResolvers<void>()
          held.push(release.resolve)
          await release.promise
        }
        return bytes
      }) as typeof fs.readFile)
      const pending = command(harness, "permissions_approve_for_me.toggle")()
      try {
        await until(() => held.length === 1)
        refresh()
        await until(() => held.length === 2)
        held[0]!()
        // The pre-write read must proceed despite the unfinished watcher,
        // writing OFF and reaching the confirmation read.
        await until(() => held.length === 3)
        refresh()
        await until(() => held.length === 4)
        held[2]!()
        // Confirmation likewise must not wait for a newer pending watcher.
        await until(() => harness.toasts.length > 0)
        await pending
        expect(harness.toasts.at(-1)?.message).toContain(
          "OFF for this instance",
        )
        expect(JSON.parse(await readFile(file, "utf8")).enabled).toBe(false)
        held[1]!()
        expect(
          await settleFrame(sidebar, "off (this instance)", 4_000),
        ).not.toContain("on · session model")
      } finally {
        blocking = false
        for (const release of held) release()
        await pending
        reading.mockRestore()
      }
    } finally {
      watching.mockRestore()
    }
  })

  test("a delayed confirmation cannot restore OFF after another attached TUI has toggled ON", async () => {
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: Date.now() },
      requests: {},
    })
    const first = makeApi()
    const second = makeApi()
    await loadTui(first)
    await loadTui(second)
    const view = await renderSidebar(first)
    await settleFrame(view, "on · session model", 4_000)
    const publish = first.api.client.tui.publish
    const heldResponse = Promise.withResolvers<void>()
    let waiting = false
    first.api.client.tui.publish = async (input: unknown) => {
      // Hold the first discovery after the OFF write, not a particular
      // handshake call number (startup and pre-write probes may change).
      if (
        !waiting &&
        (await readOverride(overrideFile(stateDir(), root)))?.enabled === false
      ) {
        waiting = true
        await heldResponse.promise
      }
      return publish(input)
    }
    const pending = command(first, "permissions_approve_for_me.toggle")()
    try {
      await until(() => waiting)
      await settleFrame(view, "off (this instance)", 4_000)
      await command(second, "permissions_approve_for_me.toggle")()
      // Consume the ON file-watch notification before releasing A's older
      // confirmation. There will be no later file change to repair a stale UI.
      await settleFrame(view, "on · session model", 4_000)
      heldResponse.resolve()
      await pending
      expect(first.toasts.at(-1)?.message).toContain("Toggle state changed")
      expect(
        first.toasts.some((toast) =>
          toast.message.includes("OFF for this instance"),
        ),
      ).toBe(false)
      expect(
        await settleFrame(view, "on · session model", 4_000),
      ).not.toContain("off (this instance)")
      expect(await readOverride(overrideFile(stateDir(), root))).toMatchObject({
        enabled: true,
      })
    } finally {
      heldResponse.resolve()
      await pending
    }
  })

  test("a reconnected server gets its own files, leaving the old owner's OFF untouched", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const toggle = command(harness, "permissions_approve_for_me.toggle")
    await toggle()
    const firstFile = overrideFile(stateDir(), root)
    const originalOff = await fs.readFile(firstFile, "utf8")
    const nextID = randomUUID()
    harness.setInstanceID(nextID)
    await toggle()
    expect(
      await readOverride(overrideFile(stateDir(), root, nextID)),
    ).toMatchObject({ enabled: false })
    expect(await fs.readFile(firstFile, "utf8")).toBe(originalOff)
  })

  test("missing owner discovery cannot claim OFF or write a fallback and can recover", async () => {
    const harness = makeApi({ instanceID: null })
    await loadTui(harness)
    const toggle = command(harness, "permissions_approve_for_me.toggle")
    await toggle()
    expect(harness.toasts.at(-1)?.message).toContain(
      "server instance unavailable",
    )
    expect(await fs.exists(overrideFile(stateDir(), root))).toBe(false)
    harness.setInstanceID(INSTANCE_ID)
    await toggle()
    expect(await readOverride(overrideFile(stateDir(), root))).toMatchObject({
      enabled: false,
    })
    expect(harness.toasts.at(-1)?.message).toContain("OFF for this instance")
  })

  test("a server reload during the write cannot produce a successful OFF confirmation", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const file = overrideFile(stateDir(), root)
    const nextID = randomUUID()
    const rename = fs.rename.bind(fs)
    const intercepted = spyOn(fs, "rename").mockImplementation(
      async (from, to) => {
        await rename(from, to)
        if (String(to) === file) harness.setInstanceID(nextID)
      },
    )
    try {
      await command(harness, "permissions_approve_for_me.toggle")()
      expect(harness.toasts.at(-1)?.variant).toBe("warning")
      expect(harness.toasts.at(-1)?.message).toContain(
        "Server instance changed",
      )
      expect(
        harness.toasts.some((toast) =>
          toast.message.includes("OFF for this instance"),
        ),
      ).toBe(false)
      expect(await readOverride(file)).toMatchObject({ enabled: false })
      expect(await fs.exists(overrideFile(stateDir(), root, nextID))).toBe(
        false,
      )
    } finally {
      intercepted.mockRestore()
    }
  })

  test("passive rediscovery stops trusting a crashed owner's ready beacon", async () => {
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: Date.now() },
      requests: {},
    })
    const harness = makeApi()
    await loadTui(harness)
    const sidebar = await renderSidebar(harness)
    await settleFrame(sidebar, "on · session model", 4_000)
    harness.setInstanceID(null)
    // No transport hint or clock mock: only the periodic probe can notice
    // this crash. The ready beacon's timestamp does not establish liveness.
    const frame = await settleFrame(
      sidebar,
      "server instance unavailable",
      8_000,
    )
    expect(frame).not.toContain("on · session model")
    expect(await fs.exists(activityFile(stateDir(), root))).toBe(true)
  }, 12_000)

  test("a discovery timeout retains the activity mirror without trusting it or allowing a toggle", async () => {
    const file = activityFile(stateDir(), root)
    await writeJson(file, {
      server: { state: "ready", time: Date.now() },
      requests: {
        per_1: { state: "surfaced", reason: "before timeout", time: 1 },
      },
    })
    const harness = makeApi()
    harness.api.state.session.permission = () => [
      {
        id: "per_1",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["pwd"],
      },
    ]
    await loadTui(harness)
    const sidebar = await renderSidebar(harness)
    await settleFrame(sidebar, "before timeout", 4_000)
    const publish = harness.api.client.tui.publish
    // The HTTP request succeeds, but the response event misses its deadline.
    harness.api.client.tui.publish = async () => ({ data: true })
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(harness.toasts.at(-1)?.message).toContain(
      "server instance unavailable",
    )
    expect(await fs.exists(overrideFile(stateDir(), root))).toBe(false)
    await writeJson(file, {
      server: { state: "ready", time: Date.now() },
      requests: {
        per_1: { state: "surfaced", reason: "after timeout", time: 2 },
      },
    })
    const frame = await settleFrame(sidebar, "after timeout", 4_000)
    expect(frame).toContain("server instance unavailable")
    expect(frame).not.toContain("on · session model")

    harness.api.client.tui.publish = publish
    harness.emit("server.connected", {})
    const recovered = await settleFrame(sidebar, "on · session model", 4_000)
    expect(recovered).toContain("after timeout")
  })

  test.each([
    "server.connected",
    "global.disposed",
    "server.instance.disposed",
  ])(
    "%s rediscovers a replacement owner without waiting for the periodic probe",
    async (event) => {
      await writeJson(activityFile(stateDir(), root), {
        server: { state: "ready", time: Date.now() },
        requests: {},
      })
      const harness = makeApi()
      await loadTui(harness)
      const sidebar = await renderSidebar(harness)
      await settleFrame(sidebar, "on · session model", 4_000)
      const nextID = randomUUID()
      await writeJson(activityFile(stateDir(), root, nextID), {
        server: {
          state: "paused",
          reason: "replacement owner",
          time: Date.now(),
        },
        requests: {},
      })
      harness.setInstanceID(nextID)
      harness.emit(event, { directory: root })
      expect(
        await settleFrame(sidebar, "replacement owner", 4_000),
      ).not.toContain("on · session model")
    },
  )

  test("unrelated instance disposal does not invalidate this owner's discovery", async () => {
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: Date.now() },
      requests: {},
    })
    const harness = makeApi()
    await loadTui(harness)
    const sidebar = await renderSidebar(harness)
    await settleFrame(sidebar, "on · session model", 4_000)
    const publish = spyOn(harness.api.client.tui, "publish")
    try {
      harness.emit("server.instance.disposed", { directory: `${root}/other` })
      await sidebar.renderOnce()
      expect(sidebar.captureCharFrame()).toContain("on · session model")
      expect(publish).not.toHaveBeenCalled()
    } finally {
      publish.mockRestore()
    }
  })

  test("a transport hint during discovery discards the old response and probes again", async () => {
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: Date.now() },
      requests: {},
    })
    const harness = makeApi()
    await loadTui(harness)
    const sidebar = await renderSidebar(harness)
    await settleFrame(sidebar, "on · session model", 4_000)
    const on = harness.api.event.on.bind(harness.api.event)
    let release: (() => void) | undefined
    const intercepted = spyOn(harness.api.event, "on").mockImplementation(
      (type, handler) =>
        on(type, (event) => {
          if (type === "tui.command.execute" && !release)
            release = () => handler(event)
          else handler(event)
        }),
    )
    try {
      harness.emit("server.connected", {})
      await until(() => !!release)
      harness.setInstanceID(null)
      harness.emit("global.disposed", {})
      release!()
      // Wait until the fresh probe has completed, then verify the delayed
      // old-owner response did not restore the stale ready claim.
      await until(() => !harness.handlers.get("tui.command.execute")?.length)
      expect(
        await settleFrame(sidebar, "server instance unavailable", 4_000),
      ).not.toContain("on · session model")
    } finally {
      release?.()
      intercepted.mockRestore()
    }
  })

  test("the ON toast names the judge as model · variant", async () => {
    await fs.mkdir(path.dirname(projectSettingsFile()), { recursive: true })
    await fs.writeFile(
      projectSettingsFile(),
      JSON.stringify({
        enabled: false,
        model: "e2e/reasoner",
        variant: "high",
      }),
    )
    const harness = makeApi()
    await loadTui(harness)
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(harness.toasts.at(-1)?.message).toContain("e2e/reasoner · high")
  })

  test("the ON toast follows the routed session model, with a persistent fallback off-session", async () => {
    await writeJson(projectSettingsFile(), {
      enabled: false,
      model: "e2e/test",
    })
    await writeSessionModel(sessionModelPath("ses_1"), {
      version: 1,
      rootSessionID: "ses_1",
      revision: "rev_toggle",
      mode: "override",
      model: "e2e/reasoner",
      variant: "high",
    })
    const routed = makeApi()
    await loadTui(routed)
    await command(routed, "permissions_approve_for_me.toggle")()
    expect(routed.toasts.at(-1)?.message).toContain(
      "e2e/reasoner · high · this session",
    )
    const otherState = path.join(sandboxRoot, "other-state")
    await fs.mkdir(otherState)
    const noRoute = makeApi({ routeName: "home", statePath: otherState })
    await loadTui(noRoute)
    await command(noRoute, "permissions_approve_for_me.toggle")()
    expect(noRoute.toasts.at(-1)?.message).toContain("e2e/test")
  })

  test("the ON toast retains its session-details warning for unresolved ancestry", async () => {
    await writeJson(projectSettingsFile(), {
      enabled: false,
      model: "e2e/test",
    })
    const harness = makeApi()
    harness.api.state.session.get = () => undefined
    await loadTui(harness)

    await command(harness, "permissions_approve_for_me.toggle")()

    expect(harness.toasts.at(-1)?.message).toContain(
      "session details are still syncing or unavailable",
    )
  })

  test("a corrupt settings file pauses the toggle fail-closed", async () => {
    await fs.mkdir(path.dirname(projectSettingsFile()), { recursive: true })
    await fs.writeFile(projectSettingsFile(), "{not json")
    const harness = makeApi()
    await loadTui(harness)
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(await fs.exists(overrideFile(stateDir(), root))).toBe(false)
    expect(harness.toasts.at(-1)?.variant).toBe("warning")
    expect(harness.toasts.at(-1)?.message).toContain("settings unreadable")
  })

  test("a rapid double-press toggles twice in order, not to the same target", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const toggle = command(harness, "permissions_approve_for_me.toggle")
    await Promise.all([toggle(), toggle()])
    // on → off → on: both presses honored, net unchanged — never two writes
    // of the same computed target.
    expect(await readOverride(overrideFile(stateDir(), root))).toMatchObject({
      enabled: true,
    })
    const messages = harness.toasts.map((toast) => toast.message)
    expect(messages.at(-2)).toContain("OFF for this instance")
    expect(messages.at(-1)).toContain("ON for this instance")
  })

  test("a keypress racing startup acts on disk state, not on defaults", async () => {
    await writeJson(projectSettingsFile(), { enabled: false })
    const harness = makeApi()
    // No settle sleep: the press lands before the first disk read finishes.
    await tui(harness.api as unknown as Api, undefined, {
      state: "first",
    } as any)
    await command(harness, "permissions_approve_for_me.toggle")()
    // Default-initialized signals would read "on" and toggle the instance
    // off; the persistent default on disk is off, so the press must turn it
    // ON.
    expect(await readOverride(overrideFile(stateDir(), root))).toMatchObject({
      enabled: true,
    })
    expect(harness.toasts.at(-1)?.message).toContain("ON for this instance")
  })

  test("the ON toast does not overpromise while the server beacon says paused", async () => {
    await writeJson(projectSettingsFile(), { enabled: false })
    await writeJson(activityFile(stateDir(), root), {
      server: {
        state: "paused",
        reason: "the permission store is unreadable or invalid JSON",
        time: Date.now(),
      },
      requests: {},
    })
    const harness = makeApi()
    await loadTui(harness)
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(await readOverride(overrideFile(stateDir(), root))).toMatchObject({
      enabled: true,
    })
    expect(harness.toasts.at(-1)?.variant).toBe("warning")
    expect(harness.toasts.at(-1)?.message).toContain(
      "but paused: the permission store is unreadable",
    )
  })

  test("the ON toast flags a pinned judge this instance cannot provide", async () => {
    await writeJson(projectSettingsFile(), {
      enabled: false,
      model: "e2e/ghost",
    })
    const harness = makeApi()
    await loadTui(harness)
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(harness.toasts.at(-1)?.variant).toBe("warning")
    expect(harness.toasts.at(-1)?.message).toContain(
      "pinned model e2e/ghost unavailable here",
    )

    await writeJson(projectSettingsFile(), {
      enabled: false,
      model: "e2e/reasoner",
      variant: "ultra",
    })
    await Bun.sleep(600) // watcher poll
    await command(harness, "permissions_approve_for_me.toggle")() // off again
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(harness.toasts.at(-1)?.message).toContain(
      'pinned variant "ultra" unavailable here',
    )
  })
})

// The non-git worktree "/" sentinel is hand-mirrored in both halves: the server
// collapses it at src/index.ts:381 (pinned by plugin.test.ts:3755), the TUI at
// src/tui.tsx:261 with a comment promising it is "the same as the server half".
// If the two disagree on the project root they key their instance files —
// activity (server → TUI) and override (TUI → server) — under different names,
// and the sidebar feed goes permanently empty while the toggle silently stops
// reaching the server, with no crash and no toast. These two tests drive both
// file channels through the toggle: the override write (readable directly) and
// the activity read (observable via the server-beacon toast, as at line 488).
describe("the non-git worktree '/' sentinel", () => {
  test("'/' keys activity (read) and override (write) from the session directory, same as the server half", async () => {
    // The server half wrote its beacon under the project ROOT key because it
    // collapses "/" to `directory` too; the TUI must read THAT file. A
    // persistent default of off makes the first toggle turn auto-approve ON, so
    // the beacon's "paused" surfaces in the ON toast.
    await writeJson(projectSettingsFile(), { enabled: false })
    await writeJson(activityFile(stateDir(), root), {
      server: {
        state: "paused",
        reason: "the permission store is unreadable or invalid JSON",
        time: Date.now(),
      },
      requests: {},
    })
    const harness = makeApi({ worktree: "/", directory: root })
    await loadTui(harness)
    await command(harness, "permissions_approve_for_me.toggle")()

    // TUI → server: the override lands on the server's key, not a "/"-derived one.
    expect(await readOverride(overrideFile(stateDir(), root))).toMatchObject({
      enabled: true,
    })
    expect(await fs.exists(overrideFile(stateDir(), "/"))).toBe(false)
    // server → TUI: the beacon on the server's key reached the toggle toast, so
    // the TUI read the correctly-keyed activity file.
    expect(harness.toasts.at(-1)?.variant).toBe("warning")
    expect(harness.toasts.at(-1)?.message).toContain(
      "but paused: the permission store is unreadable",
    )
  })

  test("a real worktree path keys instance files from the worktree, not the launch directory", async () => {
    // The git case: worktree is a real path distinct from the launch directory.
    // Both halves key by the worktree, so a mutant that collapsed root() to
    // `directory` would diverge. `elsewhere` stands in for a nested launch dir.
    const elsewhere = path.join(sandboxRoot, "elsewhere")
    await fs.mkdir(elsewhere)
    await writeJson(projectSettingsFile(), { enabled: false })
    await writeJson(activityFile(stateDir(), root), {
      server: {
        state: "paused",
        reason: "the permission store is unreadable or invalid JSON",
        time: Date.now(),
      },
      requests: {},
    })
    const harness = makeApi({ worktree: root, directory: elsewhere })
    await loadTui(harness)
    await command(harness, "permissions_approve_for_me.toggle")()

    expect(await readOverride(overrideFile(stateDir(), root))).toMatchObject({
      enabled: true,
    })
    expect(await fs.exists(overrideFile(stateDir(), elsewhere))).toBe(false)
    expect(harness.toasts.at(-1)?.variant).toBe("warning")
    expect(harness.toasts.at(-1)?.message).toContain(
      "but paused: the permission store is unreadable",
    )
  })
})

describe("the model picker", () => {
  test("refuses the session scope while routed session details are unavailable", async () => {
    const harness = makeApi({ routeSessionID: "ses_child" })
    harness.api.state.session.get = () => undefined
    await loadTui(harness)

    const first = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This session", value: "session" })
    await first
    expect(harness.toasts.at(-1)?.variant).toBe("warning")
    expect(harness.toasts.at(-1)?.message).toContain(
      "still syncing or unavailable",
    )

    harness.api.state.session.get = () => {
      throw new Error("session state is still syncing")
    }
    const second = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({ title: "This session", value: "session" })
    await second
    expect(harness.toasts.at(-1)?.message).toContain(
      "still syncing or unavailable",
    )
    expect(await fs.exists(sessionModelPath("ses_child"))).toBe(false)
    expect(await fs.exists(projectSettingsFile())).toBe(false)
    expect(await fs.exists(globalConfigFile())).toBe(false)
  })

  test("a settings edit outside this TUI refreshes the current classifier model", async () => {
    const harness = makeApi()
    await loadTui(harness)
    await writeJson(projectSettingsFile(), { model: "e2e/other" })
    await Bun.sleep(600)

    const done = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This project", value: "project" })
    await until(() => harness.selects.length === 2)
    expect(harness.selects[1]!.current).toBe("e2e/other")
    harness.api.ui.dialog.clear()
    await done
  })

  test("project and global model scopes are available without a routed session", async () => {
    await writeGlobalEntry({})
    const harness = makeApi({ routeName: "home" })
    await loadTui(harness)

    const project = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This project", value: "project" })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({ title: "Test model", value: "e2e/test" })
    await project
    expect(await readJson(projectSettingsFile())).toEqual({ model: "e2e/test" })

    const global = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 3)
    harness.selects[2]!.onSelect({
      title: "Global (all projects)",
      value: "global",
    })
    await until(() => harness.selects.length === 4)
    harness.selects[3]!.onSelect({ title: "Other", value: "e2e/other" })
    await global
    expect(await readGlobalEntryOptions()).toEqual({ model: "e2e/other" })
  })

  test("asks for scope before listing the session default and every provider model", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    expect(harness.selects[0]!.options.map((option) => option.value)).toEqual([
      "session",
      "project",
      "global",
    ])
    harness.selects[0]!.onSelect({ title: "This project", value: "project" })
    await until(() => harness.selects.length === 2)
    const options = harness.selects[1]!.options
    expect(options[0]!.title).toBe("Session model (default)")
    expect(options[0]!.value).toBeNull()
    const values = options.map((option) => option.value)
    expect(values).toContain("e2e/test")
    expect(values).toContain("e2e/other")
    expect(values).toContain("anthropic/claude-sonnet-5")
    harness.api.ui.dialog.clear() // dismiss
    await run
  })

  test("picking project scope writes only to the trusted OpenCode config directory", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This project", value: "project" })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({
      title: "Claude Sonnet 5",
      value: "anthropic/claude-sonnet-5",
    })
    await run

    expect(await readJson(projectSettingsFile())).toEqual({
      model: "anthropic/claude-sonnet-5",
    })
    expect(await fs.exists(legacySettingsFile())).toBe(false)
    expect(await fs.exists(path.join(root, ".opencode", ".gitignore"))).toBe(
      false,
    )
    expect(harness.toasts.at(-1)?.message).toContain(
      "anthropic/claude-sonnet-5",
    )
  })

  test('"Session model" with global scope writes model: null onto the global plugin entry', async () => {
    await writeGlobalEntry({ model: "e2e/other" })
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({
      title: "Global (all projects)",
      value: "global",
    })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({
      title: "Session model (default)",
      value: null,
    })
    await run

    expect(await readGlobalEntryOptions()).toEqual({ model: null })
    expect(harness.toasts.at(-1)?.message).toContain(
      "follows the session model",
    )
  })

  test("a global save without a global plugin entry fails with guidance, never inventing one", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({
      title: "Global (all projects)",
      value: "global",
    })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({
      title: "Test model",
      value: "e2e/test",
    })
    await run

    expect(await fs.exists(globalConfigFile())).toBe(false)
    expect(harness.toasts.at(-1)?.variant).toBe("error")
    expect(harness.toasts.at(-1)?.message).toContain(
      "no global opencode.json[c] declares this plugin",
    )
  })

  test("dismissing either step saves nothing", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const first = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.api.ui.dialog.clear()
    await first
    const second = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({ title: "This project", value: "project" })
    await until(() => harness.selects.length === 3)
    harness.api.ui.dialog.clear()
    await second

    expect(await fs.exists(projectSettingsFile())).toBe(false)
    expect(await fs.exists(globalSettingsFile())).toBe(false)
  })

  test("a corrupt settings file is never overwritten", async () => {
    await fs.mkdir(path.dirname(projectSettingsFile()), { recursive: true })
    await fs.writeFile(projectSettingsFile(), "{not json")
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This project", value: "project" })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({ title: "Test model", value: "e2e/test" })
    await run

    expect(await fs.readFile(projectSettingsFile(), "utf8")).toBe("{not json")
    expect(harness.toasts.at(-1)?.variant).toBe("error")
    expect(harness.toasts.at(-1)?.message).toContain("unreadable JSON")
  })

  test("a model with variants gets an effort step, and the pick saves with the model", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This project", value: "project" })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({
      title: "Reasoning model",
      value: "e2e/reasoner",
    })
    await until(() => harness.selects.length === 3)
    expect(harness.selects[2]!.title).toContain("effort")
    expect(harness.selects[2]!.options[0]!.title).toBe("Model default")
    expect(harness.selects[2]!.options[0]!.value).toBeNull()
    expect(harness.selects[2]!.options.map((option) => option.value)).toEqual([
      null,
      "high",
      "max",
    ])
    harness.selects[2]!.onSelect({ title: "high", value: "high" })
    await run

    expect(await readJson(projectSettingsFile())).toEqual({
      model: "e2e/reasoner",
      variant: "high",
    })
    expect(harness.toasts.at(-1)?.message).toContain("e2e/reasoner · high")
  })

  test("picking the model default saves no variant pin globally", async () => {
    await writeGlobalEntry({})
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({
      title: "Global (all projects)",
      value: "global",
    })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({
      title: "Reasoning model",
      value: "e2e/reasoner",
    })
    await until(() => harness.selects.length === 3)
    harness.selects[2]!.onSelect({ title: "Model default", value: null })
    await run

    expect(await readGlobalEntryOptions()).toEqual({
      model: "e2e/reasoner",
    })
  })

  test("a variant-less model skips the effort step and clears a stale variant pin", async () => {
    await fs.mkdir(path.dirname(projectSettingsFile()), { recursive: true })
    await fs.writeFile(
      projectSettingsFile(),
      JSON.stringify({ model: "e2e/reasoner", variant: "high" }),
    )
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This project", value: "project" })
    await until(() => harness.selects.length === 2)
    // No effort step for a variant-less model: it saves after the model pick.
    expect(harness.selects[1]!.title).toContain("classifier model")
    harness.selects[1]!.onSelect({ title: "Test model", value: "e2e/test" })
    await run

    expect(await readJson(projectSettingsFile())).toEqual({
      model: "e2e/test",
      variant: null,
    })
  })

  test("dismissing the effort step saves nothing", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This project", value: "project" })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({
      title: "Reasoning model",
      value: "e2e/reasoner",
    })
    await until(() => harness.selects.length === 3)
    harness.api.ui.dialog.clear()
    await run

    expect(await fs.exists(projectSettingsFile())).toBe(false)
    expect(await fs.exists(globalSettingsFile())).toBe(false)
  })

  test("preserves unrelated keys in the settings file", async () => {
    await fs.mkdir(path.dirname(projectSettingsFile()), { recursive: true })
    await fs.writeFile(
      projectSettingsFile(),
      JSON.stringify({ enabled: false, $schema: "x" }),
    )
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This project", value: "project" })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({ title: "Test model", value: "e2e/test" })
    await run

    expect(await readJson(projectSettingsFile())).toEqual({
      enabled: false,
      $schema: "x",
      model: "e2e/test",
    })
  })

  test("a session pin with an effort writes only its root record", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This session", value: "session" })
    await until(() => harness.selects.length === 2)
    expect(harness.selects[1]!.options[0]!.title).toBe(
      "Use project/global setting",
    )
    harness.selects[1]!.onSelect({
      title: "Reasoning model",
      value: "e2e/reasoner",
    })
    await until(() => harness.selects.length === 3)
    harness.selects[2]!.onSelect({ title: "high", value: "high" })
    await run

    const saved = await readSessionModel(sessionModelPath("ses_1"), "ses_1")
    expect(saved).toMatchObject({
      status: "valid",
      record: {
        version: 1,
        rootSessionID: "ses_1",
        mode: "override",
        model: "e2e/reasoner",
        variant: "high",
      },
    })
    expect(saved.status === "valid" && saved.record.revision).toBeTruthy()
    expect(await fs.exists(projectSettingsFile())).toBe(false)
    expect(await fs.exists(globalConfigFile())).toBe(false)
    expect(harness.toasts.at(-1)?.message).toContain("this session")
    await harness.dispose()
    expect(await readSessionModel(sessionModelPath("ses_1"), "ses_1")).toEqual(
      expect.objectContaining({ status: "valid" }),
    )
  })

  test("a session pin refuses to overwrite a file symlinked into the project", async () => {
    const sessionFile = sessionModelPath("ses_1")
    const planted = path.join(root, "planted-session-model.json")
    const original = {
      version: 1,
      rootSessionID: "ses_1",
      revision: "rev-planted",
      mode: "override",
      model: "e2e/other",
      variant: null,
    }
    await writeJson(planted, original)
    await fs.mkdir(path.dirname(sessionFile), { recursive: true })
    await fs.symlink(planted, sessionFile)
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This session", value: "session" })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({ title: "Test model", value: "e2e/test" })
    await run

    expect(harness.toasts.at(-1)?.message).toContain("path is not trusted")
    expect(await readJson(planted)).toEqual(original)
    expect((await fs.lstat(sessionFile)).isSymbolicLink()).toBe(true)
  })

  test("a matching session pin highlights its own effort", async () => {
    await writeSessionModel(sessionModelPath("ses_1"), {
      version: 1,
      rootSessionID: "ses_1",
      revision: "rev_max",
      mode: "override",
      model: "e2e/reasoner",
      variant: "max",
    })
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This session", value: "session" })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({
      title: "Reasoning model",
      value: "e2e/reasoner",
    })
    await until(() => harness.selects.length === 3)
    expect(harness.selects[2]!.current).toBe("max")
    harness.api.ui.dialog.clear()
    await run
  })

  test("re-saving an unchanged session pin preserves its revision", async () => {
    const file = sessionModelPath("ses_1")
    await writeSessionModel(file, {
      version: 1,
      rootSessionID: "ses_1",
      revision: "rev_unchanged",
      mode: "override",
      model: "e2e/reasoner",
      variant: "high",
    })
    const before = await fs.readFile(file, "utf8")
    const harness = makeApi()
    await loadTui(harness)

    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This session", value: "session" })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({
      title: "Reasoning model",
      value: "e2e/reasoner",
    })
    await until(() => harness.selects.length === 3)
    harness.selects[2]!.onSelect({ title: "high", value: "high" })
    await run

    expect(await fs.readFile(file, "utf8")).toBe(before)
  })

  test("session inherit unlinks its override, while Session model is an explicit null override", async () => {
    await writeSessionModel(sessionModelPath("ses_1"), {
      version: 1,
      rootSessionID: "ses_1",
      revision: "rev_existing",
      mode: "override",
      model: "e2e/other",
      variant: null,
    })
    const harness = makeApi()
    await loadTui(harness)

    const inherit = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This session", value: "session" })
    await until(() => harness.selects.length === 2)
    expect(harness.selects[1]!.current).toBe("e2e/other")
    const follow = harness.selects[1]!.options[0]!
    harness.selects[1]!.onSelect({ title: follow.title, value: follow.value })
    await inherit
    expect(await fs.exists(sessionModelPath("ses_1"))).toBe(false)
    expect(harness.toasts.at(-1)?.message).toContain("project/global")

    const explicit = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 3)
    harness.selects[2]!.onSelect({ title: "This session", value: "session" })
    await until(() => harness.selects.length === 4)
    expect(harness.selects[3]!.current).toBe(
      harness.selects[3]!.options[0]!.value,
    )
    const sessionDefault = harness.selects[3]!.options[1]!
    harness.selects[3]!.onSelect({
      title: sessionDefault.title,
      value: sessionDefault.value,
    })
    await explicit
    expect(await readSessionModel(sessionModelPath("ses_1"), "ses_1")).toEqual(
      expect.objectContaining({
        status: "valid",
        record: expect.objectContaining({
          mode: "override",
          model: null,
          variant: null,
        }),
      }),
    )
    expect(await fs.exists(projectSettingsFile())).toBe(false)
    expect(harness.toasts.at(-1)?.message).toContain("uses the session model")
  })

  test("session inherit refuses to clear a record changed during the picker", async () => {
    const file = sessionModelPath("ses_1")
    const original = {
      version: 1 as const,
      rootSessionID: "ses_1",
      revision: "rev_original",
      mode: "override" as const,
      model: "e2e/reasoner",
      variant: "high",
    }
    await writeSessionModel(file, original)
    const harness = makeApi()
    await loadTui(harness)

    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This session", value: "session" })
    await until(() => harness.selects.length === 2)
    const follow = harness.selects[1]!.options[0]!
    await writeSessionModel(file, {
      ...original,
      revision: "rev_concurrent",
      model: "e2e/other",
      variant: null,
    })
    harness.selects[1]!.onSelect({ title: follow.title, value: follow.value })
    await run

    expect(await readSessionModel(file, "ses_1")).toEqual(
      expect.objectContaining({
        status: "valid",
        record: expect.objectContaining({ revision: "rev_concurrent" }),
      }),
    )
    expect(harness.toasts.at(-1)?.variant).toBe("error")
    expect(harness.toasts.at(-1)?.message).toContain("changed while clearing")
  })

  test("session inherit reports a contended record as temporarily busy", async () => {
    const file = sessionModelPath("ses_1")
    const record = {
      version: 1 as const,
      rootSessionID: "ses_1",
      revision: "rev_busy",
      mode: "override" as const,
      model: "e2e/reasoner",
      variant: "high",
    }
    await writeSessionModel(file, record)
    const harness = makeApi()
    await loadTui(harness)

    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This session", value: "session" })
    await until(() => harness.selects.length === 2)
    const follow = harness.selects[1]!.options[0]!
    await fs.writeFile(`${file}.lock`, "peer lock")
    let now = Date.now()
    const clock = spyOn(Date, "now").mockImplementation(() => (now += 2_000))
    try {
      harness.selects[1]!.onSelect({ title: follow.title, value: follow.value })
      await run
    } finally {
      clock.mockRestore()
    }

    expect(await readSessionModel(file, "ses_1")).toEqual({
      status: "valid",
      record,
    })
    expect(harness.toasts.at(-1)?.variant).toBe("error")
    expect(harness.toasts.at(-1)?.message).toContain("temporarily busy")
    expect(harness.toasts.at(-1)?.message).toContain("try again")
    expect(harness.toasts.at(-1)?.message).not.toContain(
      "changed while clearing",
    )
  })

  test("requires a routed top-level session and never retargets an open flow", async () => {
    const noRoute = makeApi({ routeName: "home" })
    await loadTui(noRoute)
    const noRouteRun = command(noRoute, "permissions_approve_for_me.model")()
    await until(() => noRoute.selects.length === 1)
    noRoute.selects[0]!.onSelect({ title: "This session", value: "session" })
    await noRouteRun
    expect(noRoute.toasts.at(-1)?.message).toContain("top-level session")

    const child = makeApi({ routeSessionID: "ses_child" })
    await loadTui(child)
    child.api.state.session.get = (sessionID: string) =>
      sessionID === "ses_child"
        ? { parentID: "ses_1" }
        : sessionID === "ses_1"
          ? {}
          : undefined
    const childRun = command(child, "permissions_approve_for_me.model")()
    await until(() => child.selects.length === 1)
    child.selects[0]!.onSelect({ title: "This session", value: "session" })
    await childRun
    expect(child.toasts.at(-1)?.message).toContain("parent session")

    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.model")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "This session", value: "session" })
    await until(() => harness.selects.length === 2)
    harness.setRouteSession("ses_other")
    harness.selects[1]!.onSelect({ title: "Test model", value: "e2e/test" })
    await run
    expect(await readSessionModel(sessionModelPath("ses_1"), "ses_1")).toEqual(
      expect.objectContaining({ status: "valid" }),
    )
    expect(await fs.exists(sessionModelPath("ses_other"))).toBe(false)
  })
})

describe("the timeout picker", () => {
  test("lists the default first and highlights an existing pin, not the resolved default", async () => {
    await writeJson(projectSettingsFile(), { timeoutMs: 45_000 })
    const harness = makeApi()
    await loadTui(harness)
    const done = command(harness, "permissions_approve_for_me.timeout")()
    await until(() => harness.selects.length === 1)
    const options = harness.selects[0]!.options
    expect(options[0]!.title).toBe("Default (2 minutes)")
    expect(options[0]!.value).toBeNull()
    expect(options.map((option) => option.value)).toContain(45_000)
    expect(options.map((option) => option.value)).toContain(600_000)
    expect(harness.selects[0]!.current).toBe(45_000)
    harness.api.ui.dialog.clear()
    await done
  })

  test("with no pin the resolved default is not highlighted as an explicit choice", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const done = command(harness, "permissions_approve_for_me.timeout")()
    await until(() => harness.selects.length === 1)
    expect(harness.selects[0]!.current).toBeNull()
    harness.api.ui.dialog.clear()
    await done
  })

  test("picking a preset for this project writes timeoutMs", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.timeout")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "5 minutes", value: 300_000 })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({ title: "This project", value: "project" })
    await run

    expect(await readJson(projectSettingsFile())).toEqual({
      timeoutMs: 300_000,
    })
    expect(harness.toasts.at(-1)?.message).toContain("5 minutes")
  })

  test("Default writes timeoutMs: null in the project file but deletes the key globally", async () => {
    await writeGlobalEntry({ timeoutMs: 45_000, enabled: true })
    const harness = makeApi()
    await loadTui(harness)
    const first = command(harness, "permissions_approve_for_me.timeout")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "Default (2 minutes)", value: null })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({ title: "This project", value: "project" })
    await first
    expect(await readJson(projectSettingsFile())).toEqual({ timeoutMs: null })

    const second = command(harness, "permissions_approve_for_me.timeout")()
    await until(() => harness.selects.length === 3)
    harness.selects[2]!.onSelect({ title: "Default (2 minutes)", value: null })
    await until(() => harness.selects.length === 4)
    harness.selects[3]!.onSelect({
      title: "Global (all projects)",
      value: "global",
    })
    await second
    expect(await readGlobalEntryOptions()).toEqual({ enabled: true })
    expect(harness.toasts.at(-1)?.message).toContain("follows the default")
  })

  test("dismissing either step saves nothing", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const first = command(harness, "permissions_approve_for_me.timeout")()
    await until(() => harness.selects.length === 1)
    harness.api.ui.dialog.clear()
    await first
    const second = command(harness, "permissions_approve_for_me.timeout")()
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({ title: "1 minute", value: 60_000 })
    await until(() => harness.selects.length === 3)
    harness.api.ui.dialog.clear()
    await second

    expect(await fs.exists(projectSettingsFile())).toBe(false)
    expect(await fs.exists(globalSettingsFile())).toBe(false)
  })
})

describe("the persistent default", () => {
  test("choosing Disabled for this project writes enabled: false", async () => {
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.default")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "Disabled", value: false })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({ title: "This project", value: "project" })
    await run

    expect(await readJson(projectSettingsFile())).toEqual({ enabled: false })
    expect(harness.toasts.at(-1)?.message).toContain("disabled")
  })

  test("warns when the instance toggle still overrides the new default", async () => {
    await writeGlobalEntry({})
    const harness = makeApi()
    await loadTui(harness)
    await command(harness, "permissions_approve_for_me.toggle")() // instance now OFF
    const run = command(harness, "permissions_approve_for_me.default")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "Enabled", value: true })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({
      title: "Global (all projects)",
      value: "global",
    })
    await run

    expect(await readGlobalEntryOptions()).toEqual({ enabled: true })
    expect(harness.toasts.at(-1)?.message).toContain(
      "instance toggle still overrides",
    )
  })
})

describe("global saves into opencode.jsonc", () => {
  test("a global save is surgical: comments and unrelated keys survive", async () => {
    await fs.mkdir(configDir(), { recursive: true })
    await fs.writeFile(
      globalConfigFile(),
      `{
  // keep me
  "theme": "dark",
  "plugin": [
    // entry comment
    ["${PLUGIN_NAME}", { "model": "e2e/other" }]
  ]
}`,
    )
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.timeout")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "5 minutes", value: 300_000 })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({
      title: "Global (all projects)",
      value: "global",
    })
    await run

    const text = await fs.readFile(globalConfigFile(), "utf8")
    expect(text).toContain("// keep me")
    expect(text).toContain("// entry comment")
    expect(text).toContain('"theme": "dark"')
    expect(await readGlobalEntryOptions()).toEqual({
      model: "e2e/other",
      timeoutMs: 300_000,
    })
  })

  test("a bare global spec is upgraded to a tuple on first save", async () => {
    await writeGlobalEntry(undefined)
    const harness = makeApi()
    await loadTui(harness)
    const run = command(harness, "permissions_approve_for_me.default")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "Disabled", value: false })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({
      title: "Global (all projects)",
      value: "global",
    })
    await run

    expect(await readGlobalEntryOptions()).toEqual({ enabled: false })
  })
})

describe("the project-config trust flow", () => {
  const worktreeConfig = () => path.join(root, ".opencode", "opencode.json")

  test("unblessed worktree config pauses until trusted; a later edit pauses again", async () => {
    await writeJson(worktreeConfig(), {
      plugin: [[PLUGIN_NAME, { timeoutMs: 45_000 }]],
    })
    const harness = makeApi()
    await loadTui(harness)
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(harness.toasts.at(-1)?.message).toContain(
      "project opencode config needs review",
    )
    expect(await fs.exists(overrideFile(stateDir(), root))).toBe(false)

    const run = command(harness, "permissions_approve_for_me.trust")()
    await until(() => harness.selects.length === 1)
    const trust = harness.selects[0]!.options[0]!
    expect(trust.title).toContain("Trust current contents")
    expect(trust.description).toContain("timeoutMs")
    harness.selects[0]!.onSelect({ title: trust.title, value: "trust" })
    await run
    expect(harness.toasts.at(-1)?.message).toContain("Trusted 1 project file")

    // The blessed pin is live: the timeout picker highlights it.
    const picker = command(harness, "permissions_approve_for_me.timeout")()
    await until(() => harness.selects.length === 2)
    expect(harness.selects[1]!.current).toBe(45_000)
    harness.api.ui.dialog.clear()
    await picker

    // Drift — an edit the user has not reviewed — pauses again.
    await writeJson(worktreeConfig(), {
      plugin: [[PLUGIN_NAME, { timeoutMs: 45_000, enabled: false }]],
    })
    await Bun.sleep(600)
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(harness.toasts.at(-1)?.message).toContain("needs review")
  })

  test("revoking trust forgets every approved file", async () => {
    await writeJson(worktreeConfig(), {
      plugin: [[PLUGIN_NAME, { timeoutMs: 45_000 }]],
    })
    const harness = makeApi()
    await loadTui(harness)
    const first = command(harness, "permissions_approve_for_me.trust")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "trust", value: "trust" })
    await first

    const second = command(harness, "permissions_approve_for_me.trust")()
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({ title: "Revoke trust", value: "revoke" })
    await second
    expect(harness.toasts.at(-1)?.message).toContain("trust revoked")

    await command(harness, "permissions_approve_for_me.toggle")()
    expect(harness.toasts.at(-1)?.message).toContain("needs review")
  })

  test("with nothing to review the command says so", async () => {
    const harness = makeApi()
    await loadTui(harness)
    await command(harness, "permissions_approve_for_me.trust")()
    expect(harness.toasts.at(-1)?.message).toContain(
      "No project-local OpenCode config",
    )
  })

  test("removing a trusted policy file pauses; the flow can approve the removal", async () => {
    await writeJson(worktreeConfig(), {
      plugin: [[PLUGIN_NAME, { timeoutMs: 45_000 }]],
    })
    const harness = makeApi()
    await loadTui(harness)
    const first = command(harness, "permissions_approve_for_me.trust")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "trust", value: "trust" })
    await first
    // The record now says which blessed files SUPPLIED policy.
    const blessed = await readBlessing(blessFile(stateDir(), root))
    expect(blessed?.policy).toEqual([worktreeConfig()])

    // The file disappearing is a widening the server pauses on…
    await fs.rm(worktreeConfig())
    await Bun.sleep(600)
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(harness.toasts.at(-1)?.message).toContain("needs review")

    // …and the flow records the removal instead of dead-ending.
    const second = command(harness, "permissions_approve_for_me.trust")()
    await until(() => harness.selects.length === 2)
    const trust = harness.selects[1]!.options[0]!
    expect(trust.title).toContain("(0 files)")
    expect(trust.description).toContain("approves the removal")
    harness.selects[1]!.onSelect({ title: trust.title, value: "trust" })
    await second
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(harness.toasts.at(-1)?.message).not.toContain("needs review")
  })
})

describe("statusLabel", () => {
  const on = {
    override: undefined,
    defaultEnabled: true,
    model: "session model",
  }

  test("the full matrix — the content line under the bold header", () => {
    expect(
      statusLabel({
        pauseReason: "settings unreadable",
        server: "ready",
        ...on,
      }),
    ).toBe("paused · settings unreadable")
    expect(
      statusLabel({
        pauseReason: "settings migration required",
        server: "ready",
        ...on,
      }),
    ).toBe("paused · settings migration required")
    expect(statusLabel({ server: "ready", ...on })).toBe("on · session model")
    expect(statusLabel({ server: "ready", ...on, defaultEnabled: false })).toBe(
      "off",
    )
    expect(statusLabel({ server: "ready", ...on, override: false })).toBe(
      "off (this instance)",
    )
    expect(
      statusLabel({
        server: "ready",
        ...on,
        override: false,
        defaultEnabled: false,
      }),
    ).toBe("off")
    expect(
      statusLabel({
        server: "ready",
        override: true,
        defaultEnabled: false,
        model: "a/b",
      }),
    ).toBe("on (this instance) · a/b")
    expect(
      statusLabel({
        server: "ready",
        override: true,
        defaultEnabled: true,
        model: "a/b",
      }),
    ).toBe("on · a/b")
  })

  test('"on" requires a ready server — a paused or absent one shows as paused, not on', () => {
    // The whole point of the beacon: the settings saying "on" while the
    // server half approves nothing must never render as "on".
    expect(
      statusLabel({
        server: "paused",
        serverReason: "the permission store is unreadable or invalid JSON",
        ...on,
      }),
    ).toBe("paused · the permission store is unreadable or invalid JSON")
    expect(statusLabel({ server: "paused", ...on })).toBe(
      "paused · server fault",
    )
    expect(statusLabel({ server: "missing", ...on })).toBe(
      "paused · server half not running",
    )
    expect(statusLabel({ server: "starting", ...on })).toBe("starting…")
  })

  test("off outranks a server fault — off is what the user chose", () => {
    expect(
      statusLabel({
        server: "paused",
        serverReason: "x",
        ...on,
        override: false,
      }),
    ).toBe("off (this instance)")
    expect(
      statusLabel({ server: "missing", ...on, defaultEnabled: false }),
    ).toBe("off")
    // But a TUI-side pause outranks off: with unsafe paths nothing is known.
    expect(
      statusLabel({
        pauseReason: "settings path unsafe",
        server: "missing",
        ...on,
        defaultEnabled: false,
      }),
    ).toBe("paused · settings path unsafe")
  })

  test("the sidebar slot is registered and renders without a host", async () => {
    const harness = makeApi()
    await loadTui(harness)
    expect(harness.slotPlugins).toHaveLength(1)
    expect(Object.keys(harness.slotPlugins[0]!.slots)).toEqual([
      "sidebar_content",
    ])
  })
})

describe("the activity stream", () => {
  const pending = (
    id: string,
    permission = "bash",
    patterns = ["git status --short"],
  ) => ({
    id,
    permission,
    patterns,
  })

  test("an unannotated pending prompt is simply waiting", () => {
    const { lines, hiddenPending } = feedItems({
      pending: [pending("per_1")],
      settled: [],
      activity: {},
    })
    expect(lines).toEqual([
      { marker: "·", tone: "muted", text: "bash: git status --short" },
    ])
    expect(hiddenPending).toBe(0)
  })

  test("evaluating — and an approval whose reply is still in flight — show the classifier at work", () => {
    const activity = {
      per_1: { state: "evaluating" as const, reason: "e2e/test", time: 1 },
      per_2: { state: "approved" as const, time: 2 },
    }
    const { lines } = feedItems({
      pending: [pending("per_1"), pending("per_2", "edit", ["a.ts"])],
      settled: [],
      activity,
    })
    expect(lines[0]).toEqual({
      marker: "⋯",
      tone: "info",
      text: "bash: git status --short",
    })
    expect(lines[1]).toEqual({ marker: "⋯", tone: "info", text: "edit: a.ts" })
  })

  test("surfaced, undecided, and skipped prompts persist as needs-you with the cause", () => {
    const activity = {
      per_1: {
        state: "surfaced" as const,
        reason: "pushes to a remote",
        time: 1,
      },
      per_2: {
        state: "undecided" as const,
        reason: "could not evaluate — no verdict within 90s",
        time: 2,
      },
      per_3: { state: "skipped" as const, time: 3 },
    }
    const { lines } = feedItems({
      pending: [pending("per_1"), pending("per_2"), pending("per_3")],
      settled: [],
      activity,
    })
    expect(lines[0]).toEqual({
      marker: "!",
      tone: "warning",
      text: "bash: git status --short",
      reason: "pushes to a remote",
    })
    expect(lines[1]!.reason).toBe("could not evaluate — no verdict within 90s")
    expect(lines[2]).toEqual({
      marker: "!",
      tone: "warning",
      text: "bash: git status --short",
    })
  })

  test("settled items: classifier approvals in success, the user's own answers muted", () => {
    const activity = { per_1: { state: "approved" as const, time: 1 } }
    const { lines } = feedItems({
      pending: [],
      settled: [
        { ...pending("per_1"), reply: "once" },
        { ...pending("per_2", "edit", ["a.ts"]), reply: "always" },
        {
          ...pending("per_3", "webfetch", ["https://example.com"]),
          reply: "reject",
        },
      ],
      activity,
    })
    // Only the two most recent settled items render.
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({ marker: "✓", tone: "muted", text: "edit: a.ts" })
    expect(lines[1]).toEqual({
      marker: "✗",
      tone: "muted",
      text: "webfetch: https://example.com",
    })

    const classifier = feedItems({
      pending: [],
      settled: [{ ...pending("per_1"), reply: "once" }],
      activity,
    })
    expect(classifier.lines[0]).toEqual({
      marker: "✓",
      tone: "success",
      text: "bash: git status --short",
    })
  })

  test("a live deny deadline rides the end of the needs-you reason", () => {
    const activity = {
      per_1: {
        state: "surfaced" as const,
        reason: "pushes to a remote",
        time: 1,
        denyAt: 840_000,
      },
      per_2: {
        state: "undecided" as const,
        reason: "y".repeat(80),
        time: 2,
        denyAt: 30_000,
      },
      per_3: {
        state: "surfaced" as const,
        reason: "pushes to a remote",
        time: 3,
        denyAt: 100,
      },
    }
    const { lines } = feedItems({
      pending: [pending("per_1"), pending("per_2"), pending("per_3")],
      settled: [],
      activity,
      now: 0,
    })
    expect(lines[0]!.reason).toBe("pushes to a remote · deny in 14m")
    // A long reason keeps its full text (the renderer wraps it) with the
    // countdown still at its end.
    expect(lines[1]!.reason).toBe(`${"y".repeat(80)} · deny in <1m`)
    // Sub-minute deadlines are coarse, expired ones (or no clock) vanish.
    expect(lines[2]!.reason).toBe("pushes to a remote · deny in <1m")
    const expired = feedItems({
      pending: [pending("per_1")],
      settled: [],
      activity,
      now: 840_000,
    })
    expect(expired.lines[0]!.reason).toBe("pushes to a remote")
    const clockless = feedItems({
      pending: [pending("per_1")],
      settled: [],
      activity,
    })
    expect(clockless.lines[0]!.reason).toBe("pushes to a remote")
  })

  test("a deny in flight shows the classifier at work; a settled timed deny explains itself", () => {
    const activity = {
      per_1: {
        state: "denied" as const,
        reason: "no answer for 20 min — denied so the run can move on",
        time: 1,
      },
    }
    const stillPending = feedItems({
      pending: [pending("per_1")],
      settled: [],
      activity,
    })
    expect(stillPending.lines[0]).toEqual({
      marker: "⋯",
      tone: "info",
      text: "bash: git status --short",
    })
    const settled = feedItems({
      pending: [],
      settled: [{ ...pending("per_1"), reply: "reject" }],
      activity,
    })
    expect(settled.lines[0]!.marker).toBe("✗")
    expect(settled.lines[0]!.tone).toBe("muted")
    // The explanation keeps its full text — the renderer wraps it instead of
    // clipping it to one sidebar line.
    expect(settled.lines[0]!.reason).toBe(
      "no answer for 20 min — denied so the run can move on",
    )
    // A user's own reject stays a bare exit line.
    const userReject = feedItems({
      pending: [],
      settled: [{ ...pending("per_2"), reply: "reject" }],
      activity,
    })
    expect(userReject.lines[0]).toEqual({
      marker: "✗",
      tone: "muted",
      text: "bash: git status --short",
    })
  })

  test("pending overflow is counted, never silently dropped", () => {
    const many = Array.from({ length: 6 }, (_, i) => pending(`per_${i}`))
    const { lines, hiddenPending } = feedItems({
      pending: many,
      settled: [],
      activity: {},
    })
    expect(lines).toHaveLength(4)
    expect(hiddenPending).toBe(2)
  })

  test("headlines clip to one sidebar line; explanations render in full", () => {
    const long = pending("per_1", "bash", [`git commit -m "${"x".repeat(80)}"`])
    const activity = {
      per_1: { state: "surfaced" as const, reason: "y".repeat(80), time: 1 },
    }
    const { lines } = feedItems({ pending: [long], settled: [], activity })
    expect(lines[0]!.text.length).toBeLessThanOrEqual(44)
    expect(lines[0]!.text.endsWith("…")).toBe(true)
    // The why is what the user weighs before answering — never truncated.
    expect(lines[0]!.reason).toBe("y".repeat(80))
  })

  test("explanations at every valid producer bound render in full", () => {
    // The real producer path: parseVerdict keeps 300 chars of the model's
    // reason and appends its explicit suffix. The feed must not re-clip that
    // to a bare ellipsis — the tail is the marker that truncation already
    // happened.
    const verdict = parseVerdict({
      decision: "surface",
      risk: "critical",
      authorization: "none",
      reason: "r".repeat(400),
    })!
    expect(verdict.reason).toBe(`${"r".repeat(300)}${TRUNCATE_SUFFIX}`)
    // A matrix-overridden model approve is the longest valid annotation:
    // the assessment prefixed onto that already-suffixed reason.
    const annotation = `critical risk, no user assent — ${verdict.reason}`
    const activity = {
      per_1: { state: "surfaced" as const, reason: verdict.reason, time: 1 },
      per_2: { state: "surfaced" as const, reason: annotation, time: 2 },
    }
    const { lines } = feedItems({
      pending: [pending("per_1"), pending("per_2")],
      settled: [],
      activity,
    })
    expect(lines[0]!.reason).toBe(verdict.reason)
    expect(lines[1]!.reason).toBe(annotation)
  })

  test("explanations are bounded only against a corrupt file", () => {
    // Legitimate reasons never reach this cap: the server half normalizes
    // every recorded reason to ACTIVITY_REASON_MAX, and the cap passes any
    // normalized value. Only a corrupt activity file can exceed it.
    const cap = ACTIVITY_REASON_MAX + TRUNCATE_SUFFIX.length
    const activity = {
      per_1: { state: "denied" as const, reason: "z".repeat(600), time: 1 },
      per_2: {
        state: "surfaced" as const,
        reason: "z".repeat(600),
        time: 2,
        denyAt: 840_000,
      },
    }
    const rejected = feedItems({
      pending: [],
      settled: [{ ...pending("per_1"), reply: "reject" }],
      activity,
    })
    expect(rejected.lines[0]!.reason?.length).toBe(cap)
    expect(rejected.lines[0]!.reason?.endsWith("…")).toBe(true)
    // On a needs-you line the countdown rides after the cap, so even a
    // cap-length reason never hides it.
    const surfaced = feedItems({
      pending: [pending("per_2")],
      settled: [],
      activity,
      now: 0,
    })
    expect(surfaced.lines[0]!.reason?.length).toBe(
      cap + " · deny in 14m".length,
    )
    expect(surfaced.lines[0]!.reason?.endsWith("… · deny in 14m")).toBe(true)
  })

  test("the feed subscribes to the prompt lifecycle by default", async () => {
    const harness = makeApi()
    await loadTui(harness)
    expect(harness.eventHandlers.get("permission.asked")?.length).toBe(1)
    expect(harness.eventHandlers.get("permission.replied")?.length).toBe(1)
    // The wiring tolerates events without crashing headless.
    harness.emit("permission.asked", {
      id: "per_1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["git status"],
      metadata: {},
      always: [],
    })
    harness.emit("permission.replied", {
      sessionID: "ses_1",
      requestID: "per_1",
      reply: "once",
    })
  })

  test("feed: false keeps the status line but skips the stream wiring", async () => {
    const harness = makeApi()
    await loadTui(harness, { feed: false })
    expect(harness.slotPlugins).toHaveLength(1)
    expect(harness.eventHandlers.get("permission.asked")).toBeUndefined()
    expect(harness.eventHandlers.get("permission.replied")).toBeUndefined()
  })

  test("sidebar: false disables the stream too", async () => {
    const harness = makeApi()
    await loadTui(harness, { sidebar: false })
    expect(harness.slotPlugins).toHaveLength(0)
    expect(harness.eventHandlers.get("permission.asked")).toBeUndefined()
  })
})

describe("sidebar rendering (audit WP8)", () => {
  // The pure functions statusLabel/feedItems have exhaustive matrix tests; the
  // adapter that CALLS them — statusLine's judgePause-vs-beacon precedence,
  // serverReason's staticPause fallback, statusColor, and feedLines' parentID
  // scoping — is exercised here through the real rendered slot.

  test("missing-parent and cyclic ancestry render paused and never resolve session model records", async () => {
    await writeJson(projectSettingsFile(), { enabled: true, model: "e2e/test" })
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: 1 },
      requests: {},
    })
    const childFile = sessionModelPath("ses_child")
    const absentParentFile = sessionModelPath("ses_absent")
    const cycleFile = sessionModelPath("ses_cycle_a")
    await writeSessionModel(childFile, {
      version: 1,
      rootSessionID: "ses_child",
      revision: "rev_child",
      mode: "override",
      model: "e2e/other",
      variant: null,
    })
    await writeSessionModel(absentParentFile, {
      version: 1,
      rootSessionID: "ses_absent",
      revision: "rev_absent",
      mode: "override",
      model: "e2e/reasoner",
      variant: "high",
    })
    await writeSessionModel(cycleFile, {
      version: 1,
      rootSessionID: "ses_cycle_a",
      revision: "rev_cycle",
      mode: "override",
      model: "e2e/reasoner",
      variant: "max",
    })
    const harness = makeApi()
    harness.api.state.session.get = (sessionID: string) => {
      if (sessionID === "ses_child") return { parentID: "ses_absent" }
      if (sessionID === "ses_cycle_a") return { parentID: "ses_cycle_b" }
      if (sessionID === "ses_cycle_b") return { parentID: "ses_cycle_a" }
      return undefined
    }
    await loadTui(harness)

    // The trusted reader starts with open. Observing no open for these paths
    // proves an unknown ancestry never even constructs a mirror.
    const open = spyOn(fs, "open")
    try {
      const missing = await renderSidebar(harness, "ses_child")
      expect(
        await settleFrame(missing, "session ancestry unavailable", 4_000),
      ).toContain("paused · session ancestry unavailable")
      const cycle = await renderSidebar(harness, "ses_cycle_a")
      expect(
        await settleFrame(cycle, "session ancestry unavailable", 4_000),
      ).toContain("paused · session ancestry unavailable")
      const touched = open.mock.calls.map(([file]) => String(file))
      expect(touched).not.toContain(childFile)
      expect(touched).not.toContain(absentParentFile)
      expect(touched).not.toContain(cycleFile)
    } finally {
      open.mockRestore()
    }
  })

  test("the shared ancestry hop cap accepts its boundary and rejects one level beyond it", async () => {
    await writeJson(projectSettingsFile(), { enabled: true, model: "e2e/test" })
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: 1 },
      requests: {},
    })
    const allowedRoot = "ses_allowed_root"
    const blockedRoot = "ses_blocked_root"
    await writeSessionModel(sessionModelPath(allowedRoot), {
      version: 1,
      rootSessionID: allowedRoot,
      revision: "rev_allowed",
      mode: "override",
      model: "e2e/reasoner",
      variant: "high",
    })
    await writeSessionModel(sessionModelPath(blockedRoot), {
      version: 1,
      rootSessionID: blockedRoot,
      revision: "rev_blocked",
      mode: "override",
      model: "e2e/other",
      variant: null,
    })
    const sessions = new Map<string, { parentID?: string }>([
      [allowedRoot, {}],
      [blockedRoot, {}],
    ])
    const addChain = (prefix: string, rootID: string, depth: number) => {
      for (let level = 1; level <= depth; level += 1) {
        sessions.set(`${prefix}_${level}`, {
          parentID: level === 1 ? rootID : `${prefix}_${level - 1}`,
        })
      }
      return `${prefix}_${depth}`
    }
    const allowed = addChain(
      "ses_allowed",
      allowedRoot,
      SESSION_ANCESTRY_HOP_LIMIT,
    )
    const blocked = addChain(
      "ses_blocked",
      blockedRoot,
      SESSION_ANCESTRY_HOP_LIMIT + 1,
    )
    const harness = makeApi()
    harness.api.state.session.get = (sessionID: string) =>
      sessions.get(sessionID)
    await loadTui(harness)

    const withinCap = await renderSidebar(harness, allowed)
    expect(await settleFrame(withinCap, "this session", 4_000)).toContain(
      "on · e2e/reasoner · high · this session",
    )
    const beyondCap = await renderSidebar(harness, blocked)
    expect(
      await settleFrame(beyondCap, "session ancestry unavailable", 4_000),
    ).toContain("paused · session ancestry unavailable")
  })

  test("recovers a root session model when host ancestry finishes syncing", async () => {
    await writeJson(projectSettingsFile(), { enabled: true, model: "e2e/test" })
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: 1 },
      requests: {},
    })
    await writeSessionModel(sessionModelPath("ses_root"), {
      version: 1,
      rootSessionID: "ses_root",
      revision: "rev_recovered",
      mode: "override",
      model: "e2e/reasoner",
      variant: "high",
    })
    const harness = makeApi()
    const [rootAvailable, setRootAvailable] = createSignal(false)
    harness.api.state.session.get = (sessionID: string) => {
      if (sessionID === "ses_child") return { parentID: "ses_root" }
      if (sessionID === "ses_root" && rootAvailable()) return {}
      return undefined
    }
    await loadTui(harness)

    const view = await renderSidebar(harness, "ses_child")
    expect(
      await settleFrame(view, "session ancestry unavailable", 4_000),
    ).toContain("paused · session ancestry unavailable")
    setRootAvailable(true)
    const recovered = await settleFrame(view, "this session", 4_000)
    expect(recovered).toContain("on · e2e/reasoner · high · this session")
  })

  test("resolves sidebar ancestry once for each ancestry update", async () => {
    await writeJson(projectSettingsFile(), { enabled: true, model: "e2e/test" })
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: 1 },
      requests: {},
    })
    await writeSessionModel(sessionModelPath("ses_root_a"), {
      version: 1,
      rootSessionID: "ses_root_a",
      revision: "rev_a",
      mode: "override",
      model: "e2e/reasoner",
      variant: "high",
    })
    await writeSessionModel(sessionModelPath("ses_root_b"), {
      version: 1,
      rootSessionID: "ses_root_b",
      revision: "rev_b",
      mode: "override",
      model: "e2e/other",
      variant: null,
    })
    const harness = makeApi()
    const [rootID, setRootID] = createSignal("ses_root_a")
    let lookups = 0
    harness.api.state.session.get = (sessionID: string) => {
      lookups++
      if (sessionID === "ses_child") return { parentID: rootID() }
      if (sessionID === rootID()) return {}
      return undefined
    }
    await loadTui(harness, { feed: false })

    const view = await renderSidebar(harness, "ses_child")
    expect(await settleFrame(view, "e2e/reasoner", 4_000)).toContain(
      "on · e2e/reasoner · high · this session",
    )
    expect(lookups).toBe(2)

    setRootID("ses_root_b")
    expect(await settleFrame(view, "e2e/other", 4_000)).toContain(
      "on · e2e/other · this session",
    )
    expect(lookups).toBe(4)
  })

  test("a missing session record falls back to the persistent model", async () => {
    await writeJson(projectSettingsFile(), { enabled: true, model: "e2e/test" })
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: 1 },
      requests: {},
    })
    const harness = makeApi()
    await loadTui(harness, { feed: false })

    const view = await renderSidebar(harness)
    const frame = await settleFrame(view, "on · e2e/test", 4_000)
    expect(frame).not.toContain("this session")
  })

  test("an inherit session record falls back to the persistent model", async () => {
    await writeJson(projectSettingsFile(), { enabled: true, model: "e2e/test" })
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: 1 },
      requests: {},
    })
    await writeSessionModel(sessionModelPath("ses_1"), {
      version: 1,
      rootSessionID: "ses_1",
      revision: "rev_inherit",
      mode: "inherit",
      model: null,
      variant: null,
    })
    const harness = makeApi()
    await loadTui(harness, { feed: false })

    const view = await renderSidebar(harness)
    const frame = await settleFrame(view, "on · e2e/test", 4_000)
    expect(frame).not.toContain("this session")
  })

  test("an older overlapping mirror reload cannot replace the newer result", async () => {
    await writeJson(projectSettingsFile(), {
      enabled: false,
      model: "e2e/test",
    })
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: 1 },
      requests: {},
    })
    const stale = {
      version: 1,
      rootSessionID: "ses_1",
      revision: "rev_stale",
      mode: "override",
      model: "e2e/other",
      variant: null,
    } as const
    const fresh = {
      version: 1,
      rootSessionID: "ses_1",
      revision: "rev_fresh",
      mode: "override",
      model: "e2e/reasoner",
      variant: "high",
    } as const
    const file = sessionModelPath("ses_1")
    await writeSessionModel(file, stale)
    const harness = makeApi()
    await loadTui(harness)

    const realOpen = fs.open.bind(fs)
    let sessionReads = 0
    let markFirstStarted: (() => void) | undefined
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    let releaseFirst: (() => void) | undefined
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const open = spyOn(fs, "open").mockImplementation((async (
      target: Parameters<typeof fs.open>[0],
      flags: Parameters<typeof fs.open>[1],
      mode?: Parameters<typeof fs.open>[2],
    ) => {
      const handle = await realOpen(target, flags, mode)
      if (String(target) !== file) return handle
      sessionReads++
      if (sessionReads !== 1) return handle
      return {
        fd: handle.fd,
        stat: handle.stat.bind(handle),
        readFile: async () => {
          markFirstStarted?.()
          await firstRead
          return handle.readFile({ encoding: "utf8" })
        },
        close: handle.close.bind(handle),
      } as unknown as typeof handle
    }) as typeof fs.open)
    try {
      const view = await renderSidebar(harness, "ses_1")
      await firstStarted

      // The toggle explicitly reloads the existing mirror. Its second read
      // completes first; only then is the deferred initial read released.
      await writeSessionModel(file, fresh)
      await command(harness, "permissions_approve_for_me.toggle")()
      expect(sessionReads).toBe(2)
      expect(harness.toasts.at(-1)?.message).toContain(
        "e2e/reasoner · high · this session",
      )
      releaseFirst?.()
      await Bun.sleep(0) // one turn drains the released read's promise chain
      await view.renderOnce()
      const frame = view.captureCharFrame()
      expect(frame).toContain("e2e/reasoner · high · this session")
      expect(frame).not.toContain("e2e/other")
    } finally {
      releaseFirst?.()
      open.mockRestore()
    }
  })

  test("a visible session mirror stays live while newer slots fill the LRU", async () => {
    await writeJson(projectSettingsFile(), { enabled: true, model: "e2e/test" })
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: 1 },
      requests: {},
    })
    const roots = Array.from({ length: 17 }, (_, index) => `ses_lru_${index}`)
    for (const sessionID of roots) {
      await writeSessionModel(sessionModelPath(sessionID), {
        version: 1,
        rootSessionID: sessionID,
        revision: `rev_${sessionID}`,
        mode: "override",
        model: "e2e/other",
        variant: null,
      })
    }
    const harness = makeApi()
    harness.api.state.session.get = (sessionID: string) =>
      roots.includes(sessionID) ? {} : undefined
    await loadTui(harness, { feed: false })
    expect(
      await readSessionModel(sessionModelPath(roots[0]!), roots[0]!),
    ).toEqual(expect.objectContaining({ status: "valid" }))
    let showRoot: ((sessionID: string) => void) | undefined
    const view = await testRender(
      () => {
        const [secondRoot, setSecondRoot] = createSignal(roots[1]!)
        showRoot = setSecondRoot
        return [
          harness.slotPlugins[0]!.slots.sidebar_content(
            {},
            { session_id: roots[0]! },
          ),
          harness.slotPlugins[0]!.slots.sidebar_content(
            {},
            { session_id: secondRoot() },
          ),
        ]
      },
      { width: 60, height: 12 },
    )
    try {
      await settleFrame(view, "on · e2e/other · this session", 4_000)
      for (const sessionID of roots.slice(1)) {
        showRoot?.(sessionID)
        await view.renderOnce()
      }

      await writeSessionModel(sessionModelPath(roots[0]!), {
        version: 1,
        rootSessionID: roots[0]!,
        revision: "rev_lru_fresh",
        mode: "override",
        model: "e2e/reasoner",
        variant: "high",
      })
      const frame = await settleFrame(view, "e2e/reasoner", 4_000)
      expect(frame).toContain("on · e2e/reasoner · high · this session")
    } finally {
      await view.renderer.destroy()
    }
  })

  test("uses each slot root's session record for labels and local pauses", async () => {
    await writeJson(projectSettingsFile(), { enabled: true, model: "e2e/test" })
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: 1 },
      requests: {},
    })
    await writeSessionModel(sessionModelPath("ses_1"), {
      version: 1,
      rootSessionID: "ses_1",
      revision: "rev_1",
      mode: "override",
      model: "e2e/reasoner",
      variant: "high",
    })
    const planted = path.join(root, "planted-sidebar-model.json")
    await writeJson(planted, {
      version: 1,
      rootSessionID: "ses_other",
      revision: "rev_planted",
      mode: "override",
      model: "e2e/other",
      variant: null,
    })
    await fs.symlink(planted, sessionModelPath("ses_other"))
    await writeSessionModel(sessionModelPath("ses_variant"), {
      version: 1,
      rootSessionID: "ses_variant",
      revision: "rev_variant",
      mode: "override",
      model: "e2e/reasoner",
      variant: "ultra",
    })
    const harness = makeApi()
    await loadTui(harness)

    const pinned = await renderSidebar(harness, "ses_1")
    const pinnedFrame = await settleFrame(pinned, "this session", 4_000)
    expect(pinnedFrame).toContain("on · e2e/reasoner · high · this session")

    const corrupt = await renderSidebar(harness, "ses_other")
    const corruptFrame = await settleFrame(
      corrupt,
      "session model record",
      4_000,
    )
    expect(corruptFrame).toContain(
      "paused · session model record unreadable or invalid",
    )
    const statusSpan = corrupt
      .captureSpans()
      .lines.flatMap((line: any) => line.spans)
      .find((span: any) => span.text.includes("session model record"))
    const warn = statusSpan!.fg as { r: number; g: number; b: number }
    expect([warn.r, warn.g, warn.b]).toEqual([1, 0, 0])

    const unavailable = await renderSidebar(harness, "ses_variant")
    const unavailableFrame = await settleFrame(unavailable, "variant", 4_000)
    expect(unavailableFrame).toContain(
      'paused · pinned variant "ultra" unavailable here',
    )
  })

  test("a pinned model absent here renders paused-naming-the-model, in warning colour", async () => {
    await writeJson(projectSettingsFile(), {
      enabled: true,
      model: "e2e/ghost",
    })
    // The server half is ready — the beacon says so. The TUI-side judge
    // pre-check must still outrank it: a pinned model this instance's provider
    // catalog lacks shows up as paused here, before any request lets the server
    // half discover it.
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: 1 },
      requests: {},
    })
    const harness = makeApi()
    await loadTui(harness)

    const view = await renderSidebar(harness)
    // Wait on the SETTLED status, not the header: the header renders while
    // the status line still reads "starting…", so a header-keyed wait races
    // the async settle. And wait in wall-clock terms — see the settleFrame
    // note above renderSidebar.
    const frame = await settleFrame(view, "paused", 4_000)
    expect(frame).toContain("paused · pinned model e2e/ghost unavailable here")
    // Kills mutant (a): drop staticPause from statusLine's server computation
    // and the ready beacon wins, showing the trust posture as active.
    expect(frame).not.toContain("on · e2e/ghost")
    // Kills mutant (b): drop `staticPause ??` from serverReason and the fault
    // goes generic instead of naming the missing model.
    expect(frame).not.toContain("server fault")

    // statusColor: the paused state flags in theme.warning (#ff0000).
    const statusSpan = view
      .captureSpans()
      .lines.flatMap((line: any) => line.spans)
      .find((span: any) => span.text.includes("paused"))
    expect(statusSpan).toBeDefined()
    const warn = statusSpan!.fg as { r: number; g: number; b: number }
    expect([warn.r, warn.g, warn.b]).toEqual([1, 0, 0])
  })

  test("the feed shows a child session's prompt but not an unrelated root's", async () => {
    await writeJson(projectSettingsFile(), { enabled: true, model: "e2e/test" })
    const harness = makeApi()
    await loadTui(harness)
    // ses_child is a sub-agent of ses_1; ses_other is an unrelated root.
    harness.api.state.session.get = (id: string) =>
      id === "ses_child"
        ? { parentID: "ses_1" }
        : id === "ses_other"
          ? { parentID: "ses_root" }
          : undefined
    harness.api.state.session.permission = (id: string) =>
      id === "ses_child"
        ? [
            {
              id: "per_c",
              sessionID: id,
              permission: "bash",
              patterns: ["child-cmd"],
            },
          ]
        : id === "ses_other"
          ? [
              {
                id: "per_o",
                sessionID: id,
                permission: "bash",
                patterns: ["unrelated-cmd"],
              },
            ]
          : []
    // permission.asked is what puts a session into promptSessions() — the set
    // feedLines filters by parentID. Both must be known for the filter to matter.
    harness.emit("permission.asked", {
      id: "per_c",
      sessionID: "ses_child",
      permission: "bash",
      patterns: ["child-cmd"],
    })
    harness.emit("permission.asked", {
      id: "per_o",
      sessionID: "ses_other",
      permission: "bash",
      patterns: ["unrelated-cmd"],
    })

    const view = await renderSidebar(harness, "ses_1")
    const frame = await settleFrame(view, "child-cmd", 4_000)
    expect(frame).toContain("bash: child-cmd")
    // Kills mutant (c): without the `parentID === sessionID` filter the
    // unrelated root's prompt leaks into this session's feed.
    expect(frame).not.toContain("unrelated-cmd")
  })

  test("a timed deny's explanation wraps across sidebar lines instead of clipping", async () => {
    await writeJson(projectSettingsFile(), { enabled: true, model: "e2e/test" })
    const reason = "no answer for 20 min — denied so the run can move on"
    await writeJson(activityFile(stateDir(), root), {
      requests: { per_1: { state: "denied", reason, time: 1 } },
    })
    const harness = makeApi()
    await loadTui(harness)
    harness.emit("permission.asked", {
      id: "per_1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["git push origin main"],
      metadata: {},
      always: [],
    })
    harness.emit("permission.replied", {
      sessionID: "ses_1",
      requestID: "per_1",
      reply: "reject",
    })

    // Narrower than the reason, like the real 42-column sidebar: the tail of
    // the explanation only shows if the reason wraps rather than clips.
    const view = await renderSidebar(harness, "ses_1", 40)
    const frame = await settleFrame(view, "can move on", 4_000)
    const rows = frame.split("\n")
    const head = rows.findIndex((row) => row.includes("no answer for 20 min"))
    const tail = rows.findIndex((row) => row.includes("can move on"))
    expect(head).toBeGreaterThanOrEqual(0)
    expect(tail).toBeGreaterThan(head)
    // The continuation line keeps the reason indent under its ✗ headline.
    expect(rows[tail]!.startsWith("  ")).toBe(true)
  })

  test("an off status renders in the muted colour, not warning", async () => {
    await writeJson(projectSettingsFile(), {
      enabled: false,
      model: "e2e/ghost",
    })
    const harness = makeApi()
    await loadTui(harness)

    const view = await renderSidebar(harness)
    // Same settle race as the paused test above: key the wait on the
    // settled "off" status, not the header that precedes it — and on the
    // wall clock, not render passes.
    const frame = await settleFrame(view, "off", 4_000)
    expect(frame).toContain("Approve for Me")
    const statusSpan = view
      .captureSpans()
      .lines.flatMap((line: any) => line.spans)
      .find((span: any) => span.text.trim().startsWith("off"))
    expect(statusSpan).toBeDefined()
    const fg = statusSpan!.fg as { r: number; g: number; b: number }
    // textMuted #808080 -> equal channels ≈0.502; decidedly not warning red.
    expect(fg.r).toBeCloseTo(fg.g, 5)
    expect(fg.g).toBeCloseTo(fg.b, 5)
    expect(fg.r).not.toBe(1)
  })

  test("a disabled setting renders off while its session mirror loads", async () => {
    await writeJson(projectSettingsFile(), {
      enabled: false,
      model: "e2e/test",
    })
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: 1 },
      requests: {},
    })
    await writeSessionModel(sessionModelPath("ses_1"), {
      version: 1,
      rootSessionID: "ses_1",
      revision: "rev_loading",
      mode: "override",
      model: "e2e/other",
      variant: null,
    })
    const harness = makeApi()
    await loadTui(harness)

    const realOpen = fs.open.bind(fs)
    let releaseRead: (() => void) | undefined
    const blockedRead = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let reading = false
    const open = spyOn(fs, "open").mockImplementation((async (
      target: Parameters<typeof fs.open>[0],
      flags: Parameters<typeof fs.open>[1],
      mode?: Parameters<typeof fs.open>[2],
    ) => {
      const handle = await realOpen(target, flags, mode)
      if (String(target) !== sessionModelPath("ses_1")) return handle
      return {
        fd: handle.fd,
        stat: handle.stat.bind(handle),
        readFile: async () => {
          reading = true
          await blockedRead
          return handle.readFile({ encoding: "utf8" })
        },
        close: handle.close.bind(handle),
      } as unknown as typeof handle
    }) as typeof fs.open)
    try {
      const view = await renderSidebar(harness)
      await until(() => reading)
      // Let locality and policy initialization finish, but keep the existing
      // session record's read blocked throughout the rendered OFF assertion.
      const frame = await settleFrame(view, "off", 4_000)
      expect(frame).toContain("off")
      expect(frame).not.toContain("starting…")
      await view.renderer.destroy()
    } finally {
      releaseRead?.()
      open.mockRestore()
    }
  })
})

describe("the host path-sync race (issue #135)", () => {
  // api.state.path is empty-string placeholders until the host's sync
  // round-trip lands — a race plugin activation usually wins. Losing it must
  // read as startup ("starting…", "still syncing"), never latch the permanent
  // "settings path unsafe" fault, and every control must work after the batch
  // lands without a TUI restart.
  const placeholders = () => ({
    worktree: "",
    directory: "",
    statePath: "",
    configPath: "",
  })
  // The host writes every field in one batch.
  const landPaths = (harness: ReturnType<typeof makeApi>) => {
    Object.assign(harness.api.state.path, {
      worktree: root,
      directory: root,
      state: stateDir(),
      config: configDir(),
    })
  }
  // Every adoption attempt — the one at activation, each poll tick, and each
  // one a user flow forces — starts by reading `directory` off api.state.path
  // (resolvePathsOnce bails there while it is a placeholder). Counting that
  // read is therefore an exact count of attempts: measured against this
  // harness, activation plus a 750 ms hold reads it 4 times and nothing else
  // in the plugin touches it while the placeholders stand. That lets a test
  // wait out *ticks* instead of sleeping a wall-clock guess, so a poll that
  // stopped firing fails loudly here rather than silently costing coverage.
  const countAdoptionAttempts = (harness: ReturnType<typeof makeApi>) => {
    let attempts = 0
    let directory = harness.api.state.path.directory
    Object.defineProperty(harness.api.state.path, "directory", {
      configurable: true,
      enumerable: true,
      get() {
        attempts++
        return directory
      },
      set(next: string) {
        directory = next
      },
    })
    const count = () => attempts
    return {
      count,
      /** Resolve once at least `target` attempts have been observed. */
      waitFor: async (target: number) => {
        const deadline = Date.now() + 5_000
        while (attempts < target) {
          if (Date.now() > deadline)
            throw new Error(
              `the adoption poll stopped: ${attempts} attempts, expected ${target}`,
            )
          await Bun.sleep(25)
        }
      },
    }
  }
  // Not a duplicate of the file-level waitForSettledFrame, and the two do not
  // collapse: that one retries view.waitForFrame, which counts render passes
  // and returns the moment the test renderer is idle — so it cannot wait out
  // the TIMER-driven changes this block is about (the 250 ms adoption poll,
  // the file watchers), which leave the renderer idle with nothing queued
  // until a timer fires. This drives the render itself on a wall clock;
  // generous deadline for loaded CI.
  const settleFrame = async (
    view: Awaited<ReturnType<typeof renderSidebar>>,
    predicate: (frame: string) => boolean,
  ): Promise<string> => {
    const deadline = Date.now() + 5_000
    for (;;) {
      await view.renderOnce()
      const frame = view.captureCharFrame()
      if (predicate(frame)) return frame
      if (Date.now() > deadline)
        throw new Error(`sidebar never settled; last frame:\n${frame}`)
      await Bun.sleep(25)
    }
  }

  test("a toggle before the sync lands names the boot race, then works once it lands", async () => {
    const harness = makeApi(placeholders())
    await loadTui(harness)

    await command(harness, "permissions_approve_for_me.toggle")()
    expect(harness.toasts.at(-1)?.message).toContain("still syncing")
    expect(harness.toasts.at(-1)?.message).not.toContain("unsafe")
    expect(await fs.exists(overrideFile(stateDir(), root))).toBe(false)

    landPaths(harness)
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(await readOverride(overrideFile(stateDir(), root))).toMatchObject({
      enabled: false,
    })
    expect(harness.toasts.at(-1)?.message).toContain("OFF for this instance")
  })

  test("the sidebar shows startup — not a path fault — and recovers on its own", async () => {
    // Real policy and a ready beacon already on disk: the moment the paths
    // land and the first read completes, the line can say "on".
    await writeJson(projectSettingsFile(), { enabled: true, model: "e2e/test" })
    await writeJson(activityFile(stateDir(), root), {
      server: { state: "ready", time: 1 },
      requests: {},
    })
    const harness = makeApi(placeholders())
    const attempts = countAdoptionAttempts(harness)
    await loadTui(harness)

    const view = await renderSidebar(harness)
    const frame = await settleFrame(view, (f) => f.includes("starting…"))
    expect(frame).not.toContain("paused")
    expect(frame).not.toContain("settings path unsafe")

    // The poll has to survive misses, not merely fire once. Hold the
    // placeholders across several ticks (1 activation attempt + 3 polls): a
    // retry that armed itself once and gave up after the first miss would
    // still pass every assertion below if the paths landed inside the first
    // 250 ms, while reproducing the production lockout for exactly the hosts
    // this fix is for — the slow ones.
    await attempts.waitFor(4)
    const held = await settleFrame(view, (f) => f.includes("starting…"))
    expect(held).not.toContain("settings path unsafe")
    expect(held).not.toContain("paused")

    // A user flow during the window forces its own attempt, and that attempt
    // fails. It must not be cached as the answer — resolvePathsOnce caches a
    // failed *resolution*, but a placeholder read is not one — or the passive
    // recovery below never comes.
    await command(harness, "permissions_approve_for_me.toggle")()
    expect(harness.toasts.at(-1)?.message).toContain("still syncing")
    await attempts.waitFor(attempts.count() + 2)

    // The host's batch lands; the adoption poll picks it up with NO user
    // access, installs the watchers on the real paths, and the first read
    // settles the line.
    landPaths(harness)
    const settled = await settleFrame(view, (f) => f.includes("on · e2e/test"))
    expect(settled).not.toContain("settings path unsafe")

    // And the watchers really watch the trusted files — an outside edit is
    // picked up without a restart. Watchers installed against the
    // placeholder-derived junk paths (the old bug's smaller rider) could
    // never see this write.
    await writeJson(projectSettingsFile(), {
      enabled: false,
      model: "e2e/test",
    })
    await settleFrame(view, (f) => f.includes("off"))
    // Deliberately above the sum of the internal deadlines this test can wait
    // on. Bun's 5 s default expires first otherwise, and the timeout replaces
    // the diagnostic ("the adoption poll stopped: 1 attempts, expected 4")
    // with a bare "timed out" that says nothing about which wait failed. The
    // happy path settles in well under two seconds.
  }, 30_000)

  test("a picker during the sync declines by naming the race; a later save succeeds", async () => {
    const harness = makeApi(placeholders())
    await loadTui(harness)

    await command(harness, "permissions_approve_for_me.default")()
    expect(harness.selects).toHaveLength(0)
    expect(harness.toasts.at(-1)?.message).toContain("still syncing")

    landPaths(harness)
    const run = command(harness, "permissions_approve_for_me.default")()
    await until(() => harness.selects.length === 1)
    harness.selects[0]!.onSelect({ title: "Disabled", value: false })
    await until(() => harness.selects.length === 2)
    harness.selects[1]!.onSelect({ title: "This project", value: "project" })
    await run
    expect(await readJson(projectSettingsFile())).toMatchObject({
      enabled: false,
    })
    expect(harness.toasts.at(-1)?.message).toContain(
      "default for this project: disabled",
    )
  })
})

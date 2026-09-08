import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { projectFileKey, shortProjectHash } from "@macarons/permission-rules"
import { makeTuiApi } from "@macarons/plugin-test-harness/tui"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import {
  type ClassifierConfig,
  type ClassifierProvider,
  resolveClassifierConfig,
} from "../src/interop"
import {
  activityFile,
  blessFile,
  GLOBAL_SETTINGS_BASENAME,
  legacyProjectSettingsFile,
  overrideFile,
  PLUGIN_PACKAGE_NAME,
  preSlugProjectSettingsFile,
  projectSettingsFile,
  respondInstanceRequest,
  STORAGE_SERVICE,
  sessionModelDirectory,
  sessionModelFile,
  sha256Hex,
  writeActivity,
  writeBlessing,
  writeSessionModel,
} from "../src/shared"

/**
 * The sibling-plugin interop surface (src/interop.ts) — the contract the
 * usage-limits sidebar consumes, TESTED IN THIS PACKAGE so a change to the
 * settings pipeline breaks here, next to the code that changed, and not
 * silently in the consumer. That is the failure mode this module exists to
 * end: the pre-#114 consumer re-assembled the pipeline from six shared.ts
 * helpers, and when global settings moved onto the opencode.json[c] plugin
 * entry (PR #139) its copy kept reading the retired bespoke file.
 *
 * The behavioral cases mirror the consumer's old suite
 * (usage-limits/test/classifier.test.ts, retired with #114), translated to
 * the live settings sources, plus the pause gates the old pipeline never
 * knew about (legacy files, unblessed worktree config).
 */

const roots: string[] = []
const INSTANCE_A = "11111111-1111-4111-8111-111111111111"
const INSTANCE_B = "22222222-2222-4222-8222-222222222222"

afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true })
})

async function makeDirs() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "afm-interop-"))
  roots.push(root)
  const dirs = {
    project: path.join(root, "project"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
  }
  await Promise.all(
    Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })),
  )
  // Canonical from the start, so fixture paths (override, bless, project
  // settings) key exactly like the trusted paths the interop resolves.
  return {
    project: await fs.realpath(dirs.project),
    config: await fs.realpath(dirs.config),
    state: await fs.realpath(dirs.state),
  }
}

type Dirs = Awaited<ReturnType<typeof makeDirs>>
type DiscoveryApi = Pick<
  TuiPluginApi,
  "client" | "event" | "lifecycle" | "state"
>

function makeDiscoveryApi(
  dirs: Dirs,
  initialInstanceID: string | null = INSTANCE_A,
) {
  const harness = makeTuiApi({
    paths: {
      config: dirs.config,
      state: dirs.state,
      worktree: dirs.project,
      directory: dirs.project,
    },
  })
  let instanceID: string | undefined = initialInstanceID ?? undefined
  const responseClient = {
    tui: {
      publish: async (input: unknown) => {
        const body = (input as { body: { type: string; properties: unknown } })
          .body
        harness.emit(body.type, body.properties)
        return { data: true }
      },
    },
  } as unknown as Parameters<typeof respondInstanceRequest>[0]
  harness.api.client.tui = {
    publish: async (input: unknown) => {
      if (!instanceID) return { error: "server unavailable" }
      const event = (input as { body: unknown }).body
      await respondInstanceRequest(
        responseClient,
        event,
        instanceID,
        dirs.project,
      )
      return { data: true }
    },
  }
  return {
    api: harness.api as unknown as DiscoveryApi,
    setInstanceID: (value: string | undefined) => {
      instanceID = value
    },
  }
}

const PROVIDERS: ClassifierProvider[] = [
  {
    id: "openai",
    models: { "gpt-5.5-codex": { variants: { high: {} } } },
  },
  { id: "opencode-go", models: { "minimax-m3": {} } },
]

async function providerID(
  interop: ClassifierConfig,
  input: {
    rootSessionID?: string
    providers?: readonly ClassifierProvider[]
  } = {},
) {
  return interop.providerID({
    rootSessionID: input.rootSessionID ?? "ses_root",
    providers: input.providers ?? PROVIDERS,
  })
}

// The interop as usage-limits calls it, in a git-shaped session: the host
// names the project as the worktree, so the config scan stops at the project
// like the host's own discovery does.
async function resolveInterop(
  dirs: Dirs,
  api: DiscoveryApi = makeDiscoveryApi(dirs).api,
) {
  return resolveClassifierConfig({
    api,
    directory: dirs.project,
    worktree: dirs.project,
    configDir: dirs.config,
    stateDir: dirs.state,
  })
}

async function resolvedInterop(dirs: Dirs) {
  const interop = await resolveInterop(dirs)
  if (!interop) throw new Error("expected the interop to resolve")
  return interop
}

async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

/** The global layer as it exists post-#139: this plugin's entry options in
 *  the host's own config file. */
async function writeGlobalEntry(dirs: Dirs, settings: unknown) {
  await write(
    path.join(dirs.config, "opencode.json"),
    JSON.stringify({ plugin: [[PLUGIN_PACKAGE_NAME, settings]] }),
  )
}

/** The server half's liveness beacon, written through the producer's own
 *  writer. Settings prove "configured on"; only this proves anything is
 *  actually classifying, so every positive case needs one. */
async function writeServerBeacon(
  dirs: Dirs,
  state: "ready" | "paused",
  reason?: string,
  instanceID = INSTANCE_A,
) {
  await writeActivity(activityFile(dirs.state, dirs.project, instanceID), {
    server: { state, ...(reason ? { reason } : {}), time: Date.now() },
    requests: {},
  })
}

describe("resolveClassifierConfig", () => {
  test("fails closed when the config dir sits inside the project", async () => {
    const dirs = await makeDirs()
    const insideConfig = path.join(dirs.project, ".config")
    await fs.mkdir(insideConfig, { recursive: true })
    const discovery = makeDiscoveryApi(dirs)
    const interop = await resolveClassifierConfig({
      api: discovery.api,
      directory: dirs.project,
      worktree: dirs.project,
      configDir: insideConfig,
      stateDir: dirs.state,
    })
    expect(interop).toBeDefined()
    if (!interop) throw new Error("expected a live interop handle")
    expect(await providerID(interop)).toBeUndefined()
  })
})

describe("ClassifierConfig.providerID", () => {
  test("reports the pinned model's provider from the global plugin entry", async () => {
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, { model: "openai/gpt-5.5-codex" })
    await writeServerBeacon(dirs, "ready")
    const interop = await resolvedInterop(dirs)
    expect(await providerID(interop)).toBe("openai")
  })

  test("a pinned model without the server's beacon reads as no classifier (PR #142 review F2)", async () => {
    // A leftover settings file with the server half uninstalled — or simply
    // not yet started — is "configured", not "classifying". Nothing spends
    // quota, so there is no section.
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, { model: "openai/gpt-5.5-codex" })
    const interop = await resolvedInterop(dirs)
    expect(await providerID(interop)).toBeUndefined()
  })

  test("a paused server half hides the classifier however the settings read (PR #142 review F2)", async () => {
    // The server pauses instance-wide when the pinned model or its variant is
    // unavailable here, or config/store cannot be read; its beacon is the one
    // record of that.
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, { model: "openai/gpt-5.5-codex" })
    await writeServerBeacon(
      dirs,
      "paused",
      'configured classifier model "openai/gpt-5.5-codex" is not available in this OpenCode instance',
    )
    const interop = await resolvedInterop(dirs)
    expect(await providerID(interop)).toBeUndefined()

    await writeServerBeacon(dirs, "ready")
    expect(await providerID(interop)).toBe("openai")
  })

  test("old unowned activity beacons are never accepted", async () => {
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, { model: "openai/gpt-5.5-codex" })
    const oldFiles = [
      path.join(
        dirs.state,
        STORAGE_SERVICE,
        `activity-${projectFileKey(dirs.project)}.json`,
      ),
      path.join(
        dirs.state,
        STORAGE_SERVICE,
        `activity-${shortProjectHash(dirs.project)}.json`,
      ),
    ]
    for (const file of oldFiles)
      await writeActivity(file, {
        server: { state: "ready", time: Date.now() },
        requests: {},
      })
    const interop = await resolvedInterop(dirs)
    expect(await providerID(interop)).toBeUndefined()
  })

  test("re-discovers the live owner after startup and reconnect", async () => {
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, { model: "openai/gpt-5.5-codex" })
    await writeServerBeacon(dirs, "ready", undefined, INSTANCE_A)
    const discovery = makeDiscoveryApi(dirs, null)
    const interop = await resolveInterop(dirs, discovery.api)
    if (!interop) throw new Error("expected a live interop handle")

    expect(await providerID(interop)).toBeUndefined()
    discovery.setInstanceID(INSTANCE_A)
    expect(await providerID(interop)).toBe("openai")

    // A replacement server owns a different path. The old live-looking
    // beacon cannot be adopted as evidence for the newly discovered owner.
    discovery.setInstanceID(INSTANCE_B)
    expect(await providerID(interop)).toBeUndefined()
    await writeServerBeacon(dirs, "ready", undefined, INSTANCE_B)
    expect(await providerID(interop)).toBe("openai")
  })

  test("bounds cached owners without mixing or cancelling concurrent resolutions", async () => {
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, { model: "openai/gpt-5.5-codex" })
    await writeServerBeacon(dirs, "ready")
    const discovery = makeDiscoveryApi(dirs)
    const interop = await resolveInterop(dirs, discovery.api)
    if (!interop) throw new Error("expected a live interop handle")

    const ownerPath = overrideFile(dirs.state, dirs.project, INSTANCE_A)
    const resolving = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const realRealpath = fs.realpath.bind(fs)
    let resolutions = 0
    const realpath = spyOn(fs, "realpath").mockImplementation((async (
      target: Parameters<typeof fs.realpath>[0],
    ) => {
      if (String(target) === ownerPath && ++resolutions === 1) {
        resolving.resolve()
        await release.promise
      }
      return realRealpath(target)
    }) as typeof fs.realpath)
    const pending = Promise.all([providerID(interop), providerID(interop)])
    try {
      await resolving.promise
      // Evict A while its two callers share an unfinished resolution. Other
      // owners have no beacon, so none may accidentally borrow A's ready state.
      for (let i = 0; i < 8; i++) {
        discovery.setInstanceID(randomUUID())
        expect(await providerID(interop)).toBeUndefined()
      }
      release.resolve()
      await expect(pending).resolves.toEqual(["openai", "openai"])
      expect(resolutions).toBe(1)

      discovery.setInstanceID(INSTANCE_A)
      expect(await providerID(interop)).toBe("openai")
      expect(resolutions).toBe(2)
      expect(await providerID(interop)).toBe("openai")
      expect(resolutions).toBe(2)
    } finally {
      release.resolve()
      await pending
      realpath.mockRestore()
    }
  })

  test("no configuration at all reads as no classifier", async () => {
    const dirs = await makeDirs()
    const interop = await resolvedInterop(dirs)
    expect(await providerID(interop)).toBeUndefined()
  })

  test("an unset model follows the session model — no separate section", async () => {
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, { enabled: true })
    const interop = await resolvedInterop(dirs)
    expect(await providerID(interop)).toBeUndefined()
  })

  test("session records override the persistent pin independently for each root", async () => {
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, { model: "openai/gpt-5.5-codex" })
    await writeServerBeacon(dirs, "ready")
    const interop = await resolvedInterop(dirs)

    // A missing record continues to inherit the persistent pin.
    expect(await providerID(interop, { rootSessionID: "ses_inherits" })).toBe(
      "openai",
    )
    await writeSessionModel(
      sessionModelFile(sessionModelDirectory(dirs.state), "ses_inherit"),
      {
        version: 1,
        rootSessionID: "ses_inherit",
        revision: "rev-inherit",
        mode: "inherit",
        model: null,
        variant: null,
      },
    )
    await writeSessionModel(
      sessionModelFile(sessionModelDirectory(dirs.state), "ses_follows"),
      {
        version: 1,
        rootSessionID: "ses_follows",
        revision: "rev_1",
        mode: "override",
        model: null,
        variant: null,
      },
    )
    await writeSessionModel(
      sessionModelFile(sessionModelDirectory(dirs.state), "ses_pinned"),
      {
        version: 1,
        rootSessionID: "ses_pinned",
        revision: "rev_2",
        mode: "override",
        model: "opencode-go/minimax-m3",
        variant: null,
      },
    )

    expect(await providerID(interop, { rootSessionID: "ses_inherit" })).toBe(
      "openai",
    )
    expect(
      await providerID(interop, { rootSessionID: "ses_follows" }),
    ).toBeUndefined()
    expect(await providerID(interop, { rootSessionID: "ses_pinned" })).toBe(
      "opencode-go",
    )
  })

  test("malformed or unavailable session selections fail closed", async () => {
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, { model: "openai/gpt-5.5-codex" })
    await writeServerBeacon(dirs, "ready")
    const interop = await resolvedInterop(dirs)

    await write(
      sessionModelFile(sessionModelDirectory(dirs.state), "ses_bad"),
      "{not json",
    )
    expect(
      await providerID(interop, { rootSessionID: "ses_bad" }),
    ).toBeUndefined()

    await writeSessionModel(
      sessionModelFile(sessionModelDirectory(dirs.state), "ses_unknown-model"),
      {
        version: 1,
        rootSessionID: "ses_unknown-model",
        revision: "rev_1",
        mode: "override",
        model: "anthropic/claude-sonnet-5",
        variant: null,
      },
    )
    await writeSessionModel(
      sessionModelFile(
        sessionModelDirectory(dirs.state),
        "ses_unknown-variant",
      ),
      {
        version: 1,
        rootSessionID: "ses_unknown-variant",
        revision: "rev_2",
        mode: "override",
        model: "openai/gpt-5.5-codex",
        variant: "max",
      },
    )

    expect(
      await providerID(interop, { rootSessionID: "ses_unknown-model" }),
    ).toBeUndefined()
    expect(
      await providerID(interop, { rootSessionID: "ses_unknown-variant" }),
    ).toBeUndefined()
  })

  test("a session selection symlinked into the project fails closed", async () => {
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, { model: "openai/gpt-5.5-codex" })
    await writeServerBeacon(dirs, "ready")
    const sessionModelsDir = sessionModelDirectory(dirs.state)
    const sessionFile = sessionModelFile(sessionModelsDir, "ses_linked")
    const planted = path.join(dirs.project, "session-model.json")
    await writeSessionModel(planted, {
      version: 1,
      rootSessionID: "ses_linked",
      revision: "rev-linked",
      mode: "override",
      model: "opencode-go/minimax-m3",
      variant: null,
    })
    await fs.mkdir(sessionModelsDir, { recursive: true })
    await fs.symlink(planted, sessionFile)
    const interop = await resolvedInterop(dirs)

    expect(
      await providerID(interop, { rootSessionID: "ses_linked" }),
    ).toBeUndefined()
  })

  test("the trusted project file overrides the global pin, including back to unset", async () => {
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, { model: "openai/gpt-5.5-codex" })
    await writeServerBeacon(dirs, "ready")
    const projectFile = projectSettingsFile(dirs.config, dirs.project)
    const interop = await resolvedInterop(dirs)

    await write(
      projectFile,
      JSON.stringify({ model: "opencode-go/minimax-m3" }),
    )
    expect(await providerID(interop)).toBe("opencode-go")

    await write(projectFile, JSON.stringify({ model: null }))
    expect(await providerID(interop)).toBeUndefined()
  })

  test("disabled settings hide the classifier; the instance override wins both ways", async () => {
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, {
      enabled: false,
      model: "openai/gpt-5.5-codex",
    })
    await writeServerBeacon(dirs, "ready")
    const interop = await resolvedInterop(dirs)
    expect(await providerID(interop)).toBeUndefined()

    // The instance override file is what the TUI toggle writes.
    const override = overrideFile(dirs.state, dirs.project, INSTANCE_A)
    await write(override, JSON.stringify({ enabled: true }))
    expect(await providerID(interop)).toBe("openai")

    await writeGlobalEntry(dirs, {
      enabled: true,
      model: "openai/gpt-5.5-codex",
    })
    await write(override, JSON.stringify({ enabled: false }))
    expect(await providerID(interop)).toBeUndefined()
  })

  test("two owners isolate overrides while sharing project configuration", async () => {
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, {
      enabled: true,
      model: "openai/gpt-5.5-codex",
    })
    await writeServerBeacon(dirs, "ready", undefined, INSTANCE_A)
    await writeServerBeacon(dirs, "ready", undefined, INSTANCE_B)
    const ownerA = await resolveInterop(
      dirs,
      makeDiscoveryApi(dirs, INSTANCE_A).api,
    )
    const ownerB = await resolveInterop(
      dirs,
      makeDiscoveryApi(dirs, INSTANCE_B).api,
    )
    if (!ownerA || !ownerB) throw new Error("expected both interop handles")

    await write(
      overrideFile(dirs.state, dirs.project, INSTANCE_A),
      JSON.stringify({ enabled: false }),
    )
    await write(
      overrideFile(dirs.state, dirs.project, INSTANCE_B),
      JSON.stringify({ enabled: true }),
    )
    expect(await providerID(ownerA)).toBeUndefined()
    expect(await providerID(ownerB)).toBe("openai")

    await write(
      projectSettingsFile(dirs.config, dirs.project),
      JSON.stringify({ model: "opencode-go/minimax-m3" }),
    )
    expect(await providerID(ownerA)).toBeUndefined()
    expect(await providerID(ownerB)).toBe("opencode-go")

    await write(
      overrideFile(dirs.state, dirs.project, INSTANCE_A),
      JSON.stringify({ enabled: true }),
    )
    expect(await providerID(ownerA)).toBe("opencode-go")
  })

  test("an unreadable global config candidate fails closed, like approve-for-me itself", async () => {
    const dirs = await makeDirs()
    await write(path.join(dirs.config, "opencode.json"), "{not json")
    const interop = await resolvedInterop(dirs)
    expect(await providerID(interop)).toBeUndefined()
  })

  test("a mistyped model fails closed rather than guessing a provider", async () => {
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, { model: 42 })
    const interop = await resolvedInterop(dirs)
    expect(await providerID(interop)).toBeUndefined()
  })

  test("the retired bespoke global settings file pauses the classifier outright", async () => {
    // Pre-#139 policy the current release no longer reads: its mere
    // existence pauses approve-for-me, so it must yield no section here —
    // this is precisely the gate the pre-#114 consumer pipeline missed.
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, { model: "openai/gpt-5.5-codex" })
    await write(
      path.join(dirs.config, GLOBAL_SETTINGS_BASENAME),
      JSON.stringify({ enabled: true }),
    )
    const interop = await resolvedInterop(dirs)
    expect(await providerID(interop)).toBeUndefined()
  })

  test("an unblessed worktree entry pauses the classifier; blessing it restores the answer", async () => {
    const dirs = await makeDirs()
    await writeServerBeacon(dirs, "ready")
    const worktreeConfig = path.join(dirs.project, "opencode.json")
    await write(
      worktreeConfig,
      JSON.stringify({
        plugin: [[PLUGIN_PACKAGE_NAME, { model: "openai/gpt-5.5-codex" }]],
      }),
    )
    const interop = await resolvedInterop(dirs)
    expect(await providerID(interop)).toBeUndefined()

    await writeBlessing(blessFile(dirs.state, dirs.project), {
      files: {
        [worktreeConfig]: sha256Hex(await fs.readFile(worktreeConfig, "utf8")),
      },
    })
    expect(await providerID(interop)).toBe("openai")
  })

  test("a legacy in-project settings file without a trusted successor pauses", async () => {
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, { model: "openai/gpt-5.5-codex" })
    await write(
      legacyProjectSettingsFile(dirs.project),
      JSON.stringify({ enabled: true }),
    )
    const interop = await resolvedInterop(dirs)
    expect(await providerID(interop)).toBeUndefined()
  })

  test("an unresolved pre-upgrade settings file pauses", async () => {
    const dirs = await makeDirs()
    await writeGlobalEntry(dirs, { model: "openai/gpt-5.5-codex" })
    await writeServerBeacon(dirs, "ready")
    // Resolve FIRST: the trusted-path resolution would otherwise adopt a
    // lone pre-slug file to its readable name. Appearing afterwards it is
    // unresolved pre-upgrade policy (a still-running pre-slug instance, a
    // dual-name conflict), which fails closed per access.
    const interop = await resolvedInterop(dirs)
    expect(await providerID(interop)).toBe("openai")
    await write(
      preSlugProjectSettingsFile(dirs.config, dirs.project),
      JSON.stringify({ enabled: false }),
    )
    expect(await providerID(interop)).toBeUndefined()
  })
})

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  patchSettingsFile,
  projectFileKey,
  shortProjectHash,
} from "@macarons/permission-rules"
import {
  blessFile,
  clearOverride,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_UNATTENDED_DENY_MS,
  evaluateWorktreePolicy,
  formatModelRef,
  hostConfigRoot,
  isOwnPluginSpec,
  MAX_MAX_CONCURRENT,
  MAX_TIMEOUT_MS,
  MAX_UNATTENDED_DENY_MS,
  MIN_MAX_CONCURRENT,
  MIN_TIMEOUT_MS,
  MIN_UNATTENDED_DENY_MS,
  mergeSettings,
  overrideFile,
  ownPackageDir,
  parseModelRef,
  parseSettings,
  patchGlobalEntryOptions,
  preSlugProjectSettingsFile,
  projectSettingsFile,
  readBlessing,
  readGlobalEntrySettings,
  readOverride,
  readPolicySnapshot,
  readSettingsFile,
  resolveSettings,
  resolveTrustedSessionModelFile,
  resolveTrustedSettingsPaths,
  scanPluginConfigFile,
  scanSideloadSources,
  scanWorktreeConfig,
  sessionModelDirectory,
  sessionModelFile,
  sha256Hex,
  unblessedSideloads,
  worktreeConfigCandidates,
  writeBlessing,
  writeOverride,
} from "../src/shared"

/**
 * The settings pipeline is trust configuration: whether a model may approve
 * actions at all, and which model judges. Every ambiguity must resolve to
 * "surface the prompt" (fail closed), so parsing is strict, corrupt files are
 * a distinguishable state (undefined), and the merge order — global config
 * file under project file, mirroring OpenCode's own precedence — is pinned.
 */

let root: string
const instanceID = "11111111-1111-4111-8111-111111111111"
const peerID = "22222222-2222-4222-8222-222222222222"

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "auto-approve-settings-")),
  )
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("parseSettings", () => {
  test("accepts a full, valid settings object", () => {
    expect(
      parseSettings({
        enabled: false,
        model: "anthropic/claude-sonnet-5",
        variant: "high",
        timeoutMs: 10_000,
        processing: "serial",
        maxConcurrent: 8,
        notify: false,
        journal: false,
        unattendedDenyMs: 300_000,
        permissions: { edit: false },
        scope: "worktree",
      }),
    ).toEqual({
      enabled: false,
      model: "anthropic/claude-sonnet-5",
      variant: "high",
      timeoutMs: 10_000,
      processing: "serial",
      maxConcurrent: 8,
      notify: false,
      journal: false,
      unattendedDenyMs: 300_000,
      permissions: { edit: false },
      scope: "worktree",
    })
  })

  test("an empty object is valid and empty", () => {
    expect(parseSettings({})).toEqual({})
  })

  test("unknown fields like $schema are ignored", () => {
    expect(
      parseSettings({ $schema: "https://example.com", enabled: true }),
    ).toEqual({ enabled: true })
  })

  test("only own settings fields are parsed", () => {
    const inherited = Object.create({ enabled: "not a boolean" }) as Record<
      string,
      unknown
    >
    expect(parseSettings(inherited)).toEqual({})
  })

  test("permission opt-outs preserve arbitrary literal keys", () => {
    const input = JSON.parse(
      '{"permissions":{"__proto__":false,"constructor":false,"toString":false}}',
    )
    const settings = parseSettings(input)
    expect(settings).toBeDefined()
    if (!settings?.permissions) throw new Error("unreachable")
    expect(Object.getPrototypeOf(settings.permissions)).toBeNull()
    for (const key of ["__proto__", "constructor", "toString"]) {
      expect(Object.hasOwn(settings.permissions, key)).toBe(true)
      expect(settings.permissions[key]).toBe(false)
    }
  })

  test('"model": null keeps the key so a project file can override a global pin', () => {
    const parsed = parseSettings({ model: null })
    expect(parsed).toBeDefined()
    if (!parsed) throw new Error("unreachable")
    expect("model" in parsed).toBe(true)
    expect(parsed.model).toBeUndefined()
  })

  for (const cleared of [null, "default"]) {
    test(`"variant": ${JSON.stringify(cleared)} keeps the key and means the model's default effort`, () => {
      const parsed = parseSettings({ variant: cleared })
      expect(parsed).toBeDefined()
      if (!parsed) throw new Error("unreachable")
      expect("variant" in parsed).toBe(true)
      expect(parsed.variant).toBeUndefined()
    })
  }

  test('"unattendedDenyMs": null keeps the key so a project file can override a global value', () => {
    const parsed = parseSettings({ unattendedDenyMs: null })
    expect(parsed).toBeDefined()
    if (!parsed) throw new Error("unreachable")
    expect("unattendedDenyMs" in parsed).toBe(true)
    expect(parsed.unattendedDenyMs).toBeUndefined()
  })

  test('"timeoutMs": null keeps the key so a project file can override a global value', () => {
    const parsed = parseSettings({ timeoutMs: null })
    expect(parsed).toBeDefined()
    if (!parsed) throw new Error("unreachable")
    expect("timeoutMs" in parsed).toBe(true)
    expect(parsed.timeoutMs).toBeUndefined()
  })

  const invalid: [string, unknown][] = [
    ["a non-object", "enabled"],
    ["an array", []],
    ["a mistyped enabled", { enabled: "yes" }],
    ["a mistyped model", { model: 5 }],
    ["a model without a provider", { model: "claude-sonnet-5" }],
    ["a model with an empty provider", { model: "/model" }],
    ["a model with an empty model id", { model: "provider/" }],
    ["a mistyped variant", { variant: 5 }],
    ["an empty variant", { variant: "" }],
    ["a whitespace variant", { variant: "   " }],
    ["a mistyped timeout", { timeoutMs: "20s" }],
    ["a non-finite timeout", { timeoutMs: Number.POSITIVE_INFINITY }],
    ["a mistyped processing", { processing: true }],
    ["an unknown processing mode", { processing: "batched" }],
    ["a null processing", { processing: null }],
    ["a mistyped maxConcurrent", { maxConcurrent: "4" }],
    ["a null maxConcurrent", { maxConcurrent: null }],
    ["a non-finite maxConcurrent", { maxConcurrent: Number.NaN }],
    ["a mistyped notify", { notify: 1 }],
    ["a mistyped journal", { journal: "off" }],
    ["a mistyped unattendedDenyMs", { unattendedDenyMs: "20m" }],
    ["a non-finite unattendedDenyMs", { unattendedDenyMs: Number.NaN }],
    ["a mistyped permissions map", { permissions: ["edit"] }],
    ["a mistyped permissions value", { permissions: { edit: "no" } }],
    ["a mistyped scope", { scope: 5 }],
    ["an unknown scope value", { scope: "project" }],
  ]
  for (const [label, value] of invalid) {
    test(`${label} is rejected (fail closed)`, () => {
      expect(parseSettings(value)).toBeUndefined()
    })
  }
})

describe("readSettingsFile", () => {
  test("a missing file is empty settings, not an error", async () => {
    expect(await readSettingsFile(path.join(root, "nope.json"))).toEqual({})
  })

  test("round-trips arbitrary literal permission opt-outs", async () => {
    const file = path.join(root, "literal-permissions.json")
    await fs.writeFile(
      file,
      '{"permissions":{"__proto__":false,"constructor":false,"toString":false}}',
    )
    const settings = await readSettingsFile(file)
    expect(Object.getPrototypeOf(settings?.permissions)).toBeNull()
    for (const key of ["__proto__", "constructor", "toString"]) {
      expect(Object.hasOwn(settings?.permissions ?? {}, key)).toBe(true)
      expect(settings?.permissions?.[key]).toBe(false)
    }
  })

  test("a non-ENOENT read failure is undefined — callers must pause auto-approval", async () => {
    const file = path.join(root, "settings.json")
    await fs.mkdir(file)
    expect(await readSettingsFile(file)).toBeUndefined()
  })

  test("corrupt JSON is undefined — callers must pause auto-approval", async () => {
    const file = path.join(root, "settings.json")
    await fs.writeFile(file, "{not json")
    expect(await readSettingsFile(file)).toBeUndefined()
  })

  test("mistyped fields make the whole file undefined", async () => {
    const file = path.join(root, "settings.json")
    await fs.writeFile(file, JSON.stringify({ enabled: "yes" }))
    expect(await readSettingsFile(file)).toBeUndefined()
  })
})

describe("trusted project settings path", () => {
  test("uses a stable readable project key under the OpenCode config directory", () => {
    const config = path.join(root, "config")
    const first = projectSettingsFile(config, "/projects/a/../b")
    const equivalent = projectSettingsFile(config, "/projects/b")
    const other = projectSettingsFile(config, "/projects/c")

    expect(first).toBe(equivalent)
    expect(first).not.toBe(other)
    expect(path.dirname(first)).toBe(
      path.join(config, "permissions-approve-for-me", "projects"),
    )
    expect(path.basename(first)).toMatch(/^b-[a-f0-9]{16}\.json$/)
  })

  test("rejects config/state paths inside the project, including symlinks", async () => {
    const project = path.join(root, "project")
    const config = path.join(root, "config")
    const state = path.join(root, "state")
    const inside = path.join(project, "inside")
    const link = path.join(root, "config-link")
    await Promise.all([
      fs.mkdir(config),
      fs.mkdir(state),
      fs.mkdir(inside, { recursive: true }),
    ])

    expect(
      await resolveTrustedSettingsPaths(
        project,
        config,
        state,
        path.join(root, "data"),
        instanceID,
      ),
    ).toMatchObject({ stateDir: await fs.realpath(state) })
    expect(
      await resolveTrustedSettingsPaths(
        project,
        inside,
        state,
        path.join(root, "data"),
        instanceID,
      ),
    ).toBeUndefined()
    await fs.symlink(inside, link)
    expect(
      await resolveTrustedSettingsPaths(
        project,
        link,
        state,
        path.join(root, "data"),
        instanceID,
      ),
    ).toBeUndefined()
  })

  test("rejects a descendant symlink that redirects a derived settings path into the project", async () => {
    const project = path.join(root, "project")
    const config = path.join(root, "config")
    const state = path.join(root, "state")
    const inside = path.join(project, "settings")
    await Promise.all([
      fs.mkdir(config),
      fs.mkdir(state),
      fs.mkdir(inside, { recursive: true }),
    ])
    await fs.symlink(inside, path.join(config, "permissions-approve-for-me"))

    expect(
      await resolveTrustedSettingsPaths(
        project,
        config,
        state,
        path.join(root, "data"),
        instanceID,
      ),
    ).toBeUndefined()
  })

  test("rejects a session-model directory symlink redirected into the project", async () => {
    const project = path.join(root, "project")
    const config = path.join(root, "config")
    const state = path.join(root, "state")
    const inside = path.join(project, "session-models")
    await Promise.all([
      fs.mkdir(config),
      fs.mkdir(inside, { recursive: true }),
      fs.mkdir(path.join(state, "permissions-approve-for-me"), {
        recursive: true,
      }),
    ])
    await fs.symlink(inside, sessionModelDirectory(state))

    expect(
      await resolveTrustedSettingsPaths(
        project,
        config,
        state,
        path.join(root, "data"),
        instanceID,
      ),
    ).toBeUndefined()
  })

  test("rejects an individual session-model file symlink redirected into the project", async () => {
    const project = path.join(root, "project")
    const config = path.join(root, "config")
    const state = path.join(root, "state")
    await Promise.all([fs.mkdir(project), fs.mkdir(config), fs.mkdir(state)])
    const trusted = await resolveTrustedSettingsPaths(
      project,
      config,
      state,
      path.join(root, "data"),
      instanceID,
    )
    expect(trusted).toBeDefined()
    const rootSessionID = "ses_root"
    const lexical = sessionModelFile(trusted!.sessionModelsDir, rootSessionID)
    expect(
      await resolveTrustedSessionModelFile(
        trusted!.sessionModelsDir,
        rootSessionID,
      ),
    ).toBe(lexical)

    const planted = path.join(project, "session-model.json")
    await fs.mkdir(trusted!.sessionModelsDir, { recursive: true })
    await fs.writeFile(planted, "{}")
    await fs.symlink(planted, lexical)

    expect(
      await resolveTrustedSessionModelFile(
        trusted!.sessionModelsDir,
        rootSessionID,
      ),
    ).toBeUndefined()
  })

  test("a planted pre-slug file behind a rejected symlink is never moved or copied", async () => {
    // The finding-4 no-mutation invariant: rejecting the paths is not enough —
    // the adoption pass must not have moved a legacy settings file through the
    // rejected link before the rejection.
    const project = path.join(root, "project")
    const config = path.join(root, "config")
    const state = path.join(root, "state")
    const inside = path.join(project, "settings")
    await Promise.all([
      fs.mkdir(config),
      fs.mkdir(state),
      fs.mkdir(path.join(inside, "projects"), { recursive: true }),
    ])
    await fs.symlink(inside, path.join(config, "permissions-approve-for-me"))
    const legacy = preSlugProjectSettingsFile(config, project)
    await fs.writeFile(legacy, `{"enabled":false}\n`)

    expect(
      await resolveTrustedSettingsPaths(
        project,
        config,
        state,
        path.join(root, "data"),
        instanceID,
      ),
    ).toBeUndefined()

    expect(await fs.readFile(legacy, "utf8")).toBe(`{"enabled":false}\n`)
    expect(await fs.readdir(path.join(inside, "projects"))).toEqual([
      path.basename(legacy),
    ])
  })

  test("rejects descendant symlinks that escape the canonical config or state root", async () => {
    const project = path.join(root, "project")
    const config = path.join(root, "config")
    const state = path.join(root, "state")
    const escapedConfig = path.join(root, "escaped-config")
    const escapedState = path.join(root, "escaped-state")
    await Promise.all(
      [project, config, state, escapedConfig, escapedState].map((directory) =>
        fs.mkdir(directory),
      ),
    )

    await fs.symlink(
      escapedConfig,
      path.join(config, "permissions-approve-for-me"),
    )
    expect(
      await resolveTrustedSettingsPaths(
        project,
        config,
        state,
        path.join(root, "data"),
        instanceID,
      ),
    ).toBeUndefined()

    await fs.rm(path.join(config, "permissions-approve-for-me"))
    await fs.symlink(
      escapedState,
      path.join(state, "permissions-approve-for-me"),
    )
    expect(
      await resolveTrustedSettingsPaths(
        project,
        config,
        state,
        path.join(root, "data"),
        instanceID,
      ),
    ).toBeUndefined()
  })

  test("rejects a dangling descendant symlink before its project target appears", async () => {
    const project = path.join(root, "project")
    const config = path.join(root, "config")
    const state = path.join(root, "state")
    const futureInside = path.join(project, "future-settings")
    await Promise.all([fs.mkdir(project), fs.mkdir(config), fs.mkdir(state)])
    await fs.symlink(
      futureInside,
      path.join(config, "permissions-approve-for-me"),
    )

    expect(
      await resolveTrustedSettingsPaths(
        project,
        config,
        state,
        path.join(root, "data"),
        instanceID,
      ),
    ).toBeUndefined()
  })

  test("canonical project aliases select the same trusted files", async () => {
    const project = path.join(root, "project")
    const alias = path.join(root, "project-link")
    const config = path.join(root, "config")
    const state = path.join(root, "state")
    await Promise.all([fs.mkdir(project), fs.mkdir(config), fs.mkdir(state)])
    await fs.symlink(project, alias)

    const direct = await resolveTrustedSettingsPaths(
      project,
      config,
      state,
      path.join(root, "data"),
      instanceID,
    )
    const throughAlias = await resolveTrustedSettingsPaths(
      alias,
      config,
      state,
      path.join(root, "data"),
      instanceID,
    )
    expect(throughAlias).toEqual(direct)
    const peer = await resolveTrustedSettingsPaths(
      project,
      config,
      state,
      path.join(root, "data"),
      peerID,
    )
    expect(peer?.overridePath).not.toBe(direct?.overridePath)
    expect(peer?.activityPath).not.toBe(direct?.activityPath)
    expect(peer).toEqual({
      ...direct!,
      overridePath: peer!.overridePath,
      activityPath: peer!.activityPath,
    })
  })
})

describe("mergeSettings (global under project, like OpenCode config)", () => {
  test("project fields override global fields, absent fields fall through", () => {
    expect(
      mergeSettings(
        { enabled: true, model: "a/b", timeoutMs: 30_000 },
        { enabled: false },
      ),
    ).toEqual({ enabled: false, model: "a/b", timeoutMs: 30_000 })
  })

  test("the permissions map merges per key", () => {
    expect(
      mergeSettings(
        { permissions: { edit: false, bash: true } },
        { permissions: { webfetch: false, bash: false } },
      ),
    ).toEqual({ permissions: { edit: false, bash: false, webfetch: false } })
  })

  test('a project "model": null overrides a global pin back to the session model', () => {
    const project = parseSettings({ model: null })
    if (!project) throw new Error("unreachable")
    expect(mergeSettings({ model: "a/b" }, project).model).toBeUndefined()
  })

  test('a project "variant": null overrides a global pin back to the model default', () => {
    const project = parseSettings({ variant: null })
    if (!project) throw new Error("unreachable")
    expect(mergeSettings({ variant: "high" }, project).variant).toBeUndefined()
    expect(mergeSettings({ variant: "high" }, {}).variant).toBe("high")
  })

  test('a project "unattendedDenyMs": null overrides a global value back to the default', () => {
    const project = parseSettings({ unattendedDenyMs: null })
    if (!project) throw new Error("unreachable")
    expect(
      mergeSettings({ unattendedDenyMs: 0 }, project).unattendedDenyMs,
    ).toBeUndefined()
    expect(mergeSettings({ unattendedDenyMs: 0 }, {}).unattendedDenyMs).toBe(0)
  })

  test('a project "timeoutMs": null overrides a global value back to the default', () => {
    const project = parseSettings({ timeoutMs: null })
    if (!project) throw new Error("unreachable")
    expect(
      mergeSettings({ timeoutMs: 45_000 }, project).timeoutMs,
    ).toBeUndefined()
    expect(mergeSettings({ timeoutMs: 45_000 }, {}).timeoutMs).toBe(45_000)
  })
})

describe("resolveSettings", () => {
  test("defaults: enabled, notify, journal, sweep, parallel processing, session model, default effort, default timeout", () => {
    expect(resolveSettings({})).toEqual({
      enabled: true,
      model: undefined,
      variant: undefined,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      processing: "parallel",
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      notify: true,
      journal: true,
      sweepStale: true,
      unattendedDenyMs: DEFAULT_UNATTENDED_DENY_MS,
      permissions: {},
      scope: "repository",
    })
    expect(resolveSettings({ variant: "high" }).variant).toBe("high")
    expect(resolveSettings({ journal: false }).journal).toBe(false)
    expect(resolveSettings({ sweepStale: false }).sweepStale).toBe(false)
    expect(resolveSettings({ processing: "serial" }).processing).toBe("serial")
    expect(resolveSettings({ scope: "worktree" }).scope).toBe("worktree")
  })

  test("clamps the timeout into the supported band", () => {
    // The band is user-facing contract (README documents it): a 2-minute
    // default sized for local and budget cloud judges, 10-minute ceiling.
    expect(DEFAULT_TIMEOUT_MS).toBe(120_000)
    expect(MAX_TIMEOUT_MS).toBe(600_000)
    expect(resolveSettings({ timeoutMs: 1 }).timeoutMs).toBe(MIN_TIMEOUT_MS)
    expect(resolveSettings({ timeoutMs: 10 ** 9 }).timeoutMs).toBe(
      MAX_TIMEOUT_MS,
    )
    expect(resolveSettings({ timeoutMs: 42_000 }).timeoutMs).toBe(42_000)
  })

  test("unattendedDenyMs: ≤ 0 is off, positive values clamp — never deny faster than the floor", () => {
    expect(resolveSettings({ unattendedDenyMs: 0 }).unattendedDenyMs).toBe(0)
    expect(resolveSettings({ unattendedDenyMs: -1 }).unattendedDenyMs).toBe(0)
    expect(resolveSettings({ unattendedDenyMs: 1 }).unattendedDenyMs).toBe(
      MIN_UNATTENDED_DENY_MS,
    )
    expect(
      resolveSettings({ unattendedDenyMs: 10 ** 12 }).unattendedDenyMs,
    ).toBe(MAX_UNATTENDED_DENY_MS)
    expect(
      resolveSettings({ unattendedDenyMs: 300_000 }).unattendedDenyMs,
    ).toBe(300_000)
  })

  test("clamps maxConcurrent into the supported band, whole slots only", () => {
    expect(resolveSettings({ maxConcurrent: 0 }).maxConcurrent).toBe(
      MIN_MAX_CONCURRENT,
    )
    expect(resolveSettings({ maxConcurrent: -3 }).maxConcurrent).toBe(
      MIN_MAX_CONCURRENT,
    )
    expect(resolveSettings({ maxConcurrent: 1_000 }).maxConcurrent).toBe(
      MAX_MAX_CONCURRENT,
    )
    expect(resolveSettings({ maxConcurrent: 2.9 }).maxConcurrent).toBe(2)
    expect(resolveSettings({ maxConcurrent: 8 }).maxConcurrent).toBe(8)
  })
})

describe("parseModelRef", () => {
  test("splits on the first slash — model ids may contain slashes", () => {
    expect(parseModelRef("openrouter/anthropic/claude-sonnet-5")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet-5",
    })
  })

  test("round-trips through formatModelRef", () => {
    expect(formatModelRef({ providerID: "a", modelID: "b/c" })).toBe("a/b/c")
  })

  for (const bad of [
    "",
    "noslash",
    "/model",
    "provider/",
    5,
    null,
    undefined,
  ]) {
    test(`${JSON.stringify(bad)} is not a model ref`, () => {
      expect(parseModelRef(bad)).toBeUndefined()
    })
  }
})

// What the TUI writes with, so it is pinned against what this plugin READS
// with. The patch semantics themselves — merge, delete, preserve unknown
// keys, refuse a corrupt file — belong to the library now and are pinned in
// its test/promoted-helpers.test.ts.
describe("settings written by patchSettingsFile", () => {
  test("round-trip through readSettingsFile", async () => {
    const file = path.join(root, "deep", "settings.json")
    expect(
      await patchSettingsFile(file, { enabled: false, model: "a/b" }),
    ).toBe("ok")
    expect(await readSettingsFile(file)).toEqual({
      enabled: false,
      model: "a/b",
    })
  })

  test("arbitrary literal permission opt-outs survive save and parse", async () => {
    const file = path.join(root, "literal-settings.json")
    const permissions = Object.fromEntries(
      ["__proto__", "constructor", "toString"].map((key) => [key, false]),
    )
    expect(await patchSettingsFile(file, { permissions })).toBe("ok")
    const settings = await readSettingsFile(file)
    for (const key of ["__proto__", "constructor", "toString"]) {
      expect(Object.hasOwn(settings?.permissions ?? {}, key)).toBe(true)
      expect(settings?.permissions?.[key]).toBe(false)
    }
  })

  test("a null model written by the picker survives as a key and clears the pin", async () => {
    // The key has to stay in the file — that is how a project file overrides a
    // global pin — while reading back as "follow the session model".
    const file = path.join(root, "settings.json")
    expect(await patchSettingsFile(file, { enabled: true, model: "a/b" })).toBe(
      "ok",
    )
    expect(await patchSettingsFile(file, { model: null })).toBe("ok")
    expect(JSON.parse(await fs.readFile(file, "utf8")).model).toBeNull()
    const settings = await readSettingsFile(file)
    expect(settings?.enabled).toBe(true)
    expect(settings?.model).toBeUndefined()
  })

  test("a corrupt file is refused rather than flattened", async () => {
    const file = path.join(root, "settings.json")
    await fs.writeFile(file, "{not json")
    expect(await patchSettingsFile(file, { enabled: false })).toBe("corrupt")
    expect(await fs.readFile(file, "utf8")).toBe("{not json")
  })
})

describe("instance override file", () => {
  test("keyed by project root and factory UUID", () => {
    const state = path.join(root, "state")
    expect(overrideFile(state, "/project/a", instanceID)).toBe(
      overrideFile(state, "/project/a", instanceID),
    )
    expect(overrideFile(state, "/project/a", instanceID)).not.toBe(
      overrideFile(state, "/project/b", instanceID),
    )
    expect(
      overrideFile(state, "/project/a", instanceID).startsWith(
        path.join(state, "permissions-approve-for-me"),
      ),
    ).toBe(true)
    expect(overrideFile(state, "/project/a", instanceID)).not.toBe(
      overrideFile(state, "/project/a", peerID),
    )
  })

  test("absent file means no override", async () => {
    expect(await readOverride(path.join(root, "nope.json"))).toBeUndefined()
  })

  test("an unreadable override pauses approval instead of looking absent", async () => {
    const file = path.join(root, "override.json")
    await fs.mkdir(file)
    expect(await readOverride(file)).toEqual({ enabled: false })
  })

  test("round-trips a toggle, and clear removes it", async () => {
    const file = overrideFile(path.join(root, "state"), root, instanceID)
    await writeOverride(file, { enabled: false })
    expect(await readOverride(file)).toEqual({ enabled: false })
    await clearOverride(file)
    expect(await readOverride(file)).toBeUndefined()
    await clearOverride(file) // idempotent
  })

  test("the toggle timestamp round-trips; junk stamps are dropped, not trusted", async () => {
    const file = overrideFile(path.join(root, "state"), root, instanceID)
    await writeOverride(file, { enabled: true, at: 1_234 })
    expect(await readOverride(file)).toEqual({ enabled: true, at: 1_234 })
    // Older TUI halves write no stamp; wrong-typed or non-finite stamps read
    // as absent (the timer then simply cannot disarm retroactively).
    await fs.writeFile(file, JSON.stringify({ enabled: true, at: "later" }))
    expect(await readOverride(file)).toEqual({ enabled: true })
    await fs.writeFile(file, JSON.stringify({ enabled: true, at: null }))
    expect(await readOverride(file)).toEqual({ enabled: true })
  })

  test("a corrupt override pauses approval instead of falling through to on", async () => {
    const file = path.join(root, "override.json")
    await fs.writeFile(file, "{not json")
    expect(await readOverride(file)).toEqual({ enabled: false })
    await fs.writeFile(file, JSON.stringify({ enabled: "yes" }))
    expect(await readOverride(file)).toEqual({ enabled: false })
  })
})

describe("owned override channel", () => {
  test("leaves both unowned generations untouched rather than inheriting or dual-writing them", async () => {
    const state = path.join(root, "state")
    const current = overrideFile(state, root, instanceID)
    const oldFiles = [projectFileKey(root), shortProjectHash(root)].map((key) =>
      path.join(state, "permissions-approve-for-me", `override-${key}.json`),
    )
    const bytes = '{ "enabled": false, "at": 7 }\n'
    await fs.mkdir(path.dirname(current), { recursive: true })
    for (const file of oldFiles) await fs.writeFile(file, bytes)
    expect(await readOverride(current)).toBeUndefined()
    await writeOverride(current, { enabled: false })
    await writeOverride(current, { enabled: true })
    await clearOverride(current)
    for (const file of oldFiles)
      expect(await fs.readFile(file, "utf8")).toBe(bytes)
  })

  test("rejects missing, malformed, and path-like owner IDs", async () => {
    for (const invalid of [
      undefined,
      "",
      "../peer",
      `${instanceID}/../peer`,
      "not-a-uuid",
    ]) {
      expect(() => overrideFile(root, root, invalid as string)).toThrow(
        "invalid instance ID",
      )
      expect(
        await resolveTrustedSettingsPaths(
          path.join(root, "project"),
          path.join(root, "config"),
          path.join(root, "state"),
          path.join(root, "data"),
          invalid as string,
        ),
      ).toBeUndefined()
    }
  })
})

describe("opencode.json[c] as the settings source", () => {
  const NAME = "@macarons/approve-for-me"
  const packageRoot = path.resolve(import.meta.dir, "..")
  const configD = () => path.join(root, "xdg-config")
  const stateD = () => path.join(root, "xdg-state")
  const project = () => path.join(root, "project")

  beforeEach(async () => {
    await Promise.all([
      fs.mkdir(configD(), { recursive: true }),
      fs.mkdir(stateD(), { recursive: true }),
      fs.mkdir(project(), { recursive: true }),
    ])
  })

  async function write(file: string, text: string) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  }

  const snapshotInput = () => ({
    configDir: configD(),
    projectSettingsFile: projectSettingsFile(configD(), project()),
    blessPath: blessFile(stateD(), project()),
    legacyGlobalFile: path.join(configD(), "permissions-approve-for-me.json"),
    directory: project(),
    projectRoot: project(),
    configRoot: project(),
    packageDir: undefined,
  })

  test("worktreeConfigCandidates walks the directory chain in host merge order", () => {
    const dir = path.join(project(), "packages", "app")
    expect(worktreeConfigCandidates(dir, project())).toEqual([
      path.join(project(), "opencode.json"),
      path.join(project(), "opencode.jsonc"),
      path.join(project(), "packages", "opencode.json"),
      path.join(project(), "packages", "opencode.jsonc"),
      path.join(dir, "opencode.json"),
      path.join(dir, "opencode.jsonc"),
      path.join(dir, ".opencode", "opencode.json"),
      path.join(dir, ".opencode", "opencode.jsonc"),
      path.join(project(), "packages", ".opencode", "opencode.json"),
      path.join(project(), "packages", ".opencode", "opencode.jsonc"),
      path.join(project(), ".opencode", "opencode.json"),
      path.join(project(), ".opencode", "opencode.jsonc"),
    ])
  })

  test("a directory outside the root collapses to the root alone", () => {
    expect(
      worktreeConfigCandidates(path.join(root, "elsewhere"), project()),
    ).toEqual([
      path.join(project(), "opencode.json"),
      path.join(project(), "opencode.jsonc"),
      path.join(project(), ".opencode", "opencode.json"),
      path.join(project(), ".opencode", "opencode.jsonc"),
    ])
  })

  test('hostConfigRoot keeps the host\'s "/" stop for non-git sessions', () => {
    expect(hostConfigRoot("/repo/worktree")).toBe("/repo/worktree")
    expect(hostConfigRoot("/")).toBe("/")
    expect(hostConfigRoot(undefined)).toBe("/")
    expect(hostConfigRoot("")).toBe("/")
  })

  test('the "/" boundary walks every ancestor, exactly like the host', () => {
    const candidates = worktreeConfigCandidates(project(), "/")
    // Outermost first for the root chain: "/" leads, the launch directory
    // closes, and each ancestor in between appears.
    expect(candidates[0]).toBe(path.join("/", "opencode.json"))
    expect(candidates).toContain(path.join(root, "opencode.json"))
    expect(candidates).toContain(path.join(project(), "opencode.jsonc"))
    expect(candidates.indexOf(path.join(root, "opencode.json"))).toBeLessThan(
      candidates.indexOf(path.join(project(), "opencode.json")),
    )
    // The .opencode pairs come nearest-first.
    expect(
      candidates.indexOf(path.join(project(), ".opencode", "opencode.json")),
    ).toBeLessThan(
      candidates.indexOf(path.join(root, ".opencode", "opencode.json")),
    )
  })

  test("a parent directory's config is seen when the boundary extends past the project", async () => {
    // A non-git session: the project root pins state to the launch
    // directory, but the host discovers config in every ancestor — a parent
    // entry must reach the policy pipeline (here: as an unblessed pause).
    const parentConfig = path.join(root, "opencode.json")
    await write(
      parentConfig,
      JSON.stringify({ plugin: [[NAME, { enabled: false }]] }),
    )
    const snapshot = await readPolicySnapshot({
      ...snapshotInput(),
      configRoot: root,
    })
    expect(snapshot.fault).toEqual({
      kind: "worktree-unblessed",
      files: [parentConfig],
    })
    await fs.rm(parentConfig)
  })

  test("OPENCODE_DISABLE_PROJECT_CONFIG makes the project layers inert, like the host", async () => {
    await write(
      path.join(configD(), "opencode.jsonc"),
      JSON.stringify({ plugin: [[NAME, { model: "a/b" }]] }),
    )
    const worktree = path.join(project(), "opencode.json")
    await write(
      worktree,
      JSON.stringify({ plugin: [[NAME, { model: "x/y", enabled: false }]] }),
    )
    await write(
      path.join(project(), ".opencode", "plugin", "extra.ts"),
      "export const x = 1\n",
    )
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
    try {
      const snapshot = await readPolicySnapshot(snapshotInput())
      // No unblessed pause, no sideload warning, and the global entry stays
      // authoritative: the host loads neither project surface.
      expect(snapshot.fault).toBeUndefined()
      expect(snapshot.settings).toEqual({ model: "a/b" })
      expect(snapshot.sideloads).toEqual([])
    } finally {
      delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
    }
    const live = await readPolicySnapshot(snapshotInput())
    expect(live.fault).toEqual({
      kind: "worktree-unblessed",
      files: [worktree],
    })
  })

  test("scanPluginConfigFile parses JSONC, matches name specs with versions, and lists every spec", async () => {
    const file = path.join(configD(), "opencode.jsonc")
    await write(
      file,
      `{
  // a comment
  "theme": "dark",
  "plugin": [
    "some-other-plugin",
    ["${NAME}@1.2.3", { "timeoutMs": 45000 }],
  ],
}`,
    )
    const scan = await scanPluginConfigFile(file, undefined)
    if (scan === "missing" || scan === "unreadable")
      throw new Error(`unexpected ${scan}`)
    expect(scan.hasOwnEntry).toBe(true)
    expect(scan.ownOptions).toEqual({ timeoutMs: 45_000 })
    expect(scan.pluginSpecs).toEqual(["some-other-plugin", `${NAME}@1.2.3`])
    expect(scan.hash).toBe(sha256Hex(await fs.readFile(file, "utf8")))
  })

  test("JSONC plugin options preserve arbitrary literal permission keys", async () => {
    const file = path.join(configD(), "opencode.jsonc")
    await write(
      file,
      `{
  // Permission names are open strings.
  "plugin": [["${NAME}", {
    "permissions": {
      "__proto__": false,
      "constructor": false,
      "toString": false,
    },
  }]],
}`,
    )
    const global = await readGlobalEntrySettings(
      configD(),
      undefined,
      project(),
    )
    expect(global).toBeDefined()
    if (!global?.settings.permissions) throw new Error("unreachable")
    expect(Object.getPrototypeOf(global.settings.permissions)).toBeNull()
    for (const key of ["__proto__", "constructor", "toString"]) {
      expect(Object.hasOwn(global.settings.permissions, key)).toBe(true)
      expect(global.settings.permissions[key]).toBe(false)
    }
  })

  test("ownPackageDir identifies the existing shipped package root", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
    )
    expect(manifest.name).toBe(NAME)
    expect(await ownPackageDir()).toBe(await fs.realpath(packageRoot))
  })

  for (const entry of [".", "src/index.ts"]) {
    test.each(["absolute", "relative", "file-URL"])(
      `%s ${entry} entries retain their options, including enabled:false`,
      async (spelling) => {
        const target = await fs.realpath(path.join(packageRoot, entry))
        const spec =
          spelling === "file-URL"
            ? pathToFileURL(target).href
            : spelling === "relative"
              ? path.relative(configD(), target)
              : target
        const file = path.join(configD(), "opencode.json")
        const options = {
          enabled: false,
          model: "e2e/test",
          timeoutMs: 45_000,
          journal: false,
        }
        await write(file, JSON.stringify({ plugin: [[spec, options]] }))
        const packageDir = await ownPackageDir()
        const scan = await scanPluginConfigFile(file, packageDir)
        if (scan === "missing" || scan === "unreadable")
          throw new Error(`unexpected ${scan}`)
        expect(scan.hasOwnEntry).toBe(true)
        expect(scan.ownOptions).toEqual(options)
        expect(
          await readGlobalEntrySettings(configD(), packageDir, project()),
        ).toEqual({ settings: options, file })
      },
    )
  }

  test("parent, sibling, and similarly prefixed package paths do not match", async () => {
    const packageDir = path.join(root, "own-package")
    const sibling = path.join(root, "foreign-package")
    await write(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: NAME }),
    )
    await write(
      path.join(sibling, "src/index.ts"),
      "export default () => ({})\n",
    )
    const file = path.join(configD(), "opencode.json")
    for (const spec of [
      path.dirname(packageDir),
      sibling,
      path.relative(configD(), sibling),
      pathToFileURL(path.join(sibling, "src/index.ts")).href,
      `${packageDir}-other`,
      pathToFileURL(path.join(root, "elsewhere.ts")).href,
    ]) {
      await write(
        file,
        JSON.stringify({ plugin: [[spec, { enabled: false }]] }),
      )
      const scan = await scanPluginConfigFile(file, packageDir)
      if (scan === "missing" || scan === "unreadable")
        throw new Error(`unexpected ${scan} for ${spec}`)
      expect(scan.hasOwnEntry).toBe(false)
      expect(
        await readGlobalEntrySettings(configD(), packageDir, project()),
      ).toEqual({ settings: {} })
    }
  })

  test("the last own entry wins across name and path specs, including bare entries", async () => {
    const enabled = [NAME, { enabled: true, model: "e2e/test" }]
    const disabled = [pathToFileURL(packageRoot).href, { enabled: false }]
    const file = path.join(configD(), "opencode.json")
    const packageDir = await ownPackageDir()
    for (const [plugin, settings] of [
      [[enabled, disabled], { enabled: false }],
      [[disabled, enabled], { enabled: true, model: "e2e/test" }],
      [[disabled, NAME], {}],
    ] as const) {
      await write(file, JSON.stringify({ plugin }))
      expect(
        await readGlobalEntrySettings(configD(), packageDir, project()),
      ).toEqual({ settings, file })
    }
  })

  test("standalone matching caches its own file but re-resolves configured symlinks", async () => {
    const ownFile = await fs.realpath(
      path.join(packageRoot, "src/shared/config-policy.ts"),
    )
    const foreignFile = path.join(root, "foreign.ts")
    const link = path.join(configD(), "plugin.ts")
    await write(foreignFile, "export default () => ({})\n")
    await fs.symlink(ownFile, link)
    expect(await isOwnPluginSpec(link, configD(), undefined)).toBe(true)

    const realpath = spyOn(fs, "realpath")
    try {
      expect(await isOwnPluginSpec(link, configD(), undefined)).toBe(true)
      await fs.unlink(link)
      await fs.symlink(foreignFile, link)
      expect(await isOwnPluginSpec(link, configD(), undefined)).toBe(false)
      expect(
        realpath.mock.calls.filter(([target]) => target === ownFile),
      ).toHaveLength(0)
      expect(
        realpath.mock.calls.filter(([target]) => target === link),
      ).toHaveLength(2)
    } finally {
      realpath.mockRestore()
    }
  })

  test.each(["node_modules/foreign-plugin", "plugins/foreign-plugin"])(
    "a physically nested package at %s cannot replace this plugin's disabled options",
    async (nested) => {
      const packageDir = path.join(root, "own-package")
      const foreignDir = path.join(packageDir, nested)
      const foreignFile = path.join(foreignDir, "index.js")
      await write(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: NAME }),
      )
      await write(
        path.join(foreignDir, "package.json"),
        JSON.stringify({ name: "foreign-plugin", main: "index.js" }),
      )
      await write(foreignFile, "export default () => ({})\n")
      const file = path.join(configD(), "opencode.json")
      for (const spec of [foreignDir, foreignFile]) {
        await write(
          file,
          JSON.stringify({
            plugin: [
              [packageDir, { enabled: false }],
              [spec, { enabled: true }],
            ],
          }),
        )
        expect(
          await readGlobalEntrySettings(configD(), packageDir, project()),
        ).toEqual({ settings: { enabled: false }, file })
      }
    },
  )

  test("junk plugin shapes are unreadable, never guessed at", async () => {
    const file = path.join(configD(), "opencode.json")
    for (const plugin of [{}, [5], [["x", {}, 3]], "not-an-array"]) {
      await write(file, JSON.stringify({ plugin }))
      expect(await scanPluginConfigFile(file, undefined)).toBe("unreadable")
    }
    await write(file, "{broken")
    expect(await scanPluginConfigFile(file, undefined)).toBe("unreadable")
  })

  test("package names, versions, and npm aliases name only this plugin", async () => {
    const file = path.join(configD(), "opencode.json")
    for (const spec of [
      NAME,
      `${NAME}@0.1.0`,
      `npm:${NAME}@0.1.0`,
      `npm:${NAME}`,
      `afm@npm:${NAME}@0.1.0`,
      "@macarons/permissions-approve-for-me",
      "@macarons/permissions-approve-for-me@0.1.0",
      "npm:@macarons/permissions-approve-for-me@0.1.0",
      "@mcolsen-opencode/permissions-approve-for-me",
      "@mcolsen-opencode/permissions-approve-for-me@0.1.0",
      "npm:@mcolsen-opencode/permissions-approve-for-me@0.1.0",
      "opencode-permissions-approve-for-me",
      "opencode-permissions-approve-for-me@0.1.0",
      "opencode-approve-for-me",
      "opencode-approve-for-me@0.1.0",
    ]) {
      await write(
        file,
        JSON.stringify({ plugin: [[spec, { enabled: false }]] }),
      )
      const scan = await scanPluginConfigFile(file, undefined)
      if (scan === "missing" || scan === "unreadable")
        throw new Error(`unexpected ${scan} for ${spec}`)
      expect(scan.hasOwnEntry).toBe(true)
      expect(scan.ownOptions).toEqual({ enabled: false })
    }
    for (const spec of [
      "@scope/unrelated",
      "npm:@scope/other@1.0.0",
      `${NAME}@npm:@scope/other@1.0.0`,
      `${NAME}-other@0.1.0`,
      `npm:${NAME}-other@0.1.0`,
      "@mcolsen-opencode/permissions-approve-for-me-other",
      "opencode-permissions-approve-for-me-other",
    ]) {
      await write(file, JSON.stringify({ plugin: [spec] }))
      const foreign = await scanPluginConfigFile(file, undefined)
      if (foreign === "missing" || foreign === "unreadable")
        throw new Error(`unexpected ${foreign} for ${spec}`)
      expect(foreign.hasOwnEntry).toBe(false)
    }
  })

  test("a legacy package entry still preserves disabled policy and opt-outs", async () => {
    const file = path.join(configD(), "opencode.json")
    const settings = {
      enabled: false,
      model: "a/b",
      permissions: { edit: false, bash: false },
    }
    await write(
      file,
      JSON.stringify({
        plugin: [
          [NAME, { enabled: true }],
          ["@macarons/permissions-approve-for-me", settings],
        ],
      }),
    )

    expect(
      await readGlobalEntrySettings(configD(), undefined, project()),
    ).toEqual({ settings, file })
    const snapshot = await readPolicySnapshot(snapshotInput())
    expect(snapshot.fault).toBeUndefined()
    expect(snapshot.settings).toEqual(settings)
  })

  test('a bare "."-prefixed spec is a path (host isPathPluginSpec), not a package name', async () => {
    const packageDir = await ownPackageDir()
    if (!packageDir) throw new Error("own package dir unresolved")
    // The config directory carries a ".pkg" link to this package: the host
    // resolves ".pkg" as a path relative to the config file, so the scanner
    // must too — the old "./"-only test read it as a (foreign) name.
    await fs.symlink(packageRoot, path.join(configD(), ".pkg"))
    const file = path.join(configD(), "opencode.json")
    await write(
      file,
      JSON.stringify({
        plugin: [[".pkg", { enabled: false, timeoutMs: 30_000 }]],
      }),
    )
    const scan = await scanPluginConfigFile(file, packageDir)
    if (scan === "missing" || scan === "unreadable")
      throw new Error(`unexpected ${scan}`)
    expect(scan.hasOwnEntry).toBe(true)
    expect(scan.ownOptions).toEqual({ enabled: false, timeoutMs: 30_000 })
  })

  test("{env:} substitution is mirrored; a substituted spec still names this plugin", async () => {
    const file = path.join(configD(), "opencode.json")
    process.env.AFM_TEST_SPEC = NAME
    try {
      await write(
        file,
        JSON.stringify({
          plugin: [["{env:AFM_TEST_SPEC}", { notify: false }]],
        }),
      )
      const scan = await scanPluginConfigFile(file, undefined)
      if (scan === "missing" || scan === "unreadable")
        throw new Error(`unexpected ${scan}`)
      expect(scan.hasOwnEntry).toBe(true)
      expect(scan.ownOptions).toEqual({ notify: false })
    } finally {
      delete process.env.AFM_TEST_SPEC
    }
    // Unset, the host substitutes "" — an empty spec no one can load.
    const unset = await scanPluginConfigFile(file, undefined)
    if (unset === "missing" || unset === "unreadable")
      throw new Error(`unexpected ${unset}`)
    expect(unset.hasOwnEntry).toBe(false)
  })

  test("a live {file:} substitution fails closed; a commented one is inert", async () => {
    const file = path.join(configD(), "opencode.jsonc")
    await write(file, JSON.stringify({ plugin: ["{file:./spec.txt}"] }))
    expect(await scanPluginConfigFile(file, undefined)).toBe("unreadable")
    await write(
      file,
      `{
  // {file:./spec.txt} would substitute here if uncommented
  "plugin": []
}`,
    )
    const scan = await scanPluginConfigFile(file, undefined)
    if (scan === "missing" || scan === "unreadable")
      throw new Error(`unexpected ${scan}`)
    expect(scan.definesPlugin).toBe(true)
    expect(scan.pluginSpecs).toEqual([])
  })

  test("the later global candidate's entry replaces the earlier one wholly", async () => {
    await write(
      path.join(configD(), "config.json"),
      JSON.stringify({ plugin: [[NAME, { model: "a/b", journal: false }]] }),
    )
    await write(
      path.join(configD(), "opencode.jsonc"),
      JSON.stringify({ plugin: [[NAME, { timeoutMs: 45_000 }]] }),
    )
    const global = await readGlobalEntrySettings(
      configD(),
      undefined,
      project(),
    )
    expect(global?.settings).toEqual({ timeoutMs: 45_000 })
    expect(global?.file).toBe(path.join(configD(), "opencode.jsonc"))
  })

  test("a later plugin array without this plugin shadows an earlier entry wholly", async () => {
    await write(
      path.join(configD(), "config.json"),
      JSON.stringify({ plugin: [[NAME, { enabled: false, model: "a/b" }]] }),
    )
    // The host's global merge REPLACES the whole array: only
    // "some-other-plugin" survives, so the config.json options are dead and
    // must not be honored as policy.
    await write(
      path.join(configD(), "opencode.json"),
      JSON.stringify({ plugin: ["some-other-plugin"] }),
    )
    const shadowedByForeign = await readGlobalEntrySettings(
      configD(),
      undefined,
      project(),
    )
    expect(shadowedByForeign?.settings).toEqual({})
    expect(shadowedByForeign?.file).toBeUndefined()

    await write(
      path.join(configD(), "opencode.jsonc"),
      JSON.stringify({ plugin: [] }),
    )
    const shadowedByEmpty = await readGlobalEntrySettings(
      configD(),
      undefined,
      project(),
    )
    expect(shadowedByEmpty?.settings).toEqual({})
  })

  test("a later file WITHOUT a plugin key does not shadow the earlier entry", async () => {
    await write(
      path.join(configD(), "config.json"),
      JSON.stringify({ plugin: [[NAME, { journal: false }]] }),
    )
    await write(
      path.join(configD(), "opencode.jsonc"),
      JSON.stringify({ theme: "dark" }),
    )
    const global = await readGlobalEntrySettings(
      configD(),
      undefined,
      project(),
    )
    expect(global?.settings).toEqual({ journal: false })
    expect(global?.file).toBe(path.join(configD(), "config.json"))
  })

  test("a global candidate symlinked into the project fails closed on read and save", async () => {
    const target = path.join(project(), "opencode.jsonc")
    await write(target, JSON.stringify({ plugin: [[NAME, { enabled: true }]] }))
    await fs.symlink(target, path.join(configD(), "opencode.jsonc"))
    expect(
      await readGlobalEntrySettings(configD(), undefined, project()),
    ).toBeUndefined()
    expect(
      await patchGlobalEntryOptions(configD(), undefined, project(), {
        enabled: false,
      }),
    ).toBe("unsafe")
  })

  test("a global candidate symlinked outside the config directory fails closed", async () => {
    const target = path.join(root, "elsewhere.json")
    await write(target, JSON.stringify({ plugin: [[NAME, {}]] }))
    await fs.symlink(target, path.join(configD(), "opencode.json"))
    expect(
      await readGlobalEntrySettings(configD(), undefined, project()),
    ).toBeUndefined()
  })

  test("a candidate symlinked WITHIN the config directory stays trusted", async () => {
    await write(
      path.join(configD(), "opencode.jsonc"),
      JSON.stringify({ plugin: [[NAME, { notify: false }]] }),
    )
    await fs.symlink(
      path.join(configD(), "opencode.jsonc"),
      path.join(configD(), "config.json"),
    )
    const global = await readGlobalEntrySettings(
      configD(),
      undefined,
      project(),
    )
    expect(global?.settings).toEqual({ notify: false })
  })

  test("no global entry means empty settings; unreadable or mistyped fails closed", async () => {
    expect(
      (await readGlobalEntrySettings(configD(), undefined, project()))
        ?.settings,
    ).toEqual({})
    await write(path.join(configD(), "opencode.json"), "{broken")
    expect(
      await readGlobalEntrySettings(configD(), undefined, project()),
    ).toBeUndefined()
    await write(
      path.join(configD(), "opencode.json"),
      JSON.stringify({ plugin: [[NAME, { timeoutMs: "slow" }]] }),
    )
    expect(
      await readGlobalEntrySettings(configD(), undefined, project()),
    ).toBeUndefined()
  })

  test("worktree config naming this plugin pends until blessed, applies, then pends on drift", async () => {
    const file = path.join(project(), ".opencode", "opencode.json")
    await write(
      file,
      JSON.stringify({ plugin: [[NAME, { permissions: { bash: false } }]] }),
    )
    const scan = await scanWorktreeConfig(project(), project(), undefined)
    expect(scan.unreadable).toEqual([])

    const empty = await readBlessing(blessFile(stateD(), project()))
    if (!empty) throw new Error("blessing unreadable")
    expect(evaluateWorktreePolicy(scan, empty)).toEqual({
      state: "pending",
      pending: [file],
    })

    await writeBlessing(blessFile(stateD(), project()), {
      files: { [file]: sha256Hex(await fs.readFile(file, "utf8")) },
    })
    const blessed = await readBlessing(blessFile(stateD(), project()))
    if (!blessed) throw new Error("blessing unreadable")
    expect(evaluateWorktreePolicy(scan, blessed)).toEqual({
      state: "ok",
      settings: { permissions: { bash: false } },
      blessedFiles: [file],
    })

    await fs.appendFile(file, "\n")
    const drifted = await scanWorktreeConfig(project(), project(), undefined)
    expect(evaluateWorktreePolicy(drifted, blessed)).toEqual({
      state: "pending",
      pending: [file],
    })
  })

  test("deleting a blessed policy-supplying file pends instead of widening to defaults", async () => {
    const file = path.join(project(), ".opencode", "opencode.json")
    await write(file, JSON.stringify({ plugin: [[NAME, { enabled: false }]] }))
    const blessing = {
      files: { [file]: sha256Hex(await fs.readFile(file, "utf8")) },
      policy: [file],
    }
    await fs.rm(file)
    const scan = await scanWorktreeConfig(project(), project(), undefined)
    expect(evaluateWorktreePolicy(scan, blessing)).toEqual({
      state: "pending",
      pending: [file],
    })
  })

  test("removing only the plugin entry from a blessed file pends too", async () => {
    const file = path.join(project(), ".opencode", "opencode.json")
    await write(
      file,
      JSON.stringify({ plugin: [[NAME, { permissions: { bash: false } }]] }),
    )
    const blessing = {
      files: { [file]: sha256Hex(await fs.readFile(file, "utf8")) },
      policy: [file],
    }
    await write(file, JSON.stringify({ plugin: [] }))
    const scan = await scanWorktreeConfig(project(), project(), undefined)
    expect(evaluateWorktreePolicy(scan, blessing)).toEqual({
      state: "pending",
      pending: [file],
    })
  })

  test("a pre-policy blessing record holds every blessed config candidate to the same bar", async () => {
    const file = path.join(project(), "opencode.jsonc")
    await write(file, JSON.stringify({ plugin: [[NAME, { journal: false }]] }))
    const blessing = {
      files: { [file]: sha256Hex(await fs.readFile(file, "utf8")) },
    }
    await fs.rm(file)
    const scan = await scanWorktreeConfig(project(), project(), undefined)
    expect(evaluateWorktreePolicy(scan, blessing)).toEqual({
      state: "pending",
      pending: [file],
    })
  })

  test("a removed blessed sideload source does not pend — removal only unloads code", async () => {
    const source = path.join(project(), ".opencode", "plugin", "extra.ts")
    const legacy = { files: { [source]: sha256Hex("gone") } }
    const scan = await scanWorktreeConfig(project(), project(), undefined)
    expect(evaluateWorktreePolicy(scan, legacy)).toEqual({
      state: "ok",
      settings: {},
      blessedFiles: [],
    })
    const explicit = { files: { [source]: sha256Hex("gone") }, policy: [] }
    expect(evaluateWorktreePolicy(scan, explicit)).toEqual({
      state: "ok",
      settings: {},
      blessedFiles: [],
    })
  })

  test("an unreadable worktree candidate or blessing record fails closed", async () => {
    const file = path.join(project(), "opencode.jsonc")
    await write(file, "{broken")
    const scan = await scanWorktreeConfig(project(), project(), undefined)
    expect(scan.unreadable).toEqual([file])

    await write(blessFile(stateD(), project()), "{broken")
    expect(await readBlessing(blessFile(stateD(), project()))).toBeUndefined()
  })

  test("unblessedSideloads flags plugin-bearing files and sources the blessing does not cover", async () => {
    const config = path.join(project(), "opencode.json")
    await write(config, JSON.stringify({ plugin: ["@scope/foreign"] }))
    const source = path.join(project(), ".opencode", "plugin", "extra.ts")
    await write(source, "export const x = 1\n")

    const scan = await scanWorktreeConfig(project(), project(), undefined)
    const sources = await scanSideloadSources(project(), project())
    expect(sources).toEqual([
      { file: source, hash: sha256Hex("export const x = 1\n") },
    ])
    expect(unblessedSideloads(scan, sources, { files: {} })).toEqual([
      config,
      source,
    ])
    const blessing = {
      files: {
        [config]: sha256Hex(await fs.readFile(config, "utf8")),
        [source]: sha256Hex("export const x = 1\n"),
      },
    }
    expect(unblessedSideloads(scan, sources, blessing)).toEqual([])
  })

  test("patchGlobalEntryOptions edits atomically while preserving JSONC and mode", async () => {
    const file = path.join(configD(), "opencode.jsonc")
    await write(
      file,
      `{
  // keep this comment
  "theme": "dark",
  "plugin": [
    ["${NAME}", { "model": "e2e/other", "journal": false }],
  ],
}`,
    )
    if (process.platform !== "win32") await fs.chmod(file, 0o666)
    const previousUmask =
      process.platform === "win32" ? undefined : process.umask(0o077)
    try {
      expect(
        await patchGlobalEntryOptions(configD(), undefined, project(), {
          timeoutMs: 300_000,
          journal: undefined,
        }),
      ).toBe("ok")
    } finally {
      if (previousUmask !== undefined) process.umask(previousUmask)
    }
    const text = await fs.readFile(file, "utf8")
    expect(text).toContain("// keep this comment")
    expect(text).toContain('"theme": "dark"')
    if (process.platform !== "win32")
      expect((await fs.stat(file)).mode & 0o777).toBe(0o666)
    const scan = await scanPluginConfigFile(file, undefined)
    if (scan === "missing" || scan === "unreadable")
      throw new Error(`unexpected ${scan}`)
    expect(scan.ownOptions).toEqual({ model: "e2e/other", timeoutMs: 300_000 })
  })

  test("patchGlobalEntryOptions serializes concurrent disjoint patches", async () => {
    const file = path.join(configD(), "opencode.json")
    await write(file, JSON.stringify({ plugin: [[NAME, {}]] }))
    const lockFile = `${file}.lock`
    const realWriteFile = fs.writeFile.bind(fs) as (
      ...args: any[]
    ) => Promise<void>
    const realRename = fs.rename.bind(fs) as (...args: any[]) => Promise<void>
    let releasePublish: (() => void) | undefined
    const publishMayProceed = new Promise<void>((resolve) => {
      releasePublish = resolve
    })
    let lockWrites = 0
    let destinationRenames = 0
    const writeFile = spyOn(fs, "writeFile").mockImplementation((async (
      ...args: any[]
    ) => {
      if (String(args[0]) === lockFile && ++lockWrites === 2) releasePublish?.()
      await realWriteFile(...args)
    }) as typeof fs.writeFile)
    const rename = spyOn(fs, "rename").mockImplementation((async (
      ...args: any[]
    ) => {
      const source = String(args[0])
      const target = String(args[1])
      if (
        target === file &&
        source.startsWith(`${file}.`) &&
        source.endsWith(".tmp")
      ) {
        destinationRenames += 1
        if (destinationRenames === 1) await publishMayProceed
        else releasePublish?.()
      }
      await realRename(...args)
    }) as typeof fs.rename)
    try {
      expect(
        await Promise.all([
          patchGlobalEntryOptions(configD(), undefined, project(), {
            notify: false,
          }),
          patchGlobalEntryOptions(configD(), undefined, project(), {
            journal: false,
          }),
        ]),
      ).toEqual(["ok", "ok"])
    } finally {
      releasePublish?.()
      rename.mockRestore()
      writeFile.mockRestore()
    }

    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      plugin: [[NAME, { notify: false, journal: false }]],
    })
    expect(destinationRenames).toBe(2)
    expect(
      (await fs.readdir(configD())).filter(
        (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
      ),
    ).toEqual([])
  })

  test("patchGlobalEntryOptions retries from a concurrent editor's replacement", async () => {
    const file = path.join(configD(), "opencode.jsonc")
    await write(
      file,
      JSON.stringify({ plugin: [[NAME, { notify: false }]], theme: "dark" }),
    )
    const realWriteFile = fs.writeFile.bind(fs) as (
      ...args: any[]
    ) => Promise<void>
    const realRename = fs.rename.bind(fs)
    let replaced = false
    const writeFile = spyOn(fs, "writeFile").mockImplementation((async (
      ...args: any[]
    ) => {
      await realWriteFile(...args)
      const target = String(args[0])
      if (
        !replaced &&
        target.startsWith(`${file}.`) &&
        target.endsWith(".tmp")
      ) {
        replaced = true
        const editor = `${file}.editor`
        await realWriteFile(
          editor,
          JSON.stringify({
            plugin: [[NAME, { notify: false, journal: false }]],
            theme: "light",
          }),
        )
        await realRename(editor, file)
      }
    }) as typeof fs.writeFile)
    try {
      expect(
        await patchGlobalEntryOptions(configD(), undefined, project(), {
          timeoutMs: 60_000,
        }),
      ).toBe("ok")
    } finally {
      writeFile.mockRestore()
    }
    expect(replaced).toBe(true)
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      plugin: [[NAME, { notify: false, journal: false, timeoutMs: 60_000 }]],
      theme: "light",
    })
  })

  test("patchGlobalEntryOptions reports persistent publication conflicts", async () => {
    const file = path.join(configD(), "opencode.json")
    await write(file, JSON.stringify({ plugin: [[NAME, { revision: 0 }]] }))
    const realWriteFile = fs.writeFile.bind(fs) as (
      ...args: any[]
    ) => Promise<void>
    const realRename = fs.rename.bind(fs)
    let revision = 0
    const retryDelays: number[] = []
    const realSetTimeout = globalThis.setTimeout.bind(globalThis)
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: any[]) => void,
      delay?: number,
      ...args: any[]
    ) => {
      retryDelays.push(delay ?? 0)
      return realSetTimeout(callback, 0, ...args)
    }) as typeof setTimeout)
    const writeFile = spyOn(fs, "writeFile").mockImplementation((async (
      ...args: any[]
    ) => {
      await realWriteFile(...args)
      const target = String(args[0])
      if (target.startsWith(`${file}.`) && target.endsWith(".tmp")) {
        revision += 1
        const editor = `${file}.editor`
        await realWriteFile(
          editor,
          JSON.stringify({ plugin: [[NAME, { revision }]] }),
        )
        await realRename(editor, file)
      }
    }) as typeof fs.writeFile)
    try {
      expect(
        await patchGlobalEntryOptions(configD(), undefined, project(), {
          enabled: false,
        }),
      ).toBe("conflict")
    } finally {
      writeFile.mockRestore()
      timeout.mockRestore()
    }
    expect(revision).toBe(3)
    expect(retryDelays).toHaveLength(2)
    expect(retryDelays[0]).toBeGreaterThanOrEqual(25)
    expect(retryDelays[0]).toBeLessThan(50)
    expect(retryDelays[1]).toBeGreaterThanOrEqual(50)
    expect(retryDelays[1]).toBeLessThan(100)
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      plugin: [[NAME, { revision }]],
    })
    expect(
      (await fs.readdir(configD())).filter(
        (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
      ),
    ).toEqual([])
  })

  test("patchGlobalEntryOptions refuses to publish after losing its lock", async () => {
    const file = path.join(configD(), "opencode.json")
    const original = JSON.stringify({ plugin: [[NAME, { notify: false }]] })
    await write(file, original)
    const lockFile = `${file}.lock`
    const realWriteFile = fs.writeFile.bind(fs) as (
      ...args: any[]
    ) => Promise<void>
    let replaced = false
    const writeFile = spyOn(fs, "writeFile").mockImplementation((async (
      ...args: any[]
    ) => {
      await realWriteFile(...args)
      const target = String(args[0])
      if (
        !replaced &&
        target.startsWith(`${file}.`) &&
        target.endsWith(".tmp")
      ) {
        replaced = true
        await realWriteFile(lockFile, "successor lock")
      }
    }) as typeof fs.writeFile)
    try {
      await expect(
        patchGlobalEntryOptions(configD(), undefined, project(), {
          journal: false,
        }),
      ).rejects.toThrow("lock was lost to another process")
    } finally {
      writeFile.mockRestore()
    }

    expect(replaced).toBe(true)
    expect(await fs.readFile(file, "utf8")).toBe(original)
    expect(await fs.readFile(lockFile, "utf8")).toBe("successor lock")
    expect(
      (await fs.readdir(configD())).filter((name) => name.endsWith(".tmp")),
    ).toEqual([])
  })

  test("an interrupted staged write leaves the global config intact", async () => {
    const file = path.join(configD(), "opencode.json")
    const original = JSON.stringify({ plugin: [[NAME, { notify: false }]] })
    await write(file, original)
    const realWriteFile = fs.writeFile.bind(fs) as (
      ...args: any[]
    ) => Promise<void>
    let interrupted = false
    const writeFile = spyOn(fs, "writeFile").mockImplementation((async (
      ...args: any[]
    ) => {
      const target = String(args[0])
      if (target.startsWith(`${file}.`) && target.endsWith(".tmp")) {
        interrupted = true
        const text = String(args[1])
        await realWriteFile(args[0], text.slice(0, text.length / 2), args[2])
        throw new Error("simulated interrupted write")
      }
      await realWriteFile(...args)
    }) as typeof fs.writeFile)
    try {
      await expect(
        patchGlobalEntryOptions(configD(), undefined, project(), {
          enabled: false,
        }),
      ).rejects.toThrow("simulated interrupted write")
    } finally {
      writeFile.mockRestore()
    }
    expect(interrupted).toBe(true)
    expect(await fs.readFile(file, "utf8")).toBe(original)
    expect(
      (await fs.readdir(configD())).filter((name) => name.endsWith(".tmp")),
    ).toEqual([])
  })

  test("patchGlobalEntryOptions upgrades a bare spec to a tuple", async () => {
    const file = path.join(configD(), "opencode.json")
    await write(file, JSON.stringify({ plugin: [NAME] }))
    expect(
      await patchGlobalEntryOptions(configD(), undefined, project(), {
        enabled: false,
      }),
    ).toBe("ok")
    const scan = await scanPluginConfigFile(file, undefined)
    if (scan === "missing" || scan === "unreadable")
      throw new Error(`unexpected ${scan}`)
    expect(scan.ownOptions).toEqual({ enabled: false })
  })

  test("patchGlobalEntryOptions: no entry anywhere → no-entry; corrupt file → corrupt", async () => {
    expect(
      await patchGlobalEntryOptions(configD(), undefined, project(), {
        enabled: true,
      }),
    ).toBe("no-entry")
    await write(path.join(configD(), "opencode.jsonc"), "{broken")
    expect(
      await patchGlobalEntryOptions(configD(), undefined, project(), {
        enabled: true,
      }),
    ).toBe("corrupt")
  })

  test("patchGlobalEntryOptions refuses to edit an entry a later plugin array shadows", async () => {
    await write(
      path.join(configD(), "config.json"),
      JSON.stringify({ plugin: [[NAME, { journal: false }]] }),
    )
    await write(
      path.join(configD(), "opencode.json"),
      JSON.stringify({ plugin: ["some-other-plugin"] }),
    )
    expect(
      await patchGlobalEntryOptions(configD(), undefined, project(), {
        enabled: false,
      }),
    ).toBe("shadowed")
    // The dead entry was not edited, and the winning file was not given one.
    const earlier = await scanPluginConfigFile(
      path.join(configD(), "config.json"),
      undefined,
    )
    if (earlier === "missing" || earlier === "unreadable")
      throw new Error(`unexpected ${earlier}`)
    expect(earlier.ownOptions).toEqual({ journal: false })
    const winner = await scanPluginConfigFile(
      path.join(configD(), "opencode.json"),
      undefined,
    )
    if (winner === "missing" || winner === "unreadable")
      throw new Error(`unexpected ${winner}`)
    expect(winner.hasOwnEntry).toBe(false)
  })

  test("patchGlobalEntryOptions edits the WINNING file when several declare the entry", async () => {
    await write(
      path.join(configD(), "config.json"),
      JSON.stringify({ plugin: [[NAME, { journal: false }]] }),
    )
    await write(
      path.join(configD(), "opencode.jsonc"),
      JSON.stringify({ plugin: [[NAME, { notify: false }]] }),
    )
    expect(
      await patchGlobalEntryOptions(configD(), undefined, project(), {
        timeoutMs: 60_000,
      }),
    ).toBe("ok")
    const winner = await scanPluginConfigFile(
      path.join(configD(), "opencode.jsonc"),
      undefined,
    )
    if (winner === "missing" || winner === "unreadable")
      throw new Error(`unexpected ${winner}`)
    expect(winner.ownOptions).toEqual({ notify: false, timeoutMs: 60_000 })
    const earlier = await scanPluginConfigFile(
      path.join(configD(), "config.json"),
      undefined,
    )
    if (earlier === "missing" || earlier === "unreadable")
      throw new Error(`unexpected ${earlier}`)
    expect(earlier.ownOptions).toEqual({ journal: false })
  })

  test("readPolicySnapshot merges field-wise: global under blessed worktree under project", async () => {
    await write(
      path.join(configD(), "opencode.jsonc"),
      JSON.stringify({
        plugin: [[NAME, { model: "a/b", timeoutMs: 30_000, journal: false }]],
      }),
    )
    const worktree = path.join(project(), ".opencode", "opencode.json")
    await write(
      worktree,
      JSON.stringify({ plugin: [[NAME, { timeoutMs: 45_000 }]] }),
    )
    await writeBlessing(blessFile(stateD(), project()), {
      files: { [worktree]: sha256Hex(await fs.readFile(worktree, "utf8")) },
    })
    await fs.mkdir(path.dirname(projectSettingsFile(configD(), project())), {
      recursive: true,
    })
    await fs.writeFile(
      projectSettingsFile(configD(), project()),
      JSON.stringify({ timeoutMs: null, notify: false }),
    )
    const snapshot = await readPolicySnapshot(snapshotInput())
    expect(snapshot.fault).toBeUndefined()
    // model from the global entry, journal from the global entry, the
    // worktree's timeout pin overridden back to default by the project's
    // explicit null, notify from the project file.
    expect(snapshot.settings).toEqual({
      model: "a/b",
      journal: false,
      timeoutMs: undefined,
      notify: false,
    })
    expect(snapshot.blessedFiles).toEqual([worktree])
    expect(snapshot.globalSource).toBe(path.join(configD(), "opencode.jsonc"))
  })

  test("readPolicySnapshot faults, in precedence order", async () => {
    // The retired bespoke global file wins over everything else.
    await write(
      path.join(configD(), "permissions-approve-for-me.json"),
      JSON.stringify({ enabled: true }),
    )
    expect((await readPolicySnapshot(snapshotInput())).fault).toEqual({
      kind: "legacy-global",
      file: path.join(configD(), "permissions-approve-for-me.json"),
    })
    await fs.rm(path.join(configD(), "permissions-approve-for-me.json"))

    await write(path.join(configD(), "opencode.json"), "{broken")
    expect((await readPolicySnapshot(snapshotInput())).fault).toEqual({
      kind: "global-unreadable",
    })
    await fs.rm(path.join(configD(), "opencode.json"))

    const worktree = path.join(project(), "opencode.jsonc")
    await write(worktree, JSON.stringify({ plugin: [[NAME, {}]] }))
    expect((await readPolicySnapshot(snapshotInput())).fault).toEqual({
      kind: "worktree-unblessed",
      files: [worktree],
    })
    await fs.rm(worktree)

    await fs.mkdir(path.dirname(projectSettingsFile(configD(), project())), {
      recursive: true,
    })
    await fs.writeFile(projectSettingsFile(configD(), project()), "{broken")
    expect((await readPolicySnapshot(snapshotInput())).fault).toEqual({
      kind: "project-unreadable",
    })
  })

  test("a healthy empty pipeline resolves to plain defaults", async () => {
    const snapshot = await readPolicySnapshot(snapshotInput())
    expect(snapshot.fault).toBeUndefined()
    expect(snapshot.settings).toEqual({})
    expect(snapshot.sideloads).toEqual([])
  })
})

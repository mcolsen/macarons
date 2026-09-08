import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { Stats } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  activeEntries,
  assertRenderedDoc,
  assertSourceDocsUnchanged,
  buildPlan,
  type ConfigKind,
  type ConfigSource,
  type ConfigSources,
  type DocEdit,
  discoverConfigSources,
  discoverPlugins,
  entryMatchesPlugin,
  entrySpec,
  installTarget,
  type Plan,
  type PluginInfo,
  pluginState,
  type RenderedEdit,
  readSourceDoc,
  readSourceDocs,
  renderEdits,
  SourceConflictError,
  type SourceDoc,
  serverEntryUrl,
  tuiEntryUrl,
  writeRenderedEdit,
  writeSourceDoc,
} from "../src/core"

const REPO_ROOT = path.resolve(import.meta.dir, "../../..")

const persist: PluginInfo = {
  name: "@macarons/persist-permissions",
  id: "persist-permissions",
  description: "persists approvals",
  dir: "/repo/plugins/persist-permissions",
  serverEntry: "/repo/plugins/persist-permissions/src/index.ts",
  tuiEntry: "/repo/plugins/persist-permissions/src/tui.tsx",
}
const auto: PluginInfo = {
  name: "@macarons/permissions-auto-mode",
  id: "permissions-auto-mode",
  description: "auto-approves",
  dir: "/repo/plugins/permissions-auto-mode",
  serverEntry: "/repo/plugins/permissions-auto-mode/src/index.ts",
  tuiEntry: "/repo/plugins/permissions-auto-mode/src/tui.tsx",
}
const websearch: PluginInfo = {
  name: "@macarons/web-search",
  id: "web-search",
  description: "web search",
  dir: "/repo/plugins/web-search",
  serverEntry: "/repo/plugins/web-search/src/index.ts",
  tuiEntry: "/repo/plugins/web-search/src/tui.tsx",
}
const approval: PluginInfo = {
  name: "@macarons/approve-for-me",
  id: "approve-for-me",
  description: "auto-approves",
  dir: "/repo/plugins/approve-for-me",
  serverEntry: "/repo/plugins/approve-for-me/src/index.ts",
  tuiEntry: "/repo/plugins/approve-for-me/src/tui.tsx",
}
const serverOnly: PluginInfo = {
  name: "@macarons/server-only",
  id: "server-only",
  description: "no tui",
  dir: "/repo/plugins/server-only",
  serverEntry: "/repo/plugins/server-only/src/index.ts",
}
const tuiOnly: PluginInfo = {
  name: "@macarons/tui-only",
  id: "tui-only",
  description: "no server",
  dir: "/repo/plugins/tui-only",
  tuiEntry: "/repo/plugins/tui-only/src/tui.tsx",
}
const codexLimits: PluginInfo = {
  name: "@macarons/codex-limits",
  id: "codex-limits",
  description: "Codex usage limits",
  dir: "/repo/plugins/codex-limits",
  serverEntry: "/repo/plugins/codex-limits/src/index.ts",
  tuiEntry: "/repo/plugins/codex-limits/src/tui.tsx",
}
const syntheticLimits: PluginInfo = {
  name: "@macarons/synthetic-limits",
  id: "synthetic-limits",
  description: "Synthetic usage limits",
  dir: "/repo/plugins/synthetic-limits",
  tuiEntry: "/repo/plugins/synthetic-limits/src/tui.tsx",
}

const HOME = "/home/x"
const DEFAULT_DIR = path.join(HOME, ".config", "opencode")
const CUSTOM_DIR = "/custom/oc"
const HOME_OC = path.join(HOME, ".opencode")

function defaultSources(): ConfigSources {
  return discoverConfigSources({ env: {}, homedir: HOME })
}
function customSources(): ConfigSources {
  return discoverConfigSources({
    env: { OPENCODE_CONFIG_DIR: CUSTOM_DIR },
    homedir: HOME,
  })
}

/** Short display key for a source: basename, `home:`-prefixed for ~/.opencode files. */
function sourceKey(source: ConfigSource): string {
  return `${source.scope === "home-opencode" ? "home:" : ""}${path.basename(source.file)}`
}

type DocState = unknown[] | "exists-no-plugin-key"

/** Build an inventory for `cfg`, keyed by sourceKey; unkeyed files do not exist. */
function docsFrom(
  cfg: ConfigSources,
  state: Record<string, DocState> = {},
): SourceDoc[] {
  return cfg.sources.map((source) => {
    const entry = state[sourceKey(source)]
    if (entry === undefined)
      return { source, text: "", exists: false, hasPluginKey: false, list: [] }
    if (entry === "exists-no-plugin-key") {
      return {
        source,
        text: '{"model":"x"}',
        exists: true,
        hasPluginKey: false,
        list: [],
      }
    }
    return {
      source,
      text: JSON.stringify({ plugin: entry }),
      exists: true,
      hasPluginKey: true,
      list: entry,
    }
  })
}

function docFor(docs: SourceDoc[], key: string): SourceDoc {
  const doc = docs.find((candidate) => sourceKey(candidate.source) === key)
  if (!doc) throw new Error(`no doc for ${key}`)
  return doc
}

function editFor(plan: Plan, key: string): DocEdit {
  const edit = plan.edits.find(
    (candidate) => sourceKey(candidate.doc.source) === key,
  )
  if (!edit) throw new Error(`no edit for ${key}`)
  return edit
}

function selection(...names: string[]): Map<string, boolean> {
  return new Map(names.map((name) => [name, true]))
}

describe("config-source rules verification pin", () => {
  // The source-rule block in core.ts (and discoverConfigSources /
  // activeEntries encoding it) transcribes OpenCode 1.18.x behavior:
  // loadGlobal's replace-wins collapse, per-scope plugin-origin concat,
  // OPENCODE_CONFIG_DIR replacing the default dir, and tui.json+tui.jsonc
  // both loading. The nightly bump job advances `.opencode-version`; when the
  // pin crosses into a new minor line this test goes red on the bump PR,
  // forcing the rules — comment and code together — to be re-verified
  // against the new host source. Patch releases ride through, matching how
  // the verified band ratchets.
  const RULES_VERIFIED_LINE = "1.18"
  test(`rules were verified against the ${RULES_VERIFIED_LINE}.x host line`, async () => {
    const pinned = (
      await fs.readFile(path.join(REPO_ROOT, ".opencode-version"), "utf8")
    ).trim()
    expect(pinned.split(".").slice(0, 2).join(".")).toBe(RULES_VERIFIED_LINE)
  })
})

// The config-dir derivation itself is the library's
// (test/promoted-helpers.test.ts); what stays here is how the wizard USES it —
// the --config-dir override and the `custom` flag, both covered below.
describe("discoverConfigSources", () => {
  test("default mode: global trio (collapse-only), TUI pair, and the home .opencode origins", () => {
    const cfg = defaultSources()
    expect(cfg.configDir).toBe(DEFAULT_DIR)
    expect(cfg.custom).toBe(false)
    expect(cfg.homeOpencodeDir).toBe(HOME_OC)
    expect(
      cfg.sources.map((s) => [sourceKey(s), s.kind, s.origin, s.collapseRank]),
    ).toEqual([
      ["config.json", "server", false, 0],
      ["opencode.json", "server", false, 1],
      ["opencode.jsonc", "server", false, 2],
      ["tui.json", "tui", true, undefined],
      ["tui.jsonc", "tui", true, undefined],
      ["home:opencode.json", "server", true, undefined],
      ["home:opencode.jsonc", "server", true, undefined],
      ["home:tui.json", "tui", true, undefined],
      ["home:tui.jsonc", "tui", true, undefined],
    ])
    for (const source of cfg.sources.filter((s) => s.scope === "config-dir")) {
      expect(source.file.startsWith(DEFAULT_DIR + path.sep)).toBe(true)
    }
  })

  test("OPENCODE_CONFIG_DIR replaces the default dir entirely", () => {
    const cfg = customSources()
    expect(cfg.configDir).toBe(CUSTOM_DIR)
    expect(cfg.custom).toBe(true)
    // The default global dir is inactive in this mode: nothing may touch it.
    for (const source of cfg.sources) {
      expect(source.file.startsWith(DEFAULT_DIR)).toBe(false)
    }
  })

  test("custom dir: opencode.json/.jsonc are independent origins on top of the collapse", () => {
    const cfg = customSources()
    const json = docFor(docsFrom(cfg), "opencode.json").source
    const jsonc = docFor(docsFrom(cfg), "opencode.jsonc").source
    const configJson = docFor(docsFrom(cfg), "config.json").source
    expect(json.origin).toBe(true)
    expect(json.collapseRank).toBe(1)
    expect(jsonc.origin).toBe(true)
    expect(jsonc.collapseRank).toBe(2)
    // config.json is read only via the collapse — active whenever the later
    // files omit the `plugin` key, never as an unconditional origin.
    expect(configJson.origin).toBe(false)
    expect(configJson.collapseRank).toBe(0)
    // Home ~/.opencode stays active alongside a custom dir.
    expect(cfg.sources.some((s) => s.scope === "home-opencode")).toBe(true)
  })

  test("--config-dir behaves exactly like OPENCODE_CONFIG_DIR", () => {
    const byEnv = customSources()
    const byFlag = discoverConfigSources({
      env: {},
      homedir: HOME,
      configDirOverride: CUSTOM_DIR,
    })
    expect(byFlag.configDir).toBe(CUSTOM_DIR)
    expect(byFlag.custom).toBe(true)
    expect(byFlag.sources).toEqual(byEnv.sources)
  })

  test("OPENCODE_CONFIG_DIR pointing at ~/.opencode does not duplicate sources", () => {
    const cfg = discoverConfigSources({
      env: { OPENCODE_CONFIG_DIR: HOME_OC },
      homedir: HOME,
    })
    expect(cfg.homeOpencodeDir).toBeUndefined()
    const files = cfg.sources.map((s) => s.file)
    expect(new Set(files).size).toBe(files.length)
    expect(cfg.sources).toHaveLength(5)
    // The host's dir.endsWith(".opencode") predicate makes the pair origins.
    expect(docFor(docsFrom(cfg), "opencode.json").source.origin).toBe(true)
  })
})

describe("discoverPlugins", () => {
  test("finds the real plugins, each with at least one resolvable half", async () => {
    const found = await discoverPlugins(REPO_ROOT)
    const ids = found.map((p) => p.id)
    expect(ids).toContain("persist-permissions")
    expect(ids).toContain("approve-for-me")
    expect(ids).toContain("web-search")
    expect(ids).not.toContain("permissions-approve-for-me")
    expect(ids).not.toContain("websearch")
    for (const plugin of found) {
      expect(plugin.name.startsWith("@macarons/")).toBe(true)
      // Every discovered plugin exposes at least one installable half.
      expect(Boolean(plugin.serverEntry) || Boolean(plugin.tuiEntry)).toBe(true)
      if (plugin.serverEntry) {
        expect(path.isAbsolute(plugin.serverEntry)).toBe(true)
        expect(plugin.serverEntry.endsWith("src/index.ts")).toBe(true)
      }
      if (plugin.tuiEntry) {
        expect(path.isAbsolute(plugin.tuiEntry)).toBe(true)
        expect(plugin.tuiEntry.endsWith("src/tui.tsx")).toBe(true)
      }
    }
  })
  test("discovers the Codex companion and keeps Synthetic TUI-only", async () => {
    const found = await discoverPlugins(REPO_ROOT)
    for (const id of ["codex-limits", "synthetic-limits"]) {
      const plugin = found.find((candidate) => candidate.id === id)
      expect(plugin).toBeDefined()
      if (id === "codex-limits") {
        expect(plugin?.serverEntry).toBe(
          path.join(REPO_ROOT, "plugins", id, "src", "index.ts"),
        )
      } else {
        expect(plugin?.serverEntry).toBeUndefined()
      }
      expect(plugin?.tuiEntry?.endsWith("src/tui.tsx")).toBe(true)
    }
  })
  test("returns empty for a repo with no plugins directory", async () => {
    expect(await discoverPlugins("/definitely/not/a/repo")).toEqual([])
  })

  const dirs: string[] = []
  afterEach(async () => {
    while (dirs.length)
      await fs.rm(dirs.pop() as string, { recursive: true, force: true })
  })
  async function syntheticRepo(
    pkg: Record<string, unknown>,
    files: string[],
  ): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "installer-discover-"))
    dirs.push(root)
    const dir = path.join(root, "plugins", "synthetic")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "@macarons/synthetic", ...pkg }),
    )
    for (const file of files) {
      const target = path.join(dir, file)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, "// entry\n")
    }
    return root
  }

  // A declared entry whose file is missing marks the whole package broken.
  // Accepting the surviving half would turn a broken dual-half package into
  // a silent partial install.
  test("rejects a package whose declared server entry file is missing", async () => {
    const root = await syntheticRepo(
      { exports: { "./server": "./src/index.ts", "./tui": "./src/tui.tsx" } },
      ["src/tui.tsx"],
    )
    expect(await discoverPlugins(root)).toEqual([])
  })
  test("rejects a package whose declared tui entry file is missing", async () => {
    const root = await syntheticRepo(
      { exports: { "./server": "./src/index.ts", "./tui": "./src/tui.tsx" } },
      ["src/index.ts"],
    )
    expect(await discoverPlugins(root)).toEqual([])
  })
  test("rejects a package whose main file is missing even with a valid tui export", async () => {
    const root = await syntheticRepo(
      { main: "./dist/index.js", exports: { "./tui": "./src/tui.tsx" } },
      ["src/tui.tsx"],
    )
    expect(await discoverPlugins(root)).toEqual([])
  })
  test("still accepts a genuinely single-half package", async () => {
    const root = await syntheticRepo(
      { exports: { "./tui": "./src/tui.tsx" } },
      ["src/tui.tsx"],
    )
    const found = await discoverPlugins(root)
    expect(found).toHaveLength(1)
    expect(found[0]?.serverEntry).toBeUndefined()
    expect(found[0]?.tuiEntry?.endsWith(path.join("src", "tui.tsx"))).toBe(true)
  })
})

describe("entrySpec", () => {
  test("reads a string entry", () => {
    expect(entrySpec("file:///x")).toBe("file:///x")
  })
  test("reads a [spec, options] tuple", () => {
    expect(entrySpec(["file:///x", { keybind: "ctrl+o" }])).toBe("file:///x")
  })
  test("ignores malformed entries", () => {
    expect(entrySpec(42)).toBeUndefined()
    expect(entrySpec([{ not: "a spec" }])).toBeUndefined()
  })
})

describe("entryMatchesPlugin", () => {
  test("matches the canonical src entry url", () => {
    expect(
      entryMatchesPlugin(
        pathToFileURL(persist.serverEntry as string).href,
        persist,
      ),
    ).toBe(true)
    expect(
      entryMatchesPlugin(
        pathToFileURL(persist.tuiEntry as string).href,
        persist,
      ),
    ).toBe(true)
  })
  test("matches a package-directory install", () => {
    expect(entryMatchesPlugin(pathToFileURL(persist.dir).href, persist)).toBe(
      true,
    )
  })
  test("matches the scoped package name and its subpaths", () => {
    expect(entryMatchesPlugin(persist.name, persist)).toBe(true)
    expect(entryMatchesPlugin(`${persist.name}/tui`, persist)).toBe(true)
    expect(entryMatchesPlugin(`${persist.name}@0.1.0`, persist)).toBe(true)
    expect(entryMatchesPlugin(`${persist.name}@`, persist)).toBe(true)
    expect(entryMatchesPlugin(`npm:${persist.name}@0.1.0`, persist)).toBe(true)
    expect(entryMatchesPlugin(`npm:${persist.name}@`, persist)).toBe(true)
    expect(
      entryMatchesPlugin(`persist@npm:${persist.name}@next`, persist),
    ).toBe(true)
  })
  test("matches package names from before the Macarons rename", () => {
    expect(
      entryMatchesPlugin("@mcolsen-opencode/persist-permissions", persist),
    ).toBe(true)
    expect(
      entryMatchesPlugin("@mcolsen-opencode/persist-permissions/tui", persist),
    ).toBe(true)
    expect(
      entryMatchesPlugin(
        "npm:@mcolsen-opencode/persist-permissions@0.1.0",
        persist,
      ),
    ).toBe(true)
    expect(
      entryMatchesPlugin(
        "persist@npm:@mcolsen-opencode/persist-permissions@next",
        persist,
      ),
    ).toBe(true)
    expect(
      entryMatchesPlugin("@mcolsen-opencode/persist-permissions@", persist),
    ).toBe(true)
    expect(
      entryMatchesPlugin(
        "@mcolsen-opencode/persist-permissions-extra",
        persist,
      ),
    ).toBe(false)
  })
  test("matches inside a [spec, options] tuple", () => {
    expect(
      entryMatchesPlugin(
        [pathToFileURL(persist.tuiEntry as string).href, { hint: true }],
        persist,
      ),
    ).toBe(true)
  })
  test("does not match a different plugin or unrelated specs", () => {
    expect(
      entryMatchesPlugin(
        pathToFileURL(auto.serverEntry as string).href,
        persist,
      ),
    ).toBe(false)
    expect(entryMatchesPlugin("some-other-plugin", persist)).toBe(false)
    expect(entryMatchesPlugin("./relative/thing.ts", persist)).toBe(false)
    expect(
      entryMatchesPlugin(
        "file:///tmp/unrelated@npm:@macarons/persist-permissions@1.ts",
        persist,
      ),
    ).toBe(false)
    for (const protocolSpec of [
      "file:unrelated@npm:@macarons/persist-permissions",
      "git:unrelated@npm:@macarons/persist-permissions",
      "github:owner/unrelated@npm:@macarons/persist-permissions",
    ]) {
      expect(entryMatchesPlugin(protocolSpec, persist)).toBe(false)
    }
    expect(
      entryMatchesPlugin(
        "/tmp/unrelated@npm:@mcolsen-opencode/persist-permissions@1.ts",
        persist,
      ),
    ).toBe(false)
    // A directory whose path is a prefix string but not a path-boundary child.
    expect(
      entryMatchesPlugin(
        pathToFileURL("/repo/plugins/persist-permissions-extra").href,
        persist,
      ),
    ).toBe(false)
  })
  test("matches a relative-path spec resolved against the declaring file, as the host does", () => {
    // The host resolves `.`-prefixed specs relative to the declaring config
    // file (resolvePluginSpec); with the source file passed, the wizard must too.
    expect(
      entryMatchesPlugin(
        "./plugins/persist-permissions/src/index.ts",
        persist,
        "/repo/opencode.json",
      ),
    ).toBe(true)
    expect(
      entryMatchesPlugin(
        ["../repo/plugins/persist-permissions", { hint: true }],
        persist,
        "/elsewhere/tui.json",
      ),
    ).toBe(true)
    expect(
      entryMatchesPlugin(
        "./plugins/other-thing/src/index.ts",
        persist,
        "/repo/opencode.json",
      ),
    ).toBe(false)
    // Declared elsewhere, the same relative spec points at a different dir.
    expect(
      entryMatchesPlugin(
        "./plugins/persist-permissions/src/index.ts",
        persist,
        "/other/opencode.json",
      ),
    ).toBe(false)
  })
  test("a bare spec is a package name, never a relative path — mirroring isPathPluginSpec", () => {
    // `plugins/persist-permissions` WOULD hit the plugin dir if path-resolved
    // against /repo, but the host only path-resolves `.`-prefixed specs.
    expect(
      entryMatchesPlugin(
        "plugins/persist-permissions",
        persist,
        "/repo/opencode.json",
      ),
    ).toBe(false)
  })
  test("maps legacy usage-limits package and source entries only to codex-limits", () => {
    const legacySource = "/repo/plugins/usage-limits/src/tui.tsx"
    const entries = [
      "@mcolsen-opencode/usage-limits",
      "@mcolsen-opencode/usage-limits/tui",
      pathToFileURL(legacySource).href,
      legacySource,
    ]
    for (const entry of entries) {
      expect(entryMatchesPlugin(entry, codexLimits)).toBe(true)
      expect(entryMatchesPlugin(entry, syntheticLimits)).toBe(false)
    }
    expect(
      entryMatchesPlugin(
        "./plugins/usage-limits/src/tui.tsx",
        codexLimits,
        "/repo/tui.json",
      ),
    ).toBe(true)
  })
})

describe.each([
  [approval, "permissions-approve-for-me"],
  [websearch, "websearch"],
] as const)("renamed plugin %s (formerly %s)", (plugin, previousId) => {
  test("recognizes old packages and checkout paths, but not lookalikes", () => {
    for (const spec of [
      `@macarons/${previousId}`,
      `@macarons/${previousId}/tui`,
      `npm:@macarons/${previousId}@0.1.0`,
      `alias@npm:@macarons/${previousId}@0.1.0/server`,
      `@mcolsen-opencode/${previousId}@0.1.0`,
      `file:///repo/plugins/${previousId}/src/index.ts`,
      `/repo/plugins/${previousId}`,
      `./plugins/${previousId}/src/tui.tsx`,
    ]) {
      expect(
        entryMatchesPlugin(
          [spec, { enabled: false }],
          plugin,
          "/repo/tui.json",
        ),
      ).toBe(true)
    }
    for (const spec of [
      `@macarons/${previousId}-other`,
      `file:///repo/plugins/${previousId}-other/src/index.ts`,
      `file:///elsewhere/plugins/${previousId}/src/index.ts`,
      "opencode-websearch",
    ]) {
      expect(entryMatchesPlugin(spec, plugin)).toBe(false)
    }
  })

  test("migrates both halves and masked entries without losing options or duplicating installs", () => {
    const serverOptions = {
      enabled: false,
      native: { enabled: false },
      exa: { enabled: false },
    }
    const tuiOptions = { sidebar: false }
    const docs = docsFrom(defaultSources(), {
      "config.json": [[`@mcolsen-opencode/${previousId}`, serverOptions]],
      "opencode.jsonc": [
        "file:///other",
        [`file:///repo/plugins/${previousId}/src/index.ts`, serverOptions],
        [plugin.name, serverOptions],
      ],
      "tui.json": [[`@macarons/${previousId}/tui`, tuiOptions]],
      "home:tui.jsonc": [
        [`../../../repo/plugins/${previousId}/src/tui.tsx`, tuiOptions],
      ],
    })
    const original = structuredClone(docs)
    expect(pluginState(docs, plugin).present).toBe(true)
    const plan = buildPlan([plugin], selection(plugin.name), docs)
    expect(editFor(plan, "config.json").list).toEqual([
      [serverEntryUrl(plugin), serverOptions],
    ])
    expect(editFor(plan, "opencode.jsonc").list).toEqual([
      "file:///other",
      [serverEntryUrl(plugin), serverOptions],
    ])
    for (const key of ["tui.json", "home:tui.jsonc"]) {
      expect(editFor(plan, key).list).toEqual([
        [tuiEntryUrl(plugin), tuiOptions],
      ])
    }
    expect(docs).toEqual(original)
    const migrated = plan.edits.map(({ doc, list, changed }) => ({
      ...doc,
      list,
      exists: doc.exists || changed,
      hasPluginKey: doc.hasPluginKey || changed,
    }))
    expect(buildPlan([plugin], selection(plugin.name), migrated).changed).toBe(
      false,
    )

    const uninstall = buildPlan([plugin], new Map(), docs)
    expect(editFor(uninstall, "opencode.jsonc").list).toEqual(["file:///other"])
    for (const key of ["config.json", "tui.json", "home:tui.jsonc"]) {
      expect(editFor(uninstall, key).list).toEqual([])
    }
  })
})

describe("activeEntries", () => {
  test("collapse: the highest file defining `plugin` wins; lower entries are masked", () => {
    const docs = docsFrom(defaultSources(), {
      "config.json": ["file:///low"],
      "opencode.json": ["file:///mid"],
    })
    expect(activeEntries(docs, "server")).toEqual(["file:///mid"])
  })
  test("collapse: a higher file that omits the key inherits the lower array", () => {
    const docs = docsFrom(defaultSources(), {
      "config.json": ["file:///low"],
      "opencode.json": "exists-no-plugin-key",
    })
    expect(activeEntries(docs, "server")).toEqual(["file:///low"])
  })
  test("collapse: an empty `plugin` array still masks lower files", () => {
    const docs = docsFrom(defaultSources(), {
      "config.json": ["file:///low"],
      "opencode.jsonc": [],
    })
    expect(activeEntries(docs, "server")).toEqual([])
  })
  test("custom dir: json entries stay active even when jsonc defines the key", () => {
    const docs = docsFrom(customSources(), {
      "opencode.json": ["file:///json"],
      "opencode.jsonc": ["file:///jsonc"],
    })
    expect(new Set(activeEntries(docs, "server"))).toEqual(
      new Set(["file:///json", "file:///jsonc"]),
    )
  })
  test("home .opencode files are always-active origins", () => {
    const docs = docsFrom(defaultSources(), {
      "opencode.jsonc": ["file:///global"],
      "home:opencode.json": ["file:///home"],
    })
    expect(new Set(activeEntries(docs, "server"))).toEqual(
      new Set(["file:///global", "file:///home"]),
    )
  })
  test("tui: every tui.json/tui.jsonc concats", () => {
    const docs = docsFrom(defaultSources(), {
      "tui.json": ["file:///a"],
      "tui.jsonc": ["file:///b"],
      "home:tui.jsonc": ["file:///c"],
    })
    expect(new Set(activeEntries(docs, "tui"))).toEqual(
      new Set(["file:///a", "file:///b", "file:///c"]),
    )
  })
})

describe("pluginState", () => {
  test("active per half mirrors the host; present also counts masked entries", () => {
    const docs = docsFrom(defaultSources(), {
      "config.json": [serverEntryUrl(persist)],
      "opencode.json": ["file:///other"],
      "tui.json": [tuiEntryUrl(persist)],
    })
    const state = pluginState(docs, persist)
    expect(state.server).toBe(false) // masked by opencode.json's plugin key
    expect(state.tui).toBe(true)
    expect(state.active).toBe(true)
    expect(state.present).toBe(true)
  })
  test("a fully masked plugin is present but not active, and files says where it lives", () => {
    const docs = docsFrom(defaultSources(), {
      "config.json": [serverEntryUrl(persist)],
      "opencode.jsonc": [],
    })
    expect(pluginState(docs, persist)).toEqual({
      server: false,
      tui: false,
      active: false,
      present: true,
      files: [path.join(DEFAULT_DIR, "config.json")],
    })
  })
  test("absent everywhere", () => {
    const docs = docsFrom(defaultSources())
    expect(pluginState(docs, persist)).toEqual({
      server: false,
      tui: false,
      active: false,
      present: false,
      files: [],
    })
  })
  test("files lists every referencing config file across scopes", () => {
    const docs = docsFrom(defaultSources(), {
      "config.json": [serverEntryUrl(persist)],
      "home:opencode.json": [persist.name],
      "tui.jsonc": [tuiEntryUrl(persist)],
    })
    expect(pluginState(docs, persist).files).toEqual([
      path.join(DEFAULT_DIR, "config.json"),
      path.join(DEFAULT_DIR, "tui.jsonc"),
      path.join(HOME_OC, "opencode.json"),
    ])
  })
})

describe("installTarget", () => {
  test("server: prefers the highest existing file that defines `plugin` — the effective file", () => {
    const docs = docsFrom(defaultSources(), {
      "opencode.json": ["file:///x"],
      "opencode.jsonc": "exists-no-plugin-key",
    })
    expect(sourceKey(installTarget(docs, "server").source)).toBe(
      "opencode.json",
    )
  })
  test("server: when several files define the key, the collapse winner is targeted", () => {
    const docs = docsFrom(defaultSources(), {
      "config.json": ["file:///low"],
      "opencode.jsonc": ["file:///high"],
    })
    expect(sourceKey(installTarget(docs, "server").source)).toBe(
      "opencode.jsonc",
    )
  })
  test("server: no file defines the key → first existing of jsonc/json/config.json", () => {
    const docs = docsFrom(defaultSources(), {
      "opencode.json": "exists-no-plugin-key",
      "config.json": "exists-no-plugin-key",
    })
    expect(sourceKey(installTarget(docs, "server").source)).toBe(
      "opencode.json",
    )
  })
  test("server: a lone legacy config.json is respected", () => {
    const docs = docsFrom(defaultSources(), { "config.json": ["file:///x"] })
    expect(sourceKey(installTarget(docs, "server").source)).toBe("config.json")
  })
  test("server: nothing exists → a fresh opencode.jsonc", () => {
    const docs = docsFrom(defaultSources())
    const target = installTarget(docs, "server")
    expect(sourceKey(target.source)).toBe("opencode.jsonc")
    expect(target.exists).toBe(false)
  })
  test("tui: existing tui.json, else existing tui.jsonc, else a fresh tui.json", () => {
    expect(
      sourceKey(
        installTarget(
          docsFrom(defaultSources(), { "tui.json": [], "tui.jsonc": [] }),
          "tui",
        ).source,
      ),
    ).toBe("tui.json")
    expect(
      sourceKey(
        installTarget(docsFrom(defaultSources(), { "tui.jsonc": [] }), "tui")
          .source,
      ),
    ).toBe("tui.jsonc")
    expect(
      sourceKey(installTarget(docsFrom(defaultSources()), "tui").source),
    ).toBe("tui.json")
  })
  test("never targets a home .opencode file", () => {
    const docs = docsFrom(defaultSources(), {
      "home:opencode.json": ["file:///x"],
    })
    expect(installTarget(docs, "server").source.scope).toBe("config-dir")
  })
})

describe("buildPlan", () => {
  test.each([false, true])(
    "Approve for Me follows prompt injectors, including an existing install: %s",
    (installed) => {
      const approvalEntry = [serverEntryUrl(approval), { enabled: false }]
      const docs = docsFrom(
        defaultSources(),
        installed
          ? {
              "opencode.jsonc": [approvalEntry, "file:///prompt-injector"],
            }
          : {},
      )
      const plan = buildPlan(
        [approval, serverOnly],
        selection(approval.name, serverOnly.name),
        docs,
      )
      expect(editFor(plan, "opencode.jsonc").list).toEqual([
        ...(installed ? ["file:///prompt-injector"] : []),
        serverEntryUrl(serverOnly),
        installed ? approvalEntry : serverEntryUrl(approval),
      ])
      expect(editFor(plan, "tui.json").list).toEqual([tuiEntryUrl(approval)])
    },
  )

  test("installing a plugin adds both halves to a fresh default config dir", () => {
    const plan = buildPlan(
      [persist, auto],
      selection(persist.name),
      docsFrom(defaultSources()),
    )
    expect(plan.changed).toBe(true)
    expect(editFor(plan, "opencode.jsonc")).toMatchObject({
      changed: true,
      list: [serverEntryUrl(persist)],
    })
    expect(editFor(plan, "tui.json")).toMatchObject({
      changed: true,
      list: [tuiEntryUrl(persist)],
    })
    expect(plan.perPlugin.find((p) => p.plugin === persist)).toMatchObject({
      server: "added",
      tui: "added",
    })
    // auto was neither selected nor present: nothing to do.
    expect(plan.perPlugin.find((p) => p.plugin === auto)).toMatchObject({
      server: "none",
      tui: "none",
    })
  })

  test("an already-active plugin left ticked is a no-op", () => {
    const docs = docsFrom(defaultSources(), {
      "opencode.jsonc": [serverEntryUrl(persist)],
      "tui.json": [tuiEntryUrl(persist)],
    })
    const plan = buildPlan([persist], selection(persist.name), docs)
    expect(plan.changed).toBe(false)
    expect(plan.perPlugin[0]).toMatchObject({ server: "none", tui: "none" })
  })

  test("a plugin active only via home .opencode left ticked is a no-op", () => {
    const docs = docsFrom(defaultSources(), {
      "home:opencode.json": [persist.name],
      "home:tui.jsonc": [`${persist.name}/tui`],
    })
    const plan = buildPlan([persist], selection(persist.name), docs)
    expect(plan.changed).toBe(false)
  })

  test("ticking migrates pre-Macarons package entries in place", () => {
    const options = { scope: "worktree" }
    const docs = docsFrom(defaultSources(), {
      "opencode.jsonc": [["@mcolsen-opencode/persist-permissions", options]],
      "tui.json": ["@mcolsen-opencode/persist-permissions/tui"],
    })
    const plan = buildPlan([persist], selection(persist.name), docs)

    expect(plan.perPlugin[0]).toMatchObject({
      server: "added",
      tui: "added",
    })
    expect(editFor(plan, "opencode.jsonc").list).toEqual([
      [serverEntryUrl(persist), options],
    ])
    expect(editFor(plan, "tui.json").list).toEqual([tuiEntryUrl(persist)])
  })

  test("an active canonical entry does not discard options on a masked legacy tuple", () => {
    const options = { searxng: { url: "http://sx:8080" } }
    const canonical = serverEntryUrl(serverOnly) as string
    const docs = docsFrom(defaultSources(), {
      "config.json": [["@mcolsen-opencode/server-only", options]],
      "opencode.jsonc": [canonical],
    })
    const plan = buildPlan([serverOnly], selection(serverOnly.name), docs)

    expect(editFor(plan, "config.json").list).toEqual([[canonical, options]])
    expect(editFor(plan, "opencode.jsonc")).toMatchObject({
      changed: false,
      list: [canonical],
    })
  })

  test("an active bare current entry does not discard active legacy options", () => {
    const options = { searxng: { url: "http://sx:8080" } }
    const canonical = serverEntryUrl(serverOnly) as string
    const docs = docsFrom(defaultSources(), {
      "opencode.jsonc": [["@mcolsen-opencode/server-only", options]],
      "home:opencode.json": [serverOnly.name],
    })
    const plan = buildPlan([serverOnly], selection(serverOnly.name), docs)

    expect(editFor(plan, "opencode.jsonc").list).toEqual([[canonical, options]])
    expect(editFor(plan, "home:opencode.json").list).toEqual([canonical])
  })

  test("migration collapses structurally identical entries within one document", () => {
    const firstOptions = { enabled: false }
    const laterOptions = { enabled: false }
    const canonical = serverEntryUrl(serverOnly) as string
    const docs = docsFrom(defaultSources(), {
      "opencode.jsonc": [
        "@mcolsen-opencode/server-only@0.1.0",
        ["npm:@mcolsen-opencode/server-only@0.1.0", firstOptions],
        "file:///other",
        "npm:@mcolsen-opencode/server-only@0.2.0",
        ["@mcolsen-opencode/server-only@0.2.0", laterOptions],
      ],
    })
    const plan = buildPlan([serverOnly], selection(serverOnly.name), docs)

    const list = editFor(plan, "opencode.jsonc").list
    expect(list).toEqual([
      "file:///other",
      canonical,
      [canonical, laterOptions],
    ])
    expect((list[2] as unknown[])[1]).toBe(laterOptions)
  })

  test("migration preserves identical declarations in independent documents as fallbacks", () => {
    const canonical = serverEntryUrl(serverOnly) as string
    const docs = docsFrom(defaultSources(), {
      "opencode.jsonc": ["@mcolsen-opencode/server-only@0.1.0"],
      "home:opencode.json": ["npm:@mcolsen-opencode/server-only@0.2.0"],
    })
    const plan = buildPlan([serverOnly], selection(serverOnly.name), docs)

    expect(editFor(plan, "opencode.jsonc").list).toEqual([canonical])
    expect(editFor(plan, "home:opencode.json").list).toEqual([canonical])
  })

  test("migration preserves conflicting tuples in both identity orders", () => {
    const currentFirst = { source: "current", conflict: "current-first" }
    const legacySecond = { source: "legacy", conflict: "legacy-second" }
    const legacyFirst = { source: "legacy", conflict: "legacy-first" }
    const currentSecond = { source: "current", conflict: "current-second" }
    const canonical = serverEntryUrl(serverOnly) as string
    const docs = docsFrom(defaultSources(), {
      "opencode.jsonc": [
        [serverOnly.name, currentFirst],
        ["@mcolsen-opencode/server-only", legacySecond],
      ],
      "home:opencode.json": [
        ["npm:@mcolsen-opencode/server-only@0.1.0", legacyFirst],
        [`${serverOnly.name}@0.2.0`, currentSecond],
      ],
    })
    const plan = buildPlan([serverOnly], selection(serverOnly.name), docs)

    expect(editFor(plan, "opencode.jsonc").list).toEqual([
      [canonical, currentFirst],
      [canonical, legacySecond],
    ])
    expect(editFor(plan, "home:opencode.json").list).toEqual([
      [canonical, legacyFirst],
      [canonical, currentSecond],
    ])
  })

  test("migration canonicalizes a masked current entry without dropping active legacy options", () => {
    const options = { enabled: false }
    const canonical = serverEntryUrl(serverOnly) as string
    const docs = docsFrom(defaultSources(), {
      "config.json": [serverOnly.name],
      "opencode.jsonc": [["@mcolsen-opencode/server-only", options]],
    })
    const plan = buildPlan([serverOnly], selection(serverOnly.name), docs)

    expect(editFor(plan, "config.json").list).toEqual([canonical])
    expect(editFor(plan, "opencode.jsonc").list).toEqual([[canonical, options]])
  })

  test("ticking codex-limits migrates legacy TUI options and adds the optionless server companion", () => {
    const options = {
      interval: 30,
      providers: { openai: { endpoint: "http://127.0.0.1:9000/wham/usage" } },
    }
    const docs = docsFrom(defaultSources(), {
      "tui.json": ["@mcolsen-opencode/usage-limits/tui"],
      "home:tui.jsonc": [
        [pathToFileURL("/repo/plugins/usage-limits/src/tui.tsx").href, options],
      ],
    })
    const plan = buildPlan([codexLimits], selection(codexLimits.name), docs)
    const canonical = tuiEntryUrl(codexLimits)

    expect(plan.perPlugin[0]).toMatchObject({
      server: "added",
      tui: "added",
    })
    expect(editFor(plan, "tui.json").list).toEqual([canonical])
    expect(editFor(plan, "home:tui.jsonc").list).toEqual([[canonical, options]])
    expect(editFor(plan, "opencode.jsonc").list).toEqual([
      serverEntryUrl(codexLimits),
    ])
  })

  test("an existing Codex TUI-only install gains its companion without changing TUI options", () => {
    const options = {
      interval: 120,
      providers: { openai: { endpoint: "http://127.0.0.1:9000/wham/usage" } },
    }
    const docs = docsFrom(defaultSources(), {
      "tui.json": [[tuiEntryUrl(codexLimits), options]],
    })
    const plan = buildPlan([codexLimits], selection(codexLimits.name), docs)

    expect(plan.perPlugin[0]).toMatchObject({ server: "added", tui: "none" })
    expect(editFor(plan, "opencode.jsonc").list).toEqual([
      serverEntryUrl(codexLimits),
    ])
    expect(editFor(plan, "tui.json")).toMatchObject({
      changed: false,
      list: [[tuiEntryUrl(codexLimits), options]],
    })
    const installed = docsFrom(defaultSources(), {
      "opencode.jsonc": editFor(plan, "opencode.jsonc").list,
      "tui.json": editFor(plan, "tui.json").list,
    })
    expect(pluginState(installed, codexLimits)).toMatchObject({
      server: true,
      tui: true,
    })
    expect(
      buildPlan([codexLimits], selection(codexLimits.name), installed).changed,
    ).toBe(false)
  })

  test("unticking sweeps every referencing entry from every inventoried file", () => {
    const docs = docsFrom(defaultSources(), {
      "config.json": [serverEntryUrl(persist)],
      "opencode.jsonc": ["file:///other", serverEntryUrl(persist)],
      "home:opencode.json": [
        persist.name,
        "npm:@mcolsen-opencode/persist-permissions@0.1.0",
      ],
      "tui.json": [[tuiEntryUrl(persist), { hint: true }]],
      "tui.jsonc": [tuiEntryUrl(persist)],
      "home:tui.jsonc": [`${persist.name}/tui`],
    })
    const plan = buildPlan([persist], new Map([[persist.name, false]]), docs)
    expect(plan.perPlugin[0]).toMatchObject({
      server: "removed",
      tui: "removed",
    })
    expect(editFor(plan, "config.json").list).toEqual([])
    expect(editFor(plan, "opencode.jsonc").list).toEqual(["file:///other"])
    expect(editFor(plan, "home:opencode.json").list).toEqual([])
    expect(editFor(plan, "tui.json").list).toEqual([])
    expect(editFor(plan, "tui.jsonc").list).toEqual([])
    expect(editFor(plan, "home:tui.jsonc").list).toEqual([])
    // A file with no referencing entry is not rewritten.
    expect(editFor(plan, "opencode.json").changed).toBe(false)
  })

  test("unticking codex-limits sweeps the companion and canonical and legacy TUI entries", () => {
    const docs = docsFrom(defaultSources(), {
      "opencode.jsonc": [serverEntryUrl(codexLimits)],
      "tui.json": [
        tuiEntryUrl(codexLimits),
        "@mcolsen-opencode/usage-limits/tui",
      ],
      "home:tui.jsonc": [
        pathToFileURL("/repo/plugins/usage-limits/src/tui.tsx").href,
      ],
    })
    expect(pluginState(docs, codexLimits)).toMatchObject({
      server: true,
      tui: true,
      present: true,
    })

    const plan = buildPlan(
      [codexLimits],
      new Map([[codexLimits.name, false]]),
      docs,
    )
    expect(plan.perPlugin[0]).toMatchObject({
      server: "removed",
      tui: "removed",
    })
    expect(editFor(plan, "opencode.jsonc").list).toEqual([])
    expect(editFor(plan, "tui.json").list).toEqual([])
    expect(editFor(plan, "home:tui.jsonc").list).toEqual([])
  })

  test("ticking a half-installed plugin repairs only the missing half", () => {
    const docs = docsFrom(defaultSources(), {
      "opencode.jsonc": [serverEntryUrl(persist)],
    })
    const plan = buildPlan([persist], selection(persist.name), docs)
    expect(plan.perPlugin[0]).toMatchObject({ server: "none", tui: "added" })
    expect(editFor(plan, "opencode.jsonc").changed).toBe(false)
    expect(editFor(plan, "tui.json").list).toEqual([tuiEntryUrl(persist)])
  })

  test("ticking a masked entry repairs it by writing the file whose array is effective", () => {
    // persist sits in config.json but opencode.json's plugin key masks it.
    const docs = docsFrom(defaultSources(), {
      "config.json": [serverEntryUrl(persist)],
      "opencode.json": ["file:///other"],
    })
    const plan = buildPlan([persist], selection(persist.name), docs)
    expect(plan.perPlugin[0]?.server).toBe("added")
    expect(editFor(plan, "opencode.json").list).toEqual([
      "file:///other",
      serverEntryUrl(persist),
    ])
    // The masked entry is left alone on install; unticking sweeps it.
    expect(editFor(plan, "config.json").changed).toBe(false)
  })

  test.each([
    serverEntryUrl(websearch),
    "npm:@macarons/web-search@0.1.0",
    "search@npm:@macarons/web-search@0.1.0",
    path.relative(DEFAULT_DIR, websearch.serverEntry!),
  ])("masked web-search repair preserves saved options from %s", (spec) => {
    const options = {
      searxng: { url: "http://search.internal:8080", timeout: 5000 },
      native: { enabled: false },
      exa: { enabled: false },
    }
    const docs = docsFrom(defaultSources(), {
      "opencode.json": [[spec, options], "file:///masked-other"],
      "opencode.jsonc": ["file:///active-other"],
      "tui.json": [[tuiEntryUrl(websearch), { enabled: false }]],
    })
    expect(pluginState(docs, websearch).server).toBe(false)
    const plan = buildPlan(
      [websearch],
      selection(websearch.name),
      docs,
      new Map([[websearch.name, { native: { enabled: true } }]]),
    )
    expect(editFor(plan, "opencode.jsonc").list).toEqual([
      "file:///active-other",
      [serverEntryUrl(websearch), options],
    ])
    expect(editFor(plan, "opencode.json").changed).toBe(false)
    expect(editFor(plan, "tui.json").changed).toBe(false)
    expect(docFor(docs, "opencode.jsonc").list).toEqual([
      "file:///active-other",
    ])
    const repaired = docsFrom(defaultSources(), {
      "opencode.json": docFor(docs, "opencode.json").list,
      "opencode.jsonc": editFor(plan, "opencode.jsonc").list,
      "tui.json": docFor(docs, "tui.json").list,
    })
    expect(pluginState(repaired, websearch).server).toBe(true)
    expect(
      buildPlan([websearch], selection(websearch.name), repaired).changed,
    ).toBe(false)
  })

  test("masked legacy repair carries the tuple through migration and activation", () => {
    const options = { enabled: false, nested: { handEdited: [1, 2] } }
    const docs = docsFrom(defaultSources(), {
      "config.json": [["@mcolsen-opencode/server-only", options]],
      "opencode.jsonc": [],
    })
    const plan = buildPlan([serverOnly], selection(serverOnly.name), docs)
    for (const key of ["config.json", "opencode.jsonc"]) {
      expect(editFor(plan, key).list).toEqual([
        [serverEntryUrl(serverOnly), options],
      ])
    }
    expect(docFor(docs, "config.json").list).toEqual([
      ["@mcolsen-opencode/server-only", options],
    ])
  })

  test("equivalent masked tuples share one repair despite spec and key-order differences", () => {
    const options = { native: { enabled: false }, exa: { enabled: false } }
    const docs = docsFrom(defaultSources(), {
      "config.json": [[websearch.name, options]],
      "opencode.json": [
        [
          `npm:${websearch.name}@0.1.0`,
          { exa: { enabled: false }, native: { enabled: false } },
        ],
      ],
      "opencode.jsonc": [],
      "tui.json": [],
    })
    for (const inventory of [docs, [...docs].reverse()]) {
      const plan = buildPlan([websearch], selection(websearch.name), inventory)
      expect(editFor(plan, "opencode.jsonc").list).toEqual([
        [serverEntryUrl(websearch), options],
      ])
      expect(editFor(plan, "config.json").changed).toBe(false)
      expect(editFor(plan, "opencode.json").changed).toBe(false)
      expect(editFor(plan, "tui.json").list).toEqual([tuiEntryUrl(websearch)])
    }
  })

  test.each(["same file", "different files"])(
    "conflicting masked declarations in %s abort without mutating documents",
    (location) => {
      const privateEntry = [websearch.name, { native: { enabled: false } }]
      for (const conflicting of [
        [websearch.name, { native: { enabled: true } }],
        websearch.name,
      ]) {
        const docs = docsFrom(defaultSources(), {
          "config.json":
            location === "same file"
              ? [privateEntry, conflicting]
              : [privateEntry],
          "opencode.json": location === "same file" ? [] : [conflicting],
          "opencode.jsonc": [],
        })
        const original = structuredClone(docs)
        for (const inventory of [docs, [...docs].reverse()]) {
          expect(() =>
            buildPlan([websearch], selection(websearch.name), inventory),
          ).toThrow(/conflicting masked declarations/)
          expect(docs).toEqual(original)
        }
        // Refusing a repair must not prevent explicitly uninstalling leftovers.
        const removal = buildPlan([websearch], new Map(), docs)
        expect(editFor(removal, "config.json").list).toEqual([])
        expect(editFor(removal, "opencode.json").list).toEqual([])
      }
    },
  )

  test("install never introduces a `plugin` key that would mask a lower file's array", () => {
    // The old first-existing rule would have written opencode.jsonc, whose
    // new plugin key would replace-win over opencode.json and silently
    // deactivate file:///other.
    const docs = docsFrom(defaultSources(), {
      "opencode.jsonc": "exists-no-plugin-key",
      "opencode.json": ["file:///other"],
    })
    const plan = buildPlan([persist], selection(persist.name), docs)
    expect(editFor(plan, "opencode.jsonc").changed).toBe(false)
    expect(editFor(plan, "opencode.json").list).toEqual([
      "file:///other",
      serverEntryUrl(persist),
    ])
  })

  test("a plugin without a TUI half gets no tui entry", () => {
    const plan = buildPlan(
      [serverOnly],
      selection(serverOnly.name),
      docsFrom(defaultSources()),
    )
    expect(plan.perPlugin[0]).toMatchObject({
      server: "added",
      tui: "unavailable",
    })
  })

  test("a TUI-only plugin gets only a tui entry and no server entry", () => {
    const plan = buildPlan(
      [tuiOnly],
      selection(tuiOnly.name),
      docsFrom(defaultSources()),
    )
    expect(plan.perPlugin[0]).toMatchObject({
      server: "unavailable",
      tui: "added",
    })
    expect(editFor(plan, "opencode.jsonc").changed).toBe(false)
    expect(editFor(plan, "tui.json").list).toEqual([tuiEntryUrl(tuiOnly)])
  })

  test("threads edits for several plugins through one pass", () => {
    const docs = docsFrom(defaultSources(), {
      "opencode.jsonc": [serverEntryUrl(persist)],
      "tui.json": [tuiEntryUrl(persist)],
    })
    // Keep persist, add auto, in one plan.
    const plan = buildPlan(
      [persist, auto],
      selection(persist.name, auto.name),
      docs,
    )
    expect(editFor(plan, "opencode.jsonc").list).toEqual([
      serverEntryUrl(persist),
      serverEntryUrl(auto),
    ])
    expect(editFor(plan, "tui.json").list).toEqual([
      tuiEntryUrl(persist),
      tuiEntryUrl(auto),
    ])
  })

  test("input docs are not mutated", () => {
    const docs = docsFrom(defaultSources(), {
      "opencode.jsonc": [serverEntryUrl(persist)],
    })
    buildPlan([persist], new Map([[persist.name, false]]), docs)
    expect(docFor(docs, "opencode.jsonc").list).toEqual([
      serverEntryUrl(persist),
    ])
  })

  test("unticking sweeps a hand-written relative-path entry", () => {
    // /home/x/.opencode/opencode.json declaring ../../../repo/… resolves to
    // /repo/… — the host loads it (resolvePluginSpec), so the wizard must see
    // and sweep it.
    const docs = docsFrom(defaultSources(), {
      "home:opencode.json": [
        "../../../repo/plugins/persist-permissions/src/index.ts",
        "file:///other",
      ],
    })
    expect(pluginState(docs, persist)).toMatchObject({
      server: true,
      present: true,
    })
    const plan = buildPlan([persist], new Map([[persist.name, false]]), docs)
    expect(plan.perPlugin[0]?.server).toBe("removed")
    expect(editFor(plan, "home:opencode.json").list).toEqual(["file:///other"])
  })

  test("install-time options ride the new server entry as a [spec, options] tuple", () => {
    const options = new Map([
      [serverOnly.name, { searxng: { url: "http://sx:8080" } }],
    ])
    const plan = buildPlan(
      [serverOnly],
      selection(serverOnly.name),
      docsFrom(defaultSources()),
      options,
    )
    expect(plan.perPlugin[0]?.server).toBe("added")
    expect(editFor(plan, "opencode.jsonc").list).toEqual([
      [serverEntryUrl(serverOnly), { searxng: { url: "http://sx:8080" } }],
    ])
  })

  test("options are never attached to a TUI entry — only the server half carries them", () => {
    // persist ships both halves; the options map must not leak into tui.json.
    const options = new Map([[persist.name, { searxng: { url: "http://sx" } }]])
    const plan = buildPlan(
      [persist],
      selection(persist.name),
      docsFrom(defaultSources()),
      options,
    )
    expect(editFor(plan, "opencode.jsonc").list).toEqual([
      [serverEntryUrl(persist), { searxng: { url: "http://sx" } }],
    ])
    expect(editFor(plan, "tui.json").list).toEqual([tuiEntryUrl(persist)])
  })

  test("an empty options object degrades to a bare string, not a [spec, {}] tuple", () => {
    const plan = buildPlan(
      [serverOnly],
      selection(serverOnly.name),
      docsFrom(defaultSources()),
      new Map([[serverOnly.name, {}]]),
    )
    expect(editFor(plan, "opencode.jsonc").list).toEqual([
      serverEntryUrl(serverOnly),
    ])
  })

  test("options for an already-active plugin are ignored — nothing is re-added", () => {
    // Consulting options only when an entry is ADDED is what keeps an existing
    // install's hand-edited options untouched on a repair/no-op tick.
    const docs = docsFrom(defaultSources(), {
      "opencode.jsonc": [serverEntryUrl(serverOnly)],
    })
    const plan = buildPlan(
      [serverOnly],
      selection(serverOnly.name),
      docs,
      new Map([[serverOnly.name, { searxng: { url: "http://sx" } }]]),
    )
    expect(plan.changed).toBe(false)
  })

  test("a tuple install round-trips: unticking later sweeps the [spec, options] entry", () => {
    const plan1 = buildPlan(
      [serverOnly],
      selection(serverOnly.name),
      docsFrom(defaultSources()),
      new Map([[serverOnly.name, { searxng: { url: "http://sx:8080" } }]]),
    )
    // Feed the written tuple back in as the on-disk state, then untick.
    const docs = docsFrom(defaultSources(), {
      "opencode.jsonc": editFor(plan1, "opencode.jsonc").list,
    })
    const plan2 = buildPlan(
      [serverOnly],
      new Map([[serverOnly.name, false]]),
      docs,
    )
    expect(plan2.perPlugin[0]?.server).toBe("removed")
    expect(editFor(plan2, "opencode.jsonc").list).toEqual([])
  })
})

function tmpSource(
  dir: string,
  base: string,
  kind: ConfigKind = "server",
): ConfigSource {
  return {
    kind,
    file: path.join(dir, base),
    scope: "config-dir",
    origin: kind === "tui",
  }
}

describe("readSourceDoc", () => {
  const dirs: string[] = []
  afterEach(async () => {
    while (dirs.length)
      await fs.rm(dirs.pop() as string, { recursive: true, force: true })
  })
  async function tmp(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "installer-read-"))
    dirs.push(dir)
    return dir
  }

  test("a missing file is an empty, not-yet-existing doc", async () => {
    const dir = await tmp()
    const result = await readSourceDoc(tmpSource(dir, "opencode.json"))
    expect(result).toMatchObject({
      text: "",
      exists: false,
      hasPluginKey: false,
      list: [],
    })
  })
  test("reads an existing plugin array and retains the raw text", async () => {
    const dir = await tmp()
    const source = tmpSource(dir, "opencode.json")
    const text = JSON.stringify({ model: "x", plugin: ["file:///a"] })
    await fs.writeFile(source.file, text)
    const result = await readSourceDoc(source)
    expect(result.list).toEqual(["file:///a"])
    expect(result.text).toBe(text)
    expect(result.exists).toBe(true)
    expect(result.hasPluginKey).toBe(true)
  })
  test("parses JSONC — comments and trailing commas are allowed, not errors", async () => {
    const dir = await tmp()
    const source = tmpSource(dir, "opencode.jsonc")
    await fs.writeFile(
      source.file,
      [
        "{",
        "  // my plugins",
        '  "plugin": [',
        '    "file:///a",',
        "  ],",
        "}",
        "",
      ].join("\n"),
    )
    const result = await readSourceDoc(source)
    expect(result.list).toEqual(["file:///a"])
  })
  test("an absent plugin key yields an empty list and hasPluginKey false", async () => {
    const dir = await tmp()
    const source = tmpSource(dir, "tui.json", "tui")
    await fs.writeFile(source.file, JSON.stringify({ theme: "dark" }))
    const result = await readSourceDoc(source)
    expect(result.list).toEqual([])
    expect(result.hasPluginKey).toBe(false)
  })
  test("an explicit empty plugin array sets hasPluginKey — it masks lower collapse files", async () => {
    const dir = await tmp()
    const source = tmpSource(dir, "opencode.json")
    await fs.writeFile(source.file, JSON.stringify({ plugin: [] }))
    const result = await readSourceDoc(source)
    expect(result.list).toEqual([])
    expect(result.hasPluginKey).toBe(true)
  })
  test("refuses a genuinely malformed file", async () => {
    const dir = await tmp()
    const source = tmpSource(dir, "opencode.json")
    await fs.writeFile(source.file, '{ "plugin": [ }')
    expect(readSourceDoc(source)).rejects.toThrow(/not valid JSON/)
  })
  test("refuses a non-object document", async () => {
    const dir = await tmp()
    const source = tmpSource(dir, "opencode.json")
    await fs.writeFile(source.file, "[1,2,3]")
    expect(readSourceDoc(source)).rejects.toThrow(/not a JSON object/)
  })
  test("refuses a non-array plugin field", async () => {
    const dir = await tmp()
    const source = tmpSource(dir, "opencode.json")
    await fs.writeFile(source.file, JSON.stringify({ plugin: "oops" }))
    expect(readSourceDoc(source)).rejects.toThrow(/not an array/)
  })
})

describe("assertSourceDocsUnchanged", () => {
  const dirs: string[] = []
  afterEach(async () => {
    while (dirs.length)
      await fs.rm(dirs.pop() as string, { recursive: true, force: true })
  })

  test("a file replaced by a directory reports a source conflict with its cause", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "installer-recheck-"))
    dirs.push(dir)
    const source = tmpSource(dir, "opencode.json")
    await fs.writeFile(source.file, "{}")
    const doc = await readSourceDoc(source)
    await fs.rm(source.file)
    await fs.mkdir(source.file)

    const check = assertSourceDocsUnchanged([doc])
    await expect(check).rejects.toBeInstanceOf(SourceConflictError)
    await expect(check).rejects.toThrow(/could not be rechecked.*rerun/i)
    await expect(check).rejects.toMatchObject({
      message: expect.stringContaining(source.file),
      cause: expect.objectContaining({ code: "EISDIR" }),
    })
    expect((await fs.stat(source.file)).isDirectory()).toBe(true)
  })

  test.each(["existing", "absent"])(
    "an unreadable initially %s source reports a conflict instead of a raw error",
    async (state) => {
      const exists = state === "existing"
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "installer-recheck-"))
      dirs.push(dir)
      const source = tmpSource(dir, "opencode.json")
      if (exists) await fs.writeFile(source.file, "{}")
      const doc = await readSourceDoc(source)
      const cause = Object.assign(new Error("permission denied"), {
        code: "EACCES",
      })
      // Inject the OS fault so this also tests correctly when run as root.
      const read = spyOn(fs, exists ? "readFile" : "lstat").mockRejectedValue(
        cause,
      )
      try {
        const check = assertSourceDocsUnchanged([doc])
        await expect(check).rejects.toBeInstanceOf(SourceConflictError)
        await expect(check).rejects.toThrow(/could not be rechecked.*rerun/i)
        await expect(check).rejects.toMatchObject({
          message: expect.stringContaining(source.file),
          cause,
        })
      } finally {
        read.mockRestore()
      }
      if (exists) expect(await fs.readFile(source.file, "utf8")).toBe("{}")
      expect(await fs.readdir(dir)).toEqual(exists ? ["opencode.json"] : [])
    },
  )

  test("an unchanged non-target replaced by a symlink is refused with actionable guidance", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "installer-recheck-"))
    dirs.push(dir)
    const source = tmpSource(dir, "tui.json", "tui")
    const target = path.join(dir, "dotfile.json")
    const text = '{ "plugin": [] }\n'
    await fs.writeFile(source.file, text)
    const doc = await readSourceDoc(source)
    await fs.rename(source.file, target)
    await fs.symlink("dotfile.json", source.file, "file")

    const check = assertSourceDocsUnchanged([doc])
    await expect(check).rejects.toThrow(/symlink; refusing to replace/i)
    await expect(check).rejects.toThrow(/edit the symlink target directly/i)
    expect(await fs.readFile(source.file, "utf8")).toBe(doc.text)
  })
})

describe("readSourceDocs", () => {
  test("reports the first symlink in inventory order without starting later docs", async () => {
    const first = tmpSource("/configs", "first.json")
    const second = tmpSource("/configs", "second.json")
    const symlink = {
      isSymbolicLink: () => true,
    } as Stats
    let releaseFirst: (() => void) | undefined
    let secondStarted = false
    const lstat = spyOn(
      fs as unknown as { lstat: (file: string) => Promise<Stats> },
      "lstat",
    ).mockImplementation((file) => {
      if (file === first.file) {
        return new Promise<Stats>((resolve) => {
          releaseFirst = () => resolve(symlink)
        })
      }
      if (file === second.file) {
        secondStarted = true
        return Promise.resolve(symlink)
      }
      throw new Error(`unexpected lstat: ${file}`)
    })
    const reading = readSourceDocs([first, second])

    try {
      // Eager reads would have started the second lstat before this assertion.
      await Promise.resolve()
      expect(secondStarted).toBe(false)
      releaseFirst?.()
      await expect(reading).rejects.toThrow(first.file)
    } finally {
      releaseFirst?.()
      await reading.catch(() => undefined)
      lstat.mockRestore()
    }
  })
})

describe("writeSourceDoc", () => {
  const dirs: string[] = []
  afterEach(async () => {
    while (dirs.length)
      await fs.rm(dirs.pop() as string, { recursive: true, force: true })
  })
  async function tmp(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "installer-write-"))
    dirs.push(dir)
    return dir
  }

  test("creating opencode.json fresh adds the config $schema and the plugin array", async () => {
    const dir = await tmp()
    const source = tmpSource(dir, "opencode.json")
    await writeSourceDoc(await readSourceDoc(source), [serverEntryUrl(persist)])
    const written = JSON.parse(await fs.readFile(source.file, "utf8"))
    expect(written.$schema).toBe("https://opencode.ai/config.json")
    expect(written.plugin).toEqual([serverEntryUrl(persist)])
  })

  test("creating tui.json fresh adds the tui $schema and the plugin array", async () => {
    const dir = await tmp()
    const source = tmpSource(dir, "tui.json", "tui")
    await writeSourceDoc(await readSourceDoc(source), [tuiEntryUrl(persist)])
    const written = JSON.parse(await fs.readFile(source.file, "utf8"))
    expect(written.$schema).toBe("https://opencode.ai/tui.json")
    expect(written.plugin).toEqual([tuiEntryUrl(persist)])
  })

  test("rewriting an existing JSONC file preserves comments, trailing commas, and other keys", async () => {
    const dir = await tmp()
    const source = tmpSource(dir, "opencode.jsonc")
    const original = [
      "{",
      '  "$schema": "https://opencode.ai/config.json",',
      "  // keep my providers",
      '  "permission": {',
      '    "*": "ask",',
      "  },",
      '  "provider": {',
      "    // a comment inside provider",
      '    "warren": { "npm": "@ai-sdk/openai-compatible" },',
      "  },",
      "}",
      "",
    ].join("\n")
    await fs.writeFile(source.file, original)
    await writeSourceDoc(await readSourceDoc(source), [serverEntryUrl(persist)])
    const after = await fs.readFile(source.file, "utf8")
    // Comments and the user's structure survive verbatim.
    expect(after).toContain("// keep my providers")
    expect(after).toContain("// a comment inside provider")
    expect(after).toContain('"npm": "@ai-sdk/openai-compatible"')
    // And the plugin entry is now present and parseable.
    const errors: unknown[] = []
    const parsed = (await import("jsonc-parser")).parse(
      after,
      errors as never,
      { allowTrailingComma: true },
    )
    expect(errors).toEqual([])
    expect(parsed.plugin).toEqual([serverEntryUrl(persist)])
    expect(parsed.permission).toEqual({ "*": "ask" })
  })

  test("rewriting an existing plain-JSON file leaves its $schema untouched", async () => {
    const dir = await tmp()
    const source = tmpSource(dir, "opencode.json")
    await fs.writeFile(
      source.file,
      JSON.stringify(
        { model: "x", plugin: [serverEntryUrl(persist)] },
        null,
        2,
      ),
    )
    await writeSourceDoc(await readSourceDoc(source), [])
    const written = JSON.parse(await fs.readFile(source.file, "utf8"))
    expect(written.model).toBe("x")
    expect(written.$schema).toBeUndefined()
    expect(written.plugin).toEqual([])
  })

  test("a 0600-protected config keeps its mode across the atomic rewrite", async () => {
    // A config carrying provider credentials that the user locked down must
    // not come out of a rewrite group/other-readable via the temp file's
    // default mode.
    const dir = await tmp()
    const source = tmpSource(dir, "opencode.json")
    await fs.writeFile(source.file, JSON.stringify({ plugin: [] }))
    await fs.chmod(source.file, 0o600)
    await writeSourceDoc(await readSourceDoc(source), [serverEntryUrl(persist)])
    expect((await fs.stat(source.file)).mode & 0o7777).toBe(0o600)
    expect(JSON.parse(await fs.readFile(source.file, "utf8")).plugin).toEqual([
      serverEntryUrl(persist),
    ])
  })

  test("a symlinked config directory still supports regular-file rewrites", async () => {
    const dir = await tmp()
    const target = path.join(dir, "dotfiles")
    const linkedDir = path.join(dir, "opencode")
    await fs.mkdir(target)
    await fs.symlink(target, linkedDir, "dir")
    const source = tmpSource(linkedDir, "opencode.json")
    await fs.writeFile(source.file, '{ "plugin": [] }\n', { mode: 0o600 })

    await writeSourceDoc(await readSourceDoc(source), [serverEntryUrl(persist)])

    expect((await fs.lstat(linkedDir)).isSymbolicLink()).toBe(true)
    expect(await fs.readlink(linkedDir)).toBe(target)
    expect((await fs.lstat(source.file)).isFile()).toBe(true)
    expect(
      JSON.parse(await fs.readFile(path.join(target, "opencode.json"), "utf8"))
        .plugin,
    ).toEqual([serverEntryUrl(persist)])
    if (process.platform !== "win32")
      expect((await fs.stat(source.file)).mode & 0o7777).toBe(0o600)
    expect(await fs.readdir(target)).toEqual(["opencode.json"])
  })
})

describe("renderEdits", () => {
  const dirs: string[] = []
  afterEach(async () => {
    while (dirs.length)
      await fs.rm(dirs.pop() as string, { recursive: true, force: true })
  })

  test("renders and validates only the changed edits", () => {
    const docs = docsFrom(defaultSources(), {
      "opencode.json": [serverEntryUrl(persist)],
    })
    const plan = buildPlan([persist], new Map([[persist.name, false]]), docs)
    const rendered = renderEdits(plan.edits)
    // Only the one referencing file changed; unchanged docs are not rendered.
    expect(rendered.map((edit) => sourceKey(edit.doc.source))).toEqual([
      "opencode.json",
    ])
    expect(JSON.parse(rendered[0]?.output ?? "").plugin).toEqual([])
  })

  test("a render failure in ANY edit aborts before a single write can happen", async () => {
    // A doc whose text cannot take a top-level `plugin` key makes the render
    // throw. Placed after a valid edit, it must abort the whole batch — the
    // valid file is not written either, so an installer bug can never leave a
    // multi-file sweep half-applied.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "installer-render-"))
    dirs.push(dir)
    const good = await readSourceDoc(tmpSource(dir, "opencode.json"))
    const bad: SourceDoc = {
      source: tmpSource(dir, "config.json"),
      text: "[1,2,3]",
      exists: true,
      hasPluginKey: false,
      list: [],
    }
    const edits: DocEdit[] = [
      { doc: good, list: [serverEntryUrl(persist)], changed: true },
      { doc: bad, list: [serverEntryUrl(persist)], changed: true },
    ]
    expect(() => renderEdits(edits)).toThrow()
    // renderEdits is pure — nothing reached disk.
    expect(await fs.readdir(dir)).toEqual([])
  })

  test("writeRenderedEdit round-trips what renderEdits produced", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "installer-render-"))
    dirs.push(dir)
    const doc = await readSourceDoc(tmpSource(dir, "opencode.jsonc"))
    const [rendered] = renderEdits([
      { doc, list: [serverEntryUrl(persist)], changed: true },
    ])
    expect(rendered).toBeDefined()
    await writeRenderedEdit(rendered as RenderedEdit)
    expect(
      JSON.parse(await fs.readFile(doc.source.file, "utf8")).plugin,
    ).toEqual([serverEntryUrl(persist)])
  })
})

describe("assertRenderedDoc", () => {
  test("accepts a faithful rewrite, comments and all", () => {
    expect(() =>
      assertRenderedDoc("/x", '{ /* c */ "plugin": ["a",], }', ["a"]),
    ).not.toThrow()
  })
  test("rejects output that does not parse", () => {
    expect(() => assertRenderedDoc("/x", '{"plugin": [', ["a"])).toThrow(
      /installer bug/,
    )
  })
  test("rejects output whose plugin array does not round-trip", () => {
    expect(() => assertRenderedDoc("/x", '{"plugin": ["b"]}', ["a"])).toThrow(
      /installer bug/,
    )
    expect(() => assertRenderedDoc("/x", '{"model": "x"}', [])).toThrow(
      /installer bug/,
    )
  })
})

// ── Acceptance fixtures (issue #32): uninstall leaves no active origin ───────
//
// Each scenario builds a real config layout in a temp home dir, runs the full
// read → plan → write cycle exactly as the CLI does, then re-reads and asserts
// the host would no longer load the plugin from ANY origin — and that no file
// still references it at all.
describe("uninstall acceptance — every active origin is swept", () => {
  const dirs: string[] = []
  afterEach(async () => {
    while (dirs.length)
      await fs.rm(dirs.pop() as string, { recursive: true, force: true })
  })

  async function fixtureHome(files: Record<string, unknown>): Promise<string> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "installer-accept-"))
    dirs.push(home)
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(home, rel)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(
        target,
        typeof content === "string"
          ? content
          : JSON.stringify(content, null, 2),
      )
    }
    return home
  }

  async function applyCycle(options: {
    env: Record<string, string | undefined>
    home: string
    selection: Map<string, boolean>
  }) {
    const cfg = discoverConfigSources({
      env: options.env,
      homedir: options.home,
    })
    const docs = await readSourceDocs(cfg.sources)
    const plan = buildPlan([persist], options.selection, docs)
    // The same two-pass write the CLI does: validate everything, then write.
    for (const edit of renderEdits(plan.edits)) {
      await writeRenderedEdit(edit)
    }
    const after = await readSourceDocs(cfg.sources)
    return { cfg, docs, plan, after }
  }

  function assertGone(after: SourceDoc[], plugin: PluginInfo) {
    expect(
      activeEntries(after, "server").some((e) => entryMatchesPlugin(e, plugin)),
    ).toBe(false)
    expect(
      activeEntries(after, "tui").some((e) => entryMatchesPlugin(e, plugin)),
    ).toBe(false)
    for (const doc of after) {
      expect(doc.list.some((e) => entryMatchesPlugin(e, plugin))).toBe(false)
    }
  }

  const uninstall = new Map([[persist.name, false]])

  test("default dir: an entry inherited from config.json under a plugin-less opencode.json is removed", async () => {
    const home = await fixtureHome({
      ".config/opencode/config.json": { plugin: [serverEntryUrl(persist)] },
      ".config/opencode/opencode.json": { model: "x" },
    })
    const { docs, plan, after } = await applyCycle({
      env: {},
      home,
      selection: uninstall,
    })
    // Precondition: the host inherits the lower file's array, so the entry IS
    // active — the layout the old first-existing rule could not uninstall.
    expect(
      activeEntries(docs, "server").some((e) => entryMatchesPlugin(e, persist)),
    ).toBe(true)
    expect(plan.perPlugin[0]?.server).toBe("removed")
    assertGone(after, persist)
    // The plugin-less higher file was not rewritten.
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(home, ".config/opencode/opencode.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      model: "x",
    })
  })

  test("custom dir: entries in both opencode.json and opencode.jsonc are removed", async () => {
    const home = await fixtureHome({
      "custom/opencode.json": { plugin: [serverEntryUrl(persist)] },
      "custom/opencode.jsonc": {
        plugin: [serverEntryUrl(persist), "file:///other"],
      },
    })
    const env = { OPENCODE_CONFIG_DIR: path.join(home, "custom") }
    const { docs, plan, after } = await applyCycle({
      env,
      home,
      selection: uninstall,
    })
    // Precondition: even though jsonc defines the key, json's entry is STILL
    // active — each custom-dir file is an independent origin (the H1 hazard).
    const activeBefore = activeEntries(docs, "server")
    expect(
      activeBefore.filter((e) => entryMatchesPlugin(e, persist)).length,
    ).toBeGreaterThanOrEqual(2)
    expect(plan.perPlugin[0]?.server).toBe("removed")
    assertGone(after, persist)
    // The unrelated entry survives.
    expect(activeEntries(after, "server")).toContain("file:///other")
  })

  test("custom dir: a config.json-only entry (read via the collapse) is removed", async () => {
    const home = await fixtureHome({
      "custom/config.json": { plugin: [serverEntryUrl(persist)] },
      "custom/opencode.jsonc": { theme: "dark" },
    })
    const env = { OPENCODE_CONFIG_DIR: path.join(home, "custom") }
    const { docs, plan, after } = await applyCycle({
      env,
      home,
      selection: uninstall,
    })
    expect(
      activeEntries(docs, "server").some((e) => entryMatchesPlugin(e, persist)),
    ).toBe(true)
    expect(plan.perPlugin[0]?.server).toBe("removed")
    assertGone(after, persist)
  })

  test("home ~/.opencode entries are removed alongside the global dir's", async () => {
    const home = await fixtureHome({
      ".config/opencode/opencode.json": { plugin: [serverEntryUrl(persist)] },
      ".opencode/opencode.jsonc": { plugin: [persist.name] },
    })
    const { docs, plan, after } = await applyCycle({
      env: {},
      home,
      selection: uninstall,
    })
    expect(
      activeEntries(docs, "server").filter((e) =>
        entryMatchesPlugin(e, persist),
      ).length,
    ).toBe(2)
    expect(plan.perPlugin[0]?.server).toBe("removed")
    assertGone(after, persist)
  })

  test("tui.json and tui.jsonc both lose their entries", async () => {
    const home = await fixtureHome({
      ".config/opencode/tui.json": { plugin: [tuiEntryUrl(persist)] },
      ".config/opencode/tui.jsonc": {
        plugin: [tuiEntryUrl(persist), "file:///other-tui"],
      },
    })
    const { docs, plan, after } = await applyCycle({
      env: {},
      home,
      selection: uninstall,
    })
    expect(
      activeEntries(docs, "tui").filter((e) => entryMatchesPlugin(e, persist))
        .length,
    ).toBe(2)
    expect(plan.perPlugin[0]?.tui).toBe("removed")
    assertGone(after, persist)
    // The unrelated TUI entry survives.
    expect(activeEntries(after, "tui")).toContain("file:///other-tui")
  })

  test("install writes the defining file instead of masking it from a higher one", async () => {
    // Full-cycle version of the masking regression: the old first-existing
    // rule would write opencode.jsonc and deactivate file:///other.
    const home = await fixtureHome({
      ".config/opencode/opencode.jsonc": { theme: "dark" },
      ".config/opencode/opencode.json": { plugin: ["file:///other"] },
    })
    const { plan, after } = await applyCycle({
      env: {},
      home,
      selection: new Map([[persist.name, true]]),
    })
    expect(plan.perPlugin[0]?.server).toBe("added")
    const active = activeEntries(after, "server")
    expect(active.some((e) => entryMatchesPlugin(e, persist))).toBe(true)
    expect(active).toContain("file:///other")
    // opencode.jsonc still has no plugin key.
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(home, ".config/opencode/opencode.jsonc"),
          "utf8",
        ),
      ).plugin,
    ).toBeUndefined()
  })
})

describe("writeRenderedEdit fault handling", () => {
  const dirs: string[] = []
  afterEach(async () => {
    while (dirs.length)
      await fs.rm(dirs.pop() as string, { recursive: true, force: true })
  })
  async function tmp(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "installer-fault-"))
    dirs.push(dir)
    return dir
  }

  test.each(["edit", "replace", "comment", "delete", "create"] as const)(
    "a concurrent %s during staging aborts publication and cleans up the temp file",
    async (change) => {
      const dir = await tmp()
      const source = tmpSource(dir, "opencode.jsonc")
      const original =
        '{\n  // original\n  "model": "provider/old",\n  "plugin": []\n}\n'
      const updated =
        change === "comment"
          ? original.replace("// original", "// edited comment")
          : '{\n  // editor\n  "model": "provider/new",\n  "plugin": ["other-plugin"]\n}\n'
      if (change !== "create") await fs.writeFile(source.file, original)
      const doc = await readSourceDoc(source)
      const [edit] = renderEdits([
        { doc, list: [serverEntryUrl(persist)], changed: true },
      ])
      const realWriteFile = fs.writeFile.bind(fs)
      let raced = false
      const write = spyOn(fs, "writeFile").mockImplementation(
        async (...args) => {
          await realWriteFile(...args)
          const target = String(args[0])
          if (!target.startsWith(`${source.file}.`) || !target.endsWith(".tmp"))
            return
          raced = true
          if (change === "delete") {
            await fs.rm(source.file)
          } else {
            const editor =
              change === "replace" ? `${source.file}.editor` : source.file
            await realWriteFile(editor, updated)
            await fs.chmod(editor, 0o600)
            if (change === "replace") await fs.rename(editor, source.file)
          }
        },
      )
      try {
        await expect(
          writeRenderedEdit(edit as RenderedEdit),
        ).rejects.toBeInstanceOf(SourceConflictError)
      } finally {
        write.mockRestore()
      }
      expect(raced).toBe(true)
      if (change === "delete") {
        expect(await fs.readdir(dir)).toEqual([])
      } else {
        expect(await fs.readFile(source.file, "utf8")).toBe(updated)
        expect((await fs.stat(source.file)).mode & 0o7777).toBe(0o600)
        expect(await fs.readdir(dir)).toEqual(["opencode.jsonc"])
      }
    },
  )

  test("an absent destination created after the final check is never replaced", async () => {
    const dir = await tmp()
    const source = tmpSource(dir, "opencode.jsonc")
    const doc = await readSourceDoc(source)
    const updated =
      '{ /* editor */ "model": "provider/new", "plugin": ["other"] }\n'
    const realLink = fs.link.bind(fs)
    let raced = false
    const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
      if (String(to) === source.file) {
        raced = true
        await fs.writeFile(source.file, updated, { mode: 0o600 })
      }
      return realLink(from, to)
    })
    try {
      await expect(
        writeSourceDoc(doc, [serverEntryUrl(persist)]),
      ).rejects.toBeInstanceOf(SourceConflictError)
    } finally {
      link.mockRestore()
    }
    expect(raced).toBe(true)
    expect(await fs.readFile(source.file, "utf8")).toBe(updated)
    expect((await fs.stat(source.file)).mode & 0o7777).toBe(0o600)
    expect(await fs.readdir(dir)).toEqual(["opencode.jsonc"])
  })

  test("a new destination does not inherit the mode of a transient occupant", async () => {
    const dir = await tmp()
    const source = tmpSource(dir, "opencode.jsonc")
    const doc = await readSourceDoc(source)
    await fs.writeFile(source.file, "{}")
    await fs.chmod(source.file, 0o666)
    const realWriteFile = fs.writeFile.bind(fs)
    let raced = false
    const write = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await realWriteFile(...args)
      const target = String(args[0])
      if (target.startsWith(`${source.file}.`) && target.endsWith(".tmp")) {
        raced = true
        await fs.rm(source.file)
      }
    })
    const previous = process.umask(0o077)
    try {
      await writeSourceDoc(doc, [serverEntryUrl(persist)])
    } finally {
      process.umask(previous)
      write.mockRestore()
    }
    expect(raced).toBe(true)
    expect((await fs.stat(source.file)).mode & 0o7777).toBe(0o600)
    expect((await readSourceDoc(source)).list).toEqual([
      serverEntryUrl(persist),
    ])
    expect(await fs.readdir(dir)).toEqual(["opencode.jsonc"])
  })

  test("a mode tightened during staging is retained without losing JSONC comments", async () => {
    const dir = await tmp()
    const source = tmpSource(dir, "opencode.jsonc")
    await fs.writeFile(source.file, '{ /* keep */ "plugin": [] }\n')
    await fs.chmod(source.file, 0o644)
    const doc = await readSourceDoc(source)
    const realWriteFile = fs.writeFile.bind(fs)
    let raced = false
    const write = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await realWriteFile(...args)
      const target = String(args[0])
      if (target.startsWith(`${source.file}.`) && target.endsWith(".tmp")) {
        raced = true
        await fs.chmod(source.file, 0o600)
      }
    })
    try {
      await writeSourceDoc(doc, [serverEntryUrl(persist)])
    } finally {
      write.mockRestore()
    }
    expect(raced).toBe(true)
    expect((await fs.stat(source.file)).mode & 0o7777).toBe(0o600)
    const after = await readSourceDoc(source)
    expect(after.text).toContain("/* keep */")
    expect(after.list).toEqual([serverEntryUrl(persist)])
    expect(await fs.readdir(dir)).toEqual(["opencode.jsonc"])
  })

  test.each(["before write", "during staging"])(
    "refuses a config replaced by a symlink %s without detaching it",
    async (timing) => {
      const dir = await tmp()
      const source = tmpSource(dir, "opencode.jsonc")
      const target = path.join(dir, "dotfile.jsonc")
      const text = '{ /* private config */ "plugin": [] }\n'
      await fs.writeFile(source.file, text, { mode: 0o600 })
      const doc = await readSourceDoc(source)
      const [edit] = renderEdits([
        { doc, list: [serverEntryUrl(persist)], changed: true },
      ])
      const plantSymlink = async () => {
        await fs.rename(source.file, target)
        await fs.symlink("dotfile.jsonc", source.file, "file")
      }
      if (timing === "before write") await plantSymlink()

      const realWriteFile = fs.writeFile.bind(fs)
      const write = spyOn(fs, "writeFile").mockImplementation(
        async (...args) => {
          await realWriteFile(...args)
          if (
            timing === "during staging" &&
            String(args[0]).startsWith(`${source.file}.`) &&
            String(args[0]).endsWith(".tmp")
          )
            await plantSymlink()
        },
      )
      try {
        await expect(writeRenderedEdit(edit!)).rejects.toThrow(/symlink/)
        if (timing === "before write") expect(write).not.toHaveBeenCalled()
        else expect(write).toHaveBeenCalledTimes(1)
      } finally {
        write.mockRestore()
      }

      expect((await fs.lstat(source.file)).isSymbolicLink()).toBe(true)
      expect(await fs.readlink(source.file)).toBe("dotfile.jsonc")
      expect(await fs.readFile(target, "utf8")).toBe(text)
      if (process.platform !== "win32")
        expect((await fs.stat(target)).mode & 0o7777).toBe(0o600)
      expect((await fs.readdir(dir)).sort()).toEqual([
        "dotfile.jsonc",
        "opencode.jsonc",
      ])
    },
  )

  test("a failed write leaves no .tmp orphan in the user's config directory", async () => {
    // A directory at the destination makes the rename fail after the temp file
    // is already on disk. Without the cleanup the fault (ENOSPC, EXDEV, a
    // read-only fs) permanently strands an `opencode.json.<pid>.<rand>.tmp`
    // beside the user's config — the same cleanup invariant enforced by the
    // shared writeTextFile helper this path delegates to.
    const dir = await tmp()
    const source = tmpSource(dir, "opencode.json")
    await fs.mkdir(source.file)
    await fs.writeFile(path.join(source.file, "occupant"), "x")
    const edit: RenderedEdit = {
      doc: {
        source,
        text: "",
        exists: false,
        hasPluginKey: false,
        list: [],
      },
      output: '{ "plugin": [] }\n',
    }
    await expect(writeRenderedEdit(edit)).rejects.toThrow()
    expect(
      (await fs.readdir(dir)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([])
  })

  test("the target's mode survives a umask that would have stripped it", async () => {
    // writeFile's `mode` passes through the process umask, so the temp file can
    // land narrower than the config it replaces; the chmod is what restores the
    // stripped bits. Under the default 022 umask a 0600 config is immune (umask
    // only clears bits), which is why this pins a group-readable 0660 target —
    // dropping the chmod silently rewrites it as 0640 and locks the user's own
    // group out of a config they deliberately shared.
    const dir = await tmp()
    const source = tmpSource(dir, "opencode.json")
    await fs.writeFile(source.file, JSON.stringify({ plugin: [] }))
    await fs.chmod(source.file, 0o660)
    const previous = process.umask(0o027)
    try {
      await writeSourceDoc(await readSourceDoc(source), [
        serverEntryUrl(persist),
      ])
    } finally {
      process.umask(previous)
    }
    expect((await fs.stat(source.file)).mode & 0o7777).toBe(0o660)
  })
})

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"
import {
  pathExists,
  readJsonFile,
  resolveConfigDir,
  writeTextFile,
} from "@macarons/permission-rules"
import {
  applyEdits,
  modify,
  type ParseError,
  parse,
  printParseErrorCode,
} from "jsonc-parser"

/**
 * Pure install/uninstall logic for the wizard. Everything here is
 * side-effect-free except the clearly-marked filesystem functions
 * (`discoverPlugins`, `readSourceDoc`, `readSourceDocs`, `assertConfigNotSymlink`,
 * and `assertSourceDocsUnchanged` read; `writeSourceDoc` and `writeRenderedEdit` write),
 * so the decision layer — which config files the host reads plugin entries
 * from, whether a plugin is active, and what a given selection changes —
 * is unit tested without a terminal or a real OpenCode config.
 *
 * Config files are read and written the way OpenCode itself handles them:
 * JSON-with-comments is accepted everywhere, and existing files are edited
 * comment-preserving via jsonc-parser. The wizard respects the files a user
 * already keeps and never strips their comments.
 */

/** A discovered, installable plugin and where its two halves live on disk. */
export type PluginInfo = {
  /** Scoped package name, e.g. `@macarons/persist-permissions`. */
  name: string
  /** Short display id (the last path segment of the name), e.g. `persist-permissions`. */
  id: string
  /** package.json `description`, used as the checkbox blurb. */
  description: string
  /** Absolute path to the plugin's package directory. */
  dir: string
  /** Absolute path to the server-half entry (`src/index.ts`), when the package exports one. */
  serverEntry?: string
  /** Absolute path to the TUI-half entry (`src/tui.tsx`), when the package exports one. */
  tuiEntry?: string
}

/** Which of the host's two plugin systems a config file feeds. */
export type ConfigKind = "server" | "tui"

// ── How OpenCode assembles the active plugin set (user level) ────────────────
//
// Rules transcribed from the pinned host source, 1.18.x line. The
// "config-source rules" test in test/core.test.ts fails whenever
// `.opencode-version` moves to a new minor line, forcing this block and the
// code that encodes it to be re-verified against the new source together.
//
//  1. Global scope: `OPENCODE_CONFIG_DIR` *replaces* the default
//     `$XDG_CONFIG_HOME/opencode` / `~/.config/opencode` directory entirely
//     (`Global.Path.config = Flag.OPENCODE_CONFIG_DIR ?? Path.config`,
//     packages/core/src/global.ts:64). The default dir is never read when the
//     flag is set.
//  2. Inside the global dir, `config.json` < `opencode.json` <
//     `opencode.jsonc` are collapsed replace-wins (remeda mergeDeep,
//     config.ts:246-260): arrays REPLACE, so the effective `plugin` array is
//     that of the highest file that defines the key, and a higher file that
//     omits it inherits the lower one's array. The collapsed result enters
//     the plugin origins as ONE source.
//  3. Plugin origins CONCAT across scopes (mergePluginOrigins /
//     deduplicatePluginOrigins, config.ts:330-354). For every config dir that
//     ends with ".opencode" or IS `OPENCODE_CONFIG_DIR`, `opencode.json` AND
//     `opencode.jsonc` are each loaded as separate, unconditionally active
//     origins (config.ts:424-430) — on top of the collapse when that dir is
//     also the global one. Home `~/.opencode` is such a dir in every mode
//     (config/paths.ts:23-41).
//  4. TUI: `tui.json` AND `tui.jsonc` both load per directory — the global
//     dir plus every ".opencode"/`OPENCODE_CONFIG_DIR` dir — and their
//     plugin origins all concat (config/paths.ts:43-45, tui.ts:184-207).
//
// Out of the wizard's model (it is a user-level tool): project `.opencode`
// dirs between a project cwd and its worktree root, `OPENCODE_CONFIG`,
// `OPENCODE_CONFIG_CONTENT`, `OPENCODE_TUI_CONFIG`, and remote well-known
// configs. The CLI warns when the env flags are set.
//
// Consequences encoded below:
//  - INSTALL (`installTarget`) writes the file whose entry actually takes
//    effect: the highest collapse file already defining `plugin` — writing a
//    new `plugin` key into a higher file would mask a lower file's array —
//    else the first-existing of opencode.jsonc/opencode.json/config.json
//    (the order OpenCode's own config writer uses), else a fresh
//    opencode.jsonc. TUI installs go to tui.json, or tui.jsonc when that is
//    the only TUI file kept — any TUI file works, they all concat.
//  - UNINSTALL (`buildPlan`) sweeps EVERY inventoried file: entries in a
//    lower collapse file are active whenever the higher files omit the key,
//    custom-dir and `.opencode` json/jsonc entries are active regardless,
//    and even a currently-masked entry is one unrelated config edit away
//    from loading again.

const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json"
const OPENCODE_TUI_SCHEMA = "https://opencode.ai/tui.json"

/** Which user-level location a config file belongs to. */
export type SourceScope = "config-dir" | "home-opencode"

/** One config file the host reads plugin entries from, and how it activates them. */
export type ConfigSource = {
  kind: ConfigKind
  /** Absolute path; the file may not exist yet. */
  file: string
  scope: SourceScope
  /**
   * Position in the global dir's replace-wins collapse (higher wins);
   * undefined for files outside the collapse. Only the highest existing
   * collapse file that defines a `plugin` key contributes its array.
   */
  collapseRank?: number
  /** Concat-merged as an independent origin: its entries are active unconditionally. */
  origin: boolean
}

/** The full set of user-level config files the wizard inventories. */
export type ConfigSources = {
  /** The active global config dir; `OPENCODE_CONFIG_DIR`/--config-dir replaces the default. */
  configDir: string
  /** True when configDir came from `OPENCODE_CONFIG_DIR` or --config-dir rather than the default rule. */
  custom: boolean
  /** `~/.opencode`, always an active origin dir; undefined when it IS configDir. */
  homeOpencodeDir?: string
  sources: ConfigSource[]
}

/**
 * Enumerate every user-level config file OpenCode reads plugin entries from,
 * per the source rules documented above. Pure: nothing here touches the
 * filesystem, so the per-mode inventories are directly unit-testable.
 */
export function discoverConfigSources(options: {
  env: Record<string, string | undefined>
  homedir: string
  /** CLI --config-dir; behaves exactly like `OPENCODE_CONFIG_DIR` (replaces the default global dir). */
  configDirOverride?: string
}): ConfigSources {
  const override = options.configDirOverride?.trim()
  const configDir = override || resolveConfigDir(options.env, options.homedir)
  const custom = Boolean(override || options.env.OPENCODE_CONFIG_DIR?.trim())

  // The host's own predicate for "this dir's opencode.json/.jsonc are each an
  // independent origin" is `dir === OPENCODE_CONFIG_DIR || dir.endsWith(".opencode")`
  // (config.ts:424-430) — a string test, not a mode test — so mirror it.
  const globalPairIsOrigin = custom || configDir.endsWith(".opencode")

  const sources: ConfigSource[] = [
    {
      kind: "server",
      file: path.join(configDir, "config.json"),
      scope: "config-dir",
      collapseRank: 0,
      origin: false,
    },
    {
      kind: "server",
      file: path.join(configDir, "opencode.json"),
      scope: "config-dir",
      collapseRank: 1,
      origin: globalPairIsOrigin,
    },
    {
      kind: "server",
      file: path.join(configDir, "opencode.jsonc"),
      scope: "config-dir",
      collapseRank: 2,
      origin: globalPairIsOrigin,
    },
    {
      kind: "tui",
      file: path.join(configDir, "tui.json"),
      scope: "config-dir",
      origin: true,
    },
    {
      kind: "tui",
      file: path.join(configDir, "tui.jsonc"),
      scope: "config-dir",
      origin: true,
    },
  ]

  // Home ~/.opencode is a further active origin dir in every mode; when the
  // global dir IS ~/.opencode (OPENCODE_CONFIG_DIR pointed there) its files
  // are already inventoried above.
  const homeOpencode = path.join(options.homedir, ".opencode")
  if (path.resolve(homeOpencode) === path.resolve(configDir)) {
    return { configDir, custom, sources }
  }
  for (const base of ["opencode.json", "opencode.jsonc"]) {
    sources.push({
      kind: "server",
      file: path.join(homeOpencode, base),
      scope: "home-opencode",
      origin: true,
    })
  }
  for (const base of ["tui.json", "tui.jsonc"]) {
    sources.push({
      kind: "tui",
      file: path.join(homeOpencode, base),
      scope: "home-opencode",
      origin: true,
    })
  }
  return { configDir, custom, homeOpencodeDir: homeOpencode, sources }
}

/** The canonical `plugin` entry for a plugin's server half, or undefined if it has none. */
export function serverEntryUrl(plugin: PluginInfo): string | undefined {
  return plugin.serverEntry ? pathToFileURL(plugin.serverEntry).href : undefined
}

/** The canonical `plugin` entry for a plugin's TUI half, or undefined if it has none. */
export function tuiEntryUrl(plugin: PluginInfo): string | undefined {
  return plugin.tuiEntry ? pathToFileURL(plugin.tuiEntry).href : undefined
}

/**
 * Discover installable plugins under `<repoRoot>/plugins`. Each is a package
 * whose `exports` map names a server entry (`.`/`./server`) and/or a TUI entry
 * (`./tui`) — a plugin may ship either or both halves (e.g. synthetic-limits is
 * TUI-only). A directory with no resolvable, existing entry of either kind is
 * skipped rather than offered as broken — and so is one that declares an
 * entry whose file is missing on disk: offering the surviving half would
 * turn a broken dual-half package into a silent partial install.
 */
export async function discoverPlugins(repoRoot: string): Promise<PluginInfo[]> {
  const pluginsDir = path.join(repoRoot, "plugins")
  let entries: string[]
  try {
    entries = (await fs.readdir(pluginsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }

  const plugins: PluginInfo[] = []
  for (const name of entries) {
    const dir = path.join(pluginsDir, name)
    const pkg = await readPackageJson(path.join(dir, "package.json"))
    if (!pkg || typeof pkg.name !== "string") continue

    const serverRel =
      pickExport(pkg, ["./server", "."]) ??
      (typeof pkg.main === "string" ? pkg.main : undefined)
    const serverEntry = await resolveEntry(dir, serverRel)

    const tuiRel = pickExport(pkg, ["./tui"])
    const tuiEntry = await resolveEntry(dir, tuiRel)

    // An entry that is declared but missing on disk means the package is
    // broken, not single-half; accepting whichever half survived would
    // install a plugin its author intended to have both. Reject the package.
    if ((serverRel && !serverEntry) || (tuiRel && !tuiEntry)) continue

    // A package that exposes neither half is not installable; skip it rather
    // than offer something the wizard cannot act on.
    if (!serverEntry && !tuiEntry) continue

    plugins.push({
      name: pkg.name,
      id: pkg.name.split("/").pop() ?? pkg.name,
      description: typeof pkg.description === "string" ? pkg.description : "",
      dir,
      serverEntry,
      tuiEntry,
    })
  }
  plugins.sort((a, b) => a.id.localeCompare(b.id))
  return plugins
}

/** Resolve a package-relative entry to an absolute path, or undefined if it is absent or missing on disk. */
async function resolveEntry(
  dir: string,
  rel: string | undefined,
): Promise<string | undefined> {
  if (!rel) return undefined
  const resolved = path.resolve(dir, rel)
  return (await pathExists(resolved)) ? resolved : undefined
}

type PackageJson = {
  name?: unknown
  description?: unknown
  main?: unknown
  exports?: unknown
}

async function readPackageJson(file: string): Promise<PackageJson | undefined> {
  return readJsonFile(file, (value) =>
    value && typeof value === "object" ? (value as PackageJson) : undefined,
  )
}

function pickExport(pkg: PackageJson, keys: string[]): string | undefined {
  const exports = pkg.exports
  if (!exports || typeof exports !== "object") return undefined
  const map = exports as Record<string, unknown>
  for (const key of keys) {
    const value = map[key]
    if (typeof value === "string") return value
  }
  return undefined
}

/** One source file's parsed state: raw text plus its normalized `plugin` array. */
export type SourceDoc = {
  source: ConfigSource
  /** Raw original text; empty when the file does not exist yet. */
  text: string
  /** Whether the file exists on disk (an empty-but-present file counts). */
  exists: boolean
  /** Whether the document defines a `plugin` key at all — this drives collapse inheritance. */
  hasPluginKey: boolean
  /** The `plugin` array, normalized to an array (empty when the file/key is absent). */
  list: unknown[]
}

class ConfigSymlinkError extends Error {
  constructor(file: string) {
    super(
      `${file} is a symlink; refusing to replace it. To add or remove plugins, edit the symlink target directly in your dotfiles instead`,
    )
  }
}

/** A leaf symlink would be detached by the atomic writer's rename. */
export async function assertConfigNotSymlink(file: string): Promise<void> {
  const entry = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  if (entry?.isSymbolicLink()) throw new ConfigSymlinkError(file)
}

/**
 * Read one source file's `plugin` array, tolerating JSON-with-comments and
 * trailing commas exactly as OpenCode does. A missing file yields an empty,
 * not-yet-existing doc; a file with real syntax errors, or whose top level is
 * not an object, or whose `plugin` key is not an array, throws — the caller
 * must refuse to rewrite a config it cannot understand. The raw text is
 * retained so a write can edit it in place, preserving comments.
 */
export async function readSourceDoc(source: ConfigSource): Promise<SourceDoc> {
  await assertConfigNotSymlink(source.file)
  let text: string
  try {
    text = await fs.readFile(source.file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { source, text: "", exists: false, hasPluginKey: false, list: [] }
    }
    throw error
  }

  if (text.trim() === "")
    return { source, text, exists: true, hasPluginKey: false, list: [] }

  const errors: ParseError[] = []
  const parsed = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (errors.length) {
    const first = errors[0]
    const detail = first
      ? `${printParseErrorCode(first.error)} at offset ${first.offset}`
      : "unknown error"
    throw new Error(
      `${source.file} is not valid JSON/JSONC (${detail}); fix or remove it and retry`,
    )
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${source.file} is not a JSON object; refusing to modify it`,
    )
  }
  const raw = (parsed as Record<string, unknown>).plugin
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new Error(
      `${source.file} has a "plugin" field that is not an array; refusing to modify it`,
    )
  }
  return {
    source,
    text,
    exists: true,
    hasPluginKey: raw !== undefined,
    list: Array.isArray(raw) ? [...raw] : [],
  }
}

/** Read the whole inventory in order. Rejects with the first unreadable file's error. */
export async function readSourceDocs(
  sources: ConfigSource[],
): Promise<SourceDoc[]> {
  const docs: SourceDoc[] = []
  for (const source of sources) {
    docs.push(await readSourceDoc(source))
  }
  return docs
}

export class SourceConflictError extends Error {
  constructor(file: string, cause?: unknown) {
    super(
      `${file} ${cause === undefined ? "changed since the installer read it" : "could not be rechecked"}; refusing to apply a stale plan. Rerun the wizard to review a fresh plan.`,
      { cause },
    )
  }
}

type SourceSnapshot = Pick<SourceDoc, "source" | "text" | "exists">

/** Recheck the whole inventory, including absent files and unchanged plan inputs. */
export async function assertSourceDocsUnchanged(
  docs: SourceSnapshot[],
): Promise<void> {
  await Promise.all(
    docs.map(async (doc) => {
      let exists = true
      let text: string | undefined
      try {
        await assertConfigNotSymlink(doc.source.file)
        if (doc.exists) text = await fs.readFile(doc.source.file, "utf8")
        // lstat counts any new directory entry, even an empty file or dangling symlink.
        else await fs.lstat(doc.source.file)
      } catch (error) {
        if (error instanceof ConfigSymlinkError) throw error
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new SourceConflictError(doc.source.file, error)
        exists = false
      }
      if (exists !== doc.exists || (exists && text !== doc.text))
        throw new SourceConflictError(doc.source.file)
    }),
  )
}

/** Extract the spec string from a `plugin` entry — a bare string or a `[spec, options]` tuple. */
export function entrySpec(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return undefined
}

function specToPath(spec: string, sourceFile?: string): string | undefined {
  if (spec.startsWith("file://")) {
    try {
      return fileURLToPath(spec)
    } catch {
      return undefined
    }
  }
  if (path.isAbsolute(spec)) return spec
  // The host treats only `.`-prefixed specs as relative paths, resolved
  // against the declaring config file's directory (isPathPluginSpec /
  // resolvePluginSpec, packages/opencode/src/plugin/shared.ts:171,
  // config/plugin.ts:42-60); any other bare spec is a package specifier.
  if (sourceFile && spec.startsWith("."))
    return path.resolve(path.dirname(sourceFile), spec)
  return undefined
}

const CODEX_LIMITS_PACKAGE = "@macarons/codex-limits"
const PACKAGE_SCOPE = "@macarons/"
const LEGACY_PACKAGE_SCOPE = "@mcolsen-opencode/"
const LEGACY_USAGE_LIMITS_PACKAGE = "@mcolsen-opencode/usage-limits"

function packageSpecTargets(spec: string, packageName: string): boolean {
  if (
    spec.startsWith("file://") ||
    spec.startsWith(".") ||
    path.isAbsolute(spec)
  )
    return false
  const npmMarker = spec.startsWith("npm:")
    ? 4
    : /^(?:@[^/:]+\/)?[^/@:]+@npm:/.test(spec)
      ? spec.indexOf("@npm:") + 5
      : 0
  const target = spec.slice(npmMarker)
  return (
    target === packageName ||
    target.startsWith(`${packageName}/`) ||
    target.startsWith(`${packageName}@`)
  )
}

function entryMatchesLegacyPackage(
  entry: unknown,
  plugin: PluginInfo,
): boolean {
  if (!plugin.name.startsWith(PACKAGE_SCOPE)) return false
  const spec = entrySpec(entry)
  if (!spec) return false
  const legacyName = `${LEGACY_PACKAGE_SCOPE}${plugin.name.slice(PACKAGE_SCOPE.length)}`
  return packageSpecTargets(spec, legacyName)
}

function entryMatchesLegacyCodexLimits(
  entry: unknown,
  plugin: PluginInfo,
  sourceFile?: string,
): boolean {
  if (plugin.name !== CODEX_LIMITS_PACKAGE) return false
  const spec = entrySpec(entry)
  if (!spec) return false
  if (packageSpecTargets(spec, LEGACY_USAGE_LIMITS_PACKAGE)) return true
  const resolved = specToPath(spec, sourceFile)
  if (!resolved) return false
  const legacyDir = path.join(path.dirname(plugin.dir), "usage-limits")
  const normalized = path.resolve(resolved)
  return normalized === legacyDir || normalized.startsWith(legacyDir + path.sep)
}

function entryMatchesRenamedPlugin(
  entry: unknown,
  plugin: PluginInfo,
  sourceFile?: string,
): boolean {
  const previousId =
    plugin.name === "@macarons/approve-for-me"
      ? "permissions-approve-for-me"
      : plugin.name === "@macarons/web-search"
        ? "websearch"
        : undefined
  const spec = entrySpec(entry)
  if (!previousId || !spec) return false
  if (
    packageSpecTargets(spec, `${PACKAGE_SCOPE}${previousId}`) ||
    packageSpecTargets(spec, `${LEGACY_PACKAGE_SCOPE}${previousId}`) ||
    (previousId === "permissions-approve-for-me" &&
      packageSpecTargets(spec, "opencode-permissions-approve-for-me"))
  )
    return true
  const resolved = specToPath(spec, sourceFile)
  if (!resolved) return false
  const previousDir = path.join(path.dirname(plugin.dir), previousId)
  const normalized = path.resolve(resolved)
  return (
    normalized === previousDir || normalized.startsWith(previousDir + path.sep)
  )
}

function entryMatchesCurrentPlugin(
  entry: unknown,
  plugin: PluginInfo,
  sourceFile?: string,
): boolean {
  const spec = entrySpec(entry)
  if (!spec) return false
  if (packageSpecTargets(spec, plugin.name)) return true
  const resolved = specToPath(spec, sourceFile)
  if (!resolved) return false
  const normalized = path.resolve(resolved)
  return (
    normalized === plugin.dir || normalized.startsWith(plugin.dir + path.sep)
  )
}

/**
 * Does a `plugin` entry reference this plugin, in any install form the READMEs
 * document — a `file://` URL or path to `src/index.ts`/`src/tui.tsx`, the
 * package directory itself, or the scoped package name (with or without a
 * subpath)? `sourceFile` is the config file declaring the entry; with it,
 * `./relative` specs match the way the host resolves them.
 */
export function entryMatchesPlugin(
  entry: unknown,
  plugin: PluginInfo,
  sourceFile?: string,
): boolean {
  if (entryMatchesLegacyPackage(entry, plugin)) return true
  if (entryMatchesRenamedPlugin(entry, plugin, sourceFile)) return true
  if (entryMatchesLegacyCodexLimits(entry, plugin, sourceFile)) return true
  return entryMatchesCurrentPlugin(entry, plugin, sourceFile)
}

/** One active `plugin` entry together with the doc that declares it. */
export type ActiveEntry = { entry: unknown; doc: SourceDoc }

/**
 * The entries the host would actually load for one kind, each paired with its
 * declaring doc, mirroring the merge rules documented above: the collapse
 * contributes the array of the highest file that defines a `plugin` key, and
 * every origin file's array is concatenated on top unconditionally. The doc
 * matters because the host resolves `./relative` specs against the declaring
 * file before merging.
 */
export function activeEntryOrigins(
  docs: SourceDoc[],
  kind: ConfigKind,
): ActiveEntry[] {
  const relevant = docs.filter((doc) => doc.source.kind === kind)
  const collapse = relevant
    .filter((doc) => doc.source.collapseRank !== undefined)
    .sort((a, b) => (a.source.collapseRank ?? 0) - (b.source.collapseRank ?? 0))
  const winner = collapse.filter((doc) => doc.hasPluginKey).at(-1)
  const active: ActiveEntry[] = winner
    ? winner.list.map((entry) => ({ entry, doc: winner }))
    : []
  for (const doc of relevant) {
    if (doc.source.origin && doc !== winner)
      active.push(...doc.list.map((entry) => ({ entry, doc })))
  }
  return active
}

/** The active entries alone, when the declaring file does not matter. */
export function activeEntries(docs: SourceDoc[], kind: ConfigKind): unknown[] {
  return activeEntryOrigins(docs, kind).map((active) => active.entry)
}

/**
 * How a plugin relates to the inventory. `server`/`tui`/`active` mirror what
 * the host would load; `present` also counts masked entries — ones a collapse
 * currently hides, which are one unrelated config edit away from loading
 * again and which an uninstall must sweep. `files` lists every config file
 * with a referencing entry, so status output can say where leftovers live.
 */
export function pluginState(docs: SourceDoc[], plugin: PluginInfo) {
  const matches = (kind: ConfigKind) =>
    activeEntryOrigins(docs, kind).some(({ entry, doc }) =>
      entryMatchesPlugin(entry, plugin, doc.source.file),
    )
  const server = matches("server")
  const tui = matches("tui")
  const files = docs
    .filter((doc) =>
      doc.list.some((entry) =>
        entryMatchesPlugin(entry, plugin, doc.source.file),
      ),
    )
    .map((doc) => doc.source.file)
  return {
    server,
    tui,
    active: server || tui,
    present: files.length > 0,
    files,
  }
}

/**
 * The config-dir file an install writes so the new entry actually takes
 * effect. Server: the highest collapse file that already defines `plugin`
 * (writing a new key into a higher file would mask the defining file's
 * array), else the first-existing of opencode.jsonc/opencode.json/config.json,
 * else a fresh opencode.jsonc. TUI files all concat, so: tui.json, or
 * tui.jsonc when it is the only TUI file kept.
 */
export function installTarget(docs: SourceDoc[], kind: ConfigKind): SourceDoc {
  const dir = docs.filter(
    (doc) => doc.source.kind === kind && doc.source.scope === "config-dir",
  )
  if (kind === "tui") {
    const fallback = dir[0]
    if (fallback === undefined)
      throw new Error("no config-dir tui source to install into")
    return dir.find((doc) => doc.exists) ?? fallback
  }
  const byRankDesc = [...dir].sort(
    (a, b) => (b.source.collapseRank ?? 0) - (a.source.collapseRank ?? 0),
  )
  const fallback = byRankDesc[0]
  if (fallback === undefined)
    throw new Error("no config-dir server source to install into")
  return (
    byRankDesc.find((doc) => doc.exists && doc.hasPluginKey) ??
    byRankDesc.find((doc) => doc.exists) ??
    fallback
  )
}

/** What a plan does to one plugin in one half. */
export type EntryChange = "added" | "removed" | "none" | "unavailable"

/** One plugin's outcome under a plan: the change applied to each half. */
export type PluginPlan = {
  plugin: PluginInfo
  server: EntryChange
  tui: EntryChange
}

/** One file's rewrite under a plan. `doc` is the original, unmutated doc. */
export type DocEdit = { doc: SourceDoc; list: unknown[]; changed: boolean }

/** The full set of config edits a selection implies, ready to write. */
export type Plan = {
  edits: DocEdit[]
  perPlugin: PluginPlan[]
  changed: boolean
}

/**
 * Install-time options to attach to a plugin's newly-added server entry, keyed
 * by plugin name. A plugin present in the map gets a `[spec, options]` tuple
 * instead of a bare string spec — the same form the web-search README documents.
 * Only consulted when no saved server entry exists, so active and masked
 * installs retain their existing options (see the install flow in cli.ts).
 */
export type PluginOptions = Map<string, Record<string, unknown> | undefined>

/**
 * Compute the config edits that make the inventory reflect `selection`
 * (plugin name → wanted). Ticking a plugin ensures each half it ships is
 * ACTIVE — repairing a half-install or a masked entry by writing the install
 * target — while entries elsewhere are left alone. Unticking removes every
 * entry that references the plugin from EVERY inventoried file, so no active
 * (or maskedly latent) origin survives. The input docs are not mutated.
 *
 * `options` carries install-time configuration for freshly-added server
 * entries without a saved declaration. Masked entries retain their complete
 * tuples; conflicting saved declarations throw before a plan can be written.
 * A fresh install without options uses a bare string spec.
 */
export function buildPlan(
  plugins: PluginInfo[],
  selection: Map<string, boolean>,
  docs: SourceDoc[],
  options?: PluginOptions,
): Plan {
  // Working copies: lists and plugin-key presence evolve as each plugin's
  // changes apply, so a later plugin's activation test sees earlier edits.
  const working: SourceDoc[] = docs.map((doc) => ({ ...doc }))
  const perPlugin: PluginPlan[] = []
  for (const plugin of plugins) {
    const want = selection.get(plugin.name) ?? false
    perPlugin.push({
      plugin,
      server: applyDesired(
        working,
        plugin,
        "server",
        want,
        options?.get(plugin.name),
      ),
      tui: applyDesired(working, plugin, "tui", want),
    })
  }
  // Classifier isolation must run after system-prompt injectors, not alphabetically.
  const approval = perPlugin.find(
    ({ plugin }) => plugin.name === "@macarons/approve-for-me",
  )
  if (approval && selection.get(approval.plugin.name)) {
    for (const doc of working) {
      if (doc.source.kind !== "server") continue
      const isApproval = (entry: unknown) =>
        Number(entryMatchesPlugin(entry, approval.plugin, doc.source.file))
      const ordered = doc.list.toSorted((a, b) => isApproval(a) - isApproval(b))
      if (ordered.some((entry, index) => entry !== doc.list[index])) {
        doc.list = ordered
        approval.server = "added"
      }
    }
  }
  const edits: DocEdit[] = working.map((doc, index) => {
    // working is docs.map(...), so index is always in bounds; the ?? doc
    // fallback is unreachable and keeps the element typed as SourceDoc.
    const original = docs[index] ?? doc
    return {
      doc: original,
      list: doc.list,
      changed: doc.list !== original.list,
    }
  })
  return { edits, perPlugin, changed: edits.some((edit) => edit.changed) }
}

function applyDesired(
  working: SourceDoc[],
  plugin: PluginInfo,
  kind: ConfigKind,
  want: boolean,
  options?: Record<string, unknown>,
): EntryChange {
  if (!want) {
    // Sweep every file of this kind — a masked entry is as much an uninstall
    // target as an active one. A file swept down to nothing keeps an explicit
    // `plugin: []` (as the host's own writer does) rather than dropping the
    // key: deleting it would change the collapse winner and could unmask —
    // silently activate — entries a lower file still lists.
    let removed = false
    for (const doc of working) {
      if (doc.source.kind !== kind) continue
      const kept = doc.list.filter(
        (entry) => !entryMatchesPlugin(entry, plugin, doc.source.file),
      )
      if (kept.length === doc.list.length) continue
      doc.list = kept
      removed = true
    }
    return removed ? "removed" : "none"
  }
  const url = kind === "server" ? serverEntryUrl(plugin) : tuiEntryUrl(plugin)
  // When a previous name is present, move every legacy and current
  // declaration for that half to one checkout URL before testing activation.
  // Keeping either package identity beside the migrated URL could load the
  // plugin twice; preserving whole tuples and their order leaves conflicting
  // plugin-owned options to the host's normal last-origin precedence.
  let migrated = false
  if (url) {
    const isLegacyEntry = (entry: unknown, doc: SourceDoc) =>
      entryMatchesLegacyPackage(entry, plugin) ||
      entryMatchesRenamedPlugin(entry, plugin, doc.source.file) ||
      (kind === "tui" &&
        entryMatchesLegacyCodexLimits(entry, plugin, doc.source.file))
    const hasLegacyEntry = working.some(
      (doc) =>
        doc.source.kind === kind &&
        doc.list.some((entry) => isLegacyEntry(entry, doc)),
    )
    if (hasLegacyEntry) {
      migrated = true
      for (const doc of working) {
        if (doc.source.kind !== kind) continue
        let changed = false
        const canonical = doc.list.map((entry) => {
          if (
            !isLegacyEntry(entry, doc) &&
            !entryMatchesCurrentPlugin(entry, plugin, doc.source.file)
          )
            return entry
          if (entrySpec(entry) === url) return entry
          changed = true
          return Array.isArray(entry) ? [url, ...entry.slice(1)] : url
        })
        // Keep cross-document duplicates as latent fallbacks; OpenCode dedupes
        // active origins. Only identical entries in this physical array fold.
        const list = canonical.filter((entry, index) => {
          if (entrySpec(entry) !== url) return true
          return !canonical
            .slice(index + 1)
            .some((later) => isDeepStrictEqual(entry, later))
        })
        if (list.length !== canonical.length) changed = true
        if (changed) doc.list = list
      }
    }
  }
  if (
    activeEntryOrigins(working, kind).some(({ entry, doc }) =>
      entryMatchesPlugin(entry, plugin, doc.source.file),
    )
  )
    return migrated ? "added" : "none"
  // A plugin with no half of this kind cannot get an entry; that is not a change.
  if (!url) return "unavailable"

  // Only server entries can be masked; TUI origins are always active above.
  // Every matching entry is masked here. Carry its full tuple forward rather
  // than reset plugin-owned settings; refuse ambiguity instead of guessing
  // which saved privacy options to discard. Normalize only the plugin spec.
  const saved = working
    .filter((doc) => doc.source.kind === kind)
    .flatMap((doc) =>
      doc.list
        .filter((entry) => entryMatchesPlugin(entry, plugin, doc.source.file))
        .map((entry) => ({
          entry: Array.isArray(entry) ? [url, ...entry.slice(1)] : url,
          file: doc.source.file,
        })),
    )
  const savedEntry = saved[0]?.entry
  if (saved.some(({ entry }) => !isDeepStrictEqual(entry, savedEntry))) {
    const files = [...new Set(saved.map(({ file }) => file))].join(", ")
    throw new Error(
      `Cannot repair ${plugin.id} (${kind}): conflicting masked declarations in ${files}. Keep only the intended configuration or make the declarations identical, then retry. Alternatively, rerun the wizard and untick ${plugin.id} to remove all of its entries instead; no files were changed.`,
    )
  }
  // Fresh options apply only to a new server declaration, never a saved entry
  // or the TUI half. Empty fresh options still produce a bare spec.
  const entry =
    savedEntry ??
    (kind === "server" && options && Object.keys(options).length
      ? [url, options]
      : url)
  const target = installTarget(working, kind)
  target.list = [...target.list, entry]
  target.hasPluginKey = true
  return "added"
}

/**
 * Render a doc's text with its `plugin` array set to `list`. An existing file
 * is edited in place with jsonc-parser, preserving comments, formatting, and
 * every other key exactly (the same mechanism OpenCode's own `mcp add` uses);
 * a new file is rendered as plain JSON with OpenCode's `$schema`.
 */
export function renderPluginDoc(doc: SourceDoc, list: unknown[]): string {
  if (doc.text.trim() === "") {
    const schema =
      doc.source.kind === "server"
        ? OPENCODE_CONFIG_SCHEMA
        : OPENCODE_TUI_SCHEMA
    return `${JSON.stringify({ $schema: schema, plugin: list }, null, 2)}\n`
  }
  const edits = modify(doc.text, ["plugin"], list, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  return applyEdits(doc.text, edits)
}

/**
 * Prove a rendered rewrite round-trips — parseable, and its `plugin` array is
 * exactly the planned list — before anything touches disk, so a latent
 * modify/applyEdits defect reports an installer bug instead of silently
 * corrupting the user's config (audit L-RE3; chosen over `.bak` copies, which
 * would accumulate credential-bearing snapshots).
 */
export function assertRenderedDoc(
  file: string,
  output: string,
  list: unknown[],
): void {
  const errors: ParseError[] = []
  const parsed = parse(output, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  const plugin =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).plugin
      : undefined
  if (errors.length || JSON.stringify(plugin) !== JSON.stringify(list)) {
    throw new Error(
      `rewriting ${file} produced an invalid config — this is an installer bug; no files were changed`,
    )
  }
}

/** One file's rewrite, rendered and round-trip-validated, ready to write. */
export type RenderedEdit = { doc: SourceDoc; output: string }

/**
 * Render and validate every changed edit of a plan BEFORE anything touches
 * disk. A render defect in ANY file aborts the whole run with zero files
 * written, instead of surfacing mid-sweep and leaving a multi-file uninstall
 * half-applied — removed from some origins, still loading from others.
 */
export function renderEdits(edits: DocEdit[]): RenderedEdit[] {
  return edits
    .filter((edit) => edit.changed)
    .map((edit) => {
      const output = renderPluginDoc(edit.doc, edit.list)
      assertRenderedDoc(edit.doc.source.file, output, edit.list)
      return { doc: edit.doc, output }
    })
}

/**
 * Publish one validated rewrite through the suite's writer. Existing files
 * use temp file + rename so a config is never left torn. `preserveMode` is
 * why this is a rewrite rather than a create: an existing file's permission
 * bits carry over, because a 0600-protected config carrying provider
 * credentials must not come out of an install group-readable.
 * Recheck the expected inventory (or just this doc for a standalone write)
 * after staging; new destinations use create-only publication so a file
 * created even after that check cannot be overwritten.
 */
export async function writeRenderedEdit(
  edit: RenderedEdit,
  expectedDocs: SourceSnapshot[] = [edit.doc],
): Promise<void> {
  const file = edit.doc.source.file
  try {
    await assertConfigNotSymlink(file)
  } catch (error) {
    if (error instanceof ConfigSymlinkError) throw error
    throw new SourceConflictError(file, error)
  }
  try {
    await writeTextFile(file, edit.output, {
      preserveMode: edit.doc.exists,
      ifAbsent: !edit.doc.exists,
      beforePublish: () => assertSourceDocsUnchanged(expectedDocs),
    })
  } catch (error) {
    if (!edit.doc.exists && (error as NodeJS.ErrnoException).code === "EEXIST")
      throw new SourceConflictError(file)
    throw error
  }
}

/** Render, validate, and atomically write a single doc's `plugin` array. */
export async function writeSourceDoc(
  doc: SourceDoc,
  list: unknown[],
): Promise<void> {
  for (const edit of renderEdits([{ doc, list, changed: true }])) {
    await writeRenderedEdit(edit)
  }
}

import { createHash } from "node:crypto"
import type { BigIntStats } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  adoptLegacyProjectScopedFile,
  canonicalPath,
  isInside,
  isStoreScope,
  legacyProjectScopedFile,
  literalRecord,
  parseModelRef,
  pathExists,
  patternsOverlap,
  projectFileKey,
  projectScopedFile,
  readJsonFile,
  type StoreScope,
  withStoreLock,
  writeJsonFile,
  writeTextFile,
} from "@macarons/permission-rules"
import {
  applyEdits as applyJsoncEdits,
  type Node as JsoncNode,
  type ParseError as JsoncParseError,
  modify as modifyJsonc,
  parseTree as parseJsoncTree,
} from "jsonc-parser"
import {
  activityFile,
  approvalsJournalFile,
  type Override,
  overrideFile,
  preSlugApprovalsJournalFile,
  readOverride,
  STORAGE_SERVICE,
  sessionModelDirectory,
} from "./persisted-state"
import { normalizeSettings } from "./settings"

export type ProcessingMode = "serial" | "parallel"
export type Settings = {
  enabled?: boolean
  model?: string
  variant?: string
  timeoutMs?: number
  processing?: ProcessingMode
  maxConcurrent?: number
  notify?: boolean
  journal?: boolean
  sweepStale?: boolean
  unattendedDenyMs?: number
  permissions?: Record<string, boolean>
  scope?: StoreScope
}

export type ResolvedSettings = {
  enabled: boolean
  model?: string
  variant?: string
  timeoutMs: number
  processing: ProcessingMode
  maxConcurrent: number
  notify: boolean
  journal: boolean
  sweepStale: boolean
  unattendedDenyMs: number
  permissions: Record<string, boolean>
  scope: StoreScope
}

export const GLOBAL_SETTINGS_BASENAME = "permissions-approve-for-me.json"
export const LEGACY_PROJECT_SETTINGS_BASENAME =
  "permissions-approve-for-me.local.json"
export const DEFAULT_TIMEOUT_MS = 120_000
export const MIN_TIMEOUT_MS = 5_000
export const MAX_TIMEOUT_MS = 600_000
export const DEFAULT_MAX_CONCURRENT = 4
export const MIN_MAX_CONCURRENT = 1
export const MAX_MAX_CONCURRENT = 16
export const DEFAULT_UNATTENDED_DENY_MS = 1_200_000
export const MIN_UNATTENDED_DENY_MS = 60_000
export const MAX_UNATTENDED_DENY_MS = 86_400_000
export const UNATTENDED_DENY_LIMIT = 3
export const DEFAULT_PROCESSING: ProcessingMode = "parallel"

const PACKAGE_NAME = "@macarons/approve-for-me"
const LEGACY_PACKAGE_NAMES = [
  "@macarons/permissions-approve-for-me",
  "@mcolsen-opencode/permissions-approve-for-me",
] as const
const MODULE_ID = "opencode-approve-for-me"
const LEGACY_MODULE_IDS = ["opencode-permissions-approve-for-me"] as const
const PACKAGE_SPEC_NAMES = new Set<string>([
  PACKAGE_NAME,
  ...LEGACY_PACKAGE_NAMES,
  MODULE_ID,
  ...LEGACY_MODULE_IDS,
])

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function projectSettingsFile(configDir: string, projectRoot: string) {
  return projectScopedFile({
    dir: configDir,
    service: STORAGE_SERVICE,
    bucket: "projects",
    projectRoot,
  })
}

export function legacyProjectSettingsFile(projectRoot: string) {
  return path.join(projectRoot, ".opencode", LEGACY_PROJECT_SETTINGS_BASENAME)
}

export function preSlugProjectSettingsFile(
  configDir: string,
  projectRoot: string,
) {
  return legacyProjectScopedFile({
    dir: configDir,
    service: STORAGE_SERVICE,
    bucket: "projects",
    projectRoot,
  })
}

export function escapesProject(roots: string[], pattern: string): boolean {
  const bases = roots.filter(Boolean)
  const first = bases[0]
  if (first === undefined) return false
  const candidate = path.isAbsolute(pattern)
    ? path.normalize(pattern)
    : path.resolve(first, pattern)
  return bases.every((base) => !isInside(base, candidate))
}

export function touchesHostConfig(roots: string[], pattern: string): boolean {
  const bases = roots.filter(Boolean)
  const first = bases[0]
  if (first === undefined) return false
  const candidate = path.isAbsolute(pattern)
    ? path.normalize(pattern)
    : path.resolve(first, pattern)
  return (
    candidate.split(path.sep).includes(".opencode") ||
    ["opencode.json", "opencode.jsonc"].includes(path.basename(candidate))
  )
}

export async function touchesHostConfigResolved(
  roots: string[],
  pattern: string,
): Promise<boolean> {
  if (touchesHostConfig(roots, pattern)) return true
  const first = roots.filter(Boolean)[0]
  if (first === undefined) return false
  const candidate = path.isAbsolute(pattern)
    ? path.normalize(pattern)
    : path.resolve(first, pattern)
  try {
    return touchesHostConfig([first], await canonicalPath(candidate))
  } catch {
    return true
  }
}

type PathPlatform = "darwin" | "win32" | "other"

export function externalBoundaryDirectory(
  pattern: string,
  pathApi: Pick<typeof path, "isAbsolute"> = path,
): string | undefined {
  const normalized = pattern.replaceAll("\\", "/")
  const suffix = "/*"
  if (
    !pathApi.isAbsolute(normalized) ||
    !normalized.endsWith(suffix) ||
    /[*?]/.test(normalized.slice(0, -suffix.length))
  )
    return undefined
  return normalized.slice(0, -suffix.length)
}

export function reservedHostPaths(
  configDir: string,
  stateDir: string,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: PathPlatform = process.platform === "darwin" ||
  process.platform === "win32"
    ? process.platform
    : "other",
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const managed = env.OPENCODE_TEST_MANAGED_CONFIG_DIR?.trim()
  const managedDir = managed
    ? pathApi.resolve(managed)
    : platform === "darwin"
      ? "/Library/Application Support/opencode"
      : platform === "win32"
        ? pathApi.join(env.ProgramData || "C:\\ProgramData", "opencode")
        : "/etc/opencode"
  const explicit = env.OPENCODE_CONFIG?.trim()
  return [
    configDir,
    stateDir,
    pathApi.resolve(dataDir),
    managedDir,
    ...(explicit ? [pathApi.resolve(explicit)] : []),
    ...(platform === "darwin" ? ["/Library/Managed Preferences"] : []),
  ]
}

export type ReservedPathResolution = {
  reserved: boolean
  canonical?: string
}

export async function resolveReservedPath(
  roots: string[],
  protectedRoots: string[],
  pattern: string,
  boundaryPattern = false,
): Promise<ReservedPathResolution> {
  const bases = roots.filter(Boolean)
  const first = bases[0]
  if (first === undefined) return { reserved: true }

  try {
    const lexicalProtectedRoots = protectedRoots.map((protectedRoot) =>
      path.resolve(protectedRoot),
    )
    const canonicalProtectedRoots = await Promise.all(
      lexicalProtectedRoots.map(canonicalPath),
    )
    if (boundaryPattern) {
      const lexicalDirectory = externalBoundaryDirectory(pattern)
      if (lexicalDirectory === undefined) return { reserved: true }
      const canonicalDirectory = await canonicalPath(lexicalDirectory)
      if (
        touchesHostConfig([first], lexicalDirectory) ||
        touchesHostConfig([first], canonicalDirectory)
      )
        return { reserved: true, canonical: canonicalDirectory }
      const lexicalPattern = path.join(lexicalDirectory, "*")
      const canonicalPattern = path.join(canonicalDirectory, "*")
      return {
        reserved:
          lexicalProtectedRoots.some(
            (protectedRoot) =>
              patternsOverlap(lexicalPattern, protectedRoot) ||
              patternsOverlap(lexicalPattern, path.join(protectedRoot, "*")),
          ) ||
          canonicalProtectedRoots.some(
            (protectedRoot) =>
              patternsOverlap(canonicalPattern, protectedRoot) ||
              patternsOverlap(canonicalPattern, path.join(protectedRoot, "*")),
          ),
        canonical: canonicalDirectory,
      }
    }

    if (/[*?]/.test(pattern)) return { reserved: true }
    const lexical = path.isAbsolute(pattern)
      ? path.normalize(pattern)
      : path.resolve(first, pattern)
    if (touchesHostConfig([first], lexical))
      return { reserved: true, canonical: lexical }
    const canonical = await canonicalPath(lexical)
    if (touchesHostConfig([first], canonical))
      return { reserved: true, canonical }
    return {
      reserved:
        lexicalProtectedRoots.some(
          (protectedRoot) =>
            isInside(protectedRoot, lexical) ||
            isInside(lexical, protectedRoot),
        ) ||
        canonicalProtectedRoots.some(
          (protectedRoot) =>
            isInside(protectedRoot, canonical) ||
            isInside(canonical, protectedRoot),
        ),
      canonical,
    }
  } catch {
    return { reserved: true }
  }
}

export async function touchesReservedPathResolved(
  roots: string[],
  protectedRoots: string[],
  pattern: string,
  boundaryPattern = false,
): Promise<boolean> {
  return (
    await resolveReservedPath(roots, protectedRoots, pattern, boundaryPattern)
  ).reserved
}

export type TrustedSettingsPaths = {
  projectRoot: string
  configDir: string
  stateDir: string
  sessionModelsDir: string
  reservedPaths: string[]
  globalSettingsFile: string
  projectSettingsFile: string
  overridePath: string
  activityPath: string
  journalPath: string
  blessPath: string
  preSlugProjectSettingsPath: string
  preSlugJournalPath: string
}

export async function settingsLocalityPaths(
  trusted: TrustedSettingsPaths,
): Promise<string[] | undefined> {
  try {
    const globals = await Promise.all(
      globalConfigCandidates(trusted.configDir).map((file) =>
        canonicalPath(file),
      ),
    )
    if (
      globals.some(
        (file) =>
          !isInside(trusted.configDir, file) ||
          isInside(trusted.projectRoot, file),
      )
    )
      return undefined
    // Files can resolve into different trusted subdirectories through symlinks.
    // Prove their actual parents, not merely a shared config/state ancestor.
    return [
      ...new Set([
        trusted.configDir,
        path.dirname(trusted.globalSettingsFile),
        path.dirname(trusted.projectSettingsFile),
        path.dirname(trusted.preSlugProjectSettingsPath),
        trusted.sessionModelsDir,
        path.dirname(trusted.blessPath),
        path.dirname(trusted.overridePath),
        path.dirname(trusted.activityPath),
        ...globals.map((file) => path.dirname(file)),
        trusted.projectRoot,
      ]),
    ]
  } catch {
    return undefined
  }
}

export function blessFile(stateDir: string, projectRoot: string) {
  return path.join(
    stateDir,
    STORAGE_SERVICE,
    `bless-${projectFileKey(projectRoot)}.json`,
  )
}

export async function resolveTrustedSettingsPaths(
  projectRoot: string,
  configDir: string,
  stateDir: string,
  dataDir: string,
  instanceID: string,
  options: { migrate?: boolean } = {},
): Promise<TrustedSettingsPaths | undefined> {
  try {
    const [realRoot, realConfig, realState] = await Promise.all([
      canonicalPath(projectRoot),
      canonicalPath(configDir),
      canonicalPath(stateDir),
    ])
    const [
      globalSettingsFile,
      projectSettingsFilePath,
      overridePath,
      activityPath,
      journalPath,
      blessPath,
      preSlugProjectSettingsPath,
      preSlugJournalPath,
      sessionModelsDir,
    ] = await Promise.all([
      canonicalPath(path.join(realConfig, GLOBAL_SETTINGS_BASENAME)),
      canonicalPath(projectSettingsFile(realConfig, realRoot)),
      canonicalPath(overrideFile(realState, realRoot, instanceID)),
      canonicalPath(activityFile(realState, realRoot, instanceID)),
      canonicalPath(approvalsJournalFile(realState, realRoot)),
      canonicalPath(blessFile(realState, realRoot)),
      canonicalPath(preSlugProjectSettingsFile(realConfig, realRoot)),
      canonicalPath(preSlugApprovalsJournalFile(realState, realRoot)),
      canonicalPath(sessionModelDirectory(realState)),
    ])
    const files = [
      realConfig,
      realState,
      globalSettingsFile,
      projectSettingsFilePath,
      overridePath,
      activityPath,
      journalPath,
      blessPath,
      preSlugProjectSettingsPath,
      preSlugJournalPath,
      sessionModelsDir,
    ]
    const entersProject = files.some((file) => isInside(realRoot, file))
    const escapesTrustedRoot =
      !isInside(realConfig, globalSettingsFile) ||
      !isInside(realConfig, projectSettingsFilePath) ||
      !isInside(realConfig, preSlugProjectSettingsPath) ||
      !isInside(realState, overridePath) ||
      !isInside(realState, activityPath) ||
      !isInside(realState, journalPath) ||
      !isInside(realState, blessPath) ||
      !isInside(realState, preSlugJournalPath) ||
      !isInside(realState, sessionModelsDir)
    if (entersProject || escapesTrustedRoot) return undefined
    const reservedPaths = [
      ...new Set(reservedHostPaths(realConfig, realState, dataDir)),
    ]
    // The TUI resolves paths before proving locality. Only the server owns
    // startup migration; path strings from an attach cannot authorize it.
    if (options.migrate !== false)
      await Promise.all([
        adoptLegacyProjectScopedFile({
          dir: realConfig,
          service: STORAGE_SERVICE,
          bucket: "projects",
          projectRoot: realRoot,
        }),
        adoptLegacyProjectScopedFile({
          dir: realState,
          service: STORAGE_SERVICE,
          bucket: "approvals",
          projectRoot: realRoot,
        }),
      ])
    return {
      projectRoot: realRoot,
      configDir: realConfig,
      stateDir: realState,
      sessionModelsDir,
      reservedPaths,
      globalSettingsFile,
      projectSettingsFile: projectSettingsFilePath,
      overridePath,
      activityPath,
      journalPath,
      blessPath,
      preSlugProjectSettingsPath,
      preSlugJournalPath,
    }
  } catch {
    return undefined
  }
}

export function parseSettings(value: unknown): Settings | undefined {
  if (!isPlainObject(value)) return undefined
  const settings: Settings = {}
  if (Object.hasOwn(value, "enabled")) {
    if (typeof value.enabled !== "boolean") return undefined
    settings.enabled = value.enabled
  }
  if (Object.hasOwn(value, "model")) {
    if (value.model === null) settings.model = undefined
    else if (typeof value.model !== "string" || !parseModelRef(value.model))
      return undefined
    else settings.model = value.model
  }
  if (Object.hasOwn(value, "variant")) {
    if (value.variant === null || value.variant === "default")
      settings.variant = undefined
    else if (typeof value.variant !== "string" || !value.variant.trim())
      return undefined
    else settings.variant = value.variant
  }
  for (const key of [
    "timeoutMs",
    "maxConcurrent",
    "unattendedDenyMs",
  ] as const) {
    if (!Object.hasOwn(value, key)) continue
    const current = value[key]
    if (current === null) {
      if (key === "maxConcurrent") return undefined
      settings[key] = undefined
    } else if (typeof current !== "number" || !Number.isFinite(current))
      return undefined
    else settings[key] = current
  }
  if (Object.hasOwn(value, "processing")) {
    if (value.processing !== "serial" && value.processing !== "parallel")
      return undefined
    settings.processing = value.processing
  }
  for (const key of ["notify", "journal", "sweepStale"] as const) {
    if (Object.hasOwn(value, key)) {
      if (typeof value[key] !== "boolean") return undefined
      settings[key] = value[key]
    }
  }
  if (Object.hasOwn(value, "permissions")) {
    if (!isPlainObject(value.permissions)) return undefined
    const permissions = literalRecord<boolean>()
    for (const [key, flag] of Object.entries(value.permissions)) {
      if (typeof flag !== "boolean") return undefined
      permissions[key] = flag
    }
    settings.permissions = permissions
  }
  if (Object.hasOwn(value, "scope")) {
    if (!isStoreScope(value.scope)) return undefined
    settings.scope = value.scope
  }
  return settings
}

export async function readSettingsFile(
  file: string,
): Promise<Settings | undefined> {
  return readJsonFile(file, parseSettings, { onMissing: () => ({}) })
}

export function mergeSettings(global: Settings, project: Settings): Settings {
  return {
    ...global,
    ...project,
    ...(global.permissions || project.permissions
      ? {
          permissions: literalRecord([
            ...Object.entries(global.permissions ?? {}),
            ...Object.entries(project.permissions ?? {}),
          ]),
        }
      : {}),
  }
}

export function resolveSettings(merged: Settings): ResolvedSettings {
  return normalizeSettings(merged, {
    timeout: {
      default: DEFAULT_TIMEOUT_MS,
      min: MIN_TIMEOUT_MS,
      max: MAX_TIMEOUT_MS,
    },
    concurrent: {
      default: DEFAULT_MAX_CONCURRENT,
      min: MIN_MAX_CONCURRENT,
      max: MAX_MAX_CONCURRENT,
    },
    unattended: {
      default: DEFAULT_UNATTENDED_DENY_MS,
      min: MIN_UNATTENDED_DENY_MS,
      max: MAX_UNATTENDED_DENY_MS,
    },
  })
}

export const PLUGIN_PACKAGE_NAME = PACKAGE_NAME
export const PLUGIN_MODULE_ID = MODULE_ID

export async function ownPackageDir(): Promise<string | undefined> {
  try {
    const dir = path.resolve(import.meta.dir, "../..")
    // Copied bundles must not claim their surrounding project as this package.
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, "package.json"), "utf8"),
    )
    if (manifest.name !== PACKAGE_NAME) return undefined
    return await canonicalPath(dir)
  } catch {
    return undefined
  }
}

function isPathSpec(spec: string) {
  return (
    spec.startsWith("file://") || spec.startsWith(".") || path.isAbsolute(spec)
  )
}

let ownModulePath: string | undefined

export async function isOwnPluginSpec(
  spec: string,
  configFileDir: string,
  packageDir: string | undefined,
) {
  if (!isPathSpec(spec)) {
    const marker = spec.startsWith("npm:")
      ? 4
      : spec.indexOf("@npm:") > 0
        ? spec.indexOf("@npm:") + 5
        : 0
    const target = spec.slice(marker)
    const at = target.lastIndexOf("@")
    const name = at > 0 ? target.slice(0, at) : target
    return PACKAGE_SPEC_NAMES.has(target) || PACKAGE_SPEC_NAMES.has(name)
  }
  try {
    const target = spec.startsWith("file://")
      ? fileURLToPath(spec)
      : path.isAbsolute(spec)
        ? spec
        : path.resolve(configFileDir, spec)
    const real = await canonicalPath(target)
    // A standalone bundle has no package directory; match only its own file.
    if (!packageDir) {
      ownModulePath ??= await canonicalPath(import.meta.path)
      return real === ownModulePath
    }
    if (!isInside(packageDir, real)) return false
    // Source entries belong to this package only until a nested package boundary.
    for (let dir = real; dir !== packageDir; dir = path.dirname(dir)) {
      try {
        await fs.stat(path.join(dir, "package.json"))
        return false
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "ENOENT" && code !== "ENOTDIR") return false
      }
    }
    return true
  } catch {
    return false
  }
}

export function sha256Hex(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

type ConfigSourceSnapshot = {
  bytes: Buffer
  text: string
  stat: BigIntStats
}

class ConfigSourceConflictError extends Error {}

const sameConfigSourceStat = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs

async function readConfigSourceSnapshot(
  file: string,
): Promise<ConfigSourceSnapshot> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(file, "r")
    const before = await handle.stat({ bigint: true })
    const bytes = await handle.readFile()
    const [after, current] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(file, { bigint: true }),
    ])
    if (
      !before.isFile() ||
      !after.isFile() ||
      !current.isFile() ||
      !sameConfigSourceStat(before, after) ||
      !sameConfigSourceStat(after, current)
    )
      throw new ConfigSourceConflictError()
    if (before.ino <= 0n)
      throw new Error(
        "the global OpenCode config does not provide a stable file identity",
      )
    return { bytes, text: bytes.toString("utf8"), stat: after }
  } catch (error) {
    if (error instanceof ConfigSourceConflictError) throw error
    if (
      ["ENOENT", "ENOTDIR", "ELOOP", "ESTALE"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw new ConfigSourceConflictError()
    throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function assertConfigSourceUnchanged(
  file: string,
  expected: ConfigSourceSnapshot,
) {
  const current = await readConfigSourceSnapshot(file)
  if (
    !sameConfigSourceStat(expected.stat, current.stat) ||
    !expected.bytes.equals(current.bytes)
  )
    throw new ConfigSourceConflictError()
}

function substituteEnvVariables(text: string) {
  return text.replace(
    /\{env:([^}]+)\}/g,
    (_, name: string) => process.env[name] || "",
  )
}

function jsoncNodeValue(node: JsoncNode): unknown {
  if (node.type === "array") return (node.children ?? []).map(jsoncNodeValue)
  if (node.type === "object") {
    const value = literalRecord<unknown>()
    for (const property of node.children ?? []) {
      const [key, child] = property.children ?? []
      if (typeof key?.value !== "string" || !child)
        throw new Error("invalid JSONC object")
      value[key.value] = jsoncNodeValue(child)
    }
    return value
  }
  return node.type === "null" ? null : node.value
}

function parseJsoncLiteral(text: string, errors: JsoncParseError[]): unknown {
  const tree = parseJsoncTree(text, errors, { allowTrailingComma: true })
  if (!tree || errors.length) return undefined
  try {
    return jsoncNodeValue(tree)
  } catch {
    return undefined
  }
}

export type PluginConfigScan = {
  file: string
  hash: string
  definesPlugin: boolean
  hasOwnEntry: boolean
  ownOptions: unknown
  pluginSpecs: string[]
}

export async function scanPluginConfigFile(
  file: string,
  packageDir: string | undefined,
): Promise<PluginConfigScan | "missing" | "unreadable"> {
  let raw: string
  try {
    raw = await fs.readFile(file, "utf8")
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unreadable"
  }
  const substituted = substituteEnvVariables(raw)
  for (const match of substituted.matchAll(/\{file:[^}]+\}/g)) {
    const lineStart = substituted.lastIndexOf("\n", match.index - 1) + 1
    if (!substituted.slice(lineStart, match.index).trimStart().startsWith("//"))
      return "unreadable"
  }
  const errors: JsoncParseError[] = []
  const parsed = parseJsoncLiteral(substituted, errors)
  if (errors.length || !isPlainObject(parsed)) return "unreadable"
  const scan: PluginConfigScan = {
    file,
    hash: sha256Hex(raw),
    definesPlugin: false,
    hasOwnEntry: false,
    ownOptions: undefined,
    pluginSpecs: [],
  }
  if (!Object.hasOwn(parsed, "plugin")) return scan
  scan.definesPlugin = true
  if (!Array.isArray(parsed.plugin)) return "unreadable"
  const dir = path.dirname(file)
  for (const entry of parsed.plugin) {
    let spec: unknown
    let options: unknown
    if (typeof entry === "string") spec = entry
    else if (
      Array.isArray(entry) &&
      (entry.length === 1 || entry.length === 2) &&
      typeof entry[0] === "string"
    ) {
      spec = entry[0]
      options = entry[1]
    } else return "unreadable"
    scan.pluginSpecs.push(spec as string)
    if (await isOwnPluginSpec(spec as string, dir, packageDir)) {
      scan.hasOwnEntry = true
      // Last match wins wholesale; a bare entry also clears earlier options.
      scan.ownOptions = options
    }
  }
  return scan
}

export function globalConfigCandidates(configDir: string) {
  return ["config.json", "opencode.json", "opencode.jsonc"].map((name) =>
    path.join(configDir, name),
  )
}

export async function resolveGlobalCandidate(
  file: string,
  configDir: string,
  projectRoot: string,
): Promise<string | "unsafe"> {
  try {
    const [real, realConfig, realRoot] = await Promise.all([
      canonicalPath(file),
      canonicalPath(configDir),
      canonicalPath(projectRoot),
    ])
    return !isInside(realConfig, real) || isInside(realRoot, real)
      ? "unsafe"
      : real
  } catch {
    return "unsafe"
  }
}

async function winningGlobalPluginScan(
  configDir: string,
  packageDir: string | undefined,
  projectRoot: string,
): Promise<PluginConfigScan | undefined | "unreadable" | "unsafe"> {
  let winner: PluginConfigScan | undefined
  for (const file of globalConfigCandidates(configDir)) {
    const real = await resolveGlobalCandidate(file, configDir, projectRoot)
    if (real === "unsafe") return "unsafe"
    const scan = await scanPluginConfigFile(real, packageDir)
    if (scan === "missing") continue
    if (scan === "unreadable") return "unreadable"
    if (scan.definesPlugin) winner = scan
  }
  return winner
}

export async function readGlobalEntrySettings(
  configDir: string,
  packageDir: string | undefined,
  projectRoot: string,
): Promise<{ settings: Settings; file?: string } | undefined> {
  const winner = await winningGlobalPluginScan(
    configDir,
    packageDir,
    projectRoot,
  )
  if (winner === "unreadable" || winner === "unsafe") return undefined
  if (!winner?.hasOwnEntry) return { settings: {} }
  const settings = parseSettings(winner.ownOptions ?? {})
  return settings ? { settings, file: winner.file } : undefined
}

export function worktreeConfigCandidates(
  directory: string,
  projectRoot: string,
) {
  const root = path.normalize(projectRoot)
  const start = path.normalize(directory)
  const chain: string[] = []
  let dir = start === root || isInside(root, start) ? start : root
  while (true) {
    chain.push(dir)
    if (dir === root) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const candidates: string[] = []
  for (const item of chain.toReversed())
    candidates.push(
      path.join(item, "opencode.json"),
      path.join(item, "opencode.jsonc"),
    )
  for (const item of chain)
    candidates.push(
      path.join(item, ".opencode", "opencode.json"),
      path.join(item, ".opencode", "opencode.jsonc"),
    )
  return candidates
}

export type WorktreeConfigState = {
  files: PluginConfigScan[]
  unreadable: string[]
}

export async function scanWorktreeConfig(
  directory: string,
  projectRoot: string,
  packageDir: string | undefined,
): Promise<WorktreeConfigState> {
  const state: WorktreeConfigState = { files: [], unreadable: [] }
  for (const file of worktreeConfigCandidates(directory, projectRoot)) {
    const scan = await scanPluginConfigFile(file, packageDir)
    if (scan === "missing") continue
    if (scan === "unreadable") state.unreadable.push(file)
    else state.files.push(scan)
  }
  return state
}

export type Blessing = {
  files: Record<string, string>
  policy?: string[]
  at?: number
}

export function parseBlessing(value: unknown): Blessing | undefined {
  if (!isPlainObject(value) || !isPlainObject(value.files)) return undefined
  const files = literalRecord<string>()
  for (const [key, hash] of Object.entries(value.files)) {
    if (typeof hash !== "string") return undefined
    files[key] = hash
  }
  const blessing: Blessing = { files }
  if (Object.hasOwn(value, "policy")) {
    if (
      !Array.isArray(value.policy) ||
      value.policy.some((file) => typeof file !== "string")
    )
      return undefined
    blessing.policy = value.policy as string[]
  }
  if (Object.hasOwn(value, "at") && typeof value.at === "number")
    blessing.at = value.at
  return blessing
}

export async function readBlessing(
  file: string,
): Promise<Blessing | undefined> {
  return readJsonFile(file, parseBlessing, {
    onMissing: () => ({ files: literalRecord() }),
  })
}

export async function writeBlessing(file: string, blessing: Blessing) {
  await writeJsonFile(file, blessing)
}

export type WorktreePolicy =
  | { state: "ok"; settings: Settings; blessedFiles: string[] }
  | { state: "pending"; pending: string[] }
  | { state: "unreadable"; files: string[] }

function isConfigCandidateName(file: string) {
  return ["opencode.json", "opencode.jsonc"].includes(path.basename(file))
}

export function evaluateWorktreePolicy(
  scan: WorktreeConfigState,
  blessing: Blessing,
): WorktreePolicy {
  if (scan.unreadable.length)
    return { state: "unreadable", files: scan.unreadable }
  const gated = scan.files.filter((file) => file.hasOwnEntry)
  const pending = new Set(
    gated
      .filter(
        (file) =>
          !Object.hasOwn(blessing.files, file.file) ||
          blessing.files[file.file] !== file.hash,
      )
      .map((file) => file.file),
  )
  const supplied =
    blessing.policy ?? Object.keys(blessing.files).filter(isConfigCandidateName)
  for (const file of supplied) {
    const scanned = scan.files.find((candidate) => candidate.file === file)
    if (
      !scanned ||
      !Object.hasOwn(blessing.files, file) ||
      blessing.files[file] !== scanned.hash
    )
      pending.add(file)
  }
  if (pending.size) return { state: "pending", pending: [...pending] }
  const last = gated.at(-1)
  if (!last) return { state: "ok", settings: {}, blessedFiles: [] }
  const settings = parseSettings(last.ownOptions ?? {})
  if (!settings) return { state: "unreadable", files: [last.file] }
  return { state: "ok", settings, blessedFiles: gated.map((file) => file.file) }
}

export async function scanSideloadSources(
  directory: string,
  projectRoot: string,
): Promise<{ file: string; hash: string }[]> {
  const root = path.normalize(projectRoot)
  const start = path.normalize(directory)
  const chain: string[] = []
  let dir = start === root || isInside(root, start) ? start : root
  while (true) {
    chain.push(dir)
    if (dir === root) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const found: { file: string; hash: string }[] = []
  for (const item of chain)
    for (const bucket of ["plugin", "plugins"]) {
      const sub = path.join(item, ".opencode", bucket)
      let names: string[]
      try {
        names = await fs.readdir(sub)
      } catch {
        continue
      }
      for (const name of names.toSorted()) {
        if (!name.endsWith(".ts") && !name.endsWith(".js")) continue
        const file = path.join(sub, name)
        try {
          found.push({ file, hash: sha256Hex(await fs.readFile(file, "utf8")) })
        } catch {
          found.push({ file, hash: "unreadable" })
        }
      }
    }
  return found
}

export function unblessedSideloads(
  scan: WorktreeConfigState,
  sources: { file: string; hash: string }[],
  blessing: Blessing,
) {
  const flagged: string[] = []
  for (const file of scan.files)
    if (
      file.pluginSpecs.length &&
      (!Object.hasOwn(blessing.files, file.file) ||
        blessing.files[file.file] !== file.hash)
    )
      flagged.push(file.file)
  for (const source of sources)
    if (
      !Object.hasOwn(blessing.files, source.file) ||
      blessing.files[source.file] !== source.hash
    )
      flagged.push(source.file)
  return [...new Set(flagged)]
}

export type PolicyFault =
  | { kind: "legacy-global"; file: string }
  | { kind: "global-unreadable" }
  | { kind: "bless-unreadable"; file: string }
  | { kind: "worktree-unreadable"; files: string[] }
  | { kind: "worktree-unblessed"; files: string[] }
  | { kind: "project-unreadable" }
export type PolicySnapshot = {
  fault?: PolicyFault
  settings?: Settings
  globalSource?: string
  blessedFiles: string[]
  sideloads: string[]
}

export function projectConfigDisabled() {
  const value = process.env.OPENCODE_DISABLE_PROJECT_CONFIG?.toLowerCase()
  return value === "true" || value === "1"
}

export function hostConfigRoot(worktree: string | undefined) {
  return worktree && worktree !== "/" ? worktree : "/"
}

export async function readPolicySnapshot(input: {
  configDir: string
  projectSettingsFile: string
  blessPath: string
  legacyGlobalFile: string
  directory: string
  projectRoot: string
  configRoot: string
  packageDir: string | undefined
}): Promise<PolicySnapshot> {
  const disabled = projectConfigDisabled()
  const [legacyGlobal, global, blessing, worktree, sources, project] =
    await Promise.all([
      pathExists(input.legacyGlobalFile),
      readGlobalEntrySettings(
        input.configDir,
        input.packageDir,
        input.projectRoot,
      ),
      readBlessing(input.blessPath),
      disabled
        ? { files: [], unreadable: [] }
        : scanWorktreeConfig(
            input.directory,
            input.configRoot,
            input.packageDir,
          ),
      disabled ? [] : scanSideloadSources(input.directory, input.configRoot),
      readSettingsFile(input.projectSettingsFile),
    ])
  const snapshot: PolicySnapshot = {
    blessedFiles: [],
    sideloads: blessing ? unblessedSideloads(worktree, sources, blessing) : [],
  }
  if (legacyGlobal !== false) {
    snapshot.fault =
      legacyGlobal === undefined
        ? { kind: "global-unreadable" }
        : { kind: "legacy-global", file: input.legacyGlobalFile }
    return snapshot
  }
  if (!global) {
    snapshot.fault = { kind: "global-unreadable" }
    return snapshot
  }
  if (!blessing) {
    snapshot.fault = { kind: "bless-unreadable", file: input.blessPath }
    return snapshot
  }
  const policy = evaluateWorktreePolicy(worktree, blessing)
  if (policy.state === "unreadable") {
    snapshot.fault = { kind: "worktree-unreadable", files: policy.files }
    return snapshot
  }
  if (policy.state === "pending") {
    snapshot.fault = { kind: "worktree-unblessed", files: policy.pending }
    return snapshot
  }
  if (!project) {
    snapshot.fault = { kind: "project-unreadable" }
    return snapshot
  }
  snapshot.settings = mergeSettings(
    mergeSettings(global.settings, policy.settings),
    project,
  )
  snapshot.globalSource = global.file
  snapshot.blessedFiles = policy.blessedFiles
  return snapshot
}

type GlobalEntryPatchResult =
  | "ok"
  | "corrupt"
  | "no-entry"
  | "shadowed"
  | "unsafe"
  | "conflict"

const GLOBAL_CONFIG_PATCH_ATTEMPTS = 3
const GLOBAL_CONFIG_PATCH_BACKOFF_MS = 25

async function patchGlobalEntryOptionsOnce(
  configDir: string,
  packageDir: string | undefined,
  projectRoot: string,
  patch: Record<string, unknown>,
): Promise<Exclude<GlobalEntryPatchResult, "conflict">> {
  const scan = await winningGlobalPluginScan(configDir, packageDir, projectRoot)
  if (scan === "unreadable") return "corrupt"
  if (scan === "unsafe") return "unsafe"
  if (!scan) return "no-entry"
  if (!scan.hasOwnEntry) {
    for (const file of globalConfigCandidates(configDir)) {
      const real = await resolveGlobalCandidate(file, configDir, projectRoot)
      if (real === "unsafe") return "unsafe"
      if (real === scan.file) break
      const earlier = await scanPluginConfigFile(real, packageDir)
      if (typeof earlier === "object" && earlier.hasOwnEntry) return "shadowed"
    }
    return "no-entry"
  }
  const winner = scan.file
  return await withStoreLock(
    winner,
    async (lease) => {
      const source = await readConfigSourceSnapshot(winner)
      if (sha256Hex(source.text) !== scan.hash)
        throw new ConfigSourceConflictError()
      let text = source.text
      const errors: JsoncParseError[] = []
      const parsed = parseJsoncLiteral(text, errors)
      if (
        errors.length ||
        !isPlainObject(parsed) ||
        !Array.isArray(parsed.plugin)
      )
        return "corrupt"
      const dir = path.dirname(winner)
      let index = -1
      let bare = false
      let options: unknown
      for (let i = 0; i < parsed.plugin.length; i++) {
        const entry: unknown = parsed.plugin[i]
        const spec =
          typeof entry === "string"
            ? entry
            : Array.isArray(entry) && typeof entry[0] === "string"
              ? entry[0]
              : undefined
        if (spec === undefined) return "corrupt"
        if (
          await isOwnPluginSpec(substituteEnvVariables(spec), dir, packageDir)
        ) {
          index = i
          bare = typeof entry === "string"
          options = Array.isArray(entry) ? entry[1] : undefined
        }
      }
      if (index < 0) return "no-entry"
      const formatting = { insertSpaces: true, tabSize: 2 }
      if (bare) {
        const spec = parsed.plugin[index] as string
        const next = literalRecord<unknown>()
        for (const [key, value] of Object.entries(patch))
          if (value !== undefined) next[key] = value
        text = applyJsoncEdits(
          text,
          modifyJsonc(text, ["plugin", index], [spec, next], {
            formattingOptions: formatting,
          }),
        )
      } else {
        if (options !== undefined && !isPlainObject(options)) return "corrupt"
        for (const [key, value] of Object.entries(patch))
          text = applyJsoncEdits(
            text,
            modifyJsonc(text, ["plugin", index, 1, key], value, {
              formattingOptions: formatting,
            }),
          )
      }
      await writeTextFile(winner, text, {
        preserveMode: true,
        beforePublish: async () => {
          await assertConfigSourceUnchanged(winner, source)
          await lease.assertHeld()
        },
      })
      return "ok"
    },
    {
      label: "the global OpenCode config",
      heartbeatMs: 1_000,
    },
  )
}

export async function patchGlobalEntryOptions(
  configDir: string,
  packageDir: string | undefined,
  projectRoot: string,
  patch: Record<string, unknown>,
): Promise<GlobalEntryPatchResult> {
  for (let attempt = 0; attempt < GLOBAL_CONFIG_PATCH_ATTEMPTS; attempt++) {
    try {
      return await patchGlobalEntryOptionsOnce(
        configDir,
        packageDir,
        projectRoot,
        patch,
      )
    } catch (error) {
      if (!(error instanceof ConfigSourceConflictError)) throw error
      if (attempt + 1 < GLOBAL_CONFIG_PATCH_ATTEMPTS) {
        const baseMs = GLOBAL_CONFIG_PATCH_BACKOFF_MS * 2 ** attempt
        const delayMs = baseMs + Math.floor(Math.random() * baseMs)
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
  return "conflict"
}

export type EffectiveSettings = {
  settings: ResolvedSettings
  override?: Override
}

export async function readEffectiveSettings(input: {
  paths: Pick<
    TrustedSettingsPaths,
    | "projectRoot"
    | "configDir"
    | "globalSettingsFile"
    | "projectSettingsFile"
    | "blessPath"
    | "overridePath"
    | "preSlugProjectSettingsPath"
  >
  legacyProjectFile: string
  directory: string
  configRoot: string
  packageDir: string | undefined
}): Promise<EffectiveSettings | undefined> {
  const { paths } = input
  const [legacyExists, trustedProjectExists, preSlugSettingsExists] =
    await Promise.all([
      pathExists(input.legacyProjectFile),
      pathExists(paths.projectSettingsFile),
      pathExists(paths.preSlugProjectSettingsPath),
    ])
  if (
    legacyExists === undefined ||
    trustedProjectExists === undefined ||
    preSlugSettingsExists === undefined
  )
    return undefined
  if (legacyExists && !trustedProjectExists) return undefined
  if (preSlugSettingsExists) return undefined
  const snapshot = await readPolicySnapshot({
    configDir: paths.configDir,
    projectSettingsFile: paths.projectSettingsFile,
    blessPath: paths.blessPath,
    legacyGlobalFile: paths.globalSettingsFile,
    directory: input.directory,
    projectRoot: paths.projectRoot,
    configRoot: input.configRoot,
    packageDir: input.packageDir,
  })
  if (snapshot.fault) return undefined
  const settings = resolveSettings(snapshot.settings ?? {})
  let enabled = settings.enabled
  const override = await readOverride(paths.overridePath)
  if (override) enabled = override.enabled
  return enabled ? { settings, override } : undefined
}

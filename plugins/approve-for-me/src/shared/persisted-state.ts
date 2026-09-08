import crypto from "node:crypto"
import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import {
  canonicalPath,
  isInside,
  legacyProjectScopedFile,
  OWNER_ONLY_WRITE_MODES,
  parseModelRef,
  projectFileKey,
  projectScopedFile,
  readJsonFile,
  withStoreLock,
  writeJsonFile,
} from "@macarons/permission-rules"
import { RISK_LEVELS, type RiskLevel } from "./classifier-policy"

export const SERVICE = "approve-for-me"
// Preserve shipped policy, state, and cross-process identities across the rename.
export const STORAGE_SERVICE = "permissions-approve-for-me"

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNonemptyTrimmedString = (value: unknown): value is string =>
  typeof value === "string" && !!value && value === value.trim()

export type SessionModelRecord = {
  version: 1
  rootSessionID: string
  revision: string
  mode: "inherit" | "override"
  model: string | null
  variant: string | null
}

export type SessionModelReadResult =
  | { status: "missing" }
  | { status: "valid"; record: SessionModelRecord }
  | { status: "invalid" }

export function sessionModelDirectory(stateDir: string) {
  return path.join(stateDir, STORAGE_SERVICE, "session-models")
}

export function sessionModelFile(
  sessionModelsDir: string,
  rootSessionID: string,
) {
  if (!isNonemptyTrimmedString(rootSessionID))
    throw new Error("invalid root session ID")
  const key = crypto.createHash("sha256").update(rootSessionID).digest("hex")
  return path.join(sessionModelsDir, `${key}.json`)
}

export async function resolveTrustedSessionModelFile(
  sessionModelsDir: string,
  rootSessionID: string,
): Promise<string | undefined> {
  const lexical = sessionModelFile(sessionModelsDir, rootSessionID)
  try {
    try {
      if ((await fs.lstat(lexical)).isSymbolicLink()) return undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const canonical = await canonicalPath(lexical)
    return isInside(sessionModelsDir, canonical) ? canonical : undefined
  } catch {
    return undefined
  }
}

async function trustedSessionModelParent(
  file: string,
): Promise<{ path: string; dev: bigint; ino: bigint }> {
  const parentPath = path.resolve(path.dirname(file))
  const parent = await fs.lstat(parentPath, { bigint: true })
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.ino <= 0n ||
    (await fs.realpath(parentPath)) !== parentPath
  )
    throw new Error("session model parent is not trusted")
  return { path: parentPath, dev: parent.dev, ino: parent.ino }
}

export function sessionModelOpenFlags(constants: {
  O_RDONLY?: number
  O_NOFOLLOW?: number
  O_NONBLOCK?: number
}): number | undefined {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants
  return typeof O_RDONLY === "number" &&
    typeof O_NOFOLLOW === "number" &&
    O_NOFOLLOW !== 0 &&
    typeof O_NONBLOCK === "number"
    ? O_RDONLY | O_NOFOLLOW | O_NONBLOCK
    : undefined
}

const SESSION_MODEL_OPEN_FLAGS = sessionModelOpenFlags(fsConstants)

export async function sessionModelCapability(
  sessionModelsDir: string,
): Promise<{ available: true } | { available: false; reason: string }> {
  if (SESSION_MODEL_OPEN_FLAGS === undefined) {
    return {
      available: false,
      reason:
        "the platform does not provide a working O_NOFOLLOW file-open flag",
    }
  }
  let candidate = path.resolve(sessionModelsDir)
  for (;;) {
    try {
      const stat = await fs.lstat(candidate, { bigint: true })
      if (stat.ino <= 0n) {
        return {
          available: false,
          reason:
            "the state filesystem does not provide stable inode identities",
        }
      }
      return { available: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          available: false,
          reason: "the state filesystem could not be inspected safely",
        }
      }
      const parent = path.dirname(candidate)
      if (parent === candidate) {
        return {
          available: false,
          reason: "the state filesystem could not be inspected safely",
        }
      }
      candidate = parent
    }
  }
}

const sameFileIdentity = (
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
) =>
  left.ino > 0n &&
  right.ino > 0n &&
  left.dev === right.dev &&
  left.ino === right.ino

function parseSessionModelRecord(
  value: unknown,
  rootSessionID: string,
): SessionModelRecord | undefined {
  if (!isPlainObject(value)) return undefined
  const keys = Object.keys(value)
  if (
    keys.length !== 6 ||
    !keys.every((key) =>
      [
        "version",
        "rootSessionID",
        "revision",
        "mode",
        "model",
        "variant",
      ].includes(key),
    )
  )
    return undefined
  const { version, revision, mode, model, variant } = value
  if (
    version !== 1 ||
    !isNonemptyTrimmedString(rootSessionID) ||
    !isNonemptyTrimmedString(value.rootSessionID) ||
    value.rootSessionID !== rootSessionID
  )
    return undefined
  if (!isNonemptyTrimmedString(revision)) return undefined
  if (mode !== "inherit" && mode !== "override") return undefined
  if (mode === "inherit") {
    if (model !== null || variant !== null) return undefined
  } else if (model === null) {
    if (variant !== null) return undefined
  } else if (typeof model !== "string" || !parseModelRef(model)) {
    return undefined
  }
  if (
    variant !== null &&
    (typeof variant !== "string" || !variant || variant !== variant.trim())
  )
    return undefined
  return { version, rootSessionID, revision, mode, model, variant }
}

const sameSessionModelRecord = (
  left: SessionModelRecord,
  right: SessionModelRecord,
) =>
  left.version === right.version &&
  left.rootSessionID === right.rootSessionID &&
  left.revision === right.revision &&
  left.mode === right.mode &&
  left.model === right.model &&
  left.variant === right.variant

const SESSION_MODEL_BASENAME = /^[0-9a-f]{64}\.json$/

export async function readSessionModel(
  file: string,
  rootSessionID: string,
): Promise<SessionModelReadResult> {
  let invalid = false
  let corrupt = false
  const record = await readJsonFile(
    file,
    (value) => {
      const parsed = parseSessionModelRecord(value, rootSessionID)
      if (!parsed) invalid = true
      return parsed
    },
    {
      onCorrupt: () => {
        corrupt = true
      },
    },
  )
  if (record) return { status: "valid", record }
  return invalid || corrupt ? { status: "invalid" } : { status: "missing" }
}

export async function readTrustedSessionModel(
  sessionModelsDir: string,
  rootSessionID: string,
): Promise<SessionModelReadResult> {
  const trustedDir = path.resolve(sessionModelsDir)
  const lexical = sessionModelFile(trustedDir, rootSessionID)
  if (SESSION_MODEL_OPEN_FLAGS === undefined) {
    try {
      if ((await canonicalPath(trustedDir)) !== trustedDir)
        return { status: "invalid" }
      await fs.lstat(lexical)
      return { status: "invalid" }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { status: "missing" }
        : { status: "invalid" }
    }
  }
  let file: fs.FileHandle | undefined
  try {
    try {
      file = await fs.open(lexical, SESSION_MODEL_OPEN_FLAGS)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        return { status: "invalid" }
      // Missing is safe only while the trusted parent is still canonical and
      // the lexical entry is still absent (not a dangling symlink or a race).
      if ((await canonicalPath(trustedDir)) !== trustedDir)
        return { status: "invalid" }
      try {
        await fs.lstat(lexical)
        return { status: "invalid" }
      } catch (lstatError) {
        return (lstatError as NodeJS.ErrnoException).code === "ENOENT"
          ? { status: "missing" }
          : { status: "invalid" }
      }
    }

    const opened = await file.stat({ bigint: true })
    if (!opened.isFile() || opened.ino <= 0n) return { status: "invalid" }

    const currentDir = await fs.realpath(trustedDir)
    if (currentDir !== trustedDir) return { status: "invalid" }
    const canonical = await fs.realpath(lexical)
    if (!isInside(currentDir, canonical)) return { status: "invalid" }

    // Validate the pathname after opening, then bind both its lexical and
    // canonical identities to the descriptor that will actually be read.
    const current = await fs.lstat(lexical, { bigint: true })
    const canonicalCurrent =
      canonical === lexical
        ? current
        : await fs.lstat(canonical, { bigint: true })
    if (
      !current.isFile() ||
      !canonicalCurrent.isFile() ||
      !sameFileIdentity(opened, current) ||
      !sameFileIdentity(opened, canonicalCurrent)
    )
      return { status: "invalid" }

    const value = JSON.parse(await file.readFile({ encoding: "utf8" }))
    const record = parseSessionModelRecord(value, rootSessionID)
    return record ? { status: "valid", record } : { status: "invalid" }
  } catch {
    return { status: "invalid" }
  } finally {
    await file?.close().catch(() => {})
  }
}

export async function writeSessionModel(
  file: string,
  record: SessionModelRecord,
) {
  if (!parseSessionModelRecord(record, record.rootSessionID))
    throw new Error("invalid session model record")
  const trustedDir = path.resolve(path.dirname(file))
  await fs.mkdir(trustedDir, { recursive: true, mode: 0o700 })
  await withStoreLock(
    file,
    async (lease) => {
      const parent = await trustedSessionModelParent(file)
      await writeJsonFile(file, record, {
        fileMode: 0o600,
        dirMode: 0o700,
        beforePublish: async () => {
          const current = await fs.lstat(parent.path, { bigint: true })
          if (
            !current.isDirectory() ||
            !sameFileIdentity(parent, current) ||
            (await fs.realpath(parent.path)) !== parent.path
          )
            throw new Error("session model parent is no longer trusted")
          await lease.assertHeld()
        },
      })
    },
    {
      label: "the session model record",
    },
  )
}

export async function listTrustedSessionModels(
  sessionModelsDir: string,
): Promise<SessionModelRecord[]> {
  if (SESSION_MODEL_OPEN_FLAGS === undefined) return []
  const trustedDir = path.resolve(sessionModelsDir)
  try {
    const before = await fs.lstat(trustedDir, { bigint: true })
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      before.ino <= 0n ||
      (await fs.realpath(trustedDir)) !== trustedDir
    )
      return []
    const entries = await fs.readdir(trustedDir, { withFileTypes: true })
    const after = await fs.lstat(trustedDir, { bigint: true })
    if (
      !after.isDirectory() ||
      !sameFileIdentity(before, after) ||
      (await fs.realpath(trustedDir)) !== trustedDir
    )
      return []

    const records: SessionModelRecord[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !SESSION_MODEL_BASENAME.test(entry.name)) continue
      const lexical = path.join(trustedDir, entry.name)
      let file: fs.FileHandle | undefined
      try {
        file = await fs.open(lexical, SESSION_MODEL_OPEN_FLAGS)
        const opened = await file.stat({ bigint: true })
        if (!opened.isFile() || opened.ino <= 0n) continue
        if ((await fs.realpath(trustedDir)) !== trustedDir) continue
        const canonical = await fs.realpath(lexical)
        if (!isInside(trustedDir, canonical)) continue
        const current = await fs.lstat(lexical, { bigint: true })
        const canonicalCurrent =
          canonical === lexical
            ? current
            : await fs.lstat(canonical, { bigint: true })
        if (
          !current.isFile() ||
          !canonicalCurrent.isFile() ||
          !sameFileIdentity(opened, current) ||
          !sameFileIdentity(opened, canonicalCurrent)
        )
          continue
        const value = JSON.parse(await file.readFile({ encoding: "utf8" }))
        const rootSessionID = isPlainObject(value)
          ? value.rootSessionID
          : undefined
        if (!isNonemptyTrimmedString(rootSessionID)) continue
        const record = parseSessionModelRecord(value, rootSessionID)
        if (!record || sessionModelFile(trustedDir, rootSessionID) !== lexical)
          continue
        records.push(record)
      } catch {
        // Malformed, special, raced, and unreadable entries are retained.
      } finally {
        await file?.close().catch(() => {})
      }
    }
    return records
  } catch {
    return []
  }
}

export async function clearTrustedSessionModelIfUnchanged(
  sessionModelsDir: string,
  expected: SessionModelRecord,
): Promise<boolean> {
  if (
    SESSION_MODEL_OPEN_FLAGS === undefined ||
    !parseSessionModelRecord(expected, expected.rootSessionID)
  )
    return false
  const trustedDir = path.resolve(sessionModelsDir)
  const lexical = sessionModelFile(trustedDir, expected.rootSessionID)
  try {
    await trustedSessionModelParent(lexical)
  } catch {
    return false
  }
  return await withStoreLock(
    lexical,
    async (lease) => {
      let file: fs.FileHandle | undefined
      try {
        try {
          file = await fs.open(lexical, SESSION_MODEL_OPEN_FLAGS)
          const opened = await file.stat({ bigint: true })
          if (!opened.isFile() || opened.ino <= 0n) return false
          const value = JSON.parse(await file.readFile({ encoding: "utf8" }))
          const record = parseSessionModelRecord(value, expected.rootSessionID)
          if (!record || !sameSessionModelRecord(record, expected)) return false

          const canonical = await fs.realpath(lexical)
          if (!isInside(trustedDir, canonical)) return false
          const current = await fs.lstat(lexical, { bigint: true })
          const canonicalCurrent =
            canonical === lexical
              ? current
              : await fs.lstat(canonical, { bigint: true })
          if (
            !current.isFile() ||
            !canonicalCurrent.isFile() ||
            !sameFileIdentity(opened, current) ||
            !sameFileIdentity(opened, canonicalCurrent)
          )
            return false
          // The record revision and pathname identity were checked while this
          // lease excluded every cooperating writer. Re-assert ownership at the
          // destructive edge so a stale takeover can never delete its successor.
          if ((await fs.realpath(path.dirname(lexical))) !== trustedDir)
            return false
        } catch {
          return false
        }
        await lease.assertHeld()
        try {
          await fs.unlink(lexical)
          return true
        } catch {
          return false
        }
      } finally {
        await file?.close().catch(() => {})
      }
    },
    {
      label: "the session model record",
    },
  )
}

export async function clearSessionModel(file: string) {
  await fs.rm(file, { force: true })
}

export async function clearTrustedSessionModel(
  sessionModelsDir: string,
  rootSessionID: string,
): Promise<boolean> {
  const trustedDir = path.resolve(sessionModelsDir)
  const lexical = sessionModelFile(trustedDir, rootSessionID)
  try {
    // unlink() removes a final symlink itself. Pinning its parent immediately
    // beforehand prevents a persistent directory redirect from escaping state.
    if ((await fs.realpath(path.dirname(lexical))) !== trustedDir) return false
    await fs.unlink(lexical)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
  }
}

export type Override = { enabled: boolean; at?: number }
const INSTANCE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function overrideFile(
  stateDir: string,
  projectRoot: string,
  instanceID: string,
) {
  if (typeof instanceID !== "string" || !INSTANCE_UUID.test(instanceID))
    throw new Error("invalid instance ID")
  return path.join(
    stateDir,
    STORAGE_SERVICE,
    `override-${projectFileKey(projectRoot)}-${instanceID}.json`,
  )
}

export async function readOverride(
  file: string,
): Promise<Override | undefined> {
  let corrupt = false
  const parsed = await readJsonFile<Override>(
    file,
    (value) =>
      isPlainObject(value) && typeof value.enabled === "boolean"
        ? {
            enabled: value.enabled,
            ...(typeof value.at === "number" && Number.isFinite(value.at)
              ? { at: value.at }
              : {}),
          }
        : { enabled: false },
    {
      onCorrupt: () => {
        corrupt = true
      },
    },
  )
  return parsed ?? (corrupt ? { enabled: false } : undefined)
}

export async function writeOverride(file: string, override: Override) {
  await writeJsonFile(file, override)
}

export async function clearOverride(file: string) {
  await fs.rm(file, { force: true })
}

export type ActivityState =
  | "evaluating"
  | "approved"
  | "surfaced"
  | "undecided"
  | "skipped"
  | "denied"
export type ActivityEntry = {
  state: ActivityState
  reason?: string
  time: number
  denyAt?: number
}
export type Activity = Record<string, ActivityEntry>
export type ServerStatus = {
  state: "ready" | "paused"
  reason?: string
  time: number
}
export type ActivityFile = { server?: ServerStatus; requests: Activity }

const ACTIVITY_STATES: readonly string[] = [
  "evaluating",
  "approved",
  "surfaced",
  "undecided",
  "skipped",
  "denied",
]

export function activityFile(
  stateDir: string,
  projectRoot: string,
  instanceID: string,
) {
  if (typeof instanceID !== "string" || !INSTANCE_UUID.test(instanceID))
    throw new Error("invalid instance ID")
  return path.join(
    stateDir,
    STORAGE_SERVICE,
    `activity-${projectFileKey(projectRoot)}-${instanceID}.json`,
  )
}

function parseServerStatus(value: unknown): ServerStatus | undefined {
  if (!isPlainObject(value)) return undefined
  const { state, reason, time } = value
  if (state !== "ready" && state !== "paused") return undefined
  if (typeof time !== "number" || !Number.isFinite(time)) return undefined
  if (reason !== undefined && typeof reason !== "string") return undefined
  return { state, ...(reason ? { reason } : {}), time }
}

function parseActivityFile(parsed: unknown): ActivityFile | undefined {
  if (!isPlainObject(parsed) || !isPlainObject(parsed.requests))
    return undefined
  const activity: Activity = {}
  for (const [id, value] of Object.entries(parsed.requests)) {
    if (!isPlainObject(value)) continue
    const { state, reason, time, denyAt } = value
    if (typeof state !== "string" || !ACTIVITY_STATES.includes(state)) continue
    if (typeof time !== "number" || !Number.isFinite(time)) continue
    if (reason !== undefined && typeof reason !== "string") continue
    if (
      denyAt !== undefined &&
      (typeof denyAt !== "number" || !Number.isFinite(denyAt))
    )
      continue
    activity[id] = {
      state: state as ActivityState,
      ...(reason ? { reason } : {}),
      time,
      ...(denyAt !== undefined ? { denyAt } : {}),
    }
  }
  const server = parseServerStatus(parsed.server)
  return { ...(server ? { server } : {}), requests: activity }
}

export async function readActivity(
  file: string,
): Promise<ActivityFile | undefined> {
  return readJsonFile(file, parseActivityFile, {
    onMissing: () => ({ requests: {} }),
  })
}

export const ACTIVITY_TTL_MS = 10 * 60_000
export const ACTIVITY_MAX_ENTRIES = 50
export const ACTIVITY_REASON_MAX = 400

export function pruneActivity(
  entries: Map<string, ActivityEntry>,
  now: number,
) {
  const liveDeadline = (entry: ActivityEntry) =>
    entry.denyAt !== undefined && entry.denyAt > now
  for (const [id, entry] of entries)
    if (!liveDeadline(entry) && now - entry.time > ACTIVITY_TTL_MS)
      entries.delete(id)
  if (entries.size <= ACTIVITY_MAX_ENTRIES) return
  const byAge = [...entries.entries()].sort(
    (a, b) =>
      Number(liveDeadline(a[1])) - Number(liveDeadline(b[1])) ||
      a[1].time - b[1].time,
  )
  for (const [id] of byAge.slice(0, entries.size - ACTIVITY_MAX_ENTRIES))
    entries.delete(id)
}

export async function writeActivity(file: string, activity: ActivityFile) {
  await writeJsonFile(file, activity, OWNER_ONLY_WRITE_MODES)
}

export async function clearActivity(file: string) {
  await fs.rm(file, { force: true })
}

export type ApprovalEntry = {
  count: number
  first: number
  last: number
  risks: Partial<Record<RiskLevel, number>>
}
export type Approvals = Record<string, Record<string, ApprovalEntry>>
export type ApprovalsJournal = {
  root?: string
  storeFile?: string
  approvals: Approvals
}

export function approvalsJournalFile(stateDir: string, projectRoot: string) {
  return projectScopedFile({
    dir: stateDir,
    service: STORAGE_SERVICE,
    bucket: "approvals",
    projectRoot,
  })
}

export function preSlugApprovalsJournalFile(
  stateDir: string,
  projectRoot: string,
) {
  return legacyProjectScopedFile({
    dir: stateDir,
    service: STORAGE_SERVICE,
    bucket: "approvals",
    projectRoot,
  })
}

function bareRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function setOwn<T>(record: Record<string, T>, key: string, value: T) {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

function parseApprovalEntry(value: unknown): ApprovalEntry | undefined {
  if (!isPlainObject(value)) return undefined
  const { count, first, last, risks } = value
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0)
    return undefined
  if (typeof first !== "number" || !Number.isFinite(first)) return undefined
  if (typeof last !== "number" || !Number.isFinite(last)) return undefined
  const grades: ApprovalEntry["risks"] = {}
  if (risks !== undefined) {
    if (!isPlainObject(risks)) return undefined
    for (const [grade, tally] of Object.entries(risks)) {
      if (!(RISK_LEVELS as readonly string[]).includes(grade)) continue
      if (typeof tally !== "number" || !Number.isFinite(tally) || tally < 0)
        return undefined
      grades[grade as RiskLevel] = tally
    }
  }
  return { count, first, last, risks: grades }
}

function parseApprovalsJournal(parsed: unknown): ApprovalsJournal | undefined {
  if (!isPlainObject(parsed) || !isPlainObject(parsed.approvals))
    return undefined
  const { root, storeFile, approvals } = parsed
  if (root !== undefined && typeof root !== "string") return undefined
  if (storeFile !== undefined && typeof storeFile !== "string") return undefined
  const journal: ApprovalsJournal = {
    ...(typeof root === "string" ? { root } : {}),
    ...(typeof storeFile === "string" ? { storeFile } : {}),
    approvals: bareRecord(),
  }
  for (const [permission, patterns] of Object.entries(approvals)) {
    if (!isPlainObject(patterns)) continue
    for (const [pattern, value] of Object.entries(patterns)) {
      const entry = parseApprovalEntry(value)
      if (!entry) continue
      let forPermission = Object.hasOwn(journal.approvals, permission)
        ? journal.approvals[permission]
        : undefined
      if (!forPermission) {
        forPermission = bareRecord()
        setOwn(journal.approvals, permission, forPermission)
      }
      setOwn(forPermission, pattern, entry)
    }
  }
  return journal
}

export async function readApprovalsJournal(
  file: string,
): Promise<ApprovalsJournal | undefined> {
  return readJsonFile(file, parseApprovalsJournal, {
    onMissing: () => ({ approvals: bareRecord() }),
  })
}

export const APPROVALS_MAX_PATTERNS = 400

export function pruneApprovals(approvals: Approvals) {
  const all: { permission: string; pattern: string; last: number }[] = []
  for (const [permission, patterns] of Object.entries(approvals))
    for (const [pattern, entry] of Object.entries(patterns))
      all.push({ permission, pattern, last: entry.last })
  if (all.length <= APPROVALS_MAX_PATTERNS) return
  all.sort((a, b) => a.last - b.last)
  for (const { permission, pattern } of all.slice(
    0,
    all.length - APPROVALS_MAX_PATTERNS,
  )) {
    const patterns = approvals[permission]
    if (!patterns) continue
    delete patterns[pattern]
    if (!Object.keys(patterns).length) delete approvals[permission]
  }
}

export function emptyApprovals(): Approvals {
  return bareRecord()
}

export function recordApproval(
  approvals: Approvals,
  permission: string,
  patterns: string[],
  risk: RiskLevel,
  now: number,
) {
  for (const pattern of new Set(patterns)) {
    let forPermission = Object.hasOwn(approvals, permission)
      ? approvals[permission]
      : undefined
    if (!forPermission) {
      forPermission = bareRecord()
      setOwn(approvals, permission, forPermission)
    }
    const entry = (Object.hasOwn(forPermission, pattern) &&
      forPermission[pattern]) || { count: 0, first: now, last: now, risks: {} }
    entry.count += 1
    entry.last = now
    entry.risks[risk] = (entry.risks[risk] ?? 0) + 1
    setOwn(forPermission, pattern, entry)
  }
  pruneApprovals(approvals)
}

export async function writeApprovalsJournal(
  file: string,
  journal: ApprovalsJournal,
) {
  await writeJsonFile(file, journal, { fileMode: 0o600, dirMode: 0o700 })
}

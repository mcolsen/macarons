import crypto from "node:crypto"
import { type BigIntStats, constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import type { Action, Store } from "./engine"
import {
  allowRuleRedundant,
  expandHome,
  isAction,
  literalRecord,
  patternsOverlap,
  rulesFrom,
} from "./engine"
import type { PermissionStorePaths } from "./store-keying"

export async function pathExists(file: string): Promise<boolean | undefined> {
  try {
    await fs.access(file)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? false
      : undefined
  }
}

// The store is trust data, so its whole shape is validated: `permission` must
// map tool names to an action string or to a pattern → action map, with every
// action exactly allow/ask/deny. Anything else is corruption — a store whose
// unknown rules were silently dropped would keep looking readable while
// consumers evaluate weaker rules than the user wrote.
function parsePermission(value: unknown): Store["permission"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const permission = literalRecord<Action | Record<string, Action>>()
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      if (!isAction(entry)) return
      permission[key] = entry
      continue
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return
    const patterns = literalRecord<Action>()
    for (const [pattern, action] of Object.entries(entry)) {
      if (!isAction(action)) return
      patterns[pattern] = action
    }
    permission[key] = patterns
  }
  return permission
}

/**
 * The read-ENOENT-parse-validate skeleton every persisted file in the suite
 * was open-coding, in ten places, each deciding the same four questions again.
 * Here they are decided once:
 *
 * - **Missing is not corrupt.** ENOENT takes `onMissing` (default: undefined),
 *   because "nothing saved yet" is the normal first run — never a failure.
 * - **Unreadable is not empty.** Any other read error, malformed JSON, or a
 *   validator that throws goes to `onCorrupt` and yields undefined. Callers
 *   must be able to tell this from "no file": overwriting a file you failed to
 *   read loses whatever it held, and for trust data (an approvals store, an
 *   override) reading it as empty silently weakens a decision the user made.
 *   `onCorrupt` may itself throw to propagate.
 * - **The validator owns the shape** and stays local — per-file entry
 *   validation is exactly the part that is NOT common. Returning undefined
 *   rejects quietly ("some other tool's file"); throwing reports through
 *   `onCorrupt` ("our file, and it is damaged").
 */
export async function readJsonFile<T>(
  file: string,
  validate: (value: unknown) => T | undefined,
  handlers: {
    onMissing?: () => T | undefined
    onCorrupt?: (error: unknown) => void
  } = {},
): Promise<T | undefined> {
  let text: string
  try {
    text = await fs.readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return handlers.onMissing?.()
    handlers.onCorrupt?.(error)
    return undefined
  }
  try {
    return validate(JSON.parse(text))
  } catch (error) {
    handlers.onCorrupt?.(error)
    return undefined
  }
}

// Reads the store; a missing file is an empty store. undefined means the file
// exists but is unreadable or fails validation — callers must never overwrite
// it then, and trust decisions must pause rather than run on partial rules.
export async function readStore(
  file: string,
  onCorrupt?: (error: unknown) => void,
): Promise<Store | undefined> {
  return readJsonFile<Store>(
    file,
    (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("not an object")
      const parsed = value as Store
      if (!Object.hasOwn(parsed, "permission"))
        parsed.permission = literalRecord()
      else {
        const permission = parsePermission(parsed.permission)
        if (!permission) throw new Error("invalid permission rules")
        parsed.permission = permission
      }
      return parsed
    },
    { onMissing: () => ({ permission: literalRecord() }), onCorrupt },
  )
}

// Atomic replace (tmp + rename): concurrent writers can never tear the
// destination, but the rename itself is last-writer-wins — which is why every
// read-modify-write SEQUENCE against a store must hold withStoreLock (see
// below); the rename then only ever replaces a snapshot its holder read.
//
// The tmp name must be unique per call, not just per (pid, millisecond): two
// writes from the same process in the same millisecond would otherwise derive
// the same tmp path, and the default truncating writeFile would let their bytes
// interleave into one tmp that then gets renamed into place — a torn,
// invalid-JSON destination. A random suffix plus exclusive create ("wx", which
// fails rather than clobbering an existing tmp) closes that window; the tmp is
// removed if the write or rename fails so a partial file is never left behind.
export type WriteFileModes = {
  /** Mode for a newly written file (the tmp's mode survives the rename). */
  fileMode?: number
  /** Mode for directories this write has to create. */
  dirMode?: number
  /**
   * Permission-bit ceiling for an existing destination. Its current mode is
   * intersected with this value, so broad bits are removed without restoring
   * owner bits the user already removed. Implies `preserveMode` for rewrites.
   */
  fileModeLimit?: number
  /**
   * Permission-bit ceiling for an existing destination directory. As with
   * `fileModeLimit`, restriction never widens a stricter current mode.
   */
  dirModeLimit?: number
  /**
   * Rewrite in place: an existing destination's permission bits carry over to
   * the replacement, and `fileMode` applies only when the file is being
   * created. Replacing a file is not the same act as creating one — a config
   * a user chmod'd to 0600 because it carries provider credentials must not
   * come back group-readable just because a rewrite passed through here.
   */
  preserveMode?: boolean
  /**
   * Publish create-if-absent instead of replace: the write lands (via
   * `fs.link`) only when nothing owns the destination, and an existing file
   * makes the call fail with EEXIST rather than being clobbered — for slot
   * protocols where two non-clobbering writers must decide a winner atomically
   * (worktree's session markers). Any other `fs.link` failure — filesystems
   * without hardlinks (FAT/exFAT, some FUSE or network mounts throw
   * EPERM/ENOTSUP), but equally a transient fault on one that has them —
   * retries as an exclusive `wx` create, never a replace: an occupant still
   * keeps the slot and the loser still gets EEXIST, and all that degrades is
   * publication atomicity (a concurrent reader can glimpse a partially
   * written file). Meaningless with `preserveMode` — a write that only ever
   * lands on a missing destination has nothing to preserve.
   */
  ifAbsent?: boolean
  /**
   * Runs after the replacement is fully staged, immediately before the
   * rename (or link) that publishes it. Staging — mkdir, tmp create, tmp
   * write — is I/O the caller can sit suspended in, so a precondition
   * checked before calling in can be stale by publication time; this is the
   * last gate before the bytes become visible. A throw abandons the write:
   * the staged tmp is removed and the destination is never touched. The gate
   * may be repeated if a concurrent chmod forces one more mode restriction,
   * so it must be idempotent.
   */
  beforePublish?: () => void | Promise<void>
}

/** Owner-only policy for security- or privacy-relevant persisted state. */
export const OWNER_ONLY_WRITE_MODES = {
  fileMode: 0o600,
  dirMode: 0o700,
  fileModeLimit: 0o600,
  dirModeLimit: 0o700,
} as const satisfies WriteFileModes

async function prepareWriteDirectory(file: string, modes: WriteFileModes) {
  const directory = path.dirname(file)
  await fs.mkdir(directory, {
    recursive: true,
    ...(modes.dirMode !== undefined ? { mode: modes.dirMode } : {}),
  })
  if (modes.dirModeLimit === undefined) return
  await restrictPathMode(directory, modes.dirModeLimit)
}

export async function restrictPathMode(
  file: string,
  limit: number,
): Promise<number | undefined> {
  let planted: Awaited<ReturnType<typeof fs.lstat>>
  try {
    planted = await fs.lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  if (planted.isSymbolicLink())
    throw new Error(`refusing to restrict mode through a symlink (${file})`)
  const plantedMode = planted.mode & 0o7777
  // Windows exposes only a read-only approximation through chmod; POSIX
  // owner/group/other ceilings do not apply there, and directories cannot be
  // opened for the descriptor-bound fchmod below.
  if (process.platform === "win32") return plantedMode & limit
  if ((plantedMode & limit) === plantedMode) return plantedMode

  // Bind the chmod to the entry inspected. A pathname stat followed by a
  // pathname chmod can widen a stricter replacement, or follow a symlink a
  // peer substituted between the two calls.
  let handle: fs.FileHandle | undefined
  try {
    try {
      handle = await fs.open(
        file,
        fsConstants.O_RDONLY |
          (fsConstants.O_NOFOLLOW ?? 0) |
          (fsConstants.O_NONBLOCK ?? 0),
      )
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EACCES" && code !== "EPERM") throw error
      // A user-owned directory can be writable/searchable but not readable
      // (0377). POSIX offers no descriptor open that both succeeds there and
      // supports fchmod, so use a checked pathname fallback rather than fail
      // to remove its group/other bits.
      const current = await fs.lstat(file, { bigint: true })
      if (current.isSymbolicLink())
        throw new Error(`refusing to restrict mode through a symlink (${file})`)
      const currentMode = Number(current.mode) & 0o7777
      const restricted = currentMode & limit
      if (restricted !== currentMode) await fs.chmod(file, restricted)
      const after = await fs.lstat(file, { bigint: true })
      if (
        after.isSymbolicLink() ||
        after.dev !== current.dev ||
        after.ino !== current.ino
      )
        throw new Error(`path changed while restricting its mode (${file})`)
      const afterMode = Number(after.mode) & 0o7777
      if ((afterMode & limit) !== afterMode)
        throw new Error(`mode changed while restricting it (${file})`)
      return afterMode
    }
    const opened = await handle.stat({ bigint: true })
    const current = await fs.lstat(file, { bigint: true })
    if (
      current.isSymbolicLink() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    )
      throw new Error(`path changed while restricting its mode (${file})`)
    const openedMode = Number(opened.mode) & 0o7777
    const restricted = openedMode & limit
    if (restricted !== openedMode) await handle.chmod(restricted)
    return restricted
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function writeTextFile(
  file: string,
  text: string,
  modes: WriteFileModes = {},
) {
  await prepareWriteDirectory(file, modes)
  const fileModeLimit =
    process.platform === "win32" ? undefined : modes.fileModeLimit
  const retainMode = modes.preserveMode || fileModeLimit !== undefined
  const destinationMode = async (): Promise<number | undefined> => {
    if (!retainMode) return undefined
    try {
      const current = (await fs.stat(file)).mode & 0o7777
      return fileModeLimit === undefined ? current : current & fileModeLimit
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return undefined
    }
  }
  const inherited = await destinationMode()
  let mode = inherited ?? modes.fileMode
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  try {
    await fs.writeFile(tmp, text, {
      flag: "wx",
      ...(mode !== undefined ? { mode } : {}),
    })
    // writeFile applies the umask. An inherited mode is the destination's
    // existing policy, so restore it exactly before the private bytes sit in a
    // staged file; e.g. preserveMode must never stage a 0600 config as 0644.
    if (inherited !== undefined) await fs.chmod(tmp, inherited)
    // Re-read after staging: a chmod while the tmp was being written must not
    // be undone by publishing a replacement carrying the older mode. Any
    // non-ENOENT stat failure is a real fault; refusing to publish beats
    // falling back to whatever mode the umask happened to allow.
    const reconcileMode = async (): Promise<boolean> => {
      const latest = await destinationMode()
      if (latest === undefined) return false
      // Keep every restriction observed across the write. A concurrent
      // broadening is not permission to restore bits the staged snapshot had
      // already removed.
      const restricted = mode === undefined ? latest : mode & latest
      if (restricted === mode) return false
      mode = restricted
      // writeFile's mode passes through the umask. chmod restores the exact
      // preserved or restricted mode immediately before the final gate.
      await fs.chmod(tmp, mode)
      return true
    }
    await reconcileMode()
    // A beforePublish check can itself suspend while another actor tightens
    // the destination. Reconcile afterward and repeat the check whenever that
    // removes another bit; the mode only narrows, so this loop is bounded.
    for (;;) {
      await modes.beforePublish?.()
      if (!(await reconcileMode())) break
    }
    if (modes.ifAbsent) {
      try {
        await fs.link(tmp, file)
      } catch (error) {
        // EEXIST is the contract, not a fault: the slot is taken and the
        // caller decides what that means. Anything else — hardlinks being
        // unavailable, or a transient fault that merely looks like it — must
        // still never clobber: retry as an exclusive create, so an occupant
        // keeps the slot (EEXIST propagates from here too) and only the
        // publication's atomicity is lost (see WriteFileModes).
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error
        await fs.writeFile(file, text, {
          flag: "wx",
          ...(mode !== undefined ? { mode } : {}),
        })
      }
      // Either way the destination now carries the bytes; drop the tmp name
      // (after a successful link it is a second name for the same inode).
      await fs.rm(tmp, { force: true }).catch(() => {})
      return
    }
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

export async function writeJsonFile(
  file: string,
  value: unknown,
  modes: WriteFileModes = {},
) {
  await writeTextFile(file, `${JSON.stringify(value, null, 2)}\n`, modes)
}

export async function writeStore(
  file: string,
  store: Store,
  modes: WriteFileModes = {},
) {
  await writeJsonFile(file, store, modes)
}

/**
 * Read-patch-write for a settings file, preserving keys the caller does not
 * know about (`$schema`, another plugin's block, a key from a newer release).
 * A `undefined` value in the patch deletes its key.
 *
 * "corrupt" means the file exists but is not readable as a JSON object.
 * Callers must refuse to overwrite it: settings files are hand-edited, and
 * flattening a user's file because one character of it was mistyped destroys
 * work no toggle can restore.
 */
export async function patchSettingsFile(
  file: string,
  patch: Record<string, unknown>,
): Promise<"ok" | "corrupt"> {
  let raw = literalRecord<unknown>()
  let text: string | undefined
  try {
    text = await fs.readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "corrupt"
    text = undefined
  }
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return "corrupt"
      raw = literalRecord(Object.entries(parsed))
    } catch {
      return "corrupt"
    }
  }
  // Deleted explicitly rather than left as an `undefined` value for
  // JSON.stringify to drop: the object this writes is the file's contents,
  // and "the key is gone" should not depend on the serializer's opinion.
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete raw[key]
    else raw[key] = value
  }
  await writeJsonFile(file, raw)
  return "ok"
}

// ---------------------------------------------------------------------------
// Total, deterministic serialization
//
// Promoted from approve-for-me (2026-07-23 audit §4), where it
// pins the content snapshot a classification is judging — computed inside an
// event hook, before any exception boundary. Host-provided values are
// `unknown`: plain JSON.stringify throws on BigInt and cycles, and a hostile
// or broken value (proxies, throwing getters) could reject the caller's
// pipeline. This serializer is TOTAL: every property access is guarded,
// cycles collapse to a marker, depth, array length, and overall output are
// bounded. It is also deterministic — object keys are sorted — so a value
// that merely reorders keys never reads as changed content.
//
// Faithfulness is the security property: two DIFFERENT contents colliding
// would let a changed value pass as an unchanged one (for the original
// caller, a changed permission request riding an in-flight verdict).
// Concretely, equal outputs must imply that a plain-JSON.stringify view of
// the content (falling back to String() where it throws) is equivalent too.
// Two rules deliver that:
//   - Every non-JSON state renders as an UNQUOTED typed token — [circular],
//     [deep], [unreadable], [opaque], [budget], [+N more], Date(…),
//     Symbol("…"), Function("…") — which no string value can produce, since
//     strings always render JSON-quoted. A user string "[circular]" can
//     therefore never collide with an actual cycle.
//   - States whose full content this serializer cannot see, while a plain
//     JSON.stringify still could — beyond-depth content, truncated array
//     tails, throwing accessors, exceeded budgets, and objects with their
//     own toJSON or a non-plain prototype (URL serializes via toJSON;
//     enumerable keys alone would render every URL as "{}") — additionally
//     flag `state.lossy`. A lossy rendering cannot prove "unchanged", and a
//     caller comparing snapshots must treat it as changed (fail closed).
//     Cycles are exempt: any cycle makes plain JSON.stringify throw, so its
//     String() fallback view cannot distinguish contents the markers don't.
// ---------------------------------------------------------------------------

const STRINGIFY_MAX_DEPTH = 64
const STRINGIFY_MAX_ITEMS = 10_000
// Global output budget. Ancestors-only cycle detection means shared acyclic
// branches render once per reference, which a small diamond-shaped graph
// turns exponential — the budget caps rendered characters (and thereby the
// work) wherever the blowup comes from, then flags the result lossy.
const STRINGIFY_MAX_CHARS = 262_144

export function stableStringify(
  value: unknown,
  state?: { lossy?: boolean },
): string {
  // Path-based cycle detection: only true ancestors count, shared branches
  // (a DAG) serialize normally.
  const path = new Set<object>()
  let used = 0
  const lossy = (token: string): string => {
    if (state) state.lossy = true
    used += token.length
    return token
  }
  // Charging AFTER accepting a token would let a single oversized scalar —
  // one multi-megabyte string — sail past the cap unflagged; a token that
  // does not fit renders as the budget marker instead.
  const spend = (token: string): string => {
    if (used + token.length > STRINGIFY_MAX_CHARS) return lossy("[budget]")
    used += token.length
    return token
  }
  const render = (node: unknown, depth: number): string => {
    if (used > STRINGIFY_MAX_CHARS) return lossy("[budget]")
    switch (typeof node) {
      case "string":
        return spend(JSON.stringify(node))
      case "number":
      case "boolean":
      case "undefined":
        return spend(String(node))
      case "bigint":
        return spend(`${String(node)}n`)
      case "symbol": {
        let description: unknown
        try {
          description = node.description
        } catch {
          description = undefined
        }
        // JSON-quoted so a crafted description cannot forge surrounding
        // structure; symbols are invisible to plain JSON.stringify, so
        // same-description collisions are harmless.
        return spend(
          `Symbol(${typeof description === "string" ? JSON.stringify(description) : ""})`,
        )
      }
      case "function": {
        // `name` is configurable and could hide a throwing getter.
        let name: unknown
        try {
          name = node.name
        } catch {
          name = undefined
        }
        return spend(
          `Function(${typeof name === "string" ? JSON.stringify(name) : ""})`,
        )
      }
    }
    if (node === null) return spend("null")
    const container = node as object
    if (path.has(container)) return spend("[circular]")
    if (depth >= STRINGIFY_MAX_DEPTH) return lossy("[deep]")
    path.add(container)
    try {
      // Array.isArray and instanceof both throw on a revoked proxy.
      let isArray: boolean
      try {
        isArray = Array.isArray(container)
      } catch {
        return lossy("[unreadable]")
      }
      if (!isArray) {
        // A Date with the stock toJSON serializes faithfully by timestamp
        // (JSON.stringify distinguished Dates via that toJSON). One with a
        // REPLACED toJSON falls through to the opaque check below.
        try {
          if (
            container instanceof Date &&
            container.toJSON === Date.prototype.toJSON
          ) {
            return spend(`Date(${String(container.getTime())})`)
          }
        } catch {
          return lossy("[unreadable]")
        }
      }
      // Plain JSON.stringify serializes whatever toJSON returns — content
      // this serializer cannot mirror; and a non-plain instance without
      // toJSON would render from enumerable keys alone, collapsing distinct
      // instances into one "{}". Both are opaque, hence lossy.
      try {
        if (typeof (container as { toJSON?: unknown }).toJSON === "function")
          return lossy("[opaque]")
      } catch {
        return lossy("[unreadable]")
      }
      if (isArray) {
        let length: unknown
        try {
          length = (container as unknown[]).length
        } catch {
          return lossy("[unreadable]")
        }
        if (
          typeof length !== "number" ||
          !Number.isSafeInteger(length) ||
          length < 0
        )
          return lossy("[unreadable]")
        const items: string[] = []
        const shown = Math.min(length, STRINGIFY_MAX_ITEMS)
        // Delimiters count too: a shared DAG built purely from arrays emits
        // nothing BUT delimiters, and uncharged ones would render the whole
        // exponential blowup the budget exists to cap.
        used += 2
        for (let index = 0; index < shown; index++) {
          if (index > 0) used += 1
          if (used > STRINGIFY_MAX_CHARS) {
            items.push(lossy("[budget]"))
            break
          }
          let item: unknown
          try {
            item = (container as unknown[])[index]
          } catch {
            items.push(lossy("[unreadable]"))
            continue
          }
          items.push(render(item, depth + 1))
        }
        if (length > shown) items.push(lossy(`[+${length - shown} more]`))
        return `[${items.join(",")}]`
      }
      try {
        const proto = Object.getPrototypeOf(container)
        if (proto !== Object.prototype && proto !== null)
          return lossy("[opaque]")
      } catch {
        return lossy("[unreadable]")
      }
      let keys: string[]
      try {
        keys = Object.keys(container).sort()
      } catch {
        return lossy("[unreadable]")
      }
      const entries: string[] = []
      used += 2
      for (const key of keys) {
        used += entries.length > 0 ? 2 : 1
        if (used > STRINGIFY_MAX_CHARS) {
          entries.push(lossy("[budget]"))
          break
        }
        let item: unknown
        try {
          item = (container as Record<string, unknown>)[key]
        } catch {
          entries.push(`${spend(JSON.stringify(key))}:${lossy("[unreadable]")}`)
          continue
        }
        entries.push(`${spend(JSON.stringify(key))}:${render(item, depth + 1)}`)
      }
      return `{${entries.join(",")}}`
    } finally {
      path.delete(container)
    }
  }
  return render(value, 0)
}

// ---------------------------------------------------------------------------
// Cross-process store lock
//
// Atomic rename makes individual writes safe, but read-modify-write sequences
// are not: two processes that both read the same snapshot each write back
// only their own change, and the last rename silently drops the other's. For
// ordinary saves that is the documented last-writer-wins caveat — the value
// still exists in the loser's head and the next "always" answer restores it.
// Migration is different: it DELETES its source file after writing, so a
// clobbered migration loses the only copy of those approvals. Every
// read-modify-write against a store therefore runs under this lock.
//
// The lock is a sibling `<store>.lock` file created with O_EXCL. A holder
// that crashed leaves its lock behind, so a lock older than `staleMs` is
// broken and retaken; real holds last milliseconds. Acquisition that cannot
// succeed within `timeoutMs` throws — callers treat that as a failed save or
// a paused migration, never as permission to proceed unlocked.
//
// Two facilities exist for holds that are NOT millisecond-scale — the worktree
// plugin holds this lock across `git worktree remove` of a real checkout:
//
//   heartbeatMs — refresh the held lock's mtime while the callback runs, so a
//     long LEGITIMATE hold is never mistaken for a crashed holder and broken
//     by a peer. Without it, the only way to survive a slow callback is a
//     staleMs longer than the worst hold, which delays recovery from a real
//     crash by exactly that much.
//   lease — the ownership token the callback can re-assert. Stale-breaking
//     means a hold CAN be lost (a heartbeat that could not run because the
//     process was stopped, a filesystem whose mtimes do not advance), and a
//     caller about to do something destructive must be able to check rather
//     than assume. Release is token-checked for the same reason: a holder
//     whose lock was broken and retaken must never delete its successor's.
// ---------------------------------------------------------------------------

export type StoreLockOptions = {
  /** Give up acquiring after this long (default 2s). */
  timeoutMs?: number
  /** Break a lock file older than this — its holder crashed (default 10s). */
  staleMs?: number
  /** Delay between acquisition attempts (default 25ms). */
  pollMs?: number
  /** Subject named in the timeout error (default "the permission store"). */
  label?: string
  /**
   * Refresh the held lock's mtime this often. Omitted (the default) means no
   * heartbeat — byte-for-byte the original behavior for every existing caller.
   * Set it well below `staleMs`; a few refreshes must fit inside that window.
   */
  heartbeatMs?: number
  /** Modes for the lock file and its parent directory. */
  modes?: Pick<
    WriteFileModes,
    "fileMode" | "dirMode" | "fileModeLimit" | "dirModeLimit"
  >
}

/**
 * Marks the one acquisition failure that means "a peer is holding it, try
 * again" — as opposed to a lock path that is structurally broken, which no
 * amount of retrying fixes and which a caller must not report as ordinary
 * contention. Callers that turn contention into a benign "busy" result key off
 * this; anything else has to surface.
 */
const LOCK_BUSY = "ELOCKBUSY"
// Only an exclusive-create failure proves a source lock cannot be taken.
// Preparation and callback errors can carry the same errno but do not license
// migrateWorktreeStore's read-only-directory fallback.
const lockCreateFailures = new WeakSet<object>()

export function isLockBusyError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === LOCK_BUSY
}

/** A hold on the lock. Its token is the proof of ownership. */
export type StoreLease = {
  /** False once a peer broke this hold and took the lock. */
  held(): Promise<boolean>
  /** Throws unless still held. Call immediately before a destructive step. */
  assertHeld(): Promise<void>
}

export async function withStoreLock<T>(
  storeFile: string,
  fn: (lease: StoreLease) => Promise<T>,
  options: StoreLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 2_000
  const staleMs = options.staleMs ?? 10_000
  const pollMs = options.pollMs ?? 25
  const label = options.label ?? "the permission store"
  const lockFile = `${path.resolve(storeFile)}.lock`
  // The token identifies THIS hold. pid alone cannot: a pid is reused, and two
  // holds from the same process (a stale break followed by a retake) would be
  // indistinguishable — exactly when telling them apart matters most.
  const token = crypto.randomBytes(8).toString("hex")
  const contents = `${process.pid}\n${token}\n`
  await prepareWriteDirectory(lockFile, options.modes ?? {})
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fs.writeFile(lockFile, contents, {
        flag: "wx",
        ...(options.modes?.fileMode !== undefined
          ? { mode: options.modes.fileMode }
          : {}),
      })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (typeof error === "object" && error !== null)
          lockCreateFailures.add(error)
        throw error
      }
    }
    // Everything below only DECIDES whether to break the incumbent lock, and
    // nothing here may `continue`: the deadline check and the poll at the
    // bottom of this loop are the only guarantee that acquisition terminates.
    // A lock path that reliably fails to stat (a dangling symlink, a symlink
    // loop) or reliably fails to remove (a directory, a file this process may
    // not unlink) would otherwise retry at full speed forever — never timing
    // out, burning a core — instead of failing the way every caller expects.
    let held: BigIntStats | undefined
    try {
      // lstat, not stat: the `wx` create above refuses to follow a symlink and
      // reports EEXIST for one, while stat would follow it and report ENOENT.
      // lstat describes what is actually in the way.
      held = await fs.lstat(lockFile, { bigint: true })
    } catch {
      // Released between the failed create and the lstat. Self-limiting — the
      // next create simply succeeds — so fall through to the poll below.
    }
    if (held && !held.isFile()) {
      // Not something this code could have created, so no staleness rule
      // applies and it is not ours to clear. Removing it is the wrong reflex:
      // treating the path as reclaimable invites a peer to hand us a target of
      // its choosing, and this lock sits under the checkout's writable
      // .opencode directory. Fail closed and make a human look.
      throw new Error(`${label} lock path is not a regular file (${lockFile})`)
    }
    if (held && Date.now() - Number(held.mtimeMs) > staleMs) {
      // A crashed holder's leftover. Break it by IDENTITY, never by pathname:
      // two waiters routinely judge the SAME abandoned lock stale within one
      // poll cycle, and an unconditional `rm` by the second would delete the
      // FRESH lock the first just created and let both into the callback, each
      // believing it holds. Re-stat immediately before the unlink and stand
      // down unless the inode and mtime are still the ones judged stale — a
      // different inode is a successor's lock, and a bumped mtime is the
      // incumbent's heartbeat outrunning our staleness verdict.
      //
      // This NARROWS the race to the two syscalls between the re-stat and the
      // unlink; POSIX has no unlink-by-inode, so it cannot close it. That
      // residue is precisely why the lease below is the fail-closed gate
      // before any destructive step, and why a caller about to do something
      // irreversible must check it rather than assume it still holds.
      const current = await fs
        .lstat(lockFile, { bigint: true })
        .catch(() => undefined)
      if (
        current &&
        current.ino === held.ino &&
        current.mtimeMs === held.mtimeMs
      ) {
        await fs.rm(lockFile, { force: true }).catch(() => {})
      }
    }
    if (Date.now() >= deadline) {
      const busy: NodeJS.ErrnoException = new Error(
        `${label} is locked by another process (${lockFile})`,
      )
      busy.code = LOCK_BUSY
      throw busy
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }

  // Ownership is decided by the token in the file, never by the file merely
  // existing: a peer that broke this hold as stale wrote its own token there.
  const owned = async (): Promise<boolean> => {
    try {
      return (await fs.readFile(lockFile, "utf8")) === contents
    } catch {
      // Gone (or unreadable) means this hold no longer owns the lock.
      return false
    }
  }
  const lease: StoreLease = {
    held: owned,
    async assertHeld() {
      if (!(await owned()))
        throw new Error(
          `${label} lock was lost to another process (${lockFile})`,
        )
    },
  }

  // utimes, not a rewrite: a waiter's fs.lstat above reads the mtime and the
  // inode, and touching the mtime can never expose a torn file the way a
  // rewrite could — nor change the inode the stale-break identity check
  // compares, which a write-to-temp-and-rename refresh would. The timer
  // is unref'd so a pending refresh never keeps the process alive, and it stops
  // refreshing the moment the hold is lost rather than resurrecting a lock that
  // now belongs to someone else.
  const heartbeat =
    options.heartbeatMs !== undefined
      ? setInterval(() => {
          void (async () => {
            if (!(await owned())) {
              clearInterval(heartbeat)
              return
            }
            const now = new Date()
            await fs.utimes(lockFile, now, now).catch(() => {})
          })()
        }, options.heartbeatMs)
      : undefined
  heartbeat?.unref?.()

  try {
    return await fn(lease)
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    // Token-checked release. An unconditional rm would delete the lock of the
    // peer that legitimately broke and retook this one, handing a third process
    // a lock two holders believe they own.
    if (await owned()) await fs.rm(lockFile, { force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Worktree-store migration
//
// Before stores were keyed by the primary worktree root ("repository" scope),
// every linked worktree persisted into its own file. When a session first
// resolves the shared store, any store still keyed by the session's own
// worktree root is folded in — automatically only when that is provably safe.
// ---------------------------------------------------------------------------

export type StoreMigration =
  /** No worktree-keyed store exists (or it was already migrated). */
  | { outcome: "none" }
  /**
   * Folded into the shared store; `added` rules were new. `removed` is false
   * when the source file could not be deleted — or was deliberately left in
   * place because this pass's lock was broken before the removal, in which
   * case the source may already hold rules a new holder saved that this pass
   * never read. Either way the merge itself is durable, but callers must NOT
   * memoize the pass as finished: re-running it re-reads the source (folding
   * in anything newer, idempotently — everything already merged adds nothing)
   * and retries the removal.
   */
  | { outcome: "merged"; added: number; removed: boolean }
  /**
   * The worktree store holds ask/deny carve-outs (or cannot be read), and no
   * automatic merge can preserve what they mean: appending them could override
   * shared-store rules, dropping them would silently re-enable auto-approvals
   * the user carved out. Callers must pause persistence for this worktree and
   * tell the user to merge by hand — the same posture as the legacy in-project
   * store migration.
   */
  | { outcome: "manual"; reason: string }
  /** A transient read/write failure; callers pause and retry on a later access. */
  | { outcome: "error"; reason: string }

// Merging is prepend-only: imported rules land BEFORE the rules already under
// their permission key, so under last-rule-wins they only decide requests no
// existing shared rule matches — an import can never override a carve-out the
// user wrote into the shared store. That is also why only pure-allow worktree
// stores merge automatically: a prepended ask/deny would be equally powerless,
// which silently DROPS the protection it expressed, so those pause instead.
// Prepending cannot be expressed ACROSS permission keys (a new key lands at
// the end of the flattened, globally last-match-wins order), so an import
// that could land after an overlapping carve-out under another key — e.g. a
// shared "*" ask/deny — downgrades to the manual outcome instead of merging.
/**
 * Test seams for the fold. A hold can be broken as stale mid-pass (see
 * withStoreLock — stale-breaking is narrowed, never closed), and the guards
 * that make the fold stand down then fire in windows a few syscalls wide.
 * Only a hook that suspends the pass right before a destructive step can
 * place a peer's takeover inside one deterministically. Production callers
 * pass nothing.
 */
export type StoreMigrationHooks = {
  /** Runs immediately before the destination store's write (when there is one). */
  beforeWrite?: () => void | Promise<void>
  /**
   * Runs inside that write, after the replacement is fully staged and
   * immediately before the leases' final re-assert and the rename that
   * publishes it — the window staging itself opens, which beforeWrite
   * cannot reach.
   */
  beforePublish?: () => void | Promise<void>
  /** Runs immediately before the source file's removal. */
  beforeRemove?: () => void | Promise<void>
}

export async function migrateWorktreeStore(
  sharedFile: string,
  worktreeFile: string,
  hooks: StoreMigrationHooks = {},
): Promise<StoreMigration> {
  if (path.resolve(sharedFile) === path.resolve(worktreeFile))
    return { outcome: "none" }
  const exists = await pathExists(worktreeFile)
  if (exists === undefined)
    return { outcome: "error", reason: `${worktreeFile} is unreadable` }
  if (!exists) return { outcome: "none" }
  // The whole read→merge→write→delete sequence holds the destination's lock:
  // two instances migrating DIFFERENT worktree stores into one shared store
  // would otherwise each write only their own merge and both delete their
  // sources — the last rename would discard the other instance's approvals
  // with no copy left anywhere. (Both halves migrating the SAME source are
  // serialized by it too; the second pass finds the source gone and reports
  // "none".) It holds the SOURCE's lock as well: every writer that still
  // treats the candidate as its active store — a save under an interim key, a
  // still-running pre-slug release writing the legacy name — locks by that
  // filename, and without the source lock such a writer could atomically
  // replace the file between this pass's read and its delete, losing the
  // newer rules unread. Destination first, source second, the same fixed
  // order adoptLegacyProjectScopedFile uses, and no single-lock writer ever
  // takes a second lock — so the pair cannot deadlock.
  try {
    return await withStoreLock(
      sharedFile,
      async (sharedLease) => {
        let migrating = false
        try {
          return await withStoreLock(
            worktreeFile,
            (worktreeLease) => {
              migrating = true
              return migrateWorktreeStoreLocked(
                sharedFile,
                worktreeFile,
                [sharedLease, worktreeLease],
                hooks,
              )
            },
            { modes: OWNER_ONLY_WRITE_MODES },
          )
        } catch (error) {
          // A permission failure CREATING the source lock proves the source's
          // directory is unwritable — and every writer needs that same
          // directory for its own lock and its tmp+rename, so nothing can race
          // a lockless merge there. (The removal fails the same way and is
          // reported as removed: false for retry.) The proof holds only when
          // the failure IS the lock creation: the same codes thrown from
          // inside the pass — a test seam's filesystem work, say — arrive
          // AFTER the source lock was taken, prove nothing about the
          // directory, and a lockless re-run there would reintroduce the very
          // race the lock closes. Those, and anything else — contention
          // included — surface as this pass's error and are retried later.
          const code = (error as NodeJS.ErrnoException | undefined)?.code
          if (
            migrating ||
            typeof error !== "object" ||
            error === null ||
            !lockCreateFailures.has(error) ||
            (code !== "EACCES" && code !== "EPERM" && code !== "EROFS")
          )
            throw error
          return migrateWorktreeStoreLocked(
            sharedFile,
            worktreeFile,
            [sharedLease],
            hooks,
          )
        }
      },
      { modes: OWNER_ONLY_WRITE_MODES },
    )
  } catch (error) {
    return {
      outcome: "error",
      reason: `could not migrate ${worktreeFile}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

// `leases` are every hold this pass rests on — both stores' normally; only
// the destination's on the unwritable-source-directory fallback, where no
// source lock can exist for anyone. Each is re-asserted immediately before a
// destructive step, because holding a lock here is not a lease for the whole
// pass: a peer that judges this hold stale breaks it and takes the lock, and
// from that moment the peer may legitimately rewrite either store.
async function migrateWorktreeStoreLocked(
  sharedFile: string,
  worktreeFile: string,
  leases: StoreLease[],
  hooks: StoreMigrationHooks,
): Promise<StoreMigration> {
  // Re-checked under the lock: another process may have completed this very
  // migration while we waited.
  const exists = await pathExists(worktreeFile)
  if (exists === undefined)
    return { outcome: "error", reason: `${worktreeFile} is unreadable` }
  if (!exists) return { outcome: "none" }

  // Restrict every store that can survive this pass, not only a destination
  // whose contents happen to change. This covers manual/error outcomes and a
  // zero-add fold that removes a duplicate source without rewriting current.
  const worktreeMode = await restrictPathMode(
    worktreeFile,
    OWNER_ONLY_WRITE_MODES.fileModeLimit,
  )
  if (worktreeMode === undefined) return { outcome: "none" }
  await restrictPathMode(sharedFile, OWNER_ONLY_WRITE_MODES.fileModeLimit)
  const worktreeStore = await readStore(worktreeFile)
  if (!worktreeStore)
    return {
      outcome: "manual",
      reason: `${worktreeFile} is unreadable or invalid JSON`,
    }
  const carveOut = rulesFrom(worktreeStore).find(
    (rule) => rule.action !== "allow",
  )
  if (carveOut) {
    return {
      outcome: "manual",
      reason: `${worktreeFile} contains "${carveOut.pattern}": "${carveOut.action}" for "${carveOut.permission}"`,
    }
  }

  const shared = await readStore(sharedFile)
  if (!shared)
    return {
      outcome: "error",
      reason: `${sharedFile} is unreadable or invalid JSON`,
    }
  const sharedRules = rulesFrom(shared)
  // The shared store's key order — the order rulesFrom flattens and
  // evaluation consumes. Captured before any mutation.
  const keyOrder = Object.keys(shared.permission)
  type Planned = {
    permission: string
    additions: Record<string, Action>
    currentMap: Record<string, Action>
  }
  const plan: Planned[] = []
  let added = 0
  for (const [permission, value] of Object.entries(worktreeStore.permission)) {
    // Raw entries, not rulesFrom: the store file keeps `~/…` patterns as
    // written, and the merge must carry them over verbatim.
    const imported =
      typeof value === "string" ? literalRecord([["*", value]]) : value
    const current = Object.hasOwn(shared.permission, permission)
      ? shared.permission[permission]
      : undefined
    const currentMap: Record<string, Action> =
      typeof current === "string"
        ? literalRecord([["*", current]])
        : literalRecord(Object.entries(current ?? {}))
    const additions = literalRecord<Action>()
    for (const [pattern, action] of Object.entries(imported)) {
      if (Object.hasOwn(currentMap, pattern)) continue
      // The same redundancy skip persist() applies — sound containment, not
      // string matching, so a shared "git ?" can never swallow an imported
      // "git *" it does not actually cover.
      if (allowRuleRedundant(permission, expandHome(pattern), sharedRules))
        continue
      additions[pattern] = action
      added += 1
    }
    if (Object.keys(additions).length)
      plan.push({ permission, additions, currentMap })
  }

  // Prepending is only meaningful WITHIN one permission key. A rule imported
  // under a different key lands wherever that key sits — new keys at the very
  // end — and the flattened ruleset is globally last-match-wins across keys,
  // so it could evaluate after (and silently override) a carve-out the user
  // wrote under an overlapping wildcard key like "*". No automatic placement
  // preserves both stores' meaning then; that merge is the user's to do.
  for (const { permission, additions } of plan) {
    const position = keyOrder.indexOf(permission)
    for (const carveOut of sharedRules) {
      if (carveOut.action === "allow" || carveOut.permission === permission)
        continue
      // Additions to a key that already sits before the carve-out's key stay
      // before it in the flat order, so the carve-out still wins.
      if (position !== -1 && position < keyOrder.indexOf(carveOut.permission))
        continue
      if (!patternsOverlap(carveOut.permission, permission)) continue
      for (const pattern of Object.keys(additions)) {
        if (patternsOverlap(carveOut.pattern, expandHome(pattern))) {
          return {
            outcome: "manual",
            reason:
              `merging "${pattern}" for "${permission}" from ${worktreeFile} could override ` +
              `"${carveOut.pattern}": "${carveOut.action}" for "${carveOut.permission}" in the shared store`,
          }
        }
      }
    }
  }

  for (const { permission, additions, currentMap } of plan) {
    shared.permission[permission] = literalRecord([
      ...Object.entries(additions),
      ...Object.entries(currentMap),
    ])
  }
  if (added > 0) {
    await hooks.beforeWrite?.()
    // The write replaces the destination wholesale with a merge computed from
    // reads taken earlier under these holds — but the destructive instant is
    // the RENAME that publishes it, not the staging before it: serializing,
    // creating the directory, and writing the tmp are I/O this pass can sit
    // suspended in past the stale threshold. So the leases are re-asserted
    // inside the write, after the tmp is staged and immediately before the
    // rename. If a hold has been broken by then, the new holder may already
    // have written the destination itself — e.g. a peer's fold of a
    // DIFFERENT source that then deleted it — and landing a stale merge over
    // that write discards rules with no copy left anywhere. The throw
    // abandons the staged tmp with the destination untouched and surfaces as
    // this pass's "error"; a later access retries the whole pass from fresh
    // reads under fresh holds.
    try {
      await writeStore(sharedFile, shared, {
        ...OWNER_ONLY_WRITE_MODES,
        // A missing destination inherits stricter owner bits from the source;
        // an existing destination is restricted from its own current mode.
        fileMode: worktreeMode,
        beforePublish: async () => {
          await hooks.beforePublish?.()
          for (const lease of leases) await lease.assertHeld()
        },
      })
    } catch (error) {
      return {
        outcome: "error",
        reason: `could not write ${sharedFile}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  // The read-only-source fallback holds only the destination lease. It may
  // merge safely because lock creation failed while the source directory was
  // unwritable, but that point-in-time fact never licenses a later unlink: the
  // directory could become writable and accept a source-locked save meanwhile.
  // Leave the source for a retry that can acquire its lease.
  if (leases.length < 2) return { outcome: "merged", added, removed: false }
  // Remove only after the shared store holds every rule. A failed removal is
  // reported, not swallowed: callers must keep re-running the pass (which is
  // idempotent — everything already merged adds nothing) until the source is
  // really gone, instead of memoizing a half-finished migration as complete.
  await hooks.beforeRemove?.()
  try {
    // The removal is the irreversible step: if a hold was broken since the
    // merge read, whoever took the lock may have saved rules into the source
    // that this pass never read, and deleting it now would destroy the only
    // copy. Stand down as removed: false instead — the merge that DID land
    // stays durable, and the re-run that outcome demands re-reads the source
    // and folds in whatever the new holder wrote.
    for (const lease of leases) await lease.assertHeld()
    await fs.rm(worktreeFile, { force: true })
  } catch {
    return { outcome: "merged", added, removed: false }
  }
  return { outcome: "merged", added, removed: true }
}

/**
 * Every store file a session should fold into its active store, most-likely
 * first. One list so both consumers migrate exactly the same set — a candidate
 * only one of them knows about is an approval only one of them can see.
 *
 * The pre-slug names are always listed, existing file or not (a missing
 * candidate folds as "none" for the cost of one stat): a file at one of them
 * is pre-upgrade authorization state that adoption could not move — a
 * dual-name conflict, or an older release's half recreating the legacy name
 * after adoption — and the fold is what reconciles it: pure-allow rules merge
 * in, anything with carve-outs pauses persistence for the user's review.
 */
export function storeMigrationCandidates(
  paths: PermissionStorePaths,
): string[] {
  const files: string[] = []
  for (const file of [
    ...(paths.worktreeStoreFile ? [paths.worktreeStoreFile] : []),
    ...(paths.staleStoreFiles ?? []),
    ...(paths.preSlugStoreFiles ?? []),
  ]) {
    if (file === paths.storeFile || files.includes(file)) continue
    files.push(file)
  }
  return files
}

/** The result of folding every migration candidate into the active store. */
export type StoresMigration = {
  /** False when persistence must PAUSE: rules were found that no automatic
   *  merge can preserve, or a candidate could not be read or written. */
  ok: boolean
  /** Rules newly added to the active store across all candidates. */
  moved: number
  /** The pass is not finished — re-run it on the next access (never memoize it
   *  as complete): a source file still needs deleting, or a pause may lift
   *  once the user reconciles the file named in `reason`. */
  retry: boolean
  /** Why persistence paused, when ok is false. */
  reason?: string
  /** Which failure paused it: "manual" needs the user, "error" is transient. */
  kind?: "manual" | "error"
  /** A candidate that merged but could not be deleted; removal is retried. */
  unremoved?: string
}

/**
 * Fold every store the session no longer keys by into its active store. Both
 * persist-permissions halves run this with the same inputs, so they can never
 * disagree about which approvals have been migrated.
 *
 * The first candidate that cannot be merged automatically pauses the whole
 * pass rather than skipping ahead: persistence is paused for the session
 * anyway, and merging later candidates while the user reconciles an earlier
 * one would answer prompts from a store they were told to review by hand.
 */
export async function migrateStores(
  paths: PermissionStorePaths,
): Promise<StoresMigration> {
  let moved = 0
  let retry = false
  let unremoved: string | undefined
  for (const candidate of storeMigrationCandidates(paths)) {
    const result = await migrateWorktreeStore(paths.storeFile, candidate)
    if (result.outcome === "manual")
      return {
        ok: false,
        moved,
        retry: true,
        reason: result.reason,
        kind: "manual",
      }
    if (result.outcome === "error")
      return {
        ok: false,
        moved,
        retry: true,
        reason: result.reason,
        kind: "error",
      }
    if (result.outcome === "merged") {
      moved += result.added
      if (!result.removed) {
        retry = true
        unremoved ??= candidate
      }
    }
  }
  return { ok: true, moved, retry, ...(unremoved ? { unremoved } : {}) }
}

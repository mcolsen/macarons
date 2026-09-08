import { execFile } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import {
  OWNER_ONLY_WRITE_MODES,
  pathExists,
  restrictPathMode,
  type WriteFileModes,
  withStoreLock,
  writeTextFile,
} from "./filesystem"

// The store file persist-permissions writes and approve-for-me reads.
// The basename lives here because it is a contract between the two plugins:
// user-authored allow rules and ask/deny carve-outs both plugins must agree on.
export const PERMISSIONS_STORE_BASENAME = "permissions.local.json"
export const PERMISSIONS_STORE_DIRECTORY = "persist-permissions"

// How a project's store is keyed. "repository" (the default) keys by the
// PRIMARY worktree root, so one repository's linked worktrees all share a
// single store — an approval persisted in one worktree re-approves in every
// other and in the primary checkout. "worktree" keys by the session's own
// worktree root, the pre-2026-07 behavior: every linked worktree gets its own
// isolated store.
export type StoreScope = "repository" | "worktree"

export function isStoreScope(value: unknown): value is StoreScope {
  return value === "repository" || value === "worktree"
}

/**
 * A configured scope value, strictly. Absent means the default "repository";
 * anything else must be a valid StoreScope or the caller gets `problem` and
 * no scope — and must PAUSE persistence rather than guess. The consumers of
 * this option (both persist-permissions halves, approve-for-me's
 * scope setting) resolve it independently, and one half silently defaulting
 * to "repository" while another runs "worktree" makes the defaulting half
 * migrate away — and delete — the store the other is actively using.
 */
export function resolveScopeOption(value: unknown): {
  scope?: StoreScope
  problem?: string
} {
  if (value === undefined) return { scope: "repository" }
  if (isStoreScope(value)) return { scope: value }
  return { problem: '"scope" must be "repository" or "worktree"' }
}

/** Minimal subprocess runner, injectable so tests never depend on host git state. */
export type ExecRunner = (
  cwd: string,
  args: string[],
) => Promise<{ code: number; stdout: string }>

const execFileAsync = promisify(execFile)

export const runGitCommand: ExecRunner = async (cwd, args) => {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      timeout: 10_000,
    })
    return { code: 0, stdout: result.stdout }
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string }
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
    }
  }
}

// Resolve the nearest existing ancestor's realpath so a root that is itself a
// symlink (macOS /var → /private/var tmpdirs) compares equal to what git
// reports. Falls back to the resolved absolute path when nothing exists.
async function realpathOrResolve(target: string): Promise<string> {
  try {
    return await fs.realpath(path.resolve(target))
  } catch {
    return path.resolve(target)
  }
}

// The `worktree <path>` header of every record in `worktree list --porcelain
// -z` output, in order. NUL-delimited (-z) because POSIX directory names may
// contain newlines: a line-split parse would truncate such a path to a prefix,
// and two repositories differing only past the newline would then collide on
// one store key. Undefined when any record fails to parse — a store key must
// never be derived from a listing that was not fully understood.
function worktreePathsOf(porcelainZ: string): string[] | undefined {
  const paths: string[] = []
  let expectHeader = true
  for (const field of porcelainZ.split("\0")) {
    // An empty field is the blank record separator (-z turns the blank line
    // between records into consecutive NULs); the trailing NUL yields one too.
    if (field === "") {
      expectHeader = true
      continue
    }
    if (!expectHeader) continue
    if (!field.startsWith("worktree ")) return undefined
    const entry = field.slice("worktree ".length)
    if (!entry) return undefined
    paths.push(entry)
    expectHeader = false
  }
  return paths.length ? paths : undefined
}

/**
 * The primary worktree root of the repository that `root` is a worktree of,
 * or undefined when it cannot be established. Both persist-permissions halves
 * and approve-for-me key the shared ("repository"-scoped) store by
 * this directory, so its derivation lives here, next to the store-path
 * contract they already share.
 *
 * The store key crosses a trust boundary — the worktree is agent-writable and
 * its `.git` gitfile decides which repository every git read below sees — so
 * the probe demands a mutually consistent picture before answering:
 *   1. `rev-parse --show-toplevel` must name `root` itself. The callers pass
 *      the worktree root the OpenCode host derived for the session, so any
 *      disagreement means the probe discovered some OTHER repository — e.g.
 *      stray .git debris in an ancestor of a non-git project directory.
 *   2. `worktree list --porcelain -z` lists the primary worktree first (a
 *      bare primary lists the bare repository directory, which still names
 *      the family uniquely). The listing must parse completely, the primary
 *      must be an absolute path that canonicalizes (really exists), and
 *      `root` itself must appear among the listed worktrees — a `.git`
 *      gitfile forged to point into some other repository's worktree
 *      metadata yields a listing of THAT repository's worktrees, which does
 *      not contain `root`.
 *   3. `root` and the claimed primary must resolve to the same
 *      `--git-common-dir`: they are the same repository family, not merely
 *      two directories one crafted listing happens to mention.
 *
 * Undefined is always a safe answer: persist-permissions falls back to keying
 * by `root` (the historical per-worktree behavior, which only ever shares
 * less), and approve-for-me pauses.
 */
export async function discoverPrimaryRoot(
  root: string,
  git: ExecRunner = runGitCommand,
): Promise<string | undefined> {
  try {
    const canonicalRoot = await realpathOrResolve(root)
    const toplevel = await git(canonicalRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
    ])
    if (toplevel.code !== 0) return undefined
    const reported = toplevel.stdout.trim()
    if (!reported || (await realpathOrResolve(reported)) !== canonicalRoot)
      return undefined
    const listed = await git(canonicalRoot, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ])
    if (listed.code !== 0) return undefined
    const entries = worktreePathsOf(listed.stdout)
    if (!entries) return undefined
    // An empty list has no primary; guarding it also narrows the index type
    // (and avoids a latent `isAbsolute(undefined)` throw the mask hid).
    const primary = entries[0]
    if (primary === undefined || !path.isAbsolute(primary)) return undefined
    // The primary must really exist: realpath, not resolve-and-hope. A
    // truncated or fabricated path must not become a store key.
    let canonicalPrimary: string
    try {
      canonicalPrimary = await fs.realpath(primary)
    } catch {
      return undefined
    }
    let member = false
    for (const entry of entries) {
      if ((await realpathOrResolve(entry)) === canonicalRoot) {
        member = true
        break
      }
    }
    if (!member) return undefined
    if (
      canonicalPrimary !== canonicalRoot &&
      !(await sameRepository(canonicalRoot, canonicalPrimary, git))
    )
      return undefined
    return canonicalPrimary
  } catch {
    return undefined
  }
}

/**
 * The root of the git work tree containing `directory`, or undefined when git
 * does not confirm one. Consumers use this to verify the host's non-git
 * sentinel (an instance-context `worktree` of "/") before keying a store by
 * the bare session directory: that sentinel is host state, not ground truth —
 * it has been observed reaching plugin factories for sessions that ARE inside
 * linked worktrees, transiently at boot (2026-07-19, four processes; the
 * stores those sessions saved to silently regressed to per-worktree keying).
 * Asking git (instead of walking the filesystem for `.git`) means stray
 * debris like an empty `/tmp/.git` cannot claim ownership of unrelated
 * directories.
 *
 * Two checks make the answer a trustworthy store-key candidate, because
 * `directory` is agent-writable and everything git reports below it is
 * therefore attacker-influenced:
 *
 *   1. Containment — the reported work tree must contain `directory`. A
 *      hostile `.git` gitfile (or an environment redirecting git) naming an
 *      unrelated tree must not hand that tree out.
 *   2. Repository identity — `directory` and the reported top level must
 *      resolve to the same `--git-common-dir`. Containment alone is NOT
 *      enough: a nested repository can point its own `core.worktree` at an
 *      ancestor repository's checkout, and git then reports that ancestor as
 *      the nested repository's top level. The ancestor passes containment and
 *      is a self-consistent repository in its own right, so discoverPrimaryRoot
 *      validates it happily — the nested session would read and write the
 *      ancestor's approvals. Comparing the common dir keeps the repository the
 *      question was asked about and the repository the answer describes the
 *      same one.
 */
export async function discoverWorktreeRoot(
  directory: string,
  git: ExecRunner = runGitCommand,
): Promise<string | undefined> {
  try {
    const canonical = await realpathOrResolve(directory)
    const toplevel = await git(canonical, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
    ])
    if (toplevel.code !== 0) return undefined
    const reported = toplevel.stdout.trim()
    if (!reported || !path.isAbsolute(reported)) return undefined
    const canonicalReported = await realpathOrResolve(reported)
    if (!isInside(canonicalReported, canonical)) return undefined
    // Identity is trivially preserved when the top level IS the directory
    // asked about; only the handoff to a DIFFERENT directory can cross into
    // another repository.
    if (
      canonicalReported !== canonical &&
      !(await sameRepository(canonical, canonicalReported, git))
    )
      return undefined
    return canonicalReported
  } catch {
    return undefined
  }
}

// True when two directories are governed by the same repository — same
// `--git-common-dir` after canonicalization. Used wherever a git answer is
// carried from one working directory to another: the object store, not the
// path, is what "the same repository" means (a linked worktree and its
// primary checkout share one, which is exactly why they may share a store).
async function sameRepository(
  a: string,
  b: string,
  git: ExecRunner,
): Promise<boolean> {
  const [commonOfA, commonOfB] = await Promise.all([
    git(a, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(b, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ])
  if (commonOfA.code !== 0 || commonOfB.code !== 0) return false
  const reportedA = commonOfA.stdout.trim()
  const reportedB = commonOfB.stdout.trim()
  if (!reportedA || !reportedB) return false
  const [realA, realB] = await Promise.all([
    realpathOrResolve(reportedA),
    realpathOrResolve(reportedB),
  ])
  return realA === realB
}

/**
 * The user-level OpenCode config directory, resolved the way OpenCode itself
 * does: explicit `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`,
 * else `~/.config/opencode`.
 *
 * Derived rather than asked for: a config hook runs during instance
 * bootstrap, where asking the host over `/path` would deadlock, so it must
 * reach the same directory the host will. `env`/`homedir` are parameters —
 * not read from `process` here — so the derivation stays pure and the
 * installer can resolve a directory for a `--config-dir` run.
 */
export function resolveConfigDir(
  env: Record<string, string | undefined>,
  homedir: string,
): string {
  const explicit = env.OPENCODE_CONFIG_DIR?.trim()
  if (explicit) return explicit
  const xdg = env.XDG_CONFIG_HOME?.trim()
  if (xdg) return path.join(xdg, "opencode")
  return path.join(homedir, ".config", "opencode")
}

/**
 * The suite's per-project state key: sha256 of the project root, so parallel
 * projects never share a state file and the same project reaches the same file
 * from either plugin half.
 *
 * Two things this settles, because the eight copies it replaces had each
 * decided them separately (one of them by omission — approve-for-me's
 * instance-file key hashed its input unresolved, so two callers spelling the
 * same root differently keyed different files):
 *
 * - **`path.resolve`, not `canonicalPath`.** The key must be derivable by both
 *   halves without touching the filesystem: a realpath makes every path
 *   builder async, fails on a root that is momentarily unreadable, and moves
 *   the file when a symlink in the path changes — none of which a state-file
 *   name should depend on. Where the root IS a trust boundary, the keying
 *   layer canonicalizes before it gets here (see resolvePermissionStorePaths).
 * - **Full hex vs. a 16-char prefix.** Filenames take the prefix: every
 *   on-disk name now leads with a human-readable slug (see projectFileKey),
 *   and 64 bits is far past collision range for the handful of projects one
 *   machine holds. The full digest remains the derivation base — and the
 *   name pre-slug releases wrote, which the legacy adopters still derive.
 */
export function projectHash(projectRoot: string): string {
  return crypto
    .createHash("sha256")
    .update(path.resolve(projectRoot))
    .digest("hex")
}

/** projectHash's 16-char prefix — for filenames that carry their own label. */
export function shortProjectHash(projectRoot: string): string {
  return projectHash(projectRoot).slice(0, 16)
}

/**
 * The human-readable half of a project-keyed filename: the project root's
 * basename, reduced to filename-safe ASCII. Never unique on its own — that is
 * the hash suffix's job (see projectFileKey) — but it is what a person scans a
 * directory listing by, so a project's store can be found and hand-edited in a
 * pinch without first computing a sha256.
 *
 * Pure and synchronous for the same reason as projectHash: both plugin halves
 * must derive the same name without touching the filesystem.
 */
export function projectSlug(projectRoot: string): string {
  const slug = path
    .basename(path.resolve(projectRoot))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    // No leading dot (a hidden store file would defeat the readable name) and
    // no dangling separators; re-trimmed after the cap in case the cut lands
    // mid-run. 40 characters keeps the whole name comfortably scannable.
    .replace(/^[-.]+/, "")
    .slice(0, 40)
    .replace(/[-.]+$/, "")
  return slug || "project"
}

/**
 * `<slug>-<hash16>` — the filename key for every project-keyed file the suite
 * writes. The slug tells a human WHICH project the file belongs to; the hash
 * prefix keeps two projects that share a basename apart and survives the slug
 * being lossy. Uniqueness rests entirely on the hash: the slug is display
 * only, and nothing may parse it back out of a filename.
 */
export function projectFileKey(projectRoot: string): string {
  return `${projectSlug(projectRoot)}-${shortProjectHash(projectRoot)}`
}

/**
 * `<dir>/<service>/<bucket>/<slug>-<hash16>.json` — the layout every
 * project-keyed file in a plugin's own config- or state-directory subtree
 * uses. `dir` is OpenCode's config or state directory; the plugin never writes
 * outside its own `service` subtree of it. Pre-slug releases named these files
 * by the full project hash alone; legacyProjectScopedFile still derives that
 * name so adoptLegacyProjectScopedFile can move one to its readable name.
 */
export function projectScopedFile(input: {
  dir: string
  service: string
  bucket: string
  projectRoot: string
}): string {
  return path.join(
    input.dir,
    input.service,
    input.bucket,
    `${projectFileKey(input.projectRoot)}.json`,
  )
}

/** The name pre-slug releases gave projectScopedFile's file: the bare hash. */
export function legacyProjectScopedFile(input: {
  dir: string
  service: string
  bucket: string
  projectRoot: string
}): string {
  return path.join(
    input.dir,
    input.service,
    input.bucket,
    `${projectHash(input.projectRoot)}.json`,
  )
}

/** The outcome of one legacy-name adoption attempt. */
export type LegacyAdoptionOutcome =
  /** No pre-slug file remains — none ever existed, or a peer already moved it. */
  | "absent"
  /** THIS call moved the pre-slug file to its readable name. */
  | "adopted"
  /** Both names exist. No contents were moved: the readable name stays
   *  authoritative for plain reads, and the pre-slug file is left for the
   *  caller's reconciliation — never merged blind, never deleted. A supplied
   *  mode ceiling may still remove overly broad permission bits. */
  | "conflict"
  /** A fault (untrusted path, lock contention, unwritable directory) or a
   *  non-file squatting on the legacy name. No contents were moved. */
  | "error"

/**
 * Move a project-keyed file from its pre-slug name (`<hash64>.json`) to the
 * readable `<slug>-<hash16>.json` name, byte for byte, mode preserved unless
 * the caller supplies a restrictive write policy.
 *
 * The move happens only after the containing directory chain is proven to
 * still resolve inside `dir`: with a pre-slug file present, a descendant
 * symlink redirecting the service subtree (say, into the project) yields
 * "error" with the disk untouched, instead of a copy performed through the
 * untrusted link and a delete of the original behind it.
 *
 * The copy runs under BOTH names' store locks. The destination's, because
 * every writer that can CREATE the destination holds that lock across its
 * read-modify-write, so the missing-destination check cannot race one of them
 * into replacing a fresh store with legacy bytes. The SOURCE's, because a
 * still-running pre-slug release writes under the lock derived from the
 * LEGACY filename: without it that writer could atomically replace the legacy
 * file between this transaction's read and its rm, and the newer store would
 * be deleted unread. Adoption is the only path that takes two store locks —
 * always destination first — so it cannot deadlock with either generation's
 * single-lock writers.
 *
 * "conflict" and "error" both mean unresolved pre-upgrade data may remain at
 * the legacy name. Callers must not treat the readable name as the whole
 * story then: the permission-store fold machinery lists pre-slug names as
 * migration candidates (see storeMigrationCandidates), and other consumers
 * check the legacy name per access and fail closed or warn while it exists.
 */
export async function adoptLegacyProjectScopedFile(input: {
  dir: string
  service: string
  bucket: string
  projectRoot: string
  modes?: WriteFileModes
}): Promise<LegacyAdoptionOutcome> {
  const legacy = legacyProjectScopedFile(input)
  const current = projectScopedFile(input)
  // lstat, not stat: a symlink squatting on the legacy name is not a file a
  // pre-slug release wrote, and following it would copy whatever it points at
  // into the store directory under a trusted name.
  let planted: Awaited<ReturnType<typeof fs.lstat>>
  try {
    planted = await fs.lstat(legacy)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "absent"
      : "error"
  }
  if (!planted.isFile()) return "error"
  try {
    // Both names share one parent directory; prove it still resolves inside
    // the trusted base before creating the lock files, let alone the copy.
    const [realBase, realBucket] = await Promise.all([
      canonicalPath(input.dir),
      canonicalPath(path.dirname(current)),
    ])
    if (!isInside(realBase, realBucket)) return "error"
    return await withStoreLock(
      current,
      (currentLease) =>
        withStoreLock(
          legacy,
          async (legacyLease): Promise<LegacyAdoptionOutcome> => {
            // Re-checked under the locks: a peer may have completed this very
            // adoption — or the legacy writer removed its file — while we waited.
            let held: Awaited<ReturnType<typeof fs.lstat>>
            try {
              held = await fs.lstat(legacy)
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "absent"
                : "error"
            }
            if (!held.isFile()) return "error"
            let sourceMode = held.mode & 0o7777
            if (input.modes?.fileModeLimit !== undefined) {
              const restricted = await restrictPathMode(
                legacy,
                input.modes.fileModeLimit,
              )
              if (restricted === undefined) return "absent"
              sourceMode = restricted
            }
            if ((await pathExists(current)) !== false) {
              if (input.modes?.fileModeLimit !== undefined)
                await restrictPathMode(current, input.modes.fileModeLimit)
              return "conflict"
            }
            const text = await fs.readFile(legacy, "utf8")
            const beforePublish = input.modes?.beforePublish
            await writeTextFile(current, text, {
              ...input.modes,
              fileMode:
                input.modes?.fileModeLimit === undefined
                  ? sourceMode
                  : sourceMode & input.modes.fileModeLimit,
              beforePublish: async () => {
                await beforePublish?.()
                await currentLease.assertHeld()
                await legacyLease.assertHeld()
              },
            })
            await currentLease.assertHeld()
            await legacyLease.assertHeld()
            await fs.rm(legacy, { force: true })
            return "adopted"
          },
          { modes: input.modes },
        ),
      { modes: input.modes },
    )
  } catch {
    // Contention, a lock fault, or an unwritable directory: leave both names
    // and their contents in place and let a later resolution retry.
    return "error"
  }
}

// Persistent permission rules are authorization state, so the canonical
// project store lives in OpenCode's trusted config directory rather than the
// agent-writable worktree. The full canonical project-root hash avoids
// collisions while keeping the file name stable across OpenCode sessions.
export function permissionStoreFile(
  configDir: string,
  projectRoot: string,
): string {
  return projectScopedFile({
    dir: configDir,
    service: PERMISSIONS_STORE_DIRECTORY,
    bucket: "projects",
    projectRoot,
  })
}

// Pre-trust-boundary releases wrote here. Consumers detect this path only to
// require a user-reviewed migration; they never import it automatically.
export function legacyPermissionStoreFile(projectRoot: string): string {
  return path.join(projectRoot, ".opencode", PERMISSIONS_STORE_BASENAME)
}

/** The name pre-slug releases gave permissionStoreFile's file: the bare hash.
 * ("Legacy" already names the older, in-project store above, hence pre-slug.) */
export function preSlugPermissionStoreFile(
  configDir: string,
  projectRoot: string,
): string {
  return legacyProjectScopedFile({
    dir: configDir,
    service: PERMISSIONS_STORE_DIRECTORY,
    bucket: "projects",
    projectRoot,
  })
}

export function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

// Resolve the nearest existing ancestor so symlinks at any level participate
// in the containment check even before the final store path exists.
export async function canonicalPath(file: string): Promise<string> {
  let current = path.resolve(file)
  const missing: string[] = []
  while (true) {
    try {
      return path.join(await fs.realpath(current), ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      try {
        const entry = await fs.lstat(current)
        // realpath reports a dangling symlink as ENOENT too. It is not a
        // missing path we may safely append: its target could later appear
        // in agent-writable space after this one-time trust check.
        if (entry.isSymbolicLink())
          throw new Error(`dangling symlink in trusted path: ${current}`)
      } catch (lstatError) {
        if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT")
          throw lstatError
      }
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.push(path.basename(current))
      current = parent
    }
  }
}

export type PermissionStorePaths = {
  projectRoot: string
  /** The root the active store is keyed by: keyRoot when given, else projectRoot. */
  keyRoot: string
  storeFile: string
  legacyStoreFile: string
  /**
   * The store keyed by the session's own worktree root, set only when it names
   * a different file than storeFile (i.e. keyRoot re-keyed a linked worktree).
   * persist-permissions migrates it into storeFile; approve-for-me
   * folds any rules still in it into its vetoes.
   */
  worktreeStoreFile?: string
  /**
   * Stores keyed by roots this session used EARLIER and no longer does —
   * created when keying was still unestablished (see createStoreKeyingResolver)
   * and a save landed under the interim key. Without them a re-key would
   * orphan those approvals: the session's own worktree root is not the
   * directory an unconfirmed keying fell back to. Migration candidates only;
   * never the active store.
   */
  staleStoreFiles?: string[]
  /**
   * The pre-slug (bare-hash) NAMES earlier releases gave every store above,
   * deduped — names, not findings: a file need not exist there now. Adoption
   * normally empties these during resolution, but a file present at one
   * afterwards is unresolved pre-upgrade authorization state — adoption
   * failed or hit a dual-name conflict, or a still-running older release
   * recreated it AFTER this resolution settled. Consumers must check
   * existence per access and never let the readable name silently shadow it:
   * the fold machinery lists these as migration candidates
   * (storeMigrationCandidates) so rules are merged in or persistence pauses
   * for review, and veto readers treat their carve-outs as live input.
   */
  preSlugStoreFiles?: string[]
}

// Validate both the directory root and the fully derived descendants. A
// config directory inside the project, or a descendant symlink escaping the
// config directory (especially back into the project), is not trusted.
// `keyRoot`, when given, is the directory the store is keyed by — the primary
// worktree root of the session's repository (see discoverPrimaryRoot) — and
// every trust check then covers both roots: the store must sit outside the
// session's worktree AND outside the primary checkout, inside the config dir.
export async function resolvePermissionStorePaths(
  projectRoot: string,
  configDir: string,
  keyRoot?: string,
  /** Roots this session keyed by earlier; their stores become migration
   *  candidates (see PermissionStorePaths.staleStoreFiles). */
  staleRoots: string[] = [],
): Promise<PermissionStorePaths | undefined> {
  try {
    const [realRoot, realConfig, realKey] = await Promise.all([
      canonicalPath(projectRoot),
      canonicalPath(configDir),
      canonicalPath(keyRoot ?? projectRoot),
    ])
    const realStale: string[] = []
    for (const stale of staleRoots) {
      const real = await canonicalPath(stale)
      if (real === realRoot || real === realKey || realStale.includes(real))
        continue
      realStale.push(real)
    }
    // Every root the session has keyed by is checked, not just the active
    // pair: a stale candidate is read, merged, and DELETED, so it has to clear
    // the same trust bar as the store it feeds.
    const roots = [
      realRoot,
      ...(realKey === realRoot ? [] : [realKey]),
      ...realStale,
    ]
    const storeFile = await canonicalPath(
      permissionStoreFile(realConfig, realKey),
    )
    const worktreeStoreFile =
      realKey === realRoot
        ? undefined
        : await canonicalPath(permissionStoreFile(realConfig, realRoot))
    const staleStoreFiles: string[] = []
    for (const real of realStale) {
      const file = await canonicalPath(permissionStoreFile(realConfig, real))
      if (
        file === storeFile ||
        file === worktreeStoreFile ||
        staleStoreFiles.includes(file)
      )
        continue
      staleStoreFiles.push(file)
    }
    // The pre-slug names clear the same trust bar as the readable ones: a
    // fold candidate is read, merged, and DELETED, and adoption below moves
    // bytes between the two name generations, so neither may act through a
    // name that escapes the config directory or enters the project.
    const preSlugStoreFiles: string[] = []
    for (const root of roots) {
      const file = await canonicalPath(
        preSlugPermissionStoreFile(realConfig, root),
      )
      if (!preSlugStoreFiles.includes(file)) preSlugStoreFiles.push(file)
    }
    for (const file of [
      storeFile,
      ...(worktreeStoreFile ? [worktreeStoreFile] : []),
      ...staleStoreFiles,
      ...preSlugStoreFiles,
    ]) {
      if (!isInside(realConfig, file)) return undefined
      if (
        roots.some((root) => isInside(root, realConfig) || isInside(root, file))
      )
        return undefined
    }
    // Stores still sitting under the pre-slug names are adopted in place only
    // AFTER every derived path — the pre-slug names included — has passed the
    // trust checks above: adoption mutates the store directory, and a
    // resolution this function is about to reject must leave the disk exactly
    // as it found it. The adopter re-proves containment itself (other callers
    // reach it without this resolver) and swallows its own failures; a file
    // that remains at a pre-slug name afterwards — a failed adoption, or both
    // names live because an older release's half wrote the legacy name again —
    // stays visible to every consumer through preSlugStoreFiles instead of
    // being silently shadowed by the readable name.
    for (const root of roots) {
      await adoptLegacyProjectScopedFile({
        dir: realConfig,
        service: PERMISSIONS_STORE_DIRECTORY,
        bucket: "projects",
        projectRoot: root,
        modes: OWNER_ONLY_WRITE_MODES,
      })
    }
    return {
      projectRoot: realRoot,
      keyRoot: realKey,
      storeFile,
      legacyStoreFile: legacyPermissionStoreFile(realRoot),
      ...(worktreeStoreFile ? { worktreeStoreFile } : {}),
      ...(staleStoreFiles.length ? { staleStoreFiles } : {}),
      ...(preSlugStoreFiles.length ? { preSlugStoreFiles } : {}),
    }
  } catch {
    return undefined
  }
}

/** The store keying resolved for a session: trusted paths plus whether the
 * active store is the repository-shared one. */
export type StoreKeying = {
  paths: PermissionStorePaths
  /**
   * True when the active store is shared repository-wide: repository scope
   * with the primary worktree root established (a session in the primary
   * checkout establishes it trivially). False under worktree scope, under
   * the probe-failure fallback, and for non-git sessions — the wording a
   * consumer shows for a save should say which reach the rule really has.
   */
  shared: boolean
  /** True once keying is final; later resolves return this same value. */
  settled: boolean
  /**
   * True when git CONFIRMS this session sits inside a work tree but the
   * repository-shared key could not be established, so the returned paths are
   * a narrower fallback while a shared store exists and is unreachable.
   * Writing to the fallback is safe (it shares less, and the
   * caller's migration folds it in on a later re-key), but AUTHORIZATION READS
   * are not: the two stores are independent last-match-wins rulesets, so an
   * allow in the fallback can auto-approve something the shared store's
   * ask/deny carve-out would have vetoed. Consumers must fail closed on reads
   * while this is true. False for non-git sessions and for a host-named root
   * git does not recognize as a work-tree root — no repository means no
   * shared store to miss.
   */
  unkeyedShared: boolean
}

export type StoreKeyingResolver = (
  configDir: string,
  access?: { write?: boolean },
) => Promise<StoreKeying | undefined>

/**
 * A store-keying resolver that does not trust the host's non-git sentinel and
 * does not let a boot-time git failure choose the store key for the process
 * lifetime. Both persist-permissions halves create one with the same inputs,
 * so they cannot drift apart.
 *
 * Two failure legs, both observed 2026-07-19 (four OpenCode processes handed
 * plugin factories `worktree: "/"` for sessions inside linked worktrees while
 * plugin-side git probing also failed at boot; git recovered within seconds):
 *
 *  - A host claim of "no work tree" is verified with discoverWorktreeRoot
 *    before the store is keyed by the bare session directory.
 *  - Keying settles only when git POSITIVELY confirmed the situation: the
 *    primary root established under repository scope, or the work tree
 *    confirmed under worktree scope. Until then every resolve may re-derive —
 *    writes always, reads at most once per `retryIntervalMs` — and a late
 *    success swaps the returned paths, so saves that landed under the interim
 *    fallback keying are folded in by the caller's normal worktree-store
 *    migration (its memo must be keyed by `paths.storeFile`).
 *
 * While unestablished the resolver still returns the current-best fallback
 * (keyed by the work-tree root when known, else the directory): sharing less
 * is safe to WRITE, and for a genuinely non-git project the retry cost is one
 * `git rev-parse` per interval. It is not safe to read authorization from when
 * a shared store demonstrably exists — see StoreKeying.unkeyedShared, which
 * marks exactly that leg so callers can fail their read paths closed.
 * `onProbeFallback` fires at most once, on the first probe failure for a
 * git-confirmed work tree; `onShared` fires at most once, when the repository
 * keying is established (`late` = by a retry, not the first attempt).
 *
 * Every root the resolver keys by is remembered, so a re-key exposes the
 * earlier fallback stores as migration candidates (staleStoreFiles) rather
 * than orphaning whatever was saved under them.
 */
export function createStoreKeyingResolver(input: {
  scope: StoreScope
  directory: string
  /** Host-provided work-tree root; "/" and empty mean the host claims non-git. */
  worktree: string | undefined
  git?: ExecRunner
  retryIntervalMs?: number
  now?: () => number
  onProbeFallback?: () => void
  onShared?: (keyRoot: string, root: string, late: boolean) => void
}): StoreKeyingResolver {
  const git = input.git ?? runGitCommand
  const now = input.now ?? Date.now
  const interval = input.retryIntervalMs ?? 15_000
  const hostWorktree =
    input.worktree && input.worktree !== "/" ? input.worktree : undefined

  let root: string | undefined
  let gitConfirmed = false
  // True when git ITSELF placed `root` in a work tree (as opposed to the host
  // naming it, which is trusted for keying but proves nothing about git).
  let worktreeVerified = false
  // Every root this resolver has keyed by. A fallback key that a later re-key
  // replaces must stay known: saves that landed under it are only reachable as
  // migration candidates, and the session's own worktree root does not name
  // them (the fallback may have keyed by a SUBDIRECTORY — the session
  // directory — when git could not confirm a work tree at all).
  const keyedRoots = new Set<string>()
  // undefined = not settled; null = settled distrusted (deterministic inputs
  // that resolvePermissionStorePaths rejected).
  let settled: StoreKeying | null | undefined
  let last: StoreKeying | undefined
  let lastDistrusted = false
  let inflight: Promise<StoreKeying | undefined> | undefined
  let lastAttemptAt: number | undefined
  let warnedFallback = false
  let announcedShared = false
  let attempted = false

  const attempt = async (
    configDir: string,
  ): Promise<StoreKeying | undefined> => {
    const late = attempted
    attempted = true
    try {
      if (!gitConfirmed) {
        if (hostWorktree) {
          // A host that NAMES a work tree is trusted, as before this resolver
          // existed — test harnesses deliberately hand non-git directories
          // here, and the primary probe below re-validates real ones anyway.
          root = hostWorktree
          gitConfirmed = true
        } else {
          const derived = await discoverWorktreeRoot(input.directory, git)
          if (derived) {
            root = derived
            gitConfirmed = true
            worktreeVerified = true
          } else {
            root = input.directory
          }
        }
      }
      let keyRoot: string | undefined
      let unkeyedShared = false
      if (gitConfirmed && input.scope === "repository") {
        keyRoot = await discoverPrimaryRoot(root as string, git)
        if (keyRoot) {
          if (!announcedShared) {
            announcedShared = true
            input.onShared?.(keyRoot, root as string, late)
          }
        } else {
          // Distinguish "a repository exists and its shared store is
          // unreachable right now" from "there is no repository here at all".
          // Only the first must fail authorization reads closed; harnesses
          // hand plain directories here, and the fallback IS the right answer
          // for those, so their reads must keep working. A root derived from
          // git is already known to be in a work tree; a HOST-NAMED one is the
          // only claim that still needs checking.
          unkeyedShared =
            worktreeVerified ||
            Boolean(await discoverWorktreeRoot(root as string, git))
          if (!warnedFallback) {
            warnedFallback = true
            input.onProbeFallback?.()
          }
        }
      }
      keyedRoots.add(root as string)
      const paths = await resolvePermissionStorePaths(
        root as string,
        configDir,
        keyRoot,
        [...keyedRoots],
      )
      const final =
        gitConfirmed && (input.scope === "worktree" || Boolean(keyRoot))
      const keying = paths
        ? { paths, shared: Boolean(keyRoot), settled: final, unkeyedShared }
        : undefined
      if (final) settled = keying ?? null
      last = keying
      lastDistrusted = !keying
      return keying
    } catch {
      // The helpers above swallow their own failures; this is a backstop so
      // one unexpected throw reads as "not trusted this time", retried later,
      // rather than rejecting into a permission hook.
      lastDistrusted = true
      return undefined
    }
  }

  return async (configDir, access) => {
    const write = access?.write === true
    for (;;) {
      if (settled !== undefined) return settled ?? undefined
      if (inflight) {
        const joined = await inflight
        // A write must not inherit an unsettled answer from a probe that was
        // already in flight when it arrived: that probe may have read git
        // BEFORE git recovered, and the write is the moment a mis-keyed store
        // becomes durable state. Loop back and re-derive with its own attempt.
        if (!write || joined?.settled) return joined
        continue
      }
      const due =
        lastAttemptAt === undefined ||
        write ||
        now() - lastAttemptAt >= interval
      if (!due) return lastDistrusted ? undefined : last
      lastAttemptAt = now()
      const attempting = attempt(configDir).finally(() => {
        if (inflight === attempting) inflight = undefined
      })
      inflight = attempting
      return attempting
    }
  }
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  migrateWorktreeStore,
  type StoreMigration,
  withStoreLock,
} from "../src/index"

/**
 * The cross-process store lock serializes every read-modify-write against a
 * permission store. Its contract: mutual exclusion while a holder runs, a
 * crashed holder's leftover lock is broken after `staleMs`, a live holder
 * makes waiters time out (never proceed unlocked), and the lock is released
 * on both success and failure.
 */

let dir: string
let store: string

beforeEach(async () => {
  dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "store-lock-")),
  )
  store = path.join(dir, "permissions.json")
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("withStoreLock", () => {
  test("serializes concurrent holders", async () => {
    const events: string[] = []
    const hold = (name: string) =>
      withStoreLock(store, async () => {
        events.push(`${name}:enter`)
        await new Promise((resolve) => setTimeout(resolve, 20))
        events.push(`${name}:exit`)
      })
    await Promise.all([hold("a"), hold("b")])
    // Whichever entered first must exit before the other enters.
    expect(events[1]).toBe(`${events[0]!.split(":")[0]}:exit`)
    expect(events).toHaveLength(4)
  })

  test("returns the callback's value and releases the lock", async () => {
    expect(await withStoreLock(store, async () => 42)).toBe(42)
    expect(
      (await fs.readdir(dir)).filter((f) => f.endsWith(".lock")),
    ).toHaveLength(0)
  })

  test("releases the lock when the callback throws", async () => {
    await expect(
      withStoreLock(store, async () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom")
    expect(
      (await fs.readdir(dir)).filter((f) => f.endsWith(".lock")),
    ).toHaveLength(0)
    // A later holder is not blocked by the failed one.
    expect(await withStoreLock(store, async () => "after")).toBe("after")
  })

  test("times out instead of proceeding when a live holder keeps the lock", async () => {
    await fs.writeFile(`${store}.lock`, "held\n")
    await expect(
      withStoreLock(store, async () => "never", { timeoutMs: 80, pollMs: 10 }),
    ).rejects.toThrow("locked by another process")
    await fs.rm(`${store}.lock`)
  })

  test("breaks a stale lock left by a crashed holder", async () => {
    await fs.writeFile(`${store}.lock`, "crashed\n")
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(`${store}.lock`, old, old)
    expect(
      await withStoreLock(store, async () => "reclaimed", {
        timeoutMs: 500,
        staleMs: 10_000,
      }),
    ).toBe("reclaimed")
    expect(
      (await fs.readdir(dir)).filter((f) => f.endsWith(".lock")),
    ).toHaveLength(0)
  })

  test("names the caller's subject in the timeout error", async () => {
    await fs.writeFile(`${store}.lock`, "held\n")
    await expect(
      withStoreLock(store, async () => "never", {
        timeoutMs: 40,
        pollMs: 10,
        label: "this repository's worktree state",
      }),
    ).rejects.toThrow(
      "this repository's worktree state is locked by another process",
    )
    await fs.rm(`${store}.lock`)
  })
})

/**
 * Long holds. The worktree plugin holds this lock across `git worktree remove`
 * of a real checkout, which can outlast any staleMs short enough to recover
 * promptly from a real crash. The heartbeat is what lets those two live
 * together; the lease and the token-checked release are what keep a hold that
 * was lost anyway from doing damage.
 */
describe("withStoreLock long holds", () => {
  test("a heartbeat keeps a live hold from being broken as stale", async () => {
    let peerSaw: string | undefined
    const value = await withStoreLock(
      store,
      async () => {
        // Longer than staleMs: without the heartbeat the peer below would find
        // the lock stale, break it, and run concurrently with this holder.
        await new Promise((resolve) => setTimeout(resolve, 220))
        peerSaw = await withStoreLock(store, async () => "peer-got-in", {
          timeoutMs: 30,
          pollMs: 10,
          staleMs: 100,
        }).catch((error: Error) => error.message)
        return "held-throughout"
      },
      { staleMs: 100, heartbeatMs: 20 },
    )
    expect(value).toBe("held-throughout")
    expect(peerSaw).toContain("locked by another process")
  })

  test("without a heartbeat the same hold IS broken as stale", async () => {
    // The discriminator for the test above: same timings, heartbeat removed.
    let peerSaw: string | undefined
    await withStoreLock(
      store,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 220))
        peerSaw = await withStoreLock(store, async () => "peer-got-in", {
          timeoutMs: 30,
          pollMs: 10,
          staleMs: 100,
        }).catch((error: Error) => error.message)
      },
      { staleMs: 100 },
    )
    expect(peerSaw).toBe("peer-got-in")
  })

  test("the lease reports a hold broken by a peer", async () => {
    const seen: boolean[] = []
    await withStoreLock(
      store,
      async (lease) => {
        seen.push(await lease.held())
        // Simulate a peer breaking this hold as stale and taking the lock.
        await fs.writeFile(`${store}.lock`, "someone-else\n")
        seen.push(await lease.held())
        await expect(lease.assertHeld()).rejects.toThrow(
          "lock was lost to another process",
        )
      },
      { staleMs: 10_000 },
    )
    expect(seen).toEqual([true, false])
    // The peer's lock survived: releasing a hold we no longer own must not
    // delete the successor's lock file.
    expect(await fs.readFile(`${store}.lock`, "utf8")).toBe("someone-else\n")
    await fs.rm(`${store}.lock`)
  })

  test("a normal hold still removes its own lock on release", async () => {
    await withStoreLock(store, async (lease) =>
      expect(await lease.held()).toBe(true),
    )
    expect(
      (await fs.readdir(dir)).filter((f) => f.endsWith(".lock")),
    ).toHaveLength(0)
  })

  /**
   * Acquisition must TERMINATE. `wx` reports EEXIST for a symlink, while the
   * staleness check used to `stat` (following it) and hit ENOENT, then `continue`
   * past both the deadline and the poll — an unbounded busy-spin that never timed
   * out and burned a core, defeating the contract every caller relies on ("a
   * failed acquire throws; it is never permission to proceed unlocked").
   */
  test("a dangling symlink at the lock path fails fast instead of spinning", async () => {
    await fs.symlink(path.join(dir, "nowhere"), `${store}.lock`)
    const started = Date.now()
    await expect(
      withStoreLock(store, async () => "unreachable", {
        timeoutMs: 50,
        pollMs: 5,
      }),
    ).rejects.toThrow("lock path is not a regular file")
    // Well under the 2s an unbounded spin would blow past; this must not even
    // reach the 50ms deadline, since the path is rejected on the first pass.
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("a directory at the lock path fails fast instead of spinning", async () => {
    await fs.mkdir(`${store}.lock`)
    await expect(
      withStoreLock(store, async () => "unreachable", {
        timeoutMs: 50,
        pollMs: 5,
      }),
    ).rejects.toThrow("lock path is not a regular file")
  })

  /**
   * Stale takeover must unlink the file it JUDGED stale, not whatever answers to
   * the pathname later. Two waiters routinely judge the same abandoned lock
   * stale within one poll cycle; if the second removes by pathname it deletes
   * the fresh lock the first just created, and both run as holders.
   */
  test("a stale break stands down when the lock was already replaced", async () => {
    // An aged lock, so the waiter genuinely reaches the stale-break branch —
    // the branch under test. Replacing the file BEFORE the call would leave a
    // fresh mtime, the staleness check would be false, and the identity guard
    // would never run at all: the test would pass with or without the fix.
    await fs.writeFile(`${store}.lock`, "99999\ndead\n")
    const aged = new Date(Date.now() - 60_000)
    await fs.utimes(`${store}.lock`, aged, aged)

    // Substitute the successor's lock in the exact window the guard protects:
    // between the staleness verdict and the unlink. The acquisition loop lstats
    // twice per pass — once to judge, once to re-verify identity — so swapping
    // the file on the re-verify is precisely the interleaving where a peer
    // broke this lock and retook it. rm + create gives the successor a new
    // inode, which is what the guard must notice.
    const real = fs.lstat.bind(fs)
    let calls = 0
    const spy = (async (target: never, opts: never) => {
      calls += 1
      // Swap BEFORE the re-verify observes the path, so that call sees the
      // successor — the whole point is that the file changed since the verdict.
      if (calls === 2) {
        await fs.rm(`${store}.lock`)
        await fs.writeFile(`${store}.lock`, "12345\nsuccessor\n")
      }
      return await real(target, opts)
    }) as unknown as typeof fs.lstat
    ;(fs as { lstat: typeof fs.lstat }).lstat = spy
    try {
      // The successor's lock is live, so acquisition must time out rather than
      // delete it. Without the identity check the unlink removes the successor
      // and this call ACQUIRES — two processes holding at once, which is F1.
      await expect(
        withStoreLock(store, async () => "unreachable", {
          timeoutMs: 80,
          pollMs: 10,
          staleMs: 30_000,
        }),
      ).rejects.toThrow("is locked by another process")
    } finally {
      ;(fs as { lstat: typeof fs.lstat }).lstat = real
    }
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(await fs.readFile(`${store}.lock`, "utf8")).toBe(
      "12345\nsuccessor\n",
    )
  })

  test("a genuinely stale lock is still broken and retaken", async () => {
    await fs.writeFile(`${store}.lock`, "99999\ncrashed\n")
    const aged = new Date(Date.now() - 60_000)
    await fs.utimes(`${store}.lock`, aged, aged)
    expect(
      await withStoreLock(store, async () => "taken", {
        timeoutMs: 2_000,
        pollMs: 10,
        staleMs: 1_000,
      }),
    ).toBe("taken")
    expect(
      (await fs.readdir(dir)).filter((f) => f.endsWith(".lock")),
    ).toHaveLength(0)
  })
})

/**
 * The fold's lock discipline (#126). migrateWorktreeStore holds BOTH stores'
 * locks across its read→merge→write→delete, so a save landing in the source
 * under that file's lock can never fall inside the fold's read→rm span and be
 * deleted unread. And because a hold is not a lease for the whole pass — a
 * peer can break it as stale and take the lock — the fold re-asserts every
 * hold immediately before each destructive step and stands down when one was
 * lost, instead of writing or deleting on the strength of a hold it no longer
 * owns.
 */
describe("migrateWorktreeStore lock discipline", () => {
  let shared: string
  let worktree: string

  beforeEach(() => {
    shared = path.join(dir, "shared.json")
    worktree = path.join(dir, "worktree.json")
  })

  const writeRules = (file: string, patterns: Record<string, string>) =>
    fs.writeFile(file, JSON.stringify({ permission: { bash: patterns } }))

  const readRules = async (file: string) =>
    (
      JSON.parse(await fs.readFile(file, "utf8")) as {
        permission: { bash: Record<string, string> }
      }
    ).permission.bash

  const exists = (file: string) =>
    fs.access(file).then(
      () => true,
      () => false,
    )

  test("a save under the source's lock during the fold is merged, not lost", async () => {
    await writeRules(worktree, { "git status": "allow" })
    let fold: Promise<StoreMigration> | undefined
    await withStoreLock(worktree, async () => {
      // Start the fold while a writer holds the source's lock. The fold must
      // queue behind the save: a fold that read the source without its lock
      // would merge the pre-save rule set, write the destination, and delete
      // the source, and the save below would never reach either store.
      fold = migrateWorktreeStore(shared, worktree)
      // Wait until the fold provably holds the destination's lock — from
      // there its next step is acquiring the source's. A fixed delay from
      // the fold's START would race the fold's own startup: on a loaded
      // runner the save could land before a hypothetically lockless fold
      // ever read the source, and the test would pass without exercising
      // the serialization it claims. The barrier pins that interleaving;
      // the short delay after it exists only to let such a lockless fold
      // reach its read first and fail the assertions below.
      while (!(await exists(`${shared}.lock`)))
        await new Promise((resolve) => setTimeout(resolve, 5))
      await new Promise((resolve) => setTimeout(resolve, 50))
      // The save's read-modify-write: the rule set grows by one.
      await writeRules(worktree, {
        "git status": "allow",
        "git diff": "allow",
      })
      // Still queued behind this hold: a fold already resolved here finished
      // without ever waiting on the source's lock.
      expect(
        await Promise.race([
          fold,
          new Promise((resolve) => setTimeout(() => resolve("queued"), 0)),
        ]),
      ).toBe("queued")
    })
    expect(await fold!).toEqual({ outcome: "merged", added: 2, removed: true })
    expect(await readRules(shared)).toEqual({
      "git status": "allow",
      "git diff": "allow",
    })
    expect(await exists(worktree)).toBe(false)
  })

  test("a hold broken before the removal stands the fold down instead of deleting", async () => {
    await writeRules(worktree, { "git status": "allow" })
    const result = await migrateWorktreeStore(shared, worktree, {
      beforeRemove: async () => {
        // A peer judged the source hold stale, broke it, and took the lock:
        // from this moment it may legitimately save into the source, and the
        // fold's merge read no longer covers the file it is about to delete.
        await fs.writeFile(`${worktree}.lock`, "someone-else\n")
      },
    })
    // The merge that landed stays durable; the removal stands down, and
    // removed: false makes the caller re-run the pass, which re-reads
    // whatever the new holder saved.
    expect(result).toEqual({ outcome: "merged", added: 1, removed: false })
    expect(await readRules(shared)).toEqual({ "git status": "allow" })
    expect(await exists(worktree)).toBe(true)
  })

  test("migration preserves arbitrary literal permission and pattern keys", async () => {
    const names = ["__proto__", "constructor", "toString"]
    const patterns = Object.fromEntries(names.map((name) => [name, "allow"]))
    const permission = Object.fromEntries(names.map((name) => [name, patterns]))
    await fs.writeFile(worktree, JSON.stringify({ permission }))

    expect(await migrateWorktreeStore(shared, worktree)).toEqual({
      outcome: "merged",
      added: names.length * names.length,
      removed: true,
    })
    const migrated = JSON.parse(await fs.readFile(shared, "utf8")) as {
      permission: Record<string, Record<string, string>>
    }
    for (const permissionName of names) {
      expect(Object.hasOwn(migrated.permission, permissionName)).toBe(true)
      for (const pattern of names) {
        expect(
          Object.hasOwn(migrated.permission[permissionName]!, pattern),
        ).toBe(true)
        expect(migrated.permission[permissionName]![pattern]).toBe("allow")
      }
    }
  })

  test("migration creates a private destination and inherits stricter source modes under umask 022", async () => {
    if (process.platform === "win32") return
    const previous = process.umask(0o022)
    try {
      await writeRules(worktree, { "git status": "allow" })
      await fs.chmod(worktree, 0o644)
      await fs.chmod(dir, 0o755)
      expect(await migrateWorktreeStore(shared, worktree)).toEqual({
        outcome: "merged",
        added: 1,
        removed: true,
      })
      expect((await fs.stat(shared)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700)

      const strictSource = path.join(dir, "strict-source.json")
      const strictDestination = path.join(dir, "strict-destination.json")
      await writeRules(strictSource, { "git diff": "allow" })
      await fs.chmod(strictSource, 0o400)
      expect(
        await migrateWorktreeStore(strictDestination, strictSource),
      ).toEqual({ outcome: "merged", added: 1, removed: true })
      expect((await fs.stat(strictDestination)).mode & 0o777).toBe(0o400)
    } finally {
      process.umask(previous)
    }
  })

  test("migration restricts broad destinations without widening stricter ones under umask 022", async () => {
    if (process.platform === "win32") return
    const previous = process.umask(0o022)
    try {
      await writeRules(shared, { "git status": "allow" })
      await fs.chmod(shared, 0o644)
      await writeRules(worktree, { "git diff": "allow" })
      await migrateWorktreeStore(shared, worktree)
      expect((await fs.stat(shared)).mode & 0o777).toBe(0o600)

      const strictDestination = path.join(dir, "strict-destination.json")
      const strictSource = path.join(dir, "strict-source.json")
      await writeRules(strictDestination, { "git status": "allow" })
      await fs.chmod(strictDestination, 0o400)
      await writeRules(strictSource, { "git log": "allow" })
      await migrateWorktreeStore(strictDestination, strictSource)
      expect((await fs.stat(strictDestination)).mode & 0o777).toBe(0o400)
    } finally {
      process.umask(previous)
    }
  })

  test("a zero-add migration still restricts the surviving destination", async () => {
    if (process.platform === "win32") return
    await writeRules(shared, { "git status": "allow" })
    await fs.chmod(shared, 0o644)
    await writeRules(worktree, { "git status": "allow" })

    expect(await migrateWorktreeStore(shared, worktree)).toEqual({
      outcome: "merged",
      added: 0,
      removed: true,
    })
    expect((await fs.stat(shared)).mode & 0o777).toBe(0o600)
  })

  test("a manual migration restricts both stores it leaves for review", async () => {
    if (process.platform === "win32") return
    await writeRules(shared, { "git status": "allow" })
    await writeRules(worktree, { "git push *": "ask" })
    await Promise.all([fs.chmod(shared, 0o644), fs.chmod(worktree, 0o644)])

    expect(await migrateWorktreeStore(shared, worktree)).toEqual({
      outcome: "manual",
      reason: expect.stringContaining(
        '"git push *": "ask"',
      ) as unknown as string,
    })
    expect((await fs.stat(shared)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(worktree)).mode & 0o777).toBe(0o600)
  })

  test("a directory-hardening failure is not mistaken for permission to migrate locklessly", async () => {
    if (process.platform === "win32") return
    const sharedDir = path.join(dir, "shared")
    const sourceDir = path.join(dir, "source")
    const sharedFile = path.join(sharedDir, "permissions.json")
    const sourceFile = path.join(sourceDir, "permissions.json")
    await Promise.all([fs.mkdir(sharedDir), fs.mkdir(sourceDir)])
    await writeRules(sourceFile, { "git status": "allow" })
    await fs.chmod(sourceDir, 0o755)

    const realOpen = fs.open.bind(fs)
    const realChmod = fs.chmod.bind(fs)
    const guardedOpen = (async (...args: Parameters<typeof fs.open>) => {
      const [target] = args
      if (path.resolve(String(target)) === sourceDir) {
        const error: NodeJS.ErrnoException = new Error("mode change denied")
        error.code = "EPERM"
        throw error
      }
      return realOpen(...args)
    }) as typeof fs.open
    const guardedChmod = (async (
      target: Parameters<typeof fs.chmod>[0],
      mode: Parameters<typeof fs.chmod>[1],
    ) => {
      if (path.resolve(String(target)) === sourceDir) {
        const error: NodeJS.ErrnoException = new Error("mode change denied")
        error.code = "EPERM"
        throw error
      }
      return realChmod(target, mode)
    }) as typeof fs.chmod
    ;(fs as { open: typeof fs.open }).open = guardedOpen
    ;(fs as { chmod: typeof fs.chmod }).chmod = guardedChmod
    let result: StoreMigration
    try {
      result = await migrateWorktreeStore(sharedFile, sourceFile)
    } finally {
      ;(fs as { open: typeof fs.open }).open = realOpen
      ;(fs as { chmod: typeof fs.chmod }).chmod = realChmod
    }

    expect(result!).toEqual({
      outcome: "error",
      reason: expect.stringContaining(
        "mode change denied",
      ) as unknown as string,
    })
    expect(await exists(sharedFile)).toBe(false)
    expect(await exists(sourceFile)).toBe(true)
  })

  test("a migration without the source lease merges but never removes the source", async () => {
    await writeRules(worktree, { "git status": "allow" })
    const sourceLock = `${worktree}.lock`
    const realWriteFile = fs.writeFile.bind(fs)
    const guardedWrite = (async (...args: Parameters<typeof fs.writeFile>) => {
      if (path.resolve(String(args[0])) === sourceLock) {
        const error: NodeJS.ErrnoException = new Error("source is read-only")
        error.code = "EACCES"
        throw error
      }
      return realWriteFile(...args)
    }) as typeof fs.writeFile
    ;(fs as { writeFile: typeof fs.writeFile }).writeFile = guardedWrite
    let beforeRemove = 0
    let result: StoreMigration
    try {
      result = await migrateWorktreeStore(shared, worktree, {
        beforeRemove: () => {
          beforeRemove += 1
        },
      })
    } finally {
      ;(fs as { writeFile: typeof fs.writeFile }).writeFile = realWriteFile
    }

    expect(result!).toEqual({ outcome: "merged", added: 1, removed: false })
    expect(beforeRemove).toBe(0)
    expect(await readRules(shared)).toEqual({ "git status": "allow" })
    expect(await exists(worktree)).toBe(true)

    // A later pass that can take both leases removes the now-redundant source.
    expect(await migrateWorktreeStore(shared, worktree)).toEqual({
      outcome: "merged",
      added: 0,
      removed: true,
    })
    expect(await exists(worktree)).toBe(false)
  })

  test("a hold broken before the destination write aborts the pass unwritten", async () => {
    await writeRules(worktree, { "git status": "allow" })
    const result = await migrateWorktreeStore(shared, worktree, {
      beforeWrite: async () => {
        // This time the DESTINATION hold is lost: the new holder may have
        // rewritten the shared store already, and landing a merge computed
        // from stale reads would clobber it.
        await fs.writeFile(`${shared}.lock`, "someone-else\n")
      },
    })
    expect(result).toEqual({
      outcome: "error",
      reason: expect.stringContaining(
        "lock was lost to another process",
      ) as unknown as string,
    })
    // Neither store was touched: no destination written from stale reads,
    // and the source survives for the retried pass.
    expect(await exists(shared)).toBe(false)
    expect(await exists(worktree)).toBe(true)
  })

  test("a hold broken after staging, before publication, abandons the write", async () => {
    await writeRules(worktree, { "git status": "allow" })
    const result = await migrateWorktreeStore(shared, worktree, {
      beforePublish: async () => {
        // The takeover lands at the last possible instant: the merged store
        // is fully staged in its tmp file and the next step is the rename
        // that publishes it. Staging is I/O the fold can sit suspended in
        // past the stale threshold, so a hold that survived a check before
        // the write began can still be gone here — the re-assert has to sit
        // at the publication boundary itself.
        await fs.writeFile(`${shared}.lock`, "someone-else\n")
      },
    })
    expect(result).toEqual({
      outcome: "error",
      reason: expect.stringContaining(
        "lock was lost to another process",
      ) as unknown as string,
    })
    // The staged tmp was abandoned: nothing was published, no tmp remains,
    // and the source survives for the retried pass.
    expect(await exists(shared)).toBe(false)
    expect(await exists(worktree)).toBe(true)
    expect((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual(
      [],
    )
  })

  test("a failure inside the locked pass is not retried as a lockless fold", async () => {
    await writeRules(worktree, { "git status": "allow" })
    let calls = 0
    const result = await migrateWorktreeStore(shared, worktree, {
      beforeWrite: () => {
        calls += 1
        if (calls > 1) return
        // An EACCES thrown from inside the pass — here a seam's filesystem
        // work failing — arrives after the source lock was taken and proves
        // nothing about the source's directory. Mistaking it for "the source
        // lock could not be created" would re-run the fold locklessly in a
        // directory writers can reach, and this second invocation succeeding
        // would let that re-run write and remove the source with no
        // serialization at all.
        const error: NodeJS.ErrnoException = new Error("seam denied")
        error.code = "EACCES"
        throw error
      },
    })
    expect(result).toEqual({
      outcome: "error",
      reason: expect.stringContaining("seam denied") as unknown as string,
    })
    expect(calls).toBe(1)
    expect(await exists(shared)).toBe(false)
    expect(await exists(worktree)).toBe(true)
  })
})

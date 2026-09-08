import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  createStoreOpener,
  legacyPermissionStoreFile,
  type PermissionStorePaths,
  permissionStoreFile,
  type StoreAccess,
  type StoreKeying,
  type StoreNotice,
} from "../src/shared"

/**
 * The store-readiness pipeline both halves run (src/shared.ts). The halves'
 * own suites drive it end to end through their public surfaces; this one pins
 * the decisions the extraction settled, by name, against the pipeline itself:
 *
 *   - no scope, no store — and no host probe either;
 *   - a read fails closed while the repository's shared store is unlocatable,
 *     in BOTH halves now, while a write still goes through;
 *   - a pause is reported once per cause and its recovery once per episode;
 *   - an explicit access re-reports a cause a passive one already announced,
 *     independently of whether it is a write;
 *   - only "paused" notices are load-bearing for a caller that stays quiet
 *     about the rest (the TUI half does exactly that).
 */

let sandboxRoot: string
let root: string
let configDir: string
beforeEach(async () => {
  // realpath: os.tmpdir() can sit behind a symlink and the store paths here are
  // compared against what permissionStoreFile derives from the canonical root.
  sandboxRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "store-opener-")),
  )
  root = path.join(sandboxRoot, "project")
  configDir = path.join(sandboxRoot, "config")
  await Promise.all([fs.mkdir(root), fs.mkdir(configDir)])
  await fs.mkdir(path.dirname(storeFile()), { recursive: true })
})
afterEach(async () => {
  await fs.rm(sandboxRoot, { recursive: true, force: true })
})

const storeFile = () => permissionStoreFile(configDir, root)
const legacyStoreFile = () => legacyPermissionStoreFile(root)
const worktreeStoreFile = () =>
  permissionStoreFile(configDir, path.join(sandboxRoot, "linked"))

const storePaths = (
  over: Partial<PermissionStorePaths> = {},
): PermissionStorePaths => ({
  projectRoot: root,
  keyRoot: root,
  storeFile: storeFile(),
  legacyStoreFile: legacyStoreFile(),
  ...over,
})

const keyingOf = (over: Partial<StoreKeying> = {}): StoreKeying => ({
  paths: storePaths(),
  shared: true,
  settled: true,
  unkeyedShared: false,
  ...over,
})

type Harness = {
  open: ReturnType<typeof createStoreOpener>
  notices: StoreNotice[]
  keyings: { config: string; write: boolean }[]
  lookups: StoreAccess[]
}

const makeOpener = (input: {
  keying?: StoreKeying | undefined | (() => StoreKeying | undefined)
  /** undefined models an invalid `scope` option. */
  noResolver?: boolean
  config?: () => { config: string } | { unavailable: string }
}): Harness => {
  const notices: StoreNotice[] = []
  const keyings: { config: string; write: boolean }[] = []
  const lookups: StoreAccess[] = []
  const keying = () =>
    typeof input.keying === "function" ? input.keying() : input.keying
  const open = createStoreOpener({
    resolveKeying: input.noResolver
      ? undefined
      : async (config, access) => {
          keyings.push({ config, write: access?.write === true })
          return input.keying === undefined && !("keying" in input)
            ? keyingOf()
            : keying()
        },
    configDir: (access) => {
      lookups.push(access)
      return input.config?.() ?? { config: configDir }
    },
    announce: (notice) => notices.push(notice),
  })
  return { open, notices, keyings, lookups }
}

const kinds = (notices: StoreNotice[]) =>
  notices.map((notice) => `${notice.kind}:${notice.key}`)

const writeStoreFile = (file: string, permission: Record<string, unknown>) =>
  fs.writeFile(file, JSON.stringify({ permission }))

describe("createStoreOpener", () => {
  test("no keying resolver pauses every access and never asks for a config directory", async () => {
    const harness = makeOpener({ noResolver: true })

    expect(await harness.open()).toBeUndefined()
    expect(await harness.open({ write: true })).toBeUndefined()
    // The config lookup is a host round-trip in the server half: an invalid
    // scope must not spend one on an answer that could never be used.
    expect(harness.lookups).toHaveLength(0)
    expect(kinds(harness.notices)).toEqual(["paused:invalid-scope"])
    expect(harness.notices[0]?.message).toContain('"scope" plugin option')
  })

  test("the healthy path opens the store and says nothing at all", async () => {
    const harness = makeOpener({ keying: keyingOf() })

    expect(await harness.open()).toEqual({ file: storeFile(), shared: true })
    expect(harness.notices).toHaveLength(0)
  })

  test("`shared` travels with the file, because the halves word a save by its reach", async () => {
    const harness = makeOpener({ keying: keyingOf({ shared: false }) })

    expect(await harness.open()).toEqual({ file: storeFile(), shared: false })
  })

  test("a write asks the resolver to re-derive; a read does not", async () => {
    const harness = makeOpener({ keying: keyingOf() })

    await harness.open()
    await harness.open({ write: true })

    expect(harness.keyings).toEqual([
      { config: configDir, write: false },
      { config: configDir, write: true },
    ])
  })

  test("an unavailable config directory pauses with the caller's reason, and the recovery is reported once", async () => {
    let available = false
    const harness = makeOpener({
      keying: keyingOf(),
      config: () =>
        available
          ? { config: configDir }
          : { unavailable: "the host is still starting" },
    })

    expect(await harness.open()).toBeUndefined()
    expect(await harness.open()).toBeUndefined()
    expect(kinds(harness.notices)).toEqual(["paused:config-path"])
    expect(harness.notices[0]?.message).toBe(
      "Permission persistence is paused: the host is still starting.",
    )

    available = true
    expect(await harness.open()).toBeDefined()
    expect(await harness.open()).toBeDefined()
    expect(kinds(harness.notices)).toEqual([
      "paused:config-path",
      "resumed:config-path",
    ])
    expect(harness.notices[1]?.message).toBe(
      "Permission persistence resumed: the config directory resolved.",
    )
  })

  test("an untrusted derived path pauses under its own key", async () => {
    const harness = makeOpener({ keying: undefined })

    expect(await harness.open()).toBeUndefined()
    expect(kinds(harness.notices)).toEqual(["paused:unsafe-path"])
    expect(harness.notices[0]?.message).toContain("not trusted")
  })

  test("an explicit access re-reports a still-outstanding cause; a passive one stays quiet", async () => {
    const harness = makeOpener({ keying: undefined })

    await harness.open()
    await harness.open()
    expect(harness.notices).toHaveLength(1)

    // Orthogonal to `write`: the flag says a user is waiting for an answer,
    // not that a save is coming.
    await harness.open({ explicit: true })
    await harness.open({ write: true, explicit: true })
    expect(kinds(harness.notices)).toEqual([
      "paused:unsafe-path",
      "paused:unsafe-path",
      "paused:unsafe-path",
    ])
  })

  describe("the repository's shared store is unlocatable", () => {
    const unkeyed = () => keyingOf({ shared: false, unkeyedShared: true })

    test("a read fails closed and a write still opens the fallback store", async () => {
      const harness = makeOpener({ keying: unkeyed() })

      expect(await harness.open()).toBeUndefined()
      expect(await harness.open({ write: true })).toEqual({
        file: storeFile(),
        shared: false,
      })
      expect(kinds(harness.notices)).toEqual(["paused:unkeyed-shared"])
      expect(harness.notices[0]?.message).toContain("Auto-approval is paused")
    })

    test("the write does not claim the shared store was located", async () => {
      // The pause is still true after a write passes through: nothing about a
      // save establishes the keying a read is waiting for, so the recovery
      // report belongs to the access that actually finds it.
      const harness = makeOpener({ keying: unkeyed() })

      await harness.open()
      await harness.open({ write: true })
      expect(kinds(harness.notices)).toEqual(["paused:unkeyed-shared"])
    })

    test("the recovery is reported when a later access does find it", async () => {
      let located = false
      const harness = makeOpener({
        keying: () => (located ? keyingOf() : unkeyed()),
      })

      await harness.open()
      located = true
      expect(await harness.open()).toBeDefined()
      expect(kinds(harness.notices)).toEqual([
        "paused:unkeyed-shared",
        "resumed:unkeyed-shared",
      ])
      expect(harness.notices[1]?.message).toContain("Auto-approval resumed")
    })
  })

  describe("the legacy in-project store", () => {
    test("blocks the trusted store until the user recreates it, then reports the recovery", async () => {
      await fs.mkdir(path.dirname(legacyStoreFile()), { recursive: true })
      await writeStoreFile(legacyStoreFile(), { bash: "allow" })
      const harness = makeOpener({ keying: keyingOf() })

      expect(await harness.open()).toBeUndefined()
      expect(kinds(harness.notices)).toEqual(["paused:migration-required"])
      expect(harness.notices[0]?.message).toContain(legacyStoreFile())
      expect(harness.notices[0]?.message).toContain(storeFile())

      await writeStoreFile(storeFile(), {})
      expect(await harness.open()).toBeDefined()
      expect(kinds(harness.notices)).toEqual([
        "paused:migration-required",
        "resumed:migration-required",
      ])
    })

    test("a migration candidate cannot answer the gate on the legacy store's behalf", async () => {
      // The fold WRITES the trusted store into existence from a candidate (a
      // missing destination reads as an empty store). Run it before the gate
      // and a pure-allow candidate silently satisfies "the trusted store
      // exists" — and the allow rules it brings can then auto-approve past the
      // very carve-out the legacy store was pausing everything to have
      // reviewed.
      await fs.mkdir(path.dirname(legacyStoreFile()), { recursive: true })
      await writeStoreFile(legacyStoreFile(), {
        bash: { "git push *": "deny" },
      })
      await writeStoreFile(worktreeStoreFile(), { bash: { "*": "allow" } })
      const harness = makeOpener({
        keying: keyingOf({
          paths: storePaths({ worktreeStoreFile: worktreeStoreFile() }),
        }),
      })

      expect(await harness.open()).toBeUndefined()
      expect(kinds(harness.notices)).toEqual(["paused:migration-required"])
      // Neither half of the fold ran: no destination was created, and the
      // candidate is still on disk to be folded in once the user has answered
      // the gate.
      await expect(fs.access(storeFile())).rejects.toThrow()
      expect(
        JSON.parse(await fs.readFile(worktreeStoreFile(), "utf8")).permission,
      ).toEqual({ bash: { "*": "allow" } })

      // Recreating the trusted store answers the gate, and only then does the
      // candidate fold into it.
      await writeStoreFile(storeFile(), {})
      expect(await harness.open()).toBeDefined()
      expect(kinds(harness.notices)).toEqual([
        "paused:migration-required",
        "resumed:migration-required",
        "info:worktree-store-moved",
      ])
      expect(
        JSON.parse(await fs.readFile(storeFile(), "utf8")).permission.bash,
      ).toEqual({ "*": "allow" })
    })

    test("an unstat'able path is reported before the legacy gate can look at it", async () => {
      // pathExists answers undefined for a stat error that is not ENOENT:
      // .opencode written as a regular FILE makes the legacy store's access
      // reject with ENOTDIR.
      await fs.writeFile(path.join(root, ".opencode"), "not a directory")
      const harness = makeOpener({ keying: keyingOf() })

      expect(await harness.open()).toBeUndefined()
      expect(kinds(harness.notices)).toEqual(["paused:unreadable-path"])
      expect(harness.notices[0]?.message).toContain("unreadable")
    })
  })

  describe("folding in a store this session no longer keys by", () => {
    const withCandidate = () =>
      keyingOf({
        paths: storePaths({ worktreeStoreFile: worktreeStoreFile() }),
      })

    test("a pure-allow store merges, and the move is reported once with the destination", async () => {
      await writeStoreFile(worktreeStoreFile(), {
        bash: { "git status *": "allow" },
      })
      const harness = makeOpener({ keying: withCandidate() })

      expect(await harness.open()).toBeDefined()
      expect(await harness.open()).toBeDefined()

      expect(
        JSON.parse(await fs.readFile(storeFile(), "utf8")).permission.bash,
      ).toEqual({ "git status *": "allow" })
      await expect(fs.access(worktreeStoreFile())).rejects.toThrow()
      expect(kinds(harness.notices)).toEqual(["info:worktree-store-moved"])
      expect(harness.notices[0]?.message).toContain("Moved 1 saved approval(s)")
      // The reach is the point of the report: a repository-shared destination
      // is what makes the moved approvals apply outside this checkout.
      expect(harness.notices[0]?.message).toContain(
        "the repository-wide permission store",
      )
      expect(harness.notices[0]?.message).toContain("every worktree")
      // Log-only context: the destination never crowds the toast.
      expect(harness.notices[0]?.detail).toBe(storeFile())
    })

    test("a candidate that only appears after the fold settled is still folded in", async () => {
      // A write is handed its store file and returns to its caller before the
      // lock and the write itself, so a save keyed by an earlier fallback can
      // land on disk AFTER the re-keyed fold has already run and found
      // nothing. Memoize that pass and the approval is stranded — durable on
      // disk, invisible to the active store — until the process restarts.
      const harness = makeOpener({
        keying: keyingOf({
          paths: storePaths({ staleStoreFiles: [worktreeStoreFile()] }),
        }),
      })

      expect(await harness.open()).toBeDefined()
      expect(harness.notices).toHaveLength(0)

      await writeStoreFile(worktreeStoreFile(), {
        bash: { "git status *": "allow" },
      })

      expect(await harness.open()).toBeDefined()
      expect(
        JSON.parse(await fs.readFile(storeFile(), "utf8")).permission.bash,
      ).toEqual({ "git status *": "allow" })
      await expect(fs.access(worktreeStoreFile())).rejects.toThrow()
      expect(kinds(harness.notices)).toEqual(["info:worktree-store-moved"])
    })

    test("a fold into a store that is not shared is not announced as repository-wide", async () => {
      // The fold is not repository-only: this is the repository-scope write
      // fallback, where a save goes through with `shared: false` precisely
      // because the shared store is unreachable. Telling the user their
      // approvals "now apply in every worktree" would be a claim about a store
      // this access never reached.
      await writeStoreFile(worktreeStoreFile(), {
        bash: { "git status *": "allow" },
      })
      const harness = makeOpener({
        keying: keyingOf({
          shared: false,
          unkeyedShared: true,
          paths: storePaths({ staleStoreFiles: [worktreeStoreFile()] }),
        }),
      })

      expect(await harness.open({ write: true })).toEqual({
        file: storeFile(),
        shared: false,
      })
      expect(kinds(harness.notices)).toEqual(["info:worktree-store-moved"])
      const message = harness.notices[0]?.message ?? ""
      expect(message).toContain("this project's permission store")
      expect(message).toContain("this checkout only")
      expect(message).not.toContain("repository-wide")
      expect(message).not.toContain("every worktree")
    })

    test("a carve-out pause names the destination's real reach too", async () => {
      await writeStoreFile(worktreeStoreFile(), {
        bash: { "git push *": "deny" },
      })
      const harness = makeOpener({
        keying: keyingOf({
          shared: false,
          paths: storePaths({ staleStoreFiles: [worktreeStoreFile()] }),
        }),
      })

      expect(await harness.open()).toBeUndefined()
      expect(kinds(harness.notices)).toEqual([
        "paused:worktree-store-migration",
      ])
      expect(harness.notices[0]?.message).toContain(
        "this project's permission store",
      )
      expect(harness.notices[0]?.message).not.toContain("repository-wide")
    })

    test("a carve-out pauses persistence, and every explicit access re-reports why", async () => {
      await writeStoreFile(worktreeStoreFile(), {
        bash: { "git push *": "deny" },
      })
      const harness = makeOpener({ keying: withCandidate() })

      expect(await harness.open()).toBeUndefined()
      expect(await harness.open()).toBeUndefined()
      expect(kinds(harness.notices)).toEqual([
        "paused:worktree-store-migration",
      ])
      expect(harness.notices[0]?.message).toContain("git push *")
      expect(harness.notices[0]?.message).toContain(storeFile())

      // The pass is never memoized as finished, so the user resolving it by
      // hand unpauses on the next access — and an explicit access hears the
      // reason again in the meantime.
      expect(await harness.open({ explicit: true })).toBeUndefined()
      expect(kinds(harness.notices)).toEqual([
        "paused:worktree-store-migration",
        "paused:worktree-store-migration",
      ])

      await fs.rm(worktreeStoreFile())
      expect(await harness.open()).toBeDefined()
      expect(kinds(harness.notices).at(-1)).toBe(
        "resumed:worktree-store-migration",
      )
    })

    test("an unreadable destination pauses the fold under its own key, and the recovery is reported", async () => {
      // The transient leg, distinct from the manual one: a destination that is
      // not missing (that reads as an empty store) but invalid, so the merge
      // cannot know what it would be overwriting. It clears by itself once the
      // file is valid again — no rules to reconcile by hand.
      await fs.writeFile(storeFile(), "{ not json")
      await writeStoreFile(worktreeStoreFile(), {
        bash: { "git status *": "allow" },
      })
      const harness = makeOpener({ keying: withCandidate() })

      expect(await harness.open()).toBeUndefined()
      expect(kinds(harness.notices)).toEqual([
        "paused:worktree-store-migration-error",
      ])
      expect(harness.notices[0]?.message).toContain(storeFile())

      await writeStoreFile(storeFile(), {})
      expect(await harness.open()).toBeDefined()
      expect(kinds(harness.notices)).toEqual([
        "paused:worktree-store-migration-error",
        "info:worktree-store-moved",
        "resumed:worktree-store-migration-error",
      ])
    })

    test("a source that merged but could not be deleted warns per access, and resumes when it goes", async () => {
      // chmod is a no-op for uid 0, so the removal would still succeed as root
      // and the unremoved outcome could never be produced this way.
      if (process.getuid?.() === 0) return
      // The candidate needs its OWN directory: the destination's lock file
      // lives beside the destination, so making that directory unwritable
      // would fail the whole pass instead of only the unlink.
      const sourceDir = path.join(sandboxRoot, "stale")
      await fs.mkdir(sourceDir)
      const stale = path.join(sourceDir, "permissions.json")
      await writeStoreFile(stale, { bash: { "git status *": "allow" } })
      // r-x: still readable, so the merge succeeds and only the unlink fails.
      await fs.chmod(sourceDir, 0o555)
      try {
        const harness = makeOpener({
          keying: keyingOf({
            shared: false,
            paths: storePaths({ staleStoreFiles: [stale] }),
          }),
        })

        expect(await harness.open()).toEqual({
          file: storeFile(),
          shared: false,
        })
        expect(kinds(harness.notices)).toEqual([
          "info:worktree-store-moved",
          "warning:worktree-store-removal",
        ])
        expect(harness.notices[1]?.message).toContain(stale)
        // The reach travels with this one too — it is a claim about where the
        // approvals landed, not only about what could not be cleaned up.
        expect(harness.notices[1]?.message).toContain(
          "this project's permission store",
        )

        // Latched for a passive access, like every other cause...
        expect(await harness.open()).toBeDefined()
        expect(harness.notices).toHaveLength(2)
        // ...and re-reported for an explicit one, which the pass could not do
        // while it latched this warning itself.
        expect(await harness.open({ explicit: true })).toBeDefined()
        expect(kinds(harness.notices)).toEqual([
          "info:worktree-store-moved",
          "warning:worktree-store-removal",
          "warning:worktree-store-removal",
        ])

        await fs.chmod(sourceDir, 0o755)
        expect(await harness.open()).toBeDefined()
        await expect(fs.access(stale)).rejects.toThrow()
        expect(kinds(harness.notices).at(-1)).toBe(
          "resumed:worktree-store-removal",
        )
      } finally {
        // afterEach cannot rm -rf a directory it may not write to.
        await fs.chmod(sourceDir, 0o755)
      }
    })

    test("a late re-key runs the fold again against the new store", async () => {
      await writeStoreFile(worktreeStoreFile(), {
        bash: { "git status *": "allow" },
      })
      const rekeyed = path.join(sandboxRoot, "primary")
      const rekeyedStore = permissionStoreFile(configDir, rekeyed)
      let settled = false
      const harness = makeOpener({
        keying: () =>
          settled
            ? keyingOf({
                paths: storePaths({
                  keyRoot: rekeyed,
                  storeFile: rekeyedStore,
                  worktreeStoreFile: storeFile(),
                }),
              })
            : withCandidate(),
      })

      expect(await harness.open()).toBeDefined()
      settled = true
      expect(await harness.open()).toEqual({ file: rekeyedStore, shared: true })

      // Both folds ran: the interim keying's saves reached the store the
      // session ended up on, rather than being orphaned under the old key.
      expect(
        JSON.parse(await fs.readFile(rekeyedStore, "utf8")).permission.bash,
      ).toEqual({ "git status *": "allow" })
      expect(kinds(harness.notices)).toEqual([
        "info:worktree-store-moved",
        "info:worktree-store-moved",
      ])
    })
  })

  test("only pauses are load-bearing: a caller may silence every other notice", async () => {
    // What the TUI half does — the server half already logs and toasts the
    // recoveries and the migration reports, and both render into one TUI.
    await writeStoreFile(worktreeStoreFile(), {
      bash: { "git status *": "allow" },
    })
    const harness = makeOpener({
      keying: keyingOf({
        paths: storePaths({ worktreeStoreFile: worktreeStoreFile() }),
      }),
    })

    expect(await harness.open()).toBeDefined()
    expect(
      harness.notices.filter((notice) => notice.kind === "paused"),
    ).toEqual([])
  })
})

describe("the pipeline lives in exactly one place", () => {
  // A tripwire, not a proof: the two halves drifted apart the last time they
  // each carried a copy (audit 2026-07-23 §2.6), so the sequence's own moving
  // parts must not reappear in either entrypoint.
  const halves = ["../src/index.ts", "../src/tui.tsx"]

  for (const half of halves) {
    test(`${half} runs the shared opener instead of its own`, async () => {
      const source = await Bun.file(path.join(import.meta.dir, half)).text()

      expect(source).toContain("createStoreOpener({")
      for (const step of [
        "migrateStores(",
        "legacyStoreFile",
        "unkeyedShared",
      ]) {
        expect(source, `${half} still carries ${step}`).not.toContain(step)
      }
    })
  }
})

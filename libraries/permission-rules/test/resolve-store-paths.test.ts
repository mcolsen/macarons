import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  legacyProjectScopedFile,
  PERMISSIONS_STORE_DIRECTORY,
  permissionStoreFile,
  preSlugPermissionStoreFile,
  resolvePermissionStorePaths,
  storeMigrationCandidates,
} from "../src/index"

/**
 * A stale root — a directory this session keyed by earlier — becomes a
 * migration candidate that resolvePermissionStorePaths reads, merges, and
 * DELETES, so it must clear the same trust bar as the active store. When one
 * stale root cannot be canonicalized (a dangling symlink whose target could
 * appear later in agent-writable space), the whole resolution must fail closed
 * — no store paths at all — not skip that one root and proceed.
 *
 * The staleRoots loop has no per-entry guard, so the fail-closed behavior rests
 * entirely on canonicalPath's throw propagating to the outer catch. No test
 * supplies an un-canonicalizable stale root, so a "robustness" refactor that
 * wraps the loop body in try/continue would silently drop the poisoned root
 * from the trust check and survive the suite. This pins the throw path, and its
 * companion pins the ordinary dedup path apart from it.
 */

async function sandboxDir(): Promise<string> {
  // realpath so canonicalization (which resolves /var -> /private/var on macOS)
  // does not make the expected store path differ from the asserted one.
  return fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "resolve-store-paths-")),
  )
}

describe("resolvePermissionStorePaths fails closed on a poisoned stale root", () => {
  test("a dangling-symlink stale root fails the ENTIRE resolution, not just that root", async () => {
    const sandbox = await sandboxDir()
    try {
      const project = path.join(sandbox, "project")
      const config = path.join(sandbox, "config")
      await Promise.all([fs.mkdir(project), fs.mkdir(config)])

      // A symlink whose target does not exist: canonicalPath refuses to treat
      // it as a merely-missing path, because the target is attacker-plantable.
      const stale = path.join(sandbox, "stale-root")
      await fs.symlink(path.join(sandbox, "nonexistent-target"), stale)

      expect(
        await resolvePermissionStorePaths(project, config, undefined, [stale]),
      ).toBeUndefined()
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  })

  test("a store written under the pre-slug bare-hash name is adopted before paths resolve", async () => {
    const sandbox = await sandboxDir()
    try {
      const project = path.join(sandbox, "project")
      const config = path.join(sandbox, "config")
      await Promise.all([fs.mkdir(project), fs.mkdir(config)])
      const legacy = legacyProjectScopedFile({
        dir: config,
        service: PERMISSIONS_STORE_DIRECTORY,
        bucket: "projects",
        projectRoot: project,
      })
      const store = `{\n  "permission": {\n    "bash": {\n      "git status": "allow"\n    }\n  }\n}\n`
      await fs.mkdir(path.dirname(legacy), { recursive: true })
      await fs.writeFile(legacy, store)

      const resolved = await resolvePermissionStorePaths(project, config)
      expect(resolved?.storeFile).toBe(permissionStoreFile(config, project))
      expect(await fs.readFile(resolved!.storeFile, "utf8")).toBe(store)
      // The bare-hash file is gone: consumers can never read a store the
      // resolver no longer names.
      await expect(fs.access(legacy)).rejects.toThrow()
      // The pre-slug NAME stays listed regardless — consumers stat it per
      // access, so an old half recreating it later is still seen.
      expect(resolved?.preSlugStoreFiles).toEqual([legacy])
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  })

  test("pre-slug adoption restricts broad modes without widening stricter ones under umask 022", async () => {
    if (process.platform === "win32") return
    const sandbox = await sandboxDir()
    const previous = process.umask(0o022)
    try {
      const config = path.join(sandbox, "config")
      const broadProject = path.join(sandbox, "broad-project")
      const strictProject = path.join(sandbox, "strict-project")
      await Promise.all([
        fs.mkdir(config),
        fs.mkdir(broadProject),
        fs.mkdir(strictProject),
      ])
      const broadLegacy = preSlugPermissionStoreFile(config, broadProject)
      await fs.mkdir(path.dirname(broadLegacy), { recursive: true })
      await fs.writeFile(broadLegacy, `{"permission":{}}\n`, { mode: 0o644 })
      await fs.chmod(path.dirname(broadLegacy), 0o755)

      const broad = await resolvePermissionStorePaths(broadProject, config)
      expect((await fs.stat(broad!.storeFile)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(path.dirname(broad!.storeFile))).mode & 0o777).toBe(
        0o700,
      )

      const strictLegacy = preSlugPermissionStoreFile(config, strictProject)
      await fs.writeFile(strictLegacy, `{"permission":{}}\n`, { mode: 0o400 })
      const strict = await resolvePermissionStorePaths(strictProject, config)
      expect((await fs.stat(strict!.storeFile)).mode & 0o777).toBe(0o400)
      await expect(fs.access(broadLegacy)).rejects.toThrow()
      await expect(fs.access(strictLegacy)).rejects.toThrow()
    } finally {
      process.umask(previous)
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  })

  test("a dual-name conflict leaves both files and hands the pre-slug one to the fold", async () => {
    // The rolling-upgrade shape from the review: adoption cannot move the
    // bare-hash file because the readable name already exists. Resolution must
    // not hide the old file — it stays on disk, and the migration candidates
    // list it so persist-permissions folds it in (or pauses for review).
    const sandbox = await sandboxDir()
    try {
      const project = path.join(sandbox, "project")
      const config = path.join(sandbox, "config")
      await Promise.all([fs.mkdir(project), fs.mkdir(config)])
      const legacy = preSlugPermissionStoreFile(config, project)
      const current = permissionStoreFile(config, project)
      await fs.mkdir(path.dirname(legacy), { recursive: true })
      await fs.writeFile(
        legacy,
        `{"permission":{"bash":{"git push *":"ask"}}}\n`,
      )
      await fs.writeFile(current, `{"permission":{}}\n`)
      if (process.platform !== "win32") {
        await Promise.all([fs.chmod(legacy, 0o644), fs.chmod(current, 0o644)])
        await fs.chmod(path.dirname(current), 0o755)
      }

      const resolved = await resolvePermissionStorePaths(project, config)
      expect(resolved?.preSlugStoreFiles).toEqual([legacy])
      expect(storeMigrationCandidates(resolved!)).toContain(legacy)
      expect(await fs.readFile(legacy, "utf8")).toBe(
        `{"permission":{"bash":{"git push *":"ask"}}}\n`,
      )
      expect(await fs.readFile(current, "utf8")).toBe(`{"permission":{}}\n`)
      if (process.platform !== "win32") {
        expect((await fs.stat(legacy)).mode & 0o777).toBe(0o600)
        expect((await fs.stat(current)).mode & 0o777).toBe(0o600)
        expect((await fs.stat(path.dirname(current))).mode & 0o777).toBe(0o700)
      }
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  })

  test("a planted legacy file behind a rejected symlink is never moved or copied", async () => {
    // The finding-4 reproduction: the store's service directory is a symlink
    // into the agent-writable project, with a bare-hash file at the target.
    // Resolution must fail closed AND leave the disk exactly as it found it —
    // returning undefined only after mutating through the rejected link is
    // what the review demonstrated.
    const sandbox = await sandboxDir()
    try {
      const project = path.join(sandbox, "project")
      const config = path.join(sandbox, "config")
      const target = path.join(project, "smuggled")
      await fs.mkdir(path.join(target, "projects"), { recursive: true })
      await fs.mkdir(config, { recursive: true })
      await fs.symlink(target, path.join(config, PERMISSIONS_STORE_DIRECTORY))
      const legacy = preSlugPermissionStoreFile(config, project)
      await fs.writeFile(legacy, `{"bait":true}\n`)

      expect(await resolvePermissionStorePaths(project, config)).toBeUndefined()

      expect(await fs.readFile(legacy, "utf8")).toBe(`{"bait":true}\n`)
      expect(await fs.readdir(path.join(target, "projects"))).toEqual([
        path.basename(legacy),
      ])
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  })

  test("a stale root equal to the active root is deduped away without failing", async () => {
    // The companion branch: canonicalizable stale roots that collapse onto the
    // active root are dropped by the dedup, and resolution still succeeds. This
    // keeps the fail-closed test above honest — it is the THROW that fails the
    // call, not the mere presence of a staleRoots argument.
    const sandbox = await sandboxDir()
    try {
      const project = path.join(sandbox, "project")
      const config = path.join(sandbox, "config")
      await Promise.all([fs.mkdir(project), fs.mkdir(config)])

      const resolved = await resolvePermissionStorePaths(
        project,
        config,
        undefined,
        [project],
      )
      expect(resolved).toBeDefined()
      expect(resolved?.staleStoreFiles).toBeUndefined()
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  })
})

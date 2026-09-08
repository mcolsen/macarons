import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OWNER_ONLY_WRITE_MODES, writeTextFile } from "../src/index"

let dir: string

beforeEach(async () => {
  dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "write-text-")),
  )
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("writeTextFile", () => {
  test("writes the exact bytes and leaves no tmp litter", async () => {
    const file = path.join(dir, "note.md")
    const text = "---\nname: fact\n---\nBody with trailing newline\n"
    await writeTextFile(file, text)
    expect(await fs.readFile(file, "utf8")).toBe(text)
    expect(
      (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp")),
    ).toHaveLength(0)
  })

  test("creates missing parent directories", async () => {
    const file = path.join(dir, "a", "b", "note.md")
    await writeTextFile(file, "nested")
    expect(await fs.readFile(file, "utf8")).toBe("nested")
  })

  test("removes the tmp file when the rename fails", async () => {
    // A directory at the destination makes rename() fail; the tmp must not leak.
    const file = path.join(dir, "occupied")
    await fs.mkdir(file)
    await expect(writeTextFile(file, "text")).rejects.toThrow()
    expect(
      (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp")),
    ).toHaveLength(0)
  })

  test("applies the requested file and directory modes", async () => {
    if (process.platform === "win32") return
    const file = path.join(dir, "private", "note.md")
    await writeTextFile(file, "secret", { fileMode: 0o600, dirMode: 0o700 })
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700)
    // The atomic replace re-applies the file mode over a looser existing one.
    await fs.chmod(file, 0o644)
    await writeTextFile(file, "secret again", {
      fileMode: 0o600,
      dirMode: 0o700,
    })
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  test("owner-only writes restrict broad modes without widening stricter ones under umask 022", async () => {
    if (process.platform === "win32") return
    const parent = path.join(dir, "private")
    const file = path.join(parent, "note.md")
    const previous = process.umask(0o022)
    try {
      await writeTextFile(file, "created", OWNER_ONLY_WRITE_MODES)
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(parent)).mode & 0o777).toBe(0o700)

      await fs.chmod(file, 0o644)
      await fs.chmod(parent, 0o755)
      await writeTextFile(file, "restricted", OWNER_ONLY_WRITE_MODES)
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(parent)).mode & 0o777).toBe(0o700)

      // Owner write+execute is enough to use this directory even though it
      // cannot be opened read-only for descriptor-bound fchmod.
      await fs.chmod(file, 0o644)
      await fs.chmod(parent, 0o377)
      await writeTextFile(file, "unreadable parent", OWNER_ONLY_WRITE_MODES)
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(parent)).mode & 0o777).toBe(0o300)

      // Owner write+execute keeps the directory usable while proving the
      // ceiling does not restore its deliberately removed read bit.
      await fs.chmod(file, 0o400)
      await fs.chmod(parent, 0o300)
      await writeTextFile(file, "still strict", OWNER_ONLY_WRITE_MODES)
      expect((await fs.stat(file)).mode & 0o777).toBe(0o400)
      expect((await fs.stat(parent)).mode & 0o777).toBe(0o300)
    } finally {
      process.umask(previous)
      await fs.chmod(parent, 0o700).catch(() => {})
    }
  })

  test("a mode tightened while the replacement is staged is not widened again", async () => {
    if (process.platform === "win32") return
    const file = path.join(dir, "staged.json")
    await fs.writeFile(file, "old\n")
    await fs.chmod(file, 0o644)
    const realWriteFile = fs.writeFile.bind(fs)
    const stagedWrite = (async (...args: Parameters<typeof fs.writeFile>) => {
      const result = await realWriteFile(...args)
      if (String(args[0]).endsWith(".tmp")) await fs.chmod(file, 0o400)
      return result
    }) as typeof fs.writeFile
    ;(fs as { writeFile: typeof fs.writeFile }).writeFile = stagedWrite
    try {
      await writeTextFile(file, "new\n", OWNER_ONLY_WRITE_MODES)
    } finally {
      ;(fs as { writeFile: typeof fs.writeFile }).writeFile = realWriteFile
    }
    expect((await fs.stat(file)).mode & 0o777).toBe(0o400)
  })

  test("a mode tightened during the final publication gate is not widened again", async () => {
    if (process.platform === "win32") return
    const file = path.join(dir, "publishing.json")
    await fs.writeFile(file, "old\n")
    await fs.chmod(file, 0o644)
    let checks = 0
    await writeTextFile(file, "new\n", {
      ...OWNER_ONLY_WRITE_MODES,
      beforePublish: async () => {
        checks += 1
        await fs.chmod(file, 0o400)
      },
    })
    expect(checks).toBe(2)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o400)
  })

  // preserveMode exists for the installer: it rewrites config files a user
  // may have chmod'd to 0600 because they carry provider credentials, and a
  // rewrite that widened them would leak those to every local account.
  test("preserveMode carries an existing file's bits across the replace", async () => {
    if (process.platform === "win32") return
    const file = path.join(dir, "opencode.json")
    await fs.writeFile(file, "{}\n")
    await fs.chmod(file, 0o600)
    await writeTextFile(file, '{"plugin":[]}\n', { preserveMode: true })
    expect(await fs.readFile(file, "utf8")).toBe('{"plugin":[]}\n')
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  test("preserveMode never stages a private file with umask-readable bits", async () => {
    if (process.platform === "win32") return
    const file = path.join(dir, "opencode.json")
    await fs.writeFile(file, "{}\n")
    await fs.chmod(file, 0o600)
    const previous = process.umask(0o022)
    try {
      await writeTextFile(file, `{"plugin":[]}\n`, {
        preserveMode: true,
        beforePublish: async () => {
          const tmp = (await fs.readdir(dir)).find((entry) =>
            entry.endsWith(".tmp"),
          )
          expect(tmp).toBeDefined()
          expect((await fs.stat(path.join(dir, tmp!))).mode & 0o777).toBe(0o600)
        },
      })
    } finally {
      process.umask(previous)
    }
  })

  test("preserveMode beats fileMode on an existing file, and yields on a new one", async () => {
    if (process.platform === "win32") return
    const existing = path.join(dir, "existing.json")
    await fs.writeFile(existing, "{}\n")
    await fs.chmod(existing, 0o640)
    await writeTextFile(existing, "kept\n", {
      preserveMode: true,
      fileMode: 0o600,
    })
    expect((await fs.stat(existing)).mode & 0o777).toBe(0o640)

    // Nothing to preserve: a creation still honors the requested mode.
    const created = path.join(dir, "created.json")
    await writeTextFile(created, "new\n", {
      preserveMode: true,
      fileMode: 0o600,
    })
    expect((await fs.stat(created)).mode & 0o777).toBe(0o600)
  })

  test("preserveMode restores bits the umask would have stripped", async () => {
    if (process.platform === "win32") return
    const file = path.join(dir, "group.json")
    await fs.writeFile(file, "{}\n")
    await fs.chmod(file, 0o666)
    const previous = process.umask(0o077)
    try {
      await writeTextFile(file, "rewritten\n", { preserveMode: true })
    } finally {
      process.umask(previous)
    }
    // Without the chmod after the write, the umask would leave this 0o600.
    expect((await fs.stat(file)).mode & 0o777).toBe(0o666)
  })

  // ifAbsent supports slot protocols: two non-clobbering writers race for one
  // path and the loser must learn it lost, not silently erase the winner.
  test("ifAbsent publishes a new file with the requested mode", async () => {
    const file = path.join(dir, "marker.json")
    await writeTextFile(file, "claimed\n", { ifAbsent: true, fileMode: 0o600 })
    expect(await fs.readFile(file, "utf8")).toBe("claimed\n")
    if (process.platform !== "win32")
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    // The link publishes a second name for the tmp's inode; the tmp name
    // itself must still be cleaned up.
    expect(
      (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp")),
    ).toHaveLength(0)
  })

  test("ifAbsent refuses with EEXIST and leaves the occupant untouched", async () => {
    const file = path.join(dir, "marker.json")
    await fs.writeFile(file, "occupant\n")
    await expect(
      writeTextFile(file, "challenger\n", { ifAbsent: true }),
    ).rejects.toMatchObject({ code: "EEXIST" })
    expect(await fs.readFile(file, "utf8")).toBe("occupant\n")
    expect(
      (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp")),
    ).toHaveLength(0)
  })

  test("ifAbsent keeps its contract where hardlinks are unavailable", async () => {
    const file = path.join(dir, "marker.json")
    const error = Object.assign(new Error("EPERM: hardlinks unsupported"), {
      code: "EPERM",
    })
    const spy = spyOn(fs, "link").mockImplementation(() =>
      Promise.reject(error),
    )
    try {
      // Publishing to a free slot still works without fs.link...
      await writeTextFile(file, "claimed\n", { ifAbsent: true })
      expect(await fs.readFile(file, "utf8")).toBe("claimed\n")
      // ...and an occupied slot still refuses. A link failure — hardlinks
      // missing, or a transient fault on a filesystem that has them — may
      // degrade the publish's atomicity, never the non-clobbering contract:
      // a replacing fallback would let one marker publisher silently erase
      // the other during the very collision the option exists to arbitrate.
      await expect(
        writeTextFile(file, "challenger\n", { ifAbsent: true }),
      ).rejects.toMatchObject({ code: "EEXIST" })
      expect(await fs.readFile(file, "utf8")).toBe("claimed\n")
    } finally {
      spy.mockRestore()
    }
    expect(
      (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp")),
    ).toHaveLength(0)
  })

  // The race ifAbsent exists to decide: initially concurrent writers against
  // an absent path must elect exactly one winner, with every loser told so
  // via EEXIST. A check-then-rename implementation would pass the tests above
  // while letting two such writers both "succeed", one erasing the other.
  test("concurrent ifAbsent writers elect exactly one winner", async () => {
    const file = path.join(dir, "marker.json")
    const payloads = ["first\n", "second\n", "third\n"]
    for (let i = 0; i < 300; i++) {
      const results = await Promise.allSettled(
        payloads.map((text) => writeTextFile(file, text, { ifAbsent: true })),
      )
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
      for (const r of results) {
        if (r.status === "rejected")
          expect((r.reason as NodeJS.ErrnoException).code).toBe("EEXIST")
      }
      // The slot holds the winner's complete payload — the fulfilled writer's
      // bytes, never a loser's and never a mix.
      const text = await fs.readFile(file, "utf8")
      expect(results[payloads.indexOf(text)]?.status).toBe("fulfilled")
      await fs.rm(file)
    }
    expect(
      (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp")),
    ).toHaveLength(0)
  }, 30_000)

  // Same regression class as writeJsonFile: the tmp name must be unique per
  // call so two same-process writers never interleave into one tmp and tear
  // the destination. The 500-iteration loop is ~1000 fsync-ing writes: fast
  // locally, but past bun's 5s default on a loaded CI runner (observed 5.1s),
  // so the timeout is explicit — this asserts correctness, not latency.
  test("concurrent same-process writers never tear the destination", async () => {
    const file = path.join(dir, "note.md")
    const big = `big\n${"x".repeat(4096)}\n`
    const small = "small\n"

    for (let i = 0; i < 500; i++) {
      const results = await Promise.allSettled([
        writeTextFile(file, big),
        writeTextFile(file, small),
      ])
      // Neither writer collides on a shared tmp, so neither rename fails.
      expect(results.every((r) => r.status === "fulfilled")).toBe(true)
      // The destination is always one writer's complete text, never a mix.
      const text = await fs.readFile(file, "utf8")
      expect(text === big || text === small).toBe(true)
    }
    expect(
      (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp")),
    ).toHaveLength(0)
  }, 30_000)
})

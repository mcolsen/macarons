import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readStore, rulesFrom, writeJsonFile, writeStore } from "../src/index"

let dir: string

beforeEach(async () => {
  dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "write-json-")),
  )
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("writeJsonFile", () => {
  test("writes valid JSON and leaves no tmp litter", async () => {
    const file = path.join(dir, "value.json")
    await writeJsonFile(file, { permission: { bash: { "ls *": "allow" } } })
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      permission: { bash: { "ls *": "allow" } },
    })
    expect(
      (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp")),
    ).toHaveLength(0)
  })

  test("removes the tmp file when the rename fails", async () => {
    // A directory at the destination makes rename() fail; the tmp must not leak.
    const file = path.join(dir, "occupied")
    await fs.mkdir(file)
    await expect(writeJsonFile(file, { permission: {} })).rejects.toThrow()
    expect(
      (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp")),
    ).toHaveLength(0)
  })

  test("permission and pattern dictionaries round-trip arbitrary literal keys", async () => {
    const file = path.join(dir, "literal-keys.json")
    const names = ["__proto__", "constructor", "toString"]
    const patterns = Object.fromEntries(names.map((name) => [name, "allow"]))
    const permission = Object.fromEntries(names.map((name) => [name, patterns]))
    await fs.writeFile(file, JSON.stringify({ permission }))

    const store = await readStore(file)
    expect(store).toBeDefined()
    if (!store) throw new Error("unreachable")
    expect(Object.getPrototypeOf(store.permission)).toBeNull()
    expect(rulesFrom(store)).toHaveLength(names.length * names.length)
    for (const permissionName of names) {
      expect(Object.hasOwn(store.permission, permissionName)).toBe(true)
      const rules = store.permission[permissionName]
      if (!rules || typeof rules === "string") throw new Error("unreachable")
      expect(Object.getPrototypeOf(rules)).toBeNull()
      for (const pattern of names) {
        expect(Object.hasOwn(rules, pattern)).toBe(true)
        expect(rules[pattern]).toBe("allow")
      }
    }

    await writeStore(file, store)
    const saved = JSON.parse(await fs.readFile(file, "utf8")) as {
      permission: Record<string, Record<string, string>>
    }
    for (const permissionName of names) {
      expect(Object.hasOwn(saved.permission, permissionName)).toBe(true)
      for (const pattern of names)
        expect(Object.hasOwn(saved.permission[permissionName]!, pattern)).toBe(
          true,
        )
    }
  })

  // Regression: two writes from the same process in the same millisecond once
  // derived the same `${file}.${pid}.${Date.now()}.tmp` path. The default
  // truncating writeFile let their bytes interleave into that shared tmp, which
  // was then renamed into place — leaving the destination as invalid JSON
  // (surfaced by consumers as "the permission store is unreadable or invalid
  // JSON"). The tmp name must be unique per call so the destination never tears.
  // The 500-iteration loop is ~1000 fsync-ing writes: fast locally, but past
  // bun's 5s default on a loaded CI runner (its write-text-file twin timed out
  // there), so the timeout is explicit — this asserts correctness, not latency.
  test("concurrent same-process writers never tear the destination", async () => {
    const file = path.join(dir, "store.json")
    // Differently sized payloads so any interleave shows up as invalid JSON.
    const big = {
      permission: {
        bash: Object.fromEntries(
          Array.from({ length: 40 }, (_, i) => [
            `cmd-${i}-xxxxxxxxxxxxxxxx *`,
            "allow",
          ]),
        ),
      },
    }
    const small = { permission: { bash: { "ls *": "allow" } } }

    for (let i = 0; i < 500; i++) {
      const results = await Promise.allSettled([
        writeStore(file, big as never),
        writeStore(file, small as never),
      ])
      // Neither writer collides on a shared tmp, so neither rename fails.
      expect(results.every((r) => r.status === "fulfilled")).toBe(true)
      // The destination is always one writer's complete store, never a mix.
      const store = await readStore(file)
      expect(store).toBeDefined()
      expect(store).toSatisfy((s) => {
        const bash = (s as { permission: { bash: Record<string, string> } })
          .permission.bash
        return (
          JSON.stringify(bash) === JSON.stringify(big.permission.bash) ||
          JSON.stringify(bash) === JSON.stringify(small.permission.bash)
        )
      })
    }
    expect(
      (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp")),
    ).toHaveLength(0)
  }, 30_000)
})

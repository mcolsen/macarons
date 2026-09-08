import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  formatDuration,
  patchSettingsFile,
  resolveConfigDir,
  toStringArray,
  truncateLabel,
} from "../src/index"

/**
 * The helpers the 2026-07-23 duplication audit found living in two packages
 * at once (report §1). Each was byte-identical across its copies, so the
 * promotion was mechanical — but the behavior these tests pin is what the
 * copies had to agree on, and now only has to hold in one place. Their old
 * homes' tests either moved here (approve-for-me and the
 * installer) or stayed as re-export pins where the plugin still exposes the
 * helper through its own shared.ts (background-tasks, subagent-comms,
 * web-search).
 */

let dir: string

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "promoted-")))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("truncateLabel", () => {
  test("flattens interior whitespace and leaves short labels alone", () => {
    expect(truncateLabel("  a   b  ", 10)).toBe("a b")
    expect(truncateLabel("a  b\nc", 10)).toBe("a b c")
    expect(truncateLabel("exact", 5)).toBe("exact")
  })

  test("ellipsizes over the cap, counting the ellipsis", () => {
    expect(truncateLabel("abcdefghij", 5)).toBe("abcd…")
    expect(truncateLabel("abcdefghij", 5)).toHaveLength(5)
  })

  test("a cap of 0 or 1 yields just the ellipsis, never a negative slice", () => {
    // cron's copy sliced (0, max - 1) unguarded: at max 0 that is slice(0, -1),
    // which drops the last character and returns nearly the WHOLE label —
    // the opposite of truncating. This is the divergence the promotion settled.
    expect(truncateLabel("abcdefghij", 0)).toBe("…")
    expect(truncateLabel("abcdefghij", 1)).toBe("…")
  })
})

describe("formatDuration", () => {
  test("renders seconds, minutes, hours, then days", () => {
    expect(formatDuration(34_000)).toBe("34s")
    expect(formatDuration(760_000)).toBe("12m40s")
    expect(formatDuration(3_720_000)).toBe("1h02m")
    expect(formatDuration(72 * 3_600_000)).toBe("3d")
  })

  test("pads the minor unit and switches units at the boundaries", () => {
    expect(formatDuration(59_000)).toBe("59s")
    expect(formatDuration(61_000)).toBe("1m01s")
    expect(formatDuration(3_600_000)).toBe("1h00m")
    expect(formatDuration(47 * 3_600_000)).toBe("47h00m")
    expect(formatDuration(48 * 3_600_000)).toBe("2d")
  })

  test("a backwards clock reads as 0s rather than a negative elapsed", () => {
    expect(formatDuration(-5)).toBe("0s")
  })
})

describe("toStringArray", () => {
  test("accepts a bare string, a list, and drops non-strings", () => {
    expect(toStringArray("one")).toEqual(["one"])
    expect(toStringArray(["a", "b"])).toEqual(["a", "b"])
    expect(toStringArray(["a", 1, null, "b", {}])).toEqual(["a", "b"])
  })

  test("anything else is an empty list, never a guess", () => {
    for (const value of [undefined, null, 42, {}, true]) {
      expect(toStringArray(value)).toEqual([])
    }
  })
})

describe("resolveConfigDir", () => {
  test("prefers OPENCODE_CONFIG_DIR, then XDG_CONFIG_HOME, then the home default", () => {
    expect(
      resolveConfigDir(
        { OPENCODE_CONFIG_DIR: "/explicit", XDG_CONFIG_HOME: "/xdg" },
        "/home/u",
      ),
    ).toBe("/explicit")
    expect(resolveConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(
      path.join("/xdg", "opencode"),
    )
    expect(resolveConfigDir({}, "/home/u")).toBe(
      path.join("/home/u", ".config", "opencode"),
    )
  })

  test("blank values do not count as set", () => {
    expect(
      resolveConfigDir(
        { OPENCODE_CONFIG_DIR: "  ", XDG_CONFIG_HOME: "" },
        "/home/u",
      ),
    ).toBe(path.join("/home/u", ".config", "opencode"))
  })
})

describe("patchSettingsFile", () => {
  test("creates the file when it does not exist yet", async () => {
    const file = path.join(dir, "nested", "settings.json")
    expect(await patchSettingsFile(file, { enabled: false })).toBe("ok")
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      enabled: false,
    })
  })

  test("merges into existing content and preserves keys it does not know", async () => {
    const file = path.join(dir, "settings.json")
    await fs.writeFile(
      file,
      `${JSON.stringify({ $schema: "https://x/schema.json", model: "a/b" })}\n`,
    )
    expect(await patchSettingsFile(file, { enabled: true })).toBe("ok")
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      $schema: "https://x/schema.json",
      model: "a/b",
      enabled: true,
    })
  })

  test("writes arbitrary literal keys as data", async () => {
    const file = path.join(dir, "literal-settings.json")
    const patch = Object.fromEntries(
      ["__proto__", "constructor", "toString"].map((key) => [key, key]),
    )
    expect(await patchSettingsFile(file, patch)).toBe("ok")
    const saved = JSON.parse(await fs.readFile(file, "utf8")) as Record<
      string,
      unknown
    >
    for (const key of ["__proto__", "constructor", "toString"]) {
      expect(Object.hasOwn(saved, key)).toBe(true)
      expect(saved[key]).toBe(key)
    }
  })

  test("undefined deletes a key; null is a value that is kept", async () => {
    const file = path.join(dir, "settings.json")
    await fs.writeFile(file, `${JSON.stringify({ model: "a/b", keep: 1 })}\n`)
    expect(await patchSettingsFile(file, { model: undefined })).toBe("ok")
    const afterDelete = JSON.parse(await fs.readFile(file, "utf8"))
    expect("model" in afterDelete).toBe(false)
    expect(afterDelete).toEqual({ keep: 1 })

    expect(await patchSettingsFile(file, { model: null })).toBe("ok")
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      keep: 1,
      model: null,
    })
  })

  test("refuses a file that is not JSON, and refuses one that is not an object", async () => {
    const invalid = path.join(dir, "invalid.json")
    await fs.writeFile(invalid, "{not json")
    expect(await patchSettingsFile(invalid, { enabled: false })).toBe("corrupt")
    expect(await fs.readFile(invalid, "utf8")).toBe("{not json")

    for (const body of ["[1,2]", '"a string"', "null"]) {
      const file = path.join(dir, "shape.json")
      await fs.writeFile(file, body)
      expect(await patchSettingsFile(file, { enabled: false })).toBe("corrupt")
      // The user's file survives untouched — that is the whole point of the
      // "corrupt" leg: hand-edited settings are not ours to flatten.
      expect(await fs.readFile(file, "utf8")).toBe(body)
    }
  })

  test("an unreadable existing file is corrupt, not an empty starting point", async () => {
    // A directory where a file belongs: readFile fails with something other
    // than ENOENT, which must never read as "no settings yet".
    const file = path.join(dir, "as-a-dir.json")
    await fs.mkdir(file)
    expect(await patchSettingsFile(file, { enabled: false })).toBe("corrupt")
  })
})

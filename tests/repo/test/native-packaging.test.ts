import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  describeBundle,
  describePackaging,
} from "@macarons/plugin-test-harness"

const root = path.resolve(import.meta.dir, "../../..")
const plugins = readdirSync(path.join(root, "plugins"))
  .filter((id) => existsSync(path.join(root, "plugins", id, "package.json")))
  .sort()

test("native packaging covers the eight retained plugins", () => {
  expect(plugins).toEqual([
    "approve-for-me",
    "cache-ratio",
    "codex-limits",
    "cron",
    "redact-secrets",
    "scoped-system-prompts",
    "synthetic-limits",
    "web-search",
  ])
})

for (const id of plugins) {
  const directory = path.join(root, "plugins", id)
  const pkg = JSON.parse(
    readFileSync(path.join(directory, "package.json"), "utf8"),
  ) as {
    exports: Record<string, string>
    files: string[]
    scripts: Record<string, string>
  }
  describe(id, () => {
    describePackaging({
      testDir: path.join(directory, "test"),
      serverExport: pkg.exports["./server"] ? "default" : undefined,
      tui: Boolean(pkg.exports["./tui"]),
    })
    if (pkg.scripts.build)
      describeBundle({
        testDir: path.join(directory, "test"),
        exportName: "default",
      })
    test("package-directory entry shims ship with their implementation", () => {
      for (const [half, key] of [
        ["server", "./server"],
        ["tui", "./tui"],
      ]) {
        if (!pkg.exports[key!]) continue
        const choices =
          half === "server" ? ["server.ts", "index.ts"] : ["tui.ts", "tui.tsx"]
        const file = choices.find((candidate) =>
          existsSync(path.join(directory, candidate)),
        )
        expect(file).toBeDefined()
        if (!file) throw new Error(`Missing ${half} root entry`)
        expect(pkg.files).toContain(file)
        expect(readFileSync(path.join(directory, file), "utf8")).toMatch(
          /export\s+\{\s*default\s*\}\s+from/,
        )
      }
    })
  })
}

test("active plugin sources no longer import the v1 SDK", () => {
  for (const id of plugins) {
    const directory = path.join(root, "plugins", id, "src")
    for (const relative of readdirSync(directory, {
      recursive: true,
      encoding: "utf8",
    })) {
      if (!/\.tsx?$/.test(relative)) continue
      expect(
        readFileSync(path.join(directory, relative), "utf8"),
        `${id}/${relative}`,
      ).not.toMatch(/(?:from\s*|import\s*\()["']@opencode-ai\//)
    }
  }
})

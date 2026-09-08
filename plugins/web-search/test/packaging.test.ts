import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { describePackaging } from "@macarons/plugin-test-harness"

// web-search ships two halves — the server entry (./server) and the sidebar
// TUI companion (./tui). The server bundle stays standalone (bundle.test.ts):
// only src/index.ts is built, and it never imports the TUI half.

const ROOT = path.join(import.meta.dir, "..")

async function readPackageJson() {
  return JSON.parse(
    await fs.readFile(path.join(ROOT, "package.json"), "utf8"),
  ) as {
    files?: string[]
    exports?: Record<string, string>
  }
}

describePackaging({
  testDir: import.meta.dir,
  serverExport: "WebSearchPlugin",
  tui: true,
  runtimeDeps: ["@opencode-ai/plugin"],
  devOnlyDeps: ["@opencode-ai/sdk"],
})

describe("the packed tarball carries the required contents", () => {
  // `files` only names intent; this inspects what a publish would actually
  // ship. Notably NOTICE: the native adapters are adapted MIT code, and the
  // license requires the notice in all copies or substantial portions — a
  // tarball without it distributes the adaptation unattributed.
  async function packedFiles(): Promise<string[]> {
    const proc = Bun.spawn(["bun", "pm", "pack", "--dry-run"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, errors] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(await proc.exited).toBe(0)
    const lines = `${output}\n${errors}`.split("\n")
    const packed = lines
      .filter((line) => line.startsWith("packed "))
      .map((line) => line.trim().split(/\s+/)[2])
      .filter((entry): entry is string => !!entry)
    expect(packed.length).toBeGreaterThan(0)
    return packed
  }

  test("NOTICE ships, alongside every export target", async () => {
    const packed = await packedFiles()
    expect(packed).toContain("NOTICE")
    expect(packed).toContain("package.json")
    const pkg = await readPackageJson()
    for (const target of Object.values(pkg.exports ?? {})) {
      expect(packed).toContain(target.replace(/^\.\//, ""))
    }
  })

  test("NOTICE is declared in files and exists with the upstream attribution", async () => {
    const pkg = await readPackageJson()
    expect(pkg.files).toContain("NOTICE")
    const notice = await fs.readFile(path.join(ROOT, "NOTICE"), "utf8")
    expect(notice).toContain("MIT License")
    expect(notice).toContain("opencode-websearch")
  })
})

// The native backend reads OpenCode's auth store from the ENVIRONMENT rather
// than asking the server for a path (audit §2.3). That is only sound because
// this code runs in the host's own process — the server half — where
// `process.env` is the environment that placed the host's data dir. The TUI
// half is a different process whenever the TUI is attached, so a `./tui`-
// reachable import of the backend would silently start resolving credentials
// against the wrong machine, with nothing failing.
describe("the auth reader stays in the host's own process", () => {
  test("the TUI half reaches nothing under backends/", async () => {
    const seen = new Set<string>()
    const reach = async (file: string): Promise<void> => {
      if (seen.has(file)) return
      seen.add(file)
      const source = await fs.readFile(file, "utf8")
      for (const match of source.matchAll(/from\s+"(\.[^"]*)"/g)) {
        const resolved = path.resolve(path.dirname(file), match[1] as string)
        for (const candidate of [
          `${resolved}.ts`,
          `${resolved}.tsx`,
          path.join(resolved, "index.ts"),
        ]) {
          if (
            await fs.stat(candidate).then(
              () => true,
              () => false,
            )
          ) {
            expect(
              path.relative(ROOT, candidate),
              `${path.relative(ROOT, file)} reaches ${path.relative(ROOT, candidate)}`,
            ).not.toContain(`src${path.sep}backends`)
            await reach(candidate)
            break
          }
        }
      }
    }
    await reach(path.join(ROOT, "src", "tui.tsx"))
    // Guard the guard: the walk must actually have followed imports.
    expect(seen.size).toBeGreaterThan(1)
  })
})

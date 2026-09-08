import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..")

function gitLsFiles(...patterns: string[]): string[] {
  return execFileSync(
    "git",
    ["ls-files", ...patterns.map((pattern) => `:(glob)${pattern}`)],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  )
    .split("\n")
    .filter(Boolean)
}

function collectActionUses(
  value: unknown,
  found: Array<string | undefined>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectActionUses(item, found)
    return
  }
  if (value === null || typeof value !== "object") return

  for (const [key, child] of Object.entries(value)) {
    if (key === "uses") {
      found.push(typeof child === "string" ? child : undefined)
    }
    collectActionUses(child, found)
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

describe("GitHub Actions supply-chain policy", () => {
  test("discovers every action in block and flow-style YAML", () => {
    const found: Array<string | undefined> = []
    collectActionUses(
      Bun.YAML.parse(`
        steps:
          - uses: owner/block@v1
          - [{ "uses": owner/first@v2 }, { uses: owner/second@v3 }]
      `),
      found,
    )
    expect(found).toEqual([
      "owner/block@v1",
      "owner/first@v2",
      "owner/second@v3",
    ])
  })

  test("remote actions use immutable SHAs with readable version comments", () => {
    const workflows = gitLsFiles(
      ".github/workflows/*.yml",
      ".github/workflows/*.yaml",
    )
    const actionDefinitions = gitLsFiles("**/action.yml", "**/action.yaml")
    const offenders: string[] = []
    let checked = 0

    for (const rel of [...workflows, ...actionDefinitions]) {
      const source = readFileSync(path.join(REPO_ROOT, rel), "utf8")
      const targets: Array<string | undefined> = []
      collectActionUses(Bun.YAML.parse(source), targets)
      const remoteCounts = new Map<string, number>()

      for (const target of targets) {
        if (!target) {
          offenders.push(`${rel}: uses must be a string`)
          continue
        }
        if (target.startsWith("./")) continue
        checked++
        remoteCounts.set(target, (remoteCounts.get(target) ?? 0) + 1)

        const immutable = target.match(/^[^@]+@[0-9a-f]{40}$/)
        if (!immutable) offenders.push(`${rel}: ${target} is not SHA-pinned`)
      }

      const lines = source.split("\n")
      for (const [target, count] of remoteCounts) {
        const escaped = escapeRegExp(target)
        const declaration = new RegExp(
          `^\\s*(?:-\\s+)?uses:\\s*(?:${escaped}|"${escaped}"|'${escaped}')\\s+#\\s*v\\d+(?:\\.\\d+){1,2}(?:-[0-9A-Za-z.-]+)?\\s*$`,
        )
        const declarations = lines.filter((line) =>
          declaration.test(line),
        ).length
        if (declarations !== count) {
          offenders.push(
            `${rel}: ${target} needs its own block-style version comment`,
          )
        }
      }
    }

    expect(workflows.length).toBeGreaterThan(0)
    expect(checked).toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { describePackaging } from "@macarons/plugin-test-harness"

const ROOT = path.join(import.meta.dir, "..")

describePackaging({
  testDir: import.meta.dir,
  serverExport: "ApproveForMePlugin",
  tui: true,
})

describe("the published artifact carries what the README promises", () => {
  // The checkout always has every file, so only the packed manifest can
  // catch a `files` allowlist that drops something the package documents —
  // this regressed once: `files: ["src"]` shipped a tarball with no skill.
  // (Skipped on bun-only machines; CI's ubuntu runners always have npm.)
  test.skipIf(!Bun.which("npm"))(
    "npm pack includes the entry modules and the enshrine-approvals skill",
    async () => {
      const proc = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], {
        cwd: ROOT,
      })
      if (!proc.success)
        throw new Error(`npm pack --dry-run failed: ${proc.stderr.toString()}`)
      const [manifest] = JSON.parse(proc.stdout.toString()) as [
        { files: { path: string }[] },
      ]
      const packed = new Set(manifest.files.map((f) => f.path))
      for (const file of [
        "package.json",
        "src/index.ts",
        "src/tui.tsx",
        "src/shared.ts",
        "src/interop.ts",
        "skills/enshrine-approvals/SKILL.md",
      ]) {
        expect(packed).toContain(file)
      }
    },
    30_000,
  )
})

describe("the enshrine-approvals skill satisfies OpenCode's SKILL.md contract", () => {
  // Verified against the OpenCode v1.18.1 skill loader: discovery matches
  // <dir>/**/SKILL.md, the frontmatter must carry a name matching
  // ^[a-z0-9]+(-[a-z0-9]+)*$ (1-64 chars) that equals the containing
  // directory's name, and a 1-1024 char description drives when agents load it.
  const skillDir = path.join(ROOT, "skills", "enshrine-approvals")

  async function readSkill() {
    const text = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) throw new Error("SKILL.md has no frontmatter block")
    const frontmatterText = match[1]
    const body = match[2]
    if (frontmatterText === undefined || body === undefined) {
      throw new Error("SKILL.md has no frontmatter block")
    }
    const frontmatter: Record<string, string> = {}
    let current: string | undefined
    for (const line of frontmatterText.split("\n")) {
      const field = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/)
      if (field) {
        const key = field[1]
        if (key === undefined) continue
        current = key
        frontmatter[key] = (field[2] ?? "").trim()
      } else if (current && /^\s+\S/.test(line)) {
        frontmatter[current] = `${frontmatter[current]} ${line.trim()}`.trim()
      }
    }
    return { frontmatter, body }
  }

  test("frontmatter name matches the directory and OpenCode's name rules", async () => {
    const { frontmatter } = await readSkill()
    const { name } = frontmatter
    expect(name).toBe(path.basename(skillDir))
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    if (name === undefined) throw new Error("missing name")
    expect(name.length).toBeLessThanOrEqual(64)
  })

  test("frontmatter description exists and fits OpenCode's 1-1024 char band", async () => {
    const { frontmatter } = await readSkill()
    const { description } = frontmatter
    expect(description).toBeDefined()
    if (description === undefined) throw new Error("missing description")
    expect(description.length).toBeGreaterThan(0)
    expect(description.length).toBeLessThanOrEqual(1024)
  })

  test("the body names the files it is coupled to, so path drift breaks here", async () => {
    const { body } = await readSkill()
    // The journal directory this plugin writes…
    expect(body).toContain("permissions-approve-for-me/approvals")
    // …the persist-permissions project store it proposes rules for…
    expect(body).toContain("persist-permissions/projects")
    // …and the legacy store whose pending migration it must never complete.
    expect(body).toContain(".opencode/permissions.local.json")
  })

  test("the hard rules survive editing: user confirmation and file-tool writes", async () => {
    const body = (await readSkill()).body.replace(/\s+/g, " ")
    expect(body).toContain("never shell redirection")
    expect(body).toContain("the user has not individually confirmed")
  })
})

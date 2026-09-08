import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Issue #168: every manifest declared `"license": "MIT"` while the repository
 * shipped no LICENSE file and no packed tarball carried the MIT grant — a
 * public release would advertise a license it never delivers, and GitHub
 * could not identify a repository license at all.
 *
 * This suite pins the repair:
 *
 * - The repository root holds a tracked LICENSE with the MIT grant and the
 *   copyright attribution.
 * - Every workspace manifest declares the same SPDX expression, so one
 *   package can never quietly relicense itself relative to the rest.
 * - Every public (non-`private`) package ships a byte-identical LICENSE and
 *   lists it in `files`, so inclusion does not depend on a packer's
 *   auto-include behavior.
 * - `bun pm pack` run for real on every public package produces a tarball
 *   whose `package/LICENSE` carries the MIT grant and whose packed
 *   package.json still declares MIT — the artifact, not the intent, is what
 *   a consumer installs.
 *
 * Enumerated off `git ls-files` like package-manifest.test.ts: untracked
 * debris directories can never flip the verdict, while a tracked manifest
 * lost or renamed in a diff is caught.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..")
const SPDX_LICENSE = "MIT"
const COPYRIGHT_LINE = "Copyright (c) 2026 Maria Olsen"

function gitLsFiles(...patterns: string[]): string[] {
  // :(glob) pathspec magic: a single `*` must not match across `/`, or git's
  // default (which crosses slashes) would let a nested package.json masquerade
  // as a top-level package.
  return execFileSync(
    "git",
    ["ls-files", ...patterns.map((p) => `:(glob)${p}`)],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  )
    .split("\n")
    .filter(Boolean)
}

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8")
}

type Manifest = {
  name?: string
  private?: boolean
  license?: string
  files?: string[]
}

/** Tracked package.json of every workspace package, with its parsed manifest. */
const manifests = gitLsFiles(
  "plugins/*/package.json",
  "libraries/*/package.json",
  "tools/*/package.json",
  "tests/*/package.json",
).map((rel) => ({
  rel,
  pkg: JSON.parse(read(rel)) as Manifest,
}))

const publicPackages = manifests.filter(({ pkg }) => !pkg.private)

describe("the repository ships its license", () => {
  test("the root LICENSE is tracked, MIT, and carries the attribution", () => {
    const tracked = new Set(gitLsFiles("LICENSE"))
    expect(tracked.has("LICENSE")).toBe(true)
    const text = read("LICENSE")
    expect(text).toContain("MIT License")
    expect(text).toContain(COPYRIGHT_LINE)
    expect(text).toContain(
      "Permission is hereby granted, free of charge, to any person obtaining a copy",
    )
  })
})

describe("SPDX metadata is consistent across every workspace manifest", () => {
  test("the enumeration is not vacuously empty", () => {
    // 19 today (13 plugins + 3 libraries + installer + 2 test packages).
    // Headroom below the real count, as in package-manifest.test.ts:
    // retiring a package must not trip the guard.
    expect(manifests.length).toBeGreaterThanOrEqual(10)
    expect(publicPackages.length).toBeGreaterThanOrEqual(10)
  })

  test("every manifest declares the same SPDX expression", () => {
    const offenders = manifests
      .filter(({ pkg }) => pkg.license !== SPDX_LICENSE)
      .map(({ rel, pkg }) => `${rel}: license is ${String(pkg.license)}`)
    expect(offenders).toEqual([])
  })
})

describe("every public package ships the license text", () => {
  test("each holds a tracked LICENSE identical to the root's", () => {
    const rootLicense = read("LICENSE")
    // `**` (not `*`) must cross `/`: git's glob mode makes a single `*`
    // stop at path separators, so `*/LICENSE` would see only a hypothetical
    // top-level package.
    const tracked = new Set(gitLsFiles("**/LICENSE"))
    const offenders: string[] = []
    for (const { rel, pkg } of publicPackages) {
      const dir = path.dirname(rel)
      const licenseRel = `${dir}/LICENSE`
      if (!tracked.has(licenseRel)) {
        offenders.push(`${dir}: no tracked LICENSE`)
        continue
      }
      if (read(licenseRel) !== rootLicense) {
        offenders.push(`${dir}: LICENSE diverges from the repository root`)
      }
      // `files` is the packer contract: listing LICENSE there makes inclusion
      // explicit instead of relying on auto-include, which a future packer
      // version could change under us.
      if (!pkg.files?.includes("LICENSE")) {
        offenders.push(`${dir}: files does not list LICENSE`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe("every public package's packed tarball carries the license", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "license-pack-"))

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  test("bun pm pack output contains the MIT grant and MIT SPDX metadata", () => {
    const offenders: string[] = []
    for (const { rel, pkg } of publicPackages) {
      const dir = path.dirname(rel)
      const dest = path.join(scratch, dir)
      try {
        execFileSync(
          "bun",
          ["pm", "pack", "--quiet", `--destination=${dest}`],
          {
            cwd: path.join(REPO_ROOT, dir),
            stdio: "pipe",
            maxBuffer: 64 * 1024 * 1024,
          },
        )
      } catch (err) {
        offenders.push(`${dir}: bun pm pack failed: ${String(err)}`)
        continue
      }
      const tarball = readdirSync(dest).find((f) => f.endsWith(".tgz"))
      if (!tarball) {
        offenders.push(`${dir}: no tarball produced in ${dest}`)
        continue
      }
      const listing = execFileSync("tar", ["tzf", path.join(dest, tarball)], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      })
      const entries = listing.split("\n").filter(Boolean)
      if (!entries.includes("package/LICENSE")) {
        offenders.push(
          `${dir}: tarball has no package/LICENSE (${entries.join(", ")})`,
        )
        continue
      }
      const packedLicense = execFileSync(
        "tar",
        ["xzOf", path.join(dest, tarball), "package/LICENSE"],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      )
      if (
        !packedLicense.includes("MIT License") ||
        !packedLicense.includes(COPYRIGHT_LINE)
      ) {
        offenders.push(`${dir}: packed LICENSE is not the MIT grant`)
        continue
      }
      const packedManifest = JSON.parse(
        execFileSync(
          "tar",
          ["xzOf", path.join(dest, tarball), "package/package.json"],
          { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        ),
      ) as { license?: string; name?: string }
      if (packedManifest.license !== SPDX_LICENSE) {
        offenders.push(
          `${dir}: packed manifest license is ${String(packedManifest.license)}`,
        )
      }
      if (packedManifest.name !== pkg.name) {
        offenders.push(
          `${dir}: packed manifest name is ${String(packedManifest.name)}`,
        )
      }
    }
    expect(offenders).toEqual([])
  })
})

import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const pin = readFileSync(path.join(root, ".opencode-version"), "utf8").trim()
const manifests = [
  "package.json",
  ...["plugins", "libraries", "tools", "tests"].flatMap((base) =>
    readdirSync(path.join(root, base))
      .map((dir) => `${base}/${dir}/package.json`)
      .filter((file) => existsSync(path.join(root, file))),
  ),
]

test("all native OpenCode packages use the exact canonical v2 pin", () => {
  expect(pin).toMatch(/^2\.\d+\.\d+$/)
  let checked = 0
  for (const file of manifests) {
    const pkg = JSON.parse(readFileSync(path.join(root, file), "utf8"))
    for (const deps of [pkg.dependencies, pkg.devDependencies]) {
      for (const [name, version] of Object.entries(deps ?? {})) {
        expect(name, `${file}: legacy SDK dependency`).not.toMatch(
          /^@opencode-ai\//,
        )
        if (!name.startsWith("@opencode/")) continue
        checked++
        expect(version, `${file}: ${name}`).toBe(pin)
      }
    }
    if (file.startsWith("plugins/"))
      expect(pkg.engines.opencode).toBe(">=2.0.29 <3.0.0")
  }
  expect(checked).toBeGreaterThan(10)
})

test("the binary checksum manifest pins every supported npm artifact", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, ".opencode-checksums.json"), "utf8"),
  )
  expect(manifest.version).toBe(pin)
  expect(manifest.registry).toBe("https://registry.npmjs.org")
  const targets = [
    "darwin-arm64",
    "darwin-x64",
    "darwin-x64-baseline",
    "linux-arm64",
    "linux-arm64-musl",
    "linux-x64",
    "linux-x64-baseline",
    "linux-x64-baseline-musl",
    "linux-x64-musl",
    "windows-arm64",
    "windows-x64",
    "windows-x64-baseline",
  ]
  expect(Object.keys(manifest.assets).sort()).toEqual(
    targets.map((target) => `cli-${target}-${pin}.tgz`).sort(),
  )
  for (const integrity of Object.values(manifest.assets))
    expect(integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/)
})

import { spawn } from "node:child_process"
import crypto from "node:crypto"
import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * Which opencode binary every suite runs, resolved once per test process:
 *
 *   1. an explicit $OPENCODE_BIN, verbatim — the caller vouches for it;
 *   2. outside CI only: `opencode` from $PATH when it already reports the
 *      pinned version. A local install has no release artifact to check, so
 *      it is trusted on that version self-report alone (and says so on
 *      stderr); in CI every executed binary must trace back to a checksum,
 *      so this shortcut is skipped there entirely;
 *   3. otherwise the version-pinned release artifact downloaded once into
 *      ~/.cache/macarons-e2e/<version>/ and reused across runs.
 *
 * The download is fetched straight from the GitHub release (the same
 * artifacts the official install script resolves) and its SHA-256 must match
 * a checksum committed in .opencode-checksums.json before anything from it
 * is executed. At install time the extracted binary's own SHA-256 is written
 * to a sidecar file next to it, and every later reuse re-verifies the cached
 * binary against that sidecar before executing it — even for the version
 * probe. The install script itself is never run: it is mutable remote code,
 * and the version check it used to precede came only after execution. To
 * test another version, set OPENCODE_E2E_VERSION plus either OPENCODE_BIN or
 * an explicit OPENCODE_E2E_SHA256 for that version's artifact on this
 * platform.
 */

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../..")
const PINNED_VERSION = readFileSync(
  path.join(REPOSITORY_ROOT, ".opencode-version"),
  "utf8",
).trim()
if (!/^\d+\.\d+\.\d+$/.test(PINNED_VERSION)) {
  throw new Error(
    `Invalid .opencode-version: ${JSON.stringify(PINNED_VERSION)}`,
  )
}
export const EXPECTED_OPENCODE_VERSION =
  process.env.OPENCODE_E2E_VERSION ?? PINNED_VERSION

const RELEASE_URL_BASE =
  "https://github.com/anomalyco/opencode/releases/download"
const PROBE_TIMEOUT_MS = 15_000

type ChecksumManifest = { version: string; assets: Record<string, string> }
const CHECKSUMS = JSON.parse(
  readFileSync(path.join(REPOSITORY_ROOT, ".opencode-checksums.json"), "utf8"),
) as ChecksumManifest
if (
  CHECKSUMS.version !== PINNED_VERSION ||
  !CHECKSUMS.assets ||
  typeof CHECKSUMS.assets !== "object"
) {
  throw new Error(
    ".opencode-checksums.json is not in lockstep with .opencode-version",
  )
}

let resolution: Promise<string> | undefined

export function resolveOpenCodeBinary(): Promise<string> {
  resolution ??= resolveBinary().catch((error) => {
    // A failed download must not poison every later suite in the process.
    resolution = undefined
    throw error
  })
  return resolution
}

async function resolveBinary(): Promise<string> {
  const override = process.env.OPENCODE_BIN
  if (override) return override
  // The $PATH shortcut has no release artifact behind it, so it can only be
  // trusted on its version self-report. Fine for local iteration; never in
  // CI, where everything executed must trace back to a committed checksum.
  if (
    !process.env.CI &&
    (await probeVersion("opencode")) === EXPECTED_OPENCODE_VERSION
  ) {
    console.error(
      `opencode-binary: using \`opencode\` from $PATH, trusted on its version self-report alone ` +
        `(a local install has no artifact to verify). Set OPENCODE_BIN or remove it from $PATH to opt out.`,
    )
    return "opencode"
  }
  const cached = path.join(cacheRoot(), EXPECTED_OPENCODE_VERSION, "opencode")
  if (
    (await verifyCachedBinary(cached)) &&
    (await probeVersion(cached)) === EXPECTED_OPENCODE_VERSION
  ) {
    return cached
  }
  await downloadPinned(cached)
  const version = await probeVersion(cached)
  if (version !== EXPECTED_OPENCODE_VERSION) {
    throw new Error(
      `Downloaded opencode reports version ${version ?? "unknown"}, expected ${EXPECTED_OPENCODE_VERSION}`,
    )
  }
  return cached
}

function sidecarFile(binary: string): string {
  return `${binary}.sha256`
}

// The install-time sidecar pins the extracted binary's SHA-256; every reuse
// re-verifies against it before the binary is executed at all, version probe
// included. A missing binary or sidecar just means "not installed" (the
// caller re-downloads); a mismatch means the cache was corrupted or tampered
// with, and running it anyway is exactly what the pin exists to prevent.
async function verifyCachedBinary(binary: string): Promise<boolean> {
  const [payload, recorded] = await Promise.all([
    fs.readFile(binary).catch(() => undefined),
    fs.readFile(sidecarFile(binary), "utf8").catch(() => undefined),
  ])
  if (payload === undefined || recorded === undefined) return false
  const expected = recorded.trim().toLowerCase()
  const digest = crypto.createHash("sha256").update(payload).digest("hex")
  if (digest !== expected) {
    throw new Error(
      `Cached opencode at ${binary} no longer matches its install-time SHA-256 sidecar ` +
        `(recorded ${expected}, found ${digest}); refusing to execute it. ` +
        `Delete ${path.dirname(binary)} to force a fresh verified download.`,
    )
  }
  return true
}

function cacheRoot(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
  return path.join(base, "macarons-e2e")
}

// The binary's reported version, or undefined for anything that cannot be
// spawned, exits non-zero, or hangs — callers treat all of those as "not the
// binary we need".
function probeVersion(binary: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(binary, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
      })
    } catch {
      resolve(undefined)
      return
    }
    let stdout = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve(undefined)
    }, PROBE_TIMEOUT_MS)
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.once("error", () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      const version = stdout.trim().replace(/^v/, "")
      resolve(code === 0 && version ? version : undefined)
    })
  })
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  )
}

// The release artifact for this machine, named the way the official install
// script resolves it: opencode-<os>-<arch>[-baseline][-musl].<ext>. Baseline
// builds serve x64 CPUs without AVX2; musl builds serve non-glibc Linux.
async function artifactName(): Promise<string> {
  const platform = process.platform === "darwin" ? "darwin" : "linux"
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  let target = `${platform}-${arch}`
  if (arch === "x64" && !(await hasAvx2(platform))) target += "-baseline"
  if (platform === "linux" && (await isMusl())) target += "-musl"
  return `opencode-${target}${platform === "linux" ? ".tar.gz" : ".zip"}`
}

async function hasAvx2(platform: "linux" | "darwin"): Promise<boolean> {
  if (platform === "linux") {
    const cpuinfo = await fs.readFile("/proc/cpuinfo", "utf8").catch(() => "")
    return /\bavx2\b/i.test(cpuinfo)
  }
  const flag = await runCommand("sysctl", ["-n", "hw.optional.avx2_0"]).catch(
    () => "0",
  )
  return flag.trim() === "1"
}

async function isMusl(): Promise<boolean> {
  if (await exists("/etc/alpine-release")) return true
  const ldd = await runCommand("ldd", ["--version"]).catch((error: unknown) =>
    error instanceof Error ? error.message : "",
  )
  return /musl/i.test(ldd)
}

async function downloadPinned(destination: string): Promise<void> {
  if (process.platform === "win32") {
    throw new Error(
      `OpenCode ${EXPECTED_OPENCODE_VERSION} is not on PATH and the harness has no pinned Windows artifact; ` +
        `set OPENCODE_BIN to a ${EXPECTED_OPENCODE_VERSION} binary, or OPENCODE_E2E_VERSION to the version you have.`,
    )
  }
  const artifact = await artifactName()
  const committed =
    EXPECTED_OPENCODE_VERSION === CHECKSUMS.version
      ? CHECKSUMS.assets[artifact]
      : undefined
  const overrideSha = process.env.OPENCODE_E2E_SHA256
  // The env override exists so an OPENCODE_E2E_VERSION with no committed
  // checksum stays testable; it must never displace a committed pin.
  if (overrideSha && committed) {
    console.error(
      `opencode-binary: ignoring OPENCODE_E2E_SHA256 — OpenCode ${EXPECTED_OPENCODE_VERSION} (${artifact}) ` +
        `has a committed checksum in .opencode-checksums.json, which always wins.`,
    )
  } else if (overrideSha && !committed) {
    console.error(
      `opencode-binary: no committed checksum for OpenCode ${EXPECTED_OPENCODE_VERSION} (${artifact}); ` +
        `trusting the caller-supplied OPENCODE_E2E_SHA256 for this download.`,
    )
  }
  const pinned = committed ?? overrideSha
  if (!pinned) {
    throw new Error(
      `No pinned SHA-256 for OpenCode ${EXPECTED_OPENCODE_VERSION} (${artifact}); the harness refuses to run ` +
        `unverified downloads. Set OPENCODE_BIN to an existing ${EXPECTED_OPENCODE_VERSION} binary, or set ` +
        `OPENCODE_E2E_SHA256 to that artifact's checksum after verifying it yourself.`,
    )
  }
  // Staging lives inside the cache root so the final rename stays on one
  // filesystem; concurrent downloads can only replace the file with an
  // identical (checksum-verified) one.
  const staging = path.join(cacheRoot(), `staging-${process.pid}-${Date.now()}`)
  await fs.mkdir(staging, { recursive: true })
  try {
    const url = `${RELEASE_URL_BASE}/v${EXPECTED_OPENCODE_VERSION}/${artifact}`
    const response = await fetch(url)
    if (!response.ok)
      throw new Error(`GET ${url} failed: HTTP ${response.status}`)
    const payload = Buffer.from(await response.arrayBuffer())
    const digest = crypto.createHash("sha256").update(payload).digest("hex")
    if (digest !== pinned.toLowerCase()) {
      throw new Error(
        `checksum mismatch for ${artifact}: expected ${pinned}, downloaded ${digest}`,
      )
    }
    const archive = path.join(staging, artifact)
    await fs.writeFile(archive, payload)
    if (artifact.endsWith(".tar.gz"))
      await runCommand("tar", ["xzf", archive, "-C", staging])
    else await runCommand("unzip", ["-o", archive, "-d", staging])
    const binary = path.join(staging, "opencode")
    await fs.chmod(binary, 0o755)
    // Record the extracted binary's own hash so later runs can re-verify the
    // cache before executing it. Both files land via rename, so a
    // half-written install can never pass verifyCachedBinary; it just looks
    // uninstalled and is downloaded again.
    const binaryDigest = crypto
      .createHash("sha256")
      .update(await fs.readFile(binary))
      .digest("hex")
    const stagedSidecar = path.join(staging, "opencode.sha256")
    await fs.writeFile(stagedSidecar, `${binaryDigest}\n`)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.rename(binary, destination)
    await fs.rename(stagedSidecar, sidecarFile(destination))
  } catch (error) {
    throw new Error(
      `Could not fetch OpenCode ${EXPECTED_OPENCODE_VERSION} for the E2E suites ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `Set OPENCODE_BIN to an existing ${EXPECTED_OPENCODE_VERSION} binary, ` +
        `or OPENCODE_E2E_VERSION to the version already on PATH.`,
    )
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    const append = (chunk: Buffer) => {
      output += chunk.toString()
    }
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    child.once("error", reject)
    child.once("close", (code) => {
      if (code === 0) resolve(output)
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}: ${output.slice(-500)}`,
          ),
        )
    })
  })
}

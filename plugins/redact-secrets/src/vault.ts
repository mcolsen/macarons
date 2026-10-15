import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  createSerialQueue,
  openCodeDataDir,
  readJsonFile,
} from "@macarons/permission-rules"
import {
  type FingerprintEntry,
  type RedactOptions,
  type ScanLimitInfo,
  validFingerprintEntry,
} from "./shared"
import { WireRedactor } from "./v2-request"

// Preserve the existing installation's keyed fingerprints when moving to V2.
// Only hashes, rule labels, and lengths are persisted; never plaintext secrets.
export async function createVault(
  options: RedactOptions,
  onScanLimit: (info: ScanLimitInfo) => void,
) {
  const dataDir = openCodeDataDir(process.env, homedir())
  const log = (_level: string, message: string) =>
    console.warn(`redact-secrets: ${message}`)
  const loadOrCreateHashKey = async (): Promise<string> => {
    const keyPath = join(dataDir, "redact-secrets.key")
    const isKey = (value: string): boolean => /^[0-9a-f]{64}$/i.test(value)
    const readKey = async (): Promise<string | undefined> => {
      try {
        const value = (await readFile(keyPath, "utf8")).trim()
        return isKey(value) ? value : undefined
      } catch {
        return undefined
      }
    }
    const existing = await readKey()
    if (existing) return existing
    const key = randomBytes(32).toString("hex")
    try {
      await mkdir(dataDir, { recursive: true })
      // wx fails when the path already exists: either another process just
      // won the create race (prefer its key, so both agree) or a corrupt key
      // file is squatting there and needs repair below.
      await writeFile(keyPath, key, { mode: 0o600, flag: "wx" })
      return key
    } catch {
      const raced = await readKey()
      if (raced) return raced
      // The file exists but holds no valid key (a truncated or interrupted
      // write). Left in place it would fail the wx create on EVERY start and
      // permanently downgrade the plugin to ephemeral keys — so it is
      // repaired, and repair must be SERIALIZED: with each repairer renaming
      // its own fresh key over the path, two concurrent boots could adopt
      // DIFFERENT keys — one reads the file between the two renames and keeps
      // a key the final file no longer holds (reproduced review finding), and
      // every placeholder it mints is unrecoverable after the next restart. A
      // wx-created lock file arbitrates: ONLY the lock holder may rewrite
      // keyPath, and it re-reads under the lock first, so a valid key, once
      // published, is never replaced — every process converges on the first
      // one written, whether it came from a repairer or from a concurrent
      // fresh boot's plain wx create. Losers poll for that key; a lock left
      // by a crashed repairer is stolen once its mtime goes stale.
      const lockPath = `${keyPath}.lock`
      const deadline = Date.now() + 3_000
      while (Date.now() < deadline) {
        let locked = false
        try {
          await writeFile(lockPath, String(process.pid), {
            mode: 0o600,
            flag: "wx",
          })
          locked = true
        } catch {
          try {
            const info = await stat(lockPath)
            if (Date.now() - info.mtimeMs > 10_000)
              await rm(lockPath, { force: true })
          } catch {
            // The holder released it between our wx and the stat; loop and
            // retry immediately.
          }
        }
        if (locked) {
          try {
            // Re-validate under the lock: another process may have published
            // a valid key since our read — never replace it.
            const current = await readKey()
            if (current) return current
            const tmpPath = `${keyPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
            try {
              await writeFile(tmpPath, key, { mode: 0o600, flag: "wx" })
              await rename(tmpPath, keyPath)
            } catch (error) {
              await rm(tmpPath, { force: true }).catch(() => {})
              throw error
            }
            return key
          } catch {
            break // unwritable data dir — fall through to the ephemeral warning
          } finally {
            await rm(lockPath, { force: true }).catch(() => {})
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
        const published = await readKey()
        if (published) return published
      }
      log(
        "warn",
        "could not persist placeholder key; placeholders minted this run will not survive a restart",
      )
      return key
    }
  }

  // Fingerprint catalog: the non-reversible (hash, ruleId, length) record of
  // every secret this install has ever vaulted — the restart half of the
  // exact-match defense. text.complete writes restored secrets back into
  // stored prose where they can sit WITHOUT the field context their detection
  // rule needs ("- x7k2…"); pre-restart the in-memory vault exact-matches
  // them, and post-restart only this catalog can (rule re-scanning cannot see
  // a contextless bare token). Nothing reversible is persisted: the 16-hex
  // keyed hash already rides inside every placeholder sent to providers, and
  // rule id + length are the only metadata disclosed (README, "What touches
  // disk"). Losing entries narrows recovery back to rules + env fingerprinting;
  // contextless values previously restored into prose may no longer be masked.
  const FINGERPRINT_LIMIT = 2048
  const fingerprintsPath = join(dataDir, "redact-secrets.fingerprints.json")
  const fingerprintCatalog = new Map<
    string,
    { ruleId: string; length: number }
  >()

  // Missing or unreadable catalogs seed no fingerprints. Rule detection still
  // runs, but cannot replace the lost context-free recovery.
  const readFingerprintFile = async (): Promise<FingerprintEntry[]> =>
    (await readJsonFile<FingerprintEntry[]>(
      fingerprintsPath,
      (value) => {
        const parsed = value as { entries?: unknown } | null
        if (!parsed || typeof parsed !== "object") return []
        if (!Array.isArray(parsed.entries)) return []
        return parsed.entries.filter(validFingerprintEntry)
      },
      { onMissing: () => [] },
    )) ?? []

  let persistedFingerprints = (await readFingerprintFile()).slice(
    -FINGERPRINT_LIMIT,
  )
  let fingerprintTimer: ReturnType<typeof setTimeout> | undefined
  const fingerprintWrites = createSerialQueue()
  let fingerprintWarned = false
  const persistFingerprints = (): Promise<void> => {
    if (fingerprintTimer) {
      clearTimeout(fingerprintTimer)
      fingerprintTimer = undefined
    }
    return fingerprintWrites.push(async () => {
      try {
        await mkdir(dataDir, { recursive: true })
        // Merge with the file first so a concurrent instance's entries are
        // carried forward instead of clobbered. Simultaneous renames can still
        // lose a batch until that instance's next write (README known gaps).
        const merged = new Map<string, { ruleId: string; length: number }>()
        for (const entry of await readFingerprintFile()) {
          merged.set(entry.hash, {
            ruleId: entry.ruleId,
            length: entry.length,
          })
        }
        for (const [hash, entry] of fingerprintCatalog) merged.set(hash, entry)
        const entries = [...merged]
          .slice(-FINGERPRINT_LIMIT)
          .map(([hash, entry]) => ({ hash, ...entry }))
        const tmpPath = `${fingerprintsPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
        try {
          await writeFile(tmpPath, JSON.stringify({ version: 1, entries }), {
            mode: 0o600,
            flag: "wx",
          })
          await rename(tmpPath, fingerprintsPath)
        } catch (error) {
          await rm(tmpPath, { force: true }).catch(() => {})
          throw error
        }
        // Only this exact snapshot reached disk. Registrations arriving during
        // the write belong to the next batch and cannot certify a restore yet.
        persistedFingerprints = entries
      } catch {
        if (!fingerprintWarned) {
          fingerprintWarned = true
          log(
            "warn",
            "could not persist secret fingerprints; recovery after a restart may be limited",
          )
        }
      }
    })
  }

  for (const entry of persistedFingerprints) {
    fingerprintCatalog.set(entry.hash, {
      ruleId: entry.ruleId,
      length: entry.length,
    })
  }

  const redactor = new WireRedactor(
    options,
    await loadOrCreateHashKey(),
    (entry) => {
      const existing = fingerprintCatalog.get(entry.hash)
      if (
        existing &&
        existing.ruleId === entry.ruleId &&
        existing.length === entry.length
      )
        return
      fingerprintCatalog.set(entry.hash, {
        ruleId: entry.ruleId,
        length: entry.length,
      })
      // Insertion-order eviction: the catalog is a recency window, not an
      // archive — 2048 distinct secrets is far beyond any real session count.
      while (fingerprintCatalog.size > FINGERPRINT_LIMIT) {
        const oldest = fingerprintCatalog.keys().next().value
        if (oldest === undefined) break
        fingerprintCatalog.delete(oldest)
      }
      // Batch bursts, but keep the timer referenced so ordinary shutdown lets
      // the write finish. text.complete flushes it before restoring stored text.
      if (!fingerprintTimer)
        fingerprintTimer = setTimeout(() => void persistFingerprints(), 250)
    },
    (info: ScanLimitInfo) => onScanLimit(info),
  )

  redactor.seedFingerprints(persistedFingerprints)
  return {
    redactor,
    async flush() {
      if (fingerprintTimer) await persistFingerprints()
      await fingerprintWrites.drain()
    },
  }
}

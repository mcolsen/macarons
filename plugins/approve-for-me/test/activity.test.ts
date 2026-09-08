import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isLockBusyError } from "@macarons/permission-rules"
import {
  ACTIVITY_MAX_ENTRIES,
  ACTIVITY_TTL_MS,
  type ActivityEntry,
  activityFile,
  clearActivity,
  clearSessionModel,
  clearTrustedSessionModelIfUnchanged,
  listTrustedSessionModels,
  overrideFile,
  pruneActivity,
  readActivity,
  readSessionModel,
  readTrustedSessionModel,
  resolveTrustedSettingsPaths,
  SERVICE,
  STORAGE_SERVICE,
  sessionModelDirectory,
  sessionModelFile,
  writeActivity,
  writeSessionModel,
} from "../src/shared"
import { sessionModelOpenFlags } from "../src/shared/persisted-state"

/**
 * The activity feed's file plumbing: the instance-scoped channel the server
 * half writes and the TUI sidebar reads — per-request annotations plus the
 * ready/paused server beacon. It is display-only, so the failure contract
 * differs from the settings pipeline on purpose: a file that cannot be read
 * yields undefined (the stream degrades to unannotated prompts and the beacon
 * to "unknown"), and one bad record is skipped instead of blanking the whole
 * feed.
 */

let sandboxRoot: string
const instanceID = "11111111-1111-4111-8111-111111111111"
const peerID = "22222222-2222-4222-8222-222222222222"

beforeEach(async () => {
  // realpath: the plugin canonicalizes the project root before hashing it
  // into file names, and macOS puts os.tmpdir() behind the /var →
  // /private/var symlink — raw mkdtemp paths would hash differently.
  sandboxRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "auto-approve-activity-")),
  )
})

afterEach(async () => {
  await fs.rm(sandboxRoot, { recursive: true, force: true })
})

const file = () => path.join(sandboxRoot, "activity.json")

describe("session model records", () => {
  const rootSessionID = "ses_opaque/root-id"
  const stateDir = () => path.join(sandboxRoot, "state")
  const sessionModelsDir = () => sessionModelDirectory(stateDir())
  const sessionFile = () => sessionModelFile(sessionModelsDir(), rootSessionID)
  const record = {
    version: 1 as const,
    rootSessionID,
    revision: "rev_1",
    mode: "override" as const,
    model: "openai/gpt-5.6" as string | null,
    variant: "high" as string | null,
  }

  test("uses a dedicated full-hash file below trusted state", () => {
    const file = sessionFile()
    expect(file).toBe(
      path.join(
        sessionModelsDir(),
        `${Bun.CryptoHasher.hash("sha256", rootSessionID, "hex")}.json`,
      ),
    )
    expect(file).not.toContain(rootSessionID)
    expect(() => sessionModelFile(sessionModelsDir(), "")).toThrow(
      "invalid root session ID",
    )
    expect(() => sessionModelFile(sessionModelsDir(), " ses_opaque")).toThrow(
      "invalid root session ID",
    )
  })

  test("requires a non-inert O_NOFOLLOW capability", () => {
    expect(
      sessionModelOpenFlags({ O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 4 }),
    ).toBeUndefined()
    expect(
      sessionModelOpenFlags({ O_RDONLY: 0, O_NOFOLLOW: 2, O_NONBLOCK: 4 }),
    ).toBe(6)
  })

  test("distinguishes missing, valid, and invalid records", async () => {
    expect(await readSessionModel(sessionFile(), rootSessionID)).toEqual({
      status: "missing",
    })
    await writeSessionModel(sessionFile(), record)
    expect(await readSessionModel(sessionFile(), rootSessionID)).toEqual({
      status: "valid",
      record,
    })
    const noModel = { ...record, model: null, variant: null }
    await writeSessionModel(sessionFile(), noModel)
    expect(await readSessionModel(sessionFile(), rootSessionID)).toEqual({
      status: "valid",
      record: noModel,
    })
    const inherit = {
      ...record,
      mode: "inherit" as const,
      model: null,
      variant: null,
    }
    await writeSessionModel(sessionFile(), inherit)
    expect(await readSessionModel(sessionFile(), rootSessionID)).toEqual({
      status: "valid",
      record: inherit,
    })
    await fs.writeFile(sessionFile(), "{not json")
    expect(await readSessionModel(sessionFile(), rootSessionID)).toEqual({
      status: "invalid",
    })
    await fs.rm(sessionFile())
    await fs.mkdir(sessionFile())
    expect(await readSessionModel(sessionFile(), rootSessionID)).toEqual({
      status: "invalid",
    })
  })

  test("trusted reads distinguish missing and valid records", async () => {
    expect(
      await readTrustedSessionModel(sessionModelsDir(), rootSessionID),
    ).toEqual({ status: "missing" })
    await writeSessionModel(sessionFile(), record)
    expect(
      await readTrustedSessionModel(sessionModelsDir(), rootSessionID),
    ).toEqual({ status: "valid", record })
  })

  test("writes private files and directories and tightens rewritten files", async () => {
    await writeSessionModel(sessionFile(), record)
    expect((await fs.stat(sessionModelsDir())).mode & 0o777).toBe(0o700)
    expect((await fs.stat(sessionFile())).mode & 0o777).toBe(0o600)

    await fs.chmod(sessionFile(), 0o644)
    await writeSessionModel(sessionFile(), {
      ...record,
      revision: "rev_rewritten",
    })
    expect((await fs.stat(sessionFile())).mode & 0o777).toBe(0o600)
  })

  test("refuses to publish after the trusted parent is redirected", async () => {
    const trustedDir = sessionModelsDir()
    const movedDir = `${trustedDir}.moved`
    const realLstat = fs.lstat.bind(fs) as (...args: any[]) => Promise<any>
    let trustedDirStats = 0
    let redirected = false
    const lstat = spyOn(fs, "lstat").mockImplementation((async (
      target: Parameters<typeof fs.lstat>[0],
      options?: Parameters<typeof fs.lstat>[1],
    ) => {
      if (String(target) === trustedDir && ++trustedDirStats === 2) {
        redirected = true
        await fs.rename(trustedDir, movedDir)
        await fs.mkdir(trustedDir)
      }
      return realLstat(target, options)
    }) as typeof fs.lstat)
    try {
      await expect(writeSessionModel(sessionFile(), record)).rejects.toThrow(
        "session model parent is no longer trusted",
      )
      expect(redirected).toBe(true)
      expect(await fs.exists(sessionFile())).toBe(false)
    } finally {
      lstat.mockRestore()
    }
  })

  test("trusted enumeration and conditional cleanup retain changed records", async () => {
    await writeSessionModel(sessionFile(), record)
    expect(await listTrustedSessionModels(sessionModelsDir())).toEqual([record])

    const replacement = { ...record, revision: "rev_replacement" }
    await writeSessionModel(sessionFile(), replacement)
    expect(
      await clearTrustedSessionModelIfUnchanged(sessionModelsDir(), record),
    ).toBe(false)
    expect(
      await readTrustedSessionModel(sessionModelsDir(), rootSessionID),
    ).toEqual({ status: "valid", record: replacement })
    expect(
      await clearTrustedSessionModelIfUnchanged(
        sessionModelsDir(),
        replacement,
      ),
    ).toBe(true)
  })

  test("conditional cleanup reports lock contention distinctly", async () => {
    await writeSessionModel(sessionFile(), record)
    await fs.writeFile(`${sessionFile()}.lock`, "peer lock")
    let now = Date.now()
    const clock = spyOn(Date, "now").mockImplementation(() => (now += 2_000))
    let error: unknown
    try {
      await clearTrustedSessionModelIfUnchanged(sessionModelsDir(), record)
    } catch (caught) {
      error = caught
    } finally {
      clock.mockRestore()
    }

    expect(isLockBusyError(error)).toBe(true)
    expect(
      await readTrustedSessionModel(sessionModelsDir(), rootSessionID),
    ).toEqual({ status: "valid", record })
  })

  test("conditional cleanup surfaces structural lock failures", async () => {
    await writeSessionModel(sessionFile(), record)
    await fs.mkdir(`${sessionFile()}.lock`)

    await expect(
      clearTrustedSessionModelIfUnchanged(sessionModelsDir(), record),
    ).rejects.toThrow("lock path is not a regular file")
    expect(
      await readTrustedSessionModel(sessionModelsDir(), rootSessionID),
    ).toEqual({ status: "valid", record })
  })

  test("conditional cleanup cannot unlink a writer that starts after its check", async () => {
    await writeSessionModel(sessionFile(), record)
    const replacement = { ...record, revision: "rev_replacement" }
    const lockFile = `${sessionFile()}.lock`
    const realWriteFile = fs.writeFile.bind(fs) as (
      ...args: any[]
    ) => Promise<void>
    const realUnlink = fs.unlink.bind(fs)
    let replacementStarted = false
    let resolveAttempt: ((file: string) => void) | undefined
    const attempted = new Promise<string>((resolve) => {
      resolveAttempt = resolve
    })
    const writeFile = spyOn(fs, "writeFile").mockImplementation((async (
      ...args: any[]
    ) => {
      const target = String(args[0])
      if (replacementStarted) {
        replacementStarted = false
        resolveAttempt?.(target)
      }
      await realWriteFile(...args)
    }) as typeof fs.writeFile)
    let replacementWrite: Promise<void> | undefined
    const unlink = spyOn(fs, "unlink").mockImplementation((async (
      target: Parameters<typeof fs.unlink>[0],
    ) => {
      if (String(target) === sessionFile()) {
        replacementStarted = true
        replacementWrite = writeSessionModel(sessionFile(), replacement)
        expect(await attempted).toBe(lockFile)
      }
      return realUnlink(target)
    }) as typeof fs.unlink)
    try {
      expect(
        await clearTrustedSessionModelIfUnchanged(sessionModelsDir(), record),
      ).toBe(true)
      await replacementWrite
    } finally {
      await replacementWrite?.catch(() => {})
      unlink.mockRestore()
      writeFile.mockRestore()
    }
    expect(
      await readTrustedSessionModel(sessionModelsDir(), rootSessionID),
    ).toEqual({ status: "valid", record: replacement })
  })

  test("trusted reads reject a FIFO without blocking", async () => {
    await fs.mkdir(path.dirname(sessionFile()), { recursive: true })
    const { exited } = Bun.spawn(["mkfifo", sessionFile()])
    expect(await exited).toBe(0)
    expect(
      await readTrustedSessionModel(sessionModelsDir(), rootSessionID),
    ).toEqual({ status: "invalid" })
  }, 5_000)

  test("trusted reads reject a file swapped after open", async () => {
    await writeSessionModel(sessionFile(), record)
    const opened = `${sessionFile()}.opened`
    const replacement = { ...record, revision: "rev_replacement" }
    const realRealpath = fs.realpath.bind(fs)
    let swapped = false
    const realpath = spyOn(fs, "realpath").mockImplementation((async (
      target: Parameters<typeof fs.realpath>[0],
    ) => {
      if (!swapped && String(target) === sessionFile()) {
        swapped = true
        await fs.rename(sessionFile(), opened)
        await writeSessionModel(sessionFile(), replacement)
      }
      return realRealpath(target)
    }) as typeof fs.realpath)
    try {
      expect(
        await readTrustedSessionModel(sessionModelsDir(), rootSessionID),
      ).toEqual({ status: "invalid" })
      expect(swapped).toBe(true)
    } finally {
      realpath.mockRestore()
    }
  })

  test("rejects malformed records and root-session mismatches", async () => {
    for (const invalid of [
      [],
      {
        version: 1,
        rootSessionID,
        revision: "rev_1",
        model: "openai/gpt-5.6",
        variant: "high",
      },
      { ...record, rootSessionID: "ses_other" },
      { ...record, rootSessionID: "" },
      { ...record, version: 2 },
      { ...record, revision: "" },
      { ...record, mode: "unknown" },
      { ...record, mode: "inherit", model: "openai/gpt-5.6" },
      { ...record, mode: "inherit", model: null, variant: "high" },
      { ...record, model: null, variant: "high" },
      { ...record, model: "not-a-model" },
      { ...record, variant: " high" },
      { ...record, unexpected: true },
    ]) {
      await fs.mkdir(path.dirname(sessionFile()), { recursive: true })
      await fs.writeFile(sessionFile(), JSON.stringify(invalid))
      expect(await readSessionModel(sessionFile(), rootSessionID)).toEqual({
        status: "invalid",
      })
    }
  })

  test("write rejects records with invalid identifiers", async () => {
    await expect(
      writeSessionModel(sessionFile(), { ...record, rootSessionID: "" }),
    ).rejects.toThrow("invalid session model record")
    await expect(
      writeSessionModel(sessionFile(), { ...record, revision: "" }),
    ).rejects.toThrow("invalid session model record")
    await expect(
      writeSessionModel(sessionFile(), {
        ...record,
        mode: "inherit",
        model: "openai/gpt-5.6",
      }),
    ).rejects.toThrow("invalid session model record")
  })

  test("clear removes the session record and tolerates its absence", async () => {
    await writeSessionModel(sessionFile(), record)
    await clearSessionModel(sessionFile())
    expect(await readSessionModel(sessionFile(), rootSessionID)).toEqual({
      status: "missing",
    })
    await clearSessionModel(sessionFile())
  })
})

describe("the activity file location", () => {
  test("keeps public and persisted service identities intentionally separate", () => {
    expect(SERVICE).toBe("approve-for-me")
    expect(STORAGE_SERVICE).toBe("permissions-approve-for-me")
  })

  test("keyed by project root and factory UUID, beside the owned override", () => {
    const activity = activityFile("/state", "/home/user/project", instanceID)
    expect(activity).toStartWith(
      path.join("/state", "permissions-approve-for-me") + path.sep,
    )
    expect(path.basename(activity)).toMatch(
      new RegExp(`^activity-project-[0-9a-f]{16}-${instanceID}\\.json$`),
    )
    expect(activity).not.toBe(
      overrideFile("/state", "/home/user/project", instanceID),
    )
    expect(activityFile("/state", "/home/user/other", instanceID)).not.toBe(
      activity,
    )
    expect(activityFile("/state", "/home/user/project", peerID)).not.toBe(
      activity,
    )
    for (const invalid of [
      undefined,
      "",
      "../peer",
      `${instanceID}/../peer`,
      "not-a-uuid",
    ])
      expect(() =>
        activityFile("/state", "/home/user/project", invalid as string),
      ).toThrow("invalid instance ID")
  })

  test("resolveTrustedSettingsPaths derives it with the same containment check", async () => {
    const project = path.join(sandboxRoot, "project")
    const config = path.join(sandboxRoot, "config")
    const state = path.join(sandboxRoot, "state")
    await Promise.all([fs.mkdir(project), fs.mkdir(config), fs.mkdir(state)])
    const trusted = await resolveTrustedSettingsPaths(
      project,
      config,
      state,
      path.join(sandboxRoot, "data"),
      instanceID,
    )
    expect(trusted?.activityPath).toBe(activityFile(state, project, instanceID))
    expect(trusted?.sessionModelsDir).toBe(sessionModelDirectory(state))
    // A state dir inside the worktree would make the feed agent-writable.
    expect(
      await resolveTrustedSettingsPaths(
        project,
        config,
        path.join(project, ".state"),
        path.join(sandboxRoot, "data"),
        instanceID,
      ),
    ).toBeUndefined()
  })
})

describe("reading and writing", () => {
  test("a missing file is an empty feed with no beacon, a written one round-trips", async () => {
    expect(await readActivity(file())).toEqual({ requests: {} })
    const activity = {
      server: { state: "ready" as const, time: 500 },
      requests: {
        per_1: { state: "evaluating" as const, reason: "e2e/test", time: 1000 },
        per_2: { state: "approved" as const, time: 2000 },
      },
    }
    await writeActivity(file(), activity)
    expect(await readActivity(file())).toEqual(activity)
  })

  test("a paused beacon round-trips with its reason", async () => {
    const activity = {
      server: {
        state: "paused" as const,
        reason: "the permission store is unreadable or invalid JSON",
        time: 3,
      },
      requests: {},
    }
    await writeActivity(file(), activity)
    expect(await readActivity(file())).toEqual(activity)
  })

  test("writes owned activity files privately without widening stricter modes under umask 022", async () => {
    if (process.platform === "win32") return
    const state = path.join(sandboxRoot, "state")
    const project = path.join(sandboxRoot, "project")
    await fs.mkdir(project)
    const current = activityFile(state, project, instanceID)
    const peer = activityFile(state, project, peerID)
    const parent = path.dirname(current)
    const activity = {
      server: { state: "ready" as const, time: 1 },
      requests: {
        per_1: { state: "approved" as const, reason: "safe", time: 2 },
      },
    }
    const previous = process.umask(0o022)
    try {
      await Promise.all([
        writeActivity(current, activity),
        writeActivity(peer, activity),
      ])
      expect((await fs.stat(current)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(peer)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(parent)).mode & 0o777).toBe(0o700)

      await fs.chmod(current, 0o644)
      await fs.chmod(peer, 0o400)
      await fs.chmod(parent, 0o755)
      await Promise.all([
        writeActivity(current, activity),
        writeActivity(peer, activity),
      ])
      expect((await fs.stat(current)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(peer)).mode & 0o777).toBe(0o400)
      expect((await fs.stat(parent)).mode & 0o777).toBe(0o700)
    } finally {
      process.umask(previous)
    }
  })

  test("unreadable or wrongly-shaped files are undefined, not a crash", async () => {
    await fs.writeFile(file(), "{not json")
    expect(await readActivity(file())).toBeUndefined()
    await fs.writeFile(file(), JSON.stringify([1, 2]))
    expect(await readActivity(file())).toBeUndefined()
    // The pre-beacon flat shape (a bare request map) is not trusted either:
    // the file is instance-scoped and both halves ship together, so a flat
    // file is corruption, not an older version.
    await fs.writeFile(
      file(),
      JSON.stringify({ per_1: { state: "approved", time: 1 } }),
    )
    expect(await readActivity(file())).toBeUndefined()
    await fs.mkdir(path.join(sandboxRoot, "dir"))
    expect(await readActivity(path.join(sandboxRoot, "dir"))).toBeUndefined()
  })

  test("an invalid beacon is dropped, never trusted partially", async () => {
    for (const server of [
      { state: "on", time: 1 },
      { state: "ready", time: "soon" },
      { state: "paused", reason: 7, time: 1 },
      "ready",
    ]) {
      await fs.writeFile(file(), JSON.stringify({ server, requests: {} }))
      expect(await readActivity(file())).toEqual({ requests: {} })
    }
  })

  test("invalid records are skipped one by one, valid ones survive", async () => {
    await fs.writeFile(
      file(),
      JSON.stringify({
        requests: {
          good: { state: "surfaced", reason: "pushes to a remote", time: 1 },
          badState: { state: "yolo", time: 1 },
          badTime: { state: "approved", time: "soon" },
          badReason: { state: "approved", reason: 7, time: 1 },
          badDenyAt: { state: "surfaced", time: 1, denyAt: "later" },
          notAnObject: "approved",
          emptyReasonDropped: { state: "skipped", reason: "", time: 2 },
        },
      }),
    )
    expect(await readActivity(file())).toEqual({
      requests: {
        good: { state: "surfaced", reason: "pushes to a remote", time: 1 },
        emptyReasonDropped: { state: "skipped", time: 2 },
      },
    })
  })

  test("the unattended-deny annotations round-trip: a deadline on a surfaced entry, a denied state after it fires", async () => {
    const activity = {
      requests: {
        per_1: {
          state: "surfaced" as const,
          reason: "pushes to a remote",
          time: 1000,
          denyAt: 1_201_000,
        },
        per_2: {
          state: "denied" as const,
          reason: "no answer for 20 min — denied so the run can move on",
          time: 2000,
        },
      },
    }
    await writeActivity(file(), activity)
    expect(await readActivity(file())).toEqual(activity)
  })
})

describe("pruning", () => {
  const entry = (time: number): ActivityEntry => ({ state: "approved", time })

  test("entries age out after the TTL", () => {
    const entries = new Map([
      ["old", entry(0)],
      ["fresh", entry(ACTIVITY_TTL_MS)],
    ])
    pruneActivity(entries, ACTIVITY_TTL_MS + 1)
    expect([...entries.keys()]).toEqual(["fresh"])
  })

  test("the cap drops the oldest entries first", () => {
    const entries = new Map<string, ActivityEntry>()
    for (let i = 0; i <= ACTIVITY_MAX_ENTRIES + 1; i++)
      entries.set(`per_${i}`, entry(i))
    pruneActivity(entries, ACTIVITY_MAX_ENTRIES)
    expect(entries.size).toBe(ACTIVITY_MAX_ENTRIES)
    expect(entries.has("per_0")).toBe(false)
    expect(entries.has("per_1")).toBe(false)
    expect(entries.has(`per_${ACTIVITY_MAX_ENTRIES + 1}`)).toBe(true)
  })

  test("a live deny deadline is exempt from the TTL until it passes", () => {
    const entries = new Map<string, ActivityEntry>([
      ["armed", { state: "surfaced", time: 0, denyAt: 1_200_000 }],
      ["settled", { state: "approved", time: 0 }],
    ])
    // The 20-minute deadline outlives the 10-minute TTL: the countdown for a
    // still-pending prompt must survive every intermediate flush.
    pruneActivity(entries, ACTIVITY_TTL_MS + 1)
    expect([...entries.keys()]).toEqual(["armed"])
    // Once the deadline has passed, the ordinary TTL applies again.
    pruneActivity(entries, 1_200_000 + ACTIVITY_TTL_MS + 1)
    expect(entries.size).toBe(0)
  })

  test("the cap evicts settled entries before live deadlines", () => {
    const entries = new Map<string, ActivityEntry>()
    entries.set("armed", { state: "surfaced", time: 0, denyAt: 10_000_000 })
    for (let i = 1; i <= ACTIVITY_MAX_ENTRIES + 1; i++)
      entries.set(`per_${i}`, entry(i))
    pruneActivity(entries, 1_000)
    expect(entries.size).toBe(ACTIVITY_MAX_ENTRIES)
    // Oldest by time, yet kept: its deadline is still counting down.
    expect(entries.has("armed")).toBe(true)
    expect(entries.has("per_1")).toBe(false)
    expect(entries.has("per_2")).toBe(false)
  })

  test("clearActivity removes the file and tolerates its absence", async () => {
    await writeActivity(file(), {
      requests: { per_1: { state: "approved", time: 1 } },
    })
    await clearActivity(file())
    expect(await readActivity(file())).toEqual({ requests: {} })
    await clearActivity(file())
  })
})

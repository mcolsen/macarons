import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  APPROVALS_MAX_PATTERNS,
  type Approvals,
  approvalsJournalFile,
  emptyApprovals,
  pruneApprovals,
  readApprovalsJournal,
  recordApproval,
  resolveTrustedSettingsPaths,
  STORAGE_SERVICE,
  writeApprovalsJournal,
} from "../src/shared"

/**
 * The approvals journal: the durable per-project record of classifier
 * approvals that the enshrine-approvals skill reads. Advisory data with a
 * fail-soft contract — a corrupt journal starts over, bad records are dropped
 * one by one — and container hygiene strong enough that recorded command text
 * can never act as anything but data.
 */

let sandbox: string

beforeEach(async () => {
  sandbox = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "approvals-journal-")),
  )
})

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true })
})

const journalFile = () => path.join(sandbox, "journal.json")

describe("approvalsJournalFile", () => {
  test("keys by the readable slug + short-hash name under the state directory, like the store", () => {
    const root = path.join(sandbox, "project")
    const hash = crypto.createHash("sha256").update(root).digest("hex")
    expect(approvalsJournalFile(path.join(sandbox, "state"), root)).toBe(
      path.join(
        sandbox,
        "state",
        STORAGE_SERVICE,
        "approvals",
        `project-${hash.slice(0, 16)}.json`,
      ),
    )
  })

  test("resolveTrustedSettingsPaths derives and validates it", async () => {
    const root = path.join(sandbox, "project")
    const config = path.join(sandbox, "config")
    const state = path.join(sandbox, "state")
    await Promise.all([fs.mkdir(root), fs.mkdir(config), fs.mkdir(state)])
    const trusted = await resolveTrustedSettingsPaths(
      root,
      config,
      state,
      path.join(sandbox, "data"),
      crypto.randomUUID(),
    )
    expect(trusted?.journalPath).toBe(approvalsJournalFile(state, root))
  })
})

describe("recordApproval", () => {
  test("first approval creates the entry; repeats aggregate count, last, and risk tallies", () => {
    const approvals = emptyApprovals()
    recordApproval(approvals, "bash", ["git status *"], "low", 1_000)
    expect(approvals.bash?.["git status *"]).toEqual({
      count: 1,
      first: 1_000,
      last: 1_000,
      risks: { low: 1 },
    })
    recordApproval(approvals, "bash", ["git status *"], "medium", 2_000)
    expect(approvals.bash?.["git status *"]).toEqual({
      count: 2,
      first: 1_000,
      last: 2_000,
      risks: { low: 1, medium: 1 },
    })
  })

  test("multiple patterns record separately; duplicates in one request count once", () => {
    const approvals = emptyApprovals()
    recordApproval(
      approvals,
      "external_directory",
      ["/tmp/a/*", "/tmp/b/*", "/tmp/a/*"],
      "low",
      5,
    )
    expect(approvals.external_directory?.["/tmp/a/*"]?.count).toBe(1)
    expect(approvals.external_directory?.["/tmp/b/*"]?.count).toBe(1)
  })

  test("an empty pattern list records nothing", () => {
    const approvals = emptyApprovals()
    recordApproval(approvals, "bash", [], "low", 5)
    expect(Object.keys(approvals)).toEqual([])
  })

  test("arbitrary literal names land as own keys, never as prototypes", () => {
    const approvals = emptyApprovals()
    for (const key of ["__proto__", "constructor", "toString"]) {
      recordApproval(approvals, key, [key], "low", 5)
      recordApproval(approvals, key, [key], "low", 6)
      expect(Object.hasOwn(approvals, key)).toBe(true)
      expect(Object.hasOwn(approvals[key]!, key)).toBe(true)
      expect(approvals[key]?.[key]?.count).toBe(2)
    }
    // Nothing polluted: the containers stay prototype-less and fresh plain
    // objects are unaffected.
    expect(Object.getPrototypeOf(approvals)).toBeNull()
    const fresh: Record<string, unknown> = {}
    expect(fresh.count).toBeUndefined()
  })
})

describe("pruneApprovals", () => {
  test("evicts the least recently approved patterns beyond the cap, dropping emptied tools", () => {
    const approvals = emptyApprovals()
    recordApproval(approvals, "stale", ["only-pattern"], "low", 1)
    for (let i = 0; i < APPROVALS_MAX_PATTERNS; i++) {
      recordApproval(approvals, "bash", [`command-${i} *`], "low", 100 + i)
    }
    expect(approvals.stale).toBeUndefined()
    expect(approvals.bash?.["command-0 *"]).toBeDefined()
    expect(Object.keys(approvals.bash!)).toHaveLength(APPROVALS_MAX_PATTERNS)

    pruneApprovals(approvals)
    expect(Object.keys(approvals.bash!)).toHaveLength(APPROVALS_MAX_PATTERNS)
  })
})

describe("writeApprovalsJournal", () => {
  // The journal holds exact approved patterns (private paths, command text)
  // indefinitely, so it must never be readable by other local users.
  test("writes owner-only: a 0600 file under 0700 created directories", async () => {
    if (process.platform === "win32") return
    const file = approvalsJournalFile(path.join(sandbox, "state"), "/p")
    await writeApprovalsJournal(file, {
      root: "/p",
      approvals: emptyApprovals(),
    })
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700)
  })

  test("each update re-applies 0600, healing a journal from before the tightening", async () => {
    if (process.platform === "win32") return
    await fs.writeFile(journalFile(), "{}", { mode: 0o644 })
    await writeApprovalsJournal(journalFile(), {
      root: "/p",
      approvals: emptyApprovals(),
    })
    expect((await fs.stat(journalFile())).mode & 0o777).toBe(0o600)
  })
})

describe("readApprovalsJournal", () => {
  test("a missing journal is empty, not an error", async () => {
    expect(await readApprovalsJournal(journalFile())).toEqual({ approvals: {} })
  })

  test("round-trips what writeApprovalsJournal wrote", async () => {
    const approvals = emptyApprovals()
    recordApproval(approvals, "bash", ["ls *"], "low", 42)
    await writeApprovalsJournal(journalFile(), {
      root: "/home/user/project",
      approvals,
    })
    expect(await readApprovalsJournal(journalFile())).toEqual({
      root: "/home/user/project",
      approvals: {
        bash: { "ls *": { count: 1, first: 42, last: 42, risks: { low: 1 } } },
      },
    })
  })

  test("parses arbitrary literal permission and pattern names as own keys", async () => {
    const keys = ["__proto__", "constructor", "toString"]
    const entry = { count: 1, first: 2, last: 3, risks: { low: 1 } }
    const approvals = Object.fromEntries(
      keys.map((permission) => [
        permission,
        Object.fromEntries(keys.map((pattern) => [pattern, entry])),
      ]),
    )
    await fs.writeFile(journalFile(), JSON.stringify({ approvals }))

    const journal = await readApprovalsJournal(journalFile())
    if (!journal) throw new Error("unreachable")
    expect(Object.getPrototypeOf(journal.approvals)).toBeNull()
    for (const permission of keys) {
      expect(Object.hasOwn(journal.approvals, permission)).toBe(true)
      const patterns = journal.approvals[permission]!
      expect(Object.getPrototypeOf(patterns)).toBeNull()
      for (const pattern of keys) {
        expect(Object.hasOwn(patterns, pattern)).toBe(true)
        expect(patterns[pattern]).toEqual(entry)
      }
    }
    expect(({} as Record<string, unknown>).count).toBeUndefined()
  })

  for (const [label, text] of [
    ["invalid JSON", "{nope"],
    ["a non-object", '"journal"'],
    ["approvals of the wrong shape", '{ "approvals": [] }'],
    ["a mistyped root", '{ "root": 5, "approvals": {} }'],
  ] as const) {
    test(`${label} is undefined — the caller starts over`, async () => {
      await fs.writeFile(journalFile(), text)
      expect(await readApprovalsJournal(journalFile())).toBeUndefined()
    })
  }

  test("bad records are dropped one by one, never the whole history", async () => {
    await fs.writeFile(
      journalFile(),
      JSON.stringify({
        root: "/p",
        approvals: {
          bash: {
            "git status *": { count: 3, first: 1, last: 2, risks: { low: 3 } },
            "negative count": { count: -1, first: 1, last: 2, risks: {} },
            "mistyped tally": {
              count: 1,
              first: 1,
              last: 2,
              risks: { low: "many" },
            },
            "unknown grades are skipped, not fatal": {
              count: 1,
              first: 1,
              last: 2,
              risks: { catastrophic: 1 },
            },
          },
          edit: "not a pattern map",
        },
      }),
    )
    const journal = await readApprovalsJournal(journalFile())
    expect(journal?.approvals.bash?.["git status *"]?.count).toBe(3)
    expect(journal?.approvals.bash?.["negative count"]).toBeUndefined()
    expect(journal?.approvals.bash?.["mistyped tally"]).toBeUndefined()
    expect(
      journal?.approvals.bash?.["unknown grades are skipped, not fatal"]?.risks,
    ).toEqual({})
    expect(journal?.approvals.edit).toBeUndefined()
  })

  test("parsed containers are prototype-less: recording onto them stays own-key clean", async () => {
    await fs.writeFile(
      journalFile(),
      JSON.stringify({
        approvals: {
          bash: { "ls *": { count: 1, first: 1, last: 1, risks: {} } },
        },
      }),
    )
    const journal = await readApprovalsJournal(journalFile())
    if (!journal) throw new Error("unreachable")
    recordApproval(
      journal.approvals as Approvals,
      "bash",
      ["__proto__"],
      "low",
      2,
    )
    expect(Object.hasOwn(journal.approvals.bash!, "__proto__")).toBe(true)
    expect(journal.approvals.bash?.["ls *"]?.count).toBe(1)
  })
})

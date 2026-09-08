import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { writeJsonFile } from "@macarons/permission-rules"
import {
  DEFAULT_POLL_MS,
  DEFAULT_VISIBLE_MS,
  loadSearchesFile,
  MAX_SEARCHES,
  MAX_VISIBLE_MS,
  MIN_POLL_MS,
  MIN_VISIBLE_MS,
  parseSearchesFile,
  preSlugSearchesFilePath,
  pruneSearches,
  resolveSearchesPath,
  resolveTuiOptions,
  SERVER_RETENTION_MS,
  type SearchesFile,
  type SearchRecord,
  STATE_FILE_VERSION,
  SYNC_COMMAND,
  searchesFilePath,
  searchGlyph,
  searchIdPrefix,
  searchLabel,
  truncateLabel,
} from "../src/searches"

function record(overrides: Partial<SearchRecord> = {}): SearchRecord {
  return {
    id: "ws_abc123_1",
    sessionID: "ses_1",
    query: "solar flares",
    state: "running",
    startedAt: 1_000,
    ...overrides,
  }
}

describe("resolveTuiOptions", () => {
  test("defaults: sidebar on, 10s window, 15s poll", () => {
    const options = resolveTuiOptions(undefined)
    expect(options).toEqual({
      sidebar: true,
      visibleMs: DEFAULT_VISIBLE_MS,
      pollMs: DEFAULT_POLL_MS,
    })
    expect(DEFAULT_VISIBLE_MS).toBe(10_000)
  })

  test("sidebar disables only on an explicit false", () => {
    expect(resolveTuiOptions({ sidebar: false }).sidebar).toBe(false)
    expect(resolveTuiOptions({ sidebar: 0 }).sidebar).toBe(true)
    expect(resolveTuiOptions({}).sidebar).toBe(true)
  })

  test("visibleMs and pollMs are clamped to their bounds", () => {
    expect(resolveTuiOptions({ visibleMs: 1 }).visibleMs).toBe(MIN_VISIBLE_MS)
    expect(resolveTuiOptions({ visibleMs: 10 ** 9 }).visibleMs).toBe(
      MAX_VISIBLE_MS,
    )
    expect(resolveTuiOptions({ pollMs: 1 }).pollMs).toBe(MIN_POLL_MS)
    // A non-number falls back to the default rather than NaN.
    expect(resolveTuiOptions({ visibleMs: "soon" }).visibleMs).toBe(
      DEFAULT_VISIBLE_MS,
    )
  })

  test("the visible window can never outlast server retention", () => {
    // The server keeps rows for SERVER_RETENTION_MS; a TUI that displayed them
    // longer would show rows the file had already dropped.
    expect(MAX_VISIBLE_MS).toBeLessThanOrEqual(SERVER_RETENTION_MS)
  })
})

describe("pruneSearches", () => {
  test("keeps live rows regardless of age, drops ended past retention", () => {
    const now = 1_000_000
    const kept = pruneSearches(
      [
        record({ id: "live", state: "running", startedAt: 0 }),
        record({ id: "fresh", state: "complete", endedAt: now - 5_000 }),
        record({ id: "stale", state: "complete", endedAt: now - 120_000 }),
      ],
      now,
    )
    expect(kept.map((r) => r.id).sort()).toEqual(["fresh", "live"])
  })

  test("caps to the most recently started when over the limit", () => {
    const now = 1_000
    const many = Array.from({ length: MAX_SEARCHES + 5 }, (_, i) =>
      record({ id: `s${i}`, state: "running", startedAt: i }),
    )
    const kept = pruneSearches(many, now)
    expect(kept).toHaveLength(MAX_SEARCHES)
    // The five oldest (lowest startedAt) are the ones shed.
    expect(kept.some((r) => r.id === "s0")).toBe(false)
    expect(kept.some((r) => r.id === `s${MAX_SEARCHES + 4}`)).toBe(true)
  })
})

describe("parse round-trip", () => {
  test("a well-formed file survives, junk rows are dropped, foreign shape is nothing", () => {
    const file: SearchesFile = {
      version: STATE_FILE_VERSION,
      instance: { id: "inst", pid: 42, startedAt: 1 },
      updatedAt: 2,
      searches: [record({ id: "good", backend: "searxng", state: "complete" })],
    }
    const parsed = parseSearchesFile(JSON.parse(JSON.stringify(file)))
    expect(parsed?.searches).toHaveLength(1)
    expect(parsed?.searches[0]).toMatchObject({
      id: "good",
      backend: "searxng",
    })

    // One bad row must not blank the whole widget.
    const mixed = parseSearchesFile({
      ...file,
      searches: [record({ id: "ok" }), { id: "", sessionID: "x" }, 7],
    })
    expect(mixed?.searches.map((r) => r.id)).toEqual(["ok"])

    // A wrong version or foreign shape reads as "no file".
    expect(parseSearchesFile({ ...file, version: 99 })).toBeUndefined()
    expect(parseSearchesFile({ nope: true })).toBeUndefined()

    // An unknown backend string is dropped to undefined, not trusted.
    const weird = parseSearchesFile({
      ...file,
      searches: [record({ id: "b", backend: "evil" as never })],
    })
    expect(weird?.searches[0]?.backend).toBeUndefined()
  })
})

describe("resolveSearchesPath containment", () => {
  test("resolves under the state dir, rejects a state dir inside the project", async () => {
    const sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "websearch-path-")),
    )
    try {
      const project = path.join(sandbox, "project")
      const state = path.join(sandbox, "state")
      await Promise.all([fs.mkdir(project), fs.mkdir(state)])

      const resolved = await resolveSearchesPath(project, state)
      const realState = await fs.realpath(state)
      expect(resolved).toEqual({
        stateFile: searchesFilePath(realState, project),
        preSlugStateFile: preSlugSearchesFilePath(realState, project),
      })

      // A package rename must not disconnect an already-installed companion.
      for (const file of [resolved?.stateFile, resolved?.preSlugStateFile]) {
        expect(path.dirname(file as string)).toBe(
          path.join(realState, "websearch"),
        )
      }
      expect(SYNC_COMMAND).toBe("websearch.activity.sync")

      // The bridge only works if the pre-slug name stays byte-for-byte what
      // the previous release computed: bare 16-hex hash, no slug.
      expect(
        path.basename(preSlugSearchesFilePath(realState, project)),
      ).toMatch(/^searches-[0-9a-f]{16}\.json$/)

      // A state dir living inside the agent-writable project is not trusted.
      const inside = path.join(project, ".state")
      await fs.mkdir(inside)
      expect(await resolveSearchesPath(project, inside)).toBeUndefined()
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  })

  test("loadSearchesFile round-trips through disk, missing file is undefined", async () => {
    const sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "websearch-load-")),
    )
    try {
      const file = path.join(sandbox, "searches.json")
      expect(await loadSearchesFile(file)).toBeUndefined()
      const payload: SearchesFile = {
        version: STATE_FILE_VERSION,
        instance: { id: "i", pid: 1, startedAt: 0 },
        updatedAt: 0,
        searches: [record({ id: "x" })],
      }
      await writeJsonFile(file, payload)
      expect((await loadSearchesFile(file))?.searches[0]?.id).toBe("x")
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  })
})

describe("presentation", () => {
  test("a glyph per state", () => {
    expect(searchGlyph("pending")).toBe("○")
    expect(searchGlyph("running")).toBe("◐")
    expect(searchGlyph("complete")).toBe("✓")
    expect(searchGlyph("error")).toBe("✗")
  })

  test("bracket label names the backend once known, else a short fallback", () => {
    // The glyph carries state, so the bracket holds the backend when there is
    // one and a compact fallback otherwise.
    expect(searchLabel(record({ state: "pending" }))).toBe("queued")
    expect(searchLabel(record({ state: "running" }))).toBe("…")
    expect(searchLabel(record({ state: "running", backend: "searxng" }))).toBe(
      "SearXNG",
    )
    expect(searchLabel(record({ state: "complete", backend: "native" }))).toBe(
      "provider",
    )
    expect(searchLabel(record({ state: "complete", backend: "exa" }))).toBe(
      "Exa",
    )
    expect(searchLabel(record({ state: "error" }))).toBe("failed")
    expect(searchLabel(record({ state: "error", error: "no backends" }))).toBe(
      "no backends",
    )
  })

  test("truncateLabel flattens whitespace and ellipsizes over the cap", () => {
    expect(truncateLabel("  a   b  ", 10)).toBe("a b")
    expect(truncateLabel("abcdefghij", 5)).toBe("abcd…")
  })

  test("search ids embed a slug of the instance id", () => {
    expect(searchIdPrefix("1234abcd-ef00-0000-0000-000000000000")).toBe(
      "ws_1234ab_",
    )
  })
})

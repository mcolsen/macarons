import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  adoptLegacyProjectScopedFile,
  clampNumber,
  compactionNote,
  createSerialQueue,
  createWarnOnceLatch,
  every,
  explicitBoolean,
  formatModelRef,
  keybindOption,
  legacyProjectScopedFile,
  MAX_TIMER_MS,
  MESSAGE_COUNTER_MAX,
  mintMessageID,
  normalizeRequest,
  OWNER_ONLY_WRITE_MODES,
  parseModelRef,
  projectFileKey,
  projectHash,
  projectScopedFile,
  projectSlug,
  promptIdentityBody,
  readJsonFile,
  rejectNumber,
  serverToast,
  sessionPromptIdentity,
  shortProjectHash,
  tuiToast,
  unrefTimer,
  unwrap,
  withTimeout,
} from "../src/index"

/**
 * The small helpers the 2026-07-23 duplication audit found at three or more
 * call sites (report §2.2/§2.4/§2.5/§2.6/§2.7 — the Tier 2 batch).
 *
 * Unlike the Tier 1 promotions, several of these had DRIFTED between copies,
 * so these tests pin the version the promotion settled on: the strict unwrap,
 * the trimming model-ref parse, the resolved project hash, the timeout that
 * aborts as well as races, and the fail-closed keybind read.
 */

let dir: string

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tier2-")))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("serverToast", () => {
  const clientWith = (calls: unknown[]) => ({
    tui: {
      showToast: async function (this: unknown, input: unknown) {
        // Recording `this` pins the bind: the SDK's showToast reads
        // `this._client`, so a detached reference throws synchronously.
        calls.push({ input, boundToTui: this !== undefined })
        return undefined
      },
    },
  })

  test("addresses the directory and applies the per-plugin title", () => {
    const calls: unknown[] = []
    const toast = serverToast(clientWith(calls), {
      directory: "/w",
      title: "Worktree",
    })
    expect(toast("info", "moved")).toBe(true)
    expect(calls).toEqual([
      {
        input: {
          body: { title: "Worktree", message: "moved", variant: "info" },
          query: { directory: "/w" },
        },
        boundToTui: true,
      },
    ])
  })

  test("a per-call override wins over the defaults", () => {
    const calls: { input: unknown }[] = []
    const toast = serverToast(clientWith(calls), {
      directory: "/w",
      title: "Plan handoff",
    })
    toast("success", "done", { directory: "/other", title: "Elsewhere" })
    expect(calls[0]?.input).toEqual({
      body: { title: "Elsewhere", message: "done", variant: "success" },
      query: { directory: "/other" },
    })
  })

  test("no title key at all when neither a default nor an override is set", () => {
    const calls: { input: unknown }[] = []
    const toast = serverToast(clientWith(calls), { directory: "/w" })
    toast("warning", "paused")
    expect(calls[0]?.input).toEqual({
      body: { message: "paused", variant: "warning" },
      query: { directory: "/w" },
    })
  })

  test("no TUI attached reports false rather than throwing", () => {
    expect(serverToast({}, { directory: "/w" })("info", "hi")).toBe(false)
    expect(serverToast({ tui: {} }, { directory: "/w" })("info", "hi")).toBe(
      false,
    )
  })

  test("a throwing or rejecting host never reaches the caller", async () => {
    const thrower = {
      tui: {
        showToast: () => {
          throw new Error("no transport")
        },
      },
    }
    expect(serverToast(thrower, { directory: "/w" })("error", "x")).toBe(false)
    const rejecter = {
      tui: { showToast: () => Promise.reject(new Error("gone")) },
    }
    expect(serverToast(rejecter, { directory: "/w" })("error", "x")).toBe(true)
    // An unhandled rejection would fail the run on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 1))
  })
})

describe("tuiToast", () => {
  test("passes variant and message through, with an optional title", () => {
    const calls: unknown[] = []
    const api = { ui: { toast: (toast: unknown) => calls.push(toast) } }
    tuiToast(api)("warning", "careful")
    tuiToast(api, { title: "Prompt cache" })("error", "broken")
    tuiToast(api, { title: "Prompt cache" })("info", "note", "Override")
    expect(calls).toEqual([
      { variant: "warning", message: "careful" },
      { variant: "error", message: "broken", title: "Prompt cache" },
      { variant: "info", message: "note", title: "Override" },
    ])
  })

  test("a host without a toast surface is a no-op, not a crash", () => {
    expect(() => tuiToast({})("info", "hi")).not.toThrow()
  })
})

describe("withTimeout", () => {
  test("resolves the work's value and clears the deadline", async () => {
    await expect(withTimeout(async () => 7, 1_000)).resolves.toBe(7)
  })

  test("aborts the work at the deadline, not just the wait for it", async () => {
    let seen: AbortSignal | undefined
    const failure = withTimeout(
      (signal) =>
        new Promise<never>(() => {
          seen = signal
        }),
      5,
    )
    await expect(failure).rejects.toThrow("timed out after 5ms")
    expect(seen?.aborted).toBe(true)
  })

  test("the message is overridable", async () => {
    await expect(
      withTimeout(() => new Promise<never>(() => {}), 5, {
        message: "the host did not answer",
      }),
    ).rejects.toThrow("the host did not answer")
  })

  test("the caller's abort wins over the deadline, and reaches the work", async () => {
    const outer = new AbortController()
    let seen: AbortSignal | undefined
    const failure = withTimeout(
      (signal) =>
        new Promise<never>(() => {
          seen = signal
        }),
      60_000,
      { signal: outer.signal },
    )
    outer.abort(new Error("user answered first"))
    await expect(failure).rejects.toThrow("user answered first")
    expect(seen?.aborted).toBe(true)
  })

  test("an already-aborted caller signal rejects without dispatching", async () => {
    const outer = new AbortController()
    outer.abort(new Error("gone"))
    let dispatched = false
    await expect(
      withTimeout(
        async () => {
          dispatched = true
        },
        1_000,
        { signal: outer.signal },
      ),
    ).rejects.toThrow("gone")
    expect(dispatched).toBe(false)
  })

  test("the deadline wins even when the work resolves from its abort handler", async () => {
    // Abort listeners run synchronously, so work that settles in one races the
    // deadline that fired it. A timed-out call must not report success with a
    // value the timeout itself produced.
    const failure = withTimeout(
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("half-read body"), {
            once: true,
          })
        }),
      5,
    )
    await expect(failure).rejects.toThrow("timed out after 5ms")
  })

  test("the caller's abort wins over work that resolves from its abort handler", async () => {
    const outer = new AbortController()
    const failure = withTimeout(
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("partial"), {
            once: true,
          })
        }),
      60_000,
      { signal: outer.signal },
    )
    outer.abort(new Error("disposed"))
    await expect(failure).rejects.toThrow("disposed")
  })

  test("work that aborts the caller's signal synchronously is cancelled, not parked", async () => {
    // The outer listener has to be installed before dispatch: one added to an
    // already-aborted signal never fires, and the call would wait out the full
    // deadline instead of the abort it was handed.
    const outer = new AbortController()
    const started = Date.now()
    const failure = withTimeout(
      () => {
        outer.abort(new Error("gone mid-dispatch"))
        return new Promise<never>(() => {})
      },
      60_000,
      { signal: outer.signal },
    )
    await expect(failure).rejects.toThrow("gone mid-dispatch")
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("work that throws synchronously rejects with its own error", async () => {
    // Also a guard on the deadline promise: an unraced one would reject
    // unhandled when its timer fires.
    await expect(
      withTimeout(() => {
        throw new Error("dispatch failed")
      }, 5),
    ).rejects.toThrow("dispatch failed")
  })

  test("does not accumulate listeners on a long-lived caller signal", async () => {
    const outer = new AbortController()
    for (let i = 0; i < 50; i++)
      await withTimeout(async () => i, 1_000, { signal: outer.signal })
    // Every call must have removed its own listener; 50 leaked ones would
    // trip Node's MaxListeners warning and grow without bound.
    const counted = (
      outer.signal as unknown as { listenerCount?: (type: string) => number }
    ).listenerCount?.("abort")
    if (counted !== undefined) expect(counted).toBe(0)
  })
})

describe("createSerialQueue", () => {
  test("runs jobs one at a time, in submission order", async () => {
    const queue = createSerialQueue()
    const order: string[] = []
    const job = (name: string, ms: number) => async () => {
      order.push(`${name}:start`)
      await new Promise((resolve) => setTimeout(resolve, ms))
      order.push(`${name}:end`)
    }
    void queue.push(job("a", 15))
    void queue.push(job("b", 1))
    await queue.drain()
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"])
  })

  test("a rejected job keeps its rejection but never breaks the chain", async () => {
    const queue = createSerialQueue()
    const failure = queue.push(async () => {
      throw new Error("write failed")
    })
    await expect(failure).rejects.toThrow("write failed")
    await expect(queue.push(async () => "next")).resolves.toBe("next")
  })

  test("drain waits for everything queued so far", async () => {
    const queue = createSerialQueue()
    let done = 0
    for (let i = 0; i < 5; i++)
      void queue.push(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        done += 1
      })
    await queue.drain()
    expect(done).toBe(5)
  })
})

describe("unrefTimer / every / MAX_TIMER_MS", () => {
  test("unrefTimer returns its timer and tolerates one without unref", () => {
    const timer = setTimeout(() => {}, 1_000)
    expect(unrefTimer(timer)).toBe(timer)
    clearTimeout(timer)
    expect(() => unrefTimer({} as never)).not.toThrow()
  })

  test("every unrefs the interval it creates, and returns it", () => {
    let unreffed = false
    const fake = {
      unref: () => {
        unreffed = true
      },
    }
    const original = globalThis.setInterval
    let seen: [unknown, unknown] | undefined
    globalThis.setInterval = ((fn: unknown, ms?: number) => {
      seen = [fn, ms]
      return fake as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    try {
      const callback = () => {}
      const timer = every(callback, 1_000)
      expect(timer).toBe(fake as unknown as ReturnType<typeof setInterval>)
      expect(seen).toEqual([callback, 1_000])
      expect(unreffed).toBe(true)
    } finally {
      globalThis.setInterval = original
    }
  })

  test("MAX_TIMER_MS is the 32-bit signed ceiling setTimeout accepts", () => {
    expect(MAX_TIMER_MS).toBe(2 ** 31 - 1)
  })
})

describe("unwrap", () => {
  test("returns the data", () => {
    expect(unwrap({ data: { id: "s1" } }, "reading")).toEqual({ id: "s1" })
  })

  test("throws on an error payload, naming the operation", () => {
    expect(() =>
      unwrap({ error: { code: 404 } }, "reading session s1"),
    ).toThrow('reading session s1 failed: {"code":404}')
  })

  test("throws on missing data — the lenient copy returned undefined as T", () => {
    expect(() => unwrap({}, "reading session s1")).toThrow(
      "reading session s1 returned no data",
    )
  })

  test("a null error is not an error", () => {
    expect(unwrap({ data: 1, error: null }, "x")).toBe(1)
  })
})

describe("mintMessageID", () => {
  // The host's own stamp: ms << 12 | counter, truncated to 48 bits exactly as
  // Identifier.ascending truncates it.
  const hostAt = (ms: number, counter: number) =>
    `msg_${(((BigInt(ms) << 12n) | BigInt(counter)) & 0xffffffffffffn).toString(16).padStart(12, "0")}00000000000000`

  test("matches the host's format: msg_ + 12 hex + 14 base62", () => {
    expect(mintMessageID(1_700_000_000_000)).toMatch(
      /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    )
  })

  test("later milliseconds sort after earlier ones", () => {
    expect(mintMessageID(1_000) < mintMessageID(1_001)).toBe(true)
  })

  test("counter 0 sorts below a host id minted in the same millisecond", () => {
    const now = 1_700_000_000_000
    expect(mintMessageID(now, 0) < hostAt(now, 1)).toBe(true)
  })

  test("MESSAGE_COUNTER_MAX sorts above every same-millisecond host id", () => {
    const now = 1_700_000_000_000
    const steer = mintMessageID(now, MESSAGE_COUNTER_MAX)
    expect(steer > hostAt(now, MESSAGE_COUNTER_MAX - 1)).toBe(true)
    expect(steer > hostAt(now, 1)).toBe(true)
    expect(steer < mintMessageID(now + 1)).toBe(true)
  })

  test("two ids minted in the same millisecond differ", () => {
    expect(mintMessageID(1_000)).not.toBe(mintMessageID(1_000))
  })
})

describe("parseModelRef / formatModelRef", () => {
  test("splits on the FIRST slash — model ids may contain slashes", () => {
    expect(parseModelRef("openrouter/anthropic/claude-sonnet-5")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet-5",
    })
  })

  test("trims: these are hand-typed into JSON", () => {
    expect(parseModelRef("  anthropic/claude-opus-5  ")).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-5",
    })
  })

  test("round-trips through formatModelRef", () => {
    const ref = "anthropic/claude-opus-5"
    const parsed = parseModelRef(ref)
    expect(parsed && formatModelRef(parsed)).toBe(ref)
  })

  test.each([
    ["", "empty"],
    ["noslash", "no separator"],
    ["/model", "no provider"],
    ["provider/", "no model"],
    ["   ", "whitespace only"],
  ])("%p is not a model ref (%s)", (value) => {
    expect(parseModelRef(value)).toBeUndefined()
  })

  test.each([5, null, undefined, {}])("%p is not a model ref", (value) => {
    expect(parseModelRef(value)).toBeUndefined()
  })

  // Kept out of test.each, which spreads an array row into arguments and
  // would hand this case through as the bare string "a/b".
  test("an array of refs is not a model ref", () => {
    expect(parseModelRef(["a/b"])).toBeUndefined()
  })
})

describe("options toolkit", () => {
  test("clampNumber floors, clamps, and falls back", () => {
    expect(clampNumber(7.9, 1, 0, 10)).toBe(7)
    expect(clampNumber(-5, 1, 0, 10)).toBe(0)
    expect(clampNumber(99, 1, 0, 10)).toBe(10)
    expect(clampNumber("7", 1, 0, 10)).toBe(1)
    expect(clampNumber(Number.NaN, 1, 0, 10)).toBe(1)
    expect(clampNumber(undefined, 1, 0, 10)).toBe(1)
  })

  test("rejectNumber reports what it ignored instead of clamping", () => {
    const problems: string[] = []
    expect(
      rejectNumber({
        key: "floorFraction",
        value: 0,
        range: "greater than 0 and at most 1",
        accepts: (value) => value > 0 && value <= 1,
        problems,
      }),
    ).toBeUndefined()
    expect(problems).toEqual([
      "floorFraction must be a number greater than 0 and at most 1 (ignoring 0)",
    ])
  })

  test("rejectNumber leaves an absent option to the caller's default", () => {
    const problems: string[] = []
    expect(
      rejectNumber({
        key: "ttlSeconds",
        value: undefined,
        range: "greater than 0",
        accepts: (value) => value > 0,
        problems,
      }),
    ).toBeUndefined()
    expect(problems).toEqual([])
  })

  test("rejectNumber renders NaN/Infinity and non-JSON values readably", () => {
    const problems: string[] = []
    const accepts = () => false
    rejectNumber({
      key: "a",
      value: Number.NaN,
      range: "x",
      accepts,
      problems,
    })
    rejectNumber({
      key: "b",
      value: Number.POSITIVE_INFINITY,
      range: "x",
      accepts,
      problems,
    })
    rejectNumber({ key: "c", value: "no", range: "x", accepts, problems })
    expect(problems).toEqual([
      "a must be a number x (ignoring NaN)",
      "b must be a number x (ignoring Infinity)",
      'c must be a number x (ignoring "no")',
    ])
  })

  test("explicitBoolean fails closed on anything but a literal true", () => {
    expect(explicitBoolean(undefined, true)).toBe(true)
    expect(explicitBoolean(undefined, false)).toBe(false)
    expect(explicitBoolean(true, false)).toBe(true)
    expect(explicitBoolean(false, true)).toBe(false)
    expect(explicitBoolean("true", true)).toBe(false)
    expect(explicitBoolean(1, true)).toBe(false)
  })

  test("keybindOption: absent takes the default, none disables", () => {
    expect(keybindOption(undefined, "ctrl+p")).toBe("ctrl+p")
    expect(keybindOption(undefined)).toBeUndefined()
    expect(keybindOption("none", "ctrl+p")).toBeUndefined()
    expect(keybindOption("  none  ", "ctrl+p")).toBeUndefined()
    expect(keybindOption("ctrl+g,ctrl+b", "ctrl+p")).toBe("ctrl+g,ctrl+b")
    expect(keybindOption("  ctrl+g  ", "ctrl+p")).toBe("ctrl+g")
  })

  test("keybindOption: an unusable value binds nothing rather than the default", () => {
    // Binding a default key behind a typo can shadow a chord the user already
    // uses; AGENTS.md requires a collision audit before any key ships.
    expect(keybindOption("", "ctrl+p")).toBeUndefined()
    expect(keybindOption(false, "ctrl+p")).toBeUndefined()
    expect(keybindOption(123, "ctrl+p")).toBeUndefined()
    expect(keybindOption({}, "ctrl+p")).toBeUndefined()
  })
})

describe("readJsonFile", () => {
  const validNumber = (value: unknown) =>
    typeof value === "number" ? value : undefined

  test("parses and validates", async () => {
    const file = path.join(dir, "n.json")
    await fs.writeFile(file, "42")
    expect(await readJsonFile(file, validNumber)).toBe(42)
  })

  test("a missing file takes onMissing, never onCorrupt", async () => {
    const corrupt: unknown[] = []
    expect(
      await readJsonFile(path.join(dir, "gone.json"), validNumber, {
        onMissing: () => 0,
        onCorrupt: (error) => corrupt.push(error),
      }),
    ).toBe(0)
    expect(corrupt).toEqual([])
  })

  test("a missing file with no onMissing is undefined", async () => {
    expect(
      await readJsonFile(path.join(dir, "gone.json"), validNumber),
    ).toBeUndefined()
  })

  test("invalid JSON reports through onCorrupt and yields undefined", async () => {
    const file = path.join(dir, "bad.json")
    await fs.writeFile(file, "{ not json")
    const corrupt: unknown[] = []
    expect(
      await readJsonFile(file, validNumber, {
        onMissing: () => 0,
        onCorrupt: (error) => corrupt.push(error),
      }),
    ).toBeUndefined()
    expect(corrupt).toHaveLength(1)
    expect(corrupt[0]).toBeInstanceOf(SyntaxError)
  })

  test("an unreadable file is corrupt, NOT missing", async () => {
    // A directory in a file's place: the read fails with EISDIR, which must
    // never be mistaken for "nothing saved yet" — overwriting then loses data.
    const file = path.join(dir, "as-a-dir.json")
    await fs.mkdir(file)
    const corrupt: unknown[] = []
    expect(
      await readJsonFile(file, validNumber, {
        onMissing: () => 0,
        onCorrupt: (error) => corrupt.push(error),
      }),
    ).toBeUndefined()
    expect(corrupt).toHaveLength(1)
  })

  test("a validator returning undefined rejects quietly", async () => {
    const file = path.join(dir, "other.json")
    await fs.writeFile(file, '"a string"')
    const corrupt: unknown[] = []
    expect(
      await readJsonFile(file, validNumber, {
        onCorrupt: (error) => corrupt.push(error),
      }),
    ).toBeUndefined()
    expect(corrupt).toEqual([])
  })

  test("a validator that throws reports through onCorrupt", async () => {
    const file = path.join(dir, "shape.json")
    await fs.writeFile(file, "{}")
    const corrupt: unknown[] = []
    expect(
      await readJsonFile(
        file,
        () => {
          throw new Error("invalid permission rules")
        },
        { onCorrupt: (error) => corrupt.push(error) },
      ),
    ).toBeUndefined()
    expect((corrupt[0] as Error).message).toBe("invalid permission rules")
  })

  test("onCorrupt may rethrow to propagate", async () => {
    const file = path.join(dir, "boom.json")
    await fs.writeFile(file, "{ not json")
    await expect(
      readJsonFile(file, validNumber, {
        onCorrupt: (error) => {
          throw error
        },
      }),
    ).rejects.toBeInstanceOf(SyntaxError)
  })
})

describe("projectHash / shortProjectHash / projectScopedFile", () => {
  test("the same root reaches the same key however it is spelled", () => {
    const key = projectHash("/srv/project")
    expect(projectHash("/srv/project/")).toBe(key)
    expect(projectHash("/srv/./project")).toBe(key)
    expect(projectHash("/srv/other/../project")).toBe(key)
  })

  test("different roots never share a key", () => {
    expect(projectHash("/srv/a")).not.toBe(projectHash("/srv/b"))
  })

  test("full hex is 64 chars; the short form is its 16-char prefix", () => {
    const full = projectHash("/srv/project")
    expect(full).toMatch(/^[0-9a-f]{64}$/)
    expect(shortProjectHash("/srv/project")).toBe(full.slice(0, 16))
  })

  test("projectScopedFile lays the file out under the plugin's own subtree, readably named", () => {
    expect(
      projectScopedFile({
        dir: "/cfg",
        service: "test-service",
        bucket: "projects",
        projectRoot: "/srv/project",
      }),
    ).toBe(
      path.join(
        "/cfg",
        "test-service",
        "projects",
        `project-${shortProjectHash("/srv/project")}.json`,
      ),
    )
  })

  test("legacyProjectScopedFile still derives the pre-slug bare-hash name", () => {
    expect(
      legacyProjectScopedFile({
        dir: "/cfg",
        service: "test-service",
        bucket: "projects",
        projectRoot: "/srv/project",
      }),
    ).toBe(
      path.join(
        "/cfg",
        "test-service",
        "projects",
        `${projectHash("/srv/project")}.json`,
      ),
    )
  })
})

describe("projectSlug / projectFileKey", () => {
  test("the slug is the root's basename, and the key carries the short hash", () => {
    expect(projectSlug("/srv/my-app")).toBe("my-app")
    expect(projectFileKey("/srv/my-app")).toBe(
      `my-app-${shortProjectHash("/srv/my-app")}`,
    )
  })

  test("hostile characters collapse to dashes; case folds", () => {
    expect(projectSlug("/srv/My App (v2)")).toBe("my-app-v2")
    expect(projectSlug("/srv/über projekt")).toBe("ber-projekt")
  })

  test("no leading dot and no dangling separators survive", () => {
    expect(projectSlug("/srv/.dotdir")).toBe("dotdir")
    expect(projectSlug("/srv/trailing-.")).toBe("trailing")
  })

  test("a basename with nothing usable falls back to a fixed label", () => {
    expect(projectSlug("/")).toBe("project")
    expect(projectSlug("/srv/日本語")).toBe("project")
  })

  test("long basenames are capped and re-trimmed after the cut", () => {
    const slug = projectSlug(`/srv/${"a".repeat(39)}-b`)
    expect(slug).toBe("a".repeat(39))
    expect(slug.length).toBeLessThanOrEqual(40)
  })

  test("the slug never influences the key's uniqueness", () => {
    // Same basename, different roots: the slugs collide, the keys must not.
    expect(projectSlug("/srv/app")).toBe(projectSlug("/opt/app"))
    expect(projectFileKey("/srv/app")).not.toBe(projectFileKey("/opt/app"))
  })
})

describe("adoptLegacyProjectScopedFile", () => {
  let sandbox: string
  const scope = (dir: string, projectRoot: string) => ({
    dir,
    service: "test-service",
    bucket: "projects",
    projectRoot,
  })

  beforeEach(async () => {
    sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "adopt-legacy-")),
    )
  })

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true })
  })

  test("moves a pre-slug store to its readable name, bytes and mode intact", async () => {
    const input = scope(path.join(sandbox, "cfg"), "/srv/project")
    const legacy = legacyProjectScopedFile(input)
    await fs.mkdir(path.dirname(legacy), { recursive: true })
    await fs.writeFile(legacy, `{ "keep": "me" }\n`, { mode: 0o600 })

    expect(await adoptLegacyProjectScopedFile(input)).toBe("adopted")

    const current = projectScopedFile(input)
    expect(await fs.readFile(current, "utf8")).toBe(`{ "keep": "me" }\n`)
    expect((await fs.stat(current)).mode & 0o7777).toBe(0o600)
    await expect(fs.access(legacy)).rejects.toThrow()
  })

  test("a missing legacy file is a silent no-op", async () => {
    const input = scope(path.join(sandbox, "cfg"), "/srv/project")
    expect(await adoptLegacyProjectScopedFile(input)).toBe("absent")
    await expect(fs.access(projectScopedFile(input))).rejects.toThrow()
  })

  test("a dual-name conflict is reported, never clobbered or merged blind", async () => {
    const input = scope(path.join(sandbox, "cfg"), "/srv/project")
    const legacy = legacyProjectScopedFile(input)
    const current = projectScopedFile(input)
    await fs.mkdir(path.dirname(legacy), { recursive: true })
    await fs.writeFile(legacy, `{"stale": true}\n`)
    await fs.writeFile(current, `{"fresh": true}\n`)

    expect(await adoptLegacyProjectScopedFile(input)).toBe("conflict")

    expect(await fs.readFile(current, "utf8")).toBe(`{"fresh": true}\n`)
    expect(await fs.readFile(legacy, "utf8")).toBe(`{"stale": true}\n`)
  })

  test("the legacy name recreated after a successful adoption reads as a conflict", async () => {
    // The rolling-upgrade shape: adoption succeeds, then a still-running
    // pre-slug half writes its store again under the old name.
    const input = scope(path.join(sandbox, "cfg"), "/srv/project")
    const legacy = legacyProjectScopedFile(input)
    await fs.mkdir(path.dirname(legacy), { recursive: true })
    await fs.writeFile(legacy, `{"generation": 1}\n`)
    expect(await adoptLegacyProjectScopedFile(input)).toBe("adopted")

    await fs.writeFile(legacy, `{"generation": 2}\n`)
    expect(await adoptLegacyProjectScopedFile(input)).toBe("conflict")
    expect(await fs.readFile(legacy, "utf8")).toBe(`{"generation": 2}\n`)
    expect(await fs.readFile(projectScopedFile(input), "utf8")).toBe(
      `{"generation": 1}\n`,
    )
  })

  test("a pre-slug writer holding the legacy store lock stalls adoption; its newer write survives", async () => {
    // The finding-3 shape: an old-generation process writes the legacy file
    // under the lock derived from the LEGACY filename. While it holds that
    // lock, adoption must not read-copy-delete around it — the writer's
    // replacement landing between those steps would be deleted unread.
    const input = scope(path.join(sandbox, "cfg"), "/srv/project")
    const legacy = legacyProjectScopedFile(input)
    await fs.mkdir(path.dirname(legacy), { recursive: true })
    await fs.writeFile(legacy, `{"old": true}\n`)
    // A live old-generation hold: fresh mtime, so it cannot be broken as stale.
    await fs.writeFile(`${legacy}.lock`, `${process.pid}\nheld\n`)

    expect(await adoptLegacyProjectScopedFile(input)).toBe("error")
    await expect(fs.access(projectScopedFile(input))).rejects.toThrow()

    // The writer replaces the file and releases; adoption then moves the
    // NEWER bytes — nothing was captured from before the replacement.
    await fs.writeFile(legacy, `{"newer": true}\n`)
    await fs.rm(`${legacy}.lock`)
    expect(await adoptLegacyProjectScopedFile(input)).toBe("adopted")
    expect(await fs.readFile(projectScopedFile(input), "utf8")).toBe(
      `{"newer": true}\n`,
    )
    await expect(fs.access(legacy)).rejects.toThrow()
  }, 15_000)

  test("losing either adoption lock before publication leaves both generations untouched", async () => {
    for (const lost of ["current", "legacy"] as const) {
      const input = scope(path.join(sandbox, "cfg"), `/srv/${lost}`)
      const legacy = legacyProjectScopedFile(input)
      const current = projectScopedFile(input)
      await fs.mkdir(path.dirname(legacy), { recursive: true })
      await fs.writeFile(legacy, `{"generation":1}\n`)

      expect(
        await adoptLegacyProjectScopedFile({
          ...input,
          modes: {
            ...OWNER_ONLY_WRITE_MODES,
            beforePublish: async () => {
              await fs.writeFile(
                `${lost === "current" ? current : legacy}.lock`,
                "someone-else\n",
              )
            },
          },
        }),
      ).toBe("error")
      await expect(fs.access(current)).rejects.toThrow()
      expect(await fs.readFile(legacy, "utf8")).toBe(`{"generation":1}\n`)
    }
  })

  test("losing either adoption lock after publication retains the legacy copy", async () => {
    for (const lost of ["current", "legacy"] as const) {
      const input = scope(path.join(sandbox, "cfg"), `/srv/after-${lost}`)
      const legacy = legacyProjectScopedFile(input)
      const current = projectScopedFile(input)
      await fs.mkdir(path.dirname(legacy), { recursive: true })
      await fs.writeFile(legacy, `{"generation":1}\n`)

      const realRename = fs.rename.bind(fs)
      const interceptedRename = (async (
        from: Parameters<typeof fs.rename>[0],
        to: Parameters<typeof fs.rename>[1],
      ) => {
        await realRename(from, to)
        if (path.resolve(String(to)) === current)
          await fs.writeFile(
            `${lost === "current" ? current : legacy}.lock`,
            "someone-else\n",
          )
      }) as typeof fs.rename
      ;(fs as { rename: typeof fs.rename }).rename = interceptedRename
      try {
        expect(
          await adoptLegacyProjectScopedFile({
            ...input,
            modes: OWNER_ONLY_WRITE_MODES,
          }),
        ).toBe("error")
      } finally {
        ;(fs as { rename: typeof fs.rename }).rename = realRename
      }
      expect(await fs.readFile(current, "utf8")).toBe(`{"generation":1}\n`)
      expect(await fs.readFile(legacy, "utf8")).toBe(`{"generation":1}\n`)
      if (process.platform !== "win32") {
        expect((await fs.stat(current)).mode & 0o777).toBe(0o600)
        expect((await fs.stat(legacy)).mode & 0o777).toBe(0o600)
      }
    }
  })

  test("refuses a symlink squatting on the legacy name", async () => {
    const input = scope(path.join(sandbox, "cfg"), "/srv/project")
    const legacy = legacyProjectScopedFile(input)
    const outside = path.join(sandbox, "outside.json")
    await fs.mkdir(path.dirname(legacy), { recursive: true })
    await fs.writeFile(outside, `{"planted": true}\n`)
    await fs.symlink(outside, legacy)

    expect(await adoptLegacyProjectScopedFile(input)).toBe("error")

    await expect(fs.access(projectScopedFile(input))).rejects.toThrow()
    expect(await fs.readFile(outside, "utf8")).toBe(`{"planted": true}\n`)
  })

  test("a service subtree symlinked out of the base is refused with the disk untouched", async () => {
    // The finding-4 shape: the plugin's own service directory replaced by a
    // symlink into agent-writable space, with a legacy file waiting at the
    // target. Adoption must reject BEFORE moving anything through the link.
    const base = path.join(sandbox, "cfg")
    const target = path.join(sandbox, "project", "planted")
    const input = scope(base, "/srv/project")
    await fs.mkdir(path.join(target, "projects"), { recursive: true })
    await fs.mkdir(base, { recursive: true })
    await fs.symlink(target, path.join(base, "test-service"))
    const legacy = legacyProjectScopedFile(input)
    await fs.writeFile(legacy, `{"bait": true}\n`)

    expect(await adoptLegacyProjectScopedFile(input)).toBe("error")

    // Nothing moved, nothing created: the legacy file is still the only one.
    expect(await fs.readFile(legacy, "utf8")).toBe(`{"bait": true}\n`)
    await expect(fs.access(projectScopedFile(input))).rejects.toThrow()
    expect(await fs.readdir(path.join(target, "projects"))).toEqual([
      path.basename(legacy),
    ])
  })
})

describe("createWarnOnceLatch", () => {
  test("warns once per cause, and reports the recovery only if outstanding", () => {
    const latch = createWarnOnceLatch()
    expect(latch.warn("store")).toBe(true)
    expect(latch.warn("store")).toBe(false)
    expect(latch.warn("config")).toBe(true)
    expect(latch.outstanding()).toBe(true)
    expect(latch.resolve("store")).toBe(true)
    expect(latch.resolve("store")).toBe(false)
    expect(latch.outstanding()).toBe(true)
    expect(latch.resolve("config")).toBe(true)
    expect(latch.outstanding()).toBe(false)
  })

  test("a cleared cause warns anew on recurrence", () => {
    const latch = createWarnOnceLatch()
    latch.warn("store")
    latch.resolve("store")
    expect(latch.warn("store")).toBe(true)
  })

  test("the key set is bounded, oldest first", () => {
    const latch = createWarnOnceLatch({ max: 2 })
    latch.warn("a")
    latch.warn("b")
    latch.warn("c")
    // "a" was evicted, so it warns again; "c" is still latched.
    expect(latch.warn("a")).toBe(true)
    expect(latch.warn("c")).toBe(false)
  })
})

describe("promptIdentityBody", () => {
  test("omits what the session has not pinned", () => {
    expect(promptIdentityBody({})).toEqual({})
    expect(promptIdentityBody({ agent: "build" })).toEqual({ agent: "build" })
  })

  test("spreads exactly the three echoed fields", () => {
    expect(
      promptIdentityBody({
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-opus-5" },
        variant: "high",
      }),
    ).toEqual({
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
      variant: "high",
    })
  })

  test("pairs with sessionPromptIdentity, which drops the default sentinel", () => {
    const session = {
      agent: "plan",
      model: {
        providerID: "anthropic",
        id: "claude-opus-5",
        variant: "default",
      },
    }
    expect(promptIdentityBody(sessionPromptIdentity(session))).toEqual({
      agent: "plan",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
    })
  })
})

describe("compactionNote", () => {
  test("pushes the plugin's own note onto the compaction context", async () => {
    const output = { context: ["existing"] }
    await compactionNote("carry the placeholders forward")(undefined, output)
    expect(output.context).toEqual([
      "existing",
      "carry the placeholders forward",
    ])
  })
})

describe("normalizeRequest", () => {
  const base = { id: "p1", sessionID: "s1", permission: "edit" }

  test("reads the current event shape", () => {
    expect(normalizeRequest({ ...base, patterns: ["src/**"] })).toEqual({
      id: "p1",
      sessionID: "s1",
      permission: "edit",
      patterns: ["src/**"],
      always: ["src/**"],
      synthesized: false,
      title: undefined,
      metadata: undefined,
      toolCall: undefined,
    })
  })

  test("accepts the historical shapes: `type` for permission, `pattern` singular", () => {
    const request = normalizeRequest({
      id: "p1",
      sessionID: "s1",
      type: "bash",
      pattern: "git status",
    })
    expect(request?.permission).toBe("bash")
    expect(request?.patterns).toEqual(["git status"])
  })

  test('no patterns synthesizes "*" and MARKS it', () => {
    const request = normalizeRequest(base)
    expect(request?.patterns).toEqual(["*"])
    expect(request?.synthesized).toBe(true)
    // The mark is what stops "no pattern information" being written down as
    // consent to everything.
    expect(request?.always).toEqual(["*"])
  })

  test("an explicit `always` is kept apart from the request patterns", () => {
    const request = normalizeRequest({
      ...base,
      patterns: ["src/a.ts"],
      always: ["src/**"],
    })
    expect(request?.patterns).toEqual(["src/a.ts"])
    expect(request?.always).toEqual(["src/**"])
  })

  test("an empty explicit `always` is honored, not defaulted", () => {
    expect(
      normalizeRequest({ ...base, patterns: ["src/a.ts"], always: [] })?.always,
    ).toEqual([])
  })

  test("carries the tool-call pointer only when both halves are strings", () => {
    expect(
      normalizeRequest({
        ...base,
        tool: { messageID: "msg_1", callID: "call_1" },
      })?.toolCall,
    ).toEqual({ messageID: "msg_1", callID: "call_1" })
    expect(
      normalizeRequest({ ...base, tool: { messageID: "msg_1" } })?.toolCall,
    ).toBeUndefined()
    expect(
      normalizeRequest({ ...base, tool: "nope" })?.toolCall,
    ).toBeUndefined()
  })

  test.each([
    [undefined, "not an object"],
    [null, "null"],
    ["str", "a string"],
    [{ sessionID: "s1", permission: "edit" }, "no id"],
    [{ id: "p1", permission: "edit" }, "no sessionID"],
    [{ id: "p1", sessionID: "s1" }, "no permission or type"],
  ])("%p is not a request (%s)", (properties) => {
    expect(normalizeRequest(properties)).toBeUndefined()
  })

  test("non-string entries are dropped from pattern lists", () => {
    expect(
      normalizeRequest({ ...base, patterns: ["a", 5, null, "b"] })?.patterns,
    ).toEqual(["a", "b"])
  })
})

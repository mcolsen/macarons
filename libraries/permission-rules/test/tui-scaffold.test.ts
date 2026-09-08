import { describe, expect, test } from "bun:test"
import {
  BAND_SAMPLE_VERSIONS as BAND,
  isSubAgentSession,
  notePromptSession,
  PROMPT_SESSIONS_TRACKED,
  promptSessionFamily,
  replaceLargeDialog,
  resolvePathsOnce,
  singleFlight,
  tuiGate,
} from "../src/index"

/**
 * The TUI half's opening sequence and the two idioms every half had rebuilt
 * around it (2026-07-23 audit §2.5). The plugin-side tests pin what each half
 * DOES with these; this file pins the policies themselves, especially the
 * legs the ten hand-written copies had each gotten right independently and
 * which a single implementation now has to keep getting right for all of them.
 */

type Toast = { variant?: unknown; message?: unknown }

function makeApi(
  input: {
    version?: string | null
    baseUrl?: string
    sessions?: Record<string, { parentID?: unknown }>
    paths?: Partial<{
      worktree: unknown
      directory: unknown
      config: unknown
      state: unknown
    }>
  } = {},
) {
  const toasts: Toast[] = []
  return {
    toasts,
    api: {
      app: {
        version:
          input.version === null ? undefined : (input.version ?? BAND.floor),
      },
      ui: { toast: (toast: Toast) => toasts.push(toast) },
      client: input.baseUrl
        ? { _client: { getConfig: () => ({ baseUrl: input.baseUrl }) } }
        : undefined,
      state: {
        path: {
          worktree: "",
          directory: "",
          config: "",
          state: "",
          ...input.paths,
        },
        session: {
          get: (id: string) => input.sessions?.[id],
        },
      },
    },
  }
}

describe("tuiGate", () => {
  test("runs on a supported host and reports the locality", () => {
    const { api, toasts } = makeApi({ baseUrl: "http://opencode.internal" })
    const gate = tuiGate(api, { label: "x", service: "x", remoteBails: true })
    expect(gate.disabled).toBe(false)
    if (gate.disabled) throw new Error("unreachable")
    expect(gate.locality).toBe("in-process")
    expect(gate.compat).toBeNull()
    expect(toasts).toHaveLength(0)
  })

  test("warns but still runs on an untested v1 host", () => {
    const { api, toasts } = makeApi({
      version: BAND.belowBand,
      baseUrl: "http://127.0.0.1:4096",
    })
    const gate = tuiGate(api, { label: "x", service: "x", remoteBails: true })
    expect(gate.disabled).toBe(false)
    if (gate.disabled) throw new Error("unreachable")
    // The notice is handed back rather than swallowed: a half that wants to
    // say more about running untested still can.
    expect(gate.compat?.disable).toBe(false)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.variant).toBe("warning")
  })

  test("disables on a non-v1 host, and never reaches the locality probe", () => {
    const { api } = makeApi({ version: "2.0.0", baseUrl: "http://example.com" })
    const gate = tuiGate(api, { label: "x", service: "x", remoteBails: true })
    expect(gate).toEqual({ disabled: true, reason: "version" })
  })

  // The version leg comes first for a reason: a v2 host's api shape is
  // unknown, so probing its client for a base URL is exactly the kind of read
  // the disable gate exists to avoid.
  test("the version verdict wins over the locality verdict", () => {
    const api = {
      app: { version: "2.0.0" },
      ui: {
        toast: () => {},
      },
      get client(): never {
        throw new Error("the client must not be probed on a disabled host")
      },
    }
    expect(
      tuiGate(api, { label: "x", service: "x", remoteBails: true }),
    ).toEqual({ disabled: true, reason: "version" })
  })

  describe("remoteBails", () => {
    test("true disables a remote attach", () => {
      const { api } = makeApi({ baseUrl: "https://server.example.com" })
      expect(
        tuiGate(api, { label: "x", service: "x", remoteBails: true }),
      ).toEqual({ disabled: true, reason: "remote" })
    })

    // cache-ratio and the other five UI-only halves: their data is already on
    // this machine because the host synced it, so a remote attach is a
    // perfectly good place to render (audit §2.9).
    test("false runs on a remote attach and still reports it", () => {
      const { api } = makeApi({ baseUrl: "https://server.example.com" })
      const gate = tuiGate(api, {
        label: "x",
        service: "x",
        remoteBails: false,
      })
      expect(gate.disabled).toBe(false)
      if (gate.disabled) throw new Error("unreachable")
      expect(gate.locality).toBe("remote")
    })

    // An unreadable transport is the fail-closed case the locality helper
    // documents; a bailing half must treat it as remote.
    test("true disables when the transport cannot be identified", () => {
      const { api } = makeApi()
      expect(
        tuiGate(api, { label: "x", service: "x", remoteBails: true }),
      ).toEqual({ disabled: true, reason: "remote" })
    })

    // Loopback proves the connection lands on this machine, which is what the
    // file-reading halves actually need.
    test("true admits a loopback attach", () => {
      const { api } = makeApi({ baseUrl: "http://localhost:4096" })
      const gate = tuiGate(api, { label: "x", service: "x", remoteBails: true })
      expect(gate.disabled).toBe(false)
      if (gate.disabled) throw new Error("unreachable")
      expect(gate.locality).toBe("loopback")
    })
  })
})

describe("isSubAgentSession", () => {
  test("a session with a parent is a sub-agent's", () => {
    const { api } = makeApi({ sessions: { child: { parentID: "parent" } } })
    expect(isSubAgentSession(api, "child")).toBe(true)
  })

  test("a top-level session is not", () => {
    const { api } = makeApi({ sessions: { top: {} } })
    expect(isSubAgentSession(api, "top")).toBe(false)
  })

  // Fail OPEN: hiding every widget in the suite is a worse answer to an
  // unfamiliar host than showing one for a sub-agent.
  test.each([
    ["an unknown session", { sessions: {} }],
    ["an empty parentID", { sessions: { s: { parentID: "" } } }],
    ["a non-string parentID", { sessions: { s: { parentID: 7 } } }],
  ])("%s is not a sub-agent's", (_label, input) => {
    const { api } = makeApi(input)
    expect(isSubAgentSession(api, "s")).toBe(false)
  })

  test("survives a host with no session state at all", () => {
    expect(isSubAgentSession({}, "s")).toBe(false)
    expect(
      isSubAgentSession(
        {
          state: {
            session: {
              get: () => {
                throw new Error("nope")
              },
            },
          },
        },
        "s",
      ),
    ).toBe(false)
  })
})

describe("resolvePathsOnce", () => {
  const paths = {
    worktree: "/repo",
    directory: "/repo/sub",
    config: "/cfg",
    state: "/state",
  }

  test("answers undefined while the host's paths are placeholders", () => {
    const { api } = makeApi()
    let calls = 0
    const get = resolvePathsOnce(api, async () => {
      calls += 1
      return "resolved"
    })
    expect(get()).toBeUndefined()
    expect(get()).toBeUndefined()
    expect(calls).toBe(0)
  })

  test("resolves once real paths land, then caches the same promise", async () => {
    const { api } = makeApi()
    let calls = 0
    const get = resolvePathsOnce(api, async () => {
      calls += 1
      return "resolved"
    })
    expect(get()).toBeUndefined()
    Object.assign(api.state.path, paths)
    const first = get()
    expect(first).toBe(get() as Promise<string | undefined>)
    expect(await first).toBe("resolved")
    expect(calls).toBe(1)
  })

  test("hands the resolver the project root, not the raw worktree", async () => {
    const { api } = makeApi({ paths })
    const seen = resolvePathsOnce(api, async (input) => input)()
    expect(await seen).toEqual({
      projectRoot: "/repo",
      directory: "/repo/sub",
      config: "/cfg",
      state: "/state",
    })
  })

  // OpenCode reports worktree "/" for a non-git project; taking it literally
  // would key every file against the filesystem root.
  test('the non-git worktree sentinel "/" falls back to the directory', async () => {
    const { api } = makeApi({ paths: { ...paths, worktree: "/" } })
    const seen = await resolvePathsOnce(api, async (input) => input)()
    expect(seen?.projectRoot).toBe("/repo/sub")
  })

  test("`require` gates on the fields this caller actually reads", () => {
    const { api } = makeApi({
      paths: { directory: "/repo/sub", state: "/state" },
    })
    // A half that reads only the state dir must not be held up by an empty
    // config dir it never touches.
    expect(
      resolvePathsOnce(api, async () => "ok", { require: ["state"] })(),
    ).toBeDefined()
    expect(
      resolvePathsOnce(api, async () => "ok", {
        require: ["config", "state"],
      })(),
    ).toBeUndefined()
  })

  test("directory is always required", () => {
    const { api } = makeApi({ paths: { config: "/cfg", state: "/state" } })
    expect(resolvePathsOnce(api, async () => "ok")()).toBeUndefined()
  })

  // A path that fails to resolve is a fact about the project, not the moment.
  test("a rejected resolution is cached as undefined, not retried", async () => {
    const { api } = makeApi({ paths })
    let calls = 0
    const get = resolvePathsOnce(api, async () => {
      calls += 1
      throw new Error("containment check failed")
    })
    expect(await get()).toBeUndefined()
    expect(await get()).toBeUndefined()
    expect(calls).toBe(1)
  })

  // A host that reports something other than a string is "not ready", never a
  // path to resolve against.
  test("non-string path fields read as placeholders", () => {
    const { api } = makeApi({ paths: { directory: 7, state: "/state" } })
    expect(
      resolvePathsOnce(api, async () => "ok", { require: ["state"] })(),
    ).toBeUndefined()
  })
})

describe("replaceLargeDialog", () => {
  // The whole point of the helper: the host resets the size to "medium" inside
  // replace(), so a setSize before it is discarded.
  test("sets the size AFTER the replace", () => {
    const order: string[] = []
    const api = {
      ui: {
        dialog: {
          replace: () => order.push("replace"),
          setSize: (size: string) => order.push(`setSize:${size}`),
        },
      },
    }
    replaceLargeDialog(api, () => null)
    expect(order).toEqual(["replace", "setSize:large"])
  })

  test("passes render and onClose straight through", () => {
    const seen: unknown[] = []
    const render = () => null
    const onClose = () => {}
    replaceLargeDialog(
      {
        ui: {
          dialog: {
            replace: (...args: unknown[]) => seen.push(...args),
            setSize: () => {},
          },
        },
      },
      render,
      onClose,
    )
    expect(seen).toEqual([render, onClose])
  })

  test("a host without setSize still gets its dialog", () => {
    let replaced = false
    expect(() =>
      replaceLargeDialog(
        { ui: { dialog: { replace: () => (replaced = true) } } },
        () => null,
      ),
    ).not.toThrow()
    expect(replaced).toBe(true)
    expect(() => replaceLargeDialog({}, () => null)).not.toThrow()
  })
})

describe("notePromptSession", () => {
  test("appends a session it has not seen", () => {
    expect(notePromptSession(["a"], "b")).toEqual(["a", "b"])
  })

  // Identity, not just equality: both callers hold this in a signal, and a
  // fresh array would re-render the sidebar on every repeat event.
  test("returns the SAME array when the session is already tracked", () => {
    const tracked = ["a", "b"]
    expect(notePromptSession(tracked, "a")).toBe(tracked)
  })

  test("keeps the newest `limit`, dropping from the front", () => {
    const full = Array.from({ length: 5 }, (_, i) => `s${i}`)
    expect(notePromptSession(full, "s5", 5)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
    ])
  })

  test("defaults to the suite's bound", () => {
    const full = Array.from(
      { length: PROMPT_SESSIONS_TRACKED },
      (_, i) => `s${i}`,
    )
    const next = notePromptSession(full, "new")
    expect(next).toHaveLength(PROMPT_SESSIONS_TRACKED)
    expect(next[next.length - 1]).toBe("new")
    expect(next[0]).toBe("s1")
  })
})

describe("promptSessionFamily", () => {
  const sessions = {
    parent: {},
    childA: { parentID: "parent" },
    childB: { parentID: "parent" },
    stranger: { parentID: "other" },
    orphan: {},
  }

  test("the viewed session comes first, then its tracked children", () => {
    const { api } = makeApi({ sessions })
    expect(
      promptSessionFamily(api, "parent", [
        "childB",
        "stranger",
        "childA",
        "orphan",
      ]),
    ).toEqual(["parent", "childB", "childA"])
  })

  test("a session with no tracked children is its own family", () => {
    const { api } = makeApi({ sessions })
    expect(promptSessionFamily(api, "parent", [])).toEqual(["parent"])
  })

  test("the viewed session is never duplicated by the tracked list", () => {
    const { api } = makeApi({ sessions })
    expect(promptSessionFamily(api, "parent", ["parent", "childA"])).toEqual([
      "parent",
      "childA",
    ])
  })

  test("survives a host that cannot answer for a session", () => {
    expect(promptSessionFamily({}, "parent", ["childA"])).toEqual(["parent"])
    expect(
      promptSessionFamily(
        {
          state: {
            session: {
              get: () => {
                throw new Error("nope")
              },
            },
          },
        },
        "parent",
        ["childA"],
      ),
    ).toEqual(["parent"])
  })
})

describe("singleFlight", () => {
  function gated() {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return { gate, release }
  }

  test("collapses concurrent calls into one flight plus one catch-up", async () => {
    const { gate, release } = gated()
    const calls: boolean[] = []
    let first = true
    const run = singleFlight(
      async (force: boolean) => {
        calls.push(force)
        if (first) {
          first = false
          await gate
        }
      },
      { followUp: [true] },
    )
    const flight = run(false)
    // Three callers land mid-flight; exactly one catch-up covers all of them.
    void run(false)
    void run(false)
    void run(true)
    release()
    await flight
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual([false, true])
  })

  // Not merely "run again": the catch-up must be able to get past the
  // caller's own mtime/freshness gate, which the collapsed burst is news for.
  test("the catch-up runs with the forced arguments", async () => {
    const { gate, release } = gated()
    const calls: unknown[][] = []
    let first = true
    const run = singleFlight(
      async (...args: [string, number]) => {
        calls.push(args)
        if (first) {
          first = false
          await gate
        }
      },
      { followUp: ["forced", 1] },
    )
    const flight = run("initial", 0)
    void run("dropped", 9)
    release()
    await flight
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual([
      ["initial", 0],
      ["forced", 1],
    ])
  })

  test("`queues` decides which mid-flight calls earn a catch-up", async () => {
    const { gate, release } = gated()
    const calls: boolean[] = []
    let first = true
    const run = singleFlight(
      async (force: boolean) => {
        calls.push(force)
        if (first) {
          first = false
          await gate
        }
      },
      { followUp: [true], queues: (force) => force },
    )
    const flight = run(false)
    void run(false) // unforced: the flight already covers it
    release()
    await flight
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual([false])
  })

  test("a call arriving during the catch-up queues its own turn", async () => {
    const gates = [gated(), gated()]
    const calls: number[] = []
    let index = 0
    const run = singleFlight(
      async () => {
        const own = index++
        calls.push(own)
        if (own < 2) await gates[own]?.gate
      },
      { followUp: [] as [] },
    )
    const flight = run()
    void run() // queues catch-up #1
    gates[0]?.release()
    await flight
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Catch-up #1 is now in flight (gated); a call landing on it must not be
    // folded into a catch-up that has already been spent.
    void run()
    gates[1]?.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual([0, 1, 2])
  })

  // The flag lives in a finally, so one failed read cannot wedge every later
  // one — and the rejection still reaches the caller that asked for it.
  test("a rejection propagates and does not wedge the latch", async () => {
    let attempt = 0
    const run = singleFlight(
      async () => {
        attempt += 1
        if (attempt === 1) throw new Error("read failed")
      },
      { followUp: [] as [] },
    )
    await expect(run()).rejects.toThrow("read failed")
    await run()
    expect(attempt).toBe(2)
  })

  test("a rejected flight still fires its queued catch-up", async () => {
    const { gate, release } = gated()
    let attempt = 0
    const run = singleFlight(
      async () => {
        attempt += 1
        if (attempt === 1) {
          await gate
          throw new Error("read failed")
        }
      },
      { followUp: [] as [] },
    )
    const flight = run()
    void run()
    release()
    await expect(flight).rejects.toThrow("read failed")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(attempt).toBe(2)
  })

  // The catch-up has no caller holding its promise, so its rejection has
  // nowhere to go but here. Left unhandled it is a process-level unhandled
  // rejection out of a background read — which is why the disposition is
  // explicit rather than left to each body happening to be throw-free.
  test("a rejecting catch-up is reported, not left unhandled", async () => {
    const { gate, release } = gated()
    const errors: unknown[] = []
    let attempt = 0
    const run = singleFlight(
      async () => {
        attempt += 1
        if (attempt === 1) {
          await gate
          return
        }
        throw new Error("catch-up boom")
      },
      {
        followUp: [] as [],
        onFollowUpError: (error) => errors.push(error),
      },
    )
    const flight = run()
    void run()
    release()
    await flight
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(attempt).toBe(2)
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe("catch-up boom")
  })

  test("a rejecting catch-up is dropped when no reporter is given", async () => {
    const { gate, release } = gated()
    let attempt = 0
    const run = singleFlight(
      async () => {
        attempt += 1
        if (attempt === 1) {
          await gate
          return
        }
        throw new Error("catch-up boom")
      },
      { followUp: [] as [] },
    )
    const flight = run()
    void run()
    release()
    await flight
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(attempt).toBe(2)
  })

  // Sequential calls are not concurrent ones: nothing is collapsed.
  test("calls that do not overlap each run", async () => {
    const calls: boolean[] = []
    const run = singleFlight(
      async (force: boolean) => {
        calls.push(force)
      },
      { followUp: [true] },
    )
    await run(false)
    await run(false)
    expect(calls).toEqual([false, false])
  })
})

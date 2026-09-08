import { describe, expect, type Mock, spyOn, test } from "bun:test"
import {
  appLogger,
  BAND_SAMPLE_VERSIONS as BAND,
  reportServerCompat,
  reportTuiCompat,
  tuiOpenCodeVersion,
  unsupportedVersionHooks,
  warnTui,
} from "../src/index"

/**
 * The compat plumbing's whole reason to exist is "an incompatibility is never
 * silent" — app log first, console fallback when the primary channel is
 * absent. Every consumer test supplies a working app.log and a working
 * ui.toast, so the fallback chains have never run: no test in the repo makes
 * app.log throw, and there is no `spyOn(console, "warn")` anywhere. This file
 * pins those fail-closed edges (appLogger returning false, the console
 * fallbacks in reportServerCompat and warnTui) plus the boot-time TUI gate and
 * the disabled-state toast hooks — the library exports that no test names.
 */

// Awaits `run` before restoring, so a console.warn fired inside an awaited
// reportServerCompat is still captured (a non-async try/finally would restore
// the spy before the promise settled). The callback reads spy.mock.calls at
// assertion time.
async function withWarnSpy(
  run: (spy: Mock<typeof console.warn>) => void | Promise<void>,
) {
  const spy = spyOn(console, "warn").mockImplementation(() => {})
  try {
    await run(spy)
  } finally {
    spy.mockRestore()
  }
}

describe("appLogger", () => {
  test("returns false when the injected client carries no app.log", () => {
    // The standalone-TUI and injected-v1 clients have no app route; the boolean
    // is what lets the caller fall back to the console. A `return true` mutant
    // here silently swallows every warning on those hosts.
    const log = appLogger({}, "svc")
    expect(log("warn", "message")).toBe(false)
  })

  test("returns false when app.log throws synchronously", () => {
    // A detached SDK log method reads `this._client` and throws synchronously;
    // the catch must report "nothing logged" so the console fallback fires.
    const client = {
      app: {
        log: () => {
          throw new Error("detached log")
        },
      },
    }
    const log = appLogger(client, "svc")
    expect(log("warn", "message")).toBe(false)
  })

  test("returns true and swallows a rejected promise without disturbing the caller", async () => {
    // The happy path fires-and-forgets; a rejecting promise must not surface as
    // an unhandled rejection or a thrown error to the caller's real work.
    let rejected: Promise<unknown> | undefined
    const client = {
      app: {
        log: () => {
          rejected = Promise.reject(new Error("later"))
          return rejected
        },
      },
    }
    const log = appLogger(client, "svc")
    expect(log("warn", "message")).toBe(true)
    // Let the microtask settle; the internal `.catch(() => {})` must absorb it.
    await Promise.resolve()
    await rejected?.catch(() => {})
  })
})

describe("reportServerCompat", () => {
  const serverUrl = new URL("http://opencode.internal/")

  test("falls back to console.warn when the app logger reports nothing was logged", async () => {
    // No app.log on this client, so the notice must reach the user through the
    // console. Mutants killed: deleting the console.warn block, or making
    // appLogger return true when there is no logger.
    const client = { global: { health: async () => ({ version: "1.16.20" }) } }
    await withWarnSpy(async (spy) => {
      const notice = await reportServerCompat({
        client,
        serverUrl,
        label: "Approve for Me",
        service: "approve-for-me",
        log: appLogger(client, "approve-for-me"),
      })
      expect(notice?.compat).toBe("untested")
      expect(notice?.disable).toBe(false)
      expect(spy.mock.calls).toHaveLength(1)
      const line = String(spy.mock.calls[0]?.[0])
      expect(line.startsWith("approve-for-me: ")).toBe(true)
      expect(line).toContain("1.16.20")
    })
  })

  test("does NOT touch the console when the app logger accepts the message", async () => {
    let logged = false
    const client = {
      app: {
        log: async () => {
          logged = true
          return {}
        },
      },
      global: { health: async () => ({ version: "1.16.20" }) },
    }
    await withWarnSpy(async (spy) => {
      const notice = await reportServerCompat({
        client,
        serverUrl,
        label: "Approve for Me",
        service: "approve-for-me",
        log: appLogger(client, "approve-for-me"),
      })
      expect(notice?.compat).toBe("untested")
      expect(logged).toBe(true)
      expect(spy.mock.calls).toHaveLength(0)
    })
  })

  test("returns null and stays silent inside the verified band", async () => {
    const client = { global: { health: async () => ({ version: BAND.floor }) } }
    await withWarnSpy(async (spy) => {
      const notice = await reportServerCompat({
        client,
        serverUrl,
        label: "Approve for Me",
        service: "approve-for-me",
        log: appLogger(client, "approve-for-me"),
      })
      expect(notice).toBeNull()
      expect(spy.mock.calls).toHaveLength(0)
    })
  })
})

describe("warnTui", () => {
  test("toasts when the UI is ready", async () => {
    let toasted: { variant?: string; message?: string } | undefined
    const api = {
      ui: {
        toast: (t: { variant?: string; message?: string }) => {
          toasted = t
        },
      },
    }
    await withWarnSpy((spy) => {
      warnTui(api, "svc", "heads up")
      expect(toasted).toEqual({ variant: "warning", message: "heads up" })
      expect(spy.mock.calls).toHaveLength(0)
    })
  })

  test("falls back to console.warn when ui.toast throws, without crashing", async () => {
    // A host whose UI is not ready enough to toast must get a warning, not a
    // thrown error out of TUI startup. Mutant killed: dropping the try/catch
    // around ui.toast turns this into an unhandled throw.
    const api = {
      ui: {
        toast: () => {
          throw new Error("UI not ready")
        },
      },
    }
    await withWarnSpy((spy) => {
      expect(() => warnTui(api, "svc", "heads up")).not.toThrow()
      expect(spy.mock.calls).toHaveLength(1)
      expect(String(spy.mock.calls[0]?.[0])).toBe("svc: heads up")
    })
  })

  test("falls back to console.warn when there is no ui at all", async () => {
    await withWarnSpy((spy) => {
      warnTui({}, "svc", "heads up")
      expect(spy.mock.calls).toHaveLength(1)
      expect(String(spy.mock.calls[0]?.[0])).toBe("svc: heads up")
    })
  })
})

describe("tuiOpenCodeVersion", () => {
  test("reads app.version, then the top-level version, trimming both", () => {
    expect(tuiOpenCodeVersion({ app: { version: " 1.18.4 " } })).toBe("1.18.4")
    expect(tuiOpenCodeVersion({ version: "1.18.4" })).toBe("1.18.4")
    expect(
      tuiOpenCodeVersion({ app: { version: "1.18.4" }, version: "9.9.9" }),
    ).toBe("1.18.4")
  })
  test("returns undefined when neither field is a usable string", () => {
    expect(tuiOpenCodeVersion({})).toBeUndefined()
    expect(tuiOpenCodeVersion({ app: { version: "  " } })).toBeUndefined()
    expect(tuiOpenCodeVersion({ version: 118 })).toBeUndefined()
  })
})

describe("reportTuiCompat", () => {
  test("returns null and never toasts inside the band", () => {
    let toasted = false
    const api = {
      app: { version: BAND.floor },
      ui: {
        toast: () => {
          toasted = true
        },
      },
    }
    expect(reportTuiCompat(api, { label: "L", service: "svc" })).toBeNull()
    expect(toasted).toBe(false)
  })

  test("an out-of-band host warns and keeps running even when the toast throws", async () => {
    // The load-bearing warntui-toast-throw case: a newer-minor host must warn
    // and NOT be disabled, and a throwing toast must not crash the TUI boot.
    const api = {
      app: { version: BAND.aboveBand },
      ui: {
        toast: () => {
          throw new Error("UI not ready")
        },
      },
    }
    await withWarnSpy((spy) => {
      const notice = reportTuiCompat(api, { label: "L", service: "svc" })
      expect(notice?.compat).toBe("untested")
      expect(notice?.disable).toBe(false)
      expect(spy.mock.calls).toHaveLength(1)
    })
  })

  test("a non-v1 host is reported disabled", () => {
    let toasted: { message?: string } | undefined
    const api = {
      app: { version: "2.0.0" },
      ui: {
        toast: (t: { message?: string }) => {
          toasted = t
        },
      },
    }
    const notice = reportTuiCompat(api, { label: "L", service: "svc" })
    expect(notice?.compat).toBe("incompatible")
    expect(notice?.disable).toBe(true)
    expect(toasted?.message).toContain("L")
  })
})

describe("unsupportedVersionHooks", () => {
  test("toasts exactly once, on the first permission.asked, then latches", async () => {
    const calls: unknown[] = []
    const client = {
      tui: {
        showToast: async (input: unknown) => {
          calls.push(input)
          return {}
        },
      },
    }
    const hooks = unsupportedVersionHooks(client, "/work/dir", "disabled: v2")
    await hooks.event({ event: { type: "permission.asked" } })
    await hooks.event({ event: { type: "permission.asked" } })
    await hooks.event({ event: { type: "session.idle" } })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      body: { message: "disabled: v2", variant: "warning" },
      query: { directory: "/work/dir" },
    })
  })

  test("never toasts on a non-permission event", async () => {
    const calls: unknown[] = []
    const client = {
      tui: {
        showToast: async (input: unknown) => {
          calls.push(input)
          return {}
        },
      },
    }
    const hooks = unsupportedVersionHooks(client, "/work/dir", "disabled: v2")
    await hooks.event({ event: { type: "session.idle" } })
    expect(calls).toHaveLength(0)
  })

  test("tolerates a client with no TUI toast surface", async () => {
    const hooks = unsupportedVersionHooks({}, "/work/dir", "disabled: v2")
    // No tui.showToast to bind: the hook must return quietly, not throw.
    await expect(
      hooks.event({ event: { type: "permission.asked" } }),
    ).resolves.toBeUndefined()
  })

  test("swallows a showToast that throws synchronously", async () => {
    const client = {
      tui: {
        showToast: () => {
          throw new Error("no TUI attached")
        },
      },
    }
    const hooks = unsupportedVersionHooks(client, "/work/dir", "disabled: v2")
    await expect(
      hooks.event({ event: { type: "permission.asked" } }),
    ).resolves.toBeUndefined()
  })
})

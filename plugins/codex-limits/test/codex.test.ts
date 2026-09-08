import { describe, expect, test } from "bun:test"
import type { Fetcher, ProviderContext } from "@macarons/usage-limits"
import { createSignal } from "solid-js"
import {
  type CodexOauth,
  codexModule,
  codexOauthFrom,
  fetchUsage,
  isExpired,
  parseUsage,
  sameAccount,
  sameCodexOauth,
} from "../src/codex"

const NOW = new Date(2026, 6, 11, 10, 0, 0).getTime()

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`
}

function oauth(overrides: Partial<CodexOauth> = {}): CodexOauth {
  return {
    access: "access-token",
    refresh: "refresh-token",
    expires: NOW + 3_600_000,
    ...overrides,
  }
}

// A realistic chatgpt.com/backend-api/wham/usage body: integer percentages,
// window durations in seconds, absolute unix-second reset stamps. Windows are
// typed loosely so tests can strip fields to model sparse backend responses.
type UsageWindow = Record<string, unknown>

function usageBody() {
  const primary_window: UsageWindow = {
    used_percent: 42,
    limit_window_seconds: 18_000,
    reset_after_seconds: 9_000,
    reset_at: Math.floor(NOW / 1000) + 9_000,
  }
  const secondary_window: UsageWindow = {
    used_percent: 21,
    limit_window_seconds: 604_800,
    reset_after_seconds: 400_000,
    reset_at: Math.floor(NOW / 1000) + 400_000,
  }
  const rate_limit: {
    allowed: boolean
    limit_reached: boolean
    primary_window: UsageWindow
    secondary_window?: UsageWindow
  } = { allowed: true, limit_reached: false, primary_window, secondary_window }
  return {
    plan_type: "plus",
    rate_limit,
    credits: { has_credits: true, unlimited: false },
  }
}

describe("codexOauthFrom", () => {
  test("accepts an openai oauth record", () => {
    const record = {
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: 123,
      accountId: "acct",
    }
    expect(codexOauthFrom({ openai: record })).toEqual({
      access: "a",
      refresh: "r",
      expires: 123,
      accountId: "acct",
    })
  })

  test("accountId is optional", () => {
    const record = { type: "oauth", access: "a", refresh: "r", expires: 123 }
    expect(codexOauthFrom({ openai: record })?.accountId).toBeUndefined()
  })

  test("a valid access token does not require a refresh token", () => {
    const record = { type: "oauth", access: "a", expires: 123 }
    expect(codexOauthFrom({ openai: record })).toEqual({
      access: "a",
      expires: 123,
      accountId: undefined,
    })
  })

  test.each([
    ["api key", { openai: { type: "api", key: "sk-..." } }],
    ["wellknown", { openai: { type: "wellknown", key: "k", token: "t" } }],
    [
      "no openai entry",
      { anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } },
    ],
    ["missing access", { openai: { type: "oauth", refresh: "r", expires: 1 } }],
    [
      "non-numeric expires",
      { openai: { type: "oauth", access: "a", refresh: "r", expires: "soon" } },
    ],
    ["not an object", "nope"],
    ["null", null],
  ])("rejects %s", (_name, content) => {
    expect(codexOauthFrom(content)).toBeUndefined()
  })
})

describe("isExpired", () => {
  test("compares the stored expiry against now", () => {
    expect(isExpired(oauth({ expires: NOW - 1 }), NOW)).toBe(true)
    expect(isExpired(oauth({ expires: NOW + 1 }), NOW)).toBe(false)
  })
})

describe("parseUsage", () => {
  test("normalizes both windows of a realistic body", () => {
    const limits = parseUsage(usageBody(), NOW)
    expect(limits?.planType).toBe("plus")
    expect(limits?.windows).toEqual([
      {
        key: "primary",
        label: "5h",
        usedPercent: 42,
        resetsAt: NOW + 9_000_000,
      },
      {
        key: "secondary",
        label: "7d",
        usedPercent: 21,
        resetsAt: NOW + 400_000_000,
      },
    ])
  })

  test("falls back to reset_after_seconds when reset_at is absent", () => {
    const body = usageBody()
    delete body.rate_limit.primary_window.reset_at
    expect(parseUsage(body, NOW)?.windows[0]?.resetsAt).toBe(NOW + 9_000_000)
  })

  test("omits the reset time when the backend sent none", () => {
    const body = usageBody()
    delete body.rate_limit.primary_window.reset_at
    delete body.rate_limit.primary_window.reset_after_seconds
    expect(parseUsage(body, NOW)?.windows[0]?.resetsAt).toBeUndefined()
  })

  test("clamps and rounds percentages", () => {
    const body = usageBody()
    body.rate_limit.primary_window.used_percent = 105.4
    if (body.rate_limit.secondary_window)
      body.rate_limit.secondary_window.used_percent = -3
    const limits = parseUsage(body, NOW)
    expect(limits?.windows.map((window) => window.usedPercent)).toEqual([
      100, 0,
    ])
  })

  test("a single window still renders", () => {
    const body = usageBody()
    delete body.rate_limit.secondary_window
    const limits = parseUsage(body, NOW)
    expect(limits?.windows).toHaveLength(1)
    expect(limits?.windows[0]?.label).toBe("5h")
  })

  test.each([
    ["no rate_limit", { plan_type: "plus" }],
    ["empty rate_limit", { rate_limit: {} }],
    [
      "windows without percentages",
      { rate_limit: { primary_window: { limit_window_seconds: 18_000 } } },
    ],
    ["not an object", "nope"],
    ["null", null],
  ])("yields nothing for %s", (_name, body) => {
    expect(parseUsage(body, NOW)).toBeUndefined()
  })
})

describe("sameCodexOauth", () => {
  test("compares every field of the record", () => {
    expect(sameCodexOauth(oauth(), oauth())).toBe(true)
    expect(
      sameCodexOauth(
        oauth({ accountId: "acct-1" }),
        oauth({ accountId: "acct-1" }),
      ),
    ).toBe(true)
    expect(sameCodexOauth(oauth(), oauth({ access: "other" }))).toBe(false)
    expect(sameCodexOauth(oauth(), oauth({ refresh: "other" }))).toBe(false)
    expect(sameCodexOauth(oauth(), oauth({ expires: NOW }))).toBe(false)
    expect(sameCodexOauth(oauth(), oauth({ accountId: "acct-1" }))).toBe(false)
  })

  test("treats two signed-out states as equal and signed-out vs signed-in as different", () => {
    expect(sameCodexOauth(undefined, undefined)).toBe(true)
    expect(sameCodexOauth(oauth(), undefined)).toBe(false)
    expect(sameCodexOauth(undefined, oauth())).toBe(false)
  })
})

describe("sameAccount", () => {
  test("matches records with the same account identity, however derived", () => {
    expect(
      sameAccount(
        oauth({ accountId: "acct-1" }),
        oauth({ access: "other", accountId: "acct-1" }),
      ),
    ).toBe(true)
    expect(
      sameAccount(
        oauth({ access: jwt({ chatgpt_account_id: "acct-1" }) }),
        oauth({ access: jwt({ chatgpt_account_id: "acct-1", iat: 2 }) }),
      ),
    ).toBe(true)
  })

  test("a different or unprovable account identity reads as a different account", () => {
    expect(
      sameAccount(
        oauth({ accountId: "acct-1" }),
        oauth({ accountId: "acct-2" }),
      ),
    ).toBe(false)
    // No derivable id on either side: identity cannot be proven, so usage
    // state must not be carried across the change.
    expect(sameAccount(oauth(), oauth({ access: "other" }))).toBe(false)
    expect(sameAccount(undefined, oauth({ accountId: "acct-1" }))).toBe(false)
    expect(sameAccount(oauth({ accountId: "acct-1" }), undefined)).toBe(false)
    expect(sameAccount(undefined, undefined)).toBe(false)
  })
})

type Call = { url: string; init: RequestInit }

function stubFetcher(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: Call[] = []
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { calls, fetcher }
}

/** Headers land, the body never does — the shape a header-only bound misses. */
const stalledBody = () =>
  new Response(new ReadableStream({ start() {} }), {
    headers: { "content-type": "application/json" },
  })

describe("fetchUsage", () => {
  const url = "https://chatgpt.example/wham/usage"

  test("sends the host's identification headers and parses the body", async () => {
    const { calls, fetcher } = stubFetcher(() => Response.json(usageBody()))
    const result = await fetchUsage({
      oauth: oauth({ accountId: "acct-1" }),
      fetcher,
      now: NOW,
      url,
      userAgent: "opencode/1.17.18",
    })
    expect(result.kind).toBe("success")
    if (result.kind === "success") {
      expect(result.limits.windows.map((window) => window.label)).toEqual([
        "5h",
        "7d",
      ])
    }
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(calls[0]?.url).toBe(url)
    expect(headers.authorization).toBe("Bearer access-token")
    expect(headers["chatgpt-account-id"]).toBe("acct-1")
    expect(headers.originator).toBe("opencode")
    expect(headers["user-agent"]).toBe("opencode/1.17.18")
  })

  test("derives the account id from the access token when auth.json lacks one", async () => {
    const { calls, fetcher } = stubFetcher(() => Response.json(usageBody()))
    await fetchUsage({
      oauth: oauth({ access: jwt({ chatgpt_account_id: "from-jwt" }) }),
      fetcher,
      now: NOW,
      url,
      userAgent: "ua",
    })
    expect(
      (calls[0]!.init.headers as Record<string, string>)["chatgpt-account-id"],
    ).toBe("from-jwt")
  })

  test("omits the account header when no id is derivable", async () => {
    const { calls, fetcher } = stubFetcher(() => Response.json(usageBody()))
    await fetchUsage({
      oauth: oauth(),
      fetcher,
      now: NOW,
      url,
      userAgent: "ua",
    })
    expect(calls[0]?.init.headers as Record<string, string>).not.toHaveProperty(
      "chatgpt-account-id",
    )
  })

  // Only 401 is refreshable, like the Codex CLI's own backend client; a 403
  // is a permission problem a fresh token would not fix.
  test.each([
    [401, "unauthorized"],
    [403, "failed"],
    [500, "failed"],
    [429, "failed"],
  ] as const)("maps HTTP %p to %p", async (status, kind) => {
    const { fetcher } = stubFetcher(() => new Response("nope", { status }))
    const result = await fetchUsage({
      oauth: oauth(),
      fetcher,
      now: NOW,
      url,
      userAgent: "ua",
    })
    expect(result.kind).toBe(kind)
  })

  test("treats an unparseable body and a network failure as failed", async () => {
    const malformed = await fetchUsage({
      oauth: oauth(),
      fetcher: stubFetcher(() => Response.json({ plan_type: "plus" })).fetcher,
      now: NOW,
      url,
      userAgent: "ua",
    })
    expect(malformed.kind).toBe("failed")
    const offline = await fetchUsage({
      oauth: oauth(),
      fetcher: () => Promise.reject(new Error("offline")),
      now: NOW,
      url,
      userAgent: "ua",
    })
    expect(offline.kind).toBe("failed")
  })

  test("the caller's dispose tears down a response stalled mid-body", async () => {
    // A usage read stuck on its body used to latch `inFlight` for the life of
    // the process — every later refresh silently skipped — and outlive the
    // dispose that was supposed to end it.
    const disposal = new AbortController()
    const { fetcher } = stubFetcher(stalledBody)
    const pending = fetchUsage({
      oauth: oauth(),
      fetcher,
      now: NOW,
      url,
      userAgent: "ua",
      signal: disposal.signal,
    })
    disposal.abort(new Error("plugin disposed"))
    expect((await pending).kind).toBe("failed")
  })
})

// Stateful lifecycle coverage uses a mutable auth store and a controllable
// usage endpoint so credential changes can race requests deterministically.
const USAGE_URL = "https://chatgpt.example/wham/usage"

function storeRecord(overrides: Partial<CodexOauth> = {}) {
  return {
    openai: {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
      accountId: "acct-1",
      ...overrides,
    },
  }
}

type Handler = (attempt: number) => Response | Promise<Response>

function makeContext(
  input: {
    store?: () => unknown
    intervalMs?: number
    endpoint?: string
    usage?: Handler
  } = {},
) {
  let store = input.store ?? stableStore()
  let usageHandler = input.usage ?? (() => Response.json(usageBody()))
  const usageCalls: { url: string; init: RequestInit }[] = []
  let usageAttempt = 0

  const fetcher: Fetcher = async (url, init) => {
    usageCalls.push({ url, init })
    return usageHandler(++usageAttempt)
  }

  const ctx: ProviderContext = {
    readAuthStore: async () => store(),
    fetcher,
    userAgent: "opencode/1.17.18",
    disposeSignal: new AbortController().signal,
    options: { endpoint: input.endpoint ?? USAGE_URL },
    provider: () => undefined,
    intervalMs: input.intervalMs ?? 60_000,
    createSignal,
  }

  return {
    ctx,
    usageCalls,
    setStore: (next: () => unknown) => {
      store = next
    },
    setUsage: (next: Handler) => {
      usageHandler = next
    },
  }
}

// A store fn returns the same record until the test explicitly changes it,
// matching unchanged auth.json bytes across polling ticks.
function stableStore(overrides: Partial<CodexOauth> = {}) {
  const record = storeRecord(overrides)
  return () => record
}
const expiredStore = () => stableStore({ expires: Date.now() - 1_000 })
const bearer = (calls: { init: RequestInit }[], index: number) =>
  (calls[index]?.init.headers as Record<string, string> | undefined)
    ?.authorization

describe("codex read-only credentials", () => {
  test.each(["before", "after"])(
    "a superseded failed proof %s usage I/O cannot authorize a refresh",
    async (phase) => {
      const stored = stableStore()
      const h = makeContext({ store: stored })
      const instance = codexModule.create(h.ctx)
      await instance.syncAuth()
      const checked = Promise.withResolvers<unknown>()
      const started = Promise.withResolvers<void>()
      const newer = Promise.withResolvers<unknown>()
      let reads = 0
      h.setStore(() => {
        reads += 1
        if (phase === "after" && reads === 1) return stored()
        if (reads === (phase === "before" ? 1 : 2)) {
          started.resolve()
          return checked.promise
        }
        return newer.promise
      })
      const refresh = instance.refresh(true)
      await started.promise
      const overlapping = instance.syncAuth()
      checked.resolve(undefined)
      try {
        await Bun.sleep(0)
        expect(h.usageCalls).toHaveLength(phase === "before" ? 0 : 1)
        expect(instance.snapshot()).toBeUndefined()
      } finally {
        newer.resolve(undefined)
        await Promise.all([refresh, overlapping])
      }
    },
  )

  test("waits for OpenCode to replace an expired token", async () => {
    const h = makeContext({ store: expiredStore() })
    const instance = codexModule.create(h.ctx)
    await instance.syncAuth()
    await instance.refresh(true)
    expect(h.usageCalls).toHaveLength(0)

    h.setStore(stableStore({ access: "host-access", refresh: "host-refresh" }))
    await instance.syncAuth()
    await instance.refresh(true)
    expect(h.usageCalls).toHaveLength(1)
    expect(bearer(h.usageCalls, 0)).toBe("Bearer host-access")
  })

  test("an older auth read cannot overwrite a newer completed read", async () => {
    let resolveOld!: (value: unknown) => void
    const oldRead = new Promise<unknown>((resolve) => {
      resolveOld = resolve
    })
    let reads = 0
    const newer = storeRecord({ access: "new" })
    const h = makeContext({
      store: () => (++reads === 1 ? oldRead : newer),
    })
    const instance = codexModule.create(h.ctx)

    const first = instance.syncAuth()
    await instance.syncAuth()
    resolveOld(storeRecord({ access: "old" }))
    await first
    await instance.refresh(true)

    expect(h.usageCalls).toHaveLength(1)
    expect(bearer(h.usageCalls, 0)).toBe("Bearer new")
  })
})

// codex-account-switch-drop-unasserted — syncAuth's
// `if (!sameAccount(previous, read))` clear (366-369).
describe("codex account-switch drop", () => {
  test("switching accounts drops the previous account's numbers at once, then refetches", async () => {
    const h = makeContext()
    const instance = codexModule.create(h.ctx)
    await instance.syncAuth()
    await instance.refresh(true)
    expect(instance.snapshot()).toBeDefined()
    const before = h.usageCalls.length

    // The host signs into a different ChatGPT account.
    h.setStore(
      stableStore({
        access: "b-access",
        refresh: "b-refresh",
        accountId: "acct-2",
      }),
    )
    await instance.syncAuth()
    // Dropped immediately — before any fetch could repopulate it.
    expect(instance.snapshot()).toBeUndefined()

    // And lastSuccessAt was reset, so the freshness gate does not suppress the
    // very next unforced fetch for the new account.
    await instance.refresh(false)
    expect(h.usageCalls.length).toBe(before + 1)
    expect(instance.snapshot()).toBeDefined()
  })

  test("a same-account token rotation by the host keeps the numbers on screen", async () => {
    const h = makeContext()
    const instance = codexModule.create(h.ctx)
    await instance.syncAuth()
    await instance.refresh(true)
    expect(instance.snapshot()).toBeDefined()

    // Same account, fresh access token (the host refreshed it on its own use).
    h.setStore(stableStore({ access: "host-rotated", refresh: "host-refresh" }))
    await instance.syncAuth()
    expect(instance.snapshot()).toBeDefined()
  })

  test("discards an old account's in-flight response and queues the new account", async () => {
    let releaseFirst!: () => void
    const firstResponse = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const h = makeContext({
      usage: async (attempt) => {
        if (attempt === 1) await firstResponse
        const body = usageBody()
        body.rate_limit.primary_window.used_percent = attempt === 1 ? 10 : 80
        return Response.json(body)
      },
    })
    const instance = codexModule.create(h.ctx)
    await instance.syncAuth()
    const first = instance.refresh(true)
    await Bun.sleep(0)
    expect(h.usageCalls).toHaveLength(1)

    h.setStore(
      stableStore({
        access: "b-access",
        refresh: "b-refresh",
        accountId: "acct-2",
      }),
    )
    await instance.syncAuth()
    expect(instance.snapshot()).toBeUndefined()
    void instance.refresh(false)
    releaseFirst()
    await first
    await Bun.sleep(20)

    expect(h.usageCalls).toHaveLength(2)
    expect(bearer(h.usageCalls, 1)).toBe("Bearer b-access")
    expect(instance.snapshot()?.windows[0]?.usedPercent).toBe(80)
  })
})

describe("codex 401 handling", () => {
  test("latches until OpenCode provides new credentials", async () => {
    const h = makeContext({ usage: () => new Response("no", { status: 401 }) })
    const instance = codexModule.create(h.ctx)
    await instance.syncAuth()
    await instance.refresh(true)

    expect(h.usageCalls).toHaveLength(1)
    expect(instance.snapshot()).toBeUndefined()

    await instance.refresh(true)
    await instance.refresh(true)
    expect(h.usageCalls).toHaveLength(1)

    h.setStore(
      stableStore({ access: "fresh-access", refresh: "fresh-refresh" }),
    )
    h.setUsage(() => Response.json(usageBody()))
    await instance.syncAuth()
    await instance.refresh(true)
    expect(instance.snapshot()).toBeDefined()
    expect(bearer(h.usageCalls, h.usageCalls.length - 1)).toBe(
      "Bearer fresh-access",
    )
  })
})

// failure-hide-and-backoff-unasserted — fail() (536-540) and the success reset
// (507-510). intervalMs 0 neutralizes the backoff so consecutive forced ticks
// run; a separate test pins the backoff schedule itself.
describe("codex failure handling", () => {
  test("the section survives two failures and hides on the third", async () => {
    const h = makeContext({ intervalMs: 0 })
    const instance = codexModule.create(h.ctx)
    await instance.syncAuth()
    await instance.refresh(true)
    expect(instance.snapshot()).toBeDefined()

    h.setUsage(() => new Response("upstream", { status: 500 }))
    await instance.refresh(true)
    expect(instance.snapshot()).toBeDefined() // failure 1 — stale kept
    await instance.refresh(true)
    expect(instance.snapshot()).toBeDefined() // failure 2 — stale kept
    await instance.refresh(true)
    expect(instance.snapshot()).toBeUndefined() // failure 3 — hidden
  })

  test("a success between failures resets the counter", async () => {
    const h = makeContext({ intervalMs: 0 })
    const instance = codexModule.create(h.ctx)
    await instance.syncAuth()
    await instance.refresh(true)

    h.setUsage(() => new Response("upstream", { status: 500 }))
    await instance.refresh(true)
    await instance.refresh(true)
    expect(instance.snapshot()).toBeDefined()

    h.setUsage(() => Response.json(usageBody()))
    await instance.refresh(true) // success resets failures to 0
    expect(instance.snapshot()).toBeDefined()

    h.setUsage(() => new Response("upstream", { status: 500 }))
    await instance.refresh(true)
    await instance.refresh(true)
    // Only two failures since the reset, so the section is still up.
    expect(instance.snapshot()).toBeDefined()
  })

  test("a single 401 hides the section immediately, before the threshold", async () => {
    const h = makeContext({ intervalMs: 0 })
    const instance = codexModule.create(h.ctx)
    await instance.syncAuth()
    await instance.refresh(true)
    expect(instance.snapshot()).toBeDefined()

    h.setUsage(() => new Response("no", { status: 401 }))
    await instance.refresh(true)
    expect(instance.snapshot()).toBeUndefined()
  })

  test("failures back off, and Math.min caps the delay so it stays bounded", async () => {
    const h = makeContext({
      intervalMs: 30,
      usage: () => new Response("upstream", { status: 500 }),
    })
    const instance = codexModule.create(h.ctx)
    await instance.syncAuth()
    await instance.refresh(true) // failure 1 → backoff ≈ now + 30ms
    expect(h.usageCalls).toHaveLength(1)

    // A forced refresh inside the backoff window issues no request.
    await instance.refresh(true)
    expect(h.usageCalls).toHaveLength(1)

    // Past a 30ms backoff (but well inside a mutated min→max 300ms one).
    await Bun.sleep(150)
    await instance.refresh(true)
    expect(h.usageCalls).toHaveLength(2)
  })
})

// forcequeued-reentry-unasserted — the flag is consumed *before* the follow-up
// re-enters (522-528), so a force landing mid-flight yields exactly one
// follow-up rather than a self-re-arming loop.
describe("codex forceQueued re-entry", () => {
  test("a force arriving mid-flight produces exactly one follow-up fetch", async () => {
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const h = makeContext({
      usage: async (attempt) => {
        // Hold the first response open; pace any runaway follow-ups so a
        // mis-ordered mutant cannot starve the event loop before the assert.
        if (attempt === 1) await gate
        else await Bun.sleep(1)
        return Response.json(usageBody())
      },
    })
    const instance = codexModule.create(h.ctx)
    await instance.syncAuth()

    const first = instance.refresh(false) // enters the flight, blocks on gate
    void instance.refresh(true) // in flight → sets forceQueued and returns
    releaseFirst()
    await Bun.sleep(40)
    expect(h.usageCalls).toHaveLength(2)
    await first
  })

  // An UNFORCED call landing mid-flight is dropped, not queued: the flight
  // already covers the poll interval it came from. This is the `queues`
  // predicate the shared singleFlight takes, and the one thing that
  // distinguishes this site from the two sidebar `sync` copies — which queue
  // for every mid-flight call.
  test("an unforced call arriving mid-flight earns no follow-up", async () => {
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const h = makeContext({
      usage: async (attempt) => {
        if (attempt === 1) await gate
        else await Bun.sleep(1)
        return Response.json(usageBody())
      },
    })
    const instance = codexModule.create(h.ctx)
    await instance.syncAuth()

    const first = instance.refresh(true)
    void instance.refresh(false) // in flight, unforced → dropped
    releaseFirst()
    await Bun.sleep(40)
    expect(h.usageCalls).toHaveLength(1)
    await first
  })

  // The gates that make a call a no-op (backoff, the rejected-record latch,
  // the freshness window) run INSIDE the flight now, where they used to run
  // before the latch was taken. Nothing observable may depend on that: a
  // sequence of no-op calls must leave the latch free for the next real one.
  test("a call the backoff rejects does not hold the latch", async () => {
    // A 10 ms interval makes the first failure's backoff ~10 ms, so the
    // recovery leg below is a short sleep rather than a clock stub.
    const h = makeContext({
      usage: (attempt) =>
        attempt === 1
          ? new Response("nope", { status: 500 })
          : Response.json(usageBody()),
      intervalMs: 10,
    })
    const instance = codexModule.create(h.ctx)
    await instance.syncAuth()

    await instance.refresh(true) // fails → arms the backoff
    expect(h.usageCalls).toHaveLength(1)
    // Both of these bail on the backoff. If a bailing call left the latch set,
    // the second would be swallowed as "in flight" and the recovery below
    // would never issue its request.
    await instance.refresh(true)
    await instance.refresh(true)
    expect(h.usageCalls).toHaveLength(1)

    // Once the backoff lapses the very next call must reach the network — the
    // latch has to be free for it.
    await Bun.sleep(30)
    await instance.refresh(true)
    expect(h.usageCalls).toHaveLength(2)
  })
})

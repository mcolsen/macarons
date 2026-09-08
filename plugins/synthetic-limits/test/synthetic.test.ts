import { describe, expect, test } from "bun:test"
import type { Fetcher, ProviderContext } from "@macarons/usage-limits"
import { createSignal } from "solid-js"
import {
  DEFAULT_QUOTAS_URL,
  fetchQuotas,
  parseQuotas,
  syntheticApiKey,
  syntheticModule,
} from "../src/synthetic"

const NOW = Date.parse("2026-08-10T12:00:00.000Z")

function quotaBody(over: Record<string, unknown> = {}) {
  return {
    subscription: {
      limit: 135,
      requests: 27,
      renewsAt: "2026-08-11T12:00:00.000Z",
      ...over,
    },
  }
}

describe("syntheticApiKey", () => {
  test("uses OpenCode's resolved option before its provider key", () => {
    expect(
      syntheticApiKey({
        key: "resolved-key",
        options: { apiKey: "option-key" },
      }),
    ).toBe("option-key")
    expect(syntheticApiKey({ key: "resolved-key", options: {} })).toBe(
      "resolved-key",
    )
  })

  test("treats a configured empty key as authoritative", () => {
    expect(
      syntheticApiKey({
        key: "resolved-key",
        options: { apiKey: "" },
      }),
    ).toBeUndefined()
    expect(syntheticApiKey(undefined)).toBeUndefined()
  })
})

describe("parseQuotas", () => {
  test("normalizes current rolling five-hour and weekly quota fields", () => {
    expect(
      parseQuotas(
        {
          subscription: quotaBody({ requests: 0 }).subscription,
          rollingFiveHourLimit: {
            nextTickAt: "2026-08-10T12:15:00.000Z",
            tickPercent: 0.05,
            remaining: 480,
            max: 600,
            limited: false,
          },
          weeklyTokenLimit: {
            nextRegenAt: "2026-08-10T15:22:00.000Z",
            percentRemaining: 37.6,
            maxCredits: "$24.00",
            remainingCredits: "$9.02",
            nextRegenCredits: "$0.48",
          },
        },
        NOW,
      ),
    ).toEqual({
      windows: [
        {
          key: "five-hour",
          label: "5h",
          usedPercent: 20,
          resetsAt: Date.parse("2026-08-10T12:15:00.000Z"),
          resetVerb: "regen 5%",
        },
        {
          key: "weekly",
          label: "7d",
          usedPercent: 62,
          resetsAt: Date.parse("2026-08-10T15:22:00.000Z"),
          resetVerb: "regen 2%",
        },
      ],
    })
  })

  test("normalizes the documented subscription response", () => {
    expect(parseQuotas(quotaBody(), NOW)).toEqual({
      windows: [
        {
          key: "five-hour",
          label: "5h",
          usedPercent: 20,
          resetsAt: Date.parse("2026-08-11T12:00:00.000Z"),
          resetVerb: "regen 5%",
        },
      ],
    })
  })

  test("rounds decimal usage and clamps overages", () => {
    expect(
      parseQuotas(quotaBody({ limit: 8, requests: 2.1 }), NOW)?.windows[0]
        ?.usedPercent,
    ).toBe(26)
    expect(
      parseQuotas(quotaBody({ limit: 8, requests: 12 }), NOW)?.windows[0]
        ?.usedPercent,
    ).toBe(100)
  })

  test("keeps usage but omits invalid or past quota-event times", () => {
    expect(
      parseQuotas(quotaBody({ renewsAt: "not-a-date" }), NOW)?.windows[0]
        ?.resetsAt,
    ).toBeUndefined()
    expect(
      parseQuotas(quotaBody({ renewsAt: "2026-08-09T12:00:00Z" }), NOW)
        ?.windows[0]?.resetsAt,
    ).toBeUndefined()
  })

  test("keeps valid current windows independently and clamps remaining values", () => {
    expect(
      parseQuotas(
        {
          rollingFiveHourLimit: {
            nextTickAt: "not-a-date",
            remaining: 120,
            max: 100,
          },
          weeklyTokenLimit: {
            nextRegenAt: "2026-08-09T12:00:00.000Z",
            percentRemaining: -5,
          },
        },
        NOW,
      ),
    ).toEqual({
      windows: [
        {
          key: "five-hour",
          label: "5h",
          usedPercent: 0,
          resetsAt: undefined,
          resetVerb: "regen 5%",
        },
        {
          key: "weekly",
          label: "7d",
          usedPercent: 100,
          resetsAt: undefined,
          resetVerb: "regen 2%",
        },
      ],
    })
  })

  test.each([
    undefined,
    {},
    { subscription: null },
    quotaBody({ limit: 0 }),
    quotaBody({ limit: "135" }),
    quotaBody({ requests: -1 }),
    quotaBody({ requests: Number.NaN }),
    { weeklyTokenLimit: { percentRemaining: Number.NaN } },
    { rollingFiveHourLimit: { remaining: -1, max: 600 } },
  ])("rejects malformed quota bodies", (body) => {
    expect(parseQuotas(body, NOW)).toBeUndefined()
  })
})

describe("fetchQuotas", () => {
  test("sends a bearer-authenticated GET and parses the response", async () => {
    let request: { url: string; init: RequestInit } | undefined
    const result = await fetchQuotas({
      apiKey: "sk-synthetic",
      fetcher: async (url, init) => {
        request = { url, init }
        return Response.json(quotaBody())
      },
      now: NOW,
      userAgent: "opencode/1.18.14",
    })
    expect(result.kind).toBe("success")
    expect(request?.url).toBe(DEFAULT_QUOTAS_URL)
    expect(request?.init.method).toBe("GET")
    const headers = new Headers(request?.init.headers)
    expect(headers.get("authorization")).toBe("Bearer sk-synthetic")
    expect(headers.get("user-agent")).toBe("opencode/1.18.14")
  })

  test.each([
    [401, "unauthorized"],
    [403, "failed"],
    [429, "failed"],
    [500, "failed"],
  ] as const)("maps HTTP %p to %p", async (status, kind) => {
    const result = await fetchQuotas({
      apiKey: "key",
      fetcher: async () => new Response("no", { status }),
      now: NOW,
      userAgent: "opencode/test",
    })
    expect(result.kind).toBe(kind)
  })
})

function makeContext(input: {
  provider: () => { key?: string; options: Record<string, unknown> } | undefined
  fetcher: Fetcher
}): ProviderContext {
  return {
    readAuthStore: async () => ({}),
    fetcher: input.fetcher,
    userAgent: "opencode/test",
    options: {},
    provider: input.provider,
    intervalMs: 0,
    disposeSignal: new AbortController().signal,
    createSignal,
  }
}

describe("synthetic provider lifecycle", () => {
  test("latches a rejected key until credentials change", async () => {
    let key = "rejected-key"
    const seen: string[] = []
    const ctx = makeContext({
      provider: () => ({ key, options: {} }),
      fetcher: async (_url, init) => {
        const bearer = new Headers(init.headers).get("authorization") ?? ""
        seen.push(bearer)
        return bearer.endsWith("rejected-key")
          ? new Response("no", { status: 401 })
          : Response.json(quotaBody())
      },
    })
    const instance = syntheticModule.create(ctx)
    await instance.syncAuth()
    await instance.refresh(true)
    await instance.refresh(true)
    expect(seen).toEqual(["Bearer rejected-key"])
    expect(instance.snapshot()).toBeUndefined()

    key = "replacement-key"
    await instance.syncAuth()
    await instance.refresh(true)
    expect(seen).toEqual(["Bearer rejected-key", "Bearer replacement-key"])
    expect(instance.snapshot()?.windows[0]?.usedPercent).toBe(20)
  })

  test("a key change immediately drops the previous account's snapshot", async () => {
    let key = "first-key"
    const instance = syntheticModule.create(
      makeContext({
        provider: () => ({ key, options: {} }),
        fetcher: async () => Response.json(quotaBody()),
      }),
    )
    await instance.syncAuth()
    await instance.refresh(true)
    expect(instance.snapshot()).toBeDefined()
    key = "second-key"
    await instance.syncAuth()
    expect(instance.snapshot()).toBeUndefined()
  })

  test("discards an old key's response and queues a refresh for the new key", async () => {
    let key = "first-key"
    let releaseFirst!: () => void
    const firstResponse = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const seen: string[] = []
    const instance = syntheticModule.create(
      makeContext({
        provider: () => ({ key, options: {} }),
        fetcher: async (_url, init) => {
          const bearer = new Headers(init.headers).get("authorization") ?? ""
          seen.push(bearer)
          if (seen.length === 1) await firstResponse
          return Response.json(
            quotaBody({ requests: bearer.endsWith("first-key") ? 10 : 80 }),
          )
        },
      }),
    )
    await instance.syncAuth()
    const first = instance.refresh(true)
    expect(seen).toEqual(["Bearer first-key"])

    key = "second-key"
    await instance.syncAuth()
    void instance.refresh(false)
    releaseFirst()
    await first
    await Bun.sleep(20)

    expect(seen).toEqual(["Bearer first-key", "Bearer second-key"])
    expect(instance.snapshot()?.windows[0]?.usedPercent).toBe(59)
  })
})

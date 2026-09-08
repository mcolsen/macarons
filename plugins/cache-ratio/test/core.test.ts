import { describe, expect, test } from "bun:test"
import {
  DEFAULT_BREAK_OPTIONS,
  detectBreak,
  detectBreakSeries,
  formatPercent,
  formatTokens,
  promptTokens,
  ratioSnapshot,
  type StepSample,
  type StepTokens,
} from "../src/core"

function tokens(partial: Partial<StepTokens>): StepTokens {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...partial,
  }
}

function sample(
  partial: Omit<Partial<StepSample>, "tokens"> & {
    tokens?: Partial<StepTokens>
  },
): StepSample {
  return {
    partID: partial.partID ?? "prt_1",
    messageID: partial.messageID ?? "msg_1",
    providerID: partial.providerID ?? "anthropic",
    modelID: partial.modelID ?? "claude-sonnet-5",
    summary: partial.summary ?? false,
    tokens: tokens(partial.tokens ?? {}),
    observedAt: partial.observedAt,
    startedAt: partial.startedAt,
  }
}

describe("promptTokens", () => {
  test("the full prompt is fresh input plus cache reads plus cache writes", () => {
    // The host normalizes every provider to this accounting (input excludes
    // cached tokens) — see the core module doc.
    expect(
      promptTokens(tokens({ input: 100, cacheRead: 800, cacheWrite: 100 })),
    ).toEqual({
      cached: 800,
      total: 1_000,
    })
  })

  test("providers that never report writes (OpenAI-style) still sum correctly", () => {
    expect(promptTokens(tokens({ input: 300, cacheRead: 700 }))).toEqual({
      cached: 700,
      total: 1_000,
    })
  })
})

describe("ratioSnapshot", () => {
  test("no samples yields undefined ratios and zero sums", () => {
    expect(ratioSnapshot([])).toEqual({
      session: undefined,
      last: undefined,
      steps: 0,
      cachedTokens: 0,
      writtenTokens: 0,
      freshTokens: 0,
      totalPromptTokens: 0,
    })
  })

  test("aggregates across samples and reports the newest separately", () => {
    const snapshot = ratioSnapshot([
      sample({ partID: "prt_1", tokens: { input: 1_000, cacheWrite: 9_000 } }),
      sample({
        partID: "prt_2",
        tokens: { input: 500, cacheRead: 9_500, cacheWrite: 1_000 },
      }),
    ])
    expect(snapshot.steps).toBe(2)
    expect(snapshot.cachedTokens).toBe(9_500)
    expect(snapshot.writtenTokens).toBe(10_000)
    expect(snapshot.freshTokens).toBe(1_500)
    expect(snapshot.totalPromptTokens).toBe(21_000)
    expect(snapshot.session).toBeCloseTo(9_500 / 21_000)
    expect(snapshot.last).toBeCloseTo(9_500 / 11_000)
  })

  test("a zero-prompt newest sample leaves last undefined", () => {
    const snapshot = ratioSnapshot([
      sample({ partID: "prt_1", tokens: { input: 1_000 } }),
      sample({ partID: "prt_2", tokens: { output: 50 } }),
    ])
    expect(snapshot.last).toBeUndefined()
    expect(snapshot.session).toBeCloseTo(0)
  })
})

describe("detectBreak", () => {
  const previous = sample({
    partID: "prt_prev",
    tokens: { input: 2_000, cacheRead: 100_000, cacheWrite: 3_000 },
  })

  test("the first request of a session is never judged", () => {
    expect(detectBreak(undefined, sample({}))).toEqual({
      kind: "skipped",
      reason: "first-request",
    })
  })

  test("a healthy follow-up request is ok", () => {
    const current = sample({
      partID: "prt_cur",
      tokens: { input: 1_000, cacheRead: 103_000, cacheWrite: 500 },
    })
    expect(detectBreak(previous, current)).toEqual({ kind: "ok" })
  })

  test("losing the cached prefix is a break with the loss quantified", () => {
    // The classic signature: reads collapse while the whole context is
    // re-written to cache.
    const current = sample({
      partID: "prt_cur",
      tokens: { input: 2_000, cacheRead: 1_000, cacheWrite: 104_000 },
    })
    expect(detectBreak(previous, current)).toEqual({
      kind: "break",
      lostTokens: 99_000,
      previousRead: 100_000,
      read: 1_000,
    })
  })

  test("reads above the floor fraction are ok even when lower than before", () => {
    const current = sample({
      partID: "prt_cur",
      tokens: { input: 500, cacheRead: 50_000, cacheWrite: 53_000 },
    })
    expect(detectBreak(previous, current)).toEqual({ kind: "ok" })
  })

  test("a provider or model switch is an expected loss", () => {
    const current = sample({
      partID: "prt_cur",
      modelID: "claude-opus-4-8",
      tokens: { cacheWrite: 105_000 },
    })
    expect(detectBreak(previous, current)).toEqual({
      kind: "skipped",
      reason: "model-changed",
    })
    const otherProvider = sample({
      partID: "prt_cur",
      providerID: "openai",
      tokens: { input: 105_000 },
    })
    expect(detectBreak(previous, otherProvider)).toEqual({
      kind: "skipped",
      reason: "model-changed",
    })
  })

  test("compaction summaries on either side are an expected loss", () => {
    const current = sample({
      partID: "prt_cur",
      tokens: { input: 1_000, cacheWrite: 104_000 },
    })
    expect(detectBreak({ ...previous, summary: true }, current)).toEqual({
      kind: "skipped",
      reason: "compaction",
    })
    expect(detectBreak(previous, { ...current, summary: true })).toEqual({
      kind: "skipped",
      reason: "compaction",
    })
  })

  test("a prompt smaller than the previous read means messages were removed, not a break", () => {
    const current = sample({
      partID: "prt_cur",
      tokens: { input: 4_000, cacheRead: 500, cacheWrite: 20_000 },
    })
    expect(detectBreak(previous, current)).toEqual({
      kind: "skipped",
      reason: "prompt-shrank",
    })
  })

  test("a small previous cache is not worth alerting about", () => {
    const tiny = sample({
      partID: "prt_prev",
      tokens: { input: 500, cacheRead: 4_999 },
    })
    const current = sample({ partID: "prt_cur", tokens: { input: 6_000 } })
    expect(detectBreak(tiny, current)).toEqual({ kind: "ok" })
  })

  test("a re-pay older than the TTL is an expiry, quantified like a break", () => {
    const current = sample({
      partID: "prt_cur",
      tokens: { input: 2_000, cacheRead: 0, cacheWrite: 105_000 },
      observedAt: 1_000_000 + DEFAULT_BREAK_OPTIONS.ttlMs + 1,
    })
    expect(
      detectBreak({ ...previous, observedAt: 1_000_000 }, current),
    ).toEqual({
      kind: "expired",
      lostTokens: 100_000,
      previousRead: 100_000,
      read: 0,
    })
    // Within the TTL the same pair is a break.
    expect(
      detectBreak(
        { ...previous, observedAt: 1_000_000 },
        { ...current, observedAt: 1_000_000 + 60_000 },
      ).kind,
    ).toBe("break")
    // With either time unknown the gate cannot run and the break stands.
    expect(
      detectBreak(previous, { ...current, observedAt: undefined }).kind,
    ).toBe("break")
  })

  test("the TTL gate prefers start-to-start age over the finish-time gap", () => {
    // The approve-for-me shape: request N's step waited minutes on a
    // permission prompt before its tools ran, so its step-finish landed just
    // before request N+1 went out. The finish gap is seconds — but the cache
    // entry N+1 tried to read was written at N's START, well past the TTL.
    const waited = sample({
      partID: "prt_prev",
      tokens: { input: 2_000, cacheRead: 100_000, cacheWrite: 3_000 },
      startedAt: 1_000_000,
      observedAt: 1_000_000 + 450_000,
    })
    const current = sample({
      partID: "prt_cur",
      tokens: { input: 2_000, cacheRead: 0, cacheWrite: 105_000 },
      startedAt: 1_000_000 + 450_000,
      observedAt: 1_000_000 + 480_000,
    })
    expect(detectBreak(waited, current)).toEqual({
      kind: "expired",
      lostTokens: 100_000,
      previousRead: 100_000,
      read: 0,
    })

    // The inverse — a slow response inflating the finish gap past the TTL
    // while the start-to-start age is small — must NOT masquerade as expiry:
    // the entry was provably alive, so the miss is a genuine break.
    const quick = {
      ...waited,
      startedAt: 1_000_000,
      observedAt: 1_000_000 + 10_000,
    }
    const slow = {
      ...current,
      startedAt: 1_000_000 + 20_000,
      observedAt: 1_000_000 + 400_000,
    }
    expect(detectBreak(quick, slow).kind).toBe("break")

    // With either start unknown the finish-time fallback still governs.
    expect(detectBreak({ ...waited, startedAt: undefined }, current).kind).toBe(
      "break",
    )
  })

  test("options override the thresholds", () => {
    const options = {
      minPreviousRead: 200_000,
      floorFraction: 0.5,
      ttlMs: 300_000,
    }
    const current = sample({
      partID: "prt_cur",
      tokens: { input: 2_000, cacheWrite: 104_000 },
    })
    expect(detectBreak(previous, current, options)).toEqual({ kind: "ok" })
  })

  // Each of the three thresholds in judgeAgainstFloor is exclusive at its
  // boundary; the existing cases all sit one step off it, so an inclusive-twin
  // flip (`<` -> `<=`, `>` -> `>=`) silently reclassifies the exact-boundary
  // value into a suppressed alert. These pin equality itself.
  test("a previous read exactly at the alert minimum is still judged — a collapse is a break", () => {
    // floor === DEFAULT_BREAK_OPTIONS.minPreviousRead (5_000). The size gate is
    // `floor < minPreviousRead`, so this pair is judged; `floor <= …` would
    // drop the exact-boundary floor as "ok".
    const atFloor = sample({
      partID: "prt_prev",
      tokens: { input: 500, cacheRead: 5_000 },
    })
    const collapsed = sample({
      partID: "prt_cur",
      tokens: { input: 10_000, cacheRead: 1_000 },
    })
    expect(detectBreak(atFloor, collapsed)).toEqual({
      kind: "break",
      lostTokens: 4_000,
      previousRead: 5_000,
      read: 1_000,
    })
  })

  test("a prompt total exactly equal to the floor is a break, not prompt-shrank", () => {
    // The prompt-shrank skip is `total < floor`: a prompt exactly the size of
    // the reusable floor has not shrunk, so a collapsed read is a real break.
    // `total <= floor` would mis-skip the exact-boundary prompt.
    const collapsed = sample({
      partID: "prt_cur",
      // total = 95_000 + 1_000 + 4_000 = 100_000, exactly the 100_000 floor.
      tokens: { input: 95_000, cacheRead: 1_000, cacheWrite: 4_000 },
    })
    expect(detectBreak(previous, collapsed)).toEqual({
      kind: "break",
      lostTokens: 99_000,
      previousRead: 100_000,
      read: 1_000,
    })
  })

  test("a start-to-start gap exactly at the TTL is a break; one ms past it is expiry", () => {
    // The TTL gate is `age > ttlMs`: an entry read exactly at the boundary was
    // still (just) alive, so the miss is a break; `age >= ttlMs` would
    // mis-attribute the exact-boundary miss to expiry.
    const wrote = sample({
      partID: "prt_prev",
      tokens: { input: 2_000, cacheRead: 100_000, cacheWrite: 3_000 },
      startedAt: 1_000_000,
    })
    const atTtl = sample({
      partID: "prt_cur",
      tokens: { input: 2_000, cacheRead: 1_000, cacheWrite: 104_000 },
      startedAt: 1_000_000 + DEFAULT_BREAK_OPTIONS.ttlMs,
    })
    expect(detectBreak(wrote, atTtl)).toEqual({
      kind: "break",
      lostTokens: 99_000,
      previousRead: 100_000,
      read: 1_000,
    })
    // One millisecond past the TTL, the same miss becomes expiry.
    expect(
      detectBreak(wrote, {
        ...atTtl,
        startedAt: 1_000_000 + DEFAULT_BREAK_OPTIONS.ttlMs + 1,
      }).kind,
    ).toBe("expired")
  })
})

describe("detectBreakSeries", () => {
  // healthy: read 100k of a ~105k prompt; then a sustained failure where
  // every request re-pays the whole (still growing) context.
  const healthy = sample({
    partID: "p1",
    tokens: { input: 2_000, cacheRead: 100_000, cacheWrite: 3_000 },
  })
  const miss1 = sample({
    partID: "p2",
    tokens: { input: 106_000, cacheRead: 1_000, cacheWrite: 0 },
  })
  const miss2 = sample({
    partID: "p3",
    tokens: { input: 108_000, cacheRead: 1_000, cacheWrite: 0 },
  })
  const recovered = sample({
    partID: "p4",
    tokens: { input: 4_000, cacheRead: 126_000, cacheWrite: 0 },
  })

  test("no samples yields no verdict; a single sample is the first request", () => {
    expect(detectBreakSeries([])).toBeUndefined()
    expect(detectBreakSeries([healthy])).toEqual({
      kind: "skipped",
      reason: "first-request",
    })
  })

  test("two samples judge exactly like the pairwise detector", () => {
    expect(detectBreakSeries([healthy, miss1])).toEqual(
      detectBreak(healthy, miss1),
    )
    const follow = sample({
      partID: "p2",
      tokens: { input: 1_000, cacheRead: 103_000, cacheWrite: 500 },
    })
    expect(detectBreakSeries([healthy, follow])).toEqual(
      detectBreak(healthy, follow),
    )
  })

  test("a sustained failure stays a break, measured against the last healthy floor", () => {
    // Pairwise, miss2's floor would be miss1's 1k read — under the alert
    // minimum, so the alert would clear while the cache is still broken.
    expect(detectBreak(miss1, miss2)).toEqual({ kind: "ok" })
    expect(detectBreakSeries([healthy, miss1, miss2])).toEqual({
      kind: "break",
      lostTokens: 99_000,
      previousRead: 100_000,
      read: 1_000,
    })
  })

  test("a genuine recovery clears the break", () => {
    expect(detectBreakSeries([healthy, miss1, recovered])).toEqual({
      kind: "ok",
    })
  })

  test("after a recovery the floor re-arms from the recovered read", () => {
    const relapse = sample({
      partID: "p5",
      tokens: { input: 130_000, cacheRead: 1_000, cacheWrite: 0 },
    })
    expect(detectBreakSeries([healthy, miss1, recovered, relapse])).toEqual({
      kind: "break",
      lostTokens: 125_000,
      previousRead: 126_000,
      read: 1_000,
    })
  })

  test("expected-loss causes reset a standing break instead of extending it", () => {
    expect(
      detectBreakSeries([
        healthy,
        miss1,
        { ...miss2, modelID: "claude-opus-4-8" },
      ]),
    ).toEqual({
      kind: "skipped",
      reason: "model-changed",
    })
    expect(
      detectBreakSeries([healthy, miss1, { ...miss2, summary: true }]),
    ).toEqual({
      kind: "skipped",
      reason: "compaction",
    })
    // A prompt smaller than the sticky floor means messages were removed.
    const shrunk = sample({
      partID: "p3",
      tokens: { input: 50_000, cacheRead: 1_000, cacheWrite: 0 },
    })
    expect(detectBreakSeries([healthy, miss1, shrunk])).toEqual({
      kind: "skipped",
      reason: "prompt-shrank",
    })
    // A gap past the TTL attributes the continued miss to cache expiry —
    // quantified against the sticky floor, and resetting it like any other
    // expected loss.
    const late = {
      ...miss2,
      observedAt: 1_000_000 + DEFAULT_BREAK_OPTIONS.ttlMs + 1,
    }
    expect(
      detectBreakSeries([
        { ...healthy, observedAt: 900_000 },
        { ...miss1, observedAt: 1_000_000 },
        late,
      ]),
    ).toEqual({
      kind: "expired",
      lostTokens: 99_000,
      previousRead: 100_000,
      read: 1_000,
    })
  })

  test("after a reset, detection re-arms from the resetting request's own read", () => {
    // The model switch's request read almost nothing, so the request after it
    // is measured against a floor below the alert minimum: ok, not a break.
    const afterSwitch = sample({
      partID: "p4",
      modelID: "claude-opus-4-8",
      tokens: { input: 112_000, cacheRead: 0, cacheWrite: 0 },
    })
    expect(
      detectBreakSeries([
        healthy,
        miss1,
        { ...miss2, modelID: "claude-opus-4-8" },
        afterSwitch,
      ]),
    ).toEqual({ kind: "ok" })
  })

  test("a TTL expiry re-arms detection from the expiring request's own read", () => {
    // The `expired` verdict exists to stop false alarms, so it has to clear
    // the sticky floor like every other expected-loss reset. If it kept the
    // floor, the very next ordinary request would still be measured against
    // the pre-expiry 100k read and the sidebar would stay red after a
    // perfectly normal cache expiry — the exact false alarm this verdict was
    // introduced to eliminate — until some later request happened to read
    // back above that stale floor.
    const first = { ...healthy, observedAt: 900_000 }
    const second = { ...miss1, observedAt: 1_000_000 }
    const late = {
      ...miss2,
      observedAt: 1_000_000 + DEFAULT_BREAK_OPTIONS.ttlMs + 1,
    }
    // Deliberately constructed so the cleared floor is the ONLY thing that
    // can produce "ok": this request lands well inside the TTL of `late` (so
    // it cannot re-classify as another expiry) and its prompt still exceeds
    // the pre-expiry floor (so the prompt-shrank skip cannot apply either).
    // Carrying the floor forward would therefore report a break here.
    const after = sample({
      partID: "p4",
      tokens: { input: 110_000, cacheRead: 1_000, cacheWrite: 0 },
      observedAt: (late.observedAt ?? 0) + 1_000,
    })
    expect(detectBreakSeries([first, second, late, after])).toEqual({
      kind: "ok",
    })
  })
})

describe("formatTokens", () => {
  test("keeps small counts as-is and compacts thousands and millions", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(873)).toBe("873")
    expect(formatTokens(1_000)).toBe("1k")
    expect(formatTokens(12_345)).toBe("12.3k")
    expect(formatTokens(123_456)).toBe("123k")
    expect(formatTokens(999_499)).toBe("999k")
    expect(formatTokens(999_500)).toBe("1M")
    expect(formatTokens(1_234_567)).toBe("1.2M")
    expect(formatTokens(123_456_789)).toBe("123M")
  })

  test("garbage never renders", () => {
    expect(formatTokens(-5)).toBe("0")
    expect(formatTokens(Number.NaN)).toBe("0")
  })
})

describe("formatPercent", () => {
  test("rounds to whole percents", () => {
    expect(formatPercent(0)).toBe("0%")
    expect(formatPercent(0.42)).toBe("42%")
    expect(formatPercent(1)).toBe("100%")
  })

  test("never rounds a partial hit up to 100% or a nonzero one down to 0%", () => {
    expect(formatPercent(0.999)).toBe("99%")
    expect(formatPercent(0.001)).toBe("1%")
  })
})

import { describe, expect, test } from "bun:test"
import {
  BAND_SAMPLE_VERSIONS as BAND,
  probeOpenCodeVersion,
} from "../src/index"

/**
 * probeOpenCodeVersion walks a three-tier fallback — the SDK's global.health(),
 * then the raw transport, then the public HTTP endpoint — because the injected
 * v1 clients and the standalone TUI each expose a different subset. The whole
 * point of the chain is to survive a degraded host, yet no test in the repo
 * ever hands it an SDK client whose global.health() REJECTS: every health mock
 * resolves. So tier 1's failure edge (its try/catch) has never run, and the
 * mutant that deletes it — letting the rejection escape into every plugin's
 * boot — survives the suite while turning a warning into a boot crash on
 * exactly the degraded host the chain exists for.
 *
 * Every tier is bounded, so each also has a wedged edge distinct from its
 * rejecting one: work that never settles at all, which no rejection test
 * reaches.
 */

const serverUrl = new URL("http://opencode.internal/")

describe("probeOpenCodeVersion", () => {
  test("a rejecting SDK health falls through to the transport rather than throwing", async () => {
    // Tier 1 rejects; tier 2 (the SDK's in-process transport) answers. The
    // probe must recover, not reject. Mutant killed: removing the try/catch
    // around clientHealth() lets this rejection propagate out.
    const client = {
      global: {
        health: async () => {
          throw new Error("health route errored")
        },
      },
      _client: {
        get: async ({ url }: { url: string }) => {
          expect(url).toBe("/global/health")
          return { data: { version: BAND.floor } }
        },
      },
    }
    await expect(probeOpenCodeVersion(client, serverUrl)).resolves.toEqual({
      version: BAND.floor,
    })
  })

  test("a wedged SDK health falls through to the transport rather than parking init", async () => {
    // Tier 1 never settles. It is in-process, which makes it fast on a healthy
    // host but not incapable of wedging — unbounded, it parked every plugin
    // awaiting reportServerCompat for the life of the session.
    let seen: AbortSignal | undefined
    const client = {
      global: {
        health: (options?: { signal?: AbortSignal }) =>
          new Promise<never>(() => {
            seen = options?.signal
          }),
      },
      _client: {
        get: async () => ({ data: { version: BAND.floor } }),
      },
    }
    const started = Date.now()
    await expect(probeOpenCodeVersion(client, serverUrl)).resolves.toEqual({
      version: BAND.floor,
    })
    expect(Date.now() - started).toBeLessThan(10_000)
    // Bounded by a real cancellation, not only by the race: the SDK spreads
    // this signal into its own fetch, so the abandoned request is torn down
    // instead of left running against a host nobody is waiting on.
    expect(seen?.aborted).toBe(true)
  }, 15_000)

  test("the transport tier is signalled, not only raced", async () => {
    let seen: AbortSignal | undefined
    const client = {
      _client: {
        get: (options: { url: string; signal?: AbortSignal }) =>
          new Promise<never>(() => {
            seen = options.signal
          }),
      },
    }
    // Tier 3 hits a closed port and fails fast, so the probe resolves a reason.
    const result = await probeOpenCodeVersion(
      client,
      new URL("http://127.0.0.1:1/"),
    )
    expect(result.version).toBeUndefined()
    expect(seen?.aborted).toBe(true)
  }, 15_000)

  test("tier 1 answers directly when global.health resolves a version", async () => {
    // Pins that clientHealth is bound and consulted first; a broken bind would
    // fall through instead of answering here.
    const client = {
      global: { health: async () => ({ version: BAND.floor }) },
    }
    await expect(probeOpenCodeVersion(client, serverUrl)).resolves.toEqual({
      version: BAND.floor,
    })
  })

  test("every tier failing yields a reason, never a rejection", async () => {
    // tier 1 rejects, tier 2 rejects, tier 3 (HTTP) hits a closed port and
    // fails fast — the probe collects the failures into `reason` and resolves.
    const client = {
      global: {
        health: async () => {
          throw new Error("health route errored")
        },
      },
      _client: {
        get: async () => {
          throw new Error("transport down")
        },
      },
    }
    // 127.0.0.1:1 refuses immediately: an offline, deterministic tier-3 failure.
    const closedServer = new URL("http://127.0.0.1:1/")
    const result = await probeOpenCodeVersion(client, closedServer)
    expect(result.version).toBeUndefined()
    expect(result.reason).toContain("the SDK health request failed")
    expect(result.reason).toContain("the SDK transport health request failed")
  })

  test("a tier-3 response that stalls mid-body still settles at the probe bound", async () => {
    // The failure the two-second bound exists for: /global/health answers with
    // headers and then never sends a body. Bounding only the fetch let the
    // json() read run past the deadline, so the probe never settled and every
    // plugin awaiting reportServerCompat stayed blocked through startup.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    try {
      const started = Date.now()
      const result = await probeOpenCodeVersion({}, serverUrl)
      expect(result.version).toBeUndefined()
      expect(result.reason).toContain("/global/health failed")
      expect(result.reason).toContain("timed out")
      // Settled at the bound rather than hanging; generous upper edge so a
      // loaded CI box cannot flake it.
      expect(Date.now() - started).toBeLessThan(10_000)
    } finally {
      globalThis.fetch = realFetch
    }
  }, 15_000)
})

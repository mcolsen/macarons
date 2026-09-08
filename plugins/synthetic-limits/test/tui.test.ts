import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import { until } from "@macarons/plugin-test-harness"
import { describeGating } from "@macarons/plugin-test-harness/tui"
import { makeApi } from "./harness"

function quotaServer() {
  const requests: Array<{
    authorization: string | null
    userAgent: string | null
  }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      requests.push({
        authorization: request.headers.get("authorization"),
        userAgent: request.headers.get("user-agent"),
      })
      return Response.json({
        subscription: {
          limit: 100,
          requests: 25,
          renewsAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v2/quotas`,
    requests,
    stop: () => server.stop(true),
  }
}

const cleanups: Array<() => void | Promise<void>> = []
const originalAuth = process.env.OPENCODE_AUTH_CONTENT
const originalKey = process.env.SYNTHETIC_API_KEY
const originalDataHome = process.env.XDG_DATA_HOME

beforeEach(() => {
  process.env.XDG_DATA_HOME = "/nonexistent/synthetic-limits-test"
  delete process.env.OPENCODE_AUTH_CONTENT
  delete process.env.SYNTHETIC_API_KEY
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  if (originalAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuth
  if (originalKey === undefined) delete process.env.SYNTHETIC_API_KEY
  else process.env.SYNTHETIC_API_KEY = originalKey
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalDataHome
})

describeGating({
  remoteBails: true,
  load: async (input) => {
    const harness = makeApi(input)
    await harness.load()
    const run = {
      toasts: harness.toasts,
      registered: harness.slotPlugins.length === 1,
      inert:
        harness.slotPlugins.length === 0 &&
        harness.disposers.length === 0 &&
        harness.layers.length === 0 &&
        harness.handlers.size === 0,
    }
    await harness.dispose()
    return run
  },
})

describe("Synthetic polling", () => {
  test("uses the server-resolved key over loopback despite unrelated local credentials", async () => {
    const server = quotaServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      synthetic: { type: "api", key: "stored-key" },
    })
    process.env.SYNTHETIC_API_KEY = "env-key"
    const harness = makeApi({
      baseUrl: "http://127.0.0.1:4096",
      sessionModelProviderID: "synthetic",
      configApiKey: "raw-config-key",
      effectiveApiKey: "effective-key",
      effectiveKey: "fallback-key",
    })
    await harness.load({
      providers: { synthetic: { endpoint: server.url } },
    })
    cleanups.push(harness.dispose)
    await until(() => server.requests.length >= 1)
    expect(server.requests[0]?.authorization).toBe("Bearer effective-key")
    expect(server.requests[0]?.userAgent).toBe(`opencode/${BAND.floor}`)
    expect(harness.slotPlugins[0]?.order).toBe(152)
  })

  test("does not fetch for another provider", async () => {
    const server = quotaServer()
    cleanups.push(server.stop)
    process.env.SYNTHETIC_API_KEY = "env-key"
    const harness = makeApi({
      sessionModelProviderID: "openai",
      effectiveKey: "env-key",
    })
    await harness.load({
      providers: { synthetic: { endpoint: server.url } },
    })
    cleanups.push(harness.dispose)
    harness.emit("session.idle", { sessionID: "ses_1" })
    await Bun.sleep(100)
    expect(server.requests).toHaveLength(0)
  })
})

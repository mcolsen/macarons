import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
// Fixture-only: the override file is what the approve-for-me TUI toggle
// writes, and composing its path through that plugin's own helper keeps the
// fixture from drifting when its layout changes — likewise the activity
// writer for the server-half beacon the interop gates on. The RUNTIME
// interop surface stays the ./interop entrypoint alone
// (tests/repo/test/cross-plugin-imports pins src/; test fixtures may reach
// for the producer's path helpers).
import {
  activityFile,
  overrideFile,
  PLUGIN_PACKAGE_NAME,
  sessionModelDirectory,
  sessionModelFile,
  writeActivity,
  writeSessionModel,
} from "@macarons/approve-for-me/shared"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import { until } from "@macarons/plugin-test-harness"
import { describeGating } from "@macarons/plugin-test-harness/tui"
import { INSTANCE_ID, makeApi } from "./harness"

const OAUTH_RECORD = {
  openai: {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 3_600_000,
    accountId: "acct-1",
  },
}

function usageBody() {
  return {
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 42,
        limit_window_seconds: 18_000,
        reset_at: Math.floor(Date.now() / 1000) + 9_000,
      },
      secondary_window: {
        used_percent: 21,
        limit_window_seconds: 604_800,
        reset_at: Math.floor(Date.now() / 1000) + 400_000,
      },
    },
  }
}

// A loopback stand-in for the ChatGPT usage backend, wired in through the
// codex module's documented `providers.openai.endpoint` option.
function usageServer(
  handler?: (request: Request) => Response | Promise<Response>,
) {
  const requests: { url: string; headers: Headers }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push({ url: request.url, headers: request.headers })
      return handler ? handler(request) : Response.json(usageBody())
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/wham/usage`,
    requests,
    stop: () => server.stop(true),
  }
}

function codexEndpoint(url: string) {
  return { providers: { openai: { endpoint: url } } }
}

const cleanups: Array<() => void | Promise<void>> = []
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT
const originalDataHome = process.env.XDG_DATA_HOME
const originalFetch = globalThis.fetch

beforeEach(() => {
  // Without this, tests that clear OPENCODE_AUTH_CONTENT would fall through
  // to the developer's real ~/.local/share/opencode/auth.json.
  process.env.XDG_DATA_HOME = "/nonexistent/codex-limits-test"
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  if (originalAuthContent === undefined)
    delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuthContent
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalDataHome
  globalThis.fetch = originalFetch
})

async function load(
  harness: ReturnType<typeof makeApi>,
  options?: Record<string, unknown>,
) {
  await harness.load(options)
  cleanups.push(harness.dispose)
}

// The version/locality gating triad, from the shared harness: the old inline
// "version guard" describe (a hardcoded pre-band "1.16.0" sample, a minted
// "2.0.0") is subsumed by the BAND.belowBand/BAND.incompatible legs, plus the
// floor-silent, fail-open and remote-attach legs. `inert` is the full
// registration surface: nothing subscribes before the gate in src/tui.tsx.
describeGating({
  remoteBails: true,
  load: async (input) => {
    // No local auth: the gating legs assert registration shape, not polling.
    delete process.env.OPENCODE_AUTH_CONTENT
    const mock = makeApi(input)
    await mock.load()
    const run = {
      toasts: mock.toasts,
      registered: mock.slotPlugins.length === 1,
      inert:
        mock.slotPlugins.length === 0 &&
        mock.disposers.length === 0 &&
        mock.layers.length === 0 &&
        mock.handlers.size === 0,
    }
    await mock.dispose()
    return run
  },
})

describe("slot registration", () => {
  test("registers a sidebar_content slot between Context and MCP", async () => {
    const harness = makeApi()
    delete process.env.OPENCODE_AUTH_CONTENT
    await load(harness)
    expect(harness.toasts).toHaveLength(0)
    expect(harness.slotPlugins).toHaveLength(1)
    const [plugin] = harness.slotPlugins
    if (!plugin) throw new Error("expected a slot plugin")
    expect(plugin.order).toBe(150)
    expect(typeof plugin.slots.sidebar_content).toBe("function")
  })
})

describe("server locality", () => {
  // Hostname locality never proves auth scope. Even opencode.internal needs
  // the companion's credential proof; the existing remote gate stays intact.
  test.each([
    ["a remote attach", "http://192.0.2.10:4096"],
    ["an unreadable client transport", ""],
  ])("stays fully inert on %s", async (_name, baseUrl) => {
    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({ sessionModelProviderID: "openai", baseUrl })
    await load(harness, codexEndpoint(server.url))
    harness.emit("session.idle", { sessionID: "ses_1" })
    await harness.waitForQuiescence()
    expect(harness.slotPlugins).toHaveLength(0)
    expect(harness.disposers).toHaveLength(0)
    expect(server.requests).toHaveLength(0)
  })

  test("shows limits over a loopback attach with matching server credentials", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({
      sessionModelProviderID: "openai",
      baseUrl: "http://127.0.0.1:4096",
      serverAuth: async () => OAUTH_RECORD,
    })
    await load(harness, codexEndpoint(server.url))
    await until(() => server.requests.length >= 1)
    expect(harness.slotPlugins).toHaveLength(1)
    expect(harness.authCommands.length).toBeGreaterThan(0)
    expect(harness.authCommands.join("\n")).not.toMatch(
      /access-token|refresh-token|acct-1/,
    )
  })

  test.each([
    [
      "server API-key auth",
      async () => ({ openai: { type: "api", key: "server-key" } }),
    ],
    [
      "another server OAuth account",
      async () => ({
        openai: {
          ...OAUTH_RECORD.openai,
          access: "server-access",
          accountId: "server-account",
        },
      }),
    ],
    ["missing server auth", async () => ({})],
    ["missing server companion", false],
  ] as const)(
    "never fetches local-account quota with %s",
    async (_name, serverAuth) => {
      const server = usageServer()
      cleanups.push(server.stop)
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
      const harness = makeApi({
        sessionModelProviderID: "openai",
        baseUrl: "http://127.0.0.1:4096",
        serverAuth,
      })
      await load(harness, codexEndpoint(server.url))
      harness.emit("session.idle", { sessionID: "ses_1" })
      await harness.waitForQuiescence()
      expect(server.requests).toHaveLength(0)
    },
    // The shared transport exists even without Codex: auth sync and refresh
    // each wait for the missing companion's three-second proof deadline.
    10_000,
  )

  test("opencode.internal is not auth-scope evidence without a companion", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({
      sessionModelProviderID: "openai",
      serverAuth: false,
    })
    await load(harness, codexEndpoint(server.url))
    await harness.waitForQuiescence()
    expect(server.requests).toHaveLength(0)
  }, 10_000)

  test("waits for the host to refresh credentials over a loopback attach", async () => {
    // With an expired token the plugin sits still until the host rotates the
    // record, then resumes with the host's token.
    const routed: string[] = []
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: {
        type: "oauth",
        access: "stale-access",
        refresh: "refresh-token",
        expires: Date.now() - 1_000,
        accountId: "acct-1",
      },
    })
    globalThis.fetch = (async (url: any, init?: any) => {
      routed.push(String(url))
      if (String(url) === "https://auth.openai.com/oauth/token") {
        return Response.json({
          access_token: "plugin-access",
          refresh_token: "plugin-refresh",
          expires_in: 3600,
        })
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer host-access",
      )
      return Response.json(usageBody())
    }) as typeof fetch
    const harness = makeApi({
      sessionModelProviderID: "openai",
      baseUrl: "http://127.0.0.1:4096",
    })
    await load(harness, codexEndpoint("https://chatgpt.example/wham/usage"))
    await harness.waitForQuiescence()
    expect(routed).toHaveLength(0)

    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: {
        type: "oauth",
        access: "host-access",
        refresh: "host-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "acct-1",
      },
    })
    harness.emit("session.idle", { sessionID: "ses_1" })
    await until(() => routed.length >= 1)
    expect(routed).toEqual(["https://chatgpt.example/wham/usage"])
  })
})

describe("usage polling", () => {
  test("fetches with the host's identification when the session is OpenAI via OAuth", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({ sessionModelProviderID: "openai" })
    await load(harness, codexEndpoint(server.url))
    await until(() => server.requests.length >= 1)
    const request = server.requests[0]
    if (!request) throw new Error("expected a recorded request")
    expect(request.headers.get("authorization")).toBe("Bearer access-token")
    expect(request.headers.get("chatgpt-account-id")).toBe("acct-1")
    expect(request.headers.get("originator")).toBe("opencode")
    expect(request.headers.get("user-agent")).toBe(`opencode/${BAND.floor}`)
  })

  test("adopts the host-refreshed file record over an expired inline snapshot", async () => {
    const dataHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "codex-limits-auth-"),
    )
    cleanups.push(() => fs.rm(dataHome, { recursive: true, force: true }))
    const dataDir = path.join(dataHome, "opencode")
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(
      path.join(dataDir, "auth.json"),
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "host-refreshed-access",
          refresh: "host-refreshed-refresh",
          expires: Date.now() + 3_600_000,
          accountId: "acct-1",
        },
      }),
    )
    process.env.XDG_DATA_HOME = dataHome
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: {
        type: "oauth",
        access: "expired-inline-access",
        refresh: "expired-inline-refresh",
        expires: Date.now() - 1_000,
        accountId: "acct-1",
      },
    })
    const server = usageServer()
    cleanups.push(server.stop)
    const harness = makeApi({ sessionModelProviderID: "openai" })
    await load(harness, codexEndpoint(server.url))
    await until(() => server.requests.length >= 1)

    expect(server.requests[0]?.headers.get("authorization")).toBe(
      "Bearer host-refreshed-access",
    )
  })

  test("rejects a later file credential for another account", async () => {
    const dataHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "codex-limits-other-account-"),
    )
    cleanups.push(() => fs.rm(dataHome, { recursive: true, force: true }))
    const dataDir = path.join(dataHome, "opencode")
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(
      path.join(dataDir, "auth.json"),
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "account-b-access",
          refresh: "account-b-refresh",
          expires: Date.now() + 3_600_000,
          accountId: "acct-b",
        },
      }),
    )
    process.env.XDG_DATA_HOME = dataHome
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: {
        type: "oauth",
        access: "expired-account-a-access",
        refresh: "expired-account-a-refresh",
        expires: Date.now() - 1_000,
        accountId: "acct-a",
      },
    })
    const server = usageServer()
    cleanups.push(server.stop)
    const harness = makeApi({ sessionModelProviderID: "openai" })
    await load(harness, codexEndpoint(server.url))
    harness.emit("session.idle", { sessionID: "ses_1" })
    await Bun.sleep(150)

    expect(server.requests).toHaveLength(0)
  })

  test("a completed turn forces a refresh even inside the poll interval", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({ sessionModelProviderID: "openai" })
    await load(harness, codexEndpoint(server.url))
    await until(() => server.requests.length >= 1)
    harness.emit("session.idle", { sessionID: "ses_1" })
    await until(() => server.requests.length >= 2)
  })

  test("a turn completing while a fetch is in flight still forces a follow-up", async () => {
    // Hold the first response open so the idle event provably lands while
    // the fetch is in flight — the window CI hits when the runner is loaded.
    // The in-flight numbers predate the turn, so a follow-up fetch must run.
    let releaseFirst!: () => void
    const firstResponseGate = new Promise<void>(
      (resolve) => (releaseFirst = resolve),
    )
    let served = 0
    const server = usageServer(async () => {
      served += 1
      if (served === 1) await firstResponseGate
      return Response.json(usageBody())
    })
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({ sessionModelProviderID: "openai" })
    await load(harness, codexEndpoint(server.url))
    await until(() => server.requests.length >= 1)
    harness.emit("session.idle", { sessionID: "ses_1" })
    // Let the forced tick reach the provider before the first fetch settles.
    await Bun.sleep(50)
    releaseFirst()
    await until(() => server.requests.length >= 2)
  })

  test("gates on the last assistant turn and the config default when the session has no sticky model", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const viaMessages = makeApi({ lastAssistantProviderID: "openai" })
    await load(viaMessages, codexEndpoint(server.url))
    await until(() => server.requests.length >= 1)

    const viaConfig = makeApi({ configModel: "openai/gpt-5.5" })
    await load(viaConfig, codexEndpoint(server.url))
    await until(() => server.requests.length >= 2)
  })

  test("refreshes after the viewed session switches to a Fast model", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({ sessionModelProviderID: "anthropic" })
    await load(harness, codexEndpoint(server.url))
    await harness.waitForQuiescence()
    expect(server.requests).toHaveLength(0)

    harness.emit("session.next.model.switched", {
      sessionID: "ses_1",
      messageID: "msg_switch",
      timestamp: Date.now(),
      model: {
        id: "gpt-5.6-sol-fast",
        providerID: "openai",
        variant: "max",
      },
    })
    await until(() => server.requests.length >= 1)

    harness.emit("session.updated", {
      info: {
        id: "ses_1",
        model: { id: "claude-sonnet-4-20250514", providerID: "anthropic" },
      },
    })
    harness.emit("session.idle", { sessionID: "ses_1" })
    await harness.waitForQuiescence()
    expect(server.requests).toHaveLength(1)
  })

  test("disposal detaches the turn-completion handler", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({ sessionModelProviderID: "openai" })
    await load(harness, codexEndpoint(server.url))
    await until(() => server.requests.length >= 1)
    await harness.dispose()
    const before = server.requests.length
    harness.emit("session.idle", { sessionID: "ses_1" })
    await harness.waitForQuiescence()
    expect(server.requests.length).toBe(before)
  })

  test.each([
    ["another provider's model", { sessionModelProviderID: "anthropic" }],
    [
      "an OpenAI model through a reseller",
      { sessionModelProviderID: "openrouter", configModel: "openai/gpt-5.5" },
    ],
    [
      "a sub-agent session",
      { sessionModelProviderID: "openai", parentID: "ses_parent" },
    ],
    [
      "no session in view",
      { sessionModelProviderID: "openai", routeName: "home" },
    ],
  ] as const)("never fetches for %s", async (_name, input) => {
    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi(input)
    await load(harness, codexEndpoint(server.url))
    harness.emit("session.idle", { sessionID: "ses_1" })
    await harness.waitForQuiescence()
    expect(server.requests).toHaveLength(0)
  })

  test.each([
    ["an API key", JSON.stringify({ openai: { type: "api", key: "sk-test" } })],
    ["no openai entry", JSON.stringify({})],
    ["no auth at all", undefined],
  ] as const)(
    "never fetches when OpenAI auth is %s",
    async (_name, content) => {
      const server = usageServer()
      cleanups.push(server.stop)
      if (content === undefined) delete process.env.OPENCODE_AUTH_CONTENT
      else process.env.OPENCODE_AUTH_CONTENT = content
      const harness = makeApi({ sessionModelProviderID: "openai" })
      await load(harness, codexEndpoint(server.url))
      harness.emit("session.idle", { sessionID: "ses_1" })
      await harness.waitForQuiescence()
      expect(server.requests).toHaveLength(0)
    },
  )
})

// interval-option-unvalidated — options.interval is clamped to
// MIN_INTERVAL_SECONDS and defaults to 60, and the intervalMs it produces
// drives both the codex freshness window and the failure backoff. No test ever
// passed an interval value, so the clamp/fallback (and the Math.max floor) ran
// green under any mutation.
describe("poll interval option", () => {
  const cases: Array<[Record<string, unknown> | undefined, number]> = [
    [{ interval: 300 }, 300_000],
    [{ interval: 5 }, 15_000], // clamped up to the 15s floor
    [{ interval: "soon" }, 60_000], // non-numeric → default
    [{ interval: 0 }, 60_000], // a 0 interval would spin setInterval
    [{ interval: -1 }, 60_000],
    [{ interval: Number.NaN }, 60_000],
    [undefined, 60_000],
  ]
  test.each(cases)(
    "resolves %o to a %p ms poll interval",
    async (options, expected) => {
      delete process.env.OPENCODE_AUTH_CONTENT
      const delays: number[] = []
      const timers: ReturnType<typeof setInterval>[] = []
      const originalSetInterval = globalThis.setInterval
      globalThis.setInterval = ((fn: () => void, ms?: number) => {
        delays.push(Number(ms))
        const timer = originalSetInterval(fn, ms)
        timers.push(timer)
        return timer
      }) as typeof setInterval
      try {
        const harness = makeApi()
        await load(harness, options)
      } finally {
        globalThis.setInterval = originalSetInterval
      }
      expect(delays).toEqual([expected])
      expect(timers).toHaveLength(1)
      expect(timers[0]?.hasRef()).toBe(false)
    },
  )
})

// provider-options-malformed (narrowed) — every polling test supplies an
// explicit endpoint via codexEndpoint(), so the DEFAULT_USAGE_URL fallback (and
// its whitespace-only sibling) is asserted nowhere: a typo'd constant, or a
// fallback swapped for the undefined option, would break every real user with
// the suite green.
describe("endpoint fallback", () => {
  const cases: Array<[string, Record<string, unknown> | undefined]> = [
    ["no providers option at all", undefined],
    [
      "a blank endpoint override",
      { providers: { openai: { endpoint: "   " } } },
    ],
  ]
  test.each(cases)(
    "polls the real ChatGPT backend given %s",
    async (_name, options) => {
      const urls: string[] = []
      globalThis.fetch = (async (url: unknown) => {
        urls.push(String(url))
        return Response.json(usageBody())
      }) as typeof fetch
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
      const harness = makeApi({ sessionModelProviderID: "openai" })
      await load(harness, options)
      await until(() => urls.length >= 1)
      expect(urls[0]).toBe("https://chatgpt.com/backend-api/wham/usage")
    },
  )
})

describe("classifier interop", () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function classifierDirs() {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "codex-limits-tui-classifier-"),
    )
    const made = {
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      directory: path.join(root, "project"),
    }
    await Promise.all(
      Object.values(made).map((dir) => fs.mkdir(dir, { recursive: true })),
    )
    // Canonical paths, so fixture files key like the interop's trusted
    // layout; the project doubles as the worktree so approve-for-me's config
    // scan stops there, the git-shaped session the host reports.
    const directory = await fs.realpath(made.directory)
    const state = await fs.realpath(made.state)
    // The server half's liveness beacon: settings alone read as "configured",
    // never "classifying" (PR #142 review F2), so the fixture plants a
    // running producer through the producer's own writer.
    await writeActivity(activityFile(state, directory, INSTANCE_ID), {
      server: { state: "ready", time: Date.now() },
      requests: {},
    })
    return {
      config: await fs.realpath(made.config),
      state,
      directory,
      worktree: directory,
    }
  }

  // The global settings layer as approve-for-me reads it since its PR #139:
  // that plugin's entry options in the host's own opencode.json.
  async function writeGlobalSettings(dirs: { config: string }, value: unknown) {
    await fs.writeFile(
      path.join(dirs.config, "opencode.json"),
      JSON.stringify({ plugin: [[PLUGIN_PACKAGE_NAME, value]] }),
    )
  }

  test("polls the classifier's provider even when the session runs elsewhere", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    const dirs = await classifierDirs()
    await writeGlobalSettings(dirs, { model: "openai/gpt-5.5-codex" })
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    // The viewed session runs on a provider this build has no module for; the
    // classifier alone makes openai relevant.
    const harness = makeApi({
      sessionModelProviderID: "anthropic",
      paths: dirs,
    })
    await load(harness, codexEndpoint(server.url))
    await until(() => server.requests.length >= 1)
  })

  test("a disabled approve-for-me stops classifier polling; toggling it back on resumes", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    const dirs = await classifierDirs()
    await writeGlobalSettings(dirs, {
      enabled: false,
      model: "openai/gpt-5.5-codex",
    })
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({
      sessionModelProviderID: "anthropic",
      paths: dirs,
    })
    await load(harness, codexEndpoint(server.url))
    harness.emit("session.idle", { sessionID: "ses_1" })
    await harness.waitForQuiescence()
    expect(server.requests).toHaveLength(0)

    // The instance override file is what the approve-for-me toggle writes.
    const override = overrideFile(dirs.state, dirs.directory, INSTANCE_ID)
    await fs.mkdir(path.dirname(override), { recursive: true })
    await fs.writeFile(override, JSON.stringify({ enabled: true }))
    harness.emit("session.idle", { sessionID: "ses_1" })
    await until(() => server.requests.length >= 1)
  })

  test("classifier paths still syncing at load resolve on a later tick", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    const dirs = await classifierDirs()
    await writeGlobalSettings(dirs, { model: "openai/gpt-5.5-codex" })
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    // The host fills api.state.path from a server round-trip that races
    // plugin activation; until it lands every field is an empty string.
    // Resolving against those placeholders must not latch "no classifier".
    const harness = makeApi({
      sessionModelProviderID: "anthropic",
      paths: { config: "", state: "", directory: "" },
    })
    await load(harness, codexEndpoint(server.url))
    harness.emit("session.idle", { sessionID: "ses_1" })
    await harness.waitForQuiescence()
    expect(server.requests).toHaveLength(0)

    // The path store syncs (the host writes all fields in one batch); the
    // next tick must pick the classifier up without a TUI restart.
    Object.assign(harness.api.state.path, dirs)
    harness.emit("session.idle", { sessionID: "ses_1" })
    await harness.waitForQuiescence()
    await until(() => server.requests.length >= 1)
  })

  test("waits for viewed root metadata before resolving or polling", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    const dirs = await classifierDirs()
    await writeGlobalSettings(dirs, { model: "openai/gpt-5.5-codex" })
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    let catalogReads = 0
    const harness = makeApi({
      sessionModelProviderID: "openai",
      sessionMetadata: "missing",
      paths: dirs,
      onProviderCatalogRead: () => {
        catalogReads += 1
      },
    })
    await load(harness, codexEndpoint(server.url))
    harness.emit("session.idle", { sessionID: "ses_1" })
    await harness.waitForQuiescence()
    expect(server.requests).toHaveLength(0)
    expect(catalogReads).toBe(0)

    harness.setSessionMetadata({})
    harness.emit("session.idle", { sessionID: "ses_1" })
    await until(() => catalogReads >= 1)
    await until(() => server.requests.length >= 1)
  })

  test.each([
    ["a throwing record", "throwing"],
    ["an array record", []],
    ["an empty parent ID", { parentID: "" }],
    ["a non-string parent ID", { parentID: 42 }],
  ] as const)("suppresses %s", async (_name, sessionMetadata) => {
    const server = usageServer()
    cleanups.push(server.stop)
    const dirs = await classifierDirs()
    await writeGlobalSettings(dirs, { model: "openai/gpt-5.5-codex" })
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    let catalogReads = 0
    const harness = makeApi({
      sessionModelProviderID: "openai",
      sessionMetadata,
      paths: dirs,
      onProviderCatalogRead: () => {
        catalogReads += 1
      },
    })
    await load(harness, codexEndpoint(server.url))
    harness.emit("session.idle", { sessionID: "ses_1" })
    await harness.waitForQuiescence()
    expect(server.requests).toHaveLength(0)
    expect(catalogReads).toBe(0)
  })

  test("a classifier on the session's own provider adds no second poll", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    const dirs = await classifierDirs()
    await writeGlobalSettings(dirs, { model: "openai/gpt-5.5-codex" })
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({ sessionModelProviderID: "openai", paths: dirs })
    await load(harness, codexEndpoint(server.url))
    await until(() => server.requests.length >= 1)
    await harness.waitForQuiescence()
    // One fetch serves both roles: the provider set is deduplicated.
    expect(server.requests).toHaveLength(1)
  })

  test("an explicit follow-session record suppresses an inherited classifier pin", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    const dirs = await classifierDirs()
    await writeGlobalSettings(dirs, { model: "openai/gpt-5.5-codex" })
    await writeSessionModel(
      sessionModelFile(sessionModelDirectory(dirs.state), "ses_1"),
      {
        version: 1,
        rootSessionID: "ses_1",
        revision: "rev_1",
        mode: "override",
        model: null,
        variant: null,
      },
    )
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({
      sessionModelProviderID: "anthropic",
      paths: dirs,
    })
    await load(harness, codexEndpoint(server.url))
    await harness.waitForQuiescence()
    expect(server.requests).toHaveLength(0)
  })

  test("does not poll a classifier model absent from the viewed root's provider catalog", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    const dirs = await classifierDirs()
    await writeGlobalSettings(dirs, { model: "openai/gpt-5.5-codex" })
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({
      sessionModelProviderID: "anthropic",
      paths: dirs,
      providers: [{ id: "openai", models: {} }],
    })
    await load(harness, codexEndpoint(server.url))
    await harness.waitForQuiescence()
    expect(server.requests).toHaveLength(0)
  })
})

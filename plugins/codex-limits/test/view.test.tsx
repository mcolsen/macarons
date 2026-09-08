import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
// Fixture-only: the entry name approve-for-me recognizes in the host's
// config, and its activity writer for the server-half beacon the interop
// gates on; the runtime interop stays the ./interop entrypoint alone.
import {
  activityFile,
  PLUGIN_PACKAGE_NAME,
  sessionModelDirectory,
  sessionModelFile,
  writeActivity,
  writeSessionModel,
} from "@macarons/approve-for-me/shared"
import { flush, until } from "@macarons/plugin-test-harness"
import {
  createSlotMounter,
  type RenderSetup,
} from "@macarons/plugin-test-harness/view"
import { RGBA } from "@opentui/core"
import { INSTANCE_ID, makeApi as makeHarness } from "./harness"

// WP9 — no-view-test + gate-effect-untested. The sidebar View (src/tui.tsx
// 303-408) never executes in the engine tests, which assert only that
// `sidebar_content` is a function. This file mounts the registered slot under
// @opentui/solid's headless renderer (the package bunfig preloads the real
// solid transform) and asserts on captured char frames AND per-span
// foreground colours — the only surface that pins percentColor's thresholds,
// the `100 - usedPercent` remaining inversion, the "· classifier" tag, the
// resetsAt-undefined branch, the rendered() available()-but-empty filter, the
// parentID sub-agent suppression, and the effect's reactive status sampling.

// Distinct, unmistakable channels so a span's fg pins which percentColor arm
// ran. Passed through the harness's theme input so the colour assertions pin
// these exact values rather than tracking the core mock's defaults.
const THEME = {
  text: "#e0e0e0",
  textMuted: "#808080",
  warning: "#ffcc00",
  error: "#ff0000",
}
const asInts = (hex: string) => RGBA.fromHex(hex).toInts()

const OAUTH_RECORD = {
  openai: {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 3_600_000,
    accountId: "acct-1",
  },
}

/** A ChatGPT usage body; each window's used_percent and reset are overridable. */
function usageBody(
  over: {
    primary?: Record<string, unknown> | null
    secondary?: Record<string, unknown> | null
  } = {},
) {
  const primary =
    over.primary === null
      ? undefined
      : {
          used_percent: 42,
          limit_window_seconds: 18_000, // 5h
          reset_at: Math.floor(Date.now() / 1000) + 9_000,
          ...over.primary,
        }
  const secondary =
    over.secondary === null
      ? undefined
      : {
          used_percent: 21,
          limit_window_seconds: 604_800, // 7d
          reset_at: Math.floor(Date.now() / 1000) + 400_000,
          ...over.secondary,
        }
  const rate_limit: Record<string, unknown> = {}
  if (primary) rate_limit.primary_window = primary
  if (secondary) rate_limit.secondary_window = secondary
  return { plan_type: "plus", rate_limit }
}

// The shared mock with the status signal live: the gate-effect test drives
// setSessionStatus after mount to isolate the effect's reactive
// feedRetryStatus sampling from the tick delivery.
function makeApi(
  input: {
    routeSessionID?: string
    sessionModelProviderID?: string
    parentID?: unknown
    sessionMetadata?:
      | "missing"
      | "throwing"
      | { parentID?: unknown }
      | readonly unknown[]
    paths?: {
      config: string
      state: string
      directory: string
      worktree?: string
    }
    onProviderCatalogRead?: () => void
  } = {},
) {
  return makeHarness({ ...input, theme: THEME, reactiveStatus: true })
}

function usageServer(
  handler?: (request: Request) => Response | Promise<Response>,
) {
  const requests: { url: string }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push({ url: request.url })
      return handler ? handler(request) : Response.json(usageBody())
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/wham/usage`,
    requests,
    stop: () => server.stop(true),
  }
}

const codexEndpoint = (url: string) => ({
  providers: { openai: { endpoint: url } },
})

const mountSlot = createSlotMounter({ width: 60, height: 16 })

const cleanups: Array<() => void | Promise<void>> = []
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT
const originalDataHome = process.env.XDG_DATA_HOME

beforeEach(() => {
  process.env.XDG_DATA_HOME = "/nonexistent/codex-limits-view"
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  if (originalAuthContent === undefined)
    delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuthContent
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalDataHome
})

async function load(
  harness: ReturnType<typeof makeApi>,
  options?: Record<string, unknown>,
) {
  await harness.load(options)
  cleanups.push(harness.dispose)
}

/** Mount the registered sidebar_content slot for one session. */
async function mount(harness: ReturnType<typeof makeApi>, sessionID = "ses_1") {
  return mountSlot(harness, { sessionID })
}

/**
 * Mount, then wait for the codex round-trip to the loopback server to land and
 * its snapshot signal to reach the view. `waitForFrame` alone advances render
 * passes without real time, so the async fetch never completes inside it — the
 * request count is the real settle signal.
 */
async function mountAfterFetch(
  harness: ReturnType<typeof makeApi>,
  server: ReturnType<typeof usageServer>,
  sessionID = "ses_1",
) {
  const view = await mount(harness, sessionID)
  await until(() => server.requests.length >= 1)
  await flush()
  await view.renderOnce()
  return view
}

/** The fg of the first captured span whose text contains `needle`. */
function spanFg(
  view: RenderSetup,
  needle: string,
): [number, number, number, number] {
  for (const line of view.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return span.fg.toInts()
    }
  }
  throw new Error(`no span containing ${JSON.stringify(needle)}`)
}

describe("sidebar view", () => {
  test.each(["reconnect", "directory", "workspace"])(
    "recovers reactively after %s invalidates the auth scope",
    async (change) => {
      let usedPercent = 42
      const server = usageServer(() =>
        Response.json(usageBody({ primary: { used_percent: usedPercent } })),
      )
      cleanups.push(server.stop)
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
      const harness = makeApi({ sessionModelProviderID: "openai" })
      await load(harness, codexEndpoint(server.url))
      const view = await mountAfterFetch(harness, server)
      expect(view.captureCharFrame()).toContain("5h 58% left")

      // Hold fresh proof so recovery cannot race the hidden-state frame.
      const authRequested = Promise.withResolvers<void>()
      const serverAuth = Promise.withResolvers<typeof OAUTH_RECORD>()
      harness.setServerAuth(() => {
        authRequested.resolve()
        return serverAuth.promise
      })
      try {
        usedPercent = 17
        if (change === "reconnect") harness.emit("server.connected", {})
        if (change === "directory")
          harness.setSessionMetadata({ directory: "/other-project" })
        if (change === "workspace")
          harness.setSessionMetadata({ workspaceID: "wrk_other" })
        harness.emit("session.idle", { sessionID: "ses_1" })
        await authRequested.promise
        await flush()
        await view.renderOnce()
        expect(view.captureCharFrame()).not.toContain("Codex Limits")

        serverAuth.resolve(OAUTH_RECORD)
        await harness.waitForQuiescence()
        await flush()
        await view.renderOnce()
        expect(view.captureCharFrame()).toContain("5h 83% left")
      } finally {
        serverAuth.resolve(OAUTH_RECORD)
      }
    },
  )

  test("renders nothing when an available provider has no windows", async () => {
    const server = usageServer(() => Response.json({ rate_limit: {} }))
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({ sessionModelProviderID: "openai" })
    await load(harness, codexEndpoint(server.url))
    const view = await mountAfterFetch(harness, server)
    expect(view.captureCharFrame()).not.toContain("Codex Limits")
  })

  test("gauge colour tracks used%, the row shows remaining, and a reset suffix", async () => {
    const server = usageServer(() =>
      Response.json(
        usageBody({
          primary: { used_percent: 95 }, // exhausted → error
          secondary: { used_percent: 74 }, // comfortable → muted
        }),
      ),
    )
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({ sessionModelProviderID: "openai" })
    await load(harness, codexEndpoint(server.url))
    const view = await mountAfterFetch(harness, server)
    const frame = view.captureCharFrame()

    // The row counts DOWN — 95% used renders "5% left", not "95% left".
    expect(frame).toContain("5h 5% left")
    expect(frame).toContain("7d 26% left")
    // reset_at present → the "· resets" suffix renders.
    expect(frame).toContain("resets")
    // The active section carries no classifier tag.
    expect(frame).not.toContain("classifier")

    // percentColor: >= 95 is error, < 75 is muted. The exact 95 boundary pins
    // `>= 95` against `> 95`, and the colour choice against an error↔warning
    // swap.
    expect(spanFg(view, "5h 5% left")).toEqual(asInts(THEME.error))
    expect(spanFg(view, "7d 26% left")).toEqual(asInts(THEME.textMuted))
  })

  test("the 75% boundary picks the warning colour", async () => {
    const server = usageServer(() =>
      Response.json(
        usageBody({ primary: { used_percent: 75 }, secondary: null }),
      ),
    )
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({ sessionModelProviderID: "openai" })
    await load(harness, codexEndpoint(server.url))
    const view = await mountAfterFetch(harness, server)
    expect(view.captureCharFrame()).toContain("5h 25% left")
    // Exactly 75 pins `>= 75` against `> 75`.
    expect(spanFg(view, "5h 25% left")).toEqual(asInts(THEME.warning))
  })

  test("omits the reset suffix when the provider sends no reset time", async () => {
    const server = usageServer(() =>
      Response.json(
        usageBody({
          primary: { used_percent: 40, reset_at: undefined },
          secondary: null,
        }),
      ),
    )
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({ sessionModelProviderID: "openai" })
    await load(harness, codexEndpoint(server.url))
    const view = await mountAfterFetch(harness, server)
    const frame = view.captureCharFrame()
    expect(frame).toContain("5h 60% left")
    // A row with no reset must not print a "· resets Invalid Date" suffix.
    expect(frame).not.toContain("resets")
  })

  test.each([
    ["missing", "missing"],
    ["throwing", "throwing"],
    ["an array record", []],
    ["an empty parent ID", { parentID: "" }],
    ["a non-string parent ID", { parentID: 42 }],
  ] as const)(
    "hides live sections when session metadata is %s",
    async (_name, sessionMetadata) => {
      const server = usageServer()
      cleanups.push(server.stop)
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
      const harness = makeApi({ sessionModelProviderID: "openai" })
      await load(harness, codexEndpoint(server.url))
      const view = await mountAfterFetch(harness, server)
      expect(view.captureCharFrame()).toContain("Codex Limits")

      harness.setSessionMetadata(sessionMetadata)
      await flush()
      await view.renderOnce()
      expect(view.captureCharFrame()).not.toContain("Codex Limits")
    },
  )

  test("recovers after missing session metadata appears", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({
      sessionModelProviderID: "openai",
      sessionMetadata: "missing",
    })
    await load(harness, codexEndpoint(server.url))
    const view = await mount(harness)
    await flush()
    await view.renderOnce()
    expect(view.captureCharFrame()).not.toContain("Codex Limits")
    expect(server.requests).toHaveLength(0)

    harness.setSessionMetadata({})
    await until(() => server.requests.length >= 1)
    await flush()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("5h 58% left")
  })

  test("keeps rendering when session messages vanish during rendering", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({
      sessionModelProviderID: "openai",
    })
    await load(harness, codexEndpoint(server.url))
    const view = await mountAfterFetch(harness, server)
    harness.setMessagesThrow(true)
    harness.setSessionMetadata({})
    await flush()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Codex Limits")
  })

  test("renders after the session switches to a Fast model", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({ sessionModelProviderID: "anthropic" })
    await load(harness, codexEndpoint(server.url))
    const view = await mount(harness)
    await flush()
    await view.renderOnce()
    expect(view.captureCharFrame()).not.toContain("Codex Limits")

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
    await flush()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("Codex Limits")

    harness.emit("session.updated", {
      info: {
        id: "ses_1",
        model: { id: "claude-sonnet-4-20250514", providerID: "anthropic" },
      },
    })
    await flush()
    await view.renderOnce()
    expect(view.captureCharFrame()).not.toContain("Codex Limits")
  })

  test("renders nothing for a sub-agent session even with live data", async () => {
    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({
      sessionModelProviderID: "openai",
      parentID: "ses_parent",
    })
    await load(harness, codexEndpoint(server.url))
    const view = await mount(harness)
    await flush()
    await view.renderOnce()
    expect(view.captureCharFrame()).not.toContain("Codex Limits")
    expect(server.requests).toHaveLength(0)
  })
})

describe("classifier section", () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function classifierDirs() {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), "codex-limits-view-classifier-"),
    )
    const made = {
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      directory: path.join(root, "project"),
    }
    await Promise.all(
      Object.values(made).map((dir) => fs.mkdir(dir, { recursive: true })),
    )
    // Canonical paths, the project doubling as the worktree, exactly like
    // the tui.test.ts classifier fixtures.
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

  test("a classifier-pinned provider renders under a '· classifier' tag", async () => {
    const dirs = await classifierDirs()
    // The global settings layer as approve-for-me reads it since its PR
    // #139: that plugin's entry options in the host's own opencode.json.
    await fs.writeFile(
      path.join(dirs.config, "opencode.json"),
      JSON.stringify({
        plugin: [[PLUGIN_PACKAGE_NAME, { model: "openai/gpt-5.5-codex" }]],
      }),
    )

    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    // The viewed session runs on a provider this build has no module for, so
    // codex (openai) is relevant ONLY as the classifier.
    const harness = makeApi({
      sessionModelProviderID: "anthropic",
      paths: dirs,
    })
    await load(harness, codexEndpoint(server.url))
    const view = await mountAfterFetch(harness, server)
    const frame = view.captureCharFrame()
    expect(frame).toContain("Codex Limits")
    // Dropping the tag span leaves the section indistinguishable from the
    // session's own provider section.
    expect(frame).toContain("classifier")
  })

  test("refreshes for the newly viewed root without waiting for the poll interval", async () => {
    const dirs = await classifierDirs()
    await fs.writeFile(
      path.join(dirs.config, "opencode.json"),
      JSON.stringify({
        plugin: [[PLUGIN_PACKAGE_NAME, { model: "openai/gpt-5.5-codex" }]],
      }),
    )
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
    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({
      routeSessionID: "ses_1",
      sessionModelProviderID: "anthropic",
      paths: dirs,
    })
    await load(harness, codexEndpoint(server.url))
    await mount(harness)
    await harness.waitForQuiescence()
    expect(server.requests).toHaveLength(0)

    harness.setRouteSession("ses_2")
    await mountAfterFetch(harness, server, "ses_2")
  })

  test("a slow result for the previous root cannot restore its classifier", async () => {
    const dirs = await classifierDirs()
    await fs.writeFile(
      path.join(dirs.config, "opencode.json"),
      JSON.stringify({
        plugin: [[PLUGIN_PACKAGE_NAME, { model: "openai/gpt-5.5-codex" }]],
      }),
    )
    await writeSessionModel(
      sessionModelFile(sessionModelDirectory(dirs.state), "ses_2"),
      {
        version: 1,
        rootSessionID: "ses_2",
        revision: "rev_1",
        mode: "override",
        model: null,
        variant: null,
      },
    )
    const server = usageServer()
    cleanups.push(server.stop)
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH_RECORD)
    const harness = makeApi({
      routeSessionID: "ses_1",
      sessionModelProviderID: "anthropic",
      paths: dirs,
    })
    await load(harness, codexEndpoint(server.url))
    await mount(harness)
    // The first root inherits the pin. Switch before its asynchronous disk
    // reads settle; the second root follows its session and has no section.
    harness.setRouteSession("ses_2")
    await mount(harness, "ses_2")
    await harness.waitForQuiescence()
    expect(server.requests).toHaveLength(0)
  })

  test("a missing session view does not resolve a classifier against its ID", async () => {
    const dirs = await classifierDirs()
    await fs.writeFile(
      path.join(dirs.config, "opencode.json"),
      JSON.stringify({
        plugin: [[PLUGIN_PACKAGE_NAME, { model: "openai/gpt-5.5-codex" }]],
      }),
    )
    let catalogReads = 0
    const harness = makeApi({
      sessionMetadata: "missing",
      paths: dirs,
      onProviderCatalogRead: () => {
        catalogReads += 1
      },
    })
    await load(harness)
    await mount(harness)
    await harness.waitForQuiescence()
    expect(catalogReads).toBe(0)
  })

  test("a sub-agent view does not resolve a classifier against its child ID", async () => {
    const dirs = await classifierDirs()
    await fs.writeFile(
      path.join(dirs.config, "opencode.json"),
      JSON.stringify({
        plugin: [[PLUGIN_PACKAGE_NAME, { model: "openai/gpt-5.5-codex" }]],
      }),
    )
    let catalogReads = 0
    const harness = makeApi({
      parentID: "ses_root",
      paths: dirs,
      onProviderCatalogRead: () => {
        catalogReads += 1
      },
    })
    await load(harness)
    await mount(harness)
    await harness.waitForQuiescence()
    expect(catalogReads).toBe(0)
  })
})

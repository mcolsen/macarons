import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readRefreshedAuthStore } from "@macarons/permission-rules"
import { makeTuiApi } from "@macarons/plugin-test-harness/tui"
import type { ProviderContext } from "@macarons/usage-limits"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
import { createAuthScopeResponder, scopedCodexModule } from "../src/auth-scope"

const OAUTH = {
  openai: {
    type: "oauth",
    access: "local-access",
    refresh: "local-refresh",
    accountId: "local-account",
    expires: 9999999999999,
  },
}
const OTHER = {
  openai: {
    ...OAUTH.openai,
    access: "server-access",
    accountId: "server-account",
  },
}
const usage = () =>
  Response.json({
    rate_limit: {
      primary_window: { used_percent: 42, limit_window_seconds: 18000 },
    },
  })
const cleanups: Array<() => void | Promise<void>> = []
const originalAuth = process.env.OPENCODE_AUTH_CONTENT
const originalData = process.env.XDG_DATA_HOME

beforeEach(() => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(OAUTH)
  process.env.XDG_DATA_HOME = "/nonexistent/codex-auth-scope-test"
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  if (originalAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuth
  if (originalData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalData
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(
  input: {
    read?: () => Promise<unknown>
    fetcher?: ProviderContext["fetcher"]
  } = {},
) {
  const h = makeTuiApi({
    baseUrl: "http://127.0.0.1:4096",
    paths: { directory: "/project", config: "/config", state: "/state" },
  })
  let serverStore: unknown = OAUTH
  const commands: string[] = []
  const requests: RequestInit[] = []
  const controller = new AbortController()
  const respond = createAuthScopeResponder({
    readAuthStore: input.read ?? (async () => serverStore),
    signal: controller.signal,
    publish: async (command) => {
      commands.push(command)
      h.emit("tui.command.execute", { command })
    },
  })
  const publishes: Array<{
    directory?: string
    workspace?: string
    body: { type: string; properties: { command: string } }
  }> = []
  h.api.client.tui = {
    publish: async (parameters: (typeof publishes)[number]) => {
      publishes.push(parameters)
      // The HTTP acknowledgement is separate from event delivery.
      void respond(parameters.body)
      return { data: true }
    },
  }
  const instance = scopedCodexModule(h.api as unknown as TuiPluginApi).create({
    readAuthStore: async () => {
      throw new Error("must not use an unverified engine reader")
    },
    fetcher: async (url, init) => {
      requests.push(init)
      return input.fetcher ? input.fetcher(url, init) : usage()
    },
    userAgent: "opencode/test",
    options: {},
    provider: () => undefined,
    intervalMs: 60_000,
    disposeSignal: h.api.lifecycle.signal,
    createSignal,
  })
  cleanups.push(async () => {
    controller.abort()
    await h.dispose()
  })
  return {
    ...h,
    instance,
    requests,
    commands,
    publishes,
    setServerStore: (value: unknown) => {
      serverStore = value
    },
  }
}

describe("server-scoped Codex identity", () => {
  test("proves the full credential before fetching and never sends it over the bus", async () => {
    const h = fixture()
    await h.instance.refresh(true)
    expect(h.requests).toHaveLength(1)
    expect(h.instance.snapshot()?.windows[0]?.usedPercent).toBe(42)
    expect(h.commands).toHaveLength(2)
    expect(h.commands[0]).not.toBe(h.commands[1])
    expect(
      JSON.stringify(h.publishes) + JSON.stringify(h.commands),
    ).not.toMatch(/local-access|local-refresh|local-account/)
  })

  test.each([
    ["API key", { openai: { type: "api", key: "server-key" } }],
    ["other OAuth account", OTHER],
    [
      "same token with another account header",
      { openai: { ...OAUTH.openai, accountId: "other-account" } },
    ],
    [
      "unknown identities with different tokens",
      {
        openai: {
          ...OAUTH.openai,
          access: "other-token",
          accountId: undefined,
        },
      },
    ],
  ])("hides quota for server %s", async (_name, store) => {
    const h = fixture()
    h.setServerStore(store)
    await h.instance.refresh(true)
    expect(h.requests).toHaveLength(0)
    expect(h.instance.available()).toBe(false)
    expect(h.instance.snapshot()).toBeUndefined()
  })

  test.each([
    "data directories",
    "users",
    "container mounts",
    "SSH tunnel targets",
  ])(
    "does not infer shared auth from loopback and matching paths across separate %s",
    async (kind) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-scope-"))
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
      const localHome = path.join(root, "tui")
      const serverHome = path.join(root, "server")
      const localData =
        kind === "users" ? path.join(localHome, ".local", "share") : localHome
      const serverData =
        kind === "users" ? path.join(serverHome, ".local", "share") : serverHome
      await fs.mkdir(path.join(localData, "opencode"), { recursive: true })
      await fs.mkdir(path.join(serverData, "opencode"), { recursive: true })
      await fs.writeFile(
        path.join(localData, "opencode", "auth.json"),
        JSON.stringify(OAUTH),
      )
      await fs.writeFile(
        path.join(serverData, "opencode", "auth.json"),
        JSON.stringify(OTHER),
      )
      delete process.env.OPENCODE_AUTH_CONTENT
      process.env.XDG_DATA_HOME = localData
      const h = fixture({
        read: () =>
          readRefreshedAuthStore({
            env: kind === "users" ? {} : { XDG_DATA_HOME: serverData },
            homedir: serverHome,
          }),
      })
      await h.instance.refresh(true)
      expect(h.requests).toHaveLength(0)
      expect(h.instance.snapshot()).toBeUndefined()
    },
  )

  test("an authoritative server inline snapshot overrides a matching file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-inline-"))
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
    await fs.mkdir(path.join(root, "opencode"))
    await fs.writeFile(
      path.join(root, "opencode", "auth.json"),
      JSON.stringify(OAUTH),
    )
    const h = fixture({
      read: () =>
        readRefreshedAuthStore({
          env: {
            XDG_DATA_HOME: root,
            OPENCODE_AUTH_CONTENT: JSON.stringify(OTHER),
          },
          homedir: root,
        }),
    })
    await h.instance.refresh(true)
    expect(h.requests).toHaveLength(0)
  })

  test("routes proof to the viewed workspace, not the control server's auth", async () => {
    const h = fixture()
    h.api.state.session.get = () => ({
      id: "ses_1",
      directory: "/workspace",
      workspaceID: "wrk_1",
    })
    await h.instance.refresh(true)
    expect(h.publishes[0]?.directory).toBe("/workspace")
    expect(h.publishes[0]?.workspace).toBe("wrk_1")
  })

  test("loss of server proof hides existing quota even through a direct view refresh", async () => {
    const h = fixture()
    await h.instance.refresh(true)
    expect(h.instance.snapshot()).toBeDefined()
    h.setServerStore(OTHER)
    await h.instance.refresh(true)
    expect(h.instance.available()).toBe(false)
    expect(h.instance.snapshot()).toBeUndefined()
    expect(h.requests).toHaveLength(1)
  })

  test("a server auth switch during usage I/O cannot restore old quota", async () => {
    const started = deferred<void>()
    const response = deferred<Response>()
    const h = fixture({
      fetcher: () => {
        started.resolve()
        return response.promise
      },
    })
    const refresh = h.instance.refresh(true)
    await started.promise
    h.setServerStore(OTHER)
    response.resolve(usage())
    await refresh
    expect(h.instance.snapshot()).toBeUndefined()
  })

  test("reconnect clears quota synchronously even when the new server uses identical tokens", async () => {
    const h = fixture()
    await h.instance.refresh(true)
    expect(h.instance.snapshot()).toBeDefined()
    h.emit("server.connected", {})
    expect(h.instance.available()).toBe(false)
    expect(h.instance.snapshot()).toBeUndefined()
    await h.instance.refresh(false)
    expect(h.requests).toHaveLength(2)
    expect(h.instance.snapshot()).toBeDefined()
  })

  test("a pending proof from before reconnect cannot authorize a usage read", async () => {
    const started = deferred<void>()
    const old = deferred<unknown>()
    const h = fixture({
      read: () => {
        started.resolve()
        return old.promise
      },
    })
    const refresh = h.instance.refresh(true)
    await started.promise
    h.emit("server.connected", {})
    old.resolve(OAUTH)
    await refresh
    expect(h.requests).toHaveLength(0)
    expect(h.instance.snapshot()).toBeUndefined()
  })

  test.each(["client", "directory", "workspace"])(
    "changing the %s hides old quota before the next tick",
    async (field) => {
      const h = fixture()
      await h.instance.refresh(true)
      expect(h.instance.snapshot()).toBeDefined()
      if (field === "client") h.api.client = { ...h.api.client }
      if (field === "directory") h.api.state.path.directory = "/elsewhere"
      if (field === "workspace")
        h.api.state.session.get = () => ({
          id: "ses_1",
          workspaceID: "wrk_other",
        })
      expect(h.instance.available()).toBe(false)
      expect(h.instance.snapshot()).toBeUndefined()
      h.setServerStore(OTHER)
      await h.instance.refresh(true)
      expect(h.requests).toHaveLength(1)
    },
  )

  test("disposal cancels pending proof and removes temporary listeners", async () => {
    const started = deferred<void>()
    const old = deferred<unknown>()
    const h = fixture({
      read: () => {
        started.resolve()
        return old.promise
      },
    })
    const refresh = h.instance.refresh(true)
    await started.promise
    await h.dispose()
    old.resolve(OAUTH)
    await refresh
    expect(h.requests).toHaveLength(0)
    expect(h.handlers.get("tui.command.execute")).toHaveLength(0)
  })

  test("HTTP success, stale replies and malformed messages are not proof", async () => {
    const h = fixture()
    await h.instance.refresh(true)
    const stale = h.commands[0]
    h.api.client.tui.publish = async () => {
      h.emit("tui.command.execute", { command: stale })
      h.emit("tui.command.execute", { command: 42 })
      return { data: true }
    }
    // Shorten only the production proof deadline; no live host/provider involved.
    const original = globalThis.setTimeout
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => original(fn, ms === 3000 ? 10 : ms, ...args)) as typeof setTimeout
    try {
      await h.instance.refresh(true)
    } finally {
      globalThis.setTimeout = original
    }
    expect(h.instance.snapshot()).toBeUndefined()
    expect(h.requests).toHaveLength(1)
    expect(h.handlers.get("tui.command.execute")).toHaveLength(0)
  })
})

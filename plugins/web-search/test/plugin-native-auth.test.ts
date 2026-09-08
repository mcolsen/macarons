import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import type { Plugin } from "@opencode-ai/plugin"
import { WebSearchPlugin } from "../src/index"

/**
 * The PRODUCTION credential wiring, driven through the real factory.
 *
 * Every other native-backend test injects an `AuthStoreReader` stand-in
 * straight into `loadResolutions`, which is the right seam for resolver
 * behavior but means none of them execute the one line that supplies the real
 * reader: the `readRefreshedAuthStore({ env: process.env, homedir:
 * os.homedir() })` closure `WebSearchPlugin` hands `createNativeBackend`
 * (src/index.ts) — the environment read AND the refresh repair. Nor
 * could the e2e suite catch it — every sandbox sets `OPENCODE_AUTH_CONTENT`
 * to an empty store, so a native search there has no credentials either way.
 * Replacing that closure with `async () => ({})` therefore used to leave the
 * whole suite green. These tests boot the factory itself and assert the
 * credentials reached the wire, once per half of the reader: the inline
 * override a control-plane workspace arrives with, and the auth.json the
 * environment's data dir names.
 *
 * `globalThis.fetch` is replaced rather than pointing a base URL at a local
 * server: the ChatGPT and Copilot resolutions carry their provider's public
 * base URL by construction (auth.ts), so a stub is the only interception that
 * cannot reach the real endpoint even if the wiring regresses. It refuses any
 * host it was not told to expect, so a credential can never leave this
 * process. Credentials are synthetic and the ambient environment is pointed at
 * nothing, so the developer's own auth.json is unreachable here too.
 */

const originalDataHome = process.env.XDG_DATA_HOME
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT
const realFetch = globalThis.fetch

type Captured = { url: string; headers: Headers; body: unknown }
let captured: Captured[] = []

/** The ChatGPT backend only streams; two events are a complete answer. */
const CHATGPT_SSE = [
  `event: response.output_text.delta\ndata: {"delta":"Aurora tonight."}\n\n`,
  `event: response.completed\ndata: {}\n\n`,
].join("")

const COPILOT_PAYLOAD = {
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: "Copilot answered." }],
    },
  ],
}

const ALLOWED = new Map<string, () => Response>([
  [
    "https://chatgpt.com/backend-api/codex/responses",
    () =>
      new Response(CHATGPT_SSE, {
        headers: { "Content-Type": "text/event-stream" },
      }),
  ],
  [
    "https://api.githubcopilot.com/responses",
    () => Response.json(COPILOT_PAYLOAD),
  ],
])

beforeAll(() => {
  // No ambient file, and no ambient inline store: each test names the one it
  // means to be read.
  process.env.XDG_DATA_HOME = "/nonexistent/websearch-plugin-auth-test"
  delete process.env.OPENCODE_AUTH_CONTENT
  globalThis.fetch = (async (
    input: unknown,
    init?: { headers?: Record<string, string>; body?: unknown },
  ): Promise<Response> => {
    // Every native adapter passes a plain string URL; `String` also renders a
    // URL faithfully, so the stub never has to reach for a DOM type.
    const url = String(input)
    captured.push({
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    const respond = ALLOWED.get(url)
    // A regression that resolved some OTHER provider's credentials would show
    // up here as an unexpected host rather than as a silent request.
    if (!respond) throw new Error(`unexpected request to ${url}`)
    return respond()
  }) as unknown as typeof globalThis.fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalDataHome
  if (originalAuthContent === undefined)
    delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuthContent
})

afterEach(() => {
  captured = []
  delete process.env.OPENCODE_AUTH_CONTENT
  process.env.XDG_DATA_HOME = "/nonexistent/websearch-plugin-auth-test"
})

function stubClient(
  providers: unknown[],
  active: { providerID: string; modelID: string },
) {
  return {
    global: { health: async () => ({ data: { version: BAND.floor } }) },
    app: { log: async () => ({}) },
    config: { providers: async () => ({ data: { providers } }) },
    path: { get: async () => ({ data: {} }) },
    session: {
      message: async () => ({
        data: {
          info: {
            id: "msg_1",
            sessionID: "ses_auth",
            role: "assistant",
            ...active,
          },
          parts: [],
        },
      }),
    },
    tui: { showToast: async () => ({ data: true }) },
  }
}

/**
 * Boots the factory with a native-only chain by default, supplies the
 * executing assistant's model through the host, and runs one search.
 */
async function nativeSearch(
  providers: unknown[],
  active: { providerID: string; modelID: string },
  options: Record<string, unknown> = { order: ["native"] },
): Promise<{ title?: string; output: string; metadata?: unknown }> {
  const hooks = await (WebSearchPlugin as Plugin)(
    {
      client: stubClient(providers, active),
      directory: "/project",
      worktree: "/project",
      serverUrl: new URL("http://opencode.internal"),
    } as never,
    options,
  )
  const tool = (hooks.tool as Record<string, unknown>).web_search as {
    execute: (
      args: Record<string, unknown>,
      ctx: unknown,
    ) => Promise<{ title?: string; output: string; metadata?: unknown }>
  }
  return tool.execute(
    { query: "aurora forecast" },
    {
      sessionID: "ses_auth",
      messageID: "msg_1",
      agent: "build",
      directory: "/project",
      worktree: "/project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    },
  )
}

describe("the factory's own auth reader reaches the wire", () => {
  for (const providerID of ["openai", "github-copilot"]) {
    test.each([false, true])(
      `${providerID} never forwards keyless gateway headers through OAuth (locked: %j)`,
      async (locked) => {
        process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
          [providerID]: {
            type: "oauth",
            access: "synthetic-oauth-access",
            refresh: "synthetic-oauth-refresh",
            expires: Date.now() + 3_600_000,
          },
        })
        const result = await nativeSearch(
          [
            {
              id: providerID,
              key: "synthetic-stored-key",
              options: {
                apiKey:
                  providerID === "openai" ? "opencode-oauth-dummy-key" : "",
                baseURL: "https://native-gateway.example/v1",
                headers: { "x-gateway-auth": "synthetic-gateway-secret" },
              },
              models: {
                search: {
                  id: "search",
                  headers: { "x-tenant": "synthetic-gateway-tenant" },
                  options: locked ? { websearch: "always" } : {},
                },
              },
            },
          ],
          { providerID, modelID: "search" },
        )
        expect(result.output).toContain("native: unavailable")
        expect(captured).toEqual([])
        expect(JSON.stringify(result)).not.toContain("synthetic-gateway")
      },
    )
  }

  for (const source of ["provider", "model"]) {
    test.each([
      {
        kind: "value",
        name: "x-gateway-auth",
        value: "synthetic-header-secret\nnext",
      },
      {
        kind: "name",
        name: "synthetic invalid header",
        value: "synthetic-header-secret",
      },
    ])(
      `invalid ${source} header $kind fails without exposing credentials`,
      async ({ name, value }) => {
        const headers = { [name]: value }
        const result = await nativeSearch(
          [
            {
              id: "openai",
              key: "synthetic-api-key",
              options: {
                baseURL: "https://native-gateway.example/v1",
                ...(source === "provider" ? { headers } : {}),
              },
              models: {
                search: {
                  id: "search",
                  ...(source === "model" ? { headers } : {}),
                  options: {},
                },
              },
            },
          ],
          { providerID: "openai", modelID: "search" },
        )
        expect(captured).toEqual([])
        expect(result.output).toContain("invalid native request headers")
        expect(result.metadata).toMatchObject({
          attempts: [
            {
              backend: "native",
              kind: "error",
              reason: "openai/search: invalid native request headers",
            },
          ],
        })
        expect(JSON.stringify(result)).not.toContain("synthetic-header-secret")
        expect(JSON.stringify(result)).not.toContain(name)
      },
    )
  }

  test.each(["openai", "github-copilot"])(
    "%s OAuth replacement keeps provider and headers-only model configuration",
    async (providerID) => {
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
        [providerID]: {
          type: "oauth",
          access: "synthetic-oauth-access",
          refresh: "synthetic-oauth-refresh",
          expires: Date.now() + 3_600_000,
          accountId: "synthetic-oauth-account",
        },
      })
      const result = await nativeSearch(
        [
          {
            id: providerID,
            options: {
              apiKey: providerID === "openai" ? "opencode-oauth-dummy-key" : "",
              headers: {
                "x-gateway-auth": "synthetic-provider-auth",
                "X-Tenant": "wrong-provider-tenant",
                Authorization: "Bearer wrong-provider-token",
              },
            },
            models: {
              search: {
                id: "search",
                headers: {
                  "x-tenant": "synthetic-model-tenant",
                  authorization: "Bearer wrong-model-token",
                },
                options: {},
              },
              chat: {
                id: "chat",
                headers: { "x-tenant": "wrong-chat-tenant" },
                options: {},
              },
            },
          },
        ],
        { providerID, modelID: "search" },
      )
      expect(result.metadata).toMatchObject({ backend: "native" })
      expect(captured).toHaveLength(1)
      expect(captured[0]?.headers.get("x-gateway-auth")).toBe(
        "synthetic-provider-auth",
      )
      expect(captured[0]?.headers.get("x-tenant")).toBe(
        "synthetic-model-tenant",
      )
      expect(captured[0]?.headers.get("authorization")).toBe(
        providerID === "openai"
          ? "Bearer synthetic-oauth-access"
          : "Bearer synthetic-oauth-refresh",
      )
      expect(captured[0]?.body).toMatchObject({ model: "search" })
      expect(JSON.stringify(result)).not.toContain("synthetic-provider-auth")
      expect(JSON.stringify(result)).not.toContain("synthetic-model-tenant")
    },
  )

  test.each([
    { shape: "plain", host: undefined },
    { shape: "placeholder-like", host: undefined },
    { shape: "placeholder-like", host: "gw.example" },
  ])(
    "endpoint errors cannot leak a $shape query credential (host: $host)",
    async ({ shape, host }) => {
      const credentialName = "WEBS_TEST_QUERY_CREDENTIAL"
      const hostName = "WEBS_TEST_UNRESOLVED_HOST"
      const credential = "synthetic-query-credential"
      const previousCredential = process.env[credentialName]
      const previousHost = process.env[hostName]
      process.env[credentialName] =
        shape === "plain" ? credential : `\${${credential}}`
      if (host === undefined) delete process.env[hostName]
      else process.env[hostName] = host
      try {
        const result = await nativeSearch(
          [
            {
              id: "synthetic-openai",
              key: "synthetic-api-key",
              options: {},
              models: {
                "synthetic-model": {
                  id: "synthetic-model",
                  api: {
                    npm: "@ai-sdk/openai",
                    url: `https://\${${hostName}}/v1?access_token=\${${credentialName}}`,
                  },
                  options: {},
                },
              },
            },
          ],
          { providerID: "synthetic-openai", modelID: "synthetic-model" },
          { order: ["native", "exa"], exa: { enabled: false } },
        )

        // The test-wide fetch stub records every call before rejecting it.
        expect(captured).toEqual([])
        expect(result.output).toContain("Web search failed")
        expect(result.output).toContain("native: failed")
        expect(result.output).toContain("exa: unavailable")
        const reason =
          host === undefined
            ? `openai/synthetic-model: configured endpoint has unresolved variables: ${hostName}`
            : "openai/synthetic-model: configured endpoint is malformed after variable substitution"
        expect(result.output).toContain(reason)
        expect(result.metadata).toMatchObject({
          attempts: [
            { backend: "native", kind: "error", reason },
            { backend: "exa", kind: "unavailable" },
          ],
        })
        expect(result.output).not.toContain(credential)
        expect(JSON.stringify(result.metadata)).not.toContain(credential)
        expect(JSON.stringify(result)).not.toContain("https://")
        expect(JSON.stringify(result)).not.toContain("access_token=")
      } finally {
        if (previousCredential === undefined) delete process.env[credentialName]
        else process.env[credentialName] = previousCredential
        if (previousHost === undefined) delete process.env[hostName]
        else process.env[hostName] = previousHost
      }
    },
  )

  // The inline half: the host's OAuth sentinel supersedes the stored key,
  // and the production reader must attach the actual OAuth credential. If
  // it stopped reading the environment, this search would be unavailable.
  test("OPENCODE_AUTH_CONTENT reaches the ChatGPT request", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: {
        type: "oauth",
        access: "inline-access",
        refresh: "inline-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "acct-inline",
      },
    })
    const result = await nativeSearch(
      [
        {
          id: "openai",
          key: "sk-config",
          options: { apiKey: "opencode-oauth-dummy-key" },
          models: { "gpt-5": { id: "gpt-5", options: {} } },
        },
      ],
      { providerID: "openai", modelID: "gpt-5" },
    )
    expect(result.metadata).toMatchObject({ backend: "native" })
    expect(result.output).toContain("Aurora tonight.")
    expect(captured).toHaveLength(1)
    expect(captured[0]?.url).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    )
    expect(captured[0]?.headers.get("Authorization")).toBe(
      "Bearer inline-access",
    )
    expect(captured[0]?.headers.get("chatgpt-account-id")).toBe("acct-inline")
  })

  // The file half, which also pins that the closure derives the path from
  // XDG_DATA_HOME + homedir the way the host does. Copilot needs no provider
  // block at all, so this one leans on the synthesized resolution.
  test("the environment's auth.json reaches the Copilot request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "websearch-factory-"))
    try {
      await fs.mkdir(path.join(root, "opencode"), { recursive: true })
      await fs.writeFile(
        path.join(root, "opencode", "auth.json"),
        JSON.stringify({
          "github-copilot": {
            type: "oauth",
            access: "gho-access",
            refresh: "gho-refresh",
            expires: 0,
          },
        }),
      )
      process.env.XDG_DATA_HOME = root
      const result = await nativeSearch([], {
        providerID: "github-copilot",
        modelID: "gpt-5.3-codex",
      })
      expect(result.metadata).toMatchObject({ backend: "native" })
      expect(result.output).toContain("Copilot answered.")
      expect(captured).toHaveLength(1)
      expect(captured[0]?.url).toBe("https://api.githubcopilot.com/responses")
      // Copilot's API key IS its refresh token.
      expect(captured[0]?.headers.get("Authorization")).toBe(
        "Bearer gho-refresh",
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  // The control-plane recovery. A workspace's credentials arrive once, frozen,
  // in OPENCODE_AUTH_CONTENT; when the host refreshes an expired token it
  // writes the replacement to auth.json and never rewrites the environment, so
  // the plain `Auth.all()` mirror would report the dead token for the whole
  // workspace lifetime and this search would be permanently unavailable rather
  // than unavailable for one refresh.
  test("a refreshed auth.json record supersedes an expired inline one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "websearch-refresh-"))
    try {
      await fs.mkdir(path.join(root, "opencode"), { recursive: true })
      await fs.writeFile(
        path.join(root, "opencode", "auth.json"),
        JSON.stringify({
          openai: {
            type: "oauth",
            access: "refreshed-access",
            refresh: "refreshed-refresh",
            expires: Date.now() + 3_600_000,
            accountId: "acct-same",
          },
        }),
      )
      process.env.XDG_DATA_HOME = root
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
        openai: {
          type: "oauth",
          access: "expired-access",
          refresh: "expired-refresh",
          expires: Date.now() - 1,
          accountId: "acct-same",
        },
      })
      const result = await nativeSearch(
        [{ id: "openai", key: "sk-config", options: {}, models: {} }],
        { providerID: "openai", modelID: "gpt-5" },
      )
      expect(result.metadata).toMatchObject({ backend: "native" })
      expect(captured).toHaveLength(1)
      expect(captured[0]?.headers.get("Authorization")).toBe(
        "Bearer refreshed-access",
      )
      expect(captured[0]?.headers.get("chatgpt-account-id")).toBe("acct-same")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  // A missing or expired OAuth record must not fall back to the sentinel or
  // a stored/environment key that the explicit sentinel already superseded.
  test.each([
    { name: "missing", store: {} },
    {
      name: "expired",
      store: {
        openai: {
          type: "oauth",
          access: "expired-access",
          refresh: "expired-refresh",
          expires: 1_000,
          accountId: "acct-inline",
        },
      },
    },
  ])("$name OAuth records never fall back to an API key", async ({ store }) => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(store)
    const result = await nativeSearch(
      [
        {
          id: "openai",
          key: "synthetic-personal-key",
          options: { apiKey: "opencode-oauth-dummy-key" },
          models: {},
        },
      ],
      { providerID: "openai", modelID: "gpt-5" },
    )
    expect(result.output).toContain("native: unavailable")
    expect(captured).toEqual([])
  })

  // The negative control: with the store the e2e sandboxes set, the native
  // backend must report unavailable rather than fall back to anything
  // ambient — and must send nothing.
  test("an empty inline store resolves no credentials and sends nothing", async () => {
    process.env.OPENCODE_AUTH_CONTENT = "{}"
    const result = await nativeSearch([], {
      providerID: "openai",
      modelID: "gpt-5",
    })
    expect(result.output).toContain("Web search failed")
    expect(result.output).toContain("native: unavailable")
    expect(captured).toEqual([])
  })
})

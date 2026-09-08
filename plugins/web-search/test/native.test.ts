import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readAuthStore } from "@macarons/permission-rules"
import { createNativeBackend, requestBaseURL } from "../src/backends/native"
import { anthropicSearch } from "../src/backends/native/anthropic"
import { chatgptSearch } from "../src/backends/native/chatgpt"
import {
  moonshotBaseURL,
  moonshotSearch,
} from "../src/backends/native/moonshot"
import { copilotSearch, openaiSearch } from "../src/backends/native/openai"
import { detectProviderType } from "../src/backends/native/registry"
import {
  type AuthStoreReader,
  loadResolutions,
  type ProvidersClient,
  pickForActiveProvider,
} from "../src/backends/native/resolve"
import { scanProviders } from "../src/backends/native/scan"
import { formatStructuredResponse } from "../src/backends/native/types"
import {
  type BackendOutcome,
  DEFAULT_NATIVE_TIMEOUT_MS,
  runSearchChain,
} from "../src/shared"

const never = new AbortController().signal

// ---- provider detection ----------------------------------------------------

describe("detectProviderType", () => {
  const model = (npm?: string) => ({ api: npm ? { npm } : undefined })

  test("canonical ids map, including both moonshot regions", () => {
    expect(detectProviderType({ id: "anthropic", models: {} })).toBe(
      "anthropic",
    )
    expect(detectProviderType({ id: "github-copilot", models: {} })).toBe(
      "copilot",
    )
    expect(detectProviderType({ id: "moonshotai", models: {} })).toBe(
      "moonshot",
    )
    expect(detectProviderType({ id: "moonshotai-cn", models: {} })).toBe(
      "moonshot",
    )
    expect(detectProviderType({ id: "openai", models: {} })).toBe("openai")
  })

  test("renamed providers detect through unambiguous api.npm", () => {
    expect(
      detectProviderType({
        id: "openai-prod",
        models: { m: model("@ai-sdk/openai") },
      }),
    ).toBe("openai")
    expect(
      detectProviderType({
        id: "corp-claude",
        models: { m: model("@ai-sdk/anthropic") },
      }),
    ).toBe("anthropic")
  })

  test("opencode-go and openai-compatible locals are unsupported", () => {
    // The fall-through contract from issue #61: these must resolve null so
    // the chain moves on instead of misrouting the query.
    expect(detectProviderType({ id: "opencode-go", models: {} })).toBeNull()
    expect(
      detectProviderType({
        id: "local",
        models: { m: model("@ai-sdk/openai-compatible") },
      }),
    ).toBeNull()
  })
})

// ---- provider scanning -----------------------------------------------------

describe("scanProviders", () => {
  test("anthropic baseURL sheds /v1", () => {
    const scanned = scanProviders([
      {
        id: "anthropic",
        options: { apiKey: "sk-option", baseURL: "https://proxy.corp/v1/" },
        models: {},
      },
    ])
    expect(scanned).toEqual([
      {
        configuredBaseURL: "https://proxy.corp/v1/",
        credentials: { apiKey: "sk-option", baseURL: "https://proxy.corp" },
        fallbackModel: undefined,
        lockedModel: undefined,
        modelApi: {},
        providerID: "anthropic",
        type: "anthropic",
      },
    ])
  })

  test("model api ids and urls survive the scan, keyed by catalog id", () => {
    // The host resolves `api.id` (wire model name behind a catalog alias)
    // and `api.url` (provider/model-level `api` endpoint) on every model;
    // dropping them would send the catalog alias to the provider or the
    // provider's key to the public default host.
    const scanned = scanProviders([
      {
        id: "openai",
        key: "sk",
        options: {},
        models: {
          fast: {
            id: "fast",
            api: { id: "gpt-4.1", url: "https://gw.corp/v1", npm: "x" },
            options: {},
          },
          plain: { id: "plain", options: {} },
        },
      },
    ])
    expect(scanned[0]?.modelApi).toEqual({
      fast: { id: "gpt-4.1", url: "https://gw.corp/v1" },
    })
  })

  test("websearch model flags are collected first-wins", () => {
    const scanned = scanProviders([
      {
        id: "openai",
        key: "sk",
        options: {},
        models: {
          a: { id: "gpt-a", options: { websearch: "auto" } },
          b: { id: "gpt-b", options: { websearch: "always" } },
          c: { id: "gpt-c", options: { websearch: "always" } },
        },
      },
    ])
    expect(scanned[0]?.lockedModel).toBe("gpt-b")
    expect(scanned[0]?.fallbackModel).toBe("gpt-a")
  })

  test("flagged credential-less providers retain a slot for OAuth fill", () => {
    const scanned = scanProviders([
      { id: "openai", options: {}, models: {} },
      {
        id: "github-copilot",
        options: {},
        models: {
          m: { id: "gpt-5.3-codex", options: { websearch: "always" } },
        },
      },
    ])
    expect(scanned).toHaveLength(1)
    expect(scanned[0]?.providerID).toBe("github-copilot")
    expect(scanned[0]?.credentials).toBeNull()
  })

  test("undetectable providers are skipped entirely", () => {
    expect(
      scanProviders([{ id: "opencode-go", key: "x", options: {}, models: {} }]),
    ).toEqual([])
  })

  // /config/providers reports the host's OAuth sentinel as options.apiKey for
  // sentinel-based OAuth providers because provider/provider.ts's plugin-auth
  // loader loop merges it over provider options. This is therefore the shape
  // a ChatGPT user's scan sees. Read as a key it resolves a request that can
  // only 401, and it would do so in exactly the case the
  // OAuth attachment pass declined, defeating the fall-through the expiry rule
  // in auth.ts exists to produce.
  test("the OAuth dummy key keeps its slot but is not credentials", () => {
    const scanned = scanProviders([
      {
        id: "openai",
        options: { apiKey: "opencode-oauth-dummy-key" },
        models: {},
      },
    ])
    expect(scanned).toHaveLength(1)
    expect(scanned[0]?.credentials).toBeNull()
  })

  test("an explicit OAuth sentinel does not fall back to provider.key", () => {
    const scanned = scanProviders([
      {
        id: "openai",
        key: "synthetic-personal-key",
        options: { apiKey: "opencode-oauth-dummy-key" },
        models: {},
      },
    ])
    expect(scanned).toHaveLength(1)
    expect(scanned[0]?.credentials).toBeNull()
  })

  test.each(["", null])(
    "an explicit apiKey of %j does not fall back to provider.key",
    (apiKey) => {
      const warnings: string[] = []
      expect(
        scanProviders(
          [
            {
              id: "openai",
              key: "synthetic-personal-key",
              options: { apiKey },
              models: {},
            },
          ],
          (warning) => warnings.push(warning),
        ),
      ).toEqual([])
      expect(warnings).toEqual([
        'provider "openai" has an explicit empty or non-string options.apiKey; native search will not fall back to its stored/environment key',
      ])
    },
  )
})

// ---- resolution loading with OAuth attachment ------------------------------

/** A JWT whose payload carries `claims` — only the payload segment is read. */
const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`

/** The oauth fields the host's auth.json schema requires of every entry. */
const OAUTH = {
  type: "oauth",
  access: "at-123",
  refresh: "rt",
  expires: 4_102_444_800_000,
}

/**
 * Runs `run` against a real auth.json in a sandbox data dir, read through the
 * library's real reader — the same derivation the plugin uses inside the
 * host's process, pointed somewhere other than the developer's own store.
 * (The reader is passed in rather than reached for: this backend used to
 * isolate tests solely by faking `client.path.get`, and dropping that call
 * would have let every one of these read the ambient machine.)
 */
async function withAuthStore(
  entries: Record<string, unknown>,
  run: (client: ProvidersClient, readStore: AuthStoreReader) => Promise<void>,
  providers: unknown[] = [],
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "websearch-auth-"))
  try {
    const data = path.join(root, "opencode")
    await fs.mkdir(data, { recursive: true })
    await fs.writeFile(path.join(data, "auth.json"), JSON.stringify(entries))
    const client: ProvidersClient = {
      config: {
        providers: async () => ({ data: { providers } }),
      },
    }
    await run(client, () =>
      readAuthStore({ env: { XDG_DATA_HOME: root }, homedir: "/nonexistent" }),
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

describe("loadResolutions", () => {
  test("ChatGPT OAuth shadows a canonical openai entry without a baseURL", async () => {
    await withAuthStore(
      {
        openai: { ...OAUTH, accountId: "acct-9" },
      },
      async (client, readStore) => {
        const resolutions = await loadResolutions(client, readStore, never)
        expect(resolutions).toHaveLength(1)
        expect(resolutions[0]).toMatchObject({
          providerID: "openai",
          type: "chatgpt",
          credentials: {
            apiKey: "at-123",
            accountId: "acct-9",
            baseURL: "https://chatgpt.com/backend-api/codex",
          },
        })
      },
      [{ id: "openai", key: "sk-config", options: {}, models: {} }],
    )
  })

  test("an openai gateway keeps its explicit key instead of attaching OAuth", async () => {
    await withAuthStore(
      {
        openai: { ...OAUTH, accountId: "acct-9" },
      },
      async (client, readStore) => {
        const resolutions = await loadResolutions(client, readStore, never)
        expect(resolutions[0]).toMatchObject({
          type: "openai",
          credentials: {
            apiKey: "synthetic-gateway-key",
            baseURL: "https://proxy.corp",
          },
        })
      },
      [
        {
          id: "openai",
          key: "synthetic-personal-key",
          options: {
            apiKey: "synthetic-gateway-key",
            baseURL: "https://proxy.corp",
          },
          models: {},
        },
      ],
    )
  })

  // The host omits accountId when it could not extract one, and only sets the
  // header when it has one — so a record without the field is credentials,
  // not a reason to drop the whole ChatGPT resolution (which is what this
  // reader did before it shared usage-limits' JWT fallback, audit §2.3).
  test("a record with no stored accountId falls back to the access token's claim", async () => {
    await withAuthStore(
      { openai: { ...OAUTH, access: jwt({ chatgpt_account_id: "acct-jwt" }) } },
      async (client, readStore) => {
        const [resolution] = await loadResolutions(client, readStore, never)
        expect(resolution?.credentials.accountId).toBe("acct-jwt")
      },
      [{ id: "openai", key: "sk-config", options: {}, models: {} }],
    )
  })

  test("a record with no derivable accountId still resolves, headerless", async () => {
    await withAuthStore(
      { openai: OAUTH },
      async (client, readStore) => {
        const [resolution] = await loadResolutions(client, readStore, never)
        expect(resolution).toMatchObject({
          type: "chatgpt",
          credentials: { apiKey: "at-123" },
        })
        expect(resolution?.credentials.accountId).toBeUndefined()
      },
      [{ id: "openai", key: "sk-config", options: {}, models: {} }],
    )
  })

  // This resolution SHADOWS a configured api key, and nothing here can
  // refresh a token — so an expired one must not take the key's place. The
  // host refreshes before it uses one; declining until it does is the closest
  // this backend can get.
  test("an expired ChatGPT token does not shadow a working openai api key", async () => {
    await withAuthStore(
      { openai: { ...OAUTH, expires: 1_000, accountId: "acct-9" } },
      async (client, readStore) => {
        const [resolution] = await loadResolutions(client, readStore, never)
        expect(resolution).toMatchObject({
          type: "openai",
          credentials: { apiKey: "sk-config" },
        })
      },
      [{ id: "openai", key: "sk-config", options: {}, models: {} }],
    )
  })

  // ...and for the OAuth-only user — the shape the host actually reports for
  // one (options.apiKey is the dummy sentinel) — the decline has to leave
  // NOTHING, so the chain moves on. Reading the sentinel as a key here would
  // send `Bearer opencode-oauth-dummy-key` to api.openai.com instead.
  test("an expired ChatGPT token on an OAuth-only provider resolves nothing", async () => {
    await withAuthStore(
      { openai: { ...OAUTH, expires: 1_000, accountId: "acct-9" } },
      async (client, readStore) => {
        expect(await loadResolutions(client, readStore, never)).toEqual([])
      },
      [
        {
          id: "openai",
          options: { apiKey: "opencode-oauth-dummy-key" },
          models: {},
        },
      ],
    )
  })

  test("a live ChatGPT token still fills the OAuth-only provider's slot", async () => {
    await withAuthStore(
      { openai: { ...OAUTH, accountId: "acct-9" } },
      async (client, readStore) => {
        const [resolution] = await loadResolutions(client, readStore, never)
        expect(resolution).toMatchObject({
          providerID: "openai",
          type: "chatgpt",
          credentials: { accountId: "acct-9", apiKey: "at-123" },
        })
      },
      [
        {
          id: "openai",
          options: { apiKey: "opencode-oauth-dummy-key" },
          models: {},
        },
      ],
    )
  })

  // Copilot's key IS its refresh token and the host stores `expires: 0` for
  // it, so the expiry rule belongs to the ChatGPT path alone.
  test("Copilot resolves regardless of the access token's expiry", async () => {
    await withAuthStore(
      { "github-copilot": { ...OAUTH, refresh: "gho-r", expires: 0 } },
      async (client, readStore) => {
        const [resolution] = await loadResolutions(client, readStore, never)
        expect(resolution?.credentials.apiKey).toBe("gho-r")
      },
    )
  })

  // The reader decodes auth.json entry by entry exactly as the host does, so
  // an entry the host would discard cannot serve a search here either. This
  // one is a bare oauth stub with no tokens.
  test("an auth.json entry the host would drop is not credentials here", async () => {
    await withAuthStore(
      { openai: { type: "oauth", access: "at-123", accountId: "acct-9" } },
      async (client, readStore) => {
        const [resolution] = await loadResolutions(client, readStore, never)
        expect(resolution).toMatchObject({
          type: "openai",
          credentials: { apiKey: "sk-config" },
        })
      },
      [{ id: "openai", key: "sk-config", options: {}, models: {} }],
    )
  })

  // ...but the inline override is NOT filtered, because the host does not
  // filter it either — a control-plane workspace carries its credentials this
  // way with no auth.json on disk at all, and this backend used to be blind
  // to all of them (audit §2.8.4).
  test("OPENCODE_AUTH_CONTENT is honored, raw, over the file", async () => {
    const client: ProvidersClient = {
      config: {
        providers: async () => ({
          data: {
            providers: [
              { id: "openai", key: "sk-config", options: {}, models: {} },
            ],
          },
        }),
      },
    }
    const resolutions = await loadResolutions(
      client,
      () =>
        readAuthStore({
          env: {
            OPENCODE_AUTH_CONTENT: JSON.stringify({
              openai: {
                type: "oauth",
                access: "inline-at",
                accountId: "acct-i",
              },
            }),
            XDG_DATA_HOME: "/does/not/exist",
          },
          homedir: "/nonexistent",
        }),
      never,
    )
    expect(resolutions[0]).toMatchObject({
      type: "chatgpt",
      credentials: { apiKey: "inline-at", accountId: "acct-i" },
    })
  })

  test("Copilot OAuth synthesizes a resolution for OAuth-only users", async () => {
    await withAuthStore(
      {
        "github-copilot": { ...OAUTH, refresh: "gho-r" },
      },
      async (client, readStore) => {
        const resolutions = await loadResolutions(client, readStore, never)
        expect(resolutions).toHaveLength(1)
        expect(resolutions[0]).toMatchObject({
          providerID: "github-copilot",
          type: "copilot",
          credentials: {
            apiKey: "gho-r",
            baseURL: "https://api.githubcopilot.com",
          },
        })
      },
    )
  })

  test("Copilot enterpriseUrl reshapes the base URL", async () => {
    await withAuthStore(
      {
        "github-copilot": {
          ...OAUTH,
          refresh: "gho-r",
          enterpriseUrl: "https://ghe.corp.example/",
        },
      },
      async (client, readStore) => {
        const resolutions = await loadResolutions(client, readStore, never)
        expect(resolutions[0]?.credentials.baseURL).toBe(
          "https://copilot-api.ghe.corp.example",
        )
      },
    )
  })

  test("a failing providers() call degrades to no resolutions", async () => {
    const client: ProvidersClient = {
      config: {
        providers: async () => {
          throw new Error("host down")
        },
      },
    }
    expect(
      await loadResolutions(
        client,
        () => {
          throw new Error("must not read the auth store")
        },
        never,
      ),
    ).toEqual([])
  })
})

// ---- active-provider-only picking ------------------------------------------

describe("pickForActiveProvider", () => {
  const anthropic = {
    credentials: { apiKey: "sk" },
    modelApi: {},
    providerID: "anthropic",
    type: "anthropic" as const,
  }

  test("no active model means no attempts (fail-safe: chain falls through)", () => {
    expect(pickForActiveProvider([anthropic], undefined)).toEqual([])
  })

  test("the active provider must own the resolution — no cross-provider serve", () => {
    // The scope decision from issue #61: an opencode-go session never
    // borrows the configured anthropic provider for its searches.
    expect(
      pickForActiveProvider([anthropic], {
        providerID: "opencode-go",
        modelID: "go-large",
      }),
    ).toEqual([])
  })

  test("a locked model on the active provider wins over the active model", () => {
    expect(
      pickForActiveProvider([{ ...anthropic, lockedModel: "claude-searchy" }], {
        providerID: "anthropic",
        modelID: "claude-fast",
      }),
    ).toEqual([
      {
        modelID: "claude-searchy",
        apiModelID: "claude-searchy",
        resolution: { ...anthropic, lockedModel: "claude-searchy" },
      },
    ])
  })

  test("otherwise the active model itself serves the search", () => {
    expect(
      pickForActiveProvider([anthropic], {
        providerID: "anthropic",
        modelID: "claude-fast",
      }),
    ).toEqual([
      {
        modelID: "claude-fast",
        apiModelID: "claude-fast",
        resolution: anthropic,
      },
    ])
  })

  test("a catalog alias picks by catalog id but carries the wire id and endpoint", () => {
    const aliased = {
      ...anthropic,
      modelApi: {
        fast: { id: "claude-real", url: "https://gw.corp/anthropic" },
      },
    }
    expect(
      pickForActiveProvider([aliased], {
        providerID: "anthropic",
        modelID: "fast",
      }),
    ).toEqual([
      {
        modelID: "fast",
        apiModelID: "claude-real",
        apiURL: "https://gw.corp/anthropic",
        resolution: aliased,
      },
    ])
  })

  test("a locked model resolves its own wire id, not the active model's", () => {
    const aliased = {
      ...anthropic,
      lockedModel: "searchy",
      modelApi: {
        searchy: { id: "claude-searchy-v2" },
        fast: { id: "claude-real" },
      },
    }
    expect(
      pickForActiveProvider([aliased], {
        providerID: "anthropic",
        modelID: "fast",
      }),
    ).toMatchObject([{ modelID: "searchy", apiModelID: "claude-searchy-v2" }])
  })
})

describe("requestBaseURL", () => {
  const resolution = (
    credentials: { apiKey: string; baseURL?: string },
    type: "anthropic" | "openai" = "openai",
  ) => ({
    credentials,
    modelApi: {},
    providerID: type,
    type,
  })

  test("an explicit options.baseURL wins over the model endpoint (host precedence)", () => {
    expect(
      requestBaseURL({
        modelID: "m",
        apiModelID: "m",
        apiURL: "https://model.example/v1",
        resolution: resolution({
          apiKey: "sk",
          baseURL: "https://cred.example",
        }),
      }),
    ).toBe("https://cred.example")
  })

  test("without credentials baseURL the model api.url serves, anthropic sheds /v1", () => {
    expect(
      requestBaseURL({
        modelID: "m",
        apiModelID: "m",
        apiURL: "https://gw.corp/v1",
        resolution: resolution({ apiKey: "sk" }, "anthropic"),
      }),
    ).toBe("https://gw.corp")
    expect(
      requestBaseURL({
        modelID: "m",
        apiModelID: "m",
        apiURL: "https://gw.corp/v1",
        resolution: resolution({ apiKey: "sk" }),
      }),
    ).toBe("https://gw.corp/v1")
  })

  test("no endpoint anywhere → undefined (adapter public default)", () => {
    expect(
      requestBaseURL({
        modelID: "m",
        apiModelID: "m",
        resolution: resolution({ apiKey: "sk" }),
      }),
    ).toBeUndefined()
  })

  test("placeholder variables substitute from the environment; unresolved ones throw", () => {
    process.env.WEBSEARCH_TEST_GW = "gw.example"
    try {
      expect(
        requestBaseURL({
          modelID: "m",
          apiModelID: "m",
          apiURL: `https://\${WEBSEARCH_TEST_GW}/v1`,
          resolution: resolution({ apiKey: "sk" }),
        }),
      ).toBe("https://gw.example/v1")
    } finally {
      delete process.env.WEBSEARCH_TEST_GW
    }
    // Falling back to the public default here would send the provider's
    // key to a host the config did not name — throwing falls through.
    expect(() =>
      requestBaseURL({
        modelID: "m",
        apiModelID: "m",
        apiURL: `https://\${WEBSEARCH_TEST_MISSING}/v1`,
        resolution: resolution({ apiKey: "sk" }),
      }),
    ).toThrow("unresolved")
  })

  test.each([`\${}`, `\${`])(
    "malformed placeholder %s fails without disclosing the endpoint",
    (placeholder) => {
      expect(() =>
        requestBaseURL({
          modelID: "m",
          apiModelID: "m",
          apiURL: `https://gw.example/v1?token=synthetic-query-credential#${placeholder}`,
          resolution: resolution({ apiKey: "sk" }),
        }),
      ).toThrow(
        /^configured endpoint is malformed after variable substitution$/,
      )
    },
  )
})

// ---- adapters against loopback endpoints -----------------------------------

type Recorded = {
  path: string
  headers: Headers
  body: unknown
}

let server: ReturnType<typeof Bun.serve>
let respond: (request: Recorded) => Response | Promise<Response>
let requests: Recorded[]

beforeAll(() => {
  requests = []
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const recorded: Recorded = {
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.json().catch(() => undefined),
      }
      requests.push(recorded)
      return respond(recorded)
    },
  })
})

afterAll(() => {
  server.stop(true)
})

function base(): string {
  return `http://127.0.0.1:${server.port}`
}

describe("anthropic adapter", () => {
  test("pins the messages call: headers, tool block, and block parsing", async () => {
    respond = () =>
      Response.json({
        content: [
          { type: "text", text: "Answer text." },
          {
            type: "web_search_tool_result",
            content: [
              { title: "Doc", url: "https://docs.example" },
              { title: "Doc", url: "https://docs.example" },
            ],
          },
        ],
      })
    const output = await anthropicSearch(
      { apiKey: "sk-a", baseURL: base(), model: "claude-x" },
      "solar",
      never,
    )
    const request = requests.at(-1)
    expect(request?.path).toBe("/v1/messages")
    expect(request?.headers.get("x-api-key")).toBe("sk-a")
    expect(request?.headers.get("anthropic-version")).toBe("2023-06-01")
    expect(request?.body).toMatchObject({
      model: "claude-x",
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    })
    expect(output).toContain("Answer text.")
    expect(output).toContain("Sources:")
    expect(output.match(/docs\.example/g)).toHaveLength(1)
  })

  test("an API error surfaces the provider message and status", async () => {
    respond = () =>
      Response.json(
        { error: { message: "invalid x-api-key" } },
        { status: 401 },
      )
    expect(
      anthropicSearch(
        { apiKey: "bad", baseURL: base(), model: "claude-x" },
        "q",
        never,
      ),
    ).rejects.toThrow("Anthropic API error: invalid x-api-key (status: 401)")
  })

  test("a search-error block with no hits throws so the chain falls through", async () => {
    // HTTP 200, but the tool result is the error object shape — the search
    // itself failed and the model's prose is not a searched answer.
    respond = () =>
      Response.json({
        content: [
          { type: "text", text: "I could not search." },
          {
            type: "web_search_tool_result",
            content: {
              type: "web_search_tool_result_error",
              error_code: "unavailable",
            },
          },
        ],
      })
    expect(
      anthropicSearch(
        { apiKey: "sk-a", baseURL: base(), model: "claude-x" },
        "q",
        never,
      ),
    ).rejects.toThrow("Anthropic web search failed: unavailable")
  })

  test("a search-error block alongside real hits keeps the answer", async () => {
    // max_uses_exceeded after successful searches: the citations are real.
    respond = () =>
      Response.json({
        content: [
          { type: "text", text: "Partial answer." },
          {
            type: "web_search_tool_result",
            content: [{ title: "Doc", url: "https://docs.example" }],
          },
          {
            type: "web_search_tool_result",
            content: { error_code: "max_uses_exceeded" },
          },
        ],
      })
    const output = await anthropicSearch(
      { apiKey: "sk-a", baseURL: base(), model: "claude-x" },
      "q",
      never,
    )
    expect(output).toContain("Partial answer.")
    expect(output).toContain("https://docs.example")
    expect(output).not.toContain("max_uses_exceeded")
  })
})

describe("openai + copilot adapters", () => {
  const RESPONSES_PAYLOAD = {
    output: [
      {
        type: "web_search_call",
        action: { type: "search", sources: [{ url: "https://src.example" }] },
      },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "Synthesized.",
            annotations: [
              {
                type: "url_citation",
                title: "Cite",
                url: "https://cite.example",
              },
            ],
          },
        ],
      },
    ],
  }

  test("openai pins /responses with the web_search tool, ignoring call sources", async () => {
    respond = () => Response.json(RESPONSES_PAYLOAD)
    const output = await openaiSearch(
      { apiKey: "sk-o", baseURL: base(), model: "gpt-x" },
      "solar",
      never,
    )
    const request = requests.at(-1)
    expect(request?.path).toBe("/responses")
    expect(request?.headers.get("Authorization")).toBe("Bearer sk-o")
    expect(request?.body).toMatchObject({
      model: "gpt-x",
      store: false,
      tools: [{ type: "web_search" }],
    })
    expect((request!.body as { include?: unknown }).include).toBeUndefined()
    expect(output).toContain("Synthesized.")
    expect(output).toContain("https://cite.example")
    expect(output).not.toContain("src.example")
  })

  test("copilot adds the identification headers, include, and source hits", async () => {
    respond = () => Response.json(RESPONSES_PAYLOAD)
    const output = await copilotSearch(
      { apiKey: "gho-r", baseURL: base(), model: "gpt-5.3-codex" },
      "solar",
      never,
    )
    const request = requests.at(-1)
    expect(request?.headers.get("Openai-Intent")).toBe("conversation-edits")
    expect(request?.headers.get("x-initiator")).toBe("user")
    expect(request?.body).toMatchObject({
      store: false,
      include: ["web_search_call.action.sources"],
      tool_choice: "auto",
    })
    expect(output).toContain("https://src.example")
  })

  for (const providerID of ["openai", "github-copilot"]) {
    test.each([
      ...["failed", "incomplete", "cancelled", "queued", "in_progress"].map(
        (status) => ({
          name: `response status ${status}`,
          payload: { status, output: [] },
          reason: `Responses API execution failed: ${status}`,
        }),
      ),
      {
        name: "failed response with provider diagnostics",
        payload: {
          status: "failed",
          error: { code: "server_error", message: "Search unavailable" },
          output: [],
        },
        reason: "Responses API execution failed: Search unavailable",
      },
      {
        name: "body error without a response status",
        payload: { error: { code: "server_error" }, output: [] },
        reason: "Responses API execution failed: server_error",
      },
      {
        name: "token exhaustion without textual output",
        payload: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
        },
        reason: "Responses API execution failed: max_output_tokens",
      },
      {
        name: "incomplete details without a response status",
        payload: {
          incomplete_details: { reason: "content_filter" },
          output: [],
        },
        reason: "Responses API execution failed: content_filter",
      },
      {
        name: "incomplete response with partial text and citations",
        payload: {
          ...RESPONSES_PAYLOAD,
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
        reason: "Responses API execution failed: max_output_tokens",
      },
      ...["failed", "in_progress", "searching"].map((status) => ({
        name: `search-call status ${status} in a completed response`,
        payload: {
          status: "completed",
          output: [{ type: "web_search_call", status }],
        },
        reason: `Responses web search did not complete: ${status}`,
      })),
      {
        name: "failed search call with partial text and sources",
        payload: {
          status: "completed",
          output: [
            ...RESPONSES_PAYLOAD.output,
            { type: "web_search_call", status: "failed" },
          ],
        },
        reason: "Responses web search did not complete: failed",
      },
      {
        name: "completed empty response",
        payload: {
          status: "completed",
          error: null,
          incomplete_details: null,
          output: [],
        },
        reason: undefined,
      },
      {
        name: "completed search with zero sources",
        payload: {
          status: "completed",
          output: [
            {
              type: "web_search_call",
              status: "completed",
              action: { type: "search", sources: [] },
            },
          ],
        },
        reason: undefined,
      },
    ])(`${providerID}: $name`, async ({ payload, reason }) => {
      respond = () => Response.json(payload)
      const backend = createNativeBackend({
        client: {
          config: {
            providers: async () => ({
              data: {
                providers: [
                  {
                    id: providerID,
                    key: "synthetic-responses-key",
                    options: { baseURL: base() },
                    models: {},
                  },
                ],
              },
            }),
          },
        },
        readAuthStore: async () => ({}),
        warn: () => {},
      })
      let nativeOutcome: BackendOutcome | undefined
      const attempted: string[] = []
      const before = requests.length
      const result = await runSearchChain(
        ["native", "exa"],
        {
          native: {
            id: "native",
            run: async (params, signal) => {
              nativeOutcome = await backend(
                { enabled: true, timeoutMs: DEFAULT_NATIVE_TIMEOUT_MS },
                params,
                async () => ({ providerID, modelID: "gpt-x" }),
                signal,
              )
              return nativeOutcome
            },
          },
          exa: {
            id: "exa",
            run: async () => ({ kind: "ok", output: "Fallback answer." }),
          },
          searxng: {
            id: "searxng",
            run: async () => ({ kind: "unavailable", reason: "disabled" }),
          },
        },
        { query: "solar" },
        never,
        (id) => attempted.push(id),
      )
      expect(requests.slice(before)).toHaveLength(1)
      if (reason) {
        expect(nativeOutcome).toEqual({
          kind: "error",
          reason: `${providerID === "openai" ? "openai" : "copilot"}/gpt-x: ${reason}`,
        })
        expect(result).toEqual({
          kind: "ok",
          backend: "exa",
          output: "Fallback answer.",
        })
        expect(attempted).toEqual(["native", "exa"])
      } else {
        const output = expect.stringContaining(
          'No search results found for "solar"',
        )
        expect(nativeOutcome).toEqual({ kind: "ok", output })
        expect(result).toEqual({
          kind: "ok",
          backend: "native",
          output,
        })
        expect(attempted).toEqual(["native"])
      }
    })
  }
})

describe("chatgpt adapter", () => {
  test("prefers the provider error message over gateway detail", async () => {
    respond = () =>
      Response.json(
        {
          detail: "generic gateway message",
          error: { message: "specific provider message" },
        },
        { status: 401 },
      )
    await expect(
      chatgptSearch(
        { apiKey: "bad", baseURL: base(), model: "gpt-x" },
        "q",
        never,
      ),
    ).rejects.toThrow(
      "ChatGPT API error: specific provider message (status: 401)",
    )
  })

  test("consumes the SSE stream: deltas accumulate, sources dedupe", async () => {
    const events = [
      `event: response.output_text.delta\ndata: {"delta":"Half "}\n\n`,
      `event: response.output_text.delta\ndata: {"delta":"answer."}\n\n`,
      `event: response.output_item.done\ndata: {"item":{"type":"web_search_call","action":{"type":"search","sources":[{"url":"https://s.example"},{"url":"https://s.example"}]}}}\n\n`,
    ].join("")
    respond = () =>
      new Response(events, {
        headers: { "Content-Type": "text/event-stream" },
      })
    const output = await chatgptSearch(
      { apiKey: "at-1", accountId: "acct", baseURL: base(), model: "gpt-x" },
      "solar",
      never,
    )
    const request = requests.at(-1)
    expect(request?.headers.get("chatgpt-account-id")).toBe("acct")
    expect(request?.body).toMatchObject({
      stream: true,
      store: false,
      include: ["web_search_call.action.sources"],
    })
    expect(output).toContain("Half answer.")
    // One Sources entry: the duplicate URL deduped ([url](url) renders the
    // string twice within the single list item).
    expect(output.match(/- \[/g)).toHaveLength(1)
  })

  test("a response.failed event throws instead of reporting an empty search", async () => {
    const events = [
      `event: response.output_text.delta\ndata: {"delta":"partial"}\n\n`,
      `event: response.failed\ndata: {"response":{"error":{"message":"content policy"}}}\n\n`,
    ].join("")
    respond = () =>
      new Response(events, {
        headers: { "Content-Type": "text/event-stream" },
      })
    expect(
      chatgptSearch(
        { apiKey: "at-1", baseURL: base(), model: "gpt-x" },
        "q",
        never,
      ),
    ).rejects.toThrow("ChatGPT API error: content policy")
  })

  test("an error event throws with its message", async () => {
    const events = `event: error\ndata: {"message":"rate limited"}\n\n`
    respond = () =>
      new Response(events, {
        headers: { "Content-Type": "text/event-stream" },
      })
    expect(
      chatgptSearch(
        { apiKey: "at-1", baseURL: base(), model: "gpt-x" },
        "q",
        never,
      ),
    ).rejects.toThrow("ChatGPT API error: rate limited")
  })

  test("a stream that dies with no terminal event and no output throws", async () => {
    respond = () =>
      new Response("", { headers: { "Content-Type": "text/event-stream" } })
    expect(
      chatgptSearch(
        { apiKey: "at-1", baseURL: base(), model: "gpt-x" },
        "q",
        never,
      ),
    ).rejects.toThrow("without a terminal event")
  })

  test("response.completed with no output stays a genuine empty answer", async () => {
    const events = `event: response.completed\ndata: {"response":{}}\n\n`
    respond = () =>
      new Response(events, {
        headers: { "Content-Type": "text/event-stream" },
      })
    const output = await chatgptSearch(
      { apiKey: "at-1", baseURL: base(), model: "gpt-x" },
      "q",
      never,
    )
    expect(output).toContain("No search results found")
  })
})

describe("moonshot adapter", () => {
  test("regional defaults are keyed off the provider id", () => {
    expect(moonshotBaseURL("moonshotai", undefined)).toBe(
      "https://api.moonshot.ai/v1",
    )
    expect(moonshotBaseURL("moonshotai-cn", undefined)).toBe(
      "https://api.moonshot.cn/v1",
    )
    expect(moonshotBaseURL("moonshotai", "https://proxy/")).toBe(
      "https://proxy",
    )
  })

  test("the agentic loop echoes $web_search arguments back as tool results", async () => {
    let call = 0
    respond = () => {
      call += 1
      if (call === 1) {
        return Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "t1",
                    function: {
                      name: "$web_search",
                      arguments: '{"search_query":"solar"}',
                    },
                  },
                ],
              },
            },
          ],
        })
      }
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Kimi answer.",
              annotations: [
                {
                  type: "url_citation",
                  url_citation: { title: "K", url: "https://k.example" },
                },
              ],
            },
          },
        ],
      })
    }
    const before = requests.length
    const output = await moonshotSearch(
      "moonshotai",
      { apiKey: "mk", baseURL: base(), model: "kimi-x" },
      "solar",
      never,
    )
    const [first, second] = requests.slice(before)
    expect(first?.body).toMatchObject({
      tools: [{ type: "builtin_function", function: { name: "$web_search" } }],
      thinking: { type: "disabled" },
    })
    const secondMessages = (second!.body as { messages: unknown[] }).messages
    expect(secondMessages).toHaveLength(4)
    expect(secondMessages[3]).toMatchObject({
      role: "tool",
      tool_call_id: "t1",
      content: '{"search_query":"solar"}',
    })
    expect(output).toContain("Kimi answer.")
    expect(output).toContain("https://k.example")
  })
})

// ---- the assembled native backend ------------------------------------------

describe("createNativeBackend", () => {
  const nativeOptions = { enabled: true, timeoutMs: DEFAULT_NATIVE_TIMEOUT_MS }

  test.each([
    {
      name: "uses the provider key when options.apiKey is absent",
      key: "synthetic-personal-key",
      apiKey: undefined,
      expected: "synthetic-personal-key",
    },
    {
      name: "uses the explicit gateway key instead of the provider key",
      key: "synthetic-personal-key",
      apiKey: "synthetic-gateway-key",
      expected: "synthetic-gateway-key",
    },
    {
      name: "uses the explicit gateway key without a provider key",
      key: undefined,
      apiKey: "synthetic-gateway-key",
      expected: "synthetic-gateway-key",
    },
    {
      name: "uses the explicit gateway key despite a stored OAuth sentinel",
      key: "opencode-oauth-dummy-key",
      apiKey: "synthetic-gateway-key",
      expected: "synthetic-gateway-key",
    },
  ])("gateway request $name", async ({ key, apiKey, expected }) => {
    respond = () =>
      Response.json({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Gateway answered." }],
          },
        ],
      })
    const backend = createNativeBackend({
      client: {
        config: {
          providers: async () => ({
            data: {
              providers: [
                {
                  id: "openai",
                  key,
                  options: { apiKey, baseURL: `${base()}/v1` },
                  models: {},
                },
              ],
            },
          }),
        },
      },
      readAuthStore: async () => ({}),
      warn: () => {},
    })
    const before = requests.length
    const outcome = await backend(
      nativeOptions,
      { query: "q" },
      async () => ({ providerID: "openai", modelID: "gpt-x" }),
      never,
    )
    expect(outcome).toMatchObject({ kind: "ok", output: "Gateway answered." })
    expect(requests.slice(before)).toHaveLength(1)
    const request = requests[before]
    expect(request?.path).toBe("/v1/responses")
    expect(request?.headers.get("Authorization")).toBe(`Bearer ${expected}`)
    expect(request?.body).toMatchObject({ model: "gpt-x" })
  })

  test("no active model reports unavailable", async () => {
    const backend = createNativeBackend({
      client: {
        config: { providers: async () => ({ data: { providers: [] } }) },
      },
      readAuthStore: async () => ({}),
      warn: () => {},
    })
    const outcome = await backend(
      nativeOptions,
      { query: "q" },
      async () => undefined,
      never,
    )
    expect(outcome.kind).toBe("unavailable")
  })

  test("an unsupported active provider reports unavailable with its id", async () => {
    const backend = createNativeBackend({
      client: {
        config: { providers: async () => ({ data: { providers: [] } }) },
      },
      readAuthStore: async () => ({}),
      warn: () => {},
    })
    const outcome = await backend(
      nativeOptions,
      { query: "q" },
      async () => ({ providerID: "opencode-go", modelID: "go-large" }),
      never,
    )
    expect(outcome.kind).toBe("unavailable")
    if (outcome.kind !== "unavailable") throw new Error("unreachable")
    expect(outcome.reason).toContain("opencode-go")
  })

  test("an adapter failure becomes an error outcome naming the model", async () => {
    respond = () =>
      Response.json({ error: { message: "quota exceeded" } }, { status: 429 })
    const backend = createNativeBackend({
      client: {
        config: {
          providers: async () => ({
            data: {
              providers: [
                {
                  id: "anthropic",
                  key: "sk",
                  options: { baseURL: base() },
                  models: {},
                },
              ],
            },
          }),
        },
      },
      readAuthStore: async () => ({}),
      warn: () => {},
    })
    const outcome = await backend(
      nativeOptions,
      { query: "q" },
      async () => ({ providerID: "anthropic", modelID: "claude-x" }),
      never,
    )
    expect(outcome.kind).toBe("error")
    if (outcome.kind !== "error") throw new Error("unreachable")
    expect(outcome.reason).toContain("anthropic/claude-x")
    expect(outcome.reason).toContain("quota exceeded")
  })

  test("an aliased model on a renamed provider hits its api.url with its api.id", async () => {
    // H2/M3 end-to-end: no options.baseURL anywhere — the model-level
    // api endpoint and wire id must reach the actual request, or the
    // search would go to api.openai.com under the catalog alias.
    respond = () =>
      Response.json({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Routed." }],
          },
        ],
      })
    const backend = createNativeBackend({
      client: {
        config: {
          providers: async () => ({
            data: {
              providers: [
                {
                  id: "openai-prod",
                  key: "sk-corp",
                  options: {},
                  models: {
                    fast: {
                      id: "fast",
                      api: {
                        npm: "@ai-sdk/openai",
                        id: "gpt-4.1",
                        url: base(),
                      },
                      options: {},
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      readAuthStore: async () => ({}),
      warn: () => {},
    })
    const before = requests.length
    const outcome = await backend(
      nativeOptions,
      { query: "q" },
      async () => ({ providerID: "openai-prod", modelID: "fast" }),
      never,
    )
    expect(outcome.kind).toBe("ok")
    const request = requests[before]
    expect(request?.path).toBe("/responses")
    expect(request?.body).toMatchObject({ model: "gpt-4.1" })
    expect(request?.headers.get("Authorization")).toBe("Bearer sk-corp")
  })

  test("disabled short-circuits before any lookup", async () => {
    const backend = createNativeBackend({
      client: {
        config: {
          providers: async () => {
            throw new Error("must not be called")
          },
        },
      },
      readAuthStore: async () => {
        throw new Error("must not be called")
      },
      warn: () => {},
    })
    const outcome = await backend(
      { enabled: false, timeoutMs: DEFAULT_NATIVE_TIMEOUT_MS },
      { query: "q" },
      async () => {
        throw new Error("must not look up the assistant")
      },
      never,
    )
    expect(outcome.kind).toBe("unavailable")
  })
})

// ---- output formatting -----------------------------------------------------

describe("formatStructuredResponse", () => {
  test("text then a deduped Sources list", () => {
    const output = formatStructuredResponse({
      query: "q",
      results: [
        "Paragraph.",
        [
          { title: "A", url: "https://a.example" },
          { title: "A again", url: "https://a.example" },
        ],
      ],
    })
    expect(output).toBe("Paragraph.\n\nSources:\n- [A](https://a.example)")
  })

  test("nothing at all reads as no results", () => {
    expect(formatStructuredResponse({ query: "q", results: [] })).toContain(
      "No search results found",
    )
  })
})

import { describe, expect, test } from "bun:test"
import type { ModelInfo, ProviderInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { nativeSearch, searchConfig } from "../src/native"

const signal = new AbortController().signal
const provider = {
  id: "openai",
  name: "OpenAI",
  integrationID: "openai",
  package: "@opencode/ai/providers/openai",
  activation: "auto",
} as ProviderInfo
const model = {
  id: "alias",
  modelID: "wire-model",
  providerID: "openai",
  enabled: true,
  variants: [],
} as unknown as ModelInfo
function context(
  options: {
    provider?: ProviderInfo
    models?: ModelInfo[]
    credential?: unknown
  } = {},
) {
  return {
    provider: {
      get: async ({ providerID }: any) => {
        expect(providerID).toBe(options.provider?.id ?? "openai")
        return { data: options.provider ?? provider }
      },
    },
    model: { list: async () => ({ data: options.models ?? [model] }) },
    integration: {
      connection: {
        active: async () => ({ type: "credential", id: "key" }),
        resolve: async () =>
          options.credential ?? { type: "key", key: "test-key" },
      },
    },
  } as unknown as Plugin.Context
}

describe("V2 provider search routing", () => {
  test("inherits gateway settings, headers and model aliases", async () => {
    const p = {
      ...provider,
      settings: { baseURL: "https://gateway.test/v1", apiKey: "own-key" },
      headers: { "X-Route": "provider" },
    }
    const m = {
      ...model,
      headers: { "x-route": "model" },
      variants: [{ id: "fast", settings: { apiKey: "variant-key" } }],
    }
    expect(await searchConfig(context(), p, m, "fast")).toMatchObject({
      type: "openai",
      config: {
        model: "wire-model",
        apiKey: "variant-key",
        baseURL: "https://gateway.test/v1",
        headers: { "x-route": "model" },
      },
    })
  })
  test("ChatGPT OAuth is bound to the expected endpoint and account", async () => {
    const ctx = context({
      credential: {
        type: "oauth",
        methodID: "chatgpt-browser",
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 60000,
        metadata: { accountID: "account" },
      },
    })
    expect(await searchConfig(ctx, provider, model)).toMatchObject({
      type: "chatgpt",
      config: {
        apiKey: "access",
        accountId: "account",
        baseURL: "https://chatgpt.com/backend-api/codex",
      },
    })
    await expect(
      searchConfig(
        ctx,
        { ...provider, settings: { baseURL: "https://gateway.test" } },
        model,
      ),
    ).rejects.toThrow("Refusing")
  })
  test("uses the requesting provider only, and retries its tagged fallback", async () => {
    const seen: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { model: string }
        seen.push(body.model)
        return body.model === "wire-model"
          ? new Response("failed", { status: 503 })
          : Response.json({
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: "answer" }],
                },
              ],
            })
      },
    })
    try {
      const p = { ...provider, settings: { baseURL: server.url.origin } }
      const fallback = {
        ...model,
        id: "fallback",
        modelID: "fallback-wire",
        settings: { websearch: "auto" },
      }
      const other = {
        ...fallback,
        id: "foreign",
        providerID: "anthropic",
        modelID: "foreign-wire",
      }
      const answer = await nativeSearch(
        context({ provider: p, models: [model, other, fallback] }),
        { providerID: "openai", id: "alias" },
        "query",
        signal,
        1000,
      )
      expect(answer).toBe("answer")
      expect(seen).toEqual(["wire-model", "fallback-wire"])
    } finally {
      server.stop(true)
    }
  })
  test("cancellation prevents requests", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      nativeSearch(
        context(),
        { providerID: "openai", id: "alias" },
        "query",
        controller.signal,
        1000,
      ),
    ).rejects.toThrow()
  })
})

test("malformed endpoints do not echo configured credentials into tool errors", async () => {
  await expect(
    searchConfig(
      context(),
      {
        ...provider,
        settings: {
          apiKey: "own-key",
          baseURL: "invalid-endpoint?token=private-value",
        },
      },
      model,
    ),
  ).rejects.toThrow("Invalid native search endpoint")
  try {
    await searchConfig(
      context(),
      {
        ...provider,
        settings: {
          apiKey: "own-key",
          baseURL: "invalid-endpoint?token=private-value",
        },
      },
      model,
    )
  } catch (error) {
    expect(String(error)).not.toContain("private-value")
  }
})

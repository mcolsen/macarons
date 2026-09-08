import { expect, test } from "bun:test"
import { createNativeBackend } from "../src/backends/native"
import { chatgptSearch } from "../src/backends/native/chatgpt"
import { copilotSearch } from "../src/backends/native/openai"

const signal = new AbortController().signal

for (const providerID of [
  "anthropic",
  "openai",
  "github-copilot",
  "moonshotai",
  "corp-openai",
]) {
  test.each([false, true])(
    `${providerID}: gateway requires provider and selected model headers (locked: %j)`,
    async (locked) => {
      const providerHeaders = {
        "x-gateway-auth": "synthetic-gateway-auth",
        "x-route": "provider-route",
        "X-Case-Route": "provider-case-route",
        Authorization: "Bearer synthetic-provider-auth",
        "x-api-key": "synthetic-provider-key",
        "anthropic-beta": "synthetic-gateway-beta",
      }
      const modelHeaders = {
        "x-model-tenant": "synthetic-search-tenant",
        "x-route": "model-route",
        "x-case-route": "model-case-route",
        ...(locked
          ? {
              authorization: "Bearer synthetic-model-auth",
              "X-Api-Key": "synthetic-model-key",
              "Content-Type": "application/json; charset=utf-8",
              "Anthropic-Version": "synthetic-model-version",
              "Anthropic-Beta": "synthetic-model-beta",
            }
          : {}),
      }
      const expected: Record<string, string> = {
        "content-type": locked
          ? "application/json; charset=utf-8"
          : "application/json",
        "x-gateway-auth": "synthetic-gateway-auth",
        "x-model-tenant": "synthetic-search-tenant",
        "x-route": "model-route",
        "x-case-route": "model-case-route",
        authorization: locked
          ? "Bearer synthetic-model-auth"
          : "Bearer synthetic-provider-auth",
        "x-api-key": locked ? "synthetic-model-key" : "synthetic-provider-key",
        "anthropic-beta": locked
          ? "synthetic-model-beta"
          : "synthetic-gateway-beta",
      }
      if (providerID === "anthropic")
        expected["anthropic-version"] = locked
          ? "synthetic-model-version"
          : "2023-06-01"
      if (providerID === "github-copilot") {
        expected["openai-intent"] = "conversation-edits"
        expected["user-agent"] = "macarons-websearch"
        expected["x-initiator"] = "user"
      }

      const requests: Request[] = []
      const gateway = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          requests.push(request)
          if (
            Object.entries(expected).some(
              ([name, value]) => request.headers.get(name) !== value,
            )
          ) {
            return Response.json(
              { error: { message: "gateway headers required" } },
              { status: 401 },
            )
          }
          const body = (await request.json()) as {
            model: string
            messages?: unknown[]
          }
          if (body.model !== "search-wire")
            return new Response("wrong model", { status: 400 })
          if (providerID === "anthropic")
            return Response.json({
              content: [{ type: "text", text: "Gateway answered." }],
            })
          if (providerID === "moonshotai")
            return Response.json({
              choices: [
                body.messages?.length === 2
                  ? {
                      finish_reason: "tool_calls",
                      message: {
                        tool_calls: [
                          {
                            id: "search-1",
                            function: {
                              name: "$web_search",
                              arguments: '{"search_query":"q"}',
                            },
                          },
                        ],
                      },
                    }
                  : {
                      finish_reason: "stop",
                      message: { content: "Gateway answered." },
                    },
              ],
            })
          return Response.json({
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Gateway answered." }],
              },
            ],
          })
        },
      })
      try {
        const baseURL = `http://127.0.0.1:${gateway.port}/v1`
        const endpoint =
          providerID === "anthropic"
            ? "/messages"
            : providerID === "moonshotai"
              ? "/chat/completions"
              : "/responses"
        // Prove the gateway rejects either missing source and the wrong winner.
        for (const missing of ["x-gateway-auth", "x-model-tenant", "x-route"]) {
          const headers = new Headers(expected)
          if (missing === "x-route") headers.set(missing, "provider-route")
          else headers.delete(missing)
          const response = await fetch(`${baseURL}${endpoint}`, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "search-wire" }),
          })
          expect(response.status).toBe(401)
          await response.text()
        }
        requests.length = 0
        const provider = {
          id: providerID,
          key: "synthetic-default-key",
          options: { baseURL, headers: providerHeaders },
          models: {
            search: {
              id: "search",
              api: { id: "search-wire", npm: "@ai-sdk/openai" },
              headers: modelHeaders,
              options: locked ? { websearch: "always" } : {},
            },
            chat: {
              id: "chat",
              headers: { "x-model-tenant": "wrong-chat-tenant" },
              options: {},
            },
          },
        }
        const original = structuredClone(provider)
        const backend = createNativeBackend({
          client: {
            config: {
              providers: async () => ({ data: { providers: [provider] } }),
            },
          },
          readAuthStore: async () => ({}),
          warn: () => {},
        })
        const outcome = await backend(
          { enabled: true, timeoutMs: 5_000 },
          { query: "q" },
          async () => ({ providerID, modelID: locked ? "chat" : "search" }),
          signal,
        )
        expect(outcome).toEqual({ kind: "ok", output: "Gateway answered." })
        expect(requests).toHaveLength(providerID === "moonshotai" ? 2 : 1)
        for (const request of requests) {
          expect(new URL(request.url).pathname).toBe(`/v1${endpoint}`)
          for (const [name, value] of Object.entries(expected))
            expect(request.headers.get(name)).toBe(value)
        }
        expect(provider).toEqual(original)
      } finally {
        await gateway.stop(true)
      }
    },
  )
}

test.each(["chatgpt", "copilot"])(
  "%s preserves custom headers but OAuth owns auth/protocol headers",
  async (type) => {
    const expected: Record<string, string> = {
      "content-type": "application/json",
      authorization: "Bearer synthetic-oauth-token",
      "user-agent": "macarons-websearch",
      "x-gateway-auth": "synthetic-gateway-auth",
      "x-model-tenant": "synthetic-model-tenant",
    }
    if (type === "chatgpt") {
      expected.accept = "text/event-stream"
      expected["chatgpt-account-id"] = "synthetic-oauth-account"
    } else {
      expected["openai-intent"] = "conversation-edits"
      expected["x-initiator"] = "agent"
    }
    let calls = 0
    const gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        calls++
        if (
          (type === "copilot" && request.headers.has("x-api-key")) ||
          Object.entries(expected).some(
            ([name, value]) => request.headers.get(name) !== value,
          )
        )
          return Response.json(
            { error: { message: "headers required" } },
            { status: 401 },
          )
        if (type === "copilot")
          return Response.json({
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Gateway answered." }],
              },
            ],
          })
        return new Response(
          'event: response.output_text.delta\ndata: {"delta":"Gateway answered."}\n\nevent: response.completed\ndata: {}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
    })
    try {
      const config = {
        apiKey: "synthetic-oauth-token",
        oauth: true,
        accountId: "synthetic-oauth-account",
        baseURL: `http://127.0.0.1:${gateway.port}`,
        model: "search-wire",
        headers: {
          Authorization: "Bearer wrong-configured-token",
          "ChatGPT-Account-Id": "wrong-configured-account",
          "x-gateway-auth": "synthetic-gateway-auth",
          "x-model-tenant": "synthetic-model-tenant",
          ...(type === "copilot"
            ? {
                "X-Api-Key": "wrong-configured-key",
                "openai-intent": "wrong-configured-intent",
                "user-agent": "wrong-configured-agent",
                "X-Initiator": "agent",
              }
            : {}),
        },
      }
      const search = type === "chatgpt" ? chatgptSearch : copilotSearch
      await expect(search(config, "q", signal)).resolves.toBe(
        "Gateway answered.",
      )
      expect(calls).toBe(1)
    } finally {
      await gateway.stop(true)
    }
  },
)

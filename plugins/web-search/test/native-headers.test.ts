import { expect, test } from "bun:test"
import { chatgptSearch } from "../src/backends/native/chatgpt"
import { copilotSearch } from "../src/backends/native/openai"

const signal = new AbortController().signal
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

test("OpenAI token-sharing OAuth retains the active credential over configured headers", async () => {
  const { openaiSearch } = await import("../src/backends/native/openai")
  let calls = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      calls++
      expect(request.headers.get("authorization")).toBe("Bearer active-oauth")
      expect(request.headers.has("x-api-key")).toBe(false)
      expect(request.headers.get("x-custom")).toBe("preserved")
      return Response.json({
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
    await expect(
      openaiSearch(
        {
          apiKey: "active-oauth",
          oauth: true,
          model: "test",
          baseURL: server.url.origin,
          headers: {
            Authorization: "Bearer stale-key",
            "X-Api-Key": "other-account",
            "X-Custom": "preserved",
          },
        },
        "query",
        signal,
      ),
    ).resolves.toBe("answer")
    expect(calls).toBe(1)
  } finally {
    server.stop(true)
  }
})

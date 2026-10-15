import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { anthropicSearch } from "../src/backends/native/anthropic"
import { chatgptSearch } from "../src/backends/native/chatgpt"
import {
  moonshotBaseURL,
  moonshotSearch,
} from "../src/backends/native/moonshot"
import { copilotSearch, openaiSearch } from "../src/backends/native/openai"
import { formatStructuredResponse } from "../src/backends/native/types"

const never = new AbortController().signal
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
      const search = providerID === "openai" ? openaiSearch : copilotSearch
      const result = search(
        { apiKey: "synthetic-key", baseURL: base(), model: "gpt-x" },
        "solar",
        never,
      )
      if (reason) await expect(result).rejects.toThrow(reason)
      else expect(await result).toContain('No search results found for "solar"')
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

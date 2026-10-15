import { withTimeout } from "@macarons/permission-rules"
import { Plugin } from "@opencode/plugin"
import {
  parseSearxngResults,
  parseSearxngUnresponsiveEngines,
  searxngRequestUrl,
} from "./backends/searxng"
import { nativeSearch } from "./native"
import {
  backendSignal,
  resolveServerOptions,
  safeEndpointLabel,
} from "./shared"

export const WebSearchPlugin = Plugin.define({
  id: "web-search",
  async setup(ctx) {
    const options = resolveServerOptions(ctx.options)
    if (options.searxng.url) {
      const url = options.searxng.url
      await ctx.websearch.transform((editor) => {
        editor.add({
          id: "macarons-searxng",
          name: "SearXNG",
          async execute({ query }, { signal }) {
            const requestURL = searxngRequestUrl(url, { query })
            const requestSignal = backendSignal(
              signal,
              options.searxng.timeoutMs,
            )
            let response: Response
            try {
              response = await fetch(requestURL, {
                headers: { Accept: "application/json" },
                signal: requestSignal,
              })
            } catch {
              requestSignal.throwIfAborted()
              // Transport exceptions can include endpoint userinfo/query
              // credentials. Only the sanitized destination reaches tools.
              throw new Error(
                `SearXNG ${safeEndpointLabel(url)} request failed`,
              )
            }
            if (!response.ok)
              throw new Error(
                `SearXNG ${safeEndpointLabel(url)} answered ${response.status}`,
              )
            const payload: unknown = await response.json()
            const hits = parseSearxngResults(payload)
            if (!hits) throw new Error("SearXNG returned no results array")
            if (!hits.length && parseSearxngUnresponsiveEngines(payload).length)
              throw new Error("SearXNG engines failed")
            return hits.map((hit) => ({
              url: hit.url,
              title: hit.title,
              content: hit.snippet,
              time: {},
            }))
          },
        })
      })
    }
    if (!options.native.enabled) return
    // V2 websearch providers receive no session/model identity. Keep this
    // distinct capability in a tool so its active-provider privacy rule holds.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "provider_search",
        description:
          "Search using the current model provider's own server-side web search. Sends only the query to that same provider. Use the built-in websearch for other search integrations.",
        input: {
          type: "object",
          properties: { query: { type: "string", minLength: 1 } },
          required: ["query"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { query } = input as { query: string }
          if (typeof query !== "string" || !query.trim())
            throw new Error("query must be nonempty")
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: {
              type: "tool",
              messageID: context.messageID,
              id: context.id,
            },
            action: "websearch",
            resources: [query],
            save: ["*"],
          })
          const content = await withTimeout(
            async (signal) => {
              const messages = await ctx.session.context(
                { sessionID: context.sessionID },
                { signal },
              )
              signal.throwIfAborted()
              const message = messages.find(
                (item) => item.id === context.messageID,
              )
              if (message?.type !== "assistant")
                throw new Error(
                  "Cannot determine the requesting model; native search was not sent",
                )
              return nativeSearch(
                ctx,
                message.model,
                query,
                signal,
                options.native.timeoutMs,
              )
            },
            options.native.timeoutMs,
            { signal: context.signal },
          )
          return { content }
        },
      })
    })
  },
})
export default WebSearchPlugin

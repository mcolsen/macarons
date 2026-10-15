import { withTimeout } from "@macarons/permission-rules"
import type { ModelInfo, ProviderInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { anthropicSearch } from "./backends/native/anthropic"
import { chatgptSearch } from "./backends/native/chatgpt"
import { mergeHeaders } from "./backends/native/http"
import { moonshotSearch } from "./backends/native/moonshot"
import { copilotSearch, openaiSearch } from "./backends/native/openai"
import type { SearchConfig } from "./backends/native/types"

export type ActiveModel = { providerID: string; id: string; variant?: string }
type NativeContext = Pick<Plugin.Context, "provider" | "model" | "integration">

type Adapter = "anthropic" | "openai" | "copilot" | "moonshot"
function adapter(provider: ProviderInfo): Adapter | undefined {
  const canonical = provider.canonical ?? provider.id
  if (canonical === "anthropic") return "anthropic"
  if (canonical === "openai") return "openai"
  if (canonical === "github-copilot") return "copilot"
  if (canonical === "moonshotai" || canonical === "moonshotai-cn")
    return "moonshot"
  if (provider.package === "@opencode/ai/providers/anthropic")
    return "anthropic"
  if (provider.package === "@opencode/ai/providers/openai") return "openai"
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

/** Resolve fresh host credentials on every invocation, including account changes. */
export async function searchConfig(
  ctx: NativeContext,
  provider: ProviderInfo,
  model: ModelInfo,
  variant?: string,
): Promise<{ type: Adapter | "chatgpt"; config: SearchConfig }> {
  let type: Adapter | "chatgpt" | undefined = adapter(provider)
  if (!type)
    throw new Error(
      `Provider ${provider.id} has no supported native search adapter`,
    )
  const selected = variant
    ? model.variants.find((item) => item.id === variant)
    : undefined
  const settings = {
    ...provider.settings,
    ...model.settings,
    ...selected?.settings,
  }
  const headers = mergeHeaders(
    provider.headers,
    model.headers,
    selected?.headers,
  )
  let baseURL = text(settings.baseURL)
  let apiKey = text(settings.apiKey)
  let accountId: string | undefined
  let oauth = false
  if (!apiKey) {
    const connection = provider.integrationID
      ? await ctx.integration.connection.active(provider.integrationID)
      : undefined
    const credential = connection
      ? await ctx.integration.connection.resolve(connection)
      : undefined
    if (credential?.type === "key") apiKey = credential.key
    else if (credential?.type === "oauth") {
      if (credential.expires > 0 && credential.expires <= Date.now())
        throw new Error(
          "Native search credential has expired; reconnect the provider",
        )
      if (
        type === "openai" &&
        provider.id === "openai" &&
        ["chatgpt-browser", "chatgpt-headless"].includes(credential.methodID)
      ) {
        const expected = "https://chatgpt.com/backend-api/codex"
        if (baseURL && baseURL.replace(/\/$/, "") !== expected)
          throw new Error(
            "Refusing to send ChatGPT OAuth credentials to a custom search endpoint",
          )
        type = "chatgpt"
        apiKey = credential.access
        baseURL = expected
        accountId = text(credential.metadata?.accountID)
        oauth = true
      } else if (
        type === "openai" &&
        provider.id === "openai" &&
        credential.methodID === "chatgpt-token-sharing"
      ) {
        const expected = "https://api.openai.com/v1"
        if (baseURL && baseURL.replace(/\/$/, "") !== expected)
          throw new Error(
            "Refusing to send ChatGPT token-sharing credentials to a custom search endpoint",
          )
        apiKey = credential.access
        baseURL = expected
        oauth = true
      } else if (type === "copilot" && provider.id === "github-copilot") {
        // The host's Copilot integration uses the GitHub OAuth grant for inference.
        const endpoint = text(credential.metadata?.apiEndpoint)
        const enterprise = text(credential.metadata?.enterpriseUrl)
          ?.replace(/^https?:\/\//, "")
          .replace(/\/$/, "")
        const expected =
          endpoint ??
          (enterprise
            ? `https://copilot-api.${enterprise}`
            : "https://api.githubcopilot.com")
        if (
          baseURL &&
          baseURL.replace(/\/v1\/?$/, "").replace(/\/$/, "") !==
            expected.replace(/\/$/, "")
        )
          throw new Error(
            "Refusing to send Copilot OAuth credentials to a custom search endpoint",
          )
        apiKey = credential.refresh
        baseURL = expected
        oauth = true
      } else
        throw new Error(
          "This provider's OAuth method does not support native search",
        )
    }
  }
  if (!apiKey || apiKey === "opencode-oauth-dummy-key")
    throw new Error(`No usable native search credential for ${provider.id}`)
  if (baseURL) {
    let url: URL
    try {
      url = new URL(baseURL)
    } catch {
      throw new Error("Invalid native search endpoint")
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Invalid native search endpoint")
    if (type === "anthropic") baseURL = baseURL.replace(/\/v1\/?$/, "")
  }
  return {
    type,
    config: {
      apiKey,
      baseURL,
      headers,
      model: model.modelID,
      accountId,
      oauth,
    },
  }
}

export function nativeSearch(
  ctx: NativeContext,
  active: ActiveModel,
  query: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  return withTimeout(
    async (timeoutSignal) => {
      const { data: provider } = await ctx.provider.get(
        { providerID: active.providerID },
        { signal: timeoutSignal },
      )
      const models = (
        await ctx.model.list(undefined, { signal: timeoutSignal })
      ).data.filter(
        (item) => item.providerID === active.providerID && item.enabled,
      )
      const current = models.find((model) => model.id === active.id)
      const locked = models.find(
        (model) => model.settings?.websearch === "always",
      )
      const fallback = models.find(
        (model) => model.settings?.websearch === "auto",
      )
      const candidates = locked
        ? [locked]
        : [current, fallback].filter(
            (model): model is ModelInfo => model !== undefined,
          )
      const seen = new Set<string>()
      let lastError: unknown
      for (const model of candidates) {
        if (seen.has(model.id)) continue
        seen.add(model.id)
        timeoutSignal.throwIfAborted()
        try {
          const { type, config } = await searchConfig(
            ctx,
            provider,
            model,
            model.id === active.id ? active.variant : undefined,
          )
          timeoutSignal.throwIfAborted()
          switch (type) {
            case "anthropic":
              return await anthropicSearch(config, query, timeoutSignal)
            case "openai":
              return await openaiSearch(config, query, timeoutSignal)
            case "chatgpt":
              return await chatgptSearch(config, query, timeoutSignal)
            case "copilot":
              return await copilotSearch(config, query, timeoutSignal)
            case "moonshot":
              return await moonshotSearch(
                provider.canonical ?? provider.id,
                config,
                query,
                timeoutSignal,
              )
          }
        } catch (error) {
          timeoutSignal.throwIfAborted()
          lastError = error
        }
      }
      if (lastError) throw lastError
      throw new Error(
        `No enabled search model on provider ${active.providerID}`,
      )
    },
    timeoutMs,
    { signal },
  )
}

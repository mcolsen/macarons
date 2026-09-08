import { makeTuiApi } from "@macarons/plugin-test-harness/tui"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { tui } from "../src/tui"

type Api = Parameters<TuiPlugin>[0]

export function makeApi(
  input: {
    version?: string | null
    baseUrl?: string
    routeName?: string
    sessionModelProviderID?: string
    configModel?: string
    configApiKey?: string
    effectiveApiKey?: string
    effectiveKey?: string
    parentID?: string
  } = {},
) {
  const base = makeTuiApi({
    version: input.version,
    baseUrl: input.baseUrl,
    routeName: input.routeName,
    paths: {
      config: "/nonexistent/synthetic-limits-test/config",
      state: "/nonexistent/synthetic-limits-test/state",
      worktree: "/",
      directory: "/nonexistent/synthetic-limits-test/project",
    },
  })
  base.api.state.config = {
    model: input.configModel,
    provider: input.configApiKey
      ? { synthetic: { options: { apiKey: input.configApiKey } } }
      : undefined,
  }
  base.api.state.provider = [
    {
      id: "synthetic",
      name: "Synthetic",
      source: "config",
      env: [],
      ...(input.effectiveKey ? { key: input.effectiveKey } : {}),
      options: input.effectiveApiKey ? { apiKey: input.effectiveApiKey } : {},
      models: {},
    },
  ]
  base.api.state.session = {
    get: (sessionID: string) => ({
      id: sessionID,
      parentID: input.parentID,
      model: input.sessionModelProviderID
        ? { id: "some-model", providerID: input.sessionModelProviderID }
        : undefined,
    }),
    messages: () => [],
    status: () => undefined,
  }

  return {
    ...base,
    load: (options?: Record<string, unknown>) =>
      tui(base.api as unknown as Api, options, {} as never),
  }
}

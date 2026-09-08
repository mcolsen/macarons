import { afterEach, beforeEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import type { Config } from "@opencode-ai/plugin"
import { CodexLimitsPlugin } from "../src/index"

const originalAuth = process.env.OPENCODE_AUTH_CONTENT
const originalDisabled = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
beforeEach(() => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    openai: {
      type: "oauth",
      access: "test-access",
      refresh: "test-refresh",
      accountId: "test-account",
      expires: 9999999999999,
    },
  })
  process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "0"
})
afterEach(() => {
  if (originalAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = originalAuth
  if (originalDisabled === undefined)
    delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
  else process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = originalDisabled
})

async function probe(config?: Config, mutate?: () => void) {
  const commands: string[] = []
  const hooks = await CodexLimitsPlugin({
    client: {
      global: { health: async () => ({ data: { version: BAND.floor } }) },
      app: { log: async () => ({}) },
      tui: {
        publish: async (input: {
          body: { properties: { command: string } }
        }) => {
          commands.push(input.body.properties.command)
          return { data: true }
        },
      },
    },
    directory: "/project",
    serverUrl: new URL("http://opencode.internal"),
  } as never)
  try {
    if (config) await hooks.config?.(config)
    mutate?.()
    await hooks.event?.({
      event: {
        type: "tui.command.execute",
        properties: { command: `macarons.codex-auth.v1:probe:${randomUUID()}` },
      },
    })
    expect(commands).toHaveLength(1)
    return commands[0]
  } finally {
    await hooks.dispose?.()
  }
}

test.each(["1", "true", "yes", "on", "y"])(
  "does not attest inactive OAuth with default plugins disabled by %s",
  async (value) => {
    process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = value
    expect(
      await probe({
        provider: { openai: { options: { apiKey: "configured-api-key" } } },
      }),
    ).toEndWith(":unavailable")
  },
)

test.each(["0", "false", "no", "off", "n"])(
  "allows bundled OAuth with a configured API key and false flag %s",
  async (value) => {
    process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = value
    expect(
      await probe({
        provider: { openai: { options: { apiKey: "configured-api-key" } } },
      }),
    ).toMatch(/:[0-9a-f]{64}$/)
  },
)

const inactiveConfigs: Array<Config | undefined> = [
  undefined,
  { disabled_providers: ["openai"] },
  { enabled_providers: ["anthropic"] },
  { provider: { openai: { options: { fetch: null } } } },
  { provider: { openai: { options: { fetch: () => {} } } } },
]
test.each(inactiveConfigs)(
  "refuses absent config, excluded providers, and explicit fetch replacement: %o",
  async (config) => {
    expect(await probe(config)).toEndWith(":unavailable")
  },
)

test("observes a later config hook replacing Codex fetch", async () => {
  const config: Config = {}
  expect(
    await probe(config, () => {
      config.provider = { openai: { options: { fetch: null } } }
    }),
  ).toEndWith(":unavailable")
})

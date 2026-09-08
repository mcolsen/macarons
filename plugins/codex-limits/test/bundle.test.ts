import { expect, test } from "bun:test"
import { createHmac, randomUUID } from "node:crypto"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import { describeBundle } from "@macarons/plugin-test-harness"

const bundle = describeBundle({
  testDir: import.meta.dir,
  exportName: "CodexLimitsPlugin",
})

test("the standalone companion proves server credentials without publishing them", async () => {
  const mod = (await bundle.importArtifact()) as unknown as {
    CodexLimitsPlugin: (input: unknown) => Promise<{
      event: (input: unknown) => Promise<void>
      config: (input: unknown) => Promise<void>
      dispose: () => Promise<void>
    }>
  }
  const original = process.env.OPENCODE_AUTH_CONTENT
  const originalDisabled = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
  process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "0"
  const record = {
    type: "oauth",
    access: "bundle-access",
    refresh: "bundle-refresh",
    accountId: "bundle-account",
    expires: 9999999999999,
  }
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: record })
  const published: unknown[] = []
  const hooks = await mod.CodexLimitsPlugin({
    client: {
      global: { health: async () => ({ data: { version: BAND.floor } }) },
      app: { log: async () => ({}) },
      tui: {
        publish: async (input: unknown) => {
          published.push(input)
          return { data: true }
        },
      },
    },
    directory: "/server-project",
    serverUrl: new URL("http://opencode.internal"),
  })
  try {
    await hooks.config({})
    expect(published).toHaveLength(0)
    const nonce = randomUUID()
    const digest = createHmac("sha256", record.access)
      .update(
        JSON.stringify([
          "macarons.codex-auth.v1",
          nonce,
          record.refresh,
          record.expires,
          record.accountId,
        ]),
      )
      .digest("hex")
    await hooks.event({
      event: {
        type: "tui.command.execute",
        properties: { command: `macarons.codex-auth.v1:probe:${nonce}` },
      },
    })
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      query: { directory: "/server-project" },
      body: {
        type: "tui.command.execute",
        properties: {
          command: `macarons.codex-auth.v1:result:${nonce}:${digest}`,
        },
      },
    })
    expect(JSON.stringify(published)).not.toMatch(
      /bundle-access|bundle-refresh|bundle-account/,
    )
  } finally {
    await hooks.dispose()
    if (original === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = original
    if (originalDisabled === undefined)
      delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
    else process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = originalDisabled
  }
})

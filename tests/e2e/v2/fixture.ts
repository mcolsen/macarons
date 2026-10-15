import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/client"
import {
  createProgrammableProvider,
  type ProviderReply,
  type RespondContext,
} from "../harness/programmable-provider"
import { createSandbox } from "../harness/sandbox"
import { waitFor } from "../harness/wait"
import { startOpenCode } from "./process"
export const ROOT = path.resolve(import.meta.dir, "../../..")
export const pluginURL = (name: string) =>
  pathToFileURL(path.join(ROOT, "plugins", name)).href
export const SERVER_PLUGINS = [
  "cron",
  "redact-secrets",
  "scoped-system-prompts",
  "web-search",
  "codex-limits",
  "synthetic-limits",
  "approve-for-me",
]
export async function fixture(
  input: {
    plugins?: unknown[]
    config?: Record<string, unknown>
    respond?: (context: RespondContext) => ProviderReply
  } = {},
) {
  const sandbox = await createSandbox("v2")
  const provider = createProgrammableProvider({
    respond:
      input.respond ?? (() => ({ kind: "text", text: "fixture complete" })),
  })
  await provider.waitUntilReady()
  const env = await sandbox.environment("server", {
    OPENCODE_SERVER_PASSWORD: "macarons-e2e-only",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: undefined,
  })
  const config = {
    model: "fixture/model",
    update: "disable",
    share: "disabled",
    snapshots: false,
    providers: {
      fixture: {
        name: "Fixture",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: provider.baseURL, apiKey: "fixture-key" },
        models: {
          model: {
            name: "Fixture model",
            limit: { context: 100000, output: 4000 },
            capabilities: { tools: true },
          },
        },
      },
    },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
    plugins: input.plugins ?? [],
    ...input.config,
  }
  await fs.writeFile(
    path.join(sandbox.config, "opencode.json"),
    JSON.stringify(config),
  )
  try {
    const process = await startOpenCode({
      cwd: sandbox.project,
      env,
      timeout: 60000,
    })
    const client = OpenCode.make({
      baseUrl: process.url,
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
      },
    })
    let ready = await client.plugin.list({
      location: { directory: sandbox.project },
    })
    const expected = input.plugins?.length ?? 0
    await waitFor(
      async () => {
        ready = await client.plugin.list({
          location: { directory: sandbox.project },
        })
        const external = ready.data.filter(
          (plugin) => plugin.source.type !== "builtin",
        )
        const failed = external.find(
          (plugin) => plugin.state.status === "failed",
        )
        if (failed) throw new Error(JSON.stringify(failed))
        return (
          external.length >= expected &&
          external.every((plugin) => plugin.state.status === "active")
        )
      },
      { description: "native plugin startup", timeout: 30000 },
    )
    return {
      sandbox,
      provider,
      env,
      process,
      client,
      ready,
      async dispose() {
        await process.stop()
        await provider.close()
        await sandbox.cleanup()
      },
    }
  } catch (error) {
    await provider.close()
    await sandbox.cleanup()
    throw error
  }
}
export async function prompt(
  host: Awaited<ReturnType<typeof fixture>>,
  text: string,
) {
  const session = await host.client.session.create({
    location: { directory: host.sandbox.project },
    title: "Macarons migration",
  })
  await host.client.session.prompt({ sessionID: session.id, text })
  try {
    await waitFor(
      async () =>
        (await host.client.session.context({ sessionID: session.id })).some(
          (message) =>
            message.type === "assistant" &&
            message.time.completed !== undefined,
        ),
      { description: "completed v2 response", timeout: 45000 },
    )
  } catch (error) {
    await host.process.writeDiagnostics(host.sandbox.artifacts)
    await fs.writeFile(
      path.join(host.sandbox.artifacts, "fixture-requests.json"),
      JSON.stringify(host.provider.requests, null, 2),
    )
    await fs.writeFile(
      path.join(host.sandbox.artifacts, "pending-permissions.json"),
      JSON.stringify(
        await host.client.permission.list({ sessionID: session.id }),
        null,
        2,
      ),
    )
    await fs.writeFile(
      path.join(host.sandbox.artifacts, "session.json"),
      JSON.stringify(
        await host.client.session.context({ sessionID: session.id }),
        null,
        2,
      ),
    )
    console.error(
      `V2 fixture diagnostics: ${await host.sandbox.preserve("native-request-failure")}`,
    )
    throw error
  }
  return session
}

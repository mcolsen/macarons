import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { readJevApiKey } from "../../../plugins/approve-for-me/src/server/jev-auth"
import { resolveOpenCodeBinary } from "../harness/opencode-binary"
import {
  type OpenCodeProcess,
  runOpenCodeCommand,
  startOpenCode,
} from "../harness/opencode-process"
import {
  AUTO_APPROVE_SERVER_ENTRY,
  blessAutoApproveProjectConfig,
  readJson,
} from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"

const ENV_KEY = "e2e-typesafe-environment-not-a-secret"
const FIRST_KEY = "e2e-typesafe-first-not-a-secret"
const REPLACEMENT_KEY = "e2e-typesafe-replacement-not-a-secret"

async function configure(sandbox: Sandbox) {
  // An empty catalog proves login comes from the plugin's auth hook rather
  // than a models.dev entry. No fake Jev chat model or model endpoint exists.
  const modelsPath = path.join(sandbox.root, "models.json")
  await fs.writeFile(modelsPath, "{}\n")
  await fs.writeFile(
    path.join(sandbox.project, "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: [pathToFileURL(AUTO_APPROVE_SERVER_ENTRY).href],
      },
      null,
      2,
    )}\n`,
  )
  const env = await sandbox.environment("server", {
    OPENCODE_MODELS_PATH: modelsPath,
    TYPESAFE_API_KEY: ENV_KEY,
  })
  // The sandbox's default "{}" override would hide every auth.json update.
  // Delete it explicitly: environment() ignores undefined extra values.
  delete env.OPENCODE_AUTH_CONTENT
  if (!env.XDG_STATE_HOME) throw new Error("sandbox omitted XDG_STATE_HOME")
  await blessAutoApproveProjectConfig(env.XDG_STATE_HOME, sandbox.project)
  return env
}

async function retainFailure(
  sandbox: Sandbox,
  server: OpenCodeProcess | undefined,
  observations: Record<string, unknown>,
) {
  if (server)
    await server.writeDiagnostics(path.join(sandbox.artifacts, "server"))
  await fs.writeFile(
    path.join(sandbox.artifacts, "auth-observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  )
  const artifact = await sandbox.preserve("approve-for-me-auth")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("TypeSafe login against the real OpenCode host", () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("advertises API auth and observes connect, replacement, and logout without chat models", async () => {
    const sandbox = await createSandbox("approve-for-me-auth")
    let server: OpenCodeProcess | undefined
    const observations: Record<string, unknown> = {}
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => server?.stop())

    try {
      const env = await configure(sandbox)
      const dataHome = env.XDG_DATA_HOME
      if (!dataHome) throw new Error("sandbox omitted XDG_DATA_HOME")
      const authFile = path.join(dataHome, "opencode", "auth.json")
      const authInput = { env, homedir: sandbox.home }
      expect(await readJevApiKey(authInput)).toBe(ENV_KEY)

      server = await startOpenCode({ cwd: sandbox.project, env })
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: sandbox.project,
      })
      const methods = await client.provider.auth()
      observations.methods = methods.data ?? methods.error
      expect(methods.error).toBeUndefined()
      expect(methods.data?.typesafe).toEqual([
        { type: "api", label: "TypeSafe API key" },
      ])

      const config = await client.config.get()
      observations.providerConfig = config.data?.provider ?? config.error
      expect(config.error).toBeUndefined()
      expect(config.data?.provider?.typesafe).toMatchObject({
        name: "TypeSafe (Jev)",
        env: ["TYPESAFE_API_KEY"],
        models: {},
      })

      async function expectNoChatModels(stage: string) {
        const providers = await client.provider.list()
        observations[`providers-${stage}`] = providers.data ?? providers.error
        expect(providers.error).toBeUndefined()
        expect(providers.data).toBeDefined()
        // The pinned host prunes zero-model providers, so TypeSafe need not
        // appear in /provider (or the stock TUI's named /connect picker).
        expect(
          providers.data?.all.flatMap((provider) =>
            Object.keys(provider.models),
          ),
        ).toEqual([])
      }
      await expectNoChatModels("before-connect")

      for (const [stage, key] of [
        ["connect", FIRST_KEY],
        ["replace", REPLACEMENT_KEY],
      ] as const) {
        // This is the host-owned API-key persistence path used by /connect.
        // Auth.set only stores these synthetic fixtures; no Jev call is made.
        const saved = await client.auth.set({
          providerID: "typesafe",
          auth: { type: "api", key },
        })
        expect(saved.error).toBeUndefined()
        expect(saved.data).toBe(true)
        const store = await readJson<Record<string, unknown>>(authFile)
        observations[`auth-${stage}`] = store
        expect(store.typesafe).toEqual({ type: "api", key })
        // Reuse the same input/reader: the saved key beats the environment
        // fallback, and replacing it is visible without a plugin restart.
        expect(await readJevApiKey(authInput)).toBe(key)
        await expectNoChatModels(stage)
      }

      const removed = await client.auth.remove({ providerID: "typesafe" })
      expect(removed.error).toBeUndefined()
      expect(removed.data).toBe(true)
      const store = await readJson<Record<string, unknown>>(authFile)
      observations["auth-logout"] = store
      expect(store.typesafe).toBeUndefined()
      expect(await readJevApiKey(authInput)).toBe(ENV_KEY)
      expect(
        await readJevApiKey({
          ...authInput,
          env: { ...env, TYPESAFE_API_KEY: undefined },
        }),
      ).toBeUndefined()
      await expectNoChatModels("logout")
    } catch (error) {
      await retainFailure(sandbox, server, observations)
      throw error
    }
  })

  test("CLI recognizes the plugin-only TypeSafe provider without a catalog entry", async () => {
    const sandbox = await createSandbox("approve-for-me-auth-cli")
    const observations: Record<string, unknown> = {}
    cleanups.push(async () => sandbox.cleanup())

    try {
      const env = await configure(sandbox)
      delete env.TYPESAFE_API_KEY
      // Send Ctrl-C through stdin: EOF alone leaves the host's key prompt
      // waiting. The managed shell keeps the CLI in the harness process group.
      const result = await runOpenCodeCommand({
        binary: "sh",
        cwd: sandbox.project,
        env,
        args: [
          "-c",
          'printf "\\003" | "$1" auth login --provider typesafe',
          "typesafe-login",
          await resolveOpenCodeBinary(),
        ],
        timeout: 20_000,
      })
      observations.cli = result
      const output = `${result.stdout}\n${result.stderr}`
      // The host exits 1 on prompt cancellation, without killing the process.
      expect(result.code).toBe(1)
      expect(result.signal).toBeNull()
      expect(output).toContain("Enter your API key")
      expect(output).not.toMatch(/unknown provider|provider not found/i)
      expect(
        await readJevApiKey({ env, homedir: sandbox.home }),
      ).toBeUndefined()
    } catch (error) {
      await retainFailure(sandbox, undefined, observations)
      throw error
    }
  })
})

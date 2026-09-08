import { afterEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import {
  createOpencodeClient,
  type Event,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2"
import {
  placeholderFor,
  secretHash,
} from "../../../plugins/redact-secrets/src/shared"
import { EventRecorder } from "../harness/events"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import {
  AUTO_APPROVE_ROOT,
  blessAutoApproveProjectConfig,
  ENV_PROVIDER_ID,
  ENV_PROVIDER_KEY_VAR,
  REDACT_SECRETS_ROOT,
  writeAutoApproveSettings,
  writeRedactSecretsConfig,
  writeRedactSecretsEnvProviderProject,
} from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import {
  createScriptedProvider,
  type ScriptedProvider,
} from "../harness/scripted-provider"
import { waitFor } from "../harness/wait"

// End-to-end against a real, version-pinned OpenCode: a fake GitHub PAT is
// planted in the project's .env, the scripted model cats it (so the secret
// enters a tool result) and then echoes the PLACEHOLDER into a file via a
// second bash call. The assertions are the plugin's whole contract:
//
//   1. the raw secret never appears in ANY request body the provider saw,
//   2. the tool result reached the model with the placeholder instead,
//   3. the system prompt carried the placeholder explanation,
//   4. the file written from the placeholder holds the REAL secret — proving
//      tool.execute.before restored it at the execution boundary.
//
// The placeholder is a keyed function of the secret (HMAC under a random
// per-install key), so the test plants a KNOWN key in the instance data dir
// before the server starts, then computes the placeholder up front from that
// same key and bakes it into the scripted command.

const FAKE_PAT = "ghp_x7K2mQ9pL4vN8rT3wY6bJ1hF5dS0aZcE2gUq"
const E2E_KEY =
  "e2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee"
const PLACEHOLDER = placeholderFor("github-pat", secretHash(FAKE_PAT, E2E_KEY))
const RAW_FIRST_39 = FAKE_PAT.slice(0, 39)
const execFileAsync = promisify(execFile)

const HISTORY_SOURCE_MARKER = "HISTORY_SOURCE_MARKER"
const HISTORICAL_TOOL_TITLE = "historical-private-tool-title"

function secretFragmentAtCut(prefix: string, cut: number): string {
  const start = cut - RAW_FIRST_39.length
  if (prefix.length > start) throw new Error(`prefix exceeds ${cut}-char cut`)
  return `${prefix}${"x".repeat(start - prefix.length)}${FAKE_PAT}`
}

const HISTORY_SOURCE = secretFragmentAtCut(`${HISTORY_SOURCE_MARKER} `, 2_000)

type BundleOrder = "redact-first" | "approve-first"

async function buildInteropBundles(sandbox: Sandbox) {
  const directory = path.join(sandbox.root, "interop-bundles")
  await fs.mkdir(directory, { recursive: true })
  const redact = path.join(directory, "redact-secrets.js")
  const approve = path.join(directory, "approve-for-me.js")
  await Promise.all([
    execFileAsync(
      "bun",
      ["build", "src/index.ts", "--target=bun", `--outfile=${redact}`],
      { cwd: REDACT_SECRETS_ROOT },
    ),
    execFileAsync(
      "bun",
      ["build", "src/index.ts", "--target=bun", `--outfile=${approve}`],
      { cwd: AUTO_APPROVE_ROOT },
    ),
  ])
  await Promise.all([import(redact), import(approve)])
  return { approve, redact }
}

async function writeInteropProject(
  sandbox: Sandbox,
  sessionProviderURL: string,
  judgeProviderURL: string,
  bundles: { approve: string; redact: string },
  order: BundleOrder,
) {
  const ordered =
    order === "redact-first"
      ? [bundles.redact, bundles.approve]
      : [bundles.approve, bundles.redact]
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "session/test",
    provider: {
      session: {
        npm: "@ai-sdk/openai-compatible",
        name: "E2E session provider",
        options: { apiKey: "e2e-not-a-secret", baseURL: sessionProviderURL },
        models: {
          test: {
            name: "E2E session model",
            limit: { context: 32_000, output: 4_096 },
          },
        },
      },
      judge: {
        npm: "@ai-sdk/openai-compatible",
        name: "E2E classifier provider",
        options: { apiKey: "e2e-not-a-secret", baseURL: judgeProviderURL },
        models: {
          classifier: {
            name: "E2E classifier model",
            limit: { context: 32_000, output: 4_096 },
          },
        },
      },
    },
    permission: {
      bash: {
        "*": "ask",
        [`printf '${HISTORICAL_TOOL_TITLE}'`]: "allow",
      },
    },
    plugin: ordered.map((entry) => pathToFileURL(entry).href),
  }
  await fs.writeFile(
    path.join(sandbox.project, "opencode.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  )
}

// Plant the fixed placeholder key at the path the plugin reads
// (<XDG_DATA_HOME>/opencode/redact-secrets.key) so its fingerprints match the
// PLACEHOLDER computed above, instead of a random key minted on first run.
// A bare 32-char value: generic-api-key needs a field name beside it, so it
// travels unredacted until a later turn supplies one — the shape stableHistory
// exists for.
const LATE_VALUE = "x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce"

/** Write the plugin's own options file into an instance's config dir. */
async function writePluginOptions(
  env: Record<string, string>,
  options: Record<string, unknown>,
): Promise<void> {
  const configHome = env.XDG_CONFIG_HOME
  if (configHome === undefined) {
    throw new Error("XDG_CONFIG_HOME missing from sandbox environment")
  }
  const dir = path.join(configHome, "opencode")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "redact-secrets.json"),
    `${JSON.stringify(options, null, 2)}\n`,
  )
}

async function plantPlaceholderKey(env: Record<string, string>): Promise<void> {
  const dataHome = env.XDG_DATA_HOME
  if (dataHome === undefined) {
    throw new Error("XDG_DATA_HOME missing from sandbox environment")
  }
  const dir = path.join(dataHome, "opencode")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "redact-secrets.key"), E2E_KEY)
}

type SessionIdle = Extract<Event, { type: "session.idle" }>
type PermissionReplied = Extract<Event, { type: "permission.replied" }>
const isIdle =
  (sessionID: string) =>
  (event: Event): event is SessionIdle =>
    event.type === "session.idle" && event.properties.sessionID === sessionID

const isReplied =
  (sessionID: string) =>
  (event: Event): event is PermissionReplied =>
    event.type === "permission.replied" &&
    event.properties.sessionID === sessionID

function clientFor(server: OpenCodeProcess, directory: string): OpencodeClient {
  return createOpencodeClient({ baseUrl: server.url, directory })
}

async function createSession(
  client: OpencodeClient,
  directory: string,
  title?: string,
) {
  // No title on purpose in the side-channel test: only a session still
  // carrying its default title gets a generated one.
  const result = await client.session.create(
    title === undefined ? { directory } : { directory, title },
  )
  if (result.error || !result.data)
    throw new Error(`Could not create session: ${JSON.stringify(result.error)}`)
  return result.data.id
}

async function prompt(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
  text: string,
  providerID = "e2e",
) {
  const result = await client.session.promptAsync({
    directory,
    sessionID,
    model: { providerID, modelID: "test" },
    parts: [{ type: "text", text }],
  })
  if (result.error)
    throw new Error(`Could not prompt: ${JSON.stringify(result.error)}`)
}

async function writeArtifacts(
  sandbox: Sandbox,
  provider: ScriptedProvider,
  processes: OpenCodeProcess[],
) {
  await Promise.all(
    processes.map((process, index) =>
      process.writeDiagnostics(
        path.join(sandbox.artifacts, `server-${index + 1}`),
      ),
    ),
  )
  await fs.writeFile(
    path.join(sandbox.artifacts, "provider-requests.json"),
    `${JSON.stringify(provider.requests, null, 2)}\n`,
  )
  const artifact = await sandbox.preserve("redact-secrets-server")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("redact-secrets against a real OpenCode server", () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("a secret read from disk never reaches the provider, yet tools get the real value back", async () => {
    const sandbox = await createSandbox("redact-secrets-server")
    const provider = createScriptedProvider({
      commands: ["cat .env", `printf '%s' '${PLACEHOLDER}' > restored.txt`],
      finalText: "Read the env and wrote the token where you asked.",
    })
    const processes: OpenCodeProcess[] = []
    const recorders: EventRecorder[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => {
      for (const recorder of recorders) await recorder.close()
    })
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await provider.ready
      await fs.writeFile(
        path.join(sandbox.project, ".env"),
        `GITHUB_TOKEN=${FAKE_PAT}\n`,
      )
      await writeRedactSecretsConfig(sandbox.project, provider.baseURL)
      const env = await sandbox.environment("redact-secrets")
      await plantPlaceholderKey(env)
      const server = await startOpenCode({ cwd: sandbox.project, env })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      const session = await createSession(
        client,
        sandbox.project,
        "Secret redaction session",
      )
      const mark = events.mark()
      await prompt(
        client,
        sandbox.project,
        session,
        "Read .env and copy the token into restored.txt.",
      )
      await events.waitFor(isIdle(session), {
        after: mark,
        description: "scripted turn finished",
        timeout: 60_000,
      })

      // The turn made three completion requests: the user turn, the cat
      // result round, and the printf result round.
      await waitFor(async () => provider.requests.length >= 3, {
        description: "three completion requests",
      })

      // 1. The raw secret is in none of them — the core guarantee.
      for (const request of provider.requests) {
        expect(JSON.stringify(request)).not.toContain(FAKE_PAT)
      }

      // 2. The cat output reached the model with the placeholder in its place.
      const withToolResult = provider.requests.map((request) =>
        JSON.stringify(request),
      )
      expect(withToolResult.some((body) => body.includes(PLACEHOLDER))).toBe(
        true,
      )

      // 3. The system prompt taught the model about placeholders.
      expect(
        withToolResult.some((body) =>
          body.includes("[REDACTED-SECRET:rule-id:"),
        ),
      ).toBe(true)

      // 4. The placeholder in the scripted bash command was restored to the
      //    real secret before execution.
      await waitFor(
        async () => {
          try {
            return (
              (await fs.readFile(
                path.join(sandbox.project, "restored.txt"),
                "utf8",
              )) === FAKE_PAT
            )
          } catch {
            return false
          }
        },
        { description: "restored.txt holds the real secret", timeout: 20_000 },
      )
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes)
      throw error
    }
  }, 90_000)

  test("title generation on an env-key-loaded provider passes the wire backstop", async () => {
    // The provider has NO opencode.json entry: it activates purely from a
    // models.dev catalog entry plus its API-key env var, the way /connect and
    // plain exported keys load providers. The session keeps its default
    // title, so the host generates one from the first user message — a
    // request that bypasses the chat transforms entirely. Only the injected
    // wire backstop stands between a secret pasted into that first message
    // and the provider.
    const sandbox = await createSandbox("redact-secrets-title")
    const provider = createScriptedProvider({ finalText: "Noted." })
    const processes: OpenCodeProcess[] = []
    const recorders: EventRecorder[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => {
      for (const recorder of recorders) await recorder.close()
    })
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await provider.ready
      const modelsPath = path.join(sandbox.root, "models.json")
      await writeRedactSecretsEnvProviderProject(
        sandbox.project,
        modelsPath,
        provider.baseURL,
      )
      const env = await sandbox.environment("redact-secrets-title", {
        [ENV_PROVIDER_KEY_VAR]: "e2e-not-a-secret",
        // Point host AND plugin at the crafted snapshot, and keep the
        // background refresher from replacing it with the real catalog.
        OPENCODE_MODELS_PATH: modelsPath,
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      })
      await plantPlaceholderKey(env)
      const server = await startOpenCode({ cwd: sandbox.project, env })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)

      const session = await createSession(client, sandbox.project) // default title
      const mark = events.mark()
      await prompt(
        client,
        sandbox.project,
        session,
        `My personal access token is ${FAKE_PAT} — please remember it for later.`,
        ENV_PROVIDER_ID,
      )
      await events.waitFor(isIdle(session), {
        after: mark,
        description: "scripted turn finished",
        timeout: 60_000,
      })

      // The chat completion plus the title generation both hit the provider.
      const isTitleRequest = (request: unknown) =>
        JSON.stringify(request).includes("Generate a title")
      await waitFor(async () => provider.requests.some(isTitleRequest), {
        description: "title generation request arrived",
        timeout: 20_000,
      })

      // The raw secret is in NO request — the title one included — and the
      // title request proves it went out with the placeholder instead.
      for (const request of provider.requests) {
        expect(JSON.stringify(request)).not.toContain(FAKE_PAT)
      }
      const titleRequest = provider.requests.find(isTitleRequest)
      expect(JSON.stringify(titleRequest)).toContain(PLACEHOLDER)
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes)
      throw error
    }
  }, 90_000)

  test("history already sent stays byte-stable once the value becomes detectable", async () => {
    // stableHistory end to end, and the only place the delivery signal it
    // depends on can be checked: a pin stays invisible until the plugin sees
    // an assistant part for that session on the host's event bus, so if that
    // hook never fired the replay below would come back redacted.
    //
    // The wire backstop is off for this run on purpose. It re-inspects the
    // whole serialized body against the current vault with no way to tell
    // replayed history from new content, so with it on the raw replay is
    // masked at the wire regardless of the pin — the documented scope limit.
    const sandbox = await createSandbox("redact-secrets-stable")
    const provider = createScriptedProvider({ finalText: "Understood." })
    const processes: OpenCodeProcess[] = []
    const recorders: EventRecorder[] = []
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => {
      for (const recorder of recorders) await recorder.close()
    })
    cleanups.push(async () => {
      for (const process of processes.reverse()) await process.stop()
    })

    try {
      await provider.ready
      await writeRedactSecretsConfig(sandbox.project, provider.baseURL)
      const env = await sandbox.environment("redact-secrets-stable")
      await plantPlaceholderKey(env)
      await writePluginOptions(env, { wireBackstop: false })
      const server = await startOpenCode({ cwd: sandbox.project, env })
      processes.push(server)
      const client = clientFor(server, sandbox.project)
      const events = await EventRecorder.connect(client)
      recorders.push(events)
      const session = await createSession(
        client,
        sandbox.project,
        "Stable history session",
      )

      // Turn 1: a bare 32-char value. generic-api-key needs a field name
      // beside it, so nothing recognizes it yet and it goes out in the clear.
      const firstMark = events.mark()
      await prompt(
        client,
        sandbox.project,
        session,
        `Remember this build id: ${LATE_VALUE}`,
      )
      await events.waitFor(isIdle(session), {
        after: firstMark,
        description: "first turn finished",
        timeout: 60_000,
      })
      expect(JSON.stringify(provider.requests)).toContain(LATE_VALUE)

      // Turn 2: the same value behind a field name, which vaults it. This
      // turn cannot discriminate on its own — the turn-1 message is walked
      // before the field name is reached, so it is still raw either way.
      const secondMark = events.mark()
      await prompt(
        client,
        sandbox.project,
        session,
        `Now store it as api_key = ${LATE_VALUE}`,
      )
      await events.waitFor(isIdle(session), {
        after: secondMark,
        description: "second turn finished",
        timeout: 60_000,
      })

      // Turn 3 is the one that decides it: the vault has known the value
      // since turn 2, so the retroactive exact-match sweep would rewrite the
      // turn-1 message the host replays here. The pin is what stops it.
      const thirdMark = events.mark()
      const before = provider.requests.length
      await prompt(client, sandbox.project, session, "Thanks, that is all.")
      await events.waitFor(isIdle(session), {
        after: thirdMark,
        description: "third turn finished",
        timeout: 60_000,
      })
      await waitFor(async () => provider.requests.length > before, {
        description: "third turn reached the provider",
      })

      const replay = JSON.stringify(provider.requests.slice(before))
      // The turn that introduced the field name is redacted...
      expect(replay).toContain("[REDACTED-SECRET:generic-api-key:")
      // ...while the turn-1 message the host replayed keeps the bytes the
      // provider already cached.
      expect(replay).toContain(`Remember this build id: ${LATE_VALUE}`)
    } catch (error) {
      await writeArtifacts(sandbox, provider, processes)
      throw error
    }
  }, 90_000)

  test.each(["redact-first", "approve-first"] as const)(
    "redacts complete classifier history before excerpting with bundled plugins (%s)",
    async (order) => {
      expect(FAKE_PAT).toHaveLength(40)
      expect(HISTORY_SOURCE.slice(0, 2_000).slice(-39)).toBe(RAW_FIRST_39)

      const sandbox = await createSandbox(`redact-classifier-${order}`)
      const sessionProvider = createScriptedProvider({
        toolCall: (lastUserText) => {
          if (lastUserText.includes("VAULT_SOURCE_MARKER")) {
            return {
              tool: "bash",
              arguments: {
                command: `printf '${HISTORICAL_TOOL_TITLE}'`,
                description: "Create a private historical tool title.",
              },
            }
          }
          if (lastUserText.includes(HISTORY_SOURCE_MARKER)) {
            return {
              tool: "bash",
              arguments: {
                command: "true",
                description: "Raise one deterministic permission.",
              },
            }
          }
        },
        finalText: "Scripted session turn complete.",
      })
      const judgeProvider = createScriptedProvider({ finalText: "unused" })
      const processes: OpenCodeProcess[] = []
      const recorders: EventRecorder[] = []
      cleanups.push(async () => sandbox.cleanup())
      cleanups.push(async () => sessionProvider.close())
      cleanups.push(async () => judgeProvider.close())
      cleanups.push(async () => {
        for (const recorder of recorders) await recorder.close()
      })
      cleanups.push(async () => {
        for (const process of processes.reverse()) await process.stop()
      })

      try {
        await Promise.all([sessionProvider.ready, judgeProvider.ready])
        expect(judgeProvider.origin).not.toBe(sessionProvider.origin)
        const bundles = await buildInteropBundles(sandbox)
        await writeInteropProject(
          sandbox,
          sessionProvider.baseURL,
          judgeProvider.baseURL,
          bundles,
          order,
        )
        const env = await sandbox.environment(`classifier-${order}`)
        await plantPlaceholderKey(env)
        await writePluginOptions(env, { wireBackstop: false })
        await writeAutoApproveSettings(sandbox.config, sandbox.project, {
          model: "judge/classifier",
          notify: false,
        })
        const stateHome = env.XDG_STATE_HOME
        if (!stateHome) throw new Error("sandbox omitted XDG_STATE_HOME")
        await blessAutoApproveProjectConfig(stateHome, sandbox.project)

        const server = await startOpenCode({ cwd: sandbox.project, env })
        processes.push(server)
        const client = clientFor(server, sandbox.project)
        const events = await EventRecorder.connect(client)
        recorders.push(events)
        const session = await createSession(
          client,
          sandbox.project,
          `Classifier source redaction (${order})`,
        )

        // First make the complete synthetic PAT pass through the live detector.
        // The session provider sees its placeholder, never credential bytes.
        const vaultMark = events.mark()
        await prompt(
          client,
          sandbox.project,
          session,
          `VAULT_SOURCE_MARKER synthetic GitHub token: ${FAKE_PAT}`,
          "session",
        )
        await events.waitFor(isIdle(session), {
          after: vaultMark,
          description: `${order} vaulting turn finished`,
          timeout: 60_000,
        })
        const vaultRequests = sessionProvider.requests.map((request) =>
          JSON.stringify(request),
        )
        expect(vaultRequests.some((body) => body.includes(PLACEHOLDER))).toBe(
          true,
        )
        for (const body of vaultRequests) {
          expect(body).not.toContain(FAKE_PAT)
          expect(body).not.toContain(RAW_FIRST_39)
        }

        const classifyMark = events.mark()
        await prompt(
          client,
          sandbox.project,
          session,
          HISTORY_SOURCE,
          "session",
        )
        const replied = await events.waitFor(isReplied(session), {
          after: classifyMark,
          description: `${order} classifier auto-reply`,
          timeout: 60_000,
        })
        expect(replied.properties.reply).toBe("once")
        await events.waitFor(isIdle(session), {
          after: classifyMark,
          description: `${order} classified turn finished`,
          timeout: 60_000,
        })
        await judgeProvider.waitForClassifierCount(1, { timeoutMs: 20_000 })

        // The classifier was pinned to a genuinely separate provider endpoint.
        expect(sessionProvider.classifierRequests).toHaveLength(0)
        expect(judgeProvider.classifierRequests).toHaveLength(1)
        expect(judgeProvider.requests).toHaveLength(1)
        const classifierRequest = judgeProvider.classifierRequests[0]
        if (!classifierRequest) throw new Error("missing classifier request")
        expect(classifierRequest.model).toBe("classifier")
        const classifierBody = JSON.stringify(classifierRequest)

        // Complete history was redacted before its formatter made the exact
        // shape-invalid first-39 excerpt that regressed in issue #226.
        expect(classifierBody).not.toContain(FAKE_PAT)
        expect(classifierBody).not.toContain(RAW_FIRST_39)
        expect(classifierBody).toContain(PLACEHOLDER)
        expect(classifierBody).toContain(
          "User messages this session, oldest first",
        )
        expect(classifierBody).toContain(HISTORY_SOURCE_MARKER)
        expect(classifierBody).toContain("- metadata:")

        // A separately pinned judge gets historical tool names only, not the
        // completed command title (or tool output) the session provider saw.
        expect(classifierBody).toContain("Recent tool calls by the agent")
        expect(classifierBody).toContain("- bash")
        expect(classifierBody).not.toContain(HISTORICAL_TOOL_TITLE)
      } catch (error) {
        await fs.writeFile(
          path.join(sandbox.artifacts, "judge-provider-requests.json"),
          `${JSON.stringify(judgeProvider.requests, null, 2)}\n`,
        )
        await writeArtifacts(sandbox, sessionProvider, processes)
        throw error
      }
    },
    90_000,
  )
})

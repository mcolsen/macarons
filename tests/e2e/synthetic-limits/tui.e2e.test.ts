import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { EXPECTED_OPENCODE_VERSION } from "../harness/opencode-binary"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import { REPOSITORY_ROOT } from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import { startTmuxTui, type TmuxTui } from "../harness/tmux"

const TUI_ENTRY = path.join(
  REPOSITORY_ROOT,
  "plugins",
  "synthetic-limits",
  "src",
  "tui.tsx",
)

type QuotaRequest = { url: string; headers: Record<string, string> }

function startQuotaBackend() {
  const requests: QuotaRequest[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({
        url: request.url,
        headers: Object.fromEntries(request.headers),
      })
      return Response.json({
        subscription: {
          limit: 100,
          requests: 0,
          renewsAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        rollingFiveHourLimit: {
          nextTickAt: new Date(Date.now() + 900_000).toISOString(),
          tickPercent: 0.05,
          remaining: 75,
          max: 100,
          limited: false,
        },
        weeklyTokenLimit: {
          nextRegenAt: new Date(Date.now() + 12_120_000).toISOString(),
          percentRemaining: 38,
          maxCredits: "$24.00",
          remainingCredits: "$9.12",
          nextRegenCredits: "$0.48",
        },
      })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v2/quotas`,
    requests,
    close: async () => {
      await server.stop(true)
    },
  }
}

async function writeProject(project: string, quotaURL: string) {
  await fs.writeFile(
    path.join(project, "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: "synthetic/hf:zai-org/GLM-4.7",
      },
      null,
      2,
    )}\n`,
  )
  const directory = path.join(project, ".opencode")
  await fs.mkdir(directory, { recursive: true })
  const file = path.join(directory, "tui.json")
  const spec = [
    pathToFileURL(TUI_ENTRY).href,
    { providers: { synthetic: { endpoint: quotaURL } }, interval: 15 },
  ]
  await fs.writeFile(file, `${JSON.stringify({ plugin: [spec] }, null, 2)}\n`)
  return file
}

async function retainFailure(
  sandbox: Sandbox,
  requests: QuotaRequest[],
  server: OpenCodeProcess | undefined,
  tui: TmuxTui | undefined,
) {
  if (server)
    await server.writeDiagnostics(path.join(sandbox.artifacts, "server"))
  if (tui) await tui.writeDiagnostics(path.join(sandbox.artifacts, "tui"))
  await fs.writeFile(
    path.join(sandbox.artifacts, "quota-requests.json"),
    `${JSON.stringify(requests, null, 2)}\n`,
  )
  const artifact = await sandbox.preserve("synthetic-limits-tui")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("synthetic-limits sidebar widget", () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("uses the server-resolved key and renders rolling quotas", async () => {
    const sandbox = await createSandbox("synthetic-limits")
    const backend = startQuotaBackend()
    let server: OpenCodeProcess | undefined
    let tui: TmuxTui | undefined
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => backend.close())
    cleanups.push(async () => tui?.stop())
    cleanups.push(async () => server?.stop())

    try {
      const tuiConfig = await writeProject(sandbox.project, backend.url)
      server = await startOpenCode({
        cwd: sandbox.project,
        env: await sandbox.environment("server", {
          SYNTHETIC_API_KEY: "e2e-synthetic-key",
        }),
      })
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: sandbox.project,
      })
      const created = await client.session.create({
        directory: sandbox.project,
        title: "E2E Synthetic limits",
      })
      if (created.error || !created.data)
        throw new Error(
          `Could not create session: ${JSON.stringify(created.error)}`,
        )
      // Deliberately omit SYNTHETIC_API_KEY from the TUI environment. The
      // plugin must consume the effective provider state synced by the server.
      tui = await startTmuxTui({
        directory: sandbox.project,
        env: await sandbox.environment("tui"),
        serverURL: server.url,
        sessionID: created.data.id,
        tuiConfig,
      })

      await tui.waitForText("Synthetic Limits")
      // Narrow sidebars can wrap between the reset hour and minute.
      const time = /(\d{1,2}\s+\w+\s+)?\d{2}:\s*\d{2}/.source
      await tui.waitForText(
        new RegExp(`5h 75% left \\u00b7 regen 5%\\s+${time}`),
      )
      await tui.waitForText(
        new RegExp(`7d 38% left \\u00b7 regen 2%\\s+${time}`),
      )
      expect(backend.requests.length).toBeGreaterThanOrEqual(1)
      const request = backend.requests[0]
      if (!request) throw new Error("expected a backend request")
      expect(request.url.endsWith("/v2/quotas")).toBe(true)
      expect(request.headers.authorization).toBe("Bearer e2e-synthetic-key")
      expect(request.headers["user-agent"]).toBe(
        `opencode/${EXPECTED_OPENCODE_VERSION}`,
      )
    } catch (error) {
      await retainFailure(sandbox, backend.requests, server, tui)
      throw error
    }
  })
})

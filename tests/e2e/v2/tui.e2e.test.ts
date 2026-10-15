import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { usageLimitsRpc } from "../../../libraries/usage-limits/src/rpc"
import { waitFor } from "../harness/wait"
import { fixture, pluginURL } from "./fixture"
import { startTmuxTui, type TmuxTui } from "./tmux"

test("native TUI loads quota widgets from cli.json using only server credentials", async () => {
  const requests: string[] = []
  const quotas = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.headers.get("authorization") ?? "")
      return Response.json({
        rollingFiveHourLimit: { remaining: 480, max: 600 },
        weeklyTokenLimit: { percentRemaining: 75 },
      })
    },
  })
  const host = await fixture({
    plugins: [
      {
        package: pluginURL("synthetic-limits"),
        options: {
          providers: {
            synthetic: { endpoint: `http://127.0.0.1:${quotas.port}/quotas` },
          },
        },
      },
      pluginURL("codex-limits"),
      pluginURL("approve-for-me"),
    ],
    config: {
      model: "synthetic/model",
      providers: {
        synthetic: {
          name: "Synthetic fixture",
          package: "@opencode/ai/providers/openai-compatible",
          env: [],
          models: {
            model: {
              name: "Synthetic model",
              limit: { context: 100000, output: 4000 },
            },
          },
        },
      },
    },
  }).catch((error) => {
    quotas.stop(true)
    throw error
  })
  let tui: TmuxTui | undefined
  try {
    const location = { directory: host.sandbox.project }
    await host.client.credential.create({
      integrationID: "synthetic",
      value: { type: "key", key: "server-synthetic-key" },
      activate: true,
    })
    const snapshot = await host.client
      .rpc(usageLimitsRpc("synthetic"))
      .snapshot({}, { location })
    expect(snapshot).toMatchObject({
      snapshot: {
        windows: [
          { key: "five-hour", usedPercent: 20 },
          { key: "weekly", usedPercent: 25 },
        ],
      },
    })
    expect(JSON.stringify(snapshot)).not.toContain("server-synthetic-key")
    await fs.writeFile(
      path.join(host.sandbox.config, "cli.json"),
      JSON.stringify({
        plugins: [
          pluginURL("synthetic-limits"),
          pluginURL("codex-limits"),
          pluginURL("cache-ratio"),
          pluginURL("approve-for-me"),
        ],
        session: { sidebar: "auto" },
        animations: false,
      }),
    )
    const session = await host.client.session.create({
      location,
      model: { providerID: "synthetic", id: "model" },
      title: "V2 quota fixture",
    })
    const env = await host.sandbox.environment("tui", {
      OPENCODE_SERVER_PASSWORD: host.env.OPENCODE_SERVER_PASSWORD,
      OPENCODE_AUTH_CONTENT: JSON.stringify({
        synthetic: { type: "api", key: "unrelated-local-key" },
      }),
    })
    tui = await startTmuxTui({
      binary: host.process.binary,
      directory: host.sandbox.project,
      env,
      serverURL: host.process.url,
      sessionID: session.id,
    })
    const pane = await tui.waitForText("5h 80% left", 45000)
    expect(pane).toContain("Synthetic Limits")
    expect(pane).toContain("7d 75% left")
    expect(requests.length).toBeGreaterThan(0)
    expect(
      requests.every((header) => header === "Bearer server-synthetic-key"),
    ).toBe(true)
    await tui.sendKey("C-p")
    await tui.waitForText("Commands", 10000)
    await tui.type("set classifier timeout")
    await tui.waitForText("set classifier timeout", 15000)
    await tui.sendKey("Enter")
    await tui.waitForText("Classifier timeout", 15000)
    await tui.sendKey("Escape")
    const credential = (await host.client.credential.list()).find(
      (item) => item.integrationID === "synthetic",
    )
    expect(credential).toBeDefined()
    if (!credential) throw new Error("missing fixture credential")
    await host.client.credential.remove({ credentialID: credential.id })
    await waitFor(async () => !(await tui!.capture()).includes("5h 80% left"), {
      description: "quota hidden after server sign-out",
      timeout: 30000,
    })
  } catch (error) {
    await host.process.writeDiagnostics(host.sandbox.artifacts)
    if (tui) await tui.writeDiagnostics(host.sandbox.artifacts).catch(() => {})
    await host.sandbox.preserve("v2-tui")
    throw error
  } finally {
    await tui?.stop()
    await host.dispose()
    quotas.stop(true)
  }
})

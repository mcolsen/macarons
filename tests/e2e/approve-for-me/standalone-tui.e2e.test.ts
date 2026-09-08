import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  AUTO_APPROVE_SERVER_ENTRY,
  AUTO_APPROVE_TUI_ENTRY,
  blessAutoApproveProjectConfig,
  SERVER_ENTRY,
  storeFile,
  TUI_ENTRY,
  writeProjectConfig,
  writeTuiConfig,
} from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import {
  createScriptedProvider,
  type ScriptedProvider,
} from "../harness/scripted-provider"
import { startTmuxTui, type TmuxTui } from "../harness/tmux"
import { waitFor } from "../harness/wait"

/**
 * The mode every other suite misses: a plain `opencode` invocation, where the
 * host bootstraps inside the TUI process and serverUrl is NEVER bound — no
 * TCP listener exists at any point. Both the version probe and the classifier
 * session must ride the SDK's in-process transport here; anything that
 * touches fetch(serverUrl) fails with a connection error and, before the
 * transport fix, silently disabled the plugins at startup while the sidebar
 * kept saying "auto-approve on". Scripted provider, pinned OpenCode, tmux —
 * no real models, no real approvals.
 */

const COMMAND = "git status --short"

async function hostLog(sandbox: Sandbox, instance: string): Promise<string> {
  const logDir = path.join(
    sandbox.root,
    "instances",
    instance,
    "data",
    "opencode",
    "log",
  )
  let combined = ""
  try {
    for (const entry of await fs.readdir(logDir)) {
      if (entry.endsWith(".log"))
        combined += await fs.readFile(path.join(logDir, entry), "utf8")
    }
  } catch {
    // The host may not have flushed a log yet; callers poll.
  }
  return combined
}

async function retainFailure(
  sandbox: Sandbox,
  provider: ScriptedProvider | undefined,
  tui: TmuxTui | undefined,
) {
  if (tui) await tui.writeDiagnostics(path.join(sandbox.artifacts, "tui"))
  await fs.writeFile(
    path.join(sandbox.artifacts, "provider-requests.json"),
    `${JSON.stringify(provider?.requests ?? [], null, 2)}\n`,
  )
  await fs.writeFile(
    path.join(sandbox.artifacts, "host.log"),
    await hostLog(sandbox, "standalone"),
  )
  const artifact = await sandbox.preserve("approve-for-me-standalone-tui")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("approve-for-me in a standalone TUI", () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("initializes, classifies, and auto-approves with serverUrl never bound", async () => {
    const sandbox = await createSandbox("approve-for-me-standalone")
    const provider = createScriptedProvider({ command: COMMAND })
    let tui: TmuxTui | undefined
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => tui?.stop())

    try {
      await provider.ready
      // Both server plugins, the way they co-install in real configs: the
      // persist-permissions half must survive standalone bootstrap too.
      await writeProjectConfig(sandbox.project, provider.baseURL, {
        plugins: [AUTO_APPROVE_SERVER_ENTRY, SERVER_ENTRY],
      })
      const tuiConfig = await writeTuiConfig(sandbox.project, [
        AUTO_APPROVE_TUI_ENTRY,
        TUI_ENTRY,
      ])
      const environment = await sandbox.environment("standalone")
      if (!environment.XDG_STATE_HOME)
        throw new Error("sandbox omitted XDG_STATE_HOME")
      await blessAutoApproveProjectConfig(
        environment.XDG_STATE_HOME,
        sandbox.project,
      )
      tui = await startTmuxTui({
        directory: sandbox.project,
        env: environment,
        tuiConfig,
      })

      // Standalone startup includes host bootstrap and plugin loading; under a
      // loaded runner the first frame can exceed the harness's generic 30s.
      await tui.waitForText(/E2E scripted/i, 60_000)

      // Neither plugin may have tripped its version guard during bootstrap:
      // that was the standalone failure mode this suite exists to pin.
      await waitFor(
        async () => (await hostLog(sandbox, "standalone")).length > 0,
        {
          description: "host log to appear",
        },
      )
      expect(await hostLog(sandbox, "standalone")).not.toContain(
        "plugin disabled",
      )

      // One prompt: the scripted provider answers with a bash tool call, the
      // permission prompt fires, the classifier approves, the turn finishes
      // without any human answering anything.
      await tui.type("Run the scripted command exactly once.")
      await tui.sendKey("Enter")
      await tui.waitForText(/Approved/i, 60_000)
      await tui.waitForText(/\bdone\b/, 60_000)

      expect(provider.classifierRequests.length).toBe(1)
      // The host flushes its log file lazily and escapes the quotes inside
      // the message ⇒ poll, and match the unquoted part of the line.
      await waitFor(
        async () =>
          (await hostLog(sandbox, "standalone")).includes("auto-approved"),
        {
          description: "the plugin's auto-approved log line to flush",
        },
      )
      expect(await hostLog(sandbox, "standalone")).not.toContain(
        "plugin disabled",
      )

      // Both filesystem-backed controls must prove locality over worker RPC,
      // not by trying to fetch the unbound opencode.internal URL.
      await tui.sendKey("C-M-a")
      await tui.waitForText(/off \(this instance\)/)
      await tui.type("Run the scripted command once more.")
      await tui.sendKey("Enter")
      await tui.waitForText("Permission required")
      await Bun.sleep(1_500)
      expect(provider.classifierRequests).toHaveLength(1)

      await tui.sendKey("C-o")
      await tui.waitForText('Always allow "bash"')
      await tui.sendKey("C-u")
      await tui.type(COMMAND)
      await tui.sendKey("Enter")
      await tui.waitForText(/Saved git status --short/)
      const store = JSON.parse(
        await fs.readFile(storeFile(sandbox.config, sandbox.project), "utf8"),
      )
      expect(store.permission.bash).toEqual({ [COMMAND]: "allow" })
      expect(provider.classifierRequests).toHaveLength(1)
    } catch (error) {
      await retainFailure(sandbox, provider, tui)
      throw error
    }
  }, 120_000)
})

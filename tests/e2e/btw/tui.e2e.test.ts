import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import { EventRecorder } from "../harness/events"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
import {
  createProgrammableProvider,
  type ProgrammableProvider,
} from "../harness/programmable-provider"
import {
  BTW_TUI_ENTRY,
  writeBtwConfig,
  writeTuiConfig,
} from "../harness/project"
import { createSandbox, type Sandbox } from "../harness/sandbox"
import { startTmuxTui, type TmuxTui } from "../harness/tmux"
import { runPaletteCommand } from "../harness/tui-commands"
import { waitFor } from "../harness/wait"

// Drives the real TUI (tmux) through the command palette. The btw side-question flow lives
// almost entirely in the TUI half — the dialog, the fork, the streamed answer
// panel — and btw/server.e2e.test.ts drives startSideQuestion() in-process,
// never through a mounted TUI. This journey covers the mounted path: host
// mounting, the palette command, the panel's streaming render, and the promise
// the whole plugin rests on — that the parent transcript is untouched
// (audit L-RE5, issue #46).

const QUESTION = "why exponential backoff"
const PARENT_REPLY = "Exponential backoff avoids a thundering herd of retries."
// Matched on its own: the answer renders inside an 88-column dialog through
// the markdown element, so a whole sentence may wrap but a single token cannot.
const ANSWER_MARKER = "BTWSTREAMEDANSWER"
const SIDE_ANSWER = `${ANSWER_MARKER} we picked it for the jitter.`

const ASK_COMMAND_DESCRIPTION = "Ask about the conversation"
const ASK_DIALOG_PLACEHOLDER = "e.g. why did we pick exponential backoff here?"
const PANEL_HEADER = "BTW ·"

async function retainFailure(
  sandbox: Sandbox,
  provider: ProgrammableProvider | undefined,
  server: OpenCodeProcess | undefined,
  events: EventRecorder | undefined,
  tui: TmuxTui | undefined,
) {
  if (server)
    await server.writeDiagnostics(path.join(sandbox.artifacts, "server"))
  if (tui) await tui.writeDiagnostics(path.join(sandbox.artifacts, "tui"))
  await fs.writeFile(
    path.join(sandbox.artifacts, "events.json"),
    `${JSON.stringify(events?.events ?? [], null, 2)}\n`,
  )
  await fs.writeFile(
    path.join(sandbox.artifacts, "provider-requests.json"),
    `${JSON.stringify(provider?.requests ?? [], null, 2)}\n`,
  )
  const artifact = await sandbox.preserve("btw-tui")
  console.error(`E2E artifacts retained at ${artifact}`)
}

async function messageCount(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
) {
  const result = await client.session.messages({ directory, sessionID })
  return result.data?.length ?? 0
}

describe("btw TUI companion", () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("the palette command streams a side answer into its panel and leaves the parent transcript untouched", async () => {
    const sandbox = await createSandbox("btw-tui")
    const provider = createProgrammableProvider({
      respond({ request }) {
        // The side question rides in a user message wrapped in
        // <side-question> (shared.ts wrapQuestion); everything else is the
        // parent turn or a host-generated title request.
        const body = JSON.stringify(request.messages ?? [])
        if (body.includes("<side-question>"))
          return { kind: "text", text: SIDE_ANSWER }
        return { kind: "text", text: PARENT_REPLY }
      },
    })
    let server: OpenCodeProcess | undefined
    let events: EventRecorder | undefined
    let tui: TmuxTui | undefined
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => events?.close())
    cleanups.push(async () => tui?.stop())
    cleanups.push(async () => server?.stop())

    try {
      await provider.ready
      await writeBtwConfig(sandbox.project, provider.baseURL)
      const tuiConfig = await writeTuiConfig(sandbox.project, [BTW_TUI_ENTRY])

      const environment = await sandbox.environment("btw")
      server = await startOpenCode({ cwd: sandbox.project, env: environment })
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: sandbox.project,
      })
      events = await EventRecorder.connect(client)
      const created = await client.session.create({
        directory: sandbox.project,
        title: "E2E btw TUI",
      })
      if (created.error || !created.data)
        throw new Error(
          `Could not create session: ${JSON.stringify(created.error)}`,
        )
      const sessionID = created.data.id

      // btw refuses to fork a session that has never replied (forkBoundary's
      // hasContext), so give the parent one completed turn first.
      const parentMark = events.mark()
      const prompted = await client.session.promptAsync({
        directory: sandbox.project,
        sessionID,
        model: { providerID: "e2e", modelID: "test" },
        parts: [{ type: "text", text: "Explain the retry logic." }],
      })
      if (prompted.error)
        throw new Error(
          `Could not prompt the parent: ${JSON.stringify(prompted.error)}`,
        )
      await events.waitFor(
        (event) =>
          event.type === "session.idle" &&
          event.properties.sessionID === sessionID,
        { after: parentMark, description: "parent turn idle" },
      )
      const before = await messageCount(client, sandbox.project, sessionID)
      expect(before).toBeGreaterThan(0)

      tui = await startTmuxTui({
        directory: sandbox.project,
        env: environment,
        serverURL: server.url,
        sessionID,
        tuiConfig,
      })
      await tui.waitForText(/OpenCode|opencode/i)

      // ---- ask ------------------------------------------------------------
      const askMark = events.mark()
      await runPaletteCommand(tui, "btw", ASK_COMMAND_DESCRIPTION)
      await tui.waitForText(ASK_DIALOG_PLACEHOLDER)
      await tui.type(QUESTION)
      await tui.sendKey("Enter")

      // The panel replaces the prompt dialog and streams into it. Its header
      // names the model the fork runs on, so its presence proves the fork was
      // prepared, not just that a dialog opened.
      await tui.waitForText(PANEL_HEADER, 60_000)
      await tui.waitForText(ANSWER_MARKER, 60_000)

      // Wait for the fork's turn to actually FINISH before checking the parent.
      // Asserting mid-stream would miss a write-back that happens as the turn
      // completes — exactly the regression worth catching. The panel's own
      // footer would say so ("esc close" vs "esc stop & close") but never
      // reaches the pane: the dialog caps width, not height, so the answer
      // scrollbox's flexGrow pushes the footer outside the clip region. The
      // fork's session.idle is the reliable signal, and the fork is a separate
      // session the plugin titles "btw: <question>".
      let forkID: string | undefined
      await waitFor(
        async () => {
          const sessions = await client.session.list({
            directory: sandbox.project,
          })
          forkID = sessions.data?.find(
            (s) => s.id !== sessionID && s.title?.startsWith("btw:"),
          )?.id
          return forkID !== undefined
        },
        { description: "the btw fork session" },
      )
      await events.waitFor(
        (event) =>
          event.type === "session.idle" &&
          event.properties.sessionID === forkID,
        {
          after: askMark,
          description: "side question turn idle",
        },
      )

      // ---- the parent is untouched ----------------------------------------
      // The whole point of a side question: the fork carries the conversation
      // but nothing lands back on it.
      const after = await messageCount(client, sandbox.project, sessionID)
      expect(after).toBe(before)
      const messages = await client.session.messages({
        directory: sandbox.project,
        sessionID,
      })
      const parentText = JSON.stringify(messages.data ?? [])
      expect(parentText).not.toContain(QUESTION)
      expect(parentText).not.toContain(ANSWER_MARKER)
      expect(parentText).not.toContain("<side-question>")

      // Escape closes the panel; the fork is kept so the palette can reopen it.
      await tui.sendKey("Escape")
      const deadline = Date.now() + 10_000
      let pane = await tui.capture()
      while (Date.now() < deadline && pane.includes(PANEL_HEADER)) {
        await Bun.sleep(200)
        pane = await tui.capture()
      }
      expect(pane).not.toContain(PANEL_HEADER)
    } catch (error) {
      await retainFailure(sandbox, provider, server, events, tui)
      throw error
    }
  }, 150_000)
})

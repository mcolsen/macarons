import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import { EventRecorder } from "../harness/events"
import {
  type OpenCodeProcess,
  startOpenCode,
} from "../harness/opencode-process"
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

type PermissionAsked = Extract<Event, { type: "permission.asked" }>
type SessionIdle = Extract<Event, { type: "session.idle" }>

const COMMAND = "git status --short"

type ShadowPaths = { config: string; state: string }

function startPathRewritingProxy(backendURL: string, shadow: ShadowPaths) {
  const backend = new URL(backendURL)
  const controller = new AbortController()
  const readers = new Set<
    ReturnType<NonNullable<Response["body"]>["getReader"]>
  >()
  const forward = (response: Response, headers: Headers) => {
    if (!response.body)
      return new Response(null, { status: response.status, headers })
    const reader = response.body.getReader()
    readers.add(reader)
    let released = false
    const release = () => {
      if (released) return
      released = true
      readers.delete(reader)
      void reader.cancel().catch(() => {})
    }
    controller.signal.addEventListener("abort", release, { once: true })
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const next = await reader.read()
          if (next.done) {
            release()
            stream.close()
          } else {
            stream.enqueue(next.value)
          }
        } catch (error) {
          release()
          if (controller.signal.aborted) stream.close()
          else stream.error(error)
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason)
        } finally {
          release()
        }
      },
    })
    return new Response(body, { status: response.status, headers })
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const incoming = new URL(request.url)
      const target = new URL(incoming.pathname + incoming.search, backend)
      // Keep streaming responses unbuffered. fetch decompresses upstream bodies,
      // so forwarding their original encoding/length headers would corrupt them.
      const response = await fetch(new Request(target.toString(), request), {
        signal: AbortSignal.any([request.signal, controller.signal]),
      }).catch((error) => {
        if (controller.signal.aborted)
          return new Response(null, { status: 503 })
        throw error
      })
      const headers = new Headers(response.headers)
      headers.delete("content-encoding")
      headers.delete("content-length")
      if (incoming.pathname !== "/path" || !response.ok)
        return forward(response, headers)

      const paths = (await response.json()) as Record<string, unknown>
      headers.set("content-type", "application/json")
      return new Response(
        JSON.stringify({
          ...paths,
          config: shadow.config,
          state: shadow.state,
        }),
        { status: response.status, statusText: response.statusText, headers },
      )
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    close: async () => {
      controller.abort()
      await Promise.all(
        [...readers].map((reader) => reader.cancel().catch(() => {})),
      )
      await server.stop(true)
    },
  }
}

async function tree(root: string): Promise<string[]> {
  return (await fs.readdir(root, { recursive: true })).sort()
}

async function retainFailure(
  sandbox: Sandbox,
  provider: ScriptedProvider | undefined,
  server: OpenCodeProcess | undefined,
  events: EventRecorder | undefined,
  tui: TmuxTui | undefined,
) {
  if (server)
    await server.writeDiagnostics(path.join(sandbox.artifacts, "server"))
  if (tui)
    await tui
      .writeDiagnostics(path.join(sandbox.artifacts, "tui"))
      .catch(async (error) => {
        await fs.writeFile(
          path.join(sandbox.artifacts, "tui-capture-error.txt"),
          String(error),
        )
      })
  await fs.writeFile(
    path.join(sandbox.artifacts, "events.json"),
    `${JSON.stringify(events?.events ?? [], null, 2)}\n`,
  )
  await fs.writeFile(
    path.join(sandbox.artifacts, "provider-requests.json"),
    `${JSON.stringify(provider?.requests ?? [], null, 2)}\n`,
  )
  const artifact = await sandbox.preserve("persist-permissions-remote-tui")
  console.error(`E2E artifacts retained at ${artifact}`)
}

describe("permission TUI controls through a mismatched loopback mount", () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  test("does not treat a loopback proxy's writable shadow paths as the server filesystem", async () => {
    const sandbox = await createSandbox("persist-permissions-remote-tui")
    const provider = createScriptedProvider({ command: COMMAND })
    let server: OpenCodeProcess | undefined
    let events: EventRecorder | undefined
    let tui: TmuxTui | undefined
    let proxy: ReturnType<typeof startPathRewritingProxy> | undefined
    cleanups.push(async () => sandbox.cleanup())
    cleanups.push(async () => provider.close())
    cleanups.push(async () => events?.close())

    const shadowRoot = path.join(sandbox.root, "shadow-mount")
    const shadow = {
      config: path.join(shadowRoot, "config"),
      state: path.join(shadowRoot, "state"),
    }
    await Promise.all([
      fs.mkdir(shadow.config, { recursive: true }),
      fs.mkdir(shadow.state, { recursive: true }),
    ])
    const beforeShadow = await tree(shadowRoot)
    cleanups.push(async () => server?.stop())
    cleanups.push(async () => proxy?.close())
    cleanups.push(async () => tui?.stop())

    try {
      await provider.ready
      await writeProjectConfig(sandbox.project, provider.baseURL, {
        plugins: [SERVER_ENTRY, AUTO_APPROVE_SERVER_ENTRY],
      })
      const tuiConfig = await writeTuiConfig(sandbox.project, [
        TUI_ENTRY,
        AUTO_APPROVE_TUI_ENTRY,
      ])
      const serverEnv = await sandbox.environment("server")
      if (!serverEnv.XDG_STATE_HOME)
        throw new Error("sandbox omitted XDG_STATE_HOME")
      await blessAutoApproveProjectConfig(
        serverEnv.XDG_STATE_HOME,
        sandbox.project,
      )
      server = await startOpenCode({ cwd: sandbox.project, env: serverEnv })
      proxy = startPathRewritingProxy(server.url, shadow)

      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: sandbox.project,
      })
      events = await EventRecorder.connect(client)
      const created = await client.session.create({
        directory: sandbox.project,
        title: "mismatched loopback mount",
      })
      if (created.error || !created.data)
        throw new Error(
          `Could not create TUI session: ${JSON.stringify(created.error)}`,
        )
      const sessionID = created.data.id
      const proxied = createOpencodeClient({
        baseUrl: proxy.url,
        directory: sandbox.project,
      })
      const reached = await proxied.session.get({
        sessionID,
        directory: sandbox.project,
      })
      expect(reached.error).toBeUndefined()
      expect(reached.data?.id).toBe(sessionID)
      expect(
        (await proxied.path.get({ directory: sandbox.project })).data?.config,
      ).toBe(shadow.config)
      tui = await startTmuxTui({
        directory: sandbox.project,
        env: await sandbox.environment("tui"),
        serverURL: proxy.url,
        sessionID,
        tuiConfig,
      })
      const keepPane = Bun.spawn(
        [
          "tmux",
          "-L",
          tui.socket,
          "set-window-option",
          "-t",
          "tui:0",
          "remain-on-exit",
          "on",
        ],
        { stdout: "ignore", stderr: "pipe" },
      )
      expect(await keepPane.exited).toBe(0)
      await tui.waitForText(/Approve for Me/)

      await tui.sendKey("C-M-a")
      const controls = await tui.waitForText(
        "Approve for Me controls are unavailable",
      )
      expect(controls).toContain("classification may still be active")
      expect(controls).not.toContain("OFF for this instance")
      expect(await tree(shadowRoot)).toEqual(beforeShadow)

      provider.setClassifier({
        verdict: {
          decision: "surface",
          risk: "high",
          authorization: "none",
          reason: "remote mount surface",
        },
      })
      const promptMark = events.mark()
      const prompt = await client.session.promptAsync({
        directory: sandbox.project,
        sessionID,
        model: { providerID: "e2e", modelID: "test" },
        parts: [{ type: "text", text: "Run the scripted command once." }],
      })
      if (prompt.error)
        throw new Error(
          `Could not start prompt: ${JSON.stringify(prompt.error)}`,
        )
      const asked = await events.waitFor(
        (event): event is PermissionAsked =>
          event.type === "permission.asked" &&
          event.properties.sessionID === sessionID,
        { after: promptMark, description: "remote-mount permission.asked" },
      )
      await provider.waitForClassifierCount(1, { timeoutMs: 60_000 })
      await tui.waitForText("Permission required")

      const beforeEdit = events.mark()
      await tui.sendKey("C-o")
      const editing = await tui.waitForText("Permission editing is unavailable")
      expect(editing).toContain("was saved or approved")
      expect(editing).not.toMatch(/Saved |OFF for this instance/)
      await Bun.sleep(500)
      expect(
        events.events
          .slice(beforeEdit)
          .some((event) => event.type === "permission.replied"),
      ).toBe(false)
      expect(await fs.exists(storeFile(shadow.config, sandbox.project))).toBe(
        false,
      )
      expect(await tree(shadowRoot)).toEqual(beforeShadow)

      const rejected = await client.permission.reply({
        directory: sandbox.project,
        requestID: asked.properties.id,
        reply: "reject",
      })
      if (rejected.error)
        throw new Error(
          `Could not reject remote-mount permission: ${JSON.stringify(rejected.error)}`,
        )
      await events.waitFor(
        (event): event is SessionIdle =>
          event.type === "session.idle" &&
          event.properties.sessionID === sessionID,
        { after: promptMark, description: "remote-mount session idle" },
      )
      expect(provider.classifierRequests).toHaveLength(1)
    } catch (error) {
      if (tui) {
        const history = Bun.spawn(
          [
            "tmux",
            "-L",
            tui.socket,
            "capture-pane",
            "-p",
            "-J",
            "-S",
            "-",
            "-t",
            "tui:0.0",
          ],
          { stdout: "pipe", stderr: "ignore" },
        )
        await fs.writeFile(
          path.join(sandbox.artifacts, "terminal-history.txt"),
          await new Response(history.stdout).text(),
        )
        await history.exited
      }
      await retainFailure(sandbox, provider, server, events, tui)
      throw error
    }
  }, 120_000)
})

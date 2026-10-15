import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { redactSourceValue } from "@macarons/permission-rules"
import { Media } from "@opencode/ai/media"
import { Message } from "@opencode/ai/schema/messages"
import type { Plugin } from "@opencode/plugin"
import plugin from "../src/index"
import {
  COMPACTION_NOTE,
  MAX_WIRE_BODY_BYTES,
  OversizedBodyError,
  PLACEHOLDER_RE,
  SYSTEM_NOTE,
  UnscannableBodyError,
} from "../src/shared"

const PAT = "ghp_x7K2mQ9pL4vN8rT3wY6bJ1hF5dS0aZcE2gUq"
const roots: string[] = []
const cleanups: Array<() => void | Promise<void>> = []
let environment: Array<string | undefined>
beforeEach(() => {
  environment = [process.env.XDG_DATA_HOME, process.env.OPENCODE_CONFIG_DIR]
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const [i, key] of ["XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"].entries()) {
    if (environment[i] === undefined) delete process.env[key]
    else process.env[key] = environment[i]
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

async function setup(options: Record<string, unknown> = {}, existing?: string) {
  const root =
    existing ?? (await mkdtemp(join(tmpdir(), "macarons-redact-v2-")))
  if (!existing) roots.push(root)
  process.env.XDG_DATA_HOME = join(root, "data")
  process.env.OPENCODE_CONFIG_DIR = join(root, "config")
  const hooks = new Map<string, (event: unknown) => Promise<void>>()
  const registrations: string[] = []
  const hook = async (
    name: string,
    callback: (event: unknown) => Promise<void>,
  ) => {
    hooks.set(name, callback)
    return {
      dispose: async () => {
        registrations.push(name)
        hooks.delete(name)
      },
    }
  }
  const ctx = {
    options,
    app: { version: "2.0.29" },
    location: { directory: root },
    session: { hook },
    tool: { hook },
  }
  const cleanup = await plugin.setup(ctx as unknown as Plugin.Context)
  if (cleanup) cleanups.push(cleanup)
  return {
    root,
    hooks,
    registrations,
    cleanup,
    run: async (name: string, event: unknown) => {
      const callback = hooks.get(name)
      if (!callback) throw new Error(`missing hook ${name}`)
      await callback(event)
    },
  }
}

function request(text = PAT) {
  return {
    sessionID: "ses_abcdefgh12345678",
    agent: "build",
    model: { providerID: "openai", id: "gpt-6.1" },
    system: [{ type: "text", text: `System: ${text}` }],
    messages: [Message.user(text)],
    tools: {
      deploy: {
        description: text,
        input: { type: "object", properties: { token: { default: text } } },
      },
    },
    options: { user: text },
  }
}
function placeholder(text: string) {
  const result = new RegExp(PLACEHOLDER_RE.source).exec(text)?.[0]
  expect(result).toBeDefined()
  return result as string
}

describe("OpenCode v2 native redaction", () => {
  test("failed setup releases source registration and earlier native hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "macarons-redact-setup-"))
    roots.push(root)
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.OPENCODE_CONFIG_DIR = join(root, "config")
    let registered = 0
    let disposed = 0
    const ctx = {
      options: {},
      location: { directory: root },
      session: {
        hook: async () => {
          if (++registered === 3) throw new Error("registration failed")
          return {
            dispose: async () => {
              disposed++
            },
          }
        },
      },
    } as unknown as Plugin.Context
    await expect(plugin.setup(ctx)).rejects.toThrow("registration failed")
    expect(disposed).toBe(2)
    const value = { text: PAT }
    expect(redactSourceValue(ctx.location, value)).toBe(value)
  })

  test("disposal drains requests already scanning before flushing fingerprints", async () => {
    const host = await setup()
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const request = new Request("https://provider.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller
        },
      }),
    })
    const scan = host.run("http.request", {
      sessionID: "ses_abcdefgh12345678",
      request,
    })
    await Bun.sleep(5)
    let settled = false
    const cleanup = Promise.resolve(host.cleanup?.()).then(() => {
      settled = true
    })
    await Bun.sleep(5)
    expect(settled).toBe(false)
    stream.enqueue(new TextEncoder().encode(JSON.stringify({ text: PAT })))
    stream.close()
    await scan
    await cleanup
    expect(settled).toBe(true)
    const catalog = await readFile(
      join(host.root, "data/opencode/redact-secrets.fingerprints.json"),
      "utf8",
    )
    expect(JSON.parse(catalog).entries.length).toBeGreaterThan(0)
  })

  test.each(["context", "compaction", "title", "generate"])(
    "covers every surface of %s without modifying stored objects",
    async (kind) => {
      const host = await setup()
      const event = request()
      const original = event.messages
      const originalSystem = event.system
      const definitions = event.tools
      const originalSchema = definitions.deploy.input
      await host.run(kind, event)
      expect(JSON.stringify(event)).not.toContain(PAT)
      expect(JSON.stringify(original)).toContain(PAT)
      expect(JSON.stringify(originalSystem)).toContain(PAT)
      expect(JSON.stringify(originalSchema)).toContain(PAT)
      expect(event.tools.deploy).toBe(definitions.deploy)
      expect(event.messages[0]).toBeInstanceOf(Message)
      expect(event.system.some((part) => part.text === SYSTEM_NOTE)).toBe(true)
      expect(event.system.some((part) => part.text === COMPACTION_NOTE)).toBe(
        kind === "compaction",
      )
    },
  )

  test("secret-bearing tool names retain native execution identity through safe aliases", async () => {
    const host = await setup()
    const event = request("safe")
    const name = `deploy_${PAT}`
    const definition = {
      description: `deploy using ${PAT}`,
      input: { type: "object", properties: {} },
    }
    const originalDefinition = definition
    event.tools = { [name]: definition } as unknown as typeof event.tools
    event.messages = [
      Message.assistant({ type: "tool-call", id: "call_1", name, input: {} }),
      Message.tool({
        id: "call_1",
        name,
        result: { type: "text", value: "done" },
      }),
    ]
    // Mirror native model-request's identity map, populated BEFORE hooks.
    const given = new Map([[definition, { name }]])
    await host.run("context", event)
    const [alias, selected] = Object.entries(event.tools)[0]!
    expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(alias).not.toContain(PAT)
    expect(selected as object).toBe(originalDefinition)
    expect(given.get(selected)?.name).toBe(name)
    for (const message of event.messages) {
      const part = message.content[0]
      expect(part && "name" in part ? part.name : undefined).toBe(alias)
    }
    expect(JSON.stringify(event)).not.toContain(PAT)
  })

  test("tool restoration uses an owned input and leaves model prose masked", async () => {
    const host = await setup()
    const event = request()
    await host.run("context", event)
    const masked = placeholder(JSON.stringify(event.messages))
    const stored = { command: `echo ${masked}`, nested: { [masked]: masked } }
    const call = { sessionID: event.sessionID, tool: "shell", input: stored }
    await host.run("execute.before", call)
    expect(JSON.stringify(call.input)).toContain(PAT)
    expect(JSON.stringify(stored)).not.toContain(PAT)
    expect(host.hooks.has("experimental.text.complete")).toBe(false)
    expect(host.hooks.has("http.response")).toBe(false)
    expect(host.hooks.has("experimental.ws.receive")).toBe(false)
  })

  test("HTTP backstop covers body overlays without changing authentication or consuming the original", async () => {
    const host = await setup()
    const original = new Request("https://provider.test/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer host-credential",
        "content-length": "100",
      },
      body: JSON.stringify({ instructions: PAT, model: "test" }),
    })
    const event = { sessionID: "ses_abcdefgh12345678", request: original }
    await host.run("http.request", event)
    expect(await event.request.clone().text()).not.toContain(PAT)
    expect(await original.text()).toContain(PAT)
    expect(event.request.headers.get("authorization")).toBe(
      "Bearer host-credential",
    )
    expect(event.request.headers.get("content-length")).toBeNull()
  })

  test("WebSocket backstop covers frames and preserves provider-issued encrypted state", async () => {
    const host = await setup()
    const event = {
      sessionID: "ses_abcdefgh12345678",
      frame: JSON.stringify({
        type: "response.create",
        response: {
          instructions: PAT,
          input: [
            { type: "reasoning", encrypted_content: PAT },
            {
              type: "function_call",
              arguments: JSON.stringify({ encrypted_content: PAT }),
            },
          ],
        },
      }),
    }
    await host.run("experimental.ws.send", event)
    const body = JSON.parse(event.frame)
    expect(body.response.instructions).not.toContain(PAT)
    expect(body.response.input[0].encrypted_content).toBe(PAT)
    expect(body.response.input[1].arguments).not.toContain(PAT)
  })

  test("malformed and oversized WebSocket frames stop before dispatch", async () => {
    const host = await setup()
    await expect(
      host.run("experimental.ws.send", {
        sessionID: "ses_abcdefgh12345678",
        frame: "not json",
      }),
    ).rejects.toBeInstanceOf(UnscannableBodyError)
    await expect(
      host.run("experimental.ws.send", {
        sessionID: "ses_abcdefgh12345678",
        frame: "x".repeat(MAX_WIRE_BODY_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(OversizedBodyError)
  })

  test("unsupported HTTP encoding fails closed", async () => {
    const host = await setup()
    const event = {
      sessionID: "ses_abcdefgh12345678",
      request: new Request("https://provider.test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        body: new Uint8Array([1, 2, 3]),
      }),
    }
    await expect(host.run("http.request", event)).rejects.toBeInstanceOf(
      UnscannableBodyError,
    )
  })

  test("typed requests preserve opaque state only at provider-owned paths", async () => {
    const host = await setup()
    const event = request()
    event.messages = [
      Message.assistant([
        {
          type: "reasoning",
          text: PAT,
          encrypted: PAT,
          providerMetadata: { anthropic: { signature: PAT } },
        },
        {
          type: "tool-call",
          id: "call_123",
          name: "deploy",
          input: { signature: PAT, encrypted: PAT },
        },
      ]),
    ]
    await host.run("context", event)
    const parts = event.messages[0]?.content
    expect(parts?.[0]).toMatchObject({
      encrypted: PAT,
      providerMetadata: { anthropic: { signature: PAT } },
    })
    expect(JSON.stringify(parts?.[1])).not.toContain(PAT)
  })

  test.each(["bytes", "base64"] as const)(
    "scans %s attachments and retains Media.Asset methods",
    async (type) => {
      const host = await setup()
      const data = Buffer.from(JSON.stringify({ token: PAT }))
      const asset = new Media.Asset({
        source:
          type === "bytes"
            ? { type, data, mediaType: "application/json" }
            : {
                type,
                data: data.toString("base64"),
                mediaType: "application/json",
              },
      })
      const event = request("safe")
      event.messages = [Message.user({ type: "media", media: asset })]
      await host.run("context", event)
      const part = event.messages[0]?.content[0]
      expect(part?.type).toBe("media")
      if (part?.type !== "media") throw new Error("expected media")
      expect(part.media).toBeInstanceOf(Media.Asset)
      const source = part.media.source
      expect(source.type === "bytes" || source.type === "base64").toBe(true)
      if (source.type !== "bytes" && source.type !== "base64")
        throw new Error("expected inline source")
      const decoded = (
        source.type === "base64"
          ? Buffer.from(source.data, "base64")
          : Buffer.from(source.data)
      ).toString()
      expect(decoded).not.toContain(PAT)
      expect(decoded).toContain("[REDACTED-SECRET:")
      expect(data.toString()).toContain(PAT)
    },
  )

  test("restart recovery uses retained key and local environment files without persisting secrets", async () => {
    const first = await setup()
    const event = request()
    await first.run("context", event)
    const masked = placeholder(JSON.stringify(event.messages))
    await first.cleanup?.()
    await writeFile(join(first.root, ".env"), `TOKEN=${PAT}`)
    const second = await setup({}, first.root)
    const call = {
      sessionID: event.sessionID,
      tool: "shell",
      input: { command: `echo ${masked}` },
    }
    await second.run("execute.before", call)
    expect(call.input.command).toBe(`echo ${PAT}`)
    const dir = join(first.root, "data", "opencode")
    const catalog = await readFile(
      join(dir, "redact-secrets.fingerprints.json"),
      "utf8",
    )
    expect(catalog).not.toContain(PAT)
    expect((await stat(join(dir, "redact-secrets.key"))).mode & 0o777).toBe(
      0o600,
    )
    expect(
      (await stat(join(dir, "redact-secrets.fingerprints.json"))).mode & 0o777,
    ).toBe(0o600)
  })

  test("legacy configuration remains readable and V2 options override it", async () => {
    const first = await setup()
    await first.cleanup?.()
    await mkdir(join(first.root, "config"), { recursive: true })
    await writeFile(
      join(first.root, "config", "redact-secrets.json"),
      JSON.stringify({ systemNote: false }),
    )
    const host = await setup({ systemNote: true }, first.root)
    const event = request()
    await host.run("context", event)
    expect(event.system.some((part) => part.text === SYSTEM_NOTE)).toBe(true)
  })

  test("cycles fail closed and unloading releases registrations and flushes fingerprints", async () => {
    const host = await setup()
    const event = request()
    Object.assign(event.options, { cycle: event.options })
    await expect(host.run("context", event)).rejects.toThrow()
    await host.cleanup?.()
    expect(host.hooks.size).toBe(0)
    expect(host.registrations).toHaveLength(7)
  })
})

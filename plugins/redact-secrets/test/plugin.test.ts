import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import fs, * as fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  BAND_SAMPLE_VERSIONS as BAND,
  redactSourceValue,
} from "@macarons/permission-rules"
import { RedactSecretsPlugin } from "../src/index"
import {
  COMPACTION_NOTE,
  FINGERPRINT_MAX_CANDIDATES,
  FingerprintLimitError,
  MAX_WALK_DEPTH,
  PLACEHOLDER_RE,
  placeholderFor,
  Redactor,
  SYSTEM_NOTE,
  secretHash,
  VaultLimitError,
  WalkLimitError,
} from "../src/shared"

const FAKE_PAT = "ghp_x7K2mQ9pL4vN8rT3wY6bJ1hF5dS0aZcE2gUq"

// The plugin mints a random per-install key on first run; tests plant this
// fixed one so knownPlaceholder can reproduce exactly what the plugin derives.
const PLUGIN_KEY =
  "abad1deaabad1deaabad1deaabad1deaabad1deaabad1deaabad1deaabad1dea"

function knownPlaceholder(secret: string): string {
  return placeholderFor("github-pat", secretHash(secret, PLUGIN_KEY))
}

// makePlugin mkdtemps a sandbox per call and this file had no cleanup, so each
// run leaked a temp tree (a planted key file + auth.json) into the developer's
// tmpdir — ~1,000 dirs before this was added. afterEach frees each test's
// sandbox promptly; the afterAll backstop waits out the plugin's 250ms
// trailing-edge fingerprint debounce (src/index.ts:376, which has no cancel
// path) so a write that lands after a sandbox was removed cannot leave a
// partial directory behind.
const FINGERPRINT_DEBOUNCE_SETTLE_MS = 500
const sandboxRoots: string[] = []
const allSandboxRoots: string[] = []
const pluginHooks: Hooks[] = []
const fixtureEnvKeys = [
  "OPENCODE_CONFIG_DIR",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_MODELS_PATH",
] as const
let fixtureEnv: Array<string | undefined> = []
beforeEach(() => {
  fixtureEnv = fixtureEnvKeys.map((key) => process.env[key])
})
const removeAll = (roots: string[]) =>
  Promise.all(
    roots.map((root) => fs.rm(root, { recursive: true, force: true })),
  )
afterEach(async () => {
  for (const hooks of pluginHooks.splice(0)) await hooks.dispose?.()
  for (const [index, key] of fixtureEnvKeys.entries()) {
    const value = fixtureEnv[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await removeAll(sandboxRoots.splice(0))
})
afterAll(async () => {
  await new Promise((resolve) =>
    setTimeout(resolve, FINGERPRINT_DEBOUNCE_SETTLE_MS),
  )
  await removeAll(allSandboxRoots)
})

type PluginInput = Parameters<typeof RedactSecretsPlugin>[0]
type Hooks = Awaited<ReturnType<typeof RedactSecretsPlugin>>

type LogEntry = {
  level: string
  message: string
  extra?: Record<string, unknown>
}

type Setup = {
  hooks: Hooks
  root: string
  /** Every app.log the factory emitted during boot. */
  logs: LogEntry[]
  /** Re-run the plugin factory against the same sandbox — a fake "restart". */
  boot: () => Promise<Hooks>
}

async function makePlugin(input?: {
  version?: string
  optionsFile?: unknown
  /** Raw text for redact-secrets.json — bypasses JSON.stringify so a
   * deliberately malformed config can be planted (the JSON.stringify path
   * above can only ever write valid JSON). */
  optionsFileRaw?: string
  authJson?: string
  omitAuthFile?: boolean
  /** models.dev snapshot planted at <cache>/opencode/models.json when set. */
  catalog?: unknown
  /** Contents planted as the placeholder key file; defaults to PLUGIN_KEY. */
  keyFile?: string
}): Promise<Setup> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "redact-secrets-test-"))
  sandboxRoots.push(root)
  allSandboxRoots.push(root)
  const configDir = path.join(root, "config")
  const dataDir = path.join(root, "data", "opencode")
  const cacheDir = path.join(root, "cache", "opencode")
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(dataDir, { recursive: true })
  await fs.mkdir(cacheDir, { recursive: true })
  // Plant a fixed placeholder key so the plugin's fingerprints are
  // reproducible in-test; production mints a random one on first run.
  await fs.writeFile(
    path.join(dataDir, "redact-secrets.key"),
    input?.keyFile ?? PLUGIN_KEY,
  )
  // The plugin derives these exactly as the host does — from the environment.
  // XDG_CACHE_HOME must point into the sandbox even when no catalog fixture
  // is planted, so the developer machine's real models.json never leaks in.
  process.env.OPENCODE_CONFIG_DIR = configDir
  process.env.XDG_DATA_HOME = path.join(root, "data")
  process.env.XDG_CACHE_HOME = path.join(root, "cache")
  delete process.env.OPENCODE_MODELS_PATH
  if (input?.optionsFile !== undefined) {
    await fs.writeFile(
      path.join(configDir, "redact-secrets.json"),
      JSON.stringify(input.optionsFile),
    )
  }
  if (input?.optionsFileRaw !== undefined) {
    await fs.writeFile(
      path.join(configDir, "redact-secrets.json"),
      input.optionsFileRaw,
    )
  }
  if (!input?.omitAuthFile) {
    await fs.writeFile(path.join(dataDir, "auth.json"), input?.authJson ?? "{}")
  }
  if (input?.catalog !== undefined) {
    await fs.writeFile(
      path.join(cacheDir, "models.json"),
      JSON.stringify(input.catalog),
    )
  }

  const logs: LogEntry[] = []
  const client = {
    global: { health: async () => ({ version: input?.version ?? BAND.floor }) },
    app: {
      log: async (input: { body?: LogEntry }) => {
        if (input?.body) logs.push(input.body)
        return {}
      },
    },
    tui: { showToast: async () => ({}) },
  }
  const boot = async () => {
    const hooks = await RedactSecretsPlugin({
      client,
      directory: root,
      serverUrl: new URL("http://localhost:1"),
    } as unknown as PluginInput)
    pluginHooks.push(hooks)
    return hooks
  }
  const hooks = await boot()
  return { hooks, root, logs, boot }
}

describe("version guard", () => {
  // A v1 host outside the verified band warns but still redacts — losing
  // redaction on a merely-untested host would be the worse failure.
  test("an untested v1 host still registers the redaction hooks", async () => {
    const { hooks } = await makePlugin({ version: BAND.belowBand })
    expect(typeof hooks["experimental.chat.messages.transform"]).toBe(
      "function",
    )
  })

  // A non-v1 host (OpenCode v2+, whose plugin API differs) disables redaction.
  test("a non-v1 host gets no hooks at all", async () => {
    const { hooks, root } = await makePlugin({ version: "2.0.0" })
    expect(Object.keys(hooks)).toEqual([])
    const source = { text: FAKE_PAT }
    expect(
      redactSourceValue(
        { serverUrl: "http://localhost:1", directory: root },
        source,
      ),
    ).toBe(source)
  })
})

describe("optional source-redaction producer", () => {
  const GENERIC = "x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce"
  const FACEBOOK = "123456789012345|a1b2c3d4e5f6g7h8i9j0k1l2m3n"
  const scope = (root: string) => ({
    serverUrl: "http://localhost:1",
    directory: root,
  })

  test("uses the live hook vault for a previously recognized context-dependent value without mutating sources", async () => {
    const { hooks, root } = await makePlugin()
    const source = Object.freeze({
      parts: Object.freeze([{ text: `- ${GENERIC}` }]),
    })
    expect(redactSourceValue(scope(root), source)).toEqual(source)

    const named = { type: "text", text: `api_key = ${GENERIC}` }
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [{ info: {}, parts: [named] }],
    } as never)
    const placeholder = new RegExp(PLACEHOLDER_RE.source).exec(named.text)?.[0]
    if (!placeholder) throw new Error("fixture did not redact")

    const snapshot = redactSourceValue(scope(root), source)
    expect(snapshot.parts[0]?.text).toBe(`- ${placeholder}`)
    expect(snapshot).not.toBe(source)
    expect(snapshot.parts).not.toBe(source.parts)
    expect(source.parts[0]?.text).toBe(`- ${GENERIC}`)
    expect(redactSourceValue(scope(root), GENERIC)).toBe(placeholder)

    const restored = { text: snapshot.parts[0]?.text ?? "" }
    await hooks["experimental.text.complete"]?.({} as never, restored)
    expect(restored.text).toBe(`- ${GENERIC}`)
  })

  test("notes all complete sources before scanning, including keywords in later field names", async () => {
    const { root } = await makePlugin()
    const source = {
      earlier: [{ text: `access = ${FACEBOOK}\n` }, { text: `- ${GENERIC}` }],
      later: { facebook: true, api_key: GENERIC },
    }
    const before = JSON.stringify(source)
    const snapshot = redactSourceValue(scope(root), source)
    expect(snapshot.earlier[0]?.text).not.toContain(FACEBOOK)
    expect(snapshot.earlier[0]?.text).toContain("[REDACTED-SECRET:")
    expect(snapshot.earlier[1]?.text).not.toContain(GENERIC)
    expect(snapshot.later.api_key).toContain("[REDACTED-SECRET:")
    expect(JSON.stringify(source)).toBe(before)
  })

  test("uses configured detectors and keeps project/server engines isolated", async () => {
    const disabled = await makePlugin({
      optionsFile: {
        disabledRules: ["facebook-access-token", "generic-api-key"],
      },
    })
    const active = await makePlugin()
    const source = { text: `facebook access = ${FACEBOOK}\n` }
    expect(redactSourceValue(scope(active.root), source).text).not.toContain(
      FACEBOOK,
    )
    expect(redactSourceValue(scope(disabled.root), source)).toEqual(source)
    expect(
      redactSourceValue(
        { ...scope(active.root), serverUrl: "http://localhost:2" },
        source,
      ),
    ).toBe(source)
    expect(
      redactSourceValue(
        { ...scope(active.root), directory: `${active.root}/absent` },
        source,
      ),
    ).toBe(source)

    // Learning in another project's vault must not teach this project's engine.
    redactSourceValue(scope(active.root), { api_key: GENERIC })
    expect(
      redactSourceValue(scope(disabled.root), { text: GENERIC }).text,
    ).toBe(GENERIC)
  })

  test("dispose releases only its own registration, never a newer live producer", async () => {
    const setup = await makePlugin()
    const newer = await setup.boot()
    const source = { text: FAKE_PAT }
    await setup.hooks.dispose?.()
    expect(redactSourceValue(scope(setup.root), source).text).toBe(
      knownPlaceholder(FAKE_PAT),
    )
    await newer.dispose?.()
    expect(redactSourceValue(scope(setup.root), source)).toBe(source)
    const latest = await setup.boot()
    await newer.dispose?.()
    expect(redactSourceValue(scope(setup.root), source).text).toBe(
      knownPlaceholder(FAKE_PAT),
    )
    await latest.dispose?.()
  })

  test("nonserializable and walk-limit sources abort with a sanitized constant error", async () => {
    const { root, logs } = await makePlugin()
    const cycle: Record<string, unknown> = { text: FAKE_PAT }
    cycle.self = cycle
    let deep: unknown = { text: FAKE_PAT }
    for (let i = 0; i < MAX_WALK_DEPTH + 10; i++) deep = { nested: deep }
    // Prove this fixture reaches the walker, not JSON.stringify's own limit.
    expect(() => JSON.stringify(deep)).not.toThrow()
    for (const source of [
      cycle,
      { value: 1n },
      undefined,
      { text: FAKE_PAT, deep },
    ]) {
      let error: unknown
      try {
        redactSourceValue(scope(root), source)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("Source redaction failed")
      expect((error as Error).cause).toBeUndefined()
      expect(String((error as Error).stack)).not.toContain(FAKE_PAT)
    }
    expect(cycle.text).toBe(FAKE_PAT)
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "source redaction failed (WalkLimitError)",
      }),
    )
    expect(JSON.stringify(logs)).not.toContain(FAKE_PAT)
  })

  test("logs only fixed producer failure categories, never source-bearing error fields", async () => {
    const { root, logs } = await makePlugin()
    const failures: [unknown, string][] = [
      [new WalkLimitError("depth"), "WalkLimitError"],
      [new VaultLimitError(), "VaultLimitError"],
      [new FingerprintLimitError(), "FingerprintLimitError"],
      [new Error(), "unexpected error"],
      [FAKE_PAT, "unexpected error"],
    ]
    for (const [failure, category] of failures) {
      if (failure instanceof Error) {
        failure.message = FAKE_PAT
        failure.cause = new Error(FAKE_PAT)
        Object.defineProperty(failure, "name", {
          get() {
            throw new Error(FAKE_PAT)
          },
        })
      }
      const scan = spyOn(
        Redactor.prototype,
        "noteScanContextCached",
      ).mockImplementation(() => {
        throw failure
      })
      try {
        const before = logs.length
        expect(() =>
          redactSourceValue(scope(root), { text: FAKE_PAT }),
        ).toThrow(/^Source redaction failed$/)
        expect(logs.slice(before)).toEqual([
          expect.objectContaining({
            level: "warn",
            message: `source redaction failed (${category})`,
          }),
        ])
        expect(JSON.stringify(logs)).not.toContain(FAKE_PAT)
      } finally {
        scan.mockRestore()
      }
    }
  })
})

describe("outbound redaction hooks", () => {
  test("messages.transform redacts part content in place, skipping structural keys", async () => {
    const { hooks } = await makePlugin()
    const part = { id: "prt_1", type: "text", text: `token = ${FAKE_PAT}` }
    const output = { messages: [{ info: { id: "msg_1" }, parts: [part] }] }
    await hooks["experimental.chat.messages.transform"]?.({}, output as never)
    expect(part.text).not.toContain(FAKE_PAT)
    expect(part.text).toMatch(new RegExp(PLACEHOLDER_RE.source))
    expect(part.id).toBe("prt_1")
  })

  test("a rule keyword in one part gates the rule in a sibling part — in either order", async () => {
    // facebook-access-token gates on "facebook", which is NOT in its token
    // pattern. The provider reads all parts as one document, so the keyword
    // part must cover the token part wherever each sits: the transform notes
    // the full message set before scanning any part (a per-part gate
    // reproducibly leaked the token when the keyword sat in a sibling).
    const fbToken = "123456789012345|a1b2c3d4e5f6g7h8i9j0k1l2m3n"
    for (const order of ["keyword-first", "token-first"] as const) {
      const { hooks } = await makePlugin()
      const keywordPart = {
        id: "prt_k",
        type: "text",
        text: "facebook token follows",
      }
      const tokenPart = {
        id: "prt_t",
        type: "text",
        text: `access = ${fbToken}\n`,
      }
      const parts =
        order === "keyword-first"
          ? [keywordPart, tokenPart]
          : [tokenPart, keywordPart]
      const output = { messages: [{ info: { id: "msg_1" }, parts }] }
      await hooks["experimental.chat.messages.transform"]?.({}, output as never)
      expect(tokenPart.text).not.toContain(fbToken)
      expect(tokenPart.text).toMatch(new RegExp(PLACEHOLDER_RE.source))
    }
  })

  test("a keyword in one MESSAGE gates the rule in a part of another message", async () => {
    const fbToken = "123456789012345|a1b2c3d4e5f6g7h8i9j0k1l2m3n"
    const { hooks } = await makePlugin()
    const tokenPart = {
      id: "prt_t",
      type: "text",
      text: `access = ${fbToken}\n`,
    }
    const output = {
      messages: [
        { info: { id: "msg_1" }, parts: [tokenPart] },
        {
          info: { id: "msg_2" },
          parts: [
            { id: "prt_k", type: "text", text: "the facebook credentials:" },
          ],
        },
      ],
    }
    await hooks["experimental.chat.messages.transform"]?.({}, output as never)
    expect(tokenPart.text).not.toContain(fbToken)
  })

  test("a repeated request with identical history still redacts (the digest gate skips only the sweep)", async () => {
    // Audit M7: history messages are noted through a content-digest gate, so
    // the second request's identical bytes skip the keyword sweep — but the
    // REDACTION of every part must be completely unaffected.
    const { hooks } = await makePlugin()
    const makeOutput = () => ({
      messages: [
        {
          info: { id: "msg_1" },
          parts: [{ id: "prt_1", type: "text", text: `token = ${FAKE_PAT}` }],
        },
      ],
    })
    const first = makeOutput()
    await hooks["experimental.chat.messages.transform"]?.({}, first as never)
    expect(first.messages[0]?.parts[0]?.text).not.toContain(FAKE_PAT)

    const second = makeOutput()
    await hooks["experimental.chat.messages.transform"]?.({}, second as never)
    expect(second.messages[0]?.parts[0]?.text).not.toContain(FAKE_PAT)
    expect(second.messages[0]?.parts[0]?.text).toMatch(
      new RegExp(PLACEHOLDER_RE.source),
    )
  })

  test("a keyword arriving in a LATER request gates a token in unchanged history", async () => {
    // The digest gate must never freeze the keyword set: request 2's new
    // message brings the gating keyword, and the token message — identical
    // bytes to request 1, so its note is skipped — must now be redacted via
    // the sticky context those unchanged bytes already seeded.
    const fbToken = "123456789012345|a1b2c3d4e5f6g7h8i9j0k1l2m3n"
    const { hooks } = await makePlugin()
    const tokenMessage = () => ({
      info: { id: "msg_1" },
      parts: [{ id: "prt_t", type: "text", text: `access = ${fbToken}\n` }],
    })
    const first = { messages: [tokenMessage()] }
    await hooks["experimental.chat.messages.transform"]?.({}, first as never)
    expect(first.messages[0]?.parts[0]?.text).toContain(fbToken) // no keyword anywhere yet

    const second = {
      messages: [
        tokenMessage(),
        {
          info: { id: "msg_2" },
          parts: [
            { id: "prt_k", type: "text", text: "the facebook credentials:" },
          ],
        },
      ],
    }
    await hooks["experimental.chat.messages.transform"]?.({}, second as never)
    expect(second.messages[0]?.parts[0]?.text).not.toContain(fbToken)
  })

  test("a url nested in tool input is data, not structure, and gets redacted", async () => {
    const { hooks } = await makePlugin()
    const part = {
      id: "prt_1",
      type: "tool",
      tool: "webfetch",
      callID: "call_1",
      state: {
        status: "completed",
        input: { url: `https://host/api?token=${FAKE_PAT}` },
        output: "ok",
        title: "fetch",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }
    const output = { messages: [{ info: { id: "msg_1" }, parts: [part] }] }
    await hooks["experimental.chat.messages.transform"]?.({}, output as never)
    expect(part.state.input.url).not.toContain(FAKE_PAT)
    expect(part.state.input.url).toMatch(new RegExp(PLACEHOLDER_RE.source))
  })

  test("a remote attachment url with a secret is redacted before it reaches a provider", async () => {
    // OpenCode forwards a file part's url to the model verbatim, so a secret
    // in a remote http(s) url must be scanned by this universal layer — the
    // one guard that also covers the OAuth providers the wire backstop skips.
    const { hooks } = await makePlugin()
    const attachment = {
      id: "prt_1",
      type: "file",
      mime: "image/png",
      url: `https://cdn.example/i.png?token=${FAKE_PAT}`,
    }
    const output = {
      messages: [{ info: { id: "msg_1" }, parts: [attachment] }],
    }
    await hooks["experimental.chat.messages.transform"]?.({}, output as never)
    expect(attachment.url).not.toContain(FAKE_PAT)
    // The rebuilt url percent-encodes the query value, placeholder included;
    // decode the parameter to confirm the placeholder replaced the secret.
    expect(new URL(attachment.url).searchParams.get("token")).toMatch(
      new RegExp(PLACEHOLDER_RE.source),
    )
  })

  test("system.transform redacts entries and appends the placeholder note", async () => {
    const { hooks } = await makePlugin()
    const output = { system: [`context: ${FAKE_PAT}`] }
    await hooks["experimental.chat.system.transform"]?.(
      { model: {} } as never,
      output as never,
    )
    expect(output.system[0]).not.toContain(FAKE_PAT)
    expect(output.system[output.system.length - 1]).toBe(SYSTEM_NOTE)
  })

  test("the note can be turned off in the options file", async () => {
    const { hooks } = await makePlugin({ optionsFile: { systemNote: false } })
    const output = { system: ["plain system prompt"] }
    await hooks["experimental.chat.system.transform"]?.(
      { model: {} } as never,
      output as never,
    )
    expect(output.system).toEqual(["plain system prompt"])
  })

  test("tool.definition redacts the description and swaps in a redacted schema clone", async () => {
    const { hooks } = await makePlugin()
    // The jsonSchema on the hook payload is a reference into the registry's
    // cached tool definition; the hook must replace it with a redacted clone,
    // never mutate the cached object. `parameters` is live schema machinery
    // (functions) and must be left alone.
    const cachedSchema = {
      type: "object",
      properties: {
        token: {
          type: "string",
          default: `use ${FAKE_PAT}`,
          enum: [`use ${FAKE_PAT}`],
        },
      },
    }
    const parameters = { validate: () => true }
    const output = {
      description: `Authenticate with token=${FAKE_PAT}`,
      parameters,
      jsonSchema: cachedSchema,
    }
    await hooks["tool.definition"]?.({ toolID: "demo" }, output as never)
    expect(output.description).not.toContain(FAKE_PAT)
    expect(output.description).toMatch(new RegExp(PLACEHOLDER_RE.source))
    expect(JSON.stringify(output.jsonSchema)).not.toContain(FAKE_PAT)
    expect(output.jsonSchema).not.toBe(cachedSchema)
    expect(cachedSchema.properties.token.default).toContain(FAKE_PAT)
    expect(output.parameters).toBe(parameters)
  })

  test("tool.definition swaps in the scanned snapshot even when clean", async () => {
    const { hooks } = await makePlugin()
    const cachedSchema = {
      type: "object",
      properties: { path: { type: "string" } },
    }
    const output = {
      description: "Read a file from disk.",
      parameters: {},
      jsonSchema: cachedSchema,
    }
    await hooks["tool.definition"]?.({ toolID: "read" }, output as never)
    expect(output.description).toBe("Read a file from disk.")
    // The snapshot that was SCANNED is what ships, clean or not: retaining
    // the original object would let a live toJSON or getter serialize
    // something the scan never saw (finding, round 17).
    expect(output.jsonSchema).not.toBe(cachedSchema)
    expect(output.jsonSchema).toEqual(cachedSchema)
  })

  test("a tool's ID is detection context for its own definition (finding)", async () => {
    // {"name":"facebook","description":…} is one serialized document on the
    // wire: a tool NAMED after a vendor must gate that vendor's rules for the
    // description holding only the bare token.
    const fbToken = "123456789012345|a1b2c3d4e5f6g7h8i9j0k1l2m3n"
    const { hooks } = await makePlugin()
    const output = {
      description: `access = ${fbToken}\n`,
      parameters: {},
      jsonSchema: { type: "object" },
    }
    await hooks["tool.definition"]?.({ toolID: "facebook" }, output as never)
    expect(output.description).not.toContain(fbToken)
    expect(output.description).toMatch(new RegExp(PLACEHOLDER_RE.source))
  })

  test("a keyword-bearing tool ID gives its schema's top level field context", async () => {
    // The ID is the schema's enclosing name on the wire: a generic value with
    // no signal of its own must scan like the flat "x-api-key-tool=<value>"
    // line — on the redacted CLONE, never the cached schema.
    const generic = "x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce"
    const { hooks } = await makePlugin()
    const cachedSchema = { type: "object", description: generic }
    const output = {
      description: "manage keys",
      parameters: {},
      jsonSchema: cachedSchema,
    }
    await hooks["tool.definition"]?.(
      { toolID: "x-api-key-tool" },
      output as never,
    )
    expect(JSON.stringify(output.jsonSchema)).not.toContain(generic)
    expect(JSON.stringify(output.jsonSchema)).toContain(
      "[REDACTED-SECRET:generic-api-key:",
    )
    expect(cachedSchema.description).toBe(generic)
  })

  test("a keyword in an earlier tool's ID covers a later definition in the same pass", async () => {
    // Definitions fire one hook call each, in registry order; the note is
    // sticky, so an earlier definition's keyword gates every later one (and
    // all of them from the next request on).
    const fbToken = "123456789012345|a1b2c3d4e5f6g7h8i9j0k1l2m3n"
    const { hooks } = await makePlugin()
    const first = {
      description: "post to the wall",
      parameters: {},
      jsonSchema: { type: "object" },
    }
    await hooks["tool.definition"]?.({ toolID: "facebook" }, first as never)
    const second = {
      description: `access = ${fbToken}\n`,
      parameters: {},
      jsonSchema: { type: "object" },
    }
    await hooks["tool.definition"]?.({ toolID: "post" }, second as never)
    expect(second.description).not.toContain(fbToken)
    expect(second.description).toMatch(new RegExp(PLACEHOLDER_RE.source))
  })

  test("a non-cloneable schema extension cannot shield a secret (audit M10)", async () => {
    // The fail-open path: structuredClone rejects the function, but JSON
    // serialization — which is what actually builds the wire request — drops
    // it silently and keeps the secret-bearing sibling. The hook must swap in
    // the redacted wire-visible (JSON round-trip) form, never retain the
    // original schema because the clone failed.
    const { hooks } = await makePlugin()
    const cachedSchema = {
      type: "object",
      properties: { token: { type: "string", default: `use ${FAKE_PAT}` } },
      "x-validate": () => true,
    }
    const output = {
      description: "demo tool",
      parameters: {},
      jsonSchema: cachedSchema as unknown,
    }
    await hooks["tool.definition"]?.({ toolID: "demo" }, output as never)
    expect(output.jsonSchema).not.toBe(cachedSchema)
    const wire = JSON.stringify(output.jsonSchema)
    expect(wire).not.toContain(FAKE_PAT)
    expect(wire).toContain("[REDACTED-SECRET:github-pat:")
    // The registry's cached definition is never mutated.
    expect(cachedSchema.properties.token.default).toContain(FAKE_PAT)
  })

  test("a clean non-cloneable schema ships its wire-visible snapshot, not the original", async () => {
    // The JSON round-trip clone is not just a scanning vehicle — it IS the
    // wire form, and it must ship even when clean: the original's live
    // toJSON could serialize differently under the host's property key than
    // it did under the top-level probe (finding, round 17).
    const { hooks } = await makePlugin()
    const cachedSchema = {
      type: "object",
      properties: { path: { type: "string" } },
      "x-validate": () => true,
    }
    const output = {
      description: "read a file",
      parameters: {},
      jsonSchema: cachedSchema as unknown,
    }
    await hooks["tool.definition"]?.({ toolID: "read" }, output as never)
    expect(output.jsonSchema).not.toBe(cachedSchema)
    expect(output.jsonSchema).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    })
  })

  test("an inherited toJSON cannot smuggle a secret past a clean scan (finding)", async () => {
    // structuredClone strips the prototype, so the scanned clone holds only
    // the clean own data — but the host serializes whatever object the hook
    // leaves installed, and JSON.stringify would call the ORIGINAL's
    // inherited toJSON, emitting the secret. The scanned snapshot must ship.
    const { hooks } = await makePlugin()
    class SchemaWithSerializer {
      type = "object"
      toJSON() {
        return { type: "object", description: `token=${FAKE_PAT}` }
      }
    }
    const cachedSchema = new SchemaWithSerializer()
    const output = {
      description: "demo tool",
      parameters: {},
      jsonSchema: cachedSchema as unknown,
    }
    await hooks["tool.definition"]?.({ toolID: "demo" }, output as never)
    expect(output.jsonSchema).not.toBe(cachedSchema)
    expect(JSON.stringify({ input_schema: output.jsonSchema })).not.toContain(
      FAKE_PAT,
    )
  })

  test("a key-sensitive toJSON cannot answer the probe clean and the wire dirty (finding)", async () => {
    // JSON.stringify(schema) probes toJSON with key "", while the host
    // serializes the same object under a property name — a toJSON(key) can
    // tell the two apart. Installing the probed snapshot makes the probe's
    // clean answer the only thing that can ship.
    const { hooks } = await makePlugin()
    const cachedSchema = {
      type: "object",
      toJSON(key: string) {
        return key === ""
          ? { type: "object" }
          : { type: "object", description: `token=${FAKE_PAT}` }
      },
    }
    const output = {
      description: "demo tool",
      parameters: {},
      jsonSchema: cachedSchema as unknown,
    }
    await hooks["tool.definition"]?.({ toolID: "demo" }, output as never)
    expect(output.jsonSchema).not.toBe(cachedSchema)
    expect(output.jsonSchema).toEqual({ type: "object" })
    expect(JSON.stringify({ input_schema: output.jsonSchema })).not.toContain(
      FAKE_PAT,
    )
  })

  test("a schema whose wire form cannot be pinned aborts the request", async () => {
    // toJSON collapses the schema to nothing at the top level. A nullish
    // jsonSchema would make the host fall back to serializing `parameters`
    // (fromTool's `??`), which no layer scans — abort closed instead.
    const { hooks } = await makePlugin()
    const cachedSchema = { toJSON: () => undefined }
    const output = {
      description: "demo tool",
      parameters: {},
      jsonSchema: cachedSchema as unknown,
    }
    await expect(
      hooks["tool.definition"]?.({ toolID: "demo" }, output as never),
    ).rejects.toThrow(/serialized to nothing/)
  })

  test("a schema that can be neither cloned nor serialized aborts the request", async () => {
    // A function (structuredClone rejects) plus a cycle (JSON.stringify
    // rejects): no layer could ever scan this, and the host could not
    // serialize it either — the hook throws so the request dies closed
    // instead of forwarding a schema nothing has looked at.
    const { hooks } = await makePlugin()
    const cachedSchema: Record<string, unknown> = {
      "x-validate": () => true,
      note: `token=${FAKE_PAT}`,
    }
    cachedSchema.self = cachedSchema
    const output = {
      description: "demo tool",
      parameters: {},
      jsonSchema: cachedSchema as unknown,
    }
    await expect(
      hooks["tool.definition"]?.({ toolID: "demo" }, output as never),
    ).rejects.toThrow(/neither cloned nor serialized/)
  })

  test("a cyclic schema aborts the request instead of walking forever", async () => {
    // structuredClone preserves cycles, so the clone succeeds and the bounded
    // walk is what fails — closed, before any request exists.
    const { hooks } = await makePlugin()
    const cachedSchema: Record<string, unknown> = {
      type: "object",
      note: `token=${FAKE_PAT}`,
    }
    cachedSchema.self = cachedSchema
    const output = {
      description: "demo tool",
      parameters: {},
      jsonSchema: cachedSchema as unknown,
    }
    await expect(
      hooks["tool.definition"]?.({ toolID: "demo" }, output as never),
    ).rejects.toThrow(WalkLimitError)
  })

  test("a pathologically deep schema aborts the request", async () => {
    const { hooks } = await makePlugin()
    let deep: Record<string, unknown> = { default: FAKE_PAT }
    for (let i = 0; i < 1100; i++) deep = { properties: deep }
    const output = {
      description: "demo tool",
      parameters: {},
      jsonSchema: deep as unknown,
    }
    await expect(
      hooks["tool.definition"]?.({ toolID: "demo" }, output as never),
    ).rejects.toThrow(WalkLimitError)
  })

  test("a message that cannot be serialized still has its parts redacted, and does not throw (finding)", async () => {
    // JSON.stringify(message) throws on the BigInt in message.info, so that
    // message contributes no cross-string keyword — but its OWN parts must
    // still be walked, and the hook must not abort. The two surviving mutants
    // this kills: `catch { return }` (skips the whole redaction loop — total
    // bypass) and `catch { throw }` (kills the request). Every existing
    // transform fixture is JSON-safe, so line index.ts:829 never runs.
    const { hooks } = await makePlugin()
    const fbToken = "123456789012345|a1b2c3d4e5f6g7h8i9j0k1l2m3n"
    const selfPart = { id: "prt_0", type: "text", text: `token = ${FAKE_PAT}` }
    const tokenPart = {
      id: "prt_1",
      type: "text",
      text: `access = ${fbToken}\n`,
    }
    const keywordPart = {
      id: "prt_2",
      type: "text",
      text: "the facebook credentials:",
    }
    const output = {
      messages: [
        // A BigInt makes JSON.stringify(message) throw; parts stay JSON-safe.
        { info: { id: "msg_0", cursor: 1n }, parts: [selfPart] },
        { info: { id: "msg_1" }, parts: [tokenPart] },
        { info: { id: "msg_2" }, parts: [keywordPart] },
      ],
    }
    await hooks["experimental.chat.messages.transform"]?.({}, output as never)
    // The unserializable message's own part is still redacted (loop still ran).
    expect(selfPart.text).not.toContain(FAKE_PAT)
    expect(selfPart.text).toMatch(new RegExp(PLACEHOLDER_RE.source))
    // A serializable sibling's keyword still gates the bare token.
    expect(tokenPart.text).not.toContain(fbToken)
  })

  test("a tool definition with no jsonSchema still redacts the description and does not throw (fail-open path)", async () => {
    // Every other tool.definition test hands the hook a jsonSchema, so the
    // ABSENT-field case — the plugin's one fail-OPEN path, where the schema
    // block at index.ts:948 is skipped — is exercised by nothing. Pin that the
    // description is still scanned, the hook resolves, and no schema is
    // fabricated. The host-contract that the field is present is guarded
    // separately in sdk-contract.test.ts.
    const { hooks } = await makePlugin()
    const output: {
      description: string
      parameters: unknown
      jsonSchema?: unknown
    } = {
      description: `call with token=${FAKE_PAT}`,
      parameters: {},
    }
    await hooks["tool.definition"]?.({ toolID: "demo" }, output as never)
    expect(output.description).not.toContain(FAKE_PAT)
    expect(output.description).toContain("[REDACTED-SECRET:github-pat:")
    expect(output.jsonSchema).toBeUndefined()
  })

  test("a schema whose toJSON collapses it to a string is scanned, not shipped raw (finding)", async () => {
    // structuredClone throws on the toJSON FUNCTION property, so the wire form
    // is JSON.parse(JSON.stringify(schema)) — and JSON.stringify honours toJSON,
    // yielding a bare STRING clone. That string must be scanned under the tool
    // ID (index.ts:970-971), not pinned unscanned.
    const { hooks } = await makePlugin()
    const cachedSchema = {
      type: "object",
      toJSON() {
        return `schema default: ${FAKE_PAT}`
      },
    }
    const output = {
      description: "demo tool",
      parameters: {},
      jsonSchema: cachedSchema as unknown,
    }
    await hooks["tool.definition"]?.({ toolID: "demo" }, output as never)
    expect(typeof output.jsonSchema).toBe("string")
    expect(output.jsonSchema).not.toContain(FAKE_PAT)
    expect(output.jsonSchema).toMatch(new RegExp(PLACEHOLDER_RE.source))
  })

  test("a schema whose toJSON returns a clean string is pinned verbatim", async () => {
    // The pin-without-mangling contract for the string branch: a clean scanned
    // string is the exact wire form and ships unchanged.
    const { hooks } = await makePlugin()
    const cachedSchema = {
      type: "object",
      toJSON() {
        return "clean schema text"
      },
    }
    const output = {
      description: "demo tool",
      parameters: {},
      jsonSchema: cachedSchema as unknown,
    }
    await hooks["tool.definition"]?.({ toolID: "read" }, output as never)
    expect(output.jsonSchema).toBe("clean schema text")
  })

  test("a schema whose toJSON returns a scalar is pinned (number/boolean branch)", async () => {
    // The number/boolean branch (index.ts:972-974): nothing to scan, but the
    // scalar must still be pinned so the original live object is not what ships.
    const { hooks } = await makePlugin()
    const cachedSchema = {
      type: "object",
      toJSON() {
        return 42
      },
    }
    const output = {
      description: "demo tool",
      parameters: {},
      jsonSchema: cachedSchema as unknown,
    }
    await hooks["tool.definition"]?.({ toolID: "demo" }, output as never)
    expect(output.jsonSchema).toBe(42)
  })
})

describe("placeholder key persistence", () => {
  test("a corrupt key file is repaired atomically and survives a restart", async () => {
    const { hooks, root, boot } = await makePlugin({
      keyFile: "truncated-junk-not-a-key",
    })
    const keyPath = path.join(root, "data", "opencode", "redact-secrets.key")
    const repaired = (await fs.readFile(keyPath, "utf8")).trim()
    expect(repaired).toMatch(/^[0-9a-f]{64}$/)

    const redactVia = async (h: Hooks): Promise<string> => {
      const part = { type: "text", text: `token = ${FAKE_PAT}` }
      await h["experimental.chat.messages.transform"]?.({}, {
        messages: [{ info: {}, parts: [part] }],
      } as never)
      const match = new RegExp(PLACEHOLDER_RE.source).exec(part.text)
      if (!match) throw new Error("did not redact")
      return match[0]
    }

    // A "restarted" process must read the repaired key and derive the exact
    // same placeholder — before the repair, every start minted a fresh
    // ephemeral key and placeholders changed on each restart.
    const first = await redactVia(hooks)
    const second = await redactVia(await boot())
    expect(second).toBe(first)
    expect((await fs.readFile(keyPath, "utf8")).trim()).toBe(repaired)
  })

  test("a healthy key file is never rewritten", async () => {
    const { hooks, root } = await makePlugin()
    const keyPath = path.join(root, "data", "opencode", "redact-secrets.key")
    expect((await fs.readFile(keyPath, "utf8")).trim()).toBe(PLUGIN_KEY)
    // And the planted key is actually the one in use.
    const part = { type: "text", text: `token = ${FAKE_PAT}` }
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [{ info: {}, parts: [part] }],
    } as never)
    expect(part.text).toContain(knownPlaceholder(FAKE_PAT))
  })

  test("concurrent boots against a corrupt key file converge on ONE key", async () => {
    // The reviewed race: each repairer renaming its own fresh key over the
    // path let a process adopt a key the final file no longer held, minting
    // placeholders that were unrecoverable after the next restart. Repair is
    // now serialized behind a wx lock (only the holder rewrites, and it
    // re-reads first), so every concurrent boot must end up deriving the SAME
    // placeholder — and so must a later boot that reads the settled file.
    const setup = await makePlugin({
      keyFile: "junk-so-the-first-boot-repairs",
    })
    const keyPath = path.join(
      setup.root,
      "data",
      "opencode",
      "redact-secrets.key",
    )
    await fs.writeFile(keyPath, "corrupted-again-not-a-key")

    const redactVia = async (h: Hooks): Promise<string> => {
      const part = { type: "text", text: `token = ${FAKE_PAT}` }
      await h["experimental.chat.messages.transform"]?.({}, {
        messages: [{ info: {}, parts: [part] }],
      } as never)
      const match = new RegExp(PLACEHOLDER_RE.source).exec(part.text)
      if (!match) throw new Error("did not redact")
      return match[0]
    }

    const concurrent = await Promise.all([
      setup.boot(),
      setup.boot(),
      setup.boot(),
      setup.boot(),
    ])
    const placeholders = await Promise.all(concurrent.map(redactVia))
    expect(new Set(placeholders).size).toBe(1)
    // The settled file holds a valid key that derives that same placeholder.
    expect((await fs.readFile(keyPath, "utf8")).trim()).toMatch(
      /^[0-9a-f]{64}$/,
    )
    const [firstPlaceholder] = placeholders
    if (firstPlaceholder === undefined)
      throw new Error("no placeholder produced")
    expect(await redactVia(await setup.boot())).toBe(firstPlaceholder)
    // The repair lock is not left behind.
    await expect(fs.stat(`${keyPath}.lock`)).rejects.toThrow()
  })
})

describe("fingerprint catalog persistence", () => {
  // Context-gated: only the field name ever detects it by rule, so its bare
  // form is exactly the restored-prose shape the catalog exists for.
  const GENERIC = "x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce"
  const SIMPLE_CURL_AUTH = "audit225.user:Q7m2v9N4p8R1s6T0"
  const COMPLEX_CURL_AUTH = "audit225.user:Q7 m2?N4p8/R1!"
  const CLEAN_SUMMARY_TEXT = "Neighboring summary text stays unchanged."

  const waitForFile = async (file: string): Promise<string> => {
    // The catalog write is debounced (250ms); poll rather than guess.
    for (let i = 0; i < 40; i++) {
      try {
        return await fs.readFile(file, "utf8")
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    throw new Error(`fingerprint file never appeared: ${file}`)
  }

  test("a restored, contextless secret is still masked after a restart", async () => {
    const setup = await makePlugin()
    const keyed = { type: "text", text: `api_key = ${GENERIC}` }
    await setup.hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [{ info: {}, parts: [keyed] }],
    } as never)
    const match = new RegExp(PLACEHOLDER_RE.source).exec(keyed.text)
    if (!match) throw new Error("fixture did not redact")
    const placeholder = match[0]

    const catalogPath = path.join(
      setup.root,
      "data",
      "opencode",
      "redact-secrets.fingerprints.json",
    )
    const raw = await waitForFile(catalogPath)
    // Non-reversible on disk: hash + rule id + length, never the value.
    expect(raw).not.toContain(GENERIC)
    const parsed = JSON.parse(raw) as {
      entries: Array<{ hash: string; ruleId: string; length: number }>
    }
    expect(parsed.entries.length).toBe(1)
    expect(parsed.entries[0]?.length).toBe(GENERIC.length)

    // "Restart", then scan the prose text.complete wrote back: bare value, no
    // field context. Rule detection cannot see it; the catalog must.
    const restarted = await setup.boot()
    expect(
      redactSourceValue(
        { serverUrl: "http://localhost:1", directory: setup.root },
        { text: `- ${GENERIC}` },
      ).text,
    ).toBe(`- ${placeholder}`)
    const bare = { type: "text", text: `- ${GENERIC}` }
    await restarted["experimental.chat.messages.transform"]?.({}, {
      messages: [{ info: {}, parts: [bare] }],
    } as never)
    expect(bare.text).not.toContain(GENERIC)
    expect(bare.text).toContain(placeholder)
  })

  test("a restored unquoted curl auth pair is re-masked from disk after restart before it reaches the wire", async () => {
    const setup = await makePlugin()
    const original = `curl -u ${SIMPLE_CURL_AUTH} https://api.example.test`
    const expected = placeholderFor(
      "curl-auth-user",
      secretHash(SIMPLE_CURL_AUTH, PLUGIN_KEY),
    )
    const detected = { type: "text", text: original }
    await setup.hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [{ info: {}, parts: [detected] }],
    } as never)
    expect(detected.text).toBe(`curl -u ${expected} https://api.example.test`)

    // Completions include compaction summaries. With restoreText enabled, the
    // stored summary gets the raw pair back and has no curl context left.
    const summary = {
      text: `Compacted credential: ${expected}\n${CLEAN_SUMMARY_TEXT}`,
    }
    await setup.hooks["experimental.text.complete"]?.(
      { sessionID: "ses", messageID: "summary", partID: "prt" } as never,
      summary as never,
    )
    expect(summary.text).toBe(
      `Compacted credential: ${SIMPLE_CURL_AUTH}\n${CLEAN_SUMMARY_TEXT}`,
    )
    const catalogPath = path.join(
      setup.root,
      "data",
      "opencode",
      "redact-secrets.fingerprints.json",
    )
    // Restoration must flush the pending debounce BEFORE returning raw text
    // to the host, not rely on the process surviving another 250ms.
    const catalog = await fs.readFile(catalogPath, "utf8")
    expect(catalog).not.toContain(SIMPLE_CURL_AUTH)
    expect(catalog).not.toContain(original)
    expect(JSON.parse(catalog)).toEqual({
      version: 1,
      entries: [
        {
          hash: secretHash(SIMPLE_CURL_AUTH, PLUGIN_KEY),
          ruleId: "curl-auth-user",
          length: SIMPLE_CURL_AUTH.length,
        },
      ],
    })
    await fs.writeFile(
      path.join(setup.root, "persisted-summary.md"),
      summary.text,
    )

    // This fresh plugin has only the persisted fingerprint, not the original
    // vault mapping. Its transform must recover the bare pair from the catalog.
    const restarted = await setup.boot()
    const persistedSummary = await fs.readFile(
      path.join(setup.root, "persisted-summary.md"),
      "utf8",
    )
    const replayed = { type: "text", text: persistedSummary }
    await restarted["experimental.chat.messages.transform"]?.({}, {
      messages: [{ info: {}, parts: [replayed] }],
    } as never)
    expect(replayed.text).toBe(
      `Compacted credential: ${expected}\n${CLEAN_SUMMARY_TEXT}`,
    )
    expect(replayed.text).not.toContain(SIMPLE_CURL_AUTH)

    // Re-registration on the fresh instance also restores tool arguments.
    const args = { command: `curl -u ${expected} https://api.example.test` }
    await restarted["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses", callID: "call" } as never,
      { args } as never,
    )
    expect(args.command).toBe(original)

    // Use another fresh instance so the wire assertion cannot be satisfied by
    // the transform above having primed its in-memory vault.
    const coldWire = await setup.boot()
    const coldPersistedSummary = await fs.readFile(
      path.join(setup.root, "persisted-summary.md"),
      "utf8",
    )
    const seen: string[] = []
    const inner = async (_input: unknown, init?: RequestInit) => {
      seen.push(String(init?.body))
      return new Response("{}")
    }
    const config = {
      provider: { anthropic: { options: { fetch: inner } } },
    }
    await coldWire.config?.(config as never)
    const wrapped = config.provider.anthropic.options.fetch as typeof fetch
    await wrapped("https://api.anthropic.example/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: coldPersistedSummary }],
      }),
      headers: { "content-type": "application/json" },
    })
    expect(seen).toHaveLength(1)
    expect(JSON.parse(seen[0] ?? "")).toEqual({
      messages: [
        {
          role: "user",
          content: `Compacted credential: ${expected}\n${CLEAN_SUMMARY_TEXT}`,
        },
      ],
    })

    // A cap breach must stay fail-closed. In particular, it must not enter a
    // clean-result cache: the identical retry still rejects before inner fetch.
    const capped = await setup.boot()
    let innerCalls = 0
    const innerAtCap = async (_input: unknown, _init?: RequestInit) => {
      innerCalls++
      return new Response("{}")
    }
    const cappedConfig = {
      provider: { anthropic: { options: { fetch: innerAtCap } } },
    }
    await capped.config?.(cappedConfig as never)
    const cappedFetch = cappedConfig.provider.anthropic.options
      .fetch as typeof fetch
    const decoys = Array.from(
      { length: FINGERPRINT_MAX_CANDIDATES },
      // '_' is in the accepted ASCII run alphabet but never appears in base36,
      // unlike an 'a' pad which would make values such as a and aa collide.
      (_, i) => i.toString(36).padStart(SIMPLE_CURL_AUTH.length, "_"),
    )
    const overfullBody = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [...decoys, SIMPLE_CURL_AUTH].join(" "),
        },
      ],
    })
    const sendOverfull = () =>
      cappedFetch("https://api.anthropic.example/v1/messages", {
        method: "POST",
        body: overfullBody,
        headers: { "content-type": "application/json" },
      })
    await expect(sendOverfull()).rejects.toBeInstanceOf(FingerprintLimitError)
    await expect(sendOverfull()).rejects.toBeInstanceOf(FingerprintLimitError)
    expect(innerCalls).toBe(0)
  })

  test("a quoted curl auth pair remains restorable in process and safe across a summary restart", async () => {
    const setup = await makePlugin()
    const original = `curl -u '${COMPLEX_CURL_AUTH}' https://api.example.test`
    const detected = { type: "text", text: original }
    await setup.hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [{ info: {}, parts: [detected] }],
    } as never)
    const expected = new RegExp(PLACEHOLDER_RE.source).exec(detected.text)?.[0]
    if (!expected) throw new Error("quoted curl fixture did not redact")
    expect(expected).toContain("[REDACTED-SECRET:curl-auth-user:")
    expect(detected.text).toBe(`curl -u ${expected} https://api.example.test`)

    // The live vault must restore the complete quoted credential exactly at
    // the tool boundary, regardless of the summary-safety policy below.
    const inProcessArgs = {
      command: `curl -u ${expected} https://api.example.test`,
    }
    await setup.hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses", callID: "call" } as never,
      { args: inProcessArgs } as never,
    )
    expect(inProcessArgs.command).toBe(original)

    const summary = {
      text: `Compacted credential: ${expected}\n${CLEAN_SUMMARY_TEXT}`,
    }
    await setup.hooks["experimental.text.complete"]?.(
      { sessionID: "ses", messageID: "summary", partID: "prt" } as never,
      summary as never,
    )
    // Complex quoted credentials must remain opaque in persisted summary prose:
    // a later fresh process cannot safely recover a multi-token credential.
    const placeholderSummary = `Compacted credential: ${expected}\n${CLEAN_SUMMARY_TEXT}`
    expect(summary.text).toBe(placeholderSummary)
    await fs.writeFile(
      path.join(setup.root, "persisted-summary.md"),
      summary.text,
    )

    const catalogPath = path.join(
      setup.root,
      "data",
      "opencode",
      "redact-secrets.fingerprints.json",
    )
    const catalog = await waitForFile(catalogPath)
    expect(catalog).not.toContain(COMPLEX_CURL_AUTH)

    const restarted = await setup.boot()
    const replayed = {
      type: "text",
      text: await fs.readFile(
        path.join(setup.root, "persisted-summary.md"),
        "utf8",
      ),
    }
    await restarted["experimental.chat.messages.transform"]?.({}, {
      messages: [{ info: {}, parts: [replayed] }],
    } as never)
    expect(replayed.text).toBe(placeholderSummary)
    expect(replayed.text).not.toContain(COMPLEX_CURL_AUTH)
    expect(replayed.text).toContain(CLEAN_SUMMARY_TEXT)
  })

  test("in-flight writes certify only their captured snapshot and completion waits for queued writes", async () => {
    const setup = await makePlugin()
    const catalogPath = path.join(
      setup.root,
      "data",
      "opencode",
      "redact-secrets.fingerprints.json",
    )
    const other = "audit225.other:W6r8m2T9q4P1z7N0"
    const expected = placeholderFor(
      "curl-auth-user",
      secretHash(SIMPLE_CURL_AUTH, PLUGIN_KEY),
    )
    const otherPlaceholder = placeholderFor(
      "curl-auth-user",
      secretHash(other, PLUGIN_KEY),
    )
    const redact = async (secret: string) => {
      const part = { type: "text", text: `curl -u ${secret}` }
      await setup.hooks["experimental.chat.messages.transform"]?.({}, {
        messages: [{ info: {}, parts: [part] }],
      } as never)
    }
    const completions: Promise<void>[] = []
    const complete = (output: { text: string }) => {
      const pending = Promise.resolve(
        setup.hooks["experimental.text.complete"]?.(
          { sessionID: "ses", messageID: "summary", partID: "prt" } as never,
          output as never,
        ),
      )
      completions.push(pending)
      return pending
    }
    const firstWrite = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const secondWrite = Promise.withResolvers<void>()
    const releaseSecond = Promise.withResolvers<void>()
    let writes = 0
    // Named imports use the module namespace; the default fs object still
    // supplies the real rename. Scope the barrier to this test's catalog.
    const rename = spyOn(fsPromises, "rename").mockImplementation(
      async (from, to) => {
        if (to !== catalogPath) return fs.rename(from, to)
        if (++writes === 1) {
          firstWrite.resolve()
          await releaseFirst.promise
          return fs.rename(from, to)
        }
        secondWrite.resolve()
        await releaseSecond.promise
        throw new Error("simulated catalog rename failure")
      },
    )
    try {
      await redact(SIMPLE_CURL_AUTH)
      // The second placeholder is unknown when completion starts, but becomes
      // resolvable while the first write is blocked AFTER snapshot capture.
      const masked = `Saved values: ${expected} and ${otherPlaceholder}`
      const first = { text: masked }
      const flushing = complete(first)
      await firstWrite.promise

      const known = { text: `Saved value: ${expected}` }
      let drained = false
      const draining = complete(known).then(() => {
        drained = true
      })
      await Promise.resolve()
      expect(drained).toBe(false)
      expect(known.text).toBe(`Saved value: ${expected}`)

      await redact(other)
      releaseFirst.resolve()
      await Promise.all([flushing, draining])
      expect(known.text).toBe(`Saved value: ${SIMPLE_CURL_AUTH}`)
      expect(first.text).toBe(masked)

      const later = { text: `Saved value: ${otherPlaceholder}` }
      let finished = false
      const retrying = complete(later).then(() => {
        finished = true
      })
      await secondWrite.promise
      expect(finished).toBe(false)
      const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"))
      expect(catalog.entries).not.toContainEqual({
        hash: secretHash(other, PLUGIN_KEY),
        ruleId: "curl-auth-user",
        length: other.length,
      })
      releaseSecond.resolve()
      await retrying
      expect(later.text).toBe(`Saved value: ${otherPlaceholder}`)
    } finally {
      releaseFirst.resolve()
      releaseSecond.resolve()
      await Promise.allSettled(completions)
      rename.mockRestore()
    }
  })

  test("failed fingerprint writes keep prose masked and completion retries recover without a new registration", async () => {
    const setup = await makePlugin()
    const catalogPath = path.join(
      setup.root,
      "data",
      "opencode",
      "redact-secrets.fingerprints.json",
    )
    // An atomic rename cannot replace a directory, even under root. This
    // exercises a real write failure without chmod or global module mocks.
    await fs.mkdir(catalogPath)
    const original = `curl -u ${SIMPLE_CURL_AUTH} https://api.example.test`
    const expected = placeholderFor(
      "curl-auth-user",
      secretHash(SIMPLE_CURL_AUTH, PLUGIN_KEY),
    )
    const detected = { type: "text", text: original }
    await setup.hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [{ info: {}, parts: [detected] }],
    } as never)
    expect(detected.text).toContain(expected)
    const masked = `Compacted credential: ${expected}`
    const complete = async () => {
      const output = { text: masked }
      await setup.hooks["experimental.text.complete"]?.(
        { sessionID: "ses", messageID: "summary", partID: "prt" } as never,
        output as never,
      )
      return output.text
    }

    expect(await complete()).toBe(masked)
    expect(await complete()).toBe(masked)
    const warns = setup.logs.filter(
      (entry) =>
        entry.level === "warn" &&
        entry.message.includes("could not persist secret fingerprints"),
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]?.message).toContain("keeping completed text masked")

    // Storage trouble must not stop the live vault from restoring tool args.
    const args = { command: `curl -u ${expected} https://api.example.test` }
    await setup.hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses", callID: "call" } as never,
      { args } as never,
    )
    expect(args.command).toBe(original)

    await fs.rmdir(catalogPath)
    const restored = await complete()
    expect(restored).toBe(`Compacted credential: ${SIMPLE_CURL_AUTH}`)
    const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"))
    expect(catalog.entries).toContainEqual({
      hash: secretHash(SIMPLE_CURL_AUTH, PLUGIN_KEY),
      ruleId: "curl-auth-user",
      length: SIMPLE_CURL_AUTH.length,
    })
    const restarted = await setup.boot()
    const replayed = { type: "text", text: restored }
    await restarted["experimental.chat.messages.transform"]?.({}, {
      messages: [{ info: {}, parts: [replayed] }],
    } as never)
    expect(replayed.text).toBe(masked)
  })

  test("an unreadable catalog degrades to no recovery, not a crash", async () => {
    const setup = await makePlugin()
    const catalogPath = path.join(
      setup.root,
      "data",
      "opencode",
      "redact-secrets.fingerprints.json",
    )
    await fs.writeFile(catalogPath, "{ not json")
    const hooks = await setup.boot()
    const part = { type: "text", text: `token = ${FAKE_PAT}` }
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [{ info: {}, parts: [part] }],
    } as never)
    expect(part.text).toContain(knownPlaceholder(FAKE_PAT))
  })

  test("the on-disk catalog stays capped, keeps the newest hash, drops the oldest (finding)", async () => {
    // Seed the file AT the cap, restart so the plugin loads all of it, then
    // register ONE new secret. The merge slice keeps the file's tail (newest)
    // and drops its head (oldest): a `.slice(0, LIMIT)` mutant keeps the seed
    // and drops the new entry — restart recovery silently dead for every
    // future secret — and an in-memory newest-first eviction never lets the new
    // hash reach the file. FINGERPRINT_LIMIT appears in no other test.
    const LIMIT = 2048
    const setup = await makePlugin()
    const catalogPath = path.join(
      setup.root,
      "data",
      "opencode",
      "redact-secrets.fingerprints.json",
    )
    // 2048 valid synthetic entries; insertion order 0..2047, so 0 is the oldest.
    const seed = Array.from({ length: LIMIT }, (_, i) => ({
      hash: i.toString(16).padStart(16, "0"),
      ruleId: "github-pat",
      length: 40,
    }))
    const oldestHash = seed[0]?.hash
    await fs.writeFile(
      catalogPath,
      JSON.stringify({ version: 1, entries: seed }),
    )

    const hooks = await setup.boot()
    const newHash = secretHash(FAKE_PAT, PLUGIN_KEY)
    const part = { type: "text", text: `token = ${FAKE_PAT}` }
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [{ info: {}, parts: [part] }],
    } as never)

    // The file already exists (the seed), so poll until the debounced rewrite
    // lands the new hash rather than for the file's first appearance.
    let entries: Array<{ hash: string }> = []
    for (let i = 0; i < 40; i++) {
      const parsed = JSON.parse(await fs.readFile(catalogPath, "utf8")) as {
        entries: Array<{ hash: string }>
      }
      entries = parsed.entries
      if (entries.some((e) => e.hash === newHash)) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const hashes = entries.map((e) => e.hash)
    expect(entries.length).toBe(LIMIT)
    expect(hashes).toContain(newHash)
    expect(hashes).not.toContain(oldestHash)
  })

  test("a fingerprint write failure warns once and recovers when the fs does (finding)", async () => {
    if (process.getuid?.() === 0) return // chmod is a no-op under root
    const setup = await makePlugin()
    const dataDir = path.join(setup.root, "data", "opencode")
    const catalogPath = path.join(dataDir, "redact-secrets.fingerprints.json")
    const redact = async (secret: string): Promise<string> => {
      const part = { type: "text", text: `token = ${secret}` }
      await setup.hooks["experimental.chat.messages.transform"]?.({}, {
        messages: [{ info: {}, parts: [part] }],
      } as never)
      return part.text
    }
    await fs.chmod(dataDir, 0o500)
    // Confirm the chmod actually blocks writes (a root sandbox ignores it).
    let blocked = false
    try {
      await fs.writeFile(path.join(dataDir, ".probe"), "x")
      await fs.rm(path.join(dataDir, ".probe"))
    } catch {
      blocked = true
    }
    if (!blocked) {
      await fs.chmod(dataDir, 0o700)
      return
    }
    try {
      // Two registrations spaced past the 250ms debounce -> two failed writes.
      await redact(FAKE_PAT)
      await new Promise((resolve) => setTimeout(resolve, 400))
      const second = await redact("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")
      await new Promise((resolve) => setTimeout(resolve, 400))
      // (2) redaction never stopped despite the write failures.
      expect(second).toContain("[REDACTED-SECRET:github-pat:")
      // (1) warn-once: exactly one persist-failure warning across two failures.
      const warns = setup.logs.filter(
        (entry) =>
          entry.level === "warn" &&
          entry.message.includes("could not persist secret fingerprints"),
      )
      expect(warns.length).toBe(1)
      // (3) once the fs recovers, a fresh registration DOES land the catalog —
      // proving the earlier rejection did not permanently poison the write chain.
      await fs.chmod(dataDir, 0o700)
      await redact("ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3h2")
      let appeared = false
      for (let i = 0; i < 40; i++) {
        try {
          await fs.access(catalogPath)
          appeared = true
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      expect(appeared).toBe(true)
    } finally {
      await fs.chmod(dataDir, 0o700)
    }
  })
})

describe("inbound restoration hooks", () => {
  async function redactedFixture(
    setup: Setup,
  ): Promise<{ placeholder: string }> {
    const part = { type: "text", text: `token = ${FAKE_PAT}` }
    await setup.hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [{ info: {}, parts: [part] }],
    } as never)
    const match = new RegExp(PLACEHOLDER_RE.source).exec(part.text)
    if (!match) throw new Error("fixture did not redact")
    return { placeholder: match[0] }
  }

  test("text.complete restores placeholders the model echoed", async () => {
    const setup = await makePlugin()
    const { placeholder } = await redactedFixture(setup)
    const output = { text: `your token is ${placeholder}, keep it safe` }
    await setup.hooks["experimental.text.complete"]?.(
      { sessionID: "ses", messageID: "msg", partID: "prt" } as never,
      output as never,
    )
    expect(output.text).toBe(`your token is ${FAKE_PAT}, keep it safe`)
  })

  test("restoreText: false leaves the placeholder in the response", async () => {
    const setup = await makePlugin({ optionsFile: { restoreText: false } })
    const { placeholder } = await redactedFixture(setup)
    const output = { text: `use ${placeholder}` }
    await setup.hooks["experimental.text.complete"]?.(
      { sessionID: "ses", messageID: "msg", partID: "prt" } as never,
      output as never,
    )
    expect(output.text).toBe(`use ${placeholder}`)
  })

  test("restoreText: false warns at startup about narrowed restart recovery", async () => {
    // The opt-out silently applies to compaction summaries too (they stream
    // through the same completion hook), which downgrades post-restart
    // recovery to fingerprint recovery alone — a trade-off the user must be
    // able to see without reading source.
    const { logs } = await makePlugin({ optionsFile: { restoreText: false } })
    const warning = logs.find((entry) => entry.extra?.restoreText === false)
    expect(warning?.level).toBe("warn")
    expect(warning?.message).toContain("compaction")
    // The default emits no such warning.
    const on = await makePlugin()
    expect(on.logs.some((entry) => entry.extra?.restoreText === false)).toBe(
      false,
    )
  })

  test("compacting hook asks the summarizer to carry placeholders forward", async () => {
    const { hooks } = await makePlugin()
    const output = { context: [] as string[], prompt: undefined }
    await hooks["experimental.session.compacting"]?.(
      { sessionID: "ses" } as never,
      output as never,
    )
    expect(output.context).toEqual([COMPACTION_NOTE])
    expect(output.prompt).toBeUndefined()
  })

  test("an unknown placeholder is recovered by fingerprint from a project env file", async () => {
    // Simulates compaction + restart: the vault never saw the secret, but the
    // .env it originally leaked from still holds it. The placeholder's
    // sha256-derived hash lets the rescan verify the match.
    const setup = await makePlugin()
    await fs.writeFile(
      path.join(setup.root, ".env"),
      `GITHUB_TOKEN=${FAKE_PAT}\n`,
    )
    const args = { command: `deploy --token ${knownPlaceholder(FAKE_PAT)}` }
    await setup.hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses", callID: "call" } as never,
      { args } as never,
    )
    expect(args.command).toBe(`deploy --token ${FAKE_PAT}`)
  })

  test("an oversized env file is skipped by recovery rather than read whole into memory", async () => {
    // Recovery stats the file first and skips anything past the cap, so a
    // secret that lives only in a huge .env is not recovered — the placeholder
    // passes through verbatim instead of the process reading megabytes to
    // measure them. (The 1 MiB cap is MAX_RECOVERY_FILE_BYTES.)
    const setup = await makePlugin()
    const huge = `GITHUB_TOKEN=${FAKE_PAT}\n${"# pad\n".repeat(200_000)}`
    await fs.writeFile(path.join(setup.root, ".env"), huge)
    const args = { command: `deploy --token ${knownPlaceholder(FAKE_PAT)}` }
    await setup.hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses", callID: "call" } as never,
      { args } as never,
    )
    expect(args.command).toBe(`deploy --token ${knownPlaceholder(FAKE_PAT)}`)
  })

  test("an unknown placeholder is recovered by fingerprint from the shell environment", async () => {
    const altSecret = "ghp_Q9pL4vN8rT3wY6bJ1hF5dS0aZcE2gUqx7K2m"
    process.env.REDACT_SECRETS_TEST_TOKEN = altSecret
    try {
      const setup = await makePlugin()
      const output = { text: `the token is ${knownPlaceholder(altSecret)}` }
      await setup.hooks["experimental.text.complete"]?.(
        { sessionID: "ses", messageID: "msg", partID: "prt" } as never,
        output as never,
      )
      expect(output.text).toBe(`the token is ${altSecret}`)
    } finally {
      delete process.env.REDACT_SECRETS_TEST_TOKEN
    }
  })

  test("an unrecoverable placeholder passes through verbatim, without throwing", async () => {
    const setup = await makePlugin()
    const orphan = "[REDACTED-SECRET:github-pat:0123abcd0123abcd]"
    const args = { command: `deploy --token ${orphan}` }
    await setup.hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses", callID: "call" } as never,
      { args } as never,
    )
    expect(args.command).toBe(`deploy --token ${orphan}`)
  })

  test("tool.execute.before restores placeholders inside args in place", async () => {
    const setup = await makePlugin()
    const { placeholder } = await redactedFixture(setup)
    const args = {
      command: `deploy --token ${placeholder}`,
      env: { TOKEN: placeholder },
    }
    await setup.hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses", callID: "call" } as never,
      { args } as never,
    )
    expect(args.command).toBe(`deploy --token ${FAKE_PAT}`)
    expect(args.env.TOKEN).toBe(FAKE_PAT)
  })
})

describe("agent descriptions via the config hook", () => {
  test("a secret in an agent description is redacted in the shared config object", async () => {
    // The host appends agent names/descriptions to the Task tool AFTER the
    // tool.definition hook fires (registry.ts:313 vs :320-326), so the only
    // universal cover is redacting the source config the agent registry
    // builds from.
    const { hooks } = await makePlugin()
    const config = {
      agent: {
        reviewer: {
          description: `posts comments using ${FAKE_PAT} for auth`,
          prompt: "review carefully",
        },
        clean: { description: "no secrets here" },
        bare: {},
      },
    }
    await hooks.config?.(config as never)
    expect(config.agent.reviewer.description).not.toContain(FAKE_PAT)
    expect(config.agent.reviewer.description).toContain(
      "[REDACTED-SECRET:github-pat:",
    )
    // Prompts are covered by chat.system.transform at request time; names are
    // invocation identifiers — neither is rewritten here.
    expect(config.agent.reviewer.prompt).toBe("review carefully")
    expect(config.agent.clean.description).toBe("no secrets here")
  })

  test("an agent's NAME is detection context for its description (finding)", async () => {
    // The host assembles "- <name>: <description>" lines, so on the wire the
    // name sits adjacent to the description. A keyword-gated rule the bare
    // description never fires must fire under the name — while the name
    // itself, an invocation identifier, survives verbatim.
    const generic = "x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce"
    const fbToken = "123456789012345|a1b2c3d4e5f6g7h8i9j0k1l2m3n"
    const { hooks } = await makePlugin()
    const config = {
      agent: {
        // Adjacency: the reconstructed "api-key-minter=<value>" line is what
        // generic-api-key needs; the bare value alone carries no signal.
        "api-key-minter": { description: generic },
        // Gate-only: "facebook" in THIS agent's name must gate the rule for a
        // SIBLING agent's description (all lines share one Task description).
        "facebook-poster": { description: "posts to the graph api" },
        publisher: { description: `access = ${fbToken}\n` },
      },
    }
    await hooks.config?.(config as never)
    expect(config.agent["api-key-minter"].description).not.toContain(generic)
    expect(config.agent["api-key-minter"].description).toContain(
      "[REDACTED-SECRET:generic-api-key:",
    )
    expect(config.agent.publisher.description).not.toContain(fbToken)
    expect(config.agent["facebook-poster"].description).toBe(
      "posts to the graph api",
    )
    expect(Object.keys(config.agent)).toEqual([
      "api-key-minter",
      "facebook-poster",
      "publisher",
    ])
  })

  test("agent descriptions are redacted even with the wire backstop disabled", async () => {
    const { hooks } = await makePlugin({ optionsFile: { wireBackstop: false } })
    const config = {
      agent: { deployer: { description: `token: ${FAKE_PAT}` } },
      provider: { anthropic: { options: {} as Record<string, unknown> } },
    }
    await hooks.config?.(config as never)
    expect(config.agent.deployer.description).not.toContain(FAKE_PAT)
    // The gate still short-circuits the backstop half.
    expect(config.provider.anthropic.options.fetch).toBeUndefined()
  })
})

describe("wire backstop via the config hook", () => {
  type ProviderEntry = { options?: Record<string, unknown> }
  type FakeConfig = {
    provider?: Record<string, ProviderEntry>
    disabled_providers?: string[]
    enabled_providers?: string[]
  }

  test("wraps configured providers but never oauth or fetch-owning ones", async () => {
    const { hooks } = await makePlugin({
      authJson: JSON.stringify({
        openai: { type: "oauth", refresh: "r", access: "a", expires: 0 },
      }),
    })
    const config: FakeConfig = {
      provider: {
        anthropic: { options: {} },
        openai: { options: {} },
        "github-copilot": {},
        "google-vertex": { options: { project: "p" } },
        "snowflake-cortex": { options: { account: "a", token: "t" } },
      },
    }
    await hooks.config?.(config as never)
    expect(typeof config.provider?.anthropic?.options?.fetch).toBe("function")
    expect(config.provider?.openai?.options?.fetch).toBeUndefined()
    // The host installs its own fetch for these at assembly time, AFTER this
    // hook — wrapping would clobber their auth or request shaping.
    expect(config.provider?.["github-copilot"]?.options?.fetch).toBeUndefined()
    expect(config.provider?.["google-vertex"]?.options?.fetch).toBeUndefined()
    expect(
      config.provider?.["snowflake-cortex"]?.options?.fetch,
    ).toBeUndefined()
  })

  test("an env-key-loaded catalog provider gets a wrapped entry injected", async () => {
    process.env.REDACT_TEST_PROVIDER_KEY = "sk-test"
    try {
      const { hooks } = await makePlugin({
        catalog: {
          testprov: {
            id: "testprov",
            name: "Test",
            env: ["REDACT_TEST_PROVIDER_KEY"],
            models: {},
          },
        },
      })
      // No provider block at all — the host would still activate testprov
      // from its env key, and its title-generation requests must be covered.
      const config: FakeConfig = {}
      await hooks.config?.(config as never)
      expect(typeof config.provider?.testprov?.options?.fetch).toBe("function")
    } finally {
      delete process.env.REDACT_TEST_PROVIDER_KEY
    }
  })

  test("an api-key auth entry injects a wrapped entry for catalog providers only", async () => {
    const { hooks } = await makePlugin({
      authJson: JSON.stringify({
        testprov: { type: "api", key: "sk-x" },
        "my-local-proxy": { type: "api", key: "sk-y" },
      }),
      catalog: {
        testprov: {
          id: "testprov",
          name: "Test",
          env: ["REDACT_TEST_UNSET"],
          models: {},
        },
      },
    })
    const config: FakeConfig = {}
    await hooks.config?.(config as never)
    expect(typeof config.provider?.testprov?.options?.fetch).toBe("function")
    // A non-catalog auth entry never activates on the host; injecting an
    // entry for it would conjure a phantom provider.
    expect(config.provider?.["my-local-proxy"]).toBeUndefined()
  })

  test("injected coverage respects the unsafe set, skip options, and disabled_providers", async () => {
    process.env.REDACT_TEST_PROVIDER_KEY = "sk-test"
    process.env.REDACT_TEST_VERTEX_KEY = "sk-vertex"
    try {
      const catalog = {
        testprov: {
          id: "testprov",
          name: "Test",
          env: ["REDACT_TEST_PROVIDER_KEY"],
          models: {},
        },
        "google-vertex": {
          id: "google-vertex",
          name: "Vertex",
          env: ["REDACT_TEST_VERTEX_KEY"],
          models: {},
        },
        oauthprov: {
          id: "oauthprov",
          name: "OAuth",
          env: ["REDACT_TEST_UNSET"],
          models: {},
        },
      }
      const skipped = await makePlugin({
        catalog,
        optionsFile: { wireSkipProviders: ["testprov"] },
        authJson: JSON.stringify({
          oauthprov: { type: "oauth", refresh: "r", access: "a", expires: 0 },
        }),
      })
      const configA: FakeConfig = {}
      await skipped.hooks.config?.(configA as never)
      expect(configA.provider?.testprov).toBeUndefined()
      expect(configA.provider?.["google-vertex"]).toBeUndefined()
      expect(configA.provider?.oauthprov).toBeUndefined()

      const disabled = await makePlugin({ catalog })
      const configB: FakeConfig = { disabled_providers: ["testprov"] }
      await disabled.hooks.config?.(configB as never)
      expect(configB.provider?.testprov).toBeUndefined()
    } finally {
      delete process.env.REDACT_TEST_PROVIDER_KEY
      delete process.env.REDACT_TEST_VERTEX_KEY
    }
  })

  test("no readable catalog snapshot means no injected entries, but configured ones still wrap", async () => {
    process.env.REDACT_TEST_PROVIDER_KEY = "sk-test"
    try {
      const { hooks } = await makePlugin() // no catalog fixture planted
      const config: FakeConfig = { provider: { anthropic: {} } }
      await hooks.config?.(config as never)
      expect(typeof config.provider?.anthropic?.options?.fetch).toBe("function")
      expect(Object.keys(config.provider ?? {})).toEqual(["anthropic"])
    } finally {
      delete process.env.REDACT_TEST_PROVIDER_KEY
    }
  })

  test("openai loaded from its env key is left alone while the websocket rollout is live", async () => {
    process.env.OPENCODE_EXPERIMENTAL_WEBSOCKETS = "1"
    process.env.REDACT_TEST_OPENAI_KEY = "sk-test"
    try {
      const { hooks } = await makePlugin({
        authJson: JSON.stringify({ openai: { type: "api", key: "sk-x" } }),
        catalog: {
          openai: {
            id: "openai",
            name: "OpenAI",
            env: ["REDACT_TEST_OPENAI_KEY"],
            models: {},
          },
        },
      })
      const config: FakeConfig = {}
      await hooks.config?.(config as never)
      expect(config.provider?.openai).toBeUndefined()
    } finally {
      delete process.env.OPENCODE_EXPERIMENTAL_WEBSOCKETS
      delete process.env.REDACT_TEST_OPENAI_KEY
    }
  })

  test("a missing or corrupt auth.json falls back to an empty store, so wrapping still proceeds", async () => {
    // The host reads auth.json as an empty store on ANY failure — missing OR
    // unparseable (readJson(file).orElseSucceed(() => ({}))). An empty store
    // means no auth-plugin loader installed a provider fetch, so wrapping is
    // safe; disabling the whole backstop instead would leave every provider's
    // side channels (title generation) unredacted for no gain.
    const missing = await makePlugin({ omitAuthFile: true })
    const configA: FakeConfig = { provider: { anthropic: {} } }
    await missing.hooks.config?.(configA as never)
    expect(typeof configA.provider?.anthropic?.options?.fetch).toBe("function")

    const corrupt = await makePlugin({ authJson: "{not json" })
    const configB: FakeConfig = { provider: { anthropic: {} } }
    await corrupt.hooks.config?.(configB as never)
    expect(typeof configB.provider?.anthropic?.options?.fetch).toBe("function")
  })

  test("a malformed oauth entry no longer excludes an api-key-served provider (finding 3)", async () => {
    // The reviewer's leak: a stale {type:"oauth"} entry with no tokens. OpenCode
    // schema-validates auth.json and DROPS it, so openai is not an oauth provider
    // to the host — it is served through OPENAI_API_KEY as a plain api-key
    // provider with no custom fetch, and its title-generation traffic must be
    // wrapped. The plugin must read the entry the same way and wrap openai.
    const malformed = await makePlugin({
      authJson: JSON.stringify({ openai: { type: "oauth" } }),
    })
    const configA: FakeConfig = { provider: { openai: {} } }
    await malformed.hooks.config?.(configA as never)
    expect(typeof configA.provider?.openai?.options?.fetch).toBe("function")

    // A well-formed oauth entry still excludes it — the host installs a fetch.
    const valid = await makePlugin({
      authJson: JSON.stringify({
        openai: { type: "oauth", refresh: "r", access: "a", expires: 0 },
      }),
    })
    const configB: FakeConfig = { provider: { openai: {} } }
    await valid.hooks.config?.(configB as never)
    expect(configB.provider?.openai?.options?.fetch).toBeUndefined()
  })

  test("inline OPENCODE_AUTH_CONTENT is honored over auth.json, like the host", async () => {
    // Note the entry is a BARE {type:"oauth"} that the auth.json schema would
    // reject — but the host does not validate inline content (it returns the raw
    // parse, auth/index.ts:59-63), so neither does the plugin: the raw type is
    // enough to exclude openai here, unlike on the validated file path.
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: { type: "oauth", access: "x" },
    })
    try {
      // Control-plane workspaces get auth ONLY through the environment.
      const inlineOnly = await makePlugin({ omitAuthFile: true })
      const configA: FakeConfig = { provider: { openai: {}, anthropic: {} } }
      await inlineOnly.hooks.config?.(configA as never)
      expect(configA.provider?.openai?.options?.fetch).toBeUndefined()
      expect(typeof configA.provider?.anthropic?.options?.fetch).toBe(
        "function",
      )

      // When both exist, the inline copy wins wholesale — no merging.
      const both = await makePlugin({
        authJson: JSON.stringify({ openai: { type: "api", key: "sk-x" } }),
      })
      const configB: FakeConfig = { provider: { openai: {} } }
      await both.hooks.config?.(configB as never)
      expect(configB.provider?.openai?.options?.fetch).toBeUndefined()
    } finally {
      delete process.env.OPENCODE_AUTH_CONTENT
    }
  })

  test("unparseable inline auth falls through to auth.json, like the host", async () => {
    process.env.OPENCODE_AUTH_CONTENT = "{not json"
    try {
      const { hooks } = await makePlugin({
        authJson: JSON.stringify({
          openai: { type: "oauth", refresh: "r", access: "a", expires: 0 },
        }),
      })
      const config: FakeConfig = { provider: { openai: {}, anthropic: {} } }
      await hooks.config?.(config as never)
      expect(config.provider?.openai?.options?.fetch).toBeUndefined()
      expect(typeof config.provider?.anthropic?.options?.fetch).toBe("function")
    } finally {
      delete process.env.OPENCODE_AUTH_CONTENT
    }
  })

  test("openai is left alone when the websocket rollout flag is live and any auth entry exists", async () => {
    process.env.OPENCODE_EXPERIMENTAL_WEBSOCKETS = "1"
    try {
      // Api-key auth still gets a loader-installed websocket fetch on the
      // host, so the wrapper must stand down …
      const withAuth = await makePlugin({
        authJson: JSON.stringify({ openai: { type: "api", key: "sk-x" } }),
      })
      const configA: FakeConfig = {
        provider: { openai: { options: {} }, anthropic: {} },
      }
      await withAuth.hooks.config?.(configA as never)
      expect(configA.provider?.openai?.options?.fetch).toBeUndefined()
      expect(typeof configA.provider?.anthropic?.options?.fetch).toBe(
        "function",
      )

      // … but without an auth entry the loader never runs, so wrapping is safe.
      const noAuth = await makePlugin()
      const configB: FakeConfig = { provider: { openai: { options: {} } } }
      await noAuth.hooks.config?.(configB as never)
      expect(typeof configB.provider?.openai?.options?.fetch).toBe("function")
    } finally {
      delete process.env.OPENCODE_EXPERIMENTAL_WEBSOCKETS
    }
  })

  test("openai with api-key auth is wrapped when the websocket flag is off", async () => {
    const { hooks } = await makePlugin({
      authJson: JSON.stringify({ openai: { type: "api", key: "sk-x" } }),
    })
    const config: FakeConfig = { provider: { openai: { options: {} } } }
    await hooks.config?.(config as never)
    expect(typeof config.provider?.openai?.options?.fetch).toBe("function")
  })

  test("wireBackstop: false leaves every provider untouched", async () => {
    const { hooks } = await makePlugin({ optionsFile: { wireBackstop: false } })
    const config: FakeConfig = { provider: { anthropic: {} } }
    await hooks.config?.(config as never)
    expect(config.provider?.anthropic?.options?.fetch).toBeUndefined()
  })

  test("the wrapped fetch redacts JSON bodies and drops stale content-length", async () => {
    const { hooks } = await makePlugin()
    const seen: Array<{ body: unknown; headers: unknown }> = []
    const inner = async (_input: unknown, init?: RequestInit) => {
      seen.push({ body: init?.body, headers: init?.headers })
      return new Response("{}")
    }
    const config: FakeConfig = {
      provider: { anthropic: { options: { fetch: inner } } },
    }
    await hooks.config?.(config as never)
    const wrapped = config.provider?.anthropic?.options?.fetch as typeof fetch

    const body = JSON.stringify({
      messages: [{ role: "user", content: `key: ${FAKE_PAT}` }],
    })
    await wrapped("https://api.anthropic.example/v1/messages", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
      },
    })
    const call = seen[0]
    if (!call) throw new Error("inner fetch never called")
    expect(String(call.body)).not.toContain(FAKE_PAT)
    expect(String(call.body)).toContain("[REDACTED-SECRET:github-pat:")
    expect(Object.keys(call.headers as Record<string, string>)).not.toContain(
      "content-length",
    )

    // Non-JSON and secret-free bodies pass through byte-identical.
    await wrapped("https://api.anthropic.example/v1/messages", {
      method: "POST",
      body: "raw-bytes",
    })
    expect(seen[1]?.body).toBe("raw-bytes")
  })

  test("the wrapped fetch inspects byte-backed bodies and leaves the caller's headers whole", async () => {
    // Audit L-RS3 (bytes bypassed the string-only check) and L-RS4 (the
    // caller's nested headers were mutated), exercised through the real
    // wrapper rather than the helper.
    const { hooks } = await makePlugin()
    const seen: Array<{ body: unknown; headers: unknown }> = []
    const inner = async (_input: unknown, init?: RequestInit) => {
      seen.push({ body: init?.body, headers: init?.headers })
      return new Response("{}")
    }
    const config: FakeConfig = {
      provider: { anthropic: { options: { fetch: inner } } },
    }
    await hooks.config?.(config as never)
    const wrapped = config.provider?.anthropic?.options?.fetch as typeof fetch

    const body = JSON.stringify({
      messages: [{ role: "user", content: `key: ${FAKE_PAT}` }],
    })
    const callerHeaders = {
      "content-type": "application/json",
      "content-length": String(body.length),
    }
    await wrapped("https://api.anthropic.example/v1/messages", {
      method: "POST",
      body: new TextEncoder().encode(body),
      headers: callerHeaders,
    })
    const call = seen[0]
    if (!call) throw new Error("inner fetch never called")
    const sent = new TextDecoder().decode(call.body as Uint8Array)
    expect(sent).not.toContain(FAKE_PAT)
    expect(sent).toContain("[REDACTED-SECRET:github-pat:")
    expect(Object.keys(call.headers as Record<string, string>)).not.toContain(
      "content-length",
    )
    // The caller's own headers object keeps its Content-Length (audit L-RS4).
    expect(callerHeaders["content-length"]).toBe(String(body.length))
  })

  test("the native LLM runtime flag triggers a startup warning that the backstop is bypassed", async () => {
    process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM = "true"
    try {
      const { logs } = await makePlugin()
      const warning = logs.find((entry) => entry.extra?.nativeLlm === true)
      expect(warning?.level).toBe("warn")
      expect(warning?.message).toContain("OPENCODE_EXPERIMENTAL_NATIVE_LLM")
      expect(warning?.message).toContain("title generation")
    } finally {
      delete process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM
    }
  })

  test("no native warning when the flag is unset or the backstop is disabled", async () => {
    const off = await makePlugin()
    expect(off.logs.some((entry) => entry.extra?.nativeLlm === true)).toBe(
      false,
    )

    // Flag on but the backstop already disabled: the gap it warns about does
    // not apply, so no warning.
    process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM = "1"
    try {
      const disabled = await makePlugin({
        optionsFile: { wireBackstop: false },
      })
      expect(
        disabled.logs.some((entry) => entry.extra?.nativeLlm === true),
      ).toBe(false)
    } finally {
      delete process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM
    }
  })

  test("a non-enabling native flag value ('false') raises no warning", async () => {
    process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM = "false"
    try {
      const { logs } = await makePlugin()
      expect(logs.some((entry) => entry.extra?.nativeLlm === true)).toBe(false)
    } finally {
      delete process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM
    }
  })
})

describe("malformed configuration", () => {
  test("a malformed redact-secrets.json still boots with redaction active (finding)", async () => {
    // A truncated config file: JSON.parse throws, the plugin logs a warning and
    // falls back to full DEFAULTS — but it must still BOOT with redaction on.
    // Removing the try/catch at index.ts:226 makes the parse failure reject the
    // plugin factory (zero hooks loaded, redaction entirely off); that mutant is
    // killed by makePlugin resolving at all plus the assertions below. The
    // harness JSON.stringifies optionsFile, so only optionsFileRaw can plant a
    // file the parser actually chokes on.
    const { hooks, logs } = await makePlugin({
      optionsFileRaw: '{"systemNote": false,',
    })
    expect(
      logs.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message.includes("ignoring unparseable redact-secrets.json"),
      ),
    ).toBe(true)
    // Defaults are in force — systemNote defaults to true, NOT the truncated
    // false — so the system note is still appended.
    const sys = { system: ["base prompt"] }
    await hooks["experimental.chat.system.transform"]?.(
      { model: {} } as never,
      sys as never,
    )
    expect(sys.system).toContain(SYSTEM_NOTE)
    // And the wire backstop (default on) still wraps a configured provider.
    const config: {
      provider?: Record<string, { options?: { fetch?: unknown } }>
    } = { provider: { anthropic: {} } }
    await hooks.config?.(config as never)
    expect(typeof config.provider?.anthropic?.options?.fetch).toBe("function")
  })
})

describe("prompt-cache stability (HistoryPins)", () => {
  // A bare 32-char value: generic-api-key needs a field name beside it, so it
  // travels unredacted until some later turn supplies one. That is the exact
  // shape of the 2026-07-25 regression — a value already sent in cleartext
  // becomes redactable mid-session, and rewriting it in the replayed history
  // invalidates the provider's cached prefix from that byte on.
  const LATE = "x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce"
  const SESSION = "ses_stable"
  /** The model a message's own `info.model` names — the request's destination. */
  const MODEL = { providerID: "openai", modelID: "gpt-5.6" }
  /** The same destination in the shape the system hook is handed. */
  const SYSTEM_MODEL = { providerID: "openai", id: "gpt-5.6" }

  type TextPart = { id: string; type: string; text: string }
  const bare = (): TextPart => ({
    id: "prt_1",
    type: "text",
    text: `- ${LATE}`,
  })
  const named = (): TextPart => ({
    id: "prt_2",
    type: "text",
    text: `api_key = ${LATE}`,
  })
  const later = (): TextPart => ({
    id: "prt_3",
    type: "text",
    text: "carry on",
  })
  const message = (
    id: string,
    part: TextPart,
    sessionID = SESSION,
    model: unknown = MODEL,
  ) => ({
    info: { id, sessionID, role: "user", model },
    parts: [part],
  })

  /**
   * What the host publishes once a request has reached the provider and the
   * assistant starts producing. Pins stay invisible until this arrives, so
   * every request in a fixture has to be followed by it.
   */
  const deliver = async (hooks: Hooks, sessionID = SESSION): Promise<void> => {
    await hooks.event?.({
      event: {
        type: "message.part.updated",
        properties: { part: { type: "step-start", sessionID } },
      },
    } as never)
  }

  /** Drive the three requests the regression needs; return turn 1's replay. */
  async function replayHistory(hooks: Hooks) {
    const transform = hooks["experimental.chat.messages.transform"]
    // Request 1: the value is present but nothing names it — sent in the clear.
    const first = bare()
    await transform?.({}, { messages: [message("msg_1", first)] } as never)
    await deliver(hooks)
    // Request 2: a new turn names the field, so the value is vaulted here.
    await transform?.({}, {
      messages: [message("msg_1", bare()), message("msg_2", named())],
    } as never)
    await deliver(hooks)
    // Request 3: the same history replays, now against a vault that knows it.
    const replayed = bare()
    await transform?.({}, {
      messages: [
        message("msg_1", replayed),
        message("msg_2", named()),
        message("msg_3", later()),
      ],
    } as never)
    return { firstText: first.text, replayedText: replayed.text }
  }

  test("history already sent is replayed byte-identical, new content is not", async () => {
    const { hooks, root } = await makePlugin()
    const { firstText, replayedText } = await replayHistory(hooks)
    expect(firstText).toBe(`- ${LATE}`)
    // The pin holds: the prefix the provider cached is still the prefix it gets.
    expect(replayedText).toBe(`- ${LATE}`)
    // Classifier sources are a fresh disclosure, not a replay to this model.
    expect(
      redactSourceValue(
        { serverUrl: "http://localhost:1", directory: root },
        { text: replayedText },
      ).text,
    ).not.toContain(LATE)

    // ...and the turn that introduced the field name is still redacted, so the
    // pin buys stability without buying it from coverage.
    const fresh = named()
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [message("msg_9", fresh)],
    } as never)
    expect(fresh.text).not.toContain(LATE)
  })

  test("stableHistory:false restores the retroactive rewrite", async () => {
    const { hooks } = await makePlugin({
      optionsFile: { stableHistory: false },
    })
    const { replayedText } = await replayHistory(hooks)
    expect(replayedText).not.toContain(LATE)
    expect(replayedText).toMatch(new RegExp(PLACEHOLDER_RE.source))
  })

  test("a pin never crosses sessions", async () => {
    const { hooks } = await makePlugin()
    await replayHistory(hooks)
    // Byte-identical content in a DIFFERENT session gets the current rule set,
    // not the older session's decision.
    const other = bare()
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [message("msg_1", other, "ses_other")],
    } as never)
    expect(other.text).not.toContain(LATE)
  })

  test("a message the host gives no sessionID is left unpinned", async () => {
    const { hooks } = await makePlugin()
    const transform = hooks["experimental.chat.messages.transform"]
    const anon = (part: TextPart) => ({ info: { id: "msg_1" }, parts: [part] })
    await transform?.({}, { messages: [anon(bare())] } as never)
    await transform?.({}, {
      messages: [anon(bare()), { info: { id: "msg_2" }, parts: [named()] }],
    } as never)
    const replayed = bare()
    await transform?.({}, { messages: [anon(replayed)] } as never)
    expect(replayed.text).not.toContain(LATE)
  })

  test("the system prompt is pinned per session too", async () => {
    const { hooks } = await makePlugin()
    const transform = hooks["experimental.chat.system.transform"]
    const base = `agent instructions\n- ${LATE}`
    const first = { system: [base] }
    await transform?.(
      { sessionID: SESSION, model: SYSTEM_MODEL } as never,
      first as never,
    )
    expect(first.system[0]).toBe(base)
    await deliver(hooks)

    // Teach the vault the value through the message layer, then re-assemble
    // the same system prompt: its bytes must not move under the session.
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [message("msg_2", named())],
    } as never)
    const again = { system: [base] }
    await transform?.(
      { sessionID: SESSION, model: SYSTEM_MODEL } as never,
      again as never,
    )
    expect(again.system[0]).toBe(base)

    // A different session re-derives it under the current rule set.
    const elsewhere = { system: [base] }
    await transform?.(
      { sessionID: "ses_other", model: SYSTEM_MODEL } as never,
      elsewhere as never,
    )
    expect(elsewhere.system[0]).not.toContain(LATE)
  })

  test("a pin is not reused after the session switches model", async () => {
    // Pins carry an exposure decision whose whole justification is that the
    // bytes already went to THIS destination. A session that changes model
    // mid-conversation must not inherit it (audit F2).
    const { hooks } = await makePlugin()
    const transform = hooks["experimental.chat.messages.transform"]
    await transform?.({}, { messages: [message("msg_1", bare())] } as never)
    await deliver(hooks)
    await transform?.({}, {
      messages: [message("msg_1", bare()), message("msg_2", named())],
    } as never)
    await deliver(hooks)

    const elsewhere = bare()
    await transform?.({}, {
      messages: [
        message("msg_1", elsewhere, SESSION, {
          providerID: "anthropic",
          modelID: "claude-opus-5",
        }),
        message("msg_2", named(), SESSION, {
          providerID: "anthropic",
          modelID: "claude-opus-5",
        }),
      ],
    } as never)
    expect(elsewhere.text).not.toContain(LATE)
  })

  test("the system prompt pin is scoped by model too", async () => {
    const { hooks } = await makePlugin()
    const transform = hooks["experimental.chat.system.transform"]
    const base = `agent instructions\n- ${LATE}`
    await transform?.(
      { sessionID: SESSION, model: SYSTEM_MODEL } as never,
      { system: [base] } as never,
    )
    await deliver(hooks)
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [message("msg_2", named())],
    } as never)

    const switched = { system: [base] }
    await transform?.(
      {
        sessionID: SESSION,
        model: { providerID: "anthropic", id: "claude-opus-5" },
      } as never,
      switched as never,
    )
    expect(switched.system[0]).not.toContain(LATE)
  })

  test("compaction is never served from a pin", async () => {
    // Compaction can route this session's history to a separately configured
    // model, and its `messages.transform` call is indistinguishable from an
    // ordinary turn except for the hook that fires just before it.
    const { hooks } = await makePlugin()
    const transform = hooks["experimental.chat.messages.transform"]
    await transform?.({}, { messages: [message("msg_1", bare())] } as never)
    await deliver(hooks)
    await transform?.({}, {
      messages: [message("msg_1", bare()), message("msg_2", named())],
    } as never)
    await deliver(hooks)

    await hooks["experimental.session.compacting"]?.(
      { sessionID: SESSION } as never,
      { context: [] } as never,
    )
    const compacted = bare()
    await transform?.({}, {
      messages: [message("msg_1", compacted), message("msg_2", named())],
    } as never)
    expect(compacted.text).not.toContain(LATE)

    // ...and the flag is one-shot: the next ordinary turn pins again.
    const ordinary = bare()
    await transform?.({}, {
      messages: [message("msg_1", ordinary), message("msg_2", named())],
    } as never)
    expect(ordinary.text).toBe(`- ${LATE}`)
  })

  test("a pin from a request that never landed is not reused", async () => {
    // The transforms run before request construction and transport, so an
    // attempt that fails afterwards must not leave its decision behind — on
    // the retry a newly available detection has to win (audit F6).
    const { hooks } = await makePlugin()
    const transform = hooks["experimental.chat.messages.transform"]
    const first = bare()
    // Request 1 is prepared and then dies before sending: no delivery event.
    await transform?.({}, { messages: [message("msg_1", first)] } as never)
    // A later turn names the field, vaulting the value.
    await transform?.({}, {
      messages: [message("msg_1", bare()), message("msg_2", named())],
    } as never)
    const retried = bare()
    await transform?.({}, {
      messages: [message("msg_1", retried), message("msg_2", named())],
    } as never)
    expect(retried.text).not.toContain(LATE)
  })

  test("a deleted session releases its pins", async () => {
    const { hooks } = await makePlugin()
    await replayHistory(hooks)
    await hooks.event?.({
      event: { type: "session.deleted", properties: { info: { id: SESSION } } },
    } as never)
    const revived = bare()
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [message("msg_1", revived), message("msg_2", named())],
    } as never)
    expect(revived.text).not.toContain(LATE)
  })

  test("the wire backstop still re-redacts pinned history on its way out", async () => {
    // The scope boundary of stableHistory, asserted end to end rather than
    // inferred from the transform alone (audit F1).
    //
    // Pinning holds the TRANSFORM's decision. The wire backstop, on the
    // providers it wraps, then inspects the fully serialized request against
    // the current vault — and the vault sweep is exact-match and
    // context-free, so a value the pin deliberately replayed raw is replaced
    // there anyway. The prefix therefore still moves once, on the request
    // that learns the secret, for every wrapped provider.
    //
    // There is no linkage to close this with: the fetch wrapper sees a
    // provider-shaped body with no session identity, so it cannot tell
    // replayed history apart from new content. Exempting the value by
    // provider alone would let it out of a DIFFERENT session too, which is a
    // worse trade than the cache miss. Documented in the README rather than
    // papered over.
    const { hooks } = await makePlugin()
    const transform = hooks["experimental.chat.messages.transform"]
    await transform?.({}, { messages: [message("msg_1", bare())] } as never)
    await deliver(hooks)
    await transform?.({}, {
      messages: [message("msg_1", bare()), message("msg_2", named())],
    } as never)
    await deliver(hooks)

    const replayed = bare()
    await transform?.({}, {
      messages: [message("msg_1", replayed), message("msg_2", named())],
    } as never)
    // The transform layer holds the line...
    expect(replayed.text).toBe(`- ${LATE}`)

    const seen: string[] = []
    const inner = async (_input: unknown, init?: RequestInit) => {
      seen.push(String(init?.body))
      return new Response("{}")
    }
    const config = {
      provider: { anthropic: { options: { fetch: inner } } },
    }
    await hooks.config?.(config as never)
    const wrapped = config.provider.anthropic.options.fetch as typeof fetch
    await wrapped("https://api.anthropic.example/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: replayed.text }],
      }),
      headers: { "content-type": "application/json" },
    })
    // ...and the wire layer does not.
    expect(seen[0]).not.toContain(LATE)
    expect(seen[0]).toContain("[REDACTED-SECRET:")
  })
})

describe("provider protocol state in part.metadata", () => {
  // Real shapes from a gpt-5.6 session: the host stores these and hands them
  // straight back as providerOptions, so a rewritten byte corrupts the request.
  const CIPHERTEXT =
    "gAAAAABqZZb0B4bI2nx0GZG0Y9j61uhetYxd8elFYnbJebOPA5Vsgf79wZsgp_C-4-GbcYhH"
  const ITEM_ID = "rs_01bcac001ea0fa63016a6596efbf5c819aa7de5785645288af"

  const reasoningPart = () => ({
    id: "prt_r",
    type: "reasoning",
    text: "**Checking the token handling**",
    metadata: {
      openai: {
        itemId: ITEM_ID,
        reasoningEncryptedContent: CIPHERTEXT,
        phase: "commentary",
      },
    },
  })

  test("opaque provider payloads round-trip byte-exact even under a hostile vault", async () => {
    const { hooks } = await makePlugin()
    const transform = hooks["experimental.chat.messages.transform"]
    const part = reasoningPart()
    // Vault the ciphertext and the item id as if they were secrets — the
    // strongest form of the hazard, since exact-match sweeps are context-free
    // and would otherwise rewrite them wherever they appear.
    await transform?.({}, {
      messages: [
        {
          info: { id: "msg_1", sessionID: "ses_meta" },
          parts: [
            { id: "prt_1", type: "text", text: `api_key = ${CIPHERTEXT}` },
            { id: "prt_2", type: "text", text: `api_key = ${ITEM_ID}` },
          ],
        },
      ],
    } as never)

    await transform?.({}, {
      messages: [
        { info: { id: "msg_2", sessionID: "ses_meta" }, parts: [part] },
      ],
    } as never)

    expect(part.metadata.openai.reasoningEncryptedContent).toBe(CIPHERTEXT)
    expect(part.metadata.openai.itemId).toBe(ITEM_ID)
  })

  test("everything else in metadata is still redacted", async () => {
    const { hooks } = await makePlugin()
    const part = {
      id: "prt_r",
      type: "reasoning",
      text: "thinking",
      metadata: {
        openai: { itemId: ITEM_ID, phase: "commentary" },
        // A namespace this does not recognize, and a nested object: neither is
        // provider protocol state, so metadata must not become a blind spot.
        someplugin: { note: `token = ${FAKE_PAT}` },
        nested: { deeper: { pat: FAKE_PAT } },
      },
    }
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [
        { info: { id: "msg_1", sessionID: "ses_meta2" }, parts: [part] },
      ],
    } as never)

    expect(part.metadata.someplugin.note).not.toContain(FAKE_PAT)
    expect(part.metadata.nested.deeper.pat).not.toContain(FAKE_PAT)
    // The recognized namespace keeps its non-opaque fields scanned too.
    expect(part.metadata.openai.phase).toBe("commentary")
  })

  test("an opaque FIELD NAME is skipped under any namespace, by design", async () => {
    // The skip is keyed on the field name rather than on exact
    // <provider>.<field> pairs, so an unrecognized namespace's `signature` is
    // skipped too. Provider namespaces are an open set — a name this build has
    // never seen is far likelier to be a provider added since the OpenCode pin
    // than a plugin stashing a credential under a name meaning "ciphertext" —
    // and mangling live protocol state is the worse failure. Pinned here so
    // the trade is deliberate rather than incidental (audit F3).
    const { hooks } = await makePlugin()
    const part = {
      id: "prt_r",
      type: "reasoning",
      text: "thinking",
      metadata: {
        someplugin: { signature: `token = ${FAKE_PAT}`, note: FAKE_PAT },
      },
    }
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [
        { info: { id: "msg_1", sessionID: "ses_meta3" }, parts: [part] },
      ],
    } as never)

    expect(part.metadata.someplugin.signature).toBe(`token = ${FAKE_PAT}`)
    // The sibling under the same unrecognized namespace still walks normally.
    expect(part.metadata.someplugin.note).not.toContain(FAKE_PAT)
  })

  test("every provider's opaque continuation field round-trips", async () => {
    // Each of these is persisted into part.metadata by OpenCode 1.18.5 and
    // replayed as providerOptions: copilot's reasoningOpaque
    // (github-copilot/chat/convert-to-openai-compatible-chat-messages.ts:83)
    // and anthropic/bedrock's redactedData (provider/transform.ts:180-212).
    // Mangling one corrupts a live continuation request (audit F4).
    const { hooks } = await makePlugin()
    const transform = hooks["experimental.chat.messages.transform"]
    const OPAQUE = "Ck0YAyy2gZsgp_C4rEbcYhH0B4bI2nx0GZG0Y9j61uhetYxd8elFYnbJ"
    const part = {
      id: "prt_r",
      type: "reasoning",
      text: "thinking",
      metadata: {
        copilot: { reasoningOpaque: OPAQUE },
        anthropic: { redactedData: OPAQUE, signature: OPAQUE },
        bedrock: { redactedData: OPAQUE },
      },
    }
    // Vault the value first, so only the skip can keep it intact.
    await transform?.({}, {
      messages: [
        {
          info: { id: "msg_1", sessionID: "ses_meta4" },
          parts: [{ id: "prt_1", type: "text", text: `api_key = ${OPAQUE}` }],
        },
      ],
    } as never)
    await transform?.({}, {
      messages: [
        { info: { id: "msg_2", sessionID: "ses_meta4" }, parts: [part] },
      ],
    } as never)

    expect(part.metadata.copilot.reasoningOpaque).toBe(OPAQUE)
    expect(part.metadata.anthropic.redactedData).toBe(OPAQUE)
    expect(part.metadata.anthropic.signature).toBe(OPAQUE)
    expect(part.metadata.bedrock.redactedData).toBe(OPAQUE)
  })

  test("the same key names outside part.metadata are still scanned", async () => {
    const { hooks } = await makePlugin()
    // A tool output that happens to use these field names is ordinary content.
    const part = {
      id: "prt_t",
      type: "tool",
      tool: "bash",
      state: {
        status: "completed",
        output: JSON.stringify({ signature: FAKE_PAT, itemId: FAKE_PAT }),
      },
    }
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [
        { info: { id: "msg_1", sessionID: "ses_meta3" }, parts: [part] },
      ],
    } as never)
    expect(part.state.output).not.toContain(FAKE_PAT)
  })
})

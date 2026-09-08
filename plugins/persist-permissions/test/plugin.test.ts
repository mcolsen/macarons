import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  BAND_SAMPLE_VERSIONS as BAND,
  verifyFilesystemLocality,
} from "@macarons/permission-rules"
import { PersistPermissionsPlugin } from "../src/index"
import {
  automatedReplies,
  legacyPermissionStoreFile,
  permissionStoreFile,
} from "../src/shared"

type Hooks = Awaited<ReturnType<typeof PersistPermissionsPlugin>>

let sandboxRoot: string
let root: string
let configDir: string
let stateDir: string

beforeEach(async () => {
  // realpath: os.tmpdir() can sit behind a symlink (macOS /var → /private/var),
  // and the plugin hashes the canonical project root — expected store paths
  // computed from the raw root would name a different file.
  sandboxRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "persist-permissions-")),
  )
  root = path.join(sandboxRoot, "project")
  configDir = path.join(sandboxRoot, "config")
  stateDir = path.join(sandboxRoot, "state")
  await Promise.all([fs.mkdir(root), fs.mkdir(configDir), fs.mkdir(stateDir)])
  await fs.mkdir(path.dirname(storeFile()), { recursive: true })
})

afterEach(async () => {
  await fs.rm(sandboxRoot, { recursive: true, force: true })
})

// Mimics the generated SDK client: methods live on prototypes and read
// `this`, so a detached call throws synchronously exactly like the real one.
// `sessions` (id → session object) pins exact session rulesets; an id missing
// from a supplied map resolves { error }, like the real client for an unknown
// session. WITHOUT the map every session resolves as a plain session carrying
// no `permission` field — what the generated SDK's Session type actually
// describes, what a rule-less session looks like on every supported host, and
// what keeps sessionRulesOf's defensive absent-field branch covered. The
// default has to serve something now that a missing session.get fails closed:
// auto-approval cannot proceed without a readable session ruleset.
// `sessionApi: false` drops the surface entirely — only ever a degraded or
// future client, never a shape OpenCode serves.
function makeClient(
  version: unknown = BAND.floor,
  sessions?: Record<string, unknown>,
  { sessionApi = true }: { sessionApi?: boolean } = {},
) {
  const replies: any[] = []
  const logs: any[] = []
  const toasts: any[] = []
  const sessionGets: string[] = []
  class App {
    _client = {}
    log(input: any) {
      void this._client
      logs.push(input)
      return Promise.resolve({ data: true })
    }
  }
  class Tui {
    _client = {}
    showToast(input: any) {
      void this._client
      toasts.push(input)
      return Promise.resolve({ data: true })
    }
  }
  class Client {
    _client = {}
    app = new App()
    tui = new Tui()
    global = {
      health: () => Promise.resolve({ data: { healthy: true, version } }),
    }
    path = {
      get: () =>
        Promise.resolve({ data: { config: configDir, state: stateDir } }),
    }
    session = sessionApi
      ? {
          get: (options: any) => {
            sessionGets.push(options.path.id)
            const data = sessions
              ? sessions[options.path.id]
              : { id: options.path.id }
            return Promise.resolve(
              data === undefined
                ? { error: { name: "NotFoundError" } }
                : { data },
            )
          },
        }
      : undefined
    postSessionIdPermissionsPermissionId(options: any) {
      void this._client
      replies.push(options)
      return Promise.resolve({ data: true })
    }
  }
  return { client: new Client(), replies, logs, toasts, sessionGets }
}

async function load(
  client: unknown,
  worktree: string = root,
  serverUrl = new URL("http://localhost:4096"),
  options?: Record<string, unknown>,
): Promise<Hooks> {
  return PersistPermissionsPlugin(
    {
      client: client as any,
      directory: root,
      worktree,
      project: {} as any,
      serverUrl,
      experimental_workspace: { register() {} },
      $: {} as any,
    },
    options,
  )
}

describe("filesystem locality", () => {
  test("proves raw paths through a symlinked config ancestor", async () => {
    const dotfiles = path.join(sandboxRoot, "dotfiles")
    const configHome = path.join(sandboxRoot, "config-home")
    await fs.mkdir(path.join(dotfiles, "opencode"), { recursive: true })
    await fs.symlink(dotfiles, configHome, "dir")
    configDir = path.join(configHome, "opencode")
    const policyDir = path.dirname(storeFile())
    expect(await fs.exists(policyDir)).toBe(false)

    const { client } = makeClient()
    const hooks = await load(client)
    try {
      expect(
        await verifyFilesystemLocality(
          {
            client: {
              tui: {
                publish: async ({ body }: { body: any }) => {
                  await hooks.event!({ event: body })
                  return { data: true }
                },
              },
            },
          },
          {
            service: "persist-permissions",
            directory: root,
            // The TUI binds host-reported paths, not their realpath spelling.
            paths: [configDir, policyDir, root],
            timeoutMs: 2_000,
          },
        ),
      ).toBe(true)
      expect(await fs.realpath(configDir)).not.toBe(configDir)
      expect(await fs.realpath(policyDir)).not.toBe(policyDir)
      for (const dir of [configDir, policyDir, root])
        expect(
          (await fs.readdir(dir)).some((name) =>
            name.startsWith(".macarons-locality-"),
          ),
        ).toBe(false)
    } finally {
      await hooks.dispose?.()
    }
  })
})

describe("OpenCode runtime compatibility guard", () => {
  // A v1 host outside the verified band warns but keeps persisting — the real
  // permission hooks register, not the inert visibility-only shape.
  for (const version of [BAND.belowBand, BAND.aboveBand]) {
    test(`warns but runs on untested OpenCode ${version}`, async () => {
      const { client, logs } = makeClient(version)
      const hooks = await load(client)

      expect(typeof hooks["permission.ask"]).toBe("function")
      expect(logs).toHaveLength(1)
      expect(logs[0].body.level).toBe("warn")
      expect(logs[0].body.message).toContain(`found ${version}`)
      expect(logs[0].body.message).toContain("Running anyway")
    })
  }

  // A non-v1 host (OpenCode v2+, whose plugin API differs) disables the server
  // half — but visibly. The TUI companion keeps rendering from the store file,
  // so the disabled half announces itself with one warning toast at the first
  // prompt, and never persists a rule or replies.
  test("stays inert on OpenCode v2 — but visibly", async () => {
    const { client, logs, replies, toasts } = makeClient("2.0.0")
    const hooks = await load(client)

    expect(Object.keys(hooks)).toEqual(["event"])
    expect(logs).toHaveLength(1)
    expect(logs[0].body.level).toBe("warn")
    expect(logs[0].body.message).toContain("OpenCode 2.0.0")
    expect(logs[0].body.message).toContain("disabled")

    await hooks.event?.(asked())
    await hooks.event?.(asked({ id: "per_2" }))
    expect(replies).toHaveLength(0)
    const warnings = toasts.filter((toast) => toast.body.variant === "warning")
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0].body.message)).toContain("disabled")
  })

  test("reads the version through the SDK transport when global.health is missing (standalone TUI)", async () => {
    // A standalone `opencode` TUI never binds serverUrl, so the HTTP
    // fallback cannot ever reach /global/health there, and the injected v1 plugin
    // client has no global.health — the raw transport, which dispatches
    // in-process, is the only working version source.
    const fetch = spyOn(globalThis, "fetch")
    try {
      const { client, logs } = makeClient()
      ;(client as any).global = {}
      ;(client as any)._client = {
        get: (options: any) =>
          options?.url === "/global/health"
            ? Promise.resolve({ data: { healthy: true, version: BAND.floor } })
            : Promise.reject(
                new Error(`unexpected transport url ${options?.url}`),
              ),
      }
      const hooks = await load(client)

      expect(typeof hooks.event).toBe("function")
      expect(typeof hooks["permission.ask"]).toBe("function")
      expect(logs).toHaveLength(0)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
    }
  })

  test("registers both permission hooks at the supported floor", async () => {
    const { client, logs } = makeClient(BAND.floor)
    const hooks = await load(client)

    expect(typeof hooks.event).toBe("function")
    expect(typeof hooks["permission.ask"]).toBe("function")
    expect(logs).toHaveLength(0)
  })

  test("legacy clients read the version from serverUrl /global/health", async () => {
    const paths: string[] = []
    const healthFetch = (async (input: string | URL | Request) => {
      paths.push(new URL(String(input)).pathname)
      return Response.json({ healthy: true, version: BAND.floor })
    }) as unknown as typeof globalThis.fetch
    const fetch = spyOn(globalThis, "fetch").mockImplementation(healthFetch)
    try {
      const { client } = makeClient()
      const legacyClient = client as unknown as { global?: unknown }
      legacyClient.global = undefined
      const hooks = await load(client)

      expect(typeof hooks.event).toBe("function")
      expect(paths).toEqual(["/global/health"])
    } finally {
      fetch.mockRestore()
    }
  })

  test("an unknown version warns but still initializes fully (fail open)", async () => {
    const { client, logs } = makeClient(null)
    // A non-hierarchical URL makes the HTTP fallback fail immediately, so the
    // test covers a genuinely unavailable version source without networking.
    const hooks = await load(client, root, new URL("data:,"))

    // Failing open: an unreadable version is almost always still v1, so the
    // real permission hooks register — only a warning marks the uncertainty.
    expect(typeof hooks["permission.ask"]).toBe("function")
    expect(logs).toHaveLength(1)
    expect(logs[0].body.level).toBe("warn")
    expect(logs[0].body.message).toContain("could not determine")
    expect(logs[0].body.message).toContain("Running anyway")
  })
})

const storeFile = () => permissionStoreFile(configDir, root)
const legacyStoreFile = () => legacyPermissionStoreFile(root)

async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8"))
}

function asked(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    event: {
      type: "permission.asked",
      properties: {
        id: "per_1",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["git status"],
        always: ["git status *"],
        metadata: {},
        ...overrides,
      },
    },
  } as any
}

function replied(reply: string, id = "per_1") {
  return {
    event: {
      type: "permission.replied",
      properties: { sessionID: "ses_1", requestID: id, reply },
    },
  } as any
}

describe("persisting user approvals", () => {
  test("an 'always' reply saves the request's always-patterns", async () => {
    const { client } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked())
    await hooks.event!(replied("always"))

    const store = await readJson(storeFile())
    expect(store).toEqual({ permission: { bash: { "git status *": "allow" } } })
  })

  test("writes owner-only modes without widening stricter stores under umask 022", async () => {
    if (process.platform === "win32") return
    const parent = path.dirname(storeFile())
    await fs.rm(parent, { recursive: true, force: true })
    const previous = process.umask(0o022)
    try {
      const { client } = makeClient()
      const hooks = await load(client)

      await hooks.event!(asked())
      await hooks.event!(replied("always"))
      expect((await fs.stat(storeFile())).mode & 0o777).toBe(0o600)
      expect((await fs.stat(parent)).mode & 0o777).toBe(0o700)

      await fs.chmod(storeFile(), 0o644)
      await fs.chmod(parent, 0o755)
      await hooks.event!(
        asked({
          id: "per_2",
          patterns: ["git diff"],
          always: ["git diff *"],
        }),
      )
      await hooks.event!(replied("always", "per_2"))
      expect((await fs.stat(storeFile())).mode & 0o777).toBe(0o600)
      expect((await fs.stat(parent)).mode & 0o777).toBe(0o700)

      await fs.chmod(storeFile(), 0o400)
      await hooks.event!(
        asked({
          id: "per_3",
          patterns: ["git log"],
          always: ["git log *"],
        }),
      )
      await hooks.event!(replied("always", "per_3"))
      expect((await fs.stat(storeFile())).mode & 0o777).toBe(0o400)
    } finally {
      process.umask(previous)
    }
  })

  test("the store is outside the agent-writable project", async () => {
    const { client } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked())
    await hooks.event!(replied("always"))

    expect(path.relative(root, storeFile()).startsWith("..")).toBe(true)
    expect(await readJson(storeFile())).toEqual({
      permission: { bash: { "git status *": "allow" } },
    })
  })

  test("persisting does not touch the project's .gitignore", async () => {
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(root, ".opencode", ".gitignore"),
      "custom-entry\n",
    )
    const { client } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked())
    await hooks.event!(replied("always"))

    const gitignore = await fs.readFile(
      path.join(root, ".opencode", ".gitignore"),
      "utf8",
    )
    expect(gitignore).toBe("custom-entry\n")
  })

  test("an agent-writable legacy store requires user-reviewed migration", async () => {
    await fs.mkdir(path.dirname(legacyStoreFile()), { recursive: true })
    const legacy = JSON.stringify({ permission: { bash: "allow" } })
    await fs.writeFile(legacyStoreFile(), legacy)
    const { client, replies, toasts } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked())
    await hooks.event!(replied("always"))

    expect(replies).toHaveLength(0)
    await expect(fs.access(storeFile())).rejects.toThrow()
    expect(await fs.readFile(legacyStoreFile(), "utf8")).toBe(legacy)
    expect(
      toasts.some((toast) =>
        String(toast.body.message).includes("no longer trusted"),
      ),
    ).toBe(true)
  })

  test("an unstat'able store path fails closed, then reports recovery when it clears", async () => {
    // pathExists returns undefined for a stat error that is not ENOENT, and the
    // shared opener's unreadable-path gate pauses on it rather than proceeding
    // as if the file were absent. Writing .opencode as a regular FILE makes
    // fs.access on the legacy store (<root>/.opencode/permissions.local.json)
    // reject with ENOTDIR — a deterministic, root-proof stat failure, unlike a
    // chmod that no-ops as root. The plugin must fail CLOSED: no reply, nothing
    // persisted, one warn.
    await fs.writeFile(path.join(root, ".opencode"), "x")
    const { client, replies, toasts, logs } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked())
    await hooks.event!(replied("always"))

    expect(replies).toHaveLength(0)
    await expect(fs.access(storeFile())).rejects.toThrow()
    const unreadable = toasts.filter((toast) =>
      String(toast.body.message).includes(
        "a permission-store path is unreadable",
      ),
    )
    expect(unreadable).toHaveLength(1)
    expect(unreadable[0].body.variant).toBe("warning")
    expect(
      logs.some(
        (entry) =>
          entry.body.level === "warn" &&
          String(entry.body.message).includes(
            "a permission-store path is unreadable",
          ),
      ),
    ).toBe(true)

    // The path clears — the regular file is gone and a trusted store now sits
    // where it belongs. The next pass resumes and auto-approves the seeded
    // rule, and the resume is reported so "paused" is not the last word.
    await fs.rm(path.join(root, ".opencode"))
    await fs.writeFile(
      storeFile(),
      JSON.stringify({ permission: { bash: { "git status *": "allow" } } }),
    )
    await hooks.event!(asked({ id: "per_2", patterns: ["git status"] }))

    expect(replies).toHaveLength(1)
    expect(
      toasts.some(
        (toast) =>
          toast.body.variant === "info" &&
          String(toast.body.message).includes(
            "the permission-store paths are readable again",
          ),
      ),
    ).toBe(true)
  })

  test("a trusted store wins while a leftover legacy file is ignored", async () => {
    await fs.mkdir(path.dirname(legacyStoreFile()), { recursive: true })
    await fs.writeFile(
      legacyStoreFile(),
      JSON.stringify({ permission: { bash: "deny" } }),
    )
    await fs.writeFile(
      storeFile(),
      JSON.stringify({ permission: { bash: { "git *": "allow" } } }),
    )
    const { client, replies, toasts } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked())

    expect(replies).toHaveLength(1)
    expect(toasts).toHaveLength(0)
  })

  test("'once' and 'reject' replies persist nothing", async () => {
    const { client } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked({ id: "per_1" }))
    await hooks.event!(replied("once", "per_1"))
    await hooks.event!(asked({ id: "per_2" }))
    await hooks.event!(replied("reject", "per_2"))

    await expect(fs.access(storeFile())).rejects.toThrow()
  })

  test("an empty always-list persists nothing, matching opencode", async () => {
    const { client } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked({ always: [] }))
    await hooks.event!(replied("always"))

    await expect(fs.access(storeFile())).rejects.toThrow()
  })

  test("approvals accumulate across permission types", async () => {
    const { client } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked({ id: "per_1" }))
    await hooks.event!(replied("always", "per_1"))
    await hooks.event!(
      asked({
        id: "per_2",
        permission: "edit",
        patterns: ["src/app.ts"],
        always: ["*"],
      }),
    )
    await hooks.event!(replied("always", "per_2"))

    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "git status *": "allow" })
    expect(store.permission.edit).toEqual({ "src/app.ts": "allow" })
  })

  test("non-git projects (worktree '/') store in the session directory", async () => {
    const { client, replies } = makeClient()
    const hooks = await load(client, "/")

    await hooks.event!(asked())
    await hooks.event!(replied("always"))

    const store = await readJson(storeFile())
    expect(store).toEqual({ permission: { bash: { "git status *": "allow" } } })

    // And the saved rule is honored on the next request.
    await hooks.event!(asked({ id: "per_2", patterns: ["git status --short"] }))
    expect(replies).toHaveLength(1)
  })

  test("a lying non-git sentinel is verified against git: a linked worktree still keys the shared store", async () => {
    // The 2026-07-19 incident shape: the host handed plugin factories
    // worktree "/" for sessions inside real linked worktrees, and every
    // "always" save silently regressed to per-worktree keying. The sentinel
    // must be checked against git before it decides the store key.
    const run = async (cwd: string, args: string[]) => {
      const proc = Bun.spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.exited
      if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`)
    }
    const primary = path.join(sandboxRoot, "primary")
    const linked = path.join(sandboxRoot, "linked")
    await fs.mkdir(primary)
    await run(primary, ["init", "--quiet"])
    await run(primary, [
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=test",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "init",
    ])
    await run(primary, ["worktree", "add", "--quiet", linked])

    const { client, logs } = makeClient()
    const hooks = await PersistPermissionsPlugin(
      {
        client: client as any,
        directory: linked,
        worktree: "/",
        project: {} as any,
        serverUrl: new URL("http://localhost:4096"),
        experimental_workspace: { register() {} },
        $: {} as any,
      },
      undefined,
    )

    await hooks.event!(asked())
    await hooks.event!(replied("always"))

    const store = await readJson(permissionStoreFile(configDir, primary))
    expect(store).toEqual({ permission: { bash: { "git status *": "allow" } } })
    expect(
      logs.some((entry: any) =>
        String(entry.body?.message).includes(
          "sharing the permission store across worktrees",
        ),
      ),
    ).toBe(true)
  })

  // OpenCode offers a blanket "*" remember-rule for read/edit/glob/grep/
  // webfetch/... and the TUI presents it as session-scoped. Persisting it
  // forever would grant the whole tool, so the plugin saves the request's
  // concrete patterns instead — the narrowest interpretation of the approval.
  describe("blanket '*' approvals are narrowed to the requested patterns", () => {
    test("a read approval persists the file path, not '*'", async () => {
      const { client } = makeClient()
      const hooks = await load(client)

      await hooks.event!(
        asked({ permission: "read", patterns: ["src/main.ts"], always: ["*"] }),
      )
      await hooks.event!(replied("always"))

      const store = await readJson(storeFile())
      expect(store.permission.read).toEqual({ "src/main.ts": "allow" })
    })

    test("a glob approval persists the glob pattern, not '*'", async () => {
      const { client } = makeClient()
      const hooks = await load(client)

      await hooks.event!(
        asked({ permission: "glob", patterns: ["**/*.rs"], always: ["*"] }),
      )
      await hooks.event!(replied("always"))

      const store = await readJson(storeFile())
      expect(store.permission.glob).toEqual({ "**/*.rs": "allow" })
    })

    test("every requested pattern is persisted, deduplicated", async () => {
      const { client } = makeClient()
      const hooks = await load(client)

      await hooks.event!(
        asked({
          permission: "edit",
          patterns: ["a.ts", "b.ts", "a.ts"],
          always: ["*"],
        }),
      )
      await hooks.event!(replied("always"))

      const store = await readJson(storeFile())
      expect(store.permission.edit).toEqual({
        "a.ts": "allow",
        "b.ts": "allow",
      })
    })

    test("non-blanket always-patterns are persisted as shown to the user", async () => {
      const { client } = makeClient()
      const hooks = await load(client)

      // bash offers command prefixes; mcp resources offer "mcp:server:*".
      await hooks.event!(
        asked({
          id: "per_1",
          patterns: ["git status --short"],
          always: ["git status *"],
        }),
      )
      await hooks.event!(replied("always", "per_1"))
      await hooks.event!(
        asked({
          id: "per_2",
          permission: "read",
          patterns: ["mcp:linear:*"],
          always: ["mcp:linear:*"],
        }),
      )
      await hooks.event!(replied("always", "per_2"))

      const store = await readJson(storeFile())
      expect(store.permission.bash).toEqual({ "git status *": "allow" })
      expect(store.permission.read).toEqual({ "mcp:linear:*": "allow" })
    })

    test("when the request itself is for '*', '*' is persisted — nothing narrower exists", async () => {
      const { client } = makeClient()
      const hooks = await load(client)

      await hooks.event!(
        asked({
          permission: "codemode_execute",
          patterns: ["*"],
          always: ["*"],
        }),
      )
      await hooks.event!(replied("always"))

      const store = await readJson(storeFile())
      expect(store.permission.codemode_execute).toEqual({ "*": "allow" })
    })

    test("round trip: the approved file auto-approves, other files still prompt", async () => {
      const first = makeClient()
      const session1 = await load(first.client)
      await session1.event!(
        asked({ permission: "edit", patterns: ["src/app.ts"], always: ["*"] }),
      )
      await session1.event!(replied("always"))

      const second = makeClient()
      const session2 = await load(second.client)
      await session2.event!(
        asked({
          id: "per_2",
          permission: "edit",
          patterns: ["src/app.ts"],
          always: ["*"],
        }),
      )
      expect(second.replies).toHaveLength(1)

      await session2.event!(
        asked({
          id: "per_3",
          permission: "edit",
          patterns: ["src/other.ts"],
          always: ["*"],
        }),
      )
      expect(second.replies).toHaveLength(1)
    })
  })

  // The TUI half can write an (edited, possibly broader) rule just before the
  // user's "always" reply lands. Patterns the store already allows are skipped
  // so the edit is not shadowed by redundant narrower entries.
  describe("patterns already allowed by the store are not re-persisted", () => {
    async function seed(store: unknown) {
      await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
      await fs.writeFile(storeFile(), JSON.stringify(store))
    }

    test("a covering rule suppresses the narrower entry", async () => {
      // Two patterns keep the request from being auto-approved, so the reply
      // below is a genuine user answer.
      await seed({ permission: { bash: { "git *": "allow" } } })
      const { client } = makeClient()
      const hooks = await load(client)

      await hooks.event!(
        asked({
          patterns: ["git status", "npm install"],
          always: ["git status *", "npm install *"],
        }),
      )
      await hooks.event!(replied("always"))

      const store = await readJson(storeFile())
      expect(store.permission.bash).toEqual({
        "git *": "allow",
        "npm install *": "allow",
      })
    })

    test("a later 'ask' carve-out is still overridden by a fresh approval", async () => {
      await seed({
        permission: { bash: { "git *": "allow", "git push *": "ask" } },
      })
      const { client } = makeClient()
      const hooks = await load(client)

      await hooks.event!(
        asked({ patterns: ["git push origin main"], always: ["git push *"] }),
      )
      await hooks.event!(replied("always"))

      const store = await readJson(storeFile())
      // Last rule wins: the re-added allow must follow the ask carve-out.
      expect(Object.entries(store.permission.bash)).toEqual([
        ["git *", "allow"],
        ["git push *", "allow"],
      ])
    })

    test("a rule written while the prompt was open (TUI edit flow) leaves the store untouched", async () => {
      const { client } = makeClient()
      const hooks = await load(client)

      // The store is empty when the prompt appears, so nothing auto-approves.
      await hooks.event!(
        asked({
          patterns: ["docker compose up -d"],
          always: ["docker compose up *"],
        }),
      )
      // The TUI saves a broader rule while a user's host "always" reply is
      // still in flight. That reply must not add a redundant narrower rule.
      await seed({ permission: { bash: { "docker *": "allow" } } })
      const before = await fs.readFile(storeFile(), "utf8")
      await hooks.event!(replied("always"))

      expect(await fs.readFile(storeFile(), "utf8")).toBe(before)
    })
  })

  describe("pattern-less requests never persist a blanket '*'", () => {
    test("a legacy-shape event without a pattern persists nothing", async () => {
      const { client } = makeClient()
      const hooks = await load(client)

      await hooks.event!({
        event: {
          type: "permission.asked",
          properties: { id: "per_1", sessionID: "ses_1", type: "bash" },
        },
      } as any)
      await hooks.event!(replied("always"))

      await expect(fs.access(storeFile())).rejects.toThrow()
    })

    test("empty patterns with a blanket always-set persist nothing", async () => {
      const { client } = makeClient()
      const hooks = await load(client)

      await hooks.event!(asked({ patterns: [], always: ["*"] }))
      await hooks.event!(replied("always"))

      await expect(fs.access(storeFile())).rejects.toThrow()
    })

    test("empty patterns with a concrete always-set still persist the always-set", async () => {
      const { client } = makeClient()
      const hooks = await load(client)

      await hooks.event!(asked({ patterns: [], always: ["git status *"] }))
      await hooks.event!(replied("always"))

      const store = await readJson(storeFile())
      expect(store.permission.bash).toEqual({ "git status *": "allow" })
    })

    test("auto-approval of pattern-less requests still requires a blanket rule", async () => {
      await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
      await fs.writeFile(
        storeFile(),
        JSON.stringify({ permission: { bash: { "git *": "allow" } } }),
      )
      const { client, replies } = makeClient()
      const hooks = await load(client)

      // A concrete prefix rule must NOT cover a pattern-less request...
      await hooks.event!({
        event: {
          type: "permission.asked",
          properties: { id: "per_1", sessionID: "ses_1", type: "bash" },
        },
      } as any)
      expect(replies).toHaveLength(0)

      // ...but a hand-written blanket still does.
      await fs.writeFile(
        storeFile(),
        JSON.stringify({ permission: { bash: "allow" } }),
      )
      await hooks.event!({
        event: {
          type: "permission.asked",
          properties: { id: "per_2", sessionID: "ses_1", type: "bash" },
        },
      } as any)
      expect(replies).toHaveLength(1)
    })
  })

  test("a corrupt store file is never overwritten", async () => {
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(storeFile(), "{ not json")
    const { client } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked())
    await hooks.event!(replied("always"))

    expect(await fs.readFile(storeFile(), "utf8")).toBe("{ not json")
  })
})

describe("failure containment", () => {
  test("an unreadable store path is logged as an error, not thrown", async () => {
    // The store path exists as a DIRECTORY, so reading it fails closed before
    // the user's approval can reach the write path.
    await fs.mkdir(storeFile(), { recursive: true })
    const { client, logs } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked())
    await hooks.event!(replied("always")) // must resolve, not reject

    expect(
      logs.some(
        (entry) =>
          entry.body.level === "error" &&
          String(entry.body.message).includes("ignoring unreadable"),
      ),
    ).toBe(true)
  })

  // The T4 acceptance criterion (docs/july-26-fable-audit/T4-error-containment.md
  // step 6): a WRITE that fails must be logged, not thrown. The unreadable-path
  // case above cannot stand in for it — the read short-circuits inside the lock
  // and control never reaches writeStore at all. Both cases below therefore put
  // a VALID store in place first, so the read succeeds and the failure lands on
  // the write path the catch exists for.
  //
  // What is at stake is not the save (that is lost either way, fail-closed: the
  // user is re-prompted) but the diagnostic and the event pipeline. The host
  // dispatches as `void hook.event?.(…)`, so an escaping rejection is an
  // unhandled rejection and the user gets neither the rule nor a word about why.
  const validStore = JSON.stringify({
    permission: { bash: { "ls *": "allow" } },
  })
  const savedAllowRuleErrors = (logs: any[]) =>
    logs.filter(
      (entry) =>
        entry.body.level === "error" &&
        String(entry.body.message).includes("failed to save allow rule"),
    )

  test("a store that cannot be written is logged as an error, not thrown", async () => {
    await fs.writeFile(storeFile(), validStore)
    const { client, logs } = makeClient()
    const hooks = await load(client)

    // writeStore publishes by renaming a tmp file into place, so failing that
    // rename is precisely an EROFS/ENOSPC write failure. chmod would be a
    // no-op running as root, and a read-only directory would break the sibling
    // `<store>.lock` first — failing before the write path under test.
    const real = fs.rename.bind(fs)
    const spy = (async (from: never, to: never) => {
      if (to === storeFile()) throw new Error("EROFS: read-only file system")
      return await real(from, to)
    }) as unknown as typeof fs.rename
    ;(fs as { rename: typeof fs.rename }).rename = spy
    try {
      await hooks.event!(asked())
      await hooks.event!(replied("always")) // must resolve, not reject
    } finally {
      ;(fs as { rename: typeof fs.rename }).rename = real
    }

    const errors = savedAllowRuleErrors(logs)
    expect(errors).toHaveLength(1)
    expect(String(errors[0].body.message)).toContain("bash")
    expect(String(errors[0].body.message)).toContain("read-only file system")
    // Nothing half-written: the store is byte-for-byte what the user had.
    expect(await fs.readFile(storeFile(), "utf8")).toBe(validStore)
    // And no success was reported for a save that did not happen.
    expect(
      logs.some((entry) =>
        String(entry.body.message).includes("saved allow rule"),
      ),
    ).toBe(false)

    // Containment is only half the contract: the failure must also leave the
    // plugin able to save again. A lock leaked on the error path would wedge
    // every future approval in this repo — the same silent, permanent loss the
    // catch exists to prevent, just deferred to the next prompt.
    await hooks.event!(asked({ id: "per_2" }))
    await hooks.event!(replied("always", "per_2"))
    expect(savedAllowRuleErrors(logs)).toHaveLength(1)
    expect(await readJson(storeFile())).toEqual({
      permission: { bash: { "ls *": "allow", "git status *": "allow" } },
    })
  })

  test("a store lock that cannot be acquired is contained the same way", async () => {
    await fs.writeFile(storeFile(), validStore)
    const { client, logs } = makeClient()
    const hooks = await load(client)
    // A directory at the lock path makes withStoreLock fail closed on its very
    // first pass — the same failure class as another OpenCode instance holding
    // the lock past the acquisition timeout, without the wall-clock cost.
    await fs.mkdir(`${storeFile()}.lock`)

    await hooks.event!(asked())
    await hooks.event!(replied("always")) // must resolve, not reject

    const errors = savedAllowRuleErrors(logs)
    expect(errors).toHaveLength(1)
    expect(String(errors[0].body.message)).toContain("lock path is not a")
    // The message must still name the permission that was lost. This is the
    // user's only trace of an approval that silently did not stick, and a
    // generic "could not save" leaves them unable to tell which prompt to
    // expect again.
    expect(String(errors[0].body.message)).toContain("bash")
    expect(await fs.readFile(storeFile(), "utf8")).toBe(validStore)
    // No success claimed for a save that never happened.
    expect(
      logs.some((entry) =>
        String(entry.body.message).includes("saved allow rule"),
      ),
    ).toBe(false)
    // The obstruction is still exactly what the test put there — a failed
    // acquisition must not reclaim or delete a lock it never owned, which
    // would hand a second instance the store mid-write.
    expect((await fs.stat(`${storeFile()}.lock`)).isDirectory()).toBe(true)
  })

  test("a malformed store value (null) is corrupt trust data: fail closed, never overwrite", async () => {
    const malformed = JSON.stringify({ permission: { bash: null } })
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(storeFile(), malformed)
    const { client, logs, replies } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked()) // must not throw
    expect(replies).toHaveLength(0) // and must not auto-approve

    // Unknown rules silently dropped would keep the store looking readable
    // while consumers evaluate weaker rules than the user wrote — so the
    // whole store is treated as corrupt: nothing persists over it.
    await hooks.event!(replied("always"))
    expect(await fs.readFile(storeFile(), "utf8")).toBe(malformed)
    expect(
      logs.some(
        (entry) =>
          entry.body.level === "error" &&
          String(entry.body.message).includes("ignoring unreadable"),
      ),
    ).toBe(true)
  })

  test("an invalid action string is corrupt trust data too", async () => {
    const malformed = JSON.stringify({
      permission: { bash: { "git *": "yolo" } },
    })
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(storeFile(), malformed)
    const { client, replies } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked())
    expect(replies).toHaveLength(0)
    await hooks.event!(replied("always"))
    expect(await fs.readFile(storeFile(), "utf8")).toBe(malformed)
  })
})

// The config-directory lookup decides where the store lives, so a failure
// pauses everything. It used to be resolved exactly once, at boot: a host that
// was still starting when the plugin loaded left persistence off until OpenCode
// was restarted. Only a SUCCESS may be cached.
describe("the config-directory lookup recovers without a restart", () => {
  const seed = (store: unknown) =>
    fs.writeFile(storeFile(), JSON.stringify(store))
  // One macrotask turn drains the whole pending microtask queue, so after this
  // the boot prime's probe has provably settled and released the shared
  // in-flight slot. Tests that want the prime OUT OF THE WAY call it right
  // after load(); tests that want to join the prime's probe deliberately skip
  // it. Neither is a tick-count budget — a macrotask boundary draining
  // microtasks is a language guarantee, not a timing bet.
  const primeSettled = () => new Promise((resolve) => setTimeout(resolve, 0))

  test("a transient failure at boot does not disable persistence for the process", async () => {
    let failing = true
    const { client, toasts } = makeClient()
    ;(client as any).path = {
      get: async () => {
        if (failing) throw new Error("host still starting")
        return { data: { config: configDir, state: stateDir } }
      },
    }
    const hooks = await load(client)
    await primeSettled()

    // While the host is down, everything pauses — fail-closed, and the user is
    // told once why.
    await hooks.event!(asked())
    await hooks.event!(replied("always"))
    expect(await fs.exists(storeFile())).toBe(false)
    expect(
      toasts.some((toast) =>
        String(toast.body.message).includes("host still starting"),
      ),
    ).toBe(true)

    // The host finishes starting. No restart, no new plugin instance.
    failing = false
    await hooks.event!(asked({ id: "per_2" }))
    await hooks.event!(replied("always", "per_2"))

    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "git status *": "allow" })
  })

  test("a read recovers too, once a probe is due again", async () => {
    // A READ-ONLY recovery: no "always" reply anywhere in this test. Writes are
    // exempt from the throttle, so recovering through one proves nothing about
    // the read path — it would pass even if reads never retried at all. The
    // clock is what makes the retry due; nothing else can.
    await seed({ permission: { bash: { "git *": "allow" } } })
    let failing = true
    let skew = 0
    const realNow = Date.now.bind(Date)
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew)
    try {
      const { client, replies } = makeClient()
      ;(client as any).path = {
        get: async () => {
          if (failing) throw new Error("host still starting")
          return { data: { config: configDir, state: stateDir } }
        },
      }
      const hooks = await load(client)
      await primeSettled()

      await hooks.event!(asked({ id: "per_1", patterns: ["git status"] }))
      expect(replies).toHaveLength(0)

      // The host is healthy again, but this read is still inside the retry
      // interval: throttled, so it stays paused. (Without this leg the test
      // could not tell a retry from an absent throttle.)
      failing = false
      await hooks.event!(asked({ id: "per_2", patterns: ["git log"] }))
      expect(replies).toHaveLength(0)

      // Past CONFIG_RETRY_INTERVAL_MS (15s), a read re-probes on its own.
      skew += 15_001
      await hooks.event!(asked({ id: "per_3", patterns: ["git diff"] }))
      expect(replies.map((reply: any) => reply.path.permissionID)).toEqual([
        "per_3",
      ])
    } finally {
      clock.mockRestore()
    }
  })

  test("a failing host is re-probed on the interval for reads, and always for writes", async () => {
    // Retrying is not the same as retrying constantly: a burst of prompts
    // against a host that is genuinely down must not become a burst of
    // requests, or a burst of toasts. A write is exempt — an "always" reply is
    // rare, user-initiated, and the moment a dropped save becomes lost intent.
    let attempts = 0
    const { client, toasts } = makeClient()
    ;(client as any).path = {
      get: async () => {
        attempts += 1
        throw new Error("host still starting")
      },
    }
    const hooks = await load(client)
    await primeSettled()

    for (const id of ["per_1", "per_2", "per_3", "per_4"])
      await hooks.event!(asked({ id }))
    // The boot prime, plus the first read (the prime deliberately leaves the
    // throttle budget unspent). The other three fall inside the interval.
    expect(attempts).toBe(2)
    expect(
      toasts.filter((toast) =>
        String(toast.body.message).includes("host still starting"),
      ),
    ).toHaveLength(1)

    await hooks.event!(replied("always", "per_4"))
    expect(attempts).toBe(3)
  })

  test("a client that can never grow a path lookup is not retried at all", async () => {
    // The injected SDK client is one fixed object for the process, so this leg
    // is decided once at factory time and stays decided — unlike a request that
    // failed, which is what the retry above exists for. The client keeps a
    // COUNTABLE path surface whose `get` is absent, so "decided once" is
    // observable: with `path` simply undefined there is nothing to count and
    // the assertions below would hold however often the leg were re-decided.
    let reads = 0
    const { client, toasts } = makeClient()
    ;(client as any).path = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "get") reads += 1
          return undefined
        },
      },
    )
    const hooks = await load(client)
    const atFactory = reads

    await hooks.event!(asked({ id: "per_1" }))
    await hooks.event!(asked({ id: "per_2" }))
    await hooks.event!(replied("always", "per_2"))

    expect(atFactory).toBeGreaterThan(0) // the leg really was decided at factory time
    expect(reads).toBe(atFactory) // …and never re-decided, not even for a write
    expect(
      toasts.filter((toast) =>
        String(toast.body.message).includes("no path lookup method"),
      ),
    ).toHaveLength(1)
    expect(await fs.exists(storeFile())).toBe(false)
  })

  test("an invalid scope is decided once too, and never probes the host", async () => {
    let reads = 0
    const { client, toasts } = makeClient()
    ;(client as any).path = {
      get: async () => {
        reads += 1
        return { data: { config: configDir, state: stateDir } }
      },
    }
    const hooks = await load(client, root, new URL("http://localhost:4096"), {
      scope: "sideways",
    })

    await hooks.event!(asked({ id: "per_1" }))
    await hooks.event!(replied("always", "per_1"))

    expect(reads).toBe(0)
    expect(
      toasts.filter((toast) =>
        String(toast.body.message).includes('"scope" plugin option is invalid'),
      ),
    ).toHaveLength(1)
  })

  test("a write re-probes rather than inheriting a failure that was already in flight", async () => {
    // The write arrived while a read's probe was mid-flight against a host that
    // had not finished starting. Handing it that probe's answer would drop the
    // user's approval for a failure that predates their action. No seed: a
    // store that already covered the pattern would let the write be skipped as
    // redundant and the assertion would pass without a save.
    let attempts = 0
    let release!: (value: unknown) => void
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const { client } = makeClient()
    ;(client as any).path = {
      get: async () => {
        attempts += 1
        if (attempts === 1) {
          await gate
          throw new Error("host still starting")
        }
        return { data: { config: configDir, state: stateDir } }
      },
    }
    // Deliberately NOT settled: this test needs the prime's probe still in
    // flight, so the events below join it rather than starting their own.
    const hooks = await load(client)

    const read = hooks.event!(asked({ id: "per_1", patterns: ["git status"] }))
    expect(attempts).toBe(1) // the boot prime's probe, still gated
    const write = hooks.event!(replied("always", "per_1"))
    release(undefined)
    await Promise.all([read, write])

    expect(attempts).toBe(2)
    const store = await readJson(storeFile())
    expect(store.permission.bash["git status *"]).toBe("allow")
  })

  test("a probe that never responds does not wedge later permission events", async () => {
    // Every caller joins the one in-flight probe, so a request that never
    // settles would never clear it — and before retries existed, a host that
    // answered once could not wedge anything afterwards. The bound is what
    // keeps that true now that the hooks re-probe.
    let attempts = 0
    const signals: (AbortSignal | undefined)[] = []
    const { client, toasts } = makeClient()
    ;(client as any).path = {
      get: async (options: any) => {
        attempts += 1
        signals.push(options?.signal)
        if (attempts === 1) return new Promise(() => {}) // never settles
        return { data: { config: configDir, state: stateDir } }
      },
    }
    // Not settled: the event below must JOIN the stalled probe, which is the
    // shape that wedges — every caller shares one in-flight lookup.
    const hooks = await load(client)

    // Would hang forever without the probe timeout.
    await hooks.event!(asked({ id: "per_1" }))
    expect(
      toasts.some((toast) =>
        String(toast.body.message).includes("did not respond"),
      ),
    ).toBe(true)

    // Losing the race releases this plugin's callers; it must also cancel the
    // REQUEST, or a wedged host accumulates one live lookup per later write
    // (writes bypass the read throttle) for the life of the process.
    expect(signals[0]?.aborted).toBe(true)

    // And the process is not poisoned: the next write probes again and works.
    await hooks.event!(asked({ id: "per_2" }))
    await hooks.event!(replied("always", "per_2"))
    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "git status *": "allow" })
    // The retry got its own controller — the abort above must not reach it.
    expect(signals[1]?.aborted).toBe(false)
  }, 20_000)

  test("disposing the plugin cancels a probe still on the wire", async () => {
    // The host tears plugin instances down per directory, not only at exit, so
    // a probe nothing will ever read again must not outlive its hooks.
    let signal: AbortSignal | undefined
    const { client } = makeClient()
    ;(client as any).path = {
      get: async (options: any) => {
        signal = options?.signal
        return new Promise(() => {}) // never settles
      },
    }
    const hooks = await load(client)
    const deadline = Date.now() + 4_000
    while (!signal && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 0))

    expect(signal?.aborted).toBe(false)
    await hooks.dispose!()
    expect(signal?.aborted).toBe(true)
  })

  test("a recovery after a pause warning is reported, not just un-flagged", async () => {
    // The exact interleaving the write loop-back creates: a read joins a probe
    // against a host that is still starting and warns that persistence is
    // paused, then the write on the SAME reply re-probes, succeeds, and saves.
    // Clearing the pause key re-arms the warning but tells the user nothing —
    // the last thing they were shown still says persistence is off while the
    // store is in fact correct.
    let failing = true
    const { client, toasts } = makeClient()
    ;(client as any).path = {
      get: async () => {
        if (failing) throw new Error("host still starting")
        return { data: { config: configDir, state: stateDir } }
      },
    }
    const hooks = await load(client)
    await primeSettled()

    await hooks.event!(asked({ id: "per_1" }))
    expect(
      toasts.filter((toast) =>
        String(toast.body.message).includes("host still starting"),
      ),
    ).toHaveLength(1)

    failing = false
    await hooks.event!(replied("always", "per_1"))

    expect(await readJson(storeFile())).toEqual({
      permission: { bash: { "git status *": "allow" } },
    })
    const last = toasts[toasts.length - 1]
    expect(last.body.variant).toBe("info")
    expect(String(last.body.message)).toBe(
      "Permission persistence resumed: the config directory resolved.",
    )
  })

  test("a pause cause that recurs after a recovery is reported again", async () => {
    // Each pause key is cleared when its condition reads cleanly, so a second
    // outage is news rather than a swallowed duplicate. The config lookup
    // cannot demonstrate this — a SUCCESS is cached for the process, so that
    // cause can never come back — but the untrusted-legacy-store one can: it is
    // re-derived from the filesystem on every access.
    await fs.mkdir(path.dirname(legacyStoreFile()), { recursive: true })
    await fs.writeFile(
      legacyStoreFile(),
      JSON.stringify({ permission: { bash: { "git *": "allow" } } }),
    )
    const { client, toasts } = makeClient()
    const hooks = await load(client)
    const warnings = () =>
      toasts.filter((toast) =>
        String(toast.body.message).includes(
          "is agent-writable and is no longer trusted",
        ),
      ).length
    const recoveries = () =>
      toasts.filter((toast) =>
        String(toast.body.message).includes(
          "the trusted permission store is in place",
        ),
      ).length

    await hooks.event!(asked({ id: "per_1" }))
    expect(warnings()).toBe(1)

    // The user does what the warning asked: recreates the store where it is
    // trusted. The pause lifts, and the lift is reported.
    await fs.writeFile(storeFile(), JSON.stringify({ permission: {} }))
    await hooks.event!(asked({ id: "per_2" }))
    expect(warnings()).toBe(1)
    expect(recoveries()).toBe(1)

    // …and then it breaks again. A swallowed duplicate here would leave the
    // user with no sign that persistence stopped a second time.
    await fs.rm(storeFile())
    await hooks.event!(asked({ id: "per_3" }))
    expect(warnings()).toBe(2)
  })

  test("concurrent permission events share one config lookup", async () => {
    await seed({ permission: { bash: { "git *": "allow" } } })
    let attempts = 0
    let release!: (value: unknown) => void
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const { client, replies } = makeClient()
    ;(client as any).path = {
      get: async () => {
        attempts += 1
        await gate
        return { data: { config: configDir, state: stateDir } }
      },
    }
    const hooks = await load(client)

    const first = hooks.event!(asked({ id: "per_1", patterns: ["git status"] }))
    const second = hooks.event!(asked({ id: "per_2", patterns: ["git log"] }))
    release(undefined)
    await Promise.all([first, second])

    // Two events answered off ONE released probe is the structural proof of
    // coalescing: neither could have completed otherwise. The count is the
    // secondary check — the boot prime's probe is the one they both joined.
    expect(replies).toHaveLength(2)
    expect(attempts).toBe(1)
  })
})

describe("auto-approving saved permissions", () => {
  async function seed(store: unknown) {
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(storeFile(), JSON.stringify(store))
  }

  test("replies 'once' when every requested pattern is allowed", async () => {
    await seed({ permission: { bash: { "git status *": "allow" } } })
    const { client, replies } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked({ patterns: ["git status --short"] }))

    expect(replies).toHaveLength(1)
    expect(replies[0].path).toEqual({ id: "ses_1", permissionID: "per_1" })
    expect(replies[0].body).toEqual({ response: "once" })
  })

  // A single ask can be delivered twice (SSE reconnect/replay hands the same
  // request id back). The autoReplied dedupe guard must answer it exactly once —
  // a second reply POST to an already-answered permission is redundant traffic.
  test("a re-delivered ask with the same id is auto-replied only once", async () => {
    await seed({ permission: { bash: { "git status *": "allow" } } })
    const { client, replies } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked({ id: "per_1", patterns: ["git status --short"] }))
    await hooks.event!(asked({ id: "per_1", patterns: ["git status --short"] }))

    expect(replies).toHaveLength(1)
  })

  // OpenCode reacts to an "always" reply by allowing request.always in-memory
  // for the rest of the instance — a blanket "*" for most tools. The plugin
  // must not unlock more than the saved rule covers.
  describe("the reply never unlocks more than the saved rules", () => {
    for (const source of ["saved", "session"] as const) {
      for (const action of ["ask", "deny"] as const) {
        test(`a ${source} ${action} carve-out survives ordinary auto-approval`, async () => {
          await seed({
            permission: {
              read:
                source === "saved"
                  ? { "*": "allow", ".env*": action }
                  : { "*": "allow" },
            },
          })
          const before = await fs.readFile(storeFile(), "utf8")
          const { client, replies } = makeClient(BAND.floor, {
            ses_1: {
              id: "ses_1",
              permission:
                source === "session"
                  ? [{ permission: "read", pattern: ".env*", action }]
                  : [],
            },
          })
          const hooks = await load(client)

          // The protected prompt may already be pending when the ordinary
          // read is approved. Neither it nor a later read may inherit a grant.
          await Promise.all(
            [
              { id: "per_pending", patterns: [".env"] },
              { id: "per_allowed", patterns: ["README.md"] },
            ].map((request) =>
              hooks.event!(
                asked({ permission: "read", always: ["*"], ...request }),
              ),
            ),
          )
          expect(replies).toHaveLength(1)
          expect(replies[0].path.permissionID).toBe("per_allowed")
          expect(replies[0].body).toEqual({ response: "once" })
          await hooks.event!(replied("once", "per_allowed"))
          await hooks.event!(
            asked({
              id: "per_later",
              permission: "read",
              patterns: [".env.local"],
              always: ["*"],
            }),
          )
          expect(replies).toHaveLength(1)
          expect(await fs.readFile(storeFile(), "utf8")).toBe(before)
        })
      }
    }

    test("a saved 'git ?' never grants the 'git *' remember-rule language", async () => {
      await seed({ permission: { bash: { "git ?": "allow" } } })
      const { client, replies } = makeClient()
      const hooks = await load(client)

      await hooks.event!(asked({ patterns: ["git a"], always: ["git *"] }))
      expect(replies).toHaveLength(1)
      expect(replies[0].body).toEqual({ response: "once" })
      await hooks.event!(
        asked({ id: "per_2", patterns: ["git status"], always: ["git *"] }),
      )
      expect(replies).toHaveLength(1)
    })

    test("revoking a broad saved approval takes effect on the next request", async () => {
      await seed({ permission: { read: { "*": "allow" } } })
      const { client, replies } = makeClient()
      const hooks = await load(client)

      await hooks.event!(
        asked({ permission: "read", patterns: ["README.md"], always: ["*"] }),
      )
      expect(replies).toHaveLength(1)
      expect(replies[0].body).toEqual({ response: "once" })
      await seed({ permission: { read: { "*": "deny" } } })
      await hooks.event!(
        asked({
          id: "per_2",
          permission: "read",
          patterns: ["README.md"],
          always: ["*"],
        }),
      )
      expect(replies).toHaveLength(1)
    })

    test("replies 'once' when the in-memory always-set would be broader than the store", async () => {
      await seed({ permission: { read: { "src/main.ts": "allow" } } })
      const { client, replies } = makeClient()
      const hooks = await load(client)

      await hooks.event!(
        asked({ permission: "read", patterns: ["src/main.ts"], always: ["*"] }),
      )

      expect(replies).toHaveLength(1)
      expect(replies[0].body).toEqual({ response: "once" })
    })

    test("each matching request gets its own auto-reply", async () => {
      await seed({ permission: { read: { "src/main.ts": "allow" } } })
      const { client, replies } = makeClient()
      const hooks = await load(client)

      await hooks.event!(
        asked({
          id: "per_1",
          permission: "read",
          patterns: ["src/main.ts"],
          always: ["*"],
        }),
      )
      await hooks.event!(
        asked({
          id: "per_2",
          permission: "read",
          patterns: ["src/main.ts"],
          always: ["*"],
        }),
      )

      expect(replies).toHaveLength(2)
    })

    test("a hand-widened store covering the always-set is still answered 'once'", async () => {
      await seed({ permission: { read: { "*": "allow" } } })
      const { client, replies } = makeClient()
      const hooks = await load(client)

      await hooks.event!(
        asked({ permission: "read", patterns: ["src/main.ts"], always: ["*"] }),
      )

      expect(replies).toHaveLength(1)
      expect(replies[0].body).toEqual({ response: "once" })
    })

    test("bash prefix rules are also answered 'once'", async () => {
      await seed({ permission: { bash: { "git status *": "allow" } } })
      const { client, replies } = makeClient()
      const hooks = await load(client)

      await hooks.event!(
        asked({ patterns: ["git status --short"], always: ["git status *"] }),
      )

      expect(replies).toHaveLength(1)
      expect(replies[0].body).toEqual({ response: "once" })
    })
  })

  test("a trailing ' *' pattern also matches the bare command", async () => {
    await seed({ permission: { bash: { "git status *": "allow" } } })
    const { client, replies } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked({ patterns: ["git status"] }))

    expect(replies).toHaveLength(1)
  })

  test("does not reply when a pattern is not covered", async () => {
    await seed({ permission: { bash: { "git status *": "allow" } } })
    const { client, replies } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked({ patterns: ["git push origin main"] }))
    await hooks.event!(
      asked({ id: "per_2", patterns: ["git status", "rm -rf /"] }),
    )

    expect(replies).toHaveLength(0)
  })

  test("last matching rule wins, so hand-added ask/deny rules block auto-approval", async () => {
    await seed({
      permission: { bash: { "git *": "allow", "git push *": "ask" } },
    })
    const { client, replies } = makeClient()
    const hooks = await load(client)

    await hooks.event!(
      asked({ id: "per_1", patterns: ["git push origin main"] }),
    )
    expect(replies).toHaveLength(0)

    await hooks.event!(asked({ id: "per_2", patterns: ["git log"] }))
    expect(replies).toHaveLength(1)
  })

  test("string-form rules from hand-edited stores are honored", async () => {
    await seed({ permission: { webfetch: "allow" } })
    const { client, replies } = makeClient()
    const hooks = await load(client)

    await hooks.event!(
      asked({ permission: "webfetch", patterns: ["https://example.com"] }),
    )

    expect(replies).toHaveLength(1)
  })

  test("its own reply is not re-persisted", async () => {
    await seed({ permission: { bash: { "git status *": "allow" } } })
    const { client } = makeClient()
    const hooks = await load(client)
    const before = await fs.readFile(storeFile(), "utf8")

    await hooks.event!(asked({ patterns: ["git status"] }))
    await hooks.event!(replied("always"))

    expect(await fs.readFile(storeFile(), "utf8")).toBe(before)
  })

  test("its own reply is not re-persisted even when it would add a narrower rule", async () => {
    await seed({ permission: { bash: { "git *": "allow" } } })
    const { client, replies } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked({ patterns: ["git status"] }))
    await hooks.event!(replied("always"))

    expect(replies).toHaveLength(1)
    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "git *": "allow" })
  })

  test("a failed reply call leaves the prompt to the user without crashing", async () => {
    await seed({ permission: { bash: { "git status *": "allow" } } })
    const logs: any[] = []
    const client = {
      postSessionIdPermissionsPermissionId: async () => ({
        error: { name: "NotFoundError" },
      }),
      app: {
        log: async (input: any) => {
          logs.push(input)
          return {}
        },
      },
      // path and session are what let the auto-approval actually be ATTEMPTED.
      // Without them the plugin pauses before it ever reaches the reply, and
      // this test passes by reading back its own seed while covering nothing —
      // which is what it did until the reply attempt was pinned below.
      path: {
        get: async () => ({ data: { config: configDir, state: stateDir } }),
      },
      session: { get: async () => ({ data: { id: "ses_1" } }) },
      global: {
        health: async () => ({ data: { healthy: true, version: BAND.floor } }),
      },
    }
    const hooks = await load(client)

    await hooks.event!(asked({ patterns: ["git status"] }))
    expect(
      logs.some(
        (entry) =>
          entry.body.level === "warn" &&
          String(entry.body.message).includes("auto-approve failed"),
      ),
    ).toBe(true)
    // The failed reply released its ledger claim too: the user's own answer
    // below must read as the user, not as suite automation.
    expect(automatedReplies().has("per_1")).toBe(false)
    // The user answers instead; their approval must still persist.
    await hooks.event!(replied("always"))

    const store = await readJson(storeFile())
    expect(store.permission.bash["git status *"]).toBe("allow")
  })

  test("a client with no reply method warns and still persists the user's own 'always'", async () => {
    // The store would auto-approve, but this degraded client lacks the reply
    // method entirely. The auto-reply attempt must release its claim on the
    // request id (autoReplied.delete) so the user's own subsequent "always" is
    // NOT mistaken for the plugin's own reply and is genuinely persisted.
    await seed({ permission: { bash: { "git status *": "allow" } } })
    const { client, replies, logs } = makeClient()
    // The reply method is a prototype method; shadowing the instance property
    // with undefined makes autoReply's optional-chain short-circuit, hitting
    // the !respond branch.
    ;(client as any).postSessionIdPermissionsPermissionId = undefined
    const hooks = await load(client)

    // patterns are covered by the store, so auto-approval is attempted — but
    // there is no method to call it with. always carries a NOT-yet-stored
    // pattern so the user's reply has something real to persist.
    await hooks.event!(
      asked({
        patterns: ["git status"],
        always: ["git status *", "git log *"],
      }),
    )
    expect(replies).toHaveLength(0)
    const warns = logs.filter(
      (entry) =>
        entry.body.level === "warn" &&
        String(entry.body.message).includes("no permission reply method"),
    )
    expect(warns).toHaveLength(1)
    // No reply was posted, so no ledger claim may remain either.
    expect(automatedReplies().has("per_1")).toBe(false)

    // The failed auto-reply released its claim, so the user's own "always" is
    // persisted rather than swallowed as the plugin's own reply.
    await hooks.event!(replied("always"))
    const store = await readJson(storeFile())
    expect(store.permission.bash["git log *"]).toBe("allow")

    // Second symptom of a leaked claim: a re-emitted event for the same id must
    // not be swallowed by the autoReplied.has() guard — it warns again.
    await hooks.event!(asked({ patterns: ["git status"] }))
    expect(
      logs.filter(
        (entry) =>
          entry.body.level === "warn" &&
          String(entry.body.message).includes("no permission reply method"),
      ),
    ).toHaveLength(2)
  })
})

describe("session-scoped rules outrank the store", () => {
  async function seed(store: unknown) {
    await fs.writeFile(storeFile(), JSON.stringify(store))
  }

  // The shape opencode-btw gives its read-only side-question forks: gate
  // everything, re-allow reads. An explicit session "ask" is why the prompt
  // exists at all — the store must not answer it.
  const sandboxed = {
    id: "ses_1",
    permission: [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "read", pattern: "*", action: "allow" },
    ],
  }

  test("an explicit session 'ask' rule blocks auto-approval", async () => {
    await seed({ permission: { bash: { "git *": "allow" } } })
    const { client, replies } = makeClient(BAND.floor, { ses_1: sandboxed })
    const hooks = await load(client)

    await hooks.event!(asked({ patterns: ["git status"] }))

    expect(replies).toHaveLength(0)
  })

  test("a session rule resolving to allow does not block", async () => {
    await seed({ permission: { read: { "*": "allow" } } })
    const { client, replies } = makeClient(BAND.floor, { ses_1: sandboxed })
    const hooks = await load(client)

    // Last match for the pattern is the session's own read-allow.
    await hooks.event!(
      asked({ permission: "read", patterns: ["src/main.ts"], always: ["*"] }),
    )

    expect(replies).toHaveLength(1)
  })

  test("a session with no rules of its own leaves the store in charge", async () => {
    await seed({ permission: { bash: { "git *": "allow" } } })
    const { client, replies, sessionGets } = makeClient(BAND.floor, {
      ses_1: { id: "ses_1", permission: [] },
    })
    const hooks = await load(client)

    await hooks.event!(asked({ patterns: ["git status"] }))

    expect(replies).toHaveLength(1)
    expect(sessionGets).toEqual(["ses_1"])
  })

  test("an unreadable session fails closed (prompt stays interactive) and warns", async () => {
    await seed({ permission: { bash: { "git *": "allow" } } })
    const { client, replies, logs } = makeClient(BAND.floor, {}) // ses_1 unknown → { error }
    const hooks = await load(client)

    await hooks.event!(asked({ patterns: ["git status"] }))

    expect(replies).toHaveLength(0)
    expect(
      logs.some(
        (entry) =>
          entry.body.level === "warn" &&
          String(entry.body.message).includes("session rules"),
      ),
    ).toBe(true)
  })

  test("rules are fetched once per session and refetched after it changes", async () => {
    await seed({ permission: { bash: { "git *": "allow" } } })
    const sessions: Record<string, unknown> = {
      ses_1: { id: "ses_1", permission: [] },
    }
    const { client, replies, sessionGets } = makeClient(BAND.floor, sessions)
    const hooks = await load(client)

    await hooks.event!(asked({ id: "per_1", patterns: ["git status"] }))
    await hooks.event!(asked({ id: "per_2", patterns: ["git log"] }))
    expect(sessionGets).toEqual(["ses_1"]) // cached across asks
    expect(replies).toHaveLength(2)

    // The session gets sandboxed mid-life; the update event drops the cache.
    sessions.ses_1 = {
      id: "ses_1",
      permission: [{ permission: "*", pattern: "*", action: "ask" }],
    }
    await hooks.event!({
      event: { type: "session.updated", properties: { info: { id: "ses_1" } } },
    } as any)
    await hooks.event!(asked({ id: "per_3", patterns: ["git diff"] }))

    expect(sessionGets).toEqual(["ses_1", "ses_1"])
    expect(replies).toHaveLength(2) // the new ask rule now blocks
  })

  test("an update that lands mid-lookup is not overwritten by the stale response", async () => {
    // The host launches event hooks without awaiting the previous one
    // (`void hook.event?.(…)` in its plugin dispatcher), so a session.updated
    // carrying a fresh "ask" rule can land while the lookup for an in-flight
    // prompt is still on the wire. Dropping the cache entry does not reach that
    // response — it was read BEFORE the update — so writing it back would both
    // auto-approve the prompt in flight and answer every later prompt from the
    // pre-update ruleset until the session happened to change again.
    await seed({ permission: { bash: { "git *": "allow" } } })
    const sessions: Record<string, unknown> = {
      ses_1: { id: "ses_1", permission: [] },
    }
    const { client, replies, sessionGets } = makeClient(BAND.floor, sessions)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inner = (client as any).session.get
    ;(client as any).session.get = async (options: any) => {
      const first = sessionGets.length === 0
      // Resolved from the map as it is NOW: the stale, pre-update ruleset.
      const result = await inner(options)
      if (first) await gate
      return result
    }
    const hooks = await load(client)

    const asking = hooks.event!(
      asked({ id: "per_1", patterns: ["git status"] }),
    )
    const deadline = Date.now() + 4_000
    while (sessionGets.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sessionGets).toHaveLength(1) // the lookup is on the wire

    sessions.ses_1 = {
      id: "ses_1",
      permission: [{ permission: "*", pattern: "*", action: "ask" }],
    }
    await hooks.event!({
      event: { type: "session.updated", properties: { info: { id: "ses_1" } } },
    } as any)
    release()
    await asking

    // The in-flight prompt fails closed rather than acting on a ruleset it
    // knows to be superseded.
    expect(replies).toHaveLength(0)
    // And nothing stale was cached: the next prompt re-reads, and sees the ask.
    await hooks.event!(asked({ id: "per_2", patterns: ["git log"] }))
    expect(sessionGets).toEqual(["ses_1", "ses_1"])
    expect(replies).toHaveLength(0)
  })

  // A client with no session surface at all is not a shape any supported host
  // serves — but "I cannot read this session's rules" and "this session has no
  // rules" are the same observation from here, and only one of them is safe to
  // act on. These three pin the fail-closed reading.
  test("a client with no session lookup fails closed and warns once", async () => {
    await seed({ permission: { bash: { "git *": "allow" } } })
    const { client, replies, logs, toasts } = makeClient(
      BAND.floor,
      undefined,
      { sessionApi: false },
    )
    const hooks = await load(client)

    await hooks.event!(asked({ id: "per_1", patterns: ["git status"] }))
    await hooks.event!(asked({ id: "per_2", patterns: ["git log"] }))

    expect(replies).toHaveLength(0)
    // Permanent for the process, so it must warn ONCE across both asks — the
    // difference between warnOnce and a plain log.
    const warned = toasts.filter((toast) =>
      String(toast.body.message).includes("no session lookup"),
    )
    expect(warned).toHaveLength(1)
    expect(warned[0].body.variant).toBe("warning")
    expect(
      logs.filter(
        (entry) =>
          entry.body.level === "warn" &&
          String(entry.body.message).includes("no session lookup"),
      ),
    ).toHaveLength(1)
  })

  test("a client with no session lookup still saves an 'always' answer", async () => {
    // Only ANSWERING from the store is paused; the save path never consults
    // session rules, so the user's own approval must still persist.
    const { client } = makeClient(BAND.floor, undefined, { sessionApi: false })
    const hooks = await load(client)

    await hooks.event!(asked({ patterns: ["git status"] }))
    await hooks.event!(replied("always"))

    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "git status *": "allow" })
  })

  test("the legacy permission.ask hook fails closed without a session lookup too", async () => {
    await seed({ permission: { bash: { "git *": "allow" } } })
    const { client, logs } = makeClient(BAND.floor, undefined, {
      sessionApi: false,
    })
    const hooks = await load(client)

    const output = { status: "ask" as "ask" | "deny" | "allow" }
    await hooks["permission.ask"]!(
      {
        id: "per_1",
        sessionID: "ses_1",
        type: "bash",
        pattern: "git diff",
      } as any,
      output,
    )

    expect(output.status).toBe("ask")
    // Pins that the hook reached resolveSessionRules rather than bailing
    // earlier — without this the assertion above cannot tell the two apart.
    expect(
      logs.some(
        (entry) =>
          entry.body.level === "warn" &&
          String(entry.body.message).includes("no session lookup"),
      ),
    ).toBe(true)
  })

  test("the legacy permission.ask hook respects session rules too", async () => {
    await seed({ permission: { bash: { "git *": "allow" } } })
    const { client } = makeClient(BAND.floor, { ses_1: sandboxed })
    const hooks = await load(client)

    const output = { status: "ask" as "ask" | "deny" | "allow" }
    await hooks["permission.ask"]!(
      {
        id: "per_1",
        sessionID: "ses_1",
        type: "bash",
        pattern: "git diff",
      } as any,
      output,
    )
    expect(output.status).toBe("ask")
  })
})

describe("full round trip", () => {
  test("approval in one session auto-approves in the next", async () => {
    const first = makeClient()
    const session1 = await load(first.client)
    await session1.event!(asked())
    await session1.event!(replied("always"))
    expect(first.replies).toHaveLength(0)

    const second = makeClient()
    const session2 = await load(second.client)
    await session2.event!(
      asked({ id: "per_9", patterns: ["git status --porcelain"] }),
    )

    expect(second.replies).toHaveLength(1)
    expect(second.replies[0].path.permissionID).toBe("per_9")
    // The automatic answer is registered in the suite-wide ledger, so a
    // co-installed Approve for Me never mistakes its replied event for the
    // user being present (that would reset its unattended-deny budget).
    expect(automatedReplies().has("per_9")).toBe(true)
    automatedReplies().delete("per_9") // the consumer's job; keep tests isolated
  })
})

describe("diagnostic logging", () => {
  test("persisting an approval logs through app.log with its receiver intact", async () => {
    const { client, logs } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked())
    await hooks.event!(replied("always"))

    // Filtered, not counted: the harness fakes a non-git directory as the
    // worktree, so the primary-root probe also logs its fallback warning.
    const saved = logs.filter((entry) =>
      String(entry.body.message).includes("saved allow rule"),
    )
    expect(saved).toHaveLength(1)
    expect(saved[0].body.service).toBe("persist-permissions")
  })

  test("auto-approval logs an info entry", async () => {
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(
      storeFile(),
      JSON.stringify({ permission: { bash: { "git *": "allow" } } }),
    )
    const { client, logs } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked({ patterns: ["git status"] }))

    expect(
      logs.some((entry) =>
        String(entry.body.message).includes("auto-approved"),
      ),
    ).toBe(true)
  })

  test("a client without app.log is tolerated", async () => {
    const client = {
      postSessionIdPermissionsPermissionId: async () => ({ data: true }),
      global: {
        health: async () => ({ data: { healthy: true, version: BAND.floor } }),
      },
      path: {
        get: async () => ({ data: { config: configDir, state: stateDir } }),
      },
    }
    const hooks = await load(client)

    await hooks.event!(asked())
    await hooks.event!(replied("always"))

    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "git status *": "allow" })
  })
})

describe("legacy permission.ask hook", () => {
  test("sets output.status to allow for saved permissions", async () => {
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(
      storeFile(),
      JSON.stringify({ permission: { bash: { "git *": "allow" } } }),
    )
    const { client } = makeClient()
    const hooks = await load(client)

    const output = { status: "ask" as "ask" | "deny" | "allow" }
    await hooks["permission.ask"]!(
      {
        id: "per_1",
        sessionID: "ses_1",
        type: "bash",
        pattern: "git diff",
      } as any,
      output,
    )
    expect(output.status).toBe("allow")

    output.status = "ask"
    await hooks["permission.ask"]!(
      {
        id: "per_2",
        sessionID: "ses_1",
        type: "bash",
        pattern: "npm install",
      } as any,
      output,
    )
    expect(output.status).toBe("ask")
  })
})

// The store-path mechanics (probe self-check, prepend-merge semantics) are
// pinned in matching-spec.test.ts and the cross-half keying in
// cross-half-contract.test.ts; these cover the server half's WIRING of them —
// option handling, the migration gate ordering, and the pause/unpause flow.
describe("repository scope wiring", () => {
  let linked: string

  const git = async (cwd: string, args: string[]) => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited
    if (proc.exitCode !== 0)
      throw new Error(
        `git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`,
      )
  }

  const setUpWorktree = async () => {
    linked = path.join(sandboxRoot, "linked")
    await git(root, ["init", "--quiet"])
    await git(root, [
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=test",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "init",
    ])
    await git(root, ["worktree", "add", "--quiet", linked])
  }

  const linkedStoreFile = () => permissionStoreFile(configDir, linked)

  test("unknown options are warned about and ignored", async () => {
    const { client, logs, replies } = makeClient()
    const hooks = await load(client, root, undefined, { junk: true })
    const warnings = logs
      .filter((entry) => entry.body.level === "warn")
      .map((entry) => entry.body.message)
    expect(
      warnings.some((message: string) =>
        message.includes('unknown option "junk"'),
      ),
    ).toBe(true)
    // Unknown keys do not pause anything: the store still answers.
    await fs.mkdir(path.dirname(storeFile()), { recursive: true })
    await fs.writeFile(
      storeFile(),
      JSON.stringify({ permission: { bash: { "git status *": "allow" } } }),
    )
    await hooks.event!(asked())
    expect(replies).toHaveLength(1)
  })

  test("an invalid scope warns and pauses persistence instead of defaulting", async () => {
    // Defaulting to "repository" here is what would let this half migrate
    // away — and delete — a store a correctly-configured "worktree" half is
    // actively using. Only an absent option may default.
    const { client, logs, replies, toasts } = makeClient()
    const hooks = await load(client, root, undefined, { scope: "bogus" })
    const warnings = logs
      .filter((entry) => entry.body.level === "warn")
      .map((entry) => entry.body.message)
    expect(
      warnings.some((message: string) =>
        message.includes('"scope" must be "repository" or "worktree"'),
      ),
    ).toBe(true)
    await fs.mkdir(path.dirname(storeFile()), { recursive: true })
    await fs.writeFile(
      storeFile(),
      JSON.stringify({ permission: { bash: { "git status *": "allow" } } }),
    )
    // Fail closed both ways: no auto-approval from the store...
    await hooks.event!(asked())
    expect(replies).toHaveLength(0)
    // ...and no persistence of fresh approvals.
    await hooks.event!(
      asked({ patterns: ["npm test"], always: ["npm test *"] }),
    )
    await hooks.event!(replied("always"))
    expect(await readJson(storeFile())).toEqual({
      permission: { bash: { "git status *": "allow" } },
    })
    expect(
      toasts.some((toast) => String(toast.body.message).includes("paused")),
    ).toBe(true)
  })

  test("a pure-allow worktree store merges on first access, with one info toast", async () => {
    await setUpWorktree()
    await fs.writeFile(
      linkedStoreFile(),
      JSON.stringify({ permission: { bash: { "git status *": "allow" } } }),
    )
    const { client, replies, toasts } = makeClient()
    const hooks = await load(client, linked)

    await hooks.event!(asked())
    expect(replies).toHaveLength(1)
    expect(replies[0].body.response).toBe("once")
    const infoToasts = toasts.filter((toast) => toast.body.variant === "info")
    expect(infoToasts).toHaveLength(1)
    expect(infoToasts[0].body.message).toContain("Moved 1 saved approval(s)")
    expect(await readJson(storeFile())).toEqual({
      permission: { bash: { "git status *": "allow" } },
    })
    await expect(fs.access(linkedStoreFile())).rejects.toThrow()
  })

  test("a source that merges but cannot be deleted warns and retries the removal", async () => {
    // chmod is a no-op for uid 0, so removal would still succeed as root and
    // the unremoved outcome could never be produced this way.
    if (process.getuid?.() === 0) return
    await setUpWorktree()

    // The worktree store and the shared store both live in the same
    // configDir/persist-permissions/projects/ directory, so the migration's
    // lock file and the shared write share it too: chmod-ing THAT directory
    // read-only pauses the whole pass (lock acquisition fails) instead of
    // failing only the removal. Relocate the source into its own directory —
    // still inside configDir, so the trust check passes — behind a symlink the
    // resolver canonicalizes, then make only that directory unwritable. Now the
    // read and the shared write still succeed and only the unlink fails: the
    // ok-but-unremoved outcome this test is about.
    const sourceDir = path.join(configDir, "worktree-source")
    await fs.mkdir(sourceDir, { recursive: true })
    const sourceStore = path.join(sourceDir, "worktree.json")
    await fs.writeFile(
      sourceStore,
      JSON.stringify({ permission: { bash: { "git status *": "allow" } } }),
    )
    await fs.mkdir(path.dirname(linkedStoreFile()), { recursive: true })
    await fs.symlink(sourceStore, linkedStoreFile())
    // r-x: the migration can still READ the source, but cannot unlink it.
    await fs.chmod(sourceDir, 0o555)
    try {
      const { client, replies, toasts } = makeClient()
      const hooks = await load(client, linked)

      await hooks.event!(asked())

      // The shared store gained the merged rule and auto-approval fired:
      // persistence stays correct even though the pass is not finished.
      expect(replies).toHaveLength(1)
      expect(await readJson(storeFile())).toEqual({
        permission: { bash: { "git status *": "allow" } },
      })
      // The stale source is still on disk (its removal failed) ...
      await fs.access(sourceStore)
      // ... and the user was warned it could not be deleted, naming the file.
      const warnings = toasts.filter(
        (toast) => toast.body.variant === "warning",
      )
      expect(warnings).toHaveLength(1)
      expect(warnings[0].body.message).toContain("could not be deleted")
      expect(warnings[0].body.message).toContain(sourceStore)

      // The retry contract: because the migration reported retry, the memo was
      // cleared, so the next access re-runs the pass. Restore write permission,
      // fire a second event — the source is removed and completion reported.
      await fs.chmod(sourceDir, 0o755)
      await hooks.event!(asked({ id: "per_2" }))
      await expect(fs.access(sourceStore)).rejects.toThrow()
      const infoToasts = toasts.filter((toast) => toast.body.variant === "info")
      expect(
        infoToasts.some((toast) =>
          String(toast.body.message).includes("migration is complete"),
        ),
      ).toBe(true)
    } finally {
      // Restore perms even on an early assertion failure, so afterEach can
      // remove the sandbox instead of hitting EACCES on the read-only dir.
      await fs.chmod(sourceDir, 0o755).catch(() => {})
    }
  })

  test("a worktree store with carve-outs pauses persistence until it is removed", async () => {
    await setUpWorktree()
    await fs.writeFile(
      linkedStoreFile(),
      JSON.stringify({
        permission: { bash: { "git status *": "allow", "git push *": "ask" } },
      }),
    )
    const { client, replies, toasts } = makeClient()
    const hooks = await load(client, linked)

    // The worktree store would have re-approved this, but the pause must win:
    // auto-approving from the shared store while the carve-outs sit unmerged
    // would drop the narrower rules the user wrote.
    await hooks.event!(asked())
    expect(replies).toHaveLength(0)
    const warnings = toasts.filter((toast) => toast.body.variant === "warning")
    expect(warnings).toHaveLength(1)
    expect(warnings[0].body.message).toContain("paused for this worktree")
    expect(warnings[0].body.message).toContain("git push *")
    expect(warnings[0].body.message).toContain(storeFile())

    // Nothing persists while paused either.
    await hooks.event!(replied("always"))
    await expect(fs.access(storeFile())).rejects.toThrow()

    // The user reviews and removes the old store: the next event unpauses
    // without a restart and the approval persists into the shared store.
    await fs.rm(linkedStoreFile())
    await hooks.event!(asked({ id: "per_2" }))
    await hooks.event!(replied("always", "per_2"))
    expect(await readJson(storeFile())).toEqual({
      permission: { bash: { "git status *": "allow" } },
    })
  })

  test("an unreachable shared store stops auto-approval but not saving", async () => {
    // Git confirms a repository here, but the primary worktree root cannot be
    // established, so the session is keyed by a narrower fallback while a
    // repository-shared store exists and is unreadable. Answering prompts from
    // the fallback would auto-approve straight through any ask/deny carve-out
    // the user wrote into the shared store — the two files are independent
    // last-match-wins rulesets, so "shares less" is only safe for WRITES.
    await setUpWorktree()
    const nested = path.join(linked, "packages", "app")
    await fs.mkdir(nested, { recursive: true })
    // The host names the nested directory, so the primary probe's self-check
    // fails while git still places the session inside a work tree.
    await fs.writeFile(
      permissionStoreFile(configDir, nested),
      JSON.stringify({ permission: { bash: { "git status *": "allow" } } }),
    )
    const { client, replies, toasts } = makeClient()
    const hooks = await load(client, nested)

    await hooks.event!(asked())
    expect(replies).toHaveLength(0)
    const warnings = toasts.filter((toast) => toast.body.variant === "warning")
    expect(warnings).toHaveLength(1)
    expect(warnings[0].body.message).toContain("Auto-approval is paused")

    // The legacy pre-prompt hook fails closed on the same read.
    const output = { status: "ask" as "ask" | "deny" | "allow" }
    await hooks["permission.ask"]!(
      {
        id: "per_9",
        sessionID: "ses_1",
        type: "bash",
        pattern: "git status",
      } as any,
      output,
    )
    expect(output.status).toBe("ask")

    // Saving still works: the fallback store only ever shares LESS, and a
    // later re-key folds it into the shared store.
    await hooks.event!(replied("always"))
    expect(await readJson(permissionStoreFile(configDir, nested))).toEqual({
      permission: { bash: { "git status *": "allow" } },
    })
  })

  test("the primary checkout itself never migrates or re-keys", async () => {
    await setUpWorktree()
    const { client, toasts } = makeClient()
    const hooks = await load(client, root)

    await hooks.event!(asked())
    await hooks.event!(replied("always"))
    expect(await readJson(storeFile())).toEqual({
      permission: { bash: { "git status *": "allow" } },
    })
    expect(
      toasts.filter((toast) => toast.body.variant === "info"),
    ).toHaveLength(0)
  })

  test("a config dir inside the project pauses instead of writing trust data into it", async () => {
    // createStoreKeyingResolver REFUSES (returns undefined, never null) when the
    // derived store path would sit inside the agent-writable project — the last
    // guard before the plugin reads or writes trust data outside OpenCode's
    // config dir. The client's path lookup is the config source, so pointing it
    // at <root>/.config forces the refusal deterministically.
    const unsafeConfig = path.join(root, ".config")
    const unsafeStoreFile = permissionStoreFile(unsafeConfig, root)
    const { client, replies, toasts, logs } = makeClient()
    ;(client as any).path = {
      get: () =>
        Promise.resolve({ data: { config: unsafeConfig, state: stateDir } }),
    }
    const hooks = await load(client)

    // No auto-approval, and an 'always' reply persists nothing anywhere.
    await hooks.event!(asked())
    await hooks.event!(replied("always"))
    expect(replies).toHaveLength(0)
    await expect(fs.access(unsafeStoreFile)).rejects.toThrow()
    await expect(fs.access(storeFile())).rejects.toThrow()

    // Exactly one warning naming the distrust — the pause warns once, so the
    // write half of the same event and a fresh prompt do not stack duplicates.
    const notTrusted = toasts.filter(
      (toast) =>
        toast.body.variant === "warning" &&
        String(toast.body.message).includes("not trusted"),
    )
    expect(notTrusted).toHaveLength(1)
    expect(
      logs.filter(
        (entry) =>
          entry.body.level === "warn" &&
          String(entry.body.message).includes("not trusted"),
      ),
    ).toHaveLength(1)

    await hooks.event!(asked({ id: "per_2" }))
    expect(replies).toHaveLength(0)
    expect(
      toasts.filter(
        (toast) =>
          toast.body.variant === "warning" &&
          String(toast.body.message).includes("not trusted"),
      ),
    ).toHaveLength(1)
  })
})

describe("v1 event shapes (server-half canonical)", () => {
  function updated(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      event: { ...asked(overrides).event, type: "permission.updated" },
    } as any
  }

  function repliedV1(response: string, id = "per_1") {
    return {
      event: {
        type: "permission.replied",
        properties: { sessionID: "ses_1", permissionID: id, response },
      },
    } as any
  }

  test("permission.updated reaches the auto-reply path", async () => {
    await fs.writeFile(
      storeFile(),
      JSON.stringify({ permission: { bash: { "git status *": "allow" } } }),
    )
    const { client, replies } = makeClient()
    const hooks = await load(client)

    await hooks.event!(updated())

    expect(replies).toHaveLength(1)
    expect(replies[0].path).toEqual({ id: "ses_1", permissionID: "per_1" })
    expect(replies[0].body).toEqual({ response: "once" })
  })

  test("a permissionID/response 'always' reply persists the rule", async () => {
    const { client } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked())
    await hooks.event!(repliedV1("always"))

    expect(await readJson(storeFile())).toEqual({
      permission: { bash: { "git status *": "allow" } },
    })
  })

  test("a permissionID/response 'once' reply persists nothing", async () => {
    const { client } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked())
    await hooks.event!(repliedV1("once"))

    await expect(fs.access(storeFile())).rejects.toThrow()
  })
})

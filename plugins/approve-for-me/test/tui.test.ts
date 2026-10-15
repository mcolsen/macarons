import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFilesystemLocalityResponder } from "@macarons/permission-rules"
import type { Plugin } from "@opencode/plugin/tui"
import type { KeymapLayer, SlotClaim } from "@opencode/plugin/tui/context"
import { type ApprovalSnapshot, rpcDefinition } from "../src/rpc"
import {
  ACTIVITY_REASON_MAX,
  parseVerdict,
  readBlessing,
  readOverride,
  readTrustedSessionModel,
  resolveSettings,
  resolveTrustedSettingsPaths,
  settingsLocalityPaths,
  TRUNCATE_SUFFIX,
} from "../src/shared"
import tui, { feedItems, statusLabel } from "../src/tui"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function harness(options: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "macarons-afm-ui-v2-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const project = join(root, "project")
  const config = join(root, "config")
  const state = join(root, "state")
  for (const dir of [project, config, state])
    await mkdir(dir, { recursive: true })
  const instanceID = randomUUID()
  const paths = await resolveTrustedSettingsPaths(
    project,
    config,
    state,
    join(root, "data"),
    instanceID,
  )
  if (!paths) throw new Error("fixture paths not trusted")
  const roots = await settingsLocalityPaths(paths)
  if (!roots) throw new Error("fixture locality paths not resolved")
  for (const dir of roots) await mkdir(dir, { recursive: true })
  await writeFile(
    join(config, "opencode.jsonc"),
    '{\n// preserved\n"plugins":[{"package":"@macarons/approve-for-me","options":{}}]\n}',
  )
  const snapshot: ApprovalSnapshot = {
    instanceID,
    directory: project,
    projectRoot: project,
    configRoot: project,
    paths,
    enabled: true,
    settings: resolveSettings({}),
    server: { state: "ready", time: Date.now() },
    requests: {},
  }
  const locality = createFilesystemLocalityResponder({
    service: "permissions-approve-for-me",
    paths: async () => roots,
  })
  cleanups.push(() => locality.dispose())
  const commands = new Map<
    string,
    NonNullable<KeymapLayer["commands"]>[number]
  >()
  const slots: SlotClaim[] = []
  const toasts: Array<{ message: string; variant?: string }> = []
  const calls: string[] = []
  const answers: unknown[] = []
  const handlers = new Map<string, (event: unknown) => void>()
  let beforeSelect: (() => void | Promise<void>) | undefined
  let shared = true
  const location = { directory: project }
  const context = {
    options,
    location,
    client: {
      rpc: (definition: unknown) => {
        expect(definition).toBe(rpcDefinition)
        return {
          snapshot: async () => {
            calls.push("snapshot")
            return {
              ...snapshot,
              enabled:
                (await readOverride(paths.overridePath))?.enabled ??
                snapshot.enabled,
            }
          },
          locality: async ({ command }: { command: string }) => {
            calls.push("locality")
            if (!shared) throw new Error("different filesystem")
            return { handled: await locality.handle(command) }
          },
        }
      },
    },
    data: {
      session: {
        get: (id: string) => ({ id, location }),
        root: (id: string) => id,
        family: (id: string) => [id],
        permission: { list: () => [] },
      },
      location: {
        default: () => location,
        model: {
          sync: async () => {},
          list: () => [
            {
              id: "model",
              providerID: "test",
              name: "Test model",
              enabled: true,
              variants: [{ id: "high" }],
            },
          ],
        },
      },
      on: (name: string, handler: (event: unknown) => void) => {
        handlers.set(name, handler)
        return () => {
          handlers.delete(name)
        }
      },
    },
    keymap: {
      layer: (factory: () => KeymapLayer) => {
        for (const command of factory().commands ?? [])
          if (command.id) commands.set(command.id, command)
      },
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "ses_root" }) },
      toast: {
        show: (toast: { message: string; variant?: string }) =>
          toasts.push(toast),
      },
      dialog: {
        select: async () => {
          await beforeSelect?.()
          beforeSelect = undefined
          return answers.shift()
        },
        confirm: async () => answers.shift(),
      },
      slot: (slot: SlotClaim) => {
        slots.push(slot)
        return () => {
          slots.splice(slots.indexOf(slot), 1)
        }
      },
    },
  }
  const cleanup = await tui.setup(context as unknown as Plugin.Context)
  if (cleanup) cleanups.push(cleanup)
  const run = async (name: string) => {
    const command = commands.get(`permissions_approve_for_me.${name}`)
    if (!command) throw new Error("missing command")
    await command.run()
  }
  return {
    root,
    paths,
    snapshot,
    commands,
    slots,
    toasts,
    calls,
    answers,
    handlers,
    run,
    setShared: (value: boolean) => {
      shared = value
    },
    beforeSelect: (callback: () => void | Promise<void>) => {
      beforeSelect = callback
    },
  }
}

describe("native V2 approval controls", () => {
  test("registers stable palette IDs, native slot, and configurable bindings", async () => {
    const host = await harness({ keybind: false })
    expect(host.commands.size).toBe(5)
    expect(host.commands.get("permissions_approve_for_me.toggle")?.bind).toBe(
      false,
    )
    expect(host.slots[0]).toMatchObject({ append: "sidebar.content" })
    expect(host.handlers.has("permission.asked")).toBe(true)
  })
  test("instance toggle requires a fresh filesystem proof and writes only the trusted override", async () => {
    const host = await harness()
    await host.run("toggle")
    expect((await readOverride(host.paths.overridePath))?.enabled).toBe(false)
    expect(host.calls.filter((call) => call === "locality").length).toBe(3)
    expect(Object.keys(rpcDefinition.methods)).toEqual([
      "snapshot",
      "classifierProvider",
      "locality",
    ])
  })
  test("unshared attaches can observe status but cannot modify policy", async () => {
    const host = await harness()
    host.setShared(false)
    await host.run("toggle")
    expect(await readOverride(host.paths.overridePath)).toBeUndefined()
    expect(host.toasts.at(-1)?.message).toContain("verified shared filesystem")
  })
  test("model and variant picker writes the project policy", async () => {
    const host = await harness()
    host.answers.push("project", "test/model", "high")
    await host.run("model")
    expect(
      JSON.parse(await readFile(host.paths.projectSettingsFile, "utf8")),
    ).toEqual({ model: "test/model", variant: "high" })
  })
  test("session model uses a trusted record outside the project", async () => {
    const host = await harness()
    host.answers.push("session", "test/model", "high")
    await host.run("model")
    expect(
      await readTrustedSessionModel(host.paths.sessionModelsDir, "ses_root"),
    ).toMatchObject({
      status: "valid",
      record: { model: "test/model", variant: "high" },
    })
  })
  test("global default patches V2 options while retaining JSONC comments", async () => {
    const host = await harness()
    host.answers.push(false, "global")
    await host.run("default")
    const text = await readFile(
      join(host.paths.configDir, "opencode.jsonc"),
      "utf8",
    )
    expect(text).toContain("// preserved")
    expect(text).toMatch(/"enabled": false/)
    expect(text).toContain('"plugins"')
  })
  test("server replacement while a dialog is open prevents a stale write", async () => {
    const host = await harness()
    host.answers.push(60_000, "project")
    host.beforeSelect(() => {
      host.snapshot.instanceID = randomUUID()
    })
    await host.run("timeout")
    await expect(readFile(host.paths.projectSettingsFile)).rejects.toThrow()
    expect(host.toasts.at(-1)?.message).toContain("server changed")
  })
  test("symlink drift into the project while a dialog is open prevents a write", async () => {
    const host = await harness()
    const target = join(host.snapshot.projectRoot, "untrusted.json")
    await writeFile(target, "{}")
    host.answers.push(60_000, "project")
    host.beforeSelect(async () => {
      await mkdir(join(host.paths.projectSettingsFile, ".."), {
        recursive: true,
      })
      await symlink(target, host.paths.projectSettingsFile)
    })
    await host.run("timeout")
    expect(await readFile(target, "utf8")).toBe("{}")
    expect(host.toasts.at(-1)?.message).toContain("not trusted")
  })
  test("trust records only reviewed hashes and can be revoked", async () => {
    const host = await harness()
    const file = join(host.snapshot.projectRoot, "opencode.jsonc")
    await writeFile(
      file,
      JSON.stringify({
        plugins: [
          { package: "@macarons/approve-for-me", options: { enabled: false } },
        ],
      }),
    )
    host.answers.push("trust", true)
    await host.run("trust")
    expect(
      Object.keys((await readBlessing(host.paths.blessPath))?.files ?? {}),
    ).toEqual([file])
    host.answers.push("revoke")
    await host.run("trust")
    expect((await readBlessing(host.paths.blessPath))?.files).toEqual({})
  })
})
describe("statusLabel", () => {
  const on = {
    override: undefined,
    defaultEnabled: true,
    model: "session model",
  }

  test("the full matrix — the content line under the bold header", () => {
    expect(
      statusLabel({
        pauseReason: "settings unreadable",
        server: "ready",
        ...on,
      }),
    ).toBe("paused · settings unreadable")
    expect(
      statusLabel({
        pauseReason: "settings migration required",
        server: "ready",
        ...on,
      }),
    ).toBe("paused · settings migration required")
    expect(statusLabel({ server: "ready", ...on })).toBe("on · session model")
    expect(statusLabel({ server: "ready", ...on, defaultEnabled: false })).toBe(
      "off",
    )
    expect(statusLabel({ server: "ready", ...on, override: false })).toBe(
      "off (this instance)",
    )
    expect(
      statusLabel({
        server: "ready",
        ...on,
        override: false,
        defaultEnabled: false,
      }),
    ).toBe("off")
    expect(
      statusLabel({
        server: "ready",
        override: true,
        defaultEnabled: false,
        model: "a/b",
      }),
    ).toBe("on (this instance) · a/b")
    expect(
      statusLabel({
        server: "ready",
        override: true,
        defaultEnabled: true,
        model: "a/b",
      }),
    ).toBe("on · a/b")
  })

  test('"on" requires a ready server — a paused or absent one shows as paused, not on', () => {
    // The whole point of the beacon: the settings saying "on" while the
    // server half approves nothing must never render as "on".
    expect(
      statusLabel({
        server: "paused",
        serverReason: "the permission store is unreadable or invalid JSON",
        ...on,
      }),
    ).toBe("paused · the permission store is unreadable or invalid JSON")
    expect(statusLabel({ server: "paused", ...on })).toBe(
      "paused · server fault",
    )
    expect(statusLabel({ server: "missing", ...on })).toBe(
      "paused · server half not running",
    )
    expect(statusLabel({ server: "starting", ...on })).toBe("starting…")
  })

  test("off outranks a server fault — off is what the user chose", () => {
    expect(
      statusLabel({
        server: "paused",
        serverReason: "x",
        ...on,
        override: false,
      }),
    ).toBe("off (this instance)")
    expect(
      statusLabel({ server: "missing", ...on, defaultEnabled: false }),
    ).toBe("off")
    // But a TUI-side pause outranks off: with unsafe paths nothing is known.
    expect(
      statusLabel({
        pauseReason: "settings path unsafe",
        server: "missing",
        ...on,
        defaultEnabled: false,
      }),
    ).toBe("paused · settings path unsafe")
  })
})

describe("the activity stream", () => {
  const pending = (
    id: string,
    permission = "bash",
    patterns = ["git status --short"],
  ) => ({
    id,
    permission,
    patterns,
  })

  test("an unannotated pending prompt is simply waiting", () => {
    const { lines, hiddenPending } = feedItems({
      pending: [pending("per_1")],
      settled: [],
      activity: {},
    })
    expect(lines).toEqual([
      { marker: "·", tone: "muted", text: "bash: git status --short" },
    ])
    expect(hiddenPending).toBe(0)
  })

  test("evaluating — and an approval whose reply is still in flight — show the classifier at work", () => {
    const activity = {
      per_1: { state: "evaluating" as const, reason: "e2e/test", time: 1 },
      per_2: { state: "approved" as const, time: 2 },
    }
    const { lines } = feedItems({
      pending: [pending("per_1"), pending("per_2", "edit", ["a.ts"])],
      settled: [],
      activity,
    })
    expect(lines[0]).toEqual({
      marker: "⋯",
      tone: "info",
      text: "bash: git status --short",
    })
    expect(lines[1]).toEqual({ marker: "⋯", tone: "info", text: "edit: a.ts" })
  })

  test("surfaced, undecided, and skipped prompts persist as needs-you with the cause", () => {
    const activity = {
      per_1: {
        state: "surfaced" as const,
        reason: "pushes to a remote",
        time: 1,
      },
      per_2: {
        state: "undecided" as const,
        reason: "could not evaluate — no verdict within 90s",
        time: 2,
      },
      per_3: { state: "skipped" as const, time: 3 },
    }
    const { lines } = feedItems({
      pending: [pending("per_1"), pending("per_2"), pending("per_3")],
      settled: [],
      activity,
    })
    expect(lines[0]).toEqual({
      marker: "!",
      tone: "warning",
      text: "bash: git status --short",
      reason: "pushes to a remote",
    })
    expect(lines[1]!.reason).toBe("could not evaluate — no verdict within 90s")
    expect(lines[2]).toEqual({
      marker: "!",
      tone: "warning",
      text: "bash: git status --short",
    })
  })

  test("settled items: classifier approvals in success, the user's own answers muted", () => {
    const activity = { per_1: { state: "approved" as const, time: 1 } }
    const { lines } = feedItems({
      pending: [],
      settled: [
        { ...pending("per_1"), reply: "once" },
        { ...pending("per_2", "edit", ["a.ts"]), reply: "always" },
        {
          ...pending("per_3", "webfetch", ["https://example.com"]),
          reply: "reject",
        },
      ],
      activity,
    })
    // Only the two most recent settled items render.
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({ marker: "✓", tone: "muted", text: "edit: a.ts" })
    expect(lines[1]).toEqual({
      marker: "✗",
      tone: "muted",
      text: "webfetch: https://example.com",
    })

    const classifier = feedItems({
      pending: [],
      settled: [{ ...pending("per_1"), reply: "once" }],
      activity,
    })
    expect(classifier.lines[0]).toEqual({
      marker: "✓",
      tone: "success",
      text: "bash: git status --short",
    })
  })

  test("a live deny deadline rides the end of the needs-you reason", () => {
    const activity = {
      per_1: {
        state: "surfaced" as const,
        reason: "pushes to a remote",
        time: 1,
        denyAt: 840_000,
      },
      per_2: {
        state: "undecided" as const,
        reason: "y".repeat(80),
        time: 2,
        denyAt: 30_000,
      },
      per_3: {
        state: "surfaced" as const,
        reason: "pushes to a remote",
        time: 3,
        denyAt: 100,
      },
    }
    const { lines } = feedItems({
      pending: [pending("per_1"), pending("per_2"), pending("per_3")],
      settled: [],
      activity,
      now: 0,
    })
    expect(lines[0]!.reason).toBe("pushes to a remote · deny in 14m")
    // A long reason keeps its full text (the renderer wraps it) with the
    // countdown still at its end.
    expect(lines[1]!.reason).toBe(`${"y".repeat(80)} · deny in <1m`)
    // Sub-minute deadlines are coarse, expired ones (or no clock) vanish.
    expect(lines[2]!.reason).toBe("pushes to a remote · deny in <1m")
    const expired = feedItems({
      pending: [pending("per_1")],
      settled: [],
      activity,
      now: 840_000,
    })
    expect(expired.lines[0]!.reason).toBe("pushes to a remote")
    const clockless = feedItems({
      pending: [pending("per_1")],
      settled: [],
      activity,
    })
    expect(clockless.lines[0]!.reason).toBe("pushes to a remote")
  })

  test("a deny in flight shows the classifier at work; a settled timed deny explains itself", () => {
    const activity = {
      per_1: {
        state: "denied" as const,
        reason: "no answer for 20 min — denied so the run can move on",
        time: 1,
      },
    }
    const stillPending = feedItems({
      pending: [pending("per_1")],
      settled: [],
      activity,
    })
    expect(stillPending.lines[0]).toEqual({
      marker: "⋯",
      tone: "info",
      text: "bash: git status --short",
    })
    const settled = feedItems({
      pending: [],
      settled: [{ ...pending("per_1"), reply: "reject" }],
      activity,
    })
    expect(settled.lines[0]!.marker).toBe("✗")
    expect(settled.lines[0]!.tone).toBe("muted")
    // The explanation keeps its full text — the renderer wraps it instead of
    // clipping it to one sidebar line.
    expect(settled.lines[0]!.reason).toBe(
      "no answer for 20 min — denied so the run can move on",
    )
    // A user's own reject stays a bare exit line.
    const userReject = feedItems({
      pending: [],
      settled: [{ ...pending("per_2"), reply: "reject" }],
      activity,
    })
    expect(userReject.lines[0]).toEqual({
      marker: "✗",
      tone: "muted",
      text: "bash: git status --short",
    })
  })

  test("pending overflow is counted, never silently dropped", () => {
    const many = Array.from({ length: 6 }, (_, i) => pending(`per_${i}`))
    const { lines, hiddenPending } = feedItems({
      pending: many,
      settled: [],
      activity: {},
    })
    expect(lines).toHaveLength(4)
    expect(hiddenPending).toBe(2)
  })

  test("headlines clip to one sidebar line; explanations render in full", () => {
    const long = pending("per_1", "bash", [`git commit -m "${"x".repeat(80)}"`])
    const activity = {
      per_1: { state: "surfaced" as const, reason: "y".repeat(80), time: 1 },
    }
    const { lines } = feedItems({ pending: [long], settled: [], activity })
    expect(lines[0]!.text.length).toBeLessThanOrEqual(44)
    expect(lines[0]!.text.endsWith("…")).toBe(true)
    // The why is what the user weighs before answering — never truncated.
    expect(lines[0]!.reason).toBe("y".repeat(80))
  })

  test("explanations at every valid producer bound render in full", () => {
    // The real producer path: parseVerdict keeps 300 chars of the model's
    // reason and appends its explicit suffix. The feed must not re-clip that
    // to a bare ellipsis — the tail is the marker that truncation already
    // happened.
    const verdict = parseVerdict({
      decision: "surface",
      risk: "critical",
      authorization: "none",
      reason: "r".repeat(400),
    })!
    expect(verdict.reason).toBe(`${"r".repeat(300)}${TRUNCATE_SUFFIX}`)
    // A matrix-overridden model approve is the longest valid annotation:
    // the assessment prefixed onto that already-suffixed reason.
    const annotation = `critical risk, no user assent — ${verdict.reason}`
    const activity = {
      per_1: { state: "surfaced" as const, reason: verdict.reason, time: 1 },
      per_2: { state: "surfaced" as const, reason: annotation, time: 2 },
    }
    const { lines } = feedItems({
      pending: [pending("per_1"), pending("per_2")],
      settled: [],
      activity,
    })
    expect(lines[0]!.reason).toBe(verdict.reason)
    expect(lines[1]!.reason).toBe(annotation)
  })

  test("explanations are bounded only against a corrupt file", () => {
    // Legitimate reasons never reach this cap: the server half normalizes
    // every recorded reason to ACTIVITY_REASON_MAX, and the cap passes any
    // normalized value. Only a corrupt activity file can exceed it.
    const cap = ACTIVITY_REASON_MAX + TRUNCATE_SUFFIX.length
    const activity = {
      per_1: { state: "denied" as const, reason: "z".repeat(600), time: 1 },
      per_2: {
        state: "surfaced" as const,
        reason: "z".repeat(600),
        time: 2,
        denyAt: 840_000,
      },
    }
    const rejected = feedItems({
      pending: [],
      settled: [{ ...pending("per_1"), reply: "reject" }],
      activity,
    })
    expect(rejected.lines[0]!.reason?.length).toBe(cap)
    expect(rejected.lines[0]!.reason?.endsWith("…")).toBe(true)
    // On a needs-you line the countdown rides after the cap, so even a
    // cap-length reason never hides it.
    const surfaced = feedItems({
      pending: [pending("per_2")],
      settled: [],
      activity,
      now: 0,
    })
    expect(surfaced.lines[0]!.reason?.length).toBe(
      cap + " · deny in 14m".length,
    )
    expect(surfaced.lines[0]!.reason?.endsWith("… · deny in 14m")).toBe(true)
  })
})

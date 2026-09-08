import { describe, expect, test } from "bun:test"
import {
  BAND_SAMPLE_VERSIONS as BAND,
  evaluate,
} from "@macarons/permission-rules"
import type { PermissionRuleset } from "@opencode-ai/sdk/v2"
import {
  DEFAULT_KEYBIND,
  DEFAULT_TIMEOUT_MS,
  forkBoundary,
  isGuardedEnvPath,
  MARKER_KEY,
  type MessageInfoLike,
  markerFor,
  markerOf,
  mintSidePromptMessageID,
  openCodeCompatNotice,
  promptTarget,
  READ_ONLY_TOOL_IDS,
  resolveOptions,
  SUPPORTED_OPENCODE_RANGE,
  sideQuestionRules,
  sideSessionTitle,
  trim,
  wrapQuestion,
} from "../src/shared"

describe("mintSidePromptMessageID", () => {
  test("moves past same-ms fork copies while leaving the next host counter above it", async () => {
    let now = 1_700_000_000_000
    let waits = 0
    const hostID = (counter: number) => {
      const stamp = ((BigInt(now) << 12n) | BigInt(counter)) & 0xffffffffffffn
      return `msg_${stamp.toString(16).padStart(12, "0")}${"z".repeat(14)}`
    }
    const copied = hostID(7)

    const prompt = await mintSidePromptMessageID(copied, {
      now: () => now,
      waitForNextMs: async () => {
        waits++
        now++
      },
    })

    expect(waits).toBe(1)
    expect(prompt > copied).toBe(true)
    expect(Number.parseInt(prompt.slice(13, 16), 16)).toBe(0)
    expect(prompt < hostID(1)).toBe(true)
  })
})

describe("openCodeCompatNotice", () => {
  const R = SUPPORTED_OPENCODE_RANGE
  // Supported: inside the verified band — no notice. Samples derive from the
  // band so the nightly ratchet cannot strand them.
  for (const version of [BAND.floor, BAND.inBand, `${BAND.floor}+build`]) {
    test(`${version} is supported (no notice)`, () =>
      expect(openCodeCompatNotice(version, R, "btw")).toBeNull())
  }
  // Untested v1: older, a newer minor (1.19+), a prerelease, or an unreadable
  // version — warn but keep running (fail open).
  for (const version of [
    BAND.belowBand,
    "1.16.99",
    BAND.aboveBand,
    `${BAND.floor}-beta.1`,
    "not-a-version",
    "",
    undefined,
    1.17,
  ]) {
    test(`${String(version)} is untested (warn, run)`, () => {
      const notice = openCodeCompatNotice(
        version as string | undefined,
        R,
        "btw",
      )
      expect(notice?.compat).toBe("untested")
      expect(notice?.disable).toBe(false)
    })
  }
  // Not OpenCode v1 (incl. a v2 beta) — disable.
  for (const version of ["2.0.0", "2.0.0-beta.1", "0.9.9", "3.1.0"]) {
    test(`${version} is incompatible (disable)`, () => {
      const notice = openCodeCompatNotice(version, R, "btw")
      expect(notice?.compat).toBe("incompatible")
      expect(notice?.disable).toBe(true)
    })
  }
})

describe("resolveOptions", () => {
  test("defaults", () => {
    const options = resolveOptions(undefined)
    expect(options.keybind).toBe(DEFAULT_KEYBIND)
    expect(options.notify).toBe(true)
    expect(options.tools).toBe("read-only")
    expect(options.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(options.keepSessions).toBe(false)
    expect(options.model).toBeUndefined()
    expect(options.variant).toBeUndefined()
  })

  test('keybind can be disabled with false or "none"', () => {
    expect(resolveOptions({ keybind: false }).keybind).toBeUndefined()
    expect(resolveOptions({ keybind: "none" }).keybind).toBeUndefined()
    expect(resolveOptions({ keybind: "ctrl+b" }).keybind).toBe("ctrl+b")
  })

  test("model parses provider/model, ignoring malformed values", () => {
    expect(
      resolveOptions({ model: "anthropic/claude-sonnet-5" }).model,
    ).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-5",
    })
    for (const bad of ["noslash", "/leading", "trailing/", "", 42]) {
      expect(resolveOptions({ model: bad }).model).toBeUndefined()
    }
  })

  test("tools only accepts none as an override, else read-only", () => {
    expect(resolveOptions({ tools: "none" }).tools).toBe("none")
    expect(resolveOptions({ tools: "anything-else" }).tools).toBe("read-only")
  })

  test("timeoutMs rejects non-positive and non-finite values", () => {
    expect(resolveOptions({ timeoutMs: 5000 }).timeoutMs).toBe(5000)
    expect(resolveOptions({ timeoutMs: 0 }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(resolveOptions({ timeoutMs: -1 }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(
      resolveOptions({ timeoutMs: Number.POSITIVE_INFINITY }).timeoutMs,
    ).toBe(DEFAULT_TIMEOUT_MS)
  })
})

const msg = (
  id: string,
  role: "user" | "assistant",
  completed?: number,
): MessageInfoLike => ({
  id,
  role,
  time: { created: 1, ...(completed !== undefined ? { completed } : {}) },
})

describe("forkBoundary", () => {
  test("empty session has no context and no boundary", () => {
    expect(forkBoundary([])).toEqual({
      messageID: undefined,
      hasContext: false,
    })
  })

  test("all turns complete: copy everything, no cut point", () => {
    const infos = [msg("msg_01", "user"), msg("msg_02", "assistant", 9)]
    expect(forkBoundary(infos)).toEqual({
      messageID: undefined,
      hasContext: true,
    })
  })

  test("mid-turn: cut at the in-flight assistant, keeping the turn that started it", () => {
    const infos = [
      msg("msg_01", "user"),
      msg("msg_02", "assistant", 9),
      msg("msg_03", "user"),
      msg("msg_04", "assistant"), // in-flight (no completed)
    ]
    expect(forkBoundary(infos)).toEqual({
      messageID: "msg_04",
      hasContext: true,
    })
  })

  test("queued messages behind the running turn are excluded by the cut", () => {
    const infos = [
      msg("msg_01", "user"),
      msg("msg_02", "assistant"), // in-flight
      msg("msg_03", "user"), // queued behind it
    ]
    const boundary = forkBoundary(infos)
    expect(boundary.messageID).toBe("msg_02")
    // Only msg_01 is below the cut → that is the copied context.
    expect(
      infos
        .filter((info) => info.id < boundary.messageID!)
        .map((info) => info.id),
    ).toEqual(["msg_01"])
  })

  test("a lone in-flight first turn still has context (its user message)", () => {
    const infos = [msg("msg_01", "user"), msg("msg_02", "assistant")]
    expect(forkBoundary(infos)).toEqual({
      messageID: "msg_02",
      hasContext: true,
    })
  })

  test("a stale incomplete assistant mid-history (crash debris) is not the boundary", () => {
    // A hard-killed server never stamps time.completed on its in-flight
    // message, and nothing repairs it afterwards. Only the NEWEST assistant
    // may be treated as in-flight, or the fork silently loses every turn
    // after the crash.
    const infos = [
      msg("msg_01", "user"),
      msg("msg_02", "assistant"), // orphaned by a crash, never completed
      msg("msg_03", "user"),
      msg("msg_04", "assistant", 9),
    ]
    expect(forkBoundary(infos)).toEqual({
      messageID: undefined,
      hasContext: true,
    })
  })

  test("a stale incomplete assistant does not mask the genuinely in-flight turn", () => {
    const infos = [
      msg("msg_01", "user"),
      msg("msg_02", "assistant"), // crash debris
      msg("msg_03", "user"),
      msg("msg_04", "assistant", 9),
      msg("msg_05", "user"),
      msg("msg_06", "assistant"), // actually in-flight
    ]
    expect(forkBoundary(infos)).toEqual({
      messageID: "msg_06",
      hasContext: true,
    })
  })
})

describe("wrapQuestion", () => {
  test("wraps the question and marks it as an aside, not a task instruction", () => {
    const wrapped = wrapQuestion("  why backoff?  ", "read-only")
    expect(wrapped).toContain("<side-question>\nwhy backoff?\n</side-question>")
    expect(wrapped).toContain("NOT an instruction to continue the task")
    expect(wrapped).toContain("read-only tools")
  })

  test("tools:none forbids all tools", () => {
    expect(wrapQuestion("q", "none")).toContain("Do not use any tools")
  })
})

describe("sideQuestionRules", () => {
  const parent: PermissionRuleset = [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
  ]

  test("preserves effective read/glob policy, including wildcard names and ordered exceptions", () => {
    const inherited: PermissionRuleset = [
      ...parent,
      { permission: "*", pattern: "private/**", action: "deny" },
      { permission: "r?ad", pattern: "private/public.md", action: "allow" },
      { permission: "read", pattern: "review/**", action: "ask" },
      { permission: "g*", pattern: "**/*.pem", action: "deny" },
      { permission: "glob", pattern: "public/*.pem", action: "allow" },
      { permission: "read", pattern: "*.env.example", action: "deny" },
    ]
    const fork = sideQuestionRules("read-only", inherited)
    for (const [permission, pattern] of [
      ["read", "private/signing-key.pem"],
      ["read", "private/nested/signing-key.pem"],
      ["read", "private/public.md"],
      ["read", "review/draft.md"],
      ["read", ".env.example"],
      ["read", "src/main.ts"],
      ["glob", "private/**"],
      ["glob", "**/*.pem"],
      ["glob", "public/*.pem"],
    ] as const) {
      expect(evaluate(permission, pattern, fork)).toBe(
        evaluate(permission, pattern, inherited),
      )
    }
    expect(evaluate("edit", "private/public.md", fork)).toBe("ask")
    expect(evaluate("github_create_issue", "*", fork)).toBe("ask")
  })

  test("does not invent read/glob allows when the parent asks or denies everything", () => {
    for (const action of ["ask", "deny"] as const) {
      const fork = sideQuestionRules("read-only", [
        { permission: "*", pattern: "*", action },
      ])
      for (const permission of ["read", "glob"]) {
        expect(evaluate(permission, "private/key.pem", fork)).toBe(action)
      }
    }
    expect(
      evaluate("read", "src/main.ts", sideQuestionRules("read-only", [])),
    ).toBe("ask")
  })

  test("read-only gates every permission name and re-opens only the read-only tools", () => {
    const rules = sideQuestionRules("read-only", parent)
    // The catch-all must come first: evaluation is last-match-wins, so the
    // allows that follow it win for read/glob while everything else —
    // including MCP tools, which ask under sanitized ids like
    // "github_create_issue", never an "mcp" prefix — falls to "ask" and is
    // auto-rejected.
    expect(rules[0]).toEqual({ permission: "*", pattern: "*", action: "ask" })
    expect(
      rules
        .filter((rule) => rule.action === "allow")
        .every((rule) => ["read", "glob"].includes(rule.permission)),
    ).toBe(true)
    expect(evaluate("read", "src/main.ts", rules)).toBe("allow")
    expect(evaluate("read", ".env.example", rules)).toBe("allow")
    // New guards must not introduce a pattern-"*" deny that strips a tool.
    expect(
      rules.some((rule) => rule.action === "deny" && rule.pattern === "*"),
    ).toBe(false)
  })

  test("keeps a wholly denied read tool hidden instead of reintroducing it with path guards", () => {
    const rules = sideQuestionRules("read-only", [
      ...parent,
      { permission: "read", pattern: "*", action: "deny" },
    ])
    // Permission.disabled looks only at the last matching permission rule,
    // then checks whether it is a pattern-"*" deny (not path evaluation).
    expect(rules.findLast((rule) => rule.permission === "read")).toEqual({
      permission: "read",
      pattern: "*",
      action: "deny",
    })
    expect(evaluate("read", ".env.example", rules)).toBe("deny")
    expect(evaluate("read", "mcp:server:resource", rules)).toBe("deny")
    expect(evaluate("glob", "src/**", rules)).toBe("allow")
  })

  test("grep is never re-opened: its permission sees only the regex, so it would bypass the env guard", () => {
    // tool/grep.ts (1.17.18) asks with patterns: [params.pattern] — the search
    // regex — while path/include and directory sweeps decide which files'
    // CONTENT comes back. A grep allow is therefore a content read the
    // env-file rules can never see. It must fall to the "*" ask.
    const rules = sideQuestionRules("read-only", parent)
    expect(rules.some((rule) => rule.permission === "grep")).toBe(false)
  })

  test("env files stay guarded even where the parent allows them", () => {
    const rules = sideQuestionRules("read-only", [
      ...parent,
      { permission: "read", pattern: "*", action: "allow" },
    ])
    for (const path of [
      ".env",
      "private/signing.env",
      "config/.env.production",
    ]) {
      expect(evaluate("read", path, rules)).toBe("deny")
    }
    expect(evaluate("read", "config/.env.example", rules)).toBe("allow")
  })

  test("env example exemptions intersect the ordered parent policy, not just its last blanket rule", () => {
    for (const pattern of [
      "*",
      "private/**",
      "private\\*",
      "*.env.*",
      "*v.env.ex?mple",
      "*public.en*v.example",
      "private/.env.example *",
      "*.env.example *",
      "private/**/.env.*",
      "config/.env.example",
    ]) {
      for (const action of ["allow", "ask", "deny"] as const) {
        const policy: PermissionRuleset = [
          ...parent,
          { permission: "read", pattern: "private/*", action: "deny" },
          { permission: "read", pattern, action },
          {
            permission: "read",
            pattern: "private/public.env.example",
            action: "allow",
          },
        ]
        const rules = sideQuestionRules("read-only", policy)
        for (const path of [
          ".env.example",
          "dev.env.example",
          "private/.env.example",
          "private/public.env.example",
          "private/nested/.env.example",
          "config/.env.example",
          "public.env.example",
          "public.env.extra.env.example",
        ]) {
          expect(evaluate("read", path, rules)).toBe(
            evaluate("read", path, policy),
          )
        }
      }
    }
  })

  test("MCP resource reads are denied without relaxing parent denials", () => {
    // The host's MCP resource readers (session/tools.ts, 1.17.18) ask under
    // "read" with "mcp:<server>:<uri>" patterns, so the broad allow would
    // silently admit content from external MCP servers. A trailing path deny
    // wins without stripping the read tool or turning a parent deny into ask.
    for (const action of ["allow", "ask", "deny"] as const) {
      const rules = sideQuestionRules("read-only", [
        ...parent,
        { permission: "read", pattern: "mcp:*", action },
      ])
      expect(evaluate("read", "mcp:server:private/key", rules)).toBe("deny")
      expect(evaluate("read", "mcp:server:.env.example", rules)).toBe("deny")
    }
  })

  test("none asks on everything", () => {
    expect(sideQuestionRules("none", parent)).toEqual([
      { permission: "*", pattern: "*", action: "ask" },
    ])
  })

  test("READ_ONLY_TOOL_IDS lists exactly the executable read-only surface (no grep, no MCP readers)", () => {
    expect([...READ_ONLY_TOOL_IDS].sort()).toEqual(["glob", "invalid", "read"])
  })
})

describe("isGuardedEnvPath", () => {
  // Must agree with the "*.env" / "*.env.*" / "*.env.example" rules above:
  // host wildcards let "*" cross "/" and match empty, so these are suffix
  // and substring tests on the path, relative or absolute alike.
  test("guards env files wherever they live", () => {
    for (const path of [
      ".env",
      "app.env",
      "config/.env",
      "/repo/deep/.env",
      ".env.local",
      "config/.env.production",
      "envs/prod.env.bak",
    ]) {
      expect(isGuardedEnvPath(path)).toBe(true)
    }
  })

  test("the *.env.example allow wins, matching the rule order", () => {
    for (const path of [
      ".env.example",
      "config/prod.env.example",
      "/repo/.env.example",
    ]) {
      expect(isGuardedEnvPath(path)).toBe(false)
    }
  })

  test("does not overreach onto lookalikes", () => {
    for (const path of [
      "src/main.ts",
      "environment.ts",
      "config.envy",
      "env",
      "docs/env.md",
    ]) {
      expect(isGuardedEnvPath(path)).toBe(false)
    }
  })

  test("tolerates junk arguments without guessing", () => {
    for (const junk of [undefined, null, 42, {}, ""]) {
      expect(isGuardedEnvPath(junk)).toBe(false)
    }
  })
})

describe("marker", () => {
  const valid = () => ({
    version: 1,
    parent: "ses_parent",
    tools: "read-only",
    created: 123,
    lease: 456,
  })
  const wrap = (value: unknown) => ({ [MARKER_KEY]: value })

  test("round-trips through metadata", () => {
    const metadata = markerFor({
      parent: "ses_parent",
      tools: "read-only",
      created: 123,
      lease: 456,
    })
    expect(markerOf(metadata)).toEqual({
      parent: "ses_parent",
      tools: "read-only",
      created: 123,
      lease: 456,
    })
  })

  test("the key is namespaced and the payload versioned — metadata is a shared record", () => {
    // Sweeping DELETES sessions, so the marker must never collide with what
    // another plugin (or a user) happens to put in session metadata.
    const metadata = markerFor({
      parent: "p",
      tools: "none",
      created: 1,
      lease: 1,
    })
    expect(Object.keys(metadata)).toEqual([
      "@macarons/btw",
      "@mcolsen-opencode/btw",
    ])
    expect((metadata["@macarons/btw"] as { version?: unknown }).version).toBe(1)
    expect(
      (metadata["@mcolsen-opencode/btw"] as { version?: unknown }).version,
    ).toBe(1)
  })

  test("recognizes pre-Macarons markers left on existing sessions", () => {
    expect(markerOf({ "@mcolsen-opencode/btw": valid() })).toEqual({
      parent: "ses_parent",
      tools: "read-only",
      created: 123,
      lease: 456,
    })
  })

  test("rejects anything that is not exactly a marker this code wrote", () => {
    expect(markerOf(undefined)).toBeUndefined()
    expect(markerOf({})).toBeUndefined()
    expect(markerOf({ other: { parent: "x" } })).toBeUndefined()
    // The pre-namespace short key: foreign { btw: {...} } metadata must never
    // make a session deletable, however marker-shaped it looks.
    expect(markerOf({ btw: valid() })).toBeUndefined()
    expect(markerOf(wrap(undefined))).toBeUndefined()
    expect(markerOf(wrap("marker"))).toBeUndefined()
    expect(markerOf(wrap({}))).toBeUndefined()
  })

  test("every field validates strictly — nothing is defaulted before a deletion", () => {
    expect(markerOf(wrap(valid()))).toBeDefined()
    const { version: _v, ...withoutVersion } = valid()
    expect(markerOf(wrap(withoutVersion))).toBeUndefined()
    expect(markerOf(wrap({ ...valid(), version: 2 }))).toBeUndefined()
    expect(markerOf(wrap({ ...valid(), parent: "" }))).toBeUndefined()
    expect(markerOf(wrap({ ...valid(), tools: "write" }))).toBeUndefined()
    expect(markerOf(wrap({ ...valid(), tools: undefined }))).toBeUndefined()
    expect(markerOf(wrap({ ...valid(), created: undefined }))).toBeUndefined()
    expect(markerOf(wrap({ ...valid(), created: Number.NaN }))).toBeUndefined()
    expect(markerOf(wrap({ ...valid(), lease: undefined }))).toBeUndefined()
    expect(markerOf(wrap({ ...valid(), lease: "999" }))).toBeUndefined()
    expect(
      markerOf(wrap({ ...valid(), lease: Number.POSITIVE_INFINITY })),
    ).toBeUndefined()
  })
})

describe("promptTarget", () => {
  test("mirrors the parent's agent, model, and variant by default", () => {
    const target = promptTarget(
      {
        agent: "build",
        model: {
          id: "claude-sonnet-5",
          providerID: "anthropic",
          variant: "thinking",
        },
      },
      resolveOptions(undefined),
    )
    expect(target).toEqual({
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      variant: "thinking",
    })
  })

  test("option overrides win over the parent", () => {
    const target = promptTarget(
      { agent: "build", model: { id: "m", providerID: "p", variant: "v" } },
      resolveOptions({ model: "openai/gpt-5", variant: "high" }),
    )
    expect(target.model).toEqual({ providerID: "openai", modelID: "gpt-5" })
    expect(target.variant).toBe("high")
  })

  test("a pinned model never inherits the parent model's variant", () => {
    // Variants are defined per model; the parent's "thinking" may not exist
    // on the pinned model (silently ignored) or mean different settings.
    const target = promptTarget(
      {
        agent: "build",
        model: { id: "m", providerID: "p", variant: "thinking" },
      },
      resolveOptions({ model: "openai/gpt-5-mini" }),
    )
    expect(target.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5-mini",
    })
    expect(target.variant).toBeUndefined()
  })

  test("the parent's stored variant \"default\" is the host's no-pin sentinel, not a variant", () => {
    const target = promptTarget(
      {
        agent: "build",
        model: { id: "m", providerID: "p", variant: "default" },
      },
      resolveOptions(undefined),
    )
    expect(target.model).toEqual({ providerID: "p", modelID: "m" })
    expect(target.variant).toBeUndefined()
  })

  // The two host-shaped faces of the stored "default": the session records
  // "default" both for an unpinned turn and for an explicitly selected
  // variant literally named "default". The user message is what tells them
  // apart — it records the variant only as actually requested.

  test('an unpinned parent turn (message variant undefined) drops the stored "default"', () => {
    const target = promptTarget(
      {
        agent: "build",
        model: { id: "m", providerID: "p", variant: "default" },
      },
      resolveOptions(undefined),
      [
        {
          id: "msg_01",
          role: "user",
          model: { providerID: "p", modelID: "m" },
        },
        { id: "msg_02", role: "assistant" },
      ],
    )
    expect(target.variant).toBeUndefined()
  })

  test('a really-selected "default" variant (recorded on the latest user message) is forwarded', () => {
    const target = promptTarget(
      {
        agent: "build",
        model: { id: "m", providerID: "p", variant: "default" },
      },
      resolveOptions(undefined),
      [
        {
          id: "msg_01",
          role: "user",
          model: { providerID: "p", modelID: "m", variant: "default" },
        },
        { id: "msg_02", role: "assistant" },
      ],
    )
    expect(target.variant).toBe("default")
  })

  test("only the LATEST user message on the SAME model counts as evidence", () => {
    // An older "default" pin superseded by an unpinned turn must not revive,
    // and evidence recorded against a different model proves nothing about
    // the session's current one.
    const superseded = promptTarget(
      {
        agent: "build",
        model: { id: "m", providerID: "p", variant: "default" },
      },
      resolveOptions(undefined),
      [
        {
          id: "msg_01",
          role: "user",
          model: { providerID: "p", modelID: "m", variant: "default" },
        },
        {
          id: "msg_02",
          role: "user",
          model: { providerID: "p", modelID: "m" },
        },
      ],
    )
    expect(superseded.variant).toBeUndefined()

    const staleModel = promptTarget(
      {
        agent: "build",
        model: { id: "m", providerID: "p", variant: "default" },
      },
      resolveOptions(undefined),
      [
        {
          id: "msg_01",
          role: "user",
          model: { providerID: "p", modelID: "other", variant: "default" },
        },
      ],
    )
    expect(staleModel.variant).toBeUndefined()
  })

  test('an explicit option variant named "default" is forwarded verbatim', () => {
    // Only the *inherited* sentinel is stripped: an option spelled "default"
    // was configured on purpose and may name a real variant on some provider.
    const target = promptTarget(
      {
        agent: "build",
        model: { id: "m", providerID: "p", variant: "thinking" },
      },
      resolveOptions({ variant: "default" }),
    )
    expect(target.model).toEqual({ providerID: "p", modelID: "m" })
    expect(target.variant).toBe("default")
  })
})

describe("sideSessionTitle", () => {
  test("prefixes and truncates", () => {
    expect(sideSessionTitle("what is this")).toBe("btw: what is this")
    expect(sideSessionTitle("a".repeat(100)).length).toBeLessThanOrEqual(69)
    expect(sideSessionTitle("a".repeat(100)).endsWith("…")).toBe(true)
  })
})

describe("trim", () => {
  test("drops oldest keys past the max", () => {
    const map = new Map<string, unknown>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ])
    trim(map, 2)
    expect([...map.keys()]).toEqual(["b", "c"])
  })
})

import { describe, expect, test } from "bun:test"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import {
  type ChildMessage,
  childLine,
  clampWaitTimeout,
  DEFAULT_INJECT_CONFIRM_TIMEOUT_MS,
  DEFAULT_MAX_BUSY_CHILDREN,
  DEFAULT_MAX_REPLY_CHARS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  deriveChildPermission,
  extractChildOutcome,
  formatDuration,
  hasInjectedMessage,
  MESSAGE_COUNTER_MAX,
  MIN_WAIT_TIMEOUT_MS,
  mintMessageID,
  NO_CHILDREN_MESSAGE,
  notDirectChildError,
  notificationText,
  openCodeCompatNotice,
  parseChildMessages,
  parseModelCatalog,
  renderModelCatalog,
  renderTaskBlock,
  resolveServerOptions,
  rulesetOf,
  SUBAGENT_KILL_DESCRIPTION,
  SUBAGENT_MODELS_DESCRIPTION,
  SUBAGENT_TOOL_IDS,
  SUPPORTED_OPENCODE_RANGE,
  sessionPromptIdentity,
  spawnDeniedError,
  subagentDepthLimitError,
  subagentListDescription,
  subagentSendDescription,
  subagentSpawnDescription,
  subagentWaitDescription,
  taskHint,
  tooManyBusyChildrenError,
  truncateReply,
  unknownAgentError,
  WAIT_MAX_TIMEOUT_MS,
} from "../src/shared"

describe("version gate", () => {
  const R = SUPPORTED_OPENCODE_RANGE
  // [version, compat, disables?] — a non-v1 host disables; every v1 host runs
  // (silently inside the verified band, with a warning otherwise). Samples
  // derive from the band so the nightly ratchet cannot strand them.
  const cases: [
    version: string | undefined,
    compat: "supported" | "untested" | "incompatible",
    disable: boolean,
  ][] = [
    [BAND.floor, "supported", false], // verified floor
    [BAND.inBand, "supported", false],
    [`${BAND.floor}+build.7`, "supported", false], // build metadata ignored
    [BAND.belowBand, "untested", false], // below the floor: warn but run
    [`${BAND.floor}-beta.1`, "untested", false], // a v1 prerelease
    [BAND.aboveBand, "untested", false], // past the ceiling: untested, not disabled
    ["not a version", "untested", false], // unreadable → fail open
    [undefined, "untested", false], // probe could not name the version
    ["2.0.0", "incompatible", true], // OpenCode v2 changes the plugin API
    ["2.0.0-beta.1", "incompatible", true], // the v2 beta, specifically
  ]
  test.each(cases)("%p → %s (disable=%p)", (version, compat, disable) => {
    const notice = openCodeCompatNotice(version, R, "Subagent communication")
    if (compat === "supported") {
      expect(notice).toBeNull()
    } else {
      expect(notice?.compat).toBe(compat)
      expect(notice?.disable).toBe(disable)
    }
  })
})

describe("resolveServerOptions", () => {
  test("defaults", () => {
    expect(resolveServerOptions(undefined)).toEqual({
      notify: true,
      toast: true,
      taskHint: true,
      defaultWaitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      maxReplyChars: DEFAULT_MAX_REPLY_CHARS,
      maxBusyChildren: DEFAULT_MAX_BUSY_CHILDREN,
      injectConfirmTimeoutMs: DEFAULT_INJECT_CONFIRM_TIMEOUT_MS,
    })
  })
  test("booleans only disable on explicit false", () => {
    expect(
      resolveServerOptions({ notify: 0, toast: "no", taskHint: null }).notify,
    ).toBe(true)
    const disabled = resolveServerOptions({
      notify: false,
      toast: false,
      taskHint: false,
    })
    expect(disabled.notify).toBe(false)
    expect(disabled.toast).toBe(false)
    expect(disabled.taskHint).toBe(false)
  })
  test("numbers clamp and survive junk", () => {
    const options = resolveServerOptions({
      defaultWaitTimeoutMs: 10 ** 9,
      pollIntervalMs: 1,
      maxReplyChars: "big",
      maxBusyChildren: 99.9,
      injectConfirmTimeoutMs: 1,
    })
    expect(options.defaultWaitTimeoutMs).toBe(WAIT_MAX_TIMEOUT_MS)
    expect(options.pollIntervalMs).toBe(250)
    expect(options.maxReplyChars).toBe(DEFAULT_MAX_REPLY_CHARS)
    expect(options.maxBusyChildren).toBe(32)
    expect(options.injectConfirmTimeoutMs).toBe(250)
  })
})

describe("clampWaitTimeout", () => {
  test("fallback on absent or nonsense", () => {
    expect(clampWaitTimeout(undefined, 5_000)).toBe(5_000)
    expect(clampWaitTimeout(-1, 5_000)).toBe(5_000)
    expect(clampWaitTimeout(Number.NaN, 5_000)).toBe(5_000)
  })
  test("clamps to the wait bounds", () => {
    expect(clampWaitTimeout(1, 5_000)).toBe(MIN_WAIT_TIMEOUT_MS)
    expect(clampWaitTimeout(10 ** 9, 5_000)).toBe(WAIT_MAX_TIMEOUT_MS)
    expect(clampWaitTimeout(9_500.7, 5_000)).toBe(9_500)
  })
})

describe("rulesetOf", () => {
  test("reads well-formed rules and drops junk entries", () => {
    expect(
      rulesetOf([
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "rm *" }, // no action
        { permission: 7, pattern: "*", action: "allow" },
        "junk",
        { permission: "edit", pattern: "*", action: "grant" }, // unknown action
      ]),
    ).toEqual([{ permission: "task", pattern: "*", action: "deny" }])
  })
  test("non-arrays read as empty", () => {
    expect(rulesetOf(undefined)).toEqual([])
    expect(rulesetOf({ edit: "allow" })).toEqual([])
  })
})

describe("deriveChildPermission", () => {
  const deny = (permission: string) => ({
    permission,
    pattern: "*",
    action: "deny" as const,
  })

  test("carries parent deny and external_directory rules, drops allows", () => {
    const derived = deriveChildPermission(
      [
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "rm *", action: "deny" },
        {
          permission: "external_directory",
          pattern: "/tmp/*",
          action: "allow",
        },
      ],
      [
        { permission: "task", pattern: "*", action: "allow" },
        { permission: "todowrite", pattern: "*", action: "allow" },
      ],
    )
    expect(derived).toEqual([
      { permission: "bash", pattern: "rm *", action: "deny" },
      { permission: "external_directory", pattern: "/tmp/*", action: "allow" },
    ])
  })

  test("denies todowrite, task, and every subagent tool for a default agent", () => {
    const derived = deriveChildPermission([], [])
    expect(derived).toEqual([
      deny("todowrite"),
      deny("task"),
      ...SUBAGENT_TOOL_IDS.map(deny),
    ])
  })

  test("an agent that may task keeps task and the subagent tools", () => {
    const derived = deriveChildPermission(
      [],
      [{ permission: "task", pattern: "*", action: "allow" }],
    )
    expect(derived).toEqual([deny("todowrite")])
  })

  test("does not duplicate denies the parent already carries", () => {
    const derived = deriveChildPermission([deny("task")], [])
    expect(derived.filter((rule) => rule.permission === "task")).toHaveLength(1)
  })

  test("appends experimental.primary_tools denies, deduped against the base denies", () => {
    const derived = deriveChildPermission([], [], ["bash", "task"])
    expect(derived).toEqual([
      deny("todowrite"),
      deny("task"),
      ...SUBAGENT_TOOL_IDS.map(deny),
      deny("bash"),
    ])
    // A primary_tools "task" does not double the base task deny.
    expect(derived.filter((rule) => rule.permission === "task")).toHaveLength(1)
  })

  describe("WP5: a mentioned task/todowrite rule withholds the denies regardless of action", () => {
    // canTask/canTodo are action-agnostic on purpose (they mirror the host,
    // which keys off the rule's mere presence). A subagent ruleset that MENTIONS
    // task — even with action "deny" or "ask" — must NOT re-deny task and the
    // subagent tools; only the unmentioned twin (todowrite) is denied.
    for (const action of ["deny", "ask"] as const) {
      test(`a task rule with action ${action} still withholds the task/subagent denies`, () => {
        const derived = deriveChildPermission(
          [],
          [{ permission: "task", pattern: "*", action }],
        )
        expect(derived).toEqual([deny("todowrite")])
      })
    }

    test("a todowrite rule with action ask withholds only the todowrite deny", () => {
      const derived = deriveChildPermission(
        [],
        [{ permission: "todowrite", pattern: "*", action: "ask" }],
      )
      expect(derived).toEqual([deny("task"), ...SUBAGENT_TOOL_IDS.map(deny)])
    })
  })
})

describe("provider model catalog", () => {
  test("allowlists catalog models, sorts deterministically, and marks defaults", () => {
    const catalog = parseModelCatalog({
      providers: [
        {
          id: "zeta",
          name: "Zeta",
          key: "PROVIDER_SECRET",
          options: { secret: "OPTIONS_SECRET" },
          models: {
            beta: {
              id: "beta",
              name: "Beta",
              variants: { high: { secret: "VARIANT_SECRET" }, low: {} },
            },
            alpha: {
              id: "alpha",
              name: "Alpha",
              headers: { x: "HEADER_SECRET" },
            },
          },
        },
        {
          id: "openrouter",
          models: {
            "anthropic/claude-sonnet": {
              id: "anthropic/claude-sonnet",
              api: { secret: "API_SECRET" },
            },
          },
        },
        { id: "broken", models: { missing: {} } },
      ],
      default: { zeta: "beta" },
    })

    expect(catalog).toEqual({
      models: [
        {
          ref: "openrouter/anthropic/claude-sonnet",
          providerID: "openrouter",
          modelID: "anthropic/claude-sonnet",
          providerName: "openrouter",
          modelName: "anthropic/claude-sonnet",
          providerDefault: false,
          variants: [],
        },
        {
          ref: "zeta/alpha",
          providerID: "zeta",
          modelID: "alpha",
          providerName: "Zeta",
          modelName: "Alpha",
          providerDefault: false,
          variants: [],
        },
        {
          ref: "zeta/beta",
          providerID: "zeta",
          modelID: "beta",
          providerName: "Zeta",
          modelName: "Beta",
          providerDefault: true,
          variants: ["high", "low"],
        },
      ],
    })
    const output = renderModelCatalog(catalog!)
    expect(output).toContain("Models in the current provider catalog")
    expect(output).toContain("[provider default]")
    expect(output).toContain("variants: high, low")
    for (const secret of [
      "PROVIDER_SECRET",
      "OPTIONS_SECRET",
      "VARIANT_SECRET",
      "HEADER_SECRET",
      "API_SECRET",
    ])
      expect(output).not.toContain(secret)
  })

  test("rejects an unreadable provider payload but accepts a valid empty catalog", () => {
    expect(parseModelCatalog(undefined)).toBeUndefined()
    expect(parseModelCatalog({ providers: {} })).toBeUndefined()
    expect(parseModelCatalog({ providers: [], default: {} })).toEqual({
      models: [],
    })
    expect(renderModelCatalog({ models: [] })).toBe(
      "No models are currently listed in the provider catalog.",
    )
  })
})

describe("sessionPromptIdentity", () => {
  test("extracts agent, model, and a real variant", () => {
    expect(
      sessionPromptIdentity({
        agent: "explore",
        model: { providerID: "anthropic", id: "claude-x", variant: "max" },
      }),
    ).toEqual({
      agent: "explore",
      model: { providerID: "anthropic", modelID: "claude-x" },
      variant: "max",
    })
  })
  test('drops the "default" variant marker and partial models', () => {
    expect(
      sessionPromptIdentity({
        agent: "build",
        model: { providerID: "anthropic", id: "claude-x", variant: "default" },
      }),
    ).toEqual({
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-x" },
    })
    expect(
      sessionPromptIdentity({
        agent: "build",
        model: { providerID: "anthropic" },
      }),
    ).toEqual({ agent: "build" })
  })
  test("junk reads as empty identity", () => {
    expect(sessionPromptIdentity(undefined)).toEqual({})
    expect(sessionPromptIdentity({ agent: 3, model: "x" })).toEqual({})
  })
})

describe("parseChildMessages", () => {
  test("keeps the LAST text part, like the stock task result", () => {
    const parsed = parseChildMessages([
      {
        info: {
          id: "msg_2",
          role: "assistant",
          time: { created: 1, completed: 2 },
        },
        parts: [
          { type: "text", text: "thinking..." },
          { type: "tool", tool: "bash" },
          { type: "text", text: "final answer" },
        ],
      },
    ])
    expect(parsed).toEqual([
      { id: "msg_2", role: "assistant", completed: true, text: "final answer" },
    ])
  })
  test("assistant without time.completed reads as incomplete; users always complete", () => {
    const parsed = parseChildMessages([
      {
        info: { id: "msg_1", role: "user", time: { created: 1 } },
        parts: [{ type: "text", text: "go" }],
      },
      {
        info: { id: "msg_2", role: "assistant", time: { created: 2 } },
        parts: [],
      },
    ])
    expect(parsed[0]?.completed).toBe(true)
    expect(parsed[1]?.completed).toBe(false)
  })
  test("captures the reply correlation fields: parentID and the summary flag", () => {
    const parsed = parseChildMessages([
      {
        info: {
          id: "msg_2",
          role: "assistant",
          parentID: "msg_1",
          summary: true,
          time: { created: 1, completed: 2 },
        },
        parts: [{ type: "text", text: "condensed" }],
      },
      {
        info: {
          id: "msg_3",
          role: "assistant",
          parentID: 7,
          summary: "yes",
          time: { created: 3 },
        },
        parts: [],
      },
    ])
    expect(parsed).toEqual([
      {
        id: "msg_2",
        role: "assistant",
        completed: true,
        parentID: "msg_1",
        summary: true,
        text: "condensed",
      },
      { id: "msg_3", role: "assistant", completed: false },
    ])
  })
  test("extracts error message with name fallback, drops junk entries", () => {
    const parsed = parseChildMessages([
      {
        info: {
          id: "msg_3",
          role: "assistant",
          error: { name: "MessageAbortedError", data: { message: "aborted" } },
        },
      },
      {
        info: {
          id: "msg_4",
          role: "assistant",
          error: { name: "UnknownError" },
        },
      },
      { info: { role: "assistant" } },
      null,
      { info: { id: "msg_5", role: "system" } },
    ])
    expect(parsed).toEqual([
      { id: "msg_3", role: "assistant", completed: false, error: "aborted" },
      {
        id: "msg_4",
        role: "assistant",
        completed: false,
        error: "UnknownError",
      },
    ])
    expect(parseChildMessages({ not: "an array" })).toEqual([])
  })
})

describe("extractChildOutcome", () => {
  const message = (
    partial: Partial<ChildMessage> & { id: string },
  ): ChildMessage => ({
    role: "assistant",
    completed: true,
    ...partial,
  })

  test("newest completed assistant text wins, regardless of input order", () => {
    const fixture = [
      message({ id: "msg_3", text: "newest" }),
      message({ id: "msg_1", text: "oldest" }),
      message({ id: "msg_2", text: "middle" }),
    ]
    expect(extractChildOutcome(fixture, undefined)).toEqual({
      kind: "replied",
      messageID: "msg_3",
      text: "newest",
    })
  })
  test("replies correlate on parentID: at or past the injected message", () => {
    const fixture = [
      message({ id: "msg_8", parentID: "msg_2", text: "previous run's reply" }),
      message({ id: "msg_9", parentID: "msg_5", text: "our reply" }),
    ]
    expect(extractChildOutcome(fixture, "msg_5")).toEqual({
      kind: "replied",
      messageID: "msg_9",
      text: "our reply",
    })
    // A reply attributed to a LATER user message still covers ours: the run
    // answers everything pending but records only the newest as parentID.
    expect(extractChildOutcome(fixture, "msg_4")).toEqual({
      kind: "replied",
      messageID: "msg_9",
      text: "our reply",
    })
    expect(extractChildOutcome([fixture[0]!], "msg_5")).toEqual({
      kind: "none",
    })
  })
  test("assistants without a parentID never satisfy a correlation", () => {
    const fixture = [message({ id: "msg_9", text: "untraceable" })]
    expect(extractChildOutcome(fixture, "msg_1")).toEqual({ kind: "none" })
    expect(extractChildOutcome(fixture, undefined)).toEqual({
      kind: "replied",
      messageID: "msg_9",
      text: "untraceable",
    })
  })
  test("compaction summaries are never replies", () => {
    const fixture = [
      message({
        id: "msg_9",
        parentID: "msg_5",
        summary: true,
        text: "condensed transcript",
      }),
    ]
    expect(extractChildOutcome(fixture, "msg_5")).toEqual({ kind: "none" })
    expect(extractChildOutcome(fixture, undefined)).toEqual({ kind: "none" })
  })
  test("incomplete assistants are skipped; user messages never count", () => {
    const fixture = [
      message({ id: "msg_1", text: "done earlier" }),
      message({ id: "msg_2", text: "streaming", completed: false }),
      { id: "msg_3", role: "user" as const, completed: true, text: "hello" },
    ]
    expect(extractChildOutcome(fixture, undefined)).toEqual({
      kind: "replied",
      messageID: "msg_1",
      text: "done earlier",
    })
  })
  test("errored when nothing completed with text but a correlated error exists", () => {
    const fixture = [
      message({
        id: "msg_9",
        parentID: "msg_5",
        error: "aborted",
        text: undefined,
        completed: false,
      }),
    ]
    expect(extractChildOutcome(fixture, undefined)).toEqual({
      kind: "errored",
      error: "aborted",
    })
    expect(extractChildOutcome(fixture, "msg_5")).toEqual({
      kind: "errored",
      error: "aborted",
    })
    // An error from a step that never saw our message is not our outcome.
    expect(extractChildOutcome(fixture, "msg_7")).toEqual({ kind: "none" })
  })
  test("an error wins over partial text on the same completed message", () => {
    // A mid-stream/content-filter cut-off flushes partial text, sets completed,
    // and records the error — a failure, not a truncated reply.
    const fixture = [
      message({
        id: "msg_9",
        parentID: "msg_5",
        text: "partial output",
        error: "rate limited",
      }),
    ]
    expect(extractChildOutcome(fixture, undefined)).toEqual({
      kind: "errored",
      error: "rate limited",
    })
    expect(extractChildOutcome(fixture, "msg_5")).toEqual({
      kind: "errored",
      error: "rate limited",
    })
  })
  test("a newer errored step is not masked by an older completed reply", () => {
    const fixture = [
      message({ id: "msg_1", parentID: "msg_0", text: "first step output" }),
      message({
        id: "msg_2",
        parentID: "msg_0",
        text: undefined,
        error: "context overflow",
      }),
    ]
    expect(extractChildOutcome(fixture, undefined)).toEqual({
      kind: "errored",
      error: "context overflow",
    })
  })
  test("none on empty or all-filtered", () => {
    expect(extractChildOutcome([], undefined)).toEqual({ kind: "none" })
  })
})

describe("hasInjectedMessage", () => {
  test("checks the exact minted id, not just any newer user message", () => {
    const fixture = [
      {
        id: "msg_1",
        role: "user" as const,
        completed: true,
        text: "someone else's",
      },
      { id: "msg_2", role: "assistant" as const, completed: false },
    ]
    expect(hasInjectedMessage(fixture, "msg_1")).toBe(true)
    expect(hasInjectedMessage(fixture, "msg_9")).toBe(false)
  })
})

describe("mintMessageID", () => {
  test("matches the host's ascending id format", () => {
    expect(mintMessageID()).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  })
  test("sorts below same-millisecond host ids so the reply the host mints sorts after it", () => {
    const now = 1_752_000_000_000
    const hostAt = (ts: number, counter: number) =>
      `msg_${(((BigInt(ts) << 12n) | BigInt(counter)) & 0xffffffffffffn).toString(16).padStart(12, "0")}00000000000000`
    const minted = mintMessageID(now)
    // A host id from an earlier millisecond sorts before ours (time dominates).
    expect(minted > hostAt(now - 1, 40)).toBe(true)
    // Same millisecond: ours sorts BELOW any host id — the host counter starts
    // at 1, never 0 — so the assistant reply (same ms or later) always has the
    // greater id and the run loop's `lastUser.id < lastAssistant.id` check
    // terminates instead of firing an extra model turn.
    expect(minted < hostAt(now, 1)).toBe(true)
    expect(minted < hostAt(now, 40)).toBe(true)
    // A host id from a later millisecond also sorts after ours.
    expect(minted < hostAt(now + 1, 1)).toBe(true)
  })
  test("a busy steer (MESSAGE_COUNTER_MAX) sorts above every same-millisecond host id", () => {
    const now = 1_752_000_000_000
    const hostAt = (ts: number, counter: number) =>
      `msg_${(((BigInt(ts) << 12n) | BigInt(counter)) & 0xffffffffffffn).toString(16).padStart(12, "0")}00000000000000`
    const steer = mintMessageID(now, MESSAGE_COUNTER_MAX)
    // Above the in-flight assistant the host minted in our millisecond, whatever
    // its counter (the host counts up from 1 and never nears 4095 ids per ms) —
    // so the running loop cannot read the steer as already-answered and exit.
    expect(steer > hostAt(now, 1)).toBe(true)
    expect(steer > hostAt(now, 40)).toBe(true)
    expect(steer > hostAt(now, MESSAGE_COUNTER_MAX - 1)).toBe(true)
    // But a later-millisecond reply (the eventual answer) still sorts above it.
    expect(steer < hostAt(now + 1, 1)).toBe(true)
    // And the default (idle) mint stays BELOW the same-ms host ids — the two
    // modes are opposites, and the default must not regress.
    expect(mintMessageID(now) < hostAt(now, 1)).toBe(true)
    // The low 12 bits decode to the chosen counter.
    const counterOf = (id: string) =>
      Number(BigInt(`0x${id.slice(4, 16)}`) & 0xfffn)
    expect(counterOf(steer)).toBe(MESSAGE_COUNTER_MAX)
    expect(counterOf(mintMessageID(now))).toBe(0)
  })
})

describe("truncateReply", () => {
  test("passes short text through untouched", () => {
    expect(truncateReply("hello", 100)).toEqual({
      text: "hello",
      truncated: false,
    })
  })
  test("truncates with an explanatory marker", () => {
    const result = truncateReply("a".repeat(600), 512)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain("a".repeat(512))
    expect(result.text).toContain("88 characters truncated")
  })
})

describe("renderTaskBlock", () => {
  test("matches the stock task tool's completed shape byte for byte", () => {
    expect(
      renderTaskBlock({ sessionID: "ses_x", state: "completed", text: "done" }),
    ).toBe(
      [
        '<task id="ses_x" state="completed">',
        "<task_result>",
        "done",
        "</task_result>",
        "</task>",
      ].join("\n"),
    )
  })
  test("errors use task_error and summaries render before the body", () => {
    expect(
      renderTaskBlock({
        sessionID: "ses_x",
        state: "error",
        summary: "s",
        text: "boom",
      }),
    ).toBe(
      [
        '<task id="ses_x" state="error">',
        "<summary>s</summary>",
        "<task_error>",
        "boom",
        "</task_error>",
        "</task>",
      ].join("\n"),
    )
  })
})

describe("notificationText", () => {
  test("replied inlines the (truncated) reply inside a task block", () => {
    const text = notificationText({
      sessionID: "ses_x",
      label: "audit configs",
      outcome: { kind: "replied", messageID: "msg_9", text: "all good" },
      elapsedMs: 65_000,
      maxReplyChars: 512,
    })
    expect(text).toContain('<task id="ses_x" state="completed">')
    expect(text).toContain(
      "<summary>Background subagent completed: audit configs</summary>",
    )
    expect(text).toContain("all good")
    expect(text).toContain("subagent_send")
    expect(text).toContain("1m05s")
    expect(text).toContain("you may ignore it")
  })
  test("errored uses the failure summary and task_error tag", () => {
    const text = notificationText({
      sessionID: "ses_x",
      label: "audit configs",
      outcome: { kind: "errored", error: "boom" },
      elapsedMs: 1_000,
      maxReplyChars: 512,
    })
    expect(text).toContain(
      "<summary>Background subagent failed: audit configs</summary>",
    )
    expect(text).toContain("<task_error>")
  })
  test("none reports an idle-without-reply subagent as recoverable", () => {
    const text = notificationText({
      sessionID: "ses_x",
      label: "audit configs",
      outcome: { kind: "none" },
      elapsedMs: 1_000,
      maxReplyChars: 512,
    })
    expect(text).toContain("without producing a new reply")
    expect(text).toContain("subagent_send")
  })
})

describe("list and error strings", () => {
  test("childLine renders every present field", () => {
    expect(
      childLine(
        {
          id: "ses_a",
          title: "Find the loader (@explore subagent)",
          agent: "explore",
          status: "busy",
          updated: 66_000,
        },
        100_000,
      ),
    ).toBe(
      '- ses_a [busy] @explore — "Find the loader (@explore subagent)" — updated 34s ago',
    )
  })
  test("childLine omits absent fields", () => {
    expect(childLine({ id: "ses_b", status: "idle" }, 0)).toBe("- ses_b [idle]")
  })
  test("scoping and denial errors carry guidance", () => {
    expect(notDirectChildError("ses_x", "ses_p")).toContain(
      "subagents you started yourself",
    )
    expect(unknownAgentError("nope", ["general", "explore"])).toContain(
      "general, explore",
    )
    expect(unknownAgentError("nope", [])).not.toContain("Available")
    expect(spawnDeniedError(true)).toContain("may not spawn subagents")
    expect(spawnDeniedError(false)).toContain("not permitted")
    expect(subagentDepthLimitError(1)).toBe(
      'Subagent depth limit reached (1). Increase "subagent_depth" to allow nested subagents.',
    )
    expect(tooManyBusyChildrenError(8, 8)).toContain("subagent_wait")
    expect(NO_CHILDREN_MESSAGE).toContain("subagent_spawn")
  })
})

describe("descriptions", () => {
  test("spawn description positions itself against the task tool", () => {
    expect(subagentSpawnDescription(true)).toContain("task tool")
    expect(subagentSpawnDescription(true)).toContain("NOTIFIED automatically")
    expect(subagentSpawnDescription(true)).toContain("DO NOT sleep")
  })
  test("send/wait descriptions embed the configured default timeout", () => {
    expect(subagentSendDescription(120_000, true)).toContain("default 120000")
    expect(subagentSendDescription(120_000, true)).toContain("steering")
    expect(subagentWaitDescription(90_000, true)).toContain("default 90000")
    expect(subagentWaitDescription(90_000, true)).toContain(
      "Timing out is not an error",
    )
  })
  test("list and kill descriptions state their scope", () => {
    expect(subagentListDescription(true)).toContain(
      "Never call this in a polling loop",
    )
    expect(SUBAGENT_KILL_DESCRIPTION).toContain("never deletes the session")
  })
  test("the task hint names task_id resume and all six tools", () => {
    expect(taskHint(true)).toContain("task_id")
    for (const id of SUBAGENT_TOOL_IDS) expect(taskHint(true)).toContain(id)
    expect(SUBAGENT_MODELS_DESCRIPTION).toContain("provider/model")
    expect(subagentSpawnDescription(true)).toContain("subagent_models")
    expect(subagentSpawnDescription(true)).toContain("variant")
    expect(SUBAGENT_MODELS_DESCRIPTION).not.toContain("connected")
    expect(SUBAGENT_MODELS_DESCRIPTION).not.toContain("currently usable")
    expect(SUBAGENT_MODELS_DESCRIPTION).toContain("not pre-checked")
    expect(subagentSpawnDescription(true)).toContain("not pre-check")
  })
  // notify:false must never promise a notification the plugin will not send —
  // the model would otherwise end its turn waiting for one (finding 7).
  test("with notify disabled, no description promises a notification", () => {
    for (const description of [
      subagentSpawnDescription(false),
      subagentSendDescription(120_000, false),
      subagentListDescription(false),
      subagentWaitDescription(90_000, false),
      taskHint(false),
    ]) {
      expect(description.toLowerCase()).not.toContain("notified")
      expect(description).not.toContain("notifications come to you")
    }
    expect(subagentSpawnDescription(false)).toContain("notify: false")
    expect(subagentSpawnDescription(false)).toContain("subagent_wait")
    expect(subagentSendDescription(120_000, false)).toContain(
      "collect the reply later with subagent_wait",
    )
    expect(taskHint(false)).toContain("collect its reply with subagent_wait")
  })
})

describe("formatDuration", () => {
  test("compact codes", () => {
    expect(formatDuration(34_000)).toBe("34s")
    expect(formatDuration(760_000)).toBe("12m40s")
    expect(formatDuration(3_720_000)).toBe("1h02m")
    expect(formatDuration(-5)).toBe("0s")
  })
})

import { describe, expect, test } from "bun:test"
import {
  createRedactionDiagnostics,
  SCAN_LIMIT_GUIDANCE,
} from "../src/diagnostics"
import { FINGERPRINT_MAX_CANDIDATES } from "../src/shared"

function harness(maxDedupeEntries?: number) {
  const logs: Array<{
    level: string
    message: string
    extra?: Record<string, unknown>
  }> = []
  const toasts: Array<{
    variant: string
    message: string
    overrides?: { title?: string; duration?: number }
  }> = []
  const diagnostics = createRedactionDiagnostics({
    maxDedupeEntries,
    log: (level, message, extra) => {
      logs.push({ level, message, extra })
      return true
    },
    toast: (variant, message, overrides) => {
      toasts.push({ variant, message, overrides })
      return true
    },
  })
  return { diagnostics, logs, toasts }
}

describe("scan-limit diagnostics", () => {
  test("emits fixed guidance and only allowlisted host metadata", () => {
    const { diagnostics, logs, toasts } = harness()
    diagnostics.scope(
      {
        hook: "experimental.chat.messages.transform",
        surface: "chat messages",
        sessionID: "ses_01SafeId",
        messageID: "msg_01SafeId",
      },
      () =>
        diagnostics.onScanLimit({
          characters: 51_234,
          candidates: 10_001,
          partID: "prt_01SafeId",
          partType: "tool",
          tool: "bash",
        }),
    )

    expect(logs).toEqual([
      {
        level: "warn",
        message:
          "secret scan limit reached; candidate-heavy content was replaced with a safe marker",
        extra: {
          event: "scan_limit",
          category: "FingerprintLimitError",
          hook: "experimental.chat.messages.transform",
          surface: "chat messages",
          sessionID: "ses_01SafeId",
          messageID: "msg_01SafeId",
          partID: "prt_01SafeId",
          partType: "tool",
          tool: "bash",
          characters: 51_234,
          candidates: 10_001,
          limit: FINGERPRINT_MAX_CANDIDATES,
          guidance: SCAN_LIMIT_GUIDANCE,
        },
      },
    ])
    expect(toasts).toEqual([
      expect.objectContaining({
        variant: "warning",
        overrides: { title: "Secret redaction", duration: 12_000 },
      }),
    ])
    expect(toasts[0]?.message).toContain("session can continue")
    expect(SCAN_LIMIT_GUIDANCE).toContain("smaller or selective output")
    expect(SCAN_LIMIT_GUIDANCE).toContain("do not clear")
    expect(SCAN_LIMIT_GUIDANCE).not.toContain("new session")
  })

  test("drops arbitrary IDs and part types and collapses custom tool names", () => {
    const secret = "secret-bearing-host-field"
    const { diagnostics, logs, toasts } = harness()
    diagnostics.scope(
      {
        hook: `${secret}.hook`,
        surface: `${secret}.surface`,
        sessionID: `ses_${secret}!`,
        messageID: `msg_${secret}!`,
      },
      () =>
        diagnostics.onScanLimit({
          characters: 9,
          candidates: 10_001,
          partID: `prt_${secret}!`,
          partType: secret,
          tool: secret,
        }),
    )

    expect(logs[0]?.extra).toEqual({
      event: "scan_limit",
      category: "FingerprintLimitError",
      tool: "custom",
      characters: 9,
      candidates: 10_001,
      limit: FINGERPRINT_MAX_CANDIDATES,
      guidance: SCAN_LIMIT_GUIDANCE,
    })
    expect(JSON.stringify({ logs, toasts })).not.toContain(secret)
  })

  test("keeps safe outer part metadata when the core callback omits it", () => {
    const { diagnostics, logs } = harness()
    diagnostics.scope(
      {
        hook: "experimental.text.complete",
        surface: "completed text",
        sessionID: "ses_complete",
        messageID: "msg_complete",
        partID: "prt_complete",
        partType: "text",
      },
      () => diagnostics.onScanLimit({ characters: 100, candidates: 10_001 }),
    )
    expect(logs[0]?.extra).toMatchObject({
      sessionID: "ses_complete",
      messageID: "msg_complete",
      partID: "prt_complete",
      partType: "text",
    })
  })

  test("deduplicates replay per session and keeps the dedupe set bounded", () => {
    const { diagnostics, logs, toasts } = harness(2)
    const report = (sessionID: string) =>
      diagnostics.scope(
        {
          hook: "experimental.chat.system.transform",
          surface: "system prompt",
          sessionID,
        },
        () => diagnostics.onScanLimit({ characters: 20, candidates: 10_001 }),
      )

    report("ses_one00000")
    report("ses_one00000")
    report("ses_two00000")
    report("ses_three000")
    report("ses_one00000") // evicted after two newer session keys
    expect(logs).toHaveLength(4)
    expect(toasts).toHaveLength(4)
    expect(logs.map((entry) => entry.extra?.sessionID)).toEqual([
      "ses_one00000",
      "ses_two00000",
      "ses_three000",
      "ses_one00000",
    ])
  })

  test("logs distinct omitted parts but toasts once per session and surface", () => {
    const { diagnostics, logs, toasts } = harness()
    const report = (messageID: string, partID: string, characters = 100) =>
      diagnostics.scope(
        {
          hook: "experimental.chat.messages.transform",
          surface: "chat messages",
          sessionID: "ses_multiple",
          messageID,
        },
        () =>
          diagnostics.onScanLimit({
            characters,
            candidates: 10_001,
            partID,
            partType: "text",
          }),
      )
    report("msg_multiple", "prt_multiple")
    report("msg_multiple", "prt_another0")
    report("msg_another0", "prt_multiple")
    report("msg_multiple", "prt_multiple", 101)
    report("msg_multiple", "prt_multiple", 101) // exact replay
    expect(logs).toHaveLength(4)
    expect(toasts).toHaveLength(1)
    expect(
      logs.map((entry) => [
        entry.extra?.messageID,
        entry.extra?.partID,
        entry.extra?.characters,
      ]),
    ).toEqual([
      ["msg_multiple", "prt_multiple", 100],
      ["msg_multiple", "prt_another0", 100],
      ["msg_another0", "prt_multiple", 100],
      ["msg_multiple", "prt_multiple", 101],
    ])
  })

  test("uses neutral wording when local recovery learning hits the limit", () => {
    const { diagnostics, logs, toasts } = harness()
    diagnostics.scope(
      {
        hook: "tool.execute.before",
        surface: "recovery sources",
        sessionID: "ses_recovery",
      },
      () => diagnostics.onScanLimit({ characters: 20, candidates: 10_001 }),
    )
    expect(logs[0]?.message).toContain("learning local recovery sources")
    expect(logs[0]?.message).toContain("local data was skipped")
    expect(logs[0]?.message).not.toContain("replaced")
    expect(toasts[0]?.message).toContain("local recovery data")
    expect(toasts[0]?.message).not.toContain("leaving OpenCode")
    expect(toasts[0]?.overrides?.duration).toBe(12_000)
  })

  test("keeps concurrent async session scopes distinct", async () => {
    const { diagnostics, logs } = harness()
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = diagnostics.scope(
      {
        hook: "experimental.chat.messages.transform",
        surface: "chat messages",
        sessionID: "ses_first000",
      },
      async () => {
        await firstBlocked
        diagnostics.onScanLimit({ characters: 10, candidates: 10_001 })
      },
    )
    const second = diagnostics.scope(
      {
        hook: "experimental.chat.messages.transform",
        surface: "chat messages",
        sessionID: "ses_second00",
      },
      async () => {
        diagnostics.onScanLimit({ characters: 20, candidates: 10_001 })
        releaseFirst?.()
      },
    )
    await Promise.all([first, second])

    expect(
      logs.map((entry) => [entry.extra?.sessionID, entry.extra?.characters]),
    ).toEqual([
      ["ses_second00", 20],
      ["ses_first000", 10],
    ])
  })

  test("hostile metadata getters and reporting failures never escape", () => {
    const details = {
      characters: 1,
      candidates: 10_001,
      get tool(): unknown {
        throw new Error("must not escape")
      },
    }
    const diagnostics = createRedactionDiagnostics({
      log: () => {
        throw new Error("logger failed")
      },
      toast: () => {
        throw new Error("toast failed")
      },
    })
    expect(() => diagnostics.onScanLimit(details)).not.toThrow()
  })
})

describe("fatal redaction diagnostics", () => {
  test("logs a fixed category and rethrows the same synchronous exception", () => {
    const secret = "exception text could contain a credential"
    const original = new Error(secret)
    const { diagnostics, logs, toasts } = harness()
    let caught: unknown
    try {
      diagnostics.runSync(
        { hook: "source.redaction", surface: "request sources" },
        () => "UnexpectedError",
        () => {
          throw original
        },
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(original)
    expect(logs[0]).toEqual({
      level: "error",
      message: "secret redaction failed closed; the request was stopped",
      extra: {
        event: "redaction_failure",
        category: "UnexpectedError",
        hook: "source.redaction",
        surface: "request sources",
        reason: "Unexpected redaction failure in request sources.",
        guidance: "See redact-secrets logs and report a bug.",
      },
    })
    expect(toasts[0]).toEqual({
      variant: "error",
      message:
        "Unexpected redaction failure in request sources. See redact-secrets logs and report a bug.",
      overrides: { title: "Secret redaction", duration: 15_000 },
    })
    expect(JSON.stringify({ logs, toasts })).not.toContain(secret)
  })

  test("rethrows the same asynchronously rejected value", async () => {
    const original = { arbitrary: "secret-bearing object" }
    const { diagnostics, logs, toasts } = harness()
    let caught: unknown
    try {
      await diagnostics.run(
        {
          hook: "wire.request",
          surface: "provider request body",
        },
        () => "UnscannableBodyError",
        async () => Promise.reject(original),
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(original)
    expect(logs[0]?.extra?.category).toBe("UnscannableBodyError")
    expect(logs[0]?.extra?.surface).toBe("provider request body")
    expect(toasts[0]?.message).toContain("unsupported body encoding")
    expect(toasts[0]?.message).toContain("supported text or JSON encoding")
    expect(toasts[0]?.overrides?.duration).toBe(15_000)
    expect(JSON.stringify(logs)).not.toContain("secret-bearing object")
  })

  test.each([
    [
      "WalkLimitError",
      "too large or deeply nested",
      "smaller or less-nested input",
    ],
    [
      "VaultLimitError",
      "secret vault filled",
      "smaller output, then restart OpenCode",
    ],
    ["OversizedBodyError", "oversized body", "smaller request body"],
    [
      "FingerprintLimitError",
      "Fingerprint recovery exceeded",
      "do not clear the redact-secrets catalog or key files",
    ],
  ] as const)(
    "%s gets a fixed surface-specific reason and action",
    (category, reason, guidance) => {
      const { diagnostics, logs, toasts } = harness()
      diagnostics.reportFailure(category, {
        hook: "experimental.chat.messages.transform",
        surface: "chat messages",
      })
      expect(logs[0]?.extra).toMatchObject({
        category,
        surface: "chat messages",
      })
      expect(String(logs[0]?.extra?.reason)).toContain(reason)
      expect(String(logs[0]?.extra?.guidance)).toContain(guidance)
      expect(toasts[0]?.message).toContain("chat messages")
      expect(toasts[0]?.message).toContain(reason)
      expect(toasts[0]?.message).toContain(guidance)
      expect(toasts[0]?.overrides?.duration).toBe(15_000)
    },
  )

  test("a broken classifier cannot replace the original exception", () => {
    const original = new Error("original")
    const { diagnostics, logs } = harness()
    let caught: unknown
    try {
      diagnostics.runSync(
        { hook: "config", surface: "agent descriptions" },
        () => {
          throw new Error("classifier failed")
        },
        () => {
          throw original
        },
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(original)
    expect(logs[0]?.extra?.category).toBe("UnexpectedError")
  })
})

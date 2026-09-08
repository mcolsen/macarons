import { afterEach, describe, expect, test } from "bun:test"
import { registerSourceRedactor } from "@macarons/permission-rules"
import {
  DEFAULT_OPTIONS,
  Redactor,
  redactWireRequest,
} from "../../redact-secrets/src/shared"
import {
  type classifierMessage,
  createClassifierPipeline,
} from "../src/server/classifier"
import { type ClassifierRequest, TRUNCATE_SUFFIX } from "../src/shared"

// Synthetic, shape-valid 40-character PAT. No provider authentication is used.
const PAT = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`
const scope = {
  directory: "/test/classifier-redaction",
  serverUrl: "http://classifier-redaction.test",
}
const judge = { model: { providerID: "separate-judge", modelID: "gate" } }
const request: ClassifierRequest = {
  permission: "bash",
  patterns: ["git status"],
  directory: scope.directory,
}
let release: (() => void) | undefined
afterEach(() => {
  release?.()
  release = undefined
})

function harness() {
  const messages: ReturnType<typeof classifierMessage>[] = []
  const calls: string[] = []
  const logs: string[] = []
  const isolatedClassifierSessions = new Set<string>()
  const pipeline = createClassifierPipeline({
    ...scope,
    classifierSessions: new Set(),
    isolatedClassifierSessions,
    textOfParts: () => "",
    log: (_level, message) => logs.push(message),
    api: async (method, pathname, body) => {
      calls.push(`${method} ${pathname}`)
      if (pathname === "/session") return { id: "ses_judge" }
      if (pathname.endsWith("/message")) {
        messages.push(body as ReturnType<typeof classifierMessage>)
        isolatedClassifierSessions.add("ses_judge")
        return {
          info: {
            structured: {
              decision: "approve",
              risk: "low",
              authorization: "implied",
              reason: "safe fixture",
            },
          },
        }
      }
      return true
    },
  })
  return {
    messages,
    calls,
    logs,
    classify: (source: ClassifierRequest) =>
      pipeline.classify(source, judge, 1_000, new AbortController().signal),
  }
}

describe("classifier source redaction before excerpts (issue #226)", () => {
  // Each old excerpt retained 39 of 40 token characters. Account for the JSON
  // prefix in structured sources, not just the length of the nested value.
  const cut = (limit: number, prefix = 0) =>
    `${"p".repeat(limit - prefix - 40)} ${PAT}`
  const sources: [string, Partial<ClassifierRequest>][] = [
    ["user history", { userMessages: [cut(2_000)] }],
    ["fallback task", { task: cut(2_000) }],
    ["child subtask", { subtask: cut(2_000) }],
    ["request title", { title: cut(400) }],
    ["metadata", { metadata: { note: cut(4_000, '{"note":"'.length) } }],
    ["call arguments", { callInput: { note: cut(4_000, '{"note":"'.length) } }],
    ["historical tool title", { toolTitles: [cut(120)] }],
    ["project guidance", { projectGuidance: cut(4_000) }],
  ]

  for (const [name, source] of sources) {
    test(`${name} cannot disclose a previously recognized token fragment`, async () => {
      const redactor = new Redactor(
        DEFAULT_OPTIONS,
        "226-test-installation-key",
      )
      expect(PAT).toHaveLength(40)
      expect(redactor.redactString(PAT)).toStartWith("[REDACTED-SECRET:")
      expect(redactor.vaultSize).toBe(1)
      release = registerSourceRedactor(scope, (snapshot) => {
        redactor.noteScanContextCached(JSON.stringify(snapshot))
        redactor.redactValueInPlace(snapshot)
      })
      const input = { ...request, ...source }
      const original = structuredClone(input)
      const api = harness()
      expect((await api.classify(input)).verdict?.decision).toBe("approve")
      expect(api.messages).toHaveLength(1)
      const message = api.messages[0]!
      expect(message.model).toEqual(judge.model)
      expect(message.parts[0]!.text).toContain("[REDACTED-SECRET:")
      expect(message.parts[0]!.text).toContain(TRUNCATE_SUFFIX)
      expect(message.parts[0]!.text.length).toBeLessThan(6_000)
      expect(input).toEqual(original)

      // Check the pre-hook payload too: passing only a full-token absence
      // assertion after the backstop already passed with the original bug.
      expect(JSON.stringify(message)).not.toContain(PAT)
      expect(JSON.stringify(message)).not.toContain(PAT.slice(0, 39))
      expect(JSON.stringify(message)).not.toContain(PAT.slice(0, 12))
      redactor.redactPartsInPlace(message.parts)
      const wire = await redactWireRequest(redactor, "http://judge.test", {
        method: "POST",
        body: JSON.stringify(message),
      })
      expect(typeof wire.init?.body).toBe("string")
      expect(wire.init!.body as string).not.toContain(PAT.slice(0, 39))
    })
  }

  test("non-excerpted classifier fields are redacted without changing the request", async () => {
    const redactor = new Redactor(DEFAULT_OPTIONS, "226-test-installation-key")
    release = registerSourceRedactor(scope, (snapshot) => {
      redactor.noteScanContextCached(JSON.stringify(snapshot))
      redactor.redactValueInPlace(snapshot)
    })
    const input = {
      ...request,
      permission: PAT,
      patterns: [PAT],
      directory: `/project/${PAT}`,
    }
    const original = structuredClone(input)
    const api = harness()
    expect((await api.classify(input)).verdict).toBeDefined()
    expect(JSON.stringify(api.messages)).not.toContain(PAT)
    expect(api.messages[0]!.parts[0]!.text).toContain("[REDACTED-SECRET:")
    expect(input).toEqual(original)
  })

  test("redaction failure leaves the permission undecided without creating a session", async () => {
    release = registerSourceRedactor(scope, () => {
      throw Object.assign(
        new Error(`unsafe scanner failure: ${PAT}`, {
          cause: new Error(PAT),
        }),
        { name: PAT },
      )
    })
    const api = harness()
    const result = await api.classify({ ...request, task: PAT })
    expect(result).toEqual({ failure: "source redaction failed" })
    expect(api.calls).toEqual([])
    expect(api.logs).toEqual([
      'classifier failed for "bash": source redaction failed',
    ])
    expect(JSON.stringify([result, api.logs])).not.toContain(PAT)
  })

  test("snapshot failure reports source redaction failure before invoking the producer or host", async () => {
    let redactions = 0
    release = registerSourceRedactor(scope, () => redactions++)
    const api = harness()
    const result = await api.classify({
      ...request,
      metadata: {
        toJSON() {
          throw new Error(PAT)
        },
      },
    })
    expect(result).toEqual({ failure: "source redaction failed" })
    expect(redactions).toBe(0)
    expect(api.calls).toEqual([])
    expect(api.logs).toEqual([
      'classifier failed for "bash": source redaction failed',
    ])
    expect(JSON.stringify([result, api.logs])).not.toContain(PAT)
  })
})

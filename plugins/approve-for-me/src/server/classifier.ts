import { redactSourceValue, trim } from "@macarons/permission-rules"
import {
  CLASSIFIER_SYSTEM_PROMPT,
  type ClassifierRequest,
  classifierUserPrompt,
  type ModelRef,
  parseVerdict,
  truncate,
  VERDICT_SCHEMA,
  type Verdict,
} from "../shared"
import { SafeCauseError } from "./host"

const CLASSIFIER_SESSION_TITLE = "approve-for-me classifier (throwaway)"

type Api = (
  method: string,
  pathname: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>
type Log = (level: "warn", message: string) => void

/** The fixed, isolated message payload sent to a classifier session. */
export function classifierMessage(
  request: ClassifierRequest,
  judge: { model: ModelRef; variant?: string },
) {
  return {
    model: judge.model,
    ...(judge.variant ? { variant: judge.variant } : {}),
    system: CLASSIFIER_SYSTEM_PROMPT,
    tools: { "*": false },
    format: {
      type: "json_schema" as const,
      schema: VERDICT_SCHEMA,
      retryCount: 1,
    },
    parts: [{ type: "text", text: classifierUserPrompt(request) }],
  }
}

/** Isolated throwaway-session execution and verdict parsing. */
export function createClassifierPipeline(input: {
  directory: string
  serverUrl: string | URL
  api: Api
  log: Log
  classifierSessions: Set<string>
  isolatedClassifierSessions: Set<string>
  textOfParts: (parts: unknown) => string
}) {
  const classify = async (
    request: ClassifierRequest,
    judge: { model: ModelRef; variant?: string },
    timeoutMs: number,
    userAnswered: AbortSignal,
  ): Promise<{ verdict?: Verdict; failure?: string }> => {
    const signal = AbortSignal.any([
      userAnswered,
      AbortSignal.timeout(timeoutMs),
    ])
    const outcome = (verdict: Verdict | undefined) => {
      if (verdict) return { verdict }
      input.log(
        "warn",
        `classifier failed for "${request.permission}": the reply was not a parseable verdict`,
      )
      return { failure: "the model's reply was not a parseable verdict" }
    }
    let sessionID: string | undefined
    try {
      // Redact complete sources before the formatter cuts any excerpts. The
      // ordinary chat/wire hooks cannot recognize a secret already cut here.
      let source: ClassifierRequest
      try {
        source = redactSourceValue(input, request)
      } catch {
        throw new SafeCauseError("source redaction failed")
      }
      const message = classifierMessage(source, judge)
      const created = (await input.api(
        "POST",
        "/session",
        {
          title: CLASSIFIER_SESSION_TITLE,
          permission: [{ permission: "*", pattern: "*", action: "deny" }],
        },
        signal,
      )) as { id?: unknown }
      if (typeof created.id !== "string")
        throw new SafeCauseError("session create returned no id")
      sessionID = created.id
      input.classifierSessions.add(sessionID)
      trim(input.classifierSessions)

      const response = (await input.api(
        "POST",
        `/session/${sessionID}/message`,
        message,
        signal,
      )) as { info?: unknown; parts?: unknown }

      if (!input.isolatedClassifierSessions.has(sessionID))
        throw new SafeCauseError(
          "classifier system prompt isolation hook did not run",
        )

      const info = (response.info ?? {}) as {
        error?: unknown
        structured?: unknown
      }
      if (info.error) {
        const name =
          info.error && typeof info.error === "object"
            ? (info.error as { name?: unknown }).name
            : undefined
        if (name !== "StructuredOutputError") {
          const statusCode =
            info.error && typeof info.error === "object"
              ? (info.error as { data?: { statusCode?: unknown } }).data
                  ?.statusCode
              : undefined
          throw new SafeCauseError(
            `classifier message reported an error: ${truncate(JSON.stringify(info.error), 300)}`,
            `the provider reported ${typeof name === "string" && name ? truncate(name, 60) : "an error"}${typeof statusCode === "number" ? ` (HTTP ${statusCode})` : ""}`,
          )
        }
        input.log(
          "warn",
          "classifier reported StructuredOutputError; parsing the text reply only",
        )
        return outcome(
          parseVerdict(undefined, input.textOfParts(response.parts)),
        )
      }
      return outcome(
        parseVerdict(info.structured, input.textOfParts(response.parts)),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      input.log(
        "warn",
        `classifier failed for "${request.permission}": ${message}`,
      )
      if (userAnswered.aborted) return {}
      return {
        failure: signal.aborted
          ? `no verdict within ${Math.round(timeoutMs / 1000)}s`
          : error instanceof SafeCauseError
            ? error.safeCause
            : `an unexpected ${error instanceof Error && error.name ? truncate(error.name, 60) : "error"}`,
      }
    } finally {
      if (sessionID) {
        const id = sessionID
        input.isolatedClassifierSessions.delete(id)
        void input
          .api(
            "POST",
            `/session/${id}/abort`,
            undefined,
            AbortSignal.timeout(10_000),
          )
          .catch(() => {})
          .then(() =>
            input
              .api(
                "DELETE",
                `/session/${id}`,
                undefined,
                AbortSignal.timeout(10_000),
              )
              .catch(() => {}),
          )
      }
    }
  }

  return { classify }
}

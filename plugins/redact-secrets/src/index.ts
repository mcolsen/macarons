import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { registerSourceRedactor } from "@macarons/permission-rules"
import { Plugin } from "@opencode/plugin"
import type { SessionRequest } from "@opencode/plugin/promise/session"
import {
  createRedactionDiagnostics,
  type RedactionFailureCategory,
} from "./diagnostics"
import {
  COMPACTION_NOTE,
  ENV_FILE_CANDIDATES,
  FingerprintLimitError,
  MAX_RECOVERY_FILE_BYTES,
  MAX_WIRE_BODY_BYTES,
  OversizedBodyError,
  parseOptions,
  redactWireRequest,
  SYSTEM_NOTE,
  UnscannableBodyError,
  VaultLimitError,
  WalkLimitError,
} from "./shared"
import { redactRequest } from "./v2-request"
import { createVault } from "./vault"

function failureCategory(error: unknown): RedactionFailureCategory {
  try {
    if (error instanceof FingerprintLimitError) return "FingerprintLimitError"
    if (error instanceof OversizedBodyError) return "OversizedBodyError"
    if (error instanceof UnscannableBodyError) return "UnscannableBodyError"
    if (error instanceof VaultLimitError) return "VaultLimitError"
    if (error instanceof WalkLimitError) return "WalkLimitError"
  } catch {
    /* An arbitrary thrown object can have a hostile prototype. */
  }
  return "UnexpectedError"
}

export const RedactSecretsPlugin = Plugin.define({
  id: "macarons.redact-secrets",
  async setup(ctx) {
    const diagnostics = createRedactionDiagnostics({
      log(level, message, extra) {
        console[level](`redact-secrets: ${message}`, extra ?? {})
        return true
      },
      // V2 server plugins have no TUI toast endpoint. The secret-safe log is
      // always available, including headless and remote sessions.
      toast: () => false,
    })
    const configDir =
      process.env.OPENCODE_CONFIG_DIR ||
      join(
        process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
        "opencode",
      )
    let legacy: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(configDir, "redact-secrets.json"), "utf8"),
      )
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        legacy = parsed as Record<string, unknown>
    } catch {
      /* An absent legacy options file is normal. */
    }
    const options = parseOptions({
      ...legacy,
      ...ctx.options,
      restoreText: false,
      stableHistory: false,
    })
    const vault = await createVault(options, diagnostics.onScanLimit)
    const { redactor } = vault
    const releaseSource = registerSourceRedactor(ctx.location, (value) => {
      diagnostics.runSync(
        { hook: "source.redaction", surface: "request sources" },
        failureCategory,
        () => {
          redactor.noteScanContextCached(JSON.stringify(value))
          redactor.redactValueInPlace(value)
        },
      )
    })
    const registrations: Array<{ dispose(): Promise<void> }> = []
    const inFlight = new Set<Promise<unknown>>()
    let closing = false
    let cleanupPromise: Promise<void> | undefined
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise
      closing = true
      releaseSource()
      cleanupPromise = (async () => {
        // Host unregistration removes callbacks but does not join invocations
        // already selected by its hook dispatcher. Drain those before flushing.
        await Promise.allSettled(
          registrations.map((registration) => registration.dispose()),
        )
        await Promise.allSettled([...inFlight])
        await vault.flush()
      })()
      return cleanupPromise
    }
    const run = <T>(
      hook: string,
      sessionID: string,
      surface: string,
      operation: () => T | Promise<T>,
    ): Promise<T> => {
      if (closing) return Promise.reject(new UnscannableBodyError())
      const pending = diagnostics.run(
        { hook, sessionID, surface },
        failureCategory,
        operation,
      )
      inFlight.add(pending)
      void pending.finally(() => inFlight.delete(pending)).catch(() => {})
      return pending
    }

    const scan = (
      kind: "context" | "compaction" | "title" | "generate",
      event: SessionRequest,
    ) =>
      run(kind, event.sessionID, "provider request body", () => {
        redactRequest(redactor, event)
        if (options.systemNote)
          event.system.push({ type: "text", text: SYSTEM_NOTE })
        if (kind === "compaction")
          event.system.push({ type: "text", text: COMPACTION_NOTE })
      })

    try {
      // Each request kind has its own V2 hook. Titles and transient generation
      // receive exactly the same protection as normal chat and compaction.
      for (const kind of [
        "context",
        "compaction",
        "title",
        "generate",
      ] as const) {
        registrations.push(
          await ctx.session.hook(kind, (event) => scan(kind, event)),
        )
      }
      registrations.push(
        await ctx.session.hook("http.request", (event) =>
          run(
            "http.request",
            event.sessionID,
            "provider request body",
            async () => {
              const result = await redactWireRequest(
                redactor,
                event.request,
                undefined,
              )
              event.request = result.init
                ? new Request(result.input as Request, result.init)
                : (result.input as Request)
            },
          ),
        ),
      )
      registrations.push(
        await ctx.session.hook("experimental.ws.send", (event) =>
          run(
            "experimental.ws.send",
            event.sessionID,
            "provider request body",
            () => {
              if (Buffer.byteLength(event.frame) > MAX_WIRE_BODY_BYTES)
                throw new OversizedBodyError()
              // Native provider frames are JSON. Never forward an uninspectable
              // frame after a future protocol change.
              try {
                JSON.parse(event.frame)
              } catch {
                throw new UnscannableBodyError()
              }
              event.frame = redactor.redactJsonBody(event.frame)
            },
          ),
        ),
      )

      const attempted = new Set<string>()
      const recover = async (value: unknown) => {
        const missing = redactor.collectUnresolved(value)
        const fresh = [...missing].filter((hash) => !attempted.has(hash))
        if (!fresh.length) return
        for (const hash of fresh) {
          attempted.add(hash)
          while (attempted.size > 4096)
            attempted.delete(attempted.values().next().value as string)
        }
        redactor.learnFrom(
          Object.entries(process.env)
            .map(([key, value]) => `${key}=${value ?? ""}`)
            .join("\n"),
        )
        for (const name of ENV_FILE_CANDIDATES) {
          const file = join(ctx.location.directory, name)
          let text: string
          try {
            const info = await stat(file)
            if (!info.isFile() || info.size > MAX_RECOVERY_FILE_BYTES) continue
            text = await readFile(file, "utf8")
          } catch {
            continue
          }
          // Scanner exceptions must propagate; only filesystem errors are ignored.
          redactor.learnFrom(text)
        }
      }
      registrations.push(
        await ctx.tool.hook("execute.before", (event) =>
          run("execute.before", event.sessionID, "tool arguments", async () => {
            // V2's recorded tool input and executor may share data. Replace the
            // input with an owned copy so local restoration cannot alter history.
            const input = {
              value: structuredClone(event.input),
              tool: event.tool,
            }
            await recover(input)
            redactor.restoreValueInPlace(input)
            event.input = input.value
            event.tool = input.tool
          }),
        ),
      )

      return cleanup
    } catch (error) {
      // Setup can fail after publishing the cross-plugin source redactor.
      // Roll it back together with every hook that already registered.
      await cleanup()
      throw error
    }
  },
})

export default RedactSecretsPlugin

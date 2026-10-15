import { createHash } from "node:crypto"
import { Media } from "@opencode/ai/media"
import { Message } from "@opencode/ai/schema/messages"
import type {
  SessionContext,
  SessionRequest,
} from "@opencode/plugin/promise/session"
import { OPAQUE_PROVIDER_KEYS, Redactor } from "./shared"

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)

// Opaque provider-issued continuation state is not credential-bearing prose.
// Exempt only the protocol's known paths, never similarly named tool inputs.
function shields() {
  const held: Array<() => void> = []
  return {
    hide(value: RecordValue, key: string) {
      if (typeof value[key] !== "string") return
      const original = value[key]
      value[key] = "[opaque-provider-state]"
      held.push(() => {
        value[key] = original
      })
    },
    restore() {
      for (const restore of held) restore()
    },
  }
}

function metadata(value: unknown, shield: ReturnType<typeof shields>) {
  if (!record(value)) return
  for (const state of Object.values(value)) {
    if (!record(state)) continue
    for (const field of Object.keys(state)) {
      if (OPAQUE_PROVIDER_KEYS.has(field.toLowerCase()))
        shield.hide(state, field)
    }
  }
}

function contentState(part: unknown, shield: ReturnType<typeof shields>) {
  if (!record(part)) return
  metadata(part.providerMetadata, shield)
  if (part.type === "reasoning" || part.type === "compaction") {
    shield.hide(part, "encrypted")
    shield.hide(part, "encrypted_content")
  }
  if (part.type === "thinking") shield.hide(part, "signature")
  if (part.type === "redacted_thinking") shield.hide(part, "data")
  // Gemini puts this signature beside the text/functionCall, not inside it.
  shield.hide(part, "thoughtSignature")
}

function protocolState(body: unknown, shield: ReturnType<typeof shields>) {
  if (!record(body)) return
  for (const field of ["messages", "input", "contents"]) {
    const messages = body[field]
    if (!Array.isArray(messages)) continue
    for (const message of messages) {
      if (!record(message)) continue
      contentState(message, shield)
      metadata(message.providerMetadata, shield)
      const content = message.content ?? message.parts
      if (Array.isArray(content))
        for (const part of content) contentState(part, shield)
    }
  }
}

/** The V2 backstop preserves encrypted protocol state on HTTP and WebSocket. */
export class WireRedactor extends Redactor {
  override redactJsonBody(body: string): string {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return super.redactJsonBody(body)
    }
    if (!record(parsed)) return super.redactJsonBody(body)
    const shield = shields()
    protocolState(parsed, shield)
    if (record(parsed.response)) protocolState(parsed.response, shield)
    const before = this.redactionCount
    const omissions = this.omissionCount
    this.noteScanContextCached(JSON.stringify(parsed))
    this.redactValueInPlace(parsed)
    shield.restore()
    return before === this.redactionCount && omissions === this.omissionCount
      ? body
      : JSON.stringify(parsed)
  }
}

/** Scan an owned wire-visible snapshot, then reconstruct V2's runtime values. */
export function redactRequest(redactor: Redactor, event: SessionRequest) {
  const hasTools = "tools" in event
  const sourceTools = hasTools ? (event as SessionContext).tools : undefined
  const names = event.messages.map((message) =>
    message.content.map((part) =>
      part.type === "tool-call" || part.type === "tool-result"
        ? part.name
        : undefined,
    ),
  )
  const snapshot = JSON.parse(
    JSON.stringify({
      system: event.system,
      messages: event.messages,
      options: event.options,
      ...(hasTools ? { tools: (event as SessionContext).tools } : {}),
    }),
  )
  // Keep each cloned definition reachable even when the generic walker masks
  // the map's keys. The host matches renamed tools by the ORIGINAL definition
  // object's identity; only its description and input are request-owned edits.
  const toolEntries = hasTools ? Object.entries(snapshot.tools) : []
  const shield = shields()
  protocolState(snapshot, shield)

  // Asset.toJSON encodes bytes in base64. Scan the decoded attachment bytes,
  // using the existing magic-byte policy, then protect that encoded payload
  // from the generic text walker. Recreate Asset to retain its runtime methods.
  const attachments: Array<() => () => void> = []
  for (const message of snapshot.messages) {
    for (const part of message.content) {
      // Tool-result file content uses a URI rather than Media.Asset until
      // protocol lowering. Inspect encoded payloads here as well.
      if (
        part.type === "tool-result" &&
        part.result?.type === "content" &&
        Array.isArray(part.result.value)
      ) {
        for (const file of part.result.value) {
          if (file.type !== "file" || typeof file.uri !== "string") continue
          const original = file.uri
          attachments.push(() => {
            const uri = redactor.redactAttachmentUrl(original)
            return () => {
              file.uri = uri
            }
          })
        }
      }
      if (part.type !== "media") continue
      const source = part.media.source
      if (source.type === "bytes" || source.type === "base64") {
        const original = source.data
        source.data = "[attachment-payload]"
        attachments.push(() => {
          const uri = redactor.redactAttachmentUrl(
            `data:${source.mediaType};base64,${original}`,
          )
          const data = uri.slice(uri.indexOf(",") + 1)
          return () => {
            source.data = data
          }
        })
      } else if (source.type === "url") {
        const original = source.url
        attachments.push(() => {
          const url = redactor.redactAttachmentUrl(original)
          return () => {
            source.url = url
          }
        })
      }
      metadata(part.media.providerMetadata, shield)
    }
  }
  redactor.noteScanContextCached(JSON.stringify(snapshot))
  redactor.redactValueInPlace(snapshot)
  // Each attachment sees every request keyword and every secret learned by
  // its siblings. Newly discovered attachment secrets also mask earlier text.
  for (const scan of attachments) scan()
  const restoreAttachments = attachments.map((scan) => scan())
  redactor.redactValueInPlace(snapshot)
  for (const restore of restoreAttachments) restore()
  shield.restore()
  event.system = snapshot.system
  event.options = snapshot.options
  const wireName = (name: string): string => {
    const masked = redactor.redactString(name)
    if (masked === name) return name
    // Placeholder punctuation is not a legal provider function name. Hash only
    // the already-redacted name (including keyed placeholders), never a secret.
    return `macarons_redacted_${createHash("sha256").update(masked).digest("hex").slice(0, 24)}`
  }
  if (sourceTools) {
    const tools: SessionContext["tools"] = {}
    for (const [name, value] of toolEntries) {
      const definition = sourceTools[name]
      if (
        !definition ||
        !record(value) ||
        typeof value.description !== "string" ||
        !record(value.input)
      )
        throw new Error("Tool definition could not be redacted")
      const alias = wireName(name)
      if (Object.hasOwn(tools, alias))
        throw new Error("Redacted tool alias is ambiguous")
      definition.description = value.description
      definition.input = value.input
      Object.defineProperty(tools, alias, {
        value: definition,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    ;(event as SessionContext).tools = tools
  }
  event.messages = snapshot.messages.map((message: RecordValue, i: number) => {
    const content = message.content as Array<RecordValue>
    content.forEach((part, j) => {
      const name = names[i]?.[j]
      if (name !== undefined) part.name = wireName(name)
      if (part.type !== "media") return
      const asset = part.media as Media.Asset.Input
      const original = event.messages[i]?.content[j]
      const source = asset.source
      part.media = new Media.Asset({
        ...asset,
        source:
          source.type === "bytes"
            ? {
                ...source,
                data: Buffer.from(source.data as unknown as string, "base64"),
              }
            : source,
        ...(original?.type === "media"
          ? { headers: original.media.headers }
          : {}),
      })
    })
    return new Message(
      message as unknown as ConstructorParameters<typeof Message>[0],
    )
  })
}

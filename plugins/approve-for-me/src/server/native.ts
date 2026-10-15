import type { Rule } from "@macarons/permission-rules"
import type { PermissionRequest, SessionMessageInfo } from "@opencode/client"

/** Normalize host records to the classifier's stable internal policy vocabulary. */
export function toPermissionRequest(value: unknown) {
  const request = value as PermissionRequest
  if (
    !request ||
    typeof request.action !== "string" ||
    !Array.isArray(request.resources)
  )
    return undefined
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.action,
    patterns: request.resources,
    always: request.save,
    metadata: request.metadata,
    title: request.message,
    tool:
      request.source?.type === "tool"
        ? { messageID: request.source.messageID, callID: request.source.id }
        : undefined,
  }
}

export function nativeRules(
  rules: readonly {
    action: string
    resource: string
    effect: "allow" | "ask" | "deny"
  }[],
): Rule[] {
  return rules.map((rule) => ({
    permission: rule.action,
    pattern: rule.resource,
    action: rule.effect,
  }))
}

export function messageParts(
  message: SessionMessageInfo | undefined,
): unknown[] {
  if (!message) return []
  if (message.type === "user")
    return [{ type: "text", text: message.text, metadata: message.metadata }]
  if (message.type !== "assistant") return []
  return message.content.map((part) => {
    if (part.type !== "tool") return part
    return {
      ...part,
      tool: part.name,
      callID: part.id,
      state: {
        ...part.state,
        title:
          part.state.status === "streaming"
            ? undefined
            : typeof part.state.input.command === "string"
              ? part.state.input.command
              : part.name,
      },
    }
  })
}

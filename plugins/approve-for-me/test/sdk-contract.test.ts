import { expect, test } from "bun:test"
import { normalizeRequest } from "@macarons/permission-rules"
import type { PermissionRequest } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { nativeRules, toPermissionRequest } from "../src/server/native"

test("native permission records preserve all resources and tool provenance", () => {
  const request = {
    id: "per_1",
    sessionID: "ses_root",
    action: "shell",
    resources: ["git status", "git diff"],
    save: ["git *"],
    source: { type: "tool", messageID: "msg_tool", id: "call_1" },
  } satisfies PermissionRequest
  expect(normalizeRequest(toPermissionRequest(request))).toMatchObject({
    permission: "shell",
    patterns: request.resources,
    always: request.save,
    toolCall: { messageID: "msg_tool", callID: "call_1" },
  })
  expect(
    nativeRules([{ action: "shell", resource: "git push*", effect: "deny" }]),
  ).toEqual([{ permission: "shell", pattern: "git push*", action: "deny" }])
})

const reply = {
  sessionID: "ses_root",
  requestID: "per_1",
  decision: "once",
} satisfies Parameters<Plugin.Context["permission"]["reply"]>[0]
const create = {
  title: "judge",
  model: { providerID: "test", id: "judge" },
  permissions: [{ action: "*", resource: "*", effect: "deny" }],
} satisfies Parameters<Plugin.Context["session"]["create"]>[0]
test("native approval and isolated session contracts compile", () => {
  expect(reply.decision).toBe("once")
  expect(create.permissions[0]?.effect).toBe("deny")
})

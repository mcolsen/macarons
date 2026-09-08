import { expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk"

// Compile-time guard for the ONE host surface btw reaches through a structural
// cast the compiler cannot see through. rejectPermission (src/index.ts:138-146)
// binds `postSessionIdPermissionsPermissionId` off a `client as { … }` cast and
// returns silently when it is absent (`if (!respond) return`). Because the cast
// supplies the method's shape itself, an SDK rename of the real route leaves
// the whole suite green — server.test.ts:215-232 only asserts against a stub
// that also defines the name (server.test.ts:65) — while the server half's
// auto-deny becomes a permanent no-op: a headless install then sits on
// unanswered permission prompts, or a co-installed auto-approver answers them.
// Pinning the real method's option shape here fails `bun run typecheck` on that
// rename instead.
//
// btw's other host routes (session.fork/update/promptAsync, permission.reply)
// flow through the real OpencodeClient-typed parameter in shared.ts, so tsc
// already pins them at the call site; re-pinning them here would only restate a
// type the source already declares.
type RejectOptions = Parameters<
  OpencodeClient["postSessionIdPermissionsPermissionId"]
>[0]

const rejectCall: RejectOptions = {
  path: { id: "ses_123", permissionID: "per_123" },
  body: { response: "reject" },
  query: { directory: "/some/project" },
}

test("the auto-deny reply call shape matches the SDK contract", () => {
  expect(rejectCall.body?.response).toBe("reject")
})

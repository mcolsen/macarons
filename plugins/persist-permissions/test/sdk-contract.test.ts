import { expect, test } from "bun:test"
import type { Event, OpencodeClient } from "@opencode-ai/sdk"
import type { OpencodeClient as TuiOpencodeClient } from "@opencode-ai/sdk/v2"

// Compile-time guard: the reply call the plugin makes must match the real
// generated SDK client. If the SDK renames the method or reshapes its
// options, `bun x tsc --noEmit` fails here.
type ReplyOptions = Parameters<
  OpencodeClient["postSessionIdPermissionsPermissionId"]
>[0]

const replyCall: ReplyOptions = {
  path: { id: "ses_123", permissionID: "per_123" },
  body: { response: "always" },
  query: { directory: "/some/project" },
}

test("reply call shape matches the SDK contract", () => {
  expect(replyCall.body?.response).toBe("always")
})

// Same guard for the diagnostic log call (client.app.log).
type LogOptions = Parameters<OpencodeClient["app"]["log"]>[0]

const logCall: LogOptions = {
  body: {
    service: "persist-permissions",
    level: "info",
    message: "hello",
    extra: { detail: 1 },
  },
}

test("log call shape matches the SDK contract", () => {
  expect(logCall?.body?.service).toBe("persist-permissions")
})

// Same guard for the session-ruleset lookup — and this one is load-bearing for
// safety, not just shape. resolveSessionRules fails CLOSED when the method is
// absent, so an SDK rename would silently pause every auto-approval at runtime
// with nothing but a warn to show for it; the build must fail here instead.
// The RESPONSE cannot be pinned the same way: the generated Session type has no
// `permission` field even though the server serves one, which is exactly why
// sessionRulesOf parses defensively rather than trusting a type.
type SessionGetOptions = Parameters<OpencodeClient["session"]["get"]>[0]

const sessionGetCall: SessionGetOptions = {
  path: { id: "ses_123" },
  query: { directory: "/some/project" },
}

test("session lookup call shape matches the SDK contract", () => {
  expect(sessionGetCall?.path?.id).toBe("ses_123")
})

// The config-directory probe, including the cancellation channel. The plugin
// calls this through a structurally-typed `(input?: unknown) => …` handle (the
// injected client is not always the generated class), so `signal` would be
// accepted by the compiler whatever the SDK does — this is the only place that
// checks the option really exists. If it stops being passed through, a probe
// that loses the timeout race can no longer be cancelled and the accumulation
// that abort exists to prevent comes back silently.
type PathGetOptions = Parameters<OpencodeClient["path"]["get"]>[0]

const pathGetCall: PathGetOptions = {
  query: { directory: "/some/project" },
  signal: new AbortController().signal,
}

test("path lookup call shape, with cancellation, matches the SDK contract", () => {
  expect(pathGetCall?.signal).toBeInstanceOf(AbortSignal)
})

// The TUI companion answers the prompt through the v2 client (a different
// surface: flat parameters, request config in a SECOND argument). Both are
// pinned because the flow's cleanup lives in a finally the reply's await has to
// reach: if the config argument stops carrying `signal`, the timeout can still
// release the flow but the request behind it is no longer cancelled.
type ReplyParameters = Parameters<TuiOpencodeClient["permission"]["reply"]>
const tuiReplyCall: ReplyParameters = [
  { requestID: "per_123", reply: "always", directory: "/some/project" },
  { signal: new AbortController().signal },
]

test("TUI permission reply shape, with cancellation, matches the v2 SDK contract", () => {
  expect(tuiReplyCall[0].reply).toBe("always")
  expect(tuiReplyCall[1]?.signal).toBeInstanceOf(AbortSignal)
})

// Inbound event-shape pin. The server half's hook is typed `event: Event` from
// @opencode-ai/sdk (v1). That union's replied member carries
// { sessionID, permissionID, response } — NOT requestID/reply — and its ask
// member is permission.updated (v1 has no permission.asked). index.ts reads
// these through the `?? props.permissionID` / `?? props.response` fallbacks; if
// the SDK reshapes the union, `bun x tsc --noEmit` must fail here.
type RepliedProperties = Extract<
  Event,
  { type: "permission.replied" }
>["properties"]

const repliedProperties: RepliedProperties = {
  sessionID: "ses_123",
  permissionID: "per_123",
  response: "always",
}

// permissionID and response must both be present and assignable to string.
const permissionID: string = repliedProperties.permissionID
const response: string = repliedProperties.response

// The v1 ask member the server half auto-approves on is permission.updated;
// extracting it must not collapse to `never`.
type UpdatedEvent = Extract<Event, { type: "permission.updated" }>
const updatedType: UpdatedEvent["type"] = "permission.updated"

test("inbound v1 Event shapes match the SDK contract", () => {
  expect(permissionID).toBe("per_123")
  expect(response).toBe("always")
  expect(updatedType).toBe("permission.updated")
})

import { expect, test } from "bun:test"
import {
  createOpencodeClient,
  type OpencodeClient,
  type Path,
} from "@opencode-ai/sdk"
import type {
  AssistantMessage,
  EventPermissionAsked,
  SessionAbortData,
  SessionCreateData,
  SessionDeleteData,
  SessionMessageData,
  SessionPromptData,
} from "@opencode-ai/sdk/v2"
import { VERDICT_SCHEMA } from "../src/shared"

// Compile-time guards: every host surface the plugin touches must match the
// real generated SDK. If OpenCode renames a method, reshapes options, or
// moves a route, `bun run typecheck` fails here instead of the plugin
// silently breaking at runtime.

// --- v1 client methods used through the injected plugin client -------------

type ReplyOptions = Parameters<
  OpencodeClient["postSessionIdPermissionsPermissionId"]
>[0]
const replyCall: ReplyOptions = {
  path: { id: "ses_123", permissionID: "per_123" },
  body: { response: "once" },
  query: { directory: "/some/project" },
}
test("reply call shape matches the SDK contract — and 'once' is a legal response", () => {
  expect(replyCall.body?.response).toBe("once")
})

type LogOptions = Parameters<OpencodeClient["app"]["log"]>[0]
const logCall: LogOptions = {
  body: {
    service: "approve-for-me",
    level: "info",
    message: "hello",
    extra: { detail: 1 },
  },
}
test("log call shape matches the SDK contract", () => {
  expect(logCall?.body?.service).toBe("approve-for-me")
})

type ConfigGetOptions = Parameters<OpencodeClient["config"]["get"]>[0]
type ProvidersOptions = Parameters<OpencodeClient["config"]["providers"]>[0]
type PathGetOptions = Parameters<OpencodeClient["path"]["get"]>[0]
const configCall: ConfigGetOptions = { query: { directory: "/some/project" } }
const providersCall: ProvidersOptions = {
  query: { directory: "/some/project" },
}
const pathCall: PathGetOptions = { query: { directory: "/some/project" } }
test("config, providers, and path lookups match the SDK contract", () => {
  expect(configCall?.query?.directory).toBe("/some/project")
  expect(providersCall?.query?.directory).toBe("/some/project")
  expect(pathCall?.query?.directory).toBe("/some/project")
})

// The plugin reads the global config and state directories from Path.
const pathShape: Path = {
  state: "/s",
  config: "/c",
  worktree: "/w",
  directory: "/d",
}
test("Path carries the state and config directories", () => {
  expect(pathShape.state).toBe("/s")
  expect(pathShape.config).toBe("/c")
})

type SessionGetOptions = Parameters<OpencodeClient["session"]["get"]>[0]
type SessionMessagesOptions = Parameters<
  OpencodeClient["session"]["messages"]
>[0]
const sessionGetCall: SessionGetOptions = {
  path: { id: "ses_123" },
  query: { directory: "/p" },
}
// `limit` bounds the history fetch to the newest N messages — supported by
// every host in the pinned band (route schema verified against 1.17.14 and
// 1.18.1 sources).
const sessionMessagesCall: SessionMessagesOptions = {
  path: { id: "ses_123" },
  query: { directory: "/p", limit: 200 },
}
test("session lookups match the SDK contract", () => {
  expect(sessionGetCall.path.id).toBe("ses_123")
  expect(sessionMessagesCall.path.id).toBe("ses_123")
  expect(sessionMessagesCall.query?.limit).toBe(200)
})

// The effective-ruleset check reads the resolved agent list. Only the call
// shape is pinned here: the generated Agent type still declares `permission`
// as the config-style object, but a live supported host serves the resolved
// ordered rule array ({permission, pattern, action}[]) — same for the
// `permission` field GET /session/{id} returns, which the generated Session
// type omits entirely. Both payloads are therefore validated at runtime
// (parseRuleArray) instead of pinned against the stale generated types.
type AgentsOptions = Parameters<OpencodeClient["app"]["agents"]>[0]
const agentsCall: AgentsOptions = { query: { directory: "/some/project" } }
test("agent list call shape matches the SDK contract", () => {
  expect(agentsCall?.query?.directory).toBe("/some/project")
})

type ToastOptions = Parameters<OpencodeClient["tui"]["showToast"]>[0]
const toastCall: ToastOptions = {
  body: { message: "Approved bash: git status", variant: "success" },
  query: { directory: "/p" },
}
test("toast call shape matches the SDK contract", () => {
  expect(toastCall?.body?.variant).toBe("success")
})

// --- the raw transport used by the probe and the classifier session --------
//
// probeOpenCodeVersion reads /global/health through the SDK's underlying
// hey-api client (client._client), and the plugin drives its classifier
// session routes through the same transport — the only paths that work in a
// standalone TUI, where serverUrl is never bound. The field is typed
// `protected`, so this pin is a runtime one; constructing the client issues
// no requests.
test("the generated client still carries the raw transport the plugin uses", () => {
  const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:9" })
  const transport = (
    client as unknown as { _client?: { get?: unknown; request?: unknown } }
  )._client
  expect(typeof transport?.get).toBe("function")
  expect(typeof transport?.request).toBe("function")
})

// --- routes driven through the raw transport for the classifier session ----
//
// The injected v1 client cannot express the fields the classifier needs
// (session-create `permission`, prompt `format`), so the plugin calls these
// routes itself — through the raw transport above, or raw fetch when a
// client carries no transport. The v2 SDK types pin each route's URL and
// body shape; if the host reshapes them, these assignments stop compiling.

const createUrl: SessionCreateData["url"] = "/session"
const createBody: NonNullable<SessionCreateData["body"]> = {
  title: "approve-for-me classifier (throwaway)",
  permission: [{ permission: "*", pattern: "*", action: "deny" }],
}

const promptUrl: SessionPromptData["url"] = "/session/{sessionID}/message"
const promptBody: NonNullable<SessionPromptData["body"]> = {
  model: { providerID: "e2e", modelID: "test" },
  variant: "high",
  system: "You are a permission gatekeeper…",
  tools: { "*": false },
  format: {
    type: "json_schema",
    schema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
    retryCount: 1,
  },
  parts: [{ type: "text", text: "Permission request: …" }],
}

const abortUrl: SessionAbortData["url"] = "/session/{sessionID}/abort"
const deleteUrl: SessionDeleteData["url"] = "/session/{sessionID}"
// The pending-call recovery reads one message by id — the route the plugin
// resolves the permission event's tool pointer against.
const messageUrl: SessionMessageData["url"] =
  "/session/{sessionID}/message/{messageID}"

test("classifier session routes and bodies match the v2 SDK contract", () => {
  expect(createUrl).toBe("/session")
  expect(createBody.permission?.[0]?.action).toBe("deny")
  expect(promptUrl).toBe("/session/{sessionID}/message")
  expect(promptBody.format?.type).toBe("json_schema")
  expect(abortUrl).toContain("/abort")
  expect(deleteUrl).toBe("/session/{sessionID}")
  expect(messageUrl).toBe("/session/{sessionID}/message/{messageID}")
})

test("approval attribution and reply initiation contain no await gap", async () => {
  const source = await Bun.file(
    new URL("../src/index.ts", import.meta.url),
  ).text()
  const start = source.indexOf(
    "    // Registered BEFORE the POST: the host publishes the replied event",
  )
  const end = source.indexOf("    if (await reply(request))", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  expect(source.slice(start, end)).not.toMatch(/\bawait\b/)
})

// The verdict comes back on the assistant message's structured field.
type Structured = AssistantMessage["structured"]
const structured: Structured = {
  decision: "approve",
  risk: "low",
  authorization: "implied",
  reason: "read-only",
}
test("AssistantMessage still carries structured output", () => {
  expect((structured as { decision?: string }).decision).toBe("approve")
})

// The event fields normalizeRequest and the classifier prompt rely on —
// including the tool-call pointer that pending-call recovery resolves.
const askedProperties: EventPermissionAsked["properties"] = {
  id: "per_1",
  sessionID: "ses_1",
  permission: "bash",
  patterns: ["git status"],
  always: ["git status *"],
  metadata: { description: "check working tree" },
  tool: { messageID: "msg_1", callID: "call_1" },
}
test("permission.asked event properties match the v2 SDK contract", () => {
  expect(askedProperties.permission).toBe("bash")
  expect(askedProperties.patterns).toEqual(["git status"])
  expect(askedProperties.tool?.callID).toBe("call_1")
})

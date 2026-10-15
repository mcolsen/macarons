import { expect, test } from "bun:test"
import { type Credential, Integration } from "@opencode/plugin"
import { CodexLimitsPlugin, codexAuthStore } from "../src/index"

test("exports a native server plugin definition", () => {
  expect(CodexLimitsPlugin.id).toBe("macarons.codex-limits")
  expect(typeof CodexLimitsPlugin.setup).toBe("function")
})

test("accepts only active ChatGPT OAuth methods and never forwards refresh tokens", () => {
  const credential = {
    type: "oauth",
    methodID: Integration.MethodID.make("chatgpt-browser"),
    access: "access",
    refresh: "secret-refresh",
    expires: 9999999999999,
    metadata: { accountID: "account" },
  } as Credential.Value
  expect(codexAuthStore(credential)).toEqual({
    openai: {
      type: "oauth",
      access: "access",
      expires: 9999999999999,
      accountId: "account",
    },
  })
  expect(
    codexAuthStore({
      ...credential,
      methodID: Integration.MethodID.make("another-provider"),
    } as Credential.Value),
  ).toBeUndefined()
  expect(codexAuthStore({ type: "key", key: "api-key" })).toBeUndefined()
  expect(codexAuthStore(undefined)).toBeUndefined()
})

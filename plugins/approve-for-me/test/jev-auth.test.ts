import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { readJevApiKey, registerJevIntegration } from "../src/server/jev-auth"

test("registers TypeSafe key and env integration without a chat model", async () => {
  const methods: unknown[] = []
  const entry = { name: "" }
  const host = {
    integration: {
      transform: async (callback: any) => {
        callback({
          update: (id: string, fn: any) => {
            expect(id).toBe("typesafe")
            fn(entry)
          },
          method: { update: (method: unknown) => methods.push(method) },
        })
        return { dispose: async () => {} }
      },
    },
  } as unknown as Plugin.Context
  await registerJevIntegration(host)
  expect(entry.name).toBe("TypeSafe (Jev)")
  expect(methods).toEqual([
    {
      integrationID: "typesafe",
      method: { type: "key", label: "TypeSafe API key" },
    },
    {
      integrationID: "typesafe",
      method: { type: "env", names: ["TYPESAFE_API_KEY"] },
    },
  ])
})

test("native credentials take precedence and logout is observed", async () => {
  let key: string | undefined = " saved-key "
  const integration = {
    connection: {
      active: async () => (key ? { id: "connection" } : undefined),
      resolve: async () => ({ type: "key", key }),
    },
  } as unknown as Plugin.Context["integration"]
  const input = { env: { TYPESAFE_API_KEY: "env-key" }, homedir: "/unused" }
  expect(await readJevApiKey(input, integration)).toBe("saved-key")
  key = "new-key"
  expect(await readJevApiKey(input, integration)).toBe("new-key")
  key = undefined
  expect(await readJevApiKey(input, integration)).toBe("env-key")
})

test("retired inline auth stores are never read", async () => {
  expect(
    await readJevApiKey({
      env: {
        OPENCODE_AUTH_CONTENT: JSON.stringify({
          typesafe: { type: "api", key: "legacy" },
        }),
      },
      homedir: "/unused",
    }),
  ).toBeUndefined()
})

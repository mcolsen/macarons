import { describe, expect, test } from "bun:test"
import type { Config } from "@opencode-ai/plugin"
import {
  jevAuth,
  readJevApiKey,
  registerJevProvider,
} from "../src/server/jev-auth"

test("registers TypeSafe API login without advertising Jev as a chat model", async () => {
  const config: Config = {}
  await registerJevProvider(config)
  expect(config.provider?.typesafe).toEqual({
    name: "TypeSafe (Jev)",
    env: ["TYPESAFE_API_KEY"],
    models: {},
  })
  expect(jevAuth).toEqual({
    provider: "typesafe",
    methods: [{ type: "api", label: "TypeSafe API key" }],
  })
  const existing: Config = {
    provider: {
      typesafe: {
        name: "My TypeSafe",
        env: ["CUSTOM_KEY"],
        models: { other: {} },
      },
    },
  }
  const original = structuredClone(existing)
  await registerJevProvider(existing)
  expect(existing).toEqual(original)
})

describe("Jev credentials", () => {
  test("uses the server's data directory and observes key replacement and logout", async () => {
    let store: Record<string, unknown> = {
      typesafe: { type: "api", key: " saved-key " },
    }
    const reads: string[] = []
    const input = {
      env: {
        XDG_DATA_HOME: "/server/data",
        TYPESAFE_API_KEY: " env-key ",
      },
      homedir: "/server/home",
      readFile: async (file: string) => {
        reads.push(file)
        return JSON.stringify(store)
      },
    }
    expect(await readJevApiKey(input)).toBe("saved-key")
    store = { typesafe: { type: "api", key: "replacement-key" } }
    expect(await readJevApiKey(input)).toBe("replacement-key")
    store = {}
    expect(await readJevApiKey(input)).toBe("env-key")
    delete (input.env as Record<string, string>).TYPESAFE_API_KEY
    expect(await readJevApiKey(input)).toBeUndefined()
    expect(reads).toEqual(Array(4).fill("/server/data/opencode/auth.json"))
  })

  test("an inline auth store overrides the saved file wholesale", async () => {
    let reads = 0
    const input = {
      env: {
        OPENCODE_AUTH_CONTENT: JSON.stringify({
          typesafe: { type: "api", key: "inline-key" },
        }),
      },
      homedir: "/server/home",
      readFile: async () => {
        reads++
        return JSON.stringify({ typesafe: { type: "api", key: "file-key" } })
      },
    }
    expect(await readJevApiKey(input)).toBe("inline-key")
    input.env.OPENCODE_AUTH_CONTENT = "{}"
    expect(await readJevApiKey(input)).toBeUndefined()
    expect(reads).toBe(0)
  })

  test("accepts only usable TypeSafe API credentials, including unvalidated inline entries", async () => {
    for (const entry of [
      null,
      [],
      { type: "api" },
      { type: "api", key: 123 },
      { type: "api", key: "   " },
      { type: "api", key: "key", metadata: { invalid: 123 } },
      { type: "oauth", access: "not-an-api-key", refresh: "", expires: 0 },
    ]) {
      const input = {
        env: { OPENCODE_AUTH_CONTENT: JSON.stringify({ typesafe: entry }) },
        homedir: "/server/home",
      }
      expect(await readJevApiKey(input)).toBeUndefined()
    }
    expect(
      await readJevApiKey({
        env: {
          OPENCODE_AUTH_CONTENT: JSON.stringify({
            other: { type: "api", key: "wrong-provider-key" },
          }),
        },
        homedir: "/server/home",
      }),
    ).toBeUndefined()
  })

  test("missing or unreadable saved credentials retain the environment fallback", async () => {
    expect(
      await readJevApiKey({
        env: { TYPESAFE_API_KEY: "env-key" },
        homedir: "/server/home",
        readFile: async () => {
          throw new Error("unreadable auth store")
        },
      }),
    ).toBe("env-key")
  })
})

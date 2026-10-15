import { expect, test } from "bun:test"
import { classifierProvider, rpcDefinition } from "../src/interop"

test("classifier quota relevance comes from the owning server location", async () => {
  const client = {
    rpc: (definition: unknown) => {
      expect(definition).toBe(rpcDefinition)
      return {
        classifierProvider: async (input: unknown, options: unknown) => {
          expect(input).toEqual({ sessionID: "ses_root" })
          expect(options).toMatchObject({ location: { directory: "/project" } })
          return { providerID: "openai" }
        },
      }
    },
  } as unknown as Parameters<typeof classifierProvider>[0]
  expect(
    await classifierProvider(client, { directory: "/project" }, "ses_root"),
  ).toBe("openai")
})

test("unavailable companions have no active classifier provider", async () => {
  const client = {
    rpc: () => ({
      classifierProvider: async () => {
        throw new Error("offline")
      },
    }),
  } as unknown as Parameters<typeof classifierProvider>[0]
  expect(
    await classifierProvider(client, { directory: "/project" }, "ses_root"),
  ).toBeUndefined()
})

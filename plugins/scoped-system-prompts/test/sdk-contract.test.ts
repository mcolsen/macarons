import { expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"

type SystemTransform = NonNullable<Hooks["experimental.chat.system.transform"]>
type HookModel = Parameters<SystemTransform>[0]["model"]
type HookOutput = Parameters<SystemTransform>[1]

type HasProviderID = "providerID" extends keyof HookModel ? true : false
type HasID = "id" extends keyof HookModel ? true : false
type HasMessageModelID = "modelID" extends keyof HookModel ? true : false
type MutableSystem = HookOutput["system"] extends string[] ? true : false

const contract = {
  providerID: true as HasProviderID,
  id: true as HasID,
  messageModelID: false as HasMessageModelID,
  mutableSystem: true as MutableSystem,
}

test("the pinned system hook exposes the selectable model id and mutable array", () => {
  expect(contract).toEqual({
    providerID: true,
    id: true,
    messageModelID: false,
    mutableSystem: true,
  })

  const output: HookOutput = { system: ["base"] }
  const original = output.system
  output.system.splice(0, output.system.length, "replacement")
  expect(output.system).toBe(original)
  expect(output.system).toEqual(["replacement"])
})

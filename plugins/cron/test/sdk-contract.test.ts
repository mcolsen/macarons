import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"

type PromptInput = Parameters<Plugin.Context["session"]["prompt"]>[0]
const prompt = {
  sessionID: "ses_root",
  id: "msg_cron",
  text: "check the deploy",
  delivery: "queue",
} satisfies PromptInput

test("uses the V2 queued prompt contract without overriding agent or model", () => {
  expect(prompt.delivery).toBe("queue")
  expect(Object.keys(prompt).sort()).toEqual([
    "delivery",
    "id",
    "sessionID",
    "text",
  ])
})

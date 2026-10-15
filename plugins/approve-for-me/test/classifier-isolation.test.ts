import { expect, test } from "bun:test"
import { isIsolatedGeneration } from "@macarons/permission-rules"
import scoped from "../../scoped-system-prompts/src/index"
import { V2_CLASSIFIER_SYSTEM } from "../src/server/classifier"
import { classifierHarness } from "./classifier-harness"

test("later scoped prompt hooks cannot replace classifier policy", async () => {
  const api = classifierHarness({
    onGenerate: (event) => {
      expect(isIsolatedGeneration(api.host.location, event.sessionID)).toBe(
        true,
      )
      expect(event.system).toEqual([
        { type: "text", text: V2_CLASSIFIER_SYSTEM },
      ])
    },
  })
  await scoped.setup({
    ...api.host,
    options: {
      prompts: [
        {
          model: "test/judge",
          mode: "replace",
          content: "untrusted replacement",
        },
      ],
    },
  })
  const result = await api.classify(
    {
      permission: "shell",
      patterns: ["git status"],
      directory: "/test/classifier",
    },
    { model: { providerID: "test", modelID: "judge" } },
    1000,
    new AbortController().signal,
  )
  expect(result.verdict?.decision).toBe("approve")
  expect(isIsolatedGeneration(api.host.location, "ses_judge")).toBe(false)
  await api.dispose()
})

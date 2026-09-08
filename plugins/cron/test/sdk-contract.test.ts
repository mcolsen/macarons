import { expect, test } from "bun:test"
import type { Plugin } from "@opencode-ai/plugin"

// Compile-time pins for the promptAsync body cron sends on every fire. The body
// is assembled as a pre-annotated LOCAL VARIABLE (src/plugin.ts:369-381), which
// defeats the excess-property check at the call site — so a host rename of a
// field the plugin relies on would typecheck clean, and the hand-written fake
// client in plugin.test.ts would happily record whatever was sent. These pins
// put the check back where the widened variable removed it.
type Client = Parameters<Plugin>[0]["client"]
type PromptBody = NonNullable<
  NonNullable<Parameters<Client["session"]["promptAsync"]>[0]>["body"]
>

// The declared fields the plugin echoes back onto a re-pinned fire. A fresh
// literal under `satisfies` is excess-property-checked, so this breaks if the
// SDK drops or renames agent / model / messageID / parts.
const body = {
  agent: "build",
  model: { providerID: "anthropic", modelID: "claude-x" },
  messageID: "msg_1",
  parts: [{ type: "text", text: "fired prompt" }],
} satisfies PromptBody

// `variant` IS accepted by the promptAsync route but is deliberately NOT in the
// SDK body type — which is exactly why plugin.ts:369 widens a local variable to
// smuggle it through. This pins that absence: the day the host adds `variant`
// to the body type, `VariantStillAbsent` flips to `false` and the assignment
// below stops compiling — the signal that the widening hack can be removed.
type VariantStillAbsent = "variant" extends keyof PromptBody ? false : true
const variantStillAbsent: VariantStillAbsent = true

test("the promptAsync body cron sends matches the SDK contract", () => {
  expect(body.agent).toBe("build")
  expect(body.model.modelID).toBe("claude-x")
  expect(body.messageID).toBe("msg_1")
  expect(variantStillAbsent).toBe(true)
})

import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import plugin from "../src/index"

// Compile the real v2 contract; no v1 aliases or hand-written host adapter.
const contract: Plugin.Plugin = plugin

test("exports a native V2 plugin definition", () => {
  expect(contract.id).toBe("macarons.redact-secrets")
  expect(typeof contract.setup).toBe("function")
  expect("server" in contract).toBe(false)
})

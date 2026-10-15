import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import plugin from "../index"
import manifest from "../package.json"

test("native plugin exports a default object from its local package root", () => {
  expect(plugin.id).toBe("macarons.cron")
  expect(typeof plugin.setup).toBe("function")
  expect(manifest.dependencies["@opencode/plugin"]).toBe(
    readFileSync(
      new URL("../../../.opencode-version", import.meta.url),
      "utf8",
    ).trim(),
  )
  expect(manifest.engines.opencode).toBe(">=2.0.29 <3.0.0")
  expect(manifest.exports).not.toHaveProperty("./tui")
})

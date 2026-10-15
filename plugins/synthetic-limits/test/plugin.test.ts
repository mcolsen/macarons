import { expect, test } from "bun:test"
import { SyntheticLimitsPlugin } from "../src/index"

test("exports the server companion required for remote quota reads", () => {
  expect(SyntheticLimitsPlugin.id).toBe("macarons.synthetic-limits")
  expect(typeof SyntheticLimitsPlugin.setup).toBe("function")
})

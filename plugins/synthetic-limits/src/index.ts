import { createUsageLimitsServer } from "@macarons/usage-limits"
import { Plugin } from "@opencode/plugin"
import { syntheticModule } from "./synthetic"

export const SyntheticLimitsPlugin = Plugin.define({
  id: "macarons.synthetic-limits",
  setup: (ctx) => createUsageLimitsServer({ ctx, module: syntheticModule }),
})
export default SyntheticLimitsPlugin

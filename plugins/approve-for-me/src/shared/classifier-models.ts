import type { ModelRef } from "@macarons/permission-rules"

/** Classifier-only backend; it does not need an OpenCode chat-provider entry. */
export const JEV_MODEL_REF = "typesafe/jev"
/** Safe for the server activity beacon and TUI; never contains a credential. */
export const JEV_AUTH_HINT =
  "run opencode auth login --provider typesafe or set TYPESAFE_API_KEY on the server"

export function isJevModel(model: ModelRef): boolean {
  return model.providerID === "typesafe" && model.modelID === "jev"
}

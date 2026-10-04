import type { ModelRef } from "@macarons/permission-rules"

/** Classifier-only backend; it does not need an OpenCode chat-provider entry. */
export const JEV_MODEL_REF = "typesafe/jev"

export function isJevModel(model: ModelRef): boolean {
  return model.providerID === "typesafe" && model.modelID === "jev"
}

import { parseModelRef } from "@macarons/permission-rules"

export const SERVICE = "scoped-system-prompts"

export const PROMPT_MODES = ["replace", "prepend", "append"] as const
export type PromptMode = (typeof PROMPT_MODES)[number]

export type ScopedPromptRule = {
  providerID: string
  modelID: string
  mode: PromptMode
  content: string[]
}

export type NormalizedOptions = {
  rules: ScopedPromptRule[]
  problems: string[]
}

const OPTION_KEYS = new Set(["prompts"])
const RULE_KEYS = new Set(["model", "mode", "content"])

function valueKind(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function display(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function isPromptMode(value: unknown): value is PromptMode {
  return (PROMPT_MODES as readonly unknown[]).includes(value)
}

function normalizeContent(value: unknown): string[] | undefined {
  const content = typeof value === "string" ? [value] : value
  if (
    !Array.isArray(content) ||
    content.length === 0 ||
    content.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    return undefined
  }
  return [...content]
}

/** Parse user-authored `[plugin, options]` JSON without failing plugin init. */
export function normalizeOptions(raw: unknown): NormalizedOptions {
  const rules: ScopedPromptRule[] = []
  const problems: string[] = []
  if (raw === undefined || raw === null) return { rules, problems }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      rules,
      problems: [`plugin options must be an object, got ${valueKind(raw)}`],
    }
  }

  const options = raw as Record<string, unknown>
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key))
      problems.push(`unknown plugin option ${JSON.stringify(key)}`)
  }

  if (options.prompts === undefined) return { rules, problems }
  if (!Array.isArray(options.prompts)) {
    problems.push('"prompts" must be an array')
    return { rules, problems }
  }

  for (const [index, rawRule] of options.prompts.entries()) {
    const path = `"prompts[${index}]"`
    if (
      rawRule === null ||
      typeof rawRule !== "object" ||
      Array.isArray(rawRule)
    ) {
      problems.push(`${path} must be an object`)
      continue
    }

    const entry = rawRule as Record<string, unknown>
    let hasUnknownField = false
    for (const key of Object.keys(entry)) {
      if (!RULE_KEYS.has(key)) {
        hasUnknownField = true
        problems.push(`${path} has unknown field ${JSON.stringify(key)}`)
      }
    }

    const model = parseModelRef(entry.model)
    if (!model) {
      problems.push(
        `${path}.model must be a "provider/model" reference, got ${display(entry.model)}`,
      )
    }
    if (!isPromptMode(entry.mode)) {
      problems.push(
        `${path}.mode must be "replace", "prepend", or "append", got ${display(entry.mode)}`,
      )
    }
    const content = normalizeContent(entry.content)
    if (!content) {
      problems.push(
        `${path}.content must be a non-empty string or a non-empty array of non-empty strings`,
      )
    }
    if (!model || !isPromptMode(entry.mode) || !content || hasUnknownField)
      continue

    rules.push({
      providerID: model.providerID,
      modelID: model.modelID,
      mode: entry.mode,
      content,
    })
  }

  return { rules, problems }
}

/** Apply matching rules sequentially while preserving the host array identity. */
export function applyPromptRules(
  rules: readonly ScopedPromptRule[],
  model: { providerID: string; id: string },
  system: string[],
): void {
  for (const rule of rules) {
    if (rule.providerID !== model.providerID || rule.modelID !== model.id)
      continue

    if (rule.mode === "replace") {
      system.splice(0, system.length, ...rule.content)
    } else if (rule.mode === "prepend") {
      system.unshift(...rule.content)
    } else {
      system.push(...rule.content)
    }
  }
}

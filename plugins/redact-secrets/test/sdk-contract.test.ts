import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Hooks } from "@opencode-ai/plugin"

// --- (1) the type defeat, documented --------------------------------------
//
// The tool-schema redaction layer reads and writes the schema through
// `(output as { jsonSchema?: unknown }).jsonSchema` (src/index.ts:897, 964,
// 970-971, 974). The pinned @opencode-ai/plugin type declares tool.definition's
// output as `{ description: string; parameters: any }` with NO jsonSchema
// member, so the cast defeats the compiler entirely. This pins that absence:
// the day the SDK adds `jsonSchema` to the hook output type, `JsonSchemaUntyped`
// flips to `false` and the assignment below stops compiling — the signal that
// the cast can be dropped and the field type-checked directly.
type ToolDefinitionOutput = Parameters<NonNullable<Hooks["tool.definition"]>>[1]
type JsonSchemaUntyped = "jsonSchema" extends keyof ToolDefinitionOutput
  ? false
  : true
const jsonSchemaUntyped: JsonSchemaUntyped = true

test("the tool.definition hook output still omits a typed jsonSchema", () => {
  expect(jsonSchemaUntyped).toBe(true)
})

// --- (2) the host-side contract guard -------------------------------------
//
// Because the field is untyped AND the package pins @opencode-ai/plugin to one
// version while engines.opencode allows any 1.x host, a host-side rename of
// `jsonSchema` is invisible at compile time, unit-test time, AND runtime: the
// `if (schema && typeof schema === "object")` block (src/index.ts:948) is
// skipped, no redaction runs, and every tool JSON schema — defaults and enums
// that are prime credential-paste spots — ships to the provider raw. This is
// the plugin's one fail-OPEN path; every sibling failure in that file throws.
//
// Nothing in the pinned packages can catch that. This guard therefore reads the
// host's own source of truth: the OpenCode source checkout, where the tool
// registry seeds the hook payload with `jsonSchema` and reads the (possibly
// redacted) field back around the tool.definition trigger
// (packages/opencode/src/tool/registry.ts:308-328). If that field ever leaves
// the registry's tool-definition object, this fails loudly.
//
// It runs ONLY against a checkout whose version matches this repo's pin
// (.opencode-version) — a mismatched or missing checkout SKIPS rather than
// false-failing, so a CI runner without a source tree never yields a wrong
// failure. The guard's value lands on a developer machine and in the
// version-bump lane, where the pinned source can be made available (set
// OPENCODE_SRC to point at it).

const sourceDir =
  process.env.OPENCODE_SRC ?? path.join(os.homedir(), "src", "opencode")
const registryFile = path.join(
  sourceDir,
  "packages/opencode/src/tool/registry.ts",
)
const sourcePkgFile = path.join(sourceDir, "packages/opencode/package.json")
const pinFile = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  ".opencode-version",
)

const pinnedVersion = readFileSync(pinFile, "utf8").trim()
const sourceVersion =
  existsSync(sourcePkgFile) && existsSync(registryFile)
    ? (JSON.parse(readFileSync(sourcePkgFile, "utf8")) as { version?: string })
        .version
    : undefined
const guardable = sourceVersion === pinnedVersion

test.skipIf(!guardable)(
  `the pinned host (${pinnedVersion}) still surfaces jsonSchema on the tool.definition payload`,
  () => {
    const source = readFileSync(registryFile, "utf8")
    // The host seeds the hook payload with the field the plugin reads…
    // (\b so a rename to e.g. jsonSchemaV2 cannot satisfy this by prefix.)
    expect(source).toMatch(/\bjsonSchema:\s*tool\.jsonSchema\b/)
    // …fires the exact hook the plugin registers…
    expect(source).toMatch(/plugin\.trigger\(\s*["']tool\.definition["']/)
    // …and reads the (possibly redacted) field back off the mutated output,
    // so the plugin's `output.jsonSchema = clone` swap is what ships.
    expect(source).toMatch(/\boutput\.jsonSchema\b/)
  },
)

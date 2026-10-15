import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import ts from "@typescript/typescript6"

const root = path.resolve(import.meta.dir, "../../..")
type Claim = { plugin: string; placement: string; slot: string }

/** Native v2 composes additive claims in plugin enable order, without numeric priorities. */
export function scanSource(plugin: string, file: string, text: string) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  )
  const claims: Claim[] = []
  const unreadable: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "slot"
    ) {
      const target = node.expression.expression
      if (ts.isPropertyAccessExpression(target) && target.name.text === "ui") {
        const argument = node.arguments[0]
        if (!argument || !ts.isObjectLiteralExpression(argument))
          unreadable.push(file)
        else {
          const placements = argument.properties.filter(
            (property) =>
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              ["append", "prepend", "before", "after", "replace"].includes(
                property.name.text,
              ),
          )
          const placement = placements[0]
          if (
            placements.length !== 1 ||
            !placement ||
            !ts.isPropertyAssignment(placement) ||
            !ts.isStringLiteral(placement.initializer) ||
            argument.properties.some(ts.isSpreadAssignment)
          )
            unreadable.push(file)
          else
            claims.push({
              plugin,
              placement: placement.name.getText(source),
              slot: placement.initializer.text,
            })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { claims, unreadable }
}

test("the four retained sidebar widgets use native additive slot claims", () => {
  const claims: Claim[] = []
  for (const plugin of readdirSync(path.join(root, "plugins"))) {
    const file = path.join(root, "plugins", plugin, "src/tui.tsx")
    if (!existsSync(file)) continue
    const source = readFileSync(file, "utf8")
    expect(source).not.toContain("slots.register")
    const result = scanSource(plugin, file, source)
    expect(result.unreadable).toEqual([])
    claims.push(...result.claims)
  }
  expect(claims.sort((a, b) => a.plugin.localeCompare(b.plugin))).toEqual(
    ["approve-for-me", "cache-ratio", "codex-limits", "synthetic-limits"].map(
      (plugin) => ({ plugin, placement: "append", slot: "sidebar.content" }),
    ),
  )
})

describe("native slot scanner", () => {
  test("reads literal claims and ignores comments", () => {
    expect(
      scanSource(
        "one",
        "one.tsx",
        'ctx.ui.slot({render: () => null, append:"sidebar.content"})',
      ).claims,
    ).toEqual([{ plugin: "one", placement: "append", slot: "sidebar.content" }])
    expect(
      scanSource("one", "one.tsx", '// ctx.ui.slot({append:"sidebar.content"})')
        .claims,
    ).toEqual([])
  })
  test.each([
    "ctx.ui.slot(claim)",
    "ctx.ui.slot({append:target})",
    'ctx.ui.slot({...claim,append:"sidebar.content"})',
    'ctx.ui.slot({append:"sidebar.content",replace:"app"})',
  ])("reports unreadable or ambiguous claims: %s", (source) => {
    expect(scanSource("one", "one.tsx", source).unreadable).toHaveLength(1)
  })
})

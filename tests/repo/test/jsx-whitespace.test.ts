import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "@typescript/typescript6"

/**
 * Guards the TUI halves against a formatter silently changing what they render.
 *
 * The suite renders JSX to a terminal, not to a DOM. That breaks an assumption
 * every JSX formatter makes: on the web a browser collapses whitespace runs in
 * normal flow, so rewriting two spaces as one is unobservable, and Biome (like
 * Prettier, deliberately — biomejs/biome#6624) does exactly that. OpenTUI has
 * no such collapsing step, so every space is real output.
 *
 * Enabling the formatter cost us terminal spacing this way (PR #78). Nothing
 * caught it — the full suite passed before and after, because the spacing is
 * pure column alignment that no assertion looks at.
 *
 * So the rule is: padding that reaches the renderer must be written as an
 * expression, `{"  "}`, never as literal spaces in JSX text. A string literal
 * is data the formatter will not touch, and it says out loud that the spacing
 * is load-bearing rather than incidental indentation.
 *
 * This test enforces exactly that, by running JSX's own whitespace algorithm
 * over every JsxText node and flagging any run of two-plus spaces that SURVIVES
 * it. Indentation is therefore never flagged (JSX strips whitespace adjacent to
 * a newline), and `{"  "}` is never flagged (it is a JsxExpression, not text) —
 * so the check has no false positives to work around.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..")

function trackedTsxFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "*.tsx"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  })
  return out.split("\n").filter(Boolean)
}

/**
 * The value a JsxText node contributes after JSX whitespace processing.
 *
 * Lines are trimmed of leading whitespace unless they are the first line, and
 * of trailing whitespace unless they are the last; whitespace-only lines drop
 * out entirely; what remains is joined with a single space. That is why
 * `<t>  hi</t>` keeps both spaces (one line, so neither trim applies) while an
 * indented `<t>\n  hi\n</t>` renders as just "hi".
 */
export function jsxTextValue(raw: string): string {
  const lines = raw.split("\n")
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? ""
    if (i > 0) line = line.replace(/^[ \t]+/, "")
    if (i < lines.length - 1) line = line.replace(/[ \t]+$/, "")
    if (line === "") continue
    kept.push(line)
  }
  return kept.join(" ")
}

type Offence = { file: string; line: number; rendered: string }

function offencesIn(file: string): Offence[] {
  const text = readFileSync(path.join(REPO_ROOT, file), "utf8")
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  )
  const found: Offence[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const rendered = jsxTextValue(node.getFullText(source))
      if (/ {2,}/.test(rendered)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart())
        found.push({ file, line: line + 1, rendered })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe("JSX text never carries literal multi-space padding", () => {
  test("every .tsx file writes surviving padding as an expression", () => {
    const files = trackedTsxFiles()
    // Guard the guard: if the glob ever stops matching, this test would pass
    // vacuously and we would never know it had stopped protecting anything.
    expect(files.length).toBeGreaterThan(0)

    const offences = files.flatMap(offencesIn)
    const report = offences
      .map(
        (o) =>
          `  ${o.file}:${o.line} renders ${JSON.stringify(o.rendered)}\n` +
          '      write the padding as {"  "} so the formatter cannot collapse it',
      )
      .join("\n")

    expect(
      offences.length === 0 ? "" : `\n${report}\n`,
      "JSX text contains spacing a formatter will silently collapse",
    ).toBe("")
  })
})

describe("jsxTextValue models JSX whitespace processing", () => {
  // These pin the semantics the check depends on. If a TypeScript upgrade ever
  // changed how JsxText is tokenised, the check could quietly stop matching
  // reality; these cases would fail first.
  test("keeps a space run that shares its line with content", () => {
    expect(jsxTextValue("  lead")).toBe("  lead")
    expect(jsxTextValue("mid  gap")).toBe("mid  gap")
    expect(jsxTextValue("trail  ")).toBe("trail  ")
  })

  test("strips indentation adjacent to newlines", () => {
    expect(jsxTextValue("\n  indented\n")).toBe("indented")
    expect(jsxTextValue("\n    deeply\n      nested\n")).toBe("deeply nested")
  })

  test("drops whitespace-only text entirely", () => {
    expect(jsxTextValue("\n   \n")).toBe("")
    expect(jsxTextValue("   ")).toBe("   ")
  })

  test("joins wrapped lines with exactly one space", () => {
    expect(jsxTextValue("foo\nbar")).toBe("foo bar")
  })
})

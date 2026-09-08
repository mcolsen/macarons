import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "@typescript/typescript6"

/**
 * The suite's sidebar slot allocation, in one place at last.
 *
 * `api.slots.register({ order })` places a plugin's section among the host's
 * own, and the suite deliberately packs its live per-session sections into the
 * gap between the host's Context section (100) and MCP (200). Until now that
 * packing was recorded only in per-plugin comments, each written from its own
 * writer's vantage — and the 2026-07-23 audit's TUI-scaffold work (issue #112)
 * found what that costs: background-tasks took 160, and cache-ratio, reasoning
 * independently that it belonged "just after the limits widgets", took 160 as
 * well. Two sections at one order leave their relative position to whatever
 * the host's sort does with equal keys, so the sidebar could render them
 * either way round, and nothing anywhere would have said so.
 *
 * The orders stay plugin-owned: the audit's guardrail is explicit that each
 * plugin keeps its exact order and that no shared helper imposes one. So this
 * guard asserts only what no single plugin can check for itself — that the
 * order it picked is unclaimed — plus a snapshot of the allocation, so that
 * moving a section is a deliberate edit here rather than a silent collision
 * discovered by someone squinting at their sidebar.
 *
 * The sweep parses rather than pattern-matches, and reports what it could not
 * read. A regex over the one shape the halves happen to write today would be
 * fail-open in the way that matters: a registration in any other API-valid
 * form — `slots` before `order`, an option between them, a second slot key —
 * would simply not be seen, so a newly added section could collide with an
 * existing order and both tests below would still pass. Anything the reader
 * cannot resolve statically is therefore an explicit failure, not a silent
 * omission; see the fixtures at the bottom for the forms that means.
 *
 * Keyed off `git ls-files`, like the other guards here, so a stray untracked
 * checkout under plugins/ cannot make this pass locally and fail in CI.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..")

/**
 * Every slot the suite registers today, in render order. Sections 150–170 are
 * the live per-session widgets, packed between the host's Context (100) and
 * MCP (200); the permission halves sit past MCP, where their prompt-scoped
 * chrome belongs below the standing context.
 */
const EXPECTED: ReadonlyArray<{ plugin: string; slot: string; order: number }> =
  [
    { plugin: "codex-limits", slot: "sidebar_content", order: 150 },
    { plugin: "synthetic-limits", slot: "sidebar_content", order: 152 },
    { plugin: "subagents-sidebar", slot: "sidebar_content", order: 155 },
    { plugin: "background-tasks", slot: "sidebar_content", order: 160 },
    { plugin: "cache-ratio", slot: "sidebar_content", order: 165 },
    { plugin: "web-search", slot: "sidebar_content", order: 170 },
    { plugin: "persist-permissions", slot: "app_bottom", order: 300 },
    {
      plugin: "approve-for-me",
      slot: "sidebar_content",
      order: 320,
    },
  ]

type Registration = { plugin: string; slot: string; order: number }
/** A `slots.register(...)` call the reader found but could not resolve. */
type Unreadable = { file: string; line: number; reason: string }
type Scan = { registrations: Registration[]; unreadable: Unreadable[] }

// Registration lives in the shipped halves, so the sweep covers every tracked
// source under plugins/*/src — not just tui.tsx, so that moving a register call
// into a sibling module cannot quietly take the section out of this snapshot.
// Plugin test/ trees stay out: their fakes define `slots.register`, they do not
// claim orders with it.
function trackedPluginSources(): string[] {
  const out = execFileSync(
    "git",
    [
      "ls-files",
      ":(glob)plugins/*/src/**/*.ts",
      ":(glob)plugins/*/src/**/*.tsx",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  )
  return out.split("\n").filter(Boolean)
}

/**
 * Reads every `slots.register(...)` in one source, from its syntax.
 *
 * Deliberately a parse of the text rather than an import: the TUI entry modules
 * pull in solid-js and the host's JSX runtime, and this guard must stay runnable
 * without either. Recognised callees are `<anything>.slots.register(...)` and a
 * bare `slots.register(...)`; the reader resolves `order` only as a numeric
 * literal and slot names only as plain keys, because that is all that can be
 * known without running the plugin. Every other form is returned in
 * `unreadable` — the guard's whole value is that it never shrugs.
 */
export function scanSource(plugin: string, file: string, text: string): Scan {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  )
  const registrations: Registration[] = []
  const unreadable: Unreadable[] = []

  const reject = (node: ts.Node, reason: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    unreadable.push({ file, line: line + 1, reason })
  }

  const isSlotsRegister = (call: ts.CallExpression): boolean => {
    const callee = call.expression
    if (!ts.isPropertyAccessExpression(callee)) return false
    if (callee.name.text !== "register") return false
    const target = callee.expression
    if (ts.isIdentifier(target)) return target.text === "slots"
    return ts.isPropertyAccessExpression(target) && target.name.text === "slots"
  }

  const keyOf = (name: ts.PropertyName): string | undefined =>
    ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined

  const read = (call: ts.CallExpression): void => {
    const [argument, ...rest] = call.arguments
    if (
      argument === undefined ||
      rest.length > 0 ||
      !ts.isObjectLiteralExpression(argument)
    ) {
      reject(
        call,
        "registers with something other than one object literal, so its order cannot be read",
      )
      return
    }

    let order: number | undefined
    let slots: string[] | undefined
    for (const property of argument.properties) {
      if (ts.isSpreadAssignment(property)) {
        reject(property, "spreads into the registration, hiding what it claims")
        return
      }
      const key = keyOf(property.name)
      if (key === undefined) {
        reject(property, "uses a computed key in the registration")
        return
      }
      if (key === "order") {
        if (
          !ts.isPropertyAssignment(property) ||
          !ts.isNumericLiteral(property.initializer)
        ) {
          reject(
            property,
            "writes `order` as something other than a number literal; inline the number so the allocation stays readable here",
          )
          return
        }
        order = Number(property.initializer.text)
      } else if (key === "slots") {
        if (
          !ts.isPropertyAssignment(property) ||
          !ts.isObjectLiteralExpression(property.initializer)
        ) {
          reject(
            property,
            "writes `slots` as something other than an object literal",
          )
          return
        }
        const names: string[] = []
        for (const slot of property.initializer.properties) {
          if (ts.isSpreadAssignment(slot)) {
            reject(slot, "spreads into `slots`, hiding which slots it fills")
            return
          }
          const name = keyOf(slot.name)
          if (name === undefined) {
            reject(slot, "uses a computed slot name")
            return
          }
          names.push(name)
        }
        slots = names
      }
    }

    // `order` is optional to the host, which is exactly why it is required
    // here: a section that declares none lands wherever the sort leaves it.
    if (order === undefined) {
      reject(call, "declares no `order`, so where its section lands is unowned")
      return
    }
    if (slots === undefined || slots.length === 0) {
      reject(call, "fills no slots")
      return
    }
    for (const slot of slots) registrations.push({ plugin, slot, order })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isSlotsRegister(node)) read(node)
    ts.forEachChild(node, visit)
  }
  visit(source)

  return { registrations, unreadable }
}

function scanRepo(): Scan {
  const registrations: Registration[] = []
  const unreadable: Unreadable[] = []
  for (const file of trackedPluginSources()) {
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8")
    // Every callee the reader recognises names `slots`, so this skips the
    // parse for most of the tree without narrowing what is checked.
    if (!text.includes("slots")) continue
    const scan = scanSource(file.split("/")[1] as string, file, text)
    registrations.push(...scan.registrations)
    unreadable.push(...scan.unreadable)
  }
  registrations.sort(
    (a, b) =>
      a.order - b.order ||
      a.plugin.localeCompare(b.plugin) ||
      a.slot.localeCompare(b.slot),
  )
  return { registrations, unreadable }
}

describe("sidebar slot orders", () => {
  // Checked first: an unreadable registration is invisible to both tests
  // below, so without this a new section could collide and they would still
  // both pass.
  test("every registration the suite writes is readable", () => {
    const report = scanRepo()
      .unreadable.map(
        (entry) => `  ${entry.file}:${entry.line} ${entry.reason}`,
      )
      .join("\n")
    expect(
      report === "" ? "" : `\n${report}\n`,
      "a slots.register(...) call this guard cannot read is a section it cannot check for collisions",
    ).toBe("")
  })

  // Without this, a change to how registration is written would make the
  // sweep match nothing and pass forever.
  test("the sweep still finds every registration", () => {
    expect(scanRepo().registrations).toEqual([...EXPECTED])
  })

  test("no two plugins claim the same order in the same slot", () => {
    const byKey = new Map<string, string[]>()
    for (const entry of scanRepo().registrations) {
      const key = `${entry.slot}@${entry.order}`
      byKey.set(key, [...(byKey.get(key) ?? []), entry.plugin])
    }
    const collisions = [...byKey.entries()]
      .filter(([, plugins]) => plugins.length > 1)
      .map(([key, plugins]) => `${key}: ${plugins.join(", ")}`)
    expect(collisions).toEqual([])
  })
})

describe("the reader sees every registration form the API allows", () => {
  // These pin what the sweep above is worth. The host's slot plugin is
  // `{ order?, setup?, dispose?, slots }` with no required property order and
  // no limit of one slot, so all of these are things a half could legitimately
  // write tomorrow — and every one of them has to end up either counted or
  // reported, never dropped.
  const scan = (body: string): Scan =>
    scanSource("fixture", "fixture.tsx", body)

  test("the shape every half writes today", () => {
    const found = scan(`api.slots.register({
      order: 150,
      slots: { sidebar_content: (_ctx, props) => <View {...props} /> },
    })`)
    expect(found.unreadable).toEqual([])
    expect(found.registrations).toEqual([
      { plugin: "fixture", slot: "sidebar_content", order: 150 },
    ])
  })

  test("`slots` written before `order`", () => {
    const found = scan(`api.slots.register({
      slots: { sidebar_content: () => null },
      order: 165,
    })`)
    expect(found.unreadable).toEqual([])
    expect(found.registrations).toEqual([
      { plugin: "fixture", slot: "sidebar_content", order: 165 },
    ])
  })

  test("an option between `order` and `slots`", () => {
    const found = scan(`api.slots.register({
      order: 170,
      setup: () => {},
      slots: { sidebar_content: () => null },
      dispose: () => {},
    })`)
    expect(found.unreadable).toEqual([])
    expect(found.registrations).toEqual([
      { plugin: "fixture", slot: "sidebar_content", order: 170 },
    ])
  })

  test("a second slot in one registration", () => {
    const found = scan(`api.slots.register({
      order: 300,
      slots: {
        app_bottom: () => null,
        "sidebar_content": () => null,
        status_right(_ctx, props) { return null },
      },
    })`)
    expect(found.unreadable).toEqual([])
    expect(found.registrations).toEqual([
      { plugin: "fixture", slot: "app_bottom", order: 300 },
      { plugin: "fixture", slot: "sidebar_content", order: 300 },
      { plugin: "fixture", slot: "status_right", order: 300 },
    ])
  })

  test("a destructured `slots`", () => {
    const found = scan(`const { slots } = api
    slots.register({ order: 320, slots: { sidebar_content: () => null } })`)
    expect(found.unreadable).toEqual([])
    expect(found.registrations).toEqual([
      { plugin: "fixture", slot: "sidebar_content", order: 320 },
    ])
  })

  test("a registration in a comment is not one", () => {
    const found = scan(
      `// api.slots.register({ order: 150, slots: { sidebar_content: () => null } })`,
    )
    expect(found).toEqual({ registrations: [], unreadable: [] })
  })

  // Everything below is API-valid and statically unresolvable. The point of
  // each is that it fails loudly rather than vanishing from the snapshot.
  const rejected: ReadonlyArray<{ what: string; body: string }> = [
    {
      what: "`order` passed by name",
      body: `const order = 165
      api.slots.register({ order, slots: { sidebar_content: () => null } })`,
    },
    {
      what: "`order` computed from a constant",
      body: `api.slots.register({
        order: BASE + 5,
        slots: { sidebar_content: () => null },
      })`,
    },
    {
      what: "a spread into the registration",
      body: `api.slots.register({
        ...defaults,
        slots: { sidebar_content: () => null },
      })`,
    },
    {
      what: "no `order` at all",
      body: `api.slots.register({ slots: { sidebar_content: () => null } })`,
    },
    {
      what: "`slots` built elsewhere",
      body: `api.slots.register({ order: 150, slots: buildSlots() })`,
    },
    {
      what: "a computed slot name",
      body: `api.slots.register({
        order: 150,
        slots: { [SIDEBAR]: () => null },
      })`,
    },
    {
      what: "the whole registration built elsewhere",
      body: `api.slots.register(registration)`,
    },
  ]

  for (const { what, body } of rejected) {
    test(`${what} is reported, not skipped`, () => {
      const found = scan(body)
      expect(found.registrations).toEqual([])
      expect(found.unreadable).toHaveLength(1)
    })
  }
})

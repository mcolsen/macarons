# T2 — Table-driven spec for the matching engine, run against both copies

`from_finding: F2 (+F1)` · `size: M` · `dependencies: T1`

## background

This repo (`opencode-persist-permissions`) is an OpenCode plugin with two
production files, `src/index.ts` (server half) and `src/tui.tsx` (TUI half),
which deliberately duplicate a small matching engine ported from OpenCode's own
permission code: `wildcardMatch`, `expandHome`, `rulesFrom`, `evaluate`, and
the store mutator `addAllowRule`. These functions decide **what runs without a
permission prompt** — they are the plugin's security boundary — yet they are
currently tested only incidentally, through a handful of integration paths in
`test/plugin.test.ts`. A one-character regression in the regex-escape chain
would not crash anything; it would silently widen or narrow what gets
auto-approved.

The helpers are **not exported** (and must not be — see invariants). Ticket T1
added `test/helpers/source.ts` with an `extractDeclaration(source, marker)`
helper that pulls a top-level declaration out of a source file as text, plus
`SERVER_SOURCE` / `TUI_SOURCE` / `readSource`. This ticket compiles the
extracted functions with Bun's transpiler and runs one behavior table against
**both** copies. Because `os` and `process` are injected as parameters of the
compiled scope, home-directory and Windows-platform behavior become
deterministic and testable on any machine.

For reference, the engine's semantics (identical in both files):

- `wildcardMatch(input, pattern)` — backslashes in both input and pattern are
  normalized to `/`; regex metacharacters in the pattern are escaped; `*`
  becomes `.*`, `?` becomes `.`; a pattern ending in `" *"` also matches the
  bare prefix (`"git status *"` matches `"git status"`); the regex uses the `s`
  flag, plus `i` when `process.platform === "win32"`.
- `expandHome(pattern)` — `~`, `~/...`, `$HOME...` prefixes expand to
  `os.homedir()`; anything else is unchanged.
- `rulesFrom(store)` — flattens `{permission: {tool: action | {pattern: action}}}`
  into an ordered rule list; string form means pattern `"*"`; patterns are
  passed through `expandHome`.
- `evaluate(permission, pattern, rules)` — **last** matching rule wins; both
  the rule's tool key and its pattern are wildcard-matched; unmatched → `"ask"`.
- `addAllowRule(store, permission, pattern)` — appends/moves an allow rule to
  the end (freshest wins under last-rule-wins); returns whether the store
  changed.

Runtime is Bun (`bun test`, `bun run typecheck`).

## invariants

- **Do not add any `export` to `src/index.ts` or `src/tui.tsx`.** OpenCode's
  server-plugin loader may call every function export of a plugin module as a
  plugin entry point; extraction-from-source is the required approach.
- **Do not modify the production files at all.** This ticket pins current
  behavior; it changes only `test/`.
- The same behavior table must run against both files' copies. Do not test one
  copy and assume the other.

## change

Create `test/matching-spec.test.ts` with exactly this content:

```ts
import { describe, expect, test } from "bun:test"
import { SERVER_SOURCE, TUI_SOURCE, extractDeclaration, readSource } from "./helpers/source"

type Rule = { permission: string; pattern: string; action: string }
type Store = { permission: Record<string, unknown> }
type Engine = {
  wildcardMatch: (input: string, pattern: string) => boolean
  expandHome: (pattern: string) => string
  rulesFrom: (store: Store) => Rule[]
  evaluate: (permission: string, pattern: string, rules: Rule[]) => string
  addAllowRule: (store: Store, permission: string, pattern: string) => boolean
}

const FUNCTIONS = [
  "function wildcardMatch(",
  "function expandHome(",
  "function rulesFrom(",
  "function evaluate(",
  "function addAllowRule(",
]

// Compiles the (unexported) helpers straight out of a production source file
// so they can be spec-tested without adding exports — OpenCode's server-plugin
// loader may call every function export of a plugin module as a plugin, so the
// production files must not grow exports. Injecting `os` and `process` makes
// homedir and platform behavior deterministic.
async function compile(file: string, fake: { homedir: string; platform: string }): Promise<Engine> {
  const source = await readSource(file)
  const blob = FUNCTIONS.map((marker) => extractDeclaration(source, marker)).join("\n")
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(blob)
  const factory = new Function(
    "os",
    "process",
    `${js}\nreturn { wildcardMatch, expandHome, rulesFrom, evaluate, addAllowRule };`,
  )
  return factory({ homedir: () => fake.homedir }, { platform: fake.platform }) as Engine
}

const WILDCARD_CASES: [input: string, pattern: string, expected: boolean][] = [
  ["git status", "git status", true],
  ["git status --short", "git status *", true],
  ["git status", "git status *", true], // trailing " *" also matches the bare command
  ["git statuses", "git status *", false], // ...but not a longer word
  ["a.ts", "?.ts", true], // "?" matches exactly one character
  ["ab.ts", "?.ts", false],
  ["src.ts", "src.ts", true],
  ["srcXts", "src.ts", false], // "." is literal, not a regex wildcard
  ["npm run build (prod)", "npm run build (prod)", true], // regex metachars in patterns are escaped
  ["echo $HOME", "echo $HOME", true],
  ["src\\app.ts", "src/app.ts", true], // backslashes normalize to slashes on both sides
  ["echo hi\nrm -rf /", "echo *", true], // "*" spans newlines (s flag) — multi-line bash commands
  ["GIT STATUS", "git status", false], // case-sensitive off Windows
  ["", "*", true],
]

const EXPAND_CASES: [pattern: string, expected: string][] = [
  ["~", "/home/u"],
  ["~/notes/*", "/home/u/notes/*"],
  ["$HOME/notes", "/home/u/notes"],
  ["$HOME", "/home/u"],
  ["~notes", "~notes"], // only "~" and "~/" expand
  ["a/~/b", "a/~/b"], // only at the start of the pattern
]

const COPIES = [
  { name: "src/index.ts", file: SERVER_SOURCE },
  { name: "src/tui.tsx", file: TUI_SOURCE },
]

for (const copy of COPIES) {
  const engine = await compile(copy.file, { homedir: "/home/u", platform: "linux" })
  const win32 = await compile(copy.file, { homedir: "/home/u", platform: "win32" })

  describe(`matching engine in ${copy.name}`, () => {
    describe("wildcardMatch", () => {
      for (const [input, pattern, expected] of WILDCARD_CASES) {
        test(`${JSON.stringify(input)} vs ${JSON.stringify(pattern)} -> ${expected}`, () => {
          expect(engine.wildcardMatch(input, pattern)).toBe(expected)
        })
      }

      test("matching is case-insensitive on win32", () => {
        expect(win32.wildcardMatch("GIT Status", "git status")).toBe(true)
      })
    })

    describe("expandHome", () => {
      for (const [pattern, expected] of EXPAND_CASES) {
        test(`${JSON.stringify(pattern)} -> ${JSON.stringify(expected)}`, () => {
          expect(engine.expandHome(pattern)).toBe(expected)
        })
      }
    })

    describe("rulesFrom", () => {
      test("string form means a blanket '*' pattern", () => {
        expect(engine.rulesFrom({ permission: { webfetch: "allow" } })).toEqual([
          { permission: "webfetch", pattern: "*", action: "allow" },
        ])
      })

      test("object form preserves insertion order and expands '~'", () => {
        const rules = engine.rulesFrom({
          permission: { bash: { "git *": "allow", "git push *": "ask" }, read: { "~/secrets/*": "deny" } },
        })
        expect(rules).toEqual([
          { permission: "bash", pattern: "git *", action: "allow" },
          { permission: "bash", pattern: "git push *", action: "ask" },
          { permission: "read", pattern: "/home/u/secrets/*", action: "deny" },
        ])
      })
    })

    describe("evaluate", () => {
      const rules = () =>
        engine.rulesFrom({ permission: { bash: { "git *": "allow", "git push *": "ask" } } })

      test("last matching rule wins", () => {
        expect(engine.evaluate("bash", "git push origin main", rules())).toBe("ask")
        expect(engine.evaluate("bash", "git log", rules())).toBe("allow")
      })

      test("unmatched requests stay 'ask'", () => {
        expect(engine.evaluate("edit", "src/app.ts", rules())).toBe("ask")
        expect(engine.evaluate("bash", "npm install", rules())).toBe("ask")
      })

      test("the tool key is itself a wildcard pattern", () => {
        const blanket = engine.rulesFrom({ permission: { "*": "deny" } })
        expect(engine.evaluate("bash", "anything at all", blanket)).toBe("deny")
      })
    })

    describe("addAllowRule", () => {
      test("creates the rule map for a new tool", () => {
        const store: Store = { permission: {} }
        expect(engine.addAllowRule(store, "bash", "git *")).toBe(true)
        expect(store.permission.bash).toEqual({ "git *": "allow" })
      })

      test("a string-form blanket that is not 'allow' is preserved as '*' before the new rule", () => {
        const store: Store = { permission: { bash: "deny" } }
        expect(engine.addAllowRule(store, "bash", "git *")).toBe(true)
        expect(Object.entries(store.permission.bash as Record<string, string>)).toEqual([
          ["*", "deny"],
          ["git *", "allow"],
        ])
      })

      test("a string-form 'allow' blanket is already as broad as it gets", () => {
        const store: Store = { permission: { bash: "allow" } }
        expect(engine.addAllowRule(store, "bash", "git *")).toBe(false)
        expect(store.permission.bash).toBe("allow")
      })

      test("re-adding an existing rule moves it to the end (freshest wins)", () => {
        const store: Store = { permission: { bash: { "a *": "allow", "b *": "allow" } } }
        expect(engine.addAllowRule(store, "bash", "a *")).toBe(true)
        expect(Object.keys(store.permission.bash as Record<string, string>)).toEqual(["b *", "a *"])
      })

      test("an allow rule already in last position is a no-op", () => {
        const store: Store = { permission: { bash: { "a *": "allow", "b *": "allow" } } }
        expect(engine.addAllowRule(store, "bash", "b *")).toBe(false)
      })

      test("a non-allow entry for the same pattern is flipped and moved to the end", () => {
        const store: Store = { permission: { bash: { "git push *": "ask", "git *": "allow" } } }
        expect(engine.addAllowRule(store, "bash", "git push *")).toBe(true)
        expect(Object.entries(store.permission.bash as Record<string, string>)).toEqual([
          ["git *", "allow"],
          ["git push *", "allow"],
        ])
      })
    })
  })
}
```

Notes for the implementer:

- Top-level `await` outside `describe` is valid in Bun test files.
- `Bun.Transpiler` is a built-in Bun global; no import needed.
- If `extractDeclaration` throws `declaration not found`, T1 has not landed —
  it hoists `addAllowRule` to module level in `src/index.ts`. Land T1 first.
- If any assertion fails, the table is wrong about ported behavior — **stop
  and report the failing case rather than changing production code.** This
  ticket documents behavior; it must not alter it.

## files_in_scope

- `test/matching-spec.test.ts` (new — the only file this ticket touches)

## do_not_touch

- `src/index.ts`, `src/tui.tsx` (no production changes, no exports)
- All existing test files, `README.md`, `package.json`, `tsconfig.json`

## acceptance_criteria

- `bun test` passes; the new file contributes the same set of passing tests
  twice (once per production copy).
- `bun run typecheck` passes.
- `git diff` shows no changes outside `test/matching-spec.test.ts`.

## tests

- Must still pass: all existing tests.
- New: `test/matching-spec.test.ts` exactly as specified.

## non_goals

- No new matching behavior, no fixes — behavior pinning only.
- No testing of `readStore`/`writeStore`/`ensureGitignored` (covered by
  integration tests and T3).
- No property-based/fuzz testing.

# T1 — Sync-guard test for the duplicated helper core

`from_finding: F1` · `size: M` · `dependencies: none`

## background

This repo (`opencode-persist-permissions`) is an OpenCode plugin with exactly
two production files:

- `src/index.ts` — the **server half**. Listens to `permission.asked` /
  `permission.replied` events; when the user answers "always" it writes allow
  rules to `.opencode/permissions.local.json`; on later matching requests it
  auto-replies through the OpenCode API.
- `src/tui.tsx` — the **TUI half**. Adds an "edit the allow pattern before
  approving" dialog, a persistence toast, and a hint line to the OpenCode TUI.

Both files **deliberately duplicate** a core of helpers (wildcard matching,
rule evaluation, store mutation, constants, types). This is a documented
invariant, stated in both file headers: each half must remain a self-contained
single file, because users install the server half by copying the one file.
**Do not deduplicate the code.** The problem is that nothing *enforces* the
copies stay identical — someone fixing a bug in one file can silently skew the
other. This ticket turns the convention into a failing test.

Two of the duplicated helpers are currently in *different syntactic positions*
(closure-scoped in one file, module-scoped in the other), which blocks textual
comparison. This ticket first normalizes them to identical module-level
`function` declarations, then adds the guard.

Runtime is Bun. Run tests with `bun test`, typecheck with `bun run typecheck`
(strict tsc, no emit). Test files live in `test/`.

## invariants

- **Do not add any `export` to `src/index.ts` or `src/tui.tsx`.** OpenCode's
  server-plugin loader may treat every function export of a plugin module as a
  plugin entry point and call it with a plugin-input object; a stray export can
  break plugin loading. The guard must work by reading the source files as
  text, not by importing symbols.
- No behavior change in either production file. The moved functions are pure
  (they read only their arguments), so moving them out of closures is safe.
- The store file format, all event handling, and all existing tests must be
  unchanged. All 58+ existing tests must still pass.

## change

### 1. Hoist `addAllowRule` in `src/index.ts` to module scope

`src/index.ts` currently defines `addAllowRule` as a `const` arrow function
*inside* the `PersistPermissionsPlugin` closure (it appears after the
`ensureGitignored` definition, preceded by this comment):

```ts
  // Appends the pattern as an allow rule. Re-adding moves it to the end so
  // the freshest approval wins under last-rule-wins evaluation.
  const addAllowRule = (store: Store, permission: string, pattern: string): boolean => {
    const current = store.permission[permission]
    if (current === undefined) {
      store.permission[permission] = { [pattern]: "allow" }
      return true
    }
    if (typeof current === "string") {
      if (current === "allow") return false
      store.permission[permission] = { "*": current, [pattern]: "allow" }
      return true
    }
    const keys = Object.keys(current)
    if (current[pattern] === "allow" && keys[keys.length - 1] === pattern) return false
    delete current[pattern]
    current[pattern] = "allow"
    return true
  }
```

Delete that block (comment included) from inside the plugin function. Add the
following at **module level**, immediately after the `normalizeRequest`
function and before the `export const PersistPermissionsPlugin` line. This text
must be byte-identical to the `addAllowRule` already at module level in
`src/tui.tsx`:

```ts
// Appends the pattern as an allow rule. Re-adding moves it to the end so the
// freshest approval wins under last-rule-wins evaluation.
function addAllowRule(store: Store, permission: string, pattern: string): boolean {
  const current = store.permission[permission]
  if (current === undefined) {
    store.permission[permission] = { [pattern]: "allow" }
    return true
  }
  if (typeof current === "string") {
    if (current === "allow") return false
    store.permission[permission] = { "*": current, [pattern]: "allow" }
    return true
  }
  const keys = Object.keys(current)
  if (current[pattern] === "allow" && keys[keys.length - 1] === pattern) return false
  delete current[pattern]
  current[pattern] = "allow"
  return true
}
```

Note the changes versus the closure version: `function` declaration instead of
`const` arrow, 2-space body indentation instead of 4, and the comment rewrapped
to match `src/tui.tsx` exactly ("...to the end so the / freshest approval...").
No call sites change (`addAllowRule` is called inside `persist`).

### 2. Hoist `trim` in both files to module scope

Both files contain this closure-scoped helper (in `src/index.ts` inside
`PersistPermissionsPlugin`, in `src/tui.tsx` inside `tui`):

```ts
  const trim = (collection: Map<string, unknown> | Set<string>, max = 500) => {
    while (collection.size > max) {
      const oldest = collection.keys().next().value
      if (oldest === undefined) break
      collection.delete(oldest)
    }
  }
```

Delete it from both closures. Add the following at **module level in both
files** (in `src/index.ts` next to the other module-level helpers, e.g. after
`addAllowRule`; in `src/tui.tsx` after its `addAllowRule`). Byte-identical in
both files:

```ts
// Drops oldest entries first; used to bound the per-request bookkeeping maps.
function trim(collection: Map<string, unknown> | Set<string>, max = 500) {
  while (collection.size > max) {
    const oldest = collection.keys().next().value
    if (oldest === undefined) break
    collection.delete(oldest)
  }
}
```

Call sites in both files are unchanged.

### 3. New file `test/helpers/source.ts`

```ts
import fs from "node:fs/promises"
import path from "node:path"

export const SERVER_SOURCE = path.join(import.meta.dir, "..", "..", "src", "index.ts")
export const TUI_SOURCE = path.join(import.meta.dir, "..", "..", "src", "tui.tsx")

export async function readSource(file: string): Promise<string> {
  return fs.readFile(file, "utf8")
}

// Extracts a top-level declaration from source text. `marker` must be the
// exact start of the declaration's first line (column 0). A line ending in "{"
// starts a block that runs through the first following line that is exactly
// "}" (a top-level close); anything else is a single-line declaration.
export function extractDeclaration(source: string, marker: string): string {
  const lines = source.split("\n")
  const start = lines.findIndex((line) => line.startsWith(marker))
  if (start === -1) throw new Error(`declaration not found: ${marker}`)
  if (!lines[start].trimEnd().endsWith("{")) return lines[start].trimEnd()
  const end = lines.findIndex((line, index) => index > start && line === "}")
  if (end === -1) throw new Error(`unterminated declaration: ${marker}`)
  return lines.slice(start, end + 1).join("\n")
}
```

### 4. New file `test/duplication-guard.test.ts`

```ts
import { describe, expect, test } from "bun:test"
import { SERVER_SOURCE, TUI_SOURCE, extractDeclaration, readSource } from "./helpers/source"

// src/index.ts and src/tui.tsx duplicate their matching/store core on purpose:
// each half must stay a self-contained single file (see the header comments in
// both). This guard turns that convention into a failing test — edit one copy
// without the other and the mismatch fails here instead of shipping as skewed
// behavior between the halves.
const SHARED_DECLARATIONS = [
  "const STORE_BASENAME",
  "const OPENCODE_GITIGNORE_DEFAULTS",
  "type Action",
  "type Store",
  "type Rule",
  "function wildcardMatch(",
  "function expandHome(",
  "function rulesFrom(",
  "function evaluate(",
  "function addAllowRule(",
  "function trim(",
]

describe("duplicated helpers stay identical between src/index.ts and src/tui.tsx", () => {
  for (const marker of SHARED_DECLARATIONS) {
    test(marker, async () => {
      const server = extractDeclaration(await readSource(SERVER_SOURCE), marker)
      const tui = extractDeclaration(await readSource(TUI_SOURCE), marker)
      expect(tui).toBe(server)
    })
  }
})
```

All eleven declarations already exist at module level in both files after
steps 1–2, with identical text. If any comparison fails, fix the *source
files* so the two copies match byte-for-byte — do not weaken the test with
normalization beyond what `extractDeclaration` already does.

## files_in_scope

- `src/index.ts` (hoist `addAllowRule`, hoist `trim` — no other edits)
- `src/tui.tsx` (hoist `trim` — no other edits)
- `test/helpers/source.ts` (new)
- `test/duplication-guard.test.ts` (new)

## do_not_touch

- `test/plugin.test.ts`, `test/tui.test.ts`, `test/sdk-contract.test.ts`
- `README.md`, `package.json`, `tsconfig.json`
- Any logic beyond relocating the two helpers.

## acceptance_criteria

- `bun test` passes, including 11 new guard tests.
- `bun run typecheck` passes.
- `src/index.ts` and `src/tui.tsx` contain no new `export` statements
  (`git diff` shows none).
- Deleting a single character from `wildcardMatch` in exactly one of the two
  source files makes `bun test` fail in `duplication-guard.test.ts` (verify by
  hand, then revert).

## tests

- Must still pass: every existing test in `test/plugin.test.ts`,
  `test/tui.test.ts`, `test/sdk-contract.test.ts`.
- New: `test/duplication-guard.test.ts` as specified above.

## non_goals

- No deduplication into a shared module — the single-file constraint is a
  documented invariant.
- No guarding of `readStore` / `writeStore` / `ensureGitignored` — those
  legitimately differ between the halves (logging, path derivation) and are
  covered behaviorally by T3 instead.
- No behavior changes of any kind.

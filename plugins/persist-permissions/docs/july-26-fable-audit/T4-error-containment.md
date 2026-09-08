# T4 — Contain write-path and malformed-store failures

`from_finding: F3` · `size: M` · `dependencies: T1`

## background

This repo (`opencode-persist-permissions`) is an OpenCode plugin with two
production files. `src/index.ts` (server half) persists "always" permission
approvals to `.opencode/permissions.local.json` from inside an `event` hook
that OpenCode calls for every server event; `src/tui.tsx` (TUI half) writes the
same store from a user-driven dialog flow (`run`) registered as a keymap
command. Both halves read the store defensively (a corrupt JSON file is never
overwritten; a missing file means an empty store), and the server half's own
comment states the philosophy: *"Logging must never disturb permission
handling."*

The **write** paths do not live up to that philosophy:

1. In `src/index.ts`, `persist()` calls `await writeStore(store)` and
   `await ensureGitignored()` with no try/catch. On a read-only filesystem,
   ENOSPC, or a permissions error, the rejection escapes the `event` hook into
   OpenCode's event dispatcher — unknown consequences, possibly a degraded
   plugin for the rest of the session.
2. In `src/tui.tsx`, the same two calls inside `run()` are uncaught. The user
   confirms the dialog, the write fails, and the flow exits via its `finally`
   with **no feedback at all**: no rule saved, no reply sent, prompt still
   open, silence.
3. `src/tui.tsx`'s reply-failure catch toasts *"…the permission request was
   already answered."* for **any** failure, including network errors where the
   prompt is in fact still open — the message asserts a cause it cannot know.
4. A hand-edited store can crash rule evaluation: `readStore` only validates
   that `parsed.permission` is an object, so `{"permission": {"bash": null}}`
   reaches `rulesFrom`, where `Object.entries(null)` throws — on **every**
   permission event. The same value reaches `addAllowRule`, where
   `Object.keys(null)` throws during persist.

Items 1–3 are containment; item 4 is hardening two helpers that are
**duplicated between the two files as a documented invariant** (each half must
stay a self-contained single file). Ticket T1 added
`test/duplication-guard.test.ts`, which fails unless duplicated helpers stay
byte-identical across `src/index.ts` and `src/tui.tsx` — so the `rulesFrom`
and `addAllowRule` edits below must be applied **identically to both files**.

Runtime is Bun (`bun test`, `bun run typecheck` — strict tsc).

## invariants

- **Fail closed.** No failure may cause anything to be auto-approved or
  persisted that would not have been otherwise. Malformed store values must be
  treated as "no allow rule" (skip / replace), never as "allow".
- A corrupt (unparseable) store file must still never be overwritten —
  `readStore` returning `undefined` for parse failures is existing behavior;
  do not change it.
- **Do not add any `export`** to either production file (OpenCode's plugin
  loader may call function exports as plugins).
- `rulesFrom` and `addAllowRule` must remain byte-identical between
  `src/index.ts` and `src/tui.tsx` (enforced by
  `test/duplication-guard.test.ts` from T1).
- Store file format unchanged: `{"permission": {tool: action | {pattern: action}}}`.
- All existing tests must still pass. One existing test in `test/tui.test.ts`
  ("when the request was answered meanwhile, the rule is still saved") asserts
  only the toast *variant* (`"warning"`), not its message — the reword in
  step 3 is compatible.

## change

### 1. `src/index.ts` — contain write failures in `persist()`

The end of `persist()` currently reads:

```ts
    if (!changed) return
    await writeStore(store)
    await ensureGitignored()
    log("info", `saved allow rule for "${request.permission}": ${added.join(", ")}`)
```

Replace with:

```ts
    if (!changed) return
    try {
      await writeStore(store)
      await ensureGitignored()
    } catch (error) {
      // A user approval that cannot be saved must not take down the event
      // pipeline — log it and leave the store as it was.
      log("error", `failed to save allow rule for "${request.permission}": ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    log("info", `saved allow rule for "${request.permission}": ${added.join(", ")}`)
```

### 2. `src/tui.tsx` — contain write failures in `run()`

Inside `run()`, after the `addAllowRule` loop, the code currently reads:

```ts
      await writeStore(store)
      await ensureGitignored()
```

Replace with:

```ts
      try {
        await writeStore(store)
        await ensureGitignored()
      } catch (error) {
        toast("error", `Not saved: could not write ${storeFile()} (${error instanceof Error ? error.message : String(error)}).`)
        return
      }
```

(The `return` runs before `selfAnswered.add` and before the reply call, so the
host prompt stays answerable — same as the existing corrupt-store early
return.)

### 3. `src/tui.tsx` — stop asserting a cause the code cannot know

The reply-failure catch currently reads:

```ts
      } catch {
        // Likely answered elsewhere while the dialog was open. The rule is
        // saved either way; that is what the user asked for.
        toast("warning", `Saved ${saved}, but the permission request was already answered.`)
      }
```

Replace with:

```ts
      } catch {
        // Usually the request was answered elsewhere while the dialog was
        // open, but any reply failure lands here — don't claim to know. The
        // rule is saved either way; that is what the user asked for.
        toast("warning", `Saved ${saved}, but the prompt could not be answered — it may already have been resolved.`)
      }
```

### 4. Harden `rulesFrom` — identically in BOTH files

In both `src/index.ts` and `src/tui.tsx`, replace the whole `rulesFrom`
function (keep the comment above it unchanged) with:

```ts
function rulesFrom(store: Store): Rule[] {
  const rules: Rule[] = []
  for (const [permission, value] of Object.entries(store.permission ?? {})) {
    if (typeof value === "string") {
      rules.push({ permission, pattern: "*", action: value })
      continue
    }
    // Hand-edited stores can hold anything; skip junk values instead of crashing.
    if (!value || typeof value !== "object") continue
    for (const [pattern, action] of Object.entries(value)) {
      rules.push({ permission, pattern: expandHome(pattern), action })
    }
  }
  return rules
}
```

### 5. Harden `addAllowRule` — identically in BOTH files

In both files, replace the whole `addAllowRule` function body (keep the
comment above it unchanged) with:

```ts
function addAllowRule(store: Store, permission: string, pattern: string): boolean {
  const current = store.permission[permission]
  if (typeof current === "string") {
    if (current === "allow") return false
    store.permission[permission] = { "*": current, [pattern]: "allow" }
    return true
  }
  if (!current || typeof current !== "object") {
    // Absent — or junk from a hand-edited store, replaced by a valid rule map.
    store.permission[permission] = { [pattern]: "allow" }
    return true
  }
  const keys = Object.keys(current)
  if (current[pattern] === "allow" && keys[keys.length - 1] === pattern) return false
  delete current[pattern]
  current[pattern] = "allow"
  return true
}
```

(Semantics for valid inputs are unchanged; the string-form check now comes
first and the `undefined` branch also absorbs `null`/junk.)

### 6. New tests

Append to `test/plugin.test.ts` (it already provides `root`, `makeClient`,
`load`, `storeFile`, `readJson`, `asked`, `replied` — reuse them):

```ts
describe("failure containment", () => {
  test("an unwritable store path is logged as an error, not thrown", async () => {
    // The store path exists as a DIRECTORY, so writeStore's tmp-file rename fails.
    await fs.mkdir(storeFile(), { recursive: true })
    const { client, logs } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked())
    await hooks.event!(replied("always")) // must resolve, not reject

    expect(
      logs.some(
        (entry) => entry.body.level === "error" && String(entry.body.message).includes("failed to save"),
      ),
    ).toBe(true)
  })

  test("a malformed store value (null) fails closed instead of crashing", async () => {
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(storeFile(), JSON.stringify({ permission: { bash: null } }))
    const { client, replies } = makeClient()
    const hooks = await load(client)

    await hooks.event!(asked()) // must not throw
    expect(replies).toHaveLength(0) // and must not auto-approve

    // A genuine approval replaces the junk value with a valid rule map.
    await hooks.event!(replied("always"))
    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "git status *": "allow" })
  })
})
```

Append to `test/tui.test.ts` inside the `describe("edit-scope-and-allow
flow", ...)` block (it provides `makeApi`, `loadCommand`, `tick`, `storeFile`):

```ts
  test("an unwritable store path toasts an error and leaves the prompt answerable", async () => {
    // The store path exists as a DIRECTORY, so writeStore's tmp-file rename fails.
    await fs.mkdir(storeFile(), { recursive: true })
    const harness = makeApi()
    const run = await loadCommand(harness)

    const done = run()
    await tick()
    harness.dialog()!.onConfirm("docker compose up *")
    await done

    expect(harness.replies).toHaveLength(0)
    expect(
      harness.toasts.some((toast) => toast.variant === "error" && String(toast.message).includes("Not saved")),
    ).toBe(true)
  })
```

## files_in_scope

- `src/index.ts` (steps 1, 4, 5)
- `src/tui.tsx` (steps 2, 3, 4, 5)
- `test/plugin.test.ts` (step 6 — append only)
- `test/tui.test.ts` (step 6 — append only)

## do_not_touch

- `readStore` / `writeStore` / `ensureGitignored` implementations in both files
  (their behavior is correct; only their *callers* gain try/catch).
- `test/duplication-guard.test.ts`, `test/matching-spec.test.ts`,
  `test/sdk-contract.test.ts`, `test/cross-half-contract.test.ts` (if present),
  `README.md`, `package.json`, `tsconfig.json`.

## acceptance_criteria

- `bun test` passes, including the 3 new tests and — critically — the
  duplication-guard tests, which prove `rulesFrom`/`addAllowRule` were edited
  identically in both files.
- `bun run typecheck` passes.
- No new exports in either production file.
- Grep check: neither `await writeStore` nor `await ensureGitignored` appears
  outside a `try` block in either production file.

## tests

- Must still pass: everything, notably `test/tui.test.ts` "when the request
  was answered meanwhile, the rule is still saved" (asserts warning variant
  only) and `test/plugin.test.ts` "a corrupt store file is never overwritten".
- New: the three tests in step 6, verbatim.

## non_goals

- No retry logic, no queuing of failed writes.
- No change to how a corrupt (unparseable) store is handled.
- No validation-on-read schema for the store beyond the two crash fixes —
  unknown action strings etc. already fail closed via `=== "allow"` checks.
- Toast wording is pinned by tests but flagged for human review (see index,
  open question 1).

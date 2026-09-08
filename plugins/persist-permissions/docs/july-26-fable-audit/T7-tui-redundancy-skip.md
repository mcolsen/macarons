# T7 — TUI edit flow: skip already-allowed unedited suggestions

`from_finding: F6` · `size: M` · `dependencies: T4 (edits the same code region; land T4 first)`

## background

This repo (`opencode-persist-permissions`) is an OpenCode plugin. Its server
half (`src/index.ts`) persists "always" permission approvals to
`.opencode/permissions.local.json`; its TUI half (`src/tui.tsx`) adds an
"edit the allow pattern before approving" dialog flow (`run()` inside the
exported `tui` function).

The store file is user-facing and hand-editable (the README promotes copying
entries into `opencode.json` verbatim). To keep it clean, the **server half's**
persist path skips patterns the store already allows — its comment explains
this exists so a broader rule (possibly just written by the TUI edit flow)
isn't shadowed by redundant narrower entries. The **TUI edit flow** has no such
skip: it calls `addAllowRule` unconditionally for every confirmed pattern. When
a prompt appears even though a broad covering rule exists (real case: a
multi-pattern request only partially covered by the store), confirming the
pre-filled suggestion appends a redundant narrower entry the server half would
have skipped. The two save paths quietly disagree.

The fix mirrors the server's skip in the TUI flow — **but only for patterns
the user did not edit.** A pattern the user actually typed must always be
appended: re-asserting it may be the point, because rule evaluation is
last-matching-rule-wins, so re-adding an allow rule at the end deliberately
overrides a later `"ask"`/`"deny"` carve-out (e.g. store
`{"git *": "allow", "git push *": "ask"}` + user re-confirms `git push *`).

Relevant helpers already present at module level in `src/tui.tsx` (do not
redefine them): `rulesFrom(store)` flattens the store into an ordered rule
list; `evaluate(permission, pattern, rules)` returns
`"allow" | "ask" | "deny"` with last-match-wins, `"ask"` when unmatched;
`addAllowRule(store, permission, pattern)` returns `true` if the store
changed. Inside `run()`, `suggested` (array) holds the dialog pre-fills and
`edited` (array, same length, index-aligned) holds what the user confirmed.

Ticket T4 (a prerequisite) wrapped the write calls in try/catch and set the
reply-failure warning toast. This ticket's code blocks below show the region
**as T4 left it** — if the "current" block doesn't match, T4 has not landed.

Runtime is Bun (`bun test`, `bun run typecheck` — strict tsc).

## invariants

- The reply decision is unchanged: reply `"always"` only when the (possibly
  unchanged) store covers the request's whole `always` set, else `"once"`.
- A user-typed (edited) pattern is **always** appended via `addAllowRule`,
  even if the store already allows it — the last-rule-wins override use-case.
- An unedited suggestion that the store already allows is skipped; if nothing
  changes, **no write happens** (the store file must remain byte-identical).
- Even when nothing is written, the pending request is still answered (the
  user asked to approve it) and a toast still confirms the outcome.
- The success toast for a genuine save keeps its exact existing wording via
  `savedMessage(...)` — both save paths (edit flow and host-prompt toast) must
  keep reporting persistence in one voice.
- Do not touch `rulesFrom` / `evaluate` / `addAllowRule` (they are
  byte-identical duplicates of `src/index.ts` copies, enforced by
  `test/duplication-guard.test.ts`).
- No new exports in `src/tui.tsx`.

## change

### 1. `src/tui.tsx` — rework the save section of `run()`

Current code (post-T4), from the store read through the reply/toast block:

```ts
      const store = await readStore()
      if (!store) {
        toast("error", `Not saved: ${storeFile()} is unreadable JSON.`)
        return
      }
      for (const pattern of edited) {
        addAllowRule(store, request.permission, pattern)
      }
      try {
        await writeStore(store)
        await ensureGitignored()
      } catch (error) {
        toast("error", `Not saved: could not write ${storeFile()} (${error instanceof Error ? error.message : String(error)}).`)
        return
      }
```

Replace with:

```ts
      const store = await readStore()
      if (!store) {
        toast("error", `Not saved: ${storeFile()} is unreadable JSON.`)
        return
      }
      // Skip unedited suggestions the store already allows — the same
      // redundancy skip the server half applies — so confirming defaults never
      // piles narrower duplicates under an existing broader rule. Patterns the
      // user actually edited are always appended: re-asserting one may be the
      // point (last-rule-wins overrides a later ask/deny carve-out).
      const priorRules = rulesFrom(store)
      let changed = false
      for (let i = 0; i < edited.length; i++) {
        if (edited[i] === suggested[i] && evaluate(request.permission, edited[i], priorRules) === "allow") continue
        changed = addAllowRule(store, request.permission, edited[i]) || changed
      }
      if (changed) {
        try {
          await writeStore(store)
          await ensureGitignored()
        } catch (error) {
          toast("error", `Not saved: could not write ${storeFile()} (${error instanceof Error ? error.message : String(error)}).`)
          return
        }
      }
```

### 2. `src/tui.tsx` — make the outcome toasts truthful when nothing was written

Directly below the block from step 1, the code computes `rules`, `covered`,
`reply`, then sends the reply. In that section, the two toast calls currently
read (post-T4):

```ts
        toast("success", savedMessage(saved))
```

and

```ts
        toast("warning", `Saved ${saved}, but the prompt could not be answered — it may already have been resolved.`)
```

Replace them respectively with:

```ts
        toast("success", changed ? savedMessage(saved) : "Already covered by permissions.local.json — request approved.")
```

and

```ts
        toast(
          "warning",
          changed
            ? `Saved ${saved}, but the prompt could not be answered — it may already have been resolved.`
            : "Already covered by permissions.local.json, but the prompt could not be answered — it may already have been resolved.",
        )
```

Leave the comments above both toasts unchanged. Everything else in the reply
section (`rules`, `covered`, `reply`, `selfAnswered`, `trim`, `saved`, the
`api.client.permission.reply` call) stays exactly as it is — note `rules` is
computed *after* the mutation loop, which is required for the reply decision.

### 3. New tests

Append inside the `describe("edit-scope-and-allow flow", ...)` block of
`test/tui.test.ts` (helpers `makeApi`, `loadCommand`, `tick`, `storeFile`,
`readJson`, `request`, and imports `fs`, `path` already exist there):

```ts
  test("an unedited suggestion already covered by a broader rule is not re-persisted", async () => {
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(storeFile(), JSON.stringify({ permission: { bash: { "docker *": "allow" } } }))
    const before = await fs.readFile(storeFile(), "utf8")
    const harness = makeApi()
    const run = await loadCommand(harness)

    const done = run()
    await tick()
    // Confirm the pre-filled suggestion unchanged.
    harness.dialog()!.onConfirm("docker compose up *")
    await done

    expect(await fs.readFile(storeFile(), "utf8")).toBe(before)
    expect(harness.replies).toHaveLength(1)
    expect(harness.replies[0].reply).toBe("always")
    const success = harness.toasts.find((toast) => toast.variant === "success")
    expect(success?.message).toBe("Already covered by permissions.local.json — request approved.")
  })

  test("an unedited suggestion blocked by a later carve-out is still re-asserted", async () => {
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(
      storeFile(),
      JSON.stringify({ permission: { bash: { "git *": "allow", "git push *": "ask" } } }),
    )
    const harness = makeApi({
      requests: [request({ patterns: ["git push origin main"], always: ["git push *"] })],
    })
    const run = await loadCommand(harness)

    const done = run()
    await tick()
    expect(harness.dialog()!.value).toBe("git push *")
    harness.dialog()!.onConfirm("git push *")
    await done

    const store = await readJson(storeFile())
    // Last rule wins: the re-added allow must land after the ask carve-out.
    expect(Object.entries(store.permission.bash)).toEqual([
      ["git *", "allow"],
      ["git push *", "allow"],
    ])
    const success = harness.toasts.find((toast) => toast.variant === "success")
    expect(success?.message).toBe("Saved git push * to permissions.local.json — persists across sessions.")
  })

  test("a user-typed pattern is appended even when a broader rule already covers it", async () => {
    await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
    await fs.writeFile(storeFile(), JSON.stringify({ permission: { bash: { "docker *": "allow" } } }))
    const harness = makeApi()
    const run = await loadCommand(harness)

    const done = run()
    await tick()
    // The suggestion was "docker compose up *"; the user types something else.
    harness.dialog()!.onConfirm("docker run *")
    await done

    const store = await readJson(storeFile())
    expect(store.permission.bash).toEqual({ "docker *": "allow", "docker run *": "allow" })
  })
```

If `readJson` does not exist in `test/tui.test.ts`, it does — near the top:
`async function readJson(file: string)`.

## files_in_scope

- `src/tui.tsx` (steps 1–2)
- `test/tui.test.ts` (step 3 — append only)

## do_not_touch

- `src/index.ts` (the server half's skip already exists).
- The module-level helpers `rulesFrom`, `evaluate`, `addAllowRule`, `trim` in
  `src/tui.tsx` (duplication-guarded).
- The dialog loop above the save section (`suggested` / `edited` collection).
- All other test files, `README.md`, `package.json`, `tsconfig.json`.

## acceptance_criteria

- `bun test` passes, including the 3 new tests and all existing ones —
  notably `test/tui.test.ts` "confirming the suggested bash prefix persists it
  and replies 'always'" (empty store → `changed` is true → unchanged wording)
  and "the edit flow's own always-reply is not toasted twice".
- `bun run typecheck` passes.
- The duplication-guard suite still passes (proves the shared helpers were not
  touched).

## tests

- Must still pass: all existing tests, especially the whole
  `edit-scope-and-allow flow` describe block.
- New: the 3 tests in step 3, verbatim.

## non_goals

- No change to the server half.
- No dedup/compaction of rules already in the store (e.g. removing narrower
  entries when a broader one is added) — out of scope.
- No change to the reply ("once"/"always") decision logic.

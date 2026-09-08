# T6 — Document the last-writer-wins store concurrency model

`from_finding: F5` · `size: S` · `dependencies: none`

## background

This repo (`opencode-persist-permissions`) is an OpenCode plugin. Both of its
production files write the same store file,
`.opencode/permissions.local.json`, with a read-modify-write sequence
finishing in an atomic temp-file-plus-rename (`writeStore` in `src/index.ts`
and `src/tui.tsx`). The rename guarantees the file is never torn or truncated,
but there is no cross-process merge or lock: if two OpenCode instances are
open on the same project and both persist an approval at nearly the same
moment, the last writer wins and the other instance's just-saved rule is
silently dropped.

The audit decision (deliberate, reviewed): **do not build merge-on-write or
locking.** The read-to-write windows are milliseconds (both halves read the
store immediately before mutating and writing, within the same event
handling), the collision requires two instances answering prompts in the same
project near-simultaneously, and the worst outcome is one extra permission
prompt in a later session — after which answering "always" restores the rule.
The correct fix at this severity is to *state the model* where users and
future maintainers will look: the README's caveats section and a comment at
both write sites.

The README (`README.md`) has a `## Scope and caveats` section containing
bulleted caveats ("**Project-scoped.**", "**Narrow by design.**", "**A brief
prompt flash is possible.**", "**Version target: OpenCode V1 only.**").

## invariants

- **No behavior changes whatsoever.** This ticket only adds documentation: one
  README bullet and one identical comment in each production file.
- `writeStore` is intentionally *not* identical between the two files (they
  derive paths differently) and is not covered by the duplication-guard test —
  adding the same comment above both is safe.
- No new exports in either production file.

## change

### 1. `README.md` — add a caveat bullet

In the `## Scope and caveats` section, insert the following bullet immediately
after the "**A brief prompt flash is possible.**" bullet:

```markdown
- **One project, one OpenCode instance (for saving).** Writes to the store are read-modify-write finished by an atomic rename: the file can never be torn or half-written, but there is no cross-instance merge — if two OpenCode instances on the same project persist an approval at nearly the same moment, the last writer wins and the other rule is dropped. The cost is one extra prompt in a later session; answer "always" again and the rule is back. Reading is unaffected: any number of instances can share the store.
```

### 2. `src/index.ts` — comment above `writeStore`

The function currently reads:

```ts
  const writeStore = async (store: Store) => {
    await fs.mkdir(opencodeDir, { recursive: true })
    const tmp = `${storeFile}.${process.pid}.${Date.now().toString(36)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(store, null, 2) + "\n")
    await fs.rename(tmp, storeFile)
  }
```

Add this comment directly above it:

```ts
  // Atomic replace (tmp + rename): concurrent writers can never tear the
  // file, but last-writer-wins — a rule saved by another instance inside the
  // read→write window is dropped. Accepted; see "Scope and caveats" in the
  // README.
```

### 3. `src/tui.tsx` — the same comment above its `writeStore`

The function currently reads:

```ts
  const writeStore = async (store: Store) => {
    const file = storeFile()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(store, null, 2) + "\n")
    await fs.rename(tmp, file)
  }
```

Add the identical comment from step 2 directly above it.

## files_in_scope

- `README.md`
- `src/index.ts` (comment only)
- `src/tui.tsx` (comment only)

## do_not_touch

- Any executable code. `git diff` on the two source files must show only added
  comment lines.
- All test files, `package.json`, `tsconfig.json`.

## acceptance_criteria

- `bun test` and `bun run typecheck` pass (trivially — no code changed).
- `git diff --stat` shows changes only in the three listed files; the source
  file diffs contain only lines starting with `//` (plus context).
- The README bullet appears in `## Scope and caveats`, after the prompt-flash
  bullet and before the version-target bullet.

## tests

- Must still pass: everything (no new tests — nothing executable changed).

## non_goals

- No merge-on-write, no file locking, no retry/reconcile logic — explicitly
  rejected at this severity (see background). If parallel-instance use ever
  becomes a first-class workflow, revisit with a re-read-and-reapply step
  inside the persist paths.
- No changes to store format or write atomicity.

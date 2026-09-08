# T5 — Never persist a synthesized `"*"` pattern

`from_finding: F4` · `size: S` · `dependencies: none (touches src/index.ts only)`

## background

This repo (`opencode-persist-permissions`) is an OpenCode plugin. Its server
half, `src/index.ts`, listens to permission events. When the user answers
"always" to a permission prompt, the plugin persists the **narrowest
interpretation** of the approval to `.opencode/permissions.local.json` — its
core, documented promise (file header, README): where OpenCode would remember a
blanket `"*"` for a whole tool, the plugin saves the request's concrete
patterns instead, **never tool-wide access**.

`normalizeRequest` in `src/index.ts` parses event properties into a `Request`.
It supports both the current event shape (`{permission, patterns, always}`)
and the pre-1.17 legacy shape (`{type, pattern}`). Two defensive defaults
interact badly:

- If an event carries no patterns at all, `patterns` defaults to `["*"]`.
- For legacy events (no `always` field), `always` defaults to `patterns`.

The `["*"]` default is **correct for evaluation** (auto-approval of a
pattern-less request then requires a blanket rule in the store — conservative,
fails closed). But it is **anti-conservative for persistence**: an "always"
reply to a pattern-less legacy event flows into `narrowest()`, where the
blanket `"*"` in `always` is replaced by `request.patterns` — which is the
same synthesized `["*"]` — and the plugin writes `{tool: {"*": "allow"}}`:
exactly the tool-wide forever-grant it promises never to create.

"The event carried no pattern information" and "the tool explicitly requested
`*`" (a real case: OpenCode's `codemode_execute` requests
`patterns: ["*"], always: ["*"]`, and persisting `"*"` is then correct —
nothing narrower exists) are currently indistinguishable. The fix: mark
synthesized patterns in `normalizeRequest`, and make `narrowest()` contribute
nothing for them, so a pattern-less "always" persists nothing at all.

The TUI half (`src/tui.tsx`) does not need this fix: it receives typed,
host-provided requests and its equivalent computations already yield an empty
set for pattern-less requests. Do not touch it.

Runtime is Bun (`bun test`, `bun run typecheck` — strict tsc).

## invariants

- Evaluation/auto-approval behavior is **unchanged**: pattern-less requests
  still evaluate as `["*"]` and still require a blanket store rule to
  auto-approve.
- Explicitly requested `"*"` patterns (present in the event's `patterns`
  array) still persist as `"*"` — the existing test *"when the request itself
  is for '\*', '\*' is persisted — nothing narrower exists"* in
  `test/plugin.test.ts` must keep passing unchanged.
- An explicit, concrete `always` set on an event with empty `patterns` must
  still persist (only the synthesized blanket is suppressed).
- No new exports in `src/index.ts` (OpenCode's plugin loader may call function
  exports as plugins).
- `src/tui.tsx` untouched.

## change

All edits in `src/index.ts`.

### 1. Extend the `Request` type

```ts
type Request = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  always: string[]
  // true when the event carried no patterns and "*" was invented for
  // evaluation; a synthesized "*" must never be persisted.
  synthesized: boolean
}
```

### 2. Replace `normalizeRequest`

Current version (for anchoring — comment included):

```ts
// Accepts both the current event shape ({permission, patterns, always}) and
// the pre-1.17 shape ({type, pattern}) so the plugin degrades gracefully.
function normalizeRequest(properties: unknown): Request | undefined {
  if (!properties || typeof properties !== "object") return
  const props = properties as Record<string, unknown>
  if (typeof props.id !== "string" || typeof props.sessionID !== "string") return

  const permission =
    typeof props.permission === "string" ? props.permission : typeof props.type === "string" ? props.type : undefined
  if (!permission) return

  let patterns = toStringArray(props.patterns)
  if (!patterns.length) patterns = toStringArray(props.pattern)
  if (!patterns.length) patterns = ["*"]

  // "always" holds the patterns OpenCode itself would remember for the
  // session; persist exactly those. Old versions had no such field.
  const always = "always" in props ? toStringArray(props.always) : patterns

  return { id: props.id, sessionID: props.sessionID, permission, patterns, always }
}
```

New version:

```ts
// Accepts both the current event shape ({permission, patterns, always}) and
// the pre-1.17 shape ({type, pattern}) so the plugin degrades gracefully.
// When an event carries no patterns at all, "*" is synthesized so evaluation
// stays conservative (auto-approval then needs a blanket rule) — but it is
// marked, because "no pattern information" must never PERSIST as "everything".
function normalizeRequest(properties: unknown): Request | undefined {
  if (!properties || typeof properties !== "object") return
  const props = properties as Record<string, unknown>
  if (typeof props.id !== "string" || typeof props.sessionID !== "string") return

  const permission =
    typeof props.permission === "string" ? props.permission : typeof props.type === "string" ? props.type : undefined
  if (!permission) return

  let patterns = toStringArray(props.patterns)
  if (!patterns.length) patterns = toStringArray(props.pattern)
  const synthesized = !patterns.length
  if (synthesized) patterns = ["*"]

  // "always" holds the patterns OpenCode itself would remember for the
  // session; persist exactly those. Old versions had no such field.
  const always = "always" in props ? toStringArray(props.always) : patterns

  return { id: props.id, sessionID: props.sessionID, permission, patterns, always, synthesized }
}
```

### 3. Replace `narrowest`

Current version (defined inside `PersistPermissionsPlugin`, above `persist`):

```ts
  const narrowest = (request: Request): string[] => {
    if (!request.always.length) return []
    return [...new Set(request.always.flatMap((pattern) => (pattern === "*" ? request.patterns : [pattern])))]
  }
```

New version (keep the existing multi-line comment above it, and append one
sentence to that comment: `A synthesized "*" (see normalizeRequest)
contributes nothing: no pattern information must not persist as everything.`):

```ts
  const narrowest = (request: Request): string[] => {
    if (!request.always.length) return []
    return [
      ...new Set(
        request.always.flatMap((pattern) =>
          pattern === "*" ? (request.synthesized ? [] : request.patterns) : [pattern],
        ),
      ),
    ]
  }
```

### 4. New tests

Append to `test/plugin.test.ts`, inside the top-level
`describe("persisting user approvals", ...)` block (helpers `makeClient`,
`load`, `asked`, `replied`, `storeFile`, `readJson`, and the imports `fs`,
`path` already exist in that file):

```ts
  describe("pattern-less requests never persist a blanket '*'", () => {
    test("a legacy-shape event without a pattern persists nothing", async () => {
      const { client } = makeClient()
      const hooks = await load(client)

      await hooks.event!({
        event: {
          type: "permission.asked",
          properties: { id: "per_1", sessionID: "ses_1", type: "bash" },
        },
      } as any)
      await hooks.event!(replied("always"))

      expect(fs.access(storeFile())).rejects.toThrow()
    })

    test("empty patterns with a blanket always-set persist nothing", async () => {
      const { client } = makeClient()
      const hooks = await load(client)

      await hooks.event!(asked({ patterns: [], always: ["*"] }))
      await hooks.event!(replied("always"))

      expect(fs.access(storeFile())).rejects.toThrow()
    })

    test("empty patterns with a concrete always-set still persist the always-set", async () => {
      const { client } = makeClient()
      const hooks = await load(client)

      await hooks.event!(asked({ patterns: [], always: ["git status *"] }))
      await hooks.event!(replied("always"))

      const store = await readJson(storeFile())
      expect(store.permission.bash).toEqual({ "git status *": "allow" })
    })

    test("auto-approval of pattern-less requests still requires a blanket rule", async () => {
      await fs.mkdir(path.join(root, ".opencode"), { recursive: true })
      await fs.writeFile(storeFile(), JSON.stringify({ permission: { bash: { "git *": "allow" } } }))
      const { client, replies } = makeClient()
      const hooks = await load(client)

      // A concrete prefix rule must NOT cover a pattern-less request...
      await hooks.event!({
        event: {
          type: "permission.asked",
          properties: { id: "per_1", sessionID: "ses_1", type: "bash" },
        },
      } as any)
      expect(replies).toHaveLength(0)

      // ...but a hand-written blanket still does.
      await fs.writeFile(storeFile(), JSON.stringify({ permission: { bash: "allow" } }))
      await hooks.event!({
        event: {
          type: "permission.asked",
          properties: { id: "per_2", sessionID: "ses_1", type: "bash" },
        },
      } as any)
      expect(replies).toHaveLength(1)
    })
  })
```

## files_in_scope

- `src/index.ts`
- `test/plugin.test.ts` (append only)

## do_not_touch

- `src/tui.tsx` (already safe for pattern-less requests; also, duplicated-
  helper parity with it is guarded by a test — `normalizeRequest` and
  `narrowest` are server-only functions and are NOT in that guard, so these
  edits are safe).
- All other test files, `README.md`, `package.json`, `tsconfig.json`.

## acceptance_criteria

- `bun test` passes, including the 4 new tests.
- `bun run typecheck` passes.
- The existing tests *"when the request itself is for '\*', '\*' is
  persisted…"* and *"an empty always-list persists nothing…"* pass unchanged.
- No new exports in `src/index.ts`.

## tests

- Must still pass: all existing tests, especially the two named above and the
  whole `"blanket '*' approvals are narrowed to the requested patterns"`
  describe block.
- New: the 4 tests in step 4, verbatim.

## non_goals

- No change to evaluation/auto-approval semantics.
- No changes to `src/tui.tsx`.
- No attempt to persist *something* for pattern-less legacy requests (there is
  nothing trustworthy to persist; prompting again next session is the correct
  cost).

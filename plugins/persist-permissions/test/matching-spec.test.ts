import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  BAND_SAMPLE_VERSIONS as BAND,
  OPENCODE_ENGINE_RANGE,
} from "@macarons/permission-rules"
import {
  addAllowRule,
  allowRuleRedundant,
  createStoreKeyingResolver,
  discoverPrimaryRoot,
  discoverWorktreeRoot,
  type ExecRunner,
  evaluate,
  expandHome,
  isAllowed,
  migrateStores,
  migrateWorktreeStore,
  narrowestPatterns,
  openCodeCompatNotice,
  type PermissionStorePaths,
  pathExists,
  patternSubsumes,
  patternsOverlap,
  permissionStoreFile,
  preSlugPermissionStoreFile,
  type Rule,
  resolvePermissionStorePaths,
  rulesFrom,
  type Store,
  SUPPORTED_OPENCODE_RANGE,
  sessionOverrides,
  sessionRulesOf,
  storeMigrationCandidates,
  wildcardMatch,
} from "../src/shared"

/**
 * Table-driven behavior spec for the matching engine — the plugin's security
 * boundary. `wildcardMatch`, `expandHome`, `rulesFrom`, `evaluate`,
 * `addAllowRule` (plus the decision helpers `isAllowed`,
 * `narrowestPatterns`) decide what runs without a permission prompt. A
 * one-character regression in the regex-escape chain would not crash anything;
 * it would silently widen or narrow what gets auto-approved. The existing
 * suites exercise these only incidentally, through integration paths; this file
 * pins their semantics directly.
 *
 * These helpers used to be duplicated, unexported, inside src/index.ts and
 * src/tui.tsx (audit ticket T2 planned to extract them from each file's source
 * text and run one table against both copies). PR #9 deduplicated them into a
 * single exported src/shared.ts, and the approve-for-me work moved that
 * engine into the @macarons/permission-rules workspace library, which
 * src/shared.ts now re-exports. The table below imports through ../src/shared,
 * so it still runs against the one production copy directly. A guard at the
 * bottom asserts there is no second, untested copy hiding in either production
 * half — and that shared.ts really re-exports the library's definitions.
 *
 * `expandHome` reads `os.homedir()` and `wildcardMatch` reads
 * `process.platform`; both are pinned below so the table is deterministic on
 * any machine, including Windows.
 */

const FAKE_HOME = "/home/u"

// process.platform is a configurable data property; snapshot its descriptor so
// afterAll can put the real value back for the rest of the suite.
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    ...realPlatform,
    value: platform,
  })
}

let homedir: ReturnType<typeof spyOn>

beforeAll(() => {
  // src/shared.ts imports the same node:os singleton, so this spy reaches its
  // os.homedir() call. Restored in afterAll so no other test file sees it.
  homedir = spyOn(os, "homedir").mockReturnValue(FAKE_HOME)
  setPlatform("linux")
})

afterAll(() => {
  homedir.mockRestore()
  Object.defineProperty(process, "platform", realPlatform)
})

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
  ["src/app.ts", "src\\app.ts", true], // ...on the pattern side too
  ["echo hi\nrm -rf /", "echo *", true], // "*" spans newlines (s flag) — multi-line bash commands
  ["GIT STATUS", "git status", false], // case-sensitive off Windows
  ["", "*", true],
  ["anything", "*", true],
]

const EXPAND_CASES: [pattern: string, expected: string][] = [
  ["~", FAKE_HOME],
  ["~/notes/*", `${FAKE_HOME}/notes/*`],
  ["$HOME/notes", `${FAKE_HOME}/notes`],
  ["$HOME", FAKE_HOME],
  ["~notes", "~notes"], // only "~" and "~/" expand
  ["a/~/b", "a/~/b"], // only at the start of the pattern
  ["/abs/path/*", "/abs/path/*"], // absolute paths are untouched
  ["git *", "git *"], // non-path patterns are untouched
]

describe(`OpenCode runtime compatibility (${SUPPORTED_OPENCODE_RANGE})`, () => {
  // The suite now enforces exactly one hard boundary — OpenCode v1 — and warns
  // (without disabling) for every v1 host outside the verified band. [version,
  // compat, disables?].
  const cases: [
    version: unknown,
    compat: "supported" | "untested" | "incompatible",
    disable: boolean,
  ][] = [
    [BAND.belowBand, "untested", false], // below the floor: warn but run
    [BAND.floor, "supported", false], // verified floor
    [BAND.inBand, "supported", false],
    [`${BAND.inBand}+build.1`, "supported", false], // build metadata does not change precedence
    [`${BAND.floor}-beta.1`, "untested", false], // a v1 prerelease: untested, not disabled
    [BAND.aboveBand, "untested", false], // past the ceiling: untested, not disabled
    ["not-a-version", "untested", false], // unreadable → fail open
    [undefined, "untested", false], // probe could not name the version
    ["2.0.0", "incompatible", true], // OpenCode v2 changes the plugin API
    ["2.0.0-beta.1", "incompatible", true], // the v2 beta, specifically
    ["0.9.9", "incompatible", true], // predates the plugin API
  ]

  for (const [version, compat, disable] of cases) {
    test(`${JSON.stringify(version)} -> ${compat} (disable=${disable})`, () => {
      const notice = openCodeCompatNotice(
        version as string | undefined,
        SUPPORTED_OPENCODE_RANGE,
        "Permission persistence",
      )
      if (compat === "supported") {
        expect(notice).toBeNull()
      } else {
        expect(notice?.compat).toBe(compat)
        expect(notice?.disable).toBe(disable)
      }
    })
  }

  test("package.json engines declares the static v1 install gate", async () => {
    const pkg = JSON.parse(
      await fs.readFile(
        path.join(import.meta.dir, "..", "package.json"),
        "utf8",
      ),
    ) as {
      engines?: { opencode?: string }
    }
    expect(pkg.engines?.opencode).toBe(OPENCODE_ENGINE_RANGE)
  })
})

describe("matching engine (src/shared.ts)", () => {
  describe("wildcardMatch", () => {
    for (const [input, pattern, expected] of WILDCARD_CASES) {
      test(`${JSON.stringify(input)} vs ${JSON.stringify(pattern)} -> ${expected}`, () => {
        expect(wildcardMatch(input, pattern)).toBe(expected)
      })
    }

    test("matching is case-insensitive on win32", () => {
      setPlatform("win32")
      try {
        expect(wildcardMatch("GIT Status", "git status")).toBe(true)
        // "*"/"?"/"." semantics still hold under the i flag
        expect(wildcardMatch("SRC.TS", "src.ts")).toBe(true)
        expect(wildcardMatch("SRCXTS", "src.ts")).toBe(false)
      } finally {
        setPlatform("linux")
      }
    })
  })

  describe("expandHome", () => {
    for (const [pattern, expected] of EXPAND_CASES) {
      test(`${JSON.stringify(pattern)} -> ${JSON.stringify(expected)}`, () => {
        expect(expandHome(pattern)).toBe(expected)
      })
    }
  })

  describe("rulesFrom", () => {
    test("string form means a blanket '*' pattern", () => {
      expect(rulesFrom({ permission: { webfetch: "allow" } })).toEqual([
        { permission: "webfetch", pattern: "*", action: "allow" },
      ])
    })

    test("object form preserves insertion order and expands '~'", () => {
      const rules = rulesFrom({
        permission: {
          bash: { "git *": "allow", "git push *": "ask" },
          read: { "~/secrets/*": "deny" },
        },
      })
      expect(rules).toEqual([
        { permission: "bash", pattern: "git *", action: "allow" },
        { permission: "bash", pattern: "git push *", action: "ask" },
        {
          permission: "read",
          pattern: `${FAKE_HOME}/secrets/*`,
          action: "deny",
        },
      ])
    })

    test("a missing permission map yields no rules", () => {
      expect(rulesFrom({ permission: {} })).toEqual([])
      // Defends the `?? {}` guard against a malformed store.
      expect(rulesFrom({} as Store)).toEqual([])
    })
  })

  describe("evaluate", () => {
    const rules = () =>
      rulesFrom({
        permission: { bash: { "git *": "allow", "git push *": "ask" } },
      })

    test("last matching rule wins", () => {
      expect(evaluate("bash", "git push origin main", rules())).toBe("ask")
      expect(evaluate("bash", "git log", rules())).toBe("allow")
    })

    test("unmatched requests stay 'ask'", () => {
      expect(evaluate("edit", "src/app.ts", rules())).toBe("ask")
      expect(evaluate("bash", "npm install", rules())).toBe("ask")
      expect(evaluate("bash", "anything", [])).toBe("ask") // no rules at all
    })

    test("the tool key is itself a wildcard pattern", () => {
      const blanket = rulesFrom({ permission: { "*": "deny" } })
      expect(evaluate("bash", "anything at all", blanket)).toBe("deny")
    })

    test("a later 'deny' overrides an earlier 'allow' for the same request", () => {
      const carveout = rulesFrom({
        permission: { bash: { "git *": "allow", "git push *": "deny" } },
      })
      expect(evaluate("bash", "git push --force", carveout)).toBe("deny")
    })
  })

  describe("sessionRulesOf", () => {
    test("reads the host's { permission, pattern, action } triples verbatim", () => {
      const session = {
        id: "ses_1",
        permission: [
          { permission: "*", pattern: "*", action: "ask" },
          { permission: "read", pattern: "*", action: "allow" },
        ],
      }
      expect(sessionRulesOf(session)).toEqual([
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "read", pattern: "*", action: "allow" },
      ])
    })

    test("drops junk instead of guessing", () => {
      expect(sessionRulesOf(undefined)).toEqual([])
      expect(sessionRulesOf({ permission: "everything" })).toEqual([])
      expect(
        sessionRulesOf({
          permission: [
            null,
            { permission: "bash" },
            { permission: "bash", pattern: "*", action: "maybe" },
          ],
        }),
      ).toEqual([])
    })
  })

  describe("sessionOverrides", () => {
    const sandbox: Rule[] = [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "read", pattern: "*.env", action: "ask" },
    ]

    test("an explicit ask/deny match overrides; a trailing allow does not", () => {
      expect(sessionOverrides("bash", ["git status"], sandbox)).toBe(true)
      expect(sessionOverrides("read", ["src/main.ts"], sandbox)).toBe(false)
      expect(sessionOverrides("read", ["config/.env"], sandbox)).toBe(true) // last match wins
    })

    test("any overridden pattern in the request blocks the whole request", () => {
      expect(sessionOverrides("read", ["src/main.ts", ".env"], sandbox)).toBe(
        true,
      )
    })

    test("no session rules — or none matching — is not an override", () => {
      expect(sessionOverrides("bash", ["git status"], [])).toBe(false)
      expect(
        sessionOverrides(
          "webfetch",
          ["https://x"],
          [{ permission: "read", pattern: "*", action: "ask" }],
        ),
      ).toBe(false)
    })
  })

  describe("addAllowRule", () => {
    test("creates the rule map for a new tool", () => {
      const store: Store = { permission: {} }
      expect(addAllowRule(store, "bash", "git *")).toBe(true)
      expect(store.permission.bash).toEqual({ "git *": "allow" })
    })

    test("a string-form blanket that is not 'allow' is preserved as '*' before the new rule", () => {
      const store: Store = { permission: { bash: "deny" } }
      expect(addAllowRule(store, "bash", "git *")).toBe(true)
      expect(
        Object.entries(store.permission.bash as Record<string, string>),
      ).toEqual([
        ["*", "deny"],
        ["git *", "allow"],
      ])
    })

    test("a string-form 'allow' blanket is already as broad as it gets", () => {
      const store: Store = { permission: { bash: "allow" } }
      expect(addAllowRule(store, "bash", "git *")).toBe(false)
      expect(store.permission.bash).toBe("allow")
    })

    test("re-adding an existing rule moves it to the end (freshest wins)", () => {
      const store: Store = {
        permission: { bash: { "a *": "allow", "b *": "allow" } },
      }
      expect(addAllowRule(store, "bash", "a *")).toBe(true)
      expect(
        Object.keys(store.permission.bash as Record<string, string>),
      ).toEqual(["b *", "a *"])
    })

    test("an allow rule already in last position is a no-op", () => {
      const store: Store = {
        permission: { bash: { "a *": "allow", "b *": "allow" } },
      }
      expect(addAllowRule(store, "bash", "b *")).toBe(false)
    })

    test("a non-allow entry for the same pattern is flipped and moved to the end", () => {
      const store: Store = {
        permission: { bash: { "git push *": "ask", "git *": "allow" } },
      }
      expect(addAllowRule(store, "bash", "git push *")).toBe(true)
      expect(
        Object.entries(store.permission.bash as Record<string, string>),
      ).toEqual([
        ["git *", "allow"],
        ["git push *", "allow"],
      ])
    })

    test("arbitrary literal permission and pattern keys never reach Object.prototype", () => {
      const store: Store = { permission: {} }
      const prototype = Object.prototype as Record<string, unknown>
      try {
        expect(prototype.polluted).toBeUndefined()
        expect(addAllowRule(store, "__proto__", "polluted")).toBe(true)
        expect(prototype.polluted).toBeUndefined()

        for (const key of ["__proto__", "constructor", "toString"])
          expect(addAllowRule(store, key, key)).toBe(true)

        expect(Object.getPrototypeOf(store.permission)).toBeNull()
        for (const key of ["__proto__", "constructor", "toString"]) {
          expect(Object.hasOwn(store.permission, key)).toBe(true)
          const patterns = store.permission[key]
          expect(typeof patterns).toBe("object")
          if (!patterns || typeof patterns === "string")
            throw new Error("unreachable")
          expect(Object.getPrototypeOf(patterns)).toBeNull()
          expect(Object.hasOwn(patterns, key)).toBe(true)
          expect(patterns[key]).toBe("allow")
        }
      } finally {
        delete prototype.polluted
      }
    })
  })

  // The decision helpers that sit directly on top of the engine: isAllowed
  // gates auto-approval, and narrowestPatterns decides what actually gets
  // persisted. Host replies are always "once", never inferred from a match
  // against a remember-rule's pattern string.
  describe("isAllowed", () => {
    const rules = () =>
      rulesFrom({
        permission: {
          read: { "~/notes/*": "allow" },
          bash: { "git *": "allow" },
        },
      })

    test("an empty pattern set is never allowed", () => {
      expect(isAllowed("read", [], rules())).toBe(false)
    })

    test("true only when every pattern is allowed", () => {
      expect(isAllowed("bash", ["git status", "git log"], rules())).toBe(true)
      expect(isAllowed("bash", ["git status", "npm install"], rules())).toBe(
        false,
      )
    })

    test("honors home expansion in the rules", () => {
      expect(isAllowed("read", [`${FAKE_HOME}/notes/todo.md`], rules())).toBe(
        true,
      )
      expect(isAllowed("read", [`${FAKE_HOME}/secrets/key`], rules())).toBe(
        false,
      )
    })

    test("a later carve-out un-allows a pattern", () => {
      const carveout = rulesFrom({
        permission: { bash: { "git *": "allow", "git push *": "ask" } },
      })
      expect(isAllowed("bash", ["git status"], carveout)).toBe(true)
      expect(isAllowed("bash", ["git push origin"], carveout)).toBe(false)
    })
  })

  describe("narrowestPatterns", () => {
    test("replaces the session-wide blanket '*' with the concrete request patterns", () => {
      expect(narrowestPatterns(["*"], ["src/a.ts", "src/b.ts"])).toEqual([
        "src/a.ts",
        "src/b.ts",
      ])
    })

    test("keeps non-blanket always patterns verbatim", () => {
      expect(narrowestPatterns(["git *"], ["git status"])).toEqual(["git *"])
    })

    test("expands '*' inline among other patterns, and dedupes the result", () => {
      expect(narrowestPatterns(["*", "git *"], ["x"])).toEqual(["x", "git *"])
      expect(narrowestPatterns(["*", "a.ts"], ["a.ts"])).toEqual(["a.ts"])
    })
  })
})

// T2's original goal was to run the table against *both* production copies so a
// divergence in one could never slip through untested. The copies are gone;
// this asserts why that is safe — the engine has exactly one definition site
// (the permission-rules library, tested above through ../src/shared's
// re-exports), and every consumer — both halves of this plugin AND the other
// consumer, approve-for-me — imports it rather than keeping a
// private, untested copy.
//
// This is a TRIPWIRE, not a proof. It is a text search: a copy that renames the
// helper, or declares it as an arrow function under a name not listed here,
// walks straight past it. What actually keeps the engine single-copy is that
// every consumer IMPORTS it and that the suites above exercise the imported
// behavior end to end. The tripwire only makes the cheap, likely regression —
// someone pastes a helper back into a plugin — fail loudly.
//
// Division of labor with libraries/permission-rules/test/sole-definition-site.
// test.ts: that sweep derives its roster from the library's exports and walks
// every plugin package with a stricter regex (it catches const/let/var forks
// too), so it owns fork detection across plugins/*. What it cannot check, and
// this file must, is the leg the tables above depend on — that ../src/shared
// re-exports each helper FROM THE LIBRARY SPECIFIER. An
// `export { isAllowed } from "./local-copy"` would keep both files' fork checks
// green while every table here silently ran against the wrong module.
describe("the tested engine is the only copy any consumer runs", () => {
  // Exactly the value helpers this file imports through ../src/shared, so the
  // re-export leg covers everything the tables actually exercise: the matching
  // engine, the decision helpers, and the store-path/keying/migration helpers
  // the repository-scope and migration tables run against.
  //
  // Deliberately hand-listed rather than derived from the library's exports:
  // a derived roster would drag in canonicalPath, isInside, writeJsonFile,
  // sdkClientBaseUrl and ~30 others this plugin never imports, and the
  // fromLibrary leg would then demand shared.ts re-export all of them.
  //
  // `winningRule` is deliberately absent even though the audit named it
  // (L-PP2): shared.ts does not re-export it and neither half calls it, so
  // listing it here would fail the re-export leg, and adding a re-export purely
  // to satisfy a test is dead surface. Its only consumer imports it straight
  // from the library, where the suite-wide sweep already covers it.
  //
  // Value names only. The regex below matches `export {` blocks, never
  // `export type {` (`\s*` cannot consume the literal `type`), so a type name
  // is never collected into fromLibrary and fails BOTH the re-export leg and
  // the definition-site one. That is the right outcome, but it fails for a
  // reason that has nothing to do with the type being a type — so do not read a
  // green run here as evidence that a type name was checked.
  const HELPERS = [
    "wildcardMatch",
    "expandHome",
    "rulesFrom",
    "evaluate",
    "addAllowRule",
    "isAllowed",
    "allowRuleRedundant",
    "narrowestPatterns",
    "sessionRulesOf",
    "sessionOverrides",
    "patternSubsumes",
    "patternsOverlap",
    "permissionStoreFile",
    "resolvePermissionStorePaths",
    "storeMigrationCandidates",
    "migrateWorktreeStore",
    "migrateStores",
    "createStoreKeyingResolver",
    "discoverPrimaryRoot",
    "discoverWorktreeRoot",
    "pathExists",
    "openCodeCompatNotice",
  ]
  const readSrc = (file: string) =>
    fs.readFile(path.join(import.meta.dir, "..", "src", file), "utf8")

  test("the permission-rules library is the sole definition site", async () => {
    const libraryEntry = Bun.resolveSync(
      "@macarons/permission-rules",
      path.join(import.meta.dir, ".."),
    )
    const libraryDir = path.dirname(libraryEntry)
    const librarySources = await Promise.all(
      (await fs.readdir(libraryDir))
        .filter((file) => file.endsWith(".ts"))
        .sort()
        .map(async (file) => ({
          file,
          source: await fs.readFile(path.join(libraryDir, file), "utf8"),
        })),
    )
    const shared = await readSrc("shared.ts")
    // The names shared.ts re-exports FROM THE LIBRARY specifier — an
    // `export { evaluate } from "./local-copy"` would keep the not-toContain
    // check green while the table runs against the wrong module.
    const fromLibrary = [
      ...shared.matchAll(
        /export\s*\{([^}]*)\}\s*from\s*["']@macarons\/permission-rules["']/g,
      ),
    ]
      .flatMap((match) => match[1]?.split(",") ?? [])
      .map((name) => name.trim())
    for (const helper of HELPERS) {
      // `export async function` for the I/O helpers — a bare `export function`
      // literal would silently bar every store, keying and migration helper
      // from the list this guard is allowed to carry. Helper names are plain
      // identifiers, so building the pattern from one is safe.
      const definition = new RegExp(`export (?:async )?function ${helper}\\(`)
      expect(
        librarySources
          .filter(({ source }) => definition.test(source))
          .map(({ file }) => file),
      ).toHaveLength(1)
      // shared.ts re-exports the engine; a local `function <helper>(` would be
      // a second copy the table never sees.
      expect(shared).not.toContain(`function ${helper}(`)
      expect(fromLibrary).toContain(helper)
    }
  })

  for (const file of ["index.ts", "tui.tsx"]) {
    test(`src/${file} imports the engine from ./shared and declares no private copy`, async () => {
      const source = await readSrc(file)
      expect(source).toMatch(/from\s*["']\.\/shared["']/)
      for (const helper of HELPERS) {
        expect(source).not.toContain(`function ${helper}(`)
      }
    })
  }

  test("approve-for-me declares no private engine copy either", async () => {
    // The library's other consumer, scanned read-only across the workspace.
    const dir = path.join(import.meta.dir, "..", "..", "approve-for-me", "src")
    const files = (await fs.readdir(dir)).filter((file) => /\.tsx?$/.test(file))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = await fs.readFile(path.join(dir, file), "utf8")
      for (const helper of HELPERS) {
        expect(source).not.toContain(`function ${helper}(`)
      }
    }
  })
})

describe("trusted permission-store paths", () => {
  test("keys a store under the config directory, outside the project", async () => {
    // realpath: resolvePermissionStorePaths canonicalizes the roots, so on a
    // symlinked tmpdir (macOS /var → /private/var) a raw sandbox would hash
    // to a different store path than the one asserted below.
    const sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "permission-store-path-")),
    )
    try {
      const project = path.join(sandbox, "project")
      const config = path.join(sandbox, "config")
      await Promise.all([fs.mkdir(project), fs.mkdir(config)])
      const resolved = await resolvePermissionStorePaths(project, config)
      expect(resolved?.storeFile).toBe(permissionStoreFile(config, project))
      expect(path.relative(project, resolved!.storeFile).startsWith("..")).toBe(
        true,
      )
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  })

  test("rejects config roots and descendant symlinks that enter the project", async () => {
    const sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "permission-store-path-")),
    )
    try {
      const project = path.join(sandbox, "project")
      const config = path.join(sandbox, "config")
      await Promise.all([fs.mkdir(project), fs.mkdir(config)])
      expect(
        await resolvePermissionStorePaths(
          project,
          path.join(project, ".config"),
        ),
      ).toBeUndefined()

      const redirected = path.join(project, "agent-controlled")
      await fs.mkdir(redirected)
      await fs.symlink(redirected, path.join(config, "persist-permissions"))
      expect(await resolvePermissionStorePaths(project, config)).toBeUndefined()
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  })

  test("a keyRoot re-keys the store and exposes the worktree-keyed file", async () => {
    const sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "permission-store-path-")),
    )
    try {
      const primary = path.join(sandbox, "primary")
      const worktree = path.join(sandbox, "worktree")
      const config = path.join(sandbox, "config")
      await Promise.all([
        fs.mkdir(primary),
        fs.mkdir(worktree),
        fs.mkdir(config),
      ])

      const resolved = await resolvePermissionStorePaths(
        worktree,
        config,
        primary,
      )
      expect(resolved?.keyRoot).toBe(primary)
      expect(resolved?.projectRoot).toBe(worktree)
      expect(resolved?.storeFile).toBe(permissionStoreFile(config, primary))
      expect(resolved?.worktreeStoreFile).toBe(
        permissionStoreFile(config, worktree),
      )
      // The legacy in-project file stays the SESSION's: previous releases
      // wrote it into the worktree the session ran in.
      expect(resolved?.legacyStoreFile.startsWith(worktree + path.sep)).toBe(
        true,
      )

      // A keyRoot equal to the project root collapses the pair.
      const collapsed = await resolvePermissionStorePaths(
        worktree,
        config,
        worktree,
      )
      expect(collapsed?.storeFile).toBe(permissionStoreFile(config, worktree))
      expect(collapsed?.worktreeStoreFile).toBeUndefined()
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  })

  test("a config directory inside the keyRoot is rejected like one inside the project", async () => {
    const sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "permission-store-path-")),
    )
    try {
      const primary = path.join(sandbox, "primary")
      const worktree = path.join(sandbox, "worktree")
      const config = path.join(primary, ".config")
      await fs.mkdir(primary)
      await fs.mkdir(worktree)
      await fs.mkdir(config)
      expect(
        await resolvePermissionStorePaths(worktree, config, primary),
      ).toBeUndefined()
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Pattern-language reasoning — what the redundancy skip and the migration
// interference gate stand on. Subsumption must be SOUND (a wrong true deletes
// an approval that was not covered); overlap must be complete (a missed
// overlap lets a migrated allow slip past a carve-out).
// ---------------------------------------------------------------------------

describe("patternSubsumes", () => {
  const cases: Array<[general: string, specific: string, expected: boolean]> = [
    ["git *", "git status *", true],
    ["git *", "git", true], // the trailing-" *" quirk: "git *" matches bare "git"
    ["git *", "git status", true],
    ["git status *", "git status", true],
    ["*", "anything ? at all *", true],
    ["git status", "git status", true],
    ["src/*", "src/main.ts", true],
    ["git ?", "git s", true], // literal specific: plain membership
    // The finding-8 shape: "git ?" MATCHES the five-character string "git *"
    // but does not COVER the language "git *" denotes.
    ["git ?", "git *", false],
    ["git ?", "git st", false],
    ["git", "git *", false],
    ["git status *", "git *", false],
    ["docker *", "git status *", false],
  ]
  for (const [general, specific, expected] of cases) {
    test(`"${general}" ${expected ? "covers" : "does not cover"} "${specific}"`, () => {
      expect(patternSubsumes(general, specific)).toBe(expected)
    })
  }
})

describe("patternsOverlap", () => {
  const cases: Array<[a: string, b: string, expected: boolean]> = [
    ["git ?", "git *", true], // both match "git X"
    ["git status *", "git status", true], // the quirk again: both match "git status"
    ["*", "x", true],
    ["*a", "b*", true], // both match "ba"
    ["git push *", "git pull *", false],
    ["bash", "webfetch", false],
    ["a*c", "b*c", false],
    ["rm *", "ls *", false],
  ]
  for (const [a, b, expected] of cases) {
    test(`"${a}" and "${b}" ${expected ? "overlap" : "are disjoint"}`, () => {
      expect(patternsOverlap(a, b)).toBe(expected)
    })
  }
})

describe("allowRuleRedundant", () => {
  const rules: Rule[] = [
    { permission: "bash", pattern: "git *", action: "allow" },
    { permission: "bash", pattern: "git push *", action: "ask" },
  ]
  test("a covered pattern with no overlapping carve-out is redundant", () => {
    expect(allowRuleRedundant("bash", "git status *", rules)).toBe(true)
  })
  test("a pattern an ask/deny carve-out overlaps must still be written", () => {
    expect(allowRuleRedundant("bash", "git push --force", rules)).toBe(false)
  })
  test("string-matching coverage is not containment", () => {
    expect(
      allowRuleRedundant("bash", "git *", [
        { permission: "bash", pattern: "git ?", action: "allow" },
      ]),
    ).toBe(false)
  })
  test("an uncovered pattern is not redundant", () => {
    expect(allowRuleRedundant("bash", "docker ps *", rules)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Primary-root discovery — what decides which repository family shares a store
// under the default "repository" scope. Real git repositories pin the honest
// path; injected runners pin every rejection, most importantly the toplevel
// self-check: a probe that discovers a repository OTHER than the root it was
// given (stray .git debris in an ancestor directory, say) must return
// undefined rather than silently re-key the store.
// ---------------------------------------------------------------------------

describe("discoverPrimaryRoot", () => {
  const run = async (cwd: string, args: string[]) => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    if (proc.exitCode !== 0)
      throw new Error(
        `git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`,
      )
    return stdout
  }

  let sandbox: string
  let primary: string
  let linked: string

  beforeAll(async () => {
    sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "primary-root-")),
    )
    primary = path.join(sandbox, "primary")
    linked = path.join(sandbox, "linked")
    await fs.mkdir(primary)
    await run(primary, ["init", "--quiet"])
    await run(primary, [
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=test",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "init",
    ])
    await run(primary, ["worktree", "add", "--quiet", linked])
  })

  afterAll(async () => {
    await fs.rm(sandbox, { recursive: true, force: true })
  })

  test("the primary checkout names itself", async () => {
    expect(await discoverPrimaryRoot(primary)).toBe(primary)
  })

  test("a linked worktree names the primary checkout", async () => {
    expect(await discoverPrimaryRoot(linked)).toBe(primary)
  })

  test("a directory inside a worktree is rejected (the host always passes the toplevel)", async () => {
    const nested = path.join(linked, "nested")
    await fs.mkdir(nested, { recursive: true })
    expect(await discoverPrimaryRoot(nested)).toBeUndefined()
  })

  test("a toplevel disagreeing with the given root is rejected", async () => {
    const dir = path.join(sandbox, "plain")
    await fs.mkdir(dir, { recursive: true })
    const probe = await discoverPrimaryRoot(dir, async () => ({
      code: 0,
      stdout: `${sandbox}\n`,
    }))
    expect(probe).toBeUndefined()
  })

  test("git failures and unparseable listings are rejected", async () => {
    const dir = path.join(sandbox, "plain2")
    await fs.mkdir(dir, { recursive: true })
    expect(
      await discoverPrimaryRoot(dir, async () => ({ code: 128, stdout: "" })),
    ).toBeUndefined()
    expect(
      await discoverPrimaryRoot(dir, async (_cwd, args) =>
        args[0] === "rev-parse"
          ? { code: 0, stdout: `${dir}\n` }
          : { code: 0, stdout: "garbage\n" },
      ),
    ).toBeUndefined()
    expect(
      await discoverPrimaryRoot(dir, async (_cwd, args) =>
        args[0] === "rev-parse"
          ? { code: 0, stdout: `${dir}\n` }
          : { code: 1, stdout: "" },
      ),
    ).toBeUndefined()
  })

  test("a listed primary that is relative or does not exist is rejected", async () => {
    const dir = path.join(sandbox, "plain3")
    await fs.mkdir(dir, { recursive: true })
    const missing = path.join(sandbox, "not-there")
    for (const claimed of ["relative/path", missing]) {
      expect(
        await discoverPrimaryRoot(dir, async (_cwd, args) =>
          args[0] === "rev-parse"
            ? { code: 0, stdout: `${dir}\n` }
            : { code: 0, stdout: `worktree ${claimed}\0\0worktree ${dir}\0\0` },
        ),
      ).toBeUndefined()
    }
  })

  test("a listing that does not contain the current root is rejected", async () => {
    // The forged-gitfile shape: every listed worktree belongs to some other
    // repository, so the membership check must refuse to key by its primary.
    const dir = path.join(sandbox, "plain4")
    await fs.mkdir(dir, { recursive: true })
    expect(
      await discoverPrimaryRoot(dir, async (_cwd, args) =>
        args[0] === "rev-parse"
          ? { code: 0, stdout: `${dir}\n` }
          : {
              code: 0,
              stdout: `worktree ${primary}\0\0worktree ${linked}\0\0`,
            },
      ),
    ).toBeUndefined()
  })

  test("a primary with a newline in its path is parsed whole, not truncated", async () => {
    const weird = path.join(sandbox, "repo\nline")
    const weirdLinked = path.join(sandbox, "weird-linked")
    await fs.mkdir(weird)
    await run(weird, ["init", "--quiet"])
    await run(weird, [
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=test",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "init",
    ])
    await run(weird, ["worktree", "add", "--quiet", weirdLinked])
    // The pre--z parser split on newline and reported the nonexistent prefix
    // ".../repo"; the real primary keeps its full name.
    expect(await discoverPrimaryRoot(weirdLinked)).toBe(weird)
  })

  test("a forged worktree gitfile pointing into another repository is rejected", async () => {
    const makeRepo = async (name: string) => {
      const repo = path.join(sandbox, name)
      const repoLinked = path.join(sandbox, `${name}-linked`)
      await fs.mkdir(repo)
      await run(repo, ["init", "--quiet"])
      await run(repo, [
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "user.name=test",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "init",
      ])
      await run(repo, ["worktree", "add", "--quiet", repoLinked])
      return { repo, repoLinked }
    }
    const a = await makeRepo("forged-a")
    const b = await makeRepo("forged-b")
    // An agent editing inside repository A's linked worktree can rewrite its
    // agent-writable .git gitfile to borrow repository B's worktree metadata.
    // Every subsequent git read in A then describes repository B — the probe
    // must not answer with B's primary and hand A's sessions B's store.
    await fs.writeFile(
      path.join(a.repoLinked, ".git"),
      await fs.readFile(path.join(b.repoLinked, ".git")),
    )
    expect(await discoverPrimaryRoot(a.repoLinked)).toBeUndefined()
    // The unforged neighbors still resolve, so the rejection above is the
    // forgery being caught, not collateral from this test's setup.
    expect(await discoverPrimaryRoot(b.repoLinked)).toBe(b.repo)
  })
})

// ---------------------------------------------------------------------------
// Worktree-store migration — folding a per-worktree store into the shared
// repository store. The invariant everything below leans on: imported rules
// are PREPENDED, so under last-rule-wins they can never change the disposition
// of any request some existing shared rule already matches.
// ---------------------------------------------------------------------------

// Make the atomic publish of `file` fail once — writeStore writes a tmp file
// and renames it into place, so failing the rename is exactly an EROFS/ENOSPC
// write failure, with every other write in the call (crucially the sibling
// `<store>.lock`) left working. chmod is NOT a substitute: a read-only
// directory breaks lock acquisition first, so the call never reaches the write
// path under test — and chmod is a no-op when the suite runs as root.
const withOneFailingWriteTo = async <T>(
  file: string,
  run: () => Promise<T>,
): Promise<T> => {
  const real = fs.rename.bind(fs)
  let failed = false
  const spy = (async (from: never, to: never) => {
    if (!failed && to === file) {
      failed = true
      throw new Error("EROFS: read-only file system")
    }
    return await real(from, to)
  }) as unknown as typeof fs.rename
  ;(fs as { rename: typeof fs.rename }).rename = spy
  try {
    return await run()
  } finally {
    ;(fs as { rename: typeof fs.rename }).rename = real
  }
}

describe("migrateWorktreeStore", () => {
  const withSandbox = async (
    fixture: { shared?: unknown; worktree?: unknown },
    check: (paths: {
      sharedFile: string
      worktreeFile: string
    }) => Promise<void>,
  ) => {
    const sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "store-migration-")),
    )
    const sharedFile = path.join(sandbox, "shared.json")
    const worktreeFile = path.join(sandbox, "worktree.json")
    try {
      if (fixture.shared !== undefined)
        await fs.writeFile(sharedFile, JSON.stringify(fixture.shared))
      if (fixture.worktree !== undefined)
        await fs.writeFile(
          worktreeFile,
          typeof fixture.worktree === "string"
            ? fixture.worktree
            : JSON.stringify(fixture.worktree),
        )
      await check({ sharedFile, worktreeFile })
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  }
  const readJson = async (file: string) =>
    JSON.parse(await fs.readFile(file, "utf8")) as Store

  test("no worktree store: nothing to do", async () => {
    await withSandbox({}, async ({ sharedFile, worktreeFile }) => {
      expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
        outcome: "none",
      })
      expect(await pathExists(sharedFile)).toBe(false)
    })
  })

  test("identical paths: nothing to do", async () => {
    await withSandbox(
      { worktree: { permission: { bash: { "git status *": "allow" } } } },
      async ({ worktreeFile }) => {
        expect(await migrateWorktreeStore(worktreeFile, worktreeFile)).toEqual({
          outcome: "none",
        })
        expect(await pathExists(worktreeFile)).toBe(true)
      },
    )
  })

  test("pure-allow rules merge into an absent shared store and the old file is removed", async () => {
    await withSandbox(
      {
        worktree: {
          permission: { bash: { "git status *": "allow" }, edit: "allow" },
        },
      },
      async ({ sharedFile, worktreeFile }) => {
        expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
          outcome: "merged",
          added: 2,
          removed: true,
        })
        expect(await readJson(sharedFile)).toEqual({
          permission: {
            bash: { "git status *": "allow" },
            edit: { "*": "allow" },
          },
        })
        expect(await pathExists(worktreeFile)).toBe(false)
      },
    )
  })

  test("imported rules are prepended: a shared carve-out still wins every request it matches", async () => {
    await withSandbox(
      {
        shared: {
          permission: { bash: { "git *": "allow", "git push *": "ask" } },
        },
        worktree: { permission: { bash: { "git push --force": "allow" } } },
      },
      async ({ sharedFile, worktreeFile }) => {
        expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
          outcome: "merged",
          added: 1,
          removed: true,
        })
        const merged = await readJson(sharedFile)
        expect(Object.keys(merged.permission.bash as object)).toEqual([
          "git push --force",
          "git *",
          "git push *",
        ])
        // The imported allow must NOT override the carve-out that matches the
        // same request — that is the whole reason merging prepends.
        expect(evaluate("bash", "git push --force", rulesFrom(merged))).toBe(
          "ask",
        )
      },
    )
  })

  test("patterns the shared store already covers are skipped, not duplicated", async () => {
    await withSandbox(
      {
        shared: { permission: { bash: { "git *": "allow" } } },
        worktree: {
          permission: { bash: { "git status *": "allow", "git *": "allow" } },
        },
      },
      async ({ sharedFile, worktreeFile }) => {
        expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
          outcome: "merged",
          added: 0,
          removed: true,
        })
        expect(await readJson(sharedFile)).toEqual({
          permission: { bash: { "git *": "allow" } },
        })
        expect(await pathExists(worktreeFile)).toBe(false)
      },
    )
  })

  test("an identical pattern already in the shared store keeps the shared value", async () => {
    await withSandbox(
      {
        shared: { permission: { bash: { "git push *": "ask" } } },
        worktree: { permission: { bash: { "git push *": "allow" } } },
      },
      async ({ sharedFile, worktreeFile }) => {
        expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
          outcome: "merged",
          added: 0,
          removed: true,
        })
        expect(await readJson(sharedFile)).toEqual({
          permission: { bash: { "git push *": "ask" } },
        })
        expect(await pathExists(worktreeFile)).toBe(false)
      },
    )
  })

  test("a scalar shared rule survives as the trailing '*' entry", async () => {
    await withSandbox(
      {
        shared: { permission: { webfetch: "ask" } },
        worktree: { permission: { webfetch: { "https://x/*": "allow" } } },
      },
      async ({ sharedFile, worktreeFile }) => {
        expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
          outcome: "merged",
          added: 1,
          removed: true,
        })
        const merged = await readJson(sharedFile)
        expect(Object.keys(merged.permission.webfetch as object)).toEqual([
          "https://x/*",
          "*",
        ])
        // Equivalent to the scalar it replaced: the blanket still decides.
        expect(evaluate("webfetch", "https://x/y", rulesFrom(merged))).toBe(
          "ask",
        )
      },
    )
  })

  test("an import that would land after a wildcard-key carve-out demands a manual merge", async () => {
    // The finding-3 shape: permission keys are patterns too, and the
    // flattened ruleset is globally last-match-wins. "bash" is a NEW key, so
    // it would land after "*" — the imported allow would override the
    // repository-wide deny, which prepend-only merging promises never happens.
    await withSandbox(
      {
        shared: { permission: { "*": { "*": "deny" } } },
        worktree: { permission: { bash: { "git status *": "allow" } } },
      },
      async ({ sharedFile, worktreeFile }) => {
        const result = await migrateWorktreeStore(sharedFile, worktreeFile)
        expect(result.outcome).toBe("manual")
        expect(await readJson(sharedFile)).toEqual({
          permission: { "*": { "*": "deny" } },
        })
        expect(await pathExists(worktreeFile)).toBe(true)
        expect(
          evaluate("bash", "git status", rulesFrom(await readJson(sharedFile))),
        ).toBe("deny")
      },
    )
  })

  test("an import into a key that sits before the carve-out's key still merges", async () => {
    // bash precedes "*" in the shared store, so prepended bash rules stay
    // before the carve-out in the flat order and the carve-out still wins
    // whatever it matches.
    await withSandbox(
      {
        shared: {
          permission: {
            bash: { "git *": "allow" },
            "*": { "docker *": "ask" },
          },
        },
        worktree: { permission: { bash: { "ls *": "allow" } } },
      },
      async ({ sharedFile, worktreeFile }) => {
        expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
          outcome: "merged",
          added: 1,
          removed: true,
        })
        const merged = rulesFrom(await readJson(sharedFile))
        expect(evaluate("bash", "ls -la", merged)).toBe("allow")
        expect(evaluate("bash", "docker compose up", merged)).toBe("ask")
      },
    )
  })

  test("a wildcard-key carve-out with disjoint patterns does not block the merge", async () => {
    await withSandbox(
      {
        shared: { permission: { "*": { "rm *": "deny" } } },
        worktree: { permission: { bash: { "ls *": "allow" } } },
      },
      async ({ sharedFile, worktreeFile }) => {
        expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
          outcome: "merged",
          added: 1,
          removed: true,
        })
        const merged = rulesFrom(await readJson(sharedFile))
        expect(evaluate("bash", "ls -la", merged)).toBe("allow")
        expect(evaluate("bash", "rm -rf x", merged)).toBe("deny")
        expect(await pathExists(worktreeFile)).toBe(false)
      },
    )
  })

  test("a carve-out under an unrelated literal key does not block the merge", async () => {
    await withSandbox(
      {
        shared: { permission: { webfetch: { "*": "ask" } } },
        worktree: { permission: { bash: { "ls *": "allow" } } },
      },
      async ({ sharedFile, worktreeFile }) => {
        expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
          outcome: "merged",
          added: 1,
          removed: true,
        })
        expect(await pathExists(worktreeFile)).toBe(false)
      },
    )
  })

  test("wildcard 'coverage' that is string matching, not containment, still imports", async () => {
    // The finding-8 shape: shared "git ?" MATCHES the literal string "git *"
    // but does not cover it — skipping the import (and then deleting the
    // source) would silently lose the only rule allowing "git status".
    await withSandbox(
      {
        shared: { permission: { bash: { "git ?": "allow" } } },
        worktree: { permission: { bash: { "git *": "allow" } } },
      },
      async ({ sharedFile, worktreeFile }) => {
        expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
          outcome: "merged",
          added: 1,
          removed: true,
        })
        expect(
          evaluate("bash", "git status", rulesFrom(await readJson(sharedFile))),
        ).toBe("allow")
        expect(await pathExists(worktreeFile)).toBe(false)
      },
    )
  })

  test("any ask/deny carve-out demands a manual merge and leaves both files alone", async () => {
    await withSandbox(
      {
        shared: { permission: { bash: { "ls *": "allow" } } },
        worktree: {
          permission: { bash: { "git *": "allow", "git push *": "ask" } },
        },
      },
      async ({ sharedFile, worktreeFile }) => {
        const result = await migrateWorktreeStore(sharedFile, worktreeFile)
        expect(result.outcome).toBe("manual")
        if (result.outcome === "manual")
          expect(result.reason).toContain("git push *")
        expect(await readJson(sharedFile)).toEqual({
          permission: { bash: { "ls *": "allow" } },
        })
        expect(await pathExists(worktreeFile)).toBe(true)
      },
    )
  })

  test("an unreadable worktree store demands a manual merge", async () => {
    await withSandbox(
      { worktree: "not json{" },
      async ({ sharedFile, worktreeFile }) => {
        const result = await migrateWorktreeStore(sharedFile, worktreeFile)
        expect(result.outcome).toBe("manual")
        expect(await pathExists(worktreeFile)).toBe(true)
      },
    )
  })

  test("an unreadable shared store is an error, never overwritten", async () => {
    await withSandbox(
      {
        shared: undefined,
        worktree: { permission: { bash: { "ls *": "allow" } } },
      },
      async ({ sharedFile, worktreeFile }) => {
        await fs.writeFile(sharedFile, "not json{")
        const result = await migrateWorktreeStore(sharedFile, worktreeFile)
        expect(result.outcome).toBe("error")
        expect(await fs.readFile(sharedFile, "utf8")).toBe("not json{")
        expect(await pathExists(worktreeFile)).toBe(true)
      },
    )
  })

  test("a failed write to the shared store never deletes the source it failed to absorb", async () => {
    // The one thing standing between a transient write failure and permanent,
    // silent loss of a user's approvals: the source file is the ONLY copy of
    // those rules until the shared store has taken them. If the write fails
    // and the pass still falls through to `fs.rm(worktreeFile)` — or the catch
    // stops returning — the approvals exist nowhere, and nothing in the system
    // can recover them.
    await withSandbox(
      {
        shared: { permission: { bash: { "ls *": "allow" } } },
        worktree: { permission: { bash: { "git status *": "allow" } } },
      },
      async ({ sharedFile, worktreeFile }) => {
        const sharedBefore = await fs.readFile(sharedFile, "utf8")
        const worktreeBefore = await fs.readFile(worktreeFile, "utf8")

        const result = await withOneFailingWriteTo(sharedFile, () =>
          migrateWorktreeStore(sharedFile, worktreeFile),
        )

        expect(result.outcome).toBe("error")
        if (result.outcome === "error") {
          expect(result.reason).toContain("could not write")
          expect(result.reason).toContain(sharedFile)
        }
        // Neither file moved: re-running the pass is the whole recovery story.
        expect(await fs.readFile(worktreeFile, "utf8")).toBe(worktreeBefore)
        expect(await fs.readFile(sharedFile, "utf8")).toBe(sharedBefore)

        // And it really is recoverable — the retry completes the merge.
        expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
          outcome: "merged",
          added: 1,
          removed: true,
        })
        expect(
          evaluate("bash", "git status", rulesFrom(await readJson(sharedFile))),
        ).toBe("allow")
      },
    )
  })

  test("a lock that cannot be acquired pauses the migration instead of finishing it", async () => {
    // A directory at the lock path is the fail-closed route into the
    // acquisition catch: withStoreLock refuses to reclaim a lock path it could
    // not itself have created, and throws on the first pass rather than
    // burning the full default timeout. The outcome must be "error" — the
    // value migrateStores turns into retry:true — because reporting "none"
    // here reads as a finished migration, and the caller memoizes it: the
    // worktree's approvals would be stranded behind one lock collision.
    await withSandbox(
      {
        shared: { permission: { bash: { "ls *": "allow" } } },
        worktree: { permission: { bash: { "git status *": "allow" } } },
      },
      async ({ sharedFile, worktreeFile }) => {
        const sharedBefore = await fs.readFile(sharedFile, "utf8")
        const worktreeBefore = await fs.readFile(worktreeFile, "utf8")
        await fs.mkdir(`${sharedFile}.lock`)

        const blocked = await migrateWorktreeStore(sharedFile, worktreeFile)
        expect(blocked.outcome).toBe("error")
        if (blocked.outcome === "error") {
          expect(blocked.reason).toContain(`could not migrate ${worktreeFile}`)
          expect(blocked.reason).toContain("not a regular file")
        }
        expect(await fs.readFile(sharedFile, "utf8")).toBe(sharedBefore)
        expect(await fs.readFile(worktreeFile, "utf8")).toBe(worktreeBefore)

        // Retryable, not terminal: once the obstruction is gone the very same
        // call completes the merge it deferred.
        await fs.rmdir(`${sharedFile}.lock`)
        expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
          outcome: "merged",
          added: 1,
          removed: true,
        })
        expect(
          evaluate("bash", "git status", rulesFrom(await readJson(sharedFile))),
        ).toBe("allow")
      },
    )
  })

  test("concurrent migrations from different worktrees both survive", async () => {
    // The finding-1 race: two instances fold different worktree stores into
    // one shared store. Unserialized, both read the same shared snapshot,
    // each writes only its own merge, and both delete their sources — the
    // last rename discards the other instance's approvals with no copy left.
    // The store lock serializes the passes, so both rules must land.
    const sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "store-migration-race-")),
    )
    try {
      const sharedFile = path.join(sandbox, "shared.json")
      const worktreeA = path.join(sandbox, "worktree-a.json")
      const worktreeB = path.join(sandbox, "worktree-b.json")
      await fs.writeFile(
        worktreeA,
        JSON.stringify({ permission: { bash: { "git status *": "allow" } } }),
      )
      await fs.writeFile(
        worktreeB,
        JSON.stringify({
          permission: { webfetch: { "https://x/*": "allow" } },
        }),
      )
      const [a, b] = await Promise.all([
        migrateWorktreeStore(sharedFile, worktreeA),
        migrateWorktreeStore(sharedFile, worktreeB),
      ])
      expect(a).toEqual({ outcome: "merged", added: 1, removed: true })
      expect(b).toEqual({ outcome: "merged", added: 1, removed: true })
      const merged = rulesFrom(
        JSON.parse(await fs.readFile(sharedFile, "utf8")) as Store,
      )
      expect(evaluate("bash", "git status", merged)).toBe("allow")
      expect(evaluate("webfetch", "https://x/y", merged)).toBe("allow")
      expect(await pathExists(worktreeA)).toBe(false)
      expect(await pathExists(worktreeB)).toBe(false)
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  })

  test("both halves migrating the same source: the second pass finds nothing", async () => {
    await withSandbox(
      { worktree: { permission: { bash: { "git status *": "allow" } } } },
      async ({ sharedFile, worktreeFile }) => {
        const [first, second] = await Promise.all([
          migrateWorktreeStore(sharedFile, worktreeFile),
          migrateWorktreeStore(sharedFile, worktreeFile),
        ])
        const outcomes = [first.outcome, second.outcome].sort()
        expect(outcomes).toEqual(["merged", "none"])
        expect(
          evaluate("bash", "git status", rulesFrom(await readJson(sharedFile))),
        ).toBe("allow")
      },
    )
  })

  test("a failed source removal is reported, then retried to completion", async () => {
    // The finding-9 shape: fs.rm fails after a successful merge. The outcome
    // must say so (removed: false) so callers re-run the pass instead of
    // memoizing a half-finished migration; the retry adds nothing and
    // finishes the removal once it can.
    const sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "store-migration-rm-")),
    )
    const sourceDir = path.join(sandbox, "old")
    const sharedFile = path.join(sandbox, "shared.json")
    const worktreeFile = path.join(sourceDir, "worktree.json")
    try {
      await fs.mkdir(sourceDir)
      await fs.writeFile(
        worktreeFile,
        JSON.stringify({ permission: { bash: { "git status *": "allow" } } }),
      )
      await fs.chmod(sourceDir, 0o555)
      expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
        outcome: "merged",
        added: 1,
        removed: false,
      })
      expect(
        evaluate("bash", "git status", rulesFrom(await readJson(sharedFile))),
      ).toBe("allow")
      expect(await pathExists(worktreeFile)).toBe(true)
      await fs.chmod(sourceDir, 0o755)
      expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
        outcome: "merged",
        added: 0,
        removed: true,
      })
      expect(await pathExists(worktreeFile)).toBe(false)
    } finally {
      await fs.chmod(sourceDir, 0o755).catch(() => {})
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  })

  test("re-running after a merge is a no-op (idempotent recovery)", async () => {
    await withSandbox(
      { worktree: { permission: { bash: { "git status *": "allow" } } } },
      async ({ sharedFile, worktreeFile }) => {
        expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
          outcome: "merged",
          added: 1,
          removed: true,
        })
        // Simulate the removal having failed: the old file reappears intact.
        await fs.writeFile(
          worktreeFile,
          JSON.stringify({ permission: { bash: { "git status *": "allow" } } }),
        )
        expect(await migrateWorktreeStore(sharedFile, worktreeFile)).toEqual({
          outcome: "merged",
          added: 0,
          removed: true,
        })
        expect(await readJson(sharedFile)).toEqual({
          permission: { bash: { "git status *": "allow" } },
        })
        expect(await pathExists(worktreeFile)).toBe(false)
      },
    )
  })
})

// ---------------------------------------------------------------------------
// Folding EVERY candidate — the session's own worktree store plus any store an
// earlier, unestablished keying fell back to. A save made under interim keying
// is only reachable through this list; missing one orphans it (and leaves a
// stale file that a later probe failure could resurrect).
// ---------------------------------------------------------------------------

describe("migrateStores", () => {
  const readStoreJson = async (file: string) =>
    JSON.parse(await fs.readFile(file, "utf8")) as Store
  const withStores = async (
    fixture: { active?: unknown; worktree?: unknown; stale?: unknown },
    check: (
      paths: PermissionStorePaths & {
        worktreeStoreFile: string
        staleStoreFiles: string[]
      },
    ) => Promise<void>,
  ) => {
    const sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "migrate-stores-")),
    )
    try {
      const write = async (file: string, value: unknown) => {
        if (value !== undefined) await fs.writeFile(file, JSON.stringify(value))
        return file
      }
      const storeFile = await write(
        path.join(sandbox, "active.json"),
        fixture.active,
      )
      const worktreeStoreFile = await write(
        path.join(sandbox, "worktree.json"),
        fixture.worktree,
      )
      const staleStoreFile = await write(
        path.join(sandbox, "stale.json"),
        fixture.stale,
      )
      await check({
        projectRoot: sandbox,
        keyRoot: sandbox,
        storeFile,
        legacyStoreFile: path.join(sandbox, "legacy.json"),
        worktreeStoreFile,
        staleStoreFiles: [staleStoreFile],
      })
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  }

  test("candidates are ordered worktree-first, and the active store is never one", () => {
    expect(
      storeMigrationCandidates({
        projectRoot: "/p",
        keyRoot: "/k",
        storeFile: "/c/active.json",
        legacyStoreFile: "/p/.opencode/permissions.local.json",
        worktreeStoreFile: "/c/worktree.json",
        staleStoreFiles: [
          "/c/stale.json",
          "/c/worktree.json",
          "/c/active.json",
        ],
      }),
    ).toEqual(["/c/worktree.json", "/c/stale.json"])
  })

  test("every candidate is folded in, and all sources are removed", async () => {
    await withStores(
      {
        active: { permission: { bash: { "ls *": "allow" } } },
        worktree: { permission: { bash: { "git status *": "allow" } } },
        stale: { permission: { webfetch: { "https://x/*": "allow" } } },
      },
      async (paths) => {
        expect(await migrateStores(paths)).toEqual({
          ok: true,
          moved: 2,
          retry: false,
        })
        const merged = rulesFrom(await readStoreJson(paths.storeFile))
        expect(evaluate("bash", "git status", merged)).toBe("allow")
        expect(evaluate("webfetch", "https://x/y", merged)).toBe("allow")
        expect(await pathExists(paths.worktreeStoreFile)).toBe(false)
        expect(await pathExists(paths.staleStoreFiles[0]!)).toBe(false)
      },
    )
  })

  test("a candidate needing a manual merge pauses the pass and leaves the rest alone", async () => {
    // Merging the later candidate while the user reconciles this one would
    // answer prompts from a store they were told to review by hand.
    await withStores(
      {
        worktree: { permission: { bash: { "git push *": "ask" } } },
        stale: { permission: { webfetch: { "https://x/*": "allow" } } },
      },
      async (paths) => {
        const result = await migrateStores(paths)
        expect(result.ok).toBe(false)
        expect(result.kind).toBe("manual")
        expect(result.reason).toContain("git push *")
        expect(result.retry).toBe(true)
        expect(await pathExists(paths.worktreeStoreFile)).toBe(true)
        expect(await pathExists(paths.staleStoreFiles[0]!)).toBe(true)
      },
    )
  })

  test("a candidate that fails to merge pauses the pass as a transient error", async () => {
    // The sibling of the "manual" pause above, and the one that discriminates
    // the two user-facing postures documented on StoresMigration: "manual"
    // sends the user off to hand-merge a file, "error" is transient and
    // self-heals. Reporting the wrong kind misdirects the user; dropping the
    // branch entirely is worse — the loop would fall through to ok:true,
    // retry:false, which consumers memoize as a FINISHED pass, and the
    // candidate is then silently never migrated.
    await withStores(
      {
        active: { permission: { bash: { "ls *": "allow" } } },
        worktree: { permission: { bash: { "git status *": "allow" } } },
        stale: { permission: { webfetch: { "https://x/*": "allow" } } },
      },
      async (paths) => {
        const activeBefore = await fs.readFile(paths.storeFile, "utf8")
        const staleFile = paths.staleStoreFiles[0]!
        const staleBefore = await fs.readFile(staleFile, "utf8")

        // Exactly one failed write, aimed at the first candidate's merge. The
        // "once" matters: with later writes working, a pass that wrongly
        // skipped ahead would visibly fold the stale candidate in and delete
        // it, so the assertions below can tell "paused" from "carried on".
        const result = await withOneFailingWriteTo(paths.storeFile, () =>
          migrateStores(paths),
        )

        expect(result.ok).toBe(false)
        expect(result.kind).toBe("error")
        expect(result.retry).toBe(true)
        expect(result.moved).toBe(0)
        expect(result.reason).toContain("could not write")

        // Pause, don't skip ahead: merging a later candidate while an earlier
        // one is unresolved would answer prompts from a store the pass has
        // already been told it could not account for.
        expect(await pathExists(paths.worktreeStoreFile)).toBe(true)
        expect(await fs.readFile(staleFile, "utf8")).toBe(staleBefore)
        expect(await fs.readFile(paths.storeFile, "utf8")).toBe(activeBefore)
      },
    )
  })

  test("only the stale candidate existing still folds it in", async () => {
    await withStores(
      { stale: { permission: { bash: { "git status *": "allow" } } } },
      async (paths) => {
        expect(await migrateStores(paths)).toEqual({
          ok: true,
          moved: 1,
          retry: false,
        })
        expect(
          evaluate(
            "bash",
            "git status",
            rulesFrom(await readStoreJson(paths.storeFile)),
          ),
        ).toBe("allow")
      },
    )
  })

  test("nothing to fold is a clean, finished pass", async () => {
    await withStores({}, async (paths) => {
      expect(await migrateStores(paths)).toEqual({
        ok: true,
        moved: 0,
        retry: false,
      })
    })
  })

  test("a source that merged but could not be deleted keeps the pass unfinished", async () => {
    const sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "migrate-stores-rm-")),
    )
    const sourceDir = path.join(sandbox, "old")
    const worktreeStoreFile = path.join(sourceDir, "worktree.json")
    try {
      await fs.mkdir(sourceDir)
      await fs.writeFile(
        worktreeStoreFile,
        JSON.stringify({ permission: { bash: { "git status *": "allow" } } }),
      )
      await fs.chmod(sourceDir, 0o555)
      const result = await migrateStores({
        projectRoot: sandbox,
        keyRoot: sandbox,
        storeFile: path.join(sandbox, "active.json"),
        legacyStoreFile: path.join(sandbox, "legacy.json"),
        worktreeStoreFile,
      })
      expect(result).toEqual({
        ok: true,
        moved: 1,
        retry: true,
        unremoved: worktreeStoreFile,
      })
    } finally {
      await fs.chmod(sourceDir, 0o755).catch(() => {})
      await fs.rm(sandbox, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Work-tree root discovery and the keying resolver — the defense against a
// host that hands plugin factories the non-git sentinel ("/") for sessions
// that ARE inside linked worktrees (observed 2026-07-19, transiently at boot,
// with plugin-side git probing failing in the same window). The resolver must
// (1) verify the sentinel against git before keying by the bare directory,
// (2) keep re-deriving until git positively confirms the keying — writes
// always, reads throttled — and (3) swap to the shared store on a late
// success so interim fallback-keyed saves can be folded in by migration.
// ---------------------------------------------------------------------------

describe("discoverWorktreeRoot and createStoreKeyingResolver", () => {
  const realGit: ExecRunner = async (cwd, args) => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return { code: proc.exitCode ?? 1, stdout }
  }
  const gitDenies: ExecRunner = async () => ({ code: 128, stdout: "" })

  let sandbox: string
  let primary: string
  let linked: string
  let configDir: string
  let plain: string

  beforeAll(async () => {
    sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "keying-resolver-")),
    )
    primary = path.join(sandbox, "primary")
    linked = path.join(sandbox, "linked")
    configDir = path.join(sandbox, "config")
    plain = path.join(sandbox, "plain")
    await fs.mkdir(primary)
    await fs.mkdir(configDir)
    await fs.mkdir(plain)
    const run = async (cwd: string, args: string[]) => {
      const result = await realGit(cwd, args)
      if (result.code !== 0)
        throw new Error(`git ${args.join(" ")} failed in ${cwd}`)
    }
    await run(primary, ["init", "--quiet"])
    await run(primary, [
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=test",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "init",
    ])
    await run(primary, ["worktree", "add", "--quiet", linked])
  })

  afterAll(async () => {
    await fs.rm(sandbox, { recursive: true, force: true })
  })

  describe("discoverWorktreeRoot", () => {
    test("a work-tree root names itself; a linked worktree names its OWN root, not the primary", async () => {
      expect(await discoverWorktreeRoot(primary)).toBe(primary)
      expect(await discoverWorktreeRoot(linked)).toBe(linked)
    })

    test("a subdirectory resolves to its containing work-tree root", async () => {
      const nested = path.join(linked, "deeper", "still")
      await fs.mkdir(nested, { recursive: true })
      expect(await discoverWorktreeRoot(nested)).toBe(linked)
    })

    test("git failures and non-repos yield undefined", async () => {
      expect(await discoverWorktreeRoot(plain, gitDenies)).toBeUndefined()
    })

    test("a reported toplevel that does not contain the directory is rejected", async () => {
      expect(
        await discoverWorktreeRoot(plain, async () => ({
          code: 0,
          stdout: `${primary}\n`,
        })),
      ).toBeUndefined()
    })

    test("a relative or empty toplevel is rejected", async () => {
      expect(
        await discoverWorktreeRoot(plain, async () => ({
          code: 0,
          stdout: "relative/path\n",
        })),
      ).toBeUndefined()
      expect(
        await discoverWorktreeRoot(plain, async () => ({
          code: 0,
          stdout: "\n",
        })),
      ).toBeUndefined()
    })

    test("a nested repository cannot borrow an ANCESTOR repository's checkout", async () => {
      // Containment is not identity. A repository nested inside another one is
      // agent-writable, so it can point its own core.worktree at the ancestor
      // checkout; git then reports that ancestor as the nested repository's
      // top level, and the ancestor contains the directory, so the containment
      // check alone passes. The ancestor is a perfectly self-consistent
      // repository, so discoverPrimaryRoot validates it too — the nested
      // session would read and write the ancestor's approvals. Only comparing
      // the repositories themselves catches this.
      const victim = path.join(sandbox, "victim")
      const attacker = path.join(victim, "vendor", "attacker")
      await fs.mkdir(attacker, { recursive: true })
      const run = async (cwd: string, args: string[]) => {
        const result = await realGit(cwd, args)
        if (result.code !== 0)
          throw new Error(`git ${args.join(" ")} failed in ${cwd}`)
      }
      await run(victim, ["init", "--quiet"])
      await run(attacker, ["init", "--quiet"])
      await run(attacker, ["config", "core.worktree", victim])

      // Git really does report the ancestor here — the check has to be ours.
      const reported = await realGit(attacker, [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
      ])
      expect(reported.stdout.trim()).toBe(victim)
      expect(await discoverWorktreeRoot(attacker)).toBeUndefined()

      // The ancestor's own sessions are unaffected: it names itself.
      expect(await discoverWorktreeRoot(victim)).toBe(victim)
    })

    test("a top level whose repository identity cannot be confirmed is rejected", async () => {
      // The same crossing, pinned against an injected runner: a top level that
      // contains the directory but reports a different (or unreadable) common
      // dir must never become a store-key candidate.
      const nested = path.join(linked, "identity-probe")
      await fs.mkdir(nested, { recursive: true })
      const answering =
        (commonOfNested: { code: number; stdout: string }): ExecRunner =>
        async (cwd, args) => {
          if (args.includes("--show-toplevel"))
            return { code: 0, stdout: `${linked}\n` }
          if (args.includes("--git-common-dir")) {
            return cwd === nested
              ? commonOfNested
              : { code: 0, stdout: `${path.join(primary, ".git")}\n` }
          }
          return { code: 1, stdout: "" }
        }
      // A different repository's common dir.
      expect(
        await discoverWorktreeRoot(
          nested,
          answering({
            code: 0,
            stdout: `${path.join(sandbox, "elsewhere.git")}\n`,
          }),
        ),
      ).toBeUndefined()
      // An unreadable or empty one is not a confirmation either.
      expect(
        await discoverWorktreeRoot(
          nested,
          answering({ code: 128, stdout: "" }),
        ),
      ).toBeUndefined()
      expect(
        await discoverWorktreeRoot(
          nested,
          answering({ code: 0, stdout: "\n" }),
        ),
      ).toBeUndefined()
      // The honest answer still resolves.
      expect(
        await discoverWorktreeRoot(
          nested,
          answering({ code: 0, stdout: `${path.join(primary, ".git")}\n` }),
        ),
      ).toBe(linked)
    })
  })

  describe("createStoreKeyingResolver", () => {
    test("verifies the host's non-git sentinel: a linked-worktree session keys the shared store", async () => {
      const events: Array<[string, string, boolean]> = []
      const resolve = createStoreKeyingResolver({
        scope: "repository",
        directory: linked,
        worktree: "/",
        onShared: (keyRoot, root, late) => events.push([keyRoot, root, late]),
      })
      const keying = await resolve(configDir)
      expect(keying?.shared).toBe(true)
      expect(keying?.settled).toBe(true)
      expect(keying?.paths.storeFile).toBe(
        permissionStoreFile(configDir, primary),
      )
      expect(keying?.paths.worktreeStoreFile).toBe(
        permissionStoreFile(configDir, linked),
      )
      expect(events).toEqual([[primary, linked, false]])
    })

    test("boot-time git failure: fallback keying, then a write re-derives and swaps to the shared store", async () => {
      let clock = 0
      let gitDown = true
      const flaky: ExecRunner = (cwd, args) =>
        gitDown ? gitDenies(cwd, args) : realGit(cwd, args)
      const events: string[] = []
      const resolve = createStoreKeyingResolver({
        scope: "repository",
        directory: linked,
        worktree: "/",
        git: flaky,
        retryIntervalMs: 1_000,
        now: () => clock,
        onShared: (_keyRoot, _root, late) => events.push(`shared:${late}`),
        onProbeFallback: () => events.push("fallback"),
      })

      const first = await resolve(configDir)
      expect(first?.shared).toBe(false)
      expect(first?.settled).toBe(false)
      // Git denied a work tree, so the store keys by the bare directory — and
      // no probe ran, so no fallback warning either (this is indistinguishable
      // from a genuinely non-git project at this point).
      expect(first?.paths.storeFile).toBe(
        permissionStoreFile(configDir, linked),
      )
      expect(first?.paths.worktreeStoreFile).toBeUndefined()
      expect(events).toEqual([])

      // A read inside the throttle window returns the fallback without
      // re-attempting — git already recovered, so an attempt would re-key.
      gitDown = false
      clock = 500
      const throttled = await resolve(configDir)
      expect(throttled?.paths.storeFile).toBe(
        permissionStoreFile(configDir, linked),
      )

      // A write re-attempts immediately, re-keys to the shared store, and
      // reports the late establishment; the old fallback store surfaces as
      // worktreeStoreFile so the caller's migration folds it in.
      const rekeyed = await resolve(configDir, { write: true })
      expect(rekeyed?.shared).toBe(true)
      expect(rekeyed?.settled).toBe(true)
      expect(rekeyed?.paths.storeFile).toBe(
        permissionStoreFile(configDir, primary),
      )
      expect(rekeyed?.paths.worktreeStoreFile).toBe(
        permissionStoreFile(configDir, linked),
      )
      expect(events).toEqual(["shared:true"])

      // Settled: later resolves return the established keying unchanged.
      gitDown = true
      const settled = await resolve(configDir)
      expect(settled?.paths.storeFile).toBe(
        permissionStoreFile(configDir, primary),
      )
    })

    test("reads re-attempt once the retry interval elapses", async () => {
      let clock = 0
      let gitDown = true
      const flaky: ExecRunner = (cwd, args) =>
        gitDown ? gitDenies(cwd, args) : realGit(cwd, args)
      const resolve = createStoreKeyingResolver({
        scope: "repository",
        directory: linked,
        worktree: "/",
        git: flaky,
        retryIntervalMs: 1_000,
        now: () => clock,
      })
      expect((await resolve(configDir))?.shared).toBe(false)
      gitDown = false
      clock = 999
      expect((await resolve(configDir))?.shared).toBe(false)
      clock = 1_000
      expect((await resolve(configDir))?.shared).toBe(true)
    })

    test("a host that NAMES a work tree stays trusted; a failed probe warns once across retries", async () => {
      let fallbacks = 0
      const resolve = createStoreKeyingResolver({
        scope: "repository",
        directory: plain,
        worktree: plain,
        git: gitDenies,
        onProbeFallback: () => {
          fallbacks++
        },
      })
      const keying = await resolve(configDir)
      expect(keying?.shared).toBe(false)
      expect(keying?.settled).toBe(false)
      expect(keying?.paths.storeFile).toBe(
        permissionStoreFile(configDir, plain),
      )
      await resolve(configDir, { write: true })
      expect(fallbacks).toBe(1)
    })

    test("worktree scope with a host-named tree settles immediately and never touches git", async () => {
      const calls: string[][] = []
      const spying: ExecRunner = (cwd, args) => {
        calls.push(args)
        return realGit(cwd, args)
      }
      const resolve = createStoreKeyingResolver({
        scope: "worktree",
        directory: linked,
        worktree: linked,
        git: spying,
      })
      const keying = await resolve(configDir)
      expect(keying?.settled).toBe(true)
      expect(keying?.shared).toBe(false)
      expect(keying?.paths.storeFile).toBe(
        permissionStoreFile(configDir, linked),
      )
      expect(keying?.paths.worktreeStoreFile).toBeUndefined()
      expect(calls).toEqual([])
    })

    test("an unreachable shared store marks the fallback unsafe to READ from", async () => {
      // The host names a real work-tree root, but the primary probe fails —
      // so a repository-shared store exists and this session cannot see it.
      // Its own fallback store may allow what the shared store's carve-out
      // denies, so the leg is flagged and consumers pause authorization reads.
      const onlyToplevel: ExecRunner = async (cwd, args) =>
        args.includes("--show-toplevel")
          ? realGit(cwd, args)
          : { code: 128, stdout: "" }
      const resolve = createStoreKeyingResolver({
        scope: "repository",
        directory: linked,
        worktree: linked,
        git: onlyToplevel,
      })
      const keying = await resolve(configDir)
      expect(keying?.shared).toBe(false)
      expect(keying?.settled).toBe(false)
      expect(keying?.unkeyedShared).toBe(true)
      expect(keying?.paths.storeFile).toBe(
        permissionStoreFile(configDir, linked),
      )
    })

    test("a session BELOW a work-tree root is flagged too — the repository is still real", async () => {
      const nested = path.join(linked, "packages", "app")
      await fs.mkdir(nested, { recursive: true })
      // The host names the nested directory, so the primary probe's self-check
      // fails (it is not a work-tree root) even though git is perfectly happy.
      const resolve = createStoreKeyingResolver({
        scope: "repository",
        directory: nested,
        worktree: nested,
        git: realGit,
      })
      const keying = await resolve(configDir)
      expect(keying?.shared).toBe(false)
      expect(keying?.unkeyedShared).toBe(true)
    })

    test("a host-named non-git directory is NOT flagged: there is no shared store to miss", async () => {
      const resolve = createStoreKeyingResolver({
        scope: "repository",
        directory: plain,
        worktree: plain,
        git: realGit,
      })
      const keying = await resolve(configDir)
      expect(keying?.unkeyedShared).toBe(false)
      expect(keying?.paths.storeFile).toBe(
        permissionStoreFile(configDir, plain),
      )
    })

    test("worktree scope never flags the leg — it keys by the worktree by design", async () => {
      const resolve = createStoreKeyingResolver({
        scope: "worktree",
        directory: linked,
        worktree: linked,
        git: realGit,
      })
      expect((await resolve(configDir))?.unkeyedShared).toBe(false)
    })

    test("a re-key exposes the EARLIER fallback store as a migration candidate", async () => {
      // The orphaning shape: git is down at boot for a session launched below
      // the worktree root, so keying falls back to the session DIRECTORY and a
      // save lands under that key. When git recovers, the session re-keys to
      // the shared store — whose worktreeStoreFile names the worktree root,
      // not the directory. Without tracking, that save is unreachable.
      const nested = path.join(linked, "deep", "inside")
      await fs.mkdir(nested, { recursive: true })
      let gitDown = true
      const flaky: ExecRunner = (cwd, args) =>
        gitDown ? gitDenies(cwd, args) : realGit(cwd, args)
      const resolve = createStoreKeyingResolver({
        scope: "repository",
        directory: nested,
        worktree: "/",
        git: flaky,
      })

      const fallback = await resolve(configDir)
      expect(fallback?.paths.storeFile).toBe(
        permissionStoreFile(configDir, nested),
      )
      expect(fallback?.paths.staleStoreFiles).toBeUndefined()

      gitDown = false
      const rekeyed = await resolve(configDir, { write: true })
      expect(rekeyed?.settled).toBe(true)
      expect(rekeyed?.paths.storeFile).toBe(
        permissionStoreFile(configDir, primary),
      )
      expect(rekeyed?.paths.worktreeStoreFile).toBe(
        permissionStoreFile(configDir, linked),
      )
      expect(rekeyed?.paths.staleStoreFiles).toEqual([
        permissionStoreFile(configDir, nested),
      ])
      // Both are offered for folding, the session's own worktree store first,
      // then every root's pre-slug (bare-hash) name — listed whether or not a
      // file exists there, so pre-upgrade stores fold in or pause for review.
      expect(storeMigrationCandidates(rekeyed!.paths)).toEqual([
        permissionStoreFile(configDir, linked),
        permissionStoreFile(configDir, nested),
        preSlugPermissionStoreFile(configDir, linked),
        preSlugPermissionStoreFile(configDir, primary),
        preSlugPermissionStoreFile(configDir, nested),
      ])
    })

    test("a write that joins an in-flight passive probe re-derives instead of inheriting it", async () => {
      // The passive read probes while git is still down; the write arrives
      // during that probe and must not settle for its answer — git may have
      // recovered in between, and the write is what makes keying durable.
      // The read's probe is the first git call and fails; everything after it
      // succeeds, standing in for a recovery that lands while the read is
      // still in flight. A time-based gate cannot express this — the spawn
      // happens asynchronously, after the write has already been queued.
      let calls = 0
      const recovering: ExecRunner = (cwd, args) => {
        calls++
        return calls === 1 ? gitDenies(cwd, args) : realGit(cwd, args)
      }
      const resolve = createStoreKeyingResolver({
        scope: "repository",
        directory: linked,
        worktree: "/",
        git: recovering,
        retryIntervalMs: 1_000_000,
        now: () => 0,
      })

      const read = resolve(configDir)
      const write = resolve(configDir, { write: true })
      const [readKeying, writeKeying] = await Promise.all([read, write])

      expect(readKeying?.settled).toBe(false)
      expect(readKeying?.paths.storeFile).toBe(
        permissionStoreFile(configDir, linked),
      )
      expect(writeKeying?.settled).toBe(true)
      expect(writeKeying?.shared).toBe(true)
      expect(writeKeying?.paths.storeFile).toBe(
        permissionStoreFile(configDir, primary),
      )
      // And the write's own save is not orphaned by its re-key: the store the
      // read was about to hand it is offered for folding.
      expect(storeMigrationCandidates(writeKeying!.paths)).toContain(
        permissionStoreFile(configDir, linked),
      )
    })

    test("a genuinely non-git directory keys by the directory without probe warnings", async () => {
      let fallbacks = 0
      const resolve = createStoreKeyingResolver({
        scope: "repository",
        directory: plain,
        worktree: undefined,
        git: gitDenies,
        onProbeFallback: () => {
          fallbacks++
        },
      })
      const keying = await resolve(configDir)
      expect(keying?.shared).toBe(false)
      expect(keying?.paths.storeFile).toBe(
        permissionStoreFile(configDir, plain),
      )
      expect(fallbacks).toBe(0)
    })
  })
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  accountIdFromToken,
  authEntry,
  oauthAccountId,
  oauthExpired,
  oauthRecordOf,
  openCodeAuthStorePath,
  openCodeDataDir,
  readAuthStore,
  readRefreshedAuthStore,
  validAuthType,
  validatedAuthStore,
} from "../src/index"

/**
 * OpenCode's auth store (2026-07-23 audit §2.3 / §2.8.4 — the Tier 3
 * credential-path extraction).
 *
 * Three packages read auth.json and the three disagreed, so these tests pin
 * the answers the consolidation settled rather than any one fork's behavior:
 * the inline OPENCODE_AUTH_CONTENT override is honored EVERYWHERE and stays
 * raw, the file is decoded entry by entry the way the host decodes it, a
 * failed read is an empty store rather than an unknown one, the environment
 * alone places the file (the SDK-state-path rewrite web-search depended on is
 * retired, not folded in), and the JWT account-id fallback that lived only in
 * usage-limits is available to both OAuth callers.
 *
 * Host ground truth throughout: opencode/src/auth/index.ts:10-67 (v1.18.5),
 * core/global.ts:11-14, plugin/openai/codex.ts:47-63.
 */

let dir: string

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "auth-")))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** Writes `store` to the auth.json under a data dir keyed by XDG_DATA_HOME. */
async function plantStore(store: unknown): Promise<void> {
  await fs.mkdir(path.join(dir, "opencode"), { recursive: true })
  await fs.writeFile(
    path.join(dir, "opencode", "auth.json"),
    JSON.stringify(store),
  )
}

const jwt = (claims: Record<string, unknown>) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`

describe("openCodeDataDir", () => {
  test("XDG_DATA_HOME wins, else ~/.local/share — the host's own xdg read", () => {
    expect(openCodeDataDir({ XDG_DATA_HOME: "/xdg/data" }, "/home/me")).toBe(
      path.join("/xdg/data", "opencode"),
    )
    expect(openCodeDataDir({}, "/home/me")).toBe(
      path.join("/home/me", ".local", "share", "opencode"),
    )
  })

  // xdg-basedir 5.1.0 is a plain `env.XDG_DATA_HOME || <home>/.local/share`:
  // an empty value falls back, a whitespace one does not. usage-limits' fork
  // treated whitespace as unset and so would have read the real store while
  // the host read a relative directory — the settled answer is the host's.
  test("an empty value falls back but a whitespace one is used verbatim", () => {
    expect(openCodeDataDir({ XDG_DATA_HOME: "" }, "/home/me")).toBe(
      path.join("/home/me", ".local", "share", "opencode"),
    )
    expect(openCodeDataDir({ XDG_DATA_HOME: "  " }, "/home/me")).toBe(
      path.join("  ", "opencode"),
    )
  })

  test("OPENCODE_CONFIG_DIR does not move the data dir", () => {
    // The host applies that flag to Global.Path.config only (global.ts:64).
    expect(
      openCodeDataDir({ OPENCODE_CONFIG_DIR: "/elsewhere" }, "/home/me"),
    ).toBe(path.join("/home/me", ".local", "share", "opencode"))
  })
})

describe("openCodeAuthStorePath", () => {
  test("is auth.json inside the data dir, and nothing else places it", () => {
    expect(
      openCodeAuthStorePath({ XDG_DATA_HOME: "/xdg/data" }, "/home/me"),
    ).toBe(path.join("/xdg/data", "opencode", "auth.json"))
    expect(openCodeAuthStorePath({}, "/home/me")).toBe(
      path.join("/home/me", ".local", "share", "opencode", "auth.json"),
    )
  })

  // web-search reached the store through the SDK's state dir instead, rewriting
  // …/state/opencode into …/share/opencode. That derivation is retired rather
  // than folded in, because it is either redundant (same process — the env
  // derivation already answers) or unsound (different process — nothing about
  // THIS environment proves anything about the one that placed the server's
  // dirs). A server placed by XDG_STATE_HOME is the unsound case, and it is
  // the shape the repo's own e2e sandbox has.
  test("where state lives never moves it — only XDG_DATA_HOME and home do", () => {
    expect(
      openCodeAuthStorePath(
        { XDG_STATE_HOME: "/var/lib/opencode/state" },
        "/home/me",
      ),
    ).toBe(path.join("/home/me", ".local", "share", "opencode", "auth.json"))
    expect(
      openCodeAuthStorePath(
        {
          XDG_STATE_HOME: "/var/lib/opencode/state",
          XDG_DATA_HOME: "/srv/data",
        },
        "/home/me",
      ),
    ).toBe(path.join("/srv/data", "opencode", "auth.json"))
  })
})

// The host-parity spec for the file filter, moved here with the definition
// (it was redact-secrets' — the one piece of the three readers that plugin
// owned outright). Its consumers stay pinned in that package's tests.
describe("validAuthType / validatedAuthStore", () => {
  test("accepts only well-formed entries, matching the Info union", () => {
    expect(
      validAuthType({ type: "oauth", refresh: "r", access: "a", expires: 0 }),
    ).toBe("oauth")
    expect(
      validAuthType({
        type: "oauth",
        refresh: "r",
        access: "a",
        expires: 10,
        accountId: "x",
      }),
    ).toBe("oauth")
    expect(validAuthType({ type: "api", key: "sk-x" })).toBe("api")
    expect(
      validAuthType({ type: "api", key: "sk-x", metadata: { a: "b" } }),
    ).toBe("api")
    expect(validAuthType({ type: "api", key: "sk-x", metadata: {} })).toBe(
      "api",
    )
    expect(validAuthType({ type: "wellknown", key: "k", token: "t" })).toBe(
      "wellknown",
    )
    // Excess properties are ignored, exactly like Schema.Class decoding.
    expect(validAuthType({ type: "api", key: "sk-x", extra: 1 })).toBe("api")
  })

  test("drops the shapes the host drops", () => {
    // The stale entry that motivated the filter: an oauth marker with no
    // tokens, which used to masquerade as an active oauth provider.
    expect(validAuthType({ type: "oauth" })).toBeUndefined()
    expect(validAuthType({ type: "oauth", access: "a" })).toBeUndefined()
    expect(
      validAuthType({ type: "oauth", refresh: "r", access: "a", expires: -1 }),
    ).toBeUndefined()
    expect(
      validAuthType({ type: "oauth", refresh: "r", access: "a", expires: 1.5 }),
    ).toBeUndefined()
    // `NonNegativeInt` is `Schema.Int`, and effect's `isInt` filter is
    // `Number.isSafeInteger` — an expiry past 2^53 is not an integer to the
    // host, so the host drops the whole entry and no plugin may keep it.
    for (const expires of [
      Number.MAX_SAFE_INTEGER + 1,
      1e100,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    ]) {
      expect(
        validAuthType({ type: "oauth", refresh: "r", access: "a", expires }),
      ).toBeUndefined()
    }
    expect(
      validAuthType({
        type: "oauth",
        refresh: "r",
        access: "a",
        expires: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe("oauth")
    expect(
      validAuthType({
        type: "oauth",
        refresh: "r",
        access: "a",
        expires: "10",
      }),
    ).toBeUndefined()
    expect(
      validAuthType({
        type: "oauth",
        refresh: "r",
        access: "a",
        expires: 0,
        accountId: 7,
      }),
    ).toBeUndefined()
    expect(validAuthType({ type: "api" })).toBeUndefined()
    // metadata present but not Record<string,string>: the host's optional
    // field decode fails and the WHOLE entry is dropped.
    for (const metadata of [42, null, "x", [], { a: 1 }, { a: { b: "c" } }]) {
      expect(validAuthType({ type: "api", key: "sk-x", metadata })).toBe(
        undefined,
      )
    }
    expect(validAuthType({ type: "wellknown", key: "k" })).toBeUndefined()
    expect(validAuthType({ type: "unknown", key: "k" })).toBeUndefined()
    expect(validAuthType({ key: "k" })).toBeUndefined()
    expect(validAuthType("nope")).toBeUndefined()
    expect(validAuthType(null)).toBeUndefined()
    expect(validAuthType(["api"])).toBeUndefined()
  })

  test("keeps surviving entries as the raw objects, junk as an empty store", () => {
    const entry = { type: "api", key: "sk", extra: "kept" }
    expect({
      ...validatedAuthStore({ openai: entry, bad: { type: "oauth" } }),
    }).toEqual({ openai: entry })
    expect({ ...validatedAuthStore("garbage") }).toEqual({})
    expect({ ...validatedAuthStore(undefined) }).toEqual({})
    expect({ ...validatedAuthStore(null) }).toEqual({})
  })

  // JSON.parse makes __proto__ an own property, so a plain-literal accumulator
  // would re-point the result's prototype instead of adding a provider — and
  // the store this returns decides which providers the wire backstop leaves
  // alone.
  test("a __proto__ entry cannot reach the result's prototype", () => {
    const store = validatedAuthStore(
      JSON.parse(
        '{"__proto__":{"type":"api","key":"x"},"openai":{"type":"api","key":"sk"}}',
      ),
    )
    expect(Object.keys(store)).toEqual(["__proto__", "openai"])
    expect(Object.getPrototypeOf(store)).toBeNull()
    expect(({} as Record<string, unknown>).type).toBeUndefined()
  })
})

describe("readAuthStore", () => {
  test("reads the store the environment points at, entry-filtered", async () => {
    await plantStore({
      "opencode-go": { type: "api", key: "sk-go" },
      stale: { type: "oauth" },
    })
    expect(
      await readAuthStore({ env: { XDG_DATA_HOME: dir }, homedir: "/nowhere" }),
    ).toEqual({ "opencode-go": { type: "api", key: "sk-go" } })
  })

  // The override is production, not a test affordance: a control-plane
  // workspace is launched with its credentials in this variable and no
  // auth.json on disk at all (control-plane/workspace.ts:530). web-search's
  // reader ignored it entirely (§2.8.4) and so was blind exactly where the
  // host was signed in.
  test("OPENCODE_AUTH_CONTENT wins wholesale, without touching the file", async () => {
    const inline = { openai: { type: "oauth", access: "inline" } }
    expect(
      await readAuthStore({
        env: {
          OPENCODE_AUTH_CONTENT: JSON.stringify(inline),
          XDG_DATA_HOME: dir,
        },
        homedir: "/nowhere",
        readFile: () => Promise.reject(new Error("must not read the file")),
      }),
    ).toEqual(inline)
  })

  // The host returns JSON.parse(...) verbatim on this path, ahead of its
  // per-entry decode — so an entry auth.json would never keep is still
  // authoritative when it arrives inline. redact-secrets depends on this to
  // recognize a provider whose fetch the host has already claimed.
  test("inline content is RAW — the entry filter is only for the file", async () => {
    const bare = { openai: { type: "oauth" } }
    expect(
      await readAuthStore({
        env: { OPENCODE_AUTH_CONTENT: JSON.stringify(bare) },
        homedir: "/nowhere",
      }),
    ).toEqual(bare)
  })

  test("inline content that parses to no usable entries still wins", async () => {
    await plantStore({ openai: { type: "api", key: "sk-file" } })
    expect(
      await readAuthStore({
        env: { OPENCODE_AUTH_CONTENT: "{}", XDG_DATA_HOME: dir },
        homedir: "/nowhere",
      }),
    ).toEqual({})
  })

  test("an empty OPENCODE_AUTH_CONTENT is not set at all", async () => {
    await plantStore({ openai: { type: "api", key: "sk-file" } })
    expect(
      await readAuthStore({
        env: { OPENCODE_AUTH_CONTENT: "", XDG_DATA_HOME: dir },
        homedir: "/nowhere",
      }),
    ).toEqual({ openai: { type: "api", key: "sk-file" } })
  })

  // The host swallows the parse error and reads the file, staying signed in;
  // a reader that treated garbage inline content as a sign-out would disagree
  // with the host about every credential it holds.
  test("unparseable inline content falls through to the file", async () => {
    await plantStore({ openai: { type: "api", key: "sk-file" } })
    expect(
      await readAuthStore({
        env: { OPENCODE_AUTH_CONTENT: "{oops", XDG_DATA_HOME: dir },
        homedir: "/nowhere",
      }),
    ).toEqual({ openai: { type: "api", key: "sk-file" } })
  })

  test("a missing or corrupt file is an EMPTY store, not an unknown one", async () => {
    expect(
      await readAuthStore({
        env: { XDG_DATA_HOME: path.join(dir, "nothing-here") },
        homedir: "/nowhere",
      }),
    ).toEqual({})
    await fs.mkdir(path.join(dir, "opencode"), { recursive: true })
    await fs.writeFile(path.join(dir, "opencode", "auth.json"), "{not json")
    expect(
      await readAuthStore({ env: { XDG_DATA_HOME: dir }, homedir: "/nowhere" }),
    ).toEqual({})
  })

  test("the path is re-derived per call, so a moved environment is followed", async () => {
    await plantStore({ openai: { type: "api", key: "sk-here" } })
    const env: Record<string, string | undefined> = {
      XDG_DATA_HOME: path.join(dir, "nothing-here"),
    }
    expect(await readAuthStore({ env, homedir: "/nowhere" })).toEqual({})
    env.XDG_DATA_HOME = dir
    expect(await readAuthStore({ env, homedir: "/nowhere" })).toEqual({
      openai: { type: "api", key: "sk-here" },
    })
  })
})

// The store's one deliberate divergence from Auth.all(). A control-plane
// workspace's credentials arrive once, frozen, in OPENCODE_AUTH_CONTENT; when a
// token expires the host refreshes it and Auth.set() writes the replacement to
// auth.json (auth/index.ts:73-83), but Auth.all() short-circuits on the
// variable and never opens the file — so the mirror keeps reporting a dead
// token for the workspace's whole lifetime. web-search has to USE that token, so
// it reads the repaired view instead of the mirror.
describe("readRefreshedAuthStore", () => {
  const OAUTH = {
    type: "oauth",
    refresh: "r",
    access: "a",
    expires: 0,
    accountId: "acct-1",
  }
  const NOW = 1_000_000

  const env = (inline: unknown) => ({
    OPENCODE_AUTH_CONTENT: JSON.stringify(inline),
    XDG_DATA_HOME: dir,
  })

  test("an expired inline record is replaced by a later file record", async () => {
    await plantStore({
      openai: { ...OAUTH, access: "fresh", expires: NOW + 3_600_000 },
    })
    expect(
      await readRefreshedAuthStore({
        env: env({ openai: { ...OAUTH, access: "stale", expires: NOW - 1 } }),
        homedir: "/nowhere",
        now: NOW,
      }),
    ).toEqual({
      openai: { ...OAUTH, access: "fresh", expires: NOW + 3_600_000 },
    })
  })

  test("a later file record for another account never replaces inline auth", async () => {
    const inline = {
      openai: {
        ...OAUTH,
        access: "stale-a",
        expires: NOW - 1,
        accountId: "acct-a",
      },
    }
    await plantStore({
      openai: {
        ...OAUTH,
        access: "fresh-b",
        expires: NOW + 3_600_000,
        accountId: "acct-b",
      },
    })
    expect(
      await readRefreshedAuthStore({
        env: env(inline),
        homedir: "/nowhere",
        now: NOW,
      }),
    ).toEqual(inline)
  })

  test("an unprovable account identity fails closed", async () => {
    const inline = {
      openai: { ...OAUTH, access: "opaque-a", expires: NOW - 1 },
    }
    delete (inline.openai as { accountId?: string }).accountId
    await plantStore({
      openai: { ...OAUTH, access: "opaque-b", expires: NOW + 3_600_000 },
    })
    expect(
      await readRefreshedAuthStore({
        env: env(inline),
        homedir: "/nowhere",
        now: NOW,
      }),
    ).toEqual(inline)
  })

  test("a live inline record is returned raw, with no file read at all", async () => {
    const inline = { openai: { ...OAUTH, access: "live", expires: NOW + 1 } }
    expect(
      await readRefreshedAuthStore({
        env: env(inline),
        homedir: "/nowhere",
        readFile: () => Promise.reject(new Error("must not read the file")),
        now: NOW,
      }),
    ).toEqual(inline)
  })

  // Every other entry of the snapshot survives untouched, including the shapes
  // the file decode would have dropped — the repair is per record, not a
  // re-read of the store.
  test("only the expired provider moves; the rest of the snapshot stands", async () => {
    await plantStore({
      openai: { ...OAUTH, access: "fresh", expires: NOW + 10 },
      anthropic: { type: "api", key: "sk-file" },
    })
    expect(
      await readRefreshedAuthStore({
        env: env({
          openai: { ...OAUTH, access: "stale", expires: NOW - 1 },
          anthropic: { type: "api", key: "sk-inline" },
          bare: { type: "oauth" },
        }),
        homedir: "/nowhere",
        now: NOW,
      }),
    ).toEqual({
      openai: { ...OAUTH, access: "fresh", expires: NOW + 10 },
      anthropic: { type: "api", key: "sk-inline" },
      bare: { type: "oauth" },
    })
  })

  test("a provider only the FILE holds is never added — that would be a merge", async () => {
    await plantStore({ "github-copilot": { ...OAUTH, refresh: "gho" } })
    expect(
      await readRefreshedAuthStore({
        env: env({ openai: { ...OAUTH, expires: NOW - 1 } }),
        homedir: "/nowhere",
        now: NOW,
      }),
    ).toEqual({ openai: { ...OAUTH, expires: NOW - 1 } })
  })

  // Copilot's api key IS its refresh token and the host stores `expires: 0` for
  // it, so its record always reads as expired. The file's copy carries the same
  // 0 and never wins, so nothing about Copilot changes.
  test("an equal or older file record never wins, so Copilot rides through", async () => {
    await plantStore({
      "github-copilot": { ...OAUTH, refresh: "file-gho", expires: 0 },
      openai: { ...OAUTH, access: "older", expires: NOW - 500 },
    })
    expect(
      await readRefreshedAuthStore({
        env: env({
          "github-copilot": { ...OAUTH, refresh: "inline-gho", expires: 0 },
          openai: { ...OAUTH, access: "newer", expires: NOW - 100 },
        }),
        homedir: "/nowhere",
        now: NOW,
      }),
    ).toEqual({
      "github-copilot": { ...OAUTH, refresh: "inline-gho", expires: 0 },
      openai: { ...OAUTH, access: "newer", expires: NOW - 100 },
    })
  })

  // A later record that is ALSO expired still replaces the older one: it is the
  // newest thing the host wrote, and the caller declines either way.
  test("the newest record wins even when it too has expired", async () => {
    await plantStore({
      openai: { ...OAUTH, access: "newer", expires: NOW - 1 },
    })
    expect(
      await readRefreshedAuthStore({
        env: env({ openai: { ...OAUTH, access: "older", expires: NOW - 500 } }),
        homedir: "/nowhere",
        now: NOW,
      }),
    ).toMatchObject({ openai: { access: "newer" } })
  })

  test("a file entry the host would drop cannot replace anything", async () => {
    // No refresh token: Auth.all() discards this entry, so it is not a
    // credential here either and the expired inline record stands.
    await plantStore({
      openai: { type: "oauth", access: "fresh", expires: NOW + 10 },
    })
    expect(
      await readRefreshedAuthStore({
        env: env({ openai: { ...OAUTH, access: "stale", expires: NOW - 1 } }),
        homedir: "/nowhere",
        now: NOW,
      }),
    ).toEqual({ openai: { ...OAUTH, access: "stale", expires: NOW - 1 } })
  })

  test("a missing or unreadable file leaves the snapshot exactly as it was", async () => {
    const inline = { openai: { ...OAUTH, access: "stale", expires: NOW - 1 } }
    expect(
      await readRefreshedAuthStore({
        env: {
          OPENCODE_AUTH_CONTENT: JSON.stringify(inline),
          XDG_DATA_HOME: path.join(dir, "nothing-here"),
        },
        homedir: "/nowhere",
        now: NOW,
      }),
    ).toEqual(inline)
  })

  // With no override the file IS the store, so a refresh is already visible and
  // there is nothing to repair: this must stay the plain reader.
  test("with no inline override it is exactly readAuthStore", async () => {
    await plantStore({
      openai: { ...OAUTH, expires: NOW - 1 },
      stale: { type: "oauth" },
    })
    const input = { env: { XDG_DATA_HOME: dir }, homedir: "/nowhere" }
    expect(await readRefreshedAuthStore({ ...input, now: NOW })).toEqual(
      await readAuthStore(input),
    )
  })

  test("unparseable inline content still falls through to the file", async () => {
    await plantStore({ openai: { type: "api", key: "sk-file" } })
    expect(
      await readRefreshedAuthStore({
        env: { OPENCODE_AUTH_CONTENT: "{oops", XDG_DATA_HOME: dir },
        homedir: "/nowhere",
        now: NOW,
      }),
    ).toEqual({ openai: { type: "api", key: "sk-file" } })
  })

  test("a __proto__ entry cannot reach the repaired store's prototype", async () => {
    await plantStore({
      openai: { ...OAUTH, access: "fresh", expires: NOW + 1 },
    })
    const repaired = (await readRefreshedAuthStore({
      env: env(
        JSON.parse(
          `{"openai":${JSON.stringify({ ...OAUTH, expires: NOW - 1 })},"__proto__":{"polluted":true}}`,
        ),
      ),
      homedir: "/nowhere",
      now: NOW,
    })) as Record<string, unknown>
    expect(Object.getPrototypeOf(repaired)).toBeNull()
    expect(Object.keys(repaired)).toContain("__proto__")
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })
})

describe("oauthExpired", () => {
  // The predicate both the decline and the refresh fallback key off, so the
  // repair fires for exactly the records a caller would refuse.
  test("only a stored expiry that has passed is expired", () => {
    expect(oauthExpired({ expires: 999 }, 1_000)).toBe(true)
    expect(oauthExpired({ expires: 1_000 }, 1_000)).toBe(false)
    expect(oauthExpired({ expires: 1_001 }, 1_000)).toBe(false)
    expect(oauthExpired({ expires: 0 }, 1_000)).toBe(true)
  })

  // Nothing proves a record with no usable expiry dead, and the raw inline path
  // can carry one — `oauthRecordOf` drops a non-numeric or non-finite value.
  test("a record with no usable expiry, or no record, is not expired", () => {
    expect(oauthExpired({ access: "a" }, 1_000)).toBe(false)
    expect(oauthExpired(undefined, 1_000)).toBe(false)
    expect(
      oauthExpired(
        oauthRecordOf({ x: { type: "oauth", expires: "10" } }, "x"),
        1_000,
      ),
    ).toBe(false)
  })
})

describe("authEntry / oauthRecordOf", () => {
  test("indexes a provider's entry, rejecting every non-object shape", () => {
    expect(authEntry({ openai: { type: "api" } }, "openai")).toEqual({
      type: "api",
    })
    expect(authEntry({ openai: "sk" }, "openai")).toBeUndefined()
    expect(authEntry({}, "openai")).toBeUndefined()
    expect(authEntry(null, "openai")).toBeUndefined()
    expect(authEntry("garbage", "openai")).toBeUndefined()
  })

  test("keeps only usable oauth fields, and only for oauth entries", () => {
    expect(
      oauthRecordOf(
        {
          openai: {
            type: "oauth",
            access: "at",
            refresh: "rt",
            expires: 42,
            accountId: "acct",
            enterpriseUrl: "https://ghe.corp",
          },
        },
        "openai",
      ),
    ).toEqual({
      access: "at",
      refresh: "rt",
      expires: 42,
      accountId: "acct",
      enterpriseUrl: "https://ghe.corp",
    })
    expect(
      oauthRecordOf({ openai: { type: "api", key: "sk" } }, "openai"),
    ).toBe(undefined)
  })

  // Deliberately lenient: codex-limits needs access+expires, web-search only
  // ever sends the access token, and Copilot's API key IS its refresh token. A
  // parser strict enough for one would reject records the others serve, so
  // each narrows for itself.
  test("every field is optional — callers narrow, the parser does not", () => {
    expect(oauthRecordOf({ openai: { type: "oauth" } }, "openai")).toEqual({
      access: undefined,
      refresh: undefined,
      expires: undefined,
      accountId: undefined,
      enterpriseUrl: undefined,
    })
    expect(
      oauthRecordOf(
        {
          openai: { type: "oauth", access: "", accountId: "", expires: "soon" },
        },
        "openai",
      ),
    ).toMatchObject({
      access: undefined,
      accountId: undefined,
      expires: undefined,
    })
  })
})

describe("accountIdFromToken / oauthAccountId", () => {
  test("reads claims in the host's precedence", () => {
    expect(accountIdFromToken(jwt({ chatgpt_account_id: "top" }))).toBe("top")
    expect(
      accountIdFromToken(
        jwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "nested" },
        }),
      ),
    ).toBe("nested")
    expect(accountIdFromToken(jwt({ organizations: [{ id: "org-1" }] }))).toBe(
      "org-1",
    )
    expect(
      accountIdFromToken(
        jwt({
          chatgpt_account_id: "top",
          organizations: [{ id: "org-1" }],
        }),
      ),
    ).toBe("top")
  })

  // The host refuses a token that is not three dot-separated segments
  // (plugin/openai/codex.ts:47-55); the copy this replaces decoded whatever
  // sat between the first two dots, so a `<junk>.<payload>` string it should
  // have refused could still yield an account id.
  test("a token that is not three segments is refused, like the host's", () => {
    const payload = Buffer.from(
      JSON.stringify({ chatgpt_account_id: "acct" }),
    ).toString("base64url")
    expect(accountIdFromToken(`header.${payload}.sig`)).toBe("acct")
    expect(accountIdFromToken(`header.${payload}`)).toBeUndefined()
    expect(accountIdFromToken(`header.${payload}.sig.extra`)).toBeUndefined()
  })

  // Access tokens are untrusted store input, so a payload that decodes to
  // non-JSON must not throw past the caller.
  test("garbage tokens yield nothing rather than throwing", () => {
    expect(accountIdFromToken("not-a-jwt")).toBeUndefined()
    expect(accountIdFromToken(undefined)).toBeUndefined()
    expect(accountIdFromToken(42)).toBeUndefined()
    expect(
      accountIdFromToken(`x.${Buffer.from("[1]").toString("base64url")}.y`),
    ).toBeUndefined()
    expect(
      accountIdFromToken(
        `x.${Buffer.from("<<< not json >>>").toString("base64url")}.y`,
      ),
    ).toBeUndefined()
    expect(accountIdFromToken("x.!!!not-base64!!!.y")).toBeUndefined()
    expect(accountIdFromToken(jwt({ chatgpt_account_id: 12345 }))).toBe(
      undefined,
    )
  })

  // The fallback existed only in usage-limits though web-search's ChatGPT path
  // wanted the same id: the host derives account ids from exactly this token
  // when it mints the record, so a record without the field still resolves to
  // the id the host would have stored.
  test("the stored accountId wins, then the access token's claim", () => {
    expect(oauthAccountId({ accountId: "stored", access: jwt({}) })).toBe(
      "stored",
    )
    expect(
      oauthAccountId({ access: jwt({ chatgpt_account_id: "claimed" }) }),
    ).toBe("claimed")
    expect(oauthAccountId({ access: "opaque-token" })).toBeUndefined()
    expect(oauthAccountId({})).toBeUndefined()
  })
})

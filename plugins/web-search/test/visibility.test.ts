import { describe, expect, test } from "bun:test"
import { mirrorWebsearchPermissions } from "../src/visibility"

/**
 * The alias-visibility mirror. The host filters tools from the model
 * per TOOL ID (Permission.disabled): a ruleset ending in `websearch:
 * "allow"` under `"*": "deny"` keeps the builtin id visible but hides the
 * `web_search` alias — and off-Zen the registry already removed the
 * builtin id, leaving no search at all. These pin the config-hook mirror
 * that closes that gap.
 */

describe("literal-key mirroring", () => {
  test("a global websearch rule is copied to web_search", () => {
    const config: Record<string, unknown> = {
      permission: { "*": "deny", websearch: "allow" },
    }
    mirrorWebsearchPermissions(config)
    expect(config.permission).toEqual({
      "*": "deny",
      websearch: "allow",
      web_search: "allow",
    })
  })

  test("deny mirrors too — the alias never outlives a websearch deny", () => {
    const config: Record<string, unknown> = {
      permission: { websearch: "deny" },
    }
    mirrorWebsearchPermissions(config)
    expect(config.permission).toMatchObject({ web_search: "deny" })
  })

  test("pattern-object rules are cloned, not shared by reference", () => {
    const config = {
      permission: { websearch: { "*.internal": "deny", "*": "allow" } },
    } as { permission: Record<string, unknown> }
    mirrorWebsearchPermissions(config)
    expect(config.permission.web_search).toEqual({
      "*.internal": "deny",
      "*": "allow",
    })
    expect(config.permission.web_search).not.toBe(config.permission.websearch)
  })

  test("an explicit web_search key is user intent and never overwritten", () => {
    const config: Record<string, unknown> = {
      permission: { websearch: "allow", web_search: "deny" },
    }
    mirrorWebsearchPermissions(config)
    expect(config.permission).toEqual({
      websearch: "allow",
      web_search: "deny",
    })
  })

  test("per-agent rulesets mirror independently", () => {
    const config = {
      agent: {
        researcher: { permission: { "*": "deny", websearch: "allow" } },
        writer: { permission: { bash: "deny" } },
      },
    } as {
      agent: Record<string, { permission: Record<string, unknown> }>
    }
    mirrorWebsearchPermissions(config)
    expect(config.agent.researcher?.permission).toMatchObject({
      web_search: "allow",
    })
    expect(config.agent.writer?.permission).toEqual({ bash: "deny" })
  })

  test("wildcard keys already match both ids and are left alone", () => {
    const config: Record<string, unknown> = {
      permission: { "web*": "deny" },
    }
    mirrorWebsearchPermissions(config)
    expect(config.permission).toEqual({ "web*": "deny" })
  })
})

describe("the built-in explore equalizer", () => {
  test("with no user search rules, explore gets a web_search allow appended", () => {
    // The built-in explore agent hardcodes { "*": "deny", websearch:
    // "allow" }; per-agent config merges last, so this appended allow makes
    // the alias exactly as visible as the builtin id there.
    const config: Record<string, unknown> = {}
    mirrorWebsearchPermissions(config)
    expect(config).toEqual({
      agent: { explore: { permission: { web_search: "allow" } } },
    })
  })

  test("existing explore config is extended, not replaced", () => {
    const config = {
      agent: { explore: { model: "some/model", permission: { bash: "deny" } } },
    } as Record<string, unknown>
    mirrorWebsearchPermissions(config)
    expect(config.agent).toEqual({
      explore: {
        model: "some/model",
        permission: { bash: "deny", web_search: "allow" },
      },
    })
  })

  test("a user rule governing search suppresses the injection (it would merge last and override)", () => {
    // Global websearch deny: the mirror already copies the deny; an
    // injected agent-level allow would defeat it.
    const denied: Record<string, unknown> = {
      permission: { websearch: "deny" },
    }
    mirrorWebsearchPermissions(denied)
    expect(denied.agent).toBeUndefined()

    // Same for wildcard rules and for explore's own rules.
    const wildcarded: Record<string, unknown> = {
      permission: { "web*": "ask" },
    }
    mirrorWebsearchPermissions(wildcarded)
    expect(wildcarded.agent).toBeUndefined()

    const exploreOwn: Record<string, unknown> = {
      agent: { explore: { permission: { websearch: "deny" } } },
    }
    mirrorWebsearchPermissions(exploreOwn)
    expect(exploreOwn.agent).toEqual({
      explore: { permission: { websearch: "deny", web_search: "deny" } },
    })
  })

  test("rules for OTHER agents do not suppress the explore equalizer", () => {
    const config = {
      agent: { writer: { permission: { websearch: "deny" } } },
    } as Record<string, unknown>
    mirrorWebsearchPermissions(config)
    expect(config.agent).toMatchObject({
      writer: { permission: { websearch: "deny", web_search: "deny" } },
      explore: { permission: { web_search: "allow" } },
    })
  })
})

describe("defensive shapes", () => {
  test("non-object configs and rulesets are ignored without throwing", () => {
    expect(() => mirrorWebsearchPermissions(null)).not.toThrow()
    expect(() => mirrorWebsearchPermissions("nope")).not.toThrow()
    expect(() =>
      mirrorWebsearchPermissions({ permission: "nope", agent: [1, 2] }),
    ).not.toThrow()
  })
})

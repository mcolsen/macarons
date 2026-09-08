import { describe, expect, test } from "bun:test"
import { rulesFrom, type Store } from "@macarons/permission-rules"
import { explicitCarveOut, parseRuleArray, storeCarveOut } from "../src/shared"

/**
 * The veto rules are the plugin's contract with the user's explicit
 * configuration, and they are source-aware. For host-evaluated rulesets (the
 * effective agent/session rules and the merged OpenCode config) a non-blanket
 * ask/deny rule always beats the classifier, while the blanket ask that
 * merely turns prompting on (a scalar `"bash": "ask"` or a `"*"` entry) hands
 * the decision to the classifier — and, being just the prompting-on switch,
 * is transparent to the veto scan: a blanket appended after a narrow
 * carve-out cannot shadow it, though a later matching allow still cancels it
 * (mirroring the host, where that allow suppresses the prompt entirely). For
 * persist-permissions' store — which no host evaluation ever enforces — ANY
 * matching non-allow rule vetoes, blanket included. If this table drifts,
 * Approve for Me either overrides deliberate carve-outs (trust violation) or
 * goes inert for every standard ask-by-default configuration.
 */

const rules = (permission: Store["permission"]) => rulesFrom({ permission })

describe("blanket rules never veto (they are what makes prompts exist)", () => {
  test('scalar "bash": "ask"', () => {
    expect(
      explicitCarveOut("bash", ["git push origin"], rules({ bash: "ask" })),
    ).toBeUndefined()
  })

  test('map blanket "*": "ask"', () => {
    expect(
      explicitCarveOut(
        "bash",
        ["git push origin"],
        rules({ bash: { "*": "ask" } }),
      ),
    ).toBeUndefined()
  })

  test('scalar "edit": "ask" — the only form OpenCode config offers for edits', () => {
    expect(
      explicitCarveOut("edit", ["src/app.ts"], rules({ edit: "ask" })),
    ).toBeUndefined()
  })

  test('even a blanket "deny" is not this plugin\'s veto (OpenCode enforces it itself)', () => {
    expect(
      explicitCarveOut("bash", ["anything"], rules({ bash: "deny" })),
    ).toBeUndefined()
  })
})

describe("non-blanket ask/deny carve-outs always veto", () => {
  test('"git push *": "ask" vetoes a matching command', () => {
    const carved = rules({ bash: { "*": "allow", "git push *": "ask" } })
    expect(explicitCarveOut("bash", ["git push origin main"], carved)).toEqual({
      permission: "bash",
      pattern: "git push *",
      action: "ask",
    })
  })

  test('"git push *": "deny" vetoes too', () => {
    const carved = rules({ bash: { "git push *": "deny" } })
    expect(
      explicitCarveOut("bash", ["git push origin main"], carved)?.action,
    ).toBe("deny")
  })

  test("a carve-out under a permission-key wildcard still vetoes", () => {
    const carved = rules({ "*": { "*secret*": "deny" } })
    expect(
      explicitCarveOut("read", ["/home/u/.secrets/key"], carved)?.pattern,
    ).toBe("*secret*")
  })

  test("any vetoed pattern vetoes the whole request", () => {
    const carved = rules({ bash: { "git push *": "ask" } })
    expect(
      explicitCarveOut("bash", ["git status", "git push origin"], carved),
    ).toBeDefined()
  })
})

describe("rule order: later allows cancel a carve-out, later blankets cannot shadow it", () => {
  test("an allow after the carve-out un-vetoes it", () => {
    const reordered = rules({ bash: { "git push *": "ask", "git *": "allow" } })
    expect(
      explicitCarveOut("bash", ["git push origin"], reordered),
    ).toBeUndefined()
  })

  test("a carve-out after an allow vetoes", () => {
    const carved = rules({ bash: { "git *": "allow", "git push *": "ask" } })
    expect(explicitCarveOut("bash", ["git push origin"], carved)).toBeDefined()
  })

  test("a trailing blanket ask cannot shadow an earlier carve-out — the carve-out still vetoes", () => {
    // The host's outcome is "ask" either way; the narrow rule decides the
    // only remaining question — the classifier does not get this one.
    const shadowed = rules({ bash: { "git push *": "ask", "*": "ask" } })
    expect(explicitCarveOut("bash", ["git push origin"], shadowed)).toEqual({
      permission: "bash",
      pattern: "git push *",
      action: "ask",
    })
  })

  test("a trailing blanket ask cannot shadow an earlier narrow deny either", () => {
    const shadowed = rules({ bash: { "git push *": "deny", "*": "ask" } })
    expect(
      explicitCarveOut("bash", ["git push origin"], shadowed)?.action,
    ).toBe("deny")
  })

  test("an agent carve-out survives a session-wide blanket ask appended after it", () => {
    // The host-resolved shape of the same situation: agent rules with the
    // session's rules appended last, as index.ts concatenates them.
    const effective = parseRuleArray([
      { permission: "bash", pattern: "git push *", action: "ask" },
      { permission: "bash", pattern: "*", action: "ask" },
    ])
    expect(
      explicitCarveOut("bash", ["git push origin main"], effective ?? [])
        ?.pattern,
    ).toBe("git push *")
  })

  test("a later allow still cancels the carve-out even under a trailing blanket ask", () => {
    const cancelled = rules({
      bash: { "git push *": "ask", "git *": "allow", "*": "ask" },
    })
    expect(
      explicitCarveOut("bash", ["git push origin"], cancelled),
    ).toBeUndefined()
  })

  test("a trailing blanket allow is not transparent — it cancels the carve-out", () => {
    // Under host semantics that allow wins and this ruleset never prompts at
    // all, so there is no carve-out intent left standing to enforce.
    const cancelled = rules({ bash: { "git push *": "ask", "*": "allow" } })
    expect(
      explicitCarveOut("bash", ["git push origin"], cancelled),
    ).toBeUndefined()
  })
})

describe("non-matching and allow rules never veto", () => {
  test("an unrelated carve-out does not veto", () => {
    expect(
      explicitCarveOut(
        "bash",
        ["git status"],
        rules({ bash: { "npm publish *": "ask" } }),
      ),
    ).toBeUndefined()
  })

  test("winning allow rules do not veto", () => {
    expect(
      explicitCarveOut(
        "bash",
        ["git status"],
        rules({ bash: { "git *": "allow" } }),
      ),
    ).toBeUndefined()
  })

  test("no rules at all: nothing to veto", () => {
    expect(explicitCarveOut("bash", ["anything"], [])).toBeUndefined()
  })

  test("a carve-out for another permission type does not veto", () => {
    expect(
      explicitCarveOut(
        "bash",
        ["git push"],
        rules({ webfetch: { "git push *": "ask" } }),
      ),
    ).toBeUndefined()
  })
})

describe("storeCarveOut: the store is not host-enforced, so blanket rules veto too", () => {
  test('a blanket scalar "deny" vetoes', () => {
    expect(
      storeCarveOut("bash", ["anything"], rules({ bash: "deny" }))?.action,
    ).toBe("deny")
  })

  test('a blanket "*": "ask" map entry vetoes', () => {
    expect(
      storeCarveOut(
        "bash",
        ["git push origin"],
        rules({ bash: { "*": "ask" } }),
      )?.pattern,
    ).toBe("*")
  })

  test("a non-blanket carve-out vetoes, same as the config rule", () => {
    expect(
      storeCarveOut(
        "bash",
        ["git push origin"],
        rules({ bash: { "git push *": "ask" } }),
      )?.action,
    ).toBe("ask")
  })

  test("a winning allow does not veto", () => {
    expect(
      storeCarveOut(
        "bash",
        ["git status"],
        rules({ bash: { "*": "deny", "git *": "allow" } }),
      ),
    ).toBeUndefined()
  })

  test("an unmatched request does not veto — the store has no opinion", () => {
    expect(
      storeCarveOut("bash", ["npm install"], rules({ webfetch: "deny" })),
    ).toBeUndefined()
  })

  test("any vetoed pattern vetoes the whole request", () => {
    expect(
      storeCarveOut(
        "bash",
        ["git status", "rm -rf /"],
        rules({ bash: { "rm *": "deny" } }),
      ),
    ).toBeDefined()
  })
})

describe("parseRuleArray accepts exactly the host's resolved ruleset shape", () => {
  test("a valid rule array round-trips in evaluation order", () => {
    const rules = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "git push *", action: "ask" },
    ]
    expect(parseRuleArray(rules)).toEqual(rules as never)
  })

  test("an empty array is a valid empty ruleset", () => {
    expect(parseRuleArray([])).toEqual([])
  })

  const invalid: [string, unknown][] = [
    ["not an array", { permission: "bash", pattern: "*", action: "ask" }],
    [
      "an unknown action",
      [{ permission: "bash", pattern: "*", action: "maybe" }],
    ],
    ["a missing field", [{ permission: "bash", action: "ask" }]],
    ["a non-object entry", ["bash"]],
    ["a nested array entry", [[]]],
    ["a null entry", [null]],
  ]
  for (const [label, value] of invalid) {
    test(`${label} rejects the whole ruleset`, () => {
      expect(parseRuleArray(value)).toBeUndefined()
    })
  }
})

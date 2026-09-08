import { describe, expect, test } from "bun:test"
import { allowRuleRedundant, type Rule } from "../src/index"

/**
 * The behavior table for allowRuleRedundant lives downstream in
 * plugins/persist-permissions/test/matching-spec.test.ts, and it is thorough
 * about the PATTERN legs. What it cannot see is the permission legs: every
 * fixture there uses "bash" on both the rule side and the request side, so
 * both `patternSubsumes(rule.permission, permission)` and
 * `patternsOverlap(rule.permission, permission)` are only ever evaluated on
 * two identical strings — replacing either with the literal `true` left the
 * whole suite byte-identical to baseline.
 *
 * These cases exist purely to vary the permission key, i.e. to pin the
 * ARGUMENT ORDER and the existence of the permission legs. They matter
 * because both call sites act on a "redundant" verdict by NOT writing:
 * persist-permissions skips the store write, and migrateWorktreeStoreLocked
 * (index.ts:2020) skips the rule and then deletes the source file, where a
 * wrongly-dropped rule is unrecoverable.
 */
describe("allowRuleRedundant's permission leg", () => {
  test("a wildcard permission key subsumes a concrete request", () => {
    // rulesFrom produces {"*": {"git *": "allow"}} stores and evaluate()
    // honors them, so a wildcard-keyed allow really does cover a bash
    // request: skipping the write is correct here.
    const rules: Rule[] = [
      { permission: "*", pattern: "git *", action: "allow" },
    ]
    expect(allowRuleRedundant("bash", "git status", rules)).toBe(true)
  })

  test("another tool's allow never makes this tool's approval redundant", () => {
    // The killing case. The pattern leg alone is satisfied ("src/*" subsumes
    // "src/app.ts"), so anything that stops treating the permission names as
    // meaningful reports redundant and the user's "always" answer for `edit`
    // is silently swallowed by an unrelated `bash` allow — no write, no log,
    // and the user is re-prompted next time believing it was saved.
    const rules: Rule[] = [
      { permission: "bash", pattern: "src/*", action: "allow" },
    ]
    expect(allowRuleRedundant("edit", "src/app.ts", rules)).toBe(false)
  })

  test("the subsumption check is directional, not symmetric", () => {
    // A concrete rule key must not subsume a wildcard request key: an allow
    // for `bash` alone cannot cover a request that spans every tool.
    const rules: Rule[] = [
      { permission: "bash", pattern: "*", action: "allow" },
    ]
    expect(allowRuleRedundant("*", "git status", rules)).toBe(false)
    expect(allowRuleRedundant("bash", "git status", rules)).toBe(true)
  })

  test("a carve-out for an unrelated tool does not defeat redundancy", () => {
    // Mirror of the killing case on the carve-out leg. The webfetch deny
    // overlaps on pattern but not on permission, so it cannot make a
    // bash approval non-redundant — dropping the permission leg here would
    // turn every unrelated deny into a spurious duplicate write.
    const rules: Rule[] = [
      { permission: "bash", pattern: "git *", action: "allow" },
      { permission: "webfetch", pattern: "*", action: "deny" },
    ]
    expect(allowRuleRedundant("bash", "git status", rules)).toBe(true)
  })

  test("a carve-out whose permission overlaps does defeat redundancy", () => {
    // The other direction of the same leg: a wildcard-keyed ask overlaps
    // `bash`, so the fresh allow is not a no-op — appended last it overrides
    // the ask, which is the entire point of persisting the approval.
    const rules: Rule[] = [
      { permission: "bash", pattern: "git *", action: "allow" },
      { permission: "*", pattern: "git status", action: "ask" },
    ]
    expect(allowRuleRedundant("bash", "git status", rules)).toBe(false)
  })
})

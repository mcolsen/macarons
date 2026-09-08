import { describe, expect, test } from "bun:test"
import { isStoreScope, resolveScopeOption } from "../src/index"

/**
 * resolveScopeOption decides persist-permissions' and approve-for-me's
 * store scope, and implements the strict-validate-or-pause contract: an absent
 * value defaults to "repository", a valid value passes through, and ANYTHING
 * else yields `problem` with NO scope — the caller must then pause persistence
 * rather than guess. The stakes are concrete: one half silently defaulting to
 * "repository" while another runs "worktree" makes the defaulting half migrate
 * away — and delete — the store the other is using. No test names this export.
 */

describe("resolveScopeOption", () => {
  test("an absent value defaults to the repository scope", () => {
    expect(resolveScopeOption(undefined)).toEqual({ scope: "repository" })
  })

  test("a valid scope passes through unchanged", () => {
    expect(resolveScopeOption("repository")).toEqual({ scope: "repository" })
    expect(resolveScopeOption("worktree")).toEqual({ scope: "worktree" })
  })

  test("an invalid value yields a problem and NO scope, so the caller pauses", () => {
    // The load-bearing branch: a `return { scope: "repository" }` mutant here
    // would resume persistence on garbage input instead of pausing.
    for (const bad of ["global", "", "Repository", null, 42, {}, []]) {
      const resolved = resolveScopeOption(bad)
      expect(resolved.scope).toBeUndefined()
      expect(resolved.problem).toBe(
        '"scope" must be "repository" or "worktree"',
      )
    }
  })
})

describe("isStoreScope", () => {
  test("accepts exactly the two known scopes", () => {
    expect(isStoreScope("repository")).toBe(true)
    expect(isStoreScope("worktree")).toBe(true)
  })
  test("rejects everything else", () => {
    for (const bad of ["global", "", "REPOSITORY", undefined, null, 0, {}]) {
      expect(isStoreScope(bad)).toBe(false)
    }
  })
})

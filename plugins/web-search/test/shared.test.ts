import { describe, expect, test } from "bun:test"
import { resolveServerOptions, safeEndpointLabel } from "../src/shared"

describe("search options", () => {
  test("native is enabled by default, SearXNG requires a URL", () => {
    expect(resolveServerOptions(undefined)).toMatchObject({
      native: { enabled: true },
      searxng: { url: undefined },
    })
  })
  test("invalid booleans and legacy restrictions fail closed", () => {
    expect(
      resolveServerOptions({ native: { enabled: "true" } }).native.enabled,
    ).toBe(false)
    expect(resolveServerOptions({ order: [] }).native.enabled).toBe(false)
    expect(
      resolveServerOptions({
        order: ["searxng"],
        searxng: { url: "https://search.test/" },
      }),
    ).toMatchObject({
      native: { enabled: false },
      searxng: { url: "https://search.test" },
    })
    expect(
      resolveServerOptions({
        order: ["exa"],
        searxng: { url: "https://search.test/" },
      }).searxng.url,
    ).toBeUndefined()
  })
  test("diagnostics omit endpoint credentials", () => {
    expect(
      safeEndpointLabel("https://user:password@example.test/search?key=secret"),
    ).not.toContain("password")
    expect(
      safeEndpointLabel("https://user:password@example.test/search?key=secret"),
    ).not.toContain("secret")
  })
})

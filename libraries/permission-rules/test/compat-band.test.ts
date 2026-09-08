import { describe, expect, test } from "bun:test"
import {
  BAND_SAMPLE_VERSIONS as BAND,
  classifyOpenCodeVersion,
  SUPPORTED_OPENCODE_RANGE,
  versionCeilingFromRange,
  versionFloorFromRange,
  versionFromHealth,
} from "../src/index"

/**
 * The band parser is the library's only public surface that no test in the
 * repo imports directly: `versionFloorFromRange` and `versionCeilingFromRange`
 * are named by zero test file, so their malformed-range fallbacks
 * (`{1,0,0}` and `{2,0,0}`) have never executed, and `BAND_SAMPLE_VERSIONS` —
 * the sample table ~ten plugins' compat suites derive from — has never been
 * anchored to anything the parser cannot drag along with it. Every plugin band
 * table is computed by the same two functions it purports to test, so a parser
 * regression ratchets the fixtures with it and survives.
 *
 * `tests/repo/test/version-pin.test.ts` anchors the SUPPORTED_OPENCODE_RANGE
 * *string constant* against `.opencode-version` with an independent regex. That
 * is a different anchor: it never evaluates the functions or the derived BAND
 * object. These cases pin the parser's behavior and the BAND derivation
 * directly, against literals rather than against samples the parser produced.
 */

// The band's bounds, parsed out of the range string by a regex written HERE,
// so a broken versionFloorFromRange/versionCeilingFromRange cannot move the
// expectation along with the value under test.
function boundFromRange(operator: RegExp): { text: string; parts: number[] } {
  const text = SUPPORTED_OPENCODE_RANGE.match(operator)?.[1]
  if (!text)
    throw new Error(
      `SUPPORTED_OPENCODE_RANGE (${SUPPORTED_OPENCODE_RANGE}) has no ${operator} bound`,
    )
  return { text, parts: text.split(".").map(Number) }
}

const FLOOR = boundFromRange(/>=\s*(\d+\.\d+\.\d+)/)
const CEILING = boundFromRange(/<\s*(\d+\.\d+\.\d+)/)

describe("BAND_SAMPLE_VERSIONS is anchored, not self-derived", () => {
  test("the range carries both bounds so the anchor is real", () => {
    expect(FLOOR.text).toMatch(/^\d+\.\d+\.\d+$/)
    expect(CEILING.text).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test("floor and aboveBand equal the range's literal bounds", () => {
    // aboveBand is the exclusive ceiling itself; floor is the inclusive floor.
    expect(BAND.floor).toBe(FLOOR.text)
    expect(BAND.aboveBand).toBe(CEILING.text)
  })

  test("inBand sits above the floor and belowBand below it, same minor line", () => {
    const [fMajor = 0, fMinor = 0, fPatch = 0] = FLOOR.parts
    expect(BAND.inBand).toBe(`${fMajor}.${fMinor}.${fPatch + 7}`)
    // belowBand steps back a patch, or a minor when the floor patch is 0.
    expect(BAND.belowBand).toBe(
      fPatch > 0
        ? `${fMajor}.${fMinor}.${fPatch - 1}`
        : `${fMajor}.${fMinor - 1}.99`,
    )
  })

  test("incompatible is the next major above the floor, and classifies as such", () => {
    const [fMajor = 0] = FLOOR.parts
    expect(BAND.incompatible).toBe(`${fMajor + 1}.0.0`)
    // The member exists so no plugin test mints its own non-v1 sample; it must
    // actually trip the hard v1 gate, not merely sit outside the band.
    expect(
      classifyOpenCodeVersion(BAND.incompatible, SUPPORTED_OPENCODE_RANGE),
    ).toBe("incompatible")
  })
})

describe("versionFloorFromRange / versionCeilingFromRange", () => {
  test("read only their own operator, ignoring the other bound", () => {
    // The floor reader must not be fooled by the `<` bound and vice-versa.
    expect(versionFloorFromRange(">=1.18.4 <1.19.0")).toEqual({
      major: 1,
      minor: 18,
      patch: 4,
    })
    expect(versionCeilingFromRange(">=1.18.4 <1.19.0")).toEqual({
      major: 1,
      minor: 19,
      patch: 0,
    })
  })

  test("a malformed range falls back to the widest v1 band, never throws", () => {
    // These fallbacks are the genuinely-unreached lines: no caller ever passes
    // a range without a matching bound, so nothing has pinned them. The floor
    // widens to 1.0.0 and the ceiling to the v1 boundary 2.0.0, so a typo in a
    // range constant degrades to "all of v1 is untested" rather than
    // "nothing is supported, everything warns" — the ceiling fallback is the
    // one surviving mutant (2.0.0 -> 1.0.0) the finding names.
    expect(versionFloorFromRange("")).toEqual({ major: 1, minor: 0, patch: 0 })
    expect(versionFloorFromRange("garbage")).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
    })
    expect(versionCeilingFromRange("")).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
    })
    expect(versionCeilingFromRange("<not-a-version")).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
    })
  })
})

describe("classifyOpenCodeVersion is inclusive at the floor, exclusive at the ceiling", () => {
  const range = ">=1.18.4 <1.19.0"
  test("the floor itself is supported", () => {
    expect(classifyOpenCodeVersion("1.18.4", range)).toBe("supported")
  })
  test("a version inside the band is supported", () => {
    expect(classifyOpenCodeVersion("1.18.30", range)).toBe("supported")
  })
  test("the ceiling itself is untested, not supported", () => {
    expect(classifyOpenCodeVersion("1.19.0", range)).toBe("untested")
  })
  test("below the floor is untested", () => {
    expect(classifyOpenCodeVersion("1.18.3", range)).toBe("untested")
  })
  test("a non-v1 major is incompatible, a prerelease is untested", () => {
    expect(classifyOpenCodeVersion("2.0.0", range)).toBe("incompatible")
    expect(classifyOpenCodeVersion("0.9.0", range)).toBe("incompatible")
    expect(classifyOpenCodeVersion("1.18.6-beta.1", range)).toBe("untested")
    expect(classifyOpenCodeVersion("not-a-version", range)).toBe("untested")
  })
})

describe("versionFromHealth", () => {
  test("reads a top-level version string and trims it", () => {
    expect(versionFromHealth({ version: " 1.18.4 " })).toBe("1.18.4")
  })
  test("falls back to a nested data.version", () => {
    expect(versionFromHealth({ data: { version: "1.18.4" } })).toBe("1.18.4")
  })
  test("prefers the top-level version over the nested one", () => {
    expect(
      versionFromHealth({ version: "1.18.4", data: { version: "9.9.9" } }),
    ).toBe("1.18.4")
  })
  test("returns undefined for missing, blank, or non-string versions", () => {
    expect(versionFromHealth(undefined)).toBeUndefined()
    expect(versionFromHealth(null)).toBeUndefined()
    expect(versionFromHealth({})).toBeUndefined()
    expect(versionFromHealth({ version: "   " })).toBeUndefined()
    expect(versionFromHealth({ version: 118 })).toBeUndefined()
    expect(versionFromHealth({ data: { version: 118 } })).toBeUndefined()
  })
})

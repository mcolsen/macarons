import { describe, expect, test } from "bun:test"
import {
  buildWebsearchOptions,
  collectPluginOptions,
  isConfigurable,
  type Prompter,
  parseYesNo,
  pluginsToConfigure,
  promptWebsearchOptions,
  promptYesNo,
} from "../src/config"
import {
  discoverConfigSources,
  type PluginInfo,
  pluginState,
  type SourceDoc,
  serverEntryUrl,
} from "../src/core"

const websearch: PluginInfo = {
  name: "@macarons/web-search",
  id: "web-search",
  description: "privacy-first web search",
  dir: "/repo/plugins/web-search",
  serverEntry: "/repo/plugins/web-search/src/index.ts",
}
const plain: PluginInfo = {
  name: "@macarons/plain",
  id: "plain",
  description: "plugin without install-time options",
  dir: "/repo/plugins/plain",
  serverEntry: "/repo/plugins/plain/src/index.ts",
}

/** A default-mode inventory with a `plugin` array per config-dir basename. */
function docsFor(byBasename: Record<string, unknown[]>): SourceDoc[] {
  const { sources } = discoverConfigSources({ env: {}, homedir: "/home/x" })
  return sources.map((source) => {
    const base = source.file.split("/").pop() ?? ""
    const entries = source.scope === "config-dir" ? byBasename[base] : undefined
    if (entries === undefined) {
      return { source, text: "", exists: false, hasPluginKey: false, list: [] }
    }
    return {
      source,
      text: JSON.stringify({ plugin: entries }),
      exists: true,
      hasPluginKey: true,
      list: entries,
    }
  })
}

/** An inventory whose config-dir opencode.jsonc lists `entries`. */
function docsWith(entries: unknown[]): SourceDoc[] {
  return docsFor({ "opencode.jsonc": entries })
}

function scriptedPrompter(answers: string[]): {
  prompter: Prompter
  asked: string[]
} {
  const asked: string[] = []
  let index = 0
  return {
    asked,
    prompter: {
      ask: async (text) => {
        asked.push(text)
        return answers[index++] ?? ""
      },
    },
  }
}

describe("isConfigurable", () => {
  test("only web-search offers install-time configuration", () => {
    expect(isConfigurable(websearch)).toBe(true)
    expect(isConfigurable(plain)).toBe(false)
  })
})

describe("pluginsToConfigure", () => {
  test.each([
    "@macarons/websearch/server",
    "npm:@mcolsen-opencode/websearch@0.1.0",
    "file:///repo/plugins/websearch/src/index.ts",
  ])("a renamed install at %s retains options without prompting", (spec) => {
    expect(
      pluginsToConfigure(
        [websearch],
        new Map([[websearch.name, true]]),
        docsWith([
          [spec, { native: { enabled: false }, exa: { enabled: false } }],
        ]),
      ),
    ).toEqual([])
  })

  test("a web-search install going from absent → ticked is offered configuration", () => {
    const result = pluginsToConfigure(
      [plain, websearch],
      new Map([
        [plain.name, true],
        [websearch.name, true],
      ]),
      docsWith([]),
    )
    // plain is ticked too but takes no options; only web-search is prompted.
    expect(result).toEqual([websearch])
  })

  test("an already-installed web-search left ticked is NOT reconfigured", () => {
    // Re-collecting would clobber options the user hand-edited; a repair keeps
    // the existing entry untouched.
    const result = pluginsToConfigure(
      [websearch],
      new Map([[websearch.name, true]]),
      docsWith([serverEntryUrl(websearch) as string]),
    )
    expect(result).toEqual([])
  })

  test("a masked (present but inactive) web-search is still a repair, not a fresh install", () => {
    // config.json lists web-search, but opencode.jsonc's empty `plugin` key masks
    // it — so it is present, not active. `present` (not `active`) gates the
    // prompt, so a merge-masked leftover is repaired without re-prompting.
    const docs = docsFor({
      "config.json": [serverEntryUrl(websearch) as string],
      "opencode.jsonc": [],
    })
    expect(pluginState(docs, websearch)).toMatchObject({
      active: false,
      present: true,
    })
    const result = pluginsToConfigure(
      [websearch],
      new Map([[websearch.name, true]]),
      docs,
    )
    expect(result).toEqual([])
  })

  test("unticking web-search never prompts", () => {
    const result = pluginsToConfigure(
      [websearch],
      new Map([[websearch.name, false]]),
      docsWith([serverEntryUrl(websearch) as string]),
    )
    expect(result).toEqual([])
  })
})

describe("buildWebsearchOptions", () => {
  test("all defaults (blank URL, both backends on) → undefined, so a bare string is written", () => {
    expect(
      buildWebsearchOptions({ searxngUrl: "", native: true, exa: true }),
    ).toBeUndefined()
    // Whitespace-only URL is still "no URL".
    expect(
      buildWebsearchOptions({ searxngUrl: "   ", native: true, exa: true }),
    ).toBeUndefined()
  })

  test("a SearXNG URL is trimmed and nested under searxng.url", () => {
    expect(
      buildWebsearchOptions({
        searxngUrl: "  http://searxng.tailnet:8080  ",
        native: true,
        exa: true,
      }),
    ).toEqual({ searxng: { url: "http://searxng.tailnet:8080" } })
  })

  test("disabling a backend writes only its explicit `enabled: false` opt-out", () => {
    expect(
      buildWebsearchOptions({ searxngUrl: "", native: false, exa: true }),
    ).toEqual({ native: { enabled: false } })
    expect(
      buildWebsearchOptions({ searxngUrl: "", native: true, exa: false }),
    ).toEqual({ exa: { enabled: false } })
  })

  test("every non-default is combined into one options object", () => {
    expect(
      buildWebsearchOptions({
        searxngUrl: "http://sx:8080",
        native: false,
        exa: false,
      }),
    ).toEqual({
      searxng: { url: "http://sx:8080" },
      native: { enabled: false },
      exa: { enabled: false },
    })
  })
})

describe("parseYesNo", () => {
  test("a blank line accepts the fallback, both ways", () => {
    expect(parseYesNo("", true)).toBe(true)
    expect(parseYesNo("   ", false)).toBe(false)
  })

  test("accepts only y/yes and n/no, case-insensitively", () => {
    for (const yes of ["y", "Y", "yes", "YES", " Yes "]) {
      expect(parseYesNo(yes, false)).toBe(true)
    }
    for (const no of ["n", "N", "no", "NO", " No "]) {
      expect(parseYesNo(no, true)).toBe(false)
    }
  })

  test("rejects every other nonblank answer instead of treating typos as no", () => {
    for (const invalid of ["nope", "false", "0", "yeah", "nah"]) {
      expect(parseYesNo(invalid, true)).toBeUndefined()
      expect(parseYesNo(invalid, false)).toBeUndefined()
    }
  })
})

describe("promptYesNo", () => {
  test("explains an invalid answer before asking again", async () => {
    const { prompter, asked } = scriptedPrompter(["definitely", "yes"])
    expect(await promptYesNo(prompter, "Continue? [y/N]: ", false)).toBe(true)
    expect(asked).toEqual([
      "Continue? [y/N]: ",
      "Please answer y or n.\nContinue? [y/N]: ",
    ])
  })
})

describe("promptWebsearchOptions", () => {
  test("asks URL then native then exa, in that fixed order", async () => {
    const { prompter, asked } = scriptedPrompter(["", "", ""])
    await promptWebsearchOptions(prompter)
    expect(asked).toHaveLength(3)
    expect(asked[0]).toMatch(/SearXNG/i)
    expect(asked[1]).toMatch(/native/i)
    expect(asked[2]).toMatch(/Exa/i)
  })

  test("URL set, both toggles left at their default → just the searxng URL", async () => {
    const { prompter } = scriptedPrompter(["http://sx:8080", "", ""])
    expect(await promptWebsearchOptions(prompter)).toEqual({
      searxng: { url: "http://sx:8080" },
    })
  })

  test("declining both backends with no URL → the two opt-outs only", async () => {
    const { prompter } = scriptedPrompter(["", "n", "n"])
    expect(await promptWebsearchOptions(prompter)).toEqual({
      native: { enabled: false },
      exa: { enabled: false },
    })
  })

  test("accepting every default yields no options object at all", async () => {
    const { prompter } = scriptedPrompter(["", "y", "yes"])
    expect(await promptWebsearchOptions(prompter)).toBeUndefined()
  })

  test("invalid backend answers are reprompted instead of becoming no", async () => {
    const { prompter, asked } = scriptedPrompter([
      "",
      "maybe",
      "n",
      "nope",
      "yes",
    ])
    expect(await promptWebsearchOptions(prompter)).toEqual({
      native: { enabled: false },
    })
    expect(asked.filter((question) => /native/i.test(question))).toHaveLength(2)
    expect(asked.filter((question) => /Exa/i.test(question))).toHaveLength(2)
  })
})

describe("collectPluginOptions", () => {
  test("dispatches web-search to its prompt", async () => {
    const { prompter } = scriptedPrompter(["http://sx:8080", "", ""])
    expect(await collectPluginOptions(websearch, prompter)).toEqual({
      searxng: { url: "http://sx:8080" },
    })
  })

  test("a non-configurable plugin returns undefined and never touches the prompter", async () => {
    const { prompter, asked } = scriptedPrompter([])
    expect(await collectPluginOptions(plain, prompter)).toBeUndefined()
    expect(asked).toEqual([])
  })
})

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import {
  type CliRuntime,
  type ClosablePrompter,
  changedHalves,
  createReadlinePrompter,
  parseArgs,
  runCli,
  tildify,
  warnUnmanagedSources,
} from "../src/cli"
import { PromptCancelledError, promptYesNo } from "../src/config"
import {
  type PluginInfo,
  renderEdits,
  SourceConflictError,
  serverEntryUrl,
  writeRenderedEdit,
} from "../src/core"

describe("parseArgs", () => {
  test("an empty argv is a real run against the resolved config dir", () => {
    // The write path is the DEFAULT: --dry-run is the opt-out, so a mutant
    // that flips this default silently turns every invocation into a no-op
    // (or, the other way, makes --dry-run write).
    expect(parseArgs([])).toEqual({
      dryRun: false,
      help: false,
    })
  })

  test("--dry-run turns the run into a preview", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true)
  })

  test("-h and --help both request the usage text", () => {
    expect(parseArgs(["-h"]).help).toBe(true)
    expect(parseArgs(["--help"]).help).toBe(true)
  })

  test("--config-dir takes the next argument as the directory", () => {
    expect(parseArgs(["--config-dir", "/x", "--dry-run"])).toEqual({
      configDir: "/x",
      dryRun: true,
      help: false,
    })
  })

  test("--config-dir at the end of argv throws instead of silently targeting the default dir", () => {
    // Without the guard, `configDir` stays undefined and the installer rewrites
    // the user's real config directory rather than the one they named — a
    // silent wrong target on the one tool in this repo that edits ~/.config.
    expect(() => parseArgs(["--config-dir"])).toThrow(
      /--config-dir needs a directory argument/,
    )
  })

  test("--config-dir --dry-run throws rather than eating the dry-run flag", () => {
    // The shipped bug this guard fixes: `--config-dir --dry-run` used to set
    // configDir="--dry-run" and leave dryRun false, so the user who asked for a
    // preview got real writes plus a relative directory literally named
    // `--dry-run` created under cwd.
    expect(() => parseArgs(["--config-dir", "--dry-run"])).toThrow(
      /--config-dir needs a directory argument/,
    )
    expect(() => parseArgs(["--config-dir", "-h"])).toThrow()
  })

  test("a directory whose name starts with a dash is still reachable as ./-name", () => {
    // The guard rejects VALUES that look like options, not directories that
    // happen to start with `-`; the escape hatch must keep working.
    expect(parseArgs(["--config-dir", "./-dry-run"]).configDir).toBe(
      "./-dry-run",
    )
  })

  test("an unknown option throws and names the option, so a typo never writes", () => {
    // `--dryrun` (a plausible typo for --dry-run) must abort, not fall through
    // to a real write with the flag ignored.
    expect(() => parseArgs(["--dryrun"])).toThrow(/unknown option: --dryrun/)
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option: --nope/)
  })
})

describe("changedHalves", () => {
  test("names only the halves that actually change", () => {
    expect(changedHalves("added", "none")).toBe("server")
    expect(changedHalves("none", "added")).toBe("tui")
    expect(changedHalves("removed", "removed")).toBe("server + tui")
  })

  test("the non-change EntryChange values are not reported as changed", () => {
    // "none" and "unavailable" (the plugin has no such half) must both stay
    // out of the printed plan; otherwise a server-only plugin reads as
    // touching tui.json, which it never does.
    expect(changedHalves("none", "unavailable")).toBe("")
    expect(changedHalves("unavailable", "unavailable")).toBe("")
  })
})

describe("tildify", () => {
  const home = os.homedir()

  test("shortens a path inside the home directory", () => {
    expect(tildify(path.join(home, ".config", "opencode"))).toBe(
      `~${path.sep}.config${path.sep}opencode`,
    )
  })

  test("only replaces the home prefix at a path boundary", () => {
    // A sibling directory that merely starts with the same characters is a
    // DIFFERENT user's home; abbreviating it to `~…` would misreport which
    // file the installer is about to rewrite.
    expect(tildify(`${home}X${path.sep}opencode.json`)).toBe(
      `${home}X${path.sep}opencode.json`,
    )
    expect(tildify(home)).toBe(home)
  })

  test("leaves a path outside the home directory alone", () => {
    expect(tildify(path.join(path.sep, "etc", "opencode.json"))).toBe(
      path.join(path.sep, "etc", "opencode.json"),
    )
  })
})

describe("warnUnmanagedSources", () => {
  const original = console.error
  afterEach(() => {
    console.error = original
  })

  function capture(env: Record<string, string | undefined>): string[] {
    const lines: string[] = []
    console.error = (...parts: unknown[]) => {
      lines.push(parts.map(String).join(" "))
    }
    try {
      warnUnmanagedSources(env)
    } finally {
      console.error = original
    }
    return lines
  }

  test("says nothing when no unmanaged origin is configured", () => {
    expect(capture({})).toEqual([])
  })

  test("OPENCODE_CONFIG_DIR is a MANAGED origin and must not warn", () => {
    // The wizard resolves OPENCODE_CONFIG_DIR itself (resolveConfigDir), so it
    // manages every entry under it. Warning about it would tell the user their
    // ticks do not apply when they do.
    expect(capture({ OPENCODE_CONFIG_DIR: "/somewhere" })).toEqual([])
  })

  test("a whitespace-only value is not a configured source", () => {
    expect(capture({ OPENCODE_CONFIG: "   " })).toEqual([])
  })

  test("one unmanaged origin warns in the singular and names the variable", () => {
    const lines = capture({ OPENCODE_CONFIG: "/tmp/other.json" })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("OPENCODE_CONFIG")
    expect(lines[0]).toContain("that source")
    expect(lines[0]).not.toContain("those sources")
  })

  test("several unmanaged origins are all listed, in the plural", () => {
    // Plugin origins CONCAT across scopes in OpenCode, so entries in these
    // files keep loading after an uninstall the wizard reported as done —
    // every configured one has to be named, not just the first.
    const lines = capture({
      OPENCODE_CONFIG: "/tmp/other.json",
      OPENCODE_CONFIG_CONTENT: "{}",
      OPENCODE_TUI_CONFIG: "/tmp/tui.json",
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("OPENCODE_CONFIG,")
    expect(lines[0]).toContain("OPENCODE_CONFIG_CONTENT")
    expect(lines[0]).toContain("OPENCODE_TUI_CONFIG")
    expect(lines[0]).toContain("those sources")
  })
})

describe("createReadlinePrompter", () => {
  test("queues a corrected answer pasted with an invalid answer", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let printed = ""
    output.on("data", (chunk) => {
      printed += String(chunk)
    })
    const prompter = createReadlinePrompter({ input, output, terminal: false })

    const answer = promptYesNo(prompter, "Continue? [y/N]: ", false)
    input.write("maybe\ny\n")

    expect(await answer).toBe(true)
    expect(printed).toBe(
      "Continue? [y/N]: Please answer y or n.\nContinue? [y/N]: ",
    )
    prompter.close()
  })

  test("Ctrl-C between questions cancels the next question", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const prompter = createReadlinePrompter({ input, output, terminal: true })

    const first = prompter.ask("First: ")
    input.write("answer\n")
    expect(await first).toBe("answer")
    input.write("\x03")

    await expect(prompter.ask("Second: ")).rejects.toBeInstanceOf(
      PromptCancelledError,
    )
    prompter.close()
  })

  test("discarding pre-prompt input clears partial lines in both terminal modes", async () => {
    for (const terminal of [true, false]) {
      const input = new PassThrough()
      const output = new PassThrough()
      const prompter = createReadlinePrompter({ input, output, terminal })
      input.write("y")

      await prompter.discardPendingInput?.()
      const answer = prompter.ask("Continue? [y/N]: ")
      input.write("n\n")

      expect(await answer).toBe("n")
      prompter.close()
    }
  })

  test("terminal edits redraw with the real question instead of the default prompt", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let printed = ""
    output.on("data", (chunk) => {
      printed += String(chunk)
    })
    const prompter = createReadlinePrompter({ input, output, terminal: true })

    const answer = prompter.ask("Continue? [y/N]: ")
    input.write("yn\x7f\n")

    expect(await answer).toBe("y")
    expect(printed).toContain("Continue? [y/N]: ")
    expect(printed).not.toContain("> ")
    prompter.close()
  })
})

describe("runCli confirmation", () => {
  const dirs: string[] = []
  const plugin: PluginInfo = {
    name: "@macarons/plain",
    id: "plain",
    description: "test plugin",
    dir: "/repo/plugins/plain",
    serverEntry: "/repo/plugins/plain/src/index.ts",
  }
  const websearch: PluginInfo = {
    name: "@macarons/web-search",
    id: "web-search",
    description: "privacy-first web search",
    dir: "/repo/plugins/web-search",
    serverEntry: "/repo/plugins/web-search/src/index.ts",
  }

  afterEach(async () => {
    while (dirs.length)
      await fs.rm(dirs.pop() as string, { recursive: true, force: true })
  })

  async function fixture() {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "installer-cli-"))
    dirs.push(home)
    const configDir = path.join(home, "opencode")
    const configFile = path.join(configDir, "opencode.jsonc")
    const original = '{\n  // preserved\n  "model": "provider/model"\n}\n'
    await fs.mkdir(configDir)
    await fs.writeFile(configFile, original)
    return {
      home,
      configDir,
      configFile,
      original,
      output: [] as string[],
      events: [] as string[],
      renderCalls: 0,
      writeCalls: 0,
    }
  }

  function scriptedPrompter(
    answers: string[],
    onAsk?: (text: string) => void | Promise<void>,
  ) {
    const state = { asked: [] as string[], created: 0, closed: 0 }
    let index = 0
    const createPrompter = (): ClosablePrompter => {
      state.created++
      return {
        ask: async (text) => {
          state.asked.push(text)
          const answer = answers[index++]
          if (answer === undefined)
            throw new Error("scripted prompter ran out of answers")
          await onAsk?.(text)
          return answer
        },
        close: () => {
          state.closed++
        },
      }
    }
    return { createPrompter, state }
  }

  function runtime(
    target: Awaited<ReturnType<typeof fixture>>,
    overrides: Partial<CliRuntime> = {},
  ): CliRuntime {
    return {
      argv: ["--config-dir", target.configDir],
      env: {},
      homedir: target.home,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      loadPlugins: async () => [plugin],
      wizard: async () => new Map([[plugin.name, true]]),
      renderPlanEdits: (edits) => {
        target.renderCalls++
        target.events.push("render")
        return renderEdits(edits)
      },
      writeEdit: async (edit, expectedDocs) => {
        target.writeCalls++
        target.events.push("write")
        await writeRenderedEdit(edit, expectedDocs)
      },
      log: (message) => {
        target.output.push(message)
        if (message.includes("Planned changes:")) target.events.push("plan")
        if (message.includes("Files to update:")) target.events.push("files")
      },
      error: (message) => target.output.push(message),
      ...overrides,
    }
  }

  async function expectUnchanged(target: Awaited<ReturnType<typeof fixture>>) {
    expect(target.renderCalls).toBe(0)
    expect(target.writeCalls).toBe(0)
    expect(await fs.readFile(target.configFile, "utf8")).toBe(target.original)
    expect(await fs.readdir(target.configDir)).toEqual(["opencode.jsonc"])
  }

  async function expectSourceConflict(
    target: Awaited<ReturnType<typeof fixture>>,
    operation: Promise<void>,
    changedFile: string,
    editorText: string,
    writeCalls = 0,
  ) {
    let caught: unknown
    try {
      await operation
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(SourceConflictError)
    const message = (caught as Error).message
    expect(message).toContain(path.basename(changedFile))
    expect(message).toMatch(/changed/i)
    expect(message).toMatch(/rerun/i)
    expect(target.renderCalls).toBe(1)
    expect(target.writeCalls).toBe(writeCalls)
    expect(await fs.readFile(changedFile, "utf8")).toBe(editorText)
    expect(
      (await fs.readdir(target.home, { recursive: true })).filter((file) =>
        file.endsWith(".tmp"),
      ),
    ).toEqual([])
    const output = target.output.join("\n")
    expect(output).not.toMatch(/Done|Restart OpenCode/)
    expect(output).not.toMatch(/nothing (?:changed|to change)/i)
  }

  function expectSymlinkRefusal(message: string, file: string) {
    expect(message).toContain(file)
    expect(message).toContain("symlink")
    expect(message).toContain("refusing")
    expect(message).toContain("edit the symlink target directly")
  }

  async function symlinkFixture(
    kind: "server" | "tui",
    extension: "json" | "jsonc",
    installing: boolean,
    linkSpelling: "relative" | "absolute",
  ) {
    const target = await fixture()
    const configName = `${kind === "server" ? "opencode" : "tui"}.${extension}`
    const configFile = path.join(target.configDir, configName)
    const regularName = kind === "server" ? "tui.jsonc" : "opencode.jsonc"
    const regularFile = path.join(target.configDir, regularName)
    const pluginList = installing ? "[]" : '["@macarons/plain"]'
    const linkedBytes =
      (extension === "jsonc" ? "// private dotfile config\n" : "") +
      (kind === "server"
        ? `{"model":"linked","plugin":${pluginList}}\n`
        : `{"theme":"linked","plugin":${pluginList}}\n`)
    const regularBytes =
      kind === "server"
        ? `{"theme":"regular","plugin":${pluginList}}\n`
        : `{"model":"regular","plugin":${pluginList}}\n`
    const linkedTarget = path.join(target.home, `target-${configName}`)

    await fs.rm(target.configFile)
    await fs.writeFile(linkedTarget, linkedBytes)
    await fs.chmod(linkedTarget, 0o600)
    const linkValue =
      linkSpelling === "relative"
        ? path.relative(target.configDir, linkedTarget)
        : linkedTarget
    await fs.symlink(linkValue, configFile)
    await fs.writeFile(regularFile, regularBytes)

    return {
      ...target,
      configFile,
      regularFile,
      regularBytes,
      linkedTarget,
      linkedBytes,
      linkValue,
      expectedFiles: [configName, regularName].sort(),
    }
  }

  function configText(entries: unknown[]): string {
    return `${JSON.stringify({ plugin: entries }, null, 2)}\n`
  }

  test("an explicit yes applies the plan only after it has been printed", async () => {
    const target = await fixture()
    const prompt = scriptedPrompter(["yes"], () => {
      target.events.push("prompt")
    })

    await runCli(runtime(target, { createPrompter: prompt.createPrompter }))

    expect(target.output.join("\n")).toContain("Planned changes:")
    expect(target.output.join("\n")).toContain("Files to update:")
    expect(prompt.state.asked).toEqual(["\nApply these changes? [y/N]: "])
    expect(prompt.state.closed).toBe(1)
    expect(target.events).toEqual([
      "plan",
      "files",
      "prompt",
      "render",
      "write",
    ])
    expect(target.renderCalls).toBe(1)
    expect(target.writeCalls).toBe(1)
    const written = await fs.readFile(target.configFile, "utf8")
    expect(written).not.toBe(target.original)
    expect(written).toContain('"model": "provider/model"')
    expect(written).toContain("plain/src/index.ts")
  })

  test("blank default and explicit no both decline without any write", async () => {
    for (const answer of ["", "n", "no"]) {
      const target = await fixture()
      const prompt = scriptedPrompter([answer])

      await runCli(runtime(target, { createPrompter: prompt.createPrompter }))

      await expectUnchanged(target)
      expect(prompt.state.asked).toHaveLength(1)
      expect(target.output.join("\n")).toContain("Cancelled")
    }
  })

  test("an invalid confirmation reprompts before an explicit yes can write", async () => {
    const target = await fixture()
    const prompt = scriptedPrompter(["yep", "y"])

    await runCli(runtime(target, { createPrompter: prompt.createPrompter }))

    expect(prompt.state.asked).toEqual([
      "\nApply these changes? [y/N]: ",
      "Please answer y or n.\nApply these changes? [y/N]: ",
    ])
    expect(await fs.readFile(target.configFile, "utf8")).toContain(
      "plain/src/index.ts",
    )
  })

  test("EOF and Ctrl-C at confirmation both cancel with zero writes", async () => {
    for (const cancellation of ["EOF", "Ctrl-C", "yes then Ctrl-C"] as const) {
      const target = await fixture()
      let prompts = 0
      const createPrompter = () => {
        prompts++
        const input = new PassThrough()
        const output = new PassThrough()
        const prompter = createReadlinePrompter({
          input,
          output,
          terminal: true,
        })
        queueMicrotask(() => {
          if (cancellation === "EOF") input.end()
          else if (cancellation === "Ctrl-C") input.write("\x03")
          else input.write("yes\n\x03")
        })
        return prompter
      }

      await runCli(runtime(target, { createPrompter }))

      await expectUnchanged(target)
      expect(prompts).toBe(1)
      expect(target.output.join("\n")).toContain("Cancelled")
    }
  })

  test("input entered before the confirmation prompt cannot authorize writes", async () => {
    const target = await fixture()
    const input = new PassThrough()
    const output = new PassThrough()
    let sawPrompt = false
    output.on("data", (chunk) => {
      if (sawPrompt || !String(chunk).includes("Apply these changes?")) return
      sawPrompt = true
      input.write("n\n")
    })
    const createPrompter = () =>
      createReadlinePrompter({ input, output, terminal: false })
    const run = runtime(target, { createPrompter })
    const log = run.log as (message: string) => void
    run.log = (message) => {
      log(message)
      if (message.includes("Files to update:")) input.write("yes\n")
    }

    await runCli(run)

    await expectUnchanged(target)
    expect(sawPrompt).toBe(true)
    expect(target.output.join("\n")).toContain("Cancelled")
  })

  test("SIGINT while the printed plan is awaiting confirmation cancels cleanly", async () => {
    const target = await fixture()
    const prompt = scriptedPrompter(["yes"])
    const signalSource = new EventEmitter()
    const run = runtime(target, {
      createPrompter: prompt.createPrompter,
      signalSource,
    })
    const log = run.log as (message: string) => void
    run.log = (message) => {
      log(message)
      if (message.includes("Files to update:")) signalSource.emit("SIGINT")
    }

    await runCli(run)

    await expectUnchanged(target)
    expect(prompt.state.created).toBe(0)
    expect(target.output.join("\n")).toContain("Cancelled")
    expect(signalSource.listenerCount("SIGINT")).toBe(0)
  })

  test("a pending SIGINT after yes wins before writes begin", async () => {
    const target = await fixture()
    const signalSource = new EventEmitter()
    const prompt = scriptedPrompter(["yes"], () => {
      setImmediate(() => signalSource.emit("SIGINT"))
    })

    await runCli(
      runtime(target, {
        createPrompter: prompt.createPrompter,
        signalSource,
      }),
    )

    await expectUnchanged(target)
    expect(target.output.join("\n")).toContain("Cancelled")
    expect(signalSource.listenerCount("SIGINT")).toBe(0)
  })

  test("a source changed while the wizard is open aborts the stale plan", async () => {
    const target = await fixture()
    const editorText =
      '{\n  // editor change\n  "model": "provider/from-wizard"\n}\n'
    const prompt = scriptedPrompter(["yes"])

    await expectSourceConflict(
      target,
      runCli(
        runtime(target, {
          createPrompter: prompt.createPrompter,
          wizard: async () => {
            await fs.writeFile(target.configFile, editorText)
            return new Map([[plugin.name, true]])
          },
        }),
      ),
      target.configFile,
      editorText,
    )
  })

  test("a source changed during any web-search option prompt aborts", async () => {
    const websearch: PluginInfo = {
      name: "@macarons/web-search",
      id: "web-search",
      description: "test web-search plugin",
      dir: "/repo/plugins/web-search",
      serverEntry: "/repo/plugins/web-search/src/index.ts",
    }
    const stages = [
      { label: "URL", matches: /SearXNG/ },
      { label: "native", matches: /provider-native/ },
      { label: "Exa", matches: /Exa/ },
    ]

    for (const stage of stages) {
      const target = await fixture()
      const editorText = `{\n  // ${stage.label} edit\n  "model": "provider/from-options"\n}\n`
      let mutated = false
      const prompt = scriptedPrompter(
        ["https://search.example", "yes", "yes", "yes"],
        async (question) => {
          if (mutated || !stage.matches.test(question)) return
          mutated = true
          await fs.writeFile(target.configFile, editorText)
        },
      )

      await expectSourceConflict(
        target,
        runCli(
          runtime(target, {
            createPrompter: prompt.createPrompter,
            loadPlugins: async () => [websearch],
            wizard: async () => new Map([[websearch.name, true]]),
          }),
        ),
        target.configFile,
        editorText,
      )
      expect(mutated).toBe(true)
    }
  })

  test("a final-confirmation edit to model and plugins is preserved byte-for-byte", async () => {
    const target = await fixture()
    const editorText = `{
  // editor model comment
  "model": "provider/from-confirmation",
  // editor plugin comment
  "plugin": ["manual-plugin"],
}
`
    const signalSource = new EventEmitter()
    let mutated = false
    const prompt = scriptedPrompter(["yes"], async (question) => {
      if (mutated || !question.includes("Apply these changes?")) return
      mutated = true
      await fs.writeFile(target.configFile, editorText)
    })

    await expectSourceConflict(
      target,
      runCli(
        runtime(target, {
          createPrompter: prompt.createPrompter,
          signalSource,
        }),
      ),
      target.configFile,
      editorText,
    )
    expect(mutated).toBe(true)
    expect(prompt.state.created).toBe(1)
    expect(prompt.state.closed).toBe(prompt.state.created)
    expect(signalSource.listenerCount("SIGINT")).toBe(0)
  })

  test("creating an initially absent inventory file aborts, including an empty file", async () => {
    for (const base of ["opencode.jsonc", "config.json"]) {
      for (const editorText of ["", '{\n  "model": "provider/new-file"\n}\n']) {
        const target = await fixture()
        const createdFile = path.join(target.configDir, base)
        await fs.rm(createdFile, { force: true })
        const prompt = scriptedPrompter(["yes"], async (question) => {
          if (question.includes("Apply these changes?"))
            await fs.writeFile(createdFile, editorText)
        })

        await expectSourceConflict(
          target,
          runCli(runtime(target, { createPrompter: prompt.createPrompter })),
          createdFile,
          editorText,
        )
      }
    }
  })

  test("the preflight checks a later planned destination before any write", async () => {
    const target = await fixture()
    const installed = '{\n  "plugin": ["@macarons/plain"]\n}\n'
    await fs.writeFile(target.configFile, installed)
    const homeConfigDir = path.join(target.home, ".opencode")
    const laterFile = path.join(homeConfigDir, "opencode.json")
    await fs.mkdir(homeConfigDir)
    await fs.writeFile(laterFile, installed)
    const editorText =
      '{\n  // later editor change\n  "plugin": ["@macarons/plain"],\n  "model": "provider/later"\n}\n'
    const prompt = scriptedPrompter(["yes"], async (question) => {
      if (question.includes("Apply these changes?"))
        await fs.writeFile(laterFile, editorText)
    })

    await expectSourceConflict(
      target,
      runCli(
        runtime(target, {
          createPrompter: prompt.createPrompter,
          wizard: async () => new Map([[plugin.name, false]]),
        }),
      ),
      laterFile,
      editorText,
    )
    expect(await fs.readFile(target.configFile, "utf8")).toBe(installed)
  })

  test("the preflight checks an unmodified source that can change install precedence", async () => {
    const target = await fixture()
    const lowerFile = path.join(target.configDir, "opencode.json")
    await fs.writeFile(lowerFile, '{\n  "plugin": ["unrelated"]\n}\n')
    const editorText = `{
  // now the higher-precedence plugin source
  "model": "provider/from-editor",
  "plugin": ["another-unrelated-plugin"],
}
`
    const prompt = scriptedPrompter(["yes"], async (question) => {
      if (question.includes("Apply these changes?"))
        await fs.writeFile(target.configFile, editorText)
    })

    await expectSourceConflict(
      target,
      runCli(runtime(target, { createPrompter: prompt.createPrompter })),
      target.configFile,
      editorText,
    )
    expect(await fs.readFile(lowerFile, "utf8")).toBe(
      '{\n  "plugin": ["unrelated"]\n}\n',
    )
  })

  test.each([
    ["existing", "direct"],
    ["absent", "direct"],
    ["existing", "aliased"],
    ["absent", "aliased"],
  ])(
    "a multi-file apply accepts its own earlier write to an initially %s file in a %s directory",
    async (state, directory) => {
      const target = await fixture()
      if (directory === "aliased") {
        const homeConfigDir = path.join(target.home, ".opencode")
        await fs.rename(target.configDir, homeConfigDir)
        await fs.symlink(homeConfigDir, target.configDir, "dir")
      }
      if (state === "absent") await fs.rm(target.configFile)
      const prompt = scriptedPrompter(["yes"])

      await runCli(
        runtime(target, {
          createPrompter: prompt.createPrompter,
          loadPlugins: async () => [
            { ...plugin, tuiEntry: "/repo/plugins/plain/src/tui.tsx" },
          ],
        }),
      )

      expect(target.writeCalls).toBe(2)
      expect(await fs.readFile(target.configFile, "utf8")).toContain(
        "plain/src/index.ts",
      )
      expect(
        JSON.parse(
          await fs.readFile(path.join(target.configDir, "tui.json"), "utf8"),
        ).plugin,
      ).toEqual(["file:///repo/plugins/plain/src/tui.tsx"])
      expect((await fs.readdir(target.configDir)).sort()).toEqual([
        "opencode.jsonc",
        "tui.json",
      ])
      expect(target.output.join("\n")).toContain("Done. Restart OpenCode")
    },
  )

  test.each([
    ["existing non-target", "opencode.jsonc", "opencode.json"],
    ["absent non-target", "config.json", "opencode.json"],
    ["existing non-target", "opencode.jsonc", "tui.json"],
    ["absent non-target", "config.json", "tui.json"],
    ["already-written destination", "opencode.json", "tui.json"],
    ["later destination", "tui.json", "opencode.json"],
  ])(
    "a changed %s (%s) while staging %s aborts publication",
    async (_label, changedBase, stagedBase) => {
      const target = await fixture()
      const lowerFile = path.join(target.configDir, "opencode.json")
      const original = '{\n  "plugin": ["unrelated"]\n}\n'
      await fs.writeFile(lowerFile, original)
      const changedFile = path.join(target.configDir, changedBase)
      const stagedFile = path.join(target.configDir, stagedBase)
      const editorText = '{ /* editor */ "plugin": ["manual-plugin"] }\n'
      const prompt = scriptedPrompter(["yes"])
      const realWriteFile = fs.writeFile.bind(fs)
      let raced = false
      const write = spyOn(fs, "writeFile").mockImplementation(
        async (...args) => {
          await realWriteFile(...args)
          const file = String(args[0])
          if (!file.startsWith(`${stagedFile}.`) || !file.endsWith(".tmp"))
            return
          raced = true
          await realWriteFile(changedFile, editorText)
        },
      )
      try {
        await expectSourceConflict(
          target,
          runCli(
            runtime(target, {
              createPrompter: prompt.createPrompter,
              loadPlugins: async () => [
                { ...plugin, tuiEntry: "/repo/plugins/plain/src/tui.tsx" },
              ],
            }),
          ),
          changedFile,
          editorText,
          stagedBase === "opencode.json" ? 1 : 2,
        )
      } finally {
        write.mockRestore()
      }

      expect(raced).toBe(true)
      if (stagedBase === "opencode.json") {
        expect(await fs.readFile(lowerFile, "utf8")).toBe(original)
      } else if (changedFile !== lowerFile) {
        expect(JSON.parse(await fs.readFile(lowerFile, "utf8")).plugin).toEqual(
          ["unrelated", "file:///repo/plugins/plain/src/index.ts"],
        )
      }
      if (changedFile !== target.configFile)
        expect(await fs.readFile(target.configFile, "utf8")).toBe(
          target.original,
        )
      expect((await fs.readdir(target.configDir)).sort()).toEqual(
        [...new Set(["opencode.json", "opencode.jsonc", changedBase])].sort(),
      )
    },
  )

  test("dry run prints the plan without prompting or writing", async () => {
    const target = await fixture()
    const prompt = scriptedPrompter([])

    await runCli(
      runtime(target, {
        argv: ["--config-dir", target.configDir, "--dry-run"],
        createPrompter: prompt.createPrompter,
      }),
    )

    await expectUnchanged(target)
    expect(prompt.state.created).toBe(0)
    expect(target.output.join("\n")).toContain("Planned changes:")
    expect(target.output.join("\n")).toContain("Dry run")
  })

  test("a masked JSON web-search tuple is repaired with all saved options and no configuration prompts", async () => {
    const target = await fixture()
    const endpoint = "https://search.internal.invalid/issue-230"
    const savedOptions = {
      searxng: { url: endpoint },
      native: { enabled: false },
      exa: { enabled: false },
    }
    const opencodeJson = path.join(target.configDir, "opencode.json")
    const original = configText([[websearch.name, savedOptions]])
    await Promise.all([
      fs.writeFile(opencodeJson, original),
      fs.writeFile(target.configFile, configText([])),
    ])
    const prompt = scriptedPrompter(["yes"])

    await runCli(
      runtime(target, {
        argv: [],
        env: { XDG_CONFIG_HOME: target.home },
        loadPlugins: async () => [websearch],
        wizard: async () => new Map([[websearch.name, true]]),
        createPrompter: prompt.createPrompter,
      }),
    )

    expect(prompt.state.asked).toEqual(["\nApply these changes? [y/N]: "])
    expect(prompt.state.created).toBe(1)
    expect(target.renderCalls).toBe(1)
    expect(target.writeCalls).toBe(1)
    const repaired = await fs.readFile(target.configFile, "utf8")
    expect(JSON.parse(repaired).plugin).toEqual([
      [serverEntryUrl(websearch), savedOptions],
    ])
    expect(await fs.readFile(opencodeJson, "utf8")).toBe(original)
    expect(target.output.join("\n")).not.toContain(endpoint)

    const repeatPrompt = scriptedPrompter([])
    const writesAfterRepair = target.writeCalls
    await runCli(
      runtime(target, {
        argv: [],
        env: { XDG_CONFIG_HOME: target.home },
        loadPlugins: async () => [websearch],
        wizard: async () => new Map([[websearch.name, true]]),
        createPrompter: repeatPrompt.createPrompter,
      }),
    )
    expect(repeatPrompt.state.created).toBe(0)
    expect(target.writeCalls).toBe(writesAfterRepair)
    expect(await fs.readFile(target.configFile, "utf8")).toBe(repaired)
  })

  test("conflicting masked tuples abort privately before writes and allow retrying with the plugin unticked", async () => {
    const target = await fixture()
    const configJson = path.join(target.configDir, "config.json")
    const opencodeJson = path.join(target.configDir, "opencode.json")
    const privateValues = [
      "https://alpha.internal.invalid/private",
      "alpha-private-marker",
      "https://beta.internal.invalid/private",
      "beta-private-marker",
    ]
    const originals = new Map([
      [
        configJson,
        configText([
          [
            websearch.name,
            {
              searxng: { url: privateValues[0] },
              marker: privateValues[1],
            },
          ],
        ]),
      ],
      [
        opencodeJson,
        configText([
          [
            websearch.name,
            {
              searxng: { url: privateValues[2] },
              marker: privateValues[3],
            },
          ],
        ]),
      ],
      [target.configFile, configText([])],
    ])
    await Promise.all(
      [...originals].map(([file, contents]) => fs.writeFile(file, contents)),
    )
    const prompt = scriptedPrompter([])
    let caught: unknown

    try {
      await runCli(
        runtime(target, {
          argv: [],
          env: { XDG_CONFIG_HOME: target.home },
          loadPlugins: async () => [plugin, websearch],
          wizard: async () =>
            new Map([
              [plugin.name, true],
              [websearch.name, true],
            ]),
          createPrompter: prompt.createPrompter,
        }),
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    const message = caught instanceof Error ? caught.message : String(caught)
    expect(message).toContain("conflicting masked declarations")
    expect(message).toContain("web-search")
    expect(message).toContain("server")
    expect(message).toContain(configJson)
    expect(message).toContain(opencodeJson)
    expect(message).toMatch(/make .*declarations identical/i)
    expect(message).toContain(
      "rerun the wizard and untick web-search to remove all of its entries instead",
    )
    expect(message).toContain("no files were changed")
    expect(prompt.state.created).toBe(0)
    expect(target.renderCalls).toBe(0)
    expect(target.writeCalls).toBe(0)
    expect(target.output.join("\n")).not.toContain("Planned changes:")
    for (const value of privateValues) {
      expect(message).not.toContain(value)
      expect(target.output.join("\n")).not.toContain(value)
    }
    for (const [file, contents] of originals) {
      expect(await fs.readFile(file, "utf8")).toBe(contents)
    }

    const retryPrompt = scriptedPrompter(["yes"])
    await runCli(
      runtime(target, {
        argv: [],
        env: { XDG_CONFIG_HOME: target.home },
        loadPlugins: async () => [plugin, websearch],
        wizard: async () =>
          new Map([
            [plugin.name, true],
            [websearch.name, false],
          ]),
        createPrompter: retryPrompt.createPrompter,
      }),
    )

    expect(retryPrompt.state.asked).toEqual(["\nApply these changes? [y/N]: "])
    expect(target.renderCalls).toBe(1)
    expect(target.writeCalls).toBe(3)
    for (const file of [configJson, opencodeJson]) {
      expect(JSON.parse(await fs.readFile(file, "utf8")).plugin).toEqual([])
    }
    expect(
      JSON.parse(await fs.readFile(target.configFile, "utf8")).plugin,
    ).toEqual([serverEntryUrl(plugin)])
    for (const value of privateValues) {
      expect(target.output.join("\n")).not.toContain(value)
    }
  })

  test("a noninteractive dry run remains status-only and never selects or prompts", async () => {
    const target = await fixture()
    const prompt = scriptedPrompter([])
    let wizardCalls = 0

    await runCli(
      runtime(target, {
        argv: ["--config-dir", target.configDir, "--dry-run"],
        stdinIsTTY: false,
        wizard: async () => {
          wizardCalls++
          return new Map([[plugin.name, true]])
        },
        createPrompter: prompt.createPrompter,
      }),
    )

    await expectUnchanged(target)
    expect(wizardCalls).toBe(0)
    expect(prompt.state.created).toBe(0)
    expect(target.output.join("\n")).toContain("Current plugin status:")
    expect(target.output.join("\n")).toContain("interactive terminal")
  })

  test("redirected stdout uses the safe status-only path", async () => {
    const target = await fixture()
    const prompt = scriptedPrompter([])
    let wizardCalls = 0

    await runCli(
      runtime(target, {
        stdoutIsTTY: false,
        wizard: async () => {
          wizardCalls++
          return new Map([[plugin.name, true]])
        },
        createPrompter: prompt.createPrompter,
      }),
    )

    await expectUnchanged(target)
    expect(wizardCalls).toBe(0)
    expect(prompt.state.created).toBe(0)
    expect(target.output.join("\n")).toContain("Current plugin status:")
  })

  for (const { kind, extension, installing } of [
    { kind: "server", extension: "json", installing: true },
    { kind: "server", extension: "json", installing: false },
    { kind: "server", extension: "jsonc", installing: true },
    { kind: "server", extension: "jsonc", installing: false },
    { kind: "tui", extension: "json", installing: true },
    { kind: "tui", extension: "json", installing: false },
    { kind: "tui", extension: "jsonc", installing: true },
    { kind: "tui", extension: "jsonc", installing: false },
  ] as const) {
    for (const linkSpelling of ["relative", "absolute"] as const) {
      test(`${installing ? "install" : "uninstall"} refuses ${linkSpelling} symlinks for ${kind} ${extension} configs`, async () => {
        const target = await symlinkFixture(
          kind,
          extension,
          installing,
          linkSpelling,
        )
        let wizardCalls = 0
        const previousExitCode = process.exitCode ?? 0
        process.exitCode = 0
        try {
          await runCli(
            runtime(target, {
              loadPlugins: async () => [
                { ...plugin, tuiEntry: "/repo/plugins/plain/src/tui.tsx" },
              ],
              wizard: async () => {
                wizardCalls++
                return new Map([[plugin.name, installing]])
              },
            }),
          )

          expect(Number(process.exitCode)).toBe(1)
        } finally {
          process.exitCode = previousExitCode
        }

        expect(wizardCalls).toBe(0)
        expect(target.renderCalls).toBe(0)
        expect(target.writeCalls).toBe(0)
        expectSymlinkRefusal(target.output.join("\n"), target.configFile)
        expect(await fs.readlink(target.configFile)).toBe(target.linkValue)
        expect(await fs.readFile(target.linkedTarget, "utf8")).toBe(
          target.linkedBytes,
        )
        expect(await fs.readFile(target.regularFile, "utf8")).toBe(
          target.regularBytes,
        )
        expect((await fs.readdir(target.configDir)).sort()).toEqual(
          target.expectedFiles,
        )
        if (process.platform !== "win32")
          expect((await fs.stat(target.linkedTarget)).mode & 0o777).toBe(0o600)
      })
    }
  }

  test("dry runs and status checks refuse linked configs before their alternate paths", async () => {
    for (const mode of ["dry-run", "status"] as const) {
      const target = await symlinkFixture("tui", "jsonc", true, "absolute")
      let wizardCalls = 0
      const previousExitCode = process.exitCode ?? 0
      process.exitCode = 0
      try {
        await runCli(
          runtime(target, {
            argv:
              mode === "dry-run"
                ? ["--config-dir", target.configDir, "--dry-run"]
                : ["--config-dir", target.configDir],
            stdinIsTTY: mode !== "status",
            wizard: async () => {
              wizardCalls++
              return new Map([[plugin.name, true]])
            },
          }),
        )

        expect(Number(process.exitCode)).toBe(1)
      } finally {
        process.exitCode = previousExitCode
      }

      expect(wizardCalls).toBe(0)
      expect(target.renderCalls).toBe(0)
      expect(target.writeCalls).toBe(0)
      expectSymlinkRefusal(target.output.join("\n"), target.configFile)
      expect(await fs.readlink(target.configFile)).toBe(target.linkValue)
      expect(await fs.readFile(target.regularFile, "utf8")).toBe(
        target.regularBytes,
      )
    }
  })

  test("a dangling linked config is refused without creating its target", async () => {
    const target = await symlinkFixture("server", "jsonc", true, "absolute")
    await fs.rm(target.linkedTarget)
    const previousExitCode = process.exitCode ?? 0
    process.exitCode = 0
    try {
      await runCli(runtime(target))
      expect(Number(process.exitCode)).toBe(1)
    } finally {
      process.exitCode = previousExitCode
    }

    expect(target.renderCalls).toBe(0)
    expect(target.writeCalls).toBe(0)
    expectSymlinkRefusal(target.output.join("\n"), target.configFile)
    expect(await fs.readlink(target.configFile)).toBe(target.linkValue)
    await expect(fs.lstat(target.linkedTarget)).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(await fs.readFile(target.regularFile, "utf8")).toBe(
      target.regularBytes,
    )
    expect((await fs.readdir(target.configDir)).sort()).toEqual(
      target.expectedFiles,
    )
  })

  test.each(["destination", "non-target"])(
    "a %s link introduced during confirmation aborts all writes before the earlier edit",
    async (location) => {
      const target = await fixture()
      const earlyFile = path.join(target.configDir, "config.json")
      const changedFile =
        location === "destination"
          ? target.configFile
          : path.join(target.configDir, "tui.jsonc")
      const linkedTarget = path.join(target.home, "late-opencode-target.jsonc")
      const earlyBytes = '{"plugin":["@macarons/plain"]}\n'
      const lateBytes =
        location === "destination" ? earlyBytes : '{"theme":"unchanged"}\n'
      await fs.writeFile(earlyFile, earlyBytes)
      await fs.writeFile(target.configFile, earlyBytes)
      if (location === "non-target") await fs.writeFile(changedFile, lateBytes)
      await fs.writeFile(linkedTarget, lateBytes)
      const prompt = scriptedPrompter(["yes"], async () => {
        await fs.rm(changedFile)
        await fs.symlink(linkedTarget, changedFile)
      })

      const signalSource = new EventEmitter()
      const previousExitCode = process.exitCode ?? 0
      process.exitCode = 0
      try {
        await runCli(
          runtime(target, {
            createPrompter: prompt.createPrompter,
            wizard: async () => new Map([[plugin.name, false]]),
            signalSource,
          }),
        )

        expect(Number(process.exitCode)).toBe(1)
      } finally {
        process.exitCode = previousExitCode
      }

      expect(target.output.join("\n")).toContain(
        "Cannot read your OpenCode config:",
      )
      expectSymlinkRefusal(target.output.join("\n"), changedFile)
      expect(prompt.state.closed).toBe(1)
      expect(signalSource.listenerCount("SIGINT")).toBe(0)
      expect(target.writeCalls).toBe(0)
      expect(await fs.readFile(earlyFile, "utf8")).toBe(earlyBytes)
      expect(await fs.readlink(changedFile)).toBe(linkedTarget)
      expect(await fs.readFile(linkedTarget, "utf8")).toBe(lateBytes)
      expect((await fs.readdir(target.configDir)).sort()).toEqual(
        [
          ...new Set([
            "config.json",
            "opencode.jsonc",
            path.basename(changedFile),
          ]),
        ].sort(),
      )
    },
  )

  test("a link introduced mid-sweep stops writes without rolling back earlier files", async () => {
    const target = await fixture()
    const earlyFile = path.join(target.configDir, "config.json")
    const linkedTarget = path.join(target.home, "late-opencode-target.jsonc")
    const original = '{"plugin":["@macarons/plain"]}\n'
    await fs.writeFile(earlyFile, original)
    await fs.writeFile(target.configFile, original)
    await fs.writeFile(linkedTarget, original)
    await fs.chmod(linkedTarget, 0o600)
    const prompt = scriptedPrompter(["yes"])

    await expect(
      runCli(
        runtime(target, {
          createPrompter: prompt.createPrompter,
          wizard: async () => new Map([[plugin.name, false]]),
          writeEdit: async (edit, expectedDocs) => {
            target.writeCalls++
            await writeRenderedEdit(edit, expectedDocs)
            if (edit.doc.source.file === earlyFile) {
              // Introduce the link after the first publication, before the next.
              await fs.rm(target.configFile)
              await fs.symlink(linkedTarget, target.configFile)
            }
          },
        }),
      ),
    ).rejects.toThrow(
      `${target.configFile} is a symlink; refusing to replace it`,
    )

    expect(target.writeCalls).toBe(2)
    expect(JSON.parse(await fs.readFile(earlyFile, "utf8"))).toEqual({
      plugin: [],
    })
    expect(await fs.readlink(target.configFile)).toBe(linkedTarget)
    expect(await fs.readFile(linkedTarget, "utf8")).toBe(original)
    if (process.platform !== "win32")
      expect((await fs.stat(linkedTarget)).mode & 0o777).toBe(0o600)
    expect((await fs.readdir(target.configDir)).sort()).toEqual([
      "config.json",
      "opencode.jsonc",
    ])
    expect(target.output.join("\n")).not.toContain("Done.")
  })
})

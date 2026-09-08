#!/usr/bin/env bun
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import {
  collectPluginOptions,
  PromptCancelledError,
  type Prompter,
  pluginsToConfigure,
  promptYesNo,
} from "./config"
import {
  assertSourceDocsUnchanged,
  buildPlan,
  type ConfigSources,
  discoverConfigSources,
  discoverPlugins,
  type Plan,
  type PluginInfo,
  type PluginOptions,
  pluginState,
  readSourceDocs,
  renderEdits,
  SourceConflictError,
  type SourceDoc,
  writeRenderedEdit,
} from "./core"
import { runWizard, type WizardRow } from "./wizard"

const REPO_ROOT = path.resolve(import.meta.dir, "../../..")

const USAGE = `Macarons plugin installer — tick/untick plugins; your user-level OpenCode config is updated to match.

Usage: bun setup [options]

Options:
  --config-dir <dir>   Use this OpenCode config directory instead of the
                       resolved user-level one (OPENCODE_CONFIG_DIR →
                       $XDG_CONFIG_HOME/opencode → ~/.config/opencode).
                       Behaves exactly like OPENCODE_CONFIG_DIR: it replaces
                       the default directory.
  --dry-run            Show what would change without writing any file.
  -h, --help           Show this help.

Ticking a plugin adds its server half to the config-dir opencode config and
its TUI half to tui.json; unticking removes its entries from EVERY config file
OpenCode loads plugins from at the user level (the config dir's
config.json/opencode.json/opencode.jsonc and tui.json/tui.jsonc, plus
~/.opencode's opencode.json/opencode.jsonc and tui.json/tui.jsonc), so no
active origin is left behind. Restart OpenCode afterwards to load changes.`

export type Args = { configDir?: string; dryRun: boolean; help: boolean }

type Printer = (message: string) => void

export function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "-h" || arg === "--help") args.help = true
    else if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--config-dir") {
      const value = argv[++i]
      // Reject an option as the value, not just a missing one. `--config-dir
      // --dry-run` would otherwise consume the flag as the directory and leave
      // dryRun false — a real write after the user asked for a dry run, into a
      // relative directory literally named `--dry-run`. A directory whose name
      // genuinely starts with `-` is still reachable as `./-name`.
      if (!value || value.startsWith("-"))
        throw new Error("--config-dir needs a directory argument")
      args.configDir = value
    } else throw new Error(`unknown option: ${arg}`)
  }
  return args
}

export function changedHalves(server: string, tui: string): string {
  const halves: string[] = []
  if (server === "added" || server === "removed") halves.push("server")
  if (tui === "added" || tui === "removed") halves.push("tui")
  return halves.join(" + ")
}

function printPlan(plan: Plan, options: PluginOptions, print: Printer): void {
  print("\nPlanned changes:")
  for (const entry of plan.perPlugin) {
    const installing = entry.server === "added" || entry.tui === "added"
    const removing = entry.server === "removed" || entry.tui === "removed"
    if (!installing && !removing) continue
    const mark = installing ? "+ install" : "- remove "
    print(
      `  ${mark}  ${entry.plugin.id}  (${changedHalves(entry.server, entry.tui)})`,
    )
    // Show the configuration a freshly-installed plugin carries, so the user
    // sees the SearXNG URL / toggles before confirming the write.
    const opts = options.get(entry.plugin.name)
    if (installing && opts)
      print(`             options: ${JSON.stringify(opts)}`)
  }
  print("\nFiles to update:")
  for (const edit of plan.edits) {
    if (!edit.changed) continue
    const kind = edit.doc.source.kind === "server" ? "server" : "tui   "
    print(`  ${kind} → ${edit.doc.source.file}`)
  }
}

/** Shorten a path for display: the home dir prefix becomes `~`. */
export function tildify(file: string): string {
  const home = os.homedir()
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file
}

function printStatus(
  plugins: PluginInfo[],
  docs: SourceDoc[],
  print: Printer,
): void {
  print("Current plugin status:")
  let leftovers = false
  for (const plugin of plugins) {
    const state = pluginState(docs, plugin)
    let label = "[   -     ]"
    if (state.active) label = "[installed]"
    else if (state.present) {
      label = "[inactive ]"
      leftovers = true
    }
    print(`  ${label}  ${plugin.id}  — ${plugin.description}`)
    // Say where the leftover entries live, so a non-interactive run is actionable.
    if (!state.active && state.present) {
      print(`               entries in ${state.files.map(tildify).join(", ")}`)
    }
  }
  if (leftovers) {
    print(
      "\n  inactive: config entries exist but OpenCode would not load them.",
    )
    print(
      "  Tick the plugin to repair the install, or untick it to sweep the entries.",
    )
  }
}

// Plugin entries can also come from sources this user-level wizard does not
// manage; say so instead of silently ignoring them.
export function warnUnmanagedSources(
  env: Record<string, string | undefined>,
  print: Printer = (message) => console.error(message),
): void {
  const flags = [
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_TUI_CONFIG",
  ].filter((name) => env[name]?.trim())
  if (!flags.length) return
  const label = flags.length === 1 ? "that source" : "those sources"
  print(
    `note: ${flags.join(", ")} is set; plugin entries in ${label} are not managed by this wizard.`,
  )
}

export type ClosablePrompter = Prompter & {
  close(): void
  discardPendingInput?(): Promise<void>
}

type SigintSource = {
  on(event: "SIGINT", listener: () => void): unknown
  off(event: "SIGINT", listener: () => void): unknown
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** A readline-backed prompter that turns EOF and Ctrl-C into cancellation. */
export function createReadlinePrompter(
  options: {
    input?: NodeJS.ReadableStream
    output?: NodeJS.WritableStream
    terminal?: boolean
  } = {},
): ClosablePrompter {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const terminal =
    options.terminal ??
    Boolean((output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY)
  const inputState = input as NodeJS.ReadableStream & {
    destroyed?: boolean
    readableEnded?: boolean
  }
  const queued: string[] = []
  let waiter:
    | { resolve: (answer: string) => void; reject: (error: Error) => void }
    | undefined
  let closed = false
  let disposed = false
  let interrupted = false
  let rl: readline.Interface | undefined

  const rejectWaiter = () => {
    const pending = waiter
    waiter = undefined
    pending?.reject(new PromptCancelledError())
  }
  const openReadline = () => {
    const current = readline.createInterface({ input, output, terminal })
    current.on("line", (answer) => {
      if (current !== rl) return
      const pending = waiter
      if (!pending) {
        queued.push(answer)
        return
      }
      waiter = undefined
      // readline emits every line and a following SIGINT from one input chunk
      // synchronously. Settle afterward so cancellation wins over `yes\n^C`.
      queueMicrotask(() => {
        if (disposed || interrupted) pending.reject(new PromptCancelledError())
        else pending.resolve(answer)
      })
    })
    current.on("SIGINT", () => {
      if (current !== rl) return
      interrupted = true
      queued.length = 0
      rejectWaiter()
      current.close()
    })
    current.once("close", () => {
      if (current !== rl) return
      closed = true
      rejectWaiter()
    })
    return current
  }
  rl = openReadline()

  return {
    ask: (text) => {
      if (disposed || interrupted)
        return Promise.reject(new PromptCancelledError())
      if (waiter)
        return Promise.reject(
          new Error("readline prompter only supports one active question"),
        )

      const current = rl
      if (!current) return Promise.reject(new PromptCancelledError())
      if (closed) output.write(text)
      else {
        current.setPrompt(text)
        current.prompt()
      }
      const answer = queued.shift()
      if (answer !== undefined)
        return new Promise((resolve, reject) => {
          queueMicrotask(() => {
            if (disposed || interrupted) reject(new PromptCancelledError())
            else resolve(answer)
          })
        })
      if (closed || inputState.readableEnded || inputState.destroyed)
        return Promise.reject(new PromptCancelledError())

      return new Promise<string>((resolve, reject) => {
        waiter = { resolve, reject }
      })
    },
    discardPendingInput: async () => {
      if (disposed || interrupted) throw new PromptCancelledError()
      if (waiter)
        throw new Error("cannot discard input while a question is active")

      // A fresh readline interface resumes stdin asynchronously. Give buffered
      // pre-prompt bytes time to become queued lines, then drop them before the
      // confirmation prompt is armed.
      await nextEventLoopTurn()
      queued.length = 0
      if (
        disposed ||
        interrupted ||
        closed ||
        inputState.readableEnded ||
        inputState.destroyed
      )
        throw new PromptCancelledError()

      // Closing and reopening also discards readline's partial line buffer,
      // which is not exposed when stdout is redirected (`terminal: false`).
      const current = rl
      if (!current) throw new PromptCancelledError()
      if (terminal && current.line) {
        current.write(null, { ctrl: true, name: "a" })
        current.write(null, { ctrl: true, name: "k" })
      }
      rl = undefined
      current.close()
      closed = false
      rl = openReadline()
    },
    close: () => {
      if (disposed) return
      disposed = true
      queued.length = 0
      rejectWaiter()
      const current = rl
      rl = undefined
      current?.close()
    },
  }
}

function abortablePrompter(
  createPrompter: () => ClosablePrompter,
  signal: AbortSignal,
): ClosablePrompter {
  if (signal.aborted) throw new PromptCancelledError()
  const prompter = createPrompter()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    prompter.close()
  }

  const wrapped: ClosablePrompter = {
    ask: (text) => {
      if (signal.aborted) {
        close()
        return Promise.reject(new PromptCancelledError())
      }
      return new Promise<string>((resolve, reject) => {
        let settled = false
        const finish = (callback: () => void) => {
          if (settled) return
          settled = true
          signal.removeEventListener("abort", onAbort)
          callback()
        }
        const onAbort = () =>
          finish(() => {
            close()
            reject(new PromptCancelledError())
          })

        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) {
          onAbort()
          return
        }
        try {
          prompter.ask(text).then(
            (answer) => finish(() => resolve(answer)),
            (error) => finish(() => reject(error)),
          )
        } catch (error) {
          finish(() => reject(error))
        }
      })
    },
    close,
  }
  if (prompter.discardPendingInput) {
    wrapped.discardPendingInput = async () => {
      if (signal.aborted) throw new PromptCancelledError()
      await prompter.discardPendingInput?.()
      if (signal.aborted) {
        close()
        throw new PromptCancelledError()
      }
    }
  }
  return wrapped
}

/**
 * Prompt for the install-time options of every plugin going from absent →
 * ticked that takes them, returning a name → options map for `buildPlan`.
 * Nothing is prompted when no such plugin is selected, so a plain install keeps
 * its short "tick, review, confirm" flow. Only the config dir the caller
 * resolved matters here; the docs decide which plugins are fresh installs.
 */
async function collectOptions(
  plugins: PluginInfo[],
  selection: Map<string, boolean>,
  docs: SourceDoc[],
  createPrompter: () => ClosablePrompter,
  print: Printer,
): Promise<PluginOptions> {
  const options: PluginOptions = new Map()
  const toConfigure = pluginsToConfigure(plugins, selection, docs)
  if (!toConfigure.length) return options
  const prompter = createPrompter()
  try {
    for (const plugin of toConfigure) {
      print(`\nConfigure ${plugin.id} (enter accepts each default):`)
      options.set(plugin.name, await collectPluginOptions(plugin, prompter))
    }
  } finally {
    prompter.close()
  }
  return options
}

async function confirmPlan(
  createPrompter: () => ClosablePrompter,
): Promise<boolean> {
  const prompter = createPrompter()
  try {
    await prompter.discardPendingInput?.()
    return await promptYesNo(prompter, "\nApply these changes? [y/N]: ", false)
  } finally {
    prompter.close()
  }
}

export type CliRuntime = {
  argv?: string[]
  env?: Record<string, string | undefined>
  homedir?: string
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
  repoRoot?: string
  loadPlugins?: typeof discoverPlugins
  wizard?: typeof runWizard
  createPrompter?: () => ClosablePrompter
  renderPlanEdits?: typeof renderEdits
  writeEdit?: typeof writeRenderedEdit
  signalSource?: SigintSource
  log?: Printer
  error?: Printer
}

export async function runCli(runtime: CliRuntime = {}): Promise<void> {
  const argv = runtime.argv ?? process.argv.slice(2)
  const env = runtime.env ?? process.env
  const homedir = runtime.homedir ?? os.homedir()
  const stdinIsTTY = runtime.stdinIsTTY ?? Boolean(process.stdin.isTTY)
  const stdoutIsTTY = runtime.stdoutIsTTY ?? Boolean(process.stdout.isTTY)
  const repoRoot = runtime.repoRoot ?? REPO_ROOT
  const loadPlugins = runtime.loadPlugins ?? discoverPlugins
  const wizard = runtime.wizard ?? runWizard
  const createPrompter = runtime.createPrompter ?? createReadlinePrompter
  const renderPlanEdits = runtime.renderPlanEdits ?? renderEdits
  const writeEdit = runtime.writeEdit ?? writeRenderedEdit
  const signalSource = runtime.signalSource ?? process
  const log = runtime.log ?? ((message) => console.log(message))
  const error = runtime.error ?? ((message) => console.error(message))

  const args = parseArgs(argv)
  if (args.help) {
    log(USAGE)
    return
  }

  const plugins = await loadPlugins(repoRoot)
  if (!plugins.length) {
    error(
      `No installable plugins found under ${path.join(repoRoot, "plugins")}.`,
    )
    process.exitCode = 1
    return
  }

  const sources: ConfigSources = discoverConfigSources({
    env,
    homedir,
    configDirOverride: args.configDir,
  })
  warnUnmanagedSources(env, error)

  let docs: SourceDoc[]
  try {
    docs = await readSourceDocs(sources.sources)
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught)
    error(`Cannot read your OpenCode config: ${reason}`)
    process.exitCode = 1
    return
  }

  // No terminal to tick in — report status and how to change it, don't guess.
  if (!stdinIsTTY || !stdoutIsTTY) {
    printStatus(plugins, docs, log)
    log("\nRun this from an interactive terminal to tick plugins on or off.")
    return
  }

  const rows: WizardRow[] = plugins.map((plugin) => {
    // `present` (not just active) drives the checkbox: a masked leftover
    // entry unticks to a full sweep and ticks to a repair.
    const installed = pluginState(docs, plugin).present
    return { plugin, installed, selected: installed }
  })

  const cancellation = new AbortController()
  const onInterrupt = () => cancellation.abort()
  let listeningForInterrupt = true
  const stopListeningForInterrupt = () => {
    if (!listeningForInterrupt) return
    listeningForInterrupt = false
    signalSource.off("SIGINT", onInterrupt)
  }
  signalSource.on("SIGINT", onInterrupt)

  try {
    const selection = await wizard(rows, {
      title: "Macarons plugin installer",
      configDir: sources.configDir,
      signal: cancellation.signal,
    })
    if (!selection) {
      log("Cancelled — nothing changed.")
      return
    }
    if (cancellation.signal.aborted) throw new PromptCancelledError()

    // A freshly-ticked configurable plugin (web-search) is configured here,
    // after the checkbox list closes and before the plan is built, so its
    // options ride the entry the plan writes. Existing installs are untouched.
    const options: PluginOptions = await collectOptions(
      plugins,
      selection,
      docs,
      () => abortablePrompter(createPrompter, cancellation.signal),
      log,
    )
    if (cancellation.signal.aborted) throw new PromptCancelledError()

    const plan = buildPlan(plugins, selection, docs, options)
    if (!plan.changed) {
      log("Already up to date — nothing to change.")
      return
    }

    printPlan(plan, options, log)
    if (cancellation.signal.aborted) throw new PromptCancelledError()

    if (args.dryRun) {
      log("\nDry run — no files written.")
      return
    }

    if (
      !(await confirmPlan(() =>
        abortablePrompter(createPrompter, cancellation.signal),
      ))
    ) {
      log("\nCancelled — nothing changed.")
      return
    }
    if (cancellation.signal.aborted) throw new PromptCancelledError()

    // Let a native SIGINT already pending behind the accepted line reach the
    // scoped handler before it is removed and writes become possible.
    await nextEventLoopTurn()
    if (cancellation.signal.aborted) throw new PromptCancelledError()

    // Confirmation is complete; restore normal SIGINT behavior before any
    // rendering or writes begin rather than swallowing an interrupt mid-write.
    stopListeningForInterrupt()

    // Two-pass write: render + validate EVERY changed file first, then write.
    // An installer-bug render aborts here with zero files touched instead of
    // leaving the sweep applied to some origins and not others. (A failure
    // mid-write can still leave a partial sweep; after resolving the cause,
    // re-running recomputes from disk and finishes it.)
    const rendered = renderPlanEdits(plan.edits)
    // Every source affects the plan's origins and install targets, even when
    // it is absent or not rewritten. Detect stale plans before the first write.
    try {
      await assertSourceDocsUnchanged(docs)
    } catch (caught) {
      if (caught instanceof SourceConflictError) throw caught
      const reason = caught instanceof Error ? caught.message : String(caught)
      error(`Cannot read your OpenCode config: ${reason}`)
      process.exitCode = 1
      return
    }
    // Resolve directory aliases, not the destination itself: rename replaces
    // a final symlink rather than its target. Missing directories may be created.
    let expectedDocs = await Promise.all(
      docs.map(async ({ source, text, exists }) => {
        let directory = path.dirname(source.file)
        let suffix = path.basename(source.file)
        while (true) {
          try {
            const identity = path.join(await fs.realpath(directory), suffix)
            return { source, text, exists, identity }
          } catch (error) {
            const parent = path.dirname(directory)
            if (
              (error as NodeJS.ErrnoException).code !== "ENOENT" ||
              parent === directory
            )
              throw new SourceConflictError(source.file, error)
            suffix = path.join(path.basename(directory), suffix)
            directory = parent
          }
        }
      }),
    )
    for (const edit of rendered) {
      await writeEdit(edit, expectedDocs)
      // Keep checking every source, comparing earlier writes to our output
      // rather than the original text. Never adopt a fresh read as the baseline.
      const identity = expectedDocs.find(
        (doc) => doc.source.file === edit.doc.source.file,
      )?.identity
      expectedDocs = expectedDocs.map((doc) =>
        doc.identity === identity
          ? { ...doc, text: edit.output, exists: true }
          : doc,
      )
    }

    log("\nDone. Restart OpenCode to load the changes.")
    log(
      "These plugins load from this checkout, so keep it in place and run `bun install` here once.",
    )
  } catch (caught) {
    if (!(caught instanceof PromptCancelledError)) throw caught
    log("\nCancelled — nothing changed.")
  } finally {
    stopListeningForInterrupt()
  }
}

// Only run when executed as the entry point. Without this guard, importing
// anything from this module — as the tests do — runs the real installer
// against the developer's own OpenCode config.
if (import.meta.main) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

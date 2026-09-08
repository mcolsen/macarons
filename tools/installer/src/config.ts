import type { PluginInfo, SourceDoc } from "./core"
import { pluginState } from "./core"

/**
 * Install-time plugin configuration.
 *
 * Only the web-search plugin takes options today, so its prompts are spelled out
 * here rather than declared generically — the installer stays a bare checkbox
 * list for every other plugin. The pure builder (`buildWebsearchOptions`) maps
 * answers to the minimal options object and is unit tested; the interactive
 * runner is a thin wrapper over an injectable `Prompter`, so the question flow
 * is testable without a terminal.
 *
 * The plugin validates and defaults everything itself at load time
 * (`resolveServerOptions`), so this layer only has to COLLECT values, never
 * re-validate them; it writes only what differs from a default.
 */

/** The one plugin id whose install offers configuration prompts. */
const WEBSEARCH_ID = "web-search"

/** Does this plugin offer install-time configuration? */
export function isConfigurable(plugin: PluginInfo): boolean {
  return plugin.id === WEBSEARCH_ID
}

/**
 * The plugins a run should prompt to configure: those going from absent →
 * ticked that also take options. An already-present plugin left ticked is a
 * repair, not a fresh install, so its options are never re-collected (which
 * would clobber values the user hand-edited); an unticked plugin is on its way
 * out. Ordered as `plugins` is, so prompts follow the checkbox order.
 */
export function pluginsToConfigure(
  plugins: PluginInfo[],
  selection: Map<string, boolean>,
  docs: SourceDoc[],
): PluginInfo[] {
  return plugins.filter(
    (plugin) =>
      Boolean(selection.get(plugin.name)) &&
      isConfigurable(plugin) &&
      !pluginState(docs, plugin).present,
  )
}

export type WebsearchAnswers = {
  /** SearXNG base URL; blank leaves the SearXNG backend out entirely. */
  searxngUrl: string
  /** Allow the active provider's native web search (default on). */
  native: boolean
  /** Allow the Exa last-resort call (default on). */
  exa: boolean
}

/**
 * Assemble the `[spec, options]` payload from install answers. Only values that
 * DIFFER from the plugin's own defaults are written — a blank URL omits
 * `searxng`, and a still-enabled backend omits its key — so accepting every
 * default yields `undefined` and the installer writes a bare string entry,
 * byte-identical to a no-config install. `resolveServerOptions` fills the rest.
 */
export function buildWebsearchOptions(
  answers: WebsearchAnswers,
): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = {}
  const url = answers.searxngUrl.trim()
  if (url) options.searxng = { url }
  // native/exa default to enabled, so only an explicit opt-OUT needs writing.
  // The plugin reads any non-`true` value as disabled; `false` is the token.
  if (!answers.native) options.native = { enabled: false }
  if (!answers.exa) options.exa = { enabled: false }
  return Object.keys(options).length ? options : undefined
}

/** The one input primitive the prompt phase needs; injectable for tests. */
export type Prompter = {
  /** Show `text` and resolve with the user's line (newline stripped). */
  ask(text: string): Promise<string>
}

/** Raised when EOF or Ctrl-C closes an interactive line prompt. */
export class PromptCancelledError extends Error {
  constructor() {
    super("prompt cancelled")
    this.name = "PromptCancelledError"
  }
}

/** Interpret a yes/no answer; undefined means the nonblank answer is invalid. */
export function parseYesNo(
  answer: string,
  fallback: boolean,
): boolean | undefined {
  const normalized = answer.trim().toLowerCase()
  if (normalized === "") return fallback
  if (normalized === "y" || normalized === "yes") return true
  if (normalized === "n" || normalized === "no") return false
  return undefined
}

/** Ask until the user enters a displayed default or an explicit yes/no. */
export async function promptYesNo(
  prompter: Prompter,
  text: string,
  fallback: boolean,
): Promise<boolean> {
  let question = text
  while (true) {
    const parsed = parseYesNo(await prompter.ask(question), fallback)
    if (parsed !== undefined) return parsed
    const retry = text.startsWith("\n") ? text.slice(1) : text
    question = `Please answer y or n.\n${retry}`
  }
}

/**
 * Prompt for the web-search backend configuration and return the options object
 * to write (or undefined for all-defaults). The question order is fixed so a
 * unit test can script answers positionally. Both backends default to enabled;
 * the SearXNG URL is the one value with no sensible default, so a blank line
 * simply leaves that backend out of the chain.
 */
export async function promptWebsearchOptions(
  prompter: Prompter,
): Promise<Record<string, unknown> | undefined> {
  const searxngUrl = await prompter.ask(
    "  SearXNG instance URL (blank to skip SearXNG): ",
  )
  const native = await promptYesNo(
    prompter,
    "  Enable provider-native web search? [Y/n]: ",
    true,
  )
  const exa = await promptYesNo(
    prompter,
    "  Enable Exa last-resort search? [Y/n]: ",
    true,
  )
  return buildWebsearchOptions({ searxngUrl, native, exa })
}

/**
 * Collect one newly-ticked plugin's install-time options, or undefined if it
 * takes none (in which case `prompter` is never touched). Dispatch point for
 * any future configurable plugin.
 */
export async function collectPluginOptions(
  plugin: PluginInfo,
  prompter: Prompter,
): Promise<Record<string, unknown> | undefined> {
  if (plugin.id === WEBSEARCH_ID) return promptWebsearchOptions(prompter)
  return undefined
}

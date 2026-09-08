import readline from "node:readline"
import type { PluginInfo } from "./core"

/**
 * The thin interactive layer: a raw-mode checkbox list. It owns only terminal
 * I/O and keyboard handling — every decision about what a selection means
 * lives in the unit-tested `core`. `runWizard` resolves to the desired
 * selection (plugin name → wanted) or `undefined` if the user cancels.
 */

export type WizardRow = {
  plugin: PluginInfo
  /** Whether any config entry for the plugin exists (active or masked). */
  installed: boolean
  /** Whether the user wants it after this run (starts equal to `installed`). */
  selected: boolean
}

const ESC = "\x1b"
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`
const CLEAR_DOWN = `${ESC}[0J`

function truncate(text: string, width: number): string {
  if (width <= 1) return ""
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

function rowLine(row: WizardRow, focused: boolean, width: number): string {
  const box = row.selected ? "[x]" : "[ ]"
  const pointer = focused ? "›" : " "
  let tag = ""
  if (row.selected && !row.installed) tag = "  (will install)"
  else if (!row.selected && row.installed) tag = "  (will remove)"
  const head = `${pointer} ${box} ${row.plugin.id}${tag}`
  const blurb = row.plugin.description ? `  — ${row.plugin.description}` : ""
  return truncate(`${head}${blurb}`, width)
}

function frame(
  rows: WizardRow[],
  focus: number,
  title: string,
  configDir: string,
  width: number,
): string[] {
  const pending = rows.filter((r) => r.selected !== r.installed).length
  return [
    "",
    `  ${title}`,
    truncate(`  user-level config: ${configDir}`, width),
    "",
    ...rows.map(
      (row, index) => `  ${rowLine(row, index === focus, width - 2)}`,
    ),
    "",
    "  ↑/↓ move · space toggle · a all · enter review · q/esc/^c/^d cancel",
    pending
      ? `  ${pending} pending change${pending === 1 ? "" : "s"}`
      : "  no changes yet",
  ]
}

export async function runWizard(
  rows: WizardRow[],
  options: { title: string; configDir: string; signal?: AbortSignal },
): Promise<Map<string, boolean> | undefined> {
  const input = process.stdin
  const output = process.stdout
  const width = () =>
    output.columns && output.columns > 20 ? output.columns : 80
  let focus = 0
  let painted = 0

  const paint = () => {
    const lines = frame(rows, focus, options.title, options.configDir, width())
    const prefix = painted > 0 ? `${ESC}[${painted - 1}A\r${CLEAR_DOWN}` : ""
    output.write(`${prefix}${lines.join("\n")}`)
    painted = lines.length
  }

  readline.emitKeypressEvents(input)
  const wasRaw = input.isRaw ?? false
  if (input.isTTY) input.setRawMode(true)
  input.resume()
  output.write(HIDE_CURSOR)
  paint()

  return await new Promise<Map<string, boolean> | undefined>((resolve) => {
    let finished = false
    const finish = (result: Map<string, boolean> | undefined) => {
      if (finished) return
      finished = true
      input.off("keypress", onKey)
      input.off("end", onEnd)
      input.off("close", onEnd)
      options.signal?.removeEventListener("abort", onAbort)
      if (input.isTTY) input.setRawMode(wasRaw)
      input.pause()
      output.write(`${SHOW_CURSOR}\n`)
      resolve(result)
    }

    const onEnd = () => finish(undefined)
    const onAbort = () => finish(undefined)

    const onKey = (_: string, key: readline.Key | undefined) => {
      if (!key) return
      const name = key.name
      if (key.ctrl && (name === "c" || name === "d")) return finish(undefined)
      if (name === "escape" || name === "q") return finish(undefined)
      if (name === "return" || name === "enter") {
        return finish(
          new Map(rows.map((row) => [row.plugin.name, row.selected])),
        )
      }
      if (name === "up" || name === "k")
        focus = (focus - 1 + rows.length) % rows.length
      else if (name === "down" || name === "j")
        focus = (focus + 1) % rows.length
      else if (name === "space") {
        const row = rows[focus]
        if (row) row.selected = !row.selected
      } else if (name === "a") {
        const target = !rows.every((row) => row.selected)
        for (const row of rows) row.selected = target
      } else return
      paint()
    }

    input.on("keypress", onKey)
    input.once("end", onEnd)
    input.once("close", onEnd)
    options.signal?.addEventListener("abort", onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
  })
}

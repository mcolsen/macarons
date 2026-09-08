import { describe, expect, test } from "bun:test"
import type { PluginInfo } from "../src/core"
import { runWizard, type WizardRow } from "../src/wizard"

/**
 * `runWizard` attaches to process.stdin via readline.emitKeypressEvents, and
 * under `bun test` process.stdin.isTTY is falsy so the setRawMode calls are
 * skipped. That makes the key handler drivable with synthetic keypress events
 * and no production seam: emit the keys, await the resolved selection.
 */

const persist: PluginInfo = {
  name: "@macarons/persist-permissions",
  id: "persist-permissions",
  description: "persists approvals",
  dir: "/repo/plugins/persist-permissions",
  serverEntry: "/repo/plugins/persist-permissions/src/index.ts",
  tuiEntry: "/repo/plugins/persist-permissions/src/tui.tsx",
}
const auto: PluginInfo = {
  name: "@macarons/permissions-auto-mode",
  id: "permissions-auto-mode",
  description: "auto-approves",
  dir: "/repo/plugins/permissions-auto-mode",
  serverEntry: "/repo/plugins/permissions-auto-mode/src/index.ts",
}

/** How cli.ts seeds the rows: `selected` starts equal to `installed`. */
function rowsFor(installed: [boolean, boolean]): WizardRow[] {
  return [
    { plugin: persist, installed: installed[0], selected: installed[0] },
    { plugin: auto, installed: installed[1], selected: installed[1] },
  ]
}

/**
 * Run the wizard against synthetic keypresses with stdout swallowed, so the
 * frame repaints do not garble the test reporter's output. Returns both the
 * selection and everything the wizard painted.
 */
async function drive(
  rows: WizardRow[],
  keys: { name: string; ctrl?: boolean }[],
  signal?: AbortSignal,
): Promise<{ selection: Map<string, boolean> | undefined; painted: string }> {
  const write = process.stdout.write.bind(process.stdout)
  let painted = ""
  process.stdout.write = ((chunk: string) => {
    painted += String(chunk)
    return true
  }) as typeof process.stdout.write
  try {
    const pending = runWizard(rows, {
      title: "test wizard",
      configDir: "/tmp/config",
      signal,
    })
    for (const key of keys) process.stdin.emit("keypress", "", key)
    return { selection: await pending, painted }
  } finally {
    process.stdout.write = write
  }
}

describe("runWizard key protocol", () => {
  test("enter resolves the user's ticks, keyed by package name", async () => {
    // Two mutants live on this one line. Keying the map by `plugin.id` (what
    // the rows DISPLAY) instead of `plugin.name` makes every downstream
    // `selection.get(plugin.name)` fall through `?? false` and plan EVERY
    // plugin for removal — a mass uninstall on an enter keypress. Resolving
    // `row.installed` instead of `row.selected` throws the interaction away
    // and reports "Already up to date" at the user who just unticked a row.
    const rows = rowsFor([true, true])
    const { selection } = await drive(rows, [
      { name: "space" },
      { name: "return" },
    ])
    expect(selection).toBeInstanceOf(Map)
    expect([...(selection as Map<string, boolean>).keys()].toSorted()).toEqual(
      [auto.name, persist.name].toSorted(),
    )
    expect(selection?.get(persist.name)).toBe(false)
    expect(selection?.get(auto.name)).toBe(true)
    // The short id must NOT be a key; buildPlan looks entries up by name only.
    expect(selection?.has(persist.id)).toBe(false)
  })

  test("space toggles only the focused row", async () => {
    const rows = rowsFor([false, false])
    const { selection } = await drive(rows, [
      { name: "down" },
      { name: "space" },
      { name: "return" },
    ])
    expect(selection?.get(persist.name)).toBe(false)
    expect(selection?.get(auto.name)).toBe(true)
  })

  test("`a` from a mixed selection selects all, then deselects all", async () => {
    // `!rows.every(selected)` — not `!rows.some(...)`. From a MIXED state the
    // two differ, which is why the fixture starts half-ticked: an all-on or
    // all-off fixture cannot tell the mutant apart.
    const mixed = rowsFor([true, false])
    expect(
      (await drive(mixed, [{ name: "a" }, { name: "return" }])).selection,
    ).toEqual(
      new Map([
        [persist.name, true],
        [auto.name, true],
      ]),
    )
    const all = rowsFor([true, true])
    expect(
      (await drive(all, [{ name: "a" }, { name: "return" }])).selection,
    ).toEqual(
      new Map([
        [persist.name, false],
        [auto.name, false],
      ]),
    )
  })

  test("cancelling resolves strictly undefined, even after edits", async () => {
    // `undefined` means "change nothing"; a Map — including one whose values
    // are all false — means "apply this", and all-false is a full uninstall.
    // The two outcomes are one line apart in the key handler, so assert
    // toBeUndefined(): toBeFalsy() would pass on the very Map that destroys
    // the user's install. Each cancel key is exercised AFTER an edit, the
    // state in which cancel actually matters.
    for (const key of [
      { name: "escape" },
      { name: "q" },
      { name: "c", ctrl: true },
      { name: "d", ctrl: true },
    ]) {
      const { selection } = await drive(rowsFor([true, true]), [
        { name: "space" },
        key,
      ])
      expect(selection).toBeUndefined()
    }
  })

  test("an abort signal cancels and restores the terminal", async () => {
    const listenersBefore = ["keypress", "end", "close"].map((event) =>
      process.stdin.listenerCount(event),
    )
    const controller = new AbortController()
    const pending = drive(rowsFor([true, false]), [], controller.signal)
    controller.abort()

    const { selection, painted } = await pending
    expect(selection).toBeUndefined()
    expect(painted).toContain("\x1b[?25h")
    expect(
      ["keypress", "end", "close"].map((event) =>
        process.stdin.listenerCount(event),
      ),
    ).toEqual(listenersBefore)
  })

  test("an unhandled key resolves nothing and leaves the selection alone", async () => {
    const rows = rowsFor([true, false])
    const { selection } = await drive(rows, [
      { name: "z" },
      { name: "f5" },
      { name: "return" },
    ])
    expect(selection).toEqual(
      new Map([
        [persist.name, true],
        [auto.name, false],
      ]),
    )
  })

  test("the vim aliases j and k move focus like the arrow keys", async () => {
    // `j`/`k` are handled but undocumented in the footer, so a cleanup that
    // drops either alias would not fail any visible assertion. Both cases move
    // focus OFF row 0, which is exactly what distinguishes "the alias moved
    // focus" from "the key fell through to the unhandled `else return`" — an
    // ignored key leaves focus on row 0 and toggles the WRONG plugin.
    const down = await drive(rowsFor([false, false]), [
      { name: "j" },
      { name: "space" },
      { name: "return" },
    ])
    expect(down.selection?.get(auto.name)).toBe(true)
    expect(down.selection?.get(persist.name)).toBe(false)

    // `k` from the first row wraps to the last, same as `up`.
    const up = await drive(rowsFor([false, false]), [
      { name: "k" },
      { name: "space" },
      { name: "return" },
    ])
    expect(up.selection?.get(auto.name)).toBe(true)
    expect(up.selection?.get(persist.name)).toBe(false)
  })

  test("focus wraps at both ends of the list", async () => {
    // Modulo, not clamp: `up` from the first row lands on the LAST one, and
    // `down` from there comes back to the first. A clamping mutant leaves
    // focus on row 0 the whole time, so the toggles land on the wrong plugin.
    const upResult = await drive(rowsFor([false, false]), [
      { name: "up" },
      { name: "space" },
      { name: "return" },
    ])
    expect(upResult.selection?.get(auto.name)).toBe(true)
    expect(upResult.selection?.get(persist.name)).toBe(false)

    const downResult = await drive(rowsFor([false, false]), [
      { name: "down" },
      { name: "down" },
      { name: "space" },
      { name: "return" },
    ])
    expect(downResult.selection?.get(persist.name)).toBe(true)
    expect(downResult.selection?.get(auto.name)).toBe(false)
  })
})

describe("runWizard terminal handling", () => {
  test("every terminating path restores the cursor", async () => {
    // HIDE_CURSOR is written before the key loop; only finish() writes
    // SHOW_CURSOR. A future early return that skips finish() would leave the
    // user's terminal with no cursor after the installer exits.
    for (const key of [{ name: "return" }, { name: "escape" }]) {
      const { painted } = await drive(rowsFor([true, false]), [key])
      expect(painted).toContain("\x1b[?25l")
      expect(painted).toContain("\x1b[?25h")
      expect(painted.lastIndexOf("\x1b[?25h")).toBeGreaterThan(
        painted.lastIndexOf("\x1b[?25l"),
      )
    }
  })

  test("the painted rows tag pending installs and removals distinctly", async () => {
    // The tag is the only place the preview says which DIRECTION a row is
    // moving; swapping the two labels makes the user confirm the opposite of
    // what they read.
    const rows = rowsFor([true, false])
    const { painted } = await drive(rows, [
      { name: "space" },
      { name: "down" },
      { name: "space" },
      { name: "return" },
    ])
    const final = painted.slice(painted.lastIndexOf("test wizard"))
    expect(final).toContain(`${persist.id}  (will remove)`)
    expect(final).toContain(`${auto.id}  (will install)`)
    expect(final).toContain("2 pending changes")
    expect(final).toContain("enter review")
    expect(final).toContain("q/esc/^c/^d cancel")
    expect(final).not.toContain("enter apply")
  })

  test("the pending counter tracks the edits made and agrees in number", async () => {
    // The counter is the only summary the user reads before pressing enter, and
    // it is derived (`selected !== installed`) rather than incremented — a
    // regression that counted rows, or dropped the zero branch, would misreport
    // the size of a destructive change. Each repaint appends a frame, so the
    // whole sequence is visible in one capture: 0 → 1 → 2.
    const { painted } = await drive(rowsFor([true, false]), [
      { name: "space" },
      { name: "down" },
      { name: "space" },
      { name: "return" },
    ])
    const at = (text: string) => painted.indexOf(text)
    expect(at("no changes yet")).toBeGreaterThanOrEqual(0)
    // Singular, with no stray plural: "1 pending changes" is the classic slip.
    expect(painted).not.toContain("1 pending changes")
    expect(at("1 pending change")).toBeGreaterThan(at("no changes yet"))
    expect(at("2 pending changes")).toBeGreaterThan(at("1 pending change"))
  })
})

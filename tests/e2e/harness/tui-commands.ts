import type { TmuxTui } from "./tmux"

/**
 * Driving OpenCode's own command surfaces from tmux.
 *
 * These wrap host behaviour that is easy to get subtly — and silently — wrong.
 * Verified against opencode 1.18.3 (`packages/tui/src/component/prompt/`,
 * `packages/tui/src/ui/dialog-select.tsx`, `packages/tui/src/config/keybind.ts`).
 *
 * The rule every helper here encodes: **wait for the row you mean to pick
 * before pressing Enter, and match text unique to that row.** Both the slash
 * popup and DialogSelect reset their selection to index 0 on every filter
 * change, so an Enter sent before the filter settles activates whatever sorts
 * first. Matching text that is already somewhere else on screen has the same
 * effect — the wait returns from a stale frame and Enter fires early.
 */

/** The command palette's dialog title (`command-palette.tsx`). */
export const PALETTE_TITLE = "Commands"

/**
 * Invoke a slash command from the prompt input.
 *
 * The completion popup opens as soon as the buffer starts with "/" and
 * captures Enter; selecting its highlighted row is what dispatches the
 * command. The two obvious alternatives are both wrong:
 *
 *   - Pressing Escape first clears the whole buffer — autocomplete's `hide()`
 *     deletes a "/"-prefixed buffer that does not end in a space — so the
 *     following Enter does nothing at all.
 *   - Typing a trailing space closes the popup while KEEPING the text, and a
 *     TUI `slashName` is not in the server's command list, so Enter sends the
 *     raw "/name " to the model as an ordinary prompt. Silent and expensive.
 *
 * `rowMatch` must be unique to the popup row — typically the command's `desc`,
 * which the popup renders beside it. Do NOT pass the typed "/name": the status
 * bar renders the session's directory, so a project path containing the
 * command name (".../worktrees/…" for "/worktree") matches instantly from a
 * stale frame and Enter then dispatches the wrong command.
 */
export async function runSlashCommand(
  tui: TmuxTui,
  slash: string,
  rowMatch: string | RegExp,
) {
  await tui.type(`/${slash}`)
  await tui.waitForText(rowMatch)
  await tui.sendKey("Enter")
}

/**
 * Open the command palette (ctrl+p) and run one command.
 *
 * The palette's filter input self-focuses a tick after the dialog opens, so
 * the title must be on screen before typing or the first characters are lost.
 * Filtering also collapses the palette's duplicated "Suggested" rows, which is
 * why every call passes one.
 */
export async function runPaletteCommand(
  tui: TmuxTui,
  filter: string,
  rowMatch: string | RegExp,
) {
  await tui.sendKey("C-p")
  await tui.waitForText(PALETTE_TITLE)
  await tui.type(filter)
  await tui.waitForText(rowMatch)
  await tui.sendKey("Enter")
}

/**
 * Pick one row out of an already-open DialogSelect.
 *
 * Note that a `disabled: true` option is filtered out of the list entirely
 * rather than rendered greyed-out and skipped, so waiting for the row is also
 * what distinguishes "the option I want is unavailable" from "Enter silently
 * activated the option below it".
 */
export async function pickOption(
  tui: TmuxTui,
  dialogTitle: string | RegExp,
  filter: string,
  rowMatch: string | RegExp,
  /**
   * Text of a row the filter must EXCLUDE. Without it, waiting for `rowMatch`
   * proves nothing when the row was already visible in the unfiltered list:
   * the wait returns from the pre-filter frame and Enter takes index 0 of the
   * list as it stands, which is a different option than the one intended.
   * Waiting for an excluded row to disappear is what proves the filter landed.
   */
  excluded?: string,
) {
  await tui.waitForText(dialogTitle)
  await tui.type(filter)
  if (excluded !== undefined) {
    const deadline = Date.now() + 15_000
    let pane = await tui.capture()
    while (Date.now() < deadline && pane.includes(excluded)) {
      await Bun.sleep(100)
      pane = await tui.capture()
    }
    if (pane.includes(excluded)) {
      throw new Error(
        `Filter ${JSON.stringify(filter)} never excluded ${JSON.stringify(excluded)}.\nLast pane:\n${pane}`,
      )
    }
  }
  await tui.waitForText(rowMatch)
  await tui.sendKey("Enter")
}

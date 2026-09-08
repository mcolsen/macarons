/**
 * The suite's async test helpers — nine hand-rolled spellings of one poll
 * loop before the harness existed (2026-07-23 audit §3). The semantic axes
 * that mattered are all parameters here; everything else was drift.
 */

/** Let one macrotask turn pass (queued timers at 0ms, settled promises). */
export const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Run several macrotask turns so a chain of await points settles — enough
 * for every engine pipeline in the suite (the deepest needs 6).
 */
export async function flush(turns = 6): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await tick()
}

/**
 * Poll until `condition` holds, failing loudly on expiry. The wall-clock
 * bound (never an attempt count) keeps the timeout meaningful under load —
 * see the state-file wait races the e2e lane hit with counted retries.
 */
export async function until(
  condition: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 3_000
  const intervalMs = options.intervalMs ?? 10
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(
        `${options.label ?? "condition"} not met within ${timeoutMs}ms`,
      )
    }
    await Bun.sleep(intervalMs)
  }
}

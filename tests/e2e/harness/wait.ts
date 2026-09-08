/** Check the whole observation window, failing on the first broken assertion. */
export async function assertFor(
  assertion: () => void | Promise<void>,
  options: { duration: number; interval?: number },
) {
  const deadline = performance.now() + options.duration
  while (true) {
    await assertion()
    const remaining = deadline - performance.now()
    if (remaining <= 0) return
    await Bun.sleep(Math.min(options.interval ?? 25, remaining))
  }
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { description: string; timeout?: number; interval?: number },
) {
  const timeout = options.timeout ?? 20_000
  const interval = options.interval ?? 25
  const deadline = Date.now() + timeout
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
      lastError = undefined
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(interval)
  }
  const suffix = lastError ? ` Last error: ${String(lastError)}` : ""
  throw new Error(
    `Timed out after ${timeout}ms waiting for ${options.description}.${suffix}`,
  )
}

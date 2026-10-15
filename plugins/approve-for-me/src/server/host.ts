const COALESCED_READ_TIMEOUT_MS = 10_000

type Log = (level: "warn", message: string) => void

export class SafeCauseError extends Error {
  readonly safeCause: string

  constructor(message: string, safeCause = message) {
    super(message)
    this.safeCause = safeCause
  }
}

/** Epoch-gated, in-flight-only host-read sharing. */
export function createHostReadCoalescer(log: Log) {
  let epoch = 0
  type InFlightRead = { epoch: number; promise: Promise<unknown> }
  const reads = new Map<string, InFlightRead>()

  const fresh = <T>(
    key: string,
    read: () => Promise<T | undefined>,
  ): Promise<T | undefined> =>
    new Promise<T | undefined>((resolve) => {
      const timer = setTimeout(() => {
        log(
          "warn",
          `the shared "${key}" read did not settle within ${COALESCED_READ_TIMEOUT_MS}ms; failing it for all sharers`,
        )
        resolve(undefined)
      }, COALESCED_READ_TIMEOUT_MS)
      read().then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        () => {
          clearTimeout(timer)
          resolve(undefined)
        },
      )
    })

  const coalesce = <T>(
    key: string,
    read: () => Promise<T | undefined>,
  ): Promise<T | undefined> => {
    const existing = reads.get(key)
    if (existing && existing.epoch === epoch)
      return existing.promise as Promise<T | undefined>
    const entry: InFlightRead = { epoch, promise: Promise.resolve(undefined) }
    entry.promise = fresh(key, read).finally(() => {
      if (reads.get(key) === entry) reads.delete(key)
    })
    reads.set(key, entry)
    return entry.promise as Promise<T | undefined>
  }

  return {
    coalesce,
    fresh,
    advanceEpoch: () => {
      epoch += 1
    },
  }
}

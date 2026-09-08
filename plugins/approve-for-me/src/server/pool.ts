export function createConcurrencyPool(maxQueued: number) {
  let running = 0
  let limit = 0
  type Waiter = {
    grant: (granted: boolean) => void
    abandon: () => void
    signal: AbortSignal
  }
  const queue: Waiter[] = []

  const drain = () => {
    while (running < limit) {
      const next = queue.shift()
      if (!next) return
      next.signal.removeEventListener("abort", next.abandon)
      running += 1
      next.grant(true)
    }
  }

  const acquire = (
    nextLimit: number,
    signal: AbortSignal,
  ): boolean | Promise<boolean> => {
    limit = nextLimit
    drain()
    if (running < nextLimit && queue.length === 0) {
      running += 1
      return true
    }
    if (signal.aborted) return Promise.resolve(false)
    if (queue.length >= maxQueued) return false
    return new Promise<boolean>((grant) => {
      const waiter: Waiter = {
        grant,
        signal,
        abandon: () => {
          const index = queue.indexOf(waiter)
          if (index !== -1) queue.splice(index, 1)
          grant(false)
        },
      }
      signal.addEventListener("abort", waiter.abandon, { once: true })
      queue.push(waiter)
    })
  }

  return {
    acquire,
    release: () => {
      running -= 1
      drain()
    },
  }
}

import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2"

type InstanceDiscoveryApi = Parameters<
  typeof import("../../../plugins/approve-for-me/src/shared/instance").requestInstanceID
>[0]

const DEFAULT_TIMEOUT = 20_000

/**
 * The FIRST event off a freshly started server costs seconds, not
 * milliseconds — the host is still finishing its bootstrap (and installing the
 * `@opencode-ai/plugin` package the generated config asks for) when the
 * subscription opens, and `server.connected` only arrives once it serves the
 * stream. Measured at 5.5-6.0s on an idle developer box, for the bundle
 * journey as well as the install one, so it is the baseline cost of starting a
 * server rather than anything one suite does.
 *
 * Against that baseline the old shared 20s budget left barely 3x headroom, and
 * a loaded CI runner routinely eats more than that — which is how this timed
 * out on suites picked essentially at random (btw/cron/core in one run,
 * install in the next) with an empty "Recent events" list every time. Waiting
 * longer only delays the report of a genuinely dead server; it cannot turn a
 * real failure into a pass. Kept clear of the tightest per-test budget
 * (`e2e:install`, see tests/e2e/package.json) so the assertion fails with this
 * message rather than bun's own timeout.
 */
const CONNECT_TIMEOUT = 45_000

export class EventRecorder {
  readonly events: Event[] = []
  /** ms-epoch arrival time of events[i], for latency measurements. */
  readonly times: number[] = []

  private readonly abort = new AbortController()
  private readonly listeners = new Set<() => void>()
  private readonly eventListeners = new Map<
    string,
    Set<(event: Event) => void>
  >()
  private streamError: unknown
  private streamTask?: Promise<void>

  private constructor() {}

  static async connect(client: OpencodeClient, timeout = CONNECT_TIMEOUT) {
    const recorder = new EventRecorder()
    const subscription = await client.event.subscribe(undefined, {
      signal: recorder.abort.signal,
    })
    recorder.streamTask = (async () => {
      try {
        for await (const event of subscription.stream) {
          recorder.events.push(event)
          recorder.times.push(Date.now())
          recorder.emit(event)
          recorder.notify()
        }
      } catch (error) {
        if (!recorder.abort.signal.aborted) {
          recorder.streamError = error
          recorder.notify()
        }
      }
    })()
    try {
      await recorder.waitFor((event) => event.type === "server.connected", {
        description: "server.connected event",
        timeout,
      })
    } catch (error) {
      await recorder.close()
      throw error
    }
    return recorder
  }

  async waitFor<T extends Event>(
    predicate: (event: Event) => event is T,
    options?: { description?: string; timeout?: number; after?: number },
  ): Promise<T>
  async waitFor(
    predicate: (event: Event) => boolean,
    options?: { description?: string; timeout?: number; after?: number },
  ): Promise<Event>
  async waitFor(
    predicate: (event: Event) => boolean,
    options: { description?: string; timeout?: number; after?: number } = {},
  ): Promise<Event> {
    const after = options.after ?? 0
    const existing = this.events.slice(after).find(predicate)
    if (existing) return existing
    if (this.streamError) throw this.streamFailure()

    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    return new Promise<Event>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const check = () => {
        if (this.streamError) {
          cleanup()
          reject(this.streamFailure())
          return
        }
        const event = this.events.slice(after).find(predicate)
        if (!event) return
        cleanup()
        resolve(event)
      }
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        this.listeners.delete(check)
      }
      timer = setTimeout(() => {
        cleanup()
        reject(
          new Error(
            `Timed out after ${timeout}ms waiting for ${options.description ?? "event"}.\nRecent events:\n${this.formatRecent()}`,
          ),
        )
      }, timeout)
      this.listeners.add(check)
      check()
    })
  }

  mark() {
    return this.events.length
  }

  /**
   * Present the subscribed SDK stream in the narrow shape a TUI plugin uses.
   * This exercises requestInstanceID over the real host event transport.
   */
  tuiDiscoveryApi(client: OpencodeClient, directory: string) {
    const signal = this.abort.signal
    return {
      client: client as unknown as InstanceDiscoveryApi["client"],
      event: {
        on: (type: string, listener: (event: Event) => void) =>
          this.on(type, listener),
      },
      lifecycle: { signal },
      state: { path: { directory } },
    } as InstanceDiscoveryApi
  }

  /** When a previously returned event arrived, or undefined for strangers. */
  receivedAt(event: Event): number | undefined {
    const index = this.events.indexOf(event)
    return index === -1 ? undefined : this.times[index]
  }

  async close() {
    this.abort.abort()
    await this.streamTask?.catch(() => {})
  }

  formatRecent(limit = 30) {
    return this.events
      .slice(-limit)
      .map((event) => JSON.stringify(event))
      .join("\n")
  }

  private notify() {
    for (const listener of [...this.listeners]) listener()
  }

  private on(type: string, listener: (event: Event) => void) {
    let listeners = this.eventListeners.get(type)
    if (!listeners) {
      listeners = new Set()
      this.eventListeners.set(type, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.eventListeners.delete(type)
    }
  }

  private emit(event: Event) {
    for (const listener of this.eventListeners.get(event.type) ?? [])
      listener(event)
  }

  private streamFailure() {
    return new Error(
      `OpenCode event stream failed: ${String(this.streamError)}\nRecent events:\n${this.formatRecent()}`,
    )
  }
}

export function isSessionEvent(sessionID: string, type: Event["type"]) {
  return (event: Event) => {
    if (event.type !== type) return false
    const properties = event.properties as { sessionID?: unknown }
    return properties.sessionID === sessionID
  }
}

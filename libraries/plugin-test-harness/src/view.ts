import { afterEach } from "bun:test"
import { testRender } from "@opentui/solid"
import { flush } from "./async"

/**
 * The repeated slot-mount pattern from the suite's view tests: mount a
 * registered slot (or a captured render thunk) under @opentui/solid's
 * headless test renderer, destroy it after each test. Kept apart from
 * ./tui so engine-only test files never load the solid machinery.
 */
export type RenderSetup = Awaited<ReturnType<typeof testRender>>

export type MountSource = { slotPlugins: any[] } | (() => unknown)

/**
 * Returns a mount function bound to a per-file teardown: the returned view is
 * destroyed in afterEach, so call this at the top level of the test file
 * (once), and mount at most one view per test.
 */
export function createSlotMounter(defaults: { width: number; height: number }) {
  let setup: RenderSetup | undefined
  afterEach(async () => {
    await setup?.renderer.destroy()
    setup = undefined
  })

  return async function mountSlot(
    source: MountSource,
    options: {
      /** Which registered slot to mount (default sidebar_content). */
      slot?: string
      sessionID?: string
      width?: number
      height?: number
    } = {},
  ): Promise<RenderSetup> {
    let thunk: () => unknown
    if (typeof source === "function") {
      thunk = source
    } else {
      const plugin = source.slotPlugins[0]
      if (!plugin) throw new Error("no sidebar slot registered")
      const name = options.slot ?? "sidebar_content"
      const slot = plugin.slots?.[name]
      if (typeof slot !== "function")
        throw new Error(`registered plugin has no ${name} slot`)
      thunk = () => slot({}, { session_id: options.sessionID ?? "ses_1" })
    }
    const mounted = await testRender(thunk, {
      width: options.width ?? defaults.width,
      height: options.height ?? defaults.height,
    })
    setup = mounted
    await mounted.renderOnce()
    return mounted
  }
}

/**
 * Re-render until the captured char frame contains `needle`, failing with
 * the last frame so the assertion's diff shows what actually rendered.
 */
export async function settleFrame(
  view: RenderSetup,
  needle: string,
  timeoutMs = 3_000,
): Promise<string> {
  const start = Date.now()
  while (true) {
    await flush()
    await view.renderOnce()
    const frame = view.captureCharFrame()
    if (frame.includes(needle)) return frame
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `frame never contained ${JSON.stringify(needle)}:\n${frame}`,
      )
    await Bun.sleep(15)
  }
}

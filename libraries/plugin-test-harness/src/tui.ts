import { describe, expect, test } from "bun:test"
import { BAND_SAMPLE_VERSIONS as BAND } from "@macarons/permission-rules"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

export type TuiApi = Parameters<TuiPlugin>[0]
export type Toast = Parameters<TuiApi["ui"]["toast"]>[0]

/**
 * The common core of the suite's hand-rolled TuiPlugin api mocks — the slice
 * every TUI half touches, with recorders for everything the tests assert on
 * (2026-07-23 audit §3, issue #116). Domain surfaces (dialog stacks, client
 * dispatchers, keymap query tables, fixture seeds) deliberately do NOT live
 * here: a plugin's makeApi extends `api` with exactly what its entry reads,
 * keeping the mock honest about the surface it exercises.
 *
 * Structural mock: fields are permissive records so a plugin can graft its
 * own surface on before casting to the `Parameters<TuiPlugin>[0]` alias at
 * the load site, where drift against the real api type fails typecheck.
 */
export type TuiApiInput = {
  /**
   * Host version the mock reports. Omitted (or undefined) means BAND.floor —
   * the verified band's floor — so a plugin harness can forward its own
   * input's version field verbatim; `null` models a host whose version
   * cannot be determined, the fail-open leg of the compat gate.
   */
  version?: string | null
  /**
   * Server transport the mock client reports. Defaults to the in-process
   * "http://opencode.internal"; pass a remote origin for the remote-attach
   * leg, "" for an unreadable transport, or `null` to omit `_client`
   * entirely (no transport at all).
   */
  baseUrl?: string | null
  routeName?: string
  routeSessionID?: string
  /** Makes state.session.get report every session as this parent's child. */
  parentID?: string
  /** Merged over the default theme colors (real hex — the renderer rejects
   * non-color garbage, and hex also satisfies the engine tests). */
  theme?: Record<string, unknown>
  /** state.path entries; unset members stay "" (a host with no paths). */
  paths?: Partial<Record<"state" | "config" | "worktree" | "directory", string>>
}

/** The core api shape: known fields concrete, containers open for grafting. */
export type MutableTuiApi = {
  app: { version: string }
  ui: { toast: (toast: Toast) => void } & Record<string, any>
  theme: { current: Record<string, unknown> }
  state: Record<string, any>
  route: {
    current: { name: string; params: { sessionID: string } }
    navigate: (...args: any[]) => void
  }
  client: Record<string, any>
  keymap: { registerLayer: (layer: any) => () => void } & Record<string, any>
  slots: { register: (plugin: any) => string }
  event: {
    on: (type: string, handler: (event: any) => void) => () => void
  }
  lifecycle: {
    signal: AbortSignal
    onDispose: (fn: () => void | Promise<void>) => () => void
  }
}

export function makeTuiApi(input: TuiApiInput = {}) {
  const toasts: Toast[] = []
  const layers: any[] = []
  const slotPlugins: any[] = []
  const navigations: unknown[][] = []
  const disposers: Array<() => void | Promise<void>> = []
  const disposeErrors: unknown[] = []
  const handlers = new Map<string, ((event: any) => void)[]>()
  const version = input.version === undefined ? BAND.floor : input.version
  // Modeled on the host's createPluginScope (opencode
  // src/plugin/tui/runtime.ts): one controller aborted at the top of dispose,
  // registrations that can be dropped again, and a reverse drain that keeps
  // going after a callback throws. See the lifecycle field below.
  const controller = new AbortController()
  let disposed = false

  const api: MutableTuiApi = {
    app: { version: version as string },
    ui: {
      toast: (toast: Toast) => {
        toasts.push(toast)
      },
    },
    theme: {
      current: {
        text: "#e0e0e0",
        textMuted: "#808080",
        warning: "#ffcc00",
        error: "#ff0000",
        success: "#00cc66",
        ...input.theme,
      },
    },
    state: {
      path: {
        state: "",
        config: "",
        worktree: "",
        directory: "",
        ...input.paths,
      },
      session: {
        get: (sessionID: string) => ({
          id: sessionID,
          parentID: input.parentID,
        }),
      },
    },
    route: {
      current: {
        name: input.routeName ?? "session",
        params: { sessionID: input.routeSessionID ?? "ses_1" },
      },
      navigate: (...args: unknown[]) => {
        navigations.push(args)
      },
    },
    client:
      input.baseUrl === null
        ? {}
        : {
            _client: {
              getConfig: () => ({
                baseUrl: input.baseUrl ?? "http://opencode.internal",
              }),
            },
          },
    keymap: {
      registerLayer: (layer: any) => {
        layers.push(layer)
        return () => {}
      },
    },
    slots: {
      register: (plugin: any) => {
        slotPlugins.push(plugin)
        return "slot_1"
      },
    },
    event: {
      on: (type: string, handler: (event: any) => void) => {
        const list = handlers.get(type) ?? []
        list.push(handler)
        handlers.set(type, list)
        // A real unsubscribe (not a noop): tests that assert listener
        // lifecycles need removal to actually remove.
        return () => {
          const current = handlers.get(type) ?? []
          const index = current.indexOf(handler)
          if (index >= 0) current.splice(index, 1)
        }
      },
    },
    // Every field here is the host's behavior, not a convenient
    // approximation of it (opencode src/plugin/tui/runtime.ts,
    // createPluginScope). The first spelling handed out a signal whose
    // controller was discarded, a no-op unregister, and a FIFO drain that
    // stopped at the first rejection — none of which the host can do, so a
    // test written against them would pin behavior that cannot occur, and
    // one shared mock spreads that to every TUI half at once.
    lifecycle: {
      // Aborted by dispose() below, so a half that races cleanup against
      // signal.aborted sees what it would see in the host.
      signal: controller.signal,
      onDispose: (fn: () => void | Promise<void>) => {
        // Post-dispose registration is dropped rather than queued: the host
        // returns early on `done`, so a callback registered during teardown
        // never runs and must not look like it will.
        if (disposed) return () => {}
        disposers.push(fn)
        // A real unregister, like event.on's: `dropped` makes a second call
        // a no-op instead of evicting whoever now sits at that index.
        let dropped = false
        return () => {
          if (dropped) return
          dropped = true
          const index = disposers.indexOf(fn)
          if (index >= 0) disposers.splice(index, 1)
        }
      },
    },
  }

  return {
    api,
    toasts,
    layers,
    slotPlugins,
    navigations,
    disposers,
    handlers,
    /** Fire a bus event the way the host does: `{ type, properties }`. */
    emit: (type: string, properties: unknown) => {
      // Copy so a handler unsubscribing mid-dispatch cannot skip a sibling.
      for (const handler of [...(handlers.get(type) ?? [])]) {
        handler({ type, properties })
      }
    },
    /** Move the route the way the host does when the user switches sessions:
     * `route.current` is a live getter on the real api, so mutating the plain
     * params object reproduces the next read seeing the new id. */
    setRouteSession: (sessionID: string) => {
      api.route.current.params.sessionID = sessionID
    },
    /** Whatever a disposer threw, in the order the drain hit them. */
    disposeErrors,
    /**
     * Tear the plugin down the way the host does: abort the signal first,
     * then drain in REVERSE registration order — a half that registers a
     * store and then a subscriber over it expects the subscriber to go
     * first — continuing past a callback that throws so one broken disposer
     * cannot leave the rest registered. Idempotent, like the host's `done`
     * latch.
     *
     * The host's per-callback timeout is deliberately not modeled: its
     * budget is host configuration no plugin can see, and a disposer that
     * hangs already hangs the test run, which says the same thing louder.
     */
    dispose: async () => {
      if (disposed) return
      disposed = true
      controller.abort()
      for (const fn of disposers.splice(0).reverse()) {
        try {
          await fn()
        } catch (error) {
          disposeErrors.push(error)
        }
      }
    },
  }
}

export type TuiApiHarness = ReturnType<typeof makeTuiApi>

/**
 * One load of the TUI half at a given version/transport, reduced to what the
 * gating triad asserts. `registered` means the plugin's full UI surface came
 * up (slot, layers, listeners — whatever registration means for this
 * plugin); `inert` means nothing at all was registered, including — where
 * the plugin's mock tracks them — client calls and writes.
 */
export type GatingRun = {
  toasts: readonly Toast[]
  registered: boolean
  inert: boolean
}

export type GatingInput = { version?: string | null; baseUrl?: string }

/**
 * The version/locality gating triad every TUI half must pass, standardized
 * to the strictest spelling any plugin had (2026-07-23 audit §3): before the
 * harness this policy existed in eleven files and no two spellings matched —
 * three hardcoded a pre-band "1.16.0", all eleven minted their own "2.0.0",
 * and the warn assertion ranged from variant-only to full message checks.
 * Sample versions come from the library's BAND_SAMPLE_VERSIONS alone, so the
 * table survives the nightly ratchet (the issue-#116 guardrail: the harness
 * hardcodes no versions).
 *
 * The caller's `load` builds the plugin's own makeApi at the given input,
 * runs the entry, and reports what registered. Plugin-specific extra legs
 * (unreadable transports, prerelease samples, order pins) stay inline in the
 * plugin's tui.test.ts.
 */
export function describeGating(options: {
  load: (input: GatingInput) => GatingRun | Promise<GatingRun>
  /**
   * The plugin's own tuiGate `remoteBails` flag, kept in lockstep with
   * src/tui.tsx. Either setting runs a remote-origin leg: `true` expects a
   * silently inert half, `false` expects a normal registration.
   *
   * Running the leg only for `true` (the first spelling) left this field
   * unfalsifiable in the direction most plugins use. Seven pure-UI halves
   * pass `false`; if one production entry drifted to `true` the plugin would
   * disappear for every remote-attached TUI while its whole suite stayed
   * green, because nothing ever attached remotely. A flag that is only
   * checked when it is `true` says nothing about the halves that pass
   * `false`.
   */
  remoteBails: boolean
}): void {
  const warned = (run: GatingRun, ...needles: string[]) =>
    run.toasts.some(
      (toast) =>
        toast.variant === "warning" &&
        needles.every((needle) => String(toast.message).includes(needle)),
    )

  describe("OpenCode runtime compatibility gate", () => {
    test("registers silently inside the verified band", async () => {
      const run = await options.load({ version: BAND.floor })
      expect(run.registered).toBe(true)
      expect(run.toasts.filter((t) => t.variant === "warning")).toEqual([])
    })

    for (const version of [BAND.belowBand, BAND.aboveBand]) {
      test(`an untested v1 host (${version}) warns but still registers (fail open)`, async () => {
        const run = await options.load({ version })
        expect(run.registered).toBe(true)
        expect(warned(run, "Running anyway", `found ${version}`)).toBe(true)
      })
    }

    test("an unknown version warns but still registers (fail open)", async () => {
      const run = await options.load({ version: null })
      expect(run.registered).toBe(true)
      expect(warned(run, "could not determine")).toBe(true)
    })

    test("a non-v1 host registers nothing, saying so", async () => {
      const run = await options.load({ version: BAND.incompatible })
      expect(run.inert).toBe(true)
      expect(warned(run, "disabled")).toBe(true)
    })

    const remote = "http://build-box.example:4096"
    if (options.remoteBails) {
      test("a remote attach is completely inert", async () => {
        // Inert AND silent: the bail exists because local paths/stores are
        // meaningless for a server elsewhere — not worth a toast on every
        // remote attach.
        const run = await options.load({ baseUrl: remote })
        expect(run.inert).toBe(true)
        expect(run.toasts).toHaveLength(0)
      })
    } else {
      test("a remote attach is served like any other host", async () => {
        // The other side of the same contract: this half reads only what the
        // host already synced locally, so an origin elsewhere changes
        // nothing. Silent too — a warning here would be a bail in all but
        // name.
        const run = await options.load({ baseUrl: remote })
        expect(run.registered).toBe(true)
        expect(run.toasts.filter((t) => t.variant === "warning")).toEqual([])
      })
    }
  })
}

import { withTimeout } from "./async"

// The compatibility contract. The ONE hard boundary the plugins ENFORCE is the
// major version: they target OpenCode v1's plugin API, which OpenCode v2 (in
// beta as of this writing) reshapes — so a non-v1 host makes a plugin stay
// inert. Within v1, SUPPORTED_OPENCODE_RANGE names the band actually verified,
// and the band rides the repo's OpenCode pin: floor = the pinned release
// (.opencode-version), ceiling = the pin's next minor line. OpenCode is
// evergreen (auto-updating), so the suite verifies the current release rather
// than a trailing floor; the nightly bump workflow
// (.github/workflows/bump-opencode.yml) advances this constant together with
// the pin and the @opencode-ai/* package pins, and the bump PR's CI —
// typecheck against the pinned packages plus e2e against the pinned binary —
// is what re-verifies the band. A major crossing is never ratcheted
// mechanically; that is a support-policy decision made by hand. A v1 host
// outside the band (including one lagging the pin) still runs, but warns,
// because it is untested there, not known-incompatible.
//
// Runtime checks are still required for plugins loaded directly from a file
// URL or copied into .opencode/plugin/, because those paths never pass
// through an installer that can enforce the package engine declaration.
export const SUPPORTED_OPENCODE_RANGE = ">=1.18.14 <1.19.0"

// What package.json#engines.opencode declares instead (lockstep enforced by
// each plugin's packaging test). Deliberately NOT the verified band: OpenCode's
// npm-install path hard-enforces engines and refuses to load a plugin whose
// range excludes the host, so a ratcheting engines would brick installs on any
// host lagging the pin. engines therefore states only the static hard contract
// — OpenCode v1, new enough to carry the modern plugin API — and never moves
// with the pin; inside it, the runtime guard does the (warn-level) talking.
// Nothing in the suite's own code consumes engines.
export const OPENCODE_ENGINE_RANGE = ">=1.17.14 <2.0.0"

// The three ways a host version relates to a plugin's verified range:
//   "supported"    — OpenCode v1 inside the verified band: run silently.
//   "untested"     — OpenCode v1 outside the verified band (older, a newer
//                    minor, or a prerelease), OR a version we could not read:
//                    run, but warn. Failing open here is deliberate — a probe
//                    that cannot name the version is almost always still v1.
//   "incompatible" — not OpenCode v1 (v2+ changes the plugin API, v0 predates
//                    it): the plugin must stay inert.
export type OpenCodeCompat = "supported" | "untested" | "incompatible"

type VersionParts = {
  major: number
  minor: number
  patch: number
  prerelease: boolean
}

// Lenient semver read: extracts major/minor/patch and whether a `-prerelease`
// suffix is present. Tolerates a `+build` suffix (ignored, per semver) and,
// unlike a strict stable-only parser, still reads the major of a prerelease so
// a `2.0.0-beta` host is recognized as v2 and gated out. Returns undefined for
// anything without a clean numeric major.minor.patch, which the caller treats
// as an unknown (fail-open) version.
function parseOpenCodeVersion(version: unknown): VersionParts | undefined {
  if (typeof version !== "string") return
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      version.trim(),
    )
  if (!match) return
  // Groups 1-3 are mandatory in the pattern, so a successful match always has
  // them; `Number` accepts the index type's `string | undefined` and yields a
  // number (NaN for the unreachable gap), which the safe-integer gate rejects.
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every(Number.isSafeInteger)) return
  return { major, minor, patch, prerelease: match[4] !== undefined }
}

type Bound = { major: number; minor: number; patch: number }

function compareBound(a: Bound, b: Bound): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

// The verified floor (`>=X.Y.Z`) of a range. Falls back to 1.0.0 so a malformed
// constant never throws and simply widens the silent band.
export function versionFloorFromRange(range: string): Bound {
  const match = />=\s*(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(range)
  if (!match) return { major: 1, minor: 0, patch: 0 }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

// The verified ceiling (`<X.Y.Z`) of a range. Falls back to 2.0.0 — the v1
// boundary — so a range with no upper bound treats all of v1 as verified.
export function versionCeilingFromRange(range: string): Bound {
  const match = /<\s*(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(range)
  if (!match) return { major: 2, minor: 0, patch: 0 }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

// Sample versions derived from the band, for the compat tables every plugin's
// tests run: recomputed from SUPPORTED_OPENCODE_RANGE so the tables survive
// the nightly ratchet instead of hardcoding versions that go stale whenever
// the pin advances. floor/inBand classify "supported"; belowBand/aboveBand
// are v1 but "untested" (aboveBand is the exclusive ceiling itself);
// incompatible is the next major above the floor — the non-v1 host every
// disable leg tests, kept here so no test hardcodes a "2.0.0" of its own
// (issue #116's gating harness runs on these members alone).
export const BAND_SAMPLE_VERSIONS = (() => {
  const floor = versionFloorFromRange(SUPPORTED_OPENCODE_RANGE)
  const ceiling = versionCeilingFromRange(SUPPORTED_OPENCODE_RANGE)
  return {
    floor: `${floor.major}.${floor.minor}.${floor.patch}`,
    inBand: `${floor.major}.${floor.minor}.${floor.patch + 7}`,
    belowBand:
      floor.patch > 0
        ? `${floor.major}.${floor.minor}.${floor.patch - 1}`
        : `${floor.major}.${floor.minor - 1}.99`,
    aboveBand: `${ceiling.major}.${ceiling.minor}.${ceiling.patch}`,
    incompatible: `${floor.major + 1}.0.0`,
  }
})()

// Classify a probed/host version against a plugin's verified range. The hard v1
// gate is independent of the range's ceiling — only a non-v1 host is
// "incompatible". Within v1, the range's [floor, ceiling) is the silent band; a
// newer minor (e.g. a 1.19 while the band still ends at 1.19.0) runs but reports
// "untested" until the band is widened for it, exactly as it did before but
// warning instead of disabling.
export function classifyOpenCodeVersion(
  version: unknown,
  range: string,
): OpenCodeCompat {
  const parts = parseOpenCodeVersion(version)
  if (!parts) return "untested"
  if (parts.major !== 1) return "incompatible"
  if (parts.prerelease) return "untested"
  const withinBand =
    compareBound(parts, versionFloorFromRange(range)) >= 0 &&
    compareBound(parts, versionCeilingFromRange(range)) < 0
  return withinBand ? "supported" : "untested"
}

export type CompatNotice = {
  compat: OpenCodeCompat
  disable: boolean
  message: string
}

// Build the user-facing notice for the two actionable states, or null when the
// version is inside the verified band (proceed silently). `label` is the
// plugin's human name for the message ("Approve for Me", "btw"). `disable` is
// true only for the incompatible state, so callers branch on it to decide
// inert vs. run.
export function openCodeCompatNotice(
  version: string | undefined,
  range: string,
  label: string,
): CompatNotice | null {
  const compat = classifyOpenCodeVersion(version, range)
  if (compat === "supported") return null
  if (compat === "incompatible") {
    // Only reachable with a parseable non-v1 version, so `version` is present.
    return {
      compat,
      disable: true,
      message: `${label} needs OpenCode v1.x — found OpenCode ${version}. OpenCode v2 changes the plugin API, so ${label} is disabled.`,
    }
  }
  const message = version
    ? `${label} is verified against OpenCode ${range}; found ${version}. Running anyway — it may misbehave.`
    : `${label} could not determine the OpenCode version (verified against ${range}). Running anyway — it may misbehave.`
  return { compat, disable: false, message }
}

export type VersionProbe = { version?: string; reason?: string }

export function versionFromHealth(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return
  const result = value as { version?: unknown; data?: unknown }
  if (typeof result.version === "string" && result.version.trim())
    return result.version.trim()
  if (!result.data || typeof result.data !== "object") return
  const version = (result.data as { version?: unknown }).version
  return typeof version === "string" && version.trim()
    ? version.trim()
    : undefined
}

// Newer SDK clients expose global.health(); the injected v1 plugin clients do
// not, so the probe walks down to the SDK's raw transport and finally the
// public HTTP endpoint. The transport step matters: a standalone `opencode`
// TUI never binds serverUrl (it reports the default http://localhost:4096/
// with no listener behind it — verified against a live 1.17.18), so an HTTP
// fetch there fails forever, while the SDK client dispatches in-process and
// answers /global/health in milliseconds even during instance bootstrap.
/**
 * Bound on each health probe; a slow host must not wedge plugin init. Every
 * tier carries it, so a triply-wedged host delays startup by three of these
 * and then gives up — never the unbounded park that would outlast the session.
 */
const PROBE_TIMEOUT_MS = 2_000

export async function probeOpenCodeVersion(
  client: unknown,
  serverUrl: URL,
): Promise<VersionProbe> {
  const failures: string[] = []
  const globalApi = (
    client as {
      global?: {
        health?: (options?: { signal?: AbortSignal }) => Promise<unknown>
      }
    }
  ).global
  const clientHealth = globalApi?.health?.bind(globalApi)
  if (clientHealth) {
    try {
      // Bounded like the tiers below it. In-process and fast on a healthy
      // host is not the same as "cannot wedge", and an unbounded await here
      // parks plugin init behind it — the one outcome this probe exists to
      // prevent. The SDK resolves this call with the body already parsed, so
      // the bound covers the whole exchange.
      const result = await withTimeout(
        (signal) => clientHealth({ signal }),
        PROBE_TIMEOUT_MS,
      )
      const version = versionFromHealth(result)
      if (version) return { version }
      failures.push("the SDK health response omitted its version")
    } catch (error) {
      failures.push(
        `the SDK health request failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const transport = (
    client as {
      _client?: {
        get?: (options: {
          url: string
          signal?: AbortSignal
        }) => Promise<unknown>
      }
    }
  )._client
  const transportGet = transport?.get?.bind(transport)
  if (transportGet) {
    try {
      // Raced as well as signalled: whether the in-process transport honors
      // AbortSignal is a host-version detail, and a wedged probe here would
      // wedge plugin init with it.
      const result = await withTimeout(
        (signal) => transportGet({ url: "/global/health", signal }),
        PROBE_TIMEOUT_MS,
      )
      const version = versionFromHealth(result)
      if (version) return { version }
      failures.push("the SDK transport health response omitted its version")
    } catch (error) {
      failures.push(
        `the SDK transport health request failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  try {
    // The whole exchange is inside the bound, not just the headers: a host
    // that answers and then stalls its body would otherwise wedge plugin init
    // exactly the way the deadline exists to prevent.
    const version = await withTimeout(async (signal) => {
      const response = await fetch(new URL("/global/health", serverUrl), {
        signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return versionFromHealth(await response.json())
    }, PROBE_TIMEOUT_MS)
    if (version) return { version }
    failures.push("/global/health omitted its version")
  } catch (error) {
    failures.push(
      `/global/health failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { reason: failures.join("; ") || "no version source was available" }
}

/** The four toast styles the host renders, server half and TUI half alike. */
export type ToastVariant = "info" | "success" | "warning" | "error"

/**
 * Show one toast. Returns false when nothing was shown — no TUI is attached,
 * or the call threw — so a caller that must not go unheard can fall back to
 * the log. Never throws and never rejects: a toast is decoration on top of
 * work that has already happened.
 */
export type ServerToast = (
  variant: ToastVariant,
  message: string,
  overrides?: { title?: string; directory?: string },
) => boolean

/**
 * The server half's toast, wrapped the way appLogger wraps app.log: bound to
 * `client.tui` (the SDK's showToast is a prototype method reading
 * `this._client`, so a detached reference throws synchronously), addressed to
 * a directory, and fire-and-forget with every failure swallowed.
 *
 * A server-half plugin cannot know whether a TUI is attached — the same plugin
 * runs under `opencode serve`, in CI, and behind a TUI — so "no toast surface"
 * is the normal case, not an error. `title` defaults per plugin because a
 * toast without one renders as a bare line among every other plugin's; pass
 * `overrides.title`/`overrides.directory` for the odd call that differs.
 */
export function serverToast(
  client: unknown,
  input: { directory: string; title?: string },
): ServerToast {
  return (variant, message, overrides) => {
    const tui = (
      client as { tui?: { showToast?: (input: unknown) => Promise<unknown> } }
    ).tui
    const show = tui?.showToast?.bind(tui)
    if (!show) return false
    const title = overrides?.title ?? input.title
    try {
      show({
        body: { ...(title ? { title } : {}), message, variant },
        query: { directory: overrides?.directory ?? input.directory },
      }).catch(() => {})
      return true
    } catch {
      // Toasting must never disturb the caller's real work.
      return false
    }
  }
}

// When the version guard trips, a plugin must stay inert — but not
// invisible. Its TUI companion keeps rendering the settings-file trust
// posture (the two halves are separate processes with no channel), so a
// silent `return {}` looks exactly like a healthy plugin that never acts.
// These hooks surface the disabled state once, at the first permission
// prompt the user actually sees; at plugin init no TUI is attached yet, so
// a toast shown then would be lost.
export function unsupportedVersionHooks(
  client: unknown,
  directory: string,
  message: string,
) {
  const toast = serverToast(client, { directory })
  let toasted = false
  return {
    event: async ({ event }: { event: unknown }) => {
      const type = (event as { type?: unknown } | undefined)?.type
      if (type !== "permission.asked" || toasted) return
      toasted = true
      // A missing TUI just means nobody is listening; the disabled state is
      // already in the log.
      toast("warning", message)
    },
  }
}

// ---------------------------------------------------------------------------
// Server-half plumbing: the app logger and the boot-time version gate
// ---------------------------------------------------------------------------

export type AppLogger = (
  level: "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => boolean

// The host's app.log route, wrapped so callers can log without caring whether
// the injected client carries one. Returns false when nothing was logged, so
// callers can fall back to the console for messages that must not vanish.
export function appLogger(client: unknown, service: string): AppLogger {
  return (level, message, extra) => {
    const app = (
      client as { app?: { log?: (input: unknown) => Promise<unknown> } }
    ).app
    // The SDK's log is a prototype method that reads `this._client`, so it
    // must stay bound to `client.app`; detached it throws synchronously.
    const appLog = app?.log?.bind(app)
    if (!appLog) return false
    try {
      appLog({ body: { service, level, message, extra } }).catch(() => {})
      return true
    } catch {
      // Logging must never disturb the caller's real work.
      return false
    }
  }
}

// The whole boot-time version gate every server half runs: probe the host,
// build the compat notice, and report it — app log first, console fallback so
// an incompatibility is never silent. Returns null inside the verified band;
// otherwise the notice, with the caller deciding what `disable` means for it
// (an inert `{}`, unsupportedVersionHooks, …). `label` is the plugin's human
// name for the message; `service` prefixes the console fallback. The message
// carries the probe-failure reason when there is one; `disable` is only ever
// set with a cleanly parsed version, so messages callers hand on to
// unsupportedVersionHooks never carry that suffix.
export async function reportServerCompat(input: {
  client: unknown
  serverUrl: URL
  label: string
  service: string
  log: AppLogger
  range?: string
}): Promise<CompatNotice | null> {
  const range = input.range ?? SUPPORTED_OPENCODE_RANGE
  const probe = await probeOpenCodeVersion(input.client, input.serverUrl)
  const notice = openCodeCompatNotice(probe.version, range, input.label)
  if (!notice) return null
  const message = probe.reason
    ? `${notice.message} (${probe.reason})`
    : notice.message
  if (
    !input.log("warn", message, {
      version: probe.version,
      compat: notice.compat,
      supported: range,
    })
  ) {
    try {
      console.warn(`${input.service}: ${message}`)
    } catch {
      // A missing logger must not turn an incompatibility into a crash.
    }
  }
  return { compat: notice.compat, disable: notice.disable, message }
}

// ---------------------------------------------------------------------------
// TUI-half plumbing
//
// TUI companions get no serverUrl and no injected server client; the host
// version comes from the TUI api itself, and warnings go to the TUI toast.
// The api parameter stays unknown-typed: this library deliberately depends on
// no @opencode-ai packages, and every read below is defensive against hosts
// that shape the probed fields differently.
// ---------------------------------------------------------------------------

// The host version as the TUI api exposes it. `app.version` is the documented
// field (the plugin package's TuiApp); the bare `version` fallback tolerates
// hosts that surface it at the top level instead.
export function tuiOpenCodeVersion(api: unknown): string | undefined {
  const candidate = api as { app?: { version?: unknown }; version?: unknown }
  const version = candidate.app?.version ?? candidate.version
  return typeof version === "string" && version.trim()
    ? version.trim()
    : undefined
}

// Surface a warning to the TUI user: toast when the UI is ready, console
// fallback so the message is never silent. `service` prefixes the console
// line. The TUI counterpart of an appLogger "warn" plus its console fallback.
export function warnTui(api: unknown, service: string, message: string) {
  try {
    const ui = (api as { ui?: { toast?: (toast: unknown) => void } }).ui
    if (ui?.toast) {
      ui.toast({ variant: "warning", message })
      return
    }
  } catch {
    // Fall through to stderr when the UI is not ready enough to show a toast.
  }
  try {
    console.warn(`${service}: ${message}`)
  } catch {
    // A warning must never make TUI startup fail.
  }
}

/**
 * The TUI half's toast, argument-ordered like ServerToast so the two halves of
 * one plugin read the same. `api.ui.toast` is a plain host callback — no
 * binding, no directory, and the TUI it draws into is by definition attached —
 * so unlike the server half this one has no failure leg to report; it exists
 * so the six identical wrappers across the suite become one.
 *
 * `title` renders above the message; plugins that pass one usually pass the
 * same string every time, hence the per-toast default.
 */
export function tuiToast(
  api: unknown,
  input: { title?: string } = {},
): (variant: ToastVariant, message: string, title?: string) => void {
  return (variant, message, title) => {
    const ui = (api as { ui?: { toast?: (toast: unknown) => void } }).ui
    const resolved = title ?? input.title
    ui?.toast?.({ variant, message, ...(resolved ? { title: resolved } : {}) })
  }
}

// The TUI-half version gate, mirroring reportServerCompat: build the compat
// notice and surface it through warnTui. Returns null inside the verified
// band; otherwise the notice, with the caller deciding whether `disable`
// means returning before wiring anything up.
export function reportTuiCompat(
  api: unknown,
  input: { label: string; service: string; range?: string },
): CompatNotice | null {
  const notice = openCodeCompatNotice(
    tuiOpenCodeVersion(api),
    input.range ?? SUPPORTED_OPENCODE_RANGE,
    input.label,
  )
  if (!notice) return null
  warnTui(api, input.service, notice.message)
  return notice
}

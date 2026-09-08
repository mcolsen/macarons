import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { unrefTimer, withTimeout } from "./async"

const PREFIX = "macarons.locality.v1"
const SERVICE = /^[a-z][a-z0-9-]{0,63}$/
const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
const COMMAND = new RegExp(
  `^${PREFIX.replaceAll(".", "\\.")}:([a-z][a-z0-9-]{0,63}):(probe|confirm|cleanup):(${UUID}):(${UUID})$`,
)
const RESPONSE = new RegExp(`^${UUID}$`)
const TTL_MS = 10_000
const MAX_PENDING = 32
const MAX_TIMEOUT_MS = 5_000
const CLEANUP_WAIT_MS = 250
// Timed-out transports/filesystem calls retain their client's slot until they
// settle. Repeated polling must not accumulate unbounded uncancellable work.
const verifierFlights = new WeakMap<object, number>()

function rootsOf(paths: readonly string[] | undefined): string[] | undefined {
  if (!paths?.length || paths.length > 12) return
  if (
    paths.some(
      (root) =>
        typeof root !== "string" ||
        !path.isAbsolute(root) ||
        root.includes("\0") ||
        root.length > 4096,
    )
  )
    return
  return paths.map((root) => path.resolve(root))
}

function filename(service: string, nonce: string): string {
  return `.macarons-locality-${service}-${nonce}`
}

function proof(
  service: string,
  nonce: string,
  token: string,
  roots: readonly string[],
  root: string,
  phase: "challenge" | "response" | "confirmed" = "challenge",
  response?: string,
): string {
  // Bind each file to its own root AND the complete ordered scope. A config
  // marker copied to state/project, or a proof of fewer roots, is not enough.
  return JSON.stringify({ service, nonce, token, roots, root, phase, response })
}

type Marker = {
  file: string
  handle: fs.FileHandle
  dev: number
  ino: number
  text: string
  close(): Promise<void>
}

async function openMarker(file: string, signal: AbortSignal): Promise<Marker> {
  const handle = await fs.open(
    file,
    constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    signal.removeEventListener("abort", onAbort)
    closing ??= handle.close().catch(() => {})
    return closing
  }
  const onAbort = () => {
    void close()
  }
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    signal.throwIfAborted()
    const stat = await handle.stat()
    signal.throwIfAborted()
    const named = await fs.lstat(file)
    signal.throwIfAborted()
    if (
      !stat.isFile() ||
      !named.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.nlink !== 1 ||
      stat.dev !== named.dev ||
      stat.ino !== named.ino ||
      stat.size > 65_536
    )
      throw new Error("unsafe locality marker")
    const buffer = Buffer.alloc(stat.size + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    signal.throwIfAborted()
    if (bytesRead !== stat.size) throw new Error("changed locality marker")
    const bytes = buffer.subarray(0, bytesRead)
    const text = bytes.toString("utf8")
    if (!bytes.equals(Buffer.from(text)))
      throw new Error("invalid locality encoding")
    return {
      file,
      handle,
      dev: stat.dev,
      ino: stat.ino,
      text,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

async function writeMarker(
  marker: Marker,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const stat = await marker.handle.stat()
  const named = await fs.lstat(marker.file)
  if (
    !stat.isFile() ||
    !named.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    stat.nlink !== 1 ||
    stat.dev !== marker.dev ||
    stat.ino !== marker.ino ||
    named.dev !== marker.dev ||
    named.ino !== marker.ino
  )
    throw new Error("replaced locality marker")
  signal.throwIfAborted()
  const bytes = Buffer.from(text)
  // Explicit position: openMarker's bounded read already advanced the handle.
  const { bytesWritten } = await marker.handle.write(bytes, 0, bytes.length, 0)
  if (bytesWritten !== bytes.length) throw new Error("short locality write")
  await marker.handle.truncate(bytes.length)
}

/**
 * Server half of a temporary-file-only locality check. Only the server's resolver
 * supplies paths; commands contain no paths or policy settings. Construction
 * does no I/O, so instance-scoped SDK lookups cannot deadlock plugin bootstrap.
 */
export function createFilesystemLocalityResponder(input: {
  service: string
  paths: (signal: AbortSignal) => Promise<readonly string[] | undefined>
}): {
  handle(event: unknown): Promise<boolean>
  dispose(): Promise<void>
} {
  type Pending = {
    token: string
    controller: AbortController
    timer?: ReturnType<typeof setTimeout>
    files: string[]
    roots?: string[]
    identities: Map<string, { dev: number; ino: number }>
    confirming?: boolean
    done: Promise<void>
    cleanup?: Promise<void>
  }
  const pending = new Map<string, Pending>()
  let disposed = false

  const cleanup = (nonce: string, entry: Pending): Promise<void> => {
    entry.controller.abort()
    clearTimeout(entry.timer)
    entry.cleanup ??= (async () => {
      // An open/write already in flight must finish before unlinking. Keep its
      // slot until then: stalled filesystem I/O must not create unlimited work.
      await entry.done
      await Promise.all(
        entry.files.map((file) => fs.unlink(file).catch(() => {})),
      )
      pending.delete(nonce)
    })()
    return entry.cleanup
  }

  const wait = async (nonce: string, entry: Pending): Promise<void> => {
    // Bound the public wait, not the I/O promise. Cleanup retains ownership of
    // late opens/writes, including confirmation, until they really settle.
    await withTimeout(() => entry.done, TTL_MS, {
      signal: entry.controller.signal,
    }).catch(() => entry.controller.abort())
    if (entry.controller.signal.aborted)
      await withTimeout(() => cleanup(nonce, entry), CLEANUP_WAIT_MS).catch(
        () => {},
      )
  }

  return {
    async handle(event) {
      let match: RegExpExecArray | null
      try {
        const candidate = event as {
          type?: unknown
          properties?: { command?: unknown }
        } | null
        const command = candidate?.properties?.command
        if (
          candidate?.type !== "tui.command.execute" ||
          typeof command !== "string" ||
          command.length > 200
        )
          return false
        match = COMMAND.exec(command)
        // RegExp's $ also accepts a final newline; commands must match in full.
        if (match?.[0] !== command) return false
      } catch {
        return false
      }
      if (!match || match[1] !== input.service) return false
      const [, , action, nonce, token] = match
      if (!nonce || !token) return false
      if (disposed) return true
      const existing = pending.get(nonce)
      if (action === "cleanup") {
        if (existing?.token === token)
          await withTimeout(
            () => cleanup(nonce, existing),
            CLEANUP_WAIT_MS,
          ).catch(() => {})
        return true
      }
      if (action === "confirm") {
        if (
          !existing ||
          existing.token !== token ||
          existing.confirming ||
          existing.controller.signal.aborted
        )
          return true
        existing.confirming = true
        // One confirmation job per challenge, serialized behind creation. The
        // response token comes ONLY from the files, never from this command.
        existing.done = existing.done.then(async () => {
          const markers: Marker[] = []
          try {
            const roots = existing.roots
            if (!roots) throw new Error("unresolved roots")
            let response: string | undefined
            for (const root of new Set(roots)) {
              existing.controller.signal.throwIfAborted()
              const file = path.join(root, filename(input.service, nonce))
              const marker = await openMarker(file, existing.controller.signal)
              markers.push(marker)
              const identity = existing.identities.get(file)
              if (marker.dev !== identity?.dev || marker.ino !== identity?.ino)
                throw new Error("replaced locality marker")
              const value = JSON.parse(marker.text)?.response
              if (
                typeof value !== "string" ||
                RESPONSE.exec(value)?.[0] !== value
              )
                throw new Error("missing locality response")
              response ??= value
              if (
                marker.text !==
                proof(
                  input.service,
                  nonce,
                  token,
                  roots,
                  root,
                  "response",
                  response,
                )
              )
                throw new Error("mismatched locality response")
            }
            // Validate ALL roots before acknowledging any of them.
            for (const marker of markers) {
              await writeMarker(
                marker,
                proof(
                  input.service,
                  nonce,
                  token,
                  roots,
                  path.dirname(marker.file),
                  "confirmed",
                  response,
                ),
                existing.controller.signal,
              )
            }
          } catch {
            existing.controller.abort()
          } finally {
            await Promise.all(markers.map((marker) => marker.close()))
          }
        })
        await wait(nonce, existing)
        return true
      }
      if (existing || pending.size >= MAX_PENDING) return true
      const entry: Pending = {
        token,
        controller: new AbortController(),
        files: [],
        identities: new Map(),
        done: Promise.resolve(),
      }
      pending.set(nonce, entry)
      entry.timer = unrefTimer(
        setTimeout(() => void cleanup(nonce, entry), TTL_MS),
      )
      // Install ownership before dispatching a resolver that can re-enter hooks.
      entry.done = Promise.resolve().then(async () => {
        try {
          entry.controller.signal.throwIfAborted()
          // Own the actual resolver, not a timeout wrapper: it may still be in
          // uncancellable I/O after the public handle/dispose waits have ended.
          const roots = rootsOf(await input.paths(entry.controller.signal))
          entry.controller.signal.throwIfAborted()
          if (!roots) throw new Error("unresolved roots")
          entry.roots = roots
          for (const root of new Set(roots)) {
            if (entry.controller.signal.aborted) return
            const file = path.join(root, filename(input.service, nonce))
            // Exclusive creation never follows a pre-existing symlink or
            // overwrites anything. Do not mkdir: roots must already exist.
            const handle = await fs.open(file, "wx", 0o600)
            entry.files.push(file)
            try {
              const { dev, ino } = await handle.stat()
              entry.identities.set(file, { dev, ino })
              if (entry.controller.signal.aborted) return
              await handle.writeFile(
                proof(input.service, nonce, token, roots, root),
              )
            } finally {
              await handle.close()
            }
          }
        } catch {
          entry.controller.abort()
        }
      })
      await wait(nonce, entry)
      return true
    },
    async dispose() {
      disposed = true
      await withTimeout(
        () =>
          Promise.all(
            [...pending].map(([nonce, entry]) => cleanup(nonce, entry)),
          ),
        CLEANUP_WAIT_MS,
      ).catch(() => {})
    },
  }
}

/**
 * Prove bidirectional sharing of every required root using temporary markers,
 * never policy writes. `api` is TuiPluginApi (SDK v2); its lifecycle signal cancels the check.
 * Paths are the ordered config, policy-containing directories, and project
 * roots that both halves require. The helper never creates directories.
 * No URL, matching path string, cached marker, or successful HTTP reply is
 * evidence on its own. This is shared-filesystem evidence, not server identity
 * authentication or a defense against a malicious server/live file relay.
 */
export async function verifyFilesystemLocality(
  api: unknown,
  input: {
    service: string
    paths: readonly string[]
    directory: string
    timeoutMs?: number
  },
): Promise<boolean> {
  const controller = new AbortController()
  let publish:
    | ((command: string, signal: AbortSignal) => Promise<unknown>)
    | undefined
  let challenge: string | undefined
  let deadline = 0
  let lifecycleSignal: AbortSignal | undefined
  let verified = false
  let filesystem: Promise<boolean> = Promise.resolve(false)
  let cleaning: Promise<unknown> = Promise.resolve()
  const requests: Promise<unknown>[] = []
  let owner: object | undefined
  const touched = new Map<string, { dev: number; ino: number }>()
  try {
    const roots = rootsOf(input.paths)
    if (
      SERVICE.exec(input.service)?.[0] !== input.service ||
      !roots ||
      !path.isAbsolute(input.directory)
    )
      return false
    const host = api as {
      client?: {
        tui?: {
          publish?: (parameters: unknown, options: unknown) => Promise<unknown>
        }
      }
      lifecycle?: { signal?: AbortSignal }
    } | null
    const tui = host?.client?.tui
    if (typeof tui?.publish !== "function") return false
    lifecycleSignal = host?.lifecycle?.signal
    const signal = lifecycleSignal
      ? AbortSignal.any([controller.signal, lifecycleSignal])
      : controller.signal
    if (signal.aborted) return false
    const timeoutMs = input.timeoutMs ?? 3_000
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false
    const flights = verifierFlights.get(tui) ?? 0
    if (flights >= MAX_PENDING) return false
    owner = tui
    verifierFlights.set(owner, flights + 1)
    const budget = Math.min(timeoutMs, MAX_TIMEOUT_MS)
    deadline = Date.now() + budget
    const nonce = randomUUID()
    const token = randomUUID()
    const send = tui.publish.bind(tui)
    publish = (command, signal) => {
      const request = (async () =>
        send(
          {
            directory: input.directory,
            body: { type: "tui.command.execute", properties: { command } },
          },
          { signal },
        ))()
      requests.push(request)
      return request
    }
    challenge = `${nonce}:${token}`
    verified = await withTimeout(
      async (signal) => {
        const result = await publish?.(
          `${PREFIX}:${input.service}:probe:${challenge}`,
          signal,
        )
        if ((result as { error?: unknown } | null)?.error != null) return false
        let response: string | undefined
        for (const phase of ["challenge", "confirmed"] as const) {
          while (!signal.aborted) {
            filesystem = (async () => {
              const matches = (marker: Marker | undefined): marker is Marker =>
                marker !== undefined &&
                (phase === "challenge" ||
                  (marker.dev === touched.get(marker.file)?.dev &&
                    marker.ino === touched.get(marker.file)?.ino)) &&
                marker.text ===
                  proof(
                    input.service,
                    nonce,
                    token,
                    roots,
                    path.dirname(marker.file),
                    phase,
                    response,
                  )
              const markers = await Promise.all(
                [...new Set(roots)].map(async (root) => {
                  const marker = await openMarker(
                    path.join(root, filename(input.service, nonce)),
                    signal,
                  ).catch(() => undefined)
                  // Track verified siblings independently. One stalled root
                  // must not prevent their handles/copies from being cleaned.
                  if (matches(marker))
                    touched.set(marker.file, {
                      dev: marker.dev,
                      ino: marker.ino,
                    })
                  return marker
                }),
              )
              let valid = false
              try {
                valid = markers.every(matches)
                if (valid) {
                  signal.throwIfAborted()
                  if (phase === "challenge") {
                    response = randomUUID()
                    for (const marker of markers) {
                      if (marker)
                        await writeMarker(
                          marker,
                          proof(
                            input.service,
                            nonce,
                            token,
                            roots,
                            path.dirname(marker.file),
                            "response",
                            response,
                          ),
                          signal,
                        )
                    }
                  }
                }
              } finally {
                await Promise.all(markers.map((marker) => marker?.close()))
              }
              return valid
            })()
            if (await filesystem) break
            await delay(25, undefined, { signal, ref: false })
          }
          if (signal.aborted) return false
          if (phase === "challenge") {
            // The response is deliberately absent from HTTP: the server must
            // have read our writes through its own filesystem view to echo it.
            const confirmed = await publish?.(
              `${PREFIX}:${input.service}:confirm:${challenge}`,
              signal,
            )
            if ((confirmed as { error?: unknown } | null)?.error != null)
              return false
          }
        }
        return true
      },
      // Reserve a little of the same total budget for prompt marker cleanup.
      budget - Math.min(100, budget / 4),
      { signal },
    )
  } catch {
    return false
  } finally {
    controller.abort()
    if (publish && challenge) {
      // Await cleanup when the budget permits, without extending the total
      // deadline. Expiration/dispose also cover lost or reordered HTTP requests.
      const remaining = deadline - Date.now()
      const cleanup = withTimeout(
        (signal) => {
          cleaning = Promise.all([
            publish?.(
              `${PREFIX}:${input.service}:cleanup:${challenge}`,
              signal,
            ).catch(() => {}),
            // A timed-out filesystem call can settle after verify returns. Keep
            // its cleanup attached until then; never race deletion against writes.
            filesystem
              .catch(() => false)
              .then(() =>
                Promise.all(
                  [...touched].map(async ([file, identity]) => {
                    try {
                      const stat = await fs.lstat(file)
                      if (
                        stat.isFile() &&
                        stat.dev === identity.dev &&
                        stat.ino === identity.ino
                      )
                        await fs.unlink(file)
                    } catch {}
                  }),
                ),
              ),
          ])
          return cleaning
        },
        Math.max(1, Math.min(250, remaining)),
      ).catch(() => {})
      if (remaining > 0) await cleanup
    }
    if (owner) {
      const client = owner
      void Promise.allSettled([...requests, filesystem, cleaning]).then(() => {
        const count = verifierFlights.get(client) ?? 1
        if (count <= 1) verifierFlights.delete(client)
        else verifierFlights.set(client, count - 1)
      })
    }
  }
  return verified && !lifecycleSignal?.aborted
}

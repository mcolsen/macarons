import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  createFilesystemLocalityResponder,
  verifyFilesystemLocality,
} from "../src/index"

const service = "test-permissions"
const prefix = `macarons.locality.v1:${service}`
type Event = { type: string; properties: { command: string } }
type Responder = ReturnType<typeof createFilesystemLocalityResponder>
let sandbox: string
let roots: string[]
let responders: Responder[]

beforeEach(async () => {
  sandbox = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "locality-")),
  )
  roots = ["config", "state", "project"].map((name) => path.join(sandbox, name))
  await Promise.all(roots.map((root) => fs.mkdir(root)))
  responders = []
})

afterEach(async () => {
  await Promise.all(responders.map((responder) => responder.dispose()))
  await fs.rm(sandbox, { recursive: true, force: true })
})

function responder(
  paths: (
    signal: AbortSignal,
  ) => Promise<readonly string[] | undefined> = async () => roots,
) {
  const result = createFilesystemLocalityResponder({ service, paths })
  responders.push(result)
  return result
}

function event(
  nonce: string = randomUUID(),
  token: string = randomUUID(),
): Event {
  return {
    type: "tui.command.execute",
    properties: { command: `${prefix}:probe:${nonce}:${token}` },
  }
}

function cleanup(challenge: Event): Event {
  return {
    ...challenge,
    properties: {
      command: challenge.properties.command.replace(":probe:", ":cleanup:"),
    },
  }
}

function marker(root: string, challenge: Event): string {
  return path.join(
    root,
    `.macarons-locality-${service}-${challenge.properties.command.split(":")[3]}`,
  )
}

function transport(deliver: (event: Event) => Promise<unknown>) {
  const calls: { event: Event; directory: string; signal: AbortSignal }[] = []
  const controller = new AbortController()
  const tui = {
    async publish(
      this: unknown,
      parameters: { directory: string; body: Event },
      options: { signal: AbortSignal },
    ) {
      expect(this).toBe(tui)
      expect(parameters.directory).toBe(roots[2] as string)
      expect(parameters.body.type).toBe("tui.command.execute")
      expect(options.signal).toBeInstanceOf(AbortSignal)
      calls.push({
        event: parameters.body,
        directory: parameters.directory,
        signal: options.signal,
      })
      return deliver(parameters.body)
    },
  }
  return {
    api: { client: { tui }, lifecycle: { signal: controller.signal } },
    calls,
    controller,
  }
}

function verify(api: unknown, paths = roots, timeoutMs = 250) {
  return verifyFilesystemLocality(api, {
    service,
    paths,
    directory: roots[2] as string,
    timeoutMs,
  })
}

async function empty() {
  expect(await Promise.all(roots.map((root) => fs.readdir(root)))).toEqual([
    [],
    [],
    [],
  ])
}

describe("filesystem locality proof", () => {
  test("shared roots succeed through SDK v2 regardless of a network URL, and clean before return", async () => {
    const server = responder()
    const { api, calls } = transport(async (challenge) => {
      expect(await server.handle(challenge)).toBe(true)
      if (challenge.properties.command.includes(":probe:")) {
        for (const root of roots) {
          const stat = await fs.stat(marker(root, challenge))
          expect(stat.mode & 0o777).toBe(0o600)
          const data = JSON.parse(
            await fs.readFile(marker(root, challenge), "utf8"),
          )
          expect(data).toMatchObject({ service, roots, root })
          expect(data.token).toBe(challenge.properties.command.split(":")[4])
        }
      }
      return { data: true }
    })
    Object.assign(api, { serverUrl: "https://shared-network.example:4096" })
    expect(await verify(api)).toBe(true)
    expect(calls).toHaveLength(3)
    expect(calls[1]?.event.properties.command).toBe(
      calls[0]?.event.properties.command.replace(
        ":probe:",
        ":confirm:",
      ) as string,
    )
    expect(calls[2]?.event).toEqual(cleanup(calls[0]?.event as Event))
    await empty()
  })

  test("directory-scoped asynchronous event delivery is polled rather than treating HTTP success as proof", async () => {
    const server = responder()
    const jobs: Promise<unknown>[] = []
    const { api } = transport(async (challenge) => {
      if (challenge.properties.command.includes(":probe:")) {
        jobs.push(delay(35).then(() => server.handle(challenge)))
      } else await server.handle(challenge)
      return { data: true }
    })
    expect(await verify(api)).toBe(true)
    await Promise.all(jobs)
    await empty()
  })

  test.each([
    "http://localhost:4096",
    "http://127.0.0.1",
    "http://opencode.internal",
    "https://remote.example",
  ])(
    "matching reported paths and %s are not evidence without server writes",
    async (serverUrl) => {
      const { api } = transport(async () => ({ data: true }))
      Object.assign(api, {
        serverUrl,
        path: { config: roots[0], state: roots[1], worktree: roots[2] },
      })
      expect(await verify(api, roots, 70)).toBe(false)
      await empty()
    },
  )

  test("different mounts and partially shared roots fail closed", async () => {
    const other = path.join(sandbox, "other-state")
    await fs.mkdir(other)
    for (const serverRoots of [
      [roots[0] as string, other, roots[2] as string],
      [other],
    ]) {
      const server = responder(async () => serverRoots)
      const { api } = transport(async (challenge) => {
        await server.handle(challenge)
        return { data: true }
      })
      expect(await verify(api, roots, 70)).toBe(false)
      await empty()
      expect(await fs.readdir(other)).toEqual([])
    }
  })

  test("two-root persist scope and duplicate roots work, but a missing/reordered scope does not", async () => {
    for (const selected of [
      [roots[0] as string, roots[2] as string],
      [roots[0] as string, roots[0] as string, roots[2] as string],
    ]) {
      const server = responder(async () => selected)
      const { api } = transport(async (challenge) => {
        await server.handle(challenge)
        return { data: true }
      })
      expect(await verify(api, selected)).toBe(true)
      expect(await verify(api, [...selected].reverse(), 70)).toBe(false)
      expect(await verify(api, selected.slice(0, 1), 70)).toBe(false)
      await empty()
    }
  })

  test("old/missing APIs and old/missing server halves fail closed without TUI writes", async () => {
    for (const api of [
      undefined,
      null,
      {},
      { client: {} },
      {
        client: {
          tui: {
            executeCommand: () => {
              throw new Error("must not call")
            },
          },
        },
      },
    ]) {
      expect(await verify(api)).toBe(false)
    }
    const old = transport(async () => ({ data: true }))
    expect(await verify(old.api, roots, 70)).toBe(false)
    await empty()
  })

  test("invalid service, roots, and timeout options do not dispatch", async () => {
    const { api, calls } = transport(async () => ({ data: true }))
    for (const invalid of ["../escape", "bad/service", `${service}\n`, ""]) {
      expect(
        await verifyFilesystemLocality(api, {
          service: invalid,
          paths: roots,
          directory: roots[2] as string,
        }),
      ).toBe(false)
    }
    for (const paths of [[], ["relative"], Array(13).fill(sandbox)]) {
      expect(await verify(api, paths)).toBe(false)
    }
    for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await verify(api, roots, timeout)).toBe(false)
    }
    expect(calls).toHaveLength(0)
    await empty()
  })

  test("every verification uses a new nonce and token; stale copies cannot satisfy it", async () => {
    const server = responder()
    const snapshots: string[] = []
    const first = transport(async (challenge) => {
      await server.handle(challenge)
      if (challenge.properties.command.includes(":probe:")) {
        for (const root of roots)
          snapshots.push(await fs.readFile(marker(root, challenge), "utf8"))
      }
      return { data: true }
    })
    expect(await verify(first.api)).toBe(true)
    const replay = transport(async (challenge) => {
      if (challenge.properties.command.includes(":probe:")) {
        await Promise.all(
          roots.map((root, i) =>
            fs.writeFile(marker(root, challenge), snapshots[i] as string, {
              mode: 0o600,
            }),
          ),
        )
      } else {
        await Promise.all(
          roots.map((root) => fs.unlink(marker(root, challenge))),
        )
      }
      return { data: true }
    })
    expect(await verify(replay.api, roots, 70)).toBe(false)
    const before = first.calls[0]?.event.properties.command.split(":")
    const after = replay.calls[0]?.event.properties.command.split(":")
    expect(after?.[3]).not.toBe(before?.[3])
    expect(after?.[4]).not.toBe(before?.[4])
    await empty()
  })

  test.each(["copied scope", "token", "permissions", "symlink", "oversize"])(
    "rejects a %s marker",
    async (fault) => {
      const server = responder()
      const { api } = transport(async (challenge) => {
        await server.handle(challenge)
        if (challenge.properties.command.includes(":probe:")) {
          const file = marker(roots[1] as string, challenge)
          if (fault === "copied scope")
            await fs.copyFile(marker(roots[0] as string, challenge), file)
          if (fault === "token") {
            const content = JSON.parse(await fs.readFile(file, "utf8"))
            content.token = randomUUID()
            await fs.writeFile(file, JSON.stringify(content))
          }
          if (fault === "permissions") await fs.chmod(file, 0o644)
          if (fault === "symlink") {
            const target = path.join(sandbox, "copied-marker")
            await fs.rename(file, target)
            await fs.symlink(target, file)
          }
          if (fault === "oversize")
            await fs.writeFile(file, "x".repeat(100_000))
        }
        return { data: true }
      })
      expect(await verify(api, roots, 70)).toBe(false)
      await empty()
    },
  )

  test("transport errors fail even after valid markers were written and still clean up", async () => {
    for (const throws of [false, true]) {
      const server = responder()
      const { api } = transport(async (challenge) => {
        await server.handle(challenge)
        if (challenge.properties.command.includes(":probe:")) {
          if (throws) throw new Error("connection reset")
          return { error: "not authorized" }
        }
        return { data: true }
      })
      expect(await verify(api)).toBe(false)
      await empty()
    }
  })

  test("one deadline bounds HTTP plus polling and aborts an uncooperative transport", async () => {
    const signals: AbortSignal[] = []
    const api = {
      client: {
        tui: {
          publish: (_input: unknown, options: { signal: AbortSignal }) => {
            signals.push(options.signal)
            return new Promise(() => {})
          },
        },
      },
    }
    const start = performance.now()
    expect(await verify(api, roots, 80)).toBe(false)
    expect(performance.now() - start).toBeLessThan(200)
    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    await empty()
  })

  test("local cleanup removes verified markers when cleanup HTTP fails; dispose remains safe", async () => {
    const server = responder()
    const { api } = transport(async (challenge) => {
      if (challenge.properties.command.includes(":cleanup:"))
        throw new Error("offline")
      await server.handle(challenge)
      return { data: true }
    })
    expect(await verify(api)).toBe(true)
    await empty()
    await server.dispose()
    await empty()
  })

  test("lifecycle cancellation stops HTTP/polling, performs cleanup, and rejects an already-disposed API", async () => {
    const server = responder()
    const { api, calls, controller } = transport(async (challenge) => {
      await server.handle(challenge)
      if (challenge.properties.command.includes(":probe:")) controller.abort()
      return { data: true }
    })
    expect(await verify(api)).toBe(false)
    expect(calls[0]?.signal.aborted).toBe(true)
    await empty()
    expect(await verify(api)).toBe(false)
    expect(calls).toHaveLength(2)
  })

  test("concurrent clients cannot remove each other's fresh markers", async () => {
    const server = responder()
    const { api, calls } = transport(async (challenge) => {
      await server.handle(challenge)
      return { data: true }
    })
    expect(
      await Promise.all(Array.from({ length: 12 }, () => verify(api))),
    ).toEqual(Array(12).fill(true))
    expect(
      new Set(
        calls
          .filter((call) => call.event.properties.command.includes(":probe:"))
          .map((call) => call.event.properties.command),
      ).size,
    ).toBe(12)
    await empty()
  })

  test("disposal during cleanup cannot return a positive proof to a dead TUI", async () => {
    const server = responder()
    const { api, controller } = transport(async (challenge) => {
      await server.handle(challenge)
      if (challenge.properties.command.includes(":cleanup:")) controller.abort()
      return { data: true }
    })
    expect(await verify(api)).toBe(false)
    await empty()
  })

  test("confirmation learns the fresh response only from files and acknowledges every root", async () => {
    const server = responder()
    let response: string | undefined
    const { api, calls } = transport(async (challenge) => {
      const confirming = challenge.properties.command.includes(":confirm:")
      if (confirming) {
        for (const root of roots) {
          const data = JSON.parse(
            await fs.readFile(marker(root, challenge), "utf8"),
          )
          expect(data.phase).toBe("response")
          response ??= data.response
          expect(data.response).toBe(response)
          expect(challenge.properties.command).not.toContain(data.response)
        }
      }
      await server.handle(challenge)
      if (confirming) {
        for (const root of roots) {
          expect(
            JSON.parse(await fs.readFile(marker(root, challenge), "utf8")),
          ).toMatchObject({
            phase: "confirmed",
            response,
          })
        }
      }
      return { data: true }
    })
    expect(await verify(api)).toBe(true)
    expect(typeof response).toBe("string")
    expect(calls).toHaveLength(3)
    for (const call of calls)
      expect(JSON.stringify(call.event)).not.toContain(response as string)
    await empty()
  })

  test.each(["all roots", "state only", "policy subdirectory"])(
    "readable copy-on-write mounts (%s) cannot prove that policy writes reach the server",
    async (overlay) => {
      const serverView = new AsyncLocalStorage<boolean>()
      const policyDir = path.join(roots[0] as string, "policy")
      const scope =
        overlay === "policy subdirectory"
          ? [
              roots[0] as string,
              policyDir,
              roots[1] as string,
              roots[2] as string,
            ]
          : roots
      if (overlay === "policy subdirectory") await fs.mkdir(policyDir)
      const privateRoots = scope.map((root) =>
        path.join(sandbox, `upper-${path.basename(root)}`),
      )
      await Promise.all(privateRoots.map((root) => fs.mkdir(root)))
      const mapped = (file: Parameters<typeof fs.open>[0]) => {
        if (serverView.getStore() || typeof file !== "string") return file
        const index = scope.findIndex(
          (root, i) =>
            (overlay === "all roots" || i === 1) &&
            file.startsWith(path.join(root, `.macarons-locality-${service}-`)),
        )
        return index < 0
          ? file
          : path.join(privateRoots[index] as string, path.basename(file))
      }
      const originalOpen = fs.open.bind(fs)
      const originalLstat = fs.lstat.bind(fs)
      const originalUnlink = fs.unlink.bind(fs)
      const open = spyOn(fs, "open").mockImplementation(
        async (file, flags, mode) => {
          const target = mapped(file)
          if (target !== file) {
            expect(flags).toBe(
              constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            )
            // A read-write open copies the fresh lower marker into a private upper
            // inode. Future reads see that copy; writes never reach the lower view.
            await fs
              .copyFile(file, target, constants.COPYFILE_EXCL)
              .catch((error) => {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST")
                  throw error
              })
          }
          return originalOpen(target, flags, mode)
        },
      )
      const lstat = spyOn(fs, "lstat").mockImplementation(((file, options) =>
        originalLstat(mapped(file), options)) as typeof fs.lstat)
      const unlink = spyOn(fs, "unlink").mockImplementation((file) =>
        originalUnlink(mapped(file)),
      )
      const server = responder(async () => scope)
      let confirmed = false
      try {
        const { api } = transport((challenge) =>
          serverView.run(true, async () => {
            if (challenge.properties.command.includes(":confirm:")) {
              confirmed = true
              for (let i = 0; i < scope.length; i++) {
                const lower = JSON.parse(
                  await fs.readFile(
                    marker(scope[i] as string, challenge),
                    "utf8",
                  ),
                )
                if (overlay === "all roots" || i === 1) {
                  const upper = JSON.parse(
                    await fs.readFile(
                      marker(privateRoots[i] as string, challenge),
                      "utf8",
                    ),
                  )
                  expect(lower.phase).toBe("challenge")
                  expect(lower.response).toBeUndefined()
                  expect(upper.phase).toBe("response")
                  expect(challenge.properties.command).not.toContain(
                    upper.response,
                  )
                } else expect(lower.phase).toBe("response")
              }
            }
            await server.handle(challenge)
            return { data: true }
          }),
        )
        expect(await verify(api, scope, 150)).toBe(false)
        expect(confirmed).toBe(true)
      } finally {
        open.mockRestore()
        lstat.mockRestore()
        unlink.mockRestore()
        await server.dispose()
      }
      if (overlay === "policy subdirectory") {
        expect(await fs.readdir(policyDir)).toEqual([])
        await fs.rmdir(policyDir)
      }
      await empty()
      expect(
        await Promise.all(privateRoots.map((root) => fs.readdir(root))),
      ).toEqual(scope.map(() => []))
    },
  )

  test("all twelve required roots can be proved without creating any directories", async () => {
    const extra = Array.from({ length: 9 }, (_, i) =>
      path.join(sandbox, `policy-${i}`),
    )
    await Promise.all(extra.map((dir) => fs.mkdir(dir)))
    const scope = [...roots, ...extra]
    const server = responder(async () => scope)
    const { api } = transport(async (challenge) => {
      await server.handle(challenge)
      return { data: true }
    })
    expect(await verify(api, scope)).toBe(true)
    expect(await Promise.all(scope.map((root) => fs.readdir(root)))).toEqual(
      scope.map(() => []),
    )
  })

  test.each([
    "missing response",
    "different response",
    "wrong phase",
    "replaced inode",
    "symlink",
    "permissions",
  ])(
    "server confirmation rejects %s before acknowledging any root",
    async (fault) => {
      const server = responder()
      const { api } = transport(async (challenge) => {
        if (challenge.properties.command.includes(":confirm:")) {
          const file = marker(roots[1] as string, challenge)
          const content = JSON.parse(await fs.readFile(file, "utf8"))
          if (fault === "missing response") delete content.response
          if (fault === "different response") content.response = randomUUID()
          if (fault === "wrong phase") content.phase = "confirmed"
          if (fault === "replaced inode" || fault === "symlink") {
            const target = path.join(sandbox, "original-marker")
            await fs.rename(file, target)
            if (fault === "replaced inode") await fs.copyFile(target, file)
            else await fs.symlink(target, file)
          } else if (fault === "permissions") await fs.chmod(file, 0o644)
          else await fs.writeFile(file, JSON.stringify(content))
        }
        await server.handle(challenge)
        return { data: true }
      })
      expect(await verify(api, roots, 100)).toBe(false)
      await empty()
    },
  )

  test.each(["ignored", "error", "wrong response", "partial acknowledgment"])(
    "a %s confirmation fails closed",
    async (fault) => {
      const server = responder()
      const { api } = transport(async (challenge) => {
        const confirming = challenge.properties.command.includes(":confirm:")
        if (confirming && fault === "ignored") return { data: true }
        await server.handle(challenge)
        if (confirming) {
          if (fault === "error") return { error: "lost acknowledgment" }
          const file = marker(roots[2] as string, challenge)
          const content = JSON.parse(await fs.readFile(file, "utf8"))
          if (fault === "wrong response") content.response = randomUUID()
          if (fault === "partial acknowledgment") content.phase = "response"
          await fs.writeFile(file, JSON.stringify(content))
        }
        return { data: true }
      })
      expect(await verify(api, roots, 100)).toBe(false)
      await empty()
    },
  )
})

describe("filesystem locality responder", () => {
  test("construction does not resolve paths; malformed/unrelated commands cause no I/O", async () => {
    let probes = 0
    const server = responder(async () => {
      probes++
      return roots
    })
    expect(probes).toBe(0)
    const good = event()
    const command = good.properties.command
    const invalid = [
      null,
      {},
      { event: good },
      { ...good, type: "permission.asked" },
      ...[
        "session.new",
        command.replace(service, "other-plugin"),
        `${command}\n`,
        `${command}:extra`,
        command.replace(":probe:", ":write:"),
        `${prefix}:probe:../../escape:${randomUUID()}`,
        `${prefix}:probe:${randomUUID()}:bad-token`,
        command.replace("macarons.locality.v1", "macaronsXlocalityXv1"),
      ].map((command) => ({ ...good, properties: { command } })),
      {
        get type() {
          throw new Error("hostile getter")
        },
      },
    ]
    for (const candidate of invalid)
      expect(await server.handle(candidate)).toBe(false)
    expect(probes).toBe(0)
    await empty()
  })

  test("extra request paths are ignored; writes use only the server's resolved roots", async () => {
    const server = responder()
    const challenge = event()
    const outside = path.join(sandbox, "never-created")
    expect(
      await server.handle({
        ...challenge,
        paths: [outside],
        properties: { ...challenge.properties, paths: [outside] },
      }),
    ).toBe(true)
    expect(await fs.exists(outside)).toBe(false)
    for (const root of roots)
      expect(await fs.exists(marker(root, challenge))).toBe(true)
    await server.dispose()
    await empty()
  })

  test("unresolved, relative, missing and failed roots fail safely without mkdir or leftovers", async () => {
    for (const paths of [
      undefined,
      [],
      ["relative"],
      ["/bad\0path"],
      Array(13).fill(sandbox),
      [roots[0] as string, path.join(sandbox, "missing")],
    ]) {
      const server = responder(async () => paths)
      expect(await server.handle(event())).toBe(true)
      await empty()
    }
    const broken = responder(async () => {
      throw new Error("host /path failed")
    })
    expect(await broken.handle(event())).toBe(true)
    await empty()
  })

  test("exclusive creation does not overwrite or unlink existing files/symlinks", async () => {
    for (const link of [false, true]) {
      const challenge = event()
      const file = marker(roots[1] as string, challenge)
      const target = path.join(sandbox, `target-${link}`)
      await fs.writeFile(target, "untouched")
      if (link) await fs.symlink(target, file)
      else await fs.writeFile(file, "untouched")
      const server = responder()
      expect(await server.handle(challenge)).toBe(true)
      await server.dispose()
      expect(await fs.readFile(file, "utf8")).toBe("untouched")
      expect(await fs.readFile(target, "utf8")).toBe("untouched")
      await fs.unlink(file)
      await empty()
    }
  })

  test("duplicate probes are idempotent; a mismatched cleanup token cannot interfere", async () => {
    let probes = 0
    const server = responder(async () => {
      probes++
      return roots
    })
    const challenge = event()
    await server.handle(challenge)
    await server.handle(challenge)
    expect(probes).toBe(1)
    const wrong = cleanup(
      event(challenge.properties.command.split(":")[3], randomUUID()),
    )
    await server.handle(wrong)
    expect(await fs.exists(marker(roots[0] as string, challenge))).toBe(true)
    await server.handle(cleanup(challenge))
    await empty()
  })

  test.each(["cleanup", "dispose"])(
    "%s during path resolution cancels pending writes, even if the resolver ignores cancellation",
    async (stop) => {
      const ready = Promise.withResolvers<readonly string[]>()
      const server = responder(() => ready.promise)
      const challenge = event()
      const pending = server.handle(challenge)
      if (stop === "cleanup") await server.handle(cleanup(challenge))
      else await server.dispose()
      ready.resolve(roots)
      expect(await pending).toBe(true)
      await empty()
      if (stop === "dispose") {
        expect(await server.handle(event())).toBe(true)
        await empty()
      }
    },
  )

  test("pending writes/markers are capped and dispose clears the cap's files and timers", async () => {
    let probes = 0
    const server = responder(async () => {
      probes++
      return roots
    })
    await Promise.all(Array.from({ length: 48 }, () => server.handle(event())))
    expect(probes).toBe(32)
    for (const root of roots) expect(await fs.readdir(root)).toHaveLength(32)
    await server.dispose()
    await server.dispose()
    await empty()
  })

  test("cancelled resolver jobs retain their slots until the underlying work settles", async () => {
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const signals: AbortSignal[] = []
    const policyDir = path.join(sandbox, "must-not-create")
    let mkdirAttempts = 0
    const server = responder(async (signal) => {
      signals.push(signal)
      if (signals.length === 32) entered.resolve()
      await release.promise
      // Mirrors the server callbacks: the lookup itself ignores cancellation,
      // but its late result must not start a mkdir or another filesystem step.
      signal.throwIfAborted()
      mkdirAttempts++
      await fs.mkdir(policyDir)
      return roots
    })
    try {
      const challenges = Array.from({ length: 32 }, () => event())
      const jobs = challenges.map((challenge) => server.handle(challenge))
      await entered.promise
      const cleanupStart = performance.now()
      await Promise.all(
        challenges.map((challenge) => server.handle(cleanup(challenge))),
      )
      expect(await Promise.all(jobs)).toEqual(Array(32).fill(true))
      expect(performance.now() - cleanupStart).toBeLessThan(1_000)
      expect(signals.every((signal) => signal.aborted)).toBe(true)
      await Promise.all(
        Array.from({ length: 40 }, () => server.handle(event())),
      )
      expect(signals).toHaveLength(32)
      const disposeStart = performance.now()
      await server.dispose()
      expect(performance.now() - disposeStart).toBeLessThan(1_000)
    } finally {
      release.resolve()
      await server.dispose()
    }
    expect(mkdirAttempts).toBe(0)
    expect(await fs.exists(policyDir)).toBe(false)
    await empty()
  })

  test("disposal before resolver dispatch starts no path work", async () => {
    let calls = 0
    const server = responder(async () => {
      calls++
      return roots
    })
    const job = server.handle(event())
    await server.dispose()
    expect(await job).toBe(true)
    expect(calls).toBe(0)
    await empty()
  })

  test("one stalled TUI root closes healthy sibling handles and retains capped ownership until release", async () => {
    const release = Promise.withResolvers<void>()
    const originalOpen = fs.open.bind(fs)
    const opened: {
      stalled: boolean
      closeStarted: boolean
      closed: ReturnType<typeof Promise.withResolvers<void>>
      restore(): void
    }[] = []
    const open = spyOn(fs, "open").mockImplementation(
      async (file, flags, mode) => {
        const handle = await originalOpen(file, flags, mode)
        if (
          typeof flags !== "number" ||
          !String(file).includes(`.macarons-locality-${service}-`)
        )
          return handle
        const originalClose = handle.close.bind(handle)
        const record = {
          stalled: String(file).startsWith(`${roots[0]}/`),
          closeStarted: false,
          closed: Promise.withResolvers<void>(),
          restore: () => {},
        }
        const close = spyOn(handle, "close").mockImplementation(async () => {
          record.closeStarted = true
          try {
            await originalClose()
          } finally {
            record.closed.resolve()
          }
        })
        record.restore = () => close.mockRestore()
        opened.push(record)
        if (record.stalled) await release.promise
        return handle
      },
    )
    const server = responder()
    const { api, calls } = transport(async (challenge) => {
      await server.handle(challenge)
      return { data: true }
    })
    try {
      expect(
        await Promise.all(
          Array.from({ length: 32 }, () => verify(api, roots, 1_000)),
        ),
      ).toEqual(Array(32).fill(false))
      const healthy = opened.filter((record) => !record.stalled)
      const stalled = opened.filter((record) => record.stalled)
      expect(healthy).toHaveLength(64)
      expect(stalled).toHaveLength(32)
      // These closes must have started BEFORE releasing the stalled siblings.
      expect(healthy.every((record) => record.closeStarted)).toBe(true)
      await Promise.all(healthy.map((record) => record.closed.promise))
      expect(stalled.some((record) => record.closeStarted)).toBe(false)
      const dispatched = calls.length
      expect(await verify(api, roots, 80)).toBe(false)
      expect(calls).toHaveLength(dispatched)
    } finally {
      release.resolve()
      open.mockRestore()
      await Promise.all(opened.map((record) => record.closed.promise))
      for (const record of opened) record.restore()
    }
    // Late opens close independently, then release their slots after deferred
    // filesystem cleanup. A healthy retry can use this same client again.
    let verified = false
    for (let attempt = 0; attempt < 100 && !verified; attempt++) {
      verified = await verify(api)
      if (!verified) await delay(5)
    }
    expect(verified).toBe(true)
    await empty()
  })

  test("stalled opens bound public waits but retain slots and clean late files after disposal", async () => {
    const originalOpen = fs.open.bind(fs)
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let opened = 0
    const open = spyOn(fs, "open").mockImplementation(
      async (file, flags, mode) => {
        const handle = await originalOpen(file, flags, mode)
        if (String(file).includes(`.macarons-locality-${service}-`)) {
          if (++opened === 32) entered.resolve()
          // The OS may have created the file before a stalled open resolves.
          await release.promise
        }
        return handle
      },
    )
    const server = responder()
    try {
      const challenges = Array.from({ length: 32 }, () => event())
      const start = performance.now()
      const handles = challenges.map((challenge) => server.handle(challenge))
      await entered.promise
      const cleanupStart = performance.now()
      expect(await server.handle(cleanup(challenges[0] as Event))).toBe(true)
      expect(performance.now() - cleanupStart).toBeLessThan(1_000)

      // The other handles must return on their TTL without releasing the I/O.
      expect(await Promise.all(handles)).toEqual(Array(32).fill(true))
      expect(performance.now() - start).toBeLessThan(12_000)
      expect(await fs.readdir(roots[0] as string)).toHaveLength(32)
      // Timed-out calls must not surrender slots to another batch of opens.
      await Promise.all(
        Array.from({ length: 40 }, () => server.handle(event())),
      )
      expect(opened).toBe(32)
      const disposeStart = performance.now()
      await server.dispose()
      expect(performance.now() - disposeStart).toBeLessThan(1_000)
      expect(await fs.readdir(roots[0] as string)).toHaveLength(32)
    } finally {
      release.resolve()
      open.mockRestore()
      // Rejoining disposal observes the original deferred cleanup, not a new
      // batch. Every late open closes and unlinks even after dispose returned.
      await server.dispose()
    }
    await empty()
    expect(await server.handle(event())).toBe(true)
    expect(opened).toBe(32)
  }, 15_000)

  test("expiration removes markers when the client disappears without cleanup", async () => {
    const server = responder()
    const challenge = event()
    await server.handle(challenge)
    expect(await fs.exists(marker(roots[0] as string, challenge))).toBe(true)
    await delay(10_100)
    await empty()
  }, 15_000)
})

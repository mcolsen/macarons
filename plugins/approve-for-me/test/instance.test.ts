import { describe, expect, spyOn, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import {
  requestInstanceID,
  respondInstanceRequest,
} from "../src/shared/instance"

const INSTANCE_A = "1b4e28ba-2fa1-4ad5-9c68-7d5ad0c3f801"
const INSTANCE_B = "c717d75b-138b-4de7-a294-7c5e441a542f"
const WRONG_NONCE = "f5ef001d-cbad-4a04-a855-8cbd65f58f65"
const DIRECTORY = "/same/project"
const UUID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"

type DiscoveryApi = Parameters<typeof requestInstanceID>[0]
type ServerClient = Parameters<typeof respondInstanceRequest>[0]
type ServerPublishCall = NonNullable<
  Parameters<ServerClient["tui"]["publish"]>[0]
>
type PublishCall = NonNullable<
  Parameters<DiscoveryApi["client"]["tui"]["publish"]>[0]
>
type CommandEvent = {
  type: "tui.command.execute"
  properties: { command: string }
}

function commandEvent(command: string): CommandEvent {
  return { type: "tui.command.execute", properties: { command } }
}

function commandOf(call: PublishCall | ServerPublishCall): string {
  const body = call.body
  if (body?.type !== "tui.command.execute") throw new Error("not a command")
  return body.properties.command
}

function makeApi(
  publish: (call: PublishCall) => unknown,
  metadata = { serverUrl: "http://127.0.0.1:4096", project: "same-project" },
) {
  const controller = new AbortController()
  const handlers = new Set<(event: CommandEvent) => void>()
  const api = {
    ...metadata,
    client: {
      tui: {
        publish: (call: PublishCall) => Promise.resolve(publish(call)),
      },
    },
    event: {
      on: (type: string, handler: (event: CommandEvent) => void) => {
        if (type === "tui.command.execute") handlers.add(handler)
        return () => handlers.delete(handler)
      },
    },
    lifecycle: { signal: controller.signal },
    state: { path: { directory: DIRECTORY } },
  } as unknown as DiscoveryApi & typeof metadata

  return {
    api,
    abort: () => controller.abort(),
    emit: (event: CommandEvent) => {
      for (const handler of [...handlers]) handler(event)
    },
    listenerCount: () => handlers.size,
  }
}

function makeServer(instanceID: string) {
  const requests: PublishCall[] = []
  const responses: ServerPublishCall[] = []
  const attached: ReturnType<typeof makeApi>[] = []
  const serverClient = {
    tui: {
      publish: async (call: ServerPublishCall) => {
        responses.push(call)
        await Promise.resolve()
        const body = call.body
        if (body?.type === "tui.command.execute") {
          for (const tui of attached) tui.emit(body)
        }
        return { data: true }
      },
    },
  } as unknown as ServerClient

  return {
    serverClient,
    requests,
    responses,
    attach() {
      const tui = makeApi(async (call) => {
        requests.push(call)
        const body = call.body
        if (body?.type === "tui.command.execute") {
          for (const peer of attached) peer.emit(body)
        }
        await respondInstanceRequest(serverClient, body, instanceID, DIRECTORY)
        return { data: true }
      })
      attached.push(tui)
      return tui
    },
  }
}

describe("instance discovery transport", () => {
  test("identical URL and project metadata still resolve each transport's own server ID", async () => {
    const firstServer = makeServer(INSTANCE_A)
    const secondServer = makeServer(INSTANCE_B)
    const first = firstServer.attach()
    const second = secondServer.attach()

    expect(first.api.serverUrl).toBe(second.api.serverUrl)
    expect(first.api.project).toBe(second.api.project)
    await expect(
      requestInstanceID(first.api, { timeoutMs: 100 }),
    ).resolves.toBe(INSTANCE_A)
    await expect(
      requestInstanceID(second.api, { timeoutMs: 100 }),
    ).resolves.toBe(INSTANCE_B)
  })

  test("multiple TUIs attached to one server receive the same instance ID with correlated responses", async () => {
    const server = makeServer(INSTANCE_A)
    const first = server.attach()
    const second = server.attach()

    await expect(
      Promise.all([
        requestInstanceID(first.api, { timeoutMs: 100 }),
        requestInstanceID(second.api, { timeoutMs: 100 }),
      ]),
    ).resolves.toEqual([INSTANCE_A, INSTANCE_A])
    expect(server.requests).toHaveLength(2)
    expect(server.responses).toHaveLength(2)
    expect(first.listenerCount()).toBe(0)
    expect(second.listenerCount()).toBe(0)
  })

  test("uses the TUI's v2 request shape and the server's v1 response shape", async () => {
    const server = makeServer(INSTANCE_A)
    const tui = server.attach()

    await expect(requestInstanceID(tui.api, { timeoutMs: 100 })).resolves.toBe(
      INSTANCE_A,
    )

    expect(server.requests[0]).toEqual({
      body: {
        type: "tui.command.execute",
        properties: {
          command: expect.stringMatching(
            new RegExp(
              `^macarons\\.permissions-approve-for-me\\.instance\\.v1\\.request\\.${UUID_SOURCE}$`,
              "i",
            ),
          ),
        },
      },
      directory: DIRECTORY,
    })
    expect(server.responses[0]).toEqual({
      body: {
        type: "tui.command.execute",
        properties: {
          command: expect.stringMatching(
            new RegExp(
              `^macarons\\.permissions-approve-for-me\\.instance\\.v1\\.response\\.${UUID_SOURCE}\\.${INSTANCE_A}$`,
              "i",
            ),
          ),
        },
      },
      query: { directory: DIRECTORY },
    })
  })

  test("the real TUI SDK routes discovery to the current directory, not its default", async () => {
    const server = makeServer(INSTANCE_A)
    const tui = server.attach()
    tui.api.state.path.directory = "/current project"
    let sent: Request | undefined
    tui.api.client = createOpencodeClient({
      baseUrl: "http://opencode.internal",
      directory: "/different-default",
      fetch: (async (request: Request) => {
        sent = request
        await respondInstanceRequest(
          server.serverClient,
          await request.json(),
          INSTANCE_A,
          tui.api.state.path.directory,
        )
        return Response.json(true)
      }) as typeof fetch,
    })
    await expect(requestInstanceID(tui.api, { timeoutMs: 100 })).resolves.toBe(
      INSTANCE_A,
    )
    expect(sent).toBeDefined()
    expect(new URL(sent!.url).searchParams.get("directory")).toBe(
      tui.api.state.path.directory,
    )
  })
})

describe("server response validation", () => {
  test("publishes lowercase UUIDs for uppercase request and instance IDs", async () => {
    const server = makeServer(INSTANCE_A)

    await expect(
      respondInstanceRequest(
        server.serverClient,
        commandEvent(
          `macarons.permissions-approve-for-me.instance.v1.request.${WRONG_NONCE.toUpperCase()}`,
        ),
        INSTANCE_A.toUpperCase(),
        DIRECTORY,
      ),
    ).resolves.toBe(true)
    expect(commandOf(server.responses[0]!)).toBe(
      `macarons.permissions-approve-for-me.instance.v1.response.${WRONG_NONCE}.${INSTANCE_A}`,
    )
  })

  test("handles only strict UUIDv4 requests and ignores responses, unrelated, and malformed events", async () => {
    const server = makeServer(INSTANCE_A)
    const tui = server.attach()
    await requestInstanceID(tui.api, { timeoutMs: 100 })
    const request = server.requests[0]?.body
    const response = server.responses[0]?.body
    const before = server.responses.length

    expect(
      await respondInstanceRequest(
        server.serverClient,
        response,
        INSTANCE_A,
        DIRECTORY,
      ),
    ).toBe(false)
    expect(
      await respondInstanceRequest(
        server.serverClient,
        commandEvent("session.new"),
        INSTANCE_A,
        DIRECTORY,
      ),
    ).toBe(false)
    expect(
      await respondInstanceRequest(
        server.serverClient,
        { type: "tui.command.execute", properties: {} },
        INSTANCE_A,
        DIRECTORY,
      ),
    ).toBe(false)
    expect(
      await respondInstanceRequest(
        server.serverClient,
        commandEvent(`${commandOf(server.requests[0]!)}.extra`),
        INSTANCE_A,
        DIRECTORY,
      ),
    ).toBe(false)
    expect(
      await respondInstanceRequest(
        server.serverClient,
        request,
        "not-a-uuid",
        DIRECTORY,
      ),
    ).toBe(false)
    expect(server.responses).toHaveLength(before)
  })

  test.each(["HTTP error result", "network rejection"])(
    "reports a valid request as unhandled on response publication %s",
    async (failure) => {
      const client = {
        tui: {
          publish: async () => {
            if (failure === "network rejection") throw new Error("offline")
            return { error: "server unavailable" }
          },
        },
      }

      await expect(
        respondInstanceRequest(
          client,
          commandEvent(
            `macarons.permissions-approve-for-me.instance.v1.request.${WRONG_NONCE}`,
          ),
          INSTANCE_A,
          DIRECTORY,
        ),
      ).resolves.toBe(false)
    },
  )
})

describe("TUI discovery lifecycle", () => {
  test("correlates uppercase UUID responses and returns a lowercase owner for file paths", async () => {
    const calls: PublishCall[] = []
    const tui = makeApi((call) => {
      calls.push(call)
      return { data: true }
    })
    const pending = requestInstanceID(tui.api, { timeoutMs: 100 })
    const nonce = commandOf(calls[0]!).split(".").at(-1)!
    tui.emit(
      commandEvent(
        `macarons.permissions-approve-for-me.instance.v1.response.${nonce.toUpperCase()}.${INSTANCE_A.toUpperCase()}`,
      ),
    )

    await expect(pending).resolves.toBe(INSTANCE_A)
    expect(tui.listenerCount()).toBe(0)
  })

  test.each([
    [undefined, 2_000],
    [15, 15],
    [2_000, 2_000],
    [2_500, 2_500],
    [10_000, 10_000],
    [10_001, 10_000],
    [Number.MAX_VALUE, 10_000],
    [0, 0],
    [-1, 0],
    [Number.NaN, 2_000],
    [Number.POSITIVE_INFINITY, 2_000],
    [Number.NEGATIVE_INFINITY, 2_000],
  ])("normalizes timeoutMs %s to %s ms", async (timeoutMs, expected) => {
    const tui = makeApi(() => new Promise(() => {}))
    const timeout = spyOn(globalThis, "setTimeout")
    try {
      const pending = requestInstanceID(tui.api, { timeoutMs })
      expect(timeout).toHaveBeenCalledTimes(1)
      expect(timeout.mock.calls[0]?.[1]).toBe(expected)
      const expire = timeout.mock.calls[0]?.[0]
      if (typeof expire !== "function") throw new Error("missing deadline")
      // Exercise expiry and cleanup without waiting out the configured budget.
      expire()
      await expect(pending).resolves.toBeUndefined()
      expect(tui.listenerCount()).toBe(0)
    } finally {
      tui.abort()
      timeout.mockRestore()
    }
  })

  test.each(["HTTP error result", "network rejection"])(
    "finishes without waiting for the deadline on request publication %s",
    async (failure) => {
      const tui = makeApi(async () => {
        if (failure === "network rejection") throw new Error("offline")
        return { error: "server unavailable" }
      })
      const realSetTimeout = globalThis.setTimeout.bind(globalThis)
      let expired = false
      const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: () => void,
      ) =>
        realSetTimeout(() => {
          expired = true
          callback()
        }, 0)) as typeof setTimeout)
      try {
        await expect(requestInstanceID(tui.api)).resolves.toBeUndefined()
        expect(expired).toBe(false)
        expect(tui.listenerCount()).toBe(0)
      } finally {
        tui.abort()
        timeout.mockRestore()
      }
    },
  )

  test("ignores wrong nonces and malformed IDs; HTTP acceptance alone is not identity", async () => {
    const calls: PublishCall[] = []
    const tui = makeApi((call) => {
      calls.push(call)
      return { data: true }
    })
    const pending = requestInstanceID(tui.api, { timeoutMs: 25 })
    const responseCalls: PublishCall[] = []
    const responder = {
      tui: {
        publish: async (call: PublishCall) => {
          responseCalls.push(call)
          return { data: true }
        },
      },
    } as unknown as ServerClient
    await respondInstanceRequest(
      responder,
      calls[0]?.body,
      INSTANCE_A,
      DIRECTORY,
    )
    const responseCommand = commandOf(responseCalls[0]!)
    const requestNonce = commandOf(calls[0]!).match(
      new RegExp(UUID_SOURCE, "i"),
    )?.[0]
    if (!requestNonce) throw new Error("request nonce missing")

    tui.emit(commandEvent(responseCommand.replace(requestNonce, WRONG_NONCE)))
    tui.emit(commandEvent(responseCommand.replace(INSTANCE_A, "not-a-uuid")))

    await expect(pending).resolves.toBeUndefined()
    expect(tui.listenerCount()).toBe(0)
  })

  test("times out and unsubscribes without awaiting a hanging publish", async () => {
    const tui = makeApi(() => new Promise(() => {}))
    const started = Date.now()

    await expect(
      requestInstanceID(tui.api, { timeoutMs: 15 }),
    ).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(500)
    expect(tui.listenerCount()).toBe(0)
  })

  test("disposal aborts discovery, unsubscribes, and absorbs a late publish rejection", async () => {
    let rejectPublish = (_error: Error) => {}
    const tui = makeApi(
      () =>
        new Promise((_resolve, reject) => {
          rejectPublish = reject
        }),
    )
    const pending = requestInstanceID(tui.api, { timeoutMs: 100 })

    expect(tui.listenerCount()).toBe(1)
    tui.abort()
    await expect(pending).resolves.toBeUndefined()
    expect(tui.listenerCount()).toBe(0)

    rejectPublish(new Error("late transport failure"))
    await Promise.resolve()
  })

  test("late response events are inert after timeout cleanup", async () => {
    const calls: PublishCall[] = []
    const tui = makeApi((call) => {
      calls.push(call)
      return { data: true }
    })
    const pending = requestInstanceID(tui.api, { timeoutMs: 10 })
    const responseCalls: PublishCall[] = []
    const responder = {
      tui: {
        publish: async (call: PublishCall) => {
          responseCalls.push(call)
          return { data: true }
        },
      },
    } as unknown as ServerClient
    await respondInstanceRequest(
      responder,
      calls[0]?.body,
      INSTANCE_A,
      DIRECTORY,
    )

    await expect(pending).resolves.toBeUndefined()
    expect(tui.listenerCount()).toBe(0)
    tui.emit(responseCalls[0]?.body as CommandEvent)
    expect(tui.listenerCount()).toBe(0)
  })
})

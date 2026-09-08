import { describe, expect, test } from "bun:test"
import { describeGating } from "@macarons/plugin-test-harness/tui"
import { MAX_TRACKED_SESSIONS, resolveOptions, tui } from "../src/tui"
import { type MockHistoryMessage, makeApi, seedTask, taskPart } from "./harness"

// Engine-level tests: compat gate, option validation, command registration,
// the bus-fed durable record, and the /subagents dialog — against the shared
// mock api in test/harness.ts. The View's JSX and its reactive lifecycle are
// covered by test/view.test.tsx under @opentui/solid's headless renderer.

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type MockRequestOptions = { signal?: AbortSignal }

describeGating({
  // In lockstep with src/tui.tsx: this half reads only session state the host
  // has already synced locally, so remote attaches are served, not bailed.
  remoteBails: false,
  load: async (input) => {
    const harness = makeApi(input)
    await tui(harness.api, undefined, {} as never)
    const run = {
      toasts: harness.toasts,
      registered: harness.slotPlugins.length === 1,
      inert:
        harness.slotPlugins.length === 0 &&
        harness.layers.length === 0 &&
        harness.handlers.size === 0,
    }
    await harness.dispose()
    return run
  },
})

describe("registration", () => {
  test("registers a sidebar_content slot at order 155 on a supported host", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    expect(harness.toasts).toHaveLength(0)
    expect(harness.slotPlugins).toHaveLength(1)
    expect(harness.slotPlugins[0]!.order).toBe(155)
    expect(typeof harness.slotPlugins[0]!.slots.sidebar_content).toBe(
      "function",
    )
  })
})

describe("option validation", () => {
  test("defaults", () => {
    const { options, problems } = resolveOptions(undefined)
    expect(problems).toEqual([])
    expect(options).toEqual({
      lingerMs: 60_000,
      sidebar: true,
      keybind: undefined,
    })
  })

  test("accepts in-range values", () => {
    const { options, problems } = resolveOptions({
      finishedLingerSeconds: 5,
      sidebar: false,
      keybind: "ctrl+g",
    })
    expect(problems).toEqual([])
    expect(options).toEqual({
      lingerMs: 5_000,
      sidebar: false,
      keybind: "ctrl+g",
    })
  })

  test("rejects out-of-range or wrong-typed values back to defaults, with a problem each", () => {
    const { options, problems } = resolveOptions({
      finishedLingerSeconds: 0,
      sidebar: "false",
      keybind: 7,
    })
    expect(problems).toHaveLength(3)
    expect(options).toEqual({
      lingerMs: 60_000,
      sidebar: true,
      keybind: undefined,
    })
  })

  test("keybind 'none' and blank read as no keybind, silently", () => {
    expect(resolveOptions({ keybind: "none" }).options.keybind).toBeUndefined()
    expect(resolveOptions({ keybind: "  " }).options.keybind).toBeUndefined()
    expect(resolveOptions({ keybind: "none" }).problems).toEqual([])
  })

  test("invalid options surface as ONE warning toast at startup", async () => {
    const harness = makeApi()
    await tui(
      harness.api,
      { finishedLingerSeconds: -1, sidebar: 1 } as any,
      {} as any,
    )
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.variant).toBe("warning")
    expect(harness.toasts[0]!.message).toContain("finishedLingerSeconds")
    expect(harness.toasts[0]!.message).toContain("sidebar")
  })

  test("sidebar: false keeps the palette command and skips the slot", async () => {
    const harness = makeApi()
    await tui(harness.api, { sidebar: false }, {} as any)
    expect(harness.slotPlugins).toHaveLength(0)
    expect(harness.layers).toHaveLength(1)
  })
})

describe("command registration", () => {
  test("registers the palette command with /subagents and no default binding", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    expect(harness.layers).toHaveLength(1)
    const layer = harness.layers[0]!
    expect(layer.commands).toHaveLength(1)
    const command = layer.commands[0]
    expect(command.name).toBe("subagents.list")
    expect(command.slashName).toBe("subagents")
    expect(command.namespace).toBe("palette")
    // AGENTS.md rule 2: no default keybind without a collision audit.
    expect(layer.bindings).toEqual([])
  })

  test("a configured keybind binds the first alternative by name, the rest hidden", async () => {
    const harness = makeApi()
    await tui(harness.api, { keybind: "ctrl+g,ctrl+shift+g" }, {} as any)
    const layer = harness.layers[0]!
    expect(layer.bindings).toHaveLength(2)
    expect(layer.bindings[0]).toMatchObject({
      key: "ctrl+g",
      cmd: "subagents.list",
    })
    expect(typeof layer.bindings[1].cmd).toBe("function")
  })
})

describe("the /subagents dialog", () => {
  test("lists rows with categories and jumps to the child session on select", async () => {
    const harness = makeApi()
    harness.clientChildren.set("ses_1", [
      { id: "ses_child_1", time: { created: 1, updated: 1 } },
      { id: "ses_child_2", time: { created: 1, updated: 1 } },
    ])
    await tui(harness.api, undefined, {} as any)
    seedTask(harness, taskPart())
    seedTask(
      harness,
      taskPart({
        id: "prt_done",
        messageID: "msg_2",
        callID: "call_done",
        state: {
          status: "completed",
          metadata: { sessionId: "ses_child_2" },
          input: { subagent_type: "plan", description: "design the approach" },
          time: { start: 1, end: 2 },
        },
      }),
    )

    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs).toHaveLength(1)
    const dialog = harness.dialogs[0]!
    expect(dialog.title).toBe("Subagents")
    expect(dialog.options).toHaveLength(2)
    expect(dialog.options[0].category).toBe("Running")
    expect(dialog.options[0].title).toContain("explore: find the sync path")
    expect(dialog.options[1].category).toBe("Finished")

    await Bun.sleep(0)
    dialog.options[0].onSelect()
    expect(harness.dialogClears()).toBe(1)
    expect(harness.navigations).toEqual([
      { name: "session", params: { sessionID: "ses_child_1" } },
    ])
  })

  test("a subagent whose session is not known yet stays visible but cannot be opened", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedTask(
      harness,
      taskPart({
        id: "prt_pending",
        callID: "call_pending",
        state: { status: "pending", metadata: {}, time: {} },
      }),
    )
    harness.layers[0]!.commands[0].run()
    const dialog = harness.dialogs[0]!
    // Never `disabled`: the real DialogSelect filters disabled options OUT of
    // the list, which would empty /subagents exactly while a spawn waits on
    // its pre-child permission. The row stays listed; selection is guarded.
    expect(dialog.options[0].disabled).toBeUndefined()
    dialog.options[0].onSelect()
    expect(harness.navigations).toEqual([])
    expect(harness.dialogClears()).toBe(0)
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.variant).toBe("info")
  })

  test("a degraded child list fails closed when the session is unavailable", async () => {
    const harness = makeApi()
    harness.missingClientSessions.add("ses_child_1")
    await tui(harness.api, undefined, {} as any)
    seedTask(harness, taskPart())
    harness.layers[0]!.commands[0].run()
    await Bun.sleep(0)

    harness.dialogs[0]!.options[0].onSelect()
    await Bun.sleep(0)

    expect(harness.navigations).toEqual([])
    expect(harness.dialogClears()).toBe(0)
    expect(harness.toasts.at(-1)?.message).toContain("unavailable")
  })

  test("a degraded child list verifies a live session before navigating", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedTask(harness, taskPart())
    harness.layers[0]!.commands[0].run()
    await Bun.sleep(0)

    harness.dialogs[0]!.options[0].onSelect()
    await Bun.sleep(0)

    expect(harness.dialogClears()).toBe(1)
    expect(harness.navigations).toEqual([
      { name: "session", params: { sessionID: "ses_child_1" } },
    ])
  })

  test("a newer selection supersedes an older verification request", async () => {
    const harness = makeApi()
    const first = deferred<{ data: { id: string } }>()
    const second = deferred<{ data: { id: string } }>()
    harness.api.client.session.get = (({ sessionID }: { sessionID: string }) =>
      sessionID === "ses_child_1" ? first.promise : second.promise) as any
    await tui(harness.api, undefined, {} as any)
    seedTask(harness, taskPart())
    seedTask(
      harness,
      taskPart({
        id: "prt_second",
        messageID: "msg_second",
        callID: "call_second",
        state: { metadata: { sessionId: "ses_child_2" } },
      }),
    )
    harness.layers[0]!.commands[0].run()
    await Bun.sleep(0)

    const dialog = harness.dialogs[0]!
    dialog.options[0].onSelect()
    dialog.options[1].onSelect()
    second.resolve({ data: { id: "ses_child_2" } })
    await Bun.sleep(0)
    first.resolve({ data: { id: "ses_child_1" } })
    await Bun.sleep(0)

    expect(harness.navigations).toEqual([
      { name: "session", params: { sessionID: "ses_child_2" } },
    ])
  })

  test("outside a session route the command toasts instead of opening", async () => {
    const harness = makeApi({ routeName: "home" })
    await tui(harness.api, undefined, {} as any)
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs).toHaveLength(0)
    expect(harness.toasts).toHaveLength(1)
    expect(harness.toasts[0]!.variant).toBe("info")
  })
})

describe("child-state refinement", () => {
  test("a foreground child resumed through subagent_send shows as running again", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    // The stock task finished — its part is completed and stays that way.
    seedTask(
      harness,
      taskPart({
        state: { status: "completed", time: { start: 1, end: 2 } },
      }),
    )
    // subagent_send resumed the child: no new spawn part, just a busy child.
    harness.statuses.set("ses_child_1", { type: "busy" })
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options).toHaveLength(1)
    expect(harness.dialogs[0]!.options[0].category).toBe("Running")
  })

  test("a resumed foreground child blocked on a permission shows as waiting", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedTask(
      harness,
      taskPart({
        state: { status: "completed", time: { start: 1, end: 2 } },
      }),
    )
    harness.statuses.set("ses_child_1", { type: "busy" })
    harness.permissions.set("ses_child_1", [{ id: "perm_resume" }])
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options[0].title).toContain("waiting on you")
  })

  test("a failed background child settles as failed, and a resume clears the verdict", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedTask(
      harness,
      taskPart({
        tool: "subagent_spawn",
        state: { status: "completed", time: { start: 1, end: 2 } },
      }),
    )
    // Register the sighting (the child gate reads the tracked record).
    harness.layers[0]!.commands[0].run()
    // The child's run ends in an error, then the session settles.
    harness.emit("message.updated", {
      sessionID: "ses_child_1",
      info: {
        id: "msg_child_1",
        sessionID: "ses_child_1",
        role: "assistant",
        error: { name: "UnknownError", data: { message: "boom" } },
      },
    })
    harness.statuses.set("ses_child_1", { type: "idle" })
    harness.emit("session.status", {
      sessionID: "ses_child_1",
      status: { type: "idle" },
    })
    harness.layers[0]!.commands[0].run()
    const settled = harness.dialogs[1]!
    expect(settled.options[0].category).toBe("Finished")
    expect(settled.options[0].title).toContain("✗")
    expect(settled.options[0].title).toContain("failed")
    // A new run (subagent_send) goes busy: verdict and settle stamp reset.
    harness.statuses.set("ses_child_1", { type: "busy" })
    harness.emit("session.status", {
      sessionID: "ses_child_1",
      status: { type: "busy" },
    })
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[2]!.options[0].category).toBe("Running")
  })

  test("reconnect refreshes a background child's status after an event gap", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedTask(
      harness,
      taskPart({
        tool: "subagent_spawn",
        state: { status: "completed", time: { start: 1, end: 2 } },
      }),
    )
    harness.statuses.set("ses_child_1", { type: "busy" })
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options[0].category).toBe("Running")

    // The idle event was missed. The host store is stale, but the reconnect's
    // server status snapshot is current (idle sessions are omitted).
    harness.clientStatus.data = {}
    harness.emit("server.connected", {})
    await Bun.sleep(0)
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[1]!.options[0].category).toBe("Finished")
  })

  test("a newer idle event settles a run the status snapshot found busy", async () => {
    const harness = makeApi()
    harness.clientStatus.data = {}
    await tui(harness.api, undefined, {} as any)
    await Bun.sleep(0)
    seedTask(
      harness,
      taskPart({
        tool: "subagent_spawn",
        state: { status: "completed", time: { start: 1, end: 2 } },
      }),
    )
    harness.layers[0]!.commands[0].run()
    harness.emit("message.updated", {
      sessionID: "ses_child_1",
      info: {
        id: "msg_old_failure",
        sessionID: "ses_child_1",
        role: "assistant",
        error: { name: "UnknownError", data: { message: "old failure" } },
      },
    })
    harness.statuses.set("ses_child_1", { type: "idle" })
    harness.emit("session.status", {
      sessionID: "ses_child_1",
      status: { type: "idle" },
    })

    const status = deferred<{
      data: Record<string, { type: string }>
    }>()
    harness.api.client.session.status = (() => status.promise) as any
    harness.emit("server.connected", {})
    // The snapshot observed the resumed run as busy; this newer event observes
    // that run settling successfully before the response reaches the plugin.
    harness.statuses.set("ses_child_1", { type: "idle" })
    harness.emit("session.status", {
      sessionID: "ses_child_1",
      status: { type: "idle" },
    })
    status.resolve({ data: { ses_child_1: { type: "busy" } } })
    await Bun.sleep(0)

    harness.layers[0]!.commands[0].run()
    const row = harness.dialogs.at(-1)!.options[0]
    expect(row.category).toBe("Finished")
    expect(row.title).not.toContain("failed")
  })

  test("a busy snapshot does not erase a failure from the same live run", async () => {
    const harness = makeApi()
    harness.clientStatus.data = { ses_child_1: { type: "busy" } }
    await tui(harness.api, undefined, {} as any)
    await Bun.sleep(0)
    seedTask(
      harness,
      taskPart({
        tool: "subagent_spawn",
        state: { status: "completed", time: { start: 1, end: 2 } },
      }),
    )
    harness.layers[0]!.commands[0].run()
    harness.emit("message.updated", {
      sessionID: "ses_child_1",
      info: {
        id: "msg_current_failure",
        sessionID: "ses_child_1",
        role: "assistant",
        error: { name: "UnknownError", data: { message: "current failure" } },
      },
    })

    harness.emit("server.connected", {})
    await Bun.sleep(0)
    harness.statuses.set("ses_child_1", { type: "idle" })
    harness.emit("session.status", {
      sessionID: "ses_child_1",
      status: { type: "idle" },
    })
    harness.layers[0]!.commands[0].run()

    expect(harness.dialogs.at(-1)!.options[0].title).toContain("failed")
  })

  test("events already included in a busy snapshot are not replayed", async () => {
    const harness = makeApi()
    harness.clientStatus.data = {}
    await tui(harness.api, undefined, {} as any)
    await Bun.sleep(0)
    seedTask(
      harness,
      taskPart({
        tool: "subagent_spawn",
        state: { status: "completed", time: { start: 1, end: 2 } },
      }),
    )
    harness.layers[0]!.commands[0].run()
    harness.emit("message.updated", {
      sessionID: "ses_child_1",
      info: {
        id: "msg_old_failure",
        sessionID: "ses_child_1",
        role: "assistant",
        error: { name: "UnknownError", data: { message: "old failure" } },
      },
    })
    harness.statuses.set("ses_child_1", { type: "idle" })
    harness.emit("session.status", {
      sessionID: "ses_child_1",
      status: { type: "idle" },
    })

    const status = deferred<{
      data: Record<string, { type: string }>
    }>()
    harness.api.client.session.status = (() => status.promise) as any
    harness.emit("server.connected", {})
    // These events arrive after the request starts but before the server takes
    // its busy snapshot. Live handling has already reset the old failure.
    harness.emit("message.updated", {
      sessionID: "ses_child_1",
      info: {
        id: "msg_delayed_old_failure",
        sessionID: "ses_child_1",
        role: "assistant",
        error: { name: "UnknownError", data: { message: "old failure" } },
      },
    })
    harness.statuses.set("ses_child_1", { type: "busy" })
    harness.emit("session.status", {
      sessionID: "ses_child_1",
      status: { type: "busy" },
    })
    status.resolve({ data: { ses_child_1: { type: "busy" } } })
    await Bun.sleep(0)
    harness.statuses.set("ses_child_1", { type: "idle" })
    harness.emit("session.status", {
      sessionID: "ses_child_1",
      status: { type: "idle" },
    })
    harness.layers[0]!.commands[0].run()

    expect(harness.dialogs.at(-1)!.options[0].title).not.toContain("failed")
  })
})

describe("hydration", () => {
  test("a cold attach recovers a spawn older than the synced window", async () => {
    const harness = makeApi()
    // Present only in server-side history: the store never saw the message,
    // and no bus event will replay it.
    harness.clientMessages.set("ses_1", [
      {
        info: { role: "assistant", id: "msg_old" },
        parts: [taskPart({ id: "prt_old", messageID: "msg_old" })],
      },
    ])
    await tui(harness.api, undefined, {} as any)
    harness.layers[0]!.commands[0].run()
    // The first read only KICKS the hydration; the fetch has not landed yet.
    expect(harness.dialogs[0]!.options).toHaveLength(0)
    await Bun.sleep(0)
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[1]!.options).toHaveLength(1)
    expect(harness.dialogs[1]!.options[0].title).toContain(
      "explore: find the sync path",
    )
  })

  test("hydration never overwrites what the bus already delivered", async () => {
    const harness = makeApi()
    // The history snapshot still holds the RUNNING part…
    harness.clientMessages.set("ses_1", [
      {
        info: { role: "assistant", id: "msg_1" },
        parts: [taskPart({ id: "prt_race", callID: "call_race" })],
      },
    ])
    await tui(harness.api, undefined, {} as any)
    // …but the bus has since delivered its completion.
    harness.emitPartUpdated(
      taskPart({
        id: "prt_race",
        callID: "call_race",
        state: { status: "completed", time: { start: 1, end: 2 } },
      }),
    )
    harness.layers[0]!.commands[0].run()
    await Bun.sleep(0)
    harness.layers[0]!.commands[0].run()
    const dialog = harness.dialogs[1]!
    expect(dialog.options).toHaveLength(1)
    expect(dialog.options[0].category).toBe("Finished")
  })

  test("permission and question waits pending at attach time surface", async () => {
    const harness = makeApi()
    // Asked BEFORE this TUI attached: the host's event-built queues are
    // empty, only the list endpoints know.
    harness.pendingPermissions.push({
      id: "perm_pre",
      sessionID: "ses_child_1",
    })
    await tui(harness.api, undefined, {} as any)
    seedTask(harness, taskPart())
    await Bun.sleep(0)
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options[0].title).toContain("waiting on you")
    // The reply retires the hydrated entry and the wait clears.
    harness.emit("permission.replied", {
      sessionID: "ses_child_1",
      requestID: "perm_pre",
      reply: "once",
    })
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[1]!.options[0].title).not.toContain("waiting on you")
  })

  test("a hydrated wait is not double-counted once the host store catches up", async () => {
    const harness = makeApi()
    harness.pendingPermissions.push({
      id: "perm_pre",
      sessionID: "ses_child_1",
    })
    await tui(harness.api, undefined, {} as any)
    seedTask(harness, taskPart())
    await Bun.sleep(0)
    // The same request also lands in the host store (late ask delivery).
    harness.permissions.set("ses_child_1", [{ id: "perm_pre" }])
    harness.layers[0]!.commands[0].run()
    // One wait, not two: replying once must clear it entirely.
    harness.permissions.set("ses_child_1", [])
    harness.emit("permission.replied", {
      sessionID: "ses_child_1",
      requestID: "perm_pre",
      reply: "once",
    })
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[1]!.options[0].title).not.toContain("waiting on you")
  })

  test.each(["permission", "question"] as const)(
    "%s reconnect snapshots replace stale host and plugin-local requests",
    async (kind) => {
      const harness = makeApi()
      const stored =
        kind === "permission" ? harness.permissions : harness.questions
      const pending =
        kind === "permission"
          ? harness.pendingPermissions
          : harness.pendingQuestions
      // Distinct stale IDs exercise both sources, not just their intersection.
      stored.set("ses_child_1", [{ id: "req_host" }])
      pending.push({ id: "req_local", sessionID: "ses_child_1" })
      await tui(harness.api, undefined, {} as any)
      seedTask(harness, taskPart())
      await Bun.sleep(0)
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).toContain(
        "waiting on you",
      )

      // Both replies were missed while disconnected. Leave the host stale.
      pending.length = 0
      harness.emit("server.connected", {})
      await Bun.sleep(0)
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).not.toContain(
        "waiting on you",
      )
      expect(stored.get("ses_child_1")).toEqual([{ id: "req_host" }])

      // A nonempty snapshot is authoritative too, even for absent IDs in the
      // same session. Retiring its one current request must clear attention.
      pending.push({ id: "req_current", sessionID: "ses_child_1" })
      harness.emit("server.connected", {})
      await Bun.sleep(0)
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).toContain(
        "waiting on you",
      )
      harness.emit(`${kind}.replied`, {
        sessionID: "ses_child_1",
        requestID: "req_current",
        reply: "once",
        answers: [],
      })
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).not.toContain(
        "waiting on you",
      )
    },
  )

  test.each([
    ["permission", "foreign"],
    ["permission", "unknown"],
    ["question", "foreign"],
    ["question", "unknown"],
  ] as const)(
    "%s cross-directory snapshots preserve %s host and live waits",
    async (kind, scope) => {
      const harness = makeApi()
      const stored =
        kind === "permission" ? harness.permissions : harness.questions
      const pending =
        kind === "permission"
          ? harness.pendingPermissions
          : harness.pendingQuestions
      const startup = deferred<{ data: typeof pending }>()
      const parameters: unknown[] = []
      harness.api.client[kind].list = (async (input: unknown) => {
        parameters.push(input)
        return parameters.length === 1
          ? startup.promise
          : { data: pending.slice() }
      }) as any
      seedTask(harness, taskPart())
      if (scope === "foreign")
        harness.sessionRecords.set("ses_child_1", {
          ...harness.sessionRecords.get("ses_child_1")!,
          directory: "/other",
        })
      else harness.sessionRecords.delete("ses_child_1")
      stored.set("ses_child_1", [{ id: "req_host" }])

      await tui(harness.api, undefined, {} as any)
      // The response still covers /project, not the path viewed when it lands.
      Object.assign(harness.api.state.path, { directory: "/other" })
      startup.resolve({ data: [] })
      await Bun.sleep(0)
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).toContain(
        "waiting on you",
      )

      Object.assign(harness.api.state.path, { directory: "/project" })
      harness.emit(`${kind}.asked`, {
        id: "req_live",
        sessionID: "ses_child_1",
      })
      harness.emit("server.connected", {})
      await Bun.sleep(0)
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).toContain(
        "waiting on you",
      )
      expect(parameters).toEqual([
        { directory: "/project" },
        { directory: "/project" },
      ])

      // The host copy must not mask a live request lost during reconciliation.
      stored.delete("ses_child_1")
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).toContain(
        "waiting on you",
      )

      let requestID = "req_live"
      if (scope === "unknown") {
        // Being listed proves scope and replaces older unknown IDs in this child.
        requestID = "req_scoped"
        pending.push({ id: requestID, sessionID: "ses_child_1" })
        harness.emit("server.connected", {})
        await Bun.sleep(0)
        harness.layers[0]!.commands[0].run()
        expect(harness.dialogs.at(-1)!.options[0].title).toContain(
          "waiting on you",
        )
      }
      harness.emit(`${kind}.replied`, {
        requestID,
        sessionID: "ses_child_1",
        reply: "once",
        answers: [],
      })
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).not.toContain(
        "waiting on you",
      )
    },
  )

  test.each(["permission", "question"] as const)(
    "%s child-directory snapshots keep scope after pending requests clear",
    async (kind) => {
      const harness = makeApi()
      const stored =
        kind === "permission" ? harness.permissions : harness.questions
      stored.set("ses_child_1", [{ id: "req_host" }])
      seedTask(harness, taskPart())
      // Only the children endpoint can establish this child's /project scope.
      harness.clientChildren.set("ses_1", [
        harness.sessionRecords.get("ses_child_1")!,
      ])
      harness.sessionRecords.delete("ses_child_1")
      await tui(harness.api, undefined, {} as any)
      harness.layers[0]!.commands[0].run()
      await Bun.sleep(0)
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).not.toContain(
        "waiting on you",
      )

      harness.emit(`${kind}.asked`, {
        id: "req_live",
        sessionID: "ses_child_1",
      })
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).toContain(
        "waiting on you",
      )
      harness.emit(`${kind}.replied`, {
        requestID: "req_live",
        sessionID: "ses_child_1",
        reply: "once",
        answers: [],
      })
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).not.toContain(
        "waiting on you",
      )
      expect(stored.get("ses_child_1")).toEqual([{ id: "req_host" }])
    },
  )

  test.each(["permission", "question"] as const)(
    "%s proven snapshot scope survives clearing before the first dialog read",
    async (kind) => {
      const harness = makeApi()
      const stored =
        kind === "permission" ? harness.permissions : harness.questions
      stored.set("ses_child_1", [{ id: "req_old" }])
      const snapshot = deferred<{
        data: { id: string; sessionID: string }[]
      }>()
      harness.api.client[kind].list = (() => snapshot.promise) as any
      await tui(harness.api, { sidebar: false }, {} as any)
      harness.emitPartUpdated(taskPart())
      snapshot.resolve({
        data: [{ id: "req_snapshot", sessionID: "ses_child_1" }],
      })
      await Bun.sleep(0)

      // Clear pending membership before a row can cache the proven scope.
      harness.api.client[kind].list = (async () => ({ data: [] })) as any
      harness.emit("server.connected", {})
      await Bun.sleep(0)
      expect(harness.dialogs).toHaveLength(0)
      expect(harness.sessionRecords.has("ses_child_1")).toBe(false)
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs[0]!.options[0].title).not.toContain(
        "waiting on you",
      )
      expect(stored.get("ses_child_1")).toEqual([{ id: "req_old" }])
    },
  )

  test.each(["permission", "question"] as const)(
    "%s proven snapshot scope survives replies to in-flight asks",
    async (kind) => {
      const harness = makeApi()
      const stored =
        kind === "permission" ? harness.permissions : harness.questions
      stored.set("ses_child_1", [{ id: "req_old" }])
      const snapshot = deferred<{
        data: { id: string; sessionID: string }[]
      }>()
      harness.api.client[kind].list = (() => snapshot.promise) as any
      await tui(harness.api, { sidebar: false }, {} as any)
      harness.emitPartUpdated(taskPart())
      harness.emit(`${kind}.asked`, {
        id: "req_live",
        sessionID: "ses_child_1",
      })
      // A touched ID still proves scope even when membership follows the event.
      snapshot.resolve({
        data: [{ id: "req_live", sessionID: "ses_child_1" }],
      })
      await Bun.sleep(0)
      harness.emit(`${kind}.replied`, {
        requestID: "req_live",
        sessionID: "ses_child_1",
        reply: "once",
        answers: [],
      })
      expect(harness.dialogs).toHaveLength(0)
      expect(harness.sessionRecords.has("ses_child_1")).toBe(false)
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs[0]!.options[0].title).not.toContain(
        "waiting on you",
      )
      expect(stored.get("ses_child_1")).toEqual([{ id: "req_old" }])
    },
  )

  test.each(["permission", "question"] as const)(
    "%s events after the snapshot boundary win in arrival order",
    async (kind) => {
      const harness = makeApi()
      // Scope is known before the spawn sighting is discovered below.
      harness.sessionRecords.set("ses_child_1", {
        id: "ses_child_1",
        parentID: "ses_1",
        directory: "/project",
        time: { created: 0, updated: 0 },
      })
      await tui(harness.api, undefined, {} as any)
      await Bun.sleep(0)
      harness.emit(`${kind}.asked`, {
        id: "req_before_reconnect",
        sessionID: "ses_child_1",
      })
      const snapshot = deferred<{
        data: { id: string; sessionID: string }[]
      }>()
      harness.api.client[kind].list = (() => snapshot.promise) as any
      harness.emit("server.connected", {})
      harness.emit(`${kind}.asked`, {
        id: "req_live",
        sessionID: "ses_child_1",
      })
      harness.emit(`${kind}.asked`, {
        id: "req_answered",
        sessionID: "ses_child_1",
      })
      harness.emit(
        kind === "permission" ? "permission.replied" : "question.rejected",
        {
          requestID: "req_answered",
          sessionID: "ses_child_1",
          reply: "once",
        },
      )
      // The live ask is absent from this response; the answered request is
      // still present. Neither may override events observed during the fetch.
      snapshot.resolve({
        data: [{ id: "req_answered", sessionID: "ses_child_1" }],
      })
      await Bun.sleep(0)
      // Requests can arrive before the plugin discovers their child sighting.
      seedTask(harness, taskPart())
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).toContain(
        "waiting on you",
      )
      harness.emit(`${kind}.replied`, {
        requestID: "req_live",
        sessionID: "ses_child_1",
        reply: "once",
        answers: [],
      })
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).not.toContain(
        "waiting on you",
      )
    },
  )

  test.each(["permission", "question"] as const)(
    "%s snapshot authority is independent and survives failed refreshes",
    async (kind) => {
      const harness = makeApi()
      const stored =
        kind === "permission" ? harness.permissions : harness.questions
      harness.permissions.set("ses_child_1", [{ id: "req_host" }])
      harness.questions.set("ses_child_1", [{ id: "req_host" }])
      harness.api.client[kind].list = async () => {
        throw new Error("disconnected")
      }
      await tui(harness.api, undefined, {} as any)
      seedTask(harness, taskPart())
      await Bun.sleep(0)
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).toContain(
        "waiting on you",
      )
      // Only the failed endpoint still falls back to its host queue.
      stored.delete("ses_child_1")
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).not.toContain(
        "waiting on you",
      )
      stored.set("ses_child_1", [{ id: "req_host" }])

      harness.api.client[kind].list = (async () => ({
        data: [{ id: "req_snapshot", sessionID: "ses_child_1" }],
      })) as any
      harness.emit("server.connected", {})
      await Bun.sleep(0)
      // A degraded response keeps the last successful snapshot and does not
      // re-enable fallback to the stale host queue.
      harness.api.client[kind].list = (async () => ({})) as any
      harness.emit("server.connected", {})
      await Bun.sleep(0)
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).toContain(
        "waiting on you",
      )
      harness.emit(`${kind}.replied`, {
        requestID: "req_snapshot",
        sessionID: "ses_child_1",
        reply: "once",
        answers: [],
      })
      harness.layers[0]!.commands[0].run()
      expect(harness.dialogs.at(-1)!.options[0].title).not.toContain(
        "waiting on you",
      )
    },
  )

  test("an older attention hydration cannot overwrite a newer reconnect", async () => {
    const harness = makeApi()
    harness.permissions.set("ses_child_1", [{ id: "perm_stale" }])
    harness.questions.set("ses_child_1", [{ id: "question_stale" }])
    const first = deferred<{
      data: { id: string; sessionID: string }[]
    }>()
    const second = deferred<{
      data: { id: string; sessionID: string }[]
    }>()
    let calls = 0
    const signals: AbortSignal[] = []
    harness.api.client.permission.list = ((
      _parameters: unknown,
      options: MockRequestOptions,
    ) => {
      if (options.signal) signals.push(options.signal)
      return calls++ === 0 ? first.promise : second.promise
    }) as any

    await tui(harness.api, undefined, {} as any)
    seedTask(harness, taskPart())
    harness.emit("server.connected", {})
    expect(signals).toHaveLength(2)
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)

    // The reconnect's empty queue lands first and becomes authoritative.
    second.resolve({ data: [] })
    await Bun.sleep(0)
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options[0].title).not.toContain("waiting on you")

    // The startup request then arrives with an older wait. It must be ignored.
    first.resolve({
      data: [{ id: "perm_stale", sessionID: "ses_child_1" }],
    })
    await Bun.sleep(0)
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[1]!.options[0].title).not.toContain("waiting on you")
  })

  test("a reply while hydration is in flight cannot be re-added by its snapshot", async () => {
    const harness = makeApi()
    harness.permissions.set("ses_child_1", [{ id: "perm_answered" }])
    harness.questions.set("ses_child_1", [{ id: "question_answered" }])
    const permissions = deferred<{
      data: { id: string; sessionID: string }[]
    }>()
    const questions = deferred<{
      data: { id: string; sessionID: string }[]
    }>()
    harness.api.client.permission.list = (() => permissions.promise) as any
    harness.api.client.question.list = (() => questions.promise) as any

    await tui(harness.api, undefined, {} as any)
    seedTask(harness, taskPart())
    // The server has already taken a snapshot containing this request, but
    // the reply event reaches the TUI before that response promise settles.
    harness.emit("permission.replied", {
      sessionID: "ses_child_1",
      requestID: "perm_answered",
      reply: "once",
    })
    harness.emit("question.rejected", {
      sessionID: "ses_child_1",
      requestID: "question_answered",
    })
    permissions.resolve({
      data: [{ id: "perm_answered", sessionID: "ses_child_1" }],
    })
    questions.resolve({
      data: [{ id: "question_answered", sessionID: "ses_child_1" }],
    })
    await Bun.sleep(0)

    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options[0].title).not.toContain("waiting on you")
  })

  test("a pre-reconnect history response cannot claim the newer request", async () => {
    const harness = makeApi()
    const first = deferred<{ data: MockHistoryMessage[] }>()
    const second = deferred<{ data: MockHistoryMessage[] }>()
    let calls = 0
    const signals: AbortSignal[] = []
    harness.api.client.session.messages = ((
      _parameters: unknown,
      options: MockRequestOptions,
    ) => {
      if (options.signal) signals.push(options.signal)
      return calls++ === 0 ? first.promise : second.promise
    }) as any

    await tui(harness.api, undefined, {} as any)
    harness.layers[0]!.commands[0].run()
    harness.emit("server.connected", {})
    harness.layers[0]!.commands[0].run()
    expect(signals).toHaveLength(2)
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)

    // The old empty snapshot lands while the replacement is pending. It must
    // not mark that newer request done.
    first.resolve({ data: [] })
    await Bun.sleep(0)
    second.resolve({
      data: [
        {
          info: { role: "assistant", id: "msg_after_reconnect" },
          parts: [
            taskPart({
              id: "prt_after_reconnect",
              messageID: "msg_after_reconnect",
            }),
          ],
        },
      ],
    })
    await Bun.sleep(0)

    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[2]!.options).toHaveLength(1)
  })

  test("reconnect hydration refreshes an existing task part", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedTask(
      harness,
      taskPart({
        id: "prt_gap",
        messageID: "msg_gap",
        callID: "call_gap",
      }),
    )

    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options[0].category).toBe("Running")
    await Bun.sleep(0)

    harness.clientMessages.set("ses_1", [
      {
        info: { role: "assistant", id: "msg_gap" },
        parts: [
          taskPart({
            id: "prt_gap",
            messageID: "msg_gap",
            callID: "call_gap",
            state: {
              status: "completed",
              time: { start: 1, end: 2 },
            },
          }),
        ],
      },
    ])

    harness.emit("server.connected", {})
    harness.layers[0]!.commands[0].run()
    await Bun.sleep(0)
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[2]!.options[0].category).toBe("Finished")
  })

  test("the child snapshot cannot predate a child found in history", async () => {
    const harness = makeApi()
    const messages = deferred<{ data: MockHistoryMessage[] }>()
    const releaseChildren = deferred<void>()
    let children: {
      id: string
      parentID: string
      time: { created: number; updated: number }
    }[] = []
    harness.api.client.session.messages = (() => messages.promise) as any
    harness.api.client.session.children = (async () => {
      const snapshot = children.slice()
      await releaseChildren.promise
      return { data: snapshot }
    }) as any

    await tui(harness.api, undefined, {} as any)
    harness.layers[0]!.commands[0].run()
    children = [
      {
        id: "ses_child_1",
        parentID: "ses_1",
        time: { created: 1, updated: 1 },
      },
    ]
    messages.resolve({
      data: [
        {
          info: { role: "assistant", id: "msg_new_child" },
          parts: [
            taskPart({ id: "prt_new_child", messageID: "msg_new_child" }),
          ],
        },
      ],
    })
    releaseChildren.resolve()
    await Bun.sleep(0)
    await Bun.sleep(0)

    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[1]!.options).toHaveLength(1)
    harness.emitPartUpdated(
      taskPart({ id: "prt_new_child", messageID: "msg_new_child" }),
    )
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[2]!.options).toHaveLength(1)
  })
})

describe("the durable record", () => {
  test("a bus-seen task part survives the store evicting its message", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    // Seen once on the bus, but never present in the synced store — the
    // 100-message window has already moved past it.
    harness.emitPartUpdated(taskPart())
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options).toHaveLength(1)
    expect(harness.dialogs[0]!.options[0].title).toContain(
      "explore: find the sync path",
    )
  })

  test("session.deleted drops the parent's record", async () => {
    const harness = makeApi()
    harness.clientMessages.set("ses_1", [
      {
        info: { role: "assistant", id: "msg_deleted_parent" },
        parts: [
          taskPart({
            id: "prt_deleted_parent",
            messageID: "msg_deleted_parent",
          }),
        ],
      },
    ])
    await tui(harness.api, undefined, {} as any)
    harness.emitPartUpdated(taskPart())
    harness.emitSessionDeleted("ses_1")
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options).toHaveLength(0)
    await Bun.sleep(0)
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[1]!.options).toHaveLength(0)
  })

  test("deleting a CHILD removes its row from the parent, and it stays gone", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    // Store-backed on purpose: the spawn part survives the child's deletion
    // in the parent transcript, so every store walk would resurrect the row
    // without the tombstone.
    seedTask(harness, taskPart())
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options).toHaveLength(1)
    harness.emitSessionDeleted("ses_child_1")
    // An option rendered before the deletion cannot navigate afterward.
    harness.dialogs[0]!.options[0].onSelect()
    expect(harness.navigations).toEqual([])
    expect(harness.toasts.at(-1)?.message).toContain("deleted")
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[1]!.options).toHaveLength(0)
    // Not even a late bus re-delivery brings it back.
    harness.emitPartUpdated(taskPart())
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[2]!.options).toHaveLength(0)
  })

  test("reconnect retires a child deleted during the event gap", async () => {
    const harness = makeApi()
    harness.clientChildren.set("ses_1", [
      {
        id: "ses_child_1",
        parentID: "ses_1",
        time: { created: 1, updated: 1 },
      },
    ])
    await tui(harness.api, undefined, {} as any)
    seedTask(harness, taskPart())
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options).toHaveLength(1)
    await Bun.sleep(0)

    // No session.deleted event reached the plugin while disconnected.
    harness.clientChildren.set("ses_1", [])
    harness.emit("server.connected", {})
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[1]!.options).toHaveLength(1)
    harness.dialogs[1]!.options[0].onSelect()
    expect(harness.navigations).toEqual([])
    expect(harness.toasts.at(-1)?.message).toContain("refreshing")
    await Bun.sleep(0)
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[2]!.options).toHaveLength(0)
  })

  test("the viewed parent keeps a deletion past the recent tombstone cap", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    harness.emitSessionDeleted("ses_child_1", "ses_1")
    for (let index = 0; index < 256; index++)
      harness.emitSessionDeleted(`ses_unrelated_${index}`)

    seedTask(harness, taskPart())
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options).toHaveLength(0)
  })

  test("deletion remains authoritative after more than 256 children", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    const childIDs: string[] = []
    for (let index = 0; index < 257; index++) {
      const childID = `ses_deleted_${index}`
      childIDs.push(childID)
      seedTask(
        harness,
        taskPart({
          id: `prt_deleted_${index}`,
          messageID: `msg_deleted_${index}`,
          callID: `call_deleted_${index}`,
          state: { metadata: { sessionId: childID } },
        }),
      )
    }
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options).toHaveLength(257)

    for (const childID of childIDs) harness.emitSessionDeleted(childID)
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[1]!.options).toHaveLength(0)
  })

  test("the recency cap holds and never evicts the viewed session", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    // The viewed session records first, then a flood of background parents.
    harness.emitPartUpdated(taskPart())
    for (let index = 0; index < MAX_TRACKED_SESSIONS + 8; index++) {
      harness.emitPartUpdated(
        taskPart(
          { id: `prt_bg_${index}`, callID: `call_bg_${index}` },
          `ses_bg_${index}`,
        ),
      )
    }
    // ses_1 (the route) must still hold its sighting despite being the
    // oldest-touched entry in the map.
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options).toHaveLength(1)
  })

  test("re-delivery of the same part replaces, never duplicates", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    harness.emitPartUpdated(taskPart({ id: "prt_same", callID: "call_same" }))
    harness.emitPartUpdated(
      taskPart({
        id: "prt_same",
        callID: "call_same",
        state: {
          status: "completed",
          time: { start: 1, end: 2 },
        },
      }),
    )
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options).toHaveLength(1)
    expect(harness.dialogs[0]!.options[0].category).toBe("Finished")
  })

  test("a resumed task shows one row, not one per run", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedTask(
      harness,
      taskPart({
        id: "prt_first",
        callID: "call_first",
        state: { status: "completed", time: { start: 1, end: 2 } },
      }),
    )
    seedTask(
      harness,
      taskPart({ id: "prt_resume", messageID: "msg_2", callID: "call_resume" }),
    )
    harness.layers[0]!.commands[0].run()
    expect(harness.dialogs[0]!.options).toHaveLength(1)
    expect(harness.dialogs[0]!.options[0].category).toBe("Running")
  })
})

describe("disposal", () => {
  test("dispose aborts hydration and clears the ticker and subscriptions", async () => {
    const harness = makeApi()
    const messages = deferred<{ data: MockHistoryMessage[] }>()
    let signal: AbortSignal | undefined
    harness.api.client.session.messages = ((
      _parameters: unknown,
      options: MockRequestOptions,
    ) => {
      signal = options.signal
      return messages.promise
    }) as any
    await tui(harness.api, undefined, {} as any)
    harness.layers[0]!.commands[0].run()
    expect(signal?.aborted).toBe(false)
    await harness.dispose()
    expect(signal?.aborted).toBe(true)
    messages.resolve({ data: [] })
    await Bun.sleep(0)
    expect(harness.disposeErrors).toEqual([])
  })

  test("reconnect during disposal cannot start live hydration", async () => {
    const harness = makeApi()
    const never = new Promise<never>(() => {})
    const signals: AbortSignal[] = []
    harness.api.client.permission.list = ((
      _parameters: unknown,
      options: MockRequestOptions,
    ) => {
      if (options.signal) signals.push(options.signal)
      return never
    }) as any

    await tui(harness.api, undefined, {} as any)
    expect(signals).toHaveLength(1)
    const disposing = harness.dispose()
    queueMicrotask(() => harness.emit("server.connected", {}))
    await disposing

    expect(signals).toHaveLength(1)
    expect(signals[0]!.aborted).toBe(true)
  })

  test("a stale dialog callback is inert after disposal", async () => {
    const harness = makeApi()
    await tui(harness.api, undefined, {} as any)
    seedTask(harness, taskPart())
    harness.layers[0]!.commands[0].run()
    const option = harness.dialogs[0]!.options[0]

    await harness.dispose()
    option.onSelect()

    expect(harness.dialogClears()).toBe(0)
    expect(harness.navigations).toEqual([])
  })
})

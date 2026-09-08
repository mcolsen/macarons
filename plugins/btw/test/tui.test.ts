import { describe, expect, spyOn, test } from "bun:test"
import { mintMessageID } from "@macarons/permission-rules"
import { flush, until } from "@macarons/plugin-test-harness"
import { describeGating } from "@macarons/plugin-test-harness/tui"
import { createSignal } from "solid-js"
import {
  LEASE_INTERVAL_MS,
  markerFor,
  markerOf,
  PROMPT_CONFIRM_DELAYS_MS,
  resolveOptions,
} from "../src/shared"
import { timing } from "../src/tui"
import { createBtwController, type Panel } from "../src/tui-controller"
import { command, load, makeApi } from "./harness"

describeGating({
  remoteBails: false,
  load: async (input) => {
    const mock = makeApi(input)
    await mock.load()
    const run = {
      toasts: mock.toasts,
      registered: mock.layers.length === 1,
      inert:
        mock.layers.length === 0 &&
        mock.slotPlugins.length === 0 &&
        mock.handlers.size === 0,
    }
    await mock.dispose()
    return run
  },
})

describe("runtime compatibility gate: prerelease host", () => {
  // BAND_SAMPLE_VERSIONS carries no prerelease member, so this leg stays
  // inline: the major gate outranks the prerelease fallback — a non-v1
  // prerelease disables the plugin, it does not warn-and-run as "untested".
  test("a non-v1 prerelease (2.0.0-beta.1) registers nothing, saying so", async () => {
    const mock = makeApi({ version: "2.0.0-beta.1" })
    await mock.load()
    expect(mock.layers).toHaveLength(0)
    expect(mock.slotPlugins).toHaveLength(0)
    expect(mock.handlers.size).toBe(0)
    expect(
      mock.toasts.some(
        (t) =>
          t.variant === "warning" && String(t.message).includes("disabled"),
      ),
    ).toBe(true)
    await mock.dispose()
  })
})

describe("registration", () => {
  test("registers ask/open/copy/reopen in the palette with configured keybinds", async () => {
    const harness = makeApi()
    const layer = await load(harness)
    const names = layer.commands.map((c: { name: string }) => c.name).sort()
    expect(names).toEqual(["btw.ask", "btw.copy", "btw.open", "btw.reopen"])
    const ask = layer.commands.find(
      (c: { name: string }) => c.name === "btw.ask",
    )
    expect(ask.title).toBe("BTW")
    expect(ask.category).toBe("BTW")
    expect(ask.namespace).toBe("palette")
    expect(ask.slashName).toBeUndefined()
    expect(ask.slashAliases).toBeUndefined()
    const keys = layer.bindings.map((b: { key: string }) => b.key)
    expect(keys).toContain("<leader>w,ctrl+alt+w")
  })

  test("registers no slots — btw draws nothing outside its own panel", async () => {
    const harness = makeApi()
    await load(harness)
    expect(harness.slotPlugins).toHaveLength(0)
  })

  test("keybind:false leaves only the palette entries", async () => {
    const harness = makeApi()
    const layer = await load(harness, { keybind: false })
    expect(
      layer.bindings.some((b: { cmd: string }) => b.cmd === "btw.ask"),
    ).toBe(false)
    expect(
      layer.commands.some((c: { name: string }) => c.name === "btw.ask"),
    ).toBe(true)
  })
})

function latestPromptMessageID(harness: ReturnType<typeof makeApi>): string {
  const id = harness.calls
    .filter((call) => call.method === "session.promptAsync")
    .at(-1)?.params.messageID
  if (typeof id !== "string") throw new Error("no prompt message id captured")
  return id
}

describe("asking", () => {
  test("opens a prompt, then forks + marks + asks in the fork", async () => {
    const harness = makeApi({
      parentModel: { id: "claude-sonnet-5", providerID: "anthropic" },
    })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    const prompt = harness.prompt()
    expect(prompt?.title).toBe("BTW")

    prompt?.onConfirm("why backoff?")
    await flush()

    const fork = harness.calls.find((c) => c.method === "session.fork")
    expect(fork?.params.sessionID).toBe("ses_parent")
    const update = harness.calls.find((c) => c.method === "session.update")
    expect(markerOf(update?.params.metadata)).toMatchObject({
      parent: "ses_parent",
      tools: "read-only",
    })
    const ask = harness.calls.find((c) => c.method === "session.promptAsync")
    expect(ask?.params.sessionID).toBe("ses_fork")
    expect(ask?.params.messageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(ask?.params.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-5",
    })
    const parts = ask?.params.parts as { text: string }[]
    expect(parts[0]!.text).toContain("why backoff?")
  })

  test("keeps routing an initial prompt whose response was lost after persistence", async () => {
    const harness = makeApi({
      parentModel: { id: "claude-sonnet-5", providerID: "anthropic" },
    })
    harness.persistPromptMessages()
    harness.rejectOnce("session.promptAsync", new Error("socket closed"))
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("why backoff?")
    await flush()

    const ask = harness.calls.find((c) => c.method === "session.promptAsync")
    const lookup = harness.calls.find((c) => c.method === "session.message")
    expect(lookup?.params.messageID).toBe(ask?.params.messageID)
    expect(harness.calls.some((c) => c.method === "session.delete")).toBe(false)

    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: "msg_50",
        role: "assistant",
        parentID: latestPromptMessageID(harness),
      },
    })
    harness.emit("message.part.updated", {
      sessionID: "ses_fork",
      part: {
        id: "prt_1",
        type: "text",
        messageID: "msg_50",
        text: "Because retries need jitter.",
      },
    })
    harness.emit("session.idle", { sessionID: "ses_fork" })
    await command(layer, "btw.copy")()
    expect(harness.copied).toEqual(["Because retries need jitter."])
    expect(
      harness.calls.filter((c) => c.method === "session.promptAsync"),
    ).toHaveLength(1)
  })

  test("keeps an ambiguously delivered initial prompt active and warns against resending", async () => {
    timing.promptConfirmDelaysMs = []
    try {
      const harness = makeApi({
        parentModel: { id: "claude-sonnet-5", providerID: "anthropic" },
      })
      harness.rejectOnce("session.promptAsync", new Error("socket closed"))
      const layer = await load(harness)
      await command(layer, "btw.ask")()
      harness.prompt()?.onConfirm("why backoff?")
      await flush()

      expect(harness.calls.some((c) => c.method === "session.delete")).toBe(
        false,
      )
      expect(harness.toasts.at(-1)?.message).toContain("do not resend")
    } finally {
      timing.promptConfirmDelaysMs = PROMPT_CONFIRM_DELAYS_MS
    }
  })

  test("a dismissal racing initial admission re-aborts the fork", async () => {
    const harness = makeApi({
      parentModel: { id: "claude-sonnet-5", providerID: "anthropic" },
    })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.during("session.promptAsync", () => harness.escapeDialog())
    harness.prompt()?.onConfirm("why backoff?")
    await flush()

    const aborts = harness.calls.filter(
      (call) =>
        call.method === "session.abort" && call.params.sessionID === "ses_fork",
    )
    expect(aborts).toHaveLength(2)
  })

  test("an initial watchdog timeout during admission re-aborts the fork", async () => {
    timing.promptConfirmDelaysMs = [100]
    timing.leaseIntervalMs = 10
    let harness: ReturnType<typeof makeApi> | undefined
    try {
      harness = makeApi({
        parentModel: { id: "claude-sonnet-5", providerID: "anthropic" },
      })
      harness.rejectOnce("session.promptAsync", new Error("socket closed"))
      const layer = await load(harness, { timeoutMs: 5 })
      await command(layer, "btw.ask")()
      harness.prompt()?.onConfirm("why backoff?")
      await new Promise((resolve) => setTimeout(resolve, 30))
      await flush()

      expect(
        harness.calls.filter(
          (call) =>
            call.method === "session.update" &&
            call.params.sessionID === "ses_fork" &&
            markerOf(call.params.metadata),
        ).length,
      ).toBeGreaterThan(1)

      await new Promise((resolve) => setTimeout(resolve, 100))
      await flush()
      const aborts = harness.calls.filter(
        (call) =>
          call.method === "session.abort" &&
          call.params.sessionID === "ses_fork",
      )
      expect(aborts).toHaveLength(2)
    } finally {
      await harness?.dispose()
      timing.promptConfirmDelaysMs = PROMPT_CONFIRM_DELAYS_MS
      timing.leaseIntervalMs = LEASE_INTERVAL_MS
    }
  })

  test("empty question clears the dialog without forking", async () => {
    const harness = makeApi()
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("   ")
    await flush()
    expect(harness.calls.some((c) => c.method === "session.fork")).toBe(false)
  })

  test("asking off a session route is refused", async () => {
    const harness = makeApi({ routeSessionID: null })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    expect(harness.calls.some((c) => c.method === "session.fork")).toBe(false)
    expect(harness.toasts.at(-1)?.message).toContain("Open a session first")
  })

  test("a session with no conversation is discarded, not asked", async () => {
    const harness = makeApi({ messages: [] })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    expect(harness.calls.some((c) => c.method === "session.promptAsync")).toBe(
      false,
    )
    expect(harness.calls.some((c) => c.method === "session.delete")).toBe(true)
    expect(harness.toasts.at(-1)?.message).toContain("no conversation yet")
  })
})

// Drive an active side question to the point where an answer has streamed.
async function withStreamedAnswer(
  answer: string,
  options?: Record<string, unknown>,
  input: NonNullable<Parameters<typeof makeApi>[0]> = {},
) {
  const harness = makeApi({
    parentModel: { id: "m", providerID: "p" },
    ...input,
  })
  const layer = await load(harness, options)
  await command(layer, "btw.ask")()
  harness.prompt()?.onConfirm("q")
  await flush()
  harness.emit("message.updated", {
    sessionID: "ses_fork",
    info: {
      id: "msg_50",
      role: "assistant",
      parentID: latestPromptMessageID(harness),
    },
  })
  harness.emit("message.part.updated", {
    sessionID: "ses_fork",
    part: { id: "prt_1", type: "text", messageID: "msg_50", text: answer },
  })
  harness.emit("session.idle", { sessionID: "ses_fork" })
  return { harness, layer }
}

async function promptVariantsForDefaultSession(variant?: "default") {
  const { harness, layer } = await withStreamedAnswer(
    "first answer",
    undefined,
    {
      parentModel: { id: "m", providerID: "p", variant: "default" },
      messages: [
        {
          info: {
            id: "msg_01",
            role: "user",
            model: {
              providerID: "p",
              modelID: "m",
              ...(variant === undefined ? {} : { variant }),
            },
          },
        },
        {
          info: {
            id: "msg_02",
            role: "assistant",
            time: { completed: 5 },
          },
        },
      ],
    },
  )

  await command(layer, "btw.ask")()
  harness.prompt()?.onConfirm("follow up")
  await flush()

  return harness.calls
    .filter((call) => call.method === "session.promptAsync")
    .map((call) => call.params.variant)
}

describe("answer lifecycle", () => {
  test("accumulates streamed text (observed via copy) and reports clipboard support", async () => {
    const { harness, layer } = await withStreamedAnswer(
      "Because retries need jitter.",
    )
    await command(layer, "btw.copy")()
    expect(harness.copied).toEqual(["Because retries need jitter."])
    expect(harness.toasts.at(-1)?.variant).toBe("success")
  })

  test("open-as-session drops the marker, renames, and navigates", async () => {
    const { harness, layer } = await withStreamedAnswer("answer")
    await command(layer, "btw.open")()
    await flush()
    const update = harness.calls
      .filter((c) => c.method === "session.update")
      .at(-1)
    expect(update?.params.metadata).toEqual({})
    expect(harness.navigations).toEqual([
      ["session", { sessionID: "ses_fork" }],
    ])
    // Adopted: it is not deleted afterwards.
    expect(harness.calls.some((c) => c.method === "session.delete")).toBe(false)
  })

  test("asking again while the answer is open continues the thread as a follow-up", async () => {
    const { harness, layer } = await withStreamedAnswer("answer")
    await command(layer, "btw.ask")()
    expect(harness.prompt()?.title).toBe("Ask a follow-up")
  })

  test("dismissing the panel mid-stream aborts and finalizes the exchange", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: "msg_50",
        role: "assistant",
        parentID: latestPromptMessageID(harness),
      },
    })
    harness.emit("message.part.delta", {
      sessionID: "ses_fork",
      messageID: "msg_50",
      partID: "prt_1",
      field: "text",
      delta: "partial",
    })

    harness.closeDialog() // esc while streaming
    expect(
      harness.calls.some(
        (c) =>
          c.method === "session.abort" && c.params.sessionID === "ses_fork",
      ),
    ).toBe(true)

    // The abort's late idle event must not resurrect the exchange or toast.
    harness.emit("session.idle", { sessionID: "ses_fork" })
    expect(harness.toasts.some((t) => t.message?.includes("answered"))).toBe(
      false,
    )

    // The partial answer stays copyable; reuse waits for the abort's ack.
    await flush()
    await command(layer, "btw.reopen")()
    await command(layer, "btw.copy")()
    expect(harness.copied).toEqual(["partial"])
    await command(layer, "btw.ask")()
    expect(harness.prompt()?.title).toBe("Ask a follow-up")
  })
})

describe("follow-up dialog", () => {
  // The host runs the outgoing dialog's close callback synchronously inside
  // replace()/Escape/clear() — both paths here overflowed the stack before the
  // close callbacks became replace-aware (the harness mimics those semantics).
  test("confirming a follow-up returns to the panel and asks in the same fork", async () => {
    const { harness, layer } = await withStreamedAnswer("first answer")
    await command(layer, "btw.ask")()
    expect(harness.prompt()?.title).toBe("Ask a follow-up")

    harness.prompt()?.onConfirm("and why jitter?")
    await flush()

    const prompts = harness.calls.filter(
      (c) => c.method === "session.promptAsync",
    )
    expect(prompts).toHaveLength(2)
    expect(prompts[1]!.params.sessionID).toBe("ses_fork")
    expect(prompts[1]!.params.messageID).toMatch(
      /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    )
    expect(prompts[1]!.params.messageID).not.toBe(prompts[0]!.params.messageID)
    expect((prompts[1]!.params.parts as { text: string }[])[0]!.text).toContain(
      "and why jitter?",
    )
    expect(harness.dialogOpen()).toBe(true) // back on the panel, streaming the follow-up
  })

  test('keeps the inherited host "default" sentinel stripped on follow-up', async () => {
    expect(await promptVariantsForDefaultSession()).toEqual([
      undefined,
      undefined,
    ])
  })

  test('preserves a literal "default" variant on follow-up', async () => {
    expect(await promptVariantsForDefaultSession("default")).toEqual([
      "default",
      "default",
    ])
  })

  test("a definitive follow-up rejection becomes terminal without deleting the fork", async () => {
    const { harness, layer } = await withStreamedAnswer("first answer")
    await command(layer, "btw.ask")()
    harness.failWith("session.promptAsync", { name: "BadRequest" })
    harness.prompt()?.onConfirm("and why jitter?")
    await flush()

    const prompts = harness.calls.filter(
      (c) => c.method === "session.promptAsync",
    )
    expect(prompts).toHaveLength(2)
    expect(prompts[1]!.params.messageID).toMatch(
      /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    )
    expect(harness.calls.some((c) => c.method === "session.delete")).toBe(false)
    await command(layer, "btw.ask")()
    expect(harness.prompt()?.title).toBe("Ask a follow-up")
  })

  test("a definitive rejection does not quarantine the next prompt's early error", async () => {
    const { harness, layer } = await withStreamedAnswer("first answer")
    await command(layer, "btw.ask")()
    harness.failWith("session.promptAsync", { name: "BadRequest" })
    harness.prompt()?.onConfirm("rejected follow-up")
    await flush()

    harness.clearFailure("session.promptAsync")
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("next follow-up")
    await flush()
    harness.emit("session.error", {
      sessionID: "ses_fork",
      error: { name: "ProviderError" },
    })

    await command(layer, "btw.ask")()
    expect(harness.prompt()?.title).toBe("Ask a follow-up")
  })

  test("routes a follow-up whose response was lost after persistence", async () => {
    const { harness, layer } = await withStreamedAnswer("first answer")
    harness.persistPromptMessages()
    harness.rejectOnce("session.promptAsync", new Error("socket closed"))
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("and why jitter?")
    await flush()

    const prompts = harness.calls.filter(
      (c) => c.method === "session.promptAsync",
    )
    const lookup = harness.calls.find((c) => c.method === "session.message")
    expect(prompts).toHaveLength(2)
    expect(lookup?.params.messageID).toBe(prompts[1]!.params.messageID)
    expect(harness.calls.some((c) => c.method === "session.delete")).toBe(false)

    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: "msg_60",
        role: "assistant",
        parentID: latestPromptMessageID(harness),
      },
    })
    harness.emit("message.part.updated", {
      sessionID: "ses_fork",
      part: {
        id: "prt_2",
        type: "text",
        messageID: "msg_60",
        text: "More jitter prevents synchronization.",
      },
    })
    harness.emit("session.idle", { sessionID: "ses_fork" })
    await command(layer, "btw.copy")()
    expect(harness.copied).toEqual(["More jitter prevents synchronization."])
    expect(
      harness.calls.filter((c) => c.method === "session.promptAsync"),
    ).toHaveLength(2)
  })

  test("dismissing the panel while a follow-up is being prepared cancels it — no hidden prompt", async () => {
    const { harness, layer } = await withStreamedAnswer("first answer")
    await command(layer, "btw.ask")()
    // Escape lands while the follow-up's session.get is still in flight: the
    // close handler stops the fork and finalizes the exchange. The follow-up
    // must notice and never prompt — a prompt now would stream unwatched
    // behind a closed panel, with nothing left to stop it.
    harness.during("session.get", () => harness.escapeDialog())
    harness.prompt()?.onConfirm("and why jitter?")
    await flush()

    expect(
      harness.calls.filter((c) => c.method === "session.promptAsync"),
    ).toHaveLength(1) // the original question only
  })

  test("a dismissal racing the follow-up's admission re-aborts the fork", async () => {
    const { harness, layer } = await withStreamedAnswer("first answer")
    await command(layer, "btw.ask")()
    // Escape lands after promptAsync is already on the wire. The close
    // handler's abort may beat the admission, so the follow-up must abort
    // again once the prompt resolves — otherwise the fork generates on,
    // hidden, until the orphan sweep.
    harness.during("session.promptAsync", () => harness.escapeDialog())
    harness.prompt()?.onConfirm("and why jitter?")
    await flush()

    const aborts = harness.calls.filter(
      (c) => c.method === "session.abort" && c.params.sessionID === "ses_fork",
    )
    expect(aborts).toHaveLength(2) // the dismissal's, then the follow-up's own
  })

  test("a fenced thread warns before a fresh question can replace it", async () => {
    const { harness, layer } = await withStreamedAnswer("first answer")
    timing.promptConfirmDelaysMs = []
    try {
      harness.rejectOnce("session.promptAsync", new Error("socket closed"))
      await command(layer, "btw.ask")()
      harness.prompt()?.onConfirm("unconfirmed follow-up")
      await flush()
      harness.escapeDialog()
      await flush()
      await command(layer, "btw.reopen")()

      await command(layer, "btw.ask")()
      expect(harness.prompt()?.title).toBe("BTW")
      expect(harness.toasts.at(-1)?.variant).toBe("warning")
      expect(harness.toasts.at(-1)?.message).toContain("unconfirmed")
      expect(harness.toasts.at(-1)?.message).toContain(
        "will replace this thread",
      )
      expect(
        harness.calls.some((call) => call.method === "session.delete"),
      ).toBe(false)

      harness.prompt()?.onCancel()
      await command(layer, "btw.reopen")()
      expect(harness.dialogOpen()).toBe(true)
      expect(
        harness.calls.some((call) => call.method === "session.delete"),
      ).toBe(false)

      await command(layer, "btw.ask")()
      harness.prompt()?.onConfirm("fresh question")
      await flush()
      expect(
        harness.calls.filter((call) => call.method === "session.delete"),
      ).toHaveLength(1)
      const prompts = harness.calls.filter(
        (call) => call.method === "session.promptAsync",
      )
      expect(prompts).toHaveLength(3)
      expect(prompts.at(-1)?.params.parts).toEqual([
        expect.objectContaining({
          text: expect.stringContaining("fresh question"),
        }),
      ])
    } finally {
      timing.promptConfirmDelaysMs = PROMPT_CONFIRM_DELAYS_MS
      await harness.dispose()
    }
  })

  test("a fence engaging while a follow-up is typed reports that it was not sent", async () => {
    const { harness, layer } = await withStreamedAnswer("first answer")
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("second question")
    await flush()
    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: "msg_60",
        role: "assistant",
        parentID: latestPromptMessageID(harness),
      },
    })
    harness.emit("session.idle", { sessionID: "ses_fork" })
    await command(layer, "btw.ask")()
    expect(harness.prompt()?.title).toBe("Ask a follow-up")

    const response = Promise.withResolvers<void>()
    const abort = harness.api.client.session.abort
    harness.api.client.session.abort = async (params) => {
      harness.api.client.session.abort = abort
      const result = await abort(params)
      await response.promise
      return result
    }
    try {
      // A foreign permission approval requires an abort even if the preceding
      // exchange already finished. Its acknowledgement can race dialog input.
      harness.emit("permission.replied", {
        sessionID: "ses_fork",
        requestID: "per_late",
        reply: "always",
      })
      harness.prompt()?.onConfirm("typed while the abort became pending")
      await flush()
      expect(harness.toasts.at(-1)).toMatchObject({
        variant: "warning",
        message:
          "Follow-up not sent: delivery or cancellation is still unconfirmed.",
      })
      expect(
        harness.calls.filter((call) => call.method === "session.promptAsync"),
      ).toHaveLength(2)
      expect(
        harness.calls.some((call) => call.method === "session.delete"),
      ).toBe(false)
    } finally {
      response.resolve()
      await flush()
      await harness.dispose()
    }
  })

  test("a new question superseding an in-flight follow-up never prompts the new fork with the old text", async () => {
    // Reproduce withStreamedAnswer with distinguishable fork ids.
    const harness = makeApi({
      parentModel: { id: "m", providerID: "p" },
      dynamicForks: true,
    })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    harness.emit("message.updated", {
      sessionID: "ses_fork_1",
      info: {
        id: "msg_50",
        role: "assistant",
        parentID: latestPromptMessageID(harness),
      },
    })
    harness.emit("message.part.updated", {
      sessionID: "ses_fork_1",
      part: {
        id: "prt_1",
        type: "text",
        messageID: "msg_50",
        text: "first answer",
      },
    })
    harness.emit("session.idle", { sessionID: "ses_fork_1" })

    await command(layer, "btw.ask")()
    expect(harness.prompt()?.title).toBe("Ask a follow-up")
    // While the follow-up's session.get is in flight, the user asks a brand-new
    // question (allowed mid-stream), which releases ses_fork_1 and installs
    // ses_fork_2. The stale follow-up reads `active` again after its await —
    // without revalidation it would fire the OLD text at the NEW fork.
    let interleaved = false
    harness.during("session.get", () => {
      if (interleaved) return
      interleaved = true
      void command(layer, "btw.ask")()
      harness.prompt()?.onConfirm("brand new question")
    })
    // Hold the follow-up's session.get until the new start has fully
    // installed its fork — the exact interleaving where re-reading the
    // mutable `active` after the await targets the NEW session.
    harness.delayOnce("session.get", 25)
    harness.prompt()?.onConfirm("stale follow-up")
    await flush()

    const prompts = harness.calls.filter(
      (c) => c.method === "session.promptAsync",
    )
    expect(
      prompts.some((c) =>
        (c.params.parts as { text: string }[])[0]!.text.includes(
          "stale follow-up",
        ),
      ),
    ).toBe(false)
    const toNewFork = prompts.filter((c) => c.params.sessionID === "ses_fork_2")
    expect(toNewFork).toHaveLength(1)
    expect(
      (toNewFork[0]!.params.parts as { text: string }[])[0]!.text,
    ).toContain("brand new question")
    // The superseded fork was cleaned up, not left to the sweep.
    expect(
      harness.calls.some(
        (c) =>
          c.method === "session.delete" && c.params.sessionID === "ses_fork_1",
      ),
    ).toBe(true)

    // And the stale follow-up must not have finalized the NEW panel's
    // exchange either (its old code path errored the fresh exchange out
    // before a single token arrived): the new answer still streams,
    // completes, and is copyable.
    harness.emit("message.updated", {
      sessionID: "ses_fork_2",
      info: {
        id: "msg_60",
        role: "assistant",
        parentID: latestPromptMessageID(harness),
      },
    })
    harness.emit("message.part.updated", {
      sessionID: "ses_fork_2",
      part: {
        id: "prt_2",
        type: "text",
        messageID: "msg_60",
        text: "fresh answer",
      },
    })
    harness.emit("session.idle", { sessionID: "ses_fork_2" })
    await command(layer, "btw.copy")()
    expect(harness.copied).toEqual(["fresh answer"])
  })

  test("escaping a follow-up reopens the panel without touching the fork", async () => {
    const { harness, layer } = await withStreamedAnswer("first answer")
    await command(layer, "btw.ask")()
    expect(harness.prompt()?.title).toBe("Ask a follow-up")
    const before = harness.calls.length

    harness.escapeDialog()
    await flush() // the reopen is deferred a microtask past the host's stack pop

    expect(harness.dialogOpen()).toBe(true)
    expect(harness.calls.slice(before)).toHaveLength(0) // no abort, no prompt, no delete
    // The reopened panel still continues the thread.
    await command(layer, "btw.ask")()
    expect(harness.prompt()?.title).toBe("Ask a follow-up")
  })
})

describe("follow-up setup deadline", () => {
  async function setup() {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    const options = resolveOptions(undefined)
    const [panel, setPanel] = createSignal<Panel | null>(null)
    const controller = createBtwController(
      harness.api as unknown as Parameters<typeof createBtwController>[0],
      options,
      (variant, message) => harness.toasts.push({ variant, message }),
      { panel, setPanel },
    )
    await controller.beginQuestion("ses_parent", "first question")
    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: "msg_50",
        role: "assistant",
        parentID: latestPromptMessageID(harness),
      },
    })
    harness.emit("message.part.updated", {
      sessionID: "ses_fork",
      part: {
        id: "prt_1",
        type: "text",
        messageID: "msg_50",
        text: "first answer",
      },
    })
    harness.emit("session.idle", { sessionID: "ses_fork" })
    return { harness, options, controller, panel }
  }

  function hold(
    harness: ReturnType<typeof makeApi>,
    method: "get" | "promptAsync" | "message" | "abort" | "update",
  ) {
    const response = Promise.withResolvers<void>()
    const original = harness.api.client.session[method]
    let entered = false
    let signal: AbortSignal | undefined
    harness.api.client.session[method] = async (
      params,
      request?: { signal?: AbortSignal },
    ) => {
      harness.api.client.session[method] = original
      signal = request?.signal
      entered = true
      const result = await original(params)
      // Ignore cancellation, like a wedged transport: the caller must stop
      // waiting AND handle a response that eventually arrives anyway.
      await response.promise
      return result
    }
    return { ...response, entered: () => entered, signal: () => signal }
  }

  for (const method of ["get", "promptAsync"] as const) {
    for (const stop of [
      "timeout",
      "dismissal",
      "disposal",
      "kept disposal",
    ] as const) {
      test(`${stop} bounds an unresolved follow-up session.${method}`, async () => {
        const { harness, options, controller, panel } = await setup()
        if (stop === "timeout") options.timeoutMs = 30
        options.keepSessions = stop === "kept disposal"
        const held = hold(harness, method)
        let settled = false
        const pending = controller.askFollowUp("held follow-up").then(() => {
          settled = true
        })
        try {
          await until(held.entered)
          if (stop === "dismissal") controller.onPanelDismiss()
          if (stop.includes("disposal")) await controller.dispose()
          await until(() => settled, {
            timeoutMs: 500,
            label: `${stop} settles session.${method} while it is held`,
          })
          expect(held.signal()?.aborted).toBe(true)
          if (!stop.includes("disposal")) {
            expect(panel()?.starting).toBe(false)
            expect(panel()?.exchanges.at(-1)?.status).toBe("error")
            if (stop === "timeout") {
              expect(panel()?.exchanges.at(-1)?.error).toContain("timed out")
              expect(panel()?.exchanges.at(-1)?.error).toContain(
                method === "get"
                  ? "Follow-up session lookup"
                  : "Follow-up admission",
              )
              if (method === "get")
                expect(panel()?.exchanges.at(-1)?.error).not.toContain(
                  "do not resend",
                )
            }
          }
          expect(
            harness.calls.filter((call) => call.method === "session.abort"),
          ).toHaveLength(method === "get" ? 0 : 1)
          expect(
            harness.calls.filter((call) => call.method === "session.delete"),
          ).toHaveLength(stop === "disposal" ? 1 : 0)
          if (stop === "kept disposal")
            expect(
              harness.calls
                .filter((call) => call.method === "session.update")
                .at(-1)?.params.metadata,
            ).toEqual({})
          const terminal = panel()

          held.resolve()
          await flush()
          expect(
            harness.calls.filter(
              (call) => call.method === "session.promptAsync",
            ),
          ).toHaveLength(method === "get" ? 1 : 2)
          expect(
            harness.calls.filter((call) => call.method === "session.abort"),
          ).toHaveLength(method === "get" ? 0 : 2)
          expect(panel()).toEqual(terminal)
        } finally {
          held.resolve()
          await pending
          await controller.dispose()
        }
      })
    }
  }

  test("only streamed progress extends the deadline, not lookup or admission responses", async () => {
    const { harness, options, controller } = await setup()
    options.timeoutMs = 12_345
    const timers = spyOn(globalThis, "setTimeout")
    const lookup = hold(harness, "get")
    const admission = hold(harness, "promptAsync")
    const deadlines = () =>
      timers.mock.calls.filter(([, ms]) => ms === options.timeoutMs)
    try {
      const pending = controller.askFollowUp("follow-up")
      expect(deadlines()).toHaveLength(1)
      lookup.resolve()
      await until(admission.entered)
      expect(deadlines()).toHaveLength(1)
      harness.emit("message.updated", {
        sessionID: "ses_fork",
        info: {
          id: "msg_60",
          role: "assistant",
          parentID: latestPromptMessageID(harness),
        },
      })
      expect(deadlines()).toHaveLength(2)
      harness.emit("message.part.delta", {
        sessionID: "ses_fork",
        messageID: "msg_60",
        partID: "prt_2",
        field: "text",
        delta: "progress",
      })
      expect(deadlines()).toHaveLength(3)
      admission.resolve()
      await pending
      expect(deadlines()).toHaveLength(3)
    } finally {
      lookup.resolve()
      admission.resolve()
      timers.mockRestore()
      await controller.dispose()
    }
  })

  test("a timed-out lookup cannot dispatch into its replacement", async () => {
    const { harness, options, controller, panel } = await setup()
    options.timeoutMs = 30
    const held = hold(harness, "get")
    try {
      await controller.askFollowUp("cancelled follow-up")
      expect(controller.canFollowUp()).toBe(true)
      options.timeoutMs = 180_000
      await controller.askFollowUp("replacement")
      const replacement = panel()
      held.resolve()
      await flush()
      const prompts = harness.calls.filter(
        (call) => call.method === "session.promptAsync",
      )
      expect(prompts).toHaveLength(2)
      expect(prompts.at(-1)?.params.parts).toEqual([
        expect.objectContaining({
          text: expect.stringContaining("replacement"),
        }),
      ])
      expect(
        harness.calls.filter((call) => call.method === "session.abort"),
      ).toHaveLength(0)
      expect(panel()).toEqual(replacement)
      harness.emit("session.error", {
        sessionID: "ses_fork",
        error: { name: "ProviderError" },
      })
      expect(panel()?.exchanges.at(-1)?.error).toContain("ProviderError")
    } finally {
      held.resolve()
      await controller.dispose()
    }
  })

  test("cancelled admission gates reuse through late acceptance and abort acknowledgement", async () => {
    const { harness, controller, panel } = await setup()
    const admission = hold(harness, "promptAsync")
    let cleanup: ReturnType<typeof hold> | undefined
    try {
      const pending = controller.askFollowUp("cancelled follow-up")
      await until(admission.entered)
      controller.onPanelDismiss()
      await pending
      const stopped = panel()
      expect(controller.canFollowUp()).toBe(false)
      await controller.runOpen()
      expect(harness.navigations).toHaveLength(0)
      expect(harness.toasts.at(-1)?.message).toContain("still unconfirmed")
      await controller.askFollowUp("unsafe replacement")
      expect(panel()).toEqual(stopped)
      expect(harness.toasts.at(-1)?.message).toBe(
        "Follow-up not sent: delivery or cancellation is still unconfirmed.",
      )

      cleanup = hold(harness, "abort")
      admission.resolve()
      await until(cleanup.entered)
      expect(controller.canFollowUp()).toBe(false)
      await controller.runOpen()
      expect(harness.navigations).toHaveLength(0)
      await controller.askFollowUp("still unsafe")
      expect(panel()).toEqual(stopped)

      cleanup.resolve()
      await until(() => controller.canFollowUp())
      await controller.askFollowUp("safe replacement")
      expect(panel()?.exchanges.at(-1)?.question).toBe("safe replacement")
      expect(
        harness.calls.filter((call) => call.method === "session.promptAsync"),
      ).toHaveLength(3)
      expect(
        harness.calls.filter((call) => call.method === "session.abort"),
      ).toHaveLength(2)
    } finally {
      admission.resolve()
      cleanup?.resolve()
      await controller.dispose()
    }
  })

  for (const result of ["rejected transport", "SDK error"] as const) {
    test(`a cancelled admission's ${result} stays ambiguous, not retryable`, async () => {
      const { harness, options, controller, panel } = await setup()
      options.timeoutMs = 30
      const original = harness.api.client.session.promptAsync
      harness.api.client.session.promptAsync = async (
        params,
        request?: { signal?: AbortSignal },
      ) => {
        await original(params)
        return new Promise((resolve, reject) => {
          request?.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("request aborted")
              if (result === "SDK error") resolve({ error })
              else reject(error)
            },
            { once: true },
          )
        })
      }
      try {
        await controller.askFollowUp("unconfirmed follow-up")
        await flush()
        expect(panel()?.exchanges.at(-1)?.error).toContain("do not resend")
        expect(controller.canFollowUp()).toBe(false)
        await controller.askFollowUp("do not dispatch this")
        expect(
          harness.calls.filter((call) => call.method === "session.promptAsync"),
        ).toHaveLength(2)
        expect(
          harness.calls.filter((call) => call.method === "session.abort"),
        ).toHaveLength(2)
        expect(
          harness.calls.some(
            (call) =>
              call.method === "session.message" ||
              call.method === "session.delete",
          ),
        ).toBe(false)
      } finally {
        await controller.dispose()
      }
    })
  }

  test("an ambiguous response remains gated when cancellation happens afterward", async () => {
    const { harness, controller } = await setup()
    timing.promptConfirmDelaysMs = []
    harness.rejectOnce("session.promptAsync", new Error("socket closed"))
    try {
      await controller.askFollowUp("unconfirmed follow-up")
      expect(harness.toasts.at(-1)?.message).toContain("do not resend")
      controller.onPanelDismiss()
      await flush()
      expect(controller.canFollowUp()).toBe(false)
      await controller.askFollowUp("unsafe replacement")
      expect(
        harness.calls.filter((call) => call.method === "session.promptAsync"),
      ).toHaveLength(2)
    } finally {
      timing.promptConfirmDelaysMs = PROMPT_CONFIRM_DELAYS_MS
      await controller.dispose()
    }
  })

  test("a delayed streaming abort fences reuse and a racing promotion", async () => {
    const { harness, controller } = await setup()
    await controller.askFollowUp("accepted follow-up")
    const unmark = hold(harness, "update")
    const abort = hold(harness, "abort")
    try {
      const promotion = controller.runOpen()
      await until(unmark.entered)
      controller.onPanelDismiss()
      expect(controller.canFollowUp()).toBe(false)
      unmark.resolve()
      await promotion
      expect(harness.navigations).toHaveLength(0)
      expect(
        markerOf(
          harness.calls
            .filter((call) => call.method === "session.update")
            .at(-1)?.params.metadata,
        ),
      ).toBeDefined()
      await controller.askFollowUp("unsafe replacement")
      expect(
        harness.calls.filter((call) => call.method === "session.promptAsync"),
      ).toHaveLength(2)
      abort.resolve()
      await until(() => controller.canFollowUp())
      await controller.runOpen()
      expect(harness.navigations).toEqual([
        ["session", { sessionID: "ses_fork" }],
      ])
    } finally {
      unmark.resolve()
      abort.resolve()
      await controller.dispose()
    }
  })

  test("a promotion rollback that loses its response after disposal cannot leave a kept fork marked", async () => {
    const { harness, options, controller } = await setup()
    options.keepSessions = true
    await controller.askFollowUp("accepted follow-up")
    const unmark = hold(harness, "update")
    const abort = hold(harness, "abort")
    const rollback = Promise.withResolvers<void>()
    const promotion = controller.runOpen()
    try {
      await until(unmark.entered)
      controller.onPanelDismiss()
      const update = harness.api.client.session.update
      let rollingBack = false
      harness.api.client.session.update = async (params) => {
        harness.api.client.session.update = update
        rollingBack = true
        await rollback.promise
        await update(params)
        throw new Error("rollback persisted but response lost")
      }
      unmark.resolve()
      await until(() => rollingBack)
      await controller.dispose()
      rollback.resolve()
      await promotion
      expect(
        harness.calls.filter((call) => call.method === "session.update").at(-1)
          ?.params.metadata,
      ).toEqual({})
      expect(harness.navigations).toHaveLength(0)
    } finally {
      unmark.resolve()
      rollback.resolve()
      abort.resolve()
      await promotion
      await controller.dispose()
    }
  })

  test("a hung compensating abort is bounded and does not unlock the fork", async () => {
    const { harness, options, controller } = await setup()
    const admission = hold(harness, "promptAsync")
    let cleanup: ReturnType<typeof hold> | undefined
    try {
      const pending = controller.askFollowUp("cancelled follow-up")
      await until(admission.entered)
      controller.onPanelDismiss()
      await pending
      options.timeoutMs = 30
      cleanup = hold(harness, "abort")
      admission.resolve()
      await until(() => cleanup?.signal()?.aborted === true)
      expect(controller.canFollowUp()).toBe(false)
      cleanup.resolve()
      await flush()
      expect(controller.canFollowUp()).toBe(false)
    } finally {
      admission.resolve()
      cleanup?.resolve()
      await controller.dispose()
    }
  })

  test("an acknowledged compensating abort cannot discharge an earlier timed-out abort", async () => {
    const { harness, options, controller } = await setup()
    const admission = hold(harness, "promptAsync")
    const delayedAbort = Promise.withResolvers<void>()
    const originalAbort = harness.api.client.session.abort
    let abortSignal: AbortSignal | undefined
    harness.api.client.session.abort = async (
      params,
      request?: { signal?: AbortSignal },
    ) => {
      harness.api.client.session.abort = originalAbort
      abortSignal = request?.signal
      // Delay execution, not just the response: this session-wide abort could
      // select replacement work after the compensating abort has succeeded.
      await delayedAbort.promise
      return originalAbort(params)
    }
    try {
      const pending = controller.askFollowUp("cancelled follow-up")
      await until(admission.entered)
      options.timeoutMs = 30
      controller.onPanelDismiss()
      await pending
      admission.resolve()
      await until(() => abortSignal?.aborted === true)
      await flush()
      expect(
        harness.calls.filter((call) => call.method === "session.abort"),
      ).toHaveLength(1) // Only the compensating abort has executed and returned.
      expect(controller.canFollowUp()).toBe(false)
      await controller.runOpen()
      expect(harness.navigations).toHaveLength(0)
      await controller.askFollowUp("unsafe replacement")
      expect(
        harness.calls.filter((call) => call.method === "session.promptAsync"),
      ).toHaveLength(2)

      delayedAbort.resolve()
      await flush()
      expect(
        harness.calls.filter((call) => call.method === "session.abort"),
      ).toHaveLength(2)
      expect(controller.canFollowUp()).toBe(false)
    } finally {
      admission.resolve()
      delayedAbort.resolve()
      await flush()
      await controller.dispose()
    }
  })

  for (const state of ["streaming", "promoted"] as const) {
    test(`a follow-up refused on a ${state} thread gives feedback`, async () => {
      const { harness, controller, panel } = await setup()
      try {
        if (state === "streaming")
          await controller.askFollowUp("still answering")
        else await controller.runOpen()
        const before = panel()
        const prompts = harness.calls.filter(
          (call) => call.method === "session.promptAsync",
        ).length
        await controller.askFollowUp("not available")
        expect(harness.toasts.at(-1)).toMatchObject({
          variant: "warning",
          message: `Follow-up not sent: the side thread is ${state === "streaming" ? "still answering" : "no longer available"}.`,
        })
        expect(panel()).toEqual(before)
        expect(
          harness.calls.filter((call) => call.method === "session.promptAsync"),
        ).toHaveLength(prompts)
      } finally {
        await controller.dispose()
      }
    })
  }

  for (const waitingOn of ["lookup", "backoff"] as const) {
    test(`cancellation stops admission confirmation during ${waitingOn}`, async () => {
      const { harness, controller } = await setup()
      timing.promptConfirmDelaysMs = [10_000]
      harness.rejectOnce("session.promptAsync", new Error("socket closed"))
      const lookup =
        waitingOn === "lookup" ? hold(harness, "message") : undefined
      try {
        const pending = controller.askFollowUp("unconfirmed follow-up")
        await until(() =>
          harness.calls.some((call) => call.method === "session.message"),
        )
        controller.onPanelDismiss()
        await pending
        await until(
          () =>
            harness.calls.filter((call) => call.method === "session.abort")
              .length === 2,
          { timeoutMs: 500 },
        )
        if (lookup) expect(lookup.signal()?.aborted).toBe(true)
        lookup?.resolve()
        await flush()
        expect(
          harness.calls.filter((call) => call.method === "session.message"),
        ).toHaveLength(1)
        expect(controller.canFollowUp()).toBe(false)
      } finally {
        lookup?.resolve()
        timing.promptConfirmDelaysMs = PROMPT_CONFIRM_DELAYS_MS
        await controller.dispose()
      }
    })
  }

  test("fast completion stops the admission wait without cancelling the answer", async () => {
    const { harness, controller, panel } = await setup()
    const admission = hold(harness, "promptAsync")
    try {
      const pending = controller.askFollowUp("fast follow-up")
      await until(admission.entered)
      harness.emit("message.updated", {
        sessionID: "ses_fork",
        info: {
          id: "msg_60",
          role: "assistant",
          parentID: latestPromptMessageID(harness),
        },
      })
      harness.emit("message.part.updated", {
        sessionID: "ses_fork",
        part: {
          id: "prt_2",
          type: "text",
          messageID: "msg_60",
          text: "fast answer",
        },
      })
      harness.emit("session.idle", { sessionID: "ses_fork" })
      await pending
      expect(admission.signal()?.aborted).toBe(true)
      expect(panel()?.exchanges.at(-1)).toMatchObject({
        answer: "fast answer",
        status: "done",
      })
      expect(controller.canFollowUp()).toBe(true)
      await controller.askFollowUp("next follow-up")
      const replacement = panel()
      admission.resolve()
      await flush()
      expect(
        harness.calls.some((call) => call.method === "session.abort"),
      ).toBe(false)
      expect(panel()).toEqual(replacement)
    } finally {
      admission.resolve()
      await controller.dispose()
    }
  })
})

describe("fork reuse during cancellation", () => {
  test.each([
    ["initial", "accepted", "dismissal-first"],
    ["initial", "persisted", "dismissal-first"],
    ["initial", "ambiguous", "dismissal-first"],
    ["follow-up", "accepted", "dismissal-first"],
    ["follow-up", "persisted", "dismissal-first"],
    ["follow-up", "ambiguous", "dismissal-first"],
    ["initial", "accepted", "cleanup-first"],
    ["follow-up", "accepted", "cleanup-first"],
  ] as const)(
    "a cancelled %s request (%s, %s) gates reuse through cleanup",
    async (kind, outcome, abortOrder) => {
      const answered =
        kind === "follow-up"
          ? await withStreamedAnswer("first answer")
          : undefined
      const harness =
        answered?.harness ??
        makeApi({ parentModel: { id: "m", providerID: "p" } })
      const layer = answered?.layer ?? (await load(harness))
      const releasePrompt = harness.holdOnce("session.promptAsync")
      const releaseDismissAbort = harness.holdOnce("session.abort")
      let releaseCleanupAbort = () => {}
      timing.promptConfirmDelaysMs = []
      try {
        if (outcome !== "accepted") {
          harness.persistPromptMessages(outcome === "persisted")
          harness.rejectOnce("session.promptAsync", new Error("socket closed"))
        }
        await command(layer, "btw.ask")()
        harness.prompt()?.onConfirm("cancel this question")
        await flush()
        const promptCount = kind === "initial" ? 1 : 2
        const prompts = () =>
          harness.calls.filter((call) => call.method === "session.promptAsync")
        const aborts = () =>
          harness.calls.filter((call) => call.method === "session.abort")
        expect(prompts()).toHaveLength(promptCount)

        const expectBlockedReuse = async () => {
          const previousPrompt = harness.prompt()
          await command(layer, "btw.ask")()
          if (kind === "initial") {
            expect(harness.prompt()).toBe(previousPrompt)
            expect(harness.toasts.at(-1)?.variant).toBe("info")
            expect(harness.toasts.at(-1)?.message).toContain("settling")
          } else {
            expect(harness.prompt()).not.toBe(previousPrompt)
            expect(harness.prompt()?.title).toBe("BTW")
            expect(harness.toasts.at(-1)?.variant).toBe("warning")
            expect(harness.toasts.at(-1)?.message).toContain("unconfirmed")
            expect(harness.toasts.at(-1)?.message).toContain(
              "will replace this thread",
            )
            harness.prompt()?.onCancel()
            await command(layer, "btw.reopen")()
          }
          expect(prompts()).toHaveLength(promptCount)
          expect(
            harness.calls.some((call) => call.method === "session.delete"),
          ).toBe(false)
          expect(
            harness.calls.filter((call) => call.method === "session.fork"),
          ).toHaveLength(1)
          await command(layer, "btw.open")()
          await flush()
          expect(harness.navigations).toHaveLength(0)
        }

        harness.escapeDialog()
        if (abortOrder === "dismissal-first") releaseDismissAbort()
        await flush()
        await command(layer, "btw.reopen")()
        // #245: this used to open a replacement on the same fork, letting the
        // delayed request's second abort kill it after its assistant started.
        await expectBlockedReuse()
        expect(aborts()).toHaveLength(1)

        releaseCleanupAbort = harness.holdOnce("session.abort")
        releasePrompt()
        await flush()
        expect(aborts()).toHaveLength(2)
        expect(
          aborts().every((call) => call.params.sessionID === "ses_fork"),
        ).toBe(true)
        await expectBlockedReuse()

        releaseCleanupAbort()
        await flush()
        if (abortOrder === "cleanup-first") {
          // The dismissal's abort can still reach the host after cleanup.
          // Both must settle before sharing the fork.
          await expectBlockedReuse()
        }

        releaseDismissAbort()
        await flush()
        if (kind === "follow-up" && outcome !== "accepted") {
          // Cancellation stops confirmation: even mock persistence is not an
          // observed admission when the held response later rejects.
          await expectBlockedReuse()
          expect(
            harness.calls.some((call) => call.method === "session.message"),
          ).toBe(false)
          expect(aborts()).toHaveLength(2)
          return
        }
        await command(layer, "btw.ask")()
        expect(harness.prompt()?.title).toBe("Ask a follow-up")
        harness.prompt()?.onConfirm("replacement question")
        await flush()
        expect(prompts()).toHaveLength(promptCount + 1)
        expect(prompts().at(-1)?.params.sessionID).toBe("ses_fork")
        harness.emit("message.updated", {
          sessionID: "ses_fork",
          info: {
            id: "msg_60",
            role: "assistant",
            parentID: latestPromptMessageID(harness),
          },
        })
        harness.emit("message.part.delta", {
          sessionID: "ses_fork",
          messageID: "msg_60",
          partID: "prt_replacement",
          field: "text",
          delta: "replacement answer",
        })
        harness.emit("session.idle", { sessionID: "ses_fork" })
        await flush()
        await command(layer, "btw.copy")()
        expect(harness.copied).toEqual(["replacement answer"])
        expect(aborts()).toHaveLength(2)
        expect(
          harness.calls.some((call) => call.method === "session.delete"),
        ).toBe(false)
        expect(
          harness.calls.filter((call) => call.method === "session.fork"),
        ).toHaveLength(1)
        await command(layer, "btw.open")()
        await flush()
        expect(harness.navigations).toEqual([
          ["session", { sessionID: "ses_fork" }],
        ])
      } finally {
        releasePrompt()
        releaseDismissAbort()
        releaseCleanupAbort()
        await flush()
        await harness.dispose()
        timing.promptConfirmDelaysMs = PROMPT_CONFIRM_DELAYS_MS
      }
    },
  )

  test("an initial streaming abort blocks a promotion already unmarking the fork", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("initial question")
    await flush()

    const releaseUnmark = harness.holdOnce("session.update")
    const releaseAbort = harness.holdOnce("session.abort")
    const before = harness.calls.length
    try {
      await command(layer, "btw.open")()
      await until(() =>
        harness.calls
          .slice(before)
          .some((call) => call.method === "session.update"),
      )
      harness.escapeDialog()
      await until(() =>
        harness.calls.some((call) => call.method === "session.abort"),
      )
      releaseUnmark()
      await flush()
      expect(harness.navigations).toHaveLength(0)
      expect(
        markerOf(
          harness.calls
            .filter((call) => call.method === "session.update")
            .at(-1)?.params.metadata,
        ),
      ).toBeDefined()

      await command(layer, "btw.reopen")()
      const previousPrompt = harness.prompt()
      await command(layer, "btw.ask")()
      expect(harness.prompt()).toBe(previousPrompt)
      expect(harness.toasts.at(-1)?.variant).toBe("info")
      expect(harness.toasts.at(-1)?.message).toContain("settling")
      await command(layer, "btw.open")()
      await flush()
      expect(harness.navigations).toHaveLength(0)
      expect(
        harness.calls.filter((call) => call.method === "session.promptAsync"),
      ).toHaveLength(1)

      releaseAbort()
      await flush()
      await command(layer, "btw.open")()
      await flush()
      expect(harness.navigations).toEqual([
        ["session", { sessionID: "ses_fork" }],
      ])
      expect(
        harness.calls.filter((call) => call.method === "session.abort"),
      ).toHaveLength(1)
    } finally {
      releaseUnmark()
      releaseAbort()
      await flush()
      await harness.dispose()
    }
  })
})

describe("streaming starts before promptAsync resolves", () => {
  test.each(["initial", "follow-up"] as const)(
    "a fast %s answer is not lost or aborted when admission settles",
    async (kind) => {
      const answered =
        kind === "follow-up"
          ? await withStreamedAnswer("first answer")
          : undefined
      const harness =
        answered?.harness ??
        makeApi({ parentModel: { id: "m", providerID: "p" } })
      harness.emitDuringPromptAsync((promptMessageID) => {
        harness.emit("message.updated", {
          sessionID: "ses_fork",
          info: {
            id: "msg_60",
            role: "assistant",
            parentID: promptMessageID,
          },
        })
        harness.emit("message.part.delta", {
          sessionID: "ses_fork",
          messageID: "msg_60",
          partID: "prt_fast",
          field: "text",
          delta: "fast answer",
        })
        harness.emit("session.idle", { sessionID: "ses_fork" })
      })
      const layer = answered?.layer ?? (await load(harness))
      await command(layer, "btw.ask")()
      harness.prompt()?.onConfirm("q")
      await flush()

      // The whole answer streamed (and went idle) before promptAsync resolved;
      // nothing was dropped and the exchange completed rather than timing out.
      await command(layer, "btw.copy")()
      expect(harness.copied).toEqual(["fast answer"])
      await command(layer, "btw.ask")()
      expect(harness.prompt()?.title).toBe("Ask a follow-up")
      expect(
        harness.calls.some((call) => call.method === "session.abort"),
      ).toBe(false)
    },
  )

  test("a fast completed follow-up accepts the next question before its SDK response settles", async () => {
    const { harness, layer } = await withStreamedAnswer("first answer")
    const releasePrompt = harness.holdOnce("session.promptAsync")
    const prompts = () =>
      harness.calls.filter((call) => call.method === "session.promptAsync")
    try {
      await command(layer, "btw.ask")()
      harness.prompt()?.onConfirm("fast follow-up")
      await until(() => prompts().length === 2)
      harness.emit("message.updated", {
        sessionID: "ses_fork",
        info: {
          id: "msg_60",
          role: "assistant",
          parentID: latestPromptMessageID(harness),
        },
      })
      harness.emit("message.part.delta", {
        sessionID: "ses_fork",
        messageID: "msg_60",
        partID: "prt_fast",
        field: "text",
        delta: "fast answer",
      })
      harness.emit("session.idle", { sessionID: "ses_fork" })
      await flush()
      await command(layer, "btw.copy")()
      expect(harness.copied).toEqual(["fast answer"])

      await command(layer, "btw.ask")()
      expect(harness.prompt()?.title).toBe("Ask a follow-up")
      harness.prompt()?.onConfirm("next follow-up")
      await until(() => prompts().length === 3)
      expect(prompts().at(-1)?.params.sessionID).toBe("ses_fork")
      harness.emit("message.updated", {
        sessionID: "ses_fork",
        info: {
          id: "msg_70",
          role: "assistant",
          parentID: latestPromptMessageID(harness),
        },
      })
      harness.emit("message.part.delta", {
        sessionID: "ses_fork",
        messageID: "msg_70",
        partID: "prt_next",
        field: "text",
        delta: "next answer",
      })

      releasePrompt()
      await flush()
      expect(
        harness.calls.some((call) => call.method === "session.abort"),
      ).toBe(false)
      harness.emit("session.idle", { sessionID: "ses_fork" })
      await command(layer, "btw.copy")()
      expect(harness.copied).toEqual(["fast answer", "next answer"])
      expect(
        harness.calls.some((call) => call.method === "session.delete"),
      ).toBe(false)
      expect(
        harness.calls.filter((call) => call.method === "session.fork"),
      ).toHaveLength(1)
      await command(layer, "btw.ask")()
      expect(harness.prompt()?.title).toBe("Ask a follow-up")
    } finally {
      releasePrompt()
      await flush()
      await harness.dispose()
    }
  })
})

describe("cleanup", () => {
  test("disposing deletes the fork by default", async () => {
    const { harness } = await withStreamedAnswer("answer")
    await harness.dispose()
    expect(
      harness.calls.some(
        (c) =>
          c.method === "session.delete" && c.params.sessionID === "ses_fork",
      ),
    ).toBe(true)
  })

  test("keepSessions clears the marker instead of deleting, so sweeps never reclaim it", async () => {
    const { harness } = await withStreamedAnswer("answer", {
      keepSessions: true,
    })
    await harness.dispose()
    expect(harness.calls.some((c) => c.method === "session.delete")).toBe(false)
    const update = harness.calls
      .filter(
        (c) =>
          c.method === "session.update" && c.params.sessionID === "ses_fork",
      )
      .at(-1)
    expect(update?.params.metadata).toEqual({})
    // The finished fork was idle: nothing to abort.
    expect(harness.calls.some((c) => c.method === "session.abort")).toBe(false)
  })

  test("keepSessions aborts a still-streaming fork before keeping it", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    const layer = await load(harness, { keepSessions: true })
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: "msg_50",
        role: "assistant",
        parentID: latestPromptMessageID(harness),
      },
    })

    await harness.dispose()

    // Kept (not deleted), but the generation is stopped — an unwatched fork
    // must not keep consuming tokens with nobody answering its permission asks.
    const abort = harness.calls.findIndex(
      (c) => c.method === "session.abort" && c.params.sessionID === "ses_fork",
    )
    const unmark = harness.calls.findIndex(
      (c) =>
        c.method === "session.update" &&
        c.params.sessionID === "ses_fork" &&
        JSON.stringify(c.params.metadata) === "{}",
    )
    expect(abort).toBeGreaterThanOrEqual(0)
    expect(unmark).toBeGreaterThan(abort) // abort while still marked, so the guard covers the tail
    expect(harness.calls.some((c) => c.method === "session.delete")).toBe(false)
  })

  test("the watchdog aborts a stalled fork instead of letting it run on", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    // Real timers: the no-abort-yet check below needs enough headroom that a
    // loaded runner pausing between confirm and check can't fire the watchdog
    // early (20ms flaked in CI).
    const layer = await load(harness, { timeoutMs: 250 })
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    expect(harness.calls.some((c) => c.method === "session.abort")).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(
      harness.calls.some(
        (c) =>
          c.method === "session.abort" && c.params.sessionID === "ses_fork",
      ),
    ).toBe(true)
    // Timed out, not deleted: the fork is still reopenable/cleaned up later.
    expect(harness.calls.some((c) => c.method === "session.delete")).toBe(false)
  })
})

describe("cancelling a start in flight", () => {
  test("escaping the panel before the fork is ready cancels the question", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    // The user hits Escape while the fork request is still in flight —
    // before onBeforePrompt has installed anything to abort.
    harness.during("session.fork", () => harness.escapeDialog())
    harness.prompt()?.onConfirm("q")
    await flush()

    // The model was never asked, the half-made fork was deleted, and no
    // ghost panel survives to be reopened.
    expect(harness.calls.some((c) => c.method === "session.promptAsync")).toBe(
      false,
    )
    expect(
      harness.calls.some(
        (c) =>
          c.method === "session.delete" && c.params.sessionID === "ses_fork",
      ),
    ).toBe(true)
    await command(layer, "btw.reopen")()
    expect(harness.toasts.at(-1)?.message).toContain("No recent side question")
  })

  test("a new question superseding a still-starting one leaks neither fork nor prompt", async () => {
    const harness = makeApi({
      parentModel: { id: "m", providerID: "p" },
      dynamicForks: true,
    })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    let interleaved = false
    // While the first start is being marked, the user opens a fresh ask box
    // (which dismisses the "Thinking…" panel) and asks something else.
    harness.during("session.update", () => {
      if (interleaved) return
      interleaved = true
      void command(layer, "btw.ask")()
      harness.prompt()?.onConfirm("second question")
    })
    harness.prompt()?.onConfirm("first question")
    await flush()

    // Only the second question was ever sent, and the superseded fork died.
    const prompts = harness.calls.filter(
      (c) => c.method === "session.promptAsync",
    )
    expect(prompts).toHaveLength(1)
    expect((prompts[0]!.params.parts as { text: string }[])[0]!.text).toContain(
      "second question",
    )
    const deletes = harness.calls
      .filter((c) => c.method === "session.delete")
      .map((c) => c.params.sessionID)
    expect(deletes).toEqual(["ses_fork_1"])
    expect(prompts[0]!.params.sessionID).toBe("ses_fork_2")
  })
})

describe("v2 error responses are not mistaken for success", () => {
  test("a failed promotion reports the error and leaves the side thread intact", async () => {
    const { harness, layer } = await withStreamedAnswer("answer")
    harness.failWith("session.update", { name: "NetworkError" })
    await command(layer, "btw.open")()
    await flush()

    // No success theater: no navigation, an error toast instead.
    expect(harness.navigations).toHaveLength(0)
    expect(harness.toasts.at(-1)?.variant).toBe("error")
    // Crucially NOT marked adopted — the marker survived, so teardown still
    // treats the fork as btw's to clean up (instead of leaving a session the
    // next sweep would delete out from under the user).
    await harness.dispose()
    expect(
      harness.calls.some(
        (c) =>
          c.method === "session.delete" && c.params.sessionID === "ses_fork",
      ),
    ).toBe(true)
  })

  test("keepSessions warns when the kept session could not shed its marker", async () => {
    const { harness } = await withStreamedAnswer("answer", {
      keepSessions: true,
    })
    harness.failWith("session.update", { name: "boom" })
    await harness.dispose()
    expect(harness.toasts.at(-1)?.variant).toBe("warning")
    expect(harness.toasts.at(-1)?.message).toContain("kept side session")
  })

  test("a follow-up whose session lookup fails becomes an error, not a mistargeted prompt", async () => {
    const { harness, layer } = await withStreamedAnswer("first answer")
    harness.failWith("session.get", { name: "gone" })
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("and then?")
    await flush()
    // Only the original question was ever prompted.
    expect(
      harness.calls.filter((c) => c.method === "session.promptAsync"),
    ).toHaveLength(1)
  })
})

describe("read-only guard", () => {
  test("auto-rejects permission prompts raised inside the active fork", async () => {
    const harness = makeApi()
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    harness.emit("permission.asked", {
      id: "per_1",
      sessionID: "ses_fork",
      permission: "edit",
    })
    expect(harness.replies).toEqual([
      { requestID: "per_1", reply: "reject", directory: "/repo" },
    ])
  })

  test("ignores permission prompts from other sessions", async () => {
    const harness = makeApi()
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    harness.emit("permission.asked", {
      id: "per_2",
      sessionID: "ses_other",
      permission: "edit",
    })
    expect(harness.replies).toHaveLength(0)
  })

  test("a foreign approval in the fork kills the side question", async () => {
    // Auto-reject races anything else answering the same prompt (another
    // permission plugin's stored rule, say). If an approval wins, the fork
    // must not keep running with write access — abort it on the spot.
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    harness.emit("permission.replied", {
      sessionID: "ses_fork",
      requestID: "per_1",
      reply: "always",
    })
    expect(
      harness.calls.some(
        (c) =>
          c.method === "session.abort" && c.params.sessionID === "ses_fork",
      ),
    ).toBe(true)
  })

  test("its own rejects (and other sessions' replies) abort nothing", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    harness.emit("permission.replied", {
      sessionID: "ses_fork",
      requestID: "per_1",
      reply: "reject",
    })
    harness.emit("permission.replied", {
      sessionID: "ses_other",
      requestID: "per_2",
      reply: "always",
    })
    expect(harness.calls.some((c) => c.method === "session.abort")).toBe(false)
  })
})

describe("lease & sweep", () => {
  const markerUpdates = (harness: ReturnType<typeof makeApi>) =>
    harness.calls.filter(
      (c) => c.method === "session.update" && markerOf(c.params.metadata),
    )

  test("startup sweeps stale marked forks but never foreign or partial metadata", async () => {
    const stale = markerFor({
      parent: "ses_p",
      tools: "read-only",
      created: 1,
      lease: 1,
    })
    const harness = makeApi({
      sessions: [
        { id: "ses_stale", metadata: stale },
        // The pre-namespace short key and a partial marker: arbitrary
        // metadata must never make a session deletable.
        {
          id: "ses_foreign",
          metadata: {
            btw: { parent: "ses_p", tools: "read-only", created: 1 },
          },
        },
        {
          id: "ses_partial",
          metadata: { "@macarons/btw": { parent: "ses_p" } },
        },
      ],
    })
    await load(harness)
    await flush()
    const deletes = harness.calls
      .filter((c) => c.method === "session.delete")
      .map((c) => c.params.sessionID)
    expect(deletes).toEqual(["ses_stale"])
  })

  test("a live fork's lease is heartbeat-refreshed so another instance's sweep spares it", async () => {
    timing.leaseIntervalMs = 10
    try {
      const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
      const layer = await load(harness)
      await command(layer, "btw.ask")()
      harness.prompt()?.onConfirm("q")
      await flush()
      const marked = markerUpdates(harness)
      expect(marked.length).toBeGreaterThanOrEqual(1) // the initial marking update

      await new Promise((resolve) => setTimeout(resolve, 60))
      const beats = markerUpdates(harness).slice(marked.length)
      expect(beats.length).toBeGreaterThanOrEqual(2)
      for (const beat of beats) expect(beat.params.sessionID).toBe("ses_fork")
      // Each beat rewrites the FULL marker with a fresher lease — the fork
      // stays recognizable (guards) and provably owned (sweeps).
      const first = markerOf(marked[0]!.params.metadata)
      const last = markerOf(beats.at(-1)?.params.metadata)
      expect(last).toMatchObject({
        parent: "ses_parent",
        tools: "read-only",
        created: first?.created,
      })
      expect(last?.lease ?? 0).toBeGreaterThan(
        first?.lease ?? Number.POSITIVE_INFINITY,
      )
    } finally {
      timing.leaseIntervalMs = LEASE_INTERVAL_MS
    }
  })

  test("releasing the fork stops the heartbeat", async () => {
    timing.leaseIntervalMs = 10
    try {
      const { harness } = await withStreamedAnswer("answer")
      await harness.dispose()
      await flush() // let any beat already in flight settle
      const settled = harness.calls.length
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(harness.calls.length).toBe(settled)
    } finally {
      timing.leaseIntervalMs = LEASE_INTERVAL_MS
    }
  })

  test("promotion pauses the heartbeat so a beat cannot re-mark the promoted session", async () => {
    timing.leaseIntervalMs = 10
    try {
      const { harness, layer } = await withStreamedAnswer("answer")
      await command(layer, "btw.open")()
      await flush()
      const unmark = harness.calls
        .filter((c) => c.method === "session.update")
        .at(-1)
      expect(unmark?.params.metadata).toEqual({})
      const settled = harness.calls.length
      await new Promise((resolve) => setTimeout(resolve, 50))
      // No beat re-marked the session after the promotion unmarked it.
      expect(
        harness.calls
          .slice(settled)
          .filter((c) => c.method === "session.update"),
      ).toHaveLength(0)
    } finally {
      timing.leaseIntervalMs = LEASE_INTERVAL_MS
    }
  })
})

// ---- WP5: mutation-proven coverage for previously covered-but-unasserted
// branches. Each test below fails against a specific surviving mutant.

describe("WP5: begin-question failure clears active", () => {
  // A genuine (non-cancel) start failure reaches beginQuestion's catch with
  // `active` still installed (onBeforePrompt ran before promptAsync). The catch
  // must null `active` (tui.tsx:525) so the still-open panel offers a FRESH
  // question, not a follow-up on a fork that already failed.
  test("a promptAsync failure nulls active so the ask key opens a fresh question", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    const layer = await load(harness)
    // Only a promptAsync failure reaches the catch with active non-null: fork
    // and update fail before onBeforePrompt installs `active`.
    harness.failWith("session.promptAsync", { name: "boom" })
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()

    await command(layer, "btw.ask")()
    // Baseline: active nulled → runAsk opens a fresh question. If active=null is
    // dropped, the exchange is merely un-streamed and runAsk offers a follow-up.
    expect(harness.prompt()?.title).toBe("BTW")
  })
})

describe("WP5: cancelled no-context start discards its orphaned fork", () => {
  // The no-context path returns from startSideQuestion WITHOUT onBeforePrompt,
  // so a cancel racing it leaves an un-owned fork. beginQuestion's `if
  // (!installed)` discard (tui.tsx:492-496) is the only thing that deletes it.
  test("escaping during the fork-mark of a no-context start still deletes the fork", async () => {
    const harness = makeApi({ messages: [] }) // empty parent history → no context
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    // session.update is the fork-marking call, before the no-context return.
    // Escaping here bumps the start generation (active null, startPending true).
    harness.during("session.update", () => harness.escapeDialog())
    harness.prompt()?.onConfirm("q")
    await flush()

    // The :492 branch deletes the orphaned fork.
    expect(
      harness.calls.some(
        (c) =>
          c.method === "session.delete" && c.params.sessionID === "ses_fork",
      ),
    ).toBe(true)
    // GUARDS: prove we took the :492 branch, not the already-covered :501
    // no-context discard (which also deletes but additionally toasts and never
    // runs here because we returned first).
    expect(
      harness.toasts.some((t) => t.message?.includes("no conversation yet")),
    ).toBe(false)
    expect(harness.calls.some((c) => c.method === "session.promptAsync")).toBe(
      false,
    )
  })
})

describe("WP5: copy guards", () => {
  // copying while the exchange is still "Thinking…" (answer === "") must report
  // nothing-to-copy and touch the clipboard 0 times.
  test("copying before any answer streamed copies nothing and says so", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush() // exchange exists, streaming, answer === "" — no parts emitted

    await command(layer, "btw.copy")()
    expect(harness.copied).toHaveLength(0)
    expect(harness.toasts.at(-1)?.message).toBe("Nothing to copy yet.")
  })

  // A terminal without OSC52 support: the copy call still records the text but
  // the toast must warn instead of claiming success.
  test("copy warns when the terminal cannot receive the clipboard write", async () => {
    const harness = makeApi({
      copySupported: false,
      parentModel: { id: "m", providerID: "p" },
    })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: "msg_50",
        role: "assistant",
        parentID: latestPromptMessageID(harness),
      },
    })
    harness.emit("message.part.updated", {
      sessionID: "ses_fork",
      part: {
        id: "prt_1",
        type: "text",
        messageID: "msg_50",
        text: "answer",
      },
    })
    harness.emit("session.idle", { sessionID: "ses_fork" })

    await command(layer, "btw.copy")()
    expect(harness.copied).toEqual(["answer"])
    expect(harness.toasts.at(-1)).toEqual({
      variant: "warning",
      message: "Clipboard not available in this terminal.",
    })
  })
})

describe("WP5: heartbeat undoes a re-mark that lands after release", () => {
  // A beat whose marker-update resolves AFTER ownership ended must best-effort
  // undo its own re-mark (tui.tsx:197-205), or a released fork stays marked and
  // a later sweep deletes it (silent data loss).
  test("a beat resolving after release writes an empty-metadata undo", async () => {
    timing.leaseIntervalMs = 10 // must be set before withStreamedAnswer
    try {
      const { harness } = await withStreamedAnswer("answer")
      let disposed = false
      // Dispose while the first post-answer beat's marker-update is in flight:
      // during() runs synchronously inside record(), releasing (active=null)
      // before the update resolves.
      harness.during("session.update", () => {
        if (disposed) return
        disposed = true
        void harness.dispose()
      })
      await new Promise((resolve) => setTimeout(resolve, 80))
      await flush()

      const emptyForkUpdates = harness.calls.filter(
        (c) =>
          c.method === "session.update" &&
          c.params.sessionID === "ses_fork" &&
          JSON.stringify(c.params.metadata) === "{}",
      )
      // Baseline: exactly one {} undo. Without the recheck+undo block the beat
      // leaves the marker in place and release() deletes (never {}-updates) →
      // zero empty-metadata updates.
      expect(emptyForkUpdates.length).toBeGreaterThanOrEqual(1)
    } finally {
      timing.leaseIntervalMs = LEASE_INTERVAL_MS
    }
  })
})

describe("WP5: periodic re-sweep", () => {
  // The startup sweep is followed by a periodic re-sweep (tui.tsx:1000),
  // cleared on dispose (tui.tsx:1003). No test drove sweepIntervalMs before.
  test("re-sweeps on an interval while mounted, then stops after dispose", async () => {
    timing.sweepIntervalMs = 10
    try {
      // No fork asked → session.list comes ONLY from the sweeper (heartbeats
      // use session.update), a clean signal.
      const harness = makeApi({ sessions: [{ id: "ses_a" }] })
      await load(harness)
      await new Promise((resolve) => setTimeout(resolve, 50))

      const listsWhileMounted = harness.calls.filter(
        (c) => c.method === "session.list",
      ).length
      // Baseline: startup(1) + several periodic. Mutant (no periodic every()):
      // exactly 1.
      expect(listsWhileMounted).toBeGreaterThan(1)

      await harness.dispose()
      const settled = harness.calls.filter(
        (c) => c.method === "session.list",
      ).length
      await new Promise((resolve) => setTimeout(resolve, 50))
      // Baseline: frozen (clearInterval ran). Mutant (no clearInterval): grows.
      expect(
        harness.calls.filter((c) => c.method === "session.list").length,
      ).toBe(settled)
    } finally {
      timing.sweepIntervalMs = 60_000
    }
  })
})

describe("WP5: streaming answer filters (observed via copy)", () => {
  // renderStreaming keeps only parts whose message is a registered assistant
  // message (tui.tsx:271). An un-registered text part (an echoed user question)
  // must not leak into the answer.
  test("a part with no assistant registration is excluded from the answer", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    // The real assistant answer.
    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: "msg_50",
        role: "assistant",
        parentID: latestPromptMessageID(harness),
      },
    })
    harness.emit("message.part.updated", {
      sessionID: "ses_fork",
      part: { id: "prt_1", type: "text", messageID: "msg_50", text: "REAL" },
    })
    // A text part above the boundary and watermark, but with NO assistant
    // registration for its message (msg_49) — must be filtered out.
    harness.emit("message.part.updated", {
      sessionID: "ses_fork",
      part: { id: "prt_0", type: "text", messageID: "msg_49", text: "ROGUE" },
    })
    // Copy WHILE streaming — renderStreaming only recomputes then.
    await command(layer, "btw.copy")()
    expect(harness.copied).toEqual(["REAL"])
  })

  // A follow-up advances the watermark (tui.tsx:544/270) so its answer excludes
  // the prior exchange's text. The existing follow-up tests never stream a
  // second answer, so this pins that boundary.
  test("a follow-up's answer excludes the prior exchange's text", async () => {
    const { harness, layer } = await withStreamedAnswer("first answer")
    await command(layer, "btw.ask")()
    expect(harness.prompt()?.title).toBe("Ask a follow-up")
    harness.prompt()?.onConfirm("q2")
    await flush()
    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: "msg_60",
        role: "assistant",
        parentID: latestPromptMessageID(harness),
      },
    })
    harness.emit("message.part.updated", {
      sessionID: "ses_fork",
      part: {
        id: "prt_2",
        type: "text",
        messageID: "msg_60",
        text: "second answer",
      },
    })
    harness.emit("session.idle", { sessionID: "ses_fork" })

    await command(layer, "btw.copy")()
    expect(harness.copied).toEqual(["second answer"])
  })

  test("a delayed prior reply cannot bleed into the current follow-up", async () => {
    const { harness, layer } = await withStreamedAnswer("first answer")
    const firstPromptID = latestPromptMessageID(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q2")
    await flush()
    const followUpPromptID = latestPromptMessageID(harness)

    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: "msg_60",
        role: "assistant",
        parentID: firstPromptID,
      },
    })
    harness.emit("message.part.updated", {
      sessionID: "ses_fork",
      part: {
        id: "prt_late",
        type: "text",
        messageID: "msg_60",
        text: "late first answer",
      },
    })
    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: "msg_61",
        role: "assistant",
        parentID: followUpPromptID,
      },
    })
    harness.emit("message.part.updated", {
      sessionID: "ses_fork",
      part: {
        id: "prt_current",
        type: "text",
        messageID: "msg_61",
        text: "current answer",
      },
    })

    await command(layer, "btw.copy")()
    expect(harness.copied).toEqual(["current answer"])
  })

  test("prior events arriving during follow-up preparation cannot cancel or fill it", async () => {
    const { harness, layer } = await withStreamedAnswer("first answer")
    const firstPromptID = latestPromptMessageID(harness)
    await command(layer, "btw.ask")()
    harness.during("session.get", () => {
      harness.emit("message.updated", {
        sessionID: "ses_fork",
        info: {
          id: "msg_60",
          role: "assistant",
          parentID: firstPromptID,
        },
      })
      harness.emit("message.part.updated", {
        sessionID: "ses_fork",
        part: {
          id: "prt_late",
          type: "text",
          messageID: "msg_60",
          text: "late first answer",
        },
      })
      harness.emit("session.idle", { sessionID: "ses_fork" })
    })
    harness.prompt()?.onConfirm("q2")
    await flush()

    const prompts = harness.calls.filter(
      (call) => call.method === "session.promptAsync",
    )
    expect(prompts).toHaveLength(2)
    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: "msg_61",
        role: "assistant",
        parentID: latestPromptMessageID(harness),
      },
    })
    harness.emit("message.part.updated", {
      sessionID: "ses_fork",
      part: {
        id: "prt_current",
        type: "text",
        messageID: "msg_61",
        text: "current answer",
      },
    })
    await command(layer, "btw.copy")()
    expect(harness.copied).toEqual(["current answer"])
  })

  test("a stale idle after follow-up dispatch waits for the current assistant", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q1")
    await flush()
    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: "msg_50",
        role: "assistant",
        parentID: latestPromptMessageID(harness),
      },
    })
    harness.emit("message.part.updated", {
      sessionID: "ses_fork",
      part: {
        id: "prt_first",
        type: "text",
        messageID: "msg_50",
        text: "partial first answer",
      },
    })
    harness.closeDialog()
    await flush() // The stale-event test starts after cancellation is acknowledged.
    await command(layer, "btw.reopen")()
    await command(layer, "btw.ask")()
    harness.emitDuringPromptAsync(() => {
      harness.emit("session.error", {
        sessionID: "ses_fork",
        error: { name: "PriorRunError" },
      })
      harness.emit("session.idle", { sessionID: "ses_fork" })
      harness.emit("session.idle", { sessionID: "ses_fork" })
    })
    harness.prompt()?.onConfirm("q2")
    await flush()

    expect(
      harness.calls.filter((call) => call.method === "session.promptAsync"),
    ).toHaveLength(2)
    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: "msg_61",
        role: "assistant",
        parentID: latestPromptMessageID(harness),
      },
    })
    harness.emit("message.part.updated", {
      sessionID: "ses_fork",
      part: {
        id: "prt_current",
        type: "text",
        messageID: "msg_61",
        text: "current answer",
      },
    })
    harness.emit("session.idle", { sessionID: "ses_fork" })
    await command(layer, "btw.copy")()
    expect(harness.copied).toEqual(["current answer"])
  })

  test("auto-compaction continuation users remain correlated to the exchange", async () => {
    const historyNow = Date.now() - 100
    const harness = makeApi({
      parentModel: { id: "m", providerID: "p" },
      forkMessages: [
        { info: { id: mintMessageID(historyNow, 1), role: "user" } },
        {
          info: {
            id: mintMessageID(historyNow, 2),
            role: "assistant",
            time: { completed: historyNow },
          },
        },
      ],
    })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    const now = Date.now() + 100
    const compactionUser = mintMessageID(now, 1)
    const compactionAssistant = mintMessageID(now, 2)
    const continueUser = mintMessageID(now, 3)
    const answerAssistant = mintMessageID(now, 4)
    expect(compactionUser > latestPromptMessageID(harness)).toBe(true)

    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: { id: compactionUser, role: "user" },
    })
    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: compactionAssistant,
        role: "assistant",
        parentID: compactionUser,
        summary: true,
      },
    })
    harness.emit("message.part.updated", {
      sessionID: "ses_fork",
      part: {
        id: "prt_summary",
        type: "text",
        messageID: compactionAssistant,
        text: "compaction summary",
      },
    })
    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: { id: continueUser, role: "user" },
    })
    harness.emit("message.updated", {
      sessionID: "ses_fork",
      info: {
        id: answerAssistant,
        role: "assistant",
        parentID: continueUser,
      },
    })
    harness.emit("message.part.updated", {
      sessionID: "ses_fork",
      part: {
        id: "prt_answer",
        type: "text",
        messageID: answerAssistant,
        text: "answer after compaction",
      },
    })

    await command(layer, "btw.copy")()
    expect(harness.copied).toEqual(["answer after compaction"])
  })
})

describe("WP5: session.error handler", () => {
  // An error for the active fork finalizes the streaming exchange
  // (tui.tsx:422-423): streaming flips off, active stays, so the ask key
  // continues the (failed) thread as a follow-up.
  test("a provider error for the active fork finalizes it out of streaming", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    harness.emit("session.error", {
      sessionID: "ses_fork",
      error: { name: "ProviderError" },
    })

    await command(layer, "btw.ask")()
    // Finalized → follow-up. If the handler is dropped / its streaming guard
    // inverted, the exchange stays streaming and runAsk opens a fresh question.
    expect(harness.prompt()?.title).toBe("Ask a follow-up")
  })

  // Routing (tui.tsx:416): an error for a FOREIGN session must not touch the
  // live side question.
  test("an error for a foreign session leaves the live question streaming", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    harness.emit("session.error", {
      sessionID: "ses_other",
      error: { name: "X" },
    })

    await command(layer, "btw.ask")()
    // Untouched → still streaming → fresh question. Dropping the routing check
    // would finalize it and flip this to a follow-up.
    expect(harness.prompt()?.title).toBe("BTW")
  })
})

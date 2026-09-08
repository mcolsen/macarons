import { describe, expect, test } from "bun:test"
import { flush } from "@macarons/plugin-test-harness"
import { createSlotMounter } from "@macarons/plugin-test-harness/view"
import { command, load, makeApi } from "./harness"

// WP5: no-view-render-test. btw's answer panel is the `render` callback it hands
// to api.ui.dialog.replace inside showPanel(); it registers no slot. The
// engine tests (tui.test.ts) run that render inside a swallowing try/catch, so
// every line of the render layer executes but asserts nothing. This file mounts
// the CAPTURED panel render (the thunk the shared harness's dialog stack keeps,
// exposed as harness.render()) under @opentui/solid's headless test renderer
// (the package bunfig preloads the real solid transform) and asserts on the
// char frame — the only surface that can kill the render-layer mutants (the
// error/answer Show swap, the follow-up-hint streaming guard, the Q-number
// guard, the "— stopped" marker, the streaming footer flag, and the "Thinking…"
// fallback).

const mountSlot = createSlotMounter({ width: 90, height: 28 })

/** Mount the captured panel render under the real headless renderer. */
async function mountPanel(harness: ReturnType<typeof makeApi>) {
  const render = harness.render()
  if (!render) throw new Error("no panel render captured")
  return mountSlot(() => render())
}

// Drive a fresh side question to a streaming exchange (no answer yet).
async function askStreaming(
  harness: ReturnType<typeof makeApi>,
  question = "q",
) {
  const layer = await load(harness)
  await command(layer, "btw.ask")()
  harness.prompt()?.onConfirm(question)
  await flush()
  return layer
}

// Stream a single assistant answer and go idle → a DONE exchange.
function streamAnswer(
  harness: ReturnType<typeof makeApi>,
  answer: string,
  messageID = "msg_50",
  partID = "prt_1",
) {
  const promptMessageID = harness.calls
    .filter((call) => call.method === "session.promptAsync")
    .at(-1)?.params.messageID
  harness.emit("message.updated", {
    sessionID: "ses_fork",
    info: { id: messageID, role: "assistant", parentID: promptMessageID },
  })
  harness.emit("message.part.updated", {
    sessionID: "ses_fork",
    part: { id: partID, type: "text", messageID, text: answer },
  })
}

describe("WP5: answer panel render", () => {
  // (f) The empty-streaming fallback (tui.tsx:774-777): before any token, the
  // body shows "Thinking…".
  test("a streaming exchange with no answer yet shows Thinking…", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    await askStreaming(harness)
    const frame = (await mountPanel(harness)).captureCharFrame()
    expect(frame).toContain("BTW · p/m")
    expect(frame).toContain("Thinking…")
  })

  // (b)/(c) The streaming footer (tui.tsx:732/802): while streaming, esc reads
  // "stop & close" and NO ask hint is advertised (runAsk refuses a
  // follow-up mid-stream).
  test("the streaming footer says stop & close and hides the ask hint", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    await askStreaming(harness)
    const frame = (await mountPanel(harness)).captureCharFrame()
    expect(frame).toContain("stop & close")
    expect(frame).not.toContain(" ask")
  })

  // (c) The done footer (tui.tsx:802 streaming flag; :732 hint guard): once the
  // answer is final, esc reads "close" (not "stop & close") and the ask
  // hint appears.
  test("the done footer says close and shows the ask hint", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    await askStreaming(harness)
    streamAnswer(harness, "the settled answer")
    harness.emit("session.idle", { sessionID: "ses_fork" })
    const frame = (await mountPanel(harness)).captureCharFrame()
    expect(frame).toContain(" ask")
    expect(frame).not.toContain("stop & close")
  })

  // (a) The error/answer Show (tui.tsx:779-786): an errored exchange renders its
  // error reason, not the markdown answer body.
  test("an errored exchange renders the error reason, not the answer body", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    await askStreaming(harness)
    harness.emit("session.error", {
      sessionID: "ses_fork",
      error: { name: "ProviderError" },
    })
    const frame = (await mountPanel(harness)).captureCharFrame()
    // Baseline: the error branch prints "The model reported an error
    // (ProviderError)." Swapping the Show would render the markdown answer
    // ("…") instead, dropping the reason.
    expect(frame).toContain("ProviderError")
  })

  // (e) The stopped marker (tui.tsx:793): a stopped exchange with a partial
  // answer shows the "— stopped" note under the body.
  test("a stopped exchange shows the — stopped marker", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    const layer = await askStreaming(harness)
    streamAnswer(harness, "partial so far")
    harness.closeDialog() // esc mid-stream → abort + finishStreaming("stopped")
    await command(layer, "btw.reopen")()
    const frame = (await mountPanel(harness)).captureCharFrame()
    expect(frame).toContain("— stopped")
  })

  // (d) The Q-number guard (tui.tsx:765): a single-exchange panel shows NO
  // "Q1." header; a multi-exchange panel numbers each.
  test("a single-exchange panel omits the Q-number header", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    await askStreaming(harness)
    streamAnswer(harness, "only answer")
    harness.emit("session.idle", { sessionID: "ses_fork" })
    const frame = (await mountPanel(harness)).captureCharFrame()
    expect(frame).not.toContain("Q1.")
  })

  // begin-question-failure-report-uncovered: a genuine (non-cancel) start
  // failure runs beginQuestion's catch, which finalizes the exchange via
  // finishStreaming("error", …) (tui.tsx:526-529). Removing that call leaves the
  // exchange at status="streaming" — a permanent "Thinking…". The tui.test.ts
  // assertion keys off `active` (nulled independently at :525) and cannot see
  // this; only the rendered panel distinguishes it.
  test("a failed start finalizes the exchange to an error, not a stuck Thinking…", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    // A genuine (non-cancel) start failure: promptAsync resolves { error },
    // driving beginQuestion into its catch.
    harness.failWith("session.promptAsync", { name: "boom" })
    const layer = await load(harness)
    await command(layer, "btw.ask")()
    harness.prompt()?.onConfirm("q")
    await flush()
    const frame = (await mountPanel(harness)).captureCharFrame()
    // Baseline: the exchange is finalized to error and renders the reason.
    // Under the mutant it is left streaming → "Thinking…".
    expect(frame).not.toContain("Thinking…")
    expect(frame).toContain("boom")
  })

  test("a multi-exchange panel numbers each question", async () => {
    const harness = makeApi({ parentModel: { id: "m", providerID: "p" } })
    const layer = await askStreaming(harness, "first q")
    streamAnswer(harness, "first answer")
    harness.emit("session.idle", { sessionID: "ses_fork" })

    // Follow-up in the same fork → a second exchange.
    await command(layer, "btw.ask")()
    expect(harness.prompt()?.title).toBe("Ask a follow-up")
    harness.prompt()?.onConfirm("second q")
    await flush()
    streamAnswer(harness, "second answer", "msg_60", "prt_2")
    harness.emit("session.idle", { sessionID: "ses_fork" })

    const frame = (await mountPanel(harness)).captureCharFrame()
    expect(frame).toContain("Q1.")
    expect(frame).toContain("Q2.")
  })
})

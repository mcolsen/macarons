import { expect, test } from "bun:test"
import { createBatchScheduler } from "../src/server/batch-scheduler"

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return
    await Bun.sleep(1)
  }
  throw new Error("timed out")
}
test("an ask arriving as a mode read settles gets a fresh read before its batch expands", async () => {
  const modeReads: ((mode: "parallel" | "serial") => void)[] = []
  const started: string[] = []
  const releases = new Map<string, () => void>()
  const scheduler = createBatchScheduler({
    handle: async (request) => {
      started.push(request.id)
      await new Promise<void>((resolve) => releases.set(request.id, resolve))
      return "approved"
    },
    headline: (request) => request.id,
    log: () => {},
    readProcessingMode: () => new Promise((resolve) => modeReads.push(resolve)),
    onJobFinished: () => {},
    onAncestryBlockedChange: () => {},
    maxQueued: 10,
  })
  const queue = (id: string) => {
    const request = {
      id,
      sessionID: "ses_1",
      permission: "bash",
      patterns: [id],
      toolCall: { messageID: "msg_1", callID: `call_${id}` },
    } as any
    const controller = new AbortController()
    expect(scheduler.beginAncestry(request, controller)).toBe(true)
    void scheduler.refreshProcessingMode()
    const resolution = scheduler.resolveAncestry(request, "ses_1", controller)
    if (resolution.state !== "queued")
      throw new Error(`unexpected scheduler state: ${resolution.state}`)
    return resolution.settled
  }

  const first = queue("per_1")
  await waitFor(() => modeReads.length === 1 && started.length === 1)
  let second: Promise<void> | undefined
  // Land the ask after the underlying read's async continuation, but before
  // a chained completion callback could clear the in-flight marker. This is
  // the narrow handoff where a stale parallel value used to fan out per_2.
  modeReads[0]!("parallel")
  queueMicrotask(() => {
    second = queue("per_2")
  })
  await waitFor(() => modeReads.length === 2)
  expect(started).toEqual(["per_1"])
  modeReads[1]!("serial")
  await Bun.sleep(0)
  expect(started).toEqual(["per_1"])

  releases.get("per_1")?.()
  await waitFor(() => started.length === 2)
  expect(started).toEqual(["per_1", "per_2"])
  releases.get("per_2")?.()
  await Promise.all([first, second!])
})

test("a queued next batch refreshes processing mode when the current batch drains", async () => {
  let mode: "parallel" | "serial" = "parallel"
  const started: string[] = []
  const releases = new Map<string, () => void>()
  const scheduler = createBatchScheduler({
    handle: async (request) => {
      started.push(request.id)
      await new Promise<void>((resolve) => releases.set(request.id, resolve))
      return "approved"
    },
    headline: (request) => request.id,
    log: () => {},
    readProcessingMode: async () => mode,
    onJobFinished: () => {},
    onAncestryBlockedChange: () => {},
    maxQueued: 10,
  })
  const queue = (id: string, messageID: string) => {
    const request = {
      id,
      sessionID: "ses_1",
      permission: "bash",
      patterns: [id],
      toolCall: { messageID, callID: `call_${id}` },
    } as any
    const controller = new AbortController()
    expect(scheduler.beginAncestry(request, controller)).toBe(true)
    void scheduler.refreshProcessingMode()
    const resolution = scheduler.resolveAncestry(request, "ses_1", controller)
    if (resolution.state !== "queued") throw new Error("request was not queued")
    return resolution.settled
  }

  const first = queue("per_1", "msg_1")
  await waitFor(() => started.length === 1)
  const second = queue("per_2", "msg_2")
  const third = queue("per_3", "msg_2")
  await Bun.sleep(0)
  mode = "serial"
  releases.get("per_1")?.()
  await waitFor(() => started.length === 2)
  expect(started).toEqual(["per_1", "per_2"])
  releases.get("per_2")?.()
  await waitFor(() => started.length === 3)
  releases.get("per_3")?.()
  await Promise.all([first, second, third])
})

import { afterEach, beforeEach, expect, test } from "bun:test"
import { flush, until } from "@macarons/plugin-test-harness"
import { createSlotMounter } from "@macarons/plugin-test-harness/view"
import { makeApi } from "./harness"

const mountSlot = createSlotMounter({ width: 60, height: 10 })
const cleanups: Array<() => void | Promise<void>> = []
const originalDataHome = process.env.XDG_DATA_HOME

beforeEach(() => {
  process.env.XDG_DATA_HOME = "/nonexistent/synthetic-limits-view"
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalDataHome
})

test("renders five-hour and weekly quotas with regeneration times", async () => {
  const requests: Request[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      requests.push(request)
      return Response.json({
        subscription: {
          limit: 100,
          requests: 0,
          renewsAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        rollingFiveHourLimit: {
          nextTickAt: new Date(Date.now() + 900_000).toISOString(),
          tickPercent: 0.05,
          remaining: 75,
          max: 100,
          limited: false,
        },
        weeklyTokenLimit: {
          nextRegenAt: new Date(Date.now() + 12_120_000).toISOString(),
          percentRemaining: 38,
          maxCredits: "$24.00",
          remainingCredits: "$9.12",
          nextRegenCredits: "$0.48",
        },
      })
    },
  })
  cleanups.push(() => server.stop(true))
  const harness = makeApi({
    sessionModelProviderID: "synthetic",
    effectiveKey: "synthetic-key",
  })
  await harness.load({
    providers: {
      synthetic: {
        endpoint: `http://127.0.0.1:${server.port}/v2/quotas`,
      },
    },
  })
  cleanups.push(harness.dispose)
  const view = await mountSlot(harness, { sessionID: "ses_1" })
  await until(() => requests.length >= 1)
  await flush()
  await view.renderOnce()
  const frame = view.captureCharFrame()
  expect(frame).toContain("Synthetic Limits")
  expect(frame).toContain("5h 75% left · regen 5%")
  expect(frame).toContain("7d 38% left · regen 2%")
})

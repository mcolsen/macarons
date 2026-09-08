import { expect, test } from "bun:test"
import { createHostReadCoalescer } from "../src/server/host"

test("fresh verification never joins an older coalesced host read", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reads = createHostReadCoalescer(() => {})
  const stale = reads.coalesce("config", async () => {
    await gate
    return "old"
  })

  await expect(reads.fresh("config", async () => "new")).resolves.toBe("new")
  release()
  await expect(stale).resolves.toBe("old")
})

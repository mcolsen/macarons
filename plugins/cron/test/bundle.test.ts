import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("builds the native V2 server entry", async () => {
  const outdir = await mkdtemp(join(tmpdir(), "macarons-cron-"))
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "../src/index.ts")],
      outdir,
      target: "bun",
      external: ["@opencode/plugin", "effect"],
    })
    expect(build.success).toBe(true)
    const output = await build.outputs[0]?.text()
    expect(output).toContain("macarons.cron")
    expect(output).not.toContain("@opencode-ai/")
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
})

import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"

const [file, gate] = process.argv.slice(2)
if (!file) throw new Error("Missing process-group PID file")
if (gate) {
  console.log(`publisher-ready:${process.pid}`)
  while (!(await Bun.file(gate).exists())) await Bun.sleep(10)
}

// Parentage can change if the keeper dies; the actual PGID remains attached to
// surviving members. Query this short-lived member rather than trusting $PPID.
const result = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
  encoding: "utf8",
})
const group = Number(result.stdout.trim())
if (result.status !== 0 || !Number.isSafeInteger(group) || group <= 1)
  throw new Error(
    `Could not determine the owned process group: ${result.stderr}`,
  )
writeFileSync(file, `${group}\n`)

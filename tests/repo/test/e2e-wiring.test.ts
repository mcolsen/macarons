import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const scripts = JSON.parse(
  readFileSync(path.join(root, "tests/e2e/package.json"), "utf8"),
).scripts as Record<string, string>
const workflow = Bun.YAML.parse(
  readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"),
) as {
  jobs: Record<
    string,
    {
      steps: Array<{ run?: string }>
      strategy?: { matrix?: { suite?: string[] } }
      [key: string]: unknown
    }
  >
}

function expanded(name: string, visited = new Set<string>()): string {
  if (visited.has(name)) throw new Error(`Cyclic E2E script: ${name}`)
  const seen = new Set(visited).add(name)
  return (scripts[name] ?? "").replace(
    /bun run (e2e[\w:-]*)/g,
    (_match, child: string) => expanded(child, seen),
  )
}

test("CI runs native server, installation and required TUI journeys", () => {
  expect(workflow.jobs["e2e-server"]?.strategy?.matrix?.suite).toEqual([
    "server",
    "install",
  ])
  for (const suite of ["server", "install"])
    expect(scripts[`e2e:${suite}`]).toContain(`v2/${suite}.e2e.test.ts`)
  const tui = workflow.jobs["e2e-tui-gating"]
  expect(tui).toBeDefined()
  expect(tui?.["continue-on-error"]).toBeUndefined()
  expect(tui?.steps.some(({ run }) => run?.includes("e2e:tui:gating"))).toBe(
    true,
  )
  expect(expanded("e2e:tui:gating")).toContain("v2/tui.e2e.test.ts")
})

test("every native v2 E2E file is reachable from a CI script", () => {
  const files = readdirSync(path.join(root, "tests/e2e/v2")).filter((file) =>
    file.endsWith(".e2e.test.ts"),
  )
  expect(files.length).toBeGreaterThanOrEqual(3)
  const invoked = [
    expanded("e2e:server"),
    expanded("e2e:install"),
    expanded("e2e:tui:gating"),
  ].join("\n")
  for (const file of files) expect(invoked).toContain(`v2/${file}`)
})

test("legacy v1 journeys remain reference material outside active scripts", () => {
  for (const [name, command] of Object.entries(scripts)) {
    if (!name.startsWith("e2e")) continue
    expect(command).not.toMatch(
      /(?:persist-permissions|background-tasks|subagent-comms|btw)\//,
    )
    for (const match of command.matchAll(
      /(?:[\w.-]+\/)+[\w.-]+\.e2e\.test\.ts/g,
    ))
      expect(match[0]).toStartWith("v2/")
  }
})

import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { runCli } from "../../../tools/installer/src/cli"
import { waitFor } from "../harness/wait"
import { fixture, pluginURL, prompt } from "./fixture"

test("installer migrates legacy Macarons declarations into plugins understood by v2", async () => {
  const marker = "MACARONS_INSTALL_MIGRATION"
  const host = await fixture({
    config: {
      plugin: [
        [
          `${pluginURL("scoped-system-prompts")}/src/index.ts`,
          {
            prompts: [
              { model: "fixture/model", mode: "append", content: marker },
            ],
          },
        ],
      ],
      plugins: [],
    },
  })
  const file = path.join(host.sandbox.config, "opencode.json")
  try {
    const original = JSON.parse(await fs.readFile(file, "utf8"))
    original.plugin.push("@macarons/background-tasks")
    await fs.writeFile(
      file,
      `// installation fixture\n${JSON.stringify(original, null, 2)}\n`,
    )
    const output: string[] = []
    await runCli({
      argv: ["--config-dir", host.sandbox.config],
      env: host.env,
      homedir: host.sandbox.home,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      wizard: async () => new Map([["@macarons/scoped-system-prompts", true]]),
      createPrompter: () => ({ ask: async () => "yes", close() {} }),
      log: (message) => output.push(message),
      error: (message) => {
        throw new Error(message)
      },
    })
    const text = await fs.readFile(file, "utf8")
    expect(text).toContain("// installation fixture")
    expect(text).not.toContain("background-tasks")
    expect(text).not.toContain("/src/index.ts")
    expect(output.join("\n")).toContain("background-tasks")
    await waitFor(
      async () =>
        (
          await host.client.plugin.list({
            location: { directory: host.sandbox.project },
          })
        ).data.some(
          (plugin) =>
            plugin.id?.includes("scoped-system-prompts") &&
            plugin.state.status === "active",
        ),
      { description: "native migrated server plugin", timeout: 30000 },
    )
    await prompt(host, "Verify the migration")
    expect(
      host.provider.requests.some((request) =>
        JSON.stringify(request.messages).includes(marker),
      ),
    ).toBe(true)
  } catch (error) {
    await host.process.writeDiagnostics(host.sandbox.artifacts)
    await host.sandbox.preserve("v2-install")
    throw error
  } finally {
    await host.dispose()
  }
})

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { registerResource } from "../harness/registry"
import { createSandbox } from "../harness/sandbox"
import { waitFor } from "../harness/wait"

const revision = "65cf14df16c191f3e9684f0d9a8bae69103ced6d"
const source = process.env.OPENCODE_E2E_SOURCE
type Event = {
  type: string
  directory: string
  time: number
  groupPid?: number
  descendantPid?: number
  hostPid?: number
  elapsedMs?: number
}

function events(journal: string): Event[] {
  let text = ""
  try {
    text = readFileSync(journal, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return text
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line))
}

function kill(pid: number) {
  if (!Number.isSafeInteger(pid) || Math.abs(pid) <= 1)
    throw new Error(`Refusing unsafe cleanup PID: ${pid}`)
  try {
    process.kill(pid, "SIGKILL")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

function recordedPid(directory: string, file: string) {
  try {
    const pid = Number(readFileSync(path.join(directory, file), "utf8").trim())
    return Number.isSafeInteger(pid) && pid > 1 ? [pid] : []
  } catch {
    return []
  }
}

async function executing(groups: number[]) {
  const members = await Promise.all(
    (await fs.readdir("/proc"))
      .filter((pid) => /^\d+$/.test(pid))
      .map(async (pid) => {
        const stat = await fs
          .readFile(`/proc/${pid}/stat`, "utf8")
          .catch(() => "")
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
        return groups.includes(Number(fields[2])) && fields[0] !== "Z"
          ? Number(pid)
          : undefined
      }),
  )
  return members.filter((pid) => pid !== undefined)
}

for (const gated of [false, true]) {
  test(`real TUI exit drains two resistant instances${gated ? " behind earlier plugin hooks" : ""}`, async () => {
    if (process.platform !== "linux")
      throw new Error("This /proc-supervised regression requires Linux")
    if (!source)
      throw new Error(
        "Set OPENCODE_E2E_SOURCE to the pinned source checkout; see background-tasks/SHUTDOWN.md",
      )
    const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: source })
    expect(sha.exitCode).toBe(0)
    expect(sha.stdout.toString().trim()).toBe(revision)
    const unchanged = Bun.spawnSync(
      [
        "git",
        "diff",
        "--exit-code",
        "HEAD",
        "--",
        "packages/opencode/src/cli/cmd/tui.ts",
        "packages/opencode/src/cli/tui/worker.ts",
        "packages/opencode/src/util/timeout.ts",
        "bun.lock",
      ],
      { cwd: source },
    )
    expect(
      unchanged.exitCode,
      "The real shutdown caller, worker, timeout, and dependency pin must remain unchanged",
    ).toBe(0)
    expect(
      (
        await Bun.file(
          new URL("../../../.opencode-version", import.meta.url),
        ).text()
      ).trim(),
    ).toBe("1.18.14")

    const sandbox = await createSandbox(`background-shutdown-${gated}`, {
      git: false,
    })
    const peer = path.join(sandbox.root, "peer")
    const directories = [sandbox.project, peer]
    const journal = path.join(sandbox.artifacts, "shutdown.jsonl")
    let proc: ReturnType<typeof Bun.spawn> | undefined
    let output = ""
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let unregister = () => {}
    let failed = false
    const groups = () => [
      ...new Set([
        ...directories.flatMap((directory) =>
          recordedPid(directory, "group.pid"),
        ),
        ...events(journal).flatMap((event) =>
          event.groupPid &&
          Number.isSafeInteger(event.groupPid) &&
          event.groupPid > 1
            ? [event.groupPid]
            : [],
        ),
      ]),
    ]
    const cleanup = () => {
      if (proc?.exitCode === null) proc.kill("SIGKILL")
      for (const pid of groups()) kill(-pid)
    }

    try {
      await fs.mkdir(peer)
      await fs.writeFile(journal, "")
      for (const directory of directories) {
        await fs.writeFile(path.join(directory, "group.pid"), "")
        await fs.writeFile(path.join(directory, "descendant.pid"), "")
      }
      // Satisfy the host's config dependency check locally, without npm/provider
      // traffic. Its only injected dependency resolves to this exact source tree.
      await fs.mkdir(
        path.join(sandbox.config, "node_modules", "@opencode-ai"),
        { recursive: true },
      )
      await fs.symlink(
        path.join(source, "packages/plugin"),
        path.join(sandbox.config, "node_modules/@opencode-ai/plugin"),
      )
      const dependencies = { "@opencode-ai/plugin": "1.18.14" }
      await fs.writeFile(
        path.join(sandbox.config, "package.json"),
        JSON.stringify({ dependencies }),
      )
      await fs.writeFile(
        path.join(sandbox.config, "package-lock.json"),
        JSON.stringify({ packages: { "": { dependencies } } }),
      )
      const env = await sandbox.environment("shutdown", {
        OPENCODE_TEST_HOME: sandbox.home,
        OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(sandbox.root, "managed"),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DB: ":memory:",
        OPENCODE_E2E_SHUTDOWN_JOURNAL: journal,
        OPENCODE_E2E_SHUTDOWN_PEER: peer,
        OPENCODE_E2E_SHUTDOWN_GATE: gated ? "1" : "0",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          // A selected inert model avoids the first-run /connect dialog.
          // No prompt is submitted; any accidental call hits closed loopback.
          enabled_providers: ["shutdown"],
          model: "shutdown/fixture",
          provider: {
            shutdown: {
              npm: "@ai-sdk/openai-compatible",
              name: "Shutdown fixture",
              options: { baseURL: "http://127.0.0.1:1" },
              models: { fixture: { name: "Shutdown fixture" } },
            },
          },
          plugin: [
            pathToFileURL(
              path.join(import.meta.dir, "fixtures/shutdown-plugin.ts"),
            ).href,
          ],
          mcp: {},
          lsp: false,
          formatter: false,
          snapshot: false,
          share: "disabled",
          autoupdate: false,
        }),
        TERM: "xterm-256color",
      })
      proc = Bun.spawn(
        [
          process.execPath,
          "--conditions=browser",
          "--no-install",
          "--no-env-file",
          path.join(source, "packages/opencode/src/index.ts"),
          sandbox.project,
        ],
        {
          cwd: path.join(source, "packages/opencode"),
          env,
          terminal: {
            cols: 160,
            rows: 45,
            data(_terminal, data) {
              output += Buffer.from(data).toString()
            },
          },
        },
      )
      unregister = registerResource({
        kind: "opencode",
        home: sandbox.home,
        killSync: cleanup,
      })
      await waitFor(
        () => {
          if (
            proc?.exitCode !== null ||
            events(journal).some((event) => event.type === "error")
          )
            throw new Error(
              `Host startup failed.\n${readFileSync(journal, "utf8")}\n${output}`,
            )
          return (
            events(journal).filter((event) => event.type === "ready").length ===
              2 && output.includes("Ask anything")
          )
        },
        {
          timeout: 60_000,
          description: "two real cached instances and TUI prompt",
        },
      )
      const ready = events(journal).filter((event) => event.type === "ready")
      expect(new Set(ready.map((event) => event.directory)).size).toBe(2)
      expect(ready.every((event) => event.hostPid === proc?.pid)).toBe(true)
      expect(groups()).toHaveLength(2)
      expect((await executing(groups())).length).toBeGreaterThanOrEqual(4)

      // Normal /exit reaches the unmodified tui.ts stop() closure, its actual
      // shutdown RPC, five-second timeout, and explicit worker.terminate().
      proc.terminal?.write("/exit")
      await waitFor(() => Bun.stripANSI(output).includes("/exit"), {
        timeout: 5_000,
        description: "exit command rendered",
      })
      watchdog = setTimeout(() => proc?.kill("SIGKILL"), 10_000)
      proc.terminal?.write("\r")
      const code = await proc.exited
      const exitedAt = Date.now()
      clearTimeout(watchdog)
      const observed = events(journal)
      await fs.writeFile(path.join(sandbox.artifacts, "tui.txt"), output)
      console.log(
        JSON.stringify({
          revision,
          gated,
          code,
          exitedAt,
          events: observed,
          surviving: await executing(groups()),
        }),
      )
      expect(code).toBe(0)
      const started = observed.filter((event) => event.type === "disposing")
      const disposed = observed.filter((event) => event.type === "disposed")
      expect(started).toHaveLength(2)
      expect(disposed).toHaveLength(2)
      expect(
        exitedAt - Math.min(...started.map((event) => event.time)),
      ).toBeLessThan(5_000)
      expect(
        Math.max(...started.map((event) => event.time)) -
          Math.min(...started.map((event) => event.time)),
      ).toBeLessThan(1_000)
      expect(
        disposed.every(
          (event) =>
            (event.elapsedMs ?? 0) >= 2_900 &&
            (event.elapsedMs ?? Infinity) < 4_500,
        ),
      ).toBe(true)
      // Assert before any supervisor signals. Zombies are already stopped and
      // may await reaping by init; inspect every member of the original groups.
      expect(await executing(groups())).toEqual([])
    } catch (error) {
      failed = true
      throw error
    } finally {
      clearTimeout(watchdog)
      try {
        if (proc?.exitCode === null) proc.kill("SIGKILL")
        await proc?.exited
        cleanup()
        await waitFor(async () => (await executing(groups())).length === 0, {
          timeout: 2_000,
          description: "unconditional outer process-group cleanup",
        })
      } finally {
        proc?.terminal?.close()
        unregister()
        if (failed) {
          await fs.writeFile(
            path.join(sandbox.artifacts, "tui.txt"),
            Bun.stripANSI(output).replaceAll(/ {2,}/g, "\n"),
          )
          console.error(
            `Shutdown diagnostics: ${await sandbox.preserve("background-shutdown")}`,
          )
        }
        await sandbox.cleanup()
      }
    }
  }, 90_000)
}

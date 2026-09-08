import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { type ProcessGroup, spawnProcessGroup } from "../src/process-group"

const execFileAsync = promisify(execFile)
const groups: ProcessGroup[] = []
const directories: string[] = []

function start(command: string, env?: NodeJS.ProcessEnv) {
  const group = spawnProcessGroup(command, { cwd: os.tmpdir(), env })
  groups.push(group)
  let stdout = ""
  let stderr = ""
  group.stdout?.on("data", (chunk) => (stdout += chunk.toString()))
  group.stderr?.on("data", (chunk) => (stderr += chunk.toString()))
  return { group, stdout: () => stdout, stderr: () => stderr }
}

async function temp() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "process-group-test-"),
  )
  directories.push(directory)
  return directory
}

async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met")
    await Bun.sleep(10)
  }
}

async function running(pid: number) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
    return !["Z", "X", "x"].includes(stat.slice(stat.lastIndexOf(")") + 2)[0]!)
  } catch (error) {
    if (
      ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return false
    throw error
  }
}

afterEach(async () => {
  for (const group of groups.splice(0)) {
    await group.signal("SIGKILL")
    group.release()
  }
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true })
})

describe.skipIf(process.platform === "win32")(
  "POSIX process-group keeper",
  () => {
    test("shutdown fixture records the actual PGID after keeper loss before publication", async () => {
      const directory = await temp()
      const marker = path.join(directory, "group.pid")
      const gate = path.join(directory, "publish")
      const command = [
        process.execPath,
        path.join(import.meta.dir, "fixtures/record-process-group.ts"),
        marker,
        gate,
      ]
        .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
        .join(" ")
      const { group, stdout } = start(command)
      const pid = group.pid
      let publisher: number | undefined
      try {
        expect(pid).toBeGreaterThan(1)
        await until(() => /publisher-ready:[0-9]+/.test(stdout()))
        publisher = Number(stdout().match(/publisher-ready:([0-9]+)/)?.[1])
        const exited = new Promise<void>((resolve) =>
          group.child.once("exit", () => resolve()),
        )
        // Kill only the keeper, not its group, before allowing PID publication.
        group.child.kill("SIGKILL")
        await exited
        await fs.writeFile(gate, "")
        await until(async () => Bun.file(marker).exists())
        expect(Number(await fs.readFile(marker, "utf8"))).toBe(pid!)
      } finally {
        if (pid && Number.isSafeInteger(pid) && pid > 1) {
          try {
            process.kill(-pid, "SIGKILL")
          } catch (error) {
            expect((error as NodeJS.ErrnoException).code).toBe("ESRCH")
          }
        }
        if (publisher && process.platform === "linux")
          await until(async () => !(await running(publisher!)))
      }
    }, 10_000)

    test("reports actual command output and completion while retaining its keeper", async () => {
      const { group, stdout, stderr } = start(
        "printf output; printf error >&2; exit 7",
      )
      await group.spawned
      expect(await group.closed).toEqual({ code: 7, signal: null })
      expect(stdout()).toBe("output")
      expect(stderr()).toBe("error")
      expect(group.child.exitCode).toBeNull()
      expect(await group.signal("SIGTERM")).toBe("signalled")
      expect(await group.signal("SIGKILL")).toBe("signalled")
      expect(await group.groupClosed).toBe("complete")
      expect(await group.signal("SIGKILL")).toBe("absent")
      expect(await group.closed).toEqual({ code: 7, signal: null })
    })

    test("does not make the actual command inherit ignored TERM", async () => {
      const { group, stdout } = start("printf ready; exec sleep 30")
      await group.spawned
      await until(() => stdout() === "ready")
      expect(await group.signal("SIGTERM")).toBe("signalled")
      expect(await group.closed).toEqual({ code: null, signal: "SIGTERM" })
      expect(group.child.exitCode).toBeNull()
    })

    test("waits for descendant-held output after the actual command exits", async () => {
      const { group, stdout } = start(
        "(sleep 0.15; printf descendant) & exit 9",
      )
      await group.spawned
      let closed = false
      void group.closed.then(() => (closed = true))
      await Bun.sleep(40)
      expect(closed).toBe(false)
      expect(await group.closed).toEqual({ code: 9, signal: null })
      expect(stdout()).toBe("descendant")
    })

    test("synthesizes command KILL completion when the keeper cannot report it", async () => {
      const { group, stdout } = start("printf ready; exec sleep 30")
      await group.spawned
      await until(() => stdout() === "ready")
      expect(await group.signal("SIGKILL")).toBe("signalled")
      expect(await group.closed).toEqual({ code: null, signal: "SIGKILL" })
      expect(await group.groupClosed).toBe("complete")
    })

    test.skipIf(process.platform !== "linux")(
      "cleans redirected descendants after leader and stdio close",
      async () => {
        const directory = await temp()
        const marker = path.join(directory, "worker")
        const { group } = start(
          `sh -c 'trap "" TERM; echo $$ > "${marker}"; exec sleep 30' >/dev/null 2>&1 & exit 0`,
        )
        await group.spawned
        expect(await group.closed).toEqual({ code: 0, signal: null })
        await until(async () =>
          fs.stat(marker).then(
            () => true,
            () => false,
          ),
        )
        const worker = Number(await fs.readFile(marker, "utf8"))
        expect(await running(worker)).toBe(true)
        const stat = await fs.readFile(`/proc/${worker}/stat`, "utf8")
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
        expect(Number(fields[2])).toBe(group.pid!)
        expect(Number(fields[3])).toBe(group.pid!)
        expect(await group.signal("SIGTERM")).toBe("signalled")
        await Bun.sleep(50)
        expect(await running(worker)).toBe(true)
        expect(await group.signal("SIGKILL")).toBe("signalled")
        await until(async () => !(await running(worker)))
      },
    )

    test("unexpected keeper loss never falls back to numeric signalling", async () => {
      const { group } = start("exit 0")
      await group.spawned
      await group.closed
      group.child.kill("SIGKILL")
      expect(await group.groupClosed).toBe("unverified")
      const kill = spyOn(process, "kill").mockImplementation(() => {
        throw new Error("must not signal any numeric PID or PGID")
      })
      try {
        expect(await group.signal("SIGTERM")).toBe("unconfirmed")
        expect(await group.signal("SIGKILL")).toBe("unconfirmed")
        expect(kill).not.toHaveBeenCalled()
        expect(await group.closed).toEqual({ code: 0, signal: null })
      } finally {
        kill.mockRestore()
      }
    })

    test("unknown keeper loss waits for trailing command output before rejecting completion", async () => {
      const directory = await temp()
      const gate = path.join(directory, "finish")
      const { group, stdout, stderr } = start(
        `printf ready; while [ ! -f "${gate}" ]; do sleep 0.01; done; printf trailing; printf final-error >&2; exit 7`,
      )
      await group.spawned
      let settled = false
      let finalOutput: string[] | undefined
      void group.closed.then(
        () => {
          settled = true
        },
        () => {
          settled = true
          finalOutput = [stdout(), stderr()]
        },
      )
      try {
        await until(() => stdout() === "ready")
        group.child.kill("SIGKILL")
        expect(await group.groupClosed).toBe("unverified")
        expect(await group.signal("SIGTERM")).toBe("unconfirmed")
        await Bun.sleep(20)
        expect(settled).toBe(false)
        await fs.writeFile(gate, "")
        await expect(group.closed).rejects.toThrow("keeper was lost")
        expect(finalOutput).toEqual(["readytrailing", "final-error"])
      } finally {
        await fs.writeFile(gate, "")
        await until(() => group.stdout!.closed && group.stderr!.closed)
      }
    })

    test.skipIf(process.platform !== "linux")(
      "cleans a new descendant after all original workload members exit",
      async () => {
        const directory = await temp()
        const gate = path.join(directory, "turnover")
        const firstMarker = path.join(directory, "first.pid")
        const secondMarker = path.join(directory, "second.pid")
        const firstScript = path.join(directory, "first.sh")
        const secondScript = path.join(directory, "second.sh")
        await fs.writeFile(
          secondScript,
          `trap '' TERM; printf '%s' "$$" > "${secondMarker}"; exec sleep 30`,
        )
        await fs.writeFile(
          firstScript,
          `printf '%s' "$$" > "${firstMarker}"; while [ ! -f "${gate}" ]; do sleep 0.01; done; /bin/sh "${secondScript}" >/dev/null 2>&1 &`,
        )
        const { group } = start(
          `/bin/sh "${firstScript}" >/dev/null 2>&1 & exit 0`,
        )
        await group.spawned
        expect(await group.closed).toEqual({ code: 0, signal: null })
        let first = 0
        let second = 0
        await until(async () => {
          first = Number(await fs.readFile(firstMarker, "utf8").catch(() => ""))
          return first > 0
        })
        expect(await running(first)).toBe(true)
        await fs.writeFile(gate, "")
        await until(async () => {
          second = Number(
            await fs.readFile(secondMarker, "utf8").catch(() => ""),
          )
          return second > 0 && !(await running(first))
        })
        expect(await running(second)).toBe(true)
        expect(await group.signal("SIGTERM")).toBe("signalled")
        expect(await running(second)).toBe(true)
        expect(await group.signal("SIGKILL")).toBe("signalled")
        await until(async () => !(await running(second)))
        expect(await group.closed).toEqual({ code: 0, signal: null })
      },
    )

    test("failed keeper startup rejects without an unhandled child error", async () => {
      const group = spawnProcessGroup("exit 0", {
        cwd: "/nonexistent-process-group-test",
      })
      groups.push(group)
      await expect(group.spawned).rejects.toThrow()
      await expect(group.closed).rejects.toThrow()
      expect(await group.groupClosed).toBe("unverified")
    })

    test("a stalled startup times out and retires the keeper without output consumers", async () => {
      const originalTimeout = globalThis.setTimeout
      const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
        handler: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        originalTimeout(
          handler,
          delay === 5_000 ? 50 : delay,
          ...args,
        )) as typeof setTimeout)
      let send: ReturnType<typeof spyOn> | undefined
      try {
        const group = spawnProcessGroup("printf never-started", {
          cwd: os.tmpdir(),
        })
        groups.push(group)
        send = spyOn(group.child, "send").mockImplementation(() => true)
        const exited = new Promise((resolve) =>
          group.child.once("exit", resolve),
        )
        await expect(group.spawned).rejects.toThrow(
          "did not confirm startup within 5000 ms",
        )
        await expect(group.closed).rejects.toThrow(
          "did not confirm startup within 5000 ms",
        )
        expect(await group.groupClosed).toBe("unverified")
        expect(group.child.connected).toBe(false)
        expect(await group.signal("SIGKILL")).toBe("unconfirmed")
        await exited
        expect(group.child.signalCode).toBe("SIGKILL")
      } finally {
        send?.mockRestore()
        timeout.mockRestore()
      }
    })

    test("buffers fast command output until consumers attach after startup", async () => {
      const group = spawnProcessGroup(
        "printf buffered; printf error >&2; exit 2",
        { cwd: os.tmpdir() },
      )
      groups.push(group)
      await group.spawned
      await Bun.sleep(40)
      let stdout = ""
      let stderr = ""
      group.stdout?.on("data", (chunk) => (stdout += chunk))
      group.stderr?.on("data", (chunk) => (stderr += chunk))
      expect(await group.closed).toEqual({ code: 2, signal: null })
      expect(stdout).toBe("buffered")
      expect(stderr).toBe("error")
    })

    test("stalled IPC settles boundedly and permits a later cleanup request", async () => {
      const { group } = start("exit 0")
      await group.spawned
      await group.closed
      const send = spyOn(group.child, "send").mockImplementation(() => true)
      try {
        const before = Date.now()
        expect(await group.signal("SIGTERM")).toBe("unconfirmed")
        expect(Date.now() - before).toBeGreaterThanOrEqual(900)
        expect(Date.now() - before).toBeLessThan(2_000)
      } finally {
        send.mockRestore()
      }
      expect(await group.signal("SIGKILL")).toBe("signalled")
      expect(await group.groupClosed).toBe("complete")
    })

    test("keeps acknowledged KILL evidence when exit delivery outlasts the request timeout", async () => {
      const { group } = start("exit 0")
      await group.spawned
      await group.closed
      const originalEmit = group.child.emit.bind(group.child)
      let deliverExit: (() => boolean) | undefined
      const emit = spyOn(group.child, "emit").mockImplementation(
        (event: string | symbol, ...args: unknown[]) => {
          if (event === "exit") {
            deliverExit = () => originalEmit(event, ...args)
            return true
          }
          return originalEmit(event, ...args)
        },
      )
      try {
        expect(await group.signal("SIGKILL")).toBe("unconfirmed")
        expect(deliverExit).toBeDefined()
        deliverExit!()
        deliverExit = undefined
        expect(await group.groupClosed).toBe("complete")
        expect(await group.signal("SIGKILL")).toBe("absent")
      } finally {
        emit.mockRestore()
        deliverExit?.()
      }
    })

    test("release retires the capability and self-cleans the keeper", async () => {
      const { group } = start("exit 0")
      await group.spawned
      await group.closed
      const exited = new Promise((resolve) => group.child.once("exit", resolve))
      group.release()
      expect(await group.groupClosed).toBe("unverified")
      expect(await group.signal("SIGKILL")).toBe("unconfirmed")
      await exited
      expect(group.child.signalCode).toBe("SIGKILL")
      group.release()
      expect(await group.signal("SIGTERM")).toBe("unconfirmed")
    })

    test("releasing a pending request settles it without reopening the endpoint", async () => {
      const { group } = start("exit 0")
      await group.spawned
      await group.closed
      const send = spyOn(group.child, "send").mockImplementation(() => true)
      try {
        const request = group.signal("SIGKILL")
        group.release()
        expect(await request).toBe("unconfirmed")
        expect(await group.groupClosed).toBe("unverified")
        expect(await group.signal("SIGKILL")).toBe("unconfirmed")
        expect(send).toHaveBeenCalledTimes(1)
      } finally {
        send.mockRestore()
      }
    })

    test.skipIf(process.platform !== "linux")(
      "disconnect also cleans redirected descendants",
      async () => {
        const { group, stdout } = start(
          "sh -c 'trap \"\" TERM; echo $$; exec sleep 30' & wait",
        )
        await group.spawned
        await until(() => /^\d+\n$/.test(stdout()))
        const worker = Number(stdout())
        expect(await running(worker)).toBe(true)
        group.release()
        await expect(group.closed).rejects.toThrow("keeper was lost")
        await until(async () => !(await running(worker)))
      },
    )

    test("restores BUN_BE_BUN for the actual command", async () => {
      for (const value of [undefined, "original"]) {
        const env = { ...process.env }
        if (value === undefined) delete env.BUN_BE_BUN
        else env.BUN_BE_BUN = value
        const { group, stdout } = start(
          `printf "%s" "\${BUN_BE_BUN-unset}"`,
          env,
        )
        await group.spawned
        await group.closed
        expect(stdout()).toBe(value ?? "unset")
      }
    })

    test("a compiled Bun executable can relaunch itself as the keeper", async () => {
      const directory = await temp()
      const entrypoint = path.join(directory, "entry.ts")
      const executable = path.join(directory, "keeper-harness")
      const modulePath = path.resolve(
        import.meta.dir,
        "../src/process-group.ts",
      )
      await fs.writeFile(
        entrypoint,
        `
      import { spawnProcessGroup } from ${JSON.stringify(modulePath)};
      const group = spawnProcessGroup("printf compiled; exit 4", {cwd: ${JSON.stringify(directory)}});
      let output = "";
      group.stdout.on("data", (chunk) => output += chunk);
      group.stderr.resume();
      await group.spawned;
      const exit = await group.closed;
      if (process.argv[2] === "abandon") {
        console.log(JSON.stringify({pid: group.pid}));
      } else {
      const killed = await group.signal("SIGKILL");
      console.log(JSON.stringify({output, exit, killed, group: await group.groupClosed}));
      }
    `,
      )
      const build = await Bun.build({
        entrypoints: [entrypoint],
        compile: { outfile: executable },
      })
      expect(build.success).toBe(true)
      const child = spawn(executable, [], { stdio: ["ignore", "pipe", "pipe"] })
      let output = ""
      let errors = ""
      child.stdout.on("data", (chunk) => (output += chunk))
      child.stderr.on("data", (chunk) => (errors += chunk))
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      })
      expect(errors).toBe("")
      expect(code).toBe(0)
      expect(JSON.parse(output)).toEqual({
        output: "compiled",
        exit: { code: 4, signal: null },
        killed: "signalled",
        group: "complete",
      })
      const node = Bun.which("node")
      if (node) {
        const nodeEntrypoint = path.join(directory, "node-entry.mjs")
        // The TUI test preload can reuse incompatible state across build targets.
        // A fresh process keeps the Node build independent of that transform.
        const nodeBuild = await execFileAsync(
          process.execPath,
          [
            "build",
            entrypoint,
            "--target=node",
            "--format=esm",
            `--outfile=${nodeEntrypoint}`,
          ],
          { timeout: 10_000 },
        )
        expect(nodeBuild.stderr).toBe("")
        const nodeChild = spawn(node, [nodeEntrypoint], {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 5_000,
        })
        let nodeOutput = ""
        let nodeErrors = ""
        nodeChild.stdout.on("data", (chunk) => (nodeOutput += chunk))
        nodeChild.stderr.on("data", (chunk) => (nodeErrors += chunk))
        const nodeCode = await new Promise((resolve, reject) => {
          nodeChild.once("error", reject)
          nodeChild.once("close", resolve)
        })
        expect(nodeErrors).toBe("")
        expect(nodeCode).toBe(0)
        expect(JSON.parse(nodeOutput)).toEqual(JSON.parse(output))
      }
      const abandoned = spawn(executable, ["abandon"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      })
      let abandonedOutput = ""
      abandoned.stdout.on("data", (chunk) => (abandonedOutput += chunk))
      abandoned.stderr.resume()
      const abandonedCode = await new Promise((resolve, reject) => {
        abandoned.once("error", reject)
        abandoned.once("close", resolve)
      })
      expect(abandonedCode).toBe(0)
      if (process.platform === "linux") {
        const { pid } = JSON.parse(abandonedOutput)
        await until(async () => !(await running(pid)))
      }
    }, 30_000)
  },
)

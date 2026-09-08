import { type ChildProcess, spawn } from "node:child_process"
import { PassThrough, type Readable } from "node:stream"
import { unrefTimer } from "@macarons/permission-rules"

export type ProcessGroupExit = {
  code: number | null
  signal: NodeJS.Signals | null
}

export type ProcessGroup = {
  child: ChildProcess
  pid: number | undefined
  stdout: Readable | null
  stderr: Readable | null
  spawned: Promise<void>
  closed: Promise<ProcessGroupExit>
  groupClosed: Promise<"complete" | "unverified">
  signal: (
    signal: "SIGTERM" | "SIGKILL",
  ) => Promise<"signalled" | "absent" | "unconfirmed">
  release: () => void
}

const SIGNAL_CONFIRM_MS = 1_000
const STARTUP_TIMEOUT_MS = 5_000

// Only this persistent member signals the group. A private IPC endpoint cannot
// be recycled into another group's address, unlike a stored numeric PGID.
const KEEPER = `
const { spawn } = require("node:child_process");
const { closeSync } = require("node:fs");
process.on("SIGTERM", () => {});
const report = (message, callback) => {
  if (process.connected) process.send(message, callback);
};
let started = false;
process.on("message", ({ type, id, signal }) => {
  if (type === "start") {
    if (!started) {
      started = true;
      start();
    }
    return;
  }
  if (!Number.isSafeInteger(id) || !["SIGTERM", "SIGKILL"].includes(signal)) return;
  if (signal === "SIGKILL") {
    report({ type: "killing", id }, (error) => {
      if (!error) process.kill(0, "SIGKILL");
    });
  } else {
    try {
      process.kill(0, signal);
      report({ type: "signalled", id });
    } catch {
      report({ type: "unconfirmed", id });
    }
  }
});
process.on("disconnect", () => process.kill(0, "SIGKILL"));
function start() {
const env = { ...process.env };
const original = JSON.parse(process.argv[2]);
if (original.bun === undefined) delete env.BUN_BE_BUN;
else env.BUN_BE_BUN = original.bun;
const command = spawn("/bin/sh", ["-c", process.argv[1]], {
  env,
  stdio: ["ignore", 4, 5],
});
let outputOpen = true;
const closeOutput = () => {
  if (!outputOpen) return;
  outputOpen = false;
  closeSync(4);
  closeSync(5);
};
command.once("spawn", () => {
  closeOutput();
  report({ type: "spawned" });
});
command.once("error", (error) => {
  closeOutput();
  report({ type: "error", message: error.message });
});
command.once("exit", (code, signal) => report({ type: "exit", code, signal }));
}
`

/** POSIX only. Command completion and the lifetime of its group are independent. */
export function spawnProcessGroup(
  command: string,
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): ProcessGroup {
  if (process.platform === "win32")
    throw new Error("The process-group keeper requires POSIX")
  const env = options.env ?? process.env
  const child = spawn(
    "/bin/sh",
    [
      "-c",
      'exec 4>&1 5>&2; exec >/dev/null 2>&1; exec "$@"',
      "process-group-keeper",
      process.execPath,
      "--eval",
      KEEPER,
      "--",
      command,
      JSON.stringify({ bun: env.BUN_BE_BUN }),
    ],
    {
      cwd: options.cwd,
      env: { ...env, BUN_BE_BUN: "1" },
      detached: true,
      // The bootstrap preserves the pipes before Bun initializes its cached
      // stdout/stderr duplicates. It execs the keeper without changing its PGID.
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  )
  let resolveSpawned!: () => void
  let rejectSpawned!: (error: Error) => void
  const spawned = new Promise<void>((resolve, reject) => {
    resolveSpawned = resolve
    rejectSpawned = reject
  })
  let resolveClosed!: (exit: ProcessGroupExit) => void
  let rejectClosed!: (error: Error) => void
  const closed = new Promise<ProcessGroupExit>((resolve, reject) => {
    resolveClosed = resolve
    rejectClosed = reject
  })
  // Either promise may reject before the caller has finished awaiting startup.
  void spawned.catch(() => {})
  void closed.catch(() => {})
  let resolveGroupClosed!: (result: "complete" | "unverified") => void
  const groupClosed = new Promise<"complete" | "unverified">((resolve) => {
    resolveGroupClosed = resolve
  })
  let groupResult: "complete" | "unverified" | undefined
  let killAcknowledged = false
  let exit: ProcessGroupExit | undefined
  let commandStarted = false
  let commandError: Error | undefined
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let outputClosed = 0
  let nextID = 0
  const pending = new Map<
    number,
    {
      signal: "SIGTERM" | "SIGKILL"
      finish: (result: "signalled" | "unconfirmed") => void
    }
  >()
  const finishCommand = () => {
    if (exit && outputClosed === 2) resolveClosed(exit)
    // Capability loss must not finalize a started command ahead of trailing
    // output. Startup failures cannot wait for consumers that never attached.
    else if (commandError && (!commandStarted || outputClosed === 2))
      rejectClosed(commandError)
  }
  // Buffer immediately, with backpressure, until the caller attaches after
  // awaiting startup. The command may have already written its final output.
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  for (const [index, stream] of [stdout, stderr].entries()) {
    const input = index === 0 ? child.stdout : child.stderr
    if (input) {
      input.pipe(stream)
      input.once("error", (error) => {
        stream.destroy()
        child.emit("error", error)
      })
    } else stream.end()
    stream.once("close", () => {
      outputClosed++
      finishCommand()
    })
  }
  const finishGroup = (result: "complete" | "unverified", error?: Error) => {
    if (groupResult !== undefined) return
    clearTimeout(startupTimer)
    startupTimer = undefined
    groupResult = result
    resolveGroupClosed(result)
    const failure = error ?? new Error("The process-group keeper was lost")
    rejectSpawned(failure)
    if (!exit) {
      if (result === "complete") exit = { code: null, signal: "SIGKILL" }
      else commandError ??= failure
    }
    finishCommand()
    for (const request of pending.values())
      request.finish(result === "complete" ? "signalled" : "unconfirmed")
  }
  const release = () => {
    finishGroup("unverified")
    if (child.connected) {
      try {
        child.disconnect()
      } catch {
        // The endpoint already closed. Never substitute a numeric signal.
      }
    }
  }
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return
    const data = message as Record<string, unknown>
    switch (data.type) {
      case "spawned":
        clearTimeout(startupTimer)
        startupTimer = undefined
        if (groupResult === undefined) commandStarted = true
        resolveSpawned()
        break
      case "exit":
        exit = {
          code: data.code as number | null,
          signal: data.signal as NodeJS.Signals | null,
        }
        finishCommand()
        break
      case "error": {
        const error = new Error(String(data.message))
        rejectSpawned(error)
        commandError ??= error
        finishCommand()
        break
      }
      case "killing": {
        const request = pending.get(data.id as number)
        if (request?.signal === "SIGKILL") killAcknowledged = true
        break
      }
      case "signalled":
      case "unconfirmed":
        pending.get(data.id as number)?.finish(data.type)
        break
    }
  })
  child.on("error", (error) => finishGroup("unverified", error))
  child.once("exit", (_code, signal) => {
    // Event delivery can lag the request timeout; acknowledgement belongs to
    // the keeper's lifetime, not the caller's bounded wait for this response.
    const killed = signal === "SIGKILL" && killAcknowledged
    finishGroup(killed ? "complete" : "unverified")
  })
  child.once("disconnect", () => {
    // SIGKILL closes IPC before its exit event on some runtimes. Give an
    // acknowledged KILL its existing bounded wait, rather than losing the proof.
    if (
      !killAcknowledged &&
      ![...pending.values()].some((request) => request.signal === "SIGKILL")
    )
      finishGroup("unverified")
  })
  // EOF can precede the exit message. Keep the keeper referenced until both
  // arrive, then let retained finished tasks coexist with an otherwise idle host.
  void closed
    .finally(() => {
      unrefTimer(child)
      if (child.channel) unrefTimer(child.channel)
    })
    .catch(() => {})
  startupTimer = setTimeout(() => {
    finishGroup(
      "unverified",
      new Error(
        `The process-group keeper did not confirm startup within ${STARTUP_TIMEOUT_MS} ms`,
      ),
    )
    release()
  }, STARTUP_TIMEOUT_MS)
  // Launch only after output buffering and every lifecycle listener are ready.
  queueMicrotask(() => {
    if (groupResult !== undefined || !child.connected) return
    try {
      child.send({ type: "start" }, (error) => {
        if (error) finishGroup("unverified", error)
      })
    } catch (error) {
      finishGroup("unverified", error as Error)
    }
  })

  return {
    child,
    pid: child.pid,
    stdout,
    stderr,
    spawned,
    closed,
    groupClosed,
    release,
    signal: (signal) => {
      if (groupResult !== undefined)
        return Promise.resolve(
          groupResult === "complete" ? "absent" : "unconfirmed",
        )
      if (!child.connected) return Promise.resolve("unconfirmed")
      return new Promise((resolve) => {
        const id = ++nextID
        const timer = setTimeout(() => {
          pending.get(id)?.finish("unconfirmed")
          if (!child.connected && !killAcknowledged) finishGroup("unverified")
        }, SIGNAL_CONFIRM_MS)
        pending.set(id, {
          signal,
          finish: (result) => {
            clearTimeout(timer)
            pending.delete(id)
            resolve(result)
          },
        })
        try {
          child.send({ id, signal }, (error) => {
            if (error) pending.get(id)?.finish("unconfirmed")
          })
        } catch {
          pending.get(id)?.finish("unconfirmed")
        }
      })
    },
  }
}

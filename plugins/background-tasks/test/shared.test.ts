import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  BAND_SAMPLE_VERSIONS as BAND,
  projectFileKey,
} from "@macarons/permission-rules"
import {
  appendOutput,
  clampWaitTimeout,
  coalescedNotificationText,
  compileWaitPattern,
  completeLineEnd,
  createBuffer,
  DEFAULT_KILL_CONFIRM_MS,
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_MAX_TASKS_PER_SESSION,
  DEFAULT_NOTIFY_POST_TIMEOUT_MS,
  DEFAULT_NOTIFY_TAIL_LINES,
  DEFAULT_POLL_MS,
  endedPhrase,
  formatDuration,
  instanceTasksFilePath,
  killRequestsDir,
  lastLines,
  legacyTasksFilePath,
  loadTasksFile,
  loadTasksFiles,
  MAX_TIMER_MS,
  MIN_KILL_CONFIRM_MS,
  MIN_NOTIFY_POST_TIMEOUT_MS,
  notificationBlock,
  notificationText,
  openCodeCompatNotice,
  parseKillRequest,
  parseTasksFile,
  preSlugKillRequestsDir,
  preSlugTasksFilePath,
  readUnread,
  resolveChannelPaths,
  resolveServerOptions,
  resolveTuiOptions,
  STATE_FILE_VERSION,
  SUPPORTED_OPENCODE_RANGE,
  scanLinesForMatch,
  scopedTaskError,
  sliceBuffer,
  splitTasks,
  type TaskSnapshot,
  tailOf,
  taskIdPrefix,
  taskLabel,
  tasksDirectory,
  tasksFilePath,
  truncateLabel,
  WAIT_DEFAULT_TIMEOUT_MS,
  WAIT_MAX_TIMEOUT_MS,
} from "../src/shared"

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: "bg_1",
    command: "npm run build",
    workdir: "/project",
    sessionID: "ses_1",
    agent: "build",
    state: "exited",
    exitCode: 0,
    startedAt: 1_000,
    endedAt: 103_000,
    outputBytes: 0,
    droppedBytes: 0,
    ...overrides,
  }
}

describe("version gate", () => {
  const R = SUPPORTED_OPENCODE_RANGE
  // [version, compat, disables?] — a non-v1 host disables; every v1 host runs
  // (silently inside the verified band, with a warning otherwise). Samples
  // derive from the band so the nightly ratchet cannot strand them.
  const cases: [
    version: string | undefined,
    compat: "supported" | "untested" | "incompatible",
    disable: boolean,
  ][] = [
    [BAND.floor, "supported", false], // verified floor
    [BAND.inBand, "supported", false],
    [`${BAND.floor}+sha.abc`, "supported", false], // build metadata ignored
    [BAND.belowBand, "untested", false], // below the floor: warn but run
    [`${BAND.floor}-rc.1`, "untested", false], // a v1 prerelease
    [BAND.aboveBand, "untested", false], // past the ceiling: untested, not disabled
    ["junk", "untested", false], // unreadable → fail open
    [undefined, "untested", false], // probe could not name the version
    ["2.0.0", "incompatible", true], // OpenCode v2 changes the plugin API
    ["2.0.0-beta.1", "incompatible", true], // the v2 beta, specifically
  ]
  test.each(cases)("%p → %s (disable=%p)", (version, compat, disable) => {
    const notice = openCodeCompatNotice(version, R, "Background tasks")
    if (compat === "supported") {
      expect(notice).toBeNull()
    } else {
      expect(notice?.compat).toBe(compat)
      expect(notice?.disable).toBe(disable)
    }
  })
})

describe("resolveServerOptions", () => {
  test("defaults on missing/junk input", () => {
    for (const raw of [undefined, null, 42, "nope", {}]) {
      expect(resolveServerOptions(raw)).toEqual({
        notify: true,
        toast: true,
        bashHint: true,
        maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
        maxTasksPerSession: DEFAULT_MAX_TASKS_PER_SESSION,
        notifyTailLines: DEFAULT_NOTIFY_TAIL_LINES,
        notifyPostTimeoutMs: DEFAULT_NOTIFY_POST_TIMEOUT_MS,
        killConfirmMs: DEFAULT_KILL_CONFIRM_MS,
      })
    }
  })

  test("clamps numeric knobs to their documented ranges", () => {
    const options = resolveServerOptions({
      maxBufferBytes: 1,
      maxTasksPerSession: 500,
      notifyTailLines: -3,
    })
    expect(options.maxBufferBytes).toBe(64 * 1024)
    expect(options.maxTasksPerSession).toBe(32)
    expect(options.notifyTailLines).toBe(0)
    expect(resolveServerOptions({ maxBufferBytes: 1e12 }).maxBufferBytes).toBe(
      16 * 1024 * 1024,
    )
    // The floor sits above the host's busy-propagation latency: abandoning a
    // post sooner than that is what would let the next note read a session it
    // just prompted as idle.
    expect(
      resolveServerOptions({ notifyPostTimeoutMs: 1 }).notifyPostTimeoutMs,
    ).toBe(MIN_NOTIFY_POST_TIMEOUT_MS)
    // The confirm window is injectable but floored, so a tiny override cannot
    // make background_kill return before the child has any chance to confirm.
    expect(resolveServerOptions({ killConfirmMs: 1 }).killConfirmMs).toBe(
      MIN_KILL_CONFIRM_MS,
    )
    expect(resolveServerOptions({ killConfirmMs: 250 }).killConfirmMs).toBe(250)
  })

  test("boolean switches only turn off on literal false", () => {
    const options = resolveServerOptions({
      notify: false,
      toast: 0,
      bashHint: "no",
    })
    expect(options.notify).toBe(false)
    expect(options.toast).toBe(true)
    expect(options.bashHint).toBe(true)
  })
})

describe("resolveTuiOptions", () => {
  test("keybind defaults OFF and only a non-empty string enables it", () => {
    expect(resolveTuiOptions({}).keybind).toBeUndefined()
    expect(resolveTuiOptions({ keybind: "none" }).keybind).toBeUndefined()
    expect(resolveTuiOptions({ keybind: false }).keybind).toBeUndefined()
    expect(resolveTuiOptions({ keybind: "  " }).keybind).toBeUndefined()
    expect(resolveTuiOptions({ keybind: "<leader>k" }).keybind).toBe(
      "<leader>k",
    )
  })

  test("sidebar defaults on; pollMs clamps to the floor and the timer ceiling", () => {
    expect(resolveTuiOptions({}).sidebar).toBe(true)
    expect(resolveTuiOptions({ sidebar: false }).sidebar).toBe(false)
    expect(resolveTuiOptions({}).pollMs).toBe(DEFAULT_POLL_MS)
    expect(resolveTuiOptions({ pollMs: 10 }).pollMs).toBe(2_000)
    expect(resolveTuiOptions({ pollMs: "x" }).pollMs).toBe(DEFAULT_POLL_MS)
    // Past 2^31-1, setInterval degrades to ~1 ms — a huge "poll rarely"
    // setting must not become a busy loop.
    expect(resolveTuiOptions({ pollMs: Number.MAX_SAFE_INTEGER }).pollMs).toBe(
      MAX_TIMER_MS,
    )
  })
})

describe("output buffer", () => {
  test("append + read consumes exactly once", () => {
    const buffer = createBuffer(100)
    appendOutput(buffer, "one\n")
    appendOutput(buffer, "two\n")
    const first = readUnread(buffer)
    expect(first.text).toBe("one\ntwo\n")
    expect(first.lost).toBe(0)
    expect(readUnread(buffer).text).toBe("")
    appendOutput(buffer, "three\n")
    expect(readUnread(buffer).text).toBe("three\n")
  })

  test("evicts from the front precisely at the cap, slicing oversize chunks", () => {
    const buffer = createBuffer(10)
    appendOutput(buffer, "abcde")
    appendOutput(buffer, "fghij")
    appendOutput(buffer, "XY")
    expect(buffer.total - buffer.dropped).toBe(10)
    expect(buffer.dropped).toBe(2)
    expect(sliceBuffer(buffer, buffer.dropped)).toBe("cdefghijXY")
    // A single chunk bigger than the whole cap keeps only its tail.
    const big = createBuffer(4)
    appendOutput(big, "0123456789")
    expect(sliceBuffer(big, big.dropped)).toBe("6789")
    expect(big.dropped).toBe(6)
  })

  test("reports output lost before the cursor could read it", () => {
    const buffer = createBuffer(4)
    appendOutput(buffer, "abcd")
    appendOutput(buffer, "efgh")
    const read = readUnread(buffer)
    expect(read.lost).toBe(4)
    expect(read.text).toBe("efgh")
    expect(readUnread(buffer).lost).toBe(0)
  })

  test("filter selects shown lines but consumes everything", () => {
    const buffer = createBuffer(1_000)
    appendOutput(buffer, "x1\ny2\nx3\n")
    const filtered = readUnread(buffer, /^x/)
    expect(filtered.text.split("\n").filter(Boolean)).toEqual(["x1", "x3"])
    expect(readUnread(buffer).text).toBe("")
  })

  test("tailOf and lastLines bound the notification quote", () => {
    const buffer = createBuffer(1_000)
    appendOutput(buffer, "a\nb\nc\nd\n")
    expect(tailOf(buffer, 4)).toBe("c\nd\n")
    expect(lastLines("a\nb\nc\nd\n", 2)).toBe("c\nd")
    expect(lastLines("no trailing newline", 5)).toBe("no trailing newline")
    expect(lastLines("a\nb", 0)).toBe("")
  })
})

describe("wait matching", () => {
  test("matches complete lines only while the task lives", () => {
    expect(scanLinesForMatch("Listening on 3000\n", /Listening/, true)).toEqual(
      {
        line: "Listening on 3000",
        end: 18,
      },
    )
    expect(
      scanLinesForMatch("Listening on 3000", /Listening/, true),
    ).toBeUndefined()
    expect(scanLinesForMatch("Listening on 3000", /Listening/, false)).toEqual({
      line: "Listening on 3000",
      end: 17,
    })
  })

  test("anchors apply per line, and the first matching line wins", () => {
    const text = "before\nerror: boom\nerror: later\n"
    const match = scanLinesForMatch(text, /^error:/, true)
    expect(match?.line).toBe("error: boom")
    expect(text.slice(0, match?.end)).toBe("before\nerror: boom\n")
  })

  test("a line assembled across chunk boundaries matches once complete", () => {
    const buffer = createBuffer(1_000)
    appendOutput(buffer, "Lis")
    expect(
      scanLinesForMatch(sliceBuffer(buffer, 0), /Listening/, true),
    ).toBeUndefined()
    appendOutput(buffer, "tening on 3000\nmore")
    expect(
      scanLinesForMatch(sliceBuffer(buffer, 0), /Listening/, true)?.line,
    ).toBe("Listening on 3000")
  })

  test("completeLineEnd finds the start of the unterminated tail", () => {
    expect(completeLineEnd("a\nb\npartial")).toBe(4)
    expect(completeLineEnd("no newline")).toBe(0)
    expect(completeLineEnd("done\n")).toBe(5)
  })

  test("compileWaitPattern returns a model-facing Error on bad regex", () => {
    expect(compileWaitPattern("\\d+")).toBeInstanceOf(RegExp)
    const error = compileWaitPattern("(unclosed")
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('"(unclosed"')
    expect((error as Error).message).toContain("regular expression")
  })

  test("clampWaitTimeout: default, floor(junk), and cap", () => {
    expect(clampWaitTimeout(undefined)).toBe(WAIT_DEFAULT_TIMEOUT_MS)
    expect(clampWaitTimeout(-5)).toBe(WAIT_DEFAULT_TIMEOUT_MS)
    expect(clampWaitTimeout(1_500.9)).toBe(1_500)
    expect(clampWaitTimeout(10_000_000)).toBe(WAIT_MAX_TIMEOUT_MS)
  })
})

describe("cross-half channel", () => {
  let sandbox: string
  let project: string
  let stateDir: string

  beforeEach(async () => {
    sandbox = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "background-tasks-shared-")),
    )
    project = path.join(sandbox, "project")
    stateDir = path.join(sandbox, "state")
    await Promise.all([fs.mkdir(project), fs.mkdir(stateDir)])
  })

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true })
  })

  test("paths derive from the readable project key, inside the state dir", () => {
    const key = projectFileKey(project)
    expect(key).toMatch(/^project-[0-9a-f]{16}$/)
    const tasksDir = path.join(stateDir, "background-tasks", `tasks-${key}`)
    expect(tasksDirectory(stateDir, project)).toBe(tasksDir)
    expect(tasksFilePath(stateDir, project, "inst-1")).toBe(
      path.join(tasksDir, "instance-inst-1.json"),
    )
    expect(instanceTasksFilePath(tasksDir, "inst-2")).toBe(
      path.join(tasksDir, "instance-inst-2.json"),
    )
    expect(legacyTasksFilePath(stateDir, project)).toBe(
      path.join(stateDir, "background-tasks", `tasks-${key}.json`),
    )
    expect(killRequestsDir(stateDir, project)).toBe(
      path.join(stateDir, "background-tasks", `requests-${key}`),
    )
  })

  test("resolveChannelPaths accepts a clean layout and rejects a state dir inside the project", async () => {
    const paths = await resolveChannelPaths(project, stateDir)
    expect(paths).toBeDefined()
    expect(paths?.tasksDir).toBe(tasksDirectory(stateDir, project))
    expect(paths?.legacyStateFile).toBe(legacyTasksFilePath(stateDir, project))
    // The pre-slug generation rides along as the mixed-version channel
    // bridge: same directory, bare-hash names.
    expect(paths?.preSlugStateFile).toBe(
      preSlugTasksFilePath(stateDir, project),
    )
    expect(paths?.preSlugKillDir).toBe(
      preSlugKillRequestsDir(stateDir, project),
    )
    const inside = path.join(project, "state")
    await fs.mkdir(inside)
    expect(await resolveChannelPaths(project, inside)).toBeUndefined()
  })

  test("the pre-slug channel names match what pre-slug releases derived", () => {
    // The bridge only works if these stay byte-for-byte what the previous
    // release computed: bare 16-hex hash, no slug.
    const hash16 = /-([0-9a-f]{16})(\.json)?$/
    expect(path.basename(preSlugTasksFilePath(stateDir, project))).toMatch(
      /^tasks-[0-9a-f]{16}\.json$/,
    )
    expect(path.basename(preSlugKillRequestsDir(stateDir, project))).toMatch(
      /^requests-[0-9a-f]{16}$/,
    )
    // Same project key as the readable names, so both generations address
    // the same project.
    const keyOf = (name: string) => hash16.exec(name)?.[1]
    expect(keyOf(path.basename(preSlugTasksFilePath(stateDir, project)))).toBe(
      keyOf(path.basename(legacyTasksFilePath(stateDir, project))),
    )
  })

  test("resolveChannelPaths rejects a symlink escaping the state dir into the project", async () => {
    await fs.symlink(project, path.join(stateDir, "background-tasks"))
    expect(await resolveChannelPaths(project, stateDir)).toBeUndefined()
  })

  test("parseTasksFile round-trips and skips malformed entries", () => {
    const file = {
      version: 1,
      instance: { id: "i-1", pid: 4242, startedAt: 5 },
      updatedAt: 6,
      tasks: [
        snapshot(),
        { id: "broken" },
        42,
        snapshot({ id: "bg_2", state: "running", pid: 77 }),
      ],
    }
    const parsed = parseTasksFile(file)
    expect(parsed?.tasks.map((task) => task.id)).toEqual(["bg_1", "bg_2"])
    expect(parseTasksFile({ ...file, aggregate: true })?.aggregate).toBe(true)
    expect(parseTasksFile({ ...file, version: 2 })).toBeUndefined()
    expect(parseTasksFile({ ...file, instance: undefined })).toBeUndefined()
    expect(parseTasksFile("junk")).toBeUndefined()
  })

  test("loadTasksFile treats missing/corrupt files as undefined", async () => {
    expect(
      await loadTasksFile(path.join(stateDir, "nope.json")),
    ).toBeUndefined()
    const file = path.join(stateDir, "corrupt.json")
    await fs.writeFile(file, "{not json")
    expect(await loadTasksFile(file)).toBeUndefined()
  })

  test("loadTasksFiles merges valid instance-owned files and ignores junk or mismatched owners", async () => {
    const tasksDir = tasksDirectory(stateDir, project)
    const first = {
      version: STATE_FILE_VERSION,
      instance: { id: "inst-a", pid: 1, startedAt: 1 },
      updatedAt: 2,
      tasks: [snapshot({ id: "bg_a_1" })],
    }
    const second = {
      version: STATE_FILE_VERSION,
      instance: { id: "inst-b", pid: 2, startedAt: 3 },
      updatedAt: 4,
      tasks: [snapshot({ id: "bg_b_1" })],
    }
    const aggregate = {
      ...second,
      instance: { ...second.instance, id: "inst-aggregate" },
      aggregate: true,
    }
    await fs.mkdir(tasksDir, { recursive: true })
    await Promise.all([
      fs.writeFile(
        tasksFilePath(stateDir, project, "inst-a"),
        JSON.stringify(first),
      ),
      fs.writeFile(
        tasksFilePath(stateDir, project, "inst-b"),
        JSON.stringify(second),
      ),
      fs.writeFile(
        tasksFilePath(stateDir, project, "wrong-name"),
        JSON.stringify(first),
      ),
      fs.writeFile(
        tasksFilePath(stateDir, project, "inst-aggregate"),
        JSON.stringify(aggregate),
      ),
      fs.writeFile(path.join(tasksDir, "junk.json"), "{not json"),
    ])
    expect(
      (await loadTasksFiles(tasksDir)).map((file) => file.instance.id),
    ).toEqual(["inst-a", "inst-b"])
  })

  test("parseKillRequest validates the full shape", () => {
    expect(
      parseKillRequest({
        version: 1,
        action: "kill",
        taskID: "bg_3",
        requestedAt: 1,
      }),
    ).toEqual({
      taskID: "bg_3",
      requestedAt: 1,
    })
    // A missing/junk timestamp reads as 0 — i.e. ancient, sweepable by anyone.
    expect(
      parseKillRequest({ version: 1, action: "kill", taskID: "bg_3" })
        ?.requestedAt,
    ).toBe(0)
    expect(
      parseKillRequest({
        version: 1,
        action: "kill",
        taskID: "bg_3",
        requestedAt: "x",
      })?.requestedAt,
    ).toBe(0)
    expect(
      parseKillRequest({ version: 1, action: "kill", taskID: "" }),
    ).toBeUndefined()
    expect(
      parseKillRequest({ version: 2, action: "kill", taskID: "bg_3" }),
    ).toBeUndefined()
    expect(
      parseKillRequest({ version: 1, action: "stop", taskID: "bg_3" }),
    ).toBeUndefined()
    expect(parseKillRequest(null)).toBeUndefined()
  })

  test("taskIdPrefix embeds a slug of the instance id, so instances cannot mint colliding ids", () => {
    expect(taskIdPrefix("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(
      "bg_f47ac1_",
    )
    expect(taskIdPrefix("00000000-0000-0000-0000-000000000000")).not.toBe(
      taskIdPrefix("f47ac10b-58cc-4372-a567-0e02b2c3d479"),
    )
    expect(`${taskIdPrefix(crypto.randomUUID())}1`).toMatch(
      /^bg_[0-9a-f]{6}_1$/,
    )
  })
})

describe("presentation", () => {
  test("taskLabel prefers the name; truncateLabel flattens and ellipsizes", () => {
    expect(taskLabel({ name: "dev server", command: "bunx vite" })).toBe(
      "dev server",
    )
    expect(taskLabel({ command: "bunx vite" })).toBe("bunx vite")
    expect(truncateLabel("a  b\nc", 10)).toBe("a b c")
    expect(truncateLabel("abcdefghij", 5)).toBe("abcd…")
  })

  test("formatDuration boundaries", () => {
    expect(formatDuration(5_000)).toBe("5s")
    expect(formatDuration(61_000)).toBe("1m01s")
    expect(formatDuration(3_600_000)).toBe("1h00m")
    // The hours→days cutoff is where an off-by-one would hide: 47h is still
    // reported in hours, 48h is the first duration that rounds down to days.
    expect(formatDuration(47 * 3_600_000)).toBe("47h00m")
    expect(formatDuration(48 * 3_600_000)).toBe("2d")
    expect(formatDuration(49 * 3_600_000)).toBe("2d")
    expect(formatDuration(-5)).toBe("0s")
  })

  test("splitTasks: session scoping, dead pids, dead instance", () => {
    const tasks = [
      snapshot({ id: "bg_1", state: "running", pid: 1, sessionID: "ses_A" }),
      snapshot({ id: "bg_2", state: "running", pid: 2, sessionID: "ses_B" }),
      snapshot({ id: "bg_3", state: "running", pid: 3, sessionID: "ses_A" }),
      snapshot({ id: "bg_4", state: "exited" }),
    ]
    const alive = (pid: number) => pid !== 3
    const split = splitTasks(tasks, "ses_A", alive, true)
    expect(split.current.map((task) => task.id)).toEqual(["bg_1"])
    expect(split.others.map((task) => task.id)).toEqual(["bg_2"])
    expect(split.stale.map((task) => task.id)).toEqual(["bg_3"])
    expect(split.finished.map((task) => task.id)).toEqual(["bg_4"])
    const deadInstance = splitTasks(tasks, "ses_A", alive, false)
    expect(deadInstance.stale.map((task) => task.id)).toEqual([
      "bg_1",
      "bg_2",
      "bg_3",
    ])
  })
})

describe("model-facing text", () => {
  test("scopedTaskError names the id and the remedy", () => {
    const message = scopedTaskError("bg_7")
    expect(message).toContain('"bg_7"')
    expect(message).toContain("session-scoped")
    expect(message).toContain("background_run")
  })

  test("endedPhrase covers every terminal state", () => {
    expect(endedPhrase(snapshot())).toBe("exited with code 0")
    expect(endedPhrase(snapshot({ exitCode: 1 }))).toBe("exited with code 1")
    expect(endedPhrase(snapshot({ state: "killed", signal: "SIGKILL" }))).toBe(
      "was killed (SIGKILL)",
    )
    expect(
      endedPhrase(
        snapshot({
          state: "killed",
          killReason: "timeout",
          timeoutMs: 5_000,
          signal: "SIGTERM",
        }),
      ),
    ).toBe("was killed after exceeding its 5000 ms timeout (SIGTERM)")
    expect(endedPhrase(snapshot({ state: "killed", killReason: "tui" }))).toBe(
      "was killed (SIGTERM, requested via the TUI)",
    )
    expect(
      endedPhrase(snapshot({ state: "error", errorMessage: "spawn failed" })),
    ).toBe("failed: spawn failed")
  })

  test("notificationText carries the update block, the tail, and the follow-up hint", () => {
    const text = notificationText(snapshot({ name: "build" }), "line1\nline2")
    expect(text).toStartWith("<background-task-update>")
    expect(text).toContain('bg_1 ("build") exited with code 0 after 1m42s')
    expect(text).toContain("Command: npm run build")
    expect(text).toContain("line1\nline2")
    expect(text).toContain("</background-task-update>")
    expect(text).toContain('background_output({ "task_id": "bg_1" })')
    expect(text).toContain("you may ignore it")
    expect(notificationText(snapshot(), "")).toContain(
      "(no output was produced)",
    )
  })

  test("a single coalesced note is byte-identical to the uncoalesced one", () => {
    const task = snapshot({ name: "build" })
    expect(
      coalescedNotificationText([
        { id: task.id, block: notificationBlock(task, "line1") },
      ]),
    ).toBe(notificationText(task, "line1"))
  })

  test("several notes share one header and one closing hint naming every task", () => {
    const first = snapshot({ id: "bg_1", name: "build" })
    const second = snapshot({ id: "bg_2", name: "tests" })
    const text = coalescedNotificationText([
      { id: first.id, block: notificationBlock(first, "built") },
      { id: second.id, block: notificationBlock(second, "passed") },
    ])
    expect(text).toStartWith(
      "2 background tasks finished while you were working:",
    )
    expect(text).toContain('bg_1 ("build")')
    expect(text).toContain('bg_2 ("tests")')
    expect(text.match(/<background-task-update>/g)).toHaveLength(2)
    // One hint for the batch, naming both, not one hint per task.
    expect(text.match(/you may ignore/g)).toHaveLength(1)
    expect(text).toContain('background_output for any of "bg_1", "bg_2"')
    expect(text).toContain("you may ignore them")
  })
})

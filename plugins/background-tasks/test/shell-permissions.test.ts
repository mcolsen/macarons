import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { analyzeShellCommand } from "../src/shell-permissions"

let base: string
let root: string
let outside: string
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const analyze = (command: string, cwd = root, shell = "/bin/sh") =>
  analyzeShellCommand(command, cwd, root, shell)

beforeAll(async () => {
  base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "background-shell-permissions-")),
  )
  root = path.join(base, "project")
  outside = path.join(base, "outside")
  await fs.mkdir(root)
  await fs.mkdir(outside)
  await fs.mkdir(path.join(outside, "child"))
  await fs.writeFile(path.join(root, "input"), "inside")
  await fs.writeFile(path.join(outside, "secret"), "outside")
  await fs.writeFile(path.join(outside, "file with spaces"), "outside")
  await fs.symlink(outside, path.join(root, "escape"))
  await fs.symlink(outside, path.join(root, "~"))
  await fs.symlink(path.join(outside, "child"), path.join(root, "child-link"))
  await fs.symlink(path.join(outside, "missing"), path.join(root, "dangling"))
  await fs.symlink("loop", path.join(root, "loop"))
  await fs.symlink(path.join(outside, "secret"), path.join(root, "--"))
  await fs.symlink("/proc/self/cwd", path.join(root, "process-cwd"))
  for (let i = 0; i <= 6; i++) {
    await fs.symlink(
      i === 6 ? "." : `chain${i + 1}/chain${i + 1}`,
      path.join(root, `chain${i}`),
    )
  }
})

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

describe("shell command patterns", () => {
  test("keeps literal simple command to one exact pattern", async () => {
    expect(await analyze("echo hi")).toEqual({
      patterns: ["echo hi"],
      directories: [],
    })
  })

  test.each(["\u00a0uname", "uname\u00a0", "\u000buname"])(
    "preserves non-shell whitespace in the executable resource: %s",
    async (command) => {
      expect((await analyze(command)).patterns).toEqual([command])
    },
  )

  test.each([
    "echo hi; uname",
    "echo hi\nuname",
    "echo hi && uname",
    "echo hi || uname",
    "echo hi | uname",
    "{ echo hi; uname; }",
    "(echo hi; uname)",
    "if echo hi; then uname; else echo no; fi",
    "while echo hi; do uname; done",
    "until echo hi; do uname; done",
    "for x in a b; do echo $x; uname; done",
  ])("checks every executable in %s", async (command) => {
    const result = await analyze(command)
    expect(result.patterns).toContain("uname")
    expect(result.patterns.some((pattern) => pattern.includes(";"))).toBe(false)
  })

  test.each([
    "echo $(uname)",
    "echo `uname`",
    'echo "$(echo $(uname))"',
    "echo `echo \\`uname\\``",
    "echo foo`uname`bar",
  ])("traverses lazy substitutions in %s", async (command) => {
    expect((await analyze(command)).patterns).toContain("uname")
  })

  test.each(["'uname' -a", '"uname" -a', "u\\name -a", "u'na'me -a"])(
    "normalizes %s",
    async (command) => {
      const { patterns } = await analyze(command)
      expect(patterns).toContain(command)
      expect(patterns).toContain("uname -a")
    },
  )

  test.each([
    "exec uname",
    "command uname",
    "env uname",
    "nohup uname",
    "nice uname",
    "nice -- uname",
    "nice -n 5 uname",
    "nice -n -5 -- uname",
    "timeout 300 uname",
    "timeout -- 0.5s uname",
    "timeout .5m uname",
    "exec command -- uname",
    "sh -c 'uname'",
  ])("unwraps %s", async (command) => {
    expect((await analyze(command)).patterns).toContain("uname")
  })

  test("checks every layer of nested wrappers", async () => {
    expect(
      (await analyze("nice -n 5 timeout 300 nohup uname -a")).patterns,
    ).toEqual([
      "nice -n 5 timeout 300 nohup uname -a",
      "timeout 300 nohup uname -a",
      "nohup uname -a",
      "uname -a",
    ])
  })

  test.each(["! uname -a", "! echo hi | uname -a"])(
    "keeps executable-based permissions for negation in %s",
    async (command) => {
      expect((await analyze(command)).patterns).toEqual(
        (await analyze(command.slice(2))).patterns,
      )
    },
  )

  test("supports lifecycle commands", async () => {
    expect(
      (await analyze("sh -c 'sleep 0.25' & exec sleep 10")).patterns,
    ).toContain("sleep 10")
    expect(
      (await analyze("trap '' TERM; while :; do sleep 0.03; done")).patterns,
    ).toContain("sleep 0.03")
  })

  test("does not reinterpret quoted program source as shell", async () => {
    const command = "bun -e 'console.log(\"$(uname)\")'"
    expect((await analyze(command)).patterns).toEqual([command])
    expect((await analyze("echo '$HOME' '$(uname)'")).patterns).toEqual([
      "echo '$HOME' '$(uname)'",
    ])
    expect((await analyze("bun -e ''")).directories).toEqual([])
  })
})

describe("fail-closed syntax", () => {
  test.each([
    "echo 'unterminated",
    "echo $(uname",
    "echo $(if)",
    "echo $(echo hi; ; uname)",
    "echo `echo \\`if\\``",
    "sh -c 'echo $(if)'",
    "echo >",
    "echo hi ) uname",
    "echo trailing\\",
    "if then echo hi; fi",
    "while do echo hi; done",
    "( )",
    "{ }",
    "echo \0 hi",
    "$COMMAND",
    "$(echo uname)",
    "u*name",
    "echo hi; $COMMAND",
    "cat $FILE",
    'cat "$(echo input)"',
    "cat --$FLAGS",
    "echo hi > $OUTPUT",
    "echo hi > $(echo out)",
    `cat \${FILE:-input}`,
    "cat <(uname)",
    "echo $((1+$(uname)))",
    `echo \${x:=value}`,
    "custom --output=$OUT",
    'custom --output "$OUT"',
    "custom -o $(echo out)",
    `echo "\${HOME:+'$(uname)'}"`,
    `echo "\${x:-'}"; uname #'}"`,
    `echo "\${x:-'$(cat /etc/passwd)'}"`,
    "cat */secret",
    "cat e*/secret",
    "cat /et?/passwd",
    "cat escape/s*",
    "cp -t/tmp input",
    "mv -t/tmp input",
    "cp -tescape input",
    "custom -oescape",
    "grep -fescape input",
    'head "$HOME/.profile"',
    `head \${HOME}/.profile`,
    'for x in /etc/passwd; do head "$x"; done',
    'custom "$FILE"',
    "touch ~'/'new-output",
    "printf -v HOME /tmp",
    'printf "$FORMAT" data',
    "printf %n HOME; touch ~/new-output",
    "printf %10n HOME",
    "printf -[v] HOME /tmp",
    "printf -- * HOME",
    "let 'HOME=0'; touch ~/new-output",
    "mapfile -C uname -c 1 < input",
    "readarray -C uname -c 1 < input",
    "for x in uname; do $\\\nx; done",
    "cat $\\\nHOME/.profile",
    "cat $\\\n{HOME}/.profile",
    "una\\\nme -a",
    "grep secret */secret",
    "grep secret e*/secret",
    "for RANDOM in 'x[$(uname >&2)0]'; do :; done",
    "for RANDOM in 'HOME=0'; do :; done; touch ~/new-output",
    "for SECONDS in 'HOME=0'; do :; done",
    "for BASH_ALIASES in uname; do :; done",
    "cat /proc/self/cwd/../../outside/secret",
    "cat /dev/fd/3",
    "cat process-cwd/input",
    "custom --output='~/secret'",
    "echo $'text'",
    "echo {a,b}",
    "echo x |& uname",
    "echo x &> out",
    "echo x <<< hi",
    "cat <<EOF\n$(uname)\nEOF",
    "[[ -f input ]]",
    "function f() { uname; }; f",
    "f() { uname; }; f",
    "eval uname",
    ". input",
    "source input",
    "alias x=uname",
    "PATH=/tmp uname",
    "IFS=/ uname",
    "HOME=/tmp echo hi",
    "FOO=bar echo hi",
    "export PATH=/tmp; uname",
    "for PATH in /tmp; do uname; done",
    "read PATH",
    "env PATH=/tmp uname",
    "command -p uname",
    "exec -a fake uname",
    "nice -n",
    "nice -n 5",
    "nice -n $PRIORITY uname",
    "nice -n '5*' uname",
    "nice -5 uname",
    "nice --adjustment=5 uname",
    "timeout",
    "timeout 300",
    "timeout $DURATION uname",
    "timeout '3*' uname",
    "timeout -k 5 300 uname",
    "timeout --signal=KILL 300 uname",
    "timeout 300 -- uname",
    "sh input",
    "bash -c 'uname'",
    'sh -c "$CODE"',
    "trap 'uname' EXIT",
    "cd /tmp; uname",
  ])("rejects %s", async (command) => {
    await expect(analyze(command)).rejects.toThrow()
  })

  test.each([
    "ionice uname",
    "taskset 1 uname",
    "chrt 1 uname",
    "sudo uname -a",
    "doas uname -a",
    "setsid uname",
    "stdbuf -o L uname",
    "xargs uname",
    "watch uname",
    "nice -n 5 sudo uname",
    "timeout 300 xargs uname",
  ])("rejects unhandled command launchers in %s", async (command) => {
    await expect(analyze(command)).rejects.toThrow("indirect execution")
  })

  test.each(["-exec", "-execdir", "-ok", "-okdir"])(
    "rejects find's %s action even after --",
    async (action) => {
      await expect(analyze(`find -- . ${action} uname \\;`)).rejects.toThrow(
        "find execution actions",
      )
    },
  )

  test.each(["cmd", "dash", "ksh", "fish", "pwsh"])(
    "treats shell-name collisions conservatively: %s",
    async (binary) => {
      await expect(analyze(`${root}/${binary}`)).rejects.toThrow(
        "only literal sh -c",
      )
    },
  )

  test.each(["find -- . -name -exec", "find -- . -printf -ok"])(
    "conservatively rejects action-like find operands in %s",
    async (command) => {
      await expect(analyze(command)).rejects.toThrow("find execution actions")
    },
  )

  test("explains the conservative wildcard check for the test builtin", async () => {
    await expect(analyze("[ -f input ]")).rejects.toThrow(
      "quote wildcard characters",
    )
    for (const command of ["test -f input", "'[' -f input ]"])
      expect((await analyze(command)).patterns).toContain(command)
  })

  test.each(["/bin/bash", "/bin/zsh", "cmd.exe", "powershell", "pwsh", "sh"])(
    "rejects shell %s",
    async (shell) => {
      await expect(analyze("echo hi", root, shell)).rejects.toThrow("/bin/sh")
    },
  )

  test("never executes command substitutions", async () => {
    const output = path.join(root, "must-not-exist")
    await analyze(`echo $(touch ${quote(output)})`)
    expect(await fs.exists(output)).toBe(false)
    await expect(analyze(`cat $(touch ${quote(output)})`)).rejects.toThrow()
    expect(await fs.exists(output)).toBe(false)
  })
})

describe("directory boundaries", () => {
  test("includes external workdir", async () => {
    expect((await analyze("echo hi", outside)).directories).toEqual([outside])
  })

  test("retains external checks for /dev/null redirects", async () => {
    expect((await analyze("echo hi 2>/dev/null")).directories).toEqual([
      await fs.realpath("/dev"),
    ])
  })

  test("checks path-qualified executables, including inside wrappers", async () => {
    const executable = quote(path.join(outside, "secret"))
    for (const command of [executable, `nice -n 5 timeout 300 ${executable}`])
      expect((await analyze(command)).directories).toEqual([outside])
  })

  test("leaves missing workdir errors to the launcher", async () => {
    expect(await analyze("echo hi", path.join(root, "missing-cwd"))).toEqual({
      patterns: ["echo hi"],
      directories: [],
    })
  })

  test.each([
    "printf hi > output; cat output",
    "rm -f missing",
    "rm -rf missing",
    "cat < missing",
  ])("allows canonically resolved missing paths in %s", async (command) => {
    expect((await analyze(command)).directories).toEqual([])
  })

  test.each([
    "cat escape/secret",
    "nice -n 5 timeout 300 cat escape/secret",
    "cat escape/'file with spaces'",
    "cat child-link/../secret",
    "cat input > escape/new-output",
    "> escape/new-output",
    "mkdir escape/new-directory",
    "touch escape/new-directory/leaf",
    "cp input escape/new-output",
    "cat input | cat > escape/new-output",
    "{ echo hi; uname; } > escape/new-output",
    "echo $(cat escape/secret)",
    "cat escape/missing",
    "cp -t escape input",
    "head escape/secret",
    "tail escape/secret",
    "cat -- --",
    "cp -- -- output",
    "grep secret escape/secret",
    "grep -R secret escape",
    "dd if=escape/secret of=escape/new-output",
    "custom --config=escape",
    "chmod u=rw escape/secret",
    "chmod -w escape/secret",
    "chmod -R -x escape",
    "chmod -- -wx escape/secret",
    "touch escape/new=file",
    "mkdir escape/new=directory",
    "cp input escape/new=file",
  ])("checks paths in %s", async (command) => {
    const { directories } = await analyze(command)
    expect(
      directories.some(
        (directory) =>
          directory === outside || directory.startsWith(`${outside}/`),
      ),
    ).toBe(true)
  })

  test("checks generic visible paths and flag values", async () => {
    expect(
      (await analyze(`custom --output=${quote(`${outside}/new`)}`)).directories,
    ).toEqual([outside])
    expect(
      (await analyze(`custom ${quote(`${outside}/secret`)}`)).directories,
    ).toEqual([outside])
    expect(
      (await analyze(`chmod --reference=${quote(`${outside}/secret`)} input`))
        .directories,
    ).toEqual([outside])
  })

  test("checks bare home arguments of generic commands", async () => {
    const home = process.env.HOME
    process.env.HOME = outside
    try {
      expect((await analyze("grep -R secret ~")).directories).toEqual([outside])
    } finally {
      if (home === undefined) delete process.env.HOME
      else process.env.HOME = home
    }
  })

  test.each([
    "cat dangling",
    "touch dangling",
    "> dangling",
    "touch dangling/leaf",
    "cat loop",
    "touch loop/leaf",
    "custom /tmp/$UNKNOWN",
  ])("rejects unresolved filesystem access %s", async (command) => {
    await expect(analyze(command)).rejects.toThrow()
  })

  test("bounds total symlink traversal, not just recursion depth", async () => {
    await expect(analyze("cat chain0")).rejects.toThrow(
      "too many symbolic link hops",
    )
  })

  test("retains redirected command source and descriptor redirects", async () => {
    expect((await analyze("echo hi > output 2>&1")).patterns).toEqual([
      "echo hi > output 2>&1",
    ])
    expect((await analyze("cat input")).directories).toEqual([])
    expect((await analyze("chmod +x input")).directories).toEqual([])
  })
})

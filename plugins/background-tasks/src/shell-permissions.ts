import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { canonicalPath, isInside } from "@macarons/permission-rules"
import {
  type Command,
  type Node,
  type ParsedScript,
  parse,
  type Redirect,
  type Word,
  type WordPart,
} from "unbash"

const FILES = new Set([
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  "head",
  "tail",
])
const PRINT = new Set(["echo", "printf", ":"])
const PATH_FLAGS = new Set([
  "--output",
  "--file",
  "--directory",
  "--path",
  "--target-directory",
  "--reference",
  "-o",
  "-C",
  "-t",
])
const CWD = new Set(["cd", "chdir", "pushd", "popd"])
const STATE = new Set([
  "eval",
  ".",
  "source",
  "alias",
  "unalias",
  "set",
  "export",
  "readonly",
  "unset",
  "read",
  "getopts",
  "hash",
  "enable",
  "builtin",
  "local",
  "typeset",
  "declare",
  "let",
  "mapfile",
  "readarray",
  "shopt",
  "history",
  "fc",
  "bind",
  "complete",
  "compgen",
  "compopt",
  "wait",
  // These launchers need their own option grammar before we can check children.
  "ionice",
  "taskset",
  "chrt",
  "sudo",
  "doas",
  "setsid",
  "stdbuf",
  "xargs",
  "watch",
])
// Basename matching deliberately fails closed for non-shell name collisions too.
const SHELLS = new Set([
  "sh",
  "bash",
  "dash",
  "ash",
  "zsh",
  "ksh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
])

function reject(reason: string): never {
  throw new Error(`Cannot safely analyze background command: ${reason}`)
}

type Value = { value: string; dynamic: boolean; glob?: number }

/** Analyze only; never invoke a shell, expand variables, or execute substitutions. */
export async function analyzeShellCommand(
  command: string,
  workdir: string,
  root: string,
  shell: string,
): Promise<{ patterns: string[]; directories: string[] }> {
  if (process.platform === "win32" || shell !== "/bin/sh")
    reject("only the POSIX /bin/sh shell is supported")
  const patterns = new Set<string>()
  const directories = new Set<string>()
  let budget = 10_000

  // Resolve components before '..': path.resolve alone would erase symlink hops.
  async function physical(
    file: string,
    base: string,
    links = { count: 0 },
  ): Promise<string> {
    let current = path.isAbsolute(file) ? path.parse(file).root : base
    for (const segment of file.split("/")) {
      tick()
      if (!segment || segment === ".") continue
      const next = path.join(current, segment)
      if (
        next === "/proc" ||
        next === "/dev/fd" ||
        /^\/dev\/std(?:in|out|err)$/.test(next)
      )
        reject("process-relative filesystem paths cannot be safely resolved")
      const entry = await fs
        .lstat(next)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
      if (entry?.isSymbolicLink()) {
        if (++links.count > 40) reject("too many symbolic link hops")
        // Inspect link targets before realpath erases process-relative aliases.
        current = await physical(await fs.readlink(next), current, links)
        await fs.stat(current).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT")
            reject(`dangling symlink in path: ${next}`)
          throw error
        })
      } else current = await canonicalPath(next)
    }
    return current
  }
  const realRoot = await physical(root, process.cwd())
  const cwd = await physical(workdir, process.cwd())
  try {
    if (!(await fs.stat(cwd)).isDirectory())
      reject("workdir is not a directory")
  } catch (error) {
    // Preserve the launcher's existing missing-workdir error; other stat failures
    // (including dangling links, already rejected above) must not bypass checks.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (!isInside(realRoot, cwd)) directories.add(cwd)

  async function location(word: Word, item: Value, existingOnly: boolean) {
    if (item.dynamic) reject(`unresolved path ${word.text}; use a literal path`)
    let file = item.value
    if (!file) {
      if (existingOnly) return
      reject("empty path")
    }
    if (word.text.startsWith("~")) {
      if (word.text !== "~" && !word.text.startsWith("~/"))
        reject("quoted or named-user home expansion is unsupported")
      file = (process.env.HOME || os.homedir()) + file.slice(1)
    }
    // A fixed glob prefix misses matched symlinks and more-specific path denies.
    if (item.glob !== undefined)
      reject("wildcard paths require literal operands")
    let real: string
    try {
      real = await physical(file, cwd)
    } catch (error) {
      if (
        existingOnly &&
        (error as NodeJS.ErrnoException).code === "ENAMETOOLONG"
      )
        return
      throw error
    }
    let directory: string
    try {
      directory = (await fs.stat(real)).isDirectory()
        ? real
        : path.dirname(real)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      if (existingOnly) return
      directory = path.dirname(real)
    }
    if (!isInside(realRoot, directory)) directories.add(directory)
  }

  function tick() {
    if (--budget < 0) reject("command is too complex")
  }

  function words(parts: WordPart[], source: string, quoted = false): Value {
    const result: Value = { value: "", dynamic: false }
    for (const part of parts) {
      tick()
      let item: Value
      switch (part.type) {
        case "Literal": {
          let glob: number | undefined
          let length = 0
          for (let i = 0; i < part.text.length; i++) {
            if (part.text[i] === "\\") {
              if (++i === part.text.length) reject("trailing escape")
              if (part.text[i] !== "\n") length++
            } else {
              if (
                !quoted &&
                glob === undefined &&
                /[?*[]/.test(part.text.charAt(i))
              )
                glob = length
              length++
            }
          }
          item = { value: part.value, dynamic: false, glob }
          break
        }
        case "SingleQuoted":
          item = { value: part.value, dynamic: false }
          break
        case "DoubleQuoted":
          item = words(part.parts, source, true)
          break
        case "CommandExpansion":
          script(part.script, source)
          item = { value: part.text, dynamic: true }
          break
        case "SimpleExpansion":
          item = { value: part.text, dynamic: true }
          break
        case "ParameterExpansion":
          // unbash treats single quotes inside a double-quoted ${...} operand
          // as inert, unlike /bin/sh; even outer command boundaries can differ.
          return reject(
            "parameter expansion cannot be safely parsed; use literal arguments",
          )
        default:
          reject(`unsupported word syntax ${part.type}`)
      }
      if (result.glob === undefined && item.glob !== undefined)
        result.glob = result.value.length + item.glob
      result.value += item.value
      result.dynamic ||= item.dynamic
    }
    return result
  }

  function wordValue(word: Word, source: string): Value {
    // parts is a lazy, non-enumerable getter. Reading object keys misses commands.
    return words(
      word.parts ?? [{ type: "Literal", value: word.value, text: word.text }],
      source,
    )
  }

  function addPath(word: Word, value: Value, existingOnly = false) {
    // Defer filesystem work until the complete syntax tree has been accepted.
    pendingPaths.push({ word, value, existingOnly })
  }
  const pendingPaths: { word: Word; value: Value; existingOnly: boolean }[] = []

  function redirects(items: Redirect[], source: string, standalone = false) {
    for (const item of items) {
      if (item.variableName || !item.target)
        reject("unsupported or missing redirect target")
      if (![">", ">>", "<", "<>", ">|", "<&", ">&"].includes(item.operator))
        reject(`unsupported redirect ${item.operator}`)
      const value = wordValue(item.target, source)
      if (value.dynamic || value.glob !== undefined)
        reject("unresolved redirect target")
      if (item.operator === "<&" || item.operator === ">&") {
        if (!/^(?:[0-9]+|-)$/.test(value.value))
          reject("unsupported descriptor redirect")
      } else addPath(item.target, value)
      if (standalone) patterns.add(source.slice(item.pos, item.end))
    }
  }

  function executable(node: Command, source: string) {
    tick()
    if (node.prefix.length)
      reject(
        "environment assignments are unsupported; pass a literal command without assignments",
      )
    const raw = source.slice(node.pos, node.end)
    if (raw) patterns.add(raw)
    redirects(node.redirects, source)
    if (!node.name) return
    const name = wordValue(node.name, source)
    if (
      name.dynamic ||
      name.glob !== undefined ||
      node.name.text.startsWith("~") ||
      !name.value
    )
      reject(
        "executable name must be literal; quote wildcard characters such as '['",
      )
    const binary = path.basename(name.value)
    const tail = source.slice(node.name.end, node.end)
    if (name.value !== node.name.text || node.pos !== node.name.pos)
      patterns.add(name.value + tail)
    if (binary !== name.value) {
      patterns.add(binary + tail)
      addPath(node.name, name)
    }
    if (CWD.has(binary))
      reject(
        "cwd changes are unsupported; use the workdir argument instead of cd/pushd/popd",
      )
    if (STATE.has(binary))
      reject(`shell state or indirect execution via ${binary} is unsupported`)
    const args = node.suffix.map((word) => wordValue(word, source))
    if (
      binary === "find" &&
      args.some((arg) => /^-(?:exec|execdir|ok|okdir)$/.test(arg.value))
    )
      reject("find execution actions are unsupported")
    if (binary === "printf") {
      const format = args[args[0]?.value === "--" ? 1 : 0]
      if (
        !format ||
        format.dynamic ||
        format.glob !== undefined ||
        args[0]?.value.startsWith("-v")
      )
        reject(
          "printf requires a literal format and cannot assign shell variables",
        )
      // Bash-backed /bin/sh exposes %n (variable assignment), not just printing.
      for (let i = 0; i < format.value.length; i++) {
        if (format.value[i] !== "%") continue
        const conversion =
          /^%(?:%|[-+ #0']*(?:\d+|\*)?(?:\.(?:\d+|\*))?[hlLjzt]*[diouxXfFeEgGaAcsbq])/.exec(
            format.value.slice(i),
          )
        if (!conversion) reject("unsupported printf format conversion")
        i += conversion[0].length - 1
      }
    }
    if (
      ["exec", "command", "env", "nohup", "nice", "timeout"].includes(binary)
    ) {
      let start = 0
      if (binary === "nice" && args[0]?.value === "-n") {
        const adjustment = args[1]
        if (
          !adjustment ||
          adjustment.dynamic ||
          adjustment.glob !== undefined ||
          !/^[+-]?\d+$/.test(adjustment.value)
        )
          reject("nice -n requires a literal integer adjustment")
        start = 2
      }
      if (args[start]?.value === "--") start++
      if (binary === "timeout") {
        const duration = args[start++]
        if (
          !duration ||
          duration.dynamic ||
          duration.glob !== undefined ||
          !/^(?:\d+(?:\.\d*)?|\.\d+)[smhd]?$/.test(duration.value)
        )
          reject("use timeout [--] DURATION COMMAND without timeout options")
      }
      const first = args[start]
      if (
        !first ||
        first.dynamic ||
        first.value.startsWith("-") ||
        first.value.includes("=")
      )
        reject(
          `unsupported ${binary} wrapper; use a literal executable without wrapper options or assignments`,
        )
      const inner = node.suffix[start] ?? reject("missing wrapper executable")
      executable(
        {
          ...node,
          pos: inner.pos,
          name: inner,
          suffix: node.suffix.slice(++start),
          redirects: [],
        },
        source,
      )
      return
    }
    if (SHELLS.has(binary)) {
      if (
        (name.value !== "sh" && name.value !== "/bin/sh") ||
        args.length !== 2 ||
        args[0]?.value !== "-c" ||
        args.some((arg) => arg.dynamic || arg.glob !== undefined)
      )
        reject(
          "only literal sh -c 'script' without additional arguments is supported",
        )
      const inner = args[1]?.value ?? reject("missing shell script")
      script(parse(inner), inner)
      return
    }
    if (binary === "trap") {
      if (
        !args[0] ||
        !["", "-"].includes(args[0].value) ||
        args.some((arg) => arg.dynamic || arg.glob !== undefined)
      )
        reject("only literal empty/reset trap actions are supported")
      return
    }
    if (PRINT.has(binary)) return
    if (args.some((arg) => arg.dynamic || arg.glob !== undefined))
      reject(
        "unresolved command arguments may contain paths; use literal arguments",
      )
    let flags = true
    let pathFlag = false
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? reject("missing argument")
      const word = node.suffix[i] ?? reject("missing argument word")
      if (pathFlag) {
        addPath(word, arg)
        pathFlag = false
        continue
      }
      if (flags && arg.value === "--") {
        flags = false
        continue
      }
      const flag = flags && arg.value.startsWith("-")
      if (
        flag &&
        !arg.value.startsWith("--") &&
        arg.value.length > 2 &&
        !(binary === "rm" && /^-[rRf]+$/.test(arg.value))
      )
        reject(
          "attached short options cannot be safely analyzed; separate options and paths",
        )
      const equal = arg.value.indexOf("=")
      if (!flag && equal >= 0) {
        // Programs such as dd interpret key=value as a path; other programs may
        // treat the complete token as a filename. Check both possible operands.
        addPath(
          word,
          arg,
          !FILES.has(binary) &&
            !arg.value.includes("/") &&
            !arg.value.startsWith("~"),
        )
        const value = arg.value.slice(equal + 1)
        if (value.startsWith("~"))
          reject("ambiguous home expansion in option value")
        if (value)
          addPath(word, { value, dynamic: false }, !value.includes("/"))
        continue
      }
      const knownPathFlag =
        flag &&
        PATH_FLAGS.has(equal >= 0 ? arg.value.slice(0, equal) : arg.value)
      if (knownPathFlag && equal < 0) {
        if (!args[i + 1]) reject("missing path flag value")
        pathFlag = true
        continue
      }
      const visible = equal >= 0 ? arg.value.slice(equal + 1) : arg.value
      const pathlike = visible.includes("/") || visible.startsWith("~")
      if (
        (!flag && FILES.has(binary)) ||
        pathlike ||
        knownPathFlag ||
        (FILES.has(binary) && equal >= 0)
      ) {
        if (equal >= 0) {
          if (arg.dynamic || arg.glob !== undefined)
            reject("unresolved path flag value")
          if (visible.startsWith("~"))
            reject("ambiguous home expansion in option value")
          addPath(word, { value: visible, dynamic: false })
        } else addPath(word, arg)
      } else if (!flag) addPath(word, arg, true)
      else if (equal >= 0 && visible)
        addPath(word, { value: visible, dynamic: false }, true)
    }
  }

  function visit(node: Node, source: string) {
    tick()
    switch (node.type) {
      case "Statement":
        redirects(node.redirects, source, true)
        visit(node.command, source)
        return
      case "Command":
        executable(node, source)
        return
      case "Pipeline":
        if (node.time || node.operators.some((operator) => operator !== "|"))
          reject("unsupported pipeline dialect")
        // Negation changes only exit status, not which executable needs a grant.
        for (const child of node.commands) visit(child, source)
        return
      case "AndOr":
      case "CompoundList":
        if (!node.commands.length) reject("empty compound command")
        for (const child of node.commands) visit(child, source)
        return
      case "Subshell":
      case "BraceGroup":
        visit(node.body, source)
        return
      case "If":
        visit(node.clause, source)
        visit(node.then, source)
        if (node.else) visit(node.else, source)
        return
      case "While":
        visit(node.clause, source)
        visit(node.body, source)
        return
      case "For":
        // Bash special variables (e.g. RANDOM) can evaluate assignments as code.
        if (!/^[a-z_][a-z0-9_]*$/.test(node.name.text))
          reject("loop variables must use ordinary lowercase names")
        for (const word of node.wordlist) wordValue(word, source)
        visit(node.body, source)
        return
      default:
        reject(`unsupported shell construct ${node.type}`)
    }
  }

  function script(parsed: ParsedScript | undefined, source: string) {
    tick()
    if (parsed?.type !== "Script" || parsed.errors?.length)
      reject(
        `invalid shell syntax${parsed?.errors?.[0] ? `: ${parsed.errors[0].message}` : ""}`,
      )
    source = parsed.source ?? source
    if (source.includes("\0")) reject("NUL is not valid shell input")
    // The parser can classify an expansion split by a continuation as literal.
    if (/\\\r?\n/.test(source))
      reject("line continuations cannot be safely parsed")
    for (const node of parsed.commands) visit(node, source)
    if (parsed.errors?.length) reject("invalid nested shell syntax")
  }

  script(parse(command), command)
  for (const item of pendingPaths)
    await location(item.word, item.value, item.existingOnly)
  return { patterns: [...patterns], directories: [...directories] }
}

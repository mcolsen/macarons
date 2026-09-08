import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

type Step = {
  id?: string
  run?: string
  if?: string
  with?: Record<string, unknown>
}

const workflow = Bun.YAML.parse(
  readFileSync(
    path.resolve(
      import.meta.dir,
      "../../../.github/workflows/bump-opencode.yml",
    ),
    "utf8",
  ),
) as {
  env: { BRANCH: string }
  jobs: {
    bump: { steps: Step[]; outputs: Record<string, string> }
    "dispatch-ci": { needs: string; if: string; steps: Step[] }
  }
}
const reconcile = workflow.jobs.bump.steps.find((step) => step.id === "pr")!
const publish = workflow.jobs.bump.steps.find((step) => step.id === "publish")!
const base = "a".repeat(40)
const head = "b".repeat(40)
const title = "Bump pinned OpenCode to 1.18.15"
const openPr = {
  number: 42,
  title,
  headRepositoryOwner: { login: "mcolsen" },
}

function runStep(
  step: Step,
  options: {
    openPrs?: unknown[]
    closedPrs?: unknown[]
    commits?: { authors: { login?: string | null }[] }[]
    comparison?: unknown
    compareStatus?: number
    action?: "create" | "update"
    expectedHead?: string
    remoteHead?: string
  } = {},
) {
  const expressions: Record<string, string> = {
    "steps.versions.outputs.latest": "1.18.15",
    "steps.versions.outputs.pinned": "1.18.14",
    "steps.pr.outputs.action": options.action ?? "update",
    "steps.pr.outputs.number": "42",
    "steps.pr.outputs.head": options.expectedHead ?? head,
  }
  const script = step.run!.replace(
    /\$\{\{\s*(.*?)\s*\}\}/g,
    (_, key: string) => {
      const value = expressions[key]
      if (value === undefined) throw new Error(`Unmocked expression: ${key}`)
      return value
    },
  )
  const dir = mkdtempSync(path.join(tmpdir(), "macarons-bump-policy-"))
  const output = path.join(dir, "output")
  const calls = path.join(dir, "calls")
  writeFileSync(output, "")
  writeFileSync(calls, "")
  try {
    // Execute the actual workflow scripts, but never reach GitHub or mutate
    // a repository. Unknown gh/git commands fail closed, without a fallback.
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `
        gh() {
          printf 'gh %s\\n' "$*" >> "$MOCK_CALLS"
          case "$*" in
            "pr list --head $BRANCH --state open --json number,title,headRepositoryOwner")
              printf '%s\\n' "$MOCK_OPEN_PRS" ;;
            "pr list --head $BRANCH --state closed --json title,mergedAt,headRepositoryOwner")
              printf '%s\\n' "$MOCK_CLOSED_PRS" ;;
            "pr view 42 --json headRefOid,commits")
              printf '%s\\n' "$MOCK_DETAILS" ;;
            "api repos/$GITHUB_REPOSITORY/compare/$MOCK_BASE...$MOCK_HEAD")
              printf '%s\\n' "$MOCK_COMPARISON"
              return "$MOCK_COMPARE_STATUS" ;;
            "auth setup-git" | "pr edit 42 --title "* | "pr create --base main --head $BRANCH --title "*) ;;
            "workflow run ci.yml --repo $GITHUB_REPOSITORY --ref $BRANCH") ;;
            *) printf 'Unexpected gh command: %s\\n' "$*" >&2; return 90 ;;
          esac
        }
        git() {
          printf 'git %s\\n' "$*" >> "$MOCK_CALLS"
          case "$*" in
            "rev-parse HEAD") printf '%s\\n' "$MOCK_BASE" ;;
            "ls-files --others --exclude-standard") ;;
            "ls-files "*) printf 'package.json\\n' ;;
            "diff --quiet") ;;
            "diff --cached --quiet") return 1 ;;
            "config user."* | "switch -c $BRANCH" | "add -- "* | "commit -m "*) ;;
            "push --force-with-lease=refs/heads/$BRANCH:$MOCK_REMOTE_HEAD origin HEAD:refs/heads/$BRANCH") ;;
            "push "*) printf 'Push lease rejected\\n' >&2; return 1 ;;
            *) printf 'Unexpected git command: %s\\n' "$*" >&2; return 90 ;;
          esac
        }
        ${script}
        `,
      ],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          BRANCH: workflow.env.BRANCH,
          OWNER: "mcolsen",
          GITHUB_REPOSITORY: "mcolsen/macarons",
          GITHUB_OUTPUT: output,
          MOCK_CALLS: calls,
          MOCK_BASE: base,
          MOCK_HEAD: head,
          MOCK_OPEN_PRS: JSON.stringify(options.openPrs ?? [openPr]),
          MOCK_CLOSED_PRS: JSON.stringify(options.closedPrs ?? []),
          MOCK_DETAILS: JSON.stringify({
            headRefOid: head,
            commits: options.commits ?? [
              { authors: [{ login: "github-actions[bot]" }] },
            ],
          }),
          MOCK_COMPARISON: JSON.stringify(
            options.comparison ?? { behind_by: 0 },
          ),
          MOCK_COMPARE_STATUS: String(options.compareStatus ?? 0),
          MOCK_REMOTE_HEAD: options.remoteHead ?? head,
        },
      },
    )
    if (result.error) throw result.error
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      outputs: Object.fromEntries(
        readFileSync(output, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("=")),
      ) as Record<string, string>,
      calls: readFileSync(calls, "utf8"),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("nightly OpenCode bump policy", () => {
  test("refreshes and retests a same-title PR missing commits from the checked-out base", () => {
    const result = runStep(reconcile, { comparison: { behind_by: 2 } })
    expect(result).toMatchObject({
      status: 0,
      outputs: { action: "update", number: "42", head },
    })
    expect(result.calls).toContain(
      `gh api repos/mcolsen/macarons/compare/${base}...${head}`,
    )
    const published = runStep(publish, { expectedHead: result.outputs.head })
    expect(published).toMatchObject({
      status: 0,
      outputs: { "dispatch-ci": "true" },
    })
    expect(published.calls).toContain(`gh pr edit 42 --title ${title}`)
    expect(published.calls).not.toContain("gh pr create")
    expect(runStep(workflow.jobs["dispatch-ci"].steps[0]!)).toMatchObject({
      status: 0,
      calls: `gh workflow run ci.yml --repo mcolsen/macarons --ref ${workflow.env.BRANCH}\n`,
    })
  })

  test("skips a same-title PR that already includes the checked-out base", () => {
    const result = runStep(reconcile)
    expect(result).toMatchObject({ status: 0, outputs: { action: "skip" } })
    expect(result.outputs.head).toBeUndefined()
    expect(result.outputs["dispatch-ci"]).toBeUndefined()
  })

  test.each([
    ["human author", [{ login: "contributor" }]],
    [
      "human coauthor",
      [{ login: "github-actions[bot]" }, { login: "contributor" }],
    ],
    ["unknown author", [{ login: null }]],
    ["unknown coauthor", [{ login: "github-actions[bot]" }, { login: null }]],
    ["unattributed coauthor", [{ login: "github-actions[bot]" }, {}]],
    ["missing login", [{}]],
    ["missing authors", []],
  ])("preserves branches with %s on either refresh path", (_, authors) => {
    for (const proposedTitle of [title, "Bump pinned OpenCode to 1.18.14"]) {
      const result = runStep(reconcile, {
        openPrs: [{ ...openPr, title: proposedTitle }],
        comparison: { behind_by: 1 },
        commits: [{ authors: [{ login: "github-actions[bot]" }] }, { authors }],
      })
      expect(result).toMatchObject({ status: 0, outputs: { action: "skip" } })
      expect(result.stdout).toContain("carries non-bot commits")
      expect(result.outputs.head).toBeUndefined()
    }
  })

  test.each([
    ["empty commit list", []],
    [
      "potentially truncated commit list",
      Array.from({ length: 100 }, () => ({
        authors: [{ login: "github-actions[bot]" }],
      })),
    ],
    [
      "potentially truncated author list",
      [
        {
          authors: Array.from({ length: 100 }, () => ({
            login: "github-actions[bot]",
          })),
        },
      ],
    ],
  ])("preserves branches with %s", (_, commits) => {
    for (const proposedTitle of [title, "Bump pinned OpenCode to 1.18.14"]) {
      expect(
        runStep(reconcile, {
          openPrs: [{ ...openPr, title: proposedTitle }],
          comparison: { behind_by: 1 },
          commits,
        }),
      ).toMatchObject({ status: 0, outputs: { action: "skip" } })
    }
  })

  test("still refreshes an older-version bot PR without a base change", () => {
    const result = runStep(reconcile, {
      openPrs: [{ ...openPr, title: "Bump pinned OpenCode to 1.18.14" }],
      commits: [{ authors: [{ login: "github-actions" }] }],
    })
    expect(result).toMatchObject({
      status: 0,
      outputs: { action: "update", number: "42", head },
    })
    expect(result.calls).not.toContain("gh api")
  })

  test.each([
    { comparison: { behind_by: 1 }, compareStatus: 1 },
    { comparison: {} },
    { comparison: { behind_by: "unknown" } },
  ])("fails closed if the base comparison fails: %j", (options) => {
    const result = runStep(reconcile, options)
    expect(result.status).not.toBe(0)
    expect(result.outputs).toEqual({})
  })

  test("does not publish or dispatch CI if the guarded head changes before push", () => {
    const result = runStep(publish, { remoteHead: "c".repeat(40) })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Push lease rejected")
    expect(result.calls).toContain(
      `git push --force-with-lease=refs/heads/${workflow.env.BRANCH}:${head} origin HEAD:refs/heads/${workflow.env.BRANCH}`,
    )
    expect(result.calls).not.toContain("gh pr edit")
    expect(result.outputs).toEqual({})
  })

  test("ignores fork PRs and still respects same-repo rejected versions", () => {
    const rejected = { ...openPr, mergedAt: null }
    const fork = { ...rejected, headRepositoryOwner: { login: "outsider" } }
    expect(
      runStep(reconcile, { openPrs: [fork], closedPrs: [fork] }),
    ).toMatchObject({ status: 0, outputs: { action: "create" } })
    expect(
      runStep(reconcile, { openPrs: [fork], closedPrs: [rejected] }),
    ).toMatchObject({ status: 0, outputs: { action: "skip" } })
  })

  test("creates only on an absent branch, never overwriting an uninspected orphan", () => {
    const result = runStep(publish, {
      action: "create",
      expectedHead: "",
      remoteHead: "",
    })
    expect(result).toMatchObject({
      status: 0,
      outputs: { "dispatch-ci": "true" },
    })
    expect(result.calls).toContain("gh pr create --base main")
    const orphan = runStep(publish, { action: "create", expectedHead: "" })
    expect(orphan.status).toBe(1)
    expect(orphan.calls).not.toContain("gh pr create")
    expect(orphan.outputs).toEqual({})
  })

  test("wires refreshes through rebuilding on main, publishing, and CI dispatch", () => {
    expect(workflow.jobs.bump.steps[0]!.with).toMatchObject({ ref: "main" })
    const refreshSteps = workflow.jobs.bump.steps.slice(3)
    expect(refreshSteps).toHaveLength(5)
    for (const step of refreshSteps) {
      expect(step.if).toBe(
        "steps.versions.outputs.bump == 'true' && steps.pr.outputs.action != 'skip'",
      )
    }
    expect(workflow.jobs.bump.outputs["dispatch-ci"]).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression, not JavaScript interpolation.
      "${{ steps.publish.outputs.dispatch-ci }}",
    )
    expect(workflow.jobs["dispatch-ci"]).toMatchObject({
      needs: "bump",
      if: "needs.bump.outputs.dispatch-ci == 'true'",
    })
  })
})

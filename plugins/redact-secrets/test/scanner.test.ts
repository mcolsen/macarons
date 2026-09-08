import { describe, expect, test } from "bun:test"
import { RULES } from "../src/engine/rules.generated"
import {
  CHUNK_OVERLAP,
  canExceedOverlap,
  keywordsIn,
  maxMatchLength,
  scanContent,
  shannonEntropy,
} from "../src/engine/scanner"
import type { RuleData } from "../src/engine/types"

// Every fixture value is fake: shape-valid for its rule but never a live
// credential. Where a rule's own filter would allowlist a value (AWS's
// documentation key), that behavior is asserted rather than worked around.

const FAKE = {
  githubPat: "ghp_x7K2mQ9pL4vN8rT3wY6bJ1hF5dS0aZcE2gUq",
  awsKeyId: "AKIAQ3ZK7P2M4XVJ5TR6",
  awsSecret: "x7K2mQ9pL4vN8rT3wY6bJ1hF5dS0aZcE2gUq9w3e",
  generic: "x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce",
}

describe("detection", () => {
  test("github fine-grained shapes and classic PATs are found with exact spans", () => {
    const content = `export GITHUB_TOKEN=${FAKE.githubPat} # deploy`
    const findings = scanContent(content)
    expect(findings.length).toBe(1)
    const finding = findings[0]
    if (!finding) throw new Error("expected a finding")
    expect(finding.ruleId).toBe("github-pat")
    expect(content.slice(finding.start, finding.end)).toBe(FAKE.githubPat)
  })

  test("aws access key id is found; the upstream-allowlisted docs example is not", () => {
    expect(
      scanContent(`aws_access_key_id = ${FAKE.awsKeyId}`).map((f) => f.ruleId),
    ).toContain("aws-access-token")
    expect(scanContent("aws_access_key_id = AKIAIOSFODNN7EXAMPLE")).toEqual([])
  })

  test("a lone aws secret access key is redactable (re-enabled aux rule)", () => {
    const findings = scanContent(`aws_secret_access_key = "${FAKE.awsSecret}"`)
    expect(findings.map((f) => f.ruleId)).toContain("aws-secret-access-key")
  })

  test("private key blocks spanning lines are found", () => {
    const pem = [
      "-----BEGIN EC PRIVATE KEY-----",
      "MIIEx7K2mQ9pL4vN8rT3wY6bJ1hF5dS0x7K2mQ9pL4vN8rT3wY6bJ1hF5dS0",
      "aZcE2gUqx7K2mQ9pL4vN8rT3wY6bJ1hF5dS0x7K2mQ9pL4vN8rT3wY6bJ1hF",
      "-----END EC PRIVATE KEY-----",
    ].join("\n")
    expect(scanContent(pem).map((f) => f.ruleId)).toContain("private-key")
  })

  test("multiple occurrences of distinct secrets in one document are all found", () => {
    const content = [
      `token = ${FAKE.githubPat}`,
      "some prose in between",
      `aws_access_key_id=${FAKE.awsKeyId}`,
    ].join("\n")
    const rules = scanContent(content).map((f) => f.ruleId)
    expect(rules).toContain("github-pat")
    expect(rules).toContain("aws-access-token")
  })
})

describe("false-positive suppression", () => {
  test("shell placeholders, booleans, and the alphabet are never findings", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell-style placeholder is the fixture
    expect(scanContent('password = "${SECRET_VAR}"')).toEqual([])
    expect(scanContent('api_key = "false"')).toEqual([])
    expect(
      scanContent('client_secret = "abcdefghijklmnopqrstuvwxyz789012"'),
    ).toEqual([])
  })

  test("low-entropy values fail rule entropy filters", () => {
    expect(scanContent('api_key = "aaaaaaaabbbbbbbbaaaaaaaabbbbbbbb"')).toEqual(
      [],
    )
  })

  test("an inline allow comment does NOT suppress the finding (content must not steer policy)", () => {
    // Upstream honors these markers because a repo's author annotates their
    // own code; here they would let any file or tool output carry a real
    // credential past the scan — and a serialized JSON body is one line, so a
    // single marker would allowlist an entire wire-backstop request.
    expect(
      scanContent(`api_key = "${FAKE.generic}" // gitleaks:allow`).length,
    ).toBe(1)
    expect(
      scanContent(`api_key = "${FAKE.generic}" // betterleaks:allow`).length,
    ).toBe(1)
    expect(scanContent(`api_key = "${FAKE.generic}"`).length).toBe(1)
  })

  test("generic-api-key context suppression: keyboard is not an api key", () => {
    // The generic rule's finding["match"] filter recognizes key(board|code|…)
    // context; the same value behind a real key name is redacted.
    expect(scanContent(`keyboard = "${FAKE.generic}"`)).toEqual([])
    expect(scanContent(`apikey = "${FAKE.generic}"`).length).toBe(1)
  })

  test("match-text filters still see identifier chars BEFORE the keyword (stripped prefix)", () => {
    // The lazy reporting prefix is stripped from rule patterns at vendor time
    // (stripReportingPrefix), but generic-api-key's false-positive list keys
    // on the chars it used to cover — `[Mm]onkey`, `random[_.-]?access`,
    // `primary[_.-]?key` all sit LEFT of the keyword the rule matches on. The
    // scanner re-extends the match over the stripped class before filter
    // evaluation; without that, ordinary code ("monkey_wrench = …",
    // "primary_key = …") would be redacted as generic api keys.
    expect(scanContent(`monkey_wrench = "${FAKE.generic}"`)).toEqual([])
    expect(scanContent(`random_access_key = "${FAKE.generic}"`)).toEqual([])
    expect(scanContent(`primary_key = "${FAKE.generic}"`)).toEqual([])
    // …while a real assignment through the same code path still fires.
    expect(scanContent(`my.prod.api_key = "${FAKE.generic}"`).length).toBe(1)
  })

  test("the leftward match-text extension stops exactly at matchPrefix.max", () => {
    // The extension re-reads at most `max` characters of the stripped lazy
    // prefix — no more. One character too FAR is the dangerous direction: it
    // pulls an extra identifier char into the match text, an allowlist term
    // that should NOT reach can suddenly match, and a real credential is
    // discarded and shipped raw. `max` is read off the generated rule so a
    // re-vendor that changes it re-aims these fixtures instead of rotting.
    // The padding is deliberately long and entirely inside `[\w.-]`: a short
    // pad would let the rule anchor on the `key` inside "monkey" instead of
    // on `api_key`, and the fixture would stop measuring the bound at all.
    const generic = RULES.find((rule) => rule.id === "generic-api-key")
    if (!generic?.matchPrefix) throw new Error("expected a matchPrefix rule")
    const max = generic.matchPrefix.max
    const fixture = (distance: number) =>
      `monkey${"q".repeat(distance - "monkey".length)}api_key = "${FAKE.generic}"`
    // "monkey" begins exactly `max` chars before the keyword: still inside
    // the window, so the allowlist term is seen and the finding is dropped.
    expect(scanContent(fixture(max))).toEqual([])
    // One char further out it is NOT reachable, so this is an ordinary
    // assignment and the credential must be redacted. Asserting the rule and
    // the exact span, not just a count: a finding that arrived from some
    // other rule, or one whose span had drifted off the secret, would still
    // satisfy a bare length check while redacting the wrong bytes.
    const beyond = fixture(max + 1)
    const findings = scanContent(beyond)
    expect(findings.map((f) => f.ruleId)).toEqual(["generic-api-key"])
    const finding = findings[0]
    if (!finding) throw new Error("expected a finding")
    expect(beyond.slice(finding.start, finding.end)).toBe(FAKE.generic)
  })

  test("two equal-specificity findings on one span do not suppress each other", () => {
    // Suppression is STRICTLY by specificity: only a MORE specific finding
    // owns a span it contains. 306 of the 307 vendored rules share
    // specificity 100, so identical-span ties are ordinary rather than
    // exotic — here curl-auth-header and github-pat match the very same 40
    // characters. Were the comparison `>=`, each would suppress the other
    // and the span would end up owned by nobody.
    const content = `curl -H "Authorization: token ${FAKE.githubPat}" https://api.github.com`
    const findings = scanContent(content)
    expect(findings.map((f) => f.ruleId).sort()).toEqual([
      "curl-auth-header",
      "github-pat",
    ])
    for (const finding of findings) {
      expect(content.slice(finding.start, finding.end)).toBe(FAKE.githubPat)
    }
  })

  test("higher-specificity rules suppress the generic rule on the same line", () => {
    const findings = scanContent(`secret_token = ${FAKE.githubPat}`)
    expect(findings.map((f) => f.ruleId)).toEqual(["github-pat"])
  })

  test("a standalone credential equal to another secret's substring is NOT suppressed", () => {
    // The second credential's VALUE is the PAT's 36-char suffix — string
    // containment holds, but its span is elsewhere on the line, so it is a
    // separate secret that must survive suppression and be redacted.
    const suffix = FAKE.githubPat.slice(4)
    const content = `token = ${FAKE.githubPat} api_key = "${suffix}"`
    const findings = scanContent(content)
    expect(findings.map((f) => f.ruleId).sort()).toEqual([
      "generic-api-key",
      "github-pat",
    ])
    const generic = findings.find((f) => f.ruleId === "generic-api-key")
    if (!generic) throw new Error("expected a generic finding")
    expect(content.slice(generic.start, generic.end)).toBe(suffix)
    expect(generic.start).toBeGreaterThan(
      content.indexOf(FAKE.githubPat) + FAKE.githubPat.length,
    )
  })

  test("keyword gating: a pattern-shaped value with no keyword nearby stays", () => {
    // Value alone, no assignment keyword for the generic rule and no vendor
    // keyword: nothing runs, nothing found.
    expect(scanContent(FAKE.generic)).toEqual([])
  })
})

describe("scan mechanics", () => {
  test("tiny strings are skipped", () => {
    expect(scanContent("ghp_")).toEqual([])
  })

  test("secrets far past the first chunk are still found with correct offsets", () => {
    const padding = "lorem ipsum dolor sit amet ".repeat(5_000) // ~135KB
    const content = `${padding}\ntoken = ${FAKE.githubPat}\n`
    const findings = scanContent(content)
    expect(findings.length).toBe(1)
    const finding = findings[0]
    if (!finding) throw new Error("expected a finding")
    expect(content.slice(finding.start, finding.end)).toBe(FAKE.githubPat)
  })

  test("a secret longer than the chunk overlap straddling a window seam is still found", () => {
    // A ~8.8KB PEM placed so its BEGIN sits before the first window's end
    // (100,000) and its END after the second window's start (92,000): neither
    // window contains both delimiters, which the pre-fix windowed-only scan
    // missed entirely. Overlong-capable rules now scan the content unchunked.
    const body = "MIIEx7K2mQ9pL4vN8rT3wY6bJ1hF5dS0aZcE2gUq".repeat(220)
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`
    const content = "x".repeat(91_500) + pem + "y".repeat(3_198)
    const findings = scanContent(content)
    expect(findings.map((f) => f.ruleId)).toContain("private-key")
    const finding = findings.find((f) => f.ruleId === "private-key")
    if (!finding) throw new Error("expected a private-key finding")
    expect(finding.start).toBe(91_500)
    expect(content.slice(finding.start, finding.end)).toBe(finding.secret)
  })

  test("a rule keyword in one window still gates in a token in another window (finding)", () => {
    // facebook-access-token gates on the keyword "facebook", which is NOT part
    // of its token pattern. With per-window candidate computation the keyword
    // (start of content) and the token (>100KB later) landed in different
    // windows and the rule ran in NEITHER — zero findings. Candidates now come
    // from the full content, so the token's window runs the rule regardless of
    // where the keyword sits.
    const token = "123456789012345|a1b2c3d4e5f6g7h8i9j0k1l2m3n"
    const content = `# facebook app config\n${"x".repeat(150_000)}\naccess = ${token}\n`
    const findings = scanContent(content).filter(
      (f) => f.ruleId === "facebook-access-token",
    )
    expect(findings.length).toBe(1)
    const finding = findings[0]
    if (!finding) throw new Error("expected a finding")
    expect(content.slice(finding.start, finding.end)).toBe(token)
  })

  test("bounded rules still catch a secret sitting exactly on a window seam", () => {
    // The PAT spans offset 100,000 (the first window's end); the overlap
    // guarantees the second window sees it whole, exactly once.
    const prefix = "z".repeat(99_990)
    const content = `${prefix}token = ${FAKE.githubPat} and padding${"w".repeat(10_000)}`
    const findings = scanContent(content).filter(
      (f) => f.ruleId === "github-pat",
    )
    expect(findings.length).toBe(1)
    const finding = findings[0]
    if (!finding) throw new Error("expected a finding")
    expect(content.slice(finding.start, finding.end)).toBe(FAKE.githubPat)
  })

  test("a clean string cut at a window seam is not a finding (seam artifact)", () => {
    // Adversarially reproduced: a 43-char run after "…|" is NOT a
    // facebook-access-token (no terminator anywhere, so the full content
    // matches nothing) — but when the greedy 40-char cut lands exactly at a
    // window's slice end, the window-local `$` "satisfies" the rule's tail.
    // Matches flush against a cut edge are dropped; the next window re-judges
    // the span with real right-context and correctly finds nothing.
    const digits = "123456789012345"
    const body = "k9w2mq7pl4vn8rt3xy6bj1hf5ds0azcegu2k9w2mq7p" // 43 chars, high entropy
    const token = `${digits}|${body}`
    const start = 100_000 - (digits.length + 1 + 40) // greedy cut ends at 100,000
    const content = `${"x".repeat(start - 1)} ${token} tail ${"y".repeat(60_000)} facebook`
    expect(
      scanContent(content).filter((f) => f.ruleId === "facebook-access-token"),
    ).toEqual([])
  })

  test("a real match whose end lands exactly on a window seam is still found once", () => {
    // The dual of the artifact drop: window 1 drops the edge-touching match,
    // but the overlap puts the same span strictly inside window 2, which
    // reports it exactly once with correct offsets.
    const prefix = "z".repeat(100_000 - 8 - FAKE.githubPat.length)
    const content = `${prefix}token = ${FAKE.githubPat}${"w".repeat(10_000)}`
    const findings = scanContent(content).filter(
      (f) => f.ruleId === "github-pat",
    )
    expect(findings.length).toBe(1)
    const finding = findings[0]
    if (!finding) throw new Error("expected a finding")
    expect(finding.end).toBe(100_000)
    expect(content.slice(finding.start, finding.end)).toBe(FAKE.githubPat)
  })

  test("a real match starting exactly on a window seam is still found once", () => {
    // The start-edge mirror of the pair above: the token begins at the second
    // window's cut start (92,000). Window 2 drops the edge-touching match; the
    // overlap means window 1 saw the same span strictly inside and reports it.
    const content = `${"z".repeat(92_000)}${FAKE.githubPat}${"w".repeat(10_000)}`
    const findings = scanContent(content).filter(
      (f) => f.ruleId === "github-pat",
    )
    expect(findings.length).toBe(1)
    const finding = findings[0]
    if (!finding) throw new Error("expected a finding")
    expect(finding.start).toBe(92_000)
    expect(content.slice(finding.start, finding.end)).toBe(FAKE.githubPat)
  })

  test("a match that only appears because the window slice began mid-token is dropped (cutStart artifact)", () => {
    // The start-edge dual of the cutEnd artifact drop, and the case that pins
    // the `(cutStart && matchStart === 0)` disjunct. facebook-access-token
    // leads with `\b`, so a 15-digit run preceded by a word char has NO
    // boundary in the full content and matches nothing — but window 2's slice
    // begins exactly at the run's first digit, where chunk-position 0 is a
    // string start and `\b` spuriously holds. The seam guard drops that
    // window-local match; the neighbouring (first) window, which sees the run
    // with its real left context, correctly finds nothing. Drop the disjunct
    // and window 2's phantom finding ships as an over-redaction.
    const token = "123456789012345|a1b2c3d4e5f6g7h8i9j0k1l2m3n"
    // A word char at 91,999 immediately precedes the digit run at 92,000, so no
    // `\b` holds before it anywhere in the full string.
    const content = `${"z".repeat(92_000)}${token} ${"y".repeat(10_000)} facebook`
    expect(
      scanContent(content).filter((f) => f.ruleId === "facebook-access-token"),
    ).toEqual([])
  })

  test("an equal-specificity tie across the two passes still reports the secret", () => {
    // The equal-specificity case with teeth. Past CHUNK_SIZE the scan splits
    // into an UNCHUNKED overlong pass (curl-auth-header is unbounded) and a
    // WINDOWED bounded pass (github-pat maxes out at 40 chars), and the two
    // findings — identical span, identical specificity — meet for the first
    // time at the final symmetric containment filter. Neither of the
    // incremental, findings-so-far guards inside scanChunk stands between
    // them there, so a non-strict specificity comparison would filter BOTH
    // out and the PAT would go to the provider RAW. Reproduced: the strict
    // `>` is the only thing holding this shut.
    const filler = "lorem ipsum dolor sit amet ".repeat(5_000) // ~135KB
    const line = `curl -H "Authorization: token ${FAKE.githubPat}" https://api.github.com`
    const content = `${filler}\n${line}\n${filler}`
    const findings = scanContent(content)
    expect(findings.map((f) => f.ruleId).sort()).toEqual([
      "curl-auth-header",
      "github-pat",
    ])
    for (const finding of findings) {
      expect(content.slice(finding.start, finding.end)).toBe(FAKE.githubPat)
    }
  })

  test("contextKeywords gates in a rule whose keyword lives in a sibling string", () => {
    // The cross-string analogue of the cross-window case above: the provider
    // reads all parts of a request as one document, so a keyword in one part
    // must gate rules in another. The regex still has to match this string —
    // context only widens candidate selection.
    const token = "123456789012345|a1b2c3d4e5f6g7h8i9j0k1l2m3n"
    const content = `access = ${token}\n`
    expect(
      scanContent(content).filter((f) => f.ruleId === "facebook-access-token"),
    ).toEqual([])
    const findings = scanContent(content, {
      contextKeywords: new Set(["facebook"]),
    }).filter((f) => f.ruleId === "facebook-access-token")
    expect(findings.length).toBe(1)
    const finding = findings[0]
    if (!finding) throw new Error("expected a finding")
    expect(content.slice(finding.start, finding.end)).toBe(token)
  })

  test("contextKeywords never bypasses disabledRules", () => {
    const token = "123456789012345|a1b2c3d4e5f6g7h8i9j0k1l2m3n"
    const findings = scanContent(`access = ${token}\n`, {
      contextKeywords: new Set(["facebook"]),
      disabledRules: new Set(["facebook-access-token"]),
    })
    expect(
      findings.filter((f) => f.ruleId === "facebook-access-token"),
    ).toEqual([])
  })

  test("disabledRules skips exactly those rules", () => {
    const content = `token = ${FAKE.githubPat}`
    expect(
      scanContent(content, { disabledRules: new Set(["github-pat"]) }).map(
        (f) => f.ruleId,
      ),
    ).not.toContain("github-pat")
    expect(scanContent(content).map((f) => f.ruleId)).toContain("github-pat")
  })
})

describe("scan performance", () => {
  test("keyword-dense content scans in linear time (no catastrophic backtracking)", () => {
    // Regression guard for the vendored lazy reporting prefixes: before they
    // were stripped, `key=` + 1MB of `a` spent ~10s inside
    // aws-secret-access-key's nested `[\w.-]{0,50}?` pair (O(n·bound²)), and
    // the 100KB seam tests alone blew CI's 5s per-test timeout. Post-strip
    // this scans in ~0.1s locally; the bound is deliberately loose for slow
    // CI machines while still failing hard on any quadratic reintroduction.
    const content = `key= secret access token api auth ${"a".repeat(1_000_000)}`
    const started = performance.now()
    const findings = scanContent(content)
    const elapsed = performance.now() - started
    expect(findings).toEqual([])
    expect(elapsed).toBeLessThan(3_000)
  })
})

describe("unicode mode (RE2 rune semantics)", () => {
  test("bounded quantifiers count code points, not UTF-16 units", () => {
    // amplitude's `(?:.|[\n\r]){0,32}?` permits 32 intervening characters —
    // RUNES to RE2. 17 emojis are 17 runes but 34 UTF-16 units, so a
    // non-unicode compile overflowed the bound and the key behind them went
    // to the wire unseen (a reproduced reviewer finding). Unicode mode counts
    // like upstream. Each hex digit appears exactly twice, so entropy is a
    // full 4 bits and the rule's own entropy filter cannot discard it.
    const hex = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
    const content = `amplitude ${"\u{1F40D}".repeat(17)} SECRET ${hex}`
    const findings = scanContent(content)
    expect(
      findings.some(
        (f) => f.ruleId === "amplitude-secret-key" && f.secret === hex,
      ),
    ).toBe(true)
    // Spans stay UTF-16 offsets (what String.slice replaces by).
    const finding = findings.find((f) => f.ruleId === "amplitude-secret-key")
    expect(content.slice(finding?.start, finding?.end)).toBe(hex)
  })

  test("first-position ] in a class keeps its RE2 meaning inside allowlists", () => {
    // curl-auth-user's upstream allowlist `[^:]+:\[[^]]+]` discards
    // bracketed placeholder passwords. RE2 (like POSIX) reads `[^]]` as "any
    // char except ]"; the old non-unicode compile misparsed it as the
    // any-char class `[^]` plus a literal `]`, so the allowlist never
    // matched and placeholders were redacted as if real. The vendor rewrite
    // (`[^\]]`) restores upstream behavior — and real credentials still fire.
    expect(
      scanContent("curl -u 'admin:[YOUR_PASSWORD]' https://api.example.com"),
    ).toEqual([])
    const real = scanContent(
      "curl -u 'admin:hunter2secret' https://api.example.com",
    )
    expect(real.map((f) => f.ruleId)).toContain("curl-auth-user")
  })
})

describe("shannon entropy (byte-based, mirrors exprruntime)", () => {
  test("empty and single-symbol strings have zero entropy", () => {
    expect(shannonEntropy("")).toBe(0)
    expect(shannonEntropy("aaaa")).toBe(0)
  })

  test("uniform two-symbol strings have exactly one bit", () => {
    expect(shannonEntropy("abababab")).toBe(1)
  })
})

// The classifier that decides whether a rule joins the windowed scan or gets an
// unchunked pass. Its two encoded decisions — the `* 2` UTF-16 doubling and the
// `>=` (a bound EXACTLY equal to the overlap must route unchunked so scanChunk's
// seam-artifact drop has strict room) — are behaviour-identical on every shipped
// rule (the widest finite bound is ~4x under the danger band), so ONLY a
// synthetic rule can pin them. Undercounting here silently routes a straddling
// rule onto the windowed path and a seam-spanning secret ships unredacted.
describe("canExceedOverlap classification (chunk-seam safety)", () => {
  const rule = (pattern: string): RuleData => ({
    id: "synthetic",
    pattern,
    flags: "",
    keywords: [],
    specificity: 0,
  })

  test("a bound exactly at CHUNK_OVERLAP/2 code points is overlong (pins the doubling AND the >=)", () => {
    // maxMatchLength counts code points; the classifier doubles to UTF-16 units.
    // CHUNK_OVERLAP/2 code points -> exactly CHUNK_OVERLAP UTF-16 units -> `>=`
    // routes it unchunked. Drop the `* 2` and it reads (CHUNK_OVERLAP/2 >=
    // CHUNK_OVERLAP) === false (misclassified bounded); change `>=` to `>` and
    // (CHUNK_OVERLAP > CHUNK_OVERLAP) === false too. This one case kills both.
    const bound = CHUNK_OVERLAP / 2
    expect(maxMatchLength(`a{${bound}}`)).toBe(bound)
    expect(canExceedOverlap(rule(`a{${bound}}`))).toBe(true)
  })

  test("a bound one code point under CHUNK_OVERLAP/2 stays bounded", () => {
    const bound = CHUNK_OVERLAP / 2 - 1
    expect(canExceedOverlap(rule(`a{${bound}}`))).toBe(false)
  })

  test("an unbounded pattern is overlong", () => {
    expect(canExceedOverlap(rule("a+"))).toBe(true)
  })
})

// A tripwire for rule re-vendoring and parser edits. Only private-key's overlong
// classification is guarded elsewhere (incidentally, by the seam test above);
// this pins the WHOLE partition, so any rule silently flipping between the
// windowed and unchunked paths — an undercount in maxMatchLength, or a new
// upstream rule landing in the danger band — has to be acknowledged here rather
// than shipping a seam-straddling leak unnoticed.
describe("rule classification partition (re-vendor tripwire)", () => {
  const OVERLONG_RULE_IDS = [
    "1password-service-account-token",
    "airtable-oauth-token",
    "azure-app-configuration-connection-string",
    "azure-servicebus-connection-string",
    "azure-storage-account-key",
    "curl-auth-header",
    "curl-auth-user",
    "facebook-page-access-token",
    "flyio-access-token",
    "gcp-application-default-credentials",
    "gcp-service-account",
    "generic-api-key",
    "influxdb-api-token",
    "jwt",
    "jwt-base64",
    "microsoft-teams-webhook",
    "mongodb-connection-string",
    "private-key",
    "slack-app-token",
    "slack-bot-token",
    "slack-legacy-token",
    "slack-session-cookie",
    "yandex-access-token",
  ]

  test("exactly these rule ids take the unchunked (overlong) path", () => {
    const overlong = RULES.filter(canExceedOverlap)
      .map((r) => r.id)
      .sort()
    expect(overlong).toEqual([...OVERLONG_RULE_IDS].sort())
  })

  test("every rule's bound is Infinity or a finite non-negative number", () => {
    for (const r of RULES) {
      const bound = maxMatchLength(r.pattern)
      expect(bound === Infinity || (Number.isFinite(bound) && bound >= 0)).toBe(
        true,
      )
    }
  })
})

// The two commit SHAs from the 2026-07-25 prompt-cache incident: both were
// vaulted as Sourcegraph access tokens, and the retroactive rewrite that
// followed reset the prompt cache in five concurrent sessions at once.
const PR_BASE_SHA = "7c6dcd9f2b1ec7b052ab2d3a2123c586852c65b1"
const PR_HEAD_SHA = "b20e359367f412864ea8c3f1c50e1af52330e5f2"

describe("sourcegraph-access-token bare-hex narrowing", () => {
  const ruleIds = (content: string) =>
    scanContent(content).map((finding) => finding.ruleId)

  test("git SHAs are not secrets even once the gate keyword is in the content", () => {
    const content = [
      "# sourcegraph notes for this review",
      `git diff ${PR_BASE_SHA} ${PR_HEAD_SHA}`,
    ].join("\n")
    expect(ruleIds(content)).not.toContain("sourcegraph-access-token")
  })

  test("a bare 40-hex value on a line naming the vendor is still redacted", () => {
    expect(ruleIds(`SOURCEGRAPH_TOKEN=${PR_BASE_SHA}`)).toContain(
      "sourcegraph-access-token",
    )
  })

  test("both sgp_-prefixed alternatives are untouched by the narrowing", () => {
    expect(ruleIds(`token = sgp_${PR_BASE_SHA}`)).toContain(
      "sourcegraph-access-token",
    )
    expect(ruleIds(`token = sgp_0123456789abcdef_${PR_BASE_SHA}`)).toContain(
      "sourcegraph-access-token",
    )
  })

  test("the canonical authorization layout is kept, vendor name a line above", () => {
    // Sourcegraph's own docs write it exactly this way
    // (https://sourcegraph.com/docs/api/mcp/authentication), so requiring the
    // vendor name on the token's own line missed the standard form outright
    // (audit F7).
    const content = ["Sourcegraph API:", `Authorization: token ${PR_BASE_SHA}`]
    expect(ruleIds(content.join("\n"))).toContain("sourcegraph-access-token")
  })

  test("src CLI token layouts are kept too", () => {
    // The vendor name gates the rule from anywhere in the content; the LINE
    // test is what then has to recognize the credential.
    expect(
      ruleIds(`Sourcegraph setup:\nSRC_ACCESS_TOKEN=${PR_BASE_SHA}`),
    ).toContain("sourcegraph-access-token")
    expect(
      ruleIds(`Sourcegraph setup:\nsrc auth token set ${PR_BASE_SHA}`),
    ).toContain("sourcegraph-access-token")
  })

  test("an auth-form keep does not readmit the incident's git SHAs", () => {
    // The widened keep must recognize credential LAYOUTS, not merely the
    // presence of the word "token" near a hex value.
    const content = [
      "# sourcegraph notes for this review",
      `git diff ${PR_BASE_SHA} ${PR_HEAD_SHA}`,
      `the token for this commit is ${PR_HEAD_SHA}`,
      `base sha: ${PR_BASE_SHA}`,
    ].join("\n")
    expect(ruleIds(content)).not.toContain("sourcegraph-access-token")
  })
})

describe("cross-string keyword admission (keywordPresent)", () => {
  test("a keyword buried inside a longer alphanumeric run is not promoted", () => {
    // Verbatim from the incident's reasoningEncryptedContent blob.
    expect(keywordsIn("bOPA5Vsgf79wZsgp_C-4-GbcYhH9sZDB3E")).not.toContain(
      "sgp_",
    )
  })

  test("a keyword at a line start, separator, or punctuation is promoted", () => {
    expect(keywordsIn(`token: sgp_${PR_BASE_SHA}`)).toContain("sgp_")
    expect(keywordsIn("sgp_abcdef is the prefix")).toContain("sgp_")
    expect(keywordsIn("my_sourcegraph_token = 1")).toContain("sourcegraph")
    expect(keywordsIn("x-sourcegraph-url: https://example")).toContain(
      "sourcegraph",
    )
  })

  test("the per-string gate keeps plain substring semantics", () => {
    // Admission is stricter than matching on purpose: a string carrying its
    // OWN keyword still runs the rule even where promotion would be refused.
    expect(
      scanContent(`xxSOURCEGRAPH_TOKEN=${PR_BASE_SHA}`).map((f) => f.ruleId),
    ).toContain("sourcegraph-access-token")
  })

  test("a camelCase word start promotes its keyword", () => {
    // Case is the only evidence of a word boundary in an identifier, and
    // lowercasing before the boundary test threw it away — so a vendor named
    // in one serialized field stopped gating a bare token in a sibling field
    // (audit F5).
    expect(keywordsIn("myFacebookIntegration")).toContain("facebook")
    expect(keywordsIn("useSourcegraphClient")).toContain("sourcegraph")
    expect(keywordsIn("v2SourcegraphToken")).toContain("sourcegraph")
  })

  test("an all-caps run still counts as one word start", () => {
    expect(keywordsIn("readTWILIOSecret")).toContain("twilio")
  })

  test("camelCase admission is length-gated, so ciphertext stays out", () => {
    // A camel boundary is ~5x weaker than requiring a non-alphanumeric: over a
    // base64 alphabet it needs only an uppercase first letter after a
    // lowercase one. At short keyword lengths that is a real coincidence rate,
    // which is the rate the 2026-07-25 incident rode in on.
    expect(keywordsIn("useAwsSecret")).not.toContain("aws")
    expect(keywordsIn("myApiHelper")).not.toContain("api")
    // The incident's own blob stays rejected under either rule: the `s` of
    // `sgp_` is lowercase there, so no camel boundary exists to admit it.
    expect(keywordsIn("bOPA5Vsgf79wZsgp_C-4-GbcYhH9sZDB3E")).not.toContain(
      "sgp_",
    )
  })

  test("a camelCase vendor name gates a bare token in another string", () => {
    // The end-to-end shape the regression cost: two separate serialized
    // fields, the vendor in one and a shape-valid bare token in the other,
    // which only the cross-string set can connect.
    const context = new Set(keywordsIn("const myTwilioClient = load()"))
    const found = scanContent("SK0123456789abcdef0123456789abcdef ", {
      contextKeywords: context,
    })
    expect(found.map((f) => f.ruleId)).toContain("twilio-api-key")
  })
})

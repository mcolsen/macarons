import { describe, expect, test } from "bun:test"
import {
  BAND_SAMPLE_VERSIONS as BAND,
  validAuthType as libraryValidAuthType,
  validatedAuthStore as libraryValidatedAuthStore,
} from "@macarons/permission-rules"
import {
  COMPACTION_NOTE,
  catalogWireCandidates,
  DEFAULT_OPTIONS,
  dropContentLength,
  FINGERPRINT_MAX_CANDIDATES,
  type FingerprintEntry,
  FingerprintLimitError,
  HistoryPins,
  hasAuthEntry,
  isOpaqueBinaryPayload,
  MAX_VAULT_CHARS,
  MAX_VAULT_SECRETS,
  MAX_WALK_DEPTH,
  MAX_WALK_VISITS,
  MAX_WIRE_BODY_BYTES,
  OPAQUE_PROVIDER_KEYS,
  OversizedBodyError,
  openCodeCompatNotice,
  PLACEHOLDER_RE,
  parseOptions,
  percentDecodeTolerant,
  placeholderFor,
  Redactor,
  redactWireRequest,
  runtimeFlagEnabled,
  SUPPORTED_OPENCODE_RANGE,
  SYSTEM_NOTE,
  secretHash,
  serializeForKeywordSweep,
  UnscannableBodyError,
  unsafeWireProviders,
  VaultLimitError,
  validAuthType,
  validatedAuthStore,
  WalkLimitError,
} from "../src/shared"

const FAKE_PAT = "ghp_x7K2mQ9pL4vN8rT3wY6bJ1hF5dS0aZcE2gUq"

// A fixed installation key so placeholders are reproducible across the fake
// "restarts" these tests model. Production mints a random per-install key; the
// security the key buys is exercised by the cross-key test below.
const KEY = "5ecec0de5ecec0de5ecec0de5ecec0de5ecec0de5ecec0de5ecec0de5ecec0de"
const mk = () => new Redactor(DEFAULT_OPTIONS, KEY)

// Two shape-valid, distinct fake PATs.
const PAT_A = "ghp_d7rzRR3eOrtIEjAnRWkXx7EWuejxOxam2roS"
const PAT_B = "ghp_ifII4xEw2vHHQEL4T75rnkQKiYVuv74gPoLC"

function placeholderOf(redacted: string): string {
  const match = new RegExp(PLACEHOLDER_RE.source).exec(redacted)
  if (!match) throw new Error(`no placeholder in: ${redacted}`)
  return match[0]
}

describe("version guard", () => {
  const R = SUPPORTED_OPENCODE_RANGE
  const notice = (v: string | undefined) =>
    openCodeCompatNotice(v, R, "redact-secrets")

  // Samples derive from the band so the nightly ratchet cannot strand them.
  test("the verified band runs silently (no notice)", () => {
    expect(notice(BAND.floor)).toBeNull()
    expect(notice(BAND.inBand)).toBeNull()
    expect(notice(`${BAND.floor}+sha.abc`)).toBeNull()
  })

  test("any v1 outside the band warns but keeps redacting", () => {
    for (const v of [
      BAND.belowBand,
      BAND.aboveBand,
      `${BAND.floor}-rc.1`,
      "junk",
      undefined,
    ]) {
      const n = notice(v)
      expect(n?.compat).toBe("untested")
      expect(n?.disable).toBe(false)
    }
  })

  test("a non-v1 host (incl. the v2 beta) disables redaction", () => {
    for (const v of ["2.0.0", "2.0.0-beta.1", "0.9.9"]) {
      const n = notice(v)
      expect(n?.compat).toBe("incompatible")
      expect(n?.disable).toBe(true)
    }
  })
})

describe("placeholders", () => {
  test("are deterministic across redactor instances and processes under one key", () => {
    const a = mk().redactString(`token = ${FAKE_PAT}`)
    const b = mk().redactString(`different context, same secret: ${FAKE_PAT}`)
    expect(placeholderOf(a)).toBe(placeholderOf(b))
    expect(placeholderOf(a)).toBe(
      placeholderFor("github-pat", secretHash(FAKE_PAT, KEY)),
    )
  })

  test("a different installation key maps the same secret to a different placeholder", () => {
    // The keyed fingerprint is what stops a placeholder from being an offline
    // oracle and blocks cross-installation correlation: without the local key
    // an observer cannot reproduce the hash, and two installs never agree.
    const one = new Redactor(DEFAULT_OPTIONS, "11".repeat(32)).redactString(
      `t=${FAKE_PAT}`,
    )
    const two = new Redactor(DEFAULT_OPTIONS, "22".repeat(32)).redactString(
      `t=${FAKE_PAT}`,
    )
    expect(placeholderOf(one)).not.toBe(placeholderOf(two))
    expect(placeholderOf(one)).toBe(
      placeholderFor("github-pat", secretHash(FAKE_PAT, "11".repeat(32))),
    )
  })

  test("distinct secrets stay distinct and restore in any registration order", () => {
    // Regression: an earlier design used 8 hash chars with a
    // first-registered-wins collision branch, so re-learning the vault in the
    // opposite order after a restart restored old placeholders to the WRONG
    // secret. The full 16-char fingerprint is order-independent.
    expect(secretHash(PAT_A, KEY)).not.toBe(secretHash(PAT_B, KEY))

    const forward = mk()
    const placeholderA = placeholderOf(forward.redactString(`a=${PAT_A}`))
    const placeholderB = placeholderOf(forward.redactString(`b=${PAT_B}`))
    expect(placeholderA).not.toBe(placeholderB)

    // Restart with reversed registration order: every old placeholder must
    // still restore to its own secret.
    const reversed = mk()
    reversed.redactString(`b=${PAT_B}`)
    reversed.redactString(`a=${PAT_A}`)
    expect(reversed.restoreString(`use ${placeholderA}`)).toBe(`use ${PAT_A}`)
    expect(reversed.restoreString(`use ${placeholderB}`)).toBe(`use ${PAT_B}`)
  })

  test("the system and compaction notes' schematic placeholders never match the real grammar", () => {
    expect(SYSTEM_NOTE).toContain("[REDACTED-SECRET:")
    expect(new RegExp(PLACEHOLDER_RE.source).test(SYSTEM_NOTE)).toBe(false)
    expect(COMPACTION_NOTE).toContain("[REDACTED-SECRET:")
    expect(new RegExp(PLACEHOLDER_RE.source).test(COMPACTION_NOTE)).toBe(false)
  })

  test("collectUnresolved reports only hashes the vault cannot restore", () => {
    const redactor = mk()
    const known = new RegExp(PLACEHOLDER_RE.source).exec(
      redactor.redactString(`x=${FAKE_PAT}`),
    )?.[0] as string
    const unresolved = redactor.collectUnresolved({
      a: `use ${known}`,
      b: ["and [REDACTED-SECRET:github-pat:0123abcd0123abcd] too"],
    })
    expect([...unresolved]).toEqual(["0123abcd0123abcd"])
    expect(redactor.collectUnresolved(`root string ${known}`).size).toBe(0)
  })

  test("learnFrom teaches the vault without producing output", () => {
    const redactor = mk()
    redactor.learnFrom(`GITHUB_TOKEN=${FAKE_PAT}`)
    const placeholder = placeholderFor("github-pat", secretHash(FAKE_PAT, KEY))
    expect(redactor.restoreString(`use ${placeholder}`)).toBe(`use ${FAKE_PAT}`)
  })
})

describe("redact and restore round-trip", () => {
  test("redactString replaces the secret and restoreString brings it back", () => {
    const redactor = mk()
    const original = `export GITHUB_TOKEN=${FAKE_PAT}\necho done`
    const redacted = redactor.redactString(original)
    expect(redacted).not.toContain(FAKE_PAT)
    expect(redacted).toContain("[REDACTED-SECRET:github-pat:")
    expect(redactor.restoreString(redacted)).toBe(original)
  })

  test("unknown placeholders are left untouched", () => {
    const redactor = mk()
    const text = "use [REDACTED-SECRET:github-pat:0123abcd0123abcd] here"
    expect(redactor.restoreString(text)).toBe(text)
  })

  test("the same secret redacts to the same placeholder on every occurrence", () => {
    const redactor = mk()
    const redacted = redactor.redactString(`a=${FAKE_PAT}\nb=${FAKE_PAT}`)
    const first = placeholderOf(redacted)
    expect(redacted.split(first).length - 1).toBe(2)
  })

  test("a fresh redactor learns mappings back from re-scanning content", () => {
    // Restart story: the vault is memory-only, so a new process must be able
    // to restore a placeholder after its next outbound scan of the transcript.
    const first = mk()
    const redacted = first.redactString(`token = ${FAKE_PAT}`)
    const restarted = mk()
    restarted.redactString(`token = ${FAKE_PAT}`) // outbound scan re-learns
    expect(restarted.restoreString(redacted)).toBe(`token = ${FAKE_PAT}`)
  })

  test("redaction counting drives caller notifications", () => {
    const redactor = mk()
    expect(redactor.redactionCount).toBe(0)
    redactor.redactString(`token = ${FAKE_PAT}`)
    expect(redactor.redactionCount).toBe(1)
    expect(redactor.vaultSize).toBe(1)
  })

  test("a cached re-scan counts every secret it contained, not just one", () => {
    // The cache stores content >= 256 chars; a re-scan must re-count each
    // secret so the "N secrets redacted" notification stays accurate.
    const redactor = mk()
    const content = `a=${PAT_A} ${"x".repeat(260)} b=${PAT_B}`
    expect(redactor.redactValueInPlace({ v: content })).toBe(2) // cache miss
    expect(redactor.redactValueInPlace({ v: content })).toBe(2) // cache hit, still 2
  })
})

describe("known-vault exact matching (the restored-secret leak)", () => {
  // A context-gated value: no vendor shape, no keyword of its own, so only
  // its field context ("api_key = …") ever detects it by rule.
  const SECRET = "x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce"

  test("a bare, contextless occurrence of a KNOWN secret is redacted", () => {
    // The reproduced review finding: api_key=<v> → placeholder → the model
    // echoes "- <placeholder>" → text.complete stores "- <raw>" → the next
    // outbound scan saw no rule context and let the raw value through.
    const redactor = mk()
    const keyed = redactor.redactString(`api_key = ${SECRET}`)
    const bare = redactor.redactString(`- ${SECRET}`)
    expect(bare).not.toContain(SECRET)
    expect(placeholderOf(bare)).toBe(placeholderOf(keyed))
    expect(redactor.restoreString(bare)).toBe(`- ${SECRET}`)
  })

  test("a bare occurrence BEFORE the keyworded one in the same string is swept", () => {
    const redactor = mk()
    const out = redactor.redactString(
      `note ${SECRET} came from api_key=${SECRET}`,
    )
    expect(out).not.toContain(SECRET)
    expect(out.match(/\[REDACTED-SECRET:/g)?.length).toBe(2)
  })

  test("rule-origin partial overlaps preserve constituent mappings and sweep a bare occurrence", () => {
    const endMarker = "-----END PRIVATE KEY-----"
    const credential = JSON.stringify(
      `audit225.user:Q7m2v9N4p8R1s6T0${endMarker}suffix!`,
    )
    // The private-key span ends inside the curl argument; neither contains
    // the other. Its earlier bare copy has no curl context to detect it.
    const union = [
      "-----BEGIN PRIVATE KEY-----",
      "Q7m2v9N4p8R1s6T0".repeat(5),
      `curl -u ${credential}`,
    ].join("\n")
    const privateKey = union.slice(
      0,
      union.indexOf(endMarker) + endMarker.length,
    )
    const content = `${credential}\n\n${union}`
    const credentialPlaceholder = placeholderFor(
      "curl-auth-user",
      secretHash(credential, KEY),
    )
    const unionPlaceholder = placeholderFor(
      "private-key",
      secretHash(union, KEY),
    )
    expect(mk().redactString(credential)).toBe(credential)

    const redactor = mk()
    const output = redactor.redactString(content)
    expect(output).toBe(`${credentialPlaceholder}\n\n${unionPlaceholder}`)
    expect(redactor.vaultSize).toBe(3)
    expect(redactor.redactionCount).toBe(2)
    expect(redactor.restoreString(output)).toBe(content)
    expect(redactor.restoreString(credentialPlaceholder)).toBe(credential)
    expect(redactor.restoreString(unionPlaceholder)).toBe(union)
    expect(
      redactor.restoreString(
        placeholderFor("private-key", secretHash(privateKey, KEY)),
      ),
    ).toBe(privateKey)
  })

  test("a bare occurrence in an EARLIER part of the same walk is swept (multi-pass)", () => {
    const redactor = mk()
    const parts = [
      { type: "text", text: `the value is ${SECRET}` },
      { type: "text", text: `config: api_key=${SECRET}` },
    ]
    expect(redactor.redactPartsInPlace(parts)).toBe(2)
    expect(parts[0]?.text).not.toContain(SECRET)
    expect(parts[1]?.text).not.toContain(SECRET)
  })

  test("a stale-clean cache entry cannot leak a later-learned secret", () => {
    const redactor = mk()
    // Long enough to be cached; scans clean while the secret is unknown.
    const prose = `${"lorem ipsum dolor sit amet ".repeat(12)}result: ${SECRET}`
    expect(redactor.redactString(prose)).toBe(prose)
    // Learning the secret must flush that cached result…
    redactor.redactString(`api_key = ${SECRET}`)
    // …or this hit would replay the stale-clean output on every request.
    expect(redactor.redactString(prose)).not.toContain(SECRET)
  })

  test("an unknown value with no context stays untouched (control)", () => {
    expect(mk().redactString(`- ${SECRET}`)).toBe(`- ${SECRET}`)
  })

  test("a vault span nested at the head of a longer rule match loses to it", () => {
    // Same-start containment still prefers the longest span. Knowing only
    // the 20-char prefix must not leave a raw tail beside its placeholder;
    // restoration alone would not detect that partial-redaction failure.
    const PREFIX = SECRET.slice(0, 20)
    const TAIL = SECRET.slice(20)
    const redactor = mk()
    // Teach the vault the 20-char prefix on its own…
    redactor.redactString(`api_key = ${PREFIX}`)
    // …then redact a string where the rule spans PREFIX + TAIL from the
    // same start offset.
    const out = redactor.redactString(`token = ${SECRET}`)
    expect(out).not.toContain(PREFIX)
    expect(out).not.toContain(TAIL)
    expect(out.match(/\[REDACTED-SECRET:/g)?.length).toBe(1)
  })
})

describe("fingerprint persistence (restart-safe exact matching)", () => {
  const SECRET = "x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce"

  const learn = (): { entries: FingerprintEntry[]; placeholder: string } => {
    const entries: FingerprintEntry[] = []
    const first = new Redactor(DEFAULT_OPTIONS, KEY, (entry) =>
      entries.push(entry),
    )
    const keyed = first.redactString(`api_key = ${SECRET}`)
    return { entries, placeholder: placeholderOf(keyed) }
  }

  test("onRegister emits one non-reversible entry per new secret", () => {
    const { entries } = learn()
    expect(entries.length).toBe(1)
    const entry = entries[0] as FingerprintEntry
    expect(entry.hash).toBe(secretHash(SECRET, KEY))
    expect(entry.length).toBe(SECRET.length)
    expect(JSON.stringify(entries)).not.toContain(SECRET)
  })

  test("a seeded fingerprint re-identifies a bare secret after a restart", () => {
    const { entries, placeholder } = learn()
    const restarted = new Redactor(DEFAULT_OPTIONS, KEY)
    restarted.seedFingerprints(entries)
    // The stored prose a restarted process actually sees: raw value,
    // no field context (text.complete wrote the restore back).
    const bare = restarted.redactString(`- ${SECRET}`)
    expect(bare).not.toContain(SECRET)
    expect(placeholderOf(bare)).toBe(placeholder)
    expect(restarted.restoreString(bare)).toBe(`- ${SECRET}`)
  })

  test("without the seed the same restart leaks (documents what the catalog buys)", () => {
    learn()
    const restarted = new Redactor(DEFAULT_OPTIONS, KEY)
    expect(restarted.redactString(`- ${SECRET}`)).toBe(`- ${SECRET}`)
  })

  test("punctuation glued to the token does not defeat recovery (slack window)", () => {
    const { entries, placeholder } = learn()
    const restarted = new Redactor(DEFAULT_OPTIONS, KEY)
    restarted.seedFingerprints(entries)
    // '.' is in the run alphabet (dotted secrets exist), so a sentence-final
    // token gloms it: the run is one char longer than the fingerprint.
    const out = restarted.redactString(`the culprit was ${SECRET}.`)
    expect(out).toBe(`the culprit was ${placeholder}.`)
  })

  test.each([
    "audit225.user:Q7m2v9N4p8R1s6T0",
    "audit225.user@local:Q7m2v9.N4p8R1s6T0",
    "audit225$user:Q7m2v9$N4p8{R1}s6T0",
  ])(
    "recovers a registered Basic Auth argument without curl context: %s",
    (secret) => {
      const entries: FingerprintEntry[] = []
      const first = new Redactor(DEFAULT_OPTIONS, KEY, (entry) =>
        entries.push(entry),
      )
      const placeholder = placeholderOf(
        first.redactString(`curl -u ${secret} https://example.invalid`),
      )
      expect(placeholder).toBe(
        placeholderFor("curl-auth-user", secretHash(secret, KEY)),
      )
      const summary = first.restoreString(`Saved value: (${placeholder}).`)
      expect(summary).toBe(`Saved value: (${secret}).`)

      const restarted = mk()
      restarted.seedFingerprints(entries)
      expect(restarted.vaultSize).toBe(0)
      expect(restarted.redactString(summary)).toBe(
        `Saved value: (${placeholder}).`,
      )
      expect(restarted.vaultSize).toBe(1)
      expect(restarted.restoreString(placeholder)).toBe(secret)

      const wireOnly = mk()
      wireOnly.seedFingerprints(entries)
      expect(
        JSON.parse(
          wireOnly.redactJsonBody(
            JSON.stringify({
              messages: [{ role: "assistant", content: summary }],
            }),
          ),
        ),
      ).toEqual({
        messages: [
          { role: "assistant", content: `Saved value: (${placeholder}).` },
        ],
      })
    },
  )

  test("Basic Auth candidate syntax never replaces an unregistered or wrong-key value", () => {
    const secret = "audit225.user:Q7m2v9N4p8R1s6T0"
    const content = `Saved value: ${secret}; status:ready; localhost:8080`
    const entries = [
      {
        hash: secretHash(secret, KEY),
        ruleId: "curl-auth-user",
        length: secret.length,
      },
    ]
    expect(mk().redactString(content)).toBe(content)
    const wrongKey = new Redactor(DEFAULT_OPTIONS, "f".repeat(64))
    wrongKey.seedFingerprints(entries)
    expect(wrongKey.redactString(content)).toBe(content)
    expect(wrongKey.vaultSize).toBe(0)

    const restarted = mk()
    restarted.seedFingerprints(entries)
    const neighbor = secret.replace("Q7", "Q8")
    expect(
      restarted.redactString(`Saved value: ${neighbor}; status:ready`),
    ).toBe(`Saved value: ${neighbor}; status:ready`)
    expect(restarted.vaultSize).toBe(0)
  })

  test("expanded credential runs preserve the original token boundaries", () => {
    const { entries, placeholder } = learn()
    for (const separator of [":", "@", "$", "{", "}"]) {
      const restarted = mk()
      restarted.seedFingerprints(entries)
      expect(restarted.redactString(`longlabel${separator}${SECRET}`)).toBe(
        `longlabel${separator}${placeholder}`,
      )
    }
  })

  test.each(["x", "yx"])(
    "catalog growth cannot leak an approved restoration through overlapping fingerprints: %s",
    (prefix) => {
      const secret = "audit225.user:Q7m2v9N4p8R1s6T0"
      const entries: FingerprintEntry[] = []
      const first = new Redactor(DEFAULT_OPTIONS, KEY, (entry) =>
        entries.push(entry),
      )
      const placeholder = placeholderOf(first.redactString(`curl -u ${secret}`))
      const summary = `${prefix}${placeholder} longneighbor${placeholder}`
      const stored = first.restoreText(summary, entries)
      expect(stored).toBe(`${prefix}${secret} longneighbor${secret}`)

      // Each later credential matches an earlier offset of the same run. All
      // original fingerprints survive; the second occurrence needs recovery
      // from the first because its own run exceeds the punctuation slack.
      for (let offset = 1; offset <= prefix.length; offset++) {
        const overlapping = prefix.slice(-offset) + secret.slice(0, -offset)
        expect(first.redactString(`curl -u ${overlapping}`)).not.toContain(
          overlapping,
        )
      }
      const restarted = mk()
      restarted.seedFingerprints(entries)
      const wire = JSON.parse(
        restarted.redactJsonBody(JSON.stringify({ text: stored })),
      )
      const union = placeholderFor(
        "curl-auth-user",
        secretHash(prefix + secret, KEY),
      )
      expect(wire.text).toBe(`${union} longneighbor${placeholder}`)
      expect(wire.text).not.toContain(secret)
      expect(restarted.restoreString(wire.text)).toBe(stored)
      expect(restarted.restoreString(placeholder)).toBe(secret)
    },
  )

  test("credential recovery shares the candidate cap and fails closed without caching a leak", () => {
    const secret = "audit225.user:Q7m2v9N4p8R1s6T0"
    const entries: FingerprintEntry[] = []
    const first = new Redactor(DEFAULT_OPTIONS, KEY, (entry) =>
      entries.push(entry),
    )
    const placeholder = placeholderOf(first.redactString(`curl -u ${secret}`))
    const candidates = Array.from(
      { length: FINGERPRINT_MAX_CANDIDATES },
      (_, i) => String(i).padStart(secret.length, "0"),
    )

    const atLimit = mk()
    atLimit.seedFingerprints(entries)
    const prefix = candidates.slice(1).join(" ")
    expect(atLimit.redactString(`${prefix} ${secret}`)).toBe(
      `${prefix} ${placeholder}`,
    )

    const content = `${candidates.join(" ")} ${secret}`
    const restarted = mk()
    restarted.seedFingerprints(entries)
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => restarted.redactString(content)).toThrow(
        FingerprintLimitError,
      )
      expect(restarted.vaultSize).toBe(0)
    }
    expect(() =>
      restarted.redactJsonBody(JSON.stringify({ text: content })),
    ).toThrow(FingerprintLimitError)
    expect(
      first.restoreText(content.replace(secret, placeholder), entries),
    ).toBe(content.replace(secret, placeholder))
    expect(restarted.redactString(secret)).toBe(placeholder)
  })

  test("the fingerprint limit error names safe recovery and the cost of clearing the catalog", () => {
    const { message } = new FingerprintLimitError()
    expect(message).toContain(
      `${FINGERPRINT_MAX_CANDIDATES} distinct candidate strings`,
    )
    expect(message).toContain("candidate-heavy content")
    expect(message).toContain("new session")
    expect(message).toContain("redact-secrets.fingerprints.json")
    expect(message).toContain("unrecognized after restart")
  })

  test("repeated credential candidates do not consume the hash budget repeatedly", () => {
    const secret = "audit225.user:Q7m2v9N4p8R1s6T0"
    const restarted = mk()
    const hash = secretHash(secret, KEY)
    restarted.seedFingerprints([
      { hash, ruleId: "curl-auth-user", length: secret.length },
    ])
    const prefix = `${"0".repeat(secret.length)} `.repeat(
      FINGERPRINT_MAX_CANDIDATES + 1,
    )
    expect(restarted.redactString(prefix + secret)).toBe(
      prefix + placeholderFor("curl-auth-user", hash),
    )
  })

  test("a wrong-key seed never matches (HMAC verification)", () => {
    const { entries } = learn()
    const otherInstall = new Redactor(DEFAULT_OPTIONS, "f".repeat(64))
    otherInstall.seedFingerprints(entries)
    expect(otherInstall.redactString(`- ${SECRET}`)).toBe(`- ${SECRET}`)
  })

  test("malformed entries are dropped on seed", () => {
    const restarted = new Redactor(DEFAULT_OPTIONS, KEY)
    restarted.seedFingerprints([
      { hash: "not-hex", ruleId: "generic-api-key", length: 32 },
      { hash: secretHash(SECRET, KEY), ruleId: "NOT_A_RULE_ID", length: 32 },
      { hash: secretHash(SECRET, KEY), ruleId: "generic-api-key", length: 1.5 },
      { hash: secretHash(SECRET, KEY), ruleId: "generic-api-key", length: -1 },
    ] as FingerprintEntry[])
    expect(restarted.redactString(`- ${SECRET}`)).toBe(`- ${SECRET}`)
  })
})

describe("restart-safe prose restoration", () => {
  test.each([
    '"audit225.user:Q7m2 v9!N4#p8"',
    "'audit225.user:Q7m2 v9!N4#p8'",
    '"audit225.user:\u03bbQ7m2v9\u00e9N4p8"',
    '"audit225.user:Q7m2\nv9!N4p8"',
  ])(
    "retains an unsupported curl argument shape in prose, but not tool args: %s",
    (secret) => {
      const entries: FingerprintEntry[] = []
      const first = new Redactor(DEFAULT_OPTIONS, KEY, (entry) =>
        entries.push(entry),
      )
      const placeholder = placeholderOf(first.redactString(`curl -u ${secret}`))
      expect(placeholder).toBe(
        placeholderFor("curl-auth-user", secretHash(secret, KEY)),
      )
      const summary = `Saved value: ${placeholder}`
      expect(first.restoreText(summary, entries)).toBe(summary)
      const args = { command: `curl -u ${placeholder}` }
      first.restoreValueInPlace(args)
      expect(args.command).toBe(`curl -u ${secret}`)

      const restarted = mk()
      restarted.seedFingerprints(entries)
      expect(restarted.redactJsonBody(JSON.stringify({ text: summary }))).toBe(
        JSON.stringify({ text: summary }),
      )
    },
  )

  test("checks actual prose context and retains all placeholders if any restoration is unsafe", () => {
    const secret = "audit225.user:Q7m2v9N4p8R1s6T0"
    const entries: FingerprintEntry[] = []
    const first = new Redactor(DEFAULT_OPTIONS, KEY, (entry) =>
      entries.push(entry),
    )
    const placeholder = placeholderOf(first.redactString(`curl -u ${secret}`))
    expect(first.restoreText(`Saved value: ${placeholder}.`, entries)).toBe(
      `Saved value: ${secret}.`,
    )
    expect(first.restoreText(`longprefix${placeholder}`, entries)).toBe(
      `longprefix${placeholder}`,
    )
    expect(first.restoreText(`Saved value: ${placeholder}`, [])).toBe(
      `Saved value: ${placeholder}`,
    )

    const quoted = '"audit225.other:W6r8 m2!T9#q4"'
    const other = placeholderOf(first.redactString(`curl -u ${quoted}`))
    const mixed = `Saved values: ${placeholder} and ${other}`
    expect(first.restoreText(mixed, entries)).toBe(mixed)
    expect(first.restoreText(placeholder + placeholder, entries)).toBe(
      placeholder + placeholder,
    )
  })

  test("allows self-describing multiline secrets without fingerprint recovery", () => {
    const secret = [
      "-----BEGIN PRIVATE KEY-----",
      "AZ19bcD2efG3hJ4kL5mN6pQ7rS8tU9vW0xYz".repeat(4),
      "-----END PRIVATE KEY-----",
    ].join("\n")
    const first = mk()
    const placeholder = placeholderOf(first.redactString(secret))
    expect(first.restoreString(placeholder)).toBe(secret)
    const summary = `Saved value:\n${placeholder}`
    const restored = first.restoreText(summary, [])
    expect(restored).toBe(`Saved value:\n${secret}`)
    expect(mk().redactString(restored)).toBe(summary)
  })
})

describe("canonical placeholder labels (registration-order stability)", () => {
  // A 32-char [a-z0-9] value that satisfies datadog-api-key AND
  // discord-client-secret alike — which rule "sees" it depends purely on the
  // surrounding field context.
  const SECRET = "x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce"

  test("re-learning a secret under a DIFFERENT rule keeps the original label", () => {
    // The review finding: the same secret minted datadog-api-key:<hash> or
    // discord-client-secret:<hash> depending on context, so the placeholder
    // string — and with it the prompt-cache-stable prefix — changed across
    // restarts. The hash always restored correctly; only the label wandered.
    const entries: FingerprintEntry[] = []
    const first = new Redactor(DEFAULT_OPTIONS, KEY, (entry) =>
      entries.push(entry),
    )
    const viaDatadog = first.redactString(`datadog_api_key = "${SECRET}"`)
    expect(placeholderOf(viaDatadog)).toContain(":datadog-api-key:")

    const restarted = new Redactor(DEFAULT_OPTIONS, KEY)
    restarted.seedFingerprints(entries)
    const viaDiscord = restarted.redactString(`discord_secret = "${SECRET}"`)
    expect(placeholderOf(viaDiscord)).toBe(placeholderOf(viaDatadog))
  })

  test("within one process the first registration already pins the label", () => {
    const redactor = mk()
    const a = redactor.redactString(`datadog_api_key = "${SECRET}"`)
    const b = redactor.redactString(`discord_secret = "${SECRET}"`)
    expect(placeholderOf(b)).toBe(placeholderOf(a))
  })
})

describe("cross-string keyword context (noteScanContext)", () => {
  // facebook-access-token gates on "facebook", which is NOT part of its token
  // pattern — the pair that reproduces the cross-part leak: keyword in one
  // outbound string, bare token in a sibling.
  const FB_TOKEN = "123456789012345|a1b2c3d4e5f6g7h8i9j0k1l2m3n"

  test("a keyword noted from one string gates the rule in another", () => {
    const redactor = mk()
    expect(redactor.redactString(`access = ${FB_TOKEN}\n`)).toBe(
      `access = ${FB_TOKEN}\n`,
    )
    redactor.noteScanContext("facebook token follows")
    const redacted = redactor.redactString(`access = ${FB_TOKEN}\n`)
    expect(redacted).not.toContain(FB_TOKEN)
    expect(redacted).toMatch(new RegExp(PLACEHOLDER_RE.source))
  })

  test("noting a new keyword invalidates cached clean results", () => {
    // The scan cache is keyed by content alone; an entry computed under a
    // smaller candidate set would return its stale "clean" output on every
    // later hit — the cache must be flushed when the context grows.
    const redactor = mk()
    const content = `${"x".repeat(300)} access = ${FB_TOKEN}\n`
    expect(redactor.redactString(content)).toBe(content) // clean, and cached
    redactor.noteScanContext("facebook token follows")
    expect(redactor.redactString(content)).not.toContain(FB_TOKEN)
  })

  test("context only widens candidate selection — a non-matching string stays untouched", () => {
    const redactor = mk()
    redactor.noteScanContext("facebook api key token secret facebook")
    const prose =
      "ordinary prose with numbers 12345 and words, nothing shaped like a credential"
    expect(redactor.redactString(prose)).toBe(prose)
  })

  // The digest-gated variant (audit M7): repeated content skips the keyword
  // sweep, but nothing observable may change — the sticky set already holds
  // everything a repeat sweep could add.
  test("noteScanContextCached gates like noteScanContext, and a repeated note keeps the gate", () => {
    const redactor = mk()
    expect(redactor.redactString(`access = ${FB_TOKEN}\n`)).toBe(
      `access = ${FB_TOKEN}\n`,
    )
    redactor.noteScanContextCached("facebook token follows")
    redactor.noteScanContextCached("facebook token follows") // digest hit — sweep skipped, gate intact
    const redacted = redactor.redactString(`access = ${FB_TOKEN}\n`)
    expect(redacted).not.toContain(FB_TOKEN)
    expect(redacted).toMatch(new RegExp(PLACEHOLDER_RE.source))
  })

  test("changed bytes re-note through the digest gate (compaction-replaced history)", () => {
    const redactor = mk()
    redactor.noteScanContextCached("nothing interesting here")
    expect(redactor.redactString(`access = ${FB_TOKEN}\n`)).toBe(
      `access = ${FB_TOKEN}\n`,
    )
    // Same conversational "slot", new bytes: the digest misses and the new
    // keyword must gate from here on.
    redactor.noteScanContextCached(
      "nothing interesting here, plus the facebook credential",
    )
    expect(redactor.redactString(`access = ${FB_TOKEN}\n`)).not.toContain(
      FB_TOKEN,
    )
  })
})

describe("vault capacity (fail closed, audit L-RS1)", () => {
  // Shape-valid, entropy-passing distinct PATs, deterministically derived so
  // the test never flakes. A tiny number of hex-derived candidates could in
  // principle sit at entropy <= 3 and be filter-dropped, so the corpus
  // carries a margin over the cap; the cap must trip either way.
  const distinctPats = (count: number): string[] => {
    const pats: string[] = []
    for (let i = 0; pats.length < count; i++) {
      const hex =
        secretHash(`a${i}`, KEY) +
        secretHash(`b${i}`, KEY) +
        secretHash(`c${i}`, KEY)
      pats.push(`ghp_${hex.slice(0, 36)}`)
    }
    return pats
  }

  // Deliberately heavy and given an explicit budget: proving the cap means
  // actually scanning past MAX_VAULT_SECRETS distinct secrets — ~10k findings
  // through the full rule engine — which no smaller fixture can stand in for.
  // It runs in ~2s locally but timed out at Bun's 5s default on a shared CI
  // runner under monorepo contention (PR #68 run 29707935800), taking the
  // whole required job and every E2E job downstream of it with it. The
  // generous ceiling keeps a genuine hang detectable while leaving room for
  // a loaded runner.
  const VAULT_CAP_TEST_TIMEOUT_MS = 60_000

  test(
    "registration past MAX_VAULT_SECRETS aborts the request; the vault below the cap stays live",
    () => {
      const redactor = mk()
      const pats = distinctPats(MAX_VAULT_SECRETS + 64)
      const content = pats.map((pat) => `token = ${pat}`).join("\n")
      expect(() => redactor.redactString(content)).toThrow(VaultLimitError)
      expect(redactor.vaultSize).toBe(MAX_VAULT_SECRETS)

      // Everything already vaulted keeps working at the cap: same placeholder,
      // no throw, and restoration is intact.
      const first = pats[0] as string
      const redacted = redactor.redactString(`again: ${first}`)
      expect(redacted).not.toContain(first)
      expect(redactor.restoreString(redacted)).toBe(`again: ${first}`)

      // A NEW secret still fails closed rather than evicting or passing raw.
      const fresh = `ghp_${(secretHash("x0", KEY) + secretHash("y0", KEY) + secretHash("z0", KEY)).slice(0, 36)}`
      expect(() => redactor.redactString(`token = ${fresh}`)).toThrow(
        VaultLimitError,
      )
    },
    VAULT_CAP_TEST_TIMEOUT_MS,
  )

  test("a single oversized secret trips the byte budget long before the count cap", () => {
    const redactor = mk()
    // One PEM-shaped value larger than MAX_VAULT_CHARS: the private-key rule
    // matches unbounded spans, so before the byte budget this counted as ONE
    // entry against MAX_VAULT_SECRETS while retaining megabytes for the
    // session's life (audit review).
    const oversized = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "A".repeat(MAX_VAULT_CHARS + 1024),
      "-----END RSA PRIVATE KEY-----",
    ].join("\n")
    expect(() => redactor.redactString(oversized)).toThrow(VaultLimitError)
    // Fail-closed means fail-CLEAN: no half-registered entry is left behind.
    expect(redactor.vaultSize).toBe(0)
    expect(redactor.vaultChars).toBe(0)
  })

  test("the aggregate byte budget bounds many merely-large secrets too", () => {
    const redactor = mk()
    const chunk = "B".repeat(1024 * 1024)
    const pem = (n: number) =>
      `-----BEGIN RSA PRIVATE KEY-----\n${chunk}${String(n).padStart(4, "0")}\n-----END RSA PRIVATE KEY-----`
    let registered = 0
    expect(() => {
      for (let i = 0; i < 32; i++) {
        redactor.redactString(pem(i))
        registered++
      }
    }).toThrow(VaultLimitError)
    // Well under MAX_VAULT_SECRETS entries, so only the byte budget can have
    // stopped it — and it stopped inside the budget, never past it.
    expect(registered).toBeLessThan(32)
    expect(redactor.vaultSize).toBeLessThan(MAX_VAULT_SECRETS)
    expect(redactor.vaultChars).toBeLessThanOrEqual(MAX_VAULT_CHARS)
  })
})

describe("deep walks", () => {
  test("redactPartsInPlace skips structural keys on the part but scans everything below", () => {
    const redactor = mk()
    const toolPart = {
      id: "prt_1",
      type: "tool",
      tool: "webfetch",
      callID: "call_1",
      sessionID: `ses_${FAKE_PAT}`, // pathological, but must stay untouched
      state: {
        status: "completed",
        // The same names that are structural on the part are DATA here:
        // a nested url/hash/mode must not ride the skip list.
        input: { url: `https://host/api?token=${FAKE_PAT}`, hash: FAKE_PAT },
        output: `stdout: ${FAKE_PAT}`,
        metadata: { mode: `mode: ${FAKE_PAT}` },
        time: { start: 1, end: 2 },
        attachments: [
          {
            id: "prt_2",
            type: "file",
            mime: "image/png",
            url: "data:image/png;base64,AAAA",
          },
        ],
      },
    }
    const textPart = {
      id: "prt_3",
      type: "text",
      text: `here is a token: ${FAKE_PAT}`,
    }
    const count = redactor.redactPartsInPlace([toolPart, textPart])
    expect(count).toBe(5)
    expect(toolPart.state.input.url).not.toContain(FAKE_PAT)
    expect(toolPart.state.input.hash).not.toContain(FAKE_PAT)
    expect(toolPart.state.output).not.toContain(FAKE_PAT)
    expect(toolPart.state.metadata.mode).not.toContain(FAKE_PAT)
    expect(textPart.text).not.toContain(FAKE_PAT)
    expect(toolPart.sessionID).toBe(`ses_${FAKE_PAT}`)
    expect(toolPart.state.status).toBe("completed")
    // Nested FilePart attachments keep the part policy: an opaque data: url is
    // the attachment payload, not scannable data.
    expect(toolPart.state.attachments[0]?.url).toBe(
      "data:image/png;base64,AAAA",
    )
  })

  test("a remote part url is scanned; clean base64-data:/file: payloads pass through", () => {
    // The host forwards a part-level url to the provider verbatim
    // (message-v2.ts:219), so a secret in a remote http(s) attachment url is
    // wire-bound and must be redacted — even though same-named urls that are
    // clean data: payloads (scanned byte-preservingly, nothing matches) or
    // local paths (file:, resolved before sending) come out intact. Covers
    // both a top-level FilePart and one nested as a tool-state attachment.
    const redactor = mk()
    const remote = {
      id: "p1",
      type: "file",
      mime: "image/png",
      url: `https://cdn.example/i.png?token=${FAKE_PAT}`,
    }
    const dataUrl = {
      id: "p2",
      type: "file",
      mime: "image/png",
      url: "data:image/png;base64,AAAA",
    }
    const fileUrl = {
      id: "p3",
      type: "file",
      mime: "text/plain",
      url: `file:///home/u/.env?x=${FAKE_PAT}`,
    }
    // The same policy applies to a FilePart nested as a tool-state attachment.
    const nestedRemote = {
      id: "p5",
      type: "file",
      mime: "image/png",
      url: `https://cdn.example/n.png?k=${FAKE_PAT}`,
    }
    const toolPart = {
      id: "p4",
      type: "tool",
      tool: "webfetch",
      state: { status: "completed", attachments: [nestedRemote] },
    }
    redactor.redactPartsInPlace([remote, dataUrl, fileUrl, toolPart])
    expect(remote.url).not.toContain(FAKE_PAT)
    // The rebuilt url percent-encodes the query, placeholder included; decode
    // the parameter to assert the placeholder landed where the secret was.
    expect(new URL(remote.url).searchParams.get("token")).toContain(
      "[REDACTED-SECRET:github-pat:",
    )
    expect(dataUrl.url).toBe("data:image/png;base64,AAAA")
    expect(fileUrl.url).toContain(FAKE_PAT) // file: is local, resolved before it leaves the machine
    expect(nestedRemote.url).not.toContain(FAKE_PAT)
  })

  test("a secret hidden by percent-encoding in a remote url is decoded and redacted", () => {
    // The reviewer's leak: `?token=%67%68%70...` is a valid ghp_ credential the
    // provider reads once it decodes the url, but a raw scan of the encoded
    // bytes matches no rule. Each component is percent-decoded before scanning.
    const redactor = mk()
    const encodedPat = encodeURIComponent(FAKE_PAT).replace("ghp_x", "ghp_%78")
    expect(encodedPat).not.toBe(FAKE_PAT) // the %78 keeps a raw scan from matching
    const parts = [
      {
        id: "q",
        type: "file",
        mime: "image/png",
        url: `https://cdn.example/i.png?token=${encodedPat}`,
      },
      {
        id: "u",
        type: "file",
        mime: "image/png",
        url: `https://user:${encodedPat}@host/p`,
      },
      {
        id: "p",
        type: "file",
        mime: "image/png",
        url: `https://host/${encodedPat}/file`,
      },
      {
        id: "f",
        type: "file",
        mime: "image/png",
        url: `https://host/x#${encodedPat}`,
      },
    ]
    expect(redactor.redactPartsInPlace(parts)).toBe(4)
    for (const part of parts) {
      expect(part.url).not.toContain(FAKE_PAT)
      // The placeholder is recoverable from the parsed url, whichever component held it.
      const u = new URL(part.url)
      const surface = decodeURIComponent(
        `${u.username}:${u.password}${u.pathname}${u.search}${u.hash}`,
      )
      expect(surface).toContain("[REDACTED-SECRET:github-pat:")
    }
  })

  test("a secret in the host, a bare query-key, or a host-keyword url rule is still caught (whole-string backstop)", () => {
    // The component passes scan query VALUES, userinfo, path, and fragment in
    // isolation — they never see the host or a bare parameter NAME, and can't
    // fire a url rule keyword-gated on the host with its token in the path
    // (slack-webhook-url). A final whole-string scan restores that coverage.
    const redactor = mk()
    const linear = `lin_api_${"a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0"}`
    const slack = `https://hooks.slack.com/services/T00000000/B00000000/${"AbCdEfGhIjKlMnOpQrStUvWx"}`
    const parts = [
      // secret sits in the query-KEY position (value empty, then value=1)
      {
        id: "k0",
        type: "file",
        mime: "image/png",
        url: `https://cdn.example/f.png?${FAKE_PAT}`,
      },
      {
        id: "k1",
        type: "file",
        mime: "image/png",
        url: `https://cdn.example/f.png?${FAKE_PAT}=1`,
      },
      // secret sits in a host label
      {
        id: "h",
        type: "file",
        mime: "image/png",
        url: `https://${linear}.evil.example/f.png`,
      },
      // a host-keyword-gated url rule: keyword is the host, token is the path
      { id: "s", type: "file", mime: "image/png", url: slack },
    ]
    expect(redactor.redactPartsInPlace(parts)).toBe(4)
    expect(parts[0]?.url).not.toContain(FAKE_PAT)
    expect(parts[1]?.url).not.toContain(FAKE_PAT)
    expect(parts[2]?.url).not.toContain(linear)
    expect(parts[2]?.url).toContain("[REDACTED-SECRET:linear-api-key:")
    expect(parts[3]?.url).not.toContain(slack.slice(slack.indexOf("services/")))
    expect(parts[3]?.url).toContain("[REDACTED-SECRET:slack-webhook-url:")
  })

  test("a percent-encoded secret used as a query parameter NAME is decoded and redacted", () => {
    // The raw-key case above is caught by the whole-string backstop; a
    // percent-ENCODED key defeats it (the raw scan sees only encoded bytes)
    // and only URLSearchParams' decoded view exposes the credential. The
    // component pass must scan parameter names, not just values.
    const redactor = mk()
    const encodedPat = [...FAKE_PAT]
      .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("")
    const part = {
      id: "n",
      type: "file",
      mime: "image/png",
      url: `https://cdn.example/f.png?${encodedPat}=1`,
    }
    expect(redactor.redactPartsInPlace([part])).toBe(1)
    expect(part.url).not.toContain(FAKE_PAT)
    expect(decodeURIComponent(part.url)).not.toContain(FAKE_PAT)
    // The name is replaced, the value and the rest of the url survive.
    expect(decodeURIComponent(part.url)).toContain(
      "[REDACTED-SECRET:github-pat:",
    )
    expect(part.url).toContain("cdn.example/f.png")
    expect(part.url).toContain("=1")
  })

  test("a remote url query value keeps its parameter name as keyword context", () => {
    // `?api_key=<value>` needs the "api_key" keyword — which lives in the
    // parameter NAME, not the value — for the keyword-gated generic rule to
    // fire. redactRemoteUrl scans each value under its key, reconstructing the
    // key=value line the same way structured-data redaction does.
    const generic = "a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuV" // high-entropy, no vendor shape
    const bare = {
      id: "b",
      type: "file",
      mime: "image/png",
      url: `https://h/x?blob=${generic}`,
    }
    const keyed = {
      id: "k",
      type: "file",
      mime: "image/png",
      url: `https://h/x?api_key=${generic}`,
    }
    // Alone, the value has no keyword context anywhere: untouched, and a
    // clean url stays byte-identical.
    expect(mk().redactPartsInPlace([bare])).toBe(0)
    expect(bare.url).toBe(`https://h/x?blob=${generic}`)
    // With the keyed sibling in the same walk, the value is registered from
    // `api_key=` context and its bare occurrence becomes a KNOWN vault value —
    // exact-match replaces it context-free (the restored-secret leak fix), so
    // BOTH urls are masked.
    const redactor = mk()
    expect(redactor.redactPartsInPlace([bare, keyed])).toBe(2)
    expect(keyed.url).not.toContain(generic)
    expect(new URL(keyed.url).searchParams.get("api_key")).toContain(
      "[REDACTED-SECRET:",
    )
    expect(bare.url).not.toContain(generic)
    expect(decodeURIComponent(bare.url)).toContain("[REDACTED-SECRET:")
  })

  test("a clean remote url is returned byte-identical", () => {
    const redactor = mk()
    const url = "https://Cdn.Example.com:443/a%2Fb/image.png?w=100&h=50#frag"
    const part = { id: "p", type: "file", mime: "image/png", url }
    expect(redactor.redactPartsInPlace([part])).toBe(0)
    expect(part.url).toBe(url) // no normalization when nothing was redacted
  })

  test("a secret in a MIME value is scanned, not skipped as structural", () => {
    // FilePart.mime is an unrestricted string the host forwards verbatim as
    // mediaType (message-v2.ts:222); an untrusted MCP resource can set it
    // (session/tools.ts:433). A legit mediatype matches no rule; a crafted one
    // carrying a credential must be redacted.
    const redactor = mk()
    const legit = {
      id: "a",
      type: "file",
      mime: "application/json",
      url: "data:image/png;base64,AAAA",
    }
    const crafted = {
      id: "b",
      type: "file",
      mime: `text/plain; token=${FAKE_PAT}`,
      url: "data:image/png;base64,AAAA",
    }
    expect(redactor.redactPartsInPlace([legit, crafted])).toBe(1)
    expect(legit.mime).toBe("application/json") // unchanged
    expect(crafted.mime).not.toContain(FAKE_PAT)
    expect(crafted.mime).toContain("[REDACTED-SECRET:github-pat:")
  })

  test("a secret in a data: url's mediatype metadata is scanned even when the payload is clean", () => {
    // The reviewer's finding: OpenCode places the full data url into the outbound
    // file part (message-v2.ts:221). Defense in depth — the AI SDK drops a
    // data-url's `;params` before the wire, so this is not a demonstrated leak,
    // but the metadata is scanned anyway (parity with the `mime` field) rather
    // than trusted. The payload (no PNG magic, so it takes the scan path, which
    // matches nothing) is preserved byte-for-byte; the result is still a valid
    // data url with the metadata credential masked.
    const redactor = mk()
    const binaryMeta = {
      id: "p1",
      type: "file",
      mime: "image/png",
      url: `data:image/png;token=${FAKE_PAT};base64,AAAA`,
    }
    // A plaintext data url whose credential sits in the metadata, not the payload.
    const plaintextMeta = {
      id: "p2",
      type: "file",
      mime: "text/plain",
      url: `data:text/plain;key=${FAKE_PAT},hello`,
    }
    expect(redactor.redactPartsInPlace([binaryMeta, plaintextMeta])).toBe(2)

    expect(binaryMeta.url).not.toContain(FAKE_PAT)
    expect(binaryMeta.url).toContain("[REDACTED-SECRET:github-pat:")
    expect(binaryMeta.url.endsWith(";base64,AAAA")).toBe(true) // marker + clean payload preserved

    expect(plaintextMeta.url).not.toContain(FAKE_PAT)
    expect(plaintextMeta.url).toContain("[REDACTED-SECRET:github-pat:")
    expect(plaintextMeta.url.endsWith(",hello")).toBe(true) // clean payload preserved byte-for-byte
  })

  test("a plaintext data: payload is decoded, scanned, and re-encoded", () => {
    // Non-base64 data: urls carry percent-encoded PLAINTEXT the host forwards
    // to the provider verbatim — an svg comment is as readable as chat text.
    const redactor = mk()
    const svg = {
      id: "p1",
      type: "file",
      mime: "image/svg+xml",
      url: `data:image/svg+xml,<svg><!-- token=${FAKE_PAT} --></svg>`,
    }
    // A secret only visible AFTER percent-decoding ("x" encoded as %78): a
    // raw scan of the url string would miss it, the provider's decode
    // would reveal it.
    const encoded = {
      id: "p2",
      type: "file",
      mime: "text/plain",
      url: `data:text/plain,note%20${encodeURIComponent(FAKE_PAT).replace("ghp_x", "ghp_%78")}`,
    }
    redactor.redactPartsInPlace([svg, encoded])
    // The mediatype prefix is preserved, so the result is a still-valid data
    // url whose DECODED payload carries the placeholder instead of the secret.
    expect(svg.url.startsWith("data:image/svg+xml,")).toBe(true)
    expect(encoded.url.startsWith("data:text/plain,")).toBe(true)
    for (const part of [svg, encoded]) {
      expect(part.url).not.toContain(FAKE_PAT)
      const payload = decodeURIComponent(
        part.url.slice(part.url.indexOf(",") + 1),
      )
      expect(payload).not.toContain(FAKE_PAT)
      expect(payload).toMatch(new RegExp(PLACEHOLDER_RE.source))
    }
  })

  test("a textual base64 data: attachment is decoded, scanned, and re-encoded", () => {
    // OpenCode base64-encodes any non-text/plain attachment (application/json
    // included) before forwarding it to the provider, which decodes it back to
    // readable text — so a credential inside one is a real leak the message
    // transform must catch. Magic-confirmed binary base64 (a real image) stays
    // opaque even when its bytes happen to contain an ascii credential-shaped run.
    const redactor = mk()
    const json = JSON.stringify({ note: "prod key", token: FAKE_PAT }, null, 2)
    const jsonUrl = `data:application/json;base64,${Buffer.from(json, "utf8").toString("base64")}`
    const jsonPart = {
      id: "p1",
      type: "file",
      mime: "application/json",
      url: jsonUrl,
    }
    // An image whose bytes carry real PNG magic AND a shape-valid PAT: still
    // opaque, because the declared type is confirmed and a provider treats
    // image/png as bytes, not text.
    const imgBytes = Buffer.from(
      `\x89PNG\r\n\x1a\n...${FAKE_PAT}...binary`,
      "latin1",
    )
    const imgUrl = `data:image/png;base64,${imgBytes.toString("base64")}`
    const imgPart = { id: "p2", type: "file", mime: "image/png", url: imgUrl }

    const count = redactor.redactPartsInPlace([jsonPart, imgPart])
    expect(count).toBe(1)
    // The json url still parses as a data url; its DECODED payload now carries
    // the placeholder, and the secret is gone from both the url and the decode.
    expect(jsonPart.url.startsWith("data:application/json;base64,")).toBe(true)
    expect(jsonPart.url).not.toContain(Buffer.from(FAKE_PAT).toString("base64"))
    const decodedJson = Buffer.from(
      jsonPart.url.split(",")[1] as string,
      "base64",
    ).toString("utf8")
    expect(decodedJson).not.toContain(FAKE_PAT)
    expect(decodedJson).toContain("[REDACTED-SECRET:github-pat:")
    // A clean textual attachment is byte-preserved (latin1 round-trip): the
    // image is returned exactly as it came in.
    expect(imgPart.url).toBe(imgUrl)
  })

  test("a non-UTF-8 textual base64 attachment with an unlisted mediatype is still scanned", () => {
    // The reviewer's leak: OpenCode labels a non-UTF-8 textual file (a Latin-1
    // SQL dump) with a guessed mediatype (application/x-sql) that no allow-list
    // enumerates. Content sniffing, not the mediatype, must decide — so the
    // credential inside is caught, and the non-ascii byte is preserved.
    const redactor = mk()
    const dump = Buffer.concat([
      Buffer.from("-- dump caf", "latin1"),
      Buffer.from([0xe9]), // 0xe9 alone is invalid UTF-8, so the file is not text/plain
      Buffer.from(`\nINSERT INTO s VALUES('${FAKE_PAT}');\n`, "latin1"),
    ])
    const url = `data:application/x-sql;base64,${dump.toString("base64")}`
    const part = { id: "p", type: "file", mime: "application/x-sql", url }
    expect(redactor.redactPartsInPlace([part])).toBe(1)
    const decoded = Buffer.from(
      part.url.split(",")[1] as string,
      "base64",
    ).toString("latin1")
    expect(decoded).not.toContain(FAKE_PAT)
    expect(decoded).toContain("[REDACTED-SECRET:github-pat:")
    expect(decoded).toContain("caf\xe9") // the invalid-UTF-8 byte survives the latin1 round-trip
  })

  test("a well-formed UTF-8 base64 attachment is scanned with code-point semantics", () => {
    // The reviewer's miss: the identical text redacts fine as a message
    // string, but the old latin1 view of the attachment's bytes stretched
    // each emoji to four characters, overflowing amplitude's 32-code-point
    // gap — zero redactions. Well-formed UTF-8 now decodes as UTF-8, so the
    // scanner counts the characters the provider will read.
    const redactor = mk()
    const hex = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
    const text = `amplitude ${"\u{1F40D}".repeat(10)} SECRET ${hex}\n`
    const url = `data:application/json;base64,${Buffer.from(text, "utf8").toString("base64")}`
    const part = { id: "p", type: "file", mime: "application/json", url }
    expect(redactor.redactPartsInPlace([part])).toBe(1)
    const decoded = Buffer.from(
      part.url.split(",")[1] as string,
      "base64",
    ).toString("utf8")
    expect(decoded).not.toContain(hex)
    expect(decoded).toContain("[REDACTED-SECRET:amplitude-secret-key:")
    expect(decoded).toContain("\u{1F40D}".repeat(10)) // multibyte text round-trips as UTF-8
  })

  test("one malformed percent escape does not shield encoded secrets in a plaintext data: payload", () => {
    // The reviewer's bypass: decodeURIComponent is all-or-nothing, so a
    // payload beginning %FF threw and the fallback scanned the ENCODED text,
    // where a fully percent-encoded PAT matches nothing — while standard
    // data-url decoding hands the provider byte 0xff followed by the raw
    // credential. Tolerant run-by-run decoding costs the bad escape only its
    // own run.
    const redactor = mk()
    const encodedPat = [...FAKE_PAT]
      .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("")
    const part = {
      id: "p",
      type: "file",
      mime: "text/plain",
      url: `data:text/plain,%FFtoken%3A%20${encodedPat}`,
    }
    expect(redactor.redactPartsInPlace([part])).toBe(1)
    const payload = part.url.slice(part.url.indexOf(",") + 1)
    const decoded = percentDecodeTolerant(payload)
    expect(decoded).not.toContain(FAKE_PAT)
    expect(decoded).toContain("[REDACTED-SECRET:github-pat:")
  })

  test("one malformed percent escape does not shield an encoded secret elsewhere in a remote url", () => {
    // Same all-or-nothing failure on the remote-url path: %FF in the path
    // made scanComponent fall back to the encoded text, hiding the
    // percent-encoded credential in the adjacent segment.
    const redactor = mk()
    const encodedPat = [...FAKE_PAT]
      .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("")
    const part = {
      id: "p",
      type: "file",
      mime: "text/plain",
      url: `https://files.example.com/d%FF/${encodedPat}/x`,
    }
    expect(redactor.redactPartsInPlace([part])).toBe(1)
    expect(part.url).not.toContain(FAKE_PAT)
    expect(percentDecodeTolerant(part.url)).not.toContain(FAKE_PAT)
    expect(percentDecodeTolerant(part.url)).toContain(
      "[REDACTED-SECRET:github-pat:",
    )
  })

  test("a leading NUL no longer exempts a textual base64 payload from scanning", () => {
    // The reviewer's bypass: a base64 application/json attachment whose decoded
    // bytes START with a NUL. The old content sniff called that binary and
    // skipped it, so the `token=<PAT>` after the NUL reached the provider intact.
    // Content classification is no longer an exemption — the payload is scanned,
    // the secret is redacted, and the NUL byte survives the latin1 round-trip.
    const redactor = mk()
    const payload = Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from(`{"token":"${FAKE_PAT}"}`, "latin1"),
    ])
    const url = `data:application/json;base64,${payload.toString("base64")}`
    const part = { id: "p", type: "file", mime: "application/json", url }
    expect(redactor.redactPartsInPlace([part])).toBe(1)
    const decoded = Buffer.from(
      part.url.split(",")[1] as string,
      "base64",
    ).toString("latin1")
    expect(decoded).not.toContain(FAKE_PAT)
    expect(decoded).toContain("[REDACTED-SECRET:github-pat:")
    expect(decoded.charCodeAt(0)).toBe(0) // the leading NUL is preserved
  })

  test("a genuinely binary base64 payload with an unlisted mediatype and no secret round-trips byte-identically", () => {
    // No mediatype fast-path (application/x-blob has no known signature), so it
    // is decoded and scanned — but a byte-preserving scan that matches nothing
    // returns the payload untouched, so a clean binary blob is never corrupted.
    const redactor = mk()
    const binary = Buffer.from([
      0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x89, 0x13, 0x07, 0x00,
    ])
    const url = `data:application/x-blob;base64,${binary.toString("base64")}`
    const part = { id: "p", type: "file", mime: "application/x-blob", url }
    expect(redactor.redactPartsInPlace([part])).toBe(0)
    expect(part.url).toBe(url)
  })

  test("a clean textual base64 attachment is returned byte-identical", () => {
    const redactor = mk()
    const url = `data:application/json;base64,${Buffer.from('{"ok":true}', "utf8").toString("base64")}`
    const part = { id: "p1", type: "file", mime: "application/json", url }
    expect(redactor.redactPartsInPlace([part])).toBe(0)
    expect(part.url).toBe(url)
  })

  test("malformed data: payloads fail closed and are still scanned", () => {
    const redactor = mk()
    // "%va" is not a percent escape — decodeURIComponent throws, so the raw
    // payload is scanned instead of skipped.
    const badEncoding = {
      id: "p1",
      type: "file",
      mime: "text/plain",
      url: `data:text/plain,100%valid ${FAKE_PAT}`,
    }
    // No comma at all: not a well-formed data url; the whole string is scanned.
    const noComma = {
      id: "p2",
      type: "file",
      mime: "text/plain",
      url: `data:${FAKE_PAT}`,
    }
    redactor.redactPartsInPlace([badEncoding, noComma])
    expect(badEncoding.url).not.toContain(FAKE_PAT)
    expect(noComma.url).not.toContain(FAKE_PAT)
  })

  test("isOpaqueBinaryPayload skips only declared types the payload's magic bytes confirm", () => {
    const b64 = (bytes: Buffer | string): string =>
      (typeof bytes === "string"
        ? Buffer.from(bytes, "latin1")
        : bytes
      ).toString("base64")
    const png = b64(
      Buffer.concat([
        Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
        Buffer.from([1, 2, 3]),
      ]),
    )
    const zip = b64("PK\x03\x04rest-of-archive")
    const riffWebp = b64("RIFF\x10\x00\x00\x00WEBPVP8 ")
    const text = b64(`token=${FAKE_PAT}`)

    // Declared type + matching magic: opaque, fast-skipped.
    expect(isOpaqueBinaryPayload("image/png", png)).toBe(true)
    expect(isOpaqueBinaryPayload("image/png;charset=x", png)).toBe(true) // params dropped
    expect(isOpaqueBinaryPayload("application/zip", zip)).toBe(true)
    expect(isOpaqueBinaryPayload("image/webp", riffWebp)).toBe(true)

    // The declaration alone is never enough (the reproduced bypass): textual
    // bytes wearing a binary label must fall through to the scan.
    expect(isOpaqueBinaryPayload("image/png", text)).toBe(false)
    expect(isOpaqueBinaryPayload("video/mp4", text)).toBe(false)
    // Magic of a DIFFERENT type does not vouch for the declared one.
    expect(isOpaqueBinaryPayload("image/png", zip)).toBe(false)
    // No usable signature exists for the universal-mislabel type, so it is
    // always scanned even when the bytes are genuinely binary.
    expect(isOpaqueBinaryPayload("application/octet-stream", png)).toBe(false)
    // Text, structured-suffix, and any UNRECOGNIZED type never skip either —
    // application/x-sql is the round-8 leak (textual, on no allow-list) and
    // application/pdf the round-9 one (providers extract its text).
    for (const mime of [
      "",
      "text/plain",
      "application/pdf",
      "application/json",
      "application/vnd.api+json",
      "image/svg+xml",
      "application/x-sql",
      "application/vnd.dart",
      "application/x-yaml",
    ]) {
      expect(isOpaqueBinaryPayload(mime, png)).toBe(false)
    }
    // Truncated payloads shorter than the signature fail closed too.
    expect(isOpaqueBinaryPayload("image/png", b64("\x89PN"))).toBe(false)
    expect(isOpaqueBinaryPayload("image/png", "")).toBe(false)
  })

  test("a textual payload wearing a binary label is scanned, not skipped (finding)", () => {
    // The reviewer's bypass: data:image/png;base64,<base64("token=ghp_…")> —
    // MIME is unrestricted (an MCP resource can label anything image/png), and
    // trusting it sent the textual secret to the provider unscanned. The magic
    // check routes it to the byte-preserving scan instead.
    const redactor = mk()
    const url = `data:image/png;base64,${Buffer.from(`token=${FAKE_PAT}`, "latin1").toString("base64")}`
    const part = { id: "p", type: "file", mime: "image/png", url }
    expect(redactor.redactPartsInPlace([part])).toBe(1)
    expect(part.url.startsWith("data:image/png;base64,")).toBe(true)
    const decoded = Buffer.from(
      part.url.split(",")[1] as string,
      "base64",
    ).toString("latin1")
    expect(decoded).not.toContain(FAKE_PAT)
    expect(decoded).toContain("[REDACTED-SECRET:github-pat:")
    // A REAL png carrying the same byte run stays untouched (see the opaque
    // round-trip assertions in "a textual base64 data: attachment…" above).
  })

  test("a mislabeled application/octet-stream text file is scanned (finding)", () => {
    // octet-stream is the default guess for any unknown file, so textual
    // content lands under it constantly; it has no magic to confirm, so it
    // never fast-skips.
    const redactor = mk()
    const url = `data:application/octet-stream;base64,${Buffer.from(`key = ${FAKE_PAT}\n`, "latin1").toString("base64")}`
    const part = {
      id: "p",
      type: "file",
      mime: "application/octet-stream",
      url,
    }
    expect(redactor.redactPartsInPlace([part])).toBe(1)
    const decoded = Buffer.from(
      part.url.split(",")[1] as string,
      "base64",
    ).toString("latin1")
    expect(decoded).not.toContain(FAKE_PAT)
  })

  test("a base64 PDF attachment with a literal credential is decoded and scanned (finding)", () => {
    // The reviewer's leak: application/pdf was fast-skipped as opaque bytes, yet
    // OpenCode treats a PDF as media and forwards it to capable providers, which
    // extract its text. A credential sitting as a literal string in the PDF (an
    // uncompressed content stream or metadata) is provider-readable, so it must
    // be caught. A minimal PDF body carrying the PAT verbatim stands in for that.
    const redactor = mk()
    const pdf = Buffer.from(
      `%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n2 0 obj<</Token(${FAKE_PAT})>>endobj\n%%EOF\n`,
      "latin1",
    )
    const part = {
      id: "p",
      type: "file",
      mime: "application/pdf",
      url: `data:application/pdf;base64,${pdf.toString("base64")}`,
    }
    expect(redactor.redactPartsInPlace([part])).toBe(1)
    const decoded = Buffer.from(
      part.url.split(",")[1] as string,
      "base64",
    ).toString("latin1")
    expect(decoded).not.toContain(FAKE_PAT)
    expect(decoded).toContain("[REDACTED-SECRET:github-pat:")
    // Still a valid PDF data url (structure preserved around the redacted span).
    expect(part.url.startsWith("data:application/pdf;base64,")).toBe(true)
    expect(decoded.startsWith("%PDF-1.4")).toBe(true)
  })

  test("a clean binary PDF with no credential round-trips byte-identically", () => {
    // Un-skipping PDF must not corrupt clean ones: a byte-preserving scan that
    // matches nothing returns the payload untouched.
    const redactor = mk()
    const pdf = Buffer.from([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0xff, 0xfe, 0x01,
      0x02,
    ])
    const url = `data:application/pdf;base64,${pdf.toString("base64")}`
    const part = { id: "p", type: "file", mime: "application/pdf", url }
    expect(redactor.redactPartsInPlace([part])).toBe(0)
    expect(part.url).toBe(url)
  })

  test("redactValueInPlace scans every string with no key policy", () => {
    const redactor = mk()
    const body = { url: `https://host/api?token=${FAKE_PAT}` }
    expect(redactor.redactValueInPlace(body)).toBe(1)
    expect(body.url).not.toContain(FAKE_PAT)
  })

  test("restoreValueInPlace restores nested tool args in place", () => {
    const redactor = mk()
    const placeholder = placeholderOf(redactor.redactString(`x=${FAKE_PAT}`))
    const args = {
      command: `curl -H "Authorization: ${placeholder}"`,
      nested: { list: [placeholder] },
    }
    const count = redactor.restoreValueInPlace(args)
    expect(count).toBe(2)
    expect(args.command).toContain(FAKE_PAT)
    expect(args.nested.list[0]).toBe(FAKE_PAT)
  })
})

describe("walker bounds (fail closed)", () => {
  // A pathological structure must ABORT the walk (WalkLimitError), never
  // degrade to skipping the branch that tripped the limit — a skipped branch
  // is a fail-open path for whatever secret it holds. A cycle needs no
  // dedicated detection: every lap deepens the walk until the depth ceiling
  // throws.
  const nested = (depth: number, leaf: unknown): unknown => {
    let value: unknown = leaf
    for (let i = 0; i < depth; i++) value = { a: value }
    return value
  }

  test("redaction and restore still work well below the bound", () => {
    const redactor = mk()
    const value = nested(500, { token: `use ${FAKE_PAT}` }) as Record<
      string,
      unknown
    >
    expect(redactor.redactValueInPlace(value)).toBe(1)
    expect(JSON.stringify(value)).not.toContain(FAKE_PAT)
    // Bound symmetry: anything the redaction walk accepted, restore can walk.
    expect(redactor.restoreValueInPlace(value)).toBe(1)
    expect(JSON.stringify(value)).toContain(FAKE_PAT)
  })

  test("nesting beyond MAX_WALK_DEPTH throws instead of skipping the branch", () => {
    const redactor = mk()
    const value = nested(MAX_WALK_DEPTH + 50, { token: FAKE_PAT })
    expect(() => redactor.redactValueInPlace(value)).toThrow(WalkLimitError)
  })

  test("an object cycle throws in the redaction walk", () => {
    const redactor = mk()
    const value: Record<string, unknown> = { note: `token=${FAKE_PAT}` }
    value.self = value
    expect(() => redactor.redactValueInPlace(value)).toThrow(WalkLimitError)
  })

  test("an array cycle throws in the redaction walk", () => {
    const redactor = mk()
    const value: unknown[] = []
    value.push(value)
    expect(() => redactor.redactValueInPlace(value)).toThrow(WalkLimitError)
  })

  test("a cyclic tool part throws in redactPartsInPlace", () => {
    // Cycles through the part walkers too (redactPart ↔ redactToolState),
    // which recurse without ever touching redactWalk.
    const redactor = mk()
    const state: Record<string, unknown> = { status: "completed" }
    const part = { id: "p1", type: "tool", tool: "demo", state }
    state.attachments = [part]
    expect(() => redactor.redactPartsInPlace([part])).toThrow(WalkLimitError)
  })

  test("deep nesting inside tool state throws in redactPartsInPlace", () => {
    const redactor = mk()
    const part = {
      id: "p1",
      type: "tool",
      tool: "demo",
      state: { status: "completed", input: nested(MAX_WALK_DEPTH + 50, "x") },
    }
    expect(() => redactor.redactPartsInPlace([part])).toThrow(WalkLimitError)
  })

  test("the restore walk is bounded the same way (deep + cyclic)", () => {
    const redactor = mk()
    expect(() =>
      redactor.restoreValueInPlace(nested(MAX_WALK_DEPTH + 50, "text")),
    ).toThrow(WalkLimitError)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => redactor.restoreValueInPlace(cyclic)).toThrow(WalkLimitError)
    expect(() => redactor.collectUnresolved(cyclic)).toThrow(WalkLimitError)
  })

  test("a path-exploding shared-node DAG trips the visit budget", () => {
    // Depth cannot catch this shape: 25 levels of two-element arrays sharing
    // both children give ~2^25 root-to-leaf paths at trivial depth, and the
    // walkers deliberately keep no visited set (a shared node must rescan
    // under each parent's key context). Constant allocation — the previous
    // wide-array form materialized MAX_WALK_VISITS elements and dominated
    // the suite's memory ceiling.
    const redactor = mk()
    let node: unknown = [0, 1]
    for (let i = 0; i < 25; i++) node = [node, node]
    expect(() => redactor.redactValueInPlace({ tree: node })).toThrow(
      WalkLimitError,
    )
  })

  test("string leaves charge the same visit budget as any other node (finding)", () => {
    // Strings are scanned inline by their containing walker; before the fix
    // they consumed no budget, so a structure of MAX_WALK_VISITS+ string
    // leaves — the costliest leaf type — walked unbounded while the same
    // width of numbers threw. Shared rows keep the allocation tiny; the
    // all-array shape (no object keys anywhere) and a leaf long enough to
    // cache (≥ CACHE_MIN_LENGTH) keep every leaf on the cached redactString
    // fast path, so the test exercises the BUDGET, not the scanner.
    const redactor = mk()
    const leaf =
      "an entirely inert prose leaf with no secret material anywhere in it. ".repeat(
        4,
      )
    const row = new Array(1000).fill(leaf)
    const wide = new Array(Math.ceil(MAX_WALK_VISITS / row.length) + 5).fill(
      row,
    )
    expect(() => redactor.redactValueInPlace(wide)).toThrow(WalkLimitError)
  })
})

describe("percentDecodeTolerant", () => {
  test("matches decodeURIComponent on well-formed input", () => {
    const encoded = "a%20b%2Fc%F0%9F%90%8Dd" // space, slash, astral emoji
    expect(percentDecodeTolerant(encoded)).toBe(decodeURIComponent(encoded))
    expect(percentDecodeTolerant("no escapes at all")).toBe("no escapes at all")
  })

  test("malformed escapes pass through literally without shielding valid runs", () => {
    // %va is not an escape (v is not hex) — it stays literal while the valid
    // run after it still decodes; decodeURIComponent would throw on the whole
    // string.
    expect(percentDecodeTolerant("100%valid %68%69")).toBe("100%valid hi")
    expect(percentDecodeTolerant("%")).toBe("%")
    expect(percentDecodeTolerant("trailing%2")).toBe("trailing%2")
  })

  test("an invalid-UTF-8 run falls back to byte-exact latin1 without breaking its neighbors", () => {
    // %FF%68%69 is one run of bytes ff 68 69 — not well-formed UTF-8, so the
    // run reads as latin1 ("ÿhi"); the separate emoji run still decodes as
    // UTF-8.
    expect(percentDecodeTolerant("%FF%68%69 %F0%9F%90%8D")).toBe(
      "\xffhi \u{1F40D}",
    )
  })
})

describe("field-name context (structured objects)", () => {
  // A generic value with no shape prefix and no keyword of its own: only the
  // FIELD NAME satisfies the keyword-gated generic-api-key rule, so scanning
  // the value alone misses it and the reconstructed "key=value" line catches it.
  const GENERIC = "x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce"

  test("the generic secret is inert on its own but caught under a keyword key", () => {
    const redactor = mk()
    // Bare value: no rule fires (this is the gap the field name closes).
    expect(redactor.redactString(GENERIC)).toBe(GENERIC)
    // Under a keyword-bearing key, the value is redacted.
    const obj = { api_key: GENERIC }
    expect(redactor.redactValueInPlace(obj)).toBe(1)
    expect(obj.api_key).toContain("[REDACTED-SECRET:generic-api-key:")
  })

  test("a value under a non-keyword key is left alone (no over-redaction)", () => {
    const redactor = mk()
    const obj = { label: GENERIC, note: "just some prose about the project" }
    expect(redactor.redactValueInPlace(obj)).toBe(0)
    expect(obj.label).toBe(GENERIC)
  })

  test("string elements of an array inherit the enclosing field name", () => {
    const redactor = mk()
    const obj = { api_keys: [GENERIC, "another harmless string"] }
    redactor.redactValueInPlace(obj)
    expect(obj.api_keys[0]).toContain("[REDACTED-SECRET:generic-api-key:")
  })

  test("a [key, value] tuple's value inherits the key element as context (finding)", () => {
    // The reviewer's leak: {"headers":[["api_key","x7k2…"]]}. Both tuple elements
    // used to be scanned only under "headers", so the keyword-gated rule never
    // fired. The value element must additionally see "api_key" — its sibling —
    // exactly as if it had been {"api_key":"x7k2…"}.
    const redactor = mk()
    const obj = { headers: [["api_key", GENERIC]] }
    expect(redactor.redactValueInPlace(obj)).toBe(1)
    expect(obj.headers[0]?.[0]).toBe("api_key") // the key element is untouched
    expect(obj.headers[0]?.[1]).toContain("[REDACTED-SECRET:generic-api-key:")
  })

  test("a top-level [key, value] pair and a list of pairs both redact", () => {
    const redactor = mk()
    const single = ["api_key", GENERIC]
    const list = [
      ["content-type", "application/json"],
      ["x-api-key", GENERIC],
    ]
    expect(redactor.redactValueInPlace(single)).toBe(1)
    expect(single[1]).toContain("[REDACTED-SECRET:generic-api-key:")
    expect(redactor.redactValueInPlace(list)).toBe(1)
    expect(list[0]?.[1]).toBe("application/json") // no keyword next to it → untouched
    expect(list[1]?.[1]).toContain("[REDACTED-SECRET:generic-api-key:")
  })

  test("pair context is additive: a value array with a keyword enclosing key still redacts every element", () => {
    // The additive rule must not REINTERPRET a value list as a key/value pair:
    // {"api_keys":[a,b]} has no key element, so both values keep the "api_keys"
    // context. Element 0 (the "pair key" slot) must still be redacted.
    const redactor = mk()
    const obj = { api_keys: [GENERIC, GENERIC] }
    expect(redactor.redactValueInPlace(obj)).toBe(2)
    expect(obj.api_keys[0]).toContain("[REDACTED-SECRET:generic-api-key:")
    expect(obj.api_keys[1]).toContain("[REDACTED-SECRET:generic-api-key:")
  })

  test("a pair whose key element carries no rule keyword adds no signal", () => {
    // No over-redaction: a plain 2-tuple of unrelated strings is left alone when
    // neither the key element nor the enclosing key is a keyword.
    const redactor = mk()
    const obj = { coords: ["37.7749", GENERIC] }
    expect(redactor.redactValueInPlace(obj)).toBe(0)
    expect(obj.coords[1]).toBe(GENERIC)
  })

  test("a nested object's own keys still govern first", () => {
    const redactor = mk()
    const obj = { outer: { secret: GENERIC } }
    expect(redactor.redactValueInPlace(obj)).toBe(1)
    expect(obj.outer.secret).toContain("[REDACTED-SECRET:generic-api-key:")
  })

  test("a nested value inherits its PARENT key as context (finding)", () => {
    // The reviewer's leaks: the keyword sits one level ABOVE the leaf.
    // {"credentials":{"production":…}} and a JSON Schema's
    // {"properties":{"api_key":{"default":…}}} carry no keyword on the leaf
    // key, so the old immediate-key-only walk scanned the value bare and
    // missed both. A value now inherits its nearest ancestor key too.
    const redactor = mk()
    const creds = { credentials: { production: GENERIC } }
    expect(redactor.redactValueInPlace(creds)).toBe(1)
    expect(creds.credentials.production).toContain(
      "[REDACTED-SECRET:generic-api-key:",
    )
    const schema = { properties: { api_key: { default: GENERIC } } }
    expect(redactor.redactValueInPlace(schema)).toBe(1)
    expect(schema.properties.api_key.default).toContain(
      "[REDACTED-SECRET:generic-api-key:",
    )
  })

  test("ancestor inheritance is bounded to ONE level (no container over-redaction)", () => {
    // The adversarially-reproduced cost of unbounded inheritance: clean
    // high-entropy identifiers two levels under a keyword-bearing CONTAINER
    // ({"api":{"response":{"trace_id":…}}}, session ids under "auth", etags
    // under "access") were mass-redacted as generic-api-key. A keyword two
    // levels up is a container, not an assignment — flat scanning would never
    // bridge that structure either — so only the immediate parent inherits.
    const redactor = mk()
    const samples = [
      { api: { response: { trace_id: "4bf92f3577b34da6a3ce929d0e0e4736" } } },
      { auth: { session: { id: "b3d4f7a9c2e14f68a1d2b3c4d5e6f708" } } },
      { access: { object: { etag: "9cbb659014546e59a1d2b3c4d5e6f708" } } },
      { api: { meta: { idempotency: "a1d2b3c4d5e6f7089cbb659014546e59" } } },
    ]
    for (const sample of samples) {
      expect(redactor.redactValueInPlace(sample)).toBe(0)
    }
  })

  test("a nested value with no keyword anywhere on its path is left alone (no over-redaction)", () => {
    const redactor = mk()
    const obj = { outer: { inner: { label: GENERIC } } }
    expect(redactor.redactValueInPlace(obj)).toBe(0)
    expect(obj.outer.inner.label).toBe(GENERIC)
  })

  test("a pair's OBJECT value descends with the pair key on the path", () => {
    // [["credentials", {…}]] is the tuple shape of {"credentials":{…}}, so the
    // object's strings must see "credentials" exactly as the nested-object
    // case above does.
    const redactor = mk()
    const obj = { rows: [["credentials", { production: GENERIC }]] }
    expect(redactor.redactValueInPlace(obj)).toBe(1)
    const pair = obj.rows[0] as [string, { production: string }]
    expect(pair[1].production).toContain("[REDACTED-SECRET:generic-api-key:")
  })

  test("a secret sitting in a PROPERTY NAME is redacted and round-trips", () => {
    // An api-key-indexed map: the credential is the key, not the value. It must
    // be masked outbound, and restore must be symmetric so it comes back.
    const redactor = mk()
    const obj: Record<string, unknown> = { [FAKE_PAT]: { label: "prod" } }
    expect(redactor.redactValueInPlace(obj)).toBe(1)
    const keys = Object.keys(obj)
    expect(keys[0]).toContain("[REDACTED-SECRET:github-pat:")
    expect(keys[0]).not.toContain(FAKE_PAT)
    redactor.restoreValueInPlace(obj)
    expect(Object.keys(obj)[0]).toBe(FAKE_PAT)
  })

  test("restore keeps a placeholder key when its raw secret already names a sibling (finding)", () => {
    // The restore walk (shared.ts:1864) renames a placeholder-valued KEY back to
    // its raw secret, but only when that name is free; on collision it KEEPS the
    // placeholder key so a value can never be clobbered (the opposite of
    // redactWalk, which DROPS — that direction is pinned at :1538). Making the
    // rename unconditional clobbers the raw-secret-keyed sibling's value with the
    // placeholder-keyed one — a silent value loss on the tool-arg restore path.
    const redactor = mk()
    // Learn the PAT's placeholder by redacting a throwaway holder.
    const holder: Record<string, unknown> = { [FAKE_PAT]: "seed" }
    redactor.redactValueInPlace(holder)
    const placeholder = Object.keys(holder)[0] as string
    expect(placeholder).not.toBe(FAKE_PAT)

    // Both the placeholder key AND its raw secret name a sibling in one object.
    const obj: Record<string, unknown> = {
      [placeholder]: "fromPlaceholder",
      [FAKE_PAT]: "existingSibling",
    }
    redactor.restoreValueInPlace(obj)
    // The placeholder key is kept verbatim (not renamed over the sibling)…
    expect(obj[placeholder]).toBe("fromPlaceholder")
    // …and the raw-secret sibling's value is untouched. Both survive.
    expect(obj[FAKE_PAT]).toBe("existingSibling")
  })

  test("restore DOES rename a placeholder key when the raw secret is free (negative control)", () => {
    // The other branch, pinned against the collision case above: with no
    // colliding sibling the key is renamed to the raw secret and its value moves.
    const redactor = mk()
    const holder: Record<string, unknown> = { [FAKE_PAT]: "seed" }
    redactor.redactValueInPlace(holder)
    const placeholder = Object.keys(holder)[0] as string
    const solo: Record<string, unknown> = { [placeholder]: "value" }
    redactor.restoreValueInPlace(solo)
    expect(Object.keys(solo)[0]).toBe(FAKE_PAT)
    expect(solo[FAKE_PAT]).toBe("value")
  })

  test("a PROPERTY NAME inherits the enclosing key as context (finding)", () => {
    // The reviewer's leak: {"api_keys": {"x7k2…": true}} — the map shape of
    // {"api_keys": ["x7k2…"]}. The generic secret carries no shape and no
    // keyword of its own, so scanning the name in isolation missed it; like an
    // array element, a property name must see the enclosing field name.
    const redactor = mk()
    const obj: { api_keys: Record<string, unknown> } = {
      api_keys: { [GENERIC]: true },
    }
    expect(redactor.redactValueInPlace(obj)).toBe(1)
    const keys = Object.keys(obj.api_keys)
    expect(keys[0]).toContain("[REDACTED-SECRET:generic-api-key:")
    expect(keys[0]).not.toContain(GENERIC)
    expect(obj.api_keys[keys[0] as string]).toBe(true)
    // Without keyword context the same name stays put (no over-redaction) —
    // on a FRESH redactor: the one above has already vaulted GENERIC, and a
    // known vault value is exact-match redacted context-free by design.
    const inert: Record<string, unknown> = { coords: { [GENERIC]: true } }
    expect(mk().redactValueInPlace(inert)).toBe(0)
  })

  test("a secret property name is dropped, not retained, when its placeholder already names a sibling", () => {
    // The reviewer's fail-open: an object holding BOTH a secret-valued key and a
    // sibling equal to that secret's placeholder. The old collision guard kept
    // the raw key while still counting a redaction, so the secret serialized in
    // full. It must fail CLOSED: the raw key is dropped regardless.
    const redactor = mk()
    const placeholder = placeholderOf(redactor.redactString(FAKE_PAT))
    const obj: Record<string, unknown> = {
      [FAKE_PAT]: "v1",
      [placeholder]: "v2",
    }
    redactor.redactValueInPlace(obj)
    // The raw secret key is gone from both the key set and the serialized form.
    expect(Object.keys(obj)).not.toContain(FAKE_PAT)
    expect(JSON.stringify(obj)).not.toContain(FAKE_PAT)
    // The pre-existing placeholder sibling is left intact (not clobbered).
    expect(obj[placeholder]).toBe("v2")
  })

  test("the field-name path does not disturb shape-detectable secrets", () => {
    // FAKE_PAT is caught by its own shape whether or not the key is a keyword;
    // the two scans must union to exactly one redaction, not double-count.
    const redactor = mk()
    const obj = { token: FAKE_PAT }
    expect(redactor.redactValueInPlace(obj)).toBe(1)
    expect(obj.token).toContain("[REDACTED-SECRET:github-pat:")
  })
})

describe("wire body rewrite", () => {
  test("returns the identical string when nothing needs redaction", () => {
    const redactor = mk()
    const body = JSON.stringify({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
    })
    expect(redactor.redactJsonBody(body)).toBe(body)
    expect(redactor.redactJsonBody("not json at all")).toBe("not json at all")
  })

  test("redacts string values anywhere in the body", () => {
    const redactor = mk()
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: `key: ${FAKE_PAT}` }] },
      ],
    })
    const rewritten = redactor.redactJsonBody(body)
    expect(rewritten).not.toContain(FAKE_PAT)
    const parsed = JSON.parse(rewritten) as {
      messages: [{ content: [{ text: string }] }]
    }
    expect(parsed.messages[0].content[0].text).toContain(
      "[REDACTED-SECRET:github-pat:",
    )
  })

  test("a keyword in one body string gates a rule in a sibling string (finding)", () => {
    // The surfaces only this backstop covers (MCP tool definitions, the
    // StructuredOutput schema) never pass a note-taking hook, so the body must
    // seed its own request-wide keyword gate before the walk. The token string
    // comes FIRST here to prove the note precedes the walk — a keyword found
    // later in the body must still cover it.
    const redactor = mk()
    const fbToken = "123456789012345|a1b2c3d4e5f6g7h8i9j0k1l2m3n"
    const body = JSON.stringify({
      tools: [
        {
          input_schema: {
            properties: { value: { default: `access = ${fbToken}\n` } },
          },
        },
        { description: "facebook token follows" },
      ],
    })
    const rewritten = redactor.redactJsonBody(body)
    expect(rewritten).not.toContain(fbToken)
    expect(rewritten).toContain("[REDACTED-SECRET:")
  })

  test("redacts a generic secret nested in a tool_use.input object", () => {
    // The gap the reviewer reproduced: an assistant tool call whose input is a
    // native JSON object {"api_key":"x7k2…"}. The value carries no shape and no
    // keyword — only the property name does — so the deep walker missed it.
    const redactor = mk()
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              input: { api_key: "x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce" },
            },
          ],
        },
      ],
    })
    const rewritten = redactor.redactJsonBody(body)
    expect(rewritten).not.toContain("x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce")
    expect(rewritten).toContain("[REDACTED-SECRET:generic-api-key:")
  })

  test("redacts a generic secret carried in a [key, value] tuple (finding)", () => {
    // The reviewer's second wire-path gap: tool input whose headers/params are
    // represented as pair arrays, not objects — {"headers":[["api_key","x7k2…"]]}.
    // The value element must inherit "api_key" from its sibling.
    const redactor = mk()
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              input: {
                headers: [["api_key", "x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce"]],
              },
            },
          ],
        },
      ],
    })
    const rewritten = redactor.redactJsonBody(body)
    expect(rewritten).not.toContain("x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce")
    expect(rewritten).toContain("[REDACTED-SECRET:generic-api-key:")
    // The key element is preserved so the header still names its value.
    expect(
      JSON.parse(rewritten).messages[0].content[0].input.headers[0][0],
    ).toBe("api_key")
  })

  test("redacts a generic secret whose keyword sits on an ANCESTOR key (finding)", () => {
    // The walker is shared with the message transform, so without ancestor
    // context the wire backstop could not recover {"credentials":
    // {"production":…}} either — the same miss at both layers.
    const redactor = mk()
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              input: {
                credentials: { production: "x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce" },
              },
            },
          ],
        },
      ],
    })
    const rewritten = redactor.redactJsonBody(body)
    expect(rewritten).not.toContain("x7k2mq9pl4vn8rt3wy6bj1hf5ds0azce")
    expect(rewritten).toContain("[REDACTED-SECRET:generic-api-key:")
  })

  test("a keyword anywhere in the body gates a token elsewhere, duplicate keys included", () => {
    // The body is noted as its raw pre-parse bytes, so a keyword survives even
    // where JSON.parse would shadow it (audit-review regression guard): the
    // gate must span the whole request the way the pre-M7 whole-body note did.
    const redactor = mk()
    const fbToken = "123456789012345|a1b2c3d4e5f6g7h8i9j0k1l2m3n"
    const body = JSON.stringify({
      messages: [{ role: "user", content: `access = ${fbToken}\n` }],
      system: "facebook token follows",
    })
    const rewritten = redactor.redactJsonBody(body)
    expect(rewritten).not.toContain(fbToken)
    expect(rewritten).toContain("[REDACTED-SECRET:")

    // A keyword present ONLY in a duplicate/shadowed key still gates: the raw
    // body carries it even though the parse drops it.
    const shadow = mk()
    const dupBody = `{"note":"facebook","note":"","msg":"access = ${fbToken}\\n"}`
    const shadowed = shadow.redactJsonBody(dupBody)
    expect(shadowed).not.toContain(fbToken)
  })
})

describe("wire request bodies (non-string shapes, audit L-RS3)", () => {
  const secretBody = () =>
    JSON.stringify({
      messages: [{ role: "user", content: `key: ${FAKE_PAT}` }],
    })
  const cleanBody = () =>
    JSON.stringify({ messages: [{ role: "user", content: "hello" }] })
  const decode = (bytes: unknown) =>
    new TextDecoder().decode(bytes as Uint8Array)

  test("a Uint8Array JSON body is inspected like a string body (finding)", async () => {
    const redactor = mk()
    const callerHeaders = {
      "content-type": "application/json",
      "content-length": "999",
    }
    const init = {
      method: "POST",
      body: new TextEncoder().encode(secretBody()),
      headers: callerHeaders,
    }
    const result = await redactWireRequest(
      redactor,
      "https://api.example/v1",
      init as RequestInit,
    )
    expect(result.redacted).toBe(true)
    const sent = decode(result.init?.body)
    expect(sent).not.toContain(FAKE_PAT)
    expect(sent).toContain("[REDACTED-SECRET:github-pat:")
    expect(
      Object.keys(result.init?.headers as Record<string, string>),
    ).not.toContain("content-length")
    // The caller's init and nested headers stay whole (audit L-RS4).
    expect(callerHeaders["content-length"]).toBe("999")
    expect(init.body).toEqual(new TextEncoder().encode(secretBody()))
  })

  test("clean bytes pass through untouched — the exact init, byte-identical", async () => {
    const redactor = mk()
    const bytes = new TextEncoder().encode(cleanBody())
    const init = { body: bytes }
    const result = await redactWireRequest(
      redactor,
      "https://api.example/v1",
      init as RequestInit,
    )
    expect(result.redacted).toBe(false)
    expect(result.init).toBe(init as RequestInit)
    expect(result.init?.body).toBe(bytes)
  })

  test("ArrayBuffer and DataView bodies are inspected too", async () => {
    const redactor = mk()
    const encoded = new TextEncoder().encode(secretBody())
    const buffer = encoded.buffer.slice(0) as ArrayBuffer
    const asBuffer = await redactWireRequest(redactor, "u", {
      body: buffer,
    } as RequestInit)
    expect(asBuffer.redacted).toBe(true)
    expect(decode(asBuffer.init?.body)).not.toContain(FAKE_PAT)

    const view = new DataView(encoded.buffer.slice(0))
    const asView = await redactWireRequest(mk(), "u", {
      body: view,
    } as unknown as RequestInit)
    expect(asView.redacted).toBe(true)
    expect(decode(asView.init?.body)).not.toContain(FAKE_PAT)
  })

  test("a Blob JSON body is redacted into a Blob of the same type; a clean one passes as itself", async () => {
    const blob = new Blob([secretBody()], { type: "application/json" })
    const result = await redactWireRequest(mk(), "u", {
      body: blob,
    } as RequestInit)
    expect(result.redacted).toBe(true)
    const sent = result.init?.body as Blob
    expect(sent.type).toBe(blob.type) // the runtime may normalize (charset suffix); preserved either way
    const text = await sent.text()
    expect(text).not.toContain(FAKE_PAT)
    expect(text).toContain("[REDACTED-SECRET:github-pat:")

    const clean = new Blob([cleanBody()], { type: "application/json" })
    const cleanResult = await redactWireRequest(mk(), "u", {
      body: clean,
    } as RequestInit)
    expect(cleanResult.redacted).toBe(false)
    expect(cleanResult.init?.body).toBe(clean)
  })

  test("a ReadableStream body is buffered and inspected; consumption is repaired with its own bytes", async () => {
    const stream = new Response(secretBody()).body
    const result = await redactWireRequest(mk(), "u", {
      body: stream,
    } as unknown as RequestInit)
    expect(result.redacted).toBe(true)
    expect(decode(result.init?.body)).toContain("[REDACTED-SECRET:github-pat:")

    // Clean stream: inspecting consumed it, so the buffered original bytes
    // must stand in as the body — same content, Content-Length untouched.
    const clean = new Response(cleanBody()).body
    const cleanResult = await redactWireRequest(mk(), "u", {
      body: clean,
    } as unknown as RequestInit)
    expect(cleanResult.redacted).toBe(false)
    expect(decode(cleanResult.init?.body)).toBe(cleanBody())
  })

  test("async-iterable bodies (async generator, Node Readable) are buffered and inspected (finding)", async () => {
    // fetch accepts these as bodies too; the string-only fallback would have
    // forwarded them raw. Both are single-shot, so even a clean one forwards
    // its buffered bytes rather than the exhausted source.
    async function* gen(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode(secretBody())
    }
    const asGen = await redactWireRequest(mk(), "u", {
      body: gen(),
    } as unknown as RequestInit)
    expect(asGen.redacted).toBe(true)
    expect(decode(asGen.init?.body)).not.toContain(FAKE_PAT)
    expect(decode(asGen.init?.body)).toContain("[REDACTED-SECRET:github-pat:")

    const { Readable } = await import("node:stream")
    const readable = Readable.from([new TextEncoder().encode(secretBody())])
    const asNode = await redactWireRequest(mk(), "u", {
      body: readable,
    } as unknown as RequestInit)
    expect(asNode.redacted).toBe(true)
    expect(decode(asNode.init?.body)).toContain("[REDACTED-SECRET:github-pat:")

    async function* cleanGen(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode(cleanBody())
    }
    const clean = await redactWireRequest(mk(), "u", {
      body: cleanGen(),
    } as unknown as RequestInit)
    expect(clean.redacted).toBe(false)
    expect(decode(clean.init?.body)).toBe(cleanBody())
  })

  test("a body held by the Request itself is inspected; the original stays forwardable (finding)", async () => {
    const redactor = mk()
    const request = new Request("https://api.example/v1/messages", {
      method: "POST",
      body: secretBody(),
      headers: {
        "content-type": "application/json",
        "content-length": "123",
        "x-api-key": "k",
      },
    })
    const result = await redactWireRequest(redactor, request, undefined)
    expect(result.redacted).toBe(true)
    const sent = result.input as Request
    expect(sent).not.toBe(request)
    expect(sent.method).toBe("POST")
    expect(sent.url).toBe("https://api.example/v1/messages")
    const sentText = await sent.text()
    expect(sentText).not.toContain(FAKE_PAT)
    expect(sentText).toContain("[REDACTED-SECRET:github-pat:")
    expect(sent.headers.get("content-length")).toBeNull()
    expect(sent.headers.get("x-api-key")).toBe("k")
    // Only a clone was read — the caller's request must remain sendable.
    expect(request.bodyUsed).toBe(false)

    const cleanRequest = new Request("https://api.example/v1", {
      method: "POST",
      body: cleanBody(),
    })
    const cleanResult = await redactWireRequest(
      redactor,
      cleanRequest,
      undefined,
    )
    expect(cleanResult.redacted).toBe(false)
    expect(cleanResult.input).toBe(cleanRequest)
    expect(cleanRequest.bodyUsed).toBe(false)
  })

  test("UTF-16 JSON — BOM'd and BOM-less — is decoded, redacted, and re-encoded in kind (finding)", async () => {
    const toUtf16le = (text: string, bom: boolean): Uint8Array => {
      const chars = Buffer.from(text, "utf16le")
      return new Uint8Array(
        bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), chars]) : chars,
      )
    }
    const withBom = await redactWireRequest(mk(), "u", {
      body: toUtf16le(secretBody(), true),
    } as RequestInit)
    expect(withBom.redacted).toBe(true)
    const out = withBom.init?.body as Uint8Array
    expect([out[0], out[1]]).toEqual([0xff, 0xfe])
    const decoded = Buffer.from(out.subarray(2)).toString("utf16le")
    expect(decoded).not.toContain(FAKE_PAT)
    expect(decoded).toContain("[REDACTED-SECRET:github-pat:")

    // BOM-less UTF-16 must be sniffed BEFORE the UTF-8 attempt: NUL bytes are
    // valid UTF-8, so ASCII JSON in bare UTF-16 "successfully" decodes to
    // NUL-riddled text, fails JSON.parse, and would pass as not-JSON.
    const bare = await redactWireRequest(mk(), "u", {
      body: toUtf16le(secretBody(), false),
    } as RequestInit)
    expect(bare.redacted).toBe(true)
    expect(
      Buffer.from(bare.init?.body as Uint8Array).toString("utf16le"),
    ).not.toContain(FAKE_PAT)
  })

  test("a UTF-8 BOM survives a rewrite byte-for-byte", async () => {
    const bytes = new Uint8Array(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(secretBody()),
      ]),
    )
    const result = await redactWireRequest(mk(), "u", {
      body: bytes,
    } as RequestInit)
    expect(result.redacted).toBe(true)
    const out = result.init?.body as Uint8Array
    expect([out[0], out[1], out[2]]).toEqual([0xef, 0xbb, 0xbf])
    expect(Buffer.from(out.subarray(3)).toString("utf8")).toContain(
      "[REDACTED-SECRET:github-pat:",
    )
  })

  test("opaque binary passes untouched; a UTF-32 BOM fails closed (finding)", async () => {
    const redactor = mk()
    const binary = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x01,
    ])
    const init = { body: binary }
    const result = await redactWireRequest(redactor, "u", init as RequestInit)
    expect(result.redacted).toBe(false)
    expect(result.init).toBe(init as RequestInit)

    // A UTF-32 BOM claims a text encoding this runtime cannot decode — the
    // body may be JSON and cannot be inspected, so the request must abort.
    const utf32 = new Uint8Array([
      0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00,
    ])
    await expect(
      redactWireRequest(redactor, "u", { body: utf32 } as RequestInit),
    ).rejects.toThrow(UnscannableBodyError)
  })

  test("URLSearchParams and FormData — defined non-JSON formats — pass through as themselves", async () => {
    const params = new URLSearchParams({ q: "x" })
    const asParams = await redactWireRequest(mk(), "u", {
      body: params,
    } as RequestInit)
    expect(asParams.redacted).toBe(false)
    expect(asParams.init?.body).toBe(params)

    const form = new FormData()
    form.set("field", "value")
    const asForm = await redactWireRequest(mk(), "u", {
      body: form,
    } as RequestInit)
    expect(asForm.redacted).toBe(false)
    expect(asForm.init?.body).toBe(form)
  })

  test("a compressed body fails closed rather than shipping the secret inside it (finding)", async () => {
    // gzip bytes are invalid UTF-8, so byte sniffing alone called this opaque
    // binary and forwarded it — while the provider decompresses and reads the
    // credential perfectly well.
    const gzipped = Bun.gzipSync(new TextEncoder().encode(secretBody()))
    const init = {
      method: "POST",
      body: gzipped,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
    }
    await expect(
      redactWireRequest(mk(), "u", init as unknown as RequestInit),
    ).rejects.toThrow(UnscannableBodyError)

    // `identity` is not a compression — it must still be inspected.
    const identity = {
      body: new TextEncoder().encode(secretBody()),
      headers: {
        "content-type": "application/json",
        "content-encoding": "identity",
      },
    }
    const inspected = await redactWireRequest(
      mk(),
      "u",
      identity as unknown as RequestInit,
    )
    expect(inspected.redacted).toBe(true)
  })

  test("a body DECLARED as JSON never classifies as opaque binary (finding)", async () => {
    // One invalid UTF-8 byte inside a string made the fatal decoder give up,
    // and the body sailed through as "binary" — but a lenient decoder (what
    // every provider uses) still yields parseable JSON holding the credential.
    const json = new TextEncoder().encode(secretBody())
    const corrupted = new Uint8Array(json.length + 1)
    corrupted.set(json.subarray(0, 20), 0)
    corrupted[20] = 0xff
    corrupted.set(json.subarray(20), 21)
    const declared = {
      body: corrupted,
      headers: { "content-type": "application/json; charset=utf-8" },
    }
    await expect(
      redactWireRequest(mk(), "u", declared as unknown as RequestInit),
    ).rejects.toThrow(UnscannableBodyError)

    // Undeclared, the same bytes stay opaque binary: sniffing may only ever
    // narrow what an UNdeclared body is taken to be.
    const undeclared = await redactWireRequest(mk(), "u", {
      body: corrupted,
    } as RequestInit)
    expect(undeclared.redacted).toBe(false)
  })

  test("a charset outside the UTF families is read, and re-encoded only when it round-trips", async () => {
    const shiftJis = {
      body: new TextEncoder().encode(cleanBody()),
      headers: { "content-type": "text/plain; charset=shift_jis" },
    }
    // Clean: inspected and passed through byte-identical, no re-encode needed.
    const clean = await redactWireRequest(
      mk(),
      "u",
      shiftJis as unknown as RequestInit,
    )
    expect(clean.redacted).toBe(false)

    // ASCII JSON under an ASCII-transparent charset: the rewrite round-trips
    // through the declared decoder, so it is emitted rather than aborting the
    // request — aborting here regressed a case the pre-fix code handled
    // correctly (it decoded as UTF-8, redacted, re-encoded).
    const dirty = {
      body: new TextEncoder().encode(secretBody()),
      headers: { "content-type": "application/json; charset=shift_jis" },
    }
    const redacted = await redactWireRequest(
      mk(),
      "u",
      dirty as unknown as RequestInit,
    )
    expect(redacted.redacted).toBe(true)
    const sent = decode(redacted.init?.body)
    expect(sent).not.toContain(FAKE_PAT)
    expect(sent).toContain("[REDACTED-SECRET:github-pat:")

    // Genuine non-ASCII in that charset cannot be re-emitted as UTF-8 without
    // corrupting it, so THAT aborts instead of shipping mojibake.
    const japanese = Buffer.from("82a082a2", "hex") // shift_jis あい
    const mixed = new Uint8Array(
      Buffer.concat([
        Buffer.from(`{"note":"`),
        japanese,
        Buffer.from(`","k":"${FAKE_PAT}"}`),
      ]),
    )
    await expect(
      redactWireRequest(mk(), "u", {
        body: mixed,
        headers: { "content-type": "application/json; charset=shift_jis" },
      } as unknown as RequestInit),
    ).rejects.toThrow(UnscannableBodyError)

    // A charset label no decoder knows is unreadable — fail closed.
    const bogus = {
      body: new TextEncoder().encode(secretBody()),
      headers: { "content-type": "application/json; charset=x-not-a-charset" },
    }
    await expect(
      redactWireRequest(mk(), "u", bogus as unknown as RequestInit),
    ).rejects.toThrow(UnscannableBodyError)
  })

  test("BOM-less UTF-32 fails closed instead of being mistaken for UTF-16 (finding)", async () => {
    const toUtf32 = (text: string, littleEndian: boolean): Uint8Array => {
      const out = new Uint8Array(text.length * 4)
      for (let i = 0; i < text.length; i++)
        out[littleEndian ? i * 4 : i * 4 + 3] = text.charCodeAt(i)
      return out
    }
    // UTF-32LE `{` is 7B 00 00 00 — its first two bytes are exactly the
    // BOM-less UTF-16LE pattern, so it decoded as valid NUL-riddled UTF-16,
    // failed JSON.parse and was forwarded, while a UTF-32 consumer parsed the
    // credential out of it.
    for (const littleEndian of [true, false]) {
      const body = toUtf32(secretBody(), littleEndian)
      await expect(
        redactWireRequest(mk(), "u", { body } as RequestInit),
      ).rejects.toThrow(UnscannableBodyError)
    }
    // A declared UTF-32 charset is equally unreadable.
    const declared = {
      body: toUtf32(secretBody(), true),
      headers: { "content-type": "application/json; charset=utf-32le" },
    }
    await expect(
      redactWireRequest(mk(), "u", declared as unknown as RequestInit),
    ).rejects.toThrow(UnscannableBodyError)
  })

  test("a declared charset never disables encoding sniffing (finding)", async () => {
    // Guard on the fix itself: routing declared UTF-8 straight to the UTF-8
    // decoder skipped the BOM-less UTF-16/UTF-32 sniff, so adding
    // `; charset=utf-8` became a one-line way to switch the protection off —
    // and regressed a body the pre-existing sniffing already redacted.
    const utf16 = new Uint8Array(Buffer.from(secretBody(), "utf16le"))
    const sniffed = await redactWireRequest(mk(), "u", {
      body: utf16,
      headers: { "content-type": "application/json; charset=utf-8" },
    } as unknown as RequestInit)
    expect(sniffed.redacted).toBe(true)
    expect(
      Buffer.from(sniffed.init?.body as Uint8Array).toString("utf16le"),
    ).not.toContain(FAKE_PAT)

    // Same for UTF-32 under a UTF-8 label: it must still fail closed.
    const utf32 = new Uint8Array(secretBody().length * 4)
    for (let i = 0; i < secretBody().length; i++)
      utf32[i * 4] = secretBody().charCodeAt(i)
    await expect(
      redactWireRequest(mk(), "u", {
        body: utf32,
        headers: { "content-type": "application/json; charset=utf-8" },
      } as unknown as RequestInit),
    ).rejects.toThrow(UnscannableBodyError)
  })

  test("an EMPTY init.headers does not mask the Request's effective headers (finding)", async () => {
    // `new Request(req, {headers: {}})` KEEPS the request's headers in this
    // runtime, so treating any present collection as authoritative lost the
    // declared Content-Type and left a stale Content-Length in place.
    const corrupted = new Uint8Array([
      0x7b, 0xff, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d,
    ])
    const declaredJson = new Request("https://api.example/v1", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", "content-length": "2" },
    })
    // Declared JSON is still effective through the empty collection, so an
    // undecodable body must abort rather than pass as opaque binary.
    await expect(
      redactWireRequest(mk(), declaredJson, {
        headers: {},
        body: corrupted,
      } as unknown as RequestInit),
    ).rejects.toThrow(UnscannableBodyError)

    const stale = new Request("https://api.example/v1", {
      method: "POST",
      body: "{}",
      headers: { "content-length": "2", authorization: "Bearer t" },
    })
    const result = await redactWireRequest(mk(), stale, {
      headers: {},
      body: secretBody(),
    } as RequestInit)
    expect(result.redacted).toBe(true)
    const outbound = new Request(stale, result.init as RequestInit)
    expect(outbound.headers.get("content-length")).toBeNull()
    expect(outbound.headers.get("authorization")).toBe("Bearer t")
  })

  test("duplicate Content-Type headers still declare JSON (finding)", async () => {
    // Headers.get joins duplicates with ", ", which parsed to a subtype of
    // "json, application/json" and silently disabled the declared-JSON gate.
    const headers = new Headers()
    headers.append("content-type", "application/json")
    headers.append("content-type", "application/json")
    const corrupted = new Uint8Array([
      0x7b, 0xff, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d,
    ])
    await expect(
      redactWireRequest(mk(), "u", {
        body: corrupted,
        headers,
      } as unknown as RequestInit),
    ).rejects.toThrow(UnscannableBodyError)
  })

  test("binary bodies opening with a small int32 are NOT mistaken for UTF-32", async () => {
    // Guard on the UTF-32 fix itself, twice over: `20 00 00 00` is both a
    // UTF-32LE space and an ordinary little-endian int32 of 32, so a
    // shape-only rule turns pass-through binary into a hard request failure.
    // A one-unit rule tripped on a bare length prefix; widening to four units
    // still tripped on a RUN of small int32s, which is why the rule now
    // demands that the bytes actually decode as UTF-32 holding JSON.
    const shapes = [
      // A length prefix followed by high-byte payload.
      [
        0x20, 0, 0, 0, 0xff, 0x88, 0x01, 0x02, 0x99, 0xfe, 0x03, 0x04, 0x11,
        0x22, 0x33, 0x44,
      ],
      // A run of small little-endian int32s — valid UTF-32, but not JSON.
      [0x20, 0, 0, 0, 0x01, 0, 0, 0, 0x02, 0, 0, 0, 0x03, 0, 0, 0],
      [0x0a, 0, 0, 0, 0x04, 0, 0, 0, 0x04, 0, 0, 0, 0x04, 0, 0, 0],
      [0x7b, 0, 0, 0, 0x01, 0, 0, 0, 0x01, 0, 0, 0, 0x01, 0, 0, 0],
      [0x5b, 0, 0, 0, 0x02, 0, 0, 0, 0x02, 0, 0, 0, 0x02, 0, 0, 0],
    ]
    for (const shape of shapes) {
      const result = await redactWireRequest(mk(), "u", {
        body: new Uint8Array(shape),
      } as RequestInit)
      expect(result.redacted).toBe(false)
    }
  })

  // Not a regression test — the pre-fix code sniffed the BOM regardless of
  // the label, so this bug could only ever have existed inside the new
  // declared-charset branch. It is a guard on that branch.
  test("a declared UTF-16 charset honors a BOM of either endianness", async () => {
    // A body labelled utf-16 carrying a BIG-endian BOM is big-endian; reading
    // it the label's way yields U+FFFE garbage that fails JSON.parse and
    // passes unscanned.
    const be = Buffer.from(secretBody(), "utf16le")
    for (let i = 0; i + 1 < be.length; i += 2) {
      const swap = be[i] as number
      be[i] = be[i + 1] as number
      be[i + 1] = swap
    }
    const body = new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))
    const result = await redactWireRequest(mk(), "u", {
      body,
      headers: { "content-type": "application/json; charset=utf-16" },
    } as unknown as RequestInit)
    expect(result.redacted).toBe(true)
    const out = result.init?.body as Uint8Array
    expect([out[0], out[1]]).toEqual([0xfe, 0xff])
  })

  test("a rewritten body never ships under a stale Content-Length (finding)", async () => {
    // init.body overrides the Request's body while init carries NO headers —
    // so the Request's own (now wrong) Content-Length stays effective unless
    // the effective headers are resolved and returned.
    const request = new Request("https://api.example/v1", {
      method: "POST",
      body: "{}",
      headers: {
        "content-type": "application/json",
        "content-length": "2",
        authorization: "Bearer t",
      },
    })
    const result = await redactWireRequest(mk(), request, {
      body: secretBody(),
    } as RequestInit)
    expect(result.redacted).toBe(true)
    const outbound = new Request(request, result.init as RequestInit)
    expect(outbound.headers.get("content-length")).toBeNull()
    // Sanitizing must not cost the other headers.
    expect(outbound.headers.get("authorization")).toBe("Bearer t")
    expect(await outbound.text()).not.toContain(FAKE_PAT)

    // The inverse: the body comes from the Request, and init.headers — which
    // REPLACES the rebuilt request's headers at the inner fetch — carries the
    // stale length.
    const held = new Request("https://api.example/v1", {
      method: "POST",
      body: secretBody(),
    })
    const withInitHeaders = await redactWireRequest(mk(), held, {
      headers: { "content-length": "9999", authorization: "Bearer t" },
    } as RequestInit)
    expect(withInitHeaders.redacted).toBe(true)
    const sent = new Request(
      withInitHeaders.input as Request,
      withInitHeaders.init as RequestInit,
    )
    expect(sent.headers.get("content-length")).toBeNull()
    expect(sent.headers.get("authorization")).toBe("Bearer t")
    expect(await sent.text()).not.toContain(FAKE_PAT)
  })

  test("an oversized streaming body aborts instead of buffering without bound (finding)", async () => {
    // A stream fetch would have sent in bounded memory: inspection must not
    // turn it into an unbounded retention (or a hang on an endless producer).
    const chunk = new Uint8Array(1024 * 1024)
    let produced = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced++
        controller.enqueue(chunk)
      },
    })
    await expect(
      redactWireRequest(mk(), "u", { body: endless } as unknown as RequestInit),
    ).rejects.toThrow(OversizedBodyError)
    // Bounded by the budget, not by the producer running out.
    expect(produced * chunk.byteLength).toBeLessThan(
      MAX_WIRE_BODY_BYTES + 8 * chunk.byteLength,
    )

    const oversizedBlob = new Blob([new Uint8Array(8)])
    Object.defineProperty(oversizedBlob, "size", {
      value: MAX_WIRE_BODY_BYTES + 1,
    })
    await expect(
      redactWireRequest(mk(), "u", { body: oversizedBlob } as RequestInit),
    ).rejects.toThrow(OversizedBodyError)
  })

  test("a string body and an absent body behave exactly as before", async () => {
    const redactor = mk()
    const stringResult = await redactWireRequest(redactor, "u", {
      body: secretBody(),
    } as RequestInit)
    expect(stringResult.redacted).toBe(true)
    expect(stringResult.init?.body as string).toContain(
      "[REDACTED-SECRET:github-pat:",
    )

    const noBody = await redactWireRequest(redactor, "https://api.example/v1", {
      method: "GET",
    })
    expect(noBody.redacted).toBe(false)
    const noInit = await redactWireRequest(
      redactor,
      "https://api.example/v1",
      undefined,
    )
    expect(noInit.redacted).toBe(false)
  })
})

describe("dropContentLength", () => {
  // The wire wrapper shallow-copies the outer RequestInit but shares its
  // nested headers, so every representation must be COPIED before the delete
  // (audit L-RS4) — mutating the caller's instance leaked the deletion into
  // whatever the caller reuses those headers for.
  test("returns a Headers copy and never mutates the caller's instance (finding)", () => {
    const headers = new Headers({ "content-length": "10", accept: "a" })
    const copy = dropContentLength(headers) as Headers
    expect(copy).not.toBe(headers)
    expect(copy.has("content-length")).toBe(false)
    expect(copy.get("accept")).toBe("a")
    expect(headers.get("content-length")).toBe("10")
  })

  test("copies arrays and plain objects, leaving the originals whole", () => {
    const arrayInput = [
      ["Content-Length", "10"],
      ["accept", "a"],
    ]
    const asArray = dropContentLength(arrayInput) as string[][]
    expect(asArray).toEqual([["accept", "a"]])
    expect(arrayInput).toEqual([
      ["Content-Length", "10"],
      ["accept", "a"],
    ])

    const objectInput = { "Content-Length": "10", accept: "a" }
    const asObject = dropContentLength(objectInput) as Record<string, string>
    expect(asObject).toEqual({ accept: "a" })
    expect(asObject).not.toBe(objectInput)
    expect(objectInput).toEqual({ "Content-Length": "10", accept: "a" })

    expect(dropContentLength(undefined)).toBeUndefined()
  })

  // A Map is a valid HeadersInit that is neither array- nor plain-object-
  // shaped; the plain-object branch would drop every header (audit-review
  // regression guard). It must be copied as a Map, keeping Authorization.
  test("a Map keeps its other headers instead of collapsing to nothing (finding)", () => {
    const input = new Map([
      ["authorization", "Bearer tok"],
      ["Content-Length", "42"],
    ])
    const copy = dropContentLength(input) as Map<string, string>
    expect(copy).toBeInstanceOf(Map)
    expect(copy).not.toBe(input)
    expect(copy.get("authorization")).toBe("Bearer tok")
    expect(
      [...copy.keys()].some((key) => key.toLowerCase() === "content-length"),
    ).toBe(false)
    expect(input.get("Content-Length")).toBe("42") // original untouched
  })

  // The Map branch fixed one instance of this; every OTHER iterable pair
  // collection had the same defect, because WebIDL's sequence conversion
  // accepts any iterable while Object.entries() sees nothing enumerable on
  // one (audit review — a Set of tuples lost Authorization along with every
  // other header).
  test("a Set of tuples and a custom iterable keep their headers (finding)", () => {
    const asSet = new Set([
      ["authorization", "Bearer tok"],
      ["Content-Length", "42"],
    ])
    const fromSet = dropContentLength(asSet)
    expect(
      new Headers(fromSet as RequestInit["headers"]).get("authorization"),
    ).toBe("Bearer tok")
    expect(
      new Headers(fromSet as RequestInit["headers"]).has("content-length"),
    ).toBe(false)
    expect(asSet.size).toBe(2) // original untouched

    const custom = {
      *[Symbol.iterator]() {
        yield ["authorization", "Bearer tok"]
        yield ["content-length", "42"]
      },
    }
    const fromCustom = new Headers(
      dropContentLength(custom) as RequestInit["headers"],
    )
    expect(fromCustom.get("authorization")).toBe("Bearer tok")
    expect(fromCustom.has("content-length")).toBe(false)

    // Headers itself must still take the Headers branch, and a plain record
    // must not be mistaken for an iterable.
    expect(dropContentLength(new Headers({ accept: "a" }))).toBeInstanceOf(
      Headers,
    )
    expect(dropContentLength({ accept: "a" })).toEqual({ accept: "a" })
  })
})

describe("options", () => {
  test("defaults are safe and unknown input degrades to defaults", () => {
    expect(parseOptions(undefined)).toEqual(DEFAULT_OPTIONS)
    expect(parseOptions("garbage")).toEqual(DEFAULT_OPTIONS)
    expect(DEFAULT_OPTIONS.systemNote).toBe(true)
    expect(DEFAULT_OPTIONS.restoreText).toBe(true)
    expect(DEFAULT_OPTIONS.wireBackstop).toBe(true)
  })

  test("explicit values are honored", () => {
    const options = parseOptions({
      disabledRules: ["generic-api-key", 42],
      systemNote: false,
      restoreText: false,
      wireBackstop: false,
      wireSkipProviders: ["ollama"],
    })
    expect([...options.disabledRules]).toEqual(["generic-api-key"])
    expect(options.systemNote).toBe(false)
    expect(options.restoreText).toBe(false)
    expect(options.wireBackstop).toBe(false)
    expect(options.wireSkipProviders.has("ollama")).toBe(true)
  })
})

describe("unsafeWireProviders", () => {
  test("flags oauth-authed providers and always the fetch-owning built-ins", () => {
    const unsafe = unsafeWireProviders({
      openai: { type: "oauth", access: "x" },
      anthropic: { type: "api", key: "x" },
    })
    expect(unsafe.has("openai")).toBe(true)
    expect(unsafe.has("anthropic")).toBe(false)
    // These three get a host-installed fetch at assembly time — clobbering
    // it breaks their auth or request shaping, auth entry or not.
    for (const providerID of [
      "github-copilot",
      "google-vertex",
      "snowflake-cortex",
    ]) {
      expect(unsafe.has(providerID)).toBe(true)
      expect(unsafeWireProviders(undefined).has(providerID)).toBe(true)
    }
  })
})

// The filter itself is the library's since audit §2.3, and its host-parity
// table lives with it (libraries/permission-rules/test/auth-store.test.ts).
// What has to hold HERE is the thing this plugin does with the result: a
// dropped entry must stop marking a provider unsafe to wrap, and a kept one
// must survive as the raw entry the wire-backstop checks re-read.
describe("auth entry validation feeding the wire backstop", () => {
  test("the filter is the library's, re-exported", () => {
    expect(validAuthType).toBe(libraryValidAuthType)
    expect(validatedAuthStore).toBe(libraryValidatedAuthStore)
  })

  test("validatedAuthStore keeps valid entries and drops malformed ones", () => {
    const store = validatedAuthStore({
      openai: { type: "oauth" }, // stale, dropped
      anthropic: { type: "api", key: "sk-x" }, // kept
      mistral: { type: "oauth", refresh: "r", access: "a", expires: 0 }, // kept
      junk: "not-an-object", // dropped
    })
    expect(Object.keys(store).sort()).toEqual(["anthropic", "mistral"])
    // The kept entries are the raw ones (their type survives downstream checks).
    expect(unsafeWireProviders(store).has("mistral")).toBe(true)
    expect(unsafeWireProviders(store).has("anthropic")).toBe(false)
    // A dropped stale oauth entry no longer marks openai unsafe.
    expect(unsafeWireProviders(store).has("openai")).toBe(false)
  })
})

describe("catalogWireCandidates", () => {
  const catalog = {
    openai: { id: "openai", env: ["OPENAI_API_KEY"], models: {} },
    anthropic: { id: "anthropic", env: ["ANTHROPIC_API_KEY"], models: {} },
    mistral: { id: "mistral", env: ["MISTRAL_API_KEY"], models: {} },
  }

  test("catalog providers with a set env key are candidates", () => {
    const candidates = catalogWireCandidates(
      catalog,
      { OPENAI_API_KEY: "sk-x", UNRELATED: "y" },
      undefined,
    )
    expect([...candidates]).toEqual(["openai"])
  })

  test("an empty env value does not activate, mirroring the host's find(Boolean)", () => {
    expect(
      catalogWireCandidates(catalog, { OPENAI_API_KEY: "" }, undefined).size,
    ).toBe(0)
  })

  test("api-key auth entries count only for catalog providers; oauth and wellknown never do", () => {
    const candidates = catalogWireCandidates(
      catalog,
      {},
      {
        anthropic: { type: "api", key: "x" },
        mistral: { type: "oauth", access: "x" },
        openai: { type: "wellknown", key: "x", token: "t" },
        "my-local-proxy": { type: "api", key: "x" }, // not in the catalog: config-only provider
      },
    )
    expect([...candidates]).toEqual(["anthropic"])
  })

  test("junk shapes degrade to no candidates", () => {
    expect(
      catalogWireCandidates(undefined, { OPENAI_API_KEY: "x" }, undefined).size,
    ).toBe(0)
    expect(catalogWireCandidates("garbage", {}, undefined).size).toBe(0)
    expect(
      catalogWireCandidates(
        { openai: { env: "not-an-array" } },
        { OPENAI_API_KEY: "x" },
        undefined,
      ).size,
    ).toBe(0)
  })
})

describe("host environment mirrors", () => {
  test("runtimeFlagEnabled accepts exactly the host's truthy literals", () => {
    for (const enabled of ["true", "yes", "on", "1", "y"]) {
      expect(runtimeFlagEnabled(enabled)).toBe(true)
    }
    for (const disabled of [
      "false",
      "no",
      "off",
      "0",
      "n",
      "TRUE",
      " true",
      "",
      undefined,
    ]) {
      expect(runtimeFlagEnabled(disabled)).toBe(false)
    }
  })

  test("hasAuthEntry sees entries of any type and rejects junk shapes", () => {
    expect(hasAuthEntry({ openai: { type: "api", key: "x" } }, "openai")).toBe(
      true,
    )
    expect(
      hasAuthEntry(
        { openai: { type: "wellknown", key: "x", token: "t" } },
        "openai",
      ),
    ).toBe(true)
    expect(
      hasAuthEntry({ anthropic: { type: "api", key: "x" } }, "openai"),
    ).toBe(false)
    expect(hasAuthEntry({ openai: "not-an-entry" }, "openai")).toBe(false)
    expect(hasAuthEntry(undefined, "openai")).toBe(false)
    expect(hasAuthEntry(null, "openai")).toBe(false)
  })
})

describe("serializeForKeywordSweep", () => {
  test("provider-issued opaque payloads are dropped from the swept form", () => {
    // Shaped like the part that opened the sourcegraph gate on 2026-07-25:
    // a coincidental "sgp_" inside an encrypted reasoning blob.
    const message = {
      info: { id: "msg_1", sessionID: "ses_1" },
      parts: [
        {
          type: "reasoning",
          text: "**Investigating file hash naming**",
          metadata: {
            openai: {
              itemId: "rs_01bcac001ea0fa63016a6596efbf5c819aa7de5785645288af",
              reasoningEncryptedContent: "gAAAAABbOPA5Vsgf79wZsgp_C-4-GbcYhH",
            },
          },
        },
      ],
    }
    const swept = serializeForKeywordSweep(message)
    expect(swept).toBeDefined()
    expect(swept).toContain("Investigating file hash naming")
    expect(swept).not.toContain("sgp_")
    expect(swept).not.toContain("gAAAAAB")
  })

  test("ordinary fields — including ones holding real secrets — are kept", () => {
    expect(serializeForKeywordSweep({ text: "token: sgp_abcdef" })).toContain(
      "sgp_abcdef",
    )
  })

  test("every opaque key is matched case-insensitively, at the provider path", () => {
    for (const key of OPAQUE_PROVIDER_KEYS) {
      const swept = serializeForKeywordSweep({
        parts: [
          { metadata: { openai: { [key.toUpperCase()]: "sgp_secret" } } },
        ],
      })
      expect(swept).not.toContain("sgp_secret")
    }
  })

  test("opaque names OUTSIDE provider metadata still contribute keywords", () => {
    // These are ordinary application field names: a tool input's `signature`,
    // a tool output's `itemId`. Dropping them by name alone cost the sibling
    // strings of the request their cross-string gate (audit F3).
    const swept = serializeForKeywordSweep({
      parts: [
        {
          type: "tool",
          state: {
            input: { signature: "facebook token follows" },
            output: { itemId: "sourcegraph deploy id" },
          },
        },
      ],
    })
    expect(swept).toContain("facebook token follows")
    expect(swept).toContain("sourcegraph deploy id")
  })

  test("the drop is scoped to parts[].metadata, not to any nested metadata", () => {
    // `state.metadata` is tool output the host never hands back to a provider,
    // so it is content and must keep contributing keywords.
    const swept = serializeForKeywordSweep({
      parts: [
        {
          type: "tool",
          metadata: { openai: { signature: "sgp_provider_blob" } },
          state: { metadata: { signature: "facebook token follows" } },
        },
      ],
    })
    expect(swept).not.toContain("sgp_provider_blob")
    expect(swept).toContain("facebook token follows")
  })

  test("an unserializable value degrades to undefined, never a throw", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(serializeForKeywordSweep(cyclic)).toBeUndefined()
  })
})

describe("HistoryPins", () => {
  /** Store a pin and mark its scope delivered, as a completed request does. */
  const delivered = (
    pins: HistoryPins,
    scope: string,
    key: string,
    output: string,
    count = 0,
  ): void => {
    pins.set(scope, key, { output, count })
    pins.markDelivered(scope)
  }

  test("a pin is returned only for the scope that stored it", () => {
    const pins = new HistoryPins()
    delivered(pins, "ses_a", "key", "redacted-a", 1)
    expect(pins.get("ses_a", "key")?.output).toBe("redacted-a")
    // A different session is a different document and must not inherit a
    // decision made under an older rule set.
    expect(pins.get("ses_b", "key")).toBeUndefined()
  })

  test("an undelivered pin is invisible until its request is known to have landed", () => {
    // The transforms run before request construction and transport, so a pin
    // committed there describes an attempt, not a send. Until the provider
    // answers, the decision must not be reused (audit F6).
    const pins = new HistoryPins()
    pins.set("ses_a", "key", { output: "raw", count: 0 })
    expect(pins.get("ses_a", "key")).toBeUndefined()
    pins.markDelivered("ses_a")
    expect(pins.get("ses_a", "key")?.output).toBe("raw")
  })

  test("re-pinning a key returns it to undelivered", () => {
    const pins = new HistoryPins()
    delivered(pins, "s", "k", "first")
    pins.set("s", "k", { output: "second", count: 0 })
    expect(pins.get("s", "k")).toBeUndefined()
  })

  test("markDelivered on an unknown scope is a no-op, not a throw", () => {
    const pins = new HistoryPins()
    expect(() => pins.markDelivered("nobody")).not.toThrow()
  })

  test("pins evict oldest-first within a scope, re-touched on read", () => {
    const pins = new HistoryPins(2, 8)
    delivered(pins, "s", "a", "A")
    delivered(pins, "s", "b", "B")
    expect(pins.get("s", "a")?.output).toBe("A")
    delivered(pins, "s", "c", "C")
    // "b" was least recently used once "a" was re-touched above.
    expect(pins.get("s", "b")).toBeUndefined()
    expect(pins.get("s", "a")?.output).toBe("A")
    expect(pins.get("s", "c")?.output).toBe("C")
  })

  test("scopes evict oldest-first too, so a long-lived process stays bounded", () => {
    const pins = new HistoryPins(4, 2)
    delivered(pins, "s1", "k", "1")
    delivered(pins, "s2", "k", "2")
    delivered(pins, "s3", "k", "3")
    expect(pins.scopeCount).toBe(2)
    expect(pins.get("s1", "k")).toBeUndefined()
    expect(pins.get("s3", "k")?.output).toBe("3")
  })

  test("retention is byte-bounded, not only count-bounded", () => {
    // The count limits alone permit 2,048 surfaces in each of 64 scopes, and
    // one surface can be a multi-megabyte tool output (audit F8).
    const pins = new HistoryPins(1_000, 1_000, 512)
    for (let i = 0; i < 12; i++)
      delivered(pins, `s${i}`, `k${i}`, "x".repeat(100))
    expect(pins.byteCount).toBeLessThanOrEqual(512)
    // The most recent write always survives its own eviction pass.
    expect(pins.get("s11", "k11")?.output).toBe("x".repeat(100))
    expect(pins.get("s0", "k0")).toBeUndefined()
  })

  test("the key is hashed, so the pre-redaction bytes are not retained", () => {
    const pins = new HistoryPins()
    delivered(pins, "s", "sk-live-not-retained-anywhere", "out")
    // Cost accounting sees a fixed-width digest, never the caller's key.
    expect(pins.byteCount).toBe(
      "8".repeat(44).length + "out".length, // 44 = base64 of a sha-256 digest
    )
  })

  test("forget releases a deleted session outright", () => {
    const pins = new HistoryPins()
    delivered(pins, "gone", "k", "out")
    delivered(pins, "kept", "k", "out")
    pins.forget("gone")
    expect(pins.get("gone", "k")).toBeUndefined()
    expect(pins.get("kept", "k")?.output).toBe("out")
    expect(pins.scopeCount).toBe(1)
    expect(pins.byteCount).toBe(44 + "out".length)
  })

  test("forget on an unknown scope leaves accounting untouched", () => {
    const pins = new HistoryPins()
    delivered(pins, "s", "k", "out")
    const before = pins.byteCount
    pins.forget("nobody")
    expect(pins.byteCount).toBe(before)
    expect(pins.scopeCount).toBe(1)
  })
})

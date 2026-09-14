import { placeholderFor, secretHash } from "../src/shared"

/** Deterministic ~51 KB telemetry; no private incident data or real credentials. */
export function fingerprintLimitFixture(hashKey: string) {
  const secret = ["q7M2v9", "N4p8R1", "s6T0u3X"].join("")
  const ruleId = "generic-api-key"
  const entries = Array.from({ length: 8 }, (_, i) => {
    const length = 15 + i
    const value =
      length === secret.length ? secret : `${"x".repeat(length - 8)}m8N2p5Q9`
    return { hash: secretHash(value, hashKey), ruleId, length }
  })
  let state = 0x1badf00dn
  const rows = Array.from({ length: 1652 }, (_, i) => {
    state = BigInt.asUintN(
      64,
      state * 6364136223846793005n + 1442695040888963407n,
    )
    const digits = state.toString().padStart(20, "0").slice(-18)
    return `  "${i}": 0.${digits}`
  })
  const content = `{"metrics":{\n${rows.join(",\n")}\n},"saved":"${secret}"}`
  return {
    content,
    entries,
    secret,
    placeholder: placeholderFor(ruleId, secretHash(secret, hashKey)),
  }
}

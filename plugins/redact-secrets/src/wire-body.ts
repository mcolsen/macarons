import type { Redactor } from "./shared"

const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/**
 * Return a copy of a HeadersInit with any Content-Length removed, for use
 * after the body changed; the runtime recomputes the header from the
 * rewritten body. Every representation is CLONED before the delete (audit
 * L-RS4): the wire wrapper hands this the caller's own `init.headers` — the
 * outer RequestInit is spread-copied but nothing deep-copies its headers —
 * and mutating a caller-owned Headers instance (or plain object) would leak
 * the deletion into whatever the caller reuses it for. Callers invoke this
 * only when the body was actually rewritten, so untouched requests keep
 * their original headers object identity.
 */
export function dropContentLength(headers: unknown): unknown {
  if (!headers) return headers
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const copy = new Headers(headers)
    copy.delete("content-length")
    return copy
  }
  if (Array.isArray(headers)) {
    return headers.filter(
      (pair) =>
        !(
          Array.isArray(pair) &&
          String(pair[0]).toLowerCase() === "content-length"
        ),
    )
  }
  // A Map is a valid HeadersInit at the fetch layer but is not array- or
  // plain-object-shaped: Object.entries(map) is empty, so the object branch
  // below would silently return {} and STRIP EVERY HEADER (audit-review
  // regression guard — Authorization included). Copy it as a Map instead.
  if (typeof Map !== "undefined" && headers instanceof Map) {
    const copy = new Map<unknown, unknown>()
    for (const [key, value] of headers) {
      if (String(key).toLowerCase() !== "content-length") copy.set(key, value)
    }
    return copy
  }
  // Every OTHER iterable pair collection — a Set of [name, value] tuples, a
  // generator, any custom iterable — for the same reason (audit review): a
  // WebIDL `sequence<sequence<ByteString>>` conversion accepts ANY iterable,
  // so fetch takes these, while Object.entries() sees no enumerable string
  // keys and the record branch below would return {} and strip every header.
  // The Map branch above fixed one instance of this bug; this closes the
  // class. Emitted as an array of pairs (itself a valid HeadersInit) rather
  // than a Headers clone, so values pass through without Headers'
  // name-lowercasing and duplicate-joining.
  if (
    typeof headers === "object" &&
    typeof (headers as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
      "function"
  ) {
    const pairs: unknown[] = []
    for (const entry of headers as Iterable<unknown>) {
      // A pair may itself be any iterable (WebIDL converts the inner sequence
      // the same way); anything else is passed through untouched for fetch to
      // reject, exactly as it would have without this wrapper.
      const pair =
        Array.isArray(entry) || typeof entry !== "object" || entry === null
          ? entry
          : typeof (entry as { [Symbol.iterator]?: unknown })[
                Symbol.iterator
              ] === "function"
            ? [...(entry as Iterable<unknown>)]
            : entry
      if (
        Array.isArray(pair) &&
        String(pair[0]).toLowerCase() === "content-length"
      )
        continue
      pairs.push(pair)
    }
    return pairs
  }
  if (typeof headers === "object") {
    const copy: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(
      headers as Record<string, unknown>,
    )) {
      if (key.toLowerCase() !== "content-length") copy[key] = value
    }
    return copy
  }
  return headers
}

// ---- wire backstop body handling (audit L-RS3) --------------------------------

/**
 * A request body that may be JSON could not be decoded for inspection; the
 * wire backstop must abort the request rather than forward it unscanned.
 */
export class UnscannableBodyError extends Error {
  constructor(
    reason = "appears to be text in an encoding this runtime cannot decode",
  ) {
    // Never quote the body — it could hold the very secret at stake. The
    // reason is always a fixed string chosen by the caller, never derived
    // from body bytes or from a header value.
    super(
      `a provider request body ${reason}; aborting the request rather than forwarding it unscanned`,
    )
    this.name = "UnscannableBodyError"
  }
}

/**
 * Largest body the wire backstop will buffer in order to inspect it (audit
 * review of L-RS3). Only shapes whose inspection RETAINS memory the caller
 * was not already holding are charged against it: a stream (unbounded by
 * nature — fetch permits an arbitrarily long body), a Blob (which may be
 * file-backed), and a Request's body stream. Bodies already materialized in
 * memory as bytes or a string are not, since reading them costs nothing new.
 *
 * The ceiling is generous on purpose: a real provider request is a JSON
 * document of at most a few MB, but base64 attachments can make a legitimate
 * one large, and this must never abort a request that would otherwise have
 * succeeded. It bounds BYTES, not time — a stalled stream still stalls, but
 * it stalls the inner fetch identically without this wrapper, so nothing new
 * is introduced there.
 */
export const MAX_WIRE_BODY_BYTES = 64 * 1024 * 1024

/** A streaming body exceeded MAX_WIRE_BODY_BYTES; the caller must abort. */
export class OversizedBodyError extends Error {
  constructor() {
    super(
      `a provider request body exceeded the ${MAX_WIRE_BODY_BYTES}-byte inspection budget; ` +
        "aborting the request rather than buffering it without bound or forwarding it unscanned",
    )
    this.name = "OversizedBodyError"
  }
}

/**
 * Buffer a streaming body under MAX_WIRE_BODY_BYTES, aborting fail-closed
 * when it overruns rather than accumulating without bound. Response
 * normalizes every streaming shape fetch accepts — a web ReadableStream, a
 * Node Readable, a plain async iterable — into a web stream (verified under
 * Bun), so one reader loop covers all of them. On overrun the reader is
 * cancelled so the producer is not left pushing into a dropped buffer.
 */
async function bufferBoundedBody(body: unknown): Promise<Uint8Array> {
  const stream = new Response(body as ReadableStream<Uint8Array>).body
  if (!stream) return new Uint8Array(0)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const chunk =
        value instanceof Uint8Array
          ? value
          : new Uint8Array(value as ArrayBufferLike)
      total += chunk.byteLength
      if (total > MAX_WIRE_BODY_BYTES) throw new OversizedBodyError()
      chunks.push(chunk)
    }
  } finally {
    // Releases the producer whether the loop ended, threw, or overran —
    // deliberately NOT awaited: a stream whose cancel() never settles would
    // otherwise swallow the OversizedBodyError and hang the request forever
    // (adversarial review), which is the very failure the budget exists to
    // prevent.
    void reader.cancel().catch(() => {})
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * A decoded text view of a byte-backed body, with the function that encodes a
 * rewritten text back into the SAME byte encoding (BOM included, when the
 * original carried one). Callers re-encode only when redaction changed the
 * text; a clean body keeps its original bytes untouched.
 */
type DecodedWireBody = {
  readonly text: string
  readonly encode: (text: string) => Uint8Array
}

/** First bytes a JSON object/array body can start with (whitespace, `{`, `[`). */
const JSON_START_BYTES = new Set([0x09, 0x0a, 0x0d, 0x20, 0x5b, 0x7b])

/**
 * What the request's own headers say its body is. Byte-backed bodies are
 * classified against this, never against the bytes alone (audit review of
 * L-RS3): a body the SENDER declares as JSON must be inspected as JSON or the
 * request must abort, no matter what the bytes look like to a UTF-8 decoder.
 * Sniffing may only ever NARROW what an undeclared body is taken to be — the
 * same direction rule the base64 attachment path follows (round 12).
 */
type WireBodyDeclaration = {
  /** The declared Content-Type names a format a JSON consumer could read. */
  readonly text: boolean
  /** Lowercased charset parameter from the Content-Type, when it carried one. */
  readonly charset?: string
}

/** No headers resolved: nothing declared, so the byte sniffing decides alone. */
const UNDECLARED: WireBodyDeclaration = { text: false }

// WHATWG encoding labels this code can both decode AND re-encode byte-
// faithfully. Anything outside these can still be DECODED for inspection (see
// decodeDeclaredCharset), but a redacted rewrite of it cannot be produced, so
// a match in such a body fails the request closed rather than shipping bytes
// in the wrong encoding. Note iso-8859-1 is deliberately absent: WHATWG maps
// that label to windows-1252, which is NOT a byte-identical round trip.
const UTF8_LABELS = new Set([
  "utf-8",
  "utf8",
  "unicode-1-1-utf-8",
  "us-ascii",
  "ascii",
])
const UTF16LE_LABELS = new Set([
  "utf-16",
  "utf-16le",
  "utf16le",
  "unicode",
  "ucs-2",
  "csunicode",
])
const UTF16BE_LABELS = new Set(["utf-16be", "utf16be"])
const UTF32_LABELS = new Set([
  "utf-32",
  "utf-32le",
  "utf-32be",
  "utf32",
  "ucs-4",
])

/**
 * The headers effective at the inner fetch() call. fetch resolves an init's
 * headers against a Request input by REPLACEMENT, not merge (verified: `new
 * Request(req, {headers})` keeps none of req's headers), so init wins
 * wholesale when present and the Request supplies them otherwise.
 *
 * A collection Headers itself rejects yields undefined: fetch would reject
 * the same request a moment later, so there is no coverage to lose.
 */
function effectiveWireHeaders(
  input: unknown,
  init: RequestInit | undefined,
): Headers | undefined {
  const own = init?.headers
  // An EMPTY init.headers does NOT replace a Request's headers in this
  // runtime (verified for {}, [], new Headers(), new Map()): the Request's
  // stay effective. Treating an empty collection as authoritative lost the
  // declared Content-Type — reopening the very fail-open the declaration gate
  // closes — and left the Request's stale Content-Length in place
  // (adversarial review). Only a NON-empty init.headers replaces.
  if (!isEmptyHeadersInit(own)) {
    try {
      return new Headers(own as RequestInit["headers"])
    } catch {
      return undefined
    }
  }
  if (typeof Request !== "undefined" && input instanceof Request)
    return input.headers
  return undefined
}

/**
 * Is this HeadersInit absent or carrying no entries? Checked structurally,
 * without constructing a Headers, so the string-body hot path stays free of
 * per-request allocation.
 */
function isEmptyHeadersInit(headers: unknown): boolean {
  if (headers === undefined || headers === null) return true
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    for (const _ of headers.keys()) return false
    return true
  }
  if (Array.isArray(headers)) return headers.length === 0
  if (typeof Map !== "undefined" && headers instanceof Map)
    return headers.size === 0
  if (typeof headers !== "object") return true
  if (
    typeof (headers as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
    "function"
  ) {
    for (const _ of headers as Iterable<unknown>) return false
    return true
  }
  return Object.keys(headers as object).length === 0
}

/** Read the Content-Type into a declaration (see WireBodyDeclaration). */
function declaredWireBody(headers: Headers | undefined): WireBodyDeclaration {
  const joined = headers?.get("content-type")
  if (!joined) return UNDECLARED
  // Headers.get joins duplicate fields with ", ", so two Content-Type headers
  // yield "application/json, application/json" — which parses to a subtype of
  // "json, application/json" and silently disables the declared-JSON gate
  // (adversarial review). Take the first field; a consumer reading the header
  // as a single mediatype does the same.
  const raw = joined.split(",")[0] as string
  const [essence = "", ...params] = raw.split(";")
  const [type = "", subtype = ""] = essence.trim().toLowerCase().split("/")
  let charset: string | undefined
  for (const param of params) {
    const eq = param.indexOf("=")
    if (eq < 0) continue
    if (param.slice(0, eq).trim().toLowerCase() !== "charset") continue
    charset = param
      .slice(eq + 1)
      .trim()
      .toLowerCase()
      .replace(/^"(.*)"$/, "$1")
  }
  const text =
    type === "text" ||
    subtype === "json" ||
    subtype.endsWith("+json") ||
    subtype === "ndjson" ||
    subtype === "x-ndjson"
  return charset ? { text, charset } : { text }
}

/**
 * Refuse a body the sender has compressed. The bytes on the wire are then a
 * container the scanner cannot read, while the provider decompresses and
 * reads the credential inside perfectly well — the exact fail-open the
 * audit's "may be JSON but cannot be inspected must fail closed" rule
 * targets. Decompress-redact-recompress was considered and rejected: it
 * would have this backstop re-encode bodies with a codec (and a compression
 * level) the caller chose, for a transport no provider in the supported set
 * uses. No provider request today carries a Content-Encoding at all, so this
 * only ever fires on something new — which is precisely when failing closed
 * is right.
 */
function assertInspectableEncoding(headers: Headers | undefined): void {
  const declared = headers?.get("content-encoding")
  if (!declared) return
  const codings = declared
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding.length > 0)
  if (codings.every((coding) => coding === "identity")) return
  throw new UnscannableBodyError(
    "declares a content encoding this backstop cannot decode",
  )
}

// The lib typings enumerate only "utf-8"-family labels; the runtime accepts
// the full WHATWG set (utf-16le/be verified under Bun), and an unsupported
// label throws — which utf16Decoder turns into the fail-closed abort.
const AnyTextDecoder = TextDecoder as unknown as new (
  label: string,
  options?: { fatal?: boolean; ignoreBOM?: boolean },
) => TextDecoder

function utf16Decoder(label: "utf-16le" | "utf-16be"): TextDecoder {
  try {
    // ignoreBOM on purpose: any BOM was already split off by the caller, and
    // nothing else may be silently stripped or the re-encode would not be
    // byte-faithful.
    return new AnyTextDecoder(label, { fatal: true, ignoreBOM: true })
  } catch {
    // The runtime cannot decode an encoding the body's shape claims. The
    // body may well be JSON — fail closed, exactly like the UTF-32 case.
    throw new UnscannableBodyError()
  }
}

/** Swap adjacent byte pairs (UTF-16 endianness flip; even length guaranteed). */
function swapBytePairs(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out[i] = bytes[i + 1] as number
    out[i + 1] = bytes[i] as number
  }
  return out
}

function decodeUtf16WireBody(
  payload: Uint8Array,
  littleEndian: boolean,
  bom?: Uint8Array,
): DecodedWireBody | "binary" {
  const decoder = utf16Decoder(littleEndian ? "utf-16le" : "utf-16be")
  let text: string
  try {
    text = decoder.decode(payload)
  } catch {
    // The BOM or byte shape suggested UTF-16 but the payload is not valid
    // UTF-16 — no JSON parser reads it either, so it is opaque binary.
    return "binary"
  }
  const encode = (rewritten: string): Uint8Array => {
    const encoded = Buffer.from(rewritten, "utf16le")
    const body = littleEndian ? new Uint8Array(encoded) : swapBytePairs(encoded)
    if (!bom) return body
    const out = new Uint8Array(bom.length + body.length)
    out.set(bom, 0)
    out.set(body, bom.length)
    return out
  }
  return { text, encode }
}

/**
 * Decode UTF-32 by hand (no runtime decoder exists), or undefined when the
 * bytes are not valid UTF-32 in this endianness. Used only as EVIDENCE — see
 * looksLikeBomlessUtf32 — never to produce a scannable body.
 */
function decodeUtf32Text(
  bytes: Uint8Array,
  littleEndian: boolean,
): string | undefined {
  if (bytes.length === 0 || bytes.length % 4 !== 0) return undefined
  const units: string[] = []
  for (let i = 0; i < bytes.length; i += 4) {
    const a = bytes[i] as number
    const b = bytes[i + 1] as number
    const c = bytes[i + 2] as number
    const d = bytes[i + 3] as number
    // Assembled without << so a high leading byte cannot produce a negative.
    const point = littleEndian
      ? a + b * 0x100 + c * 0x10000 + d * 0x1000000
      : d + c * 0x100 + b * 0x10000 + a * 0x1000000
    // Surrogates are not scalar values; anything past the max is not UTF-32.
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
      return undefined
    units.push(String.fromCodePoint(point))
  }
  return units.join("")
}

/**
 * Does this body decode as BOM-less UTF-32 holding a JSON document?
 *
 * Structural shape alone is NOT enough evidence, which two rounds proved: one
 * ASCII-in-UTF-32 unit matches `20 00 00 00`, which is equally an ordinary
 * little-endian int32 of 32, and widening to four consecutive units still
 * matched a run of small int32s (`[32, 1, 2, 3]` — adversarial review). Every
 * such body previously passed through untouched, so a shape-only rule turns
 * pass-through binary into a hard request failure.
 *
 * So the evidence is the decode itself: valid UTF-32 whose text parses as a
 * JSON object or array. A binary payload essentially never satisfies that,
 * while real UTF-32 JSON — the fail-open this closes — always does. The cheap
 * structural pre-check keeps the full decode off every other body's path.
 */
function looksLikeBomlessUtf32(bytes: Uint8Array): boolean {
  if (bytes.length < 8 || bytes.length % 4 !== 0) return false
  const opensLikeJson = (littleEndian: boolean): boolean => {
    const lead = bytes[littleEndian ? 0 : 3] as number
    const pad = littleEndian ? [1, 2, 3] : [0, 1, 2]
    return (
      JSON_START_BYTES.has(lead) && pad.every((index) => bytes[index] === 0x00)
    )
  }
  for (const littleEndian of [true, false]) {
    if (!opensLikeJson(littleEndian)) continue
    const text = decodeUtf32Text(bytes, littleEndian)
    if (text === undefined) continue
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === "object") return true
    } catch {
      // Not JSON in this endianness — keep the body on its normal path.
    }
  }
  return false
}

/** Decode UTF-8, preserving and re-emitting a leading BOM if the body had one. */
function decodeUtf8WireBody(bytes: Uint8Array): DecodedWireBody | "binary" {
  let text: string
  try {
    text = utf8Strict.decode(bytes)
  } catch {
    return "binary"
  }
  // utf8Strict keeps a leading BOM (ignoreBOM) — split it off so JSON.parse
  // can see the document, and glue it back on re-encode so the byte prefix
  // survives a rewrite.
  if (text.startsWith("\uFEFF")) {
    return {
      text: text.slice(1),
      encode: (rewritten) =>
        new Uint8Array(Buffer.from(`\uFEFF${rewritten}`, "utf8")),
    }
  }
  return {
    text,
    encode: (rewritten) => new Uint8Array(Buffer.from(rewritten, "utf8")),
  }
}

/**
 * Decode a body whose Content-Type names a charset outside the UTF families.
 * The runtime can READ many of these (shift_jis, windows-1252, koi8-r…), and
 * reading is what a redaction decision needs — so the body is inspected
 * rather than waved through as "binary" the way an undeclared one would be.
 * What cannot be produced is a REWRITTEN body in that same encoding
 * (TextEncoder only emits UTF-8), so `encode` fails the request closed. That
 * combination is the safest of the three options: a CLEAN body still passes
 * through byte-identical (no re-encode is ever needed for it), a body holding
 * a secret aborts, and neither is forwarded with a live credential.
 */
function decodeDeclaredCharset(
  bytes: Uint8Array,
  charset: string,
  declaredText: boolean,
): DecodedWireBody | "binary" {
  let decoder: TextDecoder
  try {
    decoder = new AnyTextDecoder(charset, { fatal: true, ignoreBOM: true })
  } catch {
    // An unsupported or malformed charset label on a body that may be JSON.
    throw new UnscannableBodyError(
      "declares a charset this runtime cannot decode",
    )
  }
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    if (declaredText)
      throw new UnscannableBodyError(
        "is declared as text but is not valid in its declared charset",
      )
    return "binary"
  }
  return {
    text,
    encode: (rewritten) => {
      // TextEncoder emits only UTF-8, so a rewrite in this charset is
      // producible exactly when the UTF-8 bytes ROUND-TRIP back through the
      // declared decoder unchanged — true for the ASCII-transparent charsets
      // (shift_jis, koi8-r, windows-125x…) whenever the text is ASCII, which
      // covers the real case: an ASCII JSON body plus an ASCII placeholder.
      // Verifying rather than assuming is what makes it safe: a body holding
      // genuine non-ASCII text fails the check and aborts instead of being
      // silently corrupted into mojibake. Aborting unconditionally here
      // regressed a request the old code completed correctly (adversarial
      // review) — it decoded as UTF-8, redacted, and re-encoded.
      const candidate = new Uint8Array(Buffer.from(rewritten, "utf8"))
      try {
        if (
          new AnyTextDecoder(charset, { fatal: true, ignoreBOM: true }).decode(
            candidate,
          ) === rewritten
        ) {
          return candidate
        }
      } catch {
        // Falls through to the abort below.
      }
      throw new UnscannableBodyError(
        "would have to be re-encoded in a charset this runtime cannot emit",
      )
    },
  }
}

/**
 * Decode a byte-backed request body into inspectable text, or classify it.
 * The request's own `declared` Content-Type governs; byte sniffing decides
 * only what an UNDECLARED body is (audit review of L-RS3 — a declared JSON
 * body classified as opaque binary was a fail-open: the provider decodes
 * leniently and reads the very credential a fatal decoder refused).
 *
 *   - "binary": provably not a text encoding any JSON consumer could read
 *     AND not declared as text — invalid UTF-8 with no text-encoding markers,
 *     or a claimed UTF-16 body whose bytes are not valid UTF-16. Safe to
 *     pass through untouched.
 *   - DecodedWireBody: the declared charset decoded it; or, undeclared,
 *     well-formed UTF-8 (BOM tolerated and preserved), UTF-16 with a BOM, or
 *     BOM-less UTF-16 whose leading NUL pattern spells a JSON opener
 *     (`{ 0x00` / `0x00 {`) — that check must run BEFORE the UTF-8 attempt,
 *     because NUL bytes are VALID UTF-8: ASCII JSON in BOM-less UTF-16
 *     decodes "successfully" as NUL-riddled UTF-8, fails JSON.parse, and
 *     would sail through as "not JSON" (fail-open).
 *   - throws UnscannableBodyError: UTF-32 in any form (no runtime decoder
 *     exists — BOM, declared charset, or the BOM-less opener pattern), a
 *     claimed UTF-16 body on a runtime without that decoder, a charset the
 *     runtime cannot decode, or a body DECLARED as text that will not decode.
 *     The body may be JSON and cannot be read, so the request must abort.
 */
function decodeWireBodyBytes(
  bytes: Uint8Array,
  declared: WireBodyDeclaration,
): DecodedWireBody | "binary" {
  const b0 = bytes[0]
  const b1 = bytes[1]
  const charset = declared.charset
  if (charset) {
    // A declared charset is authoritative — the provider decodes by it too,
    // so sniffing must not second-guess it.
    if (UTF32_LABELS.has(charset)) {
      throw new UnscannableBodyError(
        "declares a UTF-32 charset this runtime cannot decode",
      )
    }
    if (UTF16LE_LABELS.has(charset) || UTF16BE_LABELS.has(charset)) {
      // A BOM is part of the byte stream (it must survive a rewrite) and it
      // OVERRIDES the label's endianness: a body labelled utf-16 carrying a
      // big-endian BOM is big-endian, and reading it the label's way yields
      // U+FFFE-prefixed garbage that fails JSON.parse and passes unscanned.
      // Honoring it can only turn an undecodable body into a decodable one.
      const bomLittle = bytes.length >= 2 && b0 === 0xff && b1 === 0xfe
      const bomBig = bytes.length >= 2 && b0 === 0xfe && b1 === 0xff
      const littleEndian =
        bomLittle || (!bomBig && !UTF16BE_LABELS.has(charset))
      const decoded =
        bomLittle || bomBig
          ? decodeUtf16WireBody(
              bytes.subarray(2),
              littleEndian,
              bytes.subarray(0, 2),
            )
          : decodeUtf16WireBody(bytes, littleEndian)
      if (decoded === "binary" && declared.text) {
        throw new UnscannableBodyError(
          "is declared as text but is not valid in its declared charset",
        )
      }
      return decoded
    }
    if (!UTF8_LABELS.has(charset))
      return decodeDeclaredCharset(bytes, charset, declared.text)
    // A declared UTF-8 charset falls THROUGH to the sniffing path below — it
    // must not disable it. NUL bytes are valid UTF-8, so BOM-less UTF-16 (or
    // UTF-32) JSON labelled `charset=utf-8` decodes "successfully" into
    // NUL-riddled text, fails JSON.parse, and ships raw: returning here made
    // adding a charset parameter a one-line way to switch the protection off,
    // and regressed a body the pre-existing sniffing already redacted
    // (adversarial review). Sniffing only ever NARROWS what a body is taken
    // to be, so running it under a UTF-8 label is safe in the other
    // direction: anything it does not recognize still ends at UTF-8 below.
  }
  // UTF-32 BOMs first — the little-endian one starts with the UTF-16LE BOM.
  if (bytes.length >= 4) {
    if (b0 === 0xff && b1 === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00)
      throw new UnscannableBodyError()
    if (b0 === 0x00 && b1 === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff)
      throw new UnscannableBodyError()
    // BOM-LESS UTF-32 openers, BEFORE any UTF-16 sniffing: a UTF-32LE `{` is
    // `7B 00 00 00`, whose first two bytes are exactly the UTF-16LE pattern
    // matched below — so it decoded as valid (NUL-riddled) UTF-16, failed
    // JSON.parse, and was forwarded, while a UTF-32 consumer parsed the
    // credential out of it perfectly well (audit review). No runtime decoder
    // exists for UTF-32, so this fails closed like its BOM'd twin.
    if (looksLikeBomlessUtf32(bytes)) {
      throw new UnscannableBodyError(
        "looks like BOM-less UTF-32, which this runtime cannot decode",
      )
    }
  }
  if (bytes.length >= 2) {
    if (b0 === 0xff && b1 === 0xfe)
      return decodeUtf16WireBody(bytes.subarray(2), true, bytes.subarray(0, 2))
    if (b0 === 0xfe && b1 === 0xff)
      return decodeUtf16WireBody(bytes.subarray(2), false, bytes.subarray(0, 2))
    // BOM-less UTF-16 JSON: one NUL beside a JSON opener, before UTF-8 (above).
    if (b1 === 0x00 && b0 !== undefined && JSON_START_BYTES.has(b0)) {
      const decoded = decodeUtf16WireBody(bytes, true)
      if (decoded !== "binary") return decoded
    } else if (b0 === 0x00 && b1 !== undefined && JSON_START_BYTES.has(b1)) {
      const decoded = decodeUtf16WireBody(bytes, false)
      if (decoded !== "binary") return decoded
    }
  }
  const decoded = decodeUtf8WireBody(bytes)
  // A body the sender DECLARED as JSON or text is never opaque binary: the
  // provider decodes it leniently (a lone invalid byte becomes U+FFFD) and
  // still parses the credential out of what remains, so "this fatal decoder
  // refused it" must abort the request, not wave it through (audit review).
  if (decoded === "binary" && declared.text) {
    throw new UnscannableBodyError(
      "is declared as text but could not be decoded for inspection",
    )
  }
  return decoded
}

/**
 * Inspect a byte-backed body exactly the way the string path inspects a
 * string body: decode, and if the text parses as a JSON object or array,
 * redact it. Returns the redacted bytes in the ORIGINAL encoding, or
 * undefined when nothing changed — the caller then forwards the original
 * body object untouched, so clean bytes are never altered or re-encoded.
 */
function redactWireBodyBytes(
  redactor: Redactor,
  bytes: Uint8Array,
  declared: WireBodyDeclaration,
): Uint8Array | undefined {
  if (bytes.length === 0) return undefined
  const decoded = decodeWireBodyBytes(bytes, declared)
  if (decoded === "binary") return undefined
  const rewritten = redactor.redactJsonBody(decoded.text)
  if (rewritten === decoded.text) return undefined
  return decoded.encode(rewritten)
}

/** One inspected outbound request: what to forward, and whether a secret was masked. */
export type WireRequestResult = {
  readonly input: unknown
  readonly init: RequestInit | undefined
  readonly redacted: boolean
}

/**
 * The wire backstop's whole-request inspection (audit L-RS3). The previous
 * shape looked only at `typeof init.body === "string"`, which is every body
 * the stock AI-SDK paths produce today — but a future transport (or a
 * provider package upgrade) that posts bytes, a Blob, a stream, or a
 * prebuilt Request would silently bypass the backstop-only surfaces (title
 * generation, MCP tool definitions, structured-output schemas). Policy, per
 * body shape:
 *
 *   - string: unconditionally inspected, exactly as before.
 *   - bytes (ArrayBuffer or any view over one), Blob: decoded and inspected
 *     (decodeWireBodyBytes, against the request's DECLARED Content-Type);
 *     JSON is redacted and re-encoded in the same encoding, clean bodies
 *     pass through byte-identical, undeclared opaque binary passes, and an
 *     encoding that may hide JSON but cannot be decoded aborts the request
 *     (UnscannableBodyError — fail closed).
 *   - ReadableStream: buffered under MAX_WIRE_BODY_BYTES, then treated as
 *     bytes. Buffering consumes the stream, so the buffered bytes replace it
 *     as the body even when clean — same content, and the Content-Length, if
 *     any, still matches.
 *   - a Request carrying the body (fetch(request) with no init body): the
 *     body is read from a clone — cloning tees the stream, so the original
 *     stays forwardable when clean — and a redacted body is rebuilt into a
 *     fresh Request copy (verified: constructing from the original with a
 *     body override leaves it undisturbed and carries method/url/options;
 *     headers are passed explicitly because the copy would otherwise keep
 *     the stale Content-Length).
 *   - URLSearchParams, FormData: defined non-JSON wire formats — passed, the
 *     same judgment the string path already applies to non-JSON text.
 *   - anything else: fetch would stringify it (USVString conversion), so the
 *     stringified form is inspected like a string body.
 *
 * Every byte-backed shape is classified against the headers EFFECTIVE at the
 * inner fetch() call, not against its bytes alone (audit review): a body the
 * sender declares as JSON must be inspected as JSON or abort, and a body the
 * sender has compressed cannot be inspected at all (assertInspectableEncoding).
 *
 * Headers are rewritten only when the body actually changed — but then they
 * are resolved the same way fetch resolves them, so a Content-Length that
 * would still be effective is dropped whichever source carries it: init's own
 * headers, or the input Request's when init has none (audit review — the
 * rewritten body otherwise shipped under the original body's length).
 */
export async function redactWireRequest(
  redactor: Redactor,
  input: unknown,
  init: RequestInit | undefined,
): Promise<WireRequestResult> {
  const unchanged: WireRequestResult = { input, init, redacted: false }
  // Resolved at most once, and never at all on the string-body path every
  // stock provider request takes today — that path needs neither the declared
  // type nor a header fallback, and building a Headers per request would be
  // pure overhead on the hot path.
  let resolved:
    | {
        readonly headers: Headers | undefined
        readonly declared: WireBodyDeclaration
      }
    | undefined
  const resolve = (): {
    readonly headers: Headers | undefined
    readonly declared: WireBodyDeclaration
  } => {
    if (!resolved) {
      const headers = effectiveWireHeaders(input, init)
      resolved = { headers, declared: declaredWireBody(headers) }
    }
    return resolved
  }
  // The headers effective at the call, minus Content-Length. When init
  // carries none, the input Request's are cloned in and returned EXPLICITLY:
  // leaving `headers: undefined` would let that Request's stale
  // Content-Length stay effective over the rewritten body (audit review).
  const sanitizedHeaders = (): RequestInit["headers"] => {
    // A non-empty init.headers is authoritative and keeps the caller's own
    // representation; an empty one does not replace the Request's, so the
    // Request's must be sanitized and returned explicitly instead.
    if (!isEmptyHeadersInit(init?.headers)) {
      return dropContentLength(init?.headers) as RequestInit["headers"]
    }
    const fromRequest = resolve().headers
    if (!fromRequest) return init?.headers
    return dropContentLength(fromRequest) as RequestInit["headers"]
  }
  const rewrite = (body: unknown): WireRequestResult => ({
    input,
    init: {
      ...init,
      body: body as RequestInit["body"],
      headers: sanitizedHeaders(),
    },
    redacted: true,
  })

  const body: unknown = init?.body
  if (typeof body === "string") {
    if (body.length === 0) return unchanged
    const rewritten = redactor.redactJsonBody(body)
    return rewritten === body ? unchanged : rewrite(rewritten)
  }
  if (body === undefined || body === null) {
    // With no init body, fetch falls back to the Request's own. An already
    // consumed body cannot be inspected — or forwarded: the inner fetch will
    // reject it exactly as it would have without the wrapper.
    if (
      typeof Request !== "undefined" &&
      input instanceof Request &&
      input.body !== null &&
      !input.bodyUsed
    ) {
      assertInspectableEncoding(resolve().headers)
      // Read the clone's STREAM under the budget rather than arrayBuffer():
      // a Request can carry an arbitrarily long streaming body too.
      const bytes = await bufferBoundedBody(input.clone().body)
      const rewritten = redactWireBodyBytes(redactor, bytes, resolve().declared)
      if (!rewritten) return unchanged
      const rebuilt = new Headers(input.headers)
      rebuilt.delete("content-length")
      // init.headers, when present, REPLACES the rebuilt Request's headers at
      // the inner fetch (verified) — so it would restore a stale
      // Content-Length over the sanitized copy. Sanitize that source too
      // (audit review); with no init.headers the init passes through as-is.
      const nextInit =
        init?.headers !== undefined && init.headers !== null
          ? {
              ...init,
              headers: dropContentLength(
                init.headers,
              ) as RequestInit["headers"],
            }
          : init
      return {
        input: new Request(input, { body: rewritten, headers: rebuilt }),
        init: nextInit,
        redacted: true,
      }
    }
    return unchanged
  }
  if (ArrayBuffer.isView(body)) {
    assertInspectableEncoding(resolve().headers)
    const bytes =
      body instanceof Uint8Array
        ? body
        : new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    const rewritten = redactWireBodyBytes(redactor, bytes, resolve().declared)
    return rewritten ? rewrite(rewritten) : unchanged
  }
  if (body instanceof ArrayBuffer) {
    assertInspectableEncoding(resolve().headers)
    const rewritten = redactWireBodyBytes(
      redactor,
      new Uint8Array(body),
      resolve().declared,
    )
    return rewritten ? rewrite(rewritten) : unchanged
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    assertInspectableEncoding(resolve().headers)
    // A Blob may be file-backed, so reading one RETAINS memory the caller was
    // not already holding — charge it against the same budget as a stream.
    if (body.size > MAX_WIRE_BODY_BYTES) throw new OversizedBodyError()
    const rewritten = redactWireBodyBytes(
      redactor,
      new Uint8Array(await body.arrayBuffer()),
      resolve().declared,
    )
    return rewritten
      ? rewrite(new Blob([rewritten], { type: body.type }))
      : unchanged
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams)
    return unchanged
  if (typeof FormData !== "undefined" && body instanceof FormData)
    return unchanged
  // A single-shot streaming body — a web ReadableStream, a Node Readable, or
  // any async iterable fetch accepts (an async generator). All buffer through
  // Response, and all are CONSUMED by the inspection, so even a clean one must
  // forward the buffered bytes rather than the exhausted source. Checked by
  // capability (Symbol.asyncIterator) plus the ReadableStream instance, since
  // a web stream is not async-iterable on every runtime.
  const streaming =
    (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) ||
    typeof (body as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  if (streaming) {
    assertInspectableEncoding(resolve().headers)
    // Buffered under MAX_WIRE_BODY_BYTES: fetch permits an arbitrarily large
    // (or endless) streaming body, and the previous unbounded
    // `new Response(body).arrayBuffer()` would retain all of it — turning a
    // transport that streamed in bounded memory into one that does not, and
    // handing an adversarial producer a way to exhaust the process (audit
    // review). Overrun aborts rather than forwarding a partly-read body.
    const bytes = await bufferBoundedBody(body)
    const rewritten = redactWireBodyBytes(redactor, bytes, resolve().declared)
    if (rewritten) return rewrite(rewritten)
    return {
      input,
      init: { ...init, body: bytes as unknown as RequestInit["body"] },
      redacted: false,
    }
  }
  // A remaining object body is not something fetch serializes as JSON — it
  // calls String() on it ("[object Object]"), which is what is inspected here
  // (never JSON, so it passes). A primitive coerces to its text form and is
  // inspected like a string body.
  const text = String(body)
  if (text.length === 0) return unchanged
  const rewritten = redactor.redactJsonBody(text)
  return rewritten === text ? unchanged : rewrite(rewritten)
}

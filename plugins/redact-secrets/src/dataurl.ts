/**
 * A parsed `data:` url. `scheme` is the leading `data:` token (with any leading
 * whitespace). `mediatype` is the pre-comma metadata with any trailing `;base64`
 * marker stripped (parameters like `;charset=utf-8` — or a crafted `;token=...`
 * — are kept, exactly as the WHATWG processor treats them). `base64Marker` is
 * that stripped marker verbatim (`;base64`, preserving its whitespace/case), or
 * "" when the payload is plaintext. `payload` is everything after the comma, so
 * `scheme + mediatype + base64Marker + "," + payload` reconstructs the original
 * url byte-for-byte — the redactor rebuilds it that way after scanning the
 * mediatype, keeping a clean url unchanged.
 */
type DataUrl = {
  readonly scheme: string
  readonly mediatype: string
  readonly base64Marker: string
  readonly base64: boolean
  readonly payload: string
}

const DATA_URL_BASE64_SUFFIX = /;[\t\n\f\r ]*base64[\t\n\f\r ]*$/i

export function parseDataUrl(url: string): DataUrl | null {
  const match = /^(\s*data:)([^,]*),([\s\S]*)$/i.exec(url)
  if (!match) return null
  const meta = match[2] as string
  const base64 = DATA_URL_BASE64_SUFFIX.test(meta)
  const mediatype = base64 ? meta.replace(DATA_URL_BASE64_SUFFIX, "") : meta
  // The stripped `;base64` suffix (or "" when plaintext): mediatype is a prefix
  // of meta, so the remainder is exactly the marker.
  const base64Marker = meta.slice(mediatype.length)
  return {
    scheme: match[1] as string,
    mediatype,
    base64Marker,
    base64,
    payload: match[3] as string,
  }
}

/**
 * One byte-run a payload must carry at a fixed offset for its declared type to
 * be believed. `bytes` is a latin1 string (one char = one byte).
 */
type MagicPart = readonly [offset: number, bytes: string]

/** Any-of signatures per mediatype; each signature is all-of MagicParts. */
type MagicSignatures = ReadonlyArray<readonly MagicPart[]>

const ZIP_MAGIC: MagicSignatures = [
  [[0, "PK\x03\x04"]],
  [[0, "PK\x05\x06"]],
  [[0, "PK\x07\x08"]],
]
const FTYP_MAGIC: MagicSignatures = [[[4, "ftyp"]]] // ISO-BMFF: mp4/quicktime/m4a/avif/heic
const EBML_MAGIC: MagicSignatures = [[[0, "\x1a\x45\xdf\xa3"]]] // Matroska/WebM
const OGG_MAGIC: MagicSignatures = [[[0, "OggS"]]]

/**
 * Magic-byte signatures for the binary formats whose base64 payload
 * redactPartUrl may skip WITHOUT scanning. The declared mediatype alone is
 * never enough: it is an unrestricted string a part can carry with any label
 * it likes (a mimeType handed back by an MCP server included), so trusting it
 * made `data:image/png;base64,<base64 of "token=ghp_…">` a redaction bypass —
 * textual bytes wearing a binary label sailed to the provider unscanned (a
 * reproduced finding). A payload is opaque only when the DECLARED type has a
 * known signature AND the decoded bytes actually carry it; everything else —
 * unrecognized types, signature mismatches, and label-only types with no
 * usable magic (application/octet-stream, the universal mislabel) — falls
 * through to the byte-preserving scan. The check can only NARROW the skip,
 * never widen it, so a wrong or missing table entry costs work (a genuine
 * unlisted binary is scanned; a clean one round-trips unchanged), never
 * coverage. A crafted payload that PREPENDS real magic to textual secret
 * bytes still skips — that adversary controls the encoding and is already
 * outside the scanner's reach (see the README's encoded-segment limitation).
 *
 * `application/pdf` is deliberately ABSENT. A PDF is a document format
 * OpenCode treats as media (util/media.ts isPdfAttachment) and forwards to
 * capable providers verbatim, which extract its TEXT (document blocks) — so a
 * credential stored as literal text in a PDF is provider-readable, and
 * skipping it would be a leak. Its decoded bytes are scanned best-effort; the
 * residual limit (README) is a credential inside a FlateDecode-compressed
 * stream.
 */
const BINARY_MAGIC: ReadonlyMap<string, MagicSignatures> = new Map([
  ["image/png", [[[0, "\x89PNG\r\n\x1a\n"]]]],
  ["image/jpeg", [[[0, "\xff\xd8\xff"]]]],
  ["image/gif", [[[0, "GIF87a"]], [[0, "GIF89a"]]]],
  [
    "image/webp",
    [
      [
        [0, "RIFF"],
        [8, "WEBP"],
      ],
    ],
  ],
  ["image/bmp", [[[0, "BM"]]]],
  ["image/tiff", [[[0, "II*\x00"]], [[0, "MM\x00*"]]]],
  ["image/x-icon", [[[0, "\x00\x00\x01\x00"]], [[0, "\x00\x00\x02\x00"]]]],
  [
    "image/vnd.microsoft.icon",
    [[[0, "\x00\x00\x01\x00"]], [[0, "\x00\x00\x02\x00"]]],
  ],
  ["image/avif", FTYP_MAGIC],
  ["image/heic", FTYP_MAGIC],
  ["image/heif", FTYP_MAGIC],
  // ID3-tagged or bare MPEG frame sync (the common layer-3 headers).
  [
    "audio/mpeg",
    [
      [[0, "ID3"]],
      [[0, "\xff\xfb"]],
      [[0, "\xff\xfa"]],
      [[0, "\xff\xf3"]],
      [[0, "\xff\xf2"]],
    ],
  ],
  [
    "audio/wav",
    [
      [
        [0, "RIFF"],
        [8, "WAVE"],
      ],
    ],
  ],
  [
    "audio/x-wav",
    [
      [
        [0, "RIFF"],
        [8, "WAVE"],
      ],
    ],
  ],
  ["audio/flac", [[[0, "fLaC"]]]],
  ["audio/ogg", OGG_MAGIC],
  ["audio/mp4", FTYP_MAGIC],
  ["audio/x-m4a", FTYP_MAGIC],
  ["audio/webm", EBML_MAGIC],
  ["video/mp4", FTYP_MAGIC],
  ["video/quicktime", FTYP_MAGIC],
  ["video/x-m4v", FTYP_MAGIC],
  ["video/webm", EBML_MAGIC],
  ["video/x-matroska", EBML_MAGIC],
  ["video/ogg", OGG_MAGIC],
  [
    "video/x-msvideo",
    [
      [
        [0, "RIFF"],
        [8, "AVI "],
      ],
    ],
  ],
  ["font/woff", [[[0, "wOFF"]]]],
  ["font/woff2", [[[0, "wOF2"]]]],
  ["font/ttf", [[[0, "\x00\x01\x00\x00"]]]],
  ["font/otf", [[[0, "OTTO"]]]],
  ["font/collection", [[[0, "ttcf"]]]],
  ["application/zip", ZIP_MAGIC],
  ["application/java-archive", ZIP_MAGIC],
  ["application/gzip", [[[0, "\x1f\x8b"]]]],
  ["application/x-gzip", [[[0, "\x1f\x8b"]]]],
  ["application/x-tar", [[[257, "ustar"]]]],
  ["application/x-bzip2", [[[0, "BZh"]]]],
  ["application/x-xz", [[[0, "\xfd7zXZ\x00"]]]],
  ["application/x-7z-compressed", [[[0, "7z\xbc\xaf\x27\x1c"]]]],
  ["application/x-rar-compressed", [[[0, "Rar!\x1a\x07"]]]],
  ["application/vnd.rar", [[[0, "Rar!\x1a\x07"]]]],
  ["application/wasm", [[[0, "\x00asm"]]]],
  ["application/ogg", OGG_MAGIC],
  ["application/x-sqlite3", [[[0, "SQLite format 3\x00"]]]],
  ["application/x-shockwave-flash", [[[0, "FWS"]], [[0, "CWS"]], [[0, "ZWS"]]]],
])

/**
 * Whether a base64 data-url payload may be skipped as opaque binary: the
 * declared mediatype must have a known signature AND the decoded payload must
 * actually start with it (see BINARY_MAGIC for why declaration alone is a
 * bypass). Used only as a fast path — a `false` never loses coverage, it just
 * routes the payload to the byte-preserving scan. Parameters are dropped
 * before the table lookup.
 */
export function isOpaqueBinaryPayload(
  mediatype: string,
  base64Payload: string,
): boolean {
  const mime = mediatype.split(";")[0]?.trim().toLowerCase() ?? ""
  const signatures = mime ? BINARY_MAGIC.get(mime) : undefined
  if (!signatures) return false
  // 512 base64 chars decode to 384 bytes — enough for the deepest signature
  // (tar's "ustar" at offset 257); Buffer's decoder skips whitespace the same
  // way the full-payload decode below does.
  const head = Buffer.from(base64Payload.slice(0, 512), "base64")
  return signatures.some((parts) =>
    parts.every(([offset, bytes]) => {
      if (offset + bytes.length > head.length) return false
      for (let i = 0; i < bytes.length; i++) {
        if (head[offset + i] !== bytes.charCodeAt(i)) return false
      }
      return true
    }),
  )
}

/**
 * Strict decoder: throws on any byte sequence that is not well-formed UTF-8,
 * instead of silently substituting U+FFFD (which would break the
 * byte-preserving re-encode contract below). ignoreBOM keeps a leading BOM in
 * the decoded text for the same reason — stripping it would alter bytes the
 * scan never touched.
 */
const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/**
 * Decode payload bytes into a scannable string, remembering which encoding
 * round-trips it. Well-formed UTF-8 is decoded as UTF-8 so the scanner sees
 * the text the PROVIDER will see: one code point per character. A latin1
 * (byte-per-char) view of the same bytes stretches every multibyte character —
 * an emoji becomes four characters — so RE2's rune-counted proximity bounds
 * (`(?:.|[\n\r]){0,32}?`) overflow and a secret near multibyte text escapes
 * bounded rules entirely. Anything NOT well-formed UTF-8 (real binary, legacy
 * encodings) falls back to latin1, the byte-exact 1:1 map, so no payload is
 * ever exempted — only scanned under weaker proximity semantics. Both
 * encodings reconstruct the original bytes exactly: valid UTF-8 → string →
 * utf8 bytes is lossless (no lone surrogates can come out of a fatal
 * decoder), and latin1 is bijective on bytes.
 */
export function decodePayloadBytes(bytes: Buffer): {
  readonly text: string
  readonly encoding: "utf8" | "latin1"
} {
  try {
    return { text: utf8Strict.decode(bytes), encoding: "utf8" }
  } catch {
    return { text: bytes.toString("latin1"), encoding: "latin1" }
  }
}

/**
 * Percent-decode without decodeURIComponent's all-or-nothing failure mode.
 * Each maximal run of `%XX` escapes becomes its bytes — read as UTF-8 when
 * well-formed, latin1 otherwise — and everything else (malformed escapes
 * included) passes through literally. decodeURIComponent instead throws on
 * the FIRST invalid sequence, and the old scan-the-encoded-text fallback let
 * one stray `%FF` shield every properly encoded secret in the same component:
 * a data url beginning `%FF` followed by a fully percent-encoded PAT scanned
 * as gibberish here while the provider's standard decoder saw byte 0xff
 * followed by the raw credential. Decoding run-by-run means an invalid byte
 * costs only its own run's UTF-8 reading (that run falls back to latin1,
 * byte-exact), never the decoding of anything around it.
 */
export function percentDecodeTolerant(encoded: string): string {
  return encoded.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    const bytes = Buffer.from(run.replaceAll("%", ""), "hex")
    return decodePayloadBytes(bytes).text
  })
}

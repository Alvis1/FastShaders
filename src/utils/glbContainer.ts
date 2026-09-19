/**
 * The GLB CONTAINER layer, shared by the trusted-side glTF reader, the
 * texture-stripping writer and (Phase 7) the repacker. A LEAF: it imports only
 * `bytesToBase64`.
 *
 * This file only CLASSIFIES and SLICES bytes. It never decodes a picture,
 * builds geometry, resolves a URI or asks the network for anything, and it
 * parses no JSON: `parseGlbContainer` hands the JSON chunk back as TEXT, and
 * the reader parses it through the shared reviver. Everything here reads a
 * dropped file, so every read is bounded and every rule is strict — a byte
 * layout GLTFLoader would tolerate is still refused when the rule below says
 * so, because the reader is the gate in front of a build, not a loader.
 *
 * What it offers:
 *   - `parseGlbContainer` / `buildGlbContainer`: the binary glTF 2.0 container
 *     (12-byte header, then a JSON chunk and at most one BIN chunk).
 *   - `decodeCanonicalBase64` / `decodeDataUri` / `encodeDataUri`: `data:` URIs
 *     for `.gltf` buffers and images, CANONICAL base64 only (no whitespace, no
 *     URL-safe alphabet, no percent-decoding, no stray bits in the last
 *     character), with the decoded size checked before anything is decoded.
 *   - `sniffImageFormat` / `readImageDimensions`: which image format the bytes
 *     really are (by magic, never by a declared MIME type), and a bounded read
 *     of its width and height from the header. The dimensions feed ESTIMATES
 *     only; decoding the picture stays authoritative.
 *   - `PLACEHOLDER_PNG_DATA_URI`: the 1×1 PNG the writer puts in place of an
 *     image it removes, so no index anywhere can dangle.
 */

import { bytesToBase64 } from './binaryCodec';

/** 'glTF', little-endian — the first u32 of every GLB. */
export const GLB_MAGIC = 0x46546c67;
/** 'JSON' — the chunk type of the (first, mandatory) JSON chunk. */
export const GLB_CHUNK_JSON = 0x4e4f534a;
/** 'BIN\0' — the chunk type of the (optional, second) binary chunk. */
export const GLB_CHUNK_BIN = 0x004e4942;
/** The most chunks a container may hold, unknown types included. A real file
 *  has two; the cap bounds the walk over a hostile one. */
export const GLB_MAX_CHUNKS = 16;
/** The largest JSON chunk the container hands out. Checked from the chunk
 *  header, before a byte of it is decoded. */
export const GLB_JSON_MAX_BYTES = 16 * 1024 * 1024;

const GLB_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
/** The smallest possible GLB: the header plus one chunk header. */
const GLB_MIN_BYTES = GLB_HEADER_BYTES + CHUNK_HEADER_BYTES;
/** A GLB's length field is a u32, so a container can be no larger. */
const GLB_MAX_TOTAL = 0xffffffff;

export type GlbParseError =
  | 'short'
  | 'magic'
  | 'version'
  | 'length'
  | 'chunk-bounds'
  | 'chunk-order'
  | 'duplicate-chunk'
  | 'too-many-chunks'
  | 'json-empty'
  | 'json-too-large';

export interface GlbChunks {
  /** The JSON chunk as text, decoded exactly as GLTFLoader decodes it. Any
   *  0x20 padding is still there (it is JSON whitespace). */
  json: string;
  /** A VIEW of the BIN chunk's bytes (padding included), never a copy; null
   *  when the container has no BIN chunk. */
  bin: Uint8Array | null;
}

/** 4-alignment, by arithmetic and NOT `(n + 3) & ~3`: a bitwise operator
 *  coerces through ToInt32, so the old spelling returned 0 at 2^32 and
 *  -2147483648 at 3·2^31 — exactly where `buildGlbContainer`'s u32 guard below
 *  exists to fire, which left it dead at the one size it is for. */
const pad4 = (n: number) => Math.ceil(n / 4) * 4;

function dataView(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/**
 * Parse a GLB container. Strict, in this order:
 *   1. fewer than 20 bytes → `short`;
 *   2. the magic is not 'glTF' → `magic`;
 *   3. the version is not exactly 2 → `version` (GLTFLoader accepts later
 *      versions; this does not);
 *   4. the declared total length L is under 20 or over the file → `length`.
 *      Bytes after L are ignored;
 *   5. the chunks are walked over [12, L): every 8-byte chunk header and every
 *      chunk body must lie inside L (`chunk-bounds`), and there may be at most
 *      GLB_MAX_CHUNKS of them (`too-many-chunks`);
 *   6. chunk 0 must be JSON (`chunk-order`);
 *   7. BIN may only be chunk 1 (`chunk-order`); a second JSON or BIN chunk is
 *      `duplicate-chunk`;
 *   8. a chunk of any other type is skipped, as the glTF spec says;
 *   9. an empty JSON chunk is `json-empty`, one over GLB_JSON_MAX_BYTES is
 *      `json-too-large` — both from the header, before decoding.
 *
 * The JSON is decoded with a default `TextDecoder` (UTF-8, non-fatal, BOM
 * stripped) — exactly GLTFLoader's decoder, so the reader and the loader see
 * the same strings, names included. Chunk alignment is not enforced: GLTFLoader
 * does not enforce it either, and nothing here reads a chunk as typed data.
 */
export function parseGlbContainer(
  bytes: Uint8Array,
): { ok: true; chunks: GlbChunks } | { ok: false; error: GlbParseError } {
  const fail = (error: GlbParseError) => ({ ok: false as const, error });
  if (bytes.length < GLB_MIN_BYTES) return fail('short');
  const dv = dataView(bytes);
  if (dv.getUint32(0, true) !== GLB_MAGIC) return fail('magic');
  if (dv.getUint32(4, true) !== 2) return fail('version');
  const total = dv.getUint32(8, true);
  if (total < GLB_MIN_BYTES || total > bytes.length) return fail('length');

  let jsonStart = 0;
  let jsonLength = 0;
  let bin: Uint8Array | null = null;
  let count = 0;
  for (let at = GLB_HEADER_BYTES; at < total; ) {
    if (total - at < CHUNK_HEADER_BYTES) return fail('chunk-bounds');
    const length = dv.getUint32(at, true);
    const type = dv.getUint32(at + 4, true);
    const body = at + CHUNK_HEADER_BYTES;
    if (length > total - body) return fail('chunk-bounds');
    if (count === GLB_MAX_CHUNKS) return fail('too-many-chunks');
    if (count === 0) {
      if (type !== GLB_CHUNK_JSON) return fail('chunk-order');
      jsonStart = body;
      jsonLength = length;
    } else if (type === GLB_CHUNK_JSON) {
      return fail('duplicate-chunk');
    } else if (type === GLB_CHUNK_BIN) {
      if (bin) return fail('duplicate-chunk');
      if (count !== 1) return fail('chunk-order');
      bin = bytes.subarray(body, body + length);
    }
    count++;
    at = body + length;
  }

  if (jsonLength === 0) return fail('json-empty');
  if (jsonLength > GLB_JSON_MAX_BYTES) return fail('json-too-large');
  const json = new TextDecoder().decode(bytes.subarray(jsonStart, jsonStart + jsonLength));
  return { ok: true, chunks: { json, bin } };
}

/**
 * Build a GLB container: version 2, the JSON chunk (UTF-8, padded with 0x20 to
 * a multiple of 4) and, only when `bin` is not null, the BIN chunk (padded with
 * 0x00). An empty `bin` still writes a BIN chunk of length 0, so a container
 * this module parsed rebuilds byte-identically. Throws only when the total
 * would not fit the u32 length field — which the reader's caps make unreachable
 * today (a model stops at 96/256 MiB, a module's assets at 64 MiB), but the
 * throw must still be REAL: it was dead until 2026-09-18, because `pad4` wrapped
 * through ToInt32 at exactly the sizes that reach it.
 */
export function buildGlbContainer(json: string, bin: Uint8Array | null): Uint8Array<ArrayBuffer> {
  const text = new TextEncoder().encode(json);
  const jsonLength = pad4(text.length);
  const binLength = bin ? pad4(bin.length) : 0;
  const total = GLB_MIN_BYTES + jsonLength + (bin ? CHUNK_HEADER_BYTES + binLength : 0);
  if (total > GLB_MAX_TOTAL) throw new RangeError(`GLB would be ${total} bytes; the length field is a u32`);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, GLB_CHUNK_JSON, true);
  out.fill(0x20, GLB_MIN_BYTES, GLB_MIN_BYTES + jsonLength);
  out.set(text, GLB_MIN_BYTES);
  if (bin) {
    const at = GLB_MIN_BYTES + jsonLength;
    dv.setUint32(at, binLength, true);
    dv.setUint32(at + 4, GLB_CHUNK_BIN, true);
    out.set(bin, at + CHUNK_HEADER_BYTES); // the zero padding is already there
  }
  return out;
}

/* ── base64 and data: URIs ───────────────────────────────────────────────── */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** The strict decoder, telling the two failures apart (a `data:` URI error
 *  needs to: too large is not the same finding as damaged). */
function decodeBase64Strict(s: string, maxBytes: number): Uint8Array | 'base64' | 'too-large' {
  if (s.length % 4 !== 0 || !BASE64_RE.test(s)) return 'base64';
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  // The decoded size, checked BEFORE a byte is decoded.
  if ((s.length / 4) * 3 - pad > maxBytes) return 'too-large';
  // Canonical: the bits the padding discards must be zero, so every byte
  // string has exactly ONE accepted spelling.
  if (pad === 2 && BASE64_ALPHABET.indexOf(s[s.length - 3]) % 16 !== 0) return 'base64';
  if (pad === 1 && BASE64_ALPHABET.indexOf(s[s.length - 2]) % 4 !== 0) return 'base64';
  let binary: string;
  try {
    binary = atob(s);
  } catch {
    return 'base64';
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Decode CANONICAL base64, or null. Refused: a length that is not a multiple of
 * 4, any character outside `A–Z a–z 0–9 + /` (so no whitespace, no URL-safe
 * `-_`, no percent escapes), more than two `=`, `=` anywhere but the end, and
 * non-zero discarded bits in the last character before the padding (`QR==` is
 * refused where `QQ==` is not). The decoded size is computed from the length
 * and compared with `maxBytes` before anything is decoded.
 */
export function decodeCanonicalBase64(s: string, maxBytes: number): Uint8Array | null {
  const r = decodeBase64Strict(s, maxBytes);
  return typeof r === 'string' ? null : r;
}

export type DataUriError = 'not-data' | 'mime' | 'not-base64' | 'base64' | 'too-large';

/** The header (everything before the first ',', `data:` included) is at most
 *  this long. A real one is `data:image/png;base64` — 21 characters. */
const DATA_URI_HEADER_MAX = 128;
const BUFFER_MEDIA_TYPES = new Set(['', 'application/octet-stream', 'application/gltf-buffer']);
const IMAGE_MEDIA_TYPE_RE = /^image\/[a-z0-9.+-]{1,32}$/;

/**
 * Decode a `data:` URI, strictly. The scheme is case-insensitive; the header
 * must be exactly `data:<mediatype>;base64` (`;base64` case-insensitive) —
 * any other parameter is `not-base64`, and so is a URI with no `;base64` at
 * all. The media type, lower-cased, must be '', application/octet-stream or
 * application/gltf-buffer for a `buffer`, and match `image/<1..32 chars>` for
 * an `image`: an image's FORMAT is decided later by `sniffImageFormat`, never
 * by this string. A URI with no ',' is `not-data`; a header over 128 characters
 * is `mime` (no media type this accepts comes close). The payload goes through
 * `decodeCanonicalBase64`, with `too-large` told apart from `base64`.
 */
export function decodeDataUri(
  uri: string,
  kind: 'buffer' | 'image',
  maxBytes: number,
): { ok: true; mime: string; bytes: Uint8Array } | { ok: false; error: DataUriError } {
  const fail = (error: DataUriError) => ({ ok: false as const, error });
  if (typeof uri !== 'string' || !/^data:/i.test(uri)) return fail('not-data');
  const comma = uri.indexOf(',');
  if (comma < 0) return fail('not-data');
  if (comma > DATA_URI_HEADER_MAX) return fail('mime');
  const params = /^(.*);base64$/i.exec(uri.slice('data:'.length, comma));
  if (!params || params[1].includes(';')) return fail('not-base64');
  const mime = params[1].toLowerCase();
  const mimeOk = kind === 'buffer' ? BUFFER_MEDIA_TYPES.has(mime) : IMAGE_MEDIA_TYPE_RE.test(mime);
  if (!mimeOk) return fail('mime');
  const decoded = decodeBase64Strict(uri.slice(comma + 1), maxBytes);
  if (typeof decoded === 'string') return fail(decoded);
  return { ok: true, mime, bytes: decoded };
}

/** `data:<mime>;base64,<canonical base64>` — the only spelling this module
 *  writes, and one `decodeDataUri` accepts back. */
export function encodeDataUri(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/* ── image sniffing ──────────────────────────────────────────────────────── */

export type SniffedImageFormat = 'png' | 'jpeg' | 'webp' | 'ktx2' | 'avif' | 'unknown';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

function bytesAt(b: Uint8Array, at: number, expect: readonly number[]): boolean {
  if (b.length < at + expect.length) return false;
  for (let i = 0; i < expect.length; i++) if (b[at + i] !== expect[i]) return false;
  return true;
}

function asciiAt(b: Uint8Array, at: number, text: string): boolean {
  if (b.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

/** The image format by magic bytes — never by a file name or a declared MIME. */
export function sniffImageFormat(b: Uint8Array): SniffedImageFormat {
  if (bytesAt(b, 0, PNG_SIGNATURE)) return 'png';
  if (bytesAt(b, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (asciiAt(b, 0, 'RIFF') && asciiAt(b, 8, 'WEBP')) return 'webp';
  if (bytesAt(b, 0, KTX2_IDENTIFIER)) return 'ktx2';
  if (asciiAt(b, 4, 'ftyp') && (asciiAt(b, 8, 'avif') || asciiAt(b, 8, 'avis'))) return 'avif';
  return 'unknown';
}

/** Largest width/height `readImageDimensions` reports (KTX2: a smaller one). */
const IMAGE_DIM_MAX = 65535;
const KTX2_DIM_MAX = 16384;
/** The JPEG segment walk stops after this many segments or this many bytes. */
const JPEG_SEGMENT_MAX = 512;
const JPEG_SCAN_MAX_BYTES = 4 * 1024 * 1024;

function dims(width: number, height: number, max: number): { width: number; height: number } | null {
  const ok = (v: number) => Number.isInteger(v) && v >= 1 && v <= max;
  return ok(width) && ok(height) ? { width, height } : null;
}

const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

/** Start-of-frame markers carrying the frame size: C0–C3, C5–C7, C9–CB, CD–CF
 *  (C4 is DHT, C8 reserved, CC is DAC). */
function isJpegSof(m: number): boolean {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

function jpegDimensions(b: Uint8Array): { width: number; height: number } | null {
  const end = Math.min(b.length, JPEG_SCAN_MAX_BYTES);
  let i = 2; // past SOI
  for (let segment = 0; segment < JPEG_SEGMENT_MAX; segment++) {
    if (i >= end || b[i] !== 0xff) return null;
    while (i + 1 < end && b[i + 1] === 0xff) i++; // fill bytes
    if (i + 1 >= end) return null;
    const marker = b[i + 1];
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2; // standalone: no length field
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // SOS / EOI before any frame header
    if (isJpegSof(marker)) {
      if (i + 9 > end) return null;
      return dims(u16be(b, i + 7), u16be(b, i + 5), IMAGE_DIM_MAX);
    }
    if (i + 4 > end) return null;
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

function webpDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (asciiAt(b, 12, 'VP8 ')) {
    if (b.length < 30 || !bytesAt(b, 23, [0x9d, 0x01, 0x2a])) return null;
    return dims(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff, IMAGE_DIM_MAX);
  }
  if (asciiAt(b, 12, 'VP8L')) {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const width = 1 + (((b[22] & 0x3f) << 8) | b[21]);
    const height = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | (b[22] >> 6));
    return dims(width, height, IMAGE_DIM_MAX);
  }
  if (asciiAt(b, 12, 'VP8X')) {
    if (b.length < 30) return null;
    return dims(1 + u24le(b, 24), 1 + u24le(b, 27), IMAGE_DIM_MAX);
  }
  return null;
}

/**
 * Width and height from an image's HEADER, or null when they cannot be read.
 * Bounded: PNG and KTX2 read fixed offsets; JPEG walks at most 512 segments in
 * the first 4 MiB and gives up at the first scan (SOS) or EOI; WebP reads the
 * first chunk's header (VP8, VP8L or VP8X). The bytes must really be `f` (the
 * magic is re-checked), and each dimension must be 1..65535 (KTX2: 1..16384).
 * An estimate's input only — decoding the picture stays authoritative.
 */
export function readImageDimensions(
  b: Uint8Array,
  f: SniffedImageFormat,
): { width: number; height: number } | null {
  if (f === 'unknown' || f === 'avif' || sniffImageFormat(b) !== f) return null;
  if (f === 'png') {
    if (b.length < 24 || !asciiAt(b, 12, 'IHDR')) return null;
    const dv = dataView(b);
    return dims(dv.getUint32(16, false), dv.getUint32(20, false), IMAGE_DIM_MAX);
  }
  if (f === 'jpeg') return jpegDimensions(b);
  if (f === 'webp') return webpDimensions(b);
  // ktx2: pixelWidth and pixelHeight after the 12-byte identifier and two u32s.
  if (b.length < 28) return null;
  const dv = dataView(b);
  return dims(dv.getUint32(20, true), dv.getUint32(24, true), KTX2_DIM_MAX);
}

/**
 * A 67-byte, 1×1, 8-bit greyscale PNG (value 255), as canonical base64. The
 * writer puts it in place of an image whose texture it removed, so the image
 * array keeps its indices and a stale reference still resolves to a picture.
 */
export const PLACEHOLDER_PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR42mP4DwABAQEAHLCMmQAAAABJRU5ErkJggg==';

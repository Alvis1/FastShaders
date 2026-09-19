/**
 * A BOUNDED reader for the parts of a KTX2 container the trusted side needs:
 * the 80-byte header, the level index, the first data-format-descriptor block
 * (colour model, primaries, transfer function) and the `KTXorientation`
 * key/value entry. Nothing else — no level data, no supercompression globals.
 *
 * KTX2 bytes are adversarial here (an encoder's output about to go into an
 * export, later a model's `image/ktx2` source), so every read is
 * little-endian through a DataView and bounds-checked first, and ANY violation
 * returns null: a wrong identifier, a truncated header or level index, more
 * than 16 levels, a side of 0 or over 16384 px, a face count other than 1 or
 * 6, a level / DFD / KVD / SGD range outside the file, a 64-bit offset above
 * 2^53, a KVD over 64 KiB or 64 entries, a key with no NUL, a non-ASCII
 * orientation, a second `KTXorientation` entry (keys are unique by spec, and
 * ktx-parse would keep the LAST where a first-wins reader keeps the first),
 * 1-3 bytes left inside kvdByteLength after the last entry (every entry's
 * padding is counted in kvdByteLength, and ktx-parse throws on them). It
 * never throws.
 *
 * Offsets follow the KTX 2.0 spec and three's own `ktx-parse` `read()`
 * (node_modules/three/examples/jsm/libs/ktx-parse.module.js), which
 * `ktx2Header.test.ts` holds this reader to on the committed fixtures. The
 * difference is only in what each does with a bad file: ktx-parse reads past
 * the end or throws, this returns null.
 *
 * A zero-import leaf. `isKtx2` is the ONE KTX2 magic check — a later reader
 * that needs one routes through it rather than restating the 12 bytes.
 */

/** «KTX 20» plus the line-ending guard bytes. */
export const KTX2_IDENTIFIER: readonly number[] = Object.freeze([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export const KTX2_HEADER_MAX_LEVELS = 16;
export const KTX2_HEADER_MAX_SIDE = 16384;
export const KTX2_KVD_MAX_BYTES = 65536;
export const KTX2_KVD_MAX_ENTRIES = 64;

/** 12 identifier + 9 u32 fields + 4 u32 DFD/KVD index + 2 u64 SGD index. */
const HEADER_BYTES = 80;
/** byteOffset, byteLength, uncompressedByteLength: three u64s. */
const LEVEL_ENTRY_BYTES = 24;
/** dfdTotalSize u32 + the 24-byte basic descriptor block header. */
const DFD_MIN_BYTES = 28;
const DFD_BLOCK_MIN_BYTES = 24;
const ORIENTATION_KEY = 'KTXorientation';

export interface Ktx2Level {
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface Ktx2Header {
  readonly vkFormat: number;
  readonly typeSize: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly pixelDepth: number;
  readonly layerCount: number;
  readonly faceCount: number;
  /** As stored: 0 means "generate mips at load", and the index still holds one level. */
  readonly levelCount: number;
  readonly supercompressionScheme: number;
  /** null only when the file carries no DFD at all (dfdByteLength 0). */
  readonly colorModel: number | null;
  readonly colorPrimaries: number | null;
  readonly transferFunction: number | null;
  /** The `KTXorientation` value up to its NUL, or null when the key is absent. */
  readonly orientation: string | null;
  /** max(1, levelCount) entries, each inside the file. */
  readonly levels: readonly Ktx2Level[];
}

/** True when `bytes` starts with the 12-byte KTX2 identifier. Nothing more is checked. */
export function isKtx2(bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length < KTX2_IDENTIFIER.length) return false;
  for (let i = 0; i < KTX2_IDENTIFIER.length; i++) if (bytes[i] !== KTX2_IDENTIFIER[i]) return false;
  return true;
}

/** The header, or null on any violation. Never throws. */
export function readKtx2Header(bytes: Uint8Array): Ktx2Header | null {
  try {
    return read(bytes);
  } catch {
    // Every read below is bounds-checked first; this is the backstop that
    // keeps "never throws" true for an input nobody anticipated.
    return null;
  }
}

function read(bytes: Uint8Array): Ktx2Header | null {
  if (!isKtx2(bytes) || bytes.length < HEADER_BYTES) return null;
  const size = bytes.length;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number): number => dv.getUint32(at, true);
  /** A u64 as a safe integer, or -1 when it exceeds 2^53 - 1. */
  const u64 = (at: number): number => {
    const lo = u32(at);
    const hi = u32(at + 4);
    return hi > 0x1fffff ? -1 : hi * 0x100000000 + lo;
  };
  const inFile = (offset: number, length: number): boolean =>
    offset >= 0 && length >= 0 && offset <= size && length <= size - offset;

  const vkFormat = u32(12);
  const typeSize = u32(16);
  const pixelWidth = u32(20);
  const pixelHeight = u32(24);
  const pixelDepth = u32(28);
  const layerCount = u32(32);
  const faceCount = u32(36);
  const levelCount = u32(40);
  const supercompressionScheme = u32(44);
  const dfdByteOffset = u32(48);
  const dfdByteLength = u32(52);
  const kvdByteOffset = u32(56);
  const kvdByteLength = u32(60);
  const sgdByteOffset = u64(64);
  const sgdByteLength = u64(72);

  if (pixelWidth < 1 || pixelWidth > KTX2_HEADER_MAX_SIDE) return null;
  if (pixelHeight < 1 || pixelHeight > KTX2_HEADER_MAX_SIDE) return null;
  if (pixelDepth > KTX2_HEADER_MAX_SIDE) return null;
  if (faceCount !== 1 && faceCount !== 6) return null;
  if (levelCount > KTX2_HEADER_MAX_LEVELS) return null;

  // Level index: max(1, levelCount) entries right after the header.
  const indexed = Math.max(1, levelCount);
  if (!inFile(HEADER_BYTES, indexed * LEVEL_ENTRY_BYTES)) return null;
  const levels: Ktx2Level[] = [];
  for (let i = 0; i < indexed; i++) {
    const at = HEADER_BYTES + i * LEVEL_ENTRY_BYTES;
    const byteOffset = u64(at);
    const byteLength = u64(at + 8);
    const uncompressed = u64(at + 16);
    if (byteOffset < 0 || byteLength < 0 || uncompressed < 0) return null;
    if (!inFile(byteOffset, byteLength)) return null;
    levels.push({ byteOffset, byteLength });
  }

  // First DFD block: dfdTotalSize u32, then vendorId/descriptorType/
  // versionNumber/descriptorBlockSize (u16 each), then colorModel,
  // colorPrimaries, transferFunction (u8 each) — the ktx-parse layout.
  let colorModel: number | null = null;
  let colorPrimaries: number | null = null;
  let transferFunction: number | null = null;
  if (dfdByteLength !== 0) {
    if (dfdByteLength < DFD_MIN_BYTES || !inFile(dfdByteOffset, dfdByteLength)) return null;
    const blockSize = dv.getUint16(dfdByteOffset + 4 + 6, true);
    if (blockSize < DFD_BLOCK_MIN_BYTES || blockSize > dfdByteLength - 4) return null;
    colorModel = bytes[dfdByteOffset + 12];
    colorPrimaries = bytes[dfdByteOffset + 13];
    transferFunction = bytes[dfdByteOffset + 14];
  }

  // KVD: entries of { u32 keyAndValueByteLength, key NUL value, pad to 4 }.
  let orientation: string | null = null;
  if (kvdByteLength !== 0) {
    if (kvdByteLength > KTX2_KVD_MAX_BYTES || !inFile(kvdByteOffset, kvdByteLength)) return null;
    const end = kvdByteOffset + kvdByteLength;
    let p = kvdByteOffset;
    let entries = 0;
    while (end - p >= 4) {
      if (++entries > KTX2_KVD_MAX_ENTRIES) return null;
      const length = u32(p);
      p += 4;
      if (length < 1 || length > end - p) return null;
      let nul = -1;
      for (let i = p; i < p + length; i++) {
        if (bytes[i] === 0) {
          nul = i;
          break;
        }
      }
      if (nul < 0) return null;
      if (keyIs(bytes, p, nul, ORIENTATION_KEY)) {
        // Keys are unique; ktx-parse keeps the LAST of two, so a first-wins
        // read could pass a file three's parser sees as Y-flipped.
        if (orientation !== null) return null;
        let value = '';
        for (let i = nul + 1; i < p + length && bytes[i] !== 0; i++) {
          const c = bytes[i];
          if (c < 0x20 || c > 0x7e) return null;
          value += String.fromCharCode(c);
        }
        orientation = value;
      }
      p += length + ((4 - (length % 4)) % 4);
    }
    // 1-3 bytes left over are not padding (each entry's padding is counted in
    // kvdByteLength) and make ktx-parse's next u32 read throw. p PAST the end
    // — a last entry whose padding kvdByteLength does not count — is accepted,
    // as ktx-parse accepts it.
    if (p < end) return null;
  }

  // SGD: only its range is checked (BasisLZ globals are the transcoder's business).
  if (sgdByteOffset < 0 || sgdByteLength < 0) return null;
  if (sgdByteLength !== 0 && !inFile(sgdByteOffset, sgdByteLength)) return null;

  return {
    vkFormat,
    typeSize,
    pixelWidth,
    pixelHeight,
    pixelDepth,
    layerCount,
    faceCount,
    levelCount,
    supercompressionScheme,
    colorModel,
    colorPrimaries,
    transferFunction,
    orientation,
    levels,
  };
}

function keyIs(bytes: Uint8Array, from: number, to: number, key: string): boolean {
  if (to - from !== key.length) return false;
  for (let i = 0; i < key.length; i++) if (bytes[from + i] !== key.charCodeAt(i)) return false;
  return true;
}

/**
 * The bounded KTX2 header reader (Phase 8, Step 1).
 *
 * PARITY: on the three committed fixtures (three r184's own KTX2 test
 * textures) and on a test-only copy carrying a `KTXorientation` entry, every
 * field this reader reports equals what three's own ktx-parse `read()` reports
 * — so the reader cannot drift from the parser three's KTX2Loader uses.
 *
 * HOSTILITY: every malformed input returns null WITHOUT throwing — each strict
 * prefix of a fixture, a wrong identifier, out-of-range counts and sides, DFD /
 * KVD / level ranges outside the file, 64-bit offsets above 2^53, an oversized
 * or over-full KVD — and a deterministic fuzz never makes it throw.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  KTX2_HEADER_MAX_LEVELS,
  KTX2_IDENTIFIER,
  KTX2_KVD_MAX_ENTRIES,
  isKtx2,
  readKtx2Header,
  type Ktx2Header,
} from './ktx2Header';

const fixture = (f: string) => new Uint8Array(readFileSync(new URL(`../engine/fixtures/ktx2/${f}`, import.meta.url)));
const FIXTURES = ['2d_uastc.ktx2', '2d_etc1s.ktx2', '2d_rgba8.ktx2'] as const;

/** A copy with one little-endian u32 replaced. */
function withU32(bytes: Uint8Array, at: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(at, value, true);
  return copy;
}

/** One KVD entry: u32 length, key, NUL, value, padded to 4. */
function kvEntry(key: string, value: Uint8Array): Uint8Array {
  const length = key.length + 1 + value.length;
  const out = new Uint8Array(4 + length + ((4 - (length % 4)) % 4));
  new DataView(out.buffer).setUint32(0, length, true);
  for (let i = 0; i < key.length; i++) out[4 + i] = key.charCodeAt(i);
  out.set(value, 4 + key.length + 1);
  return out;
}
const ascii = (s: string, nul = true) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)).concat(nul ? [0] : []));
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};

/** A copy whose KVD is REPLACED by `kvd`, appended after the level data. */
function withKvd(bytes: Uint8Array, kvd: Uint8Array): Uint8Array {
  const out = concat([bytes, kvd]);
  const dv = new DataView(out.buffer);
  dv.setUint32(56, bytes.length, true);
  dv.setUint32(60, kvd.length, true);
  return out;
}
const withOrientation = (bytes: Uint8Array, value: string) =>
  withKvd(bytes, concat([kvEntry('KTXwriter', ascii('FastShaders test')), kvEntry('KTXorientation', ascii(value))]));

/* ── parity with three's ktx-parse ─────────────────────────────────────── */

type KtxParseContainer = {
  vkFormat: number;
  typeSize: number;
  pixelWidth: number;
  pixelHeight: number;
  pixelDepth: number;
  layerCount: number;
  faceCount: number;
  levelCount: number;
  supercompressionScheme: number;
  levels: Array<{ levelData: Uint8Array }>;
  dataFormatDescriptor: Array<{ colorModel: number; colorPrimaries: number; transferFunction: number }>;
  keyValue: Record<string, unknown>;
};
const KTX_PARSE = 'three/examples/jsm/libs/ktx-parse.module.js';
const { read } = (await import(/* @vite-ignore */ KTX_PARSE)) as { read(b: Uint8Array): KtxParseContainer };

function asKtxParseSees(bytes: Uint8Array): Omit<Ktx2Header, never> {
  const c = read(bytes);
  const d = c.dataFormatDescriptor[0];
  const orientation = c.keyValue.KTXorientation;
  return {
    vkFormat: c.vkFormat,
    typeSize: c.typeSize,
    pixelWidth: c.pixelWidth,
    pixelHeight: c.pixelHeight,
    pixelDepth: c.pixelDepth,
    layerCount: c.layerCount,
    faceCount: c.faceCount,
    levelCount: c.levelCount,
    supercompressionScheme: c.supercompressionScheme,
    colorModel: d.colorModel,
    colorPrimaries: d.colorPrimaries,
    transferFunction: d.transferFunction,
    orientation: typeof orientation === 'string' ? orientation : null,
    levels: c.levels.map((l) => ({ byteOffset: l.levelData.byteOffset - bytes.byteOffset, byteLength: l.levelData.byteLength })),
  };
}

describe('readKtx2Header matches three\'s ktx-parse', () => {
  const cases: Array<[string, Uint8Array]> = [
    ...FIXTURES.map((f): [string, Uint8Array] => [f, fixture(f)]),
    ['2d_uastc.ktx2 + KTXorientation "rd"', withOrientation(fixture('2d_uastc.ktx2'), 'rd')],
    ['2d_etc1s.ktx2 + KTXorientation "ru"', withOrientation(fixture('2d_etc1s.ktx2'), 'ru')],
    // kvdByteLength stopping short of the LAST entry's 2 padding bytes: the
    // scan ends past `end`, which ktx-parse accepts too.
    ['2d_uastc.ktx2 + KTXorientation "rd", last padding uncounted', (() => {
      const b = withOrientation(fixture('2d_uastc.ktx2'), 'rd');
      return withU32(b, 60, new DataView(b.buffer).getUint32(60, true) - 2);
    })()],
  ];

  it.each(cases)('%s', (_name, bytes) => {
    const ours = readKtx2Header(bytes);
    expect(ours).not.toBeNull();
    expect(ours).toEqual(asKtxParseSees(bytes));
  });

  it('reads the facts the fixture README states', () => {
    const h = readKtx2Header(fixture('2d_uastc.ktx2'))!;
    expect([h.vkFormat, h.pixelWidth, h.pixelHeight, h.levelCount, h.faceCount, h.layerCount, h.supercompressionScheme,
      h.colorModel, h.transferFunction, h.colorPrimaries, h.orientation, h.levels.length]).toEqual(
      [0, 40, 40, 6, 1, 0, 0, 166, 2, 1, null, 6]);
    expect(readKtx2Header(fixture('2d_etc1s.ktx2'))).toMatchObject({ colorModel: 163, supercompressionScheme: 1 });
    expect(readKtx2Header(fixture('2d_rgba8.ktx2'))).toMatchObject({ vkFormat: 43, colorModel: 1 });
    expect(readKtx2Header(withOrientation(fixture('2d_uastc.ktx2'), 'rd'))?.orientation).toBe('rd');
  });

  it('ktx-parse is what the two KVD rejections are held to', () => {
    const uastc = fixture('2d_uastc.ktx2');
    // 1-3 bytes after the last entry: its next u32 read runs off the KVD.
    expect(() => read(withKvd(uastc, concat([kvEntry('KTXorientation', ascii('rd')), new Uint8Array(3)])))).toThrow();
    // Two KTXorientation entries: it keeps the LAST.
    const dup = withKvd(uastc, concat([kvEntry('KTXorientation', ascii('rd')), kvEntry('KTXorientation', ascii('ru'))]));
    expect(read(dup).keyValue.KTXorientation).toBe('ru');
  });

  it('reads a Node Buffer and an offset view of a larger buffer alike', () => {
    const plain = readKtx2Header(fixture('2d_uastc.ktx2'));
    const buf = readFileSync(new URL('../engine/fixtures/ktx2/2d_uastc.ktx2', import.meta.url));
    const padded = new Uint8Array(buf.length + 7);
    padded.set(buf, 7);
    expect(readKtx2Header(buf)).toEqual(plain);
    expect(readKtx2Header(padded.subarray(7))).toEqual(plain);
  });
});

/* ── isKtx2 ─────────────────────────────────────────────────────────────── */

describe('isKtx2 is exactly the 12-byte identifier', () => {
  it('matches the fixtures\' first 12 bytes, and nothing shorter or different', () => {
    expect([...fixture('2d_uastc.ktx2').subarray(0, 12)]).toEqual([...KTX2_IDENTIFIER]);
    expect(isKtx2(Uint8Array.from(KTX2_IDENTIFIER))).toBe(true);
    expect(isKtx2(Uint8Array.from(KTX2_IDENTIFIER.slice(0, 11)))).toBe(false);
    expect(isKtx2(new Uint8Array(0))).toBe(false);
    for (let i = 0; i < 12; i++) {
      const b = Uint8Array.from(KTX2_IDENTIFIER);
      b[i] ^= 0x01;
      expect(isKtx2(b)).toBe(false);
    }
    // A KTX 1.1 file starts «KTX 11».
    expect(isKtx2(Uint8Array.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false);
    expect(isKtx2(Uint8Array.from(KTX2_IDENTIFIER).buffer as unknown as Uint8Array)).toBe(false);
  });
});

/* ── hostile input ──────────────────────────────────────────────────────── */

describe('readKtx2Header returns null on any violation, and never throws', () => {
  const uastc = fixture('2d_uastc.ktx2');
  const nullNoThrow = (bytes: Uint8Array) => {
    let result: Ktx2Header | null | undefined;
    expect(() => (result = readKtx2Header(bytes))).not.toThrow();
    expect(result).toBeNull();
  };

  it('every truncation up to the header length, and every strict prefix of a fixture', () => {
    for (let n = 0; n <= 80; n++) nullNoThrow(uastc.slice(0, n));
    // Level 0 (the largest) ends exactly at the end of the file.
    for (let n = 81; n < uastc.length; n++) nullNoThrow(uastc.slice(0, n));
  });

  it('a wrong identifier', () => {
    for (let i = 0; i < 12; i++) {
      const b = uastc.slice();
      b[i] ^= 0x80;
      nullNoThrow(b);
    }
  });

  it('out-of-range counts and sides', () => {
    nullNoThrow(withU32(uastc, 40, KTX2_HEADER_MAX_LEVELS + 1)); // levelCount 17
    nullNoThrow(withU32(uastc, 20, 0)); // pixelWidth 0
    nullNoThrow(withU32(uastc, 24, 0)); // pixelHeight 0 (a 1D texture)
    nullNoThrow(withU32(uastc, 20, 20000));
    nullNoThrow(withU32(uastc, 24, 20000));
    nullNoThrow(withU32(uastc, 28, 20000)); // pixelDepth
    nullNoThrow(withU32(uastc, 36, 3)); // faceCount 3
    nullNoThrow(withU32(uastc, 36, 0));
    // A cubemap's face count is a legal container; the ENCODER check refuses it.
    expect(readKtx2Header(withU32(uastc, 36, 6))?.faceCount).toBe(6);
  });

  it('ranges outside the file', () => {
    nullNoThrow(withU32(uastc, 48, uastc.length + 1)); // dfdByteOffset past the end
    nullNoThrow(withU32(uastc, 48, uastc.length - 10)); // DFD runs off the end
    nullNoThrow(withU32(uastc, 52, 4)); // DFD too short to hold a block
    nullNoThrow(withU32(uastc, 56, uastc.length)); // kvdByteOffset at the end, length 52
    nullNoThrow(withU32(uastc, 60, 1e9)); // kvdByteLength 1e9
    nullNoThrow(withU32(uastc, 60, 65540)); // over the KVD cap
    nullNoThrow(withU32(uastc, 80, uastc.length)); // level 0 offset: data runs off the end
    nullNoThrow(withU32(uastc, 88, uastc.length)); // level 0 length
    nullNoThrow(withU32(withU32(uastc, 64, 16), 72, uastc.length)); // SGD runs off the end
  });

  it('64-bit fields above 2^53', () => {
    nullNoThrow(withU32(uastc, 84, 0x00200000)); // level 0 byteOffset hi word
    nullNoThrow(withU32(uastc, 92, 0x00200000)); // level 0 byteLength hi word
    nullNoThrow(withU32(uastc, 100, 0xffffffff)); // level 0 uncompressedByteLength
    nullNoThrow(withU32(uastc, 68, 0x00200000)); // sgdByteOffset
    nullNoThrow(withU32(uastc, 76, 0xffffffff)); // sgdByteLength
  });

  it('a malformed or over-full KVD', () => {
    const entry = kvEntry('a', new Uint8Array(0));
    const full = concat(Array.from({ length: KTX2_KVD_MAX_ENTRIES }, () => entry));
    expect(readKtx2Header(withKvd(uastc, full))).not.toBeNull();
    nullNoThrow(withKvd(uastc, concat([full, entry])));
    // A key with no NUL.
    const noNul = new Uint8Array(8);
    new DataView(noNul.buffer).setUint32(0, 4, true);
    noNul.set(ascii('abcd', false), 4);
    nullNoThrow(withKvd(uastc, noNul));
    // An entry longer than the KVD.
    const long = kvEntry('KTXorientation', ascii('rd'));
    new DataView(long.buffer).setUint32(0, 400, true);
    nullNoThrow(withKvd(uastc, long));
    // A zero-length entry.
    nullNoThrow(withKvd(uastc, new Uint8Array(8)));
    // A non-ASCII orientation.
    nullNoThrow(withKvd(uastc, kvEntry('KTXorientation', Uint8Array.from([0x72, 0xe2, 0x80, 0x8b, 0]))));
    // 1-3 bytes left after the last entry are NOT padding (every entry's
    // padding is inside kvdByteLength) — ktx-parse throws on them, zero or not.
    nullNoThrow(withKvd(uastc, concat([kvEntry('KTXorientation', ascii('rd')), new Uint8Array(3)])));
    nullNoThrow(withKvd(uastc, concat([kvEntry('KTXwriter', ascii('FastShaders test')), Uint8Array.of(1, 2, 3)])));
    // A second KTXorientation: ktx-parse keeps the LAST ('ru', flipped), so a
    // first-wins read would pass a file three sees as Y-flipped.
    nullNoThrow(withKvd(uastc, concat([kvEntry('KTXorientation', ascii('rd')), kvEntry('KTXorientation', ascii('ru'))])));
  });

  it('a deterministic fuzz of the header and index region never throws', () => {
    let seed = 0x2d_c0ffee;
    const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x100000000);
    for (const f of FIXTURES) {
      const base = fixture(f);
      for (let round = 0; round < 1500; round++) {
        const b = base.slice();
        const flips = 1 + Math.floor(rand() * 6);
        for (let k = 0; k < flips; k++) b[12 + Math.floor(rand() * 320)] = Math.floor(rand() * 256);
        expect(() => readKtx2Header(b)).not.toThrow();
      }
    }
    for (let round = 0; round < 500; round++) {
      const b = new Uint8Array(12 + Math.floor(rand() * 400));
      b.set(KTX2_IDENTIFIER);
      for (let i = 12; i < b.length; i++) b[i] = Math.floor(rand() * 256);
      expect(() => readKtx2Header(b)).not.toThrow();
    }
  });
});

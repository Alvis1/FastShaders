/**
 * The shared glTF/GLB fixture set in src/test-utils.ts. Every later reader,
 * writer and builder suite trusts these bytes, so this file proves each builder
 * writes what its comment claims — the container layout, the header fields a
 * dimension probe reads (restated here from the reader spec, since the reader
 * does not exist yet), and that makeRealPng really is a decodable PNG.
 */
import { inflateSync, crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  TRIANGLE_POSITIONS,
  gltfPrimitiveDoc,
  jpegHeaderBytes,
  ktx2HeaderBytes,
  makeGlb,
  makeRealPng,
  pngHeaderBytes,
  webpHeaderBytes,
} from './test-utils';
import { packGlb } from './gltfTestFixtures';
import { safeJsonReviver } from './utils/safeJson';

const u32le = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at, true);
const u32be = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at, false);
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

describe('makeGlb', () => {
  it('writes the §11 layout: header, 0x20-padded JSON, 0x00-padded BIN', () => {
    const doc = { asset: { version: '2.0' }, x: 'a' }; // 32 chars of JSON → pads to 32
    const bin = new Uint8Array([1, 2, 3, 4, 5]);
    const g = makeGlb(doc, bin);
    expect(g.buffer.byteLength).toBe(g.length);
    expect(u32le(g, 0)).toBe(0x46546c67);
    expect(u32le(g, 4)).toBe(2);
    expect(u32le(g, 8)).toBe(g.length);
    const jsonLen = u32le(g, 12);
    expect(jsonLen % 4).toBe(0);
    expect(u32le(g, 16)).toBe(0x4e4f534a);
    const text = new TextDecoder().decode(g.subarray(20, 20 + jsonLen));
    expect(JSON.parse(text, safeJsonReviver)).toEqual(doc);
    expect(text.trimEnd()).toBe(JSON.stringify(doc));
    expect([...g.subarray(20 + JSON.stringify(doc).length, 20 + jsonLen)].every((c) => c === 0x20)).toBe(true);
    const at = 20 + jsonLen;
    expect(u32le(g, at)).toBe(8);
    expect(u32le(g, at + 4)).toBe(0x004e4942);
    expect([...g.subarray(at + 8)]).toEqual([1, 2, 3, 4, 5, 0, 0, 0]);
  });

  it('pads a JSON text that is not a multiple of 4', () => {
    const g = makeGlb({ a: 1 }); // {"a":1} = 7 bytes → 8
    expect(u32le(g, 12)).toBe(8);
    expect(g[27]).toBe(0x20);
    expect(g.length).toBe(28);
  });

  it('writes no BIN chunk without bin, and an empty one for an empty bin', () => {
    expect(makeGlb({ a: 1 }).length).toBe(28);
    const g = makeGlb({ a: 1 }, new Uint8Array(0));
    expect(g.length).toBe(36);
    expect(u32le(g, 28)).toBe(0);
    expect(u32le(g, 32)).toBe(0x004e4942);
  });

  it('puts { jsonText } in the JSON chunk verbatim, JSON or not', () => {
    const g = makeGlb({ jsonText: '{ not json' });
    expect(new TextDecoder().decode(g.subarray(20, 20 + u32le(g, 12))).trimEnd()).toBe('{ not json');
  });

  it('encodes non-ASCII names as UTF-8', () => {
    const name = String.fromCharCode(0x136, 0x65, 0x72, 0x6d, 0x65, 0x6e, 0x69, 0x73); // Ķermenis
    const g = makeGlb({ materials: [{ name }] });
    const text = new TextDecoder().decode(g.subarray(20, 20 + u32le(g, 12)));
    expect((JSON.parse(text, safeJsonReviver) as { materials: { name: string }[] }).materials[0].name).toBe(name);
  });

  it('is the container gltfTestFixtures.packGlb uses (one layout in the tree)', () => {
    const doc = gltfPrimitiveDoc({ meshes: [] });
    expect(new Uint8Array(packGlb(doc, TRIANGLE_POSITIONS))).toEqual(makeGlb(doc, TRIANGLE_POSITIONS));
  });
});

describe('TRIANGLE_POSITIONS / gltfPrimitiveDoc', () => {
  it('is 36 bytes of three float32 VEC3s', () => {
    expect(TRIANGLE_POSITIONS.length).toBe(36);
    expect([...new Float32Array(TRIANGLE_POSITIONS.slice().buffer)]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('describes exactly those bytes, and extra keys replace the base', () => {
    const d = gltfPrimitiveDoc() as {
      asset: { version: string };
      buffers: { byteLength: number }[];
      bufferViews: { byteLength: number }[];
      accessors: { count: number; type: string }[];
    };
    expect(d.asset.version).toBe('2.0');
    expect(d.buffers[0].byteLength).toBe(TRIANGLE_POSITIONS.length);
    expect(d.bufferViews[0].byteLength).toBe(TRIANGLE_POSITIONS.length);
    expect(d.accessors[0]).toMatchObject({ count: 3, type: 'VEC3', componentType: 5126 });
    expect(gltfPrimitiveDoc({ buffers: [] }).buffers).toEqual([]);
    expect(gltfPrimitiveDoc({ materials: [{ name: 'A' }] }).materials).toEqual([{ name: 'A' }]);
    // A fresh document each call.
    expect(gltfPrimitiveDoc().bufferViews).not.toBe(gltfPrimitiveDoc().bufferViews);
  });
});

describe('image header fixtures carry the fields a dimension probe reads', () => {
  it('pngHeaderBytes: signature, IHDR at 12 with a true CRC, u32BE dims, filler', () => {
    const b = pngHeaderBytes(2048, 1024, 5);
    expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(u32be(b, 8)).toBe(13);
    expect(ascii(b, 12, 4)).toBe('IHDR');
    expect(u32be(b, 16)).toBe(2048);
    expect(u32be(b, 20)).toBe(1024);
    expect(u32be(b, 29)).toBe(crc32(b.subarray(12, 29)));
    expect(b.length).toBe(33 + 5);
    expect(u32be(pngHeaderBytes(0, 70000), 20)).toBe(70000);
  });

  /** The reader spec's JPEG walk, restated: SOF height at +5, width at +7. */
  function jpegDims(b: Uint8Array): { width: number; height: number; at: number } | null {
    let i = 2;
    for (let seg = 0; seg < 512 && i + 4 <= b.length; seg++) {
      if (b[i] !== 0xff) return null;
      while (b[i] === 0xff) i++;
      const m = b[i];
      const at = i - 1;
      if (m === 0xda || m === 0xd9) return null;
      if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { i++; continue; }
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(m)) {
        return { height: u16be(b, at + 5), width: u16be(b, at + 7), at };
      }
      const len = u16be(b, at + 2);
      if (len < 2) return null;
      i = at + 2 + len;
    }
    return null;
  }

  it('jpegHeaderBytes: SOI, SOF0 dims, and an APP1 run that pushes the SOF out', () => {
    const b = jpegHeaderBytes(640, 480);
    expect([...b.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect(jpegDims(b)).toEqual({ width: 640, height: 480, at: 2 });
    expect([...b.subarray(b.length - 2)]).toEqual([0xff, 0xd9]);
    const big = jpegHeaderBytes(8193, 5, 4 * 1024 * 1024);
    const d = jpegDims(big);
    expect(d).toMatchObject({ width: 8193, height: 5 });
    expect(d!.at).toBeGreaterThan(4 * 1024 * 1024);
    // 4 MiB of payload needs 65 segments of at most 65533 bytes: under the 512 walk cap.
    expect(big.length).toBe(2 + 4 * 1024 * 1024 + 65 * 4 + 19 + 2);
  });

  it('webpHeaderBytes: the three first-chunk layouts', () => {
    const lossy = webpHeaderBytes('VP8 ', 1000, 700);
    expect(ascii(lossy, 0, 4)).toBe('RIFF');
    expect(u32le(lossy, 4)).toBe(lossy.length - 8);
    expect(ascii(lossy, 8, 4)).toBe('WEBP');
    expect(ascii(lossy, 12, 4)).toBe('VP8 ');
    expect([...lossy.subarray(23, 26)]).toEqual([0x9d, 0x01, 0x2a]);
    expect(u16le(lossy, 26) & 0x3fff).toBe(1000);
    expect(u16le(lossy, 28) & 0x3fff).toBe(700);

    const lossless = webpHeaderBytes('VP8L', 16384, 3);
    expect(ascii(lossless, 12, 4)).toBe('VP8L');
    expect(lossless[20]).toBe(0x2f);
    const b = lossless;
    expect(1 + (((b[22] & 0x3f) << 8) | b[21])).toBe(16384);
    expect(1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | (b[22] >> 6))).toBe(3);
    expect(u32le(b, 4)).toBe(b.length - 8);
    expect(b.length % 2).toBe(0);

    const ext = webpHeaderBytes('VP8X', 70000, 1);
    expect(ascii(ext, 12, 4)).toBe('VP8X');
    expect(1 + u24le(ext, 24)).toBe(70000);
    expect(1 + u24le(ext, 27)).toBe(1);
  });

  it('webpHeaderBytes refuses a size its format cannot encode', () => {
    expect(() => webpHeaderBytes('VP8 ', 16384, 1)).toThrow(RangeError);
    expect(() => webpHeaderBytes('VP8L', 0, 1)).toThrow(RangeError);
    expect(() => webpHeaderBytes('VP8X', 1, 0x1000001)).toThrow(RangeError);
  });

  it('ktx2HeaderBytes: the identifier and u32LE pixel dims at 20/24', () => {
    const b = ktx2HeaderBytes(4096, 2048);
    expect([...b.subarray(0, 12)]).toEqual([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(u32le(b, 20)).toBe(4096);
    expect(u32le(b, 24)).toBe(2048);
    expect(u32le(b, 36)).toBe(1);
    expect(u32le(b, 40)).toBe(1);
  });
});

describe('makeRealPng is a real, decodable PNG', () => {
  /** Walk the chunks, checking every CRC; returns { type → data[] }. */
  function chunks(b: Uint8Array): Map<string, Uint8Array[]> {
    const out = new Map<string, Uint8Array[]>();
    let at = 8;
    while (at < b.length) {
      const len = u32be(b, at);
      const type = ascii(b, at + 4, 4);
      const data = b.subarray(at + 8, at + 8 + len);
      expect(u32be(b, at + 8 + len), `${type} CRC`).toBe(crc32(b.subarray(at + 4, at + 8 + len)));
      out.set(type, [...(out.get(type) ?? []), data]);
      at += 12 + len;
      if (type === 'IEND') break;
    }
    expect(at).toBe(b.length);
    return out;
  }

  it('one colour fills every pixel; IHDR is RGBA8, non-interlaced', () => {
    const b = makeRealPng(3, 2, [10, 20, 30, 255]);
    const c = chunks(b);
    const ih = c.get('IHDR')![0];
    expect(u32be(ih, 0)).toBe(3);
    expect(u32be(ih, 4)).toBe(2);
    expect([...ih.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    const raw = inflateSync(Buffer.concat(c.get('IDAT')!));
    expect(raw.length).toBe(2 * (1 + 3 * 4));
    for (let y = 0; y < 2; y++) {
      expect(raw[y * 13]).toBe(0); // filter None
      for (let x = 0; x < 3; x++) expect([...raw.subarray(y * 13 + 1 + x * 4, y * 13 + 5 + x * 4)]).toEqual([10, 20, 30, 255]);
    }
    expect(c.get('IEND')![0].length).toBe(0);
  });

  it('takes per-pixel bytes, row-major', () => {
    const px = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    const raw = inflateSync(Buffer.concat(chunks(makeRealPng(2, 2, px)).get('IDAT')!));
    expect([...raw]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it('refuses a pixel array of the wrong length', () => {
    expect(() => makeRealPng(2, 2, [1, 2, 3])).toThrow(RangeError);
    expect(() => makeRealPng(0, 2, [1, 2, 3, 4])).toThrow(RangeError);
  });
});

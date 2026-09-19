/**
 * The GLB container leaf (`glbContainer.ts`): the strict container parse and
 * build, canonical base64 + `data:` URIs, image sniffing and bounded header
 * dimensions, and the placeholder PNG. Everything it reads comes out of a
 * dropped file, so besides the rule-by-rule pins there is a seeded mutation
 * sweep: no prefix or byte flip of a valid input may throw, and whatever it
 * accepts must still satisfy the caps.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GLB_CHUNK_BIN,
  GLB_CHUNK_JSON,
  GLB_JSON_MAX_BYTES,
  GLB_MAGIC,
  GLB_MAX_CHUNKS,
  PLACEHOLDER_PNG_DATA_URI,
  buildGlbContainer,
  decodeCanonicalBase64,
  decodeDataUri,
  encodeDataUri,
  parseGlbContainer,
  readImageDimensions,
  sniffImageFormat,
  type GlbParseError,
} from './glbContainer';
import { safeJsonReviver } from './safeJson';
import {
  TRIANGLE_POSITIONS,
  gltfPrimitiveDoc,
  jpegHeaderBytes,
  ktx2HeaderBytes,
  makeGlb,
  makeRealPng,
  pngHeaderBytes,
  webpHeaderBytes,
} from '../test-utils';

afterEach(() => {
  vi.restoreAllMocks();
});

const utf8 = (s: string) => new TextEncoder().encode(s);

function concat(...parts: ArrayLike<number>[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

interface RawChunk {
  type: number;
  data?: Uint8Array;
  /** The DECLARED length; defaults to `data.length`. */
  length?: number;
}

/**
 * A container written chunk by chunk, for the layouts `makeGlb` (which only
 * ever writes a well-formed JSON + BIN pair) cannot express: odd chunk orders,
 * unknown chunk types, lying lengths. `total` overrides the declared length,
 * which otherwise covers the chunks but not `tail`.
 */
function rawGlb(
  chunks: RawChunk[],
  o: { version?: number; magic?: number; total?: number; tail?: ArrayLike<number> } = {},
): Uint8Array<ArrayBuffer> {
  const body = chunks.reduce((n, c) => n + 8 + (c.data?.length ?? 0), 0);
  const tail = o.tail ?? [];
  const out = new Uint8Array(12 + body + tail.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, o.magic ?? GLB_MAGIC, true);
  dv.setUint32(4, o.version ?? 2, true);
  dv.setUint32(8, o.total ?? 12 + body, true);
  let at = 12;
  for (const c of chunks) {
    const data = c.data ?? new Uint8Array(0);
    dv.setUint32(at, c.length ?? data.length, true);
    dv.setUint32(at + 4, c.type, true);
    out.set(data, at + 8);
    at += 8 + data.length;
  }
  out.set(tail, at);
  return out;
}

const JSON_CHUNK = (text = '{"asset":{"version":"2.0"}}') => ({ type: GLB_CHUNK_JSON, data: utf8(text) });
const BIN_CHUNK = (data = new Uint8Array([1, 2, 3, 4])) => ({ type: GLB_CHUNK_BIN, data });
const UNKNOWN_CHUNK = (data = new Uint8Array([9, 9, 9, 9])) => ({ type: 0x12345678, data });

function errorOf(bytes: Uint8Array): GlbParseError | 'ok' {
  const r = parseGlbContainer(bytes);
  return r.ok ? 'ok' : r.error;
}

/* ── container: accepted ─────────────────────────────────────────────────── */

describe('parseGlbContainer: accepted', () => {
  it('parses a makeGlb fixture: the JSON text and the BIN chunk as a VIEW', () => {
    const doc = gltfPrimitiveDoc();
    const glb = makeGlb(doc, TRIANGLE_POSITIONS);
    const r = parseGlbContainer(glb);
    if (!r.ok) throw new Error(r.error);
    expect(JSON.parse(r.chunks.json, safeJsonReviver)).toEqual(doc);
    const bin = r.chunks.bin!;
    expect(bin.buffer).toBe(glb.buffer); // a view, never a copy
    expect([...bin]).toEqual([...TRIANGLE_POSITIONS]);
  });

  it.each([
    ['a primitive document + BIN', () => makeGlb(gltfPrimitiveDoc(), TRIANGLE_POSITIONS)],
    ['JSON only (no BIN chunk)', () => makeGlb({ a: 1 })],
    ['an EMPTY BIN chunk', () => makeGlb({ a: 1 }, new Uint8Array(0))],
    ['a padded BIN and a non-ASCII name', () =>
      makeGlb({ materials: [{ name: String.fromCharCode(0x136, 0x65, 0x72, 0x6d, 0x65, 0x6e, 0x69, 0x73) }] },
        new Uint8Array([1, 2, 3]))],
  ])('round-trips byte-identically through buildGlbContainer: %s', (_name, make) => {
    const glb = make();
    const r = parseGlbContainer(glb);
    if (!r.ok) throw new Error(r.error);
    expect(buildGlbContainer(r.chunks.json, r.chunks.bin)).toEqual(glb);
  });

  it('keeps an absent BIN chunk null and an empty one empty', () => {
    const none = parseGlbContainer(makeGlb({ a: 1 }));
    const empty = parseGlbContainer(makeGlb({ a: 1 }, new Uint8Array(0)));
    if (!none.ok || !empty.ok) throw new Error('fixture refused');
    expect(none.chunks.bin).toBeNull();
    expect(empty.chunks.bin).not.toBeNull();
    expect(empty.chunks.bin!.length).toBe(0);
  });

  it('strips a BOM from the JSON exactly as GLTFLoader\'s default TextDecoder does', () => {
    const glb = makeGlb({ jsonText: '\uFEFF{"a":1}' });
    const r = parseGlbContainer(glb);
    if (!r.ok) throw new Error(r.error);
    expect(r.chunks.json.trimEnd()).toBe('{"a":1}');
    const chunk = glb.subarray(20, 20 + new DataView(glb.buffer).getUint32(12, true));
    expect(r.chunks.json).toBe(new TextDecoder().decode(chunk)); // parity: the loader's decoder
  });

  it('decodes invalid UTF-8 without throwing (non-fatal, like the loader)', () => {
    const r = parseGlbContainer(rawGlb([{ type: GLB_CHUNK_JSON, data: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) }]));
    if (!r.ok) throw new Error(r.error);
    expect(r.chunks.json).toBe('{\uFFFD\uFFFD}');
  });

  it('skips unknown chunk types, after BIN or between nothing', () => {
    const r = parseGlbContainer(rawGlb([JSON_CHUNK(), BIN_CHUNK(), UNKNOWN_CHUNK(), UNKNOWN_CHUNK(new Uint8Array(0))]));
    if (!r.ok) throw new Error(r.error);
    expect([...r.chunks.bin!]).toEqual([1, 2, 3, 4]);
    const noBin = parseGlbContainer(rawGlb([JSON_CHUNK(), UNKNOWN_CHUNK()]));
    if (!noBin.ok) throw new Error(noBin.error);
    expect(noBin.chunks.bin).toBeNull();
  });

  it('ignores bytes after the declared length', () => {
    const glb = makeGlb(gltfPrimitiveDoc(), TRIANGLE_POSITIONS);
    const padded = concat(glb, [0xde, 0xad, 0xbe, 0xef, 1, 2, 3]);
    const r = parseGlbContainer(padded);
    if (!r.ok) throw new Error(r.error);
    expect([...r.chunks.bin!]).toEqual([...TRIANGLE_POSITIONS]);
    // A garbage chunk header past L is never looked at either.
    expect(errorOf(rawGlb([JSON_CHUNK()], { tail: [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0] }))).toBe('ok');
  });

  it('reads a container that sits at an offset inside a larger buffer', () => {
    const glb = makeGlb({ a: 1 }, new Uint8Array([5, 6, 7, 8]));
    const host = new Uint8Array(glb.length + 13);
    host.set(glb, 5);
    const r = parseGlbContainer(host.subarray(5, 5 + glb.length));
    if (!r.ok) throw new Error(r.error);
    expect([...r.chunks.bin!]).toEqual([5, 6, 7, 8]);
    expect(r.chunks.bin!.byteOffset).toBe(5 + glb.length - 4);
  });

  it('accepts exactly GLB_MAX_CHUNKS chunks', () => {
    const chunks = [JSON_CHUNK(), ...Array.from({ length: GLB_MAX_CHUNKS - 1 }, () => UNKNOWN_CHUNK(new Uint8Array(0)))];
    expect(errorOf(rawGlb(chunks))).toBe('ok');
  });
});

/* ── container: refused ──────────────────────────────────────────────────── */

describe('parseGlbContainer: refused, each with its code', () => {
  const good = () => makeGlb(gltfPrimitiveDoc(), TRIANGLE_POSITIONS);

  it('short: under 20 bytes', () => {
    expect(errorOf(good().subarray(0, 19))).toBe('short');
    expect(errorOf(new Uint8Array(0))).toBe('short');
  });

  it('magic', () => {
    expect(errorOf(rawGlb([JSON_CHUNK()], { magic: 0x46546c68 }))).toBe('magic');
  });

  it.each([1, 3, 0, 0xffffffff])('version %i', (version) => {
    expect(errorOf(rawGlb([JSON_CHUNK()], { version }))).toBe('version');
  });

  it('length: declared over the file, or under 20', () => {
    const glb = good();
    expect(errorOf(rawGlb([JSON_CHUNK()], { total: 12 + 8 + 27 + 1 }))).toBe('length');
    new DataView(glb.buffer).setUint32(8, 19, true);
    expect(errorOf(glb)).toBe('length');
    // A truncated file is a declared length over the file.
    expect(errorOf(good().subarray(0, good().length - 1))).toBe('length');
  });

  it('chunk-bounds: a chunk header past L, or a chunk length past L', () => {
    // 4 bytes left inside L after the JSON chunk: not room for a header.
    expect(errorOf(rawGlb([JSON_CHUNK()], { tail: [0, 0, 0, 0], total: 12 + 8 + 27 + 4 }))).toBe('chunk-bounds');
    expect(errorOf(rawGlb([{ ...JSON_CHUNK(), length: 0xffffffff }]))).toBe('chunk-bounds');
    expect(errorOf(rawGlb([JSON_CHUNK(), { ...BIN_CHUNK(), length: 5 }]))).toBe('chunk-bounds');
  });

  it('chunk-order: BIN first, a non-JSON first chunk, BIN after an unknown chunk', () => {
    expect(errorOf(rawGlb([BIN_CHUNK(), JSON_CHUNK()]))).toBe('chunk-order');
    expect(errorOf(rawGlb([UNKNOWN_CHUNK(), JSON_CHUNK()]))).toBe('chunk-order');
    expect(errorOf(rawGlb([JSON_CHUNK(), UNKNOWN_CHUNK(), BIN_CHUNK()]))).toBe('chunk-order');
  });

  it('duplicate-chunk: two JSON or two BIN chunks', () => {
    expect(errorOf(rawGlb([JSON_CHUNK(), JSON_CHUNK()]))).toBe('duplicate-chunk');
    expect(errorOf(rawGlb([JSON_CHUNK(), BIN_CHUNK(), BIN_CHUNK()]))).toBe('duplicate-chunk');
    expect(errorOf(rawGlb([JSON_CHUNK(), BIN_CHUNK(), UNKNOWN_CHUNK(), JSON_CHUNK()]))).toBe('duplicate-chunk');
  });

  it('too-many-chunks: 17', () => {
    const chunks = [JSON_CHUNK(), ...Array.from({ length: GLB_MAX_CHUNKS }, () => UNKNOWN_CHUNK(new Uint8Array(0)))];
    expect(chunks.length).toBe(17);
    expect(errorOf(rawGlb(chunks))).toBe('too-many-chunks');
  });

  it('json-empty', () => {
    expect(errorOf(rawGlb([{ type: GLB_CHUNK_JSON, data: new Uint8Array(0) }]))).toBe('json-empty');
    expect(errorOf(rawGlb([{ type: GLB_CHUNK_JSON, data: new Uint8Array(0) }, BIN_CHUNK()]))).toBe('json-empty');
  });

  it('a header CLAIMING an oversized JSON chunk in a short file is chunk-bounds (nothing allocated)', () => {
    expect(errorOf(rawGlb([{ ...JSON_CHUNK(), length: GLB_JSON_MAX_BYTES + 1 }]))).toBe('chunk-bounds');
  });

  it('json-too-large: a REAL 16 MiB + 1 chunk, refused from its header before decoding; 16 MiB passes', () => {
    const n = GLB_JSON_MAX_BYTES + 1;
    const glb = new Uint8Array(20 + n); // one allocation, reused for the boundary
    const dv = new DataView(glb.buffer);
    dv.setUint32(0, GLB_MAGIC, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, glb.length, true);
    dv.setUint32(12, n, true);
    dv.setUint32(16, GLB_CHUNK_JSON, true);
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    expect(errorOf(glb)).toBe('json-too-large');
    expect(decode).not.toHaveBeenCalled();
    // Exactly the cap: accepted (the last byte becomes trailing, ignored).
    dv.setUint32(8, glb.length - 1, true);
    dv.setUint32(12, GLB_JSON_MAX_BYTES, true);
    const r = parseGlbContainer(glb);
    if (!r.ok) throw new Error(r.error);
    expect(r.chunks.json.length).toBe(GLB_JSON_MAX_BYTES);
    expect(decode).toHaveBeenCalledTimes(1);
  });
});

describe('buildGlbContainer', () => {
  it('pads JSON with 0x20 and BIN with 0x00, and omits BIN for null', () => {
    const glb = buildGlbContainer('{"a":1}', new Uint8Array([1, 2, 3, 4, 5]));
    const dv = new DataView(glb.buffer);
    expect(dv.getUint32(0, true)).toBe(GLB_MAGIC);
    expect(dv.getUint32(4, true)).toBe(2);
    expect(dv.getUint32(8, true)).toBe(glb.length);
    expect(dv.getUint32(12, true)).toBe(8);
    expect(glb[27]).toBe(0x20);
    expect(dv.getUint32(28, true)).toBe(8);
    expect(dv.getUint32(32, true)).toBe(GLB_CHUNK_BIN);
    expect([...glb.subarray(36)]).toEqual([1, 2, 3, 4, 5, 0, 0, 0]);
    expect(buildGlbContainer('{"a":1}', null).length).toBe(28);
    expect(buildGlbContainer('{"a":1}', null)).toEqual(makeGlb({ a: 1 }));
  });

  it('writes what parseGlbContainer reads back', () => {
    const json = JSON.stringify(gltfPrimitiveDoc());
    const r = parseGlbContainer(buildGlbContainer(json, TRIANGLE_POSITIONS));
    if (!r.ok) throw new Error(r.error);
    expect(r.chunks.json.trimEnd()).toBe(json);
    expect([...r.chunks.bin!]).toEqual([...TRIANGLE_POSITIONS]);
  });
});

/* ── base64 ──────────────────────────────────────────────────────────────── */

describe('decodeCanonicalBase64', () => {
  it.each([
    ['QQ==', [0x41]],
    ['QUI=', [0x41, 0x42]],
    ['QUJD', [0x41, 0x42, 0x43]],
    ['', []],
    ['+/8=', [0xfb, 0xff]],
  ])('accepts %j', (s, bytes) => {
    const out = decodeCanonicalBase64(s, 1024);
    expect(out).not.toBeNull();
    expect([...out!]).toEqual(bytes);
  });

  it.each([
    'QR==', // discarded bits set (pad 2)
    'QUJ=', // discarded bits set (pad 1)
    'QQ=', // length
    'Q Q==',
    'QQ==\n',
    '-_8=', // URL-safe alphabet
    '%41', // percent escape
    '%41%41==',
    'Q===',
    '====',
    'QQ=A',
    'QUJD====',
  ])('refuses %j', (s) => {
    expect(decodeCanonicalBase64(s, 1024)).toBeNull();
  });

  it('checks maxBytes from the length, BEFORE anything is decoded', () => {
    const atob = vi.spyOn(globalThis, 'atob');
    expect(decodeCanonicalBase64('QUJD', 2)).toBeNull();
    expect(decodeCanonicalBase64('QUI=', 1)).toBeNull();
    expect(atob).not.toHaveBeenCalled();
    expect(decodeCanonicalBase64('QUJD', 3)).not.toBeNull(); // exactly the cap
    expect(atob).toHaveBeenCalledTimes(1);
  });
});

/* ── data: URIs ──────────────────────────────────────────────────────────── */

describe('decodeDataUri', () => {
  it('accepts buffer media types, with ;base64 in any case', () => {
    for (const uri of [
      'data:application/octet-stream;base64,QUJD',
      'data:application/octet-stream;BASE64,QUJD',
      'DATA:Application/Gltf-Buffer;Base64,QUJD',
      'data:;base64,QUJD',
    ]) {
      const r = decodeDataUri(uri, 'buffer', 1024);
      if (!r.ok) throw new Error(`${uri}: ${r.error}`);
      expect([...r.bytes]).toEqual([0x41, 0x42, 0x43]);
    }
    const empty = decodeDataUri('data:;base64,', 'buffer', 1024);
    if (!empty.ok) throw new Error(empty.error);
    expect(empty.mime).toBe('');
    expect(empty.bytes.length).toBe(0);
  });

  it('accepts any image/* type lower-cased (the format is decided by the sniff, not this)', () => {
    const r = decodeDataUri('data:IMAGE/PNG;base64,QUJD', 'image', 1024);
    if (!r.ok) throw new Error(r.error);
    expect(r.mime).toBe('image/png');
    expect(decodeDataUri('data:image/x-foo.bar+baz;base64,QUJD', 'image', 1024).ok).toBe(true);
  });

  it.each<[string, 'buffer' | 'image', string]>([
    ['data:text/plain;base64,QUJD', 'buffer', 'mime'],
    ['data:image/png;base64,QUJD', 'buffer', 'mime'],
    ['data:application/octet-stream;base64,QUJD', 'image', 'mime'],
    ['data:;base64,QUJD', 'image', 'mime'],
    ['data:image/' + 'a'.repeat(33) + ';base64,QUJD', 'image', 'mime'],
    ['data:image/png ;base64,QUJD', 'image', 'mime'],
    ['data:image/png;charset=utf-8;base64,QUJD', 'image', 'not-base64'],
    ['data:application/octet-stream;x=1;base64,QUJD', 'buffer', 'not-base64'],
    ['data:image/png,QUJD', 'image', 'not-base64'],
    ['data:,QUJD', 'buffer', 'not-base64'],
    ['data:;base64,%41%41', 'buffer', 'base64'],
    ['data:;base64,QR==', 'buffer', 'base64'],
    ['data:;base64, QUJD', 'buffer', 'base64'],
    ['https://x/y.png', 'image', 'not-data'],
    ['tex.png', 'image', 'not-data'],
    ['data:image/png;base64', 'image', 'not-data'],
    [' data:;base64,QUJD', 'buffer', 'not-data'],
  ])('refuses %j (%s) as %s', (uri, kind, error) => {
    const r = decodeDataUri(uri, kind, 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(error);
  });

  it('refuses a header over 128 characters', () => {
    const header129 = 'data:' + 'x'.repeat(129 - 'data:'.length - ';base64'.length) + ';base64';
    expect(header129.length).toBe(129);
    const r = decodeDataUri(header129 + ',QUJD', 'buffer', 1024);
    expect(r.ok).toBe(false);
  });

  it('tells too-large apart from damaged, checked before decoding', () => {
    const atob = vi.spyOn(globalThis, 'atob');
    const r = decodeDataUri('data:;base64,QUJD', 'buffer', 2);
    expect(r).toEqual({ ok: false, error: 'too-large' });
    expect(atob).not.toHaveBeenCalled();
  });

  it('encodeDataUri writes a URI decodeDataUri accepts back', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    const uri = encodeDataUri('image/webp', bytes);
    expect(uri.startsWith('data:image/webp;base64,')).toBe(true);
    const r = decodeDataUri(uri, 'image', 1024);
    if (!r.ok) throw new Error(r.error);
    expect(r.mime).toBe('image/webp');
    expect([...r.bytes]).toEqual([...bytes]);
    const buf = decodeDataUri(encodeDataUri('application/octet-stream', TRIANGLE_POSITIONS), 'buffer', 36);
    expect(buf.ok).toBe(true);
  });
});

/* ── sniffing ────────────────────────────────────────────────────────────── */

describe('sniffImageFormat', () => {
  const avif = (brand: string) => concat([0, 0, 0, 0x1c], utf8('ftyp' + brand), new Uint8Array(8));
  it.each<[string, Uint8Array, string]>([
    ['png', pngHeaderBytes(1, 1), 'png'],
    ['real png', makeRealPng(2, 2, [1, 2, 3, 255]), 'png'],
    ['jpeg', jpegHeaderBytes(8, 8), 'jpeg'],
    ['webp VP8', webpHeaderBytes('VP8 ', 8, 8), 'webp'],
    ['webp VP8L', webpHeaderBytes('VP8L', 8, 8), 'webp'],
    ['ktx2', ktx2HeaderBytes(4, 4), 'ktx2'],
    ['avif', avif('avif'), 'avif'],
    ['avis', avif('avis'), 'avif'],
    ['heic is not avif', avif('heic'), 'unknown'],
    ['RIFF WAVE', concat(utf8('RIFF'), [0, 0, 0, 0], utf8('WAVE')), 'unknown'],
    ['3 bytes of a png', new Uint8Array([0x89, 0x50, 0x4e]), 'unknown'],
    ['2 bytes of a jpeg', new Uint8Array([0xff, 0xd8]), 'unknown'],
    ['empty', new Uint8Array(0), 'unknown'],
    ['a GLB', makeGlb({ a: 1 }), 'unknown'],
  ])('%s', (_name, bytes, format) => {
    expect(sniffImageFormat(bytes)).toBe(format);
  });
});

/* ── dimensions ──────────────────────────────────────────────────────────── */

describe('readImageDimensions', () => {
  const at = (b: Uint8Array) => readImageDimensions(b, sniffImageFormat(b));

  it('PNG from IHDR', () => {
    expect(at(pngHeaderBytes(4096, 2048))).toEqual({ width: 4096, height: 2048 });
    expect(at(makeRealPng(3, 5, [0, 0, 0, 255]))).toEqual({ width: 3, height: 5 });
    expect(at(pngHeaderBytes(65535, 1))).toEqual({ width: 65535, height: 1 });
  });

  it('PNG: zero, oversize, truncated or no IHDR → null', () => {
    expect(at(pngHeaderBytes(0, 16))).toBeNull();
    expect(at(pngHeaderBytes(16, 65536))).toBeNull();
    expect(at(pngHeaderBytes(0xffffffff, 1))).toBeNull();
    expect(at(pngHeaderBytes(16, 16).subarray(0, 23))).toBeNull();
    const bad = pngHeaderBytes(16, 16);
    bad[15] = 0x58; // 'IHDX'
    expect(at(bad)).toBeNull();
  });

  it('JPEG: the SOF after a 60 KB APP1, fill bytes and standalone markers', () => {
    expect(at(jpegHeaderBytes(1920, 1080, 60_000))).toEqual({ width: 1920, height: 1080 });
    const withFill = concat([0xff, 0xd8], [0xff, 0xff, 0xff, 0xd0], [0xff, 0x01], jpegHeaderBytes(640, 480).subarray(2));
    expect(at(withFill)).toEqual({ width: 640, height: 480 });
    // SOF2 (progressive) is a frame header too.
    const progressive = jpegHeaderBytes(33, 44);
    progressive[3] = 0xc2;
    expect(at(progressive)).toEqual({ width: 33, height: 44 });
  });

  it('JPEG: a scan before any frame header, EOI, a bad length or a non-marker → null', () => {
    expect(at(concat([0xff, 0xd8], [0xff, 0xda, 0x00, 0x02], jpegHeaderBytes(8, 8).subarray(2)))).toBeNull();
    expect(at(concat([0xff, 0xd8], [0xff, 0xd9], jpegHeaderBytes(8, 8).subarray(2)))).toBeNull();
    expect(at(concat([0xff, 0xd8], [0xff, 0xe0, 0x00, 0x01], jpegHeaderBytes(8, 8).subarray(2)))).toBeNull();
    expect(at(concat([0xff, 0xd8], [0x00, 0xe0, 0x00, 0x02], jpegHeaderBytes(8, 8).subarray(2)))).toBeNull();
    // DHT (C4) is not a frame header: its "size" must not be reported.
    expect(at(concat([0xff, 0xd8], [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00], [0xff, 0xd9]))).toBeNull();
  });

  it('JPEG: zero dimensions → null', () => {
    expect(at(jpegHeaderBytes(0, 480))).toBeNull();
    expect(at(jpegHeaderBytes(640, 0))).toBeNull();
  });

  it('JPEG: at most 512 segments', () => {
    const dummies = (n: number) => concat([0xff, 0xd8], ...Array.from({ length: n }, () => [0xff, 0xe0, 0x00, 0x02]),
      jpegHeaderBytes(640, 480).subarray(2));
    expect(at(dummies(511))).toEqual({ width: 640, height: 480 }); // the SOF is segment 512
    expect(at(dummies(512))).toBeNull();
    expect(at(dummies(513))).toBeNull();
  });

  it('JPEG: only the first 4 MiB are scanned', () => {
    expect(at(jpegHeaderBytes(640, 480, 4 * 1024 * 1024))).toBeNull();
    expect(at(jpegHeaderBytes(640, 480, 4 * 1024 * 1024 - 1024))).toEqual({ width: 640, height: 480 });
  });

  it('WebP: VP8, VP8L and VP8X', () => {
    expect(at(webpHeaderBytes('VP8 ', 16383, 7))).toEqual({ width: 16383, height: 7 });
    expect(at(webpHeaderBytes('VP8L', 16384, 16384))).toEqual({ width: 16384, height: 16384 });
    expect(at(webpHeaderBytes('VP8L', 1, 1))).toEqual({ width: 1, height: 1 });
    expect(at(webpHeaderBytes('VP8L', 1234, 4321))).toEqual({ width: 1234, height: 4321 });
    expect(at(webpHeaderBytes('VP8X', 65535, 3))).toEqual({ width: 65535, height: 3 });
  });

  it('WebP: oversize, zero, a broken start code or signature, an unknown chunk → null', () => {
    expect(at(webpHeaderBytes('VP8X', 65536, 3))).toBeNull();
    expect(at(webpHeaderBytes('VP8 ', 0, 7))).toBeNull();
    const vp8 = webpHeaderBytes('VP8 ', 8, 8);
    vp8[24] = 0x02;
    expect(at(vp8)).toBeNull();
    const vp8l = webpHeaderBytes('VP8L', 8, 8);
    vp8l[20] = 0x2e;
    expect(at(vp8l)).toBeNull();
    const other = webpHeaderBytes('VP8X', 8, 8);
    other[15] = 0x51; // 'VP8Q'
    expect(at(other)).toBeNull();
  });

  it('KTX2: up to 16384', () => {
    expect(at(ktx2HeaderBytes(16384, 2))).toEqual({ width: 16384, height: 2 });
    expect(at(ktx2HeaderBytes(16385, 2))).toBeNull();
    expect(at(ktx2HeaderBytes(0, 2))).toBeNull();
    expect(at(ktx2HeaderBytes(4, 4).subarray(0, 27))).toBeNull();
  });

  it('refuses a format the bytes are not, and the formats it has no reader for', () => {
    expect(readImageDimensions(pngHeaderBytes(8, 8), 'jpeg')).toBeNull();
    expect(readImageDimensions(jpegHeaderBytes(8, 8), 'png')).toBeNull();
    expect(readImageDimensions(pngHeaderBytes(8, 8), 'ktx2')).toBeNull();
    expect(readImageDimensions(pngHeaderBytes(8, 8), 'avif')).toBeNull();
    expect(readImageDimensions(pngHeaderBytes(8, 8), 'unknown')).toBeNull();
  });
});

/* ── placeholder ─────────────────────────────────────────────────────────── */

describe('PLACEHOLDER_PNG_DATA_URI', () => {
  it('is canonical base64 of a 67-byte 1×1 PNG', () => {
    const payload = PLACEHOLDER_PNG_DATA_URI.slice(PLACEHOLDER_PNG_DATA_URI.indexOf(',') + 1);
    const bytes = decodeCanonicalBase64(payload, 1024)!;
    expect(bytes).not.toBeNull();
    expect(bytes.length).toBe(67);
    expect(sniffImageFormat(bytes)).toBe('png');
    expect(readImageDimensions(bytes, 'png')).toEqual({ width: 1, height: 1 });
    const r = decodeDataUri(PLACEHOLDER_PNG_DATA_URI, 'image', 1024);
    if (!r.ok) throw new Error(r.error);
    expect(r.mime).toBe('image/png');
    expect([...r.bytes]).toEqual([...bytes]);
  });
});

/* ── hostile input ───────────────────────────────────────────────────────── */

/** A small deterministic generator, so a failure is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const PARSE_ERRORS: ReadonlySet<string> = new Set<GlbParseError>([
  'short', 'magic', 'version', 'length', 'chunk-bounds', 'chunk-order',
  'duplicate-chunk', 'too-many-chunks', 'json-empty', 'json-too-large',
]);

function checkParse(bytes: Uint8Array): void {
  const r = parseGlbContainer(bytes);
  if (!r.ok) {
    expect(PARSE_ERRORS.has(r.error)).toBe(true);
    return;
  }
  expect(r.chunks.json.length).toBeGreaterThan(0);
  expect(r.chunks.json.length).toBeLessThanOrEqual(GLB_JSON_MAX_BYTES);
  if (r.chunks.bin) {
    expect(r.chunks.bin.buffer).toBe(bytes.buffer);
    expect(r.chunks.bin.byteOffset + r.chunks.bin.length).toBeLessThanOrEqual(bytes.byteOffset + bytes.length);
  }
}

function checkDims(bytes: Uint8Array): void {
  for (const f of ['png', 'jpeg', 'webp', 'ktx2', 'avif', 'unknown'] as const) {
    const d = readImageDimensions(bytes, f);
    if (d) {
      expect(Number.isInteger(d.width) && Number.isInteger(d.height)).toBe(true);
      expect(d.width).toBeGreaterThanOrEqual(1);
      expect(d.height).toBeGreaterThanOrEqual(1);
      expect(Math.max(d.width, d.height)).toBeLessThanOrEqual(f === 'ktx2' ? 16384 : 65535);
    }
  }
}

describe('hostile input: prefixes and seeded mutations never throw', () => {
  const containers = [
    makeGlb(gltfPrimitiveDoc(), TRIANGLE_POSITIONS),
    rawGlb([JSON_CHUNK(), BIN_CHUNK(), UNKNOWN_CHUNK()]),
  ];
  const images = [
    pngHeaderBytes(640, 480),
    jpegHeaderBytes(640, 480, 300),
    webpHeaderBytes('VP8 ', 640, 480),
    webpHeaderBytes('VP8L', 640, 480),
    webpHeaderBytes('VP8X', 640, 480),
    ktx2HeaderBytes(640, 480),
  ];

  it('every prefix', () => {
    for (const c of containers) for (let n = 0; n <= c.length; n++) checkParse(c.slice(0, n));
    for (const img of images) for (let n = 0; n <= img.length; n++) checkDims(img.slice(0, n));
  });

  it('2000 seeded byte mutations (header fields biased)', () => {
    const rand = lcg(0x5eed);
    for (let round = 0; round < 2000; round++) {
      const pickContainer = round % 2 === 0;
      const src = pickContainer ? containers[Math.floor(round / 2) % containers.length] : images[Math.floor(round / 2) % images.length];
      const b = src.slice();
      const flips = 1 + Math.floor(rand() * 4);
      for (let k = 0; k < flips; k++) {
        // Half the flips land in the first 32 bytes, where every length and
        // type field lives.
        const i = rand() < 0.5 ? Math.floor(rand() * Math.min(32, b.length)) : Math.floor(rand() * b.length);
        b[i] = rand() < 0.3 ? [0x00, 0xff, 0x7f, 0x80][Math.floor(rand() * 4)] : Math.floor(rand() * 256);
      }
      if (pickContainer) checkParse(b);
      else {
        expect(['png', 'jpeg', 'webp', 'ktx2', 'avif', 'unknown']).toContain(sniffImageFormat(b));
        checkDims(b);
      }
    }
  });

  it('seeded junk strings through the data: URI decoder', () => {
    const rand = lcg(0xda7a);
    const alphabet = 'data:;,base64BASE64image/png=+/%AQ \n\u00e9\uFEFF';
    for (let round = 0; round < 1000; round++) {
      let s = '';
      const len = Math.floor(rand() * 48);
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
      for (const kind of ['buffer', 'image'] as const) {
        const r = decodeDataUri(s, kind, 64);
        if (r.ok) expect(r.bytes.length).toBeLessThanOrEqual(64);
      }
      const b = decodeCanonicalBase64(s, 64);
      if (b) expect(b.length).toBeLessThanOrEqual(64);
    }
  });
});

/* ── source pins ─────────────────────────────────────────────────────────── */

describe('glbContainer.ts source', () => {
  const src = readFileSync(join(__dirname, 'glbContainer.ts'), 'utf8');

  it('is a leaf: it imports binaryCodec and nothing else', () => {
    const imports = [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./binaryCodec']);
  });

  it('never reaches the network, a decoder or three, and parses no JSON', () => {
    for (const token of ['fetch(', 'new Image', 'createImageBitmap', 'XMLHttpRequest', 'createObjectURL', 'import(', "from 'three", 'JSON.parse(']) {
      expect(src.includes(token), token).toBe(false);
    }
  });
});

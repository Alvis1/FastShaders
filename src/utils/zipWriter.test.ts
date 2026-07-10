import { describe, it, expect } from 'vitest';
import { buildZip, crc32 } from './zipWriter';
import { collectImageFiles } from './imageNode';
import { makeNode } from '../test-utils';

const enc = new TextEncoder();

describe('crc32', () => {
  it('matches the standard check vector', () => {
    // The canonical CRC-32 test vector: "123456789" → 0xCBF43926.
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

/** Minimal reader for the STORE-only zips buildZip produces. */
function readZip(zip: Uint8Array): { name: string; data: Uint8Array; crc: number }[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // EOCD is at the very end (we write no comment).
  const eocd = zip.length - 22;
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // central directory offset
  const entries: { name: string; data: Uint8Array; crc: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50);
    expect(dv.getUint16(p + 10, true)).toBe(0); // method: store
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    // Follow the local header to the stored bytes.
    expect(dv.getUint32(localOff, true)).toBe(0x04034b50);
    const localNameLen = dv.getUint16(localOff + 26, true);
    const localExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    entries.push({ name, data: zip.subarray(dataStart, dataStart + size), crc });
    p += 46 + nameLen;
  }
  return entries;
}

describe('buildZip', () => {
  it('round-trips entries through a spec-level reader', () => {
    const a = enc.encode('export default shader;\n');
    const b = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const zip = buildZip([
      { name: 'shader.js', data: a },
      { name: 'images/cat.webp', data: b },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['shader.js', 'images/cat.webp']);
    expect(Array.from(entries[0].data)).toEqual(Array.from(a));
    expect(Array.from(entries[1].data)).toEqual(Array.from(b));
    expect(entries[0].crc).toBe(crc32(a));
    expect(entries[1].crc).toBe(crc32(b));
  });

  it('is deterministic (no timestamps)', () => {
    const entries = [{ name: 'x.txt', data: enc.encode('hi') }];
    expect(Array.from(buildZip(entries))).toEqual(Array.from(buildZip(entries)));
  });
});

describe('collectImageFiles', () => {
  const B64 = btoa('abc');
  const img = (id: string, fileName: string, mime = 'webp') =>
    makeNode(id, 'imageNode', {
      imageB64: `data:image/${mime};base64,${B64}`,
      width: 2,
      height: 2,
      fileName,
    });

  it('uses the real payload mime for the extension, not the stored name', () => {
    const files = collectImageFiles([img('a', 'cat.jpg', 'webp')]);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('cat.webp');
    expect(Array.from(files[0].bytes)).toEqual([97, 98, 99]);
  });

  it('sanitizes hostile filenames (no traversal, no separators)', () => {
    const files = collectImageFiles([img('a', '../../../etc/passwd.png')]);
    expect(files[0].name).not.toContain('/');
    expect(files[0].name).not.toContain('..');
    expect(files[0].name.endsWith('.webp')).toBe(true);
  });

  it('dedupes colliding names and falls back for empty ones', () => {
    const files = collectImageFiles([img('a', 'cat.png'), img('b', 'cat.png'), img('c', '')]);
    expect(files.map((f) => f.name)).toEqual(['cat.webp', 'cat-2.webp', 'image3.webp']);
  });

  it('skips nodes with invalid payloads', () => {
    const bad = makeNode('x', 'imageNode', {
      imageB64: 'https://evil.example/x.png',
      width: 2,
      height: 2,
      fileName: 'x.png',
    });
    expect(collectImageFiles([bad, img('a', 'ok.png')])).toHaveLength(1);
  });
});

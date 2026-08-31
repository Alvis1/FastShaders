import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { buildZip, crc32 } from './zipWriter';
import { readZip } from './zipReader';

const enc = new TextEncoder();

/** Hand-assemble a single-entry method-8 (deflate) zip, the shape OS tools
 *  produce, since buildZip only writes STORE entries. */
function deflateZip(name: string, raw: Uint8Array): Uint8Array {
  const comp = new Uint8Array(deflateRawSync(raw));
  const nameBytes = enc.encode(name);
  const out = new Uint8Array(30 + nameBytes.length + comp.length + 46 + nameBytes.length + 22);
  const dv = new DataView(out.buffer);
  let p = 0;
  dv.setUint32(p, 0x04034b50, true);
  dv.setUint16(p + 4, 20, true);
  dv.setUint16(p + 8, 8, true); // deflate
  dv.setUint32(p + 14, crc32(raw), true);
  dv.setUint32(p + 18, comp.length, true);
  dv.setUint32(p + 22, raw.length, true);
  dv.setUint16(p + 26, nameBytes.length, true);
  out.set(nameBytes, p + 30);
  out.set(comp, p + 30 + nameBytes.length);
  p += 30 + nameBytes.length + comp.length;
  const cdStart = p;
  dv.setUint32(p, 0x02014b50, true);
  dv.setUint16(p + 10, 8, true);
  dv.setUint32(p + 16, crc32(raw), true);
  dv.setUint32(p + 20, comp.length, true);
  dv.setUint32(p + 24, raw.length, true);
  dv.setUint16(p + 28, nameBytes.length, true);
  dv.setUint32(p + 42, 0, true);
  out.set(nameBytes, p + 46);
  p += 46 + nameBytes.length;
  dv.setUint32(p, 0x06054b50, true);
  dv.setUint16(p + 8, 1, true);
  dv.setUint16(p + 10, 1, true);
  dv.setUint32(p + 12, p - cdStart, true);
  dv.setUint32(p + 16, cdStart, true);
  return out;
}

describe('readZip', () => {
  it('round-trips buildZip output (STORE)', async () => {
    const a = enc.encode('export default shader;\n');
    const b = new Uint8Array([1, 2, 3, 250]);
    const zip = buildZip([
      { name: 'shader.js', data: a },
      { name: 'images/cat.webp', data: b },
    ]);
    const entries = await readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['shader.js', 'images/cat.webp']);
    expect(Array.from(entries[0].data)).toEqual(Array.from(a));
    expect(Array.from(entries[1].data)).toEqual(Array.from(b));
  });

  it('inflates deflate (method 8) entries — the OS re-zip case', async () => {
    const raw = enc.encode('const x = 1;\n'.repeat(200));
    const entries = await readZip(deflateZip('shader.js', raw));
    expect(entries).toHaveLength(1);
    expect(Array.from(entries[0].data)).toEqual(Array.from(raw));
  });

  it('skips directory markers', async () => {
    const zip = buildZip([
      { name: 'images/', data: new Uint8Array(0) },
      { name: 'images/a.png', data: new Uint8Array([1]) },
    ]);
    const entries = await readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['images/a.png']);
  });

  it('rejects garbage and truncated archives', async () => {
    await expect(readZip(enc.encode('not a zip at all'))).rejects.toThrow();
    const zip = buildZip([{ name: 'a.txt', data: enc.encode('hello world') }]);
    await expect(readZip(zip.subarray(0, zip.length - 30))).rejects.toThrow();
  });

  it('rejects archives whose declared size exceeds the cap', async () => {
    // Forge a central directory claiming a 100 MB entry.
    const zip = buildZip([{ name: 'a.bin', data: new Uint8Array(8) }]);
    const dv = new DataView(zip.buffer);
    const cdStart = dv.getUint32(zip.length - 22 + 16, true);
    dv.setUint32(cdStart + 24, 100 * 1024 * 1024, true); // uncompressed size
    await expect(readZip(zip)).rejects.toThrow(/too large/);
  });
});

/**
 * DRIFT GUARD. `public/podest.html` accepts dropped `.zip` shaders too, and
 * being a standalone vanilla page it carries its OWN hand-written reader with
 * its own copy of these caps beside a comment saying it mirrors this module.
 * The name cap had already drifted (256 there against 512 here) — a divergence
 * that shows up only as a legitimate archive being refused on the pedestal
 * while it opens fine in the editor, which reads as a corrupt file.
 *
 * Both sides are read as SOURCE TEXT: podest cannot be imported, and these
 * constants are module-private here, so text is what the two have in common.
 */
describe('podest.html zip caps mirror zipReader', () => {
  const num = (src: string, decl: RegExp, what: string): number => {
    const m = decl.exec(src);
    expect(m, `${what} not found`).not.toBeNull();
    // Evaluated rather than parsed: the totals are written as `64 * 1024 * 1024`.
    const v = Number(new Function(`return (${m![1]});`)());
    expect(Number.isFinite(v), `${what} is not a finite number`).toBe(true);
    return v;
  };

  it('agrees on entry count, total uncompressed size and name length', () => {
    const podest = readFileSync(new URL('../../public/podest.html', import.meta.url), 'utf8');
    const reader = readFileSync(new URL('./zipReader.ts', import.meta.url), 'utf8');

    for (const name of ['MAX_ENTRIES', 'MAX_TOTAL_UNCOMPRESSED', 'MAX_NAME_LENGTH']) {
      const mine = num(reader, new RegExp(`const ${name} = ([^;]+);`), `zipReader ${name}`);
      const theirs = num(podest, new RegExp(`var ${name} = ([^;]+);`), `podest ${name}`);
      expect(theirs, `podest.html's ${name} has drifted from zipReader's`).toBe(mine);
    }
  });
});

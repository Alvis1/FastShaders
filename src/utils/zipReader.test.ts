import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { buildZip, crc32 } from './zipWriter';
import {
  readZip,
  ZipLimitError,
  isZipLimitError,
  MAX_ENTRIES,
  MAX_TOTAL_UNCOMPRESSED,
  MAX_NAME_LENGTH,
  MAX_ARCHIVE_BYTES,
  DESKTOP_MAX_TOTAL_UNCOMPRESSED,
  READ_MAX_TOTAL_UNCOMPRESSED,
} from './zipReader';
import { MESH_MAX_BYTES } from './previewMesh';

const enc = new TextEncoder();

/** The rejection a promise ends in (fails the test if it resolves). */
async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

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
    const e = await rejectionOf(readZip(zip));
    expect(isZipLimitError(e)).toBe(true);
    expect(e).toMatchObject({ kind: 'total-size', limit: MAX_TOTAL_UNCOMPRESSED });
    expect((e as ZipLimitError).value).toBeGreaterThan(MAX_TOTAL_UNCOMPRESSED);
  });
});

describe('readZip caps', () => {
  it('opens a model at its cap plus 32 MiB of everything else — and no more', () => {
    // The reader must open anything the writer emits (see zipLargestBundle.test.ts).
    expect(MAX_TOTAL_UNCOMPRESSED).toBe(96 * 2 ** 20);
    expect(MAX_TOTAL_UNCOMPRESSED).toBe(MESH_MAX_BYTES + 32 * 2 ** 20);
    // Content AT the cap, with every header a legal archive can carry, always
    // passes the pre-read gate.
    expect(MAX_ARCHIVE_BYTES).toBeGreaterThanOrEqual(
      MAX_TOTAL_UNCOMPRESSED + MAX_ENTRIES * (30 + 46 + 2 * MAX_NAME_LENGTH) + 22,
    );
  });

  it('refuses more than MAX_ENTRIES entries with a typed entry-count error', async () => {
    const zip = buildZip(
      Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({ name: `f${i}.txt`, data: new Uint8Array([1]) })),
    );
    const e = await rejectionOf(readZip(zip));
    expect(e).toBeInstanceOf(ZipLimitError);
    expect(e).toMatchObject({ kind: 'entry-count', limit: 512, value: 513 });
    expect((e as Error).message).toBe('too many entries (513)');
  });

  it('refuses an over-long entry name with a typed name error', async () => {
    const zip = buildZip([{ name: 'a'.repeat(MAX_NAME_LENGTH + 1), data: new Uint8Array([1]) }]);
    const e = await rejectionOf(readZip(zip));
    expect(e).toMatchObject({ kind: 'name', limit: 512, value: 513 });
  });

  it('refuses a compression method it cannot read with a typed method error', async () => {
    const zip = buildZip([{ name: 'a.txt', data: enc.encode('hello') }]);
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const cdStart = dv.getUint32(zip.length - 22 + 16, true);
    dv.setUint16(8, 12, true); // local header: bzip2
    dv.setUint16(cdStart + 10, 12, true); // central directory: bzip2
    const e = await rejectionOf(readZip(zip));
    expect(e).toMatchObject({ kind: 'method', limit: 8, value: 12 });
  });

  it('reports corruption as a plain Error, never as a cap', async () => {
    expect(isZipLimitError(await rejectionOf(readZip(enc.encode('not a zip at all'))))).toBe(false);
    const zip = buildZip([{ name: 'a.txt', data: enc.encode('hello world') }]);
    expect(isZipLimitError(await rejectionOf(readZip(zip.subarray(0, zip.length - 30))))).toBe(false);
  });

  it('isZipLimitError recognises the class, or a same-named Error carrying valid fields', () => {
    expect(isZipLimitError(new ZipLimitError('name', 512, 600, 'x'))).toBe(true);
    const twin = Object.assign(new Error('x'), { name: 'ZipLimitError', kind: 'method', limit: 8, value: 14 });
    expect(isZipLimitError(twin)).toBe(true);
    expect(isZipLimitError(Object.assign(new Error('x'), { name: 'ZipLimitError', kind: 'nope', limit: 1, value: 2 }))).toBe(false);
    expect(isZipLimitError(Object.assign(new Error('x'), { name: 'ZipLimitError', kind: 'name', limit: NaN, value: 2 }))).toBe(false);
    expect(isZipLimitError(new Error('archive too large'))).toBe(false);
    expect(isZipLimitError('archive too large')).toBe(false);
    expect(isZipLimitError(null)).toBe(false);
    expect(isZipLimitError({})).toBe(false);
  });

  it('throws no untyped error for any cap (source pin)', () => {
    const src = readFileSync(new URL('./zipReader.ts', import.meta.url), 'utf8');
    const plain = [...src.matchAll(/new Error\(([^)]*)\)/g)].map((m) => m[1]);
    for (const msg of plain) {
      expect(msg).not.toMatch(/too large|too many entries|name too long|unsupported compression/);
    }
  });
});

/**
 * DRIFT GUARD. `public/podest.html` accepts dropped `.zip` shaders too, and
 * being a standalone vanilla page it carries its OWN hand-written reader with
 * its own copy of these caps beside a comment saying it mirrors this module.
 * The name cap once drifted (256 there against 512 here; FIXED) — a divergence
 * that shows up only as a legitimate archive being refused on the pedestal
 * while it opens fine in the editor, which reads as a corrupt file. The guard
 * also backs the 96 MB raise, which has to land on both sides at once.
 * podestLimits.test.ts additionally EXECUTES podest's reader against these caps.
 *
 * Both sides are read as SOURCE TEXT: podest cannot be imported, and these
 * constants are module-private here, so text is what the two have in common.
 */
describe('podest.html zip caps mirror zipReader', () => {
  const num = (src: string, decl: RegExp, what: string): number => {
    const m = decl.exec(src);
    expect(m, `${what} not found`).not.toBeNull();
    // Evaluated rather than parsed: the totals are written as `96 * 1024 * 1024`
    // (or in terms of MESH_MAX_BYTES, which is in scope here).
    const v = Number(new Function('MESH_MAX_BYTES', `return (${m![1]});`)(MESH_MAX_BYTES));
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

/**
 * The SUM cap is a PARAMETER since the desktop room (GLB Phase 6): the desktop
 * build reads up to DESKTOP_MAX_TOTAL_UNCOMPRESSED, the web keeps the 96 MiB
 * literal podest shares. Every total-size refusal must report the cap that was
 * actually applied, on all three paths that can raise one.
 */
describe('readZip: the SUM cap is a parameter (desktop room)', () => {
  const MiB = 1024 * 1024;
  /** Rewrite the only central-directory entry's declared uncompressed size. */
  const forgeDeclared = (zip: Uint8Array, bytes: number): Uint8Array => {
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const cdStart = dv.getUint32(zip.length - 22 + 16, true);
    dv.setUint32(cdStart + 24, bytes, true);
    return zip;
  };

  it('defaults to THIS build\'s read cap, which is the web cap under vitest', async () => {
    expect(READ_MAX_TOTAL_UNCOMPRESSED).toBe(MAX_TOTAL_UNCOMPRESSED);
    const e = await rejectionOf(readZip(forgeDeclared(buildZip([{ name: 'a.bin', data: new Uint8Array(8) }]), 100 * MiB)));
    expect(e).toMatchObject({ kind: 'total-size', limit: READ_MAX_TOTAL_UNCOMPRESSED });
  });

  it('a 97 MiB declared total is refused at the web cap and passes the declared gate at the desktop cap', async () => {
    const zip = forgeDeclared(buildZip([{ name: 'a.bin', data: new Uint8Array(8) }]), 97 * MiB);
    const e = await rejectionOf(readZip(zip));
    expect(isZipLimitError(e)).toBe(true);
    expect(e).toMatchObject({ kind: 'total-size', limit: MAX_TOTAL_UNCOMPRESSED });
    // The declared size is only an early reject: past it, the STORE entry's real
    // 8 bytes are read. Whatever the result, it is not a total-size refusal.
    let desktopErr: unknown = null;
    try {
      await readZip(zip, DESKTOP_MAX_TOTAL_UNCOMPRESSED);
    } catch (err) {
      desktopErr = err;
    }
    expect(isZipLimitError(desktopErr) && (desktopErr as ZipLimitError).kind === 'total-size').toBe(false);
  });

  it('the declared-size gate reports the cap passed in', async () => {
    const zip = buildZip([{ name: 'a.bin', data: new Uint8Array(64) }]);
    const e = await rejectionOf(readZip(zip, 32));
    expect(e).toMatchObject({ kind: 'total-size', limit: 32, value: 64 });
  });

  it('the streamed STORE budget reports the cap passed in', async () => {
    // Declared 1 byte, so the early gate passes; the real 64 bytes do not fit 32.
    const zip = forgeDeclared(buildZip([{ name: 'a.bin', data: new Uint8Array(64) }]), 1);
    const e = await rejectionOf(readZip(zip, 32));
    expect(e).toMatchObject({ kind: 'total-size', limit: 32, value: 64 });
  });

  it('the streamed DEFLATE budget reports the cap passed in', async () => {
    const zip = forgeDeclared(deflateZip('a.bin', new Uint8Array(1000)), 1);
    const e = await rejectionOf(readZip(zip, 100));
    expect(isZipLimitError(e)).toBe(true);
    expect(e).toMatchObject({ kind: 'total-size', limit: 100 });
    expect((e as ZipLimitError).value).toBeGreaterThan(100);
  });
});

/**
 * "The reader opens anything the writer emits" — the invariant the zip SUM cap
 * (zipReader MAX_TOTAL_UNCOMPRESSED) is sized by, checked on real bytes.
 *
 * Heavy on purpose (a ~72 MiB bundle and a 96 MiB deflate bomb, ~0.5 GB peak),
 * so both cases live in this one file with generous timeouts, and every large
 * buffer is dropped before the test returns: the suite runs `isolate: false`,
 * so whatever this file keeps alive, the next file in the worker pays for.
 */
import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './zipWriter';
import { buildExportBundle } from './exportBundle';
import { readZip, isZipLimitError, MAX_ARCHIVE_BYTES, MAX_TOTAL_UNCOMPRESSED, type ZipLimitError } from './zipReader';
import { MAX_TOTAL_IMAGE_CHARS } from './imageNode';
import { MESH_MAX_BYTES, createPreviewMesh } from './previewMesh';

describe('the largest legal export re-opens', () => {
  it('reads back a bundle at the soft image caps carrying a model at its cap', async () => {
    // Images at the project cap: one file of that many bytes under images/,
    // and the .js carries every image TWICE (the inlined module and the
    // project block's nodes), plus room for the code itself.
    const imageBytes = Math.ceil(MAX_TOTAL_IMAGE_CHARS * 0.75);
    let jsText: string | null = 'x'.repeat(2 * MAX_TOTAL_IMAGE_CHARS + 256 * 1024);
    let image: Uint8Array | null = new Uint8Array(imageBytes);
    image[0] = 7;
    let model: Uint8Array<ArrayBuffer> | null = new Uint8Array(MESH_MAX_BYTES);
    model.set([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]); // "glTF" v2

    let bundle: ReturnType<typeof buildExportBundle> | null = buildExportBundle(
      'my-shader',
      jsText,
      [{ name: 'tex.webp', bytes: image }],
      { name: 'model.glb', kind: 'glb', bytes: model },
    );
    expect(bundle.kind).toBe('zip');
    expect(bundle.bytes.length).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES);

    const want = new Map<string, { length: number; crc: number }>([
      ['my-shader.js', { length: jsText.length, crc: crc32(new TextEncoder().encode(jsText)) }],
      ['images/tex.webp', { length: image.length, crc: crc32(image) }],
      ['models/model.glb', { length: model.length, crc: crc32(model) }],
    ]);
    jsText = null;
    image = null;
    model = null;

    let entries: Awaited<ReturnType<typeof readZip>> | null = await readZip(bundle.bytes);
    bundle = null;
    expect(entries.map((e) => e.name)).toEqual(['my-shader.js', 'images/tex.webp', 'models/model.glb', 'README.txt']);

    const sum = entries.reduce((n, e) => n + e.data.length, 0);
    // The OLD 64 MiB cap refused this bundle — the reason for the raise.
    expect(sum).toBeGreaterThan(64 * 2 ** 20);
    expect(sum).toBeLessThanOrEqual(MAX_TOTAL_UNCOMPRESSED);

    for (const e of entries) {
      const w = want.get(e.name);
      if (!w) continue; // README.txt
      expect(e.data.length, e.name).toBe(w.length);
      expect(crc32(e.data), e.name).toBe(w.crc);
    }

    const glb = entries.find((e) => e.name === 'models/model.glb')!;
    const result = createPreviewMesh('model.glb', glb.data);
    expect('mesh' in result).toBe(true);
    entries = null;
  }, 60_000);

  it('stops a deflate bomb on the STREAMED counter, whatever the directory declares', async () => {
    let raw: Uint8Array | null = new Uint8Array(MAX_TOTAL_UNCOMPRESSED + 1);
    let comp: Uint8Array | null = new Uint8Array(deflateRawSync(raw));
    raw = null;

    // One method-8 entry whose central directory claims 1 byte, so the cheap
    // declared-size check passes and only the streamed budget can catch it.
    const name = new TextEncoder().encode('bomb.bin');
    let zip: Uint8Array | null = new Uint8Array(30 + name.length + comp.length + 46 + name.length + 22);
    const dv = new DataView(zip.buffer);
    let p = 0;
    dv.setUint32(p, 0x04034b50, true);
    dv.setUint16(p + 8, 8, true);
    dv.setUint32(p + 18, comp.length, true);
    dv.setUint32(p + 22, 1, true);
    dv.setUint16(p + 26, name.length, true);
    zip.set(name, p + 30);
    zip.set(comp, p + 30 + name.length);
    p += 30 + name.length + comp.length;
    const cdStart = p;
    dv.setUint32(p, 0x02014b50, true);
    dv.setUint16(p + 10, 8, true);
    dv.setUint32(p + 20, comp.length, true);
    dv.setUint32(p + 24, 1, true); // the lie
    dv.setUint16(p + 28, name.length, true);
    zip.set(name, p + 46);
    p += 46 + name.length;
    dv.setUint32(p, 0x06054b50, true);
    dv.setUint16(p + 8, 1, true);
    dv.setUint16(p + 10, 1, true);
    dv.setUint32(p + 12, p - cdStart, true);
    dv.setUint32(p + 16, cdStart, true);
    comp = null;

    let caught: unknown = null;
    try {
      await readZip(zip);
    } catch (e) {
      caught = e;
    }
    zip = null;
    expect(isZipLimitError(caught)).toBe(true);
    expect(caught).toMatchObject({ kind: 'total-size', limit: MAX_TOTAL_UNCOMPRESSED });
    expect((caught as ZipLimitError).value).toBeGreaterThan(MAX_TOTAL_UNCOMPRESSED);
  }, 60_000);
});

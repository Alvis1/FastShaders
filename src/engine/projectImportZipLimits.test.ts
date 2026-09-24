/**
 * importShaderZip's typed outcomes, and the ONE catch-side mapping every
 * import surface calls (`reportZipImportError`).
 *
 * A reader cap THROWS (and changes nothing); a corrupt archive still resolves
 * null; a refused model beside a script loads the shader and posts the canvas
 * import-note line; a refused model in a model-only zip throws
 * ZipModelSkippedError. Store-mutating, and `isolate: false` shares this store
 * with later files — hence the resets on both sides.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HISTORY_IDLE } from '@/test-utils';
import { buildZip, type ZipEntry } from '@/utils/zipWriter';
import { createPreviewMesh, MESH_MAX_BYTES, MESH_BAD_GLB_KEY } from '@/utils/previewMesh';
import { ZipLimitError, MAX_ARCHIVE_BYTES, MAX_TOTAL_UNCOMPRESSED } from '@/utils/zipReader';
import { useAppStore } from '@/store/useAppStore';
import {
  importShaderZip,
  reportZipImportError,
  ZipModelSkippedError,
  isZipModelSkippedError,
} from './projectImport';

const enc = new TextEncoder();
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0]);
const SCRIPT = [
  'import { positionGeometry } from "three/tsl";',
  'export default function () {',
  '  return positionGeometry;',
  '}',
  '',
].join('\n');

function zipFile(entries: ZipEntry[], name = 'export.zip'): File {
  return new File([buildZip(entries) as BlobPart], name, { type: 'application/zip' });
}

/** A minimal GLB whose JSON chunk declares `json` (previewMesh.test.ts's shape). */
function glbWith(json: string): Uint8Array {
  const chunk = enc.encode(json);
  const out = new Uint8Array(20 + chunk.length);
  const view = new DataView(out.buffer);
  out.set([0x67, 0x6c, 0x54, 0x46], 0);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, chunk.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(chunk, 20);
  return out;
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

function reset(): void {
  useAppStore.getState().setPreviewMesh(null);
  useAppStore.setState({ pendingLimitNotices: [], importNote: null, ...HISTORY_IDLE });
}
beforeEach(reset);
afterEach(reset);

describe('importShaderZip: reader caps', () => {
  it('rethrows a ZipLimitError and changes nothing', async () => {
    const stale = createPreviewMesh('stale.glb', GLB_BYTES);
    if ('error' in stale) throw new Error(stale.error);
    useAppStore.getState().setPreviewMesh(stale.mesh);
    const before = useAppStore.getState();

    const entries: ZipEntry[] = [{ name: 'shader.js', data: enc.encode(SCRIPT) }];
    for (let i = 0; i < 512; i++) entries.push({ name: `x/${i}.txt`, data: new Uint8Array([1]) });
    const e = await rejectionOf(importShaderZip(zipFile(entries)));

    expect(e).toBeInstanceOf(ZipLimitError);
    expect(e).toMatchObject({ kind: 'entry-count', limit: 512, value: 513 });
    const after = useAppStore.getState();
    expect(after.previewMesh).toBe(stale.mesh);
    expect(after.nodes).toBe(before.nodes);
    expect(after.past.length).toBe(before.past.length);
    // importShaderZip itself announces nothing — the surface's catch does.
    expect(after.pendingLimitNotices).toEqual([]);
  });

  it('refuses an oversized archive BEFORE reading it into memory', async () => {
    const arrayBuffer = vi.fn();
    const file = { name: 'big.zip', size: MAX_ARCHIVE_BYTES + 1, type: 'application/zip', arrayBuffer } as unknown as File;
    const e = await rejectionOf(importShaderZip(file));
    expect(e).toMatchObject({ kind: 'total-size', limit: MAX_TOTAL_UNCOMPRESSED, value: MAX_ARCHIVE_BYTES + 1 });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('still resolves null for a corrupt archive (the "no shader" message)', async () => {
    expect(await importShaderZip(new File([enc.encode('not a zip at all')], 'junk.zip'))).toBeNull();
  });
});

describe('importShaderZip: a refused model no longer vanishes', () => {
  it('loads the shader and posts the import-note line for a bad GLB', async () => {
    const result = await importShaderZip(zipFile([
      { name: 'shader.js', data: enc.encode(SCRIPT) },
      { name: 'models/fake.glb', data: enc.encode('not a glb at all') },
    ]));
    expect(result).toBe('script');
    expect(useAppStore.getState().previewMesh).toBeNull();
    const note = useAppStore.getState().importNote;
    expect(note?.lines[0]).toMatchObject({
      kind: 'zip-model-skipped',
      shaderLoaded: true,
      fileName: 'export.zip',
      refusal: { reason: 'bad-glb' },
    });
  });

  it('reports an empty model', async () => {
    await importShaderZip(zipFile([
      { name: 'shader.js', data: enc.encode(SCRIPT) },
      { name: 'models/e.obj', data: new Uint8Array(0) },
    ]));
    expect(useAppStore.getState().importNote?.lines[0]).toMatchObject({ refusal: { reason: 'empty' } });
  });

  it('loads a KTX2-required model from a zip — the transcoder is bundled now', async () => {
    const result = await importShaderZip(zipFile([
      { name: 'shader.js', data: enc.encode(SCRIPT) },
      { name: 'models/robot.glb', data: glbWith(JSON.stringify({ extensionsRequired: ['KHR_texture_basisu'] })) },
    ]));
    expect(result).toBe('script');
    const mesh = useAppStore.getState().previewMesh;
    expect(mesh?.name).toBe('robot.glb');
    expect(mesh?.decoders).toEqual({ draco: false, meshopt: false, ktx2: true });
    expect(useAppStore.getState().importNote?.lines ?? []).toEqual([]);
  });

  it('loads a Draco model from a zip as the preview mesh — the decoders are bundled now', async () => {
    const result = await importShaderZip(zipFile([
      { name: 'shader.js', data: enc.encode(SCRIPT) },
      { name: 'models/robot.glb', data: glbWith(JSON.stringify({ extensionsRequired: ['KHR_draco_mesh_compression'] })) },
    ]));
    expect(result).toBe('script');
    const mesh = useAppStore.getState().previewMesh;
    expect(mesh?.name).toBe('robot.glb');
    expect(mesh?.decoders).toEqual({ draco: true, meshopt: false, ktx2: false });
    const lines = useAppStore.getState().importNote?.lines ?? [];
    expect(lines.some((l) => l.kind === 'zip-model-skipped')).toBe(false);
  });

  it('reports a model over MESH_MAX_BYTES — reachable inside a zip only since the 96 MiB raise', async () => {
    const big = new Uint8Array(MESH_MAX_BYTES + 1);
    big.set([0x67, 0x6c, 0x54, 0x46]);
    await importShaderZip(zipFile([
      { name: 'shader.js', data: enc.encode(SCRIPT) },
      { name: 'models/huge.glb', data: big },
    ]));
    expect(useAppStore.getState().previewMesh).toBeNull();
    expect(useAppStore.getState().importNote?.lines[0]).toMatchObject({
      shaderLoaded: true,
      refusal: { reason: 'too-large', sizeBytes: MESH_MAX_BYTES + 1 },
    });
  }, 30_000);

  it('throws ZipModelSkippedError for a model-only zip, before touching the store', async () => {
    const e = await rejectionOf(importShaderZip(zipFile([
      { name: 'models/fake.glb', data: enc.encode('not a glb') },
    ], 'model.zip')));
    expect(isZipModelSkippedError(e)).toBe(true);
    expect((e as ZipModelSkippedError).refusal.reason).toBe('bad-glb');
    expect((e as ZipModelSkippedError).bytes).toBe(9);
    expect(useAppStore.getState().previewMesh).toBeNull();
    expect(useAppStore.getState().importNote).toBeNull();
  });
});

describe('reportZipImportError', () => {
  it('queues one zip-limit notice for a reader cap', () => {
    const handled = reportZipImportError(new ZipLimitError('entry-count', 512, 700, 'too many entries (700)'), 'a.zip');
    expect(handled).toBe(true);
    const notices = useAppStore.getState().pendingLimitNotices;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: 'zip-limit',
      fileName: 'a.zip',
      zipLimit: { kind: 'entry-count', limit: 512, value: 700 },
    });
  });

  it('posts the import note for a skipped model (nothing loaded)', () => {
    const refusal = { reason: 'bad-glb' as const, key: MESH_BAD_GLB_KEY };
    expect(reportZipImportError(new ZipModelSkippedError(refusal, 9), 'm.zip')).toBe(true);
    expect(useAppStore.getState().importNote?.lines).toEqual([
      { kind: 'zip-model-skipped', shaderLoaded: false, fileName: 'm.zip', refusal },
    ]);
    expect(useAppStore.getState().pendingLimitNotices).toEqual([]);
  });

  it('leaves anything else to the surface and touches nothing', () => {
    expect(reportZipImportError(new Error('boom'), 'a.zip')).toBe(false);
    expect(reportZipImportError('boom', 'a.zip')).toBe(false);
    expect(useAppStore.getState().pendingLimitNotices).toEqual([]);
    expect(useAppStore.getState().importNote).toBeNull();
  });

  it('recognises a same-named error from a second module instance', () => {
    const twin = Object.assign(new Error('x'), {
      name: 'ZipModelSkippedError',
      refusal: { reason: 'empty', key: 'The model file is empty.' },
      bytes: 0,
    });
    expect(isZipModelSkippedError(twin)).toBe(true);
    expect(isZipModelSkippedError(Object.assign(new Error('x'), { name: 'ZipModelSkippedError', refusal: null, bytes: 0 }))).toBe(false);
    expect(isZipModelSkippedError(Object.assign(new Error('x'), {
      name: 'ZipModelSkippedError', refusal: { reason: 'nope', key: 'k' }, bytes: 0,
    }))).toBe(false);
  });
});

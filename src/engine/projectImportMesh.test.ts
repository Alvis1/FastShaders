import { describe, it, expect, beforeEach } from 'vitest';
import { buildZip, type ZipEntry } from '@/utils/zipWriter';
import { createPreviewMesh, splatEvalRefusal, type MeshRejectReason } from '@/utils/previewMesh';
import { useAppStore } from '@/store/useAppStore';
import { splatRows } from '@/test-utils';
import {
  importShaderText,
  importShaderZip,
  isZipModelSkippedError,
  zipModelOutcome,
  ZipModelSkippedError,
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

function zipFile(entries: ZipEntry[]): File {
  return new File([buildZip(entries) as BlobPart], 'export.zip', { type: 'application/zip' });
}

function seedStaleMesh(): void {
  const result = createPreviewMesh('stale.glb', GLB_BYTES);
  if ('error' in result) throw new Error(result.error);
  useAppStore.getState().setPreviewMesh(result.mesh);
}

beforeEach(() => {
  useAppStore.getState().setPreviewMesh(null);
});

describe('importShaderZip: model restore', () => {
  it('loads a models/ entry as the preview mesh with a sanitized name', async () => {
    const result = await importShaderZip(zipFile([
      { name: 'shader.js', data: enc.encode(SCRIPT) },
      { name: 'models/my robot!.glb', data: GLB_BYTES },
    ]));
    expect(result).toBe('script');
    const mesh = useAppStore.getState().previewMesh;
    expect(mesh?.kind).toBe('glb');
    expect(mesh?.name).toBe('my-robot.glb');
  });

  it('skips junk entries (__MACOSX, dotfiles) when picking the model', async () => {
    await importShaderZip(zipFile([
      { name: '__MACOSX/ghost.glb', data: GLB_BYTES },
      { name: 'models/.hidden.glb', data: GLB_BYTES },
      { name: 'shader.js', data: enc.encode(SCRIPT) },
      { name: 'models/real.obj', data: enc.encode('v 0 0 0') },
    ]));
    const mesh = useAppStore.getState().previewMesh;
    expect(mesh?.name).toBe('real.obj');
    expect(mesh?.kind).toBe('obj');
    expect(mesh?.text).toBe('v 0 0 0');
  });

  it('ignores an invalid model (bad glb magic) instead of storing garbage', async () => {
    await importShaderZip(zipFile([
      { name: 'shader.js', data: enc.encode(SCRIPT) },
      { name: 'models/fake.glb', data: enc.encode('not a glb at all') },
    ]));
    expect(useAppStore.getState().previewMesh).toBeNull();
  });

  it('loads a model-only zip as the preview mesh and reports "model"', async () => {
    const result = await importShaderZip(zipFile([
      { name: 'models/lonely.glb', data: GLB_BYTES },
    ]));
    expect(result).toBe('model');
    expect(useAppStore.getState().previewMesh?.name).toBe('lonely.glb');
  });

  it('still rejects a zip with neither script nor model', async () => {
    const result = await importShaderZip(zipFile([
      { name: 'README.txt', data: enc.encode('hello') },
    ]));
    expect(result).toBeNull();
  });

  it('clears a stale session mesh when the zip carries no model', async () => {
    seedStaleMesh();
    await importShaderZip(zipFile([
      { name: 'shader.js', data: enc.encode(SCRIPT) },
    ]));
    expect(useAppStore.getState().previewMesh).toBeNull();
  });
});

describe('importShaderText: stale-mesh clearing', () => {
  it('clears the session mesh on a bare text import', () => {
    seedStaleMesh();
    importShaderText(SCRIPT);
    expect(useAppStore.getState().previewMesh).toBeNull();
  });

  it('keeps the mesh when the zip path asks for it', () => {
    seedStaleMesh();
    importShaderText(SCRIPT, { keepPreviewMesh: true });
    expect(useAppStore.getState().previewMesh?.name).toBe('stale.glb');
  });
});

describe('a Gaussian splat in a zip', () => {
  it('loads a models/ .splat as the preview mesh, with its sniffed facts', async () => {
    const result = await importShaderZip(zipFile([
      { name: 'shader.js', data: enc.encode(SCRIPT) },
      { name: 'models/garden.splat', data: splatRows(64) },
    ]));
    expect(result).toBe('script');
    const mesh = useAppStore.getState().previewMesh;
    expect(mesh?.kind).toBe('splat');
    expect(mesh?.splat?.count).toBe(64);
    expect(mesh?.text).toBeUndefined();
  });

  it('outside a study session the outcome is the constructor’s', () => {
    const got = zipModelOutcome('models/garden.splat', splatRows(8), false);
    expect('mesh' in got && got.mesh.kind).toBe('splat');
    const bad = zipModelOutcome('models/garden.splat', new Uint8Array(33), false);
    expect('refusal' in bad && bad.refusal.reason).toBe('bad-splat');
  });

  it('in a study session every splat kind is refused on its KIND, before any sniff', () => {
    // Bytes that would sniff as damaged: the refusal must still be the study
    // one, since the file is never looked at.
    for (const name of ['a.splat', 'b.SPZ', 'models/c.ply', 'd.ksplat']) {
      const got = zipModelOutcome(name, new Uint8Array(3), true);
      expect('refusal' in got && got.refusal, name).toEqual(splatEvalRefusal());
    }
    // A mesh model is untouched by the study switch.
    const glb = zipModelOutcome('models/robot.glb', GLB_BYTES, true);
    expect('mesh' in glb && glb.mesh.kind).toBe('glb');
  });

  it('a refused model-only zip is recognised by NAME for every refusal reason, too', () => {
    // `isZipModelSkippedError` falls back to the error's name and shape when
    // `instanceof` fails (a second module instance under isolate:false), so the
    // reason set it checks must hold every MeshRejectReason — the splat ones
    // included — or such a refusal is reported as "no shader".
    const reasons = [
      'unsupported', 'empty', 'too-large', 'bad-glb', 'compressed',
      'bad-splat', 'splat-count', 'ply-not-splat', 'ply-sh', 'ply-compressed', 'spz-version', 'gltf-splat', 'splat-eval',
    ] as const satisfies readonly MeshRejectReason[];
    for (const reason of reasons) {
      const e = Object.assign(new Error('x'), { name: 'ZipModelSkippedError', refusal: { reason, key: 'k' }, bytes: 1 });
      expect(isZipModelSkippedError(e), reason).toBe(true);
      expect(isZipModelSkippedError(new ZipModelSkippedError({ reason, key: 'k' }, 1)), reason).toBe(true);
    }
    const forged = Object.assign(new Error('x'), { name: 'ZipModelSkippedError', refusal: { reason: 'nope', key: 'k' }, bytes: 1 });
    expect(isZipModelSkippedError(forged)).toBe(false);
  });
});

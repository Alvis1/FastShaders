import { describe, it, expect, beforeEach } from 'vitest';
import { buildZip, type ZipEntry } from '@/utils/zipWriter';
import { createPreviewMesh } from '@/utils/previewMesh';
import { useAppStore } from '@/store/useAppStore';
import { importShaderText, importShaderZip } from './projectImport';

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

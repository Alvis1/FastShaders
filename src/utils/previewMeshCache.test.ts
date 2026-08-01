import { describe, it, expect } from 'vitest';
import { meshToRecord, recordToMesh } from './previewMeshCache';
import { createPreviewMesh, MESH_MAX_BYTES, type PreviewMesh } from './previewMesh';

const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46]; // "glTF"

function glbBytes(len = 32): Uint8Array {
  const b = new Uint8Array(len);
  b.set(GLB_MAGIC, 0);
  return b;
}

function makeMesh(name: string, bytes: Uint8Array): PreviewMesh {
  const r = createPreviewMesh(name, bytes);
  if (!('mesh' in r)) throw new Error(r.error);
  return r.mesh;
}

describe('meshToRecord', () => {
  it('keeps only the sanitized name and the bytes', () => {
    const rec = meshToRecord(makeMesh('teapot.glb', glbBytes()));
    expect(Object.keys(rec).sort()).toEqual(['bytes', 'name']);
    expect(rec.name).toBe('teapot.glb');
    expect(new Uint8Array(rec.bytes).slice(0, 4)).toEqual(new Uint8Array(GLB_MAGIC));
  });

  it('copies into an exactly-sized buffer (no oversized backing buffer stored)', () => {
    // A view into the middle of a bigger buffer: structured-cloning it directly
    // would persist the whole 4096-byte buffer, not the 32 bytes we care about.
    const backing = new ArrayBuffer(4096);
    const view = new Uint8Array(backing, 128, 32);
    view.set(GLB_MAGIC, 0);
    const rec = meshToRecord(makeMesh('x.glb', view));
    expect(rec.bytes.byteLength).toBe(32);
  });

  it('drops the derived text and the session id', () => {
    const mesh = makeMesh('shape.obj', new TextEncoder().encode('v 0 0 0\n'));
    expect(mesh.text).toBeDefined();
    const rec = meshToRecord(mesh) as Record<string, unknown>;
    expect(rec.text).toBeUndefined();
    expect(rec.id).toBeUndefined();
  });
});

describe('recordToMesh', () => {
  it('round-trips a mesh through the record form', () => {
    const original = makeMesh('teapot.glb', glbBytes());
    const restored = recordToMesh(meshToRecord(original));
    expect(restored).not.toBeNull();
    expect(restored!.name).toBe(original.name);
    expect(restored!.kind).toBe('glb');
    expect(restored!.bytes).toEqual(original.bytes);
  });

  it('re-derives text for the text formats', () => {
    const original = makeMesh('shape.obj', new TextEncoder().encode('v 1 2 3\n'));
    const restored = recordToMesh(meshToRecord(original));
    expect(restored!.text).toBe('v 1 2 3\n');
  });

  it('assigns a FRESH session id, so restoring forces an iframe rebuild', () => {
    const original = makeMesh('teapot.glb', glbBytes());
    const restored = recordToMesh(meshToRecord(original));
    // The rebuild key is `custom:<id>` — reusing the old id could let a stale
    // document keep the previous mesh.
    expect(restored!.id).toBeGreaterThan(original.id);
  });

  it('accepts a Uint8Array as well as an ArrayBuffer', () => {
    expect(recordToMesh({ name: 'a.glb', bytes: glbBytes() })).not.toBeNull();
    expect(recordToMesh({ name: 'a.glb', bytes: glbBytes().buffer })).not.toBeNull();
  });

  it('rejects malformed records instead of throwing', () => {
    for (const bad of [
      null,
      undefined,
      42,
      'nope',
      {},
      { name: 'a.glb' },
      { bytes: glbBytes() },
      { name: 123, bytes: glbBytes() },
      { name: 'a.glb', bytes: 'not-bytes' },
      { name: 'a.glb', bytes: { length: 10 } },
    ]) {
      expect(recordToMesh(bad)).toBeNull();
    }
  });

  it('re-runs the full drop-time validation on cached bytes', () => {
    // The cache is same-origin storage, not a trusted channel — every check the
    // drop surface applies must apply again on restore.
    expect(recordToMesh({ name: 'a.exe', bytes: glbBytes() })).toBeNull();       // extension whitelist
    expect(recordToMesh({ name: 'a.glb', bytes: new Uint8Array(0) })).toBeNull(); // empty
    expect(recordToMesh({ name: 'a.glb', bytes: new Uint8Array(32) })).toBeNull(); // no glTF magic
    expect(
      recordToMesh({ name: 'a.obj', bytes: new Uint8Array(MESH_MAX_BYTES + 1) }),
    ).toBeNull(); // over the 64 MB cap
  });

  it('re-sanitizes a tampered file name', () => {
    const restored = recordToMesh({ name: '../../etc/pa$$wd.glb', bytes: glbBytes() });
    expect(restored!.name).toBe('pa-wd.glb');
  });
});

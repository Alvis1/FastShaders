import { describe, it, expect } from 'vitest';
import {
  detectMeshKind,
  validateMeshBytes,
  sanitizeMeshFileName,
  MESH_MAX_BYTES,
} from './previewMesh';

const GLB_HEADER = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0]);

describe('previewMesh: detectMeshKind', () => {
  it('classifies model extensions case-insensitively', () => {
    expect(detectMeshKind('bunny.obj')).toBe('obj');
    expect(detectMeshKind('Robot.GLB')).toBe('glb');
    expect(detectMeshKind('scene.glTF')).toBe('gltf');
  });

  it('rejects non-model files and extension tricks', () => {
    expect(detectMeshKind('shader.js')).toBeNull();
    expect(detectMeshKind('archive.zip')).toBeNull();
    expect(detectMeshKind('model.glb.js')).toBeNull();
    expect(detectMeshKind('noext')).toBeNull();
    expect(detectMeshKind('')).toBeNull();
  });
});

describe('previewMesh: validateMeshBytes', () => {
  it('accepts a well-formed glb header', () => {
    expect(validateMeshBytes('glb', GLB_HEADER)).toBeNull();
  });

  it('rejects a glb without the glTF magic', () => {
    const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(validateMeshBytes('glb', bad)).toMatch(/glTF header/);
  });

  it('rejects a truncated glb shorter than its 12-byte header', () => {
    expect(validateMeshBytes('glb', GLB_HEADER.slice(0, 8))).toMatch(/glTF header/);
  });

  it('rejects empty files for every kind', () => {
    const empty = new Uint8Array(0);
    expect(validateMeshBytes('obj', empty)).toMatch(/empty/);
    expect(validateMeshBytes('glb', empty)).toMatch(/empty/);
    expect(validateMeshBytes('gltf', empty)).toMatch(/empty/);
  });

  it('enforces the size cap without allocating past it', () => {
    // Sparse-backed Uint8Array of cap+1 zero bytes — length is what matters.
    const over = new Uint8Array(MESH_MAX_BYTES + 1);
    expect(validateMeshBytes('obj', over)).toMatch(/too large/i);
  });

  it('does not magic-check obj/gltf (text formats)', () => {
    const text = new TextEncoder().encode('v 0 0 0');
    expect(validateMeshBytes('obj', text)).toBeNull();
    expect(validateMeshBytes('gltf', text)).toBeNull();
  });
});

describe('previewMesh: sanitizeMeshFileName', () => {
  it('keeps a plain name and normalizes the extension to the kind', () => {
    expect(sanitizeMeshFileName('bunny.obj', 'obj')).toBe('bunny.obj');
    expect(sanitizeMeshFileName('Robot.GLB', 'glb')).toBe('Robot.glb');
  });

  it('strips directory components (zip path traversal)', () => {
    expect(sanitizeMeshFileName('../../etc/passwd.glb', 'glb')).toBe('passwd.glb');
    expect(sanitizeMeshFileName('a/b\\c/mesh.obj', 'obj')).toBe('mesh.obj');
  });

  it('replaces unsafe characters and collapses dots', () => {
    expect(sanitizeMeshFileName('my mesh (final)!.glb', 'glb')).toBe('my-mesh-final.glb');
    expect(sanitizeMeshFileName('a..b.glb', 'glb')).toBe('a.b.glb');
  });

  it('falls back to "model" when nothing survives', () => {
    expect(sanitizeMeshFileName('???.glb', 'glb')).toBe('model.glb');
    expect(sanitizeMeshFileName('.glb', 'glb')).toBe('model.glb');
  });

  it('caps runaway name length', () => {
    const long = `${'x'.repeat(300)}.obj`;
    const out = sanitizeMeshFileName(long, 'obj');
    expect(out.length).toBeLessThanOrEqual(64 + '.obj'.length);
  });

  it('neutralizes control characters and newlines', () => {
    expect(sanitizeMeshFileName('a\nb\tc.glb', 'glb')).toBe('a-b-c.glb');
  });

  it('prefixes Windows-reserved device names', () => {
    expect(sanitizeMeshFileName('CON.glb', 'glb')).toBe('_CON.glb');
    expect(sanitizeMeshFileName('com1.obj', 'obj')).toBe('_com1.obj');
    expect(sanitizeMeshFileName('console.glb', 'glb')).toBe('console.glb');
  });
});

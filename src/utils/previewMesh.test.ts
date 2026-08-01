import { describe, it, expect } from 'vitest';
import {
  countMeshVertices,
  detectMeshKind,
  validateMeshBytes,
  sanitizeMeshFileName,
  MESH_MAX_BYTES,
  type PreviewMesh,
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

/** Assemble a PreviewMesh directly — createPreviewMesh's id counter is irrelevant here. */
const mesh = (kind: PreviewMesh['kind'], body: string | Uint8Array): PreviewMesh => ({
  name: `m.${kind}`,
  kind,
  bytes: (typeof body === 'string' ? new TextEncoder().encode(body) : body) as Uint8Array<ArrayBuffer>,
  text: typeof body === 'string' ? body : undefined,
  id: 1,
});

/** Wrap a glTF JSON string in a minimal GLB container (header + JSON chunk). */
function glb(json: string): Uint8Array<ArrayBuffer> {
  const chunk = new TextEncoder().encode(json);
  const out = new Uint8Array(20 + chunk.length);
  const view = new DataView(out.buffer);
  out.set([0x67, 0x6c, 0x54, 0x46], 0); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, chunk.length, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(chunk, 20);
  return out as Uint8Array<ArrayBuffer>;
}

const GLTF_DOC = JSON.stringify({
  accessors: [{ count: 24 }, { count: 36 }, { count: 8 }],
  meshes: [
    { primitives: [{ attributes: { POSITION: 0, NORMAL: 2 } }] },
    { primitives: [{ attributes: { POSITION: 1 } }, { attributes: { POSITION: 2 } }] },
  ],
});

describe('previewMesh: countMeshVertices', () => {
  it('counts OBJ v statements without mistaking vt / vn for them', () => {
    const obj = [
      '# a comment', 'o cube',
      'v 0 0 0', 'v 1 0 0', 'v 1 1 0',
      'vt 0 0', 'vn 0 0 1', 'vp 0.5',
      '  v 2 2 2', // leading whitespace is still a vertex line
      'f 1 2 3',
    ].join('\n');
    expect(countMeshVertices(mesh('obj', obj))).toBe(4);
  });

  it('handles CRLF line endings and a missing trailing newline', () => {
    expect(countMeshVertices(mesh('obj', 'v 0 0 0\r\nv 1 0 0\r\nv 2 0 0'))).toBe(3);
  });

  it('a vertex-free OBJ counts zero rather than failing', () => {
    expect(countMeshVertices(mesh('obj', 'o empty\n# nothing here\n'))).toBe(0);
  });

  it('sums POSITION accessors across every glTF mesh primitive', () => {
    expect(countMeshVertices(mesh('gltf', GLTF_DOC))).toBe(24 + 36 + 8);
  });

  it('reads the JSON chunk out of a GLB container', () => {
    expect(countMeshVertices(mesh('glb', glb(GLTF_DOC)))).toBe(68);
  });

  // Adversarial input: every malformed shape must return null, never throw.
  const BAD: { why: string; kind: PreviewMesh['kind']; body: string | Uint8Array }[] = [
    { why: 'truncated GLB container', kind: 'glb', body: new Uint8Array([1, 2, 3]) },
    { why: 'unparseable JSON chunk', kind: 'glb', body: glb('{ not json') },
    { why: 'GLB with no primitives', kind: 'glb', body: glb('{"meshes":[],"accessors":[]}') },
    { why: 'no POSITION attribute', kind: 'gltf', body: '{"meshes":[{"primitives":[{"attributes":{}}]}],"accessors":[]}' },
    { why: 'out-of-range accessor index', kind: 'gltf', body: '{"meshes":[{"primitives":[{"attributes":{"POSITION":9}}]},{}],"accessors":[{"count":3}]}' },
    { why: 'wrong types throughout', kind: 'gltf', body: '{"meshes":"nope","accessors":[]}' },
    { why: 'JSON null', kind: 'gltf', body: 'null' },
    { why: 'empty string', kind: 'gltf', body: '' },
  ];
  it.each(BAD)('returns null for $why', ({ kind, body }) => {
    expect(countMeshVertices(mesh(kind, body))).toBeNull();
  });

  it('rejects a GLB whose chunk length overruns the buffer', () => {
    const bad = glb(GLTF_DOC);
    new DataView(bad.buffer).setUint32(12, 0xffff, true);
    expect(countMeshVertices(mesh('glb', bad))).toBeNull();
  });

  it('declines an oversized JSON chunk instead of parsing it', () => {
    const bad = glb(GLTF_DOC);
    new DataView(bad.buffer).setUint32(12, 9 * 1024 * 1024, true);
    expect(countMeshVertices(mesh('glb', bad))).toBeNull();
  });

  it('returns null for an obj whose text was never decoded', () => {
    expect(countMeshVertices({ ...mesh('obj', 'v 0 0 0'), text: undefined })).toBeNull();
  });

  it('counts a large OBJ linearly without blowing up', () => {
    const big = 'v 0 0 0\n'.repeat(200_000) + 'vn 0 0 1\n'.repeat(50_000);
    expect(countMeshVertices(mesh('obj', big))).toBe(200_000);
  });
});

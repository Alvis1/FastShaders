import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import lv from '@/i18n/lv.json';
import {
  countMeshVertices,
  detectMeshKind,
  formatSplatCount,
  isBinaryKind,
  isGltfKind,
  isSplatKind,
  isTextKind,
  splatCountRefusal,
  splatEvalRefusal,
  MESH_EXTENSIONS,
  MESH_DROP_HINT_KEY,
  MESH_GLTF_SPLAT_KEY,
  MESH_SPLAT_EVAL_KEY,
  MESH_BAD_SPLAT_KEY,
  MESH_SPLAT_COUNT_KEY,
  MESH_PLY_SH_KEY,
  MESH_SPZ_VERSION_KEY,
  SPLAT_KINDS,
  validateMeshBytes,
  sanitizeMeshFileName,
  checkMeshBytes,
  createPreviewMesh,
  fillMeshRefusal,
  inspectGltfCompression,
  inspectParsedGltf,
  modelTooLargeRefusal,
  preReadModelGate,
  BUNDLED_DECODERS,
  GLB_READ_MAX_BYTES,
  MESH_MAX_BYTES,
  MESH_TOO_LARGE_KEY,
  MESH_COMPRESSED_KEY,
  MESH_EMPTY_KEY,
  MESH_BAD_GLB_KEY,
  MESH_UNSUPPORTED_KEY,
  type PreviewMesh,
} from './previewMesh';
// previewMesh.ts re-exports the gltfCompression leaf, but not this key (yet).
import { MESH_TOO_LARGE_LIMIT_KEY } from './gltfCompression';
import { safeJsonReviver } from './safeJson';
import { readGlbFsExtras } from './glbShaderExtras';
import { decodeDataUri } from './glbContainer';
import { meshToRecord, recordToMesh } from './previewMeshCache';
import { SPLAT_MAX_COUNT, SPZ_MAGIC } from './splatLimits';
import {
  FS_FIXTURE_MODULE_MARKER,
  TRIANGLE_POSITIONS,
  gltfPrimitiveDoc,
  makeFastShadersGlb,
  makeFastShadersGltfJson,
  makeGlb,
  type FsGlbFixture,
} from '@/test-utils';

const GLB_HEADER = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0]);

describe('previewMesh: detectMeshKind', () => {
  it('classifies model extensions case-insensitively', () => {
    expect(detectMeshKind('bunny.obj')).toBe('obj');
    expect(detectMeshKind('Robot.GLB')).toBe('glb');
    expect(detectMeshKind('scene.glTF')).toBe('gltf');
  });

  it('classifies the four Gaussian-splat extensions case-insensitively', () => {
    expect(detectMeshKind('garden.splat')).toBe('splat');
    expect(detectMeshKind('Garden.SPZ')).toBe('spz');
    expect(detectMeshKind('point_cloud.Ply')).toBe('ply');
    expect(detectMeshKind('bonsai.KSPLAT')).toBe('ksplat');
    // SuperSplat's compressed form is a .ply by extension; the sniff refuses it.
    expect(detectMeshKind('scene.compressed.ply')).toBe('ply');
  });

  it('rejects non-model files and extension tricks', () => {
    expect(detectMeshKind('shader.js')).toBeNull();
    expect(detectMeshKind('archive.zip')).toBeNull();
    expect(detectMeshKind('model.glb.js')).toBeNull();
    expect(detectMeshKind('garden.splat.js')).toBeNull();
    expect(detectMeshKind('garden.splats')).toBeNull();
    expect(detectMeshKind('noext')).toBeNull();
    expect(detectMeshKind('')).toBeNull();
  });
});

describe('previewMesh: the seven kinds and their predicates', () => {
  it('MESH_EXTENSIONS lists seven kinds, the splat kinds last', () => {
    expect([...MESH_EXTENSIONS]).toEqual(['obj', 'glb', 'gltf', 'splat', 'spz', 'ply', 'ksplat']);
    expect(MESH_EXTENSIONS.slice(3)).toEqual([...SPLAT_KINDS]);
  });

  it('every kind is exactly one of text or binary; only glb/gltf are glTF; only the four are splats', () => {
    for (const k of MESH_EXTENSIONS) {
      expect(isTextKind(k) !== isBinaryKind(k), k).toBe(true);
      expect(isGltfKind(k), k).toBe(k === 'glb' || k === 'gltf');
      expect(isSplatKind(k), k).toBe((SPLAT_KINDS as readonly string[]).includes(k));
      if (isSplatKind(k)) expect(isBinaryKind(k), k).toBe(true);
    }
    expect(MESH_EXTENSIONS.filter(isTextKind)).toEqual(['obj', 'gltf']);
    expect(MESH_EXTENSIONS.filter(isBinaryKind)).toEqual(['glb', 'splat', 'spz', 'ply', 'ksplat']);
    for (const junk of ['OBJ', 'Glb', '', null, undefined, 3, {}, 'toString']) {
      expect(isTextKind(junk) || isBinaryKind(junk) || isGltfKind(junk) || isSplatKind(junk)).toBe(false);
    }
  });

  it('the unsupported-file sentence and the drop hint name every extension, in both languages', () => {
    const UI = lv.ui as Record<string, string>;
    for (const key of [MESH_UNSUPPORTED_KEY, MESH_DROP_HINT_KEY]) {
      expect(typeof UI[key], key).toBe('string');
      for (const ext of MESH_EXTENSIONS) {
        expect(key, ext).toContain(`.${ext}`);
        expect(UI[key], ext).toContain(`.${ext}`);
      }
    }
    // The retired three-extension wordings are gone from the Latvian table too.
    expect(UI['Not a supported model file (.obj / .glb / .gltf).']).toBeUndefined();
    expect(UI['Drop a 3D model (.obj / .glb / .gltf) or a shader (.js / .zip)']).toBeUndefined();
  });

  it('the preview reads its drop hint through the constant (no inline copy left)', () => {
    const src = readFileSync(join(__dirname, '../components/Preview/ShaderPreview.tsx'), 'utf8');
    // The drop veil and the nothing-to-take notice.
    expect(src.match(/t\(MESH_DROP_HINT_KEY, language\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(src).not.toContain("'Drop a 3D model (");
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

describe('previewMesh: structured refusals', () => {
  it('pins the literal "64" in the too-large sentence to the real cap', () => {
    expect(MESH_MAX_BYTES).toBe(64 * 2 ** 20);
    expect(MESH_TOO_LARGE_KEY).toContain('max 64 MB');
  });

  it('only the LIMIT key carries {limit}, and nothing the English-only filler renders uses it', () => {
    // `fillMeshRefusal` fills {name}/{ext}/{size} and NOT {limit} — it is what
    // `validateMeshBytes` and `createPreviewMesh().error` go through, so a
    // {limit} in a key they can build would print literally. Both apply
    // MESH_MAX_BYTES, so both keep MESH_TOO_LARGE_KEY; `preReadModelGate` is the
    // only builder of the {limit} key and every refusal it makes reaches a user
    // through `meshRefusalMessage`, which fills it.
    expect(MESH_TOO_LARGE_KEY).not.toContain('{limit}');
    expect(MESH_TOO_LARGE_LIMIT_KEY).toContain('{limit}');
    expect(modelTooLargeRefusal(1).key).toBe(MESH_TOO_LARGE_KEY);
    expect(checkMeshBytes('obj', new Uint8Array(MESH_MAX_BYTES + 1))!.key).toBe(MESH_TOO_LARGE_KEY);
    expect(validateMeshBytes('obj', new Uint8Array(MESH_MAX_BYTES + 1))).not.toContain('{');
  });

  it('checkMeshBytes carries the reason, key and size', () => {
    const n = MESH_MAX_BYTES + 1;
    expect(checkMeshBytes('obj', new Uint8Array(n))).toEqual({ reason: 'too-large', key: MESH_TOO_LARGE_KEY, sizeBytes: n });
    expect(checkMeshBytes('glb', new Uint8Array(0))).toEqual({ reason: 'empty', key: MESH_EMPTY_KEY });
    expect(checkMeshBytes('glb', new Uint8Array(12))).toEqual({ reason: 'bad-glb', key: MESH_BAD_GLB_KEY });
    expect(checkMeshBytes('glb', GLB_HEADER)).toBeNull();
  });

  it('never prints one byte over the cap as equal to it', () => {
    expect(validateMeshBytes('obj', new Uint8Array(MESH_MAX_BYTES + 1))).toContain('(64.1 MB — max 64 MB)');
  });

  it('refuses an unsupported extension with its own reason', () => {
    const r = createPreviewMesh('a.exe', GLB_HEADER);
    expect('error' in r && r.refusal).toEqual({ reason: 'unsupported', key: MESH_UNSUPPORTED_KEY });
  });

  it('fillMeshRefusal inserts a name literally, even one spelling a replacement pattern', () => {
    const r = { reason: 'compressed' as const, key: MESH_COMPRESSED_KEY, name: "a$&b$'c.glb", ext: 'KTX2' as const };
    expect(fillMeshRefusal(r, r.key, 'en')).toBe(
      "“a$&b$'c.glb” uses KTX2 compression, which FastShaders cannot read yet. Re-export it from Blender (or gltf-transform) without KTX2.",
    );
  });
});

describe('previewMesh: inspectGltfCompression', () => {
  const doc = (d: unknown) => JSON.stringify(d);
  const DRACO = 'KHR_draco_mesh_compression';
  /** A surface without decoders: the refusals such a surface must give. */
  const NONE = { draco: false, meshopt: false, ktx2: false };
  const NO_NEEDS = { draco: false, meshopt: false, ktx2: false };

  const NO_DECODER_CASES: [string, unknown, string | null][] = [
    ['Draco used only', { extensionsUsed: [DRACO] }, 'Draco'],
    ['Draco required only', { extensionsRequired: [DRACO] }, 'Draco'],
    ['EXT_meshopt used only', { extensionsUsed: ['EXT_meshopt_compression'] }, null],
    ['EXT_meshopt required', { extensionsRequired: ['EXT_meshopt_compression'] }, 'meshopt'],
    ['KHR_meshopt required', { extensionsRequired: ['KHR_meshopt_compression'] }, 'meshopt'],
    ['basisu required', { extensionsRequired: ['KHR_texture_basisu'] }, 'KTX2'],
    ['Draco beats basisu', { extensionsUsed: [DRACO, 'KHR_texture_basisu'] }, 'Draco'],
  ];

  it.each(NO_DECODER_CASES)('without decoders: %s', (_why, d, refused) => {
    const r = inspectGltfCompression(doc(d), NONE);
    expect(r.refused).toBe(refused);
    // A surface with no decoders never reports a need it cannot meet.
    expect(r.needs).toEqual(NO_NEEDS);
  });

  it('without a transcoder, a basisu-USED model still reports the fallback (the Phase 1 rows)', () => {
    const used = inspectGltfCompression(doc({ extensionsUsed: ['KHR_texture_basisu'] }), NONE);
    expect(used).toEqual({ refused: null, ktx2Fallback: true, needs: NO_NEEDS });
    // A REQUIRED one is refused before the fallback question arises.
    expect(inspectGltfCompression(doc({ extensionsRequired: ['KHR_texture_basisu'] }), NONE)).toEqual({
      refused: 'KTX2',
      ktx2Fallback: false,
      needs: NO_NEEDS,
    });
  });

  it.each(NO_DECODER_CASES)('inspectParsedGltf gives the same answer on the parsed document: %s', (_why, d) => {
    expect(inspectParsedGltf(JSON.parse(doc(d), safeJsonReviver), NONE)).toEqual(inspectGltfCompression(doc(d), NONE));
    expect(inspectParsedGltf(JSON.parse(doc(d), safeJsonReviver))).toEqual(inspectGltfCompression(doc(d)));
  });

  it('defaults to the bundled decoders: Draco, meshopt and the KTX2 transcoder', () => {
    expect(BUNDLED_DECODERS).toEqual({ draco: true, meshopt: true, ktx2: true });
    expect(inspectGltfCompression(doc({ extensionsRequired: [DRACO] }))).toEqual(
      inspectGltfCompression(doc({ extensionsRequired: [DRACO] }), BUNDLED_DECODERS),
    );
  });

  it.each([
    ['Draco used only', { extensionsUsed: [DRACO] }, null, { draco: true, meshopt: false, ktx2: false }],
    ['Draco required', { extensionsUsed: [DRACO], extensionsRequired: [DRACO] }, null, { draco: true, meshopt: false, ktx2: false }],
    ['EXT_meshopt used only', { extensionsUsed: ['EXT_meshopt_compression'] }, null, { draco: false, meshopt: true, ktx2: false }],
    ['EXT_meshopt required', { extensionsRequired: ['EXT_meshopt_compression'] }, null, { draco: false, meshopt: true, ktx2: false }],
    ['KHR_meshopt required', { extensionsRequired: ['KHR_meshopt_compression'] }, null, { draco: false, meshopt: true, ktx2: false }],
    ['Draco and meshopt', { extensionsUsed: [DRACO, 'EXT_meshopt_compression'] }, null, { draco: true, meshopt: true, ktx2: false }],
    ['basisu required', { extensionsRequired: ['KHR_texture_basisu'] }, null, { draco: false, meshopt: false, ktx2: true }],
    ['basisu used only', { extensionsUsed: ['KHR_texture_basisu'] }, null, { draco: false, meshopt: false, ktx2: true }],
    ['Draco and basisu', { extensionsUsed: [DRACO, 'KHR_texture_basisu'] }, null, { draco: true, meshopt: false, ktx2: true }],
    ['nothing compressed', { extensionsUsed: ['KHR_materials_emissive_strength'] }, null, NO_NEEDS],
  ])('with the bundled decoders: %s', (_why, d, refused, needs) => {
    const r = inspectGltfCompression(doc(d));
    expect(r.refused).toBe(refused);
    expect(r.needs).toEqual(needs);
    // The transcoder decodes them, so nothing renders through a fallback image.
    expect(r.ktx2Fallback).toBe(false);
  });

  it('KTX2 required is transcoded, even beside a Draco model, and refused only without the transcoder', () => {
    const both = doc({ extensionsUsed: [DRACO], extensionsRequired: ['KHR_texture_basisu'] });
    expect(inspectGltfCompression(both)).toEqual({
      refused: null,
      ktx2Fallback: false,
      needs: { draco: true, meshopt: false, ktx2: true },
    });
    // Draco still comes first when neither can be decoded.
    expect(inspectGltfCompression(both, NONE).refused).toBe('Draco');
    expect(inspectGltfCompression(both, { draco: true, meshopt: true, ktx2: false }).refused).toBe('KTX2');
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['unparseable', '{ not json'],
    ['JSON null', 'null'],
    ['an array', '[]'],
    ['a string', '"s"'],
    ['a non-array list', `{"extensionsUsed":"${DRACO}"}`],
    ['non-string entries', '{"extensionsUsed":[42,null]}'],
    ['a prototype-smuggled list', `{"__proto__":{"extensionsUsed":["${DRACO}"]}}`],
    ['a wrong-case name', '{"extensionsUsed":["khr_draco_mesh_compression"]}'],
  ])('fails open for %s', (_why, json) => {
    const open = { refused: null, ktx2Fallback: false, needs: NO_NEEDS };
    expect(inspectGltfCompression(json as string | null)).toEqual(open);
    expect(inspectGltfCompression(json as string | null, NONE)).toEqual(open);
  });

  it('fails open on JSON over the 8 MiB parse cap', () => {
    const big = `{"extensionsUsed":["${DRACO}"]}` + ' '.repeat(8 * 1024 * 1024);
    expect(inspectGltfCompression(big)).toEqual({ refused: null, ktx2Fallback: false, needs: NO_NEEDS });
  });

  it('looks at no more than 256 entries of a list', () => {
    const junk = Array.from({ length: 256 }, (_, i) => `x${i}`);
    expect(inspectGltfCompression(doc({ extensionsUsed: [...junk, DRACO] }), NONE).refused).toBeNull();
    expect(inspectGltfCompression(doc({ extensionsUsed: [...junk.slice(1), DRACO] }), NONE).refused).toBe('Draco');
    expect(inspectGltfCompression(doc({ extensionsUsed: [...junk, DRACO] })).needs.draco).toBe(false);
    expect(inspectGltfCompression(doc({ extensionsUsed: [...junk.slice(1), DRACO] })).needs.draco).toBe(true);
  });

  it('hands out a fresh needs object per report, so one caller cannot edit another\'s', () => {
    const a = inspectGltfCompression(null);
    const b = inspectGltfCompression(null);
    expect(a.needs).not.toBe(b.needs);
  });
});

describe('previewMesh: createPreviewMesh runs the compression pre-check', () => {
  const gltfBytes = (d: unknown) => new TextEncoder().encode(JSON.stringify(d));

  it('loads a Draco GLB and records that it needs the Draco decoder', () => {
    const r = createPreviewMesh('My Robot!.glb', glb(JSON.stringify({ extensionsUsed: ['KHR_draco_mesh_compression'] })));
    expect('mesh' in r).toBe(true);
    if (!('mesh' in r)) return;
    expect(r.mesh.name).toBe('My-Robot.glb');
    expect(r.mesh.decoders).toEqual({ draco: true, meshopt: false, ktx2: false });
  });

  it('loads a .gltf that requires meshopt and records that it needs the meshopt decoder', () => {
    const r = createPreviewMesh('scene.gltf', gltfBytes({ extensionsUsed: ['EXT_meshopt_compression'], extensionsRequired: ['EXT_meshopt_compression'] }));
    expect('mesh' in r && r.mesh.decoders).toEqual({ draco: false, meshopt: true, ktx2: false });
  });

  it('loads a KTX2-required GLB and records that it needs the transcoder', () => {
    const r = createPreviewMesh('My Robot!.glb', glb(JSON.stringify({ extensionsRequired: ['KHR_texture_basisu'] })));
    expect('mesh' in r).toBe(true);
    if (!('mesh' in r)) return;
    expect(r.mesh.name).toBe('My-Robot.glb');
    expect(r.mesh.decoders).toEqual({ draco: false, meshopt: false, ktx2: true });
    // Nothing falls back: the transcoder is what renders those textures.
    expect(r.ktx2Fallback).toBe(false);
  });

  it('loads the committed quad-uastc-required.glb with mesh.decoders.ktx2', () => {
    const bytes = new Uint8Array(
      readFileSync(join(__dirname, '../engine/fixtures/ktx2/quad-uastc-required.glb')),
    );
    const r = createPreviewMesh('quad-uastc-required.glb', bytes);
    expect('mesh' in r).toBe(true);
    if (!('mesh' in r)) return;
    expect(r.mesh.decoders?.ktx2).toBe(true);
    expect(r.ktx2Fallback).toBe(false);
  });

  it('loads a basisu-USED GLB and needs the transcoder too (no fallback line)', () => {
    const r = createPreviewMesh('tex.glb', glb(JSON.stringify({ extensionsUsed: ['KHR_texture_basisu'] })));
    expect('mesh' in r && r.mesh.decoders).toEqual({ draco: false, meshopt: false, ktx2: true });
    expect('mesh' in r && r.ktx2Fallback).toBe(false);
  });

  it('loads a plain GLB with no fallback flag and no decoders key', () => {
    const r = createPreviewMesh('plain.glb', glb(GLTF_DOC));
    expect('mesh' in r && r.ktx2Fallback).toBe(false);
    // Absent, not { draco: false, meshopt: false, ktx2: false }: an uncompressed mesh looks
    // exactly as it did before decoders existed.
    expect('mesh' in r && 'decoders' in r.mesh).toBe(false);
  });

  it('parses a readable model ONCE: the reader\'s own report answers the pre-check', () => {
    const doc = gltfPrimitiveDoc({
      extensionsUsed: ['KHR_draco_mesh_compression'],
      materials: [{ name: 'A' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    });
    const bytes = makeGlb(doc, TRIANGLE_POSITIONS);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const r = createPreviewMesh('m.glb', bytes);
      if (!('mesh' in r)) throw new Error(r.error);
      expect(r.mesh.gltf).not.toBeNull();
      expect(r.mesh.decoders).toEqual({ draco: true, meshopt: false, ktx2: false });
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  it('fails open to no decoders for a GLB whose JSON cannot be read', () => {
    const r = createPreviewMesh('junk.glb', glb('{ not json'));
    expect('mesh' in r && 'decoders' in r.mesh).toBe(false);
  });

  it('never inspects an OBJ, whatever its text says', () => {
    const r = createPreviewMesh('a.obj', new TextEncoder().encode('# KHR_draco_mesh_compression\nv 0 0 0\n'));
    expect('mesh' in r).toBe(true);
    expect('mesh' in r && 'decoders' in r.mesh).toBe(false);
  });

  it('mints an id only on success, so a refusal never burns one', () => {
    const a = createPreviewMesh('a.obj', new TextEncoder().encode('v 0 0 0'));
    // No compression is refused under the bundled decoders any more, so the
    // refusal here is a bad container.
    createPreviewMesh('d.glb', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const b = createPreviewMesh('b.obj', new TextEncoder().encode('v 0 0 0'));
    if (!('mesh' in a) || !('mesh' in b)) throw new Error('expected meshes');
    expect(b.mesh.id).toBe(a.mesh.id + 1);
  });
});

describe('fillMeshRefusal: a name spelling a placeholder', () => {
  it('stays text — the old global `{ext}` pass rewrote the name too', () => {
    const r = { reason: 'compressed' as const, key: MESH_COMPRESSED_KEY, name: '{ext}.glb', ext: 'Draco' as const };
    expect(fillMeshRefusal(r, r.key, 'en')).toBe(
      '“{ext}.glb” uses Draco compression, which FastShaders cannot read yet. Re-export it from Blender (or gltf-transform) without Draco.',
    );
  });
});

describe('previewMesh: preReadModelGate (the pre-read size gate)', () => {
  const OVER_MODEL = MESH_MAX_BYTES + 1;

  it('with the build off it is exactly the model cap, for every kind', () => {
    for (const kind of ['glb', 'gltf', 'obj', null] as const) {
      expect(preReadModelGate(kind, OVER_MODEL, false)).toEqual(modelTooLargeRefusal(OVER_MODEL));
      expect(preReadModelGate(kind, MESH_MAX_BYTES, false)).toBeNull();
    }
  });

  it('with the build on, only a .glb gets the larger read cap', () => {
    expect(preReadModelGate('glb', OVER_MODEL, true)).toBeNull();
    expect(preReadModelGate('glb', GLB_READ_MAX_BYTES, true)).toBeNull();
    // The sentence names the cap that was APPLIED — a refusal at the READ cap
    // used to report through MESH_TOO_LARGE_KEY and say "max 64 MB".
    expect(preReadModelGate('glb', GLB_READ_MAX_BYTES + 1, true)).toEqual({
      reason: 'too-large',
      key: MESH_TOO_LARGE_LIMIT_KEY,
      sizeBytes: GLB_READ_MAX_BYTES + 1,
      limitBytes: GLB_READ_MAX_BYTES,
    });
    expect(preReadModelGate('gltf', OVER_MODEL, true)).toEqual(modelTooLargeRefusal(OVER_MODEL));
    expect(preReadModelGate('obj', OVER_MODEL, true)).toEqual(modelTooLargeRefusal(OVER_MODEL));
    expect(preReadModelGate(null, OVER_MODEL, true)).toEqual(modelTooLargeRefusal(OVER_MODEL));
  });

  it('only a literal true enables the build cap', () => {
    expect(preReadModelGate('glb', OVER_MODEL, 1 as unknown as boolean)).not.toBeNull();
    expect(preReadModelGate('glb', OVER_MODEL, 'yes' as unknown as boolean)).not.toBeNull();
  });

  it.each([Number.NaN, -1, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, '5' as unknown as number])(
    'refuses a size that cannot be shown to fit: %s',
    (size) => {
      expect(preReadModelGate('glb', size, true)?.reason).toBe('too-large');
    },
  );

  it('an empty file passes the gate (createPreviewMesh refuses it after the read)', () => {
    expect(preReadModelGate('glb', 0, false)).toBeNull();
  });
});

/* ── GLB Phase 7, L1: no preview copy keeps a FastShaders payload ─────────── */

describe('createPreviewMesh drops a FastShaders payload from every copy', () => {
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  const payloadFree = (b: Uint8Array) => {
    expect(readGlbFsExtras(b).state).toBe('none');
    expect(text(b)).not.toContain(FS_FIXTURE_MODULE_MARKER);
    expect(text(b)).not.toContain('"fastshaders"');
  };
  const fsGlb = (o: FsGlbFixture = {}) =>
    makeFastShadersGlb({ project: '/* FASTSHADERS_PROJECT_V1\n{"version":1}\nEND_FASTSHADERS_PROJECT */', ...o });

  it('a drop: reclaimed (compacted), same signature', () => {
    const src = fsGlb();
    const r = createPreviewMesh('m.glb', src);
    expect('mesh' in r).toBe(true);
    if (!('mesh' in r)) return;
    payloadFree(r.mesh.bytes);
    expect(r.mesh.bytes.length).toBeLessThan(src.length);
    expect(r.mesh.gltf?.signature).toEqual(['Body', 'Glass']);
  });

  it('the IndexedDB restore path is stripped too', () => {
    const mesh = recordToMesh({ name: 'm.glb', bytes: fsGlb().slice().buffer });
    expect(mesh).not.toBeNull();
    payloadFree(mesh!.bytes);
  });

  it("a buffer extension this file cannot see into: 'kept' mode ZEROES the payload in place", () => {
    const src = fsGlb({
      json: (doc) => {
        (doc.buffers as Array<Record<string, unknown>>)[0].extensions = { EXT_unknown_buffer: {} };
        doc.extensionsUsed = ['EXT_unknown_buffer'];
      },
    });
    const r = createPreviewMesh('m.glb', src);
    expect('mesh' in r).toBe(true);
    if ('mesh' in r) payloadFree(r.mesh.bytes);
  });

  it('a model the reader refuses still loses its payload (the in-place drop)', () => {
    // A node with two parents: the strict reader refuses, GLTFLoader would not.
    const src = fsGlb({
      json: (doc) => {
        const nodes = doc.nodes as Array<Record<string, unknown>>;
        nodes[0].children = [1];
      },
    });
    const r = createPreviewMesh('m.glb', src);
    expect('mesh' in r).toBe(true);
    if (!('mesh' in r)) return;
    payloadFree(r.mesh.bytes);
    expect(r.mesh.bytes.length).toBe(src.length);
  });

  it('a payload sniffed in a container that will not parse is a bad GLB (fail closed)', () => {
    const src = fsGlb();
    src[4] = 3; // GLB version 3
    const r = createPreviewMesh('m.glb', src);
    expect('error' in r && r.refusal.reason).toBe('bad-glb');
  });

  it('an embedded .gltf loses it too', () => {
    const src = new TextEncoder().encode(makeFastShadersGltfJson({ project: 'x' }));
    const r = createPreviewMesh('m.gltf', src);
    expect('mesh' in r).toBe(true);
    if (!('mesh' in r)) return;
    expect(r.mesh.text).not.toContain('"fastshaders"');
    const binOf = (json: string) => {
      const doc = JSON.parse(json, safeJsonReviver) as { buffers: Array<{ uri: string }> };
      const d = decodeDataUri(doc.buffers[0].uri, 'buffer', 1 << 20);
      if (!d.ok) throw new Error('buffer');
      return text(d.bytes);
    };
    expect(binOf(text(src))).toContain(FS_FIXTURE_MODULE_MARKER);
    expect(binOf(r.mesh.text!)).not.toContain(FS_FIXTURE_MODULE_MARKER);
  });

  it('a plain GLB (and one that only NAMES fastshaders) is the same bytes, unread', () => {
    const plain = makeFastShadersGlb({ omitExtras: true, omitSceneExtras: true, module: null });
    const r = createPreviewMesh('m.glb', plain);
    expect('mesh' in r && r.mesh.bytes).toEqual(plain);
    const named = makeFastShadersGlb({ omitExtras: true, omitSceneExtras: true, module: null, materials: ['"fastshaders"', 'B'] });
    const r2 = createPreviewMesh('m.glb', named);
    expect('mesh' in r2 && r2.mesh.bytes.length).toBe(named.length);
  });
});

/* ── Gaussian splats: the per-kind constructor ────────────────────────────── */

/** Minimal valid splat files, one per kind (splatSniff.test.ts pins each rule at its edge). */
const SPLAT_FILES = {
  splat: (): Uint8Array => new Uint8Array(32 * 3),
  // The header and the two rows it declares (14 floats each): a body shorter
  // than its rows is refused as cut short.
  ply: (): Uint8Array => {
    const head = new TextEncoder().encode([
      'ply', 'format binary_little_endian 1.0', 'element vertex 2',
      ...['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
        .map((p) => `property float ${p}`),
      'end_header', '',
    ].join('\n'));
    const file = new Uint8Array(head.length + 2 * 14 * 4);
    file.set(head);
    return file;
  },
  spz: (): Uint8Array => {
    const raw = new Uint8Array(16 + 19);
    new DataView(raw.buffer).setUint32(0, SPZ_MAGIC, true);
    return new Uint8Array(gzipSync(raw));
  },
  ksplat: (): Uint8Array => {
    const b = new Uint8Array(4096 + 1024 + 44 * 2);
    const v = new DataView(b.buffer);
    v.setUint8(1, 1);
    v.setUint32(4, 1, true);
    v.setUint32(16, 2, true);
    v.setUint32(4096, 2, true);
    v.setUint32(4096 + 4, 2, true);
    return b;
  },
} as const;

describe('previewMesh: createPreviewMesh for the splat kinds', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['splat', { count: 3, shDegree: 0, container: 'splat' }],
    ['ply', { count: 2, shDegree: 0, container: 'ply-binary-le' }],
    ['spz', { count: null, shDegree: null, container: 'spz-gzip' }],
    ['ksplat', { count: 2, shDegree: 0, container: 'ksplat' }],
  ] as const)('loads a .%s with its sniffed facts, its bytes untouched, and nothing glTF', (kind, facts) => {
    const bytes = SPLAT_FILES[kind]() as Uint8Array<ArrayBuffer>;
    const r = createPreviewMesh(`My Garden!.${kind.toUpperCase()}`, bytes);
    expect('mesh' in r).toBe(true);
    if (!('mesh' in r)) return;
    expect(r.mesh.name).toBe(`My-Garden.${kind}`);
    expect(r.mesh.kind).toBe(kind);
    expect(r.mesh.splat).toEqual(facts);
    // A splat is bytes: never decoded, never scanned for a FastShaders payload.
    expect(r.mesh.bytes).toBe(bytes);
    expect(r.mesh.text).toBeUndefined();
    for (const key of ['decoders', 'gltf', 'gltfReadRefusal'] as const) expect(key in r.mesh, key).toBe(false);
    expect(r.ktx2Fallback).toBe(false);
  });

  it('never TextDecodes a splat, of any kind (a 30 MiB .splat must not become a string)', () => {
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    for (const kind of SPLAT_KINDS) expect('mesh' in createPreviewMesh(`a.${kind}`, SPLAT_FILES[kind]())).toBe(true);
    expect(decode).not.toHaveBeenCalled();
    // The control: a text kind does decode.
    createPreviewMesh('a.obj', new TextEncoder().encode('v 0 0 0'));
    expect(decode).toHaveBeenCalled();
  });

  it('a splat whose bytes spell a FastShaders payload is not read as a glTF', () => {
    const rows = new Uint8Array(32 * 4);
    rows.set(new TextEncoder().encode('{"extras":{"fastshaders":{"module":1}},"extensionsUsed":["KHR_draco_mesh_compression"]}').subarray(0, 128));
    const r = createPreviewMesh('x.splat', rows);
    expect('mesh' in r && r.mesh.bytes).toBe(rows);
    expect('mesh' in r && 'decoders' in r.mesh).toBe(false);
  });

  it('hands every sniff refusal through, English sentence included, without burning an id', () => {
    const a = createPreviewMesh('a.splat', new Uint8Array(32));
    const bad = createPreviewMesh('b.splat', new Uint8Array(33));
    expect('error' in bad && bad.refusal).toEqual({ reason: 'bad-splat', key: MESH_BAD_SPLAT_KEY });
    expect('error' in bad && bad.error).toBe(MESH_BAD_SPLAT_KEY);
    const sh = new TextEncoder().encode(new TextDecoder().decode(SPLAT_FILES.ply()).replace('end_header', 'property float f_rest_0\nend_header'));
    const rsh = createPreviewMesh('sh.ply', sh);
    expect('error' in rsh && rsh.refusal).toEqual({ reason: 'ply-sh', key: MESH_PLY_SH_KEY });
    const v4 = new Uint8Array(16);
    new DataView(v4.buffer).setUint32(0, SPZ_MAGIC, true);
    new DataView(v4.buffer).setUint32(4, 4, true);
    const r4 = createPreviewMesh('v4.spz', v4);
    expect('error' in r4 && r4.error).toBe(MESH_SPZ_VERSION_KEY.replace('{version}', '4'));
    const b = createPreviewMesh('c.splat', new Uint8Array(32));
    if (!('mesh' in a) || !('mesh' in b)) throw new Error('expected meshes');
    expect(b.mesh.id).toBe(a.mesh.id + 1);
  });

  it('refuses an empty splat as an empty model file, before the sniff', () => {
    for (const kind of SPLAT_KINDS) {
      const r = createPreviewMesh(`e.${kind}`, new Uint8Array(0));
      expect('error' in r && r.refusal.reason, kind).toBe('empty');
    }
  });

  it('a .splat over the 64 MiB cap names its splat count (the pre-read gate says the same)', () => {
    const size = MESH_MAX_BYTES + 32;
    const r = createPreviewMesh('huge.splat', new Uint8Array(size));
    expect('error' in r && r.refusal).toEqual(splatCountRefusal(size / 32));
    expect('error' in r && r.refusal).toEqual(preReadModelGate('splat', size, false));
  });

  it('a .ply over the 64 MiB cap is too large before its header is sniffed', () => {
    const big = new Uint8Array(MESH_MAX_BYTES + 1);
    big.set(SPLAT_FILES.ply());
    expect(checkMeshBytes('ply', big)).toEqual(modelTooLargeRefusal(MESH_MAX_BYTES + 1));
  });

  it('checkMeshBytes runs the sniff for a splat kind, and validateMeshBytes renders it', () => {
    expect(checkMeshBytes('splat', new Uint8Array(64))).toBeNull();
    expect(checkMeshBytes('ksplat', new Uint8Array(100))?.reason).toBe('bad-splat');
    expect(validateMeshBytes('splat', new Uint8Array(33))).toContain('32-byte splats');
  });

  it('the facts are a fresh object per load', () => {
    const a = createPreviewMesh('a.splat', new Uint8Array(32));
    const b = createPreviewMesh('b.splat', new Uint8Array(32));
    if (!('mesh' in a) || !('mesh' in b)) throw new Error('expected meshes');
    expect(a.mesh.splat).not.toBe(b.mesh.splat);
  });

  it('the facts are derived, never persisted: the record is name + bytes, the restore re-sniffs', () => {
    const r = createPreviewMesh('garden.ksplat', SPLAT_FILES.ksplat());
    if (!('mesh' in r)) throw new Error('expected a mesh');
    const rec = meshToRecord(r.mesh);
    expect(Object.keys(rec).sort()).toEqual(['bytes', 'name']);
    const restored = recordToMesh(rec);
    expect(restored?.kind).toBe('ksplat');
    expect(restored?.splat).toEqual(r.mesh.splat);
    expect(restored?.splat).not.toBe(r.mesh.splat);
  });
});

describe('previewMesh: a glTF-wrapped splat is refused', () => {
  const SPLAT_EXT = 'KHR_gaussian_splatting';

  it.each([
    ['a .glb that uses it', 'g.glb', () => glb(JSON.stringify({ extensionsUsed: [SPLAT_EXT] }))],
    ['a .gltf that requires it', 'g.gltf', () => new TextEncoder().encode(JSON.stringify({ extensionsRequired: [SPLAT_EXT] }))],
    ['one that is Draco-compressed too', 'g.glb', () => glb(JSON.stringify({ extensionsUsed: ['KHR_draco_mesh_compression', SPLAT_EXT] }))],
  ])('%s', (_why, name, bytes) => {
    const r = createPreviewMesh(`My ${name}`, bytes());
    expect('error' in r && r.refusal).toEqual({ reason: 'gltf-splat', key: MESH_GLTF_SPLAT_KEY, name: `My-${name}` });
    expect('error' in r && r.error).toContain(`“My-${name}” stores Gaussian splats`);
  });

  it('a glTF that merely MENTIONS the name elsewhere loads', () => {
    const r = createPreviewMesh('m.glb', glb(JSON.stringify({ asset: { generator: SPLAT_EXT }, extensionsUsed: [] })));
    expect('mesh' in r).toBe(true);
  });
});

describe('previewMesh: splat refusal wording', () => {
  it('fills {count} and {maxCount} as grouped whole numbers, per language', () => {
    const r = splatCountRefusal(1_234_567);
    expect(fillMeshRefusal(r, r.key, 'en')).toBe(
      'Too many splats (1,234,567 — max 1,000,000). Reduce the scene in SuperSplat (or splat-transform) and export it again.',
    );
    const lvText = fillMeshRefusal(r, (lv.ui as Record<string, string>)[MESH_SPLAT_COUNT_KEY], 'lv');
    expect(lvText.replace(/\s/g, ' ')).toContain('(1 234 567 — maks. 1 000 000)');
  });

  it('a non-default cap fills {maxCount} with that cap', () => {
    const r = splatCountRefusal(12, 10);
    expect(fillMeshRefusal(r, r.key, 'en')).toContain('(12 — max 10)');
  });

  it('fills {version}, and never prints a count or version it was not given', () => {
    expect(fillMeshRefusal({ reason: 'spz-version', key: MESH_SPZ_VERSION_KEY, version: 4 }, MESH_SPZ_VERSION_KEY, 'en'))
      .toContain('version 4 (zstd');
    expect(fillMeshRefusal({ reason: 'spz-version', key: MESH_SPZ_VERSION_KEY }, MESH_SPZ_VERSION_KEY, 'en'))
      .toContain('version  (zstd');
    expect(fillMeshRefusal({ reason: 'splat-count', key: MESH_SPLAT_COUNT_KEY }, MESH_SPLAT_COUNT_KEY, 'en'))
      .toContain('( — max 1,000,000)');
  });

  it('a count placeholder is filled in the same single pass: a name spelling {count} stays text', () => {
    const r = { reason: 'gltf-splat' as const, key: MESH_GLTF_SPLAT_KEY, name: '{count}{maxCount}.glb', count: 5 };
    expect(fillMeshRefusal(r, r.key, 'en')).toContain('“{count}{maxCount}.glb”');
  });

  it('formatSplatCount prints nothing for a number that is not a count', () => {
    expect(formatSplatCount(SPLAT_MAX_COUNT, 'en')).toBe('1,000,000');
    expect(formatSplatCount(0, 'en')).toBe('0');
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, '5' as unknown as number]) expect(formatSplatCount(bad, 'en')).toBe('');
  });

  it('the study-session refusal is its own reason and key, a fresh object per call', () => {
    expect(splatEvalRefusal()).toEqual({ reason: 'splat-eval', key: MESH_SPLAT_EVAL_KEY });
    expect(splatEvalRefusal()).not.toBe(splatEvalRefusal());
  });

  it('the .ply SH sentence names the conversion', () => {
    expect(MESH_PLY_SH_KEY).toContain('.splat');
    expect(MESH_PLY_SH_KEY).toContain('f_rest_');
  });
});

describe('previewMesh: countMeshVertices counts splats for the splat kinds', () => {
  const splatMesh = (kind: PreviewMesh['kind'], bytes: Uint8Array): PreviewMesh => ({
    name: `m.${kind}`,
    kind,
    bytes: bytes as Uint8Array<ArrayBuffer>,
    id: 1,
  });

  it('reads the facts the constructor derived', () => {
    const r = createPreviewMesh('a.splat', new Uint8Array(32 * 5));
    expect('mesh' in r && countMeshVertices(r.mesh)).toBe(5);
    expect(countMeshVertices({ ...splatMesh('ply', new Uint8Array(0)), splat: { count: 42, shDegree: 0, container: 'ply-ascii' } })).toBe(42);
  });

  it('sniffs a mesh assembled without facts, and says null when the count is unknowable', () => {
    expect(countMeshVertices(splatMesh('ksplat', SPLAT_FILES.ksplat()))).toBe(2);
    expect(countMeshVertices(splatMesh('ply', SPLAT_FILES.ply()))).toBe(2);
    expect(countMeshVertices(splatMesh('spz', SPLAT_FILES.spz()))).toBeNull();
    expect(countMeshVertices(splatMesh('splat', new Uint8Array(33)))).toBeNull();
  });
});

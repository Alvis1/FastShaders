/**
 * The `gltfCompression.ts` leaf: the caps and the compressed-glTF pre-check,
 * split out of previewMesh.ts so the glTF reader can use them without an import
 * cycle. previewMesh.test.ts keeps covering the pre-check's rules through the
 * re-export; this file pins what the split itself promises.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as leaf from './gltfCompression';
import * as previewMesh from './previewMesh';
import type { PreviewMeshKind } from './previewMesh';
import { SPLAT_MAX_COUNT, SPLAT_ROW_BYTES } from './splatLimits';
import {
  DESKTOP_MAX_TOTAL_UNCOMPRESSED,
  MAX_TOTAL_UNCOMPRESSED,
  READ_MAX_TOTAL_UNCOMPRESSED,
} from './zipReader';

describe('gltfCompression: the caps', () => {
  it("GLB_READ_MAX_BYTES is THIS build's zip reader cap (96 MiB on the web), above the 64 MiB model gate", () => {
    // vitest runs the WEB profile, so the read cap is the 96 MiB SUM cap here.
    expect(leaf.GLB_READ_MAX_BYTES).toBe(READ_MAX_TOTAL_UNCOMPRESSED);
    expect(leaf.GLB_READ_MAX_BYTES).toBe(MAX_TOTAL_UNCOMPRESSED);
    expect(leaf.GLB_READ_MAX_BYTES).toBe(96 * 1024 * 1024);
    expect(leaf.MESH_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(leaf.GLB_READ_MAX_BYTES).toBeGreaterThan(leaf.MESH_MAX_BYTES);
  });

  it('its desktop branch is the desktop reader cap (256 MiB), written on the guarded define (source pin)', () => {
    // The leaf may import nothing, so both values are literals; the desktop one
    // is only reachable under the define, which vitest never sets — pin the
    // TEXT and evaluate each literal against zipReader's constants.
    const src = readFileSync(join(__dirname, 'gltfCompression.ts'), 'utf8');
    const m = src.match(
      /export const GLB_READ_MAX_BYTES =\s*typeof __FS_DESKTOP__ !== 'undefined' && __FS_DESKTOP__ \? ([\d* ]+) : ([\d* ]+);/,
    );
    expect(m, 'GLB_READ_MAX_BYTES must pick its literal on the guarded __FS_DESKTOP__ define').not.toBeNull();
    const evalLiteral = (t: string): number => t.split('*').map((x) => Number(x.trim())).reduce((a, b) => a * b, 1);
    expect(evalLiteral(m![1])).toBe(DESKTOP_MAX_TOTAL_UNCOMPRESSED);
    expect(evalLiteral(m![1])).toBe(256 * 1024 * 1024);
    expect(evalLiteral(m![2])).toBe(MAX_TOTAL_UNCOMPRESSED);
  });
});

describe('gltfCompression: the too-large sentence names the cap it APPLIED', () => {
  it('the two keys are one sentence — only the limit differs', () => {
    // Two keys rather than one `{limit}` sentence because previewMesh.ts's
    // `fillMeshRefusal` fills {name}/{ext}/{size} only (see the key's comment).
    // They are a drift pair: a reword of one must move the other, and lv.json
    // carries both.
    expect(leaf.MESH_TOO_LARGE_LIMIT_KEY).toBe(leaf.MESH_TOO_LARGE_KEY.replace('max 64 MB', 'max {limit} MB'));
    expect(leaf.MESH_TOO_LARGE_KEY).not.toContain('{limit}');
  });

  it('modelTooLargeRefusal keeps the historical shape for the model gate, and only then', () => {
    expect(leaf.modelTooLargeRefusal(7)).toEqual({ reason: 'too-large', key: leaf.MESH_TOO_LARGE_KEY, sizeBytes: 7 });
    expect(leaf.modelTooLargeRefusal(7, leaf.MESH_MAX_BYTES)).toEqual(leaf.modelTooLargeRefusal(7));
    expect(leaf.modelTooLargeRefusal(7, leaf.GLB_READ_MAX_BYTES)).toEqual({
      reason: 'too-large',
      key: leaf.MESH_TOO_LARGE_LIMIT_KEY,
      sizeBytes: 7,
      limitBytes: leaf.GLB_READ_MAX_BYTES,
    });
  });

  it('a size that cannot be shown to fit is refused against the cap that was picked', () => {
    // The unusable-size branch: it still names the larger cap on the build path,
    // so the sentence cannot contradict the gate that produced it.
    expect(leaf.preReadModelGate('glb', NaN, true)).toEqual(leaf.modelTooLargeRefusal(0, leaf.GLB_READ_MAX_BYTES));
    expect(leaf.preReadModelGate('obj', NaN, true)).toEqual(leaf.modelTooLargeRefusal(0));
  });
});

describe('gltfCompression: previewMesh re-exports the SAME bindings', () => {
  it.each([
    'MESH_MAX_BYTES',
    'GLB_READ_MAX_BYTES',
    'BUNDLED_DECODERS',
    'inspectGltfCompression',
    'inspectParsedGltf',
    'MESH_TOO_LARGE_KEY',
    'MESH_TOO_LARGE_LIMIT_KEY',
    'modelTooLargeRefusal',
    'preReadModelGate',
    'MESH_BAD_SPLAT_KEY',
    'MESH_SPLAT_COUNT_KEY',
    'splatCountRefusal',
    'splatSizeRefusal',
  ] as const)('%s', (name) => {
    expect(previewMesh[name]).toBe(leaf[name]);
  });
});

describe('gltfCompression: the pre-read gate refuses a .splat from its size alone', () => {
  const MAX = SPLAT_MAX_COUNT * SPLAT_ROW_BYTES;

  it('a length that is not whole 32-byte rows is bad-splat, before any read', () => {
    for (const size of [1, 31, 33, MAX - 1]) {
      expect(leaf.preReadModelGate('splat', size, false)).toEqual({ reason: 'bad-splat', key: leaf.MESH_BAD_SPLAT_KEY });
    }
  });

  it('the row cap sits exactly at SPLAT_MAX_COUNT rows (32,000,032 bytes is one over)', () => {
    expect(leaf.preReadModelGate('splat', MAX, false)).toBeNull();
    expect(leaf.preReadModelGate('splat', MAX + SPLAT_ROW_BYTES, false)).toEqual({
      reason: 'splat-count',
      key: leaf.MESH_SPLAT_COUNT_KEY,
      count: SPLAT_MAX_COUNT + 1,
    });
    expect(MAX + SPLAT_ROW_BYTES).toBe(32_000_032);
  });

  it('names the splat count, not megabytes, for a .splat over the 64 MiB model cap too', () => {
    const size = leaf.MESH_MAX_BYTES + SPLAT_ROW_BYTES;
    expect(leaf.preReadModelGate('splat', size, true)).toEqual(leaf.splatCountRefusal(size / SPLAT_ROW_BYTES));
  });

  it('an empty .splat passes the gate (createPreviewMesh refuses it after the read)', () => {
    expect(leaf.preReadModelGate('splat', 0, false)).toBeNull();
  });

  it('a size that cannot be shown to fit is still the too-large refusal', () => {
    for (const size of [Number.NaN, -32, Number.POSITIVE_INFINITY]) {
      expect(leaf.preReadModelGate('splat', size, false)?.reason).toBe('too-large');
    }
  });

  it('the other splat kinds carry their count in a header: only the byte cap applies before the read', () => {
    for (const kind of ['spz', 'ply', 'ksplat'] as const) {
      expect(leaf.preReadModelGate(kind, 33, false)).toBeNull();
      expect(leaf.preReadModelGate(kind, leaf.MESH_MAX_BYTES, true)).toBeNull();
      expect(leaf.preReadModelGate(kind, leaf.MESH_MAX_BYTES + 1, true)).toEqual(leaf.modelTooLargeRefusal(leaf.MESH_MAX_BYTES + 1));
    }
  });

  it('splatCountRefusal names a non-default cap, and only then', () => {
    expect(leaf.splatCountRefusal(7)).toEqual({ reason: 'splat-count', key: leaf.MESH_SPLAT_COUNT_KEY, count: 7 });
    expect(leaf.splatCountRefusal(7, SPLAT_MAX_COUNT)).toEqual(leaf.splatCountRefusal(7));
    expect(leaf.splatCountRefusal(7, 5)).toEqual({ reason: 'splat-count', key: leaf.MESH_SPLAT_COUNT_KEY, count: 7, limitCount: 5 });
  });

  it('every PreviewMeshKind is a kind the gate accepts (compile-time pin)', () => {
    const kinds: Parameters<typeof leaf.preReadModelGate>[0][] = previewMesh.MESH_EXTENSIONS.map((k: PreviewMeshKind) => k);
    expect(kinds).toHaveLength(7);
  });
});

describe('gltfCompression: a glTF-wrapped splat (KHR_gaussian_splatting)', () => {
  const SPLAT = 'KHR_gaussian_splatting';
  const NONE = { draco: false, meshopt: false, ktx2: false };

  it.each<[string, unknown]>([
    ['used', { extensionsUsed: [SPLAT] }],
    ['required', { extensionsRequired: [SPLAT] }],
    ['both', { extensionsUsed: [SPLAT], extensionsRequired: [SPLAT] }],
  ])('marks gltfSplat when %s', (_why, doc) => {
    expect(leaf.inspectParsedGltf(doc).gltfSplat).toBe(true);
    expect(leaf.inspectParsedGltf(doc, NONE).gltfSplat).toBe(true);
    expect(leaf.inspectGltfCompression(JSON.stringify(doc)).gltfSplat).toBe(true);
  });

  it('leaves the key ABSENT otherwise, so every other report is unchanged', () => {
    for (const doc of [{}, { extensionsUsed: ['KHR_draco_mesh_compression'] }, { extensionsUsed: [SPLAT.toUpperCase()] }, { extensionsUsed: SPLAT }]) {
      expect('gltfSplat' in leaf.inspectParsedGltf(doc)).toBe(false);
    }
    expect('gltfSplat' in leaf.notInspectedCompression()).toBe(false);
  });

  it('keeps the compression answers beside it (createPreviewMesh decides the order)', () => {
    const doc = { extensionsUsed: [SPLAT, 'KHR_draco_mesh_compression'] };
    expect(leaf.inspectParsedGltf(doc, NONE)).toEqual({
      refused: 'Draco',
      ktx2Fallback: false,
      needs: { draco: false, meshopt: false, ktx2: false },
      gltfSplat: true,
    });
    expect(leaf.inspectParsedGltf(doc).needs.draco).toBe(true);
  });

  it('stays fail-open: a document it cannot read is not marked', () => {
    expect('gltfSplat' in leaf.inspectGltfCompression(`{"extensionsUsed":["${SPLAT}"]`)).toBe(false);
    expect('gltfSplat' in leaf.inspectGltfCompression(`{"extensionsUsed":["${SPLAT}"]}` + ' '.repeat(8 * 1024 * 1024))).toBe(false);
    expect('gltfSplat' in leaf.inspectParsedGltf([{ extensionsUsed: [SPLAT] }])).toBe(false);
  });

  it('looks at no more than 256 entries of a list, like the compression names', () => {
    const junk = Array.from({ length: 256 }, (_, i) => `x${i}`);
    expect('gltfSplat' in leaf.inspectParsedGltf({ extensionsUsed: [...junk, SPLAT] })).toBe(false);
    expect(leaf.inspectParsedGltf({ extensionsUsed: [...junk.slice(1), SPLAT] }).gltfSplat).toBe(true);
  });
});

describe('gltfCompression: inspectParsedGltf is the post-parse half', () => {
  const DRACO = 'KHR_draco_mesh_compression';
  const NONE = { draco: false, meshopt: false, ktx2: false };
  const docs: unknown[] = [
    {},
    { extensionsUsed: [DRACO] },
    { extensionsRequired: [DRACO] },
    { extensionsUsed: ['EXT_meshopt_compression'] },
    { extensionsRequired: ['KHR_meshopt_compression'] },
    { extensionsRequired: ['KHR_texture_basisu'] },
    { extensionsUsed: ['KHR_texture_basisu'] },
    { extensionsUsed: [DRACO, 'KHR_texture_basisu'], extensionsRequired: ['EXT_meshopt_compression'] },
    { extensionsUsed: 'KHR_draco_mesh_compression' },
    { extensionsUsed: [42, null, DRACO.toLowerCase()] },
    { extensionsUsed: ['KHR_gaussian_splatting'] },
    { extensionsRequired: ['KHR_gaussian_splatting', DRACO] },
  ];

  it.each(docs.map((d) => [JSON.stringify(d), d]))('agrees with the text path for %s', (text, doc) => {
    expect(leaf.inspectParsedGltf(doc)).toEqual(leaf.inspectGltfCompression(text));
    expect(leaf.inspectParsedGltf(doc, NONE)).toEqual(leaf.inspectGltfCompression(text, NONE));
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'x'],
    ['a number', 7],
    ['an array', [{ extensionsUsed: [DRACO] }]],
  ])('does not inspect %s', (_why, doc) => {
    expect(leaf.inspectParsedGltf(doc, NONE)).toEqual(leaf.notInspectedCompression());
  });

  it('reads only the two lists, by plain property access (a getter elsewhere is never touched)', () => {
    const doc = {
      extensionsRequired: ['KHR_texture_basisu'],
      get materials(): never {
        throw new Error('read');
      },
    };
    expect(leaf.inspectParsedGltf(doc).needs.ktx2).toBe(true);
    expect(leaf.inspectParsedGltf(doc, NONE).refused).toBe('KTX2');
  });
});

describe('gltfCompression: stays a leaf', () => {
  it('imports only safeJson, meshDecoder TYPES and the zero-import splat caps — never previewMesh or the glTF reader', () => {
    const src = readFileSync(join(__dirname, 'gltfCompression.ts'), 'utf8');
    const specifiers = [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)].map((m) => m[1]);
    expect(specifiers).toEqual(['./safeJson', './meshDecoders', './splatLimits']);
    expect(src).toMatch(/^import type \{ DecoderNeeds, DecoderSupport \} from '\.\/meshDecoders';$/m);
    expect(src).not.toMatch(/\bimport\(/);
    // splatLimits is itself a leaf, so this adds no edge back into the reader graph.
    expect(readFileSync(join(__dirname, 'splatLimits.ts'), 'utf8')).not.toMatch(/^\s*import\b/m);
  });

  it('previewMesh no longer defines what moved (one copy of each rule)', () => {
    const src = readFileSync(join(__dirname, 'previewMesh.ts'), 'utf8');
    expect(src).not.toMatch(/export const MESH_MAX_BYTES\b/);
    expect(src).not.toMatch(/function inspectGltfCompression\b/);
    expect(src).not.toMatch(/const GLTF_JSON_PARSE_LIMIT\b/);
    expect(src).not.toMatch(/KHR_draco_mesh_compression/);
    expect(src).not.toMatch(/export const MESH_TOO_LARGE_KEY\b/);
    expect(src).not.toMatch(/function modelTooLargeRefusal\b/);
    expect(src).not.toMatch(/function preReadModelGate\b/);
    expect(src).not.toMatch(/interface MeshRefusal\b/);
  });
});

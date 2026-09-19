/**
 * The single-GLB contract leaf (engine/glbShaderContract.ts): its constants
 * pinned against the two other copies of the same numbers — the project
 * block's markers (engine/fastShadersProject.ts) and loader 0.8's `EMBED_*`
 * / `MODEL_SRC` literals (text-sliced from the served file) — plus the three
 * document helpers under hostile input, and the shared fixtures of
 * test-utils, which are built from this leaf and must read back through it.
 *
 * Pure: no store, no stubbed globals, no DOM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BEGIN_MARKER, END_MARKER } from './fastShadersProject';
import { readGlbFsExtras } from '@/utils/glbShaderExtras';
import { imageAssetFor, IMAGE_PLACEHOLDER_RE } from './imageAssets';
import { loaderAvailable, loaderText, CURRENT_LOADER } from '../shaderloaderHarness';
import { safeJsonReviver } from '@/utils/safeJson';
import { parseGlbContainer, decodeDataUri } from '@/utils/glbContainer';
import { readGltfModel } from '@/utils/gltfReader';
import { fnv1a32Hex } from '@/utils/payloadDigest';
import {
  canonicalSrc,
  fakeWebp,
  makeFastShadersGlb,
  makeFastShadersGltfJson,
  makeRealPng,
  packBinViews,
  repackBaseGlb,
  FS_FIXTURE_MODULE,
  FS_FIXTURE_MODULE_MARKER,
} from '@/test-utils';
import {
  FS_ASSET_KEY_RE,
  FS_ASSET_MIMES,
  FS_EMBED_ASSET_BYTES_MAX,
  FS_EMBED_ASSETS_MAX,
  FS_EMBED_TOTAL_BYTES_MAX,
  FS_EXTRAS_KEY,
  FS_EXTRAS_VERSION,
  FS_FNV1A_RE,
  FS_PLACEHOLDER_RE,
  FS_MODULE_MAX_BYTES,
  FS_MODULE_MIME,
  FS_PROJECT_BEGIN,
  FS_PROJECT_END,
  FS_PROJECT_MAX_BYTES,
  FS_SCENE_MARKER,
  FS_SCENES_SCAN_MAX,
  FS_SINGLE_GLB_MIME,
  IMAGE_ASSET_KEY_RE,
  MODEL_SRC,
  fsPayloadViews,
  hasFsExtras,
  readFsGlbPointers,
} from './glbShaderContract';

const doc = (extras: unknown, rest: Record<string, unknown> = {}): unknown => ({ extras, ...rest });
const views = (n: number) => ({ bufferViews: Array.from({ length: n }, () => ({ buffer: 0, byteLength: 1 })) });

describe('the constants (one leaf, three copies)', () => {
  it('the project markers equal fastShadersProject\'s', () => {
    expect(FS_PROJECT_BEGIN).toBe(BEGIN_MARKER);
    expect(FS_PROJECT_END).toBe(END_MARKER);
  });

  it('the values the plan fixes (§2a)', () => {
    expect(FS_EXTRAS_KEY).toBe('fastshaders');
    expect(FS_EXTRAS_VERSION).toBe(1);
    expect(MODEL_SRC).toBe('model');
    expect(FS_MODULE_MIME).toBe('text/javascript');
    expect(FS_SINGLE_GLB_MIME).toBe('model/gltf-binary');
    expect(FS_MODULE_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(FS_PROJECT_MAX_BYTES).toBe(32 * 1024 * 1024);
    expect(FS_EMBED_ASSETS_MAX).toBe(64);
    expect(FS_EMBED_ASSET_BYTES_MAX).toBe(16 * 1024 * 1024);
    expect(FS_EMBED_TOTAL_BYTES_MAX).toBe(64 * 1024 * 1024);
    expect([...FS_ASSET_MIMES]).toEqual(['image/png', 'image/jpeg', 'image/webp']);
    expect(FS_SCENE_MARKER).toEqual({ v: 1, shader: true });
    expect(FS_SCENES_SCAN_MAX).toBe(256);
  });

  it('IMAGE_ASSET_KEY_RE is what imageAssets mints, and a subset of FS_ASSET_KEY_RE', () => {
    const src = `data:image/webp;base64,${btoa('abc')}`;
    for (const id of ['img1', 'a"b/../x', 'ā ü €', 'x'.repeat(200), '']) {
      const a = imageAssetFor(id, { imageB64: src, width: 2, height: 2, fileName: 'a.webp' });
      expect(a, id).not.toBeNull();
      expect(a!.key, id).toMatch(IMAGE_ASSET_KEY_RE);
      expect(a!.key, id).toMatch(FS_ASSET_KEY_RE);
    }
    expect('no-hash').not.toMatch(IMAGE_ASSET_KEY_RE);
    expect('no-hash').toMatch(FS_ASSET_KEY_RE);
    expect(`${'x'.repeat(65)}-0123abcd`).not.toMatch(IMAGE_ASSET_KEY_RE);
    expect('x-0123ABCD').not.toMatch(IMAGE_ASSET_KEY_RE);
    expect(FS_FNV1A_RE.test(fnv1a32Hex('anything'))).toBe(true);
    expect(IMAGE_PLACEHOLDER_RE.source).toBe('"fs-asset:([^"]+)"');
    // The leaf holds THE placeholder regex; imageAssets re-exports the same object.
    expect(IMAGE_PLACEHOLDER_RE).toBe(FS_PLACEHOLDER_RE);
  });
});

describe.skipIf(!loaderAvailable(CURRENT_LOADER))('the loader\'s literals equal the leaf (text-sliced from the served 0.8)', () => {
  const text = loaderText(CURRENT_LOADER);
  const literal = (name: string): string | null => {
    const m = new RegExp(`^var ${name} = (.+);$`, 'm').exec(text);
    return m ? m[1] : null;
  };

  it('the P3b stash bounds and key regex', () => {
    expect(literal('EMBED_ASSETS_MAX')).toBe(String(FS_EMBED_ASSETS_MAX));
    expect(literal('EMBED_ASSET_BYTES_MAX')).toBe(String(FS_EMBED_ASSET_BYTES_MAX));
    expect(literal('EMBED_TOTAL_BYTES_MAX')).toBe(String(FS_EMBED_TOTAL_BYTES_MAX));
    expect(literal('EMBED_KEY_RE')).toBe(`/${FS_ASSET_KEY_RE.source}/`);
    // The three EMBED_MIME keys are the leaf's mimes, in order.
    const mimes = [...text.matchAll(/\["(image\/[a-z]+)", function \(b\)/g)].map((m) => m[1]);
    expect(mimes).toEqual([...FS_ASSET_MIMES]);
  });

  it('the reserved src keyword (Step 0)', () => {
    expect(literal('MODEL_SRC')).toBe(JSON.stringify(MODEL_SRC));
  });

  // The `src: model` RUN path (Phase 7 Step 5, section 13c) — every literal
  // present and equal to the leaf.
  const runPath: Array<[string, string]> = [
    ['FS_FORMAT', String(FS_EXTRAS_VERSION)],
    ['MODULE_MIME', JSON.stringify(FS_MODULE_MIME)],
    ['EMBED_MODULE_BYTES_MAX', String(FS_MODULE_MAX_BYTES)],
    ['MODEL_PLACEHOLDER_RE', `/${IMAGE_PLACEHOLDER_RE.source}/g`],
  ];
  it('the src: model run path\'s literals', () => {
    for (const [name, want] of runPath) expect(literal(name), name).toBe(want);
  });
});

describe('hasFsExtras', () => {
  it('true for a plain fastshaders object at the root or on a scene, whatever its version', () => {
    expect(hasFsExtras(doc({ fastshaders: {} }))).toBe(true);
    expect(hasFsExtras(doc({ fastshaders: { v: 2 } }))).toBe(true);
    expect(hasFsExtras({ scenes: [{}, { extras: { fastshaders: { v: 1 } } }] })).toBe(true);
  });

  it('false for anything else, never throwing', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}, doc(null), doc('x'), doc({}), doc({ fastshaders: null })]) {
      expect(hasFsExtras(bad)).toBe(false);
    }
    expect(hasFsExtras(doc({ fastshaders: [] }))).toBe(false);
    expect(hasFsExtras(doc({ fastshaders: 'v1' }))).toBe(false);
    expect(hasFsExtras({ scenes: 'x' })).toBe(false);
    expect(hasFsExtras({ scenes: [null, 3, { extras: 'x' }, { extras: { fastshaders: 1 } }] })).toBe(false);
    const hostile = {
      get extras() {
        throw new Error('hostile');
      },
    };
    expect(hasFsExtras(hostile)).toBe(false);
  });

  it(`scans at most ${FS_SCENES_SCAN_MAX} scenes`, () => {
    const scenes: unknown[] = Array.from({ length: FS_SCENES_SCAN_MAX + 1 }, () => ({}));
    scenes[FS_SCENES_SCAN_MAX] = { extras: { fastshaders: {} } };
    expect(hasFsExtras({ scenes })).toBe(false);
    scenes[FS_SCENES_SCAN_MAX - 1] = { extras: { fastshaders: {} } };
    expect(hasFsExtras({ scenes })).toBe(true);
  });
});

describe('fsPayloadViews', () => {
  it('the in-range module and project views, deduped and ascending', () => {
    const fs = { v: 1, module: { bufferView: 4 }, project: { bufferView: 2 } };
    expect(fsPayloadViews(doc({ fastshaders: fs }, views(5)))).toEqual([2, 4]);
    expect(fsPayloadViews(doc({ fastshaders: { v: 1, module: { bufferView: 2 }, project: { bufferView: 2 } } }, views(5)))).toEqual([2]);
    // Any version: a preview copy must never carry a module's bytes.
    expect(fsPayloadViews(doc({ fastshaders: { v: 2, module: { bufferView: 1 } } }, views(5)))).toEqual([1]);
  });

  it('ignores every malformed pointer and scene extras', () => {
    for (const bv of [-1, 5, 1.5, '2', NaN, Infinity, 2 ** 53, null, undefined, {}]) {
      expect(fsPayloadViews(doc({ fastshaders: { v: 1, module: { bufferView: bv } } }, views(5))), String(bv)).toEqual([]);
    }
    expect(fsPayloadViews(doc({ fastshaders: { v: 1, module: 3 } }, views(5)))).toEqual([]);
    expect(fsPayloadViews(doc({ fastshaders: { v: 1, module: { bufferView: 1 } } }))).toEqual([]);
    expect(fsPayloadViews(doc({ fastshaders: { v: 1, module: { bufferView: 1 } } }, { bufferViews: 'x' }))).toEqual([]);
    expect(fsPayloadViews({ scenes: [{ extras: { fastshaders: { module: { bufferView: 1 } } } }], ...views(5) })).toEqual([]);
    expect(fsPayloadViews(null)).toEqual([]);
  });
});

describe('readFsGlbPointers', () => {
  const counts = { images: 3, bufferViews: 6 };

  it('reads the pointers, the assets as a Map, and a well-formed fnv1a', () => {
    const p = readFsGlbPointers(
      doc({
        fastshaders: {
          v: 1,
          assets: { 'a-00000000': 0, 'b-11111111': 2 },
          module: { bufferView: 3, mimeType: 'text/javascript', fnv1a: 'deadbeef' },
          project: { bufferView: 4 },
        },
      }),
      counts,
    );
    expect(p).not.toBeNull();
    expect(p!.v).toBe(1);
    expect([...p!.assets]).toEqual([['a-00000000', 0], ['b-11111111', 2]]);
    expect(p!.module).toEqual({ bufferView: 3, fnv1a: 'deadbeef' });
    expect(p!.project).toEqual({ bufferView: 4 });
  });

  it('null unless the root has a plain fastshaders object whose v is the number 1', () => {
    for (const bad of [null, 5, [], {}, doc(null), doc({ fastshaders: [] }), doc({ fastshaders: { v: '1' } }), doc({ fastshaders: { v: 2 } }), doc({ fastshaders: {} })]) {
      expect(readFsGlbPointers(bad, counts)).toBeNull();
    }
    // A scene marker alone is not a root.
    expect(readFsGlbPointers({ scenes: [{ extras: { fastshaders: { v: 1 } } }] }, counts)).toBeNull();
  });

  it('drops every malformed entry and keeps the rest', () => {
    const p = readFsGlbPointers(
      doc({
        fastshaders: {
          v: 1,
          assets: { ok: 1, 'bad key!': 0, neg: -1, big: 3, frac: 1.5, str: '1', ['x'.repeat(81)]: 0 },
          module: { bufferView: 3, mimeType: 'application/javascript' },
          project: { bufferView: '4' },
        },
      }),
      counts,
    )!;
    expect([...p.assets]).toEqual([['ok', 1]]);
    expect(p.module).toBeNull();
    expect(p.project).toBeNull();
    const q = readFsGlbPointers(
      doc({ fastshaders: { v: 1, assets: [0], module: { bufferView: 6, mimeType: 'text/javascript' }, project: 4 } }),
      counts,
    )!;
    expect(q.assets.size).toBe(0);
    expect(q.module).toBeNull();
    expect(q.project).toBeNull();
    const r = readFsGlbPointers(doc({ fastshaders: { v: 1, module: { bufferView: 0, mimeType: 'text/javascript', fnv1a: 'XYZ' } } }), counts)!;
    expect(r.module).toEqual({ bufferView: 0, fnv1a: null });
    expect(r.assets.size).toBe(0);
  });

  it(`considers at most ${FS_EMBED_ASSETS_MAX} asset keys, in key order`, () => {
    const assets: Record<string, number> = {};
    for (let i = 0; i < FS_EMBED_ASSETS_MAX + 6; i++) assets[`k${i}`] = 0;
    const p = readFsGlbPointers(doc({ fastshaders: { v: 1, assets } }), counts)!;
    expect(p.assets.size).toBe(FS_EMBED_ASSETS_MAX);
    expect(p.assets.has(`k${FS_EMBED_ASSETS_MAX}`)).toBe(false);
  });

  it('an own __proto__ key lands in the Map, never on a prototype; a throwing getter is null', () => {
    const assets = {};
    Object.defineProperty(assets, '__proto__', { value: 1, enumerable: true, configurable: true, writable: true });
    const p = readFsGlbPointers(doc({ fastshaders: { v: 1, assets } }), counts)!;
    expect(p.assets.get('__proto__')).toBe(1);
    expect(Object.getPrototypeOf(p.assets)).toBe(Map.prototype);
    const hostile = {
      fastshaders: {
        v: 1,
        get assets() {
          throw new Error('hostile');
        },
      },
    };
    expect(readFsGlbPointers(doc(hostile), counts)).toBeNull();
  });
});

describe('the shared fixtures read back through the leaf', () => {
  const parse = (bytes: Uint8Array) => {
    const c = parseGlbContainer(bytes);
    if (!c.ok) throw new Error(c.error);
    return { json: JSON.parse(c.chunks.json, safeJsonReviver) as Record<string, unknown>, bin: c.chunks.bin! };
  };
  const slice = (json: Record<string, unknown>, bin: Uint8Array, view: number) => {
    const v = (json.bufferViews as Array<{ byteOffset?: number; byteLength: number }>)[view];
    return bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
  };
  const text = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(b);

  it('packBinViews: 4-aligned offsets, zero padding, exact lengths', () => {
    const { bin, views: vs } = packBinViews([new Uint8Array([1, 2, 3]), new Uint8Array([4]), new Uint8Array(0)]);
    expect(vs).toEqual([{ byteOffset: 0, byteLength: 3 }, { byteOffset: 4, byteLength: 1 }, { byteOffset: 8, byteLength: 0 }]);
    expect([...bin]).toEqual([1, 2, 3, 0, 4, 0, 0, 0]);
  });

  it('makeFastShadersGlb: the default file is a format-1 GLB with the module on the BIN and the scene marker', () => {
    const { json, bin } = parse(makeFastShadersGlb());
    expect(hasFsExtras(json)).toBe(true);
    const p = readFsGlbPointers(json, { images: 0, bufferViews: (json.bufferViews as unknown[]).length })!;
    expect(p.assets.size).toBe(0);
    expect(p.project).toBeNull();
    expect(p.module).toEqual({ bufferView: 1, fnv1a: fnv1a32Hex(FS_FIXTURE_MODULE) });
    expect(text(slice(json, bin, 1))).toBe(FS_FIXTURE_MODULE);
    expect(FS_FIXTURE_MODULE).toContain(FS_FIXTURE_MODULE_MARKER);
    expect(fsPayloadViews(json)).toEqual([1]);
    expect((json.scenes as Array<{ extras: unknown }>)[0].extras).toEqual({ fastshaders: { v: 1, shader: true } });
    expect((json.extras as Record<string, Record<string, unknown>>).fastshaders.assets).toEqual({});
    // The scene marker carries no pointer.
    expect(JSON.stringify((json.scenes as Array<{ extras: unknown }>)[0].extras)).not.toContain('bufferView');
  });

  it('makeFastShadersGlb: assets, a project view, a texture from an asset, and the readers\' own model gate', () => {
    const png = makeRealPng(2, 2, [1, 2, 3, 255]);
    const webp = fakeWebp(4, 4, true);
    const project = `${FS_PROJECT_BEGIN}\n{"version":1}\n${FS_PROJECT_END}`;
    const bytes = makeFastShadersGlb({
      module: 'export default () => null; // "fs-asset:p-00000000"',
      project,
      assets: { 'p-00000000': { mime: 'image/png', bytes: png }, 'w-00000001': { mime: 'image/webp', bytes: webp } },
      textureFromAsset: 'w-00000001',
    });
    const { json, bin } = parse(bytes);
    const p = readFsGlbPointers(json, { images: 2, bufferViews: (json.bufferViews as unknown[]).length })!;
    expect([...p.assets]).toEqual([['p-00000000', 0], ['w-00000001', 1]]);
    expect(p.module!.bufferView).toBe(3);
    expect(p.project).toEqual({ bufferView: 4 });
    expect(fsPayloadViews(json)).toEqual([3, 4]);
    expect([...slice(json, bin, 1)]).toEqual([...png]);
    expect([...slice(json, bin, 2)]).toEqual([...webp]);
    expect(text(slice(json, bin, 4))).toBe(project);
    expect(canonicalSrc('image/png', png)).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
    expect((json.textures as Array<{ source: number }>)[0].source).toBe(1);
    expect(webp.length).toBeGreaterThanOrEqual(64);
    // The Phase 5 reader accepts the fixture as a model: signature = the two names.
    const r = readGltfModel(bytes, 'glb');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model.signature.materials).toEqual(['Body', 'Glass']);
  });

  it('makeFastShadersGlb: the malformed-row overrides and the off-BIN module buffers', () => {
    const { json: j1 } = parse(makeFastShadersGlb({ moduleEntry: { bufferView: 'x' }, projectEntry: 7, assetsEntry: 'junk' }));
    const fs1 = (j1.extras as Record<string, Record<string, unknown>>).fastshaders;
    expect(fs1.module).toEqual({ bufferView: 'x' });
    expect(fs1.project).toBe(7);
    expect(fs1.assets).toBe('junk');
    const { json: j2 } = parse(makeFastShadersGlb({ omitAssets: true, fnv1a: null, moduleView: { byteStride: 4 } }));
    const fs2 = (j2.extras as Record<string, Record<string, unknown>>).fastshaders;
    expect(Object.keys(fs2)).toEqual(['v', 'module']);
    expect(fs2.module).toEqual({ bufferView: 1, mimeType: FS_MODULE_MIME });
    expect((j2.bufferViews as Array<Record<string, unknown>>)[1].byteStride).toBe(4);
    for (const moduleBuffer of ['data-uri', 'external'] as const) {
      const { json } = parse(makeFastShadersGlb({ moduleBuffer, project: 'p' }));
      const buffers = json.buffers as Array<Record<string, unknown>>;
      const bvs = json.bufferViews as Array<Record<string, unknown>>;
      expect(buffers).toHaveLength(2);
      expect(bvs[bvs.length - 1].buffer).toBe(1);
      const fs = (json.extras as Record<string, Record<string, { bufferView: number }>>).fastshaders;
      expect(fs.module.bufferView).toBe(bvs.length - 1);
      expect(fs.project.bufferView).toBe(1);
      if (moduleBuffer === 'external') expect(buffers[1].uri).toBe('https://blocked.test/module.bin');
      else expect(String(buffers[1].uri)).toMatch(/^data:application\/octet-stream;base64,/);
    }
    const { json: j3 } = parse(makeFastShadersGlb({ omitExtras: true, omitSceneExtras: true, json: (d) => { d.asset = { version: '2.0', generator: 'x' }; } }));
    expect(hasFsExtras(j3)).toBe(false);
    expect((j3.asset as { generator: string }).generator).toBe('x');
  });

  it('makeFastShadersGltfJson: the same document with the BIN as a data: buffer', () => {
    const json = JSON.parse(makeFastShadersGltfJson({ project: 'p' }), safeJsonReviver) as Record<string, unknown>;
    const uri = (json.buffers as Array<{ uri: string }>)[0].uri;
    const d = decodeDataUri(uri, 'buffer', 1 << 20);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(text(slice(json, d.bytes, 1))).toBe(FS_FIXTURE_MODULE);
    expect(text(slice(json, d.bytes, 2))).toBe('p');
    expect(readFsGlbPointers(json, { images: 0, bufferViews: 3 })!.project).toEqual({ bufferView: 2 });
  });

  it('repackBaseGlb: a plain model the reader accepts, with optional textures and a foreign buffer extension', () => {
    const plain = readGltfModel(repackBaseGlb({ materials: ['A', 'B', 'C'] }), 'glb');
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.model.signature.materials).toEqual(['A', 'B', 'C']);
      expect(plain.model.textures).toHaveLength(0);
      expect(hasFsExtras(plain.model.source.doc)).toBe(false);
    }
    const textured = readGltfModel(repackBaseGlb({ materials: ['A', 'B'], textured: true }), 'glb');
    expect(textured.ok).toBe(true);
    if (textured.ok) {
      expect(textured.model.textures).toHaveLength(2);
      expect(textured.model.images).toHaveLength(2);
    }
    const gltf = readGltfModel(repackBaseGlb({ materials: ['A'], kind: 'gltf' }), 'gltf');
    expect(gltf.ok).toBe(true);
    const ext = readGltfModel(repackBaseGlb({ materials: ['A'], extraBufferExt: 'EXT_something' }), 'glb');
    expect(ext.ok).toBe(true);
    if (ext.ok) expect(ext.model.extensionsUsed).toContain('EXT_something');
  });
});

/*
 * The one module-view rule the editor reader does NOT mirror. §2a lists the
 * refusals as parity, and both headers used to claim the default export among
 * them — but `readFsExtrasUnsafe` never inspects the module's CONTENT, and it
 * cannot: the loader's check is `typeof d` AFTER the import, which no text
 * scan can stand in for (`export { x as default }` would be false-refused).
 * So the divergence is real, and each header has to NAME it rather than
 * promise a refusal that never happens.
 */
describe('the default-export refusal is loader-only', () => {
  const HEADERS: Array<readonly [string, string]> = [
    ['engine/glbShaderContract.ts', readFileSync(new URL('./glbShaderContract.ts', import.meta.url), 'utf8')],
    ['utils/glbShaderExtras.ts', readFileSync(new URL('../utils/glbShaderExtras.ts', import.meta.url), 'utf8')],
  ];

  it('the reader reads a module with no default export as ok', () => {
    const r = readGlbFsExtras(makeFastShadersGlb({ module: 'const x = 1;\n' }));
    expect(r.state).toBe('ok');
    if (r.state === 'ok') expect(r.shader.moduleText).toBe('const x = 1;\n');
  });

  it.skipIf(!loaderAvailable(CURRENT_LOADER))('while the loader refuses the same module (so the divergence is real)', () => {
    const text = loaderText(CURRENT_LOADER);
    expect(text).toContain('M_NO_DEFAULT');
    expect(text).toMatch(/typeof d !== "function"[\s\S]{0,120}M_NO_DEFAULT/);
  });

  it.each(HEADERS)('%s states it as the loader\'s, never inside the parity list', (label, src) => {
    const header = src.slice(0, src.indexOf('*/'));
    expect(header, `${label}: the divergence is unstated`).toContain('default export');
    expect(header, `${label}: it must be named as loader-only`).toContain('loader-only');
    expect(header, `${label}: name the loader's own refusal`).toContain('M_NO_DEFAULT');
    // The retired claim, verbatim.
    expect(src, label).not.toContain('it must carry a default export. The loader refuses each of');
  });
});

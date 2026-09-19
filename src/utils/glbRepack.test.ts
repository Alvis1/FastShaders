/**
 * The single-GLB repacker (utils/glbRepack.ts), over hand-built bases and no
 * DOM: the round trip through the trusted-side reader, the two WebP modes,
 * the byte layout, the extras schema, measure == write, determinism, the
 * export → restore → export cycle, the `.gltf` merge, the caps and the
 * refusals — plus the cross-read through the editor's own reader
 * (glbShaderExtras + extractProjectState + resolveProjectImageRefs).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GLTF_WRITABLE_SLOTS,
  measureGlbRepack,
  prepareRepackBase,
  repackGlb,
  safeImageName,
  samplerFor,
  truncateDeadTail,
  type GlbSamplerSpec,
  type RepackFallback,
  type RepackInput,
  type RepackPayload,
  type RepackSlot,
} from './glbRepack';
import { readGltfModel, type GltfModelReport } from './gltfReader';
import { planTextureStrip, stripGltfTextures } from './gltfStrip';
import {
  GLB_JSON_MAX_BYTES,
  PLACEHOLDER_PNG_DATA_URI,
  encodeDataUri,
  parseGlbContainer,
} from './glbContainer';
import { safeJsonReviver } from './safeJson';
import { readGlbFsExtras, inlineFsAssets } from './glbShaderExtras';
import {
  FS_EMBED_ASSET_BYTES_MAX,
  FS_EMBED_ASSETS_MAX,
  FS_MODULE_MAX_BYTES,
  FS_PROJECT_BEGIN,
  FS_PROJECT_END,
  FS_PROJECT_MAX_BYTES,
  readFsGlbPointers,
} from '@/engine/glbShaderContract';
import { embedProjectState, extractProjectState, type FastShadersProject } from '@/engine/fastShadersProject';
import { referenceImagesInSet, resolveProjectImageRefs } from '@/engine/projectImageRefs';
import { fnv1a32Hex } from './payloadDigest';
import {
  TRIANGLE_POSITIONS,
  canonicalSrc,
  fakeWebp,
  gltfPrimitiveDoc,
  jpegHeaderBytes,
  makeGlb,
  makeNode,
  makeRealPng,
  packBinViews,
  repackBaseGlb,
} from '@/test-utils';
import type { AppNode } from '@/types';

/* ── fixtures ────────────────────────────────────────────────────────────── */

type Doc = Record<string, unknown>;

function read(bytes: Uint8Array, kind: 'glb' | 'gltf' = 'glb'): GltfModelReport {
  const r = readGltfModel(bytes, kind);
  if (!r.ok) throw new Error('reader refused: ' + JSON.stringify(r.refusal));
  return r.model;
}

function prepared(bytes: Uint8Array, index: readonly number[], kind: 'glb' | 'gltf' = 'glb'): GltfModelReport {
  const r = prepareRepackBase(read(bytes, kind), index);
  if (!r.ok) throw new Error('prepare refused: ' + JSON.stringify(r.refusal));
  return r.model;
}

function docOf(bytes: Uint8Array): Doc {
  const c = parseGlbContainer(bytes);
  if (!c.ok) throw new Error('not a glb');
  return JSON.parse(c.chunks.json, safeJsonReviver) as Doc;
}

function binOf(bytes: Uint8Array): Uint8Array {
  const c = parseGlbContainer(bytes);
  if (!c.ok || !c.chunks.bin) throw new Error('no bin');
  return c.chunks.bin;
}

function viewBytes(bytes: Uint8Array, view: number): Uint8Array {
  const v = (docOf(bytes).bufferViews as Doc[])[view];
  const off = (v.byteOffset as number | undefined) ?? 0;
  return binOf(bytes).subarray(off, off + (v.byteLength as number));
}

const PNG_A = makeRealPng(2, 2, [250, 10, 10, 255]);
const PNG_B = makeRealPng(3, 1, [10, 250, 10, 255]);
const JPEG_C = jpegHeaderBytes(4, 4);
const WEBP_D = fakeWebp(8, 8, false);
const WEBP_E = fakeWebp(16, 16, true);
const FB_D = makeRealPng(8, 8, [1, 2, 3, 255]);
const FB_E = makeRealPng(16, 16, [4, 5, 6, 255]);

const SRC = {
  A: canonicalSrc('image/png', PNG_A),
  B: canonicalSrc('image/png', PNG_B),
  C: canonicalSrc('image/jpeg', JPEG_C),
  D: canonicalSrc('image/webp', WEBP_D),
  E: canonicalSrc('image/webp', WEBP_E),
};

const PAYLOADS = new Map<string, RepackPayload>([
  [SRC.A, { mime: 'image/png', bytes: PNG_A, lossless: true }],
  [SRC.B, { mime: 'image/png', bytes: PNG_B, lossless: true }],
  [SRC.C, { mime: 'image/jpeg', bytes: JPEG_C, lossless: false }],
  [SRC.D, { mime: 'image/webp', bytes: WEBP_D, lossless: false }],
  [SRC.E, { mime: 'image/webp', bytes: WEBP_E, lossless: true }],
]);
const FALLBACKS = new Map<string, RepackFallback | null>([
  [SRC.D, { mime: 'image/png', bytes: FB_D }],
  [SRC.E, { mime: 'image/png', bytes: FB_E }],
]);

const LINEAR_REPEAT: GlbSamplerSpec = samplerFor({ colorSpace: 'color', nearest: false, repeat: true });
const DATA_CLAMP: GlbSamplerSpec = samplerFor({ colorSpace: 'data', nearest: true, repeat: false });

const KEY = { A: 'imgA-0000000a', B: 'imgB-0000000b', C: 'imgC-0000000c', D: 'imgD-0000000d', E: 'imgE-0000000e' };

const MODULE =
  "import { texture, uv } from 'three/tsl';\n" +
  `const a = "fs-asset:${KEY.A}";\nconst d = "fs-asset:${KEY.D}";\n` +
  'export default function () {\n  return { colorNode: texture(a, uv()).rgb };\n}\n';

function projectText(nodes: AppNode[] = []): string {
  const p: FastShadersProject = {
    version: 1,
    shaderName: 'Golden',
    graph: { nodes, edges: [] },
    preview: {},
    ui: {},
  };
  return embedProjectState('', p).trim();
}

function slot(material: number, s: RepackSlot['slot'], src: string, extra: Partial<RepackSlot> = {}): RepackSlot {
  return { material, slot: s, src, texCoord: 0, transform: null, sampler: LINEAR_REPEAT, name: 'tex.png', ...extra };
}

/** Three materials, each with its own texture; 0 and 1 are the index sections. */
const baseBytes = () => repackBaseGlb({ materials: ['Body', 'Glass', 'Trim'], textured: true });

function input(base: GltfModelReport, over: Partial<RepackInput> = {}): RepackInput {
  return {
    base,
    indexMaterials: [0, 1],
    slots: [
      slot(0, 'baseColor', SRC.D),
      slot(0, 'normal', SRC.A, { sampler: DATA_CLAMP, texCoord: 1 }),
      slot(1, 'metallicRoughness', SRC.C, { transform: { offset: [0.5, 0], rotation: Math.PI / 2, scale: [2, 2] } }),
      slot(1, 'emissive', SRC.D),
    ],
    payloads: PAYLOADS,
    fallbacks: FALLBACKS,
    moduleText: MODULE,
    moduleAssets: [
      { key: KEY.A, src: SRC.A },
      { key: KEY.D, src: SRC.D },
      { key: KEY.C, src: SRC.C },
      { key: KEY.B, src: SRC.B, name: 'only-module.png' },
    ],
    projectText: projectText(),
    webpMode: 'fallback',
    generator: 'FastShaders 0.3.33',
    ...over,
  };
}

function ok(i: RepackInput) {
  const r = repackGlb(i);
  if (!r.ok) throw new Error('repack refused: ' + JSON.stringify(r.refusal));
  return r;
}

function refusal(i: RepackInput) {
  const r = repackGlb(i);
  if (r.ok) throw new Error('expected a refusal');
  return r.refusal;
}

/* ── the round trip ──────────────────────────────────────────────────────── */

describe('round trip through the trusted-side reader', () => {
  const base = prepared(baseBytes(), [0, 1]);
  const { bytes, report } = ok(input(base));
  const again = read(bytes);

  it('re-reads with the same signature, every slot on its texture, every payload byte-equal', () => {
    expect(again.signature).toEqual(base.signature);
    const slotOf = (m: number, s: string) => again.materials[m].slots.find((x) => x.slot === s)!;
    for (const [m, s, src] of [
      [0, 'baseColor', SRC.D],
      [0, 'normal', SRC.A],
      [1, 'metallicRoughness', SRC.C],
      [1, 'emissive', SRC.D],
    ] as const) {
      const ref = slotOf(m, s);
      expect(ref, `${m}:${s}`).toBeDefined();
      const tex = again.textures[ref.texture];
      expect(tex.extract.status).toBe('ok');
      const img = again.images[tex.extract.image as number];
      expect(img.bytes).toEqual(PAYLOADS.get(src)!.bytes);
      // The canonical-src identity (imageAssets builds the same string).
      expect(encodeDataUri(img.mime!, img.bytes!)).toBe(src);
    }
    expect(slotOf(0, 'normal').textureInfo.texCoord).toBe(1);
    expect(slotOf(1, 'metallicRoughness').textureInfo.extensions?.KHR_texture_transform).toEqual({
      offset: [0.5, 0],
      rotation: Math.PI / 2,
      scale: [2, 2],
    });
    expect(report.slotsWritten).toBe(4);
  });

  it('a webp texture carries its PNG fallback as core source; the fallback is never an asset', () => {
    const doc = docOf(bytes);
    const tex = (doc.textures as Doc[])[again.materials[0].slots.find((s) => s.slot === 'baseColor')!.texture];
    const webp = (tex.extensions as Doc).EXT_texture_webp as Doc;
    expect(again.images[webp.source as number].mime).toBe('image/webp');
    expect(again.images[tex.source as number].mime).toBe('image/png');
    expect(again.images[tex.source as number].bytes).toEqual(FB_D);
    const assets = ((doc.extras as Doc).fastshaders as Doc).assets as Record<string, number>;
    expect(Object.values(assets)).not.toContain(tex.source);
    expect(doc.extensionsUsed).toContain('EXT_texture_webp');
    expect(doc.extensionsUsed).toContain('KHR_texture_transform');
    expect((doc.extensionsRequired as string[] | undefined) ?? []).not.toContain('EXT_texture_webp');
  });

  it('the same payload used by two slots is ONE image and ONE texture (same sampler)', () => {
    const t0 = again.materials[0].slots.find((s) => s.slot === 'baseColor')!.texture;
    const t1 = again.materials[1].slots.find((s) => s.slot === 'emissive')!.texture;
    expect(t1).toBe(t0);
    const webpImages = again.images.filter((i) => i.mime === 'image/webp');
    expect(webpImages).toHaveLength(1);
  });

  it('a PNG/JPEG payload texture has no extension', () => {
    const doc = docOf(bytes);
    const tex = (doc.textures as Doc[])[again.materials[1].slots.find((s) => s.slot === 'metallicRoughness')!.texture];
    expect(tex.extensions).toBeUndefined();
    expect(again.images[tex.source as number].mime).toBe('image/jpeg');
  });

  it('asset.generator, image names ASCII, no name when empty', () => {
    const doc = docOf(bytes);
    expect((doc.asset as Doc).generator).toBe('FastShaders 0.3.33');
    const names = (doc.images as Doc[]).map((i) => i.name).filter((n) => n !== undefined);
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9._ -]{1,48}$/);
    expect(names).toContain('only-module.png');
  });
});

describe('the WebP modes', () => {
  const base = prepared(baseBytes(), [0, 1]);

  it("'required': no core source, the extension required", () => {
    const { bytes, report } = ok(input(base, { webpMode: 'required' }));
    const doc = docOf(bytes);
    const again = read(bytes);
    const tex = (doc.textures as Doc[])[again.materials[0].slots.find((s) => s.slot === 'baseColor')!.texture];
    expect(tex.source).toBeUndefined();
    expect(doc.extensionsRequired).toContain('EXT_texture_webp');
    expect(report.size.webpRequired).toBe(true);
    expect(report.size.fallbackCount).toBe(0);
    expect(again.images.filter((i) => i.mime === 'image/png' && i.bytes && i.bytes.length === FB_D.length)).toHaveLength(0);
  });

  it("a null fallback in 'fallback' mode forces required and counts fallbackMissing", () => {
    const { bytes, report } = ok(input(base, { fallbacks: new Map([[SRC.D, null]]) }));
    expect(report.size.fallbackMissing).toBe(1);
    expect(report.size.webpRequired).toBe(true);
    expect(docOf(bytes).extensionsRequired).toContain('EXT_texture_webp');
  });

  it('PNG/JPEG-only slots use no WebP extension at all', () => {
    const { bytes } = ok(
      input(base, {
        slots: [slot(0, 'baseColor', SRC.A), slot(1, 'normal', SRC.C)],
        moduleAssets: [
          { key: KEY.A, src: SRC.A },
          { key: KEY.C, src: SRC.C },
        ],
      }),
    );
    const doc = docOf(bytes);
    expect(doc.extensionsUsed ?? []).not.toContain('EXT_texture_webp');
    expect(doc.extensionsRequired).toBeUndefined();
  });
});

/* ── layout ──────────────────────────────────────────────────────────────── */

describe('byte layout', () => {
  const baseRaw = baseBytes();
  const base = prepared(baseRaw, [0, 1]);
  const { bytes } = ok(input(base));
  const doc = docOf(bytes);

  it('4-aligned views, padded chunks, buffers[0].byteLength = the unpadded end', () => {
    const dv = new DataView(bytes.buffer);
    const jsonLen = dv.getUint32(12, true);
    expect(jsonLen % 4).toBe(0);
    const binLen = dv.getUint32(20 + jsonLen, true);
    expect(binLen % 4).toBe(0);
    const json = bytes.subarray(20, 20 + jsonLen);
    const text = JSON.stringify(doc);
    for (let i = new TextEncoder().encode(text).length; i < jsonLen; i++) expect(json[i]).toBe(0x20);
    const views = doc.bufferViews as Doc[];
    const baseViews = (base.source.doc.bufferViews as unknown[]).length;
    let end = 0;
    for (const v of views.slice(baseViews)) {
      expect((v.byteOffset as number) % 4).toBe(0);
      expect(Object.keys(v).sort()).toEqual(['buffer', 'byteLength', 'byteOffset']);
      end = Math.max(end, (v.byteOffset as number) + (v.byteLength as number));
    }
    expect((doc.buffers as Doc[])[0].byteLength).toBe(end);
    const bin = binOf(bytes);
    for (let i = end; i < bin.length; i++) expect(bin[i]).toBe(0);
  });

  it('the base BIN is kept verbatim, factors unchanged, a non-index material keeps its texture', () => {
    expect(binOf(bytes).subarray(0, base.source.bin!.length)).toEqual(base.source.bin);
    const baseDoc = base.source.doc;
    const mats = doc.materials as Doc[];
    for (let i = 0; i < mats.length; i++) {
      const pb = ((baseDoc.materials as Doc[])[i].pbrMetallicRoughness ?? {}) as Doc;
      const pa = (mats[i].pbrMetallicRoughness ?? {}) as Doc;
      expect(pa.baseColorFactor).toEqual(pb.baseColorFactor);
      expect(pa.metallicFactor).toEqual(pb.metallicFactor);
    }
    // Trim (material 2) was not an index section: its original texture survives.
    const trim = read(bytes).materials[2];
    const ref = trim.slots.find((s) => s.slot === 'baseColor')!;
    const img = read(bytes).images[read(bytes).textures[ref.texture].extract.image as number];
    expect(sniffName(img.bytes!)).toBe('png');
  });

  it('appends one sampler per distinct spec, and reuses an identical plain one the base already has', () => {
    const samplers = doc.samplers as Doc[];
    expect(samplers).toEqual([LINEAR_REPEAT, DATA_CLAMP]);
    const d = docOf(baseRaw);
    d.samplers = [{ ...DATA_CLAMP }, { ...LINEAR_REPEAT, name: 'not plain' }];
    const withSamplers = prepared(makeGlb(d, binOf(baseRaw)), [0, 1]);
    const r = ok(input(withSamplers));
    expect(docOf(r.bytes).samplers).toEqual([DATA_CLAMP, { ...LINEAR_REPEAT, name: 'not plain' }, LINEAR_REPEAT]);
    expect(r.report.samplersAdded).toBe(1);
  });
});

function sniffName(b: Uint8Array): string {
  return b[0] === 0x89 ? 'png' : b[0] === 0xff ? 'jpeg' : b[0] === 0x52 ? 'webp' : '?';
}

describe('extras', () => {
  const base = prepared(baseBytes(), [0, 1]);
  const i = input(base);
  const { bytes } = ok(i);
  const doc = docOf(bytes);
  const fs = (doc.extras as Doc).fastshaders as Doc;

  it('root: v, assets (sorted), module {bufferView, mimeType, fnv1a}, project {bufferView} — in that order', () => {
    expect(Object.keys(fs)).toEqual(['v', 'assets', 'module', 'project']);
    expect(Object.keys(fs.assets as Doc)).toEqual([KEY.A, KEY.B, KEY.C, KEY.D]);
    expect(fs.module).toEqual({ bufferView: (fs.module as Doc).bufferView, mimeType: 'text/javascript', fnv1a: fnv1a32Hex(MODULE) });
    expect(Object.keys(fs.project as Doc)).toEqual(['bufferView']);
  });

  it('the pointers read back; the views decode to EXACTLY the texts', () => {
    const p = readFsGlbPointers(doc, { images: (doc.images as unknown[]).length, bufferViews: (doc.bufferViews as unknown[]).length })!;
    expect([...p.assets.keys()].sort()).toEqual([KEY.A, KEY.B, KEY.C, KEY.D]);
    expect(new TextDecoder().decode(viewBytes(bytes, p.module!.bufferView))).toBe(MODULE);
    expect(new TextDecoder().decode(viewBytes(bytes, p.project!.bufferView))).toBe(i.projectText);
    // Every assets entry names the payload image itself.
    const again = read(bytes);
    for (const [key, src] of [[KEY.A, SRC.A], [KEY.B, SRC.B], [KEY.C, SRC.C], [KEY.D, SRC.D]] as const) {
      const img = again.images[p.assets.get(key)!];
      expect(encodeDataUri(img.mime!, img.bytes!)).toBe(src);
    }
  });

  it('the scene marker has no integers', () => {
    const scene = (doc.scenes as Doc[])[0];
    expect((scene.extras as Doc).fastshaders).toEqual({ v: 1, shader: true });
  });

  it('a non-object root extras is replaced, and says so', () => {
    const raw = baseBytes();
    const d = docOf(raw);
    d.extras = 5;
    const b = prepared(makeGlb(d, binOf(raw)), [0, 1]);
    const r = ok(input(b));
    expect(r.report.extrasReplaced).toBe(true);
    expect(((docOf(r.bytes).extras as Doc).fastshaders as Doc).v).toBe(1);
  });
});

/* ── the cross-read through the editor's own reader ──────────────────────── */

describe('the editor reader reads what the repacker writes', () => {
  it('module exact (placeholders inlined to the payloads), project refs resolve completely', () => {
    const imageNode = (id: string, src: string, fileName: string) =>
      makeNode(id, 'imageNode', { imageB64: src, width: 2, height: 2, fileName, colorSpace: 'color' });
    const nodes = [imageNode('imgA', SRC.A, 'a.png'), imageNode('imgD', SRC.D, 'd.webp'), imageNode('imgZ', SRC.E, 'z.webp')];
    const project: FastShadersProject = { version: 1, shaderName: 'Golden', graph: { nodes, edges: [] }, preview: {}, ui: {} };
    const written = new Set([SRC.A, SRC.D, SRC.C, SRC.B]);
    const refd = referenceImagesInSet(project, written, (n) => String((n.data as { values: Doc }).values.imageB64));
    const text = embedProjectState('', refd).trim();

    const base = prepared(baseBytes(), [0, 1]);
    const { bytes } = ok(input(base, { projectText: text }));
    const r = readGlbFsExtras(bytes);
    if (r.state !== 'ok') throw new Error('reader: ' + JSON.stringify(r));
    const assets = new Map([[KEY.A, SRC.A], [KEY.B, SRC.B], [KEY.C, SRC.C], [KEY.D, SRC.D]]);
    expect(r.shader.moduleText).toBe(inlineFsAssets(MODULE, assets));
    expect(r.shader.moduleEdited).toBe(false);
    expect(r.shader.assetsRefused).toBe(0);
    const extracted = extractProjectState(r.shader.projectText!);
    expect(extracted).not.toBeNull();
    const resolved = resolveProjectImageRefs(extracted!.project, r.shader.assets.values());
    expect(resolved.unresolvedIds.size).toBe(0);
    const values = (id: string) =>
      ((resolved.project.graph.nodes.find((n) => n.id === id)!.data as { values: Doc }).values);
    expect(values('imgA').imageB64).toBe(SRC.A);
    expect(values('imgD').imageB64).toBe(SRC.D);
    // A payload not written keeps its imageB64 in the block.
    expect(values('imgZ').imageB64).toBe(SRC.E);
  });
});

/* ── measure == write, determinism ───────────────────────────────────────── */

describe('measure and determinism', () => {
  const base = prepared(baseBytes(), [0, 1]);

  it('measureGlbRepack is the exact file size, in both modes', () => {
    for (const webpMode of ['fallback', 'required'] as const) {
      const i = input(base, { webpMode });
      const m = measureGlbRepack(i);
      if (!m.ok) throw new Error('measure refused');
      const r = ok(i);
      expect(m.size.totalBytes).toBe(r.bytes.length);
      expect(m.size).toEqual(r.report.size);
    }
  });

  it('the fallback-mode size counts both copies of each texture', () => {
    const f = measureGlbRepack(input(base));
    const q = measureGlbRepack(input(base, { webpMode: 'required' }));
    if (!f.ok || !q.ok) throw new Error('refused');
    expect(f.size.fallbackBytes).toBe(FB_D.length);
    expect(f.size.totalBytes - q.size.totalBytes).toBeGreaterThanOrEqual(FB_D.length);
    expect(f.size.textureImageBytes).toBe(WEBP_D.length + PNG_A.length + JPEG_C.length);
    expect(f.size.assetOnlyImageBytes).toBe(PNG_B.length);
  });

  it('two runs are byte-equal; shuffled maps and slot order change nothing', () => {
    const a = ok(input(base)).bytes;
    const b = ok(input(base)).bytes;
    expect(b).toEqual(a);
    const shuffled = input(base, {
      payloads: new Map([...PAYLOADS].reverse()),
      fallbacks: new Map([...FALLBACKS].reverse()),
      slots: [...input(base).slots].reverse(),
    });
    expect(ok(shuffled).bytes).toEqual(a);
  });
});

/* ── cycle stability ─────────────────────────────────────────────────────── */

describe('export → restore → export', () => {
  it('repack(prepare(read(repack(X)))) is byte-identical to repack(X)', () => {
    const base = prepared(baseBytes(), [0, 1]);
    const first = ok(input(base)).bytes;
    const cycleBase = prepared(first, [0, 1]);
    expect(cycleBase.source.bin).toEqual(base.source.bin);
    expect(ok(input(cycleBase)).bytes).toEqual(first);
  });

  it('the prepared cycle base carries no FastShaders views, textures or images in its tail', () => {
    const base = prepared(baseBytes(), [0, 1]);
    const first = ok(input(base)).bytes;
    const cycleBase = prepared(first, [0, 1]);
    const d = cycleBase.source.doc;
    expect(d.extras).toBeUndefined();
    expect(((d.scenes as Doc[])[0] as Doc).extras).toBeUndefined();
    expect((d.bufferViews as unknown[]).length).toBe((base.source.doc.bufferViews as unknown[]).length);
    expect(((d.images as unknown[] | undefined) ?? []).length).toBe(((base.source.doc.images as unknown[] | undefined) ?? []).length);
    expect(((d.textures as unknown[] | undefined) ?? []).length).toBe(((base.source.doc.textures as unknown[] | undefined) ?? []).length);
  });

  it('a restore that strips (the reclaim-first preview copy) gives the same next export', () => {
    const base = prepared(baseBytes(), [0, 1]);
    const first = ok(input(base)).bytes;
    const m = read(first);
    const plan = planTextureStrip(m, [0, 1])!;
    const restored = stripGltfTextures(m, plan);
    expect(ok(input(prepared(restored.bytes, [0, 1]))).bytes).toEqual(first);
  });

  it('holds through three cycles', () => {
    let bytes = ok(input(prepared(baseBytes(), [0, 1]))).bytes;
    const first = bytes;
    for (let k = 0; k < 3; k++) bytes = ok(input(prepared(bytes, [0, 1]))).bytes;
    expect(bytes).toEqual(first);
  });

  it('C19: a dead non-tail texture whose image stays live converges after ONE extra cycle (documented limit)', () => {
    // Texture 0 is unreferenced but points at image 0, which texture 1 (the
    // unbuilt material's) keeps live. The first strip ever to run re-points
    // texture 0 at the lowest DEAD image — which, with no dead image in the
    // base, is the export's first appended one — so that one placeholder
    // stays behind once. From then on it is the lowest dead image and the
    // cycle is stable.
    const png = makeRealPng(2, 2, [9, 9, 9, 255]);
    const { bin, views } = packBinViews([TRIANGLE_POSITIONS, png]);
    const doc = gltfPrimitiveDoc({
      buffers: [{ byteLength: bin.length }],
      bufferViews: views.map((v) => ({ buffer: 0, ...v })),
      images: [{ bufferView: 1, mimeType: 'image/png' }],
      textures: [{ source: 0 }, { source: 0 }],
      materials: [
        { name: 'Built', pbrMetallicRoughness: {} },
        { name: 'Kept', pbrMetallicRoughness: { baseColorTexture: { index: 1 } } },
      ],
      meshes: [0, 1].map((i) => ({ name: `M${i}`, primitives: [{ attributes: { POSITION: 0 }, material: i }] })),
      nodes: [0, 1].map((i) => ({ name: `M${i}`, mesh: i })),
      scenes: [{ nodes: [0, 1] }],
      scene: 0,
    });
    const one = (b: GltfModelReport) =>
      ok(
        input(b, {
          indexMaterials: [0],
          slots: [slot(0, 'baseColor', SRC.D)],
          moduleAssets: [{ key: KEY.D, src: SRC.D }],
        }),
      ).bytes;
    const x = one(prepared(makeGlb(doc, bin), [0]));
    const x1 = one(prepared(x, [0]));
    const x2 = one(prepared(x1, [0]));
    expect(x1).not.toEqual(x); // the one extra placeholder
    expect(x2).toEqual(x1); // stable from there
    expect(read(x2).signature).toEqual(read(x).signature);
  });
});

/* ── .gltf input and buffer extensions ───────────────────────────────────── */

describe('.gltf input', () => {
  function twoBufferGltf(ext?: string): Uint8Array {
    const png = makeRealPng(2, 2, [1, 1, 1, 255]);
    const doc = gltfPrimitiveDoc({
      buffers: [
        { byteLength: 36, uri: encodeDataUri('application/octet-stream', TRIANGLE_POSITIONS) },
        { byteLength: png.length, uri: encodeDataUri('application/octet-stream', png), ...(ext ? { extensions: { [ext]: {} } } : {}) },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 1, byteOffset: 0, byteLength: png.length },
      ],
      images: [{ bufferView: 1, mimeType: 'image/png' }],
      textures: [{ source: 0 }],
      materials: [
        { name: 'A', pbrMetallicRoughness: {} },
        { name: 'B', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
      ],
      meshes: [0, 1].map((i) => ({ name: `M${i}`, primitives: [{ attributes: { POSITION: 0 }, material: i }] })),
      nodes: [0, 1].map((i) => ({ name: `M${i}`, mesh: i })),
      scenes: [{ nodes: [0, 1] }],
      scene: 0,
      ...(ext ? { extensionsUsed: [ext] } : {}),
    });
    return new TextEncoder().encode(JSON.stringify(doc));
  }
  const gltfInput = (b: GltfModelReport): RepackInput =>
    input(b, { indexMaterials: [0], slots: [slot(0, 'baseColor', SRC.A)], moduleAssets: [{ key: KEY.A, src: SRC.A }] });

  it('two data buffers merge into one BIN; accessor bytes and the unbuilt texture survive; measure == write', () => {
    const base = prepared(twoBufferGltf(), [0], 'gltf');
    const i = gltfInput(base);
    const r = ok(i);
    const m = measureGlbRepack(i);
    expect(m.ok && m.size.totalBytes).toBe(r.bytes.length);
    const again = read(r.bytes);
    const doc = docOf(r.bytes);
    expect((doc.buffers as Doc[])).toHaveLength(1);
    expect((doc.buffers as Doc[])[0].uri).toBeUndefined();
    expect(viewBytes(r.bytes, 0)).toEqual(TRIANGLE_POSITIONS);
    const keptRef = again.materials[1].slots.find((s) => s.slot === 'baseColor')!;
    expect(again.images[again.textures[keptRef.texture].extract.image as number].bytes).toEqual(makeRealPng(2, 2, [1, 1, 1, 255]));
    expect(again.signature).toEqual(base.signature);
  });

  it('a buffer extension outside meshopt refuses the merge', () => {
    const base = read(twoBufferGltf('EXT_unknown_offsets'), 'gltf');
    expect(refusal(gltfInput(base))).toEqual({ reason: 'unsupported-buffer-extension', detail: 'merge' });
  });

  it("a GLB whose BIN carries a foreign extension is repacked as-is ('kept' base, no refusal)", () => {
    const b = repackBaseGlb({ materials: ['A', 'B'], textured: true, extraBufferExt: 'EXT_unknown_offsets' });
    const base = prepared(b, [0]);
    const r = ok(input(base, { indexMaterials: [0], slots: [slot(0, 'baseColor', SRC.A)], moduleAssets: [{ key: KEY.A, src: SRC.A }] }));
    expect(read(r.bytes).signature).toEqual(base.signature);
  });
});

/* ── caps and refusals ───────────────────────────────────────────────────── */

describe('caps', () => {
  const base = prepared(baseBytes(), [0, 1]);

  it(`${FS_EMBED_ASSETS_MAX + 1} asset keys → too-many-assets`, () => {
    const moduleAssets = Array.from({ length: FS_EMBED_ASSETS_MAX + 1 }, (_, i) => ({ key: `img${i}-0000000a`, src: SRC.A }));
    expect(refusal(input(base, { moduleAssets, slots: [slot(0, 'baseColor', SRC.A)] })).reason).toBe('too-many-assets');
  });

  it('an asset over 16 MiB → asset-too-large', () => {
    const big = new Uint8Array(FS_EMBED_ASSET_BYTES_MAX + 1);
    big.set(fakeWebp(8, 8, false));
    const src = 'data:image/webp;base64,BIG';
    const r = refusal(
      input(base, {
        slots: [],
        payloads: new Map([[src, { mime: 'image/webp', bytes: big, lossless: false }]]),
        moduleAssets: [{ key: KEY.D, src }],
      }),
    );
    expect(r).toEqual({ reason: 'asset-too-large', detail: `asset:${KEY.D}` });
  });

  it('module and project over their caps', () => {
    expect(refusal(input(base, { moduleText: 'x'.repeat(FS_MODULE_MAX_BYTES + 1) })).reason).toBe('module-too-large');
    // UTF-8 bytes, not characters: 'ā' is two bytes.
    expect(refusal(input(base, { moduleText: 'ā'.repeat(FS_MODULE_MAX_BYTES / 2 + 1) })).reason).toBe('module-too-large');
    const bigProject = FS_PROJECT_BEGIN + 'x'.repeat(FS_PROJECT_MAX_BYTES) + FS_PROJECT_END;
    expect(refusal(input(base, { projectText: bigProject })).reason).toBe('project-too-large');
  });

  it('a JSON chunk pushed over 16 MiB → too-complex', () => {
    const raw = repackBaseGlb({ materials: ['Body', 'Glass'], textured: false });
    const d = docOf(raw);
    (d.asset as Doc).extras = { pad: '' };
    const room = GLB_JSON_MAX_BYTES - 64 - JSON.stringify(d).length;
    (d.asset as Doc).extras = { pad: 'x'.repeat(room) };
    const b = prepared(makeGlb(d, binOf(raw)), [0]);
    const r = refusal(input(b, { indexMaterials: [0], slots: [slot(0, 'baseColor', SRC.A)], moduleAssets: [{ key: KEY.A, src: SRC.A }] }));
    expect(r).toEqual({ reason: 'too-complex', detail: 'json' });
  });

  /*
   * The u32 total guard, which COULD NOT FIRE at the one size it is for: the
   * padding was `(n + 3) & ~3` and a bitwise operator coerces through ToInt32,
   * so it returned 0 at 2^32 and -2147483648 at 3·2^31 — `ceil4`, two lines
   * above it in the source, had been doing the same job correctly all along.
   * `end` cannot reach 4 GiB today (the base is capped at 96/256 MiB and the
   * module's assets at 64 MiB), so this drives the layout with a base BIN that
   * only DECLARES its length: nothing reads its bytes before the guard, and
   * `measureGlbRepack` never writes the file. Measured unfixed: the first case
   * reported totalBytes 3508 for a 4 GiB file, the second -2147480140 — and
   * `exportPreflight`'s `n()` reads a negative size as 0, so the N1 "too large
   * to open again" dialog never opens and `repackGlb` throws a RangeError
   * ("Invalid typed array length") out of `new Uint8Array(l.end)` instead.
   */
  it.each([
    ['2^32, where `& ~3` wrapped to 0', 2 ** 32],
    ['3·2^31, where it went negative', 3 * 2 ** 31],
  ])('refuses a file that would not fit the u32 length field: %s', (_why, length) => {
    const bin = { length } as unknown as Uint8Array;
    const huge: GltfModelReport = {
      ...base,
      source: { ...base.source, bin, buffers: [bin, ...base.source.buffers.slice(1)] },
    };
    expect(measureGlbRepack(input(huge))).toEqual({ ok: false, refusal: { reason: 'too-complex', detail: 'total' } });
  });
});

describe('bad input', () => {
  const base = prepared(baseBytes(), [0, 1]);
  const cases: [string, Partial<RepackInput>, string][] = [
    ['slot material not an index section', { slots: [slot(2, 'baseColor', SRC.A)] }, 'slot-material'],
    ['duplicate (material, slot)', { slots: [slot(0, 'baseColor', SRC.A), slot(0, 'baseColor', SRC.D)] }, 'slot-duplicate'],
    ['texCoord out of range', { slots: [slot(0, 'baseColor', SRC.A, { texCoord: 4 as 0 })] }, 'slot-texcoord'],
    ['a non-finite transform', { slots: [slot(0, 'baseColor', SRC.A, { transform: { rotation: Infinity } })] }, 'slot-transform'],
    ['a sampler enum outside the closed set', { slots: [slot(0, 'baseColor', SRC.A, { sampler: { ...LINEAR_REPEAT, wrapS: 33648 as 10497 } })] }, 'slot-sampler'],
    ['a payload whose bytes are not its mime', { payloads: new Map([...PAYLOADS, [SRC.A, { mime: 'image/webp', bytes: PNG_A, lossless: false }]]) }, 'payload'],
    ['a slot payload with no asset key', { moduleAssets: [{ key: KEY.D, src: SRC.D }, { key: KEY.C, src: SRC.C }] }, 'payload-without-asset'],
    ['an asset key imageAssets never mints', { moduleAssets: [{ key: '__proto__', src: SRC.A }] }, 'asset-key'],
    ['a project text that is not the marker block', { projectText: '{"version":1}' }, 'project-block'],
    ['a lone surrogate in the module', { moduleText: 'export default 1; // \uD800' }, 'module-not-well-formed'],
    ['an empty module', { moduleText: '' }, 'module'],
    ['a generator outside the whitelist', { generator: 'FastShaders <script>' }, 'generator'],
    ['a JPEG fallback that is really a PNG', { fallbacks: new Map([[SRC.D, { mime: 'image/jpeg', bytes: FB_D }]]) }, 'fallback'],
  ];
  for (const [what, over, detail] of cases) {
    it(what, () => {
      expect(refusal(input(base, over))).toEqual({ reason: 'bad-input', detail });
    });
  }
});

/* ── helpers ─────────────────────────────────────────────────────────────── */

describe('truncateDeadTail', () => {
  it('pops only unreferenced exact placeholders, from the end, and deletes an emptied array', () => {
    const doc: Doc = {
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }, { source: 1 }, { source: 1, sampler: 0 }, { source: 1 }],
      images: [{ bufferView: 1, mimeType: 'image/png' }, { uri: PLACEHOLDER_PNG_DATA_URI }, { uri: PLACEHOLDER_PNG_DATA_URI }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 8 },
        { buffer: 0, byteOffset: 0, byteLength: 1 },
        { buffer: 0, byteOffset: 0, byteLength: 1 },
      ],
      accessors: [{ bufferView: 0 }],
    };
    truncateDeadTail(doc);
    // Texture 3 pops; texture 2 has a sampler, so it is not a placeholder and stops the pop.
    expect(doc.textures).toHaveLength(3);
    // Image 2 pops; image 1 is named by texture 1 (and 2).
    expect(doc.images).toHaveLength(2);
    // Views 3 and 2 pop; view 1 is named by image 0.
    expect(doc.bufferViews).toHaveLength(2);

    const bare: Doc = { textures: [{ source: 0 }], images: [{ uri: PLACEHOLDER_PNG_DATA_URI }] };
    truncateDeadTail(bare);
    expect(bare.textures).toBeUndefined();
    expect(bare.images).toBeUndefined();
  });

  it('a referenced tail entry stops the pop (a texture named from an extension, a view named from extras)', () => {
    const doc: Doc = {
      materials: [{ extensions: { KHR_x: { sheenColorTexture: { index: 0 } } } }],
      textures: [{ source: 0 }],
      images: [{ uri: PLACEHOLDER_PNG_DATA_URI }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 1 }],
      extras: { fastshaders: { v: 1, module: { bufferView: 0 } } },
    };
    truncateDeadTail(doc);
    expect(doc.textures).toHaveLength(1);
    expect(doc.images).toHaveLength(1);
    expect(doc.bufferViews).toHaveLength(1);
  });
});

describe('samplerFor and safeImageName', () => {
  it('samplerFor follows the node\'s own emission rules', () => {
    expect(samplerFor({ colorSpace: 'color', nearest: false, repeat: true })).toEqual({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
    expect(samplerFor({ colorSpace: 'color', nearest: true, repeat: false })).toEqual({ magFilter: 9728, minFilter: 9984, wrapS: 33071, wrapT: 33071 });
    expect(samplerFor({ colorSpace: 'data', nearest: false, repeat: true })).toEqual({ magFilter: 9729, minFilter: 9729, wrapS: 10497, wrapT: 10497 });
    expect(samplerFor({ colorSpace: 'data', nearest: true, repeat: true })).toEqual({ magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 });
  });

  it('safeImageName: ASCII whitelist, runs collapsed, trimmed, ≤ 48', () => {
    expect(safeImageName('  Ķermenis āda.png ')).toBe('ermenis da.png');
    expect(safeImageName('a</script>*/b')).toBe('a script b');
    expect(safeImageName('\u202Eevil\u0000.png')).toBe('evil .png');
    expect(safeImageName('x'.repeat(100))).toHaveLength(48);
    expect(safeImageName(5)).toBe('');
    expect(safeImageName('***')).toBe('');
  });

  it('GLTF_WRITABLE_SLOTS is the order slots are written in', () => {
    expect(GLTF_WRITABLE_SLOTS).toEqual(['baseColor', 'metallicRoughness', 'normal', 'emissive']);
  });
});

describe('prepareRepackBase', () => {
  it('is idempotent, and strips the index materials\' textures of a model-only base', () => {
    const raw = baseBytes();
    const once = prepared(raw, [0, 1]);
    const twice = prepareRepackBase(once, [0, 1]);
    expect(twice.ok && twice.model.source.doc).toEqual(once.source.doc);
    expect(once.materials[0].slots).toEqual([]);
    expect(once.materials[1].slots).toEqual([]);
    expect(once.materials[2].slots).toHaveLength(1);
  });
});

/**
 * KTX2 copies (Phase 8): an EXTRA `KHR_texture_basisu` source beside a written
 * texture, never in place of it. The bytes here are three's own 40x40 UASTC
 * fixture, so what a test asserts about the file is a real KTX2 image.
 */
describe('ktx2Sources', () => {
  const KTX2 = new Uint8Array(readFileSync(join(__dirname, '../engine/fixtures/ktx2/2d_uastc.ktx2')));
  const KTX2_B = new Uint8Array(readFileSync(join(__dirname, '../engine/fixtures/ktx2/2d_etc1s.ktx2')));

  /** The texture index of the first written slot, from the measure. */
  function firstTexture(i: RepackInput): number {
    const m = measureGlbRepack(i);
    if (!m.ok) throw new Error('measure refused');
    return m.written[0].texture;
  }

  it('an ABSENT or EMPTY map writes the byte-identical file', () => {
    const base = prepared(baseBytes(), [0, 1]);
    const plain = ok(input(base)).bytes;
    expect(ok(input(base, { ktx2Sources: new Map() })).bytes).toEqual(plain);
    // …and the size reports no copies.
    expect(ok(input(base)).report.size.ktx2Bytes).toBe(0);
    expect(ok(input(base)).report.size.ktx2Count).toBe(0);
  });

  it('adds ONE image/ktx2 image beside the texture, keeping its own source', () => {
    const base = prepared(baseBytes(), [0, 1]);
    const i = input(base);
    const t = firstTexture(i);
    const r = ok(input(base, { ktx2Sources: new Map([[t, KTX2]]) }));
    const doc = docOf(r.bytes);
    const images = doc.images as Doc[];
    const ktx2Images = images.filter((im) => im.mimeType === 'image/ktx2');
    expect(ktx2Images).toHaveLength(1);
    const ktx2Image = images.indexOf(ktx2Images[0]);
    // The bytes really are the fixture.
    expect(viewBytes(r.bytes, ktx2Images[0].bufferView as number)).toEqual(KTX2);

    const tex = (doc.textures as Doc[])[t];
    const ext = tex.extensions as Doc;
    const plainTex = (docOf(ok(i).bytes).textures as Doc[])[t];
    // The slot's payload is a WebP, so both extensions sit side by side, and
    // the texture's own core `source` (its PNG fallback) is untouched.
    expect((ext.KHR_texture_basisu as Doc).source).toBe(ktx2Image);
    expect(ext.EXT_texture_webp).toEqual((plainTex.extensions as Doc).EXT_texture_webp);
    expect(tex.source).toBe(plainTex.source);
    expect(tex.sampler).toBe(plainTex.sampler);
    expect(r.report.size.ktx2Count).toBe(1);
    expect(r.report.size.ktx2Bytes).toBe(KTX2.length);
  });

  it('lists the extension as USED, never REQUIRED, and never as a module asset', () => {
    const base = prepared(baseBytes(), [0, 1]);
    const i = input(base);
    const r = ok(input(base, { ktx2Sources: new Map([[firstTexture(i), KTX2]]) }));
    const doc = docOf(r.bytes);
    const used = doc.extensionsUsed as string[];
    expect(used).toContain('KHR_texture_basisu');
    expect(used.filter((e) => e === 'KHR_texture_basisu')).toHaveLength(1);
    expect((doc.extensionsRequired as string[] | undefined) ?? []).not.toContain('KHR_texture_basisu');
    // No `assets` entry may point at a KTX2 image: the module samples the
    // WebP/PNG payloads, which is the whole Option A decision.
    const images = doc.images as Doc[];
    const pointers = readFsGlbPointers(doc, { images: images.length, bufferViews: (doc.bufferViews as Doc[]).length });
    expect(pointers).not.toBeNull();
    for (const image of pointers!.assets.values()) {
      expect(images[image].mimeType).not.toBe('image/ktx2');
    }
  });

  it('identical bytes on two textures become ONE image; a key naming no written texture is ignored', () => {
    const base = prepared(baseBytes(), [0, 1]);
    const i = input(base);
    const m = measureGlbRepack(i);
    if (!m.ok) throw new Error('measure refused');
    const ts = [...new Set(m.written.map((w) => w.texture))];
    expect(ts.length).toBeGreaterThan(1);
    const shared = ok(input(base, { ktx2Sources: new Map([[ts[0], KTX2], [ts[1], KTX2.slice()]]) }));
    expect((docOf(shared.bytes).images as Doc[]).filter((im) => im.mimeType === 'image/ktx2')).toHaveLength(1);
    expect(shared.report.size.ktx2Count).toBe(1);
    // Different bytes are two images.
    const two = ok(input(base, { ktx2Sources: new Map([[ts[0], KTX2], [ts[1], KTX2_B]]) }));
    expect((docOf(two.bytes).images as Doc[]).filter((im) => im.mimeType === 'image/ktx2')).toHaveLength(2);
    // An index this pass never wrote (and an empty payload) is dropped.
    const none = ok(input(base, { ktx2Sources: new Map([[999, KTX2], [ts[0], new Uint8Array(0)]]) }));
    expect(none.bytes).toEqual(ok(input(base)).bytes);
  });

  it('the file still re-reads: the module text and the assets are unchanged', () => {
    const base = prepared(baseBytes(), [0, 1]);
    const i = input(base);
    const plain = readGlbFsExtras(ok(i).bytes);
    const withKtx2 = readGlbFsExtras(ok(input(base, { ktx2Sources: new Map([[firstTexture(i), KTX2]]) })).bytes);
    expect(plain.state).toBe('ok');
    expect(withKtx2.state).toBe('ok');
    if (plain.state !== 'ok' || withKtx2.state !== 'ok') return;
    expect(withKtx2.shader.moduleText).toBe(plain.shader.moduleText);
    expect(withKtx2.shader.projectText).toBe(plain.shader.projectText);
    expect(withKtx2.shader.moduleEdited).toBe(false);
  });
});

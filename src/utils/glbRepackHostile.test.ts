/**
 * Hostile CONTENT cannot break the container the repacker writes
 * (utils/glbRepack.ts). The module and project texts ride as opaque BIN bytes
 * and every JSON string comes from a closed vocabulary or a whitelist, so a
 * text built to look like GLB structure, a comment closer, a script tag or a
 * look-alike placeholder changes nothing but its own view's bytes. A seeded
 * fuzz over payloads, slot sets and texts either refuses or writes a file
 * that re-reads with the base's signature; it never throws.
 */
import { describe, it, expect } from 'vitest';
import {
  GLTF_WRITABLE_SLOTS,
  prepareRepackBase,
  repackGlb,
  samplerFor,
  type RepackInput,
  type RepackPayload,
  type RepackSlot,
} from './glbRepack';
import { readGltfModel, type GltfModelReport } from './gltfReader';
import { encodeDataUri, parseGlbContainer } from './glbContainer';
import { safeJsonReviver } from './safeJson';
import { readFsGlbPointers } from '@/engine/glbShaderContract';
import { embedProjectState, extractProjectState, type FastShadersProject } from '@/engine/fastShadersProject';
import { makeNode, makeRealPng, repackBaseGlb } from '@/test-utils';

type Doc = Record<string, unknown>;

function read(bytes: Uint8Array): GltfModelReport {
  const r = readGltfModel(bytes, 'glb');
  if (!r.ok) throw new Error('reader refused: ' + JSON.stringify(r.refusal));
  return r.model;
}

const BASE = (() => {
  const r = prepareRepackBase(read(repackBaseGlb({ materials: ['Body', 'Glass'], textured: true })), [0, 1]);
  if (!r.ok) throw new Error('prepare');
  return r.model;
})();

const PNG = makeRealPng(2, 2, [1, 2, 3, 255]);
const SRC = encodeDataUri('image/png', PNG);
const KEY = 'img1-0badf00d';
const SAMPLER = samplerFor({ colorSpace: 'color', nearest: false, repeat: true });

function project(nodes: ReturnType<typeof makeNode>[]): string {
  const p: FastShadersProject = { version: 1, shaderName: 'x', graph: { nodes, edges: [] }, preview: {}, ui: {} };
  return embedProjectState('', p).trim();
}

function input(over: Partial<RepackInput> = {}): RepackInput {
  return {
    base: BASE,
    indexMaterials: [0, 1],
    slots: [{ material: 0, slot: 'baseColor', src: SRC, texCoord: 0, transform: null, sampler: SAMPLER, name: 'a.png' }],
    payloads: new Map([[SRC, { mime: 'image/png', bytes: PNG, lossless: true }]]),
    fallbacks: new Map(),
    moduleText: 'export default function () { return {}; }\n',
    moduleAssets: [{ key: KEY, src: SRC }],
    projectText: project([]),
    webpMode: 'fallback',
    ...over,
  };
}

function chunkCount(bytes: Uint8Array): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let n = 0;
  for (let at = 12; at < dv.getUint32(8, true); at += 8 + dv.getUint32(at, true)) n++;
  return n;
}

function viewText(bytes: Uint8Array, view: number): string {
  const c = parseGlbContainer(bytes);
  if (!c.ok || !c.chunks.bin) throw new Error('container');
  const doc = JSON.parse(c.chunks.json, safeJsonReviver) as Doc;
  const v = (doc.bufferViews as Doc[])[view];
  const off = (v.byteOffset as number) ?? 0;
  return new TextDecoder('utf-8', { fatal: true }).decode(c.chunks.bin.subarray(off, off + (v.byteLength as number)));
}

function checkContainer(bytes: Uint8Array, moduleText: string, projectText: string): void {
  const c = parseGlbContainer(bytes);
  expect(c.ok).toBe(true);
  expect(chunkCount(bytes)).toBe(2);
  const m = read(bytes);
  expect(m.signature).toEqual(BASE.signature);
  const doc = m.source.doc;
  const p = readFsGlbPointers(doc, { images: m.images.length, bufferViews: (doc.bufferViews as unknown[]).length })!;
  expect(viewText(bytes, p.module!.bufferView)).toBe(moduleText);
  expect(viewText(bytes, p.project!.bufferView)).toBe(projectText);
  for (const img of doc.images as Doc[]) {
    if (img.name !== undefined) expect(img.name).toMatch(/^[A-Za-z0-9._ -]{0,48}$/);
  }
  const fs = (doc.extras as Doc).fastshaders as Doc;
  for (const k of Object.keys(fs)) expect(['v', 'assets', 'module', 'project']).toContain(k);
}

describe('hostile texts', () => {
  it('a module that looks like GLB structure, comments, markup and placeholders stays opaque bytes', () => {
    const moduleText =
      'glTF JSON BIN\u0000 \u0000\u0000 */ </script><svg onload=alert(1)> \u2028 \u2029 ' +
      '"fs-asset:../../etc/passwd" "fs-asset:img9-deadbeef" "fs-asset:' +
      'x'.repeat(200) +
      '" {"extras":{"fastshaders":{"v":2}}} ' +
      'ā€𝄞'.repeat(1000) +
      'j'.repeat(1024 * 1024) +
      '\nexport default function () {}\n';
    const r = repackGlb(input({ moduleText }));
    if (!r.ok) throw new Error(JSON.stringify(r.refusal));
    checkContainer(r.bytes, moduleText, input().projectText);
  });

  it('a lone surrogate in either text is refused (it has no UTF-8 spelling)', () => {
    const lone = repackGlb(input({ moduleText: 'export default 1; \uDC00' }));
    expect(lone.ok || lone.refusal.reason).toBe('bad-input');
  });

  it('a hostile project block (ids, 4 KB control-character names, nested arrays) round-trips exactly', () => {
    const nasty = '\u0000\u0007\u001B\u202E\u2066' + '\u200F'.repeat(1000) + '*/'.repeat(500) + 'x'.repeat(1500);
    const nodes = ['__proto__', 'constructor', '"', '*/', '</script>'].map((id) =>
      makeNode(id, 'imageNode', { imageB64: SRC, width: 2, height: 2, fileName: nasty }),
    );
    (nodes[0].data as Doc).extra = [[[[['deep']]]], { a: [{ b: [nasty] }] }];
    const projectText = project(nodes);
    const slots: RepackSlot[] = [
      { material: 0, slot: 'baseColor', src: SRC, texCoord: 0, transform: null, sampler: SAMPLER, name: nasty },
    ];
    const r = repackGlb(input({ projectText, slots, moduleAssets: [{ key: KEY, src: SRC, name: nasty }] }));
    if (!r.ok) throw new Error(JSON.stringify(r.refusal));
    checkContainer(r.bytes, input().moduleText, projectText);
    const back = extractProjectState(projectText);
    expect(back?.project.graph.nodes.map((n) => n.id)).toEqual(['__proto__', 'constructor', '"', '*/', '</script>']);
  });
});

/* ── seeded fuzz ─────────────────────────────────────────────────────────── */

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAGIC: Record<RepackPayload['mime'], number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/webp': [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
};

describe('seeded fuzz (200 iterations)', () => {
  it('refuses or writes a file that re-reads with the base signature; never throws', () => {
    const rnd = mulberry32(0xf5f5);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const pool = ['a', 'Z', '0', ' ', '\n', '"', '\\', '*/', '</script>', 'ā', '𝄞', '\u0000', '\u2028', 'fs-asset:', 'glTF', 'BIN\u0000'];
    const text = () => Array.from({ length: Math.floor(rnd() * 200) }, () => pick(pool)).join('');
    let wrote = 0;
    for (let it = 0; it < 200; it++) {
      const payloads = new Map<string, RepackPayload>();
      const n = 1 + Math.floor(rnd() * 5);
      const srcs: string[] = [];
      for (let i = 0; i < n; i++) {
        const mime = pick(['image/png', 'image/jpeg', 'image/webp'] as const);
        const bytes = new Uint8Array(MAGIC[mime].length + Math.floor(rnd() * 64));
        for (let k = 0; k < bytes.length; k++) bytes[k] = Math.floor(rnd() * 256);
        bytes.set(MAGIC[mime], 0);
        const src = encodeDataUri(mime, bytes);
        if (payloads.has(src)) continue;
        payloads.set(src, { mime, bytes, lossless: rnd() < 0.5 });
        srcs.push(src);
      }
      const slots: RepackSlot[] = [];
      for (const material of [0, 1]) {
        for (const slot of GLTF_WRITABLE_SLOTS) {
          if (rnd() < 0.5) continue;
          slots.push({
            material,
            slot,
            src: pick(srcs),
            texCoord: pick([0, 1, 2, 3] as const),
            transform: rnd() < 0.5 ? null : { offset: [rnd() * 4 - 2, rnd()], rotation: rnd() * 7, scale: [rnd() * 3, -rnd()] },
            sampler: samplerFor({ colorSpace: pick(['color', 'data'] as const), nearest: rnd() < 0.5, repeat: rnd() < 0.5 }),
            name: text(),
          });
        }
      }
      const fallbacks = new Map(srcs.map((s) => [s, rnd() < 0.5 ? null : { mime: 'image/png' as const, bytes: PNG }]));
      const i: RepackInput = {
        base: BASE,
        indexMaterials: [0, 1],
        slots: rnd() < 0.9 ? slots.sort(() => rnd() - 0.5) : slots,
        payloads,
        fallbacks,
        moduleText: text() || 'x',
        moduleAssets: srcs.map((src, k) => ({ key: `r${k}-0000000${k}`, src, name: text() })),
        projectText: rnd() < 0.9 ? project([]) : text(),
        webpMode: pick(['fallback', 'required'] as const),
        ...(rnd() < 0.3 ? { generator: 'FastShaders ' + text() } : {}),
      };
      let r: ReturnType<typeof repackGlb> | undefined;
      expect(() => (r = repackGlb(i))).not.toThrow();
      if (!r!.ok) continue;
      wrote++;
      const again = readGltfModel(r!.bytes, 'glb');
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.model.signature).toEqual(BASE.signature);
    }
    // The fuzz really writes files, not only refusals.
    expect(wrote).toBeGreaterThan(50);
  });
});

/**
 * The single-GLB composer (engine/exportSingleGlb.ts) over the REAL store: a
 * loaded model, an import-shaped graph and its generated code in, one `.glb`
 * out — read back through the trusted-side reader AND the editor's own
 * payload reader (module exact, project refs complete). The PNG/JPEG
 * fallback encoder is DOM-only, so it is injected through the test seam.
 *
 * `isolate: false`: the store is shared with the worker, so each test sets
 * what it reads, `localStorage` is stubbed ABSENT (buildProjectState reads
 * preview prefs from it) and every stub and the seam are restored.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import {
  __setFallbackEncoderForTests,
  __setKtx2PixelReaderForTests,
  prepareSingleGlb,
  type SingleGlbPrepared,
} from './exportSingleGlb';
import { setKtx2Encoder, type Ktx2EncodeRequest, type Ktx2Encoder } from '@/utils/ktx2Encoder';
import { buildExportModule } from './exportShader';
import { extractProjectState } from './fastShadersProject';
import { graphToCode } from './graphToCode';
import { resolveProjectImageRefs } from './projectImageRefs';
import { readFsGlbPointers } from './glbShaderContract';
import { createPreviewMesh, type PreviewMesh } from '@/utils/previewMesh';
import { readGltfModel } from '@/utils/gltfReader';
import { readGlbFsExtras } from '@/utils/glbShaderExtras';
import { parseGlbContainer } from '@/utils/glbContainer';
import { safeJsonReviver } from '@/utils/safeJson';
import { canonicalSrc, fakeWebp, makeEdge, makeNode, makeRealPng, repackBaseGlb } from '@/test-utils';
import type { AppEdge, AppNode } from '@/types';

const SIG = ['Body', 'Glass', 'Trim'];
const WEBP = fakeWebp(8, 8, false);
const PNG_N = makeRealPng(4, 4, [128, 128, 255, 255]);
const PNG_Z = makeRealPng(2, 2, [1, 2, 3, 255]);
const SRC = { W: canonicalSrc('image/webp', WEBP), N: canonicalSrc('image/png', PNG_N), Z: canonicalSrc('image/png', PNG_Z) };

function mesh(): PreviewMesh {
  const r = createPreviewMesh('statue.glb', repackBaseGlb({ materials: SIG, textured: true }));
  if (!('mesh' in r)) throw new Error('mesh refused');
  return r.mesh;
}

function graph(signature: string[] = SIG): { nodes: AppNode[]; edges: AppEdge[] } {
  const out = makeNode('out', 'output');
  Object.assign(out.data as Record<string, unknown>, {
    materials: [{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }],
    modelSignature: { materials: signature },
  });
  const img = (id: string, src: string, w: number, extra: Record<string, string | number> = {}) =>
    makeNode(id, 'imageNode', { imageB64: src, width: w, height: w, fileName: `${id}.img`, orientation: 'gltf', ...extra });
  const nodes = [out, img('T', SRC.W, 8), img('N', SRC.N, 4, { colorSpace: 'data' })];
  const edges = [makeEdge('T', 'out', 'out', 'm1:color'), makeEdge('N', 'out', 'out', 'm2:normal')];
  return { nodes, edges };
}

const calls: { mime: string; width: number; height: number }[] = [];
const FALLBACK = makeRealPng(8, 8, [9, 9, 9, 255]);

function setStore(g: { nodes: AppNode[]; edges: AppEdge[] }, codeFrom = g, previewMesh: PreviewMesh | null = mesh()) {
  cancelPendingGraphSave();
  useAppStore.setState({
    nodes: g.nodes,
    edges: g.edges,
    code: graphToCode(codeFrom.nodes, codeFrom.edges).code,
    drawings: [],
    shaderPalettes: [],
    shaderName: 'Golden',
    previewMesh,
  });
}

async function prepared(): Promise<SingleGlbPrepared> {
  const r = await prepareSingleGlb();
  if (!r.ok) throw new Error('refused: ' + JSON.stringify(r));
  return r.prepared;
}

beforeAll(() => {
  vi.stubGlobal('localStorage', undefined);
});
beforeEach(() => {
  calls.length = 0;
  __setFallbackEncoderForTests(async (p, width, height) => {
    calls.push({ mime: p.mime, width, height });
    return { mime: 'image/png', bytes: FALLBACK };
  });
});
afterAll(() => {
  __setFallbackEncoderForTests(null);
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], drawings: [], shaderPalettes: [], previewMesh: null, code: '' });
  vi.unstubAllGlobals();
});

describe('prepareSingleGlb → build', () => {
  it('writes a GLB the reader re-reads, with the slots mapped and the fallback encoded once per WebP', async () => {
    setStore(graph());
    const p = await prepared();
    expect(p.fileName).toBe('golden.glb');
    expect(calls).toEqual([{ mime: 'image/webp', width: 8, height: 8 }]);
    const { bytes, report } = p.build('fallback');
    expect(report.size.totalBytes).toBe(bytes.length);
    expect(p.sizes.fallback.totalBytes).toBe(bytes.length);
    expect(p.build('required').bytes.length).toBe(p.sizes.required.totalBytes);
    const again = readGltfModel(bytes, 'glb');
    if (!again.ok) throw new Error('re-read');
    expect(again.model.signature.materials).toEqual(SIG);
    expect(again.model.materials[0].slots.map((s) => s.slot)).toEqual(['baseColor']);
    expect(again.model.materials[1].slots.map((s) => s.slot)).toEqual(['normal']);
    expect(again.model.materials[2].slots.map((s) => s.slot)).toEqual(['baseColor']);
    expect(p.problems).toEqual([]);
    const c = parseGlbContainer(bytes);
    const doc = c.ok ? (JSON.parse(c.chunks.json, safeJsonReviver) as Record<string, unknown>) : {};
    expect((doc.asset as Record<string, unknown>).generator).toMatch(/^FastShaders [0-9A-Za-z.+-]+$/);
    // The build is deterministic.
    expect(p.build('fallback').bytes).toEqual(bytes);
  });

  it('the module inside is buildExportModule({ inlineImages: false, glbFile }) exactly, placeholders kept', async () => {
    setStore(graph());
    const bytes = (await prepared()).build('fallback').bytes;
    const c = parseGlbContainer(bytes);
    if (!c.ok || !c.chunks.bin) throw new Error('container');
    const doc = JSON.parse(c.chunks.json, safeJsonReviver) as Record<string, unknown>;
    const ptr = readFsGlbPointers(doc, { images: (doc.images as unknown[]).length, bufferViews: (doc.bufferViews as unknown[]).length })!;
    const view = (doc.bufferViews as Record<string, number>[])[ptr.module!.bufferView];
    const text = new TextDecoder().decode(c.chunks.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength));
    expect(text).toBe(buildExportModule({ inlineImages: false, glbFile: 'golden.glb' }));
    expect(text).toContain('"fs-asset:');
    expect(text).not.toContain('data:image');
  });

  it('the project block references every written payload, resolves completely, and an unwritten one keeps imageB64', async () => {
    const g = graph();
    const z = makeNode('Z', 'imageNode', { imageB64: SRC.Z, width: 2, height: 2, fileName: 'z.png' });
    // The code (un-applied, say) does not know Z: its payload is not in the file.
    setStore({ nodes: [...g.nodes, z], edges: g.edges }, g);
    const bytes = (await prepared()).build('fallback').bytes;
    const r = readGlbFsExtras(bytes);
    if (r.state !== 'ok') throw new Error('reader: ' + JSON.stringify(r));
    expect(r.shader.moduleEdited).toBe(false);
    const extracted = extractProjectState(r.shader.projectText!)!;
    const byId = new Map(extracted.project.graph.nodes.map((n) => [n.id, (n.data as { values: Record<string, unknown> }).values]));
    expect(byId.get('T')!.imageB64).toBeUndefined();
    expect(byId.get('N')!.imageB64).toBeUndefined();
    expect(byId.get('Z')!.imageB64).toBe(SRC.Z);
    const refs = (extracted.project as { imageRefs?: Record<string, string> }).imageRefs!;
    expect(Object.keys(refs).sort()).toEqual(['N', 'T']);
    const resolved = resolveProjectImageRefs(extracted.project, r.shader.assets.values());
    expect(resolved.unresolvedIds.size).toBe(0);
    const values = (id: string) =>
      (resolved.project.graph.nodes.find((n) => n.id === id)!.data as { values: Record<string, unknown> }).values;
    expect(values('T').imageB64).toBe(SRC.W);
    expect(values('N').imageB64).toBe(SRC.N);
  });

  it('a failed fallback encode writes that texture WebP-only and says so in the size', async () => {
    setStore(graph());
    __setFallbackEncoderForTests(async () => null);
    const p = await prepared();
    expect(p.sizes.fallback.fallbackMissing).toBe(1);
    expect(p.sizes.fallback.webpRequired).toBe(true);
  });
});

describe('refusals', () => {
  it('no model, an OBJ, a signature mismatch', async () => {
    setStore(graph(), undefined, null);
    expect(await prepareSingleGlb()).toEqual({ ok: false, reason: 'no-model' });
    const obj = createPreviewMesh('rock.obj', new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'));
    if (!('mesh' in obj)) throw new Error('obj');
    setStore(graph(), undefined, obj.mesh);
    expect(await prepareSingleGlb()).toEqual({ ok: false, reason: 'not-gltf', name: 'rock.obj' });
    setStore(graph(['Body', 'Glass', 'Other']));
    expect(await prepareSingleGlb()).toEqual({ ok: false, reason: 'model-mismatch' });
  });

  it('an aborted signal, before and during the fallback encodes', async () => {
    setStore(graph());
    const before = new AbortController();
    before.abort();
    expect(await prepareSingleGlb({ signal: before.signal })).toEqual({ ok: false, reason: 'aborted' });
    const during = new AbortController();
    __setFallbackEncoderForTests(async () => {
      during.abort();
      return { mime: 'image/png', bytes: FALLBACK };
    });
    expect(await prepareSingleGlb({ signal: during.signal })).toEqual({ ok: false, reason: 'aborted' });
  });
});

describe('source pins', () => {
  const src = readFileSync(path.join(__dirname, 'exportSingleGlb.ts'), 'utf8');

  it('the study gate is the first check, and a failed module is refused by its prefix', () => {
    const body = src.slice(src.indexOf('export async function prepareSingleGlb'));
    expect(body.indexOf("if (isEvalMode()) return { ok: false, reason: 'study' };")).toBeGreaterThan(0);
    expect(body.indexOf('isEvalMode()')).toBeLessThan(body.indexOf('useAppStore.getState()'));
    expect(body).toContain("moduleText.startsWith(EXPORT_ERROR_PREFIX)) return { ok: false, reason: 'module-error' }");
  });

  it('no inlining, no telemetry, no second download path; the store is read before the first await', () => {
    expect(src).not.toContain('inlineImageAssets');
    expect(src).not.toContain('evalLog' + '(');
    expect(src).not.toContain('downloadSingleGlb');
    expect(src).not.toContain('createObjectURL');
    const body = src.slice(src.indexOf('export async function prepareSingleGlb'));
    expect(body.indexOf('useAppStore.getState()')).toBeLessThan(body.indexOf('await '));
    expect(body.indexOf('buildProjectState()')).toBeLessThan(body.indexOf('await '));
  });

  it('the fallback seam is never called outside a test', () => {
    const root = path.join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) {
          const text = readFileSync(full, 'utf8');
          if (text.includes('__setFallbackEncoderForTests(') && !full.endsWith(path.join('engine', 'exportSingleGlb.ts'))) {
            offenders.push(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

/**
 * The KTX2 copies (Phase 8). No encoder ships, so one is REGISTERED here and
 * removed again in afterEach; the pixels come through the same kind of seam
 * the PNG/JPEG fallback uses, since node has no canvas. What matters is that
 * the copies are additive, serial, never fatal, and absent when not asked for.
 */
describe('prepareSingleGlb: the KTX2 copies', () => {
  const KTX2 = new Uint8Array(readFileSync(path.join(__dirname, 'fixtures/ktx2/2d_uastc.ktx2')));
  /** 40x40, the fixture's size: `validateKtx2Output` checks the request against it. */
  const PX = { rgba: new Uint8Array(40 * 40 * 4), width: 40, height: 40 };

  let encodes: { width: number; height: number; colorSpace: string; normalMap: boolean; mipmaps: boolean }[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;

  function stubEncoder(encode: (req: Ktx2EncodeRequest) => Promise<Uint8Array>): Ktx2Encoder {
    return {
      id: 'test',
      version: '0',
      where: 'test',
      async encode(req) {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        encodes.push({
          width: req.width,
          height: req.height,
          colorSpace: req.colorSpace,
          normalMap: req.normalMap,
          mipmaps: req.mipmaps,
        });
        try {
          await Promise.resolve();
          return await encode(req);
        } finally {
          concurrent--;
        }
      },
    };
  }

  const okEncoder = stubEncoder(async () => KTX2);

  beforeEach(() => {
    encodes = [];
    concurrent = 0;
    maxConcurrent = 0;
    __setKtx2PixelReaderForTests(async () => PX);
  });
  afterEach(() => {
    __setKtx2PixelReaderForTests(null);
    setKtx2Encoder(null);
  });

  it('no `ktx2` option leaves the file exactly as it was', async () => {
    setStore(graph());
    const plain = (await prepared()).build('fallback').bytes;
    const r = await prepareSingleGlb({ ktx2: null });
    if (!r.ok) throw new Error('refused');
    expect(r.prepared.ktx2Written).toBe(0);
    expect(r.prepared.ktx2Skipped).toEqual([]);
    expect(r.prepared.sizes.noKtx2).toEqual(r.prepared.sizes.fallback);
    expect(r.prepared.build('fallback').bytes).toEqual(plain);
    expect(encodes).toEqual([]);
  });

  it('encodes one texture at a time, per slot, and writes a copy for each', async () => {
    setStore(graph());
    const r = await prepareSingleGlb({ ktx2: { encoder: okEncoder } });
    if (!r.ok) throw new Error('refused');
    const p = r.prepared;
    expect(maxConcurrent).toBe(1);
    // Both textures are asked for, per slot: baseColor sRGB with mips, the
    // data-map normal linear, unmipmapped and flagged as a normal map.
    expect(encodes).toEqual([
      { width: 40, height: 40, colorSpace: 'srgb', normalMap: false, mipmaps: true },
      { width: 40, height: 40, colorSpace: 'linear', normalMap: true, mipmaps: false },
    ]);
    // The stub answers BOTH with the sRGB, 6-level fixture, so the second is
    // caught by `validateKtx2Output` — an encoder's output is never trusted —
    // and reported rather than written.
    expect(p.ktx2Written).toBe(1);
    expect(p.ktx2Skipped.map((sk) => sk.reason)).toEqual(['invalid:levels']);
    const { bytes, report } = p.build('fallback');
    expect(report.size.ktx2Count).toBe(1);
    expect(report.size.ktx2Bytes).toBe(KTX2.length);
    expect(bytes.length).toBe(p.sizes.fallback.totalBytes);
    expect(p.sizes.fallback.totalBytes).toBeGreaterThan(p.sizes.noKtx2.totalBytes);
    // The file still re-reads, and the extension is USED only.
    const again = readGltfModel(bytes, 'glb');
    if (!again.ok) throw new Error('re-read');
    const c = parseGlbContainer(bytes);
    const doc = c.ok ? (JSON.parse(c.chunks.json, safeJsonReviver) as Record<string, unknown>) : {};
    expect(doc.extensionsUsed).toContain('KHR_texture_basisu');
    expect((doc.extensionsRequired as string[] | undefined) ?? []).not.toContain('KHR_texture_basisu');
  });

  it("build('no-ktx2') is the file without them, byte for byte", async () => {
    setStore(graph());
    const plain = (await prepared()).build('fallback').bytes;
    const r = await prepareSingleGlb({ ktx2: { encoder: okEncoder } });
    if (!r.ok) throw new Error('refused');
    const without = r.prepared.build('no-ktx2');
    expect(without.bytes).toEqual(plain);
    expect(without.report.size.ktx2Count).toBe(0);
    expect(without.bytes.length).toBe(r.prepared.sizes.noKtx2.totalBytes);
  });

  it('a throwing encoder and an invalid output are REPORTED, never fatal', async () => {
    setStore(graph());
    let n = 0;
    const flaky = stubEncoder(async () => {
      n++;
      if (n === 1) throw new Error('boom');
      return new Uint8Array([1, 2, 3, 4]); // not a KTX2 file
    });
    setKtx2Encoder(flaky);
    const r = await prepareSingleGlb({ ktx2: { encoder: flaky } });
    if (!r.ok) throw new Error('refused');
    expect(r.prepared.ktx2Written).toBe(0);
    expect(r.prepared.ktx2Skipped.map((s) => s.reason)).toEqual(['encode-failed', 'invalid:not-ktx2']);
    // …and the export is exactly the file without copies.
    expect(r.prepared.build('fallback').bytes).toEqual((await prepared()).build('fallback').bytes);
  });

  it('a texture whose pixels cannot be read is skipped, and never asked of the encoder', async () => {
    setStore(graph());
    __setKtx2PixelReaderForTests(async () => null);
    const r = await prepareSingleGlb({ ktx2: { encoder: okEncoder } });
    if (!r.ok) throw new Error('refused');
    expect(encodes).toEqual([]);
    expect(r.prepared.ktx2Skipped).toHaveLength(2);
  });

  it('refuses an over-cap texture by its DECLARED size, WITHOUT decoding it', async () => {
    // `values.width`/`height` come out of a `.fastshader` and reach 8192 with
    // no restore path validating them. `encodeKtx2Checked` refuses this size
    // too — but only after the whole bitmap is RGBA8 in memory (~0.75 GB at
    // 8192², retained for the rest of the loop), so the gate must run first.
    const g = graph();
    const t = g.nodes.find((n) => n.id === 'T') as { data: { values: Record<string, unknown> } };
    Object.assign(t.data.values, { width: 8192, height: 8192 });
    setStore(g);
    const reads: [number, number][] = [];
    __setKtx2PixelReaderForTests(async (_src, w, h) => {
      reads.push([w, h]);
      return PX;
    });
    const r = await prepareSingleGlb({ ktx2: { encoder: okEncoder } });
    if (!r.ok) throw new Error('refused');
    expect(r.prepared.ktx2Skipped.map((s) => s.reason)).toContain('too-large');
    // Only the other texture is decoded, and the reader is told the size it
    // must hold the bitmap to.
    expect(reads).toEqual([[4, 4]]);
    expect(encodes).toHaveLength(1);
  });

  it('the pixel reader keeps its three decode options and refuses a bitmap of another size', () => {
    // DOM-only, so no node suite imports it: the module is source-pinned here.
    const text = readFileSync(path.join(__dirname, '..', 'utils', 'ktx2Pixels.ts'), 'utf8');
    // The FUNCTION, never the header comment above it — which names the same
    // three options in prose, so a whole-file `toContain` would pass with the
    // code deleted.
    const at = text.indexOf('export async function payloadToRgba');
    expect(at, 'payloadToRgba was renamed').toBeGreaterThan(-1);
    const body = text.slice(at);
    // The whole point of the module — a normal or data map must not be
    // re-interpreted on its way to RGBA8.
    expect(body).toContain("imageOrientation: 'none'");
    expect(body).toContain("premultiplyAlpha: 'none'");
    expect(body).toContain("colorSpaceConversion: 'none'");
    expect(body).toContain('willReadFrequently: true');
    // And the bound: a payload free to lie about its dimensions is refused
    // before getImageData, as `encodeGlbFallback` refuses one.
    expect(body).toMatch(/bitmap\.width !== width \|\| bitmap\.height !== height/);
  });

  it('reports progress per texture, and an abort mid-encode resolves as aborted', async () => {
    setStore(graph());
    const seen: [number, number][] = [];
    const ok1 = await prepareSingleGlb({
      ktx2: { encoder: okEncoder, onProgress: (done, total) => seen.push([done, total]) },
    });
    expect(ok1.ok).toBe(true);
    // Every texture is counted, written or skipped.
    expect(seen).toEqual([[1, 2], [2, 2]]);

    const ac = new AbortController();
    const aborting = stubEncoder(async () => {
      ac.abort();
      return KTX2;
    });
    const r = await prepareSingleGlb({ signal: ac.signal, ktx2: { encoder: aborting } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('aborted');
  });

  it('the pixel seam is never called outside a test', () => {
    const root = path.join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) {
          const text = readFileSync(full, 'utf8');
          if (text.includes('__setKtx2PixelReaderForTests(') && !full.endsWith(path.join('engine', 'exportSingleGlb.ts'))) {
            offenders.push(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

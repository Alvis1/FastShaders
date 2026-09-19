/**
 * The payload DROP (`dropFastShadersPayload`) and the Phase 5 strip's Phase 7
 * amendment (`fsPayloadViews` join the dead-view candidates; a payload-only
 * plan is non-null; 'kept' mode zeroes). One output is re-parsed by the REAL
 * r184 GLTFLoader, so `self`, `createImageBitmap` and `ProgressEvent` are
 * stubbed per test and undone in afterEach (`isolate: false`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Material, Mesh } from 'three';
import { GLTF_NODE_GLOBALS, parseWith } from '../gltfTestFixtures';
import { embedProjectState, type FastShadersProject } from '@/engine/fastShadersProject';
import { FS_PROJECT_BEGIN, hasFsExtras } from '@/engine/glbShaderContract';
import { decodeDataUri, encodeDataUri, parseGlbContainer } from './glbContainer';
import { readGltfModel } from './gltfReader';
import { planTextureStrip, stripGltfTextures } from './gltfStrip';
import { modelSignatureMatches } from '@/engine/materialPartsContract';
import { safeJsonReviver } from './safeJson';
import { FS_JSON_SNIFF, dropFastShadersPayload, readGlbFsExtras } from './glbShaderExtras';
import {
  FS_FIXTURE_MODULE,
  FS_FIXTURE_MODULE_MARKER,
  TRIANGLE_POSITIONS,
  makeFastShadersGlb,
  makeFastShadersGlbEscapedKey,
  makeFastShadersGltfJson,
  makeRealPng,
  repackBaseGlb,
  type FsGlbFixture,
} from '@/test-utils';

const PNG = makeRealPng(2, 2, [1, 2, 3, 255]);
const PROJECT = embedProjectState('', { version: 1, shaderName: 's', graph: { nodes: [], edges: [] }, preview: {}, ui: {} } as unknown as FastShadersProject).trim();
const TEXT = (b: Uint8Array) => new TextDecoder().decode(b);

const PAYLOAD_FIXTURE: FsGlbFixture = {
  project: PROJECT,
  assets: { 'p-00000000': { mime: 'image/png', bytes: PNG } },
  sceneExtras: { fastshaders: { v: 1, shader: true }, note: 'x' },
  json: (d) => { (d.extras as Record<string, unknown>).keep = 1; },
};
const payloadGlb = (o: FsGlbFixture = {}) => makeFastShadersGlb({ ...PAYLOAD_FIXTURE, ...o });

function docOf(bytes: Uint8Array): Record<string, unknown> {
  const c = parseGlbContainer(bytes);
  if (!c.ok) throw new Error('container: ' + c.error);
  return JSON.parse(c.chunks.json, safeJsonReviver) as Record<string, unknown>;
}
function binOf(bytes: Uint8Array): Uint8Array {
  const c = parseGlbContainer(bytes);
  if (!c.ok || !c.chunks.bin) throw new Error('no BIN');
  return c.chunks.bin;
}
/** The DECODED bytes of a `data:` buffer — the module in one is base64, so the
 *  raw-text assertions the BIN cases use would pass vacuously over it. */
function dataBufferOf(bytes: Uint8Array, index: number): Uint8Array {
  const def = (docOf(bytes).buffers as Array<{ uri?: unknown }>)[index];
  const d = decodeDataUri(String(def.uri), 'buffer', 1 << 24);
  if (!d.ok) throw new Error(`buffers[${index}]: ${d.error}`);
  return d.bytes;
}
const dropped = (kind: 'obj' | 'glb' | 'gltf', bytes: Uint8Array<ArrayBuffer>) => {
  const r = dropFastShadersPayload(kind, bytes);
  if (!r.ok) throw new Error('drop refused');
  return r;
};

describe('dropFastShadersPayload', () => {
  it('no payload → the SAME reference (a plain model, an OBJ, the sniff only in a name)', () => {
    const plain = repackBaseGlb({ materials: ['A'] });
    expect(dropFastShadersPayload('glb', plain)).toEqual({ ok: true, bytes: plain, dropped: false });
    expect(dropped('glb', plain).bytes).toBe(plain);
    const obj = new TextEncoder().encode('v 0 0 0\n# "fastshaders"') as Uint8Array<ArrayBuffer>;
    expect(dropped('obj', obj).bytes).toBe(obj);
    const named = makeFastShadersGlb({ materials: ['fastshaders'], omitExtras: true, omitSceneExtras: true });
    expect(dropped('glb', named).bytes).toBe(named);
    const gltf = new TextEncoder().encode(makeFastShadersGltfJson({ omitExtras: true, omitSceneExtras: true, materials: ['fastshaders'] })) as Uint8Array<ArrayBuffer>;
    expect(dropped('gltf', gltf).bytes).toBe(gltf);
  });

  it('with a payload: extras gone, bytes zeroed, everything else byte-identical, same length', () => {
    const input = payloadGlb();
    const r = dropped('glb', input);
    expect(r.dropped).toBe(true);
    expect(r.bytes).not.toBe(input);
    expect(r.bytes.length).toBe(input.length);
    const doc = docOf(r.bytes);
    expect(hasFsExtras(doc)).toBe(false);
    expect(TEXT(r.bytes)).not.toContain('fastshaders');
    expect(doc.extras).toEqual({ keep: 1 });
    expect((doc.scenes as Array<{ extras: unknown }>)[0].extras).toEqual({ note: 'x' });
    // The default layout: 0 triangle, 1 PNG, 2 module, 3 project.
    const inBin = binOf(input);
    const outBin = binOf(r.bytes);
    expect(outBin.length).toBe(inBin.length);
    const views = docOf(input).bufferViews as Array<{ byteOffset: number; byteLength: number }>;
    for (const v of [2, 3]) {
      const { byteOffset, byteLength } = views[v];
      expect(outBin.subarray(byteOffset, byteOffset + byteLength).every((b) => b === 0), `view ${v}`).toBe(true);
    }
    expect(TEXT(r.bytes)).not.toContain(FS_FIXTURE_MODULE_MARKER);
    expect(TEXT(r.bytes)).not.toContain(FS_PROJECT_BEGIN);
    expect([...outBin.subarray(0, 36)]).toEqual([...TRIANGLE_POSITIONS]);
    expect([...outBin.subarray(views[1].byteOffset, views[1].byteOffset + views[1].byteLength)]).toEqual([...PNG]);
    expect(doc.bufferViews).toEqual(docOf(input).bufferViews);
    expect(readGlbFsExtras(r.bytes).state).toBe('none');
    // The image the asset named is still a bufferView image (the drop is not the strip).
    expect((doc.images as Array<{ bufferView: number }>)[0].bufferView).toBe(1);
  });

  it('a payload view an accessor also reads is NOT zeroed', () => {
    const input = payloadGlb({
      json: (d) => { (d.accessors as unknown[]).push({ bufferView: 2, componentType: 5121, count: 1, type: 'SCALAR' }); },
    });
    const r = dropped('glb', input);
    expect(hasFsExtras(docOf(r.bytes))).toBe(false);
    expect(TEXT(r.bytes)).toContain(FS_FIXTURE_MODULE_MARKER); // view 2 kept: it is real data
    expect(TEXT(r.bytes)).not.toContain(FS_PROJECT_BEGIN); // view 3 zeroed
  });

  it('a payload in a data: BUFFER is zeroed too, not only one in the BIN', () => {
    // buffers[0] is the BIN (triangle, PNG, project); buffers[1] a `data:`
    // buffer holding the module followed by eight bytes of something else, so
    // the test can tell "the range was zeroed" from "the buffer was wiped".
    // The reader REFUSES such a file (a module view must be on the BIN), which
    // is exactly why the drop may not lean on it: `extras` going is not enough
    // — the bytes ride the IndexedDB mirror, the XR blob at the app's REAL
    // origin and every zip `models/` entry (integration §5 layer L1).
    const TAIL = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
    const moduleBytes = new TextEncoder().encode(FS_FIXTURE_MODULE);
    const input = payloadGlb({
      moduleBuffer: 'data-uri',
      json: (d) => {
        const whole = new Uint8Array(moduleBytes.length + TAIL.length);
        whole.set(moduleBytes);
        whole.set(TAIL, moduleBytes.length);
        (d.buffers as Record<string, unknown>[])[1] = {
          byteLength: whole.length,
          uri: encodeDataUri('application/octet-stream', whole),
        };
      },
    });
    expect(readGlbFsExtras(input)).toEqual({ state: 'refused', reason: 'damaged' });
    const before = dataBufferOf(input, 1);
    expect(TEXT(before)).toContain(FS_FIXTURE_MODULE_MARKER); // not vacuous: it really is in buffer 1
    const r = dropped('glb', input);
    expect(r.dropped).toBe(true);
    const after = dataBufferOf(r.bytes, 1);
    expect(after.length).toBe(before.length);
    expect(TEXT(after)).not.toContain(FS_FIXTURE_MODULE_MARKER);
    expect(after.subarray(0, moduleBytes.length).every((b) => b === 0)).toBe(true);
    expect([...after.subarray(moduleBytes.length)]).toEqual([...TAIL]); // only the view's own range
    // The BIN half is unchanged by the second buffer: the project is zeroed,
    // the triangle and the asset PNG stand, and the file keeps its length
    // (the re-encoded URI keeps its media type, so the JSON keeps its width).
    expect(TEXT(r.bytes)).not.toContain(FS_PROJECT_BEGIN);
    expect([...binOf(r.bytes).subarray(0, 36)]).toEqual([...TRIANGLE_POSITIONS]);
    expect(r.bytes.length).toBe(input.length);
    expect(hasFsExtras(docOf(r.bytes))).toBe(false);
    expect(docOf(r.bytes).bufferViews).toEqual(docOf(input).bufferViews);
  });

  it('an ESCAPED key is not invisible: read and drop answer it as they answer the literal one', () => {
    // The adversary: `"fastshaders"` for `"fastshaders"` in BOTH places
    // the key appears (root extras and the scene marker — escaping only one
    // leaves the literal sniff alive on the other). JSON.parse yields the
    // very same document, so a gate that tests the literal spelling alone
    // hands a stranger's module on to every preview copy (integration §5 L1).
    const escaped = makeFastShadersGlbEscapedKey(PAYLOAD_FIXTURE);
    expect(TEXT(escaped)).not.toContain(FS_JSON_SNIFF);
    expect(hasFsExtras(docOf(escaped))).toBe(true);
    expect(readGlbFsExtras(escaped).state).toBe(readGlbFsExtras(payloadGlb()).state);
    expect(readGlbFsExtras(escaped).state).toBe('ok');
    const r = dropped('glb', escaped);
    expect(r.dropped).toBe(true);
    expect(TEXT(r.bytes)).not.toContain(FS_FIXTURE_MODULE_MARKER);
    expect(TEXT(r.bytes)).not.toContain(FS_PROJECT_BEGIN);
    expect(TEXT(r.bytes)).not.toContain('fastshaders');
    expect(hasFsExtras(docOf(r.bytes))).toBe(false);
    expect(readGlbFsExtras(r.bytes).state).toBe('none');
  });

  it('a sniff hit with a broken container or broken JSON → { ok: false } (fail closed)', () => {
    const broken = payloadGlb().slice();
    new DataView(broken.buffer).setUint32(8, 20, true);
    expect(dropFastShadersPayload('glb', broken)).toEqual({ ok: false });
    const badJson = payloadGlb().slice();
    badJson[20] = 0x5d;
    expect(dropFastShadersPayload('glb', badJson)).toEqual({ ok: false });
    expect(dropFastShadersPayload('gltf', new TextEncoder().encode('{"extras":{"fastshaders"') as Uint8Array<ArrayBuffer>)).toEqual({ ok: false });
  });

  it('.gltf: the extras go and the data: buffer\'s payload bytes are zeroed; the model still reads', () => {
    const input = new TextEncoder().encode(makeFastShadersGltfJson({ project: PROJECT })) as Uint8Array<ArrayBuffer>;
    const r = dropped('gltf', input);
    expect(r.dropped).toBe(true);
    const text = TEXT(r.bytes);
    expect(text).not.toContain('fastshaders');
    const again = readGltfModel(r.bytes, 'gltf');
    expect(again.ok).toBe(true);
    if (again.ok) {
      const buf = again.model.source.buffers[0] as Uint8Array;
      expect([...buf.subarray(0, 36)]).toEqual([...TRIANGLE_POSITIONS]);
      expect(buf.subarray(36).every((b) => b === 0)).toBe(true);
      expect(again.model.signature.materials).toEqual(['Body', 'Glass']);
    }
  });

  describe('the output in the REAL r184 GLTFLoader', () => {
    beforeEach(() => {
      for (const [k, v] of Object.entries(GLTF_NODE_GLOBALS)) vi.stubGlobal(k, v);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('re-parses with the same materials', async () => {
      const input = payloadGlb({ materials: ['Body', 'Ķermenis'] });
      const r = dropped('glb', input);
      const names = async (bytes: Uint8Array<ArrayBuffer>) => {
        const gltf = await parseWith([], bytes.buffer);
        const out: string[] = [];
        gltf.scene.traverse((o) => {
          const m = (o as Mesh).material as Material | undefined;
          if ((o as Mesh).isMesh && m) out.push(m.name);
        });
        return out.sort();
      };
      expect(await names(r.bytes)).toEqual(await names(input));
      expect(await names(r.bytes)).toEqual(['Body', 'Ķermenis']);
    });
  });
});

describe('the strip amendment (utils/gltfStrip.ts)', () => {
  const read = (bytes: Uint8Array, kind: 'glb' | 'gltf' = 'glb') => {
    const r = readGltfModel(bytes, kind);
    if (!r.ok) throw new Error('reader refused: ' + JSON.stringify(r.refusal));
    return r.model;
  };

  it('a payload-only plan is non-null: no materials, the payload views dead, compacted', () => {
    const m = read(payloadGlb());
    const plan = planTextureStrip(m, []);
    expect(plan).not.toBeNull();
    expect(plan!.materials).toEqual([]);
    expect(plan!.deadTextures).toEqual([]);
    // The asset image no texture reads is an orphan: dead too, as for any model.
    expect(plan!.deadImages).toEqual([0]);
    expect(plan!.deadViews).toEqual([1, 2, 3]);
    expect(plan!.mode).toBe('compacted');
  });

  it('a plain model with nothing to strip is still null (Phase 5 unchanged)', () => {
    expect(planTextureStrip(read(repackBaseGlb({ materials: ['A', 'B'] })), [])).toBeNull();
    expect(planTextureStrip(read(repackBaseGlb({ materials: ['A', 'B'], textured: true })), [])).toBeNull();
  });

  it('compacted: the payload bytes are reclaimed, the copy re-reads with the same signature and no payload', () => {
    const input = payloadGlb();
    const m = read(input);
    const plan = planTextureStrip(m, [])!;
    const out = stripGltfTextures(m, plan);
    expect(out.kind).toBe('glb');
    // Only the triangle survives in the BIN: the module, the project and the
    // asset-only image (an orphan once nothing textures it) are reclaimed —
    // to the 4-byte residue Phase 5's hole punching leaves at each range end.
    const inBin = binOf(input);
    const outBin = binOf(out.bytes);
    expect(outBin.length).toBeGreaterThanOrEqual(36);
    expect(outBin.length).toBeLessThanOrEqual(36 + 3 * 4);
    expect(inBin.length - outBin.length).toBeGreaterThan(PNG.length);
    expect([...outBin.subarray(0, 36)]).toEqual([...TRIANGLE_POSITIONS]);
    expect(Math.abs(out.bytes.length - plan.estimatedBytes)).toBeLessThan(256);
    const again = read(out.bytes);
    expect(modelSignatureMatches(again.signature, m.signature)).toBe(true);
    expect(readGlbFsExtras(out.bytes).state).toBe('none');
    expect(hasFsExtras(docOf(out.bytes))).toBe(false);
    expect(TEXT(out.bytes)).not.toContain(FS_FIXTURE_MODULE_MARKER);
    expect(TEXT(out.bytes)).not.toContain(FS_PROJECT_BEGIN);
    // The dead views became one-byte views and the orphan image the placeholder.
    const doc = docOf(out.bytes);
    for (const v of [1, 2, 3]) expect((doc.bufferViews as unknown[])[v]).toEqual({ buffer: 0, byteOffset: 0, byteLength: 1 });
    expect((doc.images as Array<{ uri?: string }>)[0].uri).toMatch(/^data:image\/png;base64,/);
    expect(doc.extras).toEqual({ keep: 1 });
    expect((doc.scenes as Array<{ extras: unknown }>)[0].extras).toEqual({ note: 'x' });
  });

  it('a buffer carrying an unknown extension → kept mode, the payload ZEROED in place', () => {
    const input = payloadGlb({
      json: (d) => {
        (d.buffers as Record<string, unknown>[])[0].extensions = { EXT_bar: {} };
        d.extensionsUsed = ['EXT_bar'];
      },
    });
    const m = read(input);
    const plan = planTextureStrip(m, [])!;
    expect(plan.mode).toBe('kept');
    expect(plan.deadViews).toEqual([1, 2, 3]);
    const out = stripGltfTextures(m, plan);
    const inBin = binOf(input);
    const outBin = binOf(out.bytes);
    expect(outBin.length).toBe(inBin.length);
    const views = docOf(input).bufferViews as Array<{ byteOffset: number; byteLength: number }>;
    for (const v of [2, 3]) {
      const { byteOffset, byteLength } = views[v];
      expect(outBin.subarray(byteOffset, byteOffset + byteLength).every((b) => b === 0), `view ${v}`).toBe(true);
    }
    // Everything before the module — the triangle AND the orphan image's bytes
    // (kept mode leaves image views be, as Phase 5 specifies) — is byte-identical.
    expect([...outBin.subarray(0, views[2].byteOffset)]).toEqual([...inBin.subarray(0, views[2].byteOffset)]);
    expect(docOf(out.bytes).bufferViews).toEqual(docOf(input).bufferViews);
    expect(TEXT(out.bytes)).not.toContain(FS_FIXTURE_MODULE_MARKER);
    expect(readGlbFsExtras(out.bytes).state).toBe('none');
    expect(modelSignatureMatches(read(out.bytes).signature, m.signature)).toBe(true);
  });

  it('a payload view an accessor also reads survives the subtraction (its bytes stay)', () => {
    const input = payloadGlb({
      json: (d) => { (d.accessors as unknown[]).push({ bufferView: 2, componentType: 5121, count: 1, type: 'SCALAR' }); },
    });
    const m = read(input);
    const plan = planTextureStrip(m, [])!;
    expect(plan.deadViews).toEqual([1, 3]);
    const out = stripGltfTextures(m, plan);
    expect(TEXT(out.bytes)).toContain(FS_FIXTURE_MODULE_MARKER);
    expect(TEXT(out.bytes)).not.toContain(FS_PROJECT_BEGIN);
    expect(hasFsExtras(docOf(out.bytes))).toBe(false);
  });

  it('.gltf: a payload-only plan re-encodes the data: buffer without the payload', () => {
    const input = new TextEncoder().encode(makeFastShadersGltfJson({ project: PROJECT }));
    const m = read(input, 'gltf');
    const plan = planTextureStrip(m, [])!;
    expect(plan.deadViews).toEqual([1, 2]);
    const out = stripGltfTextures(m, plan);
    expect(out.kind).toBe('gltf');
    const again = read(out.bytes, 'gltf');
    const buf = again.source.buffers[0] as Uint8Array;
    expect(buf.length).toBeGreaterThanOrEqual(36);
    expect(buf.length).toBeLessThanOrEqual(36 + 2 * 4);
    expect(buf.length).toBeLessThan((m.source.buffers[0] as Uint8Array).length);
    expect(TEXT(out.bytes)).not.toContain('fastshaders');
    expect(TEXT(out.bytes)).not.toContain(FS_FIXTURE_MODULE_MARKER);
  });
});

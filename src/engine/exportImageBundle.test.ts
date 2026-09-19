/**
 * The export bundle's IMAGE bytes, pinned before the Phase 2 de-duplication.
 *
 * Today an image rides three times in an export: inlined in the module, once
 * per node in the FASTSHADERS_PROJECT_V1 block, and as a file under images/.
 * Phase 2 may shrink images/ (one file per DISTINCT image) and the module, but
 * a graph WITHOUT duplicate images must keep exporting the byte-identical zip,
 * and the project block must keep every node's full `imageB64`: FastShaders
 * 0.3.33 and older read pixels from nowhere else, so a block that drops one
 * opens there with that image black and no notice.
 *
 * The digests below were written at the Phase 1 state. A later change must NOT
 * rewrite them: every fixture holds DISTINCT payloads only, so no
 * de-duplication rule has anything to act on here.
 *
 * `isolate: false`: the store is shared with the worker, so each test sets
 * the state it reads, and `localStorage` is stubbed ABSENT (buildProjectState
 * reads its preview prefs from it) and restored afterwards.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { makeEdge, makeNode } from '@/test-utils';
import { getNodeValues, type AppNode } from '@/types';
import { collectImageFiles } from '@/utils/imageNode';
import { buildExportBundle, type ExportMesh } from '@/utils/exportBundle';
import { readZip } from '@/utils/zipReader';
import { planExportPreflight } from '@/utils/exportPreflight';
import { buildProjectState, buildShaderBundle } from './exportShader';
import { embedProjectState, extractProjectState } from './fastShadersProject';
import { graphToCode } from './graphToCode';
import { imageAssetFor } from './imageAssets';
import { referenceImagesInModule } from './projectImageRefs';

const enc = new TextEncoder();
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

const SCRIPT = 'export default function () { return 1; }\n';
const PNG_A = 'data:image/png;base64,AAAA';
const PNG_B = 'data:image/png;base64,AAAB';
const WEBP_C = 'data:image/webp;base64,AAAC';
const OBJ_MESH: ExportMesh = {
  name: 'rock.obj',
  kind: 'obj',
  bytes: enc.encode('v 0 0 0') as Uint8Array<ArrayBuffer>,
};

function image(id: string, imageB64: string, fileName = 'tex.png'): AppNode {
  return makeNode(id, 'imageNode', { imageB64, width: 1, height: 1, fileName, colorSpace: 'color' });
}

const bundle = (nodes: AppNode[], mesh: ExportMesh | null = null) =>
  buildExportBundle('s', SCRIPT, collectImageFiles(nodes), mesh);
const names = async (bytes: Uint8Array) => (await readZip(bytes)).map((e) => e.name);

describe('export zips of duplicate-free image graphs are byte-stable', () => {
  it('(a) one image', async () => {
    const b = bundle([image('i1', PNG_A)]);
    expect(await names(b.bytes)).toEqual(['s.js', 'images/tex.png', 'README.txt']);
    expect(sha256(b.bytes)).toMatchInlineSnapshot(`"d82afd4bd4d356142076b5e3768967bb90f4394cd528003591119a4b1a1a3415"`);
  });

  it('(b) two DIFFERENT images with the same name — the second is `tex-2`', async () => {
    const b = bundle([image('i1', PNG_A), image('i2', PNG_B)]);
    expect(await names(b.bytes)).toEqual(['s.js', 'images/tex.png', 'images/tex-2.png', 'README.txt']);
    expect(sha256(b.bytes)).toMatchInlineSnapshot(`"b1d52023722fa187f7f6e6ffe5903b8aeb6f23835b780661c35a6ce81e2eb351"`);
  });

  it('(c) an invalid payload is skipped and does not advance the `image<n>` fallback', async () => {
    const b = bundle([image('i1', PNG_A), image('bad', ''), image('i3', PNG_B, '')]);
    expect(await names(b.bytes)).toEqual(['s.js', 'images/tex.png', 'images/image2.png', 'README.txt']);
    expect(sha256(b.bytes)).toMatchInlineSnapshot(`"d010c98f0d0543778eb61e7732d55fbaf25f4d02c5c9bfa007869779969e9d79"`);
  });

  it('(d) one image plus an OBJ mesh', async () => {
    const b = bundle([image('i1', PNG_A)], OBJ_MESH);
    expect(await names(b.bytes)).toEqual(['s.js', 'images/tex.png', 'models/rock.obj', 'README.txt']);
    expect(sha256(b.bytes)).toMatchInlineSnapshot(`"3eabdc4df1f02b14153131cc47c7dba6b1941474419a480bc50a1bc4c0959844"`);
  });
});

describe('the project block keeps one full imageB64 PER NODE (real store)', () => {
  const NODES = () => [image('i1', PNG_A), image('i2', PNG_A), image('i3', WEBP_C, 'c.webp')];

  beforeAll(() => {
    vi.stubGlobal('localStorage', undefined);
  });

  beforeEach(() => {
    cancelPendingGraphSave();
    useAppStore.setState({
      nodes: NODES(),
      edges: [],
      drawings: [],
      shaderPalettes: [],
      shaderName: 'Golden',
      selectedHeadsetId: 'quest3',
      nodeEditorBgColor: '#fafafa',
      codeEditorTheme: 'vs',
      costColorLow: '#8bc34a',
      costColorHigh: '#ff5722',
    });
  });

  afterAll(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], drawings: [], shaderPalettes: [] });
    vi.unstubAllGlobals();
  });

  it('buildProjectState().graph.nodes carries each Image node\'s full imageB64, and no imageRefs key', () => {
    const project = buildProjectState();
    expect(Object.prototype.hasOwnProperty.call(project, 'imageRefs')).toBe(false);
    const byId = new Map(project.graph.nodes.map((n) => [n.id, n]));
    for (const n of NODES()) {
      const values = getNodeValues(byId.get(n.id)!);
      expect(values.imageB64).toBe(getNodeValues(n).imageB64);
      // Storage-side references (payload de-duplication) never reach memory.
      expect(Object.prototype.hasOwnProperty.call(values, 'imageRef')).toBe(false);
    }
  });

  it('the embedded block of two identical + one different image is byte-stable', () => {
    const embedded = embedProjectState(SCRIPT, buildProjectState());
    const count = (needle: string) => embedded.split(needle).length - 1;
    expect(count(`"imageB64": "${PNG_A}"`)).toBe(2);
    expect(count(`"imageB64": "${WEBP_C}"`)).toBe(1);
    expect(sha256(embedded)).toMatchInlineSnapshot(`"a5c24c570c42f9320f16cb34c16b38e2131fea6645c374067990832e812ed427"`);
  });

  // EXPORT_IMAGE_REFS (engine/projectImageRefs.ts) is off: the real bundle
  // builder keeps every imageB64 and writes no `imageRefs` field. The code is
  // REAL generated output, so the module inlines the PNG literal and the writer
  // WOULD reference it: with `code: ''` it had nothing to act on and a bypassed
  // gate stayed green.
  it('buildShaderBundle writes every imageB64 and no imageRefs field', async () => {
    const nodes = [...NODES(), makeNode('out1', 'output')];
    const edges = [makeEdge('i1', 'out', 'out1', 'color')];
    const { code } = graphToCode(nodes, edges);
    useAppStore.setState({ nodes, edges, code, exportIncludeMesh: false });
    const b = buildShaderBundle();
    const entries = await readZip(b.bytes);
    expect(entries.map((e) => e.name)).toEqual(['golden.js', 'images/tex.png', 'images/c.webp', 'README.txt']);
    const js = new TextDecoder().decode(entries[0].data);
    const moduleText = extractProjectState(js)!.stripped;
    expect(moduleText).toContain(`"${PNG_A}"`);
    const project = buildProjectState();
    const canonical = (n: AppNode) => imageAssetFor(n.id, getNodeValues(n))?.src ?? null;
    expect(referenceImagesInModule(project, moduleText, canonical)).not.toBe(project);
    const count = (needle: string) => js.split(needle).length - 1;
    expect(count(`"imageB64": "${PNG_A}"`)).toBe(2);
    expect(count(`"imageB64": "${WEBP_C}"`)).toBe(1);
    expect(js).not.toContain('"imageRefs"');
  });
});

describe('images/ holds ONE file per distinct image (C1)', () => {
  it('4 byte-identical nodes → one entry, named after the first, holding the decoded bytes', async () => {
    const nodes = [image('i1', PNG_A, 'first.png'), image('i2', PNG_A, 'second.png'), image('i3', PNG_A), image('i4', PNG_A)];
    const entries = await readZip(bundle(nodes).bytes);
    expect(entries.map((e) => e.name)).toEqual(['s.js', 'images/first.png', 'README.txt']);
    expect(Array.from(entries[1].data)).toEqual([0, 0, 0]);
  });

  it('4 identical nodes named alike export the byte-identical zip of ONE image', () => {
    const one = bundle([image('i1', PNG_A)]);
    const four = bundle([image('i1', PNG_A), image('i2', PNG_A), image('i3', PNG_A), image('i4', PNG_A)]);
    expect(sha256(four.bytes)).toBe(sha256(one.bytes));
  });

  it('2 identical + 1 different → 2 entries; the fallback name keeps its commit-A number', async () => {
    const nodes = [image('i1', PNG_A), image('i2', PNG_A), image('i3', PNG_B, '')];
    expect(await names(bundle(nodes).bytes)).toEqual(['s.js', 'images/tex.png', 'images/image3.png', 'README.txt']);
  });

  it('the same bytes under two MIME claims are two files', async () => {
    const nodes = [image('i1', PNG_A), image('i2', 'data:image/jpeg;base64,AAAA')];
    expect(await names(bundle(nodes).bytes)).toEqual(['s.js', 'images/tex.png', 'images/tex.jpg', 'README.txt']);
  });

  it('non-canonical base64 of the same bytes is one file', async () => {
    // `AAB=` carries non-zero padding bits; it decodes to the same two bytes as `AAA=`.
    const nodes = [image('i1', 'data:image/png;base64,AAA='), image('i2', 'data:image/png;base64,AAB=', 'other.png')];
    const entries = await readZip(bundle(nodes).bytes);
    expect(entries.map((e) => e.name)).toEqual(['s.js', 'images/tex.png', 'README.txt']);
    expect(Array.from(entries[1].data)).toEqual([0, 0]);
  });

  it('equal-length, different bytes → 2 entries', () => {
    expect(collectImageFiles([image('i1', PNG_A), image('i2', PNG_B)])).toHaveLength(2);
  });

  it('size facts and the pre-flight count the de-duplicated list', async () => {
    const one = bundle([image('i1', PNG_A)]);
    const four = bundle([image('i1', PNG_A), image('i2', PNG_A), image('i3', PNG_A), image('i4', PNG_A)]);
    const sum = (await readZip(four.bytes)).reduce((s, e) => s + e.data.length, 0);
    expect(four.unpackedBytes).toBe(sum);
    expect(four.unpackedBytes).toBe(one.unpackedBytes);
    expect(planExportPreflight(four, one.unpackedBytes)).toBeNull();
    expect(planExportPreflight(four, one.unpackedBytes - 1)?.sizeBytes).toBe(one.unpackedBytes);
  });
});

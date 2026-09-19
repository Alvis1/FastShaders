import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { buildExportModule, buildShaderBundle, collectShaderProperties, EXPORT_ERROR_PREFIX } from './exportShader';
import { extractProjectState } from './fastShadersProject';
import { glbModuleHeaderLines } from './glbUsage';
import { graphToCode } from './graphToCode';
import { IMAGE_ASSET_PREFIX, IMAGE_PLACEHOLDER_RE, inlineImageAssetsFromNodes } from './imageAssets';
import { makeEdge, makeNode } from '@/test-utils';
import { readZip } from '@/utils/zipReader';

/**
 * `collectShaderProperties` is the ONE property-list implementation: the
 * Download-Shader bundle and the code panel's A-Frame tab both read it (the tab
 * used to hold a byte-for-byte hand copy, which was a live drift site — the tab
 * could have started describing a file the user never gets). These pin the four
 * fallbacks and the ordering both surfaces now inherit from it.
 */
describe('collectShaderProperties', () => {
  it('applies the documented fallbacks for empty values (shared by the A-Frame tab and the download)', () => {
    const nodes = [
      makeNode('p1', 'property_float'),
      makeNode('c1', 'property_color'),
      makeNode('f1', 'float', { value: 2 }), // not a property node — ignored
    ];
    expect(collectShaderProperties(nodes)).toEqual([
      { name: 'property1', type: 'float', defaultValue: 1 },
      { name: 'color1', type: 'color', defaultValue: '#ff0000' },
    ]);
  });

  it('keeps nodes-array order', () => {
    // Order is load-bearing downstream: buildShaderModule's duplicate-name
    // disambiguation and buildHeader's dedupe both walk this list in order, so
    // two same-named properties resolve by position.
    const nodes = [
      makeNode('c1', 'property_color', { name: 'tint', hex: '#00ff00' }),
      makeNode('p1', 'property_float', { name: 'speed', value: 0.25 }),
    ];
    expect(collectShaderProperties(nodes).map((p) => p.name)).toEqual(['tint', 'speed']);
  });
});

/**
 * `buildExportModule` is the ONE module builder: the `.js` download inlines
 * the image payloads (what buildShaderBundle embeds, byte for byte), the
 * single-GLB export keeps the `fs-asset:` placeholders and adds the GLB
 * usage header. `isolate: false`: the store is shared, so the state is set
 * per test and `localStorage` is stubbed absent (buildProjectState reads it).
 */
describe('buildExportModule (real store)', () => {
  const PNG = 'data:image/png;base64,AAAA';
  const nodes = () => [
    makeNode('i1', 'imageNode', { imageB64: PNG, width: 1, height: 1, fileName: 'tex.png', colorSpace: 'color' }),
    makeNode('out1', 'output'),
  ];
  const edges = () => [makeEdge('i1', 'out', 'out1', 'color')];

  beforeAll(() => {
    vi.stubGlobal('localStorage', undefined);
  });
  beforeEach(() => {
    cancelPendingGraphSave();
    const ns = nodes();
    const es = edges();
    const { code } = graphToCode(ns, es);
    useAppStore.setState({ nodes: ns, edges: es, code, drawings: [], shaderPalettes: [], shaderName: 'Golden', exportIncludeMesh: false, previewMesh: null });
  });
  afterAll(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], code: '', drawings: [], shaderPalettes: [] });
    vi.unstubAllGlobals();
  });

  it('inlineImages: true is what buildShaderBundle embeds; false keeps the placeholders and nothing else differs', async () => {
    const inlined = buildExportModule({ inlineImages: true });
    const kept = buildExportModule({ inlineImages: false });
    expect(inlined).toContain(`"${PNG}"`);
    expect(inlined).not.toContain(IMAGE_ASSET_PREFIX);
    expect(kept).not.toContain('data:image/');
    const keys = [...kept.matchAll(IMAGE_PLACEHOLDER_RE)].map((m) => m[1]);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^i1-[0-9a-f]{8}$/);
    // The BODIES differ only at the literal: inlining the kept module gives
    // the inlined one. The HEADER differs by exactly the CSP note, which keys
    // on `data:` literals in the module text — right for a GLB, whose images
    // arrive as blob: URLs from the file, never as data: URLs.
    const body = (s: string) => s.split('\n').filter((l) => !l.startsWith('//')).join('\n');
    expect(body(inlineImageAssetsFromNodes(kept, useAppStore.getState().nodes))).toBe(body(inlined));
    const header = (s: string) => s.split('\n').filter((l) => l.startsWith('//'));
    expect(header(inlined).filter((l) => !header(kept).includes(l))).toEqual([
      '// This shader embeds image texture(s) as data: URLs. If the host page sets a',
      '// Content-Security-Policy, its img-src directive must allow data:.',
    ]);
    // An image graph exports a zip; its `.js` entry embeds exactly the inlined module.
    const entries = await readZip(buildShaderBundle().bytes);
    expect(entries[0].name).toBe('golden.js');
    const js = new TextDecoder().decode(entries[0].data);
    expect(extractProjectState(js)!.stripped).toBe(inlined);
    expect(js.startsWith(inlined)).toBe(true);
  });

  it('glbFile adds the GLB usage header above the plain-three block, and only that', () => {
    const kept = buildExportModule({ inlineImages: false });
    const glb = buildExportModule({ inlineImages: false, glbFile: 'golden.glb' });
    const block = glbModuleHeaderLines('golden.glb').join('\n');
    expect(glb).toContain(block);
    expect(kept).not.toContain(block);
    expect(glb.replace(`${block}\n//\n`, '')).toBe(kept);
    expect(glb).not.toContain('data:image/');
  });

  it('a module that cannot be built is the EXPORT_ERROR_PREFIX line (the composer refuses it by prefix)', () => {
    expect(EXPORT_ERROR_PREFIX).toBe('// Export error:');
    expect(buildExportModule({ inlineImages: true }).startsWith(EXPORT_ERROR_PREFIX)).toBe(false);
  });
});

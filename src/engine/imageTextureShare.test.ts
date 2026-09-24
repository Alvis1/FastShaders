import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { graphToCode } from '@/engine/graphToCode';
import { codeToGraph } from '@/engine/codeToGraph';
import { inlineImageAssetsFromNodes } from '@/engine/imageAssets';
import { buildShaderModule } from '@/engine/tslCodeProcessor';
import { computeReachableCost, getCost } from '@/utils/nodeCost';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';
import { projectDocs } from '../projectDocs';

/**
 * Image nodes holding the same payload share ONE texture (engine/imageTexturePlan.ts).
 * These pins are about the emitted module as a whole: how many objects it
 * builds, which variables the samples read, what the inline surfaces expand,
 * and that the code still changes whenever an image's bytes do.
 */

const A = 'data:image/webp;base64,' + btoa('abc');
const B = 'data:image/png;base64,' + btoa('xyz');
// 2048 px so the price is the full Image entry (2 px prices at the x0.5 floor).
const base: Record<string, string | number> = {
  imageB64: A,
  width: 2048,
  height: 2048,
  fileName: 'x.webp',
  colorSpace: 'color',
};
const img = (id: string, extra: Record<string, string | number> = {}) =>
  makeNode(id, 'imageNode', { ...base, ...extra });
const out = () => makeNode('out1', 'output');
const count = (s: string, needle: string) => s.split(needle).length - 1;

function twoThroughMul(a: Record<string, string | number> = {}, b: Record<string, string | number> = {}) {
  const nodes = [img('imgA', a), img('imgB', b), makeNode('m1', 'mul'), out()];
  const edges = [
    makeEdge('imgA', 'out', 'm1', 'a'),
    makeEdge('imgB', 'out', 'm1', 'b'),
    makeEdge('m1', 'out', 'out1', 'color'),
  ];
  return { nodes, edges };
}

describe('two Image nodes holding the same payload', () => {
  it('build one Image element and one Texture, sampled twice', () => {
    const { nodes, edges } = twoThroughMul();
    const { code } = graphToCode(nodes, edges);
    expect(count(code, 'new Image()')).toBe(1);
    expect(count(code, 'new globalThis.THREE.Texture(')).toBe(1);
    expect(count(code, 'texture(_image1_tex,')).toBe(2);
    expect(code).not.toContain('_image2_');
    expect(count(code, '"fs-asset:imgA-')).toBe(1);
    expect(code).not.toContain('fs-asset:imgB-');
  });

  it('inline to exactly one payload, with no placeholder left over', () => {
    const { nodes, edges } = twoThroughMul();
    const inlined = inlineImageAssetsFromNodes(graphToCode(nodes, edges).code, nodes);
    expect(count(inlined, 'data:image/webp;base64,')).toBe(1);
    expect(inlined).not.toContain('fs-asset:');
  });

  it('still price per node: one texture, two samples', () => {
    const { nodes, edges } = twoThroughMul();
    expect(count(graphToCode(nodes, edges).code, 'new globalThis.THREE.Texture(')).toBe(1);
    expect(computeReachableCost(nodes, edges)).toBe(2 * getCost('imageNode') + getCost('mul'));
  });

  it('share across different UVs: one texture, two uv expressions', () => {
    const { nodes, edges } = twoThroughMul({}, { tileX: 2 });
    const { code } = graphToCode(nodes, edges);
    expect(count(code, 'new globalThis.THREE.Texture(')).toBe(1);
    const uvs = [...code.matchAll(/texture\(_image1_tex, (.*)\)\.rgb;/g)].map((m) => m[1]);
    expect(uvs).toHaveLength(2);
    expect(new Set(uvs).size).toBe(2);
  });

  it('feed Environment through the shared texture', () => {
    const nodes = [img('imgA'), img('imgB'), out()];
    const edges = [makeEdge('imgA', 'out', 'out1', 'color'), makeEdge('imgB', 'out', 'out1', 'env')];
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('env: texture(_image1_tex)');
    expect(code).not.toContain('_image2_tex');
    expect(count(code, 'new globalThis.THREE.Texture(')).toBe(1);
  });

  it('hand the placeholder to the survivor when the owner is deleted', () => {
    const nodes = [img('imgB'), out()];
    const { code } = graphToCode(nodes, [makeEdge('imgB', 'out', 'out1', 'color')]);
    expect(code).toContain('"fs-asset:imgB-');
  });
});

describe('the code still changes whenever an image changes', () => {
  const emit = (a: string, b: string) => {
    const g = twoThroughMul({ imageB64: a }, { imageB64: b });
    return graphToCode(g.nodes, g.edges).code;
  };

  it('changing the sharer, the owner, or swapping the pair all change the code', () => {
    const shared = emit(A, A);
    expect(emit(A, B)).not.toBe(shared); // the sharer leaves the group
    expect(emit(B, A)).not.toBe(shared); // the owner leaves; the sharer owns now
    expect(emit(B, A)).not.toBe(emit(A, B)); // a swap is not the original
  });

  it('a sharer that leaves its group declares its own texture again', () => {
    const code = emit(A, B);
    expect(count(code, 'new globalThis.THREE.Texture(')).toBe(2);
    expect(code).toContain('"fs-asset:imgB-');
  });
});

describe('two Image nodes holding the same payload under different texture settings', () => {
  // One picture used as a colour map and as a data (normal) map: the texture
  // objects must differ, the Image element need not.
  function colorAndData(first: 'color' | 'data' = 'color') {
    const second = first === 'color' ? 'data' : 'color';
    const nodes = [img('imgA', { colorSpace: first }), img('imgB', { colorSpace: second }), out()];
    const edges = [makeEdge('imgA', 'out', 'out1', 'color'), makeEdge('imgB', 'out', 'out1', 'normal')];
    return { nodes, edges };
  }

  it('build one Image element and two Textures, the second over the first element', () => {
    const { nodes, edges } = colorAndData();
    const { code } = graphToCode(nodes, edges);
    expect(count(code, 'new Image()')).toBe(1);
    expect(count(code, 'new globalThis.THREE.Texture(')).toBe(2);
    expect(code).toContain('const _image2_tex = _image1_ok ? new globalThis.THREE.Texture(_image1_img)');
    expect(code).not.toContain('_image2_img');
    expect(code).not.toContain('_image2_ok');
    expect(count(code, '"fs-asset:')).toBe(1);
    expect(code).toContain('texture(_image2_tex,');
  });

  it('CLAUDE.md says ONE texture only when the settings match (the test above builds two)', () => {
    const doc = projectDocs();
    expect(doc).not.toContain('while the module builds them ONE texture;');
    expect(doc).toContain(
      'the module builds them ONE texture when their texture settings (colour space, filter, repeat, flipY) match, and one image element either way',
    );
  });

  it('inline to exactly one payload, with no placeholder left over', () => {
    const { nodes, edges } = colorAndData();
    const inlined = inlineImageAssetsFromNodes(graphToCode(nodes, edges).code, nodes);
    expect(count(inlined, 'data:image/webp;base64,')).toBe(1);
    expect(inlined).not.toContain('fs-asset:');
  });

  it('declare the element before the texture that reads it, in either order', () => {
    for (const first of ['color', 'data'] as const) {
      const { nodes, edges } = colorAndData(first);
      const { code } = graphToCode(nodes, edges);
      const element = code.indexOf('const _image1_img = new Image();');
      const decoded = code.indexOf('try { await _image1_img.decode(); }');
      const reader = code.indexOf('const _image2_tex = _image1_ok');
      expect(element, first).toBeGreaterThanOrEqual(0);
      expect(decoded).toBeGreaterThan(element);
      expect(reader).toBeGreaterThan(decoded);
      const module = buildShaderModule(inlineImageAssetsFromNodes(code, nodes), {});
      expect(() => parse(module, { sourceType: 'module' })).not.toThrow();
    }
  });

  it('share the element across the filter and the wrap setting too', () => {
    for (const extra of [{ filter: 'nearest' }, { repeat: 0 }] as Record<string, string | number>[]) {
      const { nodes, edges } = twoThroughMul({}, extra);
      const { code } = graphToCode(nodes, edges);
      expect(count(code, 'new Image()'), JSON.stringify(extra)).toBe(1);
      expect(count(code, 'new globalThis.THREE.Texture(')).toBe(2);
      expect(code).toContain('const _image2_tex = _image1_ok ? new globalThis.THREE.Texture(_image1_img)');
    }
  });
});

describe('an Image node planned into two march scopes', () => {
  // positionLocal -> imgA.uv makes the image position-dependent, so feeding
  // both the Field and the Density plans it into both per-step functions. It
  // used to declare its whole setup twice: a duplicate module-scope const, a
  // SyntaxError that killed the module.
  const nodes: AppNode[] = [
    makeNode('pos', 'positionLocal'),
    img('imgA'),
    makeNode('rm', 'raymarchOutput'),
  ];
  const edges = [
    makeEdge('pos', 'out', 'imgA', 'uv'),
    makeEdge('imgA', 'out', 'rm', 'field'),
    makeEdge('imgA', 'out', 'rm', 'density'),
  ];

  it('declares its setup once', () => {
    const { code } = graphToCode(nodes, edges);
    expect(count(code, 'const _image1_img = new Image();')).toBe(1);
    expect(count(code, 'const _image1_tex =')).toBe(1);
  });

  it('builds a module that parses', () => {
    const { code } = graphToCode(nodes, edges);
    const module = buildShaderModule(inlineImageAssetsFromNodes(code, nodes), {});
    expect(() => parse(module, { sourceType: 'module' })).not.toThrow();
  });
});

describe('the shared form stays inert in codeToGraph', () => {
  it('fabricates no nodes and steals no wiring', () => {
    const nodes = [img('imgA'), img('imgB'), out()];
    const edges = [makeEdge('imgA', 'out', 'out1', 'color'), makeEdge('imgB', 'out', 'out1', 'emissive')];
    const { code } = graphToCode(nodes, edges);
    expect(count(code, 'new globalThis.THREE.Texture(')).toBe(1);
    const r = codeToGraph(code);
    expect(r.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    expect(r.nodes.filter((n) => n.data.registryType !== 'output')).toEqual([]);
    expect(r.edges).toEqual([]);
  });
});

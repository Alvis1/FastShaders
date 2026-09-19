import { describe, it, expect } from 'vitest';
import { graphToCode } from '@/engine/graphToCode';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge } from '@/types';

/**
 * Image graphs, re-emitted — pinned byte for byte, beside the built-ins'.
 *
 * builtinByteStability.test.ts cannot see any of this: codeToGraph never
 * produces an Image node (they are one-way), so none of the 32 built-ins holds
 * one. This file is the image branch's standing byte check, taken BEFORE the
 * Phase 2 texture-sharing work touches it.
 *
 * WHAT MAY CHANGE, AND WHEN (review every `-u` against this list):
 *   - P2b C2 (one THREE.Texture per payload x texture spec): ONLY
 *     `two-identical` and `env-and-color-two-identical`.
 *   - P2b C3 (one Image element per payload): ONLY
 *     `same-payload-color-and-data`.
 * EVERY other key must stay byte-identical forever: a graph without two Image
 * nodes holding the same payload emits exactly what it always did, and every
 * texture setting keeps its emitted lines.
 */

const A = 'data:image/webp;base64,' + btoa('abc');
const B = 'data:image/png;base64,' + btoa('xyz');
const base: Record<string, string | number> = {
  imageB64: A,
  width: 2,
  height: 2,
  fileName: 'x.webp',
  colorSpace: 'color',
};

interface Graph { nodes: AppNode[]; edges: AppEdge[] }

const img = (id: string, extra: Record<string, string | number> = {}) =>
  makeNode(id, 'imageNode', { ...base, ...extra });
const out = () => makeNode('out1', 'output');
const mul = () => makeNode('m1', 'mul');

function shareCases(): Record<string, Graph> {
  return {
    'one-image': {
      nodes: [img('imgA'), out()],
      edges: [makeEdge('imgA', 'out', 'out1', 'color')],
    },
    'two-different': {
      nodes: [img('imgA'), img('imgB', { imageB64: B, fileName: 'y.png' }), mul(), out()],
      edges: [
        makeEdge('imgA', 'out', 'm1', 'a'),
        makeEdge('imgB', 'out', 'm1', 'b'),
        makeEdge('m1', 'out', 'out1', 'color'),
      ],
    },
    'two-identical': {
      nodes: [img('imgA'), img('imgB'), mul(), out()],
      edges: [
        makeEdge('imgA', 'out', 'm1', 'a'),
        makeEdge('imgB', 'out', 'm1', 'b'),
        makeEdge('m1', 'out', 'out1', 'color'),
      ],
    },
    'env-and-color-one-node': {
      nodes: [img('imgA'), out()],
      edges: [
        makeEdge('imgA', 'out', 'out1', 'color'),
        makeEdge('imgA', 'out', 'out1', 'env'),
      ],
    },
    'env-and-color-two-identical': {
      nodes: [img('imgA'), img('imgB'), out()],
      edges: [
        makeEdge('imgA', 'out', 'out1', 'color'),
        makeEdge('imgB', 'out', 'out1', 'env'),
      ],
    },
    'same-payload-color-and-data': {
      nodes: [img('imgA'), img('imgB', { colorSpace: 'data' }), out()],
      edges: [
        makeEdge('imgA', 'out', 'out1', 'color'),
        makeEdge('imgB', 'out', 'out1', 'normal'),
      ],
    },
    'invalid-payload-env-fallback': {
      nodes: [img('imgA', { imageB64: '' }), makeNode('c1', 'color', { hex: '#112233' }), out()],
      edges: [
        makeEdge('c1', 'out', 'out1', 'color'),
        makeEdge('imgA', 'out', 'out1', 'env'),
      ],
    },
  };
}

function single(extra: Record<string, string | number>, more: Graph = { nodes: [], edges: [] }): Graph {
  return {
    nodes: [img('imgA', extra), ...more.nodes, out()],
    edges: [...more.edges, makeEdge('imgA', 'out', 'out1', 'color')],
  };
}

function settingsCases(): Record<string, Graph> {
  const cases: Record<string, Graph> = {};
  for (const colorSpace of ['color', 'data']) {
    for (const filter of [undefined, 'nearest']) {
      for (const repeat of [undefined, 0]) {
        const extra: Record<string, string | number> = { colorSpace };
        if (filter !== undefined) extra.filter = filter;
        if (repeat !== undefined) extra.repeat = repeat;
        cases[`${colorSpace}-${filter ?? 'linear'}-${repeat === 0 ? 'clamp' : 'repeat'}`] = single(extra);
      }
    }
  }
  cases['uv-settings'] = single({ flipX: 1, flipY: 1, tileX: 2, tileY: 3, offsetX: 0.25, offsetY: 0.5 });
  cases['wired-uv'] = single({}, {
    nodes: [makeNode('v1', 'vec2', { x: 0.5, y: 0.5 })],
    edges: [makeEdge('v1', 'out', 'imgA', 'uv')],
  });
  cases['wired-dir'] = single({}, {
    nodes: [makeNode('rd1', 'rayDirection')],
    edges: [makeEdge('rd1', 'out', 'imgA', 'dir')],
  });
  return cases;
}

function emitAll(cases: Record<string, Graph>): Record<string, string> {
  const outMap: Record<string, string> = {};
  for (const [key, g] of Object.entries(cases)) outMap[key] = graphToCode(g.nodes, g.edges).code;
  return outMap;
}

describe('image graphs emit byte-identical code', () => {
  it('share cases', () => {
    expect(emitAll(shareCases())).toMatchSnapshot();
  });

  it('settings sweep', () => {
    expect(emitAll(settingsCases())).toMatchSnapshot();
  });

  it('covers every case, so one cannot be dropped with a `-u`', () => {
    expect(Object.keys(shareCases())).toEqual([
      'one-image',
      'two-different',
      'two-identical',
      'env-and-color-one-node',
      'env-and-color-two-identical',
      'same-payload-color-and-data',
      'invalid-payload-env-fallback',
    ]);
    expect(Object.keys(settingsCases())).toEqual([
      'color-linear-repeat',
      'color-linear-clamp',
      'color-nearest-repeat',
      'color-nearest-clamp',
      'data-linear-repeat',
      'data-linear-clamp',
      'data-nearest-repeat',
      'data-nearest-clamp',
      'uv-settings',
      'wired-uv',
      'wired-dir',
    ]);
  });

  it('every case really exercises what its key names', () => {
    // A snapshot pins whatever came out, including a fixture that silently
    // stopped wiring what it claims to. These are the facts each key exists for.
    const share = emitAll(shareCases());
    const count = (s: string, needle: string) => s.split(needle).length - 1;
    // The two keys P2b C2 may change are checked only for what holds before
    // AND after sharing: two samples, and an env fed by a declared texture.
    expect(count(share['two-identical'], ').rgb;')).toBe(2);
    expect(share['env-and-color-one-node']).toContain('env: texture(_image1_tex)');
    expect(share['env-and-color-two-identical']).toMatch(/env: texture\(_image\d_tex\)/);
    expect(share['same-payload-color-and-data']).toContain('normalMap(');
    expect(share['invalid-payload-env-fallback']).toContain('const image1 = vec3(0, 0, 0);');
    expect(share['invalid-payload-env-fallback']).not.toContain('_image1_tex');
    const sweep = emitAll(settingsCases());
    expect(sweep['data-linear-repeat']).toContain('generateMipmaps = false');
    expect(sweep['color-nearest-repeat']).toContain('NearestFilter');
    expect(sweep['color-linear-clamp']).toContain('ClampToEdgeWrapping');
    expect(sweep['wired-uv']).toContain('vec21');
    expect(sweep['wired-dir']).toContain('rayDirection');
  });
});

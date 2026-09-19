/**
 * The Texture (Image) node on the CPU side (GLB Phase 4 Step 2) — display only.
 *
 * The node's WHOLE vector is its rgba SAMPLE ([0,1]⁴ from `analyticalRange`,
 * which also makes it a FIELD seed), and each socket is projected out of it by
 * `handleChannels`: `out` (and null, and every tampered id) the RGB RUN [0,3),
 * Alpha/R/G/B one channel each. A plain index is not enough — EdgeInfoCard
 * sizes itself by max(rangeLen, shapeLen), so a 4-wide `out` would draw four
 * channel cards on a vec3 wire.
 *
 * No CPU VALUE is ever claimed for an image: its pixels decode asynchronously
 * in the DOM from an adversarial payload. Only the bound is honest.
 *
 * Emission is untouched by this step (graphToCode reads shapes, never ranges),
 * so the byte-stability pins stay unedited.
 */
import { describe, it, expect } from 'vitest';
import {
  handleChannels,
  handleSlice,
  evaluateEdgeSource,
  evaluateEdgeRange,
  evaluateNodeRange,
  getEdgeOutputShape,
  getFieldUpstreamSet,
} from './cpuEvaluator';
import { graphToCode } from './graphToCode';
import { edgeValueLabel } from '@/components/NodeEditor/nodes/ShaderNode';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppEdge } from '@/types';

const URL_WEBP = `data:image/webp;base64,${btoa('abc')}`;
const valid = { imageB64: URL_WEBP, width: 2, height: 2, fileName: 'x.webp', colorSpace: 'color' };

const img = () => makeNode('img1', 'imageNode', valid);
const edge = (sourceHandle: string | null): Pick<AppEdge, 'source' | 'sourceHandle'> => ({
  source: 'img1',
  sourceHandle,
});

describe('handleChannels — the Texture node\'s spans', () => {
  it('projects `out` onto the RGB run and each channel socket onto one index', () => {
    const n = img();
    expect(handleChannels(n, 'out')).toEqual({ from: 0, to: 3 });
    expect(handleChannels(n, 'r')).toBe(0);
    expect(handleChannels(n, 'g')).toBe(1);
    expect(handleChannels(n, 'b')).toBe(2);
    expect(handleChannels(n, 'alpha')).toBe(3);
  });

  it('gives a null, empty or tampered handle the RGB run — never the whole rgba', () => {
    const n = img();
    for (const h of [null, undefined, '', 'x', 'a', 'w', '__proto__', 'constructor', 'toString']) {
      expect(handleChannels(n, h), String(h)).toEqual({ from: 0, to: 3 });
    }
  });

  it('delegates every other node to handleSlice, unchanged', () => {
    const th = makeNode('th', 'toHsl');
    const sp = makeNode('sp', 'split');
    const vc = makeNode('vc', 'vertexColor');
    for (const [n, h] of [
      [th, 'h'], [th, 's'], [th, 'l'], [th, 'out'], [th, null],
      [sp, 'x'], [sp, 'w'], [sp, 'out'],
      [vc, 'out'], [undefined, 'x'],
    ] as const) {
      expect(handleChannels(n, h)).toBe(handleSlice(n, h));
    }
    expect(handleChannels(th, 's')).toBe(1);
    expect(handleChannels(vc, 'out')).toBeNull();
  });
});

describe('the Texture node\'s range — [0,1] per channel, projected per socket', () => {
  const graph = () => ({ nodes: [img(), makeNode('out1', 'output')], edges: [makeEdge('img1', 'out', 'out1', 'color')] });

  it('the node\'s whole range is the rgba sample, [0,1]⁴', () => {
    const { nodes, edges } = graph();
    expect(evaluateNodeRange('img1', nodes, edges, 0)).toEqual({ min: [0, 0, 0, 0], max: [1, 1, 1, 1] });
  });

  it('`out` (and a null or tampered handle) carries exactly three channels', () => {
    const { nodes, edges } = graph();
    for (const h of ['out', null, '__proto__', 'constructor', '']) {
      expect(evaluateEdgeRange(edge(h), nodes, edges, 0), String(h)).toEqual({
        min: [0, 0, 0],
        max: [1, 1, 1],
      });
    }
  });

  it('Alpha/R/G/B each carry one channel', () => {
    const { nodes, edges } = graph();
    for (const h of ['alpha', 'r', 'g', 'b']) {
      expect(evaluateEdgeRange(edge(h), nodes, edges, 0), h).toEqual({ min: [0], max: [1] });
    }
  });

  it('EdgeInfoCard\'s count on a Color wire is 3, not 4', () => {
    // count = min(max(rangeLen, shapeLen, 1), 4) in EdgeInfoCard.tsx.
    const { nodes, edges } = graph();
    const rangeLen = evaluateEdgeRange(edge('out'), nodes, edges, 0)?.min.length ?? 0;
    const shapeLen = getEdgeOutputShape(edge('out'), nodes, edges);
    expect(Math.max(rangeLen, shapeLen)).toBe(3);
  });

  it('claims no VALUE for any socket — the pixels are never decoded on the CPU', () => {
    const { nodes, edges } = graph();
    for (const h of ['out', 'alpha', 'r', 'g', 'b', null]) {
      expect(evaluateEdgeSource(edge(h), nodes, edges, 0), String(h)).toBeNull();
    }
  });

  it('an Image-fed label reads the bound (`0…1`), where it read `…`', () => {
    const { nodes, edges } = graph();
    expect(edgeValueLabel('img1', nodes, edges, 'out')).toEqual({ text: '0…1', live: false, animated: false });
    expect(edgeValueLabel('img1', nodes, edges, 'alpha')).toEqual({ text: '0…1', live: false, animated: false });
  });

  it('holds with an INVALID payload too — the fallback texel is opaque black, inside the bound', () => {
    const nodes = [makeNode('img1', 'imageNode', { imageB64: 'nope' }), makeNode('out1', 'output')];
    const edges = [makeEdge('img1', 'out', 'out1', 'color')];
    expect(evaluateEdgeRange(edge('alpha'), nodes, edges, 0)).toEqual({ min: [0], max: [1] });
  });
});

describe('the Texture node is a FIELD seed', () => {
  it('seeds the set, and everything downstream inherits it', () => {
    const nodes = [
      img(),
      makeNode('k', 'float', { value: 2 }),
      makeNode('m', 'mul'),
      makeNode('o', 'oneMinus'),
      makeNode('out1', 'output'),
    ];
    const edges = [
      makeEdge('img1', 'out', 'm', 'a'),
      makeEdge('k', 'out', 'm', 'b'),
      makeEdge('m', 'out', 'o', 'x'),
      makeEdge('o', 'out', 'out1', 'color'),
    ];
    const set = getFieldUpstreamSet(nodes, edges);
    expect(set.has('img1')).toBe(true);
    expect(set.has('m')).toBe(true);
    expect(set.has('o')).toBe(true);
    // A constant feeding the chain is not itself a field.
    expect(set.has('k')).toBe(false);
    // The interval path, projected through `out`'s run: [0,1]³ × 2.
    expect(evaluateNodeRange('m', nodes, edges, 0)).toEqual({ min: [0, 0, 0], max: [2, 2, 2] });
    expect(edgeValueLabel('m', nodes, edges, 'out').text).toBe('0…2');
  });

  it('a channel socket feeds a 1-channel interval downstream', () => {
    const nodes = [img(), makeNode('k', 'float', { value: 3 }), makeNode('m', 'mul')];
    const edges = [makeEdge('img1', 'alpha', 'm', 'a'), makeEdge('k', 'out', 'm', 'b')];
    expect(evaluateNodeRange('m', nodes, edges, 0)).toEqual({ min: [0], max: [3] });
  });

  it('terminates on a cycle through the node (the nodeId sentinel still holds)', () => {
    // image.alpha → mul → image.uv. A hand-edited .fastshader can reach this.
    const nodes = [img(), makeNode('m', 'mul')];
    const edges = [makeEdge('img1', 'alpha', 'm', 'a'), makeEdge('m', 'out', 'img1', 'uv')];
    expect(() => evaluateEdgeRange(edge('alpha'), nodes, edges, 0)).not.toThrow();
    expect(() => evaluateNodeRange('m', nodes, edges, 0)).not.toThrow();
    expect(() => edgeValueLabel('m', nodes, edges, 'out')).not.toThrow();
  });
});

describe('display only — emission is unmoved', () => {
  it('an out-only image still emits the vec3 `.rgb` sample and the bare variable', () => {
    const { code } = graphToCode(
      [img(), makeNode('out1', 'output')],
      [makeEdge('img1', 'out', 'out1', 'color')],
    );
    expect(code).toContain('  const image1 = texture(_image1_tex, uv().mul(vec2(-1, 1)).add(vec2(1, 0))).rgb;\n');
    expect(code).toContain('  return image1;\n');
    expect(code).not.toContain('.rgba');
    expect(code).not.toContain('vec4(');
  });
});

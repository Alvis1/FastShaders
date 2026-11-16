/**
 * The noise card's window and flat grey come from the SHADER's numbers, so the
 * card moves as the mesh moves (owner, 2026-11-16: "the noise node visual does
 * not sync with the iframe"). Before, a Time-fed card scrolled at a made-up
 * 0.4 units/s up and to the left whatever the wiring said — `Position + Time`
 * moves the mesh's noise at 1 unit/s along (1, 1, 1) — and a flat card showed
 * the 2-D stand-in's value, not the GPU's.
 */
import { describe, it, expect } from 'vitest';
import { makeEdge, makeNode } from '@/test-utils';
import { noiseWindowAt } from './noiseWindow';
import { evaluateNodeOutput } from './cpuEvaluator';
import { DEFAULT_NOISE_WINDOW } from '@/utils/noisePreview';
import { mxNoise } from '@/utils/mxNoise';

const posTime = (speed: number) => ({
  nodes: [
    makeNode('p', 'positionGeometry'),
    makeNode('t', 'time', { speed }),
    makeNode('a', 'add'),
    makeNode('n', 'perlin', { scale: 2 }),
  ],
  edges: [
    makeEdge('p', 'out', 'a', 'a'),
    makeEdge('t', 'out', 'a', 'b'),
    makeEdge('a', 'out', 'n', 'pos'),
  ],
});

describe('noiseWindowAt: the span the shader feeds the noise', () => {
  it("an unwired pos is Position's", () => {
    expect(noiseWindowAt('n', [makeNode('n', 'perlin')], [], 3)).toBe(DEFAULT_NOISE_WINDOW);
  });

  it('Position + Time slides the window with t, at the wire\'s own speed, on every axis', () => {
    const { nodes, edges } = posTime(1);
    expect(noiseWindowAt('n', nodes, edges, 0)).toEqual({ min: [-1, -1, -1], max: [1, 1, 1] });
    expect(noiseWindowAt('n', nodes, edges, 2.5)).toEqual({ min: [1.5, 1.5, 1.5], max: [3.5, 3.5, 3.5] });
    const fast = posTime(3);
    expect(noiseWindowAt('n', fast.nodes, fast.edges, 2)).toEqual({ min: [5, 5, 5], max: [7, 7, 7] });
  });

  it('Position × 3 widens it; UV is the 0…1 square', () => {
    const nodes = [makeNode('p', 'positionGeometry'), makeNode('m', 'mul', { b: 3 }), makeNode('n', 'voronoi')];
    const edges = [makeEdge('p', 'out', 'm', 'a'), makeEdge('m', 'out', 'n', 'pos')];
    expect(noiseWindowAt('n', nodes, edges, 0)).toEqual({ min: [-3, -3, -3], max: [3, 3, 3] });
    const uv = noiseWindowAt('n', [makeNode('u', 'uv'), makeNode('n', 'fbm')], [makeEdge('u', 'out', 'n', 'pos')], 0);
    expect(uv).toEqual({ min: [0, 0], max: [1, 1] });
  });
});

describe('the evaluator reads three\'s own noise', () => {
  it('Time alone into pos (a flat card) holds the GPU value at that t', () => {
    const nodes = [makeNode('t', 'time', { speed: 1 }), makeNode('n', 'perlin', { scale: 2 })];
    const edges = [makeEdge('t', 'out', 'n', 'pos')];
    for (const t of [0.37, 1.3, 7.9]) {
      // mx_noise_float(time.mul(2)): a float, converted to vec2 (2t, 2t).
      expect(evaluateNodeOutput('n', nodes, edges, t)?.[0]).toBeCloseTo(mxNoise('perlin', [2 * t])[0], 12);
    }
  });

  it('every channel of a vec3 noise of a constant is its own', () => {
    const nodes = [makeNode('c', 'vec3', { x: 0.3, y: -1.2, z: 2.6 }), makeNode('n', 'voronoiVec3')];
    const edges = [makeEdge('c', 'out', 'n', 'pos')];
    expect(evaluateNodeOutput('n', nodes, edges, 0)).toEqual(mxNoise('voronoiVec3', [0.3, -1.2, 2.6]));
  });

  it("an unsigned node's value is the remapped one", () => {
    const nodes = [makeNode('t', 'time', { speed: 1 }), makeNode('n', 'fbm', { signed: 0 })];
    const edges = [makeEdge('t', 'out', 'n', 'pos')];
    expect(evaluateNodeOutput('n', nodes, edges, 1.7)?.[0]).toBeCloseTo(mxNoise('fbm', [1.7])[0] * 0.5 + 0.5, 12);
  });
});

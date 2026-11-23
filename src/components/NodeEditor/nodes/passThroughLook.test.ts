import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AppNode } from '@/types';
import { makeEdge, makeKnot, makeNode, makeTunnelIn, makeTunnelOut } from '@/test-utils';
import {
  exitCountText,
  liveEntranceLabel,
  passThroughTypeOf,
  passThroughTypes,
  tunnelExitCount,
} from './passThroughLook';
import { KNOT_SIZE, TUNNEL_LAYOUT_H, TUNNEL_LAYOUT_W, TUNNEL_SIZE } from './passThroughGeometry';
import { rawNodeTypes } from '../flowTypes';
import { COST_SCALED_TYPES, estimateNodeSize } from '@/engine/layoutEngine';

/**
 * The Branch and Portal cards (KnotNode.tsx, TunnelNode.tsx, step 1b of the
 * feature): what they read off the store, and the guards on how they draw.
 * The vitest environment is `node`, so the DOM look is verified in the real
 * app; what is pure is pinned here.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const decomment = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the resolved TYPE colour', () => {
  it('is the source socket\'s declared type, through Branches and Portals', () => {
    const nodes = [
      makeNode('nz', 'perlin'),
      makeKnot('k1'),
      makeKnot('k2'),
      makeNode('c', 'color'),
      makeTunnelIn('in', 'c'),
      makeTunnelOut('out', 'in'),
    ];
    const edges = [
      makeEdge('nz', 'out', 'k1', 'in'),
      makeEdge('k1', 'out', 'k2', 'in'),
      makeEdge('c', 'out', 'in', 'in'),
    ];
    expect(passThroughTypeOf(nodes, edges, 'k1')).toBe('float');
    expect(passThroughTypeOf(nodes, edges, 'k2')).toBe('float');
    expect(passThroughTypeOf(nodes, edges, 'in')).toBe('color');
    // An exit reads its entrance's.
    expect(passThroughTypeOf(nodes, edges, 'out')).toBe('color');
  });

  it("falls back to the wire's inferred WIDTH where the socket says only `any`", () => {
    // Add of two vec3 noises: declared `any`, the wire carries three channels.
    const nodes = [makeNode('a', 'perlinVec3'), makeNode('b', 'perlinVec3'), makeNode('add', 'add'), makeKnot('k')];
    const edges = [makeEdge('a', 'out', 'add', 'a'), makeEdge('b', 'out', 'add', 'b'), makeEdge('add', 'out', 'k', 'in')];
    expect(passThroughTypeOf(nodes, edges, 'k')).toBe('vec3');
  });

  it('is null where nothing reaches the node: unfed, dangling, an unfed entrance, a cycle', () => {
    const nodes = [
      makeKnot('lonely'),
      makeTunnelIn('in'),
      makeTunnelOut('fromUnfed', 'in'),
      makeTunnelOut('dangling', 'gone'),
      makeTunnelOut('forged', { toString: 1 }),
      makeKnot('c1'),
      makeKnot('c2'),
    ];
    const edges = [makeEdge('c1', 'out', 'c2', 'in'), makeEdge('c2', 'out', 'c1', 'in')];
    for (const id of ['lonely', 'in', 'fromUnfed', 'dangling', 'forged', 'c1', 'c2']) {
      expect(passThroughTypeOf(nodes, edges, id), id).toBeNull();
    }
    // Not a pass-through at all: null too, never a throw.
    expect(passThroughTypeOf(nodes, edges, 'nope')).toBeNull();
  });

  it('keeps a node-borne data type only when it names a TSL type', () => {
    // A Data node's dynamicOutputs are file data: `constructor` would index
    // TYPE_COLORS' prototype and hand React a function for a colour.
    const data = (dataType: unknown): AppNode =>
      ({
        id: 'd',
        type: 'shader',
        position: { x: 0, y: 0 },
        data: { registryType: 'dataNode', label: 'd', values: {}, dynamicOutputs: [null, 7, { id: 'col0', dataType }] },
      }) as unknown as AppNode;
    const edges = [makeEdge('d', 'col0', 'k', 'in')];
    expect(passThroughTypeOf([data('vec2'), makeKnot('k')], edges, 'k')).toBe('vec2');
    for (const forged of ['constructor', '__proto__', { toString: 1 }, 5]) {
      const got = passThroughTypeOf([data(forged), makeKnot('k')], edges, 'k');
      expect(['float', 'int', 'vec2', 'vec3', 'vec4', 'color', 'any'], String(got)).toContain(got);
    }
  });

  it('is computed ONCE per graph version for every pass-through (a selector runs on every notify)', () => {
    const nodes = [makeNode('nz', 'perlin'), makeKnot('k'), makeKnot('j')];
    const edges = [makeEdge('nz', 'out', 'k', 'in'), makeEdge('k', 'out', 'j', 'in')];
    const first = passThroughTypes(nodes, edges);
    expect(passThroughTypes(nodes, edges)).toBe(first);
    // A new graph version recomputes.
    expect(passThroughTypes([...nodes], edges)).not.toBe(first);
    // The selector's answer is a PRIMITIVE, so an unchanged one re-renders nothing.
    expect(typeof passThroughTypeOf(nodes, edges, 'k')).toBe('string');
  });

  it('allocates nothing for a graph with no pass-through', () => {
    const nodes = [makeNode('nz', 'perlin')];
    expect(passThroughTypes(nodes, []).size).toBe(0);
  });
});

describe("a Portal In's exit count and a Portal Out's live name", () => {
  const nodes = [
    makeTunnelIn('in', 'perlin1'),
    makeTunnelOut('o1', 'in', 'stale'),
    makeTunnelOut('o2', 'in'),
    makeTunnelOut('o3', 'other'),
    makeTunnelIn('lonely', 'quiet'),
    makeNode('s', 'perlin'),
  ];

  it('counts the exits linked to an entrance', () => {
    expect(tunnelExitCount(nodes, 'in')).toBe(2);
    expect(tunnelExitCount(nodes, 'lonely')).toBe(0);
  });

  it("reads the entrance's CURRENT name, and null when the exit dangles", () => {
    expect(liveEntranceLabel(nodes, 'in')).toBe('perlin1');
    expect(liveEntranceLabel(nodes, 'other')).toBeNull();
    expect(liveEntranceLabel(nodes, null)).toBeNull();
    // A link to a node that is no Portal In dangles.
    expect(liveEntranceLabel(nodes, 's')).toBeNull();
    expect(liveEntranceLabel(nodes, 'o1')).toBeNull();
  });

  it('renders an adversarial name as text, never coerced', () => {
    const forged = { ...makeTunnelIn('x'), data: { registryType: 'tunnelIn', label: { toString: 1 } } } as unknown as AppNode;
    expect(liveEntranceLabel([forged], 'x')).toBe('');
  });

  it('prints →N, nothing at exactly one exit, and →0', () => {
    expect(exitCountText(1)).toBe('');
    expect(exitCountText(0)).toBe('→0');
    expect(exitCountText(3)).toBe('→3');
  });
});

describe('the cards on the canvas', () => {
  it('are registered for the canvas and the node-editor.html overview (one map)', () => {
    expect(Object.keys(rawNodeTypes)).toEqual(expect.arrayContaining(['knot', 'tunnelIn', 'tunnelOut']));
  });

  it('are never cost-scaled and carry no cost chrome', () => {
    for (const t of ['knot', 'tunnelIn', 'tunnelOut']) expect(COST_SCALED_TYPES.has(t), t).toBe(false);
    for (const f of ['./KnotNode.tsx', './TunnelNode.tsx']) {
      const src = read(f);
      expect(src, f).not.toMatch(/useCostChrome|useLiveNodeCost|<Points|cost-badge/);
      // Data is adversarial: no coercion of a stored field in render.
      expect(decomment(src), f).not.toMatch(/String\(|Number\(|data\.(label|link)\b/);
    }
  });

  it('are laid out at the size they draw', () => {
    expect(estimateNodeSize(makeKnot('k'))).toEqual({ width: KNOT_SIZE, height: KNOT_SIZE });
    for (const n of [makeTunnelIn('i'), makeTunnelOut('o', 'i')]) {
      const s = estimateNodeSize(n);
      expect(s.width).toBe(TUNNEL_LAYOUT_W);
      expect(s.height).toBe(TUNNEL_LAYOUT_H);
      expect(s.width).toBeGreaterThanOrEqual(TUNNEL_SIZE);
      expect(s.height).toBeGreaterThan(TUNNEL_SIZE);
    }
  });
});

describe('the look', () => {
  const css = decomment(read('./PassThroughNode.css'));
  const tokens = decomment(read('../../../styles/tokens.css'));

  it('declares the hole interior token in BOTH the light and the dark block', () => {
    const dark = tokens.indexOf(':root[data-theme="dark"]');
    expect(dark).toBeGreaterThan(0);
    expect(tokens.slice(0, dark)).toMatch(/--tunnel-well:/);
    expect(tokens.slice(dark)).toMatch(/--tunnel-well:/);
    expect(css).toContain('var(--tunnel-well)');
  });

  it('draws the Portal hole ROUND (the owner\'s exception) and the Branch SQUARE', () => {
    const block = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));
    expect(block('.tunnel-node__hole')).toContain('border-radius: 50%');
    expect(block('.knot-node')).toContain('border-radius: 0');
  });

  it('casts only HARD shadows: zero blur everywhere, the inset included', () => {
    for (const m of css.matchAll(/box-shadow:([^;]+);/g)) {
      for (const layer of m[1].split(/,(?![^(]*\))/)) {
        const px = layer.trim().match(/(-?\d+(?:\.\d+)?)px/g) ?? [];
        // offset-x offset-y [blur]: a third length must be 0 (written as `0`).
        expect(px.length, layer).toBeLessThanOrEqual(2);
      }
    }
    expect(css).toContain('inset 3px 3px 0');
    expect(css).toContain('inset 4px 4px 0');
  });

  it('lets the hole draw no socket dot, but keeps it pressable', () => {
    const h = css.slice(css.indexOf('.react-flow__handle.tunnel-node__handle {'));
    const rule = h.slice(0, h.indexOf('}'));
    expect(rule).toContain('background: transparent');
    expect(rule).toContain('border: none');
    expect(rule).toContain('pointer-events: all');
    expect(rule).toContain('cursor: crosshair');
  });
});

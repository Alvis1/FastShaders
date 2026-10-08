import { describe, it, expect } from 'vitest';
import type { AppEdge, AppNode } from '@/types';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { NOISE_TYPES } from '@/utils/sdfPartition';
import { helperCallPorts, helperNameFor } from './moduleHelpers';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * The consumer sweep for sources that address their OWN sockets as members of
 * ONE emitted call (Fresnel `.x`/`.y`; RGB-to-HSL `.x`/`.y`/`.z` as the
 * regression for the per-source-socket Split fix). Every input socket of every
 * def, every sink socket, the noise position and the Split: wired from each
 * source socket, the wire must survive graph → code → graph, the second
 * graph → code must be byte-identical, the counts must stay put, and the GPU
 * text must read the socket's own member. A wire that cannot survive is a
 * FAILURE unless it is listed in KNOWN_DROPS, and every entry there must leave
 * a warning in the parse — no silent drop.
 */

interface Graph { nodes: AppNode[]; edges: AppEdge[] }
interface Source { type: string; handle: string; member: string }

const SOURCES: readonly Source[] = [
  { type: 'fresnel', handle: 'out', member: 'x' },
  { type: 'fresnel', handle: 'facing', member: 'y' },
  { type: 'toHsl', handle: 's', member: 'y' },
];

/** Consumers that are ONE-WAY through codeToGraph (docs/dev/codegen.md, node-types.md): their emission is never
 *  parsed back into the node, so a wire into them cannot round-trip by design — a visible edit when a type joins. */
const ONE_WAY: ReadonlyMap<string, string> = new Map([
  ['stripes', 'dataviz family: emitted by hand, one-way through codeToGraph'],
  ['dataviz', 'dataviz family: emitted by hand, one-way through codeToGraph'],
  ['colormap', 'dataviz family: emitted by hand, one-way through codeToGraph'],
  ['dataRange', 'dataviz family: emitted by hand, one-way through codeToGraph'],
  ['isolines', 'dataviz family: emitted by hand, one-way through codeToGraph'],
  ['wireframe', 'dataviz family: emitted by hand, one-way through codeToGraph'],
  ['imageNode', 'image nodes are one-way (graphToCode imageNode branch)'],
  ['dataNode', 'the Data node is one-way (its columns are baked textures)'],
  ['soundNode', 'Sound emits plain uniforms and is one-way through codeToGraph (docs/dev/node-types.md)'],
  ['unknown', 'an unknown node round-trips its raw text, never its wires'],
]);

/** Single sockets that are one-way for EVERY source, not for these: a wired UV rotation emits the expanded
 *  rotation chain, which parses back as its own nodes (cos/sin/mul…), never as the UV node — the wire survives,
 *  into the chain, but the graph changes shape on the first Apply (a float into it does the same). */
const ONE_WAY_PORTS: ReadonlyMap<string, string> = new Map([
  ['uv.rotation', 'the rotation chain parses back as its own nodes, for any source'],
]);

/** Pairs whose wire cannot survive the code, each with the warning the parse leaves. */
const KNOWN_DROPS: ReadonlyMap<string, RegExp> = new Map([]);

/** `consumer` (id C) made LIVE: its first output wired on to an Output — Discard for a logic node, whose bool
 *  the Color channel would wrap in `float()` (a pre-existing one-way shape that has nothing to do with the source).
 *  A def with MODES gets the first mode whose helper actually reads `port`. */
/** A constant on another channel, so an Output never falls back to its `vec3(1, 0, 0)` placeholder (whose parse
 *  mints a node — the pre-existing "nothing on Color" round trip, unrelated to the source). */
const K = (): AppNode => makeNode('K', 'float', { value: 0.25 });

const live = (type: string, port: string): Graph | null => {
  const def = NODE_REGISTRY.get(type)!;
  const out = def.outputs[0];
  if (!out) return null;
  const values: Record<string, string | number> = {};
  if (def.modes) {
    const mode = def.modes.values.find((m) => helperCallPorts(helperNameFor(def, { mode: m }), def.inputs).includes(port));
    if (!mode) return null;
    values.mode = mode;
  }
  if (def.category === 'logic') {
    return {
      nodes: [makeNode('C', type, values), makeNode('O', 'output'), K()],
      edges: [makeEdge('C', out.id, 'O', 'discard'), makeEdge('K', 'out', 'O', 'color')],
    };
  }
  return {
    nodes: [makeNode('C', type, values), makeNode('O', 'output')],
    edges: [makeEdge('C', out.id, 'O', 'color')],
  };
};

/** Every (consumer label, graph-without-source, consumer type, port) case. */
function consumerCases(): { name: string; type: string; port: string; nodes: AppNode[]; edges: AppEdge[]; target: string }[] {
  const out: { name: string; type: string; port: string; nodes: AppNode[]; edges: AppEdge[]; target: string }[] = [];
  for (const def of NODE_REGISTRY.values()) {
    if (ONE_WAY.has(def.type) || def.category === 'output' || def.type === 'split') continue;
    for (const p of def.inputs) {
      if (ONE_WAY_PORTS.has(`${def.type}.${p.id}`)) continue;
      const g = live(def.type, p.id);
      if (!g) continue;
      out.push({ name: `${def.type}.${p.id}`, type: def.type, port: p.id, ...g, target: 'C' });
    }
  }
  // The noise family's position is an exposed PARAMETER, not a def input.
  for (const type of NOISE_TYPES) {
    const g = live(type, 'pos')!;
    out.push({ name: `${type}.pos`, type, port: 'pos', ...g, target: 'C' });
  }
  for (const ch of NODE_REGISTRY.get('output')!.inputs) {
    if (ch.id === 'env') continue; // an Image-only socket (the env TEXTURE): any other source is not an environment
    const other = ch.id === 'metalness' ? 'roughness' : 'metalness';
    out.push({ name: `output.${ch.id}`, type: 'output', port: ch.id, nodes: [makeNode('O', 'output'), K()], edges: [makeEdge('K', 'out', 'O', other)], target: 'O' });
  }
  for (const lit of [false, true]) {
    for (const s of NODE_REGISTRY.get('splatOutput')!.inputs) {
      if (!lit && ['lightX', 'lightY', 'lightZ', 'lightColor', 'ambient'].includes(s.id)) continue; // dormant unlit
      const sp = makeNode('SP', 'splatOutput');
      (sp.data as { values: Record<string, unknown> }).values = lit ? { lit: true } : {};
      // Only Color/Opacity/Cut/Move/Size make a Splat Output drive (SPLAT_PRIMARY_SOCKETS); a constant on
      // Opacity drives it for the others.
      const primary = ['color', 'opacity', 'cut', 'move', 'size'].includes(s.id);
      out.push({
        name: `splatOutput${lit ? ' (lit)' : ''}.${s.id}`, type: 'splatOutput', port: s.id,
        nodes: primary ? [sp] : [sp, K()], edges: primary ? [] : [makeEdge('K', 'out', 'SP', 'opacity')], target: 'SP',
      });
    }
  }
  for (const s of NODE_REGISTRY.get('raymarchOutput')!.inputs) {
    const nodes = [makeNode('RM', 'raymarchOutput')];
    const edges: AppEdge[] = [];
    if (s.id !== 'field') {
      // Something must drive the march: a sphere field off the ray position.
      nodes.push(makeNode('P', 'positionLocal'), makeNode('SD', 'sdCircle'));
      edges.push(makeEdge('P', 'out', 'SD', 'p'), makeEdge('SD', 'out', 'RM', 'field'));
    }
    out.push({ name: `raymarchOutput.${s.id}`, type: 'raymarchOutput', port: s.id, nodes, edges, target: 'RM' });
  }
  return out;
}

const byLabel = (nodes: AppNode[], label: string) => nodes.find((n) => n.data.label === label);

/** The edges from (source socket) that reach `targetId.port`, directly or through ONE Split. */
function reaches(g: Graph, srcId: string, handle: string, targetId: string, port: string): boolean {
  const direct = g.edges.some((e) => e.source === srcId && e.sourceHandle === handle && e.target === targetId && e.targetHandle === port);
  if (direct) return true;
  return g.edges.some((e) => {
    if (e.source !== srcId || e.sourceHandle !== handle) return false;
    const split = g.nodes.find((n) => n.id === e.target && n.data.registryType === 'split');
    return !!split && e.targetHandle === 'v' &&
      g.edges.some((e2) => e2.source === split.id && e2.target === targetId && e2.targetHandle === port);
  });
}

describe('own-member sources — every consumer keeps its wire across Apply', () => {
  const cases = consumerCases();

  it('sweeps every def input, the noise positions and the three sinks', () => {
    expect(cases.length).toBeGreaterThan(180);
  });

  for (const src of SOURCES) {
    for (const c of cases) {
      const key = `${src.type}.${src.handle} → ${c.name}`;
      it(key, () => {
        const S = makeNode('S', src.type);
        const g: Graph = { nodes: [S, ...c.nodes], edges: [makeEdge('S', src.handle, c.target, c.port), ...c.edges] };
        const first = graphToCode(g.nodes, g.edges).code;
        const srcVar = `${src.type}1`;
        const parsed = codeToGraph(first);
        expect(parsed.errors.filter((e) => e.severity !== 'warning'), key).toEqual([]);
        const drop = KNOWN_DROPS.get(key);
        if (drop) {
          expect(parsed.errors.some((e) => drop.test(e.message)), `${key}: a drop must be announced`).toBe(true);
          return;
        }
        // The GPU text reads the socket's own member.
        expect(first, key).toContain(`${srcVar}.${src.member}`);
        const ps = byLabel(parsed.nodes, srcVar);
        expect(ps, key).toBeDefined();
        const targetLabel = c.target === 'C'
          ? parsed.nodes.find((n) => n.data.registryType === c.type && n.data.label !== srcVar)?.data.label
          : undefined;
        const pt = c.target === 'C'
          ? byLabel(parsed.nodes, targetLabel as string)
          : parsed.nodes.find((n) => n.data.registryType === c.type);
        expect(pt, key).toBeDefined();
        expect(reaches({ nodes: parsed.nodes, edges: parsed.edges }, ps!.id, src.handle, pt!.id, c.port), key).toBe(true);
        const second = graphToCode(parsed.nodes, parsed.edges).code;
        expect(second, key).toBe(first);
        const again = codeToGraph(second);
        expect(again.nodes.length, key).toBe(parsed.nodes.length);
        expect(again.edges.length, key).toBe(parsed.edges.length);
      });
    }
  }
});

describe('own-member sources — a Split reads per SOURCE SOCKET', () => {
  for (const src of SOURCES) {
    it(`${src.type}.${src.handle} → Split.x → Color reads ${src.member}; Split.y reads nothing; Apply drops the Split`, () => {
      const S = makeNode('S', src.type);
      const sx = makeNode('X', 'split');
      const nodes = [S, sx, makeNode('O', 'output')];
      const x = graphToCode(nodes, [makeEdge('S', src.handle, 'X', 'v'), makeEdge('X', 'x', 'O', 'color')]).code;
      expect(x).toContain(`vec3(${src.type}1.${src.member})`);
      const r = codeToGraph(x);
      expect(r.nodes.some((n) => n.data.registryType === 'split')).toBe(false);
      const ps = byLabel(r.nodes, `${src.type}1`)!;
      expect(r.edges.some((e) => e.source === ps.id && e.sourceHandle === src.handle && e.targetHandle === 'color')).toBe(true);
      const second = graphToCode(r.nodes, r.edges).code;
      expect(second).toBe(x);
      const again = codeToGraph(second);
      expect([again.nodes.length, again.edges.length]).toEqual([r.nodes.length, r.edges.length]);

      // A scalar socket has no .y: the consumer reads as unwired.
      const y = graphToCode(nodes, [makeEdge('S', src.handle, 'X', 'v'), makeEdge('X', 'y', 'O', 'color')]).code;
      expect(y).not.toContain(`${src.type}1.`);
    });
  }

  it('a vector source keeps the bare-variable swizzle (toHsl HSL, a Vec3), byte-identical to before', () => {
    const nodes = [makeNode('S', 'toHsl'), makeNode('X', 'split'), makeNode('O', 'output')];
    const c = graphToCode(nodes, [makeEdge('S', 'out', 'X', 'v'), makeEdge('X', 'z', 'O', 'roughness')]).code;
    expect(c).toContain('roughness: toHsl1.z');
    const v = graphToCode(
      [makeNode('S', 'vec3', { x: 0.1, y: 0.2, z: 0.3 }), makeNode('X', 'split'), makeNode('O', 'output')],
      [makeEdge('S', 'out', 'X', 'v'), makeEdge('X', 'y', 'O', 'roughness')],
    ).code;
    expect(v).toContain('roughness: vec31.y');
  });
});

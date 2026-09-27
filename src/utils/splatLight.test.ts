/**
 * utils/splatLight.ts — the pieces of React to light that are pure: the carry
 * of light values across a code-panel Apply, against the REAL emitter and
 * parse, plus the source pin that useSyncEngine's resync merge applies it (the
 * hook itself cannot run under the node environment).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge } from '@/types';
import { graphToCode } from '@/engine/graphToCode';
import { codeToGraph } from '@/engine/codeToGraph';
import { pairResyncNodes } from './resyncPairing';
import { activeSink } from './sdfPartition';
import { carryDormantLightEdges, carrySplatLightValues, litSplatCount, SPLAT_LIGHT_DIRECTION_EPSILON } from './splatLight';

function splat(values: Record<string, unknown>): AppNode {
  const n = makeNode('sp', 'splatOutput');
  return { ...n, data: { ...n.data, values, activeOutput: true } } as AppNode;
}
const never = () => false;

describe('carrySplatLightValues — the light values an Apply cannot see', () => {
  it('an UNLIT node: the parse seeds the defaults over its dormant light, the carry brings it back', () => {
    const old = { color: '#00ff00', lightX: -2, lightY: 0.1, lightColor: '#ff0000', ambient: '#102030' };
    const parsed = codeToGraph(graphToCode([splat(old)], []).code);
    const values = (parsed.nodes.find((n) => n.data.registryType === 'splatOutput')!.data as { values: Record<string, unknown> }).values;
    // What the Apply alone does: the light is not in the code, so the parsed
    // node holds the registry's SEEDED direction and no colours.
    expect(values.lightX).toBe(0.6);
    expect(values).not.toHaveProperty('lightColor');
    const carried = carrySplatLightValues(values, old, never);
    expect(carried).toMatchObject({ color: '#00ff00', lightX: -2, lightY: 0.1, lightZ: 0.5, lightColor: '#ff0000', ambient: '#102030' });
    // …and switching the light back on then emits exactly that light.
    const relit = graphToCode([splat({ ...carried!, lit: true })], []).code;
    expect(relit).toContain('const sp1Light = add(mul(color(0xff0000), max(dot(n, normalize(add(vec3(-2, 0.1, 0.5), 1e-9))), 0)), color(0x102030));');
  });

  it('a LIT node: unwired values stay code-authoritative; a wired socket keeps the value under its wire', () => {
    const parsed = { lit: true, lightX: 0.6, lightY: 0.8, lightZ: 0.5 };
    const old = { lit: true, lightX: 3, lightColor: '#ff0000', ambient: '#00ff00' };
    // Nothing wired: the code said default grey, so the old colours are NOT carried.
    expect(carrySplatLightValues(parsed, old, never)).toBeNull();
    // Light colour wired in the parse: its stored swatch (never in the code) survives.
    expect(carrySplatLightValues(parsed, old, (p) => p === 'lightColor')).toEqual({ ...parsed, lightColor: '#ff0000' });
    // Light X wired: the parse holds only the SEEDED 0.6 there, the old 3 survives.
    expect(carrySplatLightValues(parsed, old, (p) => p === 'lightX')).toEqual({ ...parsed, lightX: 3 });
    // An unwired value the parse read from the code always wins.
    expect(carrySplatLightValues({ ...parsed, lightColor: '#0000ff' }, { lightColor: '#ff0000' }, never)).toBeNull();
  });

  it('own keys only, a fresh object, and nothing to carry is null', () => {
    const parsed = { color: '#ffffff' };
    expect(carrySplatLightValues(parsed, Object.create({ lightX: 5 }) as Record<string, unknown>, never)).toBeNull();
    expect(carrySplatLightValues(parsed, { opacity: 0.2 }, never)).toBeNull();
    const next = carrySplatLightValues(parsed, { lightZ: -1 }, never);
    expect(next).toEqual({ color: '#ffffff', lightZ: -1 });
    expect(next).not.toBe(parsed);
    expect(parsed).toEqual({ color: '#ffffff' });
  });

  it('useSyncEngine\'s resync merge applies it to a Splat Output, with the PARSED edges deciding "wired"', () => {
    const src = readFileSync(resolve(__dirname, '../hooks/useSyncEngine.ts'), 'utf8');
    expect(src).toContain("import { carryDormantLightEdges, carrySplatLightValues } from '@/utils/splatLight';");
    const at = src.indexOf("if (merged.data.registryType === 'splatOutput') {");
    expect(at).toBeGreaterThan(src.indexOf('const mergeMatch = (newNode: AppNode, match: AppNode): AppNode => {'));
    const block = src.slice(at, src.indexOf('const oldExposed', at));
    expect(block).toContain('const wiredIn = (port: string) => result.edges.some((e) => e.target === newNode.id && e.targetHandle === port);');
    expect(block).toContain('carrySplatLightValues(parsedValues, old, wiredIn) ?? parsedValues');
    // …then the colour mode, from the values the light carry produced.
    expect(block).toContain('carrySplatReplaceColor(lit, old, colorFed) ?? lit');
    expect(block).toContain("wiredIn('color') ||");
  });
});


/**
 * The resync as useSyncEngine runs it, reduced to the parts the carry reads:
 * parse the emitted code, PAIR it with the old graph (the real pairing), and
 * give every paired node its old id — what `mergeMatch` does.
 */
function applyCode(old: { nodes: AppNode[]; edges: AppEdge[] }, codeText = graphToCode(old.nodes, old.edges).code) {
  const parsed = codeToGraph(codeText);
  const pairing = pairResyncNodes(old.nodes, parsed.nodes, activeSink(old.nodes, old.edges)?.id ?? null);
  const idMap = new Map(pairing.paired.map(({ node, match }) => [node.id, match.id] as const));
  const finalNodes = parsed.nodes.map((n) => ({ ...n, id: idMap.get(n.id) ?? n.id }) as AppNode);
  const edges = parsed.edges.map((e) => ({ ...e, source: idMap.get(e.source) ?? e.source, target: idMap.get(e.target) ?? e.target }));
  const carried = carryDormantLightEdges(old.nodes, finalNodes, old.edges, edges, new Set(finalNodes.map((n) => n.id)));
  return { parsed, finalNodes, edges, carried };
}

describe('carryDormantLightEdges — the WIRES an Apply cannot see', () => {
  // The review's probe: positionWorld → length → Ambient on an UNLIT node.
  const dormant = () => ({
    nodes: [makeNode('pw', 'positionWorld'), makeNode('len', 'length'), splat({})],
    edges: [makeEdge('pw', 'out', 'len', 'v'), makeEdge('len', 'out', 'sp', 'ambient')],
  });

  it('an unlit node\'s light wire is in no line of the code; the parse keeps the feeder and the carry brings the wire back', () => {
    const old = dormant();
    const { parsed, edges, carried } = applyCode(old);
    expect(parsed.errors).toEqual([]);
    expect(edges.some((e) => e.targetHandle === 'ambient')).toBe(false); // what the parse alone loses
    expect(carried).toEqual([old.edges[1]]);
    // …and the graph after the Apply emits exactly what it did before it.
    const after = applyCode(old);
    expect(graphToCode(after.finalNodes, [...after.edges, ...after.carried]).code).toBe(graphToCode(old.nodes, old.edges).code);
  });

  it('never while either side is lit: a lit node\'s light wires ARE in the code, and deleting them there is an edit', () => {
    const litOld = { ...dormant(), nodes: [...dormant().nodes.slice(0, 2), splat({ lit: true })] };
    // Lit before and after: the parse rebuilds the wire itself — nothing to carry.
    const same = applyCode(litOld);
    expect(same.edges.some((e) => e.targetHandle === 'ambient')).toBe(true);
    expect(same.carried).toEqual([]);
    // Lit before, the light deleted from the code: the wire goes with it.
    const code = graphToCode(litOld.nodes, litOld.edges).code
      .replace(/ {4}const sp1Light = [^\n]*\n/, '')
      .replace('mul(c.rgb, sp1Light)', 'c.rgb')
      .replace(', lit: true', '');
    expect(applyCode(litOld, code).carried).toEqual([]);
  });

  it('only from a source that survived, and never into a socket the parse wired', () => {
    const old = dormant();
    // The feeder deleted from the code: its wire goes with it.
    const code = graphToCode(old.nodes, old.edges).code.replace(/ {2}const length1 = [^\n]*\n/, '');
    expect(applyCode(old, code).carried).toEqual([]);
    const oldNodes = old.nodes;
    const finalNodes = old.nodes;
    const parsedEdges = [{ target: 'sp', targetHandle: 'ambient' }];
    expect(carryDormantLightEdges(oldNodes, finalNodes, old.edges, parsedEdges, new Set(['pw', 'len', 'sp']))).toEqual([]);
    // Only Light sockets: a Color wire is the parse's to rebuild.
    const colour = [...old.edges, makeEdge('len', 'out', 'sp', 'color')];
    expect(carryDormantLightEdges(oldNodes, finalNodes, colour, [], new Set(['pw', 'len', 'sp']))).toEqual([old.edges[1]]);
  });

  it('useSyncEngine carries them INSIDE the unpositioned gate (never across documents), before the auto-expose', () => {
    const src = readFileSync(resolve(__dirname, '../hooks/useSyncEngine.ts'), 'utf8');
    const gate = src.indexOf('if (unpositioned.length === 0) {');
    const at = src.indexOf('const dormantLight = carryDormantLightEdges(');
    // After the gate opens and after the parked-sink carry inside it, before
    // the group block (which opens past the gate's close).
    expect(at).toBeGreaterThan(gate);
    expect(at).toBeGreaterThan(src.indexOf('const inactiveSinks = carryInactiveSinks('));
    expect(at).toBeLessThan(src.indexOf('const oldGroups ='));
    expect(at).toBeLessThan(src.indexOf('autoExposeConnectedParamPorts(finalNodes, remappedEdges);'));
    // The UNWRAPPED old edges the gate already built.
    expect(src.slice(at, at + 300)).toContain('realOldEdges,');
    expect(src).toContain('if (dormantLight.length > 0) remappedEdges.push(...dormantLight);');
  });
});

describe('the light direction\'s zero guard', () => {
  it('a zero direction is guarded; a real one is unchanged in float32', () => {
    expect(SPLAT_LIGHT_DIRECTION_EPSILON).toBe(1e-9);
    const code = graphToCode([splat({ lit: true, lightX: 0, lightY: 0, lightZ: 0 })], []).code;
    expect(code).toContain('normalize(add(vec3(0, 0, 0), 1e-9))');
    // Every component above 1/32 in magnitude survives the add bit for bit in
    // float32 (at exactly −1/32 the sum drops into the finer binade below).
    for (const v of [1 / 32, 0.04, 0.5, 0.6, 0.8, 1, 2, -0.04, -0.6]) {
      expect(Math.fround(Math.fround(v) + SPLAT_LIGHT_DIRECTION_EPSILON), String(v)).toBe(Math.fround(v));
    }
    // …and the zero vector normalises to the (1, 1, 1) diagonal, not NaN.
    const e = Math.fround(SPLAT_LIGHT_DIRECTION_EPSILON);
    const len = Math.hypot(e, e, e);
    expect(e / len).toBeCloseTo(1 / Math.sqrt(3), 6);
  });

  it('litSplatCount counts the lit Splat Outputs, strictly', () => {
    expect(litSplatCount([])).toBe(0);
    expect(litSplatCount([splat({ lit: true }), splat({}), splat({ lit: 'true' }), makeNode('x', 'output')])).toBe(1);
  });
});

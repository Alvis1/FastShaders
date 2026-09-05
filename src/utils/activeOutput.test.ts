import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';
import {
  activeSink,
  drivingMarchOutput,
  marchWindowRadius,
  normalizeActiveOutput,
  clearActiveOutput,
  hasActiveFlag,
} from './sdfPartition';
import { findDefaultOutput } from './outputMaterials';
import { carryInactiveSinks } from './sinkCarry';
import { graphToCode } from '@/engine/graphToCode';
import { codeToGraph } from '@/engine/codeToGraph';
import { connectedUniformNamesKey } from './connectedUniforms';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';

/**
 * Several output nodes — plain Outputs and Raymarch Outputs — may coexist and
 * exactly ONE is active. The flag is node data (`activeOutput: true`), ABSENT
 * on every document that never had a choice made, so those keep emitting
 * under the historical rule byte-for-byte. See utils/sdfPartition.ts.
 */

const flag = (n: AppNode): AppNode => ({ ...n, data: { ...n.data, activeOutput: true } }) as AppNode;

const pos = () => makeNode('pos', 'positionLocal');
const sd = () => makeNode('sd', 'sdCircle');
const rm = () => makeNode('rm', 'raymarchOutput');
const out = (id = 'out1') => makeNode(id, 'output');
const marchWired = () => [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field')];

describe('activeSink — the ONE resolver', () => {
  it('with no flag: the first WIRED Raymarch Output, else the first Output (the historical rule)', () => {
    expect(activeSink([pos(), sd(), rm(), out()], marchWired())?.id).toBe('rm');
    expect(activeSink([pos(), sd(), rm(), out()], marchWired().slice(0, 1))?.id).toBe('out1');
    expect(activeSink([out('a'), out('b')], [])?.id).toBe('a');
    expect(activeSink([pos()], [])).toBeNull();
  });

  it('the flag wins over wiring and over array order', () => {
    expect(activeSink([pos(), sd(), rm(), flag(out())], marchWired())?.id).toBe('out1');
    expect(activeSink([pos(), sd(), flag(rm()), out()], [])?.id).toBe('rm');
    expect(activeSink([out('a'), flag(out('b'))], [])?.id).toBe('b');
  });

  it('only the literal true counts (node data is untrusted)', () => {
    const junk = { ...out('b'), data: { ...out('b').data, activeOutput: 'yes' } } as AppNode;
    expect(activeSink([out('a'), junk], [])?.id).toBe('a');
    expect(hasActiveFlag(junk)).toBe(false);
  });

  it('drivingMarchOutput / marchWindowRadius / findDefaultOutput all follow it', () => {
    const nodes = [pos(), sd(), rm(), flag(out())];
    expect(drivingMarchOutput(nodes, marchWired())).toBeNull();
    expect(marchWindowRadius(nodes, marchWired())).toBeNull();
    const flaggedRm = flag(rm());
    (flaggedRm.data as { values: Record<string, number> }).values = { window: 7 };
    expect(drivingMarchOutput([pos(), sd(), flaggedRm, out()], [])?.id).toBe('rm');
    expect(marchWindowRadius([pos(), sd(), flaggedRm, out()], [])).toBe(7);
    expect(findDefaultOutput([out('a'), flag(out('b'))])?.id).toBe('b');
  });
});

describe('normalizeActiveOutput / clearActiveOutput', () => {
  it('returns the SAME array when nothing needed changing', () => {
    const nodes = [out('a'), flag(out('b')), pos()];
    expect(normalizeActiveOutput(nodes)).toBe(nodes);
    expect(clearActiveOutput([out('a'), pos()])).toEqual([out('a'), pos()]);
  });

  it('keeps the FIRST true and strips every other flag and every junk value', () => {
    const junk = { ...out('c'), data: { ...out('c').data, activeOutput: 1 } } as AppNode;
    const nodes = [out('a'), flag(out('b')), flag(rm()), junk];
    const next = normalizeActiveOutput(nodes);
    expect(next).not.toBe(nodes);
    expect(next.map((n) => hasActiveFlag(n))).toEqual([false, true, false, false]);
    expect('activeOutput' in (next[2].data as object)).toBe(false);
    expect('activeOutput' in (next[3].data as object)).toBe(false);
  });

  it('clearActiveOutput strips the flag from a fragment', () => {
    const next = clearActiveOutput([flag(out('a')), flag(rm())]);
    expect(next.some(hasActiveFlag)).toBe(false);
  });
});

describe('emission follows the active sink', () => {
  it('a document with no flag emits exactly what it always did', () => {
    const nodes = [pos(), sd(), rm(), out()];
    const { code } = graphToCode(nodes, marchWired());
    expect(code).toContain('const rm1 = Fn(');
    expect(code).not.toContain('activeOutput');
  });

  it('a flagged plain Output silences a wired march; its own chain emits', () => {
    const color = makeNode('c', 'color', { hex: '#ff0000' });
    const nodes = [pos(), sd(), rm(), flag(out()), color];
    const edges = [...marchWired(), makeEdge('c', 'out', 'out1', 'color')];
    const { code } = graphToCode(nodes, edges);
    expect(code).not.toContain('const rm1 = Fn(');
    expect(code).toContain('return color1;');
    // The march's feeders still emit as ordinary consts, so the carry can
    // keep the inactive node's wiring across an Apply.
    expect(code).toContain('const sdCircle1 = sdCircle(positionLocal1');
  });

  it('a flagged but UNWIRED Raymarch Output emits the "nothing wired" sentinel, not the plain Output', () => {
    const color = makeNode('c', 'color', { hex: '#ff0000' });
    const nodes = [flag(rm()), out(), color];
    const edges = [makeEdge('c', 'out', 'out1', 'color')];
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('return vec3(1, 0, 0);');
    expect(code).not.toContain('return color1;');
  });

  it('a second, flagged Output emits ITS chain, byte-identically to a lone Output with that chain', () => {
    const a = makeNode('a', 'color', { hex: '#ff0000' });
    const b = makeNode('b', 'color', { hex: '#00ff00' });
    const two = graphToCode(
      [out('o1'), flag(out('o2')), a, b],
      [makeEdge('a', 'out', 'o1', 'color'), makeEdge('b', 'out', 'o2', 'color')],
    ).code;
    const lone = graphToCode([out('o2'), a, b], [makeEdge('b', 'out', 'o2', 'color')]).code;
    expect(two).toBe(lone);
  });

  it('the Uniforms overlay lists only sliders that reach the ACTIVE sink', () => {
    const s1 = makeNode('s1', 'property_float', { name: 'one', value: 1 });
    const s2 = makeNode('s2', 'property_float', { name: 'two', value: 2 });
    const nodes = [out('o1'), flag(out('o2')), s1, s2];
    const edges = [makeEdge('s1', 'out', 'o1', 'roughness'), makeEdge('s2', 'out', 'o2', 'roughness')];
    const key = connectedUniformNamesKey(nodes, edges, { s1: 'one', s2: 'two' });
    expect(key).toContain('two');
    expect(key).not.toContain('one');
  });
});

describe('carryInactiveSinks — an Apply keeps the inactive outputs and their wiring', () => {
  it('carries every inactive sink verbatim plus the incoming edges whose source survived', () => {
    const a = makeNode('a', 'color');
    const b = makeNode('b', 'color');
    const gone = makeNode('gone', 'color');
    const nodes = [out('o1'), flag(out('o2')), rm(), a, b, gone];
    const edges = [
      makeEdge('a', 'out', 'o1', 'color'),
      makeEdge('b', 'out', 'o2', 'color'),
      makeEdge('gone', 'out', 'rm', 'field'),
    ];
    // After the parse: o2 (active) survived as itself, a and b were matched, gone was deleted.
    const surviving = new Set(['o2', 'a', 'b']);
    const carried = carryInactiveSinks(nodes, edges, 'o2', surviving);
    expect(carried.nodes.map((n) => n.id)).toEqual(['o1', 'rm']);
    expect(carried.edges.map((e) => e.id)).toEqual([edges[0].id]);
  });

  it('apply ∘ apply is stable: two Outputs survive two round trips with their edges', () => {
    const a = makeNode('a', 'color', { hex: '#ff0000' });
    const b = makeNode('b', 'color', { hex: '#00ff00' });
    let nodes: AppNode[] = [out('o1'), flag(out('o2')), a, b];
    let edges = [makeEdge('a', 'out', 'o1', 'color'), makeEdge('b', 'out', 'o2', 'color')];
    for (let pass = 0; pass < 2; pass++) {
      const { code } = graphToCode(nodes, edges);
      const parsed = codeToGraph(code);
      expect(parsed.nodes.filter((n) => n.data.registryType === 'output')).toHaveLength(1);
      // Model the hook's pairing: every parsed node pairs with an old node of
      // its type, the parsed sink with the ACTIVE old one only.
      const parsedSink = parsed.nodes.find((n) => n.data.registryType === 'output')!;
      const idMap = new Map<string, string>([[parsedSink.id, 'o2']]);
      for (const n of parsed.nodes) {
        if (n.id === parsedSink.id) continue;
        const old = nodes.find((o) => o.data.registryType === n.data.registryType && !idMap.has(o.id) && ![...idMap.values()].includes(o.id));
        if (old) idMap.set(n.id, old.id);
      }
      const merged = parsed.nodes.map((n) => ({ ...(nodes.find((o) => o.id === idMap.get(n.id)) ?? n), data: { ...n.data, ...(idMap.get(n.id) === 'o2' ? { activeOutput: true } : {}) } })) as AppNode[];
      const remapped = parsed.edges.map((e) => makeEdge(idMap.get(e.source) ?? e.source, e.sourceHandle ?? 'out', idMap.get(e.target) ?? e.target, e.targetHandle ?? 'in'));
      const carried = carryInactiveSinks(nodes, edges, 'o2', new Set(merged.map((n) => n.id)));
      nodes = normalizeActiveOutput([...merged, ...carried.nodes]);
      edges = [...remapped, ...carried.edges];
      expect(nodes.filter((n) => n.data.registryType === 'output')).toHaveLength(2);
      expect(edges).toHaveLength(2);
      expect(activeSink(nodes, edges)?.id).toBe('o2');
    }
  });

  it('the hook pairs the parsed sink with the ACTIVE old node only and normalises the final list (source pins)', () => {
    const src = readFileSync(resolve(__dirname, '../hooks/useSyncEngine.ts'), 'utf8');
    expect(src).toContain('if (isSinkNode(old) && old.id !== oldActive?.id) continue;');
    expect(src).toContain('if (isSinkNode(match) && hasActiveFlag(match)) {');
    expect(src).toContain("carryInactiveSinks(oldNodes, realOldEdges, oldActive?.id ?? null, survivingIds)");
    expect(src).toContain('finalNodes = normalizeActiveOutput(finalNodes);');
    // The carry sits inside the same gate as the orphan carry — never after autoLayout.
    expect(src.indexOf('carryInactiveSinks(oldNodes')).toBeGreaterThan(src.indexOf('if (unpositioned.length === 0) {'));
    expect(src.indexOf('carryInactiveSinks(oldNodes')).toBeLessThan(src.indexOf('// Preserve group nodes from the old graph'));
  });
});

describe('store.setActiveOutput', () => {
  beforeEach(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [] });
  });

  it('moves the flag in ONE history entry and ignores a non-sink id', () => {
    const c = makeNode('c', 'color');
    useAppStore.setState({ nodes: [out('o1'), out('o2'), c] as AppNode[], edges: [] });
    const store = useAppStore.getState();
    store.setActiveOutput('c');
    expect(useAppStore.getState().past).toHaveLength(0);
    store.setActiveOutput('o2');
    expect(useAppStore.getState().past).toHaveLength(1);
    expect(useAppStore.getState().nodes.map((n) => hasActiveFlag(n))).toEqual([false, true, false]);
    store.setActiveOutput('o1');
    expect(useAppStore.getState().nodes.map((n) => hasActiveFlag(n))).toEqual([true, false, false]);
    // Re-activating the active node is a no-op — no entry, no notify.
    const before = useAppStore.getState().nodes;
    store.setActiveOutput('o1');
    expect(useAppStore.getState().nodes).toBe(before);
    expect(useAppStore.getState().past).toHaveLength(2);
  });

  it('every restore path normalises the flag, and a saved group loses it (source pins)', () => {
    const store = readFileSync(resolve(__dirname, '../store/useAppStore.ts'), 'utf8');
    const load = store.slice(store.indexOf('export function loadGraph()'), store.indexOf('const folded = foldExtraOutputs(data.nodes, data.edges)'));
    expect(load, 'loadGraph must normalise BEFORE the fold reads the flag').toContain('data.nodes = normalizeActiveOutput(data.nodes);');
    expect(store, 'a saved group is a fragment — its flag is cleared at load').toContain('nodes: clearActiveOutput(sanitizeOutputMaterials(');
    expect(store, 'instantiate normalises the COMBINED list, live graph first').toContain('normalizeActiveOutput(sanitizeOutputMaterials([group, ...state.nodes, ...members] as AppNode[]))');
    const imp = readFileSync(resolve(__dirname, '../engine/projectImport.ts'), 'utf8');
    expect(imp).toContain('dataSanitized.nodes = normalizeActiveOutput(dataSanitized.nodes);');
    expect(imp.indexOf('normalizeActiveOutput(dataSanitized.nodes)')).toBeLessThan(imp.indexOf('const folded = foldExtraOutputs(dataSanitized.nodes, edges)'));
  });
});

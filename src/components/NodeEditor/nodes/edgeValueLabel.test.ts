import { describe, it, expect } from 'vitest';
import { makeNode, makeEdge } from '@/test-utils';
import { evaluateEdgeRange } from '@/engine/cpuEvaluator';
import { edgeRangeText, rangeSpan } from '@/utils/edgeValueText';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { buildRows, edgeLabelFlags, edgeValueLabel, rowHoldsInt, wiredLabelsKey } from './ShaderNode';

/**
 * The display contract of a connected input's label (ShaderNode's
 * `edgeValueLabel`) and the change key that re-renders it. Every expected TEXT
 * for a field is computed RELATIVE to `evaluateEdgeRange`, so these pin the
 * display layer and survive any change to the evaluator's interval rules.
 */
const intervalText = (
  source: string,
  nodes: Parameters<typeof evaluateEdgeRange>[1],
  edges: Parameters<typeof evaluateEdgeRange>[2],
  t: number,
  compact = false,
) => {
  const span = rangeSpan(evaluateEdgeRange({ source, sourceHandle: 'out' }, nodes, edges, t));
  return span ? edgeRangeText(span[0], span[1], compact) : '…';
};

describe('edgeValueLabel — which path a label takes', () => {
  it('UV + Time: a time-fed FIELD ticks its interval — animated, range, never blue', () => {
    const nodes = [makeNode('uv1', 'uv'), makeNode('t1', 'time', { speed: 1 }), makeNode('a', 'add')];
    const edges = [makeEdge('uv1', 'out', 'a', 'a'), makeEdge('t1', 'out', 'a', 'b')];
    const l = edgeValueLabel('a', nodes, edges, 'out');
    expect(l).toMatchObject({ animated: true, range: true, live: false, compact: false });
    expect(l.text).toBe(intervalText('a', nodes, edges, 0));
  });

  it('UV × sin(Time) is animated too — it used to read a frozen "0"', () => {
    const nodes = [
      makeNode('uv1', 'uv'),
      makeNode('t1', 'time', { speed: 1 }),
      makeNode('s1', 'sin'),
      makeNode('m', 'mul'),
    ];
    const edges = [
      makeEdge('t1', 'out', 's1', 'x'),
      makeEdge('uv1', 'out', 'm', 'a'),
      makeEdge('s1', 'out', 'm', 'b'),
    ];
    expect(edgeValueLabel('m', nodes, edges, 'out')).toMatchObject({ animated: true, range: true, live: false });
  });

  it('a constant is a POINT: live, no range, not animated', () => {
    const nodes = [makeNode('f', 'float', { value: 0.5 })];
    expect(edgeValueLabel('f', nodes, [], 'out')).toEqual({
      text: '0.5', live: true, animated: false, range: false, compact: false,
    });
  });

  it('a tiny constant prints its digit, not "0"', () => {
    const nodes = [makeNode('f', 'float', { value: 0.003 })];
    expect(edgeValueLabel('f', nodes, [], 'out').text).toBe('0.003');
  });

  it('Time → sin: a time-driven POINT — live and animated, not range', () => {
    const nodes = [makeNode('t1', 'time', { speed: 1 }), makeNode('s1', 'sin')];
    const edges = [makeEdge('t1', 'out', 's1', 'x')];
    expect(edgeValueLabel('s1', nodes, edges, 'out')).toMatchObject({ live: true, animated: true, range: false });
  });

  it('a static field: range, not animated, not live', () => {
    const nodes = [makeNode('uv1', 'uv')];
    const l = edgeValueLabel('uv1', nodes, [], 'out');
    expect(l).toMatchObject({ range: true, animated: false, live: false });
    expect(l.text).toBe(intervalText('uv1', nodes, [], 0));
  });
});

describe('edgeValueLabel — the compact option', () => {
  // UV × 0.3: the interval the old formatter printed as a flat "0".
  const nodes = [makeNode('uv1', 'uv'), makeNode('k', 'float', { value: 0.3 }), makeNode('m', 'mul')];
  const edges = [makeEdge('uv1', 'out', 'm', 'a'), makeEdge('k', 'out', 'm', 'b')];

  it('is threaded into the text and returned, so the ticks format the same way', () => {
    const full = edgeValueLabel('m', nodes, edges, 'out');
    const compact = edgeValueLabel('m', nodes, edges, 'out', { compact: true });
    expect(full.text).toBe(intervalText('m', nodes, edges, 0));
    expect(compact.text).toBe(intervalText('m', nodes, edges, 0, true));
    expect(full.compact).toBe(false);
    expect(compact.compact).toBe(true);
  });

  it('a POINT label is formatted compact too (a multi-channel point is a min…max)', () => {
    const v = [makeNode('v', 'vec3', { x: 0.2, y: 0.5, z: 0.9 })];
    expect(edgeValueLabel('v', v, [], 'out').text).toBe('0.2…0.9');
    expect(edgeValueLabel('v', v, [], 'out', { compact: true }).text).toBe('0…1');
  });
});

describe('edgeLabelFlags', () => {
  it('spells every flag, so a key cannot miss a point ↔ interval flip', () => {
    const base = { text: '0…1', live: false, animated: true, range: false, compact: false };
    expect(edgeLabelFlags(base)).not.toBe(edgeLabelFlags({ ...base, range: true }));
    expect(edgeLabelFlags(base)).not.toBe(edgeLabelFlags({ ...base, compact: true }));
    expect(edgeLabelFlags(base)).not.toBe(edgeLabelFlags({ ...base, live: true }));
    expect(edgeLabelFlags(base)).not.toBe(edgeLabelFlags({ ...base, animated: false }));
  });
});

describe('wiredLabelsKey — the useWiredLabels change key', () => {
  const graph = (feeder: 'f1' | 'f2') => {
    const nodes = [
      makeNode('f1', 'float', { value: 0.5 }),
      makeNode('f2', 'float', { value: 0.5 }),
      makeNode('out1', 'output'),
    ];
    const edges = [makeEdge(feeder, 'out', 'out1', 'roughness')];
    return { nodes, edges };
  };

  it('folds the SOURCE: re-wiring to another node with the same text changes the key', () => {
    // Same target handle, same source socket, same text ("0.5"), same flags —
    // only the source differs, which left the label ticking the OLD source.
    const a = graph('f1'), b = graph('f2');
    const ka = wiredLabelsKey(a.edges, a.nodes, a.edges);
    const kb = wiredLabelsKey(b.edges, b.nodes, b.edges);
    expect(ka).not.toBe('');
    expect(ka).not.toBe(kb);
  });

  it('is stable for an unchanged graph (a position-only notify must bail)', () => {
    const a = graph('f1');
    expect(wiredLabelsKey(a.edges, a.nodes, a.edges)).toBe(wiredLabelsKey(a.edges, a.nodes, a.edges));
  });

  it('folds every label flag (edgeLabelFlags), and the compact option with them', () => {
    // A field fed by Time: the flags a point label never carries (range).
    const nodes = [makeNode('uv1', 'uv'), makeNode('t1', 'time'), makeNode('a', 'add'), makeNode('out1', 'output')];
    const edges = [makeEdge('uv1', 'out', 'a', 'a'), makeEdge('t1', 'out', 'a', 'b'), makeEdge('a', 'out', 'out1', 'roughness')];
    const into = edges.filter((e) => e.target === 'out1');
    for (const compact of [false, true]) {
      const l = edgeValueLabel('a', nodes, edges, 'out', { compact });
      expect(wiredLabelsKey(into, nodes, edges, { compact })).toContain(`${l.text}\u0000${edgeLabelFlags(l)}`);
    }
    expect(wiredLabelsKey(into, nodes, edges, { compact: true })).not.toBe(wiredLabelsKey(into, nodes, edges));
  });

  it('skips an edge with no string target handle', () => {
    const a = graph('f1');
    const odd = [{ ...a.edges[0], targetHandle: null }];
    expect(wiredLabelsKey(odd, a.nodes, a.edges)).toBe('');
  });
});

describe('rowHoldsInt — the Int node steps by whole numbers', () => {
  const rowsOf = (type: string) => {
    const def = NODE_REGISTRY.get(type)!;
    return { def, rows: buildRows(def) };
  };

  it("the Int node's own value row (no input port) holds an int", () => {
    const { def, rows } = rowsOf('int');
    const valueRow = rows.find((r) => r.settingKey === 'value')!;
    expect(valueRow.input).toBeNull();
    expect(rowHoldsInt(def, valueRow)).toBe(true);
  });

  it("the Float node's value row does not", () => {
    const { def, rows } = rowsOf('float');
    expect(rowHoldsInt(def, rows.find((r) => r.settingKey === 'value')!)).toBe(false);
  });

  it('an int INPUT port does (UV channel), a float one does not (UV tiling)', () => {
    const { def, rows } = rowsOf('uv');
    expect(rowHoldsInt(def, rows.find((r) => r.input?.id === 'channel')!)).toBe(true);
    expect(rowHoldsInt(def, rows.find((r) => r.input?.id === 'tilingU')!)).toBe(false);
  });
});

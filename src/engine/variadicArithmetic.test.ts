import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { evaluateNodeOutput, evaluateNodeRange } from './cpuEvaluator';
import { effectiveInputs, chainPortId, chainPortIndex, NODE_REGISTRY } from '@/registry/nodeRegistry';
import { nodeCostPoints } from '@/utils/nodeCost';
import { normalizeChainOperands } from '@/utils/chainOperands';
import { makeNode, makeEdge } from '@/test-utils';

// ── effectiveInputs socket-count rule ────────────────────────────────────────
describe('effectiveInputs — chainable socket growth', () => {
  const add = NODE_REGISTRY.get('add')!;
  const mul = NODE_REGISTRY.get('mul')!;
  const clamp = NODE_REGISTRY.get('clamp')!; // non-chainable, 3 inputs

  const ids = (ports: { id: string }[]) => ports.map((p) => p.id);

  it('nothing connected → the two base sockets, no grow socket', () => {
    expect(ids(effectiveInputs(add, []))).toEqual(['a', 'b']);
  });

  it('one operand wired → still just a, b (b not yet filled)', () => {
    expect(ids(effectiveInputs(add, ['a']))).toEqual(['a', 'b']);
  });

  it('both base operands wired → one empty grow socket c appears', () => {
    expect(ids(effectiveInputs(add, ['a', 'b']))).toEqual(['a', 'b', 'c']);
  });

  it('grows one socket per wired operand', () => {
    expect(ids(effectiveInputs(mul, ['a', 'b', 'c']))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a disconnected middle operand leaves a gap but keeps the tail', () => {
    // a and c wired, b empty → render a, b, c, plus grow socket d
    expect(ids(effectiveInputs(add, ['a', 'c']))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('excludes the trailing empty socket for codegen/eval', () => {
    expect(ids(effectiveInputs(add, ['a', 'b'], false))).toEqual(['a', 'b']);
    expect(ids(effectiveInputs(add, ['a', 'b', 'c'], false))).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op for non-chainable nodes', () => {
    expect(ids(effectiveInputs(clamp, ['x', 'min', 'max']))).toEqual(['x', 'min', 'max']);
  });

  it('a stored value on an EXTENSION operand keeps its row (imported literals)', () => {
    // add(x, 2, 3): 'a' wired, values {b:2, c:3} → render a, b, c — the valued
    // c keeps its row but earns NO trailing slot (c is not wired).
    expect(ids(effectiveInputs(add, ['a'], true, ['b', 'c']))).toEqual(['a', 'b', 'c']);
    // codegen form matches
    expect(ids(effectiveInputs(add, ['a'], false, ['b', 'c']))).toEqual(['a', 'b', 'c']);
  });

  it('typing into the trailing box never spawns a new row — only wiring does', () => {
    // a, b wired → trailing slot c appears
    expect(ids(effectiveInputs(add, ['a', 'b'], true, []))).toEqual(['a', 'b', 'c']);
    // user types a value into c (no edge) → STILL three rows, no d
    expect(ids(effectiveInputs(add, ['a', 'b'], true, ['c']))).toEqual(['a', 'b', 'c']);
    // wiring c is what opens d
    expect(ids(effectiveInputs(add, ['a', 'b', 'c'], true, ['c']))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a stored value on a BASE operand never spawns a socket', () => {
    // editing a/b inline must not grow the node
    expect(ids(effectiveInputs(add, [], true, ['a', 'b']))).toEqual(['a', 'b']);
  });

  it('caps the operand count against an adversarial handle (no OOM)', () => {
    const huge = effectiveInputs(add, ['arg99999999']);
    expect(huge.length).toBeLessThanOrEqual(64);
    const hugeVal = effectiveInputs(add, [], true, ['arg2000000']);
    expect(hugeVal.length).toBeLessThanOrEqual(64);
  });

  it('chainPortId / chainPortIndex round-trip', () => {
    expect(chainPortId(0)).toBe('a');
    expect(chainPortId(2)).toBe('c');
    expect(chainPortId(26)).toBe('arg26');
    expect(chainPortIndex('a')).toBe(0);
    expect(chainPortIndex('c')).toBe(2);
    expect(chainPortIndex('arg26')).toBe(26);
    expect(chainPortIndex('out')).toBe(-1);
    expect(chainPortIndex('signal')).toBe(-1);
  });
});

// ── normalizeChainOperands: disconnect removes the row (operands compact) ────
describe('normalizeChainOperands — gap compaction after disconnect', () => {
  const srcs = ['s0', 's1', 's2', 's3'].map((id) => makeNode(id, 'float', { value: 1 }));

  it('compacts a middle gap: [a, _, c, d] → [a, b, c]', () => {
    const op = makeNode('op', 'sub');
    const edges = [
      makeEdge('s0', 'out', 'op', 'a'),
      makeEdge('s2', 'out', 'op', 'c'),
      makeEdge('s3', 'out', 'op', 'd'),
    ];
    const r = normalizeChainOperands([...srcs, op], edges);
    expect(r.changed).toBe(true);
    const handles = r.edges.filter((e) => e.target === 'op').map((e) => e.targetHandle);
    expect(handles).toEqual(['a', 'b', 'c']);
    // Operand ORDER preserved (matters for sub/div): sources stay s0, s2, s3.
    expect(r.edges.map((e) => e.source)).toEqual(['s0', 's2', 's3']);
    // Edge ids stay in sync with their new handles.
    for (const e of r.edges) expect(e.id).toContain(`-${e.targetHandle}`);
  });

  it('shifts typed values along with the compaction', () => {
    // a wired, b gap, c typed=5 → c's value lands on b
    const op = makeNode('op', 'mul', { c: 5 });
    const edges = [makeEdge('s0', 'out', 'op', 'a')];
    const r = normalizeChainOperands([...srcs, op], edges);
    expect(r.changed).toBe(true);
    const values = (r.nodes.find((n) => n.id === 'op')!.data as { values: Record<string, number> }).values;
    expect(values.b).toBe(5);
    expect(values.c).toBeUndefined();
  });

  it('leaves a classic 2-op node alone (no socket jumping)', () => {
    // only b wired — must NOT compact to a
    const op = makeNode('op', 'add');
    const edges = [makeEdge('s1', 'out', 'op', 'b')];
    const r = normalizeChainOperands([...srcs, op], edges);
    expect(r.changed).toBe(false);
    expect(r.edges).toBe(edges); // same reference — untouched
  });

  it('is idempotent: consecutive operands come back unchanged by reference', () => {
    const op = makeNode('op', 'add');
    const edges = [
      makeEdge('s0', 'out', 'op', 'a'),
      makeEdge('s1', 'out', 'op', 'b'),
      makeEdge('s2', 'out', 'op', 'c'),
    ];
    const r = normalizeChainOperands([...srcs, op], edges);
    expect(r.changed).toBe(false);
    expect(r.edges).toBe(edges);
  });

  it('skips members of a collapsed group (expand mapping stays valid)', () => {
    const group = {
      id: 'g1', type: 'group', position: { x: 0, y: 0 },
      data: { registryType: 'group', label: 'G', collapsed: true },
    } as unknown as ReturnType<typeof makeNode>;
    const op = makeNode('op', 'add');
    (op as { parentId?: string }).parentId = 'g1';
    // gap at 'a' (its boundary edge was rewired to the group socket)
    const edges = [
      makeEdge('s1', 'out', 'op', 'b'),
      makeEdge('s2', 'out', 'op', 'c'),
    ];
    const r = normalizeChainOperands([group, ...srcs, op], edges);
    expect(r.changed).toBe(false);
    expect(r.edges).toBe(edges);
  });
});

// ── cost: scales with operand count (base × operands−1) ──────────────────────
describe('nodeCostPoints — variadic arithmetic pricing', () => {
  const wire = (n: number, type: string) => {
    const op = makeNode('op', type);
    const srcs = Array.from({ length: n }, (_, i) => makeNode(`s${i}`, 'float', { value: 1 }));
    const edges = srcs.map((s, i) => makeEdge(s.id, 'out', 'op', chainPortId(i)));
    return { op, edges };
  };

  it('a 2-operand op keeps its flat base (no regression)', () => {
    const { op, edges } = wire(2, 'add'); // add base = 1
    expect(nodeCostPoints(op, edges)).toBe(1);
    const m = wire(2, 'mul'); // mul base = 1
    expect(nodeCostPoints(m.op, m.edges)).toBe(1);
    const d = wire(2, 'div'); // div base = 4
    expect(nodeCostPoints(d.op, d.edges)).toBe(4);
  });

  it('scales linearly with operand count', () => {
    const a3 = wire(3, 'add');
    expect(nodeCostPoints(a3.op, a3.edges)).toBe(2); // 1 × (3−1)
    const m6 = wire(6, 'mul');
    expect(nodeCostPoints(m6.op, m6.edges)).toBe(5); // 1 × (6−1)
    const d3 = wire(3, 'div');
    expect(nodeCostPoints(d3.op, d3.edges)).toBe(8); // 4 × (3−1)
  });

  it('an unwired op still costs one operation (base)', () => {
    const op = makeNode('op', 'mul');
    expect(nodeCostPoints(op, [])).toBe(1); // max(1, 2−1) × base
  });

  it('is the flat registry cost for non-chainable nodes', () => {
    // clamp is non-chainable; its cost is whatever the registry says, unscaled
    const clamp = makeNode('c', 'clamp');
    const edges = [makeEdge('x', 'out', 'c', 'x'), makeEdge('y', 'out', 'c', 'min')];
    const flat = nodeCostPoints(clamp, edges);
    const clampAlone = nodeCostPoints(clamp, []);
    expect(flat).toBe(clampAlone); // operand count never changes a non-chainable cost
  });
});

// ── graphToCode: variadic emission ───────────────────────────────────────────
describe('graphToCode — variadic arithmetic emission', () => {
  it('emits a 3-operand add when a third input is wired', () => {
    const a = makeNode('a', 'float', { value: 1 });
    const b = makeNode('b', 'float', { value: 2 });
    const c = makeNode('c', 'float', { value: 3 });
    const op = makeNode('op', 'add');
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('a', 'out', 'op', 'a'),
      makeEdge('b', 'out', 'op', 'b'),
      makeEdge('c', 'out', 'op', 'c'),
      makeEdge('op', 'out', 'out', 'color'),
    ];
    const { code } = graphToCode([a, b, c, op, out], edges);
    expect(code).toMatch(/const add1 = add\(float1, float2, float3\);/);
  });

  it('does not emit the dangling grow socket (no add(a, b, 0))', () => {
    const a = makeNode('a', 'float', { value: 1 });
    const b = makeNode('b', 'float', { value: 2 });
    const op = makeNode('op', 'add');
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('a', 'out', 'op', 'a'),
      makeEdge('b', 'out', 'op', 'b'),
      makeEdge('op', 'out', 'out', 'color'),
    ];
    const { code } = graphToCode([a, b, op, out], edges);
    expect(code).toMatch(/const add1 = add\(float1, float2\);/);
  });

  it('an unwired multiply operand emits the identity 1, not 0', () => {
    const a = makeNode('a', 'float', { value: 5 });
    const op = makeNode('op', 'mul');
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('a', 'out', 'op', 'a'),
      makeEdge('op', 'out', 'out', 'color'),
    ];
    const { code } = graphToCode([a, op, out], edges);
    expect(code).toMatch(/const mul1 = mul\(float1, 1\);/);
  });

  it('fills an interior gap operand with the identity', () => {
    // a and c wired, b left empty → add(float1, 0, float2)
    const a = makeNode('a', 'float', { value: 1 });
    const c = makeNode('c', 'float', { value: 3 });
    const op = makeNode('op', 'add');
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('a', 'out', 'op', 'a'),
      makeEdge('c', 'out', 'op', 'c'),
      makeEdge('op', 'out', 'out', 'color'),
    ];
    const { code } = graphToCode([a, c, op, out], edges);
    expect(code).toMatch(/const add1 = add\(float1, 0, float2\);/);
  });
});

// ── cpuEvaluator: variadic fold ──────────────────────────────────────────────
describe('evaluateNodeOutput — variadic arithmetic', () => {
  const a = makeNode('a', 'float', { value: 2 });
  const b = makeNode('b', 'float', { value: 3 });
  const c = makeNode('c', 'float', { value: 4 });

  it('add(2, 3, 4) = 9', () => {
    const op = makeNode('op', 'add');
    const edges = [
      makeEdge('a', 'out', 'op', 'a'),
      makeEdge('b', 'out', 'op', 'b'),
      makeEdge('c', 'out', 'op', 'c'),
    ];
    expect(evaluateNodeOutput('op', [a, b, c, op], edges, 0)).toEqual([9]);
  });

  it('mul(2, 3, 4) = 24', () => {
    const op = makeNode('op', 'mul');
    const edges = [
      makeEdge('a', 'out', 'op', 'a'),
      makeEdge('b', 'out', 'op', 'b'),
      makeEdge('c', 'out', 'op', 'c'),
    ];
    expect(evaluateNodeOutput('op', [a, b, c, op], edges, 0)).toEqual([24]);
  });

  it('sub left-folds: sub(2, 3, 4) = -5', () => {
    const op = makeNode('op', 'sub');
    const edges = [
      makeEdge('a', 'out', 'op', 'a'),
      makeEdge('b', 'out', 'op', 'b'),
      makeEdge('c', 'out', 'op', 'c'),
    ];
    expect(evaluateNodeOutput('op', [a, b, c, op], edges, 0)).toEqual([-5]);
  });

  it('an unwired multiply operand contributes the identity (2 * 1 = 2)', () => {
    const op = makeNode('op', 'mul');
    const edges = [makeEdge('a', 'out', 'op', 'a')];
    expect(evaluateNodeOutput('op', [a, op], edges, 0)).toEqual([2]);
  });

  it('evaluates stored extension-operand values (imported add(2, 3, 4) = 9)', () => {
    const op = makeNode('op', 'add', { a: 2, b: 3, c: 4 });
    expect(evaluateNodeOutput('op', [op], [], 0)).toEqual([9]);
  });

  it('broadcasts a scalar across a vec3 through the fold', () => {
    const v = makeNode('v', 'vec3', { x: 1, y: 2, z: 3 });
    const s = makeNode('s', 'float', { value: 10 });
    const op = makeNode('op', 'add');
    const edges = [
      makeEdge('v', 'out', 'op', 'a'),
      makeEdge('s', 'out', 'op', 'b'),
      makeEdge('s', 'out', 'op', 'c'),
    ];
    expect(evaluateNodeOutput('op', [v, s, op], edges, 0)).toEqual([21, 22, 23]);
  });
});

// ── cpuEvaluator: range propagation over 3 operands via a texture upstream ────
describe('evaluateNodeRange — variadic arithmetic', () => {
  it('folds interval arithmetic across all wired operands', () => {
    // positionGeometry isn't CPU-evaluable → true interval propagation.
    // Its per-channel range is [-0.8, 0.8]; + 0.5 + 0.5 → [0.2, 1.8].
    // A 2-operand-only fold would wrongly stop at [-0.3, 1.3].
    const pos = makeNode('n', 'positionGeometry');
    const half1 = makeNode('h1', 'float', { value: 0.5 });
    const half2 = makeNode('h2', 'float', { value: 0.5 });
    const op = makeNode('op', 'add');
    const edges = [
      makeEdge('n', 'out', 'op', 'a'),
      makeEdge('h1', 'out', 'op', 'b'),
      makeEdge('h2', 'out', 'op', 'c'),
    ];
    const r = evaluateNodeRange('op', [pos, half1, half2, op], edges, 0)!;
    expect(r.min[0]).toBeCloseTo(0.2);
    expect(r.max[0]).toBeCloseTo(1.8);
  });
});

// ── round-trip: code → graph → code preserves the variadic chain ─────────────
describe('codeToGraph — variadic arithmetic round-trip', () => {
  it('parses add(x, y, z) into three wired operand edges', () => {
    const code = [
      "import { Fn, add, positionLocal, time, normalLocal } from 'three/tsl';",
      'const shader = Fn(() => {',
      '  const sum1 = add(positionLocal, time, normalLocal);',
      '  return sum1;',
      '});',
      'export default shader;',
    ].join('\n');
    const { nodes, edges } = codeToGraph(code);
    const addNode = nodes.find((n) => n.data.registryType === 'add')!;
    expect(addNode).toBeTruthy();
    const handles = edges
      .filter((e) => e.target === addNode.id)
      .map((e) => e.targetHandle)
      .sort();
    expect(handles).toEqual(['a', 'b', 'c']);
  });

  it('preserves trailing literal operands through code → graph → code', () => {
    // Imported/pasted code with literal operands beyond the base two must not
    // silently drop the extras on re-emit.
    const code = [
      "import { Fn, add } from 'three/tsl';",
      'const shader = Fn(() => {',
      '  const sum1 = add(1, 2, 3);',
      '  return sum1;',
      '});',
      'export default shader;',
    ].join('\n');
    const { nodes, edges } = codeToGraph(code);
    const regen = graphToCode(nodes, edges).code;
    expect(regen).toMatch(/add\(1, 2, 3\)/);
  });

  it('preserves a wired operand + trailing literals (add(x, 2, 3))', () => {
    const code = [
      "import { Fn, add, positionLocal } from 'three/tsl';",
      'const shader = Fn(() => {',
      '  const sum1 = add(positionLocal, 2, 3);',
      '  return sum1;',
      '});',
      'export default shader;',
    ].join('\n');
    const { nodes, edges } = codeToGraph(code);
    const regen = graphToCode(nodes, edges).code;
    expect(regen).toMatch(/add\(\w+, 2, 3\)/);
  });

  it('graphToCode → codeToGraph → graphToCode is stable for a 3-operand add', () => {
    const a = makeNode('a', 'positionLocal');
    const b = makeNode('b', 'time');
    const c = makeNode('c', 'normalLocal');
    const op = makeNode('op', 'add');
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('a', 'out', 'op', 'a'),
      makeEdge('b', 'out', 'op', 'b'),
      makeEdge('c', 'out', 'op', 'c'),
      makeEdge('op', 'out', 'out', 'color'),
    ];
    const gen1 = graphToCode([a, b, c, op, out], edges).code;
    const parsed = codeToGraph(gen1);
    const gen2 = graphToCode(parsed.nodes, parsed.edges).code;
    // The variadic add survives the round-trip with all three operands.
    expect(gen2).toMatch(/add\([^)]*,[^)]*,[^)]*\)/);
    const addNode = parsed.nodes.find((n) => n.data.registryType === 'add')!;
    const handles = parsed.edges
      .filter((e) => e.target === addNode.id)
      .map((e) => e.targetHandle)
      .sort();
    expect(handles).toEqual(['a', 'b', 'c']);
  });
});

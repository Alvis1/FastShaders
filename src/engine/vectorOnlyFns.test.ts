import { describe, it, expect } from 'vitest';
import { graphToCode, VECTOR_ONLY_FNS } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { evaluateNodeOutput, evaluateNodeRange } from './cpuEvaluator';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge } from '@/types';

/**
 * WGSL defines `dot` and `normalize` on VECTORS only, where GLSL takes scalars
 * too — so an all-scalar Dot or Normalize compiled on WebGL and took the whole
 * module down on WebGPU, and a CONSTANT SDF field's normal (four taps summing
 * to the zero vector) failed the same way (2026-10-28, measured on both).
 */

const code = (nodes: AppNode[], edges: AppEdge[]) => graphToCode(nodes, edges).code;
const typeOf = (g: { nodes: AppNode[] }, id: string) => g.nodes.find((n) => n.id === id)?.data.registryType;
const wires = (g: { nodes: AppNode[]; edges: AppEdge[] }) =>
  g.edges.map((e) => `${typeOf(g, e.source)}.${e.sourceHandle}->${typeOf(g, e.target)}.${e.targetHandle}`).sort();

function expectFixedPoint(nodes: AppNode[], edges: AppEdge[]) {
  const a = code(nodes, edges);
  const g = codeToGraph(a);
  expect(g.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
  expect(g.nodes).toHaveLength(nodes.length);
  expect(code(g.nodes, g.edges)).toBe(a);
}

describe('an all-scalar dot / normalize goes in over vec3s', () => {
  it('VECTOR_ONLY_FNS is exactly the two (cross builds its operands as vec3 itself)', () => {
    expect([...VECTOR_ONLY_FNS].sort()).toEqual(['dot', 'normalize']);
  });

  it('Float → Dot (b unwired) and Float → Normalize emit vec3s; the labels follow', () => {
    const nodes = [makeNode('f', 'float', { value: 2 }), makeNode('g', 'float', { value: 3 }), makeNode('dt', 'dot'), makeNode('nm', 'normalize'), makeNode('o', 'output')];
    const edges = [
      makeEdge('f', 'out', 'dt', 'a'), makeEdge('g', 'out', 'dt', 'b'), makeEdge('f', 'out', 'nm', 'v'),
      makeEdge('dt', 'out', 'o', 'roughness'), makeEdge('nm', 'out', 'o', 'color'),
    ];
    const c = code(nodes, edges);
    expect(c).toContain('const dot1 = dot(vec3(float1), vec3(float2));');
    expect(c).toContain('const normalize1 = normalize(vec3(float1));');
    expect(evaluateNodeOutput('dt', nodes, edges, 0)).toEqual([18]); // (2,2,2)·(3,3,3)
    const r = evaluateNodeRange('dt', nodes, edges)!;
    expect([r.min[0], r.max[0]]).toEqual([18, 18]);
    const n = evaluateNodeOutput('nm', nodes, edges, 0)!;
    expect(n).toHaveLength(3);
    for (const v of n) expect(v).toBeCloseTo(1 / Math.sqrt(3), 12);
    expectFixedPoint(nodes, edges);
  });

  it('one vector operand leaves the call exactly as it was (three converts the scalar itself)', () => {
    const nodes = [makeNode('p', 'positionLocal'), makeNode('dt', 'dot'), makeNode('o', 'output')];
    expect(code(nodes, [makeEdge('p', 'out', 'dt', 'a'), makeEdge('dt', 'out', 'o', 'roughness')])).toContain('const dot1 = dot(positionLocal1, 0);');
  });

  it('an Int into Dot round-trips (the widening wraps its promotion)', () => {
    const nodes = [makeNode('i', 'int', { value: 2 }), makeNode('dt', 'dot'), makeNode('o', 'output')];
    const edges = [makeEdge('i', 'out', 'dt', 'a'), makeEdge('dt', 'out', 'o', 'roughness')];
    expect(code(nodes, edges)).toContain('dot(vec3(float(int1)), vec3(0))');
    expectFixedPoint(nodes, edges);
  });

  it('a hand-written dot(vec3(x), vec3(y)) reads back as the two wires', () => {
    const g = codeToGraph(`import { Fn, dot, float, vec3 } from 'three/tsl';\nconst shader = Fn(() => {\n  const x = float(2);\n  const y = float(3);\n  const d = dot(vec3(x), vec3(y));\n  return vec3(d);\n});\nexport default shader;\n`);
    expect(g.nodes.filter((n) => n.data.registryType === 'vec3')).toHaveLength(0);
    expect(wires(g)).toEqual(['dot.out->output.color', 'float.out->dot.a', 'float.out->dot.b']);
  });
});

describe('the widening touches only a CERTAIN scalar, both ways', () => {
  it('a Smoothstep of a vec4 is declared float but is four channels: no widening, w kept', () => {
    const nodes = [
      makeNode('v4', 'vec4', { x: 0.5, y: 0.5, z: 0.5, w: 0.5 }), makeNode('ss', 'smoothstep'), makeNode('f', 'float', { value: 2 }),
      makeNode('dt', 'dot'), makeNode('o', 'output'),
    ];
    const edges = [makeEdge('v4', 'out', 'ss', 'x'), makeEdge('f', 'out', 'dt', 'a'), makeEdge('ss', 'out', 'dt', 'b'), makeEdge('dt', 'out', 'o', 'color')];
    expect(code(nodes, edges)).toContain('const dot1 = dot(float1, smoothstep1);');
    expect(evaluateNodeOutput('dt', nodes, edges, 0)).toEqual([4]); // (2,2,2,2)·(0.5,0.5,0.5,0.5)
  });

  it('a hand-written vec3(<vec4>) NARROWS — it is not read as a widening', () => {
    const g = codeToGraph(`import { Fn, dot, vec3, vec4 } from 'three/tsl';\nconst shader = Fn(() => {\n  const c4 = vec4(1, 2, 3, 4);\n  const d = dot(vec3(c4), vec3(0.2126, 0.7152, 0.0722));\n  return vec3(d);\n});\nexport default shader;\n`);
    expect(wires(g)).not.toContain('vec4.out->dot.a');
  });
});

describe('an SDF Output key light of (0, 0, 0) is no key light, not a WebGPU compile error', () => {
  it('all three stored at 0 emit the zero vector; any other direction is normalized as before', () => {
    const march = (lights: Record<string, number>) => {
      const rm = { ...makeNode('rm', 'raymarchOutput', lights), type: 'raymarchOutput' } as AppNode;
      return code([makeNode('x', 'positionLocal'), makeNode('c', 'sdCircle'), rm], [makeEdge('x', 'out', 'c', 'p'), makeEdge('c', 'out', 'rm', 'field')]);
    };
    expect(march({ lightX: 0, lightY: 0, lightZ: 0 })).toContain('const key = vec3(0, 0, 0);');
    expect(march({})).toContain('const key = normalize(vec3(lightX, lightY, lightZ));');
  });
});

describe('a CONSTANT SDF field faces up instead of normalizing the zero vector', () => {
  const march = (fieldSource: AppNode, extra: AppNode[] = [], extraEdges: AppEdge[] = []): [AppNode[], AppEdge[]] => [
    [fieldSource, ...extra, { ...makeNode('rm', 'raymarchOutput'), type: 'raymarchOutput' } as AppNode],
    [...extraEdges, makeEdge(fieldSource.id, 'out', 'rm', 'field')],
  ];

  it('a Float field emits a fixed normal and round-trips', () => {
    const [nodes, edges] = march(makeNode('f', 'float', { value: 1 }));
    const c = code(nodes, edges);
    expect(c).toContain('const nrm = vec3(0, 1, 0);');
    expect(c).not.toContain('return normalize(g);');
    expectFixedPoint(nodes, edges);
  });

  it('a field that reads the ray position keeps its gradient normal', () => {
    const [nodes, edges] = march(makeNode('c', 'sdCircle'), [makeNode('x', 'positionLocal')], [makeEdge('x', 'out', 'c', 'p')]);
    const c = code(nodes, edges);
    expect(c).toContain('return normalize(g);');
    expect(c).not.toContain('const nrm = vec3(0, 1, 0);');
  });
});

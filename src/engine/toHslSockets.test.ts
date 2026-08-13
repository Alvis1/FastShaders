/**
 * The RGB-to-HSL node's per-component output sockets (h/s/l).
 *
 * Three properties have to hold together, and each fails in a way the others
 * cannot catch:
 *  1. EMISSION — one `toHsl(...)` call, addressed by swizzle, so the node
 *     costs one conversion however many sockets are wired.
 *  2. ROUND-TRIP — `toHsl1.x` must parse back to the node's `h` handle. If it
 *     mints a Split node instead, the code and the picture stay CORRECT while
 *     the graph grows a node on every Apply, so byte-equality alone passes.
 *  3. HONESTY — the CPU side must project the same channel the shader reads,
 *     or the on-node label prints Hue in live blue beside a Saturation wire.
 */
import { describe, it, expect } from 'vitest';
import { graphToCode, TOHSL_HANDLE_TO_COMPONENT } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import {
  evaluateEdgeSource,
  evaluateEdgeRange,
  getEdgeOutputShape,
  handleSlice,
  evaluateNodeOutput,
} from './cpuEvaluator';
import { edgeValueLabel } from '@/components/NodeEditor/nodes/ShaderNode';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge } from '@/types';

/** color → toHsl, plus whatever the caller wires downstream. */
function hslGraph(extra: AppNode[] = [], extraEdges: AppEdge[] = [], hex = '#3366cc') {
  const c = makeNode('c', 'color', { hex });
  const th = makeNode('th', 'toHsl');
  const out = makeNode('out', 'output');
  return {
    nodes: [c, th, ...extra, out],
    edges: [makeEdge('c', 'out', 'th', 'rgb'), ...extraEdges],
  };
}

describe('toHsl — emission', () => {
  it('addresses h/s/l as swizzles of ONE emitted call', () => {
    const mh = makeNode('mh', 'mul');
    const ms = makeNode('ms', 'mul');
    const ml = makeNode('ml', 'mul');
    const { nodes, edges } = hslGraph(
      [mh, ms, ml],
      [
        makeEdge('th', 'h', 'mh', 'a'),
        makeEdge('th', 's', 'ms', 'a'),
        makeEdge('th', 'l', 'ml', 'a'),
        makeEdge('mh', 'out', 'out', 'color'),
      ],
    );
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('toHsl1.x');
    expect(code).toContain('toHsl1.y');
    expect(code).toContain('toHsl1.z');
    // ONE conversion, not one per socket — three separate calls would inline
    // the helper Fn three times (~2.5× the GLSL) and the cost badge would lie.
    expect(code.match(/= toHsl\(/g) ?? []).toHaveLength(1);
  });

  it('emits the bare variable for `out`, a null handle, and a tampered handle', () => {
    // Byte-stability: this is the shape every pre-existing graph and every
    // already-exported shader carries.
    // 'constructor'/'toString'/'__proto__' pin the Map conversion: a Record
    // lookup resolved them through the prototype chain to a truthy Function,
    // which was stringified into the module as a SyntaxError.
    for (const handle of ['out', null, 'q', 'constructor', 'toString', '__proto__']) {
      const { nodes, edges } = hslGraph([], [makeEdge('th', handle as string, 'out', 'color')]);
      const { code } = graphToCode(nodes, edges);
      expect(code, `handle ${String(handle)}`).toContain('return toHsl1;');
      expect(code, `handle ${String(handle)}`).not.toContain('toHsl1.undefined');
      expect(code, `handle ${String(handle)}`).not.toContain('native code');
    }
  });

  it('widens a scalar socket wired to a vec3 channel', () => {
    // h is float, Color is vec3: without the widen TSL splats hue into ALPHA.
    const { nodes, edges } = hslGraph([], [makeEdge('th', 'h', 'out', 'color')]);
    expect(graphToCode(nodes, edges).code).toContain('return vec3(toHsl1.x);');
  });
});

describe('toHsl — round trip', () => {
  const stable = (nodes: AppNode[], edges: AppEdge[]) => {
    const code1 = graphToCode(nodes, edges).code;
    const parsed = codeToGraph(code1);
    expect(parsed.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    const code2 = graphToCode(parsed.nodes, parsed.edges).code;
    return { code1, code2, parsed };
  };

  it('never mints a Split node — the defect byte-equality cannot catch', () => {
    const m = makeNode('m', 'mul');
    const { nodes, edges } = hslGraph(
      [m],
      [makeEdge('th', 's', 'm', 'a'), makeEdge('m', 'out', 'out', 'color')],
    );
    const { code1, code2, parsed } = stable(nodes, edges);
    expect(code2).toBe(code1);
    expect(parsed.nodes.filter((n) => n.data.registryType === 'split')).toHaveLength(0);
    // The wire must land on the toHsl node's own `s` socket.
    const th = parsed.nodes.find((n) => n.data.registryType === 'toHsl');
    expect(parsed.edges.some((e) => e.source === th?.id && e.sourceHandle === 's')).toBe(true);
  });

  it('is stable with all three sockets wired', () => {
    const a = makeNode('a', 'vec3');
    const { nodes, edges } = hslGraph(
      [a],
      [
        makeEdge('th', 'h', 'a', 'x'),
        makeEdge('th', 's', 'a', 'y'),
        makeEdge('th', 'l', 'a', 'z'),
        makeEdge('a', 'out', 'out', 'color'),
      ],
    );
    const { code1, code2, parsed } = stable(nodes, edges);
    expect(code2).toBe(code1);
    expect(parsed.nodes.filter((n) => n.data.registryType === 'split')).toHaveLength(0);
  });

  it('is stable with `out` AND `h` wired from the same node', () => {
    const m = makeNode('m', 'mul');
    const { nodes, edges } = hslGraph(
      [m],
      [
        makeEdge('th', 'out', 'out', 'color'),
        makeEdge('th', 'h', 'm', 'a'),
        makeEdge('m', 'out', 'out', 'emissive'),
      ],
    );
    const { code1, code2, parsed } = stable(nodes, edges);
    expect(code2).toBe(code1);
    expect(parsed.nodes.filter((n) => n.data.registryType === 'split')).toHaveLength(0);
  });

  it('collapses the widened scalar back to a DIRECT h→color edge', () => {
    const { nodes, edges } = hslGraph([], [makeEdge('th', 'h', 'out', 'color')]);
    const { code1, code2, parsed } = stable(nodes, edges);
    expect(code2).toBe(code1);
    // Not a Vec3 node with y/z = 0 (unwrapScalarWiden's job).
    expect(parsed.nodes.filter((n) => n.data.registryType === 'vec3')).toHaveLength(0);
  });

  it('leaves a genuine swizzle on a non-toHsl variable as a Split node', () => {
    // Non-regression: ONLY a toHsl source short-circuits the split path.
    const parsed = codeToGraph(`
      import { Fn, vec3, mul, uv } from 'three/tsl';
      const shader = Fn(() => {
        const uv1 = uv();
        const m1 = mul(uv1.y, 2);
        return vec3(m1, 0, 0);
      });
      export default shader;
    `);
    expect(parsed.nodes.filter((n) => n.data.registryType === 'split').length).toBeGreaterThan(0);
  });

  it('sends toHsl `.w` down the Split path — there is no fourth HSL channel', () => {
    const parsed = codeToGraph(`
      import { Fn, vec3, mul, color } from 'three/tsl';
      const toHsl = Fn(([rgb]) => { return rgb; });
      const shader = Fn(() => {
        const color1 = color(0x3366cc);
        const toHsl1 = toHsl(color1);
        const m1 = mul(toHsl1.w, 2);
        return vec3(m1, 0, 0);
      });
      export default shader;
    `);
    expect(parsed.nodes.filter((n) => n.data.registryType === 'split').length).toBeGreaterThan(0);
  });
});

describe('toHsl — per-socket evaluation (the honesty contract)', () => {
  // #3366cc: H ≈ 0.611, S = 0.6, L = 0.5 — three values that cannot be
  // confused for one another.
  const { nodes, edges } = hslGraph();
  const whole = evaluateNodeOutput('th', nodes, edges, 0)!;

  it('projects each socket onto its own channel', () => {
    expect(whole).toHaveLength(3);
    for (const [handle, i] of [['h', 0], ['s', 1], ['l', 2]] as const) {
      const v = evaluateEdgeSource({ source: 'th', sourceHandle: handle }, nodes, edges, 0);
      expect(v, handle).toEqual([whole[i]]);
    }
    // Distinct enough that a wrong projection cannot pass by coincidence.
    expect(new Set(whole).size).toBe(3);
  });

  it('returns the whole vector for `out` and a null handle', () => {
    expect(evaluateEdgeSource({ source: 'th', sourceHandle: 'out' }, nodes, edges, 0)).toEqual(whole);
    expect(evaluateEdgeSource({ source: 'th', sourceHandle: null }, nodes, edges, 0)).toEqual(whole);
  });

  it('reports 1 channel per component socket and 3 for `out`', () => {
    // `computeShape` resolves `outputs.find(id === 'out') ?? outputs[0]`, so
    // without the per-handle port lookup EVERY socket would report 3 and a
    // Lightness wire would draw a 3-line ribbon.
    for (const h of ['h', 's', 'l']) {
      expect(getEdgeOutputShape({ source: 'th', sourceHandle: h }, nodes, edges), h).toBe(1);
    }
    expect(getEdgeOutputShape({ source: 'th', sourceHandle: 'out' }, nodes, edges)).toBe(3);
  });

  it('the on-node label shows the socket the wire actually carries', () => {
    const s = edgeValueLabel('th', nodes, edges, 's');
    const l = edgeValueLabel('th', nodes, edges, 'l');
    expect(s.text).toBe('0.6');
    expect(l.text).toBe('0.5');
    expect(s.text).not.toBe(l.text);
  });

  it('projects an inferred RANGE, never re-deriving it', () => {
    const r = evaluateEdgeRange({ source: 'th', sourceHandle: 's' }, nodes, edges, 0);
    expect(r?.min).toHaveLength(1);
    expect(r?.max).toHaveLength(1);
  });

  it('terminates on a cycle through the node (the nodeId sentinel still holds)', () => {
    // Slicing happens at the CONSUMER, after the cache read, precisely so the
    // per-node cycle sentinel keeps working. A per-handle cache key would let
    // a cycle re-entering through a different socket escape the guard.
    const th = makeNode('th', 'toHsl');
    const m = makeNode('m', 'mul');
    const cyc = [makeEdge('th', 'h', 'm', 'a'), makeEdge('m', 'out', 'th', 'rgb')];
    expect(() => evaluateEdgeSource({ source: 'th', sourceHandle: 'l' }, [th, m], cyc, 0)).not.toThrow();
  });
});

describe('toHsl — CPU/GPU channel parity', () => {
  it('handleSlice agrees with the emitted swizzle', () => {
    // The two directions are written in different files; swapping S and L in
    // one of them is invisible by inspection and silently wrong on screen.
    const th = makeNode('th', 'toHsl');
    const COMPONENT_INDEX: Record<string, number> = { x: 0, y: 1, z: 2 };
    for (const handle of ['h', 's', 'l']) {
      expect(handleSlice(th, handle), handle).toBe(
        COMPONENT_INDEX[TOHSL_HANDLE_TO_COMPONENT.get(handle)!],
      );
    }
    expect(handleSlice(th, 'out')).toBeNull();
  });

  it('slices a Split node by its own component handles', () => {
    const sp = makeNode('sp', 'split');
    expect(handleSlice(sp, 'x')).toBe(0);
    expect(handleSlice(sp, 'w')).toBe(3);
    expect(handleSlice(sp, 'out')).toBeNull();
  });
});

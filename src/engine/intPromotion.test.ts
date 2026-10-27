import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { evaluateNodeOutput, evaluateNodeRange } from './cpuEvaluator';
import { isIntSource, promotesIntWire, type IntGraph } from './intPromotion';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge } from '@/types';

/**
 * An INT that meets a FLOAT is a FLOAT (owner, 2026-10-27: "int — always change
 * to float where there is float"). three r184 gives an operation its FIRST
 * operand's type on a tie, so `mul(int1, 0.3)` built `( 4 * 0 )` — the float
 * became an int. graphToCode now wraps such an int in `float(…)`, codeToGraph
 * reads the wrapper back as the plain wire, and the evaluator computes what the
 * shader does: float wherever a float takes part, whole-number arithmetic only
 * where every operand is an Int.
 */

const code = (nodes: AppNode[], edges: AppEdge[]) => graphToCode(nodes, edges).code;
const parse = (body: string) =>
  codeToGraph(`import { Fn, add, div, float, int, mul, vec3 } from 'three/tsl';\nconst shader = Fn(() => {\n${body}\n});\nexport default shader;\n`);
const intWarnings = <E extends { message: string }>(errors: E[]) => errors.filter((e) => /operation on Ints alone/.test(e.message));
const typeOf = (g: { nodes: AppNode[] }, id: string) => g.nodes.find((n) => n.id === id)?.data.registryType;
const wires = (g: { nodes: AppNode[]; edges: AppEdge[] }) =>
  g.edges.map((e) => `${typeOf(g, e.source)}.${e.sourceHandle}->${typeOf(g, e.target)}.${e.targetHandle}`).sort();

/** graphToCode → codeToGraph → graphToCode lands on the same text, with no Float node grown. */
function expectFixedPoint(nodes: AppNode[], edges: AppEdge[]) {
  const a = code(nodes, edges);
  const parsed = codeToGraph(a);
  expect(parsed.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
  expect(intWarnings(parsed.errors)).toEqual([]);
  expect(parsed.nodes.filter((n) => n.data.registryType === 'float').length)
    .toBe(nodes.filter((n) => n.data.registryType === 'float').length);
  expect(code(parsed.nodes, parsed.edges)).toBe(a);
  return parsed;
}

const intTimesStored = (): [AppNode[], AppEdge[]] => [
  [makeNode('i', 'int', { value: 4 }), makeNode('m', 'mul', { b: 0.3 }), makeNode('o', 'output')],
  [makeEdge('i', 'out', 'm', 'a'), makeEdge('m', 'out', 'o', 'color')],
];
const intOverInt = (x = 7, y = 2): [AppNode[], AppEdge[]] => [
  [makeNode('i', 'int', { value: x }), makeNode('j', 'int', { value: y }), makeNode('d', 'div'), makeNode('o', 'output')],
  [makeEdge('i', 'out', 'd', 'a'), makeEdge('j', 'out', 'd', 'b'), makeEdge('d', 'out', 'o', 'color')],
];

describe('graphToCode: an int that meets a float is wrapped in float(…)', () => {
  it('Int 4 × 0.3 multiplies as floats (three built ( 4 * 0 ) before)', () => {
    const c = code(...intTimesStored());
    expect(c).toContain('const mul1 = mul(float(int1), 0.3);');
    expect(c).toMatch(/import \{[^}]*\bfloat\b[^}]*\} from 'three\/tsl';/);
  });

  it('a Float node on either side promotes the Int', () => {
    const nodes = [makeNode('f', 'float', { value: 0.5 }), makeNode('i', 'int', { value: 3 }), makeNode('a', 'add'), makeNode('o', 'output')];
    expect(code(nodes, [makeEdge('f', 'out', 'a', 'a'), makeEdge('i', 'out', 'a', 'b'), makeEdge('a', 'out', 'o', 'color')]))
      .toContain('add(float1, float(int1))');
    expect(code(nodes, [makeEdge('i', 'out', 'a', 'a'), makeEdge('f', 'out', 'a', 'b'), makeEdge('a', 'out', 'o', 'color')]))
      .toContain('add(float(int1), float1)');
  });

  it('an operation on Ints alone stays whole-number: Int 7 ÷ Int 2 is the int 3', () => {
    const c = code(...intOverInt());
    expect(c).toContain('const div1 = div(int1, int2);');
    expect(c).toContain('return vec3(float(div1));'); // the Output channel is a float
  });

  it('an all-int result meeting a float is promoted where it meets it', () => {
    const nodes = [
      makeNode('i', 'int', { value: 4 }), makeNode('j', 'int', { value: 3 }), makeNode('a', 'add'),
      makeNode('m', 'mul', { b: 0.5 }), makeNode('o', 'output'),
    ];
    const edges = [
      makeEdge('i', 'out', 'a', 'a'), makeEdge('j', 'out', 'a', 'b'),
      makeEdge('a', 'out', 'm', 'a'), makeEdge('m', 'out', 'o', 'color'),
    ];
    const c = code(nodes, edges);
    expect(c).toContain('const add1 = add(int1, int2);');
    expect(c).toContain('const mul1 = mul(float(add1), 0.5);');
  });

  it('an unwired operand is a FLOAT literal, so it promotes its int partner', () => {
    const nodes = [makeNode('i', 'int', { value: 7 }), makeNode('md', 'mod'), makeNode('o', 'output')];
    expect(code(nodes, [makeEdge('i', 'out', 'md', 'x'), makeEdge('md', 'out', 'o', 'color')]))
      .toContain('mod(float(int1), 1)');
  });

  it('a float function of an Int reads it as a float (sin(int) does not compile on GLSL ES)', () => {
    const nodes = [makeNode('i', 'int', { value: 2 }), makeNode('s', 'sin'), makeNode('o', 'output')];
    expect(code(nodes, [makeEdge('i', 'out', 's', 'x'), makeEdge('s', 'out', 'o', 'color')])).toContain('sin(float(int1))');
  });

  it('a Split of an Int is still an int; the wrapper goes where it meets the float', () => {
    const nodes = [
      makeNode('i', 'int', { value: 3 }), makeNode('sp', 'split'), makeNode('f', 'float', { value: 0.5 }),
      makeNode('m', 'mul'), makeNode('o', 'output'),
    ];
    const edges = [
      makeEdge('i', 'out', 'sp', 'v'), makeEdge('sp', 'x', 'm', 'a'), makeEdge('f', 'out', 'm', 'b'),
      makeEdge('m', 'out', 'o', 'color'),
    ];
    expect(code(nodes, edges)).toContain('mul(float(int1.x), float1)');
  });

  it('Abs and Clamp of Ints stay ints; Min and Max are promoted (WebGL builds min( 4, 3.0 ))', () => {
    const abs = code(
      [makeNode('i', 'int', { value: -7 }), makeNode('a', 'abs'), makeNode('j', 'int', { value: 2 }), makeNode('d', 'div'), makeNode('o', 'output')],
      [makeEdge('i', 'out', 'a', 'x'), makeEdge('a', 'out', 'd', 'a'), makeEdge('j', 'out', 'd', 'b'), makeEdge('d', 'out', 'o', 'color')],
    );
    expect(abs).toContain('const abs1 = abs(int1);');
    expect(abs).toContain('const div1 = div(abs1, int2);');
    const clamp = code(
      [makeNode('i', 'int', { value: 9 }), makeNode('lo', 'int', { value: 0 }), makeNode('hi', 'int', { value: 5 }), makeNode('c', 'clamp'), makeNode('o', 'output')],
      [makeEdge('i', 'out', 'c', 'x'), makeEdge('lo', 'out', 'c', 'min'), makeEdge('hi', 'out', 'c', 'max'), makeEdge('c', 'out', 'o', 'color')],
    );
    expect(clamp).toContain('clamp(int1, int2, int3)');
    for (const type of ['min', 'max']) {
      const c = code(
        [makeNode('i', 'int', { value: 4 }), makeNode('j', 'int', { value: 3 }), makeNode('m', type), makeNode('o', 'output')],
        [makeEdge('i', 'out', 'm', 'a'), makeEdge('j', 'out', 'm', 'b'), makeEdge('m', 'out', 'o', 'color')],
      );
      expect(c).toContain(`${type}(float(int1), float(int2))`);
    }
  });

  it('an Int is emitted WHOLE, so a stored 2.4 runs as the 2 its label shows', () => {
    const nodes = [makeNode('i', 'int', { value: 2.4 }), makeNode('m', 'mul', { b: 0.5 }), makeNode('o', 'output')];
    const edges = [makeEdge('i', 'out', 'm', 'a'), makeEdge('m', 'out', 'o', 'color')];
    expect(code(nodes, edges)).toContain('const int1 = int(2);');
    expect(evaluateNodeOutput('m', nodes, edges, 0)).toEqual([1]);
  });

  it('a wire codegen resolves to nothing is no int operand (a Split socket that is not a swizzle)', () => {
    const nodes = [
      makeNode('i', 'int', { value: 4 }), makeNode('k', 'int', { value: 5 }), makeNode('sp', 'split'),
      makeNode('m', 'mul', { b: 0.3 }), makeNode('o', 'output'),
    ];
    const edges = [
      makeEdge('k', 'out', 'sp', 'v'), makeEdge('i', 'out', 'm', 'a'), makeEdge('sp', 'out', 'm', 'b'),
      makeEdge('m', 'out', 'o', 'color'),
    ];
    expect(code(nodes, edges)).toContain('mul(float(int1), 0.3)');
    expect(evaluateNodeOutput('m', nodes, edges, 0)![0]).toBeCloseTo(1.2, 12);
  });

  it('an all-int result past the i32 range is a FLOAT operation (it wrapped on WebGL, failed on WebGPU)', () => {
    const product = (x: number, y: number): [AppNode[], AppEdge[]] => [
      [makeNode('i', 'int', { value: x }), makeNode('j', 'int', { value: y }), makeNode('m', 'mul'), makeNode('o', 'output')],
      [makeEdge('i', 'out', 'm', 'a'), makeEdge('j', 'out', 'm', 'b'), makeEdge('m', 'out', 'o', 'color')],
    ];
    const big = product(50000, 50000);
    expect(code(...big)).toContain('mul(float(int1), float(int2))');
    expect(evaluateNodeOutput('m', ...big, 0)).toEqual([2500000000]);
    expectFixedPoint(...big);
    expect(code(...product(300, 7))).toContain('mul(int1, int2)'); // one that fits stays whole
  });

  it('an Int literal is clamped to ±2147483647, its label too', () => {
    const nodes = [makeNode('i', 'int', { value: 3e9 }), makeNode('o', 'output')];
    expect(code(nodes, [makeEdge('i', 'out', 'o', 'color')])).toContain('const int1 = int(2147483647);');
    expect(evaluateNodeOutput('i', nodes, [], 0)).toEqual([2147483647]);
  });

  it('an SDF Output number socket converts its Int once (it read float(float(int1)))', () => {
    const rm = { ...makeNode('rm', 'raymarchOutput'), type: 'raymarchOutput' } as AppNode;
    const nodes = [makeNode('i', 'int', { value: 3 }), makeNode('x', 'positionLocal'), makeNode('c', 'sdCircle'), rm];
    const edges = [makeEdge('i', 'out', 'rm', 'stepScale'), makeEdge('x', 'out', 'c', 'p'), makeEdge('c', 'out', 'rm', 'field')];
    expect(code(nodes, edges)).toContain('const stepScale = float(int1);');
    expectFixedPoint(nodes, edges);
  });

  it('an int-typed socket keeps the int (UV Channel)', () => {
    const nodes = [makeNode('i', 'int', { value: 1 }), makeNode('u', 'uv'), makeNode('o', 'output')];
    const c = code(nodes, [makeEdge('i', 'out', 'u', 'channel'), makeEdge('u', 'out', 'o', 'color')]);
    expect(c).toContain('fsUvChannel(int1)');
    expect(c).not.toContain('float(int1)');
  });

  it('float is imported only when a wrapper reaches the module (Sound smoothing is read CPU-side)', () => {
    const nodes = [makeNode('i', 'int', { value: 4 }), makeNode('snd', 'soundNode'), makeNode('o', 'output')];
    const c = code(nodes, [makeEdge('i', 'out', 'snd', 'smoothing'), makeEdge('snd', 'level', 'o', 'color')]);
    expect(c).not.toContain('float(int1)');
    expect(c).not.toMatch(/import \{[^}]*\bfloat\b[^}]*\} from 'three\/tsl';/);
  });

  it('a graph with no Int node gains no wrapper', () => {
    const nodes = [makeNode('f', 'float', { value: 4 }), makeNode('m', 'mul', { b: 0.3 }), makeNode('o', 'output')];
    const c = code(nodes, [makeEdge('f', 'out', 'm', 'a'), makeEdge('m', 'out', 'o', 'color')]);
    expect(c).toContain('const mul1 = mul(float1, 0.3);');
  });
});

describe('codeToGraph reads the wrapper back as the plain wire', () => {
  it('Int × stored float: no Float node grows, the Int → Multiply wire survives', () => {
    const parsed = expectFixedPoint(...intTimesStored());
    expect(wires(parsed)).toEqual(['int.out->mul.a', 'mul.out->output.color']);
  });

  it('every shape above is a fixed point', () => {
    expectFixedPoint(...intOverInt());
    const split: [AppNode[], AppEdge[]] = [
      [makeNode('i', 'int', { value: 3 }), makeNode('sp', 'split'), makeNode('f', 'float', { value: 0.5 }), makeNode('m', 'mul'), makeNode('o', 'output')],
      [makeEdge('i', 'out', 'sp', 'v'), makeEdge('sp', 'x', 'm', 'a'), makeEdge('f', 'out', 'm', 'b'), makeEdge('m', 'out', 'o', 'color')],
    ];
    expect(wires(expectFixedPoint(...split))).toContain('split.x->mul.a');
    expectFixedPoint(
      [makeNode('i', 'int', { value: 2 }), makeNode('s', 'sin'), makeNode('o', 'output')],
      [makeEdge('i', 'out', 's', 'x'), makeEdge('s', 'out', 'o', 'color')],
    );
  });

  it('the wrapper inside a Raymarch field Fn and a Density return round-trips', () => {
    for (const port of ['field', 'density']) {
      const rm = { ...makeNode('rm', 'raymarchOutput'), type: 'raymarchOutput' } as AppNode;
      const nodes = [makeNode('i', 'int', { value: 4 }), rm];
      expect(code(nodes, [makeEdge('i', 'out', 'rm', port)])).toContain('float(int1)');
      expectFixedPoint(nodes, [makeEdge('i', 'out', 'rm', port)]);
    }
  });

  /** Every socket, fed by three int SOURCE shapes, round-trips as well as a Float would. */
  it('sweep: every registry socket × bare Int / Split of an Int / all-int Add', () => {
    const sources: Record<string, (k: 'int' | 'float') => { nodes: AppNode[]; edges: AppEdge[]; from: [string, string] }> = {
      bare: (k) => ({ nodes: [makeNode('s', k, { value: 4 })], edges: [], from: ['s', 'out'] }),
      split: (k) => ({ nodes: [makeNode('s', k, { value: 4 }), makeNode('sp', 'split')], edges: [makeEdge('s', 'out', 'sp', 'v')], from: ['sp', 'x'] }),
      addPair: (k) => ({
        nodes: [makeNode('s', k, { value: 4 }), makeNode('s2', k, { value: 3 }), makeNode('ad', 'add')],
        edges: [makeEdge('s', 'out', 'ad', 'a'), makeEdge('s2', 'out', 'ad', 'b')],
        from: ['ad', 'out'],
      }),
    };
    const SINKS = new Set(['output', 'raymarchOutput', 'splatOutput']);
    const trip = (nodes: AppNode[], edges: AppEdge[]) => {
      const a = code(nodes, edges);
      const parsed = codeToGraph(a);
      return { a, b: code(parsed.nodes, parsed.edges), warned: intWarnings(parsed.errors).length > 0 };
    };
    const failures: string[] = [];
    let pairs = 0;
    for (const [shape, make] of Object.entries(sources)) {
      for (const [type, def] of NODE_REGISTRY) {
        if (type === 'unknown' || type === 'dataNode' || type === 'int' || type === 'float') continue;
        for (const p of def.inputs) {
          const run = (k: 'int' | 'float') => {
            const s = make(k);
            if (SINKS.has(type)) {
              const sink = { ...makeNode('t', type), type: type === 'output' ? 'output' : type } as AppNode;
              return trip([...s.nodes, sink], [...s.edges, makeEdge(s.from[0], s.from[1], 't', p.id)]);
            }
            const out = def.outputs[0]?.id;
            return trip(
              [...s.nodes, makeNode('t', type), makeNode('o', 'output')],
              [...s.edges, makeEdge(s.from[0], s.from[1], 't', p.id), ...(out ? [makeEdge('t', out, 'o', 'color')] : [])],
            );
          };
          pairs++;
          const f = run('float');
          const i = run('int');
          if (f.a === f.b && i.a !== i.b) failures.push(`[${shape}] ${type}.${p.id} is no longer a fixed point`);
          if (i.warned) failures.push(`[${shape}] ${type}.${p.id} warned on graphToCode's own output`);
        }
      }
    }
    expect(pairs).toBeGreaterThan(500);
    expect(failures).toEqual([]);
  });
});

describe('codeToGraph: a hand-written float() the graph cannot hold is announced', () => {

  it('div(float(a), b) of two Ints is read as the Int, and says so', () => {
    const g = parse('  const a = int(3);\n  const b = int(2);\n  const c = div(float(a), b);\n  return vec3(c);');
    expect(wires(g)).toEqual(['div.out->output.color', 'int.out->div.a', 'int.out->div.b']);
    expect(intWarnings(g.errors)).toHaveLength(1);
    expect(intWarnings(g.errors)[0]).toMatchObject({ severity: 'warning', line: 5 });
    expect(intWarnings(g.errors)[0].message).toMatch(/^float\(a\) /);
  });

  it('a conversion declared first is named by what was written', () => {
    const g = parse('  const a = int(3);\n  const b = int(2);\n  const c = float(a);\n  const d = div(c, b);\n  return vec3(d);');
    expect(intWarnings(g.errors).map((e) => e.message.split(' ')[0])).toEqual(['float(a)']);
  });

  it('the method form is read the same way', () => {
    const g = parse('  const a = int(3);\n  const b = int(2);\n  const c = float(a).div(b);\n  return vec3(c);');
    expect(wires(g)).toEqual(['div.out->output.color', 'int.out->div.a', 'int.out->div.b']);
    expect(intWarnings(g.errors)).toHaveLength(1);
  });

  it('a float() that meets a float anyway loses nothing and says nothing', () => {
    const g = parse('  const a = int(3);\n  const c = float(a).mul(0.5);\n  return vec3(c);');
    expect(wires(g)).toEqual(['int.out->mul.a', 'mul.out->output.color']);
    expect(intWarnings(g.errors)).toEqual([]);
  });

  it('a Fn parameter that shadows an Int is not an Int', () => {
    const g = parse('  const a = int(3);\n  const b = int(2);\n  const f = Fn(([a]) => div(float(a), b));\n  return vec3(a);');
    expect(intWarnings(g.errors)).toEqual([]);
  });

  it('every operand the GRAPH holds as an Int counts: inline int(), .toVar(), a swizzle of the conversion', () => {
    for (const body of [
      '  const a = int(3);\n  const c = div(float(a), int(2));\n  return vec3(c);',
      '  const a = int(3);\n  const b = int(2).toVar();\n  const c = div(float(a), b);\n  return vec3(c);',
      '  const a = int(3);\n  const b = int(2);\n  const c = div(float(a).x, b);\n  return vec3(c);',
    ]) {
      expect(intWarnings(parse(body).errors).map((e) => e.message.split(' ')[0]), body).toEqual(['float(a)']);
    }
  });

  it('no warning where the call never becomes an int node (an unknown function, a Loop, a Noise position)', () => {
    expect(intWarnings(parse('  const a = int(3);\n  const b = int(2);\n  const c = myFn(div(float(a), b));\n  return vec3(c);').errors)).toEqual([]);
    expect(intWarnings(parse('  const a = int(3);\n  const b = int(2);\n  Loop(int(4), () => { const c = div(float(a), b); });\n  return vec3(a);').errors)).toEqual([]);
    const noise = [makeNode('i', 'int', { value: 3 }), makeNode('j', 'int', { value: 2 }), makeNode('n', 'perlin'), makeNode('o', 'output')];
    expectFixedPoint(noise, [makeEdge('i', 'out', 'n', 'pos'), makeEdge('j', 'out', 'n', 'scale'), makeEdge('n', 'out', 'o', 'color')]);
  });

  it('editing the Int a wrapper names keeps the wire: float(<a float>) is the float itself', () => {
    const g = parse('  const int1 = float(4.5);\n  const mul1 = mul(float(int1), 0.3);\n  return vec3(mul1);');
    expect(g.nodes.filter((n) => n.data.registryType === 'float')).toHaveLength(1);
    expect(wires(g)).toEqual(['float.out->mul.a', 'mul.out->output.color']);
    expect(code(g.nodes, g.edges)).toContain('mul(float1, 0.3)');
    const sum = parse('  const int1 = int(4);\n  const add1 = add(int1, 0.5);\n  const mul1 = mul(float(add1), 2);\n  return vec3(mul1);');
    expect(wires(sum)).toEqual(['add.out->mul.a', 'int.out->add.a', 'mul.out->output.color']);
  });

  it('the warning names the Divide/Mod whose value changes, through any int-preserving step', () => {
    const g = parse('  const a = int(3);\n  const b = int(2);\n  const c = add(float(a), b);\n  const d = div(c, b);\n  return vec3(d);');
    expect(intWarnings(g.errors).map((e) => [e.line, e.message.split(' ')[0]])).toEqual([[6, 'float(a)']]);
    // add keeps its value whole-number or not: nothing to announce
    expect(intWarnings(parse('  const a = int(3);\n  const b = int(2);\n  const c = add(float(a), b);\n  return vec3(c);').errors)).toEqual([]);
  });

  it("graphToCode's own Isolines over two Ints parses without a warning", () => {
    const nodes = [makeNode('i', 'int', { value: 3 }), makeNode('j', 'int', { value: 2 }), makeNode('iso', 'isolines'), makeNode('o', 'output')];
    const edges = [makeEdge('i', 'out', 'iso', 'value'), makeEdge('j', 'out', 'iso', 'offset'), makeEdge('iso', 'out', 'o', 'color')];
    expect(intWarnings(codeToGraph(code(nodes, edges)).errors)).toEqual([]);
  });

  it('an imported `time` is a scalar: float(time) is Time itself', () => {
    const g = codeToGraph(`import { Fn, float, mul, time, vec3 } from 'three/tsl';\nconst shader = Fn(() => {\n  const m = mul(float(time), 2.0);\n  return vec3(m);\n});\nexport default shader;\n`);
    expect(wires(g)).toEqual(['mul.out->output.color', 'time.out->mul.a']);
  });

  it('a per-component maths of a VECTOR is not stripped (float(v) is its x); of scalars it is', () => {
    const vector = parse('  const p = vec3(0.2, 0.5, 0.9);\n  const s = smoothstep(0.0, 1.0, p);\n  const m = mul(float(s), 2.0);\n  return vec3(m);');
    expect(wires(vector)).not.toContain('smoothstep.out->mul.a');
    const scalar = parse('  const x = float(0.4);\n  const s = smoothstep(0.0, 1.0, x);\n  const m = mul(float(s), 2.0);\n  return vec3(m);');
    expect(wires(scalar)).toContain('smoothstep.out->mul.a');
  });

  it('a Property named `float` beside a promoted Int keeps the Int wire', () => {
    const nodes = [makeNode('p', 'property_float', { name: 'float', value: 0.5 }), makeNode('i', 'int', { value: 4 }), makeNode('m', 'mul'), makeNode('o', 'output')];
    const edges = [makeEdge('i', 'out', 'm', 'a'), makeEdge('p', 'out', 'm', 'b'), makeEdge('m', 'out', 'o', 'color')];
    const g = codeToGraph(code(nodes, edges));
    expect(wires(g)).toContain('int.out->mul.a');
    expect(g.nodes.filter((n) => n.data.registryType === 'float')).toHaveLength(0);
  });

  it('a duplicate declaration is a parse error, never a throw', () => {
    const g = parse('  const a = int(3);\n  const a = int(4);\n  return vec3(float(a));');
    expect(g.nodes).toEqual([]);
    expect(g.errors[0].message).toMatch(/Duplicate declaration/);
  });
});

describe('a scalar comparison meeting a number is a float too', () => {
  const gtInto = (consumer: AppNode, handle: string, extraEdges: AppEdge[] = []): [AppNode[], AppEdge[]] => [
    [makeNode('f', 'float', { value: 0.25 }), makeNode('gt', 'greaterThan', { b: 0.1 }), consumer, makeNode('o', 'output')],
    [makeEdge('f', 'out', 'gt', 'a'), makeEdge('gt', 'out', consumer.id, handle), ...extraEdges],
  ];

  it('Greater Than → Multiply emits a float (bool × float compiled on neither backend)', () => {
    const [nodes, edges] = gtInto(makeNode('m', 'mul', { b: 2 }), 'a', [makeEdge('m', 'out', 'o', 'color')]);
    expect(code(nodes, edges)).toContain('const mul1 = mul(float(greaterThan1), 2);');
    expect(evaluateNodeOutput('m', nodes, edges, 0)).toEqual([2]);
    expectFixedPoint(nodes, edges);
  });

  it("where a bool is the point it stays one: Select's condition, the Output's Discard", () => {
    const [sNodes, sEdges] = gtInto(makeNode('s', 'select', { a: 1, b: 0 }), 'condition', [makeEdge('s', 'out', 'o', 'color')]);
    expect(code(sNodes, sEdges)).not.toContain('float(greaterThan1)');
    const [dNodes, dEdges] = gtInto(makeNode('m', 'mul', { b: 2 }), 'a', [makeEdge('m', 'out', 'o', 'color'), makeEdge('gt', 'out', 'o', 'discard')]);
    expect(code(dNodes, dEdges)).toMatch(/Discard\(greaterThan1\)|__pixel\(greaterThan1/);
  });

  it('the Output colour keeps its exact old form, vec3(float(<comparison>))', () => {
    const nodes = [makeNode('f', 'float', { value: 0.25 }), makeNode('gt', 'greaterThan', { b: 0.1 }), makeNode('o', 'output')];
    const edges = [makeEdge('f', 'out', 'gt', 'a'), makeEdge('gt', 'out', 'o', 'color')];
    expect(code(nodes, edges)).toContain('return vec3(float(greaterThan1));');
  });

  it('a hand-written float(<comparison>) is read as the wire and re-emitted compiling', () => {
    const g = parse('  const a = float(0.25);\n  const gt = greaterThan(a, 0.1);\n  const m = mul(float(gt), 2.0);\n  return vec3(m);');
    expect(wires(g)).toEqual(['float.out->greaterThan.a', 'greaterThan.out->mul.a', 'mul.out->output.color']);
    expect(code(g.nodes, g.edges)).toContain('mul(float(greaterThan1), 2)');
  });

  it('a comparison over a noise round-trips (operands the parse cannot prove scalar)', () => {
    const nodes = [makeNode('n', 'perlin'), makeNode('gt', 'greaterThan', { b: 0.2 }), makeNode('m', 'mul', { b: 0.5 }), makeNode('o', 'output')];
    expectFixedPoint(nodes, [makeEdge('n', 'out', 'gt', 'a'), makeEdge('gt', 'out', 'm', 'a'), makeEdge('m', 'out', 'o', 'color')]);
  });
});

describe('cpuEvaluator computes what the promoted shader computes', () => {
  it('Int 4 × 0.3 is 1.2', () => {
    const [nodes, edges] = intTimesStored();
    expect(evaluateNodeOutput('m', nodes, edges, 0)![0]).toBeCloseTo(1.2, 12);
  });

  it('Int ÷ Int truncates toward zero; ÷ 0 has no value (WebGPU rejects it, WebGL folds INT_MAX)', () => {
    const at = (x: number, y: number) => {
      const [nodes, edges] = intOverInt(x, y);
      return evaluateNodeOutput('d', nodes, edges, 0)![0];
    };
    expect(at(7, 2)).toBe(3);
    expect(at(-7, 2)).toBe(-3);
    expect(at(7, 0)).toBeNaN();
    const [nodes, edges] = intOverInt(7, 0);
    const r = evaluateNodeRange('d', nodes, edges)!;
    expect([r.min[0], r.max[0]]).toEqual([-Infinity, Infinity]);
  });

  it('Abs keeps the int a following Int ÷ Int divides', () => {
    const nodes = [makeNode('i', 'int', { value: -7 }), makeNode('a', 'abs'), makeNode('j', 'int', { value: 2 }), makeNode('d', 'div')];
    const edges = [makeEdge('i', 'out', 'a', 'x'), makeEdge('a', 'out', 'd', 'a'), makeEdge('j', 'out', 'd', 'b')];
    expect(evaluateNodeOutput('d', nodes, edges, 0)).toEqual([3]);
  });

  it('a dead Split-of-a-Split wire is unwired on both sides (its stored value is a float)', () => {
    const nodes = [
      makeNode('i', 'int', { value: 7 }), makeNode('k', 'int', { value: 5 }), makeNode('s1', 'split'), makeNode('s2', 'split'),
      makeNode('d', 'div', { b: 2 }), makeNode('o', 'output'),
    ];
    const edges = [
      makeEdge('k', 'out', 's1', 'v'), makeEdge('s1', 'x', 's2', 'v'),
      makeEdge('i', 'out', 'd', 'a'), makeEdge('s2', 'x', 'd', 'b'), makeEdge('d', 'out', 'o', 'color'),
    ];
    expect(code(nodes, edges)).toContain('div(float(int1), 2)');
    expect(evaluateNodeOutput('d', nodes, edges, 0)).toEqual([3.5]);
  });

  it('Int ÷ Float divides as floats', () => {
    const nodes = [makeNode('i', 'int', { value: 7 }), makeNode('f', 'float', { value: 2 }), makeNode('d', 'div')];
    expect(evaluateNodeOutput('d', nodes, [makeEdge('i', 'out', 'd', 'a'), makeEdge('f', 'out', 'd', 'b')], 0)).toEqual([3.5]);
  });

  it('Int mod Int is the remainder; with a negative operand it has no one value; a float mod stays floored', () => {
    const mod = (kx: 'int' | 'float', x: number, ky: 'int' | 'float', y: number) => {
      const nodes = [makeNode('x', kx, { value: x }), makeNode('y', ky, { value: y }), makeNode('m', 'mod')];
      const edges = [makeEdge('x', 'out', 'm', 'x'), makeEdge('y', 'out', 'm', 'y')];
      return { point: evaluateNodeOutput('m', nodes, edges, 0), range: evaluateNodeRange('m', nodes, edges) };
    };
    expect(mod('int', 7, 'int', 3).point).toEqual([1]);
    expect(mod('float', -7, 'int', 3).point).toEqual([2]);
    expect(mod('int', -7, 'float', 3).point).toEqual([2]);
    // WGSL truncates (−1), ANGLE folds −7 % 3 to 0, and % 0 fails to compile
    // on WebGPU: unknown, never a guess.
    for (const [x, y] of [[-7, 3], [7, -3], [7, 0]]) {
      const r = mod('int', x, 'int', y);
      expect(r.point![0], `${x} % ${y}`).toBeNaN();
      expect([r.range!.min[0], r.range!.max[0]], `${x} % ${y}`).toEqual([-Infinity, Infinity]);
    }
  });
});

describe('intPromotion: the rule itself', () => {
  /** A tiny IntGraph over a node-type table and a wire list. */
  const graph = (types: Record<string, string>, wireList: [string, string, string][], operandsOf: Record<string, string[]> = {}): IntGraph => ({
    typeOf: (id) => types[id],
    wireInto: (id, port) => {
      const w = wireList.find(([, target, p]) => target === id && p === port);
      return w ? { source: w[0] } : undefined;
    },
    operands: (id) => operandsOf[id] ?? [],
  });

  it('an int-preserving node is an int only when EVERY operand is wired from one', () => {
    const g = graph(
      { i: 'int', j: 'int', f: 'float', both: 'add', mixed: 'add', half: 'add' },
      [['i', 'both', 'a'], ['j', 'both', 'b'], ['i', 'mixed', 'a'], ['f', 'mixed', 'b'], ['i', 'half', 'a']],
      { both: ['a', 'b'], mixed: ['a', 'b'], half: ['a', 'b'] },
    );
    expect(isIntSource(g, 'both')).toBe(true);
    expect(isIntSource(g, 'mixed')).toBe(false);
    expect(isIntSource(g, 'half')).toBe(false); // b unwired: a float literal
  });

  it('a cycle answers false instead of recursing forever', () => {
    const g = graph({ a: 'add', b: 'add' }, [['b', 'a', 'a'], ['a', 'b', 'a']], { a: ['a'], b: ['a'] });
    expect(isIntSource(g, 'a')).toBe(false);
  });

  it('a wire is promoted unless its consumer keeps the int', () => {
    const g = graph({ i: 'int', j: 'int', d: 'div', s: 'sin', sp: 'split' }, [['i', 'd', 'a'], ['j', 'd', 'b']], { d: ['a', 'b'] });
    expect(promotesIntWire(g, { source: 'i', target: 's' }, 'any')).toBe(true);
    expect(promotesIntWire(g, { source: 'i', target: 'd' }, 'any')).toBe(false); // all-int div
    expect(promotesIntWire(g, { source: 'i', target: 'sp' }, 'any')).toBe(false); // the Split's consumer decides
    expect(promotesIntWire(g, { source: 'i', target: 's' }, 'int')).toBe(false); // an int socket
  });
});

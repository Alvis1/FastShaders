/**
 * The acceptance gate end to end: the built-in corpus passes UNCHANGED (same
 * graph as the parser's own reading, same uniform names), what leaves the gate
 * is closed over the app's own vocabulary, names are made safe, and the caps
 * hold.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import type * as T from '@babel/types';
import { codeToGraph } from '@/engine/codeToGraph';
import { scriptToTSLWithSettings } from '@/engine/scriptToTSL';
import { getBuiltinPresets } from '@/registry/builtinPresets';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import { DEFAULT_OPTIONAL_CATEGORIES } from '@/registry/optionalCategories';
import { computeReachableCost } from '@/utils/nodeCost';
import { makeNode } from '@/test-utils';
import { buildCatalogue, GENERATION_EXCLUDED_TYPES } from './catalogue';
import { gateProgram, gateText, graphSignature, MAX_GENERATED_NODES, MAX_GENERATED_UNIFORMS } from './gate';
import { FORMULA_TSL_SYMBOLS } from '@/utils/dataRangeFormula';
import { SPLAT_CONSTANTS } from '@/utils/sdfPartition';
import { CODEGEN_LITERAL_IMPORTS, liveUniformNames, RESERVED_NAMES, storedUniformNames } from './names';

const catalogue = buildCatalogue(DEFAULT_OPTIONAL_CATEGORIES);
const ctx = { catalogue, takenNames: new Set<string>() };
const wrap = (body: string) => `import { Fn } from "three/tsl";\nconst shader = Fn(() => {\n${body}\n});\nexport default shader;`;
const corpus = [...getBuiltinPresets(), ...getBuiltinTextures()];
const returnsChannels = (code: string) => /return\s*\{/.test(code);
const uniformNamesOf = (code: string) => [...code.matchAll(/const (\w+) = uniform\(/g)].map((m) => m[1]);

/** Node types a built-in's graph holds that the catalogue does not offer (Color Ramp). */
const unwritableTypes = (code: string) =>
  [...new Set(codeToGraph(code).nodes.map((n) => n.data.registryType))].filter((t) => !catalogue.types.has(t));

describe('the built-in corpus', () => {
  // Every built-in — the Presets tab's recipes, Presets 2 and the textures —
  // is one of three kinds, decided by its CONTENT, never by a list of ids or a
  // count written here:
  //  - a channel-object return: refused by design (a parked group has no
  //    Output to map channels onto);
  //  - a single return holding a node the catalogue leaves out (Color Ramp and
  //    RGB Curves are written with a string the dialect cannot hold): refused,
  //    for exactly that;
  //  - every other single return: passes UNCHANGED.
  const kinds = corpus.map((a) => ({
    a,
    kind: returnsChannels(a.code) ? 'channels' : unwritableTypes(a.code).length > 0 ? 'unwritable' : 'writable',
  }));
  const of = (kind: string) => kinds.filter((k) => k.kind === kind).map((k) => k.a);

  it('every writable single-return built-in passes unchanged: same graph, same uniform names', () => {
    const writable = of('writable');
    for (const asset of writable) {
      const r = gateProgram(asset.code, '', ctx);
      expect(r.ok, `${asset.id}: ${r.ok ? '' : r.problems.join(' | ')}`).toBe(true);
      if (!r.ok) continue;
      const original = codeToGraph(asset.code);
      const gated = codeToGraph(r.tsl);
      expect(graphSignature(gated.nodes, gated.edges), asset.id).toBe(graphSignature(original.nodes, original.edges));
      expect(r.uniforms.map((u) => u.name), asset.id).toEqual(uniformNamesOf(asset.code));
      expect(r.uniforms.every((u) => !u.renamedFrom), asset.id).toBe(true);
    }
    // Non-vacuous: most of the corpus passes, and the recipes are part of it.
    expect(writable.length).toBeGreaterThan(corpus.length / 2);
    expect(writable.filter((a) => a.id.startsWith('recipe-')).length).toBeGreaterThan(0);
  });

  it('every recipe is counted: each one passes, or is refused for one of the two reasons above', () => {
    const recipes = kinds.filter((k) => k.a.id.startsWith('recipe-'));
    expect(recipes.length).toBeGreaterThan(0);
    for (const { a, kind } of recipes) {
      const r = gateProgram(a.code, '', ctx);
      expect(r.ok, `${a.id} (${kind})`).toBe(kind === 'writable');
    }
  });

  it('a single return holding a node the dialect cannot write is refused for that node', () => {
    const unwritable = of('unwritable');
    expect(unwritable.length).toBeGreaterThan(0);
    for (const asset of unwritable) {
      expect(unwritableTypes(asset.code).every((t) => GENERATION_EXCLUDED_TYPES.has(t)), asset.id).toBe(true);
      const r = gateProgram(asset.code, '', ctx);
      expect(r.ok ? '' : r.problems.join(), asset.id).toMatch(/is not in the node list/);
    }
  });

  it('a channel-object return is refused (a parked group has no Output to map channels onto)', () => {
    const multi = of('channels');
    expect(multi.length).toBeGreaterThan(0);
    for (const asset of multi) {
      const r = gateProgram(asset.code, '', ctx);
      expect(r.ok ? '' : r.problems.join(), asset.id).toMatch(/not an object of channels/);
    }
  });
});

describe('what leaves the gate', () => {
  const accepted = corpus
    .filter((a) => !returnsChannels(a.code))
    .map((a) => gateProgram(a.code, '', ctx))
    .flatMap((r) => (r.ok ? [r.tsl] : []));

  it('is closed over the app\'s vocabulary: catalogue names, its own consts, numbers — no comments, no strings', () => {
    const fixed = new Set(['Fn', 'shader', 'uniform', 'color', 'float', 'int', 'uv', 'mul', 'add', 'vec2', 'time', ...catalogue.byName.keys()]);
    for (const tsl of accepted) {
      const ast = parse(tsl, { sourceType: 'module' }) as unknown as T.File;
      expect(ast.comments ?? []).toHaveLength(0);
      expect(tsl).not.toMatch(/\/\*|\/\//);
      const declared = new Set<string>();
      const strings: string[] = [];
      const idents: string[] = [];
      const walk = (n: unknown, parent: T.Node | null): void => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach((c) => walk(c, parent)); return; }
        const node = n as T.Node;
        if (typeof node.type !== 'string') return;
        if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') declared.add(node.id.name);
        if (node.type === 'StringLiteral') strings.push(node.value);
        if (node.type === 'Identifier' && !(parent?.type === 'MemberExpression' && parent.property === node)) idents.push(node.name);
        if (node.type === 'MemberExpression' && node.property.type === 'Identifier') {
          expect(['x', 'y', 'z', 'w', 'mul', 'add']).toContain(node.property.name);
        }
        for (const [k, v] of Object.entries(node)) if (k !== 'loc' && k !== 'start' && k !== 'end') walk(v, node);
      };
      walk(ast.program, null);
      expect(strings).toEqual(['three/tsl']);
      for (const id of idents) expect(fixed.has(id) || declared.has(id), `${id} in\n${tsl}`).toBe(true);
    }
  });

  it('passes through scriptToTSL untouched, so the ADD parses exactly the gated text', () => {
    for (const tsl of accepted) expect(scriptToTSLWithSettings(tsl).code).toBe(tsl);
  });

  it('prices the group as the cost bar will once its end is wired', () => {
    const r = gateProgram(wrap('const n = mx_fractal_noise_float(positionGeometry.mul(3));\n  const c = mix(color(0x112233), color(0xFFEEDD), n);\n  return c;'), '', ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = codeToGraph(r.tsl);
    expect(r.cost).toBeGreaterThan(0);
    expect(r.cost).toBe(computeReachableCost(g.nodes, g.edges));
    expect(r.nodeCount).toBe(g.nodes.filter((n) => n.data.registryType !== 'output').length);
  });
});

describe('names', () => {
  it('a uniform taking a name already in use is renamed, and says from what', () => {
    const r = gateProgram(wrap('const speed = uniform(2);\n  const t = time.mul(speed);\n  const s = sin(t);\n  return s;'), '', { catalogue, takenNames: new Set(['speed']) });
    expect(r.ok && r.uniforms).toEqual([{ name: 'speed2', kind: 'float', value: 2, renamedFrom: 'speed' }]);
    expect(r.ok && r.tsl).toMatch(/time\.mul\(speed2\)/);
  });

  it.each([
    ['color', 'const color = uniform(color(0xFF0000));\n  return color;'],
    ['src', 'const src = uniform(1);\n  const u = uv();\n  const m = mul(u.x, src);\n  return m;'],
    ['constructor', 'const constructor = uniform(1);\n  const u = uv();\n  const m = mul(u.x, constructor);\n  return m;'],
    ['mix', 'const mix = uniform(0.5);\n  const u = uv();\n  const m = mul(u.x, mix);\n  return m;'],
  ])('a uniform named %s is renamed', (name, body) => {
    const r = gateProgram(wrap(body), '', ctx);
    expect(r.ok, r.ok ? '' : r.problems.join()).toBe(true);
    if (!r.ok) return;
    expect(r.uniforms[0].name).not.toBe(name);
    expect(r.uniforms[0].renamedFrom).toBe(name);
  });

  it('a Latvian uniform name keeps its letters', () => {
    const r = gateProgram(wrap('const ātrums = uniform(2);\n  const t = time.mul(ātrums);\n  const s = sin(t);\n  return s;'), '', ctx);
    expect(r.ok && r.uniforms[0]).toMatchObject({ name: 'atrums', renamedFrom: 'ātrums' });
  });

  it('a const named after a function it then calls keeps working', () => {
    const r = gateProgram(wrap('const mix = mix(color(0x000000), color(0xFFFFFF), 0.5);\n  return mix;'), '', ctx);
    expect(r.ok, r.ok ? '' : r.problems.join()).toBe(true);
    expect(r.ok && r.tsl).toMatch(/const mix2 = mix\(/);
  });

  it('every function graphToCode imports by literal is reserved (the drift pair)', () => {
    const src = readFileSync('src/engine/graphToCode.ts', 'utf8');
    const literals = new Set([...src.matchAll(/addImport\('three\/tsl', '([A-Za-z_][A-Za-z0-9_]*)'\)/g)].map((m) => m[1]));
    // …and the literal LISTS it imports in a loop (the SDF Output's, the splat light's).
    for (const m of src.matchAll(/(?:const imports = |for \(const name of )\[([^\]]*)\]/g)) {
      for (const q of m[1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)) literals.add(q[1]);
    }
    expect(literals.has('mat2') && literals.has('frontFacing') && literals.has('Break')).toBe(true);
    for (const name of literals) {
      expect(CODEGEN_LITERAL_IMPORTS as readonly string[], name).toContain(name);
      expect(RESERVED_NAMES.has(name), name).toBe(true);
    }
  });

  it('reads the live graph\'s property names the way graphToCode claims them', () => {
    const nodes = [
      makeNode('a', 'property_float', { name: 'speed', value: 1 }),
      makeNode('b', 'property_float', { name: 'speed', value: 2 }),
      makeNode('c', 'property_color', { name: 'my tint', hex: '#ffffff' }),
      makeNode('d', 'sin'),
    ];
    const taken = liveUniformNames(nodes);
    for (const name of ['my_tint', 'speed', 'speed2']) expect(taken.has(name), name).toBe(true);
    // graphToCode's namer starts with the module helpers (and the splat
    // parameters) taken: a live property named `hsl` is emitted as `hsl2`.
    expect(taken.has('hsl')).toBe(true);
    expect(liveUniformNames([makeNode('h', 'property_float', { name: 'hsl', value: 1 })]).has('hsl2')).toBe(true);
  });

  it('a uniform named after the module wrapper\'s parameter is renamed (`function(params)` would redeclare it)', () => {
    const r = gateProgram(wrap('const params = uniform(1.5);\n  const u = uv();\n  const a = mul(u.x, params);\n  return a;'), '', ctx);
    expect(r.ok && r.uniforms[0]).toMatchObject({ name: 'params2', renamedFrom: 'params' });
  });

  it('reserves the imports chosen from tables: the formula functions and the splat constants', () => {
    for (const name of FORMULA_TSL_SYMBOLS) expect(RESERVED_NAMES.has(name), name).toBe(true);
    for (const c of SPLAT_CONSTANTS) for (const name of c.imports) expect(RESERVED_NAMES.has(name), name).toBe(true);
  });

  it('reads the stored tuned names through their sanitizers, and survives junk', () => {
    const store: Record<string, string> = {
      'fs:previewUniformValues': JSON.stringify({ speed: 2, tint: '#ff0000', bad: { x: 1 } }),
      'fs:previewUniformBounds': '{"__proto__": {"polluted": 1}, "scale": {"min": 0, "max": 4}}',
    };
    expect([...storedUniformNames((k) => store[k] ?? null)].sort()).toEqual(['scale', 'speed', 'tint']);
    expect(storedUniformNames(() => '{not json')).toEqual(new Set());
    expect(storedUniformNames(() => { throw new Error('blocked'); })).toEqual(new Set());
  });
});

describe('the forms graphToCode writes since the generator was built', () => {
  // The semantic round trip walks graphToCode's re-emission with the same
  // walker, so a form the engine started writing later refuses every program
  // that reaches it — with no generator code changing.
  const typesOf = (tsl: string) => codeToGraph(tsl).nodes.map((n) => n.data.registryType).sort();
  const wiresOf = (tsl: string) => {
    const g = codeToGraph(tsl);
    const type = new Map(g.nodes.map((n) => [n.id, n.data.registryType] as const));
    return g.edges.map((e) => `${type.get(e.source)}.${e.sourceHandle}>${type.get(e.target)}.${e.targetHandle}`).sort();
  };

  it('a Fresnel passes: graphToCode adds the world position as a third argument and reads `out` as .x', () => {
    const r = gateProgram(wrap('const f = fsFresnel(1.5, normalWorld);\n  const rim = mul(f.y, 2);\n  const v = vec3(f, rim, 0);\n  return v;'), '', ctx);
    expect(r.ok, r.ok ? '' : r.problems.join()).toBe(true);
    if (!r.ok) return;
    expect(r.tsl).toMatch(/const f = fsFresnel\(1\.5, normalWorld\);/);
    expect(typesOf(r.tsl)).toEqual(['fresnel', 'mul', 'output', 'vec3']);
    expect(wiresOf(r.tsl)).toEqual(['fresnel.facing>mul.a', 'fresnel.out>vec3.x', 'mul.out>vec3.y', 'vec3.out>output.color']);
  });

  it('the third argument graphToCode writes is accepted only as the world position it always is', () => {
    const three = gateProgram(wrap('const f = fsFresnel(1.33, normalWorld, positionWorld);\n  return f;'), '', ctx);
    const two = gateProgram(wrap('const f = fsFresnel(1.33, normalWorld);\n  return f;'), '', ctx);
    expect(three.ok && two.ok && three.tsl).toBe(two.ok && two.tsl);
    expect(problemsOf(gateProgram(wrap('const f = fsFresnel(1.33, normalWorld, positionLocal);\n  return f;'), '', ctx)))
      .toMatch(/fsFresnel\(\)'s third argument is always positionWorld/);
  });

  it('an Int meeting a Float passes: the re-walk reads graphToCode\'s float(<int>) back as the parser does', () => {
    for (const body of [
      'const i = int(4);\n  const m = mul(i, 0.3);\n  const v = vec3(m, m, m);\n  return v;',
      'const i = int(3);\n  return i;',
    ]) {
      const r = gateProgram(wrap(body), '', ctx);
      expect(r.ok, `${body}\n${r.ok ? '' : r.problems.join()}`).toBe(true);
      expect(r.ok && r.tsl).not.toMatch(/float\(/);
    }
    // The model itself still may not write a conversion of a value.
    expect(problemsOf(gateProgram(wrap('const u = uv();\n  const f = float(u.x);\n  return f;'), '', ctx))).toMatch(/float\(\) takes one number/);
  });

  it('a scalar into normalize passes: the re-walk reads graphToCode\'s vec3(<scalar>) widening back too', () => {
    const r = gateProgram(wrap('const u = uv();\n  const n = normalize(u.x);\n  return n;'), '', ctx);
    expect(r.ok, r.ok ? '' : r.problems.join()).toBe(true);
  });
});

function problemsOf(r: ReturnType<typeof gateProgram>): string {
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.problems.join('\n');
}

describe('caps and shapes', () => {
  it(`refuses more than ${MAX_GENERATED_UNIFORMS} uniforms`, () => {
    const decl = Array.from({ length: MAX_GENERATED_UNIFORMS + 1 }, (_, i) => `const k${i} = uniform(${i});`).join('\n  ');
    const sum = `const s = add(${Array.from({ length: 8 }, (_, i) => `k${i}`).join(', ')});\n  const s2 = add(s, k8);`;
    const r = gateProgram(wrap(`${decl}\n  ${sum}\n  const v = vec3(s2, s2, s2);\n  return v;`), '', ctx);
    expect(r.ok ? '' : r.problems.join()).toMatch(/use at most 8/);
  });

  it(`refuses a group of more than ${MAX_GENERATED_NODES} nodes`, () => {
    const lines = ['const u = uv();', 'const a0 = sin(u.x);'];
    for (let i = 1; i <= MAX_GENERATED_NODES; i++) lines.push(`const a${i} = sin(a${i - 1});`);
    const r = gateProgram(wrap(`${lines.join('\n  ')}\n  return a${MAX_GENERATED_NODES};`), '', ctx);
    expect(r.ok ? '' : r.problems.join()).toMatch(/keep it under 100/);
  });

  it('refuses a vector component that is not one channel', () => {
    const r = gateProgram(wrap('const c = uniform(color(0xFF0000));\n  const v = vec3(c, 0, 0);\n  return v;'), '', ctx);
    expect(r.ok ? '' : r.problems.join()).toMatch(/component must be ONE number/);
  });

  it('a whole reply round-trips, plan included', () => {
    const r = gateText('A soft blue-to-orange ramp.\n\n```js\nimport { Fn, uniform, color, uv, mix } from "three/tsl";\nconst shader = Fn(() => {\n  const a = uniform(color(0x1A237E));\n  const b = uniform(color(0xFF8A65));\n  const u = uv();\n  const r = mix(a, b, u.y);\n  return r;\n});\nexport default shader;\n```', ctx);
    expect(r.ok && r.plan).toBe('A soft blue-to-orange ramp.');
    expect(r.ok && r.uniforms.map((u) => [u.name, u.value])).toEqual([['a', '#1a237e'], ['b', '#ff8a65']]);
  });
});

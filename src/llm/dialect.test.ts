/**
 * The generation dialect: every form the parser would drop or misread without a
 * word is REFUSED with a line and a fix; every lenient rewrite is EXACT and
 * pinned by the canonical text it produces (which then passes the full gate,
 * semantic round trip included).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_OPTIONAL_CATEGORIES } from '@/registry/optionalCategories';
import { buildCatalogue } from './catalogue';
import { extractProgram, MAX_REPLY_CHARS, walkProgram } from './dialect';
import { gateProgram, gateText } from './gate';

const catalogue = buildCatalogue(DEFAULT_OPTIONAL_CATEGORIES);
const ctx = { catalogue, takenNames: new Set<string>() };
const wrap = (body: string) => `import { Fn } from "three/tsl";\nconst shader = Fn(() => {\n${body}\n});\nexport default shader;`;

/** The body lines of the canonical program (between the Fn wrapper lines). */
function canonicalBody(body: string): string[] {
  const r = gateProgram(wrap(body), '', ctx);
  if (!r.ok) throw new Error(r.problems.join('\n'));
  return r.tsl.split('\n').filter((l) => l.startsWith('  ')).map((l) => l.trim());
}

function problemsOf(body: string): string {
  const r = gateProgram(wrap(body), '', ctx);
  expect(r.ok, `expected a refusal for:\n${body}`).toBe(false);
  return r.ok ? '' : r.problems.join('\n');
}

describe('refused forms — each one the parser would drop or misread silently', () => {
  it.each([
    ['an undeclared argument', 'const a = sin(foo);\n  return a;', /foo is not declared/],
    ['a forward reference', 'const a = sin(b);\n  const b = uv();\n  return a;', /b is used before the line that declares it/],
    ['a second noise argument (TSL reads it as AMPLITUDE)', 'const n = mx_noise_float(positionGeometry, 2);\n  return n;', /takes ONE position argument/],
    ['float() of a value', 'const u = uv();\n  const f = float(u);\n  return f;', /float\(\) takes one number/],
    ['int() of a fraction', 'const k = int(1.5);\n  const u = uv();\n  const m = mul(u.x, k);\n  return m;', /whole number/],
    ['color() of a single fraction (setHex reads it as black)', 'const c = color(0.5);\n  return c;', /color\(0xRRGGBB\)/],
    ['uv() with an argument', 'const u = uv(1);\n  return u;', /uv\(\) takes no argument/],
    ['a short vector of values', 'const u = uv();\n  const v = vec3(u.x, u.y);\n  return v;', /takes all 3 components/],
    ['a method TSL reorders differently (step)', 'const u = uv();\n  const s = u.x.step(0.5);\n  return s;', /\.step\(\) is not available/],
    ['a helper Fn inside the body', 'const h = Fn(() => { return uv(); });\n  return h;', /no helper functions/],
    ['Discard', 'const u = uv();\n  Discard(u.x);\n  return u;', /Discard is not available/],
    ['an If block', 'const u = uv();\n  If(u.x, () => {});\n  return u;', /every line must be a const/],
    ['.assign', 'const u = uv();\n  u.assign(1);\n  return u;', /no \.assign/],
    ['a channel object', 'const u = uv();\n  return { color: u };', /not an object of channels/],
    ['a string', "const s = color('#ff0000');\n  return s;", /color\(0xRRGGBB\)/],
    ['the Reflect payload', "const r = String(Reflect.apply(Reflect.apply(Reflect.get(Reflect.get,'constructor'),null,['x']),null,[]));\n  return r;", /String\(\) is not in the node list/],
    ['a namespace callee (shifts every argument a port)', 'const u = uv();\n  const s = Math.sin(u.x);\n  return s;', /Math\.sin\(\) is not available/],
    ['a TSL namespace', 'const u = uv();\n  const m = TSL.mix(u.x, u.y, 0.5);\n  return m;', /TSL\.mix\(\) is not available/],
    ['a uniform of a value', 'const u = uv();\n  const k = uniform(u.x);\n  return k;', /uniform\(\) takes a number or color/],
    ['too many arguments', 'const u = uv();\n  const s = sin(u.x, u.y);\n  return s;', /sin\(\) takes 1 argument, not 2/],
    ['too few arguments', 'const u = uv();\n  const s = select(u.x, u.y);\n  return s;', /select\(\) takes 3 arguments, not 2/],
    ['a returned number', 'return 0.5;', /return a const, not a number/],
    ['a line after the return', 'const u = uv();\n  return u;\n  const v = uv();', /nothing may follow the return/],
    ['reassignment', 'let u = uv();\n  u = uv();\n  return u;', /no reassignment/],
    ['a ternary', 'const u = uv();\n  const s = u.x ? 1 : 0;\n  return s;', /select\(condition, a, b\)/],
    ['destructuring', 'const { x } = uv();\n  return x;', /no destructuring/],
    ['new', 'const v = new Foo();\n  return v;', /not a form the graph can hold/],
    ['a function not in the node list', 'const u = uv();\n  const s = triNoise3D(u.x);\n  return s;', /triNoise3D\(\) is not in the node list/],
    ['a swizzle of a swizzle', 'const u = uv();\n  const s = u.x.y;\n  return s;', /swizzle of a swizzle/],
    ['a computed member', 'const u = uv();\n  const s = u[0];\n  return s;', /one-letter swizzles/],
    // graphToCode writes a wired swizzle inline, and the parser then drops it.
    ['one component as a noise position', 'const u = uv();\n  const n = mx_noise_float(u.x);\n  return n;', /needs 2 or 3 components/],
    // 0 or 1, not a colour: the dialect asks for the colour it should pick.
    ['a returned comparison', 'const u = uv();\n  const a = greaterThan(u.x, 0.5);\n  return a;', /not a comparison/],
    ['an infinite number', 'const u = uv();\n  const s = mul(u.x, 1 / 0);\n  return s;', /not finite/],
    // three r184 fills a missing argument with 0.0, not the registry default.
    ['a left-out argument TSL has no default for (mix)', 'const u = uv();\n  const m = mix(u.x, u.y);\n  return m;', /mix\(\) takes 3 arguments, not 2/],
    ['a left-out argument TSL has no default for (pow)', 'const u = uv();\n  const m = pow(u.x);\n  return m;', /pow\(\) takes 2 arguments, not 1/],
    // remap, smoothstep and normalize take their width from their inputs.
    ['vec3() of a two-channel remap', 'const r = remap(uv(), 0, 1, -1, 1);\n  const c = vec3(r);\n  return c;', /vec3\(\) takes all 3 components/],
    ['vec4() of a three-channel smoothstep', 'const s = smoothstep(0, 1, positionWorld);\n  const c = vec4(s);\n  return c;', /vec4\(\) takes all 4 components/],
    ['vec3() of a two-channel normalize', 'const n = normalize(uv());\n  const c = vec3(n);\n  return c;', /vec3\(\) takes all 3 components/],
    ['a vector component wider than one channel', 'const r = remap(uv(), 0, 1, 0, 1);\n  const c = vec3(r, 0, 0);\n  return c;', /component must be ONE number/],
  ])('%s', (_label, body, problem) => {
    expect(problemsOf(body)).toMatch(problem);
  });

  it('type annotations are a syntax error with a plain-JavaScript hint', () => {
    expect(problemsOf('const a: number = 1;\n  return a;')).toMatch(/syntax error.*plain JavaScript/);
  });

  it('a duplicate const is a syntax error (the parser itself would hide it)', () => {
    expect(problemsOf('const u = uv();\n  const u = uv();\n  return u;')).toMatch(/syntax error.*already been declared/);
  });

  it('nesting deeper than the walker follows is refused, never a stack overflow', () => {
    const deep = 'sin('.repeat(40) + 'uv().x' + ')'.repeat(40);
    expect(problemsOf(`const s = ${deep};\n  return s;`)).toMatch(/nesting deeper than/);
  });

  it('a second top-level Fn is refused', () => {
    const r = gateText('```js\nconst h = Fn(() => uv());\nconst shader = Fn(() => { const u = uv(); return u; });\nexport default shader;\n```', ctx);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.problems.join()).toMatch(/no helper functions/);
  });

  it('problem lines quote the line and stop at eight', () => {
    const body = Array.from({ length: 12 }, (_, i) => `const a${i} = sin(missing${i});`).join('\n  ') + '\n  return a0;';
    const r = gateProgram(wrap(body), '', ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toHaveLength(8);
    expect(r.problems[0]).toMatch(/^line 3 `const a0 = sin\(missing0\);`: missing0 is not declared/);
  });

  it('a failed const does not cascade into the lines that use it', () => {
    const r = gateProgram(wrap('const n = mx_noise_float(positionGeometry, 2);\n  const m = mx_noise_float(n);\n  return m;'), '', ctx);
    expect(r.ok ? [] : r.problems).toHaveLength(1);
  });
});

describe('exact rewrites — the canonical text each one produces', () => {
  it.each([
    ['nested calls flatten into their own steps', 'const u = uv();\n  const a = sin(mul(u.x, 2));\n  return a;',
      ['const u = uv();', 'const t1 = mul(u.x, 2);', 'const a = sin(t1);', 'return a;']],
    ['constant arithmetic folds', 'const u = uv();\n  const a = mul(u.x, 1 / 4, -0.5, Math.PI * 2);\n  return a;',
      ['const u = uv();', `const a = mul(u.x, 0.25, -0.5, ${Math.PI * 2});`, 'return a;']],
    ['operators become their functions', 'const u = uv();\n  const a = u.x * u.y + 1;\n  return a;',
      ['const u = uv();', 'const t1 = mul(u.x, u.y);', 'const a = add(t1, 1);', 'return a;']],
    ['unary minus on a value', 'const u = uv();\n  const a = -u.x;\n  return a;',
      ['const u = uv();', 'const a = mul(u.x, -1);', 'return a;']],
    ['comparison operators', 'const u = uv();\n  const a = u.x > 0.5;\n  const c = select(a, 1, 0);\n  return c;',
      ['const u = uv();', 'const a = greaterThan(u.x, 0.5);', 'const c = select(a, 1, 0);', 'return c;']],
    ['positional methods become free functions', 'const u = uv();\n  const a = u.x.mul(2).sin().pow(3);\n  return a;',
      ['const u = uv();', 'const t1 = mul(u.x, 2);', 'const t2 = sin(t1);', 'const a = pow(t2, 3);', 'return a;']],
    ['t.mix(a, b) puts the receiver in the factor slot', 'const u = uv();\n  const a = u.x.mix(0.2, 0.8);\n  return a;',
      ['const u = uv();', 'const a = mix(0.2, 0.8, u.x);', 'return a;']],
    ['x.smoothstep(lo, hi) puts the receiver last', 'const u = uv();\n  const a = u.x.smoothstep(0.2, 0.8);\n  return a;',
      ['const u = uv();', 'const a = smoothstep(0.2, 0.8, u.x);', 'return a;']],
    ['toVar() is dropped', 'const u = uv().toVar();\n  return u;', ['const u = uv();', 'return u;']],
    ['a numeric const is substituted', 'const k = 0.5;\n  const u = uv();\n  const a = mul(u.x, k);\n  return a;',
      ['const u = uv();', 'const a = mul(u.x, 0.5);', 'return a;']],
    ['a const alias is substituted', 'const u = uv();\n  const w = u;\n  const a = sin(w.x);\n  return a;',
      ['const u = uv();', 'const a = sin(u.x);', 'return a;']],
    ['vec3(number) spreads', 'const v = vec3(0.5);\n  return v;', ['const v = vec3(0.5, 0.5, 0.5);', 'return v;']],
    ['vec3(scalar) spreads', 'const k = uniform(2);\n  const v = vec3(k);\n  return v;',
      ['const k = uniform(2);', 'const v = vec3(k, k, k);', 'return v;']],
    ['vec3(colour) is the colour', 'const c = uniform(color(0xFF8800));\n  const v = vec3(c);\n  const m = mul(v, 2);\n  return m;',
      ['const c = uniform(color(0xFF8800));', 'const m = mul(c, 2);', 'return m;']],
    ['a.xy becomes vec2(a.x, a.y)', 'const p = positionWorld;\n  const a = p.xz;\n  return a;',
      ['const p = positionWorld;', 'const a = vec2(p.x, p.z);', 'return a;']],
    ['color(r, g, b) is its linear vec3', 'const c = color(1, 0.5, 0);\n  return c;', ['const c = vec3(1, 0.5, 0);', 'return c;']],
    ['an alpha byte in a hex is dropped, as setHex does', 'const c = uniform(color(0xFFFFD700));\n  return c;',
      ['const c = uniform(color(0xFFD700));', 'return c;']],
    ['a registry type name maps to its function', 'const n = perlin(positionGeometry);\n  return n;',
      ['const n = mx_noise_float(positionGeometry);', 'return n;']],
    ['an input written as a call is the input', 'const d = dot(normalWorld(), positionWorld());\n  return d;',
      ['const d = dot(normalWorld, positionWorld);', 'return d;']],
    ['a noise scale written first is still the scale', 'const k = uniform(4);\n  const n = mx_noise_float(mul(k, positionGeometry));\n  return n;',
      ['const k = uniform(4);', 'const n = mx_noise_float(positionGeometry.mul(k));', 'return n;']],
    ['a computed noise position gets its own step', 'const n = mx_noise_float(add(positionGeometry, time));\n  return n;',
      ['const t1 = add(positionGeometry, time);', 'const n = mx_noise_float(t1);', 'return n;']],
    ['a noise scale that is no const becomes the product', 'const n = mx_noise_float(positionGeometry.mul(time));\n  return n;',
      ['const t1 = mul(positionGeometry, time);', 'const n = mx_noise_float(t1);', 'return n;']],
    ['the unsigned remap stays one noise', 'const n = mx_noise_float(positionGeometry.mul(3)).mul(0.5).add(0.5);\n  return n;',
      ['const n = mx_noise_float(positionGeometry.mul(3)).mul(0.5).add(0.5);', 'return n;']],
    ["time's speed", 'const t = time.mul(2);\n  const s = sin(t);\n  return s;', ['const t = time.mul(2);', 'const s = sin(t);', 'return s;']],
    ['uv tiling', 'const u = uv().mul(vec2(4, 2));\n  return u;', ['const u = mul(uv(), vec2(4, 2));', 'return u;']],
    ['an inline uniform is named', 'const u = uv();\n  const a = mul(u.x, uniform(2));\n  return a;',
      ['const u = uv();', 'const param1 = uniform(2);', 'const a = mul(u.x, param1);', 'return a;']],
    ['a left-out trailing argument TSL defaults itself is written out (remap)', 'const u = uv();\n  const r = remap(u.x, -1, 1);\n  return r;',
      ['const u = uv();', 'const r = remap(u.x, -1, 1, 0, 1);', 'return r;']],
    ['… and clamp', 'const u = uv();\n  const c = clamp(u.x);\n  return c;',
      ['const u = uv();', 'const c = clamp(u.x, 0, 1);', 'return c;']],
  ])('%s', (_label, body, lines) => {
    expect(canonicalBody(body)).toEqual(lines);
  });

  it('unused consts are dropped and reported', () => {
    const r = gateProgram(wrap('const u = uv();\n  const unused = sin(u.x);\n  const k = uniform(3);\n  return u;'), '', ctx);
    expect(r.ok && r.pruned).toEqual(['unused', 'k']);
  });

  it('accepts a body without the Fn wrapper, an expression-bodied Fn and module-level uniforms', () => {
    expect(gateText('```js\nconst u = uv();\nreturn u;\n```', ctx).ok).toBe(true);
    expect(gateText('```js\nexport default Fn(() => uv());\n```', ctx).ok).toBe(true);
    const r = gateText('```js\nconst k = uniform(2);\nconst shader = Fn(() => {\n  const u = uv();\n  const a = mul(u.x, k);\n  return a;\n});\nexport default shader;\n```', ctx);
    expect(r.ok && r.uniforms.map((u) => u.name)).toEqual(['k']);
  });

  it('the receiver-order rewrites match three\'s own chain definitions', () => {
    // If three ever changes which methods put the receiver last, the mix and
    // smoothstep rewrites above would silently swap arguments.
    const src = readFileSync('node_modules/three/src/nodes/math/MathNode.js', 'utf8');
    expect(src).toMatch(/export const mixElement = \( t, e1, e2 \) => mix\( e1, e2, t \);/);
    expect(src).toMatch(/export const smoothstepElement = \( x, low, high \) => smoothstep\( low, high, x \);/);
    expect(src).toMatch(/addMethodChaining\( 'mix', mixElement \);/);
    expect(src).toMatch(/addMethodChaining\( 'smoothstep', smoothstepElement \);/);
    for (const m of ['pow', 'clamp', 'min', 'max', 'dot', 'cross', 'distance']) {
      expect(src).toMatch(new RegExp(`addMethodChaining\\( '${m}', ${m} \\);`));
    }
  });
});

describe('extracting the program from a reply', () => {
  it('takes the last fenced block that returns, and the prose before it as the plan', () => {
    const r = extractProgram('I will **mix** two colours.\n```js\nconst a = 1;\n```\nThen:\n```javascript\nconst u = uv();\nreturn u;\n```\ntrailing');
    expect(r.ok && r.value.code).toBe('const u = uv();\nreturn u;\n');
    expect(r.ok && r.value.plan).toBe('I will mix two colours. Then:');
  });

  it('drops an inline <think> block', () => {
    const r = extractProgram('<think>```js\nreturn 1;\n```</think>Plan.\n```js\nconst u = uv();\nreturn u;\n```');
    expect(r.ok && r.value.plan).toBe('Plan.');
  });

  it('refuses a project block, an over-long reply and a reply with no program', () => {
    expect(extractProgram('/* FASTSHADERS_PROJECT_V1 */').ok).toBe(false);
    expect(extractProgram('x'.repeat(MAX_REPLY_CHARS + 1)).ok).toBe(false);
    expect(extractProgram('Sorry, I cannot help with that.').ok).toBe(false);
  });

  it('the walker never throws on hostile text', () => {
    for (const code of ['', '}{', 'return', '`${`', 'const a = (((((', ' ', 'export default 5;', 'import x from "fs"; return x;']) {
      expect(() => walkProgram(code, catalogue)).not.toThrow();
    }
  });
});

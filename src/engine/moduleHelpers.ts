/**
 * Module-scope helper `Fn`s that graphToCode emits ABOVE the shader when the
 * graph uses the node — for functions that are not `three/tsl` exports (hsl,
 * toHsl, the distance-field family). ONE table, read by both engines:
 *
 *   - graphToCode emits `lines` for every used type (in table order) and
 *     force-imports `imports`, the free-function names only the helper BODY
 *     uses (the node's own args never bring them in).
 *   - codeToGraph SKIPS a `const <name> = Fn(...)` declarator whose name is in
 *     MODULE_HELPER_NAMES — without it the helper's own mul/sub/clamp
 *     statements parse as standalone nodes and every Apply grows the graph.
 *
 * The rule the hsl/toHsl pair already documented: anything graphToCode emits at
 * module scope is graph content to codeToGraph until explicitly excluded. This
 * table is the exclusion, so a new helper cannot be added to one side alone.
 * `moduleHelpers.test.ts` pins that every key is a registry type whose
 * `tslFunction` is the emitted helper name, that the emitted declaration
 * really declares that name, and that every free-function call in a body is
 * covered by `imports`.
 *
 * Bodies use FREE functions (`sub(length(p), r)`), never named-function method
 * chains: `a.mix(b, t)`, `a.smoothstep(b, c)` and `a.step(b)` all put the
 * RECEIVER in a different slot than the positional form (see the dataviz
 * contract test), while the free form is positional for every one of them.
 */

export interface ModuleHelper {
  /** The `const <name> = Fn(...)` declaration, one line per array entry. */
  lines: string[];
  /** `three/tsl` names the body calls — force-imported when the helper ships. */
  imports: string[];
}

/**
 * HSL → RGB helper emitted at module scope when the graph contains an hsl node.
 * `hsl` is not an export of `three/tsl`, so we ship our own branchless implementation
 * (GLSL-style — no conditionals, suitable for the GPU).
 */
const HSL_HELPER_LINES = [
  'const hsl = Fn(([h, s, l]) => {',
  '  const h6 = mul(h, float(6));',
  '  const rk = clamp(sub(abs(sub(mod(add(h6, float(0)), float(6)), float(3))), float(1)), float(0), float(1));',
  '  const gk = clamp(sub(abs(sub(mod(add(h6, float(4)), float(6)), float(3))), float(1)), float(0), float(1));',
  '  const bk = clamp(sub(abs(sub(mod(add(h6, float(2)), float(6)), float(3))), float(1)), float(0), float(1));',
  '  const sat = mul(s, sub(float(1), abs(sub(mul(float(2), l), float(1)))));',
  '  return vec3(',
  '    add(l, mul(sat, sub(rk, float(0.5)))),',
  '    add(l, mul(sat, sub(gk, float(0.5)))),',
  '    add(l, mul(sat, sub(bk, float(0.5)))),',
  '  );',
  '});',
];

/**
 * RGB → HSL helper. Branchless via select/greaterThan/equal so GPU warp divergence
 * stays low. Uses `max(d, 1e-10)` to dodge division-by-zero on neutral/grayscale
 * inputs; the outer `select(d > 0, …, 0)` then zeros hue/saturation cleanly.
 */
const TO_HSL_HELPER_LINES = [
  'const toHsl = Fn(([rgb]) => {',
  '  const maxC = max(max(rgb.x, rgb.y), rgb.z);',
  '  const minC = min(min(rgb.x, rgb.y), rgb.z);',
  '  const d = sub(maxC, minC);',
  '  const L = mul(add(maxC, minC), float(0.5));',
  '  const satDenom = max(sub(float(1), abs(sub(mul(L, float(2)), float(1)))), float(1e-10));',
  '  const S = select(greaterThan(d, float(0)), div(d, satDenom), float(0));',
  '  const dSafe = max(d, float(1e-10));',
  '  const hR = add(div(sub(rgb.y, rgb.z), dSafe), select(lessThan(rgb.y, rgb.z), float(6), float(0)));',
  '  const hG = add(div(sub(rgb.z, rgb.x), dSafe), float(2));',
  '  const hB = add(div(sub(rgb.x, rgb.y), dSafe), float(4));',
  '  const hueSeg = select(equal(maxC, rgb.x), hR, select(equal(maxC, rgb.y), hG, hB));',
  '  const H = select(greaterThan(d, float(0)), mul(hueSeg, float(1 / 6)), float(0));',
  '  return vec3(H, S, L);',
  '});',
];

/**
 * Distance-field family. Each is Inigo Quilez's canonical form written with
 * free functions; the CPU evaluator carries the same maths for the on-node
 * value/range labels (`cpuEvaluator.ts`), and `registryDrift` keeps the two
 * agreeing on their unwired defaults.
 */
const SD_CIRCLE_LINES = [
  'const sdCircle = Fn(([p, r]) => {',
  '  return sub(length(p), r);',
  '});',
];

const SD_BOX2_LINES = [
  'const sdBox2 = Fn(([p, w, h]) => {',
  '  const q = sub(abs(p), vec2(w, h));',
  '  return add(length(max(q, float(0))), min(max(q.x, q.y), float(0)));',
  '});',
];

const SD_BOX3_LINES = [
  'const sdBox3 = Fn(([p, w, h, d]) => {',
  '  const q = sub(abs(p), vec3(w, h, d));',
  '  return add(length(max(q, float(0))), min(max(q.x, max(q.y, q.z)), float(0)));',
  '});',
];

const SD_TORUS_LINES = [
  'const sdTorus = Fn(([p, ringR, tubeR]) => {',
  '  const q = vec2(sub(length(p.xz), ringR), p.y);',
  '  return sub(length(q), tubeR);',
  '});',
];

// Polynomial smooth-min: h = clamp(0.5 + 0.5·(b−a)/k, 0, 1); mix(b, a, h) − k·h·(1−h).
// Undershoots min(a, b) by at most k/4. k must stay non-zero (a division).
const SMOOTH_UNION_LINES = [
  'const smoothUnion = Fn(([a, b, k]) => {',
  '  const h = clamp(add(mul(sub(b, a), div(float(0.5), k)), float(0.5)), float(0), float(1));',
  '  return sub(mix(b, a, h), mul(mul(k, h), sub(float(1), h)));',
  '});',
];

// Subtract the cutter (b) from the shape (a): max(−b, a).
const SD_SUBTRACT_LINES = [
  'const sdSubtract = Fn(([a, b]) => {',
  '  return max(mul(b, float(-1)), a);',
  '});',
];

/** Keyed by registry TYPE; insertion order is emission order. */
export const MODULE_HELPERS: ReadonlyMap<string, ModuleHelper> = new Map<string, ModuleHelper>([
  ['hsl', { lines: HSL_HELPER_LINES, imports: ['mul', 'add', 'sub', 'abs', 'mod', 'clamp', 'float', 'vec3'] }],
  ['toHsl', { lines: TO_HSL_HELPER_LINES, imports: ['max', 'min', 'sub', 'add', 'mul', 'abs', 'select', 'greaterThan', 'lessThan', 'equal', 'div', 'float', 'vec3'] }],
  ['sdCircle', { lines: SD_CIRCLE_LINES, imports: ['sub', 'length'] }],
  ['sdBox2', { lines: SD_BOX2_LINES, imports: ['sub', 'abs', 'vec2', 'add', 'length', 'max', 'min', 'float'] }],
  ['sdBox3', { lines: SD_BOX3_LINES, imports: ['sub', 'abs', 'vec3', 'add', 'length', 'max', 'min', 'float'] }],
  ['sdTorus', { lines: SD_TORUS_LINES, imports: ['vec2', 'sub', 'length'] }],
  ['smoothUnion', { lines: SMOOTH_UNION_LINES, imports: ['clamp', 'add', 'mul', 'sub', 'div', 'float', 'mix'] }],
  ['sdSubtract', { lines: SD_SUBTRACT_LINES, imports: ['max', 'mul', 'float'] }],
]);

/** The emitted helper names — what codeToGraph must skip at module scope. */
export const MODULE_HELPER_NAMES: ReadonlySet<string> = new Set(MODULE_HELPERS.keys());

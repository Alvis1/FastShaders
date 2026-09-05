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

export interface HelperAlias {
  /** The registry TYPE a call to this helper parses back into. */
  type: string;
  /** Positional port ids of the call's arguments, when they differ from the
   *  def's inputs (a variant that takes fewer, e.g. xor without k). */
  ports?: readonly string[];
  /** `values` to stamp on the parsed node — the MODE that selects this variant. */
  values?: Record<string, string | number>;
}

export interface ModuleHelper {
  /** Present on a VARIANT: which def it belongs to and how it parses back. A
   *  helper whose name IS its def's `tslFunction` needs none. */
  alias?: HelperAlias;
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
 * value/range labels (`cpuEvaluator.ts`).
 *
 * TWO helper SHAPES live here beside the plain one-def-one-helper entries:
 *  - a def with MODES (`def.modes`, e.g. Combine): one variant per mode, the
 *    default mode's helper being the def's `tslFunction` and the rest carrying
 *    `alias.values.mode`. graphToCode picks the variant from `values.mode`
 *    (`helperNameFor`), codeToGraph maps the name back through `HELPER_ALIASES`
 *    and stamps the mode — so a mode round-trips through the code panel.
 *  - a def dispatching on INPUT WIDTH (Box): `sdBox2` for a vec2 position,
 *    `sdBox3` for a vec3, chosen by `shapeOfEdgeSource` at emission; both parse
 *    back to the one `sdBox` def through the same alias table.
 */
const SD_CIRCLE_LINES = [
  'const sdCircle = Fn(([p, r]) => {',
  '  return sub(length(p), r);',
  '});',
];

// Rounded box: q = |p| − b + r; d = |max(q, 0)| + min(max(q), 0) − r. r = 0 is
// the sharp box byte-for-byte in value (r cancels).
const SD_BOX2_LINES = [
  'const sdBox2 = Fn(([p, w, h, r]) => {',
  '  const q = add(sub(abs(p), vec2(w, h)), r);',
  '  return sub(add(length(max(q, float(0))), min(max(q.x, q.y), float(0))), r);',
  '});',
];

const SD_BOX3_LINES = [
  'const sdBox3 = Fn(([p, w, h, d, r]) => {',
  '  const q = add(sub(abs(p), vec3(w, h, d)), r);',
  '  return sub(add(length(max(q, float(0))), min(max(q.x, max(q.y, q.z)), float(0))), r);',
  '});',
];

const SD_TORUS_LINES = [
  'const sdTorus = Fn(([p, ringR, tubeR]) => {',
  '  const q = vec2(sub(length(p.xz), ringR), p.y);',
  '  return sub(length(q), tubeR);',
  '});',
];

// Combine — IQ's k-NORMALISED quadratic smooth-min, where k is the blend
// thickness in distance units: h = max(k − |a − b|, 0); smin = min(a, b) −
// h²/(4k). k is floored at 1e-6 so k = 0 is the HARD op (h = 0) and never a
// division by zero. Intersection = −smin(−a, −b) = max(a, b) + h²/(4k);
// subtraction (a minus b) = smax(a, −b); xor is always exact and takes no k.
const SD_UNION_LINES = [
  'const sdUnion = Fn(([a, b, k]) => {',
  '  const kk = max(k, float(1e-6));',
  '  const h = max(sub(kk, abs(sub(a, b))), float(0));',
  '  return sub(min(a, b), div(mul(h, h), mul(kk, float(4))));',
  '});',
];

const SD_INTERSECT_LINES = [
  'const sdIntersect = Fn(([a, b, k]) => {',
  '  const kk = max(k, float(1e-6));',
  '  const h = max(sub(kk, abs(sub(a, b))), float(0));',
  '  return add(max(a, b), div(mul(h, h), mul(kk, float(4))));',
  '});',
];

const SD_SUBTRACT_LINES = [
  'const sdSubtract = Fn(([a, b, k]) => {',
  '  const kk = max(k, float(1e-6));',
  '  const nb = mul(b, float(-1));',
  '  const h = max(sub(kk, abs(sub(a, nb))), float(0));',
  '  return add(max(a, nb), div(mul(h, h), mul(kk, float(4))));',
  '});',
];

const SD_XOR_LINES = [
  'const sdXor = Fn(([a, b]) => {',
  '  return max(min(a, b), mul(max(a, b), float(-1)));',
  '});',
];

// The view ray, world space, unit length. A helper rather than an inline
// `normalize(sub(positionWorld, cameraPosition))` so codeToGraph reads the
// call back as ONE Ray Direction node (and so a Raymarch Output's Background
// Fn can substitute its parameter for the node by name).
const RAY_DIRECTION_LINES = [
  'const rayDirection = Fn(() => {',
  '  return normalize(sub(positionWorld, cameraPosition));',
  '});',
];


// ── The wider distance-field vocabulary (2026-09-03), IQ's canonical forms ──

// Capped cylinder along Y, optionally rounded (rb = 0 is sharp).
const SD_CYLINDER_LINES = [
  'const sdCylinder = Fn(([p, r, h, rb]) => {',
  '  const d = sub(abs(vec2(length(p.xz), p.y)), vec2(sub(r, rb), sub(h, rb)));',
  '  return sub(add(min(max(d.x, d.y), float(0)), length(max(d, float(0)))), rb);',
  '});',
];

// Vertical capsule: a segment of half-length h along Y, inflated by r.
const SD_CAPSULE_LINES = [
  'const sdCapsule = Fn(([p, r, h]) => {',
  '  const q = vec3(p.x, sub(p.y, clamp(p.y, mul(h, float(-1)), h)), p.z);',
  '  return sub(length(q), r);',
  '});',
];

// Capped cone along Y: radius r1 at the bottom (−h), r2 at the top (+h).
const SD_CONE_LINES = [
  'const sdCone = Fn(([p, r1, r2, h]) => {',
  '  const q = vec2(length(p.xz), p.y);',
  '  const k1 = vec2(r2, h);',
  '  const k2 = vec2(sub(r2, r1), mul(h, float(2)));',
  '  const ca = vec2(sub(q.x, min(q.x, select(lessThan(q.y, float(0)), r1, r2))), sub(abs(q.y), h));',
  '  const cb = add(sub(q, k1), mul(k2, clamp(div(dot(sub(k1, q), k2), dot(k2, k2)), float(0), float(1))));',
  '  const s = select(lessThan(cb.x, float(0)), select(lessThan(ca.y, float(0)), float(-1), float(1)), float(1));',
  '  return mul(s, sqrt(min(dot(ca, ca), dot(cb, cb))));',
  '});',
];

// Half-space: everything below the plane through the origin (offset h along
// the normal) is inside.
const SD_PLANE_LINES = [
  'const sdPlane = Fn(([p, nx, ny, nz, h]) => {',
  '  return add(dot(p, normalize(vec3(nx, ny, nz))), h);',
  '});',
];

// Exact octahedron (IQ): fold into the positive octant, pick the face.
const SD_OCTAHEDRON_LINES = [
  'const sdOctahedron = Fn(([pIn, s]) => {',
  '  const p = abs(pIn);',
  '  const m = sub(add(add(p.x, p.y), p.z), s);',
  '  const q = select(lessThan(mul(p.x, float(3)), m), p, select(lessThan(mul(p.y, float(3)), m), vec3(p.y, p.z, p.x), vec3(p.z, p.x, p.y)));',
  '  const k = clamp(mul(add(sub(q.z, q.y), s), float(0.5)), float(0), s);',
  '  const exact = length(vec3(q.x, add(sub(q.y, s), k), sub(q.z, k)));',
  '  const onFace = or(lessThan(mul(p.x, float(3)), m), or(lessThan(mul(p.y, float(3)), m), lessThan(mul(p.z, float(3)), m)));',
  '  return select(onFace, exact, mul(m, float(0.57735027)));',
  '});',
];

// Regular star / polygon (IQ sdStar): n points, m the inner angle divisor
// (m = n gives a regular n-gon). 2D position.
const SD_STAR_LINES = [
  'const sdStar = Fn(([pIn, r, n, m]) => {',
  '  const an = div(float(3.141593), max(n, float(1)));',
  '  const en = div(float(3.141593), max(m, float(1)));',
  '  const acs = vec2(cos(an), sin(an));',
  '  const ecs = vec2(cos(en), sin(en));',
  '  const bn = sub(mod(atan(pIn.x, pIn.y), mul(an, float(2))), an);',
  '  const p0 = mul(length(pIn), vec2(cos(bn), abs(sin(bn))));',
  '  const p1 = sub(p0, mul(acs, r));',
  '  const p2 = add(p1, mul(ecs, clamp(mul(dot(p1, ecs), float(-1)), float(0), div(mul(r, acs.y), ecs.y))));',
  '  return mul(length(p2), sign(p2.x));',
  '});',
];

// Rigid transform of the DOMAIN: the shape moves by t, turns by the XYZ
// angles (degrees, applied X then Y then Z) and grows by s. The distance the
// consumer computes must then be multiplied by s (Modify: scale) to stay a
// true distance — division by s inside is what makes the shape bigger.
const SDF_TRANSFORM_LINES = [
  'const sdfTransform = Fn(([p, tx, ty, tz, rx, ry, rz, s]) => {',
  '  const q0 = div(sub(p, vec3(tx, ty, tz)), max(s, float(1e-6)));',
  '  const az = radians(rz);',
  '  const cz = cos(az);',
  '  const sz = sin(az);',
  '  const q1 = vec3(add(mul(cz, q0.x), mul(sz, q0.y)), sub(mul(cz, q0.y), mul(sz, q0.x)), q0.z);',
  '  const ay = radians(ry);',
  '  const cy = cos(ay);',
  '  const sy = sin(ay);',
  '  const q2 = vec3(sub(mul(cy, q1.x), mul(sy, q1.z)), q1.y, add(mul(cy, q1.z), mul(sy, q1.x)));',
  '  const ax = radians(rx);',
  '  const cx = cos(ax);',
  '  const sx = sin(ax);',
  '  return vec3(q2.x, add(mul(cx, q2.y), mul(sx, q2.z)), sub(mul(cx, q2.z), mul(sx, q2.y)));',
  '});',
];

// Grid repetition (round form — the mod form differs between GLSL and WGSL
// for negative inputs). Spacing 0 leaves an axis alone; limit 0 is infinite,
// otherwise the instance index is clamped to ±limit.
const SDF_REPEAT_LINES = [
  'const sdfRepeat = Fn(([p, sx, sy, sz, lx, ly, lz]) => {',
  '  const ix = round(div(p.x, max(sx, float(1e-6))));',
  '  const iy = round(div(p.y, max(sy, float(1e-6))));',
  '  const iz = round(div(p.z, max(sz, float(1e-6))));',
  '  const cx = select(greaterThan(lx, float(0)), clamp(ix, mul(lx, float(-1)), lx), ix);',
  '  const cy = select(greaterThan(ly, float(0)), clamp(iy, mul(ly, float(-1)), ly), iy);',
  '  const cz = select(greaterThan(lz, float(0)), clamp(iz, mul(lz, float(-1)), lz), iz);',
  '  const rx = select(greaterThan(sx, float(0)), sub(p.x, mul(sx, cx)), p.x);',
  '  const ry = select(greaterThan(sy, float(0)), sub(p.y, mul(sy, cy)), p.y);',
  '  const rz = select(greaterThan(sz, float(0)), sub(p.z, mul(sz, cz)), p.z);',
  '  return vec3(rx, ry, rz);',
  '});',
];

// Polar repetition about Y: n copies around the axis (single evaluation, so
// the sector seam is visible on asymmetric shapes — documented).
const SDF_REPEAT_POLAR_LINES = [
  'const sdfRepeatPolar = Fn(([p, n]) => {',
  '  const sp = div(float(6.2831853), max(n, float(1)));',
  '  const an = atan(p.z, p.x);',
  '  const a = sub(an, mul(sp, floor(add(div(an, sp), float(0.5)))));',
  '  const r = length(p.xz);',
  '  return vec3(mul(r, cos(a)), p.y, mul(r, sin(a)));',
  '});',
];

// Mirror: fold each ticked axis (a 0..1 weight, so it can be animated).
const SDF_MIRROR_LINES = [
  'const sdfMirror = Fn(([p, x, y, z]) => {',
  '  return mix(p, abs(p), vec3(x, y, z));',
  '});',
];

// Modify a DISTANCE: round inflates by r, shell hollows to a wall of
// thickness t, scale rescales it (the downstream half of Transform's scale).
const SD_ROUND_LINES = [
  'const sdRound = Fn(([d, r]) => {',
  '  return sub(d, r);',
  '});',
];
const SD_SHELL_LINES = [
  'const sdShell = Fn(([d, t]) => {',
  '  return sub(abs(d), t);',
  '});',
];
const SD_SCALE_LINES = [
  'const sdScale = Fn(([d, s]) => {',
  '  return mul(d, s);',
  '});',
];

// Deform the DOMAIN: twist about Y, bend about Z (k in radians per unit),
// elongate stretches the shape's middle by h on each axis.
const SDF_TWIST_LINES = [
  'const sdfTwist = Fn(([p, k]) => {',
  '  const c = cos(mul(k, p.y));',
  '  const s = sin(mul(k, p.y));',
  '  return vec3(sub(mul(c, p.x), mul(s, p.z)), p.y, add(mul(s, p.x), mul(c, p.z)));',
  '});',
];
const SDF_BEND_LINES = [
  'const sdfBend = Fn(([p, k]) => {',
  '  const c = cos(mul(k, p.x));',
  '  const s = sin(mul(k, p.x));',
  '  return vec3(sub(mul(c, p.x), mul(s, p.y)), add(mul(s, p.x), mul(c, p.y)), p.z);',
  '});',
];
const SDF_ELONGATE_LINES = [
  'const sdfElongate = Fn(([p, hx, hy, hz]) => {',
  '  const h = vec3(hx, hy, hz);',
  '  return sub(p, clamp(p, mul(h, float(-1)), h));',
  '});',
];

// 2D → 3D: extrude a 2D distance along Z to half-depth h; revolve a 3D
// position into the 2D profile plane (radius − offset, height).
const SDF_EXTRUDE_LINES = [
  'const sdfExtrude = Fn(([d, p, h]) => {',
  '  const w = vec2(d, sub(abs(p.z), h));',
  '  return add(min(max(w.x, w.y), float(0)), length(max(w, float(0))));',
  '});',
];
const SDF_REVOLVE_LINES = [
  'const sdfRevolve = Fn(([p, o]) => {',
  '  return vec2(sub(length(p.xz), o), p.y);',
  '});',
];

// Distance → coverage: 1 inside, 0 outside, a linear ramp of width w on the
// edge. (Not smoothstep: equal edges are a WGSL compile error at w = 0.)
const SDF_MASK_LINES = [
  'const sdfMask = Fn(([d, w]) => {',
  '  return clamp(sub(float(1), div(d, max(w, float(1e-6)))), float(0), float(1));',
  '});',
];

/** Keyed by helper NAME; insertion order is emission order. */
export const MODULE_HELPERS: ReadonlyMap<string, ModuleHelper> = new Map<string, ModuleHelper>([
  ['hsl', { lines: HSL_HELPER_LINES, imports: ['mul', 'add', 'sub', 'abs', 'mod', 'clamp', 'float', 'vec3'] }],
  ['toHsl', { lines: TO_HSL_HELPER_LINES, imports: ['max', 'min', 'sub', 'add', 'mul', 'abs', 'select', 'greaterThan', 'lessThan', 'equal', 'div', 'float', 'vec3'] }],
  ['sdCircle', { lines: SD_CIRCLE_LINES, imports: ['sub', 'length'] }],
  ['sdBox3', { lines: SD_BOX3_LINES, imports: ['add', 'sub', 'abs', 'vec3', 'length', 'max', 'min', 'float'], alias: { type: 'sdBox', ports: ['p', 'w', 'h', 'd', 'round'] } }],
  ['sdBox2', { lines: SD_BOX2_LINES, imports: ['add', 'sub', 'abs', 'vec2', 'length', 'max', 'min', 'float'], alias: { type: 'sdBox', ports: ['p', 'w', 'h', 'round'] } }],
  ['sdTorus', { lines: SD_TORUS_LINES, imports: ['vec2', 'sub', 'length'] }],
  ['sdUnion', { lines: SD_UNION_LINES, imports: ['max', 'float', 'sub', 'abs', 'min', 'div', 'mul'] }],
  ['sdSubtract', { lines: SD_SUBTRACT_LINES, imports: ['max', 'float', 'mul', 'sub', 'abs', 'add', 'div'], alias: { type: 'sdCombine', values: { mode: 'subtract' } } }],
  ['sdIntersect', { lines: SD_INTERSECT_LINES, imports: ['max', 'float', 'sub', 'abs', 'add', 'div', 'mul'], alias: { type: 'sdCombine', values: { mode: 'intersect' } } }],
  ['sdXor', { lines: SD_XOR_LINES, imports: ['max', 'min', 'mul', 'float'], alias: { type: 'sdCombine', ports: ['a', 'b'], values: { mode: 'xor' } } }],
  ['sdCylinder', { lines: SD_CYLINDER_LINES, imports: ['sub', 'abs', 'vec2', 'length', 'add', 'min', 'max', 'float'] }],
  ['sdCapsule', { lines: SD_CAPSULE_LINES, imports: ['vec3', 'sub', 'clamp', 'mul', 'float', 'length'] }],
  ['sdCone', { lines: SD_CONE_LINES, imports: ['vec2', 'length', 'sub', 'mul', 'float', 'min', 'select', 'lessThan', 'abs', 'add', 'clamp', 'div', 'dot', 'sqrt'] }],
  ['sdPlane', { lines: SD_PLANE_LINES, imports: ['add', 'dot', 'normalize', 'vec3'] }],
  ['sdOctahedron', { lines: SD_OCTAHEDRON_LINES, imports: ['abs', 'sub', 'add', 'select', 'lessThan', 'mul', 'float', 'vec3', 'clamp', 'length', 'or'] }],
  ['sdStar', { lines: SD_STAR_LINES, imports: ['div', 'float', 'max', 'vec2', 'cos', 'sin', 'sub', 'mod', 'atan', 'mul', 'length', 'abs', 'add', 'clamp', 'dot', 'sign'] }],
  ['sdfTransform', { lines: SDF_TRANSFORM_LINES, imports: ['div', 'sub', 'vec3', 'max', 'float', 'radians', 'cos', 'sin', 'add', 'mul'] }],
  ['sdfRepeat', { lines: SDF_REPEAT_LINES, imports: ['round', 'div', 'max', 'float', 'select', 'greaterThan', 'clamp', 'mul', 'sub', 'vec3'] }],
  ['sdfRepeatPolar', { lines: SDF_REPEAT_POLAR_LINES, imports: ['div', 'float', 'max', 'atan', 'sub', 'mul', 'floor', 'add', 'length', 'vec3', 'cos', 'sin'] }],
  ['sdfMirror', { lines: SDF_MIRROR_LINES, imports: ['mix', 'abs', 'vec3'] }],
  ['sdRound', { lines: SD_ROUND_LINES, imports: ['sub'] }],
  ['sdShell', { lines: SD_SHELL_LINES, imports: ['sub', 'abs'], alias: { type: 'sdfModify', values: { mode: 'shell' } } }],
  ['sdScale', { lines: SD_SCALE_LINES, imports: ['mul'], alias: { type: 'sdfModify', values: { mode: 'scale' } } }],
  ['sdfTwist', { lines: SDF_TWIST_LINES, imports: ['cos', 'mul', 'sin', 'vec3', 'sub', 'add'], alias: { type: 'sdfDeform', ports: ['p', 'amount'], values: { mode: 'twist' } } }],
  ['sdfBend', { lines: SDF_BEND_LINES, imports: ['cos', 'mul', 'sin', 'vec3', 'sub', 'add'], alias: { type: 'sdfDeform', ports: ['p', 'amount'], values: { mode: 'bend' } } }],
  ['sdfElongate', { lines: SDF_ELONGATE_LINES, imports: ['vec3', 'sub', 'clamp', 'mul', 'float'], alias: { type: 'sdfDeform', ports: ['p', 'hx', 'hy', 'hz'], values: { mode: 'elongate' } } }],
  ['sdfExtrude', { lines: SDF_EXTRUDE_LINES, imports: ['vec2', 'sub', 'abs', 'add', 'min', 'max', 'float', 'length'] }],
  ['sdfRevolve', { lines: SDF_REVOLVE_LINES, imports: ['vec2', 'sub', 'length'] }],
  ['sdfMask', { lines: SDF_MASK_LINES, imports: ['clamp', 'sub', 'float', 'div', 'max'] }],
  ['rayDirection', { lines: RAY_DIRECTION_LINES, imports: ['normalize', 'sub', 'positionWorld', 'cameraPosition'] }],
]);

/** Every emitted helper name — what codeToGraph skips as a declarator. */
export const MODULE_HELPER_NAMES: ReadonlySet<string> = new Set(MODULE_HELPERS.keys());

/**
 * Call names that parse back into a def: every variant's name, plus the
 * LEGACY names of nodes that were folded (a `.js` exported by v0.3.29 still
 * calls them, and its helper declarations are skipped like any other).
 * `smoothUnion(a, b, k)` was the 2013 mix-form kernel; it maps onto Combine's
 * union with the same k — a slightly different fillet, accepted.
 */
export const HELPER_ALIASES: ReadonlyMap<string, HelperAlias> = new Map<string, HelperAlias>([
  ...[...MODULE_HELPERS].flatMap(([name, h]) => (h.alias ? [[name, h.alias] as [string, HelperAlias]] : [])),
  ['smoothUnion', { type: 'sdCombine', ports: ['a', 'b', 'k'], values: { mode: 'union' } }],
]);

/** Registry types that emit through this table under a name that is NOT
 *  their own `tslFunction` for some node (modes, or width dispatch). */
export const HELPER_OWNER_TYPES: ReadonlySet<string> = new Set([...HELPER_ALIASES.values()].map((a) => a.type));

/** helper name for (type, mode) — the variant whose alias stamps that mode. */
const MODE_VARIANTS: ReadonlyMap<string, ReadonlyMap<string, string>> = (() => {
  const out = new Map<string, Map<string, string>>();
  for (const [name, h] of MODULE_HELPERS) {
    const mode = h.alias?.values?.mode;
    if (!h.alias || typeof mode !== 'string') continue;
    if (!out.has(h.alias.type)) out.set(h.alias.type, new Map());
    out.get(h.alias.type)!.set(mode, name);
  }
  return out;
})();

/** The validated mode of a node, or the def's default. `values` is untrusted
 *  (`.fastshader` files), so anything outside the closed vocabulary is the
 *  default — and an ABSENT key is the default by design (byte stability). */
export function modeOf(def: { modes?: { values: readonly string[]; default: string } }, values: Record<string, unknown> | undefined): string {
  if (!def.modes) return '';
  const v = values?.mode;
  return typeof v === 'string' && def.modes.values.includes(v) ? v : def.modes.default;
}

/**
 * The helper a node's call must name: its def's `tslFunction` for the default
 * mode (and for every mode-less def), else the variant registered for the
 * node's mode. Width-dispatched defs (Box) pick theirs in graphToCode from the
 * wired position's shape, not here.
 */
export function helperNameFor(def: { type: string; tslFunction: string; modes?: { values: readonly string[]; default: string } }, values: Record<string, unknown> | undefined): string {
  if (!def.modes) return def.tslFunction;
  const mode = modeOf(def, values);
  if (mode === def.modes.default) return def.tslFunction;
  return MODE_VARIANTS.get(def.type)?.get(mode) ?? def.tslFunction;
}

/** The positional ports of a call to `name` (a variant may take fewer). */
export function helperCallPorts(name: string, defInputs: readonly { id: string }[]): readonly string[] {
  return HELPER_ALIASES.get(name)?.ports ?? defInputs.map((i) => i.id);
}

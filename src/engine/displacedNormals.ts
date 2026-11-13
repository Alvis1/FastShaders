/**
 * Displacement chains re-emitted for the vertex stage (buildShaderModule,
 * MODULE-only): normals that FOLLOW a displacement, and the one spelling of a
 * chain three can build inside a positionNode.
 *
 * NORMALS. three's node materials move the vertices by `positionNode` but keep
 * the geometry's own `normal` attribute for lighting, so a noise-displaced
 * sphere was lit as the smooth sphere it no longer is: the bumps showed only
 * on the silhouette. Nothing in three recomputes them, and a node graph cannot
 * be differentiated in general, so on a SMOOTH, LIT material the module
 * samples the displacement twice more — a small step along two directions in
 * the surface — and takes the normal of the three displaced points:
 *
 *   q  = D(0),  q1 = D(ε·t),  q2 = D(ε·b),  n' = normalize((q1−q) × (q2−q))
 *
 * where D(δ) is the displaced position of the vertex moved by δ (p + δ + n·d
 * along the normal, p + δ + d as an offset), t and b span the tangent plane of
 * the CURRENT normal n (skinned / morphed / welded — `setupPosition` runs the
 * positionNode after all of those), and n is held fixed for the two
 * neighbours. n' is written back with `normalLocal.assign`, exactly as three's
 * own SkinningNode does, so everything that reads a normal downstream
 * (lighting, normalWorld, Fresnel) sees the displaced surface. Needs no loader
 * change and runs on the frozen 0.6 too.
 *
 * D is the displacement CHAIN re-emitted inside `__fsDisp<N>` with every three
 * accessor it reads spelled out (`REBOUND`): a POSITION read moved by the step
 * δ — zero at the vertex itself, so `positionGeometry` stays the attribute it
 * is (a skinned model's bind pose, not its deformed `positionLocal`) — and a
 * NORMAL read bound to the held n. A chain that also reads uv(), a texture or
 * time keeps those as they are at the vertex, so only the position-driven part
 * of the relief shapes the normal. The recompute is decided by the four
 * position ROOTS alone (`POSITION_ROOTS`): a chain reading none — a constant,
 * a uniform, a uv()-only height, a normal — gets none (the same D everywhere
 * around p would give back n). The cost model prices the same decision
 * (`utils/displacedNormalCost.ts`).
 *
 * VERTEX-SAFE. Spelling the accessors out is also what lets some chains run
 * in a positionNode at all: three r184 builds a few of them wrongly there
 * (`VERTEX_UNSAFE`, measured in the vertex WGSL 2026-11-12):
 *  - normalView / normalWorld go through the material's normal setup. On a
 *    Faces: Flat material that is the pixel derivative of the very position
 *    being built — "Recursion detected", and the vertex shader does not
 *    compile. Elsewhere it writes the `v_normalViewGeometry` varying from
 *    `normalLocal` BEFORE `normalLocal` is assigned: a zero normal, normalized
 *    to NaN. A Normal (world) wired to Position made the shape vanish, and a
 *    Fresnel-driven one lost its lighting (the pixels read that varying).
 *  - positionView / positionViewDirection write the `v_positionView` varying
 *    from the UNDISPLACED point, and the clip position reuses it: the
 *    displacement is silently ignored.
 * So a chain reading one of those is wrapped on EVERY material: on a Flat or
 * Unlit one, or a smooth one with no position root, the wrapper evaluates D(0)
 * once and writes no normal. A chain reading none of them keeps today's
 * `positionLocal.add(…)` byte for byte, as does one this text pass cannot
 * trace (a chain reaching a multi-line statement, an imperative Fn block).
 *
 * The heavy nodes a chain calls (mx_noise_*, mx_fractal_*, mx_worley_*) are
 * three's own setLayout functions, so the three calls add call sites, not
 * copies of the noise body; the chain's own one-liners are emitted twice more.
 */
import { maskNonCode } from './tslCodeProcessor';

/** The vertex moved by the step `__d` (zero at the vertex itself). */
const AT = 'positionLocal.add(__d)';
/** The held normal in view space, built as three builds a smooth vertex normal (normalViewGeometry). */
const N_VIEW = 'transformNormalToView(__n)';
/** …and in world space, as three's normalWorld turns normalView back out of the camera. */
const N_WORLD = `${N_VIEW}.transformDirection(cameraViewMatrix)`;

/**
 * Every three accessor a chain is re-evaluated over inside `__fsDisp<N>`, and
 * what it becomes there. Left alone, because three builds them right in a
 * positionNode and they mean something else: `normalGeometry` (the attribute,
 * a skinned model's bind-pose normal) and `positionWorldDirection` (read at
 * the vertex, like uv). `normalFlat` is a pixel derivative no vertex has: it
 * reads the smooth normal. `positionViewDirection` assumes a perspective camera
 * (three answers (0, 0, 1) under an orthographic one).
 */
export const REBOUND: ReadonlyMap<string, string> = new Map([
  ['positionGeometry', 'positionGeometry.add(__d)'],
  ['positionLocal', AT],
  ['positionWorld', `modelWorldMatrix.mul(vec4(${AT}, 1)).xyz`],
  ['positionView', `modelViewMatrix.mul(vec4(${AT}, 1)).xyz`],
  ['positionViewDirection', `modelViewMatrix.mul(vec4(${AT}, 1)).xyz.negate().normalize()`],
  ['normalLocal', '__n'],
  ['normalView', N_VIEW],
  ['normalViewGeometry', N_VIEW],
  ['normalFlat', N_VIEW],
  ['clearcoatNormalView', N_VIEW],
  ['transformedNormalView', N_VIEW],
  ['normalWorld', N_WORLD],
  ['normalWorldGeometry', N_WORLD],
  ['transformedNormalWorld', N_WORLD],
]);

/**
 * The position reads that make a relief position-driven: the normal
 * recompute's decision. `utils/displacedNormalCost.ts` prices the same set
 * (`DISPLACED_NORMAL_ROOTS`, held equal by displacedNormals.test.ts).
 */
export const POSITION_ROOTS: readonly string[] = ['positionGeometry', 'positionLocal', 'positionWorld', 'positionView'];

/** The reads three r184 builds wrongly inside a positionNode (header): a chain reading one is always wrapped. */
export const VERTEX_UNSAFE: readonly string[] = [
  'positionView', 'positionViewDirection',
  'normalView', 'normalWorld', 'normalViewGeometry', 'normalWorldGeometry', 'normalFlat',
  'clearcoatNormalView', 'transformedNormalView', 'transformedNormalWorld',
];

/** The three/tsl names the pass adds to a module's import (scriptToTSL drops them again when unused). */
export const DISPLACED_NORMAL_IMPORTS: ReadonlySet<string> = new Set([
  'cross', 'select', 'abs', 'modelWorldMatrix', 'modelViewMatrix', 'vec4', 'transformNormalToView', 'cameraViewMatrix',
]);

/** The step, in object units: the preview's shapes and normalized models are ~1–1.6 across. */
export const DISPLACED_NORMAL_EPSILON = '0.001';

/** Any of `names` as a whole token, never a member (`.positionLocal`) or a longer name. */
const tokenRe = (names: Iterable<string>): RegExp =>
  new RegExp(`(?<![\\w$.])(${[...names].sort((a, b) => b.length - a.length).join('|')})(?![\\w$])`, 'g');
const TOKEN = tokenRe(REBOUND.keys());
const ROOT_TOKEN = tokenRe(POSITION_ROOTS);
const UNSAFE_TOKEN = tokenRe(VERTEX_UNSAFE);
const DEF = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;
const IDENT = /[A-Za-z_$][\w$]*/g;

export interface DisplacedNormalPlan {
  /** Body lines declaring the displacement Fn and the positionNode's Fn. */
  lines: string[];
  /** The positionNode expression wrapping `displaced`, today's positionNode. */
  expr: string;
}

/** Replace every `REBOUND` read in code (strings and comments untouched). */
function rebind(text: string): string {
  const masked = maskNonCode(text);
  let out = '';
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(masked); m; m = TOKEN.exec(masked)) {
    out += text.slice(last, m.index) + REBOUND.get(m[1])!;
    last = m.index + m[1].length;
  }
  return out + text.slice(last);
}

function reads(token: RegExp, text: string): boolean {
  token.lastIndex = 0;
  return token.test(maskNonCode(text));
}

/**
 * Plan ONE position channel `ref` over the shader body's top-level `lines`:
 * the normal recompute (`recompute` and the chain reads a position root), the
 * vertex-safe wrapper alone (the chain reads a `VERTEX_UNSAFE` accessor), or
 * null — today's positionNode — when it needs neither or the chain cannot be
 * traced. `id` keeps two materials' Fns apart.
 */
export function planDisplacedNormal(
  ref: string,
  lines: readonly string[],
  mode: 'normal' | 'offset',
  id: number,
  /** Today's positionNode for `ref` (`positionLocal.add(…)`), spelled as the call's argument and never built. */
  displaced: string,
  /** False on a material that keeps no vertex normal to rewrite: Faces: Flat (the pixel derivatives already follow the shape) and Unlit (reads no normal). */
  recompute = true,
): DisplacedNormalPlan | null {
  // Top-level statements, by bracket depth over the MASKED text: a one-line
  // `const x = …;` is re-emittable; a name declared by a multi-line statement
  // is OPAQUE (an imperative Fn block cannot be re-run on a moved point).
  const defs = new Map<string, { index: number; text: string }>();
  const opaque = new Set<string>();
  let depth = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const masked = maskNonCode(lines[i]);
    if (depth === 0) start = i;
    for (const ch of masked) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    }
    if (depth !== 0) continue;
    const m = DEF.exec(lines[start]);
    if (!m) continue;
    if (start === i && /;\s*$/.test(masked)) defs.set(m[1], { index: i, text: lines[i] });
    else opaque.add(m[1]);
  }

  const seen = new Set<string>();
  const queue = [...(maskNonCode(ref).match(IDENT) ?? [])];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    if (opaque.has(name)) return null;
    const def = defs.get(name);
    if (!def) continue;
    const rhs = maskNonCode(def.text.slice(def.text.indexOf('=') + 1));
    for (const w of rhs.match(IDENT) ?? []) if (!seen.has(w)) queue.push(w);
  }
  const chain = [...defs.entries()]
    .filter(([name]) => seen.has(name))
    .sort((a, b) => a[1].index - b[1].index)
    .map(([, d]) => d.text.trim());
  const texts = [ref, ...chain];
  const relief = recompute && texts.some((t) => reads(ROOT_TOKEN, t));
  if (!relief && !texts.some((t) => reads(UNSAFE_TOKEN, t))) return null;

  const disp = `__fsDisp${id}`;
  const displacedExpr = mode === 'normal' ? `${AT}.add(__n.mul(${rebind(ref)}))` : `${AT}.add(${rebind(ref)})`;
  const out = [
    `const ${disp} = Fn(([__d, __n]) => {`,
    ...chain.map((l) => `  ${rebind(l)}`),
    `  return ${displacedExpr};`,
    '});',
  ];
  // `__q0` is today's positionNode, PASSED IN so that the module still spells
  // it and scriptToTSL can unwrap the call, and deliberately never BUILT: it
  // reads three's own accessors through the module-scope chain, which is what
  // broke (header). Built as `__q0.toVar()`, a Fresnel-driven displacement
  // lost its lighting under Along normal (2026-11-12).
  if (!relief) {
    out.push(
      `const __fsDisplaced${id} = Fn(([__q0]) => {`,
      `  return ${disp}(vec3(0), normalLocal);`,
      '});',
    );
  } else {
    const step = (dir: string): string => `${dir}.mul(${DISPLACED_NORMAL_EPSILON})`;
    // `__q` and `__n` are vars taken BEFORE the assign: read lazily after it,
    // they would see the rewritten normal.
    out.push(
      `const __fsDisplaced${id} = Fn(([__q0]) => {`,
      '  const __n = normalLocal.toVar();',
      `  const __q = ${disp}(vec3(0), __n).toVar();`,
      '  const __t = cross(__n, select(abs(__n.y).greaterThan(0.99), vec3(1, 0, 0), vec3(0, 1, 0))).normalize().toVar();',
      '  const __b = cross(__n, __t).toVar();',
      `  const __q1 = ${disp}(${step('__t')}, __n);`,
      `  const __q2 = ${disp}(${step('__b')}, __n);`,
      '  normalLocal.assign(cross(__q1.sub(__q), __q2.sub(__q)).normalize());',
      '  return __q;',
      '});',
    );
  }
  return { lines: out, expr: `__fsDisplaced${id}(${displaced})` };
}

const DECL_HEAD = /^[ \t]*const\s+__fsDisp(?:laced)?\d+\s*=\s*Fn\(/;
const CALL_HEAD = /\b__fsDisplaced\d+\(/g;

/**
 * The inverse, for scriptToTSL: delete every `__fsDisp<N>` / `__fsDisplaced<N>`
 * declaration and unwrap each `__fsDisplaced<N>(X)` call to `X` — today's
 * positionNode, which the importer already reads. Brackets are balanced over
 * the MASKED text, so a string in the chain cannot end a declaration early.
 * A module without the names is returned unchanged.
 */
export function stripDisplacedNormals(code: string): string {
  if (!/\b__fsDisp(?:laced)?\d+\b/.test(code)) return code;
  const lines = code.split('\n');
  const masked = maskNonCode(code).split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!DECL_HEAD.test(masked[i])) { kept.push(lines[i]); continue; }
    let depth = 0;
    let j = i;
    for (; j < lines.length; j++) {
      for (const ch of masked[j]) {
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
      }
      if (depth <= 0) break;
    }
    i = j;
  }
  let out = kept.join('\n');
  // Unwrap calls innermost-last: each pass removes one wrapper per call site.
  for (let guard = 0; guard < 100; guard++) {
    const m = maskNonCode(out);
    CALL_HEAD.lastIndex = 0;
    const hit = CALL_HEAD.exec(m);
    if (!hit) break;
    const open = hit.index + hit[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let k = open; k < m.length; k++) {
      if (m[k] === '(') depth++;
      else if (m[k] === ')' && --depth === 0) { close = k; break; }
    }
    if (close === -1) break;
    out = out.slice(0, hit.index) + out.slice(open + 1, close) + out.slice(close + 1);
  }
  return out;
}

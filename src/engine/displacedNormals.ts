/**
 * Normals that FOLLOW a displacement (buildShaderModule, MODULE-only).
 *
 * three's node materials move the vertices by `positionNode` but keep the
 * geometry's own `normal` attribute for lighting, so a noise-displaced sphere
 * was lit as the smooth sphere it no longer is: the bumps showed only on the
 * silhouette. Nothing in three recomputes them, and a node graph cannot be
 * differentiated in general, so the module samples the displacement twice
 * more — a small step along two directions in the surface — and takes the
 * normal of the three displaced points:
 *
 *   q  = D(p),  q1 = D(p + ε·t),  q2 = D(p + ε·b),  n' = normalize((q1−q) × (q2−q))
 *
 * where D(x) is the displaced position (x + n·d(x) along the normal, x + d(x)
 * as an offset), t and b span the tangent plane of the CURRENT normal n
 * (skinned / morphed / welded — `setupPosition` runs the positionNode after all
 * of those), and n is held fixed for the two neighbours. n' is written back
 * with `normalLocal.assign`, exactly as three's own SkinningNode does, so
 * everything that reads a normal downstream (lighting, normalWorld, Fresnel)
 * sees the displaced surface. Needs no loader change and runs on the frozen
 * 0.6 too.
 *
 * D(x) is the displacement CHAIN re-emitted inside an Fn with every position
 * READ substituted (`REBOUND`). Only the position is moved: a chain that also
 * reads uv(), a normal, a texture or time keeps those as they are at the
 * vertex, so only the position-driven part of the relief shapes the normal.
 * A chain that reads NO position — a constant, a uniform, a uv()-only height —
 * gets no recompute at all (the same D everywhere around p would give back n),
 * and neither does one this text pass cannot trace: a chain reaching a
 * multi-line statement (an imperative Fn block) keeps today's emission. The
 * cost model prices the same decision (`utils/displacedNormalCost.ts`).
 *
 * The heavy nodes a chain calls (mx_noise_*, mx_fractal_*, mx_worley_*) are
 * three's own setLayout functions, so the three calls add call sites, not
 * copies of the noise body; the chain's own one-liners are emitted twice more.
 */
import { maskNonCode } from './tslCodeProcessor';

/** The position reads the chain is re-evaluated over, and what each becomes for a moved point `__p`. */
export const REBOUND: ReadonlyMap<string, string> = new Map([
  ['positionGeometry', '__p'],
  ['positionLocal', '__p'],
  ['positionWorld', 'modelWorldMatrix.mul(vec4(__p, 1)).xyz'],
  ['positionView', 'modelViewMatrix.mul(vec4(__p, 1)).xyz'],
]);

/** The three/tsl names the pass adds to a module's import (scriptToTSL drops them again when unused). */
export const DISPLACED_NORMAL_IMPORTS: ReadonlySet<string> = new Set([
  'cross', 'select', 'abs', 'modelWorldMatrix', 'modelViewMatrix', 'vec4',
]);

/** The step, in object units: the preview's shapes and normalized models are ~1–1.6 across. */
export const DISPLACED_NORMAL_EPSILON = '0.001';

/** `positionLocal` and friends as a whole token, never a member (`.positionLocal`) or a longer name. */
const TOKEN = /(?<![\w$.])(positionGeometry|positionLocal|positionWorld|positionView)(?![\w$])/g;
const DEF = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;
const IDENT = /[A-Za-z_$][\w$]*/g;

export interface DisplacedNormalPlan {
  /** Body lines declaring the displacement Fn and the normal Fn. */
  lines: string[];
  /** The positionNode expression wrapping `displaced`, today's positionNode. */
  expr: string;
}

/** Replace every position READ in code (strings and comments untouched). */
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

function readsPosition(text: string): boolean {
  TOKEN.lastIndex = 0;
  return TOKEN.test(maskNonCode(text));
}

/**
 * Plan the recompute for ONE position channel `ref` over the shader body's
 * top-level `lines`, or null when there is nothing to recompute (no position
 * read) or the chain cannot be traced. `id` keeps two materials' Fns apart.
 */
export function planDisplacedNormal(
  ref: string,
  lines: readonly string[],
  mode: 'normal' | 'offset',
  id: number,
  /** Today's positionNode for `ref` (`positionLocal.add(…)`): the vertex's own displaced point. */
  displaced: string,
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
  if (!readsPosition(ref) && !chain.some(readsPosition)) return null;

  const disp = `__fsDisp${id}`;
  const step = (dir: string): string => `positionLocal.add(${dir}.mul(${DISPLACED_NORMAL_EPSILON}))`;
  const displacedExpr = mode === 'normal' ? `__p.add(__n.mul(${rebind(ref)}))` : `__p.add(${rebind(ref)})`;
  return {
    lines: [
      `const ${disp} = Fn(([__p, __n]) => {`,
      ...chain.map((l) => `  ${rebind(l)}`),
      `  return ${displacedExpr};`,
      '});',
      // `__q0` is today's positionNode, PASSED IN (never closure-captured) so
      // that the module still spells it and scriptToTSL can unwrap the call.
      // It is captured into a var BEFORE the assign: read later, it would see
      // the rewritten normal.
      `const __fsDisplaced${id} = Fn(([__q0]) => {`,
      '  const __q = __q0.toVar();',
      '  const __n = normalLocal.toVar();',
      '  const __t = cross(__n, select(abs(__n.y).greaterThan(0.99), vec3(1, 0, 0), vec3(0, 1, 0))).normalize().toVar();',
      '  const __b = cross(__n, __t).toVar();',
      `  const __q1 = ${disp}(${step('__t')}, __n);`,
      `  const __q2 = ${disp}(${step('__b')}, __n);`,
      '  normalLocal.assign(cross(__q1.sub(__q), __q2.sub(__q)).normalize());',
      '  return __q;',
      '});',
    ],
    expr: `__fsDisplaced${id}(${displaced})`,
  };
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

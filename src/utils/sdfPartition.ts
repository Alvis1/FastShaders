/**
 * Which nodes the RAYMARCH OUTPUT re-evaluates PER RAY STEP.
 *
 * The Raymarch Output marches rays through fields built from `Local Position`:
 * a distance Field it sphere-traces to a hit, a Density it integrates as a
 * translucent volume, or both. The chain a user wires into a per-step socket
 * has to be evaluated at the ray position, many times per pixel — so
 * graphToCode emits the part of the graph that DEPENDS on a march root
 * (positionLocal / positionGeometry — object space, pre-displacement) inside
 * a `Fn(([p]) => { … })`, with each root emitted as `const <root> = p;`, and
 * calls that Fn from the loop. Everything else stays in the flat body and is
 * captured by closure (closure capture of outer nodes type-checks and renders
 * on r184 — measured 2026-09-02).
 *
 * The Background socket is the same mechanism over a different root:
 * `rayDirection` is substituted with the ray's FINAL direction, so an equirect
 * image sampled by it shows the sky the bent ray actually left toward — that
 * is the lensing.
 *
 * Pure so `nodeCost` can price a per-step body `steps × Σ` with the SAME
 * partition the emitter uses, and so the parser's inverse is testable.
 *
 * A node in two sets (feeding Field AND Color, say) is emitted into both Fns
 * — separate function scopes, same var name. On a code-panel Apply that parses
 * back as two nodes; accepted for v1.
 *
 * The SPLAT OUTPUT (`splatOutput`) is the second custom sink and the same
 * mechanism over a different set of roots: its four Fns — shade (Color,
 * Opacity, and a LIT node's five Light sockets), shape (Move, Cut), size and
 * feather — are called ONCE PER SPLAT by loader 0.8's vertex wrapper with
 * `(p, pw, n, c)`: the splat's object-space centre, that centre in world
 * space, a world-space direction `n` (toward the camera, or — on a lit node —
 * the splat's own surface normal; see SPLAT_PARAMS) and the splat's own
 * colour. A spec is therefore a `ScopeSpec`: the SOCKETS whose feeders it
 * evaluates and the PARAMETERS (each standing in for a set of root types) its
 * Fn takes. The march's specs are the one-socket, one-parameter case, and emit
 * exactly what they did.
 */
import { isSplatLit, SPLAT_LIGHT_PORTS } from './splatLight';
import { SPLAT_MODEL_SIZE } from './splatFrame';
import type { AppNode, AppEdge } from '@/types';
// `getNodeValues` lives in types/node.types.ts, which imports nothing at run
// time; wireframeMode.ts imports nothing at all. Both keep this a leaf.
import { getNodeValues } from '@/types';
import { isWireframeEdges } from './wireframeMode';
// Both LEAVES. This module is itself a leaf that `nodeCost` — and through it
// the store — imports, so it must never reach into the store-coupled utils
// graph (utils/outputMaterials.ts -> exposedPorts -> edgeUtils -> useAppStore):
// that is the costTable TDZ rule, and `isUntargetedOutput` below is exactly
// the kind of shared predicate that invites the wrong import direction.
import { emitRank, isGltfMaterialIndex } from '@/engine/materialPartsContract';
import { isUsableMeshName } from './meshInventory';

export const MARCH_OUTPUT_TYPE = 'raymarchOutput';
export const SPLAT_OUTPUT_TYPE = 'splatOutput';

/** Registry types the POSITION parameter substitutes for. Object space only. */
export const MARCH_ROOT_TYPES: ReadonlySet<string> = new Set(['positionLocal', 'positionGeometry']);
/** Registry types the DIRECTION parameter substitutes for (world space). */
export const DIR_ROOT_TYPES: ReadonlySet<string> = new Set(['rayDirection']);

/** One Fn parameter and the root types it stands in for. */
export interface ScopeParam {
  name: string;
  roots: ReadonlySet<string>;
}

/**
 * A root that is NOT a parameter but must not be read where the Fn runs
 * either: inside the scope it is bound to a fixed expression. Only the splat
 * has any (see `SPLAT_CONSTANTS`).
 */
export interface ScopeConstant {
  /** The emitted binding, verbatim: `const uv1 = <expr>;`. */
  expr: string;
  /** The three/tsl names `expr` calls. */
  imports: readonly string[];
  roots: ReadonlySet<string>;
}

/**
 * What a scope Fn is a function OF. `handle` is the scope's key — the socket
 * itself for the march, the Fn's role (`shade` / `shape` / `size` / `feather`) for the
 * splat; `sockets` are the sink sockets whose feeders it evaluates; `params`
 * are its Fn parameters in signature order.
 */
export interface ScopeSpec {
  handle: string;
  sockets: readonly string[];
  params: readonly ScopeParam[];
  constants?: readonly ScopeConstant[];
  /**
   * A node that reads one of this scope's roots IMPLICITLY — through an input
   * it leaves unwired, whose default is a geometry read (`implicitRootOf`) —
   * belongs to the scope as if that root were wired in, and is emitted there
   * with the default bound to the same parameter or constant. Only the splat
   * sets it: its Fns run in a VERTEX stage where the geometry is the quad
   * corner. The march leaves it unset, so its partition and emission are
   * exactly what they were.
   */
  implicitRoots?: true;
}

const MARCH_POSITION: readonly ScopeParam[] = [{ name: 'p', roots: MARCH_ROOT_TYPES }];
const MARCH_DIRECTION: readonly ScopeParam[] = [{ name: 'dir', roots: DIR_ROOT_TYPES }];

/** The per-step sockets, in emission order. */
export const MARCH_SCOPES: readonly ScopeSpec[] = [
  { handle: 'field', sockets: ['field'], params: MARCH_POSITION },
  { handle: 'density', sockets: ['density'], params: MARCH_POSITION },
  { handle: 'color', sockets: ['color'], params: MARCH_POSITION },
  { handle: 'emissive', sockets: ['emissive'], params: MARCH_POSITION },
  { handle: 'glow', sockets: ['glow'], params: MARCH_POSITION },
  { handle: 'background', sockets: ['background'], params: MARCH_DIRECTION },
];

/** The node DRIVES the shader when either march socket is wired. */
export const MARCH_PRIMARY_SOCKETS: readonly string[] = ['field', 'density'];

/**
 * The splat Fns' parameters, in the order loader 0.8 passes them: `p` the
 * splat's object-space centre, `pw` that centre in world space, `n` a WORLD
 * space direction (toward the camera; on a LIT node the splat's own surface
 * normal) and `c` the splat's own colour (vec4), which Vertex Color reads.
 *
 * `n` is Normal (World) only, and nothing may derive a VIEW direction from it.
 * See docs/dev/splats.md.
 */
export const SPLAT_PARAMS: readonly ScopeParam[] = [
  { name: 'p', roots: new Set(['positionLocal', 'positionGeometry']) },
  { name: 'pw', roots: new Set(['positionWorld']) },
  { name: 'n', roots: new Set(['normalWorld']) },
  { name: 'c', roots: new Set(['vertexColor']) },
];

/** The root types a splat Fn reads `n` through — the parameter itself, or the
 *  object-space constant built from it. */
export const SPLAT_NORMAL_ROOTS: ReadonlySet<string> = new Set(['normalWorld', 'normalLocal']);

/** The splat Fns' parameter list as emitted: `Fn(([p, pw, n, c]) => …)`. */
export const SPLAT_FN_PARAMS: readonly string[] = SPLAT_PARAMS.map((p) => p.name);

/**
 * Roots that would differ between the four CORNERS of one splat's quad in the
 * vertex stage. Inside a splat scope each is bound to the splat's CENTRE, so
 * every value the Fns return stays per SPLAT (a per-corner Move or Cut would
 * tear the quad). See docs/dev/splats.md.
 *
 *  - `uv`: a front projection of the centre; `p.xy` spans ±SPLAT_MODEL_SIZE/2.
 *  - `screenUV`: the centre on screen, top-left origin; the clip position is
 *    ONE node read twice (the arrow's parameter).
 *  - `normalLocal`: `n` back in OBJECT space, through the world matrix's
 *    transpose.
 *  - the view/world readings three derives from `positionLocal`, restated
 *    over the centre; `rayDirection` reads `pw`, never `n`.
 */
export const SPLAT_CONSTANTS: readonly ScopeConstant[] = [
  { expr: `p.xy.div(${SPLAT_MODEL_SIZE}).add(0.5)`, imports: [], roots: new Set(['uv']) },
  {
    expr: '((clip) => clip.xy.div(clip.w))(cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(p, 1)))).mul(vec2(0.5, -0.5)).add(0.5)',
    imports: ['cameraProjectionMatrix', 'modelViewMatrix', 'vec2', 'vec4'],
    roots: new Set(['screenUV']),
  },
  { expr: 'modelWorldMatrix.transpose().mul(vec4(n, 0)).xyz.normalize()', imports: ['modelWorldMatrix', 'vec4'], roots: new Set(['normalLocal']) },
  { expr: 'modelViewMatrix.mul(vec4(p, 1)).xyz', imports: ['modelViewMatrix', 'vec4'], roots: new Set(['positionView']) },
  {
    expr: 'modelViewMatrix.mul(vec4(p, 1)).xyz.negate().normalize()',
    imports: ['modelViewMatrix', 'vec4'],
    roots: new Set(['positionViewDirection']),
  },
  { expr: 'p.transformDirection(modelWorldMatrix)', imports: ['modelWorldMatrix'], roots: new Set(['positionWorldDirection']) },
  { expr: 'pw.sub(cameraPosition).normalize()', imports: ['cameraPosition'], roots: new Set(['rayDirection']) },
];

/**
 * The splat's four Fns, in emission order. Feather is a scope like Size: the
 * loader reads it per VERTEX (its cut test and fade run in the wrapper), so a
 * Feather that depends on the splat must be a Fn of the splat's own centre —
 * a flat node would be read at each quad CORNER and tear the quad.
 *
 * The Light sockets (a LIT Splat Output's key light, utils/splatLight.ts)
 * belong to `shade`: the light line is emitted inside the shade Fn, so a light
 * that depends on the splat is read at its centre, per splat, like Color.
 * Only while the node is lit — see `splatScopes`.
 */
export const SPLAT_SCOPES: readonly ScopeSpec[] = [
  { handle: 'shade', sockets: ['color', 'opacity', ...SPLAT_LIGHT_PORTS], params: SPLAT_PARAMS, constants: SPLAT_CONSTANTS, implicitRoots: true },
  { handle: 'shape', sockets: ['move', 'cut'], params: SPLAT_PARAMS, constants: SPLAT_CONSTANTS, implicitRoots: true },
  { handle: 'size', sockets: ['size'], params: SPLAT_PARAMS, constants: SPLAT_CONSTANTS, implicitRoots: true },
  { handle: 'feather', sockets: ['feather'], params: SPLAT_PARAMS, constants: SPLAT_CONSTANTS, implicitRoots: true },
];

/** An UNLIT node's scopes: no Light socket is read anywhere (the light line is
 *  not emitted), so a wire into one is DORMANT and its feeder stays in the
 *  flat body like any node nothing reads — never a dead line inside `shade`. */
const SPLAT_SCOPES_UNLIT: readonly ScopeSpec[] = SPLAT_SCOPES.map((sp) =>
  sp.handle === 'shade' ? { ...sp, sockets: sp.sockets.filter((s) => !SPLAT_LIGHT_PORTS.includes(s)) } : sp,
);

/** The scopes a Splat Output's program is split into: every Light socket in
 *  `shade` while the node is lit, none while it is not. */
export function splatScopes(node: AppNode): readonly ScopeSpec[] {
  return isSplatLit((node.data as { values?: unknown }).values) ? SPLAT_SCOPES : SPLAT_SCOPES_UNLIT;
}

/**
 * The noise family — every registry def in the `noise` category
 * (sdfPartition.test.ts pins the two lists against each other). Its position
 * is an exposed PARAMETER, `pos`, whose unwired default is not a number but a
 * stored IDENTIFIER: `positionGeometry`, or whatever bare global a pasted
 * shader named (codeToGraph stores `posArg.name`).
 */
export const NOISE_TYPES: ReadonlySet<string> = new Set([
  'perlin', 'perlinVec3', 'fbm', 'fbmVec3', 'cellNoise', 'voronoi', 'voronoiVec2', 'voronoiVec3',
]);

/** The noise family's registry default for `pos`. */
export const NOISE_POS_DEFAULT = 'positionGeometry';

/**
 * A bare JS identifier — the only NON-NUMERIC shape allowed to reach the
 * emitted module out of stored `values` (the noise `pos` key). Deliberately
 * shape-based rather than a membership whitelist: codeToGraph stores whatever
 * variable name a pasted shader used for a noise position
 * (`extractedValues.pos = posArg.name`), so a membership test would silently
 * rewrite those graphs. The SHAPE is what makes it safe — it can hold no `(`,
 * `)`, `;` or quote, so the worst it can produce is the bare reference the old
 * `String()` already produced (a ReferenceError at load). Moved here from
 * graphToCode.ts with `noisePosIdentifier`, its one reader.
 */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The identifier an UNWIRED noise `pos` emits, from its stored value (already
 * through `getNodeValues`, so it coerces without throwing): the value itself
 * when it is a bare identifier, else the registry default. THE one rule —
 * graphToCode's `resolveExposedParam` calls it for the flat text and
 * `implicitRootOf` for the partition, so the two cannot disagree about which
 * root a noise reads.
 */
export function noisePosIdentifier(raw: unknown): string {
  const s = String(raw ?? NOISE_POS_DEFAULT);
  return IDENTIFIER_RE.test(s) ? s : NOISE_POS_DEFAULT;
}

/**
 * THE IMPLICIT READS — the root type a node reads from the GEOMETRY through an
 * input it leaves unwired, or null. `wired(handle)` answers whether that input
 * has a wire.
 *
 * An unwired input normally emits a NUMBER (resolveArguments: the stored value,
 * the registry default, the chain identity), and a number is the same in every
 * stage. A handful emit a geometry read instead — and inside a Splat Output's
 * Fns, which run in the splat renderer's VERTEX stage, the geometry is the
 * instanced QUAD: `positionGeometry` is its corner (±2, the same for every
 * splat and different per corner) and `uv()` does not exist. Such a read makes
 * a Cut or Move different at the four corners of ONE splat — the collapse is
 * per vertex, so the quad tears — and a noise on Color the same for every
 * splat. The complete list, enumerated from the registry and graphToCode's
 * emitter branches (resolveArguments and numericParam never read geometry):
 *
 *   noise family (8)  `pos`     → its stored identifier (`positionGeometry`)
 *   imageNode         `uv`      → `uv()` / `uv(n)`, unless Direction is wired
 *   colormap, dataRange, isolines  `value` → `uv().x`
 *   dataviz           `signal`  → samples at `uv()` (a traced Data column is
 *                                 an edge from the Data node, itself below)
 *   stripes, dataNode, wireframe (grid)   always sample at `uv()`
 *
 * A scope with `implicitRoots` binds the returned type like a wired root
 * (`bindingOfRoot`): `p` for a position, `pw`, `n` (or its object-space
 * constant), and the per-splat front projection for a uv. A type the scope does not bind — a pasted
 * `cameraPosition`, the edges wireframe's `bary` attribute — is no implicit
 * root, and the node stays where its wires put it.
 *
 * Root nodes themselves (Local Position, UV, …) are not here: they ARE roots.
 */
export function implicitRootOf(node: AppNode, wired: (handle: string) => boolean): string | null {
  const type = node.data.registryType;
  if (NOISE_TYPES.has(type)) return wired('pos') ? null : noisePosIdentifier(getNodeValues(node).pos);
  switch (type) {
    case 'imageNode':
      return wired('uv') || wired('dir') ? null : 'uv';
    case 'colormap':
    case 'dataRange':
    case 'isolines':
      return wired('value') ? null : 'uv';
    case 'dataviz':
      return wired('signal') ? null : 'uv';
    case 'stripes':
    case 'dataNode':
      return 'uv';
    case 'wireframe':
      return isWireframeEdges(getNodeValues(node)) ? null : 'uv';
    default:
      return null;
  }
}

/**
 * The stored identifier a splat binding parses back to, when it stands where a
 * noise's `pos` would be — the inverse codeToGraph needs so that
 * `mx_noise_float(p)` inside a splat Fn is an UNWIRED position again rather
 * than a stored `p` (which would re-emit a bare `p` outside the Fn: a
 * ReferenceError at load). The registry default where the binding covers it,
 * else the one bare-global root it stands for; null for anything that is not
 * one of the scope's bindings.
 */
export function implicitIdentifierOf(spec: ScopeSpec, expr: string): string | null {
  const pick = (roots: ReadonlySet<string>): string =>
    roots.has(NOISE_POS_DEFAULT) ? NOISE_POS_DEFAULT : roots.has('screenUV') ? 'screenUV' : [...roots][0];
  for (const p of spec.params) if (p.name === expr) return pick(p.roots);
  for (const c of spec.constants ?? []) if (c.expr === expr) return pick(c.roots);
  return null;
}

/** A Splat Output with any of these wired drives an unflagged document. */
export const SPLAT_PRIMARY_SOCKETS: readonly string[] = ['color', 'opacity', 'cut', 'move', 'size'];

/** Every root type a spec binds — its parameters' and its constants'. */
export function scopeRootTypes(spec: ScopeSpec): Set<string> {
  const out = new Set<string>();
  for (const p of spec.params) for (const r of p.roots) out.add(r);
  for (const c of spec.constants ?? []) for (const r of c.roots) out.add(r);
  return out;
}

/** The Fn parameter a root type is bound to inside this scope, or null. */
export function paramOfRoot(spec: ScopeSpec, type: string): string | null {
  for (const p of spec.params) if (p.roots.has(type)) return p.name;
  return null;
}

/**
 * What a root node is bound to inside this scope — its parameter, else its
 * constant — or null when the type is not one of the scope's roots. The
 * emitter writes `const <var> = <expr>;` and adds `imports`.
 */
export function bindingOfRoot(spec: ScopeSpec, type: string): { expr: string; imports: readonly string[] } | null {
  const param = paramOfRoot(spec, type);
  if (param !== null) return { expr: param, imports: [] };
  for (const c of spec.constants ?? []) if (c.roots.has(type)) return { expr: c.expr, imports: c.imports };
  return null;
}

export function isMarchOutput(node: AppNode): boolean {
  return node.data.registryType === MARCH_OUTPUT_TYPE;
}

export function isSplatOutput(node: AppNode): boolean {
  return node.data.registryType === SPLAT_OUTPUT_TYPE;
}

/**
 * A sink that emits its OWN program instead of the plain Output's material
 * channels — the Raymarch Output or the Splat Output. While one is the active
 * sink every plain Output is silenced.
 */
export function isCustomSink(node: AppNode): boolean {
  return isMarchOutput(node) || isSplatOutput(node);
}

/** The node-data key that marks the ACTIVE sink. Absent everywhere on a
 *  document that never had a choice made — see `activeSink`. */
export const ACTIVE_OUTPUT_KEY = 'activeOutput';

/** An output-type node of ANY kind: the plain Output, a Raymarch Output or a
 *  Splat Output. */
export function isSinkNode(node: AppNode): boolean {
  return node.data.registryType === 'output' || isCustomSink(node);
}

/** The active flag, read strictly: only the literal `true` counts. Node data
 *  arrives from `.fastshader` files and the autosave, so `'yes'`, `1` and an
 *  object must all read as unflagged. */
export function hasActiveFlag(node: AppNode): boolean {
  return (node.data as Record<string, unknown>)[ACTIVE_OUTPUT_KEY] === true;
}

/**
 * Is this a plain Output whose OWN binding is empty — the DEFAULT material,
 * the one that owns the module's top-level channels?
 *
 * "Empty" is exactly what `materialTargetNames(outputMaterials(node)[0])`
 * reports, restated over the raw fields so this can live in a leaf: no usable
 * name in `meshTargets`, and, when there is no list, none in the older single
 * `meshTarget: { name }` either. A name `isUsableMeshName` refuses is NOT a
 * binding (emission would drop it too), so a node bound only to junk is the
 * default. utils/activeOutput.test.ts pins the restatement against a junk
 * sweep ("read one rule").
 *
 * A node-level `gltfMaterialIndex` is a binding too (an import-built Output:
 * written by the unfold, kept by the sanitizer, read by `outputMaterials`).
 */
export function isUntargetedOutput(node: AppNode): boolean {
  if (node.data.registryType !== 'output') return false;
  const d = node.data as { meshTargets?: unknown; meshTarget?: { name?: unknown }; gltfMaterialIndex?: unknown };
  if (isGltfMaterialIndex(d.gltfMaterialIndex)) return false;
  if (Array.isArray(d.meshTargets)) return !d.meshTargets.some((n) => isUsableMeshName(n));
  return !isUsableMeshName(d.meshTarget?.name);
}

/**
 * The first custom sink, in array order, with a PRIMARY socket wired — a
 * Raymarch Output's Field or Density, any of a Splat Output's Color, Opacity,
 * Cut, Move or Size. It was the rule every surface followed before a sink
 * could be chosen by hand, and is kept as the FALLBACK for a document that
 * carries no active flag (no document before the Splat Output could hold one,
 * so for every older graph this is exactly the old first-wired-march rule).
 * Pass UNWRAPPED edges (unwrapCollapsedGroupEdges): a feeder inside a
 * collapsed group must still count as wired.
 */
function firstWiredCustomSink(nodes: readonly AppNode[], edges: readonly AppEdge[]): AppNode | null {
  for (const n of nodes) {
    if (!isCustomSink(n)) continue;
    const primary = isMarchOutput(n) ? MARCH_PRIMARY_SOCKETS : SPLAT_PRIMARY_SOCKETS;
    if (edges.some((e) => e.target === n.id && primary.includes(e.targetHandle ?? ''))) return n;
  }
  return null;
}

/**
 * THE ACTIVE SINK — the one node that drives the shader: emission, the
 * preview's wire and window, the cost total, the Uniforms overlay, the export
 * and the A-Frame page all follow it, so it is resolved in exactly one place.
 *
 * Election order: the node carrying `activeOutput: true` (written by
 * `setActiveOutput`), else the first WIRED custom sink, else the LOWEST-RANKED
 * untargeted plain Output. An ABSENT flag means "never chose", which keeps
 * every older graph byte-identical.
 *
 * ONLY AN UNTARGETED plain Output may be elected: a targeted one is a `parts`
 * entry, and electing it would also hand it the module's top-level channels.
 *
 * NULL IS A REAL ANSWER: a document whose every plain Output is TARGETED has
 * no default material and emits `parts` alone. Consumers asking what the
 * shader renders read `contributingOutputs` / `costSeeds`.
 * See docs/dev/outputs-and-materials.md (several output nodes).
 */
export function activeSink(nodes: readonly AppNode[], edges: readonly AppEdge[]): AppNode | null {
  for (const n of nodes) {
    if (!isSinkNode(n) || !hasActiveFlag(n)) continue;
    if (!isCustomSink(n) && !isUntargetedOutput(n)) continue;
    return n;
  }
  return firstWiredCustomSink(nodes, edges)
    ?? lowestRankedUntargeted(nodes)
    ?? null;
}

/**
 * The LOWEST-RANKED untargeted plain Output — `defaultOutput`'s unflagged half
 * over the same `emitRank`, so the two can never name different nodes. Emit
 * order, never array order (see `outputsInEmitOrder`, utils/outputMaterials.ts);
 * ties keep array order, so an unsplit document elects the node it always did.
 */
function lowestRankedUntargeted(nodes: readonly AppNode[]): AppNode | null {
  let best: AppNode | null = null;
  for (const n of nodes) {
    if (!isUntargetedOutput(n)) continue;
    if (!best || emitRank(n) < emitRank(best)) best = n;
  }
  return best;
}

/**
 * Exactly one sink may carry the flag. Adversarial input (a hand-edited or
 * hostile `.fastshader`, a stale copy inside a saved group) can carry several
 * or a junk value; the FIRST ELIGIBLE literal `true` in array order wins,
 * every other output node loses the key, and a non-`true` value is stripped.
 * Returns the SAME array when nothing needed changing — the autosave
 * subscriber and `selectionOnlyGraphChange` compare by reference. Runs on
 * every restore path beside `sanitizeOutputMaterials`, on the resync's final
 * list, and after a paste (which strips the flag outright, see NodeEditor).
 *
 * ELIGIBLE is `activeSink`'s own rule: a custom sink (Raymarch or Splat
 * Output), or a plain Output whose own binding is empty. A flag on a TARGETED
 * plain Output is stripped
 * like any other stray — it cannot be honoured (see `activeSink`), and
 * leaving it in data would mean the choice was obeyed in-session and silently
 * reverted by the next restore.
 */
export function normalizeActiveOutput(nodes: AppNode[]): AppNode[] {
  let seen = false;
  let changed = false;
  const out = nodes.map((n) => {
    if (!isSinkNode(n)) return n;
    const data = n.data as Record<string, unknown>;
    if (!(ACTIVE_OUTPUT_KEY in data)) return n;
    const eligible = isCustomSink(n) || isUntargetedOutput(n);
    const keep = data[ACTIVE_OUTPUT_KEY] === true && !seen && eligible;
    if (keep) { seen = true; return n; }
    changed = true;
    const next = { ...data };
    delete next[ACTIVE_OUTPUT_KEY];
    return { ...n, data: next } as AppNode;
  });
  return changed ? out : nodes;
}

/** Strip the flag from every node — a fragment (a saved group, a paste) must
 *  not carry a choice that belongs to a whole graph. Same-array-when-clean. */
export function clearActiveOutput(nodes: AppNode[]): AppNode[] {
  let changed = false;
  const out = nodes.map((n) => {
    if (!isSinkNode(n) || !(ACTIVE_OUTPUT_KEY in (n.data as Record<string, unknown>))) return n;
    changed = true;
    const next = { ...(n.data as Record<string, unknown>) };
    delete next[ACTIVE_OUTPUT_KEY];
    return { ...n, data: next } as AppNode;
  });
  return changed ? out : nodes;
}

/**
 * The Raymarch Output that DRIVES the shader: the ACTIVE sink when it is a
 * Raymarch Output, else null. Wiredness no longer decides on its own — a
 * flagged Raymarch Output drives even with nothing wired (it then emits the
 * "nothing wired" sentinel, exactly as an empty plain Output does), and a
 * flagged plain Output silences every march. Every surface that asks "what
 * feeds the preview" (PreviewLink's wire, the preview's window override, the
 * double-sided material, the A-Frame tab's primitive) must ask THIS, never
 * "is there a Raymarch Output node". Pass UNWRAPPED edges.
 */
export function drivingMarchOutput(nodes: readonly AppNode[], edges: readonly AppEdge[]): AppNode | null {
  const s = activeSink(nodes, edges);
  return s && isMarchOutput(s) ? s : null;
}

/**
 * The Splat Output that DRIVES the shader: the ACTIVE sink when it is a Splat
 * Output, else null — `drivingMarchOutput`'s twin, with the same rules (a
 * flagged one drives with nothing wired and then emits the identity program
 * `return { splat: {} };`). Pass UNWRAPPED edges.
 */
export function drivingSplatOutput(nodes: readonly AppNode[], edges: readonly AppEdge[]): AppNode | null {
  const s = activeSink(nodes, edges);
  return s && isSplatOutput(s) ? s : null;
}

/**
 * The custom sink — Raymarch or Splat Output — that DRIVES the shader, else
 * null. Every surface that asks "is the module a plain material, or a program
 * of its own" (the Output suppression in emission, the cost seeds, the
 * Uniforms scope, the preview's wire) asks THIS. Pass UNWRAPPED edges.
 */
export function drivingCustomSink(nodes: readonly AppNode[], edges: readonly AppEdge[]): AppNode | null {
  const s = activeSink(nodes, edges);
  return s && isCustomSink(s) ? s : null;
}

/** The driving node's Window radius (the preview sphere), or null when nothing drives. */
export function marchWindowRadius(nodes: readonly AppNode[], edges: readonly AppEdge[]): number | null {
  const n = drivingMarchOutput(nodes, edges);
  if (!n) return null;
  const v = Number((n.data as { values?: Record<string, unknown> }).values?.window);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export interface MarchPartition {
  /** Per-step sets keyed by socket handle (roots included). */
  scopes: ReadonlyMap<string, ReadonlySet<string>>;
  /** Nodes that must ALSO be emitted in the flat body: roots, set members
   *  with a consumer outside every set — another node, or a sink socket no
   *  scope declaring them reads (a dangling branch would otherwise reference
   *  a name that only exists inside a Fn) — and every set member one of
   *  THOSE reads, transitively (a flat line names its inputs). */
  mainAlso: ReadonlySet<string>;
}

/** Incoming-edge adjacency (target → sources), for a reverse walk. */
export function buildIncoming(edges: readonly AppEdge[]): Map<string, string[]> {
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    const list = incoming.get(e.target);
    if (list) list.push(e.source);
    else incoming.set(e.target, [e.source]);
  }
  return incoming;
}

/** Every id reachable from `seed` through `next`, the seeds included. */
export function closure(seed: Iterable<string>, next: (id: string) => readonly string[]): Set<string> {
  const out = new Set<string>();
  const queue = [...seed];
  while (queue.length) {
    const id = queue.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const n of next(id)) if (!out.has(n)) queue.push(n);
  }
  return out;
}

/**
 * Partition the graph for the custom sink `sinkId`: per spec, the nodes that
 * depend on one of its roots AND feed one of its sockets. Named for the march
 * it was written for; the Splat Output runs the same function over
 * `SPLAT_SCOPES`, whose `implicitRoots` also count a node that reads a root
 * through an UNWIRED input (`implicitRootOf`) as depending on it. Such a node
 * is an ordinary member, not a root: it is kept in the flat body only when
 * something outside every scope consumes it, directly or through a flat copy
 * of a member it feeds.
 */
export function marchPartition(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  sinkId: string,
  specs: readonly ScopeSpec[] = MARCH_SCOPES,
): MarchPartition {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  /** source → the sink sockets it feeds directly. */
  const intoSink = new Map<string, string[]>();
  for (const e of edges) {
    (outgoing.get(e.source) ?? outgoing.set(e.source, []).get(e.source)!).push(e.target);
    (incoming.get(e.target) ?? incoming.set(e.target, []).get(e.target)!).push(e.source);
    if (e.target === sinkId) (intoSink.get(e.source) ?? intoSink.set(e.source, []).get(e.source)!).push(e.targetHandle ?? '');
  }
  const typeOf = new Map(nodes.map((n) => [n.id, n.data.registryType]));
  // The implicit reads (`implicitRootOf`), asked only when a spec wants them —
  // never for the march, whose partition this leaves exactly as it was. An
  // input counts as wired when a wire from a node that EXISTS reaches it (a
  // dangling edge out of a hand-edited file resolves to nothing in emission
  // either, and the node then emits its default).
  const implicitRoot = new Map<string, string>();
  if (specs.some((s) => s.implicitRoots)) {
    const wiredHandles = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!typeOf.has(e.source)) continue;
      (wiredHandles.get(e.target) ?? wiredHandles.set(e.target, new Set()).get(e.target)!).add(e.targetHandle ?? '');
    }
    for (const n of nodes) {
      const handles = wiredHandles.get(n.id);
      const root = implicitRootOf(n, (h) => handles?.has(h) ?? false);
      if (root !== null) implicitRoot.set(n.id, root);
    }
  }
  const scopes = new Map<string, Set<string>>();
  for (const spec of specs) {
    const rootTypes = scopeRootTypes(spec);
    const roots = nodes
      .filter((n) => rootTypes.has(n.data.registryType) || (spec.implicitRoots === true && rootTypes.has(implicitRoot.get(n.id) ?? '')))
      .map((n) => n.id);
    const dep = closure(roots, (id) => outgoing.get(id) ?? []);
    dep.delete(sinkId);
    const feeders = edges.filter((e) => e.target === sinkId && spec.sockets.includes(e.targetHandle ?? '')).map((e) => e.source);
    const anc = closure(feeders, (id) => incoming.get(id) ?? []);
    scopes.set(spec.handle, new Set([...anc].filter((id) => dep.has(id))));
  }
  /** Is a direct wire from `id` into the sink's `socket` read INSIDE a scope that declares `id`? */
  const readInScope = (id: string, socket: string): boolean =>
    specs.some((sp) => sp.sockets.includes(socket) && scopes.get(sp.handle)!.has(id));
  // One union of every scope's members, built once. `inAny` is asked per
  // OUTGOING EDGE of every scope member in the nested loop below, and spreading
  // `scopes.values()` inside it allocated a fresh array on each of those
  // visits — pure churn on the per-edit codegen path of exactly the graphs
  // (raymarched fields) that are already the most expensive thing to compile.
  const inAnySet = new Set<string>();
  for (const s of scopes.values()) for (const id of s) inAnySet.add(id);
  const inAny = (id: string): boolean => inAnySet.has(id);
  const allRoots = new Set(specs.flatMap((s) => [...scopeRootTypes(s)]));
  const mainAlso = new Set<string>();
  for (const set of scopes.values()) {
    for (const id of set) {
      if (allRoots.has(typeOf.get(id) ?? '')) { mainAlso.add(id); continue; }
      if (mainAlso.has(id)) continue;
      let flat = false;
      for (const t of outgoing.get(id) ?? []) {
        if (t !== sinkId && !inAny(t)) { flat = true; break; }
      }
      // A wire into a sink socket that NO scope declaring this node reads — a
      // march's numbers, or a Background whose scope is over a different
      // root — is read in the flat body (or the IIFE), where a name declared
      // only inside a Fn does not exist.
      if (!flat) flat = (intoSink.get(id) ?? []).some((socket) => !readInScope(id, socket));
      if (flat) mainAlso.add(id);
    }
  }
  // A flat copy brings its in-scope ANCESTORS with it. Its line reads its
  // inputs by name, and an input that is a scope member but not itself flat is
  // declared only inside a Fn — a ReferenceError the moment the module runs,
  // which fails the whole shader. Roots are always flat, so this bites a
  // member one level above an implicit-root noise (`remap(noise1, …)`) or two
  // above a real root (`mul(length1, 1)`). The copies are valid where they
  // land: an implicit read keeps today's text outside a splat Fn, and the
  // plan still walks `sorted`, so the emission order is unchanged. An input in
  // no scope is flat already, and its own in-scope inputs were added above.
  const pending = [...mainAlso];
  while (pending.length) {
    const id = pending.pop()!;
    for (const src of incoming.get(id) ?? []) {
      if (inAnySet.has(src) && !mainAlso.has(src)) {
        mainAlso.add(src);
        pending.push(src);
      }
    }
  }
  return { scopes, mainAlso };
}

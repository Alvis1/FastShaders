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
 */
import type { AppNode, AppEdge } from '@/types';

export const MARCH_OUTPUT_TYPE = 'raymarchOutput';

/** Registry types the POSITION parameter substitutes for. Object space only. */
export const MARCH_ROOT_TYPES: ReadonlySet<string> = new Set(['positionLocal', 'positionGeometry']);
/** Registry types the DIRECTION parameter substitutes for (world space). */
export const DIR_ROOT_TYPES: ReadonlySet<string> = new Set(['rayDirection']);

/** What each per-step socket is a function OF. */
export interface MarchScopeSpec {
  handle: string;
  /** The Fn parameter name and the roots it stands in for. */
  param: 'p' | 'dir';
  roots: ReadonlySet<string>;
}

/** The per-step sockets, in emission order. */
export const MARCH_SCOPES: readonly MarchScopeSpec[] = [
  { handle: 'field', param: 'p', roots: MARCH_ROOT_TYPES },
  { handle: 'density', param: 'p', roots: MARCH_ROOT_TYPES },
  { handle: 'color', param: 'p', roots: MARCH_ROOT_TYPES },
  { handle: 'emissive', param: 'p', roots: MARCH_ROOT_TYPES },
  { handle: 'glow', param: 'p', roots: MARCH_ROOT_TYPES },
  { handle: 'background', param: 'dir', roots: DIR_ROOT_TYPES },
];

/** The node DRIVES the shader when either march socket is wired. */
export const MARCH_PRIMARY_SOCKETS: readonly string[] = ['field', 'density'];

export function isMarchOutput(node: AppNode): boolean {
  return node.data.registryType === MARCH_OUTPUT_TYPE;
}

export function marchOutputNodes(nodes: readonly AppNode[]): AppNode[] {
  return nodes.filter(isMarchOutput);
}

/** The node-data key that marks the ACTIVE sink. Absent everywhere on a
 *  document that never had a choice made — see `activeSink`. */
export const ACTIVE_OUTPUT_KEY = 'activeOutput';

/** An output-type node of EITHER kind: the plain Output or a Raymarch Output. */
export function isSinkNode(node: AppNode): boolean {
  return node.data.registryType === 'output' || isMarchOutput(node);
}

/** The active flag, read strictly: only the literal `true` counts. Node data
 *  arrives from `.fastshader` files and the autosave, so `'yes'`, `1` and an
 *  object must all read as unflagged. */
export function hasActiveFlag(node: AppNode): boolean {
  return (node.data as Record<string, unknown>)[ACTIVE_OUTPUT_KEY] === true;
}

/**
 * The first Raymarch Output whose Field or Density is WIRED — the rule every
 * surface followed before a sink could be chosen by hand, kept as the
 * FALLBACK for a document that carries no active flag. Pass UNWRAPPED edges
 * (unwrapCollapsedGroupEdges): a feeder inside a collapsed group must still
 * count as wired.
 */
function firstWiredMarchOutput(nodes: readonly AppNode[], edges: readonly AppEdge[]): AppNode | null {
  for (const n of nodes) {
    if (!isMarchOutput(n)) continue;
    if (edges.some((e) => e.target === n.id && MARCH_PRIMARY_SOCKETS.includes(e.targetHandle ?? ''))) return n;
  }
  return null;
}

/**
 * THE ACTIVE SINK — the one node that drives the shader: emission, the
 * preview's wire and window, the cost total, the Uniforms overlay, the export
 * and the A-Frame page all follow it, so it is resolved in exactly one place.
 *
 * Several output nodes (any mix of Output and Raymarch Output) may coexist;
 * the user picks one by clicking its preview socket, which writes
 * `data.activeOutput = true` on that node and clears it on every other sink
 * (`setActiveOutput`). A document that has never had a choice made carries NO
 * flag, and then the historical rule decides: the first WIRED Raymarch Output,
 * else the first plain Output in array order. That absent-key default is what
 * keeps every saved graph, every built-in and every exported `.js` emitting
 * byte-identically — the `materials` / noise-`signed` precedent.
 *
 * Deleting the active node simply removes its flag with it, so the fallback
 * takes over; no re-election is needed on any deletion path.
 */
export function activeSink(nodes: readonly AppNode[], edges: readonly AppEdge[]): AppNode | null {
  for (const n of nodes) if (isSinkNode(n) && hasActiveFlag(n)) return n;
  return firstWiredMarchOutput(nodes, edges) ?? nodes.find((n) => n.data.registryType === 'output') ?? null;
}

/**
 * Exactly one sink may carry the flag. Adversarial input (a hand-edited or
 * hostile `.fastshader`, a stale copy inside a saved group) can carry several
 * or a junk value; the FIRST literal `true` in array order wins, every other
 * output node loses the key, and a non-`true` value is stripped. Returns the
 * SAME array when nothing needed changing — the autosave subscriber and
 * `selectionOnlyGraphChange` compare by reference. Runs on every restore path
 * beside `sanitizeOutputMaterials`, on the resync's final list, and after a
 * paste (which strips the flag outright, see NodeEditor).
 */
export function normalizeActiveOutput(nodes: AppNode[]): AppNode[] {
  let seen = false;
  let changed = false;
  const out = nodes.map((n) => {
    if (!isSinkNode(n)) return n;
    const data = n.data as Record<string, unknown>;
    if (!(ACTIVE_OUTPUT_KEY in data)) return n;
    const keep = data[ACTIVE_OUTPUT_KEY] === true && !seen;
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

export function marchOutputDrives(nodes: readonly AppNode[], edges: readonly AppEdge[]): boolean {
  return drivingMarchOutput(nodes, edges) !== null;
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
  /** Nodes that must ALSO be emitted in the flat body: roots, and set members
   *  with a consumer outside every set (a dangling branch would otherwise
   *  reference a name that only exists inside a Fn). */
  mainAlso: ReadonlySet<string>;
}

function closure(seed: Iterable<string>, next: (id: string) => readonly string[]): Set<string> {
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

export function marchPartition(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  sinkId: string,
  specs: readonly MarchScopeSpec[] = MARCH_SCOPES,
): MarchPartition {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    (outgoing.get(e.source) ?? outgoing.set(e.source, []).get(e.source)!).push(e.target);
    (incoming.get(e.target) ?? incoming.set(e.target, []).get(e.target)!).push(e.source);
  }
  const typeOf = new Map(nodes.map((n) => [n.id, n.data.registryType]));
  const scopes = new Map<string, Set<string>>();
  for (const spec of specs) {
    const roots = nodes.filter((n) => spec.roots.has(n.data.registryType)).map((n) => n.id);
    const dep = closure(roots, (id) => outgoing.get(id) ?? []);
    dep.delete(sinkId);
    const feeders = edges.filter((e) => e.target === sinkId && e.targetHandle === spec.handle).map((e) => e.source);
    const anc = closure(feeders, (id) => incoming.get(id) ?? []);
    scopes.set(spec.handle, new Set([...anc].filter((id) => dep.has(id))));
  }
  const inAny = (id: string): boolean => [...scopes.values()].some((s) => s.has(id));
  const allRoots = new Set([...specs.flatMap((s) => [...s.roots])]);
  const mainAlso = new Set<string>();
  for (const set of scopes.values()) {
    for (const id of set) {
      if (allRoots.has(typeOf.get(id) ?? '')) { mainAlso.add(id); continue; }
      for (const t of outgoing.get(id) ?? []) {
        if (t !== sinkId && !inAny(t)) { mainAlso.add(id); break; }
      }
    }
  }
  return { scopes, mainAlso };
}

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
// Both LEAVES. This module is itself a leaf that `nodeCost` — and through it
// the store — imports, so it must never reach into the store-coupled utils
// graph (utils/outputMaterials.ts -> exposedPorts -> edgeUtils -> useAppStore):
// that is the costTable TDZ rule, and `isUntargetedOutput` below is exactly
// the kind of shared predicate that invites the wrong import direction.
import { emitRank, isGltfMaterialIndex } from '@/engine/materialPartsContract';
import { isUsableMeshName } from './meshInventory';

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
 * Is this a plain Output whose OWN binding is empty — the DEFAULT material,
 * the one that owns the module's top-level channels?
 *
 * "Empty" is exactly what `materialTargetNames(outputMaterials(node)[0])`
 * reports for material 0, restated over the raw fields so this can live in a
 * leaf: no usable name in `meshTargets` (the list), and, when there is no
 * list, none in the older single `meshTarget: { name }` either. A name out of
 * a `.fastshader` that `isUsableMeshName` refuses is NOT a binding — emission
 * would drop it too, so a node bound only to junk really is the default, and
 * counting it as targeted would make the module's default holder differ from
 * the one graphToCode resolves (`material0Target`). utils/activeOutput.test.ts
 * pins the two against a junk sweep ("read one rule"), which is the only thing
 * stopping the restatement drifting.
 *
 * A node-level `gltfMaterialIndex` is a binding too. Today no such key
 * survives a restore path (`sanitizeOutputMaterials` deletes it — material 0
 * is never an index section) and `outputMaterials` never reads one, so the
 * clause is inert; it is here because the per-material Output split writes
 * that key at node level, and because `activeSink` also runs on live
 * in-session data that no sanitizer has seen.
 */
export function isUntargetedOutput(node: AppNode): boolean {
  if (node.data.registryType !== 'output') return false;
  const d = node.data as { meshTargets?: unknown; meshTarget?: { name?: unknown }; gltfMaterialIndex?: unknown };
  if (isGltfMaterialIndex(d.gltfMaterialIndex)) return false;
  if (Array.isArray(d.meshTargets)) return !d.meshTargets.some((n) => isUsableMeshName(n));
  return !isUsableMeshName(d.meshTarget?.name);
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
 * else the LOWEST-RANKED untargeted plain Output (`lowestRankedUntargeted`).
 * That absent-key default is what keeps every saved graph, every built-in and
 * every exported `.js` emitting byte-identically — the `materials` /
 * noise-`signed` precedent: a document that has never been split carries no
 * `emitOrder` at all, every rank is 0, and the tie keeps array order.
 *
 * Deleting the active node simply removes its flag with it, so the fallback
 * takes over; no re-election is needed on any deletion path.
 *
 * ONLY AN UNTARGETED plain Output may be elected. A targeted one is a `parts`
 * entry — it shades the meshes it names and nothing else — so electing it
 * would hand it the module's top-level channels as well: the same material
 * painted twice, the module-level copy repainting every mesh no other material
 * claims, while it also became the cost seed, the Uniforms scope, the preview
 * window's owner and Preview mode's target. The retired
 * `nodes.find(registryType === 'output')` fallback picked by ARRAY ORDER, and
 * could therefore land on exactly such a node.
 *
 * MEASURED, so the danger is stated accurately rather than dramatically:
 * `gltfSectionBuilder` pushes the untargeted default (`gi_output`, rank 0)
 * BEFORE any index node, so on all five fixture shapes the first Output of an
 * import-built document is the DEFAULT and array order happens to answer
 * correctly at build time. What makes the array unusable anyway is that it does
 * not STAY that way: `liftChildrenAfterParents` splices a node into a new slot
 * on an ordinary drag-into-a-group and `useSyncEngine` reorders on every Apply,
 * either of which can put a targeted node in front with nothing on screen to
 * show it. The eligibility test is what closes the class, whatever the order;
 * `normalizeActiveOutput` strips the flag from an ineligible node, so the two
 * rules cannot disagree about who may be elected.
 *
 * NULL IS A REAL ANSWER. A document whose every plain Output is TARGETED has
 * no default material at all: the module emits `parts` alone and loader 0.6/0.8
 * leaves every unclaimed mesh on its authored one. Until the Output split there
 * was a LAST-RESORT `nodes.find(registryType === 'output')` term here, so that
 * document still got a sink — because one node then held every material, and
 * every consumer asking "what does this shader render" asked THIS function.
 * Both halves of that are gone: the consumers ask `contributingOutputs` /
 * `costSeeds` for the Output SET, and array order — which is what the term
 * picked by — is not a usable order, since `liftChildrenAfterParents` splices a
 * node into a new slot on an ordinary drag-into-a-group. With several targeted
 * Outputs it would have elected an arbitrary one as the cost seed, the Uniforms
 * scope and the resync's pairing partner, and a layout gesture could move it.
 */
export function activeSink(nodes: readonly AppNode[], edges: readonly AppEdge[]): AppNode | null {
  for (const n of nodes) {
    if (!isSinkNode(n) || !hasActiveFlag(n)) continue;
    if (!isMarchOutput(n) && !isUntargetedOutput(n)) continue;
    return n;
  }
  return firstWiredMarchOutput(nodes, edges)
    ?? lowestRankedUntargeted(nodes)
    ?? null;
}

/**
 * The LOWEST-RANKED untargeted plain Output — `defaultOutput`'s unflagged half,
 * restated here over the ONE `emitRank` accessor (utils/outputMaterials.ts
 * re-exports it from the same leaf, so there is no second copy to drift).
 *
 * It was `nodes.find(isUntargetedOutput)`, i.e. ARRAY order, while
 * `defaultOutput` had already moved to emit order — so on a split document
 * whose EMPTY section sits ahead of the real default in the array the two named
 * different nodes: `graphToCode` gave the module's top-level channels to one
 * while the preview socket, the preview window's owner and Preview mode's
 * target followed the other. `liftChildrenAfterParents` puts a node in that slot
 * on an ordinary drag-into-a-group, so it is reachable without touching a
 * single Output.
 *
 * Ties keep ARRAY order (strict `<`), exactly as `defaultOutput` does, so a
 * document that has never been split — every rank the absent-key 0 — elects the
 * node it always did.
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
 * ELIGIBLE is `activeSink`'s own rule: a Raymarch Output, or a plain Output
 * whose own binding is empty. A flag on a TARGETED plain Output is stripped
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
    const eligible = isMarchOutput(n) || isUntargetedOutput(n);
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
  // One union of every scope's members, built once. `inAny` is asked per
  // OUTGOING EDGE of every scope member in the nested loop below, and spreading
  // `scopes.values()` inside it allocated a fresh array on each of those
  // visits — pure churn on the per-edit codegen path of exactly the graphs
  // (raymarched fields) that are already the most expensive thing to compile.
  const inAnySet = new Set<string>();
  for (const s of scopes.values()) for (const id of s) inAnySet.add(id);
  const inAny = (id: string): boolean => inAnySet.has(id);
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

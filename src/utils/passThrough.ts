/**
 * PASS-THROUGH nodes — the Branch and the two Portal ends (owner, 2026-11-23).
 * Three React Flow flow types with no registry entry, passive like `note` and
 * `group`:
 *
 *  - `knot` (on screen "Branch"): one wire in, any number out;
 *  - `tunnelIn` ("Portal In"): one wire in, no output socket;
 *  - `tunnelOut` ("Portal Out"): no input socket, any number out, linked to
 *    its Portal In by `data.link` — the entrance's NODE ID, never its name.
 *
 * They compute nothing. The engines read straight THROUGH them: the FOLD
 * (`foldPassThroughEdges`, applied by `unwrapCollapsedGroupEdges` right after
 * the collapsed-group unwrap) drops every wire INTO a pass-through and gives a
 * wire OUT of one the source AND source handle its chain resolves to, keeping
 * the wire's own id. What cannot be resolved (nothing fed in, a missing or
 * invalid link, a cycle) is DROPPED: the consumer reads its own unwired value,
 * exactly as with no wire. So a graph with pass-throughs emits byte-identical
 * TSL to the same graph wired directly.
 *
 * The few sites that must see the wires AS DRAWN read the group-only view
 * (`unwrapGroupsOnly` in edgeUtils.ts) instead, or `topologyEdges` (that view
 * plus a virtual `tunnelIn → tunnelOut` edge per live link) for the cycle and
 * occupancy checks; Preview mode and the Image hand-offs resolve an endpoint
 * with `passThroughSource`. docs/dev/graph-and-store.md lists every site.
 *
 * Every field is adversarial (a `.fastshader`, a tampered `fs:graph`): `link`
 * is validated at READ time (it must name a live `tunnelIn`, else the exit is
 * DANGLING), `label` is read with `plainStr`. Pure: no store, no React — the
 * leaves `valueCoerce` and `graphShape` only.
 */
import type { AppEdge, AppNode } from '@/types';
import { plainStr } from '@/utils/valueCoerce';
import { isSelectorSafeId } from '@/utils/graphShape';

/** The Branch's flow type. A PERMANENT key: stored in every `.fastshader`. */
export const KNOT_TYPE = 'knot';
/** The Portal In's flow type (permanent). */
export const TUNNEL_IN_TYPE = 'tunnelIn';
/** The Portal Out's flow type (permanent). */
export const TUNNEL_OUT_TYPE = 'tunnelOut';

/** Anything with a flow type: an AppNode, or a node from a file. */
type Typed = { type?: unknown };

export function isKnot(n: Typed | null | undefined): boolean {
  return !!n && n.type === KNOT_TYPE;
}
export function isTunnelIn(n: Typed | null | undefined): boolean {
  return !!n && n.type === TUNNEL_IN_TYPE;
}
export function isTunnelOut(n: Typed | null | undefined): boolean {
  return !!n && n.type === TUNNEL_OUT_TYPE;
}
/** A Branch or either Portal end: a node that computes nothing and passes its input on. */
export function isPassThroughNode(n: Typed | null | undefined): boolean {
  return isKnot(n) || isTunnelIn(n) || isTunnelOut(n);
}

// ---------------------------------------------------------------------------
// Validated readers (READ time: an entrance can be deleted after load)
// ---------------------------------------------------------------------------

const dataOf = (n: { data?: unknown }): Record<string, unknown> | null => {
  const d = n.data;
  return typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : null;
};

/**
 * A Portal Out's stored `link`, or null: only a non-empty, selector-safe
 * STRING is a link at all. Whether it names a live entrance is
 * `tunnelEntrance`'s question.
 */
export function tunnelLinkOf(n: { type?: unknown; data?: unknown }): string | null {
  if (!isTunnelOut(n)) return null;
  const link = dataOf(n)?.link;
  return typeof link === 'string' && link !== '' && isSelectorSafeId(link) ? link : null;
}

/** A Portal end's stored `label` as text ('' for anything not a string or number). */
export function tunnelLabelOf(n: { data?: unknown }): string {
  return plainStr(dataOf(n)?.label);
}

/**
 * The live Portal In a Portal Out is linked to, or null when it DANGLES: the
 * link is missing or malformed, or names no node, a node that is not a
 * `tunnelIn` (another exit, a shader node, itself) — every one of those reads
 * as unwired.
 */
export function tunnelEntrance<N extends AppNode>(nodes: readonly N[], exit: N): N | null {
  const link = tunnelLinkOf(exit);
  if (link === null) return null;
  for (const n of nodes) if (n.id === link) return isTunnelIn(n) ? n : null;
  return null;
}

/** Every Portal Out linked to the entrance `entranceId`, in array order. */
export function tunnelExits<N extends AppNode>(nodes: readonly N[], entranceId: string): N[] {
  return nodes.filter((n) => tunnelLinkOf(n) === entranceId);
}

// ---------------------------------------------------------------------------
// The resolver and the fold
// ---------------------------------------------------------------------------

/** Where a pass-through's value comes from: a real (non-pass-through) socket. */
export interface PassThroughSource {
  source: string;
  sourceHandle: string | null | undefined;
}

type Resolver = (id: string) => PassThroughSource | null;

/**
 * A memoized resolver over `pass` (the pass-through nodes by id) and the
 * group-only `edges`. A Branch and a Portal In read their FIRST incoming wire
 * in array order (a socket reads its first wire, as codegen does); a Portal
 * Out reads its live entrance. A chain is followed through further
 * pass-throughs and bounded by `seen`: a cycle passes nothing. In a chain each
 * node has ONE upstream, so a node whose chain meets the stack is ON the cycle
 * and its null is its true answer — memoizing it is sound.
 */
function makeResolver(pass: ReadonlyMap<string, AppNode>, edges: readonly AppEdge[]): Resolver {
  const firstIn = new Map<string, AppEdge>();
  for (const e of edges) {
    if (pass.has(e.target) && !firstIn.has(e.target)) firstIn.set(e.target, e);
  }
  const memo = new Map<string, PassThroughSource | null>();
  const resolve = (id: string, seen: Set<string>): PassThroughSource | null => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const node = pass.get(id);
    if (!node || seen.has(id)) return null;
    seen.add(id);
    let res: PassThroughSource | null = null;
    if (isTunnelOut(node)) {
      const link = tunnelLinkOf(node);
      const entrance = link === null ? undefined : pass.get(link);
      if (entrance && isTunnelIn(entrance)) res = resolve(entrance.id, seen);
    } else {
      const w = firstIn.get(id);
      if (w) {
        res = pass.has(w.source)
          ? resolveSourceOf(w.source, seen)
          : { source: w.source, sourceHandle: w.sourceHandle };
      }
    }
    memo.set(id, res);
    return res;
  };
  // A wire's SOURCE pass-through: a Portal In has no output socket, so a wire
  // out of one (only a forged file holds it) can never be drawn and must not
  // change the shader — it passes nothing.
  const resolveSourceOf = (id: string, seen: Set<string>): PassThroughSource | null =>
    isTunnelIn(pass.get(id)) ? null : resolve(id, seen);
  return (id) => resolve(id, new Set());
}

/** The pass-through nodes by id (first holder of an id), or null when there are none. */
function passThroughMap(nodes: readonly AppNode[]): Map<string, AppNode> | null {
  let pass: Map<string, AppNode> | null = null;
  const seenIds = new Set<string>();
  for (const n of nodes) {
    if (seenIds.has(n.id)) continue;
    seenIds.add(n.id);
    if (isPassThroughNode(n)) (pass ??= new Map()).set(n.id, n);
  }
  return pass;
}

/**
 * Where the pass-through `nodeId` takes its value from, through any chain of
 * pass-throughs: the real source socket, or null when nothing reaches it (an
 * unfed chain, a dangling exit, a cycle) or `nodeId` is no pass-through.
 * `groupEdges` is the GROUP-ONLY view (`unwrapGroupsOnly`), so an entrance
 * inside a collapsed group sees its real feeder.
 */
export function passThroughSource(
  nodes: readonly AppNode[],
  groupEdges: readonly AppEdge[],
  nodeId: string,
): PassThroughSource | null {
  const pass = passThroughMap(nodes);
  if (!pass || !pass.has(nodeId)) return null;
  return makeResolver(pass, groupEdges)(nodeId);
}

/**
 * Every pass-through's resolved source at once, through ONE resolver: node id
 * → the real source socket, or null where nothing reaches it. Empty when there
 * is no pass-through. For a reader that asks about all of them per graph
 * version (the canvas cards' type colour, nodes/passThroughLook.ts) rather
 * than building a resolver per node. `groupEdges` is the GROUP-ONLY view.
 */
export function passThroughSources(
  nodes: readonly AppNode[],
  groupEdges: readonly AppEdge[],
): Map<string, PassThroughSource | null> {
  const out = new Map<string, PassThroughSource | null>();
  const pass = passThroughMap(nodes);
  if (!pass) return out;
  const resolve = makeResolver(pass, groupEdges);
  for (const id of pass.keys()) out.set(id, resolve(id));
  return out;
}

/**
 * `{ source, sourceHandle }` as the SHADER reads it: the pass-through's
 * resolved source, or the endpoint itself when it is no pass-through. Null
 * only for a pass-through that resolves to nothing.
 */
export function resolvePassThroughEndpoint(
  nodes: readonly AppNode[],
  groupEdges: readonly AppEdge[],
  source: string,
  sourceHandle: string | null | undefined,
): PassThroughSource | null {
  const pass = passThroughMap(nodes);
  if (!pass || !pass.has(source)) return { source, sourceHandle };
  if (isTunnelIn(pass.get(source))) return null;
  return makeResolver(pass, groupEdges)(source);
}

/**
 * The wires that carry what the pass-through `nodeId` holds into REAL nodes —
 * the resolver run FORWARD, as drawn (`groupEdges`, the group-only view):
 * through every Branch it reaches by that Branch's FIRST incoming wire (the one
 * a Branch reads), and from a Portal In to each of its live exits. A wire out
 * of a Portal In (only a forged file holds one) carries nothing. Empty for a
 * real node or an id that is no node; a cycle ends the walk. The question a
 * connect-time check asks when the new wire's target is a pass-through: the
 * consumer sockets whose value that wire just changed.
 */
export function passThroughConsumers(
  nodes: readonly AppNode[],
  groupEdges: readonly AppEdge[],
  nodeId: string,
): AppEdge[] {
  const pass = passThroughMap(nodes);
  if (!pass || !pass.has(nodeId)) return [];
  const exits = new Map<string, string[]>();
  for (const n of pass.values()) {
    if (!isTunnelOut(n)) continue;
    const link = tunnelLinkOf(n);
    if (link === null || !isTunnelIn(pass.get(link))) continue;
    const list = exits.get(link);
    if (list) list.push(n.id);
    else exits.set(link, [n.id]);
  }
  const firstIn = new Map<string, AppEdge>();
  const bySource = new Map<string, AppEdge[]>();
  for (const e of groupEdges) {
    if (pass.has(e.target) && !firstIn.has(e.target)) firstIn.set(e.target, e);
    const list = bySource.get(e.source);
    if (list) list.push(e);
    else bySource.set(e.source, [e]);
  }
  const out: AppEdge[] = [];
  const seen = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (isTunnelIn(pass.get(id))) {
      stack.push(...(exits.get(id) ?? []));
      continue;
    }
    for (const e of bySource.get(id) ?? []) {
      if (!pass.has(e.target)) out.push(e);
      else if (firstIn.get(e.target) === e) stack.push(e.target);
    }
  }
  return out;
}

/**
 * The FOLD: the edges as the engines read them. Every wire INTO a
 * pass-through is dropped; a wire OUT of one takes the resolved source and
 * source handle (KEEPING its id, so a lookup by id — TypedEdge, EdgeInfoCard —
 * still finds it), or is dropped when nothing resolves. Returns `edges` ITSELF
 * when there is no pass-through or no wire touches one, so every older graph
 * is byte-identical and every memo keeps its identity. Idempotent.
 */
export function foldPassThroughEdges(nodes: readonly AppNode[], edges: AppEdge[]): AppEdge[] {
  const pass = passThroughMap(nodes);
  if (!pass) return edges;
  let touches = false;
  for (const e of edges) {
    if (pass.has(e.source) || pass.has(e.target)) {
      touches = true;
      break;
    }
  }
  if (!touches) return edges;
  const resolve = makeResolver(pass, edges);
  const out: AppEdge[] = [];
  for (const e of edges) {
    if (pass.has(e.target)) continue;
    if (!pass.has(e.source)) {
      out.push(e);
      continue;
    }
    if (isTunnelIn(pass.get(e.source))) continue;
    const via = resolve(e.source);
    if (via) out.push({ ...e, source: via.source, sourceHandle: via.sourceHandle });
  }
  return out;
}

/**
 * The wires as DRAWN plus one virtual `tunnelIn → tunnelOut` edge per LIVE
 * link — the graph the cycle check and the socket-occupancy test must walk:
 * folded, a Branch's input looks free (two wires into one socket), and a loop
 * through a Portal is invisible until the sort drops a node. The virtual
 * edges name no handle (no socket matches them) and an id no real edge can
 * hold. `groupEdges` itself when there is no live link.
 */
export function topologyEdges(nodes: readonly AppNode[], groupEdges: AppEdge[]): AppEdge[] {
  const pass = passThroughMap(nodes);
  if (!pass) return groupEdges;
  let virtual: AppEdge[] | null = null;
  for (const n of pass.values()) {
    if (!isTunnelOut(n)) continue;
    const link = tunnelLinkOf(n);
    if (link === null || !isTunnelIn(pass.get(link))) continue;
    (virtual ??= []).push({
      id: `\0tunnel\0${link}\0${n.id}`,
      source: link,
      sourceHandle: null,
      target: n.id,
      targetHandle: null,
    });
  }
  return virtual ? [...groupEdges, ...virtual] : groupEdges;
}

// ---------------------------------------------------------------------------
// Re-mint: the one data-borne node reference every clone path must remap
// ---------------------------------------------------------------------------

/**
 * How a clone treats a Portal Out's `link` that its id map does not remap:
 *  - `keep` (paste, duplicate): it still names the live entrance — an exit
 *    copied alone is another exit of the SAME portal;
 *  - `keep-if-live` (a saved group, `cloneGroupSnapshot`): kept only while it
 *    names a live `tunnelIn` in `live`, the graph it lands in;
 *  - `clear` (a dropped shader's ADD): dropped — a file usually carries the
 *    live graph's own ids, so a foreign link could bind to a live node.
 * A malformed link is dropped in every mode. A dropped link leaves the exit
 * DANGLING (the broken-exit look; its consumers read as unwired).
 */
export type TunnelLinkMode = 'keep' | 'keep-if-live' | 'clear';

/**
 * `nodes` with every Portal Out's `link` remapped through `idMap` (old id →
 * new id) or settled by `mode`. A changed node gets a fresh node and data
 * object; `nodes` ITSELF comes back when nothing changes.
 */
export function remapTunnelLinks<N extends AppNode>(
  nodes: N[],
  idMap: ReadonlyMap<string, string>,
  mode: TunnelLinkMode,
  live: readonly AppNode[] = [],
): N[] {
  let liveIn: Set<string> | null = null;
  let out: N[] | null = null;
  nodes.forEach((n, i) => {
    if (!isTunnelOut(n)) return;
    const data = dataOf(n);
    if (!data || !('link' in data)) return;
    const link = tunnelLinkOf(n);
    let next: string | null = null;
    if (link !== null) {
      const mapped = idMap.get(link);
      if (mapped !== undefined) next = mapped;
      else if (mode === 'keep') next = link;
      else if (mode === 'keep-if-live') {
        liveIn ??= new Set(live.filter(isTunnelIn).map((m) => m.id));
        next = liveIn.has(link) ? link : null;
      }
    }
    if (next !== null && next === data.link) return;
    const { link: _l, ...rest } = data;
    void _l;
    out ??= [...nodes];
    out[i] = { ...n, data: next === null ? rest : { ...rest, link: next } } as N;
  });
  return out ?? nodes;
}

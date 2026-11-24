/**
 * The PORTAL gestures' pure half (owner, 2026-11-23; docs/dev/canvas-interaction.md,
 * "Portal"): making a Portal (flow types `tunnelIn` / `tunnelOut`,
 * utils/passThrough.ts) out of a wire, naming it, renaming it, turning it back
 * into wires, relinking a broken exit, the one cycle a connect must refuse,
 * and the trace (which portals are lit, and the ghost line's curve).
 *
 * Every write that splits or rejoins a wire keeps the consumer side at the
 * OLD wire's array index: topological-sort ties follow edge order, so folded
 * through the Portal the edge list reads exactly as before and no private
 * variable name can swap — a Portal never changes the code.
 *
 * Names are DISPLAY ONLY (identity is the entrance's node id, `data.link`):
 * they never reach the code. They are adversarial on read (`tunnelLabelOf`)
 * and cleaned on write (`cleanPortalName`). Pure: no store, no React.
 */
import type { AppEdge, AppNode } from '@/types';
import { unwrapGroupsOnly } from '@/utils/edgeUtils';
import { generateEdgeId } from '@/utils/idGenerator';
import { isCollapsedMember } from '@/utils/groupFrame';
import { cleanPortalName, portalNamesTaken, uniquePortalName } from '@/utils/portalNames';
import {
  TUNNEL_IN_TYPE,
  TUNNEL_OUT_TYPE,
  isPassThroughNode,
  isTunnelIn,
  isTunnelOut,
  passThroughSource,
  topologyEdges,
  tunnelEntrance,
  tunnelExits,
  tunnelLabelOf,
  tunnelLinkOf,
} from '@/utils/passThrough';
import { wouldCreateCycle } from './dragConnect';
import { branchRefusal, feedsFedKnot, half, type BranchRefusal, type Pt } from './branchWire';
import type { BezierSegment } from './edges/bezierGeometry';
import { TUNNEL_SIZE } from './nodes/passThroughGeometry';

// ---------------------------------------------------------------------------
// Names (the rules are the leaf utils/portalNames.ts)
// ---------------------------------------------------------------------------

/**
 * What a portal made from the socket `sourceId` is called: the name the
 * canvas header shows for the node its value really comes from — through a
 * Branch or another Portal (`passThroughSource`) — i.e. a Property's own
 * name, else the generated variable name (`varNames`, the sync engine's
 * `nodeVarNames`), else the node's label. '' when nothing feeds it (the caller
 * then numbers it).
 */
export function portalSourceName(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  varNames: Readonly<Record<string, string>>,
  sourceId: string,
): string {
  let id: string | null = sourceId;
  const first = nodes.find((n) => n.id === sourceId);
  if (first && isPassThroughNode(first)) {
    id = passThroughSource(nodes, unwrapGroupsOnly(nodes as AppNode[], edges as AppEdge[]), sourceId)?.source ?? null;
  }
  if (id === null) return '';
  const node = nodes.find((n) => n.id === id);
  if (!node) return '';
  const data = node.data as { registryType?: unknown; values?: Record<string, unknown>; label?: unknown };
  if ((data.registryType === 'property_float' || data.registryType === 'property_color') && data.values) {
    const own = cleanPortalName(data.values.name);
    if (own) return own;
  }
  const generated = Object.prototype.hasOwnProperty.call(varNames, id) ? cleanPortalName(varNames[id]) : '';
  return generated || cleanPortalName(data.label);
}

// ---------------------------------------------------------------------------
// The two node factories
// ---------------------------------------------------------------------------

/** A group a new end belongs to: its id and ABSOLUTE position (branchWire.ts
 *  `knotParentFor`), or none for the root. */
type Parent = { id: string; origin: Pt } | undefined;

function placed(center: Pt, parent: Parent): { position: Pt; parentId?: string } {
  return {
    position: {
      x: center.x - TUNNEL_SIZE / 2 - (parent?.origin.x ?? 0),
      y: center.y - TUNNEL_SIZE / 2 - (parent?.origin.y ?? 0),
    },
    ...(parent ? { parentId: parent.id } : {}),
  };
}

/** A fresh Portal In named `label`, its hole centred on `center` (flow space). */
export function makeTunnelInNode(id: string, center: Pt, label: string, parent?: Parent): AppNode {
  return {
    id,
    type: TUNNEL_IN_TYPE,
    ...placed(center, parent),
    data: { registryType: TUNNEL_IN_TYPE, label },
  } as unknown as AppNode;
}

/** A fresh Portal Out of the entrance `link`, caching its name `label`. */
export function makeTunnelOutNode(id: string, center: Pt, link: string, label: string, parent?: Parent): AppNode {
  return {
    id,
    type: TUNNEL_OUT_TYPE,
    ...placed(center, parent),
    data: { registryType: TUNNEL_OUT_TYPE, link, label },
  } as unknown as AppNode;
}

// ---------------------------------------------------------------------------
// Make portal: where the two ends go on a wire, and the split
// ---------------------------------------------------------------------------

/** How far along the DRAWN wire each end sits from its socket (flow px). */
export const PORTAL_GAP = 60;

/** Samples per cubic when measuring a wire's arc length. */
const ARC_SAMPLES = 32;

function cubicAt(s: BezierSegment, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * s[0] + b * s[2] + c * s[4] + d * s[6], y: a * s[1] + b * s[3] + c * s[5] + d * s[7] };
}

/** The drawn curve as a polyline: every sample with its running arc length
 *  from the source. */
function arcTable(segs: readonly BezierSegment[]): { p: Pt; at: number }[] {
  const out: { p: Pt; at: number }[] = [];
  let at = 0;
  let prev: Pt | null = null;
  segs.forEach((s, seg) => {
    for (let k = seg === 0 ? 0 : 1; k <= ARC_SAMPLES; k++) {
      const p = cubicAt(s, k / ARC_SAMPLES);
      if (prev) at += Math.hypot(p.x - prev.x, p.y - prev.y);
      out.push({ p, at });
      prev = p;
    }
  });
  return out;
}

function pointAt(table: ReturnType<typeof arcTable>, d: number): Pt {
  for (let i = 1; i < table.length; i++) {
    const b = table[i];
    if (b.at < d) continue;
    const a = table[i - 1];
    const span = b.at - a.at;
    const f = span > 0 ? (d - a.at) / span : 0;
    return { x: a.p.x + (b.p.x - a.p.x) * f, y: a.p.y + (b.p.y - a.p.y) * f };
  }
  return { ...table[table.length - 1].p };
}

/**
 * Where "Make portal" puts the two ends on a wire DRAWN as `segs` (the
 * curve TypedEdge draws, edgeHit.ts `edgeDrawnSegments`): the entrance
 * `PORTAL_GAP` flow px along the curve from the source socket, the exit as
 * far back from the target socket — a third of a short wire each. Null for no
 * curve or a non-finite one.
 */
export function portalSpots(
  segs: readonly BezierSegment[],
  gap = PORTAL_GAP,
): { inAt: Pt; outAt: Pt } | null {
  if (segs.length === 0 || !segs.every((s) => s.every(Number.isFinite))) return null;
  const table = arcTable(segs);
  const total = table[table.length - 1].at;
  const d = Math.min(gap, total / 3);
  return { inAt: pointAt(table, d), outAt: pointAt(table, total - d) };
}

/**
 * `edges` with the wire `edgeId` replaced by the Portal pair: exit → old
 * target at the OLD wire's index, old source → entrance right after it. Null
 * when the wire is missing.
 */
export function splitEdgeWithPortal(
  edges: readonly AppEdge[],
  edgeId: string,
  inId: string,
  outId: string,
): AppEdge[] | null {
  const i = edges.findIndex((e) => e.id === edgeId);
  if (i < 0) return null;
  const old = edges[i];
  const out = edges.slice();
  out.splice(
    i,
    1,
    half(old, outId, 'out', old.target, old.targetHandle),
    half(old, old.source, old.sourceHandle, inId, 'in'),
  );
  return out;
}

/** Why "Make portal" refuses a wire: the Branch's reasons, or `portal` — the
 *  wire already goes INTO a Portal In or comes OUT of a Portal Out, so a
 *  second portal on it would only chain one hidden hop onto another. */
export type PortalRefusal = BranchRefusal | 'portal';

export function makePortalRefusal(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  edgeId: string,
): PortalRefusal | null {
  const branch = branchRefusal(nodes, edges, edgeId);
  if (branch) return branch;
  const wire = edges.find((e) => e.id === edgeId)!;
  const byId = (id: string) => nodes.find((n) => n.id === id);
  if (isTunnelIn(byId(wire.target)) || isTunnelOut(byId(wire.source))) return 'portal';
  return null;
}

// ---------------------------------------------------------------------------
// Rename, relink, paste
// ---------------------------------------------------------------------------

function withLabel(n: AppNode, label: string): AppNode {
  return { ...n, data: { ...n.data, label } } as AppNode;
}

/**
 * `nodes` with the portal `entranceId` renamed to `raw` — cleaned, made
 * unique among the OTHER entrances — and every exit's name cache set to it in
 * the same write. Null when nothing changes (no such entrance, an empty name,
 * or the same name with every cache already current): the caller then spends
 * no undo entry.
 */
export function renamedPortalNodes(nodes: readonly AppNode[], entranceId: string, raw: unknown): AppNode[] | null {
  const entrance = nodes.find((n) => n.id === entranceId);
  if (!entrance || !isTunnelIn(entrance)) return null;
  const clean = cleanPortalName(raw);
  if (clean === '') return null;
  const name = clean === tunnelLabelOf(entrance) ? clean : uniquePortalName(clean, portalNamesTaken(nodes, entranceId));
  let changed = false;
  const out = nodes.map((n) => {
    const own = n.id === entranceId || tunnelLinkOf(n) === entranceId;
    if (!own || (n.data as { label?: unknown }).label === name) return n;
    changed = true;
    return withLabel(n, name);
  });
  return changed ? out : null;
}

/**
 * Would wiring the exit `exitId` to the entrance `entranceId` close a loop —
 * does anything the exit feeds reach the entrance? Read on the wires AS
 * DRAWN plus every live link (`topologyEdges`).
 */
export function relinkMakesLoop(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  exitId: string,
  entranceId: string,
): boolean {
  const topo = topologyEdges(nodes as AppNode[], unwrapGroupsOnly(nodes as AppNode[], edges as AppEdge[]));
  return wouldCreateCycle(topo, entranceId, exitId);
}

/**
 * "Connect to a portal…" on a broken exit: `nodes` with its `link` set to the
 * entrance `entranceId` and its name cache to that entrance's name. Null when
 * either end is not what it should be, or the link would close a loop.
 */
export function relinkedExitNodes(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  exitId: string,
  entranceId: string,
): AppNode[] | null {
  const exit = nodes.find((n) => n.id === exitId);
  const entrance = nodes.find((n) => n.id === entranceId);
  if (!exit || !isTunnelOut(exit) || !entrance || !isTunnelIn(entrance)) return null;
  if (tunnelLinkOf(exit) === entranceId) return null;
  if (relinkMakesLoop(nodes, edges, exitId, entranceId)) return null;
  const label = tunnelLabelOf(entrance);
  return nodes.map((n) => (n.id === exitId ? ({ ...n, data: { ...n.data, link: entranceId, label } } as AppNode) : n));
}

// ---------------------------------------------------------------------------
// Turn back into wires
// ---------------------------------------------------------------------------

/** The entrance a portal end belongs to: itself, or a LIVE exit's entrance;
 *  null for a broken exit or anything else. */
export function entranceOf(nodes: readonly AppNode[], nodeId: string): AppNode | null {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  if (isTunnelIn(node)) return node;
  if (isTunnelOut(node)) return tunnelEntrance(nodes as AppNode[], node);
  return null;
}

/**
 * Why the menu's name field is read-only on the portal end `nodeId` (owner,
 * 2026-11-24): a broken exit (no portal to name), or an entrance inside a
 * COLLAPSED group — a name the canvas cannot show while it is hidden.
 */
export function portalRenameRefusal(nodes: readonly AppNode[], nodeId: string): 'broken' | 'collapsed' | null {
  const entrance = entranceOf(nodes, nodeId);
  if (!entrance) return 'broken';
  return isCollapsedMember(entrance) ? 'collapsed' : null;
}

/**
 * What the menu's name field may hand `renamePortal` when it commits: ONLY
 * what the user typed (`typed`, null while nothing was typed), and nothing
 * when that is the name it showed (`shown`). Opening and closing the menu
 * must never spend an undo entry or rewrite the exits' caches — the first cut
 * committed the shown text, which `renamePortal` cleans, so a stored name that
 * was not clean (a file's) was rewritten on every open, and StrictMode's
 * extra mount/unmount pair did it with nothing on screen.
 */
export function portalNameToCommit(shown: string, typed: string | null): string | null {
  return typed === null || typed === shown ? null : typed;
}

/** Why "Turn back into wires" refuses: a broken exit (no portal to undo) or
 *  an end inside a COLLAPSED group, whose wires sit on the pill's sockets. */
export type UnportalRefusal = 'broken' | 'collapsed' | 'missing';

export function unportalRefusal(nodes: readonly AppNode[], nodeId: string): UnportalRefusal | null {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node || !(isTunnelIn(node) || isTunnelOut(node))) return 'missing';
  const entrance = entranceOf(nodes, nodeId);
  if (!entrance) return 'broken';
  const members = [entrance, ...tunnelExits(nodes as AppNode[], entrance.id)];
  return members.some(isCollapsedMember) ? 'collapsed' : null;
}

/**
 * "Turn back into wires" on either end: every wire out of every exit is fed
 * from the entrance's own feeder again (which is what the fold already reads
 * it as), each at that exit wire's array index; the feed is removed; an UNFED
 * portal's wires simply go. Returns the new edges and the ends to remove, or
 * null when refused (`unportalRefusal`).
 */
export function unportalPlan(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  nodeId: string,
): { edges: AppEdge[]; removeIds: string[] } | null {
  if (unportalRefusal(nodes, nodeId)) return null;
  const entrance = entranceOf(nodes, nodeId)!;
  const exits = tunnelExits(nodes as AppNode[], entrance.id);
  const members = new Set([entrance.id, ...exits.map((n) => n.id)]);
  const feedWire = edges.find((e) => e.target === entrance.id);
  // A feed out of one of this portal's own ends is a loop only a forged file
  // holds: the portal is unfed.
  const feed = feedWire && !members.has(feedWire.source) ? feedWire : null;
  const taken = new Set<string>();
  const out: AppEdge[] = [];
  for (const e of edges) {
    if (members.has(e.target)) continue;
    if (!members.has(e.source)) {
      out.push(e);
      continue;
    }
    // A wire out of an exit (one out of the entrance is forged: dropped).
    if (!feed || e.source === entrance.id) continue;
    const port = `${e.target}\0${e.targetHandle ?? 'in'}`;
    if (taken.has(port)) continue;
    taken.add(port);
    out.push({
      ...e,
      id: generateEdgeId(feed.source, feed.sourceHandle ?? 'out', e.target, e.targetHandle ?? 'in'),
      source: feed.source,
      sourceHandle: feed.sourceHandle,
      selected: false,
    });
  }
  return { edges: out, removeIds: [...members] };
}

// ---------------------------------------------------------------------------
// Connect-time refusals
// ---------------------------------------------------------------------------

/**
 * The MEMBER ends a connection really joins: a collapsed group's pill socket
 * (`__in_…` / `__out_…`) followed to the member it stands for, through the
 * ONE mapping the engines read (`unwrapGroupsOnly`, applied to a probe wire).
 * The loop checks below walk the unwrapped wires, where no edge leaves or
 * enters a collapsed group's own id — asked about the pill, they found no
 * path and accepted a loop made through it. Unchanged when nothing maps.
 */
export function connectionMembers(
  nodes: readonly AppNode[],
  source: string,
  target: string,
  sourceHandle?: string | null,
  targetHandle?: string | null,
): { source: string; target: string } {
  const probe = { id: '\0probe', source, sourceHandle: sourceHandle ?? null, target, targetHandle: targetHandle ?? null } as AppEdge;
  const [out] = unwrapGroupsOnly(nodes as AppNode[], [probe]);
  return out ? { source: out.source, target: out.target } : { source, target };
}

/**
 * Would the connection source → target close a loop that only a Portal's
 * HIDDEN link makes — one the drawn wires do not show? Refused at connect
 * time (owner, 2026-11-23: an exit must never feed something upstream of its
 * own entrance). A loop the drawn wires show keeps today's rule (allowed;
 * graphToCode warns). A pill socket is read as the member it stands for
 * (`connectionMembers`). False, at no cost, while no Portal Out exists.
 */
export function closesHiddenLoop(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  source: string | null | undefined,
  target: string | null | undefined,
  sourceHandle?: string | null,
  targetHandle?: string | null,
): boolean {
  if (!source || !target || !nodes.some(isTunnelOut)) return false;
  const drawn = unwrapGroupsOnly(nodes as AppNode[], edges as AppEdge[]);
  const topo = topologyEdges(nodes as AppNode[], drawn);
  if (topo === drawn) return false;
  const c = connectionMembers(nodes, source, target, sourceHandle, targetHandle);
  return wouldCreateCycle(topo, c.source, c.target) && !wouldCreateCycle(drawn, c.source, c.target);
}

/**
 * A Portal Out of `entranceId` wired into the input of `targetId` (the
 * Add-node menu's rows on a wire pulled from an input): would it close a
 * loop — does `targetId` (a pill socket read as its member) reach the entrance?
 */
export function exitIntoMakesLoop(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  entranceId: string,
  targetId: string,
  targetHandle?: string | null,
): boolean {
  const topo = topologyEdges(nodes as AppNode[], unwrapGroupsOnly(nodes as AppNode[], edges as AppEdge[]));
  const target = connectionMembers(nodes, entranceId, targetId, 'out', targetHandle).target;
  return wouldCreateCycle(topo, entranceId, target);
}

/**
 * Does the graph `edges` hold a loop through `nodeId` that only a Portal's
 * hidden link makes (the drawn wires show none)? The check a WRITE that adds
 * several wires at once makes on its result — the drop-on-wire splice, whose
 * two new wires both touch the spliced node, so any loop it closes runs
 * through that node.
 */
export function hiddenLoopThrough(nodes: readonly AppNode[], edges: readonly AppEdge[], nodeId: string): boolean {
  if (!nodes.some(isTunnelOut)) return false;
  const drawn = unwrapGroupsOnly(nodes as AppNode[], edges as AppEdge[]);
  const topo = topologyEdges(nodes as AppNode[], drawn);
  if (topo === drawn) return false;
  const loops = (view: readonly AppEdge[]) =>
    view.some((e) => e.source === nodeId && (e.target === nodeId || wouldCreateCycle(view, nodeId, e.target)));
  return loops(topo) && !loops(drawn);
}

/**
 * Would splicing `nodeId` into the wire `edgeId` (source → node → target)
 * close a hidden loop? The drag preview's question, asked before the drop
 * (edgeInsert.ts `spliceNodeIntoEdge` asks `hiddenLoopThrough` of the exact
 * result). The splice's input port does not change the topology, so a
 * placeholder stands in for it.
 */
export function spliceClosesHiddenLoop(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  nodeId: string,
  edgeId: string,
): boolean {
  const wire = edges.find((e) => e.id === edgeId);
  if (!wire || !nodes.some(isTunnelOut)) return false;
  const next = edges.filter((e) => e.id !== edgeId);
  next.push(
    { ...wire, id: '\0splice-in', target: nodeId, targetHandle: '\0' },
    { ...wire, id: '\0splice-out', source: nodeId, sourceHandle: '\0' },
  );
  return hiddenLoopThrough(nodes, next, nodeId);
}

/** A connection as the canvas's `isValidConnection` reads it. */
export interface ConnectionLike {
  source: string | null | undefined;
  target: string | null | undefined;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

/**
 * THE connect-time refusal (the canvas's `isValidConnection`, and the
 * reconnect release that must keep its wire when it is refused): a wire into
 * a fed Branch or Portal In (`feedsFedKnot`; `ignoreEdgeId` is a reconnect's
 * own wire), or one that closes a loop only a hidden link makes
 * (`closesHiddenLoop`).
 */
export function connectionRefused(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  c: ConnectionLike,
  ignoreEdgeId?: string | null,
): boolean {
  return feedsFedKnot(nodes, edges, c.target, ignoreEdgeId, c.targetHandle)
    || closesHiddenLoop(nodes, edges, c.source, c.target, c.sourceHandle, c.targetHandle);
}

/** What a reconnect's release reports (React Flow's final connection state). */
export interface ReconnectEnd {
  isValid: boolean | null;
  toHandle: { nodeId: string; id?: string | null; type: string } | null;
  fromHandle?: { type: string } | null;
}

/**
 * A RECONNECT (one end of the wire `edgeId` dragged off its socket) released
 * ON a socket that `connectionRefused` refused: the refusal changes nothing,
 * so the wire stays — never the empty-canvas release's disconnect
 * (branchActions.ts `finishReconnect`). The connection is rebuilt the way
 * React Flow asked about it: the wire's fixed end plus the socket released
 * on. A socket of the SAME kind as the fixed end is React Flow's own refusal,
 * not ours, and keeps today's disconnect.
 */
export function reconnectRefused(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  edgeId: string,
  end: ReconnectEnd,
): boolean {
  const to = end.toHandle;
  if (end.isValid !== false || !to) return false;
  if (end.fromHandle && end.fromHandle.type === to.type) return false;
  const wire = edges.find((e) => e.id === edgeId);
  if (!wire) return false;
  const c: ConnectionLike = to.type === 'target'
    ? { source: wire.source, sourceHandle: wire.sourceHandle, target: to.nodeId, targetHandle: to.id ?? null }
    : { source: to.nodeId, sourceHandle: to.id ?? null, target: wire.target, targetHandle: wire.targetHandle };
  return connectionRefused(nodes, edges, c, edgeId);
}

// ---------------------------------------------------------------------------
// The trace: which portals are lit, and the ghost line
// ---------------------------------------------------------------------------

/**
 * The entrances to trace: every SELECTED portal end's entrance, and the
 * hovered one's (`hoveredId`) — a broken exit traces nothing. Sorted, unique.
 * Allocation-free when no portal end is selected or hovered (the common case,
 * since it runs in a selector on every store notify).
 */
export function tracedEntrances(nodes: readonly AppNode[], hoveredId: string | null): readonly string[] {
  let ids: Set<string> | null = null;
  for (const n of nodes) {
    if (n.id !== hoveredId && !n.selected) continue;
    if (isTunnelIn(n)) (ids ??= new Set()).add(n.id);
    else if (isTunnelOut(n)) {
      const e = tunnelEntrance(nodes as AppNode[], n);
      if (e) (ids ??= new Set()).add(e.id);
    }
  }
  return ids ? [...ids].sort() : NONE;
}
const NONE: readonly string[] = Object.freeze([]);

/** An entrance and all its exits: the ids the trace marks. */
export function portalMembers(nodes: readonly AppNode[], entranceId: string): string[] {
  return [entranceId, ...tunnelExits(nodes as AppNode[], entranceId).map((n) => n.id)];
}

/**
 * The end F goes to from the portal end `endId` (owner, 2026-11-24: "when
 * selected and pressed F, cycle focus through all connected nodes"): the
 * NEXT end of the same portal in its stable order — the entrance, then its
 * exits in graph order (`portalMembers`) — wrapping around. Null, leaving F
 * its usual framing, for anything that is not an end of a portal with a
 * second end: another node, a broken exit, an entrance with no exit.
 */
export function nextPortalEnd(nodes: readonly AppNode[], endId: string): string | null {
  const entrance = entranceOf(nodes, endId);
  if (!entrance) return null;
  const members = portalMembers(nodes, entrance.id);
  if (members.length < 2) return null;
  const i = members.indexOf(endId);
  return i < 0 ? null : members[(i + 1) % members.length];
}

/**
 * The trace's marks as ONE string, a selector's primitive: every end of every
 * traced portal, one id per line ('' while nothing is traced). LF is the
 * separator because it is the one a node id can never hold (graphShape.ts
 * `isSelectorSafeId`); a comma is legal in an adversarial file's id, and a
 * comma-joined key split such an id into fragments that marked OTHER nodes.
 * `portalTraceIds` reads it back.
 */
export function portalTraceKey(nodes: readonly AppNode[], hoveredId: string | null): string {
  const entrances = tracedEntrances(nodes, hoveredId);
  return entrances.length === 0 ? '' : entrances.map((id) => portalMembers(nodes, id).join('\n')).join('\n');
}

export function portalTraceIds(key: string): string[] {
  return key === '' ? [] : key.split('\n');
}

/**
 * The ghost lines of the traced `entrances`: one per exit, from the
 * entrance's hole centre to the exit's (`centreOf`, flow coordinates — React
 * Flow's measured boxes), skipping an end that is not drawn (inside a
 * collapsed group, or not measured yet).
 */
export function ghostLines(
  nodes: readonly AppNode[],
  entrances: readonly string[],
  centreOf: (id: string) => Pt | null,
): { entrance: string; exit: string; d: string }[] {
  const out: { entrance: string; exit: string; d: string }[] = [];
  const shown = (n: AppNode | undefined) => !!n && !isCollapsedMember(n);
  for (const id of entrances) {
    const entrance = nodes.find((n) => n.id === id);
    const a = shown(entrance) ? centreOf(id) : null;
    if (!a) continue;
    for (const exit of tunnelExits(nodes as AppNode[], id)) {
      const b = shown(exit) ? centreOf(exit.id) : null;
      if (b) out.push({ entrance: id, exit: exit.id, d: ghostPath(a, b) });
    }
  }
  return out;
}

/**
 * The ghost line from an entrance's centre `a` to an exit's centre `b`, in
 * flow coordinates: one cubic leaving `a` to the right and arriving at `b`
 * from the left, as a wire would run between the two holes.
 */
export function ghostPath(a: Pt, b: Pt): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  const r = (v: number) => Math.round(v * 10) / 10;
  return `M ${r(a.x)} ${r(a.y)} C ${r(a.x + dx)} ${r(a.y)} ${r(b.x - dx)} ${r(b.y)} ${r(b.x)} ${r(b.y)}`;
}

/**
 * The BRANCH gestures' pure half (owner, 2026-11-23; docs/dev/canvas-interaction.md,
 * "Branch"): putting a Branch (flow type `knot`, utils/passThrough.ts) INTO an
 * existing wire, and the one connect a Branch refuses.
 *
 * A Branch goes into a wire by a double-click on it, or the Add-node menu's
 * Branch row (Insert node on a wire included; owner, 2026-11-24), at the
 * nearest point of the DRAWN curve — and every one of those SPLITS the wire.
 * The consumer-side wire (Branch → old target) is written at the OLD wire's
 * array index and the feed (old source → Branch) right after it
 * (`splitEdgeWithKnot`): topological-sort ties follow edge order, so folded
 * through the Branch the edge list reads exactly as before and no private
 * variable name can swap — inserting a Branch never changes the code.
 *
 * Pure: no store, no React.
 */
import type { AppEdge, AppNode, GroupNodeData } from '@/types';
import { generateEdgeId } from '@/utils/idGenerator';
import { unwrapGroupsOnly } from '@/utils/edgeUtils';
import { KNOT_TYPE, isKnot, isTunnelIn } from '@/utils/passThrough';
import { KNOT_SIZE } from './nodes/passThroughGeometry';
import { absoluteNodePosition } from '@/utils/groupFrame';

export type Pt = { x: number; y: number };

/** A fresh Branch centred on `center` (flow space). With `parent` (a group
 *  and its ABSOLUTE position) it is that group's member, placed relative to it;
 *  else it sits at the root. */
export function makeKnotNode(id: string, center: Pt, parent?: { id: string; origin: Pt }): AppNode {
  const ox = parent?.origin.x ?? 0;
  const oy = parent?.origin.y ?? 0;
  return {
    id,
    type: KNOT_TYPE,
    position: { x: center.x - KNOT_SIZE / 2 - ox, y: center.y - KNOT_SIZE / 2 - oy },
    data: { registryType: KNOT_TYPE },
    ...(parent ? { parentId: parent.id } : {}),
  } as unknown as AppNode;
}

/**
 * The group a Branch put into `wire` belongs to: the innermost EXPANDED group
 * frame both of the wire's ends sit in (their nearest common ancestor), with
 * its absolute position — or null when the wire is not wholly inside one. A
 * Branch left at the root of such a wire stayed behind when the group moved
 * and hung outside its pill when it collapsed, wired through it. A chain from
 * a file may name itself: walked hop-limited and cycle-guarded.
 */
export function knotParentFor(
  nodes: readonly AppNode[],
  wire: { source: string; target: string },
): { id: string; origin: Pt } | null {
  const byId = new Map<string, AppNode>();
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>([id]);
    let p = byId.get(id)?.parentId;
    for (let hops = 0; typeof p === 'string' && !seen.has(p) && hops < 100; hops++) {
      seen.add(p);
      out.push(p);
      p = byId.get(p)?.parentId;
    }
    return out;
  };
  const targetSide = new Set(ancestors(wire.target));
  const common = ancestors(wire.source).find((id) => targetSide.has(id));
  const group = common ? byId.get(common) : undefined;
  if (!group || group.type !== 'group') return null;
  if ((group.data as { collapsed?: unknown } | undefined)?.collapsed === true) return null;
  return { id: group.id, origin: absoluteNodePosition(group, byId) };
}

/** One half of a split wire, with the old wire's data type. Shared with the
 *  Portal's split (portalWire.ts `splitEdgeWithPortal`). */
export function half(
  old: AppEdge,
  source: string,
  sourceHandle: string | null | undefined,
  target: string,
  targetHandle: string | null | undefined,
): AppEdge {
  return {
    id: generateEdgeId(source, sourceHandle ?? 'out', target, targetHandle ?? 'in'),
    source,
    sourceHandle,
    target,
    targetHandle,
    type: 'typed',
    animated: true,
    data: { dataType: old.data?.dataType ?? 'any' },
  };
}

/**
 * `edges` with the wire `edgeId` split by the Branch `knotId`: the
 * consumer-side wire (Branch → old target) at the OLD wire's index, the feed
 * (old source → Branch) right after it. Null when the wire is missing.
 */
export function splitEdgeWithKnot(
  edges: readonly AppEdge[],
  edgeId: string,
  knotId: string,
): AppEdge[] | null {
  const i = edges.findIndex((e) => e.id === edgeId);
  if (i < 0) return null;
  const old = edges[i];
  const out = edges.slice();
  out.splice(
    i,
    1,
    half(old, knotId, 'out', old.target, old.targetHandle),
    half(old, old.source, old.sourceHandle, knotId, 'in'),
  );
  return out;
}

/** Why a Branch cannot go into a wire. */
export type BranchRefusal = 'missing' | 'hidden' | 'group';

/**
 * Can a Branch go into the wire `edgeId`? Refused: a missing or hidden wire,
 * and a wire on a collapsed group's pill (its sockets are synthetic — the
 * Branch would hang off a stash). Null when it may. A split can never close
 * a loop: the wire's own source feeds the Branch, which feeds its own target.
 */
export function branchRefusal(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  edgeId: string,
): BranchRefusal | null {
  const wire = edges.find((e) => e.id === edgeId);
  if (!wire) return 'missing';
  if (wire.hidden) return 'hidden';
  const typeOf = (id: string) => nodes.find((n) => n.id === id)?.type;
  if (typeOf(wire.source) === 'group' || typeOf(wire.target) === 'group') return 'group';
  return null;
}

/**
 * Would this connection feed a Branch — or a Portal In (docs/dev/canvas-interaction.md,
 * "Portal") — that is ALREADY fed? Each has one input, and a wire released on
 * a fed one is REFUSED, never a replacement (owner, 2026-11-23): replacing it
 * would silently re-source every wire it fans out to (through every Portal
 * Out, for an entrance). `ignoreEdgeId` is the wire a reconnect is moving,
 * which may go back where it was.
 *
 * A Branch inside a COLLAPSED group is still fed from outside it through the
 * pill's input socket (`__in_<knot>_in`, which the store's collapse writes
 * onto the trunk), so a `target` that is a collapsed pill is followed through
 * its `collapsedInputs` (and through nested pills) to the member it stands
 * for, and the feed is read on the group-only view (`unwrapGroupsOnly`, which
 * keeps every wire's id). Without that, a second wire onto the pill socket
 * REPLACED the Branch's feed.
 */
export function feedsFedKnot(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  target: string | null | undefined,
  ignoreEdgeId?: string | null,
  targetHandle?: string | null,
): boolean {
  if (!target) return false;
  const byId = (id: string) => nodes.find((n) => n.id === id);
  let id = target;
  let handle = targetHandle ?? null;
  let node = byId(id);
  // Bounded by the node count: a forged loop of pill sockets ends.
  for (let hop = 0; node && !isKnot(node) && !isTunnelIn(node); hop++) {
    if (hop > nodes.length || node.type !== 'group') return false;
    const data = node.data as GroupNodeData;
    if (!data.collapsed || !Array.isArray(data.collapsedInputs)) return false;
    const socket = data.collapsedInputs.find((s) => s != null && s.socketId === handle);
    if (!socket || typeof socket.originalNodeId !== 'string') return false;
    id = socket.originalNodeId;
    handle = socket.originalHandleId ?? null;
    node = byId(id);
  }
  if (!node) return false;
  const view = id === target ? edges : unwrapGroupsOnly(nodes as AppNode[], edges as AppEdge[]);
  return view.some((e) => e.target === id && e.id !== ignoreEdgeId);
}

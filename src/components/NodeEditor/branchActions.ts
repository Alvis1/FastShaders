/**
 * The BRANCH gestures' store-touching half (docs/dev/canvas-interaction.md,
 * "Branch"). "Branch = routing point" (owner, 2026-11-23): a Branch is made
 * ONLY from a right-click menu, and every one that goes into a wire funnels
 * through `insertBranch` — the edge menu's "Branch from here" on a routing
 * point (`promoteWaypoint`) and Insert node > Branch (`branchIntoWireAt`).
 * The pure geometry and the refusals are branchWire.ts.
 *
 * ONE undo entry per act: the add and the split run in one bracket.
 * Telemetry rides the store action that already logs (`addNode` → `node-add`
 * with the node type `knot`, `removeNode` → `node-remove`); nothing new is
 * recorded.
 */
import { useAppStore } from '@/store/useAppStore';

type History = ReturnType<typeof useAppStore.getState>['past'];
import { generateId } from '@/utils/idGenerator';
import { asOneHistoryEntry } from '@/utils/historyGesture';
import { isKnot } from '@/utils/passThrough';
import { branchSpotOnWire, type GetInternalNode } from './edgeHit';
import { WAYPOINT_HIT_PX } from './edges/edgeWaypoints';
import { reconnectRefused, type ReconnectEnd } from './portalWire';
import {
  branchRefusal,
  knotParentFor,
  makeKnotNode,
  splitEdgeWithKnot,
  splitWaypointsAtIndex,
  wirePoints,
  type Pt,
} from './branchWire';

/**
 * Put a new Branch into the wire `edgeId` at `center`, with the wire's
 * routing points shared out as `before` (source half) / `after` (target
 * half). One undo entry. Returns the Branch's id, or null when refused
 * (`branchRefusal`: a missing or hidden wire, a collapsed pill), in which case
 * nothing changes and no undo entry is spent.
 */
export function insertBranch(
  edgeId: string,
  center: Pt,
  before: readonly Pt[],
  after: readonly Pt[],
): string | null {
  const store = useAppStore.getState();
  if (branchRefusal(store.nodes, store.edges, edgeId)) return null;
  const knotId = generateId();
  const split = splitEdgeWithKnot(store.edges, edgeId, knotId, before, after);
  if (!split) return null;
  // On a wire wholly inside an expanded group the Branch is that group's
  // member (`knotParentFor`), or it stays behind when the group moves.
  const wire = store.edges.find((e) => e.id === edgeId)!;
  const parent = knotParentFor(store.nodes, wire) ?? undefined;
  // Guards stay OUTSIDE the bracket: an empty one still costs an undo entry.
  asOneHistoryEntry(() => {
    const s = useAppStore.getState();
    s.addNode(makeKnotNode(knotId, center, parent));
    s.setEdges(split);
  });
  return knotId;
}

/** "Branch from here": routing point `index` of the wire `edgeId` becomes a
 *  Branch at the point's own spot, split at that KNOWN index. */
export function promoteWaypoint(edgeId: string, index: number): string | null {
  const edge = useAppStore.getState().edges.find((e) => e.id === edgeId);
  if (!edge) return null;
  const split = splitWaypointsAtIndex(wirePoints(edge), index);
  if (!split) return null;
  return insertBranch(edgeId, split.at, split.before, split.after);
}

/**
 * Insert node > Branch on the wire `edgeId`, from where its menu opened (flow
 * point `p`): on one of its routing points that point becomes the Branch (as
 * "Branch from here"), else the Branch goes on the nearest point of the DRAWN
 * curve with the points shared out by segment (`branchSpotOnWire`), so nothing
 * is dissolved. One undo entry. Null, changing nothing, when the wire is not
 * drawn or the Branch may not go into it.
 */
export function branchIntoWireAt(
  edgeId: string,
  p: Pt,
  getInternalNode: GetInternalNode,
  zoom: number,
): string | null {
  const edge = useAppStore.getState().edges.find((e) => e.id === edgeId);
  if (!edge || !(zoom > 0)) return null;
  const spot = branchSpotOnWire(edge, p, getInternalNode, WAYPOINT_HIT_PX / zoom);
  if (!spot) return null;
  return spot.kind === 'point'
    ? promoteWaypoint(edgeId, spot.index)
    : insertBranch(edgeId, spot.at, spot.before, spot.after);
}

/** What `startReconnect` remembers: the history before its entry, and the
 *  `past` array that entry made (by identity — `recordHistory` always builds
 *  a new one). */
export interface ReconnectMark {
  edgeId: string;
  past: History;
  future: History;
  pushed: History;
}

/**
 * A wire's END is pressed off its socket (React Flow's reconnect): the undo
 * entry is taken NOW, before anything moves, as it always was (onReconnectStart)
 * — and remembered, so a refused release can take it back.
 */
export function startReconnect(edgeId: string): ReconnectMark {
  const before = useAppStore.getState();
  before.pushHistory();
  return { edgeId, past: before.past, future: before.future, pushed: useAppStore.getState().past };
}

/**
 * The reconnect's release. Connected: done (`onReconnect` wrote it). Released
 * ON a socket the canvas's `isValidConnection` refused (portalWire.ts
 * `reconnectRefused`, the same `connectionRefused`: a fed Branch or Portal In,
 * or a loop only a Portal's hidden link makes): NOTHING changes — the wire
 * stays, and the start's undo entry is taken back with the redo stack it
 * cleared, provided no other entry came after it. Anywhere else (empty
 * canvas, as before): the drag-off DISCONNECT.
 */
export function finishReconnect(
  mark: ReconnectMark,
  succeeded: boolean,
  end: ReconnectEnd,
): 'connected' | 'kept' | 'removed' {
  if (succeeded) return 'connected';
  const s = useAppStore.getState();
  if (reconnectRefused(s.nodes, s.edges, mark.edgeId, end)) {
    if (s.past === mark.pushed) useAppStore.setState({ past: mark.past, future: mark.future });
    return 'kept';
  }
  s.removeEdge(mark.edgeId);
  return 'removed';
}

/**
 * Double-click on a Branch removes it, as a double-click removes a routing
 * point: every wire out of it is fed from the trunk's source again, with the
 * trunk's routing points followed by its own (no point where the Branch was).
 * That is the store's `removeNode`, whose splice is
 * `bridgeEdgesAcrossDeletedNodes` given the nodes — one undo entry and the
 * study's `node-remove`, the same path as X / Delete. False, changing nothing,
 * when `knotId` is not a Branch.
 */
export function removeBranch(knotId: string): boolean {
  const store = useAppStore.getState();
  if (!isKnot(store.nodes.find((n) => n.id === knotId))) return false;
  store.removeNode(knotId);
  return true;
}

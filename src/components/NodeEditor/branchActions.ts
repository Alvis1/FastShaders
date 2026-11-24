/**
 * The BRANCH gestures' store-touching half (docs/dev/canvas-interaction.md,
 * "Branch"). A Branch goes into a wire by a double-click on the wire or by
 * Insert node > Branch, both through `branchIntoWireAt` → `insertBranch`
 * (owner, 2026-11-24: routing points were removed and "double click to
 * place"). The pure geometry and the refusals are branchWire.ts.
 *
 * ONE undo entry per act: the add and the split run in one bracket.
 * Telemetry rides the store action that already logs (`addNode` → `node-add`
 * with the node type `knot`, `removeNode` → `node-remove`, `applyConnection`
 * → `edge-connect`); nothing new is recorded.
 */
import { useAppStore } from '@/store/useAppStore';

type History = ReturnType<typeof useAppStore.getState>['past'];
import { generateId } from '@/utils/idGenerator';
import { asOneHistoryEntry } from '@/utils/historyGesture';
import { isKnot } from '@/utils/passThrough';
import { branchSpotOnWire, type GetInternalNode } from './edgeHit';
import { reconnectRefused, type ReconnectEnd } from './portalWire';
import { branchDropRefusal, type BranchDropRefusal } from './branchDrop';
import {
  branchRefusal,
  knotParentFor,
  makeKnotNode,
  splitEdgeWithKnot,
  type Pt,
} from './branchWire';

/**
 * Put a new Branch into the wire `edgeId` at `center`. One undo entry.
 * Returns the Branch's id, or null when refused (`branchRefusal`: a missing
 * or hidden wire, a collapsed pill), in which case nothing changes and no
 * undo entry is spent.
 */
export function insertBranch(edgeId: string, center: Pt): string | null {
  const store = useAppStore.getState();
  if (branchRefusal(store.nodes, store.edges, edgeId)) return null;
  const knotId = generateId();
  const split = splitEdgeWithKnot(store.edges, edgeId, knotId);
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

/**
 * A Branch on the wire `edgeId`, aimed at the flow point `p` — a double-click
 * on the wire, or Insert node > Branch from where its menu opened: on the
 * nearest point of the DRAWN curve (`branchSpotOnWire`). One undo entry. Null,
 * changing nothing, when the wire is not drawn or the Branch may not go into
 * it (`branchRefusal`: a collapsed pill's wire).
 */
export function branchIntoWireAt(
  edgeId: string,
  p: Pt,
  getInternalNode: GetInternalNode,
): string | null {
  const edge = useAppStore.getState().edges.find((e) => e.id === edgeId);
  if (!edge) return null;
  const spot = branchSpotOnWire(edge, p, getInternalNode);
  if (!spot) return null;
  return insertBranch(edgeId, spot);
}

/** A connection as the canvas commits it (NodeEditor's `applyConnection`). */
export interface BranchConnection {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

/**
 * A Branch dragged onto an input and released there (owner, 2026-11-24: "a
 * branch dragged over an input branches to that input, keeping the drag's
 * start location"): the Branch goes BACK to `start` (its node position when
 * the drag began) and, unless refused (branchDrop.ts `branchDropRefusal` — it
 * then just goes back), Branch.out is wired into the input through `connect`
 * (the canvas's ONE connect commit). ONE undo entry, taken AFTER the Branch is
 * back, so it holds no move: undo removes the wire and nothing moves; a
 * refusal spends none.
 */
export function dropBranchOnInput(
  knotId: string,
  start: Pt,
  socket: { nodeId: string; handleId: string },
  connect: (c: BranchConnection) => void,
): 'connected' | BranchDropRefusal {
  const store = useAppStore.getState();
  const knot = store.nodes.find((n) => n.id === knotId);
  if (!isKnot(knot)) return 'missing';
  // Back where the drag started — a position write, never an undo entry.
  if (knot!.position.x !== start.x || knot!.position.y !== start.y) {
    store.setNodes(store.nodes.map((n) => (n.id === knotId ? ({ ...n, position: { x: start.x, y: start.y } } as typeof n) : n)));
  }
  const now = useAppStore.getState();
  const refusal = branchDropRefusal(now.nodes, now.edges, knotId, socket);
  if (refusal) return refusal;
  now.pushHistory();
  connect({ source: knotId, sourceHandle: 'out', target: socket.nodeId, targetHandle: socket.handleId });
  return 'connected';
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
 * Double-click on a Branch removes it: every wire out of it is fed from the
 * trunk's source again, each at its own array index. That is the store's
 * `removeNode`, whose splice is `bridgeEdgesAcrossDeletedNodes` — one undo
 * entry and the study's `node-remove`, the same path as X / Delete. False,
 * changing nothing, when `knotId` is not a Branch.
 */
export function removeBranch(knotId: string): boolean {
  const store = useAppStore.getState();
  if (!isKnot(store.nodes.find((n) => n.id === knotId))) return false;
  store.removeNode(knotId);
  return true;
}

/**
 * A BRANCH dragged onto an INPUT (owner, 2026-11-24: "a branch dragged over
 * an input branches to that input, keeping the drag's start location";
 * docs/dev/canvas-interaction.md, "Branch"). The pure half: which input the
 * dragged dot is over, and whether the Branch may be wired into it. The store
 * half is branchActions.ts `dropBranchOnInput`, the gesture NodeEditor's
 * node-drag handlers.
 *
 * Pure: no store, no React, no DOM.
 */
import type { AppEdge, AppNode } from '@/types';
import { unwrapGroupsOnly } from '@/utils/edgeUtils';
import { topologyEdges } from '@/utils/passThrough';
import { wouldCreateCycle } from './dragConnect';
import { connectionMembers, connectionRefused } from './portalWire';
import type { Pt } from './branchWire';

/** An input socket on the canvas: its node, its handle id and its CENTRE in
 *  flow space (React Flow's measured handle bounds). */
export interface InputSocket {
  nodeId: string;
  handleId: string;
  x: number;
  y: number;
}

/**
 * The input socket the Branch's dot `center` is released over: the nearest
 * socket of ANOTHER node whose centre lies within `radius` flow px (the
 * connection radius a dragged wire snaps within), or null. An input this
 * Branch already feeds is never one — moving a Branch up to its own consumer
 * is a plain move. A tie keeps the first in `sockets` order.
 *
 * Runs every drag FRAME over every input socket on the canvas, so the cheap
 * distance test comes first and only a socket within reach pays the edge scan.
 */
export function branchDropSocket(
  center: Pt,
  sockets: readonly InputSocket[],
  knotId: string,
  radius: number,
  edges: readonly AppEdge[],
): InputSocket | null {
  let best: InputSocket | null = null;
  let bestD = radius;
  for (const s of sockets) {
    if (s.nodeId === knotId) continue;
    const d = Math.hypot(s.x - center.x, s.y - center.y);
    if (!(d <= bestD && (best === null || d < bestD))) continue;
    if (edges.some((e) => e.source === knotId && e.target === s.nodeId && (e.targetHandle ?? null) === s.handleId)) continue;
    best = s;
    bestD = d;
  }
  return best;
}

/** Why the Branch may not be wired into an input it was dropped on. */
export type BranchDropRefusal = 'missing' | 'same' | 'refused' | 'loop';

/**
 * May the Branch `knotId` be wired into the input `socket` it was dropped on?
 * Refused (and the Branch simply goes back): a node that is not there; an
 * input this Branch ALREADY feeds (`same` — nothing would change); the
 * canvas's own connect refusal (`connectionRefused`: a fed Branch or Portal
 * In, a loop only a Portal's hidden link makes); and ANY loop (`loop`: the
 * input's node reaches the Branch on the wires as drawn plus every live
 * link — a pill socket read as its member). An occupied ordinary input is no
 * refusal: the wire into it is replaced, the normal connect rule.
 */
export function branchDropRefusal(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  knotId: string,
  socket: { nodeId: string; handleId: string },
): BranchDropRefusal | null {
  if (!nodes.some((n) => n.id === knotId) || !nodes.some((n) => n.id === socket.nodeId)) return 'missing';
  if (edges.some((e) => e.source === knotId && e.target === socket.nodeId && (e.targetHandle ?? null) === socket.handleId)) {
    return 'same';
  }
  const c = { source: knotId, sourceHandle: 'out', target: socket.nodeId, targetHandle: socket.handleId };
  if (connectionRefused(nodes, edges, c)) return 'refused';
  const topo = topologyEdges(nodes as AppNode[], unwrapGroupsOnly(nodes as AppNode[], edges as AppEdge[]));
  const m = connectionMembers(nodes, knotId, socket.nodeId, 'out', socket.handleId);
  if (wouldCreateCycle(topo, m.source, m.target)) return 'loop';
  return null;
}

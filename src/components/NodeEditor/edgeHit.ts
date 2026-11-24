/**
 * Hit-testing WIRES on the canvas against the curve each one is DRAWN as —
 * the drop-on-edge splice, the tile drag's highlight, the cut stroke and a
 * Branch placed on a wire (double-click, Insert node > Branch;
 * branchActions.ts) all ask here, so what lights is exactly what is hit.
 * Moved out of NodeEditor.tsx (2026-11-23) so the Branch could reuse the
 * curve rather than restate it. A wire is always its ONE plain cubic: routing
 * points were removed (owner, 2026-11-24).
 *
 * Reads React Flow's internal nodes (measured handle bounds), never the DOM.
 */
import { Position, type InternalNode } from '@xyflow/react';
import type { AppEdge } from '@/types';
import {
  distancePointToCubicBezier,
  edgeBezier,
  nearestOnSegments,
  type BezierSegment,
} from './edges/bezierGeometry';
import type { Pt } from './branchWire';
import { edgeClassHas } from './edges/portalDive';
import { prepareStroke, strokeCrossesSegments } from './cutStroke';

export type GetInternalNode = (id: string) => InternalNode | undefined;

/**
 * The edge anchor React Flow actually draws from/to for one handle, in
 * flow-space: the handle box's CARDINAL-side midpoint (Right → right edge, Left
 * → left edge, …), exactly what @xyflow/system's getHandlePosition(center=false)
 * returns. Also reports the handle's node-local CENTER (`localCx/localCy`) so a
 * color-circle source can reconstruct its radial exit vector. Falls back to the
 * node's mid-left/mid-right edge when handle bounds haven't been measured yet.
 * Reading the ACTUAL handle (not the node's vertical center) is what lets a drop
 * land on an edge feeding a non-centered socket — e.g. the Output node's
 * displacement/normal rows, or the `b` input of an arithmetic node.
 */
export function handleAnchor(
  node: InternalNode,
  handleId: string | null | undefined,
  kind: 'source' | 'target',
): { x: number; y: number; position: Position; localCx: number; localCy: number } {
  const pos = node.internals.positionAbsolute;
  const bounds = node.internals.handleBounds?.[kind];
  const h = (handleId ? bounds?.find((b) => b.id === handleId) : undefined) ?? bounds?.[0];
  if (h) {
    const localCx = h.x + h.width / 2;
    const localCy = h.y + h.height / 2;
    let x = pos.x + localCx;
    let y = pos.y + localCy;
    switch (h.position) {
      case Position.Left:   x = pos.x + h.x; break;
      case Position.Right:  x = pos.x + h.x + h.width; break;
      case Position.Top:    y = pos.y + h.y; break;
      case Position.Bottom: y = pos.y + h.y + h.height; break;
    }
    return { x, y, position: h.position, localCx, localCy };
  }
  const w = node.measured?.width ?? 120;
  const ht = node.measured?.height ?? 40;
  return kind === 'source'
    ? { x: pos.x + w, y: pos.y + ht / 2, position: Position.Right, localCx: w, localCy: ht / 2 }
    : { x: pos.x, y: pos.y + ht / 2, position: Position.Left, localCx: 0, localCy: ht / 2 };
}

/**
 * What is not DRAWN must not be hit-testable. React Flow renders an edge only
 * when its NAMED handle resolves in the node's measured bounds — an edge into
 * a DORMANT Output section's unmounted `m<n>:<channel>` handle renders as
 * NOTHING — but `handleAnchor`'s first-handle fallback would still anchor it
 * at the node's first mounted handle, so `findNearestEdge` measured a phantom
 * curve across empty-looking canvas that a drop could then SPLICE with no
 * highlight ever painted ("what wasn't previewed is never committed"). A null
 * handle id keeps the first-handle fallback (React Flow's own rule), and
 * unmeasured bounds stay permissive (a one-frame mid-mount state).
 */
function edgeEndpointDrawable(
  node: InternalNode,
  handleId: string | null | undefined,
  kind: 'source' | 'target',
): boolean {
  if (!handleId) return true;
  const bounds = node.internals.handleBounds?.[kind];
  if (!bounds) return true;
  return bounds.some((b) => b.id === handleId);
}

/** Is this wire hit-testable at all: drawn, not a collapsed group's inside.
 *  The class is read as data (`edgeClassHas`): a file's edge `className` may
 *  be no string, and `.includes` on one threw mid-drag. */
function edgeHittable(edge: AppEdge): boolean {
  if (edge.hidden) return false;
  return !edgeClassHas((edge as { className?: unknown }).className, 'fs-collapsed-edge');
}

/** Does React Flow DRAW this wire — both ends' nodes known and both NAMED
 *  handles mounted (`edgeEndpointDrawable`)? */
function edgeDrawn(edge: AppEdge, getInternalNode: GetInternalNode): boolean {
  const srcNode = getInternalNode(edge.source);
  const tgtNode = getInternalNode(edge.target);
  return !!srcNode && !!tgtNode
    && edgeEndpointDrawable(srcNode, edge.sourceHandle, 'source')
    && edgeEndpointDrawable(tgtNode, edge.targetHandle, 'target');
}

/**
 * The centreline an edge is DRAWN as, in flow space: the one cubic React Flow
 * draws (with the Color node's radial exit) — TypedEdge's own curve, through
 * the shared `edgeBezier`. A one-segment chain, so callers that walk chains
 * (the cut stroke, Make portal's arc length) need no special case. Null when
 * an end is not drawn.
 */
export function edgeDrawnSegments(edge: AppEdge, getInternalNode: GetInternalNode): BezierSegment[] | null {
  if (!edgeDrawn(edge, getInternalNode)) return null;
  const srcNode = getInternalNode(edge.source)!;
  const tgtNode = getInternalNode(edge.target)!;
  const s = handleAnchor(srcNode, edge.sourceHandle, 'source');
  const t = handleAnchor(tgtNode, edge.targetHandle, 'target');
  return [edgeBezier(s.x, s.y, radialExit(srcNode, s) ?? s.position, t.x, t.y, t.position)];
}

/** A Color node's radial exit (its output rides the circle), else null. */
function radialExit(
  srcNode: InternalNode,
  s: { localCx: number; localCy: number },
): readonly [number, number] | null {
  if (srcNode.type !== 'color') return null;
  const rdx = s.localCx - (srcNode.measured?.width ?? 28) / 2;
  const rdy = s.localCy - (srcNode.measured?.height ?? 28) / 2;
  const rlen = Math.hypot(rdx, rdy);
  return rlen > 1e-3 ? [rdx / rlen, rdy / rlen] : null;
}

/**
 * Find the closest edge to (cx, cy) in flow-space within `radius` (flow px).
 * `excludeNodeId` skips edges connected to the node being dragged. Distance is
 * measured against the SAME cubic bezier TypedEdge renders — exact handle
 * anchors, React Flow's control-point math, and the color-circle radial exit —
 * so what highlights is exactly what snaps. Invisible edges (collapsed-group
 * internals / hidden boundary edges) are skipped so a node can't splice onto an
 * edge the user can't see.
 */
export function findNearestEdge(
  cx: number, cy: number,
  allEdges: AppEdge[],
  getInternalNode: GetInternalNode,
  radius: number,
  excludeNodeId?: string,
): string | null {
  let bestId: string | null = null;
  let bestDist = radius;

  for (const edge of allEdges) {
    if (!edgeHittable(edge)) continue;
    if (excludeNodeId && (edge.source === excludeNodeId || edge.target === excludeNodeId)) continue;
    const srcNode = getInternalNode(edge.source);
    const tgtNode = getInternalNode(edge.target);
    if (!srcNode || !tgtNode) continue;
    if (!edgeEndpointDrawable(srcNode, edge.sourceHandle, 'source')) continue;
    if (!edgeEndpointDrawable(tgtNode, edge.targetHandle, 'target')) continue;

    const s = handleAnchor(srcNode, edge.sourceHandle, 'source');
    const t = handleAnchor(tgtNode, edge.targetHandle, 'target');

    // Color nodes are circles whose output rides the perimeter and exits along
    // the radial (TypedEdge's getRadialBezierPath) — everything else uses the
    // cardinal exit. Match whichever this edge is actually drawn with, through
    // `edgeBezier`, the ONE curve the renderer and the chevrons also call, so
    // the "never fork the curve" rule holds by construction.
    const exit = radialExit(srcNode, s) ?? s.position;
    const [, , c1x, c1y, c2x, c2y] = edgeBezier(s.x, s.y, exit, t.x, t.y, t.position);
    // Reject on the control hull before paying for the solve. A cubic bezier
    // lies inside the convex hull of its four control points, so a curve
    // whose control AABB is further than `bestDist` from the probe cannot
    // contain a closer point — an EXACT test, so it can never change which
    // edge is picked (the "what highlights is exactly what snaps" contract
    // holds). Worth it because this runs per edge per drag FRAME and
    // `distancePointToCubicBezier` is 31 coarse samples plus 3 refine passes
    // of 13 — 70 curve evaluations, measured at ~50 µs for 294 edges against
    // ~2 µs with the reject.
    const loX = Math.min(s.x, c1x, c2x, t.x);
    const hiX = Math.max(s.x, c1x, c2x, t.x);
    const loY = Math.min(s.y, c1y, c2y, t.y);
    const hiY = Math.max(s.y, c1y, c2y, t.y);
    if (cx < loX - bestDist || cx > hiX + bestDist
      || cy < loY - bestDist || cy > hiY + bestDist) continue;
    const d = distancePointToCubicBezier(s.x, s.y, c1x, c1y, c2x, c2y, t.x, t.y, cx, cy);
    if (d < bestDist) {
      bestDist = d;
      bestId = edge.id;
    }
  }
  return bestId;
}

/**
 * The wires a CUT STROKE crosses (cutStroke.ts): every hittable wire whose
 * DRAWN centreline — `edgeDrawnSegments`, the curve `findNearestEdge` measures
 * and TypedEdge draws — the polyline `stroke` (flow space) meets, in `edges`
 * order. `tol` is the flattening tolerance in flow units (half a screen pixel
 * at the current zoom is plenty). Hidden wires, a collapsed group's insides
 * and wires into an unmounted socket are never cut: what is not drawn cannot
 * be crossed. A wire into or out of a Branch or a Portal end is a wire like
 * any other.
 */
export function edgesCrossedByStroke(
  stroke: readonly Pt[],
  edges: readonly AppEdge[],
  getInternalNode: GetInternalNode,
  tol: number,
): string[] {
  const prepared = prepareStroke(stroke);
  if (!prepared) return [];
  const out: string[] = [];
  for (const edge of edges) {
    if (!edge || !edgeHittable(edge)) continue;
    const segs = edgeDrawnSegments(edge, getInternalNode);
    if (segs && strokeCrossesSegments(prepared, segs, tol)) out.push(edge.id);
  }
  return out;
}

/**
 * Where a Branch goes on the wire `edge`, for a point `p` (flow space) aimed
 * at it — the double-click on the wire, or the spot Insert node's menu opened
 * at: the NEAREST point of the curve the wire is DRAWN as. Null when the wire
 * is not drawn (hidden, a collapsed pill's inside, an unmounted socket): what
 * is not drawn cannot be pointed at.
 */
export function branchSpotOnWire(
  edge: AppEdge,
  p: Pt,
  getInternalNode: GetInternalNode,
): Pt | null {
  if (!edgeHittable(edge)) return null;
  const segs = edgeDrawnSegments(edge, getInternalNode);
  if (!segs) return null;
  const hit = nearestOnSegments(segs, p.x, p.y);
  return hit ? { x: hit.x, y: hit.y } : null;
}

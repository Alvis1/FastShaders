import { useCallback, useRef } from 'react';
import {
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  useReactFlow,
  useStore as useReactFlowStore,
  type EdgeProps,
  type ReactFlowState,
} from '@xyflow/react';
import type { AppEdge } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { COUNT_EDGE_COLORS, getContrastColor } from '@/utils/colorUtils';
import { setEdgeDisconnecting } from '@/utils/edgeDisconnectFlag';
import { evaluateEdgeSource, getEdgeOutputShape, getUnwrappedEdge } from '@/engine/cpuEvaluator';
import { bezierControlOffset, radialControlPoint, splinePath } from './bezierGeometry';
import { EdgeInfoCard } from './EdgeInfoCard';
import { nodeRisePx } from '../nodes/nodeFrame';

type Waypoint = { x: number; y: number };

/**
 * Draggable dots for an edge's routing waypoints. Rendered only when an edge
 * actually has waypoints, so the (per-edge) zoom subscription below only costs
 * the few routed edges — not every wire on the canvas. Dots are scale-
 * compensated (radius ÷ zoom) so they stay a constant on-screen size. Drag to
 * move, double-click to remove. History is pushed once per gesture.
 */
function EdgeWaypointHandles({
  edgeId,
  waypoints,
  bgColor,
}: {
  edgeId: string;
  waypoints: Waypoint[];
  bgColor: string;
}) {
  const zoom = useReactFlowStore((s: ReactFlowState) => s.transform[2]);
  const { screenToFlowPosition } = useReactFlow();
  const dragRef = useRef<{ index: number; startX: number; startY: number; moved: boolean } | null>(null);
  const fill = getContrastColor(bgColor);
  const stroke = fill === '#ffffff' ? '#000000' : '#ffffff';
  const r = 5 / zoom;

  const onPointerDown = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.target as SVGElement).setPointerCapture(e.pointerId);
    // Don't push history yet — a plain click (or the two clicks of a
    // double-click-to-remove) must NOT create undo entries. History is pushed
    // lazily on the first real movement (below), so a drag = exactly one entry.
    dragRef.current = { index, startX: e.clientX, startY: e.clientY, moved: false };
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    // Capture may already be gone after a pointercancel — releasing then throws.
    try { (e.target as SVGElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    dragRef.current = null;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // A stale drag (e.g. after a swallowed pointercancel) would otherwise make a
    // no-button hover drag the point around — bail if the button isn't held.
    if (e.buttons === 0) { endDrag(e); return; }
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 2) return;
      d.moved = true;
      useAppStore.getState().pushHistory();
    }
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const store = useAppStore.getState();
    const edge = store.edges.find((ed) => ed.id === edgeId);
    const wps = ((edge?.data?.waypoints ?? []) as Waypoint[]).slice();
    if (d.index >= wps.length) return;
    wps[d.index] = { x: p.x, y: p.y };
    store.setEdgeWaypoints(edgeId, wps);
  };
  const onDoubleClick = (e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    const store = useAppStore.getState();
    const edge = store.edges.find((ed) => ed.id === edgeId);
    const wps = ((edge?.data?.waypoints ?? []) as Waypoint[]).filter((_, i) => i !== index);
    store.setEdgeWaypoints(edgeId, wps, { history: true });
  };

  return (
    <g>
      {waypoints.map((w, i) => (
        <circle
          key={i}
          cx={w.x}
          cy={w.y}
          r={r}
          fill={fill}
          stroke={stroke}
          strokeWidth={1.5 / zoom}
          style={{ cursor: 'grab', pointerEvents: 'all' }}
          onPointerDown={(e) => onPointerDown(e, i)}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={(e) => onDoubleClick(e, i)}
        />
      ))}
    </g>
  );
}

const GAP = 3.5 / 3;

/** A selected wire simply gets THICKER — no shadow, no glow, no colour change.
 *
 *  Deliberately NOT the elevation shadow the node cards use: a wire is a line,
 *  not a plate, so an offset copy of it is just another line, and at any offset
 *  large enough to see it stops reading as that wire's shadow and starts
 *  reading as a second wire beside it. Weight is the property a line actually
 *  has to spend.
 *
 *  The boost scales the WHOLE ribbon — both the stroke width and the
 *  per-channel perpendicular offsets (see getOffsets) — rather than the stroke
 *  alone. Multi-channel lines sit GAP (1.167px) apart and are already up to
 *  1.2px wide, so thickening the strokes on their own would close those gaps
 *  and fuse a 4-channel ribbon into one solid band: the selection highlight
 *  would destroy the channel count it is highlighting. Scaling both keeps the
 *  ribbon geometrically similar, just bigger. */
const SELECTED_EDGE_BOOST = 1.8;

function getOffsets(count: number): number[] {
  if (count <= 1) return [0];
  const offsets: number[] = [];
  const half = (count - 1) / 2;
  for (let i = 0; i < count; i++) {
    offsets.push((i - half) * GAP);
  }
  return offsets;
}

/** Perpendicular unit vector to the source→target direction. */
function perp(sx: number, sy: number, tx: number, ty: number): [number, number] {
  const dx = tx - sx;
  const dy = ty - sy;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return [-dy / len, dx / len];
}

/**
 * Cubic bezier whose SOURCE tangent is a free unit vector instead of one of
 * React Flow's four cardinal `sourcePosition`s. Used for color-circle sources:
 * their output socket rides the circle's perimeter, and the edge should leave
 * perpendicular to the circle (along the radial), not snapped to an axis.
 * The target side keeps getBezierPath's cardinal behavior so it lands on the
 * input socket exactly like every other edge. Returns [path, labelX, labelY]
 * with the label at the curve's t=0.5 point, mirroring getBezierPath.
 */
function getRadialBezierPath(params: {
  sourceX: number;
  sourceY: number;
  radial: [number, number];
  targetX: number;
  targetY: number;
  targetPosition: Position;
}): [string, number, number] {
  const { sourceX: sx, sourceY: sy, radial: [rx, ry], targetX: tx, targetY: ty, targetPosition } = params;
  // Source handle: RF's formula projected onto the radial exit axis, with a
  // small floor so the perpendicular exit stays readable even when the target
  // sits beside/behind the socket. Shared with the drop-on-edge hit test.
  const [c1x, c1y] = radialControlPoint(sx, sy, rx, ry, tx, ty);
  // Target handle: exactly RF's getControlWithCurvature per-axis behavior.
  let c2x = tx;
  let c2y = ty;
  switch (targetPosition) {
    case Position.Left: c2x = tx - bezierControlOffset(tx - sx); break;
    case Position.Right: c2x = tx + bezierControlOffset(sx - tx); break;
    case Position.Top: c2y = ty - bezierControlOffset(ty - sy); break;
    case Position.Bottom: c2y = ty + bezierControlOffset(sy - ty); break;
  }
  // Cubic bezier at t=0.5.
  const labelX = (sx + 3 * c1x + 3 * c2x + tx) / 8;
  const labelY = (sy + 3 * c1y + 3 * c2y + ty) / 8;
  return [`M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`, labelX, labelY];
}

export function TypedEdge({
  id,
  source,
  target,
  sourceHandleId,
  sourceX: rawSourceX,
  sourceY: rawSourceY,
  targetX: rawTargetX,
  targetY: rawTargetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps<AppEdge>) {
  const nodeEditorBgColor = useAppStore((s) => s.nodeEditorBgColor);

  /**
   * A LIFTED node (hovered, selected, or holding an open settings menu) moves
   * by --fs-node-rise toward the light — and its SOCKETS move with it, while
   * React Flow keeps computing this edge's endpoints from the node's POSITION,
   * which a CSS translate never touches. Left alone, every wire on a lifted
   * node hangs a few px off its port and reads as unplugged.
   *
   * So each endpoint is offset by the same rise when ITS node is lifted — only
   * that end, because the other node has not moved.
   *
   * Both selectors fold to a small NUMBER, which is what keeps this cheap: the
   * result is 0 for every edge that does not touch the node in question, so a
   * hover or a selection change re-renders the one or two edges that actually
   * moved and nothing else. (Same reasoning as `isColorSource` below, and the
   * reason neither reads the app store's whole `nodes` array — that array's
   * identity changes on every drag frame.)
   */
  const liftedBySelection = useReactFlowStore(
    useCallback(
      (s: ReactFlowState) =>
        (s.nodeLookup.get(source)?.selected ? 1 : 0) | (s.nodeLookup.get(target)?.selected ? 2 : 0),
      [source, target],
    ),
  );
  // Hover and "its settings menu is open" both live in the app store; folded
  // into ONE subscription so an edge carries two, not three.
  const liftedByPointer = useAppStore(
    useCallback(
      (s: { hoveredNodeId: string | null; contextMenu: { open: boolean; nodeId?: string } }) => {
        const menuId = s.contextMenu.open ? s.contextMenu.nodeId : undefined;
        const lifted = (id: string) => s.hoveredNodeId === id || menuId === id;
        return (lifted(source) ? 1 : 0) | (lifted(target) ? 2 : 0);
      },
      [source, target],
    ),
  );
  const liftMask = liftedBySelection | liftedByPointer;
  const rise = liftMask === 0 ? 0 : nodeRisePx();
  const sourceX = rawSourceX + (liftMask & 1 ? rise : 0);
  const sourceY = rawSourceY + (liftMask & 1 ? rise : 0);
  const targetX = rawTargetX + (liftMask & 2 ? rise : 0);
  const targetY = rawTargetY + (liftMask & 2 ? rise : 0);

  // Color-circle sources get a radial exit tangent (perpendicular to the
  // circle) instead of a cardinal one — see getRadialBezierPath. The radial
  // runs from the circle's center through the measured HANDLE center (not the
  // edge anchor, which sits on the handle's cardinal side and would skew the
  // direction a few degrees). handleBounds coords are node-relative, so the
  // whole computation is node-local; null for other source types.
  // Read from React Flow's own O(1) nodeLookup (primitive result, so this
  // never re-renders the edge) instead of subscribing to the app store's
  // whole nodes array — that array's identity changes every drag pointermove
  // and re-rendered EVERY edge per frame.
  const isColorSource = useReactFlowStore(
    useCallback(
      (s: ReactFlowState) =>
        (s.nodeLookup.get(source)?.data as { registryType?: string } | undefined)?.registryType === 'color',
      [source],
    ),
  );
  const radial = useReactFlowStore(
    useCallback(
      (s: ReactFlowState): [number, number] | null => {
        if (!isColorSource) return null;
        const n = s.nodeLookup.get(source);
        if (!n) return null;
        const cx = (n.measured.width ?? 28) / 2;
        const cy = (n.measured.height ?? 28) / 2;
        const h = n.internals.handleBounds?.source?.[0];
        if (!h) return null;
        const rdx = h.x + h.width / 2 - cx;
        const rdy = h.y + h.height / 2 - cy;
        const rlen = Math.hypot(rdx, rdy);
        return rlen > 1e-3 ? [rdx / rlen, rdy / rlen] : null;
      },
      [source, isColorSource],
    ),
    (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1],
  );

  // Channel count: take the *larger* of live evaluation length and static shape inference.
  // Why both?
  //  - Live eval handles cases where the static walker can't see through 'any' broadcasting,
  //    e.g. `mul(float, vec2)` where the arithmetic node's output port is 'any' and the
  //    static walker would resolve to float.
  //  - Static shape handles cases where eval returns null or a shorter array, e.g. anything
  //    downstream of a procedural texture (perlinNoise → sub → ...): eval returns null because
  //    the texture is unevaluable, but the static walker still knows sub's output is vec3 (color).
  // Boundary edges from a collapsed group carry the GROUP id as their raw
  // source/target — resolve the LOGICAL endpoints (the real producer/consumer)
  // so the wire's channel count and the info card agree with what the target
  // node's card shows (its labels resolve through the same unwrap).
  const logicalSource = useAppStore(
    (s) => getUnwrappedEdge(s.nodes, s.edges, id)?.source ?? source,
  );
  const logicalTarget = useAppStore(
    (s) => getUnwrappedEdge(s.nodes, s.edges, id)?.target ?? target,
  );
  // The socket the wire really leaves (see the count selector) — the info card
  // must measure the same channel the ribbon draws.
  const logicalSourceHandle = useAppStore(
    (s) => getUnwrappedEdge(s.nodes, s.edges, id)?.sourceHandle ?? sourceHandleId ?? null,
  );

  // Taking max means each path catches the gaps of the other.
  // Computed IN the selector: the shared evaluator ctx makes both calls cache
  // hits per graph version, and the primitive result means a store notify
  // whose count is unchanged (every drag pointermove) bails before re-render.
  const count = useAppStore((s) => {
    // Both the source AND its handle come off the UNWRAPPED edge, never React
    // Flow's `sourceHandleId` prop: unwrapCollapsedGroupEdges rewrites the
    // handle too, and a collapsed group's synthetic socket id matches no
    // registry port — the projection would silently fall back to the whole
    // vector and draw a plausible-looking, wrong-width ribbon.
    const un = getUnwrappedEdge(s.nodes, s.edges, id);
    const e = { source: un?.source ?? source, sourceHandle: un?.sourceHandle ?? sourceHandleId };
    const evaluated = evaluateEdgeSource(e, s.nodes, s.edges, 0);
    const evalLen = evaluated?.length ?? 0;
    const shapeLen = getEdgeOutputShape(e, s.nodes, s.edges);
    return Math.min(Math.max(evalLen, shapeLen, 1), 4);
  });
  // 1-channel edges flip black ↔ white so they remain visible against the
  // user-picked canvas background. Multi-channel edges keep their RGB(A)
  // colors — those already read against any background.
  const channelColors =
    count === 1
      ? [getContrastColor(nodeEditorBgColor)]
      : COUNT_EDGE_COLORS[count] ?? COUNT_EDGE_COLORS[1];
  // Thinner lines when more channels; a selected edge scales the whole ribbon
  // (widths AND offsets, see SELECTED_EDGE_BOOST) so it reads as the same wire,
  // drawn heavier. Previously only the 1-channel case thickened, which left a
  // selected multi-channel edge marked by nothing but an opacity nudge.
  const boost = selected ? SELECTED_EDGE_BOOST : 1;
  const offsets = getOffsets(count).map((d) => d * boost);
  const strokeWidth = (count >= 4 ? 0.8 : count >= 3 ? 1 : count >= 2 ? 1.2 : 1.5) * boost;

  const [px, py] = perp(sourceX, sourceY, targetX, targetY);
  const waypoints = (data?.waypoints ?? []) as Waypoint[];
  const hasWaypoints = waypoints.length > 0;
  const paths: string[] = [];
  let labelX = 0;
  let labelY = 0;

  for (let i = 0; i < offsets.length; i++) {
    const d = offsets[i];
    let path: string;
    let lx: number;
    let ly: number;
    if (hasWaypoints) {
      // Route through the user's waypoints as a smooth spline. The per-channel
      // perpendicular offset is applied to EVERY point so parallel multi-channel
      // lines stay parallel. An explicit route overrides the color-circle radial
      // exit — routing intent wins over the socket's natural exit tangent.
      const pts: Array<[number, number]> = [
        [sourceX + d * px, sourceY + d * py],
        ...waypoints.map((w) => [w.x + d * px, w.y + d * py] as [number, number]),
        [targetX + d * px, targetY + d * py],
      ];
      path = splinePath(pts);
      const mid = pts[Math.floor(pts.length / 2)];
      lx = mid[0];
      ly = mid[1];
    } else if (radial) {
      [path, lx, ly] = getRadialBezierPath({
        sourceX: sourceX + d * px,
        sourceY: sourceY + d * py,
        radial,
        targetX: targetX + d * px,
        targetY: targetY + d * py,
        targetPosition,
      });
    } else {
      [path, lx, ly] = getBezierPath({
        sourceX: sourceX + d * px,
        sourceY: sourceY + d * py,
        sourcePosition,
        targetX: targetX + d * px,
        targetY: targetY + d * py,
        targetPosition,
      });
    }
    paths.push(path);
    if (i === Math.floor(offsets.length / 2)) {
      labelX = lx;
      labelY = ly;
    }
  }

  // Center path for the invisible interaction hit area
  const centerPath = hasWaypoints
    ? splinePath([
        [sourceX, sourceY],
        ...waypoints.map((w) => [w.x, w.y] as [number, number]),
        [targetX, targetY],
      ])
    : radial
      ? getRadialBezierPath({ sourceX, sourceY, radial, targetX, targetY, targetPosition })[0]
      : getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })[0];

  const dragStart = useRef<{ x: number; y: number; pointerId: number } | null>(null);

  const onInteractionDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return; // Only left click
    dragStart.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    (e.target as SVGElement).setPointerCapture(e.pointerId);
  };

  const onInteractionMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    if (Math.hypot(dx, dy) > 5) {
      const clientX = e.clientX;
      const clientY = e.clientY;
      dragStart.current = null;
      (e.target as SVGElement).releasePointerCapture(e.pointerId);

      // Remove edge (disconnect from input)
      const store = useAppStore.getState();
      store.pushHistory();
      store.setEdges(
        store.edges.filter((edge) => edge.id !== id) as typeof store.edges,
      );

      // Set flag so NodeEditor won't open AddNodeMenu when this drops on empty space
      setEdgeDisconnecting(true);

      // Start a new connection from the source handle so user can reconnect
      requestAnimationFrame(() => {
        const handleEl = document.querySelector(
          `.react-flow__handle[data-handleid="${sourceHandleId ?? 'out'}"][data-nodeid="${source}"]`,
        );
        if (handleEl) {
          handleEl.dispatchEvent(new MouseEvent('mousedown', {
            clientX,
            clientY,
            bubbles: true,
            cancelable: true,
          }));
        }
      });
    }
  };

  const onInteractionUp = () => {
    dragStart.current = null;
  };

  return (
    <>
      {/* Invisible wide hit area — drag to disconnect, click to select */}
      <path
        d={centerPath}
        className="react-flow__edge-interaction"
        onPointerDown={onInteractionDown}
        onPointerMove={onInteractionMove}
        onPointerUp={onInteractionUp}
      />
      {paths.map((path, i) => {
        const lineColor = channelColors[i];
        return (
          <path
            key={i}
            d={path}
            fill="none"
            stroke={lineColor}
            strokeWidth={strokeWidth}
            strokeDasharray={count > 1 ? '4 0.5' : undefined}
            opacity={selected ? 1 : 0.9}
            style={{ pointerEvents: 'none' }}
          />
        );
      })}
      {hasWaypoints && (
        <EdgeWaypointHandles edgeId={id} waypoints={waypoints} bgColor={nodeEditorBgColor} />
      )}
      {selected && (
        <EdgeLabelRenderer>
          <EdgeInfoCard
            sourceId={logicalSource}
            sourceHandle={logicalSourceHandle}
            targetId={logicalTarget}
            labelX={labelX}
            labelY={labelY}
          />
        </EdgeLabelRenderer>
      )}
    </>
  );
}

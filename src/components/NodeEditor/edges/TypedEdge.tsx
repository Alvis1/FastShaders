import { useCallback, useRef, useState, type CSSProperties } from 'react';
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
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/store/useAppStore';
import { COUNT_EDGE_COLORS, getContrastColor } from '@/utils/colorUtils';
import { setEdgeDisconnecting } from '@/utils/edgeDisconnectFlag';
import { evaluateEdgeSource, getEdgeOutputShape, getLiveUpstreamSet, getUnwrappedEdge } from '@/engine/cpuEvaluator';
import {
  ARROW_FLARE,
  arrowMarks,
  catmullRomToBeziers,
  chevronPath,
  edgeBezier,
  ribbonHalfWidth,
  ribbonNormal,
  ribbonOffsets,
  ribbonStrokeWidth,
  splinePath,
} from './bezierGeometry';
import { handleEl, nodeEl } from '../nodeElement';
import { removeEdgeWaypoint } from './edgeWaypoints';
import { EdgeInfoCard } from './EdgeInfoCard';

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
    removeEdgeWaypoint(edgeId, index);
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

/**
 * How much a HOVERED wire thickens. Less than a selected one, and that gap is
 * the point: hover says "this is the wire under your pointer", selection says
 * "this is the wire you are working on and its data is open". If the two
 * matched, sweeping the canvas would look like it was selecting everything it
 * passed — the same distinction the nodes draw between a passing state and a
 * committed one.
 *
 * Scales the whole ribbon like the selected boost, never the stroke alone:
 * multi-channel lines sit RIBBON_GAP apart and are already up to 1.2px wide, so
 * thickening strokes on their own would close those gaps and fuse a 4-channel
 * ribbon into one band — the highlight would destroy the channel count it is
 * highlighting.
 */
export const HOVER_EDGE_BOOST = 1.35;

/** A selected wire simply gets THICKER — no shadow, no glow, no colour change.
 *
 *  Deliberately NOT the elevation shadow the node cards use: a wire is a line,
 *  not a plate, so an offset copy of it is just another line, and at any offset
 *  large enough to see it stops reading as that wire's shadow and starts
 *  reading as a second wire beside it. Weight is the property a line actually
 *  has to spend.
 *
 *  The boost scales the WHOLE ribbon — both the stroke width and the
 *  per-channel perpendicular offsets (see ribbonOffsets) — rather than the stroke
 *  alone. Multi-channel lines sit RIBBON_GAP (1.167px) apart and are already up to
 *  1.2px wide, so thickening the strokes on their own would close those gaps
 *  and fuse a 4-channel ribbon into one solid band: the selection highlight
 *  would destroy the channel count it is highlighting. Scaling both keeps the
 *  ribbon geometrically similar, just bigger. */
export const SELECTED_EDGE_BOOST = 1.8;

/**
 * Added to the channel count (1–4) when the wire is LIVE: its source changes
 * on its own (fed by Time or Sound, `getLiveUpstreamSet`). A live wire keeps
 * React Flow's marching ants (`.animated`); a STILL one is drawn solid, its
 * paths tagged `fs-edge-still` and styled STILL_PATH_STYLE (the dash and the
 * march off), with direction chevrons along it. Owner, 2026-10-11: "marching only
 * animated". An idle canvas then repaints nothing — every marching SVG path
 * forced Chrome's layerization pass every frame (a static 150-node graph:
 * ~7 ms/frame at 1x for 280 marching paths, ~0.3 with none).
 */
const LIVE_BIT = 8;

/**
 * The drawn paths' inline styles — never a pointer target (the hit path is).
 * A STILL path also opts out of React Flow's `.react-flow__edge.animated path`
 * dash and march HERE, inline, rather than in a stylesheet: every edge is
 * stored `animated: true`, an inline declaration beats that rule wherever
 * TypedEdge is drawn, and it is drawn where no `.node-editor` ancestor and no
 * NodeEditor.css exist — node-editor.html's GraphModal, whose still wires and
 * chevrons kept dashing and marching under a CSS opt-out scoped to the canvas.
 * Module constants, so a render allocates neither.
 */
const LIVE_PATH_STYLE: CSSProperties = { pointerEvents: 'none' };
const STILL_PATH_STYLE: CSSProperties = { pointerEvents: 'none', strokeDasharray: 'none', animation: 'none' };

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
  const { sourceX: sx, sourceY: sy, radial, targetX: tx, targetY: ty, targetPosition } = params;
  // Source control: RF's formula projected onto the radial exit axis, with a
  // small floor so the perpendicular exit stays readable even when the target
  // sits beside/behind the socket; target control: exactly RF's. The ONE
  // curve the drop-on-edge hit test and the chevrons also measure.
  const [, , c1x, c1y, c2x, c2y] = edgeBezier(sx, sy, radial, tx, ty, targetPosition);
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
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps<AppEdge>) {
  const nodeEditorBgColor = useAppStore((s) => s.nodeEditorBgColor);
  /**
   * Is the pointer over THIS wire? Local state rather than a hovered-edge id in
   * the store: only this component reads it, and a global one would re-render
   * every edge on every hover to tell all but one of them nothing.
   *
   * `pointerleave` and not `pointerout`, so moving between the hit path's own
   * children could not read as leaving; and it is cleared on pointerdown-driven
   * disconnects too, because the hit path is replaced mid-gesture there.
   */
  const [hovered, setHovered] = useState(false);

  // Endpoints are used exactly as React Flow reports them — nodes no longer
  // move when lifted (NodeBase.css), so there is nothing to compensate.

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
  // Resolved only while SELECTED: the info card is the one reader, and every
  // edge runs this selector on every store notify.
  const logical = useAppStore(
    useShallow((s) => {
      if (!selected) return null;
      const un = getUnwrappedEdge(s.nodes, s.edges, id);
      return {
        source: un?.source ?? source,
        target: un?.target ?? target,
        // The socket the wire really leaves — the same one the ribbon counts.
        sourceHandle: un?.sourceHandle ?? sourceHandleId ?? null,
      };
    }),
  );

  // Taking max means each path catches the gaps of the other.
  // Computed IN the selector: the shared evaluator ctx makes both calls cache
  // hits per graph version, and the primitive result means a store notify
  // whose count is unchanged (every drag pointermove) bails before re-render.
  // The LIVE flag rides the same primitive (+LIVE_BIT) rather than a second
  // per-edge subscription.
  const packed = useAppStore((s) => {
    // Both the source AND its handle come off the UNWRAPPED edge, never React
    // Flow's `sourceHandleId` prop: unwrapCollapsedGroupEdges rewrites the
    // handle too, and a collapsed group's synthetic socket id matches no
    // registry port — the projection would silently fall back to the whole
    // vector and draw a plausible-looking, wrong-width ribbon. The same real
    // source is what makes a Time feeder inside a collapsed frame count.
    const un = getUnwrappedEdge(s.nodes, s.edges, id);
    const e = { source: un?.source ?? source, sourceHandle: un?.sourceHandle ?? sourceHandleId };
    const evaluated = evaluateEdgeSource(e, s.nodes, s.edges, 0);
    const evalLen = evaluated?.length ?? 0;
    const shapeLen = getEdgeOutputShape(e, s.nodes, s.edges);
    const width = Math.min(Math.max(evalLen, shapeLen, 1), 4);
    return width + (getLiveUpstreamSet(s.nodes, s.edges).has(e.source) ? LIVE_BIT : 0);
  });
  const count = packed % LIVE_BIT;
  const live = packed >= LIVE_BIT;
  // 1-channel edges flip black ↔ white so they remain visible against the
  // user-picked canvas background. Multi-channel edges keep their RGB(A)
  // colors — those already read against any background. A still wire's
  // chevrons are drawn in that same canvas ink: a single wire's own colour,
  // and on a ribbon the one colour that reads across all of its lines.
  const ink = getContrastColor(nodeEditorBgColor);
  const channelColors =
    count === 1
      ? [ink]
      : COUNT_EDGE_COLORS[count] ?? COUNT_EDGE_COLORS[1];
  // Thinner lines when more channels; a selected edge scales the whole ribbon
  // (widths AND offsets, see SELECTED_EDGE_BOOST) so it reads as the same wire,
  // drawn heavier. Previously only the 1-channel case thickened, which left a
  // selected multi-channel edge marked by nothing but an opacity nudge.
  const boost = selected ? SELECTED_EDGE_BOOST : hovered ? HOVER_EDGE_BOOST : 1;
  const offsets = ribbonOffsets(count).map((d) => d * boost);
  const strokeWidth = ribbonStrokeWidth(count) * boost;

  const [px, py] = ribbonNormal(sourceX, sourceY, targetX, targetY);
  const waypoints = (data?.waypoints ?? []) as Waypoint[];
  const hasWaypoints = waypoints.length > 0;
  const paths: string[] = [];

  for (let i = 0; i < offsets.length; i++) {
    const d = offsets[i];
    let path: string;
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
    } else if (radial) {
      [path] = getRadialBezierPath({
        sourceX: sourceX + d * px,
        sourceY: sourceY + d * py,
        radial,
        targetX: targetX + d * px,
        targetY: targetY + d * py,
        targetPosition,
      });
    } else {
      [path] = getBezierPath({
        sourceX: sourceX + d * px,
        sourceY: sourceY + d * py,
        sourcePosition,
        targetX: targetX + d * px,
        targetY: targetY + d * py,
        targetPosition,
      });
    }
    paths.push(path);
  }

  // Center path for the invisible interaction hit area
  const centerPts: Array<[number, number]> | null = hasWaypoints
    ? [
        [sourceX, sourceY],
        ...waypoints.map((w) => [w.x, w.y] as [number, number]),
        [targetX, targetY],
      ]
    : null;
  const centerPath = centerPts
    ? splinePath(centerPts)
    : radial
      ? getRadialBezierPath({ sourceX, sourceY, radial, targetX, targetY, targetPosition })[0]
      : getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })[0];

  // A STILL wire's direction chevrons: on the CENTRELINE, measured along the
  // same curve the hit test measures (bezierGeometry), sized to the ribbon and
  // scaled by the same boost, so a selected or hovered wire's arrows grow with
  // it. ONE path element per edge however many chevrons it carries.
  // The same centreline also anchors the value chip (EdgeInfoCard).
  const centerSegs = centerPts
    ? catmullRomToBeziers(centerPts)
    : [edgeBezier(sourceX, sourceY, radial ?? sourcePosition, targetX, targetY, targetPosition)];
  const arrows = live
    ? ''
    : chevronPath(arrowMarks(centerSegs), (ribbonHalfWidth(count) + ARROW_FLARE) * boost);

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

      // The wire is being pulled OFF its port: it is no longer a thing the
      // pointer is resting on, and the hit path it was hovering is about to be
      // replaced by the connection line.
      setHovered(false);
      // Start a new connection from the source handle so user can reconnect
      // (The escaped one-copy selectors: ids come out of `.fastshader` files.)
      requestAnimationFrame(() => {
        handleEl(nodeEl(source), 'source', sourceHandleId ?? 'out')?.dispatchEvent(new MouseEvent('mousedown', {
          clientX,
          clientY,
          bubbles: true,
          cancelable: true,
        }));
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
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      />
      {paths.map((path, i) => {
        const lineColor = channelColors[i];
        return (
          <path
            key={i}
            d={path}
            className={live ? undefined : 'fs-edge-still'}
            fill="none"
            stroke={lineColor}
            strokeWidth={strokeWidth}
            opacity={selected ? 1 : 0.9}
            style={live ? LIVE_PATH_STYLE : STILL_PATH_STYLE}
          />
        );
      })}
      {arrows && (
        <path
          d={arrows}
          className="fs-edge-still fs-edge-arrows"
          fill="none"
          stroke={ink}
          strokeWidth={ribbonStrokeWidth(1) * boost}
          strokeLinecap="round"
          opacity={selected ? 1 : 0.9}
          style={STILL_PATH_STYLE}
        />
      )}
      {hasWaypoints && (
        <EdgeWaypointHandles edgeId={id} waypoints={waypoints} bgColor={nodeEditorBgColor} />
      )}
      {logical && (
        <EdgeLabelRenderer>
          <EdgeInfoCard
            sourceId={logical.source}
            sourceHandle={logical.sourceHandle}
            targetId={logical.target}
            segs={centerSegs}
          />
        </EdgeLabelRenderer>
      )}
    </>
  );
}

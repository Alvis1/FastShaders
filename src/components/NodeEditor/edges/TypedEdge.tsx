import { useCallback, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  useStore as useReactFlowStore,
  type EdgeProps,
  type ReactFlowState,
} from '@xyflow/react';
import type { AppEdge } from '@/types';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/store/useAppStore';
import { COUNT_EDGE_COLORS, canvasWireColor } from '@/utils/colorUtils';
import { setEdgeDisconnecting } from '@/utils/edgeDisconnectFlag';
import { diveKeyOf, useDiveHost } from './portalDive';
import {
  evaluateEdgeSource,
  getEdgeOutputShape,
  getFoldedWireSource,
  getLiveUpstreamSet,
  getUnwrappedEdge,
} from '@/engine/cpuEvaluator';
import {
  ARROW_FLARE,
  arrowMarks,
  chevronPath,
  DIVE_END_X,
  DIVE_END_Y,
  edgeBezier,
  portalDive,
  ribbonHalfWidth,
  ribbonNormal,
  ribbonOffsets,
  ribbonStrokeWidth,
  segmentsPath,
  type BezierSegment,
} from './bezierGeometry';
import { handleEl, nodeEl } from '../nodeElement';
import { EdgeInfoCard } from './EdgeInfoCard';
import { TUNNEL_HANDLE, TUNNEL_SIZE } from '../nodes/passThroughGeometry';

/**
 * A wire DIVES into a Portal's hole (owner, 2026-11-24: "let the edge dive in
 * the hole", with a sketch of the wire running on over the rim and down into
 * it). Every wire draws UNDER every node (NodeEditor.css), so the part over
 * the hole is drawn a second time INSIDE that Portal end's own card — its
 * hole's dive host (portalDive.ts, registered by TunnelNode) — the SAME
 * channel lines, masked to the hole's disc and fading toward the deep end.
 * Inside the card it paints where the card paints: over the hole, and under
 * every card that covers the hole (a layer one z-step above the node layer
 * painted over a group member dropped on it). The host rides the hole's own
 * `scale`, so the copy's disc is the hole's in every state: outside it the
 * wire is drawn once (no darker band), inside it once (no gap). The copy is
 * `react-flow__edge animated` like the wire itself, so a live wire marches and
 * the drop highlight (`data-fs-dive`) thickens it; Preview mode's dim is the
 * card's (PassThroughNode.css). The chevrons are never copied: no arrow is
 * drawn over a hole. Never a pointer target.
 *
 * `centre` is the hole's centre in flow px: the socket is centred in the hole,
 * so React Flow's anchor is half a socket from it (`TUNNEL_HANDLE`); the host's
 * origin is the card's top-left, half a hole from the centre.
 */
function PortalDive({
  host,
  centre,
  deep,
  edgeId,
  selected,
  children,
}: {
  host: HTMLElement;
  centre: { x: number; y: number };
  /** The dive's deep end, where the wire has faded out. */
  deep: { x: number; y: number };
  edgeId: string;
  selected: boolean;
  children: ReactNode;
}) {
  // One mask per dive; React's id, stripped to the characters a `url(#…)`
  // reference can always carry.
  const id = `fs-dive-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  // The hole's own radius, rim included: the host grows with the hole.
  const r = TUNNEL_SIZE / 2;
  return createPortal(
    <svg className="fs-edge-dive" aria-hidden="true" focusable="false">
      {/* Flow coordinates, moved to the card's own: its top-left is the origin. */}
      <g transform={`translate(${r - centre.x},${r - centre.y})`}>
        <defs>
          <radialGradient id={`${id}-g`} gradientUnits="userSpaceOnUse" cx={deep.x} cy={deep.y} r={r * 0.95}>
            <stop offset="0" stopColor="#000" />
            <stop offset="1" stopColor="#fff" />
          </radialGradient>
          <mask id={`${id}-m`} maskUnits="userSpaceOnUse" x={centre.x - r} y={centre.y - r} width={2 * r} height={2 * r}>
            <circle cx={centre.x} cy={centre.y} r={r} fill={`url(#${id}-g)`} />
          </mask>
        </defs>
        <g
          className={`react-flow__edge animated${selected ? ' selected' : ''}`}
          data-fs-dive={edgeId}
          mask={`url(#${id}-m)`}
        >
          {children}
        </g>
      </g>
    </svg>,
    host,
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
      // A wire INTO a Branch/Portal In is folded away: read what it carries.
      const via = un ? null : getFoldedWireSource(s.nodes, s.edges, id);
      return {
        source: un?.source ?? via?.source ?? source,
        target: un?.target ?? target,
        // The socket the wire really leaves — the same one the ribbon counts.
        sourceHandle: un?.sourceHandle ?? via?.sourceHandle ?? sourceHandleId ?? null,
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
    // A wire INTO a Branch or Portal In is not in the fold (the engines read
    // past it), so it is resolved on its own: a Branch → Branch wire carries
    // the first Branch's feeder, never the Branch itself (one black channel).
    const via = un ? null : getFoldedWireSource(s.nodes, s.edges, id);
    const e = un
      ? { source: un.source, sourceHandle: un.sourceHandle }
      : via ?? { source, sourceHandle: sourceHandleId };
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
  const ink = canvasWireColor(nodeEditorBgColor);
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
  const paths: string[] = [];

  // Does the wire end in a Portal In's hole, or start in a Portal Out's? Then
  // it DIVES into it (PortalDive), drawn inside that end's card. One PRIMITIVE
  // per edge ('i' / 'o' / both / '', portalDive.ts `diveKeyOf`), so a drag
  // frame re-renders nothing for it; a wire hidden in a collapsed group
  // (`fs-collapsed-edge`) dives nowhere — its hole is not drawn either. The
  // class is read as data: a file's edge `className` may be no string.
  const diveKey = useReactFlowStore(
    useCallback(
      (s: ReactFlowState): string =>
        diveKeyOf(s.edgeLookup.get(id)?.className, s.nodeLookup.get(source)?.type, s.nodeLookup.get(target)?.type),
      [id, source, target],
    ),
  );
  const diveIn = diveKey.includes('i');
  const diveOut = diveKey.includes('o');
  const inHost = useDiveHost(diveIn ? target : null);
  const outHost = useDiveHost(diveOut ? source : null);
  const holeR = TUNNEL_SIZE / 2;
  const inCentre = diveIn ? { x: targetX + TUNNEL_HANDLE / 2, y: targetY } : null;
  const outCentre = diveOut ? { x: sourceX - TUNNEL_HANDLE / 2, y: sourceY } : null;

  for (let i = 0; i < offsets.length; i++) {
    const d = offsets[i];
    let path: string;
    if (inCentre || outCentre) {
      // The wire's own curve, plus the dive at each portal end — every point
      // shifted by the channel's offset, so the ribbon stays parallel.
      const ox = d * px;
      const oy = d * py;
      const segs: BezierSegment[] = [];
      if (outCentre) segs.push(portalDive('out', sourceX + ox, sourceY + oy, outCentre.x + ox, outCentre.y + oy, holeR));
      segs.push(edgeBezier(sourceX + ox, sourceY + oy, radial ?? sourcePosition, targetX + ox, targetY + oy, targetPosition));
      if (inCentre) segs.push(portalDive('in', targetX + ox, targetY + oy, inCentre.x + ox, inCentre.y + oy, holeR));
      path = segmentsPath(segs);
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

  // Center path for the invisible interaction hit area — the wire's own
  // curve, never the dive (a press inside a hole belongs to the node).
  const centerPath = radial
    ? getRadialBezierPath({ sourceX, sourceY, radial, targetX, targetY, targetPosition })[0]
    : getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })[0];

  // A STILL wire's direction chevrons: on the CENTRELINE, measured along the
  // same curve the hit test measures (bezierGeometry), sized to the ribbon and
  // scaled by the same boost, so a selected or hovered wire's arrows grow with
  // it. ONE path element per edge however many chevrons it carries.
  // The same centreline also anchors the value chip (EdgeInfoCard).
  const centerSegs = [edgeBezier(sourceX, sourceY, radial ?? sourcePosition, targetX, targetY, targetPosition)];
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

  // The drawn wire's channel lines. Rendered in the edge layer and, for a
  // portal end, once more inside the hole (PortalDive) — the lines alone: a
  // still wire's chevrons stay in the edge layer, so no arrow is ever drawn
  // over a hole (where the wire loops across it, the hole hides them).
  const lines = paths.map((path, i) => (
    <path
      key={i}
      d={path}
      className={live ? undefined : 'fs-edge-still'}
      fill="none"
      stroke={channelColors[i]}
      strokeWidth={strokeWidth}
      opacity={selected ? 1 : 0.9}
      style={live ? LIVE_PATH_STYLE : STILL_PATH_STYLE}
    />
  ));

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
      {lines}
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
      {inCentre && inHost && (
        <PortalDive
          host={inHost}
          centre={inCentre}
          deep={{ x: inCentre.x + DIVE_END_X * holeR, y: inCentre.y + DIVE_END_Y * holeR }}
          edgeId={id}
          selected={!!selected}
        >
          {lines}
        </PortalDive>
      )}
      {outCentre && outHost && (
        <PortalDive
          host={outHost}
          centre={outCentre}
          deep={{ x: outCentre.x - DIVE_END_X * holeR, y: outCentre.y + DIVE_END_Y * holeR }}
          edgeId={id}
          selected={!!selected}
        >
          {lines}
        </PortalDive>
      )}
      {logical && (
        <EdgeLabelRenderer>
          <EdgeInfoCard
            edgeId={id}
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

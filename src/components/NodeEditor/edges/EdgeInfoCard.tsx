import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useStore as useReactFlowStore, type ReactFlowState } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { COUNT_CARD_COLORS, COUNT_LABELS } from '@/utils/colorUtils';
import { appTime } from '@/utils/appClock';
import { useFrameLoop } from '@/hooks/useFrameLoop';
import { evaluateEdgeRange, getEdgeOutputShape, getTimeUpstreamSet, type RangeResult } from '@/engine/cpuEvaluator';
import { visibleArcMidpoint, type BezierSegment } from './bezierGeometry';
import './EdgeInfoCard.css';

/** Screen px kept clear between the chip's anchor and the canvas border, so a
 *  wire running off-screen keeps its chip readable rather than half-cut. */
const VIEW_INSET_PX = 28;

/**
 * The chip's anchor for the current viewport, as a primitive "x,y" string
 * (flow coordinates, 0.1 px) — or '' when no part of the wire is on screen.
 * Computed IN the React Flow selector so a pan that leaves the anchor where
 * it is (a wire wholly on screen) re-renders nothing.
 */
function anchorFor(segs: readonly BezierSegment[], s: ReactFlowState): string {
  const [tx, ty, zoom] = s.transform;
  const inset = VIEW_INSET_PX / (zoom || 1);
  const x0 = -tx / zoom, y0 = -ty / zoom;
  const x1 = (s.width - tx) / zoom, y1 = (s.height - ty) / zoom;
  // A canvas too small for the inset clips to its own border instead.
  const full = { x0, y0, x1, y1 };
  const inner = x1 - x0 > 2 * inset && y1 - y0 > 2 * inset
    ? { x0: x0 + inset, y0: y0 + inset, x1: x1 - inset, y1: y1 - inset }
    : full;
  // A wire that shows only inside the inset band anchors there; one wholly
  // off-screen keeps its plain arc midpoint (out of sight either way).
  const m = visibleArcMidpoint(segs, inner)
    ?? visibleArcMidpoint(segs, full)
    ?? visibleArcMidpoint(segs, null);
  return m ? `${Math.round(m[0] * 10) / 10},${Math.round(m[1] * 10) / 10}` : '';
}

/**
 * Same bounds, channel for channel — a tick that would re-render the chip to
 * the numbers it already shows (speed 0, a clamped or settled value) is
 * skipped. Exported for the test.
 */
export function sameRange(a: RangeResult | null, b: RangeResult | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.min.length !== b.min.length || a.max.length !== b.max.length) return false;
  for (let i = 0; i < a.min.length; i++) if (!Object.is(a.min[i], b.min[i])) return false;
  for (let i = 0; i < a.max.length; i++) if (!Object.is(a.max[i], b.max[i])) return false;
  return true;
}

interface EdgeInfoCardProps {
  sourceId: string;
  /** Socket the edge leaves — a multi-output source (HSL h/s/l) must report
   *  the channel THIS wire carries, not the node's whole vector. */
  sourceHandle?: string | null;
  targetId: string;
  /** The wire's centreline. The chip sits at the middle of the part of it
   *  that is ON SCREEN (visibleArcMidpoint), not of the whole curve. */
  segs: readonly BezierSegment[];
}

export function EdgeInfoCard({
  sourceId,
  sourceHandle,
  targetId,
  segs,
}: EdgeInfoCardProps) {
  const anchor = useReactFlowStore((s) => anchorFor(segs, s));
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const sourceNode = nodes.find((n) => n.id === sourceId);
  const targetNode = nodes.find((n) => n.id === targetId);

  const [range, setRange] = useState<RangeResult | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Through the shared ctx, which walks the UNWRAPPED edges: passing the raw
  // store array here (as this did) is the trap getUnwrappedEdges' contract
  // warns about — a Time feeder inside a collapsed group went invisible and
  // the chip froze on its static branch.
  const isTimeDriven = getTimeUpstreamSet(nodes, edges).has(sourceId);

  // Static (non-time-driven) range: recompute once whenever the graph changes.
  useEffect(() => {
    if (isTimeDriven) return;
    setRange(evaluateEdgeRange({ source: sourceId, sourceHandle }, nodes, edges, 0));
  }, [sourceId, sourceHandle, nodes, edges, isTimeDriven]);

  // Animated (time-driven) range, on the shared frame ticker
  // (utils/frameTicker, 15 Hz — the same frames as the labels and cards it
  // describes; skipped while the chip is off-screen). The tick reads fresh
  // graph state from the store, so the deps EXCLUDE nodes/edges — listing them
  // would tear down and re-create the loop on every unrelated drag frame (new
  // array identity). Only the source socket / isTimeDriven change what to
  // animate.
  useFrameLoop(
    isTimeDriven,
    cardRef,
    () => {
      // `t` is the shared app clock — NOT an epoch minted at mount: this card
      // mounts when its wire is selected, so a private clock restarted at ~0
      // every time, and the chip showed sin(0.15) beside a sin card whose own
      // loop was at sin(48.3). All animated surfaces now evaluate the same t
      // per tick and agree.
      const rangeAt = (t: number) => {
        const { nodes: n, edges: e } = useAppStore.getState();
        return evaluateEdgeRange({ source: sourceId, sourceHandle }, n, e, t);
      };
      // The chip mounts on selection: show a value at once rather than "…"
      // for up to one tick. (A plain update — this runs inside the effect,
      // where flushSync cannot commit.)
      let shown = rangeAt(appTime());
      setRange(shown);
      return (t) => {
        const next = rangeAt(t);
        if (sameRange(next, shown)) return;
        shown = next;
        // Commit INSIDE the tick. A plain setState from a frame callback is
        // rendered by React's scheduler in a LATER task, after this frame has
        // painted, so the chip wrote on a frame of its own — 15 extra canvas
        // writes a second, each paying the layerization pass the ticker exists
        // to share (graph-150 with a Time wire selected: 2.5 -> 4.0 ms/frame
        // at 1x, 56% -> 90% busy at 4x).
        flushSync(() => setRange(next));
      };
    },
    [sourceId, sourceHandle, isTimeDriven],
  );

  if (!sourceNode || !targetNode || !anchor) return null;
  const [labelX, labelY] = anchor.split(',');

  // Channel count: prefer the range result's length (it knows about texture-derived
  // shapes), and fall back to static shape inference for nodes the range evaluator
  // couldn't handle (e.g. positionGeometry, length, distance — chains where neither
  // eval nor range propagation works).
  const rangeLen = range?.min.length ?? 0;
  const shapeLen = getEdgeOutputShape({ source: sourceId, sourceHandle }, nodes, edges);
  const count = Math.min(Math.max(rangeLen, shapeLen, 1), 4);
  const labels = COUNT_LABELS[count] ?? [''];
  const colors = COUNT_CARD_COLORS[count] ?? [];
  const isMultiChannel = count > 1;

  // Build display strings per channel:
  //  - degenerate range (min === max) → single number "0.42"
  //  - bounded range → "min…max" (e.g. "0.00…1.00")
  //  - unbounded (Infinity) or no range data → "…" (honest unknown, no guess)
  const PLACEHOLDER = '…';
  const RANGE_EPSILON = 0.005; // values closer than this collapse to a single display
  const formatChannel = (lo: number, hi: number): string => {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return PLACEHOLDER;
    if (Math.abs(hi - lo) < RANGE_EPSILON) return lo.toFixed(2);
    return `${lo.toFixed(2)}…${hi.toFixed(2)}`;
  };
  const displayValues: string[] = [];
  for (let i = 0; i < count; i++) {
    if (range && i < range.min.length) {
      displayValues.push(formatChannel(range.min[i], range.max[i]));
    } else {
      displayValues.push(PLACEHOLDER);
    }
  }

  return (
    <div
      ref={cardRef}
      className="edge-info-card"
      style={{
        transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="edge-info-card__values">
        {displayValues.map((v, i) => (
          <span key={i} className="edge-info-card__channel">
            {isMultiChannel && (
              <span
                className="edge-info-card__label"
                style={colors[i] ? { color: colors[i] } : undefined}
              >
                {labels[i]}
              </span>
            )}
            <span className="edge-info-card__num">{v}</span>
          </span>
        ))}
      </span>
    </div>
  );
}

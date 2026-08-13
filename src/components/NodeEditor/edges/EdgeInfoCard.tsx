import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { COUNT_CARD_COLORS, COUNT_LABELS } from '@/utils/colorUtils';
import { hasTimeUpstream } from '@/utils/graphTraversal';
import { appTime } from '@/utils/appClock';
import { evaluateEdgeRange, getEdgeOutputShape, type RangeResult } from '@/engine/cpuEvaluator';
import './EdgeInfoCard.css';

interface EdgeInfoCardProps {
  sourceId: string;
  /** Socket the edge leaves — a multi-output source (HSL h/s/l) must report
   *  the channel THIS wire carries, not the node's whole vector. */
  sourceHandle?: string | null;
  targetId: string;
  labelX: number;
  labelY: number;
}

export function EdgeInfoCard({
  sourceId,
  sourceHandle,
  targetId,
  labelX,
  labelY,
}: EdgeInfoCardProps) {
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const sourceNode = nodes.find((n) => n.id === sourceId);
  const targetNode = nodes.find((n) => n.id === targetId);

  const [range, setRange] = useState<RangeResult | null>(null);

  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  const isTimeDriven = hasTimeUpstream(sourceId, nodes, edges);

  // Static (non-time-driven) range: recompute once whenever the graph changes.
  useEffect(() => {
    if (isTimeDriven) return;
    setRange(evaluateEdgeRange({ source: sourceId, sourceHandle }, nodes, edges, 0));
  }, [sourceId, sourceHandle, nodes, edges, isTimeDriven]);

  // Animated (time-driven) range: the rAF loop reads fresh graph state via
  // nodesRef/edgesRef, so its deps EXCLUDE nodes/edges — listing them would
  // tear down and re-create the loop on every unrelated drag frame (new array
  // identity). Only sourceId / isTimeDriven actually change what to animate.
  useEffect(() => {
    if (!isTimeDriven) return;
    let rafId: number;

    const tick = (timestamp: number) => {
      // Shared app clock — NOT an epoch minted at mount: this card mounts on
      // hover, so a private clock restarted at ~0 every time the user pointed
      // at the edge, and the chip showed sin(0.15) beside a sin card whose
      // own loop (same private-epoch pattern) was at sin(48.3). All animated
      // surfaces now evaluate the same t per frame and agree.
      const t = appTime(timestamp);
      const next = evaluateEdgeRange({ source: sourceId, sourceHandle }, nodesRef.current, edgesRef.current, t);
      setRange(next);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [sourceId, sourceHandle, isTimeDriven]);

  if (!sourceNode || !targetNode) return null;

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

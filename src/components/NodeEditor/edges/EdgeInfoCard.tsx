import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { COUNT_CARD_COLORS, COUNT_LABELS } from '@/utils/colorUtils';
import { hasTimeUpstream } from '@/utils/graphTraversal';
import { evaluateNodeRange, getNodeOutputShape, type RangeResult } from '@/engine/cpuEvaluator';
import './EdgeInfoCard.css';

interface EdgeInfoCardProps {
  sourceId: string;
  targetId: string;
  labelX: number;
  labelY: number;
}

export function EdgeInfoCard({
  sourceId,
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
    setRange(evaluateNodeRange(sourceId, nodes, edges, 0));
  }, [sourceId, nodes, edges, isTimeDriven]);

  // Animated (time-driven) range: the rAF loop reads fresh graph state via
  // nodesRef/edgesRef, so its deps EXCLUDE nodes/edges — listing them would
  // tear down and re-create the loop on every unrelated drag frame (new array
  // identity). Only sourceId / isTimeDriven actually change what to animate.
  useEffect(() => {
    if (!isTimeDriven) return;
    let rafId: number;
    let startTime: number | null = null;

    const tick = (timestamp: number) => {
      if (startTime === null) startTime = timestamp;
      const t = (timestamp - startTime) / 1000;
      const next = evaluateNodeRange(sourceId, nodesRef.current, edgesRef.current, t);
      setRange(next);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [sourceId, isTimeDriven]);

  if (!sourceNode || !targetNode) return null;

  // Channel count: prefer the range result's length (it knows about texture-derived
  // shapes), and fall back to static shape inference for nodes the range evaluator
  // couldn't handle (e.g. positionGeometry, length, distance — chains where neither
  // eval nor range propagation works).
  const rangeLen = range?.min.length ?? 0;
  const shapeLen = getNodeOutputShape(sourceId, nodes, edges);
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

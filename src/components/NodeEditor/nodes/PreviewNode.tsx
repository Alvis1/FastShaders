import { memo, useEffect, useMemo, useRef } from 'react';
import { Position, useStore, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { makeConnectionRevealSelector, REVEAL_TEMP_OPACITY } from './connectionReveal';
import type { PreviewFlowNode, NodeCategory, AppNode, TSLDataType } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostScale, getCostTextColor, CAT_HEX, getContrastColor } from '@/utils/colorUtils';
import { hasTimeUpstream } from '@/utils/graphTraversal';
import { evaluateNodeScalar } from '@/engine/cpuEvaluator';
import { TypedHandle } from '../handles/TypedHandle';
import { renderNoisePreview, type NoiseType, type TimeInputs } from '@/utils/noisePreview';
import './PreviewNode.css';

const PREVIEW_SIZE = 96;
/** Registry types this preview node can render — all MaterialX noise variants. */
const NOISE_TYPES = new Set<string>([
  'perlin', 'perlinVec3',
  'fbm', 'fbmVec3',
  'cellNoise',
  'voronoi', 'voronoiVec2', 'voronoiVec3',
]);

/** Distribute handles evenly along the side, centered. */
function handleTop(index: number, total: number): string {
  if (total === 1) return '50%';
  const start = 25;
  const end = 75;
  const step = (end - start) / (total - 1);
  return `${start + index * step}%`;
}

/** For each input port of a node, check whether time feeds into it. */
function getTimeInputs(
  nodeId: string,
  nodes: AppNode[],
  edges: { source: string; target: string; targetHandle?: string | null }[],
): TimeInputs {
  const result: TimeInputs = {};
  // Find edges that connect into this node, grouped by target handle
  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    const handle = edge.targetHandle;
    if (!handle) continue;
    if (hasTimeUpstream(edge.source, nodes, edges)) {
      (result as Record<string, boolean>)[handle] = true;
    }
  }
  return result;
}

export const PreviewNode = memo(function PreviewNode({
  id,
  data,
  selected,
}: NodeProps<PreviewFlowNode>) {
  const def = NODE_REGISTRY.get(data.registryType);
  if (!def) return null;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const varName = useAppStore((s) => s.nodeVarNames[id]);
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const updateNodeInternals = useUpdateNodeInternals();

  // An approaching wire reveals ALL param sockets (names on their tooltips)
  // so any parameter can be wired without a menu round-trip; landing the
  // connection makes the exposure permanent (onConnect auto-expose).
  const revealHidden = useStore(
    useMemo(() => makeConnectionRevealSelector(id, true), [id]),
  );
  // Param sockets = permanently exposed ports, plus (while revealing) every
  // exposable param from the registry defaults. Temporary ones render dimmed.
  const exposedList = data.exposedPorts ?? [];
  const paramPorts = useMemo(() => {
    if (!revealHidden) return exposedList;
    const all = new Set([...exposedList, ...Object.keys(def.defaultValues ?? {})]);
    return Array.from(all);
  }, [revealHidden, exposedList.join('|'), def]);

  // Tell React Flow to re-measure handles whenever the RENDERED port set
  // changes (settings toggle, auto-attach, or the drag reveal). Without this,
  // dynamically mounted handles aren't in React Flow's bounds map, so edges
  // connected to them silently fail to render until a full re-measure.
  const exposedKey = paramPorts.join('|');
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, exposedKey, updateNodeInternals]);

  // getTimeInputs walks the graph per incoming edge (BFS), so memoize it on the
  // graph identity instead of recomputing on every render. The JSON.stringify
  // key then stabilizes the *reference* when the resolved set is unchanged, so
  // effects keyed on `timeInputs` don't re-fire just because nodes/edges got a
  // new array identity (intentional idiom — see CLAUDE.md).
  const timeInputsRaw = useMemo(() => getTimeInputs(id, nodes, edges), [id, nodes, edges]);
  const timeInputsKey = JSON.stringify(timeInputsRaw);
  const timeInputs = useMemo(() => timeInputsRaw, [timeInputsKey]);
  const hasAnyTime = Object.values(timeInputs).some(Boolean);

  const catHex = CAT_HEX[def.category as NodeCategory] ?? CAT_HEX.unknown;
  const costColor = getCostColor(data.cost, costColorLow, costColorHigh);
  const headerTextColor = getContrastColor(costColor);
  const costTextColor = getCostTextColor(data.cost, costColorLow, costColorHigh);
  const costScale = getCostScale(data.cost);

  // Snapshot nodes/edges for use inside rAF (avoid stale closures)
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  /** Resolve each scalar input: connected edge → evaluate upstream, else → data.values fallback. */
  const resolveValues = (
    currentNodes: AppNode[],
    currentEdges: typeof edges,
    time: number,
  ): Record<string, string | number> => {
    const resolved: Record<string, string | number> = { ...data.values };
    for (const edge of currentEdges) {
      if (edge.target !== id) continue;
      const handle = edge.targetHandle;
      if (!handle) continue;
      const val = evaluateNodeScalar(edge.source, currentNodes, currentEdges, time);
      if (val !== null) resolved[handle] = val;
    }
    return resolved;
  };

  // Static (non-time-driven) noise preview: one-shot render. It legitimately
  // depends on nodes/edges so the thumbnail refreshes when an upstream value
  // changes, but it's a plain putImageData — no rAF loop to tear down.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !NOISE_TYPES.has(data.registryType) || hasAnyTime) return;
    // willReadFrequently keeps these canvases CPU-backed (both effects): an
    // accelerated canvas layer makes Safari rasterize the zoomed viewport at
    // 1× and stretch the bitmap — every node goes blurry.
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const resolved = resolveValues(nodes, edges, 0);
    const imageData = renderNoisePreview(data.registryType as NoiseType, PREVIEW_SIZE, resolved, 0, {});
    ctx.putImageData(imageData, 0, 0);
  }, [data.registryType, data.values, nodes, edges, hasAnyTime]);

  // Animated (time-driven) noise preview: the rAF loop reads fresh graph state
  // via nodesRef/edgesRef, so its deps deliberately EXCLUDE nodes/edges —
  // otherwise the loop would tear down and re-subscribe on every unrelated drag
  // frame (each of which gives nodes/edges a new array identity). The remaining
  // deps (registryType, the stabilized timeInputs, this node's own values) are
  // all stable across unrelated drags.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !NOISE_TYPES.has(data.registryType) || !hasAnyTime) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    let rafId: number;
    let startTime: number | null = null;

    const draw = (timestamp: number) => {
      if (startTime === null) startTime = timestamp;
      const t = (timestamp - startTime) / 1000;

      const resolved = resolveValues(nodesRef.current, edgesRef.current, t);
      const imageData = renderNoisePreview(
        data.registryType as NoiseType,
        PREVIEW_SIZE,
        resolved,
        t,
        timeInputs,
      );
      ctx.putImageData(imageData, 0, 0);
      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [data.registryType, data.values, hasAnyTime, timeInputs]);

  return (
    <div
      className={`node-base preview-node ${selected ? 'node-base--selected' : ''}`}
      style={{ background: 'var(--node-bg)', border: `1.5px solid ${catHex}`, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {/* Cost badge above node */}
      {data.cost > 0 && <span className="node-base__cost-badge" style={{ color: costTextColor }}>{data.cost}</span>}

      {/* Header */}
      <div className="node-base__header" style={{ background: costColor }}>
        <span className="node-base__title" style={{ color: headerTextColor }}>{varName ?? data.label}</span>
      </div>

      {/* Preview canvas */}
      <div className="preview-node__canvas-wrap">
        <canvas
          ref={canvasRef}
          width={PREVIEW_SIZE}
          height={PREVIEW_SIZE}
          className="preview-node__canvas"
        />
      </div>

      {/* Input handles — static + exposed dynamic ports on left side (plus,
          while a wire is nearby, every hidden param — dimmed — so the drag
          can snap to it). During the reveal EVERY input socket forces its
          name-tooltip visible, floated left of the dot, so the user can read
          each target while aiming (`reveal` prop). */}
      {(() => {
        const exposedSet = new Set(exposedList);
        const allInputs = [
          ...def.inputs.map((p) => ({ id: p.id, dataType: p.dataType, label: p.label, temp: false })),
          ...paramPorts.map((key) => ({
            id: key,
            dataType: (key === 'pos' ? 'vec3' : 'float') as TSLDataType,
            label: key,
            temp: !exposedSet.has(key),
          })),
        ];
        return allInputs.map((input, i) => (
          <TypedHandle
            key={input.id}
            type="target"
            position={Position.Left}
            id={input.id}
            dataType={input.dataType}
            label={input.label}
            reveal={revealHidden}
            style={{
              top: handleTop(i, allInputs.length),
              ...(input.temp ? { opacity: REVEAL_TEMP_OPACITY } : null),
            }}
          />
        ));
      })()}

      {/* Output handles — centered on right side */}
      {def.outputs.map((output, i) => (
        <TypedHandle
          key={output.id}
          type="source"
          position={Position.Right}
          id={output.id}
          dataType={output.dataType}
          label={output.label}
          style={{ top: handleTop(i, def.outputs.length) }}
        />
      ))}
    </div>
  );
});

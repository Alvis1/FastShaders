import { memo, useEffect, useRef } from 'react';
import { Position, type NodeProps } from '@xyflow/react';
import type { PreviewFlowNode, NodeCategory, AppNode } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostScale } from '@/utils/colorUtils';
import { hasTimeUpstream } from '@/utils/graphTraversal';
import { evaluateNodeScalar } from '@/engine/cpuEvaluator';
import { TypedHandle } from '../handles/TypedHandle';
import { CATEGORY_COLORS } from './ShaderNode';
import { renderNoisePreview, type NoiseType, type TimeInputs } from '@/utils/noisePreview';
import './PreviewNode.css';

const PREVIEW_SIZE = 96;
const NOISE_TYPES = new Set(['noise', 'fractal', 'voronoi']);

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

  const timeInputs = getTimeInputs(id, nodes, edges);
  const hasAnyTime = Object.values(timeInputs).some(Boolean);

  const catColor = CATEGORY_COLORS[def.category as NodeCategory] ?? 'var(--type-any)';
  const costColor = getCostColor(data.cost);
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

  // Render noise preview — resolve upstream inputs via CPU evaluator
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !NOISE_TYPES.has(data.registryType)) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (!hasAnyTime) {
      // Static render — resolve upstream values once
      const resolved = resolveValues(nodes, edges, 0);
      const imageData = renderNoisePreview(
        data.registryType as NoiseType,
        PREVIEW_SIZE,
        resolved,
        0,
        {},
      );
      ctx.putImageData(imageData, 0, 0);
      return;
    }

    // Animated render — evaluate upstream each frame
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
  }, [data.registryType, data.values, nodes, edges, hasAnyTime, timeInputs.pos, timeInputs.octaves, timeInputs.lacunarity, timeInputs.diminish]);

  return (
    <div
      className={`node-base preview-node ${selected ? 'node-base--selected' : ''}`}
      style={{ background: costColor, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {/* Cost badge above node */}
      {data.cost > 0 && <span className="node-base__cost-badge">{data.cost}</span>}

      {/* Header */}
      <div className="node-base__header" style={{ borderLeft: `3px solid ${catColor}` }}>
        <span className="node-base__title">{data.label}</span>
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

      {/* Input handles — centered on left side */}
      {def.inputs.map((input, i) => (
        <TypedHandle
          key={input.id}
          type="target"
          position={Position.Left}
          id={input.id}
          dataType={input.dataType}
          style={{ top: handleTop(i, def.inputs.length) }}
        />
      ))}

      {/* Output handles — centered on right side */}
      {def.outputs.map((output, i) => (
        <TypedHandle
          key={output.id}
          type="source"
          position={Position.Right}
          id={output.id}
          dataType={output.dataType}
          style={{ top: handleTop(i, def.outputs.length) }}
        />
      ))}
    </div>
  );
});

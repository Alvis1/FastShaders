import { memo, useEffect, useRef, useCallback } from 'react';
import { Position, type NodeProps } from '@xyflow/react';
import type { MathPreviewFlowNode, NodeCategory, AppNode } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostScale } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { CATEGORY_COLORS } from './ShaderNode';
import { renderMathPreview } from '@/utils/mathPreview';
import { evaluateNodeScalar } from '@/engine/cpuEvaluator';
import './MathPreviewNode.css';

const CANVAS_SIZE = 72;

/** Map registryType to its math function. */
const MATH_FUNCTIONS: Record<string, (x: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
};

/** Walk upstream to check if a Time node is an ancestor. */
function hasTimeUpstream(
  nodeId: string,
  nodes: AppNode[],
  edges: { source: string; target: string }[],
): boolean {
  const visited = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const node = nodes.find((n) => n.id === current);
    if (node && node.data.registryType === 'time') return true;
    for (const edge of edges) {
      if (edge.target === current && !visited.has(edge.source)) {
        queue.push(edge.source);
      }
    }
  }
  return false;
}

export const MathPreviewNode = memo(function MathPreviewNode({
  id,
  data,
  selected,
}: NodeProps<MathPreviewFlowNode>) {
  const def = NODE_REGISTRY.get(data.registryType);
  if (!def) return null;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const updateNodeData = useAppStore((s) => s.updateNodeData);

  const func = MATH_FUNCTIONS[data.registryType] ?? Math.sin;
  const catColor = CATEGORY_COLORS[def.category as NodeCategory] ?? 'var(--type-any)';
  const costColor = getCostColor(data.cost);
  const costScale = getCostScale(data.cost);

  // Check if the X input has an edge connected
  const xEdge = edges.find((e) => e.target === id && e.targetHandle === 'x');
  const hasConnection = !!xEdge;
  const hasTime = hasConnection && hasTimeUpstream(xEdge.source, nodes, edges);

  const accentColor = '#6C63FF';
  const inputX = Number(data.values?.x ?? 0);

  // Snapshot nodes/edges for use inside rAF (avoid stale closures)
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // Render waveform
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (hasTime) {
      // Animated: use CPU evaluator to get the actual input value
      let rafId: number;
      let startTime: number | null = null;

      const draw = (timestamp: number) => {
        if (startTime === null) startTime = timestamp;
        const t = (timestamp - startTime) / 1000;

        // Evaluate the actual input flowing into this node's X port
        // by walking the upstream graph with the current time
        const xSource = xEdge!.source;
        const evaluated = evaluateNodeScalar(xSource, nodesRef.current, edgesRef.current, t);
        const inputVal = evaluated ?? t;

        renderMathPreview(ctx, {
          func,
          width: CANVAS_SIZE,
          height: CANVAS_SIZE,
          phase: inputVal,
          accentColor,
          inputValue: inputVal,
          funcLabel: data.registryType,
        });
        rafId = requestAnimationFrame(draw);
      };

      rafId = requestAnimationFrame(draw);
      return () => cancelAnimationFrame(rafId);
    } else {
      // Static: show value at current input X — curve shifts, dot stays centered
      renderMathPreview(ctx, {
        func,
        width: CANVAS_SIZE,
        height: CANVAS_SIZE,
        phase: hasConnection ? 0 : inputX,
        accentColor,
        inputValue: hasConnection ? null : inputX,
        funcLabel: data.registryType,
      });
    }
  }, [data.registryType, data.values, hasTime, hasConnection, func, accentColor, inputX, xEdge]);

  const handleXChange = useCallback(
    (v: number) => {
      updateNodeData(id, {
        values: { ...data.values, x: v },
      } as Partial<MathPreviewFlowNode['data']>);
    },
    [id, data.values, updateNodeData],
  );

  return (
    <div
      className={`node-base math-preview-node ${selected ? 'node-base--selected' : ''}`}
      style={{ background: costColor, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {/* Header */}
      <div className="node-base__header">
        <span className="node-base__dot" style={{ background: catColor }} />
        <span className="node-base__title">{data.label}</span>
        <span className="node-base__cost">{data.cost}</span>
      </div>

      {/* Waveform canvas */}
      <div className="math-preview-node__canvas-wrap">
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          className="math-preview-node__canvas"
        />
      </div>

      {/* Input port row at bottom */}
      <div className="math-preview-node__port-row">
        <div className="math-preview-node__left">
          {def.inputs[0] && (
            <TypedHandle
              type="target"
              position={Position.Left}
              id={def.inputs[0].id}
              dataType={def.inputs[0].dataType}
            />
          )}
          {def.inputs[0] && (
            <span className="node-base__port-label">{def.inputs[0].label}</span>
          )}
          {!hasConnection && (
            <DragNumberInput
              compact
              value={inputX}
              onChange={handleXChange}
            />
          )}
        </div>
      </div>

      {/* Output handle — vertically centered on node */}
      {def.outputs[0] && (
        <TypedHandle
          type="source"
          position={Position.Right}
          id={def.outputs[0].id}
          dataType={def.outputs[0].dataType}
          style={{ top: '50%' }}
        />
      )}
    </div>
  );
});

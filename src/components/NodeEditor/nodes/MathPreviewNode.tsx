import { memo, useEffect, useRef, useCallback } from 'react';
import { Position, type NodeProps } from '@xyflow/react';
import type { MathPreviewFlowNode, NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostScale, getCostTextColor } from '@/utils/colorUtils';
import { hasTimeUpstream } from '@/utils/graphTraversal';
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
  const varName = useAppStore((s) => s.nodeVarNames[id]);
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);

  const func = MATH_FUNCTIONS[data.registryType] ?? Math.sin;
  const catColor = CATEGORY_COLORS[def.category as NodeCategory] ?? 'var(--type-any)';
  const costColor = getCostColor(data.cost, costColorLow, costColorHigh);
  const costTextColor = getCostTextColor(data.cost, costColorLow, costColorHigh);
  const costScale = getCostScale(data.cost);

  // Check if the X input has an edge connected
  const xEdge = edges.find((e) => e.target === id && e.targetHandle === 'x');
  const hasConnection = !!xEdge;
  const hasTime = !!xEdge && hasTimeUpstream(xEdge.source, nodes, edges);

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
      {/* Cost badge above node */}
      {data.cost > 0 && <span className="node-base__cost-badge" style={{ color: costTextColor }}>{data.cost}</span>}

      {/* Header */}
      <div className="node-base__header" style={{ borderLeft: `3px solid ${catColor}` }}>
        <span className="node-base__title">{varName ?? data.label}</span>
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
              label={def.inputs[0].label}
            />
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
          label={def.outputs[0].label}
          style={{ top: '50%' }}
        />
      )}
    </div>
  );
});

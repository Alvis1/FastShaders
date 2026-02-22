import { memo, useEffect, useRef } from 'react';
import { Position, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode, NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostScale, getCostTextColor } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import { CATEGORY_COLORS } from './ShaderNode';
import './ClockNode.css';

const CLOCK_SIZE = 56;

export const ClockNode = memo(function ClockNode({
  id,
  data,
  selected,
}: NodeProps<ShaderFlowNode>) {
  const def = NODE_REGISTRY.get(data.registryType);
  if (!def) return null;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const varName = useAppStore((s) => s.nodeVarNames[id]);
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const catColor = CATEGORY_COLORS[def.category as NodeCategory] ?? 'var(--type-any)';
  const costColor = getCostColor(data.cost, costColorLow, costColorHigh);
  const costTextColor = getCostTextColor(data.cost, costColorLow, costColorHigh);
  const costScale = getCostScale(data.cost);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const size = CLOCK_SIZE;
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 4;

    let rafId: number;
    const draw = () => {
      const now = Date.now() / 1000;
      ctx.clearRect(0, 0, size, size);

      // Clock face
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#ccc';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Hour marks
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
        const inner = r - 4;
        const outer = r - 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
        ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
        ctx.strokeStyle = '#999';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Seconds hand
      const secAngle = (now % 60) / 60 * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(secAngle) * (r - 6), cy + Math.sin(secAngle) * (r - 6));
      ctx.strokeStyle = '#e74c3c';
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.stroke();

      // Center dot
      ctx.beginPath();
      ctx.arc(cx, cy, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#e74c3c';
      ctx.fill();

      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div
      className={`node-base clock-node ${selected ? 'node-base--selected' : ''}`}
      style={{ background: costColor, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {data.cost > 0 && <span className="node-base__cost-badge" style={{ color: costTextColor }}>{data.cost}</span>}

      <div className="node-base__header" style={{ borderLeft: `3px solid ${catColor}` }}>
        <span className="node-base__title">{varName ?? data.label}</span>
      </div>

      <div className="clock-node__canvas-wrap">
        <canvas
          ref={canvasRef}
          width={CLOCK_SIZE}
          height={CLOCK_SIZE}
          className="clock-node__canvas"
        />
      </div>

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

import { memo, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { Position, useStore, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode, NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostScale, getCostTextColor, CAT_HEX, getContrastColor } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import { makeConnectionRevealSelector, REVEAL_TEMP_OPACITY } from './connectionReveal';
import './ClockNode.css';

const CLOCK_SIZE = 56;

/**
 * Label for the speed chip. A fixed 2-decimal rounding would print "×0" for a
 * slow-motion 0.001 — claiming time is frozen while the shader still animates —
 * so small magnitudes keep enough significant digits to stay truthful, and only
 * a genuine 0 reads as "×0". Trailing zeros are dropped (1.5 not 1.50).
 */
function formatSpeed(speed: number): string {
  if (speed === 0) return '0';
  const decimals = Math.abs(speed) < 0.01 ? 4 : 2;
  const rounded = Number(speed.toFixed(decimals));
  // Still rounds away below 1e-4 — fall back to exponent form rather than lie.
  return rounded === 0 ? speed.toExponential(0) : String(rounded);
}

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
  const catHex = CAT_HEX[def.category as NodeCategory] ?? CAT_HEX.unknown;
  const costColor = getCostColor(data.cost, costColorLow, costColorHigh);
  const headerTextColor = getContrastColor(costColor);
  const costTextColor = getCostTextColor(data.cost, costColorLow, costColorHigh);
  const costScale = getCostScale(data.cost);

  // Speed multiplier (Node Settings → speed). Adversarial input: a missing key,
  // a string, NaN or ±Infinity must all read as 1x — and with a phase
  // accumulator a single NaN would poison the hand permanently.
  const rawSpeed = Number(data.values?.speed);
  const speed = Number.isFinite(rawSpeed) ? rawSpeed : 1;

  // `speed` is an opt-in parameter socket, exactly like the noise nodes'
  // pos/scale: hidden until ticked in Node Settings, revealed (dimmed) while a
  // wire is dragged nearby, and made permanent when a connection lands.
  const updateNodeInternals = useUpdateNodeInternals();
  const revealHidden = useStore(
    useMemo(() => makeConnectionRevealSelector(id, true), [id]),
  );
  const speedExposed = (data.exposedPorts ?? []).includes('speed');
  const showSpeedPort = speedExposed || revealHidden;
  // React Flow only knows a handle's bounds once it has re-measured, so a
  // dynamically mounted socket needs this or edges into it don't render.
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, showSpeedPort, updateNodeInternals]);
  // A wired speed overrides the stored number (the codegen rule), so the chip
  // would be lying about a value the shader no longer uses.
  const speedWired = useStore(
    useMemo(
      () => (s: { edges: { target: string; targetHandle?: string | null }[] }) =>
        s.edges.some((e) => e.target === id && e.targetHandle === 'speed'),
      [id],
    ),
  );
  // Ride a ref so a live speed edit is picked up WITHOUT restarting the rAF
  // loop (a restart would reset the phase and jump the hand).
  const speedRef = useRef(speed);
  speedRef.current = speed;
  // Shader-time seconds, wrapped to (-60, 60). Integrating the RATE — rather
  // than scaling a wall-clock reading — is what keeps the hand continuous while
  // the user scrubs speed: DragNumberInput fires onChange every pointermove
  // frame, and `Date.now() / 1000 * speed` lands on an unrelated `% 60` residue
  // for each of those values.
  const phaseRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // willReadFrequently keeps the canvas CPU-backed: an accelerated canvas
    // layer makes Safari rasterize the zoomed viewport at 1× (all-node blur).
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const size = CLOCK_SIZE;
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 4;

    let rafId: number;
    let last: number | null = null;
    const draw = (ts: number) => {
      if (last === null) last = ts;
      // Clamp dt: a backgrounded tab hands back a multi-second delta on resume,
      // which at a high multiplier would spin the hand through hundreds of turns.
      const dt = Math.min(Math.max((ts - last) / 1000, 0), 0.1);
      last = ts;
      phaseRef.current = (phaseRef.current + dt * speedRef.current) % 60;
      const now = phaseRef.current;
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
    // Deps stay [] on purpose — speed rides speedRef, so the loop never restarts
    // and the hand's phase survives a scrub.
  }, []);

  return (
    <div
      className={`node-base clock-node ${selected ? 'node-base--selected' : ''}`}
      style={{ background: 'var(--node-bg)', border: `1.5px solid ${catHex}`, transform: `scale(${costScale})`, transformOrigin: 'top left', '--node-cat': catHex } as CSSProperties}
    >
      {data.cost > 0 && <span className="node-base__cost-badge" style={{ color: costTextColor }}>{data.cost}</span>}

      <div className="node-base__header" style={{ background: costColor }}>
        <span className="node-base__title" style={{ color: headerTextColor }}>{varName ?? data.label}</span>
      </div>

      <div className="clock-node__canvas-wrap">
        <canvas
          ref={canvasRef}
          width={CLOCK_SIZE}
          height={CLOCK_SIZE}
          className="clock-node__canvas"
        />
      </div>

      {speed !== 1 && !speedWired && (
        <span className="clock-node__speed">×{formatSpeed(speed)}</span>
      )}

      {showSpeedPort && (
        <TypedHandle
          type="target"
          position={Position.Left}
          id="speed"
          dataType="float"
          label="speed"
          reveal={revealHidden}
          style={{ top: '50%', ...(speedExposed ? null : { opacity: REVEAL_TEMP_OPACITY }) }}
        />
      )}

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

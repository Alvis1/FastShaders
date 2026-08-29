import { memo, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { Position, useStore, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode, NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostScale, getCostTextColor, CAT_HEX, getContrastColor } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { makeConnectionRevealSelector, REVEAL_TEMP_OPACITY } from './connectionReveal';
import { ClockFaceSvg, applyClockFrame } from './ClockFaceSvg';
import { LiveEdgeValue } from './LiveEdgeValue';
import { portLabel } from '@/i18n';
// One rule for "what is arriving on this input", shared with ShaderNode/MicNode
// (whose stylesheet also owns .shader-node__edge-val).
import { edgeValueLabel } from './ShaderNode';
// getTargetEdges, NOT raw s.edges — same reason as MicNode/OutputNode: the
// unwrapped edge names the REAL producer, so a feeder inside a collapsed group
// still shows its number instead of a grey ellipsis.
import { getTargetEdges } from '@/engine/cpuEvaluator';
import './ClockNode.css';
import { NODE_BORDER_WIDTH } from './nodeFrame';

// (`formatSpeed` lived here to render the read-only `×N` chip without printing
// "×0" for a slow-motion 0.001. The speed is an editable DragNumberInput now,
// which shows the stored number itself, so there is nothing left to round.)

export const ClockNode = memo(function ClockNode({
  id,
  data,
  selected,
}: NodeProps<ShaderFlowNode>) {
  const def = NODE_REGISTRY.get(data.registryType);
  // Rules-of-Hooks note: this return sits ABOVE the hooks below. Safe because
  // `def` cannot flip defined<->undefined on a MOUNTED instance: React Flow keys
  // node components by node.id, every registryType the app writes is in
  // NODE_REGISTRY (`unknown` included), and nothing mutates registryType in place
  // to or from an unregistered value. A tampered .fastshader with an unknown
  // registryType renders null for the whole life of that node. Moving the return
  // below the hooks is NOT a mechanical edit here (ShaderNode/PreviewNode hooks
  // dereference `def`) — see CLEAN-3.
  if (!def) return null;

  const handRef = useRef<SVGGElement>(null);
  const varName = useAppStore((s) => s.nodeVarNames[id]);
  const language = useAppStore((s) => s.language);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
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
  // A wired speed overrides the stored number (the codegen rule), so the row
  // must stop offering to edit it and show the value ARRIVING instead — the
  // same label ShaderNode and MicNode put on a connected input. Cheap string
  // key first so a position-only graph notify bails on Object.is; the map is
  // rebuilt from getState() only when that key actually changes.
  const speedEdgeKey = useAppStore((s) => {
    const e = getTargetEdges(s.nodes, s.edges, id).find((ed) => ed.targetHandle === 'speed');
    if (!e) return '';
    const l = edgeValueLabel(e.source, s.nodes, s.edges, e.sourceHandle);
    return `${e.source} ${e.sourceHandle ?? ''} ${l.text} ${l.live ? 1 : 0}${l.animated ? 1 : 0}`;
  });
  const wiredSpeed = useMemo(() => {
    if (!speedEdgeKey) return null;
    const { nodes, edges } = useAppStore.getState();
    const e = getTargetEdges(nodes, edges, id).find((ed) => ed.targetHandle === 'speed');
    return e ? { ...edgeValueLabel(e.source, nodes, edges, e.sourceHandle), sourceId: e.source, sourceHandle: e.sourceHandle ?? null } : null;
    // speedEdgeKey is the change signal; the graph is read imperatively above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, speedEdgeKey]);
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
    let rafId: number;
    // `last` is a dt tracker for the integrator, NOT a clock epoch — this
    // hand deliberately does NOT read the shared appClock: it shows the RATE
    // time flows at, and integrating dt × speed is what keeps it continuous
    // while the user scrubs speed (a wall-clock × speed lands on an unrelated
    // % 60 residue every pointermove frame — the hand would teleport).
    let last: number | null = null;
    const draw = (ts: number) => {
      if (last === null) last = ts;
      // Clamp dt: a backgrounded tab hands back a multi-second delta on resume,
      // which at a high multiplier would spin the hand through hundreds of turns.
      const dt = Math.min(Math.max((ts - last) / 1000, 0), 0.1);
      last = ts;
      phaseRef.current = (phaseRef.current + dt * speedRef.current) % 60;
      // One rotate-transform write per frame — the face itself is the shared
      // ClockFaceSvg (geometry in utils/clockFace), so the asset tile shows
      // the identical picture.
      applyClockFrame(handRef, phaseRef.current);
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
      style={{ background: 'var(--node-bg)', border: `${NODE_BORDER_WIDTH} solid ${catHex}`, transform: `scale(${costScale})`, transformOrigin: 'top left' } as CSSProperties}
    >
      {data.cost > 0 && <span className="node-base__cost-badge" style={{ color: costTextColor }}>{data.cost}</span>}

      <div className="node-base__header" style={{ background: costColor }}>
        <span className="node-base__title" title={varName ?? data.label} style={{ color: headerTextColor }}>{varName ?? data.label}</span>
      </div>

      {/* The sockets live INSIDE this wrapper so they centre on the clock face
          rather than on the whole node — see ClockNode.css. */}
      <div className="clock-node__canvas-wrap">
        <ClockFaceSvg phase={0} handRef={handRef} />

        {def.outputs[0] && (
          <TypedHandle
            type="source"
            position={Position.Right}
            id={def.outputs[0].id}
            dataType={def.outputs[0].dataType}
            label={def.outputs[0].label}
          />
        )}
      </div>

      {/* Speed multiplier, always visible and editable — the node's only
          setting should not be invisible at its default value. The `speed`
          SOCKET lives here rather than beside the clock face: it feeds this
          value, so it belongs on this row. */}
      <div className="clock-node__speed-row" title={portLabel('Speed', language)}>
        <span className="clock-node__speed-x">×</span>
        {wiredSpeed ? (
          <LiveEdgeValue className="clock-node__speed-wired shader-node__edge-val" {...wiredSpeed} />
        ) : (
          <DragNumberInput
            compact
            value={speed}
            onChange={(v) => updateNodeData(id, { values: { ...data.values, speed: String(v) } })}
          />
        )}

        {showSpeedPort && (
          <TypedHandle
            type="target"
            position={Position.Left}
            id="speed"
            dataType="float"
            label="speed"
            reveal={revealHidden}
            style={speedExposed ? undefined : { opacity: REVEAL_TEMP_OPACITY }}
          />
        )}
      </div>
    </div>
  );
});

import { memo, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { Position, useStore, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode, NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { valueNum } from '@/utils/valueCoerce';
import { useAppStore } from '@/store/useAppStore';
import { CAT_HEX } from '@/utils/colorUtils';
import { Points } from '@/components/Points/Points';
import { useCostChrome, useLiveNodeCost, useRemeasureOnScale } from './useCostChrome';
import { TypedHandle } from '../handles/TypedHandle';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { makeConnectionRevealSelector, REVEAL_TEMP_OPACITY } from './connectionReveal';
import { ClockFaceSvg, applyClockFrame } from './ClockFaceSvg';
import { LiveEdgeValue } from './LiveEdgeValue';
import { portLabel } from '@/i18n';
import { NodeTitle } from './NodeTitle';
import { useHeaderTip } from './headerTip';
// One rule for "what is arriving on this input", shared with ShaderNode/SoundNode
// (whose stylesheet also owns .shader-node__edge-val).
import { edgeValueLabel } from './ShaderNode';
// getTargetEdges, NOT raw s.edges — same reason as SoundNode/OutputNode: the
// unwrapped edge names the REAL producer, so a feeder inside a collapsed group
// still shows its number instead of a grey ellipsis.
import { getTargetEdges } from '@/engine/cpuEvaluator';
import { useFrameLoop } from '@/hooks/useFrameLoop';
import './ClockNode.css';
import { NODE_BORDER_WIDTH } from './nodeFrame';

/** Largest dt (s) one hand tick may integrate — see the clamp below. */
const MAX_HAND_DT = 0.25;

export const ClockNode = memo(function ClockNode({
  id,
  data,
  selected,
}: NodeProps<ShaderFlowNode>) {
  const def = NODE_REGISTRY.get(data.registryType);
  // Early return above the hooks is safe: React Flow keys node components by id
  // and registryType never changes on a mounted node.
  if (!def) return null;
  const headerTip = useHeaderTip(def);

  const handRef = useRef<SVGGElement>(null);
  // The element whose visibility gates the hand's tick (the face's wrapper,
  // which lives as long as the card).
  const faceRef = useRef<HTMLDivElement>(null);
  const varName = useAppStore((s) => s.nodeVarNames[id]);
  const language = useAppStore((s) => s.language);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const catHex = CAT_HEX[def.category as NodeCategory] ?? CAT_HEX.unknown;
  // Priced LIVE under the selected device's table, never the creation-time
  // `data.cost` snapshot (useLiveNodeCost says why). Time is 0 in the shipped
  // table, so the badge shows only under a profile that prices it.
  const cost = useLiveNodeCost(id, data);
  const { costColor, headerTextColor, costTextColor, costScale, points } = useCostChrome(cost);
  useRemeasureOnScale(id, costScale);

  // Speed multiplier (Node Settings → speed). Adversarial input: a missing key,
  // a string, NaN or ±Infinity must all read as 1x — and with a phase
  // accumulator a single NaN would poison the hand permanently.
  const rawSpeed = valueNum(data.values?.speed);
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
  // same label ShaderNode and SoundNode put on a connected input. Cheap string
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
  // Ride a ref so a live speed edit is picked up WITHOUT restarting the frame
  // loop (a restart would reset the phase and jump the hand).
  const speedRef = useRef(speed);
  speedRef.current = speed;
  // Shader-time seconds, wrapped to (-60, 60). Integrating the RATE — rather
  // than scaling a wall-clock reading — is what keeps the hand continuous while
  // the user scrubs speed: DragNumberInput fires onChange every pointermove
  // frame, and `Date.now() / 1000 * speed` lands on an unrelated `% 60` residue
  // for each of those values.
  const phaseRef = useRef(0);
  // The integrator's dt tracker — the shared app-clock reading of the last
  // tick, NOT an epoch: the hand shows the RATE time flows at, and
  // integrating dt × speed is what keeps it continuous while the user scrubs
  // speed (app time × speed lands on an unrelated % 60 residue every
  // pointermove frame — the hand would teleport). A ref, because the hidden
  // callback below must move it too.
  const lastTRef = useRef<number | null>(null);

  // On the shared frame ticker (utils/frameTicker, 15 Hz), so the hand steps
  // on the same frames as every other animated surface.
  useFrameLoop(
    true,
    faceRef,
    () => {
      lastTRef.current = null;
      // Last phase actually WRITTEN to the hand, so a fixed point of the
      // integrator costs nothing. At speed 0 — a real setting, since the
      // number is editable on the node — `dt * 0` leaves the phase alone, so
      // the identical rotate() string was being written every frame forever.
      let drawnPhase: number | null = null;
      return (t) => {
        const last = lastTRef.current ?? t;
        lastTRef.current = t;
        // Clamp dt: a backgrounded tab hands back a multi-second delta on
        // resume, which at a high multiplier would spin the hand through
        // hundreds of turns. The bound sits well above one tick (66.7 ms), so
        // a loaded machine ticking late still integrates its true dt.
        const dt = Math.min(Math.max(t - last, 0), MAX_HAND_DT);
        phaseRef.current = (phaseRef.current + dt * speedRef.current) % 60;
        // One rotate-transform write per tick — the face itself is the shared
        // ClockFaceSvg (geometry in utils/clockFace), so the asset tile shows
        // the identical picture. Compare the PHASE rather than the formatted
        // angle: it is the integrator's own state, so speed 0 is an exact
        // no-op, and it costs one number compare otherwise.
        if (phaseRef.current !== drawnPhase) {
          drawnPhase = phaseRef.current;
          applyClockFrame(handRef, phaseRef.current);
        }
      };
    },
    // Deps stay [] on purpose — speed rides speedRef, so the loop never
    // restarts and the hand's phase survives a scrub.
    [],
    {
      // Off-screen or collapsed away: keep the dt tracker moving across the
      // invisible span, so the hand simply resumes where it stopped — it
      // shows the RATE time flows at, not absolute time — and the first
      // visible tick gets an honest dt rather than one the clamp has to
      // flatten.
      onHidden: (t) => { lastTRef.current = t; },
    },
  );

  return (
    <div
      className={`node-base clock-node ${selected ? 'node-base--selected' : ''}`}
      style={{ background: 'var(--node-bg)', border: `${NODE_BORDER_WIDTH} solid ${catHex}`, transform: `scale(${costScale})`, transformOrigin: 'top left' } as CSSProperties}
    >
      {cost > 0 && <span className="node-base__cost-badge" style={{ color: costTextColor }}><Points value={points} /></span>}

      <div className="node-base__header" style={{ background: costColor }} {...headerTip}>
        <NodeTitle text={varName ?? data.label} style={{ color: headerTextColor }} bare={headerTip !== null} />
      </div>

      {/* The sockets live INSIDE this wrapper so they centre on the clock face
          rather than on the whole node — see ClockNode.css. */}
      <div className="clock-node__canvas-wrap" ref={faceRef}>
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

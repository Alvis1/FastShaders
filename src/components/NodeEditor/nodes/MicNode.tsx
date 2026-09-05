import { memo, useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import { Position, useStore, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode, NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostScale, getCostTextColor, CAT_HEX, getContrastColor } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { makeConnectionRevealSelector, REVEAL_TEMP_OPACITY } from './connectionReveal';
import { MicNodeButton } from './MicNodeButton';
import { NodeTitle } from './NodeTitle';
// One label rule for "what is arriving on this input", shared with ShaderNode
// (whose stylesheet also owns .shader-node__edge-val and the arm light).
import { edgeValueLabel } from './ShaderNode';
import { LiveEdgeValue } from './LiveEdgeValue';
// getTargetEdges, NOT raw s.edges: it returns UNWRAPPED edges, so a feeder
// inside a collapsed group reports its REAL producer. The raw boundary edge's
// source is the GROUP id, which has no registry def, so edgeValueLabel would
// degrade every wired param to a grey ellipsis the moment the group collapses
// (the trap documented at getTargetEdges' definition; same reason as
// OutputNode.tsx:85-90).
import { getTargetEdges } from '@/engine/cpuEvaluator';
import { MIC_DEFAULT_VALUES } from '@/utils/micNode';
import { readMicLevels, micArmIntent, subscribeMic, getMicStatus } from '@/utils/micSession';
import { portLabel } from '@/i18n';
import {
  MIC_BODY_W,
  MIC_BODY_H,
  MIC_PARAM_TOPS,
  MIC_CHIP_H,
  MIC_METER_TOP,
  MIC_METER_H,
  MIC_BTN_TOP,
  MIC_OUT_TOPS,
  MIC_PAD_X,
} from './micGeometry';
import './MicNode.css';
import { NODE_BORDER_WIDTH } from './nodeFrame';

/**
 * The Mic node — its own React Flow component rather than a ShaderNode.
 *
 * WHY: ShaderNode derives socket positions from in-flow ROWS, so the layout is
 * whatever the row helper produces — which is why this node kept fighting it
 * (settings paired with outputs by index, and filtering inputs to the exposed
 * ones re-flowed the whole card). Every node that looks deliberate — Time, the
 * noise family — is a component like this one: header plus fixed content, with
 * every handle ABSOLUTELY POSITIONED at a chosen offset. Nothing a socket does
 * can then move anything else.
 *
 * Geometry lives in micGeometry.ts — shared with the asset-browser tile and
 * the auto-layout footprint, so a redesign here can't strand a stale replica.
 */

export const MicNode = memo(function MicNode({ id, data, selected }: NodeProps<ShaderFlowNode>) {
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

  // Opt-in parameter sockets, same rules as the noise nodes' pos/scale: hidden
  // until ticked in Node Settings, revealed dimmed while a wire is dragged
  // nearby, permanent once a connection lands.
  const updateNodeInternals = useUpdateNodeInternals();
  const revealHidden = useStore(useMemo(() => makeConnectionRevealSelector(id, true), [id]));
  const exposed = useMemo(() => new Set(data.exposedPorts ?? []), [data.exposedPorts]);

  // Params that currently carry an edge, AND the value arriving on each. A
  // wired value overrides the stored number (the codegen rule), so the chip
  // must not keep offering to edit it — but it used to say the literal word
  // "wired", which tells you less than the wire itself already did. Show the
  // NUMBER instead, through the exact label ShaderNode puts on a connected
  // input (live value, inferred `min…max` range, or `…` when underivable).
  //
  // Same two-step selector ShaderNode uses: subscribe to a cheap STRING key so
  // a position-only graph notify bails on Object.is, then rebuild the map from
  // getState() only when that key actually changed.
  const edgeKey = useAppStore((s) => {
    let key = '';
    for (const e of getTargetEdges(s.nodes, s.edges, id)) {
      if (typeof e.targetHandle !== 'string') continue;
      const l = edgeValueLabel(e.source, s.nodes, s.edges, e.sourceHandle);
      key += `${e.targetHandle}\u0000${e.sourceHandle ?? ''}\u0000${l.text}\u0000${l.live ? 1 : 0}${l.animated ? 1 : 0}\u0001`;
    }
    return key;
  });
  const wiredLabels = useMemo(() => {
    const { nodes, edges } = useAppStore.getState();
    const m = new Map<string, { text: string; live: boolean; animated: boolean; sourceId: string; sourceHandle: string | null }>();
    for (const e of getTargetEdges(nodes, edges, id)) {
      if (typeof e.targetHandle !== 'string') continue;
      m.set(e.targetHandle, { ...edgeValueLabel(e.source, nodes, edges, e.sourceHandle), sourceId: e.source, sourceHandle: e.sourceHandle ?? null });
    }
    return m;
    // edgeKey is the change signal; nodes/edges are read imperatively above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, edgeKey]);

  // React Flow only knows a handle's bounds after a re-measure, so a socket
  // that mounts on exposure needs this or edges into it never render.
  const mountedKey = [...exposed].sort().join(',') + (revealHidden ? '|R' : '');
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, mountedKey, updateNodeInternals]);

  // Live input level, drawn on the node itself. Reads `readMicLevels()` off the
  // session rather than being fed by the preview's pump: the session is a
  // module singleton in the parent document, so the meter keeps working while
  // the shader is mid-rebuild — and the node can answer "is it hearing
  // anything?" without the preview panel being open at all.
  const status = useSyncExternalStore(subscribeMic, getMicStatus, getMicStatus);
  const meterRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = meterRef.current;
      if (!el) return;
      // Idle costs one branch per frame — cheaper and far less error-prone than
      // tearing an rAF loop up and down around a permission prompt.
      const v = micArmIntent() ? readMicLevels().level : 0;
      // scaleX rather than width: transform-only, so the compositor handles it
      // and a 60 Hz meter never triggers layout inside the viewport.
      el.style.transform = `scaleX(${v.toFixed(3)})`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={`node-base mic-node ${selected ? 'node-base--selected' : ''}`}
      style={
        {
          background: 'var(--node-bg)',
          border: `${NODE_BORDER_WIDTH} solid ${catHex}`,
          transform: `scale(${costScale})`,
          transformOrigin: 'top left',
        } as CSSProperties
      }
    >
      {data.cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{data.cost}</span>
      )}

      <div className="node-base__header" style={{ background: costColor }}>
        <NodeTitle text={varName ?? data.label} style={{ color: headerTextColor }} />
      </div>

      <div className="mic-node__body" style={{ width: MIC_BODY_W, height: MIC_BODY_H }}>
        {def.inputs.map((inp, i) => {
          const show = exposed.has(inp.id) || revealHidden;
          const wiredInfo = wiredLabels.get(inp.id);
          const top = MIC_PARAM_TOPS[i] ?? MIC_PARAM_TOPS[MIC_PARAM_TOPS.length - 1];
          return (
            <div key={inp.id}>
              {show && (
                <TypedHandle
                  type="target"
                  position={Position.Left}
                  id={inp.id}
                  dataType={inp.dataType}
                  label={inp.label}
                  reveal={revealHidden}
                  style={{
                    top,
                    ...(exposed.has(inp.id) ? null : { opacity: REVEAL_TEMP_OPACITY }),
                  }}
                />
              )}
              {/* title = the same label the socket tooltip shows (through the
                  same portLabel i18n lookup), so a bare number box is still
                  identifiable without exposing the port. */}
              <div
                className="mic-node__val"
                style={{ top, height: MIC_CHIP_H, left: MIC_PAD_X, right: MIC_PAD_X }}
                title={portLabel(inp.label ?? inp.id, language)}
              >
                {wiredInfo ? (
                  // Read-only, so PLAIN TEXT with no plate — the same rule that
                  // separates derived from editable everywhere else on a node
                  // (see .shader-node__op-val in ShaderNode.css). Blue marks a
                  // live evaluated value as opposed to an inferred range,
                  // matching ShaderNode's connected-input labels exactly.
                  <LiveEdgeValue className="mic-node__wired shader-node__edge-val" {...wiredInfo} />
                ) : (
                  <DragNumberInput
                    compact
                    value={Number(data.values?.[inp.id] ?? MIC_DEFAULT_VALUES[inp.id] ?? 0)}
                    onChange={(v) => updateNodeData(id, { values: { ...data.values, [inp.id]: String(v) } })}
                  />
                )}
              </div>
            </div>
          );
        })}

        <div
          className={`shader-node__level-meter${status === 'on' ? '' : ' shader-node__level-meter--idle'}`}
          style={{ top: MIC_METER_TOP, height: MIC_METER_H, left: MIC_PAD_X, right: MIC_PAD_X }}
        >
          <span className="shader-node__level-meter-fill" ref={meterRef} />
        </div>

        <div className="mic-node__btn-wrap" style={{ top: MIC_BTN_TOP }}>
          <MicNodeButton nodeId={id} values={data.values} />
        </div>

        {def.outputs.map((out, i) => (
          <TypedHandle
            key={out.id}
            type="source"
            position={Position.Right}
            id={out.id}
            dataType={out.dataType}
            label={out.label}
            style={{ top: MIC_OUT_TOPS[i] ?? MIC_OUT_TOPS[MIC_OUT_TOPS.length - 1] }}
          />
        ))}
      </div>
    </div>
  );
});

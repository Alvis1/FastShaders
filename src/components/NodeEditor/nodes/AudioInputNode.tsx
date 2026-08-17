import { memo, useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import { Position, useStore, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode, NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostScale, getCostTextColor, CAT_HEX, getContrastColor } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { makeConnectionRevealSelector, REVEAL_TEMP_OPACITY } from './connectionReveal';
import { AudioNodeButton } from './AudioNodeButton';
import { AudioSourceSelect } from './AudioSourceSelect';
// One label rule for "what is arriving on this input", shared with ShaderNode
// (whose stylesheet also owns .shader-node__edge-val and the arm light).
import { edgeValueLabel } from './ShaderNode';
import { LiveEdgeValue } from './LiveEdgeValue';
// getTargetEdges, NOT raw s.edges: it returns UNWRAPPED edges, so a feeder
// inside a collapsed group reports its REAL producer. The raw boundary edge's
// source is the GROUP id, which has no registry def, so edgeValueLabel would
// degrade every wired param to a grey ellipsis the moment the group collapses.
import { getTargetEdges } from '@/engine/cpuEvaluator';
import { MIC_DEFAULT_VALUES } from '@/utils/micNode';
import { readAudioLevels, audioArmIntent, subscribeAudio, getAudioStatus } from '@/utils/audioSession';
import { portLabel } from '@/i18n';
import {
  AUD_BODY_W,
  AUD_BODY_H,
  AUD_PARAM_TOPS,
  AUD_CHIP_H,
  AUD_SOURCE_TOP,
  AUD_SOURCE_H,
  AUD_METER_TOP,
  AUD_METER_H,
  AUD_BTN_TOP,
  AUD_OUT_TOPS,
  AUD_PAD_X,
} from './audioGeometry';
import './AudioInputNode.css';

/**
 * The Audio Input node — reacts to sound the machine is already PLAYING.
 *
 * Its own React Flow component for the same reason MicNode is (ShaderNode
 * derives socket positions from in-flow rows, so a card with a dropdown and a
 * meter on it cannot be expressed there), and geometry lives in
 * audioGeometry.ts so the asset tile and the auto-layout footprint cannot hold a
 * stale twin.
 *
 * What is deliberately ON the card rather than in the settings menu: the SOURCE
 * picker and the live level. Both are answers to "what is this node hearing?",
 * and a node whose answer is only visible after a right-click is the problem
 * this node was added to fix.
 */

export const AudioInputNode = memo(function AudioInputNode({ id, data, selected }: NodeProps<ShaderFlowNode>) {
  const def = NODE_REGISTRY.get(data.registryType);
  // Rules-of-Hooks note: this return sits ABOVE the hooks below, exactly as in
  // MicNode.tsx. Safe because `def` cannot flip defined<->undefined on a MOUNTED
  // instance: React Flow keys node components by node.id, every registryType the
  // app writes is in NODE_REGISTRY, and nothing mutates registryType in place to
  // or from an unregistered value.
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

  // Opt-in parameter sockets, same rules as the Mic node's: hidden until ticked
  // in Node Settings, revealed dimmed while a wire is dragged nearby, permanent
  // once a connection lands.
  const updateNodeInternals = useUpdateNodeInternals();
  const revealHidden = useStore(useMemo(() => makeConnectionRevealSelector(id, true), [id]));
  const exposed = useMemo(() => new Set(data.exposedPorts ?? []), [data.exposedPorts]);

  // Params that currently carry an edge, AND the value arriving on each — the
  // same two-step selector ShaderNode and MicNode use: subscribe to a cheap
  // STRING key so a position-only graph notify bails on Object.is, then rebuild
  // the map from getState() only when that key actually changed.
  const edgeKey = useAppStore((s) => {
    let key = '';
    for (const e of getTargetEdges(s.nodes, s.edges, id)) {
      if (typeof e.targetHandle !== 'string') continue;
      const l = edgeValueLabel(e.source, s.nodes, s.edges, e.sourceHandle);
      // NUL/SOH separators written as unicode ESCAPES, never raw bytes: a raw
      // control byte makes the whole FILE binary to grep/rg/sed, so repo-wide
      // searches skip it silently (sourceControlBytes.test.ts). A plain space
      // would not do either - an edge label can be a range like `0 ... 1`.
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

  // The live level meter. Written IMPERATIVELY from an rAF loop — never through
  // React state, which would re-render a canvas node ~60x/s (the rule
  // useMicPump's header states for the preview's own meter, and the same reason
  // PreviewNode and LiveEdgeValue write their DOM directly).
  //
  // This reads `readAudioLevels()` straight from the session rather than being
  // fed by the preview's pump: the session is a module singleton in the parent
  // document, so the node needs nothing from the preview panel to draw a meter —
  // which also means the meter still works when the shader is mid-rebuild.
  const status = useSyncExternalStore(subscribeAudio, getAudioStatus, getAudioStatus);
  const meterRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = meterRef.current;
      if (!el) return;
      // Idle costs one branch per frame — cheaper and far less error-prone than
      // tearing an rAF loop up and down around a permission prompt.
      const v = audioArmIntent() ? readAudioLevels().level : 0;
      // scaleX rather than width: transform-only, so the compositor handles it
      // and a 60 Hz meter never triggers layout inside the viewport.
      el.style.transform = `scaleX(${v.toFixed(3)})`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={`node-base audio-node ${selected ? 'node-base--selected' : ''}`}
      style={
        {
          background: 'var(--node-bg)',
          border: `1.5px solid ${catHex}`,
          transform: `scale(${costScale})`,
          transformOrigin: 'top left',
          '--node-cat': catHex,
        } as CSSProperties
      }
    >
      {data.cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>{data.cost}</span>
      )}

      <div className="node-base__header" style={{ background: costColor }}>
        <span className="node-base__title" title={varName ?? data.label} style={{ color: headerTextColor }}>
          {varName ?? data.label}
        </span>
      </div>

      <div className="audio-node__body" style={{ width: AUD_BODY_W, height: AUD_BODY_H }}>
        {def.inputs.map((inp, i) => {
          const show = exposed.has(inp.id) || revealHidden;
          const wiredInfo = wiredLabels.get(inp.id);
          const top = AUD_PARAM_TOPS[i] ?? AUD_PARAM_TOPS[AUD_PARAM_TOPS.length - 1];
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
                className="audio-node__val"
                style={{ top, height: AUD_CHIP_H, left: AUD_PAD_X, right: AUD_PAD_X }}
                title={portLabel(inp.label ?? inp.id, language)}
              >
                {wiredInfo ? (
                  // Read-only, so PLAIN TEXT with no plate — the rule that
                  // separates derived from editable everywhere else on a node.
                  <LiveEdgeValue className="audio-node__wired shader-node__edge-val" {...wiredInfo} />
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

        <AudioSourceSelect
          style={{ top: AUD_SOURCE_TOP, height: AUD_SOURCE_H, left: AUD_PAD_X, right: AUD_PAD_X }}
        />

        <div
          className={`audio-node__meter${status === 'on' ? '' : ' audio-node__meter--idle'}`}
          style={{ top: AUD_METER_TOP, height: AUD_METER_H, left: AUD_PAD_X, right: AUD_PAD_X }}
        >
          <span className="audio-node__meter-fill" ref={meterRef} />
        </div>

        <div className="audio-node__btn-wrap" style={{ top: AUD_BTN_TOP }}>
          <AudioNodeButton nodeId={id} values={data.values} />
        </div>

        {def.outputs.map((out, i) => (
          <TypedHandle
            key={out.id}
            type="source"
            position={Position.Right}
            id={out.id}
            dataType={out.dataType}
            label={out.label}
            style={{ top: AUD_OUT_TOPS[i] ?? AUD_OUT_TOPS[AUD_OUT_TOPS.length - 1] }}
          />
        ))}
      </div>
    </div>
  );
});

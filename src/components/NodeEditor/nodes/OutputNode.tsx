import { memo, useCallback, useEffect, useMemo } from 'react';
import { Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { meshTargetName } from '@/utils/outputTargets';
import type { AppNode } from '@/types';
import { OUTPUT_DEFAULT_EXPOSED } from '@/utils/exposedPorts';
import type { OutputFlowNode, OutputNodeData } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostTextColor, getContrastColor } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
// Also pulls in ShaderNode.css transitively — the shared .shader-node__edge-val
// class (one font size for every number on a node) lives there.
import { edgeValueLabel } from './ShaderNode';
import { LiveEdgeValue } from './LiveEdgeValue';
import { getTargetEdges } from '@/engine/cpuEvaluator';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import './OutputNode.css';

/** Ports that belong to the pixel (fragment) shader section.
 *  Exported so the asset/overview card replica groups the channels the same
 *  way this node does (NodePreviewCard's OutputCardContent). */
export const PIXEL_PORTS = ['color', 'emissive', 'roughness', 'metalness', 'opacity', 'discard', 'normal', 'env'];
/** Ports that belong to the vertex shader section (see PIXEL_PORTS). */
export const VERTEX_PORTS = ['position'];
// Single source of truth lives with the shared exposedPorts rules; re-exported
// here for the existing importers (ShaderSettingsMenu, NodeEditor).
export { OUTPUT_DEFAULT_EXPOSED };

/** Channels that take a stored NUMBER when unwired, with the shown default
 *  (three's material defaults: roughness 1, metalness 0, opacity 1; discard
 *  and displacement default 0 = literal no-ops, so zero and absent read
 *  identically and neither emits). NB a non-zero discard is an UNCONDITIONAL
 *  cull (truthiness) — the whole mesh vanishes, by design. */
export const OUTPUT_FLOAT_VALUE_PORTS: Record<string, number> = {
  roughness: 1,
  metalness: 0,
  opacity: 1,
  discard: 0,
  position: 0,
};
/** Channels that take a stored HEX color when unwired, with the shown default:
 *  color WHITE and emissive/env BLACK (three's material defaults — black adds
 *  nothing), normal the FLAT TANGENT-SPACE NORMAL #8080ff — the "neutral up"
 *  every normal map is built on, and the color anyone authoring normals
 *  recognizes as "no perturbation". A stored env color is a legitimate
 *  constant ambient environment; an image wired to env stays the real IBL
 *  path. */
export const OUTPUT_COLOR_VALUE_PORTS: Record<string, string> = {
  color: '#ffffff',
  emissive: '#000000',
  normal: '#8080ff',
  env: '#000000',
};

/**
 * What an Output node contributing NOTHING actually renders.
 *
 * graphToCode's `channelEntries.length === 0` branch emits
 * `return vec3(1, 0, 0);` — a deliberate "you have not wired anything yet"
 * sentinel — so a fresh Output node really does paint the mesh RED, while the
 * Color row showed the WHITE above and told the user something the shader
 * contradicted.
 *
 * This is state-dependent rather than a flat recolour of the default, because
 * `#ffffff` is CORRECT the moment any other channel contributes: the return
 * becomes an object, `colorNode` is left undefined, and three's
 * MeshPhysicalNodeMaterial default (white) takes over. Wire only Roughness and
 * the mesh is white, not red — so both colours are right, in different states.
 */
export const OUTPUT_EMPTY_COLOR = '#ff0000';

/** Stored channel values that graphToCode deliberately treats as no-ops and
 *  emits NOTHING for, so they do not make the node "contribute" (see the
 *  Output-node stored-value contract in CLAUDE.md: zero discard/displacement
 *  and the identity normal texel are indistinguishable from an absent key). */
function storedValueEmits(channel: string, v: unknown): boolean {
  if (v === undefined || v === null || v === '') return false;
  if (channel === 'discard' || channel === 'position') return Number(v) !== 0;
  if (channel === 'normal') return String(v).toLowerCase() !== '#8080ff';
  return true;
}

/** Displacement may go negative / beyond 1; everything else is a 0-1 dial. */
const CLAMP01_PORTS = new Set(['roughness', 'metalness', 'opacity', 'discard']);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export const OutputNode = memo(function OutputNode({
  id,
  data,
  selected,
}: NodeProps<OutputFlowNode>) {
  const def = NODE_REGISTRY.get('output')!;
  // Read from `data` (not the store) so the chip re-renders with the node.
  const meshTarget = meshTargetName({ id, data } as unknown as AppNode);
  // Cheap-string subscription: the whole inventory would re-render every
  // Output on any preview report, and all this needs is a yes/no.
  const targetKnown = useAppStore(
    (s) => !meshTarget || !!s.previewMeshInventory?.meshes.some((m) => m.name === meshTarget),
  );
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const cost = data.cost ?? 0;
  const costColor = getCostColor(cost, costColorLow, costColorHigh);
  const costTextColor = getCostTextColor(cost, costColorLow, costColorHigh);
  const headerTextColor = getContrastColor(costColor);

  const exposedPorts = data.exposedPorts ?? OUTPUT_DEFAULT_EXPOSED;
  const exposedSet = new Set(exposedPorts);
  const values = (data as OutputNodeData).values ?? {};

  // The Output node opts out of ALL drag-proximity behavior: no hidden-channel
  // reveal (channels are exposed only via the shader settings menu, or
  // auto-exposed when an edge arrives through sync/import) and no forced
  // name-tooltips (its rows already carry permanent labels). Hover tooltips
  // still work.

  // What is arriving on each wired channel — the same two-step cheap-string
  // subscription ShaderNode/MicNode use: fold the labels into ONE primitive
  // string so a position-only graph notify bails on Object.is, then rebuild
  // the map imperatively from getState(). getTargetEdges, NOT raw s.edges:
  // it returns UNWRAPPED edges, so a feeder inside a collapsed group reports
  // its REAL producer -- the raw boundary edge's source is the group id,
  // which has no registry def and would degrade every affected row to a
  // grey ellipsis the moment the group collapses (the trap documented at
  // getTargetEdges' definition).
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

  /** True when this Output node contributes no channel at all, i.e. exactly
   *  graphToCode's red-fallback branch. Only then does the unwired Color row
   *  show RED — see OUTPUT_EMPTY_COLOR. Emission is exposure-gated, so a
   *  stored value on a hidden channel does not count. */
  const emitsNothing = useMemo(() => {
    if (wiredLabels.size > 0) return false;
    return !Object.keys(values).some(
      (k) => exposedSet.has(k) && storedValueEmits(k, values[k]),
    );
  }, [wiredLabels, values, exposedSet]);

  /** Clear a channel's stored value — back to "default / none": the widget
   *  shows the channel default again and the channel stops emitting. */
  const clearChannelValue = useCallback(
    (channel: string) => {
      const current = (useAppStore.getState().nodes.find((n) => n.id === id)?.data as
        | OutputNodeData
        | undefined)?.values;
      if (!current || !(channel in current)) return;
      const { [channel]: _dropped, ...rest } = current;
      updateNodeData(id, { values: rest } as Partial<OutputNodeData>);
    },
    [id, updateNodeData],
  );

  const setChannelValue = useCallback(
    (channel: string, value: string | number) => {
      const current = (useAppStore.getState().nodes.find((n) => n.id === id)?.data as
        | OutputNodeData
        | undefined)?.values ?? {};
      updateNodeData(id, { values: { ...current, [channel]: value } } as Partial<OutputNodeData>);
    },
    [id, updateNodeData],
  );

  // Tell React Flow to re-measure handles whenever the RENDERED port set
  // changes (settings toggle). Without this, dynamically mounted handles
  // (e.g. `emissive` after the user toggles it on) aren't in React Flow's
  // bounds map, so any edge connected to them silently fails to render until
  // the page is reloaded.
  const updateNodeInternals = useUpdateNodeInternals();
  const exposedKey = exposedPorts.join('|');
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, exposedKey, updateNodeInternals]);

  // Only permanently exposed channels render (as rows) — no drag reveal here.
  const sectionPorts = (ids: string[]) =>
    def.inputs.filter((p) => ids.includes(p.id) && exposedSet.has(p.id));
  const pixelPorts = sectionPorts(PIXEL_PORTS);
  const vertexPorts = sectionPorts(VERTEX_PORTS);

  /** The right-hand cell of a row: the incoming value when wired (read-only,
   *  plain text, blue when live — a fill means "editable", plain text means
   *  "derived"); otherwise the channel's stored-value widget, when it has
   *  one. Same editable-vs-derived contract as every ShaderNode row. */
  const rowWidget = (portId: string) => {
    const wired = wiredLabels.get(portId);
    if (wired) {
      return (
        <LiveEdgeValue className="shader-node__edge-val output-node__val" {...wired} />
      );
    }
    if (portId in OUTPUT_COLOR_VALUE_PORTS) {
      const stored = values[portId];
      // On an Output node that emits nothing, the shader's real Color is the
      // red fallback — show that instead of a white the preview contradicts.
      const channelDefault =
        portId === 'color' && emitsNothing
          ? OUTPUT_EMPTY_COLOR
          : OUTPUT_COLOR_VALUE_PORTS[portId];
      return (
        <PaletteColorPicker
          className="output-node__val"
          // A stored channel colour IS the graph — it emits `color(0x…)` — so
          // this site is undoable and takes the bracket.
          history="bracket"
          value={typeof stored === 'string' ? stored : channelDefault}
          clearColor={channelDefault}
          onClear={() => clearChannelValue(portId)}
          onPick={(hex) => setChannelValue(portId, hex)}
        />
      );
    }
    if (portId in OUTPUT_FLOAT_VALUE_PORTS) {
      const stored = Number(values[portId]);
      const shown = Number.isFinite(stored) && values[portId] !== undefined && values[portId] !== null
        ? stored
        : OUTPUT_FLOAT_VALUE_PORTS[portId];
      return (
        <DragNumberInput
          compact
          className="output-node__val"
          value={shown}
          step={0.05}
          onChange={(v) =>
            setChannelValue(portId, CLAMP01_PORTS.has(portId) ? clamp01(v) : v)
          }
        />
      );
    }
    return null;
  };

  // Widget FIRST, label after — the ShaderNode row anatomy (socket, then the
  // value box beside it); the label trails like an out-label would.
  const renderRow = (port: (typeof def.inputs)[number]) => (
    <div key={port.id} className="output-node__row">
      <TypedHandle
        type="target"
        position={Position.Left}
        id={port.id}
        dataType={port.dataType}
        label={port.label}
      />
      {rowWidget(port.id)}
      <span className="output-node__port-label">{port.label}</span>
    </div>
  );

  return (
    <div
      className={`output-node ${selected ? 'output-node--selected' : ''}`}
      style={{ background: 'var(--node-bg)', border: '1.5px solid var(--cat-output)' }}
    >
      {/* Bare number, matching every ShaderNode badge — the unit is spelled out
          once on the CostBar meter rather than repeated on every node. */}
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>
          {cost}
        </span>
      )}

      {/* Main header. A TARGETED output names the mesh it shades right here:
          with several Outputs on the canvas the only thing distinguishing them
          is what they are for, and a node that looks identical to its
          neighbour while doing something different is how a user ends up
          editing the wrong material. The ⚠ form means the binding exists but
          the loaded model has no such mesh — the ordinary state after a reload
          without the model, since the graph persists and the mesh does not —
          so it reads as "not right now", not as an error. */}
      <div className="output-node__header" style={{ background: costColor }}>
        <span className="output-node__title" style={{ color: headerTextColor }}>Output</span>
        {meshTarget && (
          <span
            className="output-node__target"
            style={{ color: headerTextColor }}
            title={targetKnown
              ? `Shades the mesh "${meshTarget}"`
              : `Shades the mesh "${meshTarget}", which the loaded model does not contain`}
          >
            {targetKnown ? '\u2192' : '\u26A0'} {meshTarget}
          </span>
        )}
      </div>

      {/* Pixel Shader section */}
      <div className="output-node__section">
        <div className="output-node__section-label">Pixel Shader</div>
        <div className="output-node__ports">{pixelPorts.map(renderRow)}</div>
      </div>

      {/* Divider */}
      <div className="output-node__divider" />

      {/* Vertex Shader section */}
      <div className="output-node__section">
        <div className="output-node__section-label">Vertex Shader</div>
        <div className="output-node__ports">{vertexPorts.map(renderRow)}</div>
      </div>
    </div>
  );
});

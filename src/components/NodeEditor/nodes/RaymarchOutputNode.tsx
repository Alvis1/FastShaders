import { memo, useEffect, useMemo } from 'react';
import { Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { isActiveSinkSelector } from './activeSinkSelector';
import { effectiveExposedPorts } from '@/utils/exposedPorts';
import { getCostColor, getCostTextColor, getContrastColor } from '@/utils/colorUtils';
import { getTargetEdges } from '@/engine/cpuEvaluator';
import { TypedHandle } from '../handles/TypedHandle';
import { edgeValueLabel } from './ShaderNode';
import { LiveEdgeValue } from './LiveEdgeValue';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import { NODE_BORDER_WIDTH } from './nodeFrame';
import './OutputNode.css';

/**
 * The Raymarch Output (`raymarchOutput`) — surface and volume marcher in one
 * node — wearing the Output node's chrome: uppercase header on the cost
 * colour, labelled sections, one labelled row per socket with a value cell
 * beside the socket. It reuses OutputNode.css outright (plus the `--sdf` cell
 * width), so the two outputs can only differ where they mean to: the frame is
 * the `sdf` category colour, and the sections are Surface / Volume / Sky /
 * Settings rather than Pixel/Vertex.
 *
 * Row contract, the Output's: a WIRED socket shows the incoming value as plain
 * text (blue when live; plain text means "derived"); an unwired one shows the
 * stored-value widget when the socket has one (the Color swatch, the number
 * settings), or an empty cell that keeps the label column vertical (a field
 * socket). Every write goes through `updateNodeData`, so it is one undo entry
 * and the graph-to-code sync re-emits the loop with the new numbers.
 *
 * The palette tile (`MarchOutputCardContent` in NodePreviewCard.tsx) mirrors
 * this markup; change them together (the one-node-one-look convention).
 */

interface NumberSetting {
  step: number;
  decimals: number;
  clamp: (v: number) => number;
}

export interface MarchNodeConfig {
  title: string;
  sections: { label: string; ports: string[] }[];
  /** Per-setting step, display precision and clamp. A loop count is an integer
   *  of at least 1; distances and radii stay positive. */
  settings: Record<string, NumberSetting>;
  /** Sockets that carry a stored colour swatch when unwired. */
  colorPorts: string[];
}

export const MARCH_NODE_CONFIG: MarchNodeConfig = {
  title: 'Raymarch Output',
  sections: [
    { label: 'Surface', ports: ['field', 'color', 'emissive'] },
    { label: 'Volume', ports: ['density', 'glow'] },
    { label: 'Sky', ports: ['background'] },
    // The march's own light: the surface is shaded INSIDE the march (one vec4
    // return), so the scene lights never reach it — this section is what the
    // Light dropdown is to an ordinary shader.
    { label: 'Light', ports: ['lightX', 'lightY', 'lightZ', 'lightColor', 'ambient', 'ao', 'shadow'] },
    { label: 'Settings', ports: ['steps', 'stepSize', 'epsilon', 'stepScale', 'bend', 'horizon', 'window', 'fieldRadius'] },
  ],
  settings: {
    steps: { step: 1, decimals: 0, clamp: (v) => Math.min(512, Math.max(1, Math.round(v))) },
    stepSize: { step: 0.005, decimals: 3, clamp: (v) => Math.max(0.001, v) },
    // Epsilon must stay above zero or the march can never register a hit.
    epsilon: { step: 0.001, decimals: 3, clamp: (v) => Math.max(0.0001, v) },
    bend: { step: 0.01, decimals: 2, clamp: (v) => Math.max(0, v) },
    horizon: { step: 0.01, decimals: 2, clamp: (v) => Math.max(0, v) },
    // The preview sphere's radius: large = the camera is inside the sky.
    window: { step: 0.5, decimals: 1, clamp: (v) => Math.min(500, Math.max(0.1, v)) },
    fieldRadius: { step: 0.1, decimals: 2, clamp: (v) => Math.max(0.05, v) },
    lightX: { step: 0.05, decimals: 2, clamp: (v) => v },
    lightY: { step: 0.05, decimals: 2, clamp: (v) => v },
    lightZ: { step: 0.05, decimals: 2, clamp: (v) => v },
    // 0 = off (and no extra Field taps), 1 = full IQ-style occlusion.
    ao: { step: 0.05, decimals: 2, clamp: (v) => Math.min(1, Math.max(0, v)) },
    // 0 = off; otherwise the penumbra width, in distance units per unit of travel.
    shadow: { step: 0.05, decimals: 2, clamp: (v) => Math.max(0, v) },
    // Multiplies every sphere-trace advance: lower it for bound-only fields
    // (deformed, scaled, smooth-combined) that would otherwise show holes.
    stepScale: { step: 0.05, decimals: 2, clamp: (v) => Math.min(1, Math.max(0.05, v)) },
  },
  colorPorts: ['color', 'lightColor', 'ambient'],
};

/** What an UNWIRED colour socket shows and emits nothing for: the surface is
 *  white, the key light the 0.85 grey and the ambient the 0.15 grey the march
 *  used before these were tunable, so an untouched node shades as before. */
export const MARCH_COLOR_DEFAULTS: Record<string, string> = { color: '#ffffff', lightColor: '#d9d9d9', ambient: '#262626' };

export const RaymarchOutputNode = memo(function RaymarchOutputNode({ id, data, selected }: NodeProps<ShaderFlowNode>) {
  const def = NODE_REGISTRY.get('raymarchOutput')!;
  const config = MARCH_NODE_CONFIG;
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const setActiveOutput = useAppStore((s) => s.setActiveOutput);
  const language = useAppStore((s) => s.language);
  // Is THIS node the active sink? (utils/sdfPartition.ts `activeSink`.)
  const activeSel = useMemo(() => isActiveSinkSelector(id), [id]);
  const isActive = useAppStore(activeSel);
  const cost = data.cost ?? 0;
  // Only EXPOSED sockets render — the main chains by default, every setting
  // hidden until ticked in the settings menu (utils/exposedPorts.ts
  // MARCH_DEFAULT_EXPOSED; the Output's channel rule). Handles mount and
  // unmount with the list, so React Flow must re-measure on every change or
  // an edge into a freshly shown socket stays undrawn until a reload.
  const exposedList = effectiveExposedPorts({ id, data } as unknown as ShaderFlowNode);
  const exposedKey = exposedList.join('|');
  const exposed = useMemo(() => new Set(exposedKey.split('|')), [exposedKey]);
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, exposedKey, updateNodeInternals]);
  const costColor = getCostColor(cost, costColorLow, costColorHigh);
  const costTextColor = getCostTextColor(cost, costColorLow, costColorHigh);
  const headerTextColor = getContrastColor(costColor);
  const values = getNodeValues({ id, data } as unknown as ShaderFlowNode);

  // Wired values: the Output node's two-step selector. A cheap string key so
  // a position-only graph notify bails on Object.is, then the map rebuilt from
  // getState(). getTargetEdges, not raw s.edges: a feeder inside a collapsed
  // group must report its real producer. Separators are JS escapes on purpose
  // (sourceControlBytes.test.ts: a raw NUL makes the file binary to grep).
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

  const setValue = (key: string, v: string | number) => {
    updateNodeData(id, { values: { ...values, [key]: v } });
  };
  const clearValue = (key: string) => {
    const next = { ...values };
    delete next[key];
    updateNodeData(id, { values: next });
  };

  const cell = (portId: string) => {
    const wired = wiredLabels.get(portId);
    if (wired) {
      return <LiveEdgeValue className="shader-node__edge-val output-node__val" {...wired} />;
    }
    if (config.colorPorts.includes(portId)) {
      const stored = values[portId];
      return (
        <PaletteColorPicker
          className="output-node__val"
          // The stored colour IS the graph (it emits `color(0x...)`), so this
          // site is undoable and takes the bracket.
          history="bracket"
          value={typeof stored === 'string' ? stored : MARCH_COLOR_DEFAULTS[portId] ?? '#ffffff'}
          clearColor={MARCH_COLOR_DEFAULTS[portId] ?? '#ffffff'}
          onClear={() => clearValue(portId)}
          onPick={(hex) => setValue(portId, hex)}
        />
      );
    }
    const setting = config.settings[portId];
    if (setting) {
      const stored = Number(values[portId]);
      const shown = Number.isFinite(stored) && values[portId] !== undefined
        ? stored
        : Number(def.defaultValues?.[portId] ?? 0);
      return (
        <DragNumberInput
          compact
          className="output-node__val"
          value={shown}
          step={setting.step}
          decimals={setting.decimals}
          onChange={(v) => setValue(portId, setting.clamp(v))}
        />
      );
    }
    // A field socket: nothing to store; an empty cell keeps the label column vertical.
    return <span className="output-node__val" />;
  };

  const rows = (ids: string[]) =>
    def.inputs.filter((p) => ids.includes(p.id) && exposed.has(p.id)).map((port) => (
      <div key={port.id} className="output-node__row">
        <TypedHandle type="target" position={Position.Left} id={port.id} dataType={port.dataType} label={port.label} />
        {cell(port.id)}
        <span className="output-node__port-label">{port.label}</span>
      </div>
    ));

  return (
    <div
      className={`output-node output-node--sdf ${selected ? 'output-node--selected' : ''}${isActive ? '' : ' output-node--inactive'}`}
      style={{ background: 'var(--node-bg)', border: `${NODE_BORDER_WIDTH} solid var(--cat-sdf)` }}
    >
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>
          {cost}
        </span>
      )}
      <div className="output-node__header" style={{ background: costColor }}>
        <span className="output-node__title" style={{ color: headerTextColor }}>{config.title}</span>
      </div>
      <div className="output-node__material">
        {/* The activation control, exactly the Output's: solid while this node
            is the active sink (PreviewLink anchors its wire here), hollow
            otherwise; a click makes it active. See OutputNode.tsx. */}
        <button
          type="button"
          className={`output-node__preview-socket nodrag${isActive ? '' : ' output-node__preview-socket--inactive'}`}
          aria-pressed={isActive}
          aria-label={t(isActive ? 'Rendering this output' : 'Render this output', language)}
          title={t(isActive ? 'This output drives the preview' : 'Click to render this output instead', language)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setActiveOutput(id); }}
        />
        {/* A section whose every socket is hidden is skipped outright — an
            empty labelled band would read as a broken node. */}
        {config.sections.filter((section) => section.ports.some((p) => exposed.has(p))).map((section, i) => (
          <div key={section.label}>
            {i > 0 && <div className="output-node__subdivider" />}
            <div className="output-node__section">
              <div className="output-node__section-label">{section.label}</div>
              <div className="output-node__ports">{rows(section.ports)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

import { memo, useMemo } from 'react';
import { Position, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
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
 * The raymarching output — the SDF Output node (`sdfOutput`), wearing the
 * Output node's chrome: uppercase header on the cost colour, two labelled
 * sections, one labelled row per socket with a value cell beside the socket.
 * It reuses OutputNode.css outright (plus the `--sdf` cell width), so the two
 * outputs can only differ where they mean to: its frame is the `sdf` category
 * colour, and its sections are "Ray march" (Field, Color) and "Settings"
 * (Steps, Max distance, Epsilon) rather than Pixel/Vertex.
 *
 * Row contract, the Output's: a WIRED socket shows the incoming value as plain
 * text (blue when live — plain text means "derived"); an unwired one shows the
 * stored-value widget when the socket has one (the colour swatch, the three
 * numbers), or an empty cell that keeps the label column vertical (Field).
 * Every write goes through `updateNodeData`, so it is one undo entry and the
 * graph→code sync re-emits the loop with the new numbers.
 *
 * The palette tile (`SdfOutputCardContent` in NodePreviewCard.tsx) mirrors
 * this markup — change them together (the one-node-one-look convention).
 */

/** Per-setting step and clamp: a loop count is an integer of at least 1, the
 *  distance must stay positive, and epsilon must stay above zero or the march
 *  can never register a hit. */
const SETTINGS: Record<string, { step: number; decimals: number; clamp: (v: number) => number }> = {
  steps: { step: 1, decimals: 0, clamp: (v) => Math.min(512, Math.max(1, Math.round(v))) },
  maxDist: { step: 0.1, decimals: 2, clamp: (v) => Math.max(0.01, v) },
  epsilon: { step: 0.001, decimals: 3, clamp: (v) => Math.max(0.0001, v) },
};

const DEFAULT_COLOR = '#ffffff';

export const SdfOutputNode = memo(function SdfOutputNode({ id, data, selected }: NodeProps<ShaderFlowNode>) {
  const def = NODE_REGISTRY.get('sdfOutput')!;
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const cost = data.cost ?? 0;
  const costColor = getCostColor(cost, costColorLow, costColorHigh);
  const costTextColor = getCostTextColor(cost, costColorLow, costColorHigh);
  const headerTextColor = getContrastColor(costColor);
  const values = getNodeValues({ id, data } as unknown as ShaderFlowNode);

  // Wired values: the Output node's two-step selector — a cheap string key so
  // a position-only graph notify bails on Object.is, then the map rebuilt from
  // getState(). getTargetEdges, not raw s.edges: a feeder inside a collapsed
  // group must report its real producer.
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
    if (portId === 'color') {
      const stored = values.color;
      return (
        <PaletteColorPicker
          className="output-node__val"
          // The stored colour IS the graph — it emits `color(0x…)` — so this
          // site is undoable and takes the bracket.
          history="bracket"
          value={typeof stored === 'string' ? stored : DEFAULT_COLOR}
          clearColor={DEFAULT_COLOR}
          onClear={() => clearValue('color')}
          onPick={(hex) => setValue('color', hex)}
        />
      );
    }
    const setting = SETTINGS[portId];
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
    // Field: nothing to store — an empty cell keeps the label column vertical.
    return <span className="output-node__val" />;
  };

  const rows = (ids: string[]) =>
    def.inputs.filter((p) => ids.includes(p.id)).map((port) => (
      <div key={port.id} className="output-node__row">
        <TypedHandle type="target" position={Position.Left} id={port.id} dataType={port.dataType} label={port.label} />
        {cell(port.id)}
        <span className="output-node__port-label">{port.label}</span>
      </div>
    ));

  return (
    <div
      className={`output-node output-node--sdf ${selected ? 'output-node--selected' : ''}`}
      style={{ background: 'var(--node-bg)', border: `${NODE_BORDER_WIDTH} solid var(--cat-sdf)` }}
    >
      {cost > 0 && (
        <span className="node-base__cost-badge" style={{ color: costTextColor }}>
          {cost}
        </span>
      )}
      <div className="output-node__header" style={{ background: costColor }}>
        <span className="output-node__title" style={{ color: headerTextColor }}>SDF Output</span>
      </div>
      <div className="output-node__material">
        {/* Decorative, like the Output's: this node feeds the viewer. */}
        <span className="output-node__preview-socket" aria-hidden="true" />
        <div className="output-node__section">
          <div className="output-node__section-label">Ray march</div>
          <div className="output-node__ports">{rows(['field', 'color'])}</div>
        </div>
        <div className="output-node__subdivider" />
        <div className="output-node__section">
          <div className="output-node__section-label">Settings</div>
          <div className="output-node__ports">{rows(['steps', 'maxDist', 'epsilon'])}</div>
        </div>
      </div>
    </div>
  );
});

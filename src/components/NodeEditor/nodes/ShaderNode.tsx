import { memo, useCallback, useMemo, type ChangeEvent, type CSSProperties } from 'react';
import { Position, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode, PortDefinition, NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostScale, getCostTextColor, CAT_HEX, getContrastColor } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { NodeGlyph, hasNodeGlyph, nodeJustify, nodeScale, nodeBox, nodeSockets, nodeTextScale } from './glyphs/NodeGlyph';
import { evaluateNodeOutput, evaluateNodeRange, getNodeOutputShape } from '@/engine/cpuEvaluator';
import './ShaderNode.css';

function fmtNum(n: number): string {
  return Number.isFinite(n) ? String(+n.toFixed(2)) : '0';
}

/** Channel count flowing out of a node (1–4) — same formula TypedEdge uses:
 *  the larger of live evaluation length and static shape inference. */
function channelCount(
  nodeId: string,
  nodes: Parameters<typeof evaluateNodeOutput>[1],
  edges: Parameters<typeof evaluateNodeOutput>[2],
): number {
  const out = evaluateNodeOutput(nodeId, nodes, edges, 0);
  const evalLen = out?.length ?? 0;
  const shapeLen = getNodeOutputShape(nodeId, nodes, edges);
  return Math.min(Math.max(evalLen, shapeLen, 1), 4);
}

/** Node-body stack: px down per extra output channel layer. */
const STACK_STEP_Y = 3;

/**
 * Label for the value(s) arriving on a connected input edge.
 * - one channel → the number
 * - many channels → `min…max` range
 * - unevaluable upstream (texture etc.) → inferred `min…max` range
 * - nothing derivable (camera/world-space chains) → `…`
 * Returns the text plus whether it's a live value (vs. an inferred range).
 */
function edgeValueLabel(
  sourceId: string,
  nodes: Parameters<typeof evaluateNodeOutput>[1],
  edges: Parameters<typeof evaluateNodeOutput>[2],
): { text: string; live: boolean } {
  // Single values keep decimals ("3.69"); true RANGES round to whole numbers
  // only ("-0.8…0.8" → "-1…1") to keep node labels compact. Endpoints are
  // compared after formatting so "3.687…3.694" collapses to a single "3.69";
  // a range whose rounded ends meet collapses to that integer. Precise values
  // remain visible in the EdgeInfoCard (select the edge).
  const rangeText = (lo: number, hi: number) => {
    const a = fmtNum(lo), b = fmtNum(hi);
    if (a === b) return a;
    const ra = Math.round(lo), rb = Math.round(hi);
    return ra === rb ? String(ra) : `${ra}…${rb}`;
  };
  const out = evaluateNodeOutput(sourceId, nodes, edges, 0);
  if (out && out.length >= 1 && out.every((v) => Number.isFinite(v))) {
    return { text: rangeText(Math.min(...out), Math.max(...out)), live: true };
  }
  const r = evaluateNodeRange(sourceId, nodes, edges, 0);
  if (r && r.min.length) {
    const lo = Math.min(...r.min), hi = Math.max(...r.max);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      return { text: rangeText(lo, hi), live: false };
    }
  }
  // Connected, but neither eval nor range inference knows the value — show an
  // ellipsis so the socket still reads as carrying *something*.
  return { text: '…', live: false };
}

export interface PortRow {
  input: PortDefinition | null;
  output: PortDefinition | null;
  settingKey: string | null;
  settingType: 'number' | 'color' | 'vec3' | 'vec2' | null;
  /** For vec3/vec2 rows, the base key (without _x/_y/_z suffix) */
  vecBaseKey?: string;
}

/**
 * Build the visual row layout for a ShaderNode.
 *
 * Rows pair up input ports (left side) with output ports (right side).
 * Inline settings (numbers, colors) are attached to their port row.
 *
 * Special handling:
 * - Keys ending in `_x/_y/_z` are grouped into compact vec3 rows
 * - Keys ending in `_x/_y` (no `_z`) are grouped into vec2 rows
 * - Non-port settings (vec3/vec2/color not backed by an input port) are
 *   appended as extra rows after the input port rows
 * - Property nodes hide the `name` key (shown in the header instead)
 */
export function buildRows(def: { type?: string; inputs: PortDefinition[]; outputs: PortDefinition[]; defaultValues?: Record<string, string | number> }): PortRow[] {
  const rows: PortRow[] = [];
  const allDefaults = def.defaultValues ?? {};
  const defaults = def.type === 'property_float'
    ? Object.fromEntries(Object.entries(allDefaults).filter(([k]) => k !== 'name'))
    : def.type === 'slider'
      ? Object.fromEntries(Object.entries(allDefaults).filter(([k]) => k !== 'min' && k !== 'max'))
      : allDefaults;

  if (def.inputs.length === 0 && Object.keys(defaults).length > 0) {
    // No input ports but has settings (float, color, property_float, vec3, vec2)
    const keys = Object.keys(defaults);
    // Group _x/_y/_z keys into vec rows
    const consumed = new Set<string>();
    const orderedKeys: { key: string; type: 'number' | 'color' | 'vec3' | 'vec2'; baseKey?: string }[] = [];

    for (const key of keys) {
      if (consumed.has(key)) continue;
      if (key.endsWith('_x')) {
        const base = key.slice(0, -2);
        if (keys.includes(`${base}_z`)) {
          consumed.add(key);
          consumed.add(`${base}_y`);
          consumed.add(`${base}_z`);
          orderedKeys.push({ key, type: 'vec3', baseKey: base });
        } else if (keys.includes(`${base}_y`)) {
          consumed.add(key);
          consumed.add(`${base}_y`);
          orderedKeys.push({ key, type: 'vec2', baseKey: base });
        } else {
          orderedKeys.push({ key, type: 'number' });
        }
      } else if (key.endsWith('_y') || key.endsWith('_z')) {
        // Skip — already consumed by a vec group
        if (!consumed.has(key)) orderedKeys.push({ key, type: 'number' });
      } else {
        orderedKeys.push({
          key,
          type: String(defaults[key]).startsWith('#') ? 'color' : 'number',
        });
      }
    }

    const maxLen = Math.max(orderedKeys.length, def.outputs.length);
    for (let i = 0; i < maxLen; i++) {
      const entry = orderedKeys[i];
      rows.push({
        input: null,
        output: def.outputs[i] ?? null,
        settingKey: entry?.key ?? null,
        settingType: entry?.type ?? null,
        vecBaseKey: entry?.baseKey,
      });
    }
  } else {
    // Collect non-port settings (vec3/vec2/color keys not in inputs)
    const portIds = new Set(def.inputs.map(inp => inp.id));
    const extraSettings: { key: string; type: 'number' | 'color' | 'vec3' | 'vec2'; baseKey?: string }[] = [];
    const consumed = new Set<string>();
    const allKeys = Object.keys(defaults);

    for (const key of allKeys) {
      if (consumed.has(key) || portIds.has(key)) continue;
      if (key.endsWith('_x')) {
        const base = key.slice(0, -2);
        if (!portIds.has(base)) {
          if (allKeys.includes(`${base}_z`)) {
            consumed.add(key); consumed.add(`${base}_y`); consumed.add(`${base}_z`);
            extraSettings.push({ key, type: 'vec3', baseKey: base });
          } else if (allKeys.includes(`${base}_y`)) {
            consumed.add(key); consumed.add(`${base}_y`);
            extraSettings.push({ key, type: 'vec2', baseKey: base });
          }
        }
      } else if (key.endsWith('_y') || key.endsWith('_z')) {
        // skip consumed
      } else if (!portIds.has(key)) {
        extraSettings.push({
          key,
          type: String(defaults[key]).startsWith('#') ? 'color' : 'number',
        });
      }
    }

    const maxLen = Math.max(def.inputs.length + extraSettings.length, def.outputs.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < def.inputs.length) {
        const inp = def.inputs[i];
        const key = inp.id in defaults ? inp.id : null;
        rows.push({
          input: inp,
          output: def.outputs[i] ?? null,
          settingKey: key,
          settingType: key ? (String(defaults[key]).startsWith('#') ? 'color' : 'number') : null,
        });
      } else {
        const extra = extraSettings[i - def.inputs.length];
        rows.push({
          input: null,
          output: def.outputs[i] ?? null,
          settingKey: extra?.key ?? null,
          settingType: extra?.type ?? null,
          vecBaseKey: extra?.baseKey,
        });
      }
    }
  }

  // Guarantee at least one row for output-only nodes (e.g. positionGeometry)
  if (rows.length === 0 && def.outputs.length > 0) {
    for (const out of def.outputs) {
      rows.push({ input: null, output: out, settingKey: null, settingType: null });
    }
  }

  return rows;
}

export const ShaderNode = memo(function ShaderNode({
  id,
  data,
  selected,
}: NodeProps<ShaderFlowNode>) {
  const def = NODE_REGISTRY.get(data.registryType);
  if (!def) return null;

  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const edges = useAppStore((s) => s.edges);
  const nodes = useAppStore((s) => s.nodes);
  const varName = useAppStore((s) => s.nodeVarNames[id]);
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const catHex = CAT_HEX[def.category as NodeCategory] ?? CAT_HEX.unknown;
  const costColor = getCostColor(data.cost, costColorLow, costColorHigh);
  const headerTextColor = getContrastColor(costColor);
  const costTextColor = getCostTextColor(data.cost, costColorLow, costColorHigh);
  const costScale = getCostScale(data.cost);
  // Per-node box override (designer): minimum width. Frame style (corner
  // radius, border thickness) is fixed app-wide — only the color varies (category).
  const box = nodeBox(data.registryType);
  // The cost scale lives on an outer wrapper so the multi-channel stack layers
  // (siblings of the card, painted below it) scale together with the card.
  const wrapStyle: CSSProperties = {
    position: 'relative',
    width: 'fit-content',
    transform: `scale(${costScale})`,
    transformOrigin: 'top left',
  };
  const nodeStyle: CSSProperties = {
    background: 'var(--bg-panel)',
    border: `1.5px solid ${catHex}`,
  };
  // Exact width override: also lowers min-width so the node can go NARROWER
  // than its natural fit-content size (header ellipsizes; op body unfloors).
  if (box.width) {
    nodeStyle.width = box.width;
    nodeStyle.minWidth = box.width;
  }
  // Per-node text scale: multiplies header/value/edge-label font sizes via a
  // CSS variable (layout metrics like the 14px header stay fixed).
  const textScale = nodeTextScale(data.registryType);
  if (textScale !== 1) (nodeStyle as Record<string, string | number>)['--node-text-scale'] = textScale;
  const headerStyle: CSSProperties = { background: costColor };
  const rows = useMemo(() => buildRows(def), [def]);

  // Track which input ports have edges connected
  const connectedInputs = useMemo(
    () => new Set(edges.filter((e) => e.target === id).map((e) => e.targetHandle)),
    [edges, id],
  );

  // Multi-channel stacked-cards effect: the node stacks only when multi-channel
  // data ARRIVES on its inputs — the widest channel count across connected input
  // edges (mirrors TypedEdge's count). N channels read as N total cards: the
  // card itself plus N−1 offset layers. Source/constructor nodes (no
  // multi-channel input) never stack. Sockets stay single — consistency rule.
  const inChannels = useMemo(() => {
    let widest = 1;
    for (const e of edges) {
      if (e.target === id) widest = Math.max(widest, channelCount(e.source, nodes, edges));
    }
    return Math.min(widest, 4);
  }, [id, nodes, edges]);

  /** Offset card layers behind the node body (channels − 1, so N-ch = N cards).
   *  z-index staggers downward (−1, −2, −3): deeper layers paint FIRST, so each
   *  shallower layer only covers the top of the one beneath and every layer's
   *  bottom strip stays visible. (Equal z would paint in DOM order and erase
   *  all but the deepest strip.) */
  const stackLayerCount = inChannels - 1;
  // While stacked, the card drops its own shadow so no shadow falls BETWEEN
  // cards — the deepest layer casts the single group shadow instead. The
  // selection ring (class shadow + outline) still wins when selected.
  if (stackLayerCount > 0 && !selected) nodeStyle.boxShadow = 'none';
  const stackLayers = stackLayerCount > 0
    ? [...Array(stackLayerCount).keys()].map((k) => (
        <div
          key={`stack-${k}`}
          className="node-base__stack"
          style={{
            transform: `translateY(${(k + 1) * STACK_STEP_Y}px)`,
            zIndex: -(k + 1),
            borderColor: catHex,
            ...(k === stackLayerCount - 1 ? { boxShadow: 'var(--shadow-node)' } : null),
          }}
        />
      ))
    : null;

  const handleChange = useCallback(
    (key: string, raw: string) => {
      const num = parseFloat(raw);
      const value = isNaN(num) ? raw : num;
      updateNodeData(id, { values: { ...data.values, [key]: value } } as Partial<ShaderFlowNode['data']>);
    },
    [id, data.values, updateNodeData],
  );

  // Operator layout: a 2-input glyph node shows the glyph BETWEEN the two inputs.
  // Input values stack — `a` above the glyph, `b` below — centered (or justified
  // per the node's designer override). Output socket is centered on the right.
  if (hasNodeGlyph(data.registryType) && def.inputs.length === 2) {
    const ins = def.inputs;
    const justify = nodeJustify(data.registryType);
    const scale = nodeScale(data.registryType);
    const HEADER_H = 14;
    // Scale grows the glyph ONLY. Socket/value spacing is fixed: in auto mode
    // the body keeps its 52px base height and grows just enough to contain a
    // larger glyph. An explicit designer `height` overrides the body height
    // without touching the glyph (which may then overflow — designer's call).
    const glyphPx = Math.round(34 * scale);
    const BODY_H = box.height ?? Math.max(52, glyphPx + 10);
    // Socket positions are px offsets from the body CENTER (designer-movable,
    // 4px snap). Defaults reproduce the classic 26% / 74% spots of the 52px body.
    const sockets = nodeSockets(data.registryType);
    const DEF_OFF = [-12.5, 12.5];
    const offOf = (id: string, i: number) => sockets[id] ?? DEF_OFF[i] ?? 0;
    const outOff = sockets['out'] ?? 0;
    return (
      <div style={wrapStyle}>
        {stackLayers}
        <div
          className={`node-base ${selected ? 'node-base--selected' : ''}`}
          style={nodeStyle}
        >
        {data.cost > 0 && <span className="node-base__cost-badge" style={{ color: costTextColor }}>{data.cost}</span>}

        <div className="node-base__header" style={headerStyle}>
          <span className="node-base__title" style={{ color: headerTextColor }}>
            {data.registryType === 'property_float' && data.values?.name
              ? String(data.values.name)
              : varName ?? data.label}
          </span>
        </div>

        <div className="shader-node__op" style={{ height: BODY_H, ...(box.width ? { minWidth: 0 } : null) }}>
          <div className="shader-node__op-glyph">
            <NodeGlyph type={data.registryType} value={Number(data.values?.value ?? 0)} size={34} />
          </div>
          {ins.map((inp, i) => {
            const top = `${BODY_H / 2 + offOf(inp.id, i)}px`;
            const cls = `shader-node__op-val shader-node__op-val--${justify}`;
            if (!connectedInputs.has(inp.id)) {
              return (
                <div key={`v-${inp.id}`} className={cls} style={{ top }}>
                  <DragNumberInput
                    compact
                    step={inp.dataType === 'int' ? 1 : undefined}
                    value={Number(data.values[inp.id] ?? def.defaultValues?.[inp.id] ?? 0)}
                    onChange={(v) => handleChange(inp.id, String(inp.dataType === 'int' ? Math.round(v) : v))}
                  />
                </div>
              );
            }
            const edge = edges.find((e) => e.target === id && e.targetHandle === inp.id);
            const info = edge ? edgeValueLabel(edge.source, nodes, edges) : null;
            return info ? (
              <div key={`r-${inp.id}`} className={cls} style={{ top }}>
                <span className="shader-node__edge-val" style={info.live ? { color: '#2D6CDF' } : undefined}>{info.text}</span>
              </div>
            ) : null;
          })}
        </div>

        {ins.map((inp, i) => (
          <TypedHandle
            key={`h-${inp.id}`}
            type="target"
            position={Position.Left}
            id={inp.id}
            dataType={inp.dataType}
            label={inp.label}
            style={{ top: `${HEADER_H + BODY_H / 2 + offOf(inp.id, i)}px` }}
          />
        ))}
        {def.outputs[0] && (
          <TypedHandle
            type="source"
            position={Position.Right}
            id={def.outputs[0].id}
            dataType={def.outputs[0].dataType}
            label={def.outputs[0].label}
            style={{ top: `${HEADER_H + BODY_H / 2 + outOff}px` }}
          />
        )}
        </div>
      </div>
    );
  }

  // Rows layout: designer-moved sockets (sockets[id] / sockets['out']) detach
  // from their rows and position from the below-header region's center — the
  // same center-relative convention the operator layout uses. A detached
  // input's value widget follows its socket (op-val styling). Without an
  // override, sockets stay row-anchored (classic behavior).
  const sockOv = nodeSockets(data.registryType);
  const rowsOutOff = sockOv['out'];
  const rowsJustify = nodeJustify(data.registryType);
  const calcTop = (off: number) => `calc(50% ${off < 0 ? '-' : '+'} ${Math.abs(off)}px)`;

  return (
    <div style={wrapStyle}>
      {stackLayers}
      <div
        className={`node-base ${selected ? 'node-base--selected' : ''}`}
        style={nodeStyle}
      >
      {/* Cost badge above node */}
      {data.cost > 0 && <span className="node-base__cost-badge" style={{ color: costTextColor }}>{data.cost}</span>}

      {/* Header — colored by performance impact (cost) */}
      <div className="node-base__header" style={headerStyle}>
        <span className="node-base__title" style={{ color: headerTextColor }}>
          {data.registryType === 'property_float' && data.values?.name
            ? String(data.values.name)
            : varName ?? data.label}
        </span>
      </div>

      {/* Below-header region: glyph + rows. Wrapping both lets a designer-moved
          output socket position absolutely against this region's center (same
          center-relative convention as the operator layout). A designer height
          is EXACT here too — shorter than content shrinks the node and the
          glyph/rows simply overflow (overflow stays visible; dx/dy places art). */}
      <div style={{ position: 'relative', ...(box.height ? { height: box.height } : null) }}>
      {/* Glyph icon for the node, above the port rows. Values are never drawn on
          top of it — they live in the rows below, aligned with their sockets. */}
      {hasNodeGlyph(data.registryType) && (
        <div className="shader-node__glyph">
          <NodeGlyph type={data.registryType} value={Number(data.values?.value ?? 0)} size={30} />
        </div>
      )}

      {/* Port rows */}
      <div className="node-base__body">
        {rows.map((row, i) => {
          const inputConnected = row.input ? connectedInputs.has(row.input.id) : false;
          const showInlineValue = row.input && !inputConnected && !row.settingKey;
          // Designer-moved input: its socket + value render detached (below),
          // so this row's left side stays empty.
          const inputMoved = row.input ? sockOv[row.input.id] != null : false;

          if (inputMoved) {
            return (
              <div key={i} className="node-base__row shader-node__row">
                <div className="shader-node__left" />
                <div className="shader-node__right">
                  {row.output && !(rowsOutOff != null && row.output === def.outputs[0]) && (
                    <TypedHandle
                      type="source"
                      position={Position.Right}
                      id={row.output.id}
                      dataType={row.output.dataType}
                      label={row.output.label}
                    />
                  )}
                </div>
              </div>
            );
          }

          return (
            <div key={i} className="node-base__row shader-node__row">
              {/* Left side: input handle + label + value */}
              <div className="shader-node__left">
                {row.input && (
                  <TypedHandle
                    type="target"
                    position={Position.Left}
                    id={row.input.id}
                    dataType={row.input.dataType}
                    label={row.input.label}
                  />
                )}
                {/* Connected input → show the value(s) on the edge next to its socket */}
                {row.input && inputConnected && (() => {
                  const edge = edges.find((e) => e.target === id && e.targetHandle === row.input!.id);
                  const info = edge ? edgeValueLabel(edge.source, nodes, edges) : null;
                  return info ? (
                    <span className="shader-node__edge-val" style={info.live ? { color: '#2D6CDF' } : undefined}>
                      {info.text}
                    </span>
                  ) : null;
                })()}
                {/* Slider range input */}
                {data.registryType === 'slider' && row.settingKey === 'value' && (
                  <input
                    type="range"
                    className="shader-node__slider nodrag"
                    min={Number(data.values.min ?? def.defaultValues?.min ?? 0)}
                    max={Number(data.values.max ?? def.defaultValues?.max ?? 1)}
                    step={0.01}
                    value={Number(data.values.value ?? def.defaultValues?.value ?? 0.5)}
                    onChange={(e) => handleChange('value', e.target.value)}
                    title={String(Number(data.values.value ?? 0.5).toFixed(2))}
                  />
                )}
                {/* Inline setting from defaultValues */}
                {row.settingKey && row.settingType === 'number' && !inputConnected && !(data.registryType === 'slider' && row.settingKey === 'value') && (
                  <DragNumberInput
                    compact
                    step={row.input?.dataType === 'int' ? 1 : undefined}
                    value={Number(data.values[row.settingKey] ?? def.defaultValues?.[row.settingKey] ?? 0)}
                    onChange={(v) => handleChange(row.settingKey!, String(row.input?.dataType === 'int' ? Math.round(v) : v))}
                  />
                )}
                {row.settingKey && row.settingType === 'color' && (
                  <input
                    type="color"
                    className="shader-node__input-color nodrag"
                    value={String(data.values[row.settingKey] ?? def.defaultValues?.[row.settingKey] ?? '#ff0000')}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      handleChange(row.settingKey!, e.target.value)
                    }
                  />
                )}
                {row.settingType === 'vec3' && row.vecBaseKey && (
                  <span className="shader-node__vec-group">
                    {['x', 'y', 'z'].map((axis) => {
                      const k = `${row.vecBaseKey}_${axis}`;
                      return (
                        <DragNumberInput
                          key={axis}
                          compact
                          value={Number(data.values[k] ?? def.defaultValues?.[k] ?? 0)}
                          onChange={(v) => handleChange(k, String(v))}
                        />
                      );
                    })}
                  </span>
                )}
                {row.settingType === 'vec2' && row.vecBaseKey && (
                  <span className="shader-node__vec-group">
                    {['x', 'y'].map((axis) => {
                      const k = `${row.vecBaseKey}_${axis}`;
                      return (
                        <DragNumberInput
                          key={axis}
                          compact
                          value={Number(data.values[k] ?? def.defaultValues?.[k] ?? 0)}
                          onChange={(v) => handleChange(k, String(v))}
                        />
                      );
                    })}
                  </span>
                )}
                {/* Inline value for unconnected ports without defaultValues */}
                {showInlineValue && (
                  <DragNumberInput
                    compact
                    step={row.input?.dataType === 'int' ? 1 : undefined}
                    value={Number(data.values[row.input!.id] ?? 0)}
                    onChange={(v) => handleChange(row.input!.id, String(row.input?.dataType === 'int' ? Math.round(v) : v))}
                  />
                )}
              </div>

              {/* Right side: output handle (outputs[0] moves out of its row
                  when a designer socket override exists) */}
              <div className="shader-node__right">
                {row.output && !(rowsOutOff != null && row.output === def.outputs[0]) && (
                  <TypedHandle
                    type="source"
                    position={Position.Right}
                    id={row.output.id}
                    dataType={row.output.dataType}
                    label={row.output.label}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {/* Detached input sockets + their values (value follows its socket) */}
      {def.inputs.map((inp) => {
        const off = sockOv[inp.id];
        if (off == null) return null;
        const top = calcTop(off);
        const connected = connectedInputs.has(inp.id);
        const edge = connected ? edges.find((e) => e.target === id && e.targetHandle === inp.id) : undefined;
        const info = edge ? edgeValueLabel(edge.source, nodes, edges) : null;
        return (
          <div key={`mv-${inp.id}`} style={{ display: 'contents' }}>
            <div className={`shader-node__op-val shader-node__op-val--${rowsJustify}`} style={{ top }}>
              {connected ? (
                info && (
                  <span className="shader-node__edge-val" style={info.live ? { color: '#2D6CDF' } : undefined}>
                    {info.text}
                  </span>
                )
              ) : (
                <DragNumberInput
                  compact
                  step={inp.dataType === 'int' ? 1 : undefined}
                  value={Number(data.values[inp.id] ?? def.defaultValues?.[inp.id] ?? 0)}
                  onChange={(v) => handleChange(inp.id, String(inp.dataType === 'int' ? Math.round(v) : v))}
                />
              )}
            </div>
            <TypedHandle
              type="target"
              position={Position.Left}
              id={inp.id}
              dataType={inp.dataType}
              label={inp.label}
              style={{ top }}
            />
          </div>
        );
      })}
      {rowsOutOff != null && def.outputs[0] && (
        <TypedHandle
          type="source"
          position={Position.Right}
          id={def.outputs[0].id}
          dataType={def.outputs[0].dataType}
          label={def.outputs[0].label}
          style={{ top: calcTop(rowsOutOff) }}
        />
      )}
      </div>
      </div>
    </div>
  );
});

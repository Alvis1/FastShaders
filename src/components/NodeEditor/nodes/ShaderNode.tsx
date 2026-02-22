import { memo, useCallback, type ChangeEvent } from 'react';
import { Position, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode, PortDefinition, NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostScale, getCostTextColor } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import { DragNumberInput } from '../inputs/DragNumberInput';
import './ShaderNode.css';

export const CATEGORY_COLORS: Record<string, string> = {
  input: 'var(--cat-input)',
  type: 'var(--cat-type)',
  arithmetic: 'var(--cat-arithmetic)',
  math: 'var(--cat-math)',
  interpolation: 'var(--cat-interpolation)',
  vector: 'var(--cat-vector)',
  noise: 'var(--cat-noise)',
  color: 'var(--cat-color)',
  texture: 'var(--cat-texture)',
};

export interface PortRow {
  input: PortDefinition | null;
  output: PortDefinition | null;
  settingKey: string | null;
  settingType: 'number' | 'color' | 'vec3' | 'vec2' | null;
  /** For vec3/vec2 rows, the base key (without _x/_y/_z suffix) */
  vecBaseKey?: string;
}

export function buildRows(def: { type?: string; inputs: PortDefinition[]; outputs: PortDefinition[]; defaultValues?: Record<string, string | number> }): PortRow[] {
  const rows: PortRow[] = [];
  const allDefaults = def.defaultValues ?? {};
  // For property nodes, hide 'name' from inline settings (shown in header instead)
  const defaults = def.type === 'property_float'
    ? Object.fromEntries(Object.entries(allDefaults).filter(([k]) => k !== 'name'))
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
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const catColor = CATEGORY_COLORS[def.category as NodeCategory] ?? 'var(--type-any)';
  const costColor = getCostColor(data.cost, costColorLow, costColorHigh);
  const costTextColor = getCostTextColor(data.cost, costColorLow, costColorHigh);
  const costScale = getCostScale(data.cost);
  const rows = buildRows(def);

  // Track which input ports have edges connected
  const connectedInputs = new Set(
    edges.filter((e) => e.target === id).map((e) => e.targetHandle),
  );

  const handleChange = useCallback(
    (key: string, raw: string) => {
      const num = parseFloat(raw);
      const value = isNaN(num) ? raw : num;
      updateNodeData(id, { values: { ...data.values, [key]: value } } as Partial<ShaderFlowNode['data']>);
    },
    [id, data.values, updateNodeData],
  );

  return (
    <div
      className={`node-base ${selected ? 'node-base--selected' : ''}`}
      style={{ background: costColor, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
    >
      {/* Cost badge above node */}
      {data.cost > 0 && <span className="node-base__cost-badge" style={{ color: costTextColor }}>{data.cost}</span>}

      {/* Header */}
      <div className="node-base__header" style={{ borderLeft: `3px solid ${catColor}` }}>
        <span className="node-base__title">
          {data.registryType === 'property_float' && data.values?.name
            ? String(data.values.name)
            : data.label}
        </span>
      </div>

      {/* Port rows */}
      <div className="node-base__body">
        {rows.map((row, i) => {
          const inputConnected = row.input ? connectedInputs.has(row.input.id) : false;
          const showInlineValue = row.input && !inputConnected && !row.settingKey;

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
                {/* Inline setting from defaultValues */}
                {row.settingKey && row.settingType === 'number' && !inputConnected && (
                  <DragNumberInput
                    compact
                    value={Number(data.values[row.settingKey] ?? def.defaultValues?.[row.settingKey] ?? 0)}
                    onChange={(v) => handleChange(row.settingKey!, String(v))}
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
                    value={Number(data.values[row.input!.id] ?? 0)}
                    onChange={(v) => handleChange(row.input!.id, String(v))}
                  />
                )}
              </div>

              {/* Right side: output handle */}
              <div className="shader-node__right">
                {row.output && (
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
    </div>
  );
});

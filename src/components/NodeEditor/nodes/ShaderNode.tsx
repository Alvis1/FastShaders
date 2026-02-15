import { memo, useCallback, type ChangeEvent } from 'react';
import { Position, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode, PortDefinition, NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { getCostColor, getCostScale } from '@/utils/colorUtils';
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
};

export interface PortRow {
  input: PortDefinition | null;
  output: PortDefinition | null;
  settingKey: string | null;
  settingType: 'number' | 'color' | null;
}

export function buildRows(def: { inputs: PortDefinition[]; outputs: PortDefinition[]; defaultValues?: Record<string, string | number> }): PortRow[] {
  const rows: PortRow[] = [];
  const defaults = def.defaultValues ?? {};

  if (def.inputs.length === 0 && Object.keys(defaults).length > 0) {
    // No input ports but has settings (float, color, uniform_float)
    const keys = Object.keys(defaults);
    const maxLen = Math.max(keys.length, def.outputs.length);
    for (let i = 0; i < maxLen; i++) {
      const key = keys[i] ?? null;
      rows.push({
        input: null,
        output: def.outputs[i] ?? null,
        settingKey: key,
        settingType: key ? (String(defaults[key]).startsWith('#') ? 'color' : 'number') : null,
      });
    }
  } else {
    const maxLen = Math.max(def.inputs.length, def.outputs.length);
    for (let i = 0; i < maxLen; i++) {
      const inp = def.inputs[i] ?? null;
      const key = inp && inp.id in defaults ? inp.id : null;
      rows.push({
        input: inp,
        output: def.outputs[i] ?? null,
        settingKey: key,
        settingType: key ? (String(defaults[key]).startsWith('#') ? 'color' : 'number') : null,
      });
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
  const catColor = CATEGORY_COLORS[def.category as NodeCategory] ?? 'var(--type-any)';
  const costColor = getCostColor(data.cost);
  const costScale = getCostScale(data.cost);
  const costLabel = `${data.cost}`;
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
      {/* Header */}
      <div className="node-base__header">
        <span className="node-base__dot" style={{ background: catColor }} />
        <span className="node-base__title">{data.label}</span>
        <span className="node-base__cost">{costLabel}</span>
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
                  />
                )}
                {row.input && (
                  <span className="node-base__port-label">{row.input.label}</span>
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
                  <span className="shader-node__color-wrap">
                    <input
                      type="color"
                      className="shader-node__input-color nodrag"
                      value={String(data.values[row.settingKey] ?? def.defaultValues?.[row.settingKey] ?? '#ff0000')}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        handleChange(row.settingKey!, e.target.value)
                      }
                    />
                    <span className="shader-node__color-hex">
                      {String(data.values[row.settingKey] ?? def.defaultValues?.[row.settingKey] ?? '#ff0000')}
                    </span>
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

              {/* Right side: output label + handle */}
              <div className="shader-node__right">
                {row.output && (
                  <span className="node-base__port-label">{row.output.label}</span>
                )}
                {row.output && (
                  <TypedHandle
                    type="source"
                    position={Position.Right}
                    id={row.output.id}
                    dataType={row.output.dataType}
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

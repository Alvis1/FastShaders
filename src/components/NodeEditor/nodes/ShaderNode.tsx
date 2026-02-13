import { memo, useCallback, type ChangeEvent } from 'react';
import { Position, type NodeProps } from '@xyflow/react';
import type { ShaderFlowNode, PortDefinition, NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore } from '@/store/useAppStore';
import { TypedHandle } from '../handles/TypedHandle';
import './ShaderNode.css';

const CATEGORY_COLORS: Record<string, string> = {
  input: 'var(--cat-input)',
  type: 'var(--cat-type)',
  arithmetic: 'var(--cat-arithmetic)',
  math: 'var(--cat-math)',
  interpolation: 'var(--cat-interpolation)',
  vector: 'var(--cat-vector)',
  noise: 'var(--cat-noise)',
  color: 'var(--cat-color)',
};

interface PortRow {
  input: PortDefinition | null;
  output: PortDefinition | null;
  settingKey: string | null;
  settingType: 'number' | 'color' | null;
}

function buildRows(def: { inputs: PortDefinition[]; outputs: PortDefinition[]; defaultValues?: Record<string, string | number> }): PortRow[] {
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
  const catColor = CATEGORY_COLORS[def.category as NodeCategory] ?? 'var(--type-any)';
  const costLabel = `${data.cost} pts`;
  const rows = buildRows(def);

  const handleChange = useCallback(
    (key: string, raw: string) => {
      const num = parseFloat(raw);
      const value = isNaN(num) ? raw : num;
      updateNodeData(id, { values: { ...data.values, [key]: value } } as Partial<ShaderFlowNode['data']>);
    },
    [id, data.values, updateNodeData],
  );

  return (
    <div className={`shader-node ${selected ? 'shader-node--selected' : ''}`}>
      {/* Header */}
      <div className="shader-node__header">
        <span className="shader-node__dot" style={{ background: catColor }} />
        <span className="shader-node__title">{data.label}</span>
        <span className="shader-node__cost">{costLabel}</span>
      </div>

      {/* Port rows */}
      <div className="shader-node__body">
        {rows.map((row, i) => (
          <div key={i} className="shader-node__row">
            {/* Left side: input handle + label */}
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
                <span className="shader-node__port-label">{row.input.label}</span>
              )}
              {/* Inline setting: number or color */}
              {row.settingKey && row.settingType === 'number' && (
                <input
                  type="number"
                  className="shader-node__input-num nodrag"
                  step="0.1"
                  value={data.values[row.settingKey] ?? def.defaultValues?.[row.settingKey] ?? 0}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    handleChange(row.settingKey!, e.target.value)
                  }
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
            </div>

            {/* Right side: output label + handle */}
            <div className="shader-node__right">
              {row.output && (
                <span className="shader-node__port-label">{row.output.label}</span>
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
        ))}
      </div>
    </div>
  );
});

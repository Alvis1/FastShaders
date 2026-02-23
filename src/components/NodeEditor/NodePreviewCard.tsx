import { memo } from 'react';
import type { NodeDefinition, NodeCategory } from '@/types';
import { getTypeColor } from '@/utils/colorUtils';
import { getCostColor, getCostTextColor, getCostScale } from '@/utils/colorUtils';
import { buildRows } from './nodes/ShaderNode';
import complexityData from '@/registry/complexity.json';
import './NodePreviewCard.css';

const CATEGORY_COLORS: Record<string, string> = {
  input: 'var(--cat-input)',
  type: 'var(--cat-type)',
  arithmetic: 'var(--cat-arithmetic)',
  math: 'var(--cat-math)',
  interpolation: 'var(--cat-interpolation)',
  vector: 'var(--cat-vector)',
  noise: 'var(--cat-noise)',
  color: 'var(--cat-color)',
  texture: 'var(--cat-texture)',
  output: 'var(--cat-output)',
};

interface NodePreviewCardProps {
  def: NodeDefinition;
  onDragStart: (event: React.DragEvent, def: NodeDefinition) => void;
}

export const NodePreviewCard = memo(function NodePreviewCard({ def, onDragStart }: NodePreviewCardProps) {
  const costs = complexityData.costs as Record<string, number>;
  const cost = costs[def.type] ?? 0;
  const catColor = CATEGORY_COLORS[def.category as NodeCategory] ?? 'var(--type-any)';
  const costColor = getCostColor(cost);
  const costTextColor = getCostTextColor(cost);
  const costScale = getCostScale(cost);
  const rows = buildRows(def);

  return (
    <div
      className="node-preview-card"
      draggable
      onDragStart={(e) => onDragStart(e, def)}
    >
      <div
        className="node-base node-preview-card__node"
        style={{ background: costColor, transform: `scale(${costScale})`, transformOrigin: 'top left' }}
      >
        {cost > 0 && (
          <span className="node-base__cost-badge" style={{ color: costTextColor }}>{cost}</span>
        )}

        <div className="node-base__header" style={{ borderLeft: `3px solid ${catColor}` }}>
          <span className="node-base__title">{def.label}</span>
        </div>

        <div className="node-base__body">
          {rows.map((row, i) => (
            <div key={i} className="node-base__row node-preview-card__row">
              <div className="node-preview-card__left">
                {row.input && (
                  <>
                    <span
                      className="node-preview-card__handle node-preview-card__handle--left"
                      style={{ background: getTypeColor(row.input.dataType) }}
                    />
                    <span className="node-base__port-label">{row.input.label}</span>
                  </>
                )}
                {row.settingKey && row.settingType === 'number' && (
                  <span className="node-preview-card__value">
                    {def.defaultValues?.[row.settingKey] ?? 0}
                  </span>
                )}
                {row.settingKey && row.settingType === 'color' && (
                  <span
                    className="node-preview-card__color-swatch"
                    style={{ background: String(def.defaultValues?.[row.settingKey] ?? '#ff0000') }}
                  />
                )}
                {row.settingType === 'vec3' && row.vecBaseKey && (
                  <span className="node-preview-card__value">
                    {['x', 'y', 'z'].map((a) => def.defaultValues?.[`${row.vecBaseKey}_${a}`] ?? 0).join(', ')}
                  </span>
                )}
                {row.settingType === 'vec2' && row.vecBaseKey && (
                  <span className="node-preview-card__value">
                    {['x', 'y'].map((a) => def.defaultValues?.[`${row.vecBaseKey}_${a}`] ?? 0).join(', ')}
                  </span>
                )}
              </div>

              <div className="node-preview-card__right">
                {row.output && (
                  <>
                    <span className="node-base__port-label">{row.output.label}</span>
                    <span
                      className="node-preview-card__handle node-preview-card__handle--right"
                      style={{ background: getTypeColor(row.output.dataType) }}
                    />
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import type { ShaderFlowNode } from '@/types';
import { getNodeValues } from '@/types';
import { rowStyle, labelStyle, NumberRow, NodeActions } from './menuShared';

interface StripesSettingsMenuProps {
  nodeId: string;
}

/**
 * Right-click settings for the Data Stripes node: toggle radial (concentric
 * "target"/tree-ring) mode and choose the circle center + radius. These aren't
 * shown as inline node widgets (they're niche + need labels), so they live here.
 */
export function StripesSettingsMenu({ nodeId }: StripesSettingsMenuProps) {
  const nodes = useAppStore((s) => s.nodes);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);

  const node = nodes.find((n) => n.id === nodeId) as ShaderFlowNode | undefined;
  if (!node || node.data.registryType !== 'stripes') return null;

  const v = getNodeValues(node);
  const radial = Number(v.radial ?? 0) >= 0.5;
  const set = (patch: Record<string, number>) =>
    updateNodeData(nodeId, { values: { ...v, ...patch } });

  const numRow = (key: string, label: string, fallback: number, min?: number) => (
    <NumberRow
      label={label}
      value={Number(v[key] ?? fallback)}
      onCommit={(n) => set({ [key]: n })}
      min={min}
    />
  );

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">{t('Data Stripes', language)}</div>

      {/* 0 = clean value heatmap (colour only); higher = bolder stripes. */}
      {numRow('lineStrength', t('stripe strength', language), 0.75, 0)}

      <label style={{ ...rowStyle, cursor: 'pointer' }}>
        <span style={labelStyle}>{t('radial (rings)', language)}</span>
        <input
          type="checkbox"
          checked={radial}
          onChange={(e) => set({ radial: e.target.checked ? 1 : 0 })}
        />
      </label>

      {radial && (
        <>
          {numRow('center_x', t('center X', language), 0.5)}
          {numRow('center_y', t('center Y', language), 0.5)}
          {numRow('radius', t('radius', language), 0.5, 0.05)}
        </>
      )}

      <NodeActions nodeId={nodeId} />
    </div>
  );
}

import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import type { ShaderFlowNode } from '@/types';
import { getNodeValues } from '@/types';
import { NumberRow, NodeActions, RadialRows } from './menuShared';
import { RampColorPorts } from './RampColorPorts';

interface StripesSettingsMenuProps {
  nodeId: string;
}

/**
 * Right-click settings for the Data Stripes node: toggle radial (concentric
 * "target"/tree-ring) mode and choose the circle center + radius. These aren't
 * shown as inline node widgets (they're niche + need labels), so they live here.
 */
export function StripesSettingsMenu({ nodeId }: StripesSettingsMenuProps) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);

  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId)) as ShaderFlowNode | undefined;
  if (!node || node.data.registryType !== 'stripes') return null;

  const v = getNodeValues(node);
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

      {/* Shared with the Data Viz menu — the two nodes' radial blocks are the
          same three settings and must not drift. */}
      <RadialRows labelKey="radial (rings)" language={language} values={v} onChange={set} />

      <RampColorPorts nodeId={nodeId} />

      <NodeActions nodeId={nodeId} />
    </div>
  );
}

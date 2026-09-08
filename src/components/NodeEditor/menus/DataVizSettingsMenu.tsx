import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import type { ShaderFlowNode } from '@/types';
import { getNodeValues } from '@/types';
import { NumberRow, NodeActions, RadialRows } from './menuShared';
import { RampColorPorts } from './RampColorPorts';

interface DataVizSettingsMenuProps {
  nodeId: string;
}

/**
 * Right-click settings for the Data Viz node: the tone curve (scale, offset,
 * low/high input cutoffs, midpoint, contrast) plus radial distribution. These
 * need labels and are niche, so they live here rather than as inline node
 * widgets (only the two colour swatches show on the node itself).
 */
export function DataVizSettingsMenu({ nodeId }: DataVizSettingsMenuProps) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);

  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId)) as ShaderFlowNode | undefined;
  if (!node || node.data.registryType !== 'dataviz') return null;

  const v = getNodeValues(node);
  const set = (patch: Record<string, number>) =>
    updateNodeData(nodeId, { values: { ...v, ...patch } });

  const numRow = (
    key: string,
    label: string,
    fallback: number,
    step = 0.05,
    min?: number,
    max?: number,
  ) => (
    <NumberRow
      label={label}
      value={Number(v[key] ?? fallback)}
      onCommit={(n) => set({ [key]: n })}
      step={step}
      min={min}
      max={max}
    />
  );

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">{t('Data Viz — tone', language)}</div>

      {/* Pre-scale + shift of the raw normalized value. */}
      {numRow('scale', t('scale', language), 1)}
      {numRow('offset', t('offset', language), 0)}

      {/* Input levels: values below low / above high map to the ramp ends. */}
      {numRow('lowCutoff', t('low cutoff', language), 0, 0.05, 0, 1)}
      {numRow('highCutoff', t('high cutoff', language), 1, 0.05, 0, 1)}

      {/* Midpoint (gamma): value that maps to the ramp's centre. Lower = brighter. */}
      {numRow('midpoint', t('midpoint', language), 0.5, 0.02, 0.01, 0.99)}

      {/* Contrast around the midpoint (1 = none). */}
      {numRow('contrast', t('contrast', language), 1, 0.05, 0)}

      <div className="context-menu__category">{t('Data Viz — shape', language)}</div>

      {/* Shared with the Data Stripes menu — the two nodes' radial blocks are
          the same three settings and must not drift. */}
      <RadialRows labelKey="radial" language={language} values={v} onChange={set} />

      <RampColorPorts nodeId={nodeId} />

      <NodeActions nodeId={nodeId} />
    </div>
  );
}

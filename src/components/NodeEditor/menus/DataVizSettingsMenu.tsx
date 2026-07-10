import { useAppStore } from '@/store/useAppStore';
import type { ShaderFlowNode } from '@/types';
import { getNodeValues } from '@/types';
import { rowStyle, labelStyle, NumberRow, NodeActions } from './menuShared';

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
  const nodes = useAppStore((s) => s.nodes);
  const updateNodeData = useAppStore((s) => s.updateNodeData);

  const node = nodes.find((n) => n.id === nodeId) as ShaderFlowNode | undefined;
  if (!node || node.data.registryType !== 'dataviz') return null;

  const v = getNodeValues(node);
  const radial = Number(v.radial ?? 0) >= 0.5;
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
      <div className="context-menu__category">Data Viz — tone</div>

      {/* Pre-scale + shift of the raw normalized value. */}
      {numRow('scale', 'scale', 1)}
      {numRow('offset', 'offset', 0)}

      {/* Input levels: values below low / above high map to the ramp ends. */}
      {numRow('lowCutoff', 'low cutoff', 0, 0.05, 0, 1)}
      {numRow('highCutoff', 'high cutoff', 1, 0.05, 0, 1)}

      {/* Midpoint (gamma): value that maps to the ramp's centre. Lower = brighter. */}
      {numRow('midpoint', 'midpoint', 0.5, 0.02, 0.01, 0.99)}

      {/* Contrast around the midpoint (1 = none). */}
      {numRow('contrast', 'contrast', 1, 0.05, 0)}

      <div className="context-menu__category">Data Viz — shape</div>

      <label style={{ ...rowStyle, cursor: 'pointer' }}>
        <span style={labelStyle}>radial</span>
        <input
          type="checkbox"
          checked={radial}
          onChange={(e) => set({ radial: e.target.checked ? 1 : 0 })}
        />
      </label>

      {radial && (
        <>
          {numRow('center_x', 'center X', 0.5)}
          {numRow('center_y', 'center Y', 0.5)}
          {numRow('radius', 'radius', 0.5, 0.05, 0.05)}
        </>
      )}

      <NodeActions nodeId={nodeId} />
    </div>
  );
}

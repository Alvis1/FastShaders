import { useAppStore } from '@/store/useAppStore';
import { getNodeValues } from '@/types';
import type { ShaderFlowNode } from '@/types';
import { t } from '@/i18n';
import { hasUnitRangeFlag, isUnitRange } from '@/utils/unitRange';
import { rowStyle, labelStyle } from './menuShared';

/**
 * Sine / Cosine: the "Map to 0…1" checkbox. The flag lives in `values.unit`
 * (utils/unitRange.ts), never in `defaultValues`, which on this card is the
 * socket list — a `unit` entry there would become a wireable dead socket.
 * Written as the NUMBER 1 / 0, like the noise range. No history bracket: a
 * checkbox fires one change per click, so `updateNodeData`'s one push is one
 * undo entry.
 */
export function UnitRangeSettings({ nodeId }: { nodeId: string }) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);
  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId)) as ShaderFlowNode | undefined;
  if (!node || !hasUnitRangeFlag(node.data.registryType)) return null;

  const values = getNodeValues(node);
  const unit = isUnitRange(node.data.registryType, values);

  return (
    <label style={{ ...rowStyle, cursor: 'pointer' }}>
      <span style={labelStyle}>{t('Map to 0…1', language)}</span>
      <input
        type="checkbox"
        checked={unit}
        onChange={() => updateNodeData(nodeId, { values: { ...values, unit: unit ? 0 : 1 } })}
        title={t('On: the wave is remapped from −1…1 to 0…1 (½ + ½·wave). Off: the raw −1…1 wave.', language)}
      />
    </label>
  );
}

import { useAppStore } from '@/store/useAppStore';
import { getNodeValues } from '@/types';
import type { ShaderFlowNode } from '@/types';
import { t } from '@/i18n';
import { hasNoiseRangeFlag, isUnsignedNoise } from '@/utils/noiseRange';
import { rowStyle, labelStyle } from './menuShared';

interface NoiseNodeSettingsProps {
  nodeId: string;
}

/**
 * The one noise setting the generic `defaultValues` loop cannot express: which
 * RANGE the node outputs.
 *
 * The flag deliberately lives in `values` and NOT in `def.defaultValues`,
 * because on a noise node that map is the SOCKET list — `PreviewNode` builds a
 * param handle from every key in it — so a `signed` entry there would become a
 * wireable dead socket with an "expose as input socket" checkbox beside it, and
 * would flip `isAtDefaultValues` to false on every node that predates the flag,
 * lighting the destructive Reset button across every built-in preset. Keeping it
 * out of that map is also what makes the "booleans get no expose toggle" rule
 * structural rather than a special case. The Image node's `repeat`/`flipX` are
 * the same precedent.
 *
 * Ticked = signed, so a node with NOTHING stored — every graph saved before the
 * flag existed — reads as ticked, which is the truth about it. The inverse key
 * would have shown those nodes UNticked, i.e. claiming a 0–1 range they do not
 * have.
 */
export function NoiseNodeSettings({ nodeId }: NoiseNodeSettingsProps) {
  const nodes = useAppStore((s) => s.nodes);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);

  const node = nodes.find((n) => n.id === nodeId) as ShaderFlowNode | undefined;
  if (!node || !hasNoiseRangeFlag(node.data.registryType)) return null;

  const values = getNodeValues(node);
  const signed = !isUnsignedNoise(node.data.registryType, values);

  return (
    // Label left / checkbox right, matching the Stripes `radial` row — the
    // generic loop above already puts an expose-port checkbox on the LEFT of
    // every label, and two adjacent checkboxes with different meanings are
    // unreadable. No history bracket: `updateNodeData` pushes once per call and
    // a checkbox fires exactly one change per click, whereas a bracket closes
    // on an idle timer and would collapse two quick toggles into one undo.
    <label style={{ ...rowStyle, cursor: 'pointer' }}>
      <span style={labelStyle}>{t('Signed range (−1…1)', language)}</span>
      <input
        type="checkbox"
        checked={signed}
        // Written as a NUMBER, never a boolean — `values` is typed
        // Record<string, string | number>, and the emitter's read is an exact
        // identity test that a stray boolean would fall through.
        onChange={() => updateNodeData(nodeId, { values: { ...values, signed: signed ? 0 : 1 } })}
        title={t('Off: output remapped to 0…1. On: the raw MaterialX range — round() then gives −1/0/+1, and Discard culls both tails.', language)}
      />
    </label>
  );
}

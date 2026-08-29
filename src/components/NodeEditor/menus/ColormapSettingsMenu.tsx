import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import type { ShaderFlowNode } from '@/types';
import { getNodeValues } from '@/types';
import {
  COLORMAP_GROUPS,
  getColormap,
  colormapGradientCss,
  DEFAULT_COLORMAP_ID,
} from '@/utils/colormaps';
import { rowStyle, labelStyle, NumberRow, NodeActions } from './menuShared';

interface ColormapSettingsMenuProps {
  nodeId: string;
}

/**
 * Right-click settings for the Colormap node: which map, reversed, and how many
 * discrete levels.
 *
 * The picker shows each map as its own GRADIENT rather than a name in a
 * dropdown. Nobody recognises "cividis" from the word; everybody recognises it
 * from the ramp, and the whole point of shipping perceptually uniform maps is
 * that the user can see the difference between one that ramps evenly and one
 * that does not. The group headings carry the reason to choose each family —
 * that is the guidance the scientific-colour literature exists to give, and a
 * bare alphabetical list would throw it away.
 */
export function ColormapSettingsMenu({ nodeId }: ColormapSettingsMenuProps) {
  const nodes = useAppStore((s) => s.nodes);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);

  const node = nodes.find((n) => n.id === nodeId) as ShaderFlowNode | undefined;
  if (!node || node.data.registryType !== 'colormap') return null;

  const v = getNodeValues(node);
  const currentId = String(v.map ?? DEFAULT_COLORMAP_ID);
  const reverse = Number(v.reverse ?? 0) >= 0.5;
  const levels = Math.floor(Number(v.levels ?? 0));
  const set = (patch: Record<string, string | number>) =>
    updateNodeData(nodeId, { values: { ...v, ...patch } });

  return (
    <div className="context-menu__list">
      {COLORMAP_GROUPS.filter((g) => g.maps.length > 0).map((group) => (
        <div key={group.kind}>
          <div className="context-menu__category">{t(group.label, language)}</div>
          {group.maps.map((map) => (
            <button
              key={map.id}
              className="context-menu__item"
              onClick={() => set({ map: map.id })}
              style={{ gap: 'var(--space-2)' }}
              title={map.label}
            >
              <span
                aria-hidden
                style={{
                  width: '52px',
                  height: '10px',
                  flex: '0 0 auto',
                  borderRadius: 0,
                  border: '1px solid var(--border-subtle)',
                  background: colormapGradientCss(map, reverse, levels),
                }}
              />
              <span style={{ flex: 1, textAlign: 'left' }}>{map.label}</span>
              {map.id === currentId && <span aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      ))}

      <div className="context-menu__category">{t('Colormap — options', language)}</div>

      <label style={{ ...rowStyle, cursor: 'pointer' }}>
        <span style={labelStyle}>{t('reverse', language)}</span>
        <input
          type="checkbox"
          checked={reverse}
          onChange={(e) => set({ reverse: e.target.checked ? 1 : 0 })}
        />
      </label>

      {/* 0 or 1 = continuous. Stepping the ramp is how a reader gets countable
          bands out of a gradient — the colour equivalent of contour lines. */}
      <NumberRow
        label={t('levels (0 = smooth)', language)}
        value={levels}
        onCommit={(n) => set({ levels: Math.max(0, Math.round(n)) })}
        step={1}
        min={0}
        max={32}
      />

      {/* The active map, at the size where a lightness ramp is actually
          legible. */}
      <div style={{ padding: 'var(--space-1) var(--space-3)' }}>
        <div
          style={{
            height: '16px',
            borderRadius: 0,
            border: '1px solid var(--border-subtle)',
            background: colormapGradientCss(getColormap(currentId), reverse, levels),
          }}
        />
      </div>

      <NodeActions nodeId={nodeId} />
    </div>
  );
}

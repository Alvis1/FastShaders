import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import type { ShaderFlowNode } from '@/types';
import { getNodeValues } from '@/types';
import { isNormalizeMode, planNormalize, type NormalizeMode } from '@/utils/dataViz';
import { rowStyle, labelStyle, NumberRow, NodeActions } from './menuShared';
import { ColumnStatsRows, useUpstreamColumnStats, formatStat } from './DataColumnStats';

interface DataRangeSettingsMenuProps {
  nodeId: string;
}

/** Mode list with the one-line reason to pick each. The explanations are the
 *  feature — "robust" and "symmetric" are meaningless as bare words, and the
 *  choice between them is the single most consequential decision in a
 *  data-driven picture. */
const MODES: { id: NormalizeMode; label: string; hint: string }[] = [
  { id: 'minmax', label: 'min → max', hint: 'Full range. One outlier squashes everything else.' },
  { id: 'robust', label: 'robust 2–98%', hint: 'Ignores the extreme 2% at each end.' },
  { id: 'symmetric', label: 'zero-centred', hint: 'Zero lands mid-ramp — use with a diverging map.' },
  { id: 'zscore', label: 'z-score ±3σ', hint: 'Distance from the mean in standard deviations.' },
  { id: 'log', label: 'log', hint: 'For data spanning decades. Positive values only.' },
  { id: 'symlog', label: 'symlog', hint: 'Log either side of zero, linear near it.' },
  { id: 'manual', label: 'manual', hint: 'Fix the domain yourself — comparable across shaders.' },
];

/**
 * Right-click settings for the Data Range node.
 *
 * The menu shows the upstream column's statistics AND the resolved domain,
 * because the automatic modes are otherwise invisible: "robust" produces a
 * number the user never sees, and if that number is wrong (a column of mostly
 * zeros, a flat series) the picture is wrong in a way nothing on screen
 * explains. Printing the domain the shader will actually bake makes the mode
 * choice checkable.
 */
export function DataRangeSettingsMenu({ nodeId }: DataRangeSettingsMenuProps) {
  const nodes = useAppStore((s) => s.nodes);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);
  const { stats, name } = useUpstreamColumnStats(nodeId, 'value');

  const node = nodes.find((n) => n.id === nodeId) as ShaderFlowNode | undefined;
  if (!node || node.data.registryType !== 'dataRange') return null;

  const v = getNodeValues(node);
  const mode: NormalizeMode = isNormalizeMode(v.mode) ? v.mode : 'minmax';
  const manual = { lo: Number(v.domainMin ?? 0), hi: Number(v.domainMax ?? 1) };
  const doClamp = Number(v.clamp ?? 1) >= 0.5;
  const set = (patch: Record<string, string | number>) =>
    updateNodeData(nodeId, { values: { ...v, ...patch } });

  // Exactly the plan graphToCode will emit — same function, same inputs.
  const plan = planNormalize(mode, stats, manual);

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">{t('Data Range — mode', language)}</div>
      {MODES.map((m) => (
        <button
          key={m.id}
          className="context-menu__item context-menu__item--stacked"
          onClick={() => set({ mode: m.id })}
          title={m.hint}
        >
          <span>
            {m.id === mode ? '✓ ' : ''}
            {t(m.label, language)}
          </span>
          <span className="context-menu__item-desc">{t(m.hint, language)}</span>
        </button>
      ))}

      {mode === 'manual' && (
        <>
          <NumberRow
            label={t('domain min', language)}
            value={manual.lo}
            onCommit={(n) => set({ domainMin: n })}
            step={0.1}
          />
          <NumberRow
            label={t('domain max', language)}
            value={manual.hi}
            onCommit={(n) => set({ domainMax: n })}
            step={0.1}
          />
        </>
      )}

      <label style={{ ...rowStyle, cursor: 'pointer' }}>
        <span style={labelStyle}>{t('clamp to 0…1', language)}</span>
        <input
          type="checkbox"
          checked={doClamp}
          onChange={(e) => set({ clamp: e.target.checked ? 1 : 0 })}
        />
      </label>

      <ColumnStatsRows stats={stats} name={name} />

      <div className="context-menu__category">{t('resolved domain', language)}</div>
      <div style={rowStyle}>
        <span style={labelStyle}>
          {plan.kind === 'symlog' ? t('±magnitude', language) : t('low … high', language)}
        </span>
        <span style={{ ...labelStyle, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
          {plan.kind === 'symlog'
            ? `±${formatStat(plan.m)}`
            : `${formatStat(plan.lo)} … ${formatStat(plan.hi)}`}
        </span>
      </div>
      {!stats && mode !== 'manual' && (
        <div style={{ ...rowStyle, ...labelStyle, display: 'block' }}>
          {t('No Data column wired — using the manual domain.', language)}
        </div>
      )}

      <NodeActions nodeId={nodeId} />
    </div>
  );
}

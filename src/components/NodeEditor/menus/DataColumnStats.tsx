import { useMemo } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import type { AppNode, ShaderNodeData } from '@/types';
import { getTargetEdges } from '@/engine/cpuEvaluator';
import { columnForHandle } from '@/utils/dataNode';
import { columnStats, type ColumnStats } from '@/utils/dataViz';
import { rowStyle, labelStyle } from './menuShared';

/**
 * The statistics readout for a Data column.
 *
 * This exists because every tone/domain control in the dataviz family is
 * expressed in NORMALIZED units while the data is in its own units — so
 * choosing a cutoff, a midpoint or a manual domain was guesswork unless the
 * user happened to remember what was in the CSV. Costing nothing at render
 * time, showing the numbers is the difference between tuning and fiddling.
 *
 * The samples are the CAPPED column (`columnForHandle`), i.e. exactly what gets
 * baked into the shader — an over-long CSV is mean-downsampled before it ever
 * reaches the GPU, and quoting the pre-cap statistics would describe a dataset
 * the picture was not made from.
 */

/** Compact fixed/exponential formatting — data columns range over many decades
 *  and a plain toFixed turns 1.2e-7 into "0.00". */
export function formatStat(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const mag = Math.abs(v);
  if (mag >= 1e5 || mag < 1e-3) return v.toExponential(2);
  const digits = mag >= 100 ? 1 : mag >= 1 ? 3 : 4;
  return Number(v.toFixed(digits)).toString();
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={{ ...labelStyle, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
        {value}
      </span>
    </div>
  );
}

/** Render the statistics of `column`, or nothing when there is no column. */
export function ColumnStatsRows({ stats, name }: { stats: ColumnStats | null; name?: string }) {
  const language = useAppStore((s) => s.language);
  if (!stats) return null;
  return (
    <>
      <div className="context-menu__category">
        {name ? `${t('data', language)} — ${name}` : t('data', language)}
      </div>
      <StatRow label={t('min / max', language)} value={`${formatStat(stats.min)} … ${formatStat(stats.max)}`} />
      <StatRow label={t('mean ± sd', language)} value={`${formatStat(stats.mean)} ± ${formatStat(stats.sd)}`} />
      <StatRow label={t('2% / 98%', language)} value={`${formatStat(stats.p2)} … ${formatStat(stats.p98)}`} />
      <StatRow label={t('samples', language)} value={String(stats.count)} />
    </>
  );
}

/**
 * Per-column ranges for a Data node's own payload — shown in its settings menu.
 *
 * One line per column rather than the full four-row block: a CSV can carry a
 * dozen columns, and what the user needs at a glance is which column holds
 * which range so they can pick the right socket to wire.
 */
export function DataNodeStats({ nodeId }: { nodeId: string }) {
  const nodes = useAppStore((s) => s.nodes);
  const language = useAppStore((s) => s.language);

  const rows = useMemo(() => {
    const node = nodes.find((n) => n.id === nodeId) as AppNode | undefined;
    const data = node?.data as ShaderNodeData | undefined;
    if (!data || data.registryType !== 'dataNode') return [];
    return (data.dynamicOutputs ?? []).map((port) => {
      const column = columnForHandle(data, port.id);
      return { id: port.id, label: port.label ?? port.id, stats: column ? columnStats(column) : null };
    });
  }, [nodeId, nodes]);

  if (rows.length === 0) return null;

  return (
    <>
      <div className="context-menu__category">{t('columns', language)}</div>
      {rows.map((r) => (
        <div key={r.id} style={rowStyle}>
          <span style={{ ...labelStyle, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</span>
          <span
            style={{ ...labelStyle, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}
          >
            {r.stats ? `${formatStat(r.stats.min)} … ${formatStat(r.stats.max)}` : '—'}
          </span>
        </div>
      ))}
      {rows[0]?.stats && (
        <div style={rowStyle}>
          <span style={labelStyle}>{t('samples', language)}</span>
          <span style={{ ...labelStyle, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
            {rows[0].stats.count}
          </span>
        </div>
      )}
    </>
  );
}

/**
 * Statistics of whatever Data column feeds `nodeId`'s `inputHandle`, or null
 * when nothing traceable is wired. Same one-hop rule as code generation, so the
 * menu shows numbers exactly when the shader can use them.
 */
export function useUpstreamColumnStats(
  nodeId: string,
  inputHandle: string,
): { stats: ColumnStats | null; name: string | undefined } {
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);

  return useMemo(() => {
    // getTargetEdges, NOT a raw scan: graphToCode unwraps at its own entry and
    // then traces the column off the UNWRAPPED edge, so a raw scan would see a
    // collapsed group's boundary edge (source = the GROUP id, which carries no
    // Data payload), report "no statistics" and fall back to the manual domain
    // while codegen still bakes the real min/max — the exact disagreement the
    // dataRange rule exists to prevent ("the numbers on screen are the numbers
    // baked in").
    const edge = getTargetEdges(nodes, edges, nodeId).find((e) => e.targetHandle === inputHandle);
    if (!edge) return { stats: null, name: undefined };
    const src = nodes.find((n) => n.id === edge.source) as AppNode | undefined;
    const data = src?.data as ShaderNodeData | undefined;
    const column = columnForHandle(data, edge.sourceHandle);
    if (!column) return { stats: null, name: undefined };
    const port = data?.dynamicOutputs?.find((o) => o.id === edge.sourceHandle);
    return { stats: columnStats(column), name: port?.label };
  }, [nodeId, inputHandle, nodes, edges]);
}

import { useEffect, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import type { ShaderFlowNode } from '@/types';
import { getNodeValues } from '@/types';
import { isNormalizeMode, planNormalize, type NormalizeMode } from '@/utils/dataViz';
import {
  parseFormula,
  emitFormula,
  formulaEnv,
  defaultFormulaText,
  MAX_FORMULA_CHARS,
  hasCustomFormula,
  FORMULA_VAR_NAMES,
  FORMULA_FUNC_NAMES,
  type FormulaErrorCode,
} from '@/utils/dataRangeFormula';
import { rowStyle, labelStyle, fieldStyle, NumberRow, NodeActions } from './menuShared';
import { ColumnStatsRows, useUpstreamColumnStats } from './DataColumnStats';

interface DataRangeSettingsMenuProps {
  nodeId: string;
}

/** Mode list with the one-line reason to pick each. The explanations are the
 *  feature — "robust" and "symmetric" are meaningless as bare words, and the
 *  choice between them is the single most consequential decision in a
 *  data-driven picture. The seven used to be seven tall stacked buttons; they
 *  are one `<select>` now, with the SELECTED mode's hint rendered beneath it, so
 *  the explanation survives the collapse. */
const MODES: { id: NormalizeMode; label: string; hint: string }[] = [
  { id: 'minmax', label: 'min → max', hint: 'Full range. One outlier squashes everything else.' },
  { id: 'robust', label: 'robust 2–98%', hint: 'Ignores the extreme 2% at each end.' },
  { id: 'symmetric', label: 'zero-centred', hint: 'Zero lands mid-ramp — use with a diverging map.' },
  { id: 'zscore', label: 'z-score ±3σ', hint: 'Distance from the mean in standard deviations.' },
  { id: 'log', label: 'log', hint: 'For data spanning decades. Positive values only.' },
  { id: 'symlog', label: 'symlog', hint: 'Log either side of zero, linear near it.' },
  { id: 'manual', label: 'manual', hint: 'Fix the domain yourself — comparable across shaders.' },
];

/** One sentence per error code. The pure layer holds CODES, never sentences, so
 *  this table is the single place the wording lives and the i18n obligation
 *  stays finite. `absent` never reaches here (it means "no formula"). */
const ERROR_TEXT: Record<FormulaErrorCode, string> = {
  absent: '',
  'too-long': 'Formula is too long',
  'too-complex': 'Formula is too complex',
  'bad-char': 'Unexpected character',
  'bad-number': 'Invalid number',
  'unknown-name': 'Unknown name',
  'not-a-function': 'That is a value, not a function',
  'bad-arity': 'Wrong number of arguments',
  syntax: 'Syntax error',
  'non-finite': 'This formula divides by zero on this data',
};

/**
 * Right-click settings for the Data Range node.
 *
 * Three stacked parts, in the order the work is actually done:
 *
 *   1. From / To — the domain, always visible. In an automatic mode these show
 *      the numbers the METHOD resolved from the wired column, so a mode whose
 *      whole job is invisible ("robust 2–98%" produces a number the user never
 *      sees) becomes checkable. Editing either one switches to `manual` seeded
 *      with those numbers.
 *   2. Method — the seven normalization strategies.
 *   3. Formula — what the shader will evaluate, editable.
 *
 * The menu also prints the column's statistics, because every tone control
 * downstream is in normalized units and without them the user tunes against
 * numbers they cannot see.
 */
export function DataRangeSettingsMenu({ nodeId }: DataRangeSettingsMenuProps) {
  const nodes = useAppStore((s) => s.nodes);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);
  const { stats, name } = useUpstreamColumnStats(nodeId, 'value');

  const node = nodes.find((n) => n.id === nodeId) as ShaderFlowNode | undefined;
  const v = node ? getNodeValues(node) : {};
  // hasCustomFormula, not a bare typeof: a whitespace-only string parses as
  // `absent`, so the shader is already emitting the plain built-in chain and
  // treating it as custom would red-flag a node doing the completely normal
  // thing (and render an error row whose message is the empty string).
  const storedFormula = hasCustomFormula(v.formula) ? v.formula : '';

  // Local draft so a half-typed formula never reaches the store (the NumberRow
  // precedent). Re-seeded when the node's stored text changes underneath us —
  // switching method, undo, or opening the menu on a different node.
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [storedFormula, nodeId]);

  if (!node || node.data.registryType !== 'dataRange') return null;

  const mode: NormalizeMode = isNormalizeMode(v.mode) ? v.mode : 'minmax';
  const manual = { lo: Number(v.domainMin ?? 0), hi: Number(v.domainMax ?? 1) };
  const doClamp = Number(v.clamp ?? 1) >= 0.5;
  const set = (patch: Record<string, string | number>) =>
    updateNodeData(nodeId, { values: { ...v, ...patch } });

  // Exactly the plan graphToCode will emit — same function, same inputs.
  const plan = planNormalize(mode, stats, manual);
  const env = formulaEnv(plan, stats, manual);
  const canonical = defaultFormulaText(plan.kind);
  const shown = draft ?? (storedFormula || canonical);
  const isCustom = storedFormula !== '';

  // The domain the two boxes show. A symlog plan has no lo/hi — it is symmetric
  // about zero by construction, so ±m IS its domain.
  const from = plan.kind === 'symlog' ? -plan.m : plan.lo;
  const to = plan.kind === 'symlog' ? plan.m : plan.hi;

  const parsed = parseFormula(storedFormula);
  const emitted =
    parsed.ok && node ? emitFormula(parsed.ast, 'v', env, () => {}) : null;
  // What the shader really runs: the custom formula when it is usable, the
  // built-in chain otherwise. An error here means the picture no longer matches
  // the box, which is exactly the silence this row exists to break.
  const formulaError = isCustom
    ? !parsed.ok
      ? parsed.err
      : emitted && !emitted.ok
        ? emitted.err
        : null
    : null;

  /**
   * Editing a bound while an automatic method is selected switches to `manual`,
   * seeded from the domain currently on screen — one `updateNodeData`, so it is
   * one undo entry.
   *
   * The alternative is a control that does nothing. A visible, editable box
   * whose value is silently discarded is the failure this codebase has already
   * been burned by (the uniform-seeding trap, where editing the number on a
   * property node had no visible effect and read as the app being broken).
   * Writing the computed numbers back into `domainMin`/`domainMax` on every
   * data change is the other wrong answer — it would clobber the user's stored
   * manual domain behind their back.
   */
  const editBound = (which: 'domainMin' | 'domainMax', n: number) => {
    if (mode === 'manual') {
      set({ [which]: n });
      return;
    }
    set({
      mode: 'manual',
      domainMin: which === 'domainMin' ? n : from,
      domainMax: which === 'domainMax' ? n : to,
    });
  };

  const commitFormula = (text: string) => {
    const next = { ...v };
    // A formula equal to the method's own default is not stored: the built-in
    // emission path then stays the only path for every unmodified node, and the
    // absent key keeps the generated code byte-identical to what this node has
    // always produced.
    if (text.trim() === '' || text.trim() === canonical.trim()) delete next.formula;
    else next.formula = text.slice(0, MAX_FORMULA_CHARS);
    updateNodeData(nodeId, { values: next });
    setDraft(null);
  };

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">{t('Data Range — domain', language)}</div>
      <NumberRow
        label={t('From', language)}
        value={from}
        onCommit={(n) => editBound('domainMin', n)}
        step={0.1}
      />
      <NumberRow
        label={t('To', language)}
        value={to}
        onCommit={(n) => editBound('domainMax', n)}
        step={0.1}
      />
      {mode !== 'manual' && (
        <div style={{ ...rowStyle, ...labelStyle, display: 'block', paddingTop: 0 }}>
          {t('Set by the method. Editing a number switches to manual.', language)}
        </div>
      )}

      <div className="context-menu__category">{t('Method', language)}</div>
      <div style={rowStyle}>
        <select
          className="nodrag"
          value={mode}
          onChange={(e) => {
            // Changing the method reseeds the box from the new method's default,
            // so a stored custom formula goes. Same updateNodeData → one undo
            // entry, so Cmd+Z brings it back.
            const next: Record<string, string | number> = { ...v, mode: e.target.value };
            delete next.formula;
            updateNodeData(nodeId, { values: next });
          }}
          style={{ flex: 1, minWidth: 0 }}
        >
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {t(m.label, language)}
            </option>
          ))}
        </select>
      </div>
      <div style={{ ...rowStyle, ...labelStyle, display: 'block', paddingTop: 0 }}>
        {t(MODES.find((m) => m.id === mode)?.hint ?? '', language)}
      </div>

      <div className="context-menu__category">{t('Formula', language)}</div>
      <div style={{ ...rowStyle, display: 'block' }}>
        <textarea
          className="nodrag"
          rows={2}
          spellCheck={false}
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commitFormula(e.target.value)}
          onKeyDown={(e) => {
            // Enter commits, Shift+Enter is a newline (the formula may be long
            // enough to wrap). Escape reverts the draft — and is caught here so
            // it never reaches ContextMenu's dispatcher-level close.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              (e.target as HTMLTextAreaElement).blur();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setDraft(null);
            }
          }}
          style={{
            ...fieldStyle,
            width: '100%',
            boxSizing: 'border-box',
            fontFamily: 'var(--font-mono)',
            resize: 'vertical',
            ...(formulaError ? { borderColor: 'var(--color-error, #d33)' } : null),
          }}
        />
      </div>
      {formulaError && (
        <div
          style={{
            ...rowStyle,
            ...labelStyle,
            display: 'block',
            paddingTop: 0,
            color: 'var(--color-error, #d33)',
          }}
        >
          {t(ERROR_TEXT[formulaError.code], language)}
          {formulaError.got ? ` — “${formulaError.got}”` : ''}
          {` (${t('position', language)} ${formulaError.at + 1})`}
          <br />
          {t('The shader is using the method’s own formula instead.', language)}
        </div>
      )}
      {isCustom && !formulaError && (
        <div style={{ ...rowStyle, display: 'block', paddingTop: 0 }}>
          <span style={labelStyle}>{t('shader', language)} </span>
          <span
            style={{
              ...labelStyle,
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
              wordBreak: 'break-all',
            }}
          >
            {emitted && emitted.ok ? emitted.code : ''}
          </span>
        </div>
      )}
      <div style={{ ...rowStyle, ...labelStyle, display: 'block', paddingTop: 0 }}>
        {t('Values', language)}: {FORMULA_VAR_NAMES.join(', ')}
        <br />
        {t('Functions', language)}: {FORMULA_FUNC_NAMES.join(', ')}
      </div>
      {isCustom && (
        <button
          className="context-menu__item"
          onClick={() => commitFormula('')}
          title={t('Go back to the formula this method defines', language)}
        >
          {t('Reset to the method’s formula', language)}
        </button>
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

      {!stats && mode !== 'manual' && (
        <div style={{ ...rowStyle, ...labelStyle, display: 'block' }}>
          {t('No Data column wired — using the manual domain.', language)}
        </div>
      )}

      <NodeActions nodeId={nodeId} />
    </div>
  );
}

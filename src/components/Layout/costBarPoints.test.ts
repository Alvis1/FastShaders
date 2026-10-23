/**
 * The cost bar under the fixed 100 (owner, 2026-10-23): every device's budget
 * PRINTS as 100, and devices differ in their node prices alone. Pinned from
 * SOURCE where the rule is a wiring — the vitest env is `node`, so the bar
 * cannot be mounted — and through the one pure export where it is a value:
 *
 *  - the store sums in TABLE points and the bar divides ONCE, after the sum
 *    (`useBudgetPoints`), so rounding never compounds; the figure prints
 *    through <Points> (0.01, a centred dot when rounded) and the total's title
 *    states the EXACT figure, so hovering the number shows what it stands for;
 *  - the budget is POINT_BUDGET, never a device's `maxPoints` — on the meter's
 *    two ends, after the slash, in the device dropdown (no `(200 pts)` beside a
 *    name) and in the intro's copy of the readout;
 *  - the right-click point-cap editor is gone with `fs:costBudgets`: a typed cap
 *    over a fixed 100 would be a second budget nobody measured;
 *  - "Compare devices…" is an ACTION row behind the arrow-nav guard, opening a
 *    new tab, and never offered in a study session (the editor's offer is part
 *    of the condition) or the desktop build (its webview has no tab to open).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { VR_HEADSETS } from '@/store/useAppStore';
import { sanitizeCostMeta } from '@/utils/costOverride';
import { deviceOptionText } from './CostBar';

const SRC = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(SRC, p), 'utf8');

const BAR = read('components/Layout/CostBar.tsx');
const BAR_CSS = read('components/Layout/CostBar.css');
const SCENE = read('intro/BudgetScene.tsx');

const meter = BAR.slice(BAR.indexOf('export function CostMeter('), BAR.indexOf('export interface CostBarProps'));

describe('the readout prints budget points against 100', () => {
  it('divides the summed total once, with the hook every point surface shares', () => {
    expect(BAR).toContain('const points = useBudgetPoints(totalCost);');
    expect(BAR).toContain('const over = points > POINT_BUDGET;');
    // The raw total is never printed or compared against a budget by itself.
    expect(BAR).not.toMatch(/totalCost\s*>/);
    expect(BAR).not.toMatch(/total=\{totalCost\}/);
  });

  it('prints the figure through <Points>, then the fixed budget, on both ends of the meter too', () => {
    expect(meter).toContain('<Points value={points} tip={false} /> / {POINT_BUDGET} {t(\'pts\', language)}');
    expect(meter).toContain('<span className="cost-bar__label-end">0</span>');
    expect(meter).toContain('<span className="cost-bar__label-end">{POINT_BUDGET}</span>');
    expect(meter).toContain('const percentage = Math.min(points / POINT_BUDGET, 1);');
    expect(meter).toContain('const over = points > POINT_BUDGET;');
    expect(meter).not.toMatch(/\bmax\b|maxPoints/);
  });

  it('states the exact figure in the total\'s title — the one tooltip that hover shows', () => {
    expect(BAR).toContain('{ total: formatPoints(points).exact, max: POINT_BUDGET, headset: deviceLabel }');
  });

  it('the intro draws the same readout from the same division', () => {
    expect(SCENE).toContain('const points = useBudgetPoints(total);');
    expect(SCENE).toMatch(/<CostMeter\s+points=\{points\}/);
    expect(SCENE).not.toMatch(/costBudgetOverrides|max=\{|capOverridden/);
  });
});

describe('a device row names the device, never a budget', () => {
  it('prints the label and the provenance mark only', () => {
    for (const h of VR_HEADSETS) expect(deviceOptionText(h)).toBe(h.label);
    const profile = (meta: Record<string, unknown>) => ({ label: 'Rig', maxPoints: 150, meta: sanitizeCostMeta(meta) });
    expect(deviceOptionText(profile({ manual: true }))).toBe('✎ Rig');
    expect(deviceOptionText(profile({ valid: false }))).toBe('⚠ Rig');
    expect(deviceOptionText(profile({ valid: true }))).toBe('◆ Rig');
    for (const p of [profile({ manual: true }), profile({ valid: true })]) expect(deviceOptionText(p)).not.toMatch(/\d/);
  });

  it('the select\'s title says the device sets the PRICES, and states the one budget', () => {
    expect(BAR).not.toContain('sets the points budget');
    expect(BAR).toMatch(/title=\{fillTemplate\(t\('Performance device — sets the per-node prices[^']*\{max\}[^']*', language\), \{ max: POINT_BUDGET \}\)\}/);
  });
});

describe('the point cap is retired', () => {
  it('has no right-click editor, no override and no mark', () => {
    for (const gone of ['onContextMenu', 'cost-cap-menu', "'Point cap'", '<NumberField', 'costBudgetOverride', 'setCostBudgetOverride', 'capOverridden', 'Right-click', 'createPortal']) {
      expect(BAR, gone).not.toContain(gone);
    }
    expect(BAR_CSS).not.toMatch(/\.cost-cap-menu|\.cost-bar__cap-mark/);
  });
});

describe('Compare devices…', () => {
  it('is an action row: a sentinel in the Set the arrow-nav guard reads', () => {
    expect(BAR).toContain("const COMPARE_OPTION = '__compare-devices';");
    expect(BAR).toMatch(/const ACTION_OPTIONS = new Set\(\[[^\]]*\bCOMPARE_OPTION\b[^\]]*\]\);/);
    const change = BAR.slice(BAR.indexOf('const handleDeviceChange = useCallback('), BAR.indexOf('const handlePickedFile'));
    const guard = change.indexOf('if (viaArrowNav) return;');
    const open = change.indexOf("window.open(COMPARE_URL, '_blank', 'noopener')");
    expect(guard).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(guard);
  });

  it('opens the page beside the app, under the build\'s base', () => {
    expect(BAR).toContain('const COMPARE_URL = `${import.meta.env.BASE_URL}compare/`;');
  });

  it('is never offered in a study session or the desktop build', () => {
    expect(BAR).toContain('const OFFERS_COMPARE = !__FS_DESKTOP__ && !isEvalMode();');
    expect(BAR).toContain("{OFFERS_COMPARE && <option value={COMPARE_OPTION}>{t('Compare devices…', language)}</option>}");
    // Exactly one row: the option is the only place the sentinel is rendered.
    expect(BAR.match(/value=\{COMPARE_OPTION\}/g)).toHaveLength(1);
  });
});

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { getNodeValues } from '@/types';
import { t } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import { readRgbCurves, CURVE_MAX_POINTS, CURVE_MIN_POINTS, IDENTITY_CURVE } from '@/utils/rgbCurves';
import { HISTORY_IDLE, makeNode } from '@/test-utils';
import { cleanCurves } from './RgbCurvesSettings';
import { createLutIo, discreteWrite, setCanonical, type LutValues } from './lutEditorGestures';

/**
 * The RGB Curves editor's contracts, pinned in SOURCE where they need a DOM
 * (the colorRampSettings.test.ts pattern; the reasons are the same reviewed
 * defects) and run on the real store where they do not:
 *   - keys typed while focus is in the editor must not reach the canvas
 *     (Delete/X delete the NODE, A selects all, F frames, Space opens Add);
 *   - the editor's own keys act only on the plot, never on a typing target —
 *     Backspace in the X/Y fields must not delete the selected point;
 *   - the X/Y fields have their own gate, so their selection-keyed remount
 *     never ends a drag's undo bracket; a blur ends a held arrow, never a drag;
 *   - each channel's gates keep that channel's reader;
 *   - only the SVG takes touch-action: none, so the menu still scrolls by touch;
 *   - a point is ADDED on a tap, never on the press;
 *   - every limit announces itself (aria-disabled + tooltip, never `disabled`);
 *   - a junk curve on ANOTHER channel, and handle tokens anywhere, survived an
 *     edit ("any edit replaces them").
 */

const src = readFileSync(join(__dirname, 'RgbCurvesSettings.tsx'), 'utf8');

beforeEach(() => {
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
});
afterAll(() => {
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
});

describe('RgbCurvesSettings — key policy', () => {
  it('the root is the shared LutEditorRoot (keys but Escape, Tab and Cmd/Ctrl+S stop there; an ARROW release ends a held arrow)', () => {
    expect(src).toContain('<LutEditorRoot keyGate={keyGate} onKey={onKey}>');
    expect(src).not.toMatch(/onKeyDown=|onKeyUp=/);
    expect(src).not.toContain("e.key !== 'Escape' && e.key !== 'Tab'");
  });

  it('its own keys arrive decoded (the plot, not a typing target): Delete removes, every arrow nudges', () => {
    expect(src).toContain("'data-fs-lut-key': ''");
    const onKey = src.slice(src.indexOf('const onKey = '), src.indexOf('if (!node || !point) return null;'));
    expect(onKey).toMatch(/e\.preventDefault\(\);\s*if \(k\.kind === 'delete'\) remove\(\);\s*else nudge\(k\.dx, k\.dy\);/);
  });

  it('a held arrow is one entry on its own KEY gate: blur finishes it — and never a drag', () => {
    // The plot's blur used to end the SHARED gate, so focus leaving the plot mid-drag split the drag in two.
    expect(src).toContain('onBlur: () => keyGate.finish()');
    const nudge = src.slice(src.indexOf('const nudge = '), src.indexOf('const remove = '));
    expect(nudge).toContain('keyGate.propose(formatCurve(movePoint(cur, sel, p.x + dx, p.y + dy)));');
    expect(src).toMatch(/useBracketedDrag<DragState>\(\{\s*gate: dragGate,/);
  });
});

describe('RgbCurvesSettings — gestures and history', () => {
  it('the number fields have their own gate', () => {
    expect(src).toContain(
      'const { dragGate, keyGate, fieldGate, writeDiscrete } = useLutEditorWrites(nodeId, key, CANONICAL_OF[channel], IDENTITY_CURVE, cleanCurves);',
    );
    const fields = src.slice(src.indexOf('<LazyNumberField'), src.indexOf('<ToolButton'));
    expect(fields.match(/onFinish=\{\(\) => fieldGate\.finish\(\)\}/g)).toHaveLength(2);
    expect(fields).not.toMatch(/(dragGate|keyGate)\./);
  });

  it('each channel\'s gates keep THEIR reader: one module-scope reader per channel, never an inline lambda', () => {
    // An inline reader shared one ref across channels: after a tap on R during a C drag, the drag's gate compared
    // C's next string against R's curve — two entries, and a move making C equal R's curve was dropped.
    const table = src.slice(src.indexOf('const CANONICAL_OF'), src.indexOf('export const cleanCurves'));
    for (const ch of ['c', 'r', 'g', 'b']) expect(table).toContain(`${ch}: (v) => readRgbCurves(v).${ch}.canonical,`);
    expect(src).not.toMatch(/const canonicalOf = \(v/);
    expect(src).not.toMatch(/useLutEditorWrites\([^)]*=>/);
  });

  it('discrete acts (delete, reset, extend) go through the shared discrete write — it closes every gate first', () => {
    const body = src.slice(src.indexOf('export function RgbCurvesSettings'));
    expect(body.match(/writeDiscrete\(\(v\) => \{/g)).toHaveLength(3);
    expect(body).not.toContain('updateNodeData');
    expect(src).not.toContain('writeValues');
  });

  it('touch-action: none on the SVG only, and the SVG is .nowheel and .nodrag (the canvas double-tap pan and draw mode exempt only .nodrag)', () => {
    expect(src.match(/touchAction: 'none'/g)).toHaveLength(1);
    expect(src).toMatch(/className="fs-lut-editor__plot nowheel nodrag"\s*style=\{\{ touchAction: 'none' \}\}/);
  });

  it('a press grabs the NEAREST point whose box holds it — decided by geometry, not by which overlapping box the DOM put on top', () => {
    const start = src.slice(src.indexOf('    start(e'), src.indexOf('    move(s, ev)'));
    expect(start).toContain('const i = pointAt(e, rect, points);');
    expect(start).not.toContain("closest('[data-point]')");
    const fn = src.slice(src.indexOf('function pointAt('), src.indexOf('export function RgbCurvesSettings'));
    expect(fn).toContain('if (Math.abs(dx) > HIT_HALF || Math.abs(dy) > HIT_HALF) continue;');
    expect(fn).toMatch(/if \(d <= bestD\) \{/);
  });

  it('a point is ADDED on a tap, never on the press', () => {
    const tap = src.slice(src.indexOf('    tap(s, ev) {'), src.indexOf('    tap(s, ev) {') + 400);
    expect(tap).toContain('addPoint(');
    const start = src.slice(src.indexOf('    start(e'), src.indexOf('    move(s, ev)'));
    expect(start).not.toContain('addPoint(');
  });

  it('every limit announces itself: the point cap line and the minimum-points button keep a tooltip, from the constants', () => {
    expect(src).toContain('<ToolButton');
    expect(src).not.toMatch(/(?<![-\w])disabled=\{/);
    expect(src).toContain("const capText = fillTemplate(t('A curve holds at most {max} points.', language), { max: CURVE_MAX_POINTS });");
    expect(src).toMatch(/fs-lut-editor__cap" style=\{hintStyle\}>\s*\{capText\}/);
    expect(src).toContain("fillTemplate(t('A curve needs at least {min} points.', language), { min: CURVE_MIN_POINTS })");
    expect(src).not.toMatch(/\b32\b|two points/);
    const filled: [string, Record<string, number>, number][] = [
      ['A curve holds at most {max} points.', { max: CURVE_MAX_POINTS }, CURVE_MAX_POINTS],
      ['A curve needs at least {min} points.', { min: CURVE_MIN_POINTS }, CURVE_MIN_POINTS],
    ];
    for (const [key, vals, n] of filled) {
      expect(t(key, 'lv'), key).not.toBe(key);
      for (const lang of ['en', 'lv'] as const) expect(fillTemplate(t(key, lang), vals)).toContain(String(n));
    }
  });
});

describe('RgbCurvesSettings — review fixes', () => {
  it('a junk stored extend is announced; the Extend select asks the ONE vocabulary predicate', () => {
    expect(src).toContain('{curves.rejectedExtend && (');
    expect(src).toContain("t('The stored extend mode could not be read, so Extrapolated is used. Any edit replaces it.', language)");
    expect(src).toContain('if (!isCurveExtend(next)) return;');
    expect(src).toContain("setCanonical(v, 'extend', next, 'extrapolate');");
    expect(src).not.toMatch(/v\.extend !== 'horizontal' && v\.extend !== 'extrapolate'/);
  });

  it('the texture budget is announced', () => {
    expect(src).toContain('<TextureBudgetNotice language={language} />');
  });
});

describe('RgbCurvesSettings — any edit replaces what the reader rejected, on EVERY channel', () => {
  it('cleanCurves drops junk curves on any channel and a junk extend, and re-stores handle tokens canonically', () => {
    const v: LutValues = {
      color: 1,
      curveC: '0 0,1 0.8',
      curveR: 'garbage',
      curveG: '0 0 vector,0.5 0.6 auto,1 1',
      curveB: '0 0 auto,1 1 auto',
      extend: 'sideways',
    };
    const before = readRgbCurves(v);
    expect(before.rejectedChannels).toEqual(['R']);
    expect(before.rejectedExtend).toBe(true);
    cleanCurves(v);
    // R dropped; G re-spelled without its handle tokens; B's canonical is the straight line, so it goes ABSENT.
    expect(v).toEqual({ color: 1, curveC: '0 0,1 0.8', curveG: '0 0,0.5 0.6,1 1' });
    const after = readRgbCurves(v);
    expect(after.rejectedChannels).toEqual([]);
    expect(after.rejectedExtend).toBe(false);
    expect(['c', 'r', 'g', 'b'].some((ch) => after[ch as 'c'].droppedHandles)).toBe(false);
    // Nothing on screen moves: every curve and the extend mode read exactly as before.
    for (const ch of ['c', 'r', 'g', 'b'] as const) expect(after[ch].canonical).toBe(before[ch].canonical);
    expect(after.extend).toBe(before.extend);
  });

  it('cleanCurves leaves a node with nothing rejected or re-spelled EXACTLY as it was (clean nodes emit byte-identical code)', () => {
    const clean: LutValues[] = [
      {},
      { curveC: '' },
      { curveR: '0 0,0.50 0.25,1 1', extend: 'extrapolate' },
      { curveC: IDENTITY_CURVE, curveB: '0 0.1,1 0.9', extend: 'horizontal', fac: 0.5 },
    ];
    for (const values of clean) {
      const v: LutValues = { ...values };
      cleanCurves(v);
      expect(v).toEqual(values);
    }
  });

  it('a drag on C drops a junk R and re-spells G\'s handle tokens — the notices and the code comment go with them', () => {
    useAppStore.setState({
      nodes: [makeNode('rc', 'rgbCurves', { curveC: '0 0,1 0.8', curveR: 'garbage', curveG: '0 0 vector,0.5 0.6 auto,1 1' })],
    });
    const io = createLutIo('rc', 'curveC', (v) => readRgbCurves(v).c.canonical, IDENTITY_CURVE, cleanCurves);
    io.write('0 0,1 0.7');
    const v = getNodeValues(useAppStore.getState().nodes[0]);
    expect(v).toEqual({ curveC: '0 0,1 0.7', curveG: '0 0,0.5 0.6,1 1' });
    expect(readRgbCurves(v).rejectedChannels).toEqual([]);
  });

  it('an Extend pick cleans the other keys too', () => {
    useAppStore.setState({ nodes: [makeNode('rc', 'rgbCurves', { curveR: 'garbage', curveB: '0 0 auto,1 0.5' })] });
    const horizontal = (v: LutValues) => {
      setCanonical(v, 'extend', 'horizontal', 'extrapolate');
      return true;
    };
    expect(discreteWrite('rc', horizontal, cleanCurves, () => {})).toBe(true);
    expect(getNodeValues(useAppStore.getState().nodes[0])).toEqual({ extend: 'horizontal', curveB: '0 0,1 0.5' });
    expect(useAppStore.getState().past).toHaveLength(1);
  });
});

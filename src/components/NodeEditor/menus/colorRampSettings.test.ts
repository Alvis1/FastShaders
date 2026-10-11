import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { getNodeValues } from '@/types';
import { nodeDescription, t } from '@/i18n';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { fillTemplate } from '@/utils/fillTemplate';
import { readColorRamp, RAMP_MAX_STOPS, DEFAULT_RAMP_STOPS } from '@/utils/colorRamp';
import { HISTORY_IDLE, makeNode } from '@/test-utils';
import { cleanRamp } from './ColorRampSettings';
import { createLutIo, discreteWrite, setCanonical, type LutValues } from './lutEditorGestures';

/**
 * The Color Ramp editor's contracts, pinned in SOURCE where they need a DOM
 * (the vitest env has none — the historyBracketing / colorPickerHistory
 * pattern) and run on the real store where they do not. Each line here is a
 * defect a reviewer found:
 *   - keys typed while focus is in the editor must not reach the canvas
 *     (Delete/X delete the NODE, A selects all, F frames, Space opens Add);
 *   - the editor's own keys act only on a marker, never on a typing target —
 *     React bubbles keys from the PORTALLED colour picker's hex field to this
 *     root, and Backspace there must not delete the stop;
 *   - Position proposes once (a live position re-sorts per keystroke);
 *   - the picker runs history="none" behind the lazy idle write, keyed on the
 *     selection;
 *   - only the SVG takes touch-action: none, so the menu still scrolls by touch;
 *   - focus follows the stop it is on — a drag past a neighbour left it on the
 *     neighbour's slot;
 *   - junk `stops` survived an interpolation pick ("any edit replaces it").
 * The root, the own-key decoding, the stepper, the tool button and the
 * discrete write are the shared shell's (lutEditorGestures.test.ts).
 */

const src = readFileSync(join(__dirname, 'ColorRampSettings.tsx'), 'utf8');

beforeEach(() => {
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
});
afterAll(() => {
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
});

describe('ColorRampSettings — key policy', () => {
  it('the root is the shared LutEditorRoot (keys but Escape, Tab and Cmd/Ctrl+S stop there; an ARROW release ends a held arrow)', () => {
    expect(src).toContain('<LutEditorRoot rootRef={rootRef} keyGate={keyGate} onKey={onKey}>');
    expect(src).not.toMatch(/onKeyDown=|onKeyUp=/);
    expect(src).not.toContain("e.key !== 'Escape' && e.key !== 'Tab'");
  });

  it('its own keys arrive decoded (a marker, not a typing target): Delete removes and refocuses, Left/Right nudge', () => {
    expect(src).toContain('data-fs-lut-key=""');
    const onKey = src.slice(src.indexOf('const onKey = '), src.indexOf('if (!node || !stop) return null;'));
    expect(onKey).toMatch(/if \(key\.kind === 'delete'\) \{\s*e\.preventDefault\(\);/);
    // A stop has no y: Up/Down are not the ramp's, and keep their default.
    expect(onKey).toMatch(/\} else if \(key\.dx !== 0\) \{[\s\S]*?e\.preventDefault\(\);\s*nudge\(key\.dx\);/);
  });

  it('a held arrow is one entry on its own KEY gate: blur finishes it — except a refocus the editor makes itself — and never a drag', () => {
    expect(src).toMatch(/onBlur=\{\(\) => \{\s*if \(!refocusingRef\.current\) keyGate\.finish\(\);\s*\}\}/);
    const nudge = src.slice(src.indexOf('const nudge = '), src.indexOf('/** Remove the selected stop'));
    expect(nudge).toContain('if (keyGate.propose(formatRampStops(r.stops))) {');
    expect(src).toMatch(/useBracketedDrag<DragState>\(\{\s*gate: dragGate,/);
  });
});

describe('ColorRampSettings — gestures and history', () => {
  it('Position proposes ONCE (live={false}); Alpha stays live', () => {
    const pos = src.slice(src.indexOf("label={t('Position', language)}"));
    expect(pos.slice(0, 200)).toContain('live={false}');
    const alpha = src.slice(src.indexOf("label={t('Alpha', language)}"));
    expect(alpha.slice(0, 200)).not.toContain('live={false}');
  });

  it('the number fields have their own gate: their selection-keyed remount must never end a drag', () => {
    expect(src).toContain(
      "const { dragGate, keyGate, fieldGate, writeDiscrete } = useLutEditorWrites(nodeId, 'stops', canonicalOf, DEFAULT_RAMP_STOPS, cleanRamp, pick.close);",
    );
    const fields = src.slice(src.indexOf('<LazyNumberField'), src.indexOf('<StopColor'));
    expect(fields.match(/onFinish=\{\(\) => fieldGate\.finish\(\)\}/g)).toHaveLength(2);
    expect(fields).not.toMatch(/(dragGate|keyGate)\./);
  });

  it('the stop colour is a lazily bracketed picker keyed on the selection', () => {
    expect(src).toMatch(/<StopColor\s+key=\{sel\}/);
    expect(src).toContain('const pick = useLazyIdleWrite(');
    expect(src).toContain('history="none"');
  });

  it('the pick\'s idle bracket ends before ANY other act: the gates open through it, the discrete writes and a selection change close it', () => {
    // Its bracket stays open for the idle window after the last pick; a "+", flip, interpolation, bar tap, typed
    // number or marker drag inside it folded into the pick's undo entry (one Cmd+Z reverted both). `pick.close` is
    // the gates' and the discrete writes' `closeFirst` (lutEditorGestures.test.ts pins what that closes).
    expect(src.indexOf('const pick = useLazyIdleWrite(')).toBeLessThan(src.indexOf('useLutEditorWrites(nodeId'));
    const writes = src.slice(src.indexOf('const writeStops = '), src.indexOf('const markerHasFocus = '));
    expect(writes.match(/writeDiscrete\(\(v\) => \{/g)).toHaveLength(2);
    expect(writes).not.toContain('updateNodeData');
    expect(src).toContain('useEffect(() => pick.close, [sel, pick]);');
  });

  it('touch-action: none on the SVG only, and the SVG is .nowheel and .nodrag (the canvas double-tap pan and draw mode exempt only .nodrag)', () => {
    expect(src.match(/touchAction: 'none'/g)).toHaveLength(1);
    expect(src).toMatch(/<svg\s+className="fs-lut-editor__hit nowheel nodrag"[\s\S]{0,200}style=\{\{ touchAction: 'none' \}\}/);
  });

  it('a stop is ADDED on a tap, never on the press', () => {
    const tap = src.slice(src.indexOf('    tap(s, ev) {'), src.indexOf('    tap(s, ev) {') + 400);
    expect(tap).toContain('addStopAt(');
    const start = src.slice(src.indexOf('    start(e'), src.indexOf('    move(s, ev)'));
    expect(start).not.toContain('addStopAt(');
  });

  it('every limit announces itself: the stop cap and the one-stop button keep a tooltip (the shared ToolButton, aria-disabled)', () => {
    expect(src).toContain('<ToolButton');
    expect(src).not.toMatch(/(?<![-\w])disabled=\{/);
    expect(src).toContain("t('A ramp needs at least one stop.', language)");
    // The cap is printed from RAMP_MAX_STOPS, in the title and the line under the editor — never a typed 32.
    expect(src).toContain("const capText = fillTemplate(t('A ramp holds at most {max} stops.', language), { max: RAMP_MAX_STOPS });");
    expect(src).toContain('title={atCap ? capText');
    expect(src).toMatch(/fs-lut-editor__cap" style=\{hintStyle\}>\s*\{capText\}/);
    expect(src).not.toMatch(/\b32\b/);
    const KEY = 'A ramp holds at most {max} stops.';
    expect(t(KEY, 'lv')).not.toBe(KEY);
    for (const lang of ['en', 'lv'] as const) expect(fillTemplate(t(KEY, lang), { max: RAMP_MAX_STOPS })).toContain(String(RAMP_MAX_STOPS));
  });

  it('the node DESCRIPTION states the same cap — an accepted literal, held to RAMP_MAX_STOPS here', () => {
    // A description is spliced by node type and translated WHOLE (registry/descriptionSplice, i18n
    // `nodeDescription`), with no placeholder path, so its count is written out in both languages. This pin is
    // what makes a change to the cap fail until both are re-worded.
    const en = NODE_REGISTRY.get('colorRamp')?.description;
    expect(en).toContain(`up to ${RAMP_MAX_STOPS} stops`);
    expect(nodeDescription(en, 'colorRamp', 'lv')).toContain(`līdz ${RAMP_MAX_STOPS} pieturām`);
  });
});

describe('ColorRampSettings — review fixes', () => {
  const start = src.slice(src.indexOf('    start(e'), src.indexOf('    move(s, ev)'));

  it('a marker press commits a pending Position edit FIRST, then follows the pressed stop to its new index', () => {
    // The press read `data-stop` (an index of the last render), and only then did focus() blur the Position field,
    // whose commit re-sorted the stops — the drag moved, and a tap selected, whichever stop slid into that slot.
    const blur = start.indexOf('active.blur()');
    const remap = start.indexOf('indexAfterMove(i, moved.from, moved.to)');
    const focus = start.indexOf('.focus?.(');
    expect(blur).toBeGreaterThan(-1);
    expect(remap).toBeGreaterThan(blur);
    expect(focus).toBeGreaterThan(remap);
    // The selection is set LAST (after the field's own setSel during the blur), and the drag carries the new index.
    expect(start.lastIndexOf('setSel(at)')).toBeGreaterThan(focus);
    expect(start).toContain("return { kind: 'stop', index: at, rect };");
    // The Position field records the re-sort it committed.
    expect(src).toMatch(/fieldGate\.propose\(formatRampStops\(r\.stops\)\)\) \{\s*fieldMoveRef\.current = \{ from: sel, to: r\.index \};/);
  });

  it('a junk stored interpolation is reported APART from the stops, and every write path cleans', () => {
    expect(src).toContain('{ramp.rejectedStops && (');
    expect(src).toContain('{ramp.rejectedInterp && (');
    expect(src).toContain("t('The stored interpolation could not be read, so Linear is used. Any edit replaces it.', language)");
    expect(src).not.toContain('{ramp.rejected && (');
    // Every write path takes the ONE clean: the picker's idle write, and the three gates plus the discrete write.
    expect(src.match(/DEFAULT_RAMP_STOPS, cleanRamp[,)]/g)).toHaveLength(2);
    expect(src).not.toContain('dropJunk');
  });

  it('the texture budget is announced', () => {
    expect(src).toContain('<TextureBudgetNotice language={language} />');
  });
});

describe('ColorRampSettings — any edit replaces what the reader rejected, on EITHER key', () => {
  it('cleanRamp drops junk stops and a junk interpolation — each already reads as its default', () => {
    const v: LutValues = { fac: 0.5, stops: 'garbage', interp: 'Ease' };
    expect(readColorRamp(v).rejectedStops).toBe(true);
    expect(readColorRamp(v).rejectedInterp).toBe(true);
    const before = readColorRamp(v);
    cleanRamp(v);
    expect(v).toEqual({ fac: 0.5 });
    // Nothing on screen moves: the same canonical stops and interpolation as before the drop.
    expect(readColorRamp(v).canonical).toBe(before.canonical);
    expect(readColorRamp(v).interp).toBe(before.interp);
    const nonString: LutValues = { stops: 7 };
    cleanRamp(nonString);
    expect(nonString).toEqual({});
  });

  it('cleanRamp leaves a node with nothing rejected EXACTLY as it was (clean nodes emit byte-identical code)', () => {
    const clean: LutValues[] = [{}, { stops: '' }, { stops: '0 #FF0000 1,1 #0000ff 0.50', interp: 'ease' }, { fac: 0.2, stops: DEFAULT_RAMP_STOPS }];
    for (const values of clean) {
      const v: LutValues = { ...values };
      cleanRamp(v);
      expect(v).toEqual(values);
    }
  });

  it('an interpolation pick over junk stops drops them — notice and code comment go with them', () => {
    useAppStore.setState({ nodes: [makeNode('cr', 'colorRamp', { fac: 0.5, stops: 'garbage' })] });
    const pickEase = (v: LutValues) => {
      setCanonical(v, 'interp', 'ease', 'linear');
      return true;
    };
    expect(discreteWrite('cr', pickEase, cleanRamp, () => {})).toBe(true);
    const v = getNodeValues(useAppStore.getState().nodes[0]);
    expect(v).toEqual({ fac: 0.5, interp: 'ease' });
    expect(readColorRamp(v).rejectedStops).toBe(false);
    expect(useAppStore.getState().past).toHaveLength(1);
  });

  it('a stop gesture over a junk interpolation drops it (the gates\' io takes the clean)', () => {
    useAppStore.setState({ nodes: [makeNode('cr', 'colorRamp', { interp: 'sideways' })] });
    const io = createLutIo('cr', 'stops', (v) => readColorRamp(v).canonical, DEFAULT_RAMP_STOPS, cleanRamp);
    io.write('0 #000000 1,1 #ff0000 1');
    expect(getNodeValues(useAppStore.getState().nodes[0])).toEqual({ stops: '0 #000000 1,1 #ff0000 1' });
  });

  it('both discrete acts go through the shared discrete write (it runs the clean and closes every gesture first)', () => {
    const writeStops = src.slice(src.indexOf('const writeStops = '), src.indexOf('const writeInterp = '));
    expect(writeStops).toMatch(/if \(canon === readColorRamp\(v\)\.canonical\) return false;\s*setCanonical\(v, 'stops', canon, DEFAULT_RAMP_STOPS\);/);
    const writeInterp = src.slice(src.indexOf('const writeInterp = '), src.indexOf('const markerHasFocus = '));
    expect(writeInterp).toMatch(/if \(next === 'linear' \? v\.interp === undefined : v\.interp === next\) return false;\s*setCanonical\(v, 'interp', next, 'linear'\);/);
  });
});

describe('ColorRampSettings — focus and hits (review 2026-10-09)', () => {
  const start = src.slice(src.indexOf('    start(e'), src.indexOf('    move(s, ev)'));

  it('a press anywhere on the bar commits a pending Position/Alpha edit FIRST and focuses a marker — the add branch too', () => {
    // A bar tap used to add a stop with the edit still pending: Enter then moved the NEW stop, and an Alpha
    // bracket swallowed the add. The blur is no longer inside the marker branch.
    const blur = start.indexOf('active.blur()');
    expect(blur).toBeGreaterThan(-1);
    expect(start.slice(0, blur)).not.toMatch(/if \(hit\) \{/);
    expect(blur).toBeLessThan(start.indexOf("if (hit) return { kind: 'stop', index: at, rect };"));
    expect(start).toContain("return { kind: 'add', rect };");
    expect(start).toContain('if (moved) i = hit ? indexAfterMove(i, moved.from, moved.to) : moved.to;');
  });

  it('focus never falls to <body> under an act of the editor: each act that unmounts or re-indexes the focused element names its successor', () => {
    // On <body> the next Delete reached the canvas's window handler and deleted the NODE.
    expect(src).toMatch(/const after = remove\(\);\s*if \(after !== null\) refocusRef\.current = `\[data-stop="\$\{after\}"\]`;/);
    expect(src).toMatch(/if \(r\.index !== sel\) refocusRef\.current = `\[data-stop="\$\{r\.index\}"\]`;/);
    const tap = src.slice(src.indexOf('    tap(s, ev) {'), src.indexOf('    tap(s, ev) {') + 500);
    expect(tap).toContain('refocusRef.current = `[data-stop="${r.index}"]`;');
    // Enter in Position (keyed on the selection) re-sorts: focus goes to the new field — a blur commit is left be.
    expect(src).toContain('fieldId="pos"');
    expect(src).toContain("document.activeElement?.getAttribute('data-fs-lut-field') === 'pos'");
    // The layout effect consumes the request once, after the act has rendered.
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{\s*const selector = refocusRef\.current;\s*if \(selector === null\) return;\s*refocusRef\.current = null;/);
    expect(src).toContain('rootRef={rootRef}');
  });

  it('a DRAG carrying a stop past its neighbour moves focus with it, as a nudge does — while a marker holds focus', () => {
    // Measured in Chrome: after a mouse drag of red past blue, focus, aria-valuenow and the focus ring stayed on
    // blue's slot while the selection (and the next arrow or Delete) was red.
    const move = src.slice(src.indexOf('    move(s, ev)'), src.indexOf('    tap(s, ev) {'));
    expect(move).toMatch(
      /const r = moveStop\(cur, s\.index, u\);\s*if \(r\.index !== s\.index && markerHasFocus\(\)\) refocusRef\.current = `\[data-stop="\$\{r\.index\}"\]`;\s*s\.index = r\.index;/,
    );
    const has = src.slice(src.indexOf('const markerHasFocus = '), src.indexOf('const drag = '));
    expect(has).toContain("a.hasAttribute('data-stop') && !!rootRef.current?.contains(a)");
  });

  it('nearest marker wins, and the strip above the markers always adds', () => {
    // Overlapping full-height boxes let the later stop take a press aimed at its neighbour, and from 11 evenly
    // spaced stops on they covered the whole bar, so tap-to-add was impossible.
    expect(src).toContain('const GRAB_TOP = STRIP_H - 8;');
    // Decided by geometry: two markers closer than a marker's width overlap, and the DOM gave the press to the
    // later one even at the other's centre (measured: 0.49 red / 0.51 blue).
    expect(start).toContain('const grabbed = stopAt(e, rect, stops);');
    expect(start).not.toContain("closest('[data-stop]')");
    const fn = src.slice(src.indexOf('function stopAt('), src.indexOf('export function ColorRampSettings'));
    expect(fn).toContain('if (y < GRAB_TOP) return null;');
    expect(fn).toMatch(/if \(d <= HIT_HALF_W && d <= bestD\) \{/);
    expect(src).toContain('const left = i > 0 ? Math.max(x - HIT_HALF_W, (stops[i - 1].pos * BAR_W + x) / 2) : x - HIT_HALF_W;');
    expect(src).toContain('const right = i < stops.length - 1 ? Math.min(x + HIT_HALF_W, (x + stops[i + 1].pos * BAR_W) / 2) : x + HIT_HALF_W;');
    expect(src).toContain('<rect x={left} y={GRAB_TOP} width={Math.max(0, right - left)} height={BAR_H - GRAB_TOP} fill="transparent" />');
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NumberField, type NumberFieldProps } from './NumberField';
import { fieldWheelText, formatFieldNumber, parseFieldNumber, stepFieldText } from '@/utils/numberField';
import { isRoundingOnlyCommit } from '@/components/NodeEditor/menus/ParamRow';

/**
 * The app's number field (components/inputs/NumberField.tsx) and the sites that
 * must use it. Only the LUT editors' field had moved off `<input
 * type="number">`, so every other number field still drew the browser's
 * localized `0,5958`. The text rule itself is utils/numberField.test.ts; this
 * file pins what the node env can see of the component (its rendered markup)
 * and that no number field is left on the native input. The key and wheel
 * wiring is the pure `fieldKeyAction`/`fieldWheelText`, tested there.
 */

const SRC = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
/** Source with comments removed, so prose that NAMES the native input never counts as one. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const render = (props: Partial<NumberFieldProps>) =>
  renderToStaticMarkup(createElement(NumberField, { text: '0.5', onText: () => {}, value: 0.5, step: 0.1, ...props }));

describe('NumberField — what it renders', () => {
  it('is a TEXT input showing the caller\'s text, announced as a spinbutton with its value and range', () => {
    const html = render({ min: 0, max: 1 });
    expect(html).toContain('type="text"');
    expect(html).not.toContain('type="number"');
    expect(html).toContain('value="0.5"');
    expect(html).toContain('role="spinbutton"');
    expect(html).toContain('aria-valuenow="0.5"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="1"');
    expect(html).toMatch(/autocomplete="off"/i);
    expect(html).toMatch(/spellcheck="false"/i);
    // A text field takes a touch keyboard's autocorrect and capitalisation, which the number input never did.
    expect(html).toMatch(/autocorrect="off"/i);
    expect(html).toMatch(/autocapitalize="off"/i);
  });

  it('asks for a keypad only where its range has no negatives (iOS\'s decimal and numeric keypads have no minus)', () => {
    expect(render({ min: 0 })).toMatch(/inputmode="decimal"/i);
    expect(render({ min: 1, integer: true })).toMatch(/inputmode="numeric"/i);
    expect(render({})).toMatch(/inputmode="text"/i);
    expect(render({ min: -10 })).toMatch(/inputmode="text"/i);
  });

  it('has no spinbutton value for a junk number, and passes the site\'s own attributes through', () => {
    const html = render({ value: NaN, text: '', className: 'x-field', title: 'Min', 'aria-label': 'radius' });
    expect(html).not.toContain('aria-valuenow');
    expect(html).toContain('class="x-field"');
    expect(html).toContain('title="Min"');
    expect(html).toContain('aria-label="radius"');
  });
});

describe('every number field is the shared one', () => {
  /** Every component file under src. */
  const tsxFiles = (() => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.tsx')) out.push(relative(SRC, p));
      }
    };
    walk(SRC);
    return out;
  })();

  it('no component renders <input type="number"> — it draws the browser\'s localized separator', () => {
    expect(tsxFiles.length).toBeGreaterThan(50);
    const offenders = tsxFiles.filter((f) => /\btype=\{?["']number["']\}?/.test(code(read(f))));
    expect(offenders).toEqual([]);
  });

  it.each([
    ['components/NodeEditor/inputs/DragNumberInput.tsx', 'the edit box of every drag number (nodes and settings menus)'],
    ['components/NodeEditor/menus/menuShared.tsx', 'NumberRow (Stripes, Data Viz, Colormap, Data Range, the sink menus)'],
    ['components/Layout/CostBar.tsx', 'the point cap'],
    ['components/Preview/ShaderPreview.tsx', 'a uniform slider\'s min and max'],
  ])('%s renders it (%s)', (rel) => {
    expect(code(read(rel))).toContain('<NumberField');
  });

  it('the text rule has ONE home: utils/numberField.ts', () => {
    for (const fn of ['parseFieldNumber', 'formatFieldNumber']) {
      const homes = [...tsxFiles, ...walkTs()].filter((f) => new RegExp(`function ${fn}\\b`).test(read(f)));
      expect(homes, fn).toEqual(['utils/numberField.ts']);
    }
  });

  it('a typed NumberRow number is held to the row\'s range, as a step is', () => {
    expect(code(read('components/NodeEditor/menus/menuShared.tsx'))).toContain('clampFieldNumber(parseFieldNumber(raw) ?? NaN, min, max)');
  });

  it('a step that leaves the text as it is — at a bound — is swallowed but reports nothing', () => {
    // The native input fired no change there. Reporting the unchanged text made NumberRow (which commits every report,
    // inside a history bracket) push an undo entry that restored nothing and empty the redo stack, per arrow or wheel
    // notch at midpoint's 0.99 (measured in Chrome). The comparison is against the text, never a closed-over value:
    // two wheel notches land before a re-render, so a value-based test skipped a second notch BACK and left the field
    // at 1 with the store at 1.05 (measured too). Both paths still take the event, so the caret and the menu stay put.
    const field = code(read('components/inputs/NumberField.tsx'));
    expect(field).toMatch(/e\.preventDefault\(\);\s*if \(action\.text !== text\) onText\(action\.text\);/);
    expect(field).toMatch(/e\.preventDefault\(\);\s*if \(next === l\.text\) return;\s*l\.text = next;\s*l\.onText\(next\);/);
    // At a bound the step rule really does hand back the same text, which is what the field compares against.
    expect(stepFieldText('0.99', 0.99, 1, false, { step: 0.02, min: 0.01, max: 0.99 })).toBe('0.99');
    expect(fieldWheelText({ deltaX: 0, deltaY: -100, shiftKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false }, '1', 1, { step: 10, max: 1 })).toBe('1');
  });

  it('the point cap takes focus once its popover is SHOWN — a `visibility: hidden` input refuses focus', () => {
    // It focused in the frame before measurement: the text looked selected while every key went to the page.
    const bar = code(read('components/Layout/CostBar.tsx'));
    expect(bar).toContain("visibility: capPos ? 'visible' : 'hidden'");
    expect(bar).toMatch(/if \(!capMenuAt \|\| !capPos\) return;\s*const input = capInputRef\.current;\s*if \(input\) \{ input\.focus\(\); input\.select\(\); \}\s*\}, \[capMenuAt, capPos\]\);/);
    expect(bar.match(/input\.focus\(\)/g)).toHaveLength(1);
  });

  it('DragNumberInput opens at 4 places and commits through the shared parse (ParamRow\'s rounding guard assumes both)', () => {
    const drag = code(read('components/NodeEditor/inputs/DragNumberInput.tsx'));
    expect(drag).toContain('setEditText(formatFieldNumber(value, 4));');
    expect(drag).toMatch(/const num = parseFieldNumber\(editText\);\s*if \(num !== null\) onChange\(num\);/);
    expect(read('components/NodeEditor/menus/ParamRow.tsx')).toContain('const EDIT_DECIMALS = 4;');
  });

  it('a click in and out of a ParamRow\'s drag number writes no rounding: what the box shows and commits, the guard knows', () => {
    // The edit box opens at formatFieldNumber(value, 4) and Enter/blur commit parseFieldNumber of that text, typed or not.
    // Whatever comes back is either the stored number itself (the row writes it, as it always has) or exactly the
    // rounding isRoundingOnlyCommit refuses — never a third number, which would round an import on a click.
    const stored = [0.30358983848622445, -0.30358983848622445, 0.1 + 0.2, 1 / 3, -1 / 3, 0.5, -0.5, 0, -0.00004, 0.00005, 12345.678901, -7.25e-3, 2 ** 52 + 0.5, 1e21, 123456789.987654];
    for (let k = 1; k < 60; k++) stored.push(Math.sin(k * 12.9898) * 10 ** ((k % 9) - 4));
    for (const n of stored) {
      const committed = parseFieldNumber(formatFieldNumber(n, 4));
      expect(committed, String(n)).not.toBeNull();
      expect(committed === n || isRoundingOnlyCommit(committed!, n), `${n} → ${committed}`).toBe(true);
    }
    // A junk stored number opens an EMPTY box, which commits nothing.
    for (const n of [NaN, Infinity, -Infinity]) expect(parseFieldNumber(formatFieldNumber(n, 4))).toBeNull();
  });
});

/** Every non-test .ts file under src. */
function walkTs(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) out.push(relative(SRC, p));
    }
  };
  walk(SRC);
  return out;
}

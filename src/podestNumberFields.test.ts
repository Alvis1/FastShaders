import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { formatFieldNumber, parseFieldNumber } from '@/utils/numberField';

/**
 * Podest's uniform panel (public/podest.html) is a standalone vanilla page: it
 * cannot import utils/numberField.ts, so it carries a TWIN of the editor's one
 * number-field text rule — a field SHOWS a dot whatever the locale and TAKES
 * "." or ",". Its value and min/max boxes were `<input type="number">`, which
 * drew "0,5" on a Latvian machine: the editor's C11 defect, in the one page
 * the editor's fix could not reach. Compared by BEHAVIOUR over a corpus (the
 * soundAnalysis twin precedent), never as text.
 */
const PODEST = readFileSync(new URL('../public/podest.html', import.meta.url), 'utf8');

/** A two-space-indented `function name(` … `\n  }` out of podest's script. */
function fnSource(name: string): string {
  const start = PODEST.indexOf(`\n  function ${name}(`);
  expect(start, `podest.html no longer defines ${name}`).toBeGreaterThan(-1);
  const end = PODEST.indexOf('\n  }', start + 1);
  return PODEST.slice(start, end + '\n  }'.length);
}
const twin = <T,>(name: string, ...globals: string[]) => (...values: unknown[]) =>
  new Function(...globals, `${fnSource(name)}\nreturn ${name};`)(...values) as T;

describe('podest.html number fields — a twin of utils/numberField.ts', () => {
  it('reads typed text exactly as the editor does', () => {
    const parse = twin<(raw: unknown) => number | null>('parseFieldNumber')();
    const corpus = [
      '0.25', '0,25', '-0,5', '+3', ' .25 ', '3.', '3,', '0', '-0', '007', '1e3', '2.5E-4', '1,5e3', '-.5e-3', '1e+21',
      '', ' ', '-', '.', ',', 'e5', '1e', '1e+', '0x10', '0b1', 'Infinity', '-Infinity', 'NaN', '1,2,3', '1.2.3',
      '1,000.5', '1 000', '١٢', '--1', '+-1', '1e400', '5px', '0,5958', '-12,75',
    ];
    for (const s of corpus) expect(parse(s), JSON.stringify(s)).toBe(parseFieldNumber(s));
  });

  it('shows a number exactly as the editor does — a dot, the float noise cut, EMPTY for junk', () => {
    const format = twin<(n: unknown, d?: number) => string>('formatFieldNumber')();
    const values: unknown[] = [0, -0, 1, -1, 0.5, 0.5958, 0.1 + 0.2, -1e-9, 1e21, 1.5e300, 123456789012.34567, 2 ** 52 + 0.5,
      1 / 3, Math.PI * 1e5, -7.25e-3, 99.999999, NaN, Infinity, -Infinity];
    // A fixed sweep (a seeded LCG), so a failure names a value the next run reproduces.
    let seed = 0x5eed;
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    for (let i = 0; i < 300; i++) values.push((rand() - 0.5) * 10 ** Math.floor(rand() * 14 - 5));
    for (const n of values) {
      for (const d of [undefined, 4, 0]) {
        expect(format(n, d), `${String(n)} @ ${String(d)}`).toBe(formatFieldNumber(n as number, d));
      }
    }
    // A stored bound out of fs:viewerBounds is adversarial: anything not a number shows nothing, and never throws.
    for (const junk of ['5', null, undefined, {}, [], true]) expect(format(junk)).toBe('');
  });

  it('the value and min/max boxes are TEXT fields read and shown through the twin', () => {
    const at = PODEST.indexOf('function onUniforms(');
    const body = PODEST.slice(at, PODEST.indexOf('\n  }', at));
    expect(body).not.toContain('type="number"');
    expect(body).toContain('var NUM = \'type="text" inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"\';');
    for (const cls of ['u-val', 'u-min', 'u-max']) expect(body).toContain(`<input class="${cls}" ' + NUM + ' />`);
    for (const field of ['valInput', 'minInput', 'maxInput']) {
      expect(body).toContain(`parseFieldNumber(${field}.value)`);
      expect(body).not.toContain(`parseFloat(${field}.value)`);
    }
    expect(body).toContain('valInput.value = formatFieldNumber(v, 4);');
    expect(body).toContain('minInput.value = formatFieldNumber(b.min); maxInput.value = formatFieldNumber(b.max);');
    // The one number input left is the cycle's whole seconds (step 1), which never shows a separator.
    const numbers = PODEST.match(/<input[^>]*type="number"[^>]*>/g) ?? [];
    expect(numbers).toHaveLength(1);
    expect(numbers[0]).toContain('id="cycle-dur"');
    expect(numbers[0]).toContain('step="1"');
  });

  it('a stored bound is used only when both ends are finite numbers, and the store is a plain object', () => {
    const valid = twin<(b: unknown) => boolean>('validBounds')();
    expect(valid({ min: -1, max: 2 })).toBe(true);
    for (const junk of [null, 5, 'x', [], {}, { min: 0 }, { min: '0', max: 1 }, { min: 0, max: Infinity }, { min: NaN, max: 1 }, { min: 0, max: { toString: 1 } }]) {
      expect(valid(junk), JSON.stringify(junk) ?? String(junk)).toBe(false);
    }
    const loadWith = (stored: string | null) =>
      twin<() => unknown>('loadBounds', 'localStorage')({ getItem: () => stored })();
    expect(loadWith('{"a":{"min":0,"max":1}}')).toEqual({ a: { min: 0, max: 1 } });
    for (const junk of [null, '', '5', '[]', '"x"', 'null', 'true', '{oops']) expect(loadWith(junk), String(junk)).toEqual({});
  });
});

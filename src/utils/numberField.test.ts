import { describe, it, expect } from 'vitest';
import {
  parseFieldNumber,
  formatFieldNumber,
  clampFieldNumber,
  stepFieldText,
  fieldKeyAction,
  fieldWheelText,
  fieldInputMode,
  type FieldKey,
  type FieldWheel,
} from './numberField';

/**
 * The ONE text rule of every number field (utils/numberField.ts). The defect it
 * closes: only the LUT editors' field had moved off `<input type="number">`, so
 * the settings menus, a node's edit box, the uniform bounds and the point cap
 * still drew `0,5958` on a Latvian machine and read typed text the browser's
 * way. Every field now shows a dot and takes a dot or a comma through these.
 */

describe('parseFieldNumber — a dot or a comma, decimal notation', () => {
  it('takes either decimal separator, a sign, and a bare leading or trailing point', () => {
    expect(parseFieldNumber('0.25')).toBe(0.25);
    expect(parseFieldNumber('0,25')).toBe(0.25);
    expect(parseFieldNumber('-0,5')).toBe(-0.5);
    expect(parseFieldNumber('+3')).toBe(3);
    expect(parseFieldNumber(' .25 ')).toBe(0.25);
    expect(parseFieldNumber('3.')).toBe(3);
    expect(parseFieldNumber('3,')).toBe(3);
  });

  it('takes an exponent, as the number input did (and as the format prints a huge value)', () => {
    expect(parseFieldNumber('1e3')).toBe(1000);
    expect(parseFieldNumber('2.5E-4')).toBe(0.00025);
    expect(parseFieldNumber('1,5e3')).toBe(1500);
    expect(parseFieldNumber('-.5e-3')).toBe(-0.0005);
    expect(parseFieldNumber('1e+21')).toBe(1e21);
  });

  it('is null while the text is not a number yet, and for what Number() would coerce', () => {
    for (const bad of ['', ' ', '-', '.', ',', 'e5', '1e', '1e+', '0x10', '0b1', 'Infinity', '-Infinity', 'NaN', '1,2,3', '1.2.3', '1,000.5', '1 000', '١٢', '--1', '+-1', '1e400', '5px']) {
      expect(parseFieldNumber(bad), bad).toBeNull();
    }
  });
});

describe('formatFieldNumber — a dot whatever the locale', () => {
  it('prints a JS number\'s own text with the float noise cut', () => {
    expect(formatFieldNumber(0.5958)).toBe('0.5958');
    expect(formatFieldNumber(-0.5)).toBe('-0.5');
    expect(formatFieldNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatFieldNumber(200)).toBe('200');
    expect(formatFieldNumber(-1e-9)).toBe('0'); // never "-0"
    expect(formatFieldNumber(-0)).toBe('0');
    expect(formatFieldNumber(0.000001)).toBe('0.000001');
  });

  it('rounds to the asked places — DragNumberInput opens its edit box at 4', () => {
    expect(formatFieldNumber(0.30358983848622445, 4)).toBe('0.3036');
    expect(formatFieldNumber(12.5, 0)).toBe('13');
  });

  it('is EMPTY for a non-finite value — a junk stored value must not read as a real 0', () => {
    for (const n of [NaN, Infinity, -Infinity]) expect(formatFieldNumber(n)).toBe('');
  });

  it('keeps a huge value exact instead of overflowing the rounding', () => {
    expect(formatFieldNumber(1e21)).toBe('1e+21');
    expect(formatFieldNumber(1.5e300)).toBe('1.5e+300');
    expect(formatFieldNumber(123456789012.34567)).toBe(String(123456789012.34567));
  });

  it('never prints a comma, and reads back what it prints', () => {
    const values = [0, 1, -1, 0.5, 0.5958, -0.0005, 1 / 3, Math.PI * 1e5, 2 ** 52 + 0.5, 1e21, -7.25e-3, 99.999999, 0.30358983848622445];
    // A fixed sweep (a seeded LCG), so a failure names a value the next run reproduces.
    let seed = 0x2f6b1d;
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    for (let i = 0; i < 200; i++) values.push((rand() - 0.5) * 10 ** Math.floor(rand() * 12 - 4));
    for (const n of values) {
      for (const decimals of [4, 6]) {
        const shown = formatFieldNumber(n, decimals);
        expect(shown, String(n)).not.toContain(',');
        const back = parseFieldNumber(shown);
        expect(back, shown).not.toBeNull();
        // What ParamRow's isRoundingOnlyCommit assumes the edit box commits: the value rounded at `decimals`,
        // compared with `===` as the guard does (a -0 shows, and reads back, as 0).
        const f = 10 ** decimals;
        const expected = Math.abs(n * f) < Number.MAX_SAFE_INTEGER ? Math.round(n * f) / f : n;
        expect(back === expected, `${n} → ${shown} → ${back}`).toBe(true);
      }
    }
  });
});

describe('clampFieldNumber', () => {
  it('holds a number inside the bounds it is given, and only those', () => {
    expect(clampFieldNumber(-1, 0, 1)).toBe(0);
    expect(clampFieldNumber(2, 0, 1)).toBe(1);
    expect(clampFieldNumber(0.5, 0, 1)).toBe(0.5);
    expect(clampFieldNumber(-5, undefined, 1)).toBe(-5);
    expect(clampFieldNumber(50, 0)).toBe(50);
    expect(clampFieldNumber(0, 0.05)).toBe(0.05);
    expect(Number.isNaN(clampFieldNumber(NaN, 0, 1))).toBe(true);
  });
});

describe('stepFieldText — one step rule for the arrow keys and the wheel', () => {
  const range = { step: 0.05, min: 0, max: 1 };

  it('steps the SHOWN text, ×10 with Shift, clamped, without float noise', () => {
    expect(stepFieldText('0.5', 0.5, 1, false, range)).toBe('0.55');
    expect(stepFieldText('0.5', 0.5, -1, false, range)).toBe('0.45');
    expect(stepFieldText('0.5', 0.5, 1, true, range)).toBe('1');
    expect(stepFieldText('0.98', 0.98, 1, false, range)).toBe('1');
    expect(stepFieldText('0.02', 0.02, -1, false, range)).toBe('0');
    expect(stepFieldText('0.1', 0.1, 1, false, { step: 0.2 })).toBe('0.3');
    // A comma draft steps too, and comes back with a dot.
    expect(stepFieldText('0,25', 0.5, 1, false, range)).toBe('0.3');
  });

  it('is plain ± step, never snapped to a min + k·step grid (the cap stepped 200 to 201)', () => {
    expect(stepFieldText('200', 200, 1, false, { step: 10, min: 1 })).toBe('210');
    expect(stepFieldText('0.5958', 0.5958, 1, false, { step: 0.02, min: 0.01, max: 0.99 })).toBe('0.6158');
  });

  it('steps from the committed value while the text does not parse, and from 0 when neither is a number', () => {
    expect(stepFieldText('1e', 2, 1, false, { step: 1 })).toBe('3');
    expect(stepFieldText('', NaN, 1, false, { step: 0.1 })).toBe('0.1');
    expect(stepFieldText('', NaN, -1, false, { step: 0.1, min: 0 })).toBe('0');
  });

  it('treats a step that is no positive number as 1', () => {
    for (const step of [0, -2, NaN, Infinity]) expect(stepFieldText('5', 5, 1, false, { step })).toBe('6');
  });
});

describe('fieldKeyAction — what a key does in a field', () => {
  const key = (k: string, mods: Partial<FieldKey> = {}): FieldKey => ({
    key: k,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    ...mods,
  });
  const range = { step: 0.1, min: -1, max: 1 };

  it('reports Enter and Escape — each caller decides what they commit or cancel', () => {
    expect(fieldKeyAction(key('Enter'), '0.5', 0.5, range)).toEqual({ kind: 'enter' });
    expect(fieldKeyAction(key('Escape'), '0.5', 0.5, range)).toEqual({ kind: 'escape' });
  });

  it('steps on ArrowUp/ArrowDown, ×10 with Shift', () => {
    expect(fieldKeyAction(key('ArrowUp'), '0.5', 0.5, range)).toEqual({ kind: 'step', text: '0.6' });
    expect(fieldKeyAction(key('ArrowDown'), '0.5', 0.5, range)).toEqual({ kind: 'step', text: '0.4' });
    expect(fieldKeyAction(key('ArrowDown', { shiftKey: true }), '0.5', 0.5, range)).toEqual({ kind: 'step', text: '-0.5' });
  });

  it('leaves Alt/Ctrl/Cmd+Arrow to the caret, and every other key to the text field', () => {
    for (const mods of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      expect(fieldKeyAction(key('ArrowUp', mods), '0.5', 0.5, range)).toBeNull();
    }
    for (const k of ['ArrowLeft', 'ArrowRight', 'Tab', '1', ',', 'Backspace', 'Home']) expect(fieldKeyAction(key(k), '0.5', 0.5, range)).toBeNull();
  });

  it('does nothing mid-composition: the IME owns Enter, Escape and the arrows', () => {
    for (const k of ['Enter', 'Escape', 'ArrowUp', 'ArrowDown']) {
      expect(fieldKeyAction(key(k, { isComposing: true }), '0.5', 0.5, range)).toBeNull();
    }
  });
});

describe('fieldWheelText — the focused field\'s wheel step', () => {
  const wheel = (deltaY: number, mods: Partial<FieldWheel> = {}): FieldWheel => ({
    deltaX: 0,
    deltaY,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    ...mods,
  });
  const range = { step: 1 };

  it('a notch away from you steps up, towards you down; Shift ×10', () => {
    expect(fieldWheelText(wheel(-100), '0', 0, range)).toBe('1');
    expect(fieldWheelText(wheel(3), '0', 0, range)).toBe('-1');
    expect(fieldWheelText(wheel(-1, { shiftKey: true }), '0', 0, range)).toBe('10');
  });

  it('takes a Shift notch that arrives SIDEWAYS — how macOS and Chrome on Windows deliver a Shift+wheel from a mouse', () => {
    // deltaY is 0 there, and a field that read only deltaY ignored the notch: Shift ×10 never fired from a mouse.
    expect(fieldWheelText(wheel(0, { deltaX: -100, shiftKey: true }), '0', 0, range)).toBe('10');
    expect(fieldWheelText(wheel(0, { deltaX: 120, shiftKey: true }), '0', 0, range)).toBe('-10');
    // A vertical delta still decides when there is one.
    expect(fieldWheelText(wheel(100, { deltaX: -100, shiftKey: true }), '0', 0, range)).toBe('-10');
  });

  it('leaves alone a wheel something else took — over a node the canvas zooms — a zoom gesture, and a sideways one', () => {
    expect(fieldWheelText(wheel(-100, { defaultPrevented: true }), '0', 0, range)).toBeNull();
    expect(fieldWheelText(wheel(-100, { ctrlKey: true }), '0', 0, range)).toBeNull();
    expect(fieldWheelText(wheel(-100, { metaKey: true }), '0', 0, range)).toBeNull();
    expect(fieldWheelText(wheel(0), '0', 0, range)).toBeNull();
    expect(fieldWheelText(wheel(NaN), '0', 0, range)).toBeNull();
    // Without Shift a sideways wheel is a trackpad swipe, never a step.
    expect(fieldWheelText(wheel(0, { deltaX: -100 }), '0', 0, range)).toBeNull();
    expect(fieldWheelText(wheel(0, { deltaX: NaN, shiftKey: true }), '0', 0, range)).toBeNull();
    expect(fieldWheelText(wheel(0, { deltaX: -100, shiftKey: true, defaultPrevented: true }), '0', 0, range)).toBeNull();
  });
});

describe('fieldInputMode — the keypad a field may ask for', () => {
  it('never a keypad without a minus key for a field that may go negative', () => {
    // iOS's decimal and numeric keypads have NO minus key.
    expect(fieldInputMode(undefined)).toBe('text');
    expect(fieldInputMode(-1)).toBe('text');
    expect(fieldInputMode(-5, true)).toBe('text');
    expect(fieldInputMode(NaN)).toBe('text');
  });

  it('a decimal keypad from a min of 0 up, digits only for whole numbers', () => {
    expect(fieldInputMode(0)).toBe('decimal');
    expect(fieldInputMode(0.05)).toBe('decimal');
    expect(fieldInputMode(0, true)).toBe('numeric');
    expect(fieldInputMode(1, true)).toBe('numeric');
  });
});

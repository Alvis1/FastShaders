import { describe, it, expect } from 'vitest';
import {
  DRAG_PX_PER_STEP,
  dragOffset,
  dragRate,
  dragStep,
  dragStepAt,
  formatDragStep,
  stepDecimals,
} from './dragNumberStep';

/** A drag moves a node's number in whole steps (dragNumberStep.ts). */
describe('dragOffset', () => {
  const px = (steps: number) => steps * DRAG_PX_PER_STEP;

  it('plain: one step per DRAG_PX_PER_STEP pixels, constant rate, either way', () => {
    expect(dragOffset(0, 0.1, 'plain')).toBe(0);
    expect(dragOffset(px(1) - 1, 0.1, 'plain')).toBe(0);
    expect(dragOffset(px(1), 0.1, 'plain')).toBeCloseTo(0.1);
    expect(dragOffset(px(3), 0.1, 'plain')).toBeCloseTo(0.3);
    expect(dragOffset(-px(3), 0.1, 'plain')).toBeCloseTo(-0.3);
    // No acceleration: far out, still one step per notch.
    expect(dragOffset(px(200), 0.1, 'plain')).toBeCloseTo(20);
    // A whole-number field steps by 1.
    expect(dragOffset(px(4), 1, 'plain')).toBe(4);
  });

  it('owner, 2026-11-16: steps of 0.1, with Ctrl 1, with Shift 0.01', () => {
    expect(dragOffset(px(1), undefined, 'plain')).toBeCloseTo(0.1);
    expect(dragOffset(px(1), undefined, 'coarse')).toBeCloseTo(1);
    expect(dragOffset(px(1), undefined, 'fine')).toBeCloseTo(0.01);
    // Constant at every rate: no ×100 tier further out any more.
    expect(dragOffset(px(30), 0.1, 'coarse')).toBeCloseTo(30);
    expect(dragOffset(-px(30), 0.1, 'fine')).toBeCloseTo(-0.3);
  });

  it('a whole-number field keeps its own step under Shift (it cannot hold a tenth)', () => {
    expect(dragStepAt(1, 'fine')).toBe(1);
    expect(dragStepAt(1, 'coarse')).toBe(10);
    expect(dragOffset(px(3), 1, 'fine')).toBe(3);
    // A fractional field's finer step is a tenth of its own.
    expect(dragStepAt(0.05, 'fine')).toBeCloseTo(0.005);
    expect(dragStepAt(0.05, 'coarse')).toBeCloseTo(0.5);
  });

  it('counts a fractional pointer distance the way it reads (521.97 − 431.97 is 90 px)', () => {
    expect(dragOffset(521.97 - 431.97, 1, 'plain')).toBe(9);
    expect(dragOffset(431.97 - 521.97, 1, 'plain')).toBe(-9);
  });

  it('a junk step drags by 0.1; a junk distance not at all', () => {
    for (const s of [0, -1, NaN, Infinity]) expect(dragStep(s)).toBe(0.1);
    expect(dragStep(0.005)).toBe(0.005);
    expect(dragOffset(NaN, 0.1, 'plain')).toBe(0);
  });
});

describe('dragRate', () => {
  const keys = (shiftKey: boolean, ctrlKey: boolean, metaKey: boolean) => ({ shiftKey, ctrlKey, metaKey });

  it('Ctrl or ⌘ coarse, Shift fine, Shift first when both are held', () => {
    expect(dragRate(keys(false, false, false))).toBe('plain');
    expect(dragRate(keys(false, true, false))).toBe('coarse');
    expect(dragRate(keys(false, false, true))).toBe('coarse');
    expect(dragRate(keys(true, false, false))).toBe('fine');
    expect(dragRate(keys(true, true, false))).toBe('fine');
  });
});

describe('the step readout', () => {
  it('rounds a dragged value to at least the step’s own decimals', () => {
    expect(stepDecimals(0.1, 0)).toBe(1);
    expect(stepDecimals(0.01, 0)).toBe(2);
    expect(stepDecimals(0.005, 0)).toBe(3);
    expect(stepDecimals(1, 0)).toBe(0);
    expect(stepDecimals(10, 0)).toBe(0);
    expect(stepDecimals(0.00005, 4)).toBe(5);
    expect(stepDecimals(0.1, 4)).toBe(4);
    expect(stepDecimals(NaN, 4)).toBe(4);
  });

  it('prints with a dot and no float noise', () => {
    expect(formatDragStep(0.1 * 10)).toBe('1');
    expect(formatDragStep(0.1 * 3)).toBe('0.3');
    expect(formatDragStep(0.1 / 10)).toBe('0.01');
    expect(formatDragStep(0.001 * 100)).toBe('0.1');
    expect(formatDragStep(0.0001)).toBe('0.0001');
  });
});

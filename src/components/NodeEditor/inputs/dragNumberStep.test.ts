import { describe, it, expect } from 'vitest';
import { COARSE_NEAR_STEPS, DRAG_PX_PER_STEP, dragOffset, dragStep, dragStepNow, formatDragStep } from './dragNumberStep';

/** A drag moves a node's number in whole steps (dragNumberStep.ts). */
describe('dragOffset', () => {
  const px = (steps: number) => steps * DRAG_PX_PER_STEP;

  it('plain: one step per DRAG_PX_PER_STEP pixels, constant rate, either way', () => {
    expect(dragOffset(0, 0.1, false)).toBe(0);
    expect(dragOffset(px(1) - 1, 0.1, false)).toBe(0);
    expect(dragOffset(px(1), 0.1, false)).toBeCloseTo(0.1);
    expect(dragOffset(px(3), 0.1, false)).toBeCloseTo(0.3);
    expect(dragOffset(-px(3), 0.1, false)).toBeCloseTo(-0.3);
    // No acceleration: far out, still one step per notch.
    expect(dragOffset(px(200), 0.1, false)).toBeCloseTo(20);
    // A whole-number field steps by 1.
    expect(dragOffset(px(4), 1, false)).toBe(4);
  });

  it('Shift: ×10 per step near the start, ×100 past COARSE_NEAR_STEPS', () => {
    expect(dragOffset(px(1), 0.1, true)).toBeCloseTo(1);
    expect(dragOffset(px(COARSE_NEAR_STEPS), 0.1, true)).toBeCloseTo(COARSE_NEAR_STEPS);
    expect(dragOffset(px(COARSE_NEAR_STEPS + 1), 0.1, true)).toBeCloseTo(COARSE_NEAR_STEPS + 10);
    expect(dragOffset(px(COARSE_NEAR_STEPS + 3), 0.1, true)).toBeCloseTo(COARSE_NEAR_STEPS + 30);
    expect(dragOffset(-px(COARSE_NEAR_STEPS + 1), 0.1, true)).toBeCloseTo(-(COARSE_NEAR_STEPS + 10));
  });

  it('counts a fractional pointer distance the way it reads (521.97 − 431.97 is 90 px)', () => {
    expect(dragOffset(521.97 - 431.97, 1, false)).toBe(9);
    expect(dragOffset(431.97 - 521.97, 1, false)).toBe(-9);
  });

  it('a junk step drags by 0.1; a junk distance not at all', () => {
    for (const s of [0, -1, NaN, Infinity]) expect(dragStep(s)).toBe(0.1);
    expect(dragStep(0.005)).toBe(0.005);
    expect(dragOffset(NaN, 0.1, false)).toBe(0);
  });
});

/** The readout above a dragged number (DragNumberInput's step chip). */
describe('dragStepNow', () => {
  const px = (steps: number) => steps * DRAG_PX_PER_STEP;

  it('plain: the field’s own step, however far the drag goes', () => {
    expect(dragStepNow(0, 0.1, false)).toBe(0.1);
    expect(dragStepNow(px(500), 0.1, false)).toBe(0.1);
    expect(dragStepNow(px(3), 1, false)).toBe(1);
    expect(dragStepNow(px(3), undefined, false)).toBe(0.1);
  });

  it('Shift: ten steps while near the start, a hundred where dragOffset’s rate changes', () => {
    expect(dragStepNow(0, 0.1, true)).toBeCloseTo(1);
    expect(dragStepNow(px(COARSE_NEAR_STEPS - 1), 0.1, true)).toBeCloseTo(1);
    expect(dragStepNow(px(COARSE_NEAR_STEPS), 0.1, true)).toBeCloseTo(10);
    expect(dragStepNow(-px(COARSE_NEAR_STEPS), 0.1, true)).toBeCloseTo(10);
    // The readout agrees with the value: the step past the boundary adds 100×.
    const at = dragOffset(px(COARSE_NEAR_STEPS), 0.1, true);
    expect(dragOffset(px(COARSE_NEAR_STEPS + 1), 0.1, true) - at).toBeCloseTo(dragStepNow(px(COARSE_NEAR_STEPS), 0.1, true));
  });

  it('prints with a dot and no float noise', () => {
    expect(formatDragStep(0.1 * 10)).toBe('1');
    expect(formatDragStep(0.1 * 3)).toBe('0.3');
    expect(formatDragStep(0.001 * 100)).toBe('0.1');
    expect(formatDragStep(0.0001)).toBe('0.0001');
  });
});

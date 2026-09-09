/**
 * The Sound node's geometry, pinned as ARITHMETIC rather than as literals.
 *
 * The numbers are a judgement about how the node should look and are expected
 * to move — they did on 2026-09-09, when the node was shortened from 118 to
 * 103. What must NOT move are the relationships that stop the layout breaking
 * silently, because every one of them fails as "looks slightly off" rather than
 * as an error, on three surfaces at once (the canvas node, the asset tile, and
 * auto-layout's footprint, which all read this module).
 */
import { describe, it, expect } from 'vitest';
import {
  SOUND_W, SOUND_BODY_W, SOUND_BODY_H, MIC_PARAM_TOPS, MIC_CHIP_H,
  SOUND_METER_TOP, MIC_METER_H, SOUND_BTN_TOP, MIC_OUT_TOPS, MIC_PAD_X,
} from './soundGeometry';

/** `.shader-node__sound-btn` in ShaderNode.css. */
const LIGHT_D = 40;
/** `--handle-size` at the coarse-pointer bump (tokens.css). */
const SOCKET_D = 12;
/** The compact DragNumberInput: `calc(12px * --node-text-scale)`. */
const VALUE_H = 12;

describe('the Sound node fits inside itself', () => {
  it('keeps every output socket INSIDE the card, at touch size', () => {
    // The real floor on the node's height. A socket is centred on the border
    // and half-overflows horizontally by design; hanging off the BOTTOM edge
    // just looks broken.
    for (const t of MIC_OUT_TOPS) {
      expect(t - SOCKET_D / 2, `output at ${t} escapes the top`).toBeGreaterThanOrEqual(0);
      expect(t + SOCKET_D / 2, `output at ${t} escapes the bottom`).toBeLessThanOrEqual(SOUND_BODY_H);
    }
  });

  it('spaces the outputs so their discs never touch', () => {
    const gaps = MIC_OUT_TOPS.slice(1).map((t, i) => t - MIC_OUT_TOPS[i]);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(SOCKET_D + 4);
    expect(new Set(gaps).size, 'the outputs are no longer evenly spread').toBe(1);
  });

  it('leaves the value chips room for the widget inside them', () => {
    expect(MIC_CHIP_H).toBeGreaterThanOrEqual(VALUE_H);
    // …and they must not overlap each other, or the two rows fuse.
    const [a, b] = MIC_PARAM_TOPS;
    expect(b - a).toBeGreaterThanOrEqual(MIC_CHIP_H);
    expect(a - MIC_CHIP_H / 2).toBeGreaterThanOrEqual(0);
  });

  it('stacks chips, meter and light without collisions', () => {
    const chipBottom = MIC_PARAM_TOPS[1] + MIC_CHIP_H / 2;
    const meterTop = SOUND_METER_TOP - MIC_METER_H / 2;
    const meterBottom = SOUND_METER_TOP + MIC_METER_H / 2;
    const lightTop = SOUND_BTN_TOP - LIGHT_D / 2;
    expect(meterTop).toBeGreaterThanOrEqual(chipBottom);
    expect(lightTop).toBeGreaterThanOrEqual(meterBottom);
    expect(SOUND_BTN_TOP + LIGHT_D / 2).toBeLessThanOrEqual(SOUND_BODY_H);
  });

  it('keeps the arm light the face of the node — nearly the full width', () => {
    expect(LIGHT_D).toBeLessThanOrEqual(SOUND_BODY_W);
    expect(LIGHT_D / SOUND_BODY_W).toBeGreaterThan(0.55);
  });

  it('insets the full-width rows without letting them vanish', () => {
    expect(SOUND_BODY_W - 2 * MIC_PAD_X).toBeGreaterThan(20);
    expect(SOUND_BODY_W).toBe(SOUND_W - 3);
  });
});

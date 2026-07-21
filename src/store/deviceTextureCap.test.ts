import { describe, it, expect } from 'vitest';
import { VR_HEADSETS, deviceMaxTextureDim } from './useAppStore';

/**
 * The per-device image texture cap: every headset preset declares a
 * `maxTextureDim` that bounds a dropped image's longest side (see
 * `encodeImageFile`). It is an upper bound — the per-image byte budget can
 * shrink further — so it only needs to stay within the GPU's guaranteed range.
 */
describe('device texture caps', () => {
  it('every headset preset has a sane maxTextureDim', () => {
    for (const h of VR_HEADSETS) {
      expect(Number.isInteger(h.maxTextureDim), `${h.id} cap must be an integer`).toBe(true);
      expect(h.maxTextureDim, `${h.id} cap too small`).toBeGreaterThanOrEqual(512);
      // WebGPU guarantees maxTextureDimension2D >= 8192; never exceed it.
      expect(h.maxTextureDim, `${h.id} cap over the guaranteed GPU limit`).toBeLessThanOrEqual(8192);
    }
  });

  it('deviceMaxTextureDim returns the matching preset cap', () => {
    for (const h of VR_HEADSETS) {
      expect(deviceMaxTextureDim(h.id)).toBe(h.maxTextureDim);
    }
  });

  it('falls back to the first preset for an unknown headset id', () => {
    expect(deviceMaxTextureDim('does-not-exist')).toBe(VR_HEADSETS[0].maxTextureDim);
  });
});

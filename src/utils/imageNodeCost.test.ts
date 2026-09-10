import { describe, it, expect, afterEach } from 'vitest';
import {
  imageNodeCost,
  nodeCostPoints,
  getCost,
  setCostOverrides,
  IMAGE_COST_REF_SIDE,
  IMAGE_COST_FLOOR_SIDE,
  IMAGE_COST_MIN_SCALE,
  IMAGE_COST_MAX_DIM,
} from './nodeCost';
import { makeNode } from '../test-utils';

afterEach(() => setCostOverrides(null));

const img = (values: Record<string, unknown>) =>
  makeNode('img', 'imageNode', { imageB64: 'data:image/png;base64,AAAA', ...values } as Record<string, string | number>);
const price = (w: unknown, h: unknown) => nodeCostPoints(img({ width: w, height: h } as Record<string, unknown>), []);
const base = () => getCost('imageNode');

/**
 * The Image node's price is a DISCOUNT from the table value by stored
 * resolution. Every pin here reads `nodeCostPoints` — what the badge and the
 * CostBar actually charge — never the JSON scalar, which is the anchor and
 * not the price (textureSampleCost.test.ts bounds the anchor).
 */
describe('imageNodeCost — the anchor', () => {
  it('charges EXACTLY the table value at the largest size the app produces', () => {
    // The authored 10 was derived for "a mipmapped texture of up to ~16 MB",
    // i.e. the 2048² the shipped Quest 3 profile caps drops at — so a
    // full-size image pays the table and no existing graph reprices UPWARD.
    expect(price(IMAGE_COST_REF_SIDE, IMAGE_COST_REF_SIDE)).toBe(base());
    // Above the reference (a profile with a bigger cap, or ignore-limits) the
    // price stays at the anchor rather than growing — the band's HIGH end is a
    // cache-behaviour statement, not a size one.
    expect(price(4096, 4096)).toBe(base());
    expect(price(IMAGE_COST_MAX_DIM, IMAGE_COST_MAX_DIM)).toBe(base());
  });

  it('never charges more than the table value', () => {
    for (const s of [1, 64, 256, 512, 1024, 2048, 4096, 8192]) {
      expect(price(s, s)).toBeLessThanOrEqual(base());
    }
  });
});

describe('imageNodeCost — the discount', () => {
  it('is monotone in the geometric-mean side and steps once per halving', () => {
    // What makes the settings menu's Resolution ladder CONSEQUENTIAL: every
    // rung down is visibly cheaper, and no rung is dearer than the one above.
    const ladder = [2048, 1024, 512, 256].map((s) => price(s, s));
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]).toBeLessThan(ladder[i - 1]);
    expect(ladder).toEqual([10, 8, 7, 5]);
  });

  it('floors at the cache-resident end, and the floor is not the LUT price', () => {
    // A 2D fetch with mip selection is never cheaper than colormap's 1 KB ramp
    // lookup or an SFU op — reinstating that ordering at runtime is exactly
    // what the first cut of this curve did (256px → 4 = colormap).
    const floor = price(IMAGE_COST_FLOOR_SIDE, IMAGE_COST_FLOOR_SIDE);
    expect(floor).toBe(Math.round(base() * IMAGE_COST_MIN_SCALE));
    expect(price(64, 64)).toBe(floor);
    expect(price(1, 1)).toBe(floor);
    expect(floor).toBeGreaterThan(getCost('colormap'));
    expect(floor).toBeGreaterThan(getCost('sin'));
    expect(floor).toBeGreaterThan(getCost('dataNode'));
    expect(floor).toBeGreaterThan(getCost('mul'));
    // ...and the whole curve sits under a MEASURED Perlin.
    expect(base()).toBeLessThan(getCost('perlin'));
  });

  it('prices by AREA, so a panorama costs what a square of the same texel count costs', () => {
    expect(price(4096, 256)).toBe(price(1024, 1024));
    expect(price(2048, 512)).toBe(price(1024, 1024));
  });

  it('returns an integer, always', () => {
    // Every other table price is an integer and every surface renders the
    // number raw — 18.666666666666664 across a 47px card was measured.
    for (const [w, h] of [[1024, 1024], [1920, 1080], [1024, 576], [640, 480], [3, 7], [8192, 1]]) {
      expect(Number.isInteger(price(w, h))).toBe(true);
    }
  });
});

describe('imageNodeCost — junk dimensions', () => {
  it('prices ANY non-dimension at the flat table value, never at the floor', () => {
    // width/height come out of a .fastshader and no restore path validates
    // them. `Number(null)`, `Number('')`, `Number([])` are 0 and `Number(true)`
    // is 1 — a coerce-then-isFinite gate passes all of them and lands on the
    // FLOOR, a 50 % silent underprice on junk. So the gate is a REAL positive
    // integer or nothing.
    const junk: unknown[] = [undefined, null, '', ' ', 0, -1, 1.5, NaN, Infinity, -Infinity, 1e308,
      '256', '0x10', [2048], [], {}, true, false, 'constructor', IMAGE_COST_MAX_DIM + 1];
    for (const w of junk) {
      expect(price(w, 1024)).toBe(base());
      expect(price(1024, w)).toBe(base());
      expect(Number.isFinite(price(w, w))).toBe(true);
    }
    // A node with no dimensions at all — what "Reset values to default" used
    // to leave behind — is the same case.
    expect(nodeCostPoints(img({}), [])).toBe(base());
  });

  it('mirrors decodeImageNode\'s gate so the price and the emission agree on what a dimension is', () => {
    expect(price(IMAGE_COST_MAX_DIM, 1)).not.toBe(base());       // the last valid size is priced
    expect(price(IMAGE_COST_MAX_DIM + 1, 1)).toBe(base());       // one past it is junk
    expect(imageNodeCost(10, 1024, 1024)).toBe(8);
    expect(imageNodeCost(10, '1024', 1024)).toBe(10);
  });
});

describe('imageNodeCost — the table stays live', () => {
  it('is a multiplier on getCost, so a profile override moves the whole curve', () => {
    // `imageNode` is a real key a hand-authored profile can retype
    // (blankProfileCosts seeds the whole table); a curve on literals would
    // leave that edit counted by the badge and charged by nothing.
    setCostOverrides({ imageNode: 20 });
    expect(price(2048, 2048)).toBe(20);
    expect(price(256, 256)).toBe(10);
    expect(price(undefined, undefined)).toBe(20);
    setCostOverrides({ imageNode: 0 });
    expect(price(1024, 1024)).toBe(0);
  });
});

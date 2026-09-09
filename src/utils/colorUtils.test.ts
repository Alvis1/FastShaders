import { describe, it, expect } from 'vitest';
import {
  hexToRgb,
  hexToRgb01,
  getContrastColor,
  getCostColor,
  getCostTextColor,
  getCostScale,
  getGroupFrameColors,
} from './colorUtils';

describe('hexToRgb', () => {
  it('parses pure black and white', () => {
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
    expect(hexToRgb('#ffffff')).toEqual([255, 255, 255]);
  });

  it('parses primary channels', () => {
    expect(hexToRgb('#ff0000')).toEqual([255, 0, 0]);
    expect(hexToRgb('#00ff00')).toEqual([0, 255, 0]);
    expect(hexToRgb('#0000ff')).toEqual([0, 0, 255]);
  });

  it('parses arbitrary hex strings', () => {
    expect(hexToRgb('#8BC34A')).toEqual([139, 195, 74]);
  });
});

describe('hexToRgb01', () => {
  it('normalises to the 0..1 range', () => {
    expect(hexToRgb01('#000000')).toEqual([0, 0, 0]);
    expect(hexToRgb01('#ffffff')).toEqual([1, 1, 1]);
  });

  it('matches hexToRgb scaled by 1/255', () => {
    const [r, g, b] = hexToRgb01('#80c040');
    expect(r).toBeCloseTo(128 / 255, 6);
    expect(g).toBeCloseTo(192 / 255, 6);
    expect(b).toBeCloseTo(64 / 255, 6);
  });
});

describe('getContrastColor', () => {
  it('returns black on bright backgrounds', () => {
    expect(getContrastColor('#ffffff')).toBe('#000000');
    expect(getContrastColor('#ffff00')).toBe('#000000');
  });

  it('returns white on dark backgrounds', () => {
    expect(getContrastColor('#000000')).toBe('#ffffff');
    expect(getContrastColor('#222222')).toBe('#ffffff');
    expect(getContrastColor('#0000ff')).toBe('#ffffff');
  });

  it('returns black for malformed input as a safe default', () => {
    expect(getContrastColor('not-a-color')).toBe('#000000');
    expect(getContrastColor('#fff')).toBe('#000000');
    expect(getContrastColor('')).toBe('#000000');
    expect(getContrastColor(undefined as unknown as string)).toBe('#000000');
  });
});

describe('getCostColor', () => {
  it('returns the neutral grey at zero or negative cost', () => {
    expect(getCostColor(0).toLowerCase()).toBe('#ebebeb');
    expect(getCostColor(-5).toLowerCase()).toBe('#ebebeb');
  });

  it('returns a valid hex string for positive costs', () => {
    expect(getCostColor(20)).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(getCostColor(80)).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(getCostColor(1000)).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('clamps at cost = 80 so larger costs do not change the color', () => {
    expect(getCostColor(80)).toBe(getCostColor(200));
  });
});

describe('getCostTextColor', () => {
  it('returns the muted grey at zero cost', () => {
    expect(getCostTextColor(0)).toBe('#999999');
  });

  it('returns a valid hex string for positive costs', () => {
    expect(getCostTextColor(40)).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe('getCostScale', () => {
  it('returns 1 at or below zero cost', () => {
    expect(getCostScale(0)).toBe(1);
    expect(getCostScale(-1)).toBe(1);
  });

  it('linearly interpolates between 1 and 1.35 across [0, 80]', () => {
    expect(getCostScale(40)).toBeCloseTo(1.175, 6);
    expect(getCostScale(80)).toBeCloseTo(1.35, 6);
  });

  it('clamps at the max scale beyond cost = 80', () => {
    expect(getCostScale(200)).toBeCloseTo(1.35, 6);
  });
});

describe('getGroupFrameColors', () => {
  it('returns opaque 6-digit hex (never an alpha tint that the canvas shows through)', () => {
    const { background, borderColor } = getGroupFrameColors('#6366f1');
    expect(background).toMatch(/^#[0-9a-f]{6}$/);
    expect(borderColor).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('mixes the fill lighter than the border, both tinted toward the group color', () => {
    const { background, borderColor } = getGroupFrameColors('#ff0000');
    // Green/blue drop toward the color, so the fill keeps more of the base.
    expect(hexToRgb(background)[1]).toBeGreaterThan(hexToRgb(borderColor)[1]);
    // Red is the group color's own channel and rides UP from the base toward
    // 255, so the LESS-mixed fill stays the nearer of the two to the base.
    expect(hexToRgb(background)[0]).toBeLessThan(hexToRgb(borderColor)[0]);
  });

  it('mixes from the node-card off-white, not pure white', () => {
    // Pins NODE_WHITE against tokens.css's --node-bg: lerp(x, x, t) === x for
    // every mix, so feeding the base color back in must return it unchanged.
    // A group frame brighter than the cards it holds would invert the depth
    // ordering it exists to establish.
    expect(getGroupFrameColors('#f1f2f3').background).toBe('#f1f2f3');
    expect(getGroupFrameColors('#ffffff').background).not.toBe('#ffffff');
  });

  it('keeps the full-strength color for a selected border only', () => {
    expect(getGroupFrameColors('#6366f1', true).borderColor).toBe('#6366f1');
    expect(getGroupFrameColors('#6366f1', false).borderColor).not.toBe('#6366f1');
    // The fill never goes full strength, selected or not.
    expect(getGroupFrameColors('#6366f1', true).background).toBe(
      getGroupFrameColors('#6366f1', false).background,
    );
  });

  it('falls back to the default group color on malformed input', () => {
    const good = getGroupFrameColors('#6366f1');
    for (const bad of ['', 'red', '#fff', '#12345g', 'undefined1A']) {
      expect(getGroupFrameColors(bad)).toEqual(good);
    }
  });
});

describe('getGroupFrameColors follows the theme', () => {
  it('mixes from the DARK node body when asked, so the frame stays behind its cards', () => {
    // A group frame is the backdrop panel behind its member cards. Mixing it
    // from the light base on a dark canvas puts a pale sheet under dark cards
    // and inverts the depth ordering the mix exists to preserve.
    const light = getGroupFrameColors('#6366f1');
    const dark = getGroupFrameColors('#6366f1', false, true);
    expect(dark.background).not.toBe(light.background);
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return 0.299 * r + 0.587 * g + 0.114 * b;
    };
    expect(lum(dark.background)).toBeLessThan(lum(light.background));
  });

  it('defaults to light, so every existing caller and stored colour is unchanged', () => {
    expect(getGroupFrameColors('#6366f1', false, false)).toEqual(getGroupFrameColors('#6366f1'));
    expect(getGroupFrameColors('#f1f2f3').background).toBe('#f1f2f3');
    // …and the dark base is the identity for a group coloured like a dark node.
    expect(getGroupFrameColors('#2b2e34', false, true).background).toBe('#2b2e34');
  });

  it('keeps a SELECTED frame at full strength in either theme', () => {
    // Selection is the group's own colour, not a mix, so the theme cannot
    // touch it — that is what makes selection legible on any backdrop.
    expect(getGroupFrameColors('#6366f1', true, true).borderColor).toBe('#6366f1');
    expect(getGroupFrameColors('#6366f1', true, false).borderColor).toBe('#6366f1');
  });
});

describe('getCostColor follows the card it sits on', () => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };

  it('darkens the header in dark mode instead of pastelling it', () => {
    // Blending toward white in BOTH themes made a dark node's header the
    // brightest thing on it — a pastel band over a near-black card, louder
    // than the glyph it labels.
    const light = getCostColor(40);
    const dark = getCostColor(40, undefined, undefined, true);
    expect(lum(dark)).toBeLessThan(lum(light));
  });

  it('keeps the colour STRENGTH — a cheap node still reads green', () => {
    // The mix ratio is unchanged; only the thing it mixes INTO moves. If the
    // dark variant washed out, the header would stop carrying cost at all.
    const cheap = getCostColor(5, undefined, undefined, true);
    const dear = getCostColor(80, undefined, undefined, true);
    expect(cheap).not.toBe(dear);
    const chan = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    // green-dominant when cheap, red-dominant when expensive, in EITHER theme
    expect(chan(cheap)[1]).toBeGreaterThan(chan(cheap)[0]);
    expect(chan(dear)[0]).toBeGreaterThan(chan(dear)[1]);
  });

  it('defaults to light, so nothing that omits the flag changes', () => {
    expect(getCostColor(40, undefined, undefined, false)).toBe(getCostColor(40));
    expect(getCostColor(0)).toBe('#EBEBEB');
  });

  it('gives zero cost a grey on the right side of the card', () => {
    // No colour to soften — it is the "costs nothing" grey, one step off the
    // card in whichever direction the card allows.
    expect(lum(getCostColor(0, undefined, undefined, true)))
      .toBeLessThan(lum(getCostColor(0)));
  });

  it('lets the header TEXT flip itself', () => {
    // Every caller picks it with getContrastColor(costColor), so a darkened
    // fill turns the label white with no second change.
    expect(getContrastColor(getCostColor(40, undefined, undefined, true))).toBe('#ffffff');
    expect(getContrastColor(getCostColor(40))).toBe('#000000');
  });
});

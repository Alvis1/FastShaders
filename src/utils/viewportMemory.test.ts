import { describe, it, expect } from 'vitest';
import {
  parseViewport, formatViewport, VIEWPORT_MIN_ZOOM, VIEWPORT_MAX_ZOOM,
} from './viewportMemory';

describe('viewportMemory — parse', () => {
  it('accepts a well-formed triple', () => {
    expect(parseViewport('120,-45,1.25')).toEqual({ x: 120, y: -45, zoom: 1.25 });
  });

  it('round-trips what it writes', () => {
    const vp = { x: 812.4, y: -1290.6, zoom: 0.8333333 };
    const back = parseViewport(formatViewport(vp));
    expect(back).not.toBeNull();
    expect(back!.x).toBe(812);
    expect(back!.y).toBe(-1291);
    // Four decimals is enough that the restored view is pixel-identical.
    expect(Math.abs(back!.zoom - vp.zoom)).toBeLessThan(1e-4);
  });

  it('rejects anything that is not exactly three fields', () => {
    for (const raw of ['', '1,2', '1,2,3,4', ',,', '1,2,']) {
      expect(parseViewport(raw)).toBeNull();
    }
  });

  it('rejects null and over-long input before parsing', () => {
    expect(parseViewport(null)).toBeNull();
    expect(parseViewport('1'.repeat(200))).toBeNull();
  });

  /**
   * The whole reason this is validated rather than coerced: localStorage is
   * writable by anything at this origin, and `Number` is far too forgiving.
   * A viewport that is quietly wrong reads as the feature not working.
   */
  it('refuses values Number() would happily coerce', () => {
    expect(parseViewport(' 1 , 2 , 1')).toBeNull();   // Number(' 1 ') === 1
    expect(parseViewport('١٢,0,1')).toBeNull();       // Number('١٢') === 12
    expect(parseViewport('0x10,0,1')).toBeNull();     // Number('0x10') === 16
    expect(parseViewport('1e3,0,1')).toBeNull();      // no exponent in our grammar
    expect(parseViewport('Infinity,0,1')).toBeNull();
    expect(parseViewport('NaN,0,1')).toBeNull();
  });

  it('rejects a zoom outside React Flow\'s own bounds', () => {
    // Restoring one would be clamped on the first interaction, so the view
    // would visibly jump the moment the user touched the canvas.
    expect(parseViewport(`0,0,${VIEWPORT_MIN_ZOOM / 2}`)).toBeNull();
    expect(parseViewport(`0,0,${VIEWPORT_MAX_ZOOM + 0.01}`)).toBeNull();
    expect(parseViewport(`0,0,${VIEWPORT_MIN_ZOOM}`)).not.toBeNull();
    expect(parseViewport(`0,0,${VIEWPORT_MAX_ZOOM}`)).not.toBeNull();
  });

  it('rejects a pan no one could have navigated to', () => {
    expect(parseViewport('99999999,0,1')).toBeNull();
    expect(parseViewport('0,-99999999,1')).toBeNull();
  });
});

describe('viewportMemory — format', () => {
  it('rounds pan to whole pixels and trims the zoom', () => {
    expect(formatViewport({ x: 10.6, y: -3.2, zoom: 1 })).toBe('11,-3,1');
    expect(formatViewport({ x: 0, y: 0, zoom: 1.23456789 })).toBe('0,0,1.2346');
  });

  it('stays inside the parser\'s length cap at an extreme pan', () => {
    const s = formatViewport({ x: -9999999, y: 9999999, zoom: 2.9999 });
    expect(s.length).toBeLessThanOrEqual(64);
    expect(parseViewport(s)).not.toBeNull();
  });
});

/**
 * The picture measurements (imageAnalysis.ts) on pictures whose answer is
 * known: flat colours, stripes each way, a checker, noise, a fade. The lines
 * they become are the ONLY thing of a picture that reaches a model, so the
 * suite also holds them to a fixed vocabulary, a small size and determinism —
 * and feeds the analyser sizes and data a hostile file could bring.
 */
import { describe, it, expect } from 'vitest';
import { analyzePicture, pictureHintWords, pictureLines, pictureSeenLines, type PixelGrid } from './imageAnalysis';
import { estimateTokens } from './prompt';
import { wordsOf } from './examples';

type Rgb = [number, number, number];

/** A picture painted by a function of (u, v) in 0–1, v down. */
function paint(width: number, height: number, at: (u: number, v: number, x: number, y: number) => Rgb | [number, number, number, number]): PixelGrid {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = at((x + 0.5) / width, (y + 0.5) / height, x, y);
      const i = (y * width + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = c[3] ?? 255;
    }
  }
  return { width, height, data };
}

/** mulberry32: a seeded stream, so "noise" is the same picture every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DARK: Rgb = [26, 26, 26];
const ORANGE: Rgb = [255, 90, 0];
const facts = (p: PixelGrid) => {
  const f = analyzePicture(p);
  expect(f).not.toBeNull();
  return f!;
};

describe('analyzePicture: colours', () => {
  it('one flat colour is that colour, exactly, and nothing else', () => {
    const f = facts(paint(64, 48, () => ORANGE));
    expect(f.palette).toEqual([{ hex: '#ff5a00', share: 1 }]);
    expect(f.hint).toBe('flat');
    expect(f.across).toBe(0);
    expect(f.direction).toBeNull();
  });

  it('two flat colours come back exact, the larger first', () => {
    const f = facts(paint(96, 96, (u) => (u < 0.7 ? DARK : ORANGE)));
    expect(f.palette.map((c) => c.hex)).toEqual(['#1a1a1a', '#ff5a00']);
    expect(f.palette[0].share).toBeCloseTo(0.7, 1);
    expect(f.palette[1].share).toBeCloseTo(0.3, 1);
  });

  it('the blended edge between two colours is not a third colour', () => {
    // Diagonal stripes at a size that does not divide the measuring grid:
    // every edge cell is a mix of the two.
    const f = facts(paint(480, 320, (u, v) => (Math.floor((u + v) * 6) % 2 === 0 ? DARK : ORANGE)));
    expect(f.palette.map((c) => c.hex)).toEqual(expect.arrayContaining(['#1a1a1a', '#ff5a00']));
    expect(f.palette).toHaveLength(2);
    expect(f.palette[0].share + f.palette[1].share).toBeCloseTo(1, 5);
  });

  it('never more than five, never one the eye would call the same twice', () => {
    const rnd = seeded(7);
    const f = facts(paint(128, 128, () => [rnd() * 255, rnd() * 255, rnd() * 255]));
    expect(f.palette.length).toBeGreaterThan(0);
    expect(f.palette.length).toBeLessThanOrEqual(5);
    const shares = f.palette.map((c) => c.share);
    expect([...shares].sort((a, b) => b - a)).toEqual(shares);
    for (const c of f.palette) expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('transparent pixels are not a colour', () => {
    const f = facts(paint(64, 64, (u) => (u < 0.5 ? [255, 90, 0, 255] : [0, 0, 0, 0])));
    expect(f.palette).toEqual([{ hex: '#ff5a00', share: 1 }]);
  });

  it('brightness runs from black to white', () => {
    expect(facts(paint(8, 8, () => [0, 0, 0])).brightness).toBeCloseTo(0, 2);
    expect(facts(paint(8, 8, () => [255, 255, 255])).brightness).toBeCloseTo(1, 2);
  });
});

describe('analyzePicture: scale, direction, repetition', () => {
  const stripes = (cycles: number, pick: (u: number, v: number) => number) =>
    paint(192, 192, (u, v) => (Math.floor(pick(u, v) * cycles * 2) % 2 === 0 ? DARK : ORANGE));

  it('vertical stripes: counted across, running vertically, even, hard-edged', () => {
    for (const n of [3, 6, 10]) {
      const f = facts(stripes(n, (u) => u));
      expect(f.across, `${n} cycles`).toBeGreaterThanOrEqual(n - 1);
      expect(f.across, `${n} cycles`).toBeLessThanOrEqual(n + 1);
      expect(f.down).toBeLessThan(1);
      expect(f.direction).toEqual({ kind: 'vertical', angle: 90 });
      expect(f.regular).toBe(true);
      expect(f.sharp).toBe(true);
      expect(f.hint).toBe('stripes');
    }
  });

  it('horizontal stripes: counted down, running horizontally', () => {
    const f = facts(stripes(5, (_u, v) => v));
    expect(f.down).toBeGreaterThanOrEqual(4);
    expect(f.down).toBeLessThanOrEqual(6);
    expect(f.across).toBeLessThan(1);
    expect(f.direction).toEqual({ kind: 'horizontal', angle: 0 });
    expect(f.hint).toBe('stripes');
  });

  it('diagonal stripes say which way they lean, read left to right', () => {
    // v runs DOWN the picture. A stripe where u - v is constant goes right
    // and down together: it FALLS. Where u + v is constant it goes right and
    // up: it RISES.
    const falling = facts(stripes(4, (u, v) => (u - v + 1) / 2));
    expect(falling.direction?.kind).toBe('falling');
    expect(falling.direction?.angle).toBe(45);
    const rising = facts(stripes(4, (u, v) => (u + v) / 2));
    expect(rising.direction?.kind).toBe('rising');
    expect(rising.direction?.angle).toBe(45);
  });

  it('a checker repeats evenly and runs no single way', () => {
    const f = facts(paint(192, 192, (u, v) => ((Math.floor(u * 8) + Math.floor(v * 8)) % 2 === 0 ? DARK : ORANGE)));
    expect(f.direction).toBeNull();
    expect(f.regular).toBe(true);
    expect(f.across).toBeGreaterThanOrEqual(3);
    expect(f.across).toBeLessThanOrEqual(5);
    expect(f.hint).toBe('grid');
  });

  it('noise is uneven, runs no way, and is fine grain', () => {
    const rnd = seeded(42);
    const f = facts(paint(96, 96, () => { const v = rnd() * 255; return [v, v, v]; }));
    expect(f.direction).toBeNull();
    expect(f.regular).toBe(false);
    expect(f.hint).toBe('grain');
  });

  it('soft blobs are uneven blotches or clouds, never stripes or a grid', () => {
    // A few smooth bumps at fixed, unevenly spaced places.
    const bumps = [[0.2, 0.3], [0.7, 0.2], [0.5, 0.7], [0.85, 0.8], [0.15, 0.85]];
    const f = facts(paint(128, 128, (u, v) => {
      let s = 0;
      for (const [bx, by] of bumps) s += Math.exp(-((u - bx) ** 2 + (v - by) ** 2) / 0.012);
      const g = Math.min(255, s * 255);
      return [g, g, g];
    }));
    expect(['blotches', 'clouds']).toContain(f.hint);
    expect(f.sharp).toBe(false);
  });

  it('a fade is a fade, and names its brighter side', () => {
    const down = facts(paint(96, 96, (_u, v) => { const g = 255 * (1 - v); return [g, g, g]; }));
    expect(down.hint).toBe('gradient');
    expect(down.brighter).toBe('top');
    const right = facts(paint(96, 96, (u) => { const g = 255 * u; return [g, g, g]; }));
    expect(right.brighter).toBe('right');
  });

  it('the picture\'s size does not change the answer', () => {
    const at = (u: number): Rgb => (Math.floor(u * 12) % 2 === 0 ? DARK : ORANGE);
    const small = facts(paint(96, 60, (u) => at(u)));
    const large = facts(paint(1536, 960, (u) => at(u)));
    expect(large.hint).toBe(small.hint);
    expect(large.direction).toEqual(small.direction);
    expect(Math.abs(large.across - small.across)).toBeLessThanOrEqual(1);
    expect(large.palette.map((c) => c.hex)).toEqual(small.palette.map((c) => c.hex));
  });
});

describe('pictureLines: the only thing of a picture a model is sent', () => {
  const pictures: [string, PixelGrid][] = [
    ['flat', paint(32, 32, () => ORANGE)],
    ['stripes', paint(192, 192, (u, v) => (Math.floor(((u + v) / 2) * 12) % 2 === 0 ? DARK : ORANGE))],
    ['fade', paint(96, 96, (_u, v) => { const g = 255 * v; return [g, 0, 255 - g]; })],
    ['noise', (() => { const r = seeded(3); return paint(128, 128, () => [r() * 255, r() * 255, r() * 255]); })()],
  ];

  it.each(pictures)('%s: a fixed vocabulary, nothing from the file but colours and counts', (_name, p) => {
    const lines = pictureLines(facts(p));
    expect(lines[0]).toBe('PICTURE (measured by the app from the picture the user added; you cannot see it)');
    expect(lines.length).toBeLessThanOrEqual(8);
    const text = lines.join('\n');
    // Printable ASCII and the one ellipsis of "color(0x…)": no control or bidi character can ride in.
    expect(text).toMatch(/^[\x20-\x7e\n…]+$/);
    expect(text).toMatch(/- colours, most common first: #[0-9a-f]{6} \d+%/);
    expect(estimateTokens(text)).toBeLessThanOrEqual(190);
  });

  it('the same pixels give the same lines, byte for byte', () => {
    for (const [, p] of pictures) {
      expect(pictureLines(facts(p))).toEqual(pictureLines(facts({ ...p, data: Array.from(p.data) })));
    }
  });

  it('says what a model needs: the stripes case, in full', () => {
    const f = facts(paint(192, 192, (u) => (Math.floor(u * 12) % 2 === 0 ? DARK : ORANGE)));
    expect(pictureLines(f)).toEqual([
      'PICTURE (measured by the app from the picture the user added; you cannot see it)',
      '- colours, most common first: #1a1a1a 50%, #ff5a00 50%',
      `- brightness: ${f.brightness < 0.35 ? 'dark' : 'medium'} (${f.brightness.toFixed(2)} of 1); contrast: high`,
      '- scale: about 6 light-and-dark features across, under 1 down',
      '- direction: the features run vertically',
      '- repetition: even (it repeats); edges: hard, two flat tones',
      '- looks like: even stripes',
      'Use these colours as color(0x…) values. A coordinate that runs 0 to 1 across the surface, multiplied by N, gives about N features across.',
    ]);
  });

  it('every hint has words that can pick a worked example', () => {
    for (const [, p] of pictures) expect(wordsOf(pictureHintWords(facts(p))).length).toBeGreaterThan(0);
  });
});

describe('pictureSeenLines: the block beside a picture a model SEES', () => {
  const stripes = paint(192, 192, (u) => (Math.floor(u * 12) % 2 === 0 ? DARK : ORANGE));
  const noise = (() => { const r = seeded(3); return paint(128, 128, () => [r() * 255, r() * 255, r() * 255]); })();
  const blobs = paint(128, 128, (u, v) => { const g = 110 + 60 * Math.sin(u * 5) * Math.sin(v * 3.1 + u * 2); return [g * 0.4, g, g * 0.2]; });

  it('asks the model to name what it sees, and gives the colours', () => {
    for (const p of [stripes, noise, blobs]) {
      const lines = pictureSeenLines(facts(p));
      expect(lines[0]).toBe('PICTURE (attached: look at it)');
      expect(lines[1]).toMatch(/^- Start your plan with one sentence that names the main surface pattern you see/);
      expect(lines[2]).toMatch(/^- Colours the app measured over the whole picture, most common first: #[0-9a-f]{6} \d+%/);
      const text = lines.join('\n');
      expect(text).toMatch(/^[\x20-\x7e\n…]+$/);
      // Never the blind block's claim, and never its guess at the KIND of pattern.
      expect(text).not.toMatch(/you cannot see it|looks like/);
      expect(estimateTokens(text)).toBeLessThanOrEqual(190);
    }
  });

  it('carries the measured layout only where the app found a regular structure', () => {
    expect(pictureSeenLines(facts(stripes))).toContain(
      '- The app measured its layout: about 6 light-and-dark features across, under 1 down; the features run vertically; edges: hard.',
    );
    // A scene, a photo, grain: the grid's averages describe the FRAME, and
    // beside the picture they talked two models out of what they saw.
    for (const p of [noise, blobs]) {
      const f = facts(p);
      expect(f.regular).toBe(false);
      expect(pictureSeenLines(f).join('\n')).not.toMatch(/measured its layout/);
    }
  });
});

describe('a hostile file', () => {
  it('a size that is not one, or data that is too short, measures nothing and never throws', () => {
    const data = new Uint8ClampedArray(16);
    const bad: unknown[] = [
      { width: 0, height: 0, data },
      { width: -4, height: 4, data },
      { width: 2.5, height: 2, data },
      { width: NaN, height: 2, data },
      { width: Infinity, height: 1, data },
      { width: 1e9, height: 1e9, data },
      { width: 3, height: 3, data },
      { width: 2, height: 2, data: null },
      { width: 2, height: 2, data: 'abcdefghijklmnop' },
      { width: 2, height: 2 },
      { width: '2', height: '2', data },
      {},
    ];
    for (const p of bad) expect(() => analyzePicture(p as PixelGrid), JSON.stringify(p)).not.toThrow();
    for (const p of bad.slice(0, 8)) expect(analyzePicture(p as PixelGrid), JSON.stringify(p)).toBeNull();
  });

  it('all transparent measures nothing; values that are not numbers do no harm', () => {
    expect(analyzePicture(paint(16, 16, () => [10, 20, 30, 0]))).toBeNull();
    const junk = { width: 2, height: 2, data: [NaN, 'x', {}, 255, 1e9, -5, 0.5, 255, 1, 2, 3, 255, 4, 5, 6, 255] } as unknown as PixelGrid;
    expect(() => analyzePicture(junk)).not.toThrow();
    const f = analyzePicture(junk);
    if (f) for (const line of pictureLines(f)) expect(line).toMatch(/^[\x20-\x7e…]+$/);
  });

  it('a 1×1 picture and a one-pixel-wide one are measured without a division by zero', () => {
    expect(facts(paint(1, 1, () => ORANGE)).palette).toEqual([{ hex: '#ff5a00', share: 1 }]);
    const thin = facts(paint(1, 300, (_u, v) => (v < 0.5 ? DARK : ORANGE)));
    for (const v of [thin.across, thin.down, thin.brightness, thin.contrast]) expect(Number.isFinite(v)).toBe(true);
  });
});

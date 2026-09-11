import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { socketOverhang } from './tileSilhouette';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('socketOverhang', () => {
  const frame = { left: 100, right: 150 };

  it('is zero for a tile with no sockets, or sockets inside the frame', () => {
    expect(socketOverhang(frame, [], 0.5)).toEqual({ left: 0, right: 0 });
    expect(socketOverhang(frame, [{ left: 110, right: 120 }], 0.5)).toEqual({ left: 0, right: 0 });
  });

  it('reports each side in the tile’s own px, not screen px', () => {
    // MEASURED on the strip at zoom ~0.52: a normal socket reaches 2.6 screen
    // px past the frame, i.e. half the 10px socket token.
    const o = socketOverhang(frame, [{ left: 97.4, right: 102.6 }, { left: 147.4, right: 152.6 }], 0.52);
    expect(o).toEqual({ left: 5, right: 5 });
  });

  it('takes the FURTHEST socket on each side (a swatch or preview socket is bigger)', () => {
    const o = socketOverhang(frame, [{ left: 147, right: 153 }, { left: 146, right: 156.5 }], 0.5);
    expect(o.right).toBe(13);
    expect(o.left).toBe(0);
  });

  it('ignores unrendered sockets and junk scales', () => {
    expect(socketOverhang(frame, [{ left: 90, right: 90 }], 0.5)).toEqual({ left: 0, right: 0 });
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(socketOverhang(frame, [{ left: 90, right: 95 }], bad)).toEqual({ left: 0, right: 0 });
    }
  });
});

describe('the strip spaces tiles by silhouette', () => {
  it('the tile padding reads both published overhangs', () => {
    const css = read('./NodePreviewCard.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const card = /\.node-preview-card \{([^}]*)\}/.exec(css)![1];
    expect(card).toContain('padding: 20px calc(8px + var(--fs-sock-r, 0px)) 6px calc(8px + var(--fs-sock-l, 0px));');
  });

  it('ContentBrowser runs the pass with its tile measurement', () => {
    const src = read('./ContentBrowser.tsx');
    expect(src).toContain("import { applyTileSilhouettes } from './tileSilhouette';");
    const at = src.indexOf('Measure the tabs row and the tallest tile.');
    expect(src.indexOf('applyTileSilhouettes(strip);', at)).toBeGreaterThan(at);
  });
});

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CurvesArt } from './CurvesArt';
import { readRgbCurves, curveTables, curvePath } from '@/utils/rgbCurves';

/**
 * The RGB Curves card art is rendered from RAW `values` entries (ShaderNode
 * holds `data`, not a node), and there is no error boundary: a throw in render
 * blanks the app, and the 300 ms autosave writes the poisoned graph back so
 * every reload blanks again. So the art must draw the identity curves for any
 * value a `.fastshader` can carry — including the three that throw on coercion
 * — and both renderers must mount the ONE component.
 */

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const KEYS = ['curveC', 'curveR', 'curveG', 'curveB', 'extend'] as const;
const props = (over: Partial<Record<(typeof KEYS)[number], unknown>>) => ({
  curveC: undefined, curveR: undefined, curveG: undefined, curveB: undefined, extend: undefined, ...over,
});

describe('CurvesArt — total on poisoned props', () => {
  const POISONS: unknown[] = [
    { toString: 1 },
    Symbol('s'),
    { [Symbol.toPrimitive]: () => { throw new Error('boom'); } },
  ];
  // The identity C curve at the card's default size (72×56, 3px inset).
  const identityPath = curvePath(curveTables(readRgbCurves({})).c.table, 66, 50);

  for (const [i, p] of POISONS.entries()) {
    it(`poison #${i} as every prop never throws and draws the straight line`, () => {
      for (const key of KEYS) {
        let html = '';
        expect(() => { html = renderToStaticMarkup(createElement(CurvesArt, props({ [key]: p }))); }, key).not.toThrow();
        expect(html).toContain('shader-node__curves-art');
        expect(html).toContain(identityPath);
      }
      expect(() => renderToStaticMarkup(createElement(CurvesArt, props({ curveC: p, curveR: p, curveG: p, curveB: p, extend: p })))).not.toThrow();
    });
  }

  it('draws a bent channel in its colour, hides the identity ones, and carries no title (a reading)', () => {
    const html = renderToStaticMarkup(createElement(CurvesArt, props({ curveR: '0 0.2,1 0.8' })));
    expect(html).toContain('#d84040');
    expect(html).not.toContain('#3fa63f');
    expect(html).not.toContain('title=');
  });

  it('the editor form draws the active channel solid and the others faded', () => {
    const html = renderToStaticMarkup(createElement(CurvesArt, { ...props({ curveG: '0 0,0.5 0.8,1 1' }), active: 'b', width: 236, height: 200, pad: 6 }));
    expect(html).toContain('#4a68d8');
    expect(html).toContain('stroke-opacity="0.55"');
    expect(html).toContain('class="fs-curves__inactive"');
    expect(html).toContain('stroke-width="1.6"');
    // The card (no active channel) draws nothing faded.
    const card = renderToStaticMarkup(createElement(CurvesArt, props({ curveG: '0 0,0.5 0.8,1 1' })));
    expect(card).not.toContain('fs-curves__inactive');
    expect(card).not.toContain('stroke-opacity="0.55"');
  });

  it('dark mode lifts the faded channels\' OPACITY only — never the hue (the strokes are readings)', () => {
    const css = read('../menus/ContextMenu.css');
    const rule = css.match(/:root\[data-theme="dark"\] \.fs-lut-editor__plot \.fs-curves__inactive \{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/stroke-opacity:\s*0\.9/);
    expect(rule![1]).not.toMatch(/(^|[^-])stroke:|filter|color/);
  });
});

describe('CurvesArt — one renderer on every surface', () => {
  it('ShaderNode and NodeVisual both mount it with the RAW values, never a coerced copy', () => {
    const sn = read('./ShaderNode.tsx');
    for (const k of KEYS) expect(sn).toContain(`${k}={data.values?.${k}}`);
    const nv = read('./NodeVisual.tsx');
    for (const k of KEYS) expect(nv).toContain(`${k}={values?.${k}}`);
    expect(nv).toMatch(/<CurvesArt[\s\S]{0,300}dataNdArt=\{interactive \? '' : undefined\}/);
    // The editor's plot is the same art.
    expect(read('../menus/RgbCurvesSettings.tsx')).toContain('<CurvesArt');
  });

  it('the art CSS is a reading: inert, square, no dark-mode remap', () => {
    const css = read('./ShaderNode.css');
    const rule = /\.shader-node__curves-art \{([^}]*)\}/.exec(css)![1];
    expect(rule).toContain('pointer-events: none');
    expect(rule).toContain('border-radius: 0');
    expect(css).not.toMatch(/data-theme="dark"[^{]*\.shader-node__curves-art/);
  });
});

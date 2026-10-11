import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ColorRampStrip } from './ColorRampArt';
import { readColorRamp, rampCss } from '@/utils/colorRamp';

/**
 * The Color Ramp card art is rendered from RAW `values` entries (ShaderNode
 * holds `data`, not a node), and there is no error boundary: a throw in render
 * blanks the app, and the 300 ms autosave writes the poisoned graph back so
 * every reload blanks again. So the strip must draw the DEFAULT ramp for any
 * value a `.fastshader` can carry — including the three that throw on
 * coercion — and both renderers must mount the ONE component.
 */

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

describe('ColorRampStrip — total on poisoned props', () => {
  const POISONS: unknown[] = [
    { toString: 1 },
    Symbol('s'),
    { [Symbol.toPrimitive]: () => { throw new Error('boom'); } },
  ];
  const defaultCss = rampCss(readColorRamp({}));

  for (const [i, p] of POISONS.entries()) {
    it(`poison #${i} as every prop never throws and draws the default ramp`, () => {
      for (const props of [{ stops: p, interp: undefined }, { stops: undefined, interp: p }, { stops: p, interp: p }]) {
        let html = '';
        expect(() => { html = renderToStaticMarkup(createElement(ColorRampStrip, props)); }).not.toThrow();
        expect(html).toContain('shader-node__ramp-strip');
        expect(html).toContain(defaultCss.slice(0, 60));
      }
    });
  }

  it('draws the stored ramp, its alpha checker, and carries no title (a reading, pointer-events: none)', () => {
    const html = renderToStaticMarkup(createElement(ColorRampStrip, { stops: '0 #ff0000 1,1 #0000ff 0.5', interp: 'constant' }));
    expect(html).toContain('rgba(255, 0, 0, 1) 0%');
    expect(html).toContain('repeating-conic-gradient');
    expect(html).not.toContain('title=');
  });
});

describe('ColorRampStrip — one renderer on every surface', () => {
  it('ShaderNode and NodeVisual both mount it with the RAW stops/interp, never a coerced copy', () => {
    expect(read('./ShaderNode.tsx')).toMatch(/<ColorRampStrip stops=\{data\.values\?\.stops\} interp=\{data\.values\?\.interp\}/);
    const nv = read('./NodeVisual.tsx');
    expect(nv).toMatch(/<ColorRampStrip\s+stops=\{values\?\.stops\}\s+interp=\{values\?\.interp\}/);
    expect(nv).toMatch(/dataNdArt=\{interactive \? '' : undefined\}/);
    // The editor's bar is the same strip.
    expect(read('../menus/ColorRampSettings.tsx')).toContain('<ColorRampStrip ');
  });

  it('the strip CSS is a reading: inert, square, no background shorthand that would wipe the inline layers', () => {
    const css = read('./ShaderNode.css');
    const rule = /\.shader-node__ramp-strip \{([^}]*)\}/.exec(css)![1];
    expect(rule).toContain('pointer-events: none');
    expect(rule).toContain('border-radius: 0');
    expect(rule).not.toMatch(/background/);
    expect(css).not.toMatch(/data-theme="dark"[^{]*\.shader-node__ramp-strip/);
  });
});

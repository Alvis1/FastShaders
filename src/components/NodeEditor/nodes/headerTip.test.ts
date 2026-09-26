import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatNodeLabel, nodeHeaderTip, nodeLabelLV } from '@/i18n';

/**
 * Latvian mode: a CANVAS node's Latvian name is a label ABOVE its header, shown
 * on hover and pinned by the double-click that pins its socket labels. The
 * header itself keeps the generated varName (the graph mirrors the code), so
 * this label is where a Latvian user reads what a node is.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('nodeHeaderTip', () => {
  it('is the bilingual name in Latvian and nothing in English', () => {
    expect(nodeHeaderTip('Multiply', 'mul', 'en')).toBeNull();
    const lv = nodeLabelLV('mul');
    expect(lv).toBeTruthy();
    expect(nodeHeaderTip('Multiply', 'mul', 'lv')).toBe(formatNodeLabel('Multiply', 'mul', 'lv'));
    expect(nodeHeaderTip('Multiply', 'mul', 'lv')).toBe(`${lv} (Multiply)`);
  });
});

describe('every varName-headed canvas node wears the tip', () => {
  // The Output family is exempt: its header already prints the Latvian name.
  const HEADERED = ['ShaderNode', 'PreviewNode', 'MathPreviewNode', 'ClockNode', 'SoundNode'];

  it.each(HEADERED)('%s spreads the tip on its header and bares the title', (name) => {
    const src = read(`./${name}.tsx`);
    expect(src).toContain('useHeaderTip(def)');
    const headers = src.match(/<div className="node-base__header"[^>]*>/g) ?? [];
    expect(headers.length).toBeGreaterThan(0);
    // EVERY header render (ShaderNode has two layouts), not just the first.
    for (const h of headers) expect(h).toContain('{...headerTip}');
    const titles = src.match(/<NodeTitle [^>]*\/>/g) ?? [];
    expect(titles.length).toBe(headers.length);
    // Without `bare` the title's own `title` is the nearer [title] and wins.
    for (const tt of titles) expect(tt).toContain('bare={headerTip !== null}');
  });

  it('the colour swatch, which has no header bar, carries it on the swatch', () => {
    const src = read('./ColorNode.tsx');
    expect(src).toContain('useHeaderTip(NODE_REGISTRY.get(data.registryType))');
    expect(src).toContain('{...headerTip}');
  });

  it('the static replica behind asset tiles does not', () => {
    // A tile has its own tooltip, and its header already prints the Latvian name.
    expect(read('./NodeVisual.tsx')).not.toContain('useHeaderTip');
  });
});

describe('the header name is the socket label\'s twin, not a tooltip-layer bubble', () => {
  const css = read('../handles/TypedHandle.css');

  it('rides a data attribute, never `title`', () => {
    // A `title` would hand it to TooltipLayer — a different look and a 200 ms dwell.
    const src = read('./headerTip.ts');
    expect(src).toContain("{ 'data-header-tip': tip }");
    expect(src).not.toMatch(/\btitle:/);
  });

  it('shares ONE rule with the socket label for its look', () => {
    expect(css).toMatch(/\.typed-handle\[data-tooltip\]::after,\s*\[data-header-tip\]::after\s*\{[^}]*background: var\(--bg-panel\)/);
    expect(css).toContain('content: attr(data-header-tip)');
  });

  it('opens ABOVE the header, stacked over a cost number rather than covering it', () => {
    expect(css).toMatch(/\[data-header-tip\]::after\s*\{[^}]*bottom: calc\(100% \+ var\(--fs-header-tip-gap, 6px\)\)/);
    expect(css).toMatch(/\.node-base__cost-badge ~ \[data-header-tip\]\s*\{\s*--fs-header-tip-gap: 18px/);
  });

  it('shows on hover (not mid-drag) and is pinned by the double-click label peek', () => {
    expect(css).toContain('.react-flow__node:not(.dragging) [data-header-tip]:hover::after');
    expect(css).toContain('.react-flow__node[data-fs-labels-shown] [data-header-tip]::after');
  });
});

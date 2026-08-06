import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * The Node Designer (node-designer.html, repo root) is a Vite ENTRY in the
 * app's module graph: its stage renders the real NodeVisual replica and its
 * data comes from registry/i18n/colorUtils imports (src/nodeDesigner/*). This
 * replaced the old standalone page, whose inline `const NODES=[...]` /
 * COSTS / art / colour snapshots drifted repeatedly (stripes/dataviz missing,
 * the blank colormap) — designerCoverage.test.ts existed only to police that
 * copy and is gone with it.
 *
 * What can still rot, and what this suite pins:
 *  1. the entry wiring (someone re-inlines a script or renames the module);
 *  2. a resurrected snapshot (the drift class must stay structurally dead);
 *  3. a stale public/ copy — public/node-designer.html would ship ALONGSIDE
 *     the built entry (Vite copies public/ into dist verbatim) and shadow or
 *     race it, resurrecting a frozen designer nobody edits. Same for
 *     public/node-i18n.json, which only existed to feed the old page.
 */
const ROOT = path.resolve(__dirname, '../..');
const DESIGNER = path.join(ROOT, 'node-designer.html');

describe('node-designer.html is a module entry, not a snapshot page', () => {
  const html = readFileSync(DESIGNER, 'utf8');

  it('loads the designer module (src/nodeDesigner/main.ts)', () => {
    expect(html).toMatch(/<script type="module" src="\/src\/nodeDesigner\/main\.ts"><\/script>/);
  });

  it('carries no inline registry/cost/art snapshot', () => {
    expect(html, 'a NODES snapshot reappeared — designer data must come from src/nodeDesigner/ndData.ts').not.toContain('const NODES=');
    expect(html).not.toContain('const COSTS=');
    expect(html).not.toContain('builtinGlyph(');
  });

  it('does not restyle the node replica (app CSS owns node visuals)', () => {
    // The stage node is the app's own .node-base markup; designer CSS may add
    // affordances (cursors, hints) but must never redefine the shell.
    expect(html).not.toMatch(/\.node-base\s*\{/);
    expect(html).not.toMatch(/\.shader-node__op\s*\{/);
  });

  it('vite.config names both entries (main must never be dropped)', () => {
    const config = readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toMatch(/input:\s*\{[^}]*main:[^}]*index\.html[^}]*\}/s);
    expect(config).toMatch(/input:\s*\{[^}]*designer:[^}]*node-designer\.html[^}]*\}/s);
  });

  it('the retired public/ copies stay deleted', () => {
    expect(
      existsSync(path.join(ROOT, 'public/node-designer.html')),
      'public/node-designer.html is back — it would ship next to (and shadow) the built entry',
    ).toBe(false);
    expect(
      existsSync(path.join(ROOT, 'public/node-i18n.json')),
      'public/node-i18n.json is back — the designer reads i18n from src/i18n via the bridge now',
    ).toBe(false);
  });
});

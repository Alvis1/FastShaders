/**
 * The "Node graphics" switch in the toolbar's right-click settings list.
 *
 * Off hides the GLYPHS on canvas nodes — the drawn symbol on a node's face —
 * and nothing else. It is a per-browser display preference, so it must never
 * reach a document.
 *
 * SCOPE is the thing to hold on to, because it was wrong once already. Every
 * other drawn surface on a node shows that node's own data: the image and noise
 * thumbnails, the wave plot, the clock face, the colormap ramp. Hiding those
 * removes INFORMATION — a colormap picked by name is unrecognisable without its
 * strip, and the sin/cos readout lives inside the plot — whereas a glyph is a
 * picture of what the node does and the node's name already says that. So this
 * is a LOOK setting, not a performance one, and the toolbar hint says so rather
 * than promising a faster canvas.
 *
 * What is pinned below is what breaks silently: a selector matching nothing, a
 * default a junk stored value can flip, an attribute that is never stamped, and
 * the scope creeping back outward.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { useAppStore } from './useAppStore';

const css = readFileSync(new URL('../components/NodeEditor/nodes/NodeBase.css', import.meta.url), 'utf8');
const storeSrc = readFileSync(new URL('./useAppStore.ts', import.meta.url), 'utf8');
const toolbar = readFileSync(new URL('../components/Layout/Toolbar.tsx', import.meta.url), 'utf8');
const glyph = readFileSync(new URL('../components/NodeEditor/nodes/glyphs/NodeGlyph.tsx', import.meta.url), 'utf8');

/** The block the switch turns on, from `:root[data-fs-node-graphics='off']` to its `}`. */
const sweep = css.slice(
  css.indexOf(":root[data-fs-node-graphics='off']"),
  css.indexOf('}', css.lastIndexOf(":root[data-fs-node-graphics='off']")) + 1,
);

describe('the node-graphics switch', () => {
  beforeEach(() => {
    useAppStore.setState({ nodeGraphics: true });
  });

  it('defaults to ON, and only the exact string "0" turns it off', () => {
    const line = storeSrc.split('\n').find((l) => l.includes("loadString('fs:nodeGraphics'"));
    expect(line, 'the store no longer reads fs:nodeGraphics').toBeTruthy();
    // `!== '0'` and not `=== '1'`: an absent key is ON, and so is junk. The
    // value comes from localStorage, which anything at this origin can write.
    expect(line).toContain("loadString('fs:nodeGraphics', '1') !== '0'");
  });

  it('is a plain boolean in the store, flipped by its own setter', () => {
    expect(useAppStore.getState().nodeGraphics).toBe(true);
    useAppStore.getState().setNodeGraphics(false);
    expect(useAppStore.getState().nodeGraphics).toBe(false);
    useAppStore.getState().setNodeGraphics(true);
    expect(useAppStore.getState().nodeGraphics).toBe(true);
  });

  it('never reaches a document — not the autosave payload, not the project embed', () => {
    // A display preference for THIS browser. If it rode a .fastshader, opening
    // someone else's shader would change how your own canvas draws.
    const snapshot = storeSrc.slice(storeSrc.indexOf('function snapshotOf'), storeSrc.indexOf('function snapshotOf') + 900);
    expect(snapshot).not.toContain('nodeGraphics');
    const project = readFileSync(new URL('../engine/fastShadersProject.ts', import.meta.url), 'utf8');
    expect(project).not.toContain('nodeGraphics');
  });

  it('hides the glyph, and the handle it hides by exists', () => {
    expect(sweep).toContain('.node-glyph');
    expect(sweep).toContain('display: none');
    // A selector matching nothing is a silent no-op — the whole failure mode
    // this file exists for. The class has to be on the real element.
    expect(glyph).toContain('className="node-glyph"');
  });

  it("hides ONLY the glyph — every other surface shows the node's own data", () => {
    // Each of these was in the sweep at some point and had to come out. The
    // image and noise thumbnails ARE the node's content; the colormap ramp is
    // the only thing saying viridis rather than cool-warm (the header shows a
    // generated var name); the sin/cos value lives inside the plot's svg, with
    // the fallback number rendering only when nothing is wired.
    for (const cls of [
      'image-thumb',
      'preview-node__canvas',
      'math-preview-node__canvas',
      'clock-node__canvas',
      'colormap-strip',
    ]) {
      expect(sweep, `${cls} is back in the sweep — it is data, not decoration`).not.toContain(cls);
    }
  });

  it('leaves the node components untouched — this is CSS only', () => {
    // An earlier cut gated three components on the flag to stop their rAF
    // loops. That belongs to a performance setting; this one is about looks, so
    // the components carry no knowledge of it and cannot drift from the sweep.
    for (const f of ['PreviewNode', 'MathPreviewNode', 'ClockNode']) {
      const src = readFileSync(new URL(`../components/NodeEditor/nodes/${f}.tsx`, import.meta.url), 'utf8');
      expect(src, `${f} reads nodeGraphics`).not.toContain('nodeGraphics');
    }
  });

  it('leaves the palette tiles, the overview and the Designer alone', () => {
    // Scoped to the canvas. Unscoped, it would strip the glyph from the tiles
    // too, where the symbol is what identifies a node you have not placed yet.
    const selectors = sweep.split('{')[0].split(',').map((s) => s.trim()).filter(Boolean);
    for (const sel of selectors) {
      expect(sel, `${sel} is not scoped to .react-flow`).toContain('.react-flow');
    }
  });

  it('is stamped on <html> at module init, not only by the setter', () => {
    // Without the init call the attribute is absent on a fresh load, so a
    // browser that turned glyphs off gets them back every reload and the
    // setting reads as not having stuck.
    expect(storeSrc).toContain('applyNodeGraphicsAttribute(useAppStore.getState().nodeGraphics);');
    // Present only in the OFF state, so the default costs no selector match.
    const fn = storeSrc.slice(storeSrc.indexOf('function applyNodeGraphicsAttribute'), storeSrc.indexOf('function applyNodeGraphicsAttribute') + 400);
    expect(fn).toContain("removeAttribute('data-fs-node-graphics')");
    expect(fn).toContain("setAttribute('data-fs-node-graphics', 'off')");
  });

  it('appears in the toolbar settings list with an explanatory title', () => {
    expect(toolbar).toContain("t('Node graphics', language)");
    expect(toolbar).toContain('setNodeGraphics(e.target.checked)');
    // The list's rule: one line per setting, the explanation as the row's
    // `title`, raised by the app-wide TooltipLayer.
    const row = toolbar.slice(toolbar.indexOf("t('Node graphics'") - 900, toolbar.indexOf("t('Node graphics'"));
    expect(row).toContain('className="toolbar__prefs-row"');
    expect(row).toContain('title={');
  });
});

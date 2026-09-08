/**
 * The "Node graphics" switch in the toolbar's right-click settings list.
 *
 * Off hides the ARTWORK on canvas nodes — glyphs, image thumbnails, noise
 * thumbnails, the sin/cos plot, the clock face — and keeps everything that says
 * what a node is or does. It is a per-browser display preference, so it must
 * never reach a document.
 *
 * It is TWO mechanisms, and knowing which does what is the point of this file:
 *
 *  · A CSS sweep on `data-fs-node-graphics='off'` for the surfaces that are
 *    pure decoration and hold no state — the glyph and the image thumbnail.
 *  · A store-flag gate INSIDE PreviewNode, MathPreviewNode and ClockNode for
 *    the three animated ones. CSS was tried there first and was wrong twice:
 *    those rAF ticks probe `offsetParent` on the WRAPPER while the art is a
 *    CHILD, so hiding the child left the probe non-null and the loops running
 *    unseen — the setting would have hidden the cost rather than removed it —
 *    and collapsing those bodies bunches their percent-positioned sockets.
 *
 * The rest is what breaks silently: a selector that matches nothing, a default
 * that a junk stored value can flip, a surface that carried INFORMATION rather
 * than decoration, and the scope — the palette tiles, the overview and the
 * Designer stage keep their art, because there the picture is how you recognise
 * a node you have not placed yet.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { useAppStore } from './useAppStore';

const css = readFileSync(new URL('../components/NodeEditor/nodes/NodeBase.css', import.meta.url), 'utf8');
const storeSrc = readFileSync(new URL('./useAppStore.ts', import.meta.url), 'utf8');
const toolbar = readFileSync(new URL('../components/Layout/Toolbar.tsx', import.meta.url), 'utf8');
const glyph = readFileSync(new URL('../components/NodeEditor/nodes/glyphs/NodeGlyph.tsx', import.meta.url), 'utf8');
const shaderNode = readFileSync(new URL('../components/NodeEditor/nodes/ShaderNode.tsx', import.meta.url), 'utf8');
const previewNode = readFileSync(new URL('../components/NodeEditor/nodes/PreviewNode.tsx', import.meta.url), 'utf8');
const mathNode = readFileSync(new URL('../components/NodeEditor/nodes/MathPreviewNode.tsx', import.meta.url), 'utf8');
const clockNode = readFileSync(new URL('../components/NodeEditor/nodes/ClockNode.tsx', import.meta.url), 'utf8');

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
    // `!== '0'` and not `=== '1'`: an absent key is ON, and so is junk.
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
    // someone else's shader would change how your canvas draws.
    const snapshot = storeSrc.slice(storeSrc.indexOf('function snapshotOf'), storeSrc.indexOf('function snapshotOf') + 900);
    expect(snapshot).not.toContain('nodeGraphics');
    const project = readFileSync(new URL('../engine/fastShadersProject.ts', import.meta.url), 'utf8');
    expect(project).not.toContain('nodeGraphics');
  });

  it('hides with display:none rather than merely making it invisible', () => {
    expect(sweep).toContain('display: none');
    // `visibility`/`opacity` would keep the boxes in flow. For these two
    // decorative surfaces that only wastes layout, but it is also the habit
    // that made the animated ones keep running, so the sweep does not use it.
    expect(sweep).not.toContain('visibility:');
    expect(sweep).not.toContain('opacity:');
  });

  it('sweeps the two purely decorative surfaces, and their handles exist', () => {
    for (const cls of ['.node-glyph', '.shader-node__image-thumb']) {
      expect(sweep, `${cls} is not covered by the sweep`).toContain(cls);
    }
    // A selector matching nothing is a silent no-op — the whole failure mode
    // this file exists for. Both handles must be on a real element.
    expect(glyph).toContain('className="node-glyph"');
    expect(shaderNode).toContain('className="shader-node__image-thumb"');
  });

  it('does NOT hide the three animated surfaces from CSS — they gate in the component', () => {
    // Hiding them from CSS was tried and was wrong twice over. Their rAF ticks
    // probe `offsetParent` on the WRAPPER while the art is a CHILD, so the
    // wrapper stayed in flow, the probe never read null, and the loops kept
    // running unseen: the setting would have hidden the cost, not removed it.
    // And collapsing those bodies bunches their percent-positioned sockets.
    for (const cls of ['.preview-node__canvas,', '.math-preview-node__canvas', '.clock-node__canvas']) {
      expect(sweep, `${cls} is back in the CSS sweep`).not.toContain(cls);
    }
    // Each component reads the flag itself, which is what actually stops work.
    for (const [file, src] of [['PreviewNode', previewNode], ['MathPreviewNode', mathNode], ['ClockNode', clockNode]] as const) {
      expect(src, `${file} does not read nodeGraphics`).toContain('s.nodeGraphics');
    }
    // The two whose rAF effects keep narrow deps must read it through a REF, or
    // they close over the first value and never see the switch flip.
    expect(mathNode).toContain('nodeGraphicsRef.current');
    expect(clockNode).toContain('nodeGraphicsRef.current');
  });

  it('keeps what a node needs to be READ: the colormap ramp and the sin/cos value', () => {
    // A colormap picked by name is unrecognisable without its strip — the
    // header shows the generated var name — so hiding it would remove
    // information rather than decoration.
    expect(sweep).not.toContain('colormap-strip');
    // The waveform's number lives inside the svg that goes, and the fallback
    // input renders only when nothing is wired, so a connected sin node would
    // otherwise show no value at all.
    expect(mathNode).toContain('math-preview-node__plain-readout');
    expect(mathNode).toContain('waveLabel(');
  });

  it('leaves a body its sockets can spread across', () => {
    // PreviewNode's handles are placed as PERCENTAGES of the node box, so a
    // collapsed body lands four sockets within a few pixels of each other.
    const previewCss = readFileSync(new URL('../components/NodeEditor/nodes/PreviewNode.css', import.meta.url), 'utf8');
    expect(previewCss).toMatch(/data-fs-node-graphics='off'[\s\S]{0,200}min-height/);
  });

  it('leaves the palette tiles, the overview and the Designer alone', () => {
    // Every selector is scoped to the canvas. An unscoped one would strip the
    // art from the tiles too, where it is what identifies an unplaced node.
    const selectors = sweep.split('{')[0].split(',').map((s) => s.trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(1);
    for (const sel of selectors) {
      expect(sel, `${sel} is not scoped to .react-flow`).toContain('.react-flow');
    }
  });

  it('is stamped on <html> at module init, not only by the setter', () => {
    // Without the init call the attribute is absent on a fresh load, so a
    // browser that turned graphics off gets them back every reload and the
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

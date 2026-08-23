import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `designerApp.ts` is `@ts-nocheck` vanilla with no other automated coverage, and
 * the glyph editor's correctness rests on a handful of invariants that are
 * INVISIBLE when broken — the art still renders, the gesture still runs, and the
 * failure shows up as "that button does nothing" weeks later. Each assertion here
 * is one of those, with the failure it prevents.
 *
 * Source greps, not behaviour: the modal needs a DOM and the vitest env is
 * `node`. A grep cannot prove the code is right, but it can prove the specific
 * line someone would delete while tidying is still there.
 */

const ROOT = resolve(__dirname, '../..');
const app = readFileSync(resolve(ROOT, 'src/nodeDesigner/designerApp.ts'), 'utf8');
const html = readFileSync(resolve(ROOT, 'node-designer.html'), 'utf8');

describe('overlay decorations cannot steal a press', () => {
  it('#mPtsLay .pt-dec turns pointer-events back off', () => {
    /* `#mPtsLay circle{pointer-events:all;cursor:move}` is an ELEMENT rule
       written when every circle in the layer was a draggable handle. Without
       `.pt-dec`, a decorative circle is hittable and swallows exactly the press
       it was drawn to invite: the pen could not be finished by clicking its own
       first anchor, and the Add-point marker — drawn under the cursor by
       construction — ate every insert click. */
    expect(html).toMatch(/#mPtsLay\s+\.pt-dec\s*\{[^}]*pointer-events\s*:\s*none/);
    expect(html).toMatch(/#mPtsLay circle\{pointer-events:all/);   // the rule that makes it necessary
  });

  it('every overlay element goes through the one helper that tags it', () => {
    const mk = app.slice(app.indexOf('function drawToolOverlays'));
    expect(mk.slice(0, 600)).toMatch(/setAttribute\('class', cls \+ ' pt-dec'\)/);
    /* and nothing in that function appends to the layer any other way */
    const body = mk.slice(0, mk.indexOf('\n}\n'));
    const appends = body.match(/lay\.appendChild/g) || [];
    expect(appends).toHaveLength(1);
  });

  it('handles are inert outside the Select tool', () => {
    // otherwise a press meant for the active tool lands on a point instead
    expect(app).toMatch(/toolMode === 'select' \? '' : ' pt-off'/);
    expect(html).toMatch(/#mPtsLay\s+\.pt-off\s*\{[^}]*pointer-events\s*:\s*none/);
  });
});

describe('the render hook reaches past the early returns', () => {
  it('renderGlyphPts is a wrapper around renderGlyphPtsInner', () => {
    /* renderGlyphPtsInner returns early three times (no layer, "drag points"
       unticked, no parsed root). With the highlight and paint hooks INSIDE it,
       unticking a checkbox left <mark> rectangles painted behind a textarea with
       no selection to explain them, and the paint bar reading "5 shapes" against
       an empty one. */
    const m = /function renderGlyphPts\(\)\s*\{([\s\S]*?)\n\}/.exec(app);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('renderGlyphPtsInner()');
    expect(m![1]).toMatch(/syncGlyphHl\(ctx\)/);
    expect(m![1]).toMatch(/renderPaintBar\(ctx\)/);
    expect(m![1]).toMatch(/syncToolInfo\(ctx\)/);
    const inner = /function renderGlyphPtsInner\(\)\s*\{/.exec(app);
    expect(inner).not.toBeNull();
    expect(app.indexOf('function renderGlyphPtsInner')).toBeGreaterThan(app.indexOf('function renderGlyphPts()'));
  });

  it('the Format button is gated in the TEXT funnel, not the handle renderer', () => {
    /* Gated in renderGlyphPts it would stay disabled — with a tooltip blaming an
       SVG error the user had already fixed — for anyone who unticked "drag
       points", since the renderer returns before reaching it. */
    const r = app.slice(app.indexOf('function refreshMPreview'), app.indexOf('function refreshMPreview') + 1400);
    expect(r).toMatch(/el\('mFmt'\)\.disabled = !!err/);
  });
});

describe('every mutating gesture is gated on the parse', () => {
  const ARMING = ['function onDrawDown', 'function doInsertPoint', 'function onRotDown', 'function applyPaint'];
  it.each(ARMING)('%s refuses to run on art that does not parse', (fn) => {
    /* refreshMPreview injects the raw text whether or not it parses, so a gesture
       on the HTML parser's RECONSTRUCTION of half-typed markup writes that
       reconstruction back — which then parses, clearing the red error and
       enabling Apply, so it reads as the typo having been accepted. */
    const at = app.indexOf(fn);
    expect(at, fn).toBeGreaterThan(0);
    const body = app.slice(at, at + 1600);
    expect(body, fn).toContain('glyphEditBlocked(');
  });

  it('the Format button is gated too, and hands the keyboard back', () => {
    const at = app.indexOf("el('mFmt').onclick");
    const body = app.slice(at, at + 1400);
    expect(body).toContain('glyphEditBlocked(');
    expect(body).toContain('pushGlyphUndo(before)');
    /* WebKit does not focus a <button> on click, so without this the caret stays
       in #mSvg, the modal keydown bails at `if (caret) return;` above the ⌘Z
       branch, and the entry just pushed is unreachable — the trap
       replaceGlyphSource documents. */
    expect(body).toContain('focusPtCanvas()');
    expect(body.indexOf('pushGlyphUndo(before)')).toBeGreaterThan(body.indexOf("el('mSvg').value = out"));
  });

  it('the one commit path prunes empty groups before reading innerHTML', () => {
    const m = /function commitGlyphEdit\(root, before\)\s*\{([\s\S]*?)\n\}/.exec(app);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body.indexOf('pruneEmptyGroups(root)')).toBeLessThan(body.indexOf("el('mSvg').value"));
    // pushGlyphUndo compares `before` against the LIVE value, so it must run AFTER
    expect(body.indexOf("el('mSvg').value")).toBeLessThan(body.indexOf('pushGlyphUndo(before)'));
    expect(body.indexOf('pushGlyphUndo(before)')).toBeLessThan(body.indexOf('refreshMPreview()'));
  });
});

describe('the path model lives in one place', () => {
  it('designerApp does not re-declare the tokenizer it imports', () => {
    /* Two implementations of the relative-command rebasing would disagree only
       on art nobody has in the shipped corpus — invisible until it is not. */
    expect(app).toMatch(/import \{[^}]*tokenizePath[^}]*\} from '\.\/glyphPath'/);
    ['function tokenizePath', 'function serializePath', 'function segStart', 'function segEnd', 'function pathSegEnds', 'function degradeCurve', 'function fmtN']
      .forEach((decl) => expect(app, decl).not.toContain(decl));
  });
});

describe('modal chrome', () => {
  it('the paint number field beats the page-wide input rule', () => {
    /* `select,input[type=text],input[type=number],…` is (0,0,1,1); a single class
       is (0,0,1,0) and LOSES font, size and padding — the field would render as a
       26px sans-serif box instead of a 19px mono one. */
    expect(html).toMatch(/#mPaint input\.pb-num\s*\{/);
    // …and the element actually carries it. The rule existed for a release
    // without ever being applied, so the field rendered in the page-wide style.
    expect(html).toMatch(/<input class="pb-num" type="number" id="mStrokeW"/);
  });

  it('the modal is shown BEFORE its first render', () => {
    /* syncGlyphHl refuses to touch the mirror while the modal is hidden, so a
       refresh before `.show` leaves the previous glyph's text and marks in it. */
    const at = app.indexOf("function openGlyph");
    const body = app.slice(at, at + 3000);
    expect(body.indexOf("overlay.classList.add('show')")).toBeLessThan(body.indexOf('refreshMPreview()'));
  });

  it('keyboard rotation applies a TOTAL angle to the run\'s original art', () => {
    /* Applying a per-press DELTA to the previous press's output re-derives the
       pivot from already-rotated geometry, so the selection walks — measured at
       1.38 view units over six presses on a shipped polyline — and stacks one
       rotate() per keypress into the saved art. */
    const at = app.indexOf('function rotateGlyphSelection');
    const body = app.slice(at, at + 2600);
    expect(body).toContain('rotRun.total');
    expect(body).toContain('applyRotation(plan, rotRun.total)');
    expect(body).not.toMatch(/applyRotation\(plan, deg\)/);
  });

  it('the actions row stays reachable on a short viewport', () => {
    /* .modal is max-height:92vh with overflow:auto and its content has been
       taller than that since the point-editor legend landed. Apply is the ONLY
       commit path, so it must never be below the fold. */
    expect(html).toMatch(/\.mactions\{[^}]*position:sticky[^}]*bottom:0/);
  });

  it('the legend documents the tools, colours, rotation and the source link', () => {
    const hint = html.slice(html.indexOf('id="mPtsHint"'), html.indexOf('</details>'));
    ['<dt>tools</dt>', '<dt>colour</dt>', '<dt>rotate</dt>', '<dt>source</dt>'].forEach((dt) => expect(hint).toContain(dt));
  });

  it('tool icons are inline SVG, never characters', () => {
    /* The app self-hosts a woff2 SUBSET of Inter; symbol glyphs are not in it,
       which is why #mPtsHint keeps the browser's own disclosure triangle. */
    const at = app.indexOf('const TOOL_ICONS');
    const body = app.slice(at, app.indexOf('const TOOLS'));
    expect(body).toMatch(/<path |<circle /);
    expect(body).not.toMatch(/[←-➿]/);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source pins for `useScrollArrows`, because the vitest env is `node` — there
 * is no DOM, no ResizeObserver and no MutationObserver to drive it against, and
 * the defect these guard is silent in every other check.
 *
 * What went wrong: overflow is `scrollWidth - clientWidth` and the two move
 * INDEPENDENTLY. Observing only the scroller catches a pane resize (its box
 * changes) and misses every CONTENT change (its box does not). MEASURED in
 * Chromium, in both consumers: filtering the asset browser to a single tile
 * left the › arrow drawn over a strip with nothing to scroll, and switching the
 * 3D preview to an OBJ geometry — which removes the Subd slider — did the same
 * to its control bar. Clicking either did nothing. A control that is present
 * and inert reads as broken, not as stale.
 */

const SRC = readFileSync(join(__dirname, 'ScrollArrows.tsx'), 'utf8');
/** The body of the effect that wires the observers up. */
const EFFECT = SRC.slice(SRC.indexOf('useEffect(() => {'), SRC.indexOf('const scrollBy'));

describe('useScrollArrows — overflow detection', () => {
  it('observes the scroller itself, for box changes', () => {
    expect(EFFECT).toMatch(/ro\.observe\(el\)/);
  });

  it('observes the CHILDREN, for content changes that leave the box alone', () => {
    // A label relabelled by the language switch, a <select> that grew an
    // option, a filtered tile strip — none of these resize the scroller.
    expect(EFFECT).toMatch(/for \(const child of el\.children\) ro\.observe\(child\)/);
  });

  it('picks up children added after the effect ran', () => {
    // The effect runs once (its deps are stable by construction), so a child
    // React mounts later would never be observed without this.
    expect(EFFECT).toMatch(/new MutationObserver/);
    expect(EFFECT).toMatch(/mo\.observe\(el, \{ childList: true \}\)/);
  });

  it('tears both observers down', () => {
    const cleanup = EFFECT.slice(EFFECT.indexOf('return () => {'));
    expect(cleanup).toContain('ro.disconnect()');
    expect(cleanup).toContain('mo.disconnect()');
    expect(cleanup).toContain("removeEventListener('scroll'");
  });

  it('derives both arrows from the live scroll position, not from state', () => {
    // `canLeft`/`canRight` must be recomputed from the element on every
    // signal — caching either is how an arrow survives the overflow it
    // describes.
    expect(SRC).toMatch(/setCanLeft\(el\.scrollLeft > 1\)/);
    expect(SRC).toMatch(/setCanRight\(el\.scrollLeft < el\.scrollWidth - el\.clientWidth - 1\)/);
  });

  it('inverts only the preview bar, and only through the shared variant', () => {
    // A deliberate divergence, not drift: the preview's control bar is a
    // near-white chrome strip, so a plate in its own colour reads as part of
    // the bar and the arrow stops looking like a button. The asset browser's
    // arrows sit against a busy tile strip that a solid dark plate would fight,
    // so they keep the default. Pinned because "which surface inverts" is a
    // judgement that is invisible in either stylesheet on its own.
    const preview = readFileSync(join(__dirname, '../Preview/ShaderPreview.tsx'), 'utf8');
    expect((preview.match(/<ScrollArrow [^>]*\binvert\b/g) ?? []).length).toBe(2);
    const browser = readFileSync(join(__dirname, '../NodeEditor/ContentBrowser.tsx'), 'utf8');
    expect(browser).not.toMatch(/<ScrollArrow [^>]*\binvert\b/);
    // The look lives in the shared stylesheet, never inline or per-surface.
    const controls = readFileSync(join(__dirname, '../../styles/controls.css'), 'utf8');
    expect(controls).toContain('.fs-scroll-arrow--invert');
    // The hover glyph must be a LITERAL: --border-focus is a fixed blue in both
    // themes, and --bg-panel (what .toolbar__refresh:hover reads) is a dark grey
    // in dark mode — measured at 1.66:1 against that blue.
    const hover = /\.fs-scroll-arrow--invert:hover\s*\{([^}]*)\}/.exec(controls);
    expect(hover, 'the inverted hover rule is gone').not.toBeNull();
    expect(hover![1]).not.toContain('var(--bg-panel)');
  });

  it('is the ONE implementation — no consumer rolls its own', () => {
    // The visual lives in styles/controls.css as `.fs-scroll-arrow`; a local
    // copy of either half is what let the two rows drift before.
    for (const f of [
      '../NodeEditor/ContentBrowser.tsx',
      '../Preview/ShaderPreview.tsx',
    ]) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src, `${f} must import the shared hook`).toContain(
        "from '@/components/Layout/ScrollArrows'",
      );
      expect(src, `${f} must not redefine it`).not.toMatch(/function useScrollArrows/);
    }
  });
});

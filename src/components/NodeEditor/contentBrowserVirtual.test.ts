import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEditorDefinitions, getFlowNodeType } from '@/registry/nodeRegistry';
import { hiddenOptionalCategories, DEFAULT_OPTIONAL_CATEGORIES } from '@/registry/optionalCategories';

/**
 * Why the asset strip is NOT virtualized, stated as a test rather than as a
 * comment nobody re-reads — the `previewFitBounds` precedent of pinning a
 * known flaw so the trade stays deliberate instead of being rediscovered.
 *
 * Virtualizing it has now been proposed and declined three times (2026-09-08
 * being the third), every time for the SAME reason, and the reason is not
 * "nobody got round to it": the strip's tile SCALE is derived from the tallest
 * tile in the whole library, and that height is MEASURED by sweeping
 * `strip.children`. So the zoom every tile renders at depends on every tile
 * being mounted. Mount a subset and the sweep returns a smaller maximum, the
 * zoom comes out too large, and the genuinely tallest tile is clipped by the
 * strip's own `overflow-y: hidden` the moment it scrolls in — which is exactly
 * the defect STRIP_CHROME_V and the `zoomForHeight` seam term each document
 * having already shipped once, silently, because a clipped tile looks like a
 * tile with a short caption rather than like a bug.
 *
 * The mark is also monotonic (`Math.max` after the first measurement), so a
 * windowed strip does not merely start wrong — it walks: every scroll that
 * reveals a taller tile grows the mark and rescales all 78 tiles under the
 * pointer.
 *
 * WHAT WOULD SETTLE IT (in rough order of how much it buys per unit of risk):
 *
 *  1. Make the per-card cost lazy instead of windowing at all. The expensive
 *     part of a tile is `FitNodeHeading`'s ResizeObserver plus the NodeVisual
 *     replica underneath it, and BOTH live in NodePreviewCard.tsx /
 *     NodeVisual.tsx — not in ContentBrowser. An IntersectionObserver there
 *     could leave an off-screen tile as a box with nothing in it while the
 *     strip keeps every child mounted, so the sweep above still sees a full
 *     set of boxes. This is the smallest change with most of the win, and it
 *     is a NodePreviewCard change, not a ContentBrowser one.
 *  2. Cache the measured natural height PER DEF TYPE, keyed by everything the
 *     measurement depends on (language, fonts-ready, the customGlyphs design
 *     set). With that, a mounted tile is no longer required to know how tall
 *     it is, the sweep can read slot heights instead of card heights, and
 *     windowing becomes expressible. Needs an invalidation story; a stale
 *     entry reintroduces the clipping above.
 *  3. Derive the tallest tile from DATA. Attempted and abandoned: a card's
 *     height is `FitNodeHeading`'s normalized box, i.e. a function of the
 *     replica's DOM-measured natural width/height (text metrics, title
 *     wrapping at NodeTitle's balanced seam, socket rows, glyph art), which is
 *     browser-only for the 62 `shader` cards. The fixed-geometry modules
 *     (micGeometry, audioGeometry, clockFace) are pure and would give exact
 *     answers, but they cover 2 of 78 tiles.
 *
 * None of 1-3 is verifiable in this suite: the vitest env is `node`, so there
 * is no layout, no ResizeObserver and no IntersectionObserver to drive any of
 * it against. Whoever attempts it needs a browser and should re-measure the
 * numbers this file pins below.
 */

const SRC = readFileSync(join(__dirname, 'ContentBrowser.tsx'), 'utf8');

/** The high-water measurement effect — the thing that couples scale to mounts. */
const SWEEP = SRC.slice(
  SRC.indexOf('const strip = scrollRef.current;'),
  SRC.indexOf('Live gesture state'),
);

describe('content browser — the boot cost, stated', () => {
  // Measured from the registry rather than from the DOM, so the number moves
  // when the library does. These are what an optimization has to beat; re-run
  // this file after any attempt and put the new figures in the commit.
  const booted = getEditorDefinitions(hiddenOptionalCategories(DEFAULT_OPTIONAL_CATEGORIES));

  it('mounts one inert replica per default-visible node definition', () => {
    // The default tab is 'all' with an empty query, so `filteredDefs` is the
    // whole editor set narrowed by the optional categories (Textures and
    // Distance fields are OFF by default). Presets and textures are lazy and
    // contribute nothing until their tab opens or a query is typed.
    // 78 since the Raymarch Output moved from the optional Distance fields
    // family into `output` (2026-09-09): it is a SINK, and the family it grew
    // up in is off by default, which left the only marching sink unreachable.
    expect(booted.length).toBe(78);
  });

  it('mounts one ResizeObserver per replica bar the two colour swatches', () => {
    // NodePreviewCard wraps every branch except `color` in FitNodeHeading, and
    // FitNodeHeading owns exactly one ResizeObserver. The colour cards need no
    // heading normalization (they have no header), so they escape it.
    const observed = booted.filter((d) => getFlowNodeType(d) !== 'color');
    expect(observed.length).toBe(76);
  });

  it('mounts eight CPU noise thumbnails and one clock among them', () => {
    // The `preview` cards each rasterize a noise field on the CPU at mount —
    // the priciest single item in the boot set, and the one most worth making
    // lazy first if option 1 above is ever taken.
    const byFlow = (f: string) => booted.filter((d) => getFlowNodeType(d) === f).length;
    expect(byFlow('preview')).toBe(8);
    expect(byFlow('clock')).toBe(1);
    expect(byFlow('shader')).toBe(62);
  });
});

describe('content browser — why windowing is blocked', () => {
  it('derives the tile scale by sweeping every mounted child', () => {
    // This line IS the blocker. It reads the strip's DOM children, so the
    // answer is only correct while every tile is mounted.
    expect(SWEEP).toMatch(/for \(const child of Array\.from\(strip\.children\)/);
    expect(SWEEP).toMatch(/getBoundingClientRect\(\)\.height \/ z/);
  });

  it('keeps that mark monotonic, so an under-measured strip walks as it scrolls', () => {
    expect(SWEEP).toMatch(/measuredRef\.current \? Math\.max\(current, tallest\)/);
  });

  it('has not grown a windowing mechanism while the sweep still reads the DOM', () => {
    // The failure this guards is silent by construction: a virtualized strip
    // renders, scrolls and passes every other check — it is only the TALLEST
    // tile, on whichever tab happens to hold it, that comes back clipped by a
    // few pixels of caption. So fail loudly on the combination instead.
    //
    // If you are here because this test failed: you added windowing without
    // decoupling the measurement. Take option 1 or 2 from the header, then
    // rewrite this test to pin whatever replaced the sweep.
    const windowed = /IntersectionObserver/.test(SRC);
    const sweepsDom = /Array\.from\(strip\.children\)/.test(SRC);
    expect(windowed && sweepsDom).toBe(false);
  });
});
